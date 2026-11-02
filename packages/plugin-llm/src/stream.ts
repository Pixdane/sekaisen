/**
 * Executable `StreamChunk` protocol state machine.
 *
 * Every adapter output stream and every Waterfall exit stream is validated by
 * its own independent {@link StreamProtocolGuard} instance. A guard only tracks
 * the single `AsyncIterable<StreamChunk>` it consumes: `phase`, block indexes,
 * the active block table and `ReplayEnvelope` alignment are never shared.
 *
 * Protocol violations are program defects (adapter or listener bugs) and throw
 * `InvariantError`; they are never downgraded to a `finish(error)` frame.
 * {@link guardStream} adds the documented normalization boundary: expected
 * transport failures before the terminal frame become exactly one
 * `finish(error | aborted)` frame, while invariant violations propagate.
 */

import type { Option } from '@sekaisen/core'
import { InvariantError, isNone, isOption, isSome, NONE } from '@sekaisen/core'
import type {
  FinishReason,
  LlmFailure,
  NeutralContentBlock,
  ReplayEnvelope,
  StreamChunk,
  ToolCallId,
} from './types.ts'
import {
  failure,
  isPlainRecord,
  isValidDisjointTokenUsage,
  isValidLlmFailure,
  isValidReplayEnvelope,
  validSafeCount,
  validString,
} from './utils.ts'

/** Stream lifecycle phases from the design state table. */
export type StreamPhase = 'init' | 'streaming' | 'usage_emitted' | 'finished'

type BlockKind = 'text' | 'reasoning' | 'tool-call'
type FinishKind = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'

// Null-prototype dictionaries: runtime-supplied names such as `'toString'` or
// `'constructor'` must never resolve through Object.prototype.
const BLOCK_TYPE_BY_NAME: Readonly<Record<string, BlockKind | undefined>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, BlockKind | undefined>, {
    text: 'text',
    reasoning: 'reasoning',
    'tool-call': 'tool-call',
  } satisfies Record<string, BlockKind>),
)

const FINISH_KIND_BY_NAME: Readonly<Record<string, FinishKind | undefined>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, FinishKind | undefined>, {
    stop: 'stop',
    'tool-calls': 'tool-calls',
    'max-tokens': 'max-tokens',
    aborted: 'aborted',
    error: 'error',
  } satisfies Record<string, FinishKind>),
)

interface GuardedBlock {
  readonly blockType: 'text' | 'reasoning' | 'tool-call'
  readonly toolCallId: ToolCallId | undefined
  readonly toolName: string | undefined
  closed: boolean
}

/** Builds the invariant error for a frame outside the closed union. */
function unknownChunkType(chunk: StreamChunk): InvariantError {
  return new InvariantError(`unknown StreamChunk type: ${String(chunk.type)}`)
}

/** Reads `name` from an arbitrary caught value without trusting its shape. */
function thrownName(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('name' in cause)) return undefined
  const name: unknown = cause.name
  return typeof name === 'string' ? name : undefined
}

/** Reads `failure` from a finish reason without asserting an unchecked shape. */
function reasonFailureOf(reason: Record<string, unknown>): unknown {
  return Object.hasOwn(reason, 'failure') ? reason.failure : undefined
}

/**
 * Validates one `AsyncIterable<StreamChunk>` against the documented transition
 * table. The guard is not reusable: once a terminal `finish` frame was accepted,
 * {@link StreamProtocolGuard.accept} rejects every further frame.
 */
export class StreamProtocolGuard {
  #phase: StreamPhase = 'init'
  #nextBlockIndex = 0
  readonly #blocks = new Map<number, GuardedBlock>()

  /** Current lifecycle phase. */
  get phase(): StreamPhase {
    return this.#phase
  }

  /** Index the next `block-start` frame must carry (also the block count). */
  get nextBlockIndex(): number {
    return this.#nextBlockIndex
  }

