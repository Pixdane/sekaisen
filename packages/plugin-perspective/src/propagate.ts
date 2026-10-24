/**
 * Knowledge retelling.
 *
 * The sender's current subjective top is folded through the same arbitration
 * used by projections, including live perception only when the sender
 * genuinely reaches the target. The receiver gets the sender's fact reference
 * (or rumor payload) and origin chain; only the acquisition event advances.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import type { Path, StateRef } from '@sekaisen/plugin-world'
import { encodePathKey, encodeValue, SELF_COMMIT } from '@sekaisen/plugin-world'
import { assertRetellableFacet, retellsEntity } from './claim-policy.ts'
import type { ClaimEvaluator, FoldFacet } from './claims.ts'
import type { PerspectiveGraph } from './graph.ts'
import { fieldInstancePath, PerspectiveGraph as Graph, pathsEqual } from './graph.ts'
import { attemptPerspective, fail } from './internal.ts'
import type { PerspectiveReader, ResolvedObserver } from './reader.ts'
import { coWitnessKeys, isPerspectiveValue } from './reader.ts'
import type { RumorClaimInput } from './schemas.ts'
import { PERSPECTIVES_ROOT } from './schemas.ts'
import type { ObserverScopeState } from './scope.ts'
import { computeObserverScope } from './scope.ts'
import { appendClaim, bumpSeq, ensurePerspective, perspectiveRecord } from './store.ts'
import type { ObserverRef, PerspectiveError, PropagateKnowledgeOptions } from './types.ts'
import { hasLinkRole } from './visibility.ts'

interface SubjectiveTop {
  readonly facet: FoldFacet
  readonly targetRef: StateRef
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
export function propagateKnowledge(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  fromObserver: ObserverRef,
  toObserver: ObserverRef,
  targetPath: Path,
  options?: PropagateKnowledgeOptions,
): Result<void, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = new Graph(tx)
    const from = reader.resolveObserver(graph, fromObserver)
    const to = reader.resolveObserver(graph, toObserver)
    const evaluator = reader.evaluatorFor(graph, from.id)
    const scope =
      from.entity.kind === 'some' && graph.instance(from.entity.value).kind === 'some'
        ? some(computeObserverScope(graph, evaluator, from.entity.value))
        : NONE
    const top = subjectiveTop(graph, evaluator, from, targetPath, scope)
    if (top.kind === 'none')
      fail({ kind: 'not_authorized', rootPerspectiveId: from.id, targetPath })
    const facet = top.value.facet
    assertRetellableFacet(reader, graph, facet, targetPath)
    ensurePerspective(tx, to.id, to.rootEntity)
    const targetRecord = perspectiveRecord(tx, to.id)
    const priority = options?.priority ?? targetRecord.defaultPriority
    const acquiredAt = options?.acquiredAtCommitId ?? SELF_COMMIT
    const source =
      options?.claimedSource ?? (typeof fromObserver === 'string' ? fromObserver : from.id)
    const coWitnesses = coWitnessKeys(options?.coWitnesses)
    const targetIsInstance = retellsEntity(reader, graph, evaluator, facet, targetPath)

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
      appendClaim(tx, to.id, 'rumorClaims', key, input)
      bumpSeq(tx, to.id, seq + 1)
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
    appendClaim(tx, to.id, collection, key, {
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
    })
    bumpSeq(tx, to.id, seq + 1)
  })
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
function subjectiveTop(
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
      const owned = ownsEntity(graph, observer, instance.value.path)
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
        channelReaches(
          scope.value,
          instance.value.path,
          field.spec.metadata.sense === 'sound' ? 'sound' : 'sight',
        )
      )
        liveKind = 'direct_scope'
      if (liveKind) {
        const summary = field.meta.summary
        const fold = evaluator.fold(path, {
          kind: liveKind,
          value: field.value.value,
          summary: typeof summary === 'string' ? some(summary) : NONE,
        })
        if (fold.primary.kind === 'some') return some(toSubjective(fold.primary.value, path))
      }
    }
  }
  const targetInstance = graph.instance(path)
  if (targetInstance.kind === 'some') {
    const owned = ownsEntity(graph, observer, path)
    const canSee = owned || (scope.kind === 'some' && channelReaches(scope.value, path, 'sight'))
    if (canSee) {
      const fold = evaluator.fold(path, {
        kind: owned ? 'self_owned' : 'direct_scope',
        value: null,
        summary: NONE,
      })
      if (fold.primary.kind === 'some') return some(toSubjective(fold.primary.value, path))
    }
  }
  const fold = evaluator.fold(path)
  return fold.primary.kind === 'some' ? some(toSubjective(fold.primary.value, path)) : NONE
}

function channelReaches(
  scope: ObserverScopeState,
  instancePath: Path,
  channel: 'sight' | 'sound',
): boolean {
  const state = channel === 'sight' ? scope.sight : scope.sound
  return state.reachablePaths.has(encodePathKey(instancePath))
}

function toSubjective(facet: FoldFacet, path: Path): SubjectiveTop {
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
function ownsEntity(graph: PerspectiveGraph, observer: ResolvedObserver, target: Path): boolean {
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
