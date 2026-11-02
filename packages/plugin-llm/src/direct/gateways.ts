import type { ModelCapabilities } from '../service-types.ts'
import type { DirectCompat, DirectProtocol, DirectRouteConfig, GatewayKind } from './contract.ts'

/**
 * Forward auth styles accepted by {@link DirectRouteConfig.authMode}.
 * `'x-api-key'` maps to `x-api-key` for Anthropic-style routes and
 * `x-goog-api-key` for Google routes.
 */
export type DirectAuthMode = 'bearer' | 'x-api-key' | 'none'

/**
 * Declarative, transport-neutral description of one upstream gateway dialect.
 *
 * Every entry below is pure data: no gateway behaviour is allowed to require an
 * extra HTTP request, and every per-protocol value is only a *default* that an
 * explicit route configuration may override.
 */
export interface GatewayPreset {
  readonly kind: Exclude<GatewayKind, 'custom'>
  /** Protocols this gateway exposes; informational but enforced by docs/tests. */
  readonly protocols: readonly DirectProtocol[]
  /** Default host prefix per protocol (version segments belong to the wire path). */
  readonly baseURLs: Partial<Record<DirectProtocol, string>>
  readonly authModes: Partial<Record<DirectProtocol, DirectAuthMode>>
  readonly credentialRefs: Partial<Record<DirectProtocol, string>>
  readonly compats: Partial<Record<DirectProtocol, DirectCompat>>
  readonly headers?: Readonly<Record<string, string>>
  readonly notes: string
}

const OPENAI_COMPLETIONS = 'openai-completions' as const
const OPENAI_RESPONSES = 'openai-responses' as const
const ANTHROPIC_MESSAGES = 'anthropic-messages' as const
const GOOGLE_GEMINI = 'google-gemini' as const

/** Default auth style implied by a protocol when no gateway preset disagrees. */
export function defaultAuthMode(protocol: DirectProtocol): DirectAuthMode {
  return protocol === ANTHROPIC_MESSAGES || protocol === GOOGLE_GEMINI ? 'x-api-key' : 'bearer'
}

