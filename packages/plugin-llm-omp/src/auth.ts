/**
 * Credential seam for the local `omp` bridge.
 *
 * Production discovery is the real `discoverAuthStorage()` from
 * `@oh-my-pi/pi-ai/auth-broker`: it opens `~/.omp/agent/agent.db` (or the
 * configured remote broker), reloads stored OAuth/API-key rows and returns the
 * multi-account credential pool with automatic refresh/locking.
 *
 * The public interface here is deliberately structural and pi-ai-free. A host
 * may inject its own storage object, or an already-created `AuthStorage`
 * instance, without this package re-exporting upstream SDK types.
 */

import { discoverAuthStorage } from '@oh-my-pi/pi-ai/auth-broker'

/** Resolution context handed to a pi-ai-compatible API-key resolver. */
export interface OmpAuthKeyContext {
  /** True when the caller is rotating to a sibling credential. */
  readonly lastChance: boolean
  /** The auth error that triggered re-resolution, or `undefined` initially. */
  readonly error: unknown
  /** Caller cancellation, threaded into refresh/rotation work. */
  readonly signal?: AbortSignal
  /** Bearer used by the failed attempt, when known. */
  readonly previousKey?: string
}

/**
 * Resolves one bearer per attempt. The resolved value may be a plain string or
 * an upstream `{ apiKey, credentialId, oauthIdentity }` record.
 */
export type OmpApiKeyResolver = (context: OmpAuthKeyContext) => unknown | Promise<unknown>

/** Scope a resolver to one provider/model/session. */
export interface OmpAuthResolverOptions {
  readonly sessionId?: string
  readonly baseUrl?: string
  readonly modelId?: string
}

/** The subset of `AuthStorage` this bridge depends on. */
export interface OmpAuthStorageLike {
  readonly keys: {
    resolver(provider: string, options?: OmpAuthResolverOptions): OmpApiKeyResolver
  }
  /**
   * Releases the backing credential store. The adapter calls this only for a
   * store it discovered itself; an injected `authStorage` is borrowed and is
   * never closed. Real `AuthStorage.close()` is synchronous, but the seam also
   * accepts an asynchronous implementation.
   */
  readonly close?: () => void | Promise<void>
}

/** Options forwarded to real `discoverAuthStorage()`. */
export interface OmpDiscoverAuthOptions {
  /**
   * `omp` agent directory. Defaults to the SDK's `~/.omp/agent`; setting this
   * points at a different `agent.db` (custom local auth storage).
   */
  readonly agentDir?: string
  /** Remote-broker snapshot cache path (defaults to the SDK's config root). */
  readonly cachePath?: string
  /** Diagnostics label for the resolved store. */
  readonly sourceLabel?: string
}

/** Opens the credential store. Injectable as a narrow options seam for tests. */
export type OmpAuthDiscovery = (options: OmpDiscoverAuthOptions) => Promise<OmpAuthStorageLike>

/**
 * Opens the real local credential store or configured remote broker.
 *
 * Rejects when the broker is unreachable/unconfigured; the adapter converts that
 * startup failure into a terminal `MISSING_CREDENTIAL` finish instead of
 * silently falling back to an empty store.
 */
export async function discoverOmpAuthStorage(
  options: OmpDiscoverAuthOptions = {},
): Promise<OmpAuthStorageLike> {
  const storage = await discoverAuthStorage({
    ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
    ...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
    ...(options.sourceLabel === undefined ? {} : { sourceLabel: options.sourceLabel }),
  })
  return storage as unknown as OmpAuthStorageLike
}
