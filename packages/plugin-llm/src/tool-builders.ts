import { InvariantError } from '@sekaisen/core'
import { normalizeDefaultValue } from './tool-decode.ts'
import {
  canonicalJsonNumber,
  defineData,
  isFiniteNumber,
  isNonNegativeInteger,
  isRecord,
  isSchemaNodeShaped,
  jsonText,
  readOwn,
} from './tool-internal.ts'
import type {
  DiscriminatedVariantObject,
  ToolArrayBuilder,
  ToolBooleanBuilder,
  ToolBuilder,
  ToolDiscriminatedUnionBuilder,
  ToolEnumBuilder,
  ToolLiteralBuilder,
  ToolNumberBuilder,
  ToolObjectBuilder,
  ToolRecordBuilder,
  ToolScalarValue,
  ToolSchemaNode,
  ToolStringBuilder,
  ToolUnionBuilder,
} from './tool-types.ts'

/* -------------------------------------------------------------------------- */
/*                              Builder state                                */
/* -------------------------------------------------------------------------- */

interface ModifierState {
  readonly description: string
  readonly isOptional: boolean
  readonly isNullable: boolean
  readonly hasDefault: boolean
  readonly defaultValue: unknown
}

const INITIAL_STATE: ModifierState = Object.freeze({
  description: '',
  isOptional: false,
  isNullable: false,
  hasDefault: false,
  defaultValue: undefined,
})

interface ModifierFields<TDefault> {
  readonly isOptional: boolean
  readonly isNullable: boolean
  readonly hasDefault: boolean
  readonly description?: string
  readonly defaultValue?: TDefault
}

function modifierFields<TDefault>(state: ModifierState): ModifierFields<TDefault> {
  const fields: {
    isOptional: boolean
    isNullable: boolean
    hasDefault: boolean
    description?: string
    defaultValue?: TDefault
  } = {
    isOptional: state.isOptional,
    isNullable: state.isNullable,
    hasDefault: state.hasDefault,
  }
  if (state.description.length > 0) fields.description = state.description
  if (state.hasDefault) fields.defaultValue = state.defaultValue as TDefault
  return fields
}

function withDescription(state: ModifierState, description: string): ModifierState {
  if (typeof description !== 'string') {
    throw new InvariantError('t.*.desc(): description must be a string')
  }
  if (!description.isWellFormed()) {
    throw new InvariantError('t.*.desc(): description must be well-formed Unicode')
  }
  return Object.freeze({ ...state, description })
}

function withOptional(state: ModifierState): ModifierState {
  return Object.freeze({ ...state, isOptional: true })
}

function withNullable(state: ModifierState): ModifierState {
  return Object.freeze({ ...state, isNullable: true })
}

function withDefault(state: ModifierState, node: ToolSchemaNode, value: unknown): ModifierState {
  const normalized = normalizeDefaultValue(node, value)
  return Object.freeze({ ...state, hasDefault: true, defaultValue: normalized })
}

/* -------------------------------------------------------------------------- */
/*                           Constructor invariants                          */
/* -------------------------------------------------------------------------- */

function assertSchemaChild(value: unknown, role: string): asserts value is ToolSchemaNode {
  if (!isSchemaNodeShaped(value)) {
    throw new InvariantError(`${role} must be a tool schema node`)
  }
}

function assertNonNegativeInteger(label: string, value: number | undefined): void {
  if (value !== undefined && !isNonNegativeInteger(value)) {
    throw new InvariantError(`${label} must be a non-negative integer`)
  }
}

function assertFiniteBound(label: string, value: number | undefined): void {
  if (value !== undefined && !isFiniteNumber(value)) {
    throw new InvariantError(`${label} must be a finite number`)
  }
}

function assertLiteralValue(value: unknown): asserts value is ToolScalarValue {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) {
      throw new InvariantError('t.literal(): string literal must be well-formed Unicode')
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new InvariantError('t.literal(): number literal must be finite')
    return
  }
  if (typeof value === 'boolean') return
  throw new InvariantError('t.literal(): value must be a string, number, or boolean')
}

