import { describe, expect, test } from 'bun:test'
import { InvariantError, NONE, some } from '../packages/core/src/index.ts'
import {
  applyRemapPolicy,
  cloneDiff,
  cloneEntry,
  cloneRef,
  cloneValue,
  comparePaths,
  decodePathKey,
  decodeStoredValue,
  encodePathKey,
  encodeStoredValue,
  hashCommit,
  leafEntryEquals,
  type StoredValueEncoding,
  utf8Decoder,
  utf8Encoder,
  validatePath,
  valueEquals,
} from '../packages/plugin-world/src/codec.ts'
import type {
  CommitHash,
  DiffOp,
  LeafEntry,
  Path,
  RemapRefsPolicy,
  StateDiff,
  StateRef,
  Value,
  WorldError,
} from '../packages/plugin-world/src/types.ts'

function captureWorldError(run: () => unknown): WorldError {
  try {
    run()
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('worldError' in error)) {
      throw error
    }
    return error.worldError as WorldError
  }
  throw new Error('expected the callback to throw a world error')
}

const OLD_HASH = 'old-hash' as CommitHash
const NEW_HASH = 'new-hash' as CommitHash
const OTHER_HASH = 'other-hash' as CommitHash

/** Model the value SQLite hands back after encodeStoredValue was written. */
function sqliteRaw(encoded: StoredValueEncoding): unknown {
  if (encoded.type !== 3) return encoded.raw
  if (!(encoded.raw instanceof Uint8Array)) throw new Error('expected encoded string bytes')
  return utf8Decoder.decode(encoded.raw)
}

describe('validatePath', () => {
  test('allows the empty root path by default', () => {
    expect(() => validatePath([])).not.toThrow()
    expect(() => validatePath([], false)).toThrow(TypeError)
  })

  test('rejects empty, non-string and malformed segments', () => {
    expect(() => validatePath([''])).toThrow(TypeError)
    expect(() => validatePath([1] as unknown as Path)).toThrow(TypeError)
    expect(() => validatePath(['\uD800'])).toThrow(TypeError)
  })

  test('accepts BOM, NUL and astral segments', () => {
    expect(() => validatePath(['\uFEFF', '\0', '\u{10000}'])).not.toThrow()
  })
})

describe('encodePathKey / decodePathKey', () => {
  test('encodes roots and byte-length prefixes exactly', () => {
    expect(encodePathKey([])).toBe('')
    expect(encodePathKey(['a:b', 'c'])).toBe('3:a:b1:c')
    expect(encodePathKey(['\uFEFF'])).toBe('3:\uFEFF')
    expect(encodePathKey(['\u{1F600}'])).toBe('4:\u{1F600}')
    expect(encodePathKey(['\0'])).toBe('1:\0')
  })

  test('round-trips colons, BOM, NUL and astral characters', () => {
    const paths: Path[] = [
      [],
      ['a:b', 'c'],
      ['\uFEFF'],
      ['\u{1F600}'],
      ['a', '1:b', '\0'],
      ['x', 'y', 'z'],
    ]
    for (const path of paths) {
      expect(decodePathKey(encodePathKey(path))).toEqual(path)
    }
    expect(Object.isFrozen(decodePathKey(''))).toBe(true)
  })

  test('rejects non-canonical and truncated keys', () => {
    const invalid = [
      '1',
      ':',
      '0:',
      '01:a',
      '1:é',
      '2:a',
      '3:a',
      '2:\u{1F600}',
      '1:\uFEFF',
      ' 1:a',
      '99999999999999999999:a',
      '1:a2:b',
    ]
    for (const key of invalid) {
      expect(() => decodePathKey(key)).toThrow(TypeError)
    }
    expect(() => decodePathKey('1:\uD800')).toThrow(TypeError)
    expect(decodePathKey('2:é')).toEqual(['é'])
    expect(decodePathKey('1:a1:b')).toEqual(['a', 'b'])
  })
})

describe('comparePaths', () => {
  test('orders by UTF-8 bytes per segment then segment count', () => {
    expect(comparePaths([], ['a'])).toBeLessThan(0)
    expect(comparePaths(['a'], ['a', 'b'])).toBeLessThan(0)
    expect(comparePaths(['a'], ['a'])).toBe(0)
    expect(comparePaths(['b'], ['a'])).toBeGreaterThan(0)
    expect(comparePaths(['\uE000'], ['\u{10000}'])).toBeLessThan(0)
    expect(comparePaths(['\u{10000}'], ['\uE000'])).toBeGreaterThan(0)
  })
})

