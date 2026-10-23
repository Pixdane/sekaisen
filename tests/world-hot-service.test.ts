import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Option, Result } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import type {
  AdvanceHeadInput,
  CommitHash,
  CommitInput,
  CommitNode,
  LeafEntry,
  OriginDirectoryNode,
  OriginTreeNode,
  SqliteDriver,
  StateDiff,
  Value,
  WorldError,
} from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'

const drivers: SqliteDriver[] = []
const tempDirs: string[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): { driver: SqliteDriver; ctx: Context; world: WorldService } {
  const driver = createBunSqliteDriver()
  drivers.push(driver)
  const ctx = new Context()
  return { driver, ctx, world: new WorldService(ctx, { driver }) }
}

function unwrap<T>(result: Result<T, WorldError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function commit(
  world: WorldService,
  parent: CommitNode | null,
  diff: StateDiff,
  options: { readonly message?: Value; readonly advanceHead?: string | AdvanceHeadInput } = {},
): CommitNode {
  return unwrap(
    world.commit({
      parentId: parent ? some(parent.id) : NONE,
      message: options.message ?? null,
      diff,
      ...(options.advanceHead === undefined ? {} : { advanceHead: options.advanceHead }),
    }),
  )
}

function value(world: WorldService, id: CommitHash, path: readonly string[]): Value {
  const result = unwrap(world.getValue(id, path))
  if (result.kind === 'none') throw new Error('Expected a value leaf')
  return result.value
}

/* -------------------------------------------------------------------------- */
/*                      Narrow view of real residency internals               */
/* -------------------------------------------------------------------------- */

interface HotEntryProbe {
  readonly box: { readonly value: LeafEntry }
  readonly count: number
}

interface StorageProbe {
  readonly hot: ReadonlyMap<string, HotEntryProbe>
  readonly heads: ReadonlyMap<string, CommitHash>
  readonly pins: ReadonlyMap<CommitHash, ReadonlySet<CommitHash>>
  readonly commits: ReadonlyMap<
    CommitHash,
    { readonly index: OriginDirectoryNode; readonly children: ReadonlySet<CommitHash> }
  >
}

function storageOf(world: WorldService): StorageProbe {
  const candidate: unknown = world
  if (typeof candidate !== 'object' || candidate === null || !('storage' in candidate))
    throw new Error('WorldService does not expose storage internals')
  // Test-only probe: the real private storage is the residency source of truth.
  return candidate.storage as StorageProbe
}

const boxIdentities = new WeakMap<object, symbol>()

/** Opaque-coordinate snapshot: key text is compared only with itself, never asserted. */
function hotSnapshot(world: WorldService) {
  const entries = [...storageOf(world).hot.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return entries.map(([key, entry]) => {
    let box = boxIdentities.get(entry.box)
    if (box === undefined) {
      box = Symbol()
      boxIdentities.set(entry.box, box)
    }
    return { key, count: entry.count, box, value: entry.box.value }
  })
}

function hotTotal(world: WorldService): number {
  let total = 0
  for (const entry of storageOf(world).hot.values()) total += entry.count
  return total
}

function leafCount(index: OriginDirectoryNode): number {
  let total = 0
  const stack: OriginTreeNode[] = [index]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.kind === 'leaf') total++
    else for (const child of node.children.values()) stack.push(child)
  }
  return total
}

/** Per-head weighting: every leaf counts once per active head whose state contains it. */
function expectedHotTotal(world: WorldService): number {
  const storage = storageOf(world)
  let total = 0
  for (const id of storage.heads.values()) {
    const record = storage.commits.get(id)
    if (!record) throw new Error(`Missing commit ${id}`)
    total += leafCount(record.index)
  }
  return total
}

function expectResidencyConsistent(world: WorldService): void {
  for (const entry of storageOf(world).hot.values()) {
    expect(entry.count).toBeGreaterThanOrEqual(1)
  }
  expect(hotTotal(world)).toBe(expectedHotTotal(world))
}

