/**
 * One-shot chat call lifecycle: waterfall interception, double-guard
 * validation, cancellation and adapter-iterator hygiene.
 *
 * The adapter output is wrapped in its own {@link guardStream} (protocol
 * validation plus normalization of unexpected adapter throws into a terminal
 * `finish` frame). The waterfall exit stream is validated by a second,
 * independent {@link StreamProtocolGuard}: it owns a fresh phase/block table
 * and never inherits inner indexes, so a listener may filter, rewrite or
 * short-circuit frames freely.
 *
 * Every stream owns an internal `AbortController` that mirrors the caller
 * signal. It cancels the transport immediately when the caller aborts, when a
 * listener throws, or when the consumer leaves early; the exit path then awaits
 * iterator closure so no adapter iterator stays pending behind a queued
 * `return()`. Listener defects are rethrown unchanged (an abort never masks
 * them).
 */

import { InvariantError } from '@sekaisen/core'
import type {
  BoundWireChatRequest,
  PreparedChatCall,
  PreparedChatCallSnapshot,
} from './service-types.ts'
import { guardStream, StreamProtocolGuard } from './stream.ts'
import type { LlmFailure, StreamChunk } from './types.ts'
import { failure, isValidLlmFailure } from './utils.ts'

/** Generation-bound single-attempt stream function returned by `bindGeneration`. */
export type BoundChatStream = (
  request: BoundWireChatRequest,
  signal: AbortSignal,
) => AsyncIterable<StreamChunk>

/** `llm/stream` waterfall dispatch: passes the frozen snapshot and one-shot `next`. */
export type ChatWaterfall = (
  snapshot: PreparedChatCallSnapshot,
  next: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>

/** Per-stream teardown hooks shared with the exit iterator. */
interface StreamShutdown {
  /** Cancel the transport immediately. */
  abort(): void
  /** Detach the caller-signal listener. */
  release(): void
}

/** Tracks the iterator actually created by one listener's `next()` call. */
interface InnerCursor {
  readonly stream: AsyncIterable<StreamChunk>
  close(): Promise<void>
}

/**
 * Classify an adapter-side exception without echoing raw provider text: any
 * message rendered here is a static diagnostic. Credential material therefore
 * cannot leak through normalization.
 */
function classifyAdapterFailure(cause: unknown): LlmFailure {
  if (isValidLlmFailure(cause)) return cause
  if (cause instanceof Error) {
    if (cause.name === 'AbortError') return failure('ABORTED', 'Adapter stream was aborted')
    if (cause.name === 'TimeoutError') return failure('TIMEOUT', 'Adapter stream timed out')
  }
  return failure('TRANSPORT', 'Adapter stream failed before producing a terminal frame')
}

async function closeIterator(iterator: AsyncIterator<StreamChunk>): Promise<void> {
  const close = iterator.return
  if (close === undefined) return
  try {
    await close.call(iterator, undefined)
  } catch {
    // Closing is best-effort: the failure that triggered it stays authoritative.
  }
}

/**
 * Detect Cordis' per-listener `next()` latch violation.
 *
 * Cordis throws a plain `Error` for a second `next()` call; the package
 * contract requires an {@link InvariantError} instead.
 */
export function isNextReuseError(cause: unknown): cause is Error {
  return cause instanceof Error && cause.message === 'next() called multiple times'
}

/**
 * Create the guarded inner stream for one listener attempt.
 *
 * The adapter factory runs lazily on the first `next()`, so a listener that
 * short-circuits never touches the transport. Pre-aborted signals are handled
 * by {@link guardStream} (single `aborted` finish frame, zero attempts).
 */
function createInnerCursor(
  snapshot: PreparedChatCallSnapshot,
  bound: BoundChatStream,
  signal: AbortSignal,
): InnerCursor {
  let iterator: AsyncIterator<StreamChunk> | undefined
  const guarded = guardStream(() => bound({ snapshot }, signal), signal, {
    classify: classifyAdapterFailure,
  })
  return {
    stream: {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        const created = guarded[Symbol.asyncIterator]()
        iterator = created
        return created
      },
    },
    async close(): Promise<void> {
      const active = iterator
      iterator = undefined
      if (active !== undefined) await closeIterator(active)
    },
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamChunk> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
}

/**
 * Exit stream: validate every frame through an independent guard, then cancel
 * and await closure of every inner adapter iterator in the finally block.
 */
async function* exitIterator(
  source: AsyncIterable<StreamChunk>,
  inners: readonly InnerCursor[],
  shutdown: StreamShutdown,
): AsyncGenerator<StreamChunk, void, undefined> {
  const guard = new StreamProtocolGuard()
  let iterator: AsyncIterator<StreamChunk> | undefined
  try {
    iterator = source[Symbol.asyncIterator]()
    for (;;) {
      let step: IteratorResult<StreamChunk>
      try {
        step = await iterator.next()
      } catch (cause) {
        throw isNextReuseError(cause)
          ? new InvariantError('llm/stream listener called next() more than once')
          : cause
      }
      if (step.done === true) break
      guard.accept(step.value)
      yield step.value
    }
    guard.end()
  } finally {
    // Cancel first: a transport blocked in `next()` observes the abort and
    // rejects, so the awaited `return()` cannot queue behind a live request.
    shutdown.abort()
    try {
      if (iterator !== undefined) await closeIterator(iterator)
      for (const inner of inners) await inner.close()
    } finally {
      shutdown.release()
    }
  }
}

function createExitStream(
  source: AsyncIterable<StreamChunk>,
  inners: readonly InnerCursor[],
  shutdown: StreamShutdown,
): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      return exitIterator(source, inners, shutdown)
    },
  }
}

