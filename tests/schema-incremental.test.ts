import { afterEach, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { err, NONE, ok, some } from '@sekaisen/core'
import type {
  FieldLens,
  LeafSchemaNode,
  LensFor,
  MapLens,
  SchemaError,
} from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { Path, SqliteDriver } from '@sekaisen/plugin-world'
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

/* -------------------------------------------------------------------------- */
/*                    Real World access observation                           */
/* -------------------------------------------------------------------------- */

type ReadMethod = 'getValue' | 'getRef' | 'getNodeInfo' | 'listChildren'
interface WorldRead {
  readonly method: ReadMethod
  readonly path: Path
}

/**
 * Wrap a real WorldService. Every call still reaches the delegate; the wrapper
 * only records the physical coordinates the schema layer asked World for, so
 * an incremental decision can be told apart from a full traversal without
 * inspecting private service state or counting incidental duplicate reads.
 */
function createObserver(world: WorldService) {
  const reads: WorldRead[] = []
  let recording = false
  const capture = <T>(method: ReadMethod, path: Path, read: () => T): T => {
    if (recording) reads.push(Object.freeze({ method, path: Object.freeze([...path]) }))
    return read()
  }
  const getValue = world.getValue.bind(world)
  const getRef = world.getRef.bind(world)
  const getNodeInfo = world.getNodeInfo.bind(world)
  const listChildren = world.listChildren.bind(world)
  world.getValue = (id, path) => capture('getValue', path, () => getValue(id, path))
  world.getRef = (id, path) => capture('getRef', path, () => getRef(id, path))
  world.getNodeInfo = (id, path = []) => capture('getNodeInfo', path, () => getNodeInfo(id, path))
  world.listChildren = (id, path = []) =>
    capture('listChildren', path, () => listChildren(id, path))
  return {
    reads,
    record(): void {
      reads.length = 0
      recording = true
    },
    stop(): void {
      recording = false
    },
  }
}
/** Leaf payload coordinates read outside the Writer catalog. */
function valuePaths(reads: readonly WorldRead[]): readonly Path[] {
  return reads
    .filter((read) => read.method === 'getValue' || read.method === 'getRef')
    .map((read) => read.path)
    .filter((path) => path[0] !== '$schemas')
}

/* -------------------------------------------------------------------------- */
/*                            Fast-path decisions                             */
/* -------------------------------------------------------------------------- */

test('a same-reader validated parent fast-paths a point write without reading unrelated payloads or Map siblings', () => {
  const { world, schema } = setup()
  const actors = unwrap(
    schema.define(
      ['actors'],
      s.map(
        s.struct({
          name: s.str(),
          hp: s.num(),
          payload: s.bytes(),
          config: s.struct({ hp: s.num(), tags: s.map(s.str()) }),
        }),
      ),
    ),
  )
  const stats = unwrap(
    schema.define(['stats'], s.struct({ score: s.num(), series: s.map(s.num()) })),
  )
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(actors.at('alice'), {
        name: 'Alice',
        hp: 10,
        payload: new Uint8Array([1, 2, 3]),
        config: { hp: 5, tags: { role: 'hero' } },
      })
      tx.set(actors.at('bob'), {
        name: 'Bob',
        hp: 20,
        payload: new Uint8Array(2048).fill(7),
        config: { hp: 1, tags: {} },
      })
      tx.set(stats, { score: 1, series: { first: 1 } })
    }),
  )

  const observer = createObserver(world)
  observer.record()
  const next = unwrap(
    schema.commit({ head: 'main', message: 'hp' }, (tx) => tx.set(actors.at('alice').$.hp, 11)),
  )
  observer.stop()

  expect(unwrap(world.getParent(next.id))).toEqual(some(seed.id))
  expect(unwrap(schema.get(next.id, actors.at('alice').$.hp))).toEqual(some(11))

  const values = valuePaths(observer.reads)
  expect(values).toContainEqual(['actors', 'alice', 'hp', '$val'])
  // Different registered root: an incremental commit does not traverse it.
  expect(values.some((path) => path[0] === 'stats')).toBe(false)
  // Same-entry siblings, including a large payload, are not reloaded.
  expect(values).not.toContainEqual(['actors', 'alice', 'name', '$val'])
  expect(values).not.toContainEqual(['actors', 'alice', 'payload', '$val'])
  expect(values.some((path) => path[0] === 'actors' && path[1] === 'bob')).toBe(false)
  // Required presence is checked through the changed chain, not by listing the Map.
  expect(
    observer.reads.some(
      (read) =>
        read.method === 'listChildren' && read.path.length === 1 && read.path[0] === 'actors',
    ),
  ).toBe(false)

  // The skipped coordinates genuinely exist; they were simply not validated again.
  expect(unwrap(world.getValue(next.id, ['actors', 'bob', 'payload', '$val']))).toEqual(
    some(new Uint8Array(2048).fill(7)),
  )
  expect(unwrap(world.getValue(next.id, ['stats', 'series', 'first', '$val']))).toEqual(some(1))
})

