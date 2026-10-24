import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { assertIdentifier, cloneSchema, SchemaFailure } from './builders.ts'
import { validateLinkRegistration } from './links.ts'
import { makeMessagePrism } from './message.ts'
import { getLensRoot, getLensRoute, makeLens } from './optics.ts'
import type { Catalog, MutableCatalog } from './runtime.ts'
import { emptyCatalog, schemaAt } from './runtime.ts'
import type {
  CommitValidatorFn,
  ContainerPresence,
  LensFor,
  MessagePrism,
  MessageStructSchemaNode,
  SchemaFieldsOf,
  SchemaNode,
  SchemaNodeOf,
  StructLens,
} from './types.ts'

interface Augmentation {
  path: Path
  fields: Readonly<Record<string, SchemaNode>>
}
function replaceSchema(
  catalog: MutableCatalog,
  path: Path,
  transform: (node: SchemaNode) => SchemaNode,
): void {
  for (const [key, root] of catalog.roots) {
    if (!root.path.every((segment, i) => segment === path[i])) continue
    function apply(node: SchemaNode, depth: number): SchemaNode {
      if (depth === path.length) return transform(node)
      const field = path[depth]!
      if (node.nodeKind === 'map' && field === '*')
        return cloneSchema({ ...node, valueSchema: apply(node.valueSchema, depth + 1) })
      if (node.nodeKind === 'struct' && Object.hasOwn(node.fields, field))
        return cloneSchema({
          ...node,
          fields: { ...node.fields, [field]: apply(node.fields[field]!, depth + 1) },
        })
      throw new SchemaFailure({
        kind: 'schema_conflict',
        path,
        reason: 'augment_target_not_struct',
      })
    }
    catalog.roots.set(key, { path: root.path, schema: apply(root.schema, root.path.length) })
    return
  }
}

/**
 * Scoped Reader registrations behind `SchemaService`. Definitions,
 * augmentations, message kinds and validators follow the Cordis scope passed
 * to each registration call; this module never captures a context itself.
 *
 * Reader revisions change on registration and disposal only, never on
 * validator addition or removal.
 */
export class SchemaRegistry {
  private readonly roots = new Map<symbol, { path: Path; schema: SchemaNode }>()
  private readonly augmentations = new Map<symbol, Augmentation>()
  private readonly messages = new Map<symbol, { kind: string; schema: MessageStructSchemaNode }>()
  private readonly validatorSet = new Set<CommitValidatorFn>()
  /** Changes on Reader registration/disposal, never on validator registration. */
  readerRevision = Symbol()

  /** Build the current Reader catalog from cloned registrations. */
  catalog(): Catalog {
    const catalog = emptyCatalog()
    for (const root of this.roots.values())
      catalog.roots.set(encodePathKey(root.path), {
        path: root.path,
        schema: cloneSchema(root.schema),
      })
    for (const augmentation of this.augmentations.values()) {
      replaceSchema(catalog, augmentation.path, (node) => {
        if (node.nodeKind !== 'struct')
          throw new SchemaFailure({
            kind: 'schema_conflict',
            path: augmentation.path,
            reason: 'augment_target_not_struct',
          })
        for (const key of Object.keys(augmentation.fields))
          if (Object.hasOwn(node.fields, key))
            throw new SchemaFailure({
              kind: 'schema_conflict',
              path: [...augmentation.path, key],
              reason: 'field_name_collision',
            })
        return cloneSchema({ ...node, fields: { ...node.fields, ...augmentation.fields } })
      })
    }
    for (const { kind, schema } of this.messages.values()) catalog.messages.set(kind, schema)
    return catalog
  }

  /**
   * Insertion-ordered snapshot of active business rules for one commit/sync.
   */
  validators(): readonly CommitValidatorFn[] {
    return [...this.validatorSet]
  }

  /**
   * Register a copied Reader root. A root path must be non-empty, use valid
   * identifiers and not overlap another active root. Registration does not
   * persist a commit; scope disposal removes the definition without touching
   * historical Writer data.
   */
  define<S extends SchemaNode>(ctx: Context, path: Path, node: S): LensFor<S> {
    if (!path.length) assertIdentifier('')
    for (const segment of path) assertIdentifier(segment)
    const key = encodePathKey(path)
    for (const root of this.roots.values()) {
      const other = encodePathKey(root.path)
      if (key.startsWith(other) || other.startsWith(key))
        throw new SchemaFailure({
          kind: 'schema_conflict',
          path,
          reason: key === other ? 'duplicate_definition' : 'overlapping_root_path',
        })
    }
    const schema = cloneSchema(node)
    validateLinkRegistration(schema, path)
    const id = Symbol()
    const ownedPath = Object.freeze([...path])
    ctx.effect(() => {
      this.roots.set(id, { path: ownedPath, schema })
      try {
        this.catalog()
      } catch (cause) {
        this.roots.delete(id)
        throw cause
      }
      this.readerRevision = Symbol()
      return () => {
        if (this.roots.delete(id)) this.readerRevision = Symbol()
      }
    })
    return makeLens<S>(ownedPath, cloneSchema(schema) as SchemaNodeOf<S>)
  }

