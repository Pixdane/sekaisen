/**
 * OpenAI Responses wire engine (`/v1/responses`).
 *
 * Stateless by construction: every request sends `store: false`, so the full
 * conversation is reconstructed from the neutral request on each call. Session
 * affinity travels through `prompt_cache_key`, which never contains per-turn
 * volatile text, keeping the cacheable prefix byte-stable.
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

/** Replay envelope kind for the direct Responses engine (`'direct:' + protocol`). */
export const RESPONSES_REPLAY_ADAPTER_KIND = 'direct:openai-responses'

const ADAPTER_KIND = RESPONSES_REPLAY_ADAPTER_KIND
const REPLAY_VERSION = 1

const RESPONSES_PATH = '/v1/responses'

/* -------------------------------------------------------------------------- */
/*                              Small utilities                              */
/* -------------------------------------------------------------------------- */

/**
 * Emits well-formed UTF-16 increments: a delta ending in a lone high surrogate
 * is held until the following delta supplies its low surrogate. Genuinely
 * unpaired surrogates are replaced instead of corrupting the protocol guard.
 */
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

function readIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function parseUsage(raw: unknown): DisjointTokenUsage | undefined {
  if (!isPlainRecord(raw)) return undefined
  const input = readCount(raw.input_tokens)
  const details = isPlainRecord(raw.input_tokens_details) ? raw.input_tokens_details : undefined
  const cacheRead = Math.min(readCount(details?.cached_tokens), input)
  const output = readCount(raw.output_tokens)
  const outputDetails = isPlainRecord(raw.output_tokens_details)
    ? raw.output_tokens_details
    : undefined
  const reasoningRaw = outputDetails?.reasoning_tokens
  const reasoningTokens: Option<number> =
    typeof reasoningRaw === 'number' && Number.isFinite(reasoningRaw) && reasoningRaw >= 0
      ? some(readCount(reasoningRaw))
      : NONE
  const costRaw = raw.cost
  const cost =
    typeof costRaw === 'number' && Number.isFinite(costRaw) && costRaw >= 0
      ? some(costRaw === 0 ? 0 : costRaw)
      : NONE
  return {
    inputUncachedTokens: input - cacheRead,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    outputTokens: output,
    reasoningTokens,
    authoritativeCostUsd: cost,
  }
}

/* -------------------------------------------------------------------------- */
/*                             Request assembly                              */
/* -------------------------------------------------------------------------- */

function responsesEffort(snapshot: PreparedChatCallSnapshot): string | undefined {
  switch (snapshot.effectiveEffort) {
    case 'off':
      return undefined
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
    case 'max':
      return 'high'
  }
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

/**
 * Narrows function-call replay metadata to the call it was recorded for. The
 * record carries the call id it describes (`replay.callId` while decoding), so
 * a stale or swapped record can be rejected before any of its fields (item id,
 * signatures) reaches the wire.
 */
function toolCallMetadata(
  metadata: Record<string, unknown> | undefined,
  callId: string,
): Record<string, unknown> | undefined {
  if (metadata === undefined || metadata.callId !== callId) return undefined
  return metadata
}

function toolChoiceFor(snapshot: PreparedChatCallSnapshot): unknown {
  const choice = snapshot.effectiveToolChoice
  switch (choice.kind) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'required':
      return 'required'
    case 'named':
      return { type: 'function', name: requireText(choice.toolName, 'named tool choice') }
  }
}

function volatileTailText(snapshot: PreparedChatCallSnapshot): string | undefined {
  const tail = snapshot.request.segment3VolatileTail
  if (!isSome(tail)) return undefined
  const text = tail.value
  if (text.trim().length === 0) return undefined
  return `<turn-context>\n${requireText(text, 'volatile tail')}\n</turn-context>`
}

