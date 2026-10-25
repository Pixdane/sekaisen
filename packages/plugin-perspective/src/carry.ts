/**
 * Cross-timeline cognitive carry-over.
 *
 * `carryOver` moves only personal records of one canonical root perspective:
 * surviving observed/discovered/rumor claims, personal exclusions and
 * observer-private memories. Source order drives a fresh contiguous local
 * sequence allocation so the rewind branch never reuses a stored coordinate.
 * Historical fact references and independent origins survive unchanged;
 * acquisition events advance to this commit. Child summary links reconnect
 * only to memories carried in the same batch or to explicitly supplied
 * existing memories, never by content or hash guessing.
 *
 * The destination view is never wider than the source view. Inherited
 * (organisation/common) exclusions that actually cover selected memories are
 * materialised as personal destination exclusions, scoped to those memories
 * and remapped through `mapMemoryId`; organisation membership itself and
 * unrelated inherited exclusions stay behind. These derived exclusions are
 * allocated fresh sequences ahead of every personal item, so an inherited
 * perspective's own `seq` never becomes destination chronology while
 * equal-priority fold order still matches the source inheritance rank.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE } from '@sekaisen/core'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import type { Path, StateRef } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { ClaimContributorTable, ClaimEvaluator } from './claims.ts'
import { decodePathKeySafe, PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective, fail, PerspectiveFailure } from './internal.ts'
import { fieldLensAt } from './lenses.ts'
import { cognitiveMemoryPath, MEMORY_SELF_MESSAGE_REF } from './memory.ts'
import { parseCognitiveMemoryPath } from './memory-topology.ts'
import type { PerspectiveReader, ResolvedObserver } from './reader.ts'
import type {
  CognitiveMemoryRecord,
  ExclusionClaimRecord,
  ObservedClaimRecord,
  PerspectiveRecord,
  RumorClaimRecord,
} from './schemas.ts'
import { memoryLevelRank, PERSPECTIVES_ROOT } from './schemas.ts'
import {
  appendClaim,
  bumpSeq,
  ensurePerspective,
  patchMemory,
  perspectiveRecord,
  writeMemory,
} from './store.ts'
import type { CarryOverResult, CarryOverSelection, PerspectiveError } from './types.ts'

interface ObservedCarryItem {
  readonly kind: 'observed' | 'discovered'
  readonly sourceSeq: number
  readonly record: ObservedClaimRecord
  readonly path: Path
  newSeq: number
  newKey: string
}

interface RumorCarryItem {
  readonly kind: 'rumor'
  readonly sourceSeq: number
  readonly record: RumorClaimRecord
  readonly path: Path
  newSeq: number
  newKey: string
}

interface ExclusionCarryItem {
  readonly kind: 'exclusion'
  readonly sourceSeq: number
  readonly record: ExclusionClaimRecord
  /**
   * Set when this record is a protective projection of an inherited source
   * exclusion. Such items are not source evidence of the personal table and
   * are never used for supporting-key remapping.
   */
  readonly inheritedFrom?: string
  newSeq: number
  newKey: string
  newTargetPathKey: string
}

interface MemoryCarryItem {
  readonly kind: 'memory'
  readonly sourceSeq: number
  readonly memory: CognitiveMemoryRecord
  readonly newId: string
  readonly newPath: Path
  newSeq: number
}

type ClaimCarryItem = ObservedCarryItem | RumorCarryItem | ExclusionCarryItem
type CarryItem = ClaimCarryItem | MemoryCarryItem

const ITEM_RANK: Readonly<Record<CarryItem['kind'], number>> = Object.freeze({
  observed: 0,
  discovered: 1,
  rumor: 2,
  exclusion: 3,
  memory: 4,
})

function itemKey(item: CarryItem): string {
  if (item.kind === 'memory') return item.memory.memoryId
  return item.record.key
}

type PersonalClaimCandidate =
  | {
      readonly table: 'observedClaims'
      readonly record: ObservedClaimRecord
      readonly path: Path
    }
  | {
      readonly table: 'discoveredEntities'
      readonly record: ObservedClaimRecord
      readonly path: Path
    }
  | {
      readonly table: 'rumorClaims'
      readonly record: RumorClaimRecord
      readonly path: Path
    }

type ClaimCarryTable = ClaimContributorTable | 'exclusions'

const CLAIM_TABLE_BY_NAME: Readonly<Record<string, ClaimCarryTable>> = Object.freeze({
  observedClaims: 'observedClaims',
  discoveredEntities: 'discoveredEntities',
  rumorClaims: 'rumorClaims',
  exclusions: 'exclusions',
})

