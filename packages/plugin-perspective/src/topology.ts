/**
 * High-level topology invariants registered as a schema commit validator.
 *
 * Structural schema/link validation already guarantees leaf kinds, target
 * existence and per-link role-union acyclicity. Perspective additionally
 * enforces the cross-instance laws that make containment and delegation
 * unambiguous:
 * 1. at most one non-empty `'parent'` single-target link, and the parent union
 *    is acyclic;
 * 2. at most one non-empty `'delegate'` single-target link, acyclic as well;
 * 3. the `'subsumes'` union is acyclic;
 * 4. any directed edge must have non-empty single-target `edge_from` and
 *    `edge_to` links;
 * 5. `'all'` cannot inherit, and the perspective inheritance graph (including
 *    the implicit edge to `'all'`) is acyclic.
 */

import type { Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import type { HistoricalStructInspection, ReadonlySchemaView } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { decodePathKey, encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import type { PerspectiveGraph } from './graph.ts'
import { decodePathKeySafe, PerspectiveGraph as Graph } from './graph.ts'
import { parseCognitiveMemoryPath } from './memory-topology.ts'
import type { MemoryLevel } from './schemas.ts'
import {
  ALL_PERSPECTIVE_ID,
  MEMORY_EVENT_ORIGINS,
  MEMORY_LEVELS,
  MEMORY_SIGNIFICANCES,
  MEMORY_TIERS,
  memoryLevelRank,
  PERSPECTIVES_ROOT,
} from './schemas.ts'
import type { PerspectiveLinkRole } from './visibility.ts'
import { hasLinkRole, isLinkSpec } from './visibility.ts'

/** Commit-validator name reported through `validator_rejected`. */
export const TOPOLOGY_VALIDATOR_NAME = 'perspective-topology'

/** Validator failure shape accepted by `ctx.schema.addCommitValidator`. */
export interface TopologyValidatorFailure {
  readonly path: Path
  readonly validatorName: string
  readonly reason: string
}

function failure(path: Path, reason: string): TopologyValidatorFailure {
  return { path, validatorName: TOPOLOGY_VALIDATOR_NAME, reason }
}

function pathOfKey(key: string): Path {
  try {
    return decodePathKey(key)
  } catch {
    return []
  }
}

function hasCycle(edges: ReadonlyMap<string, readonly string[]>): string | null {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): string | null => {
    if (visiting.has(key)) return key
    if (visited.has(key)) return null
    visiting.add(key)
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next)
      if (cycle !== null) return cycle
    }
    visiting.delete(key)
    visited.add(key)
    return null
  }
  for (const key of edges.keys()) {
    const cycle = visit(key)
    if (cycle !== null) return cycle
  }
  return null
}

function roleEdges(
  graph: PerspectiveGraph,
  role: PerspectiveLinkRole,
): ReadonlyMap<string, readonly string[]> {
  const edges = new Map<string, string[]>()
  for (const path of graph.allInstances()) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    const targets = graph.roleLinks(instance.value, role)
    if (targets.length === 0) continue
    edges.set(
      encodePathKey(path),
      targets.map((link) => encodePathKey(link.target)),
    )
  }
  return edges
}

function checkExclusiveRole(
  graph: PerspectiveGraph,
  role: 'parent' | 'delegate',
): TopologyValidatorFailure | null {
  for (const path of graph.allInstances()) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    let nonEmpty = 0
    for (const field of instance.value.fields.values()) {
      if (!hasLinkRole(field.spec, role)) continue
      if (!isLinkSpec(field.spec)) continue
      if (field.spec.valueKind === 'list:str')
        return failure(
          path,
          role === 'parent' ? 'multiple_parent_links' : 'multiple_delegate_links',
        )
      if (field.value.kind === 'some') nonEmpty++
    }
    if (nonEmpty > 1)
      return failure(path, role === 'parent' ? 'multiple_parent_links' : 'multiple_delegate_links')
  }
  return null
}

