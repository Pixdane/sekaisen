import { describe, test } from 'bun:test'
import { NONE } from '@sekaisen/core'
import { MockAdapter, type MockTurn, type ModelId, type RouteId } from '@sekaisen/plugin-llm'
import {
  type AdapterConformanceScenario,
  runAdapterConformanceSuite,
} from '@sekaisen/plugin-llm/testing'
import { DirectChatAdapter } from '../packages/plugin-llm/src/direct/adapter.ts'
import type { DirectFetch, DirectProtocol } from '../packages/plugin-llm/src/direct/contract.ts'
import { failure } from '../packages/plugin-llm/src/utils.ts'

function event(data: unknown, name?: string): string {
  return `${name === undefined ? '' : `event: ${name}\n`}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
}
function frames(protocol: DirectProtocol, scenario: AdapterConformanceScenario): string {
  const empty = scenario === 'empty-response'
  const tool = scenario === 'tools' || scenario === 'interrupted-tool'
  const interrupted = scenario === 'interrupted-tool'
  const truncated = scenario === 'truncated'
  if (protocol === 'openai-completions') {
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: interrupted ? '{"key":' : '{"key":"alpha"}' },
            },
          ],
        }
      : { content: 'hello' }
    return (
      (empty ? '' : event({ choices: [{ index: 0, delta, finish_reason: null }] })) +
      (interrupted
        ? ''
        : event({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: tool ? 'tool_calls' : truncated ? 'length' : 'stop',
              },
            ],
          }) + event('[DONE]'))
    )
  }
  if (protocol === 'anthropic-messages') {
    let wire = event(
      {
        type: 'message_start',
        message: { id: 'msg_1', usage: { input_tokens: 8, output_tokens: 0 } },
      },
      'message_start',
    )
    if (!empty) {
      wire += event(
        {
          type: 'content_block_start',
          index: 0,
          content_block: tool
            ? { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }
            : { type: 'text', text: '' },
        },
        'content_block_start',
      )
      wire += event(
        {
          type: 'content_block_delta',
          index: 0,
          delta: tool
            ? {
                type: 'input_json_delta',
                partial_json: interrupted ? '{"key":' : '{"key":"alpha"}',
              }
            : { type: 'text_delta', text: 'hello' },
        },
        'content_block_delta',
      )
      if (interrupted) return wire
      wire += event({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
    }
    return (
      wire +
      event(
        {
          type: 'message_delta',
          delta: { stop_reason: tool ? 'tool_use' : truncated ? 'max_tokens' : 'end_turn' },
          usage: { output_tokens: 4 },
        },
        'message_delta',
      ) +
      event({ type: 'message_stop' }, 'message_stop')
    )
  }
  if (protocol === 'openai-responses') {
    let wire = event({ type: 'response.created', response: { id: 'resp_1' } }, 'response.created')
    if (!empty) {
      const item = tool
        ? { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'lookup', arguments: '' }
        : { type: 'message', id: 'item_1', role: 'assistant', content: [] }
      wire += event(
        { type: 'response.output_item.added', output_index: 0, item },
        'response.output_item.added',
      )
      if (tool)
        wire += event(
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'item_1',
            output_index: 0,
            delta: interrupted ? '{"key":' : '{"key":"alpha"}',
          },
          'response.function_call_arguments.delta',
        )
      else {
        wire += event(
          {
            type: 'response.content_part.added',
            item_id: 'item_1',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          'response.content_part.added',
        )
        wire += event(
          {
            type: 'response.output_text.delta',
            item_id: 'item_1',
            output_index: 0,
            content_index: 0,
            delta: 'hello',
          },
          'response.output_text.delta',
        )
      }
      if (interrupted) return wire
      wire += event(
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: tool
            ? { ...item, arguments: '{"key":"alpha"}' }
            : { ...item, content: [{ type: 'output_text', text: 'hello', annotations: [] }] },
        },
        'response.output_item.done',
      )
    }
    const type = truncated ? 'response.incomplete' : 'response.completed'
    return (
      wire +
      event(
        {
          type,
          response: {
            id: 'resp_1',
            status: truncated ? 'incomplete' : 'completed',
            ...(truncated ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
            usage: { input_tokens: 8, output_tokens: 4 },
          },
        },
        type,
      )
    )
  }
  const parts = tool
    ? [{ functionCall: { id: 'call_1', name: 'lookup', args: { key: 'alpha' } } }]
    : [{ text: 'hello' }]
  return event({
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: empty ? [] : parts },
        ...(interrupted ? {} : { finishReason: truncated ? 'MAX_TOKENS' : 'STOP' }),
      },
    ],
    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
  })
}

for (const protocol of [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-gemini',
] as const) {
  describe(`shared adapter conformance: ${protocol}`, () => {
    test('all success, failure, cancellation, and interruption lifecycles', async () => {
      await runAdapterConformanceSuite((scenario) => {
        let attempts = 0
        const adapter = new DirectChatAdapter({
          routes: {
            fixture: {
              protocol,
              baseURL: 'https://fixture.invalid/v1',
              authMode: 'none',
              firstEventTimeoutMs: 1000,
              interEventTimeoutMs: 1000,
            },
          },
          fetch: (async () => {
            attempts++
            const status =
              scenario === 'invalid-request'
                ? 400
                : scenario === 'rate-limit'
                  ? 429
                  : scenario === 'server-error'
                    ? 503
                    : 200
            return new Response(
              status === 200
                ? frames(protocol, scenario)
                : JSON.stringify({ error: { message: 'fixture failure' } }),
              {
                status,
                headers: {
                  'content-type': status === 200 ? 'text/event-stream' : 'application/json',
                },
              },
            )
          }) as DirectFetch,
        })
        return {
          adapter,
          routeId: 'fixture' as RouteId,
          modelId: 'fixture-model' as ModelId,
          request: {
            segment1Static: [{ name: 'system', text: 'Be precise.' }],
            segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            segment3VolatileTail: NONE,
            sharedPrefixKey: NONE,
          },
          physicalAttempts: () => attempts,
        }
      })
    })
  })
}

test('MockAdapter follows the same lifecycle contract as wire adapters', async () => {
  await runAdapterConformanceSuite((scenario) => {
    let turn: MockTurn
    switch (scenario) {
      case 'text':
      case 'pre-aborted':
        turn = { kind: 'text', text: 'hello' }
        break
      case 'tools':
        turn = {
          kind: 'tool-calls',
          calls: [{ id: 'call_1', name: 'lookup', argumentsJson: '{"key":"alpha"}' }],
        }
        break
      case 'truncated':
        turn = { kind: 'text', text: 'part', finish: 'max-tokens' }
        break
      case 'interrupted-tool':
        turn = {
          kind: 'throw',
          prefix: { tool: { id: 'call_1', name: 'lookup', argumentsJsonPrefix: '{"key":' } },
          error: new Error('connection closed'),
        }
        break
      default:
        turn = {
          kind: 'failure',
          failure: failure(
            scenario === 'invalid-request'
              ? 'INVALID_REQUEST'
              : scenario === 'rate-limit'
                ? 'RATE_LIMIT'
                : scenario === 'server-error'
                  ? 'SERVER'
                  : 'EMPTY_RESPONSE',
            'simulated upstream failure',
          ),
        }
    }
    const adapter = new MockAdapter({ turns: [turn] })
    return {
      adapter,
      routeId: 'mock' as RouteId,
      modelId: 'mock-model' as ModelId,
      request: {
        segment1Static: [],
        segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        segment3VolatileTail: NONE,
        sharedPrefixKey: NONE,
      },
      physicalAttempts: () => adapter.physicalAttempts(),
    }
  })
})
