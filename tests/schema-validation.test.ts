import { afterEach, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import { s } from '@sekaisen/plugin-schema'
import type {
  CommitHash,
  CommitNode,
  Path,
  SqliteDriver,
  StateDiff,
  WorldError,
} from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'
import { DraftOverlay } from '../packages/plugin-schema/src/overlay.ts'
import type { Catalog, StateReader } from '../packages/plugin-schema/src/runtime.ts'
import {
  deleteTree,
  emptyCatalog,
  readCatalog,
  setValue,
  validateState,
  writeCatalog,
  writeCustomSpec,
  writeNode,
} from '../packages/plugin-schema/src/runtime.ts'
import type { LeafSchemaNode, SchemaNode } from '../packages/plugin-schema/src/types.ts'
import { validateChangedState } from '../packages/plugin-schema/src/validation.ts'
import { WorldStateReader } from '../packages/plugin-schema/src/world-reader.ts'

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}
function present<T>(value: Option<T>): T {
  if (value.kind === 'none') throw new Error('Expected a present value')
  return value.value
}
/**
 * Run a validator and return its failure, or `undefined` on acceptance. Full
 * {@link validateState} and {@link validateChangedState} are always compared on
 * the same final draft, then accepted diffs are committed and revalidated
 * through a fresh World reader.
 */
function thrown(run: () => void): unknown {
  try {
    run()
    return undefined
  } catch (error) {
    return error
  }
}
function errorDetail(error: unknown): { kind?: string; path?: Path } {
  if (typeof error !== 'object' || error === null || !('error' in error)) return {}
  const structured = error.error
  if (typeof structured !== 'object' || structured === null) return {}
  const detail: { kind?: string; path?: Path } = {}
  if ('kind' in structured && typeof structured.kind === 'string') detail.kind = structured.kind
  if ('path' in structured && Array.isArray(structured.path)) detail.path = structured.path as Path
  return detail
}
function errorKind(error: unknown): string | undefined {
  return errorDetail(error).kind
}
function errorPath(error: unknown): Path | undefined {
  return errorDetail(error).path
}

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

interface SeedRoot {
  readonly path: Path
  readonly schema: SchemaNode
  readonly value: unknown
}

/**
 * Seed a real SQLite World with a genesis commit plus a valid schema-and-data
 * commit. `extras` may add physical coordinates that need the genesis hash
 * (for example refs).
 */
function setup(
  seeds: readonly SeedRoot[],
  extras?: (draft: DraftOverlay, genesisId: CommitHash) => void,
) {
  const driver = createBunSqliteDriver()
  drivers.push(driver)
  const ctx = new Context()
  const world = new WorldService(ctx, { driver })
  const genesis = unwrap(world.commit({ parentId: NONE, message: 'genesis' }))
  const catalog = emptyCatalog()
  for (const seed of seeds)
    catalog.roots.set(encodePathKey(seed.path), { path: seed.path, schema: seed.schema })
  const draft = new DraftOverlay()
  writeCatalog(draft, catalog)
  for (const seed of seeds) writeNode(draft, seed.path, seed.schema, seed.value)
  extras?.(draft, genesis.id)
  const base = unwrap(
    world.commit({ parentId: some(genesis.id), message: 'seed', diff: draft.compileDiff() }),
  )
  const reader = new WorldStateReader(world, base.id)
  return {
    world,
    baseId: base.id,
    genesisId: genesis.id,
    reader,
    baseCatalog: readCatalog(reader, base.id),
  }
}

interface Evaluation {
  readonly draft: DraftOverlay
  readonly diff: StateDiff
  readonly fullError: unknown
  readonly incrementalError: unknown
  readonly committed: Result<CommitNode, WorldError>
  readonly worldFullError: unknown
}

function evaluate(
  world: WorldService,
  baseId: CommitHash,
  reader: StateReader,
  catalog: Catalog,
  mutate: (draft: DraftOverlay) => void,
  overrideCatalog?: Catalog,
): Evaluation {
  const draft = new DraftOverlay(reader)
  mutate(draft)
  const diff = draft.compileDiff()
  const finalCatalog = overrideCatalog ?? catalog
  const fullError = thrown(() => validateState(draft, finalCatalog, baseId))
  const incrementalError = thrown(() => validateChangedState(draft, finalCatalog, baseId, diff))
  const committed = world.commit({ parentId: some(baseId), message: 'mutation', diff })
  let worldFullError: unknown
  if (committed.ok) {
    const nextReader = new WorldStateReader(world, committed.value.id)
    let nextCatalog: Catalog | undefined
    try {
      nextCatalog = readCatalog(nextReader, committed.value.id)
    } catch (error) {
      worldFullError = error
    }
    if (nextCatalog !== undefined) {
      const catalogAtNext = nextCatalog
      worldFullError = thrown(() => validateState(nextReader, catalogAtNext, committed.value.id))
    }
  }
  return { draft, diff, fullError, incrementalError, committed, worldFullError }
}

