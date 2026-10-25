/**
 * Canonical perspective schemas.
 *
 * The whole epistemic model lives in one registered Map root,
 * `['perspectives']`, so common knowledge (`'all'`), organisations and
 * individual minds share exactly one storage and inheritance mechanism.
 *
 * Three independent time coordinates are kept per claim:
 * 1. `targetRef` / `factEventRef`: when the underlying fact or rumor was true;
 * 2. `eventRef`: when this observer acquired the information;
 * 3. `originEventRef`: where the account originally started (for same-origin
 *    repetition merging and false-flag detection).
 */

import type { Option } from '@sekaisen/core'
import { s } from '@sekaisen/plugin-schema'
import type { Path, StateRef } from '@sekaisen/plugin-world'
import type { BeliefState } from './types.ts'

/** Registered root path of the unified perspective table. */
export const PERSPECTIVES_ROOT: Path = Object.freeze(['perspectives'])

/** Canonical id of the shared common-sense perspective. */
export const ALL_PERSPECTIVE_ID = 'all'

/** Default priority for newly materialized perspectives. */
export const DEFAULT_PERSPECTIVE_PRIORITY = 1000

/** Rank order of cognitive memory levels; `L0 < L1 < L2`. */
export const MEMORY_LEVEL_RANK: Readonly<Record<MemoryLevel, number>> = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
})

/** Memory summarisation levels. */
export type MemoryLevel = 'L0' | 'L1' | 'L2'

/** Provenance class of a cognitive memory record. */
export type MemoryEventOrigin = 'scene' | 'world' | 'reflection' | 'carry_over'

/** Dramatic significance of a memory. */
export type MemorySignificance = 'routine' | 'notable' | 'critical'

/** Retention tier of a memory. */
export type MemoryTier = 'pinned' | 'active' | 'archive'

/** All legal memory levels in ascending rank order. */
export const MEMORY_LEVELS: readonly MemoryLevel[] = Object.freeze(['L0', 'L1', 'L2'])

/** All legal memory event origins. */
export const MEMORY_EVENT_ORIGINS: readonly MemoryEventOrigin[] = Object.freeze([
  'scene',
  'world',
  'reflection',
  'carry_over',
])

/** All legal memory significance values. */
export const MEMORY_SIGNIFICANCES: readonly MemorySignificance[] = Object.freeze([
  'routine',
  'notable',
  'critical',
])

/** All legal memory retention tiers. */
export const MEMORY_TIERS: readonly MemoryTier[] = Object.freeze(['pinned', 'active', 'archive'])

/** Rank of a memory level; unknown levels sort below `L0` for defensive reads. */
export function memoryLevelRank(level: string): number {
  return MEMORY_LEVEL_RANK[level as MemoryLevel] ?? 0
}

/**
 * Historical entity association stored as a true cross-commit reference.
 *
 * Using `s.ref()` keeps the exact `(commitId, entityPath)` coordinate of the
 * entity at the remembered moment, including entities from other branches,
 * and participates in World pin protection and rebase remapping.
 */
export const MemoryRelatedEntitySchema = s.struct({
  /** Historical entity snapshot coordinate (`$message` targets are rejected). */
  targetRef: s.ref().desc('historical entity snapshot reference (commitId, entityPath)'),
  /** Semantic relation of the entity to this memory. */
  role: s.str().default('participant').desc('semantic relation of the entity to this memory'),
})

/**
 * Observer-private cognitive memory node.
 *
 * Memories are subjective narratives. Projection never replaces `content`
 * with an objective event/snapshot payload, and filtering or overriding the
 * supporting claims never mutates an assembled narrative.
 */
