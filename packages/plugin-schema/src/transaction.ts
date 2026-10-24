import type { Option, Result } from '@sekaisen/core'
import { compareUtf8, err, NONE, ok, some } from '@sekaisen/core'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { assertIdentifier, cloneSchema, cloneSchemaMetadata, SchemaFailure } from './builders.ts'
import {
  applyLinkCascade,
  collectTargetableInstances,
  linkOperationMayRemoveTargets,
  queryBacklinks,
  validateCustomLinkRegistration,
} from './links.ts'
import type { LensStep } from './optics.ts'
import { getLensRoot, getLensRoute, makeLens } from './optics.ts'
import type { Catalog, StateReader, StateWriter } from './runtime.ts'
import {
  deleteTree,
  failValidation,
  hasNode,
  inspectAt,
  physicalSchemaAt,
  readCustomSpec,
  readMeta,
  readNode,
  resolvePresence,
  setValue,
  typeCompatible,
  unwrapOptional,
  validateValue,
  writeCustomSpec,
  writeNode,
} from './runtime.ts'
import type {
  AnyReadableLens,
  BacklinkEntry,
  BacklinkQueryFilter,
  CustomFieldLens,
  FieldLens,
  FieldValueWithMeta,
  HistoricalNodeInspection,
  LeafSchemaNode,
  LeafValueTypeMap,
  LensOutput,
  MapLens,
  ReadonlySchemaView,
  SchemaError,
  SchemaMetaMap,
  SchemaNode,
  SchemaTransaction,
  StructLens,
  UntypedCustomFieldLens,
} from './types.ts'

export function attempt<T>(fn: () => T): Result<T, SchemaError> {
  try {
    return ok(fn())
  } catch (cause) {
    if (cause instanceof SchemaFailure) return err(cause.error)
    throw cause
  }
}
export function unwrap<T>(result: Result<T, SchemaError>): T {
  if (!result.ok) throw new SchemaFailure(result.error)
  return result.value
}
interface Resolution {
  path: Path
  reader: SchemaNode
  writer: SchemaNode | undefined
  virtual: boolean
}

/**
 * Return a copy of `spec` with optional presence, preserving its node kind.
 * Used by `lensAt` for concrete Map-entry paths so a discovered dynamic entry
 * behaves exactly like `mapLens.at(id)` (deletable, nullable writes).
 */
function withOptionalPresence(spec: SchemaNode): SchemaNode {
  switch (spec.nodeKind) {
    case 'leaf':
      return Object.freeze({ ...spec, presence: { mode: 'optional' as const } })
    case 'struct':
      return Object.freeze({ ...spec, presence: { mode: 'optional' as const } })
    case 'map':
      return Object.freeze({ ...spec, presence: { mode: 'optional' as const } })
  }
}
export class ReadView<TState extends StateReader = StateReader> implements ReadonlySchemaView {
  protected readonly state: TState
  protected readonly writer: Catalog
  protected readonly reader: Catalog
  protected readonly commitId: CommitHash
  /**
   * Catalog used for Writer-faithful inspection and link indexing. Immutable
   * views use their stored Writer catalog (same as `writer`); a transaction
   * passes the parent's stored Writer catalog separately because `writer` is
   * the merged effective catalog used for writes.
   */
  protected readonly physical: Catalog
  constructor(
    state: TState,
    writer: Catalog,
    reader: Catalog,
    commitId: CommitHash,
    physical: Catalog = writer,
  ) {
    this.state = state
    this.writer = writer
    this.reader = reader
    this.commitId = commitId
    this.physical = physical
  }

