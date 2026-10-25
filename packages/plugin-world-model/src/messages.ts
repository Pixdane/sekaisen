/**
 * The four typed commit-message contracts owned by the world model.
 *
 * Registered with `ctx.schema.defineMessage`; message schemas are closed
 * (no refs, no custom fields) so persisted payloads stay Writer-decodable.
 */

import type { InferCoreOutput, MessagePrism } from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'

/** L0 action/event advancement step. */
export const L0_STEP_MESSAGE_KIND = 'l0_step' as const
/** Memory archive/summary step. */
export const MEMORY_ARCHIVE_MESSAGE_KIND = 'memory_archive' as const
/** Manual actor/author edit step. */
export const MANUAL_EDIT_MESSAGE_KIND = 'manual_edit' as const
/** Cross-worldline carry-over patch step. */
export const CARRY_OVER_PATCH_MESSAGE_KIND = 'carry_over_patch' as const

/** `l0_step` payload. */
export const L0StepMessageSchema = s.struct({
  eventOrigin: s.str().default('scene').desc('scene | world'),
  significance: s.str().default('routine').desc('routine | notable | critical'),
  storyTimeStart: s.num().desc('step start story time in minutes'),
  storyTimeEnd: s.num().desc('step end story time in minutes'),
  locationKey: s.str().optional().desc('encoded location path key'),
  participantKeys: s.list('str').default([]).desc('encoded participant entity path keys'),
  triggeredKeys: s.list('str').default([]).desc('encoded fuse/agenda/beat keys triggered'),
  summary: s.str().desc('objective step event summary'),
})

/** `memory_archive` payload. */
export const MemoryArchiveMessageSchema = s.struct({
  archiveLevel: s.str().default('L1').desc('L1 | L2'),
  perspectiveIds: s.list('str').default([]).desc('affected root perspective ids'),
  createdMemoryKeys: s.list('str').default([]).desc('encoded paths of newly created summaries'),
  summary: s.str().desc('memory archive summary'),
})

/** `manual_edit` payload. */
export const ManualEditMessageSchema = s.struct({
  author: s.str().default('user').desc('manual edit author or tool identifier'),
  summary: s.str().desc('manual edit summary'),
})

/** `carry_over_patch` payload. */
export const CarryOverPatchMessageSchema = s.struct({
  sourceCommitId: s.str().desc('source worldline commit hash'),
  rewindTargetCommitId: s.str().desc('rewind target parent commit hash'),
  carriedPerspectiveIds: s.list('str').default([]).desc('root perspective ids carried over'),
  carriedMemoryKeys: s.list('str').default([]).desc('encoded paths of new carry-over memories'),
  carriedClaimKeys: s.list('str').default([]).desc('encoded paths of new carry-over claims'),
  carriedItemKeys: s.list('str').default([]).desc('encoded item paths physically carried'),
  summary: s.str().desc('carry-over patch summary'),
})

/** Decoded `l0_step` payload. */
export type L0StepMessage = InferCoreOutput<typeof L0StepMessageSchema>
/** Decoded `memory_archive` payload. */
export type MemoryArchiveMessage = InferCoreOutput<typeof MemoryArchiveMessageSchema>
/** Decoded `manual_edit` payload. */
export type ManualEditMessage = InferCoreOutput<typeof ManualEditMessageSchema>
/** Decoded `carry_over_patch` payload. */
export type CarryOverPatchMessage = InferCoreOutput<typeof CarryOverPatchMessageSchema>

/** Any decoded world-model message payload. */
export type WorldModelMessageData =
  | L0StepMessage
  | MemoryArchiveMessage
  | ManualEditMessage
  | CarryOverPatchMessage

/** Registered message prisms exposed through `ctx.worldModel.messages`. */
export interface WorldModelMessages {
  readonly l0Step: MessagePrism<'l0_step', typeof L0StepMessageSchema>
  readonly memoryArchive: MessagePrism<'memory_archive', typeof MemoryArchiveMessageSchema>
  readonly manualEdit: MessagePrism<'manual_edit', typeof ManualEditMessageSchema>
  readonly carryOverPatch: MessagePrism<'carry_over_patch', typeof CarryOverPatchMessageSchema>
}
