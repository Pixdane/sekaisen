/**
 * Google Gemini wire engine (`/v1beta/models/{model}:streamGenerateContent`).
 *
 * The stable system prefix is lifted into `systemInstruction`; only history and
 * the volatile tail ever appear in `contents`, so the cacheable prefix stays
 * byte-stable across turns. Consecutive tool results collapse into a single
 * `user` turn whose `parts` preserve the original call order, and block-level
 * `thoughtSignature` values are replayed only for the same route and model.
 */

import type { Option } from '@sekaisen/core'
import { isSome, NONE, some } from '@sekaisen/core'
import type { PreparedChatCallSnapshot } from '../service-types.ts'
import type {
  DisjointTokenUsage,
  FinishReason,
  LlmFailure,
  NeutralAssistantMessage,
  ReplayEnvelope,
  StreamChunk,
  ToolCallId,
} from '../types.ts'
import { failure, isPlainRecord } from '../utils.ts'
import type { DirectRouteConfig, DirectWireEngine, SseEvent, WireRequest } from './contract.ts'

/** Replay envelope kind for the direct Gemini engine (`'direct:' + protocol`). */
export const GEMINI_REPLAY_ADAPTER_KIND = 'direct:google-gemini'

const ADAPTER_KIND = GEMINI_REPLAY_ADAPTER_KIND
const REPLAY_VERSION = 1

/** Well-formed UTF-16 increment helper (see the Responses engine for rationale). */
class Utf16Carry {
  pending = ''

  push(chunk: string): string {
    if (chunk.length === 0) return ''
    const combined = this.pending + chunk
    this.pending = ''
    let end = combined.length
    const last = combined.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      this.pending = combined.slice(end - 1)
      end -= 1
    }
    const output = combined.slice(0, end)
    return output.isWellFormed() ? output : output.toWellFormed()
  }

  flush(): string {
    const output = this.pending.toWellFormed()
    this.pending = ''
    return output
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    throw failure('INVALID_REQUEST', `${label} must be well-formed Unicode text`)
  }
  return value
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() ? value : undefined
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  const truncated = Math.trunc(value)
  return Number.isSafeInteger(truncated) ? truncated : Number.MAX_SAFE_INTEGER
}

function parseUsage(raw: unknown): DisjointTokenUsage | undefined {
  if (!isPlainRecord(raw)) return undefined
  const prompt = readCount(raw.promptTokenCount)
  const cacheRead = Math.min(readCount(raw.cachedContentTokenCount), prompt)
  const candidates = readCount(raw.candidatesTokenCount)
  const thoughtsRaw = raw.thoughtsTokenCount
  const thoughts = readCount(thoughtsRaw)
  const total = readCount(raw.totalTokenCount)
  const inputUncachedTokens =
    prompt > 0 ? prompt - cacheRead : Math.max(0, total - candidates - thoughts)
  const reasoningTokens: Option<number> =
    typeof thoughtsRaw === 'number' && Number.isFinite(thoughtsRaw) && thoughtsRaw >= 0
      ? some(thoughts)
      : NONE
  return {
    inputUncachedTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: candidates + thoughts,
    reasoningTokens,
    authoritativeCostUsd: NONE,
  }
}

/* -------------------------------------------------------------------------- */
/*                             Request assembly                              */
/* -------------------------------------------------------------------------- */

function isGemini3(modelId: string): boolean {
  return /gemini-3(?:[.-]|$)/i.test(modelId)
}

function thinkingLevelFor(effort: PreparedChatCallSnapshot['effectiveEffort']): string {
  switch (effort) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    case 'off':
      return 'minimal'
  }
}

function thinkingBudgetFor(effort: PreparedChatCallSnapshot['effectiveEffort']): number {
  switch (effort) {
    case 'off':
      return 0
    case 'minimal':
      return 1024
    case 'low':
      return 2048
    case 'medium':
      return 8192
    case 'high':
      return 16384
    case 'xhigh':
    case 'max':
      return 24576
  }
}

function thinkingConfigFor(
  snapshot: PreparedChatCallSnapshot,
): Record<string, unknown> | undefined {
  if (snapshot.capabilities.supportedEfforts.length === 0) return undefined
  if (isGemini3(snapshot.modelId)) {
    if (snapshot.effectiveEffort === 'off') return undefined
    return { thinkingLevel: thinkingLevelFor(snapshot.effectiveEffort) }
  }
  return { thinkingBudget: thinkingBudgetFor(snapshot.effectiveEffort) }
}

