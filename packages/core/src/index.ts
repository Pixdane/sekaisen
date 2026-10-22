import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/* -------------------------------------------------------------------------- */
/*                              Option<T>                                    */
/* -------------------------------------------------------------------------- */

/**
 * Non-exported nominal marker carried by every real {@link Option} value.
 * It is installed as a non-enumerable own symbol, so user data shaped like
 * `{ kind: 'none' }` or `{ kind: 'some', value }` never becomes an `Option`.
 */
const OPTION_MARKER: unique symbol = Symbol('sekaisen.option')

/** Present variant of {@link Option}. */
export interface Some<T> {
  readonly kind: 'some'
  readonly value: T
  readonly [OPTION_MARKER]: true
}

function markOption<T extends object>(value: T): T & { readonly [OPTION_MARKER]: true } {
  Object.defineProperty(value, OPTION_MARKER, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.freeze(value) as T & { readonly [OPTION_MARKER]: true }
}

/** Frozen singleton representing an absent {@link Option} value. */
export const NONE = markOption({ kind: 'none' } as const)
/** Type of the absent {@link NONE} singleton. */
export type None = typeof NONE

/** Explicit optional container (`Some<T> | None`) that avoids bare `undefined` returns. */
export type Option<T> = Some<T> | None

/** Wrap `value` in a frozen {@link Some} container. */
export function some<T>(value: T): Some<T> {
  return markOption({ kind: 'some' as const, value })
}

/**
 * Runtime check for a genuine {@link Option} created by {@link some} or
 * {@link NONE}. Same-shaped business data is rejected.
 */
export function isOption(value: unknown): value is Option<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, OPTION_MARKER) &&
    Reflect.get(value, OPTION_MARKER) === true
  )
}

/** Type guard that narrows an {@link Option} to {@link Some}. */
export function isSome<T>(opt: Option<T>): opt is Some<T> {
  return opt.kind === 'some'
}

/** Type guard that narrows an {@link Option} to {@link None}. */
export function isNone<T>(opt: Option<T>): opt is None {
  return opt.kind === 'none'
}

/** Transform the inner value of an {@link Option} when present, or propagate {@link NONE}. */
export function mapOption<T, U>(opt: Option<T>, fn: (val: T) => U): Option<U> {
  return opt.kind === 'some' ? some(fn(opt.value)) : NONE
}

/** Monadic bind (`flatMap`) over an {@link Option}. */
export function andThenOption<T, U>(opt: Option<T>, fn: (val: T) => Option<U>): Option<U> {
  return opt.kind === 'some' ? fn(opt.value) : NONE
}

/** Unwrap a present {@link Option} value or return `fallback` when {@link NONE}. */
export function unwrapOr<T>(opt: Option<T>, fallback: T): T {
  return opt.kind === 'some' ? opt.value : fallback
}

/* -------------------------------------------------------------------------- */
/*                              Result<T, E>                                 */
/* -------------------------------------------------------------------------- */

/** Successful variant of {@link Result}. */
export interface Ok<T> {
  readonly ok: true
  readonly value: T
}

/** Controlled failure variant of {@link Result}. */
export interface Err<E> {
  readonly ok: false
  readonly error: E
}

/** Controlled outcome container (`Ok<T> | Err<E>`) for expected operational failures. */
export type Result<T, E> = Ok<T> | Err<E>

/** Construct a frozen {@link Ok} result. */
export function ok<T>(value: T): Ok<T> {
  return Object.freeze({ ok: true, value })
}

/** Construct a frozen {@link Err} result. */
export function err<E>(error: E): Err<E> {
  return Object.freeze({ ok: false, error })
}

/* -------------------------------------------------------------------------- */
/*                                  Brand                                    */
/* -------------------------------------------------------------------------- */

/** Nominal type marker (newtype pattern) that keeps same-shaped values apart. */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/* -------------------------------------------------------------------------- */
/*                             InvariantError                                */
/* -------------------------------------------------------------------------- */

/**
 * Thrown whenever an internal invariant is violated (program defect, corrupted
 * persisted state, index/record disagreement). This is deliberately not part
 * of the expected-failure `Result` channel.
 */
export class InvariantError extends Error {
  override readonly name = 'InvariantError'
}

/* -------------------------------------------------------------------------- */
/*                         UTF-8 and byte helpers                            */
/* -------------------------------------------------------------------------- */

const utf8Encoder = new TextEncoder()

function assertWellFormed(value: string): void {
  if (!value.isWellFormed()) {
    throw new TypeError('string contains lone UTF-16 surrogate code units')
  }
}

/** Unsigned byte-wise lexicographic comparison of two byte arrays. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength)
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return a.byteLength - b.byteLength
}

/**
 * Compare two well-formed strings by their UTF-8 byte sequences.
 *
 * This is not always the same order as JavaScript's default UTF-16 code-unit
 * comparison: `U+10000` sorts after `U+E000` in UTF-8 but before it in UTF-16.
 */
export function compareUtf8(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new TypeError('compareUtf8 expects two strings')
  }
  assertWellFormed(a)
  assertWellFormed(b)
  return compareBytes(utf8Encoder.encode(a), utf8Encoder.encode(b))
}

/* -------------------------------------------------------------------------- */
/*                              BinaryHasher                                 */
/* -------------------------------------------------------------------------- */

