import { describe, expect, test } from 'bun:test'
import { isSome, NONE, some } from '@sekaisen/core'
import {
  DirectChatAdapter,
  DirectEmbeddingAdapter,
  DirectRerankAdapter,
} from '../packages/plugin-llm/src/direct/adapter.ts'
import { completionsEngine } from '../packages/plugin-llm/src/direct/completions.ts'
import type {
  DirectAdapterOptions,
  DirectFetch,
  DirectRouteConfig,
  SseEvent,
} from '../packages/plugin-llm/src/direct/contract.ts'
import { geminiEngine } from '../packages/plugin-llm/src/direct/gemini.ts'
import { responsesEngine } from '../packages/plugin-llm/src/direct/responses.ts'
import type {
  ModelCapabilities,
  PreparedChatCallSnapshot,
} from '../packages/plugin-llm/src/service-types.ts'
import { guardStream, StreamProtocolGuard } from '../packages/plugin-llm/src/stream.ts'
import type {
  CacheAlignedChatRequest,
  DisjointTokenUsage,
  ModelId,
  NeutralAssistantMessage,
  NeutralMessage,
  ProviderRequestId,
  RouteId,
  StreamChunk,
} from '../packages/plugin-llm/src/types.ts'
import { failure } from '../packages/plugin-llm/src/utils.ts'

const ROUTE = 'fixture' as RouteId
const MODEL = 'fixture-model' as ModelId
const CACHE_MODEL = 'anthropic/claude-fixture' as ModelId

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                 */
/* -------------------------------------------------------------------------- */

function capabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    contextWindow: 1_000,
    maxOutputTokens: 256,
    supportedEfforts: ['low', 'medium', 'high'],
    canDisableReasoning: true,
    supportsSamplingWhenThinking: true,
    supportsSamplingParams: true,
    supportsPenaltiesAndStop: true,
    forcedToolChoiceSupport: 'named',
    disableReasoningOnForcedToolChoice: false,
    systemPromptUpdate: 'leading-only',
    toolSchemaDialect: 'openai-strict',
    ...overrides,
  }
}

const emptyRequest: CacheAlignedChatRequest = {
  segment1Static: [],
  segment2WarmHistory: [],
  segment3VolatileTail: NONE,
  sharedPrefixKey: NONE,
}

interface SnapshotOptions {
  readonly request?: CacheAlignedChatRequest
  readonly sampling?: Partial<PreparedChatCallSnapshot['sampling']>
  readonly modelId?: ModelId
}

function snapshot(options: SnapshotOptions = {}): PreparedChatCallSnapshot {
  return {
    routeId: ROUTE,
    modelId: options.modelId ?? MODEL,
    retryOwnership: 'caller-owned-single-attempt',
    capabilities: capabilities(),
    request: options.request ?? emptyRequest,
    tools: [],
    effectiveEffort: 'off',
    effectiveToolChoice: { kind: 'auto' },
    downgradedToolChoice: false,
    sampling: {
      temperature: NONE,
      topP: NONE,
      frequencyPenalty: NONE,
      presencePenalty: NONE,
      stopSequences: [],
      maxOutputTokens: NONE,
      cacheRetention: 'none',
      sessionAffinityKey: NONE,
      ...options.sampling,
    },
  }
}

function routeConfig(overrides: Partial<DirectRouteConfig> = {}): DirectRouteConfig {
  return {
    protocol: 'openai-completions',
    baseURL: 'https://fixture.invalid',
    authMode: 'none',
    ...overrides,
  }
}

function chatAdapter(
  fetchImpl: DirectFetch,
  routeOverrides: Partial<DirectRouteConfig> = {},
  resolveCredential?: (reference: string) => string | undefined,
): DirectChatAdapter {
  return new DirectChatAdapter({
    routes: { fixture: { ...routeConfig(), ...routeOverrides } },
    fetch: fetchImpl,
    ...(resolveCredential === undefined ? {} : { resolveCredential }),
  })
}