  protected resolve(lens: AnyReadableLens | UntypedCustomFieldLens): Resolution | undefined {
    const rootPath = getLensRoot(lens)
    const root = this.reader.roots.get(encodePathKey(rootPath))
    if (!root) failValidation(rootPath, 'type_mismatch', 'Lens root is not registered')
    let spec = root.schema
    let writer = this.writer.roots.get(encodePathKey(rootPath))?.schema
    let at: Path = rootPath
    let virtual = false
    let entry = false
    const route = getLensRoute(lens)
    for (let index = 0; ; index++) {
      const presence = resolvePresence(this.state, at, spec, writer, this.commitId, virtual, entry)
      if (presence === 'absent') return undefined
      virtual = presence === 'virtual'
      const step = route[index]
      if (!step) break
      if (step.kind === 'field' && spec.nodeKind === 'struct') {
        const child = spec.fields[step.key]
        if (!child) failValidation(at, 'type_mismatch', 'Lens field is not registered')
        spec = child
        writer = writer?.nodeKind === 'struct' ? writer.fields[step.key] : undefined
        entry = false
      } else if (step.kind === 'entry' && spec.nodeKind === 'map') {
        assertIdentifier(step.key)
        spec = spec.valueSchema
        writer = writer?.nodeKind === 'map' ? writer.valueSchema : undefined
        entry = true
        if (virtual) return undefined
      } else failValidation(at, 'type_mismatch', 'Lens no longer matches the active schema')
      at = [...at, step.key]
    }
    if (lens.opticKind === 'custom' || lens.opticKind === 'custom_untyped') {
      if (spec.nodeKind !== 'struct' || !spec.allowCustom)
        failValidation(at, 'custom_not_allowed_on_struct', 'Struct does not allow custom keys')
      assertIdentifier(lens.customKey)
      if (
        Object.hasOwn(spec.fields, lens.customKey) ||
        (writer?.nodeKind === 'struct' && Object.hasOwn(writer.fields, lens.customKey))
      ) {
        failValidation(
          lens.path,
          'custom_key_shadows_struct_field',
          'Custom key shadows a formal field',
        )
      }
      if (virtual || !this.state.hasEntry([...lens.path, '$spec', 'valueKind'])) return undefined
      const customSpec = readCustomSpec(this.state, lens.path, this.commitId)
      if (lens.opticKind === 'custom' && lens.expectedSchema.valueKind !== customSpec.valueKind) {
        throw new SchemaFailure({
          kind: 'schema_type_mismatch',
          commitId: this.commitId,
          path: lens.path,
          expectedKind: lens.expectedSchema.valueKind,
          actualKind: customSpec.valueKind,
        })
      }
      return { path: lens.path, reader: customSpec, writer: customSpec, virtual: false }
    }
    if (!typeCompatible(lens.schema, spec))
      throw new SchemaFailure({
        kind: 'schema_type_mismatch',
        commitId: this.commitId,
        path: lens.path,
        expectedKind:
          lens.schema.nodeKind === 'leaf' ? lens.schema.valueKind : lens.schema.nodeKind,
        actualKind: spec.nodeKind === 'leaf' ? spec.valueKind : spec.nodeKind,
      })
    return { path: at, reader: spec, writer, virtual }
  }

