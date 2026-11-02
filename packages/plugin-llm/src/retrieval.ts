/**
 * Embedding and rerank call plumbing.
 *
 * Targets resolve through the same named-profile / explicit-route split as chat
 * calls. Adapter payloads are shape-checked at the boundary and copied into
 * independent buffers, so callers can neither observe nor corrupt adapter-owned
 * memory. Every adapter call receives a real `AbortSignal`.
 */

import type { Option, Result } from '@sekaisen/core'
import { err, InvariantError, isOption, isSome, NONE, ok, some } from '@sekaisen/core'
import { checkNumberBound, POSITIVE_INTEGER_BOUND } from './scalars.ts'
import type {
  EmbeddingAdapter,
  EmbeddingBatchResult,
  EmbeddingProfileConfig,
  RerankAdapter,
  RerankProfileConfig,
  RerankScoreItem,
  RetrievalTargetSelector,
} from './service-types.ts'
import type { LlmFailure, ModelId, ProfileId, RouteId } from './types.ts'
import { failure, isPlainRecord, isValidLlmFailure, validSafeCount, validString } from './utils.ts'

/** Lookup seams supplied by the owning service. */
export interface RetrievalDeps {
  readonly embeddingAdapter: (routeId: RouteId) => EmbeddingAdapter | undefined
  readonly rerankAdapter: (routeId: RouteId) => RerankAdapter | undefined
  readonly embeddingProfile: (profileId: ProfileId) => EmbeddingProfileConfig | undefined
  readonly rerankProfile: (profileId: ProfileId) => RerankProfileConfig | undefined
}

interface RetrievalTarget {
  readonly routeId: RouteId
  readonly modelId: ModelId
  readonly dimensions: number | undefined
}

/**
 * Wrap an adapter rejection without echoing provider text: the message stays
 * static so a rejected promise can never surface credential material.
 */
