import type { Option } from '@sekaisen/core'
import { BinaryHasher, compareBytes, InvariantError } from '@sekaisen/core'
import type {
  CommitHash,
  DiffOp,
  LeafEntry,
  Path,
  RemapRefsPolicy,
  ScalarValue,
  StateDiff,
  StateRef,
  Value,
  WorldError,
} from './types.ts'

/* -------------------------------------------------------------------------- */
/*                            Shared codec helpers                           */
/* -------------------------------------------------------------------------- */

/** Shared UTF-8 encoder. */
export const utf8Encoder = new TextEncoder()

/** UTF-8 decoder that rejects malformed bytes and preserves a leading BOM. */
export const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const EMPTY_PATH: Path = Object.freeze([])

/** A `TypeError` carrying the structured world error the caller should return. */
class CodecError extends TypeError {
  readonly worldError: WorldError

  constructor(worldError: WorldError, message: string) {
    super(message)
    this.worldError = worldError
  }
}

function formatSegment(segment: unknown): string {
  if (typeof segment === 'string') return JSON.stringify(segment)
  try {
    return String(segment)
  } catch {
    return '<unprintable>'
  }
}

function formatPath(path: Path): string {
  if (!Array.isArray(path) || path.length === 0) return '<root>'
  return `[${path.map(formatSegment).join(', ')}]`
}

function failInvalidPath(path: Path, reason: string): never {
  const label = formatPath(path)
  throw new CodecError({ kind: 'invalid_path', path, reason }, `invalid path ${label}: ${reason}`)
}

function failInvalidValue(path: Path, reason: string): never {
  const label = formatPath(path)
  throw new CodecError(
    { kind: 'invalid_value', path, reason },
    `invalid value at ${label}: ${reason}`,
  )
}
function failInvalidDiff(
  path: Path,
  reason: 'duplicate_path' | 'overlapping_del_prefix' | 'overlapping_write_prefix' | 'empty_path',
  message: string,
): never {
  throw new CodecError({ kind: 'invalid_diff', path, reason }, message)
}

function isCommitHash(value: unknown): value is CommitHash {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed()
}

function isStrictPrefix(prefix: Path, path: Path): boolean {
  if (prefix.length >= path.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false
  }
  return true
}

/* -------------------------------------------------------------------------- */
/*                                  Paths                                    */
/* -------------------------------------------------------------------------- */

/** Validate every segment: non-empty, string, well-formed Unicode. */
export function validatePath(path: Path, allowEmpty = true): void {
  if (!Array.isArray(path)) {
    failInvalidPath(EMPTY_PATH, 'path must be an array')
  }
  if (path.length === 0) {
    if (!allowEmpty) {
      failInvalidPath(EMPTY_PATH, 'path must contain at least one segment')
    }
    return
  }
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]
    if (typeof segment !== 'string') {
      failInvalidPath(path, `segment ${i} must be a string`)
    }
    if (segment.length === 0) {
      failInvalidPath(path, `segment ${i} must not be empty`)
    }
    if (!segment.isWellFormed()) {
      failInvalidPath(path, `segment ${i} must be well-formed Unicode`)
    }
  }
}

/**
 * Encode a path as `<utf8ByteLength>:<segment>` for every segment.
 * The UTF-8 byte length makes the encoding injective, including colons and
 * supplementary-plane characters inside segments.
 */
export function encodePathKey(path: Path): string {
  validatePath(path)
  let key = ''
  for (const segment of path) {
    key += `${utf8Encoder.encode(segment).byteLength}:${segment}`
  }
  return key
}