function assertEnumValues(values: unknown): asserts values is readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new InvariantError('t.enum(): values must be a non-empty string array')
  }
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') throw new InvariantError('t.enum(): values must be strings')
    if (!value.isWellFormed()) {
      throw new InvariantError('t.enum(): values must be well-formed Unicode')
    }
    if (seen.has(value)) throw new InvariantError('t.enum(): values must be unique')
    seen.add(value)
  }
}

function assertArrayItem(item: unknown): asserts item is ToolSchemaNode {
  assertSchemaChild(item, 't.arr() item')
  if (item.isOptional) throw new InvariantError('t.arr(): the item node may not be optional')
  if (item.hasDefault) throw new InvariantError('t.arr(): the item node may not declare a default')
}

function assertRecordValue(value: unknown): asserts value is ToolSchemaNode {
  assertSchemaChild(value, 't.record() value')
  if (value.isOptional) throw new InvariantError('t.record(): the value node may not be optional')
  if (value.hasDefault) {
    throw new InvariantError('t.record(): the value node may not declare a default')
  }
}

function cloneProperties<TProps extends Readonly<Record<string, ToolSchemaNode>>>(
  properties: TProps,
): TProps {
  if (!isRecord(properties)) throw new InvariantError('t.obj(): properties must be a record')
  const copied = Object.create(null) as Record<string, ToolSchemaNode>
  for (const key of Object.keys(properties)) {
    if (!key.isWellFormed()) {
      throw new InvariantError('t.obj(): property names must be well-formed Unicode')
    }
    const own = readOwn(properties, key)
    if (!own.present) continue
    assertSchemaChild(own.value, `t.obj() property ${jsonText(key)}`)
    defineData(copied, key, own.value)
  }
  return Object.freeze(copied) as unknown as TProps
}

function assertDiscriminatedVariants<D extends string>(
  discriminator: D,
  variants: readonly DiscriminatedVariantObject<D>[],
): void {
  if (!Array.isArray(variants) || variants.length < 2) {
    throw new InvariantError('t.discriminatedUnion(): at least two variants are required')
  }
  const tags = new Set<string>()
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index]
    assertSchemaChild(variant, `t.discriminatedUnion() variant ${index}`)
    if (variant.kind !== 'obj') {
      throw new InvariantError('t.discriminatedUnion(): every variant must be an object node')
    }
    if (variant.isOptional || variant.isNullable || variant.hasDefault) {
      throw new InvariantError(
        't.discriminatedUnion(): variants may not be optional, nullable, or defaulted',
      )
    }
    if (!isRecord(variant.properties)) {
      throw new InvariantError('t.discriminatedUnion(): variant properties must be a record')
    }
    const own = readOwn(variant.properties, discriminator)
    if (!own.present) {
      throw new InvariantError(
        `t.discriminatedUnion(): every variant needs discriminator ${jsonText(discriminator)}`,
      )
    }
    const literal = own.value
    if (!isSchemaNodeShaped(literal) || literal.kind !== 'literal') {
      throw new InvariantError(
        't.discriminatedUnion(): discriminator property must be a literal node',
      )
    }
    if (typeof literal.value !== 'string' || literal.value.length === 0) {
      throw new InvariantError(
        't.discriminatedUnion(): discriminator tags must be non-empty strings',
      )
    }
    if (!literal.value.isWellFormed()) {
      throw new InvariantError(
        't.discriminatedUnion(): discriminator tags must be well-formed Unicode',
      )
    }
    if (literal.isOptional || literal.isNullable || literal.hasDefault) {
      throw new InvariantError(
        't.discriminatedUnion(): discriminator literal may not be optional, nullable, or defaulted',
      )
    }
    if (tags.has(literal.value)) {
      throw new InvariantError(
        `t.discriminatedUnion(): duplicate discriminator tag ${jsonText(literal.value)}`,
      )
    }
    tags.add(literal.value)
  }
}

/* -------------------------------------------------------------------------- */
/*                                Factories                                  */
/* -------------------------------------------------------------------------- */

