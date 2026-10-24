/**
 * `ctx.perspective`: the Cordis service owning the epistemic layer.
 *
 * Design boundaries:
 * - All structure is registered through `ctx.schema` (`define` plus the
 *   perspective commit validator); no private schema internals are imported.
 * - Every mutation requires a `SchemaTransaction`, so CAS, net-disappearance
 *   cascades and final validation remain schema-owned.
 * - Every read is pure and fixed to one commit; reads never materialize minds
 *   and never advance heads.
 * - The `asObserver` facade captures an immutable observer identity so callers
 *   cannot spoof it through `this` or mutate an input path after creation.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type {
  FieldLens,
  LeafSchemaNode,
  LeafValueTypeMap,
  MapLens,
  SchemaMetaMap,
  SchemaTransaction,
  StructLens,
} from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, encodeValue, SELF_COMMIT, valueEquals } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { FoldFacet } from './claims.ts'
import { ClaimEvaluator, isDirectPersonalObservation } from './claims.ts'
import type { FieldNode, PerspectiveGraph, StructInstance } from './graph.ts'
import {
  decodePathKeySafe,
  encodePerspectivePointer,
  fieldInstancePath,
  PerspectiveGraph as Graph,
  pathsEqual,
} from './graph.ts'
import {
  attemptPerspective,
  expectSchema,
  fail,
  PerspectiveFailure,
  valueOrRefEquals,
} from './internal.ts'
import type { ObserverContext, ProjectionDeps } from './projection.ts'
import {
  adjudicatePaths,
  buildCorpus,
  buildProjection,
  buildPublicProjection,
  inspectPaths,
  observerContext,
} from './projection.ts'
import type {
  ExclusionClaimInput,
  ObservedClaimInput,
  PerspectiveRecord,
  RumorClaimInput,
} from './schemas.ts'
import {
  ALL_PERSPECTIVE_ID,
  DEFAULT_PERSPECTIVE_PRIORITY,
  PERSPECTIVES_ROOT,
  PerspectiveNodeSchema,
} from './schemas.ts'
import type { ObserverScopeState, WitnessContext } from './scope.ts'
import { computeObserverScope, coWitnessesFor } from './scope.ts'
import { validatePerspectiveTopology } from './topology.ts'
import type {
  ActivateDelegateOptions,
  AdjudicatedPathResult,
  AgentWorldProjection,
  ConfigurePerspectiveInput,
  ExcludeKnowledgeOptions,
  GrantKnowledgeOptions,
  GrantRumorOptions,
  InspectedFieldView,
  ObserverRef,
  PerspectiveError,
  PerspectiveServiceApi,
  PropagateKnowledgeOptions,
  ScenePublicProjection,
  ScopedObserverPerspective,
  SearchableCorpusEntry,
  SyncScopeOptions,
} from './types.ts'
import type { FieldSalience } from './visibility.ts'
import { hasLinkRole, isEphemeralSpec } from './visibility.ts'

declare module 'cordis' {
  interface Context {
    perspective: PerspectiveService
  }
}

interface ResolvedObserver {
  readonly id: string
  /** Staged body path for entity observers. */
  readonly entity: Option<Path>
  /** Delegation root entity path for entity observers. */
  readonly rootEntity: Option<Path>
}

interface SubjectiveTop {
  readonly facet: FoldFacet
  readonly targetRef: StateRef
}

function observerPath(observer: StructLens | Path): Path {
  return 'opticKind' in observer ? observer.path : observer
}

function metaEquals(a: SchemaMetaMap | undefined, b: SchemaMetaMap | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && valueEquals(left[key] as Value, right[key] as Value),
  )
}

/**
 * Perspective service. Construct after `ctx.world` and `ctx.schema` exist.
 *
 * The constructor registers the `['perspectives']` Map root and the topology
 * commit validator in the calling Cordis scope. Root registration writes no
 * commit, so it is safe before the first world transition.
 */
export class PerspectiveService extends Service implements PerspectiveServiceApi {
  /** Schema and world are hard dependencies. */
  static inject = ['world', 'schema']

  constructor(ctx: Context) {
    if (!ctx.schema) throw new Error('PerspectiveService requires ctx.schema')
    super(ctx, 'perspective')
    const definition = ctx.schema.define(PERSPECTIVES_ROOT, s.map(PerspectiveNodeSchema))
    if (!definition.ok)
      throw new Error(
        `PerspectiveService failed to register perspectives: ${definition.error.kind}`,
      )
    ctx.schema.addCommitValidator(({ draft }) => validatePerspectiveTopology(draft))
  }

  private view(commitId: CommitHash): PerspectiveGraph {
    return new Graph(expectSchema(this.ctx.schema.viewAt(commitId)), true)
  }

  /**
   * Resolve observed values against their fact snapshot. SELF state references
   * read the current draft, not World's committed history. A pending message
   * remains an opaque reference until publication: relaying its anchor does
   * not invent or prematurely read a message payload.
   */
  private resolveHistorical(
    graph: PerspectiveGraph,
    ref: StateRef,
  ): Option<{ value: Value | StateRef; summary: Option<string> }> {
    if (ref.commitId === SELF_COMMIT && ref.path[0] === '$message')
      return some({ value: ref, summary: NONE })
    const resolved =
      ref.commitId === SELF_COMMIT
        ? { targetKind: 'state_node' as const, inspection: graph.inspect(ref.path) }
        : expectSchema(this.ctx.schema.resolveRef(ref))
    if (resolved.targetKind === 'commit_message') {
      const value = resolved.value
      if (value.kind === 'none') return NONE
      return some({ value: isPerspectiveValue(value.value) ? value.value : ref, summary: NONE })
    }
    if (resolved.inspection.kind === 'none') return NONE
    const inspection = resolved.inspection.value
    if (inspection.nodeKind !== 'leaf') return some({ value: ref, summary: NONE })
    const summary = inspection.meta.summary
    return some({
      value: inspection.value,
      summary: typeof summary === 'string' ? some(summary) : NONE,
    })
  }

  private deps(graph: PerspectiveGraph, commitId: CommitHash): ProjectionDeps {
    return this.depsFor(graph, commitId, ALL_PERSPECTIVE_ID)
  }

  private depsFor(graph: PerspectiveGraph, commitId: CommitHash, rootId: string): ProjectionDeps {
    let historical: Map<CommitHash, PerspectiveGraph> | undefined
    return {
      graph,
      evaluator: this.evaluatorFor(graph, rootId),
      commitId,
      graphAt: (id: CommitHash) => {
        if (id === commitId) return graph
        const cached = historical?.get(id)
        if (cached !== undefined) return cached
        const snapshot = this.view(id)
        historical ??= new Map()
        historical.set(id, snapshot)
        return snapshot
      },
    }
  }

  private resolveObserver(graph: PerspectiveGraph, observer: ObserverRef): ResolvedObserver {
    if (typeof observer === 'string') {
      const decoded = decodePathKeySafe(observer)
      if (decoded.kind === 'some' && graph.instance(decoded.value).kind === 'some') {
        const root = graph.delegateRoot(decoded.value)
        return { id: encodePathKey(root), entity: some(decoded.value), rootEntity: some(root) }
      }
      const record = graph.perspective(observer)
      if (record.kind === 'some' && record.value.hostEntity.kind === 'some') {
        return {
          id: observer,
          entity: some(record.value.hostEntity.value),
          rootEntity: some(record.value.hostEntity.value),
        }
      }
      return { id: observer, entity: NONE, rootEntity: NONE }
    }
    const path = observerPath(observer)
    if (graph.instance(path).kind === 'none')
      fail({ kind: 'observer_entity_not_found', observer: encodePathKey(path) })
    const root = graph.delegateRoot(path)
    return { id: encodePathKey(root), entity: some(path), rootEntity: some(root) }
  }

  private evaluatorFor(graph: PerspectiveGraph, rootId: string): ClaimEvaluator {
    return new ClaimEvaluator(graph.perspectives(), rootId, (ref) =>
      this.resolveHistorical(graph, ref),
    )
  }