function checkEdgeEndpoints(graph: PerspectiveGraph): TopologyValidatorFailure | null {
  for (const path of graph.allInstances()) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    const edgeFields = [...instance.value.fields.values()].filter(
      (field) => hasLinkRole(field.spec, 'edge_from') || hasLinkRole(field.spec, 'edge_to'),
    )
    if (edgeFields.length === 0) continue
    const from = edgeFields.filter((field) => hasLinkRole(field.spec, 'edge_from'))
    const to = edgeFields.filter((field) => hasLinkRole(field.spec, 'edge_to'))
    const valid = (fields: typeof edgeFields): boolean =>
      fields.some((field) => field.spec.valueKind === 'str' && field.value.kind === 'some')
    if (from.length === 0 || to.length === 0 || !valid(from) || !valid(to))
      return failure(path, 'invalid_edge_endpoints')
    if (edgeFields.some((field) => field.spec.valueKind !== 'str'))
      return failure(path, 'invalid_edge_endpoints')
  }
  return null
}

function checkPerspectiveInheritance(graph: PerspectiveGraph): TopologyValidatorFailure | null {
  const records = graph.perspectives()
  const edges = new Map<string, readonly string[]>()
  for (const [id, record] of records) {
    if (id === ALL_PERSPECTIVE_ID && record.inherits.length > 0)
      return failure(['perspectives', id], 'root_perspective_cannot_inherit')
    edges.set(id, record.inherits)
  }
  const cycle = hasCycle(edges)
  if (cycle !== null) return failure(['perspectives', cycle], 'cyclic_role_graph')
  return null
}

/** Raw stored leaf value for one declared field on any struct. */
function rawLeafValue(graph: PerspectiveGraph, path: Path, name: string): unknown {
  const instance = graph.instance(path)
  if (instance.kind === 'none') return undefined
  const field = instance.value.fields.get(name)
  if (field === undefined || field.value.kind === 'none') return undefined
  return field.value.value
}

/** Raw declared leaf on an already-inspected historical struct. */
function structFieldValue(struct: HistoricalStructInspection, name: string): unknown {
  const field = struct.fields[name]
  if (field === undefined || field.kind === 'none') return undefined
  const node = field.value
  return node.nodeKind === 'leaf' ? node.value : undefined
}

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function rawNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** Every declared leaf of one memory record, read without Reader defaults. */
interface RawMemoryFields {
  readonly ownerPerspectiveId: unknown
  readonly seq: unknown
  readonly level: unknown
  readonly eventOrigin: unknown
  readonly significance: unknown
  readonly tier: unknown
  readonly strength: unknown
  readonly belief: unknown
  readonly priority: unknown
  readonly startTime: unknown
  readonly endTime: unknown
  readonly content: unknown
  readonly factEventRef: unknown
  readonly factSnapshotRef: unknown
  readonly acquiredAtRef: unknown
  readonly originRef: unknown
  readonly children: unknown
}

/** Read one memory's raw storage fields from an existing struct inspection. */
function rawMemoryFields(struct: HistoricalStructInspection): RawMemoryFields {
  const read = (name: string): unknown => structFieldValue(struct, name)
  return {
    ownerPerspectiveId: read('ownerPerspectiveId'),
    seq: read('seq'),
    level: read('level'),
    eventOrigin: read('eventOrigin'),
    significance: read('significance'),
    tier: read('tier'),
    strength: read('strength'),
    belief: read('belief'),
    priority: read('priority'),
    startTime: read('startTime'),
    endTime: read('endTime'),
    content: read('content'),
    factEventRef: read('factEventRef'),
    factSnapshotRef: read('factSnapshotRef'),
    acquiredAtRef: read('acquiredAtRef'),
    originRef: read('originRef'),
    children: read('children'),
  }
}

/** Decode a stored `s.ref` value directly, without Reader coercion. */
function rawStateRef(
  value: unknown,
): { readonly commitId: string; readonly path: readonly string[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Readonly<Record<string, unknown>>
  const commitId = candidate.commitId
  const refPath = candidate.path
  if (typeof commitId !== 'string' || !Array.isArray(refPath)) return undefined
  const segments: string[] = []
  for (const segment of refPath) {
    if (typeof segment !== 'string') return undefined
    segments.push(segment)
  }
  return { commitId, path: Object.freeze(segments) }
}

/** Decode a raw list-of-str leaf, or `undefined` when it is malformed. */
function rawStringList(value: unknown): readonly string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return Object.freeze(items)
}

