import { afterEach, describe, expect, test } from 'bun:test'
import type { Result } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import type {
  CommitHash,
  CommitNode,
  SqliteDriver,
  StateDiff,
  TreeNodeView,
  Value,
  WorldError,
} from '@sekaisen/plugin-world'
import { WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'

function unwrap<T>(result: Result<T, WorldError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}
const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})
function setup() {
  const driver = createBunSqliteDriver()
  drivers.push(driver)
  const ctx = new Context()
  return { driver, ctx, world: new WorldService(ctx, { driver }) }
}
function commit(
  world: WorldService,
  parent: CommitNode | null,
  diff: StateDiff,
  message: Value = null,
): CommitNode {
  return unwrap(world.commit({ parentId: parent ? some(parent.id) : NONE, diff, message }))
}
function value(world: WorldService, id: CommitHash, path: readonly string[]): Value {
  const result = unwrap(world.getValue(id, path))
  if (result.kind === 'none') throw new Error('Expected value')
  return result.value
}
function leaf(view: TreeNodeView): Value {
  if (view.nodeKind !== 'leaf' || view.entry.entryKind !== 'val')
    throw new Error('Expected value leaf')
  return view.entry.value
}

describe('world forest', () => {
  test('canonical hashes, CAS before deduplication, and byte boundaries', () => {
    const { world } = setup()
    const inputBytes = new Uint8Array([1, 2])
    const root = unwrap(
      world.commit({
        parentId: NONE,
        message: inputBytes,
        diff: [
          { op: 'set', path: ['b'], value: inputBytes },
          { op: 'set', path: ['a'], value: '000123' },
        ],
        advanceHead: 'main',
      }),
    )
    inputBytes[0] = 9
    expect(value(world, root.id, ['b'])).toEqual(new Uint8Array([1, 2]))
    ;(root.message as Uint8Array)[0] = 8
    expect(unwrap(world.getMessage(root.id))).toEqual(new Uint8Array([1, 2]))
    const read = value(world, root.id, ['b']) as Uint8Array
    read[0] = 7
    expect(value(world, root.id, ['b'])).toEqual(new Uint8Array([1, 2]))
    const duplicate = unwrap(
      world.commit({
        parentId: NONE,
        message: new Uint8Array([1, 2]),
        diff: [
          { op: 'set', path: ['a'], value: '000123' },
          { op: 'set', path: ['b'], value: new Uint8Array([1, 2]) },
        ],
      }),
    )
    expect(duplicate.id).toBe(root.id)
    const nextInput = {
      parentId: some(root.id),
      message: null,
      diff: [],
      advanceHead: 'main',
    } as const
    const next = unwrap(world.commit(nextInput))
    expect(world.commit(nextInput)).toMatchObject({
      ok: false,
      error: { kind: 'head_cas_mismatch' },
    })
    expect(
      unwrap(world.commit({ ...nextInput, advanceHead: { name: 'main', expected: some(next.id) } }))
        .id,
    ).toBe(next.id)
    unwrap(world.deleteHead('main'))
    expect(world.setHead('main', root.id, some(next.id))).toMatchObject({
      ok: false,
      error: { kind: 'head_cas_mismatch', actual: NONE },
    })
    unwrap(world.setHead('main', root.id, NONE))
    expect(world.setHead('main', next.id, NONE)).toMatchObject({
      ok: false,
      error: { kind: 'head_cas_mismatch' },
    })
  })

  test('two-phase shape replacement and empty-directory pruning', () => {
    const { world } = setup()
    const root = commit(world, null, [{ op: 'set', path: ['a'], value: 1 }])
    const directory = commit(world, root, [
      { op: 'set', path: ['a', 'x'], value: 2 },
      { op: 'del', path: ['a'] },
    ])
    expect(value(world, directory.id, ['a', 'x'])).toBe(2)
    const replaced = commit(world, directory, [
      { op: 'set', path: ['a'], value: 3 },
      { op: 'del', path: ['a', 'x'] },
    ])
    expect(value(world, replaced.id, ['a'])).toBe(3)
    const deleted = commit(world, replaced, [{ op: 'del', path: ['a'] }])
    expect(unwrap(world.getNode(deleted.id, ['a']))).toEqual(NONE)
    expect(
      world.commit({
        parentId: some(deleted.id),
        message: null,
        diff: [{ op: 'del', path: ['a'] }],
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'invalid_diff', reason: 'delete_non_existent_path' },
    })
    expect(
      world.commit({
        parentId: some(directory.id),
        message: null,
        diff: [{ op: 'set', path: ['a'], value: 0 }],
      }),
    ).toMatchObject({ ok: false, error: { kind: 'structure_conflict' } })
  })

  test('persistent refs pin nodes; deletion releases only outgoing edges', () => {
    const { world, driver } = setup()
    const target = commit(world, null, [{ op: 'set', path: ['x'], value: 1 }])
    const source = commit(world, null, [
      { op: 'ref', path: ['link'], ref: { commitId: target.id, path: [] } },
    ])
    expect(world.popLeaf(target.id)).toMatchObject({
      ok: false,
      error: {
        kind: 'leaf_not_deletable',
        reason: 'pinned_by_refs',
        referencedByCommits: [source.id],
      },
    })
    const loaded = new WorldService(new Context(), { driver })
    expect(loaded.popLeaf(target.id)).toMatchObject({
      ok: false,
      error: { kind: 'leaf_not_deletable', reason: 'pinned_by_refs' },
    })
    unwrap(loaded.popLeaf(source.id))
    unwrap(loaded.popLeaf(target.id))
    expect(loaded.listRoots()).toEqual([])
  })

  test('startup rejects missing and extra persistent ref edges', () => {
    const { world, driver } = setup()
    const target = commit(world, null, [])
    const source = commit(world, null, [
      { op: 'ref', path: ['r'], ref: { commitId: target.id, path: [] } },
    ])
    driver.prepare('DELETE FROM commit_refs WHERE source_commit_id = ?').run(source.id)
    expect(() => new WorldService(new Context(), { driver })).toThrow(InvariantError)
    driver.prepare('INSERT INTO commit_refs VALUES (?,?)').run(source.id, target.id)
    driver.prepare('INSERT INTO commit_refs VALUES (?,?)').run(target.id, source.id)
    expect(() => new WorldService(new Context(), { driver })).toThrow(InvariantError)
    driver
      .prepare('DELETE FROM commit_refs WHERE source_commit_id = ? AND target_commit_id = ?')
      .run(target.id, source.id)
    const deleted = commit(world, source, [{ op: 'del', path: ['r'] }])
    driver.prepare('UPDATE diff_entries SET val_type = 0 WHERE commit_id = ?').run(deleted.id)
    expect(() => new WorldService(new Context(), { driver })).toThrow(InvariantError)
  })

  test('BOM, NUL, lists, numeric text and prototype-like head names survive restart', () => {
    const { world, driver } = setup()
    const values: Value = ['\uFEFFhello', '\0', '000123', false, 1, new Uint8Array([0, 255]), null]
    const root = unwrap(
      world.commit({
        parentId: NONE,
        message: values,
        diff: [{ op: 'set', path: ['\uFEFF', 'x\0'], value: '\uFEFF000123' }],
        advanceHead: '\uFEFFmain\0',
      }),
    )
    unwrap(world.setHead('__proto__', root.id))
    const loaded = new WorldService(new Context(), { driver })
    expect(unwrap(loaded.getMessage(root.id))).toEqual(values)
    expect(value(loaded, root.id, ['\uFEFF', 'x\0'])).toBe('\uFEFF000123')
    expect(loaded.getHead('\uFEFFmain\0')).toEqual(some(root.id))
    // biome-ignore lint/suspicious/noProto: Intentionally exercise __proto__ head name.
    expect(loaded.listHeads().__proto__).toBe(root.id)
    unwrap(loaded.deleteHead('\uFEFFmain\0', some(root.id)))
    expect(loaded.getHead('\uFEFFmain\0')).toEqual(NONE)
  })

  test('change detection uses content, not origin identity; detached views cannot mutate state', () => {
    const { world } = setup()
    const a = commit(world, null, [{ op: 'set', path: ['x'], value: 1 }])
    const b = commit(world, a, [{ op: 'set', path: ['x'], value: 2 }])
    const c = commit(world, b, [{ op: 'set', path: ['x'], value: 1 }])
    expect(unwrap(world.isRefChanged({ commitId: a.id, path: [] }, c.id))).toBe(false)
    expect(unwrap(world.isRefChanged({ commitId: a.id, path: ['x'] }, b.id))).toBe(true)
    const view = unwrap(world.getNode(a.id))
    if (view.kind !== 'some' || view.value.nodeKind !== 'dir') throw new Error('Expected root')
    ;(view.value.entries as Map<string, TreeNodeView>).clear()
    expect(value(world, a.id, ['x'])).toBe(1)
  })

  test('events are synchronous, isolated and write-locked until all listeners finish', () => {
    const { world, ctx } = setup()
    const order: string[] = []
    ctx.on('world/committed', () => {
      order.push('first')
      expect(() => world.deleteHead('main')).toThrow(InvariantError)
      throw new Error('listener failure')
    })
    ctx.on('world/committed', (node) => {
      order.push('second')
      expect(world.hasCommit(node.id)).toBe(true)
      expect(world.getHead('main')).toEqual(some(node.id))
    })
    ctx.on('world/head-updated', () => {
      order.push('head')
      expect(() => world.commit({ parentId: NONE, message: null })).toThrow(InvariantError)
    })
    const result = world.commit({ parentId: NONE, message: null, advanceHead: 'main' })
    expect(result.ok).toBe(true)
    expect(order).toEqual(['first', 'second', 'head'])
  })
})

