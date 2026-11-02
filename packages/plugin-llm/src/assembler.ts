/**
 * Deterministic stream consumer: assembles guarded `StreamChunk` frames into
 * neutral content blocks, token usage, terminal reason and optional partial
 * tool-argument values.
 *
 * The assembler owns an internal `StreamProtocolGuard` by default, so the full
 * protocol state machine (first-byte ordering, contiguous block indexes,
 * block/delta type matching, `usage` only after every started block closed,
 * legal finish kinds) raises `InvariantError` exactly like the streaming layer.
 *
 * `validateProtocol: false` skips that guard instance only; the assembler is
 * not unchecked. Its own structural consistency checks still throw
 * `InvariantError` (duplicate or invalid `block-start`, `tool-call-delta` or
 * `block-end` for an unknown/unopened index, normal finish with an open block,
 * unknown chunk type, any frame after finish, second `consume()`), and
 * `consume()` still requires a terminal finish frame. Because guard-level rules
 * (chunk payload validation, `usage` placement, finish-kind/failure-code
 * consistency, `replayState`/block alignment) are then not re-run, callers MUST
 * pass a stream already validated end to end by its own guard, such as a
 * `llm/stream` Waterfall exit stream.
 *
 * Partial tool JSON is parsed with a geometric throttle
 * (`growth >= max(256, buffer.length >>> 5)`) so long argument strings are not
 * re-parsed for every delta; the throttle is implemented locally without any
 * external dependency.
 */

import type { Option } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import { StreamProtocolGuard } from './stream.ts'
import type {
  DisjointTokenUsage,
  FinishReason,
  NeutralContentBlock,
  ReplayEnvelope,
  StreamChunk,
  ToolCallId,
} from './types.ts'
import { validString } from './utils.ts'

function unknownChunkType(chunk: StreamChunk): InvariantError {
  return new InvariantError(`unknown StreamChunk type: ${String(chunk.type)}`)
}

/* -------------------------------------------------------------------------- */
/*                  Geometric-gated tolerant JSON parsing                    */
/* -------------------------------------------------------------------------- */

const MIN_PARTIAL_JSON_GROWTH = 256

function trimTrailingSpace(text: string): string {
  let end = text.length
  while (end > 0) {
    const code = text.charCodeAt(end - 1)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
    end--
  }
  return text.slice(0, end)
}

/**
 * Close unterminated strings/brackets of a truncated JSON prefix.
 *
 * Returns `null` when the prefix cannot be completed without guessing a value
 * (for example a dangling `:` or a mismatched closing bracket).
 */
function completeJsonPrefix(text: string): string | null {
  const stack: ('object' | 'array')[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      stack.push('object')
    } else if (char === '[') {
      stack.push('array')
    } else if (char === '}' || char === ']') {
      const expected = char === '}' ? 'object' : 'array'
      if (stack.pop() !== expected) return null
    }
  }

  let completed = text
  if (inString) {
    // A dangling escape cannot be completed without guessing; drop it.
    if (escaped) completed = completed.slice(0, -1)
    completed += '"'
  }
  for (;;) {
    completed = trimTrailingSpace(completed)
    if (completed.endsWith(',')) {
      completed = completed.slice(0, -1)
      continue
    }
    if (completed.endsWith(':')) return null
    break
  }
  while (stack.length > 0) {
    const kind = stack.pop()
    completed = trimTrailingSpace(completed)
    if (completed.endsWith(',')) completed = completed.slice(0, -1)
    completed += kind === 'array' ? ']' : '}'
  }
  return completed
}

/**
 * Strict-then-tolerant parse of a possibly truncated JSON string.
 *
 * A complete JSON document takes the native `JSON.parse` fast path. Otherwise
 * unterminated strings are closed, trailing separators dropped and open
 * containers closed before a second `JSON.parse`. The function never throws
 * for malformed input; it returns `NONE` when no prefix value can be recovered.
 */
export function parsePartialJson(text: string): Option<unknown> {
  if (typeof text !== 'string' || !text.isWellFormed()) {
    throw new InvariantError('parsePartialJson expects a well-formed Unicode string')
  }
  if (text.trim().length === 0) return NONE
  try {
    return some(JSON.parse(text))
  } catch {
    // Fall through to prefix completion.
  }
  const completed = completeJsonPrefix(text)
  if (completed === null) return NONE
  try {
    return some(JSON.parse(completed))
  } catch {
    return NONE
  }
}

