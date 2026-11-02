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

/** Where {@link applyOmpCacheAnchors} is allowed to place breakpoints. */
export interface OmpCacheAnchors {
  readonly enabled: boolean
  readonly longRetention: boolean
  readonly supportsLongTtl: boolean
  readonly systemAnchor: boolean
  readonly historyAnchor: {
    readonly messageIndex: number
    readonly blockIndex: number
  } | null
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

function appendVolatileTail(messages: PiAiMessage[], text: string, timestamp: number): void {
  if (text.length === 0) return
  const wrapped = `<turn-context>\n${text}\n</turn-context>`
  const last = messages.at(-1)
  if (last?.role === 'user') {
    const content = typeof last.content === 'string' ? [textBlock(last.content)] : [...last.content]
    content.push(textBlock(`\n\n${wrapped}`))
    last.content = content
    return
  }
  messages.push({
    role: 'user',
    content: [textBlock(wrapped)],
    timestamp,
  })
}

function contentBlockCount(message: PiAiMessage): number {
  if (typeof message.content === 'string') {
    return message.content.trim().length > 0 ? 1 : 0
  }
  return message.content.length
}

/**
 * Maps the final warm-history message onto the Anthropic payload index.
 *
 * pi-ai projects user/assistant turns one-to-one (skipping completely empty
 * ones) and merges every consecutive `toolResult` run into a single `user`
 * message. The warm-end breakpoint therefore has to address the projected
 * payload, not the `Context.messages` index.
 */
function historyAnchorFor(
  messages: readonly PiAiMessage[],
  segment2Count: number,
): OmpCacheAnchors['historyAnchor'] {
  let projected = 0
  let last: { messageIndex: number; blockCount: number } | undefined
  for (let index = 0; index < segment2Count; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'toolResult') {
      let blockCount = 0
      while (index < segment2Count) {
        const grouped = messages[index]
        if (grouped?.role !== 'toolResult') break
        blockCount += contentBlockCount(grouped)
        index += 1
      }
      index -= 1
      projected += 1
      last = { messageIndex: projected - 1, blockCount }
      continue
    }
    const blockCount = contentBlockCount(message)
    if (blockCount === 0) continue
    projected += 1
    last = { messageIndex: projected - 1, blockCount }
  }
  return last === undefined
    ? null
    : Object.freeze({
        messageIndex: last.messageIndex,
        blockIndex: last.blockCount - 1,
      })
}

/**
 * Converts the frozen snapshot into pi-ai's `Context` and cache anchors.
 *
 * `segment1Static` becomes the leading system prompt. `segment2WarmHistory`
 * becomes the message array, and `segment3VolatileTail` is appended as a
 * `<turn-context>` user block — never as a cache-breakpoint target.
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
  const segment2Count = messages.length
  const historyAnchor = historyAnchorFor(messages, segment2Count)
  if (isSome(request.segment3VolatileTail)) {
    appendVolatileTail(messages, request.segment3VolatileTail.value, now)
  }
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
    historyAnchor,
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
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    // Provider payload blocks are fresh mutable objects built by pi-ai for this
    // request; removing a field is the documented cache-control override.
    const block = value as Record<string, unknown>
    delete block.cache_control
  }
}

function setCacheControl(value: unknown, control: Record<string, unknown>): void {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const block = value as Record<string, unknown>
    block.cache_control = control
  }
}

/**
 * Enforces the two-breakpoint policy on a final Anthropic request payload:
 * the last stable system block and the last content block of the last warm
 * history message. Tool breakpoints and any tail breakpoint are removed.
 */
export function applyOmpCacheAnchors(payload: unknown, anchors: OmpCacheAnchors): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const record = payload as Record<string, unknown>
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
      if (typeof message !== 'object' || message === null) continue
      const content = (message as Record<string, unknown>).content
      if (!Array.isArray(content)) continue
      for (const block of content) deleteCacheControl(block)
    }
  }
  if (!anchors.enabled) return payload
  const control = cacheControl(anchors)
  if (anchors.systemAnchor && Array.isArray(system) && system.length > 0) {
    setCacheControl(system[system.length - 1], control)
  }
  const anchor = anchors.historyAnchor
  if (anchor !== null && Array.isArray(messages)) {
    const message = messages[anchor.messageIndex]
    if (typeof message === 'object' && message !== null) {
      const content = (message as Record<string, unknown>).content
      if (Array.isArray(content) && content.length > anchor.blockIndex) {
        setCacheControl(content[anchor.blockIndex], control)
      }
    }
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
