/**
 * `ctx.llm` Cordis service: fiber-bound adapter routing, named profiles, the
 * two-stage `prepareChatCall` protocol and retrieval plumbing.
 *
 * Route tables are atomic: registration and `replace()` validate the whole
 * candidate set before committing, and the `'llm/routes-updated'` broadcast is
 * isolated per listener (a listener defect can never interrupt a commit).
 */

import type { Result } from '@sekaisen/core'
import { err, InvariantError, ok } from '@sekaisen/core'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { createPreparedChatCall } from './chat-call.ts'
import { prepareChatCall as runPreparation } from './preparation.ts'
import { buildProfileSnapshot, emptyProfileSnapshot } from './profiles.ts'
import { RouteRegistry } from './registry.ts'
import type { RetrievalDeps } from './retrieval.ts'
import { embed as runEmbedding, rerank as runRerank } from './retrieval.ts'
import type {
  AdapterRetryOwnership,
  ChatAdapter,
  ChatCallOverrides,
  ChatTargetSelector,
  EmbeddingAdapter,
  EmbeddingBatchResult,
  PreparedChatCall,
  PreparedChatCallSnapshot,
  ProfileRoutingConfig,
  RerankAdapter,
  RerankScoreItem,
  RetrievalTargetSelector,
  RouteRegistrationHandle,
} from './service-types.ts'
import type { CacheAlignedChatRequest, LlmFailure, RouteId, StreamChunk } from './types.ts'
import { failure, validString } from './utils.ts'

const CHAT_ADAPTER_METHODS = ['resolveCapabilities', 'bindGeneration'] as const
const EMBEDDING_ADAPTER_METHODS = ['embed'] as const
const RERANK_ADAPTER_METHODS = ['rerank'] as const

const RETRY_OWNERSHIPS: Readonly<Record<AdapterRetryOwnership, true>> = Object.freeze({
  'caller-owned-single-attempt': true,
  'adapter-managed-transport-and-auth': true,
})

