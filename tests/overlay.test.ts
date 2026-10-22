import { afterEach, describe, expect, test } from 'bun:test'
import { compareUtf8, NONE, some } from '@sekaisen/core'
import type {
  CommitHash,
  CommitNode,
  LeafEntry,
  Path,
  SqliteDriver,
  StateDiff,
  TreeNodeView,
  Value,
  WorldError,
} from '@sekaisen/plugin-world'
import {
  comparePaths,
  decodePathKey,
  encodePathKey,
  leafEntryEquals,
  WorldService,
} from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'
import { DraftOverlay } from '../packages/plugin-schema/src/overlay.ts'
import type { StateReader } from '../packages/plugin-schema/src/runtime.ts'
import { WorldStateReader } from '../packages/plugin-schema/src/world-reader.ts'

/* -------------------------------------------------------------------------- */
/*                                   Fixtures                                 */
/* -------------------------------------------------------------------------- */

const openDrivers: SqliteDriver[] = []

afterEach(() => {
  for (const driver of openDrivers.splice(0)) driver.close()
})

function setupWorld(): WorldService {
  const driver = createBunSqliteDriver()
  openDrivers.push(driver)
  return new WorldService(new Context(), { driver })
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: WorldError }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function commit(world: WorldService, parent: CommitNode | null, diff: StateDiff): CommitNode {
  return unwrap(world.commit({ parentId: parent ? some(parent.id) : NONE, diff, message: null }))
}

function valueEntry(value: Value): LeafEntry {
  return { entryKind: 'val', value }
}

function snapshot(world: WorldService, id: CommitHash): Map<string, LeafEntry> {
  const result = new Map<string, LeafEntry>()
  const view = unwrap(world.getNode(id))
  if (view.kind === 'none') return result
  const stack: { path: Path; node: TreeNodeView }[] = [{ path: [], node: view.value }]
  while (stack.length > 0) {
    const current = stack.pop()!
    const node = current.node
    if (node.nodeKind === 'leaf') {
      result.set(encodePathKey(current.path), node.entry)
      continue
    }
    for (const [key, child] of node.entries)
      stack.push({ path: [...current.path, key], node: child })
  }
  return result
}

function applyOverlay(
  world: WorldService,
  parent: CommitNode,
  overlay: DraftOverlay,
): { node: CommitNode; diff: StateDiff } {
  const diff = overlay.compileDiff()
  return { node: commit(world, parent, diff), diff }
}

function expectSnapshot(actual: Map<string, LeafEntry>, expected: Map<string, LeafEntry>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
  for (const [key, entry] of actual) {
    const other = expected.get(key)
    if (other === undefined) throw new Error(`unexpected world leaf ${key}`)
    expect(leafEntryEquals(entry, other)).toBe(true)
  }
}

/* -------------------------------------------------------------------------- */
/*                        Independent flat-state oracle                       */
/* -------------------------------------------------------------------------- */

type Model = Map<string, LeafEntry>

function modelSet(model: Model, path: Path, entry: LeafEntry): void {
  model.set(encodePathKey(path), entry)
}

function modelDelete(model: Model, path: Path): void {
  const prefix = encodePathKey(path)
  for (const key of [...model.keys()]) if (key.startsWith(prefix)) model.delete(key)
}

function modelChildKeys(model: Model, path: Path): string[] {
  const prefix = encodePathKey(path)
  const names = new Set<string>()
  for (const key of model.keys()) {
    if (key !== prefix && key.startsWith(prefix))
      names.add(decodePathKey(key.slice(prefix.length))[0]!)
  }
  return [...names].sort(compareUtf8)
}

function rememberPaths(seen: Map<string, Path>, path: Path): void {
  for (let len = 0; len <= path.length; len++) {
    const prefix = path.slice(0, len)
    seen.set(encodePathKey(prefix), prefix)
  }
}

