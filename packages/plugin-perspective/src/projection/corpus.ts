/**
 * Retrieval corpus construction.
 *
 * The corpus shares authorized collection with the projection but retains
 * folded supporting evidence. It emits only the observer's subjective text
 * and hash ingredients, plus authorization-filtered linked entities. Ranking
 * is deliberately left to the caller.
 */

import type { Option } from '@sekaisen/core'
import { BinaryHasher, NONE, some } from '@sekaisen/core'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import { globalSurfaceCandidate } from '../global-surface.ts'
import type { FieldNode } from '../graph.ts'
import { fieldInstancePath, linkTargets, pathsEqual, sortedUniquePaths } from '../graph.ts'
import { readableMemoryRelatedEntities } from '../memory-access.ts'
import { isSelfOwnedField } from '../ownership.ts'
import type { CognitiveMemoryRecord } from '../schemas.ts'
import type { LinkedEntity, SearchableCorpusEntry } from '../types.ts'
import { isEphemeralSpec, isLinkSpec } from '../visibility.ts'
import { collect, subsumedInstanceKeys } from './collect.ts'
import type { FieldEntry, ObserverContext, ProjectionDeps } from './context.ts'
import { factOf, isInLiveScope, snapshotGraph } from './context.ts'
import { liveFold } from './fields.ts'

function renderValue(value: Value | StateRef): string {
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return String(value)
  if ('commitId' in value) return `ref:${value.commitId}:${encodePathKey(value.path)}`
  return `[${value.map((item) => (item instanceof Uint8Array ? `0x${Buffer.from(item).toString('hex')}` : String(item))).join(', ')}]`
}

function contentHash(text: string, summary: Option<string>): string {
  const hasher = new BinaryHasher('perspective-corpus')
  hasher.writeString(text)
  hasher.writeString(summary.kind === 'some' ? summary.value : '')
  return hasher.digestHex()
}

/**
 * Whether a link field is authorized strongly enough to expose its targets.
 *
 * Authorization has two disjoint sources:
 * - for an entry anchored to the current commit, the link field must be
 *   genuinely live for this observer: declared global feed, effective public
 *   visibility in the current channel scope, or legitimate self-ownership, and
 *   its live facet must win the fold (exclusions and belief are respected);
 * - for any fact snapshot, an `observed_claim` about that exact link field
 *   must be anchored to the same commit and survive the fold.
 *
 * Rumor claims never authorize reading or comparing the objective relation:
 * a guessed link that matches the hidden target is not evidence of sight.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param instancePath - Owning instance path.
 * @param factField - Link field read from the fact snapshot.
 * @param factCommitId - Commit that the corpus entry is anchored to.
 * @returns True when this link field's fact-time contents may be used.
 */
function linkFieldAuthorized(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  instancePath: Path,
  factField: FieldNode,
  factCommitId: CommitHash,
): boolean {
  if (factCommitId === deps.commitId) {
    const current = deps.graph.instance(instancePath)
    if (current.kind === 'some') {
      const currentField = [...current.value.fields.values()].find((candidate) =>
        pathsEqual(candidate.path, factField.path),
      )
      if (currentField) {
        const global = globalSurfaceCandidate(deps.graph, ctx.actor, current.value, currentField)
        if (global.kind === 'some') {
          const fold = deps.evaluator.fold(currentField.path, global.value)
          if (
            fold.primary.kind === 'some' &&
            fold.primary.value.sourceKind === 'direct_scope' &&
            fold.primary.value.belief !== 'known_false'
          )
            return true
        }
        if (
          ctx.owned.has(encodePathKey(instancePath)) &&
          isSelfOwnedField(deps.graph, current.value, currentField)
        ) {
          const fold = liveFold(deps, currentField, 'self_owned', ctx.scope, current.value)
          if (
            fold.primary.kind === 'some' &&
            fold.primary.value.sourceKind === 'self_owned' &&
            fold.primary.value.belief !== 'known_false'
          )
            return true
        }
        const fold = liveFold(deps, currentField, 'direct_scope', ctx.scope, current.value)
        if (
          fold.primary.kind === 'some' &&
          fold.primary.value.sourceKind === 'direct_scope' &&
          fold.primary.value.belief !== 'known_false'
        )
          return true
      }
    }
  }
  return deps.evaluator
    .fold(factField.path)
    .facets.some(
      (facet) =>
        facet.sourceKind === 'observed_claim' &&
        facet.belief !== 'known_false' &&
        factOf(facet, deps.commitId) === factCommitId,
    )
}

/**
 * Whether a link target is visible in the observer's effective current view.
 *
 * Ownership and live scope cover the physical public/private channels; the
 * evaluator's canonical effective-discovery predicate covers remembered hidden
 * targets, so overrides, exclusions and `known_false` discoveries agree with
 * live access and structural snapshot expansion. A rumor about a path is not
 * sight and never authorizes the pointer.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param target - Candidate target instance path.
 * @returns True when the target identity may be disclosed.
 */
