/**
 * Scene scope synchronization.
 *
 * Refreshes persistent surface memories for observer bodies in a scene
 * subtree. Only observations are written: containment, sensory switches,
 * discoveries and exclusions stay fixed. Each recording body folds with its
 * own channel ceilings, actor sensory switches and cognitive exclusions.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { SchemaTransaction, StructLens } from '@sekaisen/plugin-schema'
import type { Path, StateRef } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import { isDirectPersonalObservation } from './claims.ts'
import { isGlobalSurfaceField } from './global-surface.ts'
import { PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective } from './internal.ts'
import type { PerspectiveReader } from './reader.ts'
import { observerPath } from './reader.ts'
import { PERSPECTIVES_ROOT } from './schemas.ts'
import type { WitnessContext } from './scope.ts'
import { computeObserverScope, coWitnessesFor } from './scope.ts'
import { appendClaim, bumpSeq, ensurePerspective, perspectiveRecord } from './store.ts'
import type { PerspectiveError, SyncScopeOptions } from './types.ts'
import type { FieldSalience } from './visibility.ts'
import { isEphemeralSpec } from './visibility.ts'

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
 * - declared `globalSurface` fields are omitted: they are live data feeds
 *   re-read from the projection commit on every read, so persisting a
 *   snapshot here would only manufacture stale observations;
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
export function syncScope(
  reader: PerspectiveReader,
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
      const resolved = reader.resolveObserver(graph, witness)
      if (resolved.entity.kind === 'some')
        actors.set(encodePathKey(resolved.entity.value), resolved.entity.value)
    }
    // Materialize explicit witnesses before folding anyone's public evidence,
    // so co-witness membership cannot depend on actor refresh order.
    for (const actorPath of actors.values()) {
      const root = graph.delegateRoot(actorPath)
      ensurePerspective(tx, encodePathKey(root), some(root))
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
      const evaluator = reader.evaluatorFor(graph, encodePathKey(root))
      const context = { evaluator, scope: computeObserverScope(graph, evaluator, body) }
      witnessContexts.set(key, context)
      return some(context)
    }

    for (const [actorKey, actorPath] of actors) {
      graph = new Graph(tx)
      const root = graph.delegateRoot(actorPath)
      const mindId = encodePathKey(root)
      const evaluator = reader.evaluatorFor(graph, mindId)
      const cachedWitness = witnessContexts.get(actorKey)
      const scope = cachedWitness?.scope ?? computeObserverScope(graph, evaluator, actorPath)
      if (!cachedWitness) witnessContexts.set(actorKey, { evaluator, scope })
      const visible = new Map<string, Path>([
        ...scope.sight.reachablePaths,
        ...scope.sound.reachablePaths,
      ])
      const personal = perspectiveRecord(tx, mindId)
      let seq = personal.nextSeq
      for (const instancePath of visible.values()) {
        const instance = graph.instance(instancePath)
        if (instance.kind === 'none') continue
        for (const field of instance.value.fields.values()) {
          if (field.value.kind === 'none') continue
          if (graph.fieldVisibility(field) !== 'surface') continue
          if (isEphemeralSpec(field.spec)) continue
          /*
           * Global feeds are read live from whatever commit a projection is
           * bound to. Persisting one here would freeze a snapshot that later
           * shadows the actual clock, so sync never writes them.
           */
          if (isGlobalSurfaceField(graph, instance.value, field)) continue
          const channel = field.spec.metadata.sense === 'sound' ? 'sound' : 'sight'
          const channelScope = channel === 'sight' ? scope.sight : scope.sound
          if (!channelScope.reachablePaths.has(encodePathKey(instancePath))) continue
          const metaSummary = field.meta.summary
          const fold = evaluator.fold(field.path, {
            kind: 'direct_scope',
            value: field.value.value,
            summary: typeof metaSummary === 'string' ? some(metaSummary) : NONE,
          })
          if (fold.primary.kind === 'none' || fold.primary.value.sourceKind !== 'direct_scope')
            continue
          const focusedPath =
            focused.has(encodePathKey(field.path)) || focused.has(encodePathKey(instancePath))
          const salience: FieldSalience = graph.fieldSalience(instance.value, field)
          if (salience === 'passive' && !focusedPath) continue
          const witnesses = coWitnessesFor(graph, scope, field.path, channel, witnessFor)
          const personalTop = evaluator.personalObservedTop(personal, field.path)
          const current = reader.currentLeaf(graph, field.path)
          let sameValueOrigin: StateRef | undefined
          if (personalTop.kind === 'some') {
            const record = personalTop.value
            const direct = isDirectPersonalObservation(mindId, record)
            const sameValue = reader.historicalMatchesCurrent(graph, record.targetRef, current)
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
          appendClaim(tx, mindId, 'observedClaims', key, {
            seq,
            targetRef: { commitId: SELF_COMMIT, path: field.path },
            eventRef: { commitId: SELF_COMMIT, path: ['$message'] },
            originEventRef: origin,
            priority: personal.defaultPriority,
            override: true,
            belief: 'believed',
            coWitnesses: witnesses,
          })
          seq++
          bumpSeq(tx, mindId, seq)
        }
      }
    }
  })
}
