import { describe, expect, test } from 'bun:test'
import type { Option } from '@sekaisen/core'
import { isSome, NONE, some } from '@sekaisen/core'
import type {
  CacheAlignedChatRequest,
  LlmFailure,
  ModelCapabilities,
  ModelId,
  NeutralAssistantMessage,
  NeutralContentBlock,
  NeutralMessage,
  NormalizedWireToolSchema,
  PreparedChatCallSnapshot,
  ReasoningEffort,
  ReplayEnvelope,
  RouteId,
  StreamChunk,
  ToolCallId,
} from '@sekaisen/plugin-llm'
import type { DirectRouteConfig } from '../packages/plugin-llm/src/direct/contract.ts'
import {
  GEMINI_REPLAY_ADAPTER_KIND,
  geminiEngine,
} from '../packages/plugin-llm/src/direct/gemini.ts'
import {
  RESPONSES_REPLAY_ADAPTER_KIND,
  responsesEngine,
} from '../packages/plugin-llm/src/direct/responses.ts'

const RESPONSES_ROUTE: DirectRouteConfig = {
  protocol: 'openai-responses',
  baseURL: 'https://fixture.invalid',
  authMode: 'none',
}
const GEMINI_ROUTE: DirectRouteConfig = {
  protocol: 'google-gemini',
  baseURL: 'https://generativelanguage.googleapis.com',
  authMode: 'none',
}

const LOOKUP_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: { key: { type: 'string' } },
  required: ['key'],
  additionalProperties: false,
}
const LOOKUP_TOOL: NormalizedWireToolSchema = {
  name: 'lookup',
  description: 'Find a record',
  strict: true,
  jsonSchema: LOOKUP_SCHEMA,
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: ['minimal', 'low', 'medium', 'high'],
  canDisableReasoning: true,
  supportsSamplingWhenThinking: true,
  supportsSamplingParams: true,
  supportsPenaltiesAndStop: true,
  forcedToolChoiceSupport: 'named',
  disableReasoningOnForcedToolChoice: false,
  systemPromptUpdate: 'leading-only',
  toolSchemaDialect: 'openai-responses',
}

function userMessage(text: string): NeutralMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function chatRequest(
  history: readonly NeutralMessage[],
  overrides: {
    readonly system?: readonly { readonly name: string; readonly text: string }[]
    readonly tail?: Option<string>
  } = {},
): CacheAlignedChatRequest {
  return {
    segment1Static: overrides.system ?? [{ name: 'rules', text: 'Be precise.' }],
    segment2WarmHistory: history,
    segment3VolatileTail: overrides.tail ?? NONE,
    sharedPrefixKey: NONE,
  }
}

interface SnapshotOptions {
  readonly routeId?: string
  readonly modelId?: string
  readonly request?: CacheAlignedChatRequest
  readonly tools?: readonly NormalizedWireToolSchema[]
  readonly effort?: ReasoningEffort
  readonly toolChoice?: PreparedChatCallSnapshot['effectiveToolChoice']
  readonly capabilities?: Partial<ModelCapabilities>
  readonly sampling?: Partial<PreparedChatCallSnapshot['sampling']>
}

function snapshot(options: SnapshotOptions = {}): PreparedChatCallSnapshot {
  return {
    routeId: (options.routeId ?? 'fixture') as RouteId,
    modelId: (options.modelId ?? 'fixture-model') as ModelId,
    retryOwnership: 'caller-owned-single-attempt',
    capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    request: options.request ?? chatRequest([userMessage('hello')]),
    tools: options.tools ?? [],
    effectiveEffort: options.effort ?? 'off',
    effectiveToolChoice: options.toolChoice ?? { kind: 'auto' },
    downgradedToolChoice: false,
    sampling: {
      temperature: NONE,
      topP: NONE,
      frequencyPenalty: NONE,
      presencePenalty: NONE,
      stopSequences: [],
      maxOutputTokens: NONE,
      cacheRetention: 'short',
      sessionAffinityKey: NONE,
      ...options.sampling,
    },
  }
}

function sseEvent(name: string, payload: unknown): { event: string; data: string } {
  return { event: name, data: JSON.stringify(payload) ?? 'null' }
}

function sseRaw(name: string, data: string): { event: string; data: string } {
  return { event: name, data }
}

async function* eventsOf(
  list: readonly { readonly event: string; readonly data: string }[],
): AsyncIterable<{ event: string; data: string }> {
  for (const event of list) yield event
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function decodeFailure(stream: AsyncIterable<StreamChunk>): Promise<LlmFailure> {
  try {
    await drain(stream)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) return error as LlmFailure
    throw error
  }
  throw new Error('expected the decoder to fail')
}

function someValue<T>(option: Option<T>): T {
  if (!isSome(option)) throw new Error('expected a present Option value')
  return option.value
}

function lastFinish(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const last = chunks.at(-1)
  if (last === undefined || last.type !== 'finish')
    throw new Error('stream did not end with finish')
  return last
}

