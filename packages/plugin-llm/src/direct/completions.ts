import { isSome, NONE, some } from '@sekaisen/core'
import type {
  NeutralToolChoice,
  PreparedChatCallSnapshot,
  ReasoningEffort,
} from '../service-types.ts'
import type {
  DisjointTokenUsage,
  FinishReason,
  NeutralContentBlock,
  NeutralMessage,
  ReplayEnvelope,
  StreamChunk,
  ToolCallId,
} from '../types.ts'
import { failure, isPlainRecord } from '../utils.ts'
import type { DirectRouteConfig, DirectWireEngine, SseEvent, WireRequest } from './contract.ts'

/** Replay envelope identity for the OpenAI-compatible completions transport. */
export const COMPLETIONS_REPLAY_ADAPTER_KIND = 'direct:openai-completions'
/** Replay envelope schema version understood by this engine. */
export const COMPLETIONS_REPLAY_VERSION = 1
/** How long trailing frames are tolerated after the provider's finish reason. */
export const TRAILING_USAGE_GRACE_MS = 2_500

const COMPLETIONS_PATH = '/v1/chat/completions'

/**
 * OpenAI Chat Completions wire transport.
 *
 * Behaviour that is part of the contract:
 * - always requests `stream_options.include_usage` and keeps a 2,500 ms grace
 *   window after `finish_reason` so a separate trailing usage frame is read;
 * - reads `reasoning_content`, `reasoning` and `reasoning_text` aliases, one
 *   non-empty field per frame, and carries `reasoning_details` through the
 *   {@link ReplayEnvelope} for same-origin replay;
 * - assembles streamed tool-call arguments by provider index, deferring the
 *   block start until both id and name are known;
 * - filters leaked DeepSeek template markers across frame boundaries when
 *   `compat.stripTemplateTokens` is enabled;
 * - normalises a zero-block terminal into `EMPTY_RESPONSE` and a structurally
 *   broken terminal tool payload into `MALFORMED_RESPONSE`.
 */
export const completionsEngine: DirectWireEngine = {
  build: buildCompletionsRequest,
  decode: decodeCompletionsStream,
}

/* -------------------------------------------------------------------------- */
/*                                  request                                  */
/* -------------------------------------------------------------------------- */

function buildCompletionsRequest(
  snapshot: PreparedChatCallSnapshot,
  config: DirectRouteConfig,
): WireRequest {
  const body: Record<string, unknown> = {
    model: String(snapshot.modelId),
    messages: buildMessages(snapshot, config),
    stream: true,
    stream_options: { include_usage: true },
  }

  const sampling = snapshot.sampling
  if (isSome(sampling.temperature)) body.temperature = sampling.temperature.value
  if (isSome(sampling.topP)) body.top_p = sampling.topP.value
  if (isSome(sampling.frequencyPenalty)) body.frequency_penalty = sampling.frequencyPenalty.value
  if (isSome(sampling.presencePenalty)) body.presence_penalty = sampling.presencePenalty.value
  if (sampling.stopSequences.length > 0) body.stop = [...sampling.stopSequences]
  if (isSome(sampling.maxOutputTokens)) body.max_tokens = sampling.maxOutputTokens.value

  if (snapshot.tools.length > 0) {
    const strictAllowed = config.compat?.disableStrictTools !== true
    body.tools = snapshot.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
        ...(tool.strict && strictAllowed ? { strict: true } : {}),
      },
    }))
    body.tool_choice = mapToolChoice(snapshot.effectiveToolChoice)
  }

  if (config.gateway === 'openrouter') {
    body.reasoning =
      snapshot.effectiveEffort === 'off'
        ? { enabled: false }
        : { effort: mapOpenRouterEffort(snapshot.effectiveEffort) }
  }

  return { path: COMPLETIONS_PATH, body }
}

function mapToolChoice(choice: NeutralToolChoice): unknown {
  switch (choice.kind) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'named':
      return { type: 'function', function: { name: choice.toolName } }
  }
}

function mapOpenRouterEffort(effort: ReasoningEffort): 'minimal' | 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'xhigh':
    case 'max':
    case 'high':
      return 'high'
    case 'off':
      return 'high'
  }
}

