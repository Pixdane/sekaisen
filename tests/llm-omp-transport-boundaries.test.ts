/**
 * Transport boundaries for the pi-ai adapter: attempt accounting at the fetch
 * seam and post-commit cancellation.
 *
 * These exercise the adapter's own `runOmpCall`/probe wiring, not a provider,
 * so every scenario is deterministic and never touches the network.
 */

import { describe, expect, test } from 'bun:test'
import { isSome, NONE, some } from '@sekaisen/core'
import {
  type PreparedChatCallSnapshot,
  type StreamChunk,
  StreamProtocolGuard,
} from '@sekaisen/plugin-llm'
import { ompFailure } from '../packages/plugin-llm-omp/src/failures.ts'
import type {
  AssistantMessage,
  FetchImpl,
  OmpStreamBackend,
  PiAiContext,
  PiModel,
  RawSseEvent,
  SimpleStreamOptions,
  TextContent,
} from '../packages/plugin-llm-omp/src/pi-ai.ts'
import {
  createOmpProbes,
  OmpCallState,
  OmpPostCommitAttemptError,
  type OmpProbes,
} from '../packages/plugin-llm-omp/src/probes.ts'
import { type OmpStreamCall, runOmpCall } from '../packages/plugin-llm-omp/src/stream.ts'

const MODEL = {
  id: 'transport-boundaries',
  api: 'anthropic-messages',
  provider: 'anthropic',
} as unknown as PiModel

const CONTEXT = { messages: [] } as unknown as PiAiContext

const EMPTY_SNAPSHOT = Object.freeze({}) as unknown as PreparedChatCallSnapshot

const RESPONSE_CREATE_FRAME: RawSseEvent = {
  event: null,
  data: '',
  raw: [': ws \u2192 response.create'],
}

interface FetchProbe {
  readonly fetch: FetchImpl
  readonly calls: () => number
}

function fetchProbe(): FetchProbe {
  let calls = 0
  const probe: FetchImpl = async () => {
    calls += 1
    return new Response('{}', { status: 200 })
  }
  return { fetch: probe, calls: () => calls }
}

function textContent(text: string): TextContent {
  return { type: 'text', text }
}

function usageWith(value: number): AssistantMessage['usage'] {
  return {
    input: value,
    output: value,
    cacheRead: value,
    cacheWrite: value,
    totalTokens: value,
    reasoningTokens: value,
    cost: { input: value, output: value, cacheRead: value, cacheWrite: value, total: value },
  }
}

function message(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  usage: AssistantMessage['usage'] = usageWith(0),
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage,
    stopReason,
    timestamp: 0,
  }
}

function optionsWith(probes: OmpProbes | undefined, signal?: AbortSignal): SimpleStreamOptions {
  return {
    ...(probes === undefined
      ? {}
      : { fetch: probes.fetch, onResponse: probes.onResponse, onSseEvent: probes.onSseEvent }),
    ...(signal === undefined ? {} : { signal }),
  }
}

function childSignalOf(options: SimpleStreamOptions): AbortSignal {
  const signal = options.signal
  if (signal === undefined) throw new Error('adapter passed no producer signal')
  return signal
}