/** Narrow a raw stored level to the declared enum, or `undefined`. */
function rawMemoryLevel(value: string | undefined): MemoryLevel | undefined {
  return value !== undefined && (MEMORY_LEVELS as readonly string[]).includes(value)
    ? (value as MemoryLevel)
    : undefined
}

/** Raw related-entity `targetRef` paths keyed by relation slot. */
function rawRelatedEntityRefPaths(
  struct: HistoricalStructInspection,
): readonly (readonly string[])[] | undefined {
  const field = struct.fields.relatedEntities
  if (field === undefined || field.kind === 'none') return []
  const node = field.value
  if (node.nodeKind !== 'map') return undefined
  const refPaths: (readonly string[])[] = []
  for (const entry of Object.values(node.entries)) {
    if (entry.nodeKind !== 'struct') return undefined
    const targetRef = entry.fields.targetRef
    if (targetRef === undefined || targetRef.kind === 'none') return undefined
    const targetRefNode = targetRef.value
    if (targetRefNode.nodeKind !== 'leaf') return undefined
    const ref = rawStateRef(targetRefNode.value)
    if (ref === undefined) return undefined
    refPaths.push(ref.path)
  }
  return refPaths
}

/**
 * Validate cognitive memory ownership, enums, metrics, references and the
 * same-perspective summarisation hierarchy.
 *
 * Runs only on the final draft, so writing `memory.seq` before advancing
 * `nextSeq` (or the reverse) inside one transaction remains legal.
 */
