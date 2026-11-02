import { InvariantError } from '@sekaisen/core'
import {
  defineData,
  isDeeplyImmutableSchema,
  isRecord,
  isSchemaNodeShaped,
  jsonText,
  nodeLabel,
  readOwn,
} from './tool-internal.ts'
import { validateToolDefinition } from './tool-parse.ts'
import type {
  NeutralToolDefinition,
  NormalizedWireToolSchema,
  ToolDiscriminatedUnionShape,
  ToolObjectShape,
  ToolSchemaDialect,
  ToolSchemaNode,
} from './tool-types.ts'

/* -------------------------------------------------------------------------- */
/*                              Schema records                               */
/* -------------------------------------------------------------------------- */

type JsonSchema = Readonly<Record<string, unknown>>

/** Build a frozen schema object from ordered entries, skipping `undefined`. */
function schemaOf(entries: Iterable<readonly [string, unknown]>): JsonSchema {
  const out: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    if (value !== undefined) defineData(out, key, value)
  }
  return Object.freeze(out)
}

/** Frozen arrays are shared by cached schemas, so callers must never mutate. */
function listOf<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values])
}

/** Static constraint keywords moved into descriptions for strict OpenAI. */
const CONSTRAINT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  minLength: true,
  maxLength: true,
  minimum: true,
  maximum: true,
  minItems: true,
  maxItems: true,
})

const DIALECTS: Readonly<Record<string, true>> = Object.freeze({
  'openai-strict': true,
  'openai-non-strict': true,
  'openai-responses': true,
  anthropic: true,
  'google-gemini': true,
  'google-gemini-cca': true,
  'moonshot-mfjs': true,
})

function isOpenAiStrictFamily(dialect: ToolSchemaDialect): boolean {
  return dialect === 'openai-strict' || dialect === 'openai-responses'
}

function isGeminiFamily(dialect: ToolSchemaDialect): boolean {
  return dialect === 'google-gemini' || dialect === 'google-gemini-cca'
}

function degradesNonStringLiterals(dialect: ToolSchemaDialect): boolean {
  return isGeminiFamily(dialect) || dialect === 'moonshot-mfjs'
}

function supportsDefaultKeyword(dialect: ToolSchemaDialect): boolean {
  return dialect === 'openai-non-strict'
}

function supportsAdditionalPropertiesKeyword(dialect: ToolSchemaDialect): boolean {
  return !isGeminiFamily(dialect) && dialect !== 'moonshot-mfjs'
}

/* -------------------------------------------------------------------------- */
/*                              Conversion context                           */
/* -------------------------------------------------------------------------- */

interface ConvertContext {
  readonly dialect: ToolSchemaDialect
  readonly strict: boolean
  readonly strictOpenAi: boolean
  /** Memoized per (node, dialect, strict) as required by the design. */
  readonly cache: WeakMap<object, JsonSchema>
}

interface DialectCache {
  readonly strictCache: WeakMap<object, JsonSchema>
  readonly looseCache: WeakMap<object, JsonSchema>
}

const CACHES: Readonly<Record<ToolSchemaDialect, DialectCache>> = Object.freeze({
  'openai-strict': { strictCache: new WeakMap(), looseCache: new WeakMap() },
  'openai-non-strict': { strictCache: new WeakMap(), looseCache: new WeakMap() },
  'openai-responses': { strictCache: new WeakMap(), looseCache: new WeakMap() },
  anthropic: { strictCache: new WeakMap(), looseCache: new WeakMap() },
  'google-gemini': { strictCache: new WeakMap(), looseCache: new WeakMap() },
  'google-gemini-cca': { strictCache: new WeakMap(), looseCache: new WeakMap() },
  'moonshot-mfjs': { strictCache: new WeakMap(), looseCache: new WeakMap() },
})

const UPPER_TYPES: Readonly<Record<string, string>> = Object.freeze({
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
  null: 'NULL',
})

const UPPERCASE_CACHE = new WeakMap<object, JsonSchema>()

/**
 * Gemini's `Schema.type` enum is uppercase. Rewrite only structural schema
 * `type` keywords, never arbitrary data: `properties` keys (including a user
 * property literally named `type`), `enum`, `default`, and `required` strings
 * are preserved; `properties`, `items`, `additionalProperties`, and `anyOf`
 * are traversed because they hold nested schemas.
 */
