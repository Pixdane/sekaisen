import type { Result } from '@sekaisen/core'
import { err, InvariantError, NONE, ok } from '@sekaisen/core'
import type {
  AdapterRetryOwnership,
  BoundWireChatRequest,
  ChatAdapter,
  LlmFailure,
  ModelCapabilities,
  ModelId,
  RouteId,
  StreamChunk,
} from '@sekaisen/plugin-llm'
import {
  discoverOmpAuthStorage,
  type OmpApiKeyResolver,
  type OmpAuthDiscovery,
  type OmpAuthStorageLike,
} from './auth.ts'
import { OMP_SUPPORTED_APIS, ompModelCapabilities } from './capabilities.ts'
import type { OmpPiAiAdapterOptions, OmpRouteConfig } from './config.ts'
import { freezeOmpRoutes } from './config.ts'
import { attachCacheAnchoring, convertOmpContext, convertOmpOptions } from './convert.ts'
import { classifyOmpAuthFailure, ompFailure, rememberCredentialSecret } from './failures.ts'
import type { ApiKey, FetchImpl, OmpModelResolver, OmpStreamBackend, PiModel } from './pi-ai.ts'
import { ompDefaultModelResolver, ompDefaultStreamBackend } from './pi-ai.ts'
import { createOmpProbes, OmpCallState } from './probes.ts'
import { runOmpCall } from './stream.ts'

/** Adapter kind recorded in neutral provenance and replay envelopes. */
export const OMP_PI_AI_ADAPTER_KIND = 'omp:pi-ai'

interface ResolvedTarget {
  readonly route: OmpRouteConfig
  readonly model: PiModel
}

const OMP_CALL_ABORTED: unique symbol = Symbol('omp.call.aborted')

/**
 * Sanitized close failure text. The original cause is never attached: broker or
 * transport errors may embed endpoints or credential material.
 */
const OMP_CLOSE_FAILURE = '@sekaisen/plugin-llm-omp owned credential store close failed'

/**
 * Races one per-call wait against caller cancellation without cancelling the
 * shared credential discovery promise. Cancellation wins even when the work
 * rejects at the same time.
 */