/** Official/default host prefixes; only known endpoints are declared. */
export const GATEWAY_PRESETS: Readonly<Record<Exclude<GatewayKind, 'custom'>, GatewayPreset>> =
  Object.freeze({
    deepseek: {
      kind: 'deepseek',
      protocols: [ANTHROPIC_MESSAGES, OPENAI_COMPLETIONS],
      baseURLs: {
        [ANTHROPIC_MESSAGES]: 'https://api.deepseek.com/anthropic',
        [OPENAI_COMPLETIONS]: 'https://api.deepseek.com',
      },
      authModes: { [ANTHROPIC_MESSAGES]: 'x-api-key', [OPENAI_COMPLETIONS]: 'bearer' },
      credentialRefs: {
        [ANTHROPIC_MESSAGES]: 'DEEPSEEK_API_KEY',
        [OPENAI_COMPLETIONS]: 'DEEPSEEK_API_KEY',
      },
      compats: {
        [OPENAI_COMPLETIONS]: { stripTemplateTokens: true, reasoningField: 'reasoning_content' },
      },
      notes: 'DeepSeek official: Anthropic-compatible /anthropic route plus /v1 completions route.',
    },
    siliconflow: {
      kind: 'siliconflow',
      protocols: [OPENAI_COMPLETIONS],
      baseURLs: { [OPENAI_COMPLETIONS]: 'https://api.siliconflow.com' },
      authModes: { [OPENAI_COMPLETIONS]: 'bearer' },
      credentialRefs: { [OPENAI_COMPLETIONS]: 'SILICONFLOW_API_KEY' },
      compats: {},
      notes: 'SiliconFlow international site: completions, embeddings and rerank.',
    },
    'siliconflow-cn': {
      kind: 'siliconflow-cn',
      protocols: [OPENAI_COMPLETIONS],
      baseURLs: { [OPENAI_COMPLETIONS]: 'https://api.siliconflow.cn' },
      authModes: { [OPENAI_COMPLETIONS]: 'bearer' },
      credentialRefs: { [OPENAI_COMPLETIONS]: 'SILICONFLOW_API_KEY' },
      compats: {},
      notes: 'SiliconFlow China site: completions, embeddings and rerank.',
    },
    openrouter: {
      kind: 'openrouter',
      protocols: [OPENAI_RESPONSES, OPENAI_COMPLETIONS],
      baseURLs: {
        [OPENAI_RESPONSES]: 'https://openrouter.ai/api',
        [OPENAI_COMPLETIONS]: 'https://openrouter.ai/api',
      },
      authModes: { [OPENAI_RESPONSES]: 'bearer', [OPENAI_COMPLETIONS]: 'bearer' },
      credentialRefs: {
        [OPENAI_RESPONSES]: 'OPENROUTER_API_KEY',
        [OPENAI_COMPLETIONS]: 'OPENROUTER_API_KEY',
      },
      compats: {
        [OPENAI_COMPLETIONS]: { omitImplicitMaxTokens: true },
        [OPENAI_RESPONSES]: { omitImplicitMaxTokens: true },
      },
      notes:
        'OpenRouter: never sends an implicit max-token ceiling, forwards Anthropic cache markers, ' +
        'maps a disabled reasoning effort to `reasoning: { enabled: false }`.',
    },
    opencode: {
      kind: 'opencode',
      protocols: [ANTHROPIC_MESSAGES, OPENAI_RESPONSES, OPENAI_COMPLETIONS, GOOGLE_GEMINI],
      baseURLs: {
        [ANTHROPIC_MESSAGES]: 'https://opencode.ai/zen',
        [OPENAI_RESPONSES]: 'https://opencode.ai/zen',
        [OPENAI_COMPLETIONS]: 'https://opencode.ai/zen',
        [GOOGLE_GEMINI]: 'https://opencode.ai/zen',
      },
      authModes: {
        [ANTHROPIC_MESSAGES]: 'x-api-key',
        [OPENAI_RESPONSES]: 'bearer',
        [OPENAI_COMPLETIONS]: 'bearer',
        [GOOGLE_GEMINI]: 'bearer',
      },
      credentialRefs: {
        [ANTHROPIC_MESSAGES]: 'OPENCODE_API_KEY',
        [OPENAI_RESPONSES]: 'OPENCODE_API_KEY',
        [OPENAI_COMPLETIONS]: 'OPENCODE_API_KEY',
        [GOOGLE_GEMINI]: 'OPENCODE_API_KEY',
      },
      compats: {},
      notes:
        'OpenCode Zen/Go: model-routed protocols, Anthropic routes authenticate with x-api-key only, ' +
        'forced tool choice is unavailable.',
    },
    commandcode: {
      kind: 'commandcode',
      protocols: [ANTHROPIC_MESSAGES, OPENAI_RESPONSES, OPENAI_COMPLETIONS],
      baseURLs: {},
      authModes: {
        [ANTHROPIC_MESSAGES]: 'bearer',
        [OPENAI_RESPONSES]: 'bearer',
        [OPENAI_COMPLETIONS]: 'bearer',
      },
      credentialRefs: {
        [ANTHROPIC_MESSAGES]: 'COMMAND_CODE_API_KEY',
        [OPENAI_RESPONSES]: 'COMMAND_CODE_API_KEY',
        [OPENAI_COMPLETIONS]: 'COMMAND_CODE_API_KEY',
      },
      compats: {},
      notes: 'CommandCode: Claude -> messages, GPT -> responses, everything else -> completions.',
    },
    'omp-gateway-http': {
      kind: 'omp-gateway-http',
      protocols: [ANTHROPIC_MESSAGES, OPENAI_RESPONSES, OPENAI_COMPLETIONS, GOOGLE_GEMINI],
      baseURLs: {},
      authModes: {
        [ANTHROPIC_MESSAGES]: 'none',
        [OPENAI_RESPONSES]: 'none',
        [OPENAI_COMPLETIONS]: 'none',
        [GOOGLE_GEMINI]: 'none',
      },
      credentialRefs: {},
      compats: {},
      notes:
        'Live HTTP SSE view of a local `omp auth-gateway serve` process; the loopback base URL ' +
        '(host + optional path prefix) is always explicit, never guessed.',
    },
    openai: {
      kind: 'openai',
      protocols: [OPENAI_RESPONSES, OPENAI_COMPLETIONS],
      baseURLs: {
        [OPENAI_RESPONSES]: 'https://api.openai.com',
        [OPENAI_COMPLETIONS]: 'https://api.openai.com',
      },
      authModes: { [OPENAI_RESPONSES]: 'bearer', [OPENAI_COMPLETIONS]: 'bearer' },
      credentialRefs: {
        [OPENAI_RESPONSES]: 'OPENAI_API_KEY',
        [OPENAI_COMPLETIONS]: 'OPENAI_API_KEY',
      },
      compats: {},
      notes: 'OpenAI official API.',
    },
    anthropic: {
      kind: 'anthropic',
      protocols: [ANTHROPIC_MESSAGES],
      baseURLs: { [ANTHROPIC_MESSAGES]: 'https://api.anthropic.com' },
      authModes: { [ANTHROPIC_MESSAGES]: 'x-api-key' },
      credentialRefs: { [ANTHROPIC_MESSAGES]: 'ANTHROPIC_API_KEY' },
      compats: {},
      notes: 'Anthropic official Messages API.',
    },
    google: {
      kind: 'google',
      protocols: [GOOGLE_GEMINI],
      baseURLs: { [GOOGLE_GEMINI]: 'https://generativelanguage.googleapis.com' },
      authModes: { [GOOGLE_GEMINI]: 'x-api-key' },
      credentialRefs: { [GOOGLE_GEMINI]: 'GEMINI_API_KEY' },
      compats: {},
      notes: 'Google Gemini API (generativelanguage).',
    },
  })

