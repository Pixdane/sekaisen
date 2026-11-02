/**
 * Warm-end cache-breakpoint placement on the real Anthropic projection.
 *
 * These tests drive the production `streamSimple` backend with an injected
 * fetch, so the request body is the one pi-ai actually serializes: whitespace
 * blocks and empty assistant turns are already dropped, consecutive tool
 * results are already merged, and the volatile tail already sits where the
 * projector put it. The assertion is always on that final payload.
 */

import { describe, expect, test } from 'bun:test'
import { NONE, type Option, some } from '@sekaisen/core'
import {
  type CacheAlignedChatRequest,
  type ChatCallOverrides,
  LlmService,
  type ModelId,
  type NeutralAssistantMessage,
  type NeutralContentBlock,
  type NeutralMessage,
  type NeutralToolDefinition,
  type NeutralUserMessage,
  type RouteId,
  type StreamChunk,
  type TextBlock,
  type ToolCallId,
  t,
} from '@sekaisen/plugin-llm'
import { type OmpAuthStorageLike, OmpPiAiAdapter } from '@sekaisen/plugin-llm-omp'
import { Context } from 'cordis'
import type { FetchImpl } from '../packages/plugin-llm-omp/src/pi-ai.ts'

const ROUTE = 'omp:cache-boundaries' as RouteId
const MODEL = 'claude-sonnet-4-5' as ModelId
const TEXT_ROUTE = 'omp:cache-text' as RouteId
const TEXT_MODEL = 'MiniMax-M2' as ModelId

interface Target {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly provider: string
}

const ANTHROPIC_TARGET: Target = Object.freeze({
  routeId: ROUTE,
  modelId: MODEL,
  provider: 'anthropic',
})

/** Catalog row with no image input, so the projector serializes text as a string. */
const TEXT_TARGET: Target = Object.freeze({
  routeId: TEXT_ROUTE,
  modelId: TEXT_MODEL,
  provider: 'minimax',
})

const LOOKUP: NeutralToolDefinition = Object.freeze({
  name: 'lookup',
  description: 'Look up one key',
  parameters: t.obj({ key: t.str() }),
})

/** Minimal well-formed Anthropic Messages SSE response; no network involved. */
const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

interface WireBlock {
  readonly type: string
  readonly text?: string
  readonly tool_use_id?: string
  readonly cache_control?: unknown
}

interface WireMessage {
  readonly role: string
  readonly content: string | readonly WireBlock[]
}

interface WirePayload {
  readonly system?: readonly WireBlock[]
  readonly tools?: readonly WireBlock[]
  readonly messages: readonly WireMessage[]
}

interface CapturingFetch {
  readonly fetch: FetchImpl
  readonly bodies: string[]
}