/* -------------------------------------------------------------------------- */
/*                              Assembly results                             */
/* -------------------------------------------------------------------------- */

/** One fully assembled tool call, in block order. */
export interface AssembledToolCall {
  readonly index: number
  readonly id: ToolCallId
  readonly name: string
  readonly argumentsJson: string
  /** Latest gated loose parse of `argumentsJson` (NONE if disabled or unparseable). */
  readonly partialArguments: Option<unknown>
}

/** Immutable view of everything a stream produced so far. */
export interface AssembledStreamSnapshot {
  /**
   * Blocks closed so far, ordered by block index. Blocks still open when a
   * stream is unfinished or failed terminally are omitted rather than fabricated.
   */
  readonly blocks: readonly NeutralContentBlock[]
  readonly toolCalls: readonly AssembledToolCall[]
  readonly usage: Option<DisjointTokenUsage>
  readonly finishReason: Option<FinishReason>
  readonly replayState: Option<ReplayEnvelope>
  readonly observedAttempts: Option<number>
}

/** Options for {@link StreamAssembler}. */
export interface StreamAssemblerOptions {
  /** Enables geometric-gated partial tool-argument parsing. Defaults to `false`. */
  readonly enablePartialToolJson?: boolean
  /**
   * Wraps every accepted frame in an internal guard. Defaults to `true`.
   * `false` skips only the guard state machine; assembler-level consistency
   * checks and the `consume()` terminal-finish requirement still apply, so
   * only pass it for a stream already validated end to end elsewhere.
   */
  readonly validateProtocol?: boolean
}

interface ToolBuffer {
  readonly id: ToolCallId
  readonly name: string
  json: string
  parsedLength: number
  partial: Option<unknown>
}

/**
 * Consumes a validated `StreamChunk` sequence.
 *
 * `accept` supports incremental use; `snapshot` may be taken at any time;
 * `consume` drains a whole stream and requires a terminal finish frame.
 */
export class StreamAssembler {
  readonly #guard: StreamProtocolGuard | undefined
  readonly #partialEnabled: boolean
  readonly #toolBuffers = new Map<number, ToolBuffer>()
  readonly #closedBlocks = new Map<number, NeutralContentBlock>()
  readonly #openBlockIndexes = new Set<number>()
  #usage: Option<DisjointTokenUsage> = NONE
  #finishReason: Option<FinishReason> = NONE
  #replayState: Option<ReplayEnvelope> = NONE
  #observedAttempts: Option<number> = NONE
  #consumed = false

  constructor(options: StreamAssemblerOptions = {}) {
    this.#guard = options.validateProtocol === false ? undefined : new StreamProtocolGuard()
    this.#partialEnabled = options.enablePartialToolJson ?? false
  }

