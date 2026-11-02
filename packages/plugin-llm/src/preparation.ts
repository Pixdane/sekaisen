/**
 * Synchronous `prepareChatCall` pipeline.
 *
 * Everything a chat call needs — target generation, capability matrix, effort
 * clamp, tool-choice downgrade, sampling stripping, dialect normalization — is
 * decided here, before a single request is sent. The result is an immutable
 * {@link PreparedChatCallSnapshot} plus the generation-bound stream function;
 * later configuration hot updates cannot leak into this call.
 */

import type { Option, Result } from '@sekaisen/core'
import { err, InvariantError, isOption, isSome, NONE, ok, some } from '@sekaisen/core'
import type { BoundChatStream } from './chat-call.ts'
import { effortRank, isCacheRetention, isReasoningEffort, REASONING_EFFORTS } from './profiles.ts'
import type { NumberBound } from './scalars.ts'
import {
  checkNumberBound,
  MAX_OUTPUT_TOKENS_BOUND,
  PENALTY_BOUND,
  TEMPERATURE_BOUND,
  TOP_P_BOUND,
} from './scalars.ts'
import type {
  ChatAdapter,
  ChatCallOverrides,
  ChatProfileConfig,
  ChatTargetSelector,
  ModelCapabilities,
  NeutralToolChoice,
  PreparedChatCallSnapshot,
  ReasoningEffort,
} from './service-types.ts'
import type {
  NeutralToolDefinition,
  NormalizedWireToolSchema,
  ToolSchemaDialect,
} from './tool-schema.ts'
import { normalizeToolSchemas, validateToolDefinition } from './tool-schema.ts'
import type { CacheAlignedChatRequest, LlmFailure, ModelId, ProfileId, RouteId } from './types.ts'
import { cloneFrozen, failure, isPlainRecord, validSafeCount, validString } from './utils.ts'

/** Lookup seams supplied by the owning service. */
export interface ChatPreparationDeps {
  readonly chatAdapter: (routeId: RouteId) => ChatAdapter | undefined
  readonly chatProfile: (profileId: ProfileId) => ChatProfileConfig | undefined
}

/** Resolved, immutable preparation output. */
export interface PreparedChatPlan {
  readonly snapshot: PreparedChatCallSnapshot
  readonly bound: BoundChatStream
}

const AUTO_CHOICE: NeutralToolChoice = Object.freeze({ kind: 'auto' })
const REQUIRED_CHOICE: NeutralToolChoice = Object.freeze({ kind: 'required' })

const TOOL_SCHEMA_DIALECTS: Readonly<Record<ToolSchemaDialect, true>> = Object.freeze({
  'openai-strict': true,
  'openai-non-strict': true,
  'openai-responses': true,
  anthropic: true,
  'google-gemini': true,
  'google-gemini-cca': true,
  'moonshot-mfjs': true,
})

function invalidRequest(message: string): LlmFailure {
  return failure('INVALID_REQUEST', message)
}

/* -------------------------------------------------------------------------- */
/*                              Target resolution                            */
/* -------------------------------------------------------------------------- */

interface ChatTarget {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly profile: ChatProfileConfig | undefined
}

function resolveChatTarget(
  deps: ChatPreparationDeps,
  target: ChatTargetSelector,
): Result<ChatTarget, LlmFailure> {
  if (!isPlainRecord(target)) return err(invalidRequest('Chat target must be a plain object'))
  if (target.kind === 'profile') {
    if (!validString(target.profileId, true))
      return err(failure('INVALID_ROUTE', 'Profile id must be a non-empty well-formed string'))
    const profile = deps.chatProfile(target.profileId)
    if (profile === undefined)
      return err(failure('NO_ROUTE', `Chat profile "${target.profileId}" is not configured`))
    return ok({ routeId: profile.routeId, modelId: profile.modelId, profile })
  }
  if (target.kind === 'explicit') {
    if (!validString(target.routeId, true))
      return err(failure('INVALID_ROUTE', 'routeId must be a non-empty well-formed string'))
    if (!validString(target.modelId, true))
      return err(failure('INVALID_ROUTE', 'modelId must be a non-empty well-formed string'))
    return ok({ routeId: target.routeId, modelId: target.modelId, profile: undefined })
  }
  return err(invalidRequest('Chat target kind must be "profile" or "explicit"'))
}