function expectAccepted(result: Evaluation): void {
  expect(result.fullError).toBeUndefined()
  expect(result.incrementalError).toBeUndefined()
  expect(result.worldFullError).toBeUndefined()
  expect(result.committed.ok).toBe(true)
}

function expectRejected(result: Evaluation): void {
  expect(result.fullError).toBeDefined()
  expect(result.incrementalError).toBeDefined()
  expect(errorKind(result.incrementalError)).toBe(errorKind(result.fullError))
  if (result.committed.ok) expect(result.worldFullError).toBeDefined()
}

interface Access {
  readonly getEntry: Path[]
  readonly hasEntry: Path[]
  readonly childKeys: Path[]
}
/** Record validator-only reads; the draft's base reads during diff compilation are separate. */
function observe(state: StateReader): { state: StateReader; access: Access } {
  const access: Access = { getEntry: [], hasEntry: [], childKeys: [] }
  const observed: StateReader = {
    getEntry(path) {
      access.getEntry.push([...path])
      return state.getEntry(path)
    },
    hasEntry(path) {
      access.hasEntry.push([...path])
      return state.hasEntry(path)
    },
    childKeys(path) {
      access.childKeys.push([...path])
      return state.childKeys(path)
    },
  }
  return { state: observed, access }
}
function touches(paths: readonly Path[], prefix: Path): boolean {
  return paths.some((path) => prefix.every((key, index) => path[index] === key))
}
function lists(paths: readonly Path[], target: Path): boolean {
  return paths.some(
    (path) => path.length === target.length && path.every((key, index) => key === target[index]),
  )
}

test('a Map member point update agrees with full validation and leaves siblings unread', () => {
  const { world, baseId, reader, baseCatalog } = setup([
    {
      path: ['records'],
      schema: s.map(s.struct({ n: s.num(), tags: s.map(s.str()) })),
      value: {
        a: { n: 1, tags: { x: 'one' } },
        b: { n: 2, tags: { y: 'two' } },
      },
    },
  ])
  const draft = new DraftOverlay(reader)
  setValue(draft, ['records', 'a', 'n', '$val'], 10)
  const diff = draft.compileDiff()
  const observed = observe(draft)
  expect(
    thrown(() => validateChangedState(observed.state, baseCatalog, baseId, diff)),
  ).toBeUndefined()
  // The root Map and the untouched nested Map must not be enumerated.
  expect(lists(observed.access.childKeys, ['records'])).toBe(false)
  expect(lists(observed.access.childKeys, ['records', 'a', 'tags'])).toBe(false)
  // Untouched member payloads stay unread.
  expect(touches(observed.access.getEntry, ['records', 'b'])).toBe(false)
  expect(touches(observed.access.getEntry, ['records', 'a', 'tags'])).toBe(false)
  const next = unwrap(world.commit({ parentId: some(baseId), message: 'point', diff }))
  expect(present(unwrap(world.getValue(next.id, ['records', 'a', 'n', '$val'])))).toBe(10)
  expect(present(unwrap(world.getValue(next.id, ['records', 'b', 'n', '$val'])))).toBe(2)
  expect(
    thrown(() => validateState(new WorldStateReader(world, next.id), baseCatalog, next.id)),
  ).toBeUndefined()
})

test('nested Map point writes do not enumerate parent Map keys', () => {
  const { world, baseId, reader, baseCatalog } = setup([
    {
      path: ['groups'],
      schema: s.map(s.map(s.struct({ v: s.num() }))),
      value: {
        g1: { m1: { v: 1 }, m2: { v: 2 } },
        g2: { m1: { v: 3 } },
      },
    },
  ])
  const draft = new DraftOverlay(reader)
  setValue(draft, ['groups', 'g1', 'm1', 'v', '$val'], 9)
  const diff = draft.compileDiff()
  const observed = observe(draft)
  expect(
    thrown(() => validateChangedState(observed.state, baseCatalog, baseId, diff)),
  ).toBeUndefined()
  expect(lists(observed.access.childKeys, ['groups'])).toBe(false)
  expect(lists(observed.access.childKeys, ['groups', 'g1'])).toBe(false)
  expect(touches(observed.access.getEntry, ['groups', 'g2'])).toBe(false)
  expect(touches(observed.access.getEntry, ['groups', 'g1', 'm2'])).toBe(false)
  const next = unwrap(world.commit({ parentId: some(baseId), message: 'nested', diff }))
  expect(present(unwrap(world.getValue(next.id, ['groups', 'g1', 'm1', 'v', '$val'])))).toBe(9)
  expect(present(unwrap(world.getValue(next.id, ['groups', 'g1', 'm2', 'v', '$val'])))).toBe(2)
})

