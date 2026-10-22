import { afterEach, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { LensFor, MessagePrism, SchemaNode } from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { comparePaths, decodePathKey, WorldService } from '@sekaisen/plugin-world'
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
  return { lens, dispose: () => fiber.dispose() }
}

/* -------------------------------------------------------------------------- */
/*                        SQLite read-scope instrumentation                    */
/* -------------------------------------------------------------------------- */

interface Trace {
  readonly sql: string
  readonly params: readonly unknown[]
}
interface Recorder {
  readonly driver: SqliteDriver
  /** Statements that touched `diff_entries` or the commit message row. */
  readonly reads: readonly Trace[]
  /** Clear the trace and begin recording read statements. */
  record(): void
  stop(): void
}

const READ_SQL = /FROM\s+(?:diff_entries|commits)\b/i
const POINT_DIFF = /\bFROM\s+diff_entries\s+WHERE\s+commit_id\s*=\s*\?\s+AND\s+path_key\s*=/i
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * Wrap the real driver: statements still execute against SQLite, but every
 * payload read is observed so tests can assert what the schema layer asked for.
 */
function createRecorder(base: SqliteDriver): Recorder {
  const reads: Trace[] = []
  let recording = false
  const capture = (sql: string, params: readonly unknown[]): void => {
    if (recording && READ_SQL.test(sql)) reads.push({ sql, params })
  }
  return {
    reads,
    record(): void {
      reads.length = 0
      recording = true
    },
    stop(): void {
      recording = false
    },
    driver: {
      exec: (sql) => base.exec(sql),
      prepare: (sql) => {
        const statement = base.prepare(sql)
        return {
          run: (...params) => statement.run(...params),
          get: <TRow = Record<string, unknown>>(...params: readonly unknown[]) => {
            capture(sql, params)
            return statement.get<TRow>(...params)
          },
          all: <TRow = Record<string, unknown>>(...params: readonly unknown[]) => {
            capture(sql, params)
            return statement.all<TRow>(...params)
          },
        }
      },
      transaction: <T>(fn: () => T): T => base.transaction(fn),
      close: () => base.close(),
    },
  }
}

/** Decode the `path_key` parameter of every point read, rejecting bulk scans. */
function payloadPaths(recorder: Recorder): readonly Path[] {
  const seen = new Set<string>()
  const paths: Path[] = []
  for (const read of recorder.reads) {
    const sql = read.sql.trim()
    if (!/FROM diff_entries\b/.test(sql)) continue
    if (!POINT_DIFF.test(sql)) throw new Error(`Unexpected non-point diff_entries read: ${sql}`)
    const commit = read.params[0]
    const encoded = read.params[1]
    if (typeof commit !== 'string' || !(encoded instanceof Uint8Array))
      throw new Error(`Unexpected diff_entries parameters: ${sql}`)
    const key = utf8.decode(encoded)
    const path = decodePathKey(key)
    if (!seen.has(key)) {
      seen.add(key)
      paths.push(path)
    }
  }
  return paths.sort(comparePaths)
}
/** Payload reads outside the Writer catalog (`$schemas`). */
function outsideCatalog(recorder: Recorder): readonly Path[] {
  return payloadPaths(recorder).filter((path) => path[0] !== '$schemas')
}
function expectCatalogOnly(recorder: Recorder): void {
  const paths = payloadPaths(recorder)
  expect(paths).toContainEqual(['$schemas', '$version'])
  expect(paths.every((path) => path[0] === '$schemas')).toBe(true)
}
function expectReads(recorder: Recorder, expected: readonly Path[]): void {
  expect(outsideCatalog(recorder)).toEqual([...expected].sort(comparePaths))
}

interface Observation {
  readonly ctx: Context
  readonly world: WorldService
  readonly schema: SchemaService
  readonly recorder: Recorder
}
/**
 * A freshly loaded WorldService over the same SQLite driver. Commits have no
 * heads, so observed data starts cold; separate instances prevent an earlier
 * query's cache hits from hiding unrelated payload reads in another scenario.
 */
