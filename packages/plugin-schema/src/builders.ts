import type { Path, StateRef, Value } from '@sekaisen/plugin-world'
import type {
  ContainerPresence,
  DefaultStructPresence,
  LeafBuilder,
  LeafPresence,
  LeafValueKind,
  LeafValueTypeMap,
  MapBuilder,
  SchemaBuilders,
  SchemaError,
  SchemaFieldsOf,
  SchemaMetaMap,
  SchemaNode,
  SchemaNodeOf,
  StructBuilder,
} from './types.ts'

/* -------------------------------------------------------------------------- */
/*                                  Failure                                  */
/* -------------------------------------------------------------------------- */

function describeSchemaError(error: SchemaError): string {
  switch (error.kind) {
    case 'invalid_schema_identifier':
      return `invalid schema identifier ${JSON.stringify(error.identifier)}: ${error.reason}`
    case 'schema_conflict':
      return `schema conflict at ${JSON.stringify(error.path)}: ${error.reason}`
    case 'validation_failed':
      return `validation failed at ${JSON.stringify(error.path)}: ${error.reason} (${error.detail})`
    case 'schema_type_mismatch':
      return `schema type mismatch at ${JSON.stringify(error.path)}: expected ${error.expectedKind}, got ${error.actualKind}`
    case 'corrupted_instance_data':
      return `corrupted instance data at ${JSON.stringify(error.path)}: ${error.reason}`
    case 'message_decode_error':
      return `message decode error: ${error.reason}`
    case 'unmigrated_required_field':
      return `unmigrated required field at ${JSON.stringify(error.path)}`
    case 'schema_drift_requires_sync':
      return `schema drift requires sync: ${error.reason}`
    case 'incompatible_schema_drift':
      return `incompatible schema drift: ${error.incompatibilities.length} incompatibilities`
    case 'validator_rejected':
      return `validator ${error.validatorName} rejected ${JSON.stringify(error.path)}: ${error.reason}`
    case 'world_error':
      return `world error: ${error.error.kind}`
    default:
      return 'schema failure'
  }
}

/** Expected schema-layer failure; carries the structured {@link SchemaError}. */
export class SchemaFailure extends Error {
  readonly error: SchemaError

  constructor(error: SchemaError) {
    super(describeSchemaError(error))
    this.name = 'SchemaFailure'
    this.error = error
  }
}

function failValidation(
  path: Path,
  reason: Extract<SchemaError, { kind: 'validation_failed' }>['reason'],
  detail: string,
): never {
  throw new SchemaFailure({ kind: 'validation_failed', path, reason, detail })
}

/* -------------------------------------------------------------------------- */
/*                                Validation                                 */
/* -------------------------------------------------------------------------- */

const LEAF_VALUE_KINDS: Readonly<Record<string, true>> = {
  bool: true,
  num: true,
  str: true,
  bytes: true,
  ref: true,
  'list:bool': true,
  'list:num': true,
  'list:str': true,
  'list:bytes': true,
}

const LIST_ITEM_KINDS: Readonly<Record<string, true>> = {
  bool: true,
  num: true,
  str: true,
  bytes: true,
}

/** Validate a user identifier (non-empty, well-formed Unicode, no `$` prefix). */
export function assertIdentifier(identifier: string): void {
  if (typeof identifier !== 'string') {
    throw new SchemaFailure({
      kind: 'invalid_schema_identifier',
      identifier: String(identifier),
      reason: 'identifier must be a string',
    })
  }
  if (identifier.length === 0) {
    throw new SchemaFailure({
      kind: 'invalid_schema_identifier',
      identifier,
      reason: 'identifier must not be empty',
    })
  }
  if (!identifier.isWellFormed()) {
    throw new SchemaFailure({
      kind: 'invalid_schema_identifier',
      identifier,
      reason: 'identifier must be well-formed Unicode',
    })
  }
  if (identifier.startsWith('$')) {
    throw new SchemaFailure({
      kind: 'invalid_schema_identifier',
      identifier,
      reason: "identifier must not start with the reserved '$' prefix",
    })
  }
}

