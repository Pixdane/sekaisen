/**
 * Shared ownership and readable-field resolution.
 *
 * Ownership is a pure graph question: follow `'owner'`, `'delegate'` and the
 * implicit `'edge_from'` ownership role backwards from a root body. The same
 * helpers serve projection (live private fields) and knowledge writes
 * (historical whole-instance grants), so both agree on which `'self'` fields a
 * body may read and record.
 *
 * Ownership is always resolved in the graph the caller supplies. Historical
 * grants therefore pass the fact snapshot, never the current draft: a delegate
 * edge created after the fact cannot retroactively grant self access.
 */

import type { Option } from '@sekaisen/core'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { FieldNode, PerspectiveGraph, StructInstance } from './graph.ts'
import { hasLinkRole, isEphemeralSpec } from './visibility.ts'

/**
 * Instances the root body owns through `'owner'`, `'delegate'` and implicit
 * `'edge_from'` ownership, including the root itself.
 *
 * Breadth-first and cycle-safe. The returned map is keyed by encoded path for
 * stable membership checks; the root is always present even if the graph does
 * not contain it (unmaterialized minds still resolve identity).
 *
 * @param graph - View whose ownership edges are authoritative.
 * @param rootEntity - Root delegation body.
 * @returns Encoded-path keyed owned instance paths.
 */
export function ownedInstances(
  graph: PerspectiveGraph,
  rootEntity: Path,
): ReadonlyMap<string, Path> {
  const owned = new Map<string, Path>()
  const queue: Path[] = [rootEntity]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const path = queue.shift()!
    const key = encodePathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    owned.set(key, path)
    for (const entry of graph.backlinks(path)) {
      if (!hasLinkRole(entry.fieldSpec, 'owner', 'delegate', 'edge_from')) continue
      const childKey = encodePathKey(entry.sourceInstancePath)
      if (!owned.has(childKey)) queue.push(entry.sourceInstancePath)
    }
  }
  return owned
}

/**
 * Ownership grants private (`self`) access, not remote surface perception or
 * knowledge of explicitly secret (`ref`) fields. A private instance applies
 * self access to its otherwise surface fields, but never overrides leaf ref.
 *
 * @param graph - View declaring effective field and instance visibility.
 * @param instance - Owning instance.
 * @param field - Candidate leaf.
 * @returns True when the field is a legitimate `self` field of an owned instance.
 */
export function isSelfOwnedField(
  graph: PerspectiveGraph,
  instance: StructInstance,
  field: FieldNode,
): boolean {
  const visibility = graph.fieldVisibility(field)
  return (
    visibility !== 'ref' && (visibility === 'self' || graph.instanceVisibility(instance) === 'self')
  )
}

/**
 * Persistent fields a whole-instance grant may record at one snapshot.
 *
 * The rule is the documented union:
 * - every non-ephemeral `'surface'` field; plus
 * - the owner's legitimate `'self'` fields, when the observer's root body owns
 *   the instance in this same snapshot.
 *
 * `'ref'` fields are never included merely because the observer owns the
 * instance, and ephemeral fields are never persisted. Ownership is resolved in
 * `graph`, so historical grants cannot inherit later delegate privileges.
 *
 * @param graph - Snapshot whose visibility and ownership declarations apply.
 * @param observerRootEntity - Observer delegation root, when the observer is an entity.
 * @param instancePath - Whole instance being recorded.
 * @returns Readable persistent fields in declaration order.
 */
export function readableFieldsAt(
  graph: PerspectiveGraph,
  observerRootEntity: Option<Path>,
  instancePath: Path,
): readonly FieldNode[] {
  const instance = graph.instance(instancePath)
  if (instance.kind === 'none') return []
  let ownsInstance = false
  if (
    observerRootEntity.kind === 'some' &&
    graph.instance(observerRootEntity.value).kind === 'some'
  ) {
    const historicalRoot = graph.delegateRoot(observerRootEntity.value)
    ownsInstance = ownedInstances(graph, historicalRoot).has(encodePathKey(instancePath))
  }
  const readable: FieldNode[] = []
  for (const field of instance.value.fields.values()) {
    if (isEphemeralSpec(field.spec)) continue
    if (graph.fieldVisibility(field) === 'surface') {
      readable.push(field)
      continue
    }
    if (ownsInstance && isSelfOwnedField(graph, instance.value, field)) readable.push(field)
  }
  return Object.freeze(readable)
}