function build(snapshot: PreparedChatCallSnapshot): WireRequest {
  const items: Record<string, unknown>[] = []

  const systemParts = snapshot.request.segment1Static.map((segment) => ({
    type: 'input_text',
    text: requireText(segment.text, 'system segment text'),
  }))
  if (systemParts.length > 0) {
    items.push({ type: 'message', role: 'developer', content: systemParts })
  }

  for (const message of snapshot.request.segment2WarmHistory) {
    if (message.role === 'user') {
      if (message.content.length === 0) {
        throw failure('INVALID_REQUEST', 'user message must contain at least one text block')
      }
      items.push({
        type: 'message',
        role: 'user',
        content: message.content.map((block) => ({
          type: 'input_text',
          text: requireText(block.text, 'user text'),
        })),
      })
      continue
    }
    if (message.role === 'tool-result') {
      items.push({
        type: 'function_call_output',
        call_id: requireText(message.toolCallId, 'tool call id'),
        output: requireText(message.content, 'tool result'),
      })
      continue
    }

    const replay = replayBlocksFor(message, snapshot)
    message.content.forEach((block, index) => {
      const metadata = blockMetadata(replay, index)
      if (block.type === 'text') {
        const item: Record<string, unknown> = {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: requireText(block.text, 'assistant text') }],
        }
        const itemId = readNonEmptyString(metadata?.itemId)
        if (itemId !== undefined) item.id = itemId
        items.push(item)
        return
      }
      if (block.type === 'reasoning') {
        const item: Record<string, unknown> = { type: 'reasoning' }
        const itemId = readNonEmptyString(metadata?.itemId)
        if (itemId !== undefined) item.id = itemId
        const encrypted = readNonEmptyString(metadata?.encryptedContent)
        if (encrypted !== undefined) item.encrypted_content = encrypted
        const text = requireText(block.text, 'reasoning text')
        if (text.length > 0) item.summary = [{ type: 'summary_text', text }]
        if (itemId === undefined && encrypted === undefined && text.length === 0) return
        items.push(item)
        return
      }
      const item: Record<string, unknown> = {
        type: 'function_call',
        call_id: requireText(block.id, 'tool call id'),
        name: requireText(block.name, 'tool name'),
        arguments: requireText(block.argumentsJson, 'tool arguments'),
      }
      const itemId = readNonEmptyString(toolCallMetadata(metadata, block.id)?.itemId)
      if (itemId !== undefined) item.id = itemId
      items.push(item)
    })
  }

  const tail = volatileTailText(snapshot)
  if (tail !== undefined) {
    const last = items.at(-1)
    if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
      ;(last.content as unknown[]).push({ type: 'input_text', text: tail })
    } else {
      items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: tail }] })
    }
  }

  const tools = snapshot.tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.jsonSchema,
    strict: tool.strict,
  }))

  const body: Record<string, unknown> = {
    model: snapshot.modelId,
    store: false,
    stream: true,
    input: items,
  }

  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = toolChoiceFor(snapshot)
  }

  const effort = responsesEffort(snapshot)
  if (effort !== undefined) {
    body.reasoning = { effort }
    body.include = ['reasoning.encrypted_content']
  }

  const sampling = snapshot.sampling
  if (isSome(sampling.temperature) && Number.isFinite(sampling.temperature.value)) {
    body.temperature = sampling.temperature.value
  }
  if (isSome(sampling.topP) && Number.isFinite(sampling.topP.value)) {
    body.top_p = sampling.topP.value
  }
  if (isSome(sampling.maxOutputTokens)) {
    body.max_output_tokens = readCount(sampling.maxOutputTokens.value)
  }
  if (isSome(sampling.sessionAffinityKey)) {
    const key = readNonEmptyString(sampling.sessionAffinityKey.value)
    if (key !== undefined) body.prompt_cache_key = key
  }

  return { path: RESPONSES_PATH, body }
}

/* -------------------------------------------------------------------------- */
/*                              Stream decoding                              */
/* -------------------------------------------------------------------------- */

interface ItemState {
  readonly itemId: string
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  index: number
  open: boolean
  closed: boolean
  text: string
  carry: Utf16Carry
  args: string
  argsCarry: Utf16Carry
  callId: string
  name: string
  encrypted: string | undefined
  authoritativeText: string | undefined
  authoritativeArgs: string | undefined
  argumentsJson: string
  readonly replay: Record<string, unknown>
}