/* -------------------------------------------------------------------------- */
/*                          Capability matrix intake                         */
/* -------------------------------------------------------------------------- */

/** Read a required boolean capability field, rejecting anything else. */
function readBoolean(record: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = record[field]
  if (typeof value !== 'boolean')
    throw new InvariantError(`ModelCapabilities.${field} must be a boolean`)
  return value
}

function readCapabilities(value: unknown): ModelCapabilities {
  if (!isPlainRecord(value))
    throw new InvariantError('ChatAdapter.resolveCapabilities must return ModelCapabilities')
  const { contextWindow, maxOutputTokens, supportedEfforts } = value
  if (
    typeof contextWindow !== 'number' ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0
  )
    throw new InvariantError('ModelCapabilities.contextWindow must be a positive safe integer')
  if (
    typeof maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0
  )
    throw new InvariantError('ModelCapabilities.maxOutputTokens must be a positive safe integer')
  if (!Array.isArray(supportedEfforts))
    throw new InvariantError('ModelCapabilities.supportedEfforts must be an array')
  const efforts: Exclude<ReasoningEffort, 'off'>[] = []
  for (const effort of supportedEfforts) {
    if (!isReasoningEffort(effort) || effort === 'off')
      throw new InvariantError(
        `ModelCapabilities.supportedEfforts must list thinking efforts only, received ${String(effort)}`,
      )
    efforts.push(effort)
  }
  const forced = value.forcedToolChoiceSupport
  if (forced !== 'named' && forced !== 'required-only' && forced !== 'none')
    throw new InvariantError(
      'ModelCapabilities.forcedToolChoiceSupport must be named, required-only or none',
    )
  const systemPromptUpdate = value.systemPromptUpdate
  if (systemPromptUpdate !== 'leading-only' && systemPromptUpdate !== 'in-history')
    throw new InvariantError(
      'ModelCapabilities.systemPromptUpdate must be leading-only or in-history',
    )
  const dialect = value.toolSchemaDialect
  if (typeof dialect !== 'string' || !Object.hasOwn(TOOL_SCHEMA_DIALECTS, dialect))
    throw new InvariantError('ModelCapabilities.toolSchemaDialect is not a known dialect')
  // Membership in the closed dialect table was just proven.
  const toolSchemaDialect = dialect as ToolSchemaDialect
  let disableStrictTools: boolean | undefined
  const rawStrict = value.disableStrictTools
  if (rawStrict !== undefined) {
    if (typeof rawStrict !== 'boolean')
      throw new InvariantError(
        'ModelCapabilities.disableStrictTools must be a boolean when present',
      )
    disableStrictTools = rawStrict
  }
  return Object.freeze({
    contextWindow,
    maxOutputTokens,
    supportedEfforts: Object.freeze(efforts),
    canDisableReasoning: readBoolean(value, 'canDisableReasoning'),
    supportsSamplingWhenThinking: readBoolean(value, 'supportsSamplingWhenThinking'),
    supportsSamplingParams: readBoolean(value, 'supportsSamplingParams'),
    supportsPenaltiesAndStop: readBoolean(value, 'supportsPenaltiesAndStop'),
    forcedToolChoiceSupport: forced,
    disableReasoningOnForcedToolChoice: readBoolean(value, 'disableReasoningOnForcedToolChoice'),
    systemPromptUpdate,
    toolSchemaDialect,
    ...(disableStrictTools === undefined ? {} : { disableStrictTools }),
  })
}

/* -------------------------------------------------------------------------- */
/*                             Effort resolution                             */
/* -------------------------------------------------------------------------- */

/** Supported thinking efforts, deduplicated and ordered cheap-to-expensive. */
function thinkingEfforts(capabilities: ModelCapabilities): readonly ReasoningEffort[] {
  const ranks = new Set<number>()
  for (const effort of capabilities.supportedEfforts) ranks.add(effortRank(effort))
  return [...ranks].sort((left, right) => left - right).map((rank) => REASONING_EFFORTS[rank]!)
}

/**
 * Clamp a requested effort onto what the target actually supports.
 *
 * Turning thinking off is only honoured when the model allows it; otherwise the
 * request is clamped up to the cheapest thinking level. A thinking request is
 * never silently converted into `'off'`.
 */