function boundStream(
  adapter: DirectChatAdapter,
  request: PreparedChatCallSnapshot,
  signal: AbortSignal = new AbortController().signal,
): AsyncIterable<StreamChunk> {
  const bound = adapter.bindGeneration(request.routeId, request.modelId)
  if (!bound.ok) throw new Error(`bindGeneration failed: ${bound.error.message}`)
  return bound.value({ snapshot: request }, signal)
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

function lastFinish(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.at(-1)
  if (finish === undefined || finish.type !== 'finish') {
    throw new Error('stream did not end with a finish frame')
  }
  return finish
}

function usageFrame(chunks: readonly StreamChunk[]): DisjointTokenUsage | undefined {
  const frame = chunks.find((chunk) => chunk.type === 'usage')
  return frame?.type === 'usage' ? frame.usage : undefined
}

/** Feed the raw decoder output through the real protocol guard. */
function guardAccepts(chunks: readonly StreamChunk[]): void {
  const guard = new StreamProtocolGuard()
  for (const chunk of chunks) guard.accept(chunk)
  expect(guard.phase).toBe('finished')
}

function expectCanonicalZero(value: unknown): void {
  expect(typeof value).toBe('number')
  expect(Object.is(value, 0)).toBe(true)
}

async function* eventsOf(payloads: readonly unknown[]): AsyncGenerator<SseEvent> {
  for (const payload of payloads) yield { event: 'message', data: JSON.stringify(payload) }
}

/* -------------------------------------------------------------------------- */
/*                        cache-aligned completions history                  */
/* -------------------------------------------------------------------------- */

describe('direct completions cache-aligned history', () => {
  const userHello: NeutralMessage = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  const assistantReply: NeutralAssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'reply' }],
    origin: { routeId: ROUTE, modelId: CACHE_MODEL, replayState: NONE },
  }
  const userNext: NeutralMessage = { role: 'user', content: [{ type: 'text', text: 'next' }] }

  function messagesOf(request: CacheAlignedChatRequest): readonly Record<string, unknown>[] {
    const built = completionsEngine.build(
      snapshot({
        request,
        modelId: CACHE_MODEL,
        sampling: { cacheRetention: 'short' },
      }),
      routeConfig({ gateway: 'openrouter' }),
    )
    return built.body.messages as readonly Record<string, unknown>[]
  }

  test('cache-enabled last user merges the volatile tail as an unmarked block', () => {
    const messages = messagesOf({
      ...emptyRequest,
      segment1Static: [{ name: 'rules', text: 'Be terse.' }],
      segment2WarmHistory: [userHello],
      segment3VolatileTail: some('now'),
    })

    expect(messages.map((message) => message.role)).toEqual(['system', 'user'])
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n<turn-context>now</turn-context>' },
    ])
  })

  test('cache-enabled prefixes keep their block-array shape across warm turns', () => {
    const turnA = messagesOf({
      ...emptyRequest,
      segment1Static: [{ name: 'rules', text: 'Be terse.' }],
      segment2WarmHistory: [userHello],
      segment3VolatileTail: some('now'),
    })
    const turnB = messagesOf({
      ...emptyRequest,
      segment1Static: [{ name: 'rules', text: 'Be terse.' }],
      segment2WarmHistory: [userHello, assistantReply, userNext],
      segment3VolatileTail: some('later'),
    })

    expect(turnB.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    // The first turn's warm block is the same text block; only the marker moved.
    expect((turnA[1]?.content as readonly unknown[] | undefined)?.[0]).toEqual({
      type: 'text',
      text: 'hello',
      cache_control: { type: 'ephemeral' },
    })
    expect(turnB[1]?.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(turnB[2]?.content).toEqual([{ type: 'text', text: 'reply' }])
    expect(turnB[3]?.content).toEqual([
      { type: 'text', text: 'next', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n<turn-context>later</turn-context>' },
    ])

    const markers = turnB.flatMap((message) => {
      const content = message.content
      return Array.isArray(content)
        ? content.filter((block) => Object.hasOwn(block as object, 'cache_control'))
        : []
    })
    // System prefix plus the warm end only: the volatile block stays uncached.
    expect(markers).toHaveLength(2)
  })

  test('non-cache channels keep plain string history and string volatile merging', () => {
    const built = completionsEngine.build(
      snapshot({ request: { ...emptyRequest, segment2WarmHistory: [userHello] } }),
      routeConfig(),
    )
    const messages = built.body.messages as readonly Record<string, unknown>[]
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])

    const withTail = completionsEngine.build(
      snapshot({
        request: {
          ...emptyRequest,
          segment2WarmHistory: [userHello],
          segment3VolatileTail: some('now'),
        },
      }),
      routeConfig(),
    )
    const tailMessages = withTail.body.messages as readonly Record<string, unknown>[]
    expect(tailMessages).toEqual([
      { role: 'user', content: 'hello\n\n<turn-context>now</turn-context>' },
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*                         transport dispatch boundary                       */
/* -------------------------------------------------------------------------- */

describe('direct transport dispatch boundary', () => {
  const canary = 'sk-sync-fetch-secret-314159'

  test('synchronous fetch throw becomes one sanitized terminal failure', async () => {
    const fetchImpl = (() => {
      throw new Error(`socket construction failed with ${canary}`)
    }) as unknown as DirectFetch
    const adapter = chatAdapter(
      fetchImpl,
      { authMode: 'bearer', credentialRef: 'CANARY_KEY' },
      () => canary,
    )

    // Raw bound executor: the throw must not escape the generator.
    const raw = await collect(boundStream(adapter, snapshot()))
    expect(raw).toHaveLength(1)
    const finish = lastFinish(raw)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('TRANSPORT')
    expect(finish.reason.failure.message).not.toContain(canary)
    expect(finish.reason.failure.message).toContain('[redacted]')
    expect(finish.reason.failure.requestId).toEqual(NONE)
    expect(finish.observedAttempts).toBe(1)

    // Service path: the sanitized terminal frame also satisfies the guard.
    const guarded = await collect(
      guardStream(() => boundStream(adapter, snapshot()), new AbortController().signal),
    )
    const guardedFinish = lastFinish(guarded)
    expect(guardedFinish.reason.kind).toBe('error')
    if (guardedFinish.reason.kind !== 'error') return
    expect(guardedFinish.reason.failure.message).not.toContain(canary)
  })

  test('a thrown structured failure never echoes the credential in requestId', async () => {
    const thrown = failure('TRANSPORT', `upstream rejected ${canary}`, {
      requestId: some(canary as ProviderRequestId),
    })
    const fetchImpl = (() => {
      throw thrown
    }) as unknown as DirectFetch
    const adapter = chatAdapter(fetchImpl, {}, () => canary)
    const guard = new StreamProtocolGuard()

    for await (const chunk of boundStream(adapter, snapshot())) {
      expect(JSON.stringify(chunk)).not.toContain(canary)
      guard.accept(chunk)
    }
    expect(guard.phase).toBe('finished')
  })

  test('caller abort during a synchronous fetch throw keeps abort priority', async () => {
    const controller = new AbortController()
    const fetchImpl = (() => {
      controller.abort()
      throw new Error('transport exploded after cancellation')
    }) as unknown as DirectFetch
    const adapter = chatAdapter(fetchImpl)

    const chunks = await collect(boundStream(adapter, snapshot(), controller.signal))
    expect(chunks).toHaveLength(1)
    const finish = lastFinish(chunks)
    expect(finish.reason.kind).toBe('aborted')
    if (finish.reason.kind !== 'aborted') return
    expect(finish.reason.failure.code).toBe('ABORTED')
    // `fetch` was invoked, so the physical attempt is counted even though it
    // never returned a response.
    expect(finish.observedAttempts).toBe(1)
  })

  test('a synchronous AbortError without caller cancellation stays protocol-legal', async () => {
    const fetchImpl = (() => {
      throw Object.assign(new Error('internal transport abort'), { name: 'AbortError' })
    }) as unknown as DirectFetch
    const chunks = await collect(boundStream(chatAdapter(fetchImpl), snapshot()))
    const finish = lastFinish(chunks)
    expect(finish.reason.kind).toBe('aborted')
    if (finish.reason.kind !== 'aborted') return
    expect(finish.reason.failure.code).toBe('ABORTED')
    expect(finish.observedAttempts).toBe(1)
    guardAccepts(chunks)
  })

  test('a thrown failure with out-of-range details is sanitized instead of escaping', async () => {
    const fetchImpl = (() => {
      throw {
        code: 'TRANSPORT',
        message: `upstream reported ${canary}`,
        status: some(-0),
        retryAfterMs: some(Number.POSITIVE_INFINITY),
        requestId: some(canary as ProviderRequestId),
      }
    }) as unknown as DirectFetch
    const chunks = await collect(boundStream(chatAdapter(fetchImpl), snapshot()))
    expect(chunks).toHaveLength(1)
    const finish = lastFinish(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('TRANSPORT')
    expect(finish.reason.failure.status).toEqual(NONE)
    expect(finish.reason.failure.retryAfterMs).toEqual(NONE)
    expect(finish.reason.failure.requestId).toEqual(NONE)
    expect(finish.reason.failure.message).not.toContain(canary)
    expect(finish.observedAttempts).toBe(1)
    guardAccepts(chunks)
  })
})

/* -------------------------------------------------------------------------- */
/*                            usage boundary guards                          */
/* -------------------------------------------------------------------------- */

function responsesFrames(usage: Record<string, unknown>): readonly unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'hi' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hi', annotations: [] }],
      },
    },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage } },
  ]
}

