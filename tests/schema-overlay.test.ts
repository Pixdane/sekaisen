import { afterEach, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { err, NONE, ok, some } from '@sekaisen/core'
import type { LensFor, SchemaError, SchemaNode } from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { Path, SqliteDriver, SqliteStatement } from '@sekaisen/plugin-world'
import { comparePaths, decodePathKey, encodePathKey, WorldService } from '@sekaisen/plugin-world'
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
  return { ctx, world, schema, driver }
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

/* -------------------------------------------------------------------------- */
/*                     Real-driver payload access observation                 */
/* -------------------------------------------------------------------------- */

interface Trace {
  readonly sql: string
  readonly params: readonly unknown[]
}
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })
const DIFF_ENTRIES = /FROM\s+diff_entries\b/i

function tracePaths(trace: Trace): Path[] {
  if (!DIFF_ENTRIES.test(trace.sql)) return []
  const paths: Path[] = []
  for (const param of trace.params) {
    if (!(param instanceof Uint8Array)) continue
    const key = utf8.decode(param)
    if (!/^(?:0|[1-9][0-9]*):/.test(key)) continue
    try {
      paths.push(decodePathKey(key))
    } catch {
      // A non-path BLOB parameter is not a payload coordinate.
    }
  }
  return paths
}
/** Leaf payload coordinates read through SQL, deduplicated in path order. */
function payloadPaths(traces: readonly Trace[]): readonly Path[] {
  const unique = new Map<string, Path>()
  for (const trace of traces)
    for (const path of tracePaths(trace)) unique.set(encodePathKey(path), path)
  return [...unique.values()].sort(comparePaths)
}
/** Payload statements that did not target an individual path coordinate (bulk reads). */
function bulkPayloadScans(traces: readonly Trace[]): number {
  return traces.filter((trace) => DIFF_ENTRIES.test(trace.sql) && tracePaths(trace).length === 0)
    .length
}
function outsideCatalog(traces: readonly Trace[]): readonly Path[] {
  return payloadPaths(traces).filter((path) => path[0] !== '$schemas')
}
interface Recorder {
  readonly driver: SqliteDriver
  readonly traces: readonly Trace[]
  record(): void
  stop(): void
}
/**
 * Wrap a real driver: every statement still executes against SQLite, but row
 * reads are captured so tests can observe which payload coordinates were loaded.
 */
function createRecorder(base: SqliteDriver): Recorder {
  const traces: Trace[] = []
  let recording = false
  const wrap = (sql: string, statement: SqliteStatement): SqliteStatement => ({
    run: (...params) => statement.run(...params),
    get: <TRow = Record<string, unknown>>(...params: readonly unknown[]) => {
      if (recording) traces.push({ sql, params: Object.freeze([...params]) })
      return statement.get<TRow>(...params)
    },
    all: <TRow = Record<string, unknown>>(...params: readonly unknown[]) => {
      if (recording) traces.push({ sql, params: Object.freeze([...params]) })
      return statement.all<TRow>(...params)
    },
  })
  return {
    traces,
    record(): void {
      traces.length = 0
      recording = true
    },
    stop(): void {
      recording = false
    },
    driver: {
      exec: (sql) => base.exec(sql),
      prepare: (sql) => wrap(sql, base.prepare(sql)),
      transaction: <T>(fn: () => T): T => base.transaction(fn),
      close: () => base.close(),
    },
  }
}
function observe(driver: SqliteDriver) {
  const recorder = createRecorder(driver)
  const ctx = new Context()
  const world = new WorldService(ctx, { driver: recorder.driver })
  const schema = new SchemaService(ctx)
  return { ctx, world, schema, recorder }
}

/* -------------------------------------------------------------------------- */
/*                        Tombstones, restoration, scope                      */
/* -------------------------------------------------------------------------- */

