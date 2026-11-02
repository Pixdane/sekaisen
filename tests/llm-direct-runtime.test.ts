import { describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import { Context } from 'cordis'
import {
  assertUsableApiKey,
  DirectChatAdapter,
  DirectEmbeddingAdapter,
  DirectRerankAdapter,
} from '../packages/plugin-llm/src/direct/adapter.ts'
import {
  completionsEngine,
  TemplateTokenFilter,
} from '../packages/plugin-llm/src/direct/completions.ts'
import type {
  DirectAdapterOptions,
  DirectFetch,
  DirectRouteConfig,
  SseEvent,
} from '../packages/plugin-llm/src/direct/contract.ts'
import {
  defineDirectRoute,
  GATEWAY_PRESETS,
  gatewayCapabilityPolicy,
} from '../packages/plugin-llm/src/direct/gateways.ts'
import { joinRequestURL, parseSseStream } from '../packages/plugin-llm/src/direct/transport.ts'
import { LlmService } from '../packages/plugin-llm/src/service.ts'
import type {
  ModelCapabilities,
  PreparedChatCallSnapshot,
} from '../packages/plugin-llm/src/service-types.ts'
import type { NormalizedWireToolSchema } from '../packages/plugin-llm/src/tool-schema.ts'
import { t } from '../packages/plugin-llm/src/tool-schema.ts'
import type {
  CacheAlignedChatRequest,
  ModelId,
  NeutralAssistantMessage,
  NeutralMessage,
  ProviderRequestId,
  ReplayEnvelope,
  RouteId,
  StreamChunk,
  ToolCallId,
} from '../packages/plugin-llm/src/types.ts'

const ROUTE = 'fixture' as RouteId
const MODEL = 'fixture-model' as ModelId

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
  readonly tools?: PreparedChatCallSnapshot['tools']
  readonly capabilities?: ModelCapabilities
  readonly sampling?: Partial<PreparedChatCallSnapshot['sampling']>
  readonly effort?: PreparedChatCallSnapshot['effectiveEffort']
  readonly toolChoice?: PreparedChatCallSnapshot['effectiveToolChoice']
  readonly modelId?: ModelId
  readonly routeId?: RouteId
}

function snapshot(options: SnapshotOptions = {}): PreparedChatCallSnapshot {
  return {
    routeId: options.routeId ?? ROUTE,
    modelId: options.modelId ?? MODEL,
    retryOwnership: 'caller-owned-single-attempt',
    capabilities: options.capabilities ?? capabilities(),
    request: options.request ?? emptyRequest,
    tools: options.tools ?? [],
    effectiveEffort: options.effort ?? 'off',
    effectiveToolChoice: options.toolChoice ?? { kind: 'auto' },
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
  resolveCredential?: DirectAdapterOptions['resolveCredential'],
): DirectChatAdapter {
  const route: DirectRouteConfig = { ...routeConfig(), ...routeOverrides }
  return new DirectChatAdapter({
    routes: { fixture: route },
    fetch: fetchImpl,
    ...(resolveCredential === undefined ? {} : { resolveCredential }),
  })
}

function retrievalAdapterOptions(
  fetchImpl: DirectFetch,
  routeOverrides: Partial<DirectRouteConfig> = {},
  resolveCredential?: DirectAdapterOptions['resolveCredential'],
): DirectAdapterOptions {
  return {
    routes: { fixture: { ...routeConfig(), ...routeOverrides } },
    fetch: fetchImpl,
    ...(resolveCredential === undefined ? {} : { resolveCredential }),
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) items.push(item)
  return items
}

function byteStream(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

interface ControlledStream {
  readonly stream: ReadableStream<Uint8Array>
  readonly push: (text: string) => void
  readonly close: () => void
}

function controlledStream(): ControlledStream {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner
    },
  })
  return {
    stream,
    push: (text) => controller?.enqueue(encoder.encode(text)),
    close: () => controller?.close(),
  }
}

function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function choiceFrame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return dataFrame({ choices: [{ index: 0, delta, finish_reason: finishReason }] })
}