function replayBlocksFor(
  message: NeutralAssistantMessage,
  snapshot: PreparedChatCallSnapshot,
): readonly unknown[] | undefined {
  const state = message.origin.replayState
  if (!isSome(state)) return undefined
  if (message.origin.routeId !== snapshot.routeId || message.origin.modelId !== snapshot.modelId) {
    return undefined
  }
  const envelope = state.value
  if (envelope.adapterKind !== ADAPTER_KIND || envelope.version !== REPLAY_VERSION) return undefined
  const blocks = envelope.blocks
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return undefined
  return blocks
}

function blockMetadata(
  blocks: readonly unknown[] | undefined,
  index: number,
): Record<string, unknown> | undefined {
  if (blocks === undefined) return undefined
  const value = blocks[index]
  return isPlainRecord(value) ? value : undefined
}

function toolChoiceFor(snapshot: PreparedChatCallSnapshot): Record<string, unknown> | undefined {
  const choice = snapshot.effectiveToolChoice
  switch (choice.kind) {
    case 'auto':
      return { functionCallingConfig: { mode: 'AUTO' } }
    case 'none':
      return { functionCallingConfig: { mode: 'NONE' } }
    case 'required':
      return { functionCallingConfig: { mode: 'ANY' } }
    case 'named':
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [requireText(choice.toolName, 'named tool choice')],
        },
      }
  }
}

function toolResultPayload(content: string, isError: boolean): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = undefined
  }
  if (isError) return isPlainRecord(parsed) ? { error: parsed } : { error: content }
  return isPlainRecord(parsed) ? parsed : { output: content }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: Record<string, unknown>[]
}

function assistantParts(
  message: NeutralAssistantMessage,
  snapshot: PreparedChatCallSnapshot,
): Record<string, unknown>[] {
  const replay = replayBlocksFor(message, snapshot)
  const parts: Record<string, unknown>[] = []
  message.content.forEach((block, index) => {
    const signature = readNonEmptyString(blockMetadata(replay, index)?.thoughtSignature)
    if (block.type === 'text') {
      const text = requireText(block.text, 'assistant text')
      if (text.length === 0) return
      const part: Record<string, unknown> = { text }
      if (signature !== undefined) part.thoughtSignature = signature
      parts.push(part)
      return
    }
    if (block.type === 'reasoning') {
      if (signature === undefined) return
      const text = requireText(block.text, 'reasoning text')
      if (text.length === 0) return
      parts.push({ text, thought: true, thoughtSignature: signature })
      return
    }
    const name = requireText(block.name, 'tool name')
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(requireText(block.argumentsJson, 'tool arguments'))
      if (isPlainRecord(parsed)) args = parsed
    } catch {
      throw failure('INVALID_REQUEST', 'tool arguments in history are not valid JSON')
    }
    const part: Record<string, unknown> = { functionCall: { name, args } }
    if (signature !== undefined) part.thoughtSignature = signature
    parts.push(part)
  })
  return parts
}