/** Validate an arbitrary `Value` (metadata, defaults, message payloads). */
export function assertSchemaValue(value: unknown, path: Path = []): asserts value is Value {
  if (value === null) return
  switch (typeof value) {
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) failValidation(path, 'type_mismatch', 'numbers must be finite')
      return
    case 'string':
      if (!value.isWellFormed()) {
        failValidation(path, 'type_mismatch', 'strings must be well-formed Unicode')
      }
      return
    case 'object':
      if (value instanceof Uint8Array) return
      if (Array.isArray(value)) {
        for (const item of value) {
          assertScalarValue(item, path)
        }
        return
      }
      failValidation(path, 'type_mismatch', 'objects are not schema values')
      return
    default:
      failValidation(path, 'type_mismatch', `unsupported value type: ${typeof value}`)
  }
}

function assertScalarValue(value: unknown, path: Path): void {
  if (value === null) return
  switch (typeof value) {
    case 'boolean':
      return
    case 'number':
      if (!Number.isFinite(value)) failValidation(path, 'type_mismatch', 'numbers must be finite')
      return
    case 'string':
      if (!value.isWellFormed()) {
        failValidation(path, 'type_mismatch', 'strings must be well-formed Unicode')
      }
      return
    case 'object':
      if (value instanceof Uint8Array) return
      failValidation(path, 'type_mismatch', 'nested lists are not schema values')
      return
    default:
      failValidation(path, 'type_mismatch', `unsupported scalar type: ${typeof value}`)
  }
}

/** Validate a leaf value against its `valueKind`. */
export function assertLeafValue(
  kind: LeafValueKind,
  value: unknown,
  path: Path = [],
): asserts value is Value | StateRef {
  if (kind === 'ref') {
    if (!isStateRef(value)) {
      failValidation(path, 'type_mismatch', 'expected a StateRef')
    }
    return
  }
  if (kind.startsWith('list:')) {
    if (!Array.isArray(value)) {
      failValidation(path, 'type_mismatch', `expected an array for ${kind}`)
    }
    const itemKind = kind.slice(5)
    for (const item of value) {
      assertScalarKind(itemKind, item, path)
    }
    return
  }
  assertScalarKind(kind, value, path)
}

function assertScalarKind(kind: string, value: unknown, path: Path): void {
  switch (kind) {
    case 'bool':
      if (typeof value !== 'boolean') {
        failValidation(path, 'type_mismatch', 'expected a boolean')
      }
      return
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        failValidation(path, 'type_mismatch', 'expected a finite number')
      }
      return
    case 'str':
      if (typeof value !== 'string' || !value.isWellFormed()) {
        failValidation(path, 'type_mismatch', 'expected a well-formed string')
      }
      return
    case 'bytes':
      if (!(value instanceof Uint8Array)) {
        failValidation(path, 'type_mismatch', 'expected a Uint8Array')
      }
      return
    default:
      failValidation(path, 'type_mismatch', `unsupported leaf kind: ${kind}`)
  }
}

/** Runtime tag guard for `StateRef`. */
export function isStateRef(value: unknown): value is StateRef {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return false
  }
  if (
    !Object.hasOwn(value, 'commitId') ||
    !('commitId' in value) ||
    typeof value.commitId !== 'string'
  )
    return false
  if (!Object.hasOwn(value, 'path') || !('path' in value) || !Array.isArray(value.path))
    return false
  return true
}