function resolveEffort(
  requested: ReasoningEffort,
  capabilities: ModelCapabilities,
): ReasoningEffort {
  const supported = thinkingEfforts(capabilities)
  if (requested === 'off') {
    if (capabilities.canDisableReasoning) return 'off'
    return supported[0] ?? 'off'
  }
  if (supported.length === 0 || supported.includes(requested)) return requested
  let below: ReasoningEffort | undefined
  for (const candidate of supported) {
    if (effortRank(candidate) <= effortRank(requested)) below = candidate
  }
  return below ?? supported[0]!
}

/* -------------------------------------------------------------------------- */
/*                          Tool choice and tools                            */
/* -------------------------------------------------------------------------- */

interface ToolPlan {
  readonly tools: readonly NeutralToolDefinition[]
  readonly choice: NeutralToolChoice
  readonly downgraded: boolean
  readonly effort: ReasoningEffort
}

/**
 * Resolve a neutral tool choice against the target's forced-choice support and
 * its reasoning constraints.
 *
 * A forced choice that cannot be expressed is statically downgraded to `auto`
 * (`downgradedToolChoice = true`); a forced choice that survives may disable
 * reasoning for the turn when the endpoint demands it.
 */
function planTools(
  requested: NeutralToolChoice,
  tools: readonly NeutralToolDefinition[],
  capabilities: ModelCapabilities,
  effort: ReasoningEffort,
): Result<ToolPlan, LlmFailure> {
  const forced = requested.kind === 'required' || requested.kind === 'named'
  if (requested.kind === 'named' && !tools.some((tool) => tool.name === requested.toolName))
    return err(invalidRequest(`Tool choice references an undefined tool "${requested.toolName}"`))
  if (forced && tools.length === 0)
    return err(invalidRequest('A forced tool choice requires at least one tool definition'))
  if (!forced) return ok({ tools, choice: requested, downgraded: false, effort })

  let plannedTools = tools
  let choice: NeutralToolChoice = requested
  let downgraded = false
  switch (capabilities.forcedToolChoiceSupport) {
    case 'none':
      choice = AUTO_CHOICE
      downgraded = true
      break
    case 'required-only':
      if (requested.kind === 'named' && requested.allowSingleToolFilter === true) {
        plannedTools = Object.freeze(tools.filter((tool) => tool.name === requested.toolName))
        choice = REQUIRED_CHOICE
      } else if (requested.kind === 'named') {
        choice = AUTO_CHOICE
        downgraded = true
      } else {
        choice = REQUIRED_CHOICE
      }
      break
    case 'named':
      choice =
        requested.kind === 'named'
          ? Object.freeze({ kind: 'named', toolName: requested.toolName })
          : REQUIRED_CHOICE
      break
    default:
      throw new InvariantError('Unknown forcedToolChoiceSupport capability')
  }

  const stillForced = choice.kind === 'required' || choice.kind === 'named'
  if (stillForced && capabilities.disableReasoningOnForcedToolChoice) {
    if (capabilities.canDisableReasoning) {
      effort = 'off'
    } else {
      choice = AUTO_CHOICE
      downgraded = true
      effort = thinkingEfforts(capabilities)[0] ?? 'off'
    }
  }
  return ok({ tools: plannedTools, choice, downgraded, effort })
}

function readToolChoice(raw: unknown): Result<NeutralToolChoice, LlmFailure> {
  if (raw === undefined) return ok(AUTO_CHOICE)
  if (!isPlainRecord(raw)) return err(invalidRequest('Tool choice must be a plain object'))
  switch (raw.kind) {
    case 'auto':
    case 'none':
    case 'required':
      return ok(Object.freeze({ kind: raw.kind }))
    case 'named': {
      if (!validString(raw.toolName, true))
        return err(invalidRequest('A named tool choice requires a non-empty well-formed toolName'))
      const allowSingleToolFilter: unknown = raw.allowSingleToolFilter
      if (allowSingleToolFilter === undefined)
        return ok(Object.freeze({ kind: 'named', toolName: raw.toolName }))
      if (typeof allowSingleToolFilter !== 'boolean')
        return err(invalidRequest('allowSingleToolFilter must be a boolean'))
      return ok(Object.freeze({ kind: 'named', toolName: raw.toolName, allowSingleToolFilter }))
    }
    default:
      return err(invalidRequest('Tool choice kind must be auto, none, required or named'))
  }
}

