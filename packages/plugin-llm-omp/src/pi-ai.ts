/**
 * The only module that imports `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-catalog`.
 *
 * Every other module in this package consumes the narrowed re-exports below,
 * so the upstream SDK types never leak into `@sekaisen/plugin-llm`.
 *
 * Verified against the published `@oh-my-pi/pi-ai@18.10.4` package layout:
 * `streamSimple()` is the provider-dispatching entry point, and
 * `getBundledModel()` resolves the shipped catalog row for a provider/model
 * pair without performing any network I/O.
 */

import type {
  ApiKey,
  ApiKeyResolution,
  ApiKeyResolver,
  AssistantMessage,
  AssistantMessageEvent,
  ImageContent,
  Context as PiAiContext,
  Message as PiAiMessage,
  Tool as PiAiTool,
  ToolCall as PiAiToolCall,
  ToolChoice as PiAiToolChoice,
  Usage as PiAiUsage,
  ProviderResponseMetadata,
  RawSseEvent,
  RedactedThinkingContent,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
} from '@oh-my-pi/pi-ai'
import { streamSimple } from '@oh-my-pi/pi-ai'
import * as AIError from '@oh-my-pi/pi-ai/error'
import {
  extractProviderRetryHint,
  getHeadersFromError,
  getRetryAfterMsFromHeaders,
} from '@oh-my-pi/pi-ai/utils/retry-after'
import type { Effort } from '@oh-my-pi/pi-catalog/effort'
import type { GeneratedProvider } from '@oh-my-pi/pi-catalog/models'
import { getBundledModel } from '@oh-my-pi/pi-catalog/models'
import type { Api, Model as CatalogModel, FetchImpl } from '@oh-my-pi/pi-catalog/types'

export type {
  Api,
  ApiKey,
  ApiKeyResolution,
  ApiKeyResolver,
  AssistantMessage,
  AssistantMessageEvent,
  Effort,
  FetchImpl,
  ImageContent,
  PiAiContext,
  PiAiMessage,
  PiAiTool,
  PiAiToolCall,
  PiAiToolChoice,
  PiAiUsage,
  ProviderResponseMetadata,
  RawSseEvent,
  RedactedThinkingContent,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
}
export { AIError, extractProviderRetryHint, getHeadersFromError, getRetryAfterMsFromHeaders }

/** A catalog or caller-supplied model row addressed by this adapter. */
export type PiModel = CatalogModel<Api>

/**
 * One upstream streaming call. The narrow signature keeps test doubles honest
 * without exposing `ReturnType<typeof streamSimple>` in any public contract.
 */
export type OmpStreamBackend = (
  model: PiModel,
  context: PiAiContext,
  options: SimpleStreamOptions,
) => AsyncIterable<AssistantMessageEvent>

/** Production backend: genuinely dispatches through the installed pi-ai SDK. */
export function ompDefaultStreamBackend(
  model: PiModel,
  context: PiAiContext,
  options: SimpleStreamOptions,
): AsyncIterable<AssistantMessageEvent> {
  return streamSimple(model, context, options)
}

/** Resolves a provider/model pair to a bundled catalog row; `undefined` when absent. */
export type OmpModelResolver = (provider: string, modelId: string) => PiModel | undefined

/** Production resolver: the pinned pi-catalog snapshot shipped with pi-ai. */
export function ompDefaultModelResolver(provider: string, modelId: string): PiModel | undefined {
  try {
    return getBundledModel(provider as GeneratedProvider, modelId)
  } catch {
    return undefined
  }
}