test('ancestor tombstones rebuild subtrees, restore exact metadata as no-ops and isolate Map membership', () => {
  const { schema } = setup()
  const box = unwrap(
    schema.define(
      ['box'],
      s
        .struct({
          name: s.str(),
          slot: s.struct({ hp: s.num().default(10), tags: s.map(s.str()).optional() }).optional(),
          config: s.struct({ hp: s.num().default(10) }),
          items: s.map(
            s.struct({ count: s.num().default(1), note: s.str().optional() }).extensible(),
          ),
        })
        .extensible(),
    ),
  )
  const first = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(box, { name: 'first' })
      tx.setWithMeta(box.$.name, 'first', { summary: 'identity' })
      tx.set(box.$.slot, { hp: 5, tags: { x: 'y', keep: 'k' } })
      tx.set(box.$.config, { hp: 4 })
      tx.set(box.$.items.at('one'), { count: 2, note: 'old' })
      tx.set(box.$.items.at('two'), { count: 1 })
      tx.defineCustom(box, 'luck', s.num(), 3, { summary: 'lucky' })
      tx.defineCustom(box.$.items.at('two'), 'flag', s.str(), 'on', { summary: 'flag' })
      tx.setWithMeta(box.$.items.at('two').$.count, 1, { unit: 'n' })
    }),
  )
  expect(unwrap(schema.get(first.id, box.$.slot.$.tags.at('keep')))).toEqual(some('k'))

  const rebuilt = unwrap(
    schema.commit({ head: 'main', message: 'rebuild slot' }, (tx) => {
      tx.delete(box.$.slot)
      tx.set(box.$.slot, { hp: 7, tags: { x: 'z' } })
      tx.setWithMeta(box.$.slot.$.tags.at('x'), 'z', { source: 'rebuild' })
      tx.set(box.$.slot.$.tags.at('added'), 'v')
      tx.setWithMeta(box.$.slot.$.hp, 7, { unit: 'hp' })
      tx.delete(box.$.items.at('one'))
      tx.set(box.$.items.at('two'), { count: 5 })
      tx.set(box.$.items.at('three'), { note: 'new' })
    }),
  )
  expect(unwrap(schema.get(rebuilt.id, box.$.slot.$.hp))).toEqual(some(7))
  expect(unwrap(schema.get(rebuilt.id, box.$.slot.$.tags.at('keep')))).toEqual(NONE)
  expect(unwrap(schema.listKeys(rebuilt.id, box.$.slot.$.tags))).toEqual(['added', 'x'])
  expect(present(unwrap(schema.getWithMeta(rebuilt.id, box.$.slot.$.hp))).meta).toEqual({
    unit: 'hp',
  })
  expect(present(unwrap(schema.getWithMeta(rebuilt.id, box.$.slot.$.tags.at('x')))).meta).toEqual({
    source: 'rebuild',
  })
  expect(unwrap(schema.listKeys(rebuilt.id, box.$.items))).toEqual(['three', 'two'])
  expect(unwrap(schema.get(rebuilt.id, box.$.items.at('two').$.note))).toEqual(NONE)
  expect(
    present(unwrap(schema.getWithMeta(rebuilt.id, box.$.items.at('two').$.count))).meta,
  ).toEqual({ unit: 'n' })
  expect(unwrap(schema.get(rebuilt.id, box.$.items.at('two').custom('flag', s.str())))).toEqual(
    some('on'),
  )
  expect(unwrap(schema.get(rebuilt.id, box.$.items.at('three').$.count))).toEqual(some(1))
  expect(unwrap(schema.get(rebuilt.id, box.custom('luck', s.num())))).toEqual(some(3))

  const restored = unwrap(
    schema.commit({ head: 'main', message: 'restore slot' }, (tx) => {
      tx.delete(box.$.slot)
      tx.set(box.$.slot, { hp: 7, tags: { x: 'z' } })
      tx.setWithMeta(box.$.slot.$.tags.at('x'), 'z', { source: 'rebuild' })
      tx.set(box.$.slot.$.tags.at('added'), 'v')
      tx.setWithMeta(box.$.slot.$.hp, 7, { unit: 'hp' })
    }),
  )
  expect(restored.diff).toEqual([])
  expect(unwrap(schema.get(restored.id, box.$.slot.$.hp))).toEqual(some(7))
  expect(unwrap(schema.listKeys(restored.id, box.$.slot.$.tags))).toEqual(['added', 'x'])
  expect(present(unwrap(schema.getWithMeta(restored.id, box.$.slot.$.tags.at('x')))).meta).toEqual({
    source: 'rebuild',
  })

  const emptied = unwrap(
    schema.commit({ head: 'main', message: 'defaulted containers' }, (tx) => {
      tx.set(box.$.slot, {})
      tx.set(box.$.config, {})
    }),
  )
  expect(unwrap(schema.get(emptied.id, box.$.slot.$.hp))).toEqual(some(10))
  expect(unwrap(schema.get(emptied.id, box.$.slot.$.tags))).toEqual(NONE)
  expect(unwrap(schema.get(emptied.id, box.$.config.$.hp))).toEqual(some(10))
  expect(unwrap(schema.listKeys(emptied.id, box.$.items))).toEqual(['three', 'two'])

  const removed = unwrap(
    schema.commit({ head: 'main', message: 'remove optional' }, (tx) => {
      tx.set(box.$.slot, NONE)
    }),
  )
  expect(unwrap(schema.get(removed.id, box.$.slot))).toEqual(NONE)
  expect(unwrap(schema.listKeys(removed.id, box.$.items))).toEqual(['three', 'two'])
  expect(unwrap(schema.get(removed.id, box.custom('luck', s.num())))).toEqual(some(3))
})

