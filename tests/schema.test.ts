import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { err, NONE, ok, some } from '@sekaisen/core'
import type { LensFor, SchemaNode, SchemaTransaction } from '@sekaisen/plugin-schema'
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

describe('schema transactions', () => {
  test('scoped updates preserve nested augment values, custom values, metadata and dormant fields', async () => {
    const { ctx, world, schema } = setup()
    const model = s.map(
      s
        .struct({
          name: s.str(),
          config: s.struct({ hp: s.num().default(10) }),
          note: s.str().optional(),
        })
        .extensible(),
    )
    const base = unwrap(schema.define(['actors'], model))
    let augmented!: ReturnType<typeof extend>
    function extend(scope: Context) {
      return unwrap(scope.schema.augment(base.at('alice').$.config, { armor: s.num().default(2) }))
    }
    const plugin = ctx.plugin((scope: Context) => {
      augmented = extend(scope)
    })
    await plugin
    const alice = base.at('alice')
    const root = unwrap(
      schema.commit({ head: 'main', message: 'create' }, (tx) => {
        tx.set(alice, { name: 'Alice' })
        tx.setWithMeta(augmented.$.armor, 7, { summary: 'plate' })
        tx.defineCustom(alice, 'luck', s.num(), 4, { summary: 'lucky' })
        tx.setWithMeta(alice.$.name, 'Alice', { summary: 'identity' })
      }),
    )
    const next = unwrap(
      schema.commit({ head: 'main', message: 'update' }, (tx) => {
        tx.set(alice, { name: 'Alicia', config: { hp: 8 } })
        tx.update(alice.$.config.$.hp, (hp) => hp - 1)
        expect(present(unwrap(tx.get(alice.$.config.$.hp)))).toBe(7)
      }),
    )
    expect(present(unwrap(schema.get(next.id, augmented.$.armor)))).toBe(7)
    expect(present(unwrap(schema.getWithMeta(next.id, augmented.$.armor))).meta.summary).toBe(
      'plate',
    )
    expect(present(unwrap(schema.get(next.id, alice.custom('luck', s.num()))))).toBe(4)
    expect(present(unwrap(schema.getWithMeta(next.id, alice.$.name))).meta.summary).toBe('identity')
    expect(next.diff.every((op) => op.path[0] !== '$schemas')).toBe(true)
    await plugin.dispose()
    const dormant = unwrap(schema.checkDrift(next.id))
    expect(dormant.incompatibilities).toEqual([])
    expect(dormant.dormantSchemas.map((item) => item.schemaPath)).toContainEqual([
      'actors',
      '*',
      'config',
      'armor',
    ])
    const afterUnload = unwrap(
      schema.commit({ head: 'main', message: 'base-only' }, (tx) =>
        tx.set(alice, { name: 'Alice', config: { hp: 6 } }),
      ),
    )
    expect(
      present(
        unwrap(world.getValue(afterUnload.id, ['actors', 'alice', 'config', 'armor', '$val'])),
      ),
    ).toBe(7)
    const historical = present(
      unwrap(schema.inspectInstance(afterUnload.id, ['actors', 'alice', 'config'])),
    )
    expect(historical.nodeKind).toBe('struct')
    if (historical.nodeKind === 'struct') expect(historical.dormantFieldKeys).toEqual(['armor'])
    expect(present(unwrap(schema.get(root.id, alice.$.config.$.hp)))).toBe(10)
  })

  test('containers and membership distinguish absence from empty values and normalize no-op drafts', () => {
    const { schema } = setup()
    const root = unwrap(
      schema.define(
        ['data'],
        s.struct({
          nested: s.struct({ value: s.str().optional() }).optional(),
          maps: s.map(s.map(s.str())),
          values: s.map(s.num().default(3)),
        }),
      ),
    )
    const first = unwrap(
      schema.commit({ head: 'main', message: 'create' }, (tx) => {
        tx.set(root.$.nested, {})
        tx.set(root.$.maps.at('empty'), {})
        tx.set(root.$.values.at('one'), 1)
      }),
    )
    expect(unwrap(schema.get(first.id, root.$.nested))).toEqual(some({ value: NONE }))
    expect(unwrap(schema.get(first.id, root.$.maps.at('empty')))).toEqual(some({}))
    expect(unwrap(schema.get(first.id, root.$.values.at('missing')))).toEqual(NONE)
    expect(unwrap(schema.get(first.id, root.$.maps.at('missing').at('deeper')))).toEqual(NONE)
    const noOp = unwrap(
      schema.commit({ head: 'main', message: 'no-op' }, (tx) => {
        tx.set(root.$.values.at('temp'), 99)
        tx.delete(root.$.values.at('temp'))
        tx.set(root.$.values.at('one'), 2)
        tx.set(root.$.values.at('one'), 1)
      }),
    )
    expect(noOp.diff).toEqual([])
    const removed = unwrap(
      schema.commit({ head: 'main', message: 'delete' }, (tx) => {
        tx.set(root.$.nested, NONE)
        tx.delete(root.$.maps.at('empty'))
      }),
    )
    expect(unwrap(schema.get(removed.id, root.$.nested))).toEqual(NONE)
    expect(unwrap(schema.listKeys(removed.id, root.$.maps))).toEqual([])
  })

  test('validators see final drafts, reject atomically, CAS prevents callback-induced lost updates, escaped transactions close', () => {
    const { schema, world } = setup()
    const hp = unwrap(schema.define(['hp'], s.num().default(10)))
    const first = unwrap(schema.commit({ head: 'main', message: 'initial' }))
    const remove = schema.addCommitValidator(({ draft }) => {
      const current = present(unwrap(draft.get(hp)))
      return current < 0
        ? err({ path: hp.path, validatorName: 'positive', reason: 'negative hp' })
        : ok(undefined)
    })
    expect(
      schema.commit({ head: 'main', message: 'invalid' }, (tx) => tx.set(hp, -1)),
    ).toMatchObject({ ok: false, error: { kind: 'validator_rejected' } })
    expect(world.getHead('main')).toEqual(some(first.id))
    expect(unwrap(world.getChildren(first.id))).toEqual([])
    let escaped!: SchemaTransaction
    const second = unwrap(
      schema.commit({ head: 'main', message: 'valid' }, (tx) => {
        escaped = tx
        tx.set(hp, -1)
        tx.set(hp, 5)
      }),
    )
    expect(() => escaped.set(hp, 9)).toThrow('ended')
    const other = unwrap(
      world.commit({ parentId: some(second.id), message: 'competing', advanceHead: 'other' }),
    )
    expect(
      schema.commit({ head: 'main', message: 'stale' }, (tx) => {
        tx.set(hp, 4)
        unwrap(world.setHead('main', other.id))
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'world_error', error: { kind: 'head_cas_mismatch' } },
    })
    remove()
  })

  test('custom evidence, deletion constraints and full overwrite enforce their different boundaries', () => {
    const { schema } = setup()
    const lens = unwrap(
      schema.define(
        ['item'],
        s.struct({ hp: s.num().default(2), note: s.str().optional() }).extensible(),
      ),
    )
    const first = unwrap(
      schema.commit({ head: 'main', message: 'initial' }, (tx) => {
        tx.defineCustom(lens, 'extra', s.str(), 'hello')
        tx.set(lens.$.note, 'note')
      }),
    )
    expect(schema.get(first.id, lens.custom('extra', s.num()))).toMatchObject({
      ok: false,
      error: { kind: 'schema_type_mismatch' },
    })
    expect(
      schema.commit({ head: 'main', message: 'shadow' }, (tx) => {
        tx.defineCustom(lens, 'hp', s.num(), 3)
      }),
    ).toMatchObject({ ok: false, error: { reason: 'custom_key_shadows_struct_field' } })
    expect(
      schema.commit({ head: 'main', message: 'undeclared' }, (tx) => {
        tx.set(lens.custom('unknown', s.str()), 'bad')
      }),
    ).toMatchObject({ ok: false, error: { reason: 'undefined_custom_key' } })
    const overwritten = unwrap(
      schema.commit({ head: 'main', message: 'reset' }, (tx) => tx.overwriteStruct(lens, {})),
    )
    expect(unwrap(schema.get(overwritten.id, lens))).toEqual(
      some({ hp: 2, note: NONE, $custom: {} }),
    )
  })
})