export const CognitiveMemorySchema = s.struct({
  /** Owning root perspective id; must equal the `P` path segment. */
  ownerPerspectiveId: s.str().desc('owning root perspective id (must match path segment P)'),
  /** Monotonic positive sequence in this perspective, sourced from `nextSeq`. */
  seq: s.num().desc('monotonic positive integer sequence in this perspective'),
  /** Summarisation level: `L0` (0) < `L1` (1) < `L2` (2). */
  level: s.str().default('L0').desc('L0 | L1 | L2'),
  /** Provenance class of this record. */
  eventOrigin: s.str().default('scene').desc('scene | world | reflection | carry_over'),
  /** Dramatic significance. */
  significance: s.str().default('routine').desc('routine | notable | critical'),
  /** Retention tier. */
  tier: s.str().default('active').desc('pinned | active | archive'),
  /** Finite non-negative retention strength. */
  strength: s.num().default(1).desc('non-negative memory retention strength'),
  /** Acceptance state. */
  belief: s.str().default('believed').desc('believed | suspected | known_false'),
  /** Finite priority weight, defaulted from the owning perspective. */
  priority: s.num().desc('finite priority weight'),
  /** Optional objective start time in minutes. */
  startTime: s.num().optional().desc('optional historical objective start time in minutes'),
  /** Optional objective end time in minutes; must not precede `startTime`. */
  endTime: s.num().optional().desc('optional historical objective end time in minutes'),
  /** Subjective narrative. Never replaced by objective evidence. */
  content: s.str().desc('subjective memory narrative text'),
  /** Historical event message reference. */
  factEventRef: s.ref().desc('historical commit message reference of the event'),
  /** Historical state-tree snapshot reference (never `$message`). */
  factSnapshotRef: s.ref().desc('historical state tree snapshot reference'),
  /** Acquisition event reference in the current line. */
  acquiredAtRef: s.ref().desc('event reference when this memory was acquired or carried over'),
  /** Independent origin record; preserved across carry-over for provenance. */
  originRef: s.ref().desc('origin memory or event reference'),
  /** Supporting claim keys in this perspective; evidence does not rewrite content. */
  supportingClaimKeys: s
    .list('str')
    .default([])
    .desc('optional supporting claim keys within the same perspective'),
  /**
   * Lower-level memories subsumed by this summary.
   *
   * Targets stay inside the same perspective, must satisfy strict level and
   * sequence progression, and form a globally acyclic graph. Deleting a parent
   * only unlinks children.
   */
  children: s
    .linkList({
      targetRoots: [PERSPECTIVES_ROOT],
      acyclic: true,
      onDelete: 'unlink',
    })
    .default([])
    .meta({ visibility: 'surface', linkRoles: ['subsumes'] })
    .desc('subsumed lower-level cognitive memory paths within the same perspective'),
  /** Cross-commit associated entities keyed by relation slot id. */
  relatedEntities: s
    .map(MemoryRelatedEntitySchema)
    .desc('related historical entity references keyed by relation slot id'),
})

/**
 * Historical observation snapshot.
 *
 * The record key in the owning Map is
 * `${encodePathKey(targetRef.path)}#${seq}` so exact-path lookups never need a
 * full scan at read time.
 */
export const ObservedClaimSchema = s.struct({
  /** Monotonic per-perspective write sequence; folded as the final tie-breaker. */
  seq: s.num().desc('monotonic assertion write sequence in this perspective'),
  /** Fact snapshot; the projection reads only `targetRef.commitId`. */
  targetRef: s.ref().desc('historical snapshot of the observed fact (fact time)'),
  /** Acquisition event; normally `(commit, ['$message'])`. */
  eventRef: s.ref().desc('event when this observer acquired the information'),
  /** Independent origin record; preserved across retellings unless the chain is broken. */
  originEventRef: s.ref().desc('independent origin record of this account'),
  /** Fold priority. */
  priority: s.num().desc('effective priority used by deterministic folding'),
  /** Whether this account overrides lower/equal priority facets. */
  override: s.bool().default(true).desc('override lower-priority facets when true'),
  /** Acceptance state. */
  belief: s.str().default('believed').desc('believed | suspected | known_false'),
  /** Direct source label, absent for direct personal observation. */
  source: s.str().optional().desc('direct informant label'),
  /** Public body path keys witnessing the same sight/sound content. */
  coWitnesses: s.list('str').default([]).desc('public co-witness body path keys'),
})