test('tombstoning one branch preserves sibling custom, metadata and dormant Writer fields', async () => {
  const { ctx, schema, world } = setup()
  const keeper = unwrap(
    schema.define(
      ['keeper'],
      s.struct({
        name: s.str(),
        inner: s.struct({ x: s.num() }),
        tail: s.map(s.str()).optional(),
      }),
    ),
  )
  const plugin = ctx.plugin((scope: Context) => {
    const augmented = unwrap(scope.schema.augment(keeper.$.inner, { note: s.str().optional() }))
    unwrap(
      scope.schema.commit({ head: 'main', message: 'seed' }, (tx) => {
        tx.set(keeper, { name: 'first', inner: { x: 1 }, tail: { left: 'l' } })
        tx.setWithMeta(augmented.$.note, 'dormant', { summary: 'kept' })
      }),
    )
  })
  await plugin
  await plugin.dispose()
  const next = unwrap(
    schema.commit({ head: 'main', message: 'rebuild tail' }, (tx) => {
      tx.delete(keeper.$.tail)
      tx.set(keeper.$.tail, { right: 'r' })
      tx.set(keeper.$.inner.$.x, 2)
    }),
  )
  expect(unwrap(schema.listKeys(next.id, keeper.$.tail))).toEqual(['right'])
  expect(unwrap(schema.get(next.id, keeper.$.inner.$.x))).toEqual(some(2))
  expect(unwrap(world.getValue(next.id, ['keeper', 'inner', 'note', '$val']))).toEqual(
    some('dormant'),
  )
  expect(unwrap(world.getValue(next.id, ['keeper', 'inner', 'note', '$meta', 'summary']))).toEqual(
    some('kept'),
  )
  const inspected = present(unwrap(schema.inspectInstance(next.id, ['keeper', 'inner'])))
  expect(inspected.nodeKind).toBe('struct')
  if (inspected.nodeKind === 'struct') expect(inspected.dormantFieldKeys).toEqual(['note'])
})

/* -------------------------------------------------------------------------- */
/*                     Rejections leave no draft commit state                 */
/* -------------------------------------------------------------------------- */

