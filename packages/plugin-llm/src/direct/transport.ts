import {
  err,
  InvariantError,
  isOption,
  isSome,
  NONE,
  type Option,
  ok,
  type Result,
  some,
} from '@sekaisen/core'
import type { ModelCapabilities, PreparedChatCallSnapshot } from '../service-types.ts'
import type { LlmFailure, ProviderRequestId, RouteId, StreamChunk } from '../types.ts'
import { failure } from '../utils.ts'
import type {
  DirectAdapterOptions,
  DirectCompat,
  DirectFetch,
  DirectProtocol,
  DirectRouteConfig,
  DirectWireEngine,
  SseEvent,
  WireRequest,
} from './contract.ts'
import {
  defaultAuthMode,
  isGatewayKind,
  presetAuthMode,
  presetCompat,
  presetCredentialRef,
  presetHeaders,
} from './gateways.ts'

/** Default first-event watchdog (zero disables the timer). */
export const DIRECT_FIRST_EVENT_TIMEOUT_MS = 120_000
/** Default inter-event idle watchdog (zero disables the timer). */
export const DIRECT_INTER_EVENT_TIMEOUT_MS = 180_000
/** Upper bound applied to upstream diagnostic snippets. */
const MAX_DIAGNOSTIC_CHARS = 400
/** Upper bound for an error body read by {@link readResponseText}. */
const DEFAULT_ERROR_BODY_LIMIT = 8_192

const FAILURE_CODES: readonly string[] = Object.freeze([
  'NO_ROUTE',
  'DUPLICATE_ROUTE',
  'INVALID_ROUTE',
  'REGISTRATION_DISPOSED',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'QUOTA',
  'RATE_LIMIT',
  'CONTEXT_WINDOW_EXCEEDED',
  'CONTENT_BLOCKED',
  'INVALID_REQUEST',
  'UNSUPPORTED_CAPABILITY',
  'MALFORMED_RESPONSE',
  'EMPTY_RESPONSE',
  'SERVER',
  'TRANSPORT',
  'TIMEOUT',
  'ABORTED',
])

const AUTH_HEADER_NAMES: readonly string[] = Object.freeze([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'proxy-authorization',
])

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/* -------------------------------------------------------------------------- */
/*                          shared request plumbing                           */
/* -------------------------------------------------------------------------- */

/**
 * Join a configured base URL with a wire path without duplicating a version
 * segment.
 *
 * The wire path always starts with its version prefix (`/v1/...`,
 * `/v1beta/...`). Callers commonly configure either a host root
 * (`https://api.openai.com`), a host root with the same version already
 * attached (`http://127.0.0.1:4096/v1`), or a gateway prefix
 * (`https://api.deepseek.com/anthropic`). The first version segment is dropped
 * from the path only when the base URL's final path segment is exactly that
 * version, so prefixes are preserved and `/v1/v1/...` can never occur.
 */
export function joinRequestURL(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  if (suffix === '/') return base
  let basePath = ''
  try {
    basePath = new URL(base).pathname.replace(/\/+$/, '')
  } catch {
    basePath = ''
  }
  const baseLastSegment = basePath.slice(basePath.lastIndexOf('/') + 1).toLowerCase()
  const pathEnd = suffix.search(/[?#]/)
  const pathOnly = pathEnd === -1 ? suffix : suffix.slice(0, pathEnd)
  const tail = pathEnd === -1 ? '' : suffix.slice(pathEnd)
  const nextSlash = pathOnly.indexOf('/', 1)
  const versionSegment = (
    nextSlash === -1 ? pathOnly.slice(1) : pathOnly.slice(1, nextSlash)
  ).toLowerCase()
  if (baseLastSegment.length > 0 && baseLastSegment === versionSegment) {
    const remainder = nextSlash === -1 ? '' : pathOnly.slice(nextSlash)
    return `${base}${remainder}${tail}`
  }
  return `${base}${suffix}`
}

/** Resolve credentials from the ambient environment by reference name. */
export function environmentCredentialResolver(reference: string): string | undefined {
  if (typeof process === 'undefined' || process.env === undefined) return undefined
  return process.env[reference]
}

/**
 * Validate an API key without ever echoing it: only the route id and the
 * credential reference may appear in a failure message.
 */
export function assertUsableApiKey(
  rawValue: unknown,
  routeId: string,
  credentialRef: string | undefined,
): Result<string, LlmFailure> {
  const reference =
    credentialRef === undefined || credentialRef.length === 0 ? '(unnamed)' : credentialRef
  if (typeof rawValue !== 'string') {
    return err(
      failure(
        'MISSING_CREDENTIAL',
        `credential "${reference}" for route "${routeId}" resolved to a non-string value`,
      ),
    )
  }
  const trimmed = rawValue.trim()
  if (trimmed.length === 0) {
    return err(
      failure('INVALID_CREDENTIAL', `credential "${reference}" for route "${routeId}" is blank`),
    )
  }
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint > 0x7e) {
      return err(
        failure(
          'INVALID_CREDENTIAL',
          `credential "${reference}" for route "${routeId}" contains characters outside the HTTP header range`,
        ),
      )
    }
  }
  return ok(trimmed)
}

/**
 * Normalize an adapter configuration route: preset headers merged under literal
 * route headers, auth/protocol defaults resolved, compatibility switches
 * merged. All fields are copied (never aliased) and frozen.
 */
