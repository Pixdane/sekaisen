import type { Path } from '@sekaisen/plugin-world'
import { assertIdentifier, cloneSchema, SchemaFailure } from './builders.ts'
import type {
  AnyReadableLens,
  ContainerPresence,
  CustomFieldLens,
  EntryLensFor,
  FieldLens,
  LeafSchemaNode,
  LensFor,
  MapLens,
  MapSchemaNode,
  PlainLeafNode,
  SchemaNode,
  SchemaNodeOf,
  StructLens,
  StructSchemaNode,
  UntypedCustomFieldLens,
} from './types.ts'

/** One navigation step from a root schema path to a lens target. */
export type LensStep = { readonly kind: 'field' | 'entry'; readonly key: string }

/** Any lens carrying internal route metadata. */
export type AnyLens = StructLens | MapLens | FieldLens | CustomFieldLens | UntypedCustomFieldLens

type LensMeta = { readonly root: Path; readonly route: readonly LensStep[] }

const lensMeta = new WeakMap<object, LensMeta>()

function registerLens<T extends object>(lens: T, meta: LensMeta): T {
  lensMeta.set(lens, {
    root: Object.freeze([...meta.root]),
    route: Object.freeze([...meta.route]),
  })
  return Object.freeze(lens) as unknown as T
}

/** Root schema path this lens was registered under (empty route lens => its own path). */
export function getLensRoot(lens: { readonly path: Path }): Path {
  return lensMeta.get(lens)?.root ?? lens.path
}

/** Field/entry navigation steps from {@link getLensRoot} down to this lens. */
export function getLensRoute(lens: { readonly path: Path }): readonly LensStep[] {
  return lensMeta.get(lens)?.route ?? []
}

function makeFieldLens<S extends LeafSchemaNode>(
  path: Path,
  schema: S,
  root: Path,
  route: readonly LensStep[],
): FieldLens<S> {
  return registerLens(
    {
      opticKind: 'field',
      path: Object.freeze([...path]),
      schema,
    },
    { root, route },
  )
}

function makeScopedFields(keys: readonly string[]): ReadonlySet<string> {
  const values = new Set(keys)
  let facade!: ReadonlySet<string>
  const impl: ReadonlySet<string> = {
    size: values.size,
    has(value) {
      return values.has(value)
    },
    entries() {
      return values.entries()
    },
    keys() {
      return values.keys()
    },
    values() {
      return values.values()
    },
    forEach(callback, thisArg) {
      for (const value of values) callback.call(thisArg, value, value, facade)
    },
    [Symbol.iterator]() {
      return values.values()
    },
  }
  facade = Object.freeze(impl) as unknown as ReadonlySet<string>
  return facade
}

function makeStructLens<
  TFields extends Readonly<Record<string, SchemaNode>>,
  TAllowCustom extends boolean,
  TPresence extends ContainerPresence,
>(
  path: Path,
  schema: StructSchemaNode<TFields, TAllowCustom, TPresence>,
  root: Path,
  route: readonly LensStep[],
): StructLens<TFields, TAllowCustom, TPresence> {
  const lensPath = Object.freeze([...path])
  const children: Record<string, AnyLens> = Object.create(null)
  for (const key of Object.keys(schema.fields)) {
    const childSchema = schema.fields[key]
    if (childSchema === undefined) continue
    children[key] = makeLensInternal([...lensPath, key], childSchema, root, [
      ...route,
      { kind: 'field', key },
    ])
  }
  Object.freeze(children)

  let self!: StructLens<TFields, TAllowCustom, TPresence>
  const lens: StructLens<TFields, TAllowCustom, TPresence> = {
    opticKind: 'struct' as const,
    path: lensPath,
    schema,
    scopedFields: makeScopedFields(Object.keys(schema.fields)),
    $: children as unknown as { readonly [K in keyof TFields]: LensFor<TFields[K]> },
    field<K extends keyof TFields & string>(key: K): LensFor<TFields[K]> {
      const child = Object.hasOwn(children, key) ? children[key] : undefined
      if (child === undefined) {
        throw new SchemaFailure({
          kind: 'validation_failed',
          path: [...lensPath, key],
          reason: 'type_mismatch',
          detail: `unknown struct field ${JSON.stringify(key)}`,
        })
      }
      return child as unknown as LensFor<TFields[K]>
    },
    custom<TLeaf extends LeafSchemaNode>(
      customKey: string,
      expectedSchema: TLeaf,
    ): CustomFieldLens<PlainLeafNode<TLeaf>> {
      return makeCustomLens(self as unknown as StructLens, customKey, expectedSchema)
    },
    customUntyped(customKey: string): UntypedCustomFieldLens {
      return makeUntypedCustomLens(self as unknown as StructLens, customKey)
    },
  }
  self = registerLens(lens, { root, route })
  return self
}

function makeMapLens<TValueSchema extends SchemaNode, TPresence extends ContainerPresence>(
  path: Path,
  schema: MapSchemaNode<TValueSchema, TPresence>,
  root: Path,
  route: readonly LensStep[],
): MapLens<TValueSchema, TPresence> {
  const lensPath = Object.freeze([...path])
  const lens: MapLens<TValueSchema, TPresence> = {
    opticKind: 'map',
    path: lensPath,
    schema,
    at(instanceId: string): EntryLensFor<TValueSchema> {
      assertIdentifier(instanceId)
      return makeEntryLens(lensPath, schema.valueSchema, instanceId, root, [
        ...route,
        { kind: 'entry', key: instanceId },
      ])
    },
  }
  return registerLens(lens, { root, route })
}

