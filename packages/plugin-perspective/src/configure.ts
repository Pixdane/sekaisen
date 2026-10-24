/**
 * Perspective configuration command.
 *
 * Materializes/updates one perspective node inside a caller-owned transaction,
 * preserving inheritance order, host binding and the root perspective rule.
 */

import type { Result } from '@sekaisen/core'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import { encodePathKey } from '@sekaisen/plugin-world'
import { encodePerspectivePointer, PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective, fail } from './internal.ts'
import { structLensAt } from './lenses.ts'
import type { PerspectiveReader } from './reader.ts'
import { ALL_PERSPECTIVE_ID, PERSPECTIVES_ROOT } from './schemas.ts'
import { ensurePerspective } from './store.ts'
import type { ConfigurePerspectiveInput, ObserverRef, PerspectiveError } from './types.ts'

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
export function configurePerspective(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  config: ConfigurePerspectiveInput,
): Result<void, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = new Graph(tx)
    const resolved = reader.resolveObserver(graph, observer)
    const inheritance = config.inherits?.map((parent) => {
      const parentResolved = reader.resolveObserver(graph, parent)
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
    ensurePerspective(tx, resolved.id, hostEntity)
    const patch: Record<string, unknown> = {}
    if (inheritance !== undefined) {
      for (const parent of inheritance) ensurePerspective(tx, parent.id, parent.hostEntity)
      patch.inherits = inheritance.map((parent) => encodePerspectivePointer(parent.id))
    }
    if (config.description !== undefined) patch.description = config.description
    if (config.defaultPriority !== undefined) patch.defaultPriority = config.defaultPriority
    if (hostEntity.kind === 'some') patch.hostEntity = encodePathKey(hostEntity.value)
    const lens = structLensAt(tx, [...PERSPECTIVES_ROOT, resolved.id])
    tx.patch(lens, patch)
  })
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