function expectReadsMatchModel(overlay: DraftOverlay, model: Model, paths: Iterable<Path>): void {
  for (const path of paths) {
    const expected = model.get(encodePathKey(path))
    const actual = overlay.getEntry(path)
    expect(actual === undefined).toBe(expected === undefined)
    if (actual !== undefined && expected !== undefined)
      expect(leafEntryEquals(actual, expected)).toBe(true)
    expect(overlay.hasEntry(path)).toBe(expected !== undefined)
    expect(overlay.childKeys(path)).toEqual(modelChildKeys(model, path))
  }
}

/* -------------------------------------------------------------------------- */
/*                              Reads and overlays                            */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay reads', () => {
  test('merges immutable base leaves with dirty writes and tombstones', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['data', 'a'], value: 1 },
      { op: 'set', path: ['data', 'b'], value: new Uint8Array([1, 2]) },
      { op: 'set', path: ['data', 'c'], value: 'old' },
      { op: 'set', path: ['data', 'nested', 'leaf'], value: true },
    ])
    const baseSnapshot = snapshot(world, base.id)
    const reader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(reader)

    overlay.setEntry(['data', 'a'], valueEntry(2))
    overlay.deleteTree(['data', 'c'])
    overlay.setEntry(['fresh', 'd'], valueEntry('new'))

    expect(overlay.getEntry(['data', 'a'])).toEqual(valueEntry(2))
    expect(overlay.getEntry(['data', 'c'])).toBeUndefined()
    expect(overlay.hasEntry(['data', 'c'])).toBe(false)
    expect(overlay.childKeys(['data'])).toEqual(['a', 'b', 'nested'])
    expect(overlay.childKeys(['data', 'a'])).toEqual([])
    expect(overlay.childKeys(['fresh'])).toEqual(['d'])
    expect(overlay.childKeys(['missing'])).toEqual([])
    expect(overlay.getEntry(['missing'])).toBeUndefined()
    expect(overlay.hasEntry(['missing'])).toBe(false)
    const bytes = overlay.getEntry(['data', 'b'])
    expect(
      bytes?.entryKind === 'val' && leafEntryEquals(bytes, valueEntry(new Uint8Array([1, 2]))),
    ).toBe(true)

    // The base World reader is immutable for the overlay lifetime.
    expectSnapshot(snapshot(world, base.id), baseSnapshot)
    expect(overlay.childKeys([])).toEqual(['data', 'fresh'])

    const applied = applyOverlay(world, base, overlay)
    const finalSnapshot = snapshot(world, applied.node.id)
    expectSnapshot(
      finalSnapshot,
      new Map([
        [encodePathKey(['data', 'a']), valueEntry(2)],
        [encodePathKey(['data', 'b']), valueEntry(new Uint8Array([1, 2]))],
        [encodePathKey(['data', 'nested', 'leaf']), valueEntry(true)],
        [encodePathKey(['fresh', 'd']), valueEntry('new')],
      ]),
    )
    expect(finalSnapshot.has(encodePathKey(['data', 'c']))).toBe(false)
  })

  test('treats leaves as childless and absent paths as empty', () => {
    const overlay = new DraftOverlay()
    expect(overlay.childKeys([])).toEqual([])
    overlay.setEntry(['dir', 'leaf'], valueEntry(1))
    expect(overlay.getEntry(['dir'])).toBeUndefined()
    expect(overlay.hasEntry(['dir'])).toBe(false)
    expect(overlay.childKeys(['dir'])).toEqual(['leaf'])
    expect(overlay.childKeys(['dir', 'leaf'])).toEqual([])
    overlay.deleteTree(['dir', 'leaf'])
    expect(overlay.childKeys(['dir'])).toEqual([])
    expect(overlay.childKeys([])).toEqual([])
  })

  test('rejects root writes and malformed paths before mutating the draft', () => {
    const overlay = new DraftOverlay()
    expect(() => overlay.setEntry([], valueEntry(1))).toThrow()
    expect(() => overlay.setEntry([''], valueEntry(1))).toThrow()
    expect(() => overlay.setEntry(['bad', 'leaf'], valueEntry(Number.NaN))).toThrow()
    expect(overlay.childKeys([])).toEqual([])
    expect(overlay.hasEntry(['bad'])).toBe(false)
    overlay.deleteTree([])
    expect(overlay.compileDiff()).toEqual([])
  })

  test('prunes directories when their last leaf disappears', () => {
    const overlay = new DraftOverlay()
    overlay.setEntry(['a', 'b', 'leaf'], valueEntry(1))
    expect(overlay.childKeys([])).toEqual(['a'])
    expect(overlay.childKeys(['a'])).toEqual(['b'])
    overlay.deleteTree(['a', 'b', 'leaf'])
    expect(overlay.childKeys(['a'])).toEqual([])
    expect(overlay.childKeys([])).toEqual([])
    overlay.setEntry(['a', 'c'], valueEntry(2))
    expect(overlay.childKeys([])).toEqual(['a'])
    expect(overlay.childKeys(['a'])).toEqual(['c'])
  })
})