/** Literal rumor/hallucination snapshot with a lossless `Value` payload. */
export const RumorClaimSchema = s.struct({
  /** Monotonic per-perspective write sequence. */
  seq: s.num().desc('monotonic assertion write sequence in this perspective'),
  /** Encoded target path key (`encodePathKey(targetPath)`). */
  targetPathKey: s.str().desc('encoded path the rumor talks about'),
  /** Event when the rumor was first claimed/created (projection `at`). */
  factEventRef: s.ref().desc('event when the rumor was first claimed'),
  /** Event when the current observer heard it (projection `acquiredAt`). */
  eventRef: s.ref().desc('event when the current observer heard the rumor'),
  /** Independent origin of the rumor account. */
  originEventRef: s.ref().desc('independent origin record of the rumor'),
  /** Lossless plugin-world binary `Value` encoding. */
  encodedValue: s.bytes().desc('binary-encoded rumor Value'),
  /** Optional micro-summary of the rumor. */
  rumorSummary: s.str().optional().desc('optional rumor summary'),
  /** Fold priority. */
  priority: s.num().desc('effective priority used by deterministic folding'),
  /** Rumor overrides only when explicitly requested. */
  override: s.bool().default(false).desc('override lower-priority facets when true'),
  /** Acceptance state; rumors default to `'suspected'`. */
  belief: s.str().default('suspected').desc('believed | suspected | known_false'),
  /** Direct rumor source label. */
  source: s.str().optional().desc('direct rumor source label'),
  /** Public body path keys that heard the same rumor. */
  coWitnesses: s.list('str').default([]).desc('public co-witness body path keys'),
})

/** Explicit suppression of claims under a path prefix. */
export const ExclusionClaimSchema = s.struct({
  /** Monotonic per-perspective write sequence. */
  seq: s.num().desc('monotonic assertion write sequence in this perspective'),
  /** Encoded prefix; suppresses the path and all descendants. */
  targetPathKey: s.str().desc('encoded suppressed path prefix'),
  /** Event of the suppression (for example witnessing an entity's destruction). */
  eventRef: s.ref().desc('event when the exclusion happened'),
  /** Facets with priority `<= priority` are removed. */
  priority: s.num().desc('suppression weight'),
})

/**
 * Unified perspective node.
 *
 * `hostEntity` is an optional link with the explicit
 * `dynamicTargetRoots: true` opt-in: static `targetRoots` stay non-empty while
 * commits additionally accept a live Struct under any currently registered
 * Reader root. `onDelete: 'cascade'` lets the schema delete a mind when its
 * physical host disappears.
 */
export const PerspectiveNodeSchema = s.struct({
  /** Human-readable description. */
  description: s.str().default('').desc('perspective description'),
  /** Default priority of live and newly written claims for this mind. */
  defaultPriority: s.num().default(DEFAULT_PERSPECTIVE_PRIORITY).desc('default claim priority'),
  /** Optional host entity; cascade-deletes this perspective when the host is deleted. */
  hostEntity: s
    .link({
      targetRoots: [[...PERSPECTIVES_ROOT]],
      dynamicTargetRoots: true,
      onDelete: 'cascade',
    })
    .optional()
    .desc('optional host entity of this mind'),
  /** Parent perspectives ordered from lowest to highest priority. */
  inherits: s
    .linkList({
      targetRoots: [[...PERSPECTIVES_ROOT]],
      acyclic: true,
      onDelete: 'unlink',
    })
    .default([])
    .desc('inherited perspective ids, lowest to highest priority'),
  /** Monotonic claim sequence counter. */
  nextSeq: s.num().default(1).desc('monotonic claim sequence counter'),
  /** Discovered secret (`visibility: 'ref'`) instances keyed by entity path key. */
  discoveredEntities: s.map(ObservedClaimSchema).desc('discovered secret instances'),
  /** Historical observation claims keyed by `${targetPathKey}#${seq}`. */
  observedClaims: s.map(ObservedClaimSchema).desc('historical observation claims'),
  /** Rumor claims keyed by `${targetPathKey}#${seq}`. */
  rumorClaims: s.map(RumorClaimSchema).desc('literal rumor claims'),
  /** Exclusions keyed by `${targetPrefixKey}#${seq}`. */
  exclusions: s.map(ExclusionClaimSchema).desc('path-prefix exclusions'),
  /** Observer-private cognitive memories keyed by memoryId. */
  memories: s.map(CognitiveMemorySchema).desc('cognitive memory nodes keyed by memory id'),
})

