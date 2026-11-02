/**
 * Service-level contracts: fiber-bound routing, atomic replacement, profile
 * publication, capability resolution, generation locking, one-shot prepared
 * calls, waterfall isolation and retrieval boundary validation.
 */

import { describe, expect, test } from 'bun:test'
import type { Result } from '@sekaisen/core'
import { InvariantError, isSome, NONE, some } from '@sekaisen/core'
import {
  type CacheAlignedChatRequest,
  type ChatAdapter,
  type ChatCallOverrides,
  type ChatProfileConfig,
  type EmbeddingAdapter,
  type EmbeddingBatchResult,
  type LlmFailure,
  LlmService,
  MockAdapter,
  type ModelCapabilities,
  type ModelId,
  type NeutralToolDefinition,
  type PreparedChatCall,
  type ProfileId,
  type ProfileRoutingConfig,
  type RerankAdapter,
  type RerankScoreItem,
  type RouteId,
  type StreamChunk,
  t,
} from '@sekaisen/plugin-llm'
import { Context } from 'cordis'
import { failure } from '../packages/plugin-llm/src/utils.ts'

const ROUTE = 'route-a' as RouteId
const ROUTE_B = 'route-b' as RouteId
const ROUTE_C = 'route-c' as RouteId
const MODEL = 'model-a' as ModelId
const PROFILE = 'fast' as ProfileId

const LOOKUP: NeutralToolDefinition = Object.freeze({
  name: 'lookup',
  description: 'Look up one key',
  parameters: t.obj({ key: t.str() }),
})

const SEARCH: NeutralToolDefinition = Object.freeze({
  name: 'search',
  description: 'Search the corpus',
  parameters: t.obj({ query: t.str() }),
})