function makeEntryLens<S extends SchemaNode>(
  mapPath: Path,
  valueSchema: S,
  instanceId: string,
  root: Path,
  route: readonly LensStep[],
): EntryLensFor<S> {
  const entryPath = Object.freeze([...mapPath, instanceId])
  switch (valueSchema.nodeKind) {
    case 'struct':
      return makeStructLens(
        entryPath,
        { ...valueSchema, presence: { mode: 'optional' } },
        root,
        route,
      ) as unknown as EntryLensFor<S>
    case 'map':
      return makeMapLens(
        entryPath,
        { ...valueSchema, presence: { mode: 'optional' } },
        root,
        route,
      ) as unknown as EntryLensFor<S>
    case 'leaf':
      return makeFieldLens(
        entryPath,
        { ...valueSchema, presence: { mode: 'optional' } },
        root,
        route,
      ) as unknown as EntryLensFor<S>
  }
  throw new SchemaFailure({
    kind: 'validation_failed',
    path: entryPath,
    reason: 'type_mismatch',
    detail: 'unsupported map value schema',
  })
}

function makeLensInternal(
  path: Path,
  schema: SchemaNode,
  root: Path,
  route: readonly LensStep[],
): AnyLens {
  switch (schema.nodeKind) {
    case 'struct':
      return makeStructLens(path, schema, root, route)
    case 'map':
      return makeMapLens(path, schema, root, route)
    case 'leaf':
      return makeFieldLens(path, schema, root, route)
  }
  throw new SchemaFailure({
    kind: 'validation_failed',
    path,
    reason: 'type_mismatch',
    detail: 'unsupported schema node',
  })
}

/**
 * Create the lens matching `schema` at `path`. `rootPath`/`route` are supplied
 * by internal child constructors and by `augment` for scoped merged schemas.
 * The first overload accepts an already-normalized AST for an explicit schema
 * type; the second infers from a plain AST value.
 */
export function makeLens<S extends SchemaNode>(
  path: Path,
  schema: SchemaNodeOf<S>,
  rootPath?: Path,
  route?: readonly LensStep[],
): LensFor<S>
export function makeLens<T extends SchemaNode>(
  path: Path,
  schema: T,
  rootPath?: Path,
  route?: readonly LensStep[],
): LensFor<T>
export function makeLens(
  path: Path,
  schema: SchemaNode,
  rootPath: Path = path,
  route: readonly LensStep[] = [],
): LensFor<SchemaNode> {
  return makeLensInternal(path, schema, rootPath, route) as LensFor<SchemaNode>
}

/** Create a typed instance-specific custom-key lens. */
export function makeCustomLens<TLeaf extends LeafSchemaNode>(
  parent: StructLens,
  customKey: string,
  schema: TLeaf,
): CustomFieldLens<PlainLeafNode<TLeaf>>
/** Create an untyped instance-specific custom-key lens. */
export function makeCustomLens(
  parent: StructLens,
  customKey: string,
  schema?: undefined,
): UntypedCustomFieldLens
export function makeCustomLens(
  parent: StructLens,
  customKey: string,
  schema?: LeafSchemaNode,
): CustomFieldLens | UntypedCustomFieldLens {
  assertIdentifier(customKey)
  if (Object.hasOwn(parent.schema.fields, customKey)) {
    throw new SchemaFailure({
      kind: 'validation_failed',
      path: parent.path,
      reason: 'custom_key_shadows_struct_field',
      detail: `custom key ${JSON.stringify(customKey)} shadows a declared field`,
    })
  }
  const route = getLensRoute(parent)
  if (schema === undefined) {
    return makeUntypedCustomLens(parent, customKey)
  }
  // cloneSchema preserves the leaf kind of the typed evidence, but still rejects forged input.
  const expected = cloneSchema(schema) as LeafSchemaNode
  if (expected.nodeKind !== 'leaf') {
    throw new SchemaFailure({
      kind: 'validation_failed',
      path: [...parent.path, '$custom', customKey],
      reason: 'type_mismatch',
      detail: 'custom key evidence must be a leaf schema',
    })
  }
  const lens: CustomFieldLens<LeafSchemaNode> = {
    opticKind: 'custom',
    instancePath: parent.path,
    customKey,
    path: Object.freeze([...parent.path, '$custom', customKey]),
    expectedSchema: expected,
  }
  return registerLens(lens, { root: getLensRoot(parent), route })
}

/** Create an untyped custom-key lens (raw read / delete). */
export function makeUntypedCustomLens(
  parent: StructLens,
  customKey: string,
): UntypedCustomFieldLens {
  assertIdentifier(customKey)
  const lens: UntypedCustomFieldLens = {
    opticKind: 'custom_untyped',
    instancePath: parent.path,
    customKey,
    path: Object.freeze([...parent.path, '$custom', customKey]),
  }
  return registerLens(lens, { root: getLensRoot(parent), route: getLensRoute(parent) })
}

/** Type guard for readable lenses accepted by `get`. */
export function isReadableLens(lens: AnyLens): lens is AnyReadableLens {
  return (
    lens.opticKind === 'struct' ||
    lens.opticKind === 'map' ||
    lens.opticKind === 'field' ||
    lens.opticKind === 'custom'
  )
}
