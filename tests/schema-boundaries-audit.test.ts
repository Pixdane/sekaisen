import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { LensFor, SchemaNode } from '@sekaisen/plugin-schema'
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

/** Register a Reader root in its own Cordis fiber so the test can unload it. */
async function register<S extends SchemaNode>(
  ctx: Context,
  path: readonly string[],
  node: S,
): Promise<{ lens: LensFor<S>; dispose: () => Promise<void> }> {
  let lens!: LensFor<S>
  const fiber = ctx.plugin((scope: Context) => {
    lens = unwrap(scope.schema.define(path, node))
  })
  await fiber
  return { lens, dispose: () => fiber.dispose() }
}

describe('Writer declaration boundaries', () => {
  test('historical declarations ignore a newer Reader and need no physical value', async () => {
    const { ctx, world, schema } = setup()
    const actors = await register(
      ctx,
      ['actors'],
      s.map(
        s
          .struct({
            name: s.str(),
            nickname: s.str().optional(),
            stats: s.map(s.num()).optional(),
            nested: s.struct({ note: s.str().optional() }).optional(),
          })
          .extensible(),
      ),
    )
    const archives = await register(
      ctx,
      ['archives'],
      s.map(s.struct({ label: s.str(), parent: s.str().optional() })),
    )
    const seed = unwrap(
      schema.commit({ head: 'main', message: 'seed writer history' }, (tx) => {
        tx.set(actors.lens.at('alice'), { name: 'Alice' })
        tx.set(archives.lens.at('tome'), { label: 'Tome' })
        tx.defineCustom(actors.lens.at('alice'), 'luck', s.num().desc('fortune'), 7, {
          summary: 'lucky',
        })
      }),
    )
    // Stored custom declaration survives while its value is physically gone.
    const withoutValue = unwrap(
      world.commit({
        parentId: some(seed.id),
        message: 'drop custom value only',
        diff: [
          {
            op: 'del',
            path: ['actors', 'alice', '$custom', 'luck', '$val'],
          },
        ],
      }),
    )
    await actors.dispose()
    await archives.dispose()
    // A newer Reader for the same root must not redefine the old view.
    await register(
      ctx,
      ['actors'],
      s.map(s.struct({ label: s.str(), archived: s.bool().default(false) })),
    )

    const view = unwrap(schema.viewAt(withoutValue.id))
    const root = present(unwrap(view.writerSchemaAt(['actors'])))
    expect(root.nodeKind).toBe('map')
    if (root.nodeKind === 'map') expect(root.valueSchema.nodeKind).toBe('struct')

    const nickname = present(unwrap(view.writerSchemaAt(['actors', 'alice', 'nickname'])))
    expect(nickname).toMatchObject({
      nodeKind: 'leaf',
      valueKind: 'str',
      presence: { mode: 'optional' },
    })

    const member = present(unwrap(view.writerSchemaAt(['actors', 'alice', 'stats', 'ghost'])))
    expect(member).toMatchObject({ nodeKind: 'leaf', valueKind: 'num' })

    const nested = present(unwrap(view.writerSchemaAt(['actors', 'alice', 'nested', 'note'])))
    expect(nested).toMatchObject({ nodeKind: 'leaf', valueKind: 'str' })

    // Writer-only dormant root remains addressable after its Reader unloads.
    const dormant = present(unwrap(view.writerSchemaAt(['archives', 'tome', 'parent'])))
    expect(dormant).toMatchObject({ nodeKind: 'leaf', valueKind: 'str' })

    // The custom declaration is read from the stored `$spec`, not from `$val`.
    const luck = present(unwrap(view.writerSchemaAt(['actors', 'alice', '$custom', 'luck'])))
    expect(luck).toMatchObject({
      nodeKind: 'leaf',
      valueKind: 'num',
      description: 'fortune',
    })

    // Newer Reader-only fields and unknown coordinates stay undeclared.
    expect(unwrap(view.writerSchemaAt(['actors', 'alice', 'label']))).toEqual(NONE)
    expect(unwrap(view.writerSchemaAt(['actors', 'alice', 'missing']))).toEqual(NONE)
    expect(unwrap(view.writerSchemaAt(['actors', 'alice', 'name', 'deeper']))).toEqual(NONE)
    expect(unwrap(view.writerSchemaAt(['actors', 'alice', '$custom', 'ghost']))).toEqual(NONE)
    expect(unwrap(view.writerSchemaAt(['actors', 'alice', '$custom']))).toEqual(NONE)
    expect(unwrap(view.writerSchemaAt(['strangers', 'bob']))).toEqual(NONE)
    expect(unwrap(view.writerSchemaAt([]))).toEqual(NONE)

    // Declarations are owned frozen copies, so callers cannot mutate the catalog.
    expect(Object.isFrozen(root)).toBe(true)
    expect(Object.isFrozen(nickname)).toBe(true)
  })

  test('a malformed stored custom declaration is corruption, never NONE', async () => {
    const { world, schema } = setup()
    const actors = unwrap(
      schema.define(['actors'], s.map(s.struct({ name: s.str() }).extensible())),
    )
    const seed = unwrap(
      schema.commit({ head: 'main', message: 'custom seed' }, (tx) => {
        tx.set(actors.at('alice'), { name: 'Alice' })
        tx.defineCustom(actors.at('alice'), 'luck', s.num(), 3)
      }),
    )
    const broken = unwrap(
      world.commit({
        parentId: some(seed.id),
        message: 'break custom spec',
        diff: [
          {
            op: 'del',
            path: ['actors', 'alice', '$custom', 'luck', '$spec', 'valueKind'],
          },
        ],
      }),
    )
    const result = unwrap(schema.viewAt(broken.id)).writerSchemaAt([
      'actors',
      'alice',
      '$custom',
      'luck',
    ])
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'corrupted_instance_data',
        path: ['actors', 'alice', '$custom', 'luck', '$spec', 'valueKind'],
      },
    })
  })

  test('draft declarations cover a newly defined root commit and drafted customs', () => {
    const { schema } = setup()
    const actors = unwrap(
      schema.define(
        ['actors'],
        s.map(
          s
            .struct({
              name: s.str(),
              nickname: s.str().optional(),
              stats: s.map(s.num()).optional(),
            })
            .extensible(),
        ),
      ),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'root draft declarations' }, (tx) => {
        // The root commit binds the active Reader as its Writer catalog, so
        // definitions are addressable before any instance exists.
        expect(present(unwrap(tx.writerSchemaAt(['actors', 'nobody', 'nickname'])))).toMatchObject({
          nodeKind: 'leaf',
          valueKind: 'str',
        })
        expect(
          present(unwrap(tx.writerSchemaAt(['actors', 'nobody', 'stats', 'ghost']))),
        ).toMatchObject({
          nodeKind: 'leaf',
          valueKind: 'num',
        })
        expect(unwrap(tx.writerSchemaAt(['actors', 'nobody', 'missing']))).toEqual(NONE)

        tx.set(actors.at('alice'), { name: 'Alice' })
        tx.defineCustom(actors.at('alice'), 'luck', s.str().desc('drafted fortune'), 'yes')
        expect(
          present(unwrap(tx.writerSchemaAt(['actors', 'alice', '$custom', 'luck']))),
        ).toMatchObject({
          nodeKind: 'leaf',
          valueKind: 'str',
          description: 'drafted fortune',
        })
      }),
    )
    const view = unwrap(schema.viewAt(commit.id))
    expect(
      present(unwrap(view.writerSchemaAt(['actors', 'alice', '$custom', 'luck']))),
    ).toMatchObject({ nodeKind: 'leaf', valueKind: 'str' })
    expect(present(unwrap(view.writerSchemaAt(['actors', 'alice', 'nickname'])))).toMatchObject({
      nodeKind: 'leaf',
      valueKind: 'str',
    })
  })
})