describe('cloneValue', () => {
  test('normalizes -0 and preserves other scalars', () => {
    expect(cloneValue(5)).toBe(5)
    expect(cloneValue('x')).toBe('x')
    expect(cloneValue('\uFEFFx')).toBe('\uFEFFx')
    expect(cloneValue(true)).toBe(true)
    expect(cloneValue(null)).toBe(null)

    const normalized = cloneValue(-0)
    expect(normalized).toBe(0)
    expect(Object.is(normalized, -0)).toBe(false)
  })

  test('copies and freezes lists without freezing byte arrays', () => {
    const bytes = new Uint8Array([1, 2])
    const value: Value = [1, 'x', bytes]
    const cloned = cloneValue(value)
    expect(cloned).not.toBe(value)
    expect(Object.isFrozen(cloned)).toBe(true)
    if (!Array.isArray(cloned)) throw new Error('expected a list')
    expect(cloned).toEqual([...value])
    expect(Object.isFrozen(cloned[2])).toBe(false)
    expect(cloned[2]).not.toBe(bytes)
  })

  test('owns byte buffers and never freezes Uint8Array', () => {
    const source = new Uint8Array([1, 2, 3])
    const cloned = cloneValue(source)
    if (!(cloned instanceof Uint8Array)) throw new Error('expected bytes')
    expect(cloned).not.toBe(source)
    expect(cloned.buffer).not.toBe(source.buffer)
    expect(Object.isFrozen(cloned)).toBe(false)
    source[0] = 9
    expect([...cloned]).toEqual([1, 2, 3])
  })

  test('rejects invalid values', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => cloneValue(bad)).toThrow(TypeError)
    }
    expect(() => cloneValue('\uD800')).toThrow(TypeError)
    expect(() => cloneValue([[1]] as unknown as Value)).toThrow(TypeError)
    expect(() => cloneValue({} as unknown as Value)).toThrow(TypeError)
    expect(() => cloneValue(undefined as unknown as Value)).toThrow(TypeError)
  })
})

describe('cloneRef / cloneEntry', () => {
  test('copies and freezes refs without sharing the path array', () => {
    const ref: StateRef = { commitId: OLD_HASH, path: ['a', 'b'] }
    const cloned = cloneRef(ref)
    expect(cloned).toEqual(ref)
    expect(cloned).not.toBe(ref)
    expect(Object.isFrozen(cloned)).toBe(true)
    expect(Object.isFrozen(cloned.path)).toBe(true)
    expect(cloned.path).not.toBe(ref.path)
  })

  test('rejects malformed refs', () => {
    expect(() => cloneRef({ commitId: '' as CommitHash, path: [] })).toThrow(TypeError)
    expect(() => cloneRef({ commitId: '\uD800' as CommitHash, path: [] })).toThrow(TypeError)
    expect(() => cloneRef({ commitId: OLD_HASH, path: [''] })).toThrow(TypeError)
  })

  test('clones value and ref entries with independent bytes', () => {
    const bytes = new Uint8Array([1, 2])
    const valueEntry: LeafEntry = { entryKind: 'val', value: bytes }
    const clonedValueEntry = cloneEntry(valueEntry)
    expect(clonedValueEntry).not.toBe(valueEntry)
    expect(Object.isFrozen(clonedValueEntry)).toBe(true)
    if (clonedValueEntry.entryKind !== 'val') throw new Error('expected a value entry')
    if (!(clonedValueEntry.value instanceof Uint8Array)) throw new Error('expected bytes')
    bytes[0] = 9
    expect([...clonedValueEntry.value]).toEqual([1, 2])

    const ref: StateRef = { commitId: OLD_HASH, path: ['a'] }
    const refEntry: LeafEntry = { entryKind: 'ref', ref }
    const clonedRefEntry = cloneEntry(refEntry)
    expect(Object.isFrozen(clonedRefEntry)).toBe(true)
    if (clonedRefEntry.entryKind !== 'ref') throw new Error('expected a ref entry')
    expect(clonedRefEntry.ref).toEqual(ref)
    expect(clonedRefEntry.ref).not.toBe(ref)
  })
})

