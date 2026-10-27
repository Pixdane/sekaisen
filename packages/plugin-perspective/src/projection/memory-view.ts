/**
 * Cognitive-memory materialization and folding.
 *
 * Memories are observer-private narrative instances, not ordinary objective
 * state: only the owning/inheriting perspective may read them, only safe
 * narrative fields are projected, and child memories folded by a visible
 * parent summary disappear from routine views. Corpus consumers keep those
 * children and mark them folded instead.
 */

import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { Path, Value } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import type { FoldFacet } from '../claims.ts'
import { pathsEqual } from '../graph.ts'
import { readableMemorySummary } from '../memory-access.ts'
import { parseCognitiveMemoryPath } from '../memory-topology.ts'
import type { CognitiveMemoryRecord } from '../schemas.ts'
import { MEMORY_LEVEL_RANK, PERSPECTIVES_ROOT } from '../schemas.ts'
import type { FieldEntry, ObserverContext, ProjectionDeps } from './context.ts'
import { BucketSet, projectFacet } from './context.ts'

/** Segment naming the cognitive-memory Map under a perspective node. */
const MEMORIES_SEGMENT = 'memories'

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

/**
 * Perspective id of `['perspectives', P, 'memories']`, when `path` is that Map.
 *
 * @param path - Candidate path.
 * @returns The owning perspective id, or `NONE` for any other path.
 */
export function memoryMapPerspectiveId(path: Path): Option<string> {
  if (path.length !== PERSPECTIVES_ROOT.length + 2) return NONE
  if (!PERSPECTIVES_ROOT.every((segment, index) => path[index] === segment)) return NONE
  if (path[PERSPECTIVES_ROOT.length + 1] !== MEMORIES_SEGMENT) return NONE
  return some(path[PERSPECTIVES_ROOT.length]!)
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
export function memoryAtPath(deps: ProjectionDeps, path: Path): Option<CognitiveMemoryRecord> {
  const parsed = parseCognitiveMemoryPath(path)
  if (parsed.kind === 'none') return NONE
  if (!deps.evaluator.orderedPerspectives().includes(parsed.value.rootPerspectiveId)) return NONE
  const record = deps.evaluator.perspectives
    .get(parsed.value.rootPerspectiveId)
    ?.memories.get(parsed.value.memoryId)
  if (record === undefined) return NONE
  if (record.ownerPerspectiveId !== parsed.value.rootPerspectiveId) return NONE
  if (!pathsEqual(record.path, path)) return NONE
  if (deps.evaluator.suppressed(record.path, record.priority)) return NONE
  return some(record)
}

/** Visible memories of one perspective, after prefix exclusions. */
export function memoryRecordsFor(
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
export function memoryFieldEntries(
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
export function memoryFieldEntryAt(deps: ProjectionDeps, path: Path): Option<FieldEntry> {
  if (path.length !== PERSPECTIVES_ROOT.length + 4) return NONE
  const memory = memoryAtPath(deps, path.slice(0, -1))
  if (memory.kind === 'none') return NONE
  for (const entry of memoryFieldEntries(deps, memory.value))
    if (pathsEqual(entry.path, path)) return some(entry)
  return NONE
}

/**
 * Structural recognition of the memory namespace, independent of ID legality.
 *
 * A `$`-prefixed perspective or empty segment is not a stored memory ID, but
 * the path is still memory-shaped and a literal rumor may legally be recorded
 * on it. Privacy fencing must reject the whole subtree, so this deliberately
 * does not reuse {@link parseCognitiveMemoryPath}.
 *
 * @param path - Candidate instance path.
 * @returns True for exactly `['perspectives', P, 'memories', M]`.
 */
export function isMemoryInstancePath(path: Path): boolean {
  if (path.length !== PERSPECTIVES_ROOT.length + 3) return false
  return memoryMapPerspectiveId(path.slice(0, PERSPECTIVES_ROOT.length + 2)).kind === 'some'
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
export function isMemoryDescendant(path: Path): boolean {
  return isMemoryInstancePath(path.slice(0, PERSPECTIVES_ROOT.length + 3))
}

/** Memory buckets plus the child memories folded by a live parent summary. */
export interface MemoryBuckets {
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
export function collectMemoryBuckets(deps: ProjectionDeps, ctx: ObserverContext): MemoryBuckets {
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
    const parentPath = parseCognitiveMemoryPath(parent.path)
    if (parentPath.kind === 'none') continue
    for (const childPath of parent.children) {
      const child = parseCognitiveMemoryPath(childPath)
      if (child.kind === 'none') continue
      if (child.value.rootPerspectiveId !== parentPath.value.rootPerspectiveId) continue
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
