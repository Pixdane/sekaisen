/**
 * Safe projection construction.
 *
 * This module is the only place that turns folded facets into agent-facing
 * data. It enforces the three privacy barriers from the specification:
 * - the public prefix is emitted only for a byte-identical raw public surface;
 * - off-scene history reads recorded fact commits, never current objective
 *   values;
 * - folded fields omit their value, and invisible empty shells disappear.
 */

import type { Option } from '@sekaisen/core'
import { BinaryHasher, NONE, some } from '@sekaisen/core'
import type { SchemaMetaMap } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT, valueEquals } from '@sekaisen/plugin-world'
import type { ClaimEvaluator, FoldFacet, FoldResult, LiveFacetInput } from './claims.ts'
import { globalSurfaceCandidate, isGlobalSurfaceField } from './global-surface.ts'
import type { FieldNode, PerspectiveGraph, StructInstance } from './graph.ts'
import { fieldInstancePath, linkTargets, pathsEqual, sortedUniquePaths } from './graph.ts'
import { PerspectiveFailure } from './internal.ts'
import { readableMemoryRelatedEntities, readableMemorySummary } from './memory-access.ts'
import { isSelfOwnedField, ownedInstances } from './ownership.ts'
import type { CognitiveMemoryRecord } from './schemas.ts'
import { DEFAULT_PERSPECTIVE_PRIORITY, MEMORY_LEVEL_RANK, PERSPECTIVES_ROOT } from './schemas.ts'
import type { ObserverScopeState } from './scope.ts'
import { computePublicChannelScope } from './scope.ts'
import type {
  AdjudicatedPathResult,
  AgentWorldProjection,
  InspectedFieldView,
  LinkedEntity,
  ObserverPrivateProjection,
  ProjectedFieldFacet,
  ProjectedFieldView,
  ProjectedInstanceView,
  ProjectedSchemaDictionary,
  ScenePublicProjection,
  SearchableCorpusEntry,
} from './types.ts'
import { isEphemeralSpec, isLinkSpec } from './visibility.ts'

/** Dependencies required by every projection entry point. */
export interface ProjectionDeps {
  readonly graph: PerspectiveGraph
  readonly evaluator: ClaimEvaluator
  readonly commitId: CommitHash
  /** Fixed view at a historical fact commit (for remembered links). */
  readonly graphAt: (commitId: CommitHash) => PerspectiveGraph
}

/** Observer-specific state resolved once per projection request. */
export interface ObserverContext {
  readonly rootId: string
  /** Staged body path, when the observer reference is an entity. */
  readonly actor: Option<Path>
  /** Delegation root entity path, when the observer is an entity. */
  readonly rootEntity: Option<Path>
  /** Live scope, when the actor body exists. */
  readonly scope: Option<ObserverScopeState>
  /** Instances owned through `owner`/`delegate` backlinks, including the root body. */
  readonly owned: ReadonlyMap<string, Path>
}

interface FieldEntry {
  readonly path: Path
  readonly view: ProjectedFieldView
  readonly facet: FoldFacet
  readonly factCommitId: CommitHash
  readonly acquiredAtCommitId: CommitHash
  readonly foldedByDefault: boolean
  /** Cognitive memory that produced this entry, when any. */
  readonly memory?: CognitiveMemoryRecord
  /** True only for the memory narrative `content` field (the corpus text). */
  readonly memoryContent?: boolean
}

interface InstanceBucket {
  readonly path: Path
  readonly fields: Map<string, FieldEntry>
  readonly customFields: Map<string, FieldEntry>
}

class BucketSet {
  readonly buckets = new Map<string, InstanceBucket>()

  add(path: Path, entry: FieldEntry): void {
    const instancePath = fieldInstancePath(path)
    const key = encodePathKey(instancePath)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { path: instancePath, fields: new Map(), customFields: new Map() }
      this.buckets.set(key, bucket)
    }
    const fields = path.at(-2) === '$custom' ? bucket.customFields : bucket.fields
    fields.set(path[path.length - 1]!, entry)
  }
}

/**
 * Reader lens declaration for one path, when the static catalog resolves it.
 *
 * Independent of any instance: this is the safe fallback for rumor-only
 * remembered paths, whose creation event never authorizes objective instance
 * metadata.
 *
 * @param graph - View whose Reader catalog is queried.
 * @param path - Field path.
 * @returns The Reader description, or `NONE` when no lens resolves.
 */
function readerDescription(graph: PerspectiveGraph, path: Path): Option<string> {
  try {
    const lens = graph.fieldLens(path)
    return lens.kind === 'some' ? some(lens.value.schema.description) : NONE
  } catch (cause) {
    if (cause instanceof PerspectiveFailure) return NONE
    throw cause
  }
}

/**
 * Resolve a declared description from one graph view.
 *
 * The owning instance's field spec wins (custom leaves included through the
 * merged `fields` map), then the Reader leaf lens. Dormant Writer roots have
 * no Reader lens, so documented schema failures mean "no declaration here".
 *
 * @param graph - View to query (current or an authorized fact snapshot).
 * @param path - Field path whose declaration is wanted.
 * @returns The declared description, or `NONE` when the view cannot resolve it.
 */
function declaredDescription(graph: PerspectiveGraph, path: Path): Option<string> {
  if (path.length > 1) {
    const instance = graph.instance(fieldInstancePath(path))
    if (instance.kind === 'some') {
      const field = instance.value.fields.get(path[path.length - 1]!)
      if (field) return some(field.spec.description)
    }
  }
  return readerDescription(graph, path)
}

/**
 * Stable synthetic description for a remembered path without a declaration.
 *
 * Used only after the entry's authorized fact snapshot (observed/live) or the
 * static Reader declaration (rumor-only) failed to resolve one. It never reads
 * objective instance metadata and never consults current entity existence.
 *
 * @param path - Field or instance path.
 * @returns The final path segment, or an empty string for the root.
 */
function rememberedLabel(path: Path): string {
  return path.at(-1) ?? ''
}

function summaryOfLeaf(meta: SchemaMetaMap | undefined): Option<string> {
  const summary = meta?.summary
  return typeof summary === 'string' ? some(summary) : NONE
}

function liveCandidateForField(
  graph: PerspectiveGraph,
  scope: Option<ObserverScopeState>,
  instance: StructInstance,
  field: FieldNode,
  kind: 'direct_scope' | 'self_owned',
): Option<LiveFacetInput> {
  const visibility = graph.fieldVisibility(field)
  if (visibility !== 'surface' && kind === 'direct_scope') return NONE
  if (graph.instanceVisibility(instance) === 'self' && kind === 'direct_scope') return NONE
  if (kind === 'self_owned' && !isSelfOwnedField(graph, instance, field)) return NONE
  if (kind === 'direct_scope') {
    if (scope.kind === 'none') return NONE
    const channel = graph.fieldSense(field)
    const channelScope = channel === 'sight' ? scope.value.sight : scope.value.sound
    if (!channelScope.reachablePaths.has(encodePathKey(instance.path))) return NONE
  }
  if (field.value.kind === 'none') return NONE
  return some({
    kind,
    value: field.value.value,
    summary: summaryOfLeaf(field.meta),
  })
}

/** One leaf explicitly declared as a global live-surface field on a struct root. */
interface GlobalSurfaceField {
  readonly instance: StructInstance
  readonly field: FieldNode
}

/**
 * Per-committed-graph memo of declared global leaves.
 *
 * Projection graphs are fixed Reader views (current or historical), so the
 * declaration index cannot change between fields of one query. Draft graphs
 * are never handed to projection entry points.
 */
const GLOBAL_SURFACE_FIELDS = new WeakMap<PerspectiveGraph, readonly GlobalSurfaceField[]>()

/**
 * Declared global live-surface leaves, discovered from the registered roots.
 *
 * Only a root that is itself a struct can declare a feed. Map roots and nested
 * instances are never scanned, so `globalSurface` can never widen into "every
 * entity" and unrelated surface roots stay invisible. The walk is bounded by
 * the Reader root catalog, not by entity count and never per instance lookup.
 *
 * @param deps - Projection dependencies bound to one committed graph.
 * @returns Declared global leaves in root/field declaration order.
 */
function globalSurfaceFields(deps: ProjectionDeps): readonly GlobalSurfaceField[] {
  const cached = GLOBAL_SURFACE_FIELDS.get(deps.graph)
  if (cached !== undefined) return cached
  const found: GlobalSurfaceField[] = []
  for (const root of deps.graph.rootPaths()) {
    const instance = deps.graph.instance(root)
    if (instance.kind === 'none') continue
    for (const field of instance.value.fields.values())
      if (isGlobalSurfaceField(deps.graph, instance.value, field))
        found.push({ instance: instance.value, field })
  }
  const result = Object.freeze(found)
  GLOBAL_SURFACE_FIELDS.set(deps.graph, result)
  return result
}

/**
 * Live global feed entry, folded through the observer's normal claims.
 *
 * The value is read from this projection's commit on every call, never from a
 * synced observation or a writer cache. The evaluator fold keeps exclusions,
 * rumors and observations in charge, so a global declaration cannot bypass
 * arbitration.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param instance - Declaring root instance.
 * @param field - Declared global leaf.
 * @param mode - Routine or expanded facet values.
 * @returns The folded entry, or `NONE` when the feed is not visible/valued.
 */
function globalFieldEntry(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  instance: StructInstance,
  field: FieldNode,
  mode: 'routine' | 'expanded',
): Option<FieldEntry> {
  const candidate = globalSurfaceCandidate(deps.graph, ctx.actor, instance, field)
  if (candidate.kind === 'none') return NONE
  return fieldEntry(deps, field.path, deps.evaluator.fold(field.path, candidate.value), mode)
}

