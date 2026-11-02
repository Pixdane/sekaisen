/**
 * Deterministic in-memory {@link ChatAdapter} for conformance tests.
 *
 * The mock never performs I/O, never uses timers or randomness, and always
 * emits legal `StreamChunk` sequences for its semantic turns: a complete
 * `first-byte` / block / usage / `finish` lifecycle with exactly the
 * `observedAttempts` values the protocol demands. It exists so the shared
 * conformance suite and service-level tests can exercise routing, guards,
 * assembly and failure handling without provider traffic.
 *
 * Two turn kinds intentionally model defective transports:
 * - `'throw'` emits an optional interrupt prefix (started blocks without
 *   `block-end`) and then throws, so a surrounding `guardStream` can prove it
 *   normalizes a transport failure into a single terminal frame.
 * - `'close-early'` emits an optional prefix and ends the iterator without any
 *   `finish` frame, which must raise `InvariantError` in the guard.
 */

import type { Option, Result } from '@sekaisen/core'
import { err, InvariantError, NONE, ok, some } from '@sekaisen/core'
import type {
  AdapterRetryOwnership,
  BoundWireChatRequest,
  ChatAdapter,
  ModelCapabilities,
  PreparedChatCallSnapshot,
} from './service-types.ts'
import type {
  CacheAlignedChatRequest,
  DisjointTokenUsage,
  LlmFailure,
  ModelId,
  ReplayEnvelope,
  RouteId,
  StreamChunk,
  ToolCallId,
} from './types.ts'
import { failure, validString } from './utils.ts'

/** One tool call emitted by a `'tool-calls'` turn. */
export interface MockToolCallSpec {
  readonly id: string
  readonly name: string
  readonly argumentsJson: string
}

/** An interrupted tool call: the block starts and receives deltas but never ends. */
export interface MockPartialToolSpec {
  readonly id: string
  readonly name: string
  readonly argumentsJsonPrefix: string
}

/** Frames emitted before a mock transport defect (never closed). */
export interface MockPrefix {
  readonly text?: string
  readonly tool?: MockPartialToolSpec
}

/**
 * One scripted mock response.
 *
 * - `text`: a normal (or `max-tokens` truncated) text/reasoning response.
 * - `tool-calls`: one text block plus N tool-call blocks.
 * - `failure`: a legal single-frame `finish(error | aborted)` from `'init'`.
 * - `throw`: optional interrupted prefix followed by a thrown operation error.
 * - `chunks`: raw frames, yielded verbatim (protocol tests only).
 * - `close-early`: optional interrupted prefix followed by silent iterator end.
 */
export type MockTurn =
  | {
      readonly kind: 'text'
      readonly text: string
      readonly reasoning?: string
      readonly finish?: 'stop' | 'max-tokens'
      readonly usage?: DisjointTokenUsage
    }
  | {
      readonly kind: 'tool-calls'
      readonly calls: readonly MockToolCallSpec[]
      readonly text?: string
      readonly usage?: DisjointTokenUsage
    }
  | {
      readonly kind: 'failure'
      readonly failure: LlmFailure
      readonly observedAttempts?: number
    }
  | { readonly kind: 'throw'; readonly error: unknown; readonly prefix?: MockPrefix }
  | { readonly kind: 'chunks'; readonly chunks: readonly StreamChunk[] }
  | { readonly kind: 'close-early'; readonly prefix?: MockPrefix }

/** Construction options for {@link MockAdapter}. */
export interface MockAdapterOptions {
  /** Defaults to `'mock'`. */
  readonly adapterKind?: string
  /** Defaults to `'caller-owned-single-attempt'`. */
  readonly retryOwnership?: AdapterRetryOwnership
  /** Overrides merged over the permissive default capability matrix. */
  readonly capabilities?: Partial<ModelCapabilities>
  /** Initial FIFO script. */
  readonly turns?: readonly MockTurn[]
  /** Used when the FIFO script is empty; defaults to a deterministic echo turn. */
  readonly respond?: (snapshot: PreparedChatCallSnapshot) => MockTurn | Promise<MockTurn>
  /** When `true`, legal finishes carry an aligned mock `ReplayEnvelope`. */
  readonly emitReplayState?: boolean
}

/** Permissive default capability matrix used by the mock and its tests. */
const DEFAULT_CAPABILITIES: ModelCapabilities = Object.freeze({
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  supportedEfforts: Object.freeze(['minimal', 'low', 'medium', 'high'] as const),
  canDisableReasoning: true,
  supportsSamplingWhenThinking: true,
  supportsSamplingParams: true,
  supportsPenaltiesAndStop: true,
  forcedToolChoiceSupport: 'named',
  disableReasoningOnForcedToolChoice: false,
  systemPromptUpdate: 'leading-only',
  toolSchemaDialect: 'openai-strict',
} satisfies ModelCapabilities)