function blockEnds(chunks: readonly StreamChunk[]): Extract<StreamChunk, { type: 'block-end' }>[] {
  return chunks.filter(
    (chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end',
  )
}

function assistantMessage(
  content: readonly NeutralContentBlock[],
  options: {
    readonly modelId?: string
    readonly routeId?: string
    readonly replayState?: Option<ReplayEnvelope>
  } = {},
): NeutralAssistantMessage {
  return {
    role: 'assistant',
    content,
    origin: {
      routeId: (options.routeId ?? 'fixture') as RouteId,
      modelId: (options.modelId ?? 'fixture-model') as ModelId,
      replayState: options.replayState ?? NONE,
    },
  }
}

/* -------------------------------------------------------------------------- */
/*                                Responses                                   */
/* -------------------------------------------------------------------------- */

describe('openai-responses request assembly', () => {
  test('sends a stateless developer-prefixed request with prompt cache affinity', () => {
    const request = snapshot({
      tools: [LOOKUP_TOOL],
      effort: 'high',
      toolChoice: { kind: 'named', toolName: 'lookup' },
      request: chatRequest([userMessage('hello')], { tail: some('volatile turn context') }),
      sampling: {
        temperature: some(0.2),
        topP: some(0.9),
        maxOutputTokens: some(256),
        sessionAffinityKey: some('affinity-1'),
      },
    })
    const wire = responsesEngine.build(request, RESPONSES_ROUTE)
    expect(wire.path).toBe('/v1/responses')
    const body = wire.body
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.model).toBe('fixture-model')
    const input = body.input as Record<string, unknown>[]
    expect(input[0]).toMatchObject({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Be precise.' }],
    })
    expect(body.prompt_cache_key).toBe('affinity-1')
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.include).toEqual(['reasoning.encrypted_content'])
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Find a record',
        parameters: LOOKUP_SCHEMA,
        strict: true,
      },
    ])
    expect(body.tool_choice).toEqual({ type: 'function', name: 'lookup' })
    expect(body.temperature).toBe(0.2)
    expect(body.top_p).toBe(0.9)
    expect(body.max_output_tokens).toBe(256)
    const last = input.at(-1)
    expect(last?.role).toBe('user')
    expect(JSON.stringify(last)).toContain('volatile turn context')
    expect(JSON.stringify(last)).toContain('<turn-context>')
    expect(JSON.stringify(input[0])).not.toContain('volatile turn context')
    expect(body.prompt_cache_key).not.toContain('volatile')
  })

  test('omits reasoning controls when effort is off', () => {
    const snapshotOff = snapshot({ effort: 'off', request: chatRequest([userMessage('hello')]) })
    const body = responsesEngine.build(snapshotOff, RESPONSES_ROUTE).body
    expect(body.reasoning).toBeUndefined()
    expect(body.include).toBeUndefined()
    expect(body.prompt_cache_key).toBeUndefined()
  })

  test('projects the volatile tail without shifting the stable prefix', () => {
    const base = snapshot({
      request: chatRequest([userMessage('hello')], { tail: some('first tail') }),
    })
    const other = snapshot({
      request: chatRequest([userMessage('hello')], { tail: some('second tail') }),
    })
    const first = responsesEngine.build(base, RESPONSES_ROUTE).body
    const second = responsesEngine.build(other, RESPONSES_ROUTE).body
    const firstInput = first.input as Record<string, unknown>[]
    const secondInput = second.input as Record<string, unknown>[]
    expect(JSON.stringify(firstInput[0])).toBe(JSON.stringify(secondInput[0]))
    expect(JSON.stringify(firstInput[1])).not.toBe(JSON.stringify(secondInput[1]))
    expect(JSON.stringify(firstInput[0])).not.toContain('tail')
  })

  test('serializes assistant reasoning, tool calls and tool results for replay', () => {
    const assistant = assistantMessage([
      { type: 'reasoning', text: 'Weighing options' },
      {
        type: 'tool-call',
        id: 'call_1' as ToolCallId,
        name: 'lookup',
        argumentsJson: '{"key":"alpha"}',
      },
    ])
    const toolResult: NeutralMessage = {
      role: 'tool-result',
      toolCallId: 'call_1' as ToolCallId,
      toolName: 'lookup',
      content: '{"found":true}',
      isError: false,
    }
    const wire = responsesEngine.build(
      snapshot({ request: chatRequest([userMessage('find alpha'), assistant, toolResult]) }),
      RESPONSES_ROUTE,
    )
    const input = wire.body.input as Record<string, unknown>[]
    expect(input.map((item) => item.type)).toEqual([
      'message',
      'message',
      'reasoning',
      'function_call',
      'function_call_output',
    ])
    expect(input[2]).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Weighing options' }],
    })
    expect(input[3]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"key":"alpha"}',
    })
    expect(input[4]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"found":true}',
    })
  })
})

