import { InvariantError, isNone, isSome, NONE, type Option, some } from '@sekaisen/core'
import type {
  ModelCapabilities,
  NeutralToolChoice,
  PreparedChatCallSnapshot,
  ReasoningEffort,
} from '../service-types.ts'
import type { NormalizedWireToolSchema } from '../tool-schema.ts'
import type {
  AssistantMessageOrigin,
  CacheBreakpointHint,
  FinishReason,
  LlmFailure,
  NeutralAssistantMessage,
  NeutralContentBlock,
  NeutralMessage,
  NeutralToolResultMessage,
  NeutralUserMessage,
  ReasoningBlock,
  ReplayEnvelope,
  StreamChunk,
  TextBlock,
  ToolCallBlock,
  ToolCallId,
} from '../types.ts'
import { failure, isPlainRecord, validString } from '../utils.ts'
import type { DirectRouteConfig, DirectWireEngine, SseEvent, WireRequest } from './contract.ts'

/* -------------------------------------------------------------------------- */
/*                                Constants                                   */
/* -------------------------------------------------------------------------- */

/** Replay envelope kind for the direct Anthropic Messages engine (`'direct:' + protocol`). */
export const ANTHROPIC_REPLAY_ADAPTER_KIND = 'direct:anthropic-messages'

const REPLAY_VERSION = 1
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'
const MIN_THINKING_BUDGET = 1024
const THINKING_HEADROOM_TOKENS = 1024

const SUPPORTED_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type SupportedEffort = (typeof SUPPORTED_EFFORTS)[number]

const EFFORT_BUDGET_TOKENS: Readonly<Record<SupportedEffort, number>> = Object.freeze({
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
})

/* -------------------------------------------------------------------------- */
/*                              Wire vocabulary                               */
/* -------------------------------------------------------------------------- */

interface WireCacheControl {
  readonly type: 'ephemeral'
  readonly ttl?: '1h'
}

/**
 * Mutable during assembly only (cache breakpoints are anchored after the stable
 * history has been laid out); the frozen request body is what leaves the process.
 */
interface WireTextBlock {
  readonly type: 'text'
  readonly text: string
  cache_control?: WireCacheControl
}

interface WireThinkingBlock {
  readonly type: 'thinking'
  readonly thinking: string
  readonly signature: string
  cache_control?: WireCacheControl
}

interface WireRedactedThinkingBlock {
  readonly type: 'redacted_thinking'
  readonly data: string
  cache_control?: WireCacheControl
}

interface WireToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
  cache_control?: WireCacheControl
}

interface WireToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
  cache_control?: WireCacheControl
}

type WireContentBlock =
  | WireTextBlock
  | WireThinkingBlock
  | WireRedactedThinkingBlock
  | WireToolUseBlock
  | WireToolResultBlock

type WireRole = 'user' | 'assistant' | 'system'

interface WireMessage {
  readonly role: WireRole
  readonly content: WireContentBlock[]
}

/* -------------------------------------------------------------------------- */
/*                              Small utilities                               */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const target = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === target)
}

function cacheControl(ttl: '1h' | undefined): WireCacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function effortIndex(effort: SupportedEffort): number {
  return SUPPORTED_EFFORTS.indexOf(effort)
}

function nearestSupportedEffort(
  supported: readonly Exclude<ReasoningEffort, 'off'>[],
  requested: SupportedEffort,
): SupportedEffort {
  const target = effortIndex(requested)
  let best: SupportedEffort | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of supported) {
    const distance = Math.abs(effortIndex(candidate) - target)
    // Ties prefer the cheaper (lower) effort so retries never inflate spend.
    if (
      distance < bestDistance ||
      (distance === bestDistance && effortIndex(candidate) < effortIndex(best!))
    ) {
      best = candidate
      bestDistance = distance
    }
  }
  return best ?? requested
}

/**
 * Resolve the prepared effort against the target's declared support. The service
 * normally clamps already; this keeps the wire legal if a capability table changes
 * between preparation and dispatch.
 */
function resolveEffort(
  capabilities: ModelCapabilities,
  requested: ReasoningEffort,
): ReasoningEffort {
  const supported = capabilities.supportedEfforts
  if (requested === 'off') {
    if (capabilities.canDisableReasoning) return 'off'
    if (supported.length === 0) return 'off'
    let lowest: SupportedEffort = supported[0]!
    for (const candidate of supported)
      if (effortIndex(candidate) < effortIndex(lowest)) lowest = candidate
    return lowest
  }
  if (supported.length === 0) return capabilities.canDisableReasoning ? 'off' : requested
  if (supported.includes(requested)) return requested
  return nearestSupportedEffort(supported, requested)
}

function gatewayEffort(effort: SupportedEffort): string {
  // DeepSeek's Messages route exposes `output_config.effort` with a narrower ladder.
  if (effort === 'minimal') return 'low'
  if (effort === 'xhigh') return 'max'
  return effort
}