  /** Closed content blocks in block-index order. */
  get blocks(): readonly NeutralContentBlock[] {
    // Closure order is unconstrained by the protocol; consumers always observe
    // blocks ordered by their block index.
    return [...this.#closedBlocks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, block]) => block)
  }

  /** Terminal reason once the stream finished. */
  get finishReason(): Option<FinishReason> {
    return this.#finishReason
  }

  /** Token usage once the stream emitted its single usage frame. */
  get usage(): Option<DisjointTokenUsage> {
    return this.#usage
  }

  /** Replay envelope carried by the terminal finish frame. */
  get replayState(): Option<ReplayEnvelope> {
    return this.#replayState
  }

  /** Observed physical attempts carried by the terminal finish frame. */
  get observedAttempts(): Option<number> {
    return this.#observedAttempts
  }

  /** Tool calls in block order, including their latest partial parse. */
  get toolCalls(): readonly AssembledToolCall[] {
    return [...this.#toolBuffers.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([index, buffer]) => this.#toolCallSnapshot(index, buffer))
  }

  /** Consume one frame; throws `InvariantError` once a finish frame was accepted. */
  accept(chunk: StreamChunk): void {
    if (this.#finishReason.kind === 'some') {
      throw new InvariantError('StreamAssembler received a frame after the terminal finish')
    }
    this.#guard?.accept(chunk)
    switch (chunk.type) {
      case 'first-byte':
      case 'text-delta':
      case 'reasoning-delta':
        return
      case 'block-start':
        if (this.#openBlockIndexes.has(chunk.index)) {
          throw new InvariantError(`block index ${chunk.index} was already started`)
        }
        this.#openBlockIndexes.add(chunk.index)
        if (chunk.blockType === 'tool-call') {
          if (!validString(chunk.toolCallId, true) || !validString(chunk.toolName, true)) {
            throw new InvariantError('tool-call block-start requires toolCallId and toolName')
          }
          this.#toolBuffers.set(chunk.index, {
            id: chunk.toolCallId,
            name: chunk.toolName,
            json: '',
            parsedLength: 0,
            partial: NONE,
          })
        }
        return
      case 'tool-call-delta': {
        const buffer = this.#toolBuffers.get(chunk.index)
        if (buffer === undefined) {
          throw new InvariantError(`tool-call-delta references unknown block index ${chunk.index}`)
        }
        buffer.json += chunk.delta
        this.#updatePartial(buffer, false)
        return
      }
      case 'block-end':
        this.#acceptBlockEnd(chunk.index, chunk.block)
        return
      case 'usage':
        this.#usage = some(chunk.usage)
        return
      case 'finish':
        if (
          (chunk.reason.kind === 'stop' ||
            chunk.reason.kind === 'tool-calls' ||
            chunk.reason.kind === 'max-tokens') &&
          this.#openBlockIndexes.size > 0
        ) {
          throw new InvariantError('normal finish requires every started block to be closed')
        }
        this.#finishReason = some(chunk.reason)
        this.#replayState = chunk.replayState
        this.#observedAttempts = some(chunk.observedAttempts)
        return
      default:
        throw unknownChunkType(chunk)
    }
  }

  /** Current immutable assembly state; safe to call at any point. */
  snapshot(): AssembledStreamSnapshot {
    return Object.freeze({
      blocks: Object.freeze([...this.blocks]),
      toolCalls: Object.freeze(this.toolCalls),
      usage: this.#usage,
      finishReason: this.#finishReason,
      replayState: this.#replayState,
      observedAttempts: this.#observedAttempts,
    })
  }

  /**
   * Drain `stream` through {@link accept}, assert it ended with a terminal
   * finish frame, and return the final snapshot. Single-use.
   */
  async consume(stream: AsyncIterable<StreamChunk>): Promise<AssembledStreamSnapshot> {
    if (this.#consumed) {
      throw new InvariantError('StreamAssembler is single-use: consume() already ran')
    }
    this.#consumed = true
    for await (const chunk of stream) this.accept(chunk)
    this.#guard?.end()
    if (this.#finishReason.kind === 'none') {
      throw new InvariantError('stream ended without a terminal finish frame')
    }
    return this.snapshot()
  }

  #acceptBlockEnd(index: number, block: NeutralContentBlock): void {
    if (!this.#openBlockIndexes.delete(index)) {
      throw new InvariantError(`block-end references block index ${index} which is not open`)
    }
    if (block.type === 'tool-call') {
      const buffer = this.#toolBuffers.get(index)
      if (buffer === undefined) {
        throw new InvariantError(`tool-call block-end references unknown block index ${index}`)
      }
      // The closed block is authoritative: adapters may reconcile deltas with a
      // final upstream item (for example Responses `output_item.done`).
      buffer.json = block.argumentsJson
      buffer.parsedLength = 0
      this.#updatePartial(buffer, true)
    }
    this.#closedBlocks.set(index, block)
  }

  #updatePartial(buffer: ToolBuffer, force: boolean): void {
    if (!this.#partialEnabled) return
    if (!force) {
      const growth = buffer.json.length - buffer.parsedLength
      if (growth < Math.max(MIN_PARTIAL_JSON_GROWTH, buffer.json.length >>> 5)) return
    }
    buffer.parsedLength = buffer.json.length
    buffer.partial = parsePartialJson(buffer.json)
  }

  #toolCallSnapshot(index: number, buffer: ToolBuffer): AssembledToolCall {
    return Object.freeze({
      index,
      id: buffer.id,
      name: buffer.name,
      argumentsJson: buffer.json,
      partialArguments: buffer.partial,
    })
  }
}
