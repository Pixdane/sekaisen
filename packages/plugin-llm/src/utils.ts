/**
 * Runtime support shared by the neutral protocol modules.
 *
 * Three public helpers are part of the package contract:
 * - {@link failure} constructs a frozen, fully validated {@link LlmFailure};
 * - {@link cloneFrozen} produces a deep, frozen plain-data copy that preserves
 *   nominal `Option` values (`some(x)` / `NONE`) created by `@sekaisen/core`;
 * - {@link validString} is the single string-shape gate (well-formed Unicode,
 *   optionally non-empty).
 *
 * Every predicate exported here is deliberately total: it never throws for
 * arbitrary `unknown` input, so callers can use it while classifying hostile
 * adapter output. Constructors throw `InvariantError` only for program defects.
 */

import type { Option } from '@sekaisen/core'
import { InvariantError, isOption, isSome, NONE, some } from '@sekaisen/core'
import type {
  DisjointTokenUsage,
  LlmFailure,
  LlmFailureCode,
  ProviderRequestId,
  ReplayEnvelope,
} from './types.ts'

/** Every legal {@link LlmFailureCode}, mirrored for runtime validation. */
const FAILURE_CODES: Readonly<Record<LlmFailureCode, true>> = {
  NO_ROUTE: true,
  DUPLICATE_ROUTE: true,
  INVALID_ROUTE: true,
  REGISTRATION_DISPOSED: true,
  MISSING_CREDENTIAL: true,
  INVALID_CREDENTIAL: true,
  AUTH: true,
  QUOTA: true,
  RATE_LIMIT: true,
  CONTEXT_WINDOW_EXCEEDED: true,
  CONTENT_BLOCKED: true,
  INVALID_REQUEST: true,
  UNSUPPORTED_CAPABILITY: true,
  MALFORMED_RESPONSE: true,
  EMPTY_RESPONSE: true,
  SERVER: true,
  TRANSPORT: true,
  TIMEOUT: true,
  ABORTED: true,
}

const MAX_JSON_DEPTH = 64

/**
 * Guard for `typeof value === 'string'` combined with the package-wide
 * well-formed Unicode rule. When `nonempty` is `true`, the empty string is
 * rejected as well.
 */
export function validString(value: unknown, nonempty = false): value is string {
  return typeof value === 'string' && (!nonempty || value.length > 0) && value.isWellFormed()
}

/** Guard for non-negative safe integers used by token counts and block indexes. */
export function validSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Guard for finite non-negative numbers used by costs and retry delays. */
export function validFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Guard for plain data records (object literals or null-prototype objects).
 * Arrays, class instances, options and other exotic objects are rejected.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function validHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return false
  switch (typeof value) {
    case 'string':
      return value.isWellFormed()
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (value === null) return true
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!isJsonValue(item, depth + 1)) return false
        }
        return true
      }
      if (!isPlainRecord(value)) return false
      for (const key of Object.keys(value)) {
        if (!key.isWellFormed()) return false
        if (!isJsonValue(value[key], depth + 1)) return false
      }
      return true
    }
    default:
      return false
  }
}

/** Validate an already-materialised {@link LlmFailure} value. */
export function isValidLlmFailure(value: unknown): value is LlmFailure {
  if (!isPlainRecord(value)) return false
  if (typeof value.code !== 'string' || !Object.hasOwn(FAILURE_CODES, value.code)) return false
  if (typeof value.message !== 'string' || !value.message.isWellFormed()) return false
  const status = value.status
  if (!isOption(status)) return false
  if (isSome(status) && !validHttpStatus(status.value)) return false
  const retryAfterMs = value.retryAfterMs
  if (!isOption(retryAfterMs)) return false
  if (isSome(retryAfterMs) && !validFiniteNonNegative(retryAfterMs.value)) return false
  const requestId = value.requestId
  if (!isOption(requestId)) return false
  if (isSome(requestId) && !validString(requestId.value, true)) return false
  return true
}

/** Validate the shell of a {@link ReplayEnvelope} (payload must be lossless JSON). */
export function isValidReplayEnvelope(value: unknown): value is ReplayEnvelope {
  if (!isPlainRecord(value)) return false
  if (!validString(value.adapterKind, true)) return false
  if (!validSafeCount(value.version)) return false
  if (!Object.hasOwn(value, 'response') || !isJsonValue(value.response, 0)) return false
  if (Object.hasOwn(value, 'blocks')) {
    const blocks = value.blocks
    if (!Array.isArray(blocks)) return false
    for (const block of blocks) {
      if (!isJsonValue(block, 0)) return false
    }
  }
  return true
}

