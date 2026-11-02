import { InvariantError } from '@sekaisen/core'
import {
  cloneJsonValue,
  codePointLength,
  createDataObject,
  defineData,
  describeReceived,
  formatIssues,
  isFiniteNumber,
  isNonNegativeInteger,
  isRecord,
  isSchemaNodeShaped,
  jsonText,
  nodeLabel,
  readOwn,
  renderPath,
  TOOL_NODE_KINDS,
} from './tool-internal.ts'
import type {
  ToolDiscriminatedUnionShape,
  ToolFieldIssue,
  ToolObjectShape,
  ToolSchemaNode,
} from './tool-types.ts'

/* -------------------------------------------------------------------------- */
/*                               Decode outcome                              */
/* -------------------------------------------------------------------------- */

/** Pure decoding outcome for one node and one raw value. */
export type DecodeOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly ToolFieldIssue[] }

function succeed(value: unknown): DecodeOutcome {
  return Object.freeze({ ok: true, value })
}

function makeIssue(
  path: readonly string[],
  expected: string,
  received: string,
  message: string,
): ToolFieldIssue {
  return Object.freeze({ path: Object.freeze([...path]), expected, received, message })
}

function fail(
  path: readonly string[],
  expected: string,
  received: string,
  message: string,
): DecodeOutcome {
  return Object.freeze({
    ok: false,
    issues: Object.freeze([makeIssue(path, expected, received, message)]),
  })
}

function failMany(issues: readonly ToolFieldIssue[]): DecodeOutcome {
  return Object.freeze({ ok: false, issues: Object.freeze([...issues]) })
}

/* -------------------------------------------------------------------------- */
/*                          Discriminator tag index                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the discriminator tag index for one decode call. Deliberately not
 * memoized by node identity: handwritten schemas are accepted mutable, so a
 * stale tag table after an edit would dispatch into the wrong variant. Branch
 * dispatch itself remains O(1) through the returned map.
 */
function tagMapFor(node: ToolDiscriminatedUnionShape): ReadonlyMap<string, ToolObjectShape> {
  const map = new Map<string, ToolObjectShape>()
  for (const variant of node.variants) {
    const own = readOwn(variant.properties, node.discriminator)
    if (!own.present || !isRecord(own.value)) {
      throw new InvariantError(
        `discriminated union variant is missing discriminator "${node.discriminator}"`,
      )
    }
    const literal = own.value
    const tag: unknown = literal.value
    if (literal.kind !== 'literal' || typeof tag !== 'string') {
      throw new InvariantError(`discriminator "${node.discriminator}" must be a string literal`)
    }
    map.set(tag, variant)
  }
  return map
}

/* -------------------------------------------------------------------------- */
/*                              Value decoding                               */
/* -------------------------------------------------------------------------- */