function assertMetaMap(meta: unknown): asserts meta is SchemaMetaMap {
  if (
    typeof meta !== 'object' ||
    meta === null ||
    Array.isArray(meta) ||
    meta instanceof Uint8Array
  ) {
    failValidation([], 'type_mismatch', 'metadata must be a plain object')
  }
  for (const [key, value] of Object.entries(meta)) {
    if (typeof key !== 'string' || key.length === 0 || !key.isWellFormed()) {
      failValidation([], 'type_mismatch', 'metadata keys must be non-empty well-formed strings')
    }
    assertSchemaValue(value)
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Cloning                                  */
/* -------------------------------------------------------------------------- */

function clonePath(path: Path): Path {
  const out: string[] = []
  for (const segment of path) {
    if (typeof segment !== 'string' || segment.length === 0 || !segment.isWellFormed()) {
      failValidation(
        [],
        'type_mismatch',
        'StateRef paths must contain non-empty well-formed segments',
      )
    }
    out.push(segment)
  }
  return Object.freeze(out)
}

/** Deep-own a `StateRef`. */
export function cloneStateRef(ref: StateRef): StateRef {
  if (!isStateRef(ref)) failValidation([], 'type_mismatch', 'expected a StateRef')
  if (
    typeof ref.commitId !== 'string' ||
    ref.commitId.length === 0 ||
    !ref.commitId.isWellFormed()
  ) {
    failValidation([], 'type_mismatch', 'StateRef commitId must be a non-empty well-formed string')
  }
  return Object.freeze({ commitId: ref.commitId, path: clonePath(ref.path) })
}

function cloneScalar(value: unknown): Value {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
      return value
    case 'number':
      return value === 0 ? 0 : value
    case 'string':
      return value
    case 'object':
      if (value instanceof Uint8Array) return new Uint8Array(value)
      break
  }
  return failValidation([], 'type_mismatch', 'invalid scalar value')
}

/** Deep-own an arbitrary `Value`. */
export function cloneSchemaValue(value: Value): Value {
  assertSchemaValue(value)
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneScalar(item))) as Value
  }
  return cloneScalar(value)
}

/** Deep-own a leaf value against its kind. */
export function cloneLeafValue(
  kind: LeafValueKind,
  value: unknown,
  path: Path = [],
): Value | StateRef {
  assertLeafValue(kind, value, path)
  if (kind === 'ref') return cloneStateRef(value as StateRef)
  return cloneSchemaValue(value as Value)
}

/** Deep-own a metadata dictionary. */
export function cloneSchemaMetadata(meta: SchemaMetaMap): SchemaMetaMap {
  assertMetaMap(meta)
  const out: Record<string, Value> = Object.create(null)
  for (const [key, value] of Object.entries(meta)) {
    out[key] = cloneSchemaValue(value)
  }
  return Object.freeze(out)
}

function cloneContainerPresence(
  presence: ContainerPresence | undefined,
  path: Path,
): ContainerPresence {
  if (presence === undefined) return { mode: 'required' }
  if (typeof presence !== 'object' || presence === null) {
    failValidation(path, 'type_mismatch', 'presence must be an object')
  }
  const mode = presence.mode
  if (mode !== 'required' && mode !== 'defaulted' && mode !== 'optional') {
    failValidation(path, 'type_mismatch', `invalid presence mode: ${String(mode)}`)
  }
  return Object.freeze({ mode })
}

function cloneLeafPresence(
  presence: LeafPresence | undefined,
  kind: LeafValueKind,
  path: Path,
): LeafPresence {
  if (presence === undefined) return { mode: 'required' }
  if (typeof presence !== 'object' || presence === null) {
    failValidation(path, 'type_mismatch', 'presence must be an object')
  }
  const mode = presence.mode
  if (mode === 'required' || mode === 'optional') return Object.freeze({ mode })
  if (mode !== 'defaulted') {
    failValidation(path, 'type_mismatch', `invalid leaf presence mode: ${String(mode)}`)
  }
  if (!('defaultValue' in presence) || presence.defaultValue === undefined) {
    failValidation(path, 'type_mismatch', 'defaulted presence requires defaultValue')
  }
  return Object.freeze({
    mode: 'defaulted',
    defaultValue: cloneLeafValue(kind, presence.defaultValue, path),
  })
}

function cloneDescription(description: unknown, path: Path): string {
  if (description === undefined) return ''
  if (typeof description !== 'string' || !description.isWellFormed()) {
    failValidation(path, 'type_mismatch', 'description must be a well-formed string')
  }
  return description
}

function cloneFields(
  fields: Readonly<Record<string, SchemaNode>>,
  path: Path,
  seen: Set<object> = new Set(),
): Readonly<Record<string, SchemaNode>> {
  if (
    typeof fields !== 'object' ||
    fields === null ||
    Array.isArray(fields) ||
    fields instanceof Uint8Array
  ) {
    failValidation(path, 'type_mismatch', 'struct fields must be a plain object')
  }
  const out: Record<string, SchemaNode> = Object.create(null)
  for (const [key, value] of Object.entries(fields)) {
    assertIdentifier(key)
    out[key] = cloneNode(value, [...path, key], seen)
  }
  return Object.freeze(out)
}