function factOf(facet: FoldFacet, commitId: CommitHash): CommitHash {
  if (facet.sourceKind === 'direct_scope' || facet.sourceKind === 'self_owned') return commitId
  return facet.at.kind === 'some' ? facet.at.value : commitId
}

function acquiredOf(facet: FoldFacet, commitId: CommitHash): CommitHash {
  if (facet.sourceKind === 'direct_scope' || facet.sourceKind === 'self_owned') return commitId
  return facet.acquiredAt.kind === 'some' ? facet.acquiredAt.value : commitId
}

function projectFacet(facet: FoldFacet, mode: 'routine' | 'expanded'): ProjectedFieldFacet {
  const folded = mode === 'routine' && facet.summary.kind === 'some'
  const base = {
    seq: facet.seq,
    summary: facet.summary,
    folded,
    sourceKind: facet.sourceKind,
    at: facet.at,
    acquiredAt: facet.acquiredAt,
    belief: facet.belief,
    source: facet.source,
    sources: facet.sources,
    coWitnesses: facet.coWitnesses,
  } as const
  return folded ? Object.freeze(base) : Object.freeze({ ...base, value: facet.value })
}

function projectField(fold: FoldResult, mode: 'routine' | 'expanded'): Option<ProjectedFieldView> {
  if (fold.primary.kind === 'none') return NONE
  const primary = fold.primary.value
  const others = fold.facets
    .filter((facet) => facet !== primary)
    .map((facet) => projectFacet(facet, mode))
  return some(
    Object.freeze({
      ...projectFacet(primary, mode),
      additionalFacets: Object.freeze(others),
    }),
  )
}

function fieldEntry(
  deps: ProjectionDeps,
  path: Path,
  fold: FoldResult,
  mode: 'routine' | 'expanded',
): Option<FieldEntry> {
  const view = projectField(fold, mode)
  if (view.kind === 'none' || fold.primary.kind === 'none') return NONE
  const primary = fold.primary.value
  return some({
    path,
    view: view.value,
    facet: primary,
    factCommitId: factOf(primary, deps.commitId),
    acquiredAtCommitId: acquiredOf(primary, deps.commitId),
    foldedByDefault: primary.summary.kind === 'some',
  })
}

function liveFold(
  deps: ProjectionDeps,
  field: FieldNode,
  kind: 'direct_scope' | 'self_owned',
  scope: Option<ObserverScopeState>,
  instance: StructInstance,
): FoldResult {
  const candidate = liveCandidateForField(deps.graph, scope, instance, field, kind)
  return deps.evaluator.fold(field.path, candidate.kind === 'some' ? candidate.value : undefined)
}

/** One authorized historical view that can supply remembered shapes/metadata. */
interface RememberedSnapshot {
  readonly graph: PerspectiveGraph
  readonly commitId: CommitHash
}

/** Current graph at the live head, historical graph otherwise. */
function snapshotGraph(deps: ProjectionDeps, commitId: CommitHash): PerspectiveGraph {
  return commitId === deps.commitId ? deps.graph : deps.graphAt(commitId)
}

/**
 * Pick the strongest authorized fact view that still contains `path`.
 *
 * Candidates are deduplicated by commit and ordered by descending claim
 * priority (then encoded commit for determinism). Only commits that actually
 * contain the struct instance are returned, so a remembered record can never
 * borrow a shape from an unrelated view.
 *
 * @param deps - Projection dependencies.
 * @param path - Instance path whose remembered shape is wanted.
 * @param candidates - Fact commits with the priority of the claim that used them.
 * @returns The first resolvable authorized snapshot, or `NONE`.
 */
function firstRememberedSnapshot(
  deps: ProjectionDeps,
  path: Path,
  candidates: readonly { readonly commitId: CommitHash; readonly priority: number }[],
): Option<RememberedSnapshot> {
  const bestByCommit = new Map<CommitHash, number>()
  for (const candidate of candidates) {
    const existing = bestByCommit.get(candidate.commitId)
    if (existing === undefined || candidate.priority > existing)
      bestByCommit.set(candidate.commitId, candidate.priority)
  }
  const ordered = [...bestByCommit.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  for (const [commitId] of ordered) {
    const graph = snapshotGraph(deps, commitId)
    if (graph.instance(path).kind === 'some') return some({ graph, commitId })
  }
  return NONE
}

/**
 * Authorized fact snapshot remembering a now-deleted (or off-scene) instance.
 *
 * Field claims contribute the fact commit of their winning observed facet;
 * an effective `discoveredEntities` record contributes its discovery snapshot.
 * Rumor claims are deliberately ignored: hearing a rumor never authorizes
 * reading objective instance metadata at the rumor-creation commit.
 *
 * @param deps - Projection dependencies.
 * @param path - Instance path to resolve.
 * @returns A readable fact snapshot, or `NONE` when only live/rumor data exists.
 */
function rememberedSnapshot(deps: ProjectionDeps, path: Path): Option<RememberedSnapshot> {
  const tables = deps.evaluator.claimPaths()
  const candidates: { commitId: CommitHash; priority: number }[] = []
  if (
    tables.structural.some((structural) => pathsEqual(structural, path)) &&
    deps.evaluator.effectiveDiscoveredPaths().some((discovered) => pathsEqual(discovered, path))
  ) {
    const primary = deps.evaluator.fold(path).primary
    if (
      primary.kind === 'some' &&
      primary.value.sourceKind === 'observed_claim' &&
      primary.value.belief !== 'known_false' &&
      primary.value.at.kind === 'some'
    )
      candidates.push({ commitId: primary.value.at.value, priority: primary.value.priority })
  }
  for (const fieldPath of tables.fields) {
    if (!pathsEqual(fieldInstancePath(fieldPath), path)) continue
    const primary = deps.evaluator.fold(fieldPath).primary
    if (primary.kind === 'none') continue
    const facet = primary.value
    if (
      facet.sourceKind !== 'observed_claim' ||
      facet.belief === 'known_false' ||
      facet.at.kind === 'none'
    )
      continue
    candidates.push({ commitId: facet.at.value, priority: facet.priority })
  }
  return firstRememberedSnapshot(deps, path, candidates)
}

/**
 * Authorized fact snapshot remembering a bucket whose entity is now deleted.
 *
 * The winning observed entry (highest priority, then stable commit order)
 * supplies the commit whose instance spec describes the remembered shape.
 *
 * @param deps - Projection dependencies.
 * @param bucket - Instance bucket assembled from claims.
 * @returns A readable fact snapshot, or `NONE` for rumor-only buckets.
 */
function rememberedBucketSnapshot(
  deps: ProjectionDeps,
  bucket: InstanceBucket,
): Option<RememberedSnapshot> {
  const candidates: { commitId: CommitHash; priority: number }[] = []
  for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()]) {
    if (entry.facet.sourceKind !== 'observed_claim' || entry.facet.belief === 'known_false')
      continue
    candidates.push({ commitId: entry.factCommitId, priority: entry.facet.priority })
  }
  return firstRememberedSnapshot(deps, bucket.path, candidates)
}

/** Enumerate every instance visible in at least one live channel. */
function visibleInstances(ctx: ObserverContext, deps: ProjectionDeps): readonly Path[] {
  if (ctx.scope.kind === 'none') return []
  const keys = new Map<string, Path>([
    ...ctx.scope.value.sight.reachablePaths,
    ...ctx.scope.value.sound.reachablePaths,
  ])
  return sortedUniquePaths(
    [...keys.values()].filter((path) => deps.graph.instance(path).kind === 'some'),
  )
}

/** Build the observer context shared by project/inspect/corpus. */
export function observerContext(
  deps: ProjectionDeps,
  rootId: string,
  actor: Option<Path>,
  rootEntity: Option<Path>,
  scope: Option<ObserverScopeState>,
): ObserverContext {
  const owned =
    rootEntity.kind === 'some'
      ? ownedInstances(deps.graph, rootEntity.value)
      : new Map<string, Path>()
  return { rootId, actor, rootEntity, scope, owned }
}

function isInLiveScope(ctx: ObserverContext, path: Path): boolean {
  if (ctx.scope.kind === 'none') return false
  const key = encodePathKey(path)
  return (
    ctx.scope.value.sight.reachablePaths.has(key) || ctx.scope.value.sound.reachablePaths.has(key)
  )
}

/**
 * Field-level claim targets, taken from the claim records alone.
 *
 * The enumeration never asks whether the path currently exists: a deleted
 * entity's remembered leaves and a live entity's hidden leaves are both
 * ordinary field claims. Structural discovery identities are excluded by
 * construction, so they can never become ghost field entries.
 *
 * @param deps - Projection dependencies.
 * @returns Deduplicated, path-key sorted field claim paths.
 */
function fieldClaimPaths(deps: ProjectionDeps): readonly Path[] {
  const result: Path[] = []
  for (const path of deps.evaluator.claimPaths().fields) {
    if (path[0] === '$message') {
      result.push(path)
      continue
    }
    if (path.length < 2) continue
    if (
      path.some(
        (segment, index) =>
          segment.startsWith('$') && !(segment === '$custom' && index === path.length - 2),
      )
    )
      continue
    result.push(path)
  }
  return sortedUniquePaths(result)
}

/** Segment naming the cognitive-memory Map under a perspective node. */
const MEMORIES_SEGMENT = 'memories'

