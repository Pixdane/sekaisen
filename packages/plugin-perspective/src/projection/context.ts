/**
 * Shared projection kernel.
 *
 * Projection dependencies, observer context, instance buckets, field-factor
 * construction and authorized fact snapshots are used by every projection
 * entry point. Keeping them here lets the memory, inspection, corpus and
 * assembly modules depend in one direction only:
 * context -> memory/fields -> collect/inspect/corpus -> assembly.
 */

import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { SchemaMetaMap } from '@sekaisen/plugin-schema'
import type { CommitHash, Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { ClaimEvaluator, FoldFacet, FoldResult } from '../claims.ts'
import type { PerspectiveGraph } from '../graph.ts'
import { fieldInstancePath, pathsEqual, sortedUniquePaths } from '../graph.ts'
import { ownedInstances } from '../ownership.ts'
import type { CognitiveMemoryRecord } from '../schemas.ts'
import type { ObserverScopeState } from '../scope.ts'
import type { ProjectedFieldFacet, ProjectedFieldView } from '../types.ts'

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

export interface FieldEntry {
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

export interface InstanceBucket {
  readonly path: Path
  readonly fields: Map<string, FieldEntry>
  readonly customFields: Map<string, FieldEntry>
}

export class BucketSet {
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

export function mergeBuckets(target: BucketSet, source: BucketSet): void {
  for (const bucket of source.buckets.values())
    for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()])
      target.add(entry.path, entry)
}

export function summaryOfLeaf(meta: SchemaMetaMap | undefined): Option<string> {
  const summary = meta?.summary
  return typeof summary === 'string' ? some(summary) : NONE
}

export function factOf(facet: FoldFacet, commitId: CommitHash): CommitHash {
  if (facet.sourceKind === 'direct_scope' || facet.sourceKind === 'self_owned') return commitId
  return facet.at.kind === 'some' ? facet.at.value : commitId
}

function acquiredOf(facet: FoldFacet, commitId: CommitHash): CommitHash {
  if (facet.sourceKind === 'direct_scope' || facet.sourceKind === 'self_owned') return commitId
  return facet.acquiredAt.kind === 'some' ? facet.acquiredAt.value : commitId
}

export function projectFacet(facet: FoldFacet, mode: 'routine' | 'expanded'): ProjectedFieldFacet {
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

export function fieldEntry(
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

/** One authorized historical view that can supply remembered shapes/metadata. */
export interface RememberedSnapshot {
  readonly graph: PerspectiveGraph
  readonly commitId: CommitHash
}

/** Current graph at the live head, historical graph otherwise. */
export function snapshotGraph(deps: ProjectionDeps, commitId: CommitHash): PerspectiveGraph {
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
export function firstRememberedSnapshot(
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
export function rememberedSnapshot(deps: ProjectionDeps, path: Path): Option<RememberedSnapshot> {
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
export function rememberedBucketSnapshot(
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
export function visibleInstances(ctx: ObserverContext, deps: ProjectionDeps): readonly Path[] {
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

export function isInLiveScope(ctx: ObserverContext, path: Path): boolean {
  if (ctx.scope.kind === 'none') return false
  const key = encodePathKey(path)
  return (
    ctx.scope.value.sight.reachablePaths.has(key) || ctx.scope.value.sound.reachablePaths.has(key)
  )
}