function sseResponse(frames: string, status = 200): Response {
  return new Response(frames, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function* sseEvents(chunks: readonly (string | Uint8Array)[]): AsyncGenerator<SseEvent> {
  yield* parseSseStream(byteStream(chunks), new AbortController().signal, {
    firstEventTimeoutMs: 0,
    interEventTimeoutMs: 0,
  })
}

function lastChunk(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.at(-1)
  if (finish === undefined || finish.type !== 'finish') {
    throw new Error('stream did not end with a finish frame')
  }
  return finish
}

function boundStream(
  adapter: DirectChatAdapter,
  request: PreparedChatCallSnapshot,
  signal: AbortSignal = new AbortController().signal,
): AsyncIterable<StreamChunk> {
  const bound = adapter.bindGeneration(request.routeId, request.modelId)
  if (!bound.ok)
    throw new Error(`bindGeneration failed: ${bound.error.code}: ${bound.error.message}`)
  return bound.value({ snapshot: request }, signal)
}

/* -------------------------------------------------------------------------- */
/*                                 SSE parsing                               */
/* -------------------------------------------------------------------------- */

describe('direct SSE parsing', () => {
  test('handles CRLF, multiline data, comments, split UTF-8 and a final unterminated event', async () => {
    const text =
      'data: {"t":"\u00e9\u{1F600}"}\r\n\r\n: keep-alive\r\ndata: line1\ndata: line2\n\nevent: custom\ndata: tail'
    const bytes = new TextEncoder().encode(text)
    const emoji = new TextEncoder().encode('\u{1F600}')
    let split = -1
    for (let index = 0; index < bytes.length - emoji.length; index++) {
      if (emoji.every((byte, offset) => bytes[index + offset] === byte)) {
        split = index + 2
        break
      }
    }
    expect(split).toBeGreaterThan(0)
    const events = await collect(
      sseEvents([bytes.slice(0, split), bytes.slice(split, split + 1), bytes.slice(split + 1)]),
    )
    expect(events).toEqual([
      { event: 'message', data: '{"t":"\u00e9\u{1F600}"}' },
      { event: 'message', data: 'line1\nline2' },
      { event: 'custom', data: 'tail' },
    ])
  })

  test('CRLF split across two network chunks is one line terminator', async () => {
    const events = await collect(sseEvents(['data: a\r', '\ndata: b\r\n\r\n']))
    expect(events).toEqual([{ event: 'message', data: 'a\nb' }])
  })
})

/* -------------------------------------------------------------------------- */
/*                                 URL joining                               */
/* -------------------------------------------------------------------------- */

describe('direct URL joining', () => {
  test('never duplicates a version segment while preserving gateway prefixes', () => {
    expect(joinRequestURL('https://api.openai.com', '/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(joinRequestURL('https://api.openai.com/v1/', '/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(joinRequestURL('http://127.0.0.1:4096/v1', '/v1/messages')).toBe(
      'http://127.0.0.1:4096/v1/messages',
    )
    expect(joinRequestURL('https://openrouter.ai/api/v1', '/v1/responses')).toBe(
      'https://openrouter.ai/api/v1/responses',
    )
    expect(joinRequestURL('https://api.deepseek.com/anthropic', '/v1/messages')).toBe(
      'https://api.deepseek.com/anthropic/v1/messages',
    )
    expect(
      joinRequestURL(
        'https://generativelanguage.googleapis.com/v1beta',
        '/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
      ),
    ).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
    )
    expect(joinRequestURL('https://fixture.invalid/v10', '/v1/chat/completions')).toBe(
      'https://fixture.invalid/v10/v1/chat/completions',
    )
  })

  test('adapter with a /v1-suffixed base sends the endpoint exactly once', async () => {
    const urls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse(
        `${choiceFrame({ content: 'ok' }) + choiceFrame({}, 'stop')}data: [DONE]\n\n`,
      )
    }) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { baseURL: 'https://fixture.invalid/v1' })
    await collect(boundStream(adapter, snapshot()))
    expect(urls).toEqual(['https://fixture.invalid/v1/chat/completions'])
  })
})

/* -------------------------------------------------------------------------- */
/*                      single attempt and HTTP lifecycle                    */
/* -------------------------------------------------------------------------- */

