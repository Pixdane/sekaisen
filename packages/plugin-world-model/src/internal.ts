/**
 * Internal Result plumbing for the world-model service.
 *
 * Schema reads return `Result`, while transaction mutators throw. Perspective
 * failures are returned as `Result`. This module normalizes those channels into
 * one `Result<_, PerspectiveError>` surface and provides the savepoint wrapper
 * used by every multi-write helper.
 */

import type { Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import type { PerspectiveError } from '@sekaisen/plugin-perspective'
import type { SchemaError, SchemaTransaction } from '@sekaisen/plugin-schema'

/** Thrown inside the plugin so nested helpers can abort a savepoint cleanly. */
export class WorldModelFailure extends Error {
  override readonly name = 'WorldModelFailure'
  readonly error: PerspectiveError

  constructor(error: PerspectiveError) {
    super(error.kind)
    this.error = error
  }
}

/** Abort the current operation with a documented perspective error. */
export function fail(error: PerspectiveError): never {
  throw new WorldModelFailure(error)
}

function isSchemaError(value: unknown): value is SchemaError {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string'
  )
}

function isSchemaFailure(cause: unknown): cause is { readonly error: SchemaError } {
  return (
    typeof cause === 'object' && cause !== null && 'error' in cause && isSchemaError(cause.error)
  )
}

/** Run a synchronous operation, converting documented failures only. */
export function attemptWorldModel<T>(fn: () => T): Result<T, PerspectiveError> {
  try {
    return ok(fn())
  } catch (cause) {
    if (cause instanceof WorldModelFailure) return err(cause.error)
    if (isSchemaFailure(cause)) return err({ kind: 'schema_error', error: cause.error })
    throw cause
  }
}

/** Unwrap a schema read; schema errors become `schema_error`. */
export function expectSchema<T>(result: Result<T, SchemaError>): T {
  if (!result.ok) fail({ kind: 'schema_error', error: result.error })
  return result.value
}

/**
 * Domain failure channel reused from perspective's documented
 * `invalid_claim_target`: world-model entity operations are claim-adjacent
 * target validations, so no parallel error union is introduced. The `reason`
 * string carries the more specific domain cause.
 */
export function domainFailure(targetPath: readonly string[], reason: string): PerspectiveError {
  return { kind: 'invalid_claim_target', targetPath: [...targetPath], reason }
}

/**
 * Execute one multi-write helper as a draft savepoint.
 *
 * A returned `Err` rolls every write back and is surfaced unchanged; thrown
 * schema failures are converted after rollback. Earlier caller writes outside
 * the savepoint are preserved by the transaction's nested journals.
 */
export function atomicWorldModel<T>(
  tx: SchemaTransaction,
  operation: () => Result<T, PerspectiveError>,
): Result<T, PerspectiveError> {
  return attemptWorldModel(() =>
    tx.atomic(() => {
      const result = operation()
      if (!result.ok) fail(result.error)
      return result.value
    }),
  )
}
