import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import type {
  CommitHash,
  CommitNode,
  SqliteDriver,
  StateDiff,
  Value,
  WorldError,
} from '@sekaisen/plugin-world'
import {
  decodeValue,
  dehydrateSelfRefs,
  encodeValue,
  SELF_COMMIT,
  valueEquals,
  WorldService,
} from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'
import { hashCommit } from '../packages/plugin-world/src/codec.ts'

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                  */
/* -------------------------------------------------------------------------- */

const drivers: SqliteDriver[] = []
const directories: string[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function unwrap<T>(result: Result<T, WorldError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function newDriver(dbPath?: string): SqliteDriver {
  const driver = createBunSqliteDriver(dbPath === undefined ? {} : { dbPath })
  drivers.push(driver)
  return driver
}

function setup(): { driver: SqliteDriver; world: WorldService } {
  const driver = newDriver()
  return { driver, world: new WorldService(new Context(), { driver }) }
}

function commit(
  world: WorldService,
  parent: CommitNode | null,
  diff: StateDiff,
  message: Value = null,
): CommitNode {
  return unwrap(world.commit({ parentId: parent ? some(parent.id) : NONE, diff, message }))
}

function refValue(world: WorldService, id: CommitHash, path: readonly string[]) {
  const result = unwrap(world.getRef(id, path))
  if (result.kind === 'none') throw new Error(`Expected a StateRef at ${path.join('/')}`)
  return result.value
}

function value(world: WorldService, id: CommitHash, path: readonly string[]): Value {
  const result = unwrap(world.getValue(id, path))
  if (result.kind === 'none') throw new Error(`Expected a value at ${path.join('/')}`)
  return result.value
}

/* -------------------------------------------------------------------------- */
/*                            SELF_COMMIT lifecycle                           */
/* -------------------------------------------------------------------------- */

describe('SELF_COMMIT lifecycle', () => {
  test('hashes canonically, materializes real ids and stays replay-stable', () => {
    const { world } = setup()
    const root = commit(world, null, [])
    const diff: StateDiff = [
      { op: 'set', path: ['records', 'r1', 'value'], value: 'a' },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
      { op: 'ref', path: ['anchor'], ref: { commitId: SELF_COMMIT, path: ['$message'] } },
      { op: 'ref', path: ['snapshot'], ref: { commitId: SELF_COMMIT, path: [] } },
      { op: 'ref', path: ['records', 'r1', 'root'], ref: { commitId: root.id, path: [] } },
    ]
    const node = commit(world, root, diff)

    // Canonical hash: dehydrating the materialized diff reproduces the node id.
    expect(hashCommit(some(root.id), null, dehydrateSelfRefs(node.id, node.diff))).toBe(node.id)
    expect(hashCommit(some(root.id), null, node.diff, node.id)).toBe(node.id)
    // Replaying the same canonical input deduplicates onto the same node.
    const replay = unwrap(world.commit({ parentId: some(root.id), message: null, diff }))
    expect(replay.id).toBe(node.id)
    expect(unwrap(world.getChildren(root.id))).toEqual([node.id])

    // Every self reference in the node, storage and reads is materialized.
    for (const op of node.diff) {
      if (op.op !== 'ref') continue
      if (op.path[0] === 'anchor' || op.path[0] === 'snapshot')
        expect(op.ref.commitId).toBe(node.id)
    }
    expect(refValue(world, node.id, ['records', 'r1', 'origin'])).toEqual({
      commitId: node.id,
      path: ['records', 'r1'],
    })
    expect(refValue(world, node.id, ['anchor'])).toEqual({
      commitId: node.id,
      path: ['$message'],
    })
    expect(refValue(world, node.id, ['snapshot'])).toEqual({ commitId: node.id, path: [] })
    expect(refValue(world, node.id, ['records', 'r1', 'root'])).toEqual({
      commitId: root.id,
      path: [],
    })

    const record = unwrap(world.getNode(node.id, ['records', 'r1']))
    if (record.kind !== 'some' || record.value.nodeKind !== 'dir')
      throw new Error('Expected the record directory')
    const originView = record.value.entries.get('origin')!
    if (originView.nodeKind !== 'leaf') throw new Error('Expected a ref leaf view')
    expect(originView.entry).toEqual({
      entryKind: 'ref',
      ref: { commitId: node.id, path: ['records', 'r1'] },
    })
    const deref = unwrap(world.deref({ commitId: node.id, path: ['records', 'r1'] }))
    expect(deref.kind).toBe('some')

    // Index-only reads stay payload-free and expose the self-ref leaf as a leaf.
    expect(unwrap(world.getNodeInfo(node.id, ['records', 'r1', 'origin']))).toEqual(
      some({ nodeKind: 'leaf', originCommitId: node.id }),
    )
    expect(unwrap(world.listChildren(node.id, ['records', 'r1']))).toEqual(
      some(['origin', 'root', 'value']),
    )
    expect(world.listChildren(node.id, ['records', 'r1', 'origin'])).toMatchObject({
      ok: false,
      error: { kind: 'structure_conflict' },
    })
  })

  test('does not pin itself and remains safely pop-able', () => {
    const { world } = setup()
    const root = commit(world, null, [])
    const selfOnly = commit(world, root, [
      { op: 'set', path: ['records', 'r0', 'value'], value: 0 },
      {
        op: 'ref',
        path: ['records', 'r0', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r0'] },
      },
    ])
    expect(unwrap(world.getReferencingCommits(selfOnly.id))).toEqual([])
    unwrap(world.popLeaf(selfOnly.id))
    expect(world.hasCommit(selfOnly.id)).toBe(false)

    const node = commit(world, root, [
      { op: 'set', path: ['records', 'r1', 'value'], value: 1 },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
      { op: 'ref', path: ['root'], ref: { commitId: root.id, path: [] } },
    ])

    expect(unwrap(world.getReferencingCommits(node.id))).toEqual([])
    expect(unwrap(world.getReferencingCommits(root.id))).toEqual([node.id])
    unwrap(world.popLeaf(node.id))
    expect(world.hasCommit(node.id)).toBe(false)
    expect(unwrap(world.getChildren(root.id))).toEqual([])
  })

  test('rejects self targets that do not exist in the final state tree', () => {
    const { world } = setup()
    const root = commit(world, null, [{ op: 'set', path: ['x'], value: 1 }])

    expect(
      world.commit({
        parentId: some(root.id),
        message: null,
        diff: [{ op: 'ref', path: ['missing'], ref: { commitId: SELF_COMMIT, path: ['absent'] } }],
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'dangling_ref', refCommitId: SELF_COMMIT, refPath: ['absent'] },
    })

    // A target deleted by the same two-phase diff is also missing.
    expect(
      world.commit({
        parentId: some(root.id),
        message: null,
        diff: [
          { op: 'del', path: ['x'] },
          { op: 'ref', path: ['r'], ref: { commitId: SELF_COMMIT, path: ['x'] } },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'dangling_ref', refCommitId: SELF_COMMIT, refPath: ['x'] },
    })
    expect(unwrap(world.getChildren(root.id))).toEqual([])
    expect(value(world, root.id, ['x'])).toBe(1)
  })

  test('leaves standalone literal $self values untouched', () => {
    const { world } = setup()
    const root = commit(world, null, [
      { op: 'set', path: ['literal'], value: SELF_COMMIT },
      { op: 'set', path: ['list'], value: ['$self', 1] },
    ])
    expect(value(world, root.id, ['literal'])).toBe('$self')
    expect(value(world, root.id, ['list'])).toEqual(['$self', 1])
    expect(encodeValue(SELF_COMMIT)).toEqual(encodeValue('$self'))
  })
})

/* -------------------------------------------------------------------------- */
/*                       SELF_COMMIT persistence and startup                   */
/* -------------------------------------------------------------------------- */

describe('SELF_COMMIT persistence and startup', () => {
  test('survives reopen with materialized refs and no persisted self edge', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sekaisen-world-self-'))
    directories.push(directory)
    const dbPath = join(directory, 'world.sqlite')

    const firstDriver = createBunSqliteDriver({ dbPath })
    const first = new WorldService(new Context(), { driver: firstDriver })
    const root = commit(first, null, [])
    const node = commit(first, root, [
      { op: 'set', path: ['records', 'r1', 'value'], value: 'a' },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
      { op: 'ref', path: ['root'], ref: { commitId: root.id, path: [] } },
    ])
    expect(
      firstDriver
        .prepare(
          'SELECT count(*) AS count FROM commit_refs WHERE source_commit_id = target_commit_id',
        )
        .get<{ count: number }>(),
    ).toEqual(some({ count: 0 }))
    firstDriver.close()

    const second = new WorldService(new Context(), { driver: newDriver(dbPath) })
    expect(second.hasCommit(node.id)).toBe(true)
    expect(refValue(second, node.id, ['records', 'r1', 'origin'])).toEqual({
      commitId: node.id,
      path: ['records', 'r1'],
    })
    expect(unwrap(second.getReferencingCommits(node.id))).toEqual([])
    expect(unwrap(second.getReferencingCommits(root.id))).toEqual([node.id])
    expect(unwrap(second.getNodeInfo(node.id, ['records', 'r1', 'origin']))).toEqual(
      some({ nodeKind: 'leaf', originCommitId: node.id }),
    )
    expect(hashCommit(some(root.id), null, dehydrateSelfRefs(node.id, node.diff))).toBe(node.id)
  })

  test('rejects persisted commit_refs self loops as corruption on startup', () => {
    const { world, driver } = setup()
    const root = commit(world, null, [])
    const node = commit(world, root, [
      { op: 'set', path: ['records', 'r1', 'value'], value: 1 },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
    ])
    driver
      .prepare('INSERT INTO commit_refs (source_commit_id, target_commit_id) VALUES (?, ?)')
      .run(node.id, node.id)
    expect(() => new WorldService(new Context(), { driver })).toThrow(InvariantError)
  })
})

/* -------------------------------------------------------------------------- */
/*                          SELF_COMMIT rebase alignment                      */
/* -------------------------------------------------------------------------- */

describe('SELF_COMMIT rebase alignment', () => {
  test('identity replay dehydrates self refs before custom policies and history checks', () => {
    const { world } = setup()
    const root = commit(world, null, [])
    const source = commit(world, root, [
      { op: 'set', path: ['records', 'r1', 'value'], value: 'b' },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
      { op: 'ref', path: ['anchor'], ref: { commitId: root.id, path: [] } },
    ])
    const calls: string[] = []
    const result = unwrap(
      world.rebase([source.id], root.id, {
        remapRefs: (ref) => {
          calls.push(ref.commitId)
          return ref.commitId
        },
      }),
    )
    if (result.status !== 'completed') throw new Error('Expected identity replay')
    expect(result.newTipId).toBe(source.id)
    expect(calls).toEqual([root.id])
    expect(calls).not.toContain(SELF_COMMIT)
    expect(calls).not.toContain(source.id)
  })

  test('force-syncs the effective base when resuming with initialRemap', () => {
    const { world } = setup()
    const root = commit(world, null, [{ op: 'set', path: ['records', 'r1', 'value'], value: 'a' }])
    const selfNode = commit(world, root, [
      { op: 'set', path: ['records', 'r1', 'value'], value: 'b' },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
    ])
    const deleteOrigin = commit(world, selfNode, [{ op: 'del', path: ['records', 'r1', 'origin'] }])
    const target = commit(world, root, [{ op: 'set', path: ['other'], value: true }])

    // First batch replays the self-anchored node; the second batch resumes.
    const first = unwrap(world.rebase([selfNode.id], target.id))
    if (first.status !== 'completed') throw new Error('Expected first batch completion')
    expect(first.remappedIds.get(selfNode.id)).toBe(first.newTipId)
    expect(refValue(world, first.newTipId, ['records', 'r1', 'origin'])).toEqual({
      commitId: first.newTipId,
      path: ['records', 'r1'],
    })

    const second = unwrap(
      world.rebase([deleteOrigin.id], first.newTipId, {
        initialRemap: first.remappedIds,
      }),
    )
    if (second.status !== 'completed') throw new Error('Expected resumed completion')
    expect(second.remappedIds.get(selfNode.id)).toBe(first.newTipId)
    expect(value(world, second.newTipId, ['records', 'r1', 'value'])).toBe('b')
    expect(unwrap(world.getRef(second.newTipId, ['records', 'r1', 'origin']))).toEqual(NONE)
    expect(value(world, second.newTipId, ['other'])).toBe(true)
  })

  test('reports the force-synced base view instead of diverging on a stale self ref', () => {
    const { world } = setup()
    const root = commit(world, null, [{ op: 'set', path: ['records', 'r1', 'value'], value: 'a' }])
    const selfNode = commit(world, root, [
      { op: 'set', path: ['records', 'r1', 'value'], value: 'b' },
      {
        op: 'ref',
        path: ['records', 'r1', 'origin'],
        ref: { commitId: SELF_COMMIT, path: ['records', 'r1'] },
      },
    ])
    const replaceRecord = commit(world, selfNode, [
      { op: 'del', path: ['records', 'r1'] },
      { op: 'set', path: ['records', 'r1', 'value'], value: 'c' },
    ])
    const target = commit(world, root, [
      { op: 'set', path: ['records', 'r1', 'extra'], value: 'x' },
    ])
    const outcome = unwrap(world.rebase([selfNode.id, replaceRecord.id], target.id))
    if (outcome.status !== 'conflict') throw new Error('Expected a value conflict')
    const replayedSelf = outcome.remappedIds.get(selfNode.id)
    expect(replayedSelf).toBeDefined()
    const base = outcome.conflicts[0]?.baseNode
    if (base?.kind !== 'some' || base.value.nodeKind !== 'dir')
      throw new Error('Expected a base directory view')
    expect(base.value.entries.get('origin')).toEqual({
      nodeKind: 'leaf',
      entry: { entryKind: 'ref', ref: { commitId: replayedSelf!, path: ['records', 'r1'] } },
    })
  })
})

/* -------------------------------------------------------------------------- */
/*                          Canonical value byte codec                        */
/* -------------------------------------------------------------------------- */

describe('canonical value byte codec', () => {
  test('round-trips scalars and scalar lists without JSON narrowing', () => {
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
    for (const entry of values) {
      expect(valueEquals(entry, decodeValue(encodeValue(entry)))).toBe(true)
    }
    expect(encodeValue(-0)).toEqual(encodeValue(0))
  })

  test('returns detached buffers and copies decoded byte payloads', () => {
    const source = new Uint8Array([1, 2, 3])
    const encoded = encodeValue(source)
    source[0] = 9
    expect(decodeValue(encoded)).toEqual(new Uint8Array([1, 2, 3]))

    const list = encodeValue([new Uint8Array([4])])
    const decoded = decodeValue(list)
    list.fill(0)
    expect(decoded).toEqual([new Uint8Array([4])])
  })

  test('rejects malformed canonical bytes', () => {
    const bad: number[][] = [
      [],
      [0x07],
      [0x06, 0x00, 0x00],
      [0x06, 0x00, 0x00, 0x00, 0x01],
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00],
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x02, 0x02],
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x06],
      [0x06, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x02, 0xc3, 0x28],
      [0x04, 0x00, 0x00, 0x00, 0x01, 0xff],
      [0x03, 0x00],
    ]
    for (const bytes of bad) {
      expect(() => decodeValue(Uint8Array.from(bytes))).toThrow(InvariantError)
    }
    expect(() => decodeValue('x' as unknown as Uint8Array)).toThrow(TypeError)
  })

  test('rejects trailing bytes after every scalar encoding rather than returning an accepted prefix', () => {
    const values: Value[] = [
      null,
      false,
      true,
      0,
      3.25,
      '',
      'a scalar string',
      new Uint8Array(),
      new Uint8Array([4, 5]),
    ]
    for (const value of values) {
      const encoded = encodeValue(value)
      const trailing = new Uint8Array(encoded.byteLength + 2)
      trailing.set(encoded)
      trailing.set([255, 255], encoded.byteLength)
      expect(() => decodeValue(trailing)).toThrow(InvariantError)
    }
  })

  test('rejects concatenated canonical values for scalar and list prefixes alike', () => {
    const values: Value[] = [null, true, 7, 'first', new Uint8Array([3]), [], [false, 'entry']]
    const second = encodeValue('a second canonical value')
    for (const value of values) {
      const first = encodeValue(value)
      const concatenated = new Uint8Array(first.byteLength + second.byteLength)
      concatenated.set(first)
      concatenated.set(second, first.byteLength)
      expect(() => decodeValue(concatenated)).toThrow(InvariantError)
    }
  })

  test('checks exhaustion against the supplied byte window instead of its larger backing buffer', () => {
    const encoded = encodeValue('inside the byte window')
    const backing = new Uint8Array(encoded.byteLength + 4).fill(255)
    backing.set(encoded, 2)
    expect(decodeValue(backing.subarray(2, 2 + encoded.byteLength))).toBe('inside the byte window')
    expect(() => decodeValue(backing.subarray(2, 3 + encoded.byteLength))).toThrow(InvariantError)
  })
})
