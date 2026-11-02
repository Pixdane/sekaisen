import { describe, expect, test } from 'bun:test'
import { InvariantError } from '@sekaisen/core'
import { LlmService, MockAdapter, type ModelId, type RouteId } from '@sekaisen/plugin-llm'
import {
  apply,
  type OmpAuthStorageLike,
  OmpPiAiAdapter,
  type OmpRouteConfig,
} from '@sekaisen/plugin-llm-omp'
import { Context } from 'cordis'

const ROUTE = 'omp:resource-boundaries' as RouteId
const MODEL = 'claude-sonnet-4-5' as ModelId

const ROUTES: Readonly<Record<string, OmpRouteConfig>> = Object.freeze({
  [ROUTE]: Object.freeze({ provider: 'anthropic' }),
})

function fakeStorage(close?: () => void | Promise<void>): OmpAuthStorageLike {
  return {
    keys: {
      resolver: () => async () => 'test-key',
    },
    ...(close === undefined ? {} : { close }),
  }
}

describe('owned credential-store lifecycle', () => {
  test('closes a store discovered after disposal exactly once', async () => {
    const discovery = Promise.withResolvers<OmpAuthStorageLike>()
    let closes = 0
    const adapter = new OmpPiAiAdapter({
      routes: ROUTES,
      discoverAuthStorage: () => discovery.promise,
    })

    const first = adapter.dispose()
    const second = adapter.dispose()
    expect(closes).toBe(0)

    discovery.resolve(
      fakeStorage(() => {
        closes += 1
      }),
    )
    await Promise.all([first, second])

    expect(closes).toBe(1)
    await adapter.dispose()
    expect(closes).toBe(1)
  })

  test('closes the discovered store exactly once when the plugin fiber unloads', async () => {
    const ctx = new Context()
    const service = new LlmService(ctx)
    let closes = 0
    const fiber = ctx.plugin((scope: Context) => {
      apply(scope, {
        routes: ROUTES,
        discoverAuthStorage: async () =>
          fakeStorage(() => {
            closes += 1
          }),
      })
    })

    await fiber
    expect(service.listChatRoutes()).toEqual([ROUTE])
    await fiber.dispose()

    expect(service.listChatRoutes()).toEqual([])
    expect(closes).toBe(1)
  })

  test('never closes an injected or static-key credential source', async () => {
    let borrowedCloses = 0
    const borrowed = fakeStorage(() => {
      borrowedCloses += 1
    })
    const ctx = new Context()
    new LlmService(ctx)
    const fiber = ctx.plugin((scope: Context) => {
      apply(scope, { routes: ROUTES, authStorage: borrowed })
    })
    await fiber
    await fiber.dispose()
    expect(borrowedCloses).toBe(0)

    let discoveries = 0
    const staticAdapter = new OmpPiAiAdapter({
      routes: ROUTES,
      resolveApiKey: async () => 'test-key',
      discoverAuthStorage: () => {
        discoveries += 1
        return Promise.reject(new Error('must not open the credential store'))
      },
    })
    await staticAdapter.ready()
    await staticAdapter.dispose()

    expect(discoveries).toBe(0)
  })

  test('settles disposal when discovery rejects after disposal', async () => {
    const discovery = Promise.withResolvers<OmpAuthStorageLike>()
    const adapter = new OmpPiAiAdapter({
      routes: ROUTES,
      discoverAuthStorage: () => discovery.promise,
    })

    const disposal = adapter.dispose()
    discovery.reject(new Error('late broker failure'))
    await disposal

    const bound = adapter.bindGeneration(ROUTE, MODEL)
    expect(bound.ok).toBe(false)
    if (!bound.ok) expect(bound.error.code).toBe('REGISTRATION_DISPOSED')
  })

  test('disposes an owned store when route registration fails', async () => {
    const ctx = new Context()
    const service = new LlmService(ctx)
    expect(service.registerChatAdapter([ROUTE], new MockAdapter()).ok).toBe(true)
    const discovery = Promise.withResolvers<OmpAuthStorageLike>()
    const closed = Promise.withResolvers<void>()
    let closes = 0
    let failure: unknown
    const fiber = ctx.plugin((scope: Context) => {
      try {
        apply(scope, {
          routes: ROUTES,
          discoverAuthStorage: () => discovery.promise,
        })
      } catch (cause) {
        failure = cause
      }
    })

    await fiber
    expect(failure).toBeInstanceOf(InvariantError)
    expect((failure as Error).message).toContain('DUPLICATE_ROUTE')

    discovery.resolve(
      fakeStorage(() => {
        closes += 1
        closed.resolve()
      }),
    )
    await closed.promise

    expect(closes).toBe(1)
    await fiber.dispose()
  })

  test('sanitizes asynchronous close failures and settles them once', async () => {
    const secret = 'sk-test-resource-boundary-secret'
    let closes = 0
    const adapter = new OmpPiAiAdapter({
      routes: ROUTES,
      discoverAuthStorage: async () =>
        fakeStorage(async () => {
          closes += 1
          throw new Error(`broker rejected token ${secret}`)
        }),
    })

    await adapter.ready()
    const failure = await adapter.dispose().then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(failure).toBeInstanceOf(InvariantError)
    expect((failure as Error).message).not.toContain(secret)
    expect((failure as Error).message).not.toContain('sk-test')
    expect(closes).toBe(1)

    await adapter.dispose().catch(() => {
      // The cached disposal settlement stays handled.
    })
    expect(closes).toBe(1)
    await Promise.resolve()
  })

  test('surfaces a discovery failure once and disposes without a store', async () => {
    let discoveries = 0
    const adapter = new OmpPiAiAdapter({
      routes: ROUTES,
      discoverAuthStorage: () => {
        discoveries += 1
        return Promise.reject(new Error('credential broker is unreachable'))
      },
    })

    await expect(adapter.ready()).rejects.toThrow('credential broker is unreachable')
    await adapter.dispose()
    expect(discoveries).toBe(1)

    await expect(
      OmpPiAiAdapter.create({
        routes: ROUTES,
        discoverAuthStorage: () => Promise.reject(new Error('startup failed')),
      }),
    ).rejects.toThrow('startup failed')
  })

  test('a disposed adapter refuses new work conservatively', async () => {
    const adapter = new OmpPiAiAdapter({
      routes: ROUTES,
      discoverAuthStorage: async () => fakeStorage(),
    })
    await adapter.dispose()

    await expect(adapter.ready()).rejects.toThrow(InvariantError)
    const bound = adapter.bindGeneration(ROUTE, MODEL)
    expect(bound.ok).toBe(false)
    if (!bound.ok) expect(bound.error.code).toBe('REGISTRATION_DISPOSED')
  })
})
