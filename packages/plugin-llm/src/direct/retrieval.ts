import { err, isSome, NONE, type Option, ok, type Result, some } from '@sekaisen/core'
import type {
  EmbeddingAdapter,
  EmbeddingBatchResult,
  RerankAdapter,
  RerankScoreItem,
} from '../service-types.ts'
import type { LlmFailure, ModelId, RouteId } from '../types.ts'
import { failure } from '../utils.ts'
import type { DirectAdapterOptions, DirectFetch, DirectProtocol } from './contract.ts'
import {
  buildRequestHeaders,
  classifyDirectFailure,
  classifyHttpResponse,
  DirectRouteTable,
  joinRequestURL,
  type PreparedDirectRoute,
  readResponseText,
  resolveRouteApiKey,
} from './transport.ts'

const EMBEDDINGS_PATH = '/v1/embeddings'
const RERANK_PATH = '/v1/rerank'
const MAX_EMBEDDING_TEXTS = 2_048
const MAX_RERANK_DOCUMENTS = 1_024
const MAX_DIMENSIONS = 8_192
const MAX_RETRIEVAL_RESPONSE_CHARS = 64 * 1024 * 1024
const MAX_ERROR_BODY_CHARS = 8_192

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isUsableModelId(modelId: unknown): modelId is ModelId {
  return typeof modelId === 'string' && modelId.length > 0 && modelId.isWellFormed()
}

/** Retrieval endpoints exist only on the OpenAI-compatible protocol family. */
function supportsRetrieval(protocol: DirectProtocol): boolean {
  return protocol === 'openai-completions' || protocol === 'openai-responses'
}

function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  const rounded = Math.round(value)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

function abortedFailure(): LlmFailure {
  return failure('ABORTED', 'retrieval request aborted by caller')
}

interface RetrievalPost {
  readonly route: PreparedDirectRoute
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly apiKey: Option<string>
  readonly fetchImpl: DirectFetch
  readonly secrets: readonly string[]
}

/** Perform one physical POST and parse a JSON response; never retries. */
async function postRetrievalJson(post: RetrievalPost): Promise<Result<unknown, LlmFailure>> {
  const { route, signal } = post
  if (signal.aborted) return err(abortedFailure())
  const url = joinRequestURL(route.config.baseURL, post.path)
  const headers = buildRequestHeaders({
    engineHeaders: { accept: 'application/json' },
    routeHeaders: route.headers,
    authMode: route.config.authMode ?? 'none',
    protocol: route.config.protocol,
    apiKey: post.apiKey,
  })
  let response: Response
  try {
    response = await post.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(post.body),
      signal,
    })
  } catch (cause) {
    return err(signal.aborted ? abortedFailure() : classifyDirectFailure(cause, post.secrets))
  }
  if (!response.ok) {
    let bodyText = ''
    try {
      bodyText = await readResponseText(response, MAX_ERROR_BODY_CHARS)
    } catch (cause) {
      return err(signal.aborted ? abortedFailure() : classifyDirectFailure(cause, post.secrets))
    }
    return err(classifyHttpResponse(response, bodyText, post.secrets))
  }
  let text: string
  try {
    text = await readResponseText(response, MAX_RETRIEVAL_RESPONSE_CHARS)
  } catch (cause) {
    return err(signal.aborted ? abortedFailure() : classifyDirectFailure(cause, post.secrets))
  }
  try {
    return ok(JSON.parse(text) as unknown)
  } catch {
    return err(failure('MALFORMED_RESPONSE', 'upstream retrieval response was not valid JSON'))
  }
}

function resolveRetrievalRoute(
  table: DirectRouteTable,
  routeId: RouteId,
  modelId: ModelId,
): Result<
  {
    readonly route: PreparedDirectRoute
    readonly apiKey: Option<string>
    readonly secrets: readonly string[]
  },
  LlmFailure
> {
  const route = table.resolveRoute(routeId)
  if (!route.ok) return err(route.error)
  if (!isUsableModelId(modelId)) {
    return err(failure('INVALID_REQUEST', 'model id must be a non-empty well-formed string'))
  }
  if (!supportsRetrieval(route.value.config.protocol)) {
    return err(
      failure(
        'UNSUPPORTED_CAPABILITY',
        `route "${String(routeId)}" protocol "${route.value.config.protocol}" exposes no retrieval endpoint`,
      ),
    )
  }
  const apiKey = resolveRouteApiKey(route.value, table.generation.resolveCredential)
  if (!apiKey.ok) return err(apiKey.error)
  const secrets = isSome(apiKey.value) ? [apiKey.value.value] : []
  return ok({ route: route.value, apiKey: apiKey.value, secrets })
}

