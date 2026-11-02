import { expect, test } from 'bun:test'
import { NONE, type Option, some } from '@sekaisen/core'
import {
  LlmService,
  type ModelId,
  type NeutralContentBlock,
  parseToolArguments,
  type ReplayEnvelope,
  type RouteId,
  t,
} from '@sekaisen/plugin-llm'
import { Context } from 'cordis'
import { DirectChatAdapter } from '../packages/plugin-llm/src/direct/adapter.ts'
import type { DirectFetch } from '../packages/plugin-llm/src/direct/contract.ts'

function sse(events: readonly Record<string, unknown>[]): Response {
  return new Response(
    events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
const firstResponse = [
  {
    type: 'message_start',
    message: { id: 'message_signed', usage: { input_tokens: 10, output_tokens: 0 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Find the requested record.' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'signed-reasoning-proof' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'call_record', name: 'lookup', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"key":"alpha","limit":null}' },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' },
]
const finalResponse = [
  {
    type: 'message_start',
    message: { id: 'message_final', usage: { input_tokens: 20, output_tokens: 0 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Record found.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]

test('signed tool round-trip preserves same-origin reasoning and keeps volatile context uncached', async () => {
  const outbound: Record<string, unknown>[] = []
  const adapter = new DirectChatAdapter({
    routes: {
      signed: {
        protocol: 'anthropic-messages',
        baseURL: 'https://fixture.invalid/v1',
        authMode: 'none',
      },
    },
    fetch: (async (_url, init) => {
      outbound.push(JSON.parse(String(init?.body)))
      return sse(outbound.length === 1 ? firstResponse : finalResponse)
    }) as DirectFetch,
  })
  const ctx = new Context()
  try {
    const service = new LlmService(ctx)
    const registration = service.registerChatAdapter(['signed' as RouteId], adapter)
    if (!registration.ok) throw new Error(registration.error.code)
    const schema = t.obj({ key: t.str(), limit: t.int().default(2) })
    const user = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Find alpha' }],
      cacheBreakpoint: 'long' as const,
    }
    const request = {
      segment1Static: [{ name: 'rules', text: 'Use lookup.' }],
      segment2WarmHistory: [user],
      segment3VolatileTail: some('private-turn-one'),
      sharedPrefixKey: some('shared'),
    }
    const target = {
      kind: 'explicit' as const,
      routeId: 'signed' as RouteId,
      modelId: 'claude-fixture' as ModelId,
    }
    const first = service.prepareChatCall(target, request, {
      cacheRetention: 'short',
      tools: [{ name: 'lookup', description: 'Find record', parameters: schema }],
    })
    if (!first.ok) throw new Error(first.error.code)
    const content: NeutralContentBlock[] = []
    let replayState: Option<ReplayEnvelope> = NONE
    for await (const chunk of first.value.stream(new AbortController().signal)) {
      if (chunk.type === 'block-end') content.push(chunk.block)
      if (chunk.type === 'finish') {
        expect(chunk.reason.kind).toBe('tool-calls')
        replayState = chunk.replayState
      }
    }
    const call = content.find((block) => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('tool block missing')
    const parsed = parseToolArguments(schema, call.argumentsJson)
    expect(parsed).toEqual({ ok: true, value: { key: 'alpha', limit: 2 } })
    const warmHistory = [
      user,
      {
        role: 'assistant' as const,
        content,
        origin: { routeId: target.routeId, modelId: target.modelId, replayState },
      },
      {
        role: 'tool-result' as const,
        toolCallId: call.id,
        toolName: call.name,
        content: '{"found":true}',
        isError: false,
      },
    ]
    const followup = {
      ...request,
      segment2WarmHistory: warmHistory,
      segment3VolatileTail: some('private-turn-two'),
    }
    for (const modelId of [target.modelId, 'another-model' as ModelId]) {
      const prepared = service.prepareChatCall({ ...target, modelId }, followup, {
        cacheRetention: 'short',
      })
      if (!prepared.ok) throw new Error(prepared.error.code)
      for await (const _chunk of prepared.value.stream(new AbortController().signal)) {
        /* consume guarded stream */
      }
    }
    const same = outbound[1]!
    const foreign = outbound[2]!
    expect(JSON.stringify(same)).toContain('signed-reasoning-proof')
    expect(JSON.stringify(foreign)).not.toContain('signed-reasoning-proof')
    expect(same.system).toEqual(outbound[0]!.system)
    for (const body of [same, foreign]) {
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('private-turn-one')
      const messages = body.messages as { content: Record<string, unknown>[] }[]
      const blocks = messages.flatMap((message) => message.content)
      const volatile = blocks.find((block) => JSON.stringify(block).includes('private-turn-two'))
      expect(volatile).toBeDefined()
      expect(volatile).not.toHaveProperty('cache_control')
      const markedHistory = blocks.filter((block) => Object.hasOwn(block, 'cache_control'))
      expect(markedHistory).toHaveLength(1)
      expect(markedHistory[0]!.type).toBe('tool_result')
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