  get<TLens extends AnyReadableLens>(lens: TLens): Result<Option<LensOutput<TLens>>, SchemaError> {
    return attempt(() => {
      const resolved = this.resolve(lens)
      if (!resolved) return NONE
      // Resolution has already applied the existence matrix, including Map member short-circuiting.
      const result = readNode(
        this.state,
        resolved.path,
        resolved.reader,
        resolved.writer,
        this.commitId,
        resolved.virtual,
      )
      return result as Option<LensOutput<TLens>>
    })
  }
  getWithMeta<TLeaf extends LeafSchemaNode>(
    lens: FieldLens<TLeaf> | CustomFieldLens<TLeaf>,
  ): Result<Option<FieldValueWithMeta<LeafValueTypeMap[TLeaf['valueKind']]>>, SchemaError> {
    return attempt(() => {
      const resolved = this.resolve(lens)
      if (!resolved) return NONE
      if (resolved.reader.nodeKind !== 'leaf')
        failValidation(lens.path, 'type_mismatch', 'Expected a leaf')
      const value = readNode(
        this.state,
        resolved.path,
        resolved.reader,
        resolved.writer,
        this.commitId,
        resolved.virtual,
      )
      if (value.kind === 'none') return NONE
      return some(
        Object.freeze({
          value: value.value as LeafValueTypeMap[TLeaf['valueKind']],
          meta: resolved.virtual ? Object.freeze({}) : readMeta(this.state, lens.path),
          spec: cloneSchema(resolved.reader) as LeafSchemaNode,
        }),
      )
    })
  }
  getCustomUntyped(
    lens: UntypedCustomFieldLens,
  ): Result<Option<FieldValueWithMeta<Value | StateRef>>, SchemaError> {
    return attempt(() => {
      const resolved = this.resolve(lens)
      if (!resolved) return NONE
      if (resolved.reader.nodeKind !== 'leaf')
        failValidation(lens.path, 'type_mismatch', 'Expected custom leaf')
      const value = readNode(this.state, lens.path, resolved.reader, resolved.writer, this.commitId)
      if (value.kind === 'none') return NONE
      return some(
        Object.freeze({
          value: value.value as Value | StateRef,
          meta: readMeta(this.state, lens.path),
          spec: cloneSchema(resolved.reader) as LeafSchemaNode,
        }),
      )
    })
  }
  listKeys(lens: MapLens): Result<readonly string[], SchemaError> {
    return attempt(() => {
      const value = unwrap(this.get(lens))
      return Object.freeze(value.kind === 'none' ? [] : Object.keys(value.value))
    })
  }
  /**
   * Root paths addressable by trusted introspection in this fixed view.
   *
   * The union of the captured Reader roots and the view's Writer roots is
   * returned, deduplicated by encoded path key and sorted by UTF-8 key, so
   * Writer-only (dormant) roots remain visible for graph/topology inspection
   * even after their plugin owner unloads. Mutation helpers (`lensAt`, `get`,
   * writes) intentionally stay restricted to the captured Reader catalog.
   */
  listRootPaths(): readonly Path[] {
    const seen = new Set<string>()
    const paths: Path[] = []
    for (const root of [...this.reader.roots.values(), ...this.physical.roots.values()]) {
      const key = encodePathKey(root.path)
      if (seen.has(key)) continue
      seen.add(key)
      paths.push(root.path)
    }
    paths.sort((left, right) => compareUtf8(encodePathKey(left), encodePathKey(right)))
    return Object.freeze(paths)
  }
  inspectInstance(nodePath: Path): Result<Option<HistoricalNodeInspection>, SchemaError> {
    return attempt(() => inspectAt(this.state, this.physical, this.reader, this.commitId, nodePath))
  }
  /**
   * Resolve a Writer declaration without consulting any physical value.
   *
   * The Writer catalog bound to this view (`physical`: the stored commit
   * catalog for immutable views and the parent's stored Writer for drafts) is
   * the only declaration source, so active Reader definitions cannot leak into
   * historical reads. Struct fields and Map value schemas are traversed purely
   * declaratively; a concrete custom leaf is resolved from its stored `$spec`
   * in the current state, which is the same snapshot `inspectInstance` uses.
   *
   * @see ReadonlySchemaView.writerSchemaAt
   */
  writerSchemaAt(nodePath: Path): Result<Option<SchemaNode>, SchemaError> {
    return attempt(() => {
      // Custom leaves are not catalog coordinates: their declaration lives at
      // `[...struct, '$custom', key, '$spec']` and is independent of `$val`.
      const customIndex = nodePath.indexOf('$custom')
      if (customIndex !== -1) {
        if (nodePath.length !== customIndex + 2) return NONE
        const customKey = nodePath[customIndex + 1]!
        assertIdentifier(customKey)
        const parent = physicalSchemaAt(this.physical, nodePath.slice(0, customIndex))
        if (parent?.nodeKind !== 'struct' || !parent.allowCustom) return NONE
        const customPath = nodePath.slice(0, customIndex + 2)
        if (this.state.childKeys(customPath).length === 0) return NONE
        // `readCustomSpec` already returns a deep-owned frozen AST.
        return some(readCustomSpec(this.state, customPath, this.commitId))
      }
      const spec = physicalSchemaAt(this.physical, nodePath)
      return spec === undefined ? NONE : some(cloneSchema(spec))
    })
  }
  lensAt(nodePath: Path): Result<AnyReadableLens, SchemaError> {
    return attempt(() => {
      let root: { path: Path; schema: SchemaNode } | undefined
      for (const candidate of this.reader.roots.values()) {
        if (candidate.path.length > nodePath.length) continue
        if (!candidate.path.every((segment, index) => segment === nodePath[index])) continue
        if (root === undefined || candidate.path.length > root.path.length) root = candidate
      }
      if (root === undefined)
        failValidation(nodePath, 'type_mismatch', 'Path is not covered by a registered root')
      let spec: SchemaNode = root.schema
      const route: LensStep[] = []
      for (const key of nodePath.slice(root.path.length)) {
        if (spec.nodeKind === 'struct') {
          const child = spec.fields[key]
          if (child === undefined)
            failValidation(
              nodePath,
              'type_mismatch',
              'Path does not match the active Reader schema',
            )
          spec = child
          route.push({ kind: 'field', key })
        } else if (spec.nodeKind === 'map') {
          assertIdentifier(key)
          spec = spec.valueSchema
          route.push({ kind: 'entry', key })
        } else {
          failValidation(nodePath, 'type_mismatch', 'Path descends through a leaf')
        }
      }
      // A concrete Map entry is addressed with add/remove semantics, matching
      // `MapLens.at(id)`, regardless of the value schema's own presence.
      const lensSpec: SchemaNode =
        route.at(-1)?.kind === 'entry' ? withOptionalPresence(spec) : spec
      return makeLens(nodePath, lensSpec, root.path, route) as AnyReadableLens
    })
  }
  getInstanceMeta(lens: StructLens): Result<Option<SchemaMetaMap>, SchemaError> {
    return attempt(() => {
      const resolved = this.resolve(lens)
      if (resolved === undefined) return NONE
      if (resolved.reader.nodeKind !== 'struct')
        failValidation(lens.path, 'type_mismatch', 'Expected a Struct instance')
      return some(readMeta(this.state, resolved.path))
    })
  }
  backlinks(
    targetInstancePath: Path,
    filter?: BacklinkQueryFilter,
  ): Result<readonly BacklinkEntry[], SchemaError> {
    return attempt(() => queryBacklinks(this.state, this.physical, targetInstancePath, filter))
  }
  /** Expose only read methods to validators, never the mutable transaction object. */
  readonlyView(): ReadonlySchemaView {
    return Object.freeze({
      get: this.get.bind(this),
      getWithMeta: this.getWithMeta.bind(this),
      getCustomUntyped: this.getCustomUntyped.bind(this),
      listKeys: this.listKeys.bind(this),
      listRootPaths: this.listRootPaths.bind(this),
      inspectInstance: this.inspectInstance.bind(this),
      writerSchemaAt: this.writerSchemaAt.bind(this),
      lensAt: this.lensAt.bind(this),
      getInstanceMeta: this.getInstanceMeta.bind(this),
      backlinks: this.backlinks.bind(this),
    })
  }
}