describe('openai-responses stream decoding', () => {
  test('emits text, cached usage and a replay envelope', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { type: 'response.created', response: { id: 'resp_1' } }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
          }),
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            delta: 'Hel',
          }),
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            delta: 'lo',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_1',
              status: 'completed',
              usage: {
                input_tokens: 20,
                input_tokens_details: { cached_tokens: 8 },
                output_tokens: 4,
                output_tokens_details: { reasoning_tokens: 2 },
              },
            },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(chunks.filter((chunk) => chunk.type === 'first-byte')).toHaveLength(1)
    const ends = blockEnds(chunks)
    expect(ends).toHaveLength(1)
    expect(ends[0]?.block).toEqual({ type: 'text', text: 'Hello' })
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage?.type !== 'usage') throw new Error('usage frame missing')
    expect(usage.usage.inputUncachedTokens).toBe(12)
    expect(usage.usage.cacheReadTokens).toBe(8)
    expect(usage.usage.cacheWriteTokens).toBe(0)
    expect(usage.usage.outputTokens).toBe(4)
    expect(someValue(usage.usage.reasoningTokens)).toBe(2)
    const finish = lastFinish(chunks)
    expect(finish.reason).toEqual({ kind: 'stop' })
    expect(finish.observedAttempts).toBe(1)
    const replay = someValue(finish.replayState)
    expect(replay.adapterKind).toBe(RESPONSES_REPLAY_ADAPTER_KIND)
    expect(replay.version).toBe(1)
    expect(replay.blocks).toHaveLength(1)
    expect((replay.blocks?.[0] as Record<string, unknown> | undefined)?.itemId).toBe('msg_1')
  })

  test('tracks parallel tool calls with compound identifiers', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', {
            type: 'response.created',
            response: { id: 'resp_tools' },
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'lookup',
              arguments: '',
            },
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'fc_2',
              call_id: 'call_2',
              name: 'lookup',
              arguments: '',
            },
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: '{"key":',
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_2',
            output_index: 1,
            delta: '{"key":"beta"}',
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 0,
            delta: '"alpha"}',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'lookup',
              arguments: '{"key":"alpha"}',
            },
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'fc_2',
              call_id: 'call_2',
              name: 'lookup',
              arguments: '{"key":"beta"}',
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_tools',
              status: 'completed',
              usage: { input_tokens: 5, output_tokens: 6 },
            },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    const toolBlocks = blockEnds(chunks)
      .map((chunk) => chunk.block)
      .filter((block) => block.type === 'tool-call')
    expect(toolBlocks).toHaveLength(2)
    expect(toolBlocks[0]).toEqual({
      type: 'tool-call',
      id: 'call_1' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":"alpha"}',
    })
    expect(toolBlocks[1]).toEqual({
      type: 'tool-call',
      id: 'call_2' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":"beta"}',
    })
    const finish = lastFinish(chunks)
    expect(finish.reason).toEqual({ kind: 'tool-calls' })
    const replay = someValue(finish.replayState)
    const metadata = (replay.blocks ?? []) as Record<string, unknown>[]
    expect(metadata.map((entry) => entry.itemId)).toEqual(['fc_1', 'fc_2'])
    expect(metadata.map((entry) => entry.callId)).toEqual(['call_1', 'call_2'])
  })

  test('replays encrypted reasoning only for the same origin', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', {
            type: 'response.created',
            response: { id: 'resp_think' },
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_1' },
          }),
          sseEvent('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            delta: 'Plan the lookup.',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: 'enc-token',
              summary: [{ type: 'summary_text', text: 'Plan the lookup.' }],
            },
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'message', id: 'msg_2', role: 'assistant', content: [] },
          }),
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_2',
            output_index: 1,
            delta: 'Done.',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'message',
              id: 'msg_2',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_think',
              status: 'completed',
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    const finish = lastFinish(chunks)
    const replay = someValue(finish.replayState)
    const blocks = (replay.blocks ?? []) as Record<string, unknown>[]
    expect(blocks[0]?.encryptedContent).toBe('enc-token')
    const content = blockEnds(chunks).map((chunk) => chunk.block)
    const followup = assistantMessage(content, { replayState: some(replay) })
    const sameRequest = snapshot({ request: chatRequest([userMessage('lookup'), followup]) })
    const sameInput = responsesEngine.build(sameRequest, RESPONSES_ROUTE).body.input as Record<
      string,
      unknown
    >[]
    const reasoningItem = sameInput.find((item) => item.type === 'reasoning')
    expect(reasoningItem).toMatchObject({ id: 'rs_1', encrypted_content: 'enc-token' })
    const foreignRequest = snapshot({
      modelId: 'other-model',
      request: chatRequest([userMessage('lookup'), followup]),
    })
    const foreignInput = responsesEngine.build(foreignRequest, RESPONSES_ROUTE).body
      .input as Record<string, unknown>[]
    expect(JSON.stringify(foreignInput)).not.toContain('enc-token')
  })

  test('discards damaged same-origin replay metadata before serialization', () => {
    const content: NeutralContentBlock[] = [
      { type: 'text', text: 'Answer' },
      { type: 'reasoning', text: 'Plan' },
      {
        type: 'tool-call',
        id: 'call_1' as ToolCallId,
        name: 'lookup',
        argumentsJson: '{"key":"alpha"}',
      },
    ]
    const envelopeFor = (
      blocks: readonly unknown[],
      options: { readonly adapterKind?: string; readonly version?: number } = {},
    ): ReplayEnvelope => ({
      adapterKind: options.adapterKind ?? RESPONSES_REPLAY_ADAPTER_KIND,
      version: options.version ?? 1,
      response: { id: 'resp_damaged' },
      blocks,
    })
    const inputFor = (
      replayState: ReplayEnvelope,
      origin: { readonly routeId?: string; readonly modelId?: string } = {},
    ): Record<string, unknown>[] => {
      const message = assistantMessage(content, { ...origin, replayState: some(replayState) })
      return responsesEngine.build(
        snapshot({ request: chatRequest([userMessage('lookup'), message]) }),
        RESPONSES_ROUTE,
      ).body.input as Record<string, unknown>[]
    }
    const signed = envelopeFor([
      { itemId: 'msg_1' },
      { itemId: 'rs_1', encryptedContent: 'enc-damaged' },
      { itemId: 'fc_1', callId: 'call_1' },
    ])
    const expectNeutral = (
      input: readonly Record<string, unknown>[],
      secrets: readonly string[] = ['msg_1', 'rs_1', 'fc_1', 'enc-damaged'],
    ): void => {
      const serialized = JSON.stringify(input)
      for (const secret of secrets) expect(serialized).not.toContain(secret)
      expect(input.find((item) => item.type === 'message' && item.role === 'assistant')).toEqual({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Answer' }],
      })
      expect(input.find((item) => item.type === 'reasoning')).toEqual({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Plan' }],
      })
      expect(input.find((item) => item.type === 'function_call')).toEqual({
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"key":"alpha"}',
      })
    }

    // Control: matching metadata is exactly what the damaged cases must lose.
    const replayed = inputFor(signed)
    expect(replayed.find((item) => item.type === 'reasoning')).toMatchObject({
      id: 'rs_1',
      encrypted_content: 'enc-damaged',
    })
    expect(replayed.find((item) => item.type === 'function_call')).toMatchObject({ id: 'fc_1' })

    for (const damaged of [
      envelopeFor(signed.blocks ?? [], { adapterKind: 'omp:pi-ai' }),
      envelopeFor(signed.blocks ?? [], { version: 99 }),
    ]) {
      expectNeutral(inputFor(damaged))
    }

    // Wrong field types are ignored per field; unrelated private fields cannot leak.
    expectNeutral(
      inputFor(
        envelopeFor([
          { itemId: 42, encryptedContent: 'enc-on-text' },
          { itemId: 7, encryptedContent: 42 },
          { itemId: true, callId: 'call_1' },
        ]),
      ),
      ['enc-on-text'],
    )
    expectNeutral(
      inputFor(
        envelopeFor([
          { textSignature: 'sig-foreign-field' },
          { thinkingSignature: 'sig-foreign-field' },
          { thoughtSignature: 'sig-foreign-field' },
        ]),
      ),
      ['sig-foreign-field'],
    )

    // Function-call metadata for another call: item id is dropped with the record.
    expectNeutral(inputFor(envelopeFor([{}, {}, { itemId: 'fc_9', callId: 'call_other' }])), [
      'fc_9',
    ])

    expectNeutral(inputFor(signed, { routeId: 'other-route' }))
    expectNeutral(inputFor(signed, { modelId: 'other-model' }))
  })

  test('reconciles authoritative output items without duplicating deltas', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', {
            type: 'response.created',
            response: { id: 'resp_reconcile' },
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_9',
              call_id: 'call_9',
              name: 'lookup',
              arguments: '',
            },
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_9',
            output_index: 0,
            delta: '{"key":',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_9',
              call_id: 'call_9',
              name: 'lookup',
              arguments: '{"key":"alpha"}',
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    const block = blockEnds(chunks)[0]?.block
    expect(block).toEqual({
      type: 'tool-call',
      id: 'call_9' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":"alpha"}',
    })
  })

  test('keeps split surrogate pairs well formed', async () => {
    const high = '\ud83d'
    const low = '\ude00'
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { response: { id: 'resp_unicode' } }),
          sseEvent('response.output_item.added', {
            output_index: 0,
            item: { type: 'message', id: 'msg_u', role: 'assistant', content: [] },
          }),
          sseEvent('response.output_text.delta', {
            item_id: 'msg_u',
            output_index: 0,
            delta: high,
          }),
          sseEvent('response.output_text.delta', { item_id: 'msg_u', output_index: 0, delta: low }),
          sseEvent('response.completed', {
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    const deltas = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta',
    )
    expect(deltas.every((chunk) => chunk.delta.isWellFormed())).toBe(true)
    expect(deltas.map((chunk) => chunk.delta).join('')).toBe('\ud83d\ude00')
    expect(blockEnds(chunks)[0]?.block).toEqual({ type: 'text', text: '\ud83d\ude00' })
  })

  test('maps upstream failures and truncation', async () => {
    const truncated = await decodeFailure(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { response: { id: 'resp_cut' } }),
          sseEvent('response.output_item.added', {
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_cut',
              call_id: 'call_cut',
              name: 'lookup',
              arguments: '',
            },
          }),
          sseEvent('response.function_call_arguments.delta', {
            item_id: 'fc_cut',
            output_index: 0,
            delta: '{"key":',
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(truncated.code).toBe('TRANSPORT')

    const empty = await decodeFailure(
      responsesEngine.decode(eventsOf([]), snapshot({}), RESPONSES_ROUTE),
    )
    expect(empty.code).toBe('EMPTY_RESPONSE')

    const noContent = await decodeFailure(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { response: { id: 'resp_empty' } }),
          sseEvent('response.completed', {
            response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 0 } },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(noContent.code).toBe('EMPTY_RESPONSE')

    const rateLimited = await decodeFailure(
      responsesEngine.decode(
        eventsOf([
          sseEvent('error', { type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(rateLimited.code).toBe('RATE_LIMIT')

    const failed = await decodeFailure(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.failed', {
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { code: 'content_policy_violation', message: 'not allowed' },
            },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(failed.code).toBe('CONTENT_BLOCKED')

    const malformed = await decodeFailure(
      responsesEngine.decode(
        eventsOf([sseRaw('response.created', 'not json')]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(malformed.code).toBe('MALFORMED_RESPONSE')

    const badArgs = await decodeFailure(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { response: { id: 'resp_bad' } }),
          sseEvent('response.output_item.added', {
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_bad',
              call_id: 'call_bad',
              name: 'lookup',
              arguments: '',
            },
          }),
          sseEvent('response.function_call_arguments.delta', {
            item_id: 'fc_bad',
            output_index: 0,
            delta: '{"key":',
          }),
          sseEvent('response.completed', {
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(badArgs.code).toBe('MALFORMED_RESPONSE')
  })
})

/* -------------------------------------------------------------------------- */
/*                                  Gemini                                   */
/* -------------------------------------------------------------------------- */

describe('google-gemini request assembly', () => {
  test('lifts the system prefix and maps the thinking level for Gemini 3', () => {
    const wire = geminiEngine.build(
      snapshot({
        modelId: 'gemini-3-flash',
        effort: 'medium',
        tools: [LOOKUP_TOOL],
        toolChoice: { kind: 'named', toolName: 'lookup' },
        request: chatRequest([userMessage('hello')], { tail: some('volatile turn context') }),
        sampling: { temperature: some(0.3), maxOutputTokens: some(512) },
      }),
      GEMINI_ROUTE,
    )
    expect(wire.path).toBe('/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse')
    const body = wire.body
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be precise.' }] })
    const contents = body.contents as Record<string, unknown>[]
    expect(JSON.stringify(contents)).not.toContain('Be precise.')
    const last = contents.at(-1) as Record<string, unknown>
    expect(last.role).toBe('user')
    expect(JSON.stringify(last)).toContain('volatile turn context')
    expect(JSON.stringify(last)).toContain('<turn-context>')
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'lookup', description: 'Find a record', parameters: LOOKUP_SCHEMA },
        ],
      },
    ])
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] },
    })
    expect(body.generationConfig).toEqual({
      temperature: 0.3,
      maxOutputTokens: 512,
      thinkingConfig: { thinkingLevel: 'medium' },
    })
  })

  test('maps thinking budget for Gemini 2.x and omits thinking for non-reasoning models', () => {
    const budget = geminiEngine.build(
      snapshot({ modelId: 'gemini-2.5-pro', effort: 'high' }),
      GEMINI_ROUTE,
    ).body
    expect((budget.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingBudget: 16384,
    })
    const disabled = geminiEngine.build(
      snapshot({ modelId: 'gemini-2.5-flash', effort: 'off' }),
      GEMINI_ROUTE,
    ).body
    expect((disabled.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingBudget: 0,
    })
    const plain = geminiEngine.build(
      snapshot({
        modelId: 'gemini-2.0-flash',
        effort: 'off',
        capabilities: { supportedEfforts: [] },
      }),
      GEMINI_ROUTE,
    ).body
    const plainConfig = plain.generationConfig as Record<string, unknown> | undefined
    expect(plainConfig?.thinkingConfig).toBeUndefined()
  })

  test('merges consecutive tool results into one user turn', () => {
    const assistant = assistantMessage([
      {
        type: 'tool-call',
        id: 'call_1' as ToolCallId,
        name: 'lookup',
        argumentsJson: '{"key":"alpha"}',
      },
    ])
    const history: NeutralMessage[] = [
      userMessage('find alpha and beta'),
      assistant,
      {
        role: 'tool-result',
        toolCallId: 'call_1' as ToolCallId,
        toolName: 'lookup',
        content: '{"found":"alpha"}',
        isError: false,
      },
      {
        role: 'tool-result',
        toolCallId: 'call_2' as ToolCallId,
        toolName: 'lookup',
        content: '{"found":"beta"}',
        isError: false,
      },
    ]
    const body = geminiEngine.build(snapshot({ request: chatRequest(history) }), GEMINI_ROUTE).body
    const contents = body.contents as Record<string, unknown>[]
    expect(contents.map((content) => content.role)).toEqual(['user', 'model', 'user'])
    const merged = contents[2] as Record<string, unknown>
    const parts = merged.parts as Record<string, unknown>[]
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ functionResponse: { name: 'lookup', response: { found: 'alpha' } } })
    expect(parts[1]).toEqual({ functionResponse: { name: 'lookup', response: { found: 'beta' } } })
  })

  test('replays thought signatures only for the same origin', async () => {
    const chunks = await drain(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Weighing options.', thought: true, thoughtSignature: 'sig-reasoning' },
                    {
                      functionCall: { id: 'call_1', name: 'lookup', args: { key: 'alpha' } },
                      thoughtSignature: 'sig-call',
                    },
                  ],
                },
              },
            ],
          }),
          sseEvent('message', {
            candidates: [{ index: 0, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          }),
        ]),
        snapshot({ routeId: 'gemini', modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    const finish = lastFinish(chunks)
    const replay = someValue(finish.replayState)
    const metadata = (replay.blocks ?? []) as Record<string, unknown>[]
    expect(metadata.map((entry) => entry.thoughtSignature)).toEqual(['sig-reasoning', 'sig-call'])
    const content = blockEnds(chunks).map((chunk) => chunk.block)
    const followup = assistantMessage(content, {
      routeId: 'gemini',
      modelId: 'gemini-3-flash',
      replayState: some(replay),
    })
    const same = geminiEngine.build(
      snapshot({
        routeId: 'gemini',
        modelId: 'gemini-3-flash',
        request: chatRequest([userMessage('lookup'), followup]),
      }),
      GEMINI_ROUTE,
    ).body
    expect(JSON.stringify(same)).toContain('sig-reasoning')
    expect(JSON.stringify(same)).toContain('sig-call')
    const foreign = geminiEngine.build(
      snapshot({
        routeId: 'gemini',
        modelId: 'gemini-2.5-pro',
        request: chatRequest([userMessage('lookup'), followup]),
      }),
      GEMINI_ROUTE,
    ).body
    expect(JSON.stringify(foreign)).not.toContain('sig-reasoning')
    expect(JSON.stringify(foreign)).not.toContain('sig-call')
  })

  test('drops damaged or foreign thought signatures while keeping neutral parts', () => {
    const content: NeutralContentBlock[] = [
      { type: 'text', text: 'Answer' },
      { type: 'reasoning', text: 'Plan' },
      {
        type: 'tool-call',
        id: 'call_1' as ToolCallId,
        name: 'lookup',
        argumentsJson: '{"key":"alpha"}',
      },
    ]
    const envelopeFor = (
      blocks: readonly unknown[],
      options: { readonly adapterKind?: string; readonly version?: number } = {},
    ): ReplayEnvelope => ({
      adapterKind: options.adapterKind ?? GEMINI_REPLAY_ADAPTER_KIND,
      version: options.version ?? 1,
      response: {},
      blocks,
    })
    const partsFor = (
      replayState: ReplayEnvelope,
      origin: { readonly routeId?: string; readonly modelId?: string } = {},
    ): Record<string, unknown>[] => {
      const message = assistantMessage(content, {
        routeId: origin.routeId ?? 'gemini',
        modelId: origin.modelId ?? 'gemini-3-flash',
        replayState: some(replayState),
      })
      const body = geminiEngine.build(
        snapshot({
          routeId: 'gemini',
          modelId: 'gemini-3-flash',
          request: chatRequest([userMessage('lookup'), message]),
        }),
        GEMINI_ROUTE,
      ).body
      const contents = body.contents as Record<string, unknown>[]
      const model = contents.at(-1)
      if (model === undefined) throw new Error('model content missing')
      return model.parts as Record<string, unknown>[]
    }
    const signed = envelopeFor([
      { thoughtSignature: 'sig-text' },
      { thoughtSignature: 'sig-reasoning' },
      { thoughtSignature: 'sig-call' },
    ])
    // Control: matching metadata is exactly what the damaged cases must lose.
    expect(partsFor(signed)).toEqual([
      { text: 'Answer', thoughtSignature: 'sig-text' },
      { text: 'Plan', thought: true, thoughtSignature: 'sig-reasoning' },
      { functionCall: { name: 'lookup', args: { key: 'alpha' } }, thoughtSignature: 'sig-call' },
    ])

    const expectNeutral = (
      parts: readonly Record<string, unknown>[],
      secrets: readonly string[] = [],
    ): void => {
      for (const secret of secrets) expect(JSON.stringify(parts)).not.toContain(secret)
      expect(parts).toEqual([
        { text: 'Answer' },
        { functionCall: { name: 'lookup', args: { key: 'alpha' } } },
      ])
    }
    for (const damaged of [
      envelopeFor(signed.blocks ?? [], { adapterKind: 'omp:pi-ai' }),
      envelopeFor(signed.blocks ?? [], { version: 99 }),
    ]) {
      expectNeutral(partsFor(damaged))
    }
    expectNeutral(
      partsFor(
        envelopeFor([
          { thoughtSignature: 42 },
          { thoughtSignature: 7 },
          { thoughtSignature: false },
        ]),
      ),
    )
    expectNeutral(
      partsFor(
        envelopeFor([
          { textSignature: 'sig-foreign-field' },
          { thinkingSignature: 'sig-foreign-field' },
          { encryptedContent: 'enc-foreign-field' },
        ]),
      ),
      ['sig-foreign-field', 'enc-foreign-field'],
    )
    expectNeutral(partsFor(signed, { routeId: 'other-route' }))
    expectNeutral(partsFor(signed, { modelId: 'gemini-2.5-pro' }))
  })
})