function build(snapshot: PreparedChatCallSnapshot): WireRequest {
  const contents: GeminiContent[] = []
  let lastWasToolResults = false

  for (const message of snapshot.request.segment2WarmHistory) {
    if (message.role === 'user') {
      lastWasToolResults = false
      if (message.content.length === 0) {
        throw failure('INVALID_REQUEST', 'user message must contain at least one text block')
      }
      contents.push({
        role: 'user',
        parts: message.content.map((block) => ({
          text: requireText(block.text, 'user text'),
        })),
      })
      continue
    }
    if (message.role === 'tool-result') {
      const part = {
        functionResponse: {
          name: requireText(message.toolName, 'tool name'),
          response: toolResultPayload(requireText(message.content, 'tool result'), message.isError),
        },
      }
      const last = contents.at(-1)
      if (lastWasToolResults && last !== undefined && last.role === 'user') {
        last.parts.push(part)
      } else {
        contents.push({ role: 'user', parts: [part] })
        lastWasToolResults = true
      }
      continue
    }
    lastWasToolResults = false
    const parts = assistantParts(message, snapshot)
    if (parts.length > 0) contents.push({ role: 'model', parts })
  }

  const tail = snapshot.request.segment3VolatileTail
  if (isSome(tail) && tail.value.trim().length > 0) {
    const text = `<turn-context>\n${requireText(tail.value, 'volatile tail')}\n</turn-context>`
    const last = contents.at(-1)
    if (last !== undefined && last.role === 'user') last.parts.push({ text })
    else contents.push({ role: 'user', parts: [{ text }] })
  }

  if (contents.length === 0) {
    throw failure('INVALID_REQUEST', 'chat request needs at least one history message')
  }

  const body: Record<string, unknown> = { contents }

  const systemParts = snapshot.request.segment1Static.map((segment) => ({
    text: requireText(segment.text, 'system segment text'),
  }))
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts }

  if (snapshot.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: snapshot.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.jsonSchema,
        })),
      },
    ]
    const toolConfig = toolChoiceFor(snapshot)
    if (toolConfig !== undefined) body.toolConfig = toolConfig
  }

  const generationConfig: Record<string, unknown> = {}
  const sampling = snapshot.sampling
  if (isSome(sampling.temperature) && Number.isFinite(sampling.temperature.value)) {
    generationConfig.temperature = sampling.temperature.value
  }
  if (isSome(sampling.topP) && Number.isFinite(sampling.topP.value)) {
    generationConfig.topP = sampling.topP.value
  }
  if (isSome(sampling.frequencyPenalty) && Number.isFinite(sampling.frequencyPenalty.value)) {
    generationConfig.frequencyPenalty = sampling.frequencyPenalty.value
  }
  if (isSome(sampling.presencePenalty) && Number.isFinite(sampling.presencePenalty.value)) {
    generationConfig.presencePenalty = sampling.presencePenalty.value
  }
  if (isSome(sampling.maxOutputTokens)) {
    generationConfig.maxOutputTokens = readCount(sampling.maxOutputTokens.value)
  }
  if (sampling.stopSequences.length > 0) {
    generationConfig.stopSequences = sampling.stopSequences.map((sequence) =>
      requireText(sequence, 'stop sequence'),
    )
  }
  const thinkingConfig = thinkingConfigFor(snapshot)
  if (thinkingConfig !== undefined) generationConfig.thinkingConfig = thinkingConfig
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig

  return {
    path: `/v1beta/models/${encodeURIComponent(snapshot.modelId)}:streamGenerateContent?alt=sse`,
    body,
  }
}

/* -------------------------------------------------------------------------- */
/*                              Stream decoding                              */
/* -------------------------------------------------------------------------- */

function failureFromPayload(payload: Record<string, unknown>): LlmFailure {
  const rawStatus = payload.code
  const statusValue =
    typeof rawStatus === 'number' &&
    Number.isSafeInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : undefined
  const rawMessage = payload.message
  const message =
    typeof rawMessage === 'string' && rawMessage.isWellFormed() && rawMessage.length > 0
      ? rawMessage
      : 'upstream reported an error response'
  const haystack =
    `${typeof payload.status === 'string' ? payload.status : ''} ${message}`.toLowerCase()
  let mapped: LlmFailure['code']
  if (
    statusValue === 401 ||
    statusValue === 403 ||
    haystack.includes('api key') ||
    haystack.includes('permission') ||
    haystack.includes('unauthenticated') ||
    haystack.includes('permission_denied')
  )
    mapped = 'AUTH'
  else if (
    statusValue === 429 ||
    haystack.includes('rate limit') ||
    haystack.includes('resource_exhausted')
  )
    mapped = 'RATE_LIMIT'
  else if (haystack.includes('quota') || haystack.includes('billing')) mapped = 'QUOTA'
  else if (haystack.includes('context') || haystack.includes('too many tokens'))
    mapped = 'CONTEXT_WINDOW_EXCEEDED'
  else if (
    haystack.includes('safety') ||
    haystack.includes('blocked') ||
    haystack.includes('policy')
  )
    mapped = 'CONTENT_BLOCKED'
  else if (haystack.includes('timeout')) mapped = 'TIMEOUT'
  else if (statusValue !== undefined && statusValue >= 500) mapped = 'SERVER'
  else if (
    statusValue === 400 ||
    statusValue === 413 ||
    statusValue === 422 ||
    haystack.includes('invalid_argument') ||
    haystack.includes('failed_precondition') ||
    haystack.includes('not_found')
  )
    mapped = 'INVALID_REQUEST'
  else if (haystack.includes('unavailable') || haystack.includes('internal')) mapped = 'SERVER'
  else mapped = 'SERVER'
  const status = statusValue === undefined ? NONE : some(statusValue)
  return failure(mapped, message, { status })
}

interface BlockState {
  index: number
  kind: 'text' | 'reasoning'
  text: string
  carry: Utf16Carry
  readonly replay: Record<string, unknown>
}