function callFixture(
  backend: OmpStreamBackend,
  options: SimpleStreamOptions,
  state: OmpCallState,
): OmpStreamCall {
  return {
    snapshot: EMPTY_SNAPSHOT,
    model: MODEL,
    context: CONTEXT,
    options,
    state,
    secrets: new Set<string>(),
    backend,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function finishOf(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish') throw new Error('terminal finish missing')
  return finish
}

function expectLegalStream(chunks: readonly StreamChunk[]): void {
  const guard = new StreamProtocolGuard()
  for (const chunk of chunks) guard.accept(chunk)
  guard.end()
}

const push = { method: 'POST' } as const

describe('OMP transport attempt accounting', () => {
  test('counts POST inference attempts on every provider-specific or gateway path', async () => {
    const base = fetchProbe()
    const state = new OmpCallState()
    const probes = createOmpProbes(state, base.fetch)

    // A `Request` carries its own method; `init` is omitted here on purpose.
    await probes.fetch(
      new Request('https://gateway.test/tenant/infer', { method: 'POST', body: '{}' }),
    )
    await probes.fetch('http://127.0.0.1:11434/api/chat', push)
    await probes.fetch(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/converse-stream',
      push,
    )
    await probes.fetch('https://gateway.test/v1/llm/stream', push)
    await probes.fetch(new URL('https://gateway.test/custom/generation'), push)
    // Query text is never classification input.
    await probes.fetch('https://gateway.test/v1/chat/completions?trace=generateAccessToken', push)
    await probes.fetch('https://gateway.test/infer?debug=direct_access', push)
    // A known inference suffix wins over an auxiliary-looking prefix segment.
    await probes.fetch('https://gateway.test/custom/token/chat/completions', push)

    expect(state.attempts).toBe(8)
    expect(base.calls()).toBe(8)
  })

  test('ignores OAuth, token, discovery and control-plane traffic', async () => {
    const base = fetchProbe()
    const state = new OmpCallState()
    const probes = createOmpProbes(state, base.fetch)

    for (const url of [
      'https://omp.test/oauth/token',
      'https://auth.test/api/v1/token',
      'https://oauth2.googleapis.com/token',
      'https://gitlab.test/api/v4/ai/third_party_agents/direct_access',
      'https://gitlab.test/api/v4/ai/duo_workflows/workflows',
      'https://gitlab.test/api/graphql',
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa:generateAccessToken',
      'https://devin.test/exa.auth_pb.AuthService/GetUserJwt',
      'https://devin.test/exa.api_server_pb.ApiServerService/AssignModel',
      'https://gateway.test/.well-known/openid-configuration',
      // Query noise cannot turn an auxiliary endpoint into an inference one.
      'https://omp.test/oauth/token?trace=direct_access',
    ]) {
      await probes.fetch(url, push)
    }
    // Non-inference methods never count, even on an inference path.
    await probes.fetch('https://omp.test/v1/messages', { method: 'HEAD' })
    await probes.fetch('https://omp.test/v1/messages', { method: 'OPTIONS' })
    await probes.fetch('https://omp.test/v1/messages')

    expect(state.attempts).toBe(0)
    expect(base.calls()).toBe(14)
  })

  test('counts one physical WebSocket attempt per pre-commit response.create only', () => {
    const state = new OmpCallState()
    const probes = createOmpProbes(state, fetchProbe().fetch)

    probes.onSseEvent(RESPONSE_CREATE_FRAME, MODEL)
    probes.onSseEvent({ event: null, data: '', raw: [': ws \u2190 response.created'] }, MODEL)
    probes.onSseEvent(RESPONSE_CREATE_FRAME, MODEL)

    expect(state.attempts).toBe(2)
    expect(state.postCommitAttempt).toBe(false)
  })
})

describe('OMP post-commit cancellation', () => {
  interface AbortableProbe {
    readonly state: OmpCallState
    readonly probes: OmpProbes
    readonly base: FetchProbe
    readonly controller: AbortController
    readonly cancellations: () => number
  }

  function abortableProbe(): AbortableProbe {
    const base = fetchProbe()
    const state = new OmpCallState()
    const controller = new AbortController()
    let cancellations = 0
    state.bindReplayCancel(() => {
      cancellations += 1
      controller.abort()
    })
    return {
      state,
      base,
      controller,
      cancellations: () => cancellations,
      probes: createOmpProbes(state, base.fetch),
    }
  }

  test('a post-commit fetch aborts the producer synchronously before rejecting', async () => {
    const fixture = abortableProbe()
    fixture.state.commit()

    const thrown = await fixture.probes.fetch('https://omp.test/v1/messages', push).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(thrown).toBeInstanceOf(OmpPostCommitAttemptError)
    // The abort happened before the rejection surfaced, so the transport is
    // already cancelled when a provider retry would keep spinning.
    expect(fixture.controller.signal.aborted).toBe(true)
    expect(fixture.cancellations()).toBe(1)
    expect(fixture.state.postCommitAttempt).toBe(true)
    expect(fixture.base.calls()).toBe(0)
    expect(fixture.state.attempts).toBe(0)
  })

  test('post-commit onResponse aborts without throwing at the observer boundary', () => {
    const fixture = abortableProbe()
    fixture.state.commit()

    expect(() => fixture.probes.onResponse({ status: 200, headers: {} }, MODEL)).not.toThrow()

    expect(fixture.controller.signal.aborted).toBe(true)
    expect(fixture.state.postCommitAttempt).toBe(true)
  })

  test('a post-commit response.create frame aborts without throwing', () => {
    const fixture = abortableProbe()
    fixture.state.commit()

    expect(() => fixture.probes.onSseEvent(RESPONSE_CREATE_FRAME, MODEL)).not.toThrow()

    expect(fixture.controller.signal.aborted).toBe(true)
    expect(fixture.state.postCommitAttempt).toBe(true)
    expect(fixture.state.attempts).toBe(0)
  })

  test('a producer that hangs after a post-commit replay terminates with TRANSPORT', async () => {
    const signals: AbortSignal[] = []
    const base = fetchProbe()
    const state = new OmpCallState()
    const caller = new AbortController()
    const probes = createOmpProbes(state, base.fetch)

    const backend: OmpStreamBackend = async function* (model, _context, options) {
      signals.push(childSignalOf(options))
      await options.fetch?.('https://omp.test/v1/messages', push)
      yield { type: 'start', partial: message([]) }
      yield { type: 'text_start', contentIndex: 0, partial: message([textContent('')]) }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'partial',
        partial: message([textContent('partial')]),
      }
      options.onSseEvent?.(RESPONSE_CREATE_FRAME, model)
      // A transport that ignores the abort must not keep the adapter waiting.
      await Promise.withResolvers<void>().promise
    }

    const chunks = await collect(
      runOmpCall(callFixture(backend, optionsWith(probes, caller.signal), state)),
    )
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') expect(finish.reason.failure.code).toBe('TRANSPORT')
    expect(finish.observedAttempts).toBe(1)
    expect(chunks.some((chunk) => chunk.type === 'first-byte')).toBe(true)

    expect(state.postCommitAttempt).toBe(true)
    expect(base.calls()).toBe(1)
    expect(caller.signal.aborted).toBe(false)
    // The backend receives the call's own signal, not the caller's.
    expect(signals).toHaveLength(1)
    expect(signals[0]).not.toBe(caller.signal)
    expect(signals[0]?.aborted).toBe(true)
    expectLegalStream(chunks)
  })

  test('a post-commit fetch from a hanging producer terminates with TRANSPORT', async () => {
    const signals: AbortSignal[] = []
    const base = fetchProbe()
    const state = new OmpCallState()
    const caller = new AbortController()
    const probes = createOmpProbes(state, base.fetch)
    let rejected: unknown

    const backend: OmpStreamBackend = async function* (_model, _context, options) {
      signals.push(childSignalOf(options))
      await options.fetch?.('https://omp.test/v1/messages', push)
      yield { type: 'start', partial: message([]) }
      yield { type: 'text_start', contentIndex: 0, partial: message([textContent('')]) }
      yield {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'partial',
        partial: message([textContent('partial')]),
      }
      try {
        await options.fetch?.('https://omp.test/v1/messages', push)
      } catch (cause) {
        rejected = cause
      }
      await Promise.withResolvers<void>().promise
    }

    const chunks = await collect(
      runOmpCall(callFixture(backend, optionsWith(probes, caller.signal), state)),
    )
    const finish = finishOf(chunks)
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind === 'error') expect(finish.reason.failure.code).toBe('TRANSPORT')
    expect(finish.observedAttempts).toBe(1)

    expect(rejected).toBeInstanceOf(OmpPostCommitAttemptError)
    expect(base.calls()).toBe(1)
    expect(signals[0]?.aborted).toBe(true)
    expectLegalStream(chunks)
  })

  test('caller cancellation of a pending producer stays ABORTED and aborts the child signal', async () => {
    const signals: AbortSignal[] = []
    const state = new OmpCallState()
    const caller = new AbortController()
    const probes = createOmpProbes(state, fetchProbe().fetch)
    const started = Promise.withResolvers<void>()

    const backend: OmpStreamBackend = async function* (_model, _context, options) {
      signals.push(childSignalOf(options))
      started.resolve()
      await Promise.withResolvers<void>().promise
      yield { type: 'start', partial: message([]) }
    }

    const pending = collect(
      runOmpCall(callFixture(backend, optionsWith(probes, caller.signal), state)),
    )
    await started.promise
    caller.abort()
    const chunks = await pending
    const finish = finishOf(chunks)

    expect(finish.reason.kind).toBe('aborted')
    if (finish.reason.kind === 'aborted') expect(finish.reason.failure.code).toBe('ABORTED')
    expect(finish.observedAttempts).toBe(0)
    expect(signals[0]?.aborted).toBe(true)
    expectLegalStream(chunks)
  })

  test('an early consumer return aborts and closes the producer', async () => {
    const signals: AbortSignal[] = []
    const caller = new AbortController()
    const state = new OmpCallState()
    const probes = createOmpProbes(state, fetchProbe().fetch)
    const closed = Promise.withResolvers<void>()
    let abortedWhenClosed = false

    const backend: OmpStreamBackend = async function* (_model, _context, options) {
      signals.push(childSignalOf(options))
      try {
        await options.fetch?.('https://omp.test/v1/messages', push)
        yield { type: 'start', partial: message([]) }
        yield { type: 'text_start', contentIndex: 0, partial: message([textContent('')]) }
        yield {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'partial',
          partial: message([textContent('partial')]),
        }
        yield { type: 'done', reason: 'stop', message: message([textContent('partial')]) }
      } finally {
        abortedWhenClosed = signals[0]?.aborted === true
        closed.resolve()
      }
    }

    const received: StreamChunk[] = []
    for await (const chunk of runOmpCall(
      callFixture(backend, optionsWith(probes, caller.signal), state),
    )) {
      received.push(chunk)
      if (chunk.type === 'first-byte') break
    }

    await closed.promise
    expect(received.map((chunk) => chunk.type)).toEqual(['first-byte'])
    // Close aborts the producer before closing its iterator.
    expect(abortedWhenClosed).toBe(true)
    expect(signals[0]?.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    expect(state.attempts).toBe(1)
  })

  test('usage counters are canonical non-negative values, including -0', async () => {
    const state = new OmpCallState()
    const probes = createOmpProbes(state, fetchProbe().fetch)
    const weirdUsage = usageWith(-0)

    const backend: OmpStreamBackend = async function* (_model, _context, options) {
      await options.fetch?.('https://omp.test/v1/messages', push)
      yield { type: 'start', partial: message([]) }
      yield { type: 'text_start', contentIndex: 0, partial: message([textContent('')]) }
      yield {
        type: 'text_end',
        contentIndex: 0,
        content: 'ok',
        partial: message([textContent('ok')]),
      }
      yield {
        type: 'done',
        reason: 'stop',
        message: message([textContent('ok')], 'stop', weirdUsage),
      }
    }

    const chunks = await collect(runOmpCall(callFixture(backend, optionsWith(probes), state)))
    const usageChunk = chunks.find((chunk) => chunk.type === 'usage')
    if (usageChunk?.type !== 'usage') throw new Error('usage chunk missing')
    const usage = usageChunk.usage

    for (const count of [
      usage.inputUncachedTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.outputTokens,
    ]) {
      expect(Object.is(count, -0)).toBe(false)
      expect(Object.is(count, 0)).toBe(true)
    }
    expect(isSome(usage.reasoningTokens)).toBe(true)
    if (isSome(usage.reasoningTokens))
      expect(Object.is(usage.reasoningTokens.value, -0)).toBe(false)
    expect(isSome(usage.authoritativeCostUsd)).toBe(true)
    if (isSome(usage.authoritativeCostUsd)) {
      expect(Object.is(usage.authoritativeCostUsd.value, -0)).toBe(false)
    }
    expectLegalStream(chunks)
  })
})

describe('OMP failure output', () => {
  test('a canonical zero retry hint stays valid public failure output', () => {
    const failure = ompFailure('RATE_LIMIT', 'rate limited', { retryAfterMs: some(-0) })

    expect(failure.retryAfterMs.kind).toBe('some')
    if (failure.retryAfterMs.kind !== 'some') return
    expect(Object.is(failure.retryAfterMs.value, -0)).toBe(false)
    expect(Object.is(failure.retryAfterMs.value, 0)).toBe(true)

    // The neutral Guard consumes the emitted failure directly.
    const guard = new StreamProtocolGuard()
    guard.accept({
      type: 'finish',
      reason: { kind: 'error', failure },
      replayState: NONE,
      observedAttempts: 0,
    })
    guard.end()
  })
})