describe('rebase atomic prefix groups', () => {
  test('identity replay preserves delete-and-restore group and same-change converges', () => {
    const { world } = setup()
    const root = commit(world, null, [
      { op: 'set', path: ['a', 'x'], value: 1 },
      { op: 'set', path: ['a', 'y'], value: 1 },
    ])
    const source = commit(world, root, [
      { op: 'del', path: ['a'] },
      { op: 'set', path: ['a', 'x'], value: 1 },
    ])
    const replay = unwrap(world.rebase([source.id], root.id))
    if (replay.status !== 'completed') throw new Error('Expected identity completion')
    expect(replay.newTipId).toBe(source.id)
    expect(unwrap(world.getNode(replay.newTipId, ['a', 'y']))).toEqual(NONE)
    const same = unwrap(world.rebase([source.id], source.id))
    if (same.status !== 'completed') throw new Error('Expected convergence')
    expect(value(world, same.newTipId, ['a', 'x'])).toBe(1)
    expect(unwrap(world.getNode(same.newTipId, ['a', 'y']))).toEqual(NONE)
  })

  test('shape changes replay identically and report divergent edits without writes', () => {
    const { world } = setup()
    const base = commit(world, null, [{ op: 'set', path: ['a'], value: 1 }])
    const source = commit(world, base, [
      { op: 'del', path: ['a'] },
      { op: 'set', path: ['a', 'x'], value: 2 },
    ])
    expect(unwrap(world.rebase([source.id], base.id))).toMatchObject({
      status: 'completed',
      newTipId: source.id,
    })
    const target = commit(world, base, [{ op: 'set', path: ['a'], value: 3 }])
    const before = world.getChildren(target.id)
    const outcome = unwrap(world.rebase([source.id], target.id))
    expect(outcome).toMatchObject({
      status: 'conflict',
      currentTipId: target.id,
      remainingSourceIds: [source.id],
      conflicts: [{ path: ['a'], reason: 'structure_conflict' }],
    })
    expect(world.getChildren(target.id)).toEqual(before)
  })

  test('deleted ancestors conflict for writes but converge for deletes', () => {
    const { world } = setup()
    const root = commit(world, null, [
      { op: 'set', path: ['a', 'x'], value: 1 },
      { op: 'set', path: ['a', 'y'], value: 3 },
    ])
    const source = commit(world, root, [
      { op: 'set', path: ['a', 'x'], value: 2 },
      { op: 'set', path: ['a', 'z'], value: 4 },
    ])
    const target = commit(world, root, [{ op: 'del', path: ['a'] }])
    const ancestorOutcome = unwrap(world.rebase([source.id], target.id))
    expect(ancestorOutcome).toMatchObject({
      status: 'conflict',
      conflicts: [{ path: ['a'], reason: 'target_deleted_subtree' }],
    })
    if (ancestorOutcome.status !== 'conflict') throw new Error('Expected conflict')
    expect(ancestorOutcome.conflicts.length).toBe(1)
    const incomingDir = ancestorOutcome.conflicts[0]?.incomingNode
    if (incomingDir?.kind !== 'some' || incomingDir.value.nodeKind !== 'dir')
      throw new Error('Expected incomingNode at ancestor path to be the full directory view')
    expect([...incomingDir.value.entries.keys()]).toEqual(['x', 'y', 'z'])
    expect(leaf(incomingDir.value.entries.get('x')!)).toBe(2)
    expect(leaf(incomingDir.value.entries.get('y')!)).toBe(3)
    expect(leaf(incomingDir.value.entries.get('z')!)).toBe(4)
    const deletion = commit(world, root, [{ op: 'del', path: ['a', 'x'] }])
    expect(unwrap(world.rebase([deletion.id], target.id))).toMatchObject({ status: 'completed' })
    const baseWithRef = commit(world, null, [
      { op: 'set', path: ['a', 'x'], value: 1 },
      { op: 'ref', path: ['a', 'y'], ref: { commitId: root.id, path: ['a', 'x'] } },
    ])
    const deleteChild = commit(world, baseWithRef, [{ op: 'del', path: ['a', 'x'] }])
    const ancestorTurnedLeaf = commit(world, baseWithRef, [
      { op: 'del', path: ['a', 'x'] },
      { op: 'del', path: ['a', 'y'] },
      { op: 'set', path: ['a'], value: 99 },
    ])
    const conflictOnLeafAncestor = unwrap(
      world.rebase([deleteChild.id], ancestorTurnedLeaf.id, {
        initialRemap: new Map([[root.id, target.id]]),
        remapRefs: 'in_chain',
      }),
    )
    expect(conflictOnLeafAncestor).toMatchObject({
      status: 'conflict',
      conflicts: [{ path: ['a'], reason: 'structure_conflict' }],
    })
    if (conflictOnLeafAncestor.status !== 'conflict') throw new Error('Expected conflict')
    const baseDir = conflictOnLeafAncestor.conflicts[0]?.baseNode
    if (baseDir?.kind !== 'some' || baseDir.value.nodeKind !== 'dir')
      throw new Error('Expected projected base directory')
    expect(baseDir.value.entries.get('y')).toEqual({
      nodeKind: 'leaf',
      entry: { entryKind: 'ref', ref: { commitId: target.id, path: ['a', 'x'] } },
    })
  })

  test('in-chain remapping projects the base as well as incoming refs', () => {
    const { world } = setup()
    const root = commit(world, null, [])
    const first = commit(world, root, [{ op: 'set', path: ['x'], value: 1 }])
    const second = commit(world, first, [
      { op: 'ref', path: ['r'], ref: { commitId: first.id, path: ['x'] } },
    ])
    const third = commit(world, second, [
      { op: 'ref', path: ['r'], ref: { commitId: root.id, path: [] } },
    ])
    const target = commit(world, root, [{ op: 'set', path: ['other'], value: true }])
    const result = unwrap(
      world.rebase([first.id, second.id, third.id], target.id, { remapRefs: 'in_chain' }),
    )
    if (result.status !== 'completed') throw new Error('Unexpected remap conflict')
    const remappedSecond = result.remappedIds.get(second.id)!
    const ref = unwrap(world.getRef(remappedSecond, ['r']))
    expect(ref).toEqual(some({ commitId: result.remappedIds.get(first.id)!, path: ['x'] }))
    const finalRef = unwrap(world.getRef(result.newTipId, ['r']))
    expect(finalRef).toEqual(some({ commitId: root.id, path: [] }))
    const deref = unwrap(world.deref({ commitId: result.newTipId, path: ['x'] }))
    if (deref.kind !== 'some') throw new Error('Missing replayed value')
    expect(leaf(deref.value)).toBe(1)
  })
})

