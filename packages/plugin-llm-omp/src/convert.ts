/**
 * Neutral request → pi-ai `Context` / `SimpleStreamOptions` conversion,
 * including cache-breakpoint anchoring and same-origin replay.
 */

import { isSome } from '@sekaisen/core'
import type {
  NeutralAssistantMessage,
  NeutralContentBlock,
  NeutralMessage,
  NeutralToolChoice,
  PreparedChatCallSnapshot,
  RouteId,
} from '@sekaisen/plugin-llm'
import type { OmpRouteConfig } from './config.ts'
import type {
  ApiKey,
  AssistantMessage,
  Effort,
  PiAiContext,
  PiAiMessage,
  PiAiTool,
  PiAiToolCall,
  PiAiToolChoice,
  PiModel,
  SimpleStreamOptions,
  TextContent,
} from './pi-ai.ts'
import type { OmpProbes } from './probes.ts'
import { asRecord } from './record.ts'
import type { OmpDecodedReplay } from './replay.ts'
import { decodeOmpReplayState, replayToolCallMetadata } from './replay.ts'
import { lowerCaseSchemaTypes } from './schema.ts'

/**
 * Where {@link convertOmpContext} left `segment3VolatileTail` inside the
 * `Context.messages` array: nothing to append, merged into the final user
 * turn's content, or appended as its own trailing user message.
 */
type OmpVolatileTailPlacement = 'none' | 'merged' | 'appended'

/**
 * Where {@link applyOmpCacheAnchors} is allowed to place breakpoints.
 *
 * The boundary is metadata, not an index: pi-ai's Anthropic projector drops
 * whitespace-only blocks and empty assistant turns and merges consecutive
 * `toolResult` messages, so the projected payload index is only known once
 * `onPayload` sees the actual wire messages.
 */
export interface OmpCacheAnchors {
  readonly enabled: boolean
  readonly longRetention: boolean
  readonly supportsLongTtl: boolean
  readonly systemAnchor: boolean
  readonly volatileTail: 'none' | 'merged' | 'appended'
  /**
   * Exact text of the volatile block merged into the final user turn. It lets
   * the payload hook split a non-vision string projection at the known
   * boundary instead of guessing at markup inside it. Null unless merged.
   */
  readonly volatileTailText: string | null
  /**
   * True when pi-ai appends its synthetic `Continue.` user turn after the
   * projected history, resolved from the messages that actually survive
   * projection. The payload never identifies that pad by its text.
   */
  readonly syntheticPad: boolean
}

interface ConvertInput {
  readonly snapshot: PreparedChatCallSnapshot
  readonly model: PiModel
  readonly route: OmpRouteConfig
  readonly apiKey: ApiKey
  readonly probes: OmpProbes
  readonly signal: AbortSignal
  readonly sessionId: string | undefined
}

interface LongCacheCompat {
  readonly supportsLongCacheRetention?: boolean
}

function zeroUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // A historical tool call with malformed arguments is replayed as an empty
    // object; the tool result pairing (id/name) is preserved.
  }
  return {}
}

function textBlock(text: string): TextContent {
  return { type: 'text', text }
}

function convertExtraBlock(value: unknown): AssistantMessage['content'][number] | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  switch (record.type) {
    case 'text':
    case 'thinking':
    case 'redactedThinking':
    case 'image':
    case 'fallback':
    case 'anthropicServerTool':
    case 'toolCall':
      // The value came from a previous AssistantMessage produced by the same
      // SDK; the discriminant is the only runtime narrowing available.
      return record as unknown as AssistantMessage['content'][number]
    default:
      return undefined
  }
}

