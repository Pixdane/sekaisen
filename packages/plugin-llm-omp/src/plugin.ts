import { InvariantError } from '@sekaisen/core'
import type { RouteId } from '@sekaisen/plugin-llm'
import type { Context } from 'cordis'
import { OmpPiAiAdapter } from './adapter.ts'
import type { OmpPiAiAdapterOptions } from './config.ts'

/** Plugin configuration; the route table is the bridge's public surface. */
export type OmpPiAiPluginConfig = OmpPiAiAdapterOptions

/**
 * Registers every configured route with `ctx.llm` and releases the atomic
 * registration handle when the plugin fiber unloads.
 */
export function apply(ctx: Context, config: OmpPiAiPluginConfig): void {
  const adapter = new OmpPiAiAdapter(config)
  const routes: RouteId[] = Object.keys(config.routes).map((routeId) => routeId as RouteId)
  const registration = ctx.llm.registerChatAdapter(routes, adapter)
  if (!registration.ok) {
    throw new InvariantError(
      `@sekaisen/plugin-llm-omp route registration failed: ${registration.error.code}`,
    )
  }
  const release = registration.value
  ctx.effect(() => () => release())
}

export default apply