/**
 * Build the one-shot {@link PreparedChatCall} for a prepared snapshot.
 *
 * A second `stream()` call, or a waterfall listener that returns something
 * other than an async iterable, is a caller/listener defect and throws
 * {@link InvariantError} synchronously.
 */
export function createPreparedChatCall(
  snapshot: PreparedChatCallSnapshot,
  bound: BoundChatStream,
  waterfall: ChatWaterfall,
): PreparedChatCall {
  let consumed = false
  return Object.freeze({
    snapshot,
    stream(callerSignal: AbortSignal): AsyncIterable<StreamChunk> {
      if (consumed) throw new InvariantError('PreparedChatCall already consumed')
      if (!(callerSignal instanceof AbortSignal))
        throw new InvariantError('PreparedChatCall.stream requires an AbortSignal')
      consumed = true

      const controller = new AbortController()
      const forwardAbort = (): void => {
        controller.abort()
      }
      if (callerSignal.aborted) controller.abort()
      else callerSignal.addEventListener('abort', forwardAbort, { once: true })
      const shutdown: StreamShutdown = {
        abort: forwardAbort,
        release: () => {
          callerSignal.removeEventListener('abort', forwardAbort)
        },
      }
      const signal = controller.signal

      const inners: InnerCursor[] = []
      const next = (): AsyncIterable<StreamChunk> => {
        const cursor = createInnerCursor(snapshot, bound, signal)
        inners.push(cursor)
        return cursor.stream
      }

      const abandon = (): void => {
        shutdown.abort()
        for (const inner of inners) void inner.close()
        shutdown.release()
      }

      let exit: AsyncIterable<StreamChunk> | undefined
      try {
        const produced: unknown = waterfall(snapshot, next)
        if (isAsyncIterable(produced)) exit = produced
      } catch (cause) {
        abandon()
        throw isNextReuseError(cause)
          ? new InvariantError('llm/stream listener called next() more than once')
          : cause
      }
      if (exit === undefined) {
        abandon()
        throw new InvariantError('llm/stream listener must return an AsyncIterable<StreamChunk>')
      }
      return createExitStream(exit, inners, shutdown)
    },
  })
}