  /** Build observer context for projections without mutating anything. */
  private contextFor(
    graph: PerspectiveGraph,
    deps: ProjectionDeps,
    observer: ResolvedObserver,
  ): ObserverContext {
    let scope: Option<ObserverScopeState> = NONE
    if (observer.entity.kind === 'some') {
      const evaluator = this.evaluatorFor(graph, observer.id)
      scope = some(computeObserverScope(graph, evaluator, observer.entity.value))
    }
    return observerContext(deps, observer.id, observer.entity, observer.rootEntity, scope)
  }

  /* ------------------------------------------------------------------ */
  /* 1. Root resolution and configuration                               */
  /* ------------------------------------------------------------------ */

  /** Resolve an observer to its canonical root perspective id. */
  resolveRootPerspective(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<string, PerspectiveError> {
    return attemptPerspective(() => this.resolveObserver(this.view(commitId), observer).id)
  }

  /**
   * Materialize/update one perspective node inside a transaction.
   *
   * `config.inherits` accepts logical observer references and is resolved to
   * logical perspective ids for cycle checks and public records. Every parent
   * node is materialized when missing so the persisted `inherits` link list
   * always targets existing `['perspectives', id]` nodes. Storage therefore
   * receives canonical pointers (see {@link encodePerspectivePointer}), never
   * bare logical ids, which native link validation would reject.
   * Omitted `inherits` preserves existing parents; only an explicit list
   * replaces them, with `[]` deliberately clearing inheritance. Description
   * and priority updates therefore never revoke unrelated knowledge access.
   */
  configurePerspective(
    tx: SchemaTransaction,
    observer: ObserverRef,
    config: ConfigurePerspectiveInput,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = new Graph(tx)
      const resolved = this.resolveObserver(graph, observer)
      const inheritance = config.inherits?.map((parent) => {
        const parentResolved = this.resolveObserver(graph, parent)
        return { id: parentResolved.id, hostEntity: parentResolved.rootEntity }
      })
      const inherits =
        inheritance?.map((parent) => parent.id) ?? graph.perspectiveOrDefault(resolved.id).inherits
      if (resolved.id === ALL_PERSPECTIVE_ID && inherits.length > 0)
        fail({
          kind: 'topology_violation',
          path: [...PERSPECTIVES_ROOT, resolved.id],
          reason: 'root_perspective_cannot_inherit',
          detail: 'the all perspective must not inherit any parent',
        })
      const edges = new Map<string, readonly string[]>()
      for (const [id, record] of graph.perspectives()) edges.set(id, record.inherits)
      edges.set(resolved.id, inherits)
      const cycle = findCycle(edges)
      if (cycle !== null)
        fail({
          kind: 'topology_violation',
          path: [...PERSPECTIVES_ROOT, cycle],
          reason: 'cyclic_role_graph',
          detail: `inheritance cycle through ${cycle}`,
        })
      const hostEntity = resolved.rootEntity
      this.ensurePerspective(tx, resolved.id, hostEntity)
      const patch: Record<string, unknown> = {}
      if (inheritance !== undefined) {
        for (const parent of inheritance) this.ensurePerspective(tx, parent.id, parent.hostEntity)
        patch.inherits = inheritance.map((parent) => encodePerspectivePointer(parent.id))
      }
      if (config.description !== undefined) patch.description = config.description
      if (config.defaultPriority !== undefined) patch.defaultPriority = config.defaultPriority
      if (hostEntity.kind === 'some') patch.hostEntity = encodePathKey(hostEntity.value)
      const lens = this.perspectiveEntry(tx, resolved.id)
      tx.patch(lens, patch)
    })
  }

  /* ------------------------------------------------------------------ */
  /* 2. Claim writes                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Record a historical observation of a leaf field, or discover an instance.
   *
   * Classification and field expansion are performed against the fact view
   * selected by `options.atCommitId` (a historical commit, or the current draft
   * for `SELF_COMMIT`). A now-deleted hidden instance is therefore still
   * classified as a Struct and only its old surface fields are captured; newer
   * current fields can never leak into the grant. Current transaction state is
   * still used to resolve the observer and write the records.
   *
   * - Custom leaves use their real `[...instancePath, '$custom', key]` paths;
   *   no logical alias is invented that could fail World's SELF validation.
   * - Message targets use `['$message', ...]`. Pending SELF messages can be
   *   relayed as opaque anchors before publication; committed scalar/list
   *   payloads are resolved afterward, while structured nodes retain refs.
   * - Leaf targets are rejected with `invalid_claim_target` when their schema
   *   declares `ephemeral: true` (or its stored Writer spec did).
   * - Instance targets write a discovery record keyed by the entity path key
   *   plus one observation per non-ephemeral `'surface'` field present at the
   *   fact view.
   * - `targetRef.commitId` is `atCommitId` (default `SELF_COMMIT`);
   *   `eventRef` is `acquiredAtCommitId` (default `SELF_COMMIT`).
   * - Unless `originEventRef` is supplied, each record's origin defaults to
   *   that record's own path in the current commit, guaranteeing the origin
   *   resolves even for backfilled history.
   * - Co-witnesses are stored as public body path keys; delegation roots are
   *   never substituted.
   */
  grantKnowledge(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    options?: GrantKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = new Graph(tx)
      const resolved = this.resolveObserver(graph, observer)
      const at = options?.atCommitId ?? SELF_COMMIT
      const source = at === SELF_COMMIT ? graph : this.view(at)
      const target = source.inspect(targetPath)

      if (target.kind === 'some' && target.value.nodeKind !== 'leaf') {
        this.ensurePerspective(tx, resolved.id, resolved.rootEntity)
        const record = this.perspectiveRecord(tx, resolved.id)
        this.writeDiscovery(tx, resolved.id, record, targetPath, options)
        for (const field of this.surfaceFields(source, targetPath)) {
          this.writeObservation(
            tx,
            resolved.id,
            this.perspectiveRecord(tx, resolved.id),
            field.path,
            options,
          )
        }
        return
      }
      this.assertPersistentClaimTarget(
        source,
        targetPath,
        at === SELF_COMMIT ? 'live' : 'historical',
      )
      this.ensurePerspective(tx, resolved.id, resolved.rootEntity)
      const record = this.perspectiveRecord(tx, resolved.id)
      this.writeObservation(tx, resolved.id, record, targetPath, options)
    })
  }

  /** Record a literal rumor/hallucination payload. */
  grantRumor(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    rumorValue: Value,
    options?: GrantRumorOptions,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = new Graph(tx)
      const resolved = this.resolveObserver(graph, observer)
      this.assertPersistentClaimTarget(graph, targetPath)
      this.ensurePerspective(tx, resolved.id, resolved.rootEntity)
      const record = this.perspectiveRecord(tx, resolved.id)
      const at = options?.atCommitId ?? options?.acquiredAtCommitId ?? SELF_COMMIT
      const acquiredAt = options?.acquiredAtCommitId ?? at
      const priority = options?.priority ?? record.defaultPriority
      const seq = record.nextSeq
      const key = `${encodePathKey(targetPath)}#${seq}`
      const origin =
        options?.originEventRef ??
        ({
          commitId: SELF_COMMIT,
          path: [...PERSPECTIVES_ROOT, resolved.id, 'rumorClaims', key],
        } as StateRef)
      const input: RumorClaimInput = {
        seq,
        targetPathKey: encodePathKey(targetPath),
        factEventRef: { commitId: at, path: ['$message'] },
        eventRef: { commitId: acquiredAt, path: ['$message'] },
        originEventRef: origin,
        encodedValue: encodeValue(rumorValue),
        priority,
        override: options?.override ?? false,
        belief: options?.belief ?? 'suspected',
        coWitnesses: this.coWitnessKeys(options?.coWitnesses),
        ...(options?.rumorSummary !== undefined ? { rumorSummary: options.rumorSummary } : {}),
        ...(options?.source !== undefined ? { source: options.source } : {}),
      }
      this.appendRumor(tx, resolved.id, 'rumorClaims', key, input)
      this.bumpSeq(tx, resolved.id, seq + 1)
    })
  }

  /**
   * Retell the sender's current subjective top facet to another observer.
   *
   * The sender's top is computed through the same fold used by projections,
   * including live perception only when the sender genuinely reaches the
   * target. The receiver therefore gets the sender's fact reference (or rumor
   * `factEventRef` plus canonical encoded value) and the sender's origin chain;
   * only `eventRef` advances to `options.acquiredAtCommitId` (default
   * `SELF_COMMIT`). Objective current values are never consulted for an
   * off-scene target, so a later unseen edit cannot leak through a retelling.
   *
   * `claimedSource` supplies a false-flag label; otherwise the sender's id is
   * used. `breakOriginChain` starts a new origin at the receiver's newly
   * written record. An unknown/unauthorized sender facet yields
   * `not_authorized`.
   *
   * Temporal classification follows the source facet, never the current
   * objective shape:
   * - live `direct_scope`/`self_owned` facets are validated against the
   *   current declaration, so a genuinely current ephemeral field is still
   *   rejected before any receiver exists;
   * - a durable observed facet is validated only against its own
   *   `targetRef` fact snapshot, so a later unknown redefinition of the same
   *   path (for example an ordinary custom leaf turned `ephemeral`) cannot
   *   revoke what the sender validly remembered;
   * - a persisted literal rumor is copied verbatim without probing objective
   *   metadata, preserving its payload through any current redefinition;
   * - a remembered whole entity is written as `discoveredEntities` using the
   *   source record table and fact snapshot, so a deleted discovery keeps its
   *   original `targetRef`/`originEventRef` and never degenerates into a fake
   *   field claim on its enclosing Map.
   */
  propagateKnowledge(
    tx: SchemaTransaction,
    fromObserver: ObserverRef,
    toObserver: ObserverRef,
    targetPath: Path,
    options?: PropagateKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = new Graph(tx)
      const from = this.resolveObserver(graph, fromObserver)
      const to = this.resolveObserver(graph, toObserver)
      const evaluator = this.evaluatorFor(graph, from.id)
      const scope =
        from.entity.kind === 'some' && graph.instance(from.entity.value).kind === 'some'
          ? some(computeObserverScope(graph, evaluator, from.entity.value))
          : NONE
      const top = this.subjectiveTop(graph, evaluator, from, targetPath, scope)
      if (top.kind === 'none')
        fail({ kind: 'not_authorized', rootPerspectiveId: from.id, targetPath })
      const facet = top.value.facet
      this.assertRetellableFacet(graph, facet, targetPath)
      this.ensurePerspective(tx, to.id, to.rootEntity)
      const targetRecord = this.perspectiveRecord(tx, to.id)
      const priority = options?.priority ?? targetRecord.defaultPriority
      const acquiredAt = options?.acquiredAtCommitId ?? SELF_COMMIT
      const source = options?.claimedSource ?? this.observerLabel(fromObserver, from)
      const coWitnesses = this.coWitnessKeys(options?.coWitnesses)
      const targetIsInstance = this.retellsEntity(graph, evaluator, facet, targetPath)

      if (facet.sourceKind === 'rumor_claim') {
        const seq = targetRecord.nextSeq
        const key = `${encodePathKey(targetPath)}#${seq}`
        const origin =
          options?.breakOriginChain || facet.originEventRef.kind === 'none'
            ? { commitId: SELF_COMMIT, path: [...PERSPECTIVES_ROOT, to.id, 'rumorClaims', key] }
            : facet.originEventRef.value
        const input: RumorClaimInput = {
          seq,
          targetPathKey: encodePathKey(targetPath),
          factEventRef:
            facet.factEventRef.kind === 'some'
              ? facet.factEventRef.value
              : { commitId: acquiredAt, path: ['$message'] },
          eventRef: { commitId: acquiredAt, path: ['$message'] },
          originEventRef: origin,
          encodedValue:
            facet.encodedValue ?? encodeValue(isPerspectiveValue(facet.value) ? facet.value : null),
          priority,
          override: options?.override ?? facet.priority > targetRecord.defaultPriority,
          belief: options?.belief ?? facet.belief,
          coWitnesses,
          ...(facet.summary.kind === 'some' ? { rumorSummary: facet.summary.value } : {}),
          source,
        }
        this.appendRumor(tx, to.id, 'rumorClaims', key, input)
        this.bumpSeq(tx, to.id, seq + 1)
        return
      }

      const seq = targetRecord.nextSeq
      const collection = targetIsInstance ? 'discoveredEntities' : 'observedClaims'
      const key = targetIsInstance
        ? encodePathKey(top.value.targetRef.path)
        : `${encodePathKey(targetPath)}#${seq}`
      const origin =
        options?.breakOriginChain || facet.originEventRef.kind === 'none'
          ? { commitId: SELF_COMMIT, path: [...PERSPECTIVES_ROOT, to.id, collection, key] }
          : facet.originEventRef.value
      const input: ObservedClaimInput = {
        seq,
        targetRef:
          facet.targetRef.kind === 'some'
            ? facet.targetRef.value
            : { commitId: SELF_COMMIT, path: targetPath },
        eventRef: { commitId: acquiredAt, path: ['$message'] },
        originEventRef: origin,
        priority,
        override: options?.override ?? true,
        belief: options?.belief ?? facet.belief,
        coWitnesses,
        source,
      }
      if (targetIsInstance) this.appendObserved(tx, to.id, 'discoveredEntities', key, input)
      else this.appendObserved(tx, to.id, 'observedClaims', key, input)
      this.bumpSeq(tx, to.id, seq + 1)
    })
  }

  /**
   * Add a path-prefix exclusion inside a transaction.
   *
   * `[]` names the entire tree. Priority and inheritance ordering still apply:
   * stronger literal claims may survive, but they cannot revive live access
   * removed by the exclusion.
   */
  excludeKnowledge(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    options?: ExcludeKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = new Graph(tx)
      const resolved = this.resolveObserver(graph, observer)
      this.ensurePerspective(tx, resolved.id, resolved.rootEntity)
      const record = this.perspectiveRecord(tx, resolved.id)
      const seq = record.nextSeq
      const key = `${encodePathKey(targetPath)}#${seq}`
      const input: ExclusionClaimInput = {
        seq,
        targetPathKey: encodePathKey(targetPath),
        eventRef: { commitId: options?.atCommitId ?? SELF_COMMIT, path: ['$message'] },
        priority: options?.priority ?? record.defaultPriority,
      }
      this.appendExclusion(tx, resolved.id, key, input)
      this.bumpSeq(tx, resolved.id, seq + 1)
    })
  }

  /**
   * Refresh persistent surface memories for observers in a scene subtree.
   *
   * `sceneRoot` selects candidate observer bodies from the scene's semantic
   * containment tree: the root body itself plus every descendant reachable
   * through `'parent'` links. Physical Map siblings are therefore included,
   * which plain structural traversal would miss. Traversal is cycle-safe even
   * for malformed historical drafts. An instance qualifies when its delegation
   * root has a materialized perspective. `additionalWitnesses` adds explicit
   * observer bodies even when they sit outside the subtree. Ordinary objects
   * never gain minds.
   * Each observer is evaluated independently with its own sight/sound ceiling,
   * actor sensory switches and cognitive exclusions.
   *
   * For every winning `direct_scope` field:
   * - ephemeral fields are never persisted;
   * - `'passive'` fields are skipped unless the field or its instance appears
   *   in `focusedPaths`;
   * - `coWitnesses` enumerate every observer body in the observer's complete
   *   unblocked visual public domain (not merely the refresh batch), require
   *   each candidate's own channel ceiling, reachable target and individual or
   *   inherited field exclusions. Stored keys name public bodies, not minds;
   * - an existing personal direct observation with the same historical value,
   *   sufficient priority and a superset of witnesses is left untouched.
   *   Forwarded observations never satisfy the direct-observation predicate,
   *   so they cannot suppress a genuine first sighting.
   *
   * Only the observer's own table is consulted for idempotence; inherited
   * organisation/common claims are ignored for that check.
   */
  syncScope(
    tx: SchemaTransaction,
    sceneRoot: StructLens | Path,
    options?: SyncScopeOptions,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() => {
      const rootPath = observerPath(sceneRoot)
      let graph = new Graph(tx)
      if (graph.instance(rootPath).kind === 'none') return
      const actors = new Map<string, Path>()
      const isBody = (path: Path): boolean => {
        const instance = graph.instance(path)
        if (instance.kind === 'none') return false
        return graph.hasMindForEntity(graph.delegateRoot(path))
      }
      /*
       * Entities are siblings under a Map root, so structural traversal of the
       * scene root finds no bodies. Follow the indexed `'parent'` containment
       * edges instead. `visited` keeps malformed cyclic drafts total.
       */
      const visited = new Set<string>()
      const pending: Path[] = [rootPath]
      for (let index = 0; index < pending.length; index++) {
        const candidate = pending[index]!
        const key = encodePathKey(candidate)
        if (visited.has(key)) continue
        visited.add(key)
        if (isBody(candidate)) actors.set(key, candidate)
        for (const child of graph.childrenOf(candidate)) pending.push(child)
      }
      for (const witness of options?.additionalWitnesses ?? []) {
        const resolved = this.resolveObserver(graph, witness)
        if (resolved.entity.kind === 'some')
          actors.set(encodePathKey(resolved.entity.value), resolved.entity.value)
      }
      // Materialize explicit witnesses before folding anyone's public evidence,
      // so co-witness membership cannot depend on actor refresh order.
      for (const actorPath of actors.values()) {
        const root = graph.delegateRoot(actorPath)
        this.ensurePerspective(tx, encodePathKey(root), some(root))
      }
      const focused = new Set((options?.focusedPaths ?? []).map((path) => encodePathKey(path)))
      /*
       * Sync writes observations only: containment, sensory switches,
       * discoveries and exclusions stay fixed. Cache candidate permissions
       * across fields, never their content-fold winners. Each recording body
       * still receives a fresh evaluator for its current memory arbitration.
       */
      const witnessContexts = new Map<string, WitnessContext | null>()
      const witnessFor = (body: Path): Option<WitnessContext> => {
        const key = encodePathKey(body)
        const cached = witnessContexts.get(key)
        if (cached !== undefined) return cached === null ? NONE : some(cached)
        if (!isBody(body)) {
          witnessContexts.set(key, null)
          return NONE
        }
        const root = graph.delegateRoot(body)
        const evaluator = this.evaluatorFor(graph, encodePathKey(root))
        const context = { evaluator, scope: computeObserverScope(graph, evaluator, body) }
        witnessContexts.set(key, context)
        return some(context)
      }

      for (const [actorKey, actorPath] of actors) {
        graph = new Graph(tx)
        const root = graph.delegateRoot(actorPath)
        const mindId = encodePathKey(root)
        const evaluator = this.evaluatorFor(graph, mindId)
        const cachedWitness = witnessContexts.get(actorKey)
        const scope = cachedWitness?.scope ?? computeObserverScope(graph, evaluator, actorPath)
        if (!cachedWitness) witnessContexts.set(actorKey, { evaluator, scope })
        const visible = new Map<string, Path>([
          ...scope.sight.reachablePaths,
          ...scope.sound.reachablePaths,
        ])
        const personal = this.perspectiveRecord(tx, mindId)
        let seq = personal.nextSeq
        for (const instancePath of visible.values()) {
          const instance = graph.instance(instancePath)
          if (instance.kind === 'none') continue
          for (const field of instance.value.fields.values()) {
            if (field.value.kind === 'none') continue
            if (graph.fieldVisibility(field) !== 'surface') continue
            if (isEphemeralSpec(field.spec)) continue
            const channel = field.spec.metadata.sense === 'sound' ? 'sound' : 'sight'
            const channelScope = channel === 'sight' ? scope.sight : scope.sound
            if (!channelScope.reachablePaths.has(encodePathKey(instancePath))) continue
            const fold = evaluator.fold(field.path, {
              kind: 'direct_scope',
              value: field.value.value,
              summary: summaryOf(field.meta),
            })
            if (fold.primary.kind === 'none' || fold.primary.value.sourceKind !== 'direct_scope')
              continue
            const focusedPath =
              focused.has(encodePathKey(field.path)) || focused.has(encodePathKey(instancePath))
            const salience: FieldSalience = graph.fieldSalience(instance.value, field)
            if (salience === 'passive' && !focusedPath) continue
            const witnesses = coWitnessesFor(graph, scope, field.path, channel, witnessFor)
            const personalTop = evaluator.personalObservedTop(personal, field.path)
            const current = this.currentLeaf(graph, field.path)
            let sameValueOrigin: StateRef | undefined
            if (personalTop.kind === 'some') {
              const record = personalTop.value
              const direct = isDirectPersonalObservation(mindId, record)
              const sameValue = this.historicalMatchesCurrent(graph, record.targetRef, current)
              if (direct && sameValue) sameValueOrigin = record.originEventRef
              const witnessesCovered = witnesses.every((witness) =>
                record.coWitnesses.includes(witness),
              )
              if (
                direct &&
                record.priority >= personal.defaultPriority &&
                sameValue &&
                witnessesCovered
              )
                continue
            }
            const key = `${encodePathKey(field.path)}#${seq}`
            const origin: StateRef = sameValueOrigin ?? {
              commitId: SELF_COMMIT,
              path: [...PERSPECTIVES_ROOT, mindId, 'observedClaims', key],
            }
            const input: ObservedClaimInput = {
              seq,
              targetRef: { commitId: SELF_COMMIT, path: field.path },
              eventRef: { commitId: SELF_COMMIT, path: ['$message'] },
              originEventRef: origin,
              priority: personal.defaultPriority,
              override: true,
              belief: 'believed',
              coWitnesses: witnesses,
            }
            this.appendObserved(tx, mindId, 'observedClaims', key, input)
            seq++
            this.bumpSeq(tx, mindId, seq)
          }
        }
      }
    })
  }

  /**
   * Move a controlled body: location, followed children and shared fields.
   *
   * Both bodies must resolve through `'delegate'` links to the same root mind
   * (otherwise `delegate_root_mismatch`). The source's parent container is
   * transferred to the destination and cleared from the source; fields marked
   * `sharedAcrossDelegates` are copied (including references), and an absent
   * optional source value clears an optional destination or resets its default.
   * If a required destination cannot represent absence, activation is rejected
   * before changing either body's location, shared values or children.
   *
   * Location is declared state, not merely a physically present link. When the
   * source has no parent (an absent optional parent or no `'parent'` field at
   * all), an optional destination parent is cleared so stale coordinates never
   * survive; a required or defaulted destination parent cannot represent that
   * absence and is rejected before any write. A source parent declaration that
   * cannot be cleared (required or defaulted) is likewise rejected before the
   * first write. A destination without any `'parent'` declaration simply keeps
   * its existing shape because there is no location slot to write or clear.
   *
   * Children are found through the canonical `'parent'` role predicate, so implicit
   * `exclusiveRole: 'parent'` declarations behave exactly like explicit
   * `linkRoles`; they are re-parented. Their declared `'owner'` links migrate
   * only targets equal to the source body: all scalar owner fields and
   * `linkList` entries are covered, unrelated co-owners stay intact, and changed
   * lists are deduplicated in first-occurrence order after replacement.
   * Transferred children may be hidden with `concealTransferredChildren` or
   * per-path `visibilityOverrides`; other runtime metadata is preserved.
   *
   * Equal source and destination paths are a successful no-op, including for
   * required location links. Transfer options do not change any state in that
   * case. For distinct bodies, parent writes reuse the populated single-target
   * slot selected during preflight, or the first declaration if all are absent.
   *
   * Every write runs inside one transaction savepoint. Any later schema or
   * perspective failure rolls back all location, shared-value, child and
   * visibility metadata writes made by this activation while preserving writes
   * made earlier in the same transaction, then reports the failure as a
   * `Result` instead of leaving a partially activated body.
   */
  activateDelegate(
    tx: SchemaTransaction,
    fromInstanceLens: StructLens,
    toInstanceLens: StructLens,
    options?: ActivateDelegateOptions,
  ): Result<void, PerspectiveError> {
    return attemptPerspective(() =>
      tx.atomic(() => {
        const fromPath = fromInstanceLens.path
        const toPath = toInstanceLens.path
        if (pathsEqual(fromPath, toPath)) return
        const graph = new Graph(tx)
        const fromRoot = graph.delegateRoot(fromPath)
        const toRoot = graph.delegateRoot(toPath)
        if (!pathsEqual(fromRoot, toRoot))
          fail({
            kind: 'delegate_root_mismatch',
            fromPath,
            toPath,
            fromRoot: encodePathKey(fromRoot),
            toRoot: encodePathKey(toRoot),
          })
        const from = graph.instance(fromPath)
        const to = graph.instance(toPath)
        if (from.kind === 'none' || to.kind === 'none') return
        const sourceFields = Object.entries(fromInstanceLens.schema.fields)
        for (const [name, spec] of sourceFields) {
          if (spec.metadata.sharedAcrossDelegates !== true) continue
          const targetSpec = toInstanceLens.schema.fields[name]
          if (targetSpec?.presence.mode !== 'required') continue
          const sourceField = from.value.fields.get(name)
          if (sourceField?.value.kind === 'some') continue
          fail({
            kind: 'schema_error',
            error: {
              kind: 'validation_failed',
              path: [...toPath, name],
              reason: 'cannot_delete_non_optional_node',
              detail: 'required shared field cannot represent the absent source value',
            },
          })
        }
        /*
         * Validate the whole location transfer before writing either body.
         * Both `fields` maps come from the Writer declarations, so declared
         * absence is distinguishable from a missing role without materializing
         * state, and physical presence decides only whether a value moves.
         */
        const fromParent = graph.singleRoleTarget(from.value, 'parent')
        const sourceParentField = this.parentField(from.value)
        const targetParentField = this.parentField(to.value)
        /** The source link that physically carries the location and its target. */
        const sourceLocation =
          fromParent.kind === 'some' && sourceParentField !== undefined
            ? { field: sourceParentField, target: fromParent.value }
            : undefined
        if (sourceLocation !== undefined) {
          if (sourceLocation.field.spec.presence.mode !== 'optional')
            fail({
              kind: 'schema_error',
              error: {
                kind: 'validation_failed',
                path: sourceLocation.field.path,
                reason: 'cannot_delete_non_optional_node',
                detail:
                  'cannot clear a required or defaulted parent link while activating a delegate',
              },
            })
        } else if (targetParentField !== undefined) {
          if (targetParentField.spec.presence.mode !== 'optional')
            fail({
              kind: 'schema_error',
              error: {
                kind: 'validation_failed',
                path: targetParentField.path,
                reason: 'cannot_delete_non_optional_node',
                detail:
                  'required or defaulted destination parent cannot represent an absent source location',
              },
            })
        }
        if (sourceLocation !== undefined) {
          if (targetParentField !== undefined)
            tx.set(fieldLensAt(tx, targetParentField.path), encodePathKey(sourceLocation.target))
          tx.delete(
            fieldLensAt(tx, sourceLocation.field.path) as FieldLens<
              LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }
            >,
          )
        } else if (targetParentField !== undefined) {
          tx.delete(
            fieldLensAt(tx, targetParentField.path) as FieldLens<
              LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }
            >,
          )
        }
        for (const [name, spec] of sourceFields) {
          if (spec.metadata.sharedAcrossDelegates !== true) continue
          const targetSpec = toInstanceLens.schema.fields[name]
          if (targetSpec === undefined) continue
          const sourceField = from.value.fields.get(name)
          const targetLens = fieldLensAt(tx, [...toPath, name])
          if (sourceField !== undefined && sourceField.value.kind === 'some') {
            const value = expectSchema(tx.get(fieldLensAt(tx, sourceField.path)))
            if (value.kind === 'some') tx.set(targetLens, value.value)
            continue
          }
          /*
           * Absence is shared state too: when the source no longer carries an
           * optional shared value, a stale copy on the destination must be
           * cleared instead of silently preserved. Required destinations were
           * rejected before any transfer; defaulted destinations reset to their
           * declaration's default rather than retaining a previous body's value.
           */
          if (targetSpec.presence.mode === 'optional')
            tx.delete(
              targetLens as FieldLens<
                LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }
              >,
            )
          else if (targetSpec.nodeKind === 'leaf' && targetSpec.presence.mode === 'defaulted')
            tx.set(
              targetLens,
              // Registered leaf defaults are validated against their value kind.
              targetSpec.presence.defaultValue as LeafValueTypeMap[LeafSchemaNode['valueKind']],
            )
        }
        const children = graph.childrenOf(fromPath)
        if (children.length === 0) return
        const fromKey = encodePathKey(fromPath)
        const toKey = encodePathKey(toPath)
        for (const child of children) {
          const childInstance = graph.instance(child)
          if (childInstance.kind === 'none') continue
          const childLens = structLensAt(tx, child)
          const parentField = this.parentField(childInstance.value)
          if (parentField !== undefined) tx.set(fieldLensAt(tx, parentField.path), toKey)
          this.transferChildOwnership(tx, childInstance.value, fromKey, toKey, parentField)
          const override = options?.visibilityOverrides?.[encodePathKey(child)]
          if (override !== undefined) tx.setInstanceMeta(childLens, { visibility: override })
          else if (options?.concealTransferredChildren === true)
            tx.setInstanceMeta(childLens, { visibility: 'self' })
        }
      }),
    )
  }

  /* ------------------------------------------------------------------ */
  /* 3. Safe projections                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Host-only raw standard public surface rooted at `sceneRoot`.
   *
   * This bypasses observer memory and divergence checks and is therefore NOT
   * an agent-safe projection: it must never be handed to a restricted
   * character agent when its own view diverges (blind/deaf, split ceilings,
   * super-priority exclusion or hallucination). Use {@link projectView} for
   * agents and this method for tools, UI inspection or shared-prefix tooling
   * only when the caller independently knows the raw surface is appropriate.
   * Publicly-visible link fields are emitted as their encoded pointer strings,
   * never dereferenced into hidden endpoint state.
   */
  projectScopePublic(
    commitId: CommitHash,
    sceneRoot: StructLens | Path,
  ): Result<ScenePublicProjection, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = this.view(commitId)
      return buildPublicProjection(this.deps(graph, commitId), observerPath(sceneRoot))
    })
  }

  /** Build a safe agent projection for one observer. */
  projectView(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<AgentWorldProjection, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = this.view(commitId)
      const resolved = this.resolveObserver(graph, observer)
      const deps = this.depsFor(graph, commitId, resolved.id)
      const ctx = this.contextFor(graph, deps, resolved)
      return buildProjection(deps, ctx)
    })
  }

  /** Fully expand requested field/instance paths. */
  inspect(
    commitId: CommitHash,
    observer: ObserverRef,
    targetPaths: readonly Path[],
  ): Result<readonly InspectedFieldView[], PerspectiveError> {
    return attemptPerspective(() => {
      const graph = this.view(commitId)
      const resolved = this.resolveObserver(graph, observer)
      const deps = this.depsFor(graph, commitId, resolved.id)
      const ctx = this.contextFor(graph, deps, resolved)
      return inspectPaths(deps, ctx, targetPaths, (path) =>
        fail({ kind: 'not_authorized', rootPerspectiveId: resolved.id, targetPath: path }),
      )
    })
  }

  /**
   * Host-only subjective/objective comparison for adjudication.
   *
   * The objective half reads the current commit through schema inspection, so
   * this API must only be exposed to Scene/World adjudicators and never to a
   * restricted character tool closure. `matchesObjectiveTruth` compares the
   * observer's primary value with the objective leaf value; an unauthorized or
   * missing subjective facet yields `false`. The method is read-only and does
   * not reveal the objective value through `inspect`/`projectView`.
   */
  inspectForAdjudication(
    commitId: CommitHash,
    observer: ObserverRef,
    targetPaths: readonly Path[],
  ): Result<readonly AdjudicatedPathResult[], PerspectiveError> {
    return attemptPerspective(() => {
      const graph = this.view(commitId)
      const resolved = this.resolveObserver(graph, observer)
      const deps = this.depsFor(graph, commitId, resolved.id)
      const ctx = this.contextFor(graph, deps, resolved)
      return adjudicatePaths(deps, ctx, targetPaths)
    })
  }

  /** Pre-filtered legal retrieval corpus. */
  listSearchableCorpus(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<readonly SearchableCorpusEntry[], PerspectiveError> {
    return attemptPerspective(() => {
      const graph = this.view(commitId)
      const resolved = this.resolveObserver(graph, observer)
      const deps = this.depsFor(graph, commitId, resolved.id)
      const ctx = this.contextFor(graph, deps, resolved)
      return buildCorpus(deps, ctx)
    })
  }

  /**
   * Read-only capability facade locked to one observer and commit.
   *
   * Methods close over an owned, frozen observer path (or immutable string),
   * retaining delegated-body perception while rejecting both mutable-input
   * aliasing and identity spoofing through `fn.call(other)`. The facade exposes
   * only `projectView`, `inspect` and `listSearchableCorpus`; it never exposes
   * adjudication, mutations, the world or the schema. All methods remain pure:
   * they create no perspective nodes and never advance heads.
   */
  asObserver(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<ScopedObserverPerspective, PerspectiveError> {
    return attemptPerspective(() => {
      const graph = this.view(commitId)
      const boundObserver =
        typeof observer === 'string' ? observer : Object.freeze([...observerPath(observer)])
      const resolved = this.resolveObserver(graph, boundObserver)
      const facade: ScopedObserverPerspective = Object.freeze({
        commitId,
        rootPerspectiveId: resolved.id,
        projectView: () => this.projectView(commitId, boundObserver),
        inspect: (paths: readonly Path[]) => this.inspect(commitId, boundObserver, paths),
        listSearchableCorpus: () => this.listSearchableCorpus(commitId, boundObserver),
      })
      return facade
    })
  }

  /* ------------------------------------------------------------------ */
  /* Internal persistence helpers                                       */
  /* ------------------------------------------------------------------ */

  private perspectiveEntry(tx: SchemaTransaction, id: string): StructLens {
    return structLensAt(tx, [...PERSPECTIVES_ROOT, id])
  }

  private perspectiveRecord(tx: SchemaTransaction, id: string): PerspectiveRecord {
    return new Graph(tx).perspectiveOrDefault(id)
  }

  private ensurePerspective(tx: SchemaTransaction, id: string, hostEntity: Option<Path>): void {
    const graph = new Graph(tx)
    if (graph.perspective(id).kind === 'some') return
    const map = graph.mapLens(PERSPECTIVES_ROOT)
    if (map.kind === 'none')
      fail({
        kind: 'schema_error',
        error: {
          kind: 'validation_failed',
          path: PERSPECTIVES_ROOT,
          reason: 'type_mismatch',
          detail: 'perspectives root is not a Map',
        },
      })
    const current = expectSchema(tx.get(map.value))
    const entries = current.kind === 'some' ? current.value : {}
    const input: Record<string, unknown> = {
      description: '',
      defaultPriority: DEFAULT_PERSPECTIVE_PRIORITY,
      inherits: [],
      nextSeq: 1,
      discoveredEntities: {},
      observedClaims: {},
      rumorClaims: {},
      exclusions: {},
    }
    if (hostEntity.kind === 'some') input.hostEntity = encodePathKey(hostEntity.value)
    tx.set(map.value, { ...entries, [id]: input })
  }

  private claimMap(tx: SchemaTransaction, id: string, field: string): MapLens {
    const entry = this.perspectiveEntry(tx, id)
    const lens = entry.field(field)
    if (lens.opticKind !== 'map')
      fail({
        kind: 'schema_error',
        error: {
          kind: 'validation_failed',
          path: [...PERSPECTIVES_ROOT, id, field],
          reason: 'type_mismatch',
          detail: 'claim collection is not a Map',
        },
      })
    return lens
  }

  private appendObserved(
    tx: SchemaTransaction,
    id: string,
    field: 'observedClaims' | 'discoveredEntities',
    key: string,
    input: ObservedClaimInput,
  ): void {
    const map = this.claimMap(tx, id, field)
    const current = expectSchema(tx.get(map))
    const entries = current.kind === 'some' ? current.value : {}
    tx.set(map, { ...entries, [key]: input })
  }

  private appendRumor(
    tx: SchemaTransaction,
    id: string,
    field: 'rumorClaims',
    key: string,
    input: RumorClaimInput,
  ): void {
    const map = this.claimMap(tx, id, field)
    const current = expectSchema(tx.get(map))
    const entries = current.kind === 'some' ? current.value : {}
    tx.set(map, { ...entries, [key]: input })
  }

  private appendExclusion(
    tx: SchemaTransaction,
    id: string,
    key: string,
    input: ExclusionClaimInput,
  ): void {
    const map = this.claimMap(tx, id, 'exclusions')
    const current = expectSchema(tx.get(map))
    const entries = current.kind === 'some' ? current.value : {}
    tx.set(map, { ...entries, [key]: input })
  }

  private bumpSeq(tx: SchemaTransaction, id: string, next: number): void {
    tx.set(fieldLensAt(tx, [...PERSPECTIVES_ROOT, id, 'nextSeq']), next)
  }

  private writeDiscovery(
    tx: SchemaTransaction,
    id: string,
    record: PerspectiveRecord,
    entityPath: Path,
    options?: GrantKnowledgeOptions,
  ): void {
    const at = options?.atCommitId ?? SELF_COMMIT
    const acquiredAt = options?.acquiredAtCommitId ?? SELF_COMMIT
    const key = encodePathKey(entityPath)
    const seq = record.nextSeq
    const origin =
      options?.originEventRef ??
      ({
        commitId: SELF_COMMIT,
        path: [...PERSPECTIVES_ROOT, id, 'discoveredEntities', key],
      } as StateRef)
    this.appendObserved(tx, id, 'discoveredEntities', key, {
      seq,
      targetRef: { commitId: at, path: entityPath },
      eventRef: { commitId: acquiredAt, path: ['$message'] },
      originEventRef: origin,
      priority: options?.priority ?? record.defaultPriority,
      override: options?.override ?? true,
      belief: options?.belief ?? 'believed',
      coWitnesses: this.coWitnessKeys(options?.coWitnesses),
      ...(options?.source !== undefined ? { source: options.source } : {}),
    })
    this.bumpSeq(tx, id, seq + 1)
  }

  private writeObservation(
    tx: SchemaTransaction,
    id: string,
    record: PerspectiveRecord,
    targetPath: Path,
    options?: GrantKnowledgeOptions,
  ): void {
    const at = options?.atCommitId ?? SELF_COMMIT
    const acquiredAt = options?.acquiredAtCommitId ?? SELF_COMMIT
    const seq = record.nextSeq
    const key = `${encodePathKey(targetPath)}#${seq}`
    const origin =
      options?.originEventRef ??
      ({
        commitId: SELF_COMMIT,
        path: [...PERSPECTIVES_ROOT, id, 'observedClaims', key],
      } as StateRef)
    this.appendObserved(tx, id, 'observedClaims', key, {
      seq,
      targetRef: { commitId: at, path: targetPath },
      eventRef: { commitId: acquiredAt, path: ['$message'] },
      originEventRef: origin,
      priority: options?.priority ?? record.defaultPriority,
      override: options?.override ?? true,
      belief: options?.belief ?? 'believed',
      coWitnesses: this.coWitnessKeys(options?.coWitnesses),
      ...(options?.source !== undefined ? { source: options.source } : {}),
    })
    this.bumpSeq(tx, id, seq + 1)
  }

  private surfaceFields(graph: PerspectiveGraph, instancePath: Path): readonly { path: Path }[] {
    const instance = graph.instance(instancePath)
    if (instance.kind === 'none') return []
    return [...instance.value.fields.values()]
      .filter((field) => graph.fieldVisibility(field) === 'surface')
      .filter((field) => !isEphemeralSpec(field.spec))
      .filter((field) => field.value.kind === 'some')
  }

  /**
   * Reject persistence according to the declaration authorizing the fact.
   *
   * Live writes also consult the current Reader declaration so absent typed
   * targets cannot bypass ephemerality. Historical facts consult only their
   * stored Writer declaration, even without a physical value, optional ancestor
   * or Map member. `viewAt(oldCommit)` still captures today's Reader catalog,
   * which must never revoke or weaken old persistence restrictions. Custom
   * leaves use stored fact-time declarations; event/instance paths are not fields.
   *
   * @param graph - Current draft or the referenced fact snapshot.
   * @param targetPath - Logical fact target.
   * @param context - Whether current Reader restrictions may participate.
   * @throws PerspectiveFailure carrying `invalid_claim_target` before writing.
   */
  private assertPersistentClaimTarget(
    graph: PerspectiveGraph,
    targetPath: Path,
    context: 'live' | 'historical' = 'live',
  ): void {
    const declaration = graph.writerSchemaAt(targetPath)
    const ephemeralWriter =
      declaration.kind === 'some' &&
      declaration.value.nodeKind === 'leaf' &&
      isEphemeralSpec(declaration.value)
    if (
      ephemeralWriter ||
      (context === 'live' && isEphemeralSpec(this.leafSpecAt(graph, targetPath)))
    )
      fail({
        kind: 'invalid_claim_target',
        targetPath,
        reason: 'cannot_persist_claim_on_ephemeral_field',
      })
  }

  /**
   * Apply the persistence guard to the declaration that authorizes a source
   * facet, never to an unrelated current objective probe.
   *
   * Live perception is judged against the current declaration, so a genuinely
   * current ephemeral field still cannot be retold. A durable observed claim is
   * judged only at its recorded `targetRef` fact commit: an unknown later
   * redefinition of the same path (typical for instance-specific custom
   * leaves) can neither revoke the old claim nor manufacture a new
   * restriction. A literal rumor carries its own encoded payload, so it is
   * copied verbatim without consulting the objective node at all.
   *
   * @param graph - Current transaction graph.
   * @param facet - Winning source facet being retold.
   * @param targetPath - Logical path requested by the caller.
   */
  private assertRetellableFacet(graph: PerspectiveGraph, facet: FoldFacet, targetPath: Path): void {
    if (facet.sourceKind === 'rumor_claim') return
    if (facet.sourceKind === 'observed_claim') {
      const ref = facet.targetRef
      if (ref.kind === 'none') return
      const factGraph = ref.value.commitId === SELF_COMMIT ? graph : this.view(ref.value.commitId)
      this.assertPersistentClaimTarget(factGraph, ref.value.path, 'historical')
      return
    }
    this.assertPersistentClaimTarget(graph, targetPath)
  }

  /**
   * Classify a retold target as a whole entity or a leaf fact.
   *
   * Live facets describe the current scene, so current structural existence is
   * authoritative for them. A durable observed claim is classified only by its
   * source record table and its own fact snapshot: a discovered entity that
   * has since been deleted stays a structural identity, while a remembered
   * leaf can never be promoted into an entity by a later current shape.
   * Rumors never assert objective structure.
   *
   * @param graph - Current transaction graph.
   * @param evaluator - Source observer's fold evaluator.
   * @param facet - Winning source facet.
   * @param targetPath - Logical path requested by the caller.
   * @returns True when the receiver must get a `discoveredEntities` record.
   */
  private retellsEntity(
    graph: PerspectiveGraph,
    evaluator: ClaimEvaluator,
    facet: FoldFacet,
    targetPath: Path,
  ): boolean {
    if (facet.sourceKind === 'direct_scope' || facet.sourceKind === 'self_owned')
      return graph.instance(targetPath).kind === 'some'
    if (facet.sourceKind === 'rumor_claim') return false
    const ref = facet.targetRef
    if (ref.kind === 'none') return false
    if (evaluator.claimPaths().structural.some((path) => pathsEqual(path, ref.value.path)))
      return true
    const factGraph = ref.value.commitId === SELF_COMMIT ? graph : this.view(ref.value.commitId)
    const inspection = factGraph.inspect(ref.value.path)
    return inspection.kind === 'some' && inspection.value.nodeKind === 'struct'
  }

  private leafSpecAt(graph: PerspectiveGraph, path: Path): LeafSchemaNode | undefined {
    try {
      const lens = graph.fieldLens(path)
      if (lens.kind === 'some') return lens.value.schema
    } catch (cause) {
      if (!(cause instanceof PerspectiveFailure)) throw cause
    }
    const inspection = graph.inspect(path)
    return inspection.kind === 'some' && inspection.value.nodeKind === 'leaf'
      ? inspection.value.writerSpec
      : undefined
  }

  private coWitnessKeys(observers: readonly ObserverRef[] | undefined): readonly string[] {
    if (!observers) return []
    return Object.freeze(
      [...new Set(observers.map((observer) => this.observerKey(observer)))].sort(),
    )
  }

  private observerKey(observer: ObserverRef): string {
    if (typeof observer === 'string') return observer
    return encodePathKey(observerPath(observer))
  }

  private observerLabel(observer: ObserverRef, resolved: ResolvedObserver): string {
    if (typeof observer === 'string') return observer
    return resolved.id
  }

  private currentLeaf(
    graph: PerspectiveGraph,
    path: Path,
  ): Option<{ value: Value | StateRef; meta: SchemaMetaMap }> {
    const inspection = graph.inspect(path)
    if (inspection.kind === 'none' || inspection.value.nodeKind !== 'leaf') return NONE
    return some({ value: inspection.value.value, meta: inspection.value.meta })
  }

  private historicalMatchesCurrent(
    graph: PerspectiveGraph,
    ref: StateRef,
    current: Option<{ value: Value | StateRef; meta: SchemaMetaMap }>,
  ): boolean {
    if (current.kind === 'none') return false
    const inspection =
      ref.commitId === SELF_COMMIT
        ? graph.inspect(ref.path)
        : expectSchema(this.ctx.schema.inspectInstance(ref.commitId, ref.path))
    if (inspection.kind === 'none') return false
    const leaf = inspection.value
    if (leaf.nodeKind !== 'leaf') return false
    return (
      valueOrRefEquals(leaf.value, current.value.value) && metaEquals(leaf.meta, current.value.meta)
    )
  }

  /**
   * Select the exclusive parent slot, preferring a populated declaration.
   *
   * Writer-backed fields retain optional declarations without inventing values.
   * If every single-target parent is absent, the first declaration supplies the
   * location slot. Ownership must not use this policy: it is a multi-target
   * relation whose independent scalar/list edges are migrated separately.
   */
  private parentField(instance: StructInstance): FieldNode | undefined {
    let absent: FieldNode | undefined
    for (const field of instance.fields.values()) {
      if (field.spec.valueKind !== 'str' || !hasLinkRole(field.spec, 'parent')) continue
      if (field.value.kind === 'some') return field
      absent ??= field
    }
    return absent
  }

  /**
   * Move only this carried child's declared owner edges naming the source body.
   *
   * Every scalar field is considered independently; an absent field or an edge
   * to a different co-owner is left untouched. A list is rewritten only if it
   * contains `fromKey`, then deduplicated in stable first-occurrence order after
   * replacement. Ownership implied by delegate/edge roles is not retargeted.
   * A combined parent/owner slot has already moved with the parent and is
   * skipped to avoid a redundant write. All writes retain leaf metadata and
   * participate in the enclosing activation savepoint.
   *
   * @param tx - Current atomic activation draft.
   * @param instance - Child snapshot captured before its parent was rewritten.
   * @param fromKey - Encoded source body path, not its delegation root.
   * @param toKey - Encoded destination body path.
   * @param movedParent - Parent slot already rewritten, possibly also an owner.
   */
  private transferChildOwnership(
    tx: SchemaTransaction,
    instance: StructInstance,
    fromKey: string,
    toKey: string,
    movedParent: FieldNode | undefined,
  ): void {
    for (const field of instance.fields.values()) {
      if (field === movedParent || !hasLinkRole(field.spec, 'owner')) continue
      if (field.value.kind === 'none') continue
      const value = field.value.value
      if (field.spec.valueKind === 'str') {
        if (value === fromKey) tx.set(fieldLensAt(tx, field.path), toKey)
        continue
      }
      if (field.spec.valueKind !== 'list:str' || !Array.isArray(value) || !value.includes(fromKey))
        continue
      const seen = new Set<string>()
      const owners: string[] = []
      // Writer inspection validates the declared list:str before this snapshot.
      for (const owner of value as readonly string[]) {
        const target = owner === fromKey ? toKey : owner
        if (seen.has(target)) continue
        seen.add(target)
        owners.push(target)
      }
      tx.set(fieldLensAt(tx, field.path), owners)
    }
  }

  /**
   * Resolve one path's top facet as seen by the observer.
   *
   * Live ownership (`self_owned`) covers only the instance itself and its
   * `'self'`-visible fields. Surface fields still require an actual channel
   * scope, ownership never promotes an explicit `'ref'` field, and a missing
   * scope (for example a pure organisation perspective with no staged body)
   * never produces `direct_scope`. Paths without a live facet fall back to the
   * inherited claim fold, so historical access stays claim-gated.
   */
  private subjectiveTop(
    graph: PerspectiveGraph,
    evaluator: ClaimEvaluator,
    observer: ResolvedObserver,
    path: Path,
    scope: Option<ObserverScopeState>,
  ): Option<SubjectiveTop> {
    const instance = path.length > 1 ? graph.instance(fieldInstancePath(path)) : NONE
    if (instance.kind === 'some') {
      const field = [...instance.value.fields.values()].find((candidate) =>
        pathsEqual(candidate.path, path),
      )
      if (field && field.value.kind === 'some') {
        const owned = this.ownsEntity(graph, observer, instance.value.path)
        const visibility = graph.fieldVisibility(field)
        const surface = visibility === 'surface'
        const selfInstance = graph.instanceVisibility(instance.value) === 'self'
        const selfOwned = owned && visibility !== 'ref' && (visibility === 'self' || selfInstance)
        let liveKind: 'direct_scope' | 'self_owned' | undefined
        if (selfOwned) liveKind = 'self_owned'
        else if (
          surface &&
          !selfInstance &&
          scope.kind === 'some' &&
          this.channelReaches(
            scope.value,
            instance.value.path,
            field.spec.metadata.sense === 'sound' ? 'sound' : 'sight',
          )
        )
          liveKind = 'direct_scope'
        if (liveKind) {
          const fold = evaluator.fold(path, {
            kind: liveKind,
            value: field.value.value,
            summary: summaryOf(field.meta),
          })
          if (fold.primary.kind === 'some') return some(this.toSubjective(fold.primary.value, path))
        }
      }
    }
    const targetInstance = graph.instance(path)
    if (targetInstance.kind === 'some') {
      const owned = this.ownsEntity(graph, observer, path)
      const canSee =
        owned || (scope.kind === 'some' && this.channelReaches(scope.value, path, 'sight'))
      if (canSee) {
        const fold = evaluator.fold(path, {
          kind: owned ? 'self_owned' : 'direct_scope',
          value: null,
          summary: NONE,
        })
        if (fold.primary.kind === 'some') return some(this.toSubjective(fold.primary.value, path))
      }
    }
    const fold = evaluator.fold(path)
    return fold.primary.kind === 'some' ? some(this.toSubjective(fold.primary.value, path)) : NONE
  }

  private channelReaches(
    scope: ObserverScopeState,
    instancePath: Path,
    channel: 'sight' | 'sound',
  ): boolean {
    const state = channel === 'sight' ? scope.sight : scope.sound
    return state.reachablePaths.has(encodePathKey(instancePath))
  }

  private toSubjective(facet: FoldFacet, path: Path): SubjectiveTop {
    return {
      facet,
      targetRef:
        facet.targetRef.kind === 'some' ? facet.targetRef.value : { commitId: SELF_COMMIT, path },
    }
  }

  /**
   * Whether `target` is the observer's own body or reachable from it along
   * implicit ownership edges.
   *
   * `'owner'` links mark private ownership, `'delegate'` bodies belong to the
   * same root mind, and `'edge_from'` implicitly implies ownership of a
   * directed edge entity. Roles are read through the canonical
   * `hasLinkRole` predicate, so implicit `exclusiveRole` declarations carry
   * the same ownership as explicit `linkRoles`. Traversal is cycle-safe for
   * malformed drafts.
   */
  private ownsEntity(graph: PerspectiveGraph, observer: ResolvedObserver, target: Path): boolean {
    if (observer.rootEntity.kind === 'none') return false
    const owned = new Set<string>([encodePathKey(observer.rootEntity.value)])
    const queue: Path[] = [observer.rootEntity.value]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const entry of graph.backlinks(current)) {
        if (!hasLinkRole(entry.fieldSpec, 'owner', 'delegate', 'edge_from')) continue
        const key = encodePathKey(entry.sourceInstancePath)
        if (owned.has(key)) continue
        owned.add(key)
        queue.push(entry.sourceInstancePath)
      }
    }
    return owned.has(encodePathKey(target))
  }
}