test('optional deletion stays valid; defaulted and required deletion are rejected', () => {
  const { world, baseId, reader, baseCatalog } = setup([
    {
      path: ['prefs'],
      schema: s.struct({ theme: s.str().optional(), count: s.num().default(3) }),
      value: { theme: 'dark', count: 5 },
    },
    {
      path: ['account'],
      schema: s.struct({ id: s.str(), nick: s.str().optional() }),
      value: { id: 'a' },
    },
    {
      path: ['counter'],
      schema: s.struct({ n: s.num().default(7) }),
      value: { n: 5 },
    },
  ])
  const optional = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    deleteTree(draft, ['prefs', 'theme']),
  )
  expectAccepted(optional)
  const defaulted = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    deleteTree(draft, ['counter', 'n']),
  )
  expectRejected(defaulted)
  expect(errorKind(defaulted.incrementalError)).toBe('corrupted_instance_data')
  const required = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    deleteTree(draft, ['account', 'id']),
  )
  expectRejected(required)
  expect(errorKind(required.incrementalError)).toBe('corrupted_instance_data')
  if (!required.committed.ok) throw new Error('expected a physically valid diff')
  expect(unwrap(world.getNodeInfo(required.committed.value.id, ['account', 'id']))).toEqual(NONE)
})

test('required and defaulted Map member deletion is valid; undermaterialized members are rejected', () => {
  const { world, baseId, reader, baseCatalog } = setup([
    {
      path: ['requiredMap'],
      schema: s.map(s.struct({ k: s.str(), n: s.num() })),
      value: { one: { k: 'x', n: 1 }, two: { k: 'y', n: 2 } },
    },
    {
      path: ['defaultedMap'],
      schema: s.map(s.num().default(0)),
      value: { a: 1, b: 2 },
    },
  ])
  const deleted = evaluate(world, baseId, reader, baseCatalog, (draft) => {
    deleteTree(draft, ['requiredMap', 'one'])
    deleteTree(draft, ['defaultedMap', 'a'])
  })
  expectAccepted(deleted)
  if (!deleted.committed.ok) throw new Error('expected an accepted diff')
  expect(unwrap(world.getNodeInfo(deleted.committed.value.id, ['requiredMap', 'one']))).toEqual(
    NONE,
  )
  expect(unwrap(world.getNodeInfo(deleted.committed.value.id, ['defaultedMap', 'a']))).toEqual(NONE)

  const undermaterialized = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    setValue(draft, ['requiredMap', 'three', '$exists'], true),
  )
  expectRejected(undermaterialized)
  expect(errorKind(undermaterialized.incrementalError)).toBe('corrupted_instance_data')
})

test('metadata, ref, and bytes point writes agree and skip an unrelated root', () => {
  const docSchema = s.struct({
    blob: s.bytes(),
    link: s.ref().optional(),
    label: s.str(),
  })
  const { world, baseId, genesisId, reader, baseCatalog } = setup(
    [
      {
        path: ['doc'],
        schema: docSchema,
        value: { blob: new Uint8Array([1, 2, 3]), label: 'base' },
      },
      { path: ['other'], schema: s.struct({ n: s.num() }), value: { n: 4 } },
    ],
    (draft, genesis) =>
      setValue(draft, ['doc', 'link', '$val'], { commitId: genesis, path: [] }, true),
  )
  const draft = new DraftOverlay(reader)
  setValue(draft, ['doc', 'blob', '$val'], new Uint8Array([9, 9]))
  setValue(draft, ['doc', 'label', '$meta', 'tag'], 'fresh')
  setValue(draft, ['doc', 'link', '$val'], { commitId: genesisId, path: ['doc'] }, true)
  const diff = draft.compileDiff()
  const observed = observe(draft)
  expect(
    thrown(() => validateChangedState(observed.state, baseCatalog, baseId, diff)),
  ).toBeUndefined()
  expect(touches(observed.access.getEntry, ['other'])).toBe(false)
  const next = unwrap(world.commit({ parentId: some(baseId), message: 'leaf', diff }))
  expect(present(unwrap(world.getValue(next.id, ['doc', 'label', '$meta', 'tag'])))).toBe('fresh')
  expect(present(unwrap(world.getValue(next.id, ['doc', 'blob', '$val'])))).toEqual(
    new Uint8Array([9, 9]),
  )
  expect(present(unwrap(world.getRef(next.id, ['doc', 'link', '$val'])))).toEqual({
    commitId: genesisId,
    path: ['doc'],
  })
})