  /** Accept one frame, advancing or throwing per the state table. */
  accept(chunk: StreamChunk): void {
    if (!isPlainRecord(chunk)) {
      throw new InvariantError('StreamChunk must be a plain object')
    }
    if (this.#phase === 'finished') {
      throw new InvariantError(
        `stream emitted '${String(chunk.type)}' after the terminal finish frame`,
      )
    }
    switch (chunk.type) {
      case 'first-byte':
        this.#acceptFirstByte()
        return
      case 'block-start':
        this.#acceptBlockStart(chunk)
        return
      case 'text-delta':
        this.#acceptDelta(chunk.index, chunk.delta, 'text', 'text-delta')
        return
      case 'reasoning-delta':
        this.#acceptDelta(chunk.index, chunk.delta, 'reasoning', 'reasoning-delta')
        return
      case 'tool-call-delta':
        this.#acceptDelta(chunk.index, chunk.delta, 'tool-call', 'tool-call-delta')
        return
      case 'block-end':
        this.#acceptBlockEnd(chunk.index, chunk.block)
        return
      case 'usage':
        this.#acceptUsage(chunk.usage)
        return
      case 'finish':
        this.#acceptFinish(chunk.reason, chunk.replayState, chunk.observedAttempts)
        return
      default:
        throw unknownChunkType(chunk)
    }
  }

  /** Assert the iterator ended legally, i.e. after a terminal `finish` frame. */
  end(): void {
    if (this.#phase !== 'finished') {
      throw new InvariantError(
        `stream iterator ended in phase '${this.#phase}' without a terminal finish frame`,
      )
    }
  }