function observe(driver: SqliteDriver): Observation {
  const recorder = createRecorder(driver)
  const ctx = new Context()
  const world = new WorldService(ctx, { driver: recorder.driver })
  const schema = new SchemaService(ctx)
  return { ctx, world, schema, recorder }
}

/* -------------------------------------------------------------------------- */
/*                                   Fixtures                                 */
/* -------------------------------------------------------------------------- */

function actorModel() {
  return s.map(
    s
      .struct({
        name: s.str(),
        hp: s.num(),
        payload: s.bytes(),
        config: s.struct({ hp: s.num(), tags: s.map(s.str()) }),
      })
      .extensible(),
  )
}
interface Seeded {
  readonly driver: SqliteDriver
  readonly source: { ctx: Context; world: WorldService; schema: SchemaService }
  readonly commitId: CommitHash
}
function seedActors(): Seeded {
  const source = setup()
  const actors = unwrap(source.schema.define(['actors'], actorModel()))
  const alice = actors.at('alice')
  const bob = actors.at('bob')
  const root = unwrap(
    source.schema.commit({ message: 'seed' }, (tx) => {
      tx.set(alice, {
        name: 'Alice',
        hp: 10,
        payload: new Uint8Array([1, 2, 3]),
        config: { hp: 5, tags: { role: 'hero' } },
      })
      tx.set(bob, {
        name: 'Bob',
        hp: 20,
        payload: new Uint8Array(2048).fill(7),
        config: { hp: 1, tags: {} },
      })
      tx.setWithMeta(alice.$.hp, 10, { summary: 'ten', unit: 'hp' })
      tx.setWithMeta(alice.$.config.$.hp, 5, { unit: 'hp' })
    }),
  )
  const archive = unwrap(
    source.world.commit({
      parentId: some(root.id),
      message: 'archive',
      diff: [{ op: 'set', path: ['archive', 'bulk', 'blob'], value: new Uint8Array(4096).fill(9) }],
    }),
  )
  return { driver: source.driver, source, commitId: archive.id }
}

/* -------------------------------------------------------------------------- */
/*                                   Tests                                    */
/* -------------------------------------------------------------------------- */

test('a cold viewAt reads only the Writer catalog; scalar and meta reads stay on the target chain', () => {
  const seeded = seedActors()

  const catalog = observe(seeded.driver)
  unwrap(catalog.schema.define(['actors'], actorModel()))
  catalog.recorder.record()
  unwrap(catalog.schema.viewAt(seeded.commitId))
  expectCatalogOnly(catalog.recorder)
  catalog.recorder.stop()

  const scalar = observe(seeded.driver)
  const scalarActors = unwrap(scalar.schema.define(['actors'], actorModel()))
  const scalarView = unwrap(scalar.schema.viewAt(seeded.commitId))
  scalar.recorder.record()
  expect(unwrap(scalarView.get(scalarActors.at('alice').$.hp))).toEqual(some(10))
  expectReads(scalar.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
    ['actors', 'alice', 'hp', '$val'],
  ])
  scalar.recorder.stop()

  const meta = observe(seeded.driver)
  const metaActors = unwrap(meta.schema.define(['actors'], actorModel()))
  const metaView = unwrap(meta.schema.viewAt(seeded.commitId))
  meta.recorder.record()
  const field = present(unwrap(metaView.getWithMeta(metaActors.at('alice').$.hp)))
  expect(field.value).toBe(10)
  expect(field.meta).toEqual({ summary: 'ten', unit: 'hp' })
  expect(field.spec.valueKind).toBe('num')
  expectReads(meta.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
    ['actors', 'alice', 'hp', '$meta', 'summary'],
    ['actors', 'alice', 'hp', '$meta', 'unit'],
    ['actors', 'alice', 'hp', '$val'],
  ])
  meta.recorder.stop()

  // Unrelated payloads really are persisted, but the reads above never fetched them.
  expect(
    unwrap(seeded.source.world.getValue(seeded.commitId, ['archive', 'bulk', 'blob'])),
  ).toEqual(some(new Uint8Array(4096).fill(9)))
  expect(
    unwrap(seeded.source.world.getValue(seeded.commitId, ['actors', 'bob', 'payload', '$val'])),
  ).toEqual(some(new Uint8Array(2048).fill(7)))
})