function normalizeRoute(
  routeId: string,
  input: DirectRouteConfig,
): Result<PreparedDirectRoute, LlmFailure> {
  const routeLabel = routeId.slice(0, 120)
  if (routeId.length === 0 || !routeId.isWellFormed()) {
    return err(failure('INVALID_ROUTE', 'route ids must be non-empty well-formed strings'))
  }
  if (typeof input !== 'object' || input === null) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" configuration must be an object`))
  }
  if (!isDirectProtocol(input.protocol)) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" declares an unknown protocol`))
  }
  const protocol = input.protocol
  if (typeof input.baseURL !== 'string') {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" requires a string baseURL`))
  }
  const baseResult = validateBaseURL(input.baseURL, routeLabel)
  if (!baseResult.ok) return baseResult
  const gateway = input.gateway ?? 'custom'
  if (!isGatewayKind(gateway)) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" declares an unknown gateway`))
  }
  if (input.authMode !== undefined && !isAuthMode(input.authMode)) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" declares an unknown authMode`))
  }
  const firstEventTimeoutMs = input.firstEventTimeoutMs ?? DIRECT_FIRST_EVENT_TIMEOUT_MS
  if (!isTimeout(firstEventTimeoutMs)) {
    return err(
      failure('INVALID_ROUTE', `route "${routeLabel}" firstEventTimeoutMs must be finite and >= 0`),
    )
  }
  const interEventTimeoutMs = input.interEventTimeoutMs ?? DIRECT_INTER_EVENT_TIMEOUT_MS
  if (!isTimeout(interEventTimeoutMs)) {
    return err(
      failure('INVALID_ROUTE', `route "${routeLabel}" interEventTimeoutMs must be finite and >= 0`),
    )
  }
  const credentialRef = input.credentialRef ?? presetCredentialRef(gateway, protocol)
  if (credentialRef !== undefined) {
    if (credentialRef.length === 0 || !credentialRef.isWellFormed() || credentialRef.length > 256) {
      return err(failure('INVALID_ROUTE', `route "${routeLabel}" has an invalid credentialRef`))
    }
  }
  const capabilitiesResult = validateCapabilities(input.capabilities, routeLabel)
  if (!capabilitiesResult.ok) return capabilitiesResult
  const compatResult = validateCompat(input.compat, routeLabel)
  if (!compatResult.ok) return compatResult

  const headersResult = mergeRouteHeaders(presetHeaders(gateway), input.headers, routeLabel)
  if (!headersResult.ok) return headersResult

  const compat = { ...presetCompat(gateway, protocol), ...compatResult.value }
  const authMode = input.authMode ?? presetAuthMode(gateway, protocol) ?? defaultAuthMode(protocol)
  const config: DirectRouteConfig = Object.freeze({
    protocol,
    baseURL: baseResult.value,
    authMode,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(Object.keys(headersResult.value).length === 0
      ? {}
      : { headers: Object.freeze(headersResult.value) }),
    ...(gateway === 'custom' ? {} : { gateway }),
    ...(input.capabilities === undefined
      ? {}
      : { capabilities: Object.freeze({ ...input.capabilities }) }),
    ...(Object.keys(compat).length === 0 ? {} : { compat: Object.freeze(compat) }),
    firstEventTimeoutMs,
    interEventTimeoutMs,
  })
  return ok(
    Object.freeze({
      routeId: routeId as PreparedDirectRoute['routeId'],
      config,
      headers: Object.freeze(headersResult.value),
      firstEventTimeoutMs,
      interEventTimeoutMs,
      gateway,
    }),
  )
}

function isDirectProtocol(value: unknown): value is DirectProtocol {
  return (
    value === 'anthropic-messages' ||
    value === 'openai-completions' ||
    value === 'openai-responses' ||
    value === 'google-gemini'
  )
}

function isAuthMode(value: unknown): value is NonNullable<DirectRouteConfig['authMode']> {
  return value === 'bearer' || value === 'x-api-key' || value === 'none'
}

function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validateBaseURL(baseURL: string, routeLabel: string): Result<string, LlmFailure> {
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" baseURL is not an absolute URL`))
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" baseURL must use http or https`))
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" baseURL must not embed credentials`))
  }
  if (parsed.hash.length > 0) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" baseURL must not carry a fragment`))
  }
  if (parsed.search.length > 0) {
    return err(
      failure('INVALID_ROUTE', `route "${routeLabel}" baseURL must not carry a query string`),
    )
  }
  return ok(baseURL.replace(/\/+$/, ''))
}

function validateCapabilities(
  capabilities: Partial<ModelCapabilities> | undefined,
  routeLabel: string,
): Result<void, LlmFailure> {
  if (capabilities === undefined) return ok(undefined)
  if (typeof capabilities !== 'object' || capabilities === null) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" capabilities must be an object`))
  }
  for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
    const value = capabilities[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      return err(
        failure(
          'INVALID_ROUTE',
          `route "${routeLabel}" capabilities.${key} must be a positive safe integer`,
        ),
      )
    }
  }
  const efforts = capabilities.supportedEfforts
  if (efforts !== undefined) {
    if (!Array.isArray(efforts) || efforts.some((value) => !isEffort(value))) {
      return err(
        failure('INVALID_ROUTE', `route "${routeLabel}" capabilities.supportedEfforts is invalid`),
      )
    }
  }
  for (const key of [
    'canDisableReasoning',
    'supportsSamplingWhenThinking',
    'supportsSamplingParams',
    'supportsPenaltiesAndStop',
    'disableReasoningOnForcedToolChoice',
    'disableStrictTools',
  ] as const) {
    const value = capabilities[key]
    if (value !== undefined && typeof value !== 'boolean') {
      return err(
        failure('INVALID_ROUTE', `route "${routeLabel}" capabilities.${key} must be boolean`),
      )
    }
  }
  const forced = capabilities.forcedToolChoiceSupport
  if (
    forced !== undefined &&
    forced !== 'named' &&
    forced !== 'required-only' &&
    forced !== 'none'
  ) {
    return err(
      failure(
        'INVALID_ROUTE',
        `route "${routeLabel}" capabilities.forcedToolChoiceSupport is invalid`,
      ),
    )
  }
  const systemPrompt = capabilities.systemPromptUpdate
  if (
    systemPrompt !== undefined &&
    systemPrompt !== 'leading-only' &&
    systemPrompt !== 'in-history'
  ) {
    return err(
      failure('INVALID_ROUTE', `route "${routeLabel}" capabilities.systemPromptUpdate is invalid`),
    )
  }
  const dialect = capabilities.toolSchemaDialect
  if (dialect !== undefined && !isToolSchemaDialect(dialect)) {
    return err(
      failure('INVALID_ROUTE', `route "${routeLabel}" capabilities.toolSchemaDialect is invalid`),
    )
  }
  return ok(undefined)
}