function upperCaseSchemaTypes(schema: JsonSchema): JsonSchema {
  const cached = UPPERCASE_CACHE.get(schema)
  if (cached !== undefined) return cached
  const entries: [string, unknown][] = []
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case 'type': {
        const mapped = typeof value === 'string' ? UPPER_TYPES[value] : undefined
        entries.push([key, mapped ?? value])
        break
      }
      case 'properties': {
        if (!isRecord(value)) {
          entries.push([key, value])
          break
        }
        const nested: [string, unknown][] = Object.entries(value).map(
          ([propertyName, propertySchema]): [string, unknown] => [
            propertyName,
            isRecord(propertySchema) ? upperCaseSchemaTypes(propertySchema) : propertySchema,
          ],
        )
        entries.push([key, schemaOf(nested)])
        break
      }
      case 'items':
      case 'additionalProperties': {
        entries.push([key, isRecord(value) ? upperCaseSchemaTypes(value) : value])
        break
      }
      case 'anyOf': {
        entries.push([
          key,
          Array.isArray(value)
            ? listOf(
                value.map((branch) => (isRecord(branch) ? upperCaseSchemaTypes(branch) : branch)),
              )
            : value,
        ])
        break
      }
      default:
        entries.push([key, value])
    }
  }
  const out = schemaOf(entries)
  UPPERCASE_CACHE.set(schema, out)
  return out
}

function descriptionOf(schema: JsonSchema): string | undefined {
  const description = schema.description
  return typeof description === 'string' && description.length > 0 ? description : undefined
}

function withDescription(schema: JsonSchema, description: string): JsonSchema {
  const entries: [string, unknown][] = Object.entries(schema).map(
    ([key, value]): [string, unknown] => [key, value],
  )
  entries.push(['description', description])
  return schemaOf(entries)
}

function stripDescription(schema: JsonSchema): JsonSchema {
  if (!Object.hasOwn(schema, 'description')) return schema
  return schemaOf(Object.entries(schema).filter(([key]) => key !== 'description'))
}

function emitsClosedObjects(ctx: ConvertContext): boolean {
  return (ctx.strictOpenAi && ctx.strict) || (ctx.dialect === 'anthropic' && ctx.strict)
}

function needsNullSchema(node: ToolSchemaNode, ctx: ConvertContext): boolean {
  if (node.isNullable) return true
  return ctx.strictOpenAi && ctx.strict && (node.isOptional || node.hasDefault)
}

/* -------------------------------------------------------------------------- */
/*                            Core node conversion                           */
/* -------------------------------------------------------------------------- */

function convertNode(node: ToolSchemaNode, ctx: ConvertContext): JsonSchema {
  const cached = ctx.cache.get(node)
  if (cached !== undefined) return cached
  const converted = convertNodeUncached(node, ctx)
  ctx.cache.set(node, converted)
  return converted
}

function convertNodeUncached(node: ToolSchemaNode, ctx: ConvertContext): JsonSchema {
  const notes: string[] = []
  let schema = baseSchema(node, ctx, notes)
  const parts: string[] = [...notes]

  if (node.hasDefault && supportsDefaultKeyword(ctx.dialect)) {
    const entries: [string, unknown][] = Object.entries(schema).map(
      ([key, value]): [string, unknown] => [key, value],
    )
    entries.push(['default', node.defaultValue])
    schema = schemaOf(entries)
  }

  if (ctx.strictOpenAi && ctx.strict) {
    const kept: [string, unknown][] = []
    for (const [key, value] of Object.entries(schema)) {
      if (CONSTRAINT_KEYS[key] === true) {
        parts.push(`${key}: ${String(value)}`)
        continue
      }
      kept.push([key, value])
    }
    schema = schemaOf(kept)
  }

  if (node.hasDefault) {
    if (supportsDefaultKeyword(ctx.dialect)) {
      // The `default` keyword is part of `baseSchema` for this dialect.
    } else {
      parts.push(`default: ${jsonText(node.defaultValue)}`)
    }
  }
  if (node.isNullable && ctx.dialect === 'moonshot-mfjs') {
    parts.push('May be null.')
  }

  const description = combineDescription(node.description, parts)
  if (!needsNullSchema(node, ctx)) {
    return description === undefined ? schema : withDescription(schema, description)
  }
  if (isGeminiFamily(ctx.dialect)) {
    const described = description === undefined ? schema : withDescription(schema, description)
    const entries: [string, unknown][] = Object.entries(described).map(
      ([key, value]): [string, unknown] => [key, value],
    )
    entries.push(['nullable', true])
    return schemaOf(entries)
  }
  if (ctx.dialect === 'moonshot-mfjs') {
    return description === undefined ? schema : withDescription(schema, description)
  }
  const inner = description === undefined ? schema : stripDescription(schema)
  const nullSchema = schemaOf([['type', 'null']])
  const wrapped: [string, unknown][] = [['anyOf', listOf([inner, nullSchema])]]
  if (description !== undefined) wrapped.push(['description', description])
  return schemaOf(wrapped)
}

