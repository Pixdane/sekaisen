/**
 * Explicit cognitive memory commands.
 *
 * Memories are observer-private narratives. These commands never derive the
 * subjective `content` from objective event or snapshot payloads, never
 * physically delete a memory in response to ordinary forgetting, and run
 * multi-write operations inside one transaction savepoint so a rejected write
 * leaves no partial memory or sequence allocation behind.
 */

import type { Result } from '@sekaisen/core'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import type { Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import type { PerspectiveGraph } from './graph.ts'
import { PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective, fail } from './internal.ts'
import { fieldLensAt } from './lenses.ts'
import { readableMemoryRelatedEntities, readableMemorySummary } from './memory-access.ts'
import { parseCognitiveMemoryPath } from './memory-topology.ts'
import type { PerspectiveReader } from './reader.ts'
import type {
  CognitiveMemoryInput,
  MemoryEventOrigin,
  MemoryLevel,
  MemorySignificance,
  MemoryTier,
} from './schemas.ts'
import {
  MEMORY_EVENT_ORIGINS,
  MEMORY_LEVELS,
  MEMORY_SIGNIFICANCES,
  MEMORY_TIERS,
  memoryLevelRank,
  PERSPECTIVES_ROOT,
} from './schemas.ts'
import {
  appendClaim,
  bumpSeq,
  ensurePerspective,
  patchMemory,
  perspectiveRecord,
  writeMemory,
} from './store.ts'
import type {
  BeliefState,
  CreateMemoryInput,
  ForgetMemoryMode,
  ObserverRef,
  PerspectiveError,
  PropagateMemoryOptions,
  SummarizeMemoriesInput,
  UpdateMemoryPatch,
} from './types.ts'

/** Current-commit message reference used for acquisition events. */
export const MEMORY_SELF_MESSAGE_REF: StateRef = Object.freeze({
  commitId: SELF_COMMIT,
  path: Object.freeze(['$message']),
})

/** Current-commit tree root used as the default factual snapshot. */
export const MEMORY_SELF_ROOT_SNAPSHOT: StateRef = Object.freeze({
  commitId: SELF_COMMIT,
  path: Object.freeze([]),
})

const BELIEF_STATES: readonly BeliefState[] = Object.freeze([
  'believed',
  'suspected',
  'known_false',
])

/** Full path of one memory record. */
export function cognitiveMemoryPath(perspectiveId: string, memoryId: string): Path {
  return [...PERSPECTIVES_ROOT, perspectiveId, 'memories', memoryId]
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

function assertMemoryId(id: string, path: Path): void {
  if (typeof id !== 'string' || id.length === 0 || id.startsWith('$'))
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_id',
    })
}

function assertStateRef(value: unknown, path: Path, label: string): asserts value is StateRef {
  if (!isStateRef(value))
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: `invalid_memory_ref:${label}`,
    })
}

/** Validate the enum-valued memory fields before the first write. */
function assertMemoryEnums(
  path: Path,
  values: {
    readonly level: string
    readonly eventOrigin: string
    readonly significance: string
    readonly tier: string
    readonly belief: string
  },
): void {
  const valid =
    (MEMORY_LEVELS as readonly string[]).includes(values.level) &&
    (MEMORY_EVENT_ORIGINS as readonly string[]).includes(values.eventOrigin) &&
    (MEMORY_SIGNIFICANCES as readonly string[]).includes(values.significance) &&
    (MEMORY_TIERS as readonly string[]).includes(values.tier) &&
    BELIEF_STATES.includes(values.belief as BeliefState)
  if (!valid)
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_enum',
    })
}

