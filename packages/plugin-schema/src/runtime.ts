import type { Option } from '@sekaisen/core'
import { isOption, NONE, some } from '@sekaisen/core'
import type {
  CommitHash,
  LeafEntry,
  Path,
  StateDiff,
  StateRef,
  Value,
} from '@sekaisen/plugin-world'
import { comparePaths, decodePathKey, encodePathKey, leafEntryEquals } from '@sekaisen/plugin-world'
import {
  assertIdentifier,
  assertLeafValue,
  cloneSchema,
  cloneSchemaValue,
  cloneStateRef,
  isStateRef,
  SchemaFailure,
} from './builders.ts'
import type {
  HistoricalNodeInspection,
  LeafSchemaNode,
  MessageStructSchemaNode,
  SchemaError,
  SchemaMetaMap,
  SchemaNode,
} from './types.ts'

export type Snapshot = Map<string, LeafEntry>
export interface Catalog {
  roots: Map<string, { path: Path; schema: SchemaNode }>
  messages: Map<string, MessageStructSchemaNode>
}
export function emptyCatalog(): Catalog {
  return { roots: new Map(), messages: new Map() }
}
export function failValidation(
  path: Path,
  reason: Extract<SchemaError, { kind: 'validation_failed' }>['reason'],
  detail: string,
): never {
  throw new SchemaFailure({ kind: 'validation_failed', path, reason, detail })
}
export function corrupt(commitId: CommitHash, path: Path, reason: string): never {
  throw new SchemaFailure({ kind: 'corrupted_instance_data', commitId, path, reason })
}
export function copyValue<T extends Value | StateRef>(value: T): T {
  return (isStateRef(value) ? cloneStateRef(value) : cloneSchemaValue(value as Value)) as T
}
export function cloneSnapshot(source: Snapshot): Snapshot {
  return new Map(
    [...source].map(([key, entry]) => [
      key,
      entry.entryKind === 'val'
        ? { entryKind: 'val', value: copyValue(entry.value) }
        : { entryKind: 'ref', ref: copyValue(entry.ref) },
    ]),
  )
}
export function getEntry(snapshot: Snapshot, path: Path): LeafEntry | undefined {
  return snapshot.get(encodePathKey(path))
}
export function setValue(
  snapshot: Snapshot,
  path: Path,
  value: Value | StateRef,
  ref = false,
): void {
  snapshot.set(
    encodePathKey(path),
    ref
      ? Object.freeze({ entryKind: 'ref', ref: copyValue(value as StateRef) })
      : Object.freeze({ entryKind: 'val', value: copyValue(value as Value) }),
  )
}
export function deleteTree(snapshot: Snapshot, path: Path): void {
  const prefix = encodePathKey(path)
  for (const key of snapshot.keys()) if (key.startsWith(prefix)) snapshot.delete(key)
}
export function childKeys(snapshot: Snapshot, path: Path): string[] {
  const prefix = encodePathKey(path)
  const result = new Set<string>()
  for (const key of snapshot.keys()) {
    if (key.startsWith(prefix) && key !== prefix)
      result.add(decodePathKey(key.slice(prefix.length))[0]!)
  }
  return [...result].sort((a, b) => comparePaths([a], [b]))
}
export function hasNode(snapshot: Snapshot, path: Path, spec: SchemaNode): boolean {
  return getEntry(snapshot, [...path, spec.nodeKind === 'leaf' ? '$val' : '$exists']) !== undefined
}
export function readMeta(snapshot: Snapshot, path: Path): SchemaMetaMap {
  const meta: Record<string, Value> = Object.create(null)
  for (const key of childKeys(snapshot, [...path, '$meta'])) {
    const entry = getEntry(snapshot, [...path, '$meta', key])
    if (entry?.entryKind !== 'val')
      failValidation(path, 'type_mismatch', 'Metadata must contain value leaves')
    meta[key] = copyValue(entry.value)
  }
  return Object.freeze(meta)
}
export function validateValue(
  spec: LeafSchemaNode,
  value: unknown,
  path: Path,
): asserts value is Value | StateRef {
  assertLeafValue(spec.valueKind, value, path)
}
function val(snapshot: Snapshot, path: Path, commitId: CommitHash): Value {
  const entry = getEntry(snapshot, path)
  if (entry?.entryKind !== 'val') corrupt(commitId, path, 'Missing schema value')
  return copyValue(entry.value)
}
function writeSpec(snapshot: Snapshot, path: Path, node: SchemaNode): void {
  setValue(snapshot, [...path, 'nodeKind'], node.nodeKind)
  setValue(snapshot, [...path, 'presenceMode'], node.presence.mode)
  setValue(snapshot, [...path, 'description'], node.description)
  for (const [key, value] of Object.entries(node.metadata))
    setValue(snapshot, [...path, 'metadata', key], value)
  if (node.nodeKind === 'leaf') {
    setValue(snapshot, [...path, 'valueKind'], node.valueKind)
    if (node.presence.mode === 'defaulted')
      setValue(
        snapshot,
        [...path, 'defaultValue'],
        node.presence.defaultValue,
        node.valueKind === 'ref',
      )
  } else if (node.nodeKind === 'struct') {
    setValue(snapshot, [...path, 'allowCustom'], node.allowCustom)
    for (const [key, field] of Object.entries(node.fields))
      writeSpec(snapshot, [...path, 'fields', key], field)
  } else writeSpec(snapshot, [...path, 'valueSchema'], node.valueSchema)
}
function readSpec(snapshot: Snapshot, path: Path, commitId: CommitHash): SchemaNode {
  const nodeKind = val(snapshot, [...path, 'nodeKind'], commitId)
  const mode = val(snapshot, [...path, 'presenceMode'], commitId)
  const description = val(snapshot, [...path, 'description'], commitId)
  const metadata: Record<string, Value> = Object.create(null)
  for (const key of childKeys(snapshot, [...path, 'metadata']))
    metadata[key] = val(snapshot, [...path, 'metadata', key], commitId)
  let node: unknown
  if (nodeKind === 'leaf') {
    const valueKind = val(snapshot, [...path, 'valueKind'], commitId)
    const entry = getEntry(snapshot, [...path, 'defaultValue'])
    if (mode === 'defaulted' && !entry) corrupt(commitId, path, 'Missing schema default')
    node = {
      nodeKind,
      valueKind,
      presence:
        mode === 'defaulted'
          ? { mode, defaultValue: entry!.entryKind === 'val' ? entry!.value : entry!.ref }
          : { mode },
      description,
      metadata,
    }
  } else if (nodeKind === 'struct') {
    const fields: Record<string, SchemaNode> = Object.create(null)
    for (const key of childKeys(snapshot, [...path, 'fields']))
      fields[key] = readSpec(snapshot, [...path, 'fields', key], commitId)
    node = {
      nodeKind,
      fields,
      allowCustom: val(snapshot, [...path, 'allowCustom'], commitId),
      presence: { mode },
      description,
      metadata,
    }
  } else if (nodeKind === 'map') {
    node = {
      nodeKind,
      valueSchema: readSpec(snapshot, [...path, 'valueSchema'], commitId),
      presence: { mode },
      description,
      metadata,
    }
  } else corrupt(commitId, path, 'Unknown schema node kind')
  try {
    return cloneSchema(node as SchemaNode)
  } catch (cause) {
    if (cause instanceof SchemaFailure) corrupt(commitId, path, cause.message)
    throw cause
  }
}
export function writeCustomSpec(snapshot: Snapshot, path: Path, spec: LeafSchemaNode): void {
  deleteTree(snapshot, [...path, '$spec'])
  writeSpec(snapshot, [...path, '$spec'], spec)
}
export function readCustomSpec(
  snapshot: Snapshot,
  path: Path,
  commitId: CommitHash,
): LeafSchemaNode {
  const spec = readSpec(snapshot, [...path, '$spec'], commitId)
  if (spec.nodeKind !== 'leaf') corrupt(commitId, path, 'Custom spec is not a leaf')
  return spec
}
export function writeCatalog(snapshot: Snapshot, catalog: Catalog): void {
  deleteTree(snapshot, ['$schemas'])
  setValue(snapshot, ['$schemas', '$version'], 1)
  for (const [key, root] of catalog.roots)
    writeSpec(snapshot, ['$schemas', 'roots', key], root.schema)
  for (const [kind, spec] of catalog.messages)
    writeSpec(snapshot, ['$schemas', 'messages', kind], spec)
}
export function readCatalog(snapshot: Snapshot, commitId: CommitHash): Catalog {
  const catalog = emptyCatalog()
  if (val(snapshot, ['$schemas', '$version'], commitId) !== 1)
    corrupt(commitId, ['$schemas'], 'Unsupported schema version')
  for (const key of childKeys(snapshot, ['$schemas', 'roots'])) {
    let path: Path
    try {
      path = decodePathKey(key)
    } catch {
      corrupt(commitId, ['$schemas', 'roots', key], 'Invalid root path encoding')
    }
    if (!path.length) corrupt(commitId, path, 'Empty schema root')
    for (const segment of path) assertIdentifier(segment)
    for (const root of catalog.roots.values()) {
      const a = encodePathKey(root.path),
        b = encodePathKey(path)
      if (a.startsWith(b) || b.startsWith(a)) corrupt(commitId, path, 'Overlapping schema roots')
    }
    catalog.roots.set(key, {
      path,
      schema: readSpec(snapshot, ['$schemas', 'roots', key], commitId),
    })
  }
  for (const kind of childKeys(snapshot, ['$schemas', 'messages'])) {
    assertIdentifier(kind)
    const spec = readSpec(snapshot, ['$schemas', 'messages', kind], commitId)
    function validMessage(node: SchemaNode): boolean {
      return node.nodeKind === 'leaf'
        ? node.valueKind !== 'ref'
        : node.nodeKind === 'struct'
          ? !node.allowCustom && Object.values(node.fields).every(validMessage)
          : validMessage(node.valueSchema)
    }
    if (spec.nodeKind !== 'struct' || !validMessage(spec))
      corrupt(commitId, ['$schemas', 'messages', kind], 'Invalid message schema')
    catalog.messages.set(kind, spec as MessageStructSchemaNode)
  }
  return catalog
}
export function cloneCatalog(catalog: Catalog): Catalog {
  return {
    roots: new Map(
      [...catalog.roots].map(([key, root]) => [
        key,
        { path: Object.freeze([...root.path]), schema: cloneSchema(root.schema) },
      ]),
    ),
    messages: new Map(
      [...catalog.messages].map(([kind, node]) => [
        kind,
        cloneSchema(node) as MessageStructSchemaNode,
      ]),
    ),
  }
}
export function effectiveCatalog(reader: Catalog, writer: Catalog, keepDormant: boolean): Catalog {
  if (!keepDormant) return cloneCatalog(reader)
  function merge(r: SchemaNode, w: SchemaNode | undefined): SchemaNode {
    if (r.nodeKind === 'struct' && w?.nodeKind === 'struct') {
      const fields = Object.assign(Object.create(null), w.fields) as Record<string, SchemaNode>
      for (const [key, node] of Object.entries(r.fields)) fields[key] = merge(node, w.fields[key])
      // Keeping a Writer-only required field makes the merged struct physically
      // required even when the Reader struct is defaulted; a defaulted struct
      // cannot contain required fields. Reader presence semantics stay on the
      // Reader catalog, so only the physical merged catalog is tightened.
      return cloneSchema({ ...r, fields, presence: mergedStructPresence(r, fields) })
    }
    if (r.nodeKind === 'map' && w?.nodeKind === 'map')
      return cloneSchema({ ...r, valueSchema: merge(r.valueSchema, w.valueSchema) })
    return cloneSchema(r)
  }
  const result = cloneCatalog(writer)
  for (const [key, root] of reader.roots) {
    for (const other of result.roots.keys()) {
      if (other !== key && (other.startsWith(key) || key.startsWith(other))) {
        throw new SchemaFailure({
          kind: 'schema_conflict',
          path: root.path,
          reason: 'overlapping_root_path',
        })
      }
    }
    result.roots.set(key, {
      path: root.path,
      schema: merge(root.schema, writer.roots.get(key)?.schema),
    })
  }
  for (const [kind, schema] of reader.messages) result.messages.set(kind, schema)
  return result
}
/**
 * Presence of a merged struct must satisfy the physical catalog contract:
 * `optional` stays optional, and any retained `required` field forces
 * `required`. A defaulted Reader struct keeps `defaulted` only when every
 * merged field is defaulted or optional.
 */
