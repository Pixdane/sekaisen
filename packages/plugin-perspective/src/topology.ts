/**
 * High-level topology invariants registered as a schema commit validator.
 *
 * Structural schema/link validation already guarantees leaf kinds, target
 * existence and per-link role-union acyclicity. Perspective additionally
 * enforces the cross-instance laws that make containment and delegation
 * unambiguous:
 * 1. at most one non-empty `'parent'` single-target link, and the parent union
 *    is acyclic;
 * 2. at most one non-empty `'delegate'` single-target link, acyclic as well;
 * 3. the `'subsumes'` union is acyclic;
 * 4. any directed edge must have non-empty single-target `edge_from` and
 *    `edge_to` links;
 * 5. `'all'` cannot inherit, and the perspective inheritance graph (including
 *    the implicit edge to `'all'`) is acyclic.
 */

import type { Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import type { ReadonlySchemaView } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { decodePathKey, encodePathKey } from '@sekaisen/plugin-world'
import type { PerspectiveGraph } from './graph.ts'
import { PerspectiveGraph as Graph } from './graph.ts'
import { ALL_PERSPECTIVE_ID } from './schemas.ts'
import type { PerspectiveLinkRole } from './visibility.ts'
import { hasLinkRole, isLinkSpec } from './visibility.ts'

/** Commit-validator name reported through `validator_rejected`. */
export const TOPOLOGY_VALIDATOR_NAME = 'perspective-topology'

/** Validator failure shape accepted by `ctx.schema.addCommitValidator`. */
export interface TopologyValidatorFailure {
  readonly path: Path
  readonly validatorName: string
  readonly reason: string
}

function failure(path: Path, reason: string): TopologyValidatorFailure {
  return { path, validatorName: TOPOLOGY_VALIDATOR_NAME, reason }
}

function pathOfKey(key: string): Path {
  try {
    return decodePathKey(key)
  } catch {
    return []
  }
}

function hasCycle(edges: ReadonlyMap<string, readonly string[]>): string | null {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): string | null => {
    if (visiting.has(key)) return key
    if (visited.has(key)) return null
    visiting.add(key)
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next)
      if (cycle !== null) return cycle
    }
    visiting.delete(key)
    visited.add(key)
    return null
  }
  for (const key of edges.keys()) {
    const cycle = visit(key)
    if (cycle !== null) return cycle
  }
  return null
}

function roleEdges(
  graph: PerspectiveGraph,
  role: PerspectiveLinkRole,
): ReadonlyMap<string, readonly string[]> {
  const edges = new Map<string, string[]>()
  for (const path of graph.allInstances()) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    const targets = graph.roleLinks(instance.value, role)
    if (targets.length === 0) continue
    edges.set(
      encodePathKey(path),
      targets.map((link) => encodePathKey(link.target)),
    )
  }
  return edges
}

function checkExclusiveRole(
  graph: PerspectiveGraph,
  role: 'parent' | 'delegate',
): TopologyValidatorFailure | null {
  for (const path of graph.allInstances()) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    let nonEmpty = 0
    for (const field of instance.value.fields.values()) {
      if (!hasLinkRole(field.spec, role)) continue
      if (!isLinkSpec(field.spec)) continue
      if (field.spec.valueKind === 'list:str')
        return failure(
          path,
          role === 'parent' ? 'multiple_parent_links' : 'multiple_delegate_links',
        )
      if (field.value.kind === 'some') nonEmpty++
    }
    if (nonEmpty > 1)
      return failure(path, role === 'parent' ? 'multiple_parent_links' : 'multiple_delegate_links')
  }
  return null
}

function checkEdgeEndpoints(graph: PerspectiveGraph): TopologyValidatorFailure | null {
  for (const path of graph.allInstances()) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    const edgeFields = [...instance.value.fields.values()].filter(
      (field) => hasLinkRole(field.spec, 'edge_from') || hasLinkRole(field.spec, 'edge_to'),
    )
    if (edgeFields.length === 0) continue
    const from = edgeFields.filter((field) => hasLinkRole(field.spec, 'edge_from'))
    const to = edgeFields.filter((field) => hasLinkRole(field.spec, 'edge_to'))
    const valid = (fields: typeof edgeFields): boolean =>
      fields.some((field) => field.spec.valueKind === 'str' && field.value.kind === 'some')
    if (from.length === 0 || to.length === 0 || !valid(from) || !valid(to))
      return failure(path, 'invalid_edge_endpoints')
    if (edgeFields.some((field) => field.spec.valueKind !== 'str'))
      return failure(path, 'invalid_edge_endpoints')
  }
  return null
}

function checkPerspectiveInheritance(graph: PerspectiveGraph): TopologyValidatorFailure | null {
  const records = graph.perspectives()
  const edges = new Map<string, readonly string[]>()
  for (const [id, record] of records) {
    if (id === ALL_PERSPECTIVE_ID && record.inherits.length > 0)
      return failure(['perspectives', id], 'root_perspective_cannot_inherit')
    edges.set(id, record.inherits)
  }
  const cycle = hasCycle(edges)
  if (cycle !== null) return failure(['perspectives', cycle], 'cyclic_role_graph')
  return null
}

/**
 * Validate the final draft.
 *
 * Runs on every schema commit and sync, including no-op diffs, matching the
 * documented validator lifecycle. Reads and direct world writes bypass it.
 */
export function validatePerspectiveTopology(
  draft: ReadonlySchemaView,
): Result<void, TopologyValidatorFailure> {
  const graph = new Graph(draft)
  const exclusiveParent = checkExclusiveRole(graph, 'parent')
  if (exclusiveParent) return err(exclusiveParent)
  const exclusiveDelegate = checkExclusiveRole(graph, 'delegate')
  if (exclusiveDelegate) return err(exclusiveDelegate)
  for (const role of ['parent', 'delegate', 'subsumes'] as const) {
    const cycle = hasCycle(roleEdges(graph, role))
    if (cycle !== null) return err(failure(pathOfKey(cycle), 'cyclic_role_graph'))
  }
  const edgeFailure = checkEdgeEndpoints(graph)
  if (edgeFailure) return err(edgeFailure)
  const inheritanceFailure = checkPerspectiveInheritance(graph)
  if (inheritanceFailure) return err(inheritanceFailure)
  return ok(undefined)
}