test('raw World children are never trusted: full validation repairs their damage or rejects untouched corruption', () => {
  const { world, schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.struct({ name: s.str(), hp: s.num() })))
  const stats = unwrap(schema.define(['stats'], s.struct({ score: s.num() })))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(actors, { name: 'Alice', hp: 10 })
      tx.set(stats, { score: 1 })
    }),
  )

  // Same `$schemas` revision, but World made this node: it is not certified.
  const archive = unwrap(
    world.commit({
      parentId: some(seed.id),
      message: 'raw archive',
      diff: [{ op: 'set', path: ['archive', 'bulk'], value: new Uint8Array(4096).fill(9) }],
    }),
  )
  const observer = createObserver(world)
  observer.record()
  const afterRaw = unwrap(
    schema.commit({ parentId: some(archive.id), message: 'touch hp' }, (tx) =>
      tx.set(actors.$.hp, 2),
    ),
  )
  observer.stop()
  expect(unwrap(world.getParent(afterRaw.id))).toEqual(some(archive.id))
  const fullValues = valuePaths(observer.reads)
  expect(fullValues).toContainEqual(['actors', 'name', '$val'])
  expect(fullValues).toContainEqual(['stats', 'score', '$val'])
  expect(fullValues.some((path) => path[0] === 'archive')).toBe(false)

  // A raw parent with a wrong value may be repaired by the callback, because
  // structural validation runs on the final draft instead of pre-checking it.
  const corruptedHp = unwrap(
    world.commit({
      parentId: some(seed.id),
      message: 'raw wrong hp',
      diff: [{ op: 'set', path: ['actors', 'hp', '$val'], value: 'not-a-number' }],
    }),
  )
  expect(schema.get(corruptedHp.id, actors.$.hp)).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['actors', 'hp'] },
  })
  const repaired = unwrap(
    schema.commit({ parentId: some(corruptedHp.id), message: 'repair hp' }, (tx) =>
      tx.set(actors.$.hp, 25),
    ),
  )
  expect(unwrap(world.getParent(repaired.id))).toEqual(some(corruptedHp.id))
  expect(unwrap(schema.get(repaired.id, actors.$.hp))).toEqual(some(25))
  // The invalid parent stays immutable and invalid.
  expect(unwrap(world.getValue(corruptedHp.id, ['actors', 'hp', '$val']))).toEqual(
    some('not-a-number'),
  )

  // Corruption in an unrelated registered root cannot hide behind a fast path.
  const corruptedStats = unwrap(
    world.commit({
      parentId: some(repaired.id),
      message: 'raw wrong stats',
      diff: [{ op: 'set', path: ['stats', 'score', '$val'], value: 'bad' }],
    }),
  )
  const rejected = schema.commit(
    { parentId: some(corruptedStats.id), message: 'touch actors' },
    (tx) => tx.set(actors.$.hp, 26),
  )
  expect(rejected).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['stats', 'score'] },
  })
  expect(world.getHead('main')).toEqual(some(seed.id))
  expect(unwrap(world.getChildren(corruptedStats.id))).toEqual([])

  // Repairing both damaged roots in the callback is enough for the final validation.
  const repairedAll = unwrap(
    schema.commit({ parentId: some(corruptedStats.id), message: 'repair both' }, (tx) => {
      tx.set(actors.$.hp, 26)
      tx.set(stats.$.score, 2)
    }),
  )
  expect(unwrap(schema.get(repairedAll.id, actors.$.hp))).toEqual(some(26))
  expect(unwrap(schema.get(repairedAll.id, stats.$.score))).toEqual(some(2))
})

