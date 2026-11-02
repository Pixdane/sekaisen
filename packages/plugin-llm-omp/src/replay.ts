/**
 * Same-origin replay state for pi-ai responses.
 *
 * Neutral content carries only text, reasoning and tool calls. Everything the
 * next turn needs to replay a signed or encrypted assistant block — Anthropic
 * `thinkingSignature`/`redacted_thinking`, Gemini `thoughtSignature`, Responses
 * item ids/signatures, provider payloads — is stored in the adapter-private
 * `ReplayEnvelope`.
 *
 * `ReplayEnvelope.blocks[i]` stays index-aligned with the neutral content block
 * array. Provider blocks that the neutral vocabulary cannot represent (images,
 * server-tool blocks, fallback markers) are kept in `response.extraContent`
 * with the neutral block index they precede, so replay order survives without
 * breaking the 1:1 alignment rule.
 */

import type { Option } from '@sekaisen/core'
import { isSome } from '@sekaisen/core'
import type { ReplayEnvelope } from '@sekaisen/plugin-llm'
import type { AssistantMessage, PiAiToolCall } from './pi-ai.ts'
import { asRecord } from './record.ts'

/** Adapter kind recorded in every envelope this bridge produces. */
export const OMP_ADAPTER_KIND = 'omp:pi-ai'
/** Envelope protocol version understood by this bridge. */
export const OMP_REPLAY_VERSION = 1

/** One provider block that has no neutral representation, with its ordering anchor. */
export interface OmpReplayExtraContent {
  /** Insert after this many emitted neutral blocks (`0` = before the first block). */
  readonly beforeBlockIndex: number
  /** Verbatim `AssistantMessage` content entry. */
  readonly block: unknown
}

/** Response-level private metadata. */
export interface OmpReplayResponseV1 {
  readonly version: typeof OMP_REPLAY_VERSION
  readonly provider: string
  readonly model: string
  readonly api: string
  readonly providerPayload?: unknown
  readonly requestControls?: unknown
  readonly responseId?: string
  readonly extraContent?: readonly OmpReplayExtraContent[]
}

/** Per-neutral-block private metadata. */
export interface OmpReplayBlockV1 {
  readonly textSignature?: string
  readonly thinkingSignature?: string
  readonly itemId?: string
  readonly summary?: boolean
  readonly thoughtSignature?: string
  readonly customWireName?: string
  readonly providerMetadata?: unknown
  /** Present when this neutral reasoning block mirrors a redacted thinking block. */
  readonly redacted?: string
}

/** Decoded, same-origin replay state ready for history conversion. */
export interface OmpDecodedReplay {
  readonly response: OmpReplayResponseV1
  readonly blocks: readonly OmpReplayBlockV1[]
  readonly byBlockIndex: ReadonlyMap<number, OmpReplayBlockV1>
  readonly extrasByIndex: ReadonlyMap<number, readonly unknown[]>
}

function blockMetadata(block: AssistantMessage['content'][number]): OmpReplayBlockV1 {
  switch (block.type) {
    case 'text':
      return typeof block.textSignature === 'string' && block.textSignature.length > 0
        ? Object.freeze({ textSignature: block.textSignature })
        : Object.freeze({})
    case 'thinking':
      return Object.freeze({
        ...(typeof block.thinkingSignature === 'string' && block.thinkingSignature.length > 0
          ? { thinkingSignature: block.thinkingSignature }
          : {}),
        ...(typeof block.itemId === 'string' && block.itemId.length > 0
          ? { itemId: block.itemId }
          : {}),
        ...(block.summary === undefined ? {} : { summary: block.summary }),
      })
    case 'redactedThinking':
      return Object.freeze({ redacted: block.data })
    case 'toolCall':
      return Object.freeze({
        ...(typeof block.thoughtSignature === 'string' && block.thoughtSignature.length > 0
          ? { thoughtSignature: block.thoughtSignature }
          : {}),
        ...(typeof block.customWireName === 'string' && block.customWireName.length > 0
          ? { customWireName: block.customWireName }
          : {}),
        ...(block.providerMetadata === undefined
          ? {}
          : { providerMetadata: block.providerMetadata }),
      })
    default:
      return Object.freeze({})
  }
}

/**
 * Builds a replay envelope from the authoritative final assistant message and
 * the pi-content-index → neutral-block-index mapping used while streaming.
 */
