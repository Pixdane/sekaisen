import { InvariantError } from '@sekaisen/core'
import type { RouteId, RouteRegistrationHandle } from '@sekaisen/plugin-llm'
import type { Context } from 'cordis'
import { OmpPiAiAdapter } from './adapter.ts'
import type { OmpPiAiAdapterOptions } from './config.ts'

/** Plugin configuration; the route table is the bridge's public surface. */
export type OmpPiAiPluginConfig = OmpPiAiAdapterOptions

/**
 * Registers every configured route with `ctx.llm`, disposes credential
 * resources when registration or fiber setup fails, and releases both the
 * atomic registration handle and the adapter's owned credential store when the
 * plugin fiber unloads.
 */
export function apply(ctx: Context, config: OmpPiAiPluginConfig): void {
  const adapter = new OmpPiAiAdapter(config)
  const routes: RouteId[] = Object.keys(config.routes).map((routeId) => routeId as RouteId)
  let release: RouteRegistrationHandle | undefined
  try {
    const registration = ctx.llm.registerChatAdapter(routes, adapter)
    if (!registration.ok) {
      throw new InvariantError(
        `@sekaisen/plugin-llm-omp route registration failed: ${registration.error.code}`,
      )
    }
    const handle = registration.value
    release = handle
    ctx.effect(() => () => {
      handle()
      return adapter.dispose()
    })
  } catch (cause) {
    release?.()
    void adapter.dispose().catch(() => {
      // Registration or fiber setup already failed; cleanup is best-effort.
    })
    throw cause
  }
}

export default apply
