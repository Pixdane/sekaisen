import { afterEach, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { SqliteDriver } from '@sekaisen/plugin-world'
import { WorldService } from '@sekaisen/plugin-world'
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
  return { ctx, world, schema }
}

test('Map replacement changes membership but preserves surviving entries outside the base lens scope', async () => {
  const { ctx, schema, world } = setup()
  const actors = unwrap(schema.define(['actors'], s.map(s.struct({ name: s.str() }).extensible())))
  function extend(scope: Context) {
    return unwrap(scope.schema.augment(actors.at('alice'), { armor: s.num().default(2) }))
  }
  let augmented!: ReturnType<typeof extend>
  const plugin = ctx.plugin((scope: Context) => {
    augmented = extend(scope)
  })
  await plugin
  unwrap(
    schema.commit({ head: 'main', message: 'initial' }, (tx) => {
      tx.set(actors, { alice: { name: 'Alice' }, bob: { name: 'Bob' } })
      tx.setWithMeta(augmented.$.armor, 9, { summary: 'plate' })
      tx.setWithMeta(actors.at('alice').$.name, 'Alice', { summary: 'identity' })
      tx.defineCustom(actors.at('alice'), 'luck', s.num(), 4)
    }),
  )
  const next = unwrap(
    schema.commit({ head: 'main', message: 'replace membership' }, (tx) => {
      tx.set(actors, { alice: { name: 'Alicia' }, carol: { name: 'Carol' } })
    }),
  )
  expect(unwrap(schema.listKeys(next.id, actors))).toEqual(['alice', 'carol'])
  expect(unwrap(schema.get(next.id, augmented.$.armor))).toEqual(some(9))
  expect(present(unwrap(schema.getWithMeta(next.id, augmented.$.armor))).meta).toEqual({
    summary: 'plate',
  })
  expect(present(unwrap(schema.getWithMeta(next.id, actors.at('alice').$.name))).meta).toEqual({
    summary: 'identity',
  })
  expect(unwrap(schema.get(next.id, actors.at('alice').custom('luck', s.num())))).toEqual(some(4))
  expect(unwrap(world.getValue(next.id, ['actors', 'carol', 'armor', '$val']))).toEqual(some(2))
  await plugin.dispose()
  const dormant = unwrap(
    schema.commit({ head: 'main', message: 'base-only membership' }, (tx) => {
      tx.set(actors, { alice: { name: 'Alice again' } })
    }),
  )
  expect(unwrap(world.getValue(dormant.id, ['actors', 'alice', 'armor', '$val']))).toEqual(some(9))
  expect(unwrap(schema.get(dormant.id, actors.at('carol')))).toEqual(NONE)
})

test('omitting a defaulted nested struct resets owned fields without deleting augment or custom data', async () => {
  const { ctx, schema } = setup()
  const actor = unwrap(
    schema.define(
      ['actor'],
      s.struct({
        name: s.str(),
        config: s.struct({ hp: s.num().default(10), note: s.str().optional() }).extensible(),
      }),
    ),
  )
  function extend(scope: Context) {
    return unwrap(scope.schema.augment(actor.$.config, { armor: s.num().default(2) }))
  }
  let augmented!: ReturnType<typeof extend>
  const plugin = ctx.plugin((scope: Context) => {
    augmented = extend(scope)
  })
  await plugin
  unwrap(
    schema.commit({ head: 'main', message: 'initial' }, (tx) => {
      tx.set(actor, { name: 'Alice', config: { hp: 5, note: 'old' } })
      tx.setWithMeta(augmented.$.armor, 7, { summary: 'retained' })
      tx.defineCustom(actor.$.config, 'luck', s.num(), 4)
    }),
  )
  const next = unwrap(
    schema.commit({ head: 'main', message: 'omit config' }, (tx) =>
      tx.set(actor, { name: 'Alicia' }),
    ),
  )
  expect(unwrap(schema.get(next.id, actor.$.config.$.hp))).toEqual(some(10))
  expect(unwrap(schema.get(next.id, actor.$.config.$.note))).toEqual(NONE)
  expect(unwrap(schema.get(next.id, augmented.$.armor))).toEqual(some(7))
  expect(present(unwrap(schema.getWithMeta(next.id, augmented.$.armor))).meta).toEqual({
    summary: 'retained',
  })
  expect(unwrap(schema.get(next.id, actor.$.config.custom('luck', s.num())))).toEqual(some(4))
})

