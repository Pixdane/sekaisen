import { describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { InvariantError, isOption, isSome, NONE, some } from '@sekaisen/core'
import type {
  BoundWireChatRequest,
  CacheAlignedChatRequest,
  DisjointTokenUsage,
  FinishReason,
  LlmFailure,
  MockTurn,
  ModelCapabilities,
  ModelId,
  PreparedChatCallSnapshot,
  ReplayEnvelope,
  RouteId,
  StreamChunk,
  ToolCallId,
} from '@sekaisen/plugin-llm'
import {
  guardStream,
  MockAdapter,
  parsePartialJson,
  StreamAssembler,
  StreamProtocolGuard,
} from '@sekaisen/plugin-llm'
import { cloneFrozen, failure, validString } from '../packages/plugin-llm/src/utils.ts'

const ROUTE = 'mock-route' as RouteId
const MODEL = 'mock-model' as ModelId
const TOOL_ID = 'call-1' as ToolCallId

const USAGE: DisjointTokenUsage = {
  inputUncachedTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 2,
  reasoningTokens: NONE,
  authoritativeCostUsd: some(0),
}

const CAPABILITIES: ModelCapabilities = {
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  supportedEfforts: Object.freeze(['low', 'medium', 'high'] as const),
  canDisableReasoning: true,
  supportsSamplingWhenThinking: true,
  supportsSamplingParams: true,
  supportsPenaltiesAndStop: true,
  forcedToolChoiceSupport: 'named',
  disableReasoningOnForcedToolChoice: false,
  systemPromptUpdate: 'leading-only',
  toolSchemaDialect: 'openai-strict',
}

function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected Ok, received ${JSON.stringify(result.error)}`)
  return result.value
}

function requestFixture(): CacheAlignedChatRequest {
  return {
    segment1Static: [{ name: 'system', text: 'be brief' }],
    segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    segment3VolatileTail: NONE,
    sharedPrefixKey: NONE,
  }
}

function snapshotFixture(): PreparedChatCallSnapshot {
  return {
    routeId: ROUTE,
    modelId: MODEL,
    retryOwnership: 'caller-owned-single-attempt',
    capabilities: CAPABILITIES,
    request: requestFixture(),
    tools: [],
    effectiveEffort: 'off',
    effectiveToolChoice: { kind: 'auto' },
    downgradedToolChoice: false,
    sampling: {
      temperature: NONE,
      topP: NONE,
      frequencyPenalty: NONE,
      presencePenalty: NONE,
      stopSequences: [],
      maxOutputTokens: NONE,
      cacheRetention: 'none',
      sessionAffinityKey: NONE,
    },
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function* fromChunks(
  chunks: readonly StreamChunk[],
): AsyncGenerator<StreamChunk, void, undefined> {
  for (const chunk of chunks) yield chunk
}

function replayEnvelope(blockCount: number): Option<ReplayEnvelope> {
  return some({
    adapterKind: 'test:mock',
    version: 1,
    response: { ok: true },
    blocks: Array.from({ length: blockCount }, (_unused, index) => ({ index })),
  })
}

function toolStreamChunks(replay: Option<ReplayEnvelope>): readonly StreamChunk[] {
  return [
    { type: 'first-byte' },
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, delta: 'hi' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    {
      type: 'block-start',
      index: 1,
      blockType: 'tool-call',
      toolCallId: TOOL_ID,
      toolName: 'lookup',
    },
    { type: 'tool-call-delta', index: 1, delta: '{"q":' },
    { type: 'tool-call-delta', index: 1, delta: '"x"}' },
    {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: TOOL_ID, name: 'lookup', argumentsJson: '{"q":"x"}' },
    },
    { type: 'usage', usage: USAGE },
    { type: 'finish', reason: { kind: 'tool-calls' }, replayState: replay, observedAttempts: 1 },
  ]
}

function errorFinish(code: LlmFailure['code'], attempts: number): StreamChunk {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: failure(code, 'fixture failure') },
    replayState: NONE,
    observedAttempts: attempts,
  }
}

describe('StreamProtocolGuard valid lifecycle', () => {
  test('accepts a full text/tool/usage/finish stream and then requires end', () => {
    const guard = new StreamProtocolGuard()
    for (const chunk of toolStreamChunks(replayEnvelope(2))) guard.accept(chunk)
    expect(guard.phase).toBe('finished')
    expect(guard.nextBlockIndex).toBe(2)
    guard.end()
  })

  test('accepts an error finish from init with zero observed attempts', () => {
    const guard = new StreamProtocolGuard()
    guard.accept(errorFinish('TRANSPORT', 0))
    expect(guard.phase).toBe('finished')
    guard.end()
  })

  test('accepts an aborted finish with open blocks and replay NONE', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    guard.accept({ type: 'text-delta', index: 0, delta: 'partial' })
    guard.accept({
      type: 'finish',
      reason: { kind: 'aborted', failure: failure('ABORTED', 'caller aborted') },
      replayState: NONE,
      observedAttempts: 1,
    })
    guard.end()
  })

  test('accepts a reasoning block and a max-tokens finish', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'reasoning' })
    guard.accept({ type: 'reasoning-delta', index: 0, delta: 'think' })
    guard.accept({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } })
    guard.accept({
      type: 'finish',
      reason: { kind: 'max-tokens' },
      replayState: NONE,
      observedAttempts: 1,
    })
    guard.end()
  })
})

describe('StreamProtocolGuard invalid transitions', () => {
  test('rejects block-start before first-byte', () => {
    const guard = new StreamProtocolGuard()
    expect(() => guard.accept({ type: 'block-start', index: 0, blockType: 'text' })).toThrow(
      InvariantError,
    )
  })

  test('rejects a duplicated first-byte frame', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    expect(() => guard.accept({ type: 'first-byte' })).toThrow(InvariantError)
  })

  test('rejects skipped and duplicated block indexes', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    expect(() => guard.accept({ type: 'block-start', index: 1, blockType: 'text' })).toThrow(
      InvariantError,
    )
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    expect(() => guard.accept({ type: 'block-start', index: 0, blockType: 'text' })).toThrow(
      InvariantError,
    )
  })

  test('rejects tool-call blocks without id or name and text blocks carrying them', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    expect(() =>
      guard.accept({ type: 'block-start', index: 0, blockType: 'tool-call', toolName: 'lookup' }),
    ).toThrow(InvariantError)
    expect(() =>
      guard.accept({ type: 'block-start', index: 0, blockType: 'text', toolCallId: TOOL_ID }),
    ).toThrow(InvariantError)
  })

  test('rejects deltas for unknown, closed or mismatched blocks and ill-formed deltas', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    expect(() => guard.accept({ type: 'text-delta', index: 0, delta: 'x' })).toThrow(InvariantError)
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    expect(() => guard.accept({ type: 'reasoning-delta', index: 0, delta: 'x' })).toThrow(
      InvariantError,
    )
    expect(() => guard.accept({ type: 'text-delta', index: 0, delta: '\uD800' })).toThrow(
      InvariantError,
    )
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } })
    expect(() => guard.accept({ type: 'text-delta', index: 0, delta: 'y' })).toThrow(InvariantError)
  })

  test('rejects block-end without start, mismatched type, closed block and tool metadata drift', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    expect(() =>
      guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } }),
    ).toThrow(InvariantError)
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    expect(() =>
      guard.accept({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } }),
    ).toThrow(InvariantError)
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
    expect(() =>
      guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } }),
    ).toThrow(InvariantError)
    guard.accept({
      type: 'block-start',
      index: 1,
      blockType: 'tool-call',
      toolCallId: TOOL_ID,
      toolName: 'lookup',
    })
    expect(() =>
      guard.accept({
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: TOOL_ID, name: 'other', argumentsJson: '{}' },
      }),
    ).toThrow(InvariantError)
  })

  test('rejects usage before any block, duplicated usage and post-usage blocks', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    expect(() => guard.accept({ type: 'usage', usage: USAGE })).toThrow(InvariantError)
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
    guard.accept({ type: 'usage', usage: USAGE })
    expect(() => guard.accept({ type: 'usage', usage: USAGE })).toThrow(InvariantError)
    expect(() => guard.accept({ type: 'block-start', index: 1, blockType: 'text' })).toThrow(
      InvariantError,
    )
  })

  test('usage waits for every interleaved block to close, including before an error finish', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    guard.accept({ type: 'text-delta', index: 0, delta: 'answer' })
    guard.accept({ type: 'block-start', index: 1, blockType: 'reasoning' })
    guard.accept({ type: 'reasoning-delta', index: 1, delta: 'partial' })
    guard.accept({
      type: 'block-start',
      index: 2,
      blockType: 'tool-call',
      toolCallId: TOOL_ID,
      toolName: 'lookup',
    })
    guard.accept({
      type: 'block-end',
      index: 2,
      block: { type: 'tool-call', id: TOOL_ID, name: 'lookup', argumentsJson: '{}' },
    })
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } })
    expect(() => guard.accept({ type: 'usage', usage: USAGE })).toThrow(InvariantError)
    // Rejection must leave the stream able to close its remaining block.
    guard.accept({ type: 'block-end', index: 1, block: { type: 'reasoning', text: 'partial' } })
    guard.accept({ type: 'usage', usage: USAGE })
    // Usage measures this attempt; it is not a successful-finish guarantee.
    guard.accept(errorFinish('TRANSPORT', 1))
    guard.end()
  })

  test('an interrupted open block can finish with an error without emitting usage', () => {
    const assembler = new StreamAssembler()
    assembler.accept({ type: 'first-byte' })
    assembler.accept({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.accept({ type: 'text-delta', index: 0, delta: 'partial' })
    expect(() => assembler.accept({ type: 'usage', usage: USAGE })).toThrow(InvariantError)
    assembler.accept(errorFinish('TRANSPORT', 1))
    const snapshot = assembler.snapshot()
    expect(snapshot.usage).toBe(NONE)
    expect(snapshot.blocks).toEqual([])
    expect(snapshot.finishReason).toEqual(
      some({
        kind: 'error',
        failure: failure('TRANSPORT', 'fixture failure'),
      }),
    )
  })

  test('rejects invalid usage numerics', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
    expect(() =>
      guard.accept({
        type: 'usage',
        usage: { ...USAGE, inputUncachedTokens: -1 },
      }),
    ).toThrow(InvariantError)
    expect(() => guard.accept({ type: 'usage', usage: { ...USAGE, outputTokens: 1.5 } })).toThrow(
      InvariantError,
    )
    expect(() =>
      guard.accept({ type: 'usage', usage: { ...USAGE, authoritativeCostUsd: some(-1) } }),
    ).toThrow(InvariantError)
  })

  test('rejects normal finish from init or without content blocks', () => {
    const guard = new StreamProtocolGuard()
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: NONE,
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
    guard.accept({ type: 'first-byte' })
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: NONE,
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
  })

  test('rejects normal finish with open blocks or tool-calls without tool blocks', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: NONE,
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: NONE,
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
  })

  test('rejects replay blocks misaligned with content blocks', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    guard.accept({ type: 'block-end', index: 0, block: { type: 'text', text: '' } })
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: replayEnvelope(2),
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
    guard.accept({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: replayEnvelope(1),
      observedAttempts: 1,
    })
    guard.end()
  })

  test('rejects invalid observedAttempts and error finish carrying replay state', () => {
    const guard = new StreamProtocolGuard()
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'error', failure: failure('TRANSPORT', 'x') },
        replayState: NONE,
        observedAttempts: 1.5,
      }),
    ).toThrow(InvariantError)
    guard.accept({ type: 'first-byte' })
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'error', failure: failure('TRANSPORT', 'x') },
        replayState: NONE,
        observedAttempts: 0,
      }),
    ).toThrow(InvariantError)
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'error', failure: failure('TRANSPORT', 'x') },
        replayState: replayEnvelope(0),
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
  })

  test('aborted finish rejects non-ABORTED failure before any output', () => {
    const guard = new StreamProtocolGuard()
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'aborted', failure: failure('TRANSPORT', 'socket closed') },
        replayState: NONE,
        observedAttempts: 0,
      }),
    ).toThrow(InvariantError)
    guard.accept({
      type: 'finish',
      reason: { kind: 'aborted', failure: failure('ABORTED', 'caller cancelled') },
      replayState: NONE,
      observedAttempts: 0,
    })
    guard.end()
  })

  test('error finish rejects ABORTED failure even with an open block', () => {
    const guard = new StreamProtocolGuard()
    guard.accept({ type: 'first-byte' })
    guard.accept({ type: 'block-start', index: 0, blockType: 'text' })
    expect(() =>
      guard.accept({
        type: 'finish',
        reason: { kind: 'error', failure: failure('ABORTED', 'caller cancelled') },
        replayState: NONE,
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
    guard.accept(errorFinish('TRANSPORT', 1))
    guard.end()
  })

  test('rejects any frame after finish and iteration ending before finish', () => {
    const guard = new StreamProtocolGuard()
    guard.accept(errorFinish('TRANSPORT', 1))
    expect(() => guard.accept({ type: 'first-byte' })).toThrow(InvariantError)
    const unfinished = new StreamProtocolGuard()
    expect(() => unfinished.end()).toThrow(InvariantError)
    unfinished.accept({ type: 'first-byte' })
    expect(() => unfinished.end()).toThrow(InvariantError)
  })

  test('rejects prototype names used as block types or finish kinds', () => {
    const blockGuard = new StreamProtocolGuard()
    blockGuard.accept({ type: 'first-byte' })
    expect(() =>
      blockGuard.accept({
        type: 'block-start',
        index: 0,
        blockType: 'toString' as unknown as 'text',
      }),
    ).toThrow(InvariantError)
    const finishGuard = new StreamProtocolGuard()
    expect(() =>
      finishGuard.accept({
        type: 'finish',
        reason: {
          kind: 'constructor',
          failure: failure('TRANSPORT', 'x'),
        } as unknown as FinishReason,
        replayState: NONE,
        observedAttempts: 1,
      }),
    ).toThrow(InvariantError)
    const hasOwnGuard = new StreamProtocolGuard()
    hasOwnGuard.accept({ type: 'first-byte' })
    expect(() =>
      hasOwnGuard.accept({
        type: 'block-start',
        index: 0,
        blockType: 'hasOwnProperty' as unknown as 'text',
      }),
    ).toThrow(InvariantError)
  })

  test('rejects unknown chunk types and non-object frames', () => {
    const guard = new StreamProtocolGuard()
    expect(() => guard.accept({ type: 'bogus' } as unknown as StreamChunk)).toThrow(InvariantError)
    expect(() => guard.accept(null as unknown as StreamChunk)).toThrow(InvariantError)
  })
})

describe('guardStream normalization boundary', () => {
  test('pre-aborted signal yields exactly one aborted frame and never calls the factory', async () => {
    const controller = new AbortController()
    controller.abort()
    let factoryCalled = false
    const chunks = await collect(
      guardStream(() => {
        factoryCalled = true
        return fromChunks([{ type: 'first-byte' }])
      }, controller.signal),
    )
    expect(factoryCalled).toBe(false)
    expect(chunks).toHaveLength(1)
    const finished = chunks[0]!
    expect(finished.type).toBe('finish')
    if (finished.type !== 'finish') return
    const reason = finished.reason
    expect(reason.kind).toBe('aborted')
    if (reason.kind === 'aborted') expect(reason.failure.code).toBe('ABORTED')
    expect(finished.observedAttempts).toBe(0)
    expect(finished.replayState.kind).toBe('none')
  })

  test('synchronous factory failure becomes one error finish frame', async () => {
    const chunks = await collect(
      guardStream(() => {
        throw new Error('connect ECONNREFUSED')
      }, new AbortController().signal),
    )
    expect(chunks).toHaveLength(1)
    const finished = chunks[0]!
    if (finished.type !== 'finish') throw new Error('expected finish')
    const reason = finished.reason
    expect(reason.kind).toBe('error')
    if (reason.kind !== 'error') return
    expect(reason.failure.code).toBe('TRANSPORT')
    expect(reason.failure.message).toBe('connect ECONNREFUSED')
    expect(finished.observedAttempts).toBe(0)
  })

  test('mid-stream rejection becomes one aborted frame when the signal aborted', async () => {
    const controller = new AbortController()
    const stream = guardStream(
      async function* failing(): AsyncGenerator<StreamChunk, void, undefined> {
        yield { type: 'first-byte' }
        throw new Error('socket reset during abort')
      },
      controller.signal,
      { observedAttempts: () => 1 },
    )
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort()
    const second = await iterator.next()
    expect(second.done).toBe(false)
    const finished = second.value!
    if (finished.type !== 'finish') throw new Error('expected finish')
    const reason = finished.reason
    expect(reason.kind).toBe('aborted')
    if (reason.kind !== 'aborted') return
    expect(reason.failure.code).toBe('ABORTED')
    expect(reason.failure.message).toBe('chat call was aborted by the caller')
    expect(finished.observedAttempts).toBe(1)
    expect((await iterator.next()).done).toBe(true)
  })

  test('a zero attempt probe after output is rejected instead of clamped', async () => {
    await expect(
      collect(
        guardStream(
          async function* failing(): AsyncGenerator<StreamChunk, void, undefined> {
            yield { type: 'first-byte' }
            throw new Error('socket reset')
          },
          new AbortController().signal,
          { observedAttempts: () => 0 },
        ),
      ),
    ).rejects.toThrow(InvariantError)
  })

  test('rethrows InvariantError from invalid frames instead of masking it', async () => {
    await expect(
      collect(
        guardStream(
          () => fromChunks([{ type: 'block-start', index: 0, blockType: 'text' }]),
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(InvariantError)
  })

  test('rejects iteration that ends without a finish frame', async () => {
    await expect(
      collect(
        guardStream(() => fromChunks([{ type: 'first-byte' }]), new AbortController().signal),
      ),
    ).rejects.toThrow(InvariantError)
  })

  test('rethrows a non-InvariantError raised after finish', async () => {
    await expect(
      collect(
        guardStream(async function* afterFinish(): AsyncGenerator<StreamChunk, void, undefined> {
          yield errorFinish('TRANSPORT', 1)
          throw new Error('late transport noise')
        }, new AbortController().signal),
      ),
    ).rejects.toThrow('late transport noise')
  })

  test('classifier and attempt probe defects are invariants', async () => {
    await expect(
      collect(
        guardStream(
          () => {
            throw new Error('boom')
          },
          new AbortController().signal,
          { classify: () => ({ bogus: true }) as unknown as LlmFailure },
        ),
      ),
    ).rejects.toThrow(InvariantError)
    await expect(
      collect(
        guardStream(
          () => {
            throw new Error('boom')
          },
          new AbortController().signal,
          { observedAttempts: () => -3 },
        ),
      ),
    ).rejects.toThrow(InvariantError)
  })

  test('closes the inner iterator when the consumer stops early', async () => {
    let closed = false
    async function* infinite(): AsyncGenerator<StreamChunk, void, undefined> {
      try {
        yield { type: 'first-byte' }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, delta: 'never consumed' }
      } finally {
        closed = true
      }
    }
    for await (const chunk of guardStream(infinite, new AbortController().signal)) {
      expect(chunk.type).toBe('first-byte')
      break
    }
    expect(closed).toBe(true)
  })
})

describe('StreamAssembler assembly', () => {
  test('assembles blocks, usage, replay and finish reason', () => {
    const assembler = new StreamAssembler({ enablePartialToolJson: true })
    for (const chunk of toolStreamChunks(replayEnvelope(2))) assembler.accept(chunk)
    const snapshot = assembler.snapshot()
    expect(snapshot.blocks).toHaveLength(2)
    expect(snapshot.blocks[0]).toEqual({ type: 'text', text: 'hi' })
    expect(snapshot.blocks[1]).toEqual({
      type: 'tool-call',
      id: TOOL_ID,
      name: 'lookup',
      argumentsJson: '{"q":"x"}',
    })
    expect(snapshot.usage).toEqual(some(USAGE))
    expect(snapshot.finishReason).toEqual(some({ kind: 'tool-calls' }))
    expect(snapshot.observedAttempts).toEqual(some(1))
    expect(isSome(snapshot.replayState)).toBe(true)
    expect(snapshot.toolCalls).toHaveLength(1)
    expect(snapshot.toolCalls[0]!.argumentsJson).toBe('{"q":"x"}')
    expect(snapshot.toolCalls[0]!.partialArguments).toEqual(some({ q: 'x' }))
  })

  test('consume drains a stream and rejects an unfinished or reused assembler', async () => {
    const assembler = new StreamAssembler()
    const snapshot = await assembler.consume(fromChunks(toolStreamChunks(NONE)))
    expect(snapshot.finishReason).toEqual(some({ kind: 'tool-calls' }))
    await expect(assembler.consume(fromChunks(toolStreamChunks(NONE)))).rejects.toThrow(
      InvariantError,
    )

    const unfinished = new StreamAssembler()
    await expect(unfinished.consume(fromChunks([{ type: 'first-byte' }]))).rejects.toThrow(
      InvariantError,
    )
  })

  test('rejects misuse when protocol validation is active', () => {
    const assembler = new StreamAssembler()
    expect(() => assembler.accept({ type: 'text-delta', index: 0, delta: 'x' })).toThrow(
      InvariantError,
    )
    assembler.accept({ type: 'first-byte' })
    assembler.accept({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.accept({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } })
    assembler.accept({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: NONE,
      observedAttempts: 1,
    })
    expect(() => assembler.accept({ type: 'text-delta', index: 0, delta: 'late' })).toThrow(
      InvariantError,
    )
  })

  test('accepts out-of-order block closure and orders blocks by index', () => {
    const chunks: readonly StreamChunk[] = [
      { type: 'first-byte' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, delta: 'zero' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, delta: 'one' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'one' } },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'zero' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: NONE, observedAttempts: 1 },
    ]
    const guard = new StreamProtocolGuard()
    for (const chunk of chunks) guard.accept(chunk)
    guard.end()
    const assembler = new StreamAssembler()
    for (const chunk of chunks) assembler.accept(chunk)
    expect(assembler.blocks).toEqual([
      { type: 'text', text: 'zero' },
      { type: 'text', text: 'one' },
    ])
    expect(assembler.snapshot().blocks).toEqual(assembler.blocks)
    expect(assembler.finishReason).toEqual(some({ kind: 'stop' }))
  })

  test('snapshots omit open blocks for unfinished and failed streams', () => {
    const assembler = new StreamAssembler()
    assembler.accept({ type: 'first-byte' })
    assembler.accept({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.accept({ type: 'text-delta', index: 0, delta: 'open' })
    assembler.accept({ type: 'block-start', index: 1, blockType: 'text' })
    assembler.accept({ type: 'block-end', index: 1, block: { type: 'text', text: 'closed' } })
    expect(assembler.blocks).toEqual([{ type: 'text', text: 'closed' }])
    assembler.accept({
      type: 'finish',
      reason: { kind: 'error', failure: failure('TRANSPORT', 'socket reset') },
      replayState: NONE,
      observedAttempts: 1,
    })
    const snapshot = assembler.snapshot()
    expect(snapshot.blocks).toEqual([{ type: 'text', text: 'closed' }])
    expect(isSome(snapshot.finishReason)).toBe(true)
    expect(snapshot.observedAttempts).toEqual(some(1))
  })

  test('skips sub-threshold partial parses and forces one at block-end', () => {
    const assembler = new StreamAssembler({ enablePartialToolJson: true })
    assembler.accept({ type: 'first-byte' })
    assembler.accept({
      type: 'block-start',
      index: 0,
      blockType: 'tool-call',
      toolCallId: TOOL_ID,
      toolName: 'lookup',
    })
    assembler.accept({ type: 'tool-call-delta', index: 0, delta: '{"q":' })
    assembler.accept({ type: 'tool-call-delta', index: 0, delta: '"x"}' })
    expect(assembler.toolCalls[0]!.partialArguments).toEqual(NONE)
    assembler.accept({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: TOOL_ID, name: 'lookup', argumentsJson: '{"q":"x"}' },
    })
    expect(assembler.toolCalls[0]!.partialArguments).toEqual(some({ q: 'x' }))
  })

  test('parses partial tool arguments once the geometric growth gate opens', () => {
    const payload = { text: 'y'.repeat(400) }
    const argumentsJson = JSON.stringify(payload)
    const assembler = new StreamAssembler({ enablePartialToolJson: true })
    assembler.accept({ type: 'first-byte' })
    assembler.accept({
      type: 'block-start',
      index: 0,
      blockType: 'tool-call',
      toolCallId: TOOL_ID,
      toolName: 'lookup',
    })
    let sawPartialWhileOpen = false
    for (let offset = 0; offset < argumentsJson.length; offset += 40) {
      assembler.accept({
        type: 'tool-call-delta',
        index: 0,
        delta: argumentsJson.slice(offset, offset + 40),
      })
      if (isSome(assembler.toolCalls[0]!.partialArguments)) sawPartialWhileOpen = true
    }
    expect(sawPartialWhileOpen).toBe(true)
    assembler.accept({
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: TOOL_ID, name: 'lookup', argumentsJson },
    })
    expect(assembler.toolCalls[0]!.partialArguments).toEqual(some(payload))
  })
})

describe('parsePartialJson', () => {
  test('parses complete and truncated JSON prefixes', () => {
    expect(parsePartialJson('{"a":1}')).toEqual(some({ a: 1 }))
    expect(parsePartialJson('{"city":"Par')).toEqual(some({ city: 'Par' }))
    expect(parsePartialJson('[1,2')).toEqual(some([1, 2]))
    expect(parsePartialJson('{"a":[1,2],')).toEqual(some({ a: [1, 2] }))
    expect(parsePartialJson('{"a":"x\\')).toEqual(some({ a: 'x' }))
  })

  test('returns NONE when no prefix value is recoverable', () => {
    expect(parsePartialJson('')).toEqual(NONE)
    expect(parsePartialJson('   ')).toEqual(NONE)
    expect(parsePartialJson('{"a":')).toEqual(NONE)
    expect(parsePartialJson('{"a":}:')).toEqual(NONE)
    expect(parsePartialJson('[1,2,')).toEqual(some([1, 2]))
    expect(parsePartialJson('{"a":"\\u00')).toEqual(NONE)
  })

  test('rejects ill-formed input as a program defect', () => {
    expect(() => parsePartialJson('\uD800')).toThrow(InvariantError)
  })
})

describe('utils invariants', () => {
  test('validString enforces well-formed Unicode and optional non-emptiness', () => {
    expect(validString('ok')).toBe(true)
    expect(validString('ok', true)).toBe(true)
    expect(validString('')).toBe(true)
    expect(validString('', true)).toBe(false)
    expect(validString('\uDC00')).toBe(false)
    expect(validString(42)).toBe(false)
  })

  test('failure freezes a fully validated structure and preserves genuine Options', () => {
    const value = failure('RATE_LIMIT', 'slow down', {
      status: some(429),
      retryAfterMs: some(1_500),
    })
    expect(Object.isFrozen(value)).toBe(true)
    expect(value.code).toBe('RATE_LIMIT')
    expect(value.status).toEqual(some(429))
    expect(value.requestId).toEqual(NONE)
    expect(() => failure('RATE_LIMIT', 'x', { status: some(99) })).toThrow(InvariantError)
    expect(() => failure('RATE_LIMIT', 'x', { retryAfterMs: some(Number.NaN) })).toThrow(
      InvariantError,
    )
  })

  test('cloneFrozen deep-copies plain data and preserves nominal Options', () => {
    const source = {
      present: some({ nested: [1, 2] }),
      absent: NONE,
      negativeZero: -0,
      list: [{ deep: true }],
    }
    const copy = cloneFrozen(source)
    expect(copy).not.toBe(source)
    expect(isOption(copy.present)).toBe(true)
    expect(isSome(copy.present)).toBe(true)
    expect(copy.present).not.toBe(source.present)
    expect(copy.absent).toBe(NONE)
    expect(Object.is(copy.negativeZero, 0)).toBe(true)
    expect(Object.isFrozen(copy)).toBe(true)
    expect(Object.isFrozen(copy.list)).toBe(true)
    expect(Object.isFrozen(copy.list[0])).toBe(true)
    expect(Object.isFrozen(copy.present.value.nested)).toBe(true)
  })

  test('cloneFrozen preserves JSON own __proto__ and constructor keys without pollution', () => {
    const parsed = JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}') as Record<
      string,
      unknown
    >
    parsed.option = some({ kept: true })
    const copy = cloneFrozen(parsed)
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
    expect(Object.hasOwn(copy, '__proto__')).toBe(true)
    expect(Object.hasOwn(copy, 'constructor')).toBe(true)
    const protoValue: unknown = Reflect.get(copy, '__proto__')
    expect(protoValue).toEqual({ safe: true })
    const constructorValue: unknown = Reflect.get(copy, 'constructor')
    expect(constructorValue).toBe('value')
    expect(Object.isFrozen(protoValue)).toBe(true)
    expect(Object.hasOwn(Object.prototype, 'safe')).toBe(false)
    expect(Object.isFrozen(copy)).toBe(true)
    const option = copy.option
    expect(isOption(option)).toBe(true)
    if (isOption(option) && isSome(option)) expect(option.value).toEqual({ kept: true })
  })

  test('cloneFrozen rejects cycles, non-finite numbers and unsupported values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => cloneFrozen(cyclic)).toThrow(InvariantError)
    expect(() => cloneFrozen({ value: Number.POSITIVE_INFINITY })).toThrow(InvariantError)
    expect(() => cloneFrozen({ value: () => 1 })).toThrow(InvariantError)
    expect(() => cloneFrozen({ value: new Date() })).toThrow(InvariantError)
  })
})

describe('MockAdapter', () => {
  function bindMock(
    adapter: MockAdapter,
  ): (request: BoundWireChatRequest, signal: AbortSignal) => AsyncIterable<StreamChunk> {
    return expectOk(adapter.bindGeneration(ROUTE, MODEL))
  }

  test('rejects invalid route and model ids with INVALID_ROUTE', () => {
    const adapter = new MockAdapter()
    const badRoute = adapter.resolveCapabilities('' as RouteId, MODEL)
    expect(badRoute.ok).toBe(false)
    if (!badRoute.ok) expect(badRoute.error.code).toBe('INVALID_ROUTE')
    const badModel = adapter.bindGeneration(ROUTE, '\uD800' as ModelId)
    expect(badModel.ok).toBe(false)
    if (!badModel.ok) expect(badModel.error.code).toBe('INVALID_ROUTE')
  })

  test('emits a guard-valid echo text stream and records the request', async () => {
    const adapter = new MockAdapter()
    const stream = bindMock(adapter)
    const iot = new AbortController()
    const chunks = await collect(
      guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
        observedAttempts: () => adapter.physicalAttempts(),
      }),
    )
    const assembler = new StreamAssembler()
    for (const chunk of chunks) assembler.accept(chunk)
    const snapshot = assembler.snapshot()
    expect(snapshot.blocks).toEqual([{ type: 'text', text: 'hello' }])
    expect(snapshot.finishReason).toEqual(some({ kind: 'stop' }))
    expect(snapshot.usage.kind).toBe('some')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.physicalAttempts()).toBe(1)
  })

  test('scripts tool-call turns including aligned replay state', async () => {
    const adapter = new MockAdapter({
      emitReplayState: true,
      turns: [
        {
          kind: 'tool-calls',
          text: 'checking',
          calls: [{ id: 'call-9', name: 'lookup', argumentsJson: '{"q":"x"}' }],
        },
      ],
    })
    const stream = bindMock(adapter)
    const iot = new AbortController()
    const assembler = new StreamAssembler({ enablePartialToolJson: true })
    const snapshot = await assembler.consume(
      guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
        observedAttempts: () => adapter.physicalAttempts(),
      }),
    )
    expect(snapshot.blocks).toHaveLength(2)
    expect(snapshot.finishReason).toEqual(some({ kind: 'tool-calls' }))
    expect(snapshot.toolCalls[0]!.argumentsJson).toBe('{"q":"x"}')
    expect(snapshot.toolCalls[0]!.partialArguments).toEqual(some({ q: 'x' }))
    if (!isSome(snapshot.replayState)) throw new Error('expected replay state')
    expect(snapshot.replayState.value.blocks?.length).toBe(2)
    expect(adapter.pendingTurns).toBe(0)
  })

  test('preserves disableStrictTools and rejects a non-boolean flag', () => {
    const enabled = new MockAdapter({ capabilities: { disableStrictTools: true } })
    expect(enabled.capabilities.disableStrictTools).toBe(true)
    expect(new MockAdapter().capabilities.disableStrictTools).toBeUndefined()
    expect(
      () =>
        new MockAdapter({
          capabilities: { disableStrictTools: 'yes' } as unknown as Partial<ModelCapabilities>,
        }),
    ).toThrow(InvariantError)
  })

  test('scripts max-token truncation', async () => {
    const adapter = new MockAdapter({
      turns: [{ kind: 'text', text: 'partial', finish: 'max-tokens' }],
    })
    const stream = bindMock(adapter)
    const iot = new AbortController()
    const chunks = await collect(
      guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
        observedAttempts: () => adapter.physicalAttempts(),
      }),
    )
    const assembler = new StreamAssembler()
    for (const chunk of chunks) assembler.accept(chunk)
    expect(assembler.finishReason).toEqual(some({ kind: 'max-tokens' }))
  })

  test('scripts a pre-output failure as a single error finish', async () => {
    const adapter = new MockAdapter({
      turns: [
        {
          kind: 'failure',
          failure: failure('RATE_LIMIT', 'rate limited', { status: some(429) }),
        },
      ],
    })
    const stream = bindMock(adapter)
    const iot = new AbortController()
    const chunks = await collect(
      guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
        observedAttempts: () => adapter.physicalAttempts(),
      }),
    )
    expect(chunks).toHaveLength(1)
    const finished = chunks[0]!
    if (finished.type !== 'finish') throw new Error('expected finish')
    const reason = finished.reason
    if (reason.kind !== 'error') throw new Error('expected error finish')
    expect(reason.failure.code).toBe('RATE_LIMIT')
    expect(reason.failure.status).toEqual(some(429))
    expect(finished.observedAttempts).toBe(1)
  })

  test('emits an interrupted tool call before throwing, normalized to TRANSPORT', async () => {
    const adapter = new MockAdapter({
      turns: [
        {
          kind: 'throw',
          error: failure('TRANSPORT', 'socket closed mid-response'),
          prefix: { tool: { id: 'call-7', name: 'lookup', argumentsJsonPrefix: '{"q":' } },
        },
      ],
    })
    const stream = bindMock(adapter)
    const iot = new AbortController()
    const chunks = await collect(
      guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
        observedAttempts: () => adapter.physicalAttempts(),
      }),
    )
    expect(chunks.some((chunk) => chunk.type === 'tool-call-delta')).toBe(true)
    const finished = chunks.at(-1)!
    if (finished.type !== 'finish') throw new Error('expected finish')
    const reason = finished.reason
    if (reason.kind !== 'error') throw new Error('expected error finish')
    expect(reason.failure.code).toBe('TRANSPORT')
    expect(finished.observedAttempts).toBe(1)
    expect(finished.replayState.kind).toBe('none')
  })

  test('pre-aborted signal yields one aborted frame without recording an attempt', async () => {
    const adapter = new MockAdapter()
    const stream = bindMock(adapter)
    const iot = new AbortController()
    iot.abort()
    const chunks = await collect(
      guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
        observedAttempts: () => adapter.physicalAttempts(),
      }),
    )
    expect(chunks).toHaveLength(1)
    const finished = chunks[0]!
    if (finished.type !== 'finish') throw new Error('expected finish')
    expect(finished.reason.kind).toBe('aborted')
    expect(finished.observedAttempts).toBe(0)
    expect(adapter.physicalAttempts()).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  test('silent early close violates the protocol guard', async () => {
    const adapter = new MockAdapter({
      turns: [{ kind: 'close-early', prefix: { text: 'half' } }],
    })
    const stream = bindMock(adapter)
    const iot = new AbortController()
    await expect(
      collect(
        guardStream(() => stream({ snapshot: snapshotFixture() }, iot.signal), iot.signal, {
          observedAttempts: () => adapter.physicalAttempts(),
        }),
      ),
    ).rejects.toThrow(InvariantError)
  })

  test('reset clears script, recordings and attempt counter; respond hook supplies turns', async () => {
    const adapter = new MockAdapter({
      respond: (snapshot) => ({
        kind: 'text',
        text: `saw ${snapshot.request.segment1Static.length}`,
      }),
    })
    const stream = bindMock(adapter)
    const iot = new AbortController()
    const chunks = await collect(stream({ snapshot: snapshotFixture() }, iot.signal))
    const assembler = new StreamAssembler()
    for (const chunk of chunks) assembler.accept(chunk)
    expect(assembler.blocks).toEqual([{ type: 'text', text: 'saw 1' }])
    adapter.reset()
    expect(adapter.pendingTurns).toBe(0)
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.physicalAttempts()).toBe(0)
  })

  test('rejects an empty tool-call script at emission time', async () => {
    const adapter = new MockAdapter({ turns: [{ kind: 'tool-calls', calls: [] }] })
    const stream = bindMock(adapter)
    await expect(
      collect(stream({ snapshot: snapshotFixture() }, new AbortController().signal)),
    ).rejects.toThrow(InvariantError)
  })

  test('supports raw chunk scripts for protocol fixtures', async () => {
    const raw: readonly StreamChunk[] = [
      { type: 'first-byte' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, delta: 'raw' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'raw' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: NONE, observedAttempts: 1 },
    ]
    const adapter = new MockAdapter({ turns: [{ kind: 'chunks', chunks: raw }] })
    const stream = bindMock(adapter)
    const chunks = await collect(
      stream({ snapshot: snapshotFixture() }, new AbortController().signal),
    )
    expect(chunks).toEqual([...raw])
  })
})

describe('MockTurn type surface', () => {
  test('accepts every documented turn shape', () => {
    const turns: readonly MockTurn[] = [
      { kind: 'text', text: 'x' },
      { kind: 'text', text: 'x', reasoning: 'r', finish: 'max-tokens', usage: USAGE },
      {
        kind: 'tool-calls',
        calls: [{ id: 'c', name: 'n', argumentsJson: '{}' }],
        text: 'x',
        usage: USAGE,
      },
      { kind: 'failure', failure: failure('EMPTY_RESPONSE', 'empty'), observedAttempts: 1 },
      {
        kind: 'throw',
        error: new Error('x'),
        prefix: { text: 'p', tool: { id: 'c', name: 'n', argumentsJsonPrefix: '{' } },
      },
      { kind: 'chunks', chunks: [{ type: 'first-byte' }] },
      { kind: 'close-early', prefix: { text: 'p' } },
    ]
    expect(turns).toHaveLength(7)
  })
})
