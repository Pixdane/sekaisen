import type { Option, Result } from '@sekaisen/core'
import { err, isOption, NONE, ok, some } from '@sekaisen/core'
import type { CommitHash, Path, ScalarValue, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { cloneSchema, SchemaFailure } from './builders.ts'
import type { Catalog, Snapshot, StateReader } from './runtime.ts'
import {
  childKeys,
  cloneSnapshot,
  copyValue,
  corrupt,
  deleteTree,
  effectiveCatalog,
  getEntry,
  hasNode,
  inspectAt,
  materializeDefaultNode,
  physicalSchemaAt,
  readCustomSpec,
  readMeta,
  validateSnapshot,
  writeCatalog,
  writeNode,
} from './runtime.ts'
import type {
  BackfillableSchemaDrift,
  CompatiblePresenceDrift,
  DormantSchemaDrift,
  HistoricalNodeInspection,
  IncompatibleSchemaDrift,
  LeafSchemaNode,
  MapSchemaNode,
  MigrationInputValue,
  NodeMigrationFn,
  PromotedCustomFieldDrift,
  SchemaDriftReport,
  SchemaError,
  SchemaMetaMap,
  SchemaNode,
  StructSchemaNode,
  SyncSchemaOptions,
} from './types.ts'

/* -------------------------------------------------------------------------- */
/*                              Internal analysis                            */
/* -------------------------------------------------------------------------- */

interface BackfillRecord {
  schemaPath: Path
  reason: BackfillableSchemaDrift['reason']
  targetSpec: SchemaNode
  nodePaths: Path[]
}

interface CompatibleRecord {
  schemaPath: Path
  reason: CompatiblePresenceDrift['reason']
  targetSpec: SchemaNode
}

interface PromotionRecord {
  structSchemaPath: Path
  fieldKey: string
  targetLeafSpec: LeafSchemaNode
  instancePaths: Path[]
}

interface DormantRecord {
  schemaPath: Path
  writerSpec: SchemaNode
  nodePaths: Path[]
}

interface IncompatRecord {
  schemaPath: Path
  reason: IncompatibleSchemaDrift['reason']
  writerSpec: SchemaNode | undefined
  readerSpec: SchemaNode
  instancePaths: Path[]
}

interface Analysis {
  backfillable: BackfillRecord[]
  compatible: CompatibleRecord[]
  promoted: PromotionRecord[]
  dormant: DormantRecord[]
  incompatibilities: IncompatRecord[]
}

interface PromotionSite {
  readonly fieldKey: string
  readonly parentInstances: readonly Path[]
}

const CUSTOM_SEGMENT = '$custom'
const MESSAGE_PATH: Path = ['$schemas', 'messages']

/**
 * In-memory accumulator for drift findings. Findings are keyed by schema path
 * (and reason / field), so repeated instances aggregate instead of flooding the
 * report. All arrays are emitted in a deterministic order.
 */
class DriftSink {
  private readonly backfills = new Map<string, BackfillRecord>()
  private readonly compatibles = new Map<string, CompatibleRecord>()
  private readonly promotions = new Map<string, PromotionRecord>()
  private readonly dormants = new Map<string, DormantRecord>()
  private readonly incompatibilities = new Map<string, IncompatRecord>()

  backfillable(
    schemaPath: Path,
    reason: BackfillableSchemaDrift['reason'],
    targetSpec: SchemaNode,
    nodePaths: readonly Path[],
  ): void {
    const key = `${encodePathKey(schemaPath)}\u0000${reason}`
    const existing = this.backfills.get(key)
    if (existing) {
      existing.nodePaths.push(...nodePaths)
      return
    }
    this.backfills.set(key, {
      schemaPath: [...schemaPath],
      reason,
      targetSpec,
      nodePaths: [...nodePaths],
    })
  }

  compatible(
    schemaPath: Path,
    reason: CompatiblePresenceDrift['reason'],
    targetSpec: SchemaNode,
  ): void {
    const key = `${encodePathKey(schemaPath)}\u0000${reason}`
    if (!this.compatibles.has(key)) {
      this.compatibles.set(key, { schemaPath: [...schemaPath], reason, targetSpec })
    }
  }

  promote(
    structSchemaPath: Path,
    fieldKey: string,
    targetLeafSpec: LeafSchemaNode,
    instancePath: Path,
  ): void {
    const key = `${encodePathKey(structSchemaPath)}\u0000${fieldKey}`
    const existing = this.promotions.get(key)
    if (existing) {
      existing.instancePaths.push(instancePath)
      return
    }
    this.promotions.set(key, {
      structSchemaPath: [...structSchemaPath],
      fieldKey,
      targetLeafSpec,
      instancePaths: [instancePath],
    })
  }

  dormant(schemaPath: Path, writerSpec: SchemaNode, nodePaths: readonly Path[]): void {
    const key = encodePathKey(schemaPath)
    const existing = this.dormants.get(key)
    if (existing) {
      existing.nodePaths.push(...nodePaths)
      return
    }
    this.dormants.set(key, { schemaPath: [...schemaPath], writerSpec, nodePaths: [...nodePaths] })
  }

  incompatible(
    schemaPath: Path,
    reason: IncompatibleSchemaDrift['reason'],
    writerSpec: SchemaNode | undefined,
    readerSpec: SchemaNode,
    instancePaths: readonly Path[],
  ): void {
    const key = `${encodePathKey(schemaPath)}\u0000${reason}`
    const existing = this.incompatibilities.get(key)
    if (existing) {
      existing.instancePaths.push(...instancePaths)
      return
    }
    this.incompatibilities.set(key, {
      schemaPath: [...schemaPath],
      reason,
      writerSpec,
      readerSpec,
      instancePaths: [...instancePaths],
    })
  }

  finish(): Analysis {
    const backfillable = [...this.backfills.values()]
      .map((record) => ({ ...record, nodePaths: uniquePaths(record.nodePaths) }))
      .sort(
        (a, b) => comparePathKeys(a.schemaPath, b.schemaPath) || compareStrings(a.reason, b.reason),
      )
    const compatible = [...this.compatibles.values()].sort(
      (a, b) => comparePathKeys(a.schemaPath, b.schemaPath) || compareStrings(a.reason, b.reason),
    )
    const promoted = [...this.promotions.values()]
      .map((record) => ({ ...record, instancePaths: uniquePaths(record.instancePaths) }))
      .sort(
        (a, b) =>
          comparePathKeys(a.structSchemaPath, b.structSchemaPath) ||
          compareStrings(a.fieldKey, b.fieldKey),
      )
    const dormant = [...this.dormants.values()]
      .map((record) => ({ ...record, nodePaths: uniquePaths(record.nodePaths) }))
      .sort((a, b) => comparePathKeys(a.schemaPath, b.schemaPath))
    const incompatibilities = [...this.incompatibilities.values()]
      .map((record) => ({ ...record, instancePaths: uniquePaths(record.instancePaths) }))
      .sort(
        (a, b) => comparePathKeys(a.schemaPath, b.schemaPath) || compareStrings(a.reason, b.reason),
      )
    return { backfillable, compatible, promoted, dormant, incompatibilities }
  }
}

/* -------------------------------------------------------------------------- */
/*                              Public entry points                          */
/* -------------------------------------------------------------------------- */

/**
 * Compare the Writer Schema stored at `commitId` with the active Reader Schema.
 * Produces a deterministic report; dormant Writer-only definitions never make
 * an otherwise clean report dirty, all other active differences do.
 */
export function checkDrift(
  snapshot: StateReader,
  writer: Catalog,
  reader: Catalog,
  commitId: CommitHash,
): SchemaDriftReport {
  return buildReport(commitId, analyze(snapshot, writer, reader, commitId))
}

/**
 * Apply every drift transition to an in-memory clone of `snapshot`, validate it
 * against the full target catalog (dormant definitions included when kept), and
 * return both the migrated snapshot and that catalog. Never writes storage.
 *
 * All reads used by migration functions are bound to the immutable pre-migration
 * `snapshot`, so the result is independent of migration execution order.
 */
export function migrateSnapshot(
  snapshot: Snapshot,
  writer: Catalog,
  reader: Catalog,
  commitId: CommitHash,
  options: SyncSchemaOptions,
): { snapshot: Snapshot; catalog: Catalog } {
  const analysis = analyze(snapshot, writer, reader, commitId)
  const report = buildReport(commitId, analysis)
  const migrations: Readonly<Record<string, NodeMigrationFn>> = options.fieldMigrations ?? {}
  const keepDormant = (options.dormantPolicy ?? 'keep') === 'keep'
  const target = effectiveCatalog(reader, writer, keepDormant)
  const draft = cloneSnapshot(snapshot)

  // Required converters are resolved up front, before the draft is mutated, so
  // a missing converter never leaves a partially migrated draft behind.
  const unhandled = analysis.incompatibilities.filter(
    (record) =>
      record.instancePaths.length > 0 &&
      !Object.hasOwn(migrations, encodePathKey(record.schemaPath)),
  )
  if (unhandled.length > 0) {
    migrationFailure(
      commitId,
      report,
      `Missing field migrations for ${unhandled.map((record) => displayPath(record.schemaPath)).join(', ')}`,
    )
  }

  for (const record of analysis.incompatibilities) {
    if (record.instancePaths.length === 0) continue
    const migration = migrations[encodePathKey(record.schemaPath)]
    if (!migration) continue
    for (const instancePath of record.instancePaths) {
      const fieldKey = record.schemaPath[record.schemaPath.length - 1]
      if (fieldKey === undefined) {
        throw new TypeError('Custom conflict schema path must end with a field key')
      }
      const oldInspection =
        record.reason === 'custom_field_type_conflict'
          ? inspectCustomLeaf(snapshot, instancePath.slice(0, -1), fieldKey, commitId)
          : inspectSource(snapshot, writer, reader, commitId, instancePath)
      const result = migration({
        targetNodePath: freezePath(instancePath),
        oldInspection,
        inspectBeforeMigration: (nodePath) =>
          inspectSourceResult(snapshot, writer, reader, commitId, nodePath),
      })
      if (!result.ok) {
        migrationFailure(commitId, report, `${displayPath(record.schemaPath)}: ${result.error}`)
      }
      if (record.reason === 'custom_field_type_conflict') {
        if (record.readerSpec.nodeKind !== 'leaf') {
          migrationFailure(
            commitId,
            report,
            `Custom promotion target ${displayPath(record.schemaPath)} is not a leaf`,
          )
        }
        applyPromotionValue(
          draft,
          snapshot,
          commitId,
          instancePath,
          record.readerSpec,
          true,
          result.value,
        )
        continue
      }
      // `writeNode` does not clear leaf subtrees in replace mode; a changed node
      // kind may have left a container behind, so remove the target first.
      deleteTree(draft, instancePath)
      writeNode(draft, instancePath, record.readerSpec, result.value, 'replace')
    }
  }

  for (const record of analysis.promoted) {
    const fieldSchemaPath: Path = [...record.structSchemaPath, record.fieldKey]
    const converter = migrations[encodePathKey(fieldSchemaPath)]
    for (const instancePath of record.instancePaths) {
      const targetPath: Path = [...instancePath, record.fieldKey]
      if (!converter) {
        applyPromotionValue(draft, snapshot, commitId, targetPath, record.targetLeafSpec, false)
        continue
      }
      const result = converter({
        targetNodePath: freezePath(targetPath),
        oldInspection: inspectCustomLeaf(snapshot, instancePath, record.fieldKey, commitId),
        inspectBeforeMigration: (nodePath) =>
          inspectSourceResult(snapshot, writer, reader, commitId, nodePath),
      })
      if (!result.ok) {
        migrationFailure(commitId, report, `${displayPath(fieldSchemaPath)}: ${result.error}`)
      }
      applyPromotionValue(
        draft,
        snapshot,
        commitId,
        targetPath,
        record.targetLeafSpec,
        true,
        result.value,
      )
    }
  }

  for (const record of analysis.backfillable) {
    for (const nodePath of record.nodePaths) {
      // The effective catalog may retain Writer-only defaulted fields under this
      // node; materializing only the Reader subtree would leave those retained
      // physical defaults missing and fail validation.
      const targetSpec = physicalSchemaAt(target, nodePath) ?? record.targetSpec
      if (hasNode(draft, nodePath, targetSpec)) continue
      materializeDefaultNode(draft, nodePath, targetSpec)
    }
  }

  if (!keepDormant) {
    for (const record of analysis.dormant) {
      for (const nodePath of record.nodePaths) pruneDormantPath(draft, reader, nodePath)
    }
  }

  writeCatalog(draft, target)
  validateSnapshot(draft, target, commitId)
  return { snapshot: draft, catalog: target }
}

/* -------------------------------------------------------------------------- */
/*                               Schema analysis                             */
/* -------------------------------------------------------------------------- */

function analyze(
  snapshot: StateReader,
  writer: Catalog,
  reader: Catalog,
  commitId: CommitHash,
): Analysis {
  const sink = new DriftSink()
  const activeRoots = new Set<string>()
  for (const [key, root] of reader.roots) {
    activeRoots.add(key)
    compareNode(
      snapshot,
      writer.roots.get(key)?.schema,
      root.schema,
      root.path,
      [root.path],
      sink,
      commitId,
    )
  }

  for (const [key, root] of writer.roots) {
    if (activeRoots.has(key)) continue
    const exists = hasNode(snapshot, root.path, root.schema)
    if (!exists && root.schema.presence.mode !== 'optional') {
      corrupt(commitId, root.path, 'Writer requires a physically present node')
    }
    sink.dormant(root.path, root.schema, exists ? [root.path] : [])
  }

  for (const [kind, schema] of reader.messages) {
    const previous = writer.messages.get(kind)
    const schemaPath: Path = [...MESSAGE_PATH, kind]
    // Message schemas are encoded declaratively; any edit requires a Writer
    // Schema sync but never touches stored state-tree data.
    if (!previous || !schemaEquals(previous, schema)) {
      sink.compatible(schemaPath, 'default_value_updated', schema as SchemaNode)
    }
  }
  for (const [kind, schema] of writer.messages) {
    if (!reader.messages.has(kind)) sink.dormant([...MESSAGE_PATH, kind], schema as SchemaNode, [])
  }

  return sink.finish()
}

/**
 * Compare one schema node, with `instancePaths` naming every concrete location
 * the node could occupy. Missing arrays (no parent instances) still compare the
 * schema itself, so structural drift is reported even without stored data.
 */
function compareNode(
  snapshot: StateReader,
  writerSpec: SchemaNode | undefined,
  readerSpec: SchemaNode,
  schemaPath: Path,
  instancePaths: readonly Path[],
  sink: DriftSink,
  commitId: CommitHash,
  site?: PromotionSite,
): void {
  const present = new Set<string>()
  for (const instancePath of instancePaths) {
    if (
      hasNode(snapshot, instancePath, readerSpec) ||
      (writerSpec !== undefined && hasNode(snapshot, instancePath, writerSpec))
    ) {
      present.add(encodePathKey(instancePath))
    }
  }
  const existsPaths = instancePaths.filter((path) => present.has(encodePathKey(path)))
  const missingPaths = instancePaths.filter((path) => !present.has(encodePathKey(path)))

  if (writerSpec === undefined) {
    addNode(snapshot, readerSpec, schemaPath, missingPaths, sink, commitId, site)
    return
  }

  // A Writer-declared required/defaulted node must be physically present.
  for (const instancePath of instancePaths) {
    if (!hasNode(snapshot, instancePath, writerSpec) && writerSpec.presence.mode !== 'optional') {
      corrupt(commitId, instancePath, 'Writer requires a physically present node')
    }
  }

  if (writerSpec.nodeKind !== readerSpec.nodeKind) {
    sink.incompatible(schemaPath, 'node_kind_changed', writerSpec, readerSpec, existsPaths)
    recordChangedTypeMissing(sink, writerSpec, readerSpec, schemaPath, missingPaths)
    return
  }
  if (
    writerSpec.nodeKind === 'leaf' &&
    readerSpec.nodeKind === 'leaf' &&
    writerSpec.valueKind !== readerSpec.valueKind
  ) {
    sink.incompatible(schemaPath, 'type_changed', writerSpec, readerSpec, existsPaths)
    recordChangedTypeMissing(sink, writerSpec, readerSpec, schemaPath, missingPaths)
    return
  }

  // Disabling custom fields is only compatible when no instance actually holds
  // custom data. Aggregate the concrete affected instances; a struct converter
  // keyed by this schema path must clear them.
  const customInstances =
    writerSpec.nodeKind === 'struct' &&
    readerSpec.nodeKind === 'struct' &&
    writerSpec.allowCustom &&
    !readerSpec.allowCustom
      ? existsPaths.filter(
          (instancePath) => childKeys(snapshot, [...instancePath, CUSTOM_SEGMENT]).length > 0,
        )
      : []
  if (customInstances.length > 0) {
    sink.incompatible(
      schemaPath,
      'custom_disabled_with_existing_instances',
      writerSpec,
      readerSpec,
      customInstances,
    )
  }
  noteDeclarative(sink, writerSpec, readerSpec, schemaPath, customInstances.length === 0)
  comparePresence(sink, writerSpec, readerSpec, schemaPath, missingPaths)

  if (writerSpec.nodeKind === 'leaf' && readerSpec.nodeKind === 'leaf') {
    if (
      writerSpec.presence.mode === 'defaulted' &&
      readerSpec.presence.mode === 'defaulted' &&
      !valueEquals(writerSpec.presence.defaultValue, readerSpec.presence.defaultValue)
    ) {
      sink.compatible(schemaPath, 'default_value_updated', readerSpec)
    }
    return
  }
  if (writerSpec.nodeKind === 'struct' && readerSpec.nodeKind === 'struct') {
    compareStruct(snapshot, writerSpec, readerSpec, schemaPath, existsPaths, sink, commitId)
    return
  }
  if (writerSpec.nodeKind === 'map' && readerSpec.nodeKind === 'map') {
    compareMap(snapshot, writerSpec, readerSpec, schemaPath, existsPaths, sink, commitId)
  }
}

/**
 * A type change must also account for slots that are physically absent: a
 * `defaulted` target is materialized, a `required` target needs a converter,
 * an `optional` target stays absent.
 */
function recordChangedTypeMissing(
  sink: DriftSink,
  writerSpec: SchemaNode,
  readerSpec: SchemaNode,
  schemaPath: Path,
  missingPaths: readonly Path[],
): void {
  if (missingPaths.length === 0) return
  if (readerSpec.presence.mode === 'optional') return
  if (readerSpec.presence.mode === 'defaulted') {
    sink.backfillable(schemaPath, 'optional_to_defaulted', readerSpec, missingPaths)
    return
  }
  sink.incompatible(
    schemaPath,
    'optional_tightened_to_required_with_missing_values',
    writerSpec,
    readerSpec,
    missingPaths,
  )
}

function addNode(
  snapshot: StateReader,
  readerSpec: SchemaNode,
  schemaPath: Path,
  missingPaths: readonly Path[],
  sink: DriftSink,
  commitId: CommitHash,
  site: PromotionSite | undefined,
): void {
  if (site && readerSpec.nodeKind === 'leaf') {
    const promoted: Path[] = []
    const conflicts: Path[] = []
    const missing: Path[] = []
    for (const parent of site.parentInstances) {
      const formalPath: Path = [...parent, site.fieldKey]
      const formalExists = hasNode(snapshot, formalPath, readerSpec)
      const customPath: Path = [...parent, CUSTOM_SEGMENT, site.fieldKey]
      const customExists = snapshot.hasEntry([...customPath, '$val'])
      if (!customExists) {
        if (!formalExists) missing.push(formalPath)
        continue
      }
      if (formalExists) corrupt(commitId, formalPath, 'Formal field and custom field coexist')
      const customSpec = readCustomSpec(snapshot, customPath, commitId)
      if (customSpec.valueKind === readerSpec.valueKind) promoted.push(parent)
      else conflicts.push(formalPath)
    }
    for (const parent of promoted) {
      sink.promote(schemaPath.slice(0, -1), site.fieldKey, readerSpec, parent)
    }
    if (conflicts.length > 0) {
      sink.incompatible(schemaPath, 'custom_field_type_conflict', undefined, readerSpec, conflicts)
    }
    applyAddedPresence(sink, readerSpec, schemaPath, missing)
    return
  }

  applyAddedPresence(sink, readerSpec, schemaPath, missingPaths)
}

function applyAddedPresence(
  sink: DriftSink,
  readerSpec: SchemaNode,
  schemaPath: Path,
  missingPaths: readonly Path[],
): void {
  switch (readerSpec.presence.mode) {
    case 'optional':
      sink.compatible(schemaPath, 'added_optional_node', readerSpec)
      return
    case 'defaulted':
      sink.backfillable(schemaPath, 'added_defaulted_node', readerSpec, missingPaths)
      return
    case 'required':
      sink.incompatible(
        schemaPath,
        'added_required_node_with_existing_instances',
        undefined,
        readerSpec,
        missingPaths,
      )
      return
  }
}

function comparePresence(
  sink: DriftSink,
  writerSpec: SchemaNode,
  readerSpec: SchemaNode,
  schemaPath: Path,
  missingPaths: readonly Path[],
): void {
  const writerMode = writerSpec.presence.mode
  const readerMode = readerSpec.presence.mode
  if (writerMode === readerMode) return
  // A keep-merged catalog raises a defaulted struct to `required` when it
  // retains a Writer-only required field; a defaulted struct may not contain
  // required fields. That physical tightening is a dormant artifact, not a
  // Reader-facing presence change, so it must not keep the report dirty.
  if (
    writerMode === 'required' &&
    readerMode === 'defaulted' &&
    writerSpec.nodeKind === 'struct' &&
    readerSpec.nodeKind === 'struct' &&
    retainsRequiredFields(writerSpec, readerSpec)
  ) {
    return
  }
  if (readerMode === 'optional') {
    sink.compatible(schemaPath, 'relaxed_to_optional', readerSpec)
    return
  }
  if (writerMode === 'optional' && readerMode === 'defaulted') {
    sink.backfillable(schemaPath, 'optional_to_defaulted', readerSpec, missingPaths)
    return
  }
  if (writerMode === 'optional' && readerMode === 'required') {
    if (missingPaths.length > 0) {
      sink.incompatible(
        schemaPath,
        'optional_tightened_to_required_with_missing_values',
        writerSpec,
        readerSpec,
        missingPaths,
      )
    } else {
      sink.compatible(schemaPath, 'default_value_updated', readerSpec)
    }
    return
  }
  // required <-> defaulted and defaulted -> required are benign presence
  // refinements once the instance is physically present; they still demand a
  // Writer Schema sync so ordinary commits cannot inherit a stale schema.
  sink.compatible(schemaPath, 'default_value_updated', readerSpec)
}

/**
 * True when `writer` forces a defaulted `reader` struct to be `required` only
 * through Writer-only required fields retained by the keep merge. Recognizes
 * the same recursive case as `effectiveCatalog`'s merged presence computation.
 */
function retainsRequiredFields(writer: StructSchemaNode, reader: StructSchemaNode): boolean {
  if (reader.presence.mode !== 'defaulted') return false
  for (const [key, writerField] of Object.entries(writer.fields)) {
    if (!Object.hasOwn(reader.fields, key)) {
      if (writerField.presence.mode === 'required') return true
      continue
    }
    const readerField = reader.fields[key]!
    if (
      writerField.nodeKind === 'struct' &&
      readerField.nodeKind === 'struct' &&
      retainsRequiredFields(writerField, readerField)
    ) {
      return true
    }
  }
  return false
}

function compareStruct(
  snapshot: StateReader,
  writer: StructSchemaNode,
  reader: StructSchemaNode,
  schemaPath: Path,
  structInstancePaths: readonly Path[],
  sink: DriftSink,
  commitId: CommitHash,
): void {
  for (const [fieldKey, readerField] of Object.entries(reader.fields)) {
    const writerField = Object.hasOwn(writer.fields, fieldKey) ? writer.fields[fieldKey] : undefined
    const fieldSchemaPath: Path = [...schemaPath, fieldKey]
    const fieldInstancePaths = structInstancePaths.map((instance) => [...instance, fieldKey])
    compareNode(
      snapshot,
      writerField,
      readerField,
      fieldSchemaPath,
      fieldInstancePaths,
      sink,
      commitId,
      { fieldKey, parentInstances: structInstancePaths },
    )
  }

  for (const [fieldKey, writerField] of Object.entries(writer.fields)) {
    if (Object.hasOwn(reader.fields, fieldKey)) continue
    const fieldSchemaPath: Path = [...schemaPath, fieldKey]
    const existing: Path[] = []
    for (const instance of structInstancePaths) {
      const fieldPath: Path = [...instance, fieldKey]
      if (hasNode(snapshot, fieldPath, writerField)) existing.push(fieldPath)
      else if (writerField.presence.mode !== 'optional') {
        corrupt(commitId, fieldPath, 'Writer requires a physically present node')
      }
    }
    sink.dormant(fieldSchemaPath, writerField, existing)
  }
}

function compareMap(
  snapshot: StateReader,
  writer: MapSchemaNode,
  reader: MapSchemaNode,
  schemaPath: Path,
  mapInstancePaths: readonly Path[],
  sink: DriftSink,
  commitId: CommitHash,
): void {
  const entryPaths: Path[] = []
  for (const mapPath of mapInstancePaths) {
    for (const key of childKeys(snapshot, mapPath)) {
      if (key.startsWith('$')) continue
      entryPaths.push([...mapPath, key])
    }
  }
  compareNode(
    snapshot,
    writer.valueSchema,
    reader.valueSchema,
    [...schemaPath, '*'],
    entryPaths,
    sink,
    commitId,
  )
}

function noteDeclarative(
  sink: DriftSink,
  writerSpec: SchemaNode,
  readerSpec: SchemaNode,
  schemaPath: Path,
  reportAllowCustom = true,
): void {
  let changed =
    writerSpec.description !== readerSpec.description ||
    !metaEquals(writerSpec.metadata, readerSpec.metadata)
  if (
    reportAllowCustom &&
    writerSpec.nodeKind === 'struct' &&
    readerSpec.nodeKind === 'struct' &&
    writerSpec.allowCustom !== readerSpec.allowCustom
  ) {
    changed = true
  }
  if (changed) sink.compatible(schemaPath, 'default_value_updated', readerSpec)
}

/* -------------------------------------------------------------------------- */
/*                                 Reporting                                 */
/* -------------------------------------------------------------------------- */

function buildReport(commitId: CommitHash, analysis: Analysis): SchemaDriftReport {
  const backfillableNodes: BackfillableSchemaDrift[] = analysis.backfillable.map((record) =>
    Object.freeze({
      schemaPath: freezePath(record.schemaPath),
      reason: record.reason,
      targetSpec: cloneSchema(record.targetSpec),
      backfillInstanceCount: record.nodePaths.length,
    }),
  )
  const compatibleChanges: CompatiblePresenceDrift[] = analysis.compatible.map((record) =>
    Object.freeze({
      schemaPath: freezePath(record.schemaPath),
      reason: record.reason,
      targetSpec: cloneSchema(record.targetSpec),
    }),
  )
  const promotedCustomFields: PromotedCustomFieldDrift[] = analysis.promoted.map((record) =>
    Object.freeze({
      structSchemaPath: freezePath(record.structSchemaPath),
      fieldKey: record.fieldKey,
      targetLeafSpec: cloneSchema(record.targetLeafSpec),
      instancePaths: Object.freeze(record.instancePaths.map(freezePath)),
    }),
  )
  const dormantSchemas: DormantSchemaDrift[] = analysis.dormant.map((record) =>
    Object.freeze({
      schemaPath: freezePath(record.schemaPath),
      writerSpec: cloneSchema(record.writerSpec),
      existingInstanceCount: record.nodePaths.length,
    }),
  )
  const incompatibilities: IncompatibleSchemaDrift[] = analysis.incompatibilities.map((record) =>
    Object.freeze({
      schemaPath: freezePath(record.schemaPath),
      reason: record.reason,
      writerSpec: record.writerSpec === undefined ? NONE : some(cloneSchema(record.writerSpec)),
      readerSpec: cloneSchema(record.readerSpec),
      affectedInstancePaths: Object.freeze(record.instancePaths.map(freezePath)),
    }),
  )
  return Object.freeze({
    commitId,
    isClean:
      backfillableNodes.length === 0 &&
      compatibleChanges.length === 0 &&
      promotedCustomFields.length === 0 &&
      incompatibilities.length === 0,
    backfillableNodes: Object.freeze(backfillableNodes),
    compatibleChanges: Object.freeze(compatibleChanges),
    promotedCustomFields: Object.freeze(promotedCustomFields),
    dormantSchemas: Object.freeze(dormantSchemas),
    incompatibilities: Object.freeze(incompatibilities),
  })
}

/* -------------------------------------------------------------------------- */
/*                            Migration helpers                              */
/* -------------------------------------------------------------------------- */

function migrationFailure(commitId: CommitHash, report: SchemaDriftReport, message: string): never {
  throw new SchemaFailure({
    kind: 'incompatible_schema_drift',
    commitId,
    incompatibilities: report.incompatibilities,
    migrationError: message,
  })
}

function applyPromotionValue(
  draft: Snapshot,
  source: StateReader,
  commitId: CommitHash,
  targetPath: Path,
  targetSpec: LeafSchemaNode,
  hasConverter: boolean,
  converterResult?: MigrationInputValue,
): void {
  const fieldKey = targetPath[targetPath.length - 1]
  if (fieldKey === undefined) {
    throw new TypeError('Custom promotion target path must end with a field key')
  }
  const customPath: Path = [...targetPath.slice(0, -1), CUSTOM_SEGMENT, fieldKey]
  const entry = getEntry(source, [...customPath, '$val'])
  if (!entry) corrupt(commitId, [...customPath, '$val'], 'Custom value is absent')
  const oldMeta = readMeta(source, customPath)

  if (!hasConverter) {
    writePromotedLeaf(
      draft,
      targetPath,
      targetSpec,
      entry.entryKind === 'ref' ? entry.ref : entry.value,
      oldMeta,
    )
    deleteTree(draft, customPath)
    return
  }

  const unwrapped =
    converterResult === undefined ? undefined : unwrapMigrationValue(converterResult)
  if (unwrapped === undefined) {
    if (targetSpec.presence.mode === 'optional') {
      // A converter may remove an optional promoted field by returning NONE.
      deleteTree(draft, targetPath)
      deleteTree(draft, customPath)
      return
    }
    // Undefined resets a defaulted node to its declared default (or is
    // rejected for required nodes) while preserving the promoted metadata.
    deleteTree(draft, targetPath)
    const resetValue =
      targetSpec.presence.mode === 'defaulted' && Object.keys(oldMeta).length > 0
        ? { $val: targetSpec.presence.defaultValue, $meta: oldMeta }
        : undefined
    writeNode(draft, targetPath, targetSpec, resetValue)
    deleteTree(draft, customPath)
    return
  }
  if (unwrapped === null && targetSpec.presence.mode === 'optional') {
    // A converter may remove an optional promoted field by returning null.
    deleteTree(draft, targetPath)
    deleteTree(draft, customPath)
    return
  }
  const { value, meta } = splitMigrationResult(unwrapped)
  const merged: SchemaMetaMap = meta ? { ...oldMeta, ...meta } : oldMeta
  writePromotedLeaf(draft, targetPath, targetSpec, value, merged)
  deleteTree(draft, customPath)
}

function writePromotedLeaf(
  draft: Snapshot,
  targetPath: Path,
  targetSpec: LeafSchemaNode,
  value: Value | StateRef,
  meta: SchemaMetaMap,
): void {
  deleteTree(draft, targetPath)
  writeNode(
    draft,
    targetPath,
    targetSpec,
    Object.keys(meta).length > 0 ? { $val: value, $meta: meta } : { $val: value },
    'replace',
  )
}

function unwrapMigrationValue(value: MigrationInputValue): MigrationInputValue | undefined {
  // Only values constructed by `some` / `NONE` are Options. Plain struct data
  // such as `{ kind: 'none' }` or `{ kind: 'some', value: 1 }` must survive.
  if (!isOption(value)) return value
  return value.kind === 'none' ? undefined : (value.value as MigrationInputValue)
}

function splitMigrationResult(value: MigrationInputValue): {
  value: Value | StateRef
  meta?: SchemaMetaMap
} {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    Object.hasOwn(value, '$val')
  ) {
    const wrapped = value as { readonly $val: Value | StateRef; readonly $meta?: SchemaMetaMap }
    return wrapped.$meta ? { value: wrapped.$val, meta: wrapped.$meta } : { value: wrapped.$val }
  }
  // A custom promotion target is a leaf, so remaining variants are leaf values
  // or StateRefs; non-leaf dictionaries are rejected by writeNode validation.
  const leafValue = value as Value | StateRef
  return { value: leafValue }
}