function combineDescription(
  description: string | undefined,
  parts: readonly string[],
): string | undefined {
  const segments: string[] = []
  if (description !== undefined && description.length > 0) segments.push(description)
  if (parts.length > 0) segments.push(`[${parts.join('; ')}]`)
  return segments.length === 0 ? undefined : segments.join(' ')
}

function baseSchema(node: ToolSchemaNode, ctx: ConvertContext, notes: string[]): JsonSchema {
  switch (node.kind) {
    case 'str':
      return schemaOf([
        ['type', 'string'],
        ['minLength', node.minLength],
        ['maxLength', node.maxLength],
      ])
    case 'num':
      return schemaOf([
        ['type', node.integerOnly ? 'integer' : 'number'],
        ['minimum', node.minimum],
        ['maximum', node.maximum],
      ])
    case 'bool':
      return schemaOf([['type', 'boolean']])
    case 'literal':
      return literalSchema(node, ctx, notes)
    case 'enum':
      return schemaOf([
        ['type', 'string'],
        ['enum', listOf(node.values)],
      ])
    case 'arr':
      return schemaOf([
        ['type', 'array'],
        ['items', convertNode(node.item, ctx)],
        ['minItems', node.minItems],
        ['maxItems', node.maxItems],
      ])
    case 'obj':
      return objectSchema(node, ctx)
    case 'record':
      return recordSchema(node, ctx, notes)
    case 'union':
      return schemaOf([
        ['anyOf', listOf(node.variants.map((variant) => convertNode(variant, ctx)))],
      ])
    case 'discriminated_union':
      return discriminatedUnionSchema(node, ctx)
    default:
      throw new InvariantError('unknown tool schema node kind')
  }
}

function literalSchema(
  node: Extract<ToolSchemaNode, { kind: 'literal' }>,
  ctx: ConvertContext,
  notes: string[],
): JsonSchema {
  const jsonType =
    typeof node.value === 'string'
      ? 'string'
      : typeof node.value === 'number'
        ? 'number'
        : 'boolean'
  if (typeof node.value === 'string') {
    return schemaOf([
      ['type', 'string'],
      ['enum', listOf([node.value])],
    ])
  }
  if (degradesNonStringLiterals(ctx.dialect)) {
    notes.push(`Allowed values: ${jsonText(node.value)}`)
    return schemaOf([['type', jsonType]])
  }
  return schemaOf([
    ['type', jsonType],
    ['enum', listOf([node.value])],
  ])
}

function objectSchema(node: ToolObjectShape, ctx: ConvertContext): JsonSchema {
  const keys = Object.keys(node.properties)
  const propertyEntries: [string, unknown][] = []
  for (const key of keys) {
    const child = node.properties[key]
    if (child !== undefined) propertyEntries.push([key, convertNode(child, ctx)])
  }
  const properties = schemaOf(propertyEntries)
  const required =
    ctx.strictOpenAi && ctx.strict
      ? keys
      : keys.filter((key) => {
          const child = node.properties[key]
          return child !== undefined && !child.isOptional && !child.hasDefault
        })
  const entries: [string, unknown][] = [
    ['type', 'object'],
    ['properties', properties],
    ['required', listOf(required)],
  ]
  if (emitsClosedObjects(ctx)) entries.push(['additionalProperties', false])
  if (ctx.dialect === 'google-gemini') entries.push(['propertyOrdering', listOf(keys)])
  return schemaOf(entries)
}

function recordSchema(
  node: Extract<ToolSchemaNode, { kind: 'record' }>,
  ctx: ConvertContext,
  notes: string[],
): JsonSchema {
  if (supportsAdditionalPropertiesKeyword(ctx.dialect)) {
    return schemaOf([
      ['type', 'object'],
      ['additionalProperties', convertNode(node.value, ctx)],
    ])
  }
  notes.push(`Arbitrary string keys map to ${nodeLabel(node.value)}.`)
  return schemaOf([['type', 'object']])
}

function discriminatedUnionSchema(
  node: ToolDiscriminatedUnionShape,
  ctx: ConvertContext,
): JsonSchema {
  if (ctx.dialect === 'google-gemini-cca' || ctx.dialect === 'moonshot-mfjs') {
    return flattenDiscriminatedUnion(node, ctx)
  }
  return schemaOf([['anyOf', listOf(node.variants.map((variant) => convertNode(variant, ctx)))]])
}