  #acceptFirstByte(): void {
    if (this.#phase !== 'init') {
      throw new InvariantError(
        `first-byte must be the first frame of the stream (phase='${this.#phase}')`,
      )
    }
    this.#phase = 'streaming'
  }

  #requireStreaming(frame: string): void {
    if (this.#phase !== 'streaming') {
      throw new InvariantError(`${frame} requires phase 'streaming', found '${this.#phase}'`)
    }
  }

  #acceptBlockStart(chunk: {
    readonly index: number
    readonly blockType: 'text' | 'reasoning' | 'tool-call'
    readonly toolCallId?: ToolCallId
    readonly toolName?: string
  }): void {
    if (this.#phase === 'init') {
      throw new InvariantError('block-start must follow first-byte')
    }
    this.#requireStreaming('block-start')
    if (!validSafeCount(chunk.index)) {
      throw new InvariantError('block-start.index must be a non-negative safe integer')
    }
    if (chunk.index !== this.#nextBlockIndex) {
      throw new InvariantError(
        `block-start.index must equal ${this.#nextBlockIndex}, received ${chunk.index}`,
      )
    }
    const blockType = BLOCK_TYPE_BY_NAME[chunk.blockType]
    if (blockType === undefined) {
      throw new InvariantError(`unknown block-start.blockType: ${String(chunk.blockType)}`)
    }
    if (blockType === 'tool-call') {
      if (!validString(chunk.toolCallId, true)) {
        throw new InvariantError('tool-call block-start requires a non-empty toolCallId')
      }
      if (!validString(chunk.toolName, true)) {
        throw new InvariantError('tool-call block-start requires a non-empty toolName')
      }
      this.#blocks.set(chunk.index, {
        blockType,
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        closed: false,
      })
    } else {
      if (chunk.toolCallId !== undefined || chunk.toolName !== undefined) {
        throw new InvariantError(`block-start of type '${blockType}' must omit tool-call metadata`)
      }
      this.#blocks.set(chunk.index, {
        blockType,
        toolCallId: undefined,
        toolName: undefined,
        closed: false,
      })
    }
    this.#nextBlockIndex++
  }

  #acceptDelta(
    index: number,
    delta: string,
    expected: 'text' | 'reasoning' | 'tool-call',
    frame: string,
  ): void {
    this.#requireStreaming(frame)
    if (!validSafeCount(index)) {
      throw new InvariantError(`${frame}.index must be a non-negative safe integer`)
    }
    const entry = this.#blocks.get(index)
    if (entry === undefined) {
      throw new InvariantError(`${frame} references block index ${index} which was never started`)
    }
    if (entry.closed) {
      throw new InvariantError(`${frame} targets block index ${index} which is already closed`)
    }
    if (entry.blockType !== expected) {
      throw new InvariantError(
        `${frame} targets block index ${index} of type '${entry.blockType}', expected '${expected}'`,
      )
    }
    if (typeof delta !== 'string' || !delta.isWellFormed()) {
      throw new InvariantError(`${frame}.delta must be a well-formed Unicode string`)
    }
  }

  #acceptBlockEnd(index: number, block: NeutralContentBlock): void {
    this.#requireStreaming('block-end')
    if (!validSafeCount(index)) {
      throw new InvariantError('block-end.index must be a non-negative safe integer')
    }
    const entry = this.#blocks.get(index)
    if (entry === undefined) {
      throw new InvariantError(`block-end references block index ${index} which was never started`)
    }
    if (entry.closed) {
      throw new InvariantError(`block-end targets block index ${index} which is already closed`)
    }
    if (!isPlainRecord(block)) {
      throw new InvariantError('block-end.block must be a plain object')
    }
    const blockType = BLOCK_TYPE_BY_NAME[block.type]
    if (blockType !== entry.blockType) {
      throw new InvariantError(
        `block-end.block.type '${String(block.type)}' does not match block index ${index} type '${entry.blockType}'`,
      )
    }
    if (block.type === 'tool-call') {
      if (block.id !== entry.toolCallId) {
        throw new InvariantError(`block-end.block.id does not match block index ${index}`)
      }
      if (block.name !== entry.toolName) {
        throw new InvariantError(`block-end.block.name does not match block index ${index}`)
      }
      if (typeof block.argumentsJson !== 'string' || !block.argumentsJson.isWellFormed()) {
        throw new InvariantError('block-end.block.argumentsJson must be a well-formed string')
      }
    } else if (typeof block.text !== 'string' || !block.text.isWellFormed()) {
      throw new InvariantError(`block-end.block.text of a '${blockType}' block must be well-formed`)
    }
    entry.closed = true
  }

  #acceptUsage(usage: unknown): void {
    this.#requireStreaming('usage')
    if (this.#nextBlockIndex < 1) {
      throw new InvariantError('usage is only allowed after at least one content block')
    }
    for (const [index, entry] of this.#blocks) {
      if (!entry.closed) {
        throw new InvariantError(`usage requires block index ${index} to be closed`)
      }
    }
    if (!isValidDisjointTokenUsage(usage)) {
      throw new InvariantError(
        'usage must carry non-negative safe integer counts and optional finite non-negative cost',
      )
    }
    this.#phase = 'usage_emitted'
  }

  #acceptFinish(
    reason: unknown,
    replayState: Option<ReplayEnvelope>,
    observedAttempts: unknown,
  ): void {
    if (!isPlainRecord(reason)) {
      throw new InvariantError('finish.reason must be a plain object')
    }
    const rawKind = reason.kind
    const kind = typeof rawKind === 'string' ? FINISH_KIND_BY_NAME[rawKind] : undefined
    if (kind === undefined) {
      throw new InvariantError(`unknown finish.reason.kind: ${String(reason.kind)}`)
    }
    if (!validSafeCount(observedAttempts)) {
      throw new InvariantError('finish.observedAttempts must be a non-negative safe integer')
    }
    if (this.#phase !== 'init' && observedAttempts < 1) {
      throw new InvariantError(
        `finish.observedAttempts must be >= 1 once the stream produced frames (phase='${this.#phase}')`,
      )
    }
    if (!isOption(replayState)) {
      throw new InvariantError('finish.replayState must be a genuine Option value')
    }

    if (kind === 'stop' || kind === 'tool-calls' || kind === 'max-tokens') {
      this.#acceptNormalFinish(kind, replayState)
      return
    }

    if (!isNone(replayState)) {
      throw new InvariantError(`finish with reason '${kind}' must carry replayState NONE`)
    }
    const reasonFailure = reasonFailureOf(reason)
    if (!isValidLlmFailure(reasonFailure)) {
      throw new InvariantError(`finish with reason '${kind}' must carry a valid LlmFailure`)
    }
    if ((kind === 'aborted') !== (reasonFailure.code === 'ABORTED')) {
      throw new InvariantError(
        `finish reason '${kind}' is inconsistent with failure code '${reasonFailure.code}'`,
      )
    }
    this.#phase = 'finished'
  }

  #acceptNormalFinish(
    kind: 'stop' | 'tool-calls' | 'max-tokens',
    replayState: Option<ReplayEnvelope>,
  ): void {
    if (this.#phase === 'init') {
      throw new InvariantError(
        `finish with reason '${kind}' is illegal before any content; empty responses must be EMPTY_RESPONSE errors`,
      )
    }
    if (this.#nextBlockIndex < 1) {
      throw new InvariantError(`finish with reason '${kind}' requires at least one content block`)
    }
    if (kind === 'tool-calls') {
      let toolBlocks = 0
      for (const entry of this.#blocks.values()) {
        if (entry.blockType === 'tool-call') toolBlocks++
      }
      if (toolBlocks < 1) {
        throw new InvariantError(
          "finish with reason 'tool-calls' requires at least one tool-call block",
        )
      }
    }
    for (const [index, entry] of this.#blocks) {
      if (!entry.closed) {
        throw new InvariantError(
          `finish with reason '${kind}' requires block index ${index} to be closed`,
        )
      }
    }
    if (isSome(replayState)) {
      const envelope = replayState.value
      if (!isValidReplayEnvelope(envelope)) {
        throw new InvariantError('finish.replayState must be a valid ReplayEnvelope')
      }
      if (envelope.blocks !== undefined && envelope.blocks.length !== this.#nextBlockIndex) {
        throw new InvariantError(
          `finish.replayState.blocks must align 1:1 with ${this.#nextBlockIndex} content blocks, received ${envelope.blocks.length}`,
        )
      }
    }
    this.#phase = 'finished'
  }
}