/* -------------------------------------------------------------------------- */
/*                              Ownership and diff                            */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay diff output', () => {
  test('is sorted, frozen, canonical and isolated from draft and inputs', () => {
    const overlay = new DraftOverlay()
    const input = new Uint8Array([1, 2, 3])
    const path = ['owned', 'bytes']
    overlay.setEntry(path, valueEntry(input))
    input[0] = 9
    path[0] = 'mutated'
    overlay.setEntry(['owned', 'n'], valueEntry(5))
    overlay.setEntry(['owned', 'a'], valueEntry(4))

    const stored = overlay.getEntry(['owned', 'bytes'])
    if (stored === undefined || stored.entryKind !== 'val' || !(stored.value instanceof Uint8Array))
      throw new Error('expected owned bytes')
    expect([...stored.value]).toEqual([1, 2, 3])

    const diff = overlay.compileDiff()
    expect(Object.isFrozen(diff)).toBe(true)
    expect(diff.map((op) => op.path)).toEqual([
      ['owned', 'a'],
      ['owned', 'bytes'],
      ['owned', 'n'],
    ])
    for (let i = 0; i < diff.length; i++) {
      const op = diff[i]!
      expect(Object.isFrozen(op)).toBe(true)
      expect(Object.isFrozen(op.path)).toBe(true)
      if (i > 0) expect(comparePaths(diff[i - 1]!.path, op.path)).toBeLessThan(0)
    }
    expect(new Set(diff.map((op) => encodePathKey(op.path))).size).toBe(diff.length)

    const bytesOp = diff[1]!
    if (bytesOp.op !== 'set' || !(bytesOp.value instanceof Uint8Array))
      throw new Error('expected set bytes')
    bytesOp.value[0] = 7
    const storedAgain = overlay.getEntry(['owned', 'bytes'])
    if (storedAgain?.entryKind !== 'val' || !(storedAgain.value instanceof Uint8Array))
      throw new Error('expected owned bytes')
    expect([...storedAgain.value]).toEqual([1, 2, 3])

    overlay.setEntry(['owned', 'n'], valueEntry(6))
    expect(diff[2]).toMatchObject({ op: 'set', path: ['owned', 'n'], value: 5 })
    expect(overlay.compileDiff()[2]).toMatchObject({ op: 'set', path: ['owned', 'n'], value: 6 })
  })

  test('copies reference payloads on write and diff', () => {
    const world = setupWorld()
    const origin = commit(world, null, [{ op: 'set', path: ['value'], value: 1 }])
    const base = commit(world, origin, [
      { op: 'ref', path: ['r'], ref: { commitId: origin.id, path: ['value'] } },
    ])
    const reader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(reader)
    const ref = { commitId: origin.id, path: ['value'] }
    overlay.setEntry(['copied'], { entryKind: 'ref', ref })
    ref.path[0] = 'changed'
    ref.commitId = base.id

    const stored = overlay.getEntry(['copied'])
    if (stored?.entryKind !== 'ref') throw new Error('expected reference entry')
    expect(stored.ref.commitId).toBe(origin.id)
    expect(stored.ref.path).toEqual(['value'])

    const diff = overlay.compileDiff()
    const op = diff[0]
    if (op?.op !== 'ref') throw new Error('expected ref operation')
    expect(op.ref.path).toEqual(['value'])
    expect(Object.isFrozen(op.ref)).toBe(true)
    expect(Object.isFrozen(op.ref.path)).toBe(true)
    expect(op.ref.path).not.toBe(ref.path)
    const after = overlay.getEntry(['copied'])
    if (after?.entryKind !== 'ref') throw new Error('expected reference entry')
    expect(after.ref.path).toEqual(['value'])
  })
})