test('struct, Map and inspectInstance reads stay inside the requested subtree', () => {
  const seeded = seedActors()

  const struct = observe(seeded.driver)
  const structActors = unwrap(struct.schema.define(['actors'], actorModel()))
  const structView = unwrap(struct.schema.viewAt(seeded.commitId))
  struct.recorder.record()
  const alice = present(unwrap(structView.get(structActors.at('alice'))))
  expect(alice.name).toBe('Alice')
  expect(alice.hp).toBe(10)
  expect(alice.payload).toEqual(new Uint8Array([1, 2, 3]))
  expect(alice.config.tags).toEqual({ role: 'hero' })
  expectReads(struct.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
    ['actors', 'alice', 'config', '$exists'],
    ['actors', 'alice', 'config', 'hp', '$val'],
    ['actors', 'alice', 'config', 'tags', '$exists'],
    ['actors', 'alice', 'config', 'tags', 'role', '$val'],
    ['actors', 'alice', 'hp', '$val'],
    ['actors', 'alice', 'name', '$val'],
    ['actors', 'alice', 'payload', '$val'],
  ])
  struct.recorder.stop()

  const map = observe(seeded.driver)
  const mapActors = unwrap(map.schema.define(['actors'], actorModel()))
  const mapView = unwrap(map.schema.viewAt(seeded.commitId))
  map.recorder.record()
  const all = present(unwrap(mapView.get(mapActors)))
  expect(Object.keys(all)).toEqual(['alice', 'bob'])
  const bob = all.bob
  if (!bob) throw new Error('Expected bob entry')
  expect(bob.payload).toEqual(new Uint8Array(2048).fill(7))
  const mapPaths = outsideCatalog(map.recorder)
  expect(mapPaths.filter((path) => path[0] !== 'actors')).toEqual([])
  expect(mapPaths).toContainEqual(['actors', 'bob', 'payload', '$val'])
  expect(mapPaths).toContainEqual(['actors', 'alice', 'name', '$val'])
  map.recorder.stop()

  const inspect = observe(seeded.driver)
  unwrap(inspect.schema.define(['actors'], actorModel()))
  inspect.recorder.record()
  const inspection = present(
    unwrap(inspect.schema.inspectInstance(seeded.commitId, ['actors', 'alice', 'config'])),
  )
  expect(inspection).toMatchObject({ nodeKind: 'struct', path: ['actors', 'alice', 'config'] })
  if (inspection.nodeKind === 'struct') {
    const hp = inspection.fields.hp
    expect(hp?.kind).toBe('some')
    if (hp && hp.kind === 'some')
      expect(hp.value).toMatchObject({ nodeKind: 'leaf', value: 5, meta: { unit: 'hp' } })
  }
  const inspectPaths = outsideCatalog(inspect.recorder)
  expect(
    inspectPaths.filter(
      (path) => path[0] !== 'actors' || (path[1] !== 'alice' && path[1] !== '$exists'),
    ),
  ).toEqual([])
  expect(inspectPaths).toContainEqual(['actors', 'alice', 'config', '$exists'])
  expect(inspectPaths).toContainEqual(['actors', 'alice', 'config', 'hp', '$val'])
  expect(inspectPaths).toContainEqual(['actors', 'alice', 'config', 'hp', '$meta', 'unit'])
  expect(inspectPaths).toContainEqual(['actors', 'alice', 'config', 'tags', 'role', '$val'])
  expect(inspectPaths).not.toContainEqual(['actors', 'alice', 'payload', '$val'])
  inspect.recorder.stop()

  const bytes = observe(seeded.driver)
  const bytesActors = unwrap(bytes.schema.define(['actors'], actorModel()))
  const bytesView = unwrap(bytes.schema.viewAt(seeded.commitId))
  bytes.recorder.record()
  const payload = present(unwrap(bytesView.get(bytesActors.at('alice').$.payload)))
  expectReads(bytes.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
    ['actors', 'alice', 'payload', '$val'],
  ])
  bytes.recorder.stop()

  payload[0] = 99
  expect(unwrap(bytesView.get(bytesActors.at('alice').$.payload))).toEqual(
    some(new Uint8Array([1, 2, 3])),
  )
  expect(unwrap(bytes.schema.get(seeded.commitId, bytesActors.at('alice').$.payload))).toEqual(
    some(new Uint8Array([1, 2, 3])),
  )
})

