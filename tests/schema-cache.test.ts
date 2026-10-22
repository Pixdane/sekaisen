import { afterEach, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}
function present<T>(value: Option<T>): T {
  if (value.kind === 'none') throw new Error('Expected present value')
  return value.value
}
const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})
function setup() {
  const driver = createBunSqliteDriver()
  drivers.push(driver)
  const ctx = new Context()
  const world = new WorldService(ctx, { driver })
  const schema = new SchemaService(ctx)
  const catalogReads: Path[] = []
  const getValue = world.getValue.bind(world)
  // Observe actual World reads, including hot-cache hits; SQL alone cannot
  // distinguish a parsed Catalog hit from re-parsing hot leaf payloads.
  world.getValue = (id, path) => {
    if (path[0] === '$schemas') catalogReads.push([...path])
    return getValue(id, path)
  }
  return { ctx, world, schema, catalogReads }
}

test('logical reads, typed messages, commit and no-op sync reuse an unchanged Writer directory revision', () => {
  const { world, schema, catalogReads } = setup()
  const hp = unwrap(schema.define(['hp'], s.num().default(10)))
  const event = unwrap(schema.defineMessage('event', s.struct({ value: s.num() })))
  const initial = unwrap(schema.commit({ head: 'main', message: event.create({ value: 1 }) }))
  expect(unwrap(schema.get(initial.id, hp))).toEqual(some(10))
  expect(catalogReads).toContainEqual(['$schemas', '$version'])
  catalogReads.length = 0

  expect(unwrap(unwrap(schema.viewAt(initial.id)).get(hp))).toEqual(some(10))
  expect(present(unwrap(schema.getWithMeta(initial.id, hp))).value).toBe(10)
  expect(present(unwrap(schema.inspectInstance(initial.id, ['hp'])))).toMatchObject({ value: 10 })
  expect(unwrap(schema.checkDrift(initial.id)).isClean).toBe(true)
  expect(unwrap(schema.getMessage(initial.id))).toEqual(event.create({ value: 1 }))
  const next = unwrap(
    schema.commit({ head: 'main', message: event.create({ value: 2 }) }, (tx) => tx.set(hp, 11)),
  )
  expect(unwrap(schema.get(next.id, hp))).toEqual(some(11))
  expect(unwrap(schema.get(initial.id, hp))).toEqual(some(10))
  expect(unwrap(schema.getMessage(next.id))).toEqual(event.create({ value: 2 }))
  expect(catalogReads).toEqual([])
  const synced = unwrap(schema.syncSchema({ head: 'main' }))
  expect(synced.diff).toEqual([])
  expect(unwrap(world.getNodeInfo(synced.id, ['$schemas']))).toEqual(
    unwrap(world.getNodeInfo(initial.id, ['$schemas'])),
  )
  // Sync's net-diff comparison legitimately reads the catalog leaves it rewrites.
  catalogReads.length = 0
  expect(unwrap(schema.get(synced.id, hp))).toEqual(some(11))
  expect(catalogReads).toEqual([])
})