/**
 * OpenAI-compatible embeddings adapter. Every returned vector is an independent
 * `Float32Array` with its own backing buffer, mapped back to the caller's input
 * order (never to response order).
 */
export class DirectEmbeddingAdapter implements EmbeddingAdapter {
  readonly adapterKind = 'direct'
  readonly #table: DirectRouteTable

  constructor(options: DirectAdapterOptions) {
    this.#table = new DirectRouteTable(options)
  }

  replaceConfiguration(options: DirectAdapterOptions): Result<void, LlmFailure> {
    return this.#table.replaceConfiguration(options)
  }

  async embed(
    routeId: RouteId,
    modelId: ModelId,
    texts: readonly string[],
    options: { readonly dimensions?: number; readonly signal: AbortSignal },
  ): Promise<Result<EmbeddingBatchResult, LlmFailure>> {
    const resolved = resolveRetrievalRoute(this.#table, routeId, modelId)
    if (!resolved.ok) return err(resolved.error)
    if (!Array.isArray(texts) || texts.length === 0) {
      return err(failure('INVALID_REQUEST', 'embedding texts must be a non-empty array'))
    }
    if (texts.length > MAX_EMBEDDING_TEXTS) {
      return err(
        failure('INVALID_REQUEST', `embedding batch exceeds ${MAX_EMBEDDING_TEXTS} inputs`),
      )
    }
    for (const text of texts) {
      if (typeof text !== 'string' || text.length === 0 || !text.isWellFormed()) {
        return err(
          failure('INVALID_REQUEST', 'embedding inputs must be non-empty well-formed strings'),
        )
      }
    }
    if (options.dimensions !== undefined) {
      if (
        !Number.isSafeInteger(options.dimensions) ||
        options.dimensions <= 0 ||
        options.dimensions > MAX_DIMENSIONS
      ) {
        return err(
          failure('INVALID_REQUEST', `dimensions must be a positive integer <= ${MAX_DIMENSIONS}`),
        )
      }
    }

    const body: Record<string, unknown> = {
      model: String(modelId),
      input: [...texts],
      encoding_format: 'float',
    }
    if (options.dimensions !== undefined) body.dimensions = options.dimensions

    const payload = await postRetrievalJson({
      route: resolved.value.route,
      path: EMBEDDINGS_PATH,
      body,
      signal: options.signal,
      apiKey: resolved.value.apiKey,
      fetchImpl: this.#table.generation.fetchImpl,
      secrets: resolved.value.secrets,
    })
    if (!payload.ok) return err(payload.error)

    const record = asRecord(payload.value)
    const data = record?.data
    if (!Array.isArray(data)) {
      return err(failure('MALFORMED_RESPONSE', 'embedding response did not include a data array'))
    }
    if (data.length !== texts.length) {
      return err(
        failure(
          'MALFORMED_RESPONSE',
          `embedding response returned ${data.length} vectors for ${texts.length} inputs`,
        ),
      )
    }

    const vectors = new Array<Float32Array>(texts.length)
    const assigned = new Array<boolean>(texts.length).fill(false)
    for (const item of data) {
      const entry = asRecord(item)
      if (entry === undefined) {
        return err(failure('MALFORMED_RESPONSE', 'embedding vector entry was not an object'))
      }
      const index = entry.index
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= texts.length
      ) {
        return err(failure('MALFORMED_RESPONSE', 'embedding vector index was out of range'))
      }
      const position = index as number
      if (assigned[position]) {
        return err(failure('MALFORMED_RESPONSE', `embedding response duplicated index ${position}`))
      }
      const raw = entry.embedding
      if (!Array.isArray(raw) || raw.length === 0) {
        return err(failure('MALFORMED_RESPONSE', 'embedding vector was empty'))
      }
      const vector = new Float32Array(raw.length)
      for (let offset = 0; offset < raw.length; offset++) {
        const value = raw[offset]
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return err(failure('MALFORMED_RESPONSE', 'embedding vector contained a non-finite value'))
        }
        vector[offset] = value
      }
      vectors[position] = vector
      assigned[position] = true
    }
    if (!assigned.every(Boolean)) {
      return err(failure('MALFORMED_RESPONSE', 'embedding response did not cover every input'))
    }