function inspectSource(
  source: StateReader,
  writer: Catalog,
  reader: Catalog,
  commitId: CommitHash,
  path: Path,
): Option<HistoricalNodeInspection> {
  const custom = splitCustomLeaf(path)
  if (custom) return inspectCustomLeaf(source, custom.instancePath, custom.key, commitId)
  return inspectAt(source, writer, reader, commitId, path)
}

function inspectSourceResult(
  source: StateReader,
  writer: Catalog,
  reader: Catalog,
  commitId: CommitHash,
  path: Path,
): Result<Option<HistoricalNodeInspection>, SchemaError> {
  try {
    return ok(inspectSource(source, writer, reader, commitId, path))
  } catch (cause) {
    if (cause instanceof SchemaFailure) return err(cause.error)
    throw cause
  }
}

function inspectCustomLeaf(
  source: StateReader,
  instancePath: Path,
  key: string,
  commitId: CommitHash,
): Option<HistoricalNodeInspection> {
  const customPath: Path = [...instancePath, CUSTOM_SEGMENT, key]
  const entry = getEntry(source, [...customPath, '$val'])
  if (!entry) return NONE
  const spec = cloneSchema(readCustomSpec(source, customPath, commitId))
  return some(
    Object.freeze({
      nodeKind: 'leaf' as const,
      path: freezePath(customPath),
      writerSpec: spec,
      value: entry.entryKind === 'ref' ? copyValue(entry.ref) : copyValue(entry.value),
      meta: readMeta(source, customPath),
    }),
  )
}