function buildMessages(
  snapshot: PreparedChatCallSnapshot,
  config: DirectRouteConfig,
): Record<string, unknown>[] {
  const request = snapshot.request
  const messages: Record<string, unknown>[] = []
  const injectCacheMarkers = shouldInjectCacheMarkers(snapshot, config)

  const systemText = request.segment1Static
    .map((segment) => segment.text)
    .filter((text) => text.length > 0)
    .join('\n\n')
  if (systemText.length > 0) {
    messages.push({
      role: 'system',
      content: injectCacheMarkers
        ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
        : systemText,
    })
  }

  const historyStart = messages.length
  for (const message of request.segment2WarmHistory) {
    messages.push(convertHistoryMessage(message, snapshot, config))
  }
  if (injectCacheMarkers && messages.length > historyStart) {
    markCacheBreakpoint(messages[messages.length - 1])
  }

  if (isSome(request.segment3VolatileTail) && request.segment3VolatileTail.value.length > 0) {
    appendVolatileTail(messages, request.segment3VolatileTail.value, snapshot)
  }

  return messages
}

function shouldInjectCacheMarkers(
  snapshot: PreparedChatCallSnapshot,
  config: DirectRouteConfig,
): boolean {
  return (
    config.gateway === 'openrouter' &&
    String(snapshot.modelId).startsWith('anthropic/') &&
    snapshot.sampling.cacheRetention !== 'none'
  )
}

function markCacheBreakpoint(message: Record<string, unknown> | undefined): void {
  if (message === undefined) return
  const content = message.content
  if (typeof content !== 'string' || content.length === 0) return
  message.content = [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
}

function appendVolatileTail(
  messages: Record<string, unknown>[],
  tail: string,
  snapshot: PreparedChatCallSnapshot,
): void {
  const hasAnchor = snapshot.request.segment2WarmHistory.some(
    (message) => message.role === 'user' || message.role === 'tool-result',
  )
  if (snapshot.capabilities.systemPromptUpdate === 'in-history' && hasAnchor) {
    messages.push({ role: 'system', content: tail })
    return
  }
  const wrapped = `<turn-context>${tail}</turn-context>`
  const last = messages[messages.length - 1]
  if (last !== undefined && last.role === 'user' && typeof last.content === 'string') {
    last.content = `${last.content}\n\n${wrapped}`
    return
  }
  messages.push({ role: 'user', content: wrapped })
}

function convertHistoryMessage(
  message: NeutralMessage,
  snapshot: PreparedChatCallSnapshot,
  config: DirectRouteConfig,
): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content.map((block) => block.text).join('') }
    case 'tool-result':
      return {
        role: 'tool',
        tool_call_id: String(message.toolCallId),
        content: message.content,
      }
    case 'assistant': {
      let text = ''
      let reasoning = ''
      const toolCalls: Record<string, unknown>[] = []
      for (const block of message.content) {
        if (block.type === 'text') text += block.text
        else if (block.type === 'reasoning') reasoning += block.text
        else {
          toolCalls.push({
            id: String(block.id),
            type: 'function',
            function: { name: block.name, arguments: block.argumentsJson },
          })
        }
      }
      const assistant: Record<string, unknown> = {
        role: 'assistant',
        content:
          text.length > 0
            ? text
            : toolCalls.length > 0
              ? config.gateway === 'deepseek'
                ? '.'
                : null
              : '',
      }
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls

      const sameOrigin =
        message.origin.routeId === snapshot.routeId && message.origin.modelId === snapshot.modelId
      const envelope =
        sameOrigin && isSome(message.origin.replayState)
          ? readCompletionsEnvelope(message.origin.replayState.value)
          : undefined
      if (envelope?.reasoningDetails !== undefined && envelope.reasoningDetails.length > 0) {
        assistant.reasoning_details = [...envelope.reasoningDetails]
      } else {
        const reasoningField = config.compat?.reasoningField
        if (
          reasoningField !== undefined &&
          reasoning.length > 0 &&
          snapshot.effectiveEffort !== 'off'
        ) {
          assistant[reasoningField] = reasoning
        }
      }
      return assistant
    }
  }
}

interface CompletionsEnvelope {
  readonly reasoningDetails?: readonly unknown[]
}

