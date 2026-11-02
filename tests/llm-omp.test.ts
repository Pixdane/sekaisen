import { describe, expect, test } from 'bun:test'
import { isSome, NONE, some } from '@sekaisen/core'
import {
  type CacheAlignedChatRequest,
  type ChatCallOverrides,
  LlmService,
  type ModelId,
  type NeutralAssistantMessage,
  type NeutralContentBlock,
  type NeutralToolDefinition,
  type ReplayEnvelope,
  type RouteId,
  type StreamChunk,
  type ToolCallId,
  t,
} from '@sekaisen/plugin-llm'
import {
  type AdapterConformanceFixture,
  type AdapterConformanceScenario,
  runAdapterConformanceSuite,
} from '@sekaisen/plugin-llm/testing'
import {
  OMP_PI_AI_ADAPTER_KIND,
  type OmpApiKeyResolver,
  type OmpAuthStorageLike,
  OmpPiAiAdapter,
} from '@sekaisen/plugin-llm-omp'
import { Context } from 'cordis'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  FetchImpl,
  PiAiContext,
  PiAiMessage,
  PiAiToolCall,
  PiModel,
  SimpleStreamOptions,
  TextContent,
} from '../packages/plugin-llm-omp/src/pi-ai.ts'
import { ompDefaultModelResolver } from '../packages/plugin-llm-omp/src/pi-ai.ts'

const ROUTE = 'omp:test' as RouteId
const MODEL = 'claude-sonnet-4-5' as ModelId
const CODEX_ROUTE = 'omp:codex' as RouteId
const ANTHROPIC_ROUTE = 'omp:anthropic' as RouteId
const ANTIGRAVITY_ROUTE = 'omp:antigravity' as RouteId
const CODEX_MODEL = 'gpt-5.6-sol' as ModelId
const ANTIGRAVITY_MODEL = 'claude-opus-4-5' as ModelId

const LOOKUP: NeutralToolDefinition = Object.freeze({
  name: 'lookup',
  description: 'Look up one key',
  parameters: t.obj({ key: t.str() }),
})

const REQUEST: CacheAlignedChatRequest = Object.freeze({
  segment1Static: Object.freeze([
    Object.freeze({ name: 'rules', text: 'Use lookup.' }),
    Object.freeze({ name: 'style', text: 'Be brief.' }),
  ]),
  segment2WarmHistory: Object.freeze([
    Object.freeze({
      role: 'user' as const,
      content: Object.freeze([Object.freeze({ type: 'text' as const, text: 'Find alpha' })]),
    }),
  ]),
  segment3VolatileTail: some('private-turn-context'),
  sharedPrefixKey: NONE,
})

const OVERRIDES: ChatCallOverrides = Object.freeze({ tools: Object.freeze([LOOKUP]) })

const TYPED_TOOL: NeutralToolDefinition = Object.freeze({
  name: 'typed',
  description: 'Exercise a property literally named type',
  parameters: t.obj({
    type: t.str(),
    nested: t.obj({ kind: t.str() }),
  }),
})

function fakeAuthStorage(): OmpAuthStorageLike {
  return {
    keys: {
      resolver: () => async () => 'test-key',
    },
  }
}