/** In-memory observation record read from the perspective Map. */
export interface ObservedClaimRecord {
  /** Map record key (`${pathKey}#${seq}` for fields, entity key for discovery). */
  readonly key: string
  /** Monotonic per-perspective write sequence; final fold tie-breaker. */
  readonly seq: number
  /** Historical fact snapshot read by projections (fact time). */
  readonly targetRef: StateRef
  /** Event when this perspective acquired the information. */
  readonly eventRef: StateRef
  /** Independent origin record preserved across retellings. */
  readonly originEventRef: StateRef
  /** Effective fold priority. */
  readonly priority: number
  /** Whether equal/lower-priority facets are replaced. */
  readonly override: boolean
  /** Acceptance state. */
  readonly belief: BeliefState
  /** Direct informant label, absent for personal observation. */
  readonly source: Option<string>
  /** Public co-witness body path keys. */
  readonly coWitnesses: readonly string[]
}

/** In-memory rumor record read from the perspective Map. */
export interface RumorClaimRecord {
  /** Map record key (`${pathKey}#${seq}`). */
  readonly key: string
  /** Monotonic per-perspective write sequence. */
  readonly seq: number
  /** Encoded path the rumor talks about. */
  readonly targetPathKey: string
  /** Event when the rumor was first claimed (fact time for projections). */
  readonly factEventRef: StateRef
  /** Event when this perspective heard the rumor (acquisition time). */
  readonly eventRef: StateRef
  /** Independent origin record preserved across retellings. */
  readonly originEventRef: StateRef
  /** Canonical binary encoding of the rumor payload. */
  readonly encodedValue: Uint8Array
  /** Optional micro-summary of the rumor. */
  readonly rumorSummary: Option<string>
  /** Effective fold priority. */
  readonly priority: number
  /** Whether equal/lower-priority facets are replaced. */
  readonly override: boolean
  /** Acceptance state (defaults to suspected). */
  readonly belief: BeliefState
  /** Direct rumor source label. */
  readonly source: Option<string>
  /** Public co-witness body path keys. */
  readonly coWitnesses: readonly string[]
}

/** In-memory exclusion record read from the perspective Map. */
export interface ExclusionClaimRecord {
  /** Map record key (`${prefixKey}#${seq}`). */
  readonly key: string
  /** Monotonic per-perspective write sequence. */
  readonly seq: number
  /** Encoded suppressed path prefix. */
  readonly targetPathKey: string
  /** Event of the suppression. */
  readonly eventRef: StateRef
  /** Facets with priority `<= priority` are removed. */
  readonly priority: number
}

/** Decoded association between a memory and a historical entity snapshot. */
export interface CognitiveMemoryRelatedEntityRecord {
  /** Relation slot key from the stored `relatedEntities` Map. */
  readonly slot: string
  /** Historical entity coordinate. */
  readonly targetRef: StateRef
  /** Semantic relation role. */
  readonly role: string
}