describe('direct runtime single-attempt contract', () => {
  test('joins baseURL and wire path, injects x-api-key, finishes with observedAttempts 1', async () => {
    const calls: string[] = []
    let init: RequestInit | undefined
    const fetchImpl = (async (input: RequestInfo | URL, options?: RequestInit) => {
      calls.push(String(input))
      init = options
      return sseResponse(
        choiceFrame({ content: 'hi' }) +
          choiceFrame({}, 'stop') +
          dataFrame({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          }) +
          'data: [DONE]\n\n',
      )
    }) as DirectFetch
    const adapter = chatAdapter(
      fetchImpl,
      {
        baseURL: 'https://fixture.invalid/prefix/',
        authMode: 'x-api-key',
        credentialRef: 'TEST_KEY',
      },
      (reference) => (reference === 'TEST_KEY' ? '  sk-live-key  ' : undefined),
    )
    const chunks = await collect(boundStream(adapter, snapshot()))
    expect(calls).toEqual(['https://fixture.invalid/prefix/v1/chat/completions'])
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe('sk-live-key')
    expect(headers.get('authorization')).toBeNull()
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(chunks.filter((chunk) => chunk.type === 'first-byte')).toHaveLength(1)
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    expect(usage).toBeDefined()
    if (usage?.type === 'usage') {
      expect(usage.usage.inputUncachedTokens).toBe(6)
      expect(usage.usage.cacheReadTokens).toBe(4)
      expect(usage.usage.cacheWriteTokens).toBe(0)
      expect(usage.usage.outputTokens).toBe(2)
    }
    const finish = lastChunk(chunks)
    expect(finish.reason).toEqual({ kind: 'stop' })
    expect(finish.observedAttempts).toBe(1)
  })

  test('bearer auth mode sends Authorization and trims the credential', async () => {
    let headers: Headers | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, options?: RequestInit) => {
      headers = new Headers(options?.headers)
      return sseResponse(
        `${choiceFrame({ content: 'ok' }) + choiceFrame({}, 'stop')}data: [DONE]\n\n`,
      )
    }) as DirectFetch
    const adapter = chatAdapter(
      fetchImpl,
      { authMode: 'bearer', credentialRef: 'TEST_KEY' },
      () => 'sk-bearer-key',
    )
    await collect(boundStream(adapter, snapshot()))
    expect(headers?.get('authorization')).toBe('Bearer sk-bearer-key')
    expect(headers?.get('x-api-key')).toBeNull()
  })

  test('pre-aborted call performs no fetch and yields exactly one aborted finish', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return sseResponse('')
    }) as DirectFetch
    const adapter = chatAdapter(fetchImpl)
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect(boundStream(adapter, snapshot(), controller.signal))
    expect(calls).toBe(0)
    expect(chunks).toHaveLength(1)
    const finish = lastChunk(chunks)
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.observedAttempts).toBe(0)
    expect(finish.replayState).toEqual(NONE)
  })

  test('abort mid-stream terminates with aborted and never retries', async () => {
    let calls = 0
    const controlled = controlledStream()
    const fetchImpl = (async () => {
      calls++
      return new Response(controlled.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as DirectFetch
    const adapter = chatAdapter(fetchImpl)
    const request = snapshot()
    const controller = new AbortController()
    const iterator = boundStream(adapter, request, controller.signal)[Symbol.asyncIterator]()
    const chunks: StreamChunk[] = []
    controlled.push(choiceFrame({ content: 'partial' }))
    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      chunks.push(next.value)
      if (next.value.type === 'text-delta') controller.abort()
    }
    expect(calls).toBe(1)
    const finish = lastChunk(chunks)
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.observedAttempts).toBe(1)
    expect(chunks.filter((chunk) => chunk.type === 'first-byte')).toHaveLength(1)
  })

  test('first-event watchdog produces TIMEOUT without retrying', async () => {
    let calls = 0
    const controlled = controlledStream()
    const fetchImpl = (async () => {
      calls++
      return new Response(controlled.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 40 })
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') expect(finish.reason.failure.code).toBe('TIMEOUT')
    expect(finish.observedAttempts).toBe(1)
    expect(calls).toBe(1)
  })

  test('inter-event idle watchdog produces TIMEOUT after partial output', async () => {
    const controlled = controlledStream()
    const fetchImpl = (async () =>
      new Response(controlled.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 500, interEventTimeoutMs: 40 })
    controlled.push(choiceFrame({ content: 'partial' }))
    const chunks = await collect(boundStream(adapter, snapshot()))
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected error finish')
    expect(finish.reason.failure.code).toBe('TIMEOUT')
    expect(finish.observedAttempts).toBe(1)
  })

  test('maps HTTP statuses to the closed failure taxonomy with retry hints', async () => {
    const cases = [
      [401, 'unauthorized', 'AUTH'],
      [403, 'forbidden', 'AUTH'],
      [402, 'balance exhausted', 'QUOTA'],
      [429, 'slow down', 'RATE_LIMIT'],
      [400, 'maximum context length exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
      [400, 'bad payload', 'INVALID_REQUEST'],
      [413, 'payload too large', 'INVALID_REQUEST'],
      [422, 'unprocessable', 'INVALID_REQUEST'],
      [503, 'unavailable', 'SERVER'],
    ] as const
    for (const [status, detail, code] of cases) {
      let calls = 0
      const fetchImpl = (async () => {
        calls++
        return new Response(JSON.stringify({ error: { message: detail } }), {
          status,
          statusText: 'Upstream',
          headers: { 'retry-after': '2', 'x-request-id': 'req-1' },
        })
      }) as DirectFetch
      const chunks = await collect(boundStream(chatAdapter(fetchImpl), snapshot()))
      const finish = lastChunk(chunks)
      expect(finish.reason.kind).toBe('error')
      if (finish.reason.kind !== 'error') continue
      expect(finish.reason.failure.code).toBe(code)
      expect(finish.reason.failure.status).toEqual(some(status))
      expect(finish.observedAttempts).toBe(1)
      expect(calls).toBe(1)
      if (status === 429) expect(finish.reason.failure.retryAfterMs).toEqual(some(2_000))
      if (status === 503) {
        expect(finish.reason.failure.requestId).toEqual(some('req-1' as ProviderRequestId))
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/*                            watchdog and redaction                         */
/* -------------------------------------------------------------------------- */

describe('direct watchdog hardening', () => {
  test('first-event deadline bounds a fetch that never yields headers', async () => {
    let calls = 0
    const never = Promise.withResolvers<Response>().promise
    const fetchImpl = (async () => {
      calls++
      return never
    }) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 40 })
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected timeout failure')
    expect(finish.reason.failure.code).toBe('TIMEOUT')
    expect(finish.observedAttempts).toBe(1)
    expect(calls).toBe(1)
  })

  test('caller abort while awaiting headers is ABORTED, not TIMEOUT', async () => {
    let calls = 0
    const never = Promise.withResolvers<Response>().promise
    const fetchImpl = (async () => {
      calls++
      return never
    }) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 500, interEventTimeoutMs: 500 })
    const controller = new AbortController()
    const pending = collect(boundStream(adapter, snapshot(), controller.signal))
    // Real elapsed time is the behaviour under test: the abort must land while
    // the fetch is still pending, well before the 500 ms watchdog.
    await Bun.sleep(20)
    controller.abort()
    const chunks = await pending
    const finish = lastChunk(chunks)
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.observedAttempts).toBe(1)
    expect(calls).toBe(1)
  })

  test('first-event deadline bounds a stalled HTTP error body', async () => {
    const controlled = controlledStream()
    const fetchImpl = (async () =>
      new Response(controlled.stream, {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 40 })
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected timeout failure')
    expect(finish.reason.failure.code).toBe('TIMEOUT')
    expect(finish.observedAttempts).toBe(1)
  })

  test('comment-only trickle cannot defeat the first-event deadline', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(': ping\n\n'))
      },
    })
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 40 })
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected timeout failure')
    expect(finish.reason.failure.code).toBe('TIMEOUT')
    expect(finish.observedAttempts).toBe(1)
  })

  test('comment-only trickle cannot extend the inter-event deadline', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(choiceFrame({ content: 'hi' })))
      },
      pull(controller) {
        controller.enqueue(encoder.encode(': tick\n\n'))
      },
    })
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as DirectFetch
    const adapter = chatAdapter(fetchImpl, { firstEventTimeoutMs: 500, interEventTimeoutMs: 40 })
    const chunks = await collect(boundStream(adapter, snapshot()))
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected timeout failure')
    expect(finish.reason.failure.code).toBe('TIMEOUT')
    expect(finish.observedAttempts).toBe(1)
  })

  test('request ids that echo the credential are omitted', async () => {
    const canary = 'sk-secret-canary-9981'
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'x-request-id': canary },
      })) as DirectFetch
    const adapter = chatAdapter(
      fetchImpl,
      { authMode: 'bearer', credentialRef: 'CANARY_KEY' },
      () => canary,
    )
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected rate limit failure')
    expect(finish.reason.failure.code).toBe('RATE_LIMIT')
    expect(finish.reason.failure.requestId).toEqual(NONE)
    expect(finish.reason.failure.message).not.toContain(canary)
  })
})

