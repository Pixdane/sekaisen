/**
 * Trusted graph access over a schema view.
 *
 * Perspective never reaches into schema internals: every read goes through the
 * documented `ReadonlySchemaView` extensions (`listRootPaths`,
 * `inspectInstance`, `lensAt`, `getInstanceMeta`, `backlinks`). The same code
 * therefore runs against immutable commit views and mutable transaction
 * drafts.
 *
 * Link direction convention: a role link field on instance `A` points to its
 * target `B` (`A.parent -> B`). Backlinks expose the reverse query
 * (`B`'s children/edges).
 */

import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type {
  BacklinkEntry,
  FieldLens,
  HistoricalNodeInspection,
  HistoricalStructInspection,
  LeafSchemaNode,
  MapLens,
  ReadonlySchemaView,
  SchemaMetaMap,
  SchemaNode,
  StructLens,
  StructSchemaNode,
} from '@sekaisen/plugin-schema'
import type { Path, StateRef, Value } from '@sekaisen/plugin-world'
import { decodePathKey, encodePathKey } from '@sekaisen/plugin-world'
import { expectSchema } from './internal.ts'
import type {
  ExclusionClaimRecord,
  ObservedClaimRecord,
  PerspectiveRecord,
  RumorClaimRecord,
} from './schemas.ts'
import { DEFAULT_PERSPECTIVE_PRIORITY, PERSPECTIVES_ROOT } from './schemas.ts'
import type { BeliefState } from './types.ts'
import type {
  FieldSalience,
  PerspectiveLinkRole,
  SensoryChannel,
  Visibility,
} from './visibility.ts'
import {
  hasLinkRole,
  INSTANCE_VISIBILITY_KEY,
  isEphemeralSpec,
  isVisibility,
  linkRolesOfSpec,
  salienceOfSpec,
  senseOfSpec,
  visibilityOfSpec,
} from './visibility.ts'

/** A physical leaf with its Writer declaration, stored value and runtime metadata. */
export interface FieldNode {
  /** Declared field name or instance-specific custom key. */
  readonly name: string
  /** Canonical World path, including `$custom` for a custom leaf. */
  readonly path: Path
  /** Writer declaration at this graph's snapshot; supplies static defaults only. */
  readonly spec: LeafSchemaNode
  /** Stored value; absent optional fields do not invent a value. */
  readonly value: Option<Value | StateRef>
  /** Per-leaf `$meta` at this snapshot, including effective visibility overrides. */
  readonly meta: SchemaMetaMap
}

/** A concrete struct instance with its declared and custom leaf fields. */
export interface StructInstance {
  readonly path: Path
  /** Writer struct declaration at this snapshot, not the current Reader schema. */
  readonly spec: StructSchemaNode
  /** Runtime instance metadata (`$meta`). */
  readonly meta: SchemaMetaMap
  /** All leaf fields: declared fields plus custom leaves. */
  readonly fields: ReadonlyMap<string, FieldNode>
  /** Custom-leaf subset of {@link fields}, for classification. */
  readonly customFields: ReadonlyMap<string, FieldNode>
}

/** A role link resolved to one target instance path. */
export interface RoleLink {
  readonly fieldName: string
  readonly role: PerspectiveLinkRole
  readonly target: Path
}

/** Decode a path key without throwing on malformed stored data. */
export function decodePathKeySafe(key: string): Option<Path> {
  try {
    return some(decodePathKey(key))
  } catch {
    return NONE
  }
}

function isStateRef(value: unknown): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'commitId' in value &&
    typeof value.commitId === 'string' &&
    'path' in value &&
    Array.isArray(value.path) &&
    value.path.every((segment) => typeof segment === 'string')
  )
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function leafOf(
  inspection: HistoricalStructInspection,
  name: string,
): HistoricalNodeInspection | undefined {
  const child = inspection.fields[name]
  return child?.kind === 'some' ? child.value : undefined
}

