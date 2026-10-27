/**
 * Live field projection and declaration resolution.
 *
 * Every entry carries the facet that authorized it. This module builds live
 * `direct_scope`/`self_owned` entries, declared global feed entries, the
 * observer-independent raw public entry, and the description attached to a
 * remembered path. It never reads an unauthorized objective value.
 */

import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { FoldFacet, FoldResult, LiveFacetInput } from '../claims.ts'
import { globalSurfaceCandidate, isGlobalSurfaceField } from '../global-surface.ts'
import type { FieldNode, PerspectiveGraph, StructInstance } from '../graph.ts'
import { fieldInstancePath } from '../graph.ts'
import { PerspectiveFailure } from '../internal.ts'
import { isSelfOwnedField } from '../ownership.ts'
import { DEFAULT_PERSPECTIVE_PRIORITY } from '../schemas.ts'
import type { ObserverScopeState } from '../scope.ts'
import type { FieldEntry, ObserverContext, ProjectionDeps } from './context.ts'
import { fieldEntry, projectFacet, snapshotGraph, summaryOfLeaf } from './context.ts'

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
export function rememberedLabel(path: Path): string {
  return path.at(-1) ?? ''
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
export function globalSurfaceFields(deps: ProjectionDeps): readonly GlobalSurfaceField[] {
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
export function globalFieldEntry(
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

export function liveFold(
  deps: ProjectionDeps,
  field: FieldNode,
  kind: 'direct_scope' | 'self_owned',
  scope: Option<ObserverScopeState>,
  instance: StructInstance,
): FoldResult {
  const candidate = liveCandidateForField(deps.graph, scope, instance, field, kind)
  return deps.evaluator.fold(field.path, candidate.kind === 'some' ? candidate.value : undefined)
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
export function entryDescription(deps: ProjectionDeps, entry: FieldEntry): string {
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
 * Neutral positive seq for the observer-independent raw public surface.
 *
 * `scenePublic` is contractually byte-identical across observers and with
 * `projectScopePublic`, while live agent-facing entries expose the observer's
 * `nextSeq`. The shared prefix therefore carries this stable value; merged and
 * private live entries are rebuilt with the observer sequence.
 */
export const PUBLIC_SCENE_SEQ = 1

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
export function publicFieldEntry(
  deps: ProjectionDeps,
  field: FieldNode,
  seq: number,
): Option<FieldEntry> {
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