/* -------------------------------------------------------------------------- */
/*                                 credentials                               */
/* -------------------------------------------------------------------------- */

describe('credential seam', () => {
  test('assertUsableApiKey normalizes whitespace and rejects blank or illegal values', () => {
    const accepted = assertUsableApiKey('  sk-abc  ', 'route-a', 'REF')
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.value).toBe('sk-abc')

    const blank = assertUsableApiKey('   ', 'route-a', 'REF')
    expect(blank.ok).toBe(false)
    if (!blank.ok) {
      expect(blank.error.code).toBe('INVALID_CREDENTIAL')
      expect(blank.error.message).toContain('route-a')
      expect(blank.error.message).toContain('REF')
    }

    const illegal = assertUsableApiKey('key\u0000value', 'route-a', 'REF')
    expect(illegal.ok).toBe(false)
    if (!illegal.ok) expect(illegal.error.code).toBe('INVALID_CREDENTIAL')

    const wrongType = assertUsableApiKey(42, 'route-a', 'REF')
    expect(wrongType.ok).toBe(false)
    if (!wrongType.ok) expect(wrongType.error.code).toBe('MISSING_CREDENTIAL')
  })

  test('bindGeneration fails with MISSING_CREDENTIAL when the resolver has no value', () => {
    const adapter = chatAdapter(
      (async () => sseResponse('')) as DirectFetch,
      { authMode: 'bearer', credentialRef: 'ABSENT_KEY' },
      () => undefined,
    )
    const bound = adapter.bindGeneration(ROUTE, MODEL)
    expect(bound.ok).toBe(false)
    if (!bound.ok) {
      expect(bound.error.code).toBe('MISSING_CREDENTIAL')
      expect(bound.error.message).not.toContain('ABSENT_KEY=')
    }
  })

  test('upstream auth errors never echo the credential', async () => {
    const canary = 'sk-secret-canary-9981'
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: `invalid api key: ${canary}` } }), {
        status: 401,
      })) as DirectFetch
    const adapter = chatAdapter(
      fetchImpl,
      { authMode: 'bearer', credentialRef: 'CANARY_KEY' },
      () => canary,
    )
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected auth failure')
    expect(finish.reason.failure.code).toBe('AUTH')
    expect(finish.reason.failure.message).not.toContain(canary)
    expect(finish.reason.failure.message).toContain('[redacted]')
  })
})

/* -------------------------------------------------------------------------- */
/*                           completions engine wire                         */
/* -------------------------------------------------------------------------- */

