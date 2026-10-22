import type { Option, Result } from '@sekaisen/core'
import { err, NONE, ok, some } from '@sekaisen/core'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { assertIdentifier, cloneSchema, cloneSchemaMetadata, SchemaFailure } from './builders.ts'
import { getLensRoot, getLensRoute } from './optics.ts'
import type { Catalog, Snapshot } from './runtime.ts'
import {
  deleteTree,
  failValidation,
  getEntry,
  hasNode,
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
  CustomFieldLens,
  FieldLens,
  FieldValueWithMeta,
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
export class ReadView implements ReadonlySchemaView {
  protected readonly snapshot: Snapshot
  protected readonly writer: Catalog
  protected readonly reader: Catalog
  protected readonly commitId: CommitHash
  constructor(snapshot: Snapshot, writer: Catalog, reader: Catalog, commitId: CommitHash) {
    this.snapshot = snapshot
    this.writer = writer
    this.reader = reader
    this.commitId = commitId
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
      const state = resolvePresence(this.snapshot, at, spec, writer, this.commitId, virtual, entry)
      if (state === 'absent') return undefined
      virtual = state === 'virtual'
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
      if (virtual || !getEntry(this.snapshot, [...lens.path, '$spec', 'valueKind']))
        return undefined
      const customSpec = readCustomSpec(this.snapshot, lens.path, this.commitId)
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
        this.snapshot,
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
        this.snapshot,
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
          meta: resolved.virtual ? Object.freeze({}) : readMeta(this.snapshot, lens.path),
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
      const value = readNode(
        this.snapshot,
        lens.path,
        resolved.reader,
        resolved.writer,
        this.commitId,
      )
      if (value.kind === 'none') return NONE
      return some(
        Object.freeze({
          value: value.value as Value | StateRef,
          meta: readMeta(this.snapshot, lens.path),
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
  /** Expose only read methods to validators, never the mutable transaction object. */
  readonlyView(): ReadonlySchemaView {
    return Object.freeze({
      get: this.get.bind(this),
      getWithMeta: this.getWithMeta.bind(this),
      getCustomUntyped: this.getCustomUntyped.bind(this),
      listKeys: this.listKeys.bind(this),
    })
  }
}

export class Transaction extends ReadView {
  private active = true
  finish(): void {
    this.active = false
  }
  private checkActive(): void {
    if (!this.active) throw new Error('Schema transaction has ended')
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
      if (!spec || !hasNode(this.snapshot, at, spec))
        failValidation(at, 'instance_not_found', 'Ancestor container does not exist')
      if (spec.nodeKind === 'struct') spec = spec.fields[step.key]
      else if (spec.nodeKind === 'map') spec = spec.valueSchema
      else failValidation(at, 'type_mismatch', 'Ancestor is a leaf')
      at = [...at, step.key]
    }
  }
  set(lens: AnyReadableLens, input: unknown): void {
    this.checkActive()
    if (lens.opticKind === 'custom') {
      const spec = this.customSpec(lens)
      validateValue(spec, input, lens.path)
      setValue(this.snapshot, [...lens.path, '$val'], input, spec.valueKind === 'ref')
      return
    }
    this.checkAncestors(lens)
    const spec = this.activeSpec(lens)
    if (lens.schema.presence.mode === 'optional') input = unwrapOptional(input)
    if (input === null) {
      if (lens.schema.presence.mode !== 'optional')
        failValidation(lens.path, 'cannot_delete_non_optional_node', 'Node is not deletable')
      deleteTree(this.snapshot, lens.path)
      return
    }
    const writeSpec: SchemaNode = { ...spec, presence: { mode: 'required' } }
    writeNode(
      this.snapshot,
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
      if (value === null) deleteTree(this.snapshot, [...lens.path, '$meta', key])
      else setValue(this.snapshot, [...lens.path, '$meta', key], value)
    }
  }
  patch(lens: StructLens, input: Readonly<Record<string, unknown>>): void {
    this.checkActive()
    if (!hasNode(this.snapshot, lens.path, lens.schema))
      failValidation(lens.path, 'instance_not_found', 'Struct does not exist')
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      failValidation(lens.path, 'type_mismatch', 'Patch must be a dictionary')
    for (const [key, value] of Object.entries(input)) {
      if (!lens.scopedFields.has(key))
        failValidation([...lens.path, key], 'type_mismatch', 'Field is outside lens scope')
      if (value !== undefined) this.set(lens.field(key), value)
    }
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
    if (!hasNode(this.snapshot, lens.path, spec))
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
    validateValue(leaf, input, lens.path)
    const custom = lens.custom(key, node)
    if (getEntry(this.snapshot, [...custom.path, '$spec', 'valueKind'])) {
      const old = readCustomSpec(this.snapshot, custom.path, this.commitId)
      if (old.valueKind !== node.valueKind)
        failValidation(custom.path, 'type_mismatch', 'Cannot redefine custom value kind')
    }
    const metadata = meta === undefined ? undefined : cloneSchemaMetadata(meta)
    writeCustomSpec(this.snapshot, custom.path, leaf)
    setValue(this.snapshot, [...custom.path, '$val'], input, leaf.valueKind === 'ref')
    if (metadata)
      for (const [attr, value] of Object.entries(metadata))
        setValue(this.snapshot, [...custom.path, '$meta', attr], value)
    return custom
  }
  overwriteStruct(lens: StructLens, input: unknown): void {
    this.checkActive()
    this.checkAncestors(lens)
    const spec = this.activeSpec(lens)
    deleteTree(this.snapshot, lens.path)
    writeNode(this.snapshot, lens.path, spec, input, 'replace', lens.scopedFields, lens.schema)
  }
  delete(lens: AnyReadableLens | UntypedCustomFieldLens): void {
    this.checkActive()
    if (lens.opticKind === 'custom' || lens.opticKind === 'custom_untyped') {
      this.resolve(lens) // Enforce extensibility, shadowing and expected custom type.
    } else {
      this.activeSpec(lens)
      if (lens.schema.presence.mode !== 'optional')
        failValidation(
          lens.path,
          'cannot_delete_non_optional_node',
          'Only optional nodes and Map entries are deletable',
        )
    }
    deleteTree(this.snapshot, lens.path)
  }
  asTransaction(): SchemaTransaction {
    // The public interface supplies the precise generic overloads; implementation validates unknown inputs.
    return this as SchemaTransaction
  }
}