test('branch switching and equal-value Writer rewrites use the requested directory version', () => {
  const { world, schema, catalogReads } = setup()
  const hp = unwrap(schema.define(['hp'], s.num().default(10)))
  const initial = unwrap(schema.commit({ message: 'seed' }))
  const descriptionPath = ['$schemas', 'roots', encodePathKey(['hp']), 'description']
  const branches = ['A', 'B'].map((description) =>
    unwrap(
      world.commit({
        parentId: some(initial.id),
        message: description,
        diff: [{ op: 'set', path: descriptionPath, value: description }],
      }),
    ),
  )
  for (const [index, branch] of branches.entries()) {
    const inspected = present(unwrap(schema.inspectInstance(branch.id, ['hp'])))
    expect(inspected.writerSpec.description).toBe(index === 0 ? 'A' : 'B')
  }
  catalogReads.length = 0
  for (const [index, branch] of [...branches.entries()].reverse()) {
    unwrap(world.setHead('main', branch.id))
    const current = present(world.getHead('main'))
    expect(present(unwrap(schema.inspectInstance(current, ['hp']))).writerSpec.description).toBe(
      index === 0 ? 'A' : 'B',
    )
    expect(unwrap(schema.get(current, hp))).toEqual(some(10))
  }
  expect(catalogReads).toEqual([])

  const rewritten = unwrap(
    world.commit({
      parentId: some(branches[0]!.id),
      message: 'equal rewrite',
      diff: [{ op: 'set', path: descriptionPath, value: 'A' }],
    }),
  )
  expect(present(unwrap(world.getNodeInfo(rewritten.id, ['$schemas'])))).not.toEqual(
    present(unwrap(world.getNodeInfo(branches[0]!.id, ['$schemas']))),
  )
  expect(present(unwrap(schema.inspectInstance(rewritten.id, ['hp']))).writerSpec.description).toBe(
    'A',
  )
  expect(catalogReads).toContainEqual(['$schemas', '$version'])
  catalogReads.length = 0
  expect(
    present(unwrap(schema.inspectInstance(branches[1]!.id, ['hp']))).writerSpec.description,
  ).toBe('B')
  expect(catalogReads).toEqual([])
})

test('Reader scope changes and sync never mutate a cached historical Writer catalog', async () => {
  const { ctx, schema, catalogReads } = setup()
  const config = unwrap(schema.define(['config'], s.struct({ hp: s.num().default(10) })))
  const initial = unwrap(schema.commit({ head: 'main', message: 'seed' }))
  unwrap(schema.viewAt(initial.id))
  catalogReads.length = 0
  const extension = ctx.plugin((scope: Context) => {
    unwrap(scope.schema.augment(config, { armor: s.num().default(2) }))
  })
  await extension
  const pending = unwrap(schema.checkDrift(initial.id))
  expect(pending.backfillableNodes).toContainEqual(
    expect.objectContaining({ schemaPath: ['config', 'armor'] }),
  )
  expect(catalogReads).toEqual([])
  const synced = unwrap(schema.syncSchema({ head: 'main' }))
  const old = present(unwrap(schema.inspectInstance(initial.id, ['config'])))
  const next = present(unwrap(schema.inspectInstance(synced.id, ['config'])))
  if (old.nodeKind !== 'struct' || next.nodeKind !== 'struct')
    throw new Error('Expected struct history')
  expect(Object.keys(old.fields)).toEqual(['hp'])
  expect(Object.keys(next.fields).sort()).toEqual(['armor', 'hp'])
  expect(present(next.fields.armor!)).toMatchObject({ value: 2 })
  await extension.dispose()
  catalogReads.length = 0
  expect(unwrap(schema.checkDrift(initial.id)).isClean).toBe(true)
  const dormant = unwrap(schema.checkDrift(synced.id))
  expect(dormant.isClean).toBe(true)
  expect(dormant.dormantSchemas).toContainEqual(
    expect.objectContaining({ schemaPath: ['config', 'armor'] }),
  )
  expect(unwrap(schema.get(synced.id, config.$.hp))).toEqual(some(10))
  expect(catalogReads).toEqual([])
})