function readTools(
  overrides: ChatCallOverrides | undefined,
): Result<readonly NeutralToolDefinition[], LlmFailure> {
  if (overrides === undefined) return ok(Object.freeze([]))
  const raw: unknown = overrides.tools
  if (raw === undefined) return ok(Object.freeze([]))
  if (!Array.isArray(raw)) return err(invalidRequest('overrides.tools must be an array'))
  const names = new Set<string>()
  const definitions: NeutralToolDefinition[] = []
  for (let index = 0; index < raw.length; index++) {
    const tool: unknown = raw[index]
    if (!isPlainRecord(tool) || !validString(tool.name, true))
      return err(invalidRequest(`overrides.tools[${index}] must be a tool definition with a name`))
    const definition = tool as unknown as NeutralToolDefinition
    const validated = validateToolDefinition(definition)
    if (!validated.ok)
      return err(invalidRequest(`overrides.tools[${index}] is invalid: ${validated.error}`))
    if (names.has(definition.name))
      return err(invalidRequest(`Tool name "${definition.name}" is defined more than once`))
    names.add(definition.name)
    definitions.push(definition)
  }
  return ok(Object.freeze(definitions))
}

/* -------------------------------------------------------------------------- */
/*                             Sampling resolution                           */
/* -------------------------------------------------------------------------- */

interface SamplingPlan {
  readonly temperature: Option<number>
  readonly topP: Option<number>
  readonly frequencyPenalty: Option<number>
  readonly presencePenalty: Option<number>
  readonly stopSequences: readonly string[]
  readonly maxOutputTokens: Option<number>
  readonly cacheRetention: 'none' | 'short' | 'long'
  readonly sessionAffinityKey: Option<string>
}

function readOverrideNumber(
  overrides: ChatCallOverrides | undefined,
  field: 'temperature' | 'topP' | 'frequencyPenalty' | 'presencePenalty' | 'maxOutputTokens',
  bound: NumberBound,
): Result<Option<number>, LlmFailure> {
  if (overrides === undefined) return ok(NONE)
  const raw: unknown = overrides[field]
  if (raw === undefined) return ok(NONE)
  if (typeof raw !== 'number') return err(invalidRequest(`${field} must be a finite number`))
  const invalid = checkNumberBound(field, raw, bound)
  if (invalid !== null) return err(invalid)
  return ok(some(Object.is(raw, -0) ? 0 : raw))
}

function readStopSequences(
  overrides: ChatCallOverrides | undefined,
): Result<readonly string[], LlmFailure> {
  if (overrides === undefined) return ok(Object.freeze([]))
  const raw: unknown = overrides.stopSequences
  if (raw === undefined) return ok(Object.freeze([]))
  if (!Array.isArray(raw)) return err(invalidRequest('overrides.stopSequences must be an array'))
  const sequences: string[] = []
  for (let index = 0; index < raw.length; index++) {
    const sequence: unknown = raw[index]
    if (!validString(sequence, true))
      return err(
        invalidRequest(`overrides.stopSequences[${index}] must be a non-empty well-formed string`),
      )
    sequences.push(sequence)
  }
  return ok(Object.freeze(sequences))
}

/**
 * Resolve and strip sampling parameters.
 *
 * Stripping is purely static: endpoints that reject sampling while thinking, or
 * reject sampling altogether, never see the parameter instead of receiving a
 * doomed request that would need a retry.
 */