describe('google-gemini stream decoding', () => {
  test('maps thought parts, text parts and candidates usage', async () => {
    const chunks = await drain(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: {
                  role: 'model',
                  parts: [
                    { text: 'think', thought: true, thoughtSignature: 'sig-r' },
                    { text: 'hel', thoughtSignature: 'sig-t' },
                    { text: 'lo' },
                  ],
                },
              },
            ],
          }),
          sseEvent('message', {
            candidates: [{ index: 0, finishReason: 'STOP' }],
            usageMetadata: {
              promptTokenCount: 20,
              cachedContentTokenCount: 8,
              candidatesTokenCount: 4,
              thoughtsTokenCount: 2,
              totalTokenCount: 26,
            },
          }),
        ]),
        snapshot({ routeId: 'gemini', modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    const blocks = blockEnds(chunks).map((chunk) => chunk.block)
    expect(blocks).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'hello' },
    ])
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    if (usage?.type !== 'usage') throw new Error('usage frame missing')
    expect(usage.usage.inputUncachedTokens).toBe(12)
    expect(usage.usage.cacheReadTokens).toBe(8)
    expect(usage.usage.cacheWriteTokens).toBe(0)
    expect(usage.usage.outputTokens).toBe(6)
    expect(someValue(usage.usage.reasoningTokens)).toBe(2)
    const finish = lastFinish(chunks)
    expect(finish.reason).toEqual({ kind: 'stop' })
    expect(finish.observedAttempts).toBe(1)
    const replay = someValue(finish.replayState)
    expect(replay.adapterKind).toBe(GEMINI_REPLAY_ADAPTER_KIND)
    const metadata = (replay.blocks ?? []) as Record<string, unknown>[]
    expect(metadata[0]?.thoughtSignature).toBe('sig-r')
    expect(metadata[1]?.thoughtSignature).toBe('sig-t')
  })

  test('emits complete tool calls with JSON arguments', async () => {
    const chunks = await drain(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: {
                  role: 'model',
                  parts: [
                    { functionCall: { id: 'call_alpha', name: 'lookup', args: { key: 'alpha' } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 },
          }),
        ]),
        snapshot({ routeId: 'gemini', modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    const deltas = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'tool-call-delta' }> =>
        chunk.type === 'tool-call-delta',
    )
    expect(deltas.map((delta) => delta.delta).join('')).toBe('{"key":"alpha"}')
    const block = blockEnds(chunks)[0]?.block
    expect(block).toEqual({
      type: 'tool-call',
      id: 'call_alpha' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":"alpha"}',
    })
    expect(lastFinish(chunks).reason).toEqual({ kind: 'tool-calls' })
  })

  test('keeps split surrogate pairs well formed', async () => {
    const chunks = await drain(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '\ud83d' }] } }],
          }),
          sseEvent('message', {
            candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '\ude00' }] } }],
          }),
          sseEvent('message', { candidates: [{ index: 0, finishReason: 'STOP' }] }),
        ]),
        snapshot({ routeId: 'gemini', modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    const deltas = chunks.filter(
      (chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta',
    )
    expect(deltas.every((chunk) => chunk.delta.isWellFormed())).toBe(true)
    expect(deltas.map((chunk) => chunk.delta).join('')).toBe('\ud83d\ude00')
    expect(blockEnds(chunks)[0]?.block).toEqual({ type: 'text', text: '\ud83d\ude00' })
  })

  test('maps safety and malformed failures', async () => {
    const safety = await decodeFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'partial' }] },
                finishReason: 'SAFETY',
              },
            ],
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(safety.code).toBe('CONTENT_BLOCKED')

    const promptBlocked = await decodeFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'blocked words' },
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(promptBlocked.code).toBe('CONTENT_BLOCKED')

    const malformedCall = await decodeFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: {
                  role: 'model',
                  parts: [{ functionCall: { name: 'lookup', args: 'not json' } }],
                },
              },
            ],
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(malformedCall.code).toBe('MALFORMED_RESPONSE')

    const badJson = await decodeFailure(
      geminiEngine.decode(eventsOf([sseRaw('message', '{oops')]), snapshot({}), GEMINI_ROUTE),
    )
    expect(badJson.code).toBe('MALFORMED_RESPONSE')
  })

  test('rejects truncated, empty and unmapped terminal streams', async () => {
    const truncated = await decodeFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: {
                  role: 'model',
                  parts: [
                    { functionCall: { id: 'call_1', name: 'lookup', args: { key: 'alpha' } } },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(truncated.code).toBe('TRANSPORT')

    const empty = await decodeFailure(geminiEngine.decode(eventsOf([]), snapshot({}), GEMINI_ROUTE))
    expect(empty.code).toBe('EMPTY_RESPONSE')

    const emptyCandidates = await decodeFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [{ index: 0, content: { role: 'model', parts: [] } }],
            usageMetadata: { promptTokenCount: 2, totalTokenCount: 2 },
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(emptyCandidates.code).toBe('EMPTY_RESPONSE')

    const maxTokens = await drain(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: 'cut' }] },
                finishReason: 'MAX_TOKENS',
              },
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(lastFinish(maxTokens).reason).toEqual({ kind: 'max-tokens' })
  })
})