function convertNeutralBlock(
  block: NeutralContentBlock,
  replayBlock: OmpDecodedReplay['blocks'][number] | undefined,
): AssistantMessage['content'][number] {
  switch (block.type) {
    case 'text':
      return replayBlock?.textSignature === undefined
        ? textBlock(block.text)
        : { type: 'text', text: block.text, textSignature: replayBlock.textSignature }
    case 'reasoning':
      if (replayBlock?.redacted !== undefined) {
        return { type: 'redactedThinking', data: replayBlock.redacted }
      }
      return {
        type: 'thinking',
        thinking: block.text,
        ...(replayBlock?.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: replayBlock.thinkingSignature }),
        ...(replayBlock?.itemId === undefined ? {} : { itemId: replayBlock.itemId }),
        ...(replayBlock?.summary === undefined ? {} : { summary: replayBlock.summary }),
      }
    case 'tool-call': {
      const toolCall: PiAiToolCall = {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.argumentsJson),
        ...replayToolCallMetadata(replayBlock),
      }
      return toolCall
    }
  }
}

function assistantMessage(
  message: NeutralAssistantMessage,
  model: PiModel,
  decoded: OmpDecodedReplay | undefined,
  timestamp: number,
): AssistantMessage {
  const content: AssistantMessage['content'] = []
  const appendExtras = (index: number): void => {
    const extras = decoded?.extrasByIndex.get(index)
    if (extras === undefined) return
    for (const value of extras) {
      const block = convertExtraBlock(value)
      if (block !== undefined) content.push(block)
    }
  }
  for (let index = 0; index < message.content.length; index += 1) {
    appendExtras(index)
    const block = message.content[index]
    if (block === undefined) continue
    content.push(convertNeutralBlock(block, decoded?.byBlockIndex.get(index)))
  }
  appendExtras(message.content.length)
  const hasToolCall = message.content.some((block) => block.type === 'tool-call')
  const response = decoded?.response
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: hasToolCall ? 'toolUse' : 'stop',
    timestamp,
    ...(response?.responseId === undefined ? {} : { responseId: response.responseId }),
    ...(response?.providerPayload === undefined
      ? {}
      : {
          providerPayload: response.providerPayload as NonNullable<
            AssistantMessage['providerPayload']
          >,
        }),
    ...(response?.requestControls === undefined
      ? {}
      : {
          requestControls: response.requestControls as NonNullable<
            AssistantMessage['requestControls']
          >,
        }),
  }
}

function convertMessage(
  message: NeutralMessage,
  model: PiModel,
  routeId: RouteId,
  timestamp: number,
): PiAiMessage {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        content: message.content.map((block) => textBlock(block.text)),
        timestamp,
      }
    case 'tool-result':
      return {
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [textBlock(message.content)],
        isError: message.isError,
        timestamp,
      }
    case 'assistant': {
      const sameOrigin = message.origin.routeId === routeId && message.origin.modelId === model.id
      return assistantMessage(
        message,
        model,
        sameOrigin
          ? decodeOmpReplayState(
              message.origin.replayState,
              model.provider,
              model.id,
              message.content.length,
            )
          : undefined,
        timestamp,
      )
    }
  }
}

interface VolatileTailProjection {
  readonly placement: OmpVolatileTailPlacement
  readonly text: string | null
}

function appendVolatileTail(
  messages: PiAiMessage[],
  text: string,
  timestamp: number,
): VolatileTailProjection {
  if (text.length === 0) return { placement: 'none', text: null }
  const wrapped = `<turn-context>\n${text}\n</turn-context>`
  const last = messages.at(-1)
  if (last?.role === 'user') {
    const block = `\n\n${wrapped}`
    const content = typeof last.content === 'string' ? [textBlock(last.content)] : [...last.content]
    content.push(textBlock(block))
    last.content = content
    return { placement: 'merged', text: block }
  }
  messages.push({
    role: 'user',
    content: [textBlock(wrapped)],
    timestamp,
  })
  return { placement: 'appended', text: null }
}

/**
 * True when pi-ai's Anthropic projector is certain to drop this block.
 * Deliberately conservative: anything that might survive is reported as
 * surviving, so a wrong guess only skips a warm message, never the reverse.
 */