function escapeTurnContext(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function turnContextWrapper(text: string): string {
  return `<turn-context>${escapeTurnContext(text)}</turn-context>`
}

/* -------------------------------------------------------------------------- */
/*                            Replay state codec                              */
/* -------------------------------------------------------------------------- */

type ReplayBlockMeta =
  | { readonly kind: 'text' }
  | { readonly kind: 'thinking'; readonly signature: string }
  | { readonly kind: 'redacted_thinking'; readonly data: string }
  | { readonly kind: 'tool_use'; readonly id: string; readonly name: string }

function parseReplayBlockMeta(raw: unknown): ReplayBlockMeta | undefined {
  if (!isPlainRecord(raw)) return undefined
  switch (raw.kind) {
    case 'text':
      return { kind: 'text' }
    case 'thinking': {
      const signature = raw.signature
      return validString(signature) ? { kind: 'thinking', signature } : undefined
    }
    case 'redacted_thinking': {
      const data = raw.data
      return validString(data, true) ? { kind: 'redacted_thinking', data } : undefined
    }
    case 'tool_use': {
      const id = raw.id
      const name = raw.name
      return validString(id, true) && validString(name, true)
        ? { kind: 'tool_use', id, name }
        : undefined
    }
    default:
      return undefined
  }
}

function replayMetaFitsContent(meta: ReplayBlockMeta, block: NeutralContentBlock): boolean {
  switch (block.type) {
    case 'text':
      return meta.kind === 'text'
    case 'reasoning':
      return meta.kind === 'thinking' || meta.kind === 'redacted_thinking'
    case 'tool-call':
      // The private metadata must describe this exact call; a mismatched id/name
      // means the envelope was built for a different block array.
      return meta.kind === 'tool_use' && meta.id === block.id && meta.name === block.name
  }
}

function playableReasoningMeta(meta: ReplayBlockMeta | undefined): ReplayBlockMeta | undefined {
  if (meta?.kind === 'thinking' && meta.signature.length > 0) return meta
  if (meta?.kind === 'redacted_thinking' && meta.data.length > 0) return meta
  return undefined
}

/**
 * Decode an opaque replay envelope only when it is strictly same-origin
 * (`adapterKind`, version, 1:1 block alignment, matching block shapes).
 * Anything else is silently ignored so foreign signatures never reach the wire.
 */
function parseReplayEnvelope(
  origin: AssistantMessageOrigin,
  content: readonly NeutralContentBlock[],
): readonly ReplayBlockMeta[] | undefined {
  const state = origin.replayState
  if (isNone(state)) return undefined
  const envelope = state.value
  if (!isPlainRecord(envelope)) return undefined
  if (envelope.adapterKind !== ANTHROPIC_REPLAY_ADAPTER_KIND) return undefined
  if (envelope.version !== REPLAY_VERSION) return undefined
  const rawBlocks = envelope.blocks
  if (!Array.isArray(rawBlocks) || rawBlocks.length !== content.length) return undefined
  const metas: ReplayBlockMeta[] = []
  for (let index = 0; index < rawBlocks.length; index += 1) {
    const meta = parseReplayBlockMeta(rawBlocks[index])
    const block = content[index]
    if (meta === undefined || block === undefined) return undefined
    if (!replayMetaFitsContent(meta, block)) return undefined
    metas.push(meta)
  }
  return metas
}

function replayMetasFor(
  message: NeutralAssistantMessage,
  snapshot: PreparedChatCallSnapshot,
): readonly ReplayBlockMeta[] | undefined {
  const origin = message.origin
  if ((origin.routeId as string) !== (snapshot.routeId as string)) return undefined
  if ((origin.modelId as string) !== (snapshot.modelId as string)) return undefined
  return parseReplayEnvelope(origin, message.content)
}

/* -------------------------------------------------------------------------- */
/*                          History projection                                */
/* -------------------------------------------------------------------------- */

interface ProjectedMessage {
  readonly role: 'user' | 'assistant'
  readonly blocks: WireContentBlock[]
}

function parseHistoryToolInput(block: ToolCallBlock): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(block.argumentsJson)
  } catch {
    throw failure('INVALID_REQUEST', 'history tool-call arguments are not valid JSON')
  }
  if (!isPlainRecord(parsed)) {
    throw failure('INVALID_REQUEST', 'history tool-call arguments are not a JSON object')
  }
  return parsed
}

function projectUserMessage(message: NeutralUserMessage): ProjectedMessage {
  const blocks: WireContentBlock[] = []
  for (const block of message.content) {
    if (block.text.length === 0) continue
    blocks.push({ type: 'text', text: block.text })
  }
  return { role: 'user', blocks }
}