describe('additional terminal states', () => {
  test('responses treats response.done as a terminal completion', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { response: { id: 'resp_done' } }),
          sseEvent('response.output_item.added', {
            output_index: 0,
            item: { type: 'message', id: 'msg_done', role: 'assistant', content: [] },
          }),
          sseEvent('response.output_text.delta', {
            item_id: 'msg_done',
            output_index: 0,
            delta: 'Hi',
          }),
          sseEvent('response.done', {
            response: {
              id: 'resp_done',
              status: 'completed',
              usage: { input_tokens: 2, output_tokens: 1 },
            },
          }),
          sseEvent('response.created', { response: { id: 'must-not-be-read' } }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(lastFinish(chunks).reason).toEqual({ kind: 'stop' })
    expect(blockEnds(chunks)[0]?.block).toEqual({ type: 'text', text: 'Hi' })
  })

  test('gemini maps structured error payloads', async () => {
    const failure = await decodeFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid' },
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(failure.code).toBe('AUTH')
    expect(someValue(failure.status)).toBe(400)
  })
})

describe('SSE naming tolerance', () => {
  test('responses falls back to the payload type when the event name is the SSE default', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          sseEvent('message', { type: 'response.created', response: { id: 'resp_default' } }),
          sseEvent('message', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_default', role: 'assistant', content: [] },
          }),
          sseEvent('message', {
            type: 'response.output_text.delta',
            item_id: 'msg_default',
            output_index: 0,
            delta: 'Ok',
          }),
          sseEvent('message', {
            type: 'response.completed',
            response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(blockEnds(chunks)[0]?.block).toEqual({ type: 'text', text: 'Ok' })
    expect(lastFinish(chunks).reason).toEqual({ kind: 'stop' })
  })
})

