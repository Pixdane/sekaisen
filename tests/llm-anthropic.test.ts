import { describe, expect, test } from 'bun:test'
import { isSome, NONE, type Option, some } from '@sekaisen/core'
import {
  ANTHROPIC_REPLAY_ADAPTER_KIND,
  anthropicEngine,
} from '../packages/plugin-llm/src/direct/anthropic.ts'
import type {
  DirectRouteConfig,
  SseEvent,
  WireRequest,
} from '../packages/plugin-llm/src/direct/contract.ts'
import type {
  ModelCapabilities,
  NeutralToolChoice,
  PreparedChatCallSnapshot,
  ReasoningEffort,
} from '../packages/plugin-llm/src/service-types.ts'
import type { NormalizedWireToolSchema } from '../packages/plugin-llm/src/tool-schema.ts'
import type {
  AssistantMessageOrigin,
  CacheAlignedChatRequest,
  LlmFailure,
  ModelId,
  NeutralMessage,
  ReplayEnvelope,
  RouteId,
  StreamChunk,
  ToolCallId,
} from '../packages/plugin-llm/src/types.ts'

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                  */
/* -------------------------------------------------------------------------- */

const ROUTE = 'route-anthropic' as RouteId
const MODEL = 'claude-test' as ModelId

type Json = Record<string, unknown>

function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value as Json
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected an array')
  return value
}

function makeCapabilities(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    supportedEfforts: ['low', 'medium', 'high'],
    canDisableReasoning: true,
    supportsSamplingWhenThinking: false,
    supportsSamplingParams: true,
    supportsPenaltiesAndStop: true,
    forcedToolChoiceSupport: 'named',
    disableReasoningOnForcedToolChoice: true,
    systemPromptUpdate: 'leading-only',
    toolSchemaDialect: 'anthropic',
    ...overrides,
  }
}

function defaultRequest(): CacheAlignedChatRequest {
  return {
    segment1Static: [{ name: 'system', text: 'Be precise.' }],
    segment2WarmHistory: [],
    segment3VolatileTail: NONE,
    sharedPrefixKey: NONE,
  }
}

interface SnapshotOptions {
  readonly capabilities?: ModelCapabilities
  readonly request?: CacheAlignedChatRequest
  readonly tools?: readonly NormalizedWireToolSchema[]
  readonly effort?: ReasoningEffort
  readonly toolChoice?: NeutralToolChoice
  readonly temperature?: Option<number>
  readonly maxOutputTokens?: Option<number>
  readonly cacheRetention?: 'none' | 'short' | 'long'
  readonly stopSequences?: readonly string[]
}

function makeSnapshot(options: SnapshotOptions = {}): PreparedChatCallSnapshot {
  return {
    routeId: ROUTE,
    modelId: MODEL,
    retryOwnership: 'caller-owned-single-attempt',
    capabilities: options.capabilities ?? makeCapabilities(),
    request: options.request ?? defaultRequest(),
    tools: options.tools ?? [],
    effectiveEffort: options.effort ?? 'off',
    effectiveToolChoice: options.toolChoice ?? { kind: 'auto' },
    downgradedToolChoice: false,
    sampling: {
      temperature: options.temperature ?? NONE,
      topP: NONE,
      frequencyPenalty: NONE,
      presencePenalty: NONE,
      stopSequences: options.stopSequences ?? [],
      maxOutputTokens: options.maxOutputTokens ?? NONE,
      cacheRetention: options.cacheRetention ?? 'short',
      sessionAffinityKey: NONE,
    },
  }
}

function makeRoute(overrides: Partial<DirectRouteConfig> = {}): DirectRouteConfig {
  return {
    protocol: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
    authMode: 'x-api-key',
    ...overrides,
  }
}

function origin(
  overrides: { routeId?: RouteId; modelId?: ModelId; replayState?: Option<ReplayEnvelope> } = {},
): AssistantMessageOrigin {
  return {
    routeId: overrides.routeId ?? ROUTE,
    modelId: overrides.modelId ?? MODEL,
    replayState: overrides.replayState ?? NONE,
  }
}