test('adding a Reader root invalidates eligibility, sync backfills it, and disposal forces one full commit', async () => {
  const { ctx, world, schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.struct({ hp: s.num() })))
  const stats = unwrap(schema.define(['stats'], s.struct({ score: s.num() })))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(actors, { hp: 1 })
      tx.set(stats, { score: 1 })
    }),
  )

  let extra!: MapLens
  const fiber = ctx.plugin((scope: Context) => {
    extra = unwrap(scope.schema.define(['extra'], s.map(s.num())))
  })
  await fiber

  const blocked = schema.commit({ head: 'main', message: 'blocked' }, (tx) =>
    tx.set(actors.$.hp, 2),
  )
  expect(blocked).toMatchObject({ ok: false, error: { kind: 'schema_drift_requires_sync' } })
  expect(world.getHead('main')).toEqual(some(seed.id))
  expect(unwrap(world.getChildren(seed.id))).toEqual([])

  const synced = unwrap(schema.syncSchema({ head: 'main' }))
  expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
  // Defaulted Map roots are materialized by the full sync.
  expect(unwrap(schema.get(synced.id, extra))).toEqual(some({}))

  // The successful sync becomes a trusted parent for the current Reader.
  const observer = createObserver(world)
  observer.record()
  const fast = unwrap(
    schema.commit({ head: 'main', message: 'fast again' }, (tx) => tx.set(actors.$.hp, 3)),
  )
  observer.stop()
  expect(valuePaths(observer.reads).some((path) => path[0] === 'stats')).toBe(false)
  expect(unwrap(world.getParent(fast.id))).toEqual(some(synced.id))

  // Removing the root is dormant-only drift: allowed, but the reader revision
  // changed, so this commit must still validate the full final state.
  await fiber.dispose()
  expect(unwrap(schema.checkDrift(fast.id)).isClean).toBe(true)
  observer.record()
  const afterDispose = unwrap(
    schema.commit({ head: 'main', message: 'after dispose' }, (tx) => tx.set(actors.$.hp, 4)),
  )
  observer.stop()
  expect(valuePaths(observer.reads)).toContainEqual(['stats', 'score', '$val'])
  // Historical Writer data for the dormant root is retained.
  expect(present(unwrap(schema.inspectInstance(afterDispose.id, ['extra'])))).toMatchObject({
    nodeKind: 'map',
  })
})

