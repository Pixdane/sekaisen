/**
 * pi-ai `AssistantMessageEvent` → neutral `StreamChunk` conversion with the
 * pre-first-byte commit lock.
 *
 * The adapter owns a single attempt lifecycle. pi-ai may rotate credentials or
 * endpoints before any replay-unsafe event; as soon as this module forwards
 * `{ type: 'first-byte' }`, a later inference fetch is rejected before send by
 * the probe, and a Codex WebSocket replay frame cancels the call's own signal so
 * the stream terminates once with `TRANSPORT` instead of concatenating two
 * responses. Caller cancellation keeps its separate `ABORTED` meaning.
 */

import type { Option } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import type {
  DisjointTokenUsage,
  FinishReason,
  LlmFailure,
  NeutralContentBlock,
  PreparedChatCallSnapshot,
  ReplayEnvelope,
  StreamChunk,
  ToolCallId,
} from '@sekaisen/plugin-llm'
import { classifyOmpFailure, OmpMalformedResponseError, ompFailure } from './failures.ts'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  OmpStreamBackend,
  PiAiContext,
  PiAiToolCall,
  PiAiUsage,
  PiModel,
  SimpleStreamOptions,
} from './pi-ai.ts'
import type { OmpCallState } from './probes.ts'
import { buildOmpReplayEnvelope } from './replay.ts'

/** Keep abort reads opaque to control-flow narrowing: the signal can abort later. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

interface OpenBlock {
  readonly piIndex: number
  readonly neutralIndex: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  readonly toolCallId: ToolCallId | undefined
  readonly toolName: string | undefined
  /** Exact concatenation of `toolcall_delta` deltas, whitespace included. */
  toolArgumentsRaw: string
  /** Trailing high surrogate held until the next delta completes the pair. */
  pendingHighSurrogate: string
  closed: boolean
}

/** One backend invocation. */
export interface OmpStreamCall {
  readonly snapshot: PreparedChatCallSnapshot
  readonly model: PiModel
  readonly context: PiAiContext
  readonly options: SimpleStreamOptions
  readonly state: OmpCallState
  /** Literal credentials resolved for this call, never emitted in failures. */
  readonly secrets: ReadonlySet<string>
  readonly backend: OmpStreamBackend
}

/** Canonicalizes SDK token counters: safe integers only, and `-0` becomes `+0`. */
function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Object.is(value, -0)
      ? 0
      : value
    : 0
}

/** Canonicalizes an optional finite non-negative protocol measure. */
function measure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Object.is(value, -0)
      ? 0
      : value
    : undefined
}

function usageFrom(usage: PiAiUsage): DisjointTokenUsage {
  const reasoning = measure(usage.reasoningTokens)
  const costUsd = measure(usage.cost?.total)
  return Object.freeze({
    inputUncachedTokens: safeCount(usage.input),
    cacheReadTokens: safeCount(usage.cacheRead),
    cacheWriteTokens: safeCount(usage.cacheWrite),
    outputTokens: safeCount(usage.output),
    reasoningTokens: reasoning === undefined ? NONE : some(reasoning),
    authoritativeCostUsd: costUsd === undefined ? NONE : some(costUsd),
  })
}

function usageChunk(message: AssistantMessage): StreamChunk {
  return { type: 'usage', usage: usageFrom(message.usage) }
}

function serializeToolArguments(toolCall: PiAiToolCall): string | undefined {
  try {
    const json = JSON.stringify(toolCall.arguments)
    return typeof json === 'string' && json.length > 0 ? json : undefined
  } catch {
    return undefined
  }
}

function resolveToolArguments(raw: string, toolCall: PiAiToolCall): string {
  if (raw.length > 0) return raw
  const serialized = serializeToolArguments(toolCall)
  if (serialized === undefined) {
    throw new OmpMalformedResponseError('Tool call arguments are not serializable')
  }
  return serialized
}