describe('schema evolution', () => {
  test('virtual defaults navigate top-down, sync backfills, old Writer corruption is never hidden', async () => {
    const { ctx, schema, world } = setup()
    const old = await register(
      ctx,
      s.map(s.struct({ name: s.str(), config: s.struct({ hp: s.num().default(4) }).optional() })),
    )
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) =>
        tx.set(old.lens.at('alice'), { name: 'Alice' }),
      ),
    )
    await old.dispose()
    const current = await register(
      ctx,
      s.map(
        s.struct({
          name: s.str(),
          config: s.struct({ hp: s.num().default(4), tags: s.map(s.str()) }),
        }),
      ),
    )
    expect(unwrap(schema.get(first.id, current.lens.at('alice').$.config.$.hp))).toEqual(some(4))
    expect(unwrap(schema.get(first.id, current.lens.at('alice').$.config))).toEqual(
      some({ hp: 4, tags: {} }),
    )
    expect(
      unwrap(schema.get(first.id, current.lens.at('alice').$.config.$.tags.at('missing'))),
    ).toEqual(NONE)
    expect(schema.commit({ head: 'main', message: 'must-sync' })).toMatchObject({
      ok: false,
      error: { kind: 'schema_drift_requires_sync' },
    })
    const synced = unwrap(schema.syncSchema({ head: 'main' }))
    expect(unwrap(world.getValue(synced.id, ['actors', 'alice', 'config', '$exists']))).toEqual(
      some(true),
    )
    expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
    const broken = unwrap(
      world.commit({
        parentId: some(synced.id),
        message: 'corrupt',
        diff: [{ op: 'del', path: ['actors', 'alice', 'config'] }],
      }),
    )
    await current.dispose()
    const relaxed = await register(
      ctx,
      s.map(
        s.struct({
          name: s.str(),
          config: s.struct({ hp: s.num().default(4), tags: s.map(s.str()) }).optional(),
        }),
      ),
    )
    expect(schema.get(broken.id, relaxed.lens.at('alice').$.config.$.hp)).toMatchObject({
      ok: false,
      error: { kind: 'corrupted_instance_data' },
    })
  })

  test('custom promotion moves values and metadata once; incompatible migration reads immutable source', async () => {
    const { ctx, schema, world } = setup()
    const original = await register(ctx, s.map(s.struct({ a: s.num(), b: s.num() }).extensible()))
    const first = unwrap(
      schema.commit({ head: 'main', message: 'old' }, (tx) => {
        const alice = original.lens.at('alice')
        tx.set(alice, { a: 1, b: 2 })
        tx.defineCustom(alice, 'luck', s.num(), 9, { summary: 'retained' })
      }),
    )
    await original.dispose()
    const next = await register(
      ctx,
      s.map(s.struct({ a: s.str(), b: s.str(), luck: s.num().default(0) }).extensible()),
    )
    const report = unwrap(schema.checkDrift(first.id))
    expect(report.promotedCustomFields).toMatchObject([
      { fieldKey: 'luck', instancePaths: [['actors', 'alice']] },
    ])
    expect(schema.syncSchema({ head: 'main' })).toMatchObject({
      ok: false,
      error: { kind: 'incompatible_schema_drift' },
    })
    const synced = unwrap(
      schema.syncSchema({
        head: 'main',
        fieldMigrations: {
          [encodePathKey(['actors', '*', 'a'])]: ({ inspectBeforeMigration }) => {
            const old = present(unwrap(inspectBeforeMigration(['actors', 'alice', 'b'])))
            return ok(`b=${old.nodeKind === 'leaf' ? old.value : 'invalid'}`)
          },
          [encodePathKey(['actors', '*', 'b'])]: ({ inspectBeforeMigration }) => {
            const old = present(unwrap(inspectBeforeMigration(['actors', 'alice', 'a'])))
            return ok(`a=${old.nodeKind === 'leaf' ? old.value : 'invalid'}`)
          },
        },
      }),
    )
    expect(unwrap(schema.get(synced.id, next.lens.at('alice').$.a))).toEqual(some('b=2'))
    expect(unwrap(schema.get(synced.id, next.lens.at('alice').$.b))).toEqual(some('a=1'))
    expect(
      present(unwrap(schema.getWithMeta(synced.id, next.lens.at('alice').$.luck))),
    ).toMatchObject({ value: 9, meta: { summary: 'retained' } })
    expect(unwrap(world.getNode(synced.id, ['actors', 'alice', '$custom', 'luck']))).toEqual(NONE)
    expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
  })

  test('presence changes require sync even without backfill, dormant prune removes both definition and data', async () => {
    const { ctx, schema, world } = setup()
    const base = await register(
      ctx,
      s.struct({ hp: s.num().default(10), optional: s.str().optional() }),
    )
    const first = unwrap(schema.commit({ head: 'main', message: 'old' }))
    await base.dispose()
    const updated = await register(
      ctx,
      s.struct({ hp: s.num().default(20), optional: s.str().optional(), note: s.str().optional() }),
    )
    expect(schema.commit({ head: 'main', message: 'blocked' })).toMatchObject({
      ok: false,
      error: { kind: 'schema_drift_requires_sync' },
    })
    const synced = unwrap(schema.syncSchema({ head: 'main' }))
    expect(unwrap(schema.get(synced.id, updated.lens.$.hp))).toEqual(some(10))
    expect(unwrap(schema.get(first.id, updated.lens.$.note))).toEqual(NONE)
    await updated.dispose()
    const pruned = unwrap(schema.syncSchema({ head: 'main', dormantPolicy: 'prune' }))
    expect(unwrap(world.getNode(pruned.id, ['actors']))).toEqual(NONE)
    expect(unwrap(schema.checkDrift(pruned.id)).isClean).toBe(true)
  })
})

