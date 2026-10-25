/**
 * Public perspective service types: projections, claims, options, errors and
 * the Cordis service contract.
 *
 * All values follow the monorepo conventions: expected failures are returned as
 * `Result`, absence is an explicit `Option`, and reads never mutate state.
 */

import type { Option, Result } from '@sekaisen/core'
import type {
  AnyReadableLens,
  HistoricalNodeInspection,
  ReadonlySchemaView,
  SchemaError,
  SchemaTransaction,
  StructLens,
} from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import type { FoldFacet } from './claims.ts'
import type { MemoryEventOrigin, MemoryLevel, MemorySignificance, MemoryTier } from './schemas.ts'
import type { Visibility } from './visibility.ts'

/** How strongly an observer accepts a claim. */
export type BeliefState = 'believed' | 'suspected' | 'known_false'

/** Provenance of a projected field facet. */
export type PerceptionSourceKind =
  /** Live direct perception in the current commit (fact and acquisition time are NONE). */
  | 'direct_scope'
  /** Live ownership perception of self/controlled instances (fact and acquisition time are NONE). */
  | 'self_owned'
  /** Historical observation claim; reads the recorded fact commit only. */
  | 'observed_claim'
  /** Literal rumor/hallucination claim; reads only the encoded rumor value. */
  | 'rumor_claim'

/**
 * Observer selector.
 *
 * - `StructLens` or `Path`: an entity instance path. Delegation is followed to
 *   the root body and the canonical perspective id is
 *   `encodePathKey(rootEntityPath)`.
 * - `string`: a named perspective id such as `'all'` or `'org:church'`.
 */
export type ObserverRef = StructLens | Path | string

/** A single resolved facet of a field, before or after folding. */
export interface ProjectedFieldFacet {
  /** Full value, or a state reference when the source value is a reference. Omitted in folded fields. */
  readonly value?: Value | StateRef
  /** Optional micro-summary; when present a routine projection folds the field by default. */
  readonly summary: Option<string>
  /** True when the field was folded because a summary exists. */
  readonly folded: boolean
  /** Provenance of this facet. */
  readonly sourceKind: PerceptionSourceKind
  /**
   * Fact-time anchor:
   * - live facets: `NONE`
   * - observed claims: the recorded target commit
   * - rumor claims: the rumor's `factEventRef` commit
   */
  readonly at: Option<CommitHash>
  /**
   * Acquisition-time anchor:
   * - live facets: `NONE`
   * - observed/rumor claims: the observer's `eventRef` commit
   */
  readonly acquiredAt: Option<CommitHash>
  /** Acceptance state recorded by the winning claim (live facets are `'believed'`). */
  readonly belief: BeliefState
  /** Direct source label of the winning facet, when any. */
  readonly source: Option<string>
  /** Merged source labels from same-origin repetitions, in first-seen order. */
  readonly sources: readonly string[]
  /** Public body path keys of same-channel co-witnesses (never delegated root mind ids). */
  readonly coWitnesses: readonly string[]
  /**
   * Monotonic subjective sequence exposed to callers.
   *
   * Persisted claims/memories use their stored positive `seq`; live perception
   * uses the observer's current `perspective.nextSeq`. The internal fold
   * sentinel `0` is never exposed.
   */
  readonly seq: number
}

/** A projected field plus any coexisting non-overriding facets. */
export interface ProjectedFieldView extends ProjectedFieldFacet {
  /** Additional different-origin facets that coexist with the primary facet. */
  readonly additionalFacets: readonly ProjectedFieldFacet[]
}

/** A safe instance projection. */
export interface ProjectedInstanceView {
  /** Full instance path. */
  readonly path: Path
  /** Own declared fields by any legal Schema name, including `__proto__`. */
  readonly fields: Readonly<Record<string, ProjectedFieldView>>
  /** Own custom fields by any legal key; names survive JSON serialization. */
  readonly customFields: Readonly<Record<string, ProjectedFieldView>>
}

/**
 * Schema descriptions keyed by encoded instance path. Field-name dictionaries
 * preserve every legal Schema identifier as an own, serializable property.
 */
export type ProjectedSchemaDictionary = Readonly<
  Record<
    string,
    {
      readonly description: string
      readonly fields: Readonly<Record<string, { readonly description: string }>>
    }
  >
>