function projectAssistantMessage(
  message: NeutralAssistantMessage,
  snapshot: PreparedChatCallSnapshot,
): ProjectedMessage {
  const metas = replayMetasFor(message, snapshot)
  const nonTool: WireContentBlock[] = []
  const toolBlocks: WireContentBlock[] = []
  for (let index = 0; index < message.content.length; index += 1) {
    const block = message.content[index]!
    if (block.type === 'text') {
      if (block.text.length === 0) continue
      nonTool.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'reasoning') {
      const meta = playableReasoningMeta(metas?.[index])
      if (meta?.kind === 'redacted_thinking') {
        nonTool.push({ type: 'redacted_thinking', data: meta.data })
      } else if (meta?.kind === 'thinking') {
        nonTool.push({ type: 'thinking', thinking: block.text, signature: meta.signature })
      }
      // Unsigned thinking cannot be replayed: Anthropic rejects `thinking`
      // blocks without a signature, and promoting them to text would corrupt
      // the transcript. Drop the block instead.
      continue
    }
    toolBlocks.push({
      type: 'tool_use',
      id: block.id as string,
      name: block.name,
      input: parseHistoryToolInput(block),
    })
  }
  // Anthropic requires tool_use blocks to trail the assistant turn's other
  // blocks so that the paired tool_result user turn follows immediately.
  return { role: 'assistant', blocks: [...nonTool, ...toolBlocks] }
}

function projectToolResultMessage(message: NeutralToolResultMessage): ProjectedMessage {
  return {
    role: 'user',
    blocks: [
      {
        type: 'tool_result',
        tool_use_id: message.toolCallId as string,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      },
    ],
  }
}

function projectMessage(
  message: NeutralMessage,
  snapshot: PreparedChatCallSnapshot,
): ProjectedMessage {
  switch (message.role) {
    case 'user':
      return projectUserMessage(message)
    case 'assistant':
      return projectAssistantMessage(message, snapshot)
    case 'tool-result':
      return projectToolResultMessage(message)
  }
}

function appendWireMessage(messages: WireMessage[], projected: ProjectedMessage): void {
  if (projected.blocks.length === 0) return
  const last = messages.at(-1)
  if (last !== undefined && last.role === projected.role) {
    last.content.push(...projected.blocks)
    return
  }
  messages.push({ role: projected.role, content: [...projected.blocks] })
}

/**
 * Anthropic only accepts `cache_control` on input content blocks; thinking
 * blocks carry signatures, not cache markers. A breakpoint therefore anchors on
 * the last text/tool block of the prefix.
 */
function isCacheableBlock(block: WireContentBlock): boolean {
  return block.type === 'text' || block.type === 'tool_use' || block.type === 'tool_result'
}

interface CacheAnchor {
  readonly index: number
  readonly hint: CacheBreakpointHint | undefined
}

function pickHistoryCacheAnchor(history: readonly NeutralMessage[]): CacheAnchor | undefined {
  if (history.length === 0) return undefined
  const index = history.length - 1
  return { index, hint: history[index]!.cacheBreakpoint }
}

function anchorTtl(
  hint: CacheBreakpointHint | undefined,
  retention: 'none' | 'short' | 'long',
): '1h' | undefined {
  if (hint === 'long') return '1h'
  if (hint === 'ephemeral') return undefined
  return retention === 'long' ? '1h' : undefined
}

/* -------------------------------------------------------------------------- */
/*                              Request assembly                              */
/* -------------------------------------------------------------------------- */

function maxTokensAndBudget(
  snapshot: PreparedChatCallSnapshot,
  effort: ReasoningEffort,
  gateway: DirectRouteConfig['gateway'],
): { readonly maxTokens: number | undefined; readonly budget: number | undefined } {
  const capabilities = snapshot.capabilities
  const capabilityMax =
    Number.isSafeInteger(capabilities.maxOutputTokens) && capabilities.maxOutputTokens > 0
      ? capabilities.maxOutputTokens
      : undefined
  const explicitMax = isSome(snapshot.sampling.maxOutputTokens)
    ? clampInt(snapshot.sampling.maxOutputTokens.value, 1, capabilityMax ?? Number.MAX_SAFE_INTEGER)
    : undefined
  const ceiling = explicitMax ?? capabilityMax
  const budgetThinking = effort !== 'off' && gateway !== 'deepseek'
  if (!budgetThinking) return { maxTokens: ceiling, budget: undefined }

  const desired = EFFORT_BUDGET_TOKENS[effort as SupportedEffort]
  const capacity = ceiling ?? desired + THINKING_HEADROOM_TOKENS
  let budget: number | undefined
  if (capacity >= desired + THINKING_HEADROOM_TOKENS) {
    budget = desired
  } else {
    const reduced = capacity - THINKING_HEADROOM_TOKENS
    if (reduced >= MIN_THINKING_BUDGET) budget = Math.min(desired, reduced)
  }
  // `max_tokens` must cover the thinking budget plus visible-output headroom.
  const maxTokens = budget === undefined ? ceiling : (ceiling ?? budget + THINKING_HEADROOM_TOKENS)
  return { maxTokens, budget }
}