/** In-memory cognitive memory record read from the perspective Map. */
export interface CognitiveMemoryRecord {
  /** Map key (`memoryId`). */
  readonly memoryId: string
  /** Full instance path `['perspectives', P, 'memories', memoryId]`. */
  readonly path: Path
  /** Root perspective id; must equal `P`. */
  readonly ownerPerspectiveId: string
  /** Monotonic positive sequence. */
  readonly seq: number
  /** Summarisation level. */
  readonly level: MemoryLevel
  /** Provenance class. */
  readonly eventOrigin: MemoryEventOrigin
  /** Dramatic significance. */
  readonly significance: MemorySignificance
  /** Retention tier. */
  readonly tier: MemoryTier
  /** Finite non-negative retention strength. */
  readonly strength: number
  /** Acceptance state. */
  readonly belief: BeliefState
  /** Finite priority weight. */
  readonly priority: number
  /** Optional objective start time. */
  readonly startTime: Option<number>
  /** Optional objective end time. */
  readonly endTime: Option<number>
  /** Subjective narrative. */
  readonly content: string
  /** Optional `$meta.summary` of the content leaf. */
  readonly summary: Option<string>
  /** Historical event message reference. */
  readonly factEventRef: StateRef
  /** Historical state-tree snapshot reference. */
  readonly factSnapshotRef: StateRef
  /** Acquisition event reference. */
  readonly acquiredAtRef: StateRef
  /** Independent origin record. */
  readonly originRef: StateRef
  /** Supporting claim keys in the same perspective. */
  readonly supportingClaimKeys: readonly string[]
  /** Decoded subsumed memory paths. */
  readonly children: readonly Path[]
  /** Related historical entity snapshots sorted by relation slot. */
  readonly relatedEntities: readonly CognitiveMemoryRelatedEntityRecord[]
}

/** Claim-data view of one perspective node with defaults already applied. */
export interface PerspectiveRecord {
  /** Perspective id (named id or encoded root entity path). */
  readonly id: string
  /** Human-readable description. */
  readonly description: string
  /** Default priority for live perception and newly written claims. */
  readonly defaultPriority: number
  /** Host entity path decoded from the host link, when present. */
  readonly hostEntity: Option<Path>
  /** Parent perspective ids, lowest to highest priority. */
  readonly inherits: readonly string[]
  /** Next claim sequence to allocate. */
  readonly nextSeq: number
  /** Discovered secret instances keyed by entity path key. */
  readonly discoveredEntities: ReadonlyMap<string, ObservedClaimRecord>
  /** Historical observation claims by map key. */
  readonly observedClaims: ReadonlyMap<string, ObservedClaimRecord>
  /** Literal rumor claims by map key. */
  readonly rumorClaims: ReadonlyMap<string, RumorClaimRecord>
  /** Prefix exclusions by map key. */
  readonly exclusions: ReadonlyMap<string, ExclusionClaimRecord>
  /** Cognitive memories keyed by memory id. */
  readonly memories: ReadonlyMap<string, CognitiveMemoryRecord>
}

/** Claim record input accepted by schema transaction writes. */
export interface ObservedClaimInput {
  /** Monotonic per-perspective write sequence. */
  readonly seq: number
  /** Historical fact snapshot. */
  readonly targetRef: StateRef
  /** Acquisition event. */
  readonly eventRef: StateRef
  /** Independent origin record. */
  readonly originEventRef: StateRef
  /** Effective fold priority. */
  readonly priority: number
  /** Whether lower/equal priority facets are replaced. */
  readonly override: boolean
  /** Acceptance state. */
  readonly belief: BeliefState
  /** Optional direct informant label. */
  readonly source?: string
  /** Public co-witness body path keys. */
  readonly coWitnesses: readonly string[]
}