test('callback, validator and CAS failures leave no draft commits and later writes start from the real parent', () => {
  const { schema, world } = setup()
  const hp = unwrap(schema.define(['hp'], s.num().default(10)))
  const first = unwrap(schema.commit({ head: 'main', message: 'seed' }))
  const remove = schema.addCommitValidator(({ draft }) => {
    const current = present(unwrap(draft.get(hp)))
    return current < 0
      ? err({ path: hp.path, validatorName: 'positive', reason: 'negative hp' })
      : ok(undefined)
  })

  expect(
    schema.commit({ head: 'main', message: 'callback veto' }, (tx) => {
      tx.set(hp, 3)
      return err<SchemaError>({
        kind: 'validation_failed',
        path: hp.path,
        reason: 'type_mismatch',
        detail: 'callback vetoed',
      })
    }),
  ).toMatchObject({ ok: false, error: { kind: 'validation_failed' } })
  expect(world.getHead('main')).toEqual(some(first.id))
  expect(unwrap(world.getChildren(first.id))).toEqual([])
  expect(unwrap(schema.get(first.id, hp))).toEqual(some(10))

  expect(schema.commit({ head: 'main', message: 'invalid' }, (tx) => tx.set(hp, -2))).toMatchObject(
    { ok: false, error: { kind: 'validator_rejected' } },
  )
  expect(world.getHead('main')).toEqual(some(first.id))
  expect(unwrap(world.getChildren(first.id))).toEqual([])
  expect(unwrap(schema.get(first.id, hp))).toEqual(some(10))

  const other = unwrap(
    world.commit({ parentId: some(first.id), message: 'competing', advanceHead: 'other' }),
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
  expect(world.getHead('main')).toEqual(some(other.id))
  expect(unwrap(world.getChildren(other.id))).toEqual([])
  expect(unwrap(world.getChildren(first.id))).toEqual([other.id])
  expect(unwrap(schema.get(other.id, hp))).toEqual(some(10))

  const next = unwrap(
    schema.commit({ head: 'main', message: 'valid after failures' }, (tx) => tx.set(hp, 6)),
  )
  expect(unwrap(world.getParent(next.id))).toEqual(some(other.id))
  expect(unwrap(schema.get(next.id, hp))).toEqual(some(6))
  remove()
})

/* -------------------------------------------------------------------------- */
/*                    Sync converters read the immutable source              */
/* -------------------------------------------------------------------------- */

test('sync converters observe the immutable source after earlier promotions rewrite siblings, and prune keeps the source intact', async () => {
  const { ctx, schema, world } = setup()
  const oldActors = await register(ctx, s.map(s.struct({ a: s.num(), b: s.num() }).extensible()), [
    'actors',
  ])
  const oldLegacy = await register(ctx, s.map(s.struct({ tag: s.str() })), ['legacy'])
  const source = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      const alice = oldActors.lens.at('alice')
      tx.set(alice, { a: 1, b: 2 })
      tx.defineCustom(alice, 'hp', s.num(), 7, { unit: 'hp' })
      tx.defineCustom(alice, 'armor', s.num(), 9, { summary: 'plate' })
      tx.defineCustom(alice, 'luck', s.num(), 3)
      tx.set(oldLegacy.lens.at('old'), { tag: 'legacy' })
    }),
  )
  await oldActors.dispose()
  await oldLegacy.dispose()
  const newActors = await register(
    ctx,
    s.map(
      s
        .struct({
          a: s.str(),
          b: s.str(),
          hp: s.num().default(0),
          armor: s.num().default(0),
        })
        .extensible(),
    ),
    ['actors'],
  )
  const alice = newActors.lens.at('alice')
  const synced = unwrap(
    schema.syncSchema({
      head: 'main',
      dormantPolicy: 'prune',
      fieldMigrations: {
        [encodePathKey(['actors', '*', 'a'])]: ({ inspectBeforeMigration }) => {
          const b = present(unwrap(inspectBeforeMigration(['actors', 'alice', 'b'])))
          const armor = present(
            unwrap(inspectBeforeMigration(['actors', 'alice', '$custom', 'armor'])),
          )
          expect(b).toMatchObject({ nodeKind: 'leaf', value: 2 })
          expect(armor).toMatchObject({ nodeKind: 'leaf', value: 9 })
          return ok(`b=${b.nodeKind === 'leaf' ? b.value : 'invalid'}`)
        },
        [encodePathKey(['actors', '*', 'b'])]: ({ inspectBeforeMigration }) => {
          // The `a` migration already rewrote `a` in the draft, but `a` must still read as its source value.
          const a = present(unwrap(inspectBeforeMigration(['actors', 'alice', 'a'])))
          const armor = present(
            unwrap(inspectBeforeMigration(['actors', 'alice', '$custom', 'armor'])),
          )
          expect(a).toMatchObject({ nodeKind: 'leaf', value: 1 })
          expect(armor).toMatchObject({ nodeKind: 'leaf', value: 9 })
          return ok(`a=${a.nodeKind === 'leaf' ? a.value : 'invalid'}`)
        },
        [encodePathKey(['actors', '*', 'hp'])]: ({ inspectBeforeMigration }) => {
          // The `armor` promotion already moved the custom `armor` leaf and deleted it from the draft.
          const armor = present(
            unwrap(inspectBeforeMigration(['actors', 'alice', '$custom', 'armor'])),
          )
          expect(armor).toMatchObject({
            nodeKind: 'leaf',
            value: 9,
            meta: { summary: 'plate' },
          })
          return ok(70)
        },
      },
    }),
  )
  expect(unwrap(world.getParent(synced.id))).toEqual(some(source.id))
  expect(unwrap(world.getChildren(source.id))).toEqual([synced.id])
  expect(unwrap(schema.get(synced.id, alice.$.a))).toEqual(some('b=2'))
  expect(unwrap(schema.get(synced.id, alice.$.b))).toEqual(some('a=1'))
  expect(unwrap(schema.get(synced.id, alice.$.hp))).toEqual(some(70))
  expect(present(unwrap(schema.getWithMeta(synced.id, alice.$.hp))).meta).toEqual({ unit: 'hp' })
  expect(unwrap(schema.get(synced.id, alice.$.armor))).toEqual(some(9))
  expect(present(unwrap(schema.getWithMeta(synced.id, alice.$.armor))).meta).toEqual({
    summary: 'plate',
  })
  expect(unwrap(schema.get(synced.id, alice.custom('luck', s.num())))).toEqual(some(3))
  expect(unwrap(world.getNode(synced.id, ['actors', 'alice', '$custom', 'armor']))).toEqual(NONE)
  expect(unwrap(world.getNode(synced.id, ['legacy']))).toEqual(NONE)
  expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)

  // The migration source commit is untouched by promotion, pruning and converters.
  expect(unwrap(world.getValue(source.id, ['actors', 'alice', 'a', '$val']))).toEqual(some(1))
  expect(unwrap(world.getValue(source.id, ['actors', 'alice', '$custom', 'hp', '$val']))).toEqual(
    some(7),
  )
  expect(
    unwrap(world.getValue(source.id, ['actors', 'alice', '$custom', 'armor', '$val'])),
  ).toEqual(some(9))
  expect(unwrap(world.getValue(source.id, ['legacy', 'old', 'tag', '$val']))).toEqual(
    some('legacy'),
  )
})