/**
 * Byte-identical standard public surface, safe for a shared prompt prefix.
 *
 * Only emitted when the observer's sight and sound are both enabled, their
 * ceilings coincide and no super-priority exclusion or hallucination diverges
 * from the raw double-channel public surface.
 */
export interface ScenePublicProjection {
  /** Ceiling container used as the public scene root. */
  readonly sceneRootPath: Path
  /** Schema descriptions for every projected instance (encoded path keyed). */
  readonly schemas: ProjectedSchemaDictionary
  /** Public instance views (encoded path keyed). */
  readonly instances: Readonly<Record<string, ProjectedInstanceView>>
}

/** Observer-private and off-scene historical knowledge. */
export interface ObserverPrivateProjection {
  /** Canonical root perspective id. */
  readonly rootPerspectiveId: string
  readonly schemas: ProjectedSchemaDictionary
  /** Owned instances and their `'self'` fields, read live from the current commit. */
  readonly selfInstances: Readonly<Record<string, ProjectedInstanceView>>
  /**
   * In-scene private/extra/override fields. When `scenePublic` is `NONE` this
   * contains the complete safe in-scene view after channel, exclusion and
   * hallucination filtering.
   */
  readonly inScenePrivateOverrides: Readonly<Record<string, ProjectedInstanceView>>
  /** Off-scene observed/rumor knowledge; never reads the current objective value. */
  readonly offSceneKnownInstances: Readonly<Record<string, ProjectedInstanceView>>
}

/** Complete projection handed to a character agent. */
export interface AgentWorldProjection {
  readonly rootPerspectiveId: string
  /** Safe public prefix, or `NONE` when any divergence exists. */
  readonly scenePublic: Option<ScenePublicProjection>
  readonly privateView: ObserverPrivateProjection
  /** Merged visible instances after every visibility filter. */
  readonly schemas: ProjectedSchemaDictionary
  readonly mergedInstances: Readonly<Record<string, ProjectedInstanceView>>
}

/** Fully expanded field inspection. */
export interface InspectedFieldView {
  readonly path: Path
  readonly description: string
  /** Complete subjective value; never the hidden objective value. */
  readonly value: Value | StateRef
  readonly summary: Option<string>
  readonly sourceKind: PerceptionSourceKind
  readonly at: Option<CommitHash>
  readonly acquiredAt: Option<CommitHash>
  readonly belief: BeliefState
  readonly source: Option<string>
  readonly sources: readonly string[]
  readonly coWitnesses: readonly string[]
  /** Monotonic subjective sequence; never the internal fold sentinel `0`. */
  readonly seq: number
  readonly additionalFacets: readonly ProjectedFieldFacet[]
}

/** Subjective-vs-objective comparison exposed only to the adjudicating host. */
export interface AdjudicatedPathResult {
  readonly path: Path
  /** Whether the observer may legally know this path. */
  readonly authorized: boolean
  /** What the observer sees, when authorized. */
  readonly subjective: Option<InspectedFieldView>
  /** Writer-faithful objective inspection at the current commit. */
  readonly objective: Option<HistoricalNodeInspection>
  /** Whether the primary subjective value still equals current objective truth. */
  readonly matchesObjectiveTruth: boolean
}

/** Associated entity resolved for a retrieval corpus entry. */
export interface LinkedEntity {
  /** Exact state reference of the entity at its fact time. */
  readonly ref: StateRef
  /** Current branch path when the entity also physically survives there. */
  readonly currentPath: Option<Path>
  /** Provenance class of the association. */
  readonly relation: 'current_link' | 'historical_link' | 'ref_target' | 'memory_entity'
  /** Optional memory relation role or link field role. */
  readonly role?: string
}

/** Pre-filtered memory/RAG corpus entry for one observer. */
export interface SearchableCorpusEntry {
  readonly path: Path
  /** Fact snapshot or rumor-creation commit (fact time). */
  readonly factCommitId: CommitHash
  /** Acquisition event commit; current commit for live perception. */
  readonly acquiredAtCommitId: CommitHash
  /** SHA-256 hex digest of `(text, summary)` for embedding-cache keys. */
  readonly contentHash: string
  readonly text: string
  readonly summary: Option<string>
  readonly sourceKind: PerceptionSourceKind
  /** Effective priority of the winning facet. */
  readonly priority: number
  readonly belief: BeliefState
  /** Whether routine projection folds this entry (summary or subsumption). */
  readonly isFoldedInDefaultView: boolean
  /**
   * Monotonic subjective sequence exposed to callers.
   *
   * Persisted claims/memories use their stored positive `seq`; live perception
   * uses the observer's current `perspective.nextSeq`.
   */
  readonly seq: number
  /** One-hop link targets also visible to this observer. */
  readonly linkedInstancePaths: readonly Path[]
  /** Canonical associated-entity set, including historical snapshot coordinates. */
  readonly linkedEntities: readonly LinkedEntity[]
}