test('update validates ancestor existence and transaction lifetime before invoking user callbacks', () => {
  const { schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.map(s.struct({ note: s.str().optional() }))))
  let calls = 0
  let escaped!: SchemaTransaction
  const next = unwrap(
    schema.commit({ head: 'main', message: 'invalid update is caught' }, (tx) => {
      escaped = tx
      expect(() =>
        tx.update(actors.at('missing').$.note, () => {
          calls++
          return 'unexpected'
        }),
      ).toThrow()
      tx.set(actors.at('alice'), { note: 'saved' })
    }),
  )
  expect(() =>
    escaped.update(actors.at('alice').$.note, () => {
      calls++
      return 'unexpected'
    }),
  ).toThrow()
  expect(calls).toBe(0)
  expect(unwrap(schema.get(next.id, actors.at('missing')))).toEqual(NONE)
  expect(unwrap(schema.get(next.id, actors.at('alice').$.note))).toEqual(some('saved'))
})

test('invalid metadata cannot partially change values, custom evidence or earlier metadata entries', () => {
  const { schema } = setup()
  const item = unwrap(schema.define(['item'], s.struct({ hp: s.num().default(1) }).extensible()))
  unwrap(
    schema.commit({ head: 'main', message: 'initial' }, (tx) => {
      tx.setWithMeta(item.$.hp, 1, { summary: 'original' })
      tx.defineCustom(item, 'old', s.num(), 3, { summary: 'original custom' })
    }),
  )
  const next = unwrap(
    schema.commit({ head: 'main', message: 'caught metadata errors' }, (tx) => {
      expect(() =>
        tx.setWithMeta(item.$.hp, 99, { summary: 'changed', invalid: Infinity }),
      ).toThrow()
      expect(() => tx.setWithMeta(item.$.hp, 98, { '': 'invalid key' })).toThrow()
      expect(() => tx.defineCustom(item, 'new', s.str(), 'bad', { invalid: Infinity })).toThrow()
      expect(() => tx.defineCustom(item, 'old', s.num(), 99, { '': 'invalid key' })).toThrow()
      expect(unwrap(tx.get(item.$.hp))).toEqual(some(1))
      expect(unwrap(tx.get(item.custom('new', s.str())))).toEqual(NONE)
    }),
  )
  expect(present(unwrap(schema.getWithMeta(next.id, item.$.hp)))).toMatchObject({
    value: 1,
    meta: { summary: 'original' },
  })
  expect(present(unwrap(schema.getWithMeta(next.id, item.custom('old', s.num()))))).toMatchObject({
    value: 3,
    meta: { summary: 'original custom' },
  })
  expect(next.diff).toEqual([])
})

test('optional state containers distinguish business kind fields from actual Option wrappers', () => {
  const { schema } = setup()
  const root = unwrap(
    schema.define(
      ['data'],
      s.struct({
        item: s.struct({ kind: s.str(), value: s.str().optional() }).optional(),
        dictionary: s.map(s.str()).optional(),
      }),
    ),
  )
  const first = unwrap(
    schema.commit({ head: 'main', message: 'business none' }, (tx) => {
      tx.set(root, { item: { kind: 'none' }, dictionary: { kind: 'none' } })
    }),
  )
  expect(unwrap(schema.get(first.id, root.$.item))).toEqual(some({ kind: 'none', value: NONE }))
  expect(unwrap(schema.get(first.id, root.$.dictionary))).toEqual(some({ kind: 'none' }))
  const next = unwrap(
    schema.commit({ head: 'main', message: 'business some' }, (tx) => {
      tx.set(root.$.item, { kind: 'some', value: 'business' })
      tx.set(root.$.dictionary, { kind: 'some', value: 'business' })
    }),
  )
  expect(unwrap(schema.get(next.id, root.$.item))).toEqual(
    some({ kind: 'some', value: some('business') }),
  )
  expect(unwrap(schema.get(next.id, root.$.dictionary))).toEqual(
    some({ kind: 'some', value: 'business' }),
  )
  const wrapped = unwrap(
    schema.commit({ head: 'main', message: 'actual wrappers' }, (tx) => {
      tx.set(root.$.item, some({ kind: 'none' }))
      tx.set(root.$.dictionary, NONE)
    }),
  )
  expect(unwrap(schema.get(wrapped.id, root.$.item))).toEqual(some({ kind: 'none', value: NONE }))
  expect(unwrap(schema.get(wrapped.id, root.$.dictionary))).toEqual(NONE)
})
