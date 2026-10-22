import { describe, expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  andThenOption,
  BinaryHasher,
  compareBytes,
  compareUtf8,
  err,
  InvariantError,
  isNone,
  isSome,
  mapOption,
  NONE,
  ok,
  some,
  unwrapOr,
} from '../packages/core/src/index.ts'

const encoder = new TextEncoder()

const HEADER = Uint8Array.from([
  0x00,
  ...encoder.encode('SEKAISEN_V1:'),
  0x04,
  0x00,
  0x00,
  0x00,
  0x06,
  ...encoder.encode('COMMIT'),
])

const expectedDigest = (bytes: readonly number[]): string =>
  bytesToHex(sha256(Uint8Array.from(bytes)))

describe('Option', () => {
  test('constructs frozen values and narrows', () => {
    expect(NONE.kind).toBe('none')
    expect(Object.isFrozen(NONE)).toBe(true)

    const value = some(3)
    expect(value.kind).toBe('some')
    expect(value.value).toBe(3)
    expect(Object.isFrozen(value)).toBe(true)
    expect(isSome(value)).toBe(true)
    expect(isNone(value)).toBe(false)
    expect(isNone(NONE)).toBe(true)
  })

  test('helpers map, chain, and unwrap', () => {
    expect(mapOption(some(2), (value) => value * 3)).toEqual(some(6))
    expect(mapOption<number, string>(NONE, String)).toBe(NONE)
    expect(andThenOption(some(2), (value) => (value > 0 ? some('positive') : NONE))).toEqual(
      some('positive'),
    )
    expect(andThenOption<number, string>(NONE, (value) => some(String(value)))).toBe(NONE)
    expect(unwrapOr(some('x'), 'fallback')).toBe('x')
    expect(unwrapOr(NONE, 'fallback')).toBe('fallback')
  })
})

describe('Result', () => {
  test('carries a value or error', () => {
    const success = ok(5)
    expect(success.ok).toBe(true)
    expect(success.value).toBe(5)
    expect(Object.isFrozen(success)).toBe(true)

    const failure = err('boom')
    expect(failure.ok).toBe(false)
    expect(failure.error).toBe('boom')
    expect(Object.isFrozen(failure)).toBe(true)
  })
})

