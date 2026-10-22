import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, ok, some } from '@sekaisen/core'
import type { LensFor, SchemaNode } from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { SqliteDriver } from '@sekaisen/plugin-world'
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
  return { ctx, world, schema }
}
async function register<S extends SchemaNode>(
  ctx: Context,
  node: S,
  path: readonly string[] = ['actors'],
) {
  let lens!: LensFor<S>
  const fiber = ctx.plugin((scope: Context) => {
    lens = unwrap(scope.schema.define(path, node))
  })
  await fiber
  return { lens, dispose: fiber.dispose }
}

describe('schema evolution edge cases', () => {
  test('keep retains Writer-only required fields without relaxing merged validation', async () => {
    const { ctx, schema, world } = setup()
    const old = await register(ctx, s.struct({ legacy: s.num() }))
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => tx.set(old.lens, { legacy: 7 })),
    )
    await old.dispose()
    const current = await register(ctx, s.struct({}))
    const synced = unwrap(schema.syncSchema({ head: 'main' }))
    expect(unwrap(schema.get(synced.id, current.lens))).toEqual(some({}))
    expect(unwrap(world.getValue(synced.id, ['actors', 'legacy', '$val']))).toEqual(some(7))
    const drift = unwrap(schema.checkDrift(synced.id))
    expect(drift.isClean).toBe(true)
    expect(drift.dormantSchemas.map((item) => item.schemaPath)).toContainEqual(['actors', 'legacy'])
    // Reader semantics may omit its defaulted struct, but the retained physical
    // field is still validated and survives ordinary commits.
    const updated = unwrap(
      schema.commit({ head: 'main', message: 'update' }, (tx) => tx.set(current.lens, {})),
    )
    expect(unwrap(world.getValue(updated.id, ['actors', 'legacy', '$val']))).toEqual(some(7))
    expect(unwrap(world.getValue(first.id, ['actors', 'legacy', '$val']))).toEqual(some(7))
  })

  test('backfill materializes retained defaults from the effective target schema', async () => {
    const { ctx, schema, world } = setup()
    const old = await register(
      ctx,
      s.struct({ box: s.struct({ legacy: s.num().default(5) }).optional() }),
    )
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => tx.set(old.lens, {})),
    )
    await old.dispose()
    const current = await register(ctx, s.struct({ box: s.struct({ fresh: s.num().default(1) }) }))
    expect(
      unwrap(schema.checkDrift(first.id)).backfillableNodes.map((item) => [
        item.schemaPath,
        item.reason,
      ]),
    ).toContainEqual([['actors', 'box'], 'optional_to_defaulted'])
    const synced = unwrap(schema.syncSchema({ head: 'main' }))
    expect(unwrap(world.getValue(synced.id, ['actors', 'box', 'legacy', '$val']))).toEqual(some(5))
    expect(unwrap(world.getValue(synced.id, ['actors', 'box', 'fresh', '$val']))).toEqual(some(1))
    expect(unwrap(schema.get(synced.id, current.lens.$.box.$.fresh))).toEqual(some(1))
    const drift = unwrap(schema.checkDrift(synced.id))
    expect(drift.isClean).toBe(true)
    expect(drift.dormantSchemas.map((item) => item.schemaPath)).toContainEqual([
      'actors',
      'box',
      'legacy',
    ])
    // The migration source is immutable.
    expect(unwrap(world.getValue(first.id, ['actors', 'box', 'legacy', '$val']))).toEqual(NONE)
  })

  test('promotion converter NONE resets a defaulted leaf and keeps its metadata', async () => {
    const { ctx, schema, world } = setup()
    const old = await register(ctx, s.struct({}).extensible())
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => {
        tx.defineCustom(old.lens, 'luck', s.num(), 8, { summary: 'old' })
      }),
    )
    await old.dispose()
    const current = await register(ctx, s.struct({ luck: s.num().default(0) }).extensible())
    const synced = unwrap(
      schema.syncSchema({
        head: 'main',
        fieldMigrations: {
          [encodePathKey(['actors', 'luck'])]: () => ok(NONE),
        },
      }),
    )
    expect(present(unwrap(schema.getWithMeta(synced.id, current.lens.$.luck)))).toMatchObject({
      value: 0,
      meta: { summary: 'old' },
    })
    expect(unwrap(world.getNode(synced.id, ['actors', '$custom', 'luck']))).toEqual(NONE)
    expect(unwrap(schema.inspectInstance(first.id, ['actors']))).toMatchObject({
      kind: 'some',
      value: {
        customFields: { luck: { value: 8, meta: { summary: 'old' } } },
      },
    })
  })

  test('prune preserves active-root data addressed by an older nested root', async () => {
    const { ctx, schema, world } = setup()
    const old = await register(ctx, s.num().default(1), ['actors', 'hp'])
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => tx.set(old.lens, 7)),
    )
    await old.dispose()
    const current = await register(ctx, s.struct({ hp: s.num().default(7) }), ['actors'])
    expect(
      unwrap(schema.checkDrift(first.id)).dormantSchemas.map((item) => item.schemaPath),
    ).toContainEqual(['actors', 'hp'])
    const synced = unwrap(schema.syncSchema({ head: 'main', dormantPolicy: 'prune' }))
    expect(unwrap(world.getValue(synced.id, ['actors', 'hp', '$val']))).toEqual(some(7))
    expect(unwrap(world.getValue(synced.id, ['actors', '$exists']))).toEqual(some(true))
    expect(unwrap(schema.get(synced.id, current.lens.$.hp))).toEqual(some(7))
    expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
    expect(unwrap(world.getValue(first.id, ['actors', 'hp', '$val']))).toEqual(some(7))
  })

  test('disabling custom fields converts instances and clears old custom data', async () => {
    const { ctx, schema, world } = setup()
    const old = await register(ctx, s.struct({}).extensible())
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => {
        tx.defineCustom(old.lens, 'luck', s.num(), 3, { summary: 'old' })
      }),
    )
    await old.dispose()
    const current = await register(ctx, s.struct({}))
    const blocking = unwrap(schema.checkDrift(first.id))
    const incompatibility = blocking.incompatibilities.find(
      (item) => item.reason === 'custom_disabled_with_existing_instances',
    )
    expect(incompatibility?.schemaPath).toEqual(['actors'])
    expect(incompatibility?.affectedInstancePaths).toEqual([['actors']])
    expect(blocking.compatibleChanges.some((item) => item.schemaPath[0] === 'actors')).toBe(false)
    expect(schema.syncSchema({ head: 'main' })).toMatchObject({
      ok: false,
      error: { kind: 'incompatible_schema_drift' },
    })
    const synced = unwrap(
      schema.syncSchema({
        head: 'main',
        fieldMigrations: {
          [encodePathKey(['actors'])]: ({ oldInspection }) => {
            expect(oldInspection.kind).toBe('some')
            return ok({})
          },
        },
      }),
    )
    expect(unwrap(schema.get(synced.id, current.lens))).toEqual(some({}))
    expect(unwrap(world.getNode(synced.id, ['actors', '$custom', 'luck']))).toEqual(NONE)
    expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
    expect(unwrap(world.getValue(first.id, ['actors', '$custom', 'luck', '$val']))).toEqual(some(3))
  })

  test('disabling custom fields without custom instances is compatible', async () => {
    const { ctx, schema } = setup()
    const old = await register(ctx, s.struct({}).extensible())
    const first = unwrap(schema.commit({ head: 'main', message: 'old' }))
    await old.dispose()
    const current = await register(ctx, s.struct({}))
    const drift = unwrap(schema.checkDrift(first.id))
    expect(drift.incompatibilities).toEqual([])
    expect(drift.compatibleChanges.find((item) => item.schemaPath[0] === 'actors')?.reason).toBe(
      'default_value_updated',
    )
    const synced = unwrap(schema.syncSchema({ head: 'main' }))
    expect(unwrap(schema.get(synced.id, current.lens))).toEqual(some({}))
    expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
  })

  test('struct-shaped migration dictionaries are data, not Options', async () => {
    const { ctx, schema, world } = setup()
    const oldAlpha = await register(ctx, s.num(), ['alpha'])
    const oldBeta = await register(ctx, s.num(), ['beta'])
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => {
        tx.set(oldAlpha.lens, 5)
        tx.set(oldBeta.lens, 6)
      }),
    )
    await oldAlpha.dispose()
    await oldBeta.dispose()
    const alpha = await register(ctx, s.struct({ kind: s.str() }), ['alpha'])
    const beta = await register(ctx, s.struct({ kind: s.str(), value: s.num().default(2) }), [
      'beta',
    ])
    const synced = unwrap(
      schema.syncSchema({
        head: 'main',
        fieldMigrations: {
          [encodePathKey(['alpha'])]: () => ok({ kind: 'none' }),
          [encodePathKey(['beta'])]: () => ok({ kind: 'some', value: 9 }),
        },
      }),
    )
    expect(unwrap(schema.get(synced.id, alpha.lens.$.kind))).toEqual(some('none'))
    expect(unwrap(schema.get(synced.id, beta.lens.$.kind))).toEqual(some('some'))
    expect(unwrap(schema.get(synced.id, beta.lens.$.value))).toEqual(some(9))
    expect(unwrap(world.getValue(first.id, ['alpha', '$val']))).toEqual(some(5))
    expect(unwrap(world.getValue(first.id, ['beta', '$val']))).toEqual(some(6))
  })
})
