import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type {
  CommitHash,
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

/* -------------------------------------------------------------------------- */
/*                              Narrow test surface                           */
/* -------------------------------------------------------------------------- */

interface HotEntryView {
  readonly box: { readonly value: LeafEntry }
  readonly count: number
}

type HotPlan =
  | { readonly kind: 'patch'; readonly entries: ReadonlyMap<string, HotEntryView | undefined> }
  | { readonly kind: 'clear' }

/** Narrow cast onto the private residency state; no public diagnostics API exists. */
interface StorageView {
  readonly commits: ReadonlyMap<CommitHash, { readonly index: OriginDirectoryNode }>
  readonly heads: Map<string, CommitHash>
  readonly hot: ReadonlyMap<string, HotEntryView>
  entry(id: CommitHash, pathKey: string): LeafEntry
  prepareHot(
    oldIndex: OriginDirectoryNode | undefined,
    newIndex: OriginDirectoryNode | undefined,
  ): HotPlan | undefined
  installHot(update: HotPlan): void
}

function storageOf(world: WorldService): StorageView {
  const candidate: unknown = world
  if (typeof candidate !== 'object' || candidate === null || !('storage' in candidate))
    throw new Error('WorldService does not expose its storage')
  // Residency internals are private; this suite is the narrow test seam onto them.
  const storage = candidate.storage as StorageView
  return storage
}

function indexOf(world: WorldService, id: CommitHash): OriginDirectoryNode {
  const record = storageOf(world).commits.get(id)
  if (!record) throw new Error(`missing commit ${id}`)
  return record.index
}

/** Substitute a coherent guarded root so a test can prove a subtree was never read. */
function replaceIndex(world: WorldService, id: CommitHash, index: OriginDirectoryNode): void {
  const record = storageOf(world).commits.get(id)
  if (!record) throw new Error(`missing commit ${id}`)
  // `index` is readonly only in the declared shape; tests substitute coherent roots.
  const mutable = record as { index: OriginDirectoryNode }
  mutable.index = index
}

/* -------------------------------------------------------------------------- */
/*                              Setup & helpers                               */
/* -------------------------------------------------------------------------- */

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function newWorld(dbPath?: string): { world: WorldService; driver: SqliteDriver } {
  const driver = createBunSqliteDriver(dbPath === undefined ? {} : { dbPath })
  drivers.push(driver)
  return { world: new WorldService(new Context(), { driver }), driver }
}

function closeDriver(driver: SqliteDriver): void {
  const at = drivers.indexOf(driver)
  if (at !== -1) drivers.splice(at, 1)
  driver.close()
}

function unwrap<T>(result: Result<T, WorldError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function commit(world: WorldService, parent: CommitNode | null, diff: StateDiff): CommitNode {
  return unwrap(
    world.commit({ parentId: parent === null ? NONE : some(parent.id), message: null, diff }),
  )
}

function set(path: readonly string[], value: Value): StateDiff[number] {
  return { op: 'set', path, value }
}

function del(path: readonly string[]): StateDiff[number] {
  return { op: 'del', path }
}

function ref(path: readonly string[], commitId: CommitHash, target: readonly string[]) {
  return { op: 'ref' as const, path, ref: { commitId, path: target } }
}

function setHead(world: WorldService, name: string, id: CommitHash): void {
  unwrap(world.setHead(name, id))
}

/** Find the resident entry for a physical `(origin, path)` leaf by value identity. */
function resident(
  world: WorldService,
  origin: CommitHash,
  path: readonly string[],
): { key: string; entry: HotEntryView } | undefined {
  const storage = storageOf(world)
  const target = storage.entry(origin, encodePathKey(path))
  for (const [key, entry] of storage.hot) {
    if (entry.box.value === target) return { key, entry }
  }
  return undefined
}

function residentCount(
  world: WorldService,
  origin: CommitHash,
  path: readonly string[],
): number | undefined {
  return resident(world, origin, path)?.entry.count
}

/**
 * Independent residency oracle: fully walk every active Head (aliases counted
 * once per name) and require the strong Hot map to hold exactly the physical
 * leaves those Heads reach, with matching per-Head counts and no extra keys.
 */
function assertResidency(world: WorldService): void {
  const storage = storageOf(world)
  const expected = new Map<LeafEntry, number>()
  let incidences = 0
  for (const commitId of storage.heads.values()) {
    const stack: { node: OriginTreeNode; path: readonly string[] }[] = [
      { node: indexOf(world, commitId), path: [] },
    ]
    while (stack.length > 0) {
      const { node, path } = stack.pop()!
      if (node.kind === 'dir') {
        for (const [name, child] of node.children) {
          stack.push({ node: child, path: [...path, name] })
        }
        continue
      }
      const entry = storage.entry(node.originCommitId, encodePathKey(path))
      expected.set(entry, (expected.get(entry) ?? 0) + 1)
      incidences++
    }
  }
  expect(storage.hot.size).toBe(expected.size)
  const seen = new Set<LeafEntry>()
  let sum = 0
  for (const [key, hotEntry] of storage.hot) {
    const count = expected.get(hotEntry.box.value)
    if (count === undefined) throw new Error(`Resident leaf is unreachable from every Head: ${key}`)
    if (seen.has(hotEntry.box.value)) throw new Error(`Duplicate resident box for ${key}`)
    seen.add(hotEntry.box.value)
    expect(hotEntry.count).toBe(count)
    expect(hotEntry.count).toBeGreaterThan(0)
    sum += hotEntry.count
  }
  expect(sum).toBe(incidences)
}

/* -------------------------------------------------------------------------- */
/*                          Unchanged-subtree guard                           */
/* -------------------------------------------------------------------------- */

/**
 * `ReadonlyMap` wrapper that records child access. A correct incremental diff
 * must never read the children of a node whose object identity is shared
 * between the old and new index trees.
 */
class GuardedChildren implements ReadonlyMap<string, OriginTreeNode> {
  readonly #inner: ReadonlyMap<string, OriginTreeNode>
  readonly #reads: { count: number }

  constructor(inner: ReadonlyMap<string, OriginTreeNode>, reads: { count: number }) {
    this.#inner = inner
    this.#reads = reads
  }

  get size(): number {
    return this.#inner.size
  }

  get(key: string): OriginTreeNode | undefined {
    this.#reads.count++
    return this.#inner.get(key)
  }

  has(key: string): boolean {
    this.#reads.count++
    return this.#inner.has(key)
  }

  entries(): MapIterator<[string, OriginTreeNode]> {
    this.#reads.count++
    return this.#inner.entries()
  }

  keys(): MapIterator<string> {
    this.#reads.count++
    return this.#inner.keys()
  }

  values(): MapIterator<OriginTreeNode> {
    this.#reads.count++
    return this.#inner.values()
  }

  forEach(
    callbackfn: (
      value: OriginTreeNode,
      key: string,
      map: ReadonlyMap<string, OriginTreeNode>,
    ) => void,
    thisArg?: unknown,
  ): void {
    this.#reads.count++
    this.#inner.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this)
    })
  }

  [Symbol.iterator](): MapIterator<[string, OriginTreeNode]> {
    this.#reads.count++
    return this.#inner[Symbol.iterator]()
  }
}