/**
 * Read-only capability locked to one commit and an owned immutable observer
 * identity. Mutating the original input path cannot retarget any method;
 * delegated bodies retain their own location and sensory domain.
 */
export interface ScopedObserverPerspective {
  readonly commitId: CommitHash
  readonly rootPerspectiveId: string
  projectView(): Result<AgentWorldProjection, PerspectiveError>
  inspect(targetPaths: readonly Path[]): Result<readonly InspectedFieldView[], PerspectiveError>
  listSearchableCorpus(): Result<readonly SearchableCorpusEntry[], PerspectiveError>
}

/** Expected perspective-layer failures. */
export type PerspectiveError =
  | { readonly kind: 'observer_entity_not_found'; readonly observer: string }
  | {
      readonly kind: 'delegate_root_mismatch'
      readonly fromPath: Path
      readonly toPath: Path
      readonly fromRoot: string
      readonly toRoot: string
    }
  | {
      readonly kind: 'topology_violation'
      readonly path: Path
      readonly reason:
        | 'multiple_parent_links'
        | 'multiple_delegate_links'
        | 'cyclic_role_graph'
        | 'invalid_edge_endpoints'
        | 'root_perspective_cannot_inherit'
      readonly detail: string
    }
  | {
      readonly kind: 'not_authorized'
      readonly rootPerspectiveId: string
      readonly targetPath: Path
    }
  | {
      readonly kind: 'invalid_claim_target'
      readonly targetPath: Path
      readonly reason: string
    }
  | {
      readonly kind: 'invalid_memory_target'
      readonly memoryPath: Path
      readonly reason: string
    }
  | {
      readonly kind: 'memory_not_found'
      readonly rootPerspectiveId: string
      readonly memoryId: string
    }
  | {
      readonly kind: 'memory_conflict'
      readonly memoryPath: Path
      readonly detail: string
    }
  | {
      readonly kind: 'carry_over_source_unavailable'
      readonly sourceCommitId: CommitHash
      readonly detail: string
    }
  | { readonly kind: 'schema_error'; readonly error: SchemaError }

/** Optional configuration for `configurePerspective`. */
export interface ConfigurePerspectiveInput {
  /** Replacement description; omission preserves the existing value. */
  readonly description?: string
  /** Replacement default priority; omission preserves the existing value. */
  readonly defaultPriority?: number
  /**
   * Parents ordered from lowest to highest priority. Omission preserves the
   * current list, including on description/priority-only updates; an explicit
   * `[]` clears it. The root `'all'` must remain empty.
   */
  readonly inherits?: readonly ObserverRef[]
}

/** Options for `grantKnowledge`. */
export interface GrantKnowledgeOptions {
  /** Fact-time commit; defaults to `SELF_COMMIT`. */
  readonly atCommitId?: CommitHash
  /** Acquisition event commit; defaults to `SELF_COMMIT`. */
  readonly acquiredAtCommitId?: CommitHash
  /** Independent origin; defaults to the newly written record's own SELF path. */
  readonly originEventRef?: StateRef
  readonly priority?: number
  /** Defaults to `true` (override lower priority); `false` adds a coexisting account. */
  readonly override?: boolean
  readonly belief?: BeliefState
  readonly source?: string
  /** Public co-witness bodies; stored as encoded body paths, never delegated roots. */
  readonly coWitnesses?: readonly ObserverRef[]
}

/** Options for `grantRumor`. */
export interface GrantRumorOptions {
  /** Rumor-creation event commit; defaults to `acquiredAtCommitId ?? SELF_COMMIT`. */
  readonly atCommitId?: CommitHash
  /** Hearing event commit; defaults to `atCommitId ?? SELF_COMMIT`. */
  readonly acquiredAtCommitId?: CommitHash
  /** Independent origin; defaults to the newly written rumor record's SELF path. */
  readonly originEventRef?: StateRef
  readonly priority?: number
  readonly override?: boolean
  readonly belief?: BeliefState
  readonly source?: string
  readonly rumorSummary?: string
  readonly coWitnesses?: readonly ObserverRef[]
}