function mergedStructPresence(
  reader: Extract<SchemaNode, { nodeKind: 'struct' }>,
  fields: Readonly<Record<string, SchemaNode>>,
): Extract<SchemaNode, { nodeKind: 'struct' }>['presence'] {
  if (reader.presence.mode === 'optional') return reader.presence
  for (const field of Object.values(fields))
    if (field.presence.mode === 'required') return { mode: 'required' }
  return reader.presence
}
export function schemaAt(catalog: Catalog, path: Path): SchemaNode | undefined {
  return findSchema(catalog, path, false)
}
export function physicalSchemaAt(catalog: Catalog, path: Path): SchemaNode | undefined {
  return findSchema(catalog, path, true)
}
function findSchema(catalog: Catalog, path: Path, concrete: boolean): SchemaNode | undefined {
  for (const root of catalog.roots.values()) {
    if (!root.path.every((p, i) => p === path[i])) continue
    let spec: SchemaNode | undefined = root.schema
    for (const key of path.slice(root.path.length)) {
      if (!spec) return undefined
      spec =
        spec.nodeKind === 'struct'
          ? spec.fields[key]
          : spec.nodeKind === 'map' && (concrete || key === '*')
            ? spec.valueSchema
            : undefined
    }
    return spec
  }
  return undefined
}
export function typeCompatible(a: SchemaNode, b: SchemaNode): boolean {
  return (
    a.nodeKind === b.nodeKind &&
    (a.nodeKind !== 'leaf' || b.nodeKind !== 'leaf' || a.valueKind === b.valueKind)
  )
}
export function resolvePresence(
  snapshot: Snapshot,
  path: Path,
  reader: SchemaNode,
  writer: SchemaNode | undefined,
  commitId: CommitHash,
  virtual = false,
  entry = false,
): 'physical' | 'virtual' | 'absent' {
  const physical = !virtual && hasNode(snapshot, path, reader)
  if (physical) {
    if (writer && !typeCompatible(reader, writer))
      throw new SchemaFailure({
        kind: 'schema_type_mismatch',
        commitId,
        path,
        expectedKind: reader.nodeKind === 'leaf' ? reader.valueKind : reader.nodeKind,
        actualKind: writer.nodeKind === 'leaf' ? writer.valueKind : writer.nodeKind,
      })
    if (reader.nodeKind !== 'leaf') {
      const anchor = getEntry(snapshot, [...path, '$exists'])!
      if (anchor.entryKind !== 'val' || anchor.value !== true)
        corrupt(commitId, path, 'Container anchor must equal true')
    }
    return 'physical'
  }
  // A kind change can leave a different physical discriminator at this path.
  if (!virtual && writer && hasNode(snapshot, path, writer) && !typeCompatible(reader, writer)) {
    throw new SchemaFailure({
      kind: 'schema_type_mismatch',
      commitId,
      path,
      expectedKind: reader.nodeKind,
      actualKind: writer.nodeKind === 'leaf' ? writer.valueKind : writer.nodeKind,
    })
  }
  if (entry) return 'absent'
  if (!virtual && writer && writer.presence.mode !== 'optional')
    corrupt(commitId, path, 'Writer requires a physically present node')
  if (reader.presence.mode === 'optional') return 'absent'
  if (reader.presence.mode === 'defaulted') return 'virtual'
  throw new SchemaFailure({ kind: 'unmigrated_required_field', commitId, path })
}
export function readNode(
  snapshot: Snapshot,
  path: Path,
  reader: SchemaNode,
  writer: SchemaNode | undefined,
  commitId: CommitHash,
  virtual = false,
  entry = false,
): Option<unknown> {
  const state = resolvePresence(snapshot, path, reader, writer, commitId, virtual, entry)
  if (state === 'absent') return NONE
  const isVirtual = state === 'virtual'
  if (reader.nodeKind === 'leaf') {
    const value =
      isVirtual && reader.presence.mode === 'defaulted'
        ? reader.presence.defaultValue
        : (() => {
            const raw = getEntry(snapshot, [...path, '$val'])!
            if ((reader.valueKind === 'ref') !== (raw.entryKind === 'ref'))
              corrupt(commitId, path, 'Wrong leaf entry kind')
            return raw.entryKind === 'val' ? raw.value : raw.ref
          })()
    try {
      validateValue(reader, value, path)
    } catch (cause) {
      if (cause instanceof SchemaFailure) corrupt(commitId, path, cause.message)
      throw cause
    }
    return some(copyValue(value))
  }
  const result: Record<string, unknown> = Object.create(null)
  if (reader.nodeKind === 'map') {
    if (!isVirtual)
      for (const key of childKeys(snapshot, path).filter((k) => k !== '$exists')) {
        assertIdentifier(key)
        const child = readNode(
          snapshot,
          [...path, key],
          reader.valueSchema,
          writer?.nodeKind === 'map' ? writer.valueSchema : undefined,
          commitId,
          false,
          true,
        )
        if (child.kind === 'none')
          corrupt(commitId, [...path, key], 'Map entry has no discriminator')
        result[key] = child.value
      }
  } else {
    for (const [key, field] of Object.entries(reader.fields)) {
      const child = readNode(
        snapshot,
        [...path, key],
        field,
        writer?.nodeKind === 'struct' ? writer.fields[key] : undefined,
        commitId,
        isVirtual,
      )
      result[key] =
        field.presence.mode === 'optional' ? child : child.kind === 'some' ? child.value : undefined
    }
    if (reader.allowCustom) {
      const custom: Record<string, unknown> = Object.create(null)
      if (!isVirtual)
        for (const key of childKeys(snapshot, [...path, '$custom'])) {
          assertIdentifier(key)
          if (Object.hasOwn(reader.fields, key)) continue // Pending promotion is inspected faithfully through Writer Schema.
          const at = [...path, '$custom', key]
          const spec = readCustomSpec(snapshot, at, commitId)
          const value = readNode(snapshot, at, spec, spec, commitId)
          if (value.kind === 'none') corrupt(commitId, at, 'Custom value is absent')
          custom[key] = Object.freeze({ value: value.value, meta: readMeta(snapshot, at), spec })
        }
      result.$custom = Object.freeze(custom)
    }
  }
  return some(Object.freeze(result))
}
function inputRecord(input: unknown, path: Path): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input instanceof Uint8Array
  )
    failValidation(path, 'type_mismatch', 'Expected an input dictionary')
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null)
    failValidation(path, 'type_mismatch', 'Expected a plain input dictionary')
  return input as Record<string, unknown>
}
export function unwrapOptional(input: unknown): unknown {
  return isOption(input) ? (input.kind === 'none' ? null : input.value) : input
}
export function materializeDefaultNode(snapshot: Snapshot, path: Path, spec: SchemaNode): void {
  if (spec.presence.mode !== 'defaulted') return
  if (spec.nodeKind === 'leaf' && spec.presence.mode === 'defaulted') {
    setValue(snapshot, [...path, '$val'], spec.presence.defaultValue, spec.valueKind === 'ref')
  } else if (spec.nodeKind !== 'leaf') {
    setValue(snapshot, [...path, '$exists'], true)
    if (spec.nodeKind === 'struct')
      for (const [key, node] of Object.entries(spec.fields))
        materializeDefaultNode(snapshot, [...path, key], node)
  }
}
export function writeNode(
  snapshot: Snapshot,
  path: Path,
  spec: SchemaNode,
  input: unknown,
  mode: 'replace' | 'scoped' = 'replace',
  scope?: ReadonlySet<string>,
  knownSpec: SchemaNode = spec,
): void {
  if (spec.presence.mode === 'optional') input = unwrapOptional(input)
  if (input === null || input === undefined) {
    if (spec.presence.mode === 'optional') {
      deleteTree(snapshot, path)
      return
    }
    if (input === undefined && spec.presence.mode === 'defaulted') {
      deleteTree(snapshot, path)
      materializeDefaultNode(snapshot, path, spec)
      return
    }
    failValidation(path, 'missing_required_field', 'Node requires a value')
  }
  if (spec.nodeKind === 'leaf') {
    // Migration values can explicitly carry leaf metadata.
    if (typeof input === 'object' && input !== null && Object.hasOwn(input, '$val')) {
      const wrapped = input as { $val: unknown; $meta?: SchemaMetaMap }
      validateValue(spec, wrapped.$val, path)
      setValue(snapshot, [...path, '$val'], wrapped.$val, spec.valueKind === 'ref')
      if (wrapped.$meta)
        for (const [key, value] of Object.entries(wrapped.$meta))
          setValue(snapshot, [...path, '$meta', key], value)
      return
    }
    validateValue(spec, input, path)
    setValue(snapshot, [...path, '$val'], input, spec.valueKind === 'ref')
    return
  }
  const record = inputRecord(input, path)
  const existed = hasNode(snapshot, path, spec)
  if (mode === 'replace') deleteTree(snapshot, path)
  setValue(snapshot, [...path, '$exists'], true)
  if (spec.nodeKind === 'map') {
    if (mode === 'scoped')
      for (const key of childKeys(snapshot, path))
        if (key !== '$exists' && !Object.hasOwn(record, key)) deleteTree(snapshot, [...path, key])
    for (const [key, value] of Object.entries(record)) {
      assertIdentifier(key)
      // Membership itself is required: optional/defaulted value schema never creates ghost members.
      if (value === undefined || value === null)
        failValidation([...path, key], 'missing_required_field', 'Map entry needs a value')
      const entrySpec: SchemaNode = { ...spec.valueSchema, presence: { mode: 'required' } }
      writeNode(
        snapshot,
        [...path, key],
        entrySpec,
        value,
        'scoped',
        undefined,
        knownSpec.nodeKind === 'map' ? knownSpec.valueSchema : spec.valueSchema,
      )
    }
    return
  }
  const fields = knownSpec.nodeKind === 'struct' ? knownSpec.fields : spec.fields
  const allowed = scope ?? new Set(Object.keys(fields))
  for (const key of Object.keys(record)) {
    if (!allowed.has(key) || !Object.hasOwn(spec.fields, key))
      failValidation([...path, key], 'type_mismatch', 'Field is outside lens scope')
  }
  for (const [key, child] of Object.entries(spec.fields)) {
    const at = [...path, key]
    if (!allowed.has(key)) {
      if (!existed || mode === 'replace') {
        if (child.presence.mode === 'required')
          failValidation(
            at,
            'missing_required_field',
            'Required field outside scope cannot be initialized',
          )
        materializeDefaultNode(snapshot, at, child)
      }
      continue
    }
    const knownChild = fields[key] ?? child
    const value = Object.hasOwn(record, key) ? record[key] : undefined
    if (value === undefined) {
      if (knownChild.presence.mode === 'required')
        failValidation(at, 'missing_required_field', 'Required field omitted')
      if (
        mode === 'scoped' &&
        knownChild.presence.mode === 'defaulted' &&
        child.nodeKind === 'struct' &&
        hasNode(snapshot, at, child)
      ) {
        writeNode(snapshot, at, child, {}, 'scoped', undefined, knownChild)
      } else {
        deleteTree(snapshot, at)
        materializeDefaultNode(snapshot, at, child)
      }
    } else {
      writeNode(snapshot, at, child, value, 'scoped', undefined, knownChild)
    }
  }
}
export function inspectNode(
  snapshot: Snapshot,
  path: Path,
  writer: SchemaNode,
  reader: SchemaNode | undefined,
  commitId: CommitHash,
): Option<HistoricalNodeInspection> {
  const presence = resolvePresence(snapshot, path, writer, writer, commitId)
  if (presence === 'absent') {
    if (getEntry(snapshot, path) || childKeys(snapshot, path).length)
      corrupt(commitId, path, 'Absent node contains orphan data')
    return NONE
  }
  if (getEntry(snapshot, path)) corrupt(commitId, path, 'Logical nodes must be directories')
  if (writer.nodeKind !== 'map') {
    for (const key of childKeys(snapshot, path)) {
      const allowed =
        writer.nodeKind === 'leaf'
          ? key === '$val' || key === '$meta' || (key === '$spec' && path.at(-2) === '$custom')
          : key === '$exists' || key === '$custom' || Object.hasOwn(writer.fields, key)
      if (!allowed) corrupt(commitId, [...path, key], 'Field is not declared in Writer Schema')
    }
  }
  if (writer.nodeKind === 'leaf') {
    const value = readNode(snapshot, path, writer, writer, commitId)
    if (value.kind === 'none') return NONE
    return some(
      Object.freeze({
        nodeKind: 'leaf',
        path: Object.freeze([...path]),
        writerSpec: cloneSchema(writer) as LeafSchemaNode,
        value: value.value as Value | StateRef,
        meta: readMeta(snapshot, path),
      }),
    )
  }
  if (writer.nodeKind === 'map') {
    const entries: Record<string, HistoricalNodeInspection> = Object.create(null)
    for (const key of childKeys(snapshot, path).filter((k) => k !== '$exists')) {
      assertIdentifier(key)
      const child = inspectNode(
        snapshot,
        [...path, key],
        writer.valueSchema,
        reader?.nodeKind === 'map' ? reader.valueSchema : undefined,
        commitId,
      )
      if (child.kind === 'none') corrupt(commitId, [...path, key], 'Map entry is absent')
      entries[key] = child.value
    }
    return some(
      Object.freeze({
        nodeKind: 'map',
        path: Object.freeze([...path]),
        writerSpec: cloneSchema(writer),
        entries: Object.freeze(entries),
      }),
    )
  }
  const fields: Record<string, Option<HistoricalNodeInspection>> = Object.create(null)
  const customFields: Record<
    string,
    { value: Value | StateRef; meta: SchemaMetaMap; spec: LeafSchemaNode }
  > = Object.create(null)
  for (const [key, child] of Object.entries(writer.fields))
    fields[key] = inspectNode(
      snapshot,
      [...path, key],
      child,
      reader?.nodeKind === 'struct' ? reader.fields[key] : undefined,
      commitId,
    )
  for (const key of childKeys(snapshot, [...path, '$custom'])) {
    assertIdentifier(key)
    if (!writer.allowCustom || Object.hasOwn(writer.fields, key))
      corrupt(commitId, path, 'Invalid or shadowing custom field')
    const at = [...path, '$custom', key],
      spec = readCustomSpec(snapshot, at, commitId)
    const value = readNode(snapshot, at, spec, spec, commitId)
    if (value.kind === 'none') corrupt(commitId, at, 'Custom value missing')
    customFields[key] = Object.freeze({
      value: value.value as Value | StateRef,
      meta: readMeta(snapshot, at),
      spec,
    })
  }
  return some(
    Object.freeze({
      nodeKind: 'struct',
      path: Object.freeze([...path]),
      writerSpec: cloneSchema(writer),
      fields: Object.freeze(fields),
      dormantFieldKeys: Object.freeze(
        Object.keys(writer.fields).filter(
          (key) => reader?.nodeKind !== 'struct' || !Object.hasOwn(reader.fields, key),
        ),
      ),
      customFields: Object.freeze(customFields),
    }),
  )
}
export function inspectAt(
  snapshot: Snapshot,
  writer: Catalog,
  reader: Catalog,
  commitId: CommitHash,
  path: Path,
): Option<HistoricalNodeInspection> {
  for (const root of writer.roots.values()) {
    if (!root.path.every((key, i) => path[i] === key)) continue
    let spec: SchemaNode = root.schema
    let at = [...root.path]
    // Validate ancestors before navigating, so absent optional/map members short-circuit.
    for (const key of path.slice(root.path.length)) {
      if (resolvePresence(snapshot, at, spec, spec, commitId) === 'absent') return NONE
      if (spec.nodeKind === 'struct') {
        const child: SchemaNode | undefined = spec.fields[key]
        if (!child) return NONE
        spec = child
      } else if (spec.nodeKind === 'map') {
        spec = spec.valueSchema
        if (!hasNode(snapshot, [...at, key], spec)) return NONE
      } else return NONE
      at = [...at, key]
    }
    return inspectNode(snapshot, path, spec, physicalSchemaAt(reader, path), commitId)
  }
  return NONE
}
export function validateSnapshot(snapshot: Snapshot, catalog: Catalog, commitId: CommitHash): void {
  for (const root of catalog.roots.values())
    inspectNode(snapshot, root.path, root.schema, root.schema, commitId)
}
/** Compare final leaves, coalescing complete subtree removals into directory deletes. */
export function compileDiff(before: Snapshot, after: Snapshot): StateDiff {
  const removed = new Set<string>()
  for (const key of before.keys()) if (!after.has(key)) removed.add(key)
  const deleted: Path[] = []
  const keysAfter = [...after.keys()]
  for (const key of removed) {
    const path = decodePathKey(key)
    let candidate = path
    for (let len = 1; len < path.length; len++) {
      const parent = path.slice(0, len),
        prefix = encodePathKey(parent)
      if (!keysAfter.some((k) => k.startsWith(prefix))) {
        candidate = parent
        break
      }
    }
    if (!deleted.some((p) => encodePathKey(candidate).startsWith(encodePathKey(p))))
      deleted.push(candidate)
  }
  const diff: Array<StateDiff[number]> = deleted.map((path) => ({ op: 'del', path }))
  for (const [key, entry] of after) {
    const previous = before.get(key)
    if (previous && leafEntryEquals(previous, entry)) continue
    const path = decodePathKey(key)
    diff.push(
      entry.entryKind === 'val'
        ? { op: 'set', path, value: copyValue(entry.value) }
        : { op: 'ref', path, ref: copyValue(entry.ref) },
    )
  }
  return Object.freeze(diff.sort((a, b) => comparePaths(a.path, b.path)))
}