describe('schema messages and references', () => {
  test('binary messages preserve bytes, scalar lists, Unicode and optional empty containers after plugin unload', async () => {
    const { ctx, schema } = setup()
    const payload = s.struct({
      title: s.str(),
      bytes: s.bytes(),
      samples: s.list('num'),
      details: s.struct({ optional: s.str().optional() }).optional(),
      map: s.map(s.map(s.bool())),
    })
    let prism!: ReturnType<typeof define>
    function define(scope: Context) {
      return unwrap(scope.schema.defineMessage('event', payload))
    }
    const fiber = ctx.plugin((scope: Context) => {
      prism = define(scope)
    })
    await fiber
    const message = prism.create({
      title: '世界\u{10000}',
      bytes: new Uint8Array([0, 255]),
      samples: [0, -2, 4.5],
      details: {},
      map: { empty: {} },
    })
    const node = unwrap(schema.commit({ message }))
    await fiber.dispose()
    expect(unwrap(schema.getMessage(node.id))).toEqual(message)
    expect(unwrap(schema.getMessageAs(node.id, prism))).toEqual(some(message.data))
    const text = unwrap(schema.commit({ message: 'plain text' }))
    expect(unwrap(schema.getMessage(text.id))).toEqual({ kind: '$text', data: 'plain text' })
  })

  test('schema refs use world pins, metadata changes affect logical refs, plain scalar updates retain meta', () => {
    const { schema, world } = setup()
    const data = unwrap(schema.define(['data'], s.bytes().default(new Uint8Array([1, 2]))))
    const ref = unwrap(schema.define(['trace'], s.ref().optional()))
    const first = unwrap(schema.commit({ head: 'main', message: 'world' }))
    const trace = unwrap(
      schema.commit({ parentId: NONE, message: 'trace' }, (tx) =>
        tx.set(ref, { commitId: first.id, path: data.path }),
      ),
    )
    expect(unwrap(world.getReferencingCommits(first.id))).toEqual([trace.id])
    const second = unwrap(
      schema.commit({ head: 'main', message: 'meta' }, (tx) =>
        tx.setWithMeta(data, new Uint8Array([1, 2]), { summary: 'bytes' }),
      ),
    )
    expect(unwrap(world.isRefChanged({ commitId: first.id, path: data.path }, second.id))).toBe(
      true,
    )
    expect(
      unwrap(world.isRefChanged({ commitId: first.id, path: [...data.path, '$val'] }, second.id)),
    ).toBe(false)
    const third = unwrap(
      schema.commit({ head: 'main', message: 'value' }, (tx) => tx.set(data, new Uint8Array([3]))),
    )
    expect(present(unwrap(schema.getWithMeta(third.id, data))).meta).toEqual({ summary: 'bytes' })
    const copy = present(unwrap(schema.get(third.id, data)))
    copy[0] = 99
    expect(unwrap(schema.get(third.id, data))).toEqual(some(new Uint8Array([3])))
  })
})

