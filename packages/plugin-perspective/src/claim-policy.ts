/**
 * Claim persistence and retelling policy.
 *
 * These checks decide whether an epistemological fact may be committed, but
 * never write it. Historical facts are judged only through their recorded
 * Writer declaration; only live facts may consult today's Reader.
 */

import type { Path } from '@sekaisen/plugin-world'
import { SELF_COMMIT } from '@sekaisen/plugin-world'
import type { ClaimEvaluator, FoldFacet } from './claims.ts'
import type { PerspectiveGraph } from './graph.ts'
import { pathsEqual } from './graph.ts'
import { fail } from './internal.ts'
import type { PerspectiveReader } from './reader.ts'
import { isEphemeralSpec } from './visibility.ts'

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
export function assertPersistentClaimTarget(
  reader: PerspectiveReader,
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
    (context === 'live' && isEphemeralSpec(reader.leafSpecAt(graph, targetPath)))
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
export function assertRetellableFacet(
  reader: PerspectiveReader,
  graph: PerspectiveGraph,
  facet: FoldFacet,
  targetPath: Path,
): void {
  if (facet.sourceKind === 'rumor_claim') return
  if (facet.sourceKind === 'observed_claim') {
    const ref = facet.targetRef
    if (ref.kind === 'none') return
    const factGraph = ref.value.commitId === SELF_COMMIT ? graph : reader.view(ref.value.commitId)
    assertPersistentClaimTarget(reader, factGraph, ref.value.path, 'historical')
    return
  }
  assertPersistentClaimTarget(reader, graph, targetPath)
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
export function retellsEntity(
  reader: PerspectiveReader,
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
  const factGraph = ref.value.commitId === SELF_COMMIT ? graph : reader.view(ref.value.commitId)
  const inspection = factGraph.inspect(ref.value.path)
  return inspection.kind === 'some' && inspection.value.nodeKind === 'struct'
}