function usage(): AssistantMessage['usage'] {
  return {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 17,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function textContent(value: string): TextContent {
  return { type: 'text', text: value }
}

function message(
  model: PiModel,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  }
}

function toolCall(): PiAiToolCall {
  return { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { key: 'alpha' } }
}

interface FetchProbe {
  readonly fetch: FetchImpl
  readonly calls: () => number
}

function fetchProbe(status = 200): FetchProbe {
  let calls = 0
  const probe: FetchImpl = async () => {
    calls += 1
    return new Response('{}', { status })
  }
  return { fetch: probe, calls: () => calls }
}

function failureStatus(scenario: AdapterConformanceScenario): number {
  if (scenario === 'invalid-request') return 400
  if (scenario === 'rate-limit') return 429
  if (scenario === 'server-error') return 503
  return 200
}

function conformanceBackend(scenario: AdapterConformanceScenario) {
  return async function* (
    model: PiModel,
    _context: PiAiContext,
    options: SimpleStreamOptions,
  ): AsyncIterable<AssistantMessageEvent> {
    const fetchImpl = options.fetch
    if (fetchImpl === undefined) throw new Error('fetch probe missing')
    const status = failureStatus(scenario)
    await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
    if (status >= 400) {
      throw Object.assign(new Error(`fixture http ${status}`), {
        status,
        headers: new Headers(status === 429 ? { 'retry-after': '1' } : {}),
      })
    }

    yield { type: 'start', partial: message(model, [], 'stop') }
    if (scenario === 'empty-response') {
      yield { type: 'done', reason: 'stop', message: message(model, [], 'stop') }
      return
    }

    const visible = textContent('hello')
    yield {
      type: 'text_start',
      contentIndex: 0,
      partial: message(model, [textContent('')], 'stop'),
    }
    yield {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
      partial: message(model, [visible], 'stop'),
    }
    yield {
      type: 'text_end',
      contentIndex: 0,
      content: 'hello',
      partial: message(model, [visible], 'stop'),
    }

    if (scenario === 'tools' || scenario === 'interrupted-tool') {
      const call = toolCall()
      const partial = message(model, [visible, call], 'toolUse')
      yield { type: 'toolcall_start', contentIndex: 1, partial }
      yield { type: 'toolcall_delta', contentIndex: 1, delta: '{"key":"alpha"}', partial }
      if (scenario === 'interrupted-tool') throw new Error('fixture socket closed')
      yield { type: 'toolcall_end', contentIndex: 1, toolCall: call, partial }
      yield {
        type: 'done',
        reason: 'toolUse',
        message: message(model, [visible, call], 'toolUse'),
      }
      return
    }

    const stopReason = scenario === 'truncated' ? 'length' : 'stop'
    yield {
      type: 'done',
      reason: scenario === 'truncated' ? 'length' : 'stop',
      message: message(model, [visible], stopReason),
    }
  }
}

function conformanceFixture(scenario: AdapterConformanceScenario): AdapterConformanceFixture {
  const probe = fetchProbe(failureStatus(scenario))
  const adapter = new OmpPiAiAdapter({
    routes: { [ROUTE]: { provider: 'anthropic' } },
    authStorage: fakeAuthStorage(),
    stream: conformanceBackend(scenario),
    fetch: probe.fetch,
  })
  return {
    adapter,
    routeId: ROUTE,
    modelId: MODEL,
    request: REQUEST,
    overrides: OVERRIDES,
    physicalAttempts: probe.calls,
  }
}

async function streamThroughService(
  adapter: OmpPiAiAdapter,
  request: CacheAlignedChatRequest,
  overrides: ChatCallOverrides = OVERRIDES,
  signal: AbortSignal = new AbortController().signal,
  routeId: RouteId = ROUTE,
  modelId: ModelId = MODEL,
): Promise<readonly StreamChunk[]> {
  const ctx = new Context()
  try {
    const service = new LlmService(ctx)
    const registration = service.registerChatAdapter([routeId], adapter)
    if (!registration.ok) throw new Error(registration.error.code)
    const prepared = service.prepareChatCall(
      { kind: 'explicit', routeId, modelId },
      request,
      overrides,
    )
    if (!prepared.ok) throw new Error(prepared.error.code)
    const chunks: StreamChunk[] = []
    for await (const chunk of prepared.value.stream(signal)) chunks.push(chunk)
    return chunks
  } finally {
    await ctx.fiber.dispose()
  }
}

function finishOf(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish') throw new Error('terminal finish missing')
  return finish
}

describe('@sekaisen/plugin-llm-omp', () => {
  test('passes the shared adapter conformance suite with injected SDK events', async () => {
    const results = await runAdapterConformanceSuite((scenario) => conformanceFixture(scenario))
    expect(results.map((result) => result.scenario)).toEqual([
      'text',
      'tools',
      'truncated',
      'invalid-request',
      'rate-limit',
      'server-error',
      'interrupted-tool',
      'pre-aborted',
      'empty-response',
    ])
  })

  test('capabilities are truthful for Codex, Anthropic and Antigravity routes', () => {
    const adapter = new OmpPiAiAdapter({
      routes: {
        [CODEX_ROUTE]: { provider: 'openai-codex' },
        [ANTHROPIC_ROUTE]: { provider: 'anthropic' },
        [ANTIGRAVITY_ROUTE]: { provider: 'google-antigravity' },
      },
      authStorage: fakeAuthStorage(),
    })

    const codex = adapter.resolveCapabilities(CODEX_ROUTE, CODEX_MODEL)
    expect(codex.ok).toBe(true)
    if (!codex.ok) return
    expect(codex.value.supportsSamplingParams).toBe(false)
    expect(codex.value.supportsSamplingWhenThinking).toBe(false)
    expect(codex.value.supportsPenaltiesAndStop).toBe(false)
    expect(codex.value.canDisableReasoning).toBe(false)
    expect(codex.value.toolSchemaDialect).toBe('openai-responses')

    const anthropic = adapter.resolveCapabilities(ANTHROPIC_ROUTE, MODEL)
    expect(anthropic.ok).toBe(true)
    if (!anthropic.ok) return
    expect(anthropic.value.toolSchemaDialect).toBe('anthropic')
    expect(anthropic.value.systemPromptUpdate).toBe('leading-only')
    expect(anthropic.value.supportsSamplingParams).toBe(true)

    const antigravity = adapter.resolveCapabilities(ANTIGRAVITY_ROUTE, ANTIGRAVITY_MODEL)
    expect(antigravity.ok).toBe(true)
    if (!antigravity.ok) return
    expect(antigravity.value.toolSchemaDialect).toBe('google-gemini-cca')
  })

  test('lowercases only Google schema keyword positions before pi-ai', async () => {
    const probe = fetchProbe()
    let captured: PiAiContext | undefined
    const backend = async function* (
      model: PiModel,
      context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      captured = context
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: 'ok',
        partial: message(model, [textContent('ok')], 'stop'),
      }
      yield { type: 'done', reason: 'stop', message: message(model, [textContent('ok')], 'stop') }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ANTIGRAVITY_ROUTE]: { provider: 'google-antigravity' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    await streamThroughService(
      adapter,
      REQUEST,
      { tools: [TYPED_TOOL] },
      new AbortController().signal,
      ANTIGRAVITY_ROUTE,
      ANTIGRAVITY_MODEL,
    )
    const tool = captured?.tools?.[0]
    if (tool === undefined) throw new Error('converted tool missing')
    const schema = tool.parameters as {
      type?: string
      properties?: Record<string, { type?: string; properties?: Record<string, { type?: string }> }>
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['nested', 'type'])
    expect(schema.properties?.type?.type).toBe('string')
    expect(schema.properties?.nested?.type).toBe('object')
    expect(schema.properties?.nested?.properties?.kind?.type).toBe('string')
  })

  test('rejects unknown routes and unknown catalog models without inventing capabilities', () => {
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
    })
    const missingRoute = adapter.resolveCapabilities('missing' as RouteId, MODEL)
    expect(missingRoute.ok).toBe(false)
    if (!missingRoute.ok) expect(missingRoute.error.code).toBe('NO_ROUTE')
    const missingModel = adapter.resolveCapabilities(ROUTE, 'not-a-model' as ModelId)
    expect(missingModel.ok).toBe(false)
    if (!missingModel.ok) expect(missingModel.error.code).toBe('INVALID_ROUTE')
  })

  test('rejects a fetch after first-byte before it reaches the network', async () => {
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'partial',
        partial: message(model, [textContent('partial')], 'stop'),
      }
      try {
        await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      } catch {
        // The probe rejects before send; the backend observes the failure and
        // still tries to finish the original response.
      }
      yield {
        type: 'done',
        reason: 'stop',
        message: message(model, [textContent('partial')], 'stop'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') expect(finish.reason.failure.code).toBe('TRANSPORT')
    expect(finish.observedAttempts).toBe(1)
    expect(probe.calls()).toBe(1)
  })

  test('caller abort wins over unresolved credential resolution', async () => {
    const unresolved = Promise.withResolvers<string | undefined>().promise
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      resolveApiKey: () => unresolved,
    })
    const controller = new AbortController()
    const pending = streamThroughService(adapter, REQUEST, OVERRIDES, controller.signal)
    controller.abort()
    const chunks = await pending
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.observedAttempts).toBe(0)
  })

  test('redacts rotated credentials and credential-bearing request ids', async () => {
    const first = 'abcdef123456'
    const second = 'zyxwvu987654'
    const authStorage: OmpAuthStorageLike = {
      keys: {
        resolver: (): OmpApiKeyResolver => async (context) => (context.lastChance ? second : first),
      },
    }
    const backend = (
      _model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AssistantMessageEvent>> {
            const resolver = options.apiKey
            if (typeof resolver !== 'function') throw new Error('resolver missing')
            const signal = options.signal
            if (signal === undefined) throw new Error('signal missing')
            await resolver({ lastChance: false, error: undefined, signal })
            await resolver({
              lastChance: true,
              error: new Error('rotate'),
              previousKey: first,
              signal,
            })
            throw Object.assign(new Error(`provider echoed ${first} and ${second}`), {
              status: 401,
              requestId: `req-${second}`,
            })
          },
        }
      },
    })
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage,
      stream: backend,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('AUTH')
    expect(finish.reason.failure.message).not.toContain(first)
    expect(finish.reason.failure.message).not.toContain(second)
    expect(finish.reason.failure.requestId.kind).toBe('none')
  })

  test('preserves raw tool-call JSON byte-for-byte at block-end', async () => {
    const raw = '{\n  "key": "alpha",\n  "n": 1\n}'
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      const call = toolCall()
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: raw,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: call,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'done',
        reason: 'toolUse',
        message: message(model, [call], 'toolUse'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const block = chunks.find(
      (chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call',
    )
    expect(block?.type).toBe('block-end')
    if (block?.type === 'block-end' && block.block.type === 'tool-call') {
      expect(block.block.argumentsJson).toBe(raw)
    }
    expect(finishOf(chunks).reason.kind).toBe('tool-calls')
  })

  test('retains a partial raw tool prefix on length termination', async () => {
    const prefix = '{"key":"alpha","n":'
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      const call = toolCall()
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: prefix,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'done',
        reason: 'length',
        message: message(model, [call], 'length'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const block = chunks.find(
      (chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call',
    )
    expect(block?.type).toBe('block-end')
    if (block?.type === 'block-end' && block.block.type === 'tool-call') {
      expect(block.block.argumentsJson).toBe(prefix)
    }
    expect(finishOf(chunks).reason.kind).toBe('max-tokens')
  })

  test('rejects invalid raw tool JSON on a normal completion', async () => {
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      const call = toolCall()
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"key":',
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: call,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'done',
        reason: 'toolUse',
        message: message(model, [call], 'toolUse'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('MALFORMED_RESPONSE')
    }
  })

  test('does not synthesize empty tool arguments for unserializable objects', async () => {
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const call: PiAiToolCall = {
        type: 'toolCall',
        id: 'call_1',
        name: 'lookup',
        arguments: cyclic,
      }
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: message(model, [call], 'toolUse'),
      }
      yield {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: call,
        partial: message(model, [call], 'toolUse'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('MALFORMED_RESPONSE')
    }
    expect(chunks.some((chunk) => chunk.type === 'block-end')).toBe(false)
  })

  test('stitches a split UTF-16 surrogate pair across text deltas', async () => {
    const high = '\ud83c'
    const low = '\udf0f'
    const combined = `${high}${low}`
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: high,
        partial: message(model, [textContent(high)], 'stop'),
      }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: low,
        partial: message(model, [textContent(combined)], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: combined,
        partial: message(model, [textContent(combined)], 'stop'),
      }
      yield {
        type: 'done',
        reason: 'stop',
        message: message(model, [textContent(combined)], 'stop'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const deltas = chunks.filter((chunk) => chunk.type === 'text-delta')
    expect(deltas.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : '')).join('')).toBe(
      combined,
    )
    expect(finishOf(chunks).reason.kind).toBe('stop')
  })

  test('rejects an unmatched low surrogate delta as MALFORMED_RESPONSE', async () => {
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: '\udf0f',
        partial: message(model, [textContent('\udf0f')], 'stop'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('MALFORMED_RESPONSE')
    }
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false)
  })

  test('rejects an unmatched high surrogate tail at closure', async () => {
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: '\ud83c',
        partial: message(model, [textContent('\ud83c')], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: '\ud83c',
        partial: message(model, [textContent('\ud83c')], 'stop'),
      }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const chunks = await streamThroughService(adapter, REQUEST)
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') {
      expect(finish.reason.failure.code).toBe('MALFORMED_RESPONSE')
    }
  })

  test('anchors cache breakpoints only on static system and warm history', async () => {
    let outbound: unknown
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      outbound = await options.onPayload?.(
        {
          system: [
            { type: 'text', text: 'Use lookup.' },
            { type: 'text', text: 'Be brief.' },
          ],
          tools: [{ name: 'lookup', cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Find alpha' },
                { type: 'text', text: '\n\n<turn-context>\nprivate-turn-context\n</turn-context>' },
              ],
            },
          ],
        },
        model,
      )
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: 'ok',
        partial: message(model, [textContent('ok')], 'stop'),
      }
      yield { type: 'done', reason: 'stop', message: message(model, [textContent('ok')], 'stop') }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    await streamThroughService(adapter, REQUEST, { ...OVERRIDES, cacheRetention: 'short' })
    const payload = outbound as {
      system: Record<string, unknown>[]
      tools: Record<string, unknown>[]
      messages: { content: Record<string, unknown>[] }[]
    }
    expect(payload.system[0]).not.toHaveProperty('cache_control')
    expect(payload.system[1]).toHaveProperty('cache_control')
    expect(payload.tools[0]).not.toHaveProperty('cache_control')
    expect(payload.messages[0]?.content[0]).toHaveProperty('cache_control')
    expect(payload.messages[0]?.content[1]).not.toHaveProperty('cache_control')
  })

  test('replays same-origin signed thinking and tool calls, dropping foreign envelopes', async () => {
    let firstRun = true
    const contexts: PiAiContext[] = []
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      contexts.push(context)
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      if (firstRun) {
        firstRun = false
        const call = toolCall()
        const thinking = { type: 'thinking' as const, thinking: 'Find the record.' }
        const signed = { ...thinking, thinkingSignature: 'sig-1' }
        yield { type: 'start', partial: message(model, [], 'stop') }
        yield {
          type: 'thinking_start',
          contentIndex: 0,
          partial: message(model, [thinking], 'stop'),
        }
        yield {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'Find the record.',
          partial: message(model, [thinking], 'stop'),
        }
        yield {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'Find the record.',
          partial: message(model, [signed], 'stop'),
        }
        yield {
          type: 'toolcall_start',
          contentIndex: 1,
          partial: message(model, [signed, call], 'toolUse'),
        }
        yield {
          type: 'toolcall_delta',
          contentIndex: 1,
          delta: '{"key":"alpha"}',
          partial: message(model, [signed, call], 'toolUse'),
        }
        yield {
          type: 'toolcall_end',
          contentIndex: 1,
          toolCall: call,
          partial: message(model, [signed, call], 'toolUse'),
        }
        yield {
          type: 'done',
          reason: 'toolUse',
          message: message(model, [signed, call], 'toolUse'),
        }
        return
      }
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: 'done',
        partial: message(model, [textContent('done')], 'stop'),
      }
      yield { type: 'done', reason: 'stop', message: message(model, [textContent('done')], 'stop') }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const first = await streamThroughService(adapter, REQUEST)
    const firstFinish = finishOf(first)
    expect(firstFinish.reason.kind).toBe('tool-calls')
    if (!isSome(firstFinish.replayState)) throw new Error('replay state missing')
    const replayState: ReplayEnvelope = firstFinish.replayState.value
    const blocks: NeutralContentBlock[] = []
    for (const chunk of first) if (chunk.type === 'block-end') blocks.push(chunk.block)
    const call = blocks.find(
      (block): block is Extract<NeutralContentBlock, { type: 'tool-call' }> =>
        block.type === 'tool-call',
    )
    if (call === undefined) throw new Error('tool call missing')
    const assistant: NeutralAssistantMessage = {
      role: 'assistant',
      content: blocks,
      origin: { routeId: ROUTE, modelId: MODEL, replayState: some(replayState) },
    }
    const toolResult = {
      role: 'tool-result' as const,
      toolCallId: call.id,
      toolName: call.name,
      content: '{"found":true}',
      isError: false,
    }
    const followup: CacheAlignedChatRequest = {
      ...REQUEST,
      segment2WarmHistory: [...REQUEST.segment2WarmHistory, assistant, toolResult],
    }
    await streamThroughService(adapter, followup)
    const secondContext = contexts[1]
    if (secondContext === undefined) throw new Error('second context missing')
    const replayAssistant = secondContext.messages[1]
    if (replayAssistant?.role !== 'assistant') throw new Error('assistant replay missing')
    const replayThinking = replayAssistant.content.find((block) => block.type === 'thinking')
    expect(replayThinking).toMatchObject({ type: 'thinking', thinkingSignature: 'sig-1' })
    const replayCall = replayAssistant.content.find((block) => block.type === 'toolCall')
    expect(replayCall).toMatchObject({ type: 'toolCall', id: 'call_1', name: 'lookup' })

    const foreignAssistant: NeutralAssistantMessage = {
      ...assistant,
      origin: {
        routeId: ROUTE,
        modelId: 'another-model' as ModelId,
        replayState: some(replayState),
      },
    }
    const foreign: CacheAlignedChatRequest = {
      ...REQUEST,
      segment2WarmHistory: [...REQUEST.segment2WarmHistory, foreignAssistant, toolResult],
    }
    await streamThroughService(adapter, foreign)
    const thirdContext = contexts[2]
    if (thirdContext === undefined) throw new Error('third context missing')
    const foreignAssistantMessage = thirdContext.messages[1]
    if (foreignAssistantMessage?.role !== 'assistant') throw new Error('assistant replay missing')
    const foreignThinking = foreignAssistantMessage.content.find(
      (block) => block.type === 'thinking',
    )
    expect(foreignThinking).toBeDefined()
    expect(foreignThinking).toMatchObject({ type: 'thinking', thinking: 'Find the record.' })
    expect(foreignThinking).not.toHaveProperty('thinkingSignature')
  })

  test('discards damaged same-origin replay metadata instead of forwarding it to pi-ai', async () => {
    const contexts: PiAiContext[] = []
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      contexts.push(context)
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      const visible = textContent('ok')
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: 'ok',
        partial: message(model, [visible], 'stop'),
      }
      yield { type: 'done', reason: 'stop', message: message(model, [visible], 'stop') }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const content: NeutralContentBlock[] = [
      { type: 'text', text: 'Answer' },
      { type: 'reasoning', text: 'Plan' },
      {
        type: 'tool-call',
        id: 'call_1' as ToolCallId,
        name: 'lookup',
        argumentsJson: '{"key":"alpha"}',
      },
    ]
    const envelopeFor = (
      blocks: readonly unknown[],
      options: {
        readonly adapterKind?: string
        readonly version?: number
        readonly responseVersion?: number
        readonly provider?: string
        readonly model?: string
        readonly extraContent?: readonly unknown[]
      } = {},
    ): ReplayEnvelope => ({
      adapterKind: options.adapterKind ?? OMP_PI_AI_ADAPTER_KIND,
      version: options.version ?? 1,
      response: {
        version: options.responseVersion ?? 1,
        provider: options.provider ?? 'anthropic',
        model: options.model ?? MODEL,
        api: 'anthropic-messages',
        ...(options.extraContent === undefined ? {} : { extraContent: options.extraContent }),
      },
      blocks,
    })
    const replayedAssistant = async (
      replayState: ReplayEnvelope,
      options: {
        readonly routeId?: RouteId
        readonly content?: readonly NeutralContentBlock[]
      } = {},
    ): Promise<PiAiMessage> => {
      const assistant: NeutralAssistantMessage = {
        role: 'assistant',
        content: options.content ?? content,
        origin: {
          routeId: options.routeId ?? ROUTE,
          modelId: MODEL,
          replayState: some(replayState),
        },
      }
      contexts.length = 0
      await streamThroughService(adapter, {
        ...REQUEST,
        segment2WarmHistory: [...REQUEST.segment2WarmHistory, assistant],
      })
      const context = contexts[0]
      if (context === undefined) throw new Error('context missing')
      const replayed = context.messages[1]
      if (replayed?.role !== 'assistant') throw new Error('assistant replay missing')
      return replayed
    }
    const expectNeutral = (replayed: PiAiMessage): void => {
      expect(JSON.stringify(replayed)).not.toMatch(/sig-|enc-/)
      expect(replayed.content[0]).toEqual({ type: 'text', text: 'Answer' })
      expect(replayed.content[1]).toEqual({ type: 'thinking', thinking: 'Plan' })
      expect(replayed.content[2]).toEqual({
        type: 'toolCall',
        id: 'call_1',
        name: 'lookup',
        arguments: { key: 'alpha' },
      })
    }

    // Control: well-typed same-origin metadata is what the damaged cases must lose.
    const providerMetadata: NonNullable<PiAiToolCall['providerMetadata']> = {
      type: 'computer',
      providerItemId: 'computer_1',
      actions: [],
      pendingSafetyChecks: [],
    }
    const signed = envelopeFor([
      { textSignature: 'sig-text' },
      { thinkingSignature: 'sig-thinking', itemId: 'item_1', summary: true },
      {
        thoughtSignature: 'sig-call',
        customWireName: 'apply_patch',
        providerMetadata,
      },
    ])
    const signedReplay = await replayedAssistant(signed)
    expect(signedReplay.content[0]).toEqual({
      type: 'text',
      text: 'Answer',
      textSignature: 'sig-text',
    })
    expect(signedReplay.content[1]).toEqual({
      type: 'thinking',
      thinking: 'Plan',
      thinkingSignature: 'sig-thinking',
      itemId: 'item_1',
      summary: true,
    })
    expect(signedReplay.content[2]).toEqual({
      type: 'toolCall',
      id: 'call_1',
      name: 'lookup',
      arguments: { key: 'alpha' },
      thoughtSignature: 'sig-call',
      customWireName: 'apply_patch',
      providerMetadata,
    })

    for (const damaged of [
      envelopeFor(signed.blocks ?? [], { adapterKind: 'direct:anthropic' }),
      envelopeFor(signed.blocks ?? [], { version: 2 }),
      envelopeFor(signed.blocks ?? [], { responseVersion: 2 }),
      envelopeFor(signed.blocks ?? [], { provider: 'openai' }),
      envelopeFor(signed.blocks ?? [], { model: 'claude-other' }),
    ]) {
      expectNeutral(await replayedAssistant(damaged))
    }

    // Wrong field types invalidate the whole envelope, never just one field.
    expectNeutral(
      await replayedAssistant(
        envelopeFor([
          { textSignature: 42, thinkingSignature: 'sig-wrong-field' },
          { thinkingSignature: 7, redacted: {}, itemId: 9, summary: 'yes' },
          { thoughtSignature: false, customWireName: 5, providerMetadata: 'raw' },
        ]),
      ),
    )

    // Same-length metadata swapped across block kinds replays nothing.
    const swapped = await replayedAssistant(
      envelopeFor([
        { thoughtSignature: 'sig-swapped-call' },
        { thinkingSignature: 'sig-swapped-thinking' },
      ]),
      {
        content: [
          { type: 'reasoning', text: 'Plan' },
          {
            type: 'tool-call',
            id: 'call_1' as ToolCallId,
            name: 'lookup',
            argumentsJson: '{"key":"alpha"}',
          },
        ],
      },
    )
    expect(JSON.stringify(swapped)).not.toContain('sig-swapped')
    expect(swapped.content).toEqual([
      { type: 'thinking', thinking: 'Plan' },
      { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { key: 'alpha' } },
    ])

    expectNeutral(await replayedAssistant(signed, { routeId: 'omp:other' as RouteId }))

    // Response-level extra content restores only when it matches an SDK variant.
    const imageExtra = {
      beforeBlockIndex: 0,
      block: { type: 'image', data: 'aGk=', mimeType: 'image/png' },
    }
    const withExtra = await replayedAssistant(
      envelopeFor(signed.blocks ?? [], { extraContent: [imageExtra] }),
    )
    expect(withExtra.content[0]).toEqual({ type: 'image', data: 'aGk=', mimeType: 'image/png' })
    expect(withExtra.content[1]).toEqual({
      type: 'text',
      text: 'Answer',
      textSignature: 'sig-text',
    })

    const serverToolExtra = {
      beforeBlockIndex: 0,
      block: {
        type: 'anthropicServerTool',
        block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search' },
      },
    } as const
    const withServerTool = await replayedAssistant(
      envelopeFor(signed.blocks ?? [], { extraContent: [serverToolExtra] }),
    )
    expect(withServerTool.content[0]).toEqual(serverToolExtra.block)

    for (const extraContent of [
      [
        {
          beforeBlockIndex: 0,
          block: { type: 'thinking', thinking: 'leak', thinkingSignature: 42 },
        },
      ],
      [{ beforeBlockIndex: 0, block: { type: 'image', data: 'aGk=' } }],
      [
        {
          beforeBlockIndex: 0,
          block: { type: 'anthropicServerTool', block: { type: 'web_search_tool_result' } },
        },
      ],
      [
        {
          beforeBlockIndex: 0,
          block: { type: 'fallback', from: { model: 1 }, to: { model: 'x' } },
        },
      ],
      [
        {
          beforeBlockIndex: 0,
          block: {
            type: 'anthropicServerTool',
            block: { type: 'server_tool_use', id: 's1', name: 'other' },
          },
        },
      ],
      [{ beforeBlockIndex: 0, block: { type: 'toolCall', id: 'leak', name: 'lookup' } }],
      [{ beforeBlockIndex: 0, block: 'leak' }],
      [
        {
          beforeBlockIndex: 0,
          block: { type: 'image', data: 'aGk=', mimeType: 'image/png', detail: 'uber' },
        },
      ],
    ]) {
      const replayed = await replayedAssistant(envelopeFor(signed.blocks ?? [], { extraContent }))
      expectNeutral(replayed)
      expect(JSON.stringify(replayed)).not.toContain('leak')
    }
  })

  test('counts every injected transport attempt and ignores auxiliary traffic', async () => {
    const probe = fetchProbe()
    const backend = async function* (
      model: PiModel,
      _context: PiAiContext,
      options: SimpleStreamOptions,
    ): AsyncIterable<AssistantMessageEvent> {
      const fetchImpl = options.fetch
      if (fetchImpl === undefined) throw new Error('fetch probe missing')
      await fetchImpl('https://omp.test/oauth/token', { method: 'POST' })
      await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
      await fetchImpl('https://omp.test/v1/responses', { method: 'POST' })
      options.onSseEvent?.({ event: null, data: '', raw: [': ws → response.create'] }, model)
      const visible = textContent('ok')
      yield { type: 'start', partial: message(model, [], 'stop') }
      yield {
        type: 'text_start',
        contentIndex: 0,
        partial: message(model, [textContent('')], 'stop'),
      }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: 'ok',
        partial: message(model, [visible], 'stop'),
      }
      yield { type: 'done', reason: 'stop', message: message(model, [visible], 'stop') }
    }
    const adapter = new OmpPiAiAdapter({
      routes: { [ROUTE]: { provider: 'anthropic' } },
      authStorage: fakeAuthStorage(),
      stream: backend,
      fetch: probe.fetch,
    })
    const finish = finishOf(await streamThroughService(adapter, REQUEST))
    expect(finish.reason.kind).toBe('stop')
    expect(finish.observedAttempts).toBe(3)
    expect(probe.calls()).toBe(3)
  })

  test('rejects post-commit onResponse and websocket replays before another attempt', async () => {
    const replays: readonly ((options: SimpleStreamOptions, model: PiModel) => void)[] = [
      (options, model) => {
        options.onResponse?.({ status: 200, headers: {} }, model)
      },
      (options, model) => {
        options.onSseEvent?.({ event: null, data: '', raw: [': ws → response.create'] }, model)
      },
    ]
    for (const inject of replays) {
      const probe = fetchProbe()
      const backend = async function* (
        model: PiModel,
        _context: PiAiContext,
        options: SimpleStreamOptions,
      ): AsyncIterable<AssistantMessageEvent> {
        const fetchImpl = options.fetch
        if (fetchImpl === undefined) throw new Error('fetch probe missing')
        await fetchImpl('https://omp.test/v1/messages', { method: 'POST' })
        const partial = message(model, [textContent('partial')], 'stop')
        yield { type: 'start', partial: message(model, [], 'stop') }
        yield {
          type: 'text_start',
          contentIndex: 0,
          partial: message(model, [textContent('')], 'stop'),
        }
        yield { type: 'text_delta', contentIndex: 0, delta: 'partial', partial }
        inject(options, model)
        yield { type: 'done', reason: 'stop', message: partial }
      }
      const adapter = new OmpPiAiAdapter({
        routes: { [ROUTE]: { provider: 'anthropic' } },
        authStorage: fakeAuthStorage(),
        stream: backend,
        fetch: probe.fetch,
      })
      const finish = finishOf(await streamThroughService(adapter, REQUEST))
      expect(finish.reason.kind).toBe('error')
      if (finish.reason.kind === 'error') expect(finish.reason.failure.code).toBe('TRANSPORT')
      expect(finish.observedAttempts).toBe(1)
      expect(finish.replayState.kind).toBe('none')
      expect(probe.calls()).toBe(1)
    }
  })

  test('production defaults resolve the installed catalog and bind without network on abort', async () => {
    const adapter = new OmpPiAiAdapter({
      routes: { [CODEX_ROUTE]: { provider: 'openai-codex' } },
      authStorage: fakeAuthStorage(),
    })
    expect(adapter.adapterKind).toBe(OMP_PI_AI_ADAPTER_KIND)
    expect(adapter.retryOwnership).toBe('adapter-managed-transport-and-auth')
    const model = ompDefaultModelResolver('openai-codex', 'gpt-5.6-sol')
    expect(model?.provider).toBe('openai-codex')
    const controller = new AbortController()
    controller.abort()
    const chunks = await streamThroughService(
      adapter,
      REQUEST,
      OVERRIDES,
      controller.signal,
      CODEX_ROUTE,
      CODEX_MODEL,
    )
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.observedAttempts).toBe(0)
  })
})