/** Validate mutually exclusive token accounting with all documented bounds. */
export function isValidDisjointTokenUsage(value: unknown): value is DisjointTokenUsage {
  if (!isPlainRecord(value)) return false
  if (!validSafeCount(value.inputUncachedTokens)) return false
  if (!validSafeCount(value.cacheReadTokens)) return false
  if (!validSafeCount(value.cacheWriteTokens)) return false
  if (!validSafeCount(value.outputTokens)) return false
  const reasoning = value.reasoningTokens
  if (!isOption(reasoning)) return false
  if (isSome(reasoning) && !validSafeCount(reasoning.value)) return false
  const cost = value.authoritativeCostUsd
  if (!isOption(cost)) return false
  if (isSome(cost) && !validFiniteNonNegative(cost.value)) return false
  return true
}

/**
 * Construct a frozen, fully validated {@link LlmFailure}.
 *
 * Rejects unmapped numeric fields and out-of-range status codes, and never
 * echoes secret material: the caller supplies the diagnostic message.
 */
export function failure(
  code: LlmFailureCode,
  message: string,
  details: Partial<Pick<LlmFailure, 'status' | 'retryAfterMs' | 'requestId'>> = {},
): LlmFailure {
  if (!Object.hasOwn(FAILURE_CODES, code)) {
    throw new InvariantError(
      `LlmFailure code is not part of the closed vocabulary: ${String(code)}`,
    )
  }
  if (typeof message !== 'string' || !message.isWellFormed()) {
    throw new InvariantError('LlmFailure.message must be a well-formed Unicode string')
  }
  const status: Option<number> = details.status ?? NONE
  if (isSome(status) && !validHttpStatus(status.value)) {
    throw new InvariantError('LlmFailure.status must be an HTTP status between 100 and 599')
  }
  const retryAfterMs: Option<number> = details.retryAfterMs ?? NONE
  if (isSome(retryAfterMs) && !validFiniteNonNegative(retryAfterMs.value)) {
    throw new InvariantError('LlmFailure.retryAfterMs must be a finite non-negative number')
  }
  const suppliedRequestId: Option<ProviderRequestId> = details.requestId ?? NONE
  if (isSome(suppliedRequestId) && !validString(suppliedRequestId.value, true)) {
    throw new InvariantError('LlmFailure.requestId must be a non-empty well-formed string')
  }
  return Object.freeze({
    code,
    message,
    status,
    retryAfterMs,
    requestId: suppliedRequestId,
  })
}

/**
 * Deep-copy plain data and freeze every level.
 *
 * Genuine nominal `Option` values are preserved through `some`/`NONE` instead
 * of being copied as plain objects. Non-finite numbers, `-0`, cyclic graphs,
 * accessors, symbol keys and class instances are program defects and raise
 * `InvariantError`; `-0` is normalised to `0` as required by the numeric rules.
 */
export function cloneFrozen<T>(value: T): T {
  return cloneValue(value, new Set<object>()) as T
}

function cloneValue(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null
  switch (typeof value) {
    case 'undefined':
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw new InvariantError('cloneFrozen rejects non-finite numbers')
      }
      return value === 0 ? 0 : value
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new InvariantError(`cloneFrozen cannot clone a ${typeof value} value`)
    case 'object':
      break
    default:
      throw new InvariantError('cloneFrozen received an unsupported value')
  }

  const record = value as object
  if (isOption(record)) {
    return isSome(record) ? some(cloneValue(record.value, seen)) : NONE
  }
  if (seen.has(record)) {
    throw new InvariantError('cloneFrozen rejects cyclic structures')
  }
  seen.add(record)
  try {
    if (Array.isArray(record)) {
      const copy = record.map((item) => cloneValue(item, seen))
      return Object.freeze(copy)
    }
    if (isPlainRecord(record)) {
      const nullPrototype = Object.getPrototypeOf(record) === null
      const copy: Record<string, unknown> = nullPrototype ? Object.create(null) : {}
      for (const key of Reflect.ownKeys(record)) {
        if (typeof key === 'symbol') {
          throw new InvariantError('cloneFrozen rejects symbol-keyed properties')
        }
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (descriptor === undefined || !descriptor.enumerable) {
          throw new InvariantError('cloneFrozen rejects non-enumerable properties')
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new InvariantError('cloneFrozen rejects accessor properties')
        }
        // Own data property: `copy[key] = ...` would run an inherited setter
        // for a JSON own `__proto__` key and pollute the clone's prototype.
        Object.defineProperty(copy, key, {
          value: cloneValue(descriptor.value, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return Object.freeze(copy)
    }
    throw new InvariantError(
      `cloneFrozen only accepts plain data, received ${Object.prototype.toString.call(record)}`,
    )
  } finally {
    seen.delete(record)
  }
}