/* -------------------------------------------------------------------------- */
/*                        Corrupt raw parents and repair                      */
/* -------------------------------------------------------------------------- */

test('a corrupted raw parent is repaired by the commit callback instead of being pre-rejected', () => {
  const { schema, world } = setup()
  const actors = unwrap(
    schema.define(['actors'], s.struct({ name: s.str(), hp: s.num(), note: s.str().optional() })),
  )
  const first = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(actors, { name: 'Alice', hp: 10 })
    }),
  )
  const corrupt = unwrap(
    world.commit({
      parentId: some(first.id),
      message: 'corrupt',
      advanceHead: { name: 'main', expected: some(first.id) },
      diff: [{ op: 'set', path: ['actors', 'hp', '$val'], value: 'not-a-number' }],
    }),
  )
  expect(schema.get(corrupt.id, actors.$.hp)).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['actors', 'hp'] },
  })

  const repaired = unwrap(
    schema.commit({ head: 'main', message: 'repair' }, (tx) => tx.set(actors.$.hp, 25)),
  )
  expect(unwrap(world.getParent(repaired.id))).toEqual(some(corrupt.id))
  expect(unwrap(schema.get(repaired.id, actors.$.hp))).toEqual(some(25))
  expect(unwrap(schema.get(repaired.id, actors.$.name))).toEqual(some('Alice'))
  expect(unwrap(schema.get(repaired.id, actors.$.note))).toEqual(NONE)
  // The invalid parent itself remains immutable and invalid.
  expect(unwrap(world.getValue(corrupt.id, ['actors', 'hp', '$val']))).toEqual(some('not-a-number'))

  const badName = unwrap(
    world.commit({
      parentId: some(repaired.id),
      message: 'bad-name',
      diff: [{ op: 'set', path: ['actors', 'name', '$val'], value: 42 }],
    }),
  )
  expect(
    schema.commit({ parentId: some(badName.id), message: 'skip the damage' }, (tx) =>
      tx.set(actors.$.hp, 26),
    ),
  ).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['actors', 'name'] },
  })
  expect(unwrap(world.getChildren(badName.id))).toEqual([])
  expect(world.getHead('main')).toEqual(some(repaired.id))

  const healthy = unwrap(
    schema.commit({ head: 'main', message: 'after repair' }, (tx) => tx.set(actors.$.hp, 27)),
  )
  expect(unwrap(world.getParent(healthy.id))).toEqual(some(repaired.id))
  expect(unwrap(schema.get(healthy.id, actors.$.hp))).toEqual(some(27))
})