export function buildOmpReplayEnvelope(
  message: AssistantMessage,
  piToNeutral: ReadonlyMap<number, number>,
  emittedBlocks: number,
): ReplayEnvelope {
  const blocks: OmpReplayBlockV1[] = Array.from(
    { length: emittedBlocks },
    () => Object.freeze({}) as OmpReplayBlockV1,
  )
  const extras: OmpReplayExtraContent[] = []
  const mappedPiIndices = [...piToNeutral.keys()].sort((left, right) => left - right)
  for (let piIndex = 0; piIndex < message.content.length; piIndex += 1) {
    const neutralIndex = piToNeutral.get(piIndex)
    const block = message.content[piIndex]
    if (block === undefined) continue
    if (neutralIndex === undefined) {
      let beforeBlockIndex = 0
      for (const mapped of mappedPiIndices) {
        if (mapped < piIndex) beforeBlockIndex += 1
        else break
      }
      extras.push(Object.freeze({ beforeBlockIndex, block }))
      continue
    }
    blocks[neutralIndex] = blockMetadata(block)
  }
  const response: OmpReplayResponseV1 = Object.freeze({
    version: OMP_REPLAY_VERSION,
    provider: message.provider,
    model: message.model,
    api: message.api,
    ...(message.providerPayload === undefined ? {} : { providerPayload: message.providerPayload }),
    ...(message.requestControls === undefined ? {} : { requestControls: message.requestControls }),
    ...(typeof message.responseId === 'string' && message.responseId.length > 0
      ? { responseId: message.responseId }
      : {}),
    ...(extras.length === 0 ? {} : { extraContent: Object.freeze(extras) }),
  })
  return Object.freeze({
    adapterKind: OMP_ADAPTER_KIND,
    version: OMP_REPLAY_VERSION,
    response,
    blocks: Object.freeze(blocks),
  })
}

/** Opaque signatures and identities: `buildOmpReplayEnvelope` never stores these empty. */
const OMP_BLOCK_SIGNATURE_FIELDS = [
  'textSignature',
  'thinkingSignature',
  'itemId',
  'thoughtSignature',
  'customWireName',
] as const

/**
 * Decodes one block's private metadata under the documented field types, so a
 * corrupted or swapped history entry can never push a non-string signature into
 * the provider request. Unknown keys are dropped (forward compatibility); a
 * mistyped known key invalidates the whole envelope.
 *
 * `redacted` mirrors `RedactedThinkingContent.data` verbatim, so any string is
 * accepted; the signature fields are only emitted when non-empty.
 */
function decodeBlock(value: unknown): OmpReplayBlockV1 | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const block: Record<string, unknown> = {}
  for (const field of OMP_BLOCK_SIGNATURE_FIELDS) {
    const payload = record[field]
    if (payload === undefined) continue
    if (typeof payload !== 'string' || payload.length === 0) return undefined
    block[field] = payload
  }
  if (record.redacted !== undefined) {
    if (typeof record.redacted !== 'string') return undefined
    block.redacted = record.redacted
  }
  if (record.summary !== undefined) {
    if (typeof record.summary !== 'boolean') return undefined
    block.summary = record.summary
  }
  if (record.providerMetadata !== undefined) {
    const providerMetadata = asRecord(record.providerMetadata)
    if (providerMetadata === undefined) return undefined
    block.providerMetadata = providerMetadata
  }
  return Object.freeze(block) as OmpReplayBlockV1
}

const EXTRA_IMAGE_DETAILS: Readonly<Record<string, true>> = Object.freeze({
  auto: true,
  low: true,
  high: true,
  original: true,
})
const EXTRA_IMAGE_PROVIDERS: Readonly<Record<string, true>> = Object.freeze({
  openai: true,
  anthropic: true,
  google: true,
})
const EXTRA_SERVER_TOOL_NAMES: Readonly<Record<string, true>> = Object.freeze({
  web_search: true,
  tool_search_tool_regex: true,
  tool_search_tool_bm25: true,
})

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isModelRef(value: unknown): boolean {
  const record = asRecord(value)
  return record !== undefined && typeof record.model === 'string'
}

function isImageProviderFile(value: unknown): boolean {
  const record = asRecord(value)
  if (record === undefined) return false
  if (
    typeof record.provider !== 'string' ||
    !Object.hasOwn(EXTRA_IMAGE_PROVIDERS, record.provider)
  ) {
    return false
  }
  if (!isOptionalString(record.id) || !isOptionalString(record.uri)) return false
  return (
    record.expiresAt === undefined ||
    (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt))
  )
}

function isServerToolBlock(value: unknown): boolean {
  const block = asRecord(value)
  if (block === undefined) return false
  if (block.type === 'server_tool_use') {
    return (
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      Object.hasOwn(EXTRA_SERVER_TOOL_NAMES, block.name) &&
      (block.input === undefined || block.input === null || asRecord(block.input) !== undefined)
    )
  }
  if (block.type === 'web_search_tool_result' || block.type === 'tool_search_tool_result') {
    return typeof block.tool_use_id === 'string' && Object.hasOwn(block, 'content')
  }
  return false
}

/**
 * Narrows one `response.extraContent` value to a permitted SDK assistant block.
 *
 * pi-ai exports no runtime content validator, so these guards mirror the
 * `AssistantMessage.content` interfaces: a wrong-typed known field (signature,
 * id, enum, required payload) invalidates the whole envelope instead of being
 * restored verbatim onto the provider request. Unknown keys stay untouched.
 */
