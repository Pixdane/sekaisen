/**
 * Internal result plumbing shared by the perspective modules.
 *
 * `@sekaisen/plugin-schema` returns `Result` for reads but throws its schema
 * failure type from transaction mutators. Perspective exposes a single
 * `Result<_, PerspectiveError>` surface, so both channels are normalized here:
 * structural invariant violations are explicit {@link PerspectiveFailure}s,
 * and thrown schema failures are duck-typed into `schema_error` without
 * importing private schema internals.
 */

import type { Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import type { SchemaError } from '@sekaisen/plugin-schema'
import type { StateRef, Value } from '@sekaisen/plugin-world'
import { valueEquals } from '@sekaisen/plugin-world'
import type { PerspectiveError } from './types.ts'

/** Thrown inside the plugin so nested helpers can fail cleanly through recursion. */
export class PerspectiveFailure extends Error {
  override readonly name = 'PerspectiveFailure'
  readonly error: PerspectiveError

  constructor(error: PerspectiveError) {
    super(error.kind)
    this.error = error
  }
}

/** Abort a perspective operation with a documented error. */
export function fail(error: PerspectiveError): never {
  throw new PerspectiveFailure(error)
}

/** Unwrap a schema read, translating its error into `schema_error`. */
export function expectSchema<T>(result: Result<T, SchemaError>): T {
  if (!result.ok) fail({ kind: 'schema_error', error: result.error })
  return result.value
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

/**
 * Run a synchronous perspective operation, converting documented failures.
 *
 * Thrown schema failures from `tx.set`/`patch`/`backlinks` become
 * `schema_error`; unrelated programming exceptions deliberately propagate.
 */
export function attemptPerspective<T>(fn: () => T): Result<T, PerspectiveError> {
  try {
    return ok(fn())
  } catch (cause) {
    if (cause instanceof PerspectiveFailure) return err(cause.error)
    if (isSchemaFailure(cause)) return err({ kind: 'schema_error', error: cause.error })
    throw cause
  }
}

function isStateRefLike(value: Value | StateRef): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    'commitId' in value &&
    'path' in value
  )
}

/**
 * Structural equality for a subjective value that may be a value leaf or a
 * cross-commit reference. Values delegate to World's canonical comparison;
 * references compare commit and path strictly.
 */
export function valueOrRefEquals(a: Value | StateRef, b: Value | StateRef): boolean {
  if (isStateRefLike(a) || isStateRefLike(b))
    return (
      isStateRefLike(a) &&
      isStateRefLike(b) &&
      a.commitId === b.commitId &&
      a.path.length === b.path.length &&
      a.path.every((segment, index) => segment === b.path[index])
    )
  return valueEquals(a, b)
}