function isEffort(value: unknown): boolean {
  return (
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

function isToolSchemaDialect(value: unknown): boolean {
  return (
    value === 'openai-strict' ||
    value === 'openai-non-strict' ||
    value === 'openai-responses' ||
    value === 'anthropic' ||
    value === 'google-gemini' ||
    value === 'google-gemini-cca' ||
    value === 'moonshot-mfjs'
  )
}

function validateCompat(
  compat: DirectCompat | undefined,
  routeLabel: string,
): Result<DirectCompat, LlmFailure> {
  if (compat === undefined) return ok({})
  if (typeof compat !== 'object' || compat === null) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" compat must be an object`))
  }
  for (const key of [
    'disableStrictTools',
    'stripTemplateTokens',
    'omitImplicitMaxTokens',
  ] as const) {
    const value = compat[key]
    if (value !== undefined && typeof value !== 'boolean') {
      return err(failure('INVALID_ROUTE', `route "${routeLabel}" compat.${key} must be boolean`))
    }
  }
  if (
    compat.reasoningField !== undefined &&
    compat.reasoningField !== 'reasoning_content' &&
    compat.reasoningField !== 'reasoning'
  ) {
    return err(failure('INVALID_ROUTE', `route "${routeLabel}" compat.reasoningField is invalid`))
  }
  return ok(compat)
}

function isHeaderValueValid(value: unknown): value is string {
  if (typeof value !== 'string') return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0x09) continue
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

function mergeRouteHeaders(
  base: Readonly<Record<string, string>>,
  override: Readonly<Record<string, string>> | undefined,
  routeLabel: string,
): Result<Record<string, string>, LlmFailure> {
  const merged = new Map<string, { readonly name: string; readonly value: string }>()
  for (const [name, value] of Object.entries(base)) {
    merged.set(name.toLowerCase(), { name, value })
  }
  if (override !== undefined) {
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      return err(failure('INVALID_ROUTE', `route "${routeLabel}" headers must be a record`))
    }
    const seen = new Set<string>()
    for (const [name, value] of Object.entries(override)) {
      if (!HEADER_NAME_PATTERN.test(name)) {
        return err(failure('INVALID_ROUTE', `route "${routeLabel}" has an invalid header name`))
      }
      if (!isHeaderValueValid(value)) {
        return err(
          failure('INVALID_ROUTE', `route "${routeLabel}" header "${name}" has an invalid value`),
        )
      }
      const lowered = name.toLowerCase()
      if (seen.has(lowered)) {
        return err(
          failure(
            'INVALID_ROUTE',
            `route "${routeLabel}" repeats header "${name}" case-insensitively`,
          ),
        )
      }
      seen.add(lowered)
      merged.set(lowered, { name, value })
    }
  }
  const headers: Record<string, string> = {}
  for (const { name, value } of merged.values()) headers[name] = value
  return ok(headers)
}

/* -------------------------------------------------------------------------- */
/*                       generation (configuration snapshot)                 */
/* -------------------------------------------------------------------------- */

/** Immutable per-route configuration snapshot used by one bound generation. */
export interface PreparedDirectRoute {
  readonly routeId: RouteId
  readonly config: DirectRouteConfig
  readonly headers: Readonly<Record<string, string>>
  readonly firstEventTimeoutMs: number
  readonly interEventTimeoutMs: number
  readonly gateway: NonNullable<DirectRouteConfig['gateway']> | 'custom'
}

/** Credential resolver seam: reference name in, clear-text key (or nothing) out. */
export type DirectCredentialResolver = (reference: string) => string | undefined

/** Frozen adapter generation produced by one configuration replacement. */
export interface DirectGeneration {
  readonly routes: ReadonlyMap<string, PreparedDirectRoute>
  readonly fetchImpl: DirectFetch
  readonly resolveCredential: DirectCredentialResolver
}

/** Validate a whole adapter configuration atomically into a generation snapshot. */
export function prepareDirectGeneration(
  options: DirectAdapterOptions,
): Result<DirectGeneration, LlmFailure> {
  if (typeof options !== 'object' || options === null) {
    return err(failure('INVALID_ROUTE', 'direct adapter options must be an object'))
  }
  if (typeof options.routes !== 'object' || options.routes === null) {
    return err(failure('INVALID_ROUTE', 'direct adapter routes must be a record'))
  }
  const routeIds = Object.keys(options.routes)
  if (routeIds.length === 0) {
    return err(failure('INVALID_ROUTE', 'direct adapter requires at least one route'))
  }
  const routes = new Map<string, PreparedDirectRoute>()
  for (const routeId of routeIds) {
    const config = options.routes[routeId]
    if (config === undefined) {
      return err(failure('INVALID_ROUTE', `route "${routeId}" configuration is missing`))
    }
    const normalized = normalizeRoute(routeId, config)
    if (!normalized.ok) return normalized
    routes.set(routeId, normalized.value)
  }
  const fetchImpl: DirectFetch = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return err(failure('INVALID_ROUTE', 'direct adapter fetch implementation must be callable'))
  }
  const resolveCredential = options.resolveCredential ?? environmentCredentialResolver
  if (typeof resolveCredential !== 'function') {
    return err(failure('INVALID_ROUTE', 'direct adapter credential resolver must be callable'))
  }
  return ok(
    Object.freeze({
      routes: routes as ReadonlyMap<string, PreparedDirectRoute>,
      fetchImpl,
      resolveCredential,
    }),
  )
}