function adapterRejection(message: string, cause: unknown): InvariantError {
  const error = new InvariantError(message)
  Object.defineProperty(error, 'cause', {
    value: cause,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  return error
}

function resolveRetrievalTarget(
  target: RetrievalTargetSelector,
  lookup: (
    profileId: ProfileId,
  ) =>
    | { readonly routeId: RouteId; readonly modelId: ModelId; readonly dimensions?: number }
    | undefined,
  catalogue: string,
  allowDimensions: boolean,
): Result<RetrievalTarget, LlmFailure> {
  if (!isPlainRecord(target))
    return err(failure('INVALID_REQUEST', 'Retrieval target must be a plain object'))
  if (target.kind === 'profile') {
    if (!validString(target.profileId, true))
      return err(failure('INVALID_ROUTE', 'Profile id must be a non-empty well-formed string'))
    const profile = lookup(target.profileId)
    if (profile === undefined)
      return err(
        failure('NO_ROUTE', `${catalogue} profile "${target.profileId}" is not configured`),
      )
    return ok({
      routeId: profile.routeId,
      modelId: profile.modelId,
      dimensions: allowDimensions ? profile.dimensions : undefined,
    })
  }
  if (target.kind === 'explicit') {
    if (!validString(target.routeId, true))
      return err(failure('INVALID_ROUTE', 'routeId must be a non-empty well-formed string'))
    if (!validString(target.modelId, true))
      return err(failure('INVALID_ROUTE', 'modelId must be a non-empty well-formed string'))
    const dimensions = allowDimensions ? target.dimensions : undefined
    if (dimensions !== undefined) {
      const invalid = checkNumberBound('dimensions', dimensions, POSITIVE_INTEGER_BOUND)
      if (invalid !== null) return err(invalid)
    }
    return ok({ routeId: target.routeId, modelId: target.modelId, dimensions })
  }
  return err(failure('INVALID_REQUEST', 'Retrieval target kind must be "profile" or "explicit"'))
}

function resolveSignal(signal: AbortSignal | undefined): AbortSignal {
  if (signal === undefined) return new AbortController().signal
  if (!(signal instanceof AbortSignal))
    throw new InvariantError('Retrieval options.signal must be an AbortSignal')
  return signal
}

/** Copy one adapter vector into an independent buffer and validate its values. */
function copyVector(vector: unknown, index: number, expectedDimension: number): Float32Array {
  if (!(vector instanceof Float32Array))
    throw new InvariantError(`Embedding adapter vector ${index} must be a Float32Array`)
  if (vector.length !== expectedDimension)
    throw new InvariantError(
      `Embedding adapter vector ${index} has ${vector.length} dimensions, expected ${expectedDimension}`,
    )
  const copy = new Float32Array(vector)
  for (const value of copy) {
    if (!Number.isFinite(value))
      throw new InvariantError(`Embedding adapter vector ${index} contains a non-finite value`)
  }
  return copy
}

function checkEmbeddingPayload(
  result: EmbeddingBatchResult,
  expectedCount: number,
  dimensions: number | undefined,
): EmbeddingBatchResult {
  const vectors: unknown = result.vectors
  if (!Array.isArray(vectors) || vectors.length !== expectedCount)
    throw new InvariantError(
      `Embedding adapter returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${expectedCount} inputs`,
    )
  const first = vectors[0]
  const expectedDimension = dimensions ?? (first instanceof Float32Array ? first.length : 0)
  if (expectedDimension <= 0) throw new InvariantError('Embedding adapter returned an empty vector')
  const copies: Float32Array[] = vectors.map((vector, index) =>
    copyVector(vector, index, expectedDimension),
  )
  const rawTotal: unknown = result.totalPromptTokens
  if (!isOption(rawTotal))
    throw new InvariantError('EmbeddingBatchResult.totalPromptTokens must be an Option<number>')
  let totalPromptTokens: Option<number> = NONE
  if (isSome(rawTotal)) {
    if (!validSafeCount(rawTotal.value))
      throw new InvariantError(
        'EmbeddingBatchResult.totalPromptTokens must be a non-negative safe integer',
      )
    totalPromptTokens = some(rawTotal.value)
  }
  return Object.freeze({
    vectors: Object.freeze(copies),
    totalPromptTokens,
  })
}

/**
 * Await one adapter call, converting a rejected promise (a channel violation)
 * into an `InvariantError` whose static message never echoes provider text.
 */
async function callEmbedAdapter(
  adapter: EmbeddingAdapter,
  routeId: RouteId,
  modelId: ModelId,
  texts: readonly string[],
  dimensions: number | undefined,
  signal: AbortSignal,
): Promise<Result<EmbeddingBatchResult, LlmFailure>> {
  try {
    return await adapter.embed(
      routeId,
      modelId,
      texts,
      dimensions === undefined ? { signal } : { dimensions, signal },
    )
  } catch (cause) {
    throw adapterRejection('Embedding adapter rejected instead of returning a Result', cause)
  }
}

/** Await one adapter call, converting a rejected promise into an `InvariantError`. */
async function callRerankAdapter(
  adapter: RerankAdapter,
  routeId: RouteId,
  modelId: ModelId,
  query: string,
  documents: readonly string[],
  topN: number | undefined,
  signal: AbortSignal,
): Promise<Result<readonly RerankScoreItem[], LlmFailure>> {
  try {
    return await adapter.rerank(
      routeId,
      modelId,
      query,
      documents,
      topN === undefined ? { signal } : { topN, signal },
    )
  } catch (cause) {
    throw adapterRejection('Rerank adapter rejected instead of returning a Result', cause)
  }
}

/** Embed `texts` through the resolved route and return independent vector copies. */
export async function embed(
  deps: RetrievalDeps,
  target: RetrievalTargetSelector,
  texts: readonly string[],
  options?: { readonly signal?: AbortSignal },
): Promise<Result<EmbeddingBatchResult, LlmFailure>> {
  const resolved = resolveRetrievalTarget(target, deps.embeddingProfile, 'Embedding', true)
  if (!resolved.ok) return resolved
  const { routeId, modelId, dimensions } = resolved.value
  const adapter = deps.embeddingAdapter(routeId)
  if (adapter === undefined)
    return err(failure('NO_ROUTE', `No embedding adapter is registered for route "${routeId}"`))

  if (!Array.isArray(texts) || texts.length === 0)
    return err(failure('INVALID_REQUEST', 'embed requires a non-empty array of texts'))
  for (let index = 0; index < texts.length; index++) {
    const text: unknown = texts[index]
    if (!validString(text))
      return err(failure('INVALID_REQUEST', `texts[${index}] must be a well-formed Unicode string`))
  }

  const signal = resolveSignal(options?.signal)
  if (signal.aborted) return err(failure('ABORTED', 'Embedding call was aborted before it started'))

  const input = Object.freeze([...texts])
  const outcome = await callEmbedAdapter(adapter, routeId, modelId, input, dimensions, signal)
  if (!outcome.ok) {
    if (!isValidLlmFailure(outcome.error))
      throw new InvariantError('Embedding adapter returned a malformed LlmFailure')
    return outcome
  }
  return ok(checkEmbeddingPayload(outcome.value, input.length, dimensions))
}

/** Validate the adapter's score list against the submitted document count. */
function checkRerankPayload(
  items: readonly RerankScoreItem[],
  documentCount: number,
  topN: number | undefined,
): readonly RerankScoreItem[] {
  if (!Array.isArray(items))
    throw new InvariantError('Rerank adapter must return an array of score items')
  if (items.length > documentCount)
    throw new InvariantError('Rerank adapter returned more scores than documents')
  if (topN !== undefined && items.length > topN)
    throw new InvariantError(`Rerank adapter returned ${items.length} scores for topN ${topN}`)
  const seen = new Set<number>()
  const scores: RerankScoreItem[] = []
  for (let position = 0; position < items.length; position++) {
    const item: unknown = items[position]
    if (!isPlainRecord(item))
      throw new InvariantError(`Rerank score item ${position} must be a plain object`)
    const { index, relevanceScore } = item
    if (!validSafeCount(index) || index >= documentCount)
      throw new InvariantError(`Rerank score item ${position} has an out-of-range index`)
    if (typeof relevanceScore !== 'number' || !Number.isFinite(relevanceScore))
      throw new InvariantError(`Rerank score item ${position} has a non-finite relevance score`)
    if (seen.has(index))
      throw new InvariantError(`Rerank adapter returned duplicate index ${index}`)
    seen.add(index)
    scores.push(
      Object.freeze({ index, relevanceScore: Object.is(relevanceScore, -0) ? 0 : relevanceScore }),
    )
  }
  return Object.freeze(scores)
}

/** Rerank `documents` against `query` through the resolved route. */
export async function rerank(
  deps: RetrievalDeps,
  target: RetrievalTargetSelector,
  query: string,
  documents: readonly string[],
  options?: { readonly topN?: number; readonly signal?: AbortSignal },
): Promise<Result<readonly RerankScoreItem[], LlmFailure>> {
  const resolved = resolveRetrievalTarget(target, deps.rerankProfile, 'Rerank', false)
  if (!resolved.ok) return resolved
  const { routeId, modelId } = resolved.value
  const adapter = deps.rerankAdapter(routeId)
  if (adapter === undefined)
    return err(failure('NO_ROUTE', `No rerank adapter is registered for route "${routeId}"`))

  if (!validString(query, true))
    return err(failure('INVALID_REQUEST', 'rerank query must be a non-empty well-formed string'))
  if (!Array.isArray(documents) || documents.length === 0)
    return err(failure('INVALID_REQUEST', 'rerank requires a non-empty array of documents'))
  for (let index = 0; index < documents.length; index++) {
    const document: unknown = documents[index]
    if (!validString(document))
      return err(
        failure('INVALID_REQUEST', `documents[${index}] must be a well-formed Unicode string`),
      )
  }

  let topN: number | undefined
  const rawTopN: unknown = options?.topN
  if (rawTopN !== undefined) {
    if (typeof rawTopN !== 'number')
      return err(failure('INVALID_REQUEST', 'topN must be a positive safe integer'))
    const invalid = checkNumberBound('topN', rawTopN, POSITIVE_INTEGER_BOUND)
    if (invalid !== null) return err(invalid)
    topN = rawTopN
    if (topN > documents.length)
      return err(failure('INVALID_REQUEST', 'topN must not exceed the document count'))
  }

  const signal = resolveSignal(options?.signal)
  if (signal.aborted) return err(failure('ABORTED', 'Rerank call was aborted before it started'))

  const input = Object.freeze([...documents])
  const outcome = await callRerankAdapter(adapter, routeId, modelId, query, input, topN, signal)
  if (!outcome.ok) {
    if (!isValidLlmFailure(outcome.error))
      throw new InvariantError('Rerank adapter returned a malformed LlmFailure')
    return outcome
  }
  return ok(checkRerankPayload(outcome.value, input.length, topN))
}