test('added required subtrees require per-instance migrations while absent optional ancestors short-circuit', async () => {
  const { ctx, schema } = setup()
  const old = await register(ctx, s.map(s.struct({ name: s.str() })))
  const first = unwrap(
    schema.commit({ head: 'main', message: 'old' }, (tx) =>
      tx.set(old.lens.at('alice'), { name: 'Alice' }),
    ),
  )
  await old.dispose()
  const current = await register(
    ctx,
    s.map(
      s.struct({
        name: s.str(),
        required: s.struct({ limit: s.num(), lookup: s.map(s.str()) }),
        optional: s.struct({ required: s.num() }).optional(),
      }),
    ),
  )
  expect(schema.get(first.id, current.lens.at('alice').$.required.$.limit)).toMatchObject({
    ok: false,
    error: { kind: 'unmigrated_required_field' },
  })
  expect(unwrap(schema.get(first.id, current.lens.at('alice').$.optional.$.required))).toEqual(NONE)
  expect(schema.syncSchema({ head: 'main' })).toMatchObject({
    ok: false,
    error: { kind: 'incompatible_schema_drift' },
  })
  const synced = unwrap(
    schema.syncSchema({
      head: 'main',
      fieldMigrations: {
        [encodePathKey(['actors', '*', 'required'])]: ({ oldInspection, targetNodePath }) => {
          expect(oldInspection).toEqual(NONE)
          expect(targetNodePath).toEqual(['actors', 'alice', 'required'])
          return ok({ limit: 5 })
        },
      },
    }),
  )
  expect(unwrap(schema.get(synced.id, current.lens.at('alice').$.required))).toEqual(
    some({ limit: 5, lookup: {} }),
  )
})