test('binary messages read only the message row and Writer catalog after unregistering', async () => {
  const { ctx, world, schema, driver } = setup()
  const payload = s.struct({ title: s.str(), bytes: s.bytes(), flags: s.map(s.bool()) })
  let prism!: MessagePrism<'event', typeof payload>
  const fiber = ctx.plugin((scope: Context) => {
    prism = unwrap(scope.schema.defineMessage('event', payload))
  })
  await fiber
  const message = prism.create({
    title: 'lazy',
    bytes: new Uint8Array([0, 255]),
    flags: { ready: true },
  })
  const base = unwrap(schema.commit({ message: 'base' }))
  const withPayload = unwrap(
    world.commit({
      parentId: some(base.id),
      message: 'payload',
      diff: [{ op: 'set', path: ['blob', 'bulk'], value: new Uint8Array(4096).fill(3) }],
    }),
  )
  const node = unwrap(schema.commit({ parentId: some(withPayload.id), message }))
  await fiber.dispose()

  // No message kind is registered in the reloaded service: decoding must use the Writer catalog.
  const unloaded = observe(driver)
  unloaded.recorder.record()
  expect(unwrap(unloaded.schema.getMessage(node.id))).toEqual(message)
  expectCatalogOnly(unloaded.recorder)
  unloaded.recorder.stop()

  // The binary message and the unrelated payload are genuinely persisted.
  expect(unwrap(world.getMessage(node.id))).toBeInstanceOf(Uint8Array)
  expect(unwrap(world.getValue(node.id, ['blob', 'bulk']))).toEqual(
    some(new Uint8Array(4096).fill(3)),
  )
})

test('absent optional ancestors, absent Map members and Reader defaults avoid payload reads', () => {
  const seeded = seedActors()
  const model = () =>
    s.map(
      s
        .struct({
          name: s.str(),
          hp: s.num(),
          payload: s.bytes(),
          config: s.struct({ hp: s.num(), tags: s.map(s.str()) }),
          extra: s.struct({ deep: s.num() }).optional(),
          level: s.num().default(7),
        })
        .extensible(),
    )

  const optional = observe(seeded.driver)
  const optionalActors = unwrap(optional.schema.define(['actors'], model()))
  const optionalView = unwrap(optional.schema.viewAt(seeded.commitId))
  optional.recorder.record()
  expect(unwrap(optionalView.get(optionalActors.at('alice').$.extra.$.deep))).toEqual(NONE)
  expectReads(optional.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
  ])
  optional.recorder.stop()

  const member = observe(seeded.driver)
  const memberActors = unwrap(member.schema.define(['actors'], model()))
  const memberView = unwrap(member.schema.viewAt(seeded.commitId))
  member.recorder.record()
  expect(unwrap(memberView.get(memberActors.at('ghost')))).toEqual(NONE)
  expectReads(member.recorder, [['actors', '$exists']])
  member.recorder.stop()

  const virtual = observe(seeded.driver)
  const virtualActors = unwrap(virtual.schema.define(['actors'], model()))
  const virtualView = unwrap(virtual.schema.viewAt(seeded.commitId))
  virtual.recorder.record()
  expect(unwrap(virtualView.get(virtualActors.at('alice').$.level))).toEqual(some(7))
  expectReads(virtual.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
  ])
  virtual.recorder.stop()

  const virtualMeta = observe(seeded.driver)
  const virtualMetaActors = unwrap(virtualMeta.schema.define(['actors'], model()))
  const virtualMetaView = unwrap(virtualMeta.schema.viewAt(seeded.commitId))
  virtualMeta.recorder.record()
  expect(
    present(unwrap(virtualMetaView.getWithMeta(virtualMetaActors.at('alice').$.level))).meta,
  ).toEqual({})
  expectReads(virtualMeta.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
  ])
  virtualMeta.recorder.stop()

  // The virtual default was never materialized into the world.
  expect(
    unwrap(seeded.source.world.getNode(seeded.commitId, ['actors', 'alice', 'level'])),
  ).toEqual(NONE)
})