/** Depth-first cycle detection over an inheritance/parent edge map. */
function findCycle(edges: ReadonlyMap<string, readonly string[]>): string | null {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): string | null => {
    if (visiting.has(id)) return id
    if (visited.has(id)) return null
    visiting.add(id)
    for (const parent of edges.get(id) ?? []) {
      const cycle = visit(parent)
      if (cycle !== null) return cycle
    }
    visiting.delete(id)
    visited.add(id)
    return null
  }
  for (const id of edges.keys()) {
    const cycle = visit(id)
    if (cycle !== null) return cycle
  }
  return null
}

function isPerspectiveValue(value: unknown): value is Value {
  if (value === null) return true
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return true
  if (value instanceof Uint8Array) return true
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item === null ||
        typeof item === 'boolean' ||
        typeof item === 'number' ||
        typeof item === 'string' ||
        item instanceof Uint8Array,
    )
  )
}

function summaryOf(meta: SchemaMetaMap): Option<string> {
  const summary = meta.summary
  return typeof summary === 'string' ? some(summary) : NONE
}

function fieldLensAt(tx: SchemaTransaction, path: Path): FieldLens {
  const lens = expectSchema(tx.lensAt(path))
  if (lens.opticKind !== 'field')
    fail({
      kind: 'schema_error',
      error: {
        kind: 'validation_failed',
        path,
        reason: 'type_mismatch',
        detail: 'expected a declared field lens',
      },
    })
  return lens
}

function structLensAt(tx: SchemaTransaction, path: Path): StructLens {
  const lens = expectSchema(tx.lensAt(path))
  if (lens.opticKind !== 'struct')
    fail({
      kind: 'schema_error',
      error: {
        kind: 'validation_failed',
        path,
        reason: 'type_mismatch',
        detail: 'expected a struct lens',
      },
    })
  return lens
}