function envelope(
  blocks: readonly unknown[],
  adapterKind: string = ANTHROPIC_REPLAY_ADAPTER_KIND,
  version = 1,
): ReplayEnvelope {
  return { adapterKind, version, response: { messageId: 'msg_replay' }, blocks }
}

function textMessage(text: string, cacheBreakpoint?: 'ephemeral' | 'long'): NeutralMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    ...(cacheBreakpoint === undefined ? {} : { cacheBreakpoint }),
  }
}

function assistantMessage(
  content: Extract<NeutralMessage, { role: 'assistant' }>['content'],
  overrides: {
    routeId?: RouteId
    modelId?: ModelId
    replayState?: Option<ReplayEnvelope>
    cacheBreakpoint?: 'ephemeral' | 'long'
  } = {},
): NeutralMessage {
  return {
    role: 'assistant',
    content,
    origin: origin(overrides),
    ...(overrides.cacheBreakpoint === undefined
      ? {}
      : { cacheBreakpoint: overrides.cacheBreakpoint }),
  }
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce<number>((sum, item) => sum + countCacheControls(item), 0)
  if (typeof value === 'object' && value !== null) {
    let count = Object.hasOwn(value, 'cache_control') ? 1 : 0
    for (const key of Object.keys(value)) count += countCacheControls((value as Json)[key])
    return count
  }
  return 0
}

function built(options: SnapshotOptions = {}, route: DirectRouteConfig = makeRoute()): Json {
  return anthropicEngine.build(makeSnapshot(options), route).body as Json
}

function messageAt(body: Json, index: number): Json {
  return record(list(body.messages)[index])
}

function contentAt(body: Json, messageIndex: number): Json[] {
  return list(messageAt(body, messageIndex).content).map(record)
}

/* -------------------------------------------------------------------------- */
/*                                SSE helpers                                 */
/* -------------------------------------------------------------------------- */

function frame(event: string, data: unknown): SseEvent {
  return { event, data: typeof data === 'string' ? data : (JSON.stringify(data) ?? '') }
}

async function* iterate(events: readonly SseEvent[]): AsyncIterable<SseEvent> {
  for (const event of events) yield event
}

async function collect(
  events: readonly SseEvent[],
  snapshot = makeSnapshot(),
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of anthropicEngine.decode(iterate(events), snapshot, makeRoute()))
    chunks.push(chunk)
  return chunks
}

interface CollectedFailure {
  readonly chunks: readonly StreamChunk[]
  readonly error: LlmFailure
}

async function collectFailure(
  events: readonly SseEvent[],
  snapshot = makeSnapshot(),
): Promise<CollectedFailure> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of anthropicEngine.decode(iterate(events), snapshot, makeRoute()))
      chunks.push(chunk)
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error)) throw error
    return { chunks, error: error as LlmFailure }
  }
  throw new Error('expected the stream to fail')
}

function textFrames(
  options: { readonly empty?: boolean; readonly truncatedStop?: boolean } = {},
): readonly SseEvent[] {
  const frames: SseEvent[] = [
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', usage: { input_tokens: 8, output_tokens: 0 } },
    }),
  ]
  if (options.empty !== true) {
    frames.push(
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    )
  }
  if (options.truncatedStop !== true) {
    frames.push(
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 4 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    )
  }
  return frames
}

/* -------------------------------------------------------------------------- */
/*                             Request serialization                          */
/* -------------------------------------------------------------------------- */