/** Options for `propagateKnowledge`. */
export interface PropagateKnowledgeOptions {
  /** Retelling event commit; defaults to `SELF_COMMIT`. */
  readonly acquiredAtCommitId?: CommitHash
  readonly priority?: number
  readonly override?: boolean
  readonly belief?: BeliefState
  /** Source label shown to the receiver; defaults to the sender's identifier. */
  readonly claimedSource?: string
  /** Break the sender's origin chain and start a new independent origin. */
  readonly breakOriginChain?: boolean
  readonly coWitnesses?: readonly ObserverRef[]
}

/** Options for `excludeKnowledge`. */
export interface ExcludeKnowledgeOptions {
  readonly priority?: number
  /** Event commit of the exclusion; defaults to `SELF_COMMIT`. */
  readonly atCommitId?: CommitHash
}

/** Options for `syncScope`. */
export interface SyncScopeOptions {
  /** Additional observer bodies to refresh even if outside the scene subtree. */
  readonly additionalWitnesses?: readonly ObserverRef[]
  /** Field or instance paths whose `'passive'` fields are persisted this pass. */
  readonly focusedPaths?: readonly Path[]
}

/** Options for `activateDelegate`. */
export interface ActivateDelegateOptions {
  /** Conceal transferred children by setting their runtime visibility to `'self'`. */
  readonly concealTransferredChildren?: boolean
  /** Per-child visibility overrides keyed by `encodePathKey(childPath)`. */
  readonly visibilityOverrides?: Readonly<Record<string, Visibility>>
}

/** Path alias documenting that inspect targets accept any field/instance path. */
export type InspectPath = Path

/** Alias kept for symmetry with schema inspection helpers. */
export type AnyReadableLensAlias = AnyReadableLens

/** Input accepted by `createMemory`. */
export interface CreateMemoryInput {
  /** Map key and final path segment. */
  readonly id: string
  readonly level?: MemoryLevel
  readonly eventOrigin?: MemoryEventOrigin
  readonly significance?: MemorySignificance
  readonly tier?: MemoryTier
  readonly strength?: number
  readonly belief?: BeliefState
  readonly priority?: number
  readonly startTime?: number
  readonly endTime?: number
  readonly content: string
  /** Micro-summary stored as `$meta.summary` on the content leaf. */
  readonly summary?: string
  /** Historical event reference; defaults to the current commit message. */
  readonly factEventRef?: StateRef
  /** Historical snapshot reference; defaults to the current state tree root. */
  readonly factSnapshotRef?: StateRef
  /** Acquisition event reference; defaults to the current commit message. */
  readonly acquiredAtRef?: StateRef
  /** Independent origin; defaults to the newly written memory's own path. */
  readonly originRef?: StateRef
  readonly supportingClaimKeys?: readonly string[]
  readonly children?: readonly Path[]
  readonly relatedEntities?: Readonly<
    Record<string, { readonly targetRef: StateRef; readonly role?: string }>
  >
}

/** Mutable subset accepted by `updateMemory`. */
export interface UpdateMemoryPatch {
  readonly tier?: MemoryTier
  readonly strength?: number
  readonly belief?: BeliefState
  readonly priority?: number
  readonly content?: string
  /** `NONE` removes the content-leaf summary; omission preserves it. */
  readonly summary?: Option<string>
  readonly children?: readonly Path[]
}

/** Input accepted by `summarizeMemories`. */
export interface SummarizeMemoriesInput {
  /** Map key and final path segment of the new summary memory. */
  readonly id: string
  /** Must be `L1` or `L2` and strictly above every child level. */
  readonly level: 'L1' | 'L2'
  readonly childMemoryIds: readonly string[]
  readonly content: string
  readonly summary?: string
  readonly significance?: MemorySignificance
  readonly tier?: MemoryTier
  readonly strength?: number
  readonly startTime?: number
  readonly endTime?: number
  /** Archive subsumed children by default. */
  readonly archiveChildrenTier?: boolean
}

/** Forget modes replace physical deletion with state evolution. */
export type ForgetMemoryMode = 'archive' | 'known_false' | 'exclude'