/* -------------------------------------------------------------------------- */
/*                        Real SQLite payload read scope                      */
/* -------------------------------------------------------------------------- */

test('commit reads only the Writer catalog before mutate, validates every registered root and skips unregistered payloads', () => {
  const source = setup()
  const seedActors = unwrap(
    source.schema.define(['actors'], s.struct({ name: s.str(), hp: s.num() })),
  )
  const seedStats = unwrap(source.schema.define(['stats'], s.struct({ score: s.num() })))
  // No head: the parent chain is addressed explicitly so head hot-index rebuilds
  // cannot legitimately touch the unregistered archive subtree.
  const seed = unwrap(
    source.schema.commit({ message: 'seed' }, (tx) => {
      tx.set(seedActors, { name: 'Alice', hp: 10 })
      tx.set(seedStats, { score: 1 })
    }),
  )
  const big = new Uint8Array(64 * 1024).fill(7)
  const tip = unwrap(
    source.world.commit({
      parentId: some(seed.id),
      message: 'archive',
      diff: [{ op: 'set', path: ['archive', 'big'], value: big }],
    }),
  )

  const observation = observe(source.driver)
  const actors = unwrap(
    observation.schema.define(['actors'], s.struct({ name: s.str(), hp: s.num() })),
  )
  unwrap(observation.schema.define(['stats'], s.struct({ score: s.num() })))

  observation.recorder.record()
  const next = unwrap(
    observation.schema.commit({ parentId: some(tip.id), message: 'update' }, (tx) => {
      // Entering the callback must not have materialized the parent World yet;
      // checkDrift may inspect metadata, but not data payloads.
      expect(bulkPayloadScans(observation.recorder.traces)).toBe(0)
      expect(outsideCatalog(observation.recorder.traces)).toEqual([])
      tx.set(actors.$.hp, 11)
    }),
  )
  observation.recorder.stop()

  const paths = outsideCatalog(observation.recorder.traces)
  expect(bulkPayloadScans(observation.recorder.traces)).toBe(0)
  expect(paths).toContainEqual(['actors', 'hp', '$val'])
  // Full final validation rereads untouched leaves of every registered Writer root.
  expect(paths).toContainEqual(['actors', 'name', '$val'])
  expect(paths).toContainEqual(['stats', 'score', '$val'])
  expect(paths.every((path) => path[0] === 'actors' || path[0] === 'stats')).toBe(true)
  expect(unwrap(observation.world.getParent(next.id))).toEqual(some(tip.id))
  expect(unwrap(observation.world.getValue(next.id, ['actors', 'hp', '$val']))).toEqual(some(11))

  const corrupt = unwrap(
    observation.world.commit({
      parentId: some(next.id),
      message: 'corrupt stats',
      diff: [{ op: 'set', path: ['stats', 'score', '$val'], value: 'bad' }],
    }),
  )
  observation.recorder.record()
  const rejected = observation.schema.commit(
    { parentId: some(corrupt.id), message: 'touch actors' },
    (tx) => {
      expect(outsideCatalog(observation.recorder.traces)).toEqual([])
      tx.set(actors.$.hp, 12)
    },
  )
  observation.recorder.stop()
  expect(rejected).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['stats', 'score'] },
  })
  expect(unwrap(observation.world.getChildren(corrupt.id))).toEqual([])
  expect(unwrap(observation.world.getChildren(next.id))).toEqual([corrupt.id])
  const rejectedPaths = outsideCatalog(observation.recorder.traces)
  expect(rejectedPaths).toContainEqual(['stats', 'score', '$val'])
  expect(rejectedPaths.some((path) => path[0] === 'archive')).toBe(false)
  expect(bulkPayloadScans(observation.recorder.traces)).toBe(0)
})