/** Validate finite metrics, sequence allocation and optional temporal bounds. */
function assertMemoryMetrics(
  path: Path,
  values: {
    readonly seq: number
    readonly nextSeq: number
    readonly strength: number
    readonly priority: number
    readonly startTime?: number
    readonly endTime?: number
  },
): void {
  if (!Number.isInteger(values.seq) || values.seq < 1 || values.seq >= values.nextSeq)
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_sequence',
    })
  if (!Number.isInteger(values.nextSeq) || values.nextSeq < 1)
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_next_seq',
    })
  if (!Number.isFinite(values.strength) || values.strength < 0)
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_strength',
    })
  if (!Number.isFinite(values.priority))
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_priority',
    })
  if (values.startTime !== undefined && !Number.isFinite(values.startTime))
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_start_time',
    })
  if (values.endTime !== undefined && !Number.isFinite(values.endTime))
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_end_time',
    })
  if (
    values.startTime !== undefined &&
    values.endTime !== undefined &&
    values.endTime < values.startTime
  )
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_time_bounds',
    })
}

/** Validate the snapshot/entity reference kinds memory records must not use. */
function assertMemoryReferences(
  path: Path,
  factSnapshotRef: StateRef,
  relatedEntities: readonly { readonly targetRef: StateRef }[],
): void {
  if (factSnapshotRef.path[0] === '$message')
    fail({
      kind: 'invalid_memory_target',
      memoryPath: path,
      reason: 'invalid_memory_snapshot_ref',
    })
  for (const entity of relatedEntities) {
    if (entity.targetRef.path[0] === '$message')
      fail({
        kind: 'invalid_memory_target',
        memoryPath: path,
        reason: 'invalid_memory_entity_ref',
      })
  }
}

/** Normalize related-entity input into a slot-keyed record with safe keys. */
function relatedEntityInput(
  path: Path,
  input: CreateMemoryInput['relatedEntities'],
): Readonly<Record<string, { readonly targetRef: StateRef; readonly role: string }>> {
  if (input === undefined) return {}
  const entries: { slot: string; targetRef: StateRef; role: string }[] = []
  for (const [slot, relation] of Object.entries(input)) {
    if (slot.length === 0 || slot.startsWith('$'))
      fail({
        kind: 'invalid_memory_target',
        memoryPath: path,
        reason: 'invalid_memory_entity_slot',
      })
    assertStateRef(relation.targetRef, path, `relatedEntities.${slot}`)
    if (relation.role !== undefined && typeof relation.role !== 'string')
      fail({
        kind: 'invalid_memory_target',
        memoryPath: path,
        reason: 'invalid_memory_entity_role',
      })
    entries.push({
      slot,
      targetRef: relation.targetRef,
      role: relation.role ?? 'participant',
    })
  }
  return Object.fromEntries(
    entries.map((entry) => [entry.slot, { targetRef: entry.targetRef, role: entry.role }]),
  )
}

/** Whether `from` reaches `target` along stored summary children. */
function memoryReaches(
  graph: PerspectiveGraph,
  perspectiveId: string,
  from: Path,
  targetPathKey: string,
): boolean {
  const visited = new Set<string>()
  const stack: Path[] = [from]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (encodePathKey(current) === targetPathKey) return true
    const key = encodePathKey(current)
    if (visited.has(key)) continue
    visited.add(key)
    const memory = graph.perspectiveOrDefault(perspectiveId).memories.get(current.at(-1)!)
    if (!memory) continue
    for (const child of memory.children) stack.push(child)
  }
  return false
}

/**
 * Validate child links and return encoded link targets.
 *
 * Every child must be an actual memory of the same root perspective with a
 * strictly lower level and a sequence no greater than the parent's. Adding a
 * child that would close a cycle is rejected before the first write.
 */