function readCompletionsEnvelope(envelope: ReplayEnvelope): CompletionsEnvelope | undefined {
  if (
    envelope.adapterKind !== COMPLETIONS_REPLAY_ADAPTER_KIND ||
    envelope.version !== COMPLETIONS_REPLAY_VERSION
  ) {
    return undefined
  }
  const response = envelope.response
  if (typeof response !== 'object' || response === null) return undefined
  const details = (response as Record<string, unknown>).reasoningDetails
  if (details === undefined || !Array.isArray(details)) return {}
  // Entries are provider-native reasoning records. A non-record element means
  // the envelope was built for a different array, so replay nothing at all
  // instead of forwarding a partially valid list onto the wire.
  const list: unknown[] = details
  if (list.some((detail) => !isPlainRecord(detail))) return undefined
  return { reasoningDetails: list }
}

/* -------------------------------------------------------------------------- */
/*                                  response                                 */
/* -------------------------------------------------------------------------- */

interface ToolCallState {
  blockIndex: number | undefined
  id: string | undefined
  name: string | undefined
  args: string
  emittedArgs: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function mapUpstreamErrorCode(error: unknown): 'RATE_LIMIT' | 'AUTH' | 'QUOTA' | 'SERVER' {
  const record = asRecord(error)
  const signal = `${String(record?.type ?? '')} ${String(record?.code ?? '')}`.toLowerCase()
  if (signal.includes('rate') || signal.includes('overloaded')) return 'RATE_LIMIT'
  if (signal.includes('auth') || signal.includes('api_key') || signal.includes('forbidden')) {
    return 'AUTH'
  }
  if (signal.includes('quota') || signal.includes('billing') || signal.includes('balance')) {
    return 'QUOTA'
  }
  return 'SERVER'
}

function extractErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  const record = asRecord(error)
  if (record === undefined) return undefined
  return typeof record.message === 'string' ? record.message : undefined
}

function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const rounded = Math.round(value)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

function readCost(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function parseUsage(raw: unknown): DisjointTokenUsage | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const promptTokens = readTokenCount(record.prompt_tokens ?? record.input_tokens)
  const outputTokens = readTokenCount(record.completion_tokens ?? record.output_tokens)
  if (promptTokens === undefined || outputTokens === undefined) return undefined

  const promptDetails = asRecord(record.prompt_tokens_details)
  const completionDetails = asRecord(record.completion_tokens_details)
  const cached =
    readTokenCount(
      record.prompt_cache_hit_tokens ?? promptDetails?.cached_tokens ?? record.cached_tokens,
    ) ?? 0
  const cacheWrite =
    readTokenCount(record.prompt_cache_write_tokens ?? promptDetails?.cache_write_tokens) ?? 0
  const reasoningTokens = readTokenCount(
    completionDetails?.reasoning_tokens ?? record.reasoning_tokens,
  )
  const cost = readCost(record.cost ?? record.total_cost ?? record.cost_usd)

  const cacheReadTokens = Math.min(cached, promptTokens)
  const cacheWriteTokens = Math.min(cacheWrite, Math.max(0, promptTokens - cacheReadTokens))
  return {
    inputUncachedTokens: promptTokens - cacheReadTokens - cacheWriteTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: reasoningTokens === undefined ? NONE : some(reasoningTokens),
    authoritativeCostUsd: cost === undefined ? NONE : some(cost),
  }
}

type DeadlineOutcome<T> =
  | { readonly kind: 'result'; readonly result: IteratorResult<T> }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'error'; readonly error: unknown }

/**
 * Await the next event, honouring an optional absolute deadline. The deadline
 * is only used after the provider has already declared its finish reason.
 */
async function nextBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: number | undefined,
): Promise<DeadlineOutcome<T>> {
  if (deadline === undefined) {
    try {
      return { kind: 'result', result: await iterator.next() }
    } catch (error) {
      return { kind: 'error', error }
    }
  }
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { kind: 'deadline' }
  const { promise, resolve } = Promise.withResolvers<DeadlineOutcome<T>>()
  const timer = setTimeout(() => resolve({ kind: 'deadline' }), remaining)
  iterator.next().then(
    (result) => {
      clearTimeout(timer)
      resolve({ kind: 'result', result })
    },
    (error) => {
      clearTimeout(timer)
      resolve({ kind: 'error', error })
    },
  )
  return promise
}