function numberField(
  inspection: HistoricalStructInspection,
  name: string,
  fallback: number,
): number {
  const leaf = leafOf(inspection, name)
  return leaf?.nodeKind === 'leaf' && typeof leaf.value === 'number' ? leaf.value : fallback
}

function stringField(inspection: HistoricalStructInspection, name: string): Option<string> {
  const leaf = leafOf(inspection, name)
  return leaf?.nodeKind === 'leaf' && typeof leaf.value === 'string' ? some(leaf.value) : NONE
}

function refField(inspection: HistoricalStructInspection, name: string): Option<StateRef> {
  const leaf = leafOf(inspection, name)
  return leaf?.nodeKind === 'leaf' && isStateRef(leaf.value) ? some(leaf.value) : NONE
}

function stringListField(inspection: HistoricalStructInspection, name: string): readonly string[] {
  const leaf = leafOf(inspection, name)
  return leaf?.nodeKind === 'leaf' && isStringList(leaf.value) ? leaf.value : []
}

function boolField(
  inspection: HistoricalStructInspection,
  name: string,
  fallback: boolean,
): boolean {
  const leaf = leafOf(inspection, name)
  return leaf?.nodeKind === 'leaf' && typeof leaf.value === 'boolean' ? leaf.value : fallback
}

function beliefField(inspection: HistoricalStructInspection, fallback: BeliefState): BeliefState {
  const value = stringField(inspection, 'belief')
  return value.kind === 'some' &&
    (value.value === 'believed' || value.value === 'suspected' || value.value === 'known_false')
    ? value.value
    : fallback
}

function readObservedClaim(
  key: string,
  inspection: HistoricalStructInspection,
): ObservedClaimRecord | undefined {
  const targetRef = refField(inspection, 'targetRef')
  const eventRef = refField(inspection, 'eventRef')
  const originEventRef = refField(inspection, 'originEventRef')
  if (targetRef.kind === 'none' || eventRef.kind === 'none' || originEventRef.kind === 'none')
    return undefined
  return Object.freeze({
    key,
    seq: numberField(inspection, 'seq', 0),
    targetRef: targetRef.value,
    eventRef: eventRef.value,
    originEventRef: originEventRef.value,
    priority: numberField(inspection, 'priority', 0),
    override: boolField(inspection, 'override', true),
    belief: beliefField(inspection, 'believed'),
    source: stringField(inspection, 'source'),
    coWitnesses: Object.freeze([...stringListField(inspection, 'coWitnesses')]),
  })
}

function readRumorClaim(
  key: string,
  inspection: HistoricalStructInspection,
): RumorClaimRecord | undefined {
  const targetPathKey = stringField(inspection, 'targetPathKey')
  const factEventRef = refField(inspection, 'factEventRef')
  const eventRef = refField(inspection, 'eventRef')
  const originEventRef = refField(inspection, 'originEventRef')
  const encoded = leafOf(inspection, 'encodedValue')
  if (
    targetPathKey.kind === 'none' ||
    factEventRef.kind === 'none' ||
    eventRef.kind === 'none' ||
    originEventRef.kind === 'none' ||
    encoded?.nodeKind !== 'leaf' ||
    !isBytes(encoded.value)
  )
    return undefined
  return Object.freeze({
    key,
    seq: numberField(inspection, 'seq', 0),
    targetPathKey: targetPathKey.value,
    factEventRef: factEventRef.value,
    eventRef: eventRef.value,
    originEventRef: originEventRef.value,
    encodedValue: new Uint8Array(encoded.value),
    rumorSummary: stringField(inspection, 'rumorSummary'),
    priority: numberField(inspection, 'priority', 0),
    override: boolField(inspection, 'override', false),
    belief: beliefField(inspection, 'suspected'),
    source: stringField(inspection, 'source'),
    coWitnesses: Object.freeze([...stringListField(inspection, 'coWitnesses')]),
  })
}