export function validateMemoryChildren(
  graph: PerspectiveGraph,
  perspectiveId: string,
  parentId: string,
  parentLevel: MemoryLevel,
  parentSeq: number,
  children: readonly Path[],
): readonly string[] {
  const parentPath = cognitiveMemoryPath(perspectiveId, parentId)
  const record = graph.perspectiveOrDefault(perspectiveId)
  const keys: string[] = []
  const seen = new Set<string>()
  for (const child of children) {
    const coordinates = parseCognitiveMemoryPath(child)
    if (coordinates.kind === 'none')
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'invalid_memory_child_target',
      })
    if (coordinates.value.rootPerspectiveId !== perspectiveId)
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'invalid_memory_child_owner',
      })
    if (coordinates.value.memoryId === parentId)
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'memory_cannot_subsume_itself',
      })
    const childMemory = record.memories.get(coordinates.value.memoryId)
    if (!childMemory || childMemory.ownerPerspectiveId !== perspectiveId)
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'invalid_memory_child_target',
      })
    if (memoryLevelRank(childMemory.level) >= memoryLevelRank(parentLevel))
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'invalid_memory_level_hierarchy',
      })
    if (childMemory.seq > parentSeq)
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'invalid_memory_sequence_hierarchy',
      })
    if (memoryReaches(graph, perspectiveId, child, encodePathKey(parentPath)))
      fail({
        kind: 'invalid_memory_target',
        memoryPath: parentPath,
        reason: 'cyclic_memory_children',
      })
    const key = encodePathKey(child)
    if (seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return Object.freeze(keys)
}

/** Shared ref-defaulting for a newly written memory. */
function newMemoryRefs(
  path: Path,
  input: {
    readonly factEventRef?: StateRef
    readonly factSnapshotRef?: StateRef
    readonly acquiredAtRef?: StateRef
    readonly originRef?: StateRef
  },
): {
  factEventRef: StateRef
  factSnapshotRef: StateRef
  acquiredAtRef: StateRef
  originRef: StateRef
} {
  const factEventRef = input.factEventRef ?? MEMORY_SELF_MESSAGE_REF
  const factSnapshotRef = input.factSnapshotRef ?? MEMORY_SELF_ROOT_SNAPSHOT
  const acquiredAtRef = input.acquiredAtRef ?? MEMORY_SELF_MESSAGE_REF
  const originRef = input.originRef ?? {
    commitId: SELF_COMMIT,
    path,
  }
  assertStateRef(factEventRef, path, 'factEventRef')
  assertStateRef(factSnapshotRef, path, 'factSnapshotRef')
  assertStateRef(acquiredAtRef, path, 'acquiredAtRef')
  assertStateRef(originRef, path, 'originRef')
  return { factEventRef, factSnapshotRef, acquiredAtRef, originRef }
}

/** Write the content leaf together with an optional metadata patch. */
function writeMemoryContent(
  tx: SchemaTransaction,
  path: Path,
  content: string,
  meta: Readonly<Record<string, Value | null>>,
): void {
  const lens = fieldLensAt(tx, [...path, 'content'])
  tx.setWithMeta(lens, content, meta)
}

/**
 * Write one subjective memory under the observer's canonical root perspective.
 *
 * The record receives the perspective's current `nextSeq`, then the counter is
 * advanced in the same savepoint. Ids never overwrite existing entries.
 */