test('augment and message registrations invalidate eligibility until sync, and disposal forces one full commit', async () => {
  const { ctx, world, schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.struct({ name: s.str(), hp: s.num() })))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) =>
      tx.set(actors, { name: 'Alice', hp: 1 }),
    ),
  )

  let armor!: FieldLens<LeafSchemaNode<'num'>>
  const augmentFiber = ctx.plugin((scope: Context) => {
    armor = unwrap(scope.schema.augment(actors, { armor: s.num().default(2) })).$.armor
  })
  await augmentFiber

  expect(
    schema.commit({ head: 'main', message: 'blocked augment' }, (tx) => tx.set(actors.$.hp, 2)),
  ).toMatchObject({ ok: false, error: { kind: 'schema_drift_requires_sync' } })
  expect(world.getHead('main')).toEqual(some(seed.id))

  const augmented = unwrap(schema.syncSchema({ head: 'main' }))
  expect(unwrap(schema.get(augmented.id, armor))).toEqual(some(2))
  expect(unwrap(schema.checkDrift(augmented.id)).isClean).toBe(true)

  const observer = createObserver(world)
  observer.record()
  const fast = unwrap(
    schema.commit({ head: 'main', message: 'fast after augment' }, (tx) => tx.set(actors.$.hp, 3)),
  )
  observer.stop()
  expect(valuePaths(observer.reads)).not.toContainEqual(['actors', 'name', '$val'])
  expect(unwrap(world.getParent(fast.id))).toEqual(some(augmented.id))

  const messageFiber = ctx.plugin((scope: Context) => {
    unwrap(scope.schema.defineMessage('event', s.struct({ value: s.num() })))
  })
  await messageFiber

  expect(
    schema.commit({ head: 'main', message: 'blocked message' }, (tx) => tx.set(actors.$.hp, 4)),
  ).toMatchObject({ ok: false, error: { kind: 'schema_drift_requires_sync' } })
  const withMessage = unwrap(schema.syncSchema({ head: 'main' }))
  expect(unwrap(schema.checkDrift(withMessage.id)).isClean).toBe(true)

  // A successful sync of the same Reader is eligible again.
  const fastWithMessage = unwrap(
    schema.commit({ head: 'main', message: 'fast after message' }, (tx) => tx.set(actors.$.hp, 5)),
  )
  expect(unwrap(world.getParent(fastWithMessage.id))).toEqual(some(withMessage.id))

  // Message removal is dormant-only drift, but still forces a full commit.
  await messageFiber.dispose()
  expect(unwrap(schema.checkDrift(fastWithMessage.id)).isClean).toBe(true)
  observer.record()
  const afterMessage = unwrap(
    schema.commit({ head: 'main', message: 'after message' }, (tx) => tx.set(actors.$.hp, 6)),
  )
  observer.stop()
  expect(valuePaths(observer.reads)).toContainEqual(['actors', 'name', '$val'])

  // Augment removal is also dormant-only; data and its spec remain readable.
  await augmentFiber.dispose()
  expect(unwrap(schema.checkDrift(afterMessage.id)).isClean).toBe(true)
  observer.record()
  const afterAugment = unwrap(
    schema.commit({ head: 'main', message: 'after augment' }, (tx) => tx.set(actors.$.hp, 7)),
  )
  observer.stop()
  expect(valuePaths(observer.reads)).toContainEqual(['actors', 'name', '$val'])
  expect(unwrap(world.getValue(afterAugment.id, ['actors', 'armor', '$val']))).toEqual(some(2))
  const inspection = present(unwrap(schema.inspectInstance(afterAugment.id, ['actors'])))
  expect(inspection).toMatchObject({ nodeKind: 'struct', dormantFieldKeys: ['armor'] })
})

/* -------------------------------------------------------------------------- */
/*                     Captured Reader revision semantics                     */
/* -------------------------------------------------------------------------- */

test('a definition registered inside the commit callback cannot bless the produced commit for the new Reader', () => {
  const { world, schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.struct({ hp: s.num() })))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => tx.set(actors, { hp: 1 })),
  )
  let armor!: FieldLens<LeafSchemaNode<'num'>>
  const defined = unwrap(
    schema.commit({ head: 'main', message: 'define during mutate' }, (tx) => {
      armor = unwrap(schema.augment(actors, { armor: s.num().default(0) })).$.armor
      tx.set(actors.$.hp, 2)
    }),
  )
  expect(unwrap(world.getParent(defined.id))).toEqual(some(seed.id))
  expect(unwrap(schema.get(defined.id, actors.$.hp))).toEqual(some(2))

  // The produced commit was validated against the Reader captured at operation
  // start. The next operation sees the new definition and must detect drift.
  const blocked = schema.commit({ head: 'main', message: 'next' }, (tx) => tx.set(actors.$.hp, 3))
  expect(blocked).toMatchObject({ ok: false, error: { kind: 'schema_drift_requires_sync' } })
  expect(world.getHead('main')).toEqual(some(defined.id))
  expect(unwrap(world.getChildren(defined.id))).toEqual([])

  const synced = unwrap(schema.syncSchema({ head: 'main' }))
  expect(unwrap(schema.get(synced.id, armor))).toEqual(some(0))
  expect(unwrap(schema.checkDrift(synced.id)).isClean).toBe(true)
})