describe('valueEquals / leafEntryEquals', () => {
  test('compares canonical value bytes', () => {
    expect(valueEquals(0, -0)).toBe(true)
    expect(valueEquals('\uFEFFx', 'x')).toBe(false)
    expect(valueEquals(1, '1')).toBe(false)
    expect(valueEquals(null, false)).toBe(false)
    expect(valueEquals([1, 'a'], [1, 'a'])).toBe(true)
    expect(valueEquals([1, 'a'], [1, 'b'])).toBe(false)
    expect(valueEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(valueEquals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
  })

  test('distinguishes value and ref leaves', () => {
    expect(leafEntryEquals({ entryKind: 'val', value: 1 }, { entryKind: 'val', value: 1 })).toBe(
      true,
    )
    expect(
      leafEntryEquals(
        { entryKind: 'val', value: 1 },
        { entryKind: 'ref', ref: { commitId: OLD_HASH, path: [] } },
      ),
    ).toBe(false)

    const ref: StateRef = { commitId: OLD_HASH, path: ['a'] }
    expect(
      leafEntryEquals({ entryKind: 'ref', ref }, { entryKind: 'ref', ref: cloneRef(ref) }),
    ).toBe(true)
    expect(
      leafEntryEquals(
        { entryKind: 'ref', ref },
        { entryKind: 'ref', ref: { commitId: OLD_HASH, path: ['b'] } },
      ),
    ).toBe(false)
  })
})

describe('cloneDiff', () => {
  test('sorts canonically and freezes the result', () => {
    const diff: StateDiff = [
      { op: 'set', path: ['b'], value: 2 },
      { op: 'del', path: ['a', 'x'] },
      { op: 'set', path: ['a', 'y'], value: 1 },
    ]
    const canonical = cloneDiff(diff)
    expect(canonical.map((op) => op.path)).toEqual([['a', 'x'], ['a', 'y'], ['b']])
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical[0])).toBe(true)
    expect(Object.isFrozen(canonical[0]!.path)).toBe(true)
  })

  test('allows del/write prefix pairs as atomic groups', () => {
    const leafToDir = cloneDiff([
      { op: 'set', path: ['a', 'x'], value: 2 },
      { op: 'del', path: ['a'] },
    ])
    expect(leafToDir.map((op) => op.op)).toEqual(['del', 'set'])
  })

  test('rejects empty paths as invalid diffs', () => {
    expect(captureWorldError(() => cloneDiff([{ op: 'del', path: [] }]))).toEqual({
      kind: 'invalid_diff',
      path: [],
      reason: 'empty_path',
    })
  })

  test('rejects duplicate paths', () => {
    const error = captureWorldError(() =>
      cloneDiff([
        { op: 'set', path: ['a'], value: 1 },
        { op: 'set', path: ['a'], value: 2 },
      ]),
    )
    expect(error).toEqual({ kind: 'invalid_diff', path: ['a'], reason: 'duplicate_path' })
  })

  test('rejects nested del and nested write prefixes', () => {
    const nestedDel = captureWorldError(() =>
      cloneDiff([
        { op: 'del', path: ['a'] },
        { op: 'del', path: ['a', 'x'] },
      ]),
    )
    expect(nestedDel).toEqual({
      kind: 'invalid_diff',
      path: ['a'],
      reason: 'overlapping_del_prefix',
    })

    const nestedWrite = captureWorldError(() =>
      cloneDiff([
        { op: 'set', path: ['a'], value: 1 },
        { op: 'set', path: ['a', 'x'], value: 2 },
      ]),
    )
    expect(nestedWrite).toEqual({
      kind: 'invalid_diff',
      path: ['a'],
      reason: 'overlapping_write_prefix',
    })
  })

  test('reports invalid paths and values with their operation path', () => {
    const badPath = captureWorldError(() => cloneDiff([{ op: 'del', path: [''] }]))
    expect(badPath.kind).toBe('invalid_path')
    if (badPath.kind !== 'invalid_path') throw new Error('expected invalid_path')
    expect(badPath.path).toEqual([''])

    const badValue = captureWorldError(() =>
      cloneDiff([{ op: 'set', path: ['a'], value: Number.NaN }]),
    )
    expect(badValue.kind).toBe('invalid_value')
    if (badValue.kind !== 'invalid_value') throw new Error('expected invalid_value')
    expect(badValue.path).toEqual(['a'])

    const badRef = captureWorldError(() =>
      cloneDiff([{ op: 'ref', path: ['a'], ref: { commitId: '' as CommitHash, path: [] } }]),
    )
    expect(badRef.kind).toBe('invalid_value')
    if (badRef.kind !== 'invalid_value') throw new Error('expected invalid_value')
    expect(badRef.path).toEqual(['a'])
  })

  test('rejects unknown op tags', () => {
    expect(() => cloneDiff([{ op: 'nope', path: ['a'] } as unknown as DiffOp])).toThrow(TypeError)
  })
})