function capturingFetch(): CapturingFetch {
  const bodies: string[] = []
  const fetchImpl: FetchImpl = async (_input, init) => {
    if (typeof init?.body === 'string') bodies.push(init.body)
    return new Response(ANTHROPIC_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  return { fetch: fetchImpl, bodies }
}

function fakeAuthStorage(): OmpAuthStorageLike {
  return {
    keys: {
      resolver: () => async () => 'test-key',
    },
  }
}

function userBlocks(...texts: readonly string[]): NeutralUserMessage {
  const content: TextBlock[] = texts.map((text) => ({ type: 'text', text }))
  return Object.freeze({ role: 'user' as const, content: Object.freeze(content) })
}

function assistant(content: readonly NeutralContentBlock[]): NeutralAssistantMessage {
  return Object.freeze({
    role: 'assistant' as const,
    content: Object.freeze([...content]),
    origin: Object.freeze({ routeId: ROUTE, modelId: MODEL, replayState: NONE }),
  })
}

function toolCall(id: string): NeutralContentBlock {
  return Object.freeze({
    type: 'tool-call' as const,
    id: id as ToolCallId,
    name: 'lookup',
    argumentsJson: '{"key":"alpha"}',
  })
}

function toolResult(id: string, content: string): NeutralMessage {
  return Object.freeze({
    role: 'tool-result' as const,
    toolCallId: id as ToolCallId,
    toolName: 'lookup',
    content,
    isError: false,
  })
}

function request(
  history: readonly NeutralMessage[],
  tail: Option<string>,
): CacheAlignedChatRequest {
  return Object.freeze({
    segment1Static: Object.freeze([
      Object.freeze({ name: 'rules', text: 'Use lookup.' }),
      Object.freeze({ name: 'style', text: 'Be brief.' }),
    ]),
    segment2WarmHistory: Object.freeze([...history]),
    segment3VolatileTail: tail,
    sharedPrefixKey: NONE,
  })
}

async function streamWithSdk(
  adapter: OmpPiAiAdapter,
  target: Target,
  requestBody: CacheAlignedChatRequest,
  overrides: ChatCallOverrides,
): Promise<readonly StreamChunk[]> {
  const ctx = new Context()
  try {
    const service = new LlmService(ctx)
    const registration = service.registerChatAdapter([target.routeId], adapter)
    if (!registration.ok) throw new Error(registration.error.code)
    const prepared = service.prepareChatCall(
      { kind: 'explicit', routeId: target.routeId, modelId: target.modelId },
      requestBody,
      overrides,
    )
    if (!prepared.ok) throw new Error(prepared.error.code)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.value.stream(new AbortController().signal))
      chunks.push(chunk)
    return chunks
  } finally {
    await ctx.fiber.dispose()
  }
}

function wirePayload(body: string): WirePayload {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('payload is not an object')
  return parsed as WirePayload
}

function contentBlocks(message: WireMessage | undefined): readonly WireBlock[] {
  if (message === undefined) throw new Error('message missing')
  if (!Array.isArray(message.content)) throw new Error('message content is not a block array')
  return message.content as readonly WireBlock[]
}

function lastSystem(payload: WirePayload): WireBlock | undefined {
  const system = payload.system ?? []
  return system[system.length - 1]
}

function firstTool(payload: WirePayload): WireBlock | undefined {
  const tools = payload.tools ?? []
  expect(tools).toHaveLength(1)
  return tools[0]
}

async function onlyPayload(
  requestBody: CacheAlignedChatRequest,
  overrides: ChatCallOverrides,
  target: Target = ANTHROPIC_TARGET,
): Promise<WirePayload> {
  const capture = capturingFetch()
  const adapter = new OmpPiAiAdapter({
    routes: { [target.routeId]: { provider: target.provider } },
    authStorage: fakeAuthStorage(),
    fetch: capture.fetch,
  })
  await streamWithSdk(adapter, target, requestBody, overrides)
  expect(capture.bodies).toHaveLength(1)
  return wirePayload(capture.bodies[0] ?? '')
}

describe('@sekaisen/plugin-llm-omp cache boundaries', () => {
  test('anchors the merged warm turn when a whitespace assistant is filtered out', async () => {
    const payload = await onlyPayload(
      request(
        [
          userBlocks('Find alpha'),
          // The Anthropic projector drops an assistant turn whose every text
          // block is whitespace, so the payload index of the warm end shifts.
          assistant([{ type: 'text' as const, text: '   ' }]),
          // A whitespace text block is filtered out of the array, so the warm
          // end moves to an earlier block of the same projected message.
          userBlocks('Find beta', '   '),
        ],
        some('private-turn-context'),
      ),
      { tools: [LOOKUP], cacheRetention: 'long', effort: 'off' },
    )

    expect(payload.messages).toHaveLength(2)
    const first = contentBlocks(payload.messages[0])
    expect(first[0]).not.toHaveProperty('cache_control')

    const merged = contentBlocks(payload.messages[1])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ type: 'text', text: 'Find beta' })
    expect(merged[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(merged[1]?.cache_control).toBeUndefined()
    expect(merged[1]?.text ?? '').toContain('<turn-context>')

    const system = payload.system ?? []
    expect(system[system.length - 1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(system[0]).not.toHaveProperty('cache_control')
    expect(firstTool(payload)).not.toHaveProperty('cache_control')
  })

  test('anchors the merged tool-result run and never the appended tail', async () => {
    const payload = await onlyPayload(
      request(
        [
          userBlocks('Find alpha'),
          assistant([toolCall('call_1'), toolCall('call_2')]),
          toolResult('call_1', '{"found":1}'),
          toolResult('call_2', '{"found":2}'),
        ],
        some('private-turn-context'),
      ),
      { tools: [LOOKUP], cacheRetention: 'short', effort: 'off' },
    )

    expect(payload.messages).toHaveLength(4)
    const merged = contentBlocks(payload.messages[2])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' })
    expect(merged[0]).not.toHaveProperty('cache_control')
    expect(merged[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_2' })
    expect(merged[1]?.cache_control).toEqual({ type: 'ephemeral' })

    const tail = contentBlocks(payload.messages[3])
    expect(tail).toHaveLength(1)
    expect(tail[0]?.text ?? '').toContain('<turn-context>')
    expect(tail[0]?.cache_control).toBeUndefined()
    expect(lastSystem(payload)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(firstTool(payload)).not.toHaveProperty('cache_control')
  })

  test('anchors the trailing assistant and never the synthetic Continue pad', async () => {
    const payload = await onlyPayload(
      request(
        [userBlocks('Find alpha'), assistant([{ type: 'text' as const, text: 'Found it.' }])],
        NONE,
      ),
      { tools: [LOOKUP], cacheRetention: 'short', effort: 'off' },
    )

    expect(payload.messages).toHaveLength(3)
    const found = contentBlocks(payload.messages[1])
    expect(found[0]).toMatchObject({ type: 'text', text: 'Found it.' })
    expect(found[0]?.cache_control).toEqual({ type: 'ephemeral' })

    const pad = payload.messages[2]
    expect(pad?.role).toBe('user')
    expect(pad?.content).toBe('Continue.')
  })

  test('omits the history anchor when every warm block is whitespace', async () => {
    const payload = await onlyPayload(request([userBlocks('   ')], some('private-turn-context')), {
      tools: [LOOKUP],
      cacheRetention: 'short',
      effort: 'off',
    })

    expect(payload.messages).toHaveLength(1)
    const tailOnly = contentBlocks(payload.messages[0])
    expect(tailOnly).toHaveLength(1)
    expect(tailOnly[0]?.text ?? '').toContain('<turn-context>')
    expect(tailOnly[0]?.cache_control).toBeUndefined()
    expect(lastSystem(payload)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(firstTool(payload)).not.toHaveProperty('cache_control')
  })

  test('splits a non-vision merged tail at the exact known boundary', async () => {
    const payload = await onlyPayload(
      request([userBlocks('Find beta')], some('private-turn-context')),
      { tools: [LOOKUP], cacheRetention: 'short', effort: 'off' },
      TEXT_TARGET,
    )

    expect(payload.messages).toHaveLength(1)
    const blocks = contentBlocks(payload.messages[0])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'Find beta' })
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1]).toMatchObject({
      type: 'text',
      text: '\n\n<turn-context>\nprivate-turn-context\n</turn-context>',
    })
    expect(blocks[1]?.cache_control).toBeUndefined()
    expect(lastSystem(payload)?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('keeps warm text serialization stable outside the trailing window', async () => {
    const overrides: ChatCallOverrides = { tools: [LOOKUP], cacheRetention: 'short', effort: 'off' }
    const merged = await onlyPayload(
      request([userBlocks('Find beta')], some('private-turn-context')),
      overrides,
      TEXT_TARGET,
    )
    const interior = await onlyPayload(
      request(
        [
          userBlocks('Find beta'),
          assistant([{ type: 'text' as const, text: 'Found it.' }]),
          userBlocks('Next'),
          assistant([{ type: 'text' as const, text: 'Done.' }]),
        ],
        NONE,
      ),
      overrides,
      TEXT_TARGET,
    )

    const mergedFirst = contentBlocks(merged.messages[0])
    expect(interior.messages).toHaveLength(5)
    const interiorFirst = contentBlocks(interior.messages[0])
    expect(interiorFirst).toHaveLength(1)
    expect(interiorFirst[0]).toMatchObject({ type: 'text' })
    expect(interiorFirst[0]?.text).toBe(mergedFirst[0]?.text)
    expect(interiorFirst[0]).not.toHaveProperty('cache_control')

    const lastAssistant = contentBlocks(interior.messages[3])
    expect(lastAssistant[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('keeps a genuine final Continue. user warm', async () => {
    const payload = await onlyPayload(
      request(
        [
          userBlocks('Find alpha'),
          assistant([{ type: 'text' as const, text: 'Found it.' }]),
          userBlocks('Continue.'),
        ],
        NONE,
      ),
      { tools: [LOOKUP], cacheRetention: 'short', effort: 'off' },
      TEXT_TARGET,
    )

    expect(payload.messages).toHaveLength(3)
    const last = contentBlocks(payload.messages[2])
    expect(last).toHaveLength(1)
    expect(last[0]).toMatchObject({ type: 'text', text: 'Continue.' })
    expect(last[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('keeps a Continue. user warm when a later whitespace assistant is filtered', async () => {
    const payload = await onlyPayload(
      request(
        [
          userBlocks('Find alpha'),
          assistant([{ type: 'text' as const, text: 'Found it.' }]),
          userBlocks('Continue.'),
          assistant([{ type: 'text' as const, text: '   ' }]),
        ],
        NONE,
      ),
      { tools: [LOOKUP], cacheRetention: 'short', effort: 'off' },
      TEXT_TARGET,
    )

    expect(payload.messages).toHaveLength(3)
    const last = contentBlocks(payload.messages[2])
    expect(last[0]).toMatchObject({ type: 'text', text: 'Continue.' })
    expect(last[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })
})