function guardDir(node: OriginDirectoryNode, reads: { count: number }): OriginDirectoryNode {
  return Object.freeze({
    kind: 'dir' as const,
    lastModifiedAt: node.lastModifiedAt,
    children: new GuardedChildren(node.children, reads),
  })
}

function coherentRoot(
  node: OriginDirectoryNode,
  guardedPath: string,
  guarded: OriginDirectoryNode,
): OriginDirectoryNode {
  return Object.freeze({
    kind: 'dir' as const,
    lastModifiedAt: node.lastModifiedAt,
    children: new Map(node.children).set(guardedPath, guarded),
  })
}

/* -------------------------------------------------------------------------- */
/*                                  Tests                                     */
/* -------------------------------------------------------------------------- */

describe('world hot residency oracle', () => {
  test('startup weights aliases and shared no-op roots per Head across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sekaisen-world-hot-'))
    try {
      const dbPath = join(directory, 'world.sqlite')
      const first = newWorld(dbPath)
      const base = commit(first.world, null, [
        set(['data', 'a'], 1),
        set(['data', 'bytes'], new Uint8Array([0, 255, 128])),
        set(['data', 'bom'], '\uFEFFheader'),
        set(['root'], true),
      ])
      // An empty diff reuses the parent's index object verbatim.
      const noop = commit(first.world, base, [])
      expect(indexOf(first.world, noop.id)).toBe(indexOf(first.world, base.id))

      setHead(first.world, 'left', base.id)
      setHead(first.world, 'alias', base.id)
      setHead(first.world, 'noop', noop.id)
      assertResidency(first.world)
      for (const entry of storageOf(first.world).hot.values()) expect(entry.count).toBe(3)

      closeDriver(first.driver)
      const second = newWorld(dbPath)
      expect(second.world.listHeads()).toEqual({
        left: base.id,
        alias: base.id,
        noop: noop.id,
      })
      // Startup groups by exact index object: three Heads, one walk, count 3.
      assertResidency(second.world)
      for (const entry of storageOf(second.world).hot.values()) expect(entry.count).toBe(3)
      expect(residentCount(second.world, base.id, ['data', 'a'])).toBe(3)
    } finally {
      for (const driver of [...drivers]) closeDriver(driver)
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('moves one alias while the remaining Head keeps leaves resident', () => {
    const { world } = newWorld()
    const base = commit(world, null, [set(['shared', 'keep'], 'v'), set(['only', 'base'], 1)])
    const moved = commit(world, base, [del(['only', 'base']), set(['only', 'moved'], 2)])
    setHead(world, 'a', base.id)
    setHead(world, 'b', base.id)
    assertResidency(world)
    expect(residentCount(world, base.id, ['shared', 'keep'])).toBe(2)
    expect(residentCount(world, base.id, ['only', 'base'])).toBe(2)

    const sharedBefore = resident(world, base.id, ['shared', 'keep'])
    const baseBefore = resident(world, base.id, ['only', 'base'])
    if (!sharedBefore || !baseBefore) throw new Error('expected resident leaves')

    setHead(world, 'b', moved.id)
    assertResidency(world)
    expect(residentCount(world, base.id, ['shared', 'keep'])).toBe(2)
    expect(residentCount(world, base.id, ['only', 'base'])).toBe(1)
    expect(residentCount(world, moved.id, ['only', 'moved'])).toBe(1)

    const sharedAfter = resident(world, base.id, ['shared', 'keep'])
    if (!sharedAfter) throw new Error('expected shared leaf still resident')
    // Unchanged leaf pair: untouched entry object and box.
    expect(sharedAfter.key).toBe(sharedBefore.key)
    expect(sharedAfter.entry).toBe(sharedBefore.entry)
    expect(sharedAfter.entry.box).toBe(sharedBefore.entry.box)

    const baseAfter = resident(world, base.id, ['only', 'base'])
    if (!baseAfter) throw new Error('expected decremented leaf still resident')
    // Decrement replaces the entry object/count but reuses the resident box.
    expect(baseAfter.entry).not.toBe(baseBefore.entry)
    expect(baseAfter.entry.box).toBe(baseBefore.entry.box)
    expect(baseBefore.entry.count).toBe(2)
    expect(baseAfter.entry.count).toBe(1)
  })

  test('converges and diverges Head states with per-Head counts', () => {
    const { world } = newWorld()
    const root = commit(world, null, [set(['base'], 0)])
    const left = commit(world, root, [set(['left'], 1)])
    const right = commit(world, root, [set(['right'], 2)])
    setHead(world, 'l', left.id)
    setHead(world, 'r', right.id)
    assertResidency(world)
    expect(residentCount(world, left.id, ['left'])).toBe(1)
    expect(residentCount(world, right.id, ['right'])).toBe(1)
    expect(residentCount(world, root.id, ['base'])).toBe(2)

    setHead(world, 'r', left.id)
    assertResidency(world)
    expect(residentCount(world, left.id, ['left'])).toBe(2)
    expect(resident(world, right.id, ['right'])).toBeUndefined()
    expect(residentCount(world, root.id, ['base'])).toBe(2)

    setHead(world, 'l', right.id)
    assertResidency(world)
    expect(residentCount(world, right.id, ['right'])).toBe(1)
    expect(residentCount(world, left.id, ['left'])).toBe(1)
    expect(residentCount(world, root.id, ['base'])).toBe(2)
  })

  test('treats no-op commits and shared index roots as identity no-ops', () => {
    const { world } = newWorld()
    const base = commit(world, null, [set(['a'], 1), set(['b'], 2)])
    const noop = commit(world, base, [])
    setHead(world, 'a', base.id)
    assertResidency(world)

    // Adding a second Head to the shared no-op root adds one count per leaf.
    setHead(world, 'b', noop.id)
    assertResidency(world)
    for (const entry of storageOf(world).hot.values()) expect(entry.count).toBe(2)

    // Moving a Head between two commits that share one index object is a no-op.
    const before = [...storageOf(world).hot]
    setHead(world, 'a', noop.id)
    const after = [...storageOf(world).hot]
    expect(after.length).toBe(before.length)
    for (let index = 0; index < before.length; index++) {
      expect(after[index]![0]).toBe(before[index]![0])
      expect(after[index]![1]).toBe(before[index]![1])
    }
    assertResidency(world)
    for (const entry of storageOf(world).hot.values()) expect(entry.count).toBe(2)
  })

  test('tracks directory/leaf shape swaps and subtree replacement', () => {
    const { world } = newWorld()
    const c0 = commit(world, null, [set(['a'], 1), set(['d', 'x'], 2), set(['d', 'y'], 3)])
    const c1 = commit(world, c0, [del(['a']), set(['a', 'child'], 4)])
    const c2 = commit(world, c1, [del(['a', 'child']), set(['a'], 5)])
    const c3 = commit(world, c2, [del(['d', 'x']), del(['d', 'y']), set(['d'], 6)])
    const c4 = commit(world, c3, [del(['d']), set(['d', 'z'], 7)])

    setHead(world, 'alias', c0.id)
    setHead(world, 'main', c0.id)
    assertResidency(world)

    for (const id of [c1.id, c2.id, c3.id, c4.id]) {
      setHead(world, 'main', id)
      assertResidency(world)
    }
    // The alias still holds the original leaves while `main` moved through shapes.
    expect(residentCount(world, c0.id, ['a'])).toBe(1)
    expect(residentCount(world, c0.id, ['d', 'x'])).toBe(1)
    expect(residentCount(world, c4.id, ['d', 'z'])).toBe(1)
    expect(resident(world, c1.id, ['a', 'child'])).toBeUndefined()
  })

  test('keeps ref, byte, BOM and astral leaves resident through changes', () => {
    const { world } = newWorld()
    const target = commit(world, null, [
      set(['value'], 41),
      set(['blob'], new Uint8Array([0, 255, 128])),
    ])
    const withRef = commit(world, target, [
      ref(['link'], target.id, ['value']),
      ref(['linkBlob'], target.id, ['blob']),
      set(['bytes'], new Uint8Array([1, 2, 3])),
      set(['bom'], '\uFEFFbom'),
      set(['astral'], '\u{1F600}'),
    ] as StateDiff)
    setHead(world, 'h', target.id)
    assertResidency(world)
    setHead(world, 'alias', withRef.id)
    assertResidency(world)
    // The shared physical leaves are reached by both Heads.
    expect(residentCount(world, target.id, ['value'])).toBe(2)
    expect(residentCount(world, target.id, ['blob'])).toBe(2)
    expect(residentCount(world, withRef.id, ['link'])).toBe(1)
    expect(residentCount(world, withRef.id, ['bytes'])).toBe(1)

    setHead(world, 'alias', target.id)
    assertResidency(world)
    expect(resident(world, withRef.id, ['link'])).toBeUndefined()
    expect(resident(world, withRef.id, ['astral'])).toBeUndefined()
  })

  test('releases leaves when their last owning Head is deleted', () => {
    const { world } = newWorld()
    const root = commit(world, null, [set(['base'], 0)])
    const left = commit(world, root, [set(['left'], 1)])
    const right = commit(world, root, [set(['right'], 2)])
    setHead(world, 'l', left.id)
    setHead(world, 'r', right.id)
    assertResidency(world)

    unwrap(world.deleteHead('r'))
    assertResidency(world)
    expect(resident(world, right.id, ['right'])).toBeUndefined()
    expect(residentCount(world, root.id, ['base'])).toBe(1)

    unwrap(world.deleteHead('l'))
    assertResidency(world)
    expect(storageOf(world).hot.size).toBe(0)
  })

  test('prepare leaves live residency untouched until install', () => {
    const { world } = newWorld()
    const base = commit(world, null, [set(['a'], 1)])
    const next = commit(world, base, [set(['b'], 2)])
    setHead(world, 'h', base.id)
    const storage = storageOf(world)
    const before = [...storage.hot]

    const plan = storage.prepareHot(indexOf(world, base.id), indexOf(world, next.id))
    if (plan?.kind !== 'patch') throw new Error('expected a patch plan')
    expect(plan.entries.size).toBe(1)

    const after = [...storage.hot]
    expect(after.length).toBe(before.length)
    for (let index = 0; index < before.length; index++) {
      expect(after[index]![0]).toBe(before[index]![0])
      expect(after[index]![1]).toBe(before[index]![1])
    }
    expect(resident(world, next.id, ['b'])).toBeUndefined()

    storage.heads.set('h', next.id)
    storage.installHot(plan)
    assertResidency(world)
    expect(residentCount(world, next.id, ['b'])).toBe(1)
  })

  test('last-Head deletion releases residency without walking the old tree', () => {
    const { world } = newWorld()
    const bulk: StateDiff = Array.from({ length: 64 }, (_, index) =>
      set(['bulk', `k${index}`], index),
    )
    const head = commit(world, null, [...bulk, set(['nested', 'deep'], 'value')] as StateDiff)
    setHead(world, 'only', head.id)
    const storage = storageOf(world)

    const reads = { count: 0 }
    const guarded = guardDir(indexOf(world, head.id), reads)
    replaceIndex(world, head.id, guarded)

    const before = [...storage.hot]
    storage.prepareHot(guarded, undefined)
    expect(reads.count).toBe(0)
    const afterPrepare = [...storage.hot]
    expect(afterPrepare.length).toBe(before.length)
    for (let index = 0; index < before.length; index++) {
      expect(afterPrepare[index]![0]).toBe(before[index]![0])
      expect(afterPrepare[index]![1]).toBe(before[index]![1])
    }

    unwrap(world.deleteHead('only'))
    expect(reads.count).toBe(0)
    expect(storage.hot.size).toBe(0)
    assertResidency(world)
  })

  test('single Head moving to an empty root clears without walking the old tree', () => {
    const { world } = newWorld()
    const empty = commit(world, null, [])
    const populated = commit(world, empty, [set(['a'], 1), set(['b'], 2)])
    setHead(world, 'only', populated.id)
    const storage = storageOf(world)

    const reads = { count: 0 }
    replaceIndex(world, populated.id, guardDir(indexOf(world, populated.id), reads))

    setHead(world, 'only', empty.id)
    expect(reads.count).toBe(0)
    expect(storage.hot.size).toBe(0)
    assertResidency(world)
  })

  test('adding an empty Head preserves another Head residency', () => {
    const { world } = newWorld()
    const populated = commit(world, null, [set(['a'], 1)])
    const empty = commit(world, null, [])
    setHead(world, 'keep', populated.id)
    const storage = storageOf(world)
    const before = [...storage.hot]

    setHead(world, 'empty', empty.id)
    assertResidency(world)
    const afterAdd = [...storage.hot]
    expect(afterAdd.length).toBe(before.length)
    for (let index = 0; index < before.length; index++) {
      expect(afterAdd[index]![1]).toBe(before[index]![1])
    }
    expect(residentCount(world, populated.id, ['a'])).toBe(1)
  })

  test('skips unchanged shared subtrees during a Head move', () => {
    const { world } = newWorld()
    const shared: StateDiff = Array.from({ length: 64 }, (_, index) =>
      set(['shared', `k${index}`], index),
    )
    const base = commit(world, null, [...shared, set(['x'], 0)] as StateDiff)
    const changed = commit(world, base, [set(['x'], 1)])
    const baseRoot = indexOf(world, base.id)
    const changedRoot = indexOf(world, changed.id)
    const sharedNode = baseRoot.children.get('shared')
    expect(sharedNode).toBe(changedRoot.children.get('shared'))
    if (sharedNode?.kind !== 'dir') throw new Error('expected shared directory')

    setHead(world, 'a', base.id)
    const reads = { count: 0 }
    const guarded = guardDir(sharedNode, reads)
    replaceIndex(world, base.id, coherentRoot(baseRoot, 'shared', guarded))
    replaceIndex(world, changed.id, coherentRoot(changedRoot, 'shared', guarded))

    setHead(world, 'a', changed.id)
    // The shared branch is skipped by object identity before its children are read.
    expect(reads.count).toBe(0)
    assertResidency(world)
    expect(residentCount(world, changed.id, ['x'])).toBe(1)
    expect(resident(world, base.id, ['x'])).toBeUndefined()
    expect(residentCount(world, base.id, ['shared', 'k0'])).toBe(1)
  })
})