function residencySnapshot(world: WorldService) {
  const storage = storageOf(world)
  return {
    heads: world.listHeads(),
    roots: world.listRoots(),
    leaves: world.listLeaves(),
    hot: hotSnapshot(world),
    commits: [...storage.commits]
      .map(([id, record]) => ({ id, children: [...record.children].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    pins: [...storage.pins]
      .map(([id, sources]) => ({ id, sources: [...sources].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

function sortedIds(ids: readonly CommitHash[]): CommitHash[] {
  return [...ids].sort()
}

/* -------------------------------------------------------------------------- */
/*                              Driver fault model                            */
/* -------------------------------------------------------------------------- */

interface FaultControl {
  /** Return `true` to abort the read of this coordinate. */
  hydration?: (params: readonly unknown[]) => boolean
  /** Invoked after a transaction callback returns, while the base transaction is open. */
  transaction?: () => Error | undefined
}

function createFaultDriver(base: SqliteDriver, control: FaultControl): SqliteDriver {
  return {
    exec: (sql) => base.exec(sql),
    prepare: (sql) => {
      const inner = base.prepare(sql)
      return {
        run: (...params: readonly unknown[]) => inner.run(...params),
        get: <TRow = Record<string, unknown>>(...params: readonly unknown[]) => {
          if (control.hydration?.(params) === true) throw new Error('injected hydration failure')
          return inner.get<TRow>(...params)
        },
        all: <TRow = Record<string, unknown>>(...params: readonly unknown[]) =>
          inner.all<TRow>(...params),
      }
    },
    transaction: <T>(fn: () => T): T =>
      base.transaction(() => {
        const result = fn()
        const failure = control.transaction?.()
        if (failure) throw failure
        return result
      }),
    close: () => base.close(),
  }
}

/* -------------------------------------------------------------------------- */
/*                        Incremental residency behavior                      */
/* -------------------------------------------------------------------------- */

describe('incremental head residency through the public service', () => {
  test('aliases and divergent roots keep per-head counts for setHead and deleteHead', () => {
    const { world } = setup()
    const base = commit(world, null, [
      { op: 'set', path: ['shared', 'x'], value: 'x' },
      { op: 'set', path: ['shared', 'y'], value: 1 },
      { op: 'set', path: ['base-only'], value: true },
    ])
    const tip = commit(world, base, [
      { op: 'set', path: ['tip-only'], value: new Uint8Array([1, 2, 3]) },
    ])
    const other = commit(world, null, [
      { op: 'set', path: ['other', 'a'], value: null },
      { op: 'set', path: ['other', 'b'], value: ['x', 1] },
    ])

    unwrap(world.setHead('main', tip.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(4)

    // A shared-history alias contributes a second count for every shared leaf.
    unwrap(world.setHead('alias', base.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(7)
    expect(value(world, base.id, ['shared', 'y'])).toBe(1)
    expect(value(world, tip.id, ['tip-only'])).toEqual(new Uint8Array([1, 2, 3]))

    // Two names on the exact same commit still count every leaf twice.
    unwrap(world.setHead('alias', tip.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(8)
    expect([...storageOf(world).hot.values()].every((entry) => entry.count === 2)).toBe(true)

    unwrap(world.setHead('third', base.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(11)

    // Move one alias to a different root while the shared-history pair remains.
    unwrap(world.setHead('alias', other.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(9)
    expect(value(world, other.id, ['other', 'b'])).toEqual(['x', 1])

    // Move across the shared root to a commit already covered by another head.
    unwrap(world.setHead('main', base.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(8)

    const advanced = unwrap(
      world.commit({
        parentId: some(tip.id),
        message: 'advance one',
        diff: [{ op: 'set', path: ['new'], value: 9 }],
        advanceHead: { name: 'main', expected: some(base.id) },
      }),
    )
    expect(world.getHead('main')).toEqual(some(advanced.id))
    expect(world.getHead('third')).toEqual(some(base.id))
    expect(world.getHead('alias')).toEqual(some(other.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(10)
    expect(value(world, advanced.id, ['new'])).toBe(9)
    expect(value(world, advanced.id, ['shared', 'x'])).toBe('x')

    unwrap(world.deleteHead('third'))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(7)

    unwrap(world.deleteHead('main'))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(2)
    expect([...storageOf(world).hot.values()].every((entry) => entry.count === 1)).toBe(true)

    unwrap(world.deleteHead('alias'))
    expect(storageOf(world).hot.size).toBe(0)
    expect(hotTotal(world)).toBe(0)
    expect(expectedHotTotal(world)).toBe(0)
  })

  test('no-op commits and replayed identities do not churn resident boxes', () => {
    const { world, ctx } = setup()
    const root = commit(
      world,
      null,
      [
        { op: 'set', path: ['x'], value: 1 },
        { op: 'set', path: ['y', 'z'], value: 'v' },
      ],
      { advanceHead: 'main' },
    )
    const events: string[] = []
    ctx.on('world/committed', (node) => {
      events.push(`committed:${node.id}`)
    })
    ctx.on('world/head-updated', (name, id) => {
      events.push(`head:${name}:${id.kind === 'some' ? id.value : 'none'}`)
    })

    const before = hotSnapshot(world)
    unwrap(world.setHead('main', root.id))
    expect(hotSnapshot(world)).toEqual(before)
    expect(events).toEqual([])

    // An empty-diff child has a new commit id but reuses the parent index object.
    const noop = unwrap(
      world.commit({
        parentId: some(root.id),
        message: 'no state change',
        diff: [],
        advanceHead: 'main',
      }),
    )
    expect(noop.id).not.toBe(root.id)
    expect(world.getHead('main')).toEqual(some(noop.id))
    expect(hotSnapshot(world)).toEqual(before)
    expect(events).toEqual([`committed:${noop.id}`, `head:main:${noop.id}`])
    expectResidencyConsistent(world)

    // Replaying the same canonical commit with an explicit matching CAS is a no-op.
    events.length = 0
    const replayed = unwrap(
      world.commit({
        parentId: some(root.id),
        message: 'no state change',
        diff: [],
        advanceHead: { name: 'main', expected: some(noop.id) },
      }),
    )
    expect(replayed.id).toBe(noop.id)
    expect(hotSnapshot(world)).toEqual(before)
    expect(events).toEqual([])
    expect(world.hasCommit(noop.id)).toBe(true)

    // Replaying an existing commit onto another head must reuse its stored index.
    const child = commit(world, root, [{ op: 'set', path: ['child'], value: 2 }])
    unwrap(world.setHead('second', root.id))
    events.length = 0
    const leavesBefore = world.listLeaves()
    const replayedChild = unwrap(
      world.commit({
        parentId: some(root.id),
        message: null,
        diff: [{ op: 'set', path: ['child'], value: 2 }],
        advanceHead: { name: 'second', expected: some(root.id) },
      }),
    )
    expect(replayedChild.id).toBe(child.id)
    expect(world.hasCommit(child.id)).toBe(true)
    expect(world.listLeaves()).toEqual(leavesBefore)
    expect(events).toEqual([`head:second:${child.id}`])
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(5)
    expect(value(world, child.id, ['child'])).toBe(2)
  })

  test('shape changes, refs and bytes stay exactly resident', () => {
    const { world } = setup()
    const base = commit(
      world,
      null,
      [
        { op: 'set', path: ['a', 'x'], value: 1 },
        { op: 'set', path: ['a', 'y'], value: 2 },
        { op: 'set', path: ['b', 'keep'], value: true },
        { op: 'set', path: ['payload', 'bytes'], value: new Uint8Array([1, 2, 3]) },
        { op: 'set', path: ['payload', 'text'], value: '000123' },
      ],
      { advanceHead: 'main' },
    )
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(5)

    // Directory -> leaf replacement prunes the subtree's two leaves.
    const shaped = commit(world, base, [
      { op: 'del', path: ['a', 'x'] },
      { op: 'del', path: ['a', 'y'] },
      { op: 'set', path: ['a'], value: 3 },
    ])
    unwrap(world.setHead('main', shaped.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(4)
    expect(value(world, shaped.id, ['a'])).toBe(3)
    expect(unwrap(world.getValue(shaped.id, ['a', 'x']))).toEqual(NONE)

    // Leaf -> directory replacement plus a reference leaf.
    const expanded = commit(world, shaped, [
      { op: 'del', path: ['a'] },
      { op: 'set', path: ['a', 'child'], value: 'nested' },
      { op: 'ref', path: ['link'], ref: { commitId: shaped.id, path: ['payload'] } },
    ])
    unwrap(world.setHead('main', expanded.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(5)
    expect(value(world, expanded.id, ['a', 'child'])).toBe('nested')
    expect(value(world, expanded.id, ['payload', 'bytes'])).toEqual(new Uint8Array([1, 2, 3]))
    expect(value(world, expanded.id, ['payload', 'text'])).toBe('000123')
    expect(unwrap(world.getRef(expanded.id, ['link']))).toEqual(
      some({ commitId: shaped.id, path: ['payload'] }),
    )

    // Subtree removal plus a reference leaf removal.
    const pruned = commit(world, expanded, [
      { op: 'del', path: ['payload'] },
      { op: 'del', path: ['link'] },
    ])
    unwrap(world.setHead('main', pruned.id))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(2)
    expect(unwrap(world.getValue(pruned.id, ['payload', 'bytes']))).toEqual(NONE)
    expect(unwrap(world.getRef(pruned.id, ['link']))).toEqual(NONE)
    expect(value(world, pruned.id, ['b', 'keep'])).toBe(true)
  })

  test('CAS failures, invalid coordinates and unknown heads leave residency untouched', () => {
    const { world, ctx } = setup()
    const root = commit(world, null, [{ op: 'set', path: ['x'], value: 1 }], {
      advanceHead: 'main',
    })
    const other = commit(world, null, [{ op: 'set', path: ['y'], value: 2 }])
    const snapshot = residencySnapshot(world)
    const events: string[] = []
    ctx.on('world/head-updated', (name, id) => {
      events.push(`head:${name}:${id.kind === 'some' ? id.value : 'none'}`)
    })
    ctx.on('world/committed', () => {
      events.push('committed')
    })

    expect(world.setHead('main', other.id, some(other.id))).toMatchObject({
      ok: false,
      error: { kind: 'head_cas_mismatch', actual: some(root.id) },
    })
    expect(world.setHead('main', 'missing' as CommitHash)).toMatchObject({
      ok: false,
      error: { kind: 'commit_not_found' },
    })
    expect(world.setHead('', root.id)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_head_name' },
    })
    expect(world.deleteHead('absent')).toMatchObject({
      ok: false,
      error: { kind: 'head_not_found' },
    })
    expect(world.deleteHead('main', some(other.id))).toMatchObject({
      ok: false,
      error: { kind: 'head_cas_mismatch' },
    })
    expect(
      world.commit({
        parentId: some(other.id),
        message: 'different parent',
        diff: [{ op: 'set', path: ['z'], value: 3 }],
        advanceHead: 'main',
      }),
    ).toMatchObject({ ok: false, error: { kind: 'head_cas_mismatch' } })

    expect(residencySnapshot(world)).toEqual(snapshot)
    expect(events).toEqual([])
    expect(world.getHead('main')).toEqual(some(root.id))
  })

  test('head events observe published heads and fully resident leaves', () => {
    const base = createBunSqliteDriver()
    drivers.push(base)
    let allowIo = true
    const guarded: SqliteDriver = {
      exec: (sql) => {
        checkIo()
        base.exec(sql)
      },
      prepare: (sql) => {
        checkIo()
        return base.prepare(sql)
      },
      transaction: <T>(fn: () => T): T => {
        checkIo()
        return base.transaction(fn)
      },
      close: () => base.close(),
    }
    function checkIo(): void {
      if (!allowIo) throw new Error('SQLite access is disabled')
    }

    const ctx = new Context()
    const world = new WorldService(ctx, { driver: guarded })
    const heads: {
      name: string
      head: string
      residency: number
      expected: number
      readOk: boolean | undefined
      readKind: string | undefined
    }[] = []
    const committed: { id: string; has: boolean; residency: number; expected: number }[] = []
    const order: string[] = []

    ctx.on('world/committed', (node) => {
      order.push('committed')
      committed.push({
        id: node.id,
        has: world.hasCommit(node.id),
        residency: hotTotal(world),
        expected: expectedHotTotal(world),
      })
    })
    ctx.on('world/head-updated', (name, id) => {
      order.push(`head:${name}`)
      let readOk: boolean | undefined
      let readKind: string | undefined
      if (id.kind === 'some') {
        allowIo = false
        const read = world.getNode(id.value)
        allowIo = true
        readOk = read.ok
        readKind = read.ok
          ? read.value.kind === 'some'
            ? read.value.value.nodeKind
            : 'none'
          : read.error.kind
      }
      heads.push({
        name,
        head: id.kind === 'some' ? id.value : 'none',
        residency: hotTotal(world),
        expected: expectedHotTotal(world),
        readOk,
        readKind,
      })
    })

    const root = commit(
      world,
      null,
      [
        { op: 'set', path: ['x'], value: 1 },
        { op: 'set', path: ['y', 'z'], value: 'v' },
      ],
      { advanceHead: 'main' },
    )
    unwrap(world.setHead('second', root.id))
    const child = unwrap(
      world.commit({
        parentId: some(root.id),
        message: 'grow',
        diff: [{ op: 'set', path: ['child'], value: 2 }],
        advanceHead: 'second',
      }),
    )
    unwrap(world.deleteHead('main'))
    unwrap(world.deleteHead('second'))

    expect(order).toEqual([
      'committed',
      'head:main',
      'head:second',
      'committed',
      'head:second',
      'head:main',
      'head:second',
    ])
    expect(committed).toHaveLength(2)
    for (const observation of committed) {
      expect(observation.has).toBe(true)
      expect(observation.residency).toBe(observation.expected)
    }
    expect(heads).toEqual([
      {
        name: 'main',
        head: root.id,
        residency: 2,
        expected: 2,
        readOk: true,
        readKind: 'dir',
      },
      {
        name: 'second',
        head: root.id,
        residency: 4,
        expected: 4,
        readOk: true,
        readKind: 'dir',
      },
      {
        name: 'second',
        head: child.id,
        residency: 5,
        expected: 5,
        readOk: true,
        readKind: 'dir',
      },
      {
        name: 'main',
        head: 'none',
        residency: 3,
        expected: 3,
        readOk: undefined,
        readKind: undefined,
      },
      {
        name: 'second',
        head: 'none',
        residency: 0,
        expected: 0,
        readOk: undefined,
        readKind: undefined,
      },
    ])
  })

  test('restart and a fresh connection reconstruct active values and alias residency', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sekaisen-hot-service-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'world.sqlite')
    const first = createBunSqliteDriver({ dbPath })
    drivers.push(first)
    const world = new WorldService(new Context(), { driver: first })
    const base = commit(world, null, [
      { op: 'set', path: ['shared', 'x'], value: 'x' },
      { op: 'set', path: ['shared', 'y'], value: 1 },
      { op: 'set', path: ['base', 'bytes'], value: new Uint8Array([9, 8]) },
    ])
    const tip = commit(world, base, [
      { op: 'set', path: ['tip'], value: 'leaf' },
      { op: 'set', path: ['link'], value: ['a', null] },
    ])
    unwrap(world.setHead('main', tip.id))
    unwrap(world.setHead('alias', tip.id))
    unwrap(world.setHead('older', base.id))
    const writtenTotal = expectedHotTotal(world)
    expect(hotTotal(world)).toBe(writtenTotal)

    const second = createBunSqliteDriver({ dbPath })
    drivers.push(second)
    let allowIo = true
    const guarded: SqliteDriver = {
      exec: (sql) => {
        checkIo()
        second.exec(sql)
      },
      prepare: (sql) => {
        checkIo()
        return second.prepare(sql)
      },
      transaction: <T>(fn: () => T): T => {
        checkIo()
        return second.transaction(fn)
      },
      close: () => second.close(),
    }
    function checkIo(): void {
      if (!allowIo) throw new Error('SQLite access is disabled')
    }

    const reopened = new WorldService(new Context(), { driver: guarded })
    expectResidencyConsistent(reopened)
    expect(hotTotal(reopened)).toBe(writtenTotal)
    expect(reopened.listHeads()).toEqual(world.listHeads())

    // Every active leaf is strong after startup: reads work with SQLite disabled.
    allowIo = false
    expect(value(reopened, tip.id, ['tip'])).toBe('leaf')
    expect(value(reopened, tip.id, ['shared', 'y'])).toBe(1)
    expect(value(reopened, base.id, ['base', 'bytes'])).toEqual(new Uint8Array([9, 8]))
    expect(unwrap(reopened.getNode(base.id))).not.toEqual(NONE)
    expect(unwrap(reopened.getNode(tip.id))).not.toEqual(NONE)
    allowIo = true

    // Move an alias after restart and retain the remaining counts.
    unwrap(reopened.setHead('alias', base.id))
    expectResidencyConsistent(reopened)
    expect(hotTotal(reopened)).toBe(11)
    allowIo = false
    expect(value(reopened, base.id, ['shared', 'x'])).toBe('x')
    expect(value(reopened, tip.id, ['shared', 'x'])).toBe('x')
    allowIo = true

    unwrap(reopened.deleteHead('older'))
    expectResidencyConsistent(reopened)
    expect(hotTotal(reopened)).toBe(8)
    unwrap(reopened.deleteHead('alias'))
    unwrap(reopened.deleteHead('main'))
    expect(storageOf(reopened).hot.size).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/*                       Failure atomicity after prepare                      */
/* -------------------------------------------------------------------------- */

describe('failed head transitions never publish residency', () => {
  test('setHead transaction failure after prepare leaves memory and SQLite unchanged', () => {
    const baseDriver = createBunSqliteDriver()
    drivers.push(baseDriver)
    const control: FaultControl = {}
    const driver = createFaultDriver(baseDriver, control)
    const ctx = new Context()
    const world = new WorldService(ctx, { driver })

    const base = commit(world, null, [{ op: 'set', path: ['a'], value: 1 }])
    const tip = commit(world, base, [{ op: 'set', path: ['b'], value: 2 }])
    const other = commit(world, null, [
      { op: 'set', path: ['c'], value: 3 },
      { op: 'set', path: ['d'], value: 4 },
    ])
    unwrap(world.setHead('main', base.id))
    unwrap(world.setHead('second', tip.id))
    const snapshot = residencySnapshot(world)
    const events: string[] = []
    ctx.on('world/head-updated', (name, id) => {
      events.push(`head:${name}:${id.kind === 'some' ? id.value : 'none'}`)
    })
    ctx.on('world/committed', () => {
      events.push('committed')
    })

    let armed = true
    control.transaction = () => (armed ? new Error('injected failure after prepare') : undefined)
    const failed = world.setHead('second', other.id)
    armed = false

    expect(failed).toMatchObject({ ok: false, error: { kind: 'storage_error' } })
    expect(residencySnapshot(world)).toEqual(snapshot)
    expect(events).toEqual([])
    expect(world.getHead('second')).toEqual(some(tip.id))

    const reopened = new WorldService(new Context(), { driver: baseDriver })
    expect(reopened.listHeads()).toEqual(snapshot.heads)
    expect(sortedIds(reopened.listLeaves())).toEqual(sortedIds(snapshot.leaves))

    unwrap(world.setHead('second', other.id))
    expect(events).toEqual([`head:second:${other.id}`])
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(expectedHotTotal(world))
    expect(value(world, other.id, ['d'])).toBe(4)
  })

  test('deleteHead transaction failure keeps counts and last-head clear retries', () => {
    const baseDriver = createBunSqliteDriver()
    drivers.push(baseDriver)
    const control: FaultControl = {}
    const driver = createFaultDriver(baseDriver, control)
    const ctx = new Context()
    const world = new WorldService(ctx, { driver })

    const base = commit(world, null, [{ op: 'set', path: ['a'], value: 1 }])
    const tip = commit(world, base, [{ op: 'set', path: ['b'], value: 2 }])
    const other = commit(world, null, [{ op: 'set', path: ['c'], value: 3 }])
    unwrap(world.setHead('main', base.id))
    unwrap(world.setHead('second', tip.id))
    unwrap(world.setHead('third', other.id))
    const events: (readonly [string, Option<CommitHash>])[] = []
    ctx.on('world/head-updated', (name, id) => {
      events.push([name, id])
    })

    let armed = true
    control.transaction = () => (armed ? new Error('injected delete failure') : undefined)
    const beforeDelete = residencySnapshot(world)
    expect(world.deleteHead('second')).toMatchObject({
      ok: false,
      error: { kind: 'storage_error' },
    })
    armed = false
    expect(residencySnapshot(world)).toEqual(beforeDelete)
    expect(events).toEqual([])
    expect(world.getHead('second')).toEqual(some(tip.id))

    unwrap(world.deleteHead('second'))
    expect(events).toEqual([['second', NONE]])
    expectResidencyConsistent(world)

    armed = true
    const beforeLast = residencySnapshot(world)
    expect(world.deleteHead('third')).toMatchObject({
      ok: false,
      error: { kind: 'storage_error' },
    })
    armed = false
    expect(residencySnapshot(world)).toEqual(beforeLast)
    unwrap(world.deleteHead('third'))
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(1)

    armed = true
    const beforeClear = residencySnapshot(world)
    expect(world.deleteHead('main')).toMatchObject({
      ok: false,
      error: { kind: 'storage_error' },
    })
    armed = false
    expect(residencySnapshot(world)).toEqual(beforeClear)
    unwrap(world.deleteHead('main'))
    expect(storageOf(world).hot.size).toBe(0)
    expect(hotTotal(world)).toBe(0)
    expect(events).toEqual([
      ['second', NONE],
      ['third', NONE],
      ['main', NONE],
    ])
  })

  test('commit insert and advance failure rolls back node, pins and residency', () => {
    const baseDriver = createBunSqliteDriver()
    drivers.push(baseDriver)
    const control: FaultControl = {}
    const driver = createFaultDriver(baseDriver, control)
    const ctx = new Context()
    const world = new WorldService(ctx, { driver })

    const base = commit(world, null, [{ op: 'set', path: ['state'], value: 1 }])
    const target = commit(world, null, [{ op: 'set', path: ['target'], value: 2 }])
    unwrap(world.setHead('main', base.id))
    const diff: StateDiff = [
      { op: 'set', path: ['fresh'], value: 42 },
      { op: 'ref', path: ['link'], ref: { commitId: target.id, path: [] } },
    ]
    const input: CommitInput = {
      parentId: some(base.id),
      message: 'rolled back',
      diff,
      advanceHead: 'main',
    }
    const snapshot = residencySnapshot(world)
    const pinsBefore = unwrap(world.getReferencingCommits(target.id))
    const events: string[] = []
    ctx.on('world/committed', (node) => {
      events.push(`committed:${node.id}`)
    })
    ctx.on('world/head-updated', (name, id) => {
      events.push(`head:${name}:${id.kind === 'some' ? id.value : 'none'}`)
    })

    let armed = true
    control.transaction = () => (armed ? new Error('injected commit failure') : undefined)
    const failed = world.commit(input)
    armed = false

    expect(failed).toMatchObject({ ok: false, error: { kind: 'storage_error' } })
    expect(residencySnapshot(world)).toEqual(snapshot)
    expect(unwrap(world.getReferencingCommits(target.id))).toEqual(pinsBefore)
    expect(events).toEqual([])
    expect(world.getHead('main')).toEqual(some(base.id))

    const reopened = new WorldService(new Context(), { driver: baseDriver })
    expect(sortedIds(reopened.listLeaves())).toEqual(sortedIds(snapshot.leaves))
    expect(reopened.getHead('main')).toEqual(some(base.id))

    const committed = unwrap(world.commit(input))
    expect(world.hasCommit(committed.id)).toBe(true)
    expect(world.getHead('main')).toEqual(some(committed.id))
    expect(unwrap(world.getReferencingCommits(target.id))).toEqual([committed.id])
    expect(events).toEqual([`committed:${committed.id}`, `head:main:${committed.id}`])
    expectResidencyConsistent(world)
    expect(value(world, committed.id, ['fresh'])).toBe(42)
    expect(unwrap(world.getRef(committed.id, ['link']))).toEqual(
      some({ commitId: target.id, path: [] }),
    )
  })

  test('setHead hydration failure after the first added leaf keeps residency and retries', () => {
    const baseDriver = createBunSqliteDriver()
    drivers.push(baseDriver)
    const control: FaultControl = {}
    const driver = createFaultDriver(baseDriver, control)
    const ctx = new Context()
    const world = new WorldService(ctx, { driver })

    commit(world, null, [{ op: 'set', path: ['warm'], value: true }], {
      advanceHead: 'main',
    })
    const cold = commit(world, null, [
      { op: 'set', path: ['cold', 'a'], value: 1 },
      { op: 'set', path: ['cold', 'b'], value: 2 },
      { op: 'set', path: ['cold', 'c'], value: 3 },
      { op: 'set', path: ['cold', 'd'], value: 4 },
    ])
    const snapshot = residencySnapshot(world)
    const events: string[] = []
    ctx.on('world/head-updated', (name) => {
      events.push(`head:${name}`)
    })

    let active = true
    let hits = 0
    control.hydration = (params) => {
      if (!active || params[0] !== cold.id) return false
      hits++
      return hits > 1
    }
    const failed = world.setHead('cold', cold.id)
    active = false

    expect(failed).toMatchObject({ ok: false, error: { kind: 'storage_error' } })
    expect(hits).toBeGreaterThanOrEqual(2)
    expect(residencySnapshot(world)).toEqual(snapshot)
    expect(events).toEqual([])
    expect(world.getHead('cold')).toEqual(NONE)

    const reopened = new WorldService(new Context(), { driver: baseDriver })
    expect(reopened.listHeads()).toEqual(snapshot.heads)

    unwrap(world.setHead('cold', cold.id))
    expect(events).toEqual(['head:cold'])
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(5)
    expect(value(world, cold.id, ['cold', 'd'])).toBe(4)
  })

  test('commit hydrate failure after an added leaf rolls back and retries', () => {
    const baseDriver = createBunSqliteDriver()
    drivers.push(baseDriver)
    const control: FaultControl = {}
    const driver = createFaultDriver(baseDriver, control)
    const ctx = new Context()
    const world = new WorldService(ctx, { driver })

    const base = commit(world, null, [{ op: 'set', path: ['warm'], value: true }], {
      advanceHead: 'main',
    })
    const input: CommitInput = {
      parentId: some(base.id),
      message: 'hydrate me',
      diff: [
        { op: 'set', path: ['a'], value: 1 },
        { op: 'set', path: ['b'], value: 2 },
        { op: 'set', path: ['c'], value: 3 },
        { op: 'set', path: ['d'], value: 4 },
      ],
      advanceHead: 'main',
    }
    const snapshot = residencySnapshot(world)
    const events: string[] = []
    ctx.on('world/committed', () => {
      events.push('committed')
    })
    ctx.on('world/head-updated', () => {
      events.push('head')
    })

    let active = true
    let hits = 0
    // Coordinate-specific: only the four newly added root leaves may fail, and
    // only after the first one has already been hydrated into the prepared plan.
    const addedKeys = new Set(['a', 'b', 'c', 'd'].map((name) => encodePathKey([name])))
    const decoder = new TextDecoder()
    control.hydration = (params) => {
      if (!active || typeof params[0] !== 'string') return false
      const encoded = params[1]
      if (!(encoded instanceof Uint8Array) || !addedKeys.has(decoder.decode(encoded))) return false
      hits++
      return hits > 1
    }
    const failed = world.commit(input)
    active = false

    expect(failed).toMatchObject({ ok: false, error: { kind: 'storage_error' } })
    expect(hits).toBeGreaterThanOrEqual(2)
    expect(residencySnapshot(world)).toEqual(snapshot)
    expect(events).toEqual([])

    const reopened = new WorldService(new Context(), { driver: baseDriver })
    expect(sortedIds(reopened.listLeaves())).toEqual(sortedIds(snapshot.leaves))

    const committed = unwrap(world.commit(input))
    expect(world.getHead('main')).toEqual(some(committed.id))
    expect(events).toEqual(['committed', 'head'])
    expectResidencyConsistent(world)
    expect(hotTotal(world)).toBe(5)
    expect(value(world, committed.id, ['d'])).toBe(4)
  })

  test('corrupt persisted values raise InvariantError without publishing a head', () => {
    const { world, driver, ctx } = setup()
    commit(world, null, [{ op: 'set', path: ['ok'], value: 1 }], {
      advanceHead: 'main',
    })
    const corrupt = commit(world, null, [
      { op: 'set', path: ['a'], value: 1 },
      { op: 'set', path: ['b'], value: 'x' },
      { op: 'set', path: ['c'], value: true },
    ])
    driver
      .prepare('UPDATE diff_entries SET val_type = 9 WHERE commit_id = ? AND op = 1')
      .run(corrupt.id)

    const snapshot = residencySnapshot(world)
    const events: string[] = []
    ctx.on('world/head-updated', () => {
      events.push('head')
    })

    expect(() => world.setHead('bad', corrupt.id)).toThrow(InvariantError)
    expect(residencySnapshot(world)).toEqual(snapshot)
    expect(world.getHead('bad')).toEqual(NONE)
    expect(events).toEqual([])
    expect(() => world.getValue(corrupt.id, ['a'])).toThrow(InvariantError)

    const reopened = new WorldService(new Context(), { driver })
    expect(reopened.listHeads()).toEqual(snapshot.heads)
    expect(sortedIds(reopened.listLeaves())).toEqual(sortedIds(snapshot.leaves))
    expect(() => reopened.getValue(corrupt.id, ['a'])).toThrow(InvariantError)
  })
})