/**
 * Neutral positive seq for the observer-independent raw public surface.
 *
 * `scenePublic` is contractually byte-identical across observers and with
 * `projectScopePublic`, while live agent-facing entries expose the observer's
 * `nextSeq`. The shared prefix therefore carries this stable value; merged and
 * private live entries are rebuilt with the observer sequence.
 */
const PUBLIC_SCENE_SEQ = 1

/** Memory fields safe to expose to the owning/inheriting observer. */
const MEMORY_PROJECTED_FIELDS = [
  'level',
  'eventOrigin',
  'significance',
  'tier',
  'strength',
  'belief',
  'priority',
  'seq',
  'startTime',
  'endTime',
  'content',
] as const

/** Coordinates decoded from a four-segment memory instance path. */
interface MemoryPathCoordinates {
  readonly perspectiveId: string
  readonly memoryId: string
}

/**
 * Perspective id of `['perspectives', P, 'memories']`, when `path` is that Map.
 *
 * @param path - Candidate path.
 * @returns The owning perspective id, or `NONE` for any other path.
 */
function memoryMapPerspectiveId(path: Path): Option<string> {
  if (path.length !== PERSPECTIVES_ROOT.length + 2) return NONE
  if (!PERSPECTIVES_ROOT.every((segment, index) => path[index] === segment)) return NONE
  if (path[PERSPECTIVES_ROOT.length + 1] !== MEMORIES_SEGMENT) return NONE
  return some(path[PERSPECTIVES_ROOT.length]!)
}

/**
 * Decode `['perspectives', P, 'memories', M]`.
 *
 * @param path - Candidate path.
 * @returns Coordinates for exactly four memory segments, otherwise `NONE`.
 */
function parseMemoryPath(path: Path): Option<MemoryPathCoordinates> {
  if (path.length !== PERSPECTIVES_ROOT.length + 3) return NONE
  const mapPerspective = memoryMapPerspectiveId(path.slice(0, PERSPECTIVES_ROOT.length + 2))
  if (mapPerspective.kind === 'none') return NONE
  return some({
    perspectiveId: mapPerspective.value,
    memoryId: path[PERSPECTIVES_ROOT.length + 2]!,
  })
}

/**
 * Authorized cognitive memory at an exact memory instance path.
 *
 * A memory is readable only through the observer's ordered inheritance chain,
 * so a foreign perspective's memory is invisible even though the schema view
 * contains it. Prefix exclusions at the memory path or any ancestor suppress
 * it before any field is projected.
 *
 * @param deps - Projection dependencies.
 * @param path - Memory instance path.
 * @returns The memory record, or `NONE`.
 */
function memoryAtPath(deps: ProjectionDeps, path: Path): Option<CognitiveMemoryRecord> {
  const parsed = parseMemoryPath(path)
  if (parsed.kind === 'none') return NONE
  if (!deps.evaluator.orderedPerspectives().includes(parsed.value.perspectiveId)) return NONE
  const record = deps.evaluator.perspectives
    .get(parsed.value.perspectiveId)
    ?.memories.get(parsed.value.memoryId)
  if (record === undefined) return NONE
  if (record.ownerPerspectiveId !== parsed.value.perspectiveId) return NONE
  if (!pathsEqual(record.path, path)) return NONE
  if (deps.evaluator.suppressed(record.path, record.priority)) return NONE
  return some(record)
}

/** Visible memories of one perspective, after prefix exclusions. */
function memoryRecordsFor(
  deps: ProjectionDeps,
  perspectiveId: string,
): readonly CognitiveMemoryRecord[] {
  if (!deps.evaluator.orderedPerspectives().includes(perspectiveId)) return []
  const record = deps.evaluator.perspectives.get(perspectiveId)
  if (record === undefined) return []
  const memories: CognitiveMemoryRecord[] = []
  for (const memory of record.memories.values()) {
    if (memory.ownerPerspectiveId !== perspectiveId) continue
    if (deps.evaluator.suppressed(memory.path, memory.priority)) continue
    memories.push(memory)
  }
  return memories
}

/**
 * One projected memory field.
 *
 * Memory text is the observer's own narrative: `factEventRef` and
 * `factSnapshotRef` provide time anchors only and are never dereferenced into
 * objective message/state content. `SELF_COMMIT` anchors normalize to the
 * fixed projection commit.
 *
 * @param deps - Projection dependencies.
 * @param memory - Source memory record.
 * @param fieldName - Safe field name.
 * @param value - Subjective value.
 * @param path - Exact field path.
 * @returns The field entry.
 */
function memoryFieldEntry(
  deps: ProjectionDeps,
  memory: CognitiveMemoryRecord,
  fieldName: string,
  value: Value,
  path: Path,
): Option<FieldEntry> {
  const at =
    memory.factSnapshotRef.commitId === SELF_COMMIT
      ? deps.commitId
      : memory.factSnapshotRef.commitId
  const acquiredAt =
    memory.acquiredAtRef.commitId === SELF_COMMIT ? deps.commitId : memory.acquiredAtRef.commitId
  const summary = fieldName === 'content' ? readableMemorySummary(deps.evaluator, memory) : NONE
  const facet: FoldFacet = Object.freeze({
    sourceKind: 'observed_claim',
    seq: memory.seq,
    priority: memory.priority,
    belief: memory.belief,
    source: NONE,
    sources: Object.freeze([]),
    coWitnesses: Object.freeze([]),
    at: some(at),
    acquiredAt: some(acquiredAt),
    originEventRef: some(memory.originRef),
    targetRef: some(memory.factSnapshotRef),
    factEventRef: NONE,
    value,
    summary,
    recordKey: memory.memoryId,
  })
  const projected = projectFacet(facet, 'routine')
  return some(
    Object.freeze({
      path,
      view: Object.freeze({ ...projected, additionalFacets: Object.freeze([]) }),
      facet,
      factCommitId: at,
      acquiredAtCommitId: acquiredAt,
      foldedByDefault: summary.kind === 'some',
      memory,
      memoryContent: fieldName === 'content',
    }),
  )
}

/**
 * Safe, exclusion-filtered fields of one cognitive memory.
 *
 * Only narrative metadata is exposed. Evidence refs, supporting claim keys,
 * `relatedEntities` rows and `children` links stay internal: related entities
 * are projected solely through authorization-filtered corpus `linkedEntities`.
 *
 * @param deps - Projection dependencies.
 * @param memory - Source memory record.
 * @returns Projected field entries in the declared safe-field order.
 */
function memoryFieldEntries(
  deps: ProjectionDeps,
  memory: CognitiveMemoryRecord,
): readonly FieldEntry[] {
  const instance = deps.graph.instance(memory.path)
  if (instance.kind === 'none') return []
  const values: Record<string, Value> = {
    level: memory.level,
    eventOrigin: memory.eventOrigin,
    significance: memory.significance,
    tier: memory.tier,
    strength: memory.strength,
    belief: memory.belief,
    priority: memory.priority,
    seq: memory.seq,
    content: memory.content,
  }
  if (memory.startTime.kind === 'some') values.startTime = memory.startTime.value
  if (memory.endTime.kind === 'some') values.endTime = memory.endTime.value
  const entries: FieldEntry[] = []
  for (const fieldName of MEMORY_PROJECTED_FIELDS) {
    if (!Object.hasOwn(values, fieldName)) continue
    if (!instance.value.fields.has(fieldName)) continue
    const path = [...memory.path, fieldName]
    if (deps.evaluator.suppressed(path, memory.priority)) continue
    const entry = memoryFieldEntry(deps, memory, fieldName, values[fieldName]!, path)
    if (entry.kind === 'some') entries.push(entry.value)
  }
  return entries
}

/**
 * Authorized projected field entry at one exact memory field path.
 *
 * @param deps - Projection dependencies.
 * @param path - Candidate field path.
 * @returns The entry, or `NONE` for non-memory/unknown/unauthorized fields.
 */
function memoryFieldEntryAt(deps: ProjectionDeps, path: Path): Option<FieldEntry> {
  if (path.length !== PERSPECTIVES_ROOT.length + 4) return NONE
  const memory = memoryAtPath(deps, path.slice(0, -1))
  if (memory.kind === 'none') return NONE
  for (const entry of memoryFieldEntries(deps, memory.value))
    if (pathsEqual(entry.path, path)) return some(entry)
  return NONE
}

/**
 * Whether `path` is a memory instance or any node below one.
 *
 * Used to fence off internal memory structure (evidence refs, supporting
 * claims, related-entity rows, child links) from generic instance expansion.
 *
 * @param path - Candidate path.
 * @returns True for a memory path or a descendant of one.
 */
function isMemoryDescendant(path: Path): boolean {
  for (let length = PERSPECTIVES_ROOT.length + 3; length <= path.length; length++)
    if (parseMemoryPath(path.slice(0, length)).kind === 'some') return true
  return false
}

/** Memory buckets plus the child memories folded by a live parent summary. */
interface MemoryBuckets {
  readonly own: BucketSet
  readonly inherited: BucketSet
  readonly foldedChildKeys: ReadonlySet<string>
}

/**
 * Collect own and inherited cognitive memories.
 *
 * Own-root memories become private self instances; ancestor-perspective
 * memories remain readable off-scene inheritance. A visible parent summary
 * with `belief !== 'known_false'` folds visible child memories of strictly
 * lower level whose sequence does not exceed the parent's. Corpus consumers
 * keep the children and mark them folded instead.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @returns Memory buckets and folded child keys.
 */