describe('first-byte timing', () => {
  async function drainUntilFailure(
    stream: AsyncIterable<StreamChunk>,
  ): Promise<{ chunks: StreamChunk[]; failure: LlmFailure }> {
    const chunks: StreamChunk[] = []
    try {
      for await (const chunk of stream) chunks.push(chunk)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        return { chunks, failure: error as LlmFailure }
      }
      throw error
    }
    throw new Error('expected the decoder to fail')
  }

  test('responses withholds first-byte for pre-output errors and empty responses', async () => {
    const empty = await drainUntilFailure(
      responsesEngine.decode(
        eventsOf([
          sseEvent('response.created', { response: { id: 'resp_empty' } }),
          sseEvent('response.completed', {
            response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 0 } },
          }),
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(empty.failure.code).toBe('EMPTY_RESPONSE')
    expect(empty.chunks.some((chunk) => chunk.type === 'first-byte')).toBe(false)

    const earlyError = await drainUntilFailure(
      responsesEngine.decode(
        eventsOf([sseEvent('error', { code: 'rate_limit_exceeded', message: 'slow down' })]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(earlyError.failure.code).toBe('RATE_LIMIT')
    expect(earlyError.chunks.some((chunk) => chunk.type === 'first-byte')).toBe(false)

    const refusal = await drainUntilFailure(
      responsesEngine.decode(
        eventsOf([sseEvent('response.refusal.delta', { delta: 'no' })]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(refusal.failure.code).toBe('CONTENT_BLOCKED')
    expect(refusal.chunks.some((chunk) => chunk.type === 'first-byte')).toBe(false)
  })

  test('gemini withholds first-byte for pre-output errors and empty responses', async () => {
    const empty = await drainUntilFailure(
      geminiEngine.decode(
        eventsOf([
          sseEvent('message', {
            candidates: [{ index: 0, content: { role: 'model', parts: [] } }],
            usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 },
          }),
        ]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(empty.failure.code).toBe('EMPTY_RESPONSE')
    expect(empty.chunks.some((chunk) => chunk.type === 'first-byte')).toBe(false)

    const safety = await drainUntilFailure(
      geminiEngine.decode(
        eventsOf([sseEvent('message', { promptFeedback: { blockReason: 'SAFETY' } })]),
        snapshot({ modelId: 'gemini-3-flash' }),
        GEMINI_ROUTE,
      ),
    )
    expect(safety.failure.code).toBe('CONTENT_BLOCKED')
    expect(safety.chunks.some((chunk) => chunk.type === 'first-byte')).toBe(false)
  })
})

describe('responses truncated tool arguments', () => {
  const partialToolStart = [
    sseEvent('response.created', { response: { id: 'resp_cut_tool' } }),
    sseEvent('response.output_item.added', {
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_cut',
        call_id: 'call_cut',
        name: 'lookup',
        arguments: '',
      },
    }),
    sseEvent('response.function_call_arguments.delta', {
      item_id: 'fc_cut',
      output_index: 0,
      delta: '{"key":',
    }),
  ]
  const incomplete = sseEvent('response.incomplete', {
    response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  })

  test('keeps raw partial arguments when max tokens truncates the response', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([...partialToolStart, incomplete]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(blockEnds(chunks)[0]?.block).toEqual({
      type: 'tool-call',
      id: 'call_cut' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":',
    })
    expect(lastFinish(chunks).reason).toEqual({ kind: 'max-tokens' })
  })

  test('keeps partial arguments reported by a truncated output_item.done', async () => {
    const chunks = await drain(
      responsesEngine.decode(
        eventsOf([
          ...partialToolStart,
          sseEvent('response.output_item.done', {
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_cut',
              call_id: 'call_cut',
              name: 'lookup',
              arguments: '{"key":',
            },
          }),
          incomplete,
        ]),
        snapshot({}),
        RESPONSES_ROUTE,
      ),
    )
    expect(blockEnds(chunks)[0]?.block).toEqual({
      type: 'tool-call',
      id: 'call_cut' as ToolCallId,
      name: 'lookup',
      argumentsJson: '{"key":',
    })
    expect(lastFinish(chunks).reason).toEqual({ kind: 'max-tokens' })
  })
})
