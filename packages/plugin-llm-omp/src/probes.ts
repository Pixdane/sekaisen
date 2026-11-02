/**
 * Transport probes around pi-ai's `options.fetch` / `onResponse` /
 * `onSseEvent` seams.
 *
 * They serve two purposes:
 * 1. count the physical model attempts pi-ai actually performs (HTTP fetches,
 *    Codex WebSocket `response.create` frames) so `finish.observedAttempts` is
 *    truthful rather than assumed;
 * 2. enforce the pre-first-byte commit lock: once the adapter has emitted
 *    `first-byte`, a further inference fetch is rejected before it reaches the
 *    network, and a Codex WebSocket replay frame cancels the call so it ends
 *    with a terminal `TRANSPORT` finish.
 */

import type { FetchImpl, PiModel, ProviderResponseMetadata, RawSseEvent } from './pi-ai.ts'

/** Raised before send when an upstream retry tries to fetch after first byte. */
export class OmpPostCommitAttemptError extends Error {
  constructor() {
    super('Upstream retried after the response had already produced output')
    this.name = 'OmpPostCommitAttemptError'
  }
}

/**
 * Endpoints the SDK requests through the same `options.fetch` seam that are
 * auxiliary rather than inference: OAuth/token exchange, credential metadata,
 * discovery/version probes, and GitLab/Devin control-plane traffic.
 *
 * Classification runs on the parsed host and pathname, never on query text, so
 * a tracing or debug parameter can neither hide an inference request nor excuse
 * an auxiliary one. A known inference suffix wins over any prefix, so a gateway
 * mounted under `/custom/token` still counts. Remaining POSTs are presumed
 * inference: that keeps arbitrary gateway paths truthful instead of silently
 * reporting zero attempts.
 */
const INFERENCE_PATH =
  /\/(?:chat\/completions|completions|messages|responses|converse-stream|api\/chat|api\/generate|generate|v1\/pi\/stream|GetChatMessage)$|:streamgeneratecontent|:generatecontent/i

const AUXILIARY_HOSTS: Readonly<Record<string, true>> = Object.freeze({
  'iamcredentials.googleapis.com': true,
  'metadata.google.internal': true,
  'oauth2.googleapis.com': true,
  // Antigravity client-version manifest probe.
  'antigravity-hub-auto-updater-974169037036.us-central1.run.app': true,
})

const AUXILIARY_SEGMENTS: Readonly<Record<string, true>> = Object.freeze({
  assignmodel: true,
  authorization: true,
  authorize: true,
  direct_access: true,
  duo_workflows: true,
  fetchavailablemodels: true,
  getuserjwt: true,
  graphql: true,
  login: true,
  logout: true,
  oauth: true,
  oauth2: true,
  refresh: true,
})

const AUXILIARY_TERMINAL_SEGMENTS: Readonly<Record<string, true>> = Object.freeze({
  health: true,
  token: true,
  version: true,
})

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof input === 'object' && input !== null && 'url' in input) {
    const url = input.url
    if (typeof url === 'string') return url
  }
  return undefined
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const method = init?.method
  if (typeof method === 'string' && method.length > 0) return method.toUpperCase()
  // A `Request` carries its own method; reading only `init` reported every
  // `fetch(request)` as GET and silently dropped those attempts.
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function parseRequestUrl(url: string): { readonly hostname: string; readonly pathname: string } {
  try {
    const parsed = new URL(url)
    return { hostname: parsed.hostname.toLowerCase(), pathname: parsed.pathname }
  } catch {
    // Relative inputs are not legal fetch targets, but the path prefix still
    // classifies better than dropping the attempt.
    return { hostname: '', pathname: url.split(/[?#]/, 1)[0] ?? '' }
  }
}

function isAuxiliaryRequest(hostname: string, pathname: string): boolean {
  if (Object.hasOwn(AUXILIARY_HOSTS, hostname)) return true
  if (pathname.startsWith('/.well-known/')) return true
  const normalized = pathname.toLowerCase()
  if (normalized.endsWith(':generateaccesstoken')) return true
  const segments = normalized.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => Object.hasOwn(AUXILIARY_SEGMENTS, segment))) return true
  const terminal = segments.at(-1)
  return terminal !== undefined && Object.hasOwn(AUXILIARY_TERMINAL_SEGMENTS, terminal)
}

function isInferenceRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (requestMethod(input, init) !== 'POST') return false
  const url = requestUrl(input)
  if (url === undefined) return false
  const { hostname, pathname } = parseRequestUrl(url)
  if (INFERENCE_PATH.test(pathname)) return true
  return !isAuxiliaryRequest(hostname, pathname)
}