describe('InvariantError', () => {
  test('is a named Error with cause support', () => {
    const cause = new Error('root cause')
    const error = new InvariantError('broken invariant', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(InvariantError)
    expect(error.name).toBe('InvariantError')
    expect(error.message).toBe('broken invariant')
    expect(error.cause).toBe(cause)
  })
})

describe('BinaryHasher', () => {
  test('writes the documented header and null tag', () => {
    const hasher = new BinaryHasher('COMMIT')
    expect(hasher.writeNull()).toBe(hasher)
    const expected = [...HEADER, 0x01]
    expect(hasher.digest()).toEqual(sha256(Uint8Array.from(expected)))
    expect(hasher.digestHex()).toBe(expectedDigest(expected))
  })

  test('writes every scalar tag with the documented layout', () => {
    const bytes = [
      ...HEADER,
      0x01, // null
      0x02,
      0x01, // true
      0x03,
      0x3f,
      0xf0,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // 1.0 Float64BE
      0x04,
      0x00,
      0x00,
      0x00,
      0x02,
      0xc3,
      0xa9, // "é"
      0x05,
      0x00,
      0x00,
      0x00,
      0x01,
      0xaa, // bytes [0xAA]
      0x42, // raw tag
      0x01,
      0x02,
      0x03,
      0x04, // Uint32BE 0x01020304
    ]
    const hasher = new BinaryHasher('COMMIT')
      .writeNull()
      .writeBool(true)
      .writeNumber(1)
      .writeString('é')
      .writeBytes(Uint8Array.from([0xaa]))
      .writeByte(0x42)
      .writeUint32BE(0x01020304)

    expect(hasher.digest()).toEqual(sha256(Uint8Array.from(bytes)))
    expect(hasher.digestHex()).toBe(expectedDigest(bytes))
  })

  test('is incremental and chainable', () => {
    const chained = new BinaryHasher()
      .writeHeader('COMMIT')
      .writeBool(true)
      .writeString('x')
      .digestHex()

    const incremental = new BinaryHasher()
    expect(incremental.writeHeader('COMMIT')).toBe(incremental)
    expect(incremental.writeBool(true)).toBe(incremental)
    expect(incremental.writeString('x')).toBe(incremental)
    expect(incremental.digestHex()).toBe(chained)
  })

  test('normalizes -0 and rejects non-finite numbers', () => {
    const negativeZero = new BinaryHasher().writeNumber(-0)
    const positiveZero = new BinaryHasher().writeNumber(0)
    expect(negativeZero.digestHex()).toBe(positiveZero.digestHex())
    expect(negativeZero.digestHex()).not.toBe(new BinaryHasher().writeNumber(1).digestHex())

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => new BinaryHasher().writeNumber(value)).toThrow(RangeError)
    }
  })

  test('preserves leading BOM and supplementary-plane strings', () => {
    const bom = '\uFEFFx'
    const withBom = [...HEADER, 0x04, 0x00, 0x00, 0x00, 0x04, 0xef, 0xbb, 0xbf, 0x78]
    expect(new BinaryHasher('COMMIT').writeString(bom).digestHex()).toBe(expectedDigest(withBom))

    const astral = '\u{1F600}'
    const astralBytes = [...HEADER, 0x04, 0x00, 0x00, 0x00, 0x04, 0xf0, 0x9f, 0x98, 0x80]
    expect(new BinaryHasher('COMMIT').writeString(astral).digestHex()).toBe(
      expectedDigest(astralBytes),
    )
    expect(new BinaryHasher('COMMIT').writeString(bom).digestHex()).not.toBe(
      new BinaryHasher('COMMIT').writeString('x').digestHex(),
    )
  })

  test('rejects malformed strings and invalid tags/counts', () => {
    expect(() => new BinaryHasher().writeString('\uD800')).toThrow(TypeError)
    expect(() => new BinaryHasher().writeHeader('\uD800')).toThrow(TypeError)
    expect(() => new BinaryHasher().writeByte(-1)).toThrow(RangeError)
    expect(() => new BinaryHasher().writeByte(0x100)).toThrow(RangeError)
    expect(() => new BinaryHasher().writeByte(1.5)).toThrow(TypeError)
    expect(() => new BinaryHasher().writeUint32BE(-1)).toThrow(RangeError)
    expect(() => new BinaryHasher().writeUint32BE(0x1_0000_0000)).toThrow(RangeError)
    expect(() => new BinaryHasher().writeUint32BE(1.5)).toThrow(TypeError)
    expect(() => new BinaryHasher().writeBool(1 as unknown as boolean)).toThrow(TypeError)
    expect(() => new BinaryHasher().writeBytes([1] as unknown as Uint8Array)).toThrow(TypeError)
  })

  test('digest returns an independent copy and finalizes the hasher', () => {
    const hasher = new BinaryHasher().writeNull()
    const first = hasher.digest()
    const expected = new Uint8Array(first)
    first.fill(0)
    expect(hasher.digest()).toEqual(expected)
    expect(hasher.digestHex()).toBe(bytesToHex(expected))
    expect(() => hasher.writeNull()).toThrow(InvariantError)
  })
})

describe('byte ordering helpers', () => {
  test('compareBytes compares unsigned bytes then length', () => {
    expect(compareBytes(Uint8Array.from([0]), Uint8Array.from([1]))).toBeLessThan(0)
    expect(compareBytes(Uint8Array.from([255]), Uint8Array.from([0]))).toBeGreaterThan(0)
    expect(compareBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 0]))).toBeLessThan(0)
    expect(compareBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(0)
  })

  test('compareUtf8 orders by UTF-8 bytes, not UTF-16 code units', () => {
    // U+E000 sorts before U+10000 in UTF-8, but after it in UTF-16.
    expect(compareUtf8('\uE000', '\u{10000}')).toBeLessThan(0)
    expect('\u{10000}' < '\uE000').toBe(true)
    expect(compareUtf8('a', 'a')).toBe(0)
    expect(compareUtf8('a', 'ab')).toBeLessThan(0)
    expect(compareUtf8('😀', '\uE000')).toBeGreaterThan(0)
    expect(() => compareUtf8('\uD800', 'x')).toThrow(TypeError)
  })
})