function inferStructPresence(fields: Readonly<Record<string, SchemaNode>>): ContainerPresence {
  for (const field of Object.values(fields)) {
    if (field.presence.mode === 'required') return { mode: 'required' }
  }
  return { mode: 'defaulted' }
}

function cloneNode(node: SchemaNode, path: Path, seen: Set<object>): SchemaNode {
  if (typeof node !== 'object' || node === null) {
    failValidation(path, 'type_mismatch', 'schema node must be an object')
  }
  if (seen.has(node)) {
    failValidation(path, 'type_mismatch', 'schema nodes must not be cyclic')
  }
  seen.add(node)
  try {
    const raw = node as unknown as Record<string, unknown>
    switch (raw.nodeKind) {
      case 'leaf': {
        const valueKind = raw.valueKind
        if (typeof valueKind !== 'string' || LEAF_VALUE_KINDS[valueKind] !== true) {
          failValidation(path, 'type_mismatch', `invalid leaf valueKind: ${String(valueKind)}`)
        }
        const kind = valueKind as LeafValueKind
        return Object.freeze({
          nodeKind: 'leaf' as const,
          valueKind: kind,
          presence: cloneLeafPresence(raw.presence as LeafPresence | undefined, kind, path),
          description: cloneDescription(raw.description, path),
          metadata:
            raw.metadata === undefined
              ? EMPTY_META
              : cloneSchemaMetadata(raw.metadata as SchemaMetaMap),
        })
      }
      case 'struct': {
        const fields = cloneFields(raw.fields as Readonly<Record<string, SchemaNode>>, path, seen)
        if (raw.allowCustom !== undefined && typeof raw.allowCustom !== 'boolean') {
          failValidation(path, 'type_mismatch', 'allowCustom must be a boolean')
        }
        const presence =
          raw.presence === undefined
            ? inferStructPresence(fields)
            : cloneContainerPresence(raw.presence as ContainerPresence, path)
        if (presence.mode === 'defaulted') {
          for (const [key, child] of Object.entries(fields)) {
            if (child.presence.mode === 'required') {
              failValidation(
                [...path, key],
                'type_mismatch',
                'a defaulted struct cannot contain required fields',
              )
            }
          }
        }
        return Object.freeze({
          nodeKind: 'struct' as const,
          fields,
          allowCustom: raw.allowCustom === true,
          presence,
          description: cloneDescription(raw.description, path),
          metadata:
            raw.metadata === undefined
              ? EMPTY_META
              : cloneSchemaMetadata(raw.metadata as SchemaMetaMap),
        })
      }
      case 'map': {
        const valueSchema = raw.valueSchema
        if (typeof valueSchema !== 'object' || valueSchema === null) {
          failValidation(path, 'type_mismatch', 'map valueSchema must be a schema node')
        }
        return Object.freeze({
          nodeKind: 'map' as const,
          valueSchema: cloneNode(valueSchema as SchemaNode, path, seen),
          presence:
            raw.presence === undefined
              ? { mode: 'defaulted' as const }
              : cloneContainerPresence(raw.presence as ContainerPresence, path),
          description: cloneDescription(raw.description, path),
          metadata:
            raw.metadata === undefined
              ? EMPTY_META
              : cloneSchemaMetadata(raw.metadata as SchemaMetaMap),
        })
      }
      default:
        failValidation(path, 'type_mismatch', `invalid schema nodeKind: ${String(raw.nodeKind)}`)
    }
  } finally {
    seen.delete(node)
  }
  failValidation(path, 'type_mismatch', 'unreachable schema node')
}

const EMPTY_META: SchemaMetaMap = Object.freeze(Object.create(null) as Record<string, Value>)

function mergeMetadata(base: SchemaMetaMap, extra: SchemaMetaMap): SchemaMetaMap {
  const out: Record<string, Value> = Object.create(null)
  for (const [key, value] of Object.entries(base)) out[key] = value
  for (const [key, value] of Object.entries(cloneSchemaMetadata(extra))) out[key] = value
  return Object.freeze(out)
}

