/**
 * Safe projection assembly.
 *
 * This is the top of the projection stack: it combines the shared public
 * prefix, live private overrides, self-owned instances and off-scene
 * remembered buckets into the frozen agent-facing view. Collection, field
 * authorization, memory materialization, inspection and corpus construction
 * live in their own modules and never depend on this one.
 */

import { NONE, some } from '@sekaisen/core'
import type { Path } from '@sekaisen/plugin-world'
import { computePublicChannelScope } from '../scope.ts'
import type {
  AgentWorldProjection,
  ObserverPrivateProjection,
  ScenePublicProjection,
} from '../types.ts'
import { collect, instanceViews, schemaOfBuckets, withoutSubsumed } from './collect.ts'
import type { ObserverContext, ProjectionDeps } from './context.ts'
import { BucketSet, mergeBuckets } from './context.ts'
import { PUBLIC_SCENE_SEQ, publicFieldEntry } from './fields.ts'

/**
 * Build the complete agent projection.
 *
 * The routine mode folds fields with summaries; `inspect` reuses the same fold
 * data but expands values.
 */
export function buildProjection(deps: ProjectionDeps, ctx: ObserverContext): AgentWorldProjection {
  const collected = collect(deps, ctx)
  const privateBuckets = new BucketSet()
  mergeBuckets(privateBuckets, collected.selfBuckets)
  mergeBuckets(privateBuckets, collected.overrideBuckets)
  mergeBuckets(privateBuckets, collected.offSceneBuckets)
  const privateView: ObserverPrivateProjection = Object.freeze({
    rootPerspectiveId: ctx.rootId,
    schemas: schemaOfBuckets(deps, privateBuckets, ctx),
    selfInstances: instanceViews(collected.selfBuckets),
    inScenePrivateOverrides: instanceViews(collected.overrideBuckets),
    offSceneKnownInstances: instanceViews(collected.offSceneBuckets),
  })
  return Object.freeze({
    rootPerspectiveId: ctx.rootId,
    scenePublic: collected.scenePublic === null ? NONE : some(collected.scenePublic),
    privateView,
    schemas: schemaOfBuckets(deps, collected.mergedBuckets, ctx),
    mergedInstances: instanceViews(collected.mergedBuckets),
  })
}

/**
 * Build a raw public projection independent of any observer claims.
 *
 * The host-only counterpart of the observer's raw public surface: every entry
 * is a fresh live `direct_scope` facet, so observer memory never influences
 * the result and public link fields keep their encoded endpoint strings.
 *
 * @param deps - Projection dependencies.
 * @param sceneRoot - Ceiling container to expand.
 * @returns Frozen raw public scene projection.
 */
export function buildPublicProjection(
  deps: ProjectionDeps,
  sceneRoot: Path,
): ScenePublicProjection {
  const buckets = new BucketSet()
  const sightDomains = computePublicChannelScope(deps.graph, sceneRoot, 'sight')
  const soundDomains = computePublicChannelScope(deps.graph, sceneRoot, 'sound')
  const domains = new Map<string, Path>([...sightDomains, ...soundDomains])
  for (const [key, path] of domains) {
    const instance = deps.graph.instance(path)
    if (instance.kind === 'none' || deps.graph.instanceVisibility(instance.value) !== 'surface')
      continue
    for (const field of instance.value.fields.values()) {
      if (deps.graph.fieldVisibility(field) !== 'surface') continue
      const channelDomains = deps.graph.fieldSense(field) === 'sight' ? sightDomains : soundDomains
      if (!channelDomains.has(key)) continue
      const entry = publicFieldEntry(deps, field, PUBLIC_SCENE_SEQ)
      if (entry.kind === 'some') buckets.add(field.path, entry.value)
    }
  }
  withoutSubsumed(deps, buckets)
  return Object.freeze({
    sceneRootPath: sceneRoot,
    schemas: schemaOfBuckets(deps, buckets),
    instances: instanceViews(buckets),
  })
}