const HEADER_PREFIX = new Uint8Array([
  0x53, 0x45, 0x4b, 0x41, 0x49, 0x53, 0x45, 0x4e, 0x5f, 0x56, 0x31, 0x3a,
]) // ASCII "SEKAISEN_V1:"

/**
 * Deterministic, domain-separated incremental SHA-256 writer.
 *
 * Every write method returns `this`, so calls can be chained:
 * `new BinaryHasher('COMMIT').writeNull().writeString('x').digestHex()`.
 * Once {@link digest} or {@link digestHex} has been called the hasher is
 * finalized and further writes throw.
 */
export class BinaryHasher {
  readonly #hash = sha256.create()
  readonly #scratch = new Uint8Array(8)
  readonly #scratchView = new DataView(this.#scratch.buffer)
  readonly #tagBytes = this.#scratch.subarray(0, 1)
  readonly #uint32Bytes = this.#scratch.subarray(0, 4)
  #digest: Uint8Array | null = null

  /** When `domain` is supplied, the protocol header is written immediately. */
  constructor(domain?: string) {
    if (domain !== undefined) this.writeHeader(domain)
  }

  #assertWritable(): void {
    if (this.#digest !== null) {
      throw new InvariantError('BinaryHasher has already been finalized')
    }
  }

  #writeRaw(bytes: Uint8Array): void {
    this.#assertWritable()
    this.#hash.update(bytes)
  }

  /** Write the protocol header (`0x00` + `"SEKAISEN_V1:"` + length-prefixed `domain`). */
  writeHeader(domain: string): this {
    if (typeof domain !== 'string') {
      throw new TypeError('writeHeader expects a string domain')
    }
    assertWellFormed(domain)
    this.writeByte(0x00)
    this.#writeRaw(HEADER_PREFIX)
    this.writeString(domain)
    return this
  }

  /** Encode a `null` scalar (`0x01`). */
  writeNull(): this {
    this.writeByte(0x01)
    return this
  }

  /** Encode a `boolean` scalar (`0x02` + `0x00 | 0x01`). */
  writeBool(value: boolean): this {
    if (typeof value !== 'boolean') {
      throw new TypeError('writeBool expects a boolean')
    }
    this.writeByte(0x02)
    this.writeByte(value ? 0x01 : 0x00)
    return this
  }

  /** Encode a finite IEEE 754 `number` (`0x03` + `Float64BE`, normalizing `-0` to `+0`). */
  writeNumber(value: number): this {
    if (typeof value !== 'number') {
      throw new TypeError('writeNumber expects a number')
    }
    if (!Number.isFinite(value)) {
      throw new RangeError('writeNumber rejects NaN and non-finite numbers')
    }
    // Normalize -0 to +0 so both hash to the same canonical bytes.
    const normalized = value === 0 ? 0 : value
    this.writeByte(0x03)
    this.#scratchView.setFloat64(0, normalized, false)
    this.#writeRaw(this.#scratch)
    return this
  }

  /** Encode a well-formed Unicode string (`0x04` + `Uint32BE(utf8ByteLength)` + UTF-8 bytes). */
  writeString(value: string): this {
    if (typeof value !== 'string') {
      throw new TypeError('writeString expects a string')
    }
    assertWellFormed(value)
    const bytes = utf8Encoder.encode(value)
    this.writeByte(0x04)
    this.writeUint32BE(bytes.byteLength)
    this.#writeRaw(bytes)
    return this
  }

  /** Encode a byte array (`0x05` + `Uint32BE(byteLength)` + raw bytes). */
  writeBytes(value: Uint8Array): this {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError('writeBytes expects a Uint8Array')
    }
    this.writeByte(0x05)
    this.writeUint32BE(value.byteLength)
    this.#writeRaw(value)
    return this
  }

  /** Write a single unsigned tag byte (`0x00..0xFF`). */
  writeByte(tag: number): this {
    if (typeof tag !== 'number' || !Number.isInteger(tag)) {
      throw new TypeError('writeByte expects an integer tag')
    }
    if (tag < 0 || tag > 0xff) {
      throw new RangeError('writeByte tag must be within 0x00..0xFF')
    }
    this.#tagBytes[0] = tag
    this.#writeRaw(this.#tagBytes)
    return this
  }

  /** Write a 4-byte unsigned big-endian integer count (`0..0xFFFFFFFF`). */
  writeUint32BE(count: number): this {
    if (typeof count !== 'number' || !Number.isInteger(count)) {
      throw new TypeError('writeUint32BE expects an integer count')
    }
    if (count < 0 || count > 0xffffffff) {
      throw new RangeError('writeUint32BE count must be within 0..0xFFFFFFFF')
    }
    this.#scratchView.setUint32(0, count, false)
    this.#writeRaw(this.#uint32Bytes)
    return this
  }

  /** Finalize and return an independent copy of the 32-byte digest. */
  digest(): Uint8Array {
    let digest = this.#digest
    if (digest === null) {
      digest = this.#hash.digest()
      this.#digest = digest
    }
    return new Uint8Array(digest)
  }

  /** Finalize and return the lowercase hexadecimal digest. */
  digestHex(): string {
    let digest = this.#digest
    if (digest === null) {
      digest = this.#hash.digest()
      this.#digest = digest
    }
    return bytesToHex(digest)
  }
}
