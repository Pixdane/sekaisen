import type { Path } from '@sekaisen/plugin-world'
import { decodePathKey, encodePathKey } from '@sekaisen/plugin-world'
import { assertIdentifier, cloneSchema, cloneSchemaMetadata, SchemaFailure } from './builders.ts'
import type { Catalog, StateReader, StateWriter } from './runtime.ts'
import { childKeys, getEntry, physicalSchemaAt, setValue } from './runtime.ts'
import type {
  BacklinkEntry,
  BacklinkQueryFilter,
  LeafSchemaNode,
  LinkTraits,
  OnDeletePolicy,
  SchemaMetaMap,
  SchemaNode,
  SchemaValidationReason,
} from './types.ts'

/* -------------------------------------------------------------------------- */
/*                             Encoded link metadata                        */
/* -------------------------------------------------------------------------- */

/**
 * Canonical flat metadata keys written by `s.link` / `s.linkList`.
 *
 * Kept as constants so upper plugins can inspect `fieldSpec.metadata` without
 * hard-coding strings. Metadata remains a plain persisted `Value` map, so the
 * Writer catalog stays self-describing.
 */
export const LINK_META_KEYS = Object.freeze({
  targetRoots: '$linkTargetRoots',
  dynamicTargetRoots: '$linkTargetRootsDynamic',
  acyclic: '$linkAcyclic',
  exclusiveRole: '$linkExclusiveRole',
  onDelete: '$linkOnDelete',
} as const)

const ON_DELETE_POLICIES: Readonly<Record<string, OnDeletePolicy>> = Object.freeze({
  reject: 'reject',
  cascade: 'cascade',
  unlink: 'unlink',
})

function fail(path: Path, reason: SchemaValidationReason, detail: string): never {
  throw new SchemaFailure({ kind: 'validation_failed', path, reason, detail })
}

/** Keep the stable registration error code while retaining detail in thrown diagnostics. */
function failLinkTraits(path: Path, detail: string): never {
  const failure = new SchemaFailure({
    kind: 'schema_conflict',
    path,
    reason: 'invalid_link_traits',
  })
  failure.message = `${failure.message}: ${detail}`
  throw failure
}

function readPathList(raw: unknown, at: Path): readonly Path[] {
  if (!Array.isArray(raw)) failLinkTraits(at, 'link target roots must be a list of paths')
  const paths: Path[] = []
  for (const item of raw) {
    if (typeof item !== 'string') failLinkTraits(at, 'encoded link target roots must be strings')
    let decoded: Path = Object.freeze([])
    try {
      decoded = decodePathKey(item)
    } catch {
      failLinkTraits(at, 'encoded link target root is malformed')
    }
    if (decoded.length === 0) failLinkTraits(at, 'link target roots must be non-empty paths')
    for (const segment of decoded) {
      try {
        assertIdentifier(segment)
      } catch {
        failLinkTraits(at, 'link target root segments must be valid identifiers')
      }
    }
    paths.push(Object.freeze([...decoded]))
  }
  return Object.freeze(paths)
}

function readExclusiveRole(raw: unknown, at: Path): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || raw.length === 0)
    failLinkTraits(at, 'exclusiveRole must be a non-empty string or null')
  return raw
}

function readOnDelete(raw: unknown, at: Path): OnDeletePolicy {
  if (raw === undefined) return 'reject'
  if (typeof raw !== 'string' || ON_DELETE_POLICIES[raw] === undefined)
    failLinkTraits(at, 'onDelete must be reject, cascade or unlink')
  return ON_DELETE_POLICIES[raw]!
}

/**
 * Validate a `LinkTraits` description and encode it as flat leaf metadata.
 * Throws `invalid_schema_identifier` for malformed target paths and
 * `schema_conflict` (`invalid_link_traits`) for malformed scalar traits.
 * `targetRoots` must be non-empty; `dynamicTargetRoots` is the only opt-in for
 * targets whose owning roots are registered later by other plugins.
 */
export function encodeLinkTraits(traits: LinkTraits): SchemaMetaMap {
  if (typeof traits !== 'object' || traits === null)
    failLinkTraits([], 'link traits must be an object')
  if (!Array.isArray(traits.targetRoots))
    failLinkTraits([], 'targetRoots must be an array of paths')
  if (traits.targetRoots.length === 0)
    failLinkTraits([], 'targetRoots must be a non-empty array of paths')
  if (traits.dynamicTargetRoots !== undefined && typeof traits.dynamicTargetRoots !== 'boolean')
    failLinkTraits([], 'dynamicTargetRoots must be a boolean')
  const roots: string[] = []
  for (const root of traits.targetRoots) {
    if (!Array.isArray(root)) failLinkTraits([], 'targetRoots entries must be paths')
    if (root.length === 0) failLinkTraits([], 'targetRoots entries must be non-empty paths')
    for (const segment of root) assertIdentifier(segment)
    roots.push(encodePathKey(root))
  }
  if (traits.acyclic !== undefined && typeof traits.acyclic !== 'boolean')
    failLinkTraits([], 'acyclic must be a boolean')
  const exclusiveRole = traits.exclusiveRole
  if (exclusiveRole !== undefined) {
    if (typeof exclusiveRole !== 'string') failLinkTraits([], 'exclusiveRole must be a string')
    assertIdentifier(exclusiveRole)
  }
  if (traits.onDelete !== undefined && ON_DELETE_POLICIES[traits.onDelete] === undefined)
    failLinkTraits([], 'onDelete must be reject, cascade or unlink')
  return cloneSchemaMetadata({
    [LINK_META_KEYS.targetRoots]: Object.freeze(roots),
    [LINK_META_KEYS.dynamicTargetRoots]: traits.dynamicTargetRoots === true,
    [LINK_META_KEYS.acyclic]: traits.acyclic === true,
    [LINK_META_KEYS.exclusiveRole]: exclusiveRole ?? null,
    [LINK_META_KEYS.onDelete]: traits.onDelete ?? 'reject',
  })
}