function readExclusion(
  key: string,
  inspection: HistoricalStructInspection,
): ExclusionClaimRecord | undefined {
  const targetPathKey = stringField(inspection, 'targetPathKey')
  const eventRef = refField(inspection, 'eventRef')
  if (targetPathKey.kind === 'none' || eventRef.kind === 'none') return undefined
  return Object.freeze({
    key,
    seq: numberField(inspection, 'seq', 0),
    targetPathKey: targetPathKey.value,
    eventRef: eventRef.value,
    priority: numberField(inspection, 'priority', 0),
  })
}

function claimMap<T>(
  inspection: HistoricalStructInspection,
  name: string,
  read: (key: string, inspection: HistoricalStructInspection) => T | undefined,
): ReadonlyMap<string, T> {
  const child = leafOf(inspection, name)
  const map = new Map<string, T>()
  if (child?.nodeKind !== 'map') return map
  for (const [key, entry] of Object.entries(child.entries)) {
    if (entry.nodeKind !== 'struct') continue
    const record = read(key, entry)
    if (record) map.set(key, record)
  }
  return map
}

/** Build the empty perspective used when a mind has not been materialized yet. */
export function emptyPerspective(id: string): PerspectiveRecord {
  return Object.freeze({
    id,
    description: '',
    defaultPriority: DEFAULT_PERSPECTIVE_PRIORITY,
    hostEntity: NONE,
    inherits: Object.freeze([]),
    nextSeq: 1,
    discoveredEntities: new Map(),
    observedClaims: new Map(),
    rumorClaims: new Map(),
    exclusions: new Map(),
  })
}

/**
 * Encode a logical perspective id as its canonical native pointer path key.
 *
 * `inherits` is an `s.linkList` targeting the `['perspectives']` Map, so every
 * stored member MUST be a pointer to `['perspectives', id]` rather than a bare
 * logical id; otherwise commit validation rejects the link target.
 */
export function encodePerspectivePointer(id: string): string {
  return encodePathKey([...PERSPECTIVES_ROOT, id])
}

/**
 * Decode a native `inherits` pointer back to its logical perspective id.
 *
 * Returns `NONE` for malformed path keys and for pointers outside the
 * `['perspectives']` root, so total reads ignore foreign or corrupt entries
 * instead of exposing storage coordinates as inheritance identities.
 */
function decodePerspectivePointer(key: string): Option<string> {
  const decoded = decodePathKeySafe(key)
  if (decoded.kind === 'none') return NONE
  const path = decoded.value
  if (path.length !== PERSPECTIVES_ROOT.length + 1) return NONE
  for (const [index, segment] of PERSPECTIVES_ROOT.entries())
    if (path[index] !== segment) return NONE
  return some(path[PERSPECTIVES_ROOT.length]!)
}

/**
 * Decode a stored perspective node inspection into its claim-table view.
 *
 * `inherits` members are persisted as native link pointers, while the exposed
 * record uses logical perspective ids so folding and topology checks stay
 * independent of storage encoding.
 */
export function readPerspective(
  id: string,
  inspection: HistoricalStructInspection,
): PerspectiveRecord {
  const host = stringField(inspection, 'hostEntity')
  const hostPath = host.kind === 'some' ? decodePathKeySafe(host.value) : NONE
  const inherits: string[] = []
  for (const key of stringListField(inspection, 'inherits')) {
    const parent = decodePerspectivePointer(key)
    if (parent.kind === 'some') inherits.push(parent.value)
  }
  const description = stringField(inspection, 'description')
  return Object.freeze({
    id,
    description: description.kind === 'some' ? description.value : '',
    defaultPriority: numberField(inspection, 'defaultPriority', DEFAULT_PERSPECTIVE_PRIORITY),
    hostEntity: hostPath,
    inherits: Object.freeze([...inherits]),
    nextSeq: numberField(inspection, 'nextSeq', 1),
    discoveredEntities: claimMap(inspection, 'discoveredEntities', readObservedClaim),
    observedClaims: claimMap(inspection, 'observedClaims', readObservedClaim),
    rumorClaims: claimMap(inspection, 'rumorClaims', readRumorClaim),
    exclusions: claimMap(inspection, 'exclusions', readExclusion),
  })
}

