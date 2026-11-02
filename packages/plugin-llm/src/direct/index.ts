/**
 * Built-in, zero-SDK direct adapter group.
 *
 * Public surface:
 * - adapter constructors ({@link DirectChatAdapter}, {@link DirectEmbeddingAdapter},
 *   {@link DirectRerankAdapter}) and the four wire engines;
 * - credential validation and request/SSE plumbing helpers;
 * - declarative gateway presets and the `defineDirectRoute` builder;
 * - the shared contract types consumed by the wire engines.
 */

export type { DirectChatStreamExecutor } from './adapter.ts'
export {
  DirectChatAdapter,
  DirectEmbeddingAdapter,
  DirectRerankAdapter,
} from './adapter.ts'
export { anthropicEngine } from './anthropic.ts'
export {
  COMPLETIONS_REPLAY_ADAPTER_KIND,
  COMPLETIONS_REPLAY_VERSION,
  completionsEngine,
  TemplateTokenFilter,
  TRAILING_USAGE_GRACE_MS,
} from './completions.ts'
export type {
  CredentialResult,
  DirectAdapterOptions,
  DirectCompat,
  DirectFetch,
  DirectProtocol,
  DirectRouteConfig,
  DirectWireEngine,
  GatewayKind,
  SseEvent,
  WireRequest,
} from './contract.ts'
export type { DirectAuthMode, DirectRouteInput, GatewayPreset } from './gateways.ts'
export {
  defineDirectRoute,
  GATEWAY_PRESETS,
  gatewayCapabilityPolicy,
  gatewayPreset,
  isGatewayKind,
} from './gateways.ts'
export { geminiEngine } from './gemini.ts'
export { responsesEngine } from './responses.ts'
export type {
  DirectCredentialResolver,
  DirectGeneration,
  DirectStreamContext,
  PreparedDirectRoute,
  RequestHeaderInput,
  SseWatchdogOptions,
} from './transport.ts'
export {
  assertUsableApiKey,
  buildRequestHeaders,
  classifyDirectFailure,
  classifyHttpResponse,
  DIRECT_FIRST_EVENT_TIMEOUT_MS,
  DIRECT_INTER_EVENT_TIMEOUT_MS,
  DirectRouteTable,
  executeDirectStream,
  isLlmFailure,
  joinRequestURL,
  parseSseStream,
  prepareDirectGeneration,
  readResponseText,
  redactSecrets,
  resolveRouteApiKey,
  sanitizeMessage,
} from './transport.ts'
