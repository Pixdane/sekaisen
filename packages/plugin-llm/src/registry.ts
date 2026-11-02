/**
 * Fiber-bound, atomically replaceable route table shared by the chat,
 * embedding and rerank adapter registries.
 *
 * Every handle owns a disjoint route set. `replace()` validates the whole
 * candidate set before touching the live table, so a rejected replacement can
 * never leave the registry half-updated. Commit and broadcast happen inside one
 * synchronous block: concurrent readers never observe a gap.
 */

import type { Result } from '@sekaisen/core'
import { compareUtf8, err, ok } from '@sekaisen/core'
import type { RouteRegistrationHandle } from './service-types.ts'
import type { LlmFailure, RouteId } from './types.ts'
import { failure, validString } from './utils.ts'

/** Minimum surface every routable adapter must expose. */
export interface RouteEntry {
  readonly adapterKind: string
}

interface OwnerState<T extends RouteEntry> {
  readonly entry: T
  routes: Set<RouteId>
  disposed: boolean
}

interface LiveRoute<T extends RouteEntry> {
  readonly owner: number
  readonly entry: T
}

/**
 * Validate a caller-supplied route list.
 *
 * Returns `null` when the list is acceptable. Ordering is irrelevant for the
 * registry, but duplicates inside one candidate list are rejected because they
 * would make ownership ambiguous.
 */
function checkRouteList(routes: readonly RouteId[], allowEmpty: boolean): LlmFailure | null {
  if (!Array.isArray(routes))
    return failure('INVALID_ROUTE', 'Route list must be an array of RouteId values')
  if (routes.length === 0 && !allowEmpty)
    return failure('INVALID_ROUTE', 'Initial registration requires at least one route')
  const seen = new Set<string>()
  for (let index = 0; index < routes.length; index++) {
    const route: unknown = routes[index]
    if (!validString(route, true))
      return failure(
        'INVALID_ROUTE',
        `Route at index ${index} must be a non-empty well-formed string`,
      )
    if (seen.has(route))
      return failure(
        'INVALID_ROUTE',
        `Route "${route}" appears more than once in the same registration`,
      )
    seen.add(route)
  }
  return null
}

/** Route table for one adapter family. */
export class RouteRegistry<T extends RouteEntry> {
  private readonly live = new Map<RouteId, LiveRoute<T>>()
  private readonly owners = new Map<number, OwnerState<T>>()
  private readonly onChange: () => void
  private nextOwnerId = 1

  /** @param onChange Invoked once per committed table mutation. */
  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  /** Register `routes` for `entry` as one atomic owner. */
  register(routes: readonly RouteId[], entry: T): Result<RouteRegistrationHandle, LlmFailure> {
    const invalid = checkRouteList(routes, false)
    if (invalid !== null) return err(invalid)
    for (const route of routes) {
      if (this.live.has(route))
        return err(
          failure('DUPLICATE_ROUTE', `Route "${route}" is already registered by another adapter`),
        )
    }
    const ownerId = this.nextOwnerId++
    this.owners.set(ownerId, { entry, routes: new Set(routes), disposed: false })
    for (const route of routes) this.live.set(route, { owner: ownerId, entry })
    this.onChange()
    return ok(this.createHandle(ownerId))
  }

  /** Look up the adapter serving `route`. */
  get(route: RouteId): T | undefined {
    return this.live.get(route)?.entry
  }

  /** Route list in deterministic UTF-8 lexical order. */
  list(): readonly RouteId[] {
    return Object.freeze([...this.live.keys()].sort(compareUtf8))
  }

  private createHandle(ownerId: number): RouteRegistrationHandle {
    const release = (): void => {
      this.release(ownerId)
    }
    return Object.assign(release, {
      replace: (nextRoutes: readonly RouteId[]): Result<void, LlmFailure> =>
        this.replaceRoutes(ownerId, nextRoutes),
    })
  }

  /** Release every route owned by `ownerId`; idempotent. */
  private release(ownerId: number): void {
    const owner = this.owners.get(ownerId)
    if (owner === undefined || owner.disposed) return
    owner.disposed = true
    this.owners.delete(ownerId)
    for (const route of owner.routes) {
      const live = this.live.get(route)
      if (live !== undefined && live.owner === ownerId) this.live.delete(route)
    }
    owner.routes.clear()
    this.onChange()
  }

  /** Atomically hot-replace the route set owned by `ownerId`. */
  private replaceRoutes(ownerId: number, nextRoutes: readonly RouteId[]): Result<void, LlmFailure> {
    const owner = this.owners.get(ownerId)
    if (owner === undefined || owner.disposed)
      return err(
        failure(
          'REGISTRATION_DISPOSED',
          'The registration handle has been released and can no longer replace routes',
        ),
      )

    const invalid = checkRouteList(nextRoutes, true)
    if (invalid !== null) return err(invalid)
    for (const route of nextRoutes) {
      const live = this.live.get(route)
      if (live !== undefined && live.owner !== ownerId)
        return err(
          failure('DUPLICATE_ROUTE', `Route "${route}" is already registered by another adapter`),
        )
    }

    // All-or-nothing pre-check passed: commit inside this synchronous block.
    const next = new Set(nextRoutes)
    for (const route of owner.routes) {
      if (next.has(route)) continue
      const live = this.live.get(route)
      if (live !== undefined && live.owner === ownerId) this.live.delete(route)
    }
    for (const route of next) this.live.set(route, { owner: ownerId, entry: owner.entry })
    owner.routes = next
    this.onChange()
    return ok(undefined)
  }
}