/** Split `[...instance, '$custom', key]` leaf inspection paths. */
function splitCustomLeaf(path: Path): { instancePath: Path; key: string } | undefined {
  const index = path.lastIndexOf(CUSTOM_SEGMENT)
  if (index < 0 || index !== path.length - 2) return undefined
  const key = path[index + 1]
  if (!key) return undefined
  return { instancePath: path.slice(0, index), key }
}

function isAncestorOfActiveRoot(reader: Catalog, path: Path): boolean {
  for (const root of reader.roots.values()) {
    if (root.path.length < path.length) continue
    if (path.every((segment, index) => root.path[index] === segment)) return true
  }
  return false
}

/**
 * Prune one dormant Writer path without discarding data the active Reader
 * Schema now covers. A dormant Writer root can become a field of an active
 * root (or vice versa), so root ancestry alone cannot decide what to delete.
 */
function pruneDormantPath(draft: Snapshot, reader: Catalog, path: Path): void {
  if (isAncestorOfActiveRoot(reader, path)) {
    // Active roots nested below a dormant ancestor keep their own subtrees.
    const prefix = encodePathKey(path)
    const activePrefixes = [...reader.roots.keys()]
    for (const key of [...draft.keys()]) {
      if (key.startsWith(prefix) && !activePrefixes.some((active) => key.startsWith(active)))
        draft.delete(key)
    }
    return
  }
  const activeSpec = physicalSchemaAt(reader, path)
  if (!activeSpec) {
    deleteTree(draft, path)
    return
  }
  pruneCoveredPath(draft, path, activeSpec)
}

