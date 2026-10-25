import type { Option } from '@sekaisen/core'
import { NONE } from '@sekaisen/core'
import type { ClaimEvaluator } from './claims.ts'
import type { CognitiveMemoryRecord, CognitiveMemoryRelatedEntityRecord } from './schemas.ts'

/** Summary disclosure follows the full content/$meta/summary exclusion path. */
export function readableMemorySummary(
  evaluator: ClaimEvaluator,
  memory: CognitiveMemoryRecord,
): Option<string> {
  return evaluator.suppressed([...memory.path, 'content', '$meta', 'summary'], memory.priority)
    ? NONE
    : memory.summary
}

/** Read and retell the same association view, including leaf-level exclusions. */
export function readableMemoryRelatedEntities(
  evaluator: ClaimEvaluator,
  memory: CognitiveMemoryRecord,
): readonly CognitiveMemoryRelatedEntityRecord[] {
  const visible: CognitiveMemoryRelatedEntityRecord[] = []
  for (const entity of memory.relatedEntities) {
    const slotPath = [...memory.path, 'relatedEntities', entity.slot]
    // suppressed checks every prefix, so instance, map, slot and leaf all apply.
    if (evaluator.suppressed([...slotPath, 'targetRef'], memory.priority)) continue
    visible.push(
      evaluator.suppressed([...slotPath, 'role'], memory.priority)
        ? Object.freeze({ ...entity, role: 'participant' })
        : entity,
    )
  }
  return Object.freeze(visible)
}