function dropsAssistantBlock(block: AssistantMessage['content'][number]): boolean {
  switch (block.type) {
    case 'text':
      return block.text.trim().length === 0
    case 'thinking':
      return (
        block.thinking.trim().length === 0 &&
        (block.thinkingSignature === undefined || block.thinkingSignature.trim().length === 0)
      )
    case 'redactedThinking':
      return block.data.trim().length === 0
    case 'image':
      // The assistant projection has no image case, so the block never reaches
      // the wire.
      return true
    default:
      return false
  }
}

/** True when the projector is certain to emit no wire message for this turn. */
function projectsToNothing(message: PiAiMessage): boolean {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content.trim().length === 0
    return message.content.every((block) => block.type === 'text' && block.text.trim().length === 0)
  }
  if (message.role !== 'assistant') return false
  return message.content.every(dropsAssistantBlock)
}

/**
 * Role of the last warm turn that survives projection. pi-ai appends its
 * neutral `Continue.` pad exactly when that role is `assistant`.
 */
function lastProjectedRole(messages: readonly PiAiMessage[]): PiAiMessage['role'] | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || projectsToNothing(message)) continue
    return message.role
  }
  return null
}

/**
 * Converts the frozen snapshot into pi-ai's `Context` and cache anchors.
 *
 * `segment1Static` becomes the leading system prompt. `segment2WarmHistory`
 * becomes the message array, and `segment3VolatileTail` is appended as a
 * `<turn-context>` user block — its placement is reported to the payload hook
 * so the warm-end breakpoint can be resolved on the projected wire messages.
 */
export function convertOmpContext(
  snapshot: PreparedChatCallSnapshot,
  model: PiModel,
  now: number = Date.now(),
): { context: PiAiContext; anchors: OmpCacheAnchors } {
  const request = snapshot.request
  const systemPrompt = request.segment1Static.map((segment) => segment.text)
  const messages: PiAiMessage[] = []
  for (const message of request.segment2WarmHistory) {
    messages.push(convertMessage(message, model, snapshot.routeId, now))
  }
  const volatileTail = isSome(request.segment3VolatileTail)
    ? appendVolatileTail(messages, request.segment3VolatileTail.value, now)
    : { placement: 'none' as const, text: null }
  const tools = convertTools(snapshot, model)
  const compat = (model.compat ?? {}) as LongCacheCompat
  const cacheRetention = snapshot.sampling.cacheRetention
  // The final warm-history message owns the mandatory warm-end breakpoint and
  // its hint selects the TTL; earlier hint positions are never anchor targets.
  const warmTail = request.segment2WarmHistory.at(-1)
  const longRetention =
    cacheRetention === 'long' || (cacheRetention !== 'none' && warmTail?.cacheBreakpoint === 'long')
  const anchors: OmpCacheAnchors = Object.freeze({
    enabled: cacheRetention !== 'none',
    longRetention,
    supportsLongTtl: compat.supportsLongCacheRetention === true,
    systemAnchor: systemPrompt.length > 0,
    volatileTail: volatileTail.placement,
    volatileTailText: volatileTail.text,
    // A tail projects a trailing user turn, so the projector appends no pad.
    syntheticPad: volatileTail.placement === 'none' && lastProjectedRole(messages) === 'assistant',
  })
  return {
    context: {
      ...(systemPrompt.length === 0 ? {} : { systemPrompt }),
      messages,
      ...(tools === undefined ? {} : { tools }),
    },
    anchors,
  }
}

function mapToolChoice(choice: NeutralToolChoice): PiAiToolChoice {
  switch (choice.kind) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'named':
      return { type: 'function', name: choice.toolName }
  }
}

const GOOGLE_APIS: Readonly<Record<string, true>> = Object.freeze({
  'google-generative-ai': true,
  'google-vertex': true,
  'google-gemini-cli': true,
})