/** Options for `propagateMemory`. */
export interface PropagateMemoryOptions {
  /** Target memory id; defaults to the source id and must not collide. */
  readonly targetMemoryId?: string
  /** Explicit acquisition event; defaults to the current commit message. */
  readonly acquiredAtRef?: StateRef
  /** Explicit origin record; defaults to the source memory path in this commit. */
  readonly originRef?: StateRef
}

/** Selection accepted by `carryOver`. */
export interface CarryOverSelection {
  /** Source branch commit. */
  readonly sourceCommitId: CommitHash
  /** Observer whose canonical root perspective is shared by both branches. */
  readonly observer: ObserverRef
  /** Restrict memories; omission carries every surviving personal memory. */
  readonly memoryIds?: readonly string[]
  /** Carry personal effective claims and exclusions (default `true`). */
  readonly includeClaims?: boolean
  /** Optional per-claim filter applied to the source winning facet. */
  readonly filterClaim?: (path: Path, facet: FoldFacet) => boolean
  /** Injective id remapping applied to carried memories. */
  readonly mapMemoryId?: (oldMemoryId: string) => string
  /** Explicit reconnection map for children that are not carried. */
  readonly existingChildMemoryMap?: Readonly<Record<string, string>>
}

/** Result of `carryOver`. */
export interface CarryOverResult {
  readonly rootPerspectiveId: string
  readonly sourceCommitId: CommitHash
  /** Old source memory id -> new branch memory id. */
  readonly memoryIdMap: Readonly<Record<string, string>>
  /** New memory paths written by this operation. */
  readonly carriedMemoryPaths: readonly Path[]
  /** Encoded full paths of claims and exclusions written by this operation. */
  readonly carriedClaimKeys: readonly string[]
  /** Inclusive allocated sequence range; empty carries return `[start, start - 1]`. */
  readonly allocatedSeqRange: readonly [number, number]
}

/** Coordinate components of a four-segment cognitive memory path. */
export interface MemoryPathCoordinates {
  readonly rootPerspectiveId: string
  readonly memoryId: string
}

/** Node of the observer's cognitive memory summary DAG. */
export interface CognitiveMemoryTreeNode {
  readonly memoryId: string
  readonly path: Path
  readonly level: MemoryLevel
  readonly seq: number
  readonly tier: MemoryTier
  readonly strength: number
  readonly belief: BeliefState
  readonly summary: Option<string>
  readonly content: string
  /** Memories directly subsumed by this node; cycle-safe. */
  readonly subsumedChildren: readonly CognitiveMemoryTreeNode[]
}

/**
 * Side-effect-free topology protocol shared with upper plugins.
 *
 * These reads never materialize state and never touch private modules.
 */
export interface PerspectiveTopologyReader {
  /** Resolve any entity path or perspective identifier to its canonical root id. */
  resolveRootPerspectiveAt(
    view: ReadonlySchemaView,
    observer: ObserverRef,
  ): Result<string, PerspectiveError>
  /** Recognize `['perspectives', P, 'memories', M]`; absence is `NONE`. */
  parseCognitiveMemoryPath(path: Path): Option<MemoryPathCoordinates>
}

/**
 * Perspective service contract registered as `ctx.perspective`.
 *
 * Every read method is pure and fixed to the supplied commit. Mutation methods
 * require a `SchemaTransaction` so optimistic concurrency, schema validation
 * and cascades remain owned by `@sekaisen/plugin-schema`.
 */