describe('hashCommit', () => {
  test('is deterministic and order-independent', () => {
    const diffA: StateDiff = [
      { op: 'set', path: ['b'], value: 2 },
      { op: 'set', path: ['a'], value: 1 },
    ]
    const diffB: StateDiff = [
      { op: 'set', path: ['a'], value: 1 },
      { op: 'set', path: ['b'], value: 2 },
    ]
    const hash = hashCommit(NONE, 'message', diffA)
    expect(hashCommit(NONE, 'message', diffB)).toBe(hash)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashCommit(some(OTHER_HASH), 'message', diffA)).not.toBe(hash)
    expect(hashCommit(NONE, 'other message', diffA)).not.toBe(hash)
    expect(hashCommit(NONE, 'message', [{ op: 'set', path: ['a'], value: 1 }])).not.toBe(hash)
  })

  test('normalizes -0 in messages and diff values', () => {
    const diff: StateDiff = [{ op: 'set', path: ['a'], value: 1 }]
    expect(hashCommit(NONE, -0, diff)).toBe(hashCommit(NONE, 0, diff))
    expect(hashCommit(NONE, 'm', [{ op: 'set', path: ['a'], value: -0 }])).toBe(
      hashCommit(NONE, 'm', [{ op: 'set', path: ['a'], value: 0 }]),
    )
  })

  test('validates the diff before hashing', () => {
    const error = captureWorldError(() =>
      hashCommit(NONE, 'm', [
        { op: 'set', path: ['a'], value: 1 },
        { op: 'set', path: ['a'], value: 2 },
      ]),
    )
    expect(error.kind).toBe('invalid_diff')
  })
})

describe('stored value codec', () => {
  test('encodes each type tag and round-trips', () => {
    expect(encodeStoredValue(null)).toEqual({ type: 0, raw: null })
    expect(encodeStoredValue(false)).toEqual({ type: 1, raw: 0n })
    expect(encodeStoredValue(true)).toEqual({ type: 1, raw: 1n })

    const numberValue = encodeStoredValue(-0)
    expect(numberValue.type).toBe(2)
    expect(Object.is(numberValue.raw, -0)).toBe(false)

    const stringValue = encodeStoredValue('\uFEFFx')
    expect(stringValue.type).toBe(3)
    expect(stringValue.raw).toEqual(utf8Encoder.encode('\uFEFFx'))

    expect(encodeStoredValue(new Uint8Array([1, 2])).type).toBe(4)
    expect(encodeStoredValue([1, 'a']).type).toBe(5)

    const values: Value[] = [
      null,
      false,
      true,
      0,
      -0,
      1.5,
      '',
      '\uFEFFx',
      '\u{1F600}',
      new Uint8Array([1, 2]),
      [],
      [null, true, -0, 3.25, 'é', new Uint8Array([9])],
    ]
    for (const value of values) {
      const encoded = encodeStoredValue(value)
      expect(valueEquals(value, decodeStoredValue(encoded.type, sqliteRaw(encoded)))).toBe(true)
    }
  })

  test('does not share byte buffers with callers', () => {
    const source = new Uint8Array([1, 2, 3])
    const encoded = encodeStoredValue(source)
    source[0] = 9
    expect(encoded.raw).toEqual(new Uint8Array([1, 2, 3]))

    const listEncoded = encodeStoredValue([new Uint8Array([1])])
    const raw = listEncoded.raw
    if (!(raw instanceof Uint8Array)) throw new Error('expected list bytes')
    const decoded = decodeStoredValue(5, raw)
    raw.fill(0)
    if (!Array.isArray(decoded)) throw new Error('expected decoded list')
    expect(decoded[0]).toEqual(new Uint8Array([1]))
  })

  test('checks the optional SQLite storage class', () => {
    expect(decodeStoredValue(0, null, 'null')).toBe(null)
    expect(decodeStoredValue(1, 1n, 'integer')).toBe(true)
    expect(decodeStoredValue(2, 1, 'real')).toBe(1)
    expect(decodeStoredValue(2, 1, 'integer')).toBe(1)
    expect(decodeStoredValue(3, 'x', 'text')).toBe('x')
    expect(decodeStoredValue(4, new Uint8Array([1]), 'blob')).toEqual(new Uint8Array([1]))
    expect(() => decodeStoredValue(1, 1n, 'text')).toThrow(InvariantError)
    expect(() => decodeStoredValue(3, 'x', 'blob')).toThrow(InvariantError)
  })

  test('rejects corrupt scalar rows', () => {
    expect(() => decodeStoredValue(6, null)).toThrow(InvariantError)
    expect(() => decodeStoredValue('1', 1n)).toThrow(InvariantError)
    expect(() => decodeStoredValue(0, 0n)).toThrow(InvariantError)
    expect(() => decodeStoredValue(1, 2n)).toThrow(InvariantError)
    expect(() => decodeStoredValue(1, true)).toThrow(InvariantError)
    expect(() => decodeStoredValue(2, '1')).toThrow(InvariantError)
    expect(() => decodeStoredValue(2, Number.NaN)).toThrow(InvariantError)
    expect(() => decodeStoredValue(3, utf8Encoder.encode('x'))).toThrow(InvariantError)
    expect(() => decodeStoredValue(3, '\uD800')).toThrow(InvariantError)
    expect(() => decodeStoredValue(4, 'x')).toThrow(InvariantError)
    expect(() => decodeStoredValue(5, 'x')).toThrow(InvariantError)
  })

  test('rejects corrupt list blobs', () => {
    const nan = new Uint8Array(8)
    new DataView(nan.buffer).setFloat64(0, Number.NaN, false)

    const badLists: number[][] = [
      [0x06, 0x00, 0x00], // truncated count
      [0x07, 0x00, 0x00, 0x00, 0x00], // wrong tag
      [0x06, 0x00, 0x00, 0x00, 0x01], // count without element
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00], // trailing byte
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x02, 0x02], // bad boolean
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x02], // truncated boolean
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x03, ...nan], // non-finite number
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x03, 0x00], // truncated number
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x02, 0xc3, 0x28], // invalid UTF-8
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x05, 0x61], // truncated string
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x05, 0x00, 0x00, 0x00, 0x02, 0x01], // truncated bytes
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x09], // unknown scalar tag
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x06], // nested list is forbidden
    ]
    for (const bad of badLists) {
      expect(() => decodeStoredValue(5, Uint8Array.from(bad))).toThrow(InvariantError)
    }
  })
})