function collectMemoryBuckets(deps: ProjectionDeps, ctx: ObserverContext): MemoryBuckets {
  const own = new BucketSet()
  const inherited = new BucketSet()
  const visible = new Map<string, CognitiveMemoryRecord>()
  for (const perspectiveId of deps.evaluator.orderedPerspectives()) {
    /*
     * Every memory keeps its owning perspective's local seq. Inherited values
     * are therefore source-ordered, not globally chronological observer
     * timestamps; consumers must not compare seq across perspectives.
     */
    for (const memory of memoryRecordsFor(deps, perspectiveId)) {
      const entries = memoryFieldEntries(deps, memory)
      if (entries.length === 0) continue
      const target = perspectiveId === ctx.rootId ? own : inherited
      for (const entry of entries) target.add(entry.path, entry)
      if (entries.some((entry) => entry.memoryContent))
        visible.set(encodePathKey(memory.path), memory)
    }
  }
  const foldedChildKeys = new Set<string>()
  for (const parent of visible.values()) {
    if (parent.belief === 'known_false') continue
    const parentPath = parseMemoryPath(parent.path)
    if (parentPath.kind === 'none') continue
    for (const childPath of parent.children) {
      const child = parseMemoryPath(childPath)
      if (child.kind === 'none') continue
      if (child.value.perspectiveId !== parentPath.value.perspectiveId) continue
      const childKey = encodePathKey(childPath)
      const childMemory = visible.get(childKey)
      if (childMemory === undefined) continue
      if (MEMORY_LEVEL_RANK[childMemory.level] >= MEMORY_LEVEL_RANK[parent.level]) continue
      if (childMemory.seq > parent.seq) continue
      foldedChildKeys.add(childKey)
    }
  }
  return { own, inherited, foldedChildKeys }
}

interface Collected {
  readonly scenePublic: ScenePublicProjection | null
  readonly publicBuckets: BucketSet
  readonly overrideBuckets: BucketSet
  readonly selfBuckets: BucketSet
  readonly offSceneBuckets: BucketSet
  readonly mergedBuckets: BucketSet
  readonly memoryFoldedChildKeys: ReadonlySet<string>
}

/**
 * Schema dictionary for a bucket set.
 *
 * Whole-schema expansion requires current spatial/ownership access or an
 * effective historical entity discovery. Field observations describe their
 * authorized snapshot fields; feeds and rumors never authorize sibling
 * declarations, even when mixed in the same bucket. Historical labels remain
 * bound to their recorded snapshot, not unknown current objective metadata.
 * Dictionary keys may be any legal Schema identifier, including `__proto__`;
 * all name-indexed containers use the same null-prototype convention as Schema.
 *
 * @param deps - Projection dependencies.
 * @param buckets - Buckets to describe.
 * @param ctx - Observer structure permissions; omitted only for raw public builders.
 * @returns Frozen, encoded-instance-keyed schema dictionary.
 */
function schemaOfBuckets(
  deps: ProjectionDeps,
  buckets: BucketSet,
  ctx?: ObserverContext,
): ProjectedSchemaDictionary {
  const dictionary: Record<
    string,
    { description: string; fields: Record<string, { description: string }> }
  > = Object.create(null)
  for (const [key, bucket] of buckets.buckets) {
    const entries = [...bucket.fields.values(), ...bucket.customFields.values()]
    const memoryInstance = parseMemoryPath(bucket.path).kind === 'some'
    // Public builders select actual scene structure; observer views must prove
    // spatial/ownership access independently of the bucket's mixture of values.
    const currentStructure =
      memoryInstance || ctx === undefined || ctx.owned.has(key) || isInLiveScope(ctx, bucket.path)
    let discovered: Option<RememberedSnapshot> = NONE
    if (
      !currentStructure &&
      deps.evaluator.effectiveDiscoveredPaths().some((path) => pathsEqual(path, bucket.path))
    ) {
      const discoveryCandidates: { commitId: CommitHash; priority: number }[] = []
      for (const facet of deps.evaluator.fold(bucket.path).facets)
        if (
          facet.sourceKind === 'observed_claim' &&
          facet.belief !== 'known_false' &&
          facet.at.kind === 'some'
        )
          discoveryCandidates.push({ commitId: facet.at.value, priority: facet.priority })
      if (discoveryCandidates.length > 0)
        discovered = firstRememberedSnapshot(deps, bucket.path, discoveryCandidates)
    }
    let shape: StructInstance | undefined
    if (currentStructure) {
      const instance = deps.graph.instance(bucket.path)
      if (instance.kind === 'some') shape = instance.value
    } else {
      const remembered =
        discovered.kind === 'some' ? discovered : rememberedBucketSnapshot(deps, bucket)
      if (remembered.kind === 'some') {
        const instance = remembered.value.graph.instance(bucket.path)
        if (instance.kind === 'some') shape = instance.value
      }
    }
    const fields: Record<string, { description: string }> = Object.create(null)
    if (shape && !memoryInstance && (currentStructure || discovered.kind === 'some')) {
      for (const [name, spec] of Object.entries(shape.spec.fields))
        fields[name] = { description: spec.description }
    }
    for (const entry of entries) {
      const name = entry.path[entry.path.length - 1]!
      if (!Object.hasOwn(fields, name))
        fields[name] = { description: entryDescription(deps, entry) }
    }
    dictionary[key] = {
      description: shape ? shape.spec.description : rememberedLabel(bucket.path),
      fields,
    }
  }
  return Object.freeze(dictionary)
}

/**
 * Description for one entry, preferring the declaration captured by its fact.
 *
 * Live and observed entries read the authorized view at `factCommitId`, so
 * before/after an unknown off-scene deletion the same remembered declaration
 * is returned. A rumor-claim entry deliberately skips the rumor-creation
 * commit (that event does not authorize objective metadata) and falls back to
 * the current Reader declaration or a stable synthetic label.
 *
 * @param deps - Projection dependencies.
 * @param entry - Projected field entry.
 * @returns A non-empty description when any declaration exists.
 */
function entryDescription(deps: ProjectionDeps, entry: FieldEntry): string {
  if (entry.memory !== undefined) {
    const declared = declaredDescription(deps.graph, entry.path)
    return declared.kind === 'some' ? declared.value : rememberedLabel(entry.path)
  }
  if (entry.facet.sourceKind !== 'rumor_claim') {
    const declared = declaredDescription(snapshotGraph(deps, entry.factCommitId), entry.path)
    if (declared.kind === 'some') return declared.value
    const current = declaredDescription(deps.graph, entry.path)
    return current.kind === 'some' ? current.value : rememberedLabel(entry.path)
  }
  // A rumor-creation commit is not evidence of the objective node. Use only
  // the static Reader declaration, otherwise a stable synthetic label.
  const reader = readerDescription(deps.graph, entry.path)
  return reader.kind === 'some' ? reader.value : rememberedLabel(entry.path)
}

/**
 * Materialize public/private instance dictionaries without interpreting names
 * as Object prototype setters. Declared and custom fields retain every legal
 * identifier as an own, JSON-serializable property.
 */
function instanceViews(buckets: BucketSet): Readonly<Record<string, ProjectedInstanceView>> {
  const views: Record<string, ProjectedInstanceView> = Object.create(null)
  for (const [key, bucket] of buckets.buckets) {
    if (bucket.fields.size === 0 && bucket.customFields.size === 0) continue
    const fields: Record<string, ProjectedFieldView> = Object.create(null)
    const customFields: Record<string, ProjectedFieldView> = Object.create(null)
    for (const [name, entry] of bucket.fields) fields[name] = entry.view
    for (const [name, entry] of bucket.customFields) customFields[name] = entry.view
    views[key] = Object.freeze({
      path: bucket.path,
      fields: Object.freeze(fields),
      customFields: Object.freeze(customFields),
    })
  }
  return Object.freeze(views)
}

/**
 * Resolve folding relations only from snapshots the observer actually knows.
 * Current off-scene role edits must not unfold or hide remembered instances;
 * rumors alone do not reveal the corresponding objective graph.
 */
function subsumedInstanceKeys(deps: ProjectionDeps, buckets: BucketSet): ReadonlySet<string> {
  const hidden = new Set<string>()
  for (const bucket of buckets.buckets.values()) {
    if (parseMemoryPath(bucket.path).kind === 'some') continue
    const commits = new Set<CommitHash>()
    for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()])
      if (entry.facet.sourceKind !== 'rumor_claim') commits.add(entry.factCommitId)
    for (const commit of commits) {
      const graph = snapshotGraph(deps, commit)
      const instance = graph.instance(bucket.path)
      if (instance.kind === 'none') continue
      for (const link of graph.roleLinks(instance.value, 'subsumes'))
        hidden.add(encodePathKey(link.target))
    }
  }
  return hidden
}

function withoutSubsumed(deps: ProjectionDeps, buckets: BucketSet): BucketSet {
  const hidden = subsumedInstanceKeys(deps, buckets)
  for (const key of hidden) buckets.buckets.delete(key)
  return buckets
}

function mergeBuckets(target: BucketSet, source: BucketSet): void {
  for (const bucket of source.buckets.values())
    for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()])
      target.add(entry.path, entry)
}

/**
 * Observer-independent live entry for one public field.
 *
 * The entry owns a fresh `direct_scope` facet with canonical priority and no
 * coexisting facets. Raw public material must never carry any observer's
 * exclusion, rumor or private `additionalFacets`, so this helper bypasses the
 * claim evaluator entirely.
 *
 * @param deps - Projection dependencies (fact anchor only).
 * @param field - Effective Reader field with a stored value.
 * @returns The self-contained entry, or `NONE` when the field has no value.
 */