/* -------------------------------------------------------------------------- */
/*                             Noop and net diffs                             */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay net diff', () => {
  test('A -> B -> A emits nothing, including bytes and refs', () => {
    const world = setupWorld()
    const origin = commit(world, null, [{ op: 'set', path: ['value'], value: 1 }])
    const base = commit(world, origin, [
      { op: 'set', path: ['data', 'bytes'], value: new Uint8Array([4, 5, 6]) },
      { op: 'ref', path: ['data', 'ref'], ref: { commitId: origin.id, path: ['value'] } },
    ])
    const reader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(reader)
    overlay.setEntry(['data', 'bytes'], valueEntry(new Uint8Array([9])))
    overlay.setEntry(['data', 'bytes'], valueEntry(new Uint8Array([4, 5, 6])))
    const baseRef = reader.getEntry(['data', 'ref'])
    if (baseRef === undefined) throw new Error('missing ref')
    overlay.setEntry(['data', 'ref'], { entryKind: 'ref', ref: { commitId: base.id, path: ['x'] } })
    overlay.setEntry(['data', 'ref'], baseRef)
    expect(overlay.compileDiff()).toEqual([])
  })

  test('delete then exact restore of every leaf and reference is a no-op', () => {
    const world = setupWorld()
    const origin = commit(world, null, [{ op: 'set', path: ['value'], value: 1 }])
    const base = commit(world, origin, [
      { op: 'set', path: ['data', 'a'], value: 1 },
      { op: 'set', path: ['data', 'bytes'], value: new Uint8Array([7, 8]) },
      { op: 'set', path: ['data', 'deep', 'leaf'], value: 'x' },
      { op: 'ref', path: ['data', 'ref'], ref: { commitId: origin.id, path: ['value'] } },
    ])
    const reader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(reader)
    overlay.deleteTree(['data'])
    for (const path of [
      ['data', 'a'],
      ['data', 'bytes'],
      ['data', 'deep', 'leaf'],
      ['data', 'ref'],
    ]) {
      const entry = reader.getEntry(path)
      if (entry === undefined) throw new Error(`missing base entry ${path.join('/')}`)
      overlay.setEntry(path, entry)
    }
    expect(overlay.getEntry(['data', 'deep', 'leaf'])).toEqual(valueEntry('x'))
    expect(overlay.compileDiff()).toEqual([])
  })

  test('add then delete of an absent subtree and absent deletes emit nothing', () => {
    const overlay = new DraftOverlay()
    overlay.setEntry(['ghost', 'leaf'], valueEntry(1))
    overlay.deleteTree(['ghost'])
    overlay.deleteTree(['never', 'existed'])
    overlay.setEntry(['empty', 'branch'], valueEntry(2))
    overlay.deleteTree(['empty'])
    expect(overlay.compileDiff()).toEqual([])
  })

  test('partial restore deletes only the final differences', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['data', 'a'], value: 1 },
      { op: 'set', path: ['data', 'b'], value: 2 },
      { op: 'set', path: ['data', 'c'], value: 3 },
    ])
    const reader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(reader)
    overlay.deleteTree(['data'])
    const restored = reader.getEntry(['data', 'a'])
    if (restored === undefined) throw new Error('missing base leaf')
    overlay.setEntry(['data', 'a'], restored)
    const diff = overlay.compileDiff()
    expect(diff.map((op) => [op.op, op.path])).toEqual([
      ['del', ['data', 'b']],
      ['del', ['data', 'c']],
    ])
    const applied = applyOverlay(world, base, overlay)
    const finalSnapshot = snapshot(world, applied.node.id)
    expect([...finalSnapshot.keys()]).toEqual([encodePathKey(['data', 'a'])])
    expect(leafEntryEquals(finalSnapshot.get(encodePathKey(['data', 'a']))!, valueEntry(1))).toBe(
      true,
    )
  })

  test('nested deletion with partial restore keeps untouched restored values', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['data', 'x', 'z'], value: 1 },
      { op: 'set', path: ['data', 'x', 'w'], value: 2 },
      { op: 'set', path: ['data', 'q'], value: 3 },
    ])
    const reader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(reader)
    overlay.deleteTree(['data', 'x'])
    const z = reader.getEntry(['data', 'x', 'z'])
    if (z === undefined) throw new Error('missing base leaf')
    overlay.setEntry(['data', 'x', 'z'], z)
    expect(overlay.childKeys(['data', 'x'])).toEqual(['z'])
    expect(overlay.childKeys(['data'])).toEqual(['q', 'x'])

    const applied = applyOverlay(world, base, overlay)
    const finalSnapshot = snapshot(world, applied.node.id)
    const expected: Model = new Map([
      [encodePathKey(['data', 'x', 'z']), valueEntry(1)],
      [encodePathKey(['data', 'q']), valueEntry(3)],
    ])
    expectSnapshot(finalSnapshot, expected)
    const appliedDiff = applied.diff.map((op) => [op.op, op.path])
    expect(appliedDiff).toEqual([['del', ['data', 'x', 'w']]])
  })

  test('last leaf removal coalesces into the highest empty ancestor', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['a', 'b', 'c', 'd'], value: 1 },
      { op: 'set', path: ['a', 'b', 'e'], value: 2 },
    ])
    const overlay = new DraftOverlay(new WorldStateReader(world, base.id))
    overlay.deleteTree(['a', 'b', 'c', 'd'])
    overlay.deleteTree(['a', 'b', 'e'])
    expect(overlay.compileDiff().map((op) => [op.op, op.path])).toEqual([['del', ['a']]])
  })
})