test('an exact restore produces an empty diff and performs no structural reads', () => {
  const { reader, baseId, baseCatalog } = setup([
    {
      path: ['prefs'],
      schema: s.struct({ theme: s.str(), count: s.num().default(3) }),
      value: { theme: 'dark' },
    },
  ])
  const draft = new DraftOverlay(reader)
  setValue(draft, ['prefs', 'theme', '$val'], 'temporary')
  setValue(draft, ['prefs', 'theme', '$val'], 'dark')
  const diff = draft.compileDiff()
  expect(diff).toEqual([])
  const observed = observe(draft)
  expect(
    thrown(() => validateChangedState(observed.state, baseCatalog, baseId, diff)),
  ).toBeUndefined()
  expect(observed.access.getEntry).toEqual([])
  expect(observed.access.hasEntry).toEqual([])
  expect(observed.access.childKeys).toEqual([])
  expect(thrown(() => validateState(draft, baseCatalog, baseId))).toBeUndefined()
})

test('orphan data, false anchors, and undeclared fields are rejected by both validators', () => {
  const { world, baseId, reader, baseCatalog } = setup([
    {
      path: ['cfg'],
      schema: s.struct({ n: s.num(), opt: s.struct({ x: s.num() }).optional() }),
      value: { n: 1 },
    },
  ])
  const orphan = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    setValue(draft, ['cfg', 'opt', 'stray', '$val'], 1),
  )
  expectRejected(orphan)
  expect(errorKind(orphan.incrementalError)).toBe('corrupted_instance_data')
  expect(errorPath(orphan.incrementalError)).toEqual(['cfg', 'opt'])

  const falseAnchor = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    setValue(draft, ['cfg', 'opt', '$exists'], false),
  )
  expectRejected(falseAnchor)
  expect(errorKind(falseAnchor.incrementalError)).toBe('corrupted_instance_data')

  const undeclared = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    setValue(draft, ['cfg', 'extra', '$val'], 1),
  )
  expectRejected(undeclared)
  expect(errorKind(undeclared.incrementalError)).toBe('corrupted_instance_data')
  expect(errorPath(undeclared.incrementalError)).toEqual(['cfg', 'extra'])
})

test('custom field edits widen to the containing struct and match full validation', () => {
  const { world, baseId, reader, baseCatalog } = setup(
    [
      {
        path: ['meta'],
        schema: s.struct({ n: s.num() }).extensible(),
        value: { n: 1 },
      },
    ],
    (draft) => {
      setValue(draft, ['meta', '$custom', 'tag', '$val'], 'old')
      writeCustomSpec(draft, ['meta', '$custom', 'tag'], s.str())
    },
  )
  const updated = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    setValue(draft, ['meta', '$custom', 'tag', '$val'], 'new'),
  )
  expectAccepted(updated)
  if (!updated.committed.ok) throw new Error('expected an accepted diff')
  expect(
    present(unwrap(world.getValue(updated.committed.value.id, ['meta', '$custom', 'tag', '$val']))),
  ).toBe('new')

  const removed = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    deleteTree(draft, ['meta', '$custom', 'tag']),
  )
  expectAccepted(removed)
  if (!removed.committed.ok) throw new Error('expected an accepted diff')
  expect(unwrap(world.getNodeInfo(removed.committed.value.id, ['meta', '$custom', 'tag']))).toEqual(
    NONE,
  )

  const invalidSpec = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    writeCustomSpec(draft, ['meta', '$custom', 'bad'], s.struct({}) as unknown as LeafSchemaNode),
  )
  expectRejected(invalidSpec)
  expect(errorKind(invalidSpec.incrementalError)).toBe('corrupted_instance_data')

  const collision = evaluate(world, baseId, reader, baseCatalog, (draft) =>
    setValue(draft, ['meta', '$custom', 'n', '$val'], 2),
  )
  expectRejected(collision)
  expect(errorKind(collision.incrementalError)).toBe('corrupted_instance_data')
})

