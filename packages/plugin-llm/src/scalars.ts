/**
 * Shared scalar boundary checks for every externally supplied number: request
 * overrides, profile catalogues and adapter capability matrices all use the
 * same bounds so a value accepted in one place is accepted everywhere.
 */

import type { Option, Result } from '@sekaisen/core'
import { err, isOption, NONE, ok, some } from '@sekaisen/core'
import type { LlmFailure } from './types.ts'
import { failure } from './utils.ts'

/** Inclusive/exclusive numeric range check for one labelled scalar. */
export interface NumberBound {
  readonly min: number
  readonly max: number
  /** When `true` the lower bound is exclusive. */
  readonly exclusiveMin?: boolean
  /** When `true` only safe integers are accepted. */
  readonly integer?: boolean
}

/** Sampling temperature range accepted by every supported provider. */
export const TEMPERATURE_BOUND: NumberBound = Object.freeze({ min: 0, max: 2 })
/** Nucleus sampling mass; zero would disable every token. */
export const TOP_P_BOUND: NumberBound = Object.freeze({ min: 0, max: 1, exclusiveMin: true })
/** Repetition penalty range shared by OpenAI-compatible and Anthropic APIs. */
export const PENALTY_BOUND: NumberBound = Object.freeze({ min: -2, max: 2 })
/** Output token budget: a positive safe integer. */
export const MAX_OUTPUT_TOKENS_BOUND: NumberBound = Object.freeze({
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  integer: true,
})
/** Embedding dimensionality: a positive safe integer. */
export const DIMENSIONS_BOUND: NumberBound = Object.freeze({
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  integer: true,
})
/** A positive safe integer, used for token counts and `topN`. */
export const POSITIVE_INTEGER_BOUND: NumberBound = Object.freeze({
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  integer: true,
})

/**
 * Validate one numeric scalar against `bound`.
 *
 * Returns `null` when acceptable; `-0` is normalised to `0` by
 * {@link readOptionNumber} rather than here.
 */
export function checkNumberBound(
  label: string,
  value: unknown,
  bound: NumberBound,
): LlmFailure | null {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return failure('INVALID_REQUEST', `${label} must be a finite number`)
  if (bound.integer === true && !Number.isSafeInteger(value))
    return failure('INVALID_REQUEST', `${label} must be a safe integer`)
  if (bound.exclusiveMin === true ? !(value > bound.min) : !(value >= bound.min))
    return failure(
      'INVALID_REQUEST',
      `${label} must be ${bound.exclusiveMin === true ? 'greater than' : 'at least'} ${bound.min}`,
    )
  if (value > bound.max) return failure('INVALID_REQUEST', `${label} must not exceed ${bound.max}`)
  return null
}

/**
 * Read an optional `Option<number>` field from a plain configuration record.
 *
 * An absent (or `undefined`) field means "not configured" and yields `NONE`;
 * a present non-`Option` value is rejected instead of being coerced.
 */
export function readOptionNumber(
  entry: Readonly<Record<string, unknown>>,
  field: string,
  bound: NumberBound,
): Result<Option<number>, LlmFailure> {
  const raw = entry[field]
  if (raw === undefined) return ok(NONE)
  if (!isOption(raw)) return err(failure('INVALID_REQUEST', `${field} must be an Option<number>`))
  if (raw.kind === 'none') return ok(NONE)
  if (typeof raw.value !== 'number')
    return err(failure('INVALID_REQUEST', `${field} must be a finite number`))
  const invalid = checkNumberBound(field, raw.value, bound)
  if (invalid !== null) return err(invalid)
  return ok(some(Object.is(raw.value, -0) ? 0 : raw.value))
}