    const usage = asRecord(record?.usage)
    const totalPromptTokens = readTokenCount(usage?.prompt_tokens ?? usage?.total_tokens)
    return ok({
      vectors: Object.freeze(vectors),
      totalPromptTokens: totalPromptTokens === undefined ? NONE : some(totalPromptTokens),
    })
  }
}

/**
 * OpenAI-compatible rerank adapter. Server order is preserved unless `topN`
 * is supplied, in which case results are sorted by descending relevance and
 * truncated locally (no extra upstream request).
 */
export class DirectRerankAdapter implements RerankAdapter {
  readonly adapterKind = 'direct'
  readonly #table: DirectRouteTable

  constructor(options: DirectAdapterOptions) {
    this.#table = new DirectRouteTable(options)
  }

  replaceConfiguration(options: DirectAdapterOptions): Result<void, LlmFailure> {
    return this.#table.replaceConfiguration(options)
  }

  async rerank(
    routeId: RouteId,
    modelId: ModelId,
    query: string,
    documents: readonly string[],
    options: { readonly topN?: number; readonly signal: AbortSignal },
  ): Promise<Result<readonly RerankScoreItem[], LlmFailure>> {
    const resolved = resolveRetrievalRoute(this.#table, routeId, modelId)
    if (!resolved.ok) return err(resolved.error)
    if (typeof query !== 'string' || query.length === 0 || !query.isWellFormed()) {
      return err(failure('INVALID_REQUEST', 'rerank query must be a non-empty well-formed string'))
    }
    if (!Array.isArray(documents) || documents.length === 0) {
      return err(failure('INVALID_REQUEST', 'rerank documents must be a non-empty array'))
    }
    if (documents.length > MAX_RERANK_DOCUMENTS) {
      return err(
        failure('INVALID_REQUEST', `rerank batch exceeds ${MAX_RERANK_DOCUMENTS} documents`),
      )
    }
    for (const document of documents) {
      if (typeof document !== 'string' || document.length === 0 || !document.isWellFormed()) {
        return err(
          failure('INVALID_REQUEST', 'rerank documents must be non-empty well-formed strings'),
        )
      }
    }
    if (options.topN !== undefined) {
      if (
        !Number.isSafeInteger(options.topN) ||
        options.topN <= 0 ||
        options.topN > documents.length
      ) {
        return err(
          failure('INVALID_REQUEST', `topN must be a positive integer <= ${documents.length}`),
        )
      }
    }

    const body: Record<string, unknown> = {
      model: String(modelId),
      query,
      documents: [...documents],
    }
    if (options.topN !== undefined) body.top_n = options.topN

    const payload = await postRetrievalJson({
      route: resolved.value.route,
      path: RERANK_PATH,
      body,
      signal: options.signal,
      apiKey: resolved.value.apiKey,
      fetchImpl: this.#table.generation.fetchImpl,
      secrets: resolved.value.secrets,
    })
    if (!payload.ok) return err(payload.error)

    const record = asRecord(payload.value)
    const results = record?.results
    if (!Array.isArray(results)) {
      return err(failure('MALFORMED_RESPONSE', 'rerank response did not include a results array'))
    }
    if (results.length > documents.length) {
      return err(
        failure('MALFORMED_RESPONSE', 'rerank response returned more scores than documents'),
      )
    }
    const scores: RerankScoreItem[] = []
    const seen = new Set<number>()
    for (const raw of results) {
      const entry = asRecord(raw)
      if (entry === undefined) {
        return err(failure('MALFORMED_RESPONSE', 'rerank result entry was not an object'))
      }
      const index = entry.index
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= documents.length
      ) {
        return err(failure('MALFORMED_RESPONSE', 'rerank result index was out of range'))
      }
      const position = index as number
      if (seen.has(position)) {
        return err(failure('MALFORMED_RESPONSE', `rerank response duplicated index ${position}`))
      }
      const score = entry.relevance_score
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        return err(failure('MALFORMED_RESPONSE', 'rerank relevance score was not finite'))
      }
      seen.add(position)
      scores.push(Object.freeze({ index: position, relevanceScore: score }))
    }

    if (options.topN === undefined) return ok(Object.freeze(scores))
    const limited = scores
      .slice()
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
      .slice(0, options.topN)
    return ok(Object.freeze(limited))
  }
}
