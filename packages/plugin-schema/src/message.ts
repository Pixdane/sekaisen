import type { Option, Result } from '@sekaisen/core'
import { err, isOption, NONE, ok, some } from '@sekaisen/core'
import type { CommitHash, Path, ScalarValue, Value } from '@sekaisen/plugin-world'
import { comparePaths, encodePathKey } from '@sekaisen/plugin-world'
import { assertIdentifier, cloneLeafValue, cloneSchema, SchemaFailure } from './builders.ts'
import type {
  InferCoreInput,
  InferCoreOutput,
  LeafValueKind,
  MessagePrism,
  MessageSchemaNode,
  MessageStructSchemaNode,
  SchemaError,
  SchemaNode,
  SchemaNodeOf,
  TypedCommitMessage,
} from './types.ts'

/* -------------------------------------------------------------------------- */
/*                             Wire format constants                        */
/* -------------------------------------------------------------------------- */

const PROTOCOL_DOMAIN = 'SCHEMA_MSG_V1'
const utf8Encoder = new TextEncoder()
const HEADER_PREFIX = utf8Encoder.encode('SEKAISEN_V1:')
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const numberScratch = new Uint8Array(8)
const numberView = new DataView(numberScratch.buffer)

const TAG_NULL = 0x01
const TAG_BOOL = 0x02
const TAG_NUMBER = 0x03
const TAG_STRING = 0x04
const TAG_BYTES = 0x05
const TAG_LIST = 0x06

/** Decode failures carry the placeholder commit id; callers know the commit. */
const EMPTY_COMMIT_ID = '' as CommitHash

function decodeFailure(reason: string): never {
  throw new SchemaFailure({ kind: 'message_decode_error', commitId: EMPTY_COMMIT_ID, reason })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  )
}

function asRecord(value: unknown, path: Path): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new SchemaFailure({
      kind: 'validation_failed',
      path,
      reason: 'type_mismatch',
      detail: 'message container input must be a plain object',
    })
  }
  return value
}

/* -------------------------------------------------------------------------- */
/*                       Message schema validation                          */
/* -------------------------------------------------------------------------- */

/** Validate that a schema node can be used inside a commit message. */
export function validateMessageSchema(schema: MessageStructSchemaNode, path: Path = []): void {
  if (schema.nodeKind !== 'struct') {
    throw new SchemaFailure({
      kind: 'validation_failed',
      path,
      reason: 'type_mismatch',
      detail: 'a message schema root must be a struct',
    })
  }
  const visit = (node: SchemaNode, nodePath: Path): void => {
    switch (node.nodeKind) {
      case 'leaf':
        if (node.valueKind === 'ref') {
          throw new SchemaFailure({
            kind: 'schema_conflict',
            path: nodePath,
            reason: 'ref_not_allowed_in_message',
          })
        }
        if (node.presence.mode === 'defaulted') {
          cloneLeafValue(node.valueKind, node.presence.defaultValue, nodePath)
        }
        return
      case 'struct':
        if (node.allowCustom !== false) {
          throw new SchemaFailure({
            kind: 'validation_failed',
            path: nodePath,
            reason: 'custom_not_allowed_on_struct',
            detail: 'commit-message structs must not allow custom keys',
          })
        }
        for (const [key, child] of Object.entries(node.fields)) {
          assertIdentifier(key)
          visit(child, [...nodePath, key])
        }
        return
      case 'map':
        visit(node.valueSchema, [...nodePath, '*'])
        return
    }
  }
  const root: SchemaNode = schema
  visit(root, path)
}

/* -------------------------------------------------------------------------- */
/*                         Input normalization / flatten                    */
/* -------------------------------------------------------------------------- */

type FlatEntry = { readonly path: Path; readonly value: Value }

function unwrapOptional(input: unknown): { readonly present: boolean; readonly value: unknown } {
  if (input === undefined || input === null) return { present: false, value: undefined }
  if (isOption(input)) {
    return input.kind === 'some'
      ? { present: true, value: input.value }
      : { present: false, value: undefined }
  }
  return { present: true, value: input }
}

function pushEntry(entries: FlatEntry[], path: Path, value: Value): void {
  entries.push({ path: Object.freeze([...path]), value })
}