const DELTA_GRANULARITY = 24

/** Split text on code-point boundaries so every delta stays well-formed. */
function splitDeltas(text: string): readonly string[] {
  const points = Array.from(text)
  const deltas: string[] = []
  for (let offset = 0; offset < points.length; offset += DELTA_GRANULARITY) {
    deltas.push(points.slice(offset, offset + DELTA_GRANULARITY).join(''))
  }
  return deltas
}

/** Total character count of every textual payload in the three request segments. */
function requestInputChars(request: CacheAlignedChatRequest): number {
  let chars = 0
  for (const segment of request.segment1Static) chars += segment.name.length + segment.text.length
  for (const message of request.segment2WarmHistory) {
    if (message.role === 'user') {
      for (const block of message.content) chars += block.text.length
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool-call') chars += block.name.length + block.argumentsJson.length
        else chars += block.text.length
      }
    } else {
      chars += message.toolName.length + message.content.length
    }
  }
  const tail = request.segment3VolatileTail
  if (tail.kind === 'some') chars += tail.value.length
  return chars
}

function deterministicUsage(
  snapshot: PreparedChatCallSnapshot,
  outputChars: number,
  reasoningChars: number,
): DisjointTokenUsage {
  const inputChars = requestInputChars(snapshot.request)
  return Object.freeze({
    inputUncachedTokens: Math.ceil(inputChars / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: Math.ceil(outputChars / 4),
    reasoningTokens: reasoningChars > 0 ? some(Math.ceil(reasoningChars / 4)) : NONE,
    authoritativeCostUsd: NONE,
  })
}

/** Most recent user-authored text, used for the deterministic default reply. */
function lastUserText(request: CacheAlignedChatRequest): string {
  for (let index = request.segment2WarmHistory.length - 1; index >= 0; index--) {
    const message = request.segment2WarmHistory[index]
    if (message === undefined || message.role !== 'user') continue
    return message.content.map((block) => block.text).join('')
  }
  const tail = request.segment3VolatileTail
  return tail.kind === 'some' ? tail.value : ''
}

function toolCallId(raw: string, frame: string): ToolCallId {
  if (!validString(raw, true)) {
    throw new InvariantError(`${frame}.id must be a non-empty well-formed string`)
  }
  return raw as ToolCallId
}

function abortedFrame(observedAttempts: number): StreamChunk {
  return {
    type: 'finish',
    reason: { kind: 'aborted', failure: failure('ABORTED', 'mock chat call was aborted') },
    replayState: NONE,
    observedAttempts,
  }
}

/**
 * In-memory chat adapter with a FIFO script, recorded requests and an
 * `observedAttempts` probe compatible with `'caller-owned-single-attempt'`.
 */
export class MockAdapter implements ChatAdapter {
  readonly adapterKind: string
  readonly retryOwnership: AdapterRetryOwnership
  readonly #capabilities: ModelCapabilities
  readonly #emitReplayState: boolean
  readonly #respond:
    | ((snapshot: PreparedChatCallSnapshot) => MockTurn | Promise<MockTurn>)
    | undefined
  readonly #turns: MockTurn[]
  readonly #requests: PreparedChatCallSnapshot[] = []
  #attempts = 0

  constructor(options: MockAdapterOptions = {}) {
    this.adapterKind = options.adapterKind ?? 'mock'
    this.retryOwnership = options.retryOwnership ?? 'caller-owned-single-attempt'
    const overrides = options.capabilities ?? {}
    const disableStrictTools = overrides.disableStrictTools
    if (disableStrictTools !== undefined && typeof disableStrictTools !== 'boolean') {
      throw new InvariantError(
        'ModelCapabilities.disableStrictTools must be a boolean when provided',
      )
    }
    const base: ModelCapabilities = {
      contextWindow: overrides.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow,
      maxOutputTokens: overrides.maxOutputTokens ?? DEFAULT_CAPABILITIES.maxOutputTokens,
      supportedEfforts: Object.freeze([
        ...(overrides.supportedEfforts ?? DEFAULT_CAPABILITIES.supportedEfforts),
      ]),
      canDisableReasoning:
        overrides.canDisableReasoning ?? DEFAULT_CAPABILITIES.canDisableReasoning,
      supportsSamplingWhenThinking:
        overrides.supportsSamplingWhenThinking ?? DEFAULT_CAPABILITIES.supportsSamplingWhenThinking,
      supportsSamplingParams:
        overrides.supportsSamplingParams ?? DEFAULT_CAPABILITIES.supportsSamplingParams,
      supportsPenaltiesAndStop:
        overrides.supportsPenaltiesAndStop ?? DEFAULT_CAPABILITIES.supportsPenaltiesAndStop,
      forcedToolChoiceSupport:
        overrides.forcedToolChoiceSupport ?? DEFAULT_CAPABILITIES.forcedToolChoiceSupport,
      disableReasoningOnForcedToolChoice:
        overrides.disableReasoningOnForcedToolChoice ??
        DEFAULT_CAPABILITIES.disableReasoningOnForcedToolChoice,
      systemPromptUpdate: overrides.systemPromptUpdate ?? DEFAULT_CAPABILITIES.systemPromptUpdate,
      toolSchemaDialect: overrides.toolSchemaDialect ?? DEFAULT_CAPABILITIES.toolSchemaDialect,
    }
    this.#capabilities = Object.freeze(
      disableStrictTools === undefined ? base : { ...base, disableStrictTools },
    )
    this.#emitReplayState = options.emitReplayState ?? false
    this.#respond = options.respond
    this.#turns = [...(options.turns ?? [])]
  }

  /** Capability matrix returned for every registered route. */
  get capabilities(): ModelCapabilities {
    return this.#capabilities
  }

  /** Snapshots of every stream call started against this adapter. */
  get requests(): readonly PreparedChatCallSnapshot[] {
    return Object.freeze([...this.#requests])
  }

  /** Number of scripted turns not yet consumed. */
  get pendingTurns(): number {
    return this.#turns.length
  }

  /** Append turns to the FIFO script. */
  enqueue(...turns: readonly MockTurn[]): this {
    this.#turns.push(...turns)
    return this
  }

  /** Clear script, recordings and the attempt counter. */
  reset(): void {
    this.#turns.length = 0
    this.#requests.length = 0
    this.#attempts = 0
  }

  /** Physical request attempts started so far (probe for `finish.observedAttempts`). */
  physicalAttempts(): number {
    return this.#attempts
  }

  resolveCapabilities(routeId: RouteId, modelId: ModelId): Result<ModelCapabilities, LlmFailure> {
    const invalid = validateTarget(routeId, modelId)
    return invalid === undefined ? ok(this.#capabilities) : err(invalid)
  }

  bindGeneration(
    routeId: RouteId,
    modelId: ModelId,
  ): Result<
    (request: BoundWireChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk>,
    LlmFailure
  > {
    const invalid = validateTarget(routeId, modelId)
    if (invalid !== undefined) return err(invalid)
    return ok((request: BoundWireChatRequest, signal: AbortSignal) => {
      const snapshot = request.snapshot
      return this.#stream(snapshot, signal)
    })
  }

  #stream(snapshot: PreparedChatCallSnapshot, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const adapter = this
    return (async function* stream(): AsyncGenerator<StreamChunk, void, undefined> {
      if (signal.aborted) {
        // A pre-aborted call never reaches the wire, so no attempt is recorded.
        yield abortedFrame(0)
        return
      }
      adapter.#attempts++
      adapter.#requests.push(snapshot)
      const queued = adapter.#turns.shift()
      const turn =
        queued ??
        (adapter.#respond === undefined
          ? adapter.#defaultTurn(snapshot)
          : await adapter.#respond(snapshot))
      yield* adapter.#emit(turn, snapshot)
    })()
  }

  #defaultTurn(snapshot: PreparedChatCallSnapshot): MockTurn {
    const echo = lastUserText(snapshot.request)
    return { kind: 'text', text: echo.length > 0 ? echo : 'mock' }
  }

  #replayFor(blockCount: number): Option<ReplayEnvelope> {
    if (!this.#emitReplayState) return NONE
    const blocks = Array.from({ length: blockCount }, (_unused, index) => ({ index }))
    return some(
      Object.freeze({
        adapterKind: this.adapterKind,
        version: 1,
        response: Object.freeze({ mock: true }),
        blocks: Object.freeze(blocks),
      }),
    )
  }

  async *#emit(
    turn: MockTurn,
    snapshot: PreparedChatCallSnapshot,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    switch (turn.kind) {
      case 'text':
        yield* this.#emitText(turn, snapshot)
        return
      case 'tool-calls':
        yield* this.#emitToolCalls(turn, snapshot)
        return
      case 'failure':
        yield {
          type: 'finish',
          reason:
            turn.failure.code === 'ABORTED'
              ? { kind: 'aborted', failure: turn.failure }
              : { kind: 'error', failure: turn.failure },
          replayState: NONE,
          observedAttempts: turn.observedAttempts ?? 1,
        }
        return
      case 'throw':
        yield* this.#emitPrefix(turn.prefix)
        throw turn.error
      case 'chunks':
        for (const chunk of turn.chunks) yield chunk
        return
      case 'close-early':
        yield* this.#emitPrefix(turn.prefix)
        return
      default:
        throw new InvariantError('unknown MockTurn kind')
    }
  }

  async *#emitText(
    turn: Extract<MockTurn, { readonly kind: 'text' }>,
    snapshot: PreparedChatCallSnapshot,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    yield { type: 'first-byte' }
    let index = 0
    let reasoningChars = 0
    const reasoning = turn.reasoning
    if (reasoning !== undefined) {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      for (const delta of splitDeltas(reasoning)) {
        reasoningChars += delta.length
        yield { type: 'reasoning-delta', index, delta }
      }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
      index++
    }
    yield { type: 'block-start', index, blockType: 'text' }
    for (const delta of splitDeltas(turn.text)) {
      yield { type: 'text-delta', index, delta }
    }
    yield { type: 'block-end', index, block: { type: 'text', text: turn.text } }
    index++
    yield {
      type: 'usage',
      usage: turn.usage ?? deterministicUsage(snapshot, turn.text.length, reasoningChars),
    }
    const finish = turn.finish ?? 'stop'
    yield {
      type: 'finish',
      reason: finish === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
      replayState: this.#replayFor(index),
      observedAttempts: 1,
    }
  }

  async *#emitToolCalls(
    turn: Extract<MockTurn, { readonly kind: 'tool-calls' }>,
    snapshot: PreparedChatCallSnapshot,
  ): AsyncGenerator<StreamChunk, void, undefined> {
    if (turn.calls.length === 0) {
      throw new InvariantError("a 'tool-calls' turn requires at least one tool call")
    }
    yield { type: 'first-byte' }
    let index = 0
    let outputChars = 0
    const text = turn.text
    if (text !== undefined) {
      yield { type: 'block-start', index, blockType: 'text' }
      for (const delta of splitDeltas(text)) {
        outputChars += delta.length
        yield { type: 'text-delta', index, delta }
      }
      yield { type: 'block-end', index, block: { type: 'text', text } }
      index++
    }
    for (const call of turn.calls) {
      const id = toolCallId(call.id, 'MockToolCallSpec')
      const name = call.name
      if (!validString(name, true)) {
        throw new InvariantError('MockToolCallSpec.name must be a non-empty well-formed string')
      }
      yield { type: 'block-start', index, blockType: 'tool-call', toolCallId: id, toolName: name }
      for (const delta of splitDeltas(call.argumentsJson)) {
        outputChars += delta.length
        yield { type: 'tool-call-delta', index, delta }
      }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name, argumentsJson: call.argumentsJson },
      }
      index++
    }
    yield { type: 'usage', usage: turn.usage ?? deterministicUsage(snapshot, outputChars, 0) }
    yield {
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: this.#replayFor(index),
      observedAttempts: 1,
    }
  }

  async *#emitPrefix(prefix: MockPrefix | undefined): AsyncGenerator<StreamChunk, void, undefined> {
    if (prefix === undefined) return
    yield { type: 'first-byte' }
    let index = 0
    if (prefix.text !== undefined) {
      yield { type: 'block-start', index, blockType: 'text' }
      for (const delta of splitDeltas(prefix.text)) yield { type: 'text-delta', index, delta }
      index++
    }
    const tool = prefix.tool
    if (tool !== undefined) {
      const id = toolCallId(tool.id, 'MockPartialToolSpec')
      if (!validString(tool.name, true)) {
        throw new InvariantError('MockPartialToolSpec.name must be a non-empty well-formed string')
      }
      yield {
        type: 'block-start',
        index,
        blockType: 'tool-call',
        toolCallId: id,
        toolName: tool.name,
      }
      for (const delta of splitDeltas(tool.argumentsJsonPrefix)) {
        yield { type: 'tool-call-delta', index, delta }
      }
    }
  }
}

function validateTarget(routeId: RouteId, modelId: ModelId): LlmFailure | undefined {
  if (!validString(routeId, true)) {
    return failure('INVALID_ROUTE', 'routeId must be a non-empty well-formed string')
  }
  if (!validString(modelId, true)) {
    return failure('INVALID_ROUTE', 'modelId must be a non-empty well-formed string')
  }
  return undefined
}