/* -------------------------------------------------------------------------- */
/*                              Shape transitions                             */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay shape transitions', () => {
  test('base leaf to directory deletes the leaf, then writes descendants', () => {
    const world = setupWorld()
    const base = commit(world, null, [{ op: 'set', path: ['node'], value: 1 }])
    const overlay = new DraftOverlay(new WorldStateReader(world, base.id))
    overlay.deleteTree(['node'])
    overlay.setEntry(['node', 'child'], valueEntry(2))
    const diff = overlay.compileDiff()
    expect(diff.map((op) => [op.op, op.path])).toEqual([
      ['del', ['node']],
      ['set', ['node', 'child']],
    ])
    const applied = applyOverlay(world, base, overlay)
    const view = unwrap(world.getNode(applied.node.id))
    if (view.kind !== 'some' || view.value.nodeKind !== 'dir') throw new Error('expected dir root')
    const node = view.value.entries.get('node')
    if (node?.nodeKind !== 'dir') throw new Error('expected directory')
    expect([...node.entries.keys()]).toEqual(['child'])
  })

  test('base directory to leaf deletes child subtrees without deleting the leaf path', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['node', 'a'], value: 1 },
      { op: 'set', path: ['node', 'deep', 'b'], value: 2 },
    ])
    const overlay = new DraftOverlay(new WorldStateReader(world, base.id))
    overlay.deleteTree(['node'])
    overlay.setEntry(['node'], valueEntry(9))
    const diff = overlay.compileDiff()
    expect(diff.filter((op) => op.op === 'del').map((op) => op.path)).toEqual([
      ['node', 'a'],
      ['node', 'deep'],
    ])
    expect(diff.some((op) => op.op === 'del' && op.path.length === 1)).toBe(false)
    expect(diff.find((op) => op.op === 'set')?.path).toEqual(['node'])
    const applied = applyOverlay(world, base, overlay)
    const view = unwrap(world.getNode(applied.node.id))
    if (view.kind !== 'some' || view.value.nodeKind !== 'dir') throw new Error('expected dir root')
    const node = view.value.entries.get('node')
    if (node?.nodeKind !== 'leaf') throw new Error('expected leaf')
    expect(leafEntryEquals(node.entry, valueEntry(9))).toBe(true)
  })

  test('root clear deletes every top-level branch and can be rebuilt', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['data', 'a'], value: 1 },
      { op: 'set', path: ['other'], value: 2 },
      { op: 'set', path: ['shadow', 'deep', 'leaf'], value: 3 },
    ])
    const overlay = new DraftOverlay(new WorldStateReader(world, base.id))
    overlay.deleteTree([])
    expect(overlay.childKeys([])).toEqual([])
    const cleared = overlay.compileDiff()
    expect(cleared.map((op) => [op.op, op.path])).toEqual([
      ['del', ['data']],
      ['del', ['other']],
      ['del', ['shadow']],
    ])
    const empty = applyOverlay(world, base, overlay)
    expectSnapshot(snapshot(world, empty.node.id), new Map<string, LeafEntry>())

    overlay.setEntry(['fresh'], valueEntry(7))
    expect(overlay.childKeys([])).toEqual(['fresh'])
    const rebuilt = applyOverlay(world, base, overlay)
    expectSnapshot(
      snapshot(world, rebuilt.node.id),
      new Map([[encodePathKey(['fresh']), valueEntry(7)]]),
    )
  })
})