function materializeNode(schema: MessageSchemaNode, path: Path, entries: FlatEntry[]): unknown {
  switch (schema.nodeKind) {
    case 'leaf': {
      if (schema.presence.mode !== 'defaulted') {
        throw new SchemaFailure({
          kind: 'validation_failed',
          path,
          reason: 'missing_required_field',
          detail: 'cannot materialize a non-defaulted leaf',
        })
      }
      const cloned = cloneLeafValue(schema.valueKind, schema.presence.defaultValue, path)
      pushEntry(entries, [...path, '$val'], cloned as Value)
      return cloned
    }
    case 'map':
      pushEntry(entries, [...path, '$exists'], true)
      return Object.freeze({})
    case 'struct': {
      pushEntry(entries, [...path, '$exists'], true)
      const out: Record<string, unknown> = Object.create(null)
      for (const [key, child] of Object.entries(schema.fields)) {
        out[key] =
          child.presence.mode === 'defaulted'
            ? materializeNode(child, [...path, key], entries)
            : NONE
      }
      return Object.freeze(out)
    }
  }
}

function buildPresentNode(
  schema: MessageSchemaNode,
  path: Path,
  input: unknown,
  entries: FlatEntry[],
): unknown {
  switch (schema.nodeKind) {
    case 'leaf': {
      const cloned = cloneLeafValue(schema.valueKind, input, path)
      pushEntry(entries, [...path, '$val'], cloned as Value)
      return cloned
    }
    case 'struct': {
      const record = asRecord(input, path)
      pushEntry(entries, [...path, '$exists'], true)
      const out: Record<string, unknown> = Object.create(null)
      for (const [key, child] of Object.entries(schema.fields)) {
        const supplied = Object.hasOwn(record, key) ? record[key] : undefined
        if (child.presence.mode === 'optional') {
          const optional = unwrapOptional(supplied)
          out[key] = optional.present
            ? some(buildPresentNode(child, [...path, key], optional.value, entries))
            : NONE
          continue
        }
        if (supplied === undefined && child.presence.mode === 'defaulted') {
          out[key] = materializeNode(child, [...path, key], entries)
          continue
        }
        if (supplied === undefined) {
          throw new SchemaFailure({
            kind: 'validation_failed',
            path: [...path, key],
            reason: 'missing_required_field',
            detail: 'required message field is missing',
          })
        }
        out[key] = buildPresentNode(child, [...path, key], supplied, entries)
      }
      return Object.freeze(out)
    }
    case 'map': {
      const record = asRecord(input, path)
      pushEntry(entries, [...path, '$exists'], true)
      const out: Record<string, unknown> = Object.create(null)
      for (const [id, value] of Object.entries(record)) {
        assertIdentifier(id)
        out[id] = buildPresentNode(schema.valueSchema, [...path, id], value, entries)
      }
      return Object.freeze(out)
    }
  }
}

function buildMessage(
  schema: MessageStructSchemaNode,
  input: unknown,
): { readonly output: unknown; readonly entries: readonly FlatEntry[] } {
  const entries: FlatEntry[] = []
  const output = buildPresentNode(schema, [], input, entries)
  entries.sort((a, b) => comparePaths(a.path, b.path))
  return { output, entries }
}

/* -------------------------------------------------------------------------- */
/*                                  Encoder                                 */
/* -------------------------------------------------------------------------- */

function pushUint32(out: number[], value: number): void {
  out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function pushString(out: number[], value: string): void {
  if (!value.isWellFormed()) {
    throw new SchemaFailure({
      kind: 'message_decode_error',
      commitId: EMPTY_COMMIT_ID,
      reason: 'string is not well-formed Unicode',
    })
  }
  const bytes = utf8Encoder.encode(value)
  out.push(TAG_STRING)
  pushUint32(out, bytes.byteLength)
  for (const byte of bytes) out.push(byte)
}

function pushScalar(out: number[], value: ScalarValue): void {
  if (value === null) {
    out.push(TAG_NULL)
    return
  }
  switch (typeof value) {
    case 'boolean':
      out.push(TAG_BOOL, value ? 1 : 0)
      return
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new SchemaFailure({
          kind: 'message_decode_error',
          commitId: EMPTY_COMMIT_ID,
          reason: 'numbers must be finite',
        })
      }
      out.push(TAG_NUMBER)
      numberView.setFloat64(0, value === 0 ? 0 : value, false)
      for (const byte of numberScratch) out.push(byte)
      return
    }
    case 'string':
      pushString(out, value)
      return
    case 'object': {
      if (!(value instanceof Uint8Array)) {
        throw new SchemaFailure({
          kind: 'message_decode_error',
          commitId: EMPTY_COMMIT_ID,
          reason: 'unsupported scalar object',
        })
      }
      out.push(TAG_BYTES)
      pushUint32(out, value.byteLength)
      for (const byte of value) out.push(byte)
      return
    }
    default:
      throw new SchemaFailure({
        kind: 'message_decode_error',
        commitId: EMPTY_COMMIT_ID,
        reason: `unsupported scalar type: ${typeof value}`,
      })
  }
}