/**
 * Configuration holder shared by the chat/embedding/rerank adapters: an atomic,
 * synchronous, generation-based replacement with an immutable snapshot.
 */
export class DirectRouteTable {
  #generation: DirectGeneration

  constructor(options: DirectAdapterOptions) {
    const prepared = prepareDirectGeneration(options)
    if (!prepared.ok) {
      throw new InvariantError(
        `direct adapter configuration rejected: ${prepared.error.code}: ${prepared.error.message}`,
      )
    }
    this.#generation = prepared.value
  }

  get generation(): DirectGeneration {
    return this.#generation
  }

  replaceConfiguration(options: DirectAdapterOptions): Result<void, LlmFailure> {
    const prepared = prepareDirectGeneration(options)
    if (!prepared.ok) return err(prepared.error)
    this.#generation = prepared.value
    return ok(undefined)
  }

  resolveRoute(routeId: RouteId): Result<PreparedDirectRoute, LlmFailure> {
    if (typeof routeId !== 'string' || routeId.length === 0) {
      return err(failure('INVALID_ROUTE', 'route id must be a non-empty string'))
    }
    const route = this.#generation.routes.get(routeId)
    if (route === undefined) {
      return err(failure('NO_ROUTE', `no direct route registered for "${routeId.slice(0, 120)}"`))
    }
    return ok(route)
  }
}

/** Resolve and validate the credential bound to one route snapshot. */
export function resolveRouteApiKey(
  route: PreparedDirectRoute,
  resolveCredential: DirectCredentialResolver,
): Result<Option<string>, LlmFailure> {
  const mode = route.config.authMode ?? 'none'
  const routeLabel = String(route.routeId).slice(0, 120)
  if (mode === 'none') return ok(NONE)
  const reference = route.config.credentialRef
  if (reference === undefined) {
    return err(
      failure(
        'MISSING_CREDENTIAL',
        `route "${routeLabel}" uses ${mode} auth but declares no credential reference`,
      ),
    )
  }
  let raw: string | undefined
  try {
    raw = resolveCredential(reference)
  } catch {
    return err(
      failure(
        'INVALID_CREDENTIAL',
        `credential provider failed for "${reference}" on route "${routeLabel}"`,
      ),
    )
  }
  if (raw === undefined || raw === null) {
    return err(
      failure(
        'MISSING_CREDENTIAL',
        `no value resolved for credential "${reference}" on route "${routeLabel}"`,
      ),
    )
  }
  const checked = assertUsableApiKey(raw, routeLabel, reference)
  if (!checked.ok) return err(checked.error)
  return ok(some(checked.value))
}

/* -------------------------------------------------------------------------- */
/*                              request headers                              */
/* -------------------------------------------------------------------------- */

/** Inputs for {@link buildRequestHeaders}; auth headers are always runtime-owned. */
export interface RequestHeaderInput {
  readonly engineHeaders: Readonly<Record<string, string>> | undefined
  readonly routeHeaders: Readonly<Record<string, string>>
  readonly authMode: NonNullable<DirectRouteConfig['authMode']>
  readonly protocol: DirectProtocol
  readonly apiKey: Option<string>
}

/** Merge protocol headers with route headers, then inject the owned auth header. */
export function buildRequestHeaders(input: RequestHeaderInput): Record<string, string> {
  const merged = new Map<string, { readonly name: string; readonly value: string }>()
  const put = (name: string, value: string): void => {
    merged.set(name.toLowerCase(), { name, value })
  }
  for (const source of [input.engineHeaders, input.routeHeaders]) {
    if (source === undefined) continue
    for (const [name, value] of Object.entries(source)) {
      if (AUTH_HEADER_NAMES.includes(name.toLowerCase())) continue
      put(name, value)
    }
  }
  if (!merged.has('content-type')) put('content-type', 'application/json')
  if (!merged.has('accept')) put('accept', 'text/event-stream')
  if (!merged.has('user-agent')) put('user-agent', 'sekaisen-plugin-llm/0.1')

  if (isSome(input.apiKey) && input.authMode !== 'none') {
    const key = input.apiKey.value
    if (input.protocol === 'google-gemini' && input.authMode === 'x-api-key') {
      put('x-goog-api-key', key)
    } else if (input.authMode === 'x-api-key') {
      put('x-api-key', key)
    } else {
      put('authorization', `Bearer ${key}`)
    }
  }

  const headers: Record<string, string> = {}
  for (const { name, value } of merged.values()) headers[name] = value
  return headers
}

/* -------------------------------------------------------------------------- */
/*                          failure classification                           */
/* -------------------------------------------------------------------------- */

function isFailureCode(value: unknown): value is LlmFailure['code'] {
  return typeof value === 'string' && FAILURE_CODES.includes(value)
}

/** Shape check for a plain (non-`Error`) {@link LlmFailure} thrown by an engine. */
export function isLlmFailure(value: unknown): value is LlmFailure {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return isFailureCode(record.code) && typeof record.message === 'string'
}