  /**
   * Register non-required extra fields for an active struct schema. Targets
   * under `Map.at(id)` apply to every Map entry. Disposal follows `ctx`.
   */
  augment<
    TBase extends Readonly<Record<string, SchemaNode>>,
    TCustom extends boolean,
    TPresence extends ContainerPresence,
    TExtra extends Readonly<Record<string, SchemaNode>>,
  >(
    ctx: Context,
    target: StructLens<TBase, TCustom, TPresence>,
    extraFields: TExtra,
  ): StructLens<SchemaFieldsOf<TBase & TExtra>, TCustom, TPresence> {
    const path: Path = [
      ...getLensRoot(target),
      ...getLensRoute(target).map((step) => (step.kind === 'entry' ? '*' : step.key)),
    ]
    const active = schemaAt(this.catalog(), path)
    if (active?.nodeKind !== 'struct')
      throw new SchemaFailure({
        kind: 'schema_conflict',
        path,
        reason: 'augment_target_not_struct',
      })
    function check(node: SchemaNode, at: Path): void {
      if (node.presence.mode === 'required')
        throw new SchemaFailure({
          kind: 'schema_conflict',
          path: at,
          reason: 'mandatory_field_in_augment',
        })
      if (node.nodeKind === 'struct')
        for (const [key, child] of Object.entries(node.fields)) check(child, [...at, key])
      if (node.nodeKind === 'map') check(node.valueSchema, [...at, '*'])
    }
    const fields: Record<string, SchemaNode> = Object.create(null)
    for (const [key, node] of Object.entries(extraFields)) {
      assertIdentifier(key)
      if (Object.hasOwn(active.fields, key))
        throw new SchemaFailure({
          kind: 'schema_conflict',
          path: [...path, key],
          reason: 'field_name_collision',
        })
      fields[key] = cloneSchema(node)
      // Augmented fields are attached to an existing Struct instance, so a
      // direct or Map-nested link here has a valid source boundary.
      validateLinkRegistration(fields[key]!, [...path, key], true)
      check(fields[key]!, [...path, key])
    }
    const id = Symbol()
    ctx.effect(() => {
      this.augmentations.set(id, { path, fields })
      this.readerRevision = Symbol()
      return () => {
        if (this.augmentations.delete(id)) this.readerRevision = Symbol()
      }
    })
    const schema = cloneSchema({
      ...target.schema,
      fields: { ...target.schema.fields, ...fields },
    })
    return makeLens(target.path, schema, getLensRoot(target), getLensRoute(target)) as StructLens<
      SchemaFieldsOf<TBase & TExtra>,
      TCustom,
      TPresence
    >
  }

  /**
   * Register a unique message kind in the calling scope. Message schemas
   * cannot contain references or extensible structs.
   */
  defineMessage<K extends string, S extends MessageStructSchemaNode>(
    ctx: Context,
    kind: K,
    node: S,
  ): MessagePrism<K, S> {
    assertIdentifier(kind)
    if (this.catalog().messages.has(kind))
      throw new SchemaFailure({
        kind: 'schema_conflict',
        path: [kind],
        reason: 'duplicate_definition',
      })
    // Cloning preserves the message-only AST constraint on S.
    const schema = cloneSchema(node) as SchemaNodeOf<S> & MessageStructSchemaNode
    const prism = makeMessagePrism<K, S>(kind, cloneSchema(schema) as SchemaNodeOf<S>)
    const id = Symbol()
    ctx.effect(() => {
      this.messages.set(id, { kind, schema })
      this.readerRevision = Symbol()
      return () => {
        if (this.messages.delete(id)) this.readerRevision = Symbol()
      }
    })
    return prism
  }

  /** Register a business rule with its own identity inside the calling scope. */
  addCommitValidator(ctx: Context, validator: CommitValidatorFn): () => void {
    return ctx.effect(() => {
      // Each registration has its own identity, even if the function is reused.
      const registered: CommitValidatorFn = (input) => validator(input)
      this.validatorSet.add(registered)
      return () => {
        this.validatorSet.delete(registered)
      }
    })
  }
}
