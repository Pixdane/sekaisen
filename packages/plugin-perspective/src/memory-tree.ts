/**
 * Host-only cognitive memory tree inspection.
 *
 * The view walks only the observer's own root-perspective memories. It is not
 * part of the restricted `asObserver` facade, honours effective exclusions, and
 * tolerates malformed cycles so a corrupt draft can never recurse forever.
 */

import type { Result } from '@sekaisen/core'
import type { ReadonlySchemaView } from '@sekaisen/plugin-schema'
import type { CommitHash } from '@sekaisen/plugin-world'
import { PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective } from './internal.ts'

import { parseCognitiveMemoryPath } from './memory-topology.ts'
import type { PerspectiveReader } from './reader.ts'
import type { CognitiveMemoryRecord } from './schemas.ts'
import type { CognitiveMemoryTreeNode, ObserverRef, PerspectiveError } from './types.ts'

/**
 * Assemble the observer's `L2 -> L1 -> L0` summary tree from one view.
 *
 * A child is emitted only when it is present in the same root perspective and
 * not hidden by an effective exclusion. Shared children may appear under
 * several parents. Pure: reads never materialize a perspective.
 */
export function inspectCognitiveMemoryTree(
  reader: PerspectiveReader,
  commitIdOrView: CommitHash | ReadonlySchemaView,
  observer: ObserverRef,
): Result<readonly CognitiveMemoryTreeNode[], PerspectiveError> {
  return attemptPerspective(() => {
    const graph =
      typeof commitIdOrView === 'string' ? reader.view(commitIdOrView) : new Graph(commitIdOrView)
    const resolved = reader.resolveObserver(graph, observer)
    const record = graph.perspective(resolved.id)
    if (record.kind === 'none') return Object.freeze([])
    const evaluator = reader.evaluatorFor(graph, resolved.id)
    const available = new Map<string, CognitiveMemoryRecord>()
    for (const [memoryId, memory] of record.value.memories) {
      if (!evaluator.suppressed(memory.path, memory.priority)) available.set(memoryId, memory)
    }
    const memo = new Map<string, CognitiveMemoryTreeNode>()
    const building = new Set<string>()
    const build = (memoryId: string): CognitiveMemoryTreeNode | undefined => {
      const cached = memo.get(memoryId)
      if (cached !== undefined) return cached
      const memory = available.get(memoryId)
      if (memory === undefined || building.has(memoryId)) return undefined
      building.add(memoryId)
      const subsumedChildren: CognitiveMemoryTreeNode[] = []
      for (const childPath of memory.children) {
        const coordinates = parseCognitiveMemoryPath(childPath)
        if (coordinates.kind === 'none') continue
        if (coordinates.value.rootPerspectiveId !== resolved.id) continue
        const child = build(coordinates.value.memoryId)
        if (child !== undefined) subsumedChildren.push(child)
      }
      building.delete(memoryId)
      subsumedChildren.sort((a, b) => a.seq - b.seq || a.memoryId.localeCompare(b.memoryId))
      const node: CognitiveMemoryTreeNode = Object.freeze({
        memoryId: memory.memoryId,
        path: memory.path,
        level: memory.level,
        seq: memory.seq,
        tier: memory.tier,
        strength: memory.strength,
        belief: memory.belief,
        summary: memory.summary,
        content: memory.content,
        subsumedChildren: Object.freeze(subsumedChildren),
      })
      memo.set(memoryId, node)
      return node
    }
    for (const memoryId of available.keys()) build(memoryId)
    const referenced = new Set<string>()
    for (const node of memo.values())
      for (const child of node.subsumedChildren) referenced.add(child.memoryId)
    const roots = [...memo.values()]
      .filter((node) => !referenced.has(node.memoryId))
      .sort((a, b) => a.seq - b.seq || a.memoryId.localeCompare(b.memoryId))
    return Object.freeze(roots)
  })
}