function convertTools(snapshot: PreparedChatCallSnapshot, model: PiModel): PiAiTool[] | undefined {
  if (snapshot.tools.length === 0) return undefined
  const google = Object.hasOwn(GOOGLE_APIS, model.api)
  return snapshot.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // The neutral Gemini/CCA dialects emit uppercase `Schema.type`. pi-ai
    // normalizes Google wire schemas itself from lowercase JSON Schema.
    parameters: google ? lowerCaseSchemaTypes(tool.jsonSchema) : { ...tool.jsonSchema },
    strict: tool.strict,
  }))
}

function cacheControl(anchors: OmpCacheAnchors): Record<string, unknown> {
  return {
    type: 'ephemeral',
    ...(anchors.longRetention && anchors.supportsLongTtl ? { ttl: '1h' } : {}),
  }
}

function deleteCacheControl(value: unknown): void {
  const block = asRecord(value)
  if (block === undefined) return
  // Provider payload blocks are fresh mutable objects built by pi-ai for this
  // request; removing a field is the documented cache-control override.
  delete block.cache_control
}

/**
 * Blocks Anthropic refuses to decorate with `cache_control`: generated
 * reasoning, fallback boundaries, and mid-conversation tool-control markers.
 */
const UNCACHEABLE_BLOCK_TYPES: Readonly<Record<string, true>> = Object.freeze({
  thinking: true,
  redacted_thinking: true,
  fallback: true,
  tool_addition: true,
  tool_removal: true,
})

interface WarmBoundary {
  /** Index of the payload message that ends the warm history. */
  readonly messageIndex: number
  /** Trailing blocks of that message that belong to the volatile tail. */
  readonly tailBlocks: number
}

/**
 * Splits a non-vision string projection at the exact merged-tail boundary.
 *
 * pi-ai first joins text blocks with `\n`, then its prompt-caching pass may
 * replace the string content with a single text block before `onPayload` sees
 * it. The known tail block is therefore the exact suffix `"\n" +
 * volatileTailText` of either the message string or its final text block.
 * Slicing from the end cannot confuse identical markup that already existed
 * inside the warm history. A vision projection already ends with a separate
 * tail block, whose text equals `volatileTailText` and never matches the
 * longer suffix, so it is left untouched.
 */
function splitMergedTail(messages: readonly unknown[], tailText: string): void {
  const last = asRecord(messages[messages.length - 1])
  if (last?.role !== 'user') return
  const suffix = `\n${tailText}`
  const splitWarm = (text: string): string | null => {
    if (!text.endsWith(suffix)) return null
    const warm = text.slice(0, text.length - suffix.length)
    return warm.trim().length === 0 ? null : warm
  }
  if (typeof last.content === 'string') {
    const warm = splitWarm(last.content)
    if (warm === null) return
    last.content = [
      { type: 'text', text: warm },
      { type: 'text', text: tailText },
    ]
    return
  }
  if (!Array.isArray(last.content)) return
  const tailIndex = last.content.length - 1
  const tailBlock = asRecord(last.content[tailIndex])
  if (tailBlock?.type !== 'text' || typeof tailBlock.text !== 'string') return
  const warm = splitWarm(tailBlock.text)
  if (warm === null) return
  last.content = [
    ...last.content.slice(0, tailIndex),
    { type: 'text', text: warm },
    { type: 'text', text: tailText },
  ]
}

/**
 * Serializes every warm message-level string as a text block so the same turn
 * keeps identical bytes when it later becomes interior history. The synthetic
 * pad is skipped: it is never a breakpoint target and disappears next request.
 */
function normalizeMessageStrings(messages: readonly unknown[], skipLast: boolean): void {
  const skip = skipLast ? messages.length - 1 : -1
  for (let index = 0; index < messages.length; index += 1) {
    if (index === skip) continue
    const message = asRecord(messages[index])
    if (message === undefined || typeof message.content !== 'string') continue
    message.content = [{ type: 'text', text: message.content }]
  }
}

/**
 * Resolves the projected wire message that ends `segment2WarmHistory`.
 *
 * The Anthropic projector drops whitespace-only text blocks and empty
 * assistant turns, merges a consecutive `toolResult` run into one `user`
 * message, and appends a neutral `Continue.` pad after a trailing assistant.
 * The boundary is read from the actual payload plus conversion-time metadata
 * (tail placement and pad expectation), never from message text.
 */