/* -------------------------------------------------------------------------- */
/*                       Discriminated union projection                      */
/* -------------------------------------------------------------------------- */

interface FlattenedProperty {
  readonly tag: string
  readonly child: ToolSchemaNode
}

function flattenDiscriminatedUnion(
  node: ToolDiscriminatedUnionShape,
  ctx: ConvertContext,
): JsonSchema {
  const discriminator = node.discriminator
  const tags: string[] = []
  for (const variant of node.variants) {
    const own = readOwn(variant.properties, discriminator)
    if (
      !own.present ||
      !isSchemaNodeShaped(own.value) ||
      own.value.kind !== 'literal' ||
      typeof own.value.value !== 'string'
    ) {
      throw new InvariantError(
        `discriminated union variant is missing string discriminator ${jsonText(discriminator)}`,
      )
    }
    tags.push(own.value.value)
  }

  const order: string[] = []
  const byKey = new Map<string, FlattenedProperty[]>()
  for (let index = 0; index < node.variants.length; index++) {
    const variant = node.variants[index]
    const tag = tags[index]
    if (variant === undefined || tag === undefined) continue
    for (const key of Object.keys(variant.properties)) {
      if (key === discriminator) continue
      const child = variant.properties[key]
      if (child === undefined) continue
      let bucket = byKey.get(key)
      if (bucket === undefined) {
        bucket = []
        byKey.set(key, bucket)
        order.push(key)
      }
      bucket.push({ tag, child })
    }
  }

  const propertyEntries: [string, unknown][] = [
    [
      discriminator,
      schemaOf([
        ['type', 'string'],
        ['enum', listOf(tags)],
      ]),
    ],
  ]
  const requiredKeys: string[] = [discriminator]

  for (const key of order) {
    const bucket = byKey.get(key) ?? []
    let requiredEverywhere = bucket.length === node.variants.length
    const schemas: JsonSchema[] = []
    const descriptions: string[] = []
    const notes: string[] = []
    const requiredTags: string[] = []
    for (const { tag, child } of bucket) {
      const converted = convertNode(child, ctx)
      const description = descriptionOf(converted)
      if (description !== undefined && !descriptions.includes(description)) {
        descriptions.push(description)
      }
      const stripped = stripDescription(converted)
      if (!schemas.some((schema) => JSON.stringify(schema) === JSON.stringify(stripped))) {
        schemas.push(stripped)
      }
      if (!child.isOptional && !child.hasDefault) requiredTags.push(tag)
      else requiredEverywhere = false
    }
    if (requiredTags.length !== node.variants.length) requiredEverywhere = false
    if (!requiredEverywhere) {
      for (const tag of requiredTags) notes.push(`[When ${discriminator}="${tag}": required]`)
    }
    if (requiredEverywhere) requiredKeys.push(key)
    let propertySchema: JsonSchema =
      schemas.length === 1 && schemas[0] !== undefined
        ? schemas[0]
        : schemaOf([['anyOf', listOf(schemas)]])
    const text = [...descriptions, ...notes].join(' ')
    if (text.length > 0) propertySchema = withDescription(propertySchema, text)
    propertyEntries.push([key, propertySchema])
  }

  return schemaOf([
    ['type', 'object'],
    ['properties', schemaOf(propertyEntries)],
    ['required', listOf(requiredKeys)],
  ])
}

/* -------------------------------------------------------------------------- */
/*                          Complexity measurements                          */
/* -------------------------------------------------------------------------- */

interface NodeStats {
  readonly properties: number
  readonly unionVariants: number
  /** Number of nested object/array/dictionary container levels. */
  readonly height: number
  readonly hasRecord: boolean
}

function emptyStats(): NodeStats {
  return { properties: 0, unionVariants: 0, height: 0, hasRecord: false }
}

function mergeStats(left: NodeStats, right: NodeStats): NodeStats {
  return {
    properties: left.properties + right.properties,
    unionVariants: left.unionVariants + right.unionVariants,
    height: Math.max(left.height, right.height),
    hasRecord: left.hasRecord || right.hasRecord,
  }
}

