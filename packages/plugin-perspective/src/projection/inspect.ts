/**
 * Read-only expansion and adjudication.
 *
 * `inspect` exposes exactly the entries an observer is allowed to know, using
 * the same folds and authorized fact snapshots as the projection. Struct and
 * Map targets expand from current and remembered members; a deleted struct is
 * read from its strongest authorized observation snapshot. Adjudication
 * compares that subjective entry with the objective leaf and is host-only.
 */

import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, valueEquals } from '@sekaisen/plugin-world'
import type { PerspectiveGraph } from '../graph.ts'
import { fieldInstancePath, pathsEqual, sortedUniquePaths } from '../graph.ts'
import { isSelfOwnedField } from '../ownership.ts'
import type { AdjudicatedPathResult, InspectedFieldView } from '../types.ts'
import type { FieldEntry, ObserverContext, ProjectionDeps } from './context.ts'
import { fieldEntry, rememberedSnapshot } from './context.ts'
import { entryDescription, globalFieldEntry, globalSurfaceFields, liveFold } from './fields.ts'
import {
  isMemoryDescendant,
  memoryAtPath,
  memoryFieldEntries,
  memoryFieldEntryAt,
  memoryMapPerspectiveId,
  memoryRecordsFor,
} from './memory-view.ts'

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