/** Decode a canonical `encodePathKey` result. */
export function decodePathKey(key: string): Path {
  if (typeof key !== 'string') {
    throw new TypeError('path key must be a string')
  }
  if (!key.isWellFormed()) {
    throw new TypeError('path key must be well-formed Unicode')
  }
  if (key === '') return Object.freeze([])

  const segments: string[] = []
  let cursor = 0
  while (cursor < key.length) {
    const colon = key.indexOf(':', cursor)
    if (colon <= cursor) {
      throw new TypeError('path key is missing a byte-length prefix')
    }
    const digits = key.slice(cursor, colon)
    if (!/^(?:0|[1-9][0-9]*)$/.test(digits)) {
      throw new TypeError(`path key has a non-canonical byte-length prefix: ${digits}`)
    }
    const byteLength = Number(digits)
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
      throw new TypeError(`path key has an invalid byte-length prefix: ${digits}`)
    }

    let end = colon + 1
    let consumed = 0
    while (end < key.length && consumed < byteLength) {
      const codePoint = key.codePointAt(end)!
      const width = codePoint > 0xffff ? 4 : codePoint > 0x7ff ? 3 : codePoint > 0x7f ? 2 : 1
      consumed += width
      end += width === 4 ? 2 : 1
    }
    if (consumed !== byteLength) {
      throw new TypeError('path key segment does not match its byte-length prefix')
    }
    const segment = key.slice(colon + 1, end)
    if (utf8Encoder.encode(segment).byteLength !== byteLength) {
      throw new TypeError('path key segment does not match its byte-length prefix')
    }
    segments.push(segment)
    cursor = end
  }
  return Object.freeze(segments)
}

function compareValidatedPaths(a: Path, b: Path): number {
  const common = Math.min(a.length, b.length)
  for (let i = 0; i < common; i++) {
    const order = compareBytes(utf8Encoder.encode(a[i]!), utf8Encoder.encode(b[i]!))
    if (order !== 0) return order
  }
  return a.length - b.length
}

/** Canonical path ordering: UTF-8 byte order per segment, then segment count. */
export function comparePaths(a: Path, b: Path): number {
  validatePath(a)
  validatePath(b)
  return compareValidatedPaths(a, b)
}

/* -------------------------------------------------------------------------- */
/*                             Value / ref cloning                           */
/* -------------------------------------------------------------------------- */

function cloneScalarAt(value: unknown, path: Path): ScalarValue {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        failInvalidValue(path, 'numbers must be finite')
      }
      // Canonicalize -0 to +0.
      return value === 0 ? 0 : value
    case 'string':
      if (!value.isWellFormed()) {
        failInvalidValue(path, 'strings must be well-formed Unicode')
      }
      return value
    case 'object':
      if (value instanceof Uint8Array) {
        return new Uint8Array(value)
      }
      if (Array.isArray(value)) {
        failInvalidValue(path, 'nested scalar lists are not allowed')
      }
      break
  }
  failInvalidValue(path, `unsupported scalar type: ${typeof value}`)
}

function cloneValueAt(value: unknown, path: Path): Value {
  if (Array.isArray(value)) {
    const items: ScalarValue[] = []
    for (let i = 0; i < value.length; i++) {
      items.push(cloneScalarAt(value[i], path))
    }
    return Object.freeze(items)
  }
  return cloneScalarAt(value, path)
}

/** Validate, normalize and copy a `Value`. Throws `TypeError` on invalid input. */
export function cloneValue(value: Value): Value {
  return cloneValueAt(value, EMPTY_PATH)
}

function assertRef(ref: unknown): asserts ref is StateRef {
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    throw new TypeError('StateRef must be an object')
  }
  if (!('commitId' in ref) || !isCommitHash(ref.commitId)) {
    throw new TypeError('StateRef.commitId must be a non-empty well-formed string')
  }
  if (!('path' in ref) || !Array.isArray(ref.path)) {
    failInvalidPath(EMPTY_PATH, 'StateRef.path must be an array')
  }
  validatePath(ref.path)
}

/** Validate, copy and freeze a `StateRef`. */
export function cloneRef(ref: StateRef): StateRef {
  assertRef(ref)
  return Object.freeze({
    commitId: ref.commitId,
    path: Object.freeze([...ref.path]),
  })
}

