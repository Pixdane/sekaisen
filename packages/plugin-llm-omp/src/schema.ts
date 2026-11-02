/**
 * Structural JSON Schema projection from the direct-adapter Gemini dialect
 * (uppercase `Schema.type`) back to the lowercase JSON Schema that pi-ai's
 * Gemini and Cloud Code Assist converters expect.
 *
 * Only schema-keyword positions are rewritten. A user property literally named
 * `type`, enum values, defaults, `required` strings and `propertyOrdering`
 * entries are data and stay byte-identical.
 */

import { isRecord } from './record.ts'

const LOWER_TYPES: Readonly<Record<string, string>> = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NULL: 'null',
})

const SCHEMA_MAP_KEYS: Readonly<Record<string, true>> = Object.freeze({
  properties: true,
  $defs: true,
  definitions: true,
  dependentSchemas: true,
})
const SCHEMA_SINGLE_KEYS: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(
    [
      'items',
      'additionalProperties',
      'contains',
      'not',
      'if',
      'then',
      'else',
      'propertyNames',
      'unevaluatedProperties',
    ].map((key) => [key, true] as const),
  ),
)
const SCHEMA_LIST_KEYS: Readonly<Record<string, true>> = Object.freeze({
  anyOf: true,
  oneOf: true,
  allOf: true,
  prefixItems: true,
})

function lowerMap(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const [name, schema] of Object.entries(value)) {
    out[name] = isRecord(schema) ? lowerCaseSchemaTypes(schema) : schema
  }
  return out
}

function lowerSingle(value: unknown): unknown {
  if (isRecord(value)) return lowerCaseSchemaTypes(value)
  if (Array.isArray(value)) {
    return value.map((entry) => (isRecord(entry) ? lowerCaseSchemaTypes(entry) : entry))
  }
  return value
}

/** Returns a new schema tree; never mutates the frozen snapshot tool definition. */
export function lowerCaseSchemaTypes(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type') {
      out.type = typeof value === 'string' ? (LOWER_TYPES[value] ?? value) : value
    } else if (Object.hasOwn(SCHEMA_MAP_KEYS, key)) {
      out[key] = isRecord(value) ? lowerMap(value) : value
    } else if (Object.hasOwn(SCHEMA_SINGLE_KEYS, key)) {
      out[key] = lowerSingle(value)
    } else if (Object.hasOwn(SCHEMA_LIST_KEYS, key)) {
      out[key] = lowerSingle(value)
    } else {
      out[key] = value
    }
  }
  return out
}