/** Mutable per-stream probe state. */
export class OmpCallState {
  #committed = false
  #postCommitAttempt = false
  #attempts = 0
  #requestId: string | undefined
  #cancelReplay: (() => void) | undefined

  /** True once `{ type: 'first-byte' }` was handed to the downstream guard. */
  get committed(): boolean {
    return this.#committed
  }

  /** True once an upstream retry/reconnect was observed after the commit. */
  get postCommitAttempt(): boolean {
    return this.#postCommitAttempt
  }

  /** Physical inference attempts observed so far. */
  get attempts(): number {
    return this.#attempts
  }

  /** Last provider request id observed on a response. */
  get requestId(): string | undefined {
    return this.#requestId
  }

  /**
   * Registers the synchronous cancel hook used to stop the in-flight producer.
   *
   * pi-ai routes `onResponse`/`onSseEvent` through observers that swallow
   * exceptions, so a probe cannot stop generation by throwing. Aborting the
   * call's own signal is the only mechanism that reaches the transport.
   */
  bindReplayCancel(cancel: () => void): void {
    this.#cancelReplay = cancel
  }

  commit(): void {
    this.#committed = true
  }

  noteHttpAttempt(): void {
    this.#attempts += 1
  }

  noteWebSocketAttempt(): void {
    this.#attempts += 1
  }

  /**
   * Records a replay observed after the commit and synchronously cancels the
   * producer, so a pending `iterator.next()` settles instead of hanging.
   */
  notePostCommitAttempt(): void {
    this.#postCommitAttempt = true
    this.#cancelReplay?.()
  }

  noteRequestId(requestId: string): void {
    this.#requestId = requestId
  }
}

/** Probe callbacks injected into pi-ai stream options. */
export interface OmpProbes {
  readonly fetch: FetchImpl
  readonly onResponse: (
    response: ProviderResponseMetadata,
    model?: PiModel,
    signal?: AbortSignal,
  ) => void | Promise<void>
  readonly onSseEvent: (event: RawSseEvent, model?: PiModel) => void
}

const RESPONSE_CREATE_PREFIX = ': ws \u2192 '

/**
 * Wraps one stream's probes around the caller/SDK fetch implementation.
 *
 * Only inference POSTs increment the attempt counter; OAuth/token refresh,
 * discovery probes and other auxiliary HTTP traffic seen on the same fetch
 * implementation stays uncounted, so it cannot inflate `observedAttempts`.
 * A fetch after the commit is cancelled before it can reach the network.
 */
export function createOmpProbes(state: OmpCallState, baseFetch: FetchImpl): OmpProbes {
  const fetchProbe: FetchImpl = async (input, init) => {
    if (state.committed) {
      // Sets the replay flag and aborts the call signal synchronously, then
      // rejects this attempt so no provider retry loop keeps spinning.
      state.notePostCommitAttempt()
      throw new OmpPostCommitAttemptError()
    }
    if (isInferenceRequest(input, init)) state.noteHttpAttempt()
    return baseFetch(input, init)
  }

  const onResponse: OmpProbes['onResponse'] = (response) => {
    if (state.committed) {
      state.notePostCommitAttempt()
      return
    }
    if (typeof response.requestId === 'string' && response.requestId.length > 0) {
      state.noteRequestId(response.requestId)
    }
  }

  const onSseEvent: OmpProbes['onSseEvent'] = (event) => {
    const first = event.raw[0]
    if (first === undefined || !first.startsWith(RESPONSE_CREATE_PREFIX)) return
    if (first.slice(RESPONSE_CREATE_PREFIX.length) !== 'response.create') return
    if (state.committed) {
      // pi-ai hands this outbound frame to the observer before `socket.send`,
      // and the abort listener it registered closes the socket synchronously.
      // Cancelling here therefore stops the physical re-send, not just the
      // adapter's reading of the reply.
      state.notePostCommitAttempt()
      return
    }
    state.noteWebSocketAttempt()
  }

  return { fetch: fetchProbe, onResponse, onSseEvent }
}