describe('anthropic messages request', () => {
  test('anchors exactly two cache breakpoints and keeps the volatile tail uncached', () => {
    const body = built({
      request: {
        segment1Static: [{ name: 'system', text: 'Stable prefix.' }],
        segment2WarmHistory: [
          textMessage('first'),
          // An earlier hint must not move the mandatory warm-end breakpoint.
          assistantMessage([{ type: 'text', text: 'reply' }], { cacheBreakpoint: 'ephemeral' }),
          textMessage('second', 'long'),
        ],
        segment3VolatileTail: some('ctx <tag> & more'),
        sharedPrefixKey: NONE,
      },
    })

    expect(countCacheControls(body)).toBe(2)
    const systemBlocks = list(body.system).map(record)
    expect(systemBlocks).toHaveLength(1)
    expect(systemBlocks[0]!.text).toBe('Stable prefix.')
    expect(systemBlocks[0]!.cache_control).toEqual({ type: 'ephemeral' })

    expect(body.messages).toBeDefined()
    const messages = list(body.messages).map(record)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    // The earlier assistant hint is ignored; breakpoint #2 stays on the warm end.
    const assistantContent = list(messages[1]!.content).map(record)
    expect(assistantContent[0]!.cache_control).toBeUndefined()
    const trailing = list(messages[2]!.content).map(record)
    expect(trailing[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    // Volatile text merges into the trailing user turn with no breakpoint.
    expect(trailing[1]).toEqual({
      type: 'text',
      text: '\n\n<turn-context>ctx &lt;tag&gt; &amp; more</turn-context>',
    })
    expect(trailing[1]!.cache_control).toBeUndefined()
  })

  test('uses a new user turn when the warm history ends with an assistant reply', () => {
    const body = built({
      request: {
        segment1Static: [],
        segment2WarmHistory: [
          textMessage('question'),
          assistantMessage([{ type: 'text', text: 'answer' }]),
        ],
        segment3VolatileTail: some('turn context'),
        sharedPrefixKey: NONE,
      },
    })
    const messages = list(body.messages).map(record)
    expect(messages).toHaveLength(3)
    expect(messages[2]!.role).toBe('user')
    expect(list(messages[2]!.content).map(record)[0]).toEqual({
      type: 'text',
      text: '<turn-context>turn context</turn-context>',
    })
    expect(countCacheControls(body)).toBe(1)
    const anchored = list(messages[1]!.content).map(record)[0]!
    expect(anchored.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('projects the volatile tail as an incremental system turn for in-history targets', () => {
    const body = built({
      capabilities: makeCapabilities({ systemPromptUpdate: 'in-history' }),
      request: {
        segment1Static: [{ name: 'system', text: 'prefix' }],
        segment2WarmHistory: [textMessage('question')],
        segment3VolatileTail: some('tail text'),
        sharedPrefixKey: NONE,
      },
    })
    const messages = list(body.messages).map(record)
    expect(messages.map((message) => message.role)).toEqual(['user', 'system'])
    expect(list(messages[1]!.content).map(record)[0]).toEqual({
      type: 'text',
      text: 'tail text',
    })
    expect(countCacheControls(body)).toBe(2)
    expect(messages[1]!.cache_control).toBeUndefined()
  })

  test('disables every breakpoint when cache retention is off', () => {
    const body = built({
      cacheRetention: 'none',
      request: {
        segment1Static: [{ name: 'system', text: 'prefix' }],
        segment2WarmHistory: [textMessage('question')],
        segment3VolatileTail: some('tail'),
        sharedPrefixKey: NONE,
      },
    })
    expect(countCacheControls(body)).toBe(0)
  })

  test('serializes stable block arrays and merges consecutive tool results into one user turn', () => {
    const body = built({
      request: {
        segment1Static: [
          { name: 'system', text: 'one' },
          { name: 'system2', text: 'two' },
        ],
        segment2WarmHistory: [
          textMessage('question'),
          assistantMessage([
            {
              type: 'tool-call',
              id: 'call_1' as ToolCallId,
              name: 'lookup',
              argumentsJson: '{"key":"alpha"}',
            },
          ]),
          {
            role: 'tool-result',
            toolCallId: 'call_1' as ToolCallId,
            toolName: 'lookup',
            content: 'first',
            isError: false,
          },
          {
            role: 'tool-result',
            toolCallId: 'call_2' as ToolCallId,
            toolName: 'lookup',
            content: 'boom',
            isError: true,
          },
        ],
        segment3VolatileTail: NONE,
        sharedPrefixKey: NONE,
      },
    })
    const systemBlocks = list(body.system).map(record)
    expect(systemBlocks).toHaveLength(2)
    expect(systemBlocks[1]!.cache_control).toEqual({ type: 'ephemeral' })

    const messages = list(body.messages).map(record)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    const assistantContent = list(messages[1]!.content).map(record)
    expect(assistantContent[0]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { key: 'alpha' },
    })
    const toolResults = list(messages[2]!.content).map(record)
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_1', content: 'first' })
    expect(toolResults[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_2',
      content: 'boom',
      is_error: true,
      cache_control: { type: 'ephemeral' },
    })
    // Breakpoint #2 lands on the final block of the warm history.
    expect(toolResults[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('replays same-origin thinking signatures and redacted blocks, partitioning tool_use last', () => {
    const body = built({
      cacheRetention: 'none',
      request: {
        segment1Static: [],
        segment2WarmHistory: [
          textMessage('question'),
          assistantMessage(
            [
              { type: 'text', text: 'visible' },
              { type: 'reasoning', text: 'plan' },
              {
                type: 'tool-call',
                id: 'call_1' as ToolCallId,
                name: 'lookup',
                argumentsJson: '{"key":"alpha"}',
              },
              { type: 'reasoning', text: '' },
            ],
            {
              replayState: some(
                envelope([
                  { kind: 'text' },
                  { kind: 'thinking', signature: 'sig-1' },
                  { kind: 'tool_use', id: 'call_1', name: 'lookup' },
                  { kind: 'redacted_thinking', data: 'opaque-payload' },
                ]),
              ),
            },
          ),
        ],
        segment3VolatileTail: NONE,
        sharedPrefixKey: NONE,
      },
    })
    const assistantContent = contentAt(body, 1)
    expect(assistantContent.map((block) => block.type)).toEqual([
      'text',
      'thinking',
      'redacted_thinking',
      'tool_use',
    ])
    expect(assistantContent[1]).toEqual({ type: 'thinking', thinking: 'plan', signature: 'sig-1' })
    expect(assistantContent[2]).toEqual({ type: 'redacted_thinking', data: 'opaque-payload' })
    expect(assistantContent[3]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { key: 'alpha' },
    })
  })

  test('ignores foreign or malformed replay state instead of emitting unusable signatures', () => {
    const foreign = built({
      request: {
        segment1Static: [],
        segment2WarmHistory: [
          assistantMessage(
            [
              { type: 'reasoning', text: 'plan' },
              {
                type: 'tool-call',
                id: 'call_1' as ToolCallId,
                name: 'lookup',
                argumentsJson: '{}',
              },
            ],
            {
              modelId: 'claude-other' as ModelId,
              replayState: some(
                envelope([
                  { kind: 'thinking', signature: 'foreign-signature' },
                  { kind: 'tool_use', id: 'call_1', name: 'lookup' },
                ]),
              ),
            },
          ),
        ],
        segment3VolatileTail: NONE,
        sharedPrefixKey: NONE,
      },
    })
    expect(contentAt(foreign, 0).map((block) => block.type)).toEqual(['tool_use'])

    const damaged = built({
      request: {
        segment1Static: [],
        segment2WarmHistory: [
          assistantMessage([{ type: 'reasoning', text: 'plan' }], {
            replayState: some(
              envelope([{ kind: 'thinking', signature: 'sig' }], ANTHROPIC_REPLAY_ADAPTER_KIND, 99),
            ),
          }),
        ],
        segment3VolatileTail: NONE,
        sharedPrefixKey: NONE,
      },
    })
    expect(list(damaged.messages)).toHaveLength(0)

    const replaying = (
      content: Extract<NeutralMessage, { role: 'assistant' }>['content'],
      replay: ReplayEnvelope,
      overrides: { routeId?: RouteId; modelId?: ModelId } = {},
    ): Json =>
      built({
        cacheRetention: 'none',
        request: {
          segment1Static: [],
          segment2WarmHistory: [
            assistantMessage(content, { ...overrides, replayState: some(replay) }),
          ],
          segment3VolatileTail: NONE,
          sharedPrefixKey: NONE,
        },
      })
    const visible = { type: 'text' as const, text: 'visible' }
    const reasoning = { type: 'reasoning' as const, text: 'plan' }
    const call = {
      type: 'tool-call' as const,
      id: 'call_1' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":"alpha"}',
    }
    const neutralCall = {
      type: 'tool_use',
      id: 'call_1',
      name: 'lookup',
      input: { key: 'alpha' },
    }

    // Valid JSON, wrong adapter kind: the same-origin gate rejects the envelope.
    const foreignKind = replaying(
      [visible, reasoning, call],
      envelope(
        [
          { kind: 'text' },
          { kind: 'thinking', signature: 'sig-wrong-kind' },
          { kind: 'tool_use', id: 'call_1', name: 'lookup' },
        ],
        'omp:pi-ai',
      ),
    )
    expect(contentAt(foreignKind, 0).map((block) => block.type)).toEqual(['text', 'tool_use'])
    expect(JSON.stringify(foreignKind)).not.toContain('sig-wrong-kind')
    expect(contentAt(foreignKind, 0)[1]).toEqual(neutralCall)

    // Exact-length metadata swapped across block kinds must invalidate the envelope.
    const swapped = replaying(
      [reasoning, call],
      envelope([
        { kind: 'tool_use', id: 'call_1', name: 'lookup' },
        { kind: 'thinking', signature: 'sig-swapped' },
      ]),
    )
    expect(contentAt(swapped, 0).map((block) => block.type)).toEqual(['tool_use'])
    expect(JSON.stringify(swapped)).not.toContain('sig-swapped')

    // A mistyped private field discards the envelope rather than reaching the wire.
    const mistyped = replaying(
      [reasoning, call],
      envelope([
        { kind: 'thinking', signature: 42 },
        { kind: 'tool_use', id: 'call_1', name: 'lookup' },
      ]),
    )
    expect(contentAt(mistyped, 0).map((block) => block.type)).toEqual(['tool_use'])
    expect(JSON.stringify(mistyped)).not.toContain('signature')

    // Metadata recorded for a different call: id and name are both identity.
    for (const metadata of [
      { kind: 'tool_use', id: 'call_9', name: 'lookup' },
      { kind: 'tool_use', id: 'call_1', name: 'other' },
    ]) {
      const wrongIdentity = replaying([call], envelope([metadata]))
      expect(contentAt(wrongIdentity, 0)).toEqual([neutralCall])
    }

    const foreignRoute = replaying(
      [reasoning, call],
      envelope([
        { kind: 'thinking', signature: 'sig-foreign-route' },
        { kind: 'tool_use', id: 'call_1', name: 'lookup' },
      ]),
      { routeId: 'route-other' as RouteId },
    )
    expect(contentAt(foreignRoute, 0).map((block) => block.type)).toEqual(['tool_use'])
    expect(JSON.stringify(foreignRoute)).not.toContain('sig-foreign-route')
  })

  test('carries static strict tools and the prepared tool choice', () => {
    const tools: readonly NormalizedWireToolSchema[] = [
      {
        name: 'lookup',
        description: 'Look up a key.',
        strict: true,
        jsonSchema: { type: 'object' },
      },
      { name: 'other', description: 'Other.', strict: false, jsonSchema: { type: 'object' } },
    ]
    const named = built({ tools, toolChoice: { kind: 'named', toolName: 'lookup' } })
    const wireTools = list(named.tools).map(record)
    expect(wireTools[0]).toEqual({
      name: 'lookup',
      description: 'Look up a key.',
      input_schema: { type: 'object' },
      strict: true,
    })
    expect(wireTools[1]!.strict).toBeUndefined()
    expect(named.tool_choice).toEqual({ type: 'tool', name: 'lookup' })

    expect(built({ tools, toolChoice: { kind: 'required' } }).tool_choice).toEqual({
      type: 'any',
    })
    expect(built({ tools, toolChoice: { kind: 'none' } }).tool_choice).toEqual({ type: 'none' })
    expect(built({ tools, toolChoice: { kind: 'auto' } }).tool_choice).toBeUndefined()

    const strictDisabled = built({
      tools,
      capabilities: makeCapabilities({ disableStrictTools: true }),
    })
    expect(list(strictDisabled.tools).map(record)[0]!.strict).toBeUndefined()
  })

  test('budgets thinking with max-token headroom and drops incompatible sampling', () => {
    const high = built({
      effort: 'high',
      temperature: some(0.4),
      maxOutputTokens: some(4096),
    })
    const thinking = record(high.thinking)
    expect(thinking.type).toBe('enabled')
    const budget = thinking.budget_tokens as number
    expect(budget).toBe(3072)
    expect(high.max_tokens).toBe(4096)
    expect(high.max_tokens as number).toBeGreaterThanOrEqual(budget + 1024)
    expect(high.temperature).toBeUndefined()
    expect(high.top_p).toBeUndefined()

    const withoutHeadroom = built({ effort: 'high' })
    const shrunkBudget = record(withoutHeadroom.thinking).budget_tokens as number
    expect(shrunkBudget).toBe(7168)
    expect(withoutHeadroom.max_tokens).toBe(8192)
    expect(withoutHeadroom.max_tokens as number).toBeGreaterThanOrEqual(shrunkBudget + 1024)

    const samplingAllowed = built({
      effort: 'high',
      temperature: some(0.4),
      capabilities: makeCapabilities({ supportsSamplingWhenThinking: true }),
    })
    expect(samplingAllowed.temperature).toBe(0.4)
  })

  test('applies the DeepSeek thinking overlay through body fields', () => {
    const deepseek = makeRoute({
      gateway: 'deepseek',
      baseURL: 'https://api.deepseek.com/anthropic',
    })
    const enabled = anthropicEngine.build(
      makeSnapshot({
        effort: 'high',
        capabilities: makeCapabilities({ supportedEfforts: ['minimal', 'high'] }),
      }),
      deepseek,
    ).body as Json
    expect(enabled.output_config).toEqual({ effort: 'high' })
    expect(enabled.thinking).toBeUndefined()

    const minimal = anthropicEngine.build(makeSnapshot({ effort: 'minimal' }), deepseek)
      .body as Json
    expect(minimal.output_config).toEqual({ effort: 'low' })

    const disabled = anthropicEngine.build(makeSnapshot({ effort: 'off' }), deepseek).body as Json
    expect(disabled.thinking).toEqual({ type: 'disabled' })
    expect(disabled.output_config).toBeUndefined()
  })

  test('targets /v1/messages and lets route headers override the protocol default', () => {
    const wire: WireRequest = anthropicEngine.build(makeSnapshot(), makeRoute())
    expect(wire.path).toBe('/v1/messages')
    expect(wire.headers?.['anthropic-version']).toBe('2023-06-01')

    const custom = anthropicEngine.build(
      makeSnapshot(),
      makeRoute({ headers: { 'anthropic-version': '2024-10-22', 'x-trace': 'abc' } }),
    )
    expect(custom.headers?.['anthropic-version']).toBe('2024-10-22')
    expect(custom.headers?.['x-trace']).toBe('abc')
  })
})

/* -------------------------------------------------------------------------- */
/*                                Stream decode                               */
/* -------------------------------------------------------------------------- */

describe('anthropic messages stream decode', () => {
  test('decodes text, usage and a stop finish with observedAttempts = 1', async () => {
    expect(ANTHROPIC_REPLAY_ADAPTER_KIND).toBe('direct:anthropic-messages')
    const chunks = await collect(textFrames())
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'first-byte',
      'block-start',
      'text-delta',
      'block-end',
      'usage',
      'finish',
    ])
    const stop = chunks.at(-1)
    if (stop?.type !== 'finish') throw new Error('missing finish')
    expect(stop.reason).toEqual({ kind: 'stop' })
    expect(stop.observedAttempts).toBe(1)
    if (!isSome(stop.replayState)) throw new Error('missing replay state')
    expect(stop.replayState.value.adapterKind).toBe(ANTHROPIC_REPLAY_ADAPTER_KIND)
    expect(stop.replayState.value.version).toBe(1)
    expect(stop.replayState.value.blocks).toEqual([{ kind: 'text' }])

    const usageChunk = chunks.find((chunk) => chunk.type === 'usage')
    if (usageChunk?.type !== 'usage') throw new Error('missing usage')
    expect(usageChunk.usage).toEqual({
      inputUncachedTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      reasoningTokens: NONE,
      authoritativeCostUsd: NONE,
    })
  })

  test('decodes tool calls and reports tool-calls', async () => {
    const chunks = await collect([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"key":"alpha"}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 2 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    if (end?.type !== 'block-end') throw new Error('missing block-end')
    expect(end.block).toEqual({
      type: 'tool-call',
      id: 'call_1' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":"alpha"}',
    })
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('missing finish')
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
    if (!isSome(finish.replayState)) throw new Error('missing replay state')
    expect(finish.replayState.value.blocks).toEqual([
      { kind: 'tool_use', id: 'call_1', name: 'lookup' },
    ])
  })

  test('deduplicates cache usage into disjoint buckets', async () => {
    const chunks = await collect([
      frame('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_1',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage?.type !== 'usage') throw new Error('missing usage')
    expect(usage.usage).toEqual({
      inputUncachedTokens: 100,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 5,
      reasoningTokens: NONE,
      authoritativeCostUsd: NONE,
    })
  })

  test('records signature and redacted thinking in the replay envelope', async () => {
    const signature = await collect([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'plan' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-1' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    const end = signature.find((chunk) => chunk.type === 'block-end')
    if (end?.type !== 'block-end') throw new Error('missing block-end')
    expect(end.block).toEqual({ type: 'reasoning', text: 'plan' })
    const finish = signature.at(-1)
    if (finish?.type !== 'finish' || !isSome(finish.replayState))
      throw new Error('missing replay state')
    expect(finish.replayState.value.blocks).toEqual([{ kind: 'thinking', signature: 'sig-1' }])

    const redacted = await collect([
      frame('message_start', { type: 'message_start', message: { id: 'msg_2' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'opaque-payload' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    const redactedEnd = redacted.find((chunk) => chunk.type === 'block-end')
    if (redactedEnd?.type !== 'block-end') throw new Error('missing block-end')
    expect(redactedEnd.block).toEqual({ type: 'reasoning', text: '' })
    const redactedFinish = redacted.at(-1)
    if (redactedFinish?.type !== 'finish' || !isSome(redactedFinish.replayState)) {
      throw new Error('missing replay state')
    }
    expect(redactedFinish.replayState.value.blocks).toEqual([
      { kind: 'redacted_thinking', data: 'opaque-payload' },
    ])
  })

  test('supports interleaved indexed blocks and keeps replay alignment', async () => {
    const chunks = await collect([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call_2', name: 'lookup', input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'a' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    expect(chunks.filter((chunk) => chunk.type === 'first-byte')).toHaveLength(1)
    const ends = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end',
    )
    expect(ends).toHaveLength(2)
    if (ends[0]?.type !== 'block-end' || ends[1]?.type !== 'block-end')
      throw new Error('missing block-end')
    expect(ends[0]!.index).toBe(0)
    expect(ends[0]!.block).toEqual({ type: 'text', text: 'a' })
    expect(ends[1]!.index).toBe(1)
    expect(ends[1]!.block).toEqual({
      type: 'tool-call',
      id: 'call_2' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"x":1}',
    })
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || !isSome(finish.replayState))
      throw new Error('missing replay state')
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
    expect(finish.replayState.value.blocks).toEqual([
      { kind: 'text' },
      { kind: 'tool_use', id: 'call_2', name: 'lookup' },
    ])
  })

  test('maps max_tokens stop reasons to max-tokens', async () => {
    const chunks = await collect(textFrames())
    const last = chunks.at(-1)
    if (last?.type !== 'finish') throw new Error('missing finish')
    expect(last.reason).toEqual({ kind: 'stop' })

    const truncated = await collect([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    const finish = truncated.at(-1)
    if (finish?.type !== 'finish') throw new Error('missing finish')
    expect(finish.reason).toEqual({ kind: 'max-tokens' })
  })

  test('rejects empty completions without emitting first-byte or a normal finish', async () => {
    const failure = await collectFailure(textFrames({ empty: true }))
    expect(failure.error.code).toBe('EMPTY_RESPONSE')
    expect(failure.chunks).toHaveLength(0)
  })

  test('emits no first-byte for metadata-only frames', async () => {
    const failure = await collectFailure([
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_1', usage: { input_tokens: 3 } },
      }),
      frame('ping', { type: 'ping' }),
    ])
    expect(failure.chunks).toHaveLength(0)
    expect(failure.error.code).toBe('TRANSPORT')
  })

  test('reports TRANSPORT when the stream ends before message_stop', async () => {
    const failure = await collectFailure(textFrames({ truncatedStop: true }))
    expect(failure.error.code).toBe('TRANSPORT')
    expect(
      failure.chunks.some(
        (chunk) => chunk.type === 'tool-call-delta' || chunk.type === 'text-delta',
      ),
    ).toBe(true)
  })

  test('reports MALFORMED_RESPONSE for invalid JSON and rejects quietly before first-byte', async () => {
    const failure = await collectFailure([frame('message_start', '{not json')])
    expect(failure.error.code).toBe('MALFORMED_RESPONSE')
    expect(failure.chunks).toHaveLength(0)
  })

  test('maps upstream error events without emitting first-byte', async () => {
    const failure = await collectFailure([
      frame('error', {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid credentials' },
      }),
    ])
    expect(failure.error.code).toBe('AUTH')
    expect(failure.chunks).toHaveLength(0)
  })

  test('rejects out-of-order indexes, unclosed blocks and half-written tool JSON', async () => {
    const outOfOrder = await collectFailure([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
    ])
    expect(outOfOrder.error.code).toBe('MALFORMED_RESPONSE')

    const unclosed = await collectFailure([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'x' },
      }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    expect(unclosed.error.code).toBe('MALFORMED_RESPONSE')

    const badToolJson = await collectFailure([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"key":' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    expect(badToolJson.error.code).toBe('MALFORMED_RESPONSE')
    expect(badToolJson.chunks.some((chunk) => chunk.type === 'tool-call-delta')).toBe(true)
    const badToolEnd = badToolJson.chunks.find((chunk) => chunk.type === 'block-end')
    if (badToolEnd?.type !== 'block-end') throw new Error('missing block-end')
    expect(badToolEnd.block).toEqual({
      type: 'tool-call',
      id: 'call_1' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":',
    })
  })

  test('keeps raw partial tool arguments when max-tokens truncates the call', async () => {
    const chunks = await collect([
      frame('message_start', { type: 'message_start', message: { id: 'msg_1' } }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"key":' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      frame('message_stop', { type: 'message_stop' }),
    ])
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    if (end?.type !== 'block-end') throw new Error('missing block-end')
    expect(end.block).toEqual({
      type: 'tool-call',
      id: 'call_1' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":',
    })
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('missing finish')
    expect(finish.reason).toEqual({ kind: 'max-tokens' })
  })

  test('throws plain LlmFailure values rather than Error instances', async () => {
    const failure = await collectFailure([frame('message_start', '{broken')])
    expect(failure.error).not.toBeInstanceOf(Error)
    expect(typeof failure.error.message).toBe('string')
  })
})