function publicFieldEntry(deps: ProjectionDeps, field: FieldNode, seq: number): Option<FieldEntry> {
  if (field.value.kind === 'none') return NONE
  const facet: FoldFacet = Object.freeze({
    sourceKind: 'direct_scope',
    seq,
    priority: DEFAULT_PERSPECTIVE_PRIORITY,
    belief: 'believed',
    source: NONE,
    sources: Object.freeze([]),
    coWitnesses: Object.freeze([]),
    at: NONE,
    acquiredAt: NONE,
    originEventRef: NONE,
    targetRef: NONE,
    factEventRef: NONE,
    value: field.value.value,
    summary: summaryOfLeaf(field.meta),
    recordKey: 'public',
  })
  const view = projectFacet(facet, 'routine')
  return some({
    path: field.path,
    view: Object.freeze({ ...view, additionalFacets: Object.freeze([]) }),
    facet,
    factCommitId: deps.commitId,
    acquiredAtCommitId: deps.commitId,
    foldedByDefault: facet.summary.kind === 'some',
  })
}

/**
 * Raw standard public surface for a non-diverging observer.
 *
 * Every emitted facet is built from the live public field itself: the observer
 * evaluator is never consulted, so the surface is byte-identical for every
 * observer sharing the same ceiling and cannot include private additional
 * facets. Effective runtime/static field and instance visibility are honored
 * through the graph accessors.
 *
 * @param deps - Projection dependencies.
 * @param scope - Observer scope proven non-diverging by the scope engine.
 * @returns Public buckets for the ceiling.
 */
function rawPublicBuckets(deps: ProjectionDeps, scope: ObserverScopeState, seq: number): BucketSet {
  const buckets = new BucketSet()
  const sightCeiling = scope.sight.ceiling
  const soundCeiling = scope.sound.ceiling
  if (sightCeiling.kind === 'none' || soundCeiling.kind === 'none') return buckets
  const domains = new Map<string, Path>([
    ...computePublicChannelScope(deps.graph, sightCeiling.value, 'sight'),
    ...computePublicChannelScope(deps.graph, soundCeiling.value, 'sound'),
  ])
  for (const [key, path] of domains) {
    const instance = deps.graph.instance(path)
    if (instance.kind === 'none' || deps.graph.instanceVisibility(instance.value) !== 'surface')
      continue
    for (const field of instance.value.fields.values()) {
      if (deps.graph.fieldVisibility(field) !== 'surface') continue
      const channel = deps.graph.fieldSense(field)
      const channelDomains = channel === 'sight' ? scope.sight.publicPaths : scope.sound.publicPaths
      if (!channelDomains.has(key)) continue
      const entry = publicFieldEntry(deps, field, seq)
      if (entry.kind === 'some') buckets.add(field.path, entry.value)
    }
  }
  return buckets
}

/**
 * Whether a live field already belongs to the raw public shared surface.
 *
 * Uses effective runtime/static visibility so a field concealed at runtime is
 * never folded into the observer-private override block.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param instance - Owning instance.
 * @param field - Candidate field.
 * @returns True when the field is part of the raw public surface.
 */
function inRawPublicField(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  instance: StructInstance,
  field: FieldNode,
): boolean {
  if (ctx.scope.kind === 'none' || !ctx.scope.value.canUseRawPublicScope) return false
  if (deps.graph.fieldVisibility(field) !== 'surface') return false
  if (deps.graph.instanceVisibility(instance) !== 'surface') return false
  const channelScope =
    deps.graph.fieldSense(field) === 'sight' ? ctx.scope.value.sight : ctx.scope.value.sound
  return channelScope.publicPaths.has(encodePathKey(instance.path))
}

/** Collect the same authorized fields; corpus mode retains folded supporting evidence. */
function collect(deps: ProjectionDeps, ctx: ObserverContext, forCorpus = false): Collected {
  const overrideBuckets = new BucketSet()
  const selfBuckets = new BucketSet()
  const offSceneBuckets = new BucketSet()
  const handled = new Set<string>()

  for (const instancePath of visibleInstances(ctx, deps)) {
    const instance = deps.graph.instance(instancePath)
    if (instance.kind === 'none') continue
    const owned = ctx.owned.has(encodePathKey(instancePath))
    for (const field of instance.value.fields.values()) {
      if (field.value.kind === 'none') continue
      const hiddenField = deps.graph.fieldVisibility(field) !== 'surface'
      if (owned && isSelfOwnedField(deps.graph, instance.value, field)) {
        const fold = liveFold(deps, field, 'self_owned', ctx.scope, instance.value)
        const entry = fieldEntry(deps, field.path, fold, 'routine')
        if (entry.kind === 'none') continue
        handled.add(encodePathKey(field.path))
        if (fold.primary.kind === 'some' && fold.primary.value.sourceKind === 'self_owned')
          selfBuckets.add(field.path, entry.value)
        else overrideBuckets.add(field.path, entry.value)
        continue
      }
      if (hiddenField) continue
      const fold = liveFold(deps, field, 'direct_scope', ctx.scope, instance.value)
      const entry = fieldEntry(deps, field.path, fold, 'routine')
      if (entry.kind === 'none') continue
      handled.add(encodePathKey(field.path))
      if (inRawPublicField(deps, ctx, instance.value, field)) continue
      overrideBuckets.add(field.path, entry.value)
    }
  }

  // Only private self fields bypass physical scope through ownership.
  for (const path of ctx.owned.values()) {
    if (isInLiveScope(ctx, path)) continue
    const instance = deps.graph.instance(path)
    if (instance.kind === 'none') continue
    for (const field of instance.value.fields.values()) {
      if (!isSelfOwnedField(deps.graph, instance.value, field)) continue
      if (field.value.kind === 'none') continue
      const fold = liveFold(deps, field, 'self_owned', ctx.scope, instance.value)
      const entry = fieldEntry(deps, field.path, fold, 'routine')
      if (entry.kind === 'none') continue
      handled.add(encodePathKey(field.path))
      if (fold.primary.kind === 'some' && fold.primary.value.sourceKind === 'self_owned')
        selfBuckets.add(field.path, entry.value)
      else overrideBuckets.add(field.path, entry.value)
    }
  }

  /*
   * Declared global live-surface leaves are re-read from this projection's
   * commit for staged physical observers. They stay out of the raw public
   * prefix so every observer's scenePublic remains byte-identical, and they
   * fold through the evaluator so exclusions and rumors keep their normal
   * arbitration. A feed never grants ownership, navigation or link-target
   * identities: those checks use geometric scope and discovery predicates,
   * which a global leaf does not change.
   */
  if (ctx.scope.kind === 'some')
    for (const { instance, field } of globalSurfaceFields(deps)) {
      const key = encodePathKey(field.path)
      if (handled.has(key)) continue
      const entry = globalFieldEntry(deps, ctx, instance, field, 'routine')
      if (entry.kind === 'none') continue
      handled.add(key)
      overrideBuckets.add(field.path, entry.value)
    }

  // Memory-only paths not produced by the live pass (hidden fields, off-scene).
  for (const path of fieldClaimPaths(deps)) {
    if (isMemoryDescendant(path)) continue
    if (handled.has(encodePathKey(path))) continue
    const fold = deps.evaluator.fold(path)
    const entry = fieldEntry(deps, path, fold, 'routine')
    if (entry.kind === 'none') continue
    const instancePath = fieldInstancePath(path)
    if (isInLiveScope(ctx, instancePath) || ctx.owned.has(encodePathKey(instancePath)))
      overrideBuckets.add(path, entry.value)
    else offSceneBuckets.add(path, entry.value)
  }

  // Own-root and inherited cognitive memories are observer-private content.
  const memoryBuckets = collectMemoryBuckets(deps, ctx)
  mergeBuckets(selfBuckets, memoryBuckets.own)
  mergeBuckets(offSceneBuckets, memoryBuckets.inherited)
  if (!forCorpus) {
    for (const key of memoryBuckets.foldedChildKeys) {
      selfBuckets.buckets.delete(key)
      offSceneBuckets.buckets.delete(key)
    }
  }

  const publicBuckets = new BucketSet()
  let scenePublic: ScenePublicProjection | null = null
  if (ctx.scope.kind === 'some' && ctx.scope.value.canUseRawPublicScope) {
    const ceiling = ctx.scope.value.sight.ceiling
    if (ceiling.kind === 'some') {
      if (forCorpus) {
        mergeBuckets(
          publicBuckets,
          rawPublicBuckets(deps, ctx.scope.value, deps.evaluator.nextSeq()),
        )
      } else {
        const shared = rawPublicBuckets(deps, ctx.scope.value, PUBLIC_SCENE_SEQ)
        withoutSubsumed(deps, shared)
        scenePublic = Object.freeze({
          sceneRootPath: ceiling.value,
          schemas: schemaOfBuckets(deps, shared),
          instances: instanceViews(shared),
        })
        const agent = rawPublicBuckets(deps, ctx.scope.value, deps.evaluator.nextSeq())
        withoutSubsumed(deps, agent)
        mergeBuckets(publicBuckets, agent)
      }
    }
  }

  if (!forCorpus) {
    withoutSubsumed(deps, overrideBuckets)
    withoutSubsumed(deps, selfBuckets)
    withoutSubsumed(deps, offSceneBuckets)
  }

  const mergedBuckets = new BucketSet()
  mergeBuckets(mergedBuckets, publicBuckets)
  mergeBuckets(mergedBuckets, overrideBuckets)
  mergeBuckets(mergedBuckets, selfBuckets)
  mergeBuckets(mergedBuckets, offSceneBuckets)
  if (!forCorpus) withoutSubsumed(deps, mergedBuckets)

  return {
    scenePublic,
    publicBuckets,
    overrideBuckets,
    selfBuckets,
    offSceneBuckets,
    mergedBuckets,
    memoryFoldedChildKeys: memoryBuckets.foldedChildKeys,
  }
}

