import type { Option } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import type { LlmFailure, LlmFailureCode, ProviderRequestId } from '@sekaisen/plugin-llm'
import {
  AIError,
  extractProviderRetryHint,
  getHeadersFromError,
  getRetryAfterMsFromHeaders,
} from './pi-ai.ts'
import { asRecord } from './record.ts'

/** Upstream produced a tool call whose raw arguments cannot be represented. */
export class OmpMalformedResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OmpMalformedResponseError'
  }
}

/** Optional structured detail accepted by {@link ompFailure}. */
export type OmpFailureDetails = Partial<Pick<LlmFailure, 'status' | 'retryAfterMs' | 'requestId'>>

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /(?:api[_-]?key|token|secret|authorization)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
]

/** Records every bearer/API-key value a call actually resolved. */
export function rememberCredentialSecret(secrets: Set<string>, resolved: unknown): void {
  let value: unknown = resolved
  if (typeof resolved === 'object' && resolved !== null && 'apiKey' in resolved) {
    value = resolved.apiKey
  }
  if (typeof value !== 'string' || value.length === 0) return
  secrets.add(value)
  const trimmed = value.trim()
  if (trimmed.length > 0) secrets.add(trimmed)
}

/** Whether a diagnostic or header value embeds one of this call's credentials. */
export function secretsContain(secrets: Iterable<string> | undefined, value: string): boolean {
  if (secrets === undefined) return false
  for (const secret of secrets) {
    if (secret.length > 0 && value.includes(secret)) return true
  }
  return false
}

/**
 * Removes credential-shaped material and every literal credential resolved for
 * this call from an upstream diagnostic. The literal pass is mandatory:
 * provider keys need not match any known vendor prefix.
 */
export function redactOmpSecrets(message: string, secrets?: Iterable<string>): string {
  const wellFormed = message.isWellFormed() ? message : message.toWellFormed()
  let redacted = wellFormed
  if (secrets !== undefined) {
    const literals = [...new Set(secrets)]
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length)
    for (const secret of literals) {
      redacted = redacted.split(secret).join('[redacted]')
    }
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]')
  }
  return redacted
}

/** Builds a frozen, contract-valid {@link LlmFailure}. */
export function ompFailure(
  code: LlmFailureCode,
  message: string,
  details: OmpFailureDetails = {},
  secrets?: Iterable<string>,
): LlmFailure {
  if (typeof message !== 'string') {
    throw new InvariantError('LlmFailure.message must be a string')
  }
  const status: Option<number> = details.status ?? NONE
  if (
    status.kind === 'some' &&
    (!Number.isSafeInteger(status.value) || status.value < 100 || status.value > 599)
  ) {
    throw new InvariantError('LlmFailure.status must be an HTTP status between 100 and 599')
  }
  const suppliedRetryAfterMs: Option<number> = details.retryAfterMs ?? NONE
  // `-0` is not a canonical protocol measure: the neutral Guard rejects it, and
  // it carries no more meaning than `+0`. Canonicalize before validation so a
  // provider-derived zero cannot make an otherwise valid failure unusable.
  const retryAfterMs: Option<number> =
    suppliedRetryAfterMs.kind === 'some' && Object.is(suppliedRetryAfterMs.value, -0)
      ? some(0)
      : suppliedRetryAfterMs
  if (
    retryAfterMs.kind === 'some' &&
    (!Number.isFinite(retryAfterMs.value) || retryAfterMs.value < 0)
  ) {
    throw new InvariantError('LlmFailure.retryAfterMs must be a finite non-negative number')
  }
  const suppliedRequestId: Option<ProviderRequestId> = details.requestId ?? NONE
  const requestId: Option<ProviderRequestId> =
    suppliedRequestId.kind === 'some' && secretsContain(secrets, suppliedRequestId.value)
      ? NONE
      : suppliedRequestId
  return Object.freeze({
    code,
    message: redactOmpSecrets(message, secrets),
    status,
    retryAfterMs,
    requestId,
  })
}

/** Extra evidence gathered by the stream probes for failure classification. */
export interface OmpFailureContext {
  readonly api?: string
  readonly provider?: string
  readonly requestId?: string
  /** Literal credentials resolved by this call, redacted from diagnostics. */
  readonly secrets?: Iterable<string>
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  const record = asRecord(error)
  if (record !== undefined && typeof record.message === 'string') return record.message
  return 'unknown upstream failure'
}

function errorStatus(error: unknown): number | undefined {
  const direct = AIError.status(error)
  if (direct !== undefined) return direct
  const record = asRecord(error)
  if (record !== undefined) {
    for (const key of ['status', 'statusCode', 'errorStatus']) {
      const value = record[key]
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 100 &&
        value <= 599
      ) {
        return value
      }
    }
  }
  return undefined
}

