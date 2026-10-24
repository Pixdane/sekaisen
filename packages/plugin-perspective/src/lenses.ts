/**
 * Transaction lens helpers.
 *
 * Perspective only writes through public `SchemaTransaction` optics; these
 * wrappers turn an unexpected optic kind into the documented `type_mismatch`
 * schema error instead of a programming exception.
 */

import type { FieldLens, SchemaTransaction, StructLens } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { expectSchema, fail } from './internal.ts'

/** Fetch a declared field lens, rejecting non-field paths as `type_mismatch`. */
export function fieldLensAt(tx: SchemaTransaction, path: Path): FieldLens {
  const lens = expectSchema(tx.lensAt(path))
  if (lens.opticKind !== 'field')
    fail({
      kind: 'schema_error',
      error: {
        kind: 'validation_failed',
        path,
        reason: 'type_mismatch',
        detail: 'expected a declared field lens',
      },
    })
  return lens
}

/** Fetch a struct lens, rejecting non-struct paths as `type_mismatch`. */
export function structLensAt(tx: SchemaTransaction, path: Path): StructLens {
  const lens = expectSchema(tx.lensAt(path))
  if (lens.opticKind !== 'struct')
    fail({
      kind: 'schema_error',
      error: {
        kind: 'validation_failed',
        path,
        reason: 'type_mismatch',
        detail: 'expected a struct lens',
      },
    })
  return lens
}
