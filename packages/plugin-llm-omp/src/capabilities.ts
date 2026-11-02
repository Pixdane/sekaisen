import type { Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import type {
  LlmFailure,
  ModelCapabilities,
  ReasoningEffort,
  ToolSchemaDialect,
} from '@sekaisen/plugin-llm'
import { ompFailure } from './failures.ts'
import type { PiModel } from './pi-ai.ts'

/** APIs this bridge can drive through pi-ai's provider dispatch. */
export const OMP_SUPPORTED_APIS: readonly string[] = Object.freeze([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'google-generative-ai',
  'google-gemini-cli',
])

/** Capability fields a route may override for a custom catalog row. */
export type OmpCapabilityOverrides = Partial<Omit<ModelCapabilities, 'systemPromptUpdate'>>

interface CompatFlags {
  readonly supportsSamplingParams?: boolean
  readonly supportsPenaltyAndStopParams?: boolean
  readonly supportsForcedToolChoice?: boolean
  readonly disableStrictTools?: boolean
  readonly supportsLongCacheRetention?: boolean
  readonly disableReasoningOnForcedToolChoice?: boolean
}

function compatFlags(model: PiModel): CompatFlags {
  return (model.compat ?? {}) as CompatFlags
}

function dialectFor(model: PiModel): ToolSchemaDialect {
  switch (model.api) {
    case 'anthropic-messages':
      return 'anthropic'
    case 'openai-responses':
    case 'openai-codex-responses':
    case 'azure-openai-responses':
    case 'openrouter':
      return 'openai-responses'
    case 'openai-completions':
      return compatFlags(model).disableStrictTools === true ? 'openai-non-strict' : 'openai-strict'
    // Google needs the Gemini/CCA dialect projections (nullable folding,
    // `propertyOrdering`, flattened discriminated unions for CCA). The
    // normalizer emits Gemini `Schema` with uppercase structural types; the
    // bridge lowercases only schema keyword positions again before handing the
    // JSON Schema to pi-ai, whose Gemini/CCA paths expect lowercase input.
    case 'google-generative-ai':
    case 'google-vertex':
      return 'google-gemini'
    case 'google-gemini-cli':
      return 'google-gemini-cca'
    default:
      return 'openai-non-strict'
  }
}

function supportedEfforts(model: PiModel): readonly Exclude<ReasoningEffort, 'off'>[] {
  if (!model.reasoning || model.thinking === undefined) return Object.freeze([])
  const efforts: Exclude<ReasoningEffort, 'off'>[] = []
  for (const effort of model.thinking.efforts) {
    const value = String(effort)
    if (value !== 'off') efforts.push(value as Exclude<ReasoningEffort, 'off'>)
  }
  return Object.freeze(efforts)
}

/**
 * Derives the neutral capability matrix from the pinned catalog row and its
 * resolved compatibility flags. Subscription-specific truth is inherited from
 * pi-ai rather than guessed here:
 *
 * - Codex rows carry `compat.supportsSamplingParams === false` and
 *   `compat.supportsPenaltyAndStopParams === false`; the transport likewise
 *   strips `max_output_tokens` before sending.
 * - Anthropic OAuth rows keep their catalog sampling/prompt-cache surface;
 *   pi-ai injects the Claude Code identity block, tool-name prefixing and
 *   OAuth betas internally when the resolved bearer is an OAuth token.
 * - Gemini/Cloud Code Assist rows declare a plain JSON Schema dialect because
 *   pi-ai performs the Google wire-schema conversion itself.
 */
export function ompModelCapabilities(
  model: PiModel,
  overrides: OmpCapabilityOverrides = {},
): Result<ModelCapabilities, LlmFailure> {
  if (!OMP_SUPPORTED_APIS.includes(model.api)) {
    return err(
      ompFailure(
        'UNSUPPORTED_CAPABILITY',
        `pi-ai API "${model.api}" is not supported by @sekaisen/plugin-llm-omp`,
      ),
    )
  }
  const contextWindow = overrides.contextWindow ?? model.contextWindow
  if (contextWindow === null || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return err(
      ompFailure(
        'INVALID_ROUTE',
        `Model "${model.provider}/${model.id}" has no published context window`,
      ),
    )
  }
  const maxOutputTokens = overrides.maxOutputTokens ?? model.maxTokens
  if (maxOutputTokens === null || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    return err(
      ompFailure(
        'INVALID_ROUTE',
        `Model "${model.provider}/${model.id}" has no published output-token limit`,
      ),
    )
  }

  const compat = compatFlags(model)
  // The Codex backend refuses every sampling control and explicit output cap;
  // pi-ai's Codex request builder drops them unconditionally. Disabling
  // reasoning there maps to the lowest effort (`reasoningDisableMode:
  // "lowest-effort"`), not a true off switch.
  const codex = model.api === 'openai-codex-responses'
  const anthropic = model.api === 'anthropic-messages'
  const responses =
    model.api === 'openai-responses' ||
    model.api === 'azure-openai-responses' ||
    model.api === 'openrouter'
  const google =
    model.api === 'google-generative-ai' ||
    model.api === 'google-gemini-cli' ||
    model.api === 'google-vertex'
  const samplingSupported = !codex && compat.supportsSamplingParams !== false
  const base: ModelCapabilities = Object.freeze({
    contextWindow,
    maxOutputTokens,
    supportedEfforts: supportedEfforts(model),
    canDisableReasoning: codex
      ? !model.reasoning
      : !model.reasoning || model.thinking === undefined || model.thinking.requiresEffort !== true,
    // Anthropic extended thinking and OpenAI Responses reasoning both reject
    // non-default sampling parameters while reasoning; the SDK strips them.
    supportsSamplingWhenThinking: samplingSupported && !anthropic && !responses,
    supportsSamplingParams: samplingSupported,
    // Anthropic accepts stop sequences but no penalty fields; the neutral flag
    // is conjunctive, so it is false there (matching the direct adapter).
    supportsPenaltiesAndStop: !codex && !anthropic && compat.supportsPenaltyAndStopParams !== false,
    forcedToolChoiceSupport: compat.supportsForcedToolChoice === false ? 'none' : 'named',
    disableReasoningOnForcedToolChoice:
      anthropic || google || compat.disableReasoningOnForcedToolChoice === true,
    // Static strict-tool admission: the service must know before dispatch
    // whether this endpoint accepts strict schemas at all.
    disableStrictTools: compat.disableStrictTools === true,
    // `Context` has only a leading system prompt, so a volatile tail can only
    // be projected into the last user turn.
    systemPromptUpdate: 'leading-only',
    toolSchemaDialect: dialectFor(model),
  })
  const merged: ModelCapabilities = Object.freeze({
    ...base,
    ...overrides,
    systemPromptUpdate: 'leading-only',
  })
  return ok(merged)
}