export function createMemory(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  input: CreateMemoryInput,
): Result<Path, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const graph = new Graph(tx)
      const resolved = reader.resolveObserver(graph, observer)
      ensurePerspective(tx, resolved.id, resolved.rootEntity)
      const record = perspectiveRecord(tx, resolved.id)
      const path = cognitiveMemoryPath(resolved.id, input.id)
      assertMemoryId(input.id, path)
      if (record.memories.has(input.id))
        fail({
          kind: 'memory_conflict',
          memoryPath: path,
          detail: 'a memory with this id already exists in the perspective',
        })
      const seq = record.nextSeq
      const level = input.level ?? 'L0'
      const eventOrigin = input.eventOrigin ?? 'scene'
      const significance = input.significance ?? 'routine'
      const tier = input.tier ?? 'active'
      const strength = input.strength ?? 1
      const belief = input.belief ?? 'believed'
      const priority = input.priority ?? record.defaultPriority
      assertMemoryEnums(path, { level, eventOrigin, significance, tier, belief })
      assertMemoryMetrics(path, {
        seq,
        nextSeq: seq + 1,
        strength,
        priority,
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
      })
      if (typeof input.content !== 'string')
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'invalid_memory_content',
        })
      if (input.summary !== undefined && typeof input.summary !== 'string')
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'invalid_memory_summary',
        })
      const relatedEntities = relatedEntityInput(path, input.relatedEntities)
      const refs = newMemoryRefs(path, input)
      assertMemoryReferences(path, refs.factSnapshotRef, Object.values(relatedEntities))
      const children = validateMemoryChildren(
        graph,
        resolved.id,
        input.id,
        level,
        seq,
        input.children ?? [],
      )
      const memoryInput: CognitiveMemoryInput = {
        ownerPerspectiveId: resolved.id,
        seq,
        level,
        eventOrigin,
        significance,
        tier,
        strength,
        belief,
        priority,
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
        content: input.content,
        factEventRef: refs.factEventRef,
        factSnapshotRef: refs.factSnapshotRef,
        acquiredAtRef: refs.acquiredAtRef,
        originRef: refs.originRef,
        supportingClaimKeys: Object.freeze([...(input.supportingClaimKeys ?? [])]),
        children,
        relatedEntities,
      }
      writeMemory(tx, resolved.id, input.id, memoryInput)
      writeMemoryContent(
        tx,
        path,
        input.content,
        input.summary === undefined ? {} : { summary: input.summary },
      )
      bumpSeq(tx, resolved.id, seq + 1)
      return Object.freeze(path)
    }),
  )
}

/**
 * Update mutable memory state without changing owner, level, sequence or refs.
 *
 * Content and its micro-summary share one leaf write; supplying only
 * `summary` preserves the existing narrative, while `summary: NONE` removes
 * the leaf summary.
 */
export function updateMemory(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  memoryId: string,
  patch: UpdateMemoryPatch,
): Result<void, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const graph = new Graph(tx)
      const resolved = reader.resolveObserver(graph, observer)
      const record = perspectiveRecord(tx, resolved.id)
      const memory = record.memories.get(memoryId)
      const path = cognitiveMemoryPath(resolved.id, memoryId)
      if (!memory) fail({ kind: 'memory_not_found', rootPerspectiveId: resolved.id, memoryId })
      if (memory.ownerPerspectiveId !== resolved.id)
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'memory_owner_mismatch',
        })
      const nextPatch: Record<string, unknown> = {}
      if (patch.tier !== undefined) {
        assertMemoryEnums(path, {
          level: memory.level,
          eventOrigin: memory.eventOrigin,
          significance: memory.significance,
          tier: patch.tier,
          belief: memory.belief,
        })
        nextPatch.tier = patch.tier
      }
      if (patch.belief !== undefined) {
        assertMemoryEnums(path, {
          level: memory.level,
          eventOrigin: memory.eventOrigin,
          significance: memory.significance,
          tier: memory.tier,
          belief: patch.belief,
        })
        nextPatch.belief = patch.belief
      }
      const strength = patch.strength ?? memory.strength
      const priority = patch.priority ?? memory.priority
      assertMemoryMetrics(path, {
        seq: memory.seq,
        nextSeq: Math.max(record.nextSeq, memory.seq + 1),
        strength,
        priority,
      })
      if (patch.strength !== undefined) nextPatch.strength = patch.strength
      if (patch.priority !== undefined) nextPatch.priority = patch.priority
      if (patch.children !== undefined)
        nextPatch.children = validateMemoryChildren(
          graph,
          resolved.id,
          memoryId,
          memory.level,
          memory.seq,
          patch.children,
        )
      if (Object.keys(nextPatch).length > 0) patchMemory(tx, resolved.id, memoryId, nextPatch)
      if (patch.content !== undefined || patch.summary !== undefined) {
        const content = patch.content ?? memory.content
        if (typeof content !== 'string')
          fail({
            kind: 'invalid_memory_target',
            memoryPath: path,
            reason: 'invalid_memory_content',
          })
        const meta: Record<string, Value | null> = {}
        if (patch.summary !== undefined) {
          if (patch.summary.kind === 'some') {
            if (typeof patch.summary.value !== 'string')
              fail({
                kind: 'invalid_memory_target',
                memoryPath: path,
                reason: 'invalid_memory_summary',
              })
            meta.summary = patch.summary.value
          } else meta.summary = null
        }
        writeMemoryContent(tx, path, content, meta)
      }
    }),
  )
}