test('mutating byte defaults and metadata in inspection or drift results cannot poison the cached Writer', async () => {
  const { ctx, schema } = setup()
  const definition = ctx.plugin((scope: Context) => {
    unwrap(
      scope.schema.define(
        ['blob'],
        s
          .bytes()
          .default(new Uint8Array([1, 2]))
          .meta({ marker: new Uint8Array([3, 4]) }),
      ),
    )
  })
  await definition
  const initial = unwrap(schema.commit({ message: 'seed' }))
  const inspect = () => present(unwrap(schema.inspectInstance(initial.id, ['blob'])))
  const first = inspect()
  if (
    first.writerSpec.nodeKind !== 'leaf' ||
    first.writerSpec.valueKind !== 'bytes' ||
    first.writerSpec.presence.mode !== 'defaulted'
  )
    throw new Error('Expected defaulted bytes')
  const defaultValue = first.writerSpec.presence.defaultValue
  if (!(defaultValue instanceof Uint8Array)) throw new Error('Expected byte default')
  defaultValue[0] = 99
  const marker = first.writerSpec.metadata.marker
  if (!(marker instanceof Uint8Array)) throw new Error('Expected byte metadata')
  marker[0] = 99
  await definition.dispose()
  unwrap(schema.define(['blob'], s.str().default('new')))
  const incompatible = unwrap(schema.checkDrift(initial.id)).incompatibilities[0]!
  const exported = present(incompatible.writerSpec)
  if (
    exported.nodeKind !== 'leaf' ||
    exported.valueKind !== 'bytes' ||
    exported.presence.mode !== 'defaulted'
  )
    throw new Error('Expected Writer byte default')
  const reportDefault = exported.presence.defaultValue
  if (!(reportDefault instanceof Uint8Array)) throw new Error('Expected byte default')
  reportDefault[0] = 88
  const reportMarker = exported.metadata.marker
  if (!(reportMarker instanceof Uint8Array)) throw new Error('Expected byte metadata')
  reportMarker[0] = 88
  const again = inspect()
  expect(again.writerSpec).toMatchObject({
    presence: { mode: 'defaulted', defaultValue: new Uint8Array([1, 2]) },
    metadata: { marker: new Uint8Array([3, 4]) },
  })
  expect(again).toMatchObject({ value: new Uint8Array([1, 2]) })
})

test('missing, malformed and deleted commits cannot fall back to a cached valid catalog or cached error identity', () => {
  const { world, schema } = setup()
  const hp = unwrap(schema.define(['hp'], s.num().default(10)))
  const initial = unwrap(schema.commit({ message: 'seed' }))
  expect(unwrap(schema.get(initial.id, hp))).toEqual(some(10))
  const malformed = unwrap(
    world.commit({
      parentId: some(initial.id),
      message: 'bad version',
      diff: [{ op: 'set', path: ['$schemas', '$version'], value: 2 }],
    }),
  )
  const sameBadVersion = unwrap(
    world.commit({
      parentId: some(malformed.id),
      message: 'same bad schema',
      diff: [{ op: 'set', path: ['hp', '$val'], value: 11 }],
    }),
  )
  for (const bad of [malformed, sameBadVersion])
    expect(schema.viewAt(bad.id)).toMatchObject({
      ok: false,
      error: { kind: 'corrupted_instance_data', commitId: bad.id },
    })
  const missing = unwrap(
    world.commit({
      parentId: some(initial.id),
      message: 'no catalog',
      diff: [{ op: 'del', path: ['$schemas'] }],
    }),
  )
  const leaf = unwrap(
    world.commit({
      parentId: NONE,
      message: 'leaf catalog',
      diff: [{ op: 'set', path: ['$schemas'], value: 1 }],
    }),
  )
  for (const bad of [missing, leaf])
    expect(schema.viewAt(bad.id)).toMatchObject({
      ok: false,
      error: { kind: 'corrupted_instance_data', commitId: bad.id },
    })
  const removable = unwrap(
    world.commit({
      parentId: some(initial.id),
      message: 'removable',
      diff: [{ op: 'set', path: ['hp', '$val'], value: 12 }],
    }),
  )
  expect(unwrap(schema.get(removable.id, hp))).toEqual(some(12))
  unwrap(world.popLeaf(removable.id))
  expect(schema.viewAt(removable.id)).toMatchObject({
    ok: false,
    error: { kind: 'world_error', error: { kind: 'commit_not_found', commitId: removable.id } },
  })
  expect(unwrap(schema.get(initial.id, hp))).toEqual(some(10))
})