function makeString<O extends boolean, N extends boolean, D extends boolean>(
  state: ModifierState,
  minLength: number | undefined,
  maxLength: number | undefined,
): ToolStringBuilder<O, N, D> {
  assertNonNegativeInteger('t.str() minLength', minLength)
  assertNonNegativeInteger('t.str() maxLength', maxLength)
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new InvariantError('t.str(): minLength must not exceed maxLength')
  }
  const fields = Object.freeze({
    kind: 'str' as const,
    ...modifierFields<unknown>(state),
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolStringBuilder<O, N, D> {
      return makeString<O, N, D>(withDescription(state, description), minLength, maxLength)
    },
    optional(): ToolStringBuilder<true, N, D> {
      return makeString<true, N, D>(withOptional(state), minLength, maxLength)
    },
    nullable(): ToolStringBuilder<O, true, D> {
      return makeString<O, true, D>(withNullable(state), minLength, maxLength)
    },
    default(value: unknown): ToolStringBuilder<O, N, true> {
      return makeString<O, N, true>(withDefault(state, node, value), minLength, maxLength)
    },
    min(value: number): ToolStringBuilder<O, N, D> {
      return makeString<O, N, D>(state, value, maxLength)
    },
    max(value: number): ToolStringBuilder<O, N, D> {
      return makeString<O, N, D>(state, minLength, value)
    },
  }) as unknown as ToolStringBuilder<O, N, D>
}

function makeNumber<O extends boolean, N extends boolean, D extends boolean>(
  state: ModifierState,
  integerOnly: boolean,
  min: number | undefined,
  max: number | undefined,
): ToolNumberBuilder<O, N, D> {
  assertFiniteBound('t.*() min', min)
  assertFiniteBound('t.*() max', max)
  if (min !== undefined && max !== undefined && min > max) {
    throw new InvariantError('t.num(): min must not exceed max')
  }
  const fields = Object.freeze({
    kind: 'num' as const,
    ...modifierFields<unknown>(state),
    integerOnly,
    ...(min !== undefined ? { minimum: min } : {}),
    ...(max !== undefined ? { maximum: max } : {}),
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolNumberBuilder<O, N, D> {
      return makeNumber<O, N, D>(withDescription(state, description), integerOnly, min, max)
    },
    optional(): ToolNumberBuilder<true, N, D> {
      return makeNumber<true, N, D>(withOptional(state), integerOnly, min, max)
    },
    nullable(): ToolNumberBuilder<O, true, D> {
      return makeNumber<O, true, D>(withNullable(state), integerOnly, min, max)
    },
    default(value: unknown): ToolNumberBuilder<O, N, true> {
      return makeNumber<O, N, true>(withDefault(state, node, value), integerOnly, min, max)
    },
    min(value: number): ToolNumberBuilder<O, N, D> {
      return makeNumber<O, N, D>(state, integerOnly, value, max)
    },
    max(value: number): ToolNumberBuilder<O, N, D> {
      return makeNumber<O, N, D>(state, integerOnly, min, value)
    },
  }) as unknown as ToolNumberBuilder<O, N, D>
}

function makeBoolean<O extends boolean, N extends boolean, D extends boolean>(
  state: ModifierState,
): ToolBooleanBuilder<O, N, D> {
  const fields = Object.freeze({ kind: 'bool' as const, ...modifierFields<unknown>(state) })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolBooleanBuilder<O, N, D> {
      return makeBoolean<O, N, D>(withDescription(state, description))
    },
    optional(): ToolBooleanBuilder<true, N, D> {
      return makeBoolean<true, N, D>(withOptional(state))
    },
    nullable(): ToolBooleanBuilder<O, true, D> {
      return makeBoolean<O, true, D>(withNullable(state))
    },
    default(value: unknown): ToolBooleanBuilder<O, N, true> {
      return makeBoolean<O, N, true>(withDefault(state, node, value))
    },
  }) as unknown as ToolBooleanBuilder<O, N, D>
}

function makeLiteral<
  V extends ToolScalarValue,
  O extends boolean,
  N extends boolean,
  D extends boolean,
