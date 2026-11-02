import { InvariantError } from '@sekaisen/core'
import { Context } from 'cordis'
import { LlmService } from './service.ts'
import type { ChatAdapter, ChatCallOverrides } from './service-types.ts'
import type {
  CacheAlignedChatRequest,
  LlmFailureCode,
  ModelId,
  RouteId,
  StreamChunk,
} from './types.ts'

/** Transport fixtures must simulate these upstream outcomes without live credentials. */
export type AdapterConformanceScenario =
  | 'text'
  | 'tools'
  | 'truncated'
  | 'invalid-request'
  | 'rate-limit'
  | 'server-error'
  | 'interrupted-tool'
  | 'pre-aborted'
  | 'empty-response'

export interface AdapterConformanceFixture {
  readonly adapter: ChatAdapter
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly request: CacheAlignedChatRequest
  readonly overrides?: ChatCallOverrides
  /** Count real transport calls, not emitted semantic events. */
  readonly physicalAttempts: () => number
}
export interface AdapterConformanceResult {
  readonly scenario: AdapterConformanceScenario
  readonly chunks: readonly StreamChunk[]
}

const scenarios: readonly AdapterConformanceScenario[] = [
  'text',
  'tools',
  'truncated',
  'invalid-request',
  'rate-limit',
  'server-error',
  'interrupted-tool',
  'pre-aborted',
  'empty-response',
]
const expectedErrors: Partial<Record<AdapterConformanceScenario, LlmFailureCode>> = {
  'invalid-request': 'INVALID_REQUEST',
  'rate-limit': 'RATE_LIMIT',
  'server-error': 'SERVER',
  'interrupted-tool': 'TRANSPORT',
  'pre-aborted': 'ABORTED',
  'empty-response': 'EMPTY_RESPONSE',
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(`Adapter conformance: ${message}`)
}

/**
 * Run the same lifecycle contract against any adapter using fault-injected upstream fixtures.
 * The service supplies independent protocol guards, so invalid transitions throw immediately.
 * Fixtures own wire-level cache/replay/credential assertions; no provider-specific SDK enters this module.
 */
export async function runAdapterConformanceSuite(
  createFixture: (
    scenario: AdapterConformanceScenario,
  ) => AdapterConformanceFixture | Promise<AdapterConformanceFixture>,
): Promise<readonly AdapterConformanceResult[]> {
  const results: AdapterConformanceResult[] = []
  for (const scenario of scenarios) {
    const fixture = await createFixture(scenario)
    const ctx = new Context()
    const service = new LlmService(ctx)
    try {
      const registered = service.registerChatAdapter([fixture.routeId], fixture.adapter)
      assert(registered.ok, `${scenario}: route registration failed`)
      const prepared = service.prepareChatCall(
        { kind: 'explicit', routeId: fixture.routeId, modelId: fixture.modelId },
        fixture.request,
        fixture.overrides,
      )
      assert(prepared.ok, `${scenario}: preparation failed`)
      const controller = new AbortController()
      if (scenario === 'pre-aborted') controller.abort()
      const chunks: StreamChunk[] = []
      for await (const chunk of prepared.value.stream(controller.signal)) chunks.push(chunk)
      const finish = chunks.at(-1)
      assert(finish?.type === 'finish', `${scenario}: terminal frame missing`)
      const attempts = fixture.physicalAttempts()
      assert(
        finish.observedAttempts === attempts,
        `${scenario}: attempt counter disagrees with transport`,
      )
      if (fixture.adapter.retryOwnership === 'caller-owned-single-attempt')
        assert(attempts <= 1, `${scenario}: direct adapter retried`)
      assert(
        attempts === (scenario === 'pre-aborted' ? 0 : 1) ||
          (fixture.adapter.retryOwnership === 'adapter-managed-transport-and-auth' &&
            scenario !== 'pre-aborted' &&
            attempts > 1),
        `${scenario}: unexpected physical request count`,
      )
      const error = expectedErrors[scenario]
      if (error !== undefined) {
        assert(
          finish.reason.kind === (scenario === 'pre-aborted' ? 'aborted' : 'error'),
          `${scenario}: expected failure`,
        )
        assert(
          finish.reason.kind === 'error' || finish.reason.kind === 'aborted',
          `${scenario}: failure detail missing`,
        )
        assert(finish.reason.failure.code === error, `${scenario}: wrong failure code`)
        if (scenario !== 'interrupted-tool')
          assert(
            !chunks.some((chunk) => chunk.type === 'first-byte'),
            `${scenario}: pre-output failure emitted a semantic first-byte`,
          )
        assert(
          finish.replayState.kind === 'none',
          `${scenario}: failed response retained replay state`,
        )
      } else {
        const expected =
          scenario === 'tools' ? 'tool-calls' : scenario === 'truncated' ? 'max-tokens' : 'stop'
        assert(finish.reason.kind === expected, `${scenario}: wrong success reason`)
        assert(
          chunks.some((chunk) => chunk.type === 'block-end'),
          `${scenario}: no completed content`,
        )
      }
      if (scenario === 'interrupted-tool') {
        assert(
          chunks.some((chunk) => chunk.type === 'tool-call-delta'),
          `${scenario}: fixture did not exercise partial tool output`,
        )
        assert(
          chunks.filter((chunk) => chunk.type === 'first-byte').length === 1,
          `${scenario}: replayed first-byte`,
        )
        assert(attempts === 1, `${scenario}: post-output retry`)
      }
      if (scenario === 'pre-aborted')
        assert(chunks.length === 1, `${scenario}: aborted-before-send produced semantic output`)
      results.push(Object.freeze({ scenario, chunks: Object.freeze(chunks) }))
    } finally {
      await ctx.fiber.dispose()
    }
  }
  return Object.freeze(results)
}