/**
 * Build the complete agent projection.
 *
 * The routine mode folds fields with summaries; `inspect` reuses the same fold
 * data but expands values.
 */
export function buildProjection(deps: ProjectionDeps, ctx: ObserverContext): AgentWorldProjection {
  const collected = collect(deps, ctx)
  const privateBuckets = new BucketSet()
  mergeBuckets(privateBuckets, collected.selfBuckets)
  mergeBuckets(privateBuckets, collected.overrideBuckets)
  mergeBuckets(privateBuckets, collected.offSceneBuckets)
  const privateView: ObserverPrivateProjection = Object.freeze({
    rootPerspectiveId: ctx.rootId,
    schemas: schemaOfBuckets(deps, privateBuckets, ctx),
    selfInstances: instanceViews(collected.selfBuckets),
    inScenePrivateOverrides: instanceViews(collected.overrideBuckets),
    offSceneKnownInstances: instanceViews(collected.offSceneBuckets),
  })
  return Object.freeze({
    rootPerspectiveId: ctx.rootId,
    scenePublic: collected.scenePublic === null ? NONE : some(collected.scenePublic),
    privateView,
    schemas: schemaOfBuckets(deps, collected.mergedBuckets, ctx),
    mergedInstances: instanceViews(collected.mergedBuckets),
  })
}

/**
 * Build a raw public projection independent of any observer claims.
 *
 * The host-only counterpart of the observer's raw public surface: every entry
 * is a fresh live `direct_scope` facet, so observer memory never influences
 * the result and public link fields keep their encoded endpoint strings.
 *
 * @param deps - Projection dependencies.
 * @param sceneRoot - Ceiling container to expand.
 * @returns Frozen raw public scene projection.
 */
export function buildPublicProjection(
  deps: ProjectionDeps,
  sceneRoot: Path,
): ScenePublicProjection {
  const buckets = new BucketSet()
  const sightDomains = computePublicChannelScope(deps.graph, sceneRoot, 'sight')
  const soundDomains = computePublicChannelScope(deps.graph, sceneRoot, 'sound')
  const domains = new Map<string, Path>([...sightDomains, ...soundDomains])
  for (const [key, path] of domains) {
    const instance = deps.graph.instance(path)
    if (instance.kind === 'none' || deps.graph.instanceVisibility(instance.value) !== 'surface')
      continue
    for (const field of instance.value.fields.values()) {
      if (deps.graph.fieldVisibility(field) !== 'surface') continue
      const channelDomains = deps.graph.fieldSense(field) === 'sight' ? sightDomains : soundDomains
      if (!channelDomains.has(key)) continue
      const entry = publicFieldEntry(deps, field, PUBLIC_SCENE_SEQ)
      if (entry.kind === 'some') buckets.add(field.path, entry.value)
    }
  }
  withoutSubsumed(deps, buckets)
  return Object.freeze({
    sceneRootPath: sceneRoot,
    schemas: schemaOfBuckets(deps, buckets),
    instances: instanceViews(buckets),
  })
}

function fieldEntryAt(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  path: Path,
  mode: 'routine' | 'expanded',
): Option<FieldEntry> {
  const memoryField = memoryFieldEntryAt(deps, path)
  if (memoryField.kind === 'some') return memoryField
  if (isMemoryDescendant(path)) return NONE
  const global = globalSurfaceFields(deps).find((candidate) =>
    pathsEqual(candidate.field.path, path),
  )
  if (global !== undefined) {
    const entry = globalFieldEntry(deps, ctx, global.instance, global.field, mode)
    if (entry.kind === 'some') return entry
  }
  const instancePath = fieldInstancePath(path)
  const instance = deps.graph.instance(instancePath)
  if (instance.kind === 'some') {
    const field = [...instance.value.fields.values()].find((candidate) =>
      pathsEqual(candidate.path, path),
    )
    if (field) {
      const selfOwned =
        ctx.owned.has(encodePathKey(instancePath)) &&
        isSelfOwnedField(deps.graph, instance.value, field)
      const fold = liveFold(
        deps,
        field,
        selfOwned ? 'self_owned' : 'direct_scope',
        ctx.scope,
        instance.value,
      )
      if (fold.primary.kind === 'some') return fieldEntry(deps, path, fold, mode)
    }
  }
  const fold = deps.evaluator.fold(path)
  return fieldEntry(deps, path, fold, mode)
}

/**
 * Direct Map members that legal memory still identifies, including an
 * intermediate Map whose known Struct descendants outlive its deletion.
 *
 * Candidate owners come only from effective discoveries and field claims.
 * Each owner must resolve through the same authorized fact snapshot used by
 * direct instance inspection before its direct child coordinate is admitted.
 * Rumor-only guesses and known-false-only accounts cannot create members.
 * No current physical membership is needed to retain that coordinate.
 *
 * @param deps - Projection dependencies.
 * @param mapPath - Current Map root being inspected.
 * @returns Deduplicated, path-key sorted direct member paths.
 */
function rememberedMapMembers(deps: ProjectionDeps, mapPath: Path): readonly Path[] {
  const candidates = new Map<string, Path>()
  const addCandidate = (instancePath: Path): void => {
    if (instancePath.length <= mapPath.length) return
    if (!mapPath.every((segment, index) => segment === instancePath[index])) return
    candidates.set(encodePathKey(instancePath), instancePath)
  }
  for (const discovered of deps.evaluator.effectiveDiscoveredPaths()) addCandidate(discovered)
  for (const fieldPath of deps.evaluator.claimPaths().fields)
    addCandidate(fieldInstancePath(fieldPath))
  const remembered: Path[] = []
  for (const candidate of candidates.values()) {
    if (rememberedSnapshot(deps, candidate).kind === 'none') continue
    remembered.push(candidate.slice(0, mapPath.length + 1))
  }
  return sortedUniquePaths(remembered)
}

/**
 * Expand one struct target using visible declarations plus claim paths.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param instancePath - Struct instance to expand.
 * @param graph - View supplying the remembered/current shape.
 * @param mode - Routine or expanded facet values.
 * @returns Authorized field entries in stable path order.
 */
function instanceFieldEntries(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  instancePath: Path,
  graph: PerspectiveGraph,
  mode: 'routine' | 'expanded',
): readonly FieldEntry[] {
  const entries: FieldEntry[] = []
  for (const fieldPath of claimFieldPathsForInstance(deps, instancePath, graph)) {
    const entry = fieldEntryAt(deps, ctx, fieldPath, mode)
    if (entry.kind === 'some') entries.push(entry.value)
  }
  return entries
}

/**
 * Expand a struct or Map target from every legally live and remembered member.
 *
 * A current Map target is not enumerated from its physical entries alone:
 * members that direct instance inspection would still expand from memory are
 * unioned in, deduplicated by encoded path and visited in stable key order.
 * Each member is then expanded through this same function, so nested Maps and
 * deleted-but-remembered instances follow exactly the direct-inspection path
 * and produce the same entries as inspecting every member individually.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param path - Struct or Map target to expand.
 * @param mode - Routine or expanded facet values.
 * @returns Authorized field entries in stable path order.
 */
function expandInstancePaths(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  path: Path,
  mode: 'routine' | 'expanded',
): readonly FieldEntry[] {
  const inspection = deps.graph.inspect(path)
  if (inspection.kind === 'some') {
    if (inspection.value.nodeKind === 'struct')
      return instanceFieldEntries(deps, ctx, path, deps.graph, mode)
    if (inspection.value.nodeKind === 'map') {
      const members = new Map<string, Path>()
      for (const key of Object.keys(inspection.value.entries)) {
        const member = [...path, key]
        members.set(encodePathKey(member), member)
      }
      for (const member of rememberedMapMembers(deps, path))
        members.set(encodePathKey(member), member)
      const entries: FieldEntry[] = []
      for (const [, member] of [...members.entries()].sort((a, b) => a[0].localeCompare(b[0])))
        entries.push(...expandInstancePaths(deps, ctx, member, mode))
      return entries
    }
    return []
  }
  // The current path is gone: only an authorized observation/discovery fact
  // snapshot may supply the remembered shape. Rumor-only paths have none.
  const remembered = rememberedSnapshot(deps, path)
  if (remembered.kind === 'some')
    return instanceFieldEntries(deps, ctx, path, remembered.value.graph, mode)
  const entries: FieldEntry[] = []
  for (const member of rememberedMapMembers(deps, path))
    entries.push(...expandInstancePaths(deps, ctx, member, mode))
  return entries
}

/**
 * Field paths to expand for one struct instance.
 *
 * The view supplies every declared/custom field of the current or remembered
 * shape; claim records add leaves that only memory still knows (including
 * fields deleted from the shape and custom leaves). Existence of the current
 * path is never used to admit or reject a claim.
 *
 * @param deps - Projection dependencies.
 * @param instancePath - Owning instance path.
 * @param graph - Current or authorized fact view supplying the shape.
 * @returns Deduplicated, sorted field paths.
 */
