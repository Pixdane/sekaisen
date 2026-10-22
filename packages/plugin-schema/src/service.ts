import type { Option, Result } from '@sekaisen/core'
import { InvariantError, NONE } from '@sekaisen/core'
import type {
  AdvanceHeadInput,
  CommitHash,
  CommitNode,
  Path,
  StateDiff,
  TreeNodeView,
  Value,
} from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { assertIdentifier, cloneSchema, SchemaFailure } from './builders.ts'
import { checkDrift, migrateSnapshot } from './evolution.ts'
import { decodeMessage, encodeMessage, makeMessagePrism } from './message.ts'
import { getLensRoot, getLensRoute, makeLens } from './optics.ts'
import type { Catalog } from './runtime.ts'
import {
  cloneCatalog,
  cloneSnapshot,
  compileDiff,
  copyValue,
  effectiveCatalog,
  emptyCatalog,
  inspectAt,
  materializeDefaultNode,
  readCatalog,
  Snapshot,
  schemaAt,
  validateSnapshot,
  writeCatalog,
} from './runtime.ts'
import { attempt, ReadView, Transaction, unwrap } from './transaction.ts'
import type {
  AnyReadableLens,
  CommitValidatorFn,
  ContainerPresence,
  CustomFieldLens,
  FieldLens,
  FieldValueWithMeta,
  HistoricalNodeInspection,
  InferCoreOutput,
  LeafSchemaNode,
  LeafValueTypeMap,
  LensFor,
  LensOutput,
  MapLens,
  MessagePrism,
  MessageStructSchemaNode,
  ReadonlySchemaView,
  SchemaCommitOptions,
  SchemaDriftReport,
  SchemaError,
  SchemaFieldsOf,
  SchemaNode,
  SchemaNodeOf,
  SchemaTransaction,
  StructLens,
  SyncSchemaOptions,
  TypedCommitMessage,
} from './types.ts'
import { WorldStateReader, worldResult } from './world-reader.ts'