function wireToolDefinitions(
  tools: readonly NormalizedWireToolSchema[],
  strictAllowed: boolean,
): readonly Record<string, unknown>[] {
  return tools.map((schema) => ({
    name: schema.name,
    description: schema.description,
    input_schema: schema.jsonSchema,
    // The strict decision is computed statically in `prepareChatCall`; the wire
    // only ever advertises it, never silently retries without it.
    ...(schema.strict && strictAllowed ? { strict: true } : {}),
  }))
}

function wireToolChoice(
  choice: NeutralToolChoice,
  hasTools: boolean,
): Record<string, unknown> | undefined {
  if (!hasTools) return undefined
  switch (choice.kind) {
    case 'auto':
      // `auto` is the API default; omitting keeps the stable prefix byte-identical.
      return undefined
    case 'none':
      return { type: 'none' }
    case 'required':
      return { type: 'any' }
    case 'named':
      return { type: 'tool', name: choice.toolName }
  }
}

function wireHeaders(config: DirectRouteConfig): Readonly<Record<string, string>> {
  // Authentication headers are runtime-owned: `x-api-key` vs `Bearer` follows
  // the gateway preset's authMode (OpenCode Anthropic routes send only
  // `x-api-key`), and the runtime strips any auth header coming from here.
  const headers: Record<string, string> = {}
  if (config.headers !== undefined) {
    for (const [name, value] of Object.entries(config.headers)) headers[name] = value
  }
  if (!hasHeader(headers, 'anthropic-version'))
    headers['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION
  return Object.freeze(headers)
}

function buildAnthropicRequest(
  snapshot: PreparedChatCallSnapshot,
  config: DirectRouteConfig,
): WireRequest {
  const request = snapshot.request
  const capabilities = snapshot.capabilities
  const retention = snapshot.sampling.cacheRetention
  const cacheEnabled = retention !== 'none'

  /* Segment 1: stable system prefix, single breakpoint on the final block. */
  const systemBlocks: WireTextBlock[] = []
  for (const segment of request.segment1Static) {
    if (segment.text.length === 0) continue
    systemBlocks.push({ type: 'text', text: segment.text })
  }
  if (cacheEnabled && systemBlocks.length > 0) {
    systemBlocks.at(-1)!.cache_control = cacheControl(retention === 'long' ? '1h' : undefined)
  }

  /* Segment 2: warm history, single breakpoint on the anchored message. */
  const cacheAnchor = cacheEnabled ? pickHistoryCacheAnchor(request.segment2WarmHistory) : undefined
  const messages: WireMessage[] = []
  let lastCacheable: WireContentBlock | undefined
  let anchorBlock: WireContentBlock | undefined
  for (let index = 0; index < request.segment2WarmHistory.length; index += 1) {
    const projected = projectMessage(request.segment2WarmHistory[index]!, snapshot)
    if (projected.blocks.length === 0) continue
    for (const block of projected.blocks) {
      if (isCacheableBlock(block)) lastCacheable = block
    }
    if (cacheAnchor !== undefined && cacheAnchor.index === index) anchorBlock = lastCacheable
    appendWireMessage(messages, projected)
  }
  // The warm-end breakpoint is mandatory for a non-empty history: if the final
  // message projected no cacheable block (e.g. thinking only), anchor on the
  // preceding cacheable block instead of dropping the breakpoint.
  if (anchorBlock === undefined && cacheAnchor !== undefined) anchorBlock = lastCacheable
  if (anchorBlock !== undefined && cacheAnchor !== undefined) {
    anchorBlock.cache_control = cacheControl(anchorTtl(cacheAnchor.hint, retention))
  }

  /* Segment 3: volatile tail, never cached. */
  if (isSome(request.segment3VolatileTail) && request.segment3VolatileTail.value.length > 0) {
    const tail = request.segment3VolatileTail.value
    const last = messages.at(-1)
    const hasUserAnchor = request.segment2WarmHistory.some(
      (message) => message.role === 'user' || message.role === 'tool-result',
    )
    if (capabilities.systemPromptUpdate === 'in-history' && hasUserAnchor) {
      // The target accepts an incremental system turn at the tail of the
      // conversation, so the volatile text needs no pseudo-tag wrapper.
      messages.push({ role: 'system', content: [{ type: 'text', text: tail }] })
    } else if (last !== undefined && last.role === 'user') {
      last.content.push({ type: 'text', text: `\n\n${turnContextWrapper(tail)}` })
    } else {
      messages.push({ role: 'user', content: [{ type: 'text', text: turnContextWrapper(tail) }] })
    }
  }

  /* Sampling parameters are illegal alongside active thinking on many targets. */
  const effort = resolveEffort(capabilities, snapshot.effectiveEffort)
  const { maxTokens, budget } = maxTokensAndBudget(snapshot, effort, config.gateway)
  const thinkingActive = config.gateway === 'deepseek' ? effort !== 'off' : budget !== undefined
  const samplingAllowed = !thinkingActive || capabilities.supportsSamplingWhenThinking

  const tools = wireToolDefinitions(
    snapshot.tools,
    snapshot.capabilities.disableStrictTools !== true && config.compat?.disableStrictTools !== true,
  )
  const toolChoice = wireToolChoice(snapshot.effectiveToolChoice, tools.length > 0)

  const body: Record<string, unknown> = {
    model: snapshot.modelId as string,
    stream: true,
    messages,
  }
  if (systemBlocks.length > 0) body.system = systemBlocks
  const omitImplicitMaxTokens = config.compat?.omitImplicitMaxTokens === true
  const explicitMax = isSome(snapshot.sampling.maxOutputTokens)
  if (maxTokens !== undefined && !(omitImplicitMaxTokens && !explicitMax && budget === undefined)) {
    body.max_tokens = maxTokens
  }
  if (tools.length > 0) {
    body.tools = tools
    if (toolChoice !== undefined) body.tool_choice = toolChoice
  }
  if (capabilities.supportsSamplingParams && samplingAllowed) {
    if (isSome(snapshot.sampling.temperature))
      body.temperature = snapshot.sampling.temperature.value
    if (isSome(snapshot.sampling.topP)) body.top_p = snapshot.sampling.topP.value
  }
  if (snapshot.sampling.stopSequences.length > 0) {
    body.stop_sequences = [...snapshot.sampling.stopSequences]
  }
  if (config.gateway === 'deepseek') {
    if (effort === 'off') body.thinking = { type: 'disabled' }
    else body.output_config = { effort: gatewayEffort(effort) }
  } else if (budget !== undefined) {
    body.thinking = { type: 'enabled', budget_tokens: budget }
  }

  return { path: '/v1/messages', body, headers: wireHeaders(config) }
}

/* -------------------------------------------------------------------------- */
/*                              Stream decoding                               */
/* -------------------------------------------------------------------------- */

interface DecodeBlock {
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  signature: string
  redacted: string
  readonly toolCallId: string
  readonly toolName: string
  inputJson: string
  closed: boolean
}

interface UsageState {
  inputUncached: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: Option<number>
  cost: Option<number>
  seen: boolean
}

interface UsagePatch {
  inputUncached?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
  cost?: number
}

function malformed(message: string): LlmFailure {
  return failure('MALFORMED_RESPONSE', message)
}

function readBlockIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed('content block index is not a non-negative integer')
  }
  return value
}

