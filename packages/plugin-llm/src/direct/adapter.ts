import { err, ok, type Result } from '@sekaisen/core'
import type {
  AdapterRetryOwnership,
  BoundWireChatRequest,
  ChatAdapter,
  ModelCapabilities,
} from '../service-types.ts'
import type { ToolSchemaDialect } from '../tool-schema.ts'
import type { LlmFailure, ModelId, RouteId, StreamChunk } from '../types.ts'
import { failure } from '../utils.ts'
import { anthropicEngine } from './anthropic.ts'
import { completionsEngine } from './completions.ts'
import type { DirectAdapterOptions, DirectProtocol, DirectWireEngine } from './contract.ts'
import { gatewayCapabilityPolicy } from './gateways.ts'
import { geminiEngine } from './gemini.ts'
import { responsesEngine } from './responses.ts'
import {
  DirectRouteTable,
  executeDirectStream,
  type PreparedDirectRoute,
  resolveRouteApiKey,
} from './transport.ts'

const ENGINES: Readonly<Record<DirectProtocol, DirectWireEngine>> = Object.freeze({
  'anthropic-messages': anthropicEngine,
  'openai-completions': completionsEngine,
  'openai-responses': responsesEngine,
  'google-gemini': geminiEngine,
})

/** One bound stream executor produced by {@link DirectChatAdapter.bindGeneration}. */
export type DirectChatStreamExecutor = (
  request: BoundWireChatRequest,
  signal: AbortSignal,
) => AsyncIterable<StreamChunk>

function isUsableModelId(modelId: unknown): modelId is ModelId {
  return typeof modelId === 'string' && modelId.length > 0 && modelId.isWellFormed()
}

function defaultToolSchemaDialect(protocol: DirectProtocol): ToolSchemaDialect {
  switch (protocol) {
    case 'anthropic-messages':
      return 'anthropic'
    case 'openai-responses':
      return 'openai-responses'
    case 'google-gemini':
      return 'google-gemini'
    case 'openai-completions':
      return 'openai-strict'
  }
}

function protocolDefaults(protocol: DirectProtocol): ModelCapabilities {
  const base: ModelCapabilities = {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportedEfforts: Object.freeze(['minimal', 'low', 'medium', 'high'] as const),
    canDisableReasoning: true,
    supportsSamplingWhenThinking: true,
    supportsSamplingParams: true,
    supportsPenaltiesAndStop: true,
    forcedToolChoiceSupport: 'named',
    disableReasoningOnForcedToolChoice: false,
    systemPromptUpdate: 'leading-only',
    toolSchemaDialect: defaultToolSchemaDialect(protocol),
  }
  switch (protocol) {
    case 'anthropic-messages':
      return Object.freeze({
        ...base,
        supportedEfforts: Object.freeze(['low', 'medium', 'high', 'max'] as const),
        supportsSamplingWhenThinking: false,
        supportsPenaltiesAndStop: false,
        disableReasoningOnForcedToolChoice: true,
      })
    case 'openai-responses':
      return Object.freeze({
        ...base,
        supportedEfforts: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh'] as const),
        supportsSamplingWhenThinking: false,
      })
    case 'google-gemini':
      return Object.freeze({ ...base, disableReasoningOnForcedToolChoice: true })
    case 'openai-completions':
      return base
  }
}

function mergeCapabilities(
  base: ModelCapabilities,
  ...overrides: readonly (Partial<ModelCapabilities> | undefined)[]
): ModelCapabilities {
  const merged: Record<string, unknown> = { ...base }
  for (const override of overrides) {
    if (override === undefined) continue
    for (const key of Object.keys(override) as (keyof ModelCapabilities)[]) {
      const value = override[key]
      if (value !== undefined) merged[key] = value
    }
  }
  return Object.freeze({
    ...(merged as unknown as ModelCapabilities),
    supportedEfforts: Object.freeze([
      ...(merged.supportedEfforts as ModelCapabilities['supportedEfforts']),
    ]),
  })
}