describe('openai-completions engine', () => {
  test('rejects non-object JSON SSE frames and invalid tool JSON', async () => {
    const malformed = completionsEngine.decode(
      sseEvents(['data: not-json\n\n']),
      snapshot(),
      routeConfig(),
    )
    const malformedError = await collect(malformed).then(
      () => undefined,
      (cause: unknown) => cause as { code?: string },
    )
    expect(malformedError?.code).toBe('MALFORMED_RESPONSE')

    const invalidTool = completionsEngine.decode(
      sseEvents([
        choiceFrame({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"a":' },
            },
          ],
        }),
        choiceFrame({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
      snapshot(),
      routeConfig(),
    )
    const invalidToolError = await collect(invalidTool).then(
      () => undefined,
      (cause: unknown) => cause as { code?: string; message?: string },
    )
    expect(invalidToolError?.code).toBe('MALFORMED_RESPONSE')
    expect(invalidToolError?.message).toContain('invalid JSON')
  })

  test('reasoning aliases emit at most one delta per frame', async () => {
    const chunks = await collect(
      completionsEngine.decode(
        sseEvents([
          choiceFrame({ reasoning_content: 'think-1', reasoning: 'think-1' }),
          choiceFrame({ reasoning: 'think-2' }),
          choiceFrame({ content: 'answer' }),
          choiceFrame({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
        snapshot(),
        routeConfig(),
      ),
    )
    const reasoningDeltas = chunks.filter((chunk) => chunk.type === 'reasoning-delta')
    expect(
      reasoningDeltas.map((chunk) => (chunk.type === 'reasoning-delta' ? chunk.delta : '')),
    ).toEqual(['think-1', 'think-2'])
    const reasoningEnd = chunks.find(
      (chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning',
    )
    expect(
      reasoningEnd?.type === 'block-end' && reasoningEnd.block.type === 'reasoning'
        ? reasoningEnd.block.text
        : '',
    ).toBe('think-1think-2')
  })

  test('assembles tool calls split over frames and corrects stop to tool-calls', async () => {
    const chunks = await collect(
      completionsEngine.decode(
        sseEvents([
          choiceFrame({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"key"' },
              },
            ],
          }),
          choiceFrame({ tool_calls: [{ index: 0, function: { arguments: ':"alpha"}' } }] }),
          choiceFrame({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
        snapshot(),
        routeConfig(),
      ),
    )
    const start = chunks.find((chunk) => chunk.type === 'block-start')
    expect(start?.type === 'block-start' ? start.toolName : undefined).toBe('lookup')
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas).toHaveLength(2)
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    expect(
      end?.type === 'block-end' && end.block.type === 'tool-call' ? end.block.argumentsJson : '',
    ).toBe('{"key":"alpha"}')
    const finish = lastChunk(chunks)
    expect(finish.reason.kind).toBe('tool-calls')
  })

  test('truncated tool arguments under max-tokens are preserved, not rejected', async () => {
    const chunks = await collect(
      completionsEngine.decode(
        sseEvents([
          choiceFrame({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"key":' },
              },
            ],
          }),
          choiceFrame({}, 'length'),
          'data: [DONE]\n\n',
        ]),
        snapshot(),
        routeConfig(),
      ),
    )
    const finish = lastChunk(chunks)
    expect(finish.reason.kind).toBe('max-tokens')
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    expect(
      end?.type === 'block-end' && end.block.type === 'tool-call' ? end.block.argumentsJson : '',
    ).toBe('{"key":')
  })

  test('zero-block terminal becomes EMPTY_RESPONSE over a single physical request', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return sseResponse('')
    }) as DirectFetch
    const chunks = await collect(boundStream(chatAdapter(fetchImpl), snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected empty-response error')
    expect(finish.reason.failure.code).toBe('EMPTY_RESPONSE')
    expect(finish.observedAttempts).toBe(1)
    expect(calls).toBe(1)
  })

  test('premature EOF after block output becomes TRANSPORT without block-end splicing', async () => {
    const controlled = controlledStream()
    const fetchImpl = (async () =>
      new Response(controlled.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as DirectFetch
    const adapter = chatAdapter(fetchImpl)
    controlled.push(choiceFrame({ content: 'hello' }))
    controlled.close()
    const chunks = await collect(boundStream(adapter, snapshot()))
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected transport failure')
    expect(finish.reason.failure.code).toBe('TRANSPORT')
    expect(chunks.some((chunk) => chunk.type === 'block-end')).toBe(false)
  })

  test('captures a delayed trailing usage frame inside the grace window', async () => {
    const controlled = controlledStream()
    const fetchImpl = (async () =>
      new Response(controlled.stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as DirectFetch
    const adapter = chatAdapter(fetchImpl)
    const pending = collect(boundStream(adapter, snapshot()))
    controlled.push(choiceFrame({ content: 'ok' }))
    controlled.push(choiceFrame({}, 'stop'))
    // Real elapsed time is the behaviour under test: the trailing usage frame is
    // deliberately delayed past the provider's finish frame, and only a genuine
    // delay proves the 2,500 ms grace window is actually honoured.
    await Bun.sleep(120)
    controlled.push(
      `${dataFrame({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_cache_hit_tokens: 4,
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      })}data: [DONE]\n\n`,
    )
    controlled.close()
    const chunks = await pending
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    expect(usage?.type === 'usage' ? usage.usage.inputUncachedTokens : -1).toBe(6)
    expect(usage?.type === 'usage' ? usage.usage.cacheReadTokens : -1).toBe(4)
    expect(usage?.type === 'usage' ? usage.usage.reasoningTokens : undefined).toEqual(some(1))
    expect(lastChunk(chunks).reason).toEqual({ kind: 'stop' })
  })

  test('filters DeepSeek template markers split across frames', () => {
    const filter = new TemplateTokenFilter()
    expect(filter.push('hello<｜end')).toBe('hello')
    expect(filter.push('▁of▁sentence｜> world<|')).toBe(' world')
    expect(filter.push('im_end|>!')).toBe('!')
    expect(filter.flush()).toBe('')
  })

  test('template filtering applies inside the decoder', async () => {
    const chunks = await collect(
      completionsEngine.decode(
        sseEvents([
          choiceFrame({ content: 'hello<｜end' }),
          choiceFrame({ content: '▁of▁sentence｜> world' }),
          choiceFrame({}, 'stop'),
          'data: [DONE]\n\n',
        ]),
        snapshot(),
        routeConfig({ compat: { stripTemplateTokens: true } }),
      ),
    )
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : ''))
      .join('')
    expect(text).toBe('hello world')
  })

  test('content_filter finish becomes CONTENT_BLOCKED', async () => {
    const chunks = await collect(
      completionsEngine.decode(
        sseEvents([
          choiceFrame({ content: 'x' }),
          choiceFrame({}, 'content_filter'),
          'data: [DONE]\n\n',
        ]),
        snapshot(),
        routeConfig(),
      ),
    )
    const finish = lastChunk(chunks)
    if (finish.reason.kind !== 'error') throw new Error('expected content block')
    expect(finish.reason.failure.code).toBe('CONTENT_BLOCKED')
  })
})

/* -------------------------------------------------------------------------- */
/*                        request projection and replay                      */
/* -------------------------------------------------------------------------- */

describe('openai-completions request projection', () => {
  test('replays reasoning_details only for the same origin', () => {
    const assistant: NeutralAssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      origin: {
        routeId: ROUTE,
        modelId: MODEL,
        replayState: some({
          adapterKind: 'direct:openai-completions',
          version: 1,
          response: { reasoningDetails: [{ type: 'reasoning.text', text: 'because' }] },
        }),
      },
    }
    const request: CacheAlignedChatRequest = {
      ...emptyRequest,
      segment2WarmHistory: [assistant],
    }
    const sameOrigin = completionsEngine.build(snapshot({ request }), routeConfig())
    const sameMessages = sameOrigin.body.messages as readonly Record<string, unknown>[]
    expect(sameMessages[0]?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'because' },
    ])

    const otherOrigin = completionsEngine.build(
      snapshot({ request, modelId: 'other-model' as ModelId }),
      routeConfig(),
    )
    const otherMessages = otherOrigin.body.messages as readonly Record<string, unknown>[]
    expect(otherMessages[0]?.reasoning_details).toBeUndefined()

    // Wrong adapter kind, damaged version or a non-array payload cannot leak.
    for (const replayState of [
      {
        adapterKind: 'omp:pi-ai',
        version: 1,
        response: { reasoningDetails: [{ type: 'reasoning.text', text: 'because' }] },
      },
      {
        adapterKind: 'direct:openai-completions',
        version: 2,
        response: { reasoningDetails: [{ type: 'reasoning.text', text: 'because' }] },
      },
      {
        adapterKind: 'direct:openai-completions',
        version: 1,
        response: { reasoningDetails: 'because' },
      },
      {
        adapterKind: 'direct:openai-completions',
        version: 1,
        response: { reasoningDetails: [{ type: 'reasoning.text', text: 'because' }, 42] },
      },
      {
        adapterKind: 'direct:openai-completions',
        version: 1,
        response: { reasoningDetails: ['because'] },
      },
    ] satisfies readonly ReplayEnvelope[]) {
      const damaged = completionsEngine.build(
        snapshot({
          request: {
            ...request,
            segment2WarmHistory: [
              {
                ...assistant,
                origin: { routeId: ROUTE, modelId: MODEL, replayState: some(replayState) },
              },
            ],
          },
        }),
        routeConfig(),
      )
      const messages = damaged.body.messages as readonly Record<string, unknown>[]
      expect(messages[0]?.reasoning_details).toBeUndefined()
      expect(JSON.stringify(messages)).not.toContain('because')
      expect(messages[0]?.content).toBe('answer')
    }

    const foreignRoute = completionsEngine.build(
      snapshot({
        routeId: 'other-route' as RouteId,
        request: { ...request, segment2WarmHistory: [assistant] },
      }),
      routeConfig(),
    )
    const foreignRouteMessages = foreignRoute.body.messages as readonly Record<string, unknown>[]
    expect(foreignRouteMessages[0]?.reasoning_details).toBeUndefined()
  })

  test('deepseek replays real reasoning_content and pads tool-only content', () => {
    const history: readonly NeutralMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thought' },
          { type: 'tool-call', id: 'call_1' as ToolCallId, name: 'lookup', argumentsJson: '{}' },
        ],
        origin: { routeId: ROUTE, modelId: MODEL, replayState: NONE },
      },
    ]
    const built = completionsEngine.build(
      snapshot({ request: { ...emptyRequest, segment2WarmHistory: history }, effort: 'medium' }),
      routeConfig({ gateway: 'deepseek', compat: { reasoningField: 'reasoning_content' } }),
    )
    const message = (built.body.messages as readonly Record<string, unknown>[])[0]
    expect(message?.reasoning_content).toBe('thought')
    expect(message?.content).toBe('.')
    expect(message?.tool_calls).toHaveLength(1)
  })

  test('openrouter sends reasoning policy, omits strict tools, and injects cache markers', () => {
    const tool: NormalizedWireToolSchema = {
      name: 'lookup',
      description: 'Look up',
      strict: true,
      jsonSchema: { type: 'object', properties: {} },
    }
    const request: CacheAlignedChatRequest = {
      segment1Static: [{ name: 'system', text: 'Be terse.' }],
      segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      segment3VolatileTail: some('tail context'),
      sharedPrefixKey: NONE,
    }
    const built = completionsEngine.build(
      snapshot({
        request,
        tools: [tool],
        modelId: 'anthropic/claude-x' as ModelId,
        effort: 'off',
        sampling: { cacheRetention: 'short' },
      }),
      routeConfig({ gateway: 'openrouter', compat: { disableStrictTools: true } }),
    )
    expect(built.body.reasoning).toEqual({ enabled: false })
    const tools = built.body.tools as readonly Record<string, Record<string, unknown>>[]
    expect(tools[0]?.function?.strict).toBeUndefined()
    const messages = built.body.messages as readonly Record<string, unknown>[]
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'Be terse.', cache_control: { type: 'ephemeral' } },
    ])
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n<turn-context>tail context</turn-context>' },
    ])
    expect(messages).toHaveLength(2)
  })

  test('volatile tail merges into a trailing user message', () => {
    const request: CacheAlignedChatRequest = {
      ...emptyRequest,
      segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      segment3VolatileTail: some('now'),
    }
    const built = completionsEngine.build(snapshot({ request }), routeConfig())
    const messages = built.body.messages as readonly Record<string, unknown>[]
    expect(messages).toEqual([
      { role: 'user', content: 'hello\n\n<turn-context>now</turn-context>' },
    ])
  })
})