function readDeltaString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw malformed(`upstream ${label} is not a string`)
  if (!value.isWellFormed()) throw malformed(`upstream ${label} is not well-formed Unicode`)
  return value
}

function readTokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`upstream usage.${label} is not a non-negative safe integer`)
  }
  return value
}

function readUsage(raw: unknown): UsagePatch | undefined {
  if (!isPlainRecord(raw)) return undefined
  const patch: UsagePatch = {}
  const input = readTokenCount(raw.input_tokens, 'input_tokens')
  if (input !== undefined) patch.inputUncached = input
  const cacheRead = readTokenCount(raw.cache_read_input_tokens, 'cache_read_input_tokens')
  if (cacheRead !== undefined) patch.cacheRead = cacheRead
  let cacheWrite = readTokenCount(raw.cache_creation_input_tokens, 'cache_creation_input_tokens')
  const creation = raw.cache_creation
  if (cacheWrite === undefined && isPlainRecord(creation)) {
    // Newer Anthropic usage reports cache writes per TTL bucket.
    const shortLived =
      readTokenCount(creation.ephemeral_5m_input_tokens, 'ephemeral_5m_input_tokens') ?? 0
    const longLived =
      readTokenCount(creation.ephemeral_1h_input_tokens, 'ephemeral_1h_input_tokens') ?? 0
    if (shortLived + longLived > 0) cacheWrite = shortLived + longLived
  }
  if (cacheWrite !== undefined) patch.cacheWrite = cacheWrite
  const output = readTokenCount(raw.output_tokens, 'output_tokens')
  if (output !== undefined) patch.output = output
  const reasoning = readTokenCount(raw.reasoning_output_tokens, 'reasoning_output_tokens')
  if (reasoning !== undefined) patch.reasoning = reasoning
  const cost = raw.cost
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) patch.cost = cost
  return Object.keys(patch).length === 0 ? undefined : patch
}