/**
 * Streaming filter for leaked DeepSeek `<｜...｜>` / `<|...|>` template markers.
 * A partially received marker is held back so a marker split across two frames
 * is never emitted; a token still incomplete at flush time is dropped.
 */
export class TemplateTokenFilter {
  #buffer = ''

  push(chunk: string): string {
    this.#buffer += chunk
    let output = ''
    while (true) {
      const fullWidthOpen = this.#buffer.indexOf('<｜')
      const asciiOpen = this.#buffer.indexOf('<|')
      let open = -1
      let closeSequence = ''
      if (fullWidthOpen >= 0 && (asciiOpen < 0 || fullWidthOpen < asciiOpen)) {
        open = fullWidthOpen
        closeSequence = '｜>'
      } else if (asciiOpen >= 0) {
        open = asciiOpen
        closeSequence = '|>'
      }
      if (open < 0) {
        if (this.#buffer.endsWith('<')) {
          output += this.#buffer.slice(0, -1)
          this.#buffer = '<'
        } else {
          output += this.#buffer
          this.#buffer = ''
        }
        return output
      }
      const close = this.#buffer.indexOf(closeSequence, open + 2)
      if (close < 0) {
        output += this.#buffer.slice(0, open)
        this.#buffer = this.#buffer.slice(open)
        return output
      }
      output += this.#buffer.slice(0, open)
      this.#buffer = this.#buffer.slice(close + closeSequence.length)
    }
  }

  flush(): string {
    this.#buffer = ''
    return ''
  }
}

/**
 * Decode an OpenAI-compatible SSE event stream into a complete, protocol-legal
 * chunk sequence. The generator emits exactly one terminal `finish` for every
 * provider terminal; an EOF before the provider terminal simply ends, which the
 * direct runtime normalises to `TRANSPORT` without splicing another attempt.
 */