function failureFromPayload(payload: Record<string, unknown> | undefined): LlmFailure {
  const code =
    readNonEmptyString(payload?.code) ?? readNonEmptyString(payload?.type) ?? 'unknown_error'
  const rawMessage = payload?.message
  const message =
    typeof rawMessage === 'string' && rawMessage.isWellFormed() && rawMessage.length > 0
      ? rawMessage
      : 'upstream reported an error event'
  const haystack = `${code} ${message}`.toLowerCase()
  let mapped: LlmFailure['code']
  if (haystack.includes('rate_limit') || haystack.includes('rate limit')) mapped = 'RATE_LIMIT'
  else if (haystack.includes('quota') || haystack.includes('billing')) mapped = 'QUOTA'
  else if (
    haystack.includes('auth') ||
    haystack.includes('api_key') ||
    haystack.includes('permission')
  )
    mapped = 'AUTH'
  else if (haystack.includes('context') || haystack.includes('too many tokens'))
    mapped = 'CONTEXT_WINDOW_EXCEEDED'
  else if (
    haystack.includes('content_filter') ||
    haystack.includes('content_policy') ||
    haystack.includes('safety') ||
    haystack.includes('moderation') ||
    haystack.includes('blocked')
  )
    mapped = 'CONTENT_BLOCKED'
  else if (haystack.includes('timeout')) mapped = 'TIMEOUT'
  else if (
    haystack.includes('server') ||
    haystack.includes('overloaded') ||
    haystack.includes('unavailable')
  )
    mapped = 'SERVER'
  else mapped = 'INVALID_REQUEST'
  const statusValue = readIndex(payload?.status)
  const status =
    statusValue !== undefined && statusValue >= 100 && statusValue <= 599 ? some(statusValue) : NONE
  return failure(mapped, message, { status })
}

