/**
 * Authorized field collection and bucket materialization.
 *
 * One collection pass gathers the public shared prefix, live private
 * overrides, self-owned instances and off-scene remembered buckets. Schema
 * dictionaries, instance views and subsumption folding are materialized from
 * those exact buckets so projection and corpus consume the same evidence.
 */

import type { Option } from '@sekaisen/core'
import { NONE } from '@sekaisen/core'
import type { CommitHash, Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { FieldNode, StructInstance } from '../graph.ts'
import { fieldInstancePath, pathsEqual, sortedUniquePaths } from '../graph.ts'
import { isSelfOwnedField } from '../ownership.ts'
import type { ObserverScopeState } from '../scope.ts'
import { computePublicChannelScope } from '../scope.ts'
import type {
  ProjectedFieldView,
  ProjectedInstanceView,
  ProjectedSchemaDictionary,
  ScenePublicProjection,
} from '../types.ts'
import type { ObserverContext, ProjectionDeps, RememberedSnapshot } from './context.ts'
import {
  BucketSet,
  fieldEntry,
  firstRememberedSnapshot,
  isInLiveScope,
  mergeBuckets,
  rememberedBucketSnapshot,
  snapshotGraph,
  visibleInstances,
} from './context.ts'
import {
  entryDescription,
  globalFieldEntry,
  globalSurfaceFields,
  liveFold,
  PUBLIC_SCENE_SEQ,
  publicFieldEntry,
  rememberedLabel,
} from './fields.ts'
import { collectMemoryBuckets, isMemoryDescendant, isMemoryInstancePath } from './memory-view.ts'

export interface Collected {
  readonly scenePublic: ScenePublicProjection | null
  readonly publicBuckets: BucketSet
  readonly overrideBuckets: BucketSet
  readonly selfBuckets: BucketSet
  readonly offSceneBuckets: BucketSet
  readonly mergedBuckets: BucketSet
  readonly memoryFoldedChildKeys: ReadonlySet<string>
}

/**
 * Schema dictionary for a bucket set.
 *
 * Whole-schema expansion requires current spatial/ownership access or an
 * effective historical entity discovery. Field observations describe their
 * authorized snapshot fields; feeds and rumors never authorize sibling
 * declarations, even when mixed in the same bucket. Historical labels remain
 * bound to their recorded snapshot, not unknown current objective metadata.
 * Dictionary keys may be any legal Schema identifier, including `__proto__`;
 * all name-indexed containers use the same null-prototype convention as Schema.
 *
 * @param deps - Projection dependencies.
 * @param buckets - Buckets to describe.
 * @param ctx - Observer structure permissions; omitted only for raw public builders.
 * @returns Frozen, encoded-instance-keyed schema dictionary.
 */
export function schemaOfBuckets(
  deps: ProjectionDeps,
  buckets: BucketSet,
  ctx?: ObserverContext,
): ProjectedSchemaDictionary {
  const dictionary: Record<
    string,
    { description: string; fields: Record<string, { description: string }> }
  > = Object.create(null)
  for (const [key, bucket] of buckets.buckets) {
    const entries = [...bucket.fields.values(), ...bucket.customFields.values()]
    const memoryInstance = isMemoryInstancePath(bucket.path)
    // Public builders select actual scene structure; observer views must prove
    // spatial/ownership access independently of the bucket's mixture of values.
    const currentStructure =
      memoryInstance || ctx === undefined || ctx.owned.has(key) || isInLiveScope(ctx, bucket.path)
    let discovered: Option<RememberedSnapshot> = NONE
    if (
      !currentStructure &&
      deps.evaluator.effectiveDiscoveredPaths().some((path) => pathsEqual(path, bucket.path))
    ) {
      const discoveryCandidates: { commitId: CommitHash; priority: number }[] = []
      for (const facet of deps.evaluator.fold(bucket.path).facets)
        if (
          facet.sourceKind === 'observed_claim' &&
          facet.belief !== 'known_false' &&
          facet.at.kind === 'some'
        )
          discoveryCandidates.push({ commitId: facet.at.value, priority: facet.priority })
      if (discoveryCandidates.length > 0)
        discovered = firstRememberedSnapshot(deps, bucket.path, discoveryCandidates)
    }
    let shape: StructInstance | undefined
    if (currentStructure) {
      const instance = deps.graph.instance(bucket.path)
      if (instance.kind === 'some') shape = instance.value
    } else {
      const remembered =
        discovered.kind === 'some' ? discovered : rememberedBucketSnapshot(deps, bucket)
      if (remembered.kind === 'some') {
        const instance = remembered.value.graph.instance(bucket.path)
        if (instance.kind === 'some') shape = instance.value
      }
    }
    const fields: Record<string, { description: string }> = Object.create(null)
    if (shape && !memoryInstance && (currentStructure || discovered.kind === 'some')) {
      for (const [name, spec] of Object.entries(shape.spec.fields))
        fields[name] = { description: spec.description }
    }
    for (const entry of entries) {
      const name = entry.path[entry.path.length - 1]!
      if (!Object.hasOwn(fields, name))
        fields[name] = { description: entryDescription(deps, entry) }
    }
    dictionary[key] = {
      description: shape ? shape.spec.description : rememberedLabel(bucket.path),
      fields,
    }
  }
  return Object.freeze(dictionary)
}

/**
 * Materialize public/private instance dictionaries without interpreting names
 * as Object prototype setters. Declared and custom fields retain every legal
 * identifier as an own, JSON-serializable property.
 */
export function instanceViews(buckets: BucketSet): Readonly<Record<string, ProjectedInstanceView>> {
  const views: Record<string, ProjectedInstanceView> = Object.create(null)
  for (const [key, bucket] of buckets.buckets) {
    if (bucket.fields.size === 0 && bucket.customFields.size === 0) continue
    const fields: Record<string, ProjectedFieldView> = Object.create(null)
    const customFields: Record<string, ProjectedFieldView> = Object.create(null)
    for (const [name, entry] of bucket.fields) fields[name] = entry.view
    for (const [name, entry] of bucket.customFields) customFields[name] = entry.view
    views[key] = Object.freeze({
      path: bucket.path,
      fields: Object.freeze(fields),
      customFields: Object.freeze(customFields),
    })
  }
  return Object.freeze(views)
}

/**
 * Resolve folding relations only from snapshots the observer actually knows.
 * Current off-scene role edits must not unfold or hide remembered instances;
 * rumors alone do not reveal the corresponding objective graph.
 */
export function subsumedInstanceKeys(
  deps: ProjectionDeps,
  buckets: BucketSet,
): ReadonlySet<string> {
  const hidden = new Set<string>()
  for (const bucket of buckets.buckets.values()) {
    if (isMemoryInstancePath(bucket.path)) continue
    const commits = new Set<CommitHash>()
    for (const entry of [...bucket.fields.values(), ...bucket.customFields.values()])
      if (entry.facet.sourceKind !== 'rumor_claim') commits.add(entry.factCommitId)
    for (const commit of commits) {
      const graph = snapshotGraph(deps, commit)
      const instance = graph.instance(bucket.path)
      if (instance.kind === 'none') continue
      for (const link of graph.roleLinks(instance.value, 'subsumes'))
        hidden.add(encodePathKey(link.target))
    }
  }
  return hidden
}

export function withoutSubsumed(deps: ProjectionDeps, buckets: BucketSet): BucketSet {
  const hidden = subsumedInstanceKeys(deps, buckets)
  for (const key of hidden) buckets.buckets.delete(key)
  return buckets
}

/**
 * Raw standard public surface for a non-diverging observer.
 *
 * Every emitted facet is built from the live public field itself: the observer
 * evaluator is never consulted, so the surface is byte-identical for every
 * observer sharing the same ceiling and cannot include private additional
 * facets. Effective runtime/static field and instance visibility are honored
 * through the graph accessors.
 *
 * @param deps - Projection dependencies.
 * @param scope - Observer scope proven non-diverging by the scope engine.
 * @returns Public buckets for the ceiling.
 */
function rawPublicBuckets(deps: ProjectionDeps, scope: ObserverScopeState, seq: number): BucketSet {
  const buckets = new BucketSet()
  const sightCeiling = scope.sight.ceiling
  const soundCeiling = scope.sound.ceiling
  if (sightCeiling.kind === 'none' || soundCeiling.kind === 'none') return buckets
  const domains = new Map<string, Path>([
    ...computePublicChannelScope(deps.graph, sightCeiling.value, 'sight'),
    ...computePublicChannelScope(deps.graph, soundCeiling.value, 'sound'),
  ])
  for (const [key, path] of domains) {
    const instance = deps.graph.instance(path)
    if (instance.kind === 'none' || deps.graph.instanceVisibility(instance.value) !== 'surface')
      continue
    for (const field of instance.value.fields.values()) {
      if (deps.graph.fieldVisibility(field) !== 'surface') continue
      const channel = deps.graph.fieldSense(field)
      const channelDomains = channel === 'sight' ? scope.sight.publicPaths : scope.sound.publicPaths
      if (!channelDomains.has(key)) continue
      const entry = publicFieldEntry(deps, field, seq)
      if (entry.kind === 'some') buckets.add(field.path, entry.value)
    }
  }
  return buckets
}

/**
 * Whether a live field already belongs to the raw public shared surface.
 *
 * Uses effective runtime/static visibility so a field concealed at runtime is
 * never folded into the observer-private override block.
 *
 * @param deps - Projection dependencies.
 * @param ctx - Observer context.
 * @param instance - Owning instance.
 * @param field - Candidate field.
 * @returns True when the field is part of the raw public surface.
 */
function inRawPublicField(
  deps: ProjectionDeps,
  ctx: ObserverContext,
  instance: StructInstance,
  field: FieldNode,
): boolean {
  if (ctx.scope.kind === 'none' || !ctx.scope.value.canUseRawPublicScope) return false
  if (deps.graph.fieldVisibility(field) !== 'surface') return false
  if (deps.graph.instanceVisibility(instance) !== 'surface') return false
  const channelScope =
    deps.graph.fieldSense(field) === 'sight' ? ctx.scope.value.sight : ctx.scope.value.sound
  return channelScope.publicPaths.has(encodePathKey(instance.path))
}

/**
 * Field-level claim targets, taken from the claim records alone.
 *
 * The enumeration never asks whether the path currently exists: a deleted
 * entity's remembered leaves and a live entity's hidden leaves are both
 * ordinary field claims. Structural discovery identities are excluded by
 * construction, so they can never become ghost field entries.
 *
 * @param deps - Projection dependencies.
 * @returns Deduplicated, path-key sorted field claim paths.
 */
function fieldClaimPaths(deps: ProjectionDeps): readonly Path[] {
  const result: Path[] = []
  for (const path of deps.evaluator.claimPaths().fields) {
    if (path[0] === '$message') {
      result.push(path)
      continue
    }
    if (path.length < 2) continue
    if (
      path.some(
        (segment, index) =>
          segment.startsWith('$') && !(segment === '$custom' && index === path.length - 2),
      )
    )
      continue
    result.push(path)
  }
  return sortedUniquePaths(result)
}

/** Collect the same authorized fields; corpus mode retains folded supporting evidence. */
export function collect(deps: ProjectionDeps, ctx: ObserverContext, forCorpus = false): Collected {
  const overrideBuckets = new BucketSet()
  const selfBuckets = new BucketSet()
  const offSceneBuckets = new BucketSet()
  const handled = new Set<string>()

  for (const instancePath of visibleInstances(ctx, deps)) {
    const instance = deps.graph.instance(instancePath)
    if (instance.kind === 'none') continue
    const owned = ctx.owned.has(encodePathKey(instancePath))
    for (const field of instance.value.fields.values()) {
      if (field.value.kind === 'none') continue
      const hiddenField = deps.graph.fieldVisibility(field) !== 'surface'
      if (owned && isSelfOwnedField(deps.graph, instance.value, field)) {
        const fold = liveFold(deps, field, 'self_owned', ctx.scope, instance.value)
        const entry = fieldEntry(deps, field.path, fold, 'routine')
        if (entry.kind === 'none') continue
        handled.add(encodePathKey(field.path))
        if (fold.primary.kind === 'some' && fold.primary.value.sourceKind === 'self_owned')
          selfBuckets.add(field.path, entry.value)
        else overrideBuckets.add(field.path, entry.value)
        continue
      }
      if (hiddenField) continue
      const fold = liveFold(deps, field, 'direct_scope', ctx.scope, instance.value)
      const entry = fieldEntry(deps, field.path, fold, 'routine')
      if (entry.kind === 'none') continue
      handled.add(encodePathKey(field.path))
      if (inRawPublicField(deps, ctx, instance.value, field)) continue
      overrideBuckets.add(field.path, entry.value)
    }
  }

  // Only private self fields bypass physical scope through ownership.
  for (const path of ctx.owned.values()) {
    if (isInLiveScope(ctx, path)) continue
    const instance = deps.graph.instance(path)
    if (instance.kind === 'none') continue
    for (const field of instance.value.fields.values()) {
      if (!isSelfOwnedField(deps.graph, instance.value, field)) continue
      if (field.value.kind === 'none') continue
      const fold = liveFold(deps, field, 'self_owned', ctx.scope, instance.value)
      const entry = fieldEntry(deps, field.path, fold, 'routine')
      if (entry.kind === 'none') continue
      handled.add(encodePathKey(field.path))
      if (fold.primary.kind === 'some' && fold.primary.value.sourceKind === 'self_owned')
        selfBuckets.add(field.path, entry.value)
      else overrideBuckets.add(field.path, entry.value)
    }
  }

  /*
   * Declared global live-surface leaves are re-read from this projection's
   * commit for staged physical observers. They stay out of the raw public
   * prefix so every observer's scenePublic remains byte-identical, and they
   * fold through the evaluator so exclusions and rumors keep their normal
   * arbitration. A feed never grants ownership, navigation or link-target
   * identities: those checks use geometric scope and discovery predicates,
   * which a global leaf does not change.
   */
  if (ctx.scope.kind === 'some')
    for (const { instance, field } of globalSurfaceFields(deps)) {
      const key = encodePathKey(field.path)
      if (handled.has(key)) continue
      const entry = globalFieldEntry(deps, ctx, instance, field, 'routine')
      if (entry.kind === 'none') continue
      handled.add(key)
      overrideBuckets.add(field.path, entry.value)
    }

  // Memory-only paths not produced by the live pass (hidden fields, off-scene).
  for (const path of fieldClaimPaths(deps)) {
    if (isMemoryDescendant(path)) continue
    if (handled.has(encodePathKey(path))) continue
    const fold = deps.evaluator.fold(path)
    const entry = fieldEntry(deps, path, fold, 'routine')
    if (entry.kind === 'none') continue
    const instancePath = fieldInstancePath(path)
    if (isInLiveScope(ctx, instancePath) || ctx.owned.has(encodePathKey(instancePath)))
      overrideBuckets.add(path, entry.value)
    else offSceneBuckets.add(path, entry.value)
  }

  // Own-root and inherited cognitive memories are observer-private content.
  const memoryBuckets = collectMemoryBuckets(deps, ctx)
  mergeBuckets(selfBuckets, memoryBuckets.own)
  mergeBuckets(offSceneBuckets, memoryBuckets.inherited)
  if (!forCorpus) {
    for (const key of memoryBuckets.foldedChildKeys) {
      selfBuckets.buckets.delete(key)
      offSceneBuckets.buckets.delete(key)
    }
  }

  const publicBuckets = new BucketSet()
  let scenePublic: ScenePublicProjection | null = null
  if (ctx.scope.kind === 'some' && ctx.scope.value.canUseRawPublicScope) {
    const ceiling = ctx.scope.value.sight.ceiling
    if (ceiling.kind === 'some') {
      if (forCorpus) {
        mergeBuckets(
          publicBuckets,
          rawPublicBuckets(deps, ctx.scope.value, deps.evaluator.nextSeq()),
        )
      } else {
        const shared = rawPublicBuckets(deps, ctx.scope.value, PUBLIC_SCENE_SEQ)
        withoutSubsumed(deps, shared)
        scenePublic = Object.freeze({
          sceneRootPath: ceiling.value,
          schemas: schemaOfBuckets(deps, shared),
          instances: instanceViews(shared),
        })
        const agent = rawPublicBuckets(deps, ctx.scope.value, deps.evaluator.nextSeq())
        withoutSubsumed(deps, agent)
        mergeBuckets(publicBuckets, agent)
      }
    }
  }

  if (!forCorpus) {
    withoutSubsumed(deps, overrideBuckets)
    withoutSubsumed(deps, selfBuckets)
    withoutSubsumed(deps, offSceneBuckets)
  }

  const mergedBuckets = new BucketSet()
  mergeBuckets(mergedBuckets, publicBuckets)
  mergeBuckets(mergedBuckets, overrideBuckets)
  mergeBuckets(mergedBuckets, selfBuckets)
  mergeBuckets(mergedBuckets, offSceneBuckets)
  if (!forCorpus) withoutSubsumed(deps, mergedBuckets)

  return {
    scenePublic,
    publicBuckets,
    overrideBuckets,
    selfBuckets,
    offSceneBuckets,
    mergedBuckets,
    memoryFoldedChildKeys: memoryBuckets.foldedChildKeys,
  }
}