function optionOf<T>(value: unknown): Option<T> {
  return isOption(value) ? (value as unknown as Option<T>) : NONE
}

/** Redact literal secrets and credential-looking substrings from diagnostics. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let output = text
  for (const secret of secrets) {
    if (secret.length < 4) continue
    output = output.split(secret).join('[redacted]')
  }
  output = output.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[redacted]')
  output = output.replace(
    /((?:x-api-key|x-goog-api-key|api-key|authorization)\s*[:=]\s*)[^\s,;"'}]+/gi,
    '$1[redacted]',
  )
  output = output.replace(/\b(?:sk|rk|pk|gsk|xai)-[A-Za-z0-9_-]{6,}\b/g, '[redacted]')
  return output
}

/** Redact, strip control characters, and bound a diagnostic message. */
export function sanitizeMessage(
  text: string,
  secrets: readonly string[],
  limit: number = MAX_DIAGNOSTIC_CHARS,
): string {
  const redacted = redactSecrets(text, secrets)
  let output = ''
  for (const character of redacted) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0xd800 && code <= 0xdfff) {
      // Lone surrogate code units are not well-formed Unicode; never let them
      // reach an LlmFailure message or an emitted stream frame.
      output += '\uFFFD'
      continue
    }
    if (code < 0x20 || code === 0x7f) {
      output += ' '
      continue
    }
    output += character
  }
  const trimmed = output.trim()
  if (trimmed.length <= limit) return trimmed
  const cut = trimmed.slice(0, limit)
  const lastUnit = cut.charCodeAt(cut.length - 1)
  // Never truncate between a surrogate pair: the message must stay well-formed.
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut
}

/** Normalize any thrown value into a safe {@link LlmFailure}. */
export function classifyDirectFailure(cause: unknown, secrets: readonly string[]): LlmFailure {
  if (isLlmFailure(cause)) {
    const status = optionOf<number>(Reflect.get(cause, 'status'))
    const retryAfterMs = optionOf<number>(Reflect.get(cause, 'retryAfterMs'))
    // A stale or hostile thrown failure must not make `failure()` throw and
    // escape the transport: drop fields outside the documented ranges.
    const statusIsValid =
      isSome(status) &&
      Number.isSafeInteger(status.value) &&
      status.value >= 100 &&
      status.value <= 599
    const retryIsValid =
      isSome(retryAfterMs) && Number.isFinite(retryAfterMs.value) && retryAfterMs.value >= 0
    return failure(cause.code, sanitizeMessage(cause.message, secrets), {
      status: statusIsValid ? status : NONE,
      retryAfterMs: retryIsValid ? retryAfterMs : NONE,
      requestId: sanitizeRequestId(Reflect.get(cause, 'requestId'), secrets),
    })
  }
  if (cause instanceof Error) {
    const name = cause.name
    if (name === 'AbortError') {
      return failure('ABORTED', 'upstream request was aborted')
    }
    if (name === 'TimeoutError') {
      return failure('TIMEOUT', 'upstream request timed out')
    }
    return failure('TRANSPORT', sanitizeMessage(cause.message, secrets))
  }
  return failure('TRANSPORT', 'upstream transport failed')
}

/**
 * Diagnostic trace ids are only kept when they cannot carry credential
 * material. An upstream that echoes the API key into `x-request-id` (or any
 * credential-shaped value such as a Bearer token) gets the id dropped rather
 * than partially redacted, because a partial trace id is misleading.
 */
function sanitizeRequestId(raw: unknown, secrets: readonly string[]): Option<ProviderRequestId> {
  const value = isOption(raw) ? (isSome(raw) ? raw.value : undefined) : raw
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return NONE
  if (!value.isWellFormed()) return NONE
  if (redactSecrets(value, secrets) !== value) return NONE
  return some(value as ProviderRequestId)
}

function extractRequestId(headers: Headers, secrets: readonly string[]): Option<ProviderRequestId> {
  for (const name of [
    'x-request-id',
    'request-id',
    'openai-request-id',
    'x-amzn-requestid',
    'cf-ray',
  ]) {
    const value = headers.get(name)
    if (value === null) continue
    const requestId = sanitizeRequestId(value, secrets)
    if (isSome(requestId)) return requestId
  }
  return NONE
}

function parseRetryAfter(headers: Headers): Option<number> {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return secondsAsMillis(seconds)
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return some(Math.max(0, date - Date.now()))
  }
  const resetAfter = headers.get('x-ratelimit-reset-after')
  if (resetAfter !== null) {
    const seconds = Number(resetAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return secondsAsMillis(seconds)
  }
  return NONE
}

/** Convert a Retry-After second count into bounded milliseconds. */
function secondsAsMillis(seconds: number): Option<number> {
  const millis = Math.round(seconds * 1000)
  return Number.isFinite(millis) ? some(millis) : NONE
}

function extractUpstreamMessage(bodyText: string): string {
  if (bodyText.length === 0) return ''
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (typeof error === 'string') return error
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string') return message
      }
      if (typeof record.message === 'string') return record.message
      if (typeof record.detail === 'string') return record.detail
    }
  } catch {
    // Non-JSON diagnostics are used verbatim (after redaction).
  }
  return bodyText
}

const CONTEXT_OVERFLOW_PATTERN =
  /context[ _-]?(?:window|length)|maximum context|too many tokens|prompt is too long/i
const CONTENT_BLOCKED_PATTERN =
  /content[ _-]?(?:filter|policy)|safety|moderation|prohibited|blocklist/i