function statsOf(node: ToolSchemaNode): NodeStats {
  switch (node.kind) {
    case 'str':
    case 'num':
    case 'bool':
    case 'literal':
    case 'enum':
      return emptyStats()
    case 'arr': {
      const item = statsOf(node.item)
      return { ...item, height: 1 + item.height }
    }
    case 'record': {
      const value = statsOf(node.value)
      return { ...value, height: 1 + value.height, hasRecord: true }
    }
    case 'obj': {
      let stats = emptyStats()
      for (const key of Object.keys(node.properties)) {
        const child = node.properties[key]
        if (child !== undefined) stats = mergeStats(stats, statsOf(child))
      }
      return {
        ...stats,
        properties: stats.properties + Object.keys(node.properties).length,
        height: 1 + stats.height,
      }
    }
    case 'union':
    case 'discriminated_union': {
      let stats = emptyStats()
      for (const variant of node.variants) stats = mergeStats(stats, statsOf(variant))
      return {
        ...stats,
        unionVariants: stats.unionVariants + node.variants.length,
      }
    }
    default:
      return emptyStats()
  }
}

function fitsOpenAiStrict(stats: NodeStats): boolean {
  return !stats.hasRecord && stats.height <= 5
}

function fitsAnthropicStrict(stats: NodeStats): boolean {
  return !stats.hasRecord && stats.height <= 4 && stats.properties + stats.unionVariants <= 64
}

/* -------------------------------------------------------------------------- */
/*                             Public normalization                          */
/* -------------------------------------------------------------------------- */

/** Options shared by every dialect. */
export interface NormalizeToolSchemasOptions {
  /** Route-level `compat.disableStrictTools` mapped into static strict:false. */
  readonly disableStrictTools?: boolean
}

interface ValidatedTool {
  readonly tool: NeutralToolDefinition
  readonly root: ToolObjectShape
  readonly stats: NodeStats
  readonly cacheable: boolean
}

/** Roots proven to be recursively frozen; the verdict is immutable-stable. */
const IMMUTABLE_ROOTS = new WeakSet<object>()

function schemaIsCacheable(root: ToolObjectShape): boolean {
  if (IMMUTABLE_ROOTS.has(root)) return true
  if (!isDeeplyImmutableSchema(root)) return false
  IMMUTABLE_ROOTS.add(root)
  return true
}

/**
 * Statically normalize neutral tool definitions into one wire dialect.
 *
 * Pure and deterministic: the same frozen AST always yields the same frozen
 * schema. Invalid definitions are program defects at this point (the service
 * validates first and maps failures to `INVALID_REQUEST`) and throw
 * `InvariantError`.
 */
export function normalizeToolSchemas(
  tools: readonly NeutralToolDefinition[],
  dialect: ToolSchemaDialect,
  options?: NormalizeToolSchemasOptions,
): readonly NormalizedWireToolSchema[] {
  if (typeof dialect !== 'string' || DIALECTS[dialect] !== true) {
    throw new InvariantError(`unknown tool schema dialect ${jsonText(dialect)}`)
  }
  if (!Array.isArray(tools)) {
    throw new InvariantError('normalizeToolSchemas expects an array of tool definitions')
  }
  const disableStrict = options?.disableStrictTools === true

  const validated: ValidatedTool[] = []
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index]
    if (tool === undefined) {
      throw new InvariantError(`tool definition at index ${index} is missing`)
    }
    const result = validateToolDefinition(tool)
    if (!result.ok) {
      throw new InvariantError(`invalid tool definition at index ${index}: ${result.error}`)
    }
    validated.push({
      tool,
      root: tool.parameters,
      stats: statsOf(tool.parameters),
      cacheable: schemaIsCacheable(tool.parameters),
    })
  }

  const anthropicStrict =
    dialect === 'anthropic' &&
    !disableStrict &&
    validated.length <= 8 &&
    validated.every((entry) => fitsAnthropicStrict(entry.stats))

  const dialectCache = CACHES[dialect]
  const normalized: NormalizedWireToolSchema[] = []
  for (const entry of validated) {
    let strict = false
    if (isOpenAiStrictFamily(dialect)) {
      strict = !disableStrict && fitsOpenAiStrict(entry.stats)
    } else if (dialect === 'anthropic') {
      strict = anthropicStrict
    }
    const ctx: ConvertContext = {
      dialect,
      strict,
      strictOpenAi: isOpenAiStrictFamily(dialect),
      cache: entry.cacheable
        ? strict
          ? dialectCache.strictCache
          : dialectCache.looseCache
        : new WeakMap(),
    }
    const converted = convertNode(entry.root, ctx)
    const jsonSchema =
      dialect === 'google-gemini' || dialect === 'google-gemini-cca'
        ? upperCaseSchemaTypes(converted)
        : converted
    normalized.push(
      Object.freeze({
        name: entry.tool.name,
        description: entry.tool.description,
        strict,
        jsonSchema,
      }),
    )
  }
  return Object.freeze(normalized)
}
