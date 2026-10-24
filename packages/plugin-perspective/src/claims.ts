/**
 * Deterministic claim folding.
 *
 * The folding pipeline is the single arbitration point for memory, inheritance
 * and rumour: all candidates (observed claims, discovered entities, rumours,
 * prefix exclusions and an optional live producer) are ordered by
 * `(priority, inheritanceRank, seq)` and folded once in that order.
 *
 * Same-origin repetitions are merged before override handling so a rumour that
 * is retold by several informants keeps every source and co-witness while the
 * newest belief/acquisition wins.
 */

import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { decodePathKey, decodeValue, encodePathKey } from '@sekaisen/plugin-world'
import { valueOrRefEquals } from './internal.ts'
import type {
  ExclusionClaimRecord,
  ObservedClaimRecord,
  PerspectiveRecord,
  RumorClaimRecord,
} from './schemas.ts'
import { ALL_PERSPECTIVE_ID } from './schemas.ts'
import type { BeliefState, PerceptionSourceKind } from './types.ts'

/** Historical value resolution used by observed claims. */
export interface ResolvedHistoricalValue {
  readonly value: Value | StateRef
  readonly summary: Option<string>
}

/** Resolver callback for `StateRef` targets; `NONE` means the node is gone. */
export type HistoricalResolver = (ref: StateRef) => Option<ResolvedHistoricalValue>

/** Live direct/owned perception candidate injected by the scope engine. */
export interface LiveFacetInput {
  readonly kind: 'direct_scope' | 'self_owned'
  readonly value: Value | StateRef
  readonly summary: Option<string>
  readonly coWitnesses?: readonly string[]
}

/** One folded facet. */
export interface FoldFacet {
  readonly sourceKind: PerceptionSourceKind
  readonly priority: number
  readonly belief: BeliefState
  readonly source: Option<string>
  readonly sources: readonly string[]
  readonly coWitnesses: readonly string[]
  readonly at: Option<CommitHash>
  readonly acquiredAt: Option<CommitHash>
  readonly originEventRef: Option<StateRef>
  readonly targetRef: Option<StateRef>
  readonly factEventRef: Option<StateRef>
  readonly value: Value | StateRef
  readonly summary: Option<string>
  /** Canonical rumor payload bytes, present only for rumor facets. */
  readonly encodedValue?: Uint8Array
  /** Stable identifier of the winning record, for caches and corpus metadata. */
  readonly recordKey: string
}

/** Fold output. `primary` is the top surviving facet. */
export interface FoldResult {
  readonly facets: readonly FoldFacet[]
  readonly primary: Option<FoldFacet>
}

/** Claim targets split by the record table that asserts them. */
export interface ClaimPathTables {
  /** Whole-entity identities asserted by `discoveredEntities` records. */
  readonly structural: readonly Path[]
  /** Leaf (or exact-path) facts asserted by `observedClaims`/`rumorClaims`. */
  readonly fields: readonly Path[]
}

interface LiveItem {
  readonly kind: 'live'
  readonly priority: number
  readonly rank: number
  readonly seq: number
  readonly override: boolean
  readonly belief: BeliefState
  readonly facet: LiveFacetInput
}

interface ObservedItem {
  readonly kind: 'observed'
  readonly priority: number
  readonly rank: number
  readonly seq: number
  readonly override: boolean
  readonly belief: BeliefState
  readonly source: Option<string>
  readonly record: ObservedClaimRecord
  readonly discovered: boolean
}

interface RumorItem {
  readonly kind: 'rumor'
  readonly priority: number
  readonly rank: number
  readonly seq: number
  readonly override: boolean
  readonly belief: BeliefState
  readonly source: Option<string>
  readonly record: RumorClaimRecord
}

interface ExclusionItem {
  readonly kind: 'exclusion'
  readonly priority: number
  readonly rank: number
  readonly seq: number
  readonly record: ExclusionClaimRecord
}

type ClaimItem = LiveItem | ObservedItem | RumorItem | ExclusionItem