test('kind changes replace old physical discriminators and custom converters receive source values', async () => {
  const { ctx, schema, world } = setup()
  const old = await register(ctx, s.struct({ value: s.num().default(3) }).extensible())
  const first = unwrap(
    schema.commit({ head: 'main', message: 'old' }, (tx) => {
      tx.defineCustom(old.lens, 'luck', s.num(), 8, { summary: 'old' })
    }),
  )
  await old.dispose()
  const current = await register(
    ctx,
    s
      .struct({
        value: s.struct({ amount: s.num() }),
        luck: s.num().default(0),
      })
      .extensible(),
  )
  const synced = unwrap(
    schema.syncSchema({
      head: 'main',
      fieldMigrations: {
        [encodePathKey(['actors', 'value'])]: ({ oldInspection }) => {
          const oldValue = present(oldInspection)
          if (oldValue.nodeKind !== 'leaf' || typeof oldValue.value !== 'number')
            throw new Error('Expected numeric source')
          return ok({ amount: oldValue.value + 1 })
        },
        [encodePathKey(['actors', 'luck'])]: ({ oldInspection }) => {
          const oldValue = present(oldInspection)
          if (oldValue.nodeKind !== 'leaf' || typeof oldValue.value !== 'number')
            throw new Error('Expected custom source')
          return ok({ $val: oldValue.value * 2, $meta: { summary: 'converted' } })
        },
      },
    }),
  )
  expect(unwrap(schema.get(synced.id, current.lens.$.value.$.amount))).toEqual(some(4))
  expect(unwrap(world.getValue(synced.id, ['actors', 'value', '$val']))).toEqual(NONE)
  expect(present(unwrap(schema.getWithMeta(synced.id, current.lens.$.luck)))).toMatchObject({
    value: 16,
    meta: { summary: 'converted' },
  })
  expect(unwrap(world.getNode(synced.id, ['actors', '$custom', 'luck']))).toEqual(NONE)
  expect(unwrap(schema.inspectInstance(first.id, ['actors']))).toMatchObject({
    kind: 'some',
    value: { customFields: { luck: { value: 8 } } },
  })
})

test('malformed binary messages fail closed while optional leaves and byte lists round-trip', () => {
  const { schema, world } = setup()
  const prism = unwrap(
    schema.defineMessage(
      'binary',
      s.struct({
        bytes: s.list('bytes'),
        flag: s.bool().optional(),
        optionalMap: s.map(s.str()).optional(),
      }),
    ),
  )
  const message = prism.create({
    bytes: [new Uint8Array([0, 128, 255])],
    flag: true,
    optionalMap: {},
  })
  const first = unwrap(schema.commit({ message }))
  expect(unwrap(schema.getMessage(first.id))).toEqual(message)
  const bytes = unwrap(world.getMessage(first.id))
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected encoded bytes')
  for (const invalid of [
    bytes.subarray(0, bytes.length - 1),
    new Uint8Array([...bytes, 0]),
    new Uint8Array([255, ...bytes.subarray(1)]),
  ]) {
    const malformed = unwrap(world.commit({ parentId: some(first.id), message: invalid }))
    expect(schema.getMessage(malformed.id)).toMatchObject({
      ok: false,
      error: { kind: 'message_decode_error', commitId: malformed.id },
    })
  }
  const other = unwrap(schema.defineMessage('other', s.struct({})))
  expect(other.parse(message)).toEqual(ok(NONE))
})