const GATEWAY_KINDS: readonly GatewayKind[] = Object.freeze([
  'custom',
  'deepseek',
  'siliconflow',
  'siliconflow-cn',
  'openrouter',
  'opencode',
  'commandcode',
  'omp-gateway-http',
  'openai',
  'anthropic',
  'google',
])

/** Runtime-checkable list of every declarative gateway name. */
export function isGatewayKind(value: unknown): value is GatewayKind {
  return typeof value === 'string' && (GATEWAY_KINDS as readonly string[]).includes(value)
}

/** Look up a preset; `'custom'` and unknown kinds have no declarative preset. */
export function gatewayPreset(kind: GatewayKind): GatewayPreset | undefined {
  return kind === 'custom' ? undefined : GATEWAY_PRESETS[kind]
}

/** Preset auth style for `(gateway, protocol)`, if declared. */
export function presetAuthMode(
  kind: GatewayKind,
  protocol: DirectProtocol,
): DirectAuthMode | undefined {
  return gatewayPreset(kind)?.authModes[protocol]
}

/** Preset credential reference (for example an environment variable name). */
export function presetCredentialRef(
  kind: GatewayKind,
  protocol: DirectProtocol,
): string | undefined {
  return gatewayPreset(kind)?.credentialRefs[protocol]
}

/** Preset base URL per protocol (host prefix; version segments belong to the wire path). */
export function presetBaseURL(kind: GatewayKind, protocol: DirectProtocol): string | undefined {
  return gatewayPreset(kind)?.baseURLs[protocol]
}

/** Preset literal headers (never credentials, never Authorization). */
export function presetHeaders(kind: GatewayKind): Readonly<Record<string, string>> {
  return gatewayPreset(kind)?.headers ?? {}
}

/** Preset compatibility switches merged before explicit route compat overrides. */
export function presetCompat(kind: GatewayKind, protocol: DirectProtocol): DirectCompat {
  return gatewayPreset(kind)?.compats[protocol] ?? {}
}

/**
 * Gateway-level capability declaration that is applied *after* protocol
 * defaults but *before* an explicit `capabilities` override.
 */
export function gatewayCapabilityPolicy(
  kind: GatewayKind,
  protocol: DirectProtocol,
  modelId: string,
): Partial<ModelCapabilities> {
  switch (kind) {
    case 'deepseek':
      if (protocol === ANTHROPIC_MESSAGES && modelId === 'deepseek-flash') {
        return { systemPromptUpdate: 'in-history' }
      }
      if (protocol === OPENAI_COMPLETIONS) {
        return { forcedToolChoiceSupport: 'none' }
      }
      return {}
    case 'opencode':
      return { forcedToolChoiceSupport: 'none' }
    case 'commandcode':
      return protocol === OPENAI_RESPONSES ? { forcedToolChoiceSupport: 'required-only' } : {}
    default:
      return {}
  }
}

/** Input accepted by {@link defineDirectRoute}. */
export interface DirectRouteInput {
  readonly protocol: DirectProtocol
  readonly gateway?: GatewayKind
  readonly baseURL?: string
  readonly credentialRef?: string
  readonly authMode?: DirectAuthMode
  readonly headers?: Readonly<Record<string, string>>
  readonly capabilities?: Partial<ModelCapabilities>
  readonly compat?: DirectCompat
  readonly firstEventTimeoutMs?: number
  readonly interEventTimeoutMs?: number
}

/**
 * Build a concrete {@link DirectRouteConfig} from a declarative gateway preset.
 * Throws {@link TypeError} when no base URL can be derived; the adapter's own
 * `replaceConfiguration`/constructor then performs the full validation pass.
 */
export function defineDirectRoute(input: DirectRouteInput): DirectRouteConfig {
  const gateway = input.gateway ?? 'custom'
  const baseURL = input.baseURL ?? presetBaseURL(gateway, input.protocol)
  if (baseURL === undefined || baseURL.length === 0) {
    throw new TypeError(
      `direct route preset "${gateway}" has no default base URL for protocol "${input.protocol}"; ` +
        'supply an explicit baseURL',
    )
  }
  const credentialRef = input.credentialRef ?? presetCredentialRef(gateway, input.protocol)
  const compat: DirectCompat = { ...presetCompat(gateway, input.protocol), ...input.compat }
  const headers = { ...presetHeaders(gateway), ...input.headers }
  return {
    protocol: input.protocol,
    baseURL,
    authMode:
      input.authMode ?? presetAuthMode(gateway, input.protocol) ?? defaultAuthMode(input.protocol),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(gateway === 'custom' ? {} : { gateway }),
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    ...(Object.keys(compat).length === 0 ? {} : { compat }),
    ...(input.firstEventTimeoutMs === undefined
      ? {}
      : { firstEventTimeoutMs: input.firstEventTimeoutMs }),
    ...(input.interEventTimeoutMs === undefined
      ? {}
      : { interEventTimeoutMs: input.interEventTimeoutMs }),
  }
}