export class Transaction extends ReadView<StateWriter> {
  private active = true
  finish(): void {
    this.active = false
  }
  private checkActive(): void {
    if (!this.active) throw new Error('Schema transaction has ended')
  }
  /**
   * Apply `operation` as one nested draft savepoint.
   *
   * The draft's rollback journal records the first touch of every node changed
   * by the callback, so accepting merges those records into an enclosing scope
   * and rejecting restores values, deletes, custom specs/metadata and layout
   * exactly. Writes made before this call are outside the journal snapshot and
   * survive a rollback, which lets a caller catch a failed savepoint and still
   * commit its earlier work.
   *
   * Failures propagate the callback's exact thrown value. A returned thenable
   * is rejected with `TypeError` and rolled back because transactions are
   * synchronous.
   *
   * @see SchemaTransaction.atomic
   */
  atomic<T>(operation: () => T): T {
    this.checkActive()
    this.state.beginScope()
    try {
      const result = operation()
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      )
        throw new TypeError('Schema transaction savepoints must be synchronous')
      this.state.commitScope()
      return result
    } catch (cause) {
      this.state.rollbackScope()
      throw cause
    }
  }
  private activeSpec(lens: StructLens | MapLens | FieldLens): SchemaNode {
    const spec = physicalSchemaAt(this.reader, lens.path)
    if (!spec) failValidation(lens.path, 'type_mismatch', 'Lens is not registered')
    if (!typeCompatible(lens.schema, spec))
      failValidation(lens.path, 'type_mismatch', 'Lens schema is stale')
    // Dormant Writer fields still impose physical invariants on newly created instances.
    return physicalSchemaAt(this.writer, lens.path) ?? spec
  }
  private customSpec(lens: CustomFieldLens): LeafSchemaNode {
    const resolved = this.resolve(lens)
    if (resolved?.reader.nodeKind !== 'leaf')
      failValidation(lens.path, 'undefined_custom_key', 'Define custom key before writing')
    return resolved.reader
  }
  private checkAncestors(lens: AnyReadableLens): void {
    const root = getLensRoot(lens)
    const route = getLensRoute(lens)
    let at: Path = root
    let spec = this.reader.roots.get(encodePathKey(root))?.schema
    for (const step of route) {
      if (!spec || !hasNode(this.state, at, spec))
        failValidation(at, 'instance_not_found', 'Ancestor container does not exist')
      if (spec.nodeKind === 'struct') spec = spec.fields[step.key]
      else if (spec.nodeKind === 'map') spec = spec.valueSchema
      else failValidation(at, 'type_mismatch', 'Ancestor is a leaf')
      at = [...at, step.key]
    }
  }
  /**
   * Run one mutation under the three-phase link policy.
   *
   * The seed set is collected from the pre-mutation draft (`D_pre`) inside the
   * touched subtree before anything changes, then the mutation is applied and
   * {@link applyLinkCascade} works on the post-mutation draft. A rejected
   * deletion throws after the rollback scope restores every physical write, so
   * the caller never observes a half-applied cascade.
   *
   * Operations that cannot remove a link target (leaf/custom writes, subtrees
   * disjoint from every declared target root) bypass the scope entirely.
   */
  private withLinks(root: Path, mutate: () => void): void {
    if (!linkOperationMayRemoveTargets(this.physical, root)) {
      mutate()
      return
    }
    this.state.beginScope()
    const preTargets = collectTargetableInstances(this.state, this.physical, root)
    try {
      mutate()
      applyLinkCascade(this.state, this.physical, preTargets)
      this.state.commitScope()
    } catch (cause) {
      this.state.rollbackScope()
      throw cause
    }
  }
  set(lens: AnyReadableLens, input: unknown): void {
    this.checkActive()
    if (lens.opticKind === 'struct' || lens.opticKind === 'map') {
      this.withLinks(lens.path, () => this.applySet(lens, input))
      return
    }
    this.applySet(lens, input)
  }
  private applySet(lens: AnyReadableLens, input: unknown): void {
    if (lens.opticKind === 'custom') {
      const spec = this.customSpec(lens)
      validateValue(spec, input, lens.path)
      setValue(this.state, [...lens.path, '$val'], input, spec.valueKind === 'ref')
      return
    }
    this.checkAncestors(lens)
    const spec = this.activeSpec(lens)
    if (lens.schema.presence.mode === 'optional') input = unwrapOptional(input)
    if (input === null) {
      if (lens.schema.presence.mode !== 'optional')
        failValidation(lens.path, 'cannot_delete_non_optional_node', 'Node is not deletable')
      deleteTree(this.state, lens.path)
      return
    }
    const writeSpec: SchemaNode = { ...spec, presence: { mode: 'required' } }
    writeNode(
      this.state,
      lens.path,
      writeSpec,
      input,
      'scoped',
      lens.opticKind === 'struct' ? lens.scopedFields : undefined,
      lens.schema,
    )
  }
  setWithMeta(
    lens: FieldLens | CustomFieldLens,
    input: unknown,
    meta: Readonly<Record<string, Value | null>>,
  ): void {
    this.checkActive()
    const metadata = cloneSchemaMetadata(meta)
    this.set(lens, input)
    for (const [key, value] of Object.entries(metadata)) {
      if (value === null) deleteTree(this.state, [...lens.path, '$meta', key])
      else setValue(this.state, [...lens.path, '$meta', key], value)
    }
  }
  /**
   * Merge instance metadata into an existing Struct instance.
   *
   * Writes `[...instancePath, '$meta', key]` values and deletes keys passed as
   * `null`. Every supplied value is validated and copied before the first
   * write, so an invalid dictionary cannot leave partial metadata behind.
   * Omitted keys survive; fields, custom leaves and `$exists` are untouched.
   * Requires a physically present instance (`resolvePresence` must not be
   * absent or virtual), mirroring `tx.set` ancestor requirements.
   */
  setInstanceMeta(lens: StructLens, meta: Readonly<Record<string, Value | null>>): void {
    this.checkActive()
    const resolved = this.resolve(lens)
    if (resolved === undefined)
      failValidation(lens.path, 'instance_not_found', 'Struct does not exist')
    if (resolved.reader.nodeKind !== 'struct' || resolved.virtual)
      failValidation(lens.path, 'instance_not_found', 'Struct does not physically exist')
    const writes: Record<string, Value> = Object.create(null)
    for (const [key, value] of Object.entries(meta)) {
      if (key.length === 0 || !key.isWellFormed())
        failValidation(
          [...lens.path, '$meta', key],
          'type_mismatch',
          'Metadata keys must be non-empty well-formed strings',
        )
      if (value !== null) writes[key] = value
    }
    const owned = cloneSchemaMetadata(writes)
    for (const [key, value] of Object.entries(meta)) {
      if (value === null) deleteTree(this.state, [...resolved.path, '$meta', key])
    }
    for (const [key, value] of Object.entries(owned)) {
      setValue(this.state, [...resolved.path, '$meta', key], value)
    }
  }
  patch(lens: StructLens, input: Readonly<Record<string, unknown>>): void {
    this.checkActive()
    if (!hasNode(this.state, lens.path, lens.schema))
      failValidation(lens.path, 'instance_not_found', 'Struct does not exist')
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      failValidation(lens.path, 'type_mismatch', 'Patch must be a dictionary')
    this.withLinks(lens.path, () => {
      for (const [key, value] of Object.entries(input)) {
        if (!lens.scopedFields.has(key))
          failValidation([...lens.path, key], 'type_mismatch', 'Field is outside lens scope')
        if (value !== undefined) this.applySet(lens.field(key), value)
      }
    })
  }
  update(lens: FieldLens | CustomFieldLens, updater: (value: never) => unknown): void {
    this.checkActive()
    this.checkAncestors(lens)
    const current = unwrap(this.get(lens))
    const optional = lens.opticKind === 'field' && lens.schema.presence.mode === 'optional'
    if (!optional && current.kind === 'none')
      failValidation(lens.path, 'instance_not_found', 'Cannot update absent field')
    const value = optional ? current : current.kind === 'some' ? current.value : undefined
    this.set(lens, updater(value as never))
  }
  defineCustom(
    lens: StructLens,
    key: string,
    node: LeafSchemaNode,
    input: unknown,
    meta?: SchemaMetaMap,
  ): CustomFieldLens {
    this.checkActive()
    assertIdentifier(key)
    const spec = this.activeSpec(lens)
    if (spec.nodeKind !== 'struct' || !spec.allowCustom)
      failValidation(lens.path, 'custom_not_allowed_on_struct', 'Struct is not extensible')
    if (!hasNode(this.state, lens.path, spec))
      failValidation(lens.path, 'instance_not_found', 'Struct does not exist')
    const writer = physicalSchemaAt(this.writer, lens.path)
    if (
      Object.hasOwn(spec.fields, key) ||
      (writer?.nodeKind === 'struct' && Object.hasOwn(writer.fields, key))
    )
      failValidation(lens.path, 'custom_key_shadows_struct_field', 'Key is a formal field')
    const leaf = cloneSchema(node)
    if (leaf.nodeKind !== 'leaf')
      failValidation(lens.path, 'type_mismatch', 'Custom schema must be a leaf')
    const custom = lens.custom(key, node)
    validateCustomLinkRegistration(leaf, custom.path)
    validateValue(leaf, input, lens.path)
    if (this.state.hasEntry([...custom.path, '$spec', 'valueKind'])) {
      const old = readCustomSpec(this.state, custom.path, this.commitId)
      if (old.valueKind !== node.valueKind)
        failValidation(custom.path, 'type_mismatch', 'Cannot redefine custom value kind')
    }
    const metadata = meta === undefined ? undefined : cloneSchemaMetadata(meta)
    writeCustomSpec(this.state, custom.path, leaf)
    setValue(this.state, [...custom.path, '$val'], input, leaf.valueKind === 'ref')
    if (metadata)
      for (const [attr, value] of Object.entries(metadata))
        setValue(this.state, [...custom.path, '$meta', attr], value)
    return custom
  }
  overwriteStruct(lens: StructLens, input: unknown): void {
    this.checkActive()
    this.checkAncestors(lens)
    const spec = this.activeSpec(lens)
    this.withLinks(lens.path, () => {
      deleteTree(this.state, lens.path)
      writeNode(this.state, lens.path, spec, input, 'replace', lens.scopedFields, lens.schema)
    })
  }
  delete(lens: AnyReadableLens | UntypedCustomFieldLens): void {
    this.checkActive()
    if (lens.opticKind === 'custom' || lens.opticKind === 'custom_untyped') {
      this.resolve(lens) // Enforce extensibility, shadowing and expected custom type.
      deleteTree(this.state, lens.path)
      return
    }
    this.activeSpec(lens)
    if (lens.schema.presence.mode !== 'optional')
      failValidation(
        lens.path,
        'cannot_delete_non_optional_node',
        'Only optional nodes and Map entries are deletable',
      )
    if (lens.opticKind === 'struct' || lens.opticKind === 'map') {
      this.withLinks(lens.path, () => deleteTree(this.state, lens.path))
      return
    }
    deleteTree(this.state, lens.path)
  }
  asTransaction(): SchemaTransaction {
    // The public interface supplies the precise generic overloads; implementation validates unknown inputs.
    return this as SchemaTransaction
  }
}