function planSampling(
  overrides: ChatCallOverrides | undefined,
  profile: ChatProfileConfig | undefined,
  capabilities: ModelCapabilities,
  effort: ReasoningEffort,
): Result<SamplingPlan, LlmFailure> {
  const temperature = readOverrideNumber(overrides, 'temperature', TEMPERATURE_BOUND)
  if (!temperature.ok) return temperature
  const topP = readOverrideNumber(overrides, 'topP', TOP_P_BOUND)
  if (!topP.ok) return topP
  const frequencyPenalty = readOverrideNumber(overrides, 'frequencyPenalty', PENALTY_BOUND)
  if (!frequencyPenalty.ok) return frequencyPenalty
  const presencePenalty = readOverrideNumber(overrides, 'presencePenalty', PENALTY_BOUND)
  if (!presencePenalty.ok) return presencePenalty
  const maxOutputTokens = readOverrideNumber(overrides, 'maxOutputTokens', MAX_OUTPUT_TOKENS_BOUND)
  if (!maxOutputTokens.ok) return maxOutputTokens
  const stopSequences = readStopSequences(overrides)
  if (!stopSequences.ok) return stopSequences

  let resolvedTemperature: Option<number> = isSome(temperature.value)
    ? temperature.value
    : (profile?.temperature ?? NONE)
  let resolvedTopP: Option<number> = isSome(topP.value) ? topP.value : (profile?.topP ?? NONE)
  let resolvedFrequency: Option<number> = isSome(frequencyPenalty.value)
    ? frequencyPenalty.value
    : (profile?.frequencyPenalty ?? NONE)
  let resolvedPresence: Option<number> = isSome(presencePenalty.value)
    ? presencePenalty.value
    : (profile?.presencePenalty ?? NONE)
  let resolvedMaxOutput: Option<number> = isSome(maxOutputTokens.value)
    ? maxOutputTokens.value
    : (profile?.maxOutputTokens ?? NONE)
  let resolvedStops = stopSequences.value

  const stripAll = !capabilities.supportsSamplingParams
  const stripWhileThinking = effort !== 'off' && !capabilities.supportsSamplingWhenThinking
  if (stripAll || stripWhileThinking) {
    resolvedTemperature = NONE
    resolvedTopP = NONE
  }
  if (stripAll) resolvedMaxOutput = NONE
  if (!capabilities.supportsPenaltiesAndStop) {
    resolvedFrequency = NONE
    resolvedPresence = NONE
    resolvedStops = Object.freeze([])
  }
  if (isSome(resolvedMaxOutput))
    resolvedMaxOutput = some(Math.min(resolvedMaxOutput.value, capabilities.maxOutputTokens))

  let cacheRetention: 'none' | 'short' | 'long' = profile?.cacheRetention ?? 'none'
  const rawRetention: unknown = overrides?.cacheRetention
  if (rawRetention !== undefined) {
    if (!isCacheRetention(rawRetention))
      return err(invalidRequest('overrides.cacheRetention must be none, short or long'))
    cacheRetention = rawRetention
  }
  let sessionAffinityKey: Option<string> = NONE
  const rawAffinity: unknown = overrides?.sessionAffinityKey
  if (rawAffinity !== undefined) {
    if (!validString(rawAffinity, true))
      return err(
        invalidRequest('overrides.sessionAffinityKey must be a non-empty well-formed string'),
      )
    sessionAffinityKey = some(rawAffinity)
  }

  return ok(
    Object.freeze({
      temperature: resolvedTemperature,
      topP: resolvedTopP,
      frequencyPenalty: resolvedFrequency,
      presencePenalty: resolvedPresence,
      stopSequences: resolvedStops,
      maxOutputTokens: resolvedMaxOutput,
      cacheRetention,
      sessionAffinityKey,
    }),
  )
}

/* -------------------------------------------------------------------------- */
/*                            Request prevalidation                          */
/* -------------------------------------------------------------------------- */

function checkCacheBreakpoint(
  message: Readonly<Record<string, unknown>>,
  label: string,
): LlmFailure | null {
  if (!Object.hasOwn(message, 'cacheBreakpoint')) return null
  const hint = message.cacheBreakpoint
  if (hint !== 'ephemeral' && hint !== 'long')
    return invalidRequest(`${label}.cacheBreakpoint must be ephemeral or long`)
  return null
}

function checkContentBlock(block: unknown, label: string): LlmFailure | null {
  if (!isPlainRecord(block)) return invalidRequest(`${label} must be a plain object`)
  switch (block.type) {
    case 'text':
    case 'reasoning':
      if (!validString(block.text))
        return invalidRequest(`${label}.text must be a well-formed Unicode string`)
      return null
    case 'tool-call':
      if (!validString(block.id, true))
        return invalidRequest(`${label}.id must be a non-empty well-formed string`)
      if (!validString(block.name, true))
        return invalidRequest(`${label}.name must be a non-empty well-formed string`)
      if (!validString(block.argumentsJson))
        return invalidRequest(`${label}.argumentsJson must be a well-formed Unicode string`)
      return null
    default:
      return invalidRequest(`${label}.type must be text, reasoning or tool-call`)
  }
}