>(state: ModifierState, value: V): ToolLiteralBuilder<V, O, N, D> {
  assertLiteralValue(value)
  const stored = (typeof value === 'number' ? canonicalJsonNumber(value) : value) as V
  const fields = Object.freeze({
    kind: 'literal' as const,
    ...modifierFields<unknown>(state),
    value: stored,
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolLiteralBuilder<V, O, N, D> {
      return makeLiteral<V, O, N, D>(withDescription(state, description), stored)
    },
    optional(): ToolLiteralBuilder<V, true, N, D> {
      return makeLiteral<V, true, N, D>(withOptional(state), stored)
    },
    nullable(): ToolLiteralBuilder<V, O, true, D> {
      return makeLiteral<V, O, true, D>(withNullable(state), stored)
    },
    default(value_: unknown): ToolLiteralBuilder<V, O, N, true> {
      return makeLiteral<V, O, N, true>(withDefault(state, node, value_), stored)
    },
  }) as unknown as ToolLiteralBuilder<V, O, N, D>
}

function makeEnum<
  TValues extends readonly [string, ...string[]],
  O extends boolean,
  N extends boolean,
  D extends boolean,
>(state: ModifierState, values: TValues): ToolEnumBuilder<TValues, O, N, D> {
  assertEnumValues(values)
  const frozen = Object.freeze([...values]) as unknown as TValues
  const fields = Object.freeze({
    kind: 'enum' as const,
    ...modifierFields<unknown>(state),
    values: frozen,
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolEnumBuilder<TValues, O, N, D> {
      return makeEnum<TValues, O, N, D>(withDescription(state, description), frozen)
    },
    optional(): ToolEnumBuilder<TValues, true, N, D> {
      return makeEnum<TValues, true, N, D>(withOptional(state), frozen)
    },
    nullable(): ToolEnumBuilder<TValues, O, true, D> {
      return makeEnum<TValues, O, true, D>(withNullable(state), frozen)
    },
    default(value: unknown): ToolEnumBuilder<TValues, O, N, true> {
      return makeEnum<TValues, O, N, true>(withDefault(state, node, value), frozen)
    },
  }) as unknown as ToolEnumBuilder<TValues, O, N, D>
}

function makeArray<
  TItem extends ToolSchemaNode,
  O extends boolean,
  N extends boolean,
  D extends boolean,
>(
  state: ModifierState,
  item: TItem,
  minItems: number | undefined,
  maxItems: number | undefined,
): ToolArrayBuilder<TItem, O, N, D> {
  assertArrayItem(item)
  assertNonNegativeInteger('t.arr() minItems', minItems)
  assertNonNegativeInteger('t.arr() maxItems', maxItems)
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw new InvariantError('t.arr(): minItems must not exceed maxItems')
  }
  const fields = Object.freeze({
    kind: 'arr' as const,
    ...modifierFields<unknown>(state),
    item,
    ...(minItems !== undefined ? { minItems } : {}),
    ...(maxItems !== undefined ? { maxItems } : {}),
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolArrayBuilder<TItem, O, N, D> {
      return makeArray<TItem, O, N, D>(
        withDescription(state, description),
        item,
        minItems,
        maxItems,
      )
    },
    optional(): ToolArrayBuilder<TItem, true, N, D> {
      return makeArray<TItem, true, N, D>(withOptional(state), item, minItems, maxItems)
    },
    nullable(): ToolArrayBuilder<TItem, O, true, D> {
      return makeArray<TItem, O, true, D>(withNullable(state), item, minItems, maxItems)
    },
    default(value: unknown): ToolArrayBuilder<TItem, O, N, true> {
      return makeArray<TItem, O, N, true>(withDefault(state, node, value), item, minItems, maxItems)
    },
    min(value: number): ToolArrayBuilder<TItem, O, N, D> {
      return makeArray<TItem, O, N, D>(state, item, value, maxItems)
    },
    max(value: number): ToolArrayBuilder<TItem, O, N, D> {
      return makeArray<TItem, O, N, D>(state, item, minItems, value)
    },
  }) as unknown as ToolArrayBuilder<TItem, O, N, D>
}

function makeObject<
  TProps extends Readonly<Record<string, ToolSchemaNode>>,
  O extends boolean,
  N extends boolean,
  D extends boolean,