/**
 * Read-only graph API over one fixed schema view.
 *
 * No method mutates the view. Transaction drafts are supported because every
 * schema read follows the draft overlay.
 */
export class PerspectiveGraph {
  readonly view: ReadonlySchemaView
  private readonly inspectionCache: Map<string, Option<HistoricalNodeInspection>> | undefined
  private readonly instanceCache: Map<string, Option<StructInstance>> | undefined
  private perspectiveRecords: ReadonlyMap<string, PerspectiveRecord> | undefined

  /**
   * Bind trusted graph access to a view.
   *
   * @param view Captured Schema view or live transaction draft.
   * @param fixedSnapshot Enable request-local reuse only for an immutable
   * committed view. Draft callers must keep the default so writes made between
   * reads remain immediately visible.
   */
  constructor(view: ReadonlySchemaView, fixedSnapshot = false) {
    this.view = view
    this.inspectionCache = fixedSnapshot ? new Map() : undefined
    this.instanceCache = fixedSnapshot ? new Map() : undefined
  }

  /** Writer-faithful inspection at `path` (draft-aware for transactions). */
  inspect(path: Path): Option<HistoricalNodeInspection> {
    const key = this.inspectionCache === undefined ? undefined : encodePathKey(path)
    const cached = key === undefined ? undefined : this.inspectionCache?.get(key)
    if (cached !== undefined) return cached
    const inspected = expectSchema(this.view.inspectInstance(path))
    if (key !== undefined) this.inspectionCache?.set(key, inspected)
    return inspected
  }

  /**
   * Writer declaration at `path`, independent of stored values and Reader
   * registration. Useful for historical guards that must reason about the
   * schema a node was written with instead of the current Reader.
   *
   * @param path Logical path from a registered Writer root, including
   * `$custom/<key>` for an instance-specific leaf.
   * @returns A deep-owned frozen declaration, or `NONE` when this view's Writer
   * catalog has no such node. Malformed stored custom specs surface as
   * structured errors rather than `NONE`.
   */
  writerSchemaAt(path: Path): Option<SchemaNode> {
    return expectSchema(this.view.writerSchemaAt(path))
  }

  /** Reader struct lens at `path`, when it is a struct. */
  structLens(path: Path): Option<StructLens> {
    const lens = expectSchema(this.view.lensAt(path))
    return lens.opticKind === 'struct' ? some(lens) : NONE
  }

  /** Reader Map lens at `path`, when it is a Map root. */
  mapLens(path: Path): Option<MapLens> {
    const lens = expectSchema(this.view.lensAt(path))
    return lens.opticKind === 'map' ? some(lens) : NONE
  }

  /** Reader leaf lens at `path`, when it is a declared field. */
  fieldLens(path: Path): Option<FieldLens> {
    const lens = expectSchema(this.view.lensAt(path))
    return lens.opticKind === 'field' ? some(lens) : NONE
  }

  /** All captured Reader root paths. */
  rootPaths(): readonly Path[] {
    return this.view.listRootPaths()
  }