function errorRequestId(error: unknown): string | undefined {
  const record = asRecord(error)
  if (record !== undefined) {
    const value = record.requestId
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function retryAfterMs(error: unknown, message: string, provider?: string): number | undefined {
  const headerValue = getRetryAfterMsFromHeaders(getHeadersFromError(error))
  if (headerValue !== undefined) return headerValue
  return extractProviderRetryHint(provider, message)
}

/**
 * Maps an upstream SDK/transport failure onto the closed neutral failure
 * vocabulary. `signal.aborted` always wins: a caller cancellation is reported
 * as `ABORTED` regardless of the error the SDK produced while unwinding.
 */
export function classifyOmpFailure(
  error: unknown,
  signal?: AbortSignal,
  context: OmpFailureContext = {},
): LlmFailure {
  if (signal?.aborted === true) {
    return ompFailure('ABORTED', 'Model call aborted by caller')
  }
  const rawMessage = errorMessage(error)
  const message = redactOmpSecrets(rawMessage, context.secrets)
  const status = errorStatus(error)
  const requestIdText = context.requestId ?? errorRequestId(error)
  const requestId =
    requestIdText === undefined || secretsContain(context.secrets, requestIdText)
      ? NONE
      : some(requestIdText as ProviderRequestId)

  let flags = 0
  try {
    flags = AIError.classify(error, context.api)
  } catch {
    flags = 0
  }
  const has = (flag: number): boolean => (flags & flag) !== 0
  const retry = retryAfterMs(error, rawMessage, context.provider)
  const extra: OmpFailureDetails = {
    ...(status !== undefined ? { status: some(status) } : {}),
    ...(requestId.kind === 'some' ? { requestId } : {}),
    ...(retry === undefined ? {} : { retryAfterMs: some(retry) }),
  }

  if (error instanceof Error && error.name === 'OmpPostCommitAttemptError') {
    return ompFailure(
      'TRANSPORT',
      'Upstream attempted another request after the response had already produced output',
      extra,
    )
  }
  if (error instanceof Error && error.name === 'OmpMalformedResponseError') {
    return ompFailure('MALFORMED_RESPONSE', message, extra)
  }
  if (has(AIError.Flag.Abort)) return ompFailure('ABORTED', message, extra)
  if (has(AIError.Flag.ContentBlocked)) return ompFailure('CONTENT_BLOCKED', message, extra)
  if (has(AIError.Flag.ContextOverflow))
    return ompFailure('CONTEXT_WINDOW_EXCEEDED', message, extra)
  if (has(AIError.Flag.UsageLimit)) return ompFailure('QUOTA', message, extra)
  if (has(AIError.Flag.AuthFailed) || status === 401 || status === 403) {
    return ompFailure('AUTH', message, extra)
  }
  if (has(AIError.Flag.Timeout) || status === 408) return ompFailure('TIMEOUT', message, extra)
  if (has(AIError.Flag.EmptyResponse)) return ompFailure('EMPTY_RESPONSE', message, extra)
  if (has(AIError.Flag.MalformedFunctionCall)) {
    return ompFailure('MALFORMED_RESPONSE', message, extra)
  }
  if (status === 429) return ompFailure('RATE_LIMIT', message, extra)
  if (status === 400 || status === 413 || status === 422) {
    return ompFailure('INVALID_REQUEST', message, extra)
  }
  if (status !== undefined && status >= 500) return ompFailure('SERVER', message, extra)
  if (has(AIError.Flag.Transient)) return ompFailure('TRANSPORT', message, extra)

  const record = asRecord(error)
  const name = error instanceof Error ? error.name : undefined
  if (
    error instanceof TypeError ||
    name === 'AbortError' ||
    name === 'CodexWebSocketTransportError' ||
    record?.name === 'CodexWebSocketTransportError'
  ) {
    return ompFailure('TRANSPORT', message, extra)
  }
  return ompFailure('TRANSPORT', message, extra)
}

/** Classifies a credential-store startup failure without exposing its contents. */
export function classifyOmpAuthFailure(error: unknown, secrets?: Iterable<string>): LlmFailure {
  const message = redactOmpSecrets(errorMessage(error), secrets)
  if (error instanceof Error && error.name === 'MissingApiKeyError') {
    return ompFailure('MISSING_CREDENTIAL', message, {}, secrets)
  }
  if (AIError.status(error) === 401 || AIError.status(error) === 403) {
    return ompFailure('AUTH', message, {}, secrets)
  }
  return ompFailure('MISSING_CREDENTIAL', message, {}, secrets)
}