/* -------------------------------------------------------------------------- */
/*                             Unicode and prefixes                           */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay key ordering', () => {
  test('keeps prefix-shaped and Unicode keys in UTF-8 order', () => {
    const world = setupWorld()
    const base = commit(world, null, [
      { op: 'set', path: ['data', 'a'], value: 1 },
      { op: 'set', path: ['data', 'ab'], value: 2 },
      { op: 'set', path: ['data', '\uE000'], value: 3 },
      { op: 'set', path: ['data', '\u{10000}'], value: 4 },
    ])
    const overlay = new DraftOverlay(new WorldStateReader(world, base.id))
    overlay.deleteTree(['data', 'ab'])
    overlay.setEntry(['data', 'a0'], valueEntry(5))
    overlay.setEntry(['data', '\u00E9'], valueEntry(6))
    const expected = ['a', 'a0', '\u00E9', '\uE000', '\u{10000}']
    expect(overlay.childKeys(['data'])).toEqual(expected)
    expect(overlay.hasEntry(['data', 'a'])).toBe(true)
    expect(overlay.hasEntry(['data', 'ab'])).toBe(false)

    const applied = applyOverlay(world, base, overlay)
    const listing = unwrap(world.listChildren(applied.node.id, ['data']))
    if (listing.kind !== 'some') throw new Error('expected directory listing')
    expect(listing.value).toEqual(expected)
  })
})

