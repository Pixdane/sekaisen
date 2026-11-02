/**
 * Neutral, provider-agnostic request and streaming vocabulary for
 * `@sekaisen/plugin-llm`.
 *
 * This module contains only the closed value shapes from the first design
 * document. Every string that reaches a request preflight or the stream state
 * machine is required to be well-formed Unicode; every numeric field is
 * required to be finite (and integral where documented). Those runtime rules
 * are enforced by `./utils.ts`, `./stream.ts` and `./assembler.ts`.
 *
 * No wire format, gateway or vendor concept belongs here: adapters translate
 * these shapes to and from their own protocols.
 */

import type { Brand, Option } from '@sekaisen/core'

/* -------------------------------------------------------------------------- */
/*                            Nominal scalar types                           */
/* -------------------------------------------------------------------------- */

/** Registered adapter channel identifier (for example `'deepseek'`, `'omp:google-antigravity'`). */
export type RouteId = Brand<string, 'RouteId'>

/** Concrete model identifier inside a channel (for example `'deepseek-v4-pro'`). */
export type ModelId = Brand<string, 'ModelId'>

/** Host-side named, domain-free model configuration profile identifier. */
export type ProfileId = Brand<string, 'ProfileId'>

/** Identifier correlating one tool call with its later tool result. */
export type ToolCallId = Brand<string, 'ToolCallId'>

/** Upstream request trace identifier used for diagnostics only. */
export type ProviderRequestId = Brand<string, 'ProviderRequestId'>

/* -------------------------------------------------------------------------- */
/*                        Closed neutral content blocks                      */
/* -------------------------------------------------------------------------- */

/** Visible plain-text content block. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Reasoning/thinking block, kept physically separate from visible text. */
export interface ReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
}

/**
 * Model-issued tool call block.
 *
 * `argumentsJson` keeps the exact JSON string produced by the model; the
 * adapter never discards the original text before parsing.
 */
export interface ToolCallBlock {
  readonly type: 'tool-call'
  readonly id: ToolCallId
  readonly name: string
  readonly argumentsJson: string
}

/** Union of every block type the neutral vocabulary allows. */
export type NeutralContentBlock = TextBlock | ReasoningBlock | ToolCallBlock

/* -------------------------------------------------------------------------- */
/*                    Opaque same-origin replay envelope                     */
/* -------------------------------------------------------------------------- */

/**
 * Adapter-private, lossless JSON replay state.
 *
 * The core layer validates only the envelope shell and the positional
 * alignment of `blocks`; the payload inside `response` and `blocks` is never
 * interpreted here.
 */
export interface ReplayEnvelope {
  /** Adapter kind that produced the envelope (for example `'direct:anthropic'`). */
  readonly adapterKind: string
  /** Envelope protocol version. */
  readonly version: number
  /** Response-level private metadata. */
  readonly response: unknown
  /**
   * Block-level private metadata: when present it must stay 1:1 indexed with
   * the produced content blocks (`0..N-1`). Trimming a content block requires
   * removing `blocks[i]` at the same index.
   */
  readonly blocks?: readonly unknown[]
}

/** Provenance of an assistant message, including optional replay state. */
export interface AssistantMessageOrigin {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly replayState: Option<ReplayEnvelope>
}

/* -------------------------------------------------------------------------- */
/*                          Neutral conversation history                     */
/* -------------------------------------------------------------------------- */

/** Cache retention hint attached to at most one block per message. */
export type CacheBreakpointHint = 'ephemeral' | 'long'

/** User turn carrying only visible text blocks. */
export interface NeutralUserMessage {
  readonly role: 'user'
  readonly content: readonly TextBlock[]
  readonly cacheBreakpoint?: CacheBreakpointHint
}

/** Assistant turn carrying neutral content blocks and its origin. */
export interface NeutralAssistantMessage {
  readonly role: 'assistant'
  readonly content: readonly NeutralContentBlock[]
  readonly origin: AssistantMessageOrigin
  readonly cacheBreakpoint?: CacheBreakpointHint
}

/** Tool result answering one earlier tool call. */
export interface NeutralToolResultMessage {
  readonly role: 'tool-result'
  readonly toolCallId: ToolCallId
  readonly toolName: string
  readonly content: string
  readonly isError: boolean
  readonly cacheBreakpoint?: CacheBreakpointHint
}