/** Map an HTTP error response to the closed {@link LlmFailure} taxonomy. */
export function classifyHttpResponse(
  response: Response,
  bodyText: string,
  secrets: readonly string[],
): LlmFailure {
  const status = response.status
  const detail = sanitizeMessage(extractUpstreamMessage(bodyText), secrets)
  const statusText = sanitizeMessage(response.statusText || 'upstream error', secrets, 80)
  const summary = `${status} ${statusText}`
  const message = detail.length === 0 ? summary : `${summary}: ${detail}`
  const requestId = extractRequestId(response.headers, secrets)
  const details = {
    status: some(status),
    retryAfterMs: parseRetryAfter(response.headers),
    requestId,
  }
  if (status === 401 || status === 403) return failure('AUTH', message, details)
  if (status === 402) return failure('QUOTA', message, details)
  if (status === 408) return failure('TIMEOUT', message, details)
  if (status === 429) return failure('RATE_LIMIT', message, details)
  if (status >= 500) return failure('SERVER', message, details)
  if (status === 400 || status === 413 || status === 422) {
    if (CONTEXT_OVERFLOW_PATTERN.test(bodyText)) {
      return failure('CONTEXT_WINDOW_EXCEEDED', message, details)
    }
    if (CONTENT_BLOCKED_PATTERN.test(bodyText)) {
      return failure('CONTENT_BLOCKED', message, details)
    }
    return failure('INVALID_REQUEST', message, details)
  }
  if (status >= 400) return failure('INVALID_REQUEST', message, details)
  return failure('SERVER', message, details)
}

/* -------------------------------------------------------------------------- */
/*                                SSE parsing                                */
/* -------------------------------------------------------------------------- */

/** Watchdog configuration for {@link parseSseStream}. */
export interface SseWatchdogOptions {
  readonly firstEventTimeoutMs: number
  readonly interEventTimeoutMs: number
  /**
   * Absolute epoch-ms deadline for the first dispatched SSE event. The direct
   * runtime computes it before dispatching the physical request, so a hanging
   * fetch/error-body consumes the same budget. When omitted the parser derives
   * an equivalent absolute deadline from `firstEventTimeoutMs` at entry.
   */
  readonly firstEventDeadline?: number
}

/**
 * Outcome of one raced socket read. The read-result type is a generic parameter
 * so the runtime stays independent of whether `ReadableStream` comes from the
 * DOM lib (Node) or Bun's own declarations — their read-result shapes differ in
 * optional members but are structurally interchangeable at the call site.
 */
type ReadOutcome<T> =
  | { readonly kind: 'result'; readonly result: T }
  | { readonly kind: 'abort' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error'; readonly error: unknown }

function raceOperation<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  deadline: number | undefined,
): Promise<ReadOutcome<T>> {
  const { promise, resolve } = Promise.withResolvers<ReadOutcome<T>>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = (): void => finish({ kind: 'abort' })
  const finish = (outcome: ReadOutcome<T>): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    resolve(outcome)
  }
  // Attach handlers before any early return so an abandoned request (for
  // example a fetch cancelled by the watchdog) can never become an unhandled
  // rejection when it settles after the race was already decided.
  pending.then(
    (result) => finish({ kind: 'result', result }),
    (error) => finish({ kind: 'error', error }),
  )
  if (signal.aborted) {
    finish({ kind: 'abort' })
    return promise
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (deadline !== undefined) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      finish({ kind: 'timeout' })
      return promise
    }
    timer = setTimeout(() => finish({ kind: 'timeout' }), remaining)
  }
  return promise
}

