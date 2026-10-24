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
  SchemaError,
  SchemaTransaction,
  StructLens,
} from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
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
  /** One-hop link targets also visible to this observer. */
  readonly linkedInstancePaths: readonly Path[]
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

  /* 3. Projection, expansion, adjudication and retrieval */
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