function warmBoundary(messages: readonly unknown[], anchors: OmpCacheAnchors): WarmBoundary | null {
  const lastIndex = messages.length - 1
  if (lastIndex < 0) return null
  const last = asRecord(messages[lastIndex])
  switch (anchors.volatileTail) {
    case 'appended':
      // The tail is its own trailing user message when it cannot merge.
      if (last?.role !== 'user' || lastIndex === 0) return null
      return { messageIndex: lastIndex - 1, tailBlocks: 0 }
    case 'merged':
      // The tail is the last block of the final user turn. Only the split of a
      // non-vision string leaves it non-array; never mark that message then.
      if (last?.role !== 'user') return null
      if (!Array.isArray(last.content)) {
        return lastIndex === 0 ? null : { messageIndex: lastIndex - 1, tailBlocks: 0 }
      }
      return { messageIndex: lastIndex, tailBlocks: 1 }
    case 'none':
      // The pad is present exactly when a trailing assistant survived
      // projection; a genuine final user that happens to read `Continue.`
      // stays warm because it is never identified by text.
      if (anchors.syntheticPad && last?.role === 'user' && lastIndex > 0) {
        return { messageIndex: lastIndex - 1, tailBlocks: 0 }
      }
      return { messageIndex: lastIndex, tailBlocks: 0 }
  }
}

/**
 * Decorates the last cacheable block of one payload message. Returns false when
 * the message carries no block Anthropic accepts a breakpoint on, so the caller
 * can walk further back through stable history.
 */
function decorateMessage(
  message: Record<string, unknown>,
  control: Record<string, unknown>,
  tailBlocks: number,
): boolean {
  const content = message.content
  if (typeof content === 'string') {
    if (tailBlocks > 0 || content.trim().length === 0) return false
    message.content = [{ type: 'text', text: content, cache_control: control }]
    return true
  }
  if (!Array.isArray(content)) return false
  for (let index = content.length - 1 - tailBlocks; index >= 0; index -= 1) {
    const block = content[index]
    const record = asRecord(block)
    if (record === undefined) continue
    const type = record.type
    if (typeof type === 'string' && Object.hasOwn(UNCACHEABLE_BLOCK_TYPES, type)) continue
    content[index] = { ...record, cache_control: control }
    return true
  }
  return false
}

/**
 * Enforces the two-breakpoint policy on a final Anthropic request payload: the
 * last static system block and the last cacheable warm-history block. Every
 * other breakpoint — including any on the volatile tail or on pi-ai's own
 * projected pages — is removed.
 *
 * A merged tail that the projector flattened into one string is split back at
 * its exact known boundary, and every warm message-level string is rewritten
 * as a text block so the same turn keeps identical bytes once it becomes
 * interior history.
 */
export function applyOmpCacheAnchors(payload: unknown, anchors: OmpCacheAnchors): unknown {
  const record = asRecord(payload)
  if (record === undefined) return payload
  const system = record.system
  if (Array.isArray(system)) {
    for (const block of system) deleteCacheControl(block)
  }
  const tools = record.tools
  if (Array.isArray(tools)) {
    for (const tool of tools) deleteCacheControl(tool)
  }
  const messages = record.messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = asRecord(message)?.content
      if (!Array.isArray(content)) continue
      for (const block of content) deleteCacheControl(block)
    }
  }
  if (!anchors.enabled) return payload
  const mergedTail = anchors.volatileTail === 'merged' ? anchors.volatileTailText : null
  if (Array.isArray(messages)) {
    if (mergedTail !== null) splitMergedTail(messages, mergedTail)
    normalizeMessageStrings(messages, anchors.syntheticPad)
  }
  const control = cacheControl(anchors)
  if (anchors.systemAnchor && Array.isArray(system) && system.length > 0) {
    const anchor = asRecord(system[system.length - 1])
    if (anchor !== undefined) anchor.cache_control = control
  }
  if (!Array.isArray(messages)) return payload
  const boundary = warmBoundary(messages, anchors)
  if (boundary === null) return payload
  for (let index = boundary.messageIndex; index >= 0; index -= 1) {
    const message = asRecord(messages[index])
    if (message === undefined) continue
    const tailBlocks = index === boundary.messageIndex ? boundary.tailBlocks : 0
    if (decorateMessage(message, control, tailBlocks)) break
  }
  return payload
}