/* -------------------------------------------------------------------------- */
/*                     Creation / iteration normalization                    */
/* -------------------------------------------------------------------------- */

/** Hooks supplied by the adapter/service around {@link guardStream}. */
export interface GuardStreamOptions {
  /** Maps a thrown/rejected operation error to an `LlmFailure` (defaults to a transport classifier). */
  readonly classify?: (cause: unknown) => LlmFailure
  /** Reports physical request attempts made so far (defaults to `0` at init, `1` after first frame). */
  readonly observedAttempts?: () => number
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    const message = cause.message
    if (typeof message === 'string' && message.length > 0 && message.isWellFormed()) return message
  }
  if (typeof cause === 'string' && cause.length > 0 && cause.isWellFormed()) return cause
  return fallback
}

function classifyCause(cause: unknown): LlmFailure {
  if (isValidLlmFailure(cause)) return cause
  const name = thrownName(cause)
  if (name === 'AbortError') {
    return failure('ABORTED', errorMessage(cause, 'adapter stream was aborted'))
  }
  if (name === 'TimeoutError') {
    return failure('TIMEOUT', errorMessage(cause, 'adapter stream timed out'))
  }
  return failure('TRANSPORT', errorMessage(cause, 'adapter stream failed'))
}

function buildTerminalFrame(
  classify: (cause: unknown) => LlmFailure,
  cause: unknown,
  signal: AbortSignal,
  phase: StreamPhase,
  probe: (() => number) | undefined,
): StreamChunk {
  const classified = classify(cause)
  if (!isValidLlmFailure(classified)) {
    throw new InvariantError('stream failure classifier returned an invalid LlmFailure')
  }
  const reported = probe?.()
  if (reported !== undefined && !validSafeCount(reported)) {
    throw new InvariantError('observedAttempts probe must return a non-negative safe integer')
  }
  // A supplied probe is authoritative: a reported 0 after output is a caller
  // defect that `guard.accept` rejects instead of being silently clamped.
  const observedAttempts = reported ?? (phase === 'init' ? 0 : 1)
  const aborted = signal.aborted || classified.code === 'ABORTED'
  // Cancellation is always reported as ABORTED with a transport-neutral message,
  // so a co-occurring socket error cannot masquerade as a retryable TRANSPORT.
  const reasonFailure =
    aborted && classified.code !== 'ABORTED'
      ? failure('ABORTED', 'chat call was aborted by the caller')
      : classified
  const reason: FinishReason = aborted
    ? { kind: 'aborted', failure: reasonFailure }
    : { kind: 'error', failure: reasonFailure }
  return { type: 'finish', reason, replayState: NONE, observedAttempts }
}