/** Delete children under `path` that the active Reader Schema does not declare. */
function pruneCoveredPath(draft: Snapshot, path: Path, spec: SchemaNode): void {
  if (spec.nodeKind === 'leaf') {
    for (const key of childKeys(draft, path))
      if (key !== '$val' && key !== '$meta') deleteTree(draft, [...path, key])
    return
  }
  if (spec.nodeKind === 'map') {
    for (const key of childKeys(draft, path)) {
      if (key === '$exists') continue
      if (key.startsWith('$')) {
        deleteTree(draft, [...path, key])
        continue
      }
      pruneCoveredPath(draft, [...path, key], spec.valueSchema)
    }
    return
  }
  for (const key of childKeys(draft, path)) {
    if (key === '$exists') continue
    if (key === CUSTOM_SEGMENT) {
      if (!spec.allowCustom) {
        deleteTree(draft, [...path, key])
        continue
      }
      // A custom key that now shadows a formal field is not covered.
      for (const customKey of childKeys(draft, [...path, key]))
        if (Object.hasOwn(spec.fields, customKey)) deleteTree(draft, [...path, key, customKey])
      continue
    }
    const field = Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined
    if (!field) {
      deleteTree(draft, [...path, key])
      continue
    }
    pruneCoveredPath(draft, [...path, key], field)
  }
}