async function responsesChunks(usage: Record<string, unknown>): Promise<StreamChunk[]> {
  return collect(
    responsesEngine.decode(
      eventsOf(responsesFrames(usage)),
      snapshot(),
      routeConfig({ protocol: 'openai-responses' }),
    ),
  )
}

function geminiFrames(usage: Record<string, unknown>): readonly unknown[] {
  return [
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hi' }] } }] },
    { candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: usage },
  ]
}

async function geminiChunks(usage: Record<string, unknown>): Promise<StreamChunk[]> {
  return collect(
    geminiEngine.decode(
      eventsOf(geminiFrames(usage)),
      snapshot(),
      routeConfig({ protocol: 'google-gemini' }),
    ),
  )
}

function completionsFrames(usage: Record<string, unknown>): readonly unknown[] {
  return [
    { choices: [{ index: 0, delta: { content: 'hi' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
    '[DONE]',
  ]
}

async function completionsChunks(usage: Record<string, unknown>): Promise<StreamChunk[]> {
  const events: SseEvent[] = completionsFrames(usage).map((payload) => ({
    event: 'message',
    data: typeof payload === 'string' ? payload : JSON.stringify(payload),
  }))
  return collect(
    completionsEngine.decode(
      (async function* () {
        yield* events
      })(),
      snapshot(),
      routeConfig(),
    ),
  )
}

describe('direct usage boundary', () => {
  test('responses drops malformed usage instead of crashing the guard', async () => {
    const malformed: readonly Record<string, unknown>[] = [
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 1e300, output_tokens: 2 },
      { input_tokens: 1, output_tokens: 1e300 },
      { input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: -3 } },
      { input_tokens: 1, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1e300 } },
      { input_tokens: 1, output_tokens: 2, cost: -0.5 },
      { input_tokens: '4', output_tokens: 2 },
    ]
    for (const usage of malformed) {
      const chunks = await responsesChunks(usage)
      expect(usageFrame(chunks)).toBeUndefined()
      guardAccepts(chunks)
      expect(lastFinish(chunks).reason).toEqual({ kind: 'stop' })
    }
  })

  test('responses normalizes fractional usage to safe counts and canonical zero', async () => {
    const chunks = await responsesChunks({
      input_tokens: 12.4,
      input_tokens_details: { cached_tokens: 3.6 },
      output_tokens: 2.5,
      output_tokens_details: { reasoning_tokens: 1.5 },
      cost: 0,
    })
    const usage = usageFrame(chunks)
    if (usage === undefined) throw new Error('usage frame missing')
    expect(usage.inputUncachedTokens).toBe(8)
    expect(usage.cacheReadTokens).toBe(4)
    expect(usage.outputTokens).toBe(3)
    if (!isSome(usage.reasoningTokens)) throw new Error('reasoning usage missing')
    expect(usage.reasoningTokens.value).toBe(2)
    if (!isSome(usage.authoritativeCostUsd)) throw new Error('cost usage missing')
    expectCanonicalZero(usage.authoritativeCostUsd.value)
    guardAccepts(chunks)

    const zeroes = await responsesChunks({
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      cost: 0,
    })
    const zeroUsage = usageFrame(zeroes)
    if (zeroUsage === undefined) throw new Error('usage frame missing')
    expectCanonicalZero(zeroUsage.inputUncachedTokens)
    expectCanonicalZero(zeroUsage.cacheReadTokens)
    expectCanonicalZero(zeroUsage.cacheWriteTokens)
    expectCanonicalZero(zeroUsage.outputTokens)
    if (!isSome(zeroUsage.reasoningTokens)) throw new Error('reasoning usage missing')
    expectCanonicalZero(zeroUsage.reasoningTokens.value)
    if (!isSome(zeroUsage.authoritativeCostUsd)) throw new Error('cost usage missing')
    expectCanonicalZero(zeroUsage.authoritativeCostUsd.value)
    guardAccepts(zeroes)
  })

  test('gemini drops malformed usage and unsafe output sums', async () => {
    const malformed: readonly Record<string, unknown>[] = [
      { promptTokenCount: -1, candidatesTokenCount: 2 },
      { promptTokenCount: 1e300, candidatesTokenCount: 2 },
      { promptTokenCount: 1, candidatesTokenCount: 1e300 },
      { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: -1 },
      { promptTokenCount: 1, candidatesTokenCount: 2, cachedContentTokenCount: -1 },
      { promptTokenCount: 1, candidatesTokenCount: '2' },
      // candidates + thoughts exceeds the safe-integer range.
      {
        promptTokenCount: 5,
        cachedContentTokenCount: 0,
        candidatesTokenCount: Number.MAX_SAFE_INTEGER,
        thoughtsTokenCount: 1,
      },
    ]
    for (const usage of malformed) {
      const chunks = await geminiChunks(usage)
      expect(usageFrame(chunks)).toBeUndefined()
      guardAccepts(chunks)
      expect(lastFinish(chunks).reason).toEqual({ kind: 'stop' })
    }
  })

  test('gemini normalizes fractional usage and canonical zero', async () => {
    const chunks = await geminiChunks({
      promptTokenCount: 0,
      cachedContentTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
      totalTokenCount: 0,
    })
    const usage = usageFrame(chunks)
    if (usage === undefined) throw new Error('usage frame missing')
    expectCanonicalZero(usage.inputUncachedTokens)
    expectCanonicalZero(usage.cacheReadTokens)
    expectCanonicalZero(usage.cacheWriteTokens)
    expectCanonicalZero(usage.outputTokens)
    if (!isSome(usage.reasoningTokens)) throw new Error('reasoning usage missing')
    expectCanonicalZero(usage.reasoningTokens.value)
    guardAccepts(chunks)

    const fractional = await geminiChunks({
      promptTokenCount: 12.6,
      cachedContentTokenCount: 8.4,
      candidatesTokenCount: 4.4,
      thoughtsTokenCount: 1.6,
      totalTokenCount: 26.6,
    })
    const fractionalUsage = usageFrame(fractional)
    if (fractionalUsage === undefined) throw new Error('usage frame missing')
    expect(fractionalUsage.inputUncachedTokens).toBe(5)
    expect(fractionalUsage.cacheReadTokens).toBe(8)
    expect(fractionalUsage.outputTokens).toBe(6)
    guardAccepts(fractional)
  })

  test('completions omits malformed usage and emits canonical zero', async () => {
    for (const usage of [
      { prompt_tokens: -1, completion_tokens: 2 },
      { prompt_tokens: 1e300, completion_tokens: 2 },
      { prompt_tokens: 1, completion_tokens: 1e300 },
      { prompt_tokens: '4', completion_tokens: 2 },
    ]) {
      const chunks = await completionsChunks(usage)
      expect(usageFrame(chunks)).toBeUndefined()
      guardAccepts(chunks)
      expect(lastFinish(chunks).reason).toEqual({ kind: 'stop' })
    }

    // Invalid optional buckets are dropped from an otherwise usable record
    // rather than poisoning the whole usage frame.
    const partial = await completionsChunks({
      prompt_tokens: 1,
      completion_tokens: 2,
      prompt_cache_hit_tokens: -4,
      cost: -1,
    })
    const partialUsage = usageFrame(partial)
    if (partialUsage === undefined) throw new Error('usage frame missing')
    expect(partialUsage.cacheReadTokens).toBe(0)
    expect(partialUsage.authoritativeCostUsd).toEqual(NONE)
    guardAccepts(partial)

    const zeroes = await completionsChunks({
      prompt_tokens: 0,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
      cost: 0,
    })
    const usage = usageFrame(zeroes)
    if (usage === undefined) throw new Error('usage frame missing')
    expectCanonicalZero(usage.inputUncachedTokens)
    expectCanonicalZero(usage.cacheReadTokens)
    expectCanonicalZero(usage.cacheWriteTokens)
    expectCanonicalZero(usage.outputTokens)
    if (!isSome(usage.reasoningTokens)) throw new Error('reasoning usage missing')
    expectCanonicalZero(usage.reasoningTokens.value)
    if (!isSome(usage.authoritativeCostUsd)) throw new Error('cost usage missing')
    expectCanonicalZero(usage.authoritativeCostUsd.value)
    guardAccepts(zeroes)
  })
})

/* -------------------------------------------------------------------------- */
/*                           retrieval scalar boundary                       */
/* -------------------------------------------------------------------------- */

function retrievalAdapterOptions(fetchImpl: DirectFetch): DirectAdapterOptions {
  return {
    routes: { fixture: { ...routeConfig(), authMode: 'none' } },
    fetch: fetchImpl,
  }
}

async function embeddingResult(body: string) {
  const fetchImpl = (async () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as DirectFetch
  const adapter = new DirectEmbeddingAdapter(retrievalAdapterOptions(fetchImpl))
  return adapter.embed(ROUTE, MODEL, ['a'], { signal: new AbortController().signal })
}

describe('direct retrieval boundaries', () => {
  test('embedding usage canonicalizes -0 and omits malformed counts', async () => {
    const zero = await embeddingResult(
      '{"data":[{"index":0,"embedding":[0.5]}],"usage":{"prompt_tokens":-0}}',
    )
    if (!zero.ok) throw new Error(zero.error.code)
    if (!isSome(zero.value.totalPromptTokens)) throw new Error('usage missing')
    expectCanonicalZero(zero.value.totalPromptTokens.value)

    // Fractional provider counts are accepted via rounding, never rejected.
    const fractional = await embeddingResult(
      '{"data":[{"index":-0,"embedding":[0.5]}],"usage":{"prompt_tokens":12.6}}',
    )
    if (!fractional.ok) throw new Error(fractional.error.code)
    expect(fractional.value.totalPromptTokens).toEqual(some(13))

    for (const total of ['-1', '1e300', '"4"']) {
      const result = await embeddingResult(
        `{"data":[{"index":0,"embedding":[0.5]}],"usage":{"prompt_tokens":${total}}}`,
      )
      if (!result.ok) throw new Error(result.error.code)
      expect(result.value.totalPromptTokens).toEqual(NONE)
    }
  })

  test('rerank score indexes canonicalize -0 before service validation', async () => {
    const body =
      '{"results":[' + '{"index":-0,"relevance_score":0.9},' + '{"index":1,"relevance_score":0.1}]}'
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as DirectFetch
    const adapter = new DirectRerankAdapter(retrievalAdapterOptions(fetchImpl))
    const result = await adapter.rerank(ROUTE, MODEL, 'query', ['a', 'b'], {
      signal: new AbortController().signal,
    })
    if (!result.ok) throw new Error(result.error.code)
    expect(result.value).toHaveLength(2)
    expect(Object.is(result.value[0]?.index, 0)).toBe(true)
    expect(result.value[1]?.index).toBe(1)
  })
})