export interface PerspectiveServiceApi {
  /* 1. Root resolution and optional inheritance configuration */
  /**
   * Resolve an observer to its canonical root perspective id.
   *
   * Entity observers follow `'delegate'` links to the root body; named
   * perspective ids are returned unchanged.
   * @returns `Err(observer_entity_not_found)` only when an entity path was
   * supplied but no such instance exists at `commitId`.
   */
  resolveRootPerspective(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<string, PerspectiveError>

  /**
   * Materialize/update a perspective node inside a schema transaction.
   *
   * An entity observer binds `hostEntity` to its delegation root (cascade
   * delete) and uses the canonical id. Inherits are resolved to ids.
   */
  configurePerspective(
    tx: SchemaTransaction,
    observer: ObserverRef,
    config: ConfigurePerspectiveInput,
  ): Result<void, PerspectiveError>

  /* 2. Claim writing, retelling, exclusion and scene synchronisation */
  /**
   * Record a historical observation of a leaf field, or discover an instance.
   *
   * Ephemerality and structure come from `options.atCommitId`'s Writer
   * snapshot (the current draft by default), even when a leaf, optional ancestor
   * or concrete Map entry has no physical value. Today's Reader cannot weaken
   * or revoke historical restrictions. Instance targets write a discovery plus
   * eligible non-ephemeral surface observations from the same snapshot.
   */
  grantKnowledge(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    options?: GrantKnowledgeOptions,
  ): Result<void, PerspectiveError>

  /** Record a literal rumor/hallucination with a losslessly encoded `Value`. */
  grantRumor(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    rumorValue: Value,
    options?: GrantRumorOptions,
  ): Result<void, PerspectiveError>

  /**
   * Copy the sender's current subjective facet to another observer.
   *
   * The fact reference (or rumor factEventRef/encodedValue) and origin chain
   * are preserved unless `breakOriginChain` is requested; only the acquisition
   * event is updated. Unknown or unauthorized targets return `not_authorized`.
   * Live ephemerality uses the current declaration; observed facts use only
   * their recorded Writer declaration; persisted rumors copy literal bytes
   * without probing current objective metadata. Deleted discoveries retain
   * their structural kind, without implicitly authorizing unknown fields.
   */
  propagateKnowledge(
    tx: SchemaTransaction,
    fromObserver: ObserverRef,
    toObserver: ObserverRef,
    targetPath: Path,
    options?: PropagateKnowledgeOptions,
  ): Result<void, PerspectiveError>

  /**
   * Exclude claims at and below a path prefix with priority `<= options.priority`.
   * The empty path `[]` is a whole-tree prefix, including inherited knowledge
   * and live candidates; surviving stronger fiction never restores perception.
   */
  excludeKnowledge(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    options?: ExcludeKnowledgeOptions,
  ): Result<void, PerspectiveError>

  /**
   * Refresh persistent memory for observers near `sceneRoot`.
   *
   * Only observer bodies whose delegate root has a perspective node are
   * refreshed, plus `additionalWitnesses`. Each observer uses its own channel
   * ceilings; passive fields are skipped unless focused. Public co-witnesses
   * must also reach the target in their own channel scope and pass their own
   * inherited/personal field exclusions, not merely share the recorder's room.
   */
  syncScope(
    tx: SchemaTransaction,
    sceneRoot: StructLens | Path,
    options?: SyncScopeOptions,
  ): Result<void, PerspectiveError>

  /**
   * Activate a body of the same root mind, transferring location and children.
   *
   * Explicit `linkRoles` and implicit `exclusiveRole` use one role predicate.
   * Shared values copy from source to destination; source absence clears an
   * optional target or resets a defaulted target. An unrepresentable required
   * target rejects activation before location, shared-value or child writes.
   * Location absence also transfers: optional target parents clear; required
   * or defaulted targets reject before writes. Required/defaulted source
   * location links cannot be cleared. The whole operation is one savepoint:
   * later failures restore bodies, shared values, children and metadata while
   * preserving writes made earlier in the enclosing transaction.
   * Equal source/destination paths are a successful no-op, ignoring transfer
   * options. For distinct bodies, parent writes preserve the populated slot
   * chosen in preflight; an entirely absent parent uses its first declaration.
   * Owner migration instead replaces only edges naming the source body across
   * all scalar fields and link lists, preserves unrelated co-owners and absent
   * fields, and deduplicates changed lists in stable first-occurrence order.
   */
  activateDelegate(
    tx: SchemaTransaction,
    fromInstanceLens: StructLens,
    toInstanceLens: StructLens,
    options?: ActivateDelegateOptions,
  ): Result<void, PerspectiveError>

  /* 3. Observer-private cognitive memories and cross-timeline carry-over */
  /**
   * Write one subjective memory under the observer's canonical root perspective.
   *
   * `seq` is allocated from that perspective's `nextSeq`; enum, metric,
   * reference and same-perspective child invariants are validated before the
   * first write. `originRef` defaults to the newly written record's own path;
   * the record is appended atomically without advancing the objective clock.
   * Memory content is subjective and never replaced by objective evidence.
   */
  createMemory(
    tx: SchemaTransaction,
    observer: ObserverRef,
    input: CreateMemoryInput,
  ): Result<Path, PerspectiveError>

  /**
   * Update mutable memory state in place without changing sequence or owner.
   *
   * The whole patch is one savepoint. Sequence, level, refs and owner are not
   * mutable; children updates are re-validated against the same-perspective
   * level and sequence hierarchy.
   */
  updateMemory(
    tx: SchemaTransaction,
    observer: ObserverRef,
    memoryId: string,
    patch: UpdateMemoryPatch,
  ): Result<void, PerspectiveError>

  /**
   * Create an `L1`/`L2` summary over same-perspective child memories.
   *
   * Every child must exist, belong to the same root, and satisfy strict level
   * and sequence progression. Children are archived by default through the
   * same savepoint; a failure writes nothing.
   */
  summarizeMemories(
    tx: SchemaTransaction,
    observer: ObserverRef,
    input: SummarizeMemoriesInput,
  ): Result<Path, PerspectiveError>

  /**
   * Forget through state evolution rather than physical deletion.
   *
   * `archive` changes the tier, `known_false` changes belief so summaries stop
   * folding children, and `exclude` appends a high-priority exclusion for the
   * memory path. Nothing is deleted.
   */
  forgetMemory(
    tx: SchemaTransaction,
    observer: ObserverRef,
    memoryId: string,
    mode: ForgetMemoryMode,
  ): Result<void, PerspectiveError>

  /**
   * Retell one self-owned memory to another observer.
   *
   * Content, level, significance, tier, metrics, belief and historical entity
   * references survive; acquisition time advances to this commit, acquisition
   * evidence keys are dropped, children are not implicitly reconnected, and
   * the new id must not collide with the receiver's existing memories.
   */
  propagateMemory(
    tx: SchemaTransaction,
    fromObserver: ObserverRef,
    toObserver: ObserverRef,
    memoryId: string,
    options?: PropagateMemoryOptions,
  ): Result<Path, PerspectiveError>

  /**
   * Migrate surviving personal claims and memories across branches of the same
   * root perspective.
   *
   * Source order drives new local sequence allocation; historical refs and
   * claim origins survive, acquisition events advance to this commit, children
   * reconnect only for batch-carried memories or explicit existing mappings,
   * and ids must remain injective without overwriting target memories.
   */
  carryOver(
    tx: SchemaTransaction,
    selection: CarryOverSelection,
  ): Result<CarryOverResult, PerspectiveError>

  /**
   * Assemble the observer's own `L2 -> L1 -> L0` summary DAG.
   *
   * Reads are host-only, cycle-safe for malformed drafts, and omit memories
   * hidden by effective exclusions. Shared children may appear under multiple
   * parents.
   */
  inspectCognitiveMemoryTree(
    commitIdOrView: CommitHash | ReadonlySchemaView,
    observer: ObserverRef,
  ): Result<readonly CognitiveMemoryTreeNode[], PerspectiveError>

  /** Resolve an observer at a read-only view without materializing state. */
  resolveRootPerspectiveAt(
    view: ReadonlySchemaView,
    observer: ObserverRef,
  ): Result<string, PerspectiveError>

  /** Recognize a four-segment cognitive memory path without reading state. */
  parseCognitiveMemoryPath(path: Path): Option<MemoryPathCoordinates>

  /* 4. Projection, expansion, adjudication and retrieval */
  /** Raw standard double-channel public surface rooted at `sceneRoot`. */
  projectScopePublic(
    commitId: CommitHash,
    sceneRoot: StructLens | Path,
  ): Result<ScenePublicProjection, PerspectiveError>

  /** Safe agent projection: public prefix only when byte-identical to raw public. */
  projectView(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<AgentWorldProjection, PerspectiveError>

  /** Fully expand chosen paths for one observer. */
  inspect(
    commitId: CommitHash,
    observer: ObserverRef,
    targetPaths: readonly Path[],
  ): Result<readonly InspectedFieldView[], PerspectiveError>

  /** Adjudicator-only subjective/objective comparison. */
  inspectForAdjudication(
    commitId: CommitHash,
    observer: ObserverRef,
    targetPaths: readonly Path[],
  ): Result<readonly AdjudicatedPathResult[], PerspectiveError>

  /**
   * Pre-filtered legal retrieval corpus for one observer.
   *
   * Historical ephemerality comes from each fact's Writer snapshot; unseen
   * current declarations cannot censor old observations or literal rumors.
   */
  listSearchableCorpus(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<readonly SearchableCorpusEntry[], PerspectiveError>

  /** Read-only capability facade locked to the observer and commit. */
  asObserver(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<ScopedObserverPerspective, PerspectiveError>
}