>(state: ModifierState, properties: TProps): ToolObjectBuilder<TProps, O, N, D> {
  const copied = cloneProperties(properties)
  const fields = Object.freeze({
    kind: 'obj' as const,
    ...modifierFields<unknown>(state),
    properties: copied,
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolObjectBuilder<TProps, O, N, D> {
      return makeObject<TProps, O, N, D>(withDescription(state, description), copied)
    },
    optional(): ToolObjectBuilder<TProps, true, N, D> {
      return makeObject<TProps, true, N, D>(withOptional(state), copied)
    },
    nullable(): ToolObjectBuilder<TProps, O, true, D> {
      return makeObject<TProps, O, true, D>(withNullable(state), copied)
    },
    default(value: unknown): ToolObjectBuilder<TProps, O, N, true> {
      return makeObject<TProps, O, N, true>(withDefault(state, node, value), copied)
    },
  }) as unknown as ToolObjectBuilder<TProps, O, N, D>
}

function makeRecord<
  TVal extends ToolSchemaNode,
  O extends boolean,
  N extends boolean,
  D extends boolean,
>(state: ModifierState, value: TVal): ToolRecordBuilder<TVal, O, N, D> {
  assertRecordValue(value)
  const fields = Object.freeze({
    kind: 'record' as const,
    ...modifierFields<unknown>(state),
    value,
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolRecordBuilder<TVal, O, N, D> {
      return makeRecord<TVal, O, N, D>(withDescription(state, description), value)
    },
    optional(): ToolRecordBuilder<TVal, true, N, D> {
      return makeRecord<TVal, true, N, D>(withOptional(state), value)
    },
    nullable(): ToolRecordBuilder<TVal, O, true, D> {
      return makeRecord<TVal, O, true, D>(withNullable(state), value)
    },
    default(value_: unknown): ToolRecordBuilder<TVal, O, N, true> {
      return makeRecord<TVal, O, N, true>(withDefault(state, node, value_), value)
    },
  }) as unknown as ToolRecordBuilder<TVal, O, N, D>
}

function makeUnion<
  TVariants extends readonly [ToolSchemaNode, ToolSchemaNode, ...ToolSchemaNode[]],
  O extends boolean,
  N extends boolean,
  D extends boolean,
>(state: ModifierState, variants: TVariants): ToolUnionBuilder<TVariants, O, N, D> {
  if (!Array.isArray(variants) || variants.length < 2) {
    throw new InvariantError('t.union(): at least two variants are required')
  }
  const copied: ToolSchemaNode[] = []
  for (let index = 0; index < variants.length; index++) {
    const variant = variants[index]
    assertSchemaChild(variant, `t.union() variant ${index}`)
    copied.push(variant)
  }
  const frozen = Object.freeze(copied) as unknown as TVariants
  const fields = Object.freeze({
    kind: 'union' as const,
    ...modifierFields<unknown>(state),
    variants: frozen,
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolUnionBuilder<TVariants, O, N, D> {
      return makeUnion<TVariants, O, N, D>(withDescription(state, description), frozen)
    },
    optional(): ToolUnionBuilder<TVariants, true, N, D> {
      return makeUnion<TVariants, true, N, D>(withOptional(state), frozen)
    },
    nullable(): ToolUnionBuilder<TVariants, O, true, D> {
      return makeUnion<TVariants, O, true, D>(withNullable(state), frozen)
    },
    default(value: unknown): ToolUnionBuilder<TVariants, O, N, true> {
      return makeUnion<TVariants, O, N, true>(withDefault(state, node, value), frozen)
    },
  }) as unknown as ToolUnionBuilder<TVariants, O, N, D>
}

function makeDiscriminatedUnion<
  D extends string,
  TVariants extends readonly [
    DiscriminatedVariantObject<D>,
    DiscriminatedVariantObject<D>,
    ...DiscriminatedVariantObject<D>[],
  ],
  O extends boolean,
  N extends boolean,
  H extends boolean,
