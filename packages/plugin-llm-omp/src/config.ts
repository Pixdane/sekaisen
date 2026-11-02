import { InvariantError } from '@sekaisen/core'
import type { OmpAuthDiscovery, OmpAuthStorageLike } from './auth.ts'
import type { OmpCapabilityOverrides } from './capabilities.ts'
import type { FetchImpl, OmpModelResolver, OmpStreamBackend } from './pi-ai.ts'

/** One subscription/local `omp` channel exposed as a neutral route. */
export interface OmpRouteConfig {
  /**
   * pi-ai provider id (`openai-codex`, `anthropic`, `google-antigravity`,
   * `google-gemini-cli`, `opencode-go`, `opencode-zen`, `commandcode`, …).
   * Also the credential-store lookup key.
   */
  readonly provider: string
  /** Optional endpoint override; defaults to the catalog row's `baseUrl`. */
  readonly baseURL?: string
  /** Extra request headers merged by pi-ai on top of model headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Route-specific corrections for a custom/proxied catalog row. */
  readonly capabilities?: OmpCapabilityOverrides
  /**
   * Prefer the Codex WebSocket transport. Defaults to `false` so HTTP attempt
   * counting is deterministic; WebSocket attempts are counted from
   * `response.create` frames when enabled (or by model/env preference).
   */
  readonly preferWebsockets?: boolean
  /** First-event watchdog forwarded to pi-ai; `0` disables it. */
  readonly firstEventTimeoutMs?: number
  /** Inter-event idle watchdog forwarded to pi-ai; `0` disables it. */
  readonly interEventTimeoutMs?: number
}

/** Construction options for {@link OmpPiAiAdapter}. */
export interface OmpPiAiAdapterOptions {
  /** Route id → subscription channel binding. */
  readonly routes: Readonly<Record<string, OmpRouteConfig>>
  /**
   * Pre-opened real `AuthStorage` (or structural equivalent). Borrowed: the
   * adapter never closes it; the host owns its lifetime. When omitted the
   * adapter lazily runs `discoverAuthStorage()` against `agentDir`/broker and
   * owns the discovered store.
   */
  readonly authStorage?: OmpAuthStorageLike
  /** Custom `omp` agent directory containing `agent.db`. */
  readonly agentDir?: string
  /** Remote-broker snapshot cache path. */
  readonly cachePath?: string
  /**
   * Simple static-key seam for hosts that do not use the `omp` credential
   * store. When set, no `AuthStorage` is opened and no rotation is available.
   */
  readonly resolveApiKey?: (provider: string) => Promise<string | undefined>
  /**
   * Test/host seam for credential discovery. Production defaults to the real
   * `discoverOmpAuthStorage()`; a discovered store is owned and closed by the
   * adapter, unlike an injected `authStorage`. Ignored when `authStorage` or
   * `resolveApiKey` is supplied.
   */
  readonly discoverAuthStorage?: OmpAuthDiscovery
  /** Session id used for credential affinity and prompt-cache routing. */
  readonly sessionId?: string
  /** Test seam: narrow pi-ai stream backend. Production defaults to `streamSimple`. */
  readonly stream?: OmpStreamBackend
  /** Test seam: catalog lookup. Production defaults to the pinned pi-catalog snapshot. */
  readonly resolveModel?: OmpModelResolver
  /** Test seam / corporate proxy: fetch implementation behind the attempt probe. */
  readonly fetch?: FetchImpl
}

function validHeaderValue(value: string): boolean {
  return (
    value.isWellFormed() && !value.includes('\r') && !value.includes('\n') && !value.includes('\0')
  )
}

function assertWellFormedString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !value.isWellFormed()) {
    throw new InvariantError(`${what} must be a non-empty well-formed string`)
  }
}

function freezeRoute(routeId: string, route: OmpRouteConfig): OmpRouteConfig {
  assertWellFormedString(routeId, 'Route id')
  assertWellFormedString(route.provider, `Route "${routeId}" provider`)
  if (route.baseURL !== undefined) {
    assertWellFormedString(route.baseURL, `Route "${routeId}" baseURL`)
    let parsed: URL
    try {
      parsed = new URL(route.baseURL)
    } catch {
      throw new InvariantError(`Route "${routeId}" baseURL must be an absolute URL`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new InvariantError(`Route "${routeId}" baseURL must use http or https`)
    }
  }
  let headers: Readonly<Record<string, string>> | undefined
  if (route.headers !== undefined) {
    const copy: Record<string, string> = Object.create(null)
    for (const [name, value] of Object.entries(route.headers)) {
      assertWellFormedString(name, `Route "${routeId}" header name`)
      if (!validHeaderValue(value)) {
        throw new InvariantError(`Route "${routeId}" header "${name}" contains illegal characters`)
      }
      copy[name] = value
    }
    headers = Object.freeze(copy)
  }
  for (const timeout of [route.firstEventTimeoutMs, route.interEventTimeoutMs]) {
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
      throw new InvariantError(
        `Route "${routeId}" watchdog timeouts must be finite non-negative numbers`,
      )
    }
  }
  return Object.freeze({
    provider: route.provider,
    ...(route.baseURL === undefined ? {} : { baseURL: route.baseURL }),
    ...(headers === undefined ? {} : { headers }),
    ...(route.capabilities === undefined
      ? {}
      : { capabilities: Object.freeze({ ...route.capabilities }) }),
    ...(route.preferWebsockets === undefined ? {} : { preferWebsockets: route.preferWebsockets }),
    ...(route.firstEventTimeoutMs === undefined
      ? {}
      : { firstEventTimeoutMs: route.firstEventTimeoutMs }),
    ...(route.interEventTimeoutMs === undefined
      ? {}
      : { interEventTimeoutMs: route.interEventTimeoutMs }),
  })
}

/** Defensive copy of the route table with a null-prototype lookup dictionary. */
export function freezeOmpRoutes(
  routes: Readonly<Record<string, OmpRouteConfig>>,
): Readonly<Record<string, OmpRouteConfig>> {
  const dictionary: Record<string, OmpRouteConfig> = Object.create(null)
  for (const [routeId, route] of Object.entries(routes)) {
    dictionary[routeId] = freezeRoute(routeId, route)
  }
  return Object.freeze(dictionary)
}