  /**
   * Materialize one struct instance with every declared and custom leaf field.
   *
   * `fields` is the complete live field map (declared plus custom); the
   * `customFields` subset remains available for classification. Struct/Map
   * nested below a field are not returned here; use {@link walkInstances} for
   * full subtree traversal.
   */
  instance(path: Path): Option<StructInstance> {
    const key = this.instanceCache === undefined ? undefined : encodePathKey(path)
    const cached = key === undefined ? undefined : this.instanceCache?.get(key)
    if (cached !== undefined) return cached
    const inspection = this.inspect(path)
    if (inspection.kind === 'none' || inspection.value.nodeKind !== 'struct') {
      if (key !== undefined) this.instanceCache?.set(key, NONE)
      return NONE
    }
    const struct = inspection.value
    const spec = struct.writerSpec
    const fields = new Map<string, FieldNode>()
    for (const [name, fieldSpec] of Object.entries(spec.fields)) {
      if (fieldSpec.nodeKind !== 'leaf') continue
      const child = leafOf(struct, name)
      fields.set(name, {
        name,
        path: [...path, name],
        spec: fieldSpec,
        value: child?.nodeKind === 'leaf' ? some(child.value) : NONE,
        meta: child?.nodeKind === 'leaf' ? child.meta : Object.freeze({}),
      })
    }
    const customFields = new Map<string, FieldNode>()
    for (const [name, custom] of Object.entries(struct.customFields)) {
      if (custom.spec.nodeKind !== 'leaf') continue
      customFields.set(name, {
        name,
        path: [...path, '$custom', name],
        spec: custom.spec,
        value: some(custom.value),
        meta: custom.meta,
      })
    }
    /*
     * Every live consumer (scope, projection, service) iterates `fields`.
     * Custom leaves are part of the instance surface, so expose them in the
     * common map as well; `customFields` stays the classification subset.
     * Native Schema forbids custom keys from shadowing declared fields.
     */
    for (const [name, field] of customFields) fields.set(name, field)
    const instance = some(
      Object.freeze({
        path,
        spec,
        meta: struct.meta,
        fields,
        customFields,
      }),
    )
    if (key !== undefined) this.instanceCache?.set(key, instance)
    return instance
  }

  /** Effective instance visibility: runtime `$meta` override, then declaration, then surface. */
  instanceVisibility(instance: StructInstance): Visibility {
    const override = instance.meta[INSTANCE_VISIBILITY_KEY]
    return isVisibility(override) ? override : visibilityOfSpec(instance.spec)
  }

  /**
   * Effective field visibility: a valid runtime leaf `$meta.visibility`
   * overrides the Writer declaration; absent or invalid overrides fall back
   * to that declaration's visibility (surface by default). The same rule
   * applies to declared and instance-specific custom leaves.
   */
  fieldVisibility(field: FieldNode): Visibility {
    const override = field.meta.visibility
    return isVisibility(override) ? override : visibilityOfSpec(field.spec)
  }

  /** Field sensory channel from its leaf declaration. */
  fieldSense(field: FieldNode): SensoryChannel {
    return senseOfSpec(field.spec)
  }

  /** Field ephemerality from its leaf declaration. */
  fieldEphemeral(field: FieldNode): boolean {
    return isEphemeralSpec(field.spec)
  }

  /** Effective salience for automatic memory writes. */
  fieldSalience(instance: StructInstance, field: FieldNode): FieldSalience {
    const fieldOverride = field.meta.salience
    if (fieldOverride === 'salient' || fieldOverride === 'passive') return fieldOverride
    const instanceOverride = instance.meta.salience
    if (instanceOverride === 'salient' || instanceOverride === 'passive') return instanceOverride
    const declared = field.spec.metadata.salience
    if (declared === 'salient' || declared === 'passive') return declared
    return salienceOfSpec(instance.spec)
  }

  /** Resolve all targets of a role link field on an instance. */
  roleLinks(instance: StructInstance, role: PerspectiveLinkRole): readonly RoleLink[] {
    const links: RoleLink[] = []
    for (const field of instance.fields.values()) {
      if (!hasLinkRole(field.spec, role)) continue
      if (field.value.kind === 'none') continue
      const targets = linkTargets(field.value.value)
      for (const target of targets) links.push({ fieldName: field.name, role, target })
    }
    return links
  }