/**
 * Parse a byte stream into SSE events.
 *
 * - CRLF, bare CR and LF line terminators are all handled, including a CRLF
 *   pair split across two network chunks.
 * - Multi-byte UTF-8 sequences split across chunks are decoded incrementally.
 * - Multiple `data:` lines are joined with `\n` (multiline payloads).
 * - Comment lines (`: ping`) and `retry:` fields are ignored.
 * - A final event without a trailing blank line is still dispatched.
 * - Abort, first-event and inter-event idle watchdogs surface as `LlmFailure`
 *   values (`ABORTED` / `TIMEOUT`) for the runtime to convert into `finish`.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  options: SseWatchdogOptions,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let eventName = ''
  let eventId: string | undefined
  let dataLines: string[] = []
  let hasData = false
  let emittedAny = false

  const dispatch = (): SseEvent | null => {
    if (!hasData) {
      eventName = ''
      dataLines = []
      return null
    }
    const event: SseEvent = {
      event: eventName.length === 0 ? 'message' : eventName,
      data: dataLines.join('\n'),
      ...(eventId === undefined ? {} : { id: eventId }),
    }
    eventName = ''
    dataLines = []
    hasData = false
    return event
  }

  const consumeLine = (line: string): SseEvent | null => {
    if (line.length === 0) return dispatch()
    if (line.charCodeAt(0) === 0x3a) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        dataLines.push(value)
        hasData = true
        return null
      case 'event':
        eventName = value
        return null
      case 'id':
        if (!value.includes('\u0000')) eventId = value
        return null
      default:
        return null
    }
  }

  const drainLines = (): SseEvent[] => {
    const events: SseEvent[] = []
    let position = 0
    while (true) {
      let end = -1
      let skip = 1
      const lineFeed = buffer.indexOf('\n', position)
      const carriageReturn = buffer.indexOf('\r', position)
      if (carriageReturn >= 0 && (lineFeed < 0 || carriageReturn < lineFeed)) {
        if (carriageReturn === buffer.length - 1) break
        end = carriageReturn
        skip = buffer.charCodeAt(carriageReturn + 1) === 0x0a ? 2 : 1
      } else if (lineFeed >= 0) {
        end = lineFeed
      } else {
        break
      }
      const line = buffer.slice(position, end)
      position = end + skip
      const event = consumeLine(line)
      if (event !== null) events.push(event)
    }
    buffer = buffer.slice(position)
    return events
  }

  // Absolute deadlines: the first-event budget starts at parser entry (or at
  // the runtime's pre-dispatch instant) and is never extended by comments or
  // partial lines; the inter-event budget restarts only on a dispatched event.
  const firstDeadline =
    options.firstEventDeadline ??
    (options.firstEventTimeoutMs > 0 ? Date.now() + options.firstEventTimeoutMs : undefined)
  let nextDeadline: number | undefined

  try {
    while (true) {
      const deadline = emittedAny ? nextDeadline : firstDeadline
      const outcome = await raceOperation(reader.read(), signal, deadline)
      if (outcome.kind === 'abort') {
        throw failure('ABORTED', 'upstream stream aborted while awaiting data')
      }
      if (outcome.kind === 'timeout') {
        const window = emittedAny ? options.interEventTimeoutMs : options.firstEventTimeoutMs
        throw failure(
          'TIMEOUT',
          emittedAny
            ? `no upstream SSE event within ${window}ms while streaming`
            : `no upstream SSE event within ${window}ms after dispatch`,
        )
      }
      if (outcome.kind === 'error') throw outcome.error
      const result = outcome.result
      if (result.done) break
      const value = result.value
      buffer += value === undefined ? decoder.decode() : decoder.decode(value, { stream: true })
      const events = drainLines()
      for (const event of events) {
        emittedAny = true
        nextDeadline =
          options.interEventTimeoutMs > 0 ? Date.now() + options.interEventTimeoutMs : undefined
        yield event
      }
    }

    buffer += decoder.decode()
    if (buffer.length > 0) {
      // EOF terminates the final line even without a trailing newline, and a
      // bare CR (or CRLF) at the very end is still a line terminator.
      const lines = buffer.split(/\r\n|\r|\n/)
      buffer = ''
      for (const line of lines) {
        const trailing = consumeLine(line)
        if (trailing !== null) {
          emittedAny = true
          yield trailing
        }
      }
    }
    const pending = dispatch()
    if (pending !== null) yield pending
  } finally {
    // Never block terminal-frame delivery on transport teardown: cancel() may
    // wait for a pending read that only settles when the socket notices.
    void reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // A pending read still holds the lock; cancel() has already closed it.
    }
  }
}

/** Read at most `limit` characters of a response body (used for diagnostics). */
export async function readResponseText(
  response: Response,
  limit: number = DEFAULT_ERROR_BODY_LIMIT,
): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let output = ''
  try {
    while (output.length < limit) {
      const result = await reader.read()
      if (result.done) break
      output += result.value === undefined ? '' : decoder.decode(result.value, { stream: true })
    }
    output += decoder.decode()
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Ignore a body that is already closed.
    }
  }
  return output.slice(0, limit)
}

/* -------------------------------------------------------------------------- */
/*                              streaming runtime                            */
/* -------------------------------------------------------------------------- */

/** Everything one bound chat call needs to perform its single physical request. */
export interface DirectStreamContext {
  readonly route: PreparedDirectRoute
  readonly engine: DirectWireEngine
  readonly apiKey: Option<string>
  readonly fetchImpl: DirectFetch
  readonly snapshot: PreparedChatCallSnapshot
  readonly signal: AbortSignal
}

function abortFinish(observedAttempts: number): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'aborted',
      failure: failure('ABORTED', 'request aborted by caller'),
    },
    replayState: NONE,
    observedAttempts,
  }
}

function failedFinish(error: LlmFailure, observedAttempts: number): StreamChunk {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: error },
    replayState: NONE,
    observedAttempts,
  }
}

/**
 * Terminal frame for a classified failure. The stream protocol requires an
 * `aborted` reason exactly when the failure code is `ABORTED`; every other
 * classified transport failure stays an `error` frame. Keeping this in one
 * place prevents an internally aborted transport from failing the guard.
 */
function classifiedFinish(error: LlmFailure, observedAttempts: number): StreamChunk {
  return {
    type: 'finish',
    reason:
      error.code === 'ABORTED'
        ? { kind: 'aborted', failure: error }
        : { kind: 'error', failure: error },
    replayState: NONE,
    observedAttempts,
  }
}

function normalizeFinish(
  chunk: Extract<StreamChunk, { type: 'finish' }>,
  observedAttempts: number,
): StreamChunk {
  const failed = chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
  return {
    type: 'finish',
    reason: chunk.reason,
    replayState: failed ? NONE : chunk.replayState,
    observedAttempts,
  }
}

type DispatchOutcome =
  | { readonly kind: 'dispatched'; readonly promise: Promise<Response> }
  | { readonly kind: 'threw'; readonly cause: unknown }

/**
 * Invoke the injected `fetch` without letting a synchronous throw escape the
 * transport generator. The thunk preserves the call-site binding of a custom
 * implementation; the caller owns classification and abort priority.
 */
function dispatchFetch(dispatch: () => Promise<Response>): DispatchOutcome {
  try {
    return { kind: 'dispatched', promise: dispatch() }
  } catch (cause) {
    return { kind: 'threw', cause }
  }
}

/**
 * Execute exactly one physical model request and emit a protocol-legal
 * {@link StreamChunk} sequence.
 *
 * The stream *never* retries: `observedAttempts` is `0` when the caller was
 * already aborted before dispatch and exactly `1` once `fetch` was invoked.
 * Any failure after the first byte terminates the stream instead of splicing a
 * second attempt, and engine defects surface as {@link InvariantError}.
 */