function samplingEnabled(snapshot: PreparedChatCallSnapshot): boolean {
  if (!snapshot.capabilities.supportsSamplingParams) return false
  return snapshot.effectiveEffort === 'off' || snapshot.capabilities.supportsSamplingWhenThinking
}

function copyHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  return { ...headers }
}

/**
 * Builds the pi-ai stream options while keeping transport-level stripping
 * (Codex sampling/output caps, unsupported parameters) independent of the
 * service's static preparation.
 */
export function convertOmpOptions(input: ConvertInput): SimpleStreamOptions {
  const { snapshot, model, route, apiKey, probes, signal, sessionId } = input
  const sampling = snapshot.sampling
  const samplingSupported = samplingEnabled(snapshot)
  const penaltiesSupported = samplingSupported && snapshot.capabilities.supportsPenaltiesAndStop
  const isCodex = model.api === 'openai-codex-responses'
  const affinity = isSome(sampling.sessionAffinityKey)
    ? sampling.sessionAffinityKey.value
    : sessionId
  const toolChoice =
    snapshot.tools.length === 0 ? undefined : mapToolChoice(snapshot.effectiveToolChoice)
  const headers = copyHeaders(route.headers)
  const reasoning = snapshot.effectiveEffort === 'off' ? undefined : snapshot.effectiveEffort

  return {
    apiKey,
    signal,
    ...(reasoning === undefined
      ? { disableReasoning: true }
      : { reasoning: reasoning as unknown as Effort }),
    ...(samplingSupported && isSome(sampling.temperature)
      ? { temperature: sampling.temperature.value }
      : {}),
    ...(samplingSupported && isSome(sampling.topP) ? { topP: sampling.topP.value } : {}),
    ...(penaltiesSupported && isSome(sampling.frequencyPenalty)
      ? { frequencyPenalty: sampling.frequencyPenalty.value }
      : {}),
    ...(penaltiesSupported && isSome(sampling.presencePenalty)
      ? { presencePenalty: sampling.presencePenalty.value }
      : {}),
    ...(penaltiesSupported && sampling.stopSequences.length > 0
      ? { stopSequences: [...sampling.stopSequences] }
      : {}),
    ...(isSome(sampling.maxOutputTokens) && !isCodex
      ? { maxTokens: sampling.maxOutputTokens.value }
      : {}),
    cacheRetention: sampling.cacheRetention,
    ...(affinity === undefined ? {} : { sessionId: affinity, promptCacheKey: affinity }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(headers === undefined ? {} : { headers }),
    ...(route.firstEventTimeoutMs === undefined
      ? {}
      : { streamFirstEventTimeoutMs: route.firstEventTimeoutMs }),
    ...(route.interEventTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: route.interEventTimeoutMs }),
    statefulResponses: false,
    codexSseMaxAttempts: 1,
    preferWebsockets: route.preferWebsockets ?? false,
    acceptEmptyResponse: false,
    fetch: probes.fetch,
    onResponse: probes.onResponse,
    onSseEvent: probes.onSseEvent,
  }
}

/** Attaches the route's cache anchoring hook for Anthropic Messages requests. */
export function attachCacheAnchoring(
  options: SimpleStreamOptions,
  anchors: OmpCacheAnchors,
  model: PiModel,
): SimpleStreamOptions {
  if (model.api !== 'anthropic-messages') return options
  return {
    ...options,
    onPayload: (payload) => applyOmpCacheAnchors(payload, anchors),
  }
}
