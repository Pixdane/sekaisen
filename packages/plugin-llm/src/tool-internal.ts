import { InvariantError } from '@sekaisen/core'
import type { ToolFieldIssue, ToolSchemaNode } from './tool-types.ts'

/* -------------------------------------------------------------------------- */
/*                              Record traversal                              */
/* -------------------------------------------------------------------------- */

/** True for non-null, non-array objects (including null-prototype records). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Result of reading an own property without invoking accessors. */
export interface OwnValue {
  readonly present: boolean
  readonly value: unknown
}

const ABSENT: OwnValue = Object.freeze({ present: false, value: undefined })

/**
 * Read an own property through its descriptor. Accessors are never invoked:
 * a present accessor reports `value: undefined`, which callers treat as absent.
 */
export function readOwn(target: object, key: string): OwnValue {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor === undefined) return ABSENT
  if ('value' in descriptor) return Object.freeze({ present: true, value: descriptor.value })
  return Object.freeze({ present: true, value: undefined })
}

/**
 * Define an own enumerable, non-writable data property. Unlike assignment this
 * is safe for the keys `__proto__` and `constructor`.
 */
export function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  })
}

/** Create a plain object or a prototype-less dictionary. */
export function createDataObject(nullPrototype: boolean): Record<string, unknown> {
  return nullPrototype ? (Object.create(null) as Record<string, unknown>) : {}
}

/* -------------------------------------------------------------------------- */
/*                            JSON value utilities                            */
/* -------------------------------------------------------------------------- */

/** Deep clone frozen JSON data, preserving null-prototype dictionaries. */
export function cloneJsonValue(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) items.push(cloneJsonValue(item))
    return Object.freeze(items)
  }
  if (isRecord(value)) {
    const out = createDataObject(Object.getPrototypeOf(value) === null)
    for (const key of Object.keys(value)) {
      const own = readOwn(value, key)
      if (own.present) defineData(out, key, cloneJsonValue(own.value))
    }
    return Object.freeze(out)
  }
  const type = typeof value
  if (type === 'string' || type === 'boolean' || type === 'number') return value
  throw new InvariantError('tool schema values must be JSON data')
}

/** Compact JSON rendering used inside descriptions and error messages. */
export function jsonText(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return '[unserializable value]'
  }
}

/** First `limit` UTF-16 units of `value`, always well-formed. */
export function wellFormedPreview(value: string, limit: number): string {
  const truncated = value.length > limit ? `${value.slice(0, limit)}...` : value
  return truncated.toWellFormed()
}

/** JSON Schema string lengths count Unicode code points, not UTF-16 units. */
export function codePointLength(value: string): number {
  let length = 0
  for (const _unit of value) length += 1
  return length
}

/* -------------------------------------------------------------------------- */
/*                            Diagnostics helpers                             */
/* -------------------------------------------------------------------------- */

/** Render an issue path as a compact JavaScript-style accessor chain. */
export function renderPath(path: readonly string[]): string {
  let rendered = '$'
  for (const segment of path) {
    if (/^(?:0|[1-9][0-9]*)$/.test(segment)) rendered += `[${segment}]`
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) rendered += `.${segment}`
    else rendered += `[${JSON.stringify(segment)}]`
  }
  return rendered
}

/** Human description of an arbitrary received value. */
export function describeReceived(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'object') return 'object'
  if (type === 'number') return `number ${String(value)}`
  if (type === 'string') return `string ${jsonText(value)}`
  if (type === 'boolean') return `boolean ${String(value)}`
  return type
}

/** Plain JSON type name for root diagnostics. */
export function rootTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Format field issues as one deterministic, model-readable block. */
export function formatIssues(issues: readonly ToolFieldIssue[]): string {
  return issues
    .map(
      (issue) =>
        `- ${renderPath(issue.path)}: expected ${issue.expected}, received ${issue.received}; ${issue.message}`,
    )
    .join('\n')
}

/* -------------------------------------------------------------------------- */
/*                            Node kind utilities                             */
/* -------------------------------------------------------------------------- */

/** Every legal AST kind. */
export const TOOL_NODE_KINDS: Readonly<Record<string, true>> = Object.freeze({
  str: true,
  num: true,
  bool: true,
  literal: true,
  enum: true,
  arr: true,
  obj: true,
  record: true,
  union: true,
  discriminated_union: true,
})

/** Shallow check that a value is shaped like a schema node. */
export function isSchemaNodeShaped(value: unknown): value is ToolSchemaNode {
  if (!isRecord(value)) return false
  const kind = value.kind
  return typeof kind === 'string' && TOOL_NODE_KINDS[kind] === true
}

/** Bounds checks shared by constructors and structural validation. */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Finite-number check shared by numeric constraints and literals. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Human label of a node's accepted value domain. */
export function nodeLabel(node: ToolSchemaNode): string {
  switch (node.kind) {
    case 'str':
      return 'string'
    case 'num':
      return node.integerOnly ? 'integer' : 'number'
    case 'bool':
      return 'boolean'
    case 'literal':
      return `literal ${jsonText(node.value)}`
    case 'enum':
      return `one of ${node.values.map((value) => jsonText(value)).join(' | ')}`
    case 'arr':
      return `array of ${nodeLabel(node.item)}`
    case 'obj':
      return 'object'
    case 'record':
      return `object with arbitrary keys mapping to ${nodeLabel(node.value)}`
    case 'union':
      return `one of ${node.variants.map((variant) => nodeLabel(variant)).join(' | ')}`
    case 'discriminated_union':
      return `object discriminated by "${node.discriminator}"`
    default:
      return 'unknown schema node'
  }
}

/* -------------------------------------------------------------------------- */
/*                         Deep immutability probing                         */
/* -------------------------------------------------------------------------- */

function isDeeplyFrozenJson(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true
  if (!Object.isFrozen(value)) return false
  for (const key of Object.keys(value)) {
    const own = readOwn(value, key)
    if (own.present && !isDeeplyFrozenJson(own.value)) return false
  }
  return true
}

function schemaNodeIsImmutable(node: ToolSchemaNode, visited: Set<object>): boolean {
  if (!Object.isFrozen(node)) return false
  if (visited.has(node)) return true
  visited.add(node)
  if (node.hasDefault && !isDeeplyFrozenJson(node.defaultValue)) return false
  switch (node.kind) {
    case 'arr':
      return schemaNodeIsImmutable(node.item, visited)
    case 'record':
      return schemaNodeIsImmutable(node.value, visited)
    case 'obj':
      if (!Object.isFrozen(node.properties)) return false
      for (const key of Object.keys(node.properties)) {
        const child = node.properties[key]
        if (child === undefined || !schemaNodeIsImmutable(child, visited)) return false
      }
      return true
    case 'enum':
      return Object.isFrozen(node.values)
    case 'union':
    case 'discriminated_union':
      if (!Object.isFrozen(node.variants)) return false
      for (const variant of node.variants) {
        if (!schemaNodeIsImmutable(variant, visited)) return false
      }
      return true
    default:
      return true
  }
}

/**
 * True only when the whole AST (nodes, property maps, variant lists, enum
 * values, and default JSON values) is frozen. Used to decide whether wire
 * schemas may be memoized by node identity: mutable handwritten ASTs must be
 * re-normalized after every edit, while frozen builders are cache-safe.
 */
export function isDeeplyImmutableSchema(node: ToolSchemaNode): boolean {
  return schemaNodeIsImmutable(node, new Set<object>())
}