>(
  state: ModifierState,
  discriminator: D,
  variants: TVariants,
): ToolDiscriminatedUnionBuilder<D, TVariants, O, N, H> {
  if (typeof discriminator !== 'string' || discriminator.length === 0) {
    throw new InvariantError('t.discriminatedUnion(): discriminator must be a non-empty string')
  }
  if (!discriminator.isWellFormed()) {
    throw new InvariantError('t.discriminatedUnion(): discriminator must be well-formed Unicode')
  }
  assertDiscriminatedVariants(discriminator, variants)
  const frozen = Object.freeze([...variants]) as unknown as TVariants
  const fields = Object.freeze({
    kind: 'discriminated_union' as const,
    ...modifierFields<unknown>(state),
    discriminator,
    variants: frozen,
  })
  const node = fields as unknown as ToolSchemaNode
  return Object.freeze({
    ...fields,
    desc(description: string): ToolDiscriminatedUnionBuilder<D, TVariants, O, N, H> {
      return makeDiscriminatedUnion<D, TVariants, O, N, H>(
        withDescription(state, description),
        discriminator,
        frozen,
      )
    },
    optional(): ToolDiscriminatedUnionBuilder<D, TVariants, true, N, H> {
      return makeDiscriminatedUnion<D, TVariants, true, N, H>(
        withOptional(state),
        discriminator,
        frozen,
      )
    },
    nullable(): ToolDiscriminatedUnionBuilder<D, TVariants, O, true, H> {
      return makeDiscriminatedUnion<D, TVariants, O, true, H>(
        withNullable(state),
        discriminator,
        frozen,
      )
    },
    default(value: unknown): ToolDiscriminatedUnionBuilder<D, TVariants, O, N, true> {
      return makeDiscriminatedUnion<D, TVariants, O, N, true>(
        withDefault(state, node, value),
        discriminator,
        frozen,
      )
    },
  }) as unknown as ToolDiscriminatedUnionBuilder<D, TVariants, O, N, H>
}

/* -------------------------------------------------------------------------- */
/*                             Public constructors                            */
/* -------------------------------------------------------------------------- */

/** Fluent, immutable tool schema constructors. */
export const t: ToolBuilder = Object.freeze({
  str: (): ToolStringBuilder<false, false, false> =>
    makeString<false, false, false>(INITIAL_STATE, undefined, undefined),
  num: (): ToolNumberBuilder<false, false, false> =>
    makeNumber<false, false, false>(INITIAL_STATE, false, undefined, undefined),
  int: (): ToolNumberBuilder<false, false, false> =>
    makeNumber<false, false, false>(INITIAL_STATE, true, undefined, undefined),
  bool: (): ToolBooleanBuilder<false, false, false> =>
    makeBoolean<false, false, false>(INITIAL_STATE),
  literal: <const V extends ToolScalarValue>(
    value: V,
  ): ToolLiteralBuilder<V, false, false, false> =>
    makeLiteral<V, false, false, false>(INITIAL_STATE, value),
  enum: <const TValues extends readonly [string, ...string[]]>(
    values: TValues,
  ): ToolEnumBuilder<TValues, false, false, false> =>
    makeEnum<TValues, false, false, false>(INITIAL_STATE, values),
  arr: <TItem extends ToolSchemaNode>(item: TItem): ToolArrayBuilder<TItem, false, false, false> =>
    makeArray<TItem, false, false, false>(INITIAL_STATE, item, undefined, undefined),
  obj: <TProps extends Readonly<Record<string, ToolSchemaNode>>>(
    properties: TProps,
  ): ToolObjectBuilder<TProps, false, false, false> =>
    makeObject<TProps, false, false, false>(INITIAL_STATE, properties),
  record: <TVal extends ToolSchemaNode>(
    value: TVal,
  ): ToolRecordBuilder<TVal, false, false, false> =>
    makeRecord<TVal, false, false, false>(INITIAL_STATE, value),
  union: <const TVariants extends readonly [ToolSchemaNode, ToolSchemaNode, ...ToolSchemaNode[]]>(
    variants: TVariants,
  ): ToolUnionBuilder<TVariants, false, false, false> =>
    makeUnion<TVariants, false, false, false>(INITIAL_STATE, variants),
  discriminatedUnion: <
    const D extends string,
    const TVariants extends readonly [
      DiscriminatedVariantObject<D>,
      DiscriminatedVariantObject<D>,
      ...DiscriminatedVariantObject<D>[],
    ],
  >(
    discriminator: D,
    variants: TVariants,
  ): ToolDiscriminatedUnionBuilder<D, TVariants, false, false, false> =>
    makeDiscriminatedUnion<D, TVariants, false, false, false>(
      INITIAL_STATE,
      discriminator,
      variants,
    ),
})
