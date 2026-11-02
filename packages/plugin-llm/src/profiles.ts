/**
 * Named, domain-free profile catalogue.
 *
 * The service never retains a caller-supplied object: `configureProfiles`
 * validates everything all-or-nothing, then publishes a fresh deep-frozen
 * snapshot whose dictionaries are `Object.create(null)` maps read through
 * `Object.hasOwn` only. Keys therefore stay safe for arbitrary well-formed
 * strings (including `"__proto__"` and `"constructor"`).
 */

import type { Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import {
  checkNumberBound,
  DIMENSIONS_BOUND,
  MAX_OUTPUT_TOKENS_BOUND,
  PENALTY_BOUND,
  readOptionNumber,
  TEMPERATURE_BOUND,
  TOP_P_BOUND,
} from './scalars.ts'
import type {
  ChatProfileConfig,
  EmbeddingProfileConfig,
  ProfileRoutingConfig,
  ReasoningEffort,
  RerankProfileConfig,
} from './service-types.ts'
import type { LlmFailure } from './types.ts'
import { failure, isPlainRecord, validString } from './utils.ts'

/** Reasoning effort ladder, cheapest first; `'off'` is always rank 0. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

/** Narrow an unknown value to a {@link ReasoningEffort}. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)
}

/** Rank of a reasoning effort inside {@link REASONING_EFFORTS}. */
export function effortRank(effort: ReasoningEffort): number {
  const rank = REASONING_EFFORTS.indexOf(effort)
  if (rank < 0) throw new Error(`Unknown reasoning effort: ${String(effort)}`)
  return rank
}

const CACHE_RETENTIONS: Readonly<Record<'none' | 'short' | 'long', true>> = Object.freeze({
  none: true,
  short: true,
  long: true,
})

/** Narrow an unknown value to a cache retention tier. */
export function isCacheRetention(value: unknown): value is 'none' | 'short' | 'long' {
  return typeof value === 'string' && Object.hasOwn(CACHE_RETENTIONS, value)
}

function createDictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function invalidRequest(message: string): LlmFailure {
  return failure('INVALID_REQUEST', message)
}

/** Empty frozen catalogue published before the first `configureProfiles` call. */
export function emptyProfileSnapshot(): ProfileRoutingConfig {
  return Object.freeze({
    chatProfiles: Object.freeze(createDictionary<ChatProfileConfig>()),
    embeddingProfiles: Object.freeze(createDictionary<EmbeddingProfileConfig>()),
    rerankProfiles: Object.freeze(createDictionary<RerankProfileConfig>()),
  })
}

function readRequiredIds(
  entry: Readonly<Record<string, unknown>>,
  label: string,
): Result<{ readonly routeId: string; readonly modelId: string }, LlmFailure> {
  const { routeId, modelId } = entry
  if (!validString(routeId, true))
    return err(failure('INVALID_ROUTE', `${label}.routeId must be a non-empty well-formed string`))
  if (!validString(modelId, true))
    return err(failure('INVALID_ROUTE', `${label}.modelId must be a non-empty well-formed string`))
  return ok({ routeId, modelId })
}

function buildChatProfile(
  profileId: string,
  entry: Readonly<Record<string, unknown>>,
): Result<ChatProfileConfig, LlmFailure> {
  const ids = readRequiredIds(entry, `chatProfiles["${profileId}"]`)
  if (!ids.ok) return ids
  const { routeId, modelId } = ids.value
  if (!isReasoningEffort(entry.defaultEffort))
    return err(
      invalidRequest(`chatProfiles["${profileId}"].defaultEffort must be a reasoning effort`),
    )
  if (!isCacheRetention(entry.cacheRetention))
    return err(
      invalidRequest(`chatProfiles["${profileId}"].cacheRetention must be none, short or long`),
    )

  const temperature = readOptionNumber(entry, 'temperature', TEMPERATURE_BOUND)
  if (!temperature.ok) return temperature
  const topP = readOptionNumber(entry, 'topP', TOP_P_BOUND)
  if (!topP.ok) return topP
  const frequencyPenalty = readOptionNumber(entry, 'frequencyPenalty', PENALTY_BOUND)
  if (!frequencyPenalty.ok) return frequencyPenalty
  const presencePenalty = readOptionNumber(entry, 'presencePenalty', PENALTY_BOUND)
  if (!presencePenalty.ok) return presencePenalty
  const maxOutputTokens = readOptionNumber(entry, 'maxOutputTokens', MAX_OUTPUT_TOKENS_BOUND)
  if (!maxOutputTokens.ok) return maxOutputTokens

  return ok(
    Object.freeze({
      routeId: routeId as ChatProfileConfig['routeId'],
      modelId: modelId as ChatProfileConfig['modelId'],
      defaultEffort: entry.defaultEffort,
      temperature: temperature.value,
      topP: topP.value,
      frequencyPenalty: frequencyPenalty.value,
      presencePenalty: presencePenalty.value,
      maxOutputTokens: maxOutputTokens.value,
      cacheRetention: entry.cacheRetention,
    }),
  )
}

function buildEmbeddingProfile(
  profileId: string,
  entry: Readonly<Record<string, unknown>>,
): Result<EmbeddingProfileConfig, LlmFailure> {
  const ids = readRequiredIds(entry, `embeddingProfiles["${profileId}"]`)
  if (!ids.ok) return ids
  const { routeId, modelId } = ids.value
  const dimensions = entry.dimensions
  if (dimensions === undefined)
    return ok(
      Object.freeze({
        routeId: routeId as EmbeddingProfileConfig['routeId'],
        modelId: modelId as EmbeddingProfileConfig['modelId'],
      }),
    )
  if (typeof dimensions !== 'number')
    return err(
      invalidRequest(`embeddingProfiles["${profileId}"].dimensions must be a finite number`),
    )
  const invalid = checkNumberBound(
    `embeddingProfiles["${profileId}"].dimensions`,
    dimensions,
    DIMENSIONS_BOUND,
  )
  if (invalid !== null) return err(invalid)
  return ok(
    Object.freeze({
      routeId: routeId as EmbeddingProfileConfig['routeId'],
      modelId: modelId as EmbeddingProfileConfig['modelId'],
      dimensions,
    }),
  )
}

function buildRerankProfile(
  profileId: string,
  entry: Readonly<Record<string, unknown>>,
): Result<RerankProfileConfig, LlmFailure> {
  const ids = readRequiredIds(entry, `rerankProfiles["${profileId}"]`)
  if (!ids.ok) return ids
  const { routeId, modelId } = ids.value
  return ok(
    Object.freeze({
      routeId: routeId as RerankProfileConfig['routeId'],
      modelId: modelId as RerankProfileConfig['modelId'],
    }),
  )
}

function buildCatalogue<T>(
  source: unknown,
  catalogue: string,
  build: (profileId: string, entry: Readonly<Record<string, unknown>>) => Result<T, LlmFailure>,
): Result<Record<string, T>, LlmFailure> {
  if (source === undefined) return ok(createDictionary<T>())
  if (!isPlainRecord(source))
    return err(invalidRequest(`${catalogue} must be a plain record of profile configurations`))
  const dictionary = createDictionary<T>()
  for (const profileId of Object.keys(source)) {
    if (!validString(profileId, true))
      return err(failure('INVALID_ROUTE', `${catalogue} contains an invalid profile id`))
    const entry = source[profileId]
    if (!isPlainRecord(entry))
      return err(invalidRequest(`${catalogue}["${profileId}"] must be a plain object`))
    const built = build(profileId, entry)
    if (!built.ok) return built
    dictionary[profileId] = built.value
  }
  return ok(Object.freeze(dictionary))
}

/**
 * Validate a caller-supplied catalogue all-or-nothing and return a fresh
 * deep-frozen snapshot. The caller keeps full ownership of its input.
 */
export function buildProfileSnapshot(
  config: ProfileRoutingConfig,
): Result<ProfileRoutingConfig, LlmFailure> {
  if (!isPlainRecord(config))
    return err(invalidRequest('Profile routing config must be a plain object'))
  // `isPlainRecord` narrowed this to a plain record, so unknown value reads are safe.
  const record: Readonly<Record<string, unknown>> = config
  const chatProfiles = buildCatalogue(record.chatProfiles, 'chatProfiles', buildChatProfile)
  if (!chatProfiles.ok) return chatProfiles
  const embeddingProfiles = buildCatalogue(
    record.embeddingProfiles,
    'embeddingProfiles',
    buildEmbeddingProfile,
  )
  if (!embeddingProfiles.ok) return embeddingProfiles
  const rerankProfiles = buildCatalogue(record.rerankProfiles, 'rerankProfiles', buildRerankProfile)
  if (!rerankProfiles.ok) return rerankProfiles
  return ok(
    Object.freeze({
      chatProfiles: chatProfiles.value,
      embeddingProfiles: embeddingProfiles.value,
      rerankProfiles: rerankProfiles.value,
    }),
  )
}