/** Validate, copy and freeze a `LeafEntry`. */
export function cloneEntry(entry: LeafEntry): LeafEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError('LeafEntry must be an object')
  }
  if (entry.entryKind === 'val') {
    return Object.freeze({
      entryKind: 'val',
      value: cloneValueAt(entry.value, EMPTY_PATH),
    })
  }
  if (entry.entryKind === 'ref') {
    return Object.freeze({
      entryKind: 'ref',
      ref: cloneRef(entry.ref),
    })
  }
  throw new TypeError("LeafEntry.entryKind must be 'val' or 'ref'")
}

/* -------------------------------------------------------------------------- */
/*                       Canonical binary encoding sink                      */
/* -------------------------------------------------------------------------- */

interface BinarySink {
  writeNull(): void
  writeBool(value: boolean): void
  writeNumber(value: number): void
  writeString(value: string): void
  writeBytes(value: Uint8Array): void
  writeByte(tag: number): void
  writeUint32BE(count: number): void
}

const numberScratch = new Uint8Array(8)
const numberScratchView = new DataView(numberScratch.buffer)

class ByteWriter implements BinarySink {
  #buffer: Uint8Array
  #length = 0

  constructor(capacity = 64) {
    this.#buffer = new Uint8Array(capacity)
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra
    if (needed <= this.#buffer.byteLength) return
    let capacity = this.#buffer.byteLength === 0 ? 8 : this.#buffer.byteLength
    while (capacity < needed) capacity *= 2
    const next = new Uint8Array(capacity)
    next.set(this.#buffer.subarray(0, this.#length))
    this.#buffer = next
  }

  writeNull(): void {
    this.writeByte(0x01)
  }

  writeBool(value: boolean): void {
    this.writeByte(0x02)
    this.writeByte(value ? 0x01 : 0x00)
  }

  writeNumber(value: number): void {
    this.writeByte(0x03)
    numberScratchView.setFloat64(0, value === 0 ? 0 : value, false)
    this.#reserve(8)
    this.#buffer.set(numberScratch, this.#length)
    this.#length += 8
  }

  writeString(value: string): void {
    const bytes = utf8Encoder.encode(value)
    this.writeByte(0x04)
    this.writeUint32BE(bytes.byteLength)
    this.#reserve(bytes.byteLength)
    this.#buffer.set(bytes, this.#length)
    this.#length += bytes.byteLength
  }

  writeBytes(value: Uint8Array): void {
    this.writeByte(0x05)
    this.writeUint32BE(value.byteLength)
    this.#reserve(value.byteLength)
    this.#buffer.set(value, this.#length)
    this.#length += value.byteLength
  }

  writeByte(tag: number): void {
    this.#reserve(1)
    this.#buffer[this.#length] = tag
    this.#length += 1
  }

  writeUint32BE(count: number): void {
    this.#reserve(4)
    this.#buffer[this.#length] = (count >>> 24) & 0xff
    this.#buffer[this.#length + 1] = (count >>> 16) & 0xff
    this.#buffer[this.#length + 2] = (count >>> 8) & 0xff
    this.#buffer[this.#length + 3] = count & 0xff
    this.#length += 4
  }

  finish(): Uint8Array {
    return new Uint8Array(this.#buffer.subarray(0, this.#length))
  }
}

function writeScalarTo(sink: BinarySink, value: ScalarValue): void {
  if (value === null) {
    sink.writeNull()
  } else if (typeof value === 'boolean') {
    sink.writeBool(value)
  } else if (typeof value === 'number') {
    sink.writeNumber(value)
  } else if (typeof value === 'string') {
    sink.writeString(value)
  } else {
    sink.writeBytes(value)
  }
}

function isScalarList(value: Value): value is readonly ScalarValue[] {
  return Array.isArray(value)
}

function writeValueTo(sink: BinarySink, value: Value): void {
  if (isScalarList(value)) {
    sink.writeByte(0x06)
    sink.writeUint32BE(value.length)
    for (const item of value) {
      writeScalarTo(sink, item)
    }
  } else {
    writeScalarTo(sink, value)
  }
}

function writePathTo(sink: BinarySink, path: Path): void {
  sink.writeByte(0x07)
  sink.writeUint32BE(path.length)
  for (const segment of path) {
    sink.writeString(segment)
  }
}

function writeRefTo(sink: BinarySink, ref: StateRef): void {
  sink.writeByte(0x08)
  sink.writeString(ref.commitId)
  writePathTo(sink, ref.path)
}

function writeEntryTo(sink: BinarySink, entry: LeafEntry): void {
  if (entry.entryKind === 'val') {
    writeValueTo(sink, entry.value)
  } else {
    writeRefTo(sink, entry.ref)
  }
}

function encodeCanonicalValue(value: Value): Uint8Array {
  const writer = new ByteWriter()
  writeValueTo(writer, value)
  return writer.finish()
}

function encodeCanonicalEntry(entry: LeafEntry): Uint8Array {
  const writer = new ByteWriter()
  writeEntryTo(writer, entry)
  return writer.finish()
}

/** Equality is byte equality under the canonical encoding above. */
export function valueEquals(a: Value, b: Value): boolean {
  const left = cloneValue(a)
  const right = cloneValue(b)
  return compareBytes(encodeCanonicalValue(left), encodeCanonicalValue(right)) === 0
}

/** Equality of leaf entries under the canonical binary encoding. */
export function leafEntryEquals(a: LeafEntry, b: LeafEntry): boolean {
  return (
    compareBytes(encodeCanonicalEntry(cloneEntry(a)), encodeCanonicalEntry(cloneEntry(b))) === 0
  )
}

/* -------------------------------------------------------------------------- */
/*                                Canonical diff                             */
/* -------------------------------------------------------------------------- */

/**
 * Validate and canonicalize a diff.
 *
 * Enforces: non-empty paths, unique paths, no strict prefix overlap between
 * two `del`s and no strict prefix overlap between two writes. A `del` may
 * prefix a write (and vice versa); such pairs form one two-phase atomic group.
 * The returned operations are frozen and sorted by {@link comparePaths}.
 */
export function cloneDiff(diff: StateDiff): StateDiff {
  if (!Array.isArray(diff)) {
    throw new TypeError('diff must be an array')
  }

  const ops: DiffOp[] = []
  const seenPaths = new Set<string>()

  for (let index = 0; index < diff.length; index++) {
    const raw: unknown = diff[index]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError(`diff[${index}] must be a DiffOp object`)
    }
    if (!('path' in raw) || !Array.isArray(raw.path)) {
      failInvalidPath(EMPTY_PATH, `diff[${index}].path must be an array`)
    }
    const path: Path = Object.freeze([...raw.path])
    if (path.length === 0) {
      failInvalidDiff(path, 'empty_path', 'diff operation path must not be empty')
    }
    validatePath(path)

    const key = encodePathKey(path)
    if (seenPaths.has(key)) {
      failInvalidDiff(path, 'duplicate_path', `diff contains duplicate path ${formatPath(path)}`)
    }
    seenPaths.add(key)

    const op = 'op' in raw ? raw.op : undefined
    if (op === 'del') {
      ops.push(Object.freeze({ op: 'del', path }))
      continue
    }
    if (op === 'set') {
      if (!('value' in raw)) {
        failInvalidValue(path, "set operation is missing 'value'")
      }
      const value = cloneValueAt(raw.value, path)
      ops.push(Object.freeze({ op: 'set', path, value }))
      continue
    }
    if (op === 'ref') {
      const rawRef = 'ref' in raw ? raw.ref : undefined
      let ref: StateRef
      try {
        assertRef(rawRef)
        ref = cloneRef(rawRef)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'invalid StateRef'
        throw new CodecError(
          { kind: 'invalid_value', path, reason },
          `invalid ref at ${formatPath(path)}: ${reason}`,
        )
      }
      ops.push(Object.freeze({ op: 'ref', path, ref }))
      continue
    }
    throw new TypeError(`diff[${index}].op must be 'set', 'ref', or 'del'`)
  }

  for (let i = 0; i < ops.length; i++) {
    for (let j = i + 1; j < ops.length; j++) {
      const left = ops[i]!
      const right = ops[j]!
      const prefix = left.path.length <= right.path.length ? left.path : right.path
      const longer = left.path.length <= right.path.length ? right.path : left.path
      if (!isStrictPrefix(prefix, longer)) continue
      if (left.op === 'del' && right.op === 'del') {
        failInvalidDiff(
          prefix,
          'overlapping_del_prefix',
          `diff contains nested del operations at ${JSON.stringify(prefix)}`,
        )
      }
      if (left.op !== 'del' && right.op !== 'del') {
        failInvalidDiff(
          prefix,
          'overlapping_write_prefix',
          `diff contains nested write operations at ${JSON.stringify(prefix)}`,
        )
      }
    }
  }

  ops.sort((a, b) => compareValidatedPaths(a.path, b.path))
  return Object.freeze(ops)
}

/* -------------------------------------------------------------------------- */
/*                               Commit hashing                              */
/* -------------------------------------------------------------------------- */

/**
 * Compute the content-addressed commit hash:
 * `COMMIT(parentId, message, canonicalDiffOrder)`.
 */
export function hashCommit(
  parentId: Option<CommitHash>,
  message: Value,
  diff: StateDiff,
): CommitHash {
  if (typeof parentId !== 'object' || parentId === null) {
    throw new TypeError('parentId must be an Option<CommitHash>')
  }
  if (parentId.kind === 'some') {
    if (!isCommitHash(parentId.value)) {
      throw new TypeError('parentId Some value must be a non-empty well-formed CommitHash')
    }
  } else if (parentId.kind !== 'none') {
    throw new TypeError("parentId.kind must be 'some' or 'none'")
  }

  const canonicalDiff = cloneDiff(diff)
  const canonicalMessage = cloneValue(message)

  const hasher = new BinaryHasher()
  hasher.writeHeader('COMMIT')
  if (parentId.kind === 'none') {
    hasher.writeNull()
  } else {
    hasher.writeString(parentId.value)
  }
  writeValueTo(hasher, canonicalMessage)
  hasher.writeByte(0x09)
  hasher.writeUint32BE(canonicalDiff.length)
  for (const op of canonicalDiff) {
    if (op.op === 'del') {
      hasher.writeByte(0x10)
      writePathTo(hasher, op.path)
    } else if (op.op === 'set') {
      hasher.writeByte(0x11)
      writePathTo(hasher, op.path)
      writeValueTo(hasher, op.value)
    } else {
      hasher.writeByte(0x12)
      writePathTo(hasher, op.path)
      writeRefTo(hasher, op.ref)
    }
  }
  return hasher.digestHex() as CommitHash
}

/* -------------------------------------------------------------------------- */
/*                         SQLite stored-value codec                         */
/* -------------------------------------------------------------------------- */

/** Canonical SQLite representation of a world value. */
export interface StoredValueEncoding {
  readonly type: number
  readonly raw: null | bigint | number | Uint8Array
}

/**
 * Encode a value for the `msg_type` / `msg_raw` and `val_type` / `val_raw`
 * columns. Strings are returned as UTF-8 bytes so the caller can bind them
 * with `CAST(? AS TEXT)` and preserve a leading U+FEFF.
 */
export function encodeStoredValue(value: Value): StoredValueEncoding {
  const normalized = cloneValue(value)
  if (normalized === null) {
    return Object.freeze({ type: 0, raw: null })
  }
  if (typeof normalized === 'boolean') {
    return Object.freeze({ type: 1, raw: normalized ? 1n : 0n })
  }
  if (typeof normalized === 'number') {
    return Object.freeze({ type: 2, raw: normalized })
  }
  if (typeof normalized === 'string') {
    return Object.freeze({ type: 3, raw: utf8Encoder.encode(normalized) })
  }
  if (normalized instanceof Uint8Array) {
    // cloneValue already produced an independent copy.
    return Object.freeze({ type: 4, raw: normalized })
  }
  return Object.freeze({ type: 5, raw: encodeCanonicalValue(normalized) })
}

/**
 * Decode one stored value. Any shape that could not have been produced by
 * {@link encodeStoredValue} is treated as persisted corruption and raises
 * `InvariantError` instead of silently coercing.
 */
export function decodeStoredValue(type: unknown, raw: unknown, storageClass?: unknown): Value {
  if (typeof type !== 'number' || !Number.isInteger(type) || type < 0 || type > 5) {
    throw new InvariantError(`corrupted stored value: unknown type tag ${String(type)}`)
  }

  if (storageClass !== undefined) {
    if (typeof storageClass !== 'string') {
      throw new InvariantError(
        `corrupted stored value: invalid storage class ${String(storageClass)}`,
      )
    }
    const actual = storageClass.toLowerCase()
    const expected =
      type === 0
        ? 'null'
        : type === 1
          ? 'integer'
          : type === 3
            ? 'text'
            : type === 4 || type === 5
              ? 'blob'
              : null
    const matches = type === 2 ? actual === 'integer' || actual === 'real' : actual === expected
    if (!matches) {
      throw new InvariantError(
        `corrupted stored value: type ${type} cannot have storage class ${storageClass}`,
      )
    }
  }

  switch (type) {
    case 0:
      if (raw !== null) {
        throw new InvariantError('corrupted stored value: null tag requires a NULL raw value')
      }
      return null
    case 1:
      if (raw === 0 || raw === 0n) return false
      if (raw === 1 || raw === 1n) return true
      throw new InvariantError('corrupted stored value: boolean raw value must be integer 0 or 1')
    case 2:
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new InvariantError('corrupted stored value: number raw value must be finite')
      }
      return raw === 0 ? 0 : raw
    case 3:
      if (typeof raw !== 'string') {
        throw new InvariantError('corrupted stored value: string raw value must be TEXT')
      }
      if (!raw.isWellFormed()) {
        throw new InvariantError('corrupted stored value: string is not well-formed Unicode')
      }
      return raw
    case 4:
      if (!(raw instanceof Uint8Array)) {
        throw new InvariantError('corrupted stored value: bytes raw value must be a BLOB')
      }
      return new Uint8Array(raw)
    default:
      if (!(raw instanceof Uint8Array)) {
        throw new InvariantError('corrupted stored value: list raw value must be a BLOB')
      }
      return decodeScalarList(raw)
  }
}

function corrupt(message: string, cause?: unknown): never {
  if (cause === undefined) throw new InvariantError(message)
  throw new InvariantError(message, { cause })
}

function decodeScalarList(bytes: Uint8Array): Value {
  if (bytes.byteLength < 5) {
    corrupt('corrupted stored list: missing tag or element count')
  }
  if (bytes[0] !== 0x06) {
    corrupt(`corrupted stored list: expected tag 0x06, got 0x${bytes[0]!.toString(16)}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(1, false)
  const items: ScalarValue[] = []
  let cursor = 5

  for (let i = 0; i < count; i++) {
    if (cursor >= bytes.byteLength) {
      corrupt('corrupted stored list: truncated element')
    }
    const tag = bytes[cursor]!
    cursor += 1
    switch (tag) {
      case 0x01:
        items.push(null)
        break
      case 0x02: {
        if (cursor >= bytes.byteLength) {
          corrupt('corrupted stored list: truncated boolean')
        }
        const encoded = bytes[cursor]!
        cursor += 1
        if (encoded === 0x00) items.push(false)
        else if (encoded === 0x01) items.push(true)
        else corrupt(`corrupted stored list: invalid boolean byte 0x${encoded.toString(16)}`)
        break
      }
      case 0x03: {
        if (cursor + 8 > bytes.byteLength) {
          corrupt('corrupted stored list: truncated number')
        }
        const number = view.getFloat64(cursor, false)
        cursor += 8
        if (!Number.isFinite(number)) {
          corrupt('corrupted stored list: non-finite number')
        }
        items.push(number === 0 ? 0 : number)
        break
      }
      case 0x04: {
        if (cursor + 4 > bytes.byteLength) {
          corrupt('corrupted stored list: truncated string length')
        }
        const length = view.getUint32(cursor, false)
        cursor += 4
        if (length > bytes.byteLength - cursor) {
          corrupt('corrupted stored list: truncated string payload')
        }
        const payload = bytes.subarray(cursor, cursor + length)
        cursor += length
        let decoded: string
        try {
          decoded = utf8Decoder.decode(payload)
        } catch (error) {
          throw new InvariantError('corrupted stored list: invalid UTF-8 string payload', {
            cause: error,
          })
        }
        if (!decoded.isWellFormed()) {
          corrupt('corrupted stored list: string is not well-formed Unicode')
        }
        items.push(decoded)
        break
      }
      case 0x05: {
        if (cursor + 4 > bytes.byteLength) {
          corrupt('corrupted stored list: truncated bytes length')
        }
        const length = view.getUint32(cursor, false)
        cursor += 4
        if (length > bytes.byteLength - cursor) {
          corrupt('corrupted stored list: truncated bytes payload')
        }
        items.push(new Uint8Array(bytes.subarray(cursor, cursor + length)))
        cursor += length
        break
      }
      default:
        corrupt(`corrupted stored list: unknown scalar tag 0x${tag.toString(16)}`)
    }
  }

  if (cursor !== bytes.byteLength) {
    corrupt('corrupted stored list: trailing bytes after elements')
  }
  return Object.freeze(items)
}

/* -------------------------------------------------------------------------- */
/*                              Reference rewrites                           */
/* -------------------------------------------------------------------------- */

/**
 * Apply a rebase ref-remap policy to `ref`.
 * - `'none'` returns the original ref;
 * - `'in_chain'` remaps only ids present in `remappedIds`;
 * - a function returns the new commit id (the path is preserved).
 */
export function applyRemapPolicy(
  ref: StateRef,
  policy: RemapRefsPolicy,
  remappedIds: ReadonlyMap<CommitHash, CommitHash>,
): StateRef {
  assertRef(ref)
  if (
    typeof remappedIds !== 'object' ||
    remappedIds === null ||
    typeof remappedIds.has !== 'function' ||
    typeof remappedIds.get !== 'function'
  ) {
    throw new TypeError('remappedIds must be a ReadonlyMap<CommitHash, CommitHash>')
  }

  if (policy === 'none') {
    return ref
  }
  if (policy === 'in_chain') {
    if (!remappedIds.has(ref.commitId)) return ref
    const mapped = remappedIds.get(ref.commitId)
    if (!isCommitHash(mapped)) {
      throw new TypeError('remappedIds contains an invalid CommitHash')
    }
    return cloneRef({ commitId: mapped, path: ref.path })
  }
  if (typeof policy !== 'function') {
    throw new TypeError("remap policy must be 'none', 'in_chain', or a function")
  }
  const mapped = policy(ref, remappedIds)
  if (!isCommitHash(mapped)) {
    throw new TypeError('remap policy returned an invalid CommitHash')
  }
  return cloneRef({ commitId: mapped, path: ref.path })
}