/* -------------------------------------------------------------------------- */
/*                            Access-scope guarantee                          */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay point diffs', () => {
  test('do not enumerate unrelated base siblings', () => {
    const world = setupWorld()
    const siblings = Array.from({ length: 200 }, (_, index) => ({
      op: 'set' as const,
      path: ['sibling', `s${String(index).padStart(3, '0')}`],
      value: index,
    }))
    const base = commit(world, null, siblings)
    const reader = new WorldStateReader(world, base.id)
    const accesses: Path[] = []
    const spy: StateReader = {
      getEntry(path) {
        accesses.push([...path])
        return reader.getEntry(path)
      },
      hasEntry(path) {
        accesses.push([...path])
        return reader.hasEntry(path)
      },
      childKeys(path) {
        accesses.push([...path])
        return reader.childKeys(path)
      },
    }
    const overlay = new DraftOverlay(spy)
    overlay.setEntry(['target', 'leaf'], valueEntry(1))
    const diff = overlay.compileDiff()
    expect(diff.map((op) => [op.op, op.path])).toEqual([['set', ['target', 'leaf']]])
    // The point diff may inspect only the dirty coordinate; it must never walk
    // the unrelated `sibling/*` subtree (nor enumerate the root).
    for (const path of accesses) expect(path[0]).toBe('target')
  })

  test('empty overlay diff is empty and frozen without touching the base', () => {
    const calls: string[] = []
    const base: StateReader = {
      getEntry() {
        calls.push('getEntry')
        throw new Error('unexpected payload read')
      },
      hasEntry() {
        calls.push('hasEntry')
        throw new Error('unexpected presence read')
      },
      childKeys() {
        calls.push('childKeys')
        throw new Error('unexpected child enumeration')
      },
    }
    const overlay = new DraftOverlay(base)
    const diff = overlay.compileDiff()
    expect(diff).toEqual([])
    expect(Object.isFrozen(diff)).toBe(true)
    expect(calls).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*                              Deep root paths                              */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay deep root paths', () => {
  test('compiles, applies and deletes a 3200-segment path without recursion', () => {
    const world = setupWorld()
    const chain: string[] = []
    for (let index = 0; index < 3200; index++) chain.push(`p${index}`)
    const deepA = [...chain, 'a']
    const deepB = [...chain, 'b']

    const seed = new DraftOverlay()
    seed.setEntry(deepA, valueEntry(1))
    expect(seed.childKeys([...chain])).toEqual(['a'])
    const first = seed.compileDiff()
    expect(first.map((op) => op.path)).toEqual([deepA])
    const base = commit(world, null, first)
    const baseReader = new WorldStateReader(world, base.id)
    expect(baseReader.hasEntry(deepA)).toBe(true)
    expect(baseReader.getEntry(deepA)).toEqual(valueEntry(1))

    const grow = new DraftOverlay(baseReader)
    grow.setEntry(deepB, valueEntry(2))
    const second = grow.compileDiff()
    expect(second.map((op) => op.path)).toEqual([deepB])
    const both = commit(world, base, second)
    const bothReader = new WorldStateReader(world, both.id)
    expect(bothReader.hasEntry(deepB)).toBe(true)

    const cut = new DraftOverlay(bothReader)
    cut.deleteTree(deepA)
    expect(cut.childKeys([...chain])).toEqual(['b'])
    const third = cut.compileDiff()
    expect(third.map((op) => [op.op, op.path])).toEqual([['del', deepA]])
    const after = commit(world, both, third)
    const afterReader = new WorldStateReader(world, after.id)
    expect(afterReader.hasEntry(deepA)).toBe(false)
    expect(afterReader.hasEntry(deepB)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*                         Deterministic model-based run                      */
/* -------------------------------------------------------------------------- */

describe('DraftOverlay against an independent flat model', () => {
  test('deterministic mixed sequence matches reads, child keys and final World state', () => {
    const world = setupWorld()
    const segments = ['a', 'ab', 'a:b', '\u00E9', '\u{1F600}', '\uE000', 'node', 'nested', '$meta']
    let seed = 0x5eed1234
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const randomPath = (): Path => {
      const depth = 1 + (random() % 3)
      const path: string[] = []
      for (let i = 0; i < depth; i++) path.push(segments[random() % segments.length]!)
      return path
    }
    const randomValue = (): Value => {
      switch (random() % 4) {
        case 0:
          return random() % 1000
        case 1:
          return `v${random() % 1000}`
        case 2:
          return new Uint8Array([random() % 256, random() % 256])
        default:
          return [random() % 10, 'x', null]
      }
    }
    const hasLeafAncestor = (model: Model, path: Path): boolean => {
      for (let len = 1; len < path.length; len++)
        if (model.has(encodePathKey(path.slice(0, len)))) return true
      return false
    }
    const hasDescendants = (model: Model, path: Path): boolean => {
      const prefix = encodePathKey(path)
      for (const key of model.keys()) if (key !== prefix && key.startsWith(prefix)) return true
      return false
    }

    const initial: { path: Path; entry: LeafEntry }[] = [
      { path: ['data', 'a'], entry: valueEntry(1) },
      { path: ['data', 'ab'], entry: valueEntry(new Uint8Array([1])) },
      { path: ['data', '\u{10000}'], entry: valueEntry('unicode') },
      { path: ['other', 'deep', 'leaf'], entry: valueEntry(true) },
    ]
    const model: Model = new Map()
    const baseDiff: StateDiff = initial.map((item) => {
      modelSet(model, item.path, item.entry)
      return item.entry.entryKind === 'val'
        ? { op: 'set' as const, path: item.path, value: item.entry.value }
        : { op: 'ref' as const, path: item.path, ref: item.entry.ref }
    })
    const base = commit(world, null, baseDiff)
    const baseReader = new WorldStateReader(world, base.id)
    const overlay = new DraftOverlay(baseReader)
    const seen = new Map<string, Path>()
    for (const key of model.keys()) rememberPaths(seen, decodePathKey(key))
    rememberPaths(seen, [])

    const rewrite = (path: Path): void => {
      const blocked = hasLeafAncestor(model, path)
      overlay.deleteTree(path)
      modelDelete(model, path)
      rememberPaths(seen, path)
      // A leaf ancestor keeps this coordinate structurally absent; only an
      // explicit delete of that ancestor could replace it.
      if (blocked) return
      const entry = valueEntry(randomValue())
      overlay.setEntry(path, entry)
      modelSet(model, path, entry)
      rememberPaths(seen, path)
    }

    for (let step = 0; step < 160; step++) {
      const choice = random() % 100
      if (choice < 45) {
        const path = randomPath()
        if (hasLeafAncestor(model, path)) {
          rewrite(path)
          continue
        }
        if (hasDescendants(model, path)) {
          // Replacing a directory with a leaf must be explicit.
          rewrite(path)
          continue
        }
        const entry = valueEntry(randomValue())
        overlay.setEntry(path, entry)
        modelSet(model, path, entry)
        rememberPaths(seen, path)
      } else if (choice < 75) {
        const path = randomPath()
        overlay.deleteTree(path)
        modelDelete(model, path)
        rememberPaths(seen, path)
      } else if (choice < 92) {
        rewrite(randomPath())
      } else {
        const keys = [...model.keys()]
        if (keys.length === 0) continue
        const key = keys[random() % keys.length]!
        const path = decodePathKey(key)
        const entry = model.get(key)!
        overlay.setEntry(path, entry)
        modelSet(model, path, entry)
      }
      expectReadsMatchModel(overlay, model, seen.values())
    }

    expectReadsMatchModel(overlay, model, seen.values())
    const first = overlay.compileDiff()
    const second = overlay.compileDiff()
    expect(second).toEqual(first)
    expect(Object.isFrozen(first)).toBe(true)
    for (let i = 1; i < first.length; i++)
      expect(comparePaths(first[i - 1]!.path, first[i]!.path)).toBeLessThan(0)

    const applied = commit(world, base, first)
    expectSnapshot(snapshot(world, applied.id), model)
  })
})