/* -------------------------------------------------------------------------- */
/*                             Generic utilities                             */
/* -------------------------------------------------------------------------- */

function freezePath(path: Path): Path {
  return Object.freeze([...path])
}

function uniquePaths(paths: readonly Path[]): Path[] {
  const unique = new Map<string, Path>()
  for (const path of paths) unique.set(encodePathKey(path), path)
  return [...unique.values()].sort(comparePathKeys)
}

function comparePathKeys(a: Path, b: Path): number {
  return compareStrings(encodePathKey(a), encodePathKey(b))
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function displayPath(path: Path): string {
  return `[${path.map((segment) => JSON.stringify(segment)).join(', ')}]`
}

function isStateRef(value: Value | StateRef): value is StateRef {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    return false
  }
  return 'commitId' in value && typeof value.commitId === 'string'
}

function scalarEquals(a: ScalarValue, b: ScalarValue): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) {
      return false
    }
    for (let index = 0; index < a.length; index++) {
      if (a[index] !== b[index]) return false
    }
    return true
  }
  return a === b
}

function valueEquals(a: Value | StateRef, b: Value | StateRef): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => scalarEquals(value, b[index]!))
  }
  if (isStateRef(a) || isStateRef(b)) {
    return (
      isStateRef(a) &&
      isStateRef(b) &&
      a.commitId === b.commitId &&
      a.path.length === b.path.length &&
      a.path.every((segment, index) => b.path[index] === segment)
    )
  }
  return scalarEquals(a as ScalarValue, b as ScalarValue)
}

function metaEquals(a: SchemaMetaMap, b: SchemaMetaMap): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && valueEquals(a[key]!, b[key]!))
}

function schemaEquals(a: SchemaNode, b: SchemaNode): boolean {
  if (a.nodeKind !== b.nodeKind || a.presence.mode !== b.presence.mode) return false
  if (a.description !== b.description || !metaEquals(a.metadata, b.metadata)) return false
  if (a.nodeKind === 'leaf') {
    if (b.nodeKind !== 'leaf' || a.valueKind !== b.valueKind) return false
    if (a.presence.mode === 'defaulted' && b.presence.mode === 'defaulted') {
      return valueEquals(a.presence.defaultValue, b.presence.defaultValue)
    }
    return true
  }
  if (a.nodeKind === 'struct') {
    if (b.nodeKind !== 'struct' || a.allowCustom !== b.allowCustom) return false
    const keys = Object.keys(a.fields)
    if (keys.length !== Object.keys(b.fields).length) return false
    return keys.every(
      (key) => Object.hasOwn(b.fields, key) && schemaEquals(a.fields[key]!, b.fields[key]!),
    )
  }
  return b.nodeKind === 'map' && schemaEquals(a.valueSchema, b.valueSchema)
}