/** Closed union of the three neutral history message roles. */
export type NeutralMessage = NeutralUserMessage | NeutralAssistantMessage | NeutralToolResultMessage

/* -------------------------------------------------------------------------- */
/*                      Three-segment cache-aligned request                  */
/* -------------------------------------------------------------------------- */

/** One named block of the stable system prefix. */
export interface SystemSegment {
  readonly name: string
  readonly text: string
}

/**
 * Three-segment chat request: stable system prefix, warm history and a single
 * volatile tail that must never carry a cache breakpoint.
 */
export interface CacheAlignedChatRequest {
  /** Segment 1 — stable system prefix; breakpoint #1 anchors at its end. */
  readonly segment1Static: readonly SystemSegment[]
  /** Segment 2 — warm history; breakpoint #2 anchors on its last block when non-empty. */
  readonly segment2WarmHistory: readonly NeutralMessage[]
  /** Segment 3 — volatile tail, projected by the adapter from capabilities. */
  readonly segment3VolatileTail: Option<string>
  /**
   * Optional shared-prefix grouping key. Only stored on
   * `snapshot.request.sharedPrefixKey`; neither this package nor the adapters
   * interpret it.
   */
  readonly sharedPrefixKey: Option<string>
}

/* -------------------------------------------------------------------------- */
/*                       Disjoint usage and failure vocabulary               */
/* -------------------------------------------------------------------------- */

/**
 * Mutually exclusive token accounting for one model call:
 * `inputUncachedTokens`, `cacheReadTokens` and `cacheWriteTokens` are disjoint
 * non-negative safe integers whose sum is the total input token count.
 */
export interface DisjointTokenUsage {
  readonly inputUncachedTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: Option<number>
  readonly authoritativeCostUsd: Option<number>
}

/** Expected-failure codes surfaced as `Result` errors or `finish` reasons. */
export type LlmFailureCode =
  | 'NO_ROUTE'
  | 'DUPLICATE_ROUTE'
  | 'INVALID_ROUTE'
  | 'REGISTRATION_DISPOSED'
  | 'MISSING_CREDENTIAL'
  | 'INVALID_CREDENTIAL'
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'CONTENT_BLOCKED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_CAPABILITY'
  | 'MALFORMED_RESPONSE'
  | 'EMPTY_RESPONSE'
  | 'SERVER'
  | 'TRANSPORT'
  | 'TIMEOUT'
  | 'ABORTED'

/** Structured expected failure; never carries plaintext credential material. */
export interface LlmFailure {
  readonly code: LlmFailureCode
  readonly message: string
  readonly status: Option<number>
  readonly retryAfterMs: Option<number>
  readonly requestId: Option<ProviderRequestId>
}

/* -------------------------------------------------------------------------- */
/*                    Executable stream protocol vocabulary                 */
/* -------------------------------------------------------------------------- */

/**
 * Terminal reason of one validated stream.
 * `aborted` requires failure code `ABORTED`; `error` forbids that code.
 * The protocol guard enforces the runtime relationship.
 */
export type FinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure: LlmFailure }
  | { readonly kind: 'error'; readonly failure: LlmFailure }

/**
 * Closed frame union produced by every adapter and re-validated by every
 * `StreamProtocolGuard`.
 */
export type StreamChunk =
  | { readonly type: 'first-byte' }
  | {
      readonly type: 'block-start'
      readonly index: number
      readonly blockType: 'text' | 'reasoning' | 'tool-call'
      readonly toolCallId?: ToolCallId
      readonly toolName?: string
    }
  | { readonly type: 'text-delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: NeutralContentBlock }
  /** At most once, after all started blocks close; does not imply a successful finish. */
  | { readonly type: 'usage'; readonly usage: DisjointTokenUsage }
  | {
      readonly type: 'finish'
      readonly reason: FinishReason
      readonly replayState: Option<ReplayEnvelope>
      /**
       * Physical request attempts made by the stream.
       *
       * `0` when cancelled or transport-initialized before any physical request
       * was sent; `>= 1` once a physical request was actually issued. Direct
       * adapters are restricted to `0 | 1`.
       */
      readonly observedAttempts: number
    }