async function raceOmpCallWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof OMP_CALL_ABORTED> {
  if (signal.aborted) return OMP_CALL_ABORTED
  const aborted = Promise.withResolvers<typeof OMP_CALL_ABORTED>()
  const onAbort = (): void => aborted.resolve(OMP_CALL_ABORTED)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) aborted.resolve(OMP_CALL_ABORTED)
  try {
    try {
      const value = await Promise.race([work, aborted.promise])
      return signal.aborted ? OMP_CALL_ABORTED : value
    } catch (error) {
      if (signal.aborted) return OMP_CALL_ABORTED
      throw error
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Lazy credential session. Discovery is asynchronous while
 * `ChatAdapter.bindGeneration()` is synchronous, so the adapter captures the
 * discovery promise at construction and each bound stream awaits the same
 * generation. A discovery failure is converted into a terminal
 * `MISSING_CREDENTIAL` finish on every stream attempted by that generation.
 *
 * A store this session discovered is owned and closed exactly once by
 * `dispose()`; an injected `authStorage` is borrowed and never closed.
 */
class OmpAuthSession {
  #storage: OmpAuthStorageLike | undefined = undefined
  #promise: Promise<OmpAuthStorageLike> | undefined = undefined
  #startupError: unknown = undefined
  #staticKey: ((provider: string) => Promise<string | undefined>) | undefined = undefined
  #owned = false
  #disposed = false
  #disposePromise: Promise<void> | undefined = undefined
  #closePromise: Promise<void> | undefined = undefined

  constructor(options: OmpPiAiAdapterOptions) {
    if (options.authStorage !== undefined) {
      this.#storage = options.authStorage
      return
    }
    if (options.resolveApiKey !== undefined) {
      this.#staticKey = options.resolveApiKey
      return
    }
    this.#owned = true
    const discover: OmpAuthDiscovery = options.discoverAuthStorage ?? discoverOmpAuthStorage
    const promise = discover({
      ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
      ...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
    }).then(
      (storage) => {
        this.#storage = storage
        if (this.#disposed) {
          // Discovery may finish after disposal; release the store immediately.
          void this.#closeOwned(storage).catch(() => {
            // `dispose()` awaits the same close promise; this handler only keeps
            // a late close from becoming an unhandled rejection.
          })
        }
        return storage
      },
      (cause) => {
        this.#startupError = cause
        throw cause
      },
    )
    // Mark the rejection handled until the first stream awaits it; the error is
    // still rethrown from `session()` and reported as MISSING_CREDENTIAL.
    promise.catch(() => {})
    this.#promise = promise
  }

  get hasStaticKey(): boolean {
    return this.#staticKey !== undefined
  }

  async ready(): Promise<void> {
    await this.session()
  }

  async session(): Promise<OmpAuthStorageLike> {
    if (this.#disposed) {
      throw new InvariantError('@sekaisen/plugin-llm-omp credential session is disposed')
    }
    if (this.#storage !== undefined) return this.#storage
    if (this.#startupError !== undefined) throw this.#startupError
    if (this.#promise === undefined) {
      throw new Error('No credential store is configured for @sekaisen/plugin-llm-omp')
    }
    const storage = await this.#promise
    if (this.#disposed) {
      throw new InvariantError('@sekaisen/plugin-llm-omp credential session is disposed')
    }
    this.#storage = storage
    return storage
  }

  async staticKey(provider: string): Promise<string | undefined> {
    return this.#staticKey?.(provider)
  }

  /**
   * Releases the store this session opened, exactly once. An injected
   * `authStorage` and the static-key seam own no resource. Pending discovery is
   * awaited so an unload cannot report completion before the store it opened
   * has been closed.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    if (!this.#owned) {
      this.#disposePromise = Promise.resolve()
    } else if (this.#storage !== undefined) {
      this.#disposePromise = this.#closeOwned(this.#storage)
    } else if (this.#promise === undefined) {
      this.#disposePromise = Promise.resolve()
    } else {
      this.#disposePromise = this.#promise.then(
        (opened) => this.#closeOwned(opened),
        () => undefined,
      )
    }
    return this.#disposePromise
  }

  #closeOwned(storage: OmpAuthStorageLike): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    const close = storage.close
    if (close === undefined) {
      this.#closePromise = Promise.resolve()
      return this.#closePromise
    }
    try {
      this.#closePromise = Promise.resolve(close.call(storage)).then(
        () => undefined,
        () => {
          throw new InvariantError(OMP_CLOSE_FAILURE)
        },
      )
    } catch {
      this.#closePromise = Promise.reject(new InvariantError(OMP_CLOSE_FAILURE))
    }
    return this.#closePromise
  }
}

/**
 * Bun-only bridge from the neutral LLM seam to pi-ai's provider dispatch.
 *
 * The adapter reuses the local `omp` credential pool, lets pi-ai rotate
 * credentials/endpoints only before replay-safe output, counts every physical
 * inference request, and enforces the post-first-byte replay lock.
 */
export class OmpPiAiAdapter implements ChatAdapter {
  readonly adapterKind = OMP_PI_AI_ADAPTER_KIND
  readonly retryOwnership: AdapterRetryOwnership = 'adapter-managed-transport-and-auth'
  readonly #routes: Readonly<Record<string, OmpRouteConfig>>
  readonly #auth: OmpAuthSession
  readonly #backend: OmpStreamBackend
  readonly #resolveModel: OmpModelResolver
  readonly #fetch: FetchImpl
  readonly #sessionId: string | undefined
  #disposed = false
  #disposePromise: Promise<void> | undefined = undefined

  constructor(options: OmpPiAiAdapterOptions) {
    this.#routes = freezeOmpRoutes(options.routes)
    this.#auth = new OmpAuthSession(options)
    this.#backend = options.stream ?? ompDefaultStreamBackend
    this.#resolveModel = options.resolveModel ?? ompDefaultModelResolver
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#sessionId = options.sessionId
  }

  /** Eager initialisation seam: surfaces credential-startup failures at boot. */
  static async create(options: OmpPiAiAdapterOptions): Promise<OmpPiAiAdapter> {
    const adapter = new OmpPiAiAdapter(options)
    try {
      await adapter.ready()
    } catch (cause) {
      await adapter.dispose().catch(() => {
        // Keep the startup failure authoritative; any owned store is closed.
      })
      throw cause
    }
    return adapter
  }

  /**
   * Releases the credential store this adapter discovered, exactly once.
   * Injected `authStorage` and the static-key seam own nothing and are left
   * untouched. Idempotent: later calls return the same settlement.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise
    this.#disposed = true
    this.#disposePromise = this.#auth.dispose()
    return this.#disposePromise
  }

  /** Awaits the credential store opened by this adapter generation. */
  async ready(): Promise<void> {
    if (this.#disposed) {
      throw new InvariantError('@sekaisen/plugin-llm-omp adapter is disposed')
    }
    if (this.#auth.hasStaticKey) return
    await this.#auth.ready()
  }

  #route(routeId: RouteId): Result<OmpRouteConfig, LlmFailure> {
    const key = routeId as string
    if (typeof key !== 'string' || !Object.hasOwn(this.#routes, key)) {
      return err(ompFailure('NO_ROUTE', `Route "${String(key)}" is not registered by this adapter`))
    }
    const route = this.#routes[key]
    if (route === undefined) {
      return err(ompFailure('NO_ROUTE', `Route "${key}" is not registered by this adapter`))
    }
    return ok(route)
  }

  #resolve(routeId: RouteId, modelId: ModelId): Result<ResolvedTarget, LlmFailure> {
    const route = this.#route(routeId)
    if (!route.ok) return route
    const modelKey = modelId as string
    if (typeof modelKey !== 'string' || modelKey.length === 0 || !modelKey.isWellFormed()) {
      return err(ompFailure('INVALID_ROUTE', 'Model id must be a non-empty well-formed string'))
    }
    const model = this.#resolveModel(route.value.provider, modelKey)
    if (model === undefined) {
      return err(
        ompFailure(
          'INVALID_ROUTE',
          `pi-ai catalog has no model "${route.value.provider}/${modelKey}"`,
        ),
      )
    }
    if (model.provider !== route.value.provider) {
      return err(
        ompFailure(
          'INVALID_ROUTE',
          `Model "${modelKey}" belongs to provider "${model.provider}", not route provider "${route.value.provider}"`,
        ),
      )
    }
    if (!OMP_SUPPORTED_APIS.includes(model.api)) {
      return err(
        ompFailure(
          'UNSUPPORTED_CAPABILITY',
          `pi-ai API "${model.api}" is not supported by @sekaisen/plugin-llm-omp`,
        ),
      )
    }
    return ok({ route: route.value, model })
  }

  resolveCapabilities(routeId: RouteId, modelId: ModelId): Result<ModelCapabilities, LlmFailure> {
    const resolved = this.#resolve(routeId, modelId)
    if (!resolved.ok) return resolved
    return ompModelCapabilities(resolved.value.model, resolved.value.route.capabilities)
  }

  bindGeneration(
    routeId: RouteId,
    modelId: ModelId,
  ): Result<
    (request: BoundWireChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk>,
    LlmFailure
  > {
    if (this.#disposed) {
      return err(
        ompFailure('REGISTRATION_DISPOSED', 'Adapter was disposed before binding a generation'),
      )
    }
    const resolved = this.#resolve(routeId, modelId)
    if (!resolved.ok) return resolved
    const model =
      resolved.value.route.baseURL === undefined
        ? resolved.value.model
        : { ...resolved.value.model, baseUrl: resolved.value.route.baseURL }
    const route = resolved.value.route
    return ok((request, signal) => this.#streamCall(request, signal, model, route))
  }

  async *#streamCall(
    request: BoundWireChatRequest,
    signal: AbortSignal,
    model: PiModel,
    route: OmpRouteConfig,
  ): AsyncGenerator<StreamChunk> {
    if (signal.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: ompFailure('ABORTED', 'Model call aborted before send'),
        },
        replayState: NONE,
        observedAttempts: 0,
      }
      return
    }

    if (this.#disposed) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: ompFailure(
            'REGISTRATION_DISPOSED',
            'Adapter was disposed before the model call',
          ),
        },
        replayState: NONE,
        observedAttempts: 0,
      }
      return
    }

    const secrets = new Set<string>()
    let apiKey: ApiKey
    try {
      if (this.#auth.hasStaticKey) {
        const keyResult = await raceOmpCallWithAbort(this.#auth.staticKey(route.provider), signal)
        if (keyResult === OMP_CALL_ABORTED) {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: ompFailure('ABORTED', 'Model call aborted before send'),
            },
            replayState: NONE,
            observedAttempts: 0,
          }
          return
        }
        if (keyResult === undefined || keyResult.trim().length === 0) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: ompFailure(
                'MISSING_CREDENTIAL',
                `No credential for provider "${route.provider}"`,
              ),
            },
            replayState: NONE,
            observedAttempts: 0,
          }
          return
        }
        rememberCredentialSecret(secrets, keyResult)
        apiKey = keyResult
      } else {
        const sessionResult = await raceOmpCallWithAbort(this.#auth.session(), signal)
        if (sessionResult === OMP_CALL_ABORTED) {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: ompFailure('ABORTED', 'Model call aborted before send'),
            },
            replayState: NONE,
            observedAttempts: 0,
          }
          return
        }
        const resolver = sessionResult.keys.resolver(route.provider, {
          ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
          ...(route.baseURL === undefined ? {} : { baseUrl: route.baseURL }),
          modelId: request.snapshot.modelId as string,
        })
        const perCallResolver: OmpApiKeyResolver = async (context) => {
          const resolved = await resolver(context)
          rememberCredentialSecret(secrets, resolved)
          return resolved
        }
        apiKey = perCallResolver as unknown as ApiKey
      }
    } catch (cause) {
      if (signal.aborted) {
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: ompFailure('ABORTED', 'Model call aborted before send'),
          },
          replayState: NONE,
          observedAttempts: 0,
        }
        return
      }
      if (this.#disposed) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: ompFailure(
              'REGISTRATION_DISPOSED',
              'Adapter was disposed while resolving credentials',
            ),
          },
          replayState: NONE,
          observedAttempts: 0,
        }
        return
      }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: classifyOmpAuthFailure(cause, secrets) },
        replayState: NONE,
        observedAttempts: 0,
      }
      return
    }

    if (signal.aborted) {
      yield {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: ompFailure('ABORTED', 'Model call aborted before send'),
        },
        replayState: NONE,
        observedAttempts: 0,
      }
      return
    }

    if (this.#disposed) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: ompFailure(
            'REGISTRATION_DISPOSED',
            'Adapter was disposed while resolving credentials',
          ),
        },
        replayState: NONE,
        observedAttempts: 0,
      }
      return
    }

    const state = new OmpCallState()
    const probes = createOmpProbes(state, this.#fetch)
    const { context, anchors } = convertOmpContext(request.snapshot, model)
    const options = attachCacheAnchoring(
      convertOmpOptions({
        snapshot: request.snapshot,
        model,
        route,
        apiKey,
        probes,
        signal,
        sessionId: this.#sessionId,
      }),
      anchors,
      model,
    )
    yield* runOmpCall({
      snapshot: request.snapshot,
      model,
      context,
      options,
      state,
      secrets,
      backend: this.#backend,
    })
  }
}