test('a definition registered inside a validator cannot bless the produced commit for the new Reader', () => {
  const { world, schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.struct({ hp: s.num() })))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => tx.set(actors, { hp: 1 })),
  )
  let armor!: FieldLens<LeafSchemaNode<'num'>>
  let armed = true
  const remove = schema.addCommitValidator(() => {
    if (armed) {
      armed = false
      armor = unwrap(schema.augment(actors, { armor: s.num().default(5) })).$.armor
    }
    return ok(undefined)
  })
  const first = unwrap(
    schema.commit({ head: 'main', message: 'define during validator' }, (tx) =>
      tx.set(actors.$.hp, 2),
    ),
  )
  expect(unwrap(world.getParent(first.id))).toEqual(some(seed.id))
  remove()

  const blocked = schema.commit({ head: 'main', message: 'next' }, (tx) => tx.set(actors.$.hp, 3))
  expect(blocked).toMatchObject({ ok: false, error: { kind: 'schema_drift_requires_sync' } })
  const synced = unwrap(schema.syncSchema({ head: 'main' }))
  expect(unwrap(schema.get(synced.id, armor))).toEqual(some(5))
  expect(unwrap(schema.get(first.id, actors.$.hp))).toEqual(some(2))
})

/* -------------------------------------------------------------------------- */
/*                        Validators and atomic failures                      */
/* -------------------------------------------------------------------------- */

test('business validators inspect unchanged roots on fast commits and even on an empty diff', () => {
  const { world, schema } = setup()
  const actors = unwrap(schema.define(['actors'], s.struct({ hp: s.num() })))
  const stats = unwrap(schema.define(['stats'], s.struct({ score: s.num() })))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(actors, { hp: 10 })
      tx.set(stats, { score: 3 })
    }),
  )

  const seen: number[] = []
  let rejectAll = false
  const remove = schema.addCommitValidator(({ draft }) => {
    const hp = present(unwrap(draft.get(actors.$.hp)))
    const score = present(unwrap(draft.get(stats.$.score)))
    seen.push(hp)
    if (score !== 3)
      return err({ path: stats.$.score.path, validatorName: 'audit', reason: 'score changed' })
    if (rejectAll)
      return err({ path: actors.$.hp.path, validatorName: 'rejector', reason: 'rejected' })
    return hp < 0
      ? err({ path: actors.$.hp.path, validatorName: 'nonNegative', reason: 'negative hp' })
      : ok(undefined)
  })

  const first = unwrap(
    schema.commit({ head: 'main', message: 'fast valid' }, (tx) => tx.set(actors.$.hp, 5)),
  )
  expect(first.diff).toContainEqual(
    expect.objectContaining({ op: 'set', path: ['actors', 'hp', '$val'], value: 5 }),
  )
  expect(seen).toContain(5)
  expect(unwrap(world.getChildren(seed.id))).toEqual([first.id])

  const rejectedValue = schema.commit({ head: 'main', message: 'invalid value' }, (tx) =>
    tx.set(actors.$.hp, -1),
  )
  expect(rejectedValue).toMatchObject({ ok: false, error: { kind: 'validator_rejected' } })
  expect(world.getHead('main')).toEqual(some(first.id))
  expect(unwrap(world.getChildren(first.id))).toEqual([])

  rejectAll = true
  const rejectedNoop = schema.commit({ head: 'main', message: 'no-op rejected' }, (tx) =>
    tx.set(actors.$.hp, 5),
  )
  expect(rejectedNoop).toMatchObject({ ok: false, error: { kind: 'validator_rejected' } })
  expect(world.getHead('main')).toEqual(some(first.id))
  expect(unwrap(world.getChildren(first.id))).toEqual([])
  // Both rejections were still observed after the unchanged stats root.
  expect(seen.length).toBeGreaterThan(1)

  rejectAll = false
  const noop = unwrap(
    schema.commit({ head: 'main', message: 'no-op accepted' }, (tx) => tx.set(actors.$.hp, 5)),
  )
  expect(noop.diff).toEqual([])
  expect(unwrap(world.getParent(noop.id))).toEqual(some(first.id))
  expect(unwrap(schema.get(noop.id, actors.$.hp))).toEqual(some(5))
  remove()
})