/* -------------------------------------------------------------------------- */
/*                              configuration                                */
/* -------------------------------------------------------------------------- */

describe('direct adapter configuration', () => {
  test('generation snapshots survive replacement; invalid replacement is atomic', async () => {
    const urls: string[] = []
    const firstFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse(
        `${choiceFrame({ content: 'first' }) + choiceFrame({}, 'stop')}data: [DONE]\n\n`,
      )
    }) as DirectFetch
    const adapter = chatAdapter(firstFetch, { baseURL: 'https://first.invalid' })
    const request = snapshot()
    const boundBefore = adapter.bindGeneration(request.routeId, request.modelId)
    expect(boundBefore.ok).toBe(true)
    if (!boundBefore.ok) return

    const rejected = adapter.replaceConfiguration({
      routes: { fixture: { protocol: 'openai-completions', baseURL: 'not-a-url' } },
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.code).toBe('INVALID_ROUTE')
    expect(adapter.resolveCapabilities(ROUTE, MODEL).ok).toBe(true)

    const secondFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse(
        `${choiceFrame({ content: 'second' }) + choiceFrame({}, 'stop')}data: [DONE]\n\n`,
      )
    }) as DirectFetch
    const replaced = adapter.replaceConfiguration({
      routes: {
        fixture: {
          protocol: 'openai-completions',
          baseURL: 'https://second.invalid',
          authMode: 'none',
          firstEventTimeoutMs: 500,
          interEventTimeoutMs: 500,
        },
      },
      fetch: secondFetch,
    })
    expect(replaced.ok).toBe(true)

    await collect(boundBefore.value({ snapshot: request }, new AbortController().signal))
    const boundAfter = adapter.bindGeneration(request.routeId, request.modelId)
    if (!boundAfter.ok) throw new Error('rebind failed')
    await collect(boundAfter.value({ snapshot: request }, new AbortController().signal))
    expect(urls).toEqual([
      'https://first.invalid/v1/chat/completions',
      'https://second.invalid/v1/chat/completions',
    ])
  })

  test('openai-responses route with compat.disableStrictTools snapshots strict:false', async () => {
    const ctx = new Context()
    const service = new LlmService(ctx)
    try {
      const adapter = new DirectChatAdapter({
        routes: {
          fixture: {
            protocol: 'openai-responses',
            baseURL: 'https://fixture.invalid',
            authMode: 'none',
            compat: { disableStrictTools: true },
          },
        },
      })
      expect(service.registerChatAdapter([ROUTE], adapter).ok).toBe(true)
      const prepared = service.prepareChatCall(
        { kind: 'explicit', routeId: ROUTE, modelId: MODEL },
        emptyRequest,
        {
          tools: [
            {
              name: 'lookup',
              description: 'Look up a record',
              parameters: t.obj({ key: t.str() }),
            },
          ],
        },
      )
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      expect(prepared.value.snapshot.capabilities.disableStrictTools).toBe(true)
      expect(prepared.value.snapshot.tools).toHaveLength(1)
      expect(prepared.value.snapshot.tools[0]?.strict).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  test('unknown route is NO_ROUTE and malformed model id is INVALID_REQUEST', () => {
    const adapter = chatAdapter((async () => sseResponse('')) as DirectFetch)
    const unknown = adapter.resolveCapabilities('missing' as RouteId, MODEL)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NO_ROUTE')
    const badModel = adapter.bindGeneration(ROUTE, '' as ModelId)
    expect(badModel.ok).toBe(false)
    if (!badModel.ok) expect(badModel.error.code).toBe('INVALID_REQUEST')
  })

  test('capability policy is applied per gateway before explicit overrides', () => {
    const adapter = new DirectChatAdapter({
      routes: {
        deepseek: {
          protocol: 'anthropic-messages',
          gateway: 'deepseek',
          baseURL: 'https://api.deepseek.com/anthropic',
          authMode: 'none',
        },
        deepseekCompletions: {
          protocol: 'openai-completions',
          gateway: 'deepseek',
          baseURL: 'https://api.deepseek.com',
          authMode: 'none',
        },
        commandcode: {
          protocol: 'openai-responses',
          gateway: 'commandcode',
          baseURL: 'https://commandcode.invalid',
          authMode: 'none',
        },
        opencode: {
          protocol: 'openai-completions',
          gateway: 'opencode',
          baseURL: 'https://opencode.invalid',
          authMode: 'none',
          capabilities: { contextWindow: 999 },
        },
      },
    })
    const flash = adapter.resolveCapabilities('deepseek' as RouteId, 'deepseek-flash' as ModelId)
    expect(flash.ok && flash.value.systemPromptUpdate).toBe('in-history')
    const completions = adapter.resolveCapabilities('deepseekCompletions' as RouteId, MODEL)
    expect(completions.ok && completions.value.forcedToolChoiceSupport).toBe('none')
    const responses = adapter.resolveCapabilities('commandcode' as RouteId, MODEL)
    expect(responses.ok && responses.value.forcedToolChoiceSupport).toBe('required-only')
    const opencode = adapter.resolveCapabilities('opencode' as RouteId, MODEL)
    expect(opencode.ok && opencode.value.forcedToolChoiceSupport).toBe('none')
    expect(opencode.ok && opencode.value.contextWindow).toBe(999)
  })

  test('every doc04 gateway preset is declared with protocol-appropriate auth', () => {
    expect(Object.keys(GATEWAY_PRESETS).sort()).toEqual(
      [
        'anthropic',
        'commandcode',
        'deepseek',
        'google',
        'omp-gateway-http',
        'openai',
        'opencode',
        'openrouter',
        'siliconflow',
        'siliconflow-cn',
      ].sort(),
    )
    const deepseekMessages = defineDirectRoute({
      gateway: 'deepseek',
      protocol: 'anthropic-messages',
    })
    expect(deepseekMessages.baseURL).toBe('https://api.deepseek.com/anthropic')
    expect(deepseekMessages.authMode).toBe('x-api-key')
    expect(deepseekMessages.credentialRef).toBe('DEEPSEEK_API_KEY')
    const deepseekCompletions = defineDirectRoute({
      gateway: 'deepseek',
      protocol: 'openai-completions',
    })
    expect(deepseekCompletions.baseURL).toBe('https://api.deepseek.com')
    expect(deepseekCompletions.compat).toEqual({
      stripTemplateTokens: true,
      reasoningField: 'reasoning_content',
    })
    expect(
      gatewayCapabilityPolicy('commandcode', 'openai-responses', MODEL).forcedToolChoiceSupport,
    ).toBe('required-only')

    const custom = defineDirectRoute({
      protocol: 'openai-responses',
      baseURL: 'https://custom.invalid/prefix',
      authMode: 'none',
      headers: { 'x-custom': 'yes' },
    })
    expect(custom.gateway).toBeUndefined()
    expect(custom.authMode).toBe('none')
    expect(custom.headers).toEqual({ 'x-custom': 'yes' })

    expect(() =>
      defineDirectRoute({ gateway: 'omp-gateway-http', protocol: 'openai-completions' }),
    ).toThrow(/explicit baseURL/)
  })
})

/* -------------------------------------------------------------------------- */
/*                                  retrieval                                */
/* -------------------------------------------------------------------------- */

describe('direct retrieval adapters', () => {
  test('embeddings map response indices onto independent input-order buffers', async () => {
    let body: Record<string, unknown> | undefined
    let url = ''
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input)
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
          usage: { prompt_tokens: 7 },
        }),
        { status: 200 },
      )
    }) as DirectFetch
    const adapter = new DirectEmbeddingAdapter(retrievalAdapterOptions(fetchImpl))
    const result = await adapter.embed(ROUTE, MODEL, ['a', 'b'], {
      dimensions: 2,
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(url).toBe('https://fixture.invalid/v1/embeddings')
    expect(body?.input).toEqual(['a', 'b'])
    expect(body?.encoding_format).toBe('float')
    expect(body?.dimensions).toBe(2)
    expect(Array.from(result.value.vectors[0] ?? [])).toEqual([1, 2])
    expect(Array.from(result.value.vectors[1] ?? [])).toEqual([3, 4])
    expect(result.value.vectors[0]?.buffer).not.toBe(result.value.vectors[1]?.buffer)
    expect(result.value.totalPromptTokens).toEqual(some(7))
  })

  test('embeddings reject duplicate indices and mismatched counts', async () => {
    const duplicate = new DirectEmbeddingAdapter(
      retrievalAdapterOptions(
        (async () =>
          new Response(
            JSON.stringify({
              data: [
                { index: 0, embedding: [1] },
                { index: 0, embedding: [2] },
              ],
            }),
            {
              status: 200,
            },
          )) as DirectFetch,
      ),
    )
    const duplicateResult = await duplicate.embed(ROUTE, MODEL, ['a', 'b'], {
      signal: new AbortController().signal,
    })
    expect(duplicateResult.ok).toBe(false)
    if (!duplicateResult.ok) expect(duplicateResult.error.code).toBe('MALFORMED_RESPONSE')

    const mismatch = new DirectEmbeddingAdapter(
      retrievalAdapterOptions(
        (async () =>
          new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
            status: 200,
          })) as DirectFetch,
      ),
    )
    const mismatchResult = await mismatch.embed(ROUTE, MODEL, ['a', 'b'], {
      signal: new AbortController().signal,
    })
    expect(mismatchResult.ok).toBe(false)
    if (!mismatchResult.ok) expect(mismatchResult.error.code).toBe('MALFORMED_RESPONSE')
  })

  test('embeddings classify upstream failures and never retry', async () => {
    let calls = 0
    const adapter = new DirectEmbeddingAdapter(
      retrievalAdapterOptions((async () => {
        calls++
        return new Response(JSON.stringify({ error: { message: 'slow' } }), {
          status: 429,
          headers: { 'retry-after': '1' },
        })
      }) as DirectFetch),
    )
    const result = await adapter.embed(ROUTE, MODEL, ['a'], {
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('RATE_LIMIT')
      expect(result.error.retryAfterMs).toEqual(some(1_000))
    }
    expect(calls).toBe(1)
  })

  test('pre-aborted embedding performs no fetch', async () => {
    let calls = 0
    const adapter = new DirectEmbeddingAdapter(
      retrievalAdapterOptions((async () => {
        calls++
        return new Response('{}', { status: 200 })
      }) as DirectFetch),
    )
    const controller = new AbortController()
    controller.abort()
    const result = await adapter.embed(ROUTE, MODEL, ['a'], { signal: controller.signal })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ABORTED')
    expect(calls).toBe(0)
  })

  test('rerank preserves server order without topN and sorts with topN', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.2 },
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.5 },
          ],
        }),
        { status: 200 },
      )
    }) as DirectFetch
    const adapter = new DirectRerankAdapter(retrievalAdapterOptions(fetchImpl))
    const plain = await adapter.rerank(ROUTE, MODEL, 'q', ['a', 'b', 'c'], {
      signal: new AbortController().signal,
    })
    expect(plain.ok).toBe(true)
    if (plain.ok) expect(plain.value.map((item) => item.index)).toEqual([2, 0, 1])
    const limited = await adapter.rerank(ROUTE, MODEL, 'q', ['a', 'b', 'c'], {
      topN: 2,
      signal: new AbortController().signal,
    })
    expect(limited.ok).toBe(true)
    if (limited.ok) {
      expect(limited.value.map((item) => item.index)).toEqual([0, 1])
      expect(limited.value.map((item) => item.relevanceScore)).toEqual([0.9, 0.5])
    }
    expect(bodies[1]?.top_n).toBe(2)
  })

  test('rerank rejects out-of-range indices and invalid topN', async () => {
    const adapter = new DirectRerankAdapter(
      retrievalAdapterOptions(
        (async () =>
          new Response(JSON.stringify({ results: [{ index: 5, relevance_score: 0.1 }] }), {
            status: 200,
          })) as DirectFetch,
      ),
    )
    const badIndex = await adapter.rerank(ROUTE, MODEL, 'q', ['a'], {
      signal: new AbortController().signal,
    })
    expect(badIndex.ok).toBe(false)
    if (!badIndex.ok) expect(badIndex.error.code).toBe('MALFORMED_RESPONSE')

    const badTopN = await adapter.rerank(ROUTE, MODEL, 'q', ['a'], {
      topN: 5,
      signal: new AbortController().signal,
    })
    expect(badTopN.ok).toBe(false)
    if (!badTopN.ok) expect(badTopN.error.code).toBe('INVALID_REQUEST')
  })

  test('retrieval routes without an embeddings endpoint are UNSUPPORTED_CAPABILITY', async () => {
    const adapter = new DirectEmbeddingAdapter(
      retrievalAdapterOptions((async () => new Response('{}', { status: 200 })) as DirectFetch, {
        protocol: 'anthropic-messages',
      }),
    )
    const result = await adapter.embed(ROUTE, MODEL, ['a'], {
      signal: new AbortController().signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_CAPABILITY')
  })
})