export function executeDirectStream(context: DirectStreamContext): AsyncIterable<StreamChunk> {
  return runDirectStream(context)
}

async function* runDirectStream(context: DirectStreamContext): AsyncGenerator<StreamChunk> {
  const { route, engine, snapshot, signal } = context
  const secrets = isSome(context.apiKey)
    ? [context.apiKey.value, `Bearer ${context.apiKey.value}`]
    : []
  if (signal.aborted) {
    yield abortFinish(0)
    return
  }

  let wire: WireRequest
  try {
    wire = engine.build(snapshot, route.config)
  } catch (cause) {
    if (signal.aborted) {
      yield abortFinish(0)
      return
    }
    yield classifiedFinish(classifyDirectFailure(cause, secrets), 0)
    return
  }

  const url = joinRequestURL(route.config.baseURL, wire.path)
  const headers = buildRequestHeaders({
    engineHeaders: wire.headers,
    routeHeaders: route.headers,
    authMode: route.config.authMode ?? 'none',
    protocol: route.config.protocol,
    apiKey: context.apiKey,
  })

  // The first-event budget starts *before* dispatch: a hanging handshake, a
  // stalled error-response body or a comment-only SSE trickle all consume the
  // same absolute deadline instead of waiting forever.
  const firstEventDeadline =
    route.firstEventTimeoutMs > 0 ? Date.now() + route.firstEventTimeoutMs : undefined

  // One controller owns the whole transport: forwarded caller aborts, watchdog
  // timeouts and post-terminal teardown all cancel the physical request/body.
  const streamController = new AbortController()
  const forwardAbort = (): void => streamController.abort()
  if (signal.aborted) streamController.abort()
  else signal.addEventListener('abort', forwardAbort, { once: true })

  let attempts = 0
  try {
    let response: Response
    attempts = 1
    const dispatch = dispatchFetch(() =>
      context.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(wire.body),
        signal: streamController.signal,
      }),
    )
    // A custom `fetch` implementation may throw synchronously (before it ever
    // returns a promise). That is a transport failure of this single attempt,
    // not a caller-visible rejection, so it must become a sanitised terminal
    // frame — caller cancellation still takes priority over the cause.
    if (dispatch.kind === 'threw') {
      if (signal.aborted) {
        yield abortFinish(attempts)
        return
      }
      yield classifiedFinish(classifyDirectFailure(dispatch.cause, secrets), attempts)
      return
    }
    const responseOutcome = await raceOperation(
      dispatch.promise,
      streamController.signal,
      firstEventDeadline,
    )
    if (responseOutcome.kind === 'timeout') {
      streamController.abort()
      yield failedFinish(
        failure(
          'TIMEOUT',
          `no upstream response within ${route.firstEventTimeoutMs}ms after dispatch`,
        ),
        attempts,
      )
      return
    }
    if (responseOutcome.kind === 'abort') {
      yield abortFinish(attempts)
      return
    }
    if (responseOutcome.kind === 'error') {
      if (signal.aborted) {
        yield abortFinish(attempts)
        return
      }
      yield classifiedFinish(classifyDirectFailure(responseOutcome.error, secrets), attempts)
      return
    }
    response = responseOutcome.result

    if (!response.ok) {
      const bodyOutcome = await raceOperation(
        readResponseText(response, DEFAULT_ERROR_BODY_LIMIT),
        streamController.signal,
        firstEventDeadline,
      )
      if (bodyOutcome.kind === 'timeout') {
        streamController.abort()
        yield failedFinish(
          failure(
            'TIMEOUT',
            `HTTP ${response.status} error body stalled past the first-event deadline`,
          ),
          attempts,
        )
        return
      }
      if (bodyOutcome.kind === 'abort') {
        yield abortFinish(attempts)
        return
      }
      if (bodyOutcome.kind === 'error') {
        if (signal.aborted) {
          yield abortFinish(attempts)
          return
        }
        yield classifiedFinish(classifyDirectFailure(bodyOutcome.error, secrets), attempts)
        return
      }
      yield failedFinish(classifyHttpResponse(response, bodyOutcome.result, secrets), attempts)
      return
    }

    if (response.body === null) {
      yield failedFinish(
        failure('MALFORMED_RESPONSE', 'upstream response carried no body'),
        attempts,
      )
      return
    }

    const events = parseSseStream(response.body, streamController.signal, {
      firstEventTimeoutMs: route.firstEventTimeoutMs,
      interEventTimeoutMs: route.interEventTimeoutMs,
      ...(firstEventDeadline === undefined ? {} : { firstEventDeadline }),
    })

    let finished = false
    try {
      for await (const chunk of engine.decode(events, snapshot, route.config)) {
        if (chunk.type === 'finish') {
          if (finished) throw new InvariantError('direct engine produced a duplicate finish chunk')
          finished = true
          streamController.abort()
          yield normalizeFinish(chunk, attempts)
          continue
        }
        if (finished) throw new InvariantError('direct engine produced a chunk after finish')
        yield chunk
      }
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause
      if (finished) return
      if (signal.aborted) {
        yield abortFinish(attempts)
        return
      }
      yield classifiedFinish(classifyDirectFailure(cause, secrets), attempts)
      return
    }

    if (finished) return
    if (signal.aborted) {
      yield abortFinish(attempts)
      return
    }
    yield failedFinish(
      failure('TRANSPORT', 'upstream stream ended before a terminal event'),
      attempts,
    )
  } finally {
    signal.removeEventListener('abort', forwardAbort)
    streamController.abort()
  }
}