test('lazy presence checks detect missing Writer values and invalid container anchors', () => {
  const seeded = seedActors()
  const missing = unwrap(
    seeded.source.world.commit({
      parentId: some(seeded.commitId),
      message: 'drop hp value',
      diff: [{ op: 'del', path: ['actors', 'alice', 'hp', '$val'] }],
    }),
  )
  const invalidAnchor = unwrap(
    seeded.source.world.commit({
      parentId: some(missing.id),
      message: 'false anchor',
      diff: [{ op: 'set', path: ['actors', 'alice', '$exists'], value: false }],
    }),
  )

  const dropped = observe(seeded.driver)
  const droppedActors = unwrap(dropped.schema.define(['actors'], actorModel()))
  dropped.recorder.record()
  expect(dropped.schema.get(missing.id, droppedActors.at('alice').$.hp)).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['actors', 'alice', 'hp'] },
  })
  expectReads(dropped.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
  ])
  dropped.recorder.stop()

  const anchored = observe(seeded.driver)
  const anchoredActors = unwrap(anchored.schema.define(['actors'], actorModel()))
  anchored.recorder.record()
  expect(anchored.schema.get(invalidAnchor.id, anchoredActors.at('alice'))).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['actors', 'alice'] },
  })
  expectReads(anchored.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
  ])
  anchored.recorder.stop()
})

test('listKeys reads and validates member values instead of only enumerating names', () => {
  const seeded = seedActors()
  const corrupted = unwrap(
    seeded.source.world.commit({
      parentId: some(seeded.commitId),
      message: 'drop member discriminator',
      diff: [{ op: 'del', path: ['actors', 'bob', '$exists'] }],
    }),
  )

  const healthy = observe(seeded.driver)
  const actors = unwrap(healthy.schema.define(['actors'], actorModel()))
  healthy.recorder.record()
  expect(unwrap(healthy.schema.listKeys(seeded.commitId, actors))).toEqual(['alice', 'bob'])
  const paths = outsideCatalog(healthy.recorder)
  expect(paths).toContainEqual(['actors', 'bob', '$exists'])
  expect(paths).toContainEqual(['actors', 'bob', 'name', '$val'])
  expect(paths).toContainEqual(['actors', 'bob', 'payload', '$val'])
  expect(paths.filter((path) => path[0] !== 'actors')).toEqual([])
  healthy.recorder.stop()

  // A shallow physical listing still reports the member; listKeys must not.
  const broken = observe(seeded.driver)
  const brokenActors = unwrap(broken.schema.define(['actors'], actorModel()))
  expect(present(unwrap(broken.world.listChildren(corrupted.id, ['actors'])))).toContain('bob')
  expect(broken.schema.listKeys(corrupted.id, brokenActors)).toMatchObject({
    ok: false,
    error: { kind: 'corrupted_instance_data', path: ['actors', 'bob'] },
  })
})