function neutralBlockFrom(
  block: AssistantMessage['content'][number],
  rawToolArguments?: string,
): NeutralContentBlock | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return { type: 'reasoning', text: block.thinking }
    case 'redactedThinking':
      return { type: 'reasoning', text: '' }
    case 'toolCall':
      return {
        type: 'tool-call',
        id: block.id as ToolCallId,
        name: block.name,
        argumentsJson: resolveToolArguments(rawToolArguments ?? '', block),
      }
    default:
      return undefined
  }
}

function terminalFailure(
  reason: FinishReason,
  state: OmpCallState,
  replayState: Option<ReplayEnvelope> = NONE,
): StreamChunk {
  return {
    type: 'finish',
    reason,
    replayState,
    observedAttempts: state.attempts,
  }
}

function failureFinish(failure: LlmFailure, state: OmpCallState): StreamChunk {
  return terminalFailure(
    failure.code === 'ABORTED' ? { kind: 'aborted', failure } : { kind: 'error', failure },
    state,
  )
}

function errorCarrier(message: AssistantMessage): {
  readonly message: string
  readonly status: number | undefined
  readonly errorId: number | undefined
} {
  return {
    message:
      typeof message.errorMessage === 'string' && message.errorMessage.length > 0
        ? message.errorMessage
        : 'Upstream stream failed',
    status: message.errorStatus,
    errorId: message.errorId,
  }
}

/**
 * Settles a pending `iterator.next()` when the call is cancelled. Aborting the
 * producer signal is the only reliable cancel channel: pi-ai routes its probes
 * through observers that swallow exceptions, so throwing from `onSseEvent` or
 * `onResponse` cannot stop an in-flight request by itself.
 */
const STOP = Symbol('omp-call-stop')

/**
 * Runs one bound backend call and yields exactly one legal stream. Operational
 * failures become a single terminal finish; protocol defects thrown by this
 * module are rethrown as `InvariantError`.
 */