/**
 * Validate and deep-own a schema AST. Fluent builder methods are not part of
 * the returned value, so the return type exposes the plain AST shape.
 * Throws {@link SchemaFailure} for every structural or identifier violation.
 */
export function cloneSchema<S extends SchemaNode>(node: S): SchemaNodeOf<S> {
  const cloned = cloneNode(node, [], new Set())
  return cloned as SchemaNodeOf<S>
}

/* -------------------------------------------------------------------------- */
/*                                Builders                                  */
/* -------------------------------------------------------------------------- */

type RequiredPresence = { readonly mode: 'required' }

class LeafBuilderImpl<
  TKind extends LeafValueKind = LeafValueKind,
  TPresence extends LeafPresence = RequiredPresence,
> implements LeafBuilder<TKind, TPresence>
{
  readonly nodeKind = 'leaf' as const
  readonly valueKind: TKind
  readonly presence: TPresence
  readonly description: string
  readonly metadata: SchemaMetaMap

  constructor(valueKind: TKind, presence: TPresence, description: string, metadata: SchemaMetaMap) {
    this.valueKind = valueKind
    this.presence = presence
    this.description = description
    this.metadata = metadata
    Object.freeze(this)
  }

  default(
    defaultValue: LeafValueTypeMap[TKind],
  ): LeafBuilder<
    TKind,
    { readonly mode: 'defaulted'; readonly defaultValue: LeafValueTypeMap[TKind] }
  > {
    const cloned = cloneLeafValue(this.valueKind, defaultValue)
    return new LeafBuilderImpl<
      TKind,
      { readonly mode: 'defaulted'; readonly defaultValue: LeafValueTypeMap[TKind] }
    >(
      this.valueKind,
      { mode: 'defaulted', defaultValue: cloned as LeafValueTypeMap[TKind] },
      this.description,
      this.metadata,
    )
  }

  optional(): LeafBuilder<TKind, { readonly mode: 'optional' }> {
    return new LeafBuilderImpl<TKind, { readonly mode: 'optional' }>(
      this.valueKind,
      { mode: 'optional' },
      this.description,
      this.metadata,
    )
  }

  desc(description: string): LeafBuilder<TKind, TPresence> {
    return new LeafBuilderImpl<TKind, TPresence>(
      this.valueKind,
      this.presence,
      cloneDescription(description, []),
      this.metadata,
    )
  }

  meta(meta: SchemaMetaMap): LeafBuilder<TKind, TPresence> {
    return new LeafBuilderImpl<TKind, TPresence>(
      this.valueKind,
      this.presence,
      this.description,
      mergeMetadata(this.metadata, meta),
    )
  }
}

class StructBuilderImpl<
  TFields extends Readonly<Record<string, SchemaNode>> = Readonly<Record<string, SchemaNode>>,
  TAllowCustom extends boolean = false,
  TPresence extends ContainerPresence = DefaultStructPresence<TFields>,
> implements StructBuilder<TFields, TAllowCustom, TPresence>
{
  readonly nodeKind = 'struct' as const
  readonly fields: TFields
  readonly allowCustom: TAllowCustom
  readonly presence: TPresence
  readonly description: string
  readonly metadata: SchemaMetaMap

  constructor(
    fields: TFields,
    allowCustom: TAllowCustom,
    presence: TPresence,
    description: string,
    metadata: SchemaMetaMap,
  ) {
    this.fields = fields
    this.allowCustom = allowCustom
    this.presence = presence
    this.description = description
    this.metadata = metadata
    Object.freeze(this)
  }

  extensible(): StructBuilder<TFields, true, TPresence> {
    return new StructBuilderImpl<TFields, true, TPresence>(
      this.fields,
      true,
      this.presence,
      this.description,
      this.metadata,
    )
  }

  optional(): StructBuilder<TFields, TAllowCustom, { readonly mode: 'optional' }> {
    return new StructBuilderImpl<TFields, TAllowCustom, { readonly mode: 'optional' }>(
      this.fields,
      this.allowCustom,
      { mode: 'optional' },
      this.description,
      this.metadata,
    )
  }

  desc(description: string): StructBuilder<TFields, TAllowCustom, TPresence> {
    return new StructBuilderImpl<TFields, TAllowCustom, TPresence>(
      this.fields,
      this.allowCustom,
      this.presence,
      cloneDescription(description, []),
      this.metadata,
    )
  }

  meta(meta: SchemaMetaMap): StructBuilder<TFields, TAllowCustom, TPresence> {
    return new StructBuilderImpl<TFields, TAllowCustom, TPresence>(
      this.fields,
      this.allowCustom,
      this.presence,
      this.description,
      mergeMetadata(this.metadata, meta),
    )
  }
}