/** One `llm/stream` waterfall listener as invoked by the service dispatcher. */
type ChatStreamListener = (
  prepared: PreparedChatCallSnapshot,
  next: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>

/**
 * Runtime shape check shared by all three adapter families.
 *
 * Adapters are ordinary objects (usually class instances), so only their
 * observable contract is inspected: a well-formed `adapterKind`, a known retry
 * ownership for chat, and the required methods.
 */
function checkAdapter(
  label: string,
  adapter: unknown,
  methods: readonly string[],
  requireRetryOwnership: boolean,
): LlmFailure | null {
  if (typeof adapter !== 'object' || adapter === null)
    return failure('INVALID_ROUTE', `${label} adapter must be an object`)
  const record = adapter as unknown as Readonly<Record<string, unknown>>
  if (!validString(record.adapterKind, true))
    return failure(
      'INVALID_ROUTE',
      `${label} adapter.adapterKind must be a non-empty well-formed string`,
    )
  if (requireRetryOwnership) {
    const ownership = record.retryOwnership
    if (typeof ownership !== 'string' || !Object.hasOwn(RETRY_OWNERSHIPS, ownership))
      return failure(
        'INVALID_ROUTE',
        `${label} adapter.retryOwnership must be caller-owned-single-attempt or adapter-managed-transport-and-auth`,
      )
  }
  for (const method of methods) {
    if (typeof record[method] !== 'function')
      return failure('INVALID_ROUTE', `${label} adapter.${method} must be a function`)
  }
  return null
}

/**
 * Cordis service mounted on `ctx.llm`.
 *
 * The service owns no provider knowledge: adapters are registered per route,
 * profiles only bind names to `(routeId, modelId)` pairs, and every prepared
 * call carries the capabilities and generation snapshot it was planned with.
 */
export class LlmService extends Service {
  private readonly chatRoutes: RouteRegistry<ChatAdapter>
  private readonly embeddingRoutes: RouteRegistry<EmbeddingAdapter>
  private readonly rerankRoutes: RouteRegistry<RerankAdapter>
  private profiles: ProfileRoutingConfig = emptyProfileSnapshot()
  private disposed = false

  constructor(ctx: Context) {
    super(ctx, 'llm')
    const notify = (): void => {
      this.emitRoutesUpdated()
    }
    this.chatRoutes = new RouteRegistry<ChatAdapter>(notify)
    this.embeddingRoutes = new RouteRegistry<EmbeddingAdapter>(notify)
    this.rerankRoutes = new RouteRegistry<RerankAdapter>(notify)
    this.ctx.effect(() => () => {
      this.disposed = true
    })
  }

  /* ---------------------------------------------------------------------- */
  /*                              Route tables                             */
  /* ---------------------------------------------------------------------- */

  /** Register one chat adapter for `routes`; the handle is released with the fiber. */
  registerChatAdapter(
    routes: readonly RouteId[],
    adapter: ChatAdapter,
  ): Result<RouteRegistrationHandle, LlmFailure> {
    const invalid = checkAdapter('Chat', adapter, CHAT_ADAPTER_METHODS, true)
    if (invalid !== null) return err(invalid)
    return this.bindHandle(this.chatRoutes.register(routes, adapter))
  }

  /** Register one embedding adapter for `routes`. */
  registerEmbeddingAdapter(
    routes: readonly RouteId[],
    adapter: EmbeddingAdapter,
  ): Result<RouteRegistrationHandle, LlmFailure> {
    const invalid = checkAdapter('Embedding', adapter, EMBEDDING_ADAPTER_METHODS, false)
    if (invalid !== null) return err(invalid)
    return this.bindHandle(this.embeddingRoutes.register(routes, adapter))
  }

  /** Register one rerank adapter for `routes`. */
  registerRerankAdapter(
    routes: readonly RouteId[],
    adapter: RerankAdapter,
  ): Result<RouteRegistrationHandle, LlmFailure> {
    const invalid = checkAdapter('Rerank', adapter, RERANK_ADAPTER_METHODS, false)
    if (invalid !== null) return err(invalid)
    return this.bindHandle(this.rerankRoutes.register(routes, adapter))
  }

  /** Registered chat routes in deterministic order. */
  listChatRoutes(): readonly RouteId[] {
    return this.chatRoutes.list()
  }

  /** Registered embedding routes in deterministic order. */
  listEmbeddingRoutes(): readonly RouteId[] {
    return this.embeddingRoutes.list()
  }

  /** Registered rerank routes in deterministic order. */
  listRerankRoutes(): readonly RouteId[] {
    return this.rerankRoutes.list()
  }

  /** Attach a freshly created registration handle to this fiber's lifetime. */
  private bindHandle(
    registered: Result<RouteRegistrationHandle, LlmFailure>,
  ): Result<RouteRegistrationHandle, LlmFailure> {
    if (!registered.ok) return registered
    const handle = registered.value
    try {
      this.ctx.effect(() => () => {
        handle()
      })
    } catch (cause) {
      handle()
      throw cause
    }
    return registered
  }

  /* ---------------------------------------------------------------------- */
  /*                         Profile configuration                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Validate and publish a fresh deeply frozen profile snapshot.
   *
   * Validation is all-or-nothing: on any error the previously published
   * snapshot keeps serving unchanged and no event is emitted.
   */
  configureProfiles(config: ProfileRoutingConfig): Result<void, LlmFailure> {
    const snapshot = buildProfileSnapshot(config)
    if (!snapshot.ok) return snapshot
    this.profiles = snapshot.value
    this.emitRoutesUpdated()
    return ok(undefined)
  }

  /** Currently published immutable profile catalogue. */
  getProfileConfig(): ProfileRoutingConfig {
    return this.profiles
  }

  /* ---------------------------------------------------------------------- */
  /*                            Chat preparation                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve a chat target and produce a one-shot prepared call.
   *
   * All capability plumbing happens synchronously here, so the returned call
   * keeps the endpoint generation, capability matrix and tool normalization
   * decided at preparation time even if routes change before iteration.
   */
  prepareChatCall(
    target: ChatTargetSelector,
    request: CacheAlignedChatRequest,
    overrides?: ChatCallOverrides,
  ): Result<PreparedChatCall, LlmFailure> {
    const plan = runPreparation(
      {
        chatAdapter: (routeId) => this.chatRoutes.get(routeId),
        chatProfile: (profileId) => {
          const catalogue = this.profiles.chatProfiles
          return Object.hasOwn(catalogue, profileId) ? catalogue[profileId] : undefined
        },
      },
      target,
      request,
      overrides,
    )
    if (!plan.ok) return plan
    return ok(
      createPreparedChatCall(plan.value.snapshot, plan.value.bound, (snapshot, next) =>
        this.waterfall(snapshot, next),
      ),
    )
  }

  /**
   * Dispatch the `llm/stream` waterfall with the package's own latch.
   *
   * Cordis' `waterfall` installs a plain `Error` for a second `next()` call, so
   * a listener that catches it would observe the wrong class. The service
   * therefore snapshots the listener chain itself and hands every listener a
   * one-shot `next` whose second call throws {@link InvariantError}
   * synchronously, before anything else runs. Listener exceptions propagate
   * unchanged.
   */
  private waterfall(
    snapshot: PreparedChatCallSnapshot,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const callbacks = this.ctx.events.dispatch('waterfall', [
      'llm/stream',
      snapshot,
      next,
    ]) as unknown as readonly ChatStreamListener[]

    const dispatch = (position: number): AsyncIterable<StreamChunk> => {
      const listener = callbacks[position]
      if (listener === undefined) return next()
      let called = false
      const invokeNext = (): AsyncIterable<StreamChunk> => {
        if (called) throw new InvariantError('llm/stream listener called next() more than once')
        called = true
        return dispatch(position + 1)
      }
      return listener(snapshot, invokeNext)
    }
    return dispatch(0)
  }

  /* ---------------------------------------------------------------------- */
  /*                               Retrieval                               */
  /* ---------------------------------------------------------------------- */

  /** Embed `texts`, returning one independent `Float32Array` copy per input. */
  embed(
    target: RetrievalTargetSelector,
    texts: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<EmbeddingBatchResult, LlmFailure>> {
    return runEmbedding(this.retrievalDeps(), target, texts, options)
  }

  /** Rerank `documents` against `query`, returning validated score items. */
  rerank(
    target: RetrievalTargetSelector,
    query: string,
    documents: readonly string[],
    options?: { readonly topN?: number; readonly signal?: AbortSignal },
  ): Promise<Result<readonly RerankScoreItem[], LlmFailure>> {
    return runRerank(this.retrievalDeps(), target, query, documents, options)
  }

  private retrievalDeps(): RetrievalDeps {
    const embeddingCatalogue = this.profiles.embeddingProfiles
    const rerankCatalogue = this.profiles.rerankProfiles
    return {
      embeddingAdapter: (routeId) => this.embeddingRoutes.get(routeId),
      rerankAdapter: (routeId) => this.rerankRoutes.get(routeId),
      embeddingProfile: (profileId) =>
        Object.hasOwn(embeddingCatalogue, profileId) ? embeddingCatalogue[profileId] : undefined,
      rerankProfile: (profileId) =>
        Object.hasOwn(rerankCatalogue, profileId) ? rerankCatalogue[profileId] : undefined,
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                                 Events                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Broadcast `'llm/routes-updated'` with per-listener isolation.
   *
   * Cordis' plain `emit` stops at the first throwing listener, so callbacks are
   * dispatched individually: a synchronous throw or an asynchronous rejection
   * is logged and swallowed, and later listeners still observe the commit.
   */
  private emitRoutesUpdated(): void {
    if (this.disposed) return
    let callbacks: (() => unknown)[]
    try {
      callbacks = this.ctx.events.dispatch('emit', ['llm/routes-updated']) as (() => unknown)[]
    } catch {
      return
    }
    for (const callback of callbacks) {
      try {
        const outcome = callback()
        if (
          outcome !== null &&
          typeof outcome === 'object' &&
          'then' in outcome &&
          typeof outcome.then === 'function'
        ) {
          void Promise.resolve(outcome).catch(() => {
            // Isolated: a rejecting listener cannot interrupt the commit.
          })
        }
      } catch (cause) {
        try {
          this.ctx.logger.warn('llm/routes-updated listener failed', cause)
        } catch {
          // Logging must never turn an isolated listener failure into a commit failure.
        }
      }
    }
  }
}