function assertToolArguments(raw: string, name: string): void {
  if (!raw.isWellFormed()) {
    throw failure('MALFORMED_RESPONSE', `tool arguments for ${name} are not well-formed Unicode`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw failure('MALFORMED_RESPONSE', `tool arguments for ${name} are not valid JSON`)
  }
  if (!isPlainRecord(parsed)) {
    throw failure('MALFORMED_RESPONSE', `tool arguments for ${name} must decode to a JSON object`)
  }
}

export const responsesEngine: DirectWireEngine = {
  build,

  async *decode(
    events: AsyncIterable<SseEvent>,
    snapshot: PreparedChatCallSnapshot,
    _config: DirectRouteConfig,
  ): AsyncIterable<StreamChunk> {
    const byItemId = new Map<string, ItemState>()
    const byOutputIndex = new Map<number, ItemState>()
    const ordered: ItemState[] = []
    const replayBlocks: Record<string, unknown>[] = []
    let nextIndex = 0
    let firstByteSent = false
    let sawEvent = false
    let finished = false
    let responseId: string | undefined
    let usage: DisjointTokenUsage | undefined

    const lookup = (
      itemId: string | undefined,
      outputIndex: number | undefined,
    ): ItemState | undefined => {
      const byId = itemId === undefined ? undefined : byItemId.get(itemId)
      if (byId !== undefined) return byId
      return outputIndex === undefined ? undefined : byOutputIndex.get(outputIndex)
    }

    const createItem = (
      kind: ItemState['kind'],
      itemId: string,
      outputIndex: number | undefined,
    ): ItemState => {
      const state: ItemState = {
        itemId,
        kind,
        index: -1,
        open: false,
        closed: false,
        text: '',
        carry: new Utf16Carry(),
        args: '',
        argsCarry: new Utf16Carry(),
        callId: '',
        name: '',
        encrypted: undefined,
        authoritativeText: undefined,
        authoritativeArgs: undefined,
        argumentsJson: '',
        replay: {},
      }
      byItemId.set(itemId, state)
      if (outputIndex !== undefined) byOutputIndex.set(outputIndex, state)
      ordered.push(state)
      return state
    }

    const identity = (
      data: Record<string, unknown>,
      prefix: string,
    ): [string, number | undefined] => {
      const outputIndex = readIndex(data.output_index)
      const itemId =
        readNonEmptyString(data.item_id) ?? `output:${prefix}:${outputIndex ?? ordered.length}`
      return [itemId, outputIndex]
    }

    function* emitFirstByte(): Generator<StreamChunk> {
      if (firstByteSent) return
      firstByteSent = true
      yield { type: 'first-byte' }
    }

    function* openItem(state: ItemState): Generator<StreamChunk> {
      if (state.open) return
      state.open = true
      state.index = nextIndex++
      state.replay.itemId = state.itemId
      replayBlocks.push(state.replay)
      if (state.kind === 'tool-call') {
        if (state.name.length === 0) {
          throw failure('MALFORMED_RESPONSE', 'function call item is missing a name')
        }
        yield* emitFirstByte()
        yield {
          type: 'block-start',
          index: state.index,
          blockType: 'tool-call',
          toolCallId: state.callId as ToolCallId,
          toolName: state.name,
        }
        if (state.args.length > 0) {
          yield { type: 'tool-call-delta', index: state.index, delta: state.args }
        }
        return
      }
      yield* emitFirstByte()
      yield { type: 'block-start', index: state.index, blockType: state.kind }
      if (state.text.length > 0) {
        yield state.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: state.index, delta: state.text }
          : { type: 'text-delta', index: state.index, delta: state.text }
      }
    }

    function* appendText(state: ItemState, delta: string): Generator<StreamChunk> {
      if (state.closed || delta.length === 0) return
      const clean = state.carry.push(delta)
      if (clean.length === 0) return
      state.text += clean
      yield state.kind === 'reasoning'
        ? { type: 'reasoning-delta', index: state.index, delta: clean }
        : { type: 'text-delta', index: state.index, delta: clean }
    }

    function* appendArgs(state: ItemState, delta: string): Generator<StreamChunk> {
      if (state.closed || delta.length === 0) return
      const clean = state.argsCarry.push(delta)
      if (clean.length === 0) return
      state.args += clean
      if (state.open) {
        yield { type: 'tool-call-delta', index: state.index, delta: clean }
      }
    }

    function* closeItem(state: ItemState): Generator<StreamChunk> {
      if (!state.open || state.closed) return
      state.closed = true
      if (state.kind === 'tool-call') {
        const rest = state.argsCarry.flush()
        if (rest.length > 0) {
          state.args += rest
          yield { type: 'tool-call-delta', index: state.index, delta: rest }
        }
        const candidate = state.authoritativeArgs ?? state.args
        const raw = candidate.length > 0 ? candidate : '{}'
        state.argumentsJson = raw
        state.replay.callId = state.callId
        yield {
          type: 'block-end',
          index: state.index,
          block: {
            type: 'tool-call',
            id: state.callId as ToolCallId,
            name: state.name,
            argumentsJson: raw,
          },
        }
        return
      }
      const rest = state.carry.flush()
      if (rest.length > 0) {
        state.text += rest
        yield state.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: state.index, delta: rest }
          : { type: 'text-delta', index: state.index, delta: rest }
      }
      if (state.kind === 'reasoning' && state.encrypted !== undefined) {
        state.replay.encryptedContent = state.encrypted
      }
      const text = state.authoritativeText ?? state.text
      yield {
        type: 'block-end',
        index: state.index,
        block: state.kind === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text },
      }
    }

    const ensureText = (data: Record<string, unknown>): ItemState => {
      const [itemId, outputIndex] = identity(data, 'text')
      const existing = lookup(itemId, outputIndex)
      if (existing !== undefined) {
        if (existing.kind !== 'text')
          throw failure('MALFORMED_RESPONSE', 'item id switched block type')
        return existing
      }
      return createItem('text', itemId, outputIndex)
    }

    const ensureReasoning = (data: Record<string, unknown>): ItemState => {
      const [itemId, outputIndex] = identity(data, 'reasoning')
      const existing = lookup(itemId, outputIndex)
      if (existing !== undefined) {
        if (existing.kind !== 'reasoning') {
          throw failure('MALFORMED_RESPONSE', 'item id switched block type')
        }
        return existing
      }
      return createItem('reasoning', itemId, outputIndex)
    }

    const ensureTool = (data: Record<string, unknown>): ItemState => {
      const [itemId, outputIndex] = identity(data, 'tool')
      const existing = lookup(itemId, outputIndex)
      if (existing !== undefined) {
        if (existing.kind !== 'tool-call') {
          throw failure('MALFORMED_RESPONSE', 'item id switched block type')
        }
        return existing
      }
      const state = createItem('tool-call', itemId, outputIndex)
      state.callId = itemId
      return state
    }

    function* attachItemFields(
      state: ItemState,
      item: Record<string, unknown>,
    ): Generator<StreamChunk> {
      if (state.kind === 'tool-call') {
        if (!state.open) {
          const name = readNonEmptyString(item.name)
          if (name !== undefined) state.name = name
          const callId = readNonEmptyString(item.call_id)
          if (callId !== undefined) state.callId = callId
        }
        const args = item.arguments
        if (typeof args === 'string' && args.isWellFormed() && args.length > 0) {
          state.authoritativeArgs = args
          if (state.args.length === 0) yield* appendArgs(state, args)
        }
        return
      }
      if (state.kind === 'reasoning') {
        const encrypted = readNonEmptyString(item.encrypted_content)
        if (encrypted !== undefined) state.encrypted = encrypted
        const summary = collectSummary(item.summary)
        if (summary.length > 0) {
          state.authoritativeText = summary
          if (state.text.length === 0) yield* appendText(state, summary)
        }
        return
      }
      const content = item.content
      if (!Array.isArray(content)) return
      const text = collectOutputText(content)
      if (text.length > 0) {
        state.authoritativeText = text
        if (state.text.length === 0) yield* appendText(state, text)
      }
    }

    function* ingestAdded(
      item: Record<string, unknown>,
      outputIndex: number | undefined,
    ): Generator<StreamChunk> {
      const type = item.type
      if (type === 'message') {
        const state = ensureText({ item_id: item.id, output_index: outputIndex })
        yield* openItem(state)
        yield* attachItemFields(state, item)
        return
      }
      if (type === 'reasoning') {
        const state = ensureReasoning({ item_id: item.id, output_index: outputIndex })
        yield* openItem(state)
        yield* attachItemFields(state, item)
        return
      }
      if (type === 'function_call') {
        const state = ensureTool({ item_id: item.id, output_index: outputIndex })
        yield* attachItemFields(state, item)
        if (state.name.length > 0) yield* openItem(state)
      }
    }

    function* ingestDone(
      item: Record<string, unknown>,
      outputIndex: number | undefined,
    ): Generator<StreamChunk> {
      const type = item.type
      if (type !== 'message' && type !== 'reasoning' && type !== 'function_call') return
      const state =
        type === 'message'
          ? ensureText({ item_id: item.id, output_index: outputIndex })
          : type === 'reasoning'
            ? ensureReasoning({ item_id: item.id, output_index: outputIndex })
            : ensureTool({ item_id: item.id, output_index: outputIndex })
      if (state.closed) {
        if (state.kind === 'reasoning') {
          const encrypted = readNonEmptyString(item.encrypted_content)
          if (encrypted !== undefined) {
            state.encrypted = encrypted
            state.replay.encryptedContent = encrypted
          }
        }
        return
      }
      if (state.kind === 'tool-call') {
        yield* attachItemFields(state, item)
        if (!state.open) yield* openItem(state)
      } else {
        if (!state.open) yield* openItem(state)
        yield* attachItemFields(state, item)
      }
      yield* closeItem(state)
    }

    function* ingestFinalOutput(output: unknown): Generator<StreamChunk> {
      if (!Array.isArray(output)) return
      for (const entry of output) {
        if (!isPlainRecord(entry)) continue
        yield* ingestDone(entry, undefined)
      }
    }

    function* finalize(preferred: 'stop' | 'max-tokens'): Generator<StreamChunk> {
      for (const state of ordered) {
        if (!state.open && state.kind === 'tool-call' && state.args.length > 0) {
          throw failure('MALFORMED_RESPONSE', 'function call item never received a tool name')
        }
      }
      for (const state of ordered) {
        if (state.open && !state.closed) yield* closeItem(state)
      }
      if (nextIndex === 0) {
        throw failure('EMPTY_RESPONSE', 'upstream completed without producing any content block')
      }
      if (preferred !== 'max-tokens') {
        for (const state of ordered) {
          if (state.kind === 'tool-call' && state.closed) {
            assertToolArguments(state.argumentsJson, state.name)
          }
        }
      }
      if (usage !== undefined) yield { type: 'usage', usage }
      const hasToolCalls = ordered.some((state) => state.kind === 'tool-call' && state.closed)
      const reason: FinishReason =
        preferred === 'max-tokens' || !hasToolCalls ? { kind: preferred } : { kind: 'tool-calls' }
      const envelope: ReplayEnvelope = {
        adapterKind: ADAPTER_KIND,
        version: REPLAY_VERSION,
        response: { id: responseId ?? null, model: snapshot.modelId },
        blocks: replayBlocks,
      }
      finished = true
      yield { type: 'finish', reason, replayState: some(envelope), observedAttempts: 1 }
    }

    const readResponse = (parsed: Record<string, unknown>): Record<string, unknown> | undefined => {
      const response = parsed.response
      return isPlainRecord(response) ? response : undefined
    }

    const captureResponse = (response: Record<string, unknown> | undefined): void => {
      if (response === undefined) return
      const id = readNonEmptyString(response.id)
      if (id !== undefined) responseId = id
      const parsedUsage = parseUsage(response.usage)
      if (parsedUsage !== undefined) usage = parsedUsage
    }

    for await (const event of events) {
      if (finished) return
      const raw = event.data.trim()
      if (raw.length === 0) continue
      if (raw === '[DONE]') {
        yield* finalize('stop')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw failure('MALFORMED_RESPONSE', 'upstream sent an SSE payload that is not valid JSON')
      }
      if (!isPlainRecord(parsed)) {
        throw failure(
          'MALFORMED_RESPONSE',
          'upstream sent an SSE payload that is not a JSON object',
        )
      }
      sawEvent = true
      const declared = event.event
      const payloadType = typeof parsed.type === 'string' ? parsed.type : ''
      const type = declared.length > 0 && declared !== 'message' ? declared : payloadType
      switch (type) {
        case 'response.created':
        case 'response.in_progress':
        case 'response.queued':
          captureResponse(readResponse(parsed))
          break
        case 'response.output_item.added': {
          const item = parsed.item
          if (!isPlainRecord(item)) {
            throw failure('MALFORMED_RESPONSE', 'response.output_item.added is missing its item')
          }
          yield* ingestAdded(item, readIndex(parsed.output_index))
          break
        }
        case 'response.output_item.done': {
          const item = parsed.item
          if (!isPlainRecord(item)) {
            throw failure('MALFORMED_RESPONSE', 'response.output_item.done is missing its item')
          }
          yield* ingestDone(item, readIndex(parsed.output_index))
          break
        }
        case 'response.output_text.delta': {
          const state = ensureText(parsed)
          if (!state.open) yield* openItem(state)
          const delta = parsed.delta
          if (typeof delta === 'string') yield* appendText(state, delta)
          break
        }
        case 'response.output_text.done': {
          const state = ensureText(parsed)
          if (!state.closed && !state.open) yield* openItem(state)
          const text = parsed.text
          if (!state.closed && typeof text === 'string' && text.length > 0 && text.isWellFormed()) {
            state.authoritativeText = text
            if (state.text.length === 0) yield* appendText(state, text)
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const state = ensureTool(parsed)
          const delta = parsed.delta
          if (typeof delta === 'string') {
            yield* appendArgs(state, delta)
            if (!state.open && state.name.length > 0) yield* openItem(state)
          }
          break
        }
        case 'response.function_call_arguments.done': {
          const state = ensureTool(parsed)
          const args = parsed.arguments
          if (typeof args === 'string' && args.length > 0 && args.isWellFormed()) {
            state.authoritativeArgs = args
            if (state.args.length === 0) yield* appendArgs(state, args)
          }
          if (!state.closed && !state.open && state.name.length > 0) yield* openItem(state)
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const state = ensureReasoning(parsed)
          if (!state.open) yield* openItem(state)
          const delta = parsed.delta
          if (typeof delta === 'string') yield* appendText(state, delta)
          break
        }
        case 'response.refusal.delta':
        case 'response.refusal.done':
          throw failure('CONTENT_BLOCKED', 'upstream refused to answer the request')
        case 'response.content_part.done': {
          const part = parsed.part
          if (isPlainRecord(part) && part.type === 'refusal' && typeof part.refusal === 'string') {
            throw failure('CONTENT_BLOCKED', 'upstream refused to answer the request')
          }
          break
        }
        case 'response.completed':
        case 'response.done': {
          const response = readResponse(parsed)
          captureResponse(response)
          yield* ingestFinalOutput(response?.output)
          const status = response === undefined ? undefined : response.status
          const incomplete = response === undefined ? undefined : response.incomplete_details
          const incompleteReason = isPlainRecord(incomplete) ? incomplete.reason : undefined
          if (incompleteReason === 'content_filter') {
            throw failure(
              'CONTENT_BLOCKED',
              'upstream blocked the response for content policy reasons',
            )
          }
          const reason =
            status === 'incomplete' || incompleteReason === 'max_output_tokens'
              ? 'max-tokens'
              : 'stop'
          yield* finalize(reason)
          return
        }
        case 'response.incomplete': {
          const response = readResponse(parsed)
          captureResponse(response)
          yield* ingestFinalOutput(response?.output)
          const incomplete = response === undefined ? undefined : response.incomplete_details
          const reason = isPlainRecord(incomplete) ? incomplete.reason : undefined
          if (reason === 'content_filter') {
            throw failure(
              'CONTENT_BLOCKED',
              'upstream blocked the response for content policy reasons',
            )
          }
          yield* finalize(reason === 'max_output_tokens' ? 'max-tokens' : 'stop')
          return
        }
        case 'response.failed': {
          const response = readResponse(parsed)
          const error = isPlainRecord(response?.error)
            ? (response?.error as Record<string, unknown>)
            : isPlainRecord(parsed.error)
              ? (parsed.error as Record<string, unknown>)
              : undefined
          throw failureFromPayload(error)
        }
        case 'error': {
          const error = isPlainRecord(parsed.error)
            ? (parsed.error as Record<string, unknown>)
            : parsed
          throw failureFromPayload(error)
        }
        default:
          break
      }
    }

    if (finished) return
    if (!sawEvent) {
      throw failure('EMPTY_RESPONSE', 'upstream closed the stream before emitting any event')
    }
    throw failure('TRANSPORT', 'upstream stream ended before a terminal event')
  },
}

function collectOutputText(content: readonly unknown[]): string {
  let text = ''
  for (const part of content) {
    if (!isPlainRecord(part)) continue
    if (part.type === 'refusal' && typeof part.refusal === 'string') {
      throw failure('CONTENT_BLOCKED', 'upstream refused to answer the request')
    }
    if (part.type === 'output_text' && typeof part.text === 'string' && part.text.isWellFormed()) {
      text += part.text
    }
  }
  return text
}

function collectSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  let text = ''
  for (const part of summary) {
    if (!isPlainRecord(part)) continue
    const value = part.text
    if (typeof value === 'string' && value.isWellFormed()) text += value
  }
  return text
}