test('subtree replacement agrees and restores only the written coordinates', () => {
  const bagSchema = s.struct({ n: s.num(), note: s.str().optional() })
  const { world, baseId, reader, baseCatalog } = setup([
    { path: ['bag'], schema: bagSchema, value: { n: 1, note: 'old' } },
  ])
  const replaced = evaluate(world, baseId, reader, baseCatalog, (draft) => {
    deleteTree(draft, ['bag'])
    writeNode(draft, ['bag'], bagSchema, { n: 2 })
  })
  expectAccepted(replaced)
  if (!replaced.committed.ok) throw new Error('expected an accepted diff')
  expect(present(unwrap(world.getValue(replaced.committed.value.id, ['bag', 'n', '$val'])))).toBe(2)
  expect(unwrap(world.getNodeInfo(replaced.committed.value.id, ['bag', 'note']))).toEqual(NONE)
})

test('deleting a physical ancestor of a root validates that root only', () => {
  const optional = setup([
    {
      path: ['a', 'b'],
      schema: s.struct({ n: s.num() }).optional(),
      value: { n: 1 },
    },
  ])
  const removed = evaluate(
    optional.world,
    optional.baseId,
    optional.reader,
    optional.baseCatalog,
    (draft) => deleteTree(draft, ['a']),
  )
  expectAccepted(removed)
  if (removed.committed.ok)
    expect(unwrap(optional.world.getNodeInfo(removed.committed.value.id, ['a']))).toEqual(NONE)

  const required = setup([{ path: ['a', 'b'], schema: s.struct({ n: s.num() }), value: { n: 1 } }])
  const missing = evaluate(
    required.world,
    required.baseId,
    required.reader,
    required.baseCatalog,
    (draft) => deleteTree(draft, ['a']),
  )
  expectRejected(missing)
  expect(errorKind(missing.incrementalError)).toBe('corrupted_instance_data')
})

test('a changed Catalog falls back to full traversal', () => {
  const { world, baseId, reader } = setup([
    { path: ['items'], schema: s.struct({ n: s.num() }), value: { n: 1 } },
  ])
  const buildCatalog = (schema: SchemaNode) => {
    const catalog = emptyCatalog()
    catalog.roots.set(encodePathKey(['items']), { path: ['items'], schema })
    return catalog
  }

  const requiredCatalog = buildCatalog(s.struct({ n: s.num(), extra: s.str() }))
  const rejectedDraft = new DraftOverlay(reader)
  writeCatalog(rejectedDraft, requiredCatalog)
  const rejectedDiff = rejectedDraft.compileDiff()
  const rejectedCatalog = readCatalog(rejectedDraft, baseId)
  const rejectedFull = thrown(() => validateState(rejectedDraft, rejectedCatalog, baseId))
  const rejectedIncremental = thrown(() =>
    validateChangedState(rejectedDraft, rejectedCatalog, baseId, rejectedDiff),
  )
  expect(rejectedFull).toBeDefined()
  expect(rejectedIncremental).toBeDefined()
  expect(errorKind(rejectedIncremental)).toBe(errorKind(rejectedFull))
  expect(errorKind(rejectedIncremental)).toBe('corrupted_instance_data')
  const rejectedCommit = unwrap(
    world.commit({ parentId: some(baseId), message: 'catalog', diff: rejectedDiff }),
  )
  const rejectedReader = new WorldStateReader(world, rejectedCommit.id)
  expect(
    thrown(() =>
      validateState(
        rejectedReader,
        readCatalog(rejectedReader, rejectedCommit.id),
        rejectedCommit.id,
      ),
    ),
  ).toBeDefined()

  const optionalCatalog = buildCatalog(s.struct({ n: s.num(), extra: s.str().optional() }))
  const acceptedDraft = new DraftOverlay(reader)
  writeCatalog(acceptedDraft, optionalCatalog)
  const acceptedDiff = acceptedDraft.compileDiff()
  const acceptedCatalog = readCatalog(acceptedDraft, baseId)
  expect(thrown(() => validateState(acceptedDraft, acceptedCatalog, baseId))).toBeUndefined()
  expect(
    thrown(() => validateChangedState(acceptedDraft, acceptedCatalog, baseId, acceptedDiff)),
  ).toBeUndefined()
  const acceptedCommit = unwrap(
    world.commit({ parentId: some(baseId), message: 'catalog', diff: acceptedDiff }),
  )
  const acceptedReader = new WorldStateReader(world, acceptedCommit.id)
  const nextCatalog = readCatalog(acceptedReader, acceptedCommit.id)
  expect(nextCatalog.roots.get(encodePathKey(['items']))?.schema).toMatchObject({
    nodeKind: 'struct',
    fields: { extra: { nodeKind: 'leaf', presence: { mode: 'optional' } } },
  })
  expect(
    thrown(() => validateState(acceptedReader, nextCatalog, acceptedCommit.id)),
  ).toBeUndefined()
  expect(present(unwrap(world.getValue(acceptedCommit.id, ['items', 'n', '$val'])))).toBe(1)
})