export async function* runOmpCall(call: OmpStreamCall): AsyncIterable<StreamChunk> {
  const { model, context, options, state } = call
  const callerSignal = options.signal
  // The call owns its producer signal. Caller cancellation is forwarded into
  // it, and a replay observed after the commit can cancel the transport without
  // being mistaken for a caller abort. `classifyOmpFailure` keeps receiving the
  // caller signal, whose `aborted` flag alone means cancellation.
  const controller = new AbortController()
  const signal = controller.signal
  let callerAborted = isAborted(callerSignal)
  let callEnded = false
  let stopRequested = false
  const stopped = Promise.withResolvers<typeof STOP>()
  const requestStop = (): void => {
    if (stopRequested) return
    stopRequested = true
    stopped.resolve(STOP)
  }
  const forwardCallerAbort = (): void => {
    callerAborted = true
    controller.abort(callerSignal?.reason)
    requestStop()
  }
  const detachCaller = (): void => {
    callerSignal?.removeEventListener('abort', forwardCallerAbort)
  }
  state.bindReplayCancel(() => {
    // A late observer callback from an SDK stream this call already closed must
    // not cancel the (possibly reused) transport of the finished call.
    if (callEnded) return
    controller.abort()
    requestStop()
  })
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) forwardCallerAbort()
    else callerSignal.addEventListener('abort', forwardCallerAbort, { once: true })
  }
  if (callerAborted) {
    yield terminalFailure(
      { kind: 'aborted', failure: ompFailure('ABORTED', 'Model call aborted before send') },
      state,
    )
    return
  }

  let iterator: AsyncIterator<AssistantMessageEvent>
  try {
    iterator = call.backend(model, context, { ...options, signal })[Symbol.asyncIterator]()
  } catch (error) {
    detachCaller()
    yield failureFinish(
      classifyOmpFailure(error, callerSignal, {
        api: model.api,
        provider: model.provider,
        secrets: call.secrets,
      }),
      state,
    )
    return
  }

  const openBlocks = new Map<number, OpenBlock>()
  const piToNeutral = new Map<number, number>()
  let nextBlockIndex = 0
  let firstByteSent = false
  let usageSent = false
  let finished = false
  let innerClosed = false
  let toolBlocks = 0

  /**
   * Stops the producer before closing it. `cancel` aborts the call signal,
   * which is what actually reaches the SDK transport (socket, response body,
   * pending retry). The close is not awaited: a producer that ignores
   * cancellation must not hold the terminal frame. A normally completed stream
   * closes without aborting, so a transport the SDK keeps for reuse is not torn
   * down after its last event.
   */
  const closeInner = (cancel = true): void => {
    if (innerClosed) return
    innerClosed = true
    if (cancel) {
      controller.abort()
      requestStop()
    }
    try {
      const closing = iterator.return?.()
      if (closing !== undefined) void Promise.resolve(closing).catch(() => {})
    } catch {
      // The terminal finish already describes the stream outcome; a close
      // failure cannot add information or a legal second frame.
    }
  }

  const firstChunk = (): StreamChunk | undefined => {
    if (firstByteSent) return undefined
    firstByteSent = true
    state.commit()
    return { type: 'first-byte' }
  }

  const startBlock = (
    piIndex: number,
    kind: OpenBlock['kind'],
    toolCallId?: ToolCallId,
    toolName?: string,
  ): StreamChunk => {
    const neutralIndex = nextBlockIndex
    nextBlockIndex += 1
    openBlocks.set(piIndex, {
      piIndex,
      neutralIndex,
      kind,
      toolCallId,
      toolName,
      toolArgumentsRaw: '',
      pendingHighSurrogate: '',
      closed: false,
    })
    piToNeutral.set(piIndex, neutralIndex)
    if (kind === 'tool-call') toolBlocks += 1
    return {
      type: 'block-start',
      index: neutralIndex,
      blockType: kind,
      ...(kind === 'tool-call'
        ? { toolCallId: toolCallId as ToolCallId, toolName: toolName as string }
        : {}),
    }
  }

  const ensureBlock = (
    event: AssistantMessageEvent & { contentIndex: number },
  ): { readonly starts: StreamChunk[]; readonly block: OpenBlock } | undefined => {
    const existing = openBlocks.get(event.contentIndex)
    if (existing !== undefined) return { starts: [], block: existing }
    const content = event.partial.content[event.contentIndex]
    if (content === undefined) return undefined
    switch (content.type) {
      case 'text':
        return {
          starts: [startBlock(event.contentIndex, 'text')],
          block: openBlocks.get(event.contentIndex)!,
        }
      case 'thinking':
        return {
          starts: [startBlock(event.contentIndex, 'reasoning')],
          block: openBlocks.get(event.contentIndex)!,
        }
      case 'toolCall':
        return {
          starts: [
            startBlock(event.contentIndex, 'tool-call', content.id as ToolCallId, content.name),
          ],
          block: openBlocks.get(event.contentIndex)!,
        }
      default:
        return undefined
    }
  }

  const takeWellFormedDelta = (open: OpenBlock, delta: string): string => {
    const combined = open.pendingHighSurrogate + delta
    open.pendingHighSurrogate = ''
    if (combined.length === 0) return ''
    const last = combined.charCodeAt(combined.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      const emitted = combined.slice(0, -1)
      if (!emitted.isWellFormed()) {
        throw new OmpMalformedResponseError('Upstream delta split an invalid UTF-16 sequence')
      }
      open.pendingHighSurrogate = combined.slice(-1)
      return emitted
    }
    if (!combined.isWellFormed()) {
      throw new OmpMalformedResponseError('Upstream delta split an invalid UTF-16 sequence')
    }
    return combined
  }

  const closeBlock = async (
    piIndex: number,
    block: NeutralContentBlock,
  ): Promise<StreamChunk[]> => {
    const open = openBlocks.get(piIndex)
    if (open === undefined) return []
    if (open.closed) throw new InvariantError('pi-ai emitted a duplicate block end')
    const expectedKind =
      block.type === 'text' ? 'text' : block.type === 'reasoning' ? 'reasoning' : 'tool-call'
    if (open.kind !== expectedKind) {
      throw new InvariantError('pi-ai block end does not match the open block type')
    }
    if (open.pendingHighSurrogate.length > 0) {
      throw new OmpMalformedResponseError('Upstream ended a block with an unmatched high surrogate')
    }
    const blockText = block.type === 'tool-call' ? block.argumentsJson : block.text
    if (!blockText.isWellFormed()) {
      throw new OmpMalformedResponseError('Upstream block text is not well-formed Unicode')
    }
    open.closed = true
    return [{ type: 'block-end', index: open.neutralIndex, block }]
  }

  try {
    while (true) {
      // A cancelled call must not hang on a producer that never settles, so the
      // read races the producer against the stop signal. `Promise.race` also
      // owns the abandoned read, so its later rejection is not unhandled.
      const next = await Promise.race([iterator.next(), stopped.promise])
      if (next === STOP) {
        closeInner()
        yield callerAborted
          ? terminalFailure(
              { kind: 'aborted', failure: ompFailure('ABORTED', 'Model call aborted by caller') },
              state,
            )
          : failureFinish(
              ompFailure(
                'TRANSPORT',
                'Upstream attempted a replay after the response had already produced output',
              ),
              state,
            )
        return
      }
      if (callerAborted) {
        closeInner()
        yield terminalFailure(
          { kind: 'aborted', failure: ompFailure('ABORTED', 'Model call aborted by caller') },
          state,
        )
        return
      }
      if (next.done === true) break
      const event = next.value
      if (state.postCommitAttempt && firstByteSent) {
        closeInner()
        yield failureFinish(
          ompFailure(
            'TRANSPORT',
            'Upstream attempted a replay after the response had already produced output',
          ),
          state,
        )
        return
      }

      if (event.type === 'start') {
        continue
      }

      if (event.type === 'done') {
        if (nextBlockIndex === 0) {
          yield failureFinish(
            ompFailure('EMPTY_RESPONSE', 'Upstream completed without producing any content'),
            state,
          )
          return
        }
        for (const open of openBlocks.values()) {
          if (open.closed) continue
          const content = event.message.content[open.piIndex]
          if (content === undefined) {
            yield failureFinish(
              ompFailure('MALFORMED_RESPONSE', 'Upstream completed with an unclosed content block'),
              state,
            )
            return
          }
          const source = neutralBlockFrom(
            content,
            open.kind === 'tool-call' ? open.toolArgumentsRaw : undefined,
          )
          const block =
            source?.type === 'tool-call' && open.kind === 'tool-call'
              ? {
                  type: 'tool-call' as const,
                  id: open.toolCallId as ToolCallId,
                  name: open.toolName as string,
                  argumentsJson: source.argumentsJson,
                }
              : source
          if (block === undefined) {
            yield failureFinish(
              ompFailure(
                'MALFORMED_RESPONSE',
                'Upstream completed with an unsupported content block',
              ),
              state,
            )
            return
          }
          const closing = await closeBlock(open.piIndex, block)
          for (const chunk of closing) yield chunk
        }
        if (event.reason !== 'length') {
          for (const open of openBlocks.values()) {
            if (open.kind !== 'tool-call' || open.toolArgumentsRaw.length === 0) continue
            let parsed: unknown
            try {
              parsed = JSON.parse(open.toolArgumentsRaw)
            } catch {
              yield failureFinish(
                ompFailure('MALFORMED_RESPONSE', 'Tool call arguments are not valid JSON'),
                state,
              )
              return
            }
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              yield failureFinish(
                ompFailure('MALFORMED_RESPONSE', 'Tool call arguments must be a JSON object'),
                state,
              )
              return
            }
          }
        }
        if (event.reason === 'toolUse' && toolBlocks === 0) {
          yield failureFinish(
            ompFailure('MALFORMED_RESPONSE', 'Upstream stopped for tool use without a tool call'),
            state,
          )
          return
        }
        if (!usageSent) {
          usageSent = true
          yield usageChunk(event.message)
        }
        const replayState = some(buildOmpReplayEnvelope(event.message, piToNeutral, nextBlockIndex))
        const reason: FinishReason =
          event.reason === 'toolUse'
            ? { kind: 'tool-calls' }
            : event.reason === 'length'
              ? { kind: 'max-tokens' }
              : { kind: 'stop' }
        finished = true
        closeInner(false)
        yield terminalFailure(reason, state, replayState)
        return
      }

      if (event.type === 'error') {
        closeInner()
        const failure =
          callerAborted || event.reason === 'aborted'
            ? ompFailure('ABORTED', 'Model call aborted by caller')
            : state.postCommitAttempt
              ? ompFailure(
                  'TRANSPORT',
                  'Upstream attempted a replay after the response had already produced output',
                )
              : classifyOmpFailure(errorCarrier(event.error), callerSignal, {
                  api: model.api,
                  provider: model.provider,
                  secrets: call.secrets,
                  ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
                })
        yield failureFinish(failure, state)
        return
      }

      if (event.type === 'image_end') {
        continue
      }

      const first = firstChunk()
      if (first !== undefined) yield first
      const ensured = ensureBlock(event)
      if (ensured === undefined) {
        throw new InvariantError('pi-ai stream event has no matching content block')
      }
      for (const chunk of ensured.starts) yield chunk
      const open = ensured.block

      switch (event.type) {
        case 'text_start':
          break
        case 'text_delta': {
          if (open.kind !== 'text') throw new InvariantError('pi-ai text delta crossed block types')
          const emitted = takeWellFormedDelta(open, event.delta)
          if (emitted.length > 0) {
            yield { type: 'text-delta', index: open.neutralIndex, delta: emitted }
          }
          break
        }
        case 'text_end': {
          const closing = await closeBlock(event.contentIndex, {
            type: 'text',
            text: event.content,
          })
          for (const chunk of closing) yield chunk
          break
        }
        case 'thinking_start':
          break
        case 'thinking_delta': {
          if (open.kind !== 'reasoning') {
            throw new InvariantError('pi-ai reasoning delta crossed block types')
          }
          const emitted = takeWellFormedDelta(open, event.delta)
          if (emitted.length > 0) {
            yield { type: 'reasoning-delta', index: open.neutralIndex, delta: emitted }
          }
          break
        }
        case 'thinking_end': {
          const closing = await closeBlock(event.contentIndex, {
            type: 'reasoning',
            text: event.content,
          })
          for (const chunk of closing) yield chunk
          break
        }
        case 'toolcall_start':
          break
        case 'toolcall_delta': {
          if (open.kind !== 'tool-call') {
            throw new InvariantError('pi-ai tool delta crossed block types')
          }
          const emitted = takeWellFormedDelta(open, event.delta)
          open.toolArgumentsRaw += event.delta
          if (emitted.length > 0) {
            yield { type: 'tool-call-delta', index: open.neutralIndex, delta: emitted }
          }
          break
        }
        case 'toolcall_end': {
          const closing = await closeBlock(event.contentIndex, {
            type: 'tool-call',
            id: open.toolCallId as ToolCallId,
            name: open.toolName as string,
            argumentsJson: resolveToolArguments(open.toolArgumentsRaw, event.toolCall),
          })
          for (const chunk of closing) yield chunk
          break
        }
      }
    }

    closeInner()
    if (callerAborted) {
      yield terminalFailure(
        { kind: 'aborted', failure: ompFailure('ABORTED', 'Model call aborted by caller') },
        state,
      )
      return
    }
    yield failureFinish(
      ompFailure('TRANSPORT', 'Upstream stream ended before a terminal event'),
      state,
    )
  } catch (cause) {
    if (cause instanceof InvariantError) throw cause
    closeInner()
    const failure = callerAborted
      ? ompFailure('ABORTED', 'Model call aborted by caller')
      : state.postCommitAttempt
        ? ompFailure(
            'TRANSPORT',
            'Upstream attempted a replay after the response had already produced output',
          )
        : classifyOmpFailure(cause, callerSignal, {
            api: model.api,
            provider: model.provider,
            secrets: call.secrets,
            ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
          })
    finished = true
    yield failureFinish(failure, state)
  } finally {
    callEnded = true
    detachCaller()
    if (!finished) closeInner()
  }
}