/** Rumor claim input accepted by schema transaction writes. */
export interface RumorClaimInput {
  /** Monotonic per-perspective write sequence. */
  readonly seq: number
  /** Encoded target path key. */
  readonly targetPathKey: string
  /** Event when the rumor was first claimed. */
  readonly factEventRef: StateRef
  /** Hearing event. */
  readonly eventRef: StateRef
  /** Independent origin record. */
  readonly originEventRef: StateRef
  /** Canonical binary rumor payload. */
  readonly encodedValue: Uint8Array
  /** Optional rumor micro-summary. */
  readonly rumorSummary?: string
  /** Effective fold priority. */
  readonly priority: number
  /** Whether lower/equal priority facets are replaced. */
  readonly override: boolean
  /** Acceptance state. */
  readonly belief: BeliefState
  /** Optional direct source label. */
  readonly source?: string
  /** Public co-witness body path keys. */
  readonly coWitnesses: readonly string[]
}

/** Exclusion input accepted by schema transaction writes. */
export interface ExclusionClaimInput {
  /** Monotonic per-perspective write sequence. */
  readonly seq: number
  /** Encoded suppressed path prefix. */
  readonly targetPathKey: string
  /** Event of the suppression. */
  readonly eventRef: StateRef
  /** Facets with priority `<= priority` are removed. */
  readonly priority: number
}

/** Default (empty) perspective payload used when lazily materializing a mind. */
export interface PerspectiveInput {
  readonly description?: string
  readonly defaultPriority?: number
  readonly hostEntity?: string
  readonly inherits?: readonly string[]
  readonly nextSeq?: number
  readonly discoveredEntities?: Readonly<Record<string, ObservedClaimInput>>
  readonly observedClaims?: Readonly<Record<string, ObservedClaimInput>>
  readonly rumorClaims?: Readonly<Record<string, RumorClaimInput>>
  readonly exclusions?: Readonly<Record<string, ExclusionClaimInput>>
  readonly memories?: Readonly<Record<string, CognitiveMemoryInput>>
}

/** Related-entity input accepted by cognitive memory writes. */
export interface CognitiveMemoryRelatedEntityInput {
  /** Historical entity snapshot coordinate. */
  readonly targetRef: StateRef
  /** Optional semantic role; defaults to `'participant'`. */
  readonly role?: string
}

/** Cognitive memory input accepted by schema transaction writes. */
export interface CognitiveMemoryInput {
  /** Owning root perspective id; must match the containing Map path. */
  readonly ownerPerspectiveId: string
  /** Monotonic positive sequence. */
  readonly seq: number
  /** Summarisation level; defaults to `L0` in the schema. */
  readonly level: MemoryLevel
  /** Provenance class; defaults to `scene` in the schema. */
  readonly eventOrigin: MemoryEventOrigin
  /** Dramatic significance; defaults to `routine` in the schema. */
  readonly significance: MemorySignificance
  /** Retention tier; defaults to `active` in the schema. */
  readonly tier: MemoryTier
  /** Finite non-negative retention strength. */
  readonly strength: number
  /** Acceptance state. */
  readonly belief: BeliefState
  /** Finite priority weight. */
  readonly priority: number
  /** Optional objective start time. */
  readonly startTime?: number
  /** Optional objective end time. */
  readonly endTime?: number
  /** Subjective narrative. */
  readonly content: string
  /** Historical event message reference. */
  readonly factEventRef: StateRef
  /** Historical state-tree snapshot reference. */
  readonly factSnapshotRef: StateRef
  /** Acquisition event reference. */
  readonly acquiredAtRef: StateRef
  /** Independent origin record. */
  readonly originRef: StateRef
  /** Supporting claim keys in the same perspective. */
  readonly supportingClaimKeys: readonly string[]
  /** Encoded subsumed memory path keys. */
  readonly children: readonly string[]
  /** Related historical entities keyed by relation slot. */
  readonly relatedEntities: Readonly<Record<string, CognitiveMemoryRelatedEntityInput>>
}
