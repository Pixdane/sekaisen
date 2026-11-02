import type { Option, Result } from '@sekaisen/core'
import type { LlmService } from './service.ts'
import type {
  NeutralToolDefinition,
  NormalizedWireToolSchema,
  ToolSchemaDialect,
} from './tool-schema.ts'
import type {
  CacheAlignedChatRequest,
  LlmFailure,
  ModelId,
  ProfileId,
  RouteId,
  StreamChunk,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    llm: LlmService
  }

  interface Events {
    /**
     * Route table or profile catalogue change notification (payload-free,
     * non-vetoing broadcast). Fired when any adapter registers, hot-replaces,
     * unloads, or when `configureProfiles` commits. Individual listener
     * exceptions and rejections are isolated internally and never interrupt
     * the route commit.
     */
    'llm/routes-updated'(): void

    /**
     * Single-attempt streaming interception pipeline (waterfall).
     *
     * `prepared` is the deeply frozen one-shot snapshot (read the grouping key
     * exclusively from `prepared.request.sharedPrefixKey`) and must never be
     * mutated in place. `next` is a per-listener one-shot latch: a listener may
     * defer `next()`, observe/transform the produced `StreamChunk`s, cancel
     * through `signal`, or short-circuit by returning a legal stream without
     * calling `next()`. Calling `next()` more than once throws `InvariantError`.
     */
    'llm/stream'(
      prepared: PreparedChatCallSnapshot,
      next: () => AsyncIterable<StreamChunk>,
    ): AsyncIterable<StreamChunk>
  }
}

/* -------------------------------------------------------------------------- */
/*                        Adapter retry ownership and routes                 */
/* -------------------------------------------------------------------------- */

/**
 * Who owns retries for one adapter.
 *
 * - `'caller-owned-single-attempt'`: one `stream()` triggers at most one
 *   physical model request (`observedAttempts <= 1`); retries belong to the
 *   caller and require a fresh `PreparedChatCall`.
 * - `'adapter-managed-transport-and-auth'`: the underlying library may rotate
 *   credentials or endpoints before `first-byte` only; after `first-byte` the
 *   pre-output commit lock forbids replay.
 */
export type AdapterRetryOwnership =
  | 'caller-owned-single-attempt'
  | 'adapter-managed-transport-and-auth'

/** Fiber-bound handle owning an atomic set of routes for one adapter. */
export interface RouteRegistrationHandle {
  /** Immediately releases every route held by this handle. */
  (): void
  /**
   * Synchronously and gaplessly hot-replace the route set owned by this handle
   * (an empty array puts the handle to sleep). The candidate set is validated
   * all-or-nothing first: on failure it returns `Err` and the previous routes
   * keep serving unchanged. On success the switch and the single
   * `'llm/routes-updated'` broadcast happen inside one synchronous block.
   * A handle released together with its plugin unload returns
   * `Err({ code: 'REGISTRATION_DISPOSED' })`.
   */
  replace(nextRoutes: readonly RouteId[]): Result<void, LlmFailure>
}

/** Payload handed to a generation-bound stream function. */
export interface BoundWireChatRequest {
  readonly snapshot: PreparedChatCallSnapshot
}

