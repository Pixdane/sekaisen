# Sekaisen

Sekaisen (世界線) is an agent-based role-playing simulation framework that enables complex interactions among agents and with their environment. It also provides basic mechanisms to express branching timelines and time travel, along with other common elements of science fiction narratives.

## LLM adapter plugins

`@sekaisen/plugin-llm` provides the domain-neutral Cordis `ctx.llm` service, immutable tool schemas (`t`), argument validation, guarded streaming, and a deterministic `MockAdapter`. It does not depend on world state or run agent/tool loops.

The `@sekaisen/plugin-llm/direct` entry point provides Fetch/SSE adapters for Anthropic Messages, OpenAI Completions, OpenAI Responses, and Gemini, plus embedding/rerank adapters and gateway presets. These work on Node ≥ 22.13 and Bun; each chat stream sends at most one inference request.

```ts
import { NONE } from '@sekaisen/core'
import { LlmService, StreamAssembler, type ModelId, type RouteId } from '@sekaisen/plugin-llm'
import { DirectChatAdapter, defineDirectRoute } from '@sekaisen/plugin-llm/direct'
import { Context } from 'cordis'

const ctx = new Context()
const llm = new LlmService(ctx)
const routeId = 'openai' as RouteId
const adapter = new DirectChatAdapter({
  routes: {
    openai: defineDirectRoute({
      gateway: 'openai',
      protocol: 'openai-completions',
      capabilities: { supportedEfforts: [] }, // This model has no reasoning-effort control.
    }),
  },
  resolveCredential: reference => process.env[reference],
})
const registered = llm.registerChatAdapter([routeId], adapter)
if (!registered.ok) throw new Error(registered.error.code)

try {
  const prepared = llm.prepareChatCall(
    { kind: 'explicit', routeId, modelId: 'gpt-4.1' as ModelId },
    {
      segment1Static: [{ name: 'system', text: 'Answer concisely.' }],
      segment2WarmHistory: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
      segment3VolatileTail: NONE,
      sharedPrefixKey: NONE,
    },
  )
  if (!prepared.ok) throw new Error(prepared.error.code)
  const result = await new StreamAssembler().consume(
    prepared.value.stream(new AbortController().signal),
  )
  console.log(result.blocks, result.finishReason)
} finally {
  await ctx.fiber.dispose()
}
```

Direct routes keep credential references rather than persisted API keys. Set `OPENAI_API_KEY` for this example. Configure route capabilities for the target model: protocol defaults are not a live model catalogue. Gateway presets include DeepSeek, SiliconFlow (`.com`/`.cn`), OpenRouter, OpenCode, CommandCode, and the HTTP OMP gateway; custom base URLs, headers, and anonymous endpoints are supported. `DirectEmbeddingAdapter` and `DirectRerankAdapter` use compatible `/embeddings` and `/rerank` endpoints.

`rerank()` validates and freezes adapter scores but preserves their order: callers must not assume relevance-descending results and should sort by `relevanceScore` when they need a ranking. `StreamAssembler` guards its input by default; `validateProtocol: false` skips only that guard instance and is valid solely for an already guarded stream such as a Waterfall exit.

`prepareChatCall()` validates requests, resolves capabilities and tool dialects, and freezes the route generation before execution. Each prepared call is single-use. Expected failures use `Result` or a terminal `finish` chunk; protocol defects throw `InvariantError`. A retry requires a new prepared call. Waterfall listeners may queue or transform a stream, but each listener's `next()` is also single-use. Keep assistant `origin` and its aligned replay envelope when storing signed reasoning/tool history: adapters validate the private replay data they restore and drop foreign, corrupted, or mistyped entries instead of sending their bytes, though swaps between two blocks of the same type remain undetectable. Store and rehydrate blocks in their original 1:1 order; arbitrary permutation of private metadata is not validated.

`@sekaisen/plugin-llm-omp` is a separate Bun ≥ 1.3.14 plugin pinned to `@oh-my-pi/pi-ai` / `pi-catalog` 18.10.4. Its default Cordis plugin export registers configured routes; `OmpPiAiAdapter` is also available directly:

```ts
import { OmpPiAiAdapter } from '@sekaisen/plugin-llm-omp'

const adapter = await OmpPiAiAdapter.create({
  routes: { 'omp:codex': { provider: 'openai-codex' } },
})
```

The bridge discovers the existing OMP auth store/broker (or accepts an injected store), delegates pre-output account recovery to pi-ai, and reports probe-observed inference attempts over the SDK's HTTP and Codex WebSocket paths, rejecting inference replay after the first semantic frame. That count covers only traffic visible through pi-ai's injected `fetch` / `onResponse` / `onSseEvent` seams; inference-URL matching is heuristic, so uncovered paths can only under-count, and an SDK transport that bypasses those seams needs new evidence and adapter-specific tests. OAuth/SDK types stay outside the neutral package. Tests use injected transports and auth stores; they do not read local credentials, open a real Codex socket, or call paid models.

Validation: `bun run typecheck`, `bun test`, `bun run check`. The shared `@sekaisen/plugin-llm/testing` conformance runner exercises text, tools, truncation, HTTP failures, interrupted tools, pre-send cancellation, and empty responses across both adapter families.

## License

GNU Affero General Public License version 3 only (`AGPL-3.0-only`).
See [LICENSE](LICENSE) for the full terms, including network-source obligations.