function applyUsage(state: UsageState, patch: UsagePatch | undefined): void {
  if (patch === undefined) return
  state.seen = true
  // Anthropic reports mutually exclusive buckets; counters are cumulative, so
  // taking the maximum keeps repeated message_delta usage idempotent.
  if (patch.inputUncached !== undefined)
    state.inputUncached = Math.max(state.inputUncached, patch.inputUncached)
  if (patch.cacheRead !== undefined) state.cacheRead = Math.max(state.cacheRead, patch.cacheRead)
  if (patch.cacheWrite !== undefined)
    state.cacheWrite = Math.max(state.cacheWrite, patch.cacheWrite)
  if (patch.output !== undefined) state.output = Math.max(state.output, patch.output)
  if (patch.reasoning !== undefined) state.reasoning = some(patch.reasoning)
  if (patch.cost !== undefined) state.cost = some(patch.cost)
}

function mapProviderError(raw: unknown): LlmFailure {
  const record: JsonObject = isPlainRecord(raw) ? raw : {}
  const rawType = record.type
  const type = typeof rawType === 'string' && rawType.isWellFormed() ? rawType : 'api_error'
  const message = validString(record.message, true)
    ? record.message
    : 'upstream returned an error event'
  const lower = `${type} ${message}`.toLowerCase()
  const contextOverflow =
    (lower.includes('context') && (lower.includes('length') || lower.includes('window'))) ||
    lower.includes('too many tokens') ||
    lower.includes('prompt is too long') ||
    lower.includes('maximum context')
  const contentBlocked =
    lower.includes('content filter') ||
    lower.includes('safety') ||
    lower.includes('prohibited') ||
    lower.includes('blocklist')
  if (type === 'authentication_error' || type === 'permission_error')
    return failure('AUTH', message)
  if (type === 'rate_limit_error') return failure('RATE_LIMIT', message)
  if (type === 'billing_error' || lower.includes('insufficient_quota'))
    return failure('QUOTA', message)
  if (type === 'overloaded_error' || type === 'api_error') return failure('SERVER', message)
  if (contextOverflow) return failure('CONTEXT_WINDOW_EXCEEDED', message)
  if (contentBlocked) return failure('CONTENT_BLOCKED', message)
  if (type === 'invalid_request_error' || type === 'not_found_error') {
    return failure('INVALID_REQUEST', message)
  }
  if (lower.includes('quota') || lower.includes('balance')) return failure('QUOTA', message)
  if (lower.includes('rate limit')) return failure('RATE_LIMIT', message)
  return failure('SERVER', message)
}

function stopReasonToFinish(stopReason: string | undefined, hasToolBlock: boolean): FinishReason {
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  if (hasToolBlock) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Validate a tool call only once the terminal reason proves it was not
 * truncated: `max-tokens` legitimately ends mid-arguments, while a completed
 * turn with unparsable arguments is a malformed upstream response.
 */
function assertCompleteToolArguments(argumentsJson: string, toolName: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    throw malformed(`tool call "${toolName}" produced invalid JSON arguments`)
  }
  if (!isPlainRecord(parsed)) {
    throw malformed(`tool call "${toolName}" produced arguments that are not a JSON object`)
  }
}

function replayEnvelopeFor(
  messageId: string | undefined,
  stopReason: string | undefined,
  metas: readonly ReplayBlockMeta[],
): ReplayEnvelope {
  return {
    adapterKind: ANTHROPIC_REPLAY_ADAPTER_KIND,
    version: REPLAY_VERSION,
    response: { messageId: messageId ?? null, stopReason: stopReason ?? null },
    blocks: metas,
  }
}