export const geminiEngine: DirectWireEngine = {
  build,

  async *decode(
    events: AsyncIterable<SseEvent>,
    snapshot: PreparedChatCallSnapshot,
    _config: DirectRouteConfig,
  ): AsyncIterable<StreamChunk> {
    const replayBlocks: Record<string, unknown>[] = []
    let nextIndex = 0
    let firstByteSent = false
    let finished = false
    let usage: DisjointTokenUsage | undefined
    let terminal: 'stop' | 'max-tokens' | undefined
    let toolCalls = 0
    let textBlock: BlockState | null = null
    let reasoningBlock: BlockState | null = null

    function* emitFirstByte(): Generator<StreamChunk> {
      if (firstByteSent) return
      firstByteSent = true
      yield { type: 'first-byte' }
    }

    function* closeBlock(block: BlockState): Generator<StreamChunk> {
      const rest = block.carry.flush()
      if (rest.length > 0) {
        block.text += rest
        yield block.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: block.index, delta: rest }
          : { type: 'text-delta', index: block.index, delta: rest }
      }
      yield {
        type: 'block-end',
        index: block.index,
        block:
          block.kind === 'reasoning'
            ? { type: 'reasoning', text: block.text }
            : { type: 'text', text: block.text },
      }
    }

    function* closeOpenBlocks(): Generator<StreamChunk> {
      if (textBlock !== null) {
        const block = textBlock
        textBlock = null
        yield* closeBlock(block)
      }
      if (reasoningBlock !== null) {
        const block = reasoningBlock
        reasoningBlock = null
        yield* closeBlock(block)
      }
    }

    function* ensureBlock(kind: 'text' | 'reasoning'): Generator<StreamChunk, BlockState> {
      if (kind === 'text' && reasoningBlock !== null) {
        const block = reasoningBlock
        reasoningBlock = null
        yield* closeBlock(block)
      }
      if (kind === 'reasoning' && textBlock !== null) {
        const block = textBlock
        textBlock = null
        yield* closeBlock(block)
      }
      const existing = kind === 'text' ? textBlock : reasoningBlock
      if (existing !== null) return existing
      const block: BlockState = {
        index: nextIndex++,
        kind,
        text: '',
        carry: new Utf16Carry(),
        replay: {},
      }
      block.replay.index = block.index
      replayBlocks.push(block.replay)
      if (kind === 'text') textBlock = block
      else reasoningBlock = block
      yield* emitFirstByte()
      yield { type: 'block-start', index: block.index, blockType: kind }
      return block
    }

    function* appendText(block: BlockState, delta: string): Generator<StreamChunk> {
      const clean = block.carry.push(delta)
      if (clean.length === 0) return
      block.text += clean
      yield block.kind === 'reasoning'
        ? { type: 'reasoning-delta', index: block.index, delta: clean }
        : { type: 'text-delta', index: block.index, delta: clean }
    }

    function* emitToolCall(part: Record<string, unknown>): Generator<StreamChunk> {
      const call = isPlainRecord(part.functionCall) ? part.functionCall : undefined
      if (call === undefined) return
      yield* closeOpenBlocks()
      const name = readNonEmptyString(call.name)
      if (name === undefined) {
        throw failure('MALFORMED_RESPONSE', 'Gemini functionCall part is missing its name')
      }
      let args: Record<string, unknown> = {}
      const rawArgs = call.args
      if (isPlainRecord(rawArgs)) {
        args = rawArgs
      } else if (typeof rawArgs === 'string' && rawArgs.isWellFormed()) {
        try {
          const parsed: unknown = JSON.parse(rawArgs)
          if (isPlainRecord(parsed)) args = parsed
        } catch {
          throw failure(
            'MALFORMED_RESPONSE',
            `Gemini functionCall ${name} sent invalid JSON arguments`,
          )
        }
      }
      const index = nextIndex++
      const callId = readNonEmptyString(call.id) ?? `gemini-call-${index}`
      const signature = readNonEmptyString(part.thoughtSignature)
      const replay: Record<string, unknown> = { index }
      if (signature !== undefined) replay.thoughtSignature = signature
      replayBlocks.push(replay)
      const argumentsJson = JSON.stringify(args) ?? '{}'
      toolCalls++
      yield* emitFirstByte()
      yield {
        type: 'block-start',
        index,
        blockType: 'tool-call',
        toolCallId: callId as ToolCallId,
        toolName: name,
      }
      yield { type: 'tool-call-delta', index, delta: argumentsJson }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: callId as ToolCallId, name, argumentsJson },
      }
    }

    function* handlePart(part: Record<string, unknown>): Generator<StreamChunk> {
      if (isPlainRecord(part.functionCall)) {
        yield* emitToolCall(part)
        return
      }
      const text = part.text
      if (typeof text !== 'string' || text.length === 0) return
      const kind = part.thought === true ? 'reasoning' : 'text'
      const block = yield* ensureBlock(kind)
      const signature = readNonEmptyString(part.thoughtSignature)
      if (signature !== undefined) block.replay.thoughtSignature = signature
      yield* appendText(block, text)
    }

    function* handleResponse(payload: Record<string, unknown>): Generator<StreamChunk> {
      const error = payload.error
      if (isPlainRecord(error)) throw failureFromPayload(error)

      const progress = payload.usageMetadata
      if (progress !== undefined) {
        const parsed = parseUsage(progress)
        if (parsed !== undefined) usage = parsed
      }

      const feedback = payload.promptFeedback
      if (isPlainRecord(feedback)) {
        const reason = readNonEmptyString(feedback.blockReason)
        if (reason !== undefined && reason !== 'BLOCK_REASON_UNSPECIFIED') {
          const message = readNonEmptyString(feedback.blockReasonMessage)
          throw failure('CONTENT_BLOCKED', message ?? `Gemini blocked the prompt (${reason})`)
        }
      }

      const candidates = payload.candidates
      if (!Array.isArray(candidates)) return
      for (const candidate of candidates) {
        if (!isPlainRecord(candidate)) continue
        const content = candidate.content
        if (isPlainRecord(content)) {
          const parts = content.parts
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (isPlainRecord(part)) yield* handlePart(part)
            }
          }
        }
        const rawFinish = candidate.finishReason
        const finish = readNonEmptyString(rawFinish)
        if (finish === undefined || finish === 'FINISH_REASON_UNSPECIFIED') continue
        if (
          finish === 'SAFETY' ||
          finish === 'RECITATION' ||
          finish === 'BLOCKLIST' ||
          finish === 'PROHIBITED_CONTENT' ||
          finish === 'SPII' ||
          finish === 'IMAGE_SAFETY' ||
          finish === 'LANGUAGE'
        ) {
          throw failure('CONTENT_BLOCKED', `Gemini blocked the response (${finish})`)
        }
        if (finish === 'MALFORMED_FUNCTION_CALL' || finish === 'UNEXPECTED_TOOL_CALL') {
          throw failure(
            'MALFORMED_RESPONSE',
            `Gemini emitted a malformed function call (${finish})`,
          )
        }
        if (finish === 'MAX_TOKENS') terminal = 'max-tokens'
        else if (terminal === undefined) terminal = 'stop'
      }
    }

    function* finalize(): Generator<StreamChunk> {
      yield* closeOpenBlocks()
      if (nextIndex === 0) {
        throw failure('EMPTY_RESPONSE', 'upstream completed without producing any content block')
      }
      if (terminal === undefined) {
        throw failure('TRANSPORT', 'upstream stream ended before a terminal event')
      }
      if (usage !== undefined) yield { type: 'usage', usage }
      const reason: FinishReason = toolCalls > 0 ? { kind: 'tool-calls' } : { kind: terminal }
      const envelope: ReplayEnvelope = {
        adapterKind: ADAPTER_KIND,
        version: REPLAY_VERSION,
        response: { model: snapshot.modelId, candidateIndex: 0 },
        blocks: replayBlocks,
      }
      finished = true
      yield { type: 'finish', reason, replayState: some(envelope), observedAttempts: 1 }
    }

    for await (const event of events) {
      if (finished) return
      const raw = event.data.trim()
      if (raw.length === 0) continue
      if (raw === '[DONE]') break
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw failure('MALFORMED_RESPONSE', 'upstream sent an SSE payload that is not valid JSON')
      }
      const values = Array.isArray(parsed) ? parsed : [parsed]
      for (const value of values) {
        if (!isPlainRecord(value)) {
          throw failure(
            'MALFORMED_RESPONSE',
            'upstream sent an SSE payload that is not a JSON object',
          )
        }
        yield* handleResponse(value)
      }
    }

    if (finished) return
    if (!firstByteSent) {
      throw failure('EMPTY_RESPONSE', 'upstream closed the stream before emitting any event')
    }
    yield* finalize()
  },
}