const traitsCache = new WeakMap<LeafSchemaNode, LinkTraits | null>()

/**
 * Decode a leaf's persisted link metadata. Returns `undefined` for ordinary
 * leaves; malformed or partially forged `$link*` metadata throws
 * `schema_conflict` (`invalid_link_traits`). Results are cached per leaf object.
 */
export function linkTraitsOf(spec: LeafSchemaNode): LinkTraits | undefined {
  const cached = traitsCache.get(spec)
  if (cached !== undefined) return cached ?? undefined
  const rawRoots = spec.metadata[LINK_META_KEYS.targetRoots]
  const hasAcyclic = Object.hasOwn(spec.metadata, LINK_META_KEYS.acyclic)
  const hasRole = Object.hasOwn(spec.metadata, LINK_META_KEYS.exclusiveRole)
  const hasPolicy = Object.hasOwn(spec.metadata, LINK_META_KEYS.onDelete)
  if (rawRoots === undefined) {
    if (
      hasAcyclic ||
      hasRole ||
      hasPolicy ||
      Object.hasOwn(spec.metadata, LINK_META_KEYS.dynamicTargetRoots)
    )
      failLinkTraits([], 'link traits require $linkTargetRoots')
    traitsCache.set(spec, null)
    return undefined
  }
  if (spec.valueKind !== 'str' && spec.valueKind !== 'list:str')
    failLinkTraits([], 'links must be str or list:str leaves')
  const targetRoots = readPathList(rawRoots, [])
  if (targetRoots.length === 0) failLinkTraits([], 'targetRoots must be a non-empty array of paths')
  const dynamic = spec.metadata[LINK_META_KEYS.dynamicTargetRoots]
  if (dynamic !== undefined && typeof dynamic !== 'boolean')
    failLinkTraits([], '$linkTargetRootsDynamic must be a boolean')
  const acyclic = spec.metadata[LINK_META_KEYS.acyclic]
  if (acyclic !== undefined && typeof acyclic !== 'boolean')
    failLinkTraits([], '$linkAcyclic must be a boolean')
  const exclusiveRole = readExclusiveRole(spec.metadata[LINK_META_KEYS.exclusiveRole], [])
  const traits: LinkTraits = Object.freeze({
    targetRoots,
    dynamicTargetRoots: dynamic === true,
    acyclic: acyclic === true,
    onDelete: readOnDelete(spec.metadata[LINK_META_KEYS.onDelete], []),
    ...(exclusiveRole === undefined ? {} : { exclusiveRole }),
  })
  traitsCache.set(spec, traits)
  return traits
}

/**
 * Registration-time checks for every link leaf in a copied schema AST.
 * Enforces the doc-05 build rules:
 * - a link must be owned by a Struct instance, because every backlink entry
 *   carries a `sourceInstancePath` and scanners only emit edges below a
 *   Struct boundary. Root `s.link()` and root `s.map(s.link())` are therefore
 *   rejected explicitly instead of being silently skipped by validation;
 * - single-target `s.link` with `onDelete: 'unlink'` must be optional;
 * - `s.linkList` must not declare an `exclusiveRole`.
 * Malformed trait metadata is reported as well, so a raw `.meta()` forgery
 * cannot smuggle a link past the builder helpers.
 *
 * @param node Copied (normalized) schema AST.
 * @param path Schema path of `node`, used for diagnostics.
 * @param hasSourceStruct Whether an enclosing Struct instance already owns this
 * node. `false` only for a registered root and for Map entries that never cross
 * a Struct boundary; `true` for Struct fields (including augmented fields).
 * @throws SchemaFailure with `schema_conflict` for every violation.
 */