  /** First single-target link for a role (parent/delegate are exclusive by contract). */
  singleRoleTarget(instance: StructInstance, role: PerspectiveLinkRole): Option<Path> {
    for (const field of [...instance.fields.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!hasLinkRole(field.spec, role)) continue
      if (field.value.kind === 'none') continue
      const value = field.value.value
      if (typeof value === 'string') {
        const decoded = decodePathKeySafe(value)
        if (decoded.kind === 'some') return decoded
      }
      if (isStringList(value) && value.length > 0) {
        const decoded = decodePathKeySafe(value[0]!)
        if (decoded.kind === 'some') return decoded
      }
    }
    return NONE
  }

  /** Parent container from the instance's `'parent'` role link. */
  parentOf(path: Path): Option<Path> {
    const instance = this.instance(path)
    return instance.kind === 'none' ? NONE : this.singleRoleTarget(instance.value, 'parent')
  }

  /**
   * Follow the `'delegate'` chain to the root body.
   *
   * Cyclic data is tolerated defensively (returns the last distinct node)
   * because topology validators reject it before commits, while reads must
   * still be total.
   */
  delegateRoot(path: Path): Path {
    const visited = new Set<string>([encodePathKey(path)])
    let current = path
    for (;;) {
      const instance = this.instance(current)
      if (instance.kind === 'none') return current
      const parent = this.singleRoleTarget(instance.value, 'delegate')
      if (parent.kind === 'none') return current
      const key = encodePathKey(parent.value)
      if (visited.has(key)) return current
      visited.add(key)
      current = parent.value
    }
  }

  /** Direct child instances via `'parent'` backlinks, UTF-8-key sorted. */
  childrenOf(path: Path): readonly Path[] {
    const entries = expectSchema(
      this.view.backlinks(path, {
        filterFieldSpec: (spec) => hasLinkRole(spec, 'parent'),
      }),
    )
    return sortedUniquePaths(entries.map((entry) => entry.sourceInstancePath))
  }

  /** Directed edges touching `path` via `edge_from`/`edge_to` backlinks. */
  edgesTouching(path: Path): readonly Path[] {
    const entries = expectSchema(
      this.view.backlinks(path, {
        filterFieldSpec: (spec) => hasLinkRole(spec, 'edge_from', 'edge_to'),
      }),
    )
    return sortedUniquePaths(entries.map((entry) => entry.sourceInstancePath))
  }

  /** All backlink entries touching an instance (used by delegate activation). */
  backlinks(path: Path): readonly BacklinkEntry[] {
    return expectSchema(this.view.backlinks(path))
  }

  /**
   * Enumerate all struct instances physically nested under `rootPath`
   * (inclusive).
   *
   * Maps and struct fields are visited structurally; no link traversal occurs.
   * Semantic containment (`'parent'` links) is a separate graph and must use
   * {@link childrenOf}; business entities often live as sibling Map members,
   * so this physical subtree alone is not a containment-tree enumeration.
   */
  walkInstances(rootPath: Path): readonly Path[] {
    const result: Path[] = []
    const visit = (path: Path): void => {
      const inspection = this.inspect(path)
      if (inspection.kind === 'none') return
      const node = inspection.value
      if (node.nodeKind === 'struct') {
        result.push(path)
        for (const [name, child] of Object.entries(node.fields)) {
          if (child.kind === 'none') continue
          if (child.value.nodeKind !== 'leaf') visit([...path, name])
        }
      } else if (node.nodeKind === 'map') {
        for (const [key, entry] of Object.entries(node.entries)) {
          if (entry.nodeKind !== 'leaf') visit([...path, key])
        }
      }
    }
    visit(rootPath)
    return result
  }

  /** Enumerate every struct instance under every registered Reader root. */
  allInstances(): readonly Path[] {
    const paths: Path[] = []
    for (const root of this.rootPaths()) {
      for (const path of this.walkInstances(root)) paths.push(path)
    }
    return sortedUniquePaths(paths)
  }