function checkCognitiveMemories(graph: PerspectiveGraph): TopologyValidatorFailure | null {
  for (const [perspectiveId] of graph.perspectives()) {
    const perspectivePath = [...PERSPECTIVES_ROOT, perspectiveId]
    const nextSeq = rawNumber(rawLeafValue(graph, perspectivePath, 'nextSeq'))
    if (nextSeq === undefined || !Number.isInteger(nextSeq) || nextSeq < 1)
      return failure(perspectivePath, 'invalid_memory_metrics')
    const memories = graph.inspect([...perspectivePath, 'memories'])
    if (memories.kind === 'none' || memories.value.nodeKind !== 'map') continue
    const records = new Map<
      string,
      {
        readonly path: Path
        readonly struct: HistoricalStructInspection
        readonly fields: RawMemoryFields
      }
    >()
    for (const [memoryId, entry] of Object.entries(memories.value.entries)) {
      const path = [...perspectivePath, 'memories', memoryId]
      if (entry.nodeKind !== 'struct') return failure(path, 'invalid_memory_metrics')
      records.set(memoryId, { path, struct: entry, fields: rawMemoryFields(entry) })
    }
    for (const record of records.values()) {
      const { path, struct, fields } = record
      if (rawString(fields.ownerPerspectiveId) !== perspectiveId)
        return failure(path, 'memory_owner_mismatch')
      const level = rawMemoryLevel(rawString(fields.level))
      const eventOrigin = rawString(fields.eventOrigin)
      const significance = rawString(fields.significance)
      const tier = rawString(fields.tier)
      const belief = rawString(fields.belief)
      const validEnums =
        eventOrigin !== undefined &&
        (MEMORY_EVENT_ORIGINS as readonly string[]).includes(eventOrigin) &&
        significance !== undefined &&
        (MEMORY_SIGNIFICANCES as readonly string[]).includes(significance) &&
        tier !== undefined &&
        (MEMORY_TIERS as readonly string[]).includes(tier) &&
        (belief === 'believed' || belief === 'suspected' || belief === 'known_false')
      if (level === undefined || !validEnums) return failure(path, 'invalid_memory_level')
      const seq = rawNumber(fields.seq)
      const strength = rawNumber(fields.strength)
      const priority = rawNumber(fields.priority)
      if (
        seq === undefined ||
        !Number.isInteger(seq) ||
        seq < 1 ||
        seq >= nextSeq ||
        strength === undefined ||
        !Number.isFinite(strength) ||
        strength < 0 ||
        priority === undefined ||
        !Number.isFinite(priority)
      )
        return failure(path, 'invalid_memory_metrics')
      const startTime = rawNumber(fields.startTime)
      const endTime = rawNumber(fields.endTime)
      if (
        (fields.startTime !== undefined &&
          (startTime === undefined || !Number.isFinite(startTime))) ||
        (fields.endTime !== undefined && (endTime === undefined || !Number.isFinite(endTime))) ||
        (startTime !== undefined && endTime !== undefined && endTime < startTime)
      )
        return failure(path, 'invalid_memory_metrics')
      const factEventRef = rawStateRef(fields.factEventRef)
      const factSnapshotRef = rawStateRef(fields.factSnapshotRef)
      const acquiredAtRef = rawStateRef(fields.acquiredAtRef)
      const originRef = rawStateRef(fields.originRef)
      if (rawString(fields.content) === undefined) return failure(path, 'invalid_memory_content')
      if (
        factEventRef === undefined ||
        factSnapshotRef === undefined ||
        acquiredAtRef === undefined ||
        originRef === undefined
      )
        return failure(path, 'invalid_memory_refs')
      if (factSnapshotRef.path[0] === '$message') return failure(path, 'invalid_memory_refs')
      const relatedEntityRefPaths = rawRelatedEntityRefPaths(struct)
      if (relatedEntityRefPaths === undefined) return failure(path, 'invalid_memory_refs')
      for (const relatedRefPath of relatedEntityRefPaths)
        if (relatedRefPath[0] === '$message') return failure(path, 'invalid_memory_refs')
      if (
        originRef.commitId === SELF_COMMIT &&
        originRef.path.length > 0 &&
        originRef.path[0] !== '$message' &&
        graph.inspect([...originRef.path]).kind === 'none'
      )
        return failure(path, 'invalid_memory_refs')

      const rawChildren = rawStringList(fields.children)
      if (rawChildren === undefined) return failure(path, 'invalid_memory_child_target')
      for (const rawChild of rawChildren) {
        const decoded = decodePathKeySafe(rawChild)
        if (decoded.kind === 'none') return failure(path, 'invalid_memory_child_target')
        const coordinates = parseCognitiveMemoryPath(decoded.value)
        if (coordinates.kind === 'none') return failure(path, 'invalid_memory_child_target')
        if (coordinates.value.rootPerspectiveId !== perspectiveId)
          return failure(path, 'invalid_memory_child_owner')
        const childRecord = records.get(coordinates.value.memoryId)
        if (childRecord === undefined) return failure(path, 'invalid_memory_child_target')
        const childLevel = rawMemoryLevel(rawString(childRecord.fields.level))
        if (childLevel === undefined) return failure(childRecord.path, 'invalid_memory_level')
        const childSeq = rawNumber(childRecord.fields.seq)
        if (childSeq === undefined || !Number.isInteger(childSeq) || childSeq < 1)
          return failure(childRecord.path, 'invalid_memory_metrics')
        if (memoryLevelRank(childLevel) >= memoryLevelRank(level) || seq < childSeq)
          return failure(path, 'invalid_memory_level_hierarchy')
      }
    }
  }
  return null
}

/**
 * Validate the final draft.
 *
 * Runs on every schema commit and sync, including no-op diffs, matching the
 * documented validator lifecycle. Reads and direct world writes bypass it.
 */
export function validatePerspectiveTopology(
  draft: ReadonlySchemaView,
): Result<void, TopologyValidatorFailure> {
  const graph = new Graph(draft)
  const exclusiveParent = checkExclusiveRole(graph, 'parent')
  if (exclusiveParent) return err(exclusiveParent)
  const exclusiveDelegate = checkExclusiveRole(graph, 'delegate')
  if (exclusiveDelegate) return err(exclusiveDelegate)
  for (const role of ['parent', 'delegate', 'subsumes'] as const) {
    const cycle = hasCycle(roleEdges(graph, role))
    if (cycle !== null) return err(failure(pathOfKey(cycle), 'cyclic_role_graph'))
  }
  const edgeFailure = checkEdgeEndpoints(graph)
  if (edgeFailure) return err(edgeFailure)
  const inheritanceFailure = checkPerspectiveInheritance(graph)
  if (inheritanceFailure) return err(inheritanceFailure)
  const memoryFailure = checkCognitiveMemories(graph)
  if (memoryFailure) return err(memoryFailure)
  return ok(undefined)
}