class MapBuilderImpl<
  TValueSchema extends SchemaNode = SchemaNode,
  TPresence extends ContainerPresence = { readonly mode: 'defaulted' },
> implements MapBuilder<TValueSchema, TPresence>
{
  readonly nodeKind = 'map' as const
  readonly valueSchema: TValueSchema
  readonly presence: TPresence
  readonly description: string
  readonly metadata: SchemaMetaMap

  constructor(
    valueSchema: TValueSchema,
    presence: TPresence,
    description: string,
    metadata: SchemaMetaMap,
  ) {
    this.valueSchema = valueSchema
    this.presence = presence
    this.description = description
    this.metadata = metadata
    Object.freeze(this)
  }

  optional(): MapBuilder<TValueSchema, { readonly mode: 'optional' }> {
    return new MapBuilderImpl<TValueSchema, { readonly mode: 'optional' }>(
      this.valueSchema,
      { mode: 'optional' },
      this.description,
      this.metadata,
    )
  }

  desc(description: string): MapBuilder<TValueSchema, TPresence> {
    return new MapBuilderImpl<TValueSchema, TPresence>(
      this.valueSchema,
      this.presence,
      cloneDescription(description, []),
      this.metadata,
    )
  }

  meta(meta: SchemaMetaMap): MapBuilder<TValueSchema, TPresence> {
    return new MapBuilderImpl<TValueSchema, TPresence>(
      this.valueSchema,
      this.presence,
      this.description,
      mergeMetadata(this.metadata, meta),
    )
  }
}

function makeLeaf<TKind extends LeafValueKind>(kind: TKind): LeafBuilder<TKind, RequiredPresence> {
  return new LeafBuilderImpl<TKind, RequiredPresence>(kind, { mode: 'required' }, '', EMPTY_META)
}

/** Fluent schema builders. */
export const s: SchemaBuilders = Object.freeze({
  bool: () => makeLeaf('bool'),
  num: () => makeLeaf('num'),
  str: () => makeLeaf('str'),
  bytes: () => makeLeaf('bytes'),
  ref: () => makeLeaf('ref'),
  list<TItem extends 'bool' | 'num' | 'str' | 'bytes'>(
    itemKind: TItem,
  ): LeafBuilder<`list:${TItem}`> {
    if (typeof itemKind !== 'string' || LIST_ITEM_KINDS[itemKind] !== true) {
      failValidation([], 'type_mismatch', `invalid list item kind: ${String(itemKind)}`)
    }
    return makeLeaf(`list:${itemKind}`)
  },
  struct<TFields extends Readonly<Record<string, SchemaNode>>>(
    fields: TFields,
  ): StructBuilder<SchemaFieldsOf<TFields>, false, DefaultStructPresence<SchemaFieldsOf<TFields>>> {
    const cloned = cloneFields(fields, []) as unknown as SchemaFieldsOf<TFields>
    const presence = inferStructPresence(cloned) as unknown as DefaultStructPresence<
      SchemaFieldsOf<TFields>
    >
    return new StructBuilderImpl<
      SchemaFieldsOf<TFields>,
      false,
      DefaultStructPresence<SchemaFieldsOf<TFields>>
    >(cloned, false, presence, '', EMPTY_META)
  },
  map<TValueSchema extends SchemaNode>(
    valueSchema: TValueSchema,
  ): MapBuilder<SchemaNodeOf<TValueSchema>, { readonly mode: 'defaulted' }> {
    return new MapBuilderImpl<SchemaNodeOf<TValueSchema>, { readonly mode: 'defaulted' }>(
      cloneSchema(valueSchema),
      { mode: 'defaulted' },
      '',
      EMPTY_META,
    )
  },
})