function authorizedTarget(deps: ProjectionDeps, ctx: ObserverContext, target: Path): boolean {
  if (ctx.owned.has(encodePathKey(target))) return true
  if (isInLiveScope(ctx, target)) return true
  return deps.evaluator
    .effectiveDiscoveredPaths()
    .some((discovered) => pathsEqual(discovered, target))
}

/**
 * Current authorized path for a linked entity coordinate.
 *
 * `currentPath` is disclosed only when the observer currently perceives or
 * owns the identity. For off-scene entities known only through memory, the
 * objective current existence is deliberately not probed: an unknown
 * deletion/reappearance must not change the projected relation.
 *
 * @param ctx - Observer context.
 * @param target - Entity path.
 * @returns The same path when currently live/owned, otherwise `NONE`.
 */
function currentLinkedPath(ctx: ObserverContext, target: Path): Option<Path> {
  const key = encodePathKey(target)
  return ctx.owned.has(key) || isInLiveScope(ctx, target) ? some(target) : NONE
}

/** Deterministic relation preference used when one ref is reached twice. */
const LINKED_RELATION_RANK: Record<LinkedEntity['relation'], number> = {
  current_link: 0,
  historical_link: 1,
  ref_target: 2,
  memory_entity: 3,
}

/**
 * Stable de-duplication of linked entities by exact `(commitId, path)`.
 *
 * Different commits of the same logical entity remain distinct entries. When
 * one exact coordinate is reachable through several relations, the earliest
 * relation rank wins deterministically.
 *
 * @param entities - Candidate linked entities.
 * @returns Frozen, `(commitId, pathKey)` sorted list.
 */