function checkMessage(message: unknown, index: number): LlmFailure | null {
  const label = `segment2WarmHistory[${index}]`
  if (!isPlainRecord(message)) return invalidRequest(`${label} must be a plain object`)
  switch (message.role) {
    case 'user': {
      const content = message.content
      if (!Array.isArray(content))
        return invalidRequest(`${label}.content must be an array of text blocks`)
      for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const block: unknown = content[blockIndex]
        if (!isPlainRecord(block) || block.type !== 'text')
          return invalidRequest(`${label}.content[${blockIndex}] must be a text block`)
        if (!validString(block.text))
          return invalidRequest(
            `${label}.content[${blockIndex}].text must be a well-formed Unicode string`,
          )
      }
      return checkCacheBreakpoint(message, label)
    }
    case 'assistant': {
      const content = message.content
      if (!Array.isArray(content))
        return invalidRequest(`${label}.content must be an array of content blocks`)
      for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const problem = checkContentBlock(content[blockIndex], `${label}.content[${blockIndex}]`)
        if (problem !== null) return problem
      }
      const origin = message.origin
      if (!isPlainRecord(origin)) return invalidRequest(`${label}.origin must be a plain object`)
      if (!validString(origin.routeId, true))
        return invalidRequest(`${label}.origin.routeId must be a non-empty well-formed string`)
      if (!validString(origin.modelId, true))
        return invalidRequest(`${label}.origin.modelId must be a non-empty well-formed string`)
      const replay = origin.replayState
      if (!isOption(replay))
        return invalidRequest(`${label}.origin.replayState must be an Option<ReplayEnvelope>`)
      if (isSome(replay)) {
        const envelope = replay.value
        if (!isPlainRecord(envelope))
          return invalidRequest(`${label}.origin.replayState must carry a ReplayEnvelope shell`)
        if (!validString(envelope.adapterKind, true))
          return invalidRequest(
            `${label}.origin.replayState.adapterKind must be a non-empty well-formed string`,
          )
        if (!validSafeCount(envelope.version))
          return invalidRequest(
            `${label}.origin.replayState.version must be a non-negative safe integer`,
          )
        const blocks = envelope.blocks
        if (blocks !== undefined) {
          if (!Array.isArray(blocks))
            return invalidRequest(`${label}.origin.replayState.blocks must be an array`)
          if (blocks.length !== content.length)
            return invalidRequest(
              `${label}.origin.replayState.blocks must align 1:1 with ${label}.content`,
            )
        }
      }
      return checkCacheBreakpoint(message, label)
    }
    case 'tool-result': {
      if (!validString(message.toolCallId, true))
        return invalidRequest(`${label}.toolCallId must be a non-empty well-formed string`)
      if (!validString(message.toolName, true))
        return invalidRequest(`${label}.toolName must be a non-empty well-formed string`)
      if (!validString(message.content))
        return invalidRequest(`${label}.content must be a well-formed Unicode string`)
      if (typeof message.isError !== 'boolean')
        return invalidRequest(`${label}.isError must be a boolean`)
      return checkCacheBreakpoint(message, label)
    }
    default:
      return invalidRequest(`${label}.role must be user, assistant or tool-result`)
  }
}

function checkOptionalString(value: unknown, label: string): LlmFailure | null {
  if (!isOption(value)) return invalidRequest(`${label} must be an Option<string>`)
  if (isSome(value) && !validString(value.value))
    return invalidRequest(`${label} must contain a well-formed Unicode string`)
  return null
}

/** Full structural and Unicode validation of a chat request, including history. */
function validateRequest(request: unknown): LlmFailure | null {
  if (!isPlainRecord(request)) return invalidRequest('Chat request must be a plain object')

  const staticSegments = request.segment1Static
  if (!Array.isArray(staticSegments))
    return invalidRequest('segment1Static must be an array of system segments')
  for (let index = 0; index < staticSegments.length; index++) {
    const segment: unknown = staticSegments[index]
    if (!isPlainRecord(segment))
      return invalidRequest(`segment1Static[${index}] must be a plain object`)
    if (!validString(segment.name))
      return invalidRequest(`segment1Static[${index}].name must be a well-formed Unicode string`)
    if (!validString(segment.text))
      return invalidRequest(`segment1Static[${index}].text must be a well-formed Unicode string`)
  }

  const history = request.segment2WarmHistory
  if (!Array.isArray(history))
    return invalidRequest('segment2WarmHistory must be an array of neutral messages')
  for (let index = 0; index < history.length; index++) {
    const problem = checkMessage(history[index], index)
    if (problem !== null) return problem
  }

  const tailProblem = checkOptionalString(request.segment3VolatileTail, 'segment3VolatileTail')
  if (tailProblem !== null) return tailProblem
  return checkOptionalString(request.sharedPrefixKey, 'sharedPrefixKey')
}