function pushValue(out: number[], value: Value): void {
  if (Array.isArray(value)) {
    out.push(TAG_LIST)
    pushUint32(out, value.length)
    for (const item of value) pushScalar(out, item)
    return
  }
  pushScalar(out, value as ScalarValue)
}

function pushPath(out: number[], path: Path): void {
  pushUint32(out, path.length)
  for (const segment of path) pushString(out, segment)
}

/** Deterministic self-describing commit-message encoding (`SCHEMA_MSG_V1`). */
export function encodeMessage(
  message: TypedCommitMessage,
  schema: MessageStructSchemaNode,
): Uint8Array {
  if (!isPlainRecord(message)) {
    throw new SchemaFailure({
      kind: 'validation_failed',
      path: [],
      reason: 'type_mismatch',
      detail: 'message envelope must be an object',
    })
  }
  if (typeof message.kind !== 'string') {
    throw new SchemaFailure({
      kind: 'validation_failed',
      path: [],
      reason: 'type_mismatch',
      detail: 'message kind must be a string',
    })
  }
  assertIdentifier(message.kind)
  const owned = cloneSchema(schema)
  // cloneSchema preserves the struct root; validation below rejects refs/custom keys.
  const messageSchema = owned as unknown as MessageStructSchemaNode
  validateMessageSchema(messageSchema)
  const { entries } = buildMessage(messageSchema, message.data)

  const out: number[] = []
  out.push(0x00)
  for (const byte of HEADER_PREFIX) out.push(byte)
  pushString(out, PROTOCOL_DOMAIN)
  pushString(out, message.kind)
  pushUint32(out, entries.length)
  for (const entry of entries) {
    pushPath(out, entry.path)
    pushValue(out, entry.value)
  }
  return Uint8Array.from(out)
}

/* -------------------------------------------------------------------------- */
/*                                  Decoder                                 */
/* -------------------------------------------------------------------------- */

class MessageReader {
  readonly bytes: Uint8Array
  readonly view: DataView
  offset = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset
  }

  readByte(): number {
    if (this.offset >= this.bytes.byteLength) decodeFailure('unexpected end of message')
    return this.bytes[this.offset++]!
  }

  readUint32(): number {
    if (this.remaining < 4) decodeFailure('unexpected end of message')
    const b = this.bytes
    const offset = this.offset
    this.offset = offset + 4
    return (
      b[offset]! * 0x1000000 + ((b[offset + 1]! << 16) | (b[offset + 2]! << 8) | b[offset + 3]!)
    )
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      decodeFailure('invalid byte length')
    }
    const start = this.offset
    this.offset = start + length
    return this.bytes.slice(start, start + length)
  }

  readString(): string {
    if (this.readByte() !== TAG_STRING) decodeFailure('expected a string')
    const length = this.readUint32()
    const bytes = this.readBytes(length)
    try {
      return utf8Decoder.decode(bytes)
    } catch {
      return decodeFailure('string is not valid UTF-8')
    }
  }

  readNumber(): number {
    if (this.remaining < 8) decodeFailure('unexpected end of message')
    const value = this.view.getFloat64(this.offset, false)
    this.offset += 8
    if (!Number.isFinite(value)) decodeFailure('number is not finite')
    return value === 0 ? 0 : value
  }

  readValue(): Value {
    const tag = this.readByte()
    switch (tag) {
      case TAG_NULL:
        return null
      case TAG_BOOL: {
        const flag = this.readByte()
        if (flag !== 0 && flag !== 1) decodeFailure('invalid boolean tag')
        return flag === 1
      }
      case TAG_NUMBER:
        return this.readNumber()
      case TAG_STRING: {
        this.offset -= 1
        return this.readString()
      }
      case TAG_BYTES: {
        const length = this.readUint32()
        return this.readBytes(length)
      }
      case TAG_LIST: {
        const count = this.readUint32()
        if (count > this.remaining) decodeFailure('list item count exceeds payload')
        const items: ScalarValue[] = []
        for (let index = 0; index < count; index++) {
          items.push(this.readScalar())
        }
        return Object.freeze(items)
      }
      default:
        return decodeFailure(`unknown value tag 0x${tag.toString(16)}`)
    }
  }

  readScalar(): ScalarValue {
    const tag = this.readByte()
    switch (tag) {
      case TAG_NULL:
        return null
      case TAG_BOOL: {
        const flag = this.readByte()
        if (flag !== 0 && flag !== 1) decodeFailure('invalid boolean tag')
        return flag === 1
      }
      case TAG_NUMBER:
        return this.readNumber()
      case TAG_STRING: {
        this.offset -= 1
        return this.readString()
      }
      case TAG_BYTES: {
        const length = this.readUint32()
        return this.readBytes(length)
      }
      default:
        return decodeFailure(`invalid scalar tag 0x${tag.toString(16)}`)
    }
  }
}