function decodeString(
  node: Extract<ToolSchemaNode, { kind: 'str' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (typeof value !== 'string') {
    return fail(path, 'string', describeReceived(value), 'Expected a JSON string')
  }
  if (!value.isWellFormed()) {
    return fail(
      path,
      'string',
      'string with unpaired surrogates',
      'Strings must be well-formed Unicode',
    )
  }
  const length = codePointLength(value)
  if (node.minLength !== undefined && length < node.minLength) {
    return fail(
      path,
      `string with at least ${node.minLength} characters`,
      `string of length ${length}`,
      `String is shorter than minLength ${node.minLength}`,
    )
  }
  if (node.maxLength !== undefined && length > node.maxLength) {
    return fail(
      path,
      `string with at most ${node.maxLength} characters`,
      `string of length ${length}`,
      `String is longer than maxLength ${node.maxLength}`,
    )
  }
  return succeed(value)
}

function decodeNumber(
  node: Extract<ToolSchemaNode, { kind: 'num' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(path, nodeLabel(node), describeReceived(value), 'Expected a finite JSON number')
  }
  if (node.integerOnly && !Number.isInteger(value)) {
    return fail(
      path,
      'integer',
      describeReceived(value),
      'Expected an integer without a fractional part',
    )
  }
  if (node.minimum !== undefined && value < node.minimum) {
    return fail(
      path,
      `${nodeLabel(node)} >= ${node.minimum}`,
      describeReceived(value),
      `Number is below minimum ${node.minimum}`,
    )
  }
  if (node.maximum !== undefined && value > node.maximum) {
    return fail(
      path,
      `${nodeLabel(node)} <= ${node.maximum}`,
      describeReceived(value),
      `Number is above maximum ${node.maximum}`,
    )
  }
  return succeed(value)
}

function decodeBoolean(value: unknown, path: readonly string[]): DecodeOutcome {
  if (typeof value !== 'boolean') {
    return fail(path, 'boolean', describeReceived(value), 'Expected a JSON boolean')
  }
  return succeed(value)
}

function decodeLiteral(
  node: Extract<ToolSchemaNode, { kind: 'literal' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (value !== node.value) {
    return fail(
      path,
      `literal ${jsonText(node.value)}`,
      describeReceived(value),
      `Expected exactly ${jsonText(node.value)}`,
    )
  }
  return succeed(value)
}

function decodeEnum(
  node: Extract<ToolSchemaNode, { kind: 'enum' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (typeof value !== 'string' || !node.values.includes(value)) {
    return fail(
      path,
      nodeLabel(node),
      describeReceived(value),
      `Expected one of ${node.values.map((allowed) => jsonText(allowed)).join(', ')}`,
    )
  }
  return succeed(value)
}

function decodeArray(
  node: Extract<ToolSchemaNode, { kind: 'arr' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (!Array.isArray(value)) {
    return fail(
      path,
      `array of ${nodeLabel(node.item)}`,
      describeReceived(value),
      'Expected a JSON array',
    )
  }
  const issues: ToolFieldIssue[] = []
  const items: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const decoded = decodeNodeValue(node.item, value[index], [...path, String(index)])
    if (decoded.ok) items.push(decoded.value)
    else issues.push(...decoded.issues)
  }
  if (node.minItems !== undefined && value.length < node.minItems) {
    issues.push(
      makeIssue(
        path,
        `array with at least ${node.minItems} items`,
        `array of ${value.length} items`,
        `Array is shorter than minItems ${node.minItems}`,
      ),
    )
  }
  if (node.maxItems !== undefined && value.length > node.maxItems) {
    issues.push(
      makeIssue(
        path,
        `array with at most ${node.maxItems} items`,
        `array of ${value.length} items`,
        `Array is longer than maxItems ${node.maxItems}`,
      ),
    )
  }
  if (issues.length > 0) return failMany(issues)
  return succeed(Object.freeze(items))
}

function decodeObject(
  node: ToolObjectShape,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (!isRecord(value)) {
    return fail(path, 'object', describeReceived(value), 'Expected a JSON object')
  }
  const issues: ToolFieldIssue[] = []
  const out = createDataObject(false)
  for (const key of Object.keys(node.properties)) {
    const child = node.properties[key]
    if (child === undefined) continue
    const own = readOwn(value, key)
    if (!own.present || own.value === undefined) {
      if (child.hasDefault) {
        if (!Object.hasOwn(child, 'defaultValue')) {
          throw new InvariantError('schema node declares hasDefault without a defaultValue')
        }
        defineData(out, key, cloneJsonValue(child.defaultValue))
      } else if (!child.isOptional) {
        issues.push(
          makeIssue(
            [...path, key],
            nodeLabel(child),
            'missing',
            `Required property ${jsonText(key)} is missing`,
          ),
        )
      }
      continue
    }
    if (own.value === null) {
      if (acceptsNull(child)) {
        defineData(out, key, null)
      } else if (child.hasDefault) {
        if (!Object.hasOwn(child, 'defaultValue')) {
          throw new InvariantError('schema node declares hasDefault without a defaultValue')
        }
        defineData(out, key, cloneJsonValue(child.defaultValue))
      } else if (!child.isOptional) {
        issues.push(
          makeIssue(
            [...path, key],
            nodeLabel(child),
            'null',
            `Required property ${jsonText(key)} may not be null`,
          ),
        )
      }
      continue
    }
    const decoded = decodeNodeValue(child, own.value, [...path, key])
    if (decoded.ok) defineData(out, key, decoded.value)
    else issues.push(...decoded.issues)
  }
  if (issues.length > 0) return failMany(issues)
  return succeed(Object.freeze(out))
}

function decodeRecord(
  node: Extract<ToolSchemaNode, { kind: 'record' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (!isRecord(value)) {
    return fail(path, nodeLabel(node), describeReceived(value), 'Expected a JSON object')
  }
  const issues: ToolFieldIssue[] = []
  const out = createDataObject(true)
  for (const key of Object.keys(value)) {
    const own = readOwn(value, key)
    if (!own.present) continue
    if (own.value === undefined) {
      issues.push(
        makeIssue(
          [...path, key],
          nodeLabel(node.value),
          'undefined',
          'Record values must be JSON values',
        ),
      )
      continue
    }
    const decoded = decodeNodeValue(node.value, own.value, [...path, key])
    if (decoded.ok) defineData(out, key, decoded.value)
    else issues.push(...decoded.issues)
  }
  if (issues.length > 0) return failMany(issues)
  return succeed(Object.freeze(out))
}

function decodeUnion(
  node: Extract<ToolSchemaNode, { kind: 'union' }>,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  for (const variant of node.variants) {
    const decoded = decodeNodeValue(variant, value, path)
    if (decoded.ok) return decoded
  }
  return fail(
    path,
    nodeLabel(node),
    describeReceived(value),
    'Value did not match any union variant',
  )
}

function decodeDiscriminatedUnion(
  node: ToolDiscriminatedUnionShape,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (!isRecord(value)) {
    return fail(path, nodeLabel(node), describeReceived(value), 'Expected a JSON object')
  }
  const tags = tagMapFor(node)
  const expected = `one of ${[...tags.keys()].map((tag) => jsonText(tag)).join(' | ')}`
  const own = readOwn(value, node.discriminator)
  if (!own.present || own.value === undefined) {
    return fail(
      [...path, node.discriminator],
      expected,
      'missing',
      `Discriminator ${jsonText(node.discriminator)} is missing`,
    )
  }
  if (typeof own.value !== 'string') {
    return fail(
      [...path, node.discriminator],
      expected,
      describeReceived(own.value),
      `Discriminator ${jsonText(node.discriminator)} must be a string`,
    )
  }
  const variant = tags.get(own.value)
  if (variant === undefined) {
    return fail(
      [...path, node.discriminator],
      expected,
      jsonText(own.value),
      `Unknown discriminator value for ${jsonText(node.discriminator)}`,
    )
  }
  // Precise O(1) branch dispatch: only the matched variant is validated.
  return decodeNodeValue(variant, value, path)
}

/**
 * Decode one JSON value against a schema node.
 *
 * Presence rules (`isOptional` / `hasDefault`) are owned by the parent object
 * decoder; this function validates the node's value domain, including
 * nullability. It never throws for bad input and never mutates the input.
 */
/**
 * Whether a node's value domain explicitly includes JSON `null`. Union
 * variants may declare nullability even when the union node itself does not.
 */
function acceptsNull(node: ToolSchemaNode): boolean {
  if (node.isNullable) return true
  if (node.kind === 'union') return node.variants.some((variant) => acceptsNull(variant))
  return false
}

export function decodeNodeValue(
  node: ToolSchemaNode,
  value: unknown,
  path: readonly string[],
): DecodeOutcome {
  if (value === null) {
    if (acceptsNull(node)) return succeed(null)
    return fail(path, nodeLabel(node), 'null', 'null is not allowed for this field')
  }
  switch (node.kind) {
    case 'str':
      return decodeString(node, value, path)
    case 'num':
      return decodeNumber(node, value, path)
    case 'bool':
      return decodeBoolean(value, path)
    case 'literal':
      return decodeLiteral(node, value, path)
    case 'enum':
      return decodeEnum(node, value, path)
    case 'arr':
      return decodeArray(node, value, path)
    case 'obj':
      return decodeObject(node, value, path)
    case 'record':
      return decodeRecord(node, value, path)
    case 'union':
      return decodeUnion(node, value, path)
    case 'discriminated_union':
      return decodeDiscriminatedUnion(node, value, path)
    default:
      throw new InvariantError('unknown tool schema node kind')
  }
}

/* -------------------------------------------------------------------------- */
/*                          Structural validation                            */
/* -------------------------------------------------------------------------- */

const MODIFIER_FLAGS = ['isOptional', 'isNullable', 'hasDefault'] as const

function validateModifiers(node: Record<string, unknown>, path: readonly string[]): string | null {
  const at = renderPath(path)
  for (const flag of MODIFIER_FLAGS) {
    if (typeof node[flag] !== 'boolean') return `${at}: ${flag} must be a boolean`
  }
  if (node.description !== undefined) {
    const description = node.description
    if (typeof description !== 'string') return `${at}: description must be a string`
    if (!description.isWellFormed()) return `${at}: description contains unpaired surrogates`
  }
  if (node.hasDefault === true && !Object.hasOwn(node, 'defaultValue')) {
    return `${at}: hasDefault requires defaultValue`
  }
  if (node.hasDefault === false && Object.hasOwn(node, 'defaultValue')) {
    return `${at}: defaultValue requires hasDefault`
  }
  return null
}

function validateBounds(
  node: Record<string, unknown>,
  path: readonly string[],
  minKey: string,
  maxKey: string,
): string | null {
  const at = renderPath(path)
  const min = node[minKey]
  const max = node[maxKey]
  if (min !== undefined && !isNonNegativeInteger(min)) {
    return `${at}: ${minKey} must be a non-negative integer`
  }
  if (max !== undefined && !isNonNegativeInteger(max)) {
    return `${at}: ${maxKey} must be a non-negative integer`
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    return `${at}: ${minKey} must not exceed ${maxKey}`
  }
  return null
}

function validateNumericBounds(
  node: Record<string, unknown>,
  path: readonly string[],
): string | null {
  const at = renderPath(path)
  if (typeof node.integerOnly !== 'boolean') return `${at}: integerOnly must be a boolean`
  const minimum = node.minimum
  const maximum = node.maximum
  if (minimum !== undefined && !isFiniteNumber(minimum)) {
    return `${at}: minimum must be a finite number`
  }
  if (maximum !== undefined && !isFiniteNumber(maximum)) {
    return `${at}: maximum must be a finite number`
  }
  if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum) {
    return `${at}: minimum must not exceed maximum`
  }
  return null
}

function validateLiteralValue(value: unknown, path: readonly string[]): string | null {
  const at = renderPath(path)
  if (typeof value === 'string') {
    return value.isWellFormed() ? null : `${at}: literal string contains unpaired surrogates`
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${at}: literal number must be finite`
  }
  if (typeof value === 'boolean') return null
  return `${at}: literal value must be a string, number, or boolean`
}

function validateEnumValues(values: unknown, path: readonly string[]): string | null {
  const at = renderPath(path)
  if (!Array.isArray(values) || values.length === 0) {
    return `${at}: enum values must be a non-empty string array`
  }
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') return `${at}: enum values must be strings`
    if (!value.isWellFormed()) return `${at}: enum value contains unpaired surrogates`
    if (seen.has(value)) return `${at}: enum values must be unique`
    seen.add(value)
  }
  return null
}

function validateForbiddenPresence(
  child: ToolSchemaNode,
  path: readonly string[],
  role: string,
): string | null {
  const at = renderPath(path)
  if (child.isOptional) return `${at}: ${role} nodes may not be optional`
  if (child.hasDefault) return `${at}: ${role} nodes may not declare a default`
  return null
}

function validateDiscriminatedVariant(
  variant: ToolObjectShape,
  discriminator: string,
  path: readonly string[],
  seenTags: Set<string>,
): string | null {
  const at = renderPath(path)
  if (variant.isOptional) return `${at}: discriminated union variants may not be optional`
  if (variant.isNullable) return `${at}: discriminated union variants may not be nullable`
  if (variant.hasDefault) return `${at}: discriminated union variants may not declare a default`
  const own = readOwn(variant.properties, discriminator)
  if (!own.present)
    return `${at}: variant is missing discriminator property ${jsonText(discriminator)}`
  if (!isRecord(own.value)) return `${at}: discriminator property must be a schema node`
  const literal = own.value
  if (literal.kind !== 'literal') {
    return `${at}: discriminator property must be a string literal node`
  }
  const tag: unknown = literal.value
  if (typeof tag !== 'string' || tag.length === 0) {
    return `${at}: discriminator tag must be a non-empty string`
  }
  if (!tag.isWellFormed()) return `${at}: discriminator tag contains unpaired surrogates`
  if (literal.isOptional || literal.isNullable || literal.hasDefault) {
    return `${at}: discriminator literal may not be optional, nullable, or defaulted`
  }
  if (seenTags.has(tag)) {
    return `${at}: duplicate discriminator tag ${jsonText(tag)}`
  }
  seenTags.add(tag)
  return null
}

/**
 * Fully validate a schema node. The first violation is returned as a readable
 * string; handwritten ASTs are therefore safe to preflight before use.
 */
export function validateSchemaNode(
  node: unknown,
  path: readonly string[],
  seen: Set<object> = new Set(),
): string | null {
  const at = renderPath(path)
  if (!isRecord(node)) return `${at}: expected a schema node object`
  if (seen.has(node)) return `${at}: cyclic schema reference`
  const kind = node.kind
  if (typeof kind !== 'string' || TOOL_NODE_KINDS[kind] !== true) {
    return `${at}: unknown schema node kind ${jsonText(kind)}`
  }
  seen.add(node)
  try {
    const modifierError = validateModifiers(node, path)
    if (modifierError !== null) return modifierError

    switch (kind) {
      case 'str': {
        const boundsError = validateBounds(node, path, 'minLength', 'maxLength')
        if (boundsError !== null) return boundsError
        break
      }
      case 'num': {
        const numericError = validateNumericBounds(node, path)
        if (numericError !== null) return numericError
        break
      }
      case 'bool':
        break
      case 'literal': {
        const literalError = validateLiteralValue(node.value, [...path, 'value'])
        if (literalError !== null) return literalError
        break
      }
      case 'enum': {
        const enumError = validateEnumValues(node.values, [...path, 'values'])
        if (enumError !== null) return enumError
        break
      }
      case 'arr': {
        const itemError = validateSchemaNode(node.item, [...path, 'item'], seen)
        if (itemError !== null) return itemError
        if (!isSchemaNodeShaped(node.item)) return `${at}: item must be a schema node`
        const presenceError = validateForbiddenPresence(node.item, [...path, 'item'], 'array item')
        if (presenceError !== null) return presenceError
        const boundsError = validateBounds(node, path, 'minItems', 'maxItems')
        if (boundsError !== null) return boundsError
        break
      }
      case 'obj': {
        const properties = node.properties
        if (!isRecord(properties)) return `${at}: properties must be an object`
        for (const key of Object.keys(properties)) {
          if (!key.isWellFormed()) return `${at}: property names must be well-formed Unicode`
          const childError = validateSchemaNode(properties[key], [...path, key], seen)
          if (childError !== null) return childError
        }
        break
      }
      case 'record': {
        const valueError = validateSchemaNode(node.value, [...path, 'value'], seen)
        if (valueError !== null) return valueError
        if (!isSchemaNodeShaped(node.value)) return `${at}: value must be a schema node`
        const presenceError = validateForbiddenPresence(
          node.value,
          [...path, 'value'],
          'record value',
        )
        if (presenceError !== null) return presenceError
        break
      }
      case 'union': {
        const variants = node.variants
        if (!Array.isArray(variants) || variants.length < 2) {
          return `${at}: unions require at least two variants`
        }
        for (let index = 0; index < variants.length; index++) {
          const variantError = validateSchemaNode(variants[index], [...path, String(index)], seen)
          if (variantError !== null) return variantError
        }
        break
      }
      case 'discriminated_union': {
        const discriminator = node.discriminator
        if (typeof discriminator !== 'string' || discriminator.length === 0) {
          return `${at}: discriminator must be a non-empty string`
        }
        if (!discriminator.isWellFormed()) {
          return `${at}: discriminator contains unpaired surrogates`
        }
        const variants = node.variants
        if (!Array.isArray(variants) || variants.length < 2) {
          return `${at}: discriminated unions require at least two variants`
        }
        const tags = new Set<string>()
        for (let index = 0; index < variants.length; index++) {
          const variantPath = [...path, 'variants', String(index)]
          const variantError = validateSchemaNode(variants[index], variantPath, seen)
          if (variantError !== null) return variantError
          const variant = variants[index]
          if (!isSchemaNodeShaped(variant) || variant.kind !== 'obj') {
            return `${renderPath(variantPath)}: discriminated union variants must be object nodes`
          }
          const variantTagError = validateDiscriminatedVariant(
            variant,
            discriminator,
            variantPath,
            tags,
          )
          if (variantTagError !== null) return variantTagError
        }
        break
      }
      default:
        return `${at}: unknown schema node kind ${jsonText(kind)}`
    }

    if (node.hasDefault === true) {
      const defaultIssues = decodeNodeValue(node as unknown as ToolSchemaNode, node.defaultValue, [
        ...path,
        'defaultValue',
      ])
      if (!defaultIssues.ok) {
        return `${renderPath([...path, 'defaultValue'])}: default value is invalid\n${formatIssues(defaultIssues.issues)}`
      }
    }
    return null
  } finally {
    seen.delete(node)
  }
}

/** Throw `InvariantError` unless `node` is a fully valid schema node. */
export function assertToolSchema(
  node: unknown,
  path: readonly string[] = [],
): asserts node is ToolSchemaNode {
  const error = validateSchemaNode(node, path)
  if (error !== null) throw new InvariantError(error)
}

/** Normalize a builder default through the node's own schema. */
export function normalizeDefaultValue(node: ToolSchemaNode, value: unknown): unknown {
  const decoded = decodeNodeValue(node, value, [])
  if (!decoded.ok) {
    throw new InvariantError(`invalid default value:\n${formatIssues(decoded.issues)}`)
  }
  return decoded.value
}