  /** Read one perspective node, or `NONE` when not yet materialized. */
  perspective(id: string): Option<PerspectiveRecord> {
    if (this.inspectionCache !== undefined) {
      const record = this.perspectives().get(id)
      return record === undefined ? NONE : some(record)
    }
    const inspection = this.inspect([...PERSPECTIVES_ROOT, id])
    if (inspection.kind === 'none') return NONE
    return inspection.value.nodeKind === 'struct'
      ? some(readPerspective(id, inspection.value))
      : NONE
  }

  /** All materialized perspective records, keyed by id. */
  perspectives(): ReadonlyMap<string, PerspectiveRecord> {
    if (this.perspectiveRecords !== undefined) return this.perspectiveRecords
    const inspection = this.inspect(PERSPECTIVES_ROOT)
    const records = new Map<string, PerspectiveRecord>()
    if (inspection.kind === 'some' && inspection.value.nodeKind === 'map') {
      for (const [id, entry] of Object.entries(inspection.value.entries)) {
        if (entry.nodeKind === 'struct') records.set(id, readPerspective(id, entry))
      }
    }
    if (this.inspectionCache !== undefined) this.perspectiveRecords = records
    return records
  }

  /** Perspective record with defaults for an unmaterialized id. */
  perspectiveOrDefault(id: string): PerspectiveRecord {
    const record = this.perspective(id)
    return record.kind === 'some' ? record.value : emptyPerspective(id)
  }

  /** True when a perspective node, or a node hosted by this entity, exists. */
  hasMindForEntity(rootEntity: Path): boolean {
    if (this.perspective(encodePathKey(rootEntity)).kind === 'some') return true
    for (const record of this.perspectives().values()) {
      if (record.hostEntity.kind === 'some' && pathsEqual(record.hostEntity.value, rootEntity))
        return true
    }
    return false
  }

  /** Canonical root perspective id for an entity root. */
  static entityPerspectiveId(rootEntity: Path): string {
    return encodePathKey(rootEntity)
  }
}

/** Decode a link leaf value (single key or list of keys) into target paths. */
export function linkTargets(value: Value | StateRef): readonly Path[] {
  const targets: Path[] = []
  if (typeof value === 'string') {
    const decoded = decodePathKeySafe(value)
    if (decoded.kind === 'some') targets.push(decoded.value)
  } else if (isStringList(value)) {
    for (const key of value) {
      const decoded = decodePathKeySafe(key)
      if (decoded.kind === 'some') targets.push(decoded.value)
    }
  }
  return targets
}

/** Pairwise path equality. */
export function pathsEqual(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index])
}

/**
 * Owning Struct of a declared or instance-specific leaf's physical path.
 * Custom leaves live under the reserved `$custom` slot, which is not itself
 * an entity and must never become a projected instance or ownership boundary.
 */
export function fieldInstancePath(path: Path): Path {
  return path.slice(0, path.at(-2) === '$custom' ? -2 : -1)
}

/** Stable path-key sorting with deduplication. */
export function sortedUniquePaths(paths: readonly Path[]): readonly Path[] {
  const byKey = new Map<string, Path>()
  for (const path of paths) byKey.set(encodePathKey(path), path)
  return Object.freeze(
    [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]),
  )
}

/** Read a leaf field's declared description for schema dictionaries. */
export function nodeDescription(spec: SchemaNode | undefined): string {
  return spec?.description ?? ''
}

/**
 * Role tags on a leaf, exposed for topology validation and scope checks.
 *
 * Kept as a function so the graph layer does not duplicate schema metadata
 * decoding rules.
 */
export function rolesOfLeaf(spec: LeafSchemaNode | undefined): readonly PerspectiveLinkRole[] {
  return linkRolesOfSpec(spec)
}