function isDecodedIdentifier(segment: string): boolean {
  return segment.length > 0 && segment.isWellFormed() && !segment.startsWith('$')
}

function readEntryPath(reader: MessageReader): Path {
  const count = reader.readUint32()
  if (count === 0) decodeFailure('entry path must not be empty')
  if (count > reader.remaining) decodeFailure('path segment count exceeds payload')
  const segments: string[] = []
  for (let index = 0; index < count; index++) segments.push(reader.readString())
  const last = segments[segments.length - 1]!
  if (last !== '$val' && last !== '$exists') decodeFailure('entry path has invalid terminator')
  if (count === 1 && last !== '$exists') {
    decodeFailure('a one-segment path must be the root $exists anchor')
  }
  for (let index = 0; index < segments.length - 1; index++) {
    if (!isDecodedIdentifier(segments[index]!)) decodeFailure('entry path has invalid identifier')
  }
  return Object.freeze(segments)
}

function childNames(path: Path, allPaths: readonly Path[]): string[] {
  const names = new Set<string>()
  for (const candidate of allPaths) {
    if (candidate.length <= path.length) continue
    let matches = true
    for (let index = 0; index < path.length; index++) {
      if (candidate[index] !== path[index]) {
        matches = false
        break
      }
    }
    if (matches) {
      const name = candidate[path.length]!
      if (name !== '$exists') names.add(name)
    }
  }
  return [...names].sort((a, b) => comparePaths([a], [b]))
}

function nodeIsPresent(
  schema: MessageSchemaNode,
  path: Path,
  entries: ReadonlyMap<string, Value>,
): boolean {
  if (schema.nodeKind === 'leaf') return entries.has(encodePathKey([...path, '$val']))
  return entries.get(encodePathKey([...path, '$exists'])) === true
}

function takeEntry(
  path: Path,
  entries: ReadonlyMap<string, Value>,
  consumed: Set<string>,
): Value | undefined {
  const key = encodePathKey(path)
  if (!entries.has(key)) return undefined
  consumed.add(key)
  return entries.get(key)
}

function checkLeafValue(kind: LeafValueKind, value: unknown, path: Path): unknown {
  try {
    return cloneLeafValue(kind, value, path)
  } catch (error) {
    if (error instanceof SchemaFailure) {
      decodeFailure(`invalid ${kind} value at ${JSON.stringify(path)}: ${error.message}`)
    }
    throw error
  }
}

function decodePresentNode(
  schema: MessageSchemaNode,
  path: Path,
  entries: ReadonlyMap<string, Value>,
  consumed: Set<string>,
  allPaths: readonly Path[],
): unknown {
  switch (schema.nodeKind) {
    case 'leaf': {
      const value = takeEntry([...path, '$val'], entries, consumed)
      if (value === undefined) decodeFailure(`missing leaf value at ${JSON.stringify(path)}`)
      return checkLeafValue(schema.valueKind, value, path)
    }
    case 'struct': {
      if (takeEntry([...path, '$exists'], entries, consumed) !== true) {
        decodeFailure(`missing container anchor at ${JSON.stringify(path)}`)
      }
      const out: Record<string, unknown> = Object.create(null)
      for (const [key, child] of Object.entries(schema.fields)) {
        if (!nodeIsPresent(child, [...path, key], entries)) {
          if (child.presence.mode === 'optional') {
            out[key] = NONE
            continue
          }
          decodeFailure(`missing ${child.presence.mode} field at ${JSON.stringify([...path, key])}`)
        }
        const value = decodePresentNode(child, [...path, key], entries, consumed, allPaths)
        out[key] = child.presence.mode === 'optional' ? some(value) : value
      }
      return Object.freeze(out)
    }
    case 'map': {
      if (takeEntry([...path, '$exists'], entries, consumed) !== true) {
        decodeFailure(`missing container anchor at ${JSON.stringify(path)}`)
      }
      const out: Record<string, unknown> = Object.create(null)
      for (const name of childNames(path, allPaths)) {
        if (!isDecodedIdentifier(name)) decodeFailure('map entry key is not a valid identifier')
        out[name] = decodePresentNode(
          schema.valueSchema,
          [...path, name],
          entries,
          consumed,
          allPaths,
        )
      }
      return Object.freeze(out)
    }
  }
}

