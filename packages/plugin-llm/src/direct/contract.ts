import type { Result } from '@sekaisen/core'
import type { ModelCapabilities, PreparedChatCallSnapshot } from '../service-types.ts'
import type { LlmFailure, StreamChunk } from '../types.ts'

export type DirectProtocol =
  | 'anthropic-messages'
  | 'openai-completions'
  | 'openai-responses'
  | 'google-gemini'
export type GatewayKind =
  | 'custom'
  | 'deepseek'
  | 'siliconflow'
  | 'siliconflow-cn'
  | 'openrouter'
  | 'opencode'
  | 'commandcode'
  | 'omp-gateway-http'
  | 'openai'
  | 'anthropic'
  | 'google'
export interface DirectCompat {
  readonly disableStrictTools?: boolean
  readonly stripTemplateTokens?: boolean
  readonly omitImplicitMaxTokens?: boolean
  readonly reasoningField?: 'reasoning_content' | 'reasoning'
}
export interface DirectRouteConfig {
  readonly protocol: DirectProtocol
  readonly baseURL: string
  readonly credentialRef?: string
  readonly authMode?: 'bearer' | 'x-api-key' | 'none'
  readonly headers?: Readonly<Record<string, string>>
  readonly gateway?: GatewayKind
  readonly capabilities?: Partial<ModelCapabilities>
  readonly compat?: DirectCompat
  readonly firstEventTimeoutMs?: number
  readonly interEventTimeoutMs?: number
}
export interface SseEvent {
  readonly event: string
  readonly data: string
  readonly id?: string
}
export interface WireRequest {
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
}
export interface DirectWireEngine {
  build(snapshot: PreparedChatCallSnapshot, config: DirectRouteConfig): WireRequest
  decode(
    events: AsyncIterable<SseEvent>,
    snapshot: PreparedChatCallSnapshot,
    config: DirectRouteConfig,
  ): AsyncIterable<StreamChunk>
}
/**
 * Neutral fetch seam for the direct runtime.
 *
 * The ambient `globalThis.fetch` type differs per host (Bun augments the
 * function with extra statics such as `preconnect`), so the runtime depends on
 * this minimal callable shape instead. A plain function satisfies it, and
 * `globalThis.fetch` is assignable to it on every supported runtime.
 */
export type DirectFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface DirectAdapterOptions {
  readonly routes: Readonly<Record<string, DirectRouteConfig>>
  readonly resolveCredential?: (reference: string) => string | undefined
  readonly fetch?: DirectFetch
}
export type CredentialResult = Result<string, LlmFailure>