function isExtraBlock(value: unknown): boolean {
  const block = asRecord(value)
  if (block === undefined) return false
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' && isOptionalString(block.textSignature)
    case 'thinking':
      return (
        typeof block.thinking === 'string' &&
        isOptionalString(block.thinkingSignature) &&
        isOptionalString(block.itemId) &&
        (block.summary === undefined || typeof block.summary === 'boolean')
      )
    case 'redactedThinking':
      return typeof block.data === 'string'
    case 'image':
      return (
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string' &&
        isOptionalString(block.url) &&
        (block.detail === undefined ||
          (typeof block.detail === 'string' && Object.hasOwn(EXTRA_IMAGE_DETAILS, block.detail))) &&
        (block.providerFile === undefined || isImageProviderFile(block.providerFile))
      )
    case 'fallback':
      return isModelRef(block.from) && isModelRef(block.to)
    case 'anthropicServerTool':
      return isServerToolBlock(block.block)
    case 'toolCall':
      return (
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        asRecord(block.arguments) !== undefined &&
        isOptionalString(block.thoughtSignature) &&
        isOptionalString(block.intent) &&
        isOptionalString(block.rawBlock) &&
        isOptionalString(block.customWireName) &&
        (block.providerMetadata === undefined || asRecord(block.providerMetadata) !== undefined)
      )
    default:
      return false
  }
}

function decodeExtras(value: unknown): Map<number, readonly unknown[]> | undefined {
  if (value === undefined) return new Map()
  if (!Array.isArray(value)) return undefined
  const extras = new Map<number, unknown[]>()
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) return undefined
    const index = record.beforeBlockIndex
    const block = record.block
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      return undefined
    }
    if (!isExtraBlock(block)) return undefined
    const list = extras.get(index)
    if (list === undefined) extras.set(index, [block])
    else list.push(block)
  }
  return extras
}

/**
 * Validates an envelope for the current route/model. Anything foreign,
 * version-mismatched, misaligned or structurally corrupt is ignored so a
 * cross-provider history can never poison an outbound request.
 */
export function decodeOmpReplayState(
  state: Option<ReplayEnvelope>,
  provider: string,
  modelId: string,
  expectedBlocks: number,
): OmpDecodedReplay | undefined {
  if (!isSome(state)) return undefined
  const envelope = state.value
  if (envelope.adapterKind !== OMP_ADAPTER_KIND) return undefined
  if (envelope.version !== OMP_REPLAY_VERSION) return undefined
  const response = asRecord(envelope.response)
  if (response === undefined) return undefined
  if (response.version !== OMP_REPLAY_VERSION) return undefined
  if (response.provider !== provider || response.model !== modelId) return undefined
  if (typeof response.api !== 'string') return undefined
  const blocksValue = envelope.blocks
  if (blocksValue !== undefined && !Array.isArray(blocksValue)) return undefined
  const blocks: OmpReplayBlockV1[] = []
  if (blocksValue !== undefined) {
    if (blocksValue.length !== expectedBlocks) return undefined
    for (const entry of blocksValue) {
      const decoded = decodeBlock(entry)
      if (decoded === undefined) return undefined
      blocks.push(decoded)
    }
  } else if (expectedBlocks > 0) {
    return undefined
  }
  const extras = decodeExtras(response.extraContent)
  if (extras === undefined) return undefined
  const byBlockIndex = new Map<number, OmpReplayBlockV1>()
  blocks.forEach((block, index) => {
    byBlockIndex.set(index, block)
  })
  return Object.freeze({
    response: Object.freeze({
      version: OMP_REPLAY_VERSION,
      provider: response.provider as string,
      model: response.model as string,
      api: response.api as string,
      ...(response.providerPayload === undefined
        ? {}
        : { providerPayload: response.providerPayload }),
      ...(response.requestControls === undefined
        ? {}
        : { requestControls: response.requestControls }),
      ...(typeof response.responseId === 'string' ? { responseId: response.responseId } : {}),
      ...(extras.size === 0 ? {} : { extraContent: Object.freeze(collectExtras(extras)) }),
    }),
    blocks: Object.freeze(blocks),
    byBlockIndex,
    extrasByIndex: extras,
  })
}

function collectExtras(extras: ReadonlyMap<number, readonly unknown[]>): OmpReplayExtraContent[] {
  const result: OmpReplayExtraContent[] = []
  for (const [beforeBlockIndex, blocks] of extras) {
    for (const block of blocks) {
      result.push(Object.freeze({ beforeBlockIndex, block }))
    }
  }
  return result.sort((left, right) => left.beforeBlockIndex - right.beforeBlockIndex)
}

/** Converts replay metadata into the provider content block it represents. */
export function replayToolCallMetadata(
  metadata: OmpReplayBlockV1 | undefined,
): Pick<PiAiToolCall, 'thoughtSignature' | 'customWireName' | 'providerMetadata'> {
  if (metadata === undefined) return {}
  return {
    ...(metadata.thoughtSignature === undefined
      ? {}
      : { thoughtSignature: metadata.thoughtSignature }),
    ...(metadata.customWireName === undefined ? {} : { customWireName: metadata.customWireName }),
    ...(metadata.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: metadata.providerMetadata as NonNullable<
            PiAiToolCall['providerMetadata']
          >,
        }),
  }
}