/** Strict decode; validates the header, canonical ordering and full schema coverage. */
export function decodeMessage(
  bytes: Uint8Array,
  schemaLookup: (kind: string) => MessageStructSchemaNode | undefined,
): TypedCommitMessage {
  if (!(bytes instanceof Uint8Array)) {
    throw new SchemaFailure({
      kind: 'message_decode_error',
      commitId: EMPTY_COMMIT_ID,
      reason: 'message payload must be a Uint8Array',
    })
  }
  const reader = new MessageReader(bytes)
  if (reader.readByte() !== 0x00) decodeFailure('invalid header prefix')
  for (const expected of HEADER_PREFIX) {
    if (reader.readByte() !== expected) decodeFailure('invalid header prefix')
  }
  if (reader.readString() !== PROTOCOL_DOMAIN) decodeFailure('unsupported message protocol')
  const kind = reader.readString()
  const schema = schemaLookup(kind)
  if (schema === undefined) decodeFailure(`unknown message kind ${JSON.stringify(kind)}`)
  validateMessageSchema(schema)

  const count = reader.readUint32()
  if (count > reader.remaining) decodeFailure('entry count exceeds payload')
  const entries = new Map<string, Value>()
  const allPaths: Path[] = []
  let previous: Path | undefined
  for (let index = 0; index < count; index++) {
    const path = readEntryPath(reader)
    const value = reader.readValue()
    if (previous !== undefined && comparePaths(previous, path) >= 0) {
      decodeFailure('entries are not in canonical order')
    }
    const key = encodePathKey(path)
    if (entries.has(key)) decodeFailure('duplicate entry path')
    entries.set(key, value)
    allPaths.push(path)
    previous = path
  }
  if (reader.remaining !== 0) decodeFailure('trailing bytes after message entries')

  const consumed = new Set<string>()
  const data = decodePresentNode(schema, [], entries, consumed, allPaths)
  if (consumed.size !== entries.size) decodeFailure('message contains entries outside its schema')
  return Object.freeze({ kind, data })
}

/* -------------------------------------------------------------------------- */
/*                                MessagePrism                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a validated message prism. Rejects `ref` leaves, `allowCustom` structs
 * and invalid identifiers at runtime in addition to the compile-time types.
 */
export function makeMessagePrism<TKind extends string, TSchema extends MessageStructSchemaNode>(
  kind: TKind,
  schema: SchemaNodeOf<TSchema>,
): MessagePrism<TKind, TSchema> {
  assertIdentifier(kind)
  // Callers pass a cloned AST; cloneSchema preserves the message struct root.
  const messageSchema = schema as unknown as MessageStructSchemaNode
  validateMessageSchema(messageSchema)

  const prism: MessagePrism<TKind, TSchema> = {
    kind,
    schema,
    create(input: InferCoreInput<TSchema>): TypedCommitMessage<TKind, InferCoreOutput<TSchema>> {
      const { output } = buildMessage(messageSchema, input)
      return Object.freeze({ kind, data: output as InferCoreOutput<TSchema> })
    },
    parse(raw: TypedCommitMessage): Result<Option<InferCoreOutput<TSchema>>, SchemaError> {
      try {
        if (!isPlainRecord(raw)) {
          throw new SchemaFailure({
            kind: 'message_decode_error',
            commitId: EMPTY_COMMIT_ID,
            reason: 'decoded message must be an object',
          })
        }
        if (typeof raw.kind !== 'string') {
          throw new SchemaFailure({
            kind: 'message_decode_error',
            commitId: EMPTY_COMMIT_ID,
            reason: 'decoded message kind must be a string',
          })
        }
        if (raw.kind !== kind) return ok(NONE as Option<InferCoreOutput<TSchema>>)
        const { output } = buildMessage(messageSchema, raw.data)
        return ok(some(output as InferCoreOutput<TSchema>))
      } catch (error) {
        if (error instanceof SchemaFailure) return err(error.error)
        throw error
      }
    },
  }
  return Object.freeze(prism)
}