/**
 * Create an `L1`/`L2` summary over same-perspective memories.
 *
 * Child validation covers ownership, physical existence, strict level
 * progression and sequence order before the summary is written. Children are
 * archived by default; `archiveChildrenTier: false` preserves their tiers.
 */
export function summarizeMemories(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  input: SummarizeMemoriesInput,
): Result<Path, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const graph = new Graph(tx)
      const resolved = reader.resolveObserver(graph, observer)
      ensurePerspective(tx, resolved.id, resolved.rootEntity)
      const record = perspectiveRecord(tx, resolved.id)
      const path = cognitiveMemoryPath(resolved.id, input.id)
      assertMemoryId(input.id, path)
      if (record.memories.has(input.id))
        fail({
          kind: 'memory_conflict',
          memoryPath: path,
          detail: 'a memory with this id already exists in the perspective',
        })
      const level: MemoryLevel = input.level === 'L2' ? 'L2' : 'L1'
      if (input.level !== 'L1' && input.level !== 'L2')
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'invalid_memory_summary_level',
        })
      if (input.childMemoryIds.length === 0)
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'summarize_requires_children',
        })
      if (new Set(input.childMemoryIds).size !== input.childMemoryIds.length)
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'duplicate_child_memory',
        })
      const seq = record.nextSeq
      const strength = input.strength ?? 1
      const priority = record.defaultPriority
      assertMemoryMetrics(path, { seq, nextSeq: seq + 1, strength, priority })
      if (typeof input.content !== 'string')
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'invalid_memory_content',
        })
      if (input.summary !== undefined && typeof input.summary !== 'string')
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'invalid_memory_summary',
        })
      const childPaths: Path[] = []
      for (const childId of input.childMemoryIds) {
        const childPath = cognitiveMemoryPath(resolved.id, childId)
        const child = record.memories.get(childId)
        if (!child || child.ownerPerspectiveId !== resolved.id)
          fail({
            kind: 'invalid_memory_target',
            memoryPath: path,
            reason: 'invalid_memory_child_target',
          })
        if (memoryLevelRank(child.level) >= memoryLevelRank(level))
          fail({
            kind: 'invalid_memory_target',
            memoryPath: path,
            reason: 'invalid_memory_level_hierarchy',
          })
        if (child.seq > seq)
          fail({
            kind: 'invalid_memory_target',
            memoryPath: path,
            reason: 'invalid_memory_sequence_hierarchy',
          })
        childPaths.push(childPath)
      }
      const children = validateMemoryChildren(graph, resolved.id, input.id, level, seq, childPaths)
      const refs = newMemoryRefs(path, {})
      const memoryInput: CognitiveMemoryInput = {
        ownerPerspectiveId: resolved.id,
        seq,
        level,
        eventOrigin: 'reflection',
        significance: input.significance ?? 'routine',
        tier: input.tier ?? 'active',
        strength,
        belief: 'believed',
        priority,
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
        content: input.content,
        factEventRef: refs.factEventRef,
        factSnapshotRef: refs.factSnapshotRef,
        acquiredAtRef: refs.acquiredAtRef,
        originRef: refs.originRef,
        supportingClaimKeys: Object.freeze([]),
        children,
        relatedEntities: Object.freeze({}),
      }
      assertMemoryEnums(path, {
        level,
        eventOrigin: memoryInput.eventOrigin,
        significance: memoryInput.significance,
        tier: memoryInput.tier,
        belief: memoryInput.belief,
      })
      assertMemoryMetrics(path, {
        seq,
        nextSeq: seq + 1,
        strength,
        priority,
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
      })
      if (input.archiveChildrenTier !== false) {
        for (const childId of input.childMemoryIds)
          patchMemory(tx, resolved.id, childId, { tier: 'archive' })
      }
      writeMemory(tx, resolved.id, input.id, memoryInput)
      writeMemoryContent(
        tx,
        path,
        input.content,
        input.summary === undefined ? {} : { summary: input.summary },
      )
      bumpSeq(tx, resolved.id, seq + 1)
      return Object.freeze(path)
    }),
  )
}