function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected Ok, received ${JSON.stringify(result.error)}`)
  return result.value
}

function expectErrCode(result: Result<unknown, LlmFailure>, code: LlmFailure['code']): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe(code)
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function requestFixture(text = 'hello'): CacheAlignedChatRequest {
  return {
    segment1Static: [{ name: 'system', text: 'be brief' }],
    segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text }] }],
    segment3VolatileTail: NONE,
    sharedPrefixKey: NONE,
  }
}

function chatProfile(overrides: Partial<ChatProfileConfig> = {}): ChatProfileConfig {
  return Object.freeze({
    routeId: ROUTE,
    modelId: MODEL,
    defaultEffort: 'medium',
    temperature: NONE,
    topP: NONE,
    frequencyPenalty: NONE,
    presencePenalty: NONE,
    maxOutputTokens: NONE,
    cacheRetention: 'none',
    ...overrides,
  })
}

function catalogue(entries: Readonly<Record<string, ChatProfileConfig>>): ProfileRoutingConfig {
  return { chatProfiles: entries, embeddingProfiles: {}, rerankProfiles: {} }
}

function setup(): { ctx: Context; service: LlmService } {
  const ctx = new Context()
  return { ctx, service: new LlmService(ctx) }
}

function prepare(
  service: LlmService,
  overrides?: ChatCallOverrides,
): Result<PreparedChatCall, LlmFailure> {
  const target = { kind: 'explicit' as const, routeId: ROUTE, modelId: MODEL }
  return overrides === undefined
    ? service.prepareChatCall(target, requestFixture())
    : service.prepareChatCall(target, requestFixture(), overrides)
}

const AUTO_TOOL_CHOICE = { kind: 'auto' } as const

/* -------------------------------------------------------------------------- */
/*                             Registration lifecycle                        */
/* -------------------------------------------------------------------------- */

describe('route registration lifecycle', () => {
  test('registers, lists deterministically and rejects duplicates', () => {
    const { service } = setup()
    const adapter = new MockAdapter()
    expectOk(service.registerChatAdapter([ROUTE_B, ROUTE], adapter))
    expect(service.listChatRoutes()).toEqual([ROUTE, ROUTE_B])

    expectErrCode(service.registerChatAdapter([ROUTE], adapter), 'DUPLICATE_ROUTE')
    expectErrCode(service.registerChatAdapter([], adapter), 'INVALID_ROUTE')
    expectErrCode(service.registerChatAdapter(['' as RouteId], adapter), 'INVALID_ROUTE')
    expectErrCode(service.registerChatAdapter([ROUTE_C, ROUTE_C], adapter), 'INVALID_ROUTE')
    expect(service.listChatRoutes()).toEqual([ROUTE, ROUTE_B])
  })

  test('rejects malformed adapters without touching the table', () => {
    const { service } = setup()
    const missingMethods = { adapterKind: 'broken' } as unknown as ChatAdapter
    expectErrCode(service.registerChatAdapter([ROUTE], missingMethods), 'INVALID_ROUTE')
    const badOwnership = {
      adapterKind: 'broken',
      retryOwnership: 'sometimes',
      resolveCapabilities: () => ({}),
      bindGeneration: () => ({}),
    } as unknown as ChatAdapter
    expectErrCode(service.registerChatAdapter([ROUTE], badOwnership), 'INVALID_ROUTE')
    const badKind = { ...badOwnership, adapterKind: '' } as unknown as ChatAdapter
    expectErrCode(service.registerChatAdapter([ROUTE], badKind), 'INVALID_ROUTE')
    expect(service.listChatRoutes()).toEqual([])
  })

  test('dispose releases routes idempotently and locks replace', () => {
    const { service } = setup()
    const adapter = new MockAdapter()
    const handle = expectOk(service.registerChatAdapter([ROUTE], adapter))
    expect(service.listChatRoutes()).toEqual([ROUTE])
    handle()
    handle()
    expect(service.listChatRoutes()).toEqual([])
    expectErrCode(handle.replace([ROUTE_B]), 'REGISTRATION_DISPOSED')
    expect(service.registerChatAdapter([ROUTE_B], adapter).ok).toBe(true)
  })

  test('replace is atomic: conflicts leave the live table untouched', () => {
    const { service } = setup()
    const first = new MockAdapter()
    const second = new MockAdapter()
    const firstHandle = expectOk(service.registerChatAdapter([ROUTE], first))
    const secondHandle = expectOk(service.registerChatAdapter([ROUTE_B], second))

    expectErrCode(secondHandle.replace([ROUTE, ROUTE_C]), 'DUPLICATE_ROUTE')
    expect(service.listChatRoutes()).toEqual([ROUTE, ROUTE_B])
    expect(
      service.prepareChatCall(
        { kind: 'explicit', routeId: ROUTE_C, modelId: MODEL },
        requestFixture(),
      ).ok,
    ).toBe(false)

    expectOk(secondHandle.replace([ROUTE_C]))
    expect(service.listChatRoutes()).toEqual([ROUTE, ROUTE_C])
    expectOk(firstHandle.replace([]))
    expect(service.listChatRoutes()).toEqual([ROUTE_C])
    expectOk(secondHandle.replace([ROUTE]))
    expect(service.listChatRoutes()).toEqual([ROUTE])
  })

  test('routes-updated fires once per commit and isolates faulty listeners', async () => {
    const { ctx, service } = setup()
    let commits = 0
    let afterFaulty = 0
    ctx.on('llm/routes-updated', () => {
      commits++
      throw new Error('listener defect')
    })
    ctx.on('llm/routes-updated', () => {
      afterFaulty++
      return Promise.reject(new Error('async listener defect'))
    })
    const adapter = new MockAdapter()
    const handle = expectOk(service.registerChatAdapter([ROUTE], adapter))
    expect(commits).toBe(1)
    expect(afterFaulty).toBe(1)
    expectOk(handle.replace([ROUTE_B]))
    expect(commits).toBe(2)
    expect(afterFaulty).toBe(2)
    expectOk(service.configureProfiles(catalogue({ [PROFILE]: chatProfile() })))
    expect(commits).toBe(3)
    expect(afterFaulty).toBe(3)
    // A rejected listener promise must not become an unhandled rejection.
    await Promise.resolve()
  })

  test('fiber unload releases registrations', async () => {
    const ctx = new Context()
    const adapter = new MockAdapter()
    let service!: LlmService
    const fiber = ctx.plugin((scope: Context) => {
      service = new LlmService(scope)
      expectOk(service.registerChatAdapter([ROUTE], adapter))
    })
    await fiber
    expect(service.listChatRoutes()).toEqual([ROUTE])
    await fiber.dispose()
    expect(service.listChatRoutes()).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*                          Profile snapshot publication                     */
/* -------------------------------------------------------------------------- */

describe('profile catalogue', () => {
  test('publishes a frozen null-prototype snapshot and ignores caller mutation', () => {
    const { service } = setup()
    const mutable: Record<string, ChatProfileConfig> = {
      [PROFILE]: chatProfile({ temperature: some(0.4) }),
      ['__proto__']: chatProfile({ modelId: MODEL }),
    }
    expectOk(
      service.configureProfiles({
        chatProfiles: mutable,
        embeddingProfiles: {},
        rerankProfiles: {},
      }),
    )
    const snapshot = service.getProfileConfig()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.getPrototypeOf(snapshot.chatProfiles)).toBe(null)
    expect(Object.isFrozen(snapshot.chatProfiles)).toBe(true)
    expect(Object.isFrozen(snapshot.chatProfiles[PROFILE])).toBe(true)
    expect(Object.hasOwn(snapshot.chatProfiles, '__proto__')).toBe(true)

    delete mutable[PROFILE]
    expect(Object.hasOwn(service.getProfileConfig().chatProfiles, PROFILE)).toBe(true)
    const temperature = service.getProfileConfig().chatProfiles[PROFILE]?.temperature
    expect(temperature !== undefined && isSome(temperature)).toBe(true)
  })

  test('validation is all-or-nothing and keeps the previous snapshot', () => {
    const { service } = setup()
    expectOk(service.configureProfiles(catalogue({ [PROFILE]: chatProfile() })))
    const before = service.getProfileConfig()

    expectErrCode(
      service.configureProfiles(catalogue({ [PROFILE]: chatProfile({ temperature: some(3) }) })),
      'INVALID_REQUEST',
    )
    expectErrCode(
      service.configureProfiles(catalogue({ [PROFILE]: chatProfile({ topP: some(0) }) })),
      'INVALID_REQUEST',
    )
    expectErrCode(
      service.configureProfiles(
        catalogue({ [PROFILE]: chatProfile({ maxOutputTokens: some(0) }) }),
      ),
      'INVALID_REQUEST',
    )
    expectErrCode(
      service.configureProfiles(
        catalogue({
          [PROFILE]: chatProfile({ defaultEffort: 'turbo' as ChatProfileConfig['defaultEffort'] }),
        }),
      ),
      'INVALID_REQUEST',
    )
    expectErrCode(
      service.configureProfiles(
        catalogue({
          [PROFILE]: chatProfile({
            cacheRetention: 'forever' as ChatProfileConfig['cacheRetention'],
          }),
        }),
      ),
      'INVALID_REQUEST',
    )
    expectErrCode(
      service.configureProfiles(
        catalogue({
          [PROFILE]: { ...chatProfile(), temperature: 0.5 } as unknown as ChatProfileConfig,
        }),
      ),
      'INVALID_REQUEST',
    )
    expectErrCode(service.configureProfiles(catalogue({ '': chatProfile() })), 'INVALID_ROUTE')
    expectErrCode(
      service.configureProfiles(catalogue({ [PROFILE]: chatProfile({ routeId: '' as RouteId }) })),
      'INVALID_ROUTE',
    )
    expect(service.getProfileConfig()).toBe(before)
  })

  test('profile targets resolve through the catalogue or report NO_ROUTE', () => {
    const { service } = setup()
    const adapter = new MockAdapter()
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    expectErrCode(
      service.prepareChatCall({ kind: 'profile', profileId: PROFILE }, requestFixture()),
      'NO_ROUTE',
    )
    expectOk(service.configureProfiles(catalogue({ [PROFILE]: chatProfile() })))
    expectOk(service.prepareChatCall({ kind: 'profile', profileId: PROFILE }, requestFixture()))
    expectErrCode(
      service.prepareChatCall(
        { kind: 'explicit', routeId: ROUTE_C, modelId: MODEL },
        requestFixture(),
      ),
      'NO_ROUTE',
    )
  })
})

/* -------------------------------------------------------------------------- */
/*                          Capability resolution                            */
/* -------------------------------------------------------------------------- */

function prepareWith(capabilities: Partial<ModelCapabilities>, overrides?: ChatCallOverrides) {
  const { service } = setup()
  const adapter = new MockAdapter({ capabilities })
  expectOk(service.registerChatAdapter([ROUTE], adapter))
  return expectOk(prepare(service, overrides))
}

/**
 * Prepare against an exact capability matrix instead of a merged mock default,
 * for capabilities only the runtime supplies (such as the strict opt-out).
 */
function prepareWithCapabilities(
  capabilities: ModelCapabilities,
  overrides?: ChatCallOverrides,
): PreparedChatCall {
  const { service } = setup()
  const adapter: ChatAdapter = {
    adapterKind: 'fixed-capabilities',
    retryOwnership: 'caller-owned-single-attempt',
    resolveCapabilities: () => ({ ok: true, value: capabilities }),
    bindGeneration: () => ({
      ok: true,
      value: () => (async function* unused(): AsyncGenerator<StreamChunk> {})(),
    }),
  }
  expectOk(service.registerChatAdapter([ROUTE], adapter))
  return expectOk(prepare(service, overrides))
}

describe('capability precedence', () => {
  test('forced tool choice degrades when the target refuses it', () => {
    const prepared = prepareWith(
      { forcedToolChoiceSupport: 'none' },
      { tools: [LOOKUP], toolChoice: { kind: 'named', toolName: 'lookup' } },
    )
    expect(prepared.snapshot.effectiveToolChoice).toEqual({ kind: 'auto' })
    expect(prepared.snapshot.downgradedToolChoice).toBe(true)

    const named = prepareWith(
      { forcedToolChoiceSupport: 'named' },
      { tools: [LOOKUP], toolChoice: { kind: 'named', toolName: 'lookup' } },
    )
    expect(named.snapshot.effectiveToolChoice).toEqual({ kind: 'named', toolName: 'lookup' })
    expect(named.snapshot.downgradedToolChoice).toBe(false)
  })

  test('required-only keeps a single filtered tool and downgrades unfiltered names', () => {
    const filtered = prepareWith(
      { forcedToolChoiceSupport: 'required-only' },
      {
        tools: [LOOKUP, SEARCH],
        toolChoice: { kind: 'named', toolName: 'lookup', allowSingleToolFilter: true },
      },
    )
    expect(filtered.snapshot.effectiveToolChoice).toEqual({ kind: 'required' })
    expect(filtered.snapshot.downgradedToolChoice).toBe(false)
    expect(filtered.snapshot.tools.map((tool) => tool.name)).toEqual(['lookup'])

    const downgraded = prepareWith(
      { forcedToolChoiceSupport: 'required-only' },
      { tools: [LOOKUP, SEARCH], toolChoice: { kind: 'named', toolName: 'lookup' } },
    )
    expect(downgraded.snapshot.effectiveToolChoice).toEqual({ kind: 'auto' })
    expect(downgraded.snapshot.downgradedToolChoice).toBe(true)
    expect(downgraded.snapshot.tools.length).toBe(2)
  })

  test('forced tool choice disables reasoning or downgrades without it', () => {
    const disabled = prepareWith(
      { disableReasoningOnForcedToolChoice: true, canDisableReasoning: true },
      { tools: [LOOKUP], toolChoice: { kind: 'required' } },
    )
    expect(disabled.snapshot.effectiveEffort).toBe('off')
    expect(disabled.snapshot.effectiveToolChoice).toEqual({ kind: 'required' })
    expect(disabled.snapshot.downgradedToolChoice).toBe(false)

    const cannot = prepareWith(
      {
        disableReasoningOnForcedToolChoice: true,
        canDisableReasoning: false,
        supportedEfforts: ['low', 'high'],
      },
      { tools: [LOOKUP], toolChoice: { kind: 'required' }, effort: 'high' },
    )
    expect(cannot.snapshot.effectiveToolChoice).toEqual({ kind: 'auto' })
    expect(cannot.snapshot.downgradedToolChoice).toBe(true)
    expect(cannot.snapshot.effectiveEffort).toBe('low')
  })

  test('effort clamps onto supported levels and honours the disable flag', () => {
    const high = prepareWith({ supportedEfforts: ['low', 'high'] }, { effort: 'max' })
    expect(high.snapshot.effectiveEffort).toBe('high')
    const low = prepareWith({ supportedEfforts: ['low', 'high'] }, { effort: 'medium' })
    expect(low.snapshot.effectiveEffort).toBe('low')
    const offDenied = prepareWith(
      { canDisableReasoning: false, supportedEfforts: ['minimal', 'high'] },
      { effort: 'off' },
    )
    expect(offDenied.snapshot.effectiveEffort).toBe('minimal')
    const offAllowed = prepareWith({ canDisableReasoning: true }, { effort: 'off' })
    expect(offAllowed.snapshot.effectiveEffort).toBe('off')
  })

  test('profile defaults apply before overrides and sampling is stripped statically', () => {
    const { service } = setup()
    const adapter = new MockAdapter({
      capabilities: {
        supportsSamplingWhenThinking: false,
        supportsPenaltiesAndStop: false,
        maxOutputTokens: 4_096,
      },
    })
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    expectOk(
      service.configureProfiles(
        catalogue({
          [PROFILE]: chatProfile({
            temperature: some(0.4),
            topP: some(0.9),
            frequencyPenalty: some(0.5),
            maxOutputTokens: some(9_999),
            cacheRetention: 'short',
          }),
        }),
      ),
    )
    const prepared = expectOk(
      service.prepareChatCall({ kind: 'profile', profileId: PROFILE }, requestFixture(), {
        temperature: 0.9,
        stopSequences: ['STOP'],
        sessionAffinityKey: 'session-1',
        effort: 'medium',
      }),
    )
    const sampling = prepared.snapshot.sampling
    expect(sampling.temperature).toEqual(NONE)
    expect(sampling.topP).toEqual(NONE)
    expect(sampling.frequencyPenalty).toEqual(NONE)
    expect(sampling.presencePenalty).toEqual(NONE)
    expect(sampling.stopSequences).toEqual([])
    expect(sampling.maxOutputTokens).toEqual(some(4_096))
    expect(sampling.cacheRetention).toBe('short')
    expect(sampling.sessionAffinityKey).toEqual(some('session-1'))

    const thinkingOff = expectOk(
      service.prepareChatCall({ kind: 'profile', profileId: PROFILE }, requestFixture(), {
        effort: 'off',
        temperature: 0.2,
      }),
    )
    expect(thinkingOff.snapshot.sampling.temperature).toEqual(some(0.2))
  })

  test('route strict opt-out is applied and frozen before the wire', () => {
    const strict = prepareWith({}, { tools: [LOOKUP] })
    expect(strict.snapshot.tools[0]?.strict).toBe(true)
    expect(strict.snapshot.capabilities.disableStrictTools).toBeUndefined()

    const relaxedMatrix: ModelCapabilities = {
      ...new MockAdapter().capabilities,
      disableStrictTools: true,
    }
    const relaxed = prepareWithCapabilities(relaxedMatrix, { tools: [LOOKUP] })
    expect(relaxed.snapshot.capabilities.disableStrictTools).toBe(true)
    expect(Object.isFrozen(relaxed.snapshot.capabilities)).toBe(true)
    expect(relaxed.snapshot.tools[0]?.strict).toBe(false)
  })

  test('endpoints without sampling support lose sampling and output budgets', () => {
    const prepared = prepareWith(
      { supportsSamplingParams: false },
      { temperature: 0.1, topP: 0.2, maxOutputTokens: 1_000 },
    )
    expect(prepared.snapshot.sampling.temperature).toEqual(NONE)
    expect(prepared.snapshot.sampling.topP).toEqual(NONE)
    expect(prepared.snapshot.sampling.maxOutputTokens).toEqual(NONE)
  })
})

/* -------------------------------------------------------------------------- */
/*                       Snapshot freezing and generation lock               */
/* -------------------------------------------------------------------------- */

describe('prepared snapshots', () => {
  test('are deeply frozen and reject mutation', () => {
    const prepared = prepareWith({}, { tools: [LOOKUP], temperature: 0.5 })
    const snapshot = prepared.snapshot
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.request)).toBe(true)
    expect(Object.isFrozen(snapshot.request.segment1Static)).toBe(true)
    expect(Object.isFrozen(snapshot.request.segment2WarmHistory)).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities.supportedEfforts)).toBe(true)
    expect(Object.isFrozen(snapshot.sampling)).toBe(true)
    expect(Object.isFrozen(snapshot.tools)).toBe(true)
    expect(Object.isFrozen(snapshot.effectiveToolChoice)).toBe(true)
    // Frozen values reject writes without relying on module strict-mode throws.
    expect(Reflect.set(snapshot, 'effectiveEffort', 'max')).toBe(false)
    expect(Reflect.set(snapshot.sampling, 'cacheRetention', 'long')).toBe(false)
    expect(Reflect.defineProperty(snapshot, 'effectiveEffort', { value: 'max' })).toBe(false)
    expect(Reflect.set(snapshot.request, 'sharedPrefixKey', NONE)).toBe(false)
  })

  test('the request snapshot is a defensive copy of the caller object', () => {
    const { service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    const request = requestFixture()
    const prepared = expectOk(
      service.prepareChatCall({ kind: 'explicit', routeId: ROUTE, modelId: MODEL }, request),
    )
    expect(prepared.snapshot.request).not.toBe(request)
    expect(prepared.snapshot.request.segment2WarmHistory).not.toBe(request.segment2WarmHistory)
  })

  test('binding locks the adapter generation used at preparation time', async () => {
    const { service } = setup()
    const first = new MockAdapter({ turns: [{ kind: 'text', text: 'first-generation' }] })
    const second = new MockAdapter({ turns: [{ kind: 'text', text: 'second-generation' }] })
    const handle = expectOk(service.registerChatAdapter([ROUTE], first))
    const prepared = expectOk(prepare(service))

    expectOk(handle.replace([]))
    expectOk(service.registerChatAdapter([ROUTE], second))

    const chunks = await collect(prepared.stream(new AbortController().signal))
    const text = chunks
      .filter(
        (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta',
      )
      .map((chunk) => chunk.delta)
      .join('')
    expect(text).toBe('first-generation')
    expect(first.requests.length).toBe(1)
    expect(second.requests.length).toBe(0)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  test('stream is one-shot', async () => {
    const prepared = prepareWith({})
    await collect(prepared.stream(new AbortController().signal))
    expect(() => prepared.stream(new AbortController().signal)).toThrow(InvariantError)

    // A rejected signal argument must not burn the one-shot latch.
    const fresh = prepareWith({})
    expect(() => fresh.stream(undefined as unknown as AbortSignal)).toThrow(InvariantError)
    await collect(fresh.stream(new AbortController().signal))
  })

  test('a pre-aborted signal yields one aborted frame and never touches the adapter', async () => {
    const { service } = setup()
    const adapter = new MockAdapter()
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    const prepared = expectOk(prepare(service))
    const controller = new AbortController()
    controller.abort()
    const chunks = await collect(prepared.stream(controller.signal))
    expect(chunks.length).toBe(1)
    const finish = chunks[0]
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') return
    expect(finish.reason.kind).toBe('aborted')
    if (finish.reason.kind !== 'aborted') return
    expect(finish.reason.failure.code).toBe('ABORTED')
    expect(finish.observedAttempts).toBe(0)
    expect(adapter.physicalAttempts()).toBe(0)
  })

  test('an aborted transport mid-stream ends as an aborted finish', async () => {
    const { service } = setup()
    const abortError = Object.assign(new Error('transport aborted'), { name: 'AbortError' })
    const adapter = new MockAdapter({
      turns: [{ kind: 'throw', error: abortError, prefix: { text: 'partial' } }],
    })
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    const prepared = expectOk(prepare(service))
    const chunks = await collect(prepared.stream(new AbortController().signal))
    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') return
    expect(finish.reason.kind).toBe('aborted')
    expect(finish.observedAttempts).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/*                              Waterfall pipeline                          */
/* -------------------------------------------------------------------------- */

describe('llm/stream waterfall', () => {
  test('listeners observe the frozen snapshot and may filter frames', async () => {
    const { ctx, service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    let seenEffort = ''
    ctx.on('llm/stream', (prepared, next) => {
      seenEffort = prepared.effectiveEffort
      expect(Object.isFrozen(prepared)).toBe(true)
      return (async function* filtered(): AsyncGenerator<StreamChunk> {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') continue
          yield chunk
        }
      })()
    })
    const prepared = expectOk(prepare(service, { effort: 'low' }))
    const chunks = await collect(prepared.stream(new AbortController().signal))
    expect(seenEffort).toBe('low')
    expect(chunks.some((chunk) => chunk.type === 'usage')).toBe(false)
    expect(chunks.at(-1)?.type).toBe('finish')
  })

  test.each(['remove', 'insert'] as const)(
    'a listener may %s blocks only with a matching replay envelope',
    async (mode) => {
      for (const alignReplay of [true, false]) {
        const { ctx, service } = setup()
        const adapter = new MockAdapter({
          emitReplayState: true,
          turns: [{ kind: 'text', reasoning: 'plan', text: 'answer' }],
        })
        expectOk(service.registerChatAdapter([ROUTE], adapter))
        ctx.on('llm/stream', (_prepared, next) =>
          (async function* (): AsyncIterable<StreamChunk> {
            for await (const chunk of next()) {
              if (chunk.type === 'first-byte') {
                yield chunk
                if (mode === 'insert') {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  yield { type: 'text-delta', index: 0, delta: 'prefix' }
                  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'prefix' } }
                }
              } else if ('index' in chunk) {
                if (mode === 'remove' && chunk.index === 0) continue
                yield { ...chunk, index: chunk.index + (mode === 'insert' ? 1 : -1) }
              } else if (chunk.type === 'finish' && alignReplay && isSome(chunk.replayState)) {
                const replay = chunk.replayState.value
                if (replay.blocks === undefined) throw new Error('mock replay blocks missing')
                yield {
                  ...chunk,
                  replayState: some({
                    ...replay,
                    blocks:
                      mode === 'remove'
                        ? replay.blocks.slice(1)
                        : [{ local: 'prefix' }, ...replay.blocks],
                  }),
                }
              } else {
                yield chunk
              }
            }
          })(),
        )
        try {
          const stream = expectOk(prepare(service)).stream(new AbortController().signal)
          if (!alignReplay) {
            await expect(collect(stream)).rejects.toThrow(InvariantError)
            continue
          }
          const chunks = await collect(stream)
          expect(
            chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
          ).toEqual(
            mode === 'remove'
              ? [{ type: 'text', text: 'answer' }]
              : [
                  { type: 'text', text: 'prefix' },
                  { type: 'reasoning', text: 'plan' },
                  { type: 'text', text: 'answer' },
                ],
          )
          const finish = chunks.at(-1)
          if (finish?.type !== 'finish' || !isSome(finish.replayState))
            throw new Error('missing replay finish')
          expect(finish.reason.kind).toBe('stop')
          expect(finish.replayState.value.blocks).toEqual(
            mode === 'remove' ? [{ index: 1 }] : [{ local: 'prefix' }, { index: 0 }, { index: 1 }],
          )
        } finally {
          await ctx.fiber.dispose()
        }
      }
    },
  )

  test('a listener may short-circuit without calling next', async () => {
    const { ctx, service } = setup()
    const adapter = new MockAdapter()
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    ctx.on('llm/stream', () => {
      return (async function* substitute(): AsyncGenerator<StreamChunk> {
        yield { type: 'first-byte' }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, delta: 'cached answer' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'cached answer' } }
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: NONE, observedAttempts: 1 }
      })()
    })
    const prepared = expectOk(prepare(service))
    const chunks = await collect(prepared.stream(new AbortController().signal))
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    expect(adapter.physicalAttempts()).toBe(0)
  })

  test('calling next twice is an invariant failure', () => {
    const { ctx, service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    ctx.on('llm/stream', (_prepared, next) => {
      void next()
      return next()
    })
    const prepared = expectOk(prepare(service))
    expect(() => prepared.stream(new AbortController().signal)).toThrow(InvariantError)
  })

  test('a listener that catches the second next() still observes InvariantError', async () => {
    const { ctx, service } = setup()
    const adapter = new MockAdapter()
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    let observed: unknown
    ctx.on('llm/stream', (_prepared, next) => {
      void next()
      try {
        next()
      } catch (error) {
        observed = error
      }
      return (async function* substitute(): AsyncGenerator<StreamChunk> {
        yield { type: 'first-byte' }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, delta: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'finish', reason: { kind: 'stop' }, replayState: NONE, observedAttempts: 1 }
      })()
    })
    const prepared = expectOk(prepare(service))
    const chunks = await collect(prepared.stream(new AbortController().signal))
    expect(observed).toBeInstanceOf(InvariantError)
    expect(chunks.at(-1)?.type).toBe('finish')
    expect(adapter.physicalAttempts()).toBe(0)
  })

  test('listeners that return a non-iterable are rejected', () => {
    const { ctx, service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    ctx.on('llm/stream', (() => 42) as unknown as () => AsyncIterable<StreamChunk>)
    const prepared = expectOk(prepare(service))
    expect(() => prepared.stream(new AbortController().signal)).toThrow(InvariantError)
  })

  test('synchronous listener exceptions propagate unchanged', () => {
    const { ctx, service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    ctx.on('llm/stream', () => {
      throw new Error('listener-boom')
    })
    const prepared = expectOk(prepare(service))
    expect(() => prepared.stream(new AbortController().signal)).toThrow('listener-boom')
  })

  test('asynchronous listener exceptions close the adapter iterator and propagate', async () => {
    const { ctx, service } = setup()
    const closed = { value: false }
    const adapter: ChatAdapter = {
      adapterKind: 'tracking',
      retryOwnership: 'caller-owned-single-attempt',
      resolveCapabilities: () => ({ ok: true, value: new MockAdapter().capabilities }),
      bindGeneration: () => ({
        ok: true,
        value: () =>
          (async function* tracked(): AsyncGenerator<StreamChunk> {
            try {
              yield { type: 'first-byte' }
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, delta: 'one' }
            } finally {
              closed.value = true
            }
            return
          })(),
      }),
    }
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    ctx.on('llm/stream', (_prepared, next) => {
      return (async function* failing(): AsyncGenerator<StreamChunk> {
        for await (const chunk of next()) {
          yield chunk
          throw new Error('listener-async-boom')
        }
      })()
    })
    const prepared = expectOk(prepare(service))
    const iterator = prepared.stream(new AbortController().signal)[Symbol.asyncIterator]()
    const seen: StreamChunk[] = []
    await expect(
      (async () => {
        for (;;) {
          const step = await iterator.next()
          if (step.done === true) return
          seen.push(step.value)
        }
      })(),
    ).rejects.toThrow('listener-async-boom')
    expect(seen.length).toBeGreaterThan(0)
    expect(closed.value).toBe(true)
  })

  test('consumer early exit closes the adapter iterator', async () => {
    const { service } = setup()
    const closed = { value: false }
    const adapter: ChatAdapter = {
      adapterKind: 'tracking',
      retryOwnership: 'caller-owned-single-attempt',
      resolveCapabilities: () => ({ ok: true, value: new MockAdapter().capabilities }),
      bindGeneration: () => ({
        ok: true,
        value: () =>
          (async function* tracked(): AsyncGenerator<StreamChunk> {
            try {
              yield { type: 'first-byte' }
              yield { type: 'block-start', index: 0, blockType: 'text' }
              yield { type: 'text-delta', index: 0, delta: 'one' }
              yield { type: 'block-end', index: 0, block: { type: 'text', text: 'one' } }
              yield {
                type: 'finish',
                reason: { kind: 'stop' },
                replayState: NONE,
                observedAttempts: 1,
              }
            } finally {
              closed.value = true
            }
          })(),
      }),
    }
    expectOk(service.registerChatAdapter([ROUTE], adapter))
    const prepared = expectOk(prepare(service))
    for await (const chunk of prepared.stream(new AbortController().signal)) {
      if (chunk.type === 'text-delta') break
    }
    // Allow the generator's finally block to run on the microtask queue.
    await Promise.resolve()
    await Promise.resolve()
    expect(closed.value).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*                            Request prevalidation                          */
/* -------------------------------------------------------------------------- */

describe('request prevalidation', () => {
  function prepareRaw(request: unknown) {
    const { service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    return service.prepareChatCall(
      { kind: 'explicit', routeId: ROUTE, modelId: MODEL },
      request as CacheAlignedChatRequest,
    )
  }

  test('rejects ill-formed Unicode anywhere in the request', () => {
    const lone = 'broken \uD800 surrogate'
    expectErrCode(prepareRaw(requestFixture(lone)), 'INVALID_REQUEST')
    const solid = requestFixture()
    expectErrCode(
      prepareRaw({
        ...solid,
        segment1Static: [{ name: 'system', text: lone }],
      }),
      'INVALID_REQUEST',
    )
    expectErrCode(prepareRaw({ ...solid, segment3VolatileTail: some(lone) }), 'INVALID_REQUEST')
    expectErrCode(prepareRaw({ ...solid, sharedPrefixKey: some(lone) }), 'INVALID_REQUEST')
  })

  test('requires genuine Option containers and known roles', () => {
    const solid = requestFixture()
    expectErrCode(prepareRaw({ ...solid, segment3VolatileTail: undefined }), 'INVALID_REQUEST')
    expectErrCode(prepareRaw({ ...solid, sharedPrefixKey: 'group' }), 'INVALID_REQUEST')
    expectErrCode(
      prepareRaw({ ...solid, segment2WarmHistory: [{ role: 'system', content: [] }] }),
      'INVALID_REQUEST',
    )
    expectErrCode(
      prepareRaw({
        ...solid,
        segment2WarmHistory: [{ role: 'user', content: [{ type: 'reasoning', text: 'x' }] }],
      }),
      'INVALID_REQUEST',
    )
    expectErrCode(
      prepareRaw({
        ...solid,
        segment2WarmHistory: [
          { role: 'tool-result', toolCallId: 'call-1', content: 'x', isError: false },
        ],
      }),
      'INVALID_REQUEST',
    )
  })

  test('validates assistant replay alignment', () => {
    const assistant = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: 'call-1', name: 'lookup', argumentsJson: '{}' },
      ],
      origin: {
        routeId: ROUTE,
        modelId: MODEL,
        replayState: some({ adapterKind: 'mock', version: 1, response: {}, blocks: [{}] }),
      },
    }
    const solid = requestFixture()
    expectErrCode(prepareRaw({ ...solid, segment2WarmHistory: [assistant] }), 'INVALID_REQUEST')
    expectOk(
      prepareRaw({
        ...solid,
        segment2WarmHistory: [
          {
            ...assistant,
            origin: {
              routeId: ROUTE,
              modelId: MODEL,
              replayState: some({
                adapterKind: 'mock',
                version: 1,
                response: {},
                blocks: [{}, {}],
              }),
            },
          },
        ],
      }),
    )
  })

  test('validates tool arguments before calling the adapter', () => {
    const { service } = setup()
    expectOk(service.registerChatAdapter([ROUTE], new MockAdapter()))
    expectErrCode(prepare(service, { tools: [LOOKUP, { ...LOOKUP }] }), 'INVALID_REQUEST')
    expectErrCode(
      prepare(service, { tools: [LOOKUP], toolChoice: { kind: 'named', toolName: 'missing' } }),
      'INVALID_REQUEST',
    )
    expectErrCode(prepare(service, { toolChoice: { kind: 'required' } }), 'INVALID_REQUEST')
    expectErrCode(prepare(service, { temperature: 5 }), 'INVALID_REQUEST')
    expectErrCode(prepare(service, { topP: 0 }), 'INVALID_REQUEST')
    expectErrCode(prepare(service, { stopSequences: [''] }), 'INVALID_REQUEST')
    expectErrCode(
      prepare(service, { effort: 'turbo' as NonNullable<ChatCallOverrides['effort']> }),
      'INVALID_REQUEST',
    )
    expectErrCode(
      prepare(service, {
        cacheRetention: 'forever' as NonNullable<ChatCallOverrides['cacheRetention']>,
      }),
      'INVALID_REQUEST',
    )
    expectErrCode(prepare(service, { sessionAffinityKey: '' }), 'INVALID_REQUEST')
  })

  test('a tool-free auto choice ignores the empty tool list', () => {
    const prepared = prepareWith({}, { toolChoice: AUTO_TOOL_CHOICE })
    expect(prepared.snapshot.tools).toEqual([])
    expect(prepared.snapshot.effectiveToolChoice).toEqual(AUTO_TOOL_CHOICE)
  })
})

/* -------------------------------------------------------------------------- */
/*                                  Retrieval                               */
/* -------------------------------------------------------------------------- */

class EmbeddingFixture implements EmbeddingAdapter {
  readonly adapterKind = 'embedding-fixture'
  readonly calls: { texts: readonly string[]; dimensions: number | undefined }[] = []
  source: Float32Array[] = [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])]
  failure: LlmFailure | undefined
  reject = false

  async embed(
    _routeId: RouteId,
    _modelId: ModelId,
    texts: readonly string[],
    options: { readonly dimensions?: number; readonly signal: AbortSignal },
  ): Promise<Result<EmbeddingBatchResult, LlmFailure>> {
    this.calls.push({ texts, dimensions: options.dimensions })
    if (this.reject) throw new Error('adapter exploded')
    if (this.failure !== undefined) return { ok: false, error: this.failure }
    return {
      ok: true,
      value: {
        vectors: this.source,
        totalPromptTokens: some(3),
      },
    }
  }
}

class RerankFixture implements RerankAdapter {
  readonly adapterKind = 'rerank-fixture'
  readonly calls: { query: string; documents: readonly string[]; topN: number | undefined }[] = []
  items: RerankScoreItem[] = [
    { index: 1, relevanceScore: 0.9 },
    { index: 0, relevanceScore: 0.1 },
  ]

  async rerank(
    _routeId: RouteId,
    _modelId: ModelId,
    query: string,
    documents: readonly string[],
    options: { readonly topN?: number; readonly signal: AbortSignal },
  ): Promise<Result<readonly RerankScoreItem[], LlmFailure>> {
    this.calls.push({ query, documents, topN: options.topN })
    return { ok: true, value: this.items }
  }
}

describe('embedding and rerank plumbing', () => {
  test('resolves profiles, forwards dimensions and copies vectors', async () => {
    const { service } = setup()
    const embedding = new EmbeddingFixture()
    const shared = new Float32Array([1, 2, 3, 4])
    embedding.source = [shared.subarray(0, 3), shared.subarray(1, 4)]
    expectOk(service.registerEmbeddingAdapter([ROUTE], embedding))
    expectOk(
      service.configureProfiles({
        chatProfiles: {},
        embeddingProfiles: {
          vectors: { routeId: ROUTE, modelId: MODEL, dimensions: 3 },
        },
        rerankProfiles: {},
      }),
    )
    const result = expectOk(
      await service.embed({ kind: 'profile', profileId: 'vectors' as ProfileId }, ['a', 'b']),
    )
    expect(embedding.calls[0]?.dimensions).toBe(3)
    expect(result.vectors.length).toBe(2)
    expect(result.vectors[0]).not.toBe(embedding.source[0])
    expect(result.vectors[0]?.buffer).not.toBe(result.vectors[1]?.buffer)
    const first = result.vectors[0]
    const second = result.vectors[1]
    if (first === undefined || second === undefined) throw new Error('missing embedding vector')
    first[1] = 99
    expect(shared[1]).toBe(2)
    expect(second[0]).toBe(2)
    shared[2] = 77
    expect(first[2]).toBe(3)
    expect(second[1]).toBe(3)
    expect(result.totalPromptTokens).toEqual(some(3))
  })

  test('rejects malformed embedding payloads instead of returning them', async () => {
    const { service } = setup()
    const embedding = new EmbeddingFixture()
    expectOk(service.registerEmbeddingAdapter([ROUTE], embedding))
    const target = { kind: 'explicit' as const, routeId: ROUTE, modelId: MODEL }
    embedding.source = [new Float32Array([1, 2])]
    await expect(service.embed(target, ['a', 'b'])).rejects.toThrow(InvariantError)
    embedding.source = [new Float32Array([1, 2]), new Float32Array([3])]
    await expect(service.embed(target, ['a', 'b'])).rejects.toThrow(InvariantError)
    embedding.source = [new Float32Array([1, Number.NaN]), new Float32Array([3, 4])]
    await expect(service.embed(target, ['a', 'b'])).rejects.toThrow(InvariantError)
    embedding.source = [new Float32Array([1, 2]), new Float32Array([3, 4])]
    embedding.reject = true
    await expect(service.embed(target, ['a', 'b'])).rejects.toThrow(InvariantError)
    embedding.reject = false
    embedding.failure = failure('RATE_LIMIT', 'slow down')
    expectErrCode(await service.embed(target, ['a', 'b']), 'RATE_LIMIT')
  })

  test('embedding boundaries: registration, inputs, signals', async () => {
    const { service } = setup()
    const target = { kind: 'explicit' as const, routeId: ROUTE, modelId: MODEL }
    expectErrCode(await service.embed(target, ['a']), 'NO_ROUTE')
    const embedding = new EmbeddingFixture()
    expectOk(service.registerEmbeddingAdapter([ROUTE], embedding))
    expectErrCode(await service.embed(target, []), 'INVALID_REQUEST')
    expectErrCode(await service.embed(target, ['ok', 'bad \uD800']), 'INVALID_REQUEST')
    expectErrCode(await service.embed({ ...target, dimensions: 0 }, ['a']), 'INVALID_REQUEST')
    const controller = new AbortController()
    controller.abort()
    expectErrCode(await service.embed(target, ['a'], { signal: controller.signal }), 'ABORTED')
    expect(embedding.calls.length).toBe(0)
    embedding.source = [new Float32Array([1, 2, 3])]
    expectOk(await service.embed(target, ['a'], {}))
  })

  test('rerank validates scores and bounds', async () => {
    const { service } = setup()
    const rerank = new RerankFixture()
    expectOk(service.registerRerankAdapter([ROUTE], rerank))
    const target = { kind: 'explicit' as const, routeId: ROUTE, modelId: MODEL }
    const result = expectOk(await service.rerank(target, 'query', ['one', 'two'], { topN: 2 }))
    expect(rerank.calls[0]?.topN).toBe(2)
    expect(result).toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.1 },
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0])).toBe(true)

    rerank.items = [{ index: 2, relevanceScore: 0.5 }]
    await expect(service.rerank(target, 'query', ['one', 'two'])).rejects.toThrow(InvariantError)
    rerank.items = [
      { index: 0, relevanceScore: 0.5 },
      { index: 0, relevanceScore: 0.4 },
    ]
    await expect(service.rerank(target, 'query', ['one', 'two'])).rejects.toThrow(InvariantError)
    rerank.items = [{ index: 0, relevanceScore: Number.POSITIVE_INFINITY }]
    await expect(service.rerank(target, 'query', ['one', 'two'])).rejects.toThrow(InvariantError)

    expectErrCode(await service.rerank(target, '', ['one']), 'INVALID_REQUEST')
    expectErrCode(await service.rerank(target, 'query', []), 'INVALID_REQUEST')
    expectErrCode(
      await service.rerank(target, 'query', ['one', 'two'], { topN: 3 }),
      'INVALID_REQUEST',
    )
    expectErrCode(await service.rerank(target, 'query', ['one'], { topN: 0 }), 'INVALID_REQUEST')
    expectErrCode(await service.rerank(target, 'query', ['bad \uD800']), 'INVALID_REQUEST')
  })
})