function claimFieldPathsForInstance(
  deps: ProjectionDeps,
  instancePath: Path,
  graph: PerspectiveGraph,
): readonly Path[] {
  const paths: Path[] = []
  const instance = graph.instance(instancePath)
  if (instance.kind === 'some')
    for (const field of instance.value.fields.values()) paths.push(field.path)
  for (const path of deps.evaluator.claimPaths().fields) {
    if (path.length < 2) continue
    if (!pathsEqual(fieldInstancePath(path), instancePath)) continue
    paths.push(path)
  }
  return sortedUniquePaths(paths)
}

/**
 * Expanded inspection view for one entry.
 *
 * Descriptions come from the entry's authorized fact snapshot (or the current
 * declaration/synthetic label for rumor-only records), never from the current
 * objective node merely because it happens to exist.
 *
 * @param deps - Projection dependencies.
 * @param entry - Projected field entry.
 * @returns Frozen expanded inspection view.
 */
function inspectedFromEntry(deps: ProjectionDeps, entry: FieldEntry): InspectedFieldView {
  return Object.freeze({
    path: entry.path,
    description: entryDescription(deps, entry),
    value: entry.facet.value,
    seq: entry.facet.seq,
    summary: entry.facet.summary,
    sourceKind: entry.facet.sourceKind,
    at: entry.facet.at,
    acquiredAt: entry.facet.acquiredAt,
    belief: entry.facet.belief,
    source: entry.facet.source,
    sources: entry.facet.sources,
    coWitnesses: entry.facet.coWitnesses,
    additionalFacets: entry.view.additionalFacets,
  })
}

/**
 * Fully expand requested paths. Struct/Map targets expand to their visible
 * leaf fields; a leaf target returns exactly one entry. A currently deleted
 * struct is expanded from its strongest authorized observed/discovery fact
 * snapshot, so unknown off-scene deletions cannot change the result.
 */
export function inspectPaths(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  targetPaths: readonly Path[],
  errorForUnauthorized: (path: Path) => never,
): readonly InspectedFieldView[] {
  const views: InspectedFieldView[] = []
  for (const path of targetPaths) {
    const memory = memoryAtPath(deps, path)
    if (memory.kind === 'some') {
      const entries = memoryFieldEntries(deps, memory.value)
      if (entries.length === 0) errorForUnauthorized(path)
      for (const entry of entries) views.push(inspectedFromEntry(deps, entry))
      continue
    }
    const mapPerspective = memoryMapPerspectiveId(path)
    if (mapPerspective.kind === 'some') {
      const entries = memoryRecordsFor(deps, mapPerspective.value).flatMap((record) => [
        ...memoryFieldEntries(deps, record),
      ])
      if (entries.length === 0) errorForUnauthorized(path)
      for (const entry of entries) views.push(inspectedFromEntry(deps, entry))
      continue
    }
    const memoryField = memoryFieldEntryAt(deps, path)
    if (memoryField.kind === 'some') {
      views.push(inspectedFromEntry(deps, memoryField.value))
      continue
    }
    if (isMemoryDescendant(path)) errorForUnauthorized(path)
    const inspection = deps.graph.inspect(path)
    const currentContainer =
      inspection.kind === 'some' &&
      (inspection.value.nodeKind === 'struct' || inspection.value.nodeKind === 'map')
    const rememberedContainer =
      inspection.kind === 'none' &&
      (rememberedSnapshot(deps, path).kind === 'some' ||
        rememberedMapMembers(deps, path).length > 0)
    if (currentContainer || rememberedContainer) {
      const entries = expandInstancePaths(deps, ctx, path, 'expanded')
      if (entries.length === 0) errorForUnauthorized(path)
      for (const entry of entries) views.push(inspectedFromEntry(deps, entry))
      continue
    }
    const entry = fieldEntryAt(deps, ctx, path, 'expanded')
    if (entry.kind === 'none') errorForUnauthorized(path)
    views.push(inspectedFromEntry(deps, entry.value))
  }
  return Object.freeze(views)
}

function stateRefEquals(a: StateRef, b: StateRef): boolean {
  return a.commitId === b.commitId && pathsEqual(a.path, b.path)
}

function valuesMatch(subjective: Value | StateRef, objective: Value | StateRef): boolean {
  if (isStateRefLike(subjective) || isStateRefLike(objective)) {
    return (
      isStateRefLike(subjective) &&
      isStateRefLike(objective) &&
      stateRefEquals(subjective, objective)
    )
  }
  return valueEquals(subjective, objective)
}

function isStateRefLike(value: Value | StateRef): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    'commitId' in value &&
    'path' in value
  )
}

/** Adjudicator-only subjective/objective comparison. */
export function adjudicatePaths(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  targetPaths: readonly Path[],
): readonly AdjudicatedPathResult[] {
  const results: AdjudicatedPathResult[] = []
  for (const path of targetPaths) {
    const memory = memoryAtPath(deps, path)
    if (memory.kind === 'some') {
      results.push(
        Object.freeze({
          path,
          authorized: memoryFieldEntries(deps, memory.value).length > 0,
          subjective: NONE,
          objective: deps.graph.inspect(path),
          matchesObjectiveTruth: false,
        }),
      )
      continue
    }
    const entry = fieldEntryAt(deps, ctx, path, 'expanded')
    const subjective = entry.kind === 'some' ? some(inspectedFromEntry(deps, entry.value)) : NONE
    const objective = deps.graph.inspect(path)
    let matches = false
    if (entry.kind === 'some' && objective.kind === 'some' && objective.value.nodeKind === 'leaf') {
      matches = valuesMatch(entry.value.facet.value, objective.value.value)
    }
    results.push(
      Object.freeze({
        path,
        authorized: entry.kind === 'some',
        subjective,
        objective,
        matchesObjectiveTruth: matches,
      }),
    )
  }
  return Object.freeze(results)
}

function renderValue(value: Value | StateRef): string {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return String(value)
  if ('commitId' in value) return `ref:${value.commitId}:${encodePathKey(value.path)}`
  return `[${value.map((item) => (item instanceof Uint8Array ? `0x${Buffer.from(item).toString('hex')}` : String(item))).join(', ')}]`
}

function contentHash(text: string, summary: Option<string>): string {
  const hasher = new BinaryHasher('perspective-corpus')
  hasher.writeString(text)
  hasher.writeString(summary.kind === 'some' ? summary.value : '')
  return hasher.digestHex()
}

/**
 * Whether a link field is authorized strongly enough to expose its targets.
 *
 * Authorization has two disjoint sources:
 * - for an entry anchored to the current commit, the link field must be
 *   genuinely live for this observer: declared global feed, effective public
 *   visibility in the current channel scope, or legitimate self-ownership, and
 *   its live facet must win the fold (exclusions and belief are respected);
 * - for any fact snapshot, an `observed_claim` about that exact link field
 *   must be anchored to the same commit and survive the fold.
 *
 * Rumor claims never authorize reading or comparing the objective relation:
 * a guessed link that matches the hidden target is not evidence of sight.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param instancePath - Owning instance path.
 * @param factField - Link field read from the fact snapshot.
 * @param factCommitId - Commit that the corpus entry is anchored to.
 * @returns True when this link field's fact-time contents may be used.
 */
function linkFieldAuthorized(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  instancePath: Path,
  factField: FieldNode,
  factCommitId: CommitHash,
): boolean {
  if (factCommitId === deps.commitId) {
    const current = deps.graph.instance(instancePath)
    if (current.kind === 'some') {
      const currentField = [...current.value.fields.values()].find((candidate) =>
        pathsEqual(candidate.path, factField.path),
      )
      if (currentField) {
        const global = globalSurfaceCandidate(deps.graph, ctx.actor, current.value, currentField)
        if (global.kind === 'some') {
          const fold = deps.evaluator.fold(currentField.path, global.value)
          if (
            fold.primary.kind === 'some' &&
            fold.primary.value.sourceKind === 'direct_scope' &&
            fold.primary.value.belief !== 'known_false'
          )
            return true
        }
        if (
          ctx.owned.has(encodePathKey(instancePath)) &&
          isSelfOwnedField(deps.graph, current.value, currentField)
        ) {
          const fold = liveFold(deps, currentField, 'self_owned', ctx.scope, current.value)
          if (
            fold.primary.kind === 'some' &&
            fold.primary.value.sourceKind === 'self_owned' &&
            fold.primary.value.belief !== 'known_false'
          )
            return true
        }
        const fold = liveFold(deps, currentField, 'direct_scope', ctx.scope, current.value)
        if (
          fold.primary.kind === 'some' &&
          fold.primary.value.sourceKind === 'direct_scope' &&
          fold.primary.value.belief !== 'known_false'
        )
          return true
      }
    }
  }
  return deps.evaluator
    .fold(factField.path)
    .facets.some(
      (facet) =>
        facet.sourceKind === 'observed_claim' &&
        facet.belief !== 'known_false' &&
        factOf(facet, deps.commitId) === factCommitId,
    )
}

/**
 * Whether a link target is visible in the observer's effective current view.
 *
 * Ownership and live scope cover the physical public/private channels; the
 * evaluator's canonical effective-discovery predicate covers remembered hidden
 * targets, so overrides, exclusions and `known_false` discoveries agree with
 * live access and structural snapshot expansion. A rumor about a path is not
 * sight and never authorizes the pointer.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param target - Candidate target instance path.
 * @returns True when the target identity may be disclosed.
 */
function authorizedTarget(deps: ProjectionDeps, ctx: ObserverContext, target: Path): boolean {
  if (ctx.owned.has(encodePathKey(target))) return true
  if (isInLiveScope(ctx, target)) return true
  return deps.evaluator
    .effectiveDiscoveredPaths()
    .some((discovered) => pathsEqual(discovered, target))
}