/**
 * Pure `fetch` API adapter for the four base wire protocols.
 *
 * The adapter owns exactly one physical HTTP request per `stream()` call
 * (`retryOwnership: 'caller-owned-single-attempt'`), validates credentials
 * before dispatch without ever echoing them, and binds a frozen configuration
 * generation at `bindGeneration` time so a concurrent
 * {@link DirectChatAdapter.replaceConfiguration} cannot change the endpoint,
 * credential reference, or compatibility switches of an in-flight call.
 */
export class DirectChatAdapter implements ChatAdapter {
  readonly adapterKind = 'direct'
  readonly retryOwnership: AdapterRetryOwnership = 'caller-owned-single-attempt'
  readonly #table: DirectRouteTable

  constructor(options: DirectAdapterOptions) {
    this.#table = new DirectRouteTable(options)
  }

  /**
   * Synchronously warm-replace the whole route table. Validation is
   * all-or-nothing: a rejected configuration returns `Err` and the previous
   * generation keeps serving unchanged.
   */
  replaceConfiguration(options: DirectAdapterOptions): Result<void, LlmFailure> {
    return this.#table.replaceConfiguration(options)
  }

  resolveCapabilities(routeId: RouteId, modelId: ModelId): Result<ModelCapabilities, LlmFailure> {
    const route = this.#table.resolveRoute(routeId)
    if (!route.ok) return err(route.error)
    if (!isUsableModelId(modelId)) {
      return err(failure('INVALID_REQUEST', 'model id must be a non-empty well-formed string'))
    }
    return ok(this.#capabilities(route.value, modelId))
  }

  bindGeneration(routeId: RouteId, modelId: ModelId): Result<DirectChatStreamExecutor, LlmFailure> {
    const route = this.#table.resolveRoute(routeId)
    if (!route.ok) return err(route.error)
    if (!isUsableModelId(modelId)) {
      return err(failure('INVALID_REQUEST', 'model id must be a non-empty well-formed string'))
    }
    const generation = this.#table.generation
    const apiKey = resolveRouteApiKey(route.value, generation.resolveCredential)
    if (!apiKey.ok) return err(apiKey.error)
    const engine = ENGINES[route.value.config.protocol]
    const fetchImpl = generation.fetchImpl
    const prepared = route.value
    return ok((request: BoundWireChatRequest, signal: AbortSignal) =>
      executeDirectStream({
        route: prepared,
        engine,
        apiKey: apiKey.value,
        fetchImpl,
        snapshot: request.snapshot,
        signal,
      }),
    )
  }

  #capabilities(route: PreparedDirectRoute, modelId: ModelId): ModelCapabilities {
    const protocol = route.config.protocol
    const merged = mergeCapabilities(
      protocolDefaults(protocol),
      gatewayCapabilityPolicy(route.gateway, protocol, String(modelId)),
      route.config.capabilities,
    )
    // `compat.disableStrictTools` is a route-level switch: surface it statically
    // in the capability matrix so `prepareChatCall` normalizes strict:false into
    // the frozen tool snapshot instead of deferring the decision to the wire.
    const disableStrictTools =
      route.config.compat?.disableStrictTools ?? merged.disableStrictTools === true
    return Object.freeze({ ...merged, disableStrictTools })
  }
}

export type { DirectAdapterOptions, DirectRouteConfig, SseEvent, WireRequest } from './contract.ts'
export { DirectEmbeddingAdapter, DirectRerankAdapter } from './retrieval.ts'
export type {
  DirectCredentialResolver,
  DirectGeneration,
  PreparedDirectRoute,
} from './transport.ts'
export {
  assertUsableApiKey,
  DIRECT_FIRST_EVENT_TIMEOUT_MS,
  DIRECT_INTER_EVENT_TIMEOUT_MS,
  isLlmFailure,
  redactSecrets,
  sanitizeMessage,
} from './transport.ts'