async function* decodeCompletionsStream(
  events: AsyncIterable<SseEvent>,
  _snapshot: PreparedChatCallSnapshot,
  config: DirectRouteConfig,
): AsyncGenerator<StreamChunk> {
  const stripTemplates = config.compat?.stripTemplateTokens === true
  const filter = new TemplateTokenFilter()
  const toolCalls = new Map<number, ToolCallState>()
  const reasoningDetails: unknown[] = []
  let textBlock: { readonly index: number; readonly parts: string[] } | undefined
  let reasoningBlock: { readonly index: number; readonly parts: string[] } | undefined
  let nextBlockIndex = 0
  let firstByteSent = false
  let finishReason: string | undefined
  let finishDeadline: number | undefined
  let latestUsage: DisjointTokenUsage | undefined
  let sawTerminal = false
  let sawAnyEvent = false

  function* ensureFirstByte(): Generator<StreamChunk, void, undefined> {
    if (firstByteSent) return
    firstByteSent = true
    yield { type: 'first-byte' }
  }

  function* startTextBlock(): Generator<StreamChunk, void, undefined> {
    if (textBlock !== undefined) return
    const index = nextBlockIndex
    nextBlockIndex += 1
    textBlock = { index, parts: [] }
    yield* ensureFirstByte()
    yield { type: 'block-start', index, blockType: 'text' }
  }

  function* startReasoningBlock(): Generator<StreamChunk, void, undefined> {
    if (reasoningBlock !== undefined) return
    const index = nextBlockIndex
    nextBlockIndex += 1
    reasoningBlock = { index, parts: [] }
    yield* ensureFirstByte()
    yield { type: 'block-start', index, blockType: 'reasoning' }
  }

  function* startToolBlock(state: ToolCallState): Generator<StreamChunk, void, undefined> {
    if (state.blockIndex !== undefined || state.id === undefined || state.name === undefined) {
      return
    }
    const index = nextBlockIndex
    nextBlockIndex += 1
    state.blockIndex = index
    yield* ensureFirstByte()
    yield {
      type: 'block-start',
      index,
      blockType: 'tool-call',
      toolCallId: state.id as ToolCallId,
      toolName: state.name,
    }
  }

  const iterator = events[Symbol.asyncIterator]()
  try {
    while (true) {
      const outcome = await nextBeforeDeadline(iterator, finishDeadline)
      if (outcome.kind === 'deadline') break
      if (outcome.kind === 'error') throw outcome.error
      if (outcome.result.done) break
      const event = outcome.result.value
      if (event === undefined) continue
      sawAnyEvent = true
      const data = event.data.trim()
      if (data.length === 0) continue
      if (data === '[DONE]') {
        sawTerminal = true
        break
      }

      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        throw failure('MALFORMED_RESPONSE', 'upstream SSE frame carried invalid JSON')
      }
      const record = asRecord(payload)
      if (record === undefined) {
        throw failure('MALFORMED_RESPONSE', 'upstream SSE frame was not a JSON object')
      }

      if (record.error !== undefined && record.choices === undefined) {
        throw failure(
          mapUpstreamErrorCode(record.error),
          extractErrorMessage(record.error) ?? 'upstream reported an error frame',
        )
      }

      if (record.usage !== undefined) {
        const usage = parseUsage(record.usage)
        if (usage !== undefined) latestUsage = usage
      }

      const choices = record.choices
      if (!Array.isArray(choices) || choices.length === 0) continue
      const choice = asRecord(choices[0])
      if (choice === undefined) continue

      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        if (finishReason === undefined) {
          finishReason = choice.finish_reason
          finishDeadline = Date.now() + TRAILING_USAGE_GRACE_MS
          sawTerminal = true
        }
      }

      const delta = asRecord(choice.delta)
      if (delta === undefined) continue

      const reasoningText = firstNonEmptyString(
        delta.reasoning_content,
        delta.reasoning,
        delta.reasoning_text,
      )
      if (reasoningText !== undefined) {
        if (!reasoningText.isWellFormed()) {
          throw failure(
            'MALFORMED_RESPONSE',
            'upstream reasoning delta was not well-formed Unicode',
          )
        }
        yield* startReasoningBlock()
        const block = reasoningBlock
        if (block !== undefined) {
          block.parts.push(reasoningText)
          yield { type: 'reasoning-delta', index: block.index, delta: reasoningText }
        }
      }
      if (Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) reasoningDetails.push(detail)
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!delta.content.isWellFormed()) {
          throw failure('MALFORMED_RESPONSE', 'upstream text delta was not well-formed Unicode')
        }
        const filtered = stripTemplates ? filter.push(delta.content) : delta.content
        if (filtered.length > 0) {
          yield* startTextBlock()
          const block = textBlock
          if (block !== undefined) {
            block.parts.push(filtered)
            yield { type: 'text-delta', index: block.index, delta: filtered }
          }
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const rawToolCall of delta.tool_calls) {
          const entry = asRecord(rawToolCall)
          if (entry === undefined) {
            throw failure('MALFORMED_RESPONSE', 'upstream tool-call delta was not an object')
          }
          const providerIndex = entry.index
          if (
            typeof providerIndex !== 'number' ||
            !Number.isInteger(providerIndex) ||
            providerIndex < 0
          ) {
            throw failure('MALFORMED_RESPONSE', 'upstream tool-call delta had an invalid index')
          }
          let state = toolCalls.get(providerIndex)
          if (state === undefined) {
            state = {
              blockIndex: undefined,
              id: undefined,
              name: undefined,
              args: '',
              emittedArgs: 0,
            }
            toolCalls.set(providerIndex, state)
          }
          if (state.id === undefined && typeof entry.id === 'string' && entry.id.length > 0) {
            if (!entry.id.isWellFormed()) {
              throw failure(
                'MALFORMED_RESPONSE',
                'upstream tool call id was not well-formed Unicode',
              )
            }
            state.id = entry.id
          }
          const fn = asRecord(entry.function)
          if (fn !== undefined) {
            if (state.name === undefined && typeof fn.name === 'string' && fn.name.length > 0) {
              if (!fn.name.isWellFormed()) {
                throw failure(
                  'MALFORMED_RESPONSE',
                  'upstream tool name was not well-formed Unicode',
                )
              }
              state.name = fn.name
            }
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
              if (!fn.arguments.isWellFormed()) {
                throw failure(
                  'MALFORMED_RESPONSE',
                  'upstream tool arguments were not well-formed Unicode',
                )
              }
              state.args += fn.arguments
            }
          }
          yield* startToolBlock(state)
          if (state.blockIndex !== undefined && state.args.length > state.emittedArgs) {
            const deltaText = state.args.slice(state.emittedArgs)
            state.emittedArgs = state.args.length
            yield { type: 'tool-call-delta', index: state.blockIndex, delta: deltaText }
          }
        }
      }
    }
  } finally {
    // Non-blocking close: an async generator's `return()` queues behind a
    // pending read, and the runtime aborts the shared transport signal once the
    // terminal frame is delivered.
    Promise.resolve(iterator.return?.()).catch(() => undefined)
  }

  if (!sawTerminal) {
    // Premature EOF: no terminal frame of our own; the runtime maps this to
    // TRANSPORT and must not append a synthetic success.
    if (nextBlockIndex === 0 && !sawAnyEvent) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: failure('EMPTY_RESPONSE', 'upstream returned no content blocks'),
        },
        replayState: NONE,
        observedAttempts: 1,
      }
    }
    return
  }

  if (stripTemplates && textBlock !== undefined) {
    const tail = filter.flush()
    if (tail.length > 0) {
      textBlock.parts.push(tail)
      yield { type: 'text-delta', index: textBlock.index, delta: tail }
    }
  }

  if (nextBlockIndex === 0) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: failure('EMPTY_RESPONSE', 'upstream finished without any content blocks'),
      },
      replayState: NONE,
      observedAttempts: 1,
    }
    return
  }

  if (finishReason === 'content_filter') {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: failure('CONTENT_BLOCKED', 'upstream content filter blocked the response'),
      },
      replayState: NONE,
      observedAttempts: 1,
    }
    return
  }

  const startedToolStates = [...toolCalls.values()].filter(
    (state) => state.blockIndex !== undefined,
  )
  const kind: 'stop' | 'tool-calls' | 'max-tokens' =
    finishReason === 'length'
      ? 'max-tokens'
      : startedToolStates.length > 0 || finishReason === 'tool_calls'
        ? 'tool-calls'
        : 'stop'
  if (kind === 'tool-calls' && startedToolStates.length === 0) {
    throw failure('MALFORMED_RESPONSE', 'upstream reported tool calls without any tool-call blocks')
  }
  for (const state of toolCalls.values()) {
    if (state.blockIndex === undefined) {
      throw failure('MALFORMED_RESPONSE', 'upstream tool call never produced an id and a name')
    }
  }

  const closures: { readonly index: number; readonly block: NeutralContentBlock }[] = []
  if (textBlock !== undefined) {
    closures.push({
      index: textBlock.index,
      block: { type: 'text', text: textBlock.parts.join('') },
    })
  }
  if (reasoningBlock !== undefined) {
    closures.push({
      index: reasoningBlock.index,
      block: { type: 'reasoning', text: reasoningBlock.parts.join('') },
    })
  }
  for (const state of startedToolStates) {
    const index = state.blockIndex
    const id = state.id
    const name = state.name
    if (index === undefined || id === undefined || name === undefined) continue
    const argumentsJson = state.args.length > 0 ? state.args : '{}'
    if (kind !== 'max-tokens') {
      let parsedArguments: unknown
      try {
        parsedArguments = JSON.parse(argumentsJson)
      } catch {
        throw failure('MALFORMED_RESPONSE', 'a streamed tool call produced invalid JSON arguments')
      }
      if (
        typeof parsedArguments !== 'object' ||
        parsedArguments === null ||
        Array.isArray(parsedArguments)
      ) {
        throw failure('MALFORMED_RESPONSE', 'a streamed tool call did not produce a JSON object')
      }
    }
    closures.push({
      index,
      block: { type: 'tool-call', id: id as ToolCallId, name, argumentsJson },
    })
  }
  closures.sort((left, right) => left.index - right.index)
  for (const closure of closures) {
    yield { type: 'block-end', index: closure.index, block: closure.block }
  }

  if (latestUsage !== undefined && nextBlockIndex >= 1) {
    yield { type: 'usage', usage: latestUsage }
  }

  const replayState =
    reasoningDetails.length === 0
      ? NONE
      : some({
          adapterKind: COMPLETIONS_REPLAY_ADAPTER_KIND,
          version: COMPLETIONS_REPLAY_VERSION,
          response: Object.freeze({ reasoningDetails: Object.freeze([...reasoningDetails]) }),
        })
  const reason: FinishReason = { kind }
  yield {
    type: 'finish',
    reason,
    replayState,
    observedAttempts: 1,
  }
}