/**
 * Wrap an adapter stream factory with the documented exception boundary.
 *
 * - The factory is called lazily on the first `next()`; a factory that throws
 *   (or an iterator that rejects) with a non-`InvariantError` is normalized to
 *   exactly one `finish(error | aborted)` frame and the iteration ends.
 * - An already-aborted `signal` short-circuits before the factory runs and
 *   yields exactly one `finish(aborted, observedAttempts: 0)` frame.
 * - Invalid frames, frames after `finish`, and iteration ending before
 *   `finish` throw `InvariantError` unchanged.
 * - If the consumer stops early, the inner iterator is closed via `return()`
 *   so adapters can release transports.
 *
 * The returned value is a single-shot async iterable backed by a generator.
 */
export function guardStream(
  factory: () => AsyncIterable<StreamChunk>,
  signal: AbortSignal,
  options: GuardStreamOptions = {},
): AsyncIterable<StreamChunk> {
  return runStream(factory, signal, options)
}

async function* runStream(
  factory: () => AsyncIterable<StreamChunk>,
  signal: AbortSignal,
  options: GuardStreamOptions,
): AsyncGenerator<StreamChunk, void, undefined> {
  const guard = new StreamProtocolGuard()
  const classify = options.classify ?? classifyCause
  const probe = options.observedAttempts
  let iterator: AsyncIterator<StreamChunk> | undefined
  try {
    if (signal.aborted) {
      const frame: StreamChunk = {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: failure('ABORTED', 'chat call was aborted before the stream started'),
        },
        replayState: NONE,
        observedAttempts: 0,
      }
      guard.accept(frame)
      yield frame
      return
    }

    let stream: AsyncIterable<StreamChunk> | undefined
    try {
      stream = factory()
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause
      const frame = buildTerminalFrame(classify, cause, signal, guard.phase, probe)
      guard.accept(frame)
      yield frame
      return
    }

    if (stream === undefined) {
      throw new InvariantError('stream factory must return an AsyncIterable<StreamChunk>')
    }
    if (typeof stream?.[Symbol.asyncIterator] !== 'function') {
      throw new InvariantError('stream factory must return an AsyncIterable<StreamChunk>')
    }
    const active = stream[Symbol.asyncIterator]()
    if (typeof active?.next !== 'function') {
      throw new InvariantError('stream iterator must expose next()')
    }
    iterator = active

    for (;;) {
      let step: IteratorResult<StreamChunk>
      try {
        step = await active.next()
      } catch (cause) {
        if (cause instanceof InvariantError) throw cause
        if (guard.phase === 'finished') throw cause
        const frame = buildTerminalFrame(classify, cause, signal, guard.phase, probe)
        guard.accept(frame)
        yield frame
        return
      }
      if (step.done === true) {
        guard.end()
        return
      }
      guard.accept(step.value)
      yield step.value
    }
  } finally {
    const closing = iterator
    iterator = undefined
    if (closing !== undefined) {
      try {
        await closing.return?.()
      } catch {
        // Closing a cancelled transport must not mask the observed outcome.
      }
    }
  }
}