function finalizeLinkedEntities(entities: readonly LinkedEntity[]): readonly LinkedEntity[] {
  const byKey = new Map<string, LinkedEntity>()
  for (const entity of entities) {
    const key = `${entity.ref.commitId}\u0000${encodePathKey(entity.ref.path)}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, entity)
      continue
    }
    if (LINKED_RELATION_RANK[entity.relation] < LINKED_RELATION_RANK[existing.relation])
      byKey.set(key, entity)
  }
  return Object.freeze(
    [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]),
  )
}

/** Build one linked entity with conservative current-path disclosure. */
function linkedEntity(
  ctx: ObserverContext,
  ref: StateRef,
  relation: LinkedEntity['relation'],
  role?: string,
): LinkedEntity {
  const currentPath = currentLinkedPath(ctx, ref.path)
  return Object.freeze(
    role === undefined
      ? { ref: Object.freeze(ref), currentPath, relation }
      : { ref: Object.freeze(ref), currentPath, relation, role },
  )
}

function isStateRefValue(value: Value | StateRef): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    'commitId' in value &&
    'path' in value &&
    typeof value.commitId === 'string' &&
    Array.isArray(value.path)
  )
}

/** Whether a ref coordinate names a Struct instance in its own snapshot. */
function structAtRef(deps: ProjectionDeps, ref: StateRef): boolean {
  if (ref.path[0] === '$message') return false
  const graph = ref.commitId === SELF_COMMIT ? deps.graph : snapshotGraph(deps, ref.commitId)
  return graph.instance(ref.path).kind === 'some'
}

/**
 * One-hop links and entity-targeting refs from the entry's fact snapshot.
 *
 * Link contents are always read from `entry.factCommitId`, so an unseen newer
 * edit cannot rewrite remembered edges. A rumor-claim entry never dereferences
 * the objective instance at the rumor-creation commit. Every disclosed target
 * must pass both source-field authorization and target-identity authorization;
 * entity refs additionally require a Struct snapshot, and message refs are
 * never entities.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param entry - Corpus entry whose instance relations are wanted.
 * @returns Sorted, de-duplicated linked entities.
 */
function linkedEntitiesForEntry(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  entry: FieldEntry,
): readonly LinkedEntity[] {
  if (entry.facet.sourceKind === 'rumor_claim') return []
  const factGraph = snapshotGraph(deps, entry.factCommitId)
  const instancePath = fieldInstancePath(entry.path)
  const instance = factGraph.instance(instancePath)
  if (instance.kind === 'none') return []
  const relation: LinkedEntity['relation'] =
    entry.factCommitId === deps.commitId ? 'current_link' : 'historical_link'
  const found: LinkedEntity[] = []
  for (const field of instance.value.fields.values()) {
    if (field.value.kind === 'none') continue
    if (isLinkSpec(field.spec)) {
      if (!linkFieldAuthorized(deps, ctx, instancePath, field, entry.factCommitId)) continue
      for (const target of linkTargets(field.value.value))
        if (authorizedTarget(deps, ctx, target))
          found.push(linkedEntity(ctx, { commitId: entry.factCommitId, path: target }, relation))
      continue
    }
    if (field.spec.valueKind !== 'ref') continue
    const value = field.value.value
    if (!isStateRefValue(value)) continue
    const ref = value
    if (ref.path[0] === '$message') continue
    if (!linkFieldAuthorized(deps, ctx, instancePath, field, entry.factCommitId)) continue
    if (!authorizedTarget(deps, ctx, ref.path)) continue
    if (!structAtRef(deps, ref)) continue
    found.push(linkedEntity(ctx, ref, 'ref_target'))
  }
  return finalizeLinkedEntities(found)
}

/**
 * Authorized historical entity associations of one cognitive memory.
 *
 * Only `relatedEntities` rows become links; evidence refs are never emitted.
 * Each row needs an authorized target identity, a Struct at its exact
 * historical coordinate, and an unsuppressed row path. A rumor (a false
 * memory) never grants more: the memory itself is the only evidence.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param memory - Source memory record.
 * @returns Sorted, de-duplicated `memory_entity` linked entities.
 */
function memoryLinkedEntities(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  memory: CognitiveMemoryRecord,
): readonly LinkedEntity[] {
  const found: LinkedEntity[] = []
  for (const row of readableMemoryRelatedEntities(deps.evaluator, memory)) {
    const ref = row.targetRef
    if (ref.path[0] === '$message') continue
    if (!authorizedTarget(deps, ctx, ref.path)) continue
    if (!structAtRef(deps, ref)) continue
    found.push(linkedEntity(ctx, ref, 'memory_entity', row.role))
  }
  return finalizeLinkedEntities(found)
}

/**
 * Whether an entry's own authorizing declaration marks its field ephemeral.
 *
 * Ephemerality is a Writer-side declaration bound to the moment that produced
 * the entry. Live facets (`direct_scope`/`self_owned`) therefore consult the
 * current objective field, while durable observed entries consult only their
 * `factCommitId` snapshot. A later unseen redefinition of the same field
 * (`defineCustom(..., { ephemeral: true })` over an ordinary historical custom
 * leaf) can never erase what the observer actually recorded. A persisted
 * literal rumor is exempt entirely: its payload is the claim, and probing the
 * current objective node would let an unknown redefinition censor it.
 * Declaration lookup is independent of physical leaf, ancestor and Map-entry
 * existence; missing values cannot erase the Writer's persistence policy.
 *
 * @param deps - Projection dependencies.
 * @param entry - Corpus candidate.
 * @returns True when the authorizing declaration says "never persist".
 */
function corpusEntryEphemeral(deps: ProjectionDeps, entry: FieldEntry): boolean {
  if (entry.facet.sourceKind === 'rumor_claim') return false
  const graph =
    entry.facet.sourceKind === 'direct_scope' || entry.facet.sourceKind === 'self_owned'
      ? deps.graph
      : snapshotGraph(deps, entry.factCommitId)
  const declaration = graph.writerSchemaAt(entry.path)
  return (
    declaration.kind === 'some' &&
    declaration.value.nodeKind === 'leaf' &&
    isEphemeralSpec(declaration.value)
  )
}

/**
 * Pre-filtered corpus for memory/RAG consumers.
 *
 * Ranking (relevance/recency/importance) is deliberately left to the caller;
 * this function only guarantees that every returned entry is legally visible
 * and carries the raw scoring ingredients. Ephemerality is checked against
 * each entry's authorizing declaration, never against the current objective
 * node alone (see {@link corpusEntryEphemeral}).
 */
export function buildCorpus(
  deps: ProjectionDeps,
  ctx: ObserverContext,
): readonly SearchableCorpusEntry[] {
  const collected = collect(deps, ctx, true)
  const subsumed = subsumedInstanceKeys(deps, collected.mergedBuckets)
  const entries: SearchableCorpusEntry[] = []
  for (const bucket of collected.mergedBuckets.buckets.values()) {
    const instanceKey = encodePathKey(bucket.path)
    for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()]) {
      // Memory metadata stays available in the projection tree, but retrieval
      // sees only the subjective narrative (never sequence/ref plumbing).
      if (entry.memory !== undefined && entry.memoryContent !== true) continue
      if (corpusEntryEphemeral(deps, entry)) continue
      const text = renderValue(entry.facet.value)
      const linkedEntities =
        entry.memory !== undefined && entry.memoryContent === true
          ? memoryLinkedEntities(deps, ctx, entry.memory)
          : linkedEntitiesForEntry(deps, ctx, entry)
      entries.push(
        Object.freeze({
          path: entry.path,
          seq: entry.facet.seq,
          factCommitId: entry.factCommitId,
          acquiredAtCommitId: entry.acquiredAtCommitId,
          contentHash: contentHash(text, entry.facet.summary),
          text,
          summary: entry.facet.summary,
          sourceKind: entry.facet.sourceKind,
          priority: entry.facet.priority,
          belief: entry.facet.belief,
          isFoldedInDefaultView:
            entry.foldedByDefault ||
            subsumed.has(instanceKey) ||
            collected.memoryFoldedChildKeys.has(instanceKey),
          linkedEntities,
          linkedInstancePaths: sortedUniquePaths(linkedEntities.map((entity) => entity.ref.path)),
        }),
      )
    }
  }
  return Object.freeze(entries)
}