/* -------------------------------------------------------------------------- */
/*                                   Entry                                   */
/* -------------------------------------------------------------------------- */

function readEffortOverride(
  overrides: ChatCallOverrides | undefined,
): Result<ReasoningEffort | undefined, LlmFailure> {
  if (overrides === undefined) return ok(undefined)
  const raw: unknown = overrides.effort
  if (raw === undefined) return ok(undefined)
  if (!isReasoningEffort(raw))
    return err(invalidRequest('overrides.effort must be a reasoning effort'))
  return ok(raw)
}

/**
 * Run the five synchronous preparation steps and return an immutable snapshot
 * with the generation-bound stream function.
 *
 * Adapter contract violations (a malformed capability matrix, an invalid tool
 * definition that slipped past preflight) throw `InvariantError`; everything a
 * caller can get wrong is reported through `Err(LlmFailure)`.
 */
export function prepareChatCall(
  deps: ChatPreparationDeps,
  target: ChatTargetSelector,
  request: CacheAlignedChatRequest,
  overrides?: ChatCallOverrides,
): Result<PreparedChatPlan, LlmFailure> {
  const resolvedTarget = resolveChatTarget(deps, target)
  if (!resolvedTarget.ok) return resolvedTarget
  const { routeId, modelId, profile } = resolvedTarget.value

  const adapter = deps.chatAdapter(routeId)
  if (adapter === undefined)
    return err(failure('NO_ROUTE', `No chat adapter is registered for route "${routeId}"`))
  const capabilities = adapter.resolveCapabilities(routeId, modelId)
  if (!capabilities.ok) return capabilities
  const matrix = readCapabilities(capabilities.value)
  const retryOwnership = adapter.retryOwnership
  if (
    retryOwnership !== 'caller-owned-single-attempt' &&
    retryOwnership !== 'adapter-managed-transport-and-auth'
  )
    throw new InvariantError('ChatAdapter.retryOwnership is not a known ownership mode')
  const bound = adapter.bindGeneration(routeId, modelId)
  if (!bound.ok) return bound

  const requestProblem = validateRequest(request)
  if (requestProblem !== null) return err(requestProblem)
  if (overrides !== undefined && !isPlainRecord(overrides))
    return err(invalidRequest('Chat call overrides must be a plain object'))

  const effortOverride = readEffortOverride(overrides)
  if (!effortOverride.ok) return effortOverride
  let effort = resolveEffort(effortOverride.value ?? profile?.defaultEffort ?? 'medium', matrix)

  const requestedChoice = readToolChoice(overrides?.toolChoice)
  if (!requestedChoice.ok) return requestedChoice
  const tools = readTools(overrides)
  if (!tools.ok) return tools
  const planned = planTools(requestedChoice.value, tools.value, matrix, effort)
  if (!planned.ok) return planned
  effort = planned.value.effort

  const sampling = planSampling(overrides, profile, matrix, effort)
  if (!sampling.ok) return sampling

  const normalizedTools: readonly NormalizedWireToolSchema[] = Object.freeze(
    normalizeToolSchemas(planned.value.tools, matrix.toolSchemaDialect, {
      disableStrictTools: matrix.disableStrictTools === true,
    }),
  )

  const snapshot: PreparedChatCallSnapshot = Object.freeze({
    routeId,
    modelId,
    retryOwnership,
    capabilities: matrix,
    request: cloneFrozen(request),
    tools: normalizedTools,
    effectiveEffort: effort,
    effectiveToolChoice: planned.value.choice,
    downgradedToolChoice: planned.value.downgraded,
    sampling: sampling.value,
  })
  return ok({ snapshot, bound: bound.value })
}