/**
 * Forget through state evolution rather than physical deletion.
 *
 * `exclude` writes a stronger-than-memory exclusion so the memory disappears
 * from the observer's effective view; `known_false` leaves child links intact
 * because projection stops folding children of a false summary.
 */
export function forgetMemory(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  memoryId: string,
  mode: ForgetMemoryMode,
): Result<void, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const graph = new Graph(tx)
      const resolved = reader.resolveObserver(graph, observer)
      const record = perspectiveRecord(tx, resolved.id)
      const memory = record.memories.get(memoryId)
      const path = cognitiveMemoryPath(resolved.id, memoryId)
      if (!memory) fail({ kind: 'memory_not_found', rootPerspectiveId: resolved.id, memoryId })
      if (memory.ownerPerspectiveId !== resolved.id)
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'memory_owner_mismatch',
        })
      if (mode === 'archive') {
        patchMemory(tx, resolved.id, memoryId, { tier: 'archive' })
        return
      }
      if (mode === 'known_false') {
        patchMemory(tx, resolved.id, memoryId, { belief: 'known_false' })
        return
      }
      if (mode !== 'exclude')
        fail({
          kind: 'invalid_memory_target',
          memoryPath: path,
          reason: 'invalid_forget_mode',
        })
      const seq = record.nextSeq
      assertMemoryMetrics(path, {
        seq,
        nextSeq: seq + 1,
        strength: memory.strength,
        priority: memory.priority,
      })
      const key = `${encodePathKey(path)}#${seq}`
      appendClaim(tx, resolved.id, 'exclusions', key, {
        seq,
        targetPathKey: encodePathKey(path),
        eventRef: MEMORY_SELF_MESSAGE_REF,
        priority: Math.max(record.defaultPriority, memory.priority) + 1,
      })
      bumpSeq(tx, resolved.id, seq + 1)
    }),
  )
}

/**
 * Retell one self-owned memory to another observer.
 *
 * Historical refs and content survive; acquisition advances to this commit,
 * acquisition-scoped supporting keys and cross-perspective child links are
 * dropped, and the target id must not collide with existing memories.
 */
