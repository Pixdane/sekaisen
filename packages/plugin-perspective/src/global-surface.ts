import type { Option } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { Path } from '@sekaisen/plugin-world'
import type { LiveFacetInput } from './claims.ts'
import type { FieldNode, PerspectiveGraph, StructInstance } from './graph.ts'
import { pathsEqual } from './graph.ts'
import { isGlobalSurfaceSpec } from './visibility.ts'

/** Only a declared direct leaf of a registered Struct root is a global feed. */
export function isGlobalSurfaceField(
  graph: PerspectiveGraph,
  instance: StructInstance,
  field: FieldNode,
): boolean {
  if (!isGlobalSurfaceSpec(field.spec)) return false
  if (instance.spec.fields[field.name]?.nodeKind !== 'leaf') return false
  if (!pathsEqual(field.path, [...instance.path, field.name])) return false
  return graph.rootPaths().some((root) => pathsEqual(root, instance.path))
}

/** Shared current-value candidate for projection and retelling; callers fold claims. */
export function globalSurfaceCandidate(
  graph: PerspectiveGraph,
  actor: Option<Path>,
  instance: StructInstance,
  field: FieldNode,
): Option<LiveFacetInput> {
  if (!isGlobalSurfaceField(graph, instance, field)) return NONE
  if (actor.kind === 'none' || graph.parentOf(actor.value).kind === 'none') return NONE
  if (
    graph.instanceVisibility(instance) !== 'surface' ||
    graph.fieldVisibility(field) !== 'surface'
  )
    return NONE
  if (field.value.kind === 'none') return NONE
  const summary = field.meta.summary
  return some({
    kind: 'direct_scope',
    value: field.value.value,
    summary: typeof summary === 'string' ? some(summary) : NONE,
  })
}