/**
 * Current authorized path for a linked entity coordinate.
 *
 * `currentPath` is disclosed only when the observer currently perceives or
 * owns the identity. For off-scene entities known only through memory, the
 * objective current existence is deliberately not probed: an unknown
 * deletion/reappearance must not change the projected relation.
 *
 * @param ctx - Observer context.
 * @param target - Entity path.
 * @returns The same path when currently live/owned, otherwise `NONE`.
 */
function currentLinkedPath(ctx: ObserverContext, target: Path): Option<Path> {
  const key = encodePathKey(target)
  return ctx.owned.has(key) || isInLiveScope(ctx, target) ? some(target) : NONE
}

/** Deterministic relation preference used when one ref is reached twice. */
const LINKED_RELATION_RANK: Record<LinkedEntity['relation'], number> = {
  current_link: 0,
  historical_link: 1,
  ref_target: 2,
  memory_entity: 3,
}

/**
 * Stable de-duplication of linked entities by exact `(commitId, path)`.
 *
 * Different commits of the same logical entity remain distinct entries. When
 * one exact coordinate is reachable through several relations, the earliest
 * relation rank wins deterministically.
 *
 * @param entities - Candidate linked entities.
 * @returns Frozen, `(commitId, pathKey)` sorted list.
 */
function finalizeLinkedEntities(entities: readonly LinkedEntity[]): readonly LinkedEntity[] {
  const byKey = new Map<string, LinkedEntity>()
  for (const entity of entities) {
    const key = `${entity.ref.commitId}\u0000${encodePathKey(entity.ref.path)}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, entity)
      continue
    }
    if (LINKED_RELATION_RANK[entity.relation] < LINKED_RELATION_RANK[existing.relation])
      byKey.set(key, entity)
  }
  return Object.freeze(
    [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]),
  )
}

/** Build one linked entity with conservative current-path disclosure. */
function linkedEntity(
  ctx: ObserverContext,
  ref: StateRef,
  relation: LinkedEntity['relation'],
  role?: string,
): LinkedEntity {
  const currentPath = currentLinkedPath(ctx, ref.path)
  return Object.freeze(
    role === undefined
      ? { ref: Object.freeze(ref), currentPath, relation }
      : { ref: Object.freeze(ref), currentPath, relation, role },
  )
}

function isStateRefValue(value: Value | StateRef): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    'commitId' in value &&
    'path' in value &&
    typeof value.commitId === 'string' &&
    Array.isArray(value.path)
  )
}

/** Whether a ref coordinate names a Struct instance in its own snapshot. */
function structAtRef(deps: ProjectionDeps, ref: StateRef): boolean {
  if (ref.path[0] === '$message') return false
  const graph = ref.commitId === SELF_COMMIT ? deps.graph : snapshotGraph(deps, ref.commitId)
  return graph.instance(ref.path).kind === 'some'
}

/**
 * One-hop links and entity-targeting refs from the entry's fact snapshot.
 *
 * Link contents are always read from `entry.factCommitId`, so an unseen newer
 * edit cannot rewrite remembered edges. A rumor-claim entry never dereferences
 * the objective instance at the rumor-creation commit. Every disclosed target
 * must pass both source-field authorization and target-identity authorization;
 * entity refs additionally require a Struct snapshot, and message refs are
 * never entities.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param entry - Corpus entry whose instance relations are wanted.
 * @returns Sorted, de-duplicated linked entities.
 */
function linkedEntitiesForEntry(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  entry: FieldEntry,
): readonly LinkedEntity[] {
  if (entry.facet.sourceKind === 'rumor_claim') return []
  const factGraph = snapshotGraph(deps, entry.factCommitId)
  const instancePath = fieldInstancePath(entry.path)
  const instance = factGraph.instance(instancePath)
  if (instance.kind === 'none') return []
  const relation: LinkedEntity['relation'] =
    entry.factCommitId === deps.commitId ? 'current_link' : 'historical_link'
  const found: LinkedEntity[] = []
  for (const field of instance.value.fields.values()) {
    if (field.value.kind === 'none') continue
    if (isLinkSpec(field.spec)) {
      if (!linkFieldAuthorized(deps, ctx, instancePath, field, entry.factCommitId)) continue
      for (const target of linkTargets(field.value.value))
        if (authorizedTarget(deps, ctx, target))
          found.push(linkedEntity(ctx, { commitId: entry.factCommitId, path: target }, relation))
      continue
    }
    if (field.spec.valueKind !== 'ref') continue
    const value = field.value.value
    if (!isStateRefValue(value)) continue
    const ref = value
    if (ref.path[0] === '$message') continue
    if (!linkFieldAuthorized(deps, ctx, instancePath, field, entry.factCommitId)) continue
    if (!authorizedTarget(deps, ctx, ref.path)) continue
    if (!structAtRef(deps, ref)) continue
    found.push(linkedEntity(ctx, ref, 'ref_target'))
  }
  return finalizeLinkedEntities(found)
}

/**
 * Authorized historical entity associations of one cognitive memory.
 *
 * Only `relatedEntities` rows become links; evidence refs are never emitted.
 * Each row needs an authorized target identity, a Struct at its exact
 * historical coordinate, and an unsuppressed row path. A rumor (a false
 * memory) never grants more: the memory itself is the only evidence.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param memory - Source memory record.
 * @returns Sorted, de-duplicated `memory_entity` linked entities.
 */
function memoryLinkedEntities(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  memory: CognitiveMemoryRecord,
): readonly LinkedEntity[] {
  const found: LinkedEntity[] = []
  for (const row of readableMemoryRelatedEntities(deps.evaluator, memory)) {
    const ref = row.targetRef
    if (ref.path[0] === '$message') continue
    if (!authorizedTarget(deps, ctx, ref.path)) continue
    if (!structAtRef(deps, ref)) continue
    found.push(linkedEntity(ctx, ref, 'memory_entity', row.role))
  }
  return finalizeLinkedEntities(found)
}

/**
 * Whether an entry's own authorizing declaration marks its field ephemeral.
 *
 * Ephemerality is a Writer-side declaration bound to the moment that produced
 * the entry. Live facets (`direct_scope`/`self_owned`) therefore consult the
 * current objective field, while durable observed entries consult only their
 * `factCommitId` snapshot. A later unseen redefinition of the same field
 * (`defineCustom(..., { ephemeral: true })` over an ordinary historical custom
 * leaf) can never erase what the observer actually recorded. A persisted
 * literal rumor is exempt entirely: its payload is the claim, and probing the
 * current objective node would let an unknown redefinition censor it.
 * Declaration lookup is independent of physical leaf, ancestor and Map-entry
 * existence; missing values cannot erase the Writer's persistence policy.
 *
 * @param deps - Projection dependencies.
 * @param entry - Corpus candidate.
 * @returns True when the authorizing declaration says "never persist".
 */
function corpusEntryEphemeral(deps: ProjectionDeps, entry: FieldEntry): boolean {
  if (entry.facet.sourceKind === 'rumor_claim') return false
  const graph =
    entry.facet.sourceKind === 'direct_scope' || entry.facet.sourceKind === 'self_owned'
      ? deps.graph
      : snapshotGraph(deps, entry.factCommitId)
  const declaration = graph.writerSchemaAt(entry.path)
  return (
    declaration.kind === 'some' &&
    declaration.value.nodeKind === 'leaf' &&
    isEphemeralSpec(declaration.value)
  )
}

/**
 * Pre-filtered corpus for memory/RAG consumers.
 *
 * Ranking (relevance/recency/importance) is deliberately left to the caller;
 * this function only guarantees that every returned entry is legally visible
 * and carries the raw scoring ingredients. Ephemerality is checked against
 * each entry's authorizing declaration, never against the current objective
 * node alone (see {@link corpusEntryEphemeral}).
 */
export function buildCorpus(
  deps: ProjectionDeps,
  ctx: ObserverContext,
): readonly SearchableCorpusEntry[] {
  const collected = collect(deps, ctx, true)
  const subsumed = subsumedInstanceKeys(deps, collected.mergedBuckets)
  const entries: SearchableCorpusEntry[] = []
  for (const bucket of collected.mergedBuckets.buckets.values()) {
    const instanceKey = encodePathKey(bucket.path)
    for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()]) {
      // Memory metadata stays available in the projection tree, but retrieval
      // sees only the subjective narrative (never sequence/ref plumbing).
      if (entry.memory !== undefined && entry.memoryContent !== true) continue
      if (corpusEntryEphemeral(deps, entry)) continue
      const text = renderValue(entry.facet.value)
      const linkedEntities =
        entry.memory !== undefined && entry.memoryContent === true
          ? memoryLinkedEntities(deps, ctx, entry.memory)
          : linkedEntitiesForEntry(deps, ctx, entry)
      entries.push(
        Object.freeze({
          path: entry.path,
          seq: entry.facet.seq,
          factCommitId: entry.factCommitId,
          acquiredAtCommitId: entry.acquiredAtCommitId,
          contentHash: contentHash(text, entry.facet.summary),
          text,
          summary: entry.facet.summary,
          sourceKind: entry.facet.sourceKind,
          priority: entry.facet.priority,
          belief: entry.facet.belief,
          isFoldedInDefaultView:
            entry.foldedByDefault ||
            subsumed.has(instanceKey) ||
            collected.memoryFoldedChildKeys.has(instanceKey),
          linkedEntities,
          linkedInstancePaths: sortedUniquePaths(linkedEntities.map((entity) => entity.ref.path)),
        }),
      )
    }
  }
  return Object.freeze(entries)
}