/** Streaming chat adapter registered per route. */
export interface ChatAdapter {
  readonly adapterKind: string
  readonly retryOwnership: AdapterRetryOwnership
  resolveCapabilities(routeId: RouteId, modelId: ModelId): Result<ModelCapabilities, LlmFailure>
  /**
   * Synchronously bind the current adapter configuration generation and return
   * the single-attempt streaming function. A configuration hot update between
   * `prepareChatCall` and actual iteration therefore cannot leak a newer
   * endpoint or credential into this call.
   */
  bindGeneration(
    routeId: RouteId,
    modelId: ModelId,
  ): Result<
    (request: BoundWireChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk>,
    LlmFailure
  >
}

/** One embedding batch; `vectors[i]` answers `texts[i]`. */
export interface EmbeddingBatchResult {
  /**
   * Independent `Float32Array` copy per input text, in 1:1 index order; every
   * vector owns its own `ArrayBuffer`.
   */
  readonly vectors: readonly Float32Array[]
  readonly totalPromptTokens: Option<number>
}

/**
 * One rerank relevance score, addressed by document index.
 *
 * `index` is the position in the submitted `documents` array and
 * `relevanceScore` is finite (higher means more relevant). Array order is
 * adapter-defined: `LlmService.rerank` validates and freezes the items but
 * never reorders them, so consumers MUST NOT assume relevance-descending order
 * and may sort by `relevanceScore` themselves.
 */
export interface RerankScoreItem {
  readonly index: number
  readonly relevanceScore: number
}

/** Embedding adapter registered per route. */
export interface EmbeddingAdapter {
  readonly adapterKind: string
  embed(
    routeId: RouteId,
    modelId: ModelId,
    texts: readonly string[],
    options: { readonly dimensions?: number; readonly signal: AbortSignal },
  ): Promise<Result<EmbeddingBatchResult, LlmFailure>>
}

/**
 * Rerank adapter registered per route.
 *
 * Adapters MUST return at most one score per submitted document and at most
 * `topN` items when `topN` is supplied, with unique in-range indexes and finite
 * scores. Item order is adapter-defined and the service passes it through
 * unchanged: applying `topN` locally by sorting descending relevance is a valid
 * adapter choice, not a service guarantee. A rejected promise is reported as an
 * `InvariantError`; expected failures use `Err(LlmFailure)`.
 */
export interface RerankAdapter {
  readonly adapterKind: string
  rerank(
    routeId: RouteId,
    modelId: ModelId,
    query: string,
    documents: readonly string[],
    options: { readonly topN?: number; readonly signal: AbortSignal },
  ): Promise<Result<readonly RerankScoreItem[], LlmFailure>>
}

/* -------------------------------------------------------------------------- */
/*                     Domain-free named profile routing                     */
/* -------------------------------------------------------------------------- */

/** Reasoning effort ladder understood by every adapter. */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Named chat profile: target plus default decodable parameters. */
export interface ChatProfileConfig {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly defaultEffort: ReasoningEffort
  readonly temperature: Option<number>
  readonly topP: Option<number>
  readonly frequencyPenalty: Option<number>
  readonly presencePenalty: Option<number>
  readonly maxOutputTokens: Option<number>
  readonly cacheRetention: 'none' | 'short' | 'long'
}

/** Named embedding profile: target plus an optional fixed dimensionality. */
export interface EmbeddingProfileConfig {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly dimensions?: number
}

/** Named rerank profile. */
export interface RerankProfileConfig {
  readonly routeId: RouteId
  readonly modelId: ModelId
}

/**
 * Domain-free profile catalogue: plain string profile identifiers mapped onto
 * neutral targets. The service stores an `Object.create(null)` deep-frozen
 * snapshot and reads it through `Object.hasOwn` only.
 */
export interface ProfileRoutingConfig {
  readonly chatProfiles: Readonly<Record<string, ChatProfileConfig>>
  readonly embeddingProfiles: Readonly<Record<string, EmbeddingProfileConfig>>
  readonly rerankProfiles: Readonly<Record<string, RerankProfileConfig>>
}

/* -------------------------------------------------------------------------- */
/*                          Model capability matrix                          */
/* -------------------------------------------------------------------------- */

/** Native support for forcing one specific tool. */
export type ForcedToolChoiceSupport =
  /** Native named selection (`{ type: 'function', ... }` / `{ type: 'tool', name }` / Gemini `ANY` + `allowedFunctionNames`). */
  | 'named'
  /** Only the string `"required"`; named objects are rejected (e.g. CommandCode Responses, Ollama). */
  | 'required-only'
  /** No forced tool choice at all (e.g. DeepSeek reasoning direct, prefix-bound thinking models). */
  | 'none'

/** Exact, static capability declaration of one `(routeId, modelId)` pair. */
export interface ModelCapabilities {
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportedEfforts: readonly Exclude<ReasoningEffort, 'off'>[]
  readonly canDisableReasoning: boolean
  readonly supportsSamplingWhenThinking: boolean
  readonly supportsSamplingParams: boolean
  readonly supportsPenaltiesAndStop: boolean
  readonly forcedToolChoiceSupport: ForcedToolChoiceSupport
  readonly disableReasoningOnForcedToolChoice: boolean
  readonly systemPromptUpdate: 'leading-only' | 'in-history'
  readonly toolSchemaDialect: ToolSchemaDialect
  /**
   * Route-level opt-out of dialect strict mode.
   *
   * When `true`, `prepareChatCall` normalizes every tool with `strict: false`
   * so the decision is fixed before the wire request is built. Omitted means
   * "use the dialect default".
   */
  readonly disableStrictTools?: boolean
}

/* -------------------------------------------------------------------------- */
/*                        Chat call request/override shapes                  */
/* -------------------------------------------------------------------------- */

/** Provider-neutral tool selection request. */
export type NeutralToolChoice =
  | { readonly kind: 'auto' }
  | { readonly kind: 'none' }
  | { readonly kind: 'required' }
  | {
      readonly kind: 'named'
      readonly toolName: string
      /**
       * Service hint: when the target only supports `'required'`, advertise
       * exactly this tool and send `required` instead of downgrading.
       */
      readonly allowSingleToolFilter?: boolean
    }

/** Per-call overrides applied on top of the resolved profile. */
export interface ChatCallOverrides {
  readonly effort?: ReasoningEffort
  readonly temperature?: number
  readonly topP?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly stopSequences?: readonly string[]
  readonly maxOutputTokens?: number
  readonly cacheRetention?: 'none' | 'short' | 'long'
  readonly tools?: readonly NeutralToolDefinition[]
  readonly toolChoice?: NeutralToolChoice
  readonly sessionAffinityKey?: string
}

/** Chat target: a named profile or an explicit route/model pair. */
export type ChatTargetSelector =
  | { readonly kind: 'profile'; readonly profileId: ProfileId }
  | { readonly kind: 'explicit'; readonly routeId: RouteId; readonly modelId: ModelId }

/** Fully resolved, deeply frozen one-shot chat call snapshot. */
export interface PreparedChatCallSnapshot {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly retryOwnership: AdapterRetryOwnership
  readonly capabilities: ModelCapabilities
  /** Contains `segment1Static` / `segment2WarmHistory` / `segment3VolatileTail` / `sharedPrefixKey`. */
  readonly request: CacheAlignedChatRequest
  readonly tools: readonly NormalizedWireToolSchema[]
  readonly effectiveEffort: ReasoningEffort
  readonly effectiveToolChoice: NeutralToolChoice
  readonly downgradedToolChoice: boolean
  readonly sampling: {
    readonly temperature: Option<number>
    readonly topP: Option<number>
    readonly frequencyPenalty: Option<number>
    readonly presencePenalty: Option<number>
    readonly stopSequences: readonly string[]
    readonly maxOutputTokens: Option<number>
    readonly cacheRetention: 'none' | 'short' | 'long'
    readonly sessionAffinityKey: Option<string>
  }
}

/** Prepared one-shot chat call; `stream()` may be called exactly once. */
export interface PreparedChatCall {
  readonly snapshot: PreparedChatCallSnapshot
  /** One-shot consumption latch: a second call throws `InvariantError` synchronously. */
  stream(signal: AbortSignal): AsyncIterable<StreamChunk>
}

/** Retrieval target: a named profile or an explicit route/model pair. */
export type RetrievalTargetSelector =
  | { readonly kind: 'profile'; readonly profileId: ProfileId }
  | {
      readonly kind: 'explicit'
      readonly routeId: RouteId
      readonly modelId: ModelId
      readonly dimensions?: number
    }