test('callback veto and head CAS failures leave no commit, head change or recorded trust', () => {
  const { world, schema } = setup()
  const hp = unwrap(schema.define(['hp'], s.num().default(10)))
  const first = unwrap(schema.commit({ head: 'main', message: 'seed' }))
  const vetoed = schema.commit({ head: 'main', message: 'veto' }, (tx) => {
    tx.set(hp, 3)
    return err<SchemaError>({
      kind: 'validation_failed',
      path: hp.path,
      reason: 'type_mismatch',
      detail: 'callback veto',
    })
  })
  expect(vetoed).toMatchObject({ ok: false, error: { kind: 'validation_failed' } })
  expect(world.getHead('main')).toEqual(some(first.id))
  expect(unwrap(world.getChildren(first.id))).toEqual([])
  expect(unwrap(schema.get(first.id, hp))).toEqual(some(10))

  const competing = unwrap(world.commit({ parentId: some(first.id), message: 'competing' }))
  const lostCas = schema.commit({ head: 'main', message: 'lost update' }, (tx) => {
    tx.set(hp, 4)
    unwrap(world.setHead('main', competing.id))
  })
  expect(lostCas).toMatchObject({
    ok: false,
    error: { kind: 'world_error', error: { kind: 'head_cas_mismatch' } },
  })
  expect(world.getHead('main')).toEqual(some(competing.id))
  expect(unwrap(world.getChildren(competing.id))).toEqual([])
  expect(unwrap(world.getChildren(first.id))).toEqual([competing.id])

  const recovered = unwrap(
    schema.commit({ head: 'main', message: 'recovered' }, (tx) => tx.set(hp, 5)),
  )
  expect(unwrap(world.getParent(recovered.id))).toEqual(some(competing.id))
  expect(unwrap(schema.get(recovered.id, hp))).toEqual(some(5))
})

/* -------------------------------------------------------------------------- */
/*                    Incremental optional/custom/meta shapes                 */
/* -------------------------------------------------------------------------- */