interface MutableFacet {
  sourceKind: PerceptionSourceKind
  priority: number
  belief: BeliefState
  source: Option<string>
  sources: string[]
  coWitnesses: string[]
  at: Option<CommitHash>
  acquiredAt: Option<CommitHash>
  originEventRef: Option<StateRef>
  targetRef: Option<StateRef>
  factEventRef: Option<StateRef>
  value: Value | StateRef
  summary: Option<string>
  encodedValue?: Uint8Array
  recordKey: string
}

/** Encoded key of the root path `[]`, which prefixes every folded path. */
const ROOT_PATH_KEY = encodePathKey([])

function compareItems(a: ClaimItem, b: ClaimItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  if (a.rank !== b.rank) return a.rank - b.rank
  if (a.seq !== b.seq) return a.seq - b.seq
  // Same coordinates only remain for defensive malformed data; keep the fold total.
  return a.kind.localeCompare(b.kind)
}

function stateRefEquals(a: StateRef, b: StateRef): boolean {
  return (
    a.commitId === b.commitId &&
    a.path.length === b.path.length &&
    a.path.every((segment, i) => segment === b.path[i])
  )
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value)
}

/**
 * Folding context for one observer at one fixed view.
 *
 * Instances are cheap: inheritance order and default priority are computed
 * lazily and then reused by every field projection in the same request.
 */
export class ClaimEvaluator {
  readonly perspectives: ReadonlyMap<string, PerspectiveRecord>
  readonly rootId: string
  private readonly resolve: HistoricalResolver
  private order: readonly string[] | null = null
  private rankById: ReadonlyMap<string, number> | null = null
  private rootPriority: number | null = null
  /** Derived target tables are immutable for this captured perspective snapshot. */
  private pathTables: ClaimPathTables | undefined
  private discoveredPaths: readonly Path[] | undefined
  /** Super-priority exclusion prefixes for this captured observer snapshot. */
  private liveExclusionPrefixes: readonly string[] | undefined

  constructor(
    perspectives: ReadonlyMap<string, PerspectiveRecord>,
    rootId: string,
    resolve: HistoricalResolver,
  ) {
    this.perspectives = perspectives
    this.rootId = rootId
    this.resolve = resolve
  }

  /** Parent chain of a perspective with the implicit `'all'` root applied. */
  private parentsOf(id: string): readonly string[] {
    const record = this.perspectives.get(id)
    const declared = record?.inherits ?? []
    if (id === ALL_PERSPECTIVE_ID) return []
    return declared.includes(ALL_PERSPECTIVE_ID) ? declared : [ALL_PERSPECTIVE_ID, ...declared]
  }