async function* decodeAnthropicStream(
  events: AsyncIterable<SseEvent>,
): AsyncGenerator<StreamChunk> {
  const blocks = new Map<number, DecodeBlock>()
  const replayMetas: ReplayBlockMeta[] = []
  const usage: UsageState = {
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: NONE,
    cost: NONE,
    seen: false,
  }
  let nextIndex = 0
  let firstByteEmitted = false
  let messageId: string | undefined
  let stopReason: string | undefined
  let sawMessageStop = false

  /**
   * `first-byte` marks the first *semantic* output: provider metadata frames
   * (`message_start`, pings) never emit it, so pre-output failures converge on
   * `finish(error)` from the init phase.
   */
  function* ensureFirstByte(): Generator<StreamChunk, void, undefined> {
    if (firstByteEmitted) return
    firstByteEmitted = true
    yield { type: 'first-byte' }
  }

  for await (const event of events) {
    const raw = event.data
    if (raw.trim() === '') continue
    if (raw.trim() === '[DONE]') continue
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw malformed('upstream SSE data is not valid JSON')
    }
    if (!isPlainRecord(payload)) throw malformed('upstream SSE payload is not a JSON object')
    const declaredType = payload.type
    const type = typeof declaredType === 'string' ? declaredType : event.event

    switch (type) {
      case 'message_start': {
        const message = payload.message
        if (isPlainRecord(message)) {
          const id = message.id
          if (validString(id, true)) messageId = id
          applyUsage(usage, readUsage(message.usage))
        }
        applyUsage(usage, readUsage(payload.usage))
        break
      }
      case 'content_block_start': {
        const index = readBlockIndex(payload.index)
        if (index !== nextIndex) {
          throw malformed(
            `content block index ${index} arrived out of order (expected ${nextIndex})`,
          )
        }
        const rawBlock = payload.content_block
        if (!isPlainRecord(rawBlock))
          throw malformed('content_block_start is missing its content block')
        const wireType = rawBlock.type
        if (wireType === 'text') {
          const initialText = rawBlock.text
          const text =
            typeof initialText === 'string'
              ? readDeltaString(initialText, 'content_block.text')
              : ''
          const block: DecodeBlock = {
            index,
            kind: 'text',
            text: '',
            signature: '',
            redacted: '',
            toolCallId: '',
            toolName: '',
            inputJson: '',
            closed: false,
          }
          blocks.set(index, block)
          nextIndex += 1
          yield* ensureFirstByte()
          yield { type: 'block-start', index, blockType: 'text' }
          if (text.length > 0) {
            block.text = text
            yield { type: 'text-delta', index, delta: text }
          }
          break
        }
        if (wireType === 'thinking') {
          const initialThinking = rawBlock.thinking
          const text =
            typeof initialThinking === 'string'
              ? readDeltaString(initialThinking, 'content_block.thinking')
              : ''
          const block: DecodeBlock = {
            index,
            kind: 'reasoning',
            text: '',
            signature: '',
            redacted: '',
            toolCallId: '',
            toolName: '',
            inputJson: '',
            closed: false,
          }
          blocks.set(index, block)
          nextIndex += 1
          yield* ensureFirstByte()
          yield { type: 'block-start', index, blockType: 'reasoning' }
          if (text.length > 0) {
            block.text = text
            yield { type: 'reasoning-delta', index, delta: text }
          }
          break
        }
        if (wireType === 'redacted_thinking') {
          const data = readDeltaString(rawBlock.data, 'content_block.data')
          if (data.length === 0) throw malformed('redacted_thinking block carries no data')
          const block: DecodeBlock = {
            index,
            kind: 'reasoning',
            text: '',
            signature: '',
            redacted: data,
            toolCallId: '',
            toolName: '',
            inputJson: '',
            closed: false,
          }
          blocks.set(index, block)
          nextIndex += 1
          yield* ensureFirstByte()
          yield { type: 'block-start', index, blockType: 'reasoning' }
          break
        }
        if (wireType === 'tool_use') {
          const id = rawBlock.id
          const name = rawBlock.name
          if (!validString(id, true) || !validString(name, true)) {
            throw malformed('tool_use block is missing a usable id or name')
          }
          const input = rawBlock.input
          const initialInput =
            isPlainRecord(input) && Object.keys(input).length > 0
              ? (JSON.stringify(input) ?? '')
              : ''
          const block: DecodeBlock = {
            index,
            kind: 'tool-call',
            text: '',
            signature: '',
            redacted: '',
            toolCallId: id,
            toolName: name,
            inputJson: initialInput,
            closed: false,
          }
          blocks.set(index, block)
          nextIndex += 1
          yield* ensureFirstByte()
          yield {
            type: 'block-start',
            index,
            blockType: 'tool-call',
            toolCallId: id as ToolCallId,
            toolName: name,
          }
          break
        }
        throw malformed(
          `unsupported content block type ${validString(wireType, true) ? wireType : typeof wireType}`,
        )
      }
      case 'content_block_delta': {
        const index = readBlockIndex(payload.index)
        const block = blocks.get(index)
        if (block === undefined) throw malformed(`delta references unknown content block ${index}`)
        if (block.closed) throw malformed(`delta references already closed content block ${index}`)
        const delta = payload.delta
        if (!isPlainRecord(delta)) throw malformed('content_block_delta is missing its delta')
        const deltaType = delta.type
        if (deltaType === 'text_delta') {
          if (block.kind !== 'text') throw malformed(`text_delta arrived for a ${block.kind} block`)
          const text = readDeltaString(delta.text, 'delta.text')
          if (text.length > 0) {
            block.text += text
            yield { type: 'text-delta', index, delta: text }
          }
        } else if (deltaType === 'thinking_delta') {
          if (block.kind !== 'reasoning')
            throw malformed(`thinking_delta arrived for a ${block.kind} block`)
          const text = readDeltaString(delta.thinking, 'delta.thinking')
          if (text.length > 0) {
            block.text += text
            yield { type: 'reasoning-delta', index, delta: text }
          }
        } else if (deltaType === 'signature_delta') {
          if (block.kind !== 'reasoning')
            throw malformed(`signature_delta arrived for a ${block.kind} block`)
          block.signature += readDeltaString(delta.signature, 'delta.signature')
        } else if (deltaType === 'input_json_delta') {
          if (block.kind !== 'tool-call')
            throw malformed(`input_json_delta arrived for a ${block.kind} block`)
          const partial = readDeltaString(delta.partial_json, 'delta.partial_json')
          if (partial.length > 0) {
            block.inputJson += partial
            yield { type: 'tool-call-delta', index, delta: partial }
          }
        }
        // Unknown delta types (citations, future additions) are forward-compatible.
        break
      }
      case 'content_block_stop': {
        const index = readBlockIndex(payload.index)
        const block = blocks.get(index)
        if (block === undefined)
          throw malformed(`content_block_stop references unknown content block ${index}`)
        if (block.closed) throw malformed(`content_block_stop repeated for content block ${index}`)
        block.closed = true
        if (block.kind === 'text') {
          const neutral: TextBlock = { type: 'text', text: block.text }
          replayMetas[index] = { kind: 'text' }
          yield { type: 'block-end', index, block: neutral }
          break
        }
        if (block.kind === 'reasoning') {
          const neutral: ReasoningBlock = { type: 'reasoning', text: block.text }
          replayMetas[index] =
            block.redacted.length > 0
              ? { kind: 'redacted_thinking', data: block.redacted }
              : { kind: 'thinking', signature: block.signature }
          yield { type: 'block-end', index, block: neutral }
          break
        }
        const argumentsJson = block.inputJson.length > 0 ? block.inputJson : '{}'
        // Completed-call JSON validity is checked after the terminal reason is
        // known; a max-tokens truncation legitimately leaves partial arguments.
        const neutral: ToolCallBlock = {
          type: 'tool-call',
          id: block.toolCallId as ToolCallId,
          name: block.toolName,
          argumentsJson,
        }
        replayMetas[index] = { kind: 'tool_use', id: block.toolCallId, name: block.toolName }
        yield { type: 'block-end', index, block: neutral }
        break
      }
      case 'message_delta': {
        const delta = payload.delta
        if (isPlainRecord(delta)) {
          const reason = delta.stop_reason
          if (validString(reason, true)) stopReason = reason
          else if (reason === null) stopReason = undefined
        }
        applyUsage(usage, readUsage(payload.usage))
        break
      }
      case 'message_stop':
        sawMessageStop = true
        break
      case 'ping':
        break
      case 'error':
        throw mapProviderError(payload.error ?? payload)
      default:
        // Unknown event kinds are ignored so additive provider events stay harmless.
        break
    }
    if (sawMessageStop) break
  }

  if (!sawMessageStop) throw failure('TRANSPORT', 'upstream stream ended before message_stop')
  for (const block of blocks.values()) {
    if (!block.closed) throw malformed(`content block ${block.index} was never closed`)
  }
  if (stopReason === 'refusal') {
    throw failure('CONTENT_BLOCKED', 'upstream refused to complete the request')
  }
  if (stopReason === 'model_context_window_exceeded') {
    throw failure('CONTEXT_WINDOW_EXCEEDED', 'upstream reported the context window was exceeded')
  }
  if (nextIndex === 0) {
    throw failure('EMPTY_RESPONSE', 'upstream completed without producing any content block')
  }
  const hasToolBlock = [...blocks.values()].some((block) => block.kind === 'tool-call')
  const reason = stopReasonToFinish(stopReason, hasToolBlock)
  if (reason.kind !== 'max-tokens') {
    for (const block of blocks.values()) {
      if (block.kind !== 'tool-call') continue
      const argumentsJson = block.inputJson.length > 0 ? block.inputJson : '{}'
      assertCompleteToolArguments(argumentsJson, block.toolName)
    }
  }
  if (usage.seen) {
    yield {
      type: 'usage',
      usage: {
        inputUncachedTokens: usage.inputUncached,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
        reasoningTokens: usage.reasoning,
        authoritativeCostUsd: usage.cost,
      },
    }
  }
  const metas: ReplayBlockMeta[] = []
  for (let index = 0; index < nextIndex; index += 1) {
    const meta = replayMetas[index]
    if (meta === undefined)
      throw new InvariantError('anthropic decoder lost replay metadata for a closed block')
    metas.push(meta)
  }
  yield {
    type: 'finish',
    reason,
    replayState: some(replayEnvelopeFor(messageId, stopReason, metas)),
    observedAttempts: 1,
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Engine                                    */
/* -------------------------------------------------------------------------- */

/** Pure-fetch Anthropic Messages engine (`/v1/messages`). */
export const anthropicEngine: DirectWireEngine = {
  build: buildAnthropicRequest,
  decode: (events) => decodeAnthropicStream(events),
}