function claimTableOf(item: ClaimCarryItem): ClaimCarryTable {
  if (item.kind === 'exclusion') return 'exclusions'
  if (item.kind === 'rumor') return 'rumorClaims'
  return item.kind === 'discovered' ? 'discoveredEntities' : 'observedClaims'
}

function claimPathKey(rootId: string, table: ClaimCarryTable, key: string): string {
  return encodePathKey([...PERSPECTIVES_ROOT, rootId, table, key])
}

function candidateId(table: ClaimContributorTable, key: string): string {
  return `${table}\u0000${key}`
}

/**
 * Collect the source perspective's winning personal claim records.
 *
 * Every surviving personal facet is carried, including independent coexisting
 * rumors. A same-origin fold merges earlier records into one facet, so the
 * facet's internal contributors, not only its newest `recordKey`, decide which
 * original personal records must migrate with their sources and co-witnesses.
 * Inherited contributors are deliberately ignored.
 */
function survivingPersonalClaims(
  evaluator: ClaimEvaluator,
  record: PerspectiveRecord,
  filter: CarryOverSelection['filterClaim'],
): readonly ClaimCarryItem[] {
  const candidates = new Map<string, PersonalClaimCandidate>()
  const paths = new Map<string, Path>()
  const addCandidate = (candidate: PersonalClaimCandidate): void => {
    candidates.set(candidateId(candidate.table, candidate.record.key), candidate)
    paths.set(encodePathKey(candidate.path), candidate.path)
  }
  for (const claim of record.observedClaims.values())
    addCandidate({
      table: 'observedClaims',
      record: claim,
      path: claim.targetRef.path,
    })
  for (const claim of record.discoveredEntities.values())
    addCandidate({
      table: 'discoveredEntities',
      record: claim,
      path: claim.targetRef.path,
    })
  for (const claim of record.rumorClaims.values()) {
    const decoded = decodePathKeySafe(claim.targetPathKey)
    if (decoded.kind === 'none') continue
    addCandidate({ table: 'rumorClaims', record: claim, path: decoded.value })
  }

  const result = new Map<string, ClaimCarryItem>()
  for (const path of paths.values()) {
    const pathKey = encodePathKey(path)
    for (const facet of evaluator.fold(path).facets) {
      let hasPersonalContributor = false
      for (const contributor of facet.contributors ?? []) {
        if (contributor.perspectiveId !== record.id) continue
        const candidate = candidates.get(candidateId(contributor.table, contributor.recordKey))
        if (candidate === undefined) continue
        if (encodePathKey(candidate.path) !== pathKey) continue
        hasPersonalContributor = true
        break
      }
      if (!hasPersonalContributor) continue
      if (filter !== undefined && !filter(path, facet)) continue
      for (const contributor of facet.contributors ?? []) {
        if (contributor.perspectiveId !== record.id) continue
        const id = candidateId(contributor.table, contributor.recordKey)
        const candidate = candidates.get(id)
        if (candidate === undefined) continue
        if (encodePathKey(candidate.path) !== pathKey) continue
        if (result.has(id)) continue
        if (candidate.table === 'rumorClaims')
          result.set(id, {
            kind: 'rumor',
            sourceSeq: candidate.record.seq,
            record: candidate.record,
            path,
            newSeq: 0,
            newKey: '',
          })
        else
          result.set(id, {
            kind: candidate.table === 'discoveredEntities' ? 'discovered' : 'observed',
            sourceSeq: candidate.record.seq,
            record: candidate.record,
            path,
            newSeq: 0,
            newKey: '',
          })
      }
    }
  }
  return [...result.values()]
}

function claimTableOfPath(path: Path): ClaimCarryTable | undefined {
  if (path.length !== PERSPECTIVES_ROOT.length + 3) return undefined
  if (path[0] !== PERSPECTIVES_ROOT[0]) return undefined
  const tableName = path[PERSPECTIVES_ROOT.length + 1]
  if (tableName === undefined) return undefined
  return CLAIM_TABLE_BY_NAME[tableName]
}