declare module 'cordis' {
  interface Context {
    schema: SchemaService
  }
}
interface Augmentation {
  path: Path
  fields: Readonly<Record<string, SchemaNode>>
}
interface ServiceState {
  roots: Map<symbol, { path: Path; schema: SchemaNode }>
  augmentations: Map<symbol, Augmentation>
  messages: Map<symbol, { kind: string; schema: MessageStructSchemaNode }>
  validators: Set<CommitValidatorFn>
  busy: boolean
}
function schemaPath(lens: StructLens): Path {
  return [
    ...getLensRoot(lens),
    ...getLensRoute(lens).map((step) => (step.kind === 'entry' ? '*' : step.key)),
  ]
}
function replaceSchema(
  catalog: Catalog,
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
 * Scoped Reader schemas, typed logical access and explicit evolution over
 * `ctx.world`. Definitions, message kinds and validators follow the calling
 * Cordis scope's lifetime; historical Writer catalogs remain in commits.
 *
 * Structural and business-rule checks protect schema commit/sync operations,
 * not direct world writes, rebases or head changes. Expected schema failures
 * return `Err`; unrelated callback exceptions and reentrant writes throw.
 */
export class SchemaService extends Service {
  /** World owns physical commits, persistence and atomic head/CAS operations. */
  static inject = ['world']
  private readonly state: ServiceState
  /**
   * Attach `ctx.schema` to a context with an existing `ctx.world` service.
   * @throws Error if the world dependency is missing.
   */
  constructor(ctx: Context) {
    if (!ctx.world) throw new Error('SchemaService requires ctx.world')
    super(ctx, 'schema')
    this.state = {
      roots: new Map(),
      augmentations: new Map(),
      messages: new Map(),
      validators: new Set(),
      busy: false,
    }
  }
  private catalog(): Catalog {
    const catalog = emptyCatalog()
    for (const root of this.state.roots.values())
      catalog.roots.set(encodePathKey(root.path), {
        path: root.path,
        schema: cloneSchema(root.schema),
      })
    for (const augmentation of this.state.augmentations.values()) {
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
    for (const { kind, schema } of this.state.messages.values()) catalog.messages.set(kind, schema)
    return catalog
  }
  /**
   * Register a copied Reader root and return a typed, scoped lens. A root path
   * must be non-empty, use valid identifiers and not overlap another active root.
   * Registration does not persist a commit. Scope disposal unregisters the
   * Reader definition without deleting the historical Writer data.
   * @see LensFor
   */
  define<S extends SchemaNode>(path: Path, node: S): Result<LensFor<S>, SchemaError> {
    return attempt(() => {
      if (!path.length) assertIdentifier('')
      for (const segment of path) assertIdentifier(segment)
      const key = encodePathKey(path)
      for (const root of this.state.roots.values()) {
        const other = encodePathKey(root.path)
        if (key.startsWith(other) || other.startsWith(key))
          throw new SchemaFailure({
            kind: 'schema_conflict',
            path,
            reason: key === other ? 'duplicate_definition' : 'overlapping_root_path',
          })
      }
      const schema = cloneSchema(node)
      const id = Symbol()
      const ownedPath = Object.freeze([...path])
      this.ctx.effect(() => {
        this.state.roots.set(id, { path: ownedPath, schema })
        try {
          this.catalog()
        } catch (cause) {
          this.state.roots.delete(id)
          throw cause
        }
        return () => {
          this.state.roots.delete(id)
        }
      })
      return makeLens<S>(ownedPath, cloneSchema(schema) as SchemaNodeOf<S>)
    })
  }
  /**
   * Register non-required extra fields for an active struct schema and return
   * a lens owning the target's base and extra fields. The original lens keeps
   * its narrower scope. Targets under `Map.at(id)` apply to every Map entry.
   * The augmentation is unregistered when its calling Cordis scope is disposed.
   * @see StructLens
   */
  augment<
    TBase extends Readonly<Record<string, SchemaNode>>,
    TCustom extends boolean,
    TPresence extends ContainerPresence,
    TExtra extends Readonly<Record<string, SchemaNode>>,
  >(
    target: StructLens<TBase, TCustom, TPresence>,
    extraFields: TExtra,
  ): Result<StructLens<SchemaFieldsOf<TBase & TExtra>, TCustom, TPresence>, SchemaError> {
    return attempt(() => {
      const path = schemaPath(target)
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
        check(fields[key]!, [...path, key])
      }
      const id = Symbol()
      this.ctx.effect(() => {
        this.state.augmentations.set(id, { path, fields })
        return () => {
          this.state.augmentations.delete(id)
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
    })
  }
  /**
   * Register a unique message kind in the calling scope. Message schemas cannot
   * contain references or extensible structs. The returned prism creates and
   * parses payloads; stored Writer catalogs allow decoding after plugin unload.
   * @see MessagePrism
   */
  defineMessage<K extends string, S extends MessageStructSchemaNode>(
    kind: K,
    node: S,
  ): Result<MessagePrism<K, S>, SchemaError> {
    return attempt(() => {
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
      this.ctx.effect(() => {
        this.state.messages.set(id, { kind, schema })
        return () => {
          this.state.messages.delete(id)
        }
      })
      return prism
    })
  }
  /**
   * Register a synchronous business rule over the final, structurally validated
   * draft. Both `commit` and `syncSchema` invoke a snapshot of registrations in
   * insertion order before calling world; the first rejection aborts the call
   * with `validator_rejected`, without its commit or head update being persisted.
   *
   * Rules must return `ok(undefined)` or
   * `err({ path, validatorName, reason })`, not `Err<SchemaError>` from a read.
   * Ordinary exceptions propagate. Callbacks should be side-effect-free:
   * rejection cannot undo external effects or direct world operations.
   * Reads, `world.commit` and `world.rebase` do not execute these rules.
   *
   * @param validator Rule receiving the parent, read-only final draft and copied physical diff.
   * @returns A disposer for this independent registration. Calling-scope disposal also unregisters it.
   * @see CommitValidatorFn
   * @example
   * ```ts
   * import { err, ok } from '@sekaisen/core'
   * import type { FieldLens, LeafSchemaNode } from '@sekaisen/plugin-schema'
   * import { SchemaService } from '@sekaisen/plugin-schema'
   *
   * export function registerNonNegativeHp(
   *   schema: SchemaService,
   *   hp: FieldLens<LeafSchemaNode<'num'>>,
   * ): () => void {
   *   return schema.addCommitValidator(({ draft }) => {
   *     const current = draft.get(hp)
   *     if (!current.ok) {
   *       return err({
   *         path: hp.path,
   *         validatorName: 'nonNegativeHp',
   *         reason: current.error.kind,
   *       })
   *     }
   *     return current.value.kind === 'some' && current.value.value < 0
   *       ? err({
   *           path: hp.path,
   *           validatorName: 'nonNegativeHp',
   *           reason: 'hp must be non-negative',
   *         })
   *       : ok(undefined)
   *   })
   * }
   * ```
   */
  addCommitValidator(validator: CommitValidatorFn): () => void {
    return this.ctx.effect(() => {
      // Each registration has its own identity, even if the function is reused.
      const registered: CommitValidatorFn = (input) => validator(input)
      this.state.validators.add(registered)
      return () => {
        this.state.validators.delete(registered)
      }
    })
  }
  /** Only write/migration paths materialize a full snapshot; logical reads use StateReader. */
  private snapshot(commitId: CommitHash): Snapshot {
    const node = worldResult(this.ctx.world.getNode(commitId))
    const snapshot = new Snapshot()
    function flatten(view: TreeNodeView, path: Path): void {
      if (view.nodeKind === 'leaf') snapshot.set(encodePathKey(path), view.entry)
      else for (const [key, child] of view.entries) flatten(child, [...path, key])
    }
    if (node.kind === 'some') flatten(node.value, [])
    return snapshot
  }
  /**
   * Capture a fixed World commit and current Reader catalog for repeated logical
   * reads. Payloads are fetched lazily from World, not copied into a full snapshot.
   * Reader defaults may be virtual; later registrations do not alter this view.
   * The backing World commit and storage must remain available for later reads.
   * @see ReadonlySchemaView
   */
  viewAt(commitId: CommitHash): Result<ReadonlySchemaView, SchemaError> {
    return attempt(() => {
      const source = new WorldStateReader(this.ctx.world, commitId)
      return new ReadView(
        source,
        readCatalog(source, commitId),
        this.catalog(),
        commitId,
      ).readonlyView()
    })
  }
  /**
   * Read a lens through the current Reader schema. Optional ancestor/member
   * absence returns `ok(NONE)`; invalid commits, incompatible kinds, missing
   * required nodes and detected Writer corruption return structured errors.
   * Reads load the Writer catalog and requested subtree, not the entire world.
   * @see ReadonlySchemaView.get
   */
  get<L extends AnyReadableLens>(
    commitId: CommitHash,
    lens: L,
  ): Result<Option<LensOutput<L>>, SchemaError> {
    return attempt(() => unwrap(unwrap(this.viewAt(commitId)).get(lens)))
  }
  /**
   * Read a copied leaf value with its instance metadata and effective spec.
   * Absent leaves return `NONE`; virtual default values have empty metadata.
   * @see ReadonlySchemaView.getWithMeta
   */
  getWithMeta<L extends LeafSchemaNode>(
    commitId: CommitHash,
    lens: FieldLens<L> | CustomFieldLens<L>,
  ): Result<Option<FieldValueWithMeta<LeafValueTypeMap[L['valueKind']]>>, SchemaError> {
    return attempt(() => unwrap(unwrap(this.viewAt(commitId)).getWithMeta(lens)))
  }
  /**
   * List concrete Map member IDs in path order; a logically absent Map yields `[]`.
   * As with a Map read, member values are still read and validated before listing.
   */
  listKeys(commitId: CommitHash, lens: MapLens): Result<readonly string[], SchemaError> {
    return attempt(() => unwrap(unwrap(this.viewAt(commitId)).listKeys(lens)))
  }
  /**
   * Inspect a logical path using the commit's Writer Schema, including dormant
   * fields and custom leaves. This returns physical history rather than
   * synthesized Reader defaults; absent or undeclared paths yield `NONE`.
   */
  inspectInstance(
    commitId: CommitHash,
    path: Path,
  ): Result<Option<HistoricalNodeInspection>, SchemaError> {
    return attempt(() => {
      const source = new WorldStateReader(this.ctx.world, commitId)
      return inspectAt(source, readCatalog(source, commitId), this.catalog(), commitId, path)
    })
  }
  /**
   * Read a plain string as `{ kind: '$text', data: message }`, or decode binary
   * message data with the commit's Writer catalog. Active registration is not
   * required for historical decoding; malformed encodings return
   * `message_decode_error`.
   * Only the message and Writer catalog are loaded, not unrelated state payloads.
   */
  getMessage(commitId: CommitHash): Result<TypedCommitMessage, SchemaError> {
    return attempt(() => {
      const message = worldResult(this.ctx.world.getMessage(commitId))
      if (typeof message === 'string') return Object.freeze({ kind: '$text', data: message })
      if (!(message instanceof Uint8Array))
        throw new SchemaFailure({
          kind: 'message_decode_error',
          commitId,
          reason: 'Expected encoded message bytes or a plain string',
        })
      const writer = readCatalog(new WorldStateReader(this.ctx.world, commitId), commitId)
      try {
        return decodeMessage(message, (kind) => writer.messages.get(kind))
      } catch (cause) {
        if (cause instanceof SchemaFailure)
          throw new SchemaFailure({ kind: 'message_decode_error', commitId, reason: cause.message })
        throw cause
      }
    })
  }
  /**
   * Decode with the historical Writer catalog, then validate/normalize through
   * the supplied prism. A different message kind yields `ok(NONE)`; a matching
   * kind must satisfy the prism's schema, which may differ from the Writer's.
   */
  getMessageAs<K extends string, S extends MessageStructSchemaNode>(
    commitId: CommitHash,
    prism: MessagePrism<K, S>,
  ): Result<Option<InferCoreOutput<S>>, SchemaError> {
    return attempt(() => unwrap(prism.parse(unwrap(this.getMessage(commitId)))))
  }
  private write<T>(fn: () => T): Result<T, SchemaError> {
    if (this.state.busy) throw new InvariantError('Reentrant schema write operation')
    this.state.busy = true
    try {
      return attempt(fn)
    } finally {
      this.state.busy = false
    }
  }
  private parent(options: SchemaCommitOptions): Option<CommitHash> {
    if (options.parentId !== undefined) return options.parentId
    if (options.head !== undefined)
      return this.ctx.world.getHead(
        typeof options.head === 'string' ? options.head : options.head.name,
      )
    return NONE
  }
  private finish(
    before: Snapshot,
    draft: Snapshot,
    catalog: Catalog,
    reader: Catalog,
    parentId: Option<CommitHash>,
    message: Value,
    head?: string | AdvanceHeadInput,
  ): CommitNode {
    const commitId = parentId.kind === 'some' ? parentId.value : ('' as CommitHash)
    validateSnapshot(draft, catalog, commitId)
    const diff: StateDiff = compileDiff(before, draft)
    const view = new ReadView(draft, catalog, reader, commitId).readonlyView()
    for (const validator of [...this.state.validators]) {
      const exposedDiff: StateDiff = Object.freeze(
        diff.map((op) =>
          Object.freeze(
            op.op === 'set'
              ? { ...op, value: copyValue(op.value) }
              : op.op === 'ref'
                ? { ...op, ref: copyValue(op.ref) }
                : { ...op },
          ),
        ),
      )
      const result = validator({ parentId, draft: view, diff: exposedDiff })
      if (!result.ok) throw new SchemaFailure({ kind: 'validator_rejected', ...result.error })
    }
    return worldResult(
      this.ctx.world.commit({
        parentId,
        message,
        diff,
        ...(head === undefined
          ? {}
          : {
              advanceHead:
                typeof head === 'string'
                  ? { name: head, expected: parentId }
                  : { ...head, expected: head.expected ?? parentId },
            }),
      }),
    )
  }
  /**
   * Mutate an isolated draft synchronously, check its final physical schema,
   * run registered validators and persist through world with atomic head/CAS.
   * Active Reader/Writer drift requires `syncSchema`; dormant-only differences
   * are retained. The transaction's mutation methods close when `mutate` exits.
   *
   * @param options Parent selection, optional head advancement and plain/typed message.
   * @param mutate Optional synchronous callback; return `Err<SchemaError>` to reject.
   * @returns The physical world commit, or a structured schema/validator/world failure.
   * @remarks Rejection creates no commit/head update for this operation, but cannot
   * undo callback side effects or direct world writes. Expected schema failures
   * thrown by mutators become `Err`; other exceptions propagate.
   * @throws TypeError if the callback returns a Promise/thenable.
   * @throws InvariantError if called reentrantly during a schema write or validator.
   * @see SchemaCommitOptions
   * @see CommitValidatorFn
   */
  commit(
    options: SchemaCommitOptions,
    mutate?: (tx: SchemaTransaction) => void | Result<void, SchemaError>,
  ): Result<CommitNode, SchemaError> {
    return this.write(() => {
      const parentId = this.parent(options)
      const commitId = parentId.kind === 'some' ? parentId.value : ('' as CommitHash)
      const before = parentId.kind === 'some' ? this.snapshot(parentId.value) : new Snapshot()
      const reader = this.catalog()
      const writer =
        parentId.kind === 'some' ? readCatalog(before, parentId.value) : cloneCatalog(reader)
      if (parentId.kind === 'some') {
        const drift = checkDrift(before, writer, reader, parentId.value)
        if (
          drift.backfillableNodes.length ||
          drift.compatibleChanges.length ||
          drift.promotedCustomFields.length ||
          drift.incompatibilities.length
        ) {
          throw new SchemaFailure({
            kind: 'schema_drift_requires_sync',
            commitId: parentId.value,
            reason: 'Active Reader Schema differs from Writer Schema; call syncSchema first',
          })
        }
      }
      const catalog = effectiveCatalog(reader, writer, true)
      const draft = cloneSnapshot(before)
      if (parentId.kind === 'none') {
        writeCatalog(draft, reader)
        for (const root of reader.roots.values())
          materializeDefaultNode(draft, root.path, root.schema)
      }
      const tx = new Transaction(draft, catalog, reader, commitId)
      try {
        const result = mutate?.(tx.asTransaction())
        if (result && typeof result === 'object' && 'then' in result)
          throw new TypeError('Schema transactions must be synchronous')
        if (result && !result.ok) throw new SchemaFailure(result.error)
      } finally {
        tx.finish()
      }
      let message: Value
      if (typeof options.message === 'string') message = options.message
      else {
        const schema = reader.messages.get(options.message.kind)
        if (!schema)
          throw new SchemaFailure({
            kind: 'validation_failed',
            path: [],
            reason: 'type_mismatch',
            detail: 'Message kind is not registered',
          })
        message = encodeMessage(options.message, schema)
      }
      return this.finish(before, draft, catalog, reader, parentId, message, options.head)
    })
  }
  /**
   * Compare the commit's stored Writer catalog with active Reader definitions
   * without writing data. Dormant definitions alone leave `isClean` true.
   * @see SchemaDriftReport
   */
  checkDrift(commitId: CommitHash): Result<SchemaDriftReport, SchemaError> {
    return attempt(() => {
      const source = new WorldStateReader(this.ctx.world, commitId)
      return checkDrift(source, readCatalog(source, commitId), this.catalog(), commitId)
    })
  }
  /**
   * Synchronize the current tip of an existing head to the active Reader schema.
   * Backfills, promotions, supplied migrations and optional pruning build a
   * separate draft; every converter reads the immutable pre-migration source.
   * The final physical state and registered validators must pass before world
   * atomically persists the `syncSchema` commit and advances the head with CAS.
   *
   * @param options Head/expectation, dormant policy (default `keep`) and per-schema converters.
   * @returns The sync commit, or a structured drift/migration/validator/world failure.
   * @remarks Missing heads fail; incompatible existing instances need converters.
   * Failure persists no commit/head update for this call. Converter/validator
   * side effects are not rolled back, and unrelated thrown exceptions propagate.
   * @throws InvariantError if called reentrantly during another schema write.
   * @see SyncSchemaOptions
   * @see CommitValidatorFn
   */
  syncSchema(options: SyncSchemaOptions): Result<CommitNode, SchemaError> {
    return this.write(() => {
      const name = typeof options.head === 'string' ? options.head : options.head.name
      const parentId = this.ctx.world.getHead(name)
      if (parentId.kind === 'none')
        throw new SchemaFailure({
          kind: 'world_error',
          error: { kind: 'head_not_found', headName: name },
        })
      const before = this.snapshot(parentId.value)
      const writer = readCatalog(before, parentId.value),
        reader = this.catalog()
      const migrated = migrateSnapshot(before, writer, reader, parentId.value, options)
      writeCatalog(migrated.snapshot, migrated.catalog)
      return this.finish(
        before,
        migrated.snapshot,
        migrated.catalog,
        reader,
        parentId,
        'syncSchema',
        options.head,
      )
    })
  }
}