export function validateLinkRegistration(
  node: SchemaNode,
  path: Path,
  hasSourceStruct = false,
): void {
  const traits = node.nodeKind === 'leaf' ? linkTraitsOf(node) : undefined
  if (node.nodeKind === 'leaf' && traits) {
    if (!hasSourceStruct) {
      throw new SchemaFailure({
        kind: 'schema_conflict',
        path,
        reason: 'link_source_struct_required',
      })
    }
    if (
      node.valueKind === 'str' &&
      traits.onDelete === 'unlink' &&
      node.presence.mode !== 'optional'
    ) {
      throw new SchemaFailure({
        kind: 'schema_conflict',
        path,
        reason: 'link_unlink_requires_optional',
      })
    }
    if (node.valueKind === 'list:str' && traits.exclusiveRole !== undefined) {
      throw new SchemaFailure({
        kind: 'schema_conflict',
        path,
        reason: 'link_list_exclusive_role_forbidden',
      })
    }
  }
  if (node.nodeKind === 'struct') {
    for (const [key, child] of Object.entries(node.fields))
      validateLinkRegistration(child, [...path, key], true)
  } else if (node.nodeKind === 'map') {
    validateLinkRegistration(node.valueSchema, [...path, '*'], hasSourceStruct)
  }
}

/**
 * Registration-time check for a custom leaf definition.
 *
 * Custom leaves are stored at `$custom/<key>` and deliberately skipped by the
 * link scanners, which only traverse declared Struct fields. A custom leaf
 * carrying `$link*` metadata would therefore register successfully while never
 * producing backlinks or target/cycle validation, so it is rejected instead of
 * being silently ignored.
 *
 * @param spec Copied custom leaf definition.
 * @param path Custom leaf path (`...instancePath, '$custom', key`).
 * @throws SchemaFailure `schema_conflict` (`link_custom_field_forbidden`) when
 * the definition declares link traits.
 */
export function validateCustomLinkRegistration(spec: LeafSchemaNode, path: Path): void {
  if (linkTraitsOf(spec) === undefined) return
  throw new SchemaFailure({
    kind: 'schema_conflict',
    path,
    reason: 'link_custom_field_forbidden',
  })
}

/* -------------------------------------------------------------------------- */
/*                            Target root catalog                           */
/* -------------------------------------------------------------------------- */

interface LinkTargets {
  readonly hasLinks: boolean
  /**
   * True when at least one link opts into `dynamicTargetRoots`: it may point at
   * any Struct instance under a currently registered Writer root, so every
   * registered root can contain its targets.
   */
  readonly wildcard: boolean
  /** Encoded static target root keys; empty when only dynamic links exist. */
  readonly keys: readonly string[]
}

const targetRootsCache = new WeakMap<Catalog, LinkTargets>()

const linkLeafCache = new WeakMap<SchemaNode, boolean>()

function containsLinkLeaf(node: SchemaNode): boolean {
  const cached = linkLeafCache.get(node)
  if (cached !== undefined) return cached
  const result =
    node.nodeKind === 'leaf'
      ? linkTraitsOf(node) !== undefined
      : node.nodeKind === 'struct'
        ? Object.values(node.fields).some(containsLinkLeaf)
        : containsLinkLeaf(node.valueSchema)
  linkLeafCache.set(node, result)
  return result
}

/**
 * Collect the union of declared link target roots for a catalog.
 * Uses encoded path keys so prefix tests are O(1) string operations.
 */
export function linkTargetsOf(catalog: Catalog): LinkTargets {
  const cached = targetRootsCache.get(catalog)
  if (cached !== undefined) return cached
  const keys = new Set<string>()
  let hasLinks = false
  let wildcard = false
  function visit(node: SchemaNode): void {
    if (node.nodeKind === 'leaf') {
      const traits = linkTraitsOf(node)
      if (!traits) return
      hasLinks = true
      if (traits.dynamicTargetRoots === true) wildcard = true
      for (const root of traits.targetRoots) keys.add(encodePathKey(root))
      return
    }
    if (node.nodeKind === 'struct') {
      for (const child of Object.values(node.fields)) visit(child)
    } else visit(node.valueSchema)
  }
  for (const root of catalog.roots.values()) visit(root.schema)
  const result: LinkTargets = Object.freeze({
    hasLinks,
    wildcard,
    keys: Object.freeze([...keys].sort()),
  })
  targetRootsCache.set(catalog, result)
  return result
}

/** Whether `catalog` declares any link leaf at all. */
export function hasLinkSchemas(catalog: Catalog): boolean {
  return linkTargetsOf(catalog).hasLinks
}

/** Whether a concrete instance path is an allowed target for these traits. */
export function isAllowedTarget(targetKey: string, traits: LinkTraits): boolean {
  if (traits.dynamicTargetRoots === true) return true
  return traits.targetRoots.some((root) => {
    const rootKey = encodePathKey(root)
    return targetKey === rootKey || targetKey.startsWith(rootKey)
  })
}