function sourceHasClaimPath(
  perspectives: ReadonlyMap<string, PerspectiveRecord> | undefined,
  path: Path,
): boolean {
  if (perspectives === undefined) return false
  const table = claimTableOfPath(path)
  if (table === undefined) return false
  const perspectiveId = path[PERSPECTIVES_ROOT.length]
  const key = path[PERSPECTIVES_ROOT.length + 2]
  if (perspectiveId === undefined || key === undefined) return false
  const record = perspectives.get(perspectiveId)
  if (record === undefined) return false
  switch (table) {
    case 'observedClaims':
      return record.observedClaims.has(key)
    case 'discoveredEntities':
      return record.discoveredEntities.has(key)
    case 'rumorClaims':
      return record.rumorClaims.has(key)
    case 'exclusions':
      return record.exclusions.has(key)
  }
}

function sourceHasClaimKey(
  perspectives: ReadonlyMap<string, PerspectiveRecord> | undefined,
  key: string,
): boolean {
  if (perspectives === undefined) return false
  for (const record of perspectives.values())
    if (
      record.observedClaims.has(key) ||
      record.discoveredEntities.has(key) ||
      record.rumorClaims.has(key) ||
      record.exclusions.has(key)
    )
      return true
  return false
}

/**
 * Map source evidence keys onto canonical full paths of carried claims.
 *
 * `carriedClaimKeys` and the stored evidence canonical form are full encoded
 * claim paths. Legacy table-local record keys are accepted only when exactly
 * one carried record owns them; a raw key shared by two tables is preserved
 * unchanged rather than silently selecting one. Keys proven to name source
 * claims that were not carried (filtered, overridden or inherited) are
 * intentionally dropped. Unknown formats are preserved instead of being
 * mistaken for uncarried evidence.
 */
function remapSupportingClaimKeys(
  keys: readonly string[],
  evidenceBySourceKey: ReadonlyMap<string, string>,
  uniqueRawEvidence: ReadonlyMap<string, string>,
  perspectives: ReadonlyMap<string, PerspectiveRecord> | undefined,
): readonly string[] {
  const mapped: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    let next = evidenceBySourceKey.get(key)
    if (next === undefined) {
      const decoded = decodePathKeySafe(key)
      if (decoded.kind === 'some' && sourceHasClaimPath(perspectives, decoded.value)) continue
      const raw = uniqueRawEvidence.get(key)
      if (raw !== undefined) next = raw
      else if (sourceHasClaimKey(perspectives, key)) continue
      else next = key
    }
    if (seen.has(next)) continue
    seen.add(next)
    mapped.push(next)
  }
  return Object.freeze(mapped)
}

/**
 * Rewrite an exclusion target that names a carried memory.
 *
 * Renaming a memory through `mapMemoryId` must also rename every exclusion
 * prefix beneath it (the instance itself, a content field or a related-entity
 * association slot); otherwise hidden narrative or associations resurrect
 * under the new id. Non-memory and uncarried targets stay byte-identical.
 */
function remapMemoryExclusionTarget(
  targetPathKey: string,
  rootId: string,
  idMap: Readonly<Record<string, string>>,
): string {
  const decoded = decodePathKeySafe(targetPathKey)
  if (decoded.kind === 'none') return targetPathKey
  const path = decoded.value
  const memoryBaseLength = PERSPECTIVES_ROOT.length + 2
  if (path.length <= memoryBaseLength) return targetPathKey
  if (path[0] !== PERSPECTIVES_ROOT[0]) return targetPathKey
  if (path[PERSPECTIVES_ROOT.length] !== rootId) return targetPathKey
  if (path[PERSPECTIVES_ROOT.length + 1] !== 'memories') return targetPathKey
  const oldMemoryId = path[memoryBaseLength]
  if (oldMemoryId === undefined) return targetPathKey
  const newMemoryId = idMap[oldMemoryId]
  if (newMemoryId === undefined || newMemoryId === oldMemoryId) return targetPathKey
  return encodePathKey([
    ...path.slice(0, memoryBaseLength),
    newMemoryId,
    ...path.slice(memoryBaseLength + 1),
  ])
}

/** One inherited exclusion narrowed to a carried memory and renamed locally. */
interface InheritedProtection {
  readonly perspectiveId: string
  readonly sourceTargetPathKey: string
  readonly targetPathKey: string
  readonly priority: number
  readonly eventRef: StateRef
  readonly rank: number
  readonly seq: number
  readonly recordKey: string
}