test('legal prototype-shaped identifiers work across fields, Map entries, custom keys and metadata', () => {
  const { schema } = setup()
  const root = unwrap(
    schema.define(
      ['weird'],
      s.map(
        s
          .struct({
            ['__proto__']: s.str().default('proto'),
            constructor: s.num().default(1),
          })
          .extensible(),
      ),
    ),
  )
  const entry = root.at('__proto__')
  const first = unwrap(
    schema.commit({ message: 'prototype keys' }, (tx) => {
      tx.set(entry, { constructor: 1 })
      tx.defineCustom(entry, 'toString', s.str(), 'custom', { ['__proto__']: 'meta' })
    }),
  )
  expect(unwrap(schema.get(first.id, entry.field('__proto__')))).toEqual(some('proto'))
  expect(unwrap(schema.get(first.id, entry.$.constructor))).toEqual(some(1))
  expect(
    present(unwrap(schema.getWithMeta(first.id, entry.custom('toString', s.str())))),
  ).toMatchObject({ value: 'custom', meta: { ['__proto__']: 'meta' } })
  expect(unwrap(schema.listKeys(first.id, root))).toEqual(['__proto__'])
  expect(schema.define(['$reserved'], s.str())).toMatchObject({
    ok: false,
    error: { kind: 'invalid_schema_identifier' },
  })
  expect(() => root.at('$invalid')).toThrow()
})

test('schema AST cycles fail through the structured error channel', () => {
  const { schema } = setup()
  const fields: Record<string, SchemaNode> = {}
  const cycle = {
    nodeKind: 'struct',
    fields,
    allowCustom: false,
    presence: { mode: 'optional' },
    description: '',
    metadata: {},
  } as const
  fields.loop = cycle
  expect(schema.define(['cycle'], cycle)).toMatchObject({
    ok: false,
    error: { kind: 'validation_failed', reason: 'type_mismatch' },
  })
})

test('overlapping dormant roots require explicit pruning without leaving stale ancestors', async () => {
  const { ctx, schema, world } = setup()
  const old = await register(ctx, s.struct({ old: s.num().default(1) }), ['data'])
  const first = unwrap(schema.commit({ head: 'main', message: 'old root' }))
  await old.dispose()
  const current = await register(ctx, s.map(s.str()), ['data', 'items'])
  expect(schema.syncSchema({ head: 'main' })).toMatchObject({
    ok: false,
    error: { kind: 'schema_conflict', reason: 'overlapping_root_path' },
  })
  expect(world.getHead('main')).toEqual(some(first.id))
  const synced = unwrap(schema.syncSchema({ head: 'main', dormantPolicy: 'prune' }))
  expect(unwrap(schema.get(synced.id, current.lens))).toEqual(some({}))
  expect(unwrap(world.getValue(synced.id, ['data', '$exists']))).toEqual(NONE)
  expect(unwrap(world.getNode(synced.id, ['data', 'old']))).toEqual(NONE)
  expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
})

test('caller buffers and validator diff buffers cannot mutate the validated commit', () => {
  const { schema } = setup()
  const data = unwrap(schema.define(['data'], s.bytes().default(new Uint8Array([1]))))
  schema.addCommitValidator(({ draft, diff }) => {
    for (const op of diff)
      if (op.op === 'set' && op.path[0] === 'data' && op.value instanceof Uint8Array)
        op.value[0] = 99
    expect(unwrap(draft.get(data))).toEqual(some(new Uint8Array([2])))
    return ok(undefined)
  })
  const input = new Uint8Array([2])
  const committed = unwrap(
    schema.commit({ message: 'owned bytes' }, (tx) => {
      tx.set(data, input)
      input[0] = 88
    }),
  )
  expect(unwrap(schema.get(committed.id, data))).toEqual(some(new Uint8Array([2])))
})