test('transaction failure rolls back node, head and pin updates without events', () => {
  const { world, driver, ctx } = setup()
  const root = commit(world, null, [])
  unwrap(world.setHead('main', root.id))
  let events = 0
  ctx.on('world/committed', () => {
    events++
  })
  driver.exec(
    "CREATE TRIGGER fail_head BEFORE UPDATE ON heads BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  )
  const result = world.commit({
    parentId: some(root.id),
    message: 'failed',
    diff: [{ op: 'ref', path: ['r'], ref: { commitId: root.id, path: [] } }],
    advanceHead: 'main',
  })
  expect(result).toMatchObject({ ok: false, error: { kind: 'storage_error' } })
  expect(world.getHead('main')).toEqual(some(root.id))
  expect(unwrap(world.getChildren(root.id))).toEqual([])
  expect(events).toBe(0)
  const loaded = new WorldService(new Context(), { driver })
  expect(loaded.listLeaves()).toEqual([root.id])
  expect(driver.prepare('SELECT count(*) AS count FROM commit_refs').get()).toEqual(
    some({ count: 0 }),
  )
})

test('failed rebase preserves committed prefix and can resume with initialRemap', () => {
  const { world: sourceWorld, driver } = setup()
  const root = commit(sourceWorld, null, [])
  const first = commit(sourceWorld, root, [{ op: 'set', path: ['x'], value: 1 }])
  const second = commit(sourceWorld, first, [{ op: 'set', path: ['y'], value: 2 }])
  const target = commit(sourceWorld, root, [{ op: 'set', path: ['z'], value: 3 }])
  let transactions = 0
  let failOn = Number.POSITIVE_INFINITY
  const faultDriver: SqliteDriver = {
    exec: (sql) => driver.exec(sql),
    prepare: (sql) => driver.prepare(sql),
    close: () => driver.close(),
    transaction: (fn) =>
      driver.transaction(() => {
        const result = fn()
        if (++transactions === failOn) throw new Error('Injected commit failure')
        return result
      }),
  }
  const world = new WorldService(new Context(), { driver: faultDriver })
  transactions = 0
  failOn = 2
  const result = world.rebase([first.id, second.id], target.id)
  if (result.ok || result.error.kind !== 'storage_error' || !result.error.partialRebase)
    throw new Error('Expected partial failure')
  const partial = result.error.partialRebase
  expect(partial.completedRemap.has(first.id)).toBe(true)
  expect(partial.completedRemap.has(second.id)).toBe(false)
  expect(value(world, partial.currentTipId, ['x'])).toBe(1)
  expect(unwrap(world.getNode(partial.currentTipId, ['y']))).toEqual(NONE)
  failOn = Number.POSITIVE_INFINITY
  const resumed = unwrap(
    world.rebase([second.id], partial.currentTipId, { initialRemap: partial.completedRemap }),
  )
  if (resumed.status !== 'completed') throw new Error('Expected resumed completion')
  expect(value(world, resumed.newTipId, ['x'])).toBe(1)
  expect(value(world, resumed.newTipId, ['y'])).toBe(2)
  expect(value(world, resumed.newTipId, ['z'])).toBe(3)
  expect(resumed.remappedIds.get(first.id)).toBe(partial.currentTipId)
})

test('lazy reads throw InvariantError for persisted scalar and UTF-8 TEXT corruption', () => {
  const { world, driver } = setup()
  const root = commit(
    world,
    null,
    [
      { op: 'set', path: ['x'], value: true },
      { op: 'set', path: ['s'], value: 'valid' },
    ],
    'valid-msg',
  )
  driver
    .prepare('UPDATE diff_entries SET val_raw = ? WHERE commit_id = ? AND path_key = ?')
    .run(2, root.id, '1:x')
  driver
    .prepare(
      "UPDATE diff_entries SET val_raw = CAST(X'80' AS TEXT) WHERE commit_id = ? AND path_key = ?",
    )
    .run(root.id, '1:s')
  driver.prepare("UPDATE commits SET msg_raw = CAST(X'EDA080' AS TEXT) WHERE id = ?").run(root.id)
  const loaded = new WorldService(new Context(), { driver })
  expect(() => loaded.getValue(root.id, ['x'])).toThrow(InvariantError)
  expect(() => loaded.getValue(root.id, ['s'])).toThrow(InvariantError)
  expect(() => loaded.getMessage(root.id)).toThrow(InvariantError)

  const utf16Driver = createBunSqliteDriver()
  drivers.push(utf16Driver)
  utf16Driver.exec("PRAGMA encoding = 'UTF-16le'")
  const retryCtx = new Context()
  expect(() => new WorldService(retryCtx, { driver: utf16Driver })).toThrow(InvariantError)
  expect(retryCtx.get('world')).toBeUndefined()
  const validDriver = createBunSqliteDriver()
  drivers.push(validDriver)
  const recovered = new WorldService(retryCtx, { driver: validDriver })
  expect(retryCtx.world).toBeInstanceOf(WorldService)
  expect(retryCtx.world.listRoots()).toEqual([])
  expect(recovered.listRoots()).toEqual([])
})

test('deep 3000-segment paths support commit, getNode, isRefChanged, and rebase without stack overflow', () => {
  const { world } = setup()
  const deepPath = Array.from({ length: 3000 }, () => 'x')
  const root = unwrap(
    world.commit({
      parentId: NONE,
      message: null,
      diff: [{ op: 'set', path: deepPath, value: 7 }],
      advanceHead: 'deep',
    }),
  )
  expect(value(world, root.id, deepPath)).toBe(7)
  const rootView = unwrap(world.getNode(root.id))
  expect(rootView.kind).toBe('some')
  const child = commit(world, root, [{ op: 'set', path: deepPath, value: 8 }])
  expect(unwrap(world.isRefChanged({ commitId: root.id, path: [] }, child.id))).toBe(true)
  expect(unwrap(world.rebase([child.id], root.id))).toMatchObject({
    status: 'completed',
    newTipId: child.id,
  })
})

test('Cordis disposal keeps borrowed connections open and closes transferred connections', async () => {
  const borrowed = createBunSqliteDriver()
  drivers.push(borrowed)
  const borrowedContext = new Context()
  const borrowedPlugin = borrowedContext.plugin(WorldService, { driver: borrowed })
  await borrowedPlugin
  const root = commit(borrowedContext.world, null, [])
  await borrowedPlugin.dispose()
  expect(borrowed.prepare('SELECT id FROM commits').get()).toEqual(some({ id: root.id }))
  const owned = createBunSqliteDriver()
  const ownedContext = new Context()
  const ownedPlugin = ownedContext.plugin(WorldService, { driver: owned, closeOnDispose: true })
  await ownedPlugin
  commit(ownedContext.world, null, [])
  await ownedPlugin.dispose()
  expect(() => owned.prepare('SELECT id FROM commits').get()).toThrow()
})

test('directory-to-leaf rebase preserves its atomic delete group', () => {
  const { world } = setup()
  const base = commit(world, null, [
    { op: 'set', path: ['a', 'x'], value: 1 },
    { op: 'set', path: ['a', 'y'], value: 2 },
  ])
  const source = commit(world, base, [
    { op: 'del', path: ['a', 'x'] },
    { op: 'del', path: ['a', 'y'] },
    { op: 'set', path: ['a'], value: 3 },
  ])
  expect(unwrap(world.rebase([source.id], base.id))).toMatchObject({
    status: 'completed',
    newTipId: source.id,
  })
  const converged = unwrap(world.rebase([source.id], source.id))
  if (converged.status !== 'completed') throw new Error('Expected same-change convergence')
  expect(value(world, converged.newTipId, ['a'])).toBe(3)
  expect(unwrap(world.getNode(converged.newTipId, ['a', 'x']))).toEqual(NONE)
})

test('invalid values, paths and missing refs stay in the controlled error channel', () => {
  const { world } = setup()
  expect(world.commit({ parentId: NONE, message: Number.NaN })).toMatchObject({
    ok: false,
    error: { kind: 'invalid_value' },
  })
  expect(
    world.commit({
      parentId: NONE,
      message: null,
      diff: [{ op: 'set', path: ['x'], value: '\uD800' }],
    }),
  ).toMatchObject({ ok: false, error: { kind: 'invalid_value', path: ['x'] } })
  expect(
    world.commit({ parentId: NONE, message: null, diff: [{ op: 'set', path: [], value: 1 }] }),
  ).toMatchObject({ ok: false, error: { kind: 'invalid_diff', reason: 'empty_path' } })
  const root = commit(world, null, [])
  expect(world.getValue(root.id, [''])).toMatchObject({
    ok: false,
    error: { kind: 'invalid_path' },
  })
  expect(
    world.commit({
      parentId: NONE,
      message: null,
      diff: [{ op: 'set', path: [1n as unknown as string], value: 1 }],
    }),
  ).toMatchObject({
    ok: false,
    error: { kind: 'invalid_path' },
  })
  expect(
    world.commit({
      parentId: some(root.id),
      message: null,
      diff: [{ op: 'ref', path: ['r'], ref: { commitId: 'missing' as CommitHash, path: [] } }],
    }),
  ).toMatchObject({ ok: false, error: { kind: 'dangling_ref' } })
  expect(unwrap(world.getChildren(root.id))).toEqual([])
})

test('getReferencingCommits tracks live incoming StateRefs and clears on popLeaf', () => {
  const { world } = setup()
  const w1 = commit(world, null, [{ op: 'set', path: ['state'], value: 'v1' }], 'w1')
  expect(unwrap(world.getReferencingCommits(w1.id))).toEqual([])
  const trace = commit(
    world,
    null,
    [{ op: 'ref', path: ['worldNode'], ref: { commitId: w1.id, path: [] } }],
    'trace',
  )
  const refs = unwrap(world.getReferencingCommits(w1.id))
  expect(refs).toEqual([trace.id])
  expect(Object.isFrozen(refs)).toBe(true)
  expect(world.popLeaf(trace.id)).toEqual({ ok: true, value: undefined })
  expect(unwrap(world.getReferencingCommits(w1.id))).toEqual([])
})