/**
 * Effective inherited exclusions that protect the selected memories.
 *
 * A source observer can see a memory through an organisation while that
 * organisation's exclusion hides its narrative. The destination branch only
 * receives personal records, so carrying personal exclusions alone would widen
 * the readable view. Capture inherited records that actually cover a selected
 * memory, narrow whole-memory ancestors to the memory instance (an inherited
 * exclusion above `memories` must not suppress unrelated destination
 * memories), rewrite memory ids through `idMap`, and keep the strongest
 * suppression per target. Exclusions already covered by a carried personal
 * exclusion, or by another inherited exclusion with an equal-or-higher
 * priority, are dropped as redundant.
 *
 * Inherited `seq` values stay provenance only. Callers allocate fresh local
 * sequences for these items ahead of every personal item: an ancestor's
 * exclusion sorts before the root perspective in the source fold, so at equal
 * priority it must also precede carried personal claims on the destination.
 */
function inheritedProtectiveExclusions(
  evaluator: ClaimEvaluator,
  rootId: string,
  memories: readonly CognitiveMemoryRecord[],
  idMap: Readonly<Record<string, string>>,
  personalExclusions: readonly ExclusionCarryItem[],
): readonly ExclusionCarryItem[] {
  if (memories.length === 0) return []
  const memoryKeys = memories.map((memory) => ({ memory, key: encodePathKey(memory.path) }))
  const candidates = new Map<string, InheritedProtection>()
  const order = evaluator.orderedPerspectives()
  for (let rank = 0; rank < order.length; rank++) {
    const perspectiveId = order[rank]!
    if (perspectiveId === rootId) continue
    const record = evaluator.perspectives.get(perspectiveId)
    if (record === undefined) continue
    for (const exclusion of record.exclusions.values()) {
      for (const { memory, key: memoryKey } of memoryKeys) {
        // The memory's own priority decides field suppression, so a weaker
        // inherited exclusion never hid this memory and is not protective.
        if (exclusion.priority < memory.priority) continue
        // A covering ancestor is clipped to the memory instance; a target
        // inside the memory keeps its narrower field/slot/leaf scope.
        const sourceTargetPathKey = memoryKey.startsWith(exclusion.targetPathKey)
          ? memoryKey
          : exclusion.targetPathKey.startsWith(memoryKey)
            ? exclusion.targetPathKey
            : undefined
        if (sourceTargetPathKey === undefined) continue
        const targetPathKey = remapMemoryExclusionTarget(sourceTargetPathKey, rootId, idMap)
        const current = candidates.get(targetPathKey)
        const better =
          current === undefined ||
          exclusion.priority > current.priority ||
          (exclusion.priority === current.priority &&
            (rank < current.rank || (rank === current.rank && exclusion.seq < current.seq)))
        if (!better) continue
        candidates.set(targetPathKey, {
          perspectiveId,
          sourceTargetPathKey,
          targetPathKey,
          priority: exclusion.priority,
          eventRef: exclusion.eventRef,
          rank,
          seq: exclusion.seq,
          recordKey: exclusion.key,
        })
      }
    }
  }

  const carriedPersonal = personalExclusions.map((item) => ({
    targetPathKey: remapMemoryExclusionTarget(item.record.targetPathKey, rootId, idMap),
    priority: item.record.priority,
  }))
  const all = [...candidates.values()]
  const retained = all.filter(
    (candidate) =>
      !carriedPersonal.some(
        (personal) =>
          personal.priority >= candidate.priority &&
          candidate.targetPathKey.startsWith(personal.targetPathKey),
      ) &&
      !all.some(
        (other) =>
          other !== candidate &&
          other.targetPathKey !== candidate.targetPathKey &&
          other.priority >= candidate.priority &&
          candidate.targetPathKey.startsWith(other.targetPathKey),
      ),
  )
  // Deterministic tree order; identity here never depends on inherited seq.
  retained.sort((a, b) => a.targetPathKey.localeCompare(b.targetPathKey))

  return retained.map<ExclusionCarryItem>((candidate) => ({
    kind: 'exclusion',
    // Provenance only; source sequencing is deliberately not reused.
    sourceSeq: candidate.seq,
    record: Object.freeze({
      key: candidate.recordKey,
      seq: candidate.seq,
      targetPathKey: candidate.sourceTargetPathKey,
      eventRef: candidate.eventRef,
      priority: candidate.priority,
    }),
    newSeq: 0,
    newKey: '',
    newTargetPathKey: '',
    inheritedFrom: candidate.perspectiveId,
  }))
}

/**
 * Migrate surviving personal claims and memories across branches.
 *
 * The whole operation is one savepoint: a collision, malformed source child,
 * missing explicit child mapping or write failure rolls back every claim,
 * memory, child patch and sequence advancement made here.
 */
