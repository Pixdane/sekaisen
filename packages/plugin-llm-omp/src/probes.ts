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
 *    network, and a Codex WebSocket replay frame marks the stream for a
 *    terminal `TRANSPORT` finish.
 */

import type { FetchImpl, PiModel, ProviderResponseMetadata, RawSseEvent } from './pi-ai.ts'

/** Raised before send when an upstream retry tries to fetch after first byte. */
export class OmpPostCommitAttemptError extends Error {
  constructor() {
    super('Upstream retried after the response had already produced output')
    this.name = 'OmpPostCommitAttemptError'
  }
}

const INFERENCE_PATH =
  /\/(?:v1\/)?(?:messages|responses|chat\/completions|completions)(?:[/?]|$)|:streamgeneratecontent|\/responses\/|\/backend-api\/codex\//i

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof input === 'object' && input !== null && 'url' in input) {
    const url = input.url
    if (typeof url === 'string') return url
  }
  return undefined
}

function isInferenceRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method === 'HEAD' || method === 'OPTIONS') return false
  const url = requestUrl(input)
  return url !== undefined && INFERENCE_PATH.test(url)
}

/** Mutable per-stream probe state. */
export class OmpCallState {
  #committed = false
  #postCommitAttempt = false
  #attempts = 0
  #requestId: string | undefined

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

  commit(): void {
    this.#committed = true
  }

  noteHttpAttempt(): void {
    this.#attempts += 1
  }

  noteWebSocketAttempt(): void {
    this.#attempts += 1
  }

  notePostCommitAttempt(): void {
    this.#postCommitAttempt = true
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

/**
 * Wraps one stream's probes around the caller/SDK fetch implementation.
 *
 * Only inference paths increment the attempt counter; token refresh or other
 * auxiliary HTTP traffic seen on the same fetch implementation stays
 * uncounted, so it cannot inflate `observedAttempts`.
 */
export function createOmpProbes(state: OmpCallState, baseFetch: FetchImpl): OmpProbes {
  const fetchProbe: FetchImpl = async (input, init) => {
    if (state.committed) {
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
    if (first === undefined || !first.startsWith(': ws \u2192 ')) return
    if (first.slice(': ws \u2192 '.length) !== 'response.create') return
    if (state.committed) {
      state.notePostCommitAttempt()
      return
    }
    state.noteWebSocketAttempt()
  }

  return { fetch: fetchProbe, onResponse, onSseEvent }
}