export function propagateMemory(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  fromObserver: ObserverRef,
  toObserver: ObserverRef,
  memoryId: string,
  options?: PropagateMemoryOptions,
): Result<Path, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const graph = new Graph(tx)
      const from = reader.resolveObserver(graph, fromObserver)
      const to = reader.resolveObserver(graph, toObserver)
      const fromRecord = perspectiveRecord(tx, from.id)
      const memory = fromRecord.memories.get(memoryId)
      const sourcePath = cognitiveMemoryPath(from.id, memoryId)
      if (!memory || memory.ownerPerspectiveId !== from.id)
        fail({ kind: 'memory_not_found', rootPerspectiveId: from.id, memoryId })
      const evaluator = reader.evaluatorFor(graph, from.id)
      const suppressedField = (field: string): boolean =>
        evaluator.suppressed([...sourcePath, field], memory.priority)
      /*
       * Retelling must never widen what the sender knows. An exclusion on the
       * instance, the narrative, or the historical fact references makes a
       * faithful retelling impossible, so propagation refuses instead of
       * inventing coordinates or exposing the hidden text.
       */
      if (
        evaluator.suppressed(sourcePath, memory.priority) ||
        suppressedField('content') ||
        suppressedField('factEventRef') ||
        suppressedField('factSnapshotRef')
      )
        fail({
          kind: 'not_authorized',
          rootPerspectiveId: from.id,
          targetPath: sourcePath,
        })
      ensurePerspective(tx, to.id, to.rootEntity)
      const targetRecord = perspectiveRecord(tx, to.id)
      const targetId = options?.targetMemoryId ?? memoryId
      const targetPath = cognitiveMemoryPath(to.id, targetId)
      assertMemoryId(targetId, targetPath)
      if (targetRecord.memories.has(targetId))
        fail({
          kind: 'memory_conflict',
          memoryPath: targetPath,
          detail: 'the receiver already has a memory with this id',
        })
      const seq = targetRecord.nextSeq
      const level: MemoryLevel = suppressedField('level') ? 'L0' : memory.level
      const eventOrigin: MemoryEventOrigin = suppressedField('eventOrigin')
        ? 'scene'
        : memory.eventOrigin
      const significance: MemorySignificance = suppressedField('significance')
        ? 'routine'
        : memory.significance
      const tier: MemoryTier = suppressedField('tier') ? 'active' : memory.tier
      const strength = suppressedField('strength') ? 1 : memory.strength
      const belief: BeliefState = suppressedField('belief') ? 'believed' : memory.belief
      const priority = suppressedField('priority') ? targetRecord.defaultPriority : memory.priority
      /*
       * Related-entity slots are associations, not narrative: filtering the
       * whole map, a slot, its `targetRef`, or its `role` keeps suppressed
       * associations (and hidden roles) out of the receiver's memory.
       */
      const relatedEntities = Object.fromEntries(
        readableMemoryRelatedEntities(evaluator, memory).map((entity) => [
          entity.slot,
          { targetRef: entity.targetRef, role: entity.role },
        ]),
      )
      assertMemoryMetrics(targetPath, {
        seq,
        nextSeq: seq + 1,
        strength,
        priority,
      })
      const acquiredAtRef = options?.acquiredAtRef ?? MEMORY_SELF_MESSAGE_REF
      const originRef = options?.originRef ?? {
        commitId: SELF_COMMIT,
        path: Object.freeze([...sourcePath]),
      }
      assertStateRef(acquiredAtRef, targetPath, 'acquiredAtRef')
      assertStateRef(originRef, targetPath, 'originRef')
      const memoryInput: CognitiveMemoryInput = {
        ownerPerspectiveId: to.id,
        seq,
        level,
        eventOrigin,
        significance,
        tier,
        strength,
        belief,
        priority,
        ...(memory.startTime.kind === 'some' && !suppressedField('startTime')
          ? { startTime: memory.startTime.value }
          : {}),
        ...(memory.endTime.kind === 'some' && !suppressedField('endTime')
          ? { endTime: memory.endTime.value }
          : {}),
        content: memory.content,
        factEventRef: memory.factEventRef,
        factSnapshotRef: memory.factSnapshotRef,
        acquiredAtRef,
        originRef,
        supportingClaimKeys: Object.freeze([]),
        children: Object.freeze([]),
        relatedEntities,
      }
      assertMemoryEnums(targetPath, {
        level: memoryInput.level,
        eventOrigin: memoryInput.eventOrigin,
        significance: memoryInput.significance,
        tier: memoryInput.tier,
        belief: memoryInput.belief,
      })
      assertMemoryReferences(
        targetPath,
        memoryInput.factSnapshotRef,
        Object.values(memoryInput.relatedEntities),
      )
      writeMemory(tx, to.id, targetId, memoryInput)
      const summary = readableMemorySummary(evaluator, memory)
      writeMemoryContent(
        tx,
        targetPath,
        memory.content,
        summary.kind === 'some' ? { summary: summary.value } : {},
      )
      bumpSeq(tx, to.id, seq + 1)
      return Object.freeze(targetPath)
    }),
  )
}