export function carryOver(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  selection: CarryOverSelection,
): Result<CarryOverResult, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const sourceGraph = reader.view(selection.sourceCommitId)
      const targetGraph = new Graph(tx)
      const sourceResolved = reader.resolveObserver(sourceGraph, selection.observer)
      let targetResolved: ResolvedObserver
      try {
        targetResolved = reader.resolveObserver(targetGraph, selection.observer)
      } catch (cause) {
        if (cause instanceof PerspectiveFailure && cause.error.kind === 'observer_entity_not_found')
          targetResolved = {
            id: sourceResolved.id,
            entity: NONE,
            rootEntity: NONE,
          }
        else throw cause
      }
      const rootId = sourceResolved.id
      if (targetResolved.id !== rootId)
        fail({
          kind: 'invalid_memory_target',
          memoryPath: [...PERSPECTIVES_ROOT, rootId],
          reason: 'root_perspective_mismatch',
        })
      const sourceRecordOption = sourceGraph.perspective(rootId)
      const sourceRecord = sourceRecordOption.kind === 'some' ? sourceRecordOption.value : undefined
      if (
        sourceRecord === undefined &&
        selection.memoryIds !== undefined &&
        selection.memoryIds.length > 0
      )
        fail({
          kind: 'carry_over_source_unavailable',
          sourceCommitId: selection.sourceCommitId,
          detail: 'the source perspective has no memories or claims',
        })
      const targetRecordOption = targetGraph.perspective(rootId)
      const targetRecord = targetRecordOption.kind === 'some' ? targetRecordOption.value : undefined
      const hostCandidates: Option<Path>[] = [targetResolved.rootEntity]
      if (sourceResolved.rootEntity.kind === 'some') hostCandidates.push(sourceResolved.rootEntity)
      if (targetRecord !== undefined) hostCandidates.push(targetRecord.hostEntity)
      if (sourceRecord !== undefined) hostCandidates.push(sourceRecord.hostEntity)
      const host = hostCandidates.find((candidate) => candidate.kind === 'some') ?? NONE
      if (host.kind === 'some' && targetGraph.instance(host.value).kind === 'none')
        fail({
          kind: 'carry_over_source_unavailable',
          sourceCommitId: selection.sourceCommitId,
          detail: 'the host entity does not exist on the target branch',
        })
      ensurePerspective(tx, rootId, host)
      const targetSnapshot = perspectiveRecord(tx, rootId)
      const startSeq = targetSnapshot.nextSeq
      if (!Number.isInteger(startSeq) || startSeq < 1)
        fail({
          kind: 'invalid_memory_target',
          memoryPath: [...PERSPECTIVES_ROOT, rootId, 'nextSeq'],
          reason: 'invalid_next_seq',
        })

      const evaluator =
        sourceRecord !== undefined ? reader.evaluatorFor(sourceGraph, rootId) : undefined

      const sourceMemories = sourceRecord?.memories ?? new Map<string, CognitiveMemoryRecord>()
      const selectedIds: string[] = []
      if (selection.memoryIds !== undefined) {
        if (new Set(selection.memoryIds).size !== selection.memoryIds.length)
          fail({
            kind: 'invalid_memory_target',
            memoryPath: [...PERSPECTIVES_ROOT, rootId, 'memories'],
            reason: 'duplicate_memory_selection',
          })
        for (const memoryId of selection.memoryIds) {
          const memory = sourceMemories.get(memoryId)
          if (memory === undefined)
            fail({ kind: 'memory_not_found', rootPerspectiveId: rootId, memoryId })
          if (evaluator?.suppressed(memory.path, memory.priority))
            fail({
              kind: 'invalid_memory_target',
              memoryPath: memory.path,
              reason: 'excluded_memory',
            })
          selectedIds.push(memoryId)
        }
      } else {
        for (const memory of sourceMemories.values()) {
          if (evaluator?.suppressed(memory.path, memory.priority)) continue
          selectedIds.push(memory.memoryId)
        }
      }

      const claimItems: ClaimCarryItem[] = []
      if (sourceRecord !== undefined && evaluator !== undefined) {
        if (selection.includeClaims !== false) {
          claimItems.push(
            ...survivingPersonalClaims(evaluator, sourceRecord, selection.filterClaim),
          )
          for (const exclusion of sourceRecord.exclusions.values())
            claimItems.push({
              kind: 'exclusion',
              sourceSeq: exclusion.seq,
              record: exclusion,
              newSeq: 0,
              newKey: '',
              newTargetPathKey: '',
            })
        } else {
          /*
           * Claims are skipped, but a selected memory's content or association
           * may be hidden by a field/slot exclusion rather than by suppressing
           * the memory instance. Carry only those protective exclusions so a
           * raw narrative cannot reappear on the target branch.
           */
          const carriedMemoryKeys = selectedIds.map((memoryId) =>
            encodePathKey(cognitiveMemoryPath(rootId, memoryId)),
          )
          for (const exclusion of sourceRecord.exclusions.values())
            if (
              carriedMemoryKeys.some(
                (memoryKey) =>
                  memoryKey.startsWith(exclusion.targetPathKey) ||
                  exclusion.targetPathKey.startsWith(memoryKey),
              )
            )
              claimItems.push({
                kind: 'exclusion',
                sourceSeq: exclusion.seq,
                record: exclusion,
                newSeq: 0,
                newKey: '',
                newTargetPathKey: '',
              })
        }
      }

      const idMap: Record<string, string> = Object.create(null)
      const chosenIds = new Set<string>()
      const memoryItems: MemoryCarryItem[] = []
      for (const oldId of selectedIds) {
        const memory = sourceMemories.get(oldId)
        if (memory === undefined) continue
        const newId = selection.mapMemoryId?.(oldId) ?? oldId
        if (typeof newId !== 'string' || newId.length === 0 || newId.startsWith('$'))
          fail({
            kind: 'invalid_memory_target',
            memoryPath: cognitiveMemoryPath(rootId, newId),
            reason: 'invalid_memory_id',
          })
        if (chosenIds.has(newId))
          fail({
            kind: 'memory_conflict',
            memoryPath: cognitiveMemoryPath(rootId, newId),
            detail: 'carried memory ids must be injective',
          })
        if (targetSnapshot.memories.has(newId))
          fail({
            kind: 'memory_conflict',
            memoryPath: cognitiveMemoryPath(rootId, newId),
            detail: 'the target branch already has a memory with this id',
          })
        chosenIds.add(newId)
        idMap[oldId] = newId
        memoryItems.push({
          kind: 'memory',
          sourceSeq: memory.seq,
          memory,
          newId,
          newPath: cognitiveMemoryPath(rootId, newId),
          newSeq: 0,
        })
      }

      const personalItems: CarryItem[] = [...claimItems, ...memoryItems]
      personalItems.sort(
        (a, b) =>
          a.sourceSeq - b.sourceSeq ||
          ITEM_RANK[a.kind] - ITEM_RANK[b.kind] ||
          itemKey(a).localeCompare(itemKey(b)),
      )

      /*
       * Inherited protection is allocated before every personal item. In the
       * source fold an inherited exclusion outranks the root by inheritance
       * rank, so at equal priority it must sort before carried personal claims;
       * a root-level record can only reproduce that with an earlier sequence.
       * The source organisation's own `seq` is still never reused, and the
       * personal items keep their relative source order.
       */
      const inheritedExclusions =
        sourceRecord !== undefined && evaluator !== undefined
          ? inheritedProtectiveExclusions(
              evaluator,
              rootId,
              memoryItems.map((item) => item.memory),
              idMap,
              claimItems.filter((item): item is ExclusionCarryItem => item.kind === 'exclusion'),
            )
          : []
      const items: CarryItem[] = [...inheritedExclusions, ...personalItems]
      for (let index = 0; index < items.length; index++) items[index]!.newSeq = startSeq + index
      claimItems.push(...inheritedExclusions)
      const endSeq = startSeq + items.length - 1

      const evidenceBySourceKey = new Map<string, string>()
      const evidenceByRawKey = new Map<string, string[]>()
      const carriedClaimKeys: string[] = []
      for (const item of claimItems) {
        const table = claimTableOf(item)
        if (item.kind === 'exclusion') {
          item.newTargetPathKey = remapMemoryExclusionTarget(
            item.record.targetPathKey,
            rootId,
            idMap,
          )
          item.newKey = `${item.newTargetPathKey}#${item.newSeq}`
        } else if (item.kind === 'rumor') {
          item.newKey = `${item.record.targetPathKey}#${item.newSeq}`
        } else {
          const pathKey = encodePathKey(item.record.targetRef.path)
          item.newKey = item.kind === 'discovered' ? pathKey : `${pathKey}#${item.newSeq}`
        }
        const carriedKey = claimPathKey(rootId, table, item.newKey)
        /*
         * A protective record projected from an inherited perspective never
         * existed in the source personal table, so it cannot be evidence for
         * a memory's supporting keys and must not shadow a personal raw key.
         */
        if (item.kind !== 'exclusion' || item.inheritedFrom === undefined) {
          evidenceBySourceKey.set(claimPathKey(rootId, table, item.record.key), carriedKey)
          const raw = evidenceByRawKey.get(item.record.key)
          if (raw === undefined) evidenceByRawKey.set(item.record.key, [carriedKey])
          else if (!raw.includes(carriedKey)) raw.push(carriedKey)
        }
        carriedClaimKeys.push(carriedKey)
      }
      const uniqueRawEvidence = new Map<string, string>()
      for (const [rawKey, carriedKeys] of evidenceByRawKey)
        if (carriedKeys.length === 1) uniqueRawEvidence.set(rawKey, carriedKeys[0]!)

      for (const item of claimItems) {
        if (item.kind === 'exclusion') {
          appendClaim(tx, rootId, 'exclusions', item.newKey, {
            seq: item.newSeq,
            targetPathKey: item.newTargetPathKey,
            eventRef: item.record.eventRef,
            priority: item.record.priority,
          })
          continue
        }
        if (item.kind === 'rumor') {
          appendClaim(tx, rootId, 'rumorClaims', item.newKey, {
            seq: item.newSeq,
            targetPathKey: item.record.targetPathKey,
            factEventRef: item.record.factEventRef,
            eventRef: MEMORY_SELF_MESSAGE_REF,
            originEventRef: item.record.originEventRef,
            encodedValue: new Uint8Array(item.record.encodedValue),
            ...(item.record.rumorSummary.kind === 'some'
              ? { rumorSummary: item.record.rumorSummary.value }
              : {}),
            priority: item.record.priority,
            override: item.record.override,
            belief: item.record.belief,
            ...(item.record.source.kind === 'some' ? { source: item.record.source.value } : {}),
            coWitnesses: item.record.coWitnesses,
          })
          continue
        }
        appendClaim(
          tx,
          rootId,
          item.kind === 'discovered' ? 'discoveredEntities' : 'observedClaims',
          item.newKey,
          {
            seq: item.newSeq,
            targetRef: item.record.targetRef,
            eventRef: MEMORY_SELF_MESSAGE_REF,
            originEventRef: item.record.originEventRef,
            priority: item.record.priority,
            override: item.record.override,
            belief: item.record.belief,
            ...(item.record.source.kind === 'some' ? { source: item.record.source.value } : {}),
            coWitnesses: item.record.coWitnesses,
          },
        )
      }

      const memorySeqById = new Map<string, number>()
      for (const item of memoryItems) memorySeqById.set(item.memory.memoryId, item.newSeq)
      const childKeysByNewId = new Map<string, readonly string[]>()
      for (const item of memoryItems) {
        const keys: string[] = []
        const seen = new Set<string>()
        for (const childPath of item.memory.children) {
          const coordinates = parseCognitiveMemoryPath(childPath)
          if (coordinates.kind === 'none')
            fail({
              kind: 'invalid_memory_target',
              memoryPath: item.newPath,
              reason: 'invalid_memory_child_target',
            })
          if (coordinates.value.rootPerspectiveId !== rootId)
            fail({
              kind: 'invalid_memory_target',
              memoryPath: item.newPath,
              reason: 'invalid_memory_child_owner',
            })
          const oldChildId = coordinates.value.memoryId
          if (oldChildId === item.memory.memoryId)
            fail({
              kind: 'invalid_memory_target',
              memoryPath: item.newPath,
              reason: 'memory_cannot_subsume_itself',
            })
          let targetChildId: string | undefined
          const carriedChildId = idMap[oldChildId]
          if (carriedChildId !== undefined) {
            const carriedChild = sourceMemories.get(oldChildId)
            if (
              carriedChild !== undefined &&
              memoryLevelRank(carriedChild.level) >= memoryLevelRank(item.memory.level)
            )
              fail({
                kind: 'memory_conflict',
                memoryPath: item.newPath,
                detail: `carried child violates level hierarchy: ${oldChildId}`,
              })
            targetChildId = carriedChildId
          } else if (
            selection.existingChildMemoryMap !== undefined &&
            Object.hasOwn(selection.existingChildMemoryMap, oldChildId)
          ) {
            const mappedId = selection.existingChildMemoryMap[oldChildId]
            if (mappedId === undefined)
              fail({
                kind: 'memory_conflict',
                memoryPath: item.newPath,
                detail: `explicit child mapping is undefined: ${oldChildId}`,
              })
            targetChildId = mappedId
            const existing = targetSnapshot.memories.get(mappedId)
            if (existing === undefined || existing.ownerPerspectiveId !== rootId)
              fail({
                kind: 'memory_conflict',
                memoryPath: item.newPath,
                detail: `explicit child mapping is not an existing memory of this perspective: ${oldChildId}`,
              })
            if (memoryLevelRank(existing.level) >= memoryLevelRank(item.memory.level))
              fail({
                kind: 'memory_conflict',
                memoryPath: item.newPath,
                detail: `explicit child mapping violates level hierarchy: ${oldChildId}`,
              })
            if (existing.seq > item.newSeq)
              fail({
                kind: 'memory_conflict',
                memoryPath: item.newPath,
                detail: `explicit child mapping violates sequence order: ${oldChildId}`,
              })
          }
          if (targetChildId === undefined) continue
          const childSeq = memorySeqById.get(oldChildId)
          if (childSeq !== undefined && childSeq > item.newSeq)
            fail({
              kind: 'memory_conflict',
              memoryPath: item.newPath,
              detail: `carried child sequence exceeds its parent: ${oldChildId}`,
            })
          const targetKey = encodePathKey([...PERSPECTIVES_ROOT, rootId, 'memories', targetChildId])
          if (seen.has(targetKey)) continue
          seen.add(targetKey)
          keys.push(targetKey)
        }
        childKeysByNewId.set(item.newId, Object.freeze(keys))
      }

      const supportingKeys = new Map<string, readonly string[]>()
      for (const item of memoryItems)
        supportingKeys.set(
          item.newId,
          remapSupportingClaimKeys(
            item.memory.supportingClaimKeys,
            evidenceBySourceKey,
            uniqueRawEvidence,
            evaluator?.perspectives,
          ),
        )

      const carriedMemoryPaths: Path[] = []
      for (const item of items) {
        if (item.kind !== 'memory') continue
        const memory = item.memory
        const refs: {
          factEventRef: StateRef
          factSnapshotRef: StateRef
          acquiredAtRef: StateRef
          originRef: StateRef
        } = {
          factEventRef: memory.factEventRef,
          factSnapshotRef: memory.factSnapshotRef,
          acquiredAtRef: MEMORY_SELF_MESSAGE_REF,
          originRef: { commitId: selection.sourceCommitId, path: memory.path },
        }
        writeMemory(tx, rootId, item.newId, {
          ownerPerspectiveId: rootId,
          seq: item.newSeq,
          level: memory.level,
          eventOrigin: memory.eventOrigin,
          significance: memory.significance,
          tier: memory.tier,
          strength: memory.strength,
          belief: memory.belief,
          priority: memory.priority,
          ...(memory.startTime.kind === 'some' ? { startTime: memory.startTime.value } : {}),
          ...(memory.endTime.kind === 'some' ? { endTime: memory.endTime.value } : {}),
          content: memory.content,
          factEventRef: refs.factEventRef,
          factSnapshotRef: refs.factSnapshotRef,
          acquiredAtRef: refs.acquiredAtRef,
          originRef: refs.originRef,
          supportingClaimKeys: supportingKeys.get(item.newId) ?? Object.freeze([]),
          children: Object.freeze([]),
          relatedEntities: Object.fromEntries(
            memory.relatedEntities.map((entity) => [
              entity.slot,
              { targetRef: entity.targetRef, role: entity.role },
            ]),
          ),
        })
        if (memory.summary.kind === 'some')
          tx.setWithMeta(fieldLensAt(tx, [...item.newPath, 'content']), memory.content, {
            summary: memory.summary.value,
          })
        carriedMemoryPaths.push(item.newPath)
      }

      for (const item of items) {
        if (item.kind !== 'memory') continue
        const children = childKeysByNewId.get(item.newId) ?? Object.freeze([])
        if (children.length > 0) patchMemory(tx, rootId, item.newId, { children })
      }

      if (items.length > 0) bumpSeq(tx, rootId, startSeq + items.length)
      const result: CarryOverResult = Object.freeze({
        rootPerspectiveId: rootId,
        sourceCommitId: selection.sourceCommitId,
        memoryIdMap: Object.freeze({ ...idMap }),
        carriedMemoryPaths: Object.freeze(carriedMemoryPaths),
        carriedClaimKeys: Object.freeze([...carriedClaimKeys].sort()),
        allocatedSeqRange: Object.freeze([startSeq, endSeq]) as readonly [number, number],
      })
      return result
    }),
  )
}