  private inheritance(): { order: readonly string[]; ranks: ReadonlyMap<string, number> } {
    if (this.order && this.rankById) return { order: this.order, ranks: this.rankById }
    const order: string[] = []
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      visited.add(id)
      for (const parent of this.parentsOf(id)) visit(parent)
      order.push(id)
    }
    visit(this.rootId)
    const ranks = new Map<string, number>()
    for (let index = 0; index < order.length; index++) ranks.set(order[index]!, index)
    this.order = Object.freeze(order)
    this.rankById = ranks
    return { order: this.order, ranks }
  }

  /** Ordered perspective ids, ancestors first and the root last. */
  orderedPerspectives(): readonly string[] {
    return this.inheritance().order
  }

  /** Default priority of the root perspective (`1000` when unmaterialized). */
  defaultPriority(): number {
    if (this.rootPriority !== null) return this.rootPriority
    this.rootPriority = this.perspectives.get(this.rootId)?.defaultPriority ?? 1000
    return this.rootPriority
  }

  /**
   * Whether cognitive exclusions permit realtime access to this exact path.
   *
   * Access and content arbitration are separate: an observation, discovery or
   * rumor may replace the live facet without changing sensory permission.
   * Conversely, no stronger content claim can undo an exclusion. Only matching
   * exclusions above the root's default priority deny live access; equal-priority
   * exclusions sort before the virtual live producer and allow reacquisition.
   * Geometry, field visibility and effective discovery must still be checked
   * by the caller. Semantic containment ancestors are checked separately from
   * these physical schema prefixes.
   *
   * @param path - Instance, edge or field whose live access is being checked.
   * @returns False when any inherited or personal super-exclusion covers it.
   */
  allowsLive(path: Path): boolean {
    if (this.liveExclusionPrefixes === undefined) {
      const prefixes = new Set<string>()
      const priority = this.defaultPriority()
      for (const id of this.inheritance().order) {
        const record = this.perspectives.get(id)
        if (record === undefined) continue
        for (const exclusion of record.exclusions.values())
          if (exclusion.priority > priority) prefixes.add(exclusion.targetPathKey)
      }
      this.liveExclusionPrefixes = Object.freeze([...prefixes])
    }
    if (this.liveExclusionPrefixes.length === 0) return true
    const key = encodePathKey(path)
    // Each prefix is a validated length-prefixed path key, so startsWith
    // matches whole segments (including []), never similarly named siblings.
    for (const prefix of this.liveExclusionPrefixes) if (key.startsWith(prefix)) return false
    return true
  }

  /** Live facet rank: strictly after every inherited perspective. */
  private liveRank(): number {
    return this.inheritance().order.length
  }

  private collectItems(path: Path, live: LiveFacetInput | undefined): readonly ClaimItem[] {
    const { order, ranks } = this.inheritance()
    const items: ClaimItem[] = []
    const pathKey = encodePathKey(path)
    // The root `[]` is a legal arbitrary path and encodes as the empty key; it
    // acts as a whole-tree prefix and must therefore match every folded path.
    const prefixKeys = new Set<string>([ROOT_PATH_KEY])
    for (let length = 1; length <= path.length; length++)
      prefixKeys.add(encodePathKey(path.slice(0, length)))

    for (const id of order) {
      const rank = ranks.get(id) ?? 0
      const record = this.perspectives.get(id)
      if (!record) continue
      for (const claim of record.observedClaims.values()) {
        if (!samePath(claim.targetRef.path, path)) continue
        items.push({
          kind: 'observed',
          priority: claim.priority,
          rank,
          seq: claim.seq,
          override: claim.override,
          belief: claim.belief,
          source: claim.source,
          record: claim,
          discovered: false,
        })
      }
      for (const claim of record.discoveredEntities.values()) {
        if (!samePath(claim.targetRef.path, path)) continue
        items.push({
          kind: 'observed',
          priority: claim.priority,
          rank,
          seq: claim.seq,
          override: claim.override,
          belief: claim.belief,
          source: claim.source,
          record: claim,
          discovered: true,
        })
      }
      for (const claim of record.rumorClaims.values()) {
        if (claim.targetPathKey !== pathKey) continue
        items.push({
          kind: 'rumor',
          priority: claim.priority,
          rank,
          seq: claim.seq,
          override: claim.override,
          belief: claim.belief,
          source: claim.source,
          record: claim,
        })
      }
      for (const exclusion of record.exclusions.values()) {
        if (!prefixKeys.has(exclusion.targetPathKey)) continue
        items.push({
          kind: 'exclusion',
          priority: exclusion.priority,
          rank,
          seq: exclusion.seq,
          record: exclusion,
        })
      }
    }
    if (live)
      items.push({
        kind: 'live',
        priority: this.defaultPriority(),
        rank: this.liveRank(),
        seq: 0,
        override: true,
        belief: 'believed',
        facet: live,
      })
    return items.sort(compareItems)
  }

  private materialize(item: Exclude<ClaimItem, ExclusionItem>): MutableFacet | undefined {
    if (item.kind === 'live') {
      return {
        sourceKind: item.facet.kind,
        priority: item.priority,
        belief: 'believed',
        source: NONE,
        sources: [],
        coWitnesses: [...(item.facet.coWitnesses ?? [])],
        at: NONE,
        acquiredAt: NONE,
        originEventRef: NONE,
        targetRef: NONE,
        factEventRef: NONE,
        value: item.facet.value,
        summary: item.facet.summary,
        recordKey: 'live',
      }
    }
    if (item.kind === 'rumor') {
      const source = item.record.source
      return {
        sourceKind: 'rumor_claim',
        priority: item.priority,
        belief: item.belief,
        source,
        sources: source.kind === 'some' ? [source.value] : [],
        coWitnesses: [...item.record.coWitnesses],
        at: some(item.record.factEventRef.commitId),
        acquiredAt: some(item.record.eventRef.commitId),
        originEventRef: some(item.record.originEventRef),
        targetRef: NONE,
        factEventRef: some(item.record.factEventRef),
        value: decodeValue(item.record.encodedValue),
        summary: item.record.rumorSummary,
        encodedValue: new Uint8Array(item.record.encodedValue),
        recordKey: item.record.key,
      }
    }
    const resolved = item.discovered ? NONE : this.resolve(item.record.targetRef)
    if (!item.discovered && resolved.kind === 'none') return undefined
    const source = item.record.source
    return {
      sourceKind: 'observed_claim',
      priority: item.priority,
      belief: item.belief,
      source,
      sources: source.kind === 'some' ? [source.value] : [],
      coWitnesses: [...item.record.coWitnesses],
      at: some(item.record.targetRef.commitId),
      acquiredAt: some(item.record.eventRef.commitId),
      originEventRef: some(item.record.originEventRef),
      targetRef: some(item.record.targetRef),
      factEventRef: NONE,
      value: resolved.kind === 'some' ? resolved.value.value : null,
      summary: resolved.kind === 'some' ? resolved.value.summary : NONE,
      recordKey: item.record.key,
    }
  }

  private foldItems(items: readonly ClaimItem[]): FoldResult {
    const facets: MutableFacet[] = []
    for (const item of items) {
      if (item.kind === 'exclusion') {
        for (let i = facets.length - 1; i >= 0; i--)
          if (facets[i]!.priority <= item.priority) facets.splice(i, 1)
        continue
      }
      const next = this.materialize(item)
      if (next === undefined) continue
      const mergedSources: string[] = []
      const mergedCoWitnesses: string[] = []
      const sameOrigin: MutableFacet[] = []
      const nextOrigin = next.originEventRef
      for (const facet of facets) {
        const existingOrigin = facet.originEventRef
        const same =
          facet.sourceKind !== 'direct_scope' &&
          facet.sourceKind !== 'self_owned' &&
          existingOrigin.kind === 'some' &&
          nextOrigin.kind === 'some' &&
          stateRefEquals(existingOrigin.value, nextOrigin.value) &&
          valueOrRefEquals(facet.value, next.value)
        if (!same) continue
        sameOrigin.push(facet)
        appendUnique(mergedSources, facet.sources)
        appendUnique(mergedCoWitnesses, facet.coWitnesses)
      }
      if (sameOrigin.length > 0) {
        appendUnique(mergedSources, next.sources)
        appendUnique(mergedCoWitnesses, next.coWitnesses)
        for (const facet of sameOrigin) {
          const index = facets.indexOf(facet)
          if (index >= 0) facets.splice(index, 1)
        }
        next.sources = mergedSources
        next.coWitnesses = mergedCoWitnesses
      }
      if (item.override)
        for (let i = facets.length - 1; i >= 0; i--)
          if (facets[i]!.priority <= item.priority) facets.splice(i, 1)
      facets.push(next)
    }
    const frozen = facets.map((facet) => Object.freeze({ ...facet }))
    return Object.freeze({
      facets: Object.freeze(frozen),
      primary: frozen.length > 0 ? some(frozen[frozen.length - 1]!) : NONE,
    })
  }

  /** Fold every inherited claim at `path`, optionally with a live producer. */
  fold(path: Path, live?: LiveFacetInput): FoldResult {
    return this.foldItems(this.collectItems(path, live))
  }

  /**
   * Fold a single perspective in isolation.
   *
   * Used by the sync idempotence check, which must ignore inherited
   * organisation/common knowledge and consider only the observer's own table.
   */
  foldPersonal(record: PerspectiveRecord, path: Path): FoldResult {
    const isolated = new Map<string, PerspectiveRecord>([[record.id, record]])
    const evaluator = new ClaimEvaluator(isolated, record.id, this.resolve)
    return evaluator.fold(path)
  }

  /**
   * Explicit claim-target tables split by what each record asserts.
   *
   * `discoveredEntities` records always name whole entities, never leaves, so
   * their `targetRef.path` is reported as a structural identity even after the
   * entity no longer exists. `observedClaims` and `rumorClaims` name leaf
   * facts (or, defensively, whatever exact path the record stores) and are
   * reported as field claims. The split is derived from the record tables
   * alone: current graph existence never promotes a record to another kind or
   * demotes it from the result.
   *
   * Malformed rumor keys are skipped because schema validators reject them at
   * write time and reads must stay total.
   *
   * @returns Deduplicated, path-key sorted structural and field target lists.
   */
  claimPaths(): ClaimPathTables {
    if (this.pathTables !== undefined) return this.pathTables
    const structural = new Map<string, Path>()
    const fields = new Map<string, Path>()
    for (const id of this.inheritance().order) {
      const record = this.perspectives.get(id)
      if (!record) continue
      for (const claim of record.discoveredEntities.values())
        structural.set(encodePathKey(claim.targetRef.path), claim.targetRef.path)
      for (const claim of record.observedClaims.values())
        fields.set(encodePathKey(claim.targetRef.path), claim.targetRef.path)
      for (const claim of record.rumorClaims.values()) {
        const path = decodePathKeyValue(claim.targetPathKey)
        if (path) fields.set(claim.targetPathKey, path)
      }
    }
    // A discovered entity identity is structural even if an old or relayed
    // record also wrote the same exact path as an observation. It must never be
    // enumerated as a leaf claim of its enclosing Map/Struct.
    for (const key of structural.keys()) fields.delete(key)
    this.pathTables = Object.freeze({
      structural: Object.freeze(
        [...structural.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]),
      ),
      fields: Object.freeze(
        [...fields.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]),
      ),
    })
    return this.pathTables
  }

  /**
   * Discovered entity identities whose discovery record survives folding.
   *
   * A discovery is effective only while a record from a `discoveredEntities`
   * table is still the winner of its path: inherited duplicates conclude for
   * the same identity, and an exclusion, a stronger override or a
   * `known_false` belief can veto it. The check deliberately folds without a
   * live producer, because present physical existence is never evidence of
   * discovery.
   *
   * @returns Deduplicated, discovery-authorized entity paths.
   */
  effectiveDiscoveredPaths(): readonly Path[] {
    if (this.discoveredPaths !== undefined) return this.discoveredPaths
    const candidates = new Map<string, { path: Path; keys: Set<string> }>()
    for (const id of this.inheritance().order) {
      const record = this.perspectives.get(id)
      if (!record) continue
      for (const claim of record.discoveredEntities.values()) {
        const key = encodePathKey(claim.targetRef.path)
        const candidate = candidates.get(key)
        if (candidate) candidate.keys.add(claim.key)
        else candidates.set(key, { path: claim.targetRef.path, keys: new Set([claim.key]) })
      }
    }
    const effective: Path[] = []
    for (const candidate of candidates.values()) {
      const surviving = this.fold(candidate.path).facets.some(
        (facet) =>
          facet.sourceKind === 'observed_claim' &&
          facet.belief !== 'known_false' &&
          candidate.keys.has(facet.recordKey),
      )
      if (surviving) effective.push(candidate.path)
    }
    this.discoveredPaths = Object.freeze(
      [...effective].sort((a, b) => encodePathKey(a).localeCompare(encodePathKey(b))),
    )
    return this.discoveredPaths
  }

  /** Highest-priority exact claim record for `path` in one perspective. */
  personalObservedTop(record: PerspectiveRecord, path: Path): Option<ObservedClaimRecord> {
    const result = this.foldPersonal(record, path)
    if (result.primary.kind === 'none') return NONE
    const primary = result.primary.value
    if (primary.sourceKind !== 'observed_claim') return NONE
    const found = [...record.observedClaims.values()].find(
      (claim) => claim.key === primary.recordKey,
    )
    return found ? some(found) : NONE
  }
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i])
}

function decodePathKeyValue(key: string): Path | undefined {
  try {
    return decodePathKey(key)
  } catch {
    return undefined
  }
}

/**
 * Structural direct-observation predicate.
 *
 * True only for a record born in this mind's own tables with no informant
 * source. Retold records always carry `source` (unless a false flag explicitly
 * sets one), so hearing Bob's story can never suppress the observer's own
 * later direct sighting.
 */
export function isDirectPersonalObservation(mindId: string, record: ObservedClaimRecord): boolean {
  return (
    record.originEventRef.path[0] === 'perspectives' &&
    record.originEventRef.path[1] === mindId &&
    record.source.kind === 'none'
  )
}