describe('transaction savepoints', () => {
  test('failure restores values, deletes, custom specs and metadata while keeping earlier writes', () => {
    const { schema } = setup()
    const actors = unwrap(
      schema.define(
        ['actors'],
        s.map(
          s
            .struct({
              name: s.str(),
              hp: s.num().default(10),
              alias: s.str().optional(),
              scores: s.map(s.num()).optional(),
            })
            .extensible(),
        ),
      ),
    )
    const alice = actors.at('alice')
    unwrap(
      schema.commit({ head: 'main', message: 'seed savepoint state' }, (tx) => {
        tx.set(alice, { name: 'Alice', hp: 10, alias: 'A', scores: { x: 1, keep: 2 } })
        tx.setWithMeta(alice.$.name, 'Alice', { summary: 'identity' })
        tx.defineCustom(alice, 'luck', s.num(), 4, { summary: 'lucky' })
      }),
    )
    const failure = new Error('savepoint boom')
    const next = unwrap(
      schema.commit({ head: 'main', message: 'savepoint rollback' }, (tx) => {
        const custom = alice.custom('luck', s.num())
        // This successful write predates the savepoint and must survive it.
        tx.set(alice.$.hp, 11)

        let caught: unknown
        try {
          tx.atomic(() => {
            tx.set(alice.$.hp, 99)
            tx.delete(alice.$.alias)
            tx.delete(alice.$.scores.at('x'))
            tx.set(alice.$.scores.at('y'), 3)
            tx.setWithMeta(alice.$.name, 'Inside', { summary: 'changed' })
            tx.delete(custom)
            tx.defineCustom(alice, 'doomed', s.str(), 'gone', { summary: 'temporary' })
            throw failure
          })
        } catch (cause) {
          caught = cause
        }
        expect(caught).toBe(failure)

        expect(present(unwrap(tx.get(alice.$.hp)))).toBe(11)
        expect(present(unwrap(tx.get(alice.$.alias)))).toBe('A')
        expect(present(unwrap(tx.getWithMeta(alice.$.name))).meta).toEqual({
          summary: 'identity',
        })
        const scores = present(unwrap(tx.get(alice.$.scores)))
        expect(Object.keys(scores).sort()).toEqual(['keep', 'x'])
        expect(unwrap(tx.get(alice.$.scores.at('y')))).toEqual(NONE)
        expect(present(unwrap(tx.get(custom)))).toBe(4)
        expect(present(unwrap(tx.getWithMeta(custom))).meta).toEqual({ summary: 'lucky' })
        expect(present(unwrap(tx.writerSchemaAt(custom.path)))).toMatchObject({
          nodeKind: 'leaf',
          valueKind: 'num',
        })
        expect(unwrap(tx.writerSchemaAt(['actors', 'alice', '$custom', 'doomed']))).toEqual(NONE)

        // A nested successful savepoint still merges into the outer rollback.
        let innerCaught: unknown
        try {
          tx.atomic(() => {
            tx.atomic(() => tx.set(alice.$.hp, 50))
            throw failure
          })
        } catch (cause) {
          innerCaught = cause
        }
        expect(innerCaught).toBe(failure)
        expect(present(unwrap(tx.get(alice.$.hp)))).toBe(11)
        expect(unwrap(tx.get(alice.$.scores.at('keep')))).toEqual(some(2))

        // A caught inner failure leaves the outer savepoint usable.
        const innerFailure = new Error('nested failure')
        tx.atomic(() => {
          try {
            tx.atomic(() => {
              tx.set(alice.$.hp, 60)
              throw innerFailure
            })
          } catch (cause) {
            expect(cause).toBe(innerFailure)
          }
          tx.set(alice.$.alias, 'B')
        })
        expect(present(unwrap(tx.get(alice.$.hp)))).toBe(11)
        expect(present(unwrap(tx.get(alice.$.alias)))).toBe('B')
      }),
    )
    const persisted = present(unwrap(schema.get(next.id, alice)))
    expect(persisted.hp).toBe(11)
    expect(persisted.alias).toEqual(some('B'))
    expect(present(persisted.scores)).toEqual({ keep: 2, x: 1 })
    expect(unwrap(schema.get(next.id, alice.custom('luck', s.num())))).toEqual(some(4))
    expect(present(unwrap(schema.getWithMeta(next.id, alice.$.name))).meta).toEqual({
      summary: 'identity',
    })
  })

  test('savepoints reject actual thenables but accept ordinary business data named then', () => {
    const { schema } = setup()
    const hp = unwrap(schema.define(['actors', 'alice', 'hp'], s.num().default(10)))
    unwrap(schema.commit({ head: 'main', message: 'seed hp' }, (tx) => tx.set(hp, 10)))
    const next = unwrap(
      schema.commit({ head: 'main', message: 'thenable savepoint' }, (tx) => {
        tx.set(hp, 11)
        expect(() =>
          tx.atomic(() => {
            tx.set(hp, 12)
            return Promise.resolve(12)
          }),
        ).toThrow(TypeError)
        expect(present(unwrap(tx.get(hp)))).toBe(11)
        const returned = tx.atomic(() => {
          tx.set(hp, 13)
          return Object.fromEntries([['then', 17]])
        })
        tx.set(hp, returned.then!)
      }),
    )
    expect(unwrap(schema.get(next.id, hp))).toEqual(some(17))
  })
})