function intersects(left: Path, right: Path): boolean {
  const a = encodePathKey(left)
  const b = encodePathKey(right)
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/**
 * Cheap pre-check used before expensive seed collection: does deleting
 * `subtreeRoot` have any chance of removing a link target?
 */
export function linkOperationMayRemoveTargets(catalog: Catalog, subtreeRoot: Path): boolean {
  const targets = linkTargetsOf(catalog)
  if (!targets.hasLinks) return false
  if (targets.wildcard) return true
  const rootKey = encodePathKey(subtreeRoot)
  return targets.keys.some(
    (key) => key === rootKey || key.startsWith(rootKey) || rootKey.startsWith(key),
  )
}

/* -------------------------------------------------------------------------- */
/*                          Physical instance walking                       */
/* -------------------------------------------------------------------------- */

interface InstanceCursor {
  readonly path: Path
  readonly rel: Path
}

const fieldSpecCache = new WeakMap<LeafSchemaNode, LeafSchemaNode>()

function normalizedFieldSpec(spec: LeafSchemaNode): LeafSchemaNode {
  let cached = fieldSpecCache.get(spec)
  if (cached === undefined) {
    cached = cloneSchema(spec) as LeafSchemaNode
    fieldSpecCache.set(spec, cached)
  }
  return cached
}

function addEdge(
  out: Map<string, BacklinkEntry[]>,
  instance: InstanceCursor,
  sourceRoot: Path,
  spec: LeafSchemaNode,
  traits: LinkTraits,
  value: string,
): void {
  const bucket = out.get(value)
  const entry: BacklinkEntry = Object.freeze({
    sourceInstancePath: Object.freeze([...instance.path]),
    sourceRootPath: Object.freeze([...sourceRoot]),
    fieldRelativePath: Object.freeze([...instance.rel]),
    fieldSpec: normalizedFieldSpec(spec),
    onDelete: traits.onDelete ?? 'reject',
  })
  if (bucket === undefined) out.set(value, [entry])
  else bucket.push(entry)
}

function scanNode(
  state: StateReader,
  root: SchemaNode,
  path: Path,
  sourceRoot: Path,
  instance: InstanceCursor | undefined,
  boundary: boolean,
  out: Map<string, BacklinkEntry[]>,
): void {
  if (root.nodeKind === 'leaf') {
    if (instance === undefined) return
    const traits = linkTraitsOf(root)
    if (!traits) return
    const entry = getEntry(state, [...path, '$val'])
    if (entry?.entryKind !== 'val') return
    if (root.valueKind === 'list:str') {
      if (!Array.isArray(entry.value)) return
      for (const item of entry.value) {
        if (typeof item !== 'string' || item.length === 0) continue
        addEdge(out, instance, sourceRoot, root, traits, item)
      }
      return
    }
    if (typeof entry.value !== 'string' || entry.value.length === 0) return
    addEdge(out, instance, sourceRoot, root, traits, entry.value)
    return
  }
  if (!state.hasEntry([...path, '$exists'])) return
  if (root.nodeKind === 'struct') {
    const cursor = boundary ? { path, rel: Object.freeze([] as string[]) } : instance
    for (const [key, child] of Object.entries(root.fields)) {
      const next: InstanceCursor | undefined =
        cursor === undefined
          ? undefined
          : { path: cursor.path, rel: Object.freeze([...cursor.rel, key]) }
      scanNode(state, child, [...path, key], sourceRoot, next, false, out)
    }
    return
  }
  const valueSchema = root.valueSchema
  for (const key of childKeys(state, path)) {
    if (key === '$exists' || key.startsWith('$')) continue
    const childPath = [...path, key]
    if (valueSchema.nodeKind === 'struct') {
      scanNode(state, valueSchema, childPath, sourceRoot, undefined, true, out)
    } else {
      const next: InstanceCursor | undefined =
        instance === undefined
          ? undefined
          : { path: instance.path, rel: Object.freeze([...instance.rel, key]) }
      scanNode(state, valueSchema, childPath, sourceRoot, next, false, out)
    }
  }
}

/** Immutable per-view bucket index from target key to live backlink entries. */
export interface LinkIndex {
  readonly byTarget: ReadonlyMap<string, readonly BacklinkEntry[]>
  /** Whether the catalog declares any links; callers may skip related work. */
  readonly hasLinks: boolean
}

interface IndexCacheEntry {
  readonly revision: number | undefined
  readonly index: LinkIndex
}

const indexCache = new WeakMap<StateReader, Map<Catalog, IndexCacheEntry>>()

/**
 * Build (or reuse) the backlink index for a physical state snapshot.
 *
 * The cache is keyed by the state object, its catalog and the state's monotonic
 * draft revision, so a fixed commit builds once and a transaction draft is
 * rebuilt exactly once after every write. Only roots that declare links are
 * traversed, and only physically present sources/leaves become edges.
 *
 * @param state Physical state reader (World commit or draft overlay).
 * @param catalog Catalog that defines the shape being scanned.
 */
export function linkIndexOf(state: StateReader, catalog: Catalog): LinkIndex {
  const targets = linkTargetsOf(catalog)
  if (!targets.hasLinks) return { byTarget: new Map(), hasLinks: false }
  let perCatalog = indexCache.get(state)
  if (perCatalog === undefined) {
    perCatalog = new Map()
    indexCache.set(state, perCatalog)
  }
  const revision = state.revision
  const cached = perCatalog.get(catalog)
  if (cached !== undefined && cached.revision === revision) return cached.index
  const byTarget = new Map<string, BacklinkEntry[]>()
  for (const root of catalog.roots.values()) {
    if (!containsLinkLeaf(root.schema)) continue
    scanNode(state, root.schema, root.path, root.path, undefined, true, byTarget)
  }
  const index: LinkIndex = Object.freeze({
    byTarget,
    hasLinks: true,
  })
  perCatalog.set(catalog, { revision, index })
  return index
}

/**
 * Query live incoming edges for one target, applying the optional view filter.
 * The returned array is a fresh frozen copy; entries themselves are immutable.
 */
export function queryBacklinks(
  state: StateReader,
  catalog: Catalog,
  targetInstancePath: Path,
  filter?: BacklinkQueryFilter,
): readonly BacklinkEntry[] {
  for (const segment of targetInstancePath) assertIdentifier(segment)
  const index = linkIndexOf(state, catalog)
  if (!index.hasLinks) return Object.freeze([])
  const bucket = index.byTarget.get(encodePathKey(targetInstancePath))
  if (bucket === undefined) return Object.freeze([])
  const sourceKey =
    filter?.sourceRootPath === undefined ? undefined : encodePathKey(filter.sourceRootPath)
  const predicate = filter?.filterFieldSpec
  const result: BacklinkEntry[] = []
  for (const entry of bucket) {
    if (sourceKey !== undefined && encodePathKey(entry.sourceRootPath) !== sourceKey) continue
    if (predicate !== undefined && !predicate(entry.fieldSpec)) continue
    result.push(entry)
  }
  return Object.freeze(result)
}

/**
 * Enumerate every physically present Struct instance at or below
 * `subtreeRoot` whose path is an allowed link target.
 *
 * Used as the pre-image for net-disappearance detection and inside the cascade
 * closure. Map members are traversed by concrete IDs; nested Struct fields are
 * included because a link may legally point at any Struct under a target root.
 */
export function collectTargetableInstances(
  state: StateReader,
  catalog: Catalog,
  subtreeRoot: Path,
): readonly Path[] {
  const targets = linkTargetsOf(catalog)
  if (!targets.hasLinks) return Object.freeze([])
  const out: Path[] = []
  const seen = new Set<string>()
  function push(path: Path): void {
    const key = encodePathKey(path)
    if (seen.has(key)) return
    if (targets.wildcard) {
      seen.add(key)
      out.push(Object.freeze([...path]))
      return
    }
    if (targets.keys.some((root) => key === root || key.startsWith(root))) {
      seen.add(key)
      out.push(Object.freeze([...path]))
    }
  }
  for (const root of catalog.roots.values()) {
    if (!intersects(root.path, subtreeRoot)) continue
    const startKey = encodePathKey(root.path)
    const subtreeKey = encodePathKey(subtreeRoot)
    const start = subtreeKey.startsWith(startKey) ? subtreeRoot : root.path
    const spec = physicalSchemaAt(catalog, start)
    if (spec === undefined) continue
    walkStructs(state, spec, start, push)
  }
  return Object.freeze(out)
}

function walkStructs(
  state: StateReader,
  spec: SchemaNode,
  path: Path,
  visit: (path: Path) => void,
): void {
  if (spec.nodeKind === 'leaf') return
  if (!state.hasEntry([...path, '$exists'])) return
  if (spec.nodeKind === 'struct') {
    visit(path)
    for (const [key, child] of Object.entries(spec.fields))
      walkStructs(state, child, [...path, key], visit)
    return
  }
  for (const key of childKeys(state, path)) {
    if (key === '$exists' || key.startsWith('$')) continue
    walkStructs(state, spec.valueSchema, [...path, key], visit)
  }
}

/* -------------------------------------------------------------------------- */
/*                          Three-phase cascade policy                      */
/* -------------------------------------------------------------------------- */

/**
 * Recheck a captured backlink after a cascade has removed source subtrees or
 * an unlink has rewritten its list. Cascade phases only remove edges, so one
 * D_post index remains sufficient when each candidate is checked against the
 * current draft before use.
 */
function isLiveBacklink(state: StateReader, entry: BacklinkEntry, targetKey: string): boolean {
  if (!state.hasEntry([...entry.sourceInstancePath, '$exists'])) return false
  const fieldPath = [...entry.sourceInstancePath, ...entry.fieldRelativePath, '$val']
  const current = getEntry(state, fieldPath)
  if (current?.entryKind !== 'val') return false
  return entry.fieldSpec.valueKind === 'list:str'
    ? Array.isArray(current.value) && current.value.includes(targetKey)
    : current.value === targetKey
}

/**
 * Apply the doc-05 three-phase deletion protocol after a tentative mutation.
 *
 * Inputs are always evaluated against the *current* draft (`D_post`), while
 * `preTargets` must have been collected from `D_pre` for the touched subtree.
 * - Phase 1: close over `cascade` edges until no newly disappeared target
 *   instances remain (`cascadeQueue`), deleting each source instance subtree.
 * - Phase 2: reject if any `reject` edge is still live against a disappeared
 *   target; the caller rolls the whole draft back, so nothing is half-applied.
 * - Phase 3: rewrite live `unlink` edges to `NONE` (single link) or filter the
 *   disappeared keys out of `linkList` values.
 *
 * The caller must run this inside a rollback scope; this function throws
 * `validation_failed` (`referenced_target_not_deletable`) after cascades.
 *
 * One index is captured from D_post and reused throughout all three phases.
 * The cascade cannot create links; current-draft checks discard edges removed
 * along the way instead of rebuilding the entire index after each deletion.
 *
 * @param state Mutable draft in its post-mutation state.
 * @param catalog Writer catalog describing the physical tree.
 * @param preTargets Targetable instances that existed under the touched root before the mutation.
 */
export function applyLinkCascade(
  state: StateWriter,
  catalog: Catalog,
  preTargets: readonly Path[],
): void {
  const targets = linkTargetsOf(catalog)
  if (!targets.hasLinks) return
  const disappeared = new Set<string>()
  const queue: string[] = []
  function seed(path: Path): void {
    const key = encodePathKey(path)
    if (disappeared.has(key)) return
    if (state.hasEntry([...path, '$exists'])) return
    disappeared.add(key)
    queue.push(key)
  }
  for (const target of preTargets) seed(target)
  if (disappeared.size === 0) return
  const index = linkIndexOf(state, catalog)
  while (queue.length > 0) {
    const key = queue.pop()!
    const bucket = index.byTarget.get(key)
    if (bucket === undefined) continue
    for (const entry of bucket) {
      if (entry.onDelete !== 'cascade' || !isLiveBacklink(state, entry, key)) continue
      const source = entry.sourceInstancePath
      // Collect nested targets before the source subtree disappears.
      const subTargets = collectTargetableInstances(state, catalog, source)
      state.deleteTree(source)
      for (const sub of subTargets) seed(sub)
    }
  }
  // Phase 2: any live reject edge into a disappeared instance aborts the draft.
  for (const key of disappeared) {
    const targetPath = decodePathKey(key)
    const bucket = index.byTarget.get(key)
    if (bucket === undefined) continue
    for (const entry of bucket) {
      if (entry.onDelete !== 'reject' || !isLiveBacklink(state, entry, key)) continue
      fail(
        targetPath,
        'referenced_target_not_deletable',
        `instance is still referenced by ${JSON.stringify(entry.sourceInstancePath)}${JSON.stringify(entry.fieldRelativePath)}`,
      )
    }
  }
  // Phase 3: unbind every still-live unlink edge.
  const unlinkedFields = new Set<string>()
  for (const key of disappeared) {
    const bucket = index.byTarget.get(key)
    if (bucket === undefined) continue
    for (const entry of bucket) {
      if (entry.onDelete !== 'unlink' || !isLiveBacklink(state, entry, key)) continue
      const fieldPath = [...entry.sourceInstancePath, ...entry.fieldRelativePath]
      const fieldKey = encodePathKey(fieldPath)
      if (unlinkedFields.has(fieldKey)) continue
      unlinkedFields.add(fieldKey)
      if (entry.fieldSpec.valueKind === 'list:str') {
        const valuePath = [...fieldPath, '$val']
        const current = getEntry(state, valuePath)
        if (current?.entryKind !== 'val' || !Array.isArray(current.value)) continue
        const filtered = current.value.filter(
          (item) => typeof item !== 'string' || !disappeared.has(item),
        )
        setValue(state, valuePath, Object.freeze(filtered))
        continue
      }
      state.deleteTree(fieldPath)
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                        Final-draft link validation                       */
/* -------------------------------------------------------------------------- */

/**
 * Disjoint union identities: public role names are strings, while an untagged
 * declaration uses its catalog leaf object. Reusing the leaf across concrete
 * Map entries groups only that declaration without allocating synthetic names
 * or allowing any user-supplied role string to collide with it.
 */
type LinkUnionKey = string | LeafSchemaNode

interface ScannedEdge {
  readonly sourceInstancePath: Path
  readonly fieldPath: Path
  readonly fieldSpec: LeafSchemaNode
  readonly targetKeys: readonly string[]
  readonly traits: LinkTraits
  /**
   * Union keys this edge participates in: role tags when declared, otherwise a
   * per-declaration key. Untagged links must not form a global union.
   */
  readonly roles: readonly LinkUnionKey[]
}

interface ScanSink {
  readonly edges: ScannedEdge[]
}

function scanForValidation(
  state: StateReader,
  root: SchemaNode,
  path: Path,
  instance: InstanceCursor | undefined,
  boundary: boolean,
  sink: ScanSink,
  declarations: WeakMap<LeafSchemaNode, LinkDeclaration>,
): void {
  if (root.nodeKind === 'leaf') {
    if (instance === undefined) return
    const traits = linkTraitsOf(root)
    if (!traits) return
    const entry = getEntry(state, [...path, '$val'])
    if (entry?.entryKind !== 'val') return
    const keys: string[] = []
    if (root.valueKind === 'list:str') {
      if (!Array.isArray(entry.value)) return
      for (const item of entry.value)
        if (typeof item === 'string' && item.length > 0) keys.push(item)
    } else if (typeof entry.value === 'string' && entry.value.length > 0) {
      keys.push(entry.value)
    }
    if (keys.length === 0) return
    const declared = declarations.get(root)
    sink.edges.push({
      sourceInstancePath: Object.freeze([...instance.path]),
      fieldPath: Object.freeze([...path]),
      fieldSpec: normalizedFieldSpec(root),
      targetKeys: Object.freeze(keys),
      traits,
      roles: declared?.unionKeys ?? linkRoleTags(root, traits),
    })
    return
  }
  if (!state.hasEntry([...path, '$exists'])) return
  if (root.nodeKind === 'struct') {
    const cursor = boundary ? { path, rel: Object.freeze([] as string[]) } : instance
    for (const [key, child] of Object.entries(root.fields)) {
      const next: InstanceCursor | undefined =
        cursor === undefined
          ? undefined
          : { path: cursor.path, rel: Object.freeze([...cursor.rel, key]) }
      scanForValidation(state, child, [...path, key], next, false, sink, declarations)
    }
    return
  }
  for (const key of childKeys(state, path)) {
    if (key === '$exists' || key.startsWith('$')) continue
    const childPath = [...path, key]
    if (root.valueSchema.nodeKind === 'struct') {
      scanForValidation(state, root.valueSchema, childPath, undefined, true, sink, declarations)
    } else {
      const next: InstanceCursor | undefined =
        instance === undefined
          ? undefined
          : { path: instance.path, rel: Object.freeze([...instance.rel, key]) }
      scanForValidation(state, root.valueSchema, childPath, next, false, sink, declarations)
    }
  }
}

/**
 * Role tags declared by one link leaf (`exclusiveRole` plus any upper-plugin
 * `linkRoles` metadata). Returns an empty list for untagged declarations; such
 * links form a union only with the same declaration, not with every untagged
 * link in the catalog.
 */
function linkRoleTags(spec: LeafSchemaNode, traits: LinkTraits): readonly string[] {
  const keys = new Set<string>()
  if (traits.exclusiveRole !== undefined) keys.add(traits.exclusiveRole)
  const roles = spec.metadata.linkRoles
  if (Array.isArray(roles)) {
    for (const role of roles) if (typeof role === 'string' && role.length > 0) keys.add(role)
  }
  return Object.freeze([...keys])
}

function isStructInstanceAt(state: StateReader, catalog: Catalog, path: Path): boolean {
  const spec = physicalSchemaAt(catalog, path)
  return spec?.nodeKind === 'struct' && state.hasEntry([...path, '$exists'])
}

/**
 * Role-union membership and acyclicity declared by one link leaf. These are
 * schema facts, independent of whether the field has any live instance or
 * non-empty value.
 */
interface LinkDeclaration {
  readonly unionKeys: readonly LinkUnionKey[]
  /** Whether this declaration activates the cycle check for its unions. */
  readonly acyclic: boolean
}

interface CatalogLinkDeclarations {
  /** Union identity for every link declaration leaf of the catalog. */
  readonly bySpec: WeakMap<LeafSchemaNode, LinkDeclaration>
  /** Every declared union key mapped to whether any declaration is acyclic. */
  readonly acyclicUnions: ReadonlyMap<LinkUnionKey, boolean>
}

const declarationsCache = new WeakMap<Catalog, CatalogLinkDeclarations>()

/**
 * Collect every link declaration reachable from the catalog roots.
 *
 * A union's acyclicity is a constraint of the Schema, not of the data: a
 * declaration that sets `acyclic` activates the cycle check for every edge
 * sharing its role tags or untagged declaration identity, even when that
 * marked field has no live instance and no non-empty list entry. Untagged
 * declarations share one identity across all concrete Map entries.
 */
function linkDeclarationsOf(catalog: Catalog): CatalogLinkDeclarations {
  const cached = declarationsCache.get(catalog)
  if (cached !== undefined) return cached
  const bySpec = new WeakMap<LeafSchemaNode, LinkDeclaration>()
  const acyclicUnions = new Map<LinkUnionKey, boolean>()
  function visit(node: SchemaNode): void {
    if (node.nodeKind === 'leaf') {
      const traits = linkTraitsOf(node)
      if (traits === undefined) return
      let declaration = bySpec.get(node)
      if (declaration === undefined) {
        const tags = linkRoleTags(node, traits)
        declaration = Object.freeze({
          unionKeys: tags.length > 0 ? tags : Object.freeze([node]),
          acyclic: traits.acyclic === true,
        })
        bySpec.set(node, declaration)
      }
      for (const key of declaration.unionKeys)
        acyclicUnions.set(key, (acyclicUnions.get(key) ?? false) || declaration.acyclic)
      return
    }
    if (node.nodeKind === 'struct') {
      for (const child of Object.values(node.fields)) visit(child)
    } else {
      visit(node.valueSchema)
    }
  }
  for (const root of catalog.roots.values()) visit(root.schema)
  const result: CatalogLinkDeclarations = Object.freeze({
    bySpec,
    acyclicUnions,
  })
  declarationsCache.set(catalog, result)
  return result
}

/**
 * Validate every live link edge of a final draft.
 *
 * Checks, in this order per edge and deterministic root order:
 * 1. each target key decodes to a path and satisfies the field's `targetRoots`
 *    (static prefix union, plus any catalog root when `dynamicTargetRoots`);
 * 2. the target is a physically present Struct instance known to the catalog;
 * 3. per-instance `exclusiveRole` holds at most one non-empty link;
 * 4. role unions: every edge whose declaration shares a role tag joins that
 *    union, and the union is acyclic when ANY Schema declaration sets
 *    `acyclic`, even if that declaration has no live instance/value. Untagged
 *    declarations form a union with themselves (across concrete Map entries)
 *    by schema-declaration identity, so unrelated fields never create false
 *    cycles.
 *
 * Called by `commit` and `syncSchema` on the final state regardless of which
 * write path produced the data, so low-level transaction writes and migrations
 * cannot bypass link semantics.
 *
 * @throws SchemaFailure `validation_failed` with `invalid_link_target`,
 * `exclusive_link_conflict` or `link_cycle`.
 */
export function validateStateLinks(state: StateReader, catalog: Catalog): void {
  const targets = linkTargetsOf(catalog)
  if (!targets.hasLinks) return
  const declarations = linkDeclarationsOf(catalog)
  const sink: ScanSink = { edges: [] }
  for (const root of catalog.roots.values()) {
    if (!containsLinkLeaf(root.schema)) continue
    scanForValidation(state, root.schema, root.path, undefined, true, sink, declarations.bySpec)
  }
  const exclusiveCounts = new Map<string, number>()
  interface AcyclicEdge {
    readonly from: string
    readonly to: string
  }
  interface AcyclicUnion {
    acyclic: boolean
    readonly edges: AcyclicEdge[]
  }
  const unions = new Map<LinkUnionKey, AcyclicUnion>()
  // Seed activation from the Schema itself: an acyclic declaration constrains
  // its union even when no live edge currently references it or its list/root
  // is empty. A later edge lookup only appends to this predeclared entry.
  for (const [role, acyclic] of declarations.acyclicUnions) unions.set(role, { acyclic, edges: [] })

  for (const edge of sink.edges) {
    for (const targetKey of edge.targetKeys) {
      let targetPath: Path = Object.freeze([])
      try {
        targetPath = decodePathKey(targetKey)
      } catch {
        fail(edge.fieldPath, 'invalid_link_target', 'link value is not an encoded instance path')
      }
      if (!isAllowedTarget(targetKey, edge.traits))
        fail(edge.fieldPath, 'invalid_link_target', 'target is outside the declared targetRoots')
      if (!isStructInstanceAt(state, catalog, targetPath))
        fail(edge.fieldPath, 'invalid_link_target', 'target is not an existing Struct instance')
    }
    if (edge.traits.exclusiveRole !== undefined) {
      const sourceKey = encodePathKey(edge.sourceInstancePath)
      const roleKey = `${edge.traits.exclusiveRole}\u0000${sourceKey}`
      const count = (exclusiveCounts.get(roleKey) ?? 0) + 1
      exclusiveCounts.set(roleKey, count)
      if (count > 1)
        fail(
          edge.sourceInstancePath,
          'exclusive_link_conflict',
          `multiple non-empty links for exclusive role ${JSON.stringify(edge.traits.exclusiveRole)}`,
        )
    }
    const sourceKey = encodePathKey(edge.sourceInstancePath)
    for (const role of edge.roles) {
      let union = unions.get(role)
      if (union === undefined) {
        union = { acyclic: false, edges: [] }
        unions.set(role, union)
      }
      for (const targetKey of edge.targetKeys) union.edges.push({ from: sourceKey, to: targetKey })
    }
  }
  for (const [role, union] of unions) {
    if (!union.acyclic) continue
    const cycle = findCycle(union.edges)
    if (cycle !== undefined) {
      const path = decodePathKey(cycle)
      const label = typeof role === 'string' ? role : 'untagged declaration'
      fail(path, 'link_cycle', `acyclic role union ${JSON.stringify(label)} contains a cycle`)
    }
  }
}

/**
 * Iterative three-colour cycle detection. Returns one node on a cycle, or
 * `undefined` for a DAG. Uses an explicit stack so deep hierarchies of
 * thousands of instances cannot overflow the call stack.
 */
function findCycle(edges: readonly { from: string; to: string }[]): string | undefined {
  if (edges.length === 0) return undefined
  const adjacency = new Map<string, string[]>()
  for (const { from, to } of edges) {
    if (from === to) return from
    const list = adjacency.get(from)
    if (list === undefined) adjacency.set(from, [to])
    else list.push(to)
  }
  const state = new Map<string, 1 | 2>()
  for (const start of adjacency.keys()) {
    if (state.has(start)) continue
    const stack: { node: string; index: number }[] = [{ node: start, index: 0 }]
    state.set(start, 1)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const next = adjacency.get(frame.node)
      if (next === undefined || frame.index >= next.length) {
        state.set(frame.node, 2)
        stack.pop()
        continue
      }
      const child = next[frame.index]!
      frame.index += 1
      const status = state.get(child)
      if (status === 1) return child
      if (status === 2) continue
      state.set(child, 1)
      stack.push({ node: child, index: 0 })
    }
  }
  return undefined
}
