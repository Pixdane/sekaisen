/**
 * Public, side-effect-free cognitive memory path protocol.
 *
 * Upper plugins (for example `@sekaisen/plugin-world-model`) validate
 * cross-layer links without importing private perspective modules or
 * hard-coding the four-segment memory path layout.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { ReadonlySchemaView } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { PerspectiveGraph } from './graph.ts'
import { decodePathKeySafe, PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective, fail } from './internal.ts'
import { PERSPECTIVES_ROOT } from './schemas.ts'
import type { MemoryPathCoordinates, ObserverRef, PerspectiveError } from './types.ts'

/**
 * Recognize a legal cognitive memory instance path.
 *
 * Only exactly `['perspectives', P, 'memories', M]` with non-empty segments
 * qualifies. Map roots, claim sub-tables and foreign roots return `NONE`.
 */
export function parseCognitiveMemoryPath(path: Path): Option<MemoryPathCoordinates> {
  if (path.length !== 4) return NONE
  const [root, rootPerspectiveId, table, memoryId] = path
  if (root !== PERSPECTIVES_ROOT[0] || table !== 'memories') return NONE
  if (
    rootPerspectiveId === undefined ||
    memoryId === undefined ||
    rootPerspectiveId.length === 0 ||
    memoryId.length === 0 ||
    rootPerspectiveId.startsWith('$') ||
    memoryId.startsWith('$')
  )
    return NONE
  return some(Object.freeze({ rootPerspectiveId, memoryId }))
}

/** How an observer reference resolves inside one graph snapshot. */
export interface ResolvedRootPerspective {
  readonly id: string
  readonly rootEntity: Option<Path>
}

/**
 * Resolve an observer to its canonical root id without touching a transaction.
 *
 * Entity paths follow `'delegate'` links to the root body. A materialized
 * perspective id is returned unchanged, matching the fixed-commit read
 * contract used by `resolveRootPerspective`.
 */
export function resolveRootPerspectiveInGraph(
  graph: PerspectiveGraph,
  observer: ObserverRef,
): ResolvedRootPerspective {
  if (typeof observer === 'string') {
    const decoded = decodePathKeySafe(observer)
    if (decoded.kind === 'some' && graph.instance(decoded.value).kind === 'some') {
      const root = graph.delegateRoot(decoded.value)
      return Object.freeze({ id: encodePathKey(root), rootEntity: some(root) })
    }
    const record = graph.perspective(observer)
    if (record.kind === 'some' && record.value.hostEntity.kind === 'some')
      return Object.freeze({
        id: observer,
        rootEntity: some(record.value.hostEntity.value),
      })
    return Object.freeze({ id: observer, rootEntity: NONE })
  }
  const path = 'opticKind' in observer ? observer.path : observer
  if (graph.instance(path).kind === 'none')
    fail({ kind: 'observer_entity_not_found', observer: encodePathKey(path) })
  const root = graph.delegateRoot(path)
  return Object.freeze({ id: encodePathKey(root), rootEntity: some(root) })
}

/**
 * Resolve an observer at a read-only view or transaction draft.
 *
 * Pure: no perspective node is materialized and no write occurs.
 */
export function resolveRootPerspectiveAt(
  view: ReadonlySchemaView,
  observer: ObserverRef,
): Result<string, PerspectiveError> {
  return attemptPerspective(() => resolveRootPerspectiveInGraph(new Graph(view), observer).id)
}