test('fast commits delete and rebuild optional nodes and Map members while preserving custom data and metadata', () => {
  const { world, schema } = setup()
  const box = unwrap(
    schema.define(
      ['box'],
      s
        .struct({
          name: s.str(),
          slot: s.struct({ hp: s.num(), tags: s.map(s.str()).optional() }).optional(),
        })
        .extensible(),
    ),
  )
  const party = unwrap(schema.define(['party'], s.map(s.struct({ name: s.str(), hp: s.num() }))))
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) => {
      tx.set(box, { name: 'box' })
      tx.set(box.$.slot, { hp: 5, tags: { keep: 'yes' } })
      tx.setWithMeta(box.$.slot.$.hp, 5, { unit: 'hp' })
      tx.defineCustom(box, 'luck', s.num(), 4, { summary: 'lucky' })
      tx.set(party.at('a'), { name: 'A', hp: 1 })
      tx.set(party.at('b'), { name: 'B', hp: 2 })
    }),
  )
  expect(unwrap(world.getParent(seed.id)).kind).toBe('none')

  const removed = unwrap(
    schema.commit({ head: 'main', message: 'remove optional' }, (tx) => tx.set(box.$.slot, NONE)),
  )
  expect(unwrap(world.getParent(removed.id))).toEqual(some(seed.id))
  expect(unwrap(schema.get(removed.id, box.$.slot))).toEqual(NONE)
  expect(unwrap(schema.get(removed.id, box.custom('luck', s.num())))).toEqual(some(4))

  const rebuilt = unwrap(
    schema.commit({ head: 'main', message: 'rebuild optional' }, (tx) => {
      tx.set(box.$.slot, { hp: 6, tags: { x: 'y' } })
      tx.setWithMeta(box.$.slot.$.hp, 6, { unit: 'hp2' })
    }),
  )
  expect(unwrap(schema.get(rebuilt.id, box.$.slot.$.hp))).toEqual(some(6))
  expect(present(unwrap(schema.getWithMeta(rebuilt.id, box.$.slot.$.hp))).meta).toEqual({
    unit: 'hp2',
  })
  expect(unwrap(schema.listKeys(rebuilt.id, box.$.slot.$.tags))).toEqual(['x'])
  expect(unwrap(schema.get(rebuilt.id, box.custom('luck', s.num())))).toEqual(some(4))

  // Rewriting exactly the same physical tree is a no-op, not a validated rewrite.
  const noop = unwrap(
    schema.commit({ head: 'main', message: 'same tree' }, (tx) => {
      tx.set(box.$.slot, { hp: 6, tags: { x: 'y' } })
      tx.setWithMeta(box.$.slot.$.hp, 6, { unit: 'hp2' })
    }),
  )
  expect(noop.diff).toEqual([])
  expect(unwrap(schema.get(noop.id, box.$.slot.$.hp))).toEqual(some(6))

  // Custom edits conservatively widen to the containing struct. Only the
  // consumer-visible value, spec and metadata matter here.
  const luck = box.custom('luck', s.num())
  const custom = unwrap(
    schema.commit({ head: 'main', message: 'custom edit' }, (tx) => {
      tx.defineCustom(box, 'luck', s.num(), 7, { summary: 'lucky2' })
    }),
  )
  expect(unwrap(schema.get(custom.id, luck))).toEqual(some(7))
  expect(present(unwrap(schema.getWithMeta(custom.id, luck))).meta).toEqual({
    summary: 'lucky2',
  })

  // Metadata-only changes inspect the owning leaf, not the whole root.
  const meta = unwrap(
    schema.commit({ head: 'main', message: 'meta only' }, (tx) =>
      tx.setWithMeta(box.$.name, 'box', { mark: 'm' }),
    ),
  )
  expect(unwrap(schema.get(meta.id, box.$.name))).toEqual(some('box'))
  expect(present(unwrap(schema.getWithMeta(meta.id, box.$.name))).meta).toEqual({ mark: 'm' })

  // Deleting a Map member is valid even though the value schema is required,
  // and the surviving member is not enumerated for existence.
  const observer = createObserver(world)
  observer.record()
  const deleted = unwrap(
    schema.commit({ head: 'main', message: 'delete member' }, (tx) => tx.delete(party.at('b'))),
  )
  observer.stop()
  expect(unwrap(world.getNode(deleted.id, ['party', 'b']))).toEqual(NONE)
  expect(unwrap(schema.listKeys(deleted.id, party))).toEqual(['a'])
  expect(unwrap(schema.get(deleted.id, party.at('a').$.hp))).toEqual(some(1))
  expect(valuePaths(observer.reads).some((path) => path[0] === 'party' && path[1] === 'a')).toBe(
    false,
  )
})

test('a narrower Reader still preserves dormant Writer values across fast commits', async () => {
  const { ctx, world, schema } = setup()
  const wideNode = s.struct({ name: s.str(), hp: s.num(), secret: s.str() })
  let wide!: LensFor<typeof wideNode>
  const wideFiber = ctx.plugin((scope: Context) => {
    wide = unwrap(scope.schema.define(['actors'], wideNode))
  })
  await wideFiber
  const seed = unwrap(
    schema.commit({ head: 'main', message: 'seed' }, (tx) =>
      tx.set(wide, { name: 'Alice', hp: 1, secret: 'shh' }),
    ),
  )
  await wideFiber.dispose()

  const actors = unwrap(schema.define(['actors'], s.struct({ name: s.str(), hp: s.num() })))
  // Dormant-only drift is allowed, but this first commit is a full traversal.
  const first = unwrap(
    schema.commit({ head: 'main', message: 'narrow' }, (tx) => tx.set(actors.$.hp, 2)),
  )
  expect(unwrap(world.getParent(first.id))).toEqual(some(seed.id))

  const observer = createObserver(world)
  observer.record()
  const fast = unwrap(
    schema.commit({ head: 'main', message: 'fast narrow' }, (tx) => tx.set(actors.$.hp, 3)),
  )
  observer.stop()
  expect(valuePaths(observer.reads)).not.toContainEqual(['actors', 'secret', '$val'])
  expect(unwrap(world.getValue(fast.id, ['actors', 'secret', '$val']))).toEqual(some('shh'))
  const inspection = present(unwrap(schema.inspectInstance(fast.id, ['actors'])))
  expect(inspection).toMatchObject({ nodeKind: 'struct', dormantFieldKeys: ['secret'] })
})