describe('applyRemapPolicy', () => {
  test('returns the original ref for none', () => {
    const ref: StateRef = { commitId: OLD_HASH, path: ['a'] }
    const remapped = new Map<CommitHash, CommitHash>([[OLD_HASH, NEW_HASH]])
    expect(applyRemapPolicy(ref, 'none', remapped)).toBe(ref)
  })

  test('remaps only known ids for in_chain', () => {
    const remapped = new Map<CommitHash, CommitHash>([[OLD_HASH, NEW_HASH]])
    const known: StateRef = { commitId: OLD_HASH, path: ['a'] }
    const rewritten = applyRemapPolicy(known, 'in_chain', remapped)
    expect(rewritten).not.toBe(known)
    expect(rewritten.commitId).toBe(NEW_HASH)
    expect(rewritten.path).toEqual(['a'])
    expect(Object.isFrozen(rewritten)).toBe(true)

    const unknown: StateRef = { commitId: OTHER_HASH, path: [] }
    expect(applyRemapPolicy(unknown, 'in_chain', remapped)).toBe(unknown)
  })

  test('uses a custom policy function and validates its result', () => {
    const ref: StateRef = { commitId: OLD_HASH, path: ['a'] }
    const remapped = new Map<CommitHash, CommitHash>([[OLD_HASH, NEW_HASH]])
    const policy: RemapRefsPolicy = (input, ids) => `${input.commitId}+${ids.size}` as CommitHash
    const rewritten = applyRemapPolicy(ref, policy, remapped)
    expect(rewritten.commitId).toBe('old-hash+1' as CommitHash)
    expect(rewritten.path).toEqual(['a'])

    const invalidPolicy: RemapRefsPolicy = () => '' as CommitHash
    expect(() => applyRemapPolicy(ref, invalidPolicy, remapped)).toThrow(TypeError)
    expect(() => applyRemapPolicy(ref, 'bogus' as unknown as RemapRefsPolicy, remapped)).toThrow(
      TypeError,
    )
  })
})
