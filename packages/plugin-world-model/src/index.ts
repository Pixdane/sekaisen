/**
 * `@sekaisen/plugin-world-model`
 *
 * Declarative objective world model on top of `@sekaisen/plugin-world`,
 * `@sekaisen/plugin-schema` and `@sekaisen/plugin-perspective`:
 * twelve registered roots, four typed commit messages, a twelve-rule
 * final-draft validator and atomic assignment/timer primitives.
 *
 * ```ts
 * const worldModel = new WorldModelService(ctx)
 * schema.commit(worldModel.messages.l0Step.create({
 *   storyTimeStart: 0,
 *   storyTimeEnd: 10,
 *   summary: 'A bell rings.',
 * }), (tx) => {
 *   tx.patch(worldModel.lenses.world, { clock: 10 })
 * })
 * ```
 */

export type {
  CarryOverResult,
  CarryOverSelection,
  CognitiveMemoryTreeNode,
  PerspectiveError,
} from '@sekaisen/plugin-perspective'
export * from './lenses.ts'
export * from './messages.ts'
export * from './schemas.ts'
export { WorldModelService, WorldModelService as default } from './service.ts'
export * from './types.ts'
export type {
  WorldModelValidatorContext,
  WorldModelValidatorDeps,
  WorldModelValidatorFailure,
} from './validation.ts'
export { validateWorldModel, WORLD_MODEL_VALIDATOR_NAME } from './validation.ts'
