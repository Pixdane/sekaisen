/**
 * `@sekaisen/plugin-perspective`
 *
 * Epistemic visibility layered on `@sekaisen/plugin-schema`:
 * declaration-merged metadata, dual-channel live perception, dual-time claims,
 * safe projections, retrieval corpora and delegate-body switching.
 *
 * Register the service after `ctx.world` and `ctx.schema` exist:
 *
 * ```ts
 * const perspective = new PerspectiveService(ctx)
 * schema.commit({ head: 'main', message: 'seed' }, (tx) => {
 *   perspective.configurePerspective(tx, Characters.at('alice'), {})
 * })
 * ```
 */

export * from './schemas.ts'
export { PerspectiveService, PerspectiveService as default } from './service.ts'
export * from './types.ts'
export * from './visibility.ts'