test('custom leaves read lazily and retained views keep their captured Reader catalog', async () => {
  const { schema, driver } = setup()
  const actors = unwrap(schema.define(['actors'], actorModel()))
  const alice = actors.at('alice')
  const seed = unwrap(
    schema.commit({ message: 'seed' }, (tx) => {
      tx.set(alice, {
        name: 'Alice',
        hp: 10,
        payload: new Uint8Array([1, 2, 3]),
        config: { hp: 5, tags: { role: 'hero' } },
      })
      tx.setWithMeta(alice.$.hp, 10, { summary: 'ten' })
      tx.defineCustom(alice, 'luck', s.num(), 4, { summary: 'lucky' })
    }),
  )

  const custom = observe(driver)
  const customA = await register(custom.ctx, actorModel())
  const customView = unwrap(custom.schema.viewAt(seed.id))
  custom.recorder.record()
  expect(unwrap(customView.get(customA.lens.at('alice').custom('luck', s.num())))).toEqual(some(4))
  expectReads(custom.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'description'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'nodeKind'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'presenceMode'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'valueKind'],
    ['actors', 'alice', '$custom', 'luck', '$val'],
  ])
  custom.recorder.stop()

  const wrong = observe(driver)
  const wrongA = await register(wrong.ctx, actorModel())
  const wrongView = unwrap(wrong.schema.viewAt(seed.id))
  wrong.recorder.record()
  expect(wrongView.get(wrongA.lens.at('alice').custom('luck', s.str()))).toMatchObject({
    ok: false,
    error: { kind: 'schema_type_mismatch', path: ['actors', 'alice', '$custom', 'luck'] },
  })
  expectReads(wrong.recorder, [
    ['actors', '$exists'],
    ['actors', 'alice', '$exists'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'description'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'nodeKind'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'presenceMode'],
    ['actors', 'alice', '$custom', 'luck', '$spec', 'valueKind'],
  ])
  wrong.recorder.stop()

  const retained = observe(driver)
  const readerA = await register(retained.ctx, actorModel())
  const captured = unwrap(retained.schema.viewAt(seed.id))
  const later = unwrap(
    retained.schema.commit({ parentId: some(seed.id), message: 'later' }, (tx) => {
      tx.set(readerA.lens.at('alice').$.hp, 99)
    }),
  )
  // The captured view keeps its commit even after the world advances.
  expect(unwrap(retained.schema.get(later.id, readerA.lens.at('alice').$.hp))).toEqual(some(99))
  expect(unwrap(captured.get(readerA.lens.at('alice').$.hp))).toEqual(some(10))
  await readerA.dispose()
  const readerB = await register(
    retained.ctx,
    s.map(
      s
        .struct({
          name: s.str(),
          hp: s.num(),
          payload: s.bytes(),
          level: s.num().default(7),
        })
        .extensible(),
    ),
  )

  // The service uses the new Reader, while the retained view keeps the old one.
  expect(unwrap(retained.schema.get(seed.id, readerB.lens.at('alice').$.level))).toEqual(some(7))
  expect(captured.get(readerB.lens.at('alice').$.level)).toMatchObject({
    ok: false,
    error: { kind: 'validation_failed', reason: 'type_mismatch' },
  })
  expect(unwrap(captured.get(readerA.lens.at('alice').$.hp))).toEqual(some(10))

  // Historical inspection stays Writer-based: `config` is dormant for the new Reader.
  const inspection = present(unwrap(retained.schema.inspectInstance(seed.id, ['actors', 'alice'])))
  expect(inspection).toMatchObject({ nodeKind: 'struct', dormantFieldKeys: ['config'] })
  if (inspection.nodeKind === 'struct') {
    const luck = inspection.customFields.luck
    if (!luck) throw new Error('Expected custom luck field')
    expect(luck).toMatchObject({
      value: 4,
      meta: { summary: 'lucky' },
    })
  }
})
