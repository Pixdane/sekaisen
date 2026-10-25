import { afterEach, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveFixture } from './perspective-fixture.ts'
import { seedBase, unwrap, WorldModelFixture } from './world-model-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

const worldKey = encodePathKey(['world'])

test('a field rumor mixed with global feeds grants no sibling schema declarations', () => {
  const f = new WorldModelFixture()
  drivers.push(f.driver)
  seedBase(f, 10)
  const alice = f.worldModel.lenses.characters.at('alice')
  const heard = f.commit('a rumor is not structural discovery', (tx) => {
    unwrap(f.perspective.configurePerspective(tx, alice, {}))
    unwrap(f.perspective.grantRumor(tx, alice, ['world', 'imaginary'], 'a rumor only'))
  })
  const view = unwrap(f.perspective.projectView(heard.id, alice))
  for (const schemas of [view.schemas, view.privateView.schemas]) {
    expect(Object.keys(schemas[worldKey]?.fields ?? {}).sort()).toEqual([
      'clock',
      'imaginary',
      'timeAnchorLabel',
    ])
    expect(JSON.stringify(schemas[worldKey])).not.toContain('storytellerMode')
    expect(JSON.stringify(schemas[worldKey])).not.toContain('tension')
  }
  expect(view.mergedInstances[worldKey]?.fields.imaginary?.value).toBe('a rumor only')
  expect(view.mergedInstances[worldKey]?.fields.clock?.value).toBe(10)
})

test('an individual observed field does not grant the full singleton schema but explicit discovery does', () => {
  const f = new WorldModelFixture()
  drivers.push(f.driver)
  seedBase(f, 10)
  const alice = f.worldModel.lenses.characters.at('alice')
  const observed = f.commit('grant only the clock field', (tx) => {
    unwrap(f.perspective.grantKnowledge(tx, alice, ['world', 'clock']))
    unwrap(f.perspective.grantRumor(tx, alice, ['world', 'imaginary'], 'fiction'))
    tx.set(alice.$.location, NONE)
  })
  const before = unwrap(f.perspective.projectView(observed.id, alice))
  expect(Object.keys(before.schemas[worldKey]?.fields ?? {}).sort()).toEqual(['clock', 'imaginary'])
  const discovered = f.commit('explicitly grant structural knowledge', (tx) => {
    unwrap(f.perspective.grantKnowledge(tx, alice, ['world']))
  })
  const after = unwrap(f.perspective.projectView(discovered.id, alice))
  expect(Object.keys(after.schemas[worldKey]?.fields ?? {}).sort()).toEqual([
    'clock',
    'imaginary',
    'storytellerMode',
    'tension',
    'timeAnchorLabel',
  ])
  // Knowing the shape still grants no private controller values.
  expect(f.perspective.inspect(discovered.id, alice, [['world', 'tension']]).ok).toBe(false)
})

test('retelling a live feed records the current draft fact and preserves it offstage', () => {
  const f = new WorldModelFixture()
  drivers.push(f.driver)
  seedBase(f, 10)
  const alice = f.worldModel.lenses.characters.at('alice')
  const bob = f.worldModel.lenses.characters.at('bob')
  const configured = f.commit('prepare a staged sender and offstage receiver', (tx) => {
    tx.set(bob, { name: 'Bob' })
    unwrap(f.perspective.configurePerspective(tx, alice, {}))
    unwrap(f.perspective.configurePerspective(tx, bob, {}))
  })
  expect(unwrap(f.perspective.inspect(configured.id, alice, [['world', 'clock']]))[0]?.value).toBe(
    10,
  )
  const retold = f.commit('retell the draft clock without syncing it', (tx) => {
    tx.set(f.worldModel.lenses.world.$.clock, 20)
    unwrap(f.perspective.propagateKnowledge(tx, alice, bob, ['world', 'clock']))
  })
  const later = f.commit('the clock changes without Bob witnessing it', (tx) => {
    tx.set(f.worldModel.lenses.world.$.clock, 30)
  })
  expect(unwrap(f.perspective.inspect(later.id, alice, [['world', 'clock']]))[0]?.value).toBe(30)
  expect(unwrap(f.perspective.inspect(later.id, bob, [['world', 'clock']]))[0]).toMatchObject({
    value: 20,
    sourceKind: 'observed_claim',
    at: some(retold.id),
    acquiredAt: some(retold.id),
  })
  const view = unwrap(f.perspective.projectView(later.id, bob))
  expect(Object.keys(view.schemas[worldKey]?.fields ?? {})).toEqual(['clock'])
})

test('retelling uses the folded subjective feed rather than the objective clock', () => {
  const f = new WorldModelFixture()
  drivers.push(f.driver)
  seedBase(f, 10)
  const alice = f.worldModel.lenses.characters.at('alice')
  const bob = f.worldModel.lenses.characters.at('bob')
  const retold = f.commit('hear and retell a clock hallucination', (tx) => {
    tx.set(bob, { name: 'Bob' })
    unwrap(
      f.perspective.grantRumor(tx, alice, ['world', 'clock'], 999, {
        priority: 2500,
        override: true,
      }),
    )
    unwrap(f.perspective.propagateKnowledge(tx, alice, bob, ['world', 'clock']))
  })
  expect(unwrap(f.perspective.inspect(retold.id, alice, [['world', 'clock']]))[0]?.value).toBe(999)
  expect(unwrap(f.perspective.inspect(retold.id, bob, [['world', 'clock']]))[0]).toMatchObject({
    value: 999,
    sourceKind: 'rumor_claim',
  })
  const excluded = f.commit('exclude even the hallucinated clock', (tx) => {
    unwrap(f.perspective.excludeKnowledge(tx, alice, ['world', 'clock'], { priority: 3000 }))
    expect(f.perspective.propagateKnowledge(tx, alice, bob, ['world', 'clock'])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })
  expect(f.perspective.inspect(excluded.id, alice, [['world', 'clock']]).ok).toBe(false)
  expect(unwrap(f.perspective.inspect(excluded.id, bob, [['world', 'clock']]))[0]?.value).toBe(999)
})

for (const hiddenBy of ['offstage', 'field visibility', 'root visibility'] as const) {
  test(`a live feed denied by ${hiddenBy} is also unavailable for retelling`, () => {
    const f = new WorldModelFixture()
    drivers.push(f.driver)
    seedBase(f, 10)
    const alice = f.worldModel.lenses.characters.at('alice')
    const bob = f.worldModel.lenses.characters.at('bob')
    const hidden = f.commit('change live-feed authorization', (tx) => {
      tx.set(bob, { name: 'Bob' })
      if (hiddenBy === 'offstage') tx.set(alice.$.location, NONE)
      else if (hiddenBy === 'field visibility')
        tx.setWithMeta(f.worldModel.lenses.world.$.clock, 10, { visibility: 'ref' })
      else tx.setInstanceMeta(f.worldModel.lenses.world, { visibility: 'ref' })
      expect(f.perspective.propagateKnowledge(tx, alice, bob, ['world', 'clock'])).toMatchObject({
        ok: false,
        error: { kind: 'not_authorized' },
      })
    })
    expect(f.perspective.inspect(hidden.id, alice, [['world', 'clock']]).ok).toBe(false)
    expect(f.perspective.inspect(hidden.id, bob, [['world', 'clock']]).ok).toBe(false)
  })
}

for (const kind of ['map member', 'nested map member'] as const) {
  test(`a globalSurface marker on a ${kind} does not disable normal observation memory`, () => {
    const f = new PerspectiveFixture()
    drivers.push(f.driver)
    const instance = s.struct({
      broadcast: s.str().default('').meta({ visibility: 'surface', globalSurface: true }),
      parent: s
        .link({
          targetRoots: [['entities']],
          exclusiveRole: 'parent',
          acyclic: true,
          onDelete: 'unlink',
        })
        .optional()
        .meta({ linkRoles: ['parent'], visibility: 'ref' }),
    })
    unwrap(
      f.schema.define(
        ['signals'],
        kind === 'map member' ? s.map(instance) : s.struct({ notes: s.map(instance) }),
      ),
    )
    f.seed()
    const path = kind === 'map member' ? ['signals', 'note'] : ['signals', 'notes', 'note']
    const observed = f.commit('observe an ordinary positioned instance', (tx) => {
      const lens = unwrap(tx.lensAt(path))
      if (lens.opticKind !== 'struct') throw new Error('Expected signal instance')
      tx.set(lens, { broadcast: 'remembered signal', parent: f.key('room') })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const later = f.commit('leave before an unseen update', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
      const lens = unwrap(tx.lensAt([...path, 'broadcast']))
      if (lens.opticKind !== 'field') throw new Error('Expected broadcast leaf')
      tx.set(lens, 'unseen new signal')
    })
    expect(
      unwrap(f.perspective.inspect(later.id, f.at('alice'), [[...path, 'broadcast']]))[0],
    ).toMatchObject({
      value: 'remembered signal',
      sourceKind: 'observed_claim',
      at: some(observed.id),
      acquiredAt: some(observed.id),
    })
    const corpus = unwrap(f.perspective.listSearchableCorpus(later.id, f.at('alice')))
    expect(
      corpus.find((entry) => encodePathKey(entry.path) === encodePathKey([...path, 'broadcast']))
        ?.text,
    ).toBe('remembered signal')
  })
}

function globalRelationsFixture() {
  const f = new WorldModelFixture()
  drivers.push(f.driver)
  const extended = unwrap(
    f.schema.augment(f.worldModel.lenses.world, {
      focus: s
        .link({ targetRoots: [['entities', 'character']], onDelete: 'unlink' })
        .optional()
        .meta({ visibility: 'surface', globalSurface: true }),
      focusSnapshot: s.ref().optional().meta({ visibility: 'surface', globalSurface: true }),
    }),
  )
  seedBase(f, 10)
  const alice = f.worldModel.lenses.characters.at('alice')
  const bob = f.worldModel.lenses.characters.at('bob')
  const historical = f.commit('prepare an observer and an unknown offstage target', (tx) => {
    tx.set(bob, { name: 'Unknown Bob' })
    unwrap(f.perspective.configurePerspective(tx, alice, {}))
  })
  const published = f.commit('publish global link and historical entity ref', (tx) => {
    tx.patch(extended, {
      focus: encodePathKey(alice.path),
      focusSnapshot: { commitId: historical.id, path: alice.path },
    })
  })
  return { f, extended, alice, bob, historical, published }
}

function globalCorpusEntry(f: WorldModelFixture, commitId: CommitHash, field: string) {
  const entry = unwrap(
    f.perspective.listSearchableCorpus(commitId, f.worldModel.lenses.characters.at('alice')),
  ).find((entry) => encodePathKey(entry.path) === encodePathKey(['world', field]))
  if (!entry) throw new Error(`Missing world corpus field: ${field}`)
  return entry
}

test('global link and ref fields contribute authorized current and historical entity coordinates', () => {
  const { f, extended, alice, historical, published } = globalRelationsFixture()
  const inspected = unwrap(
    f.perspective.inspect(published.id, alice, [
      extended.$.focus.path,
      extended.$.focusSnapshot.path,
    ]),
  )
  expect(inspected).toMatchObject([
    { sourceKind: 'direct_scope', value: encodePathKey(alice.path) },
    {
      sourceKind: 'direct_scope',
      value: { commitId: historical.id, path: alice.path },
    },
  ])
  const expected = [
    {
      ref: { commitId: published.id, path: alice.path },
      currentPath: some(alice.path),
      relation: 'current_link' as const,
    },
    {
      ref: { commitId: historical.id, path: alice.path },
      currentPath: some(alice.path),
      relation: 'ref_target' as const,
    },
  ].sort((a, b) => a.ref.commitId.localeCompare(b.ref.commitId))
  for (const field of ['focus', 'focusSnapshot']) {
    const entry = globalCorpusEntry(f, published.id, field)
    expect(entry.linkedEntities).toEqual(expected)
    expect(entry.linkedInstancePaths).toEqual([alice.path])
  }
})

for (const suppressedBy of ['exclusion', 'rumor override', 'known false'] as const) {
  test(`global relation fields suppressed by ${suppressedBy} do not leak through sibling corpus entries`, () => {
    const { f, extended, alice } = globalRelationsFixture()
    const suppressed = f.commit('suppress both global relation sources', (tx) => {
      for (const path of [extended.$.focus.path, extended.$.focusSnapshot.path]) {
        if (suppressedBy === 'exclusion') {
          unwrap(f.perspective.excludeKnowledge(tx, alice, path, { priority: 3000 }))
        } else if (suppressedBy === 'rumor override') {
          // A correct link guess or a literal ref hallucination grants no objective edge.
          unwrap(
            f.perspective.grantRumor(tx, alice, path, encodePathKey(alice.path), {
              priority: 3000,
              override: true,
            }),
          )
        } else {
          unwrap(
            f.perspective.grantKnowledge(tx, alice, path, {
              priority: 3000,
              override: true,
              belief: 'known_false',
            }),
          )
        }
      }
    })
    const entry = globalCorpusEntry(f, suppressed.id, 'clock')
    expect(entry.linkedEntities).toEqual([])
    expect(entry.linkedInstancePaths).toEqual([])
    if (suppressedBy === 'exclusion') {
      expect(f.perspective.inspect(suppressed.id, alice, [extended.$.focus.path]).ok).toBe(false)
    } else {
      expect(
        unwrap(f.perspective.inspect(suppressed.id, alice, [extended.$.focus.path]))[0],
      ).toMatchObject(
        suppressedBy === 'rumor override'
          ? { sourceKind: 'rumor_claim', value: encodePathKey(alice.path) }
          : { sourceKind: 'observed_claim', belief: 'known_false' },
      )
    }
  })
}

test('globally readable relation fields do not grant unknown target identity', () => {
  const { f, extended, alice, bob, historical } = globalRelationsFixture()
  const unknown = f.commit('point both feeds at an unknown entity', (tx) => {
    tx.patch(extended, {
      focus: encodePathKey(bob.path),
      focusSnapshot: { commitId: historical.id, path: bob.path },
    })
  })
  expect(
    unwrap(
      f.perspective.inspect(unknown.id, alice, [
        extended.$.focus.path,
        extended.$.focusSnapshot.path,
      ]),
    ),
  ).toMatchObject([
    { sourceKind: 'direct_scope', value: encodePathKey(bob.path) },
    { sourceKind: 'direct_scope', value: { commitId: historical.id, path: bob.path } },
  ])
  for (const field of ['focus', 'focusSnapshot']) {
    const entry = globalCorpusEntry(f, unknown.id, field)
    expect(entry.linkedEntities).toEqual([])
    expect(entry.linkedInstancePaths).toEqual([])
  }
  const discovered = f.commit(
    'explicitly learn the target identity without seeing its location',
    (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, alice, bob.path))
    },
  )
  const entry = globalCorpusEntry(f, discovered.id, 'focusSnapshot')
  expect(entry.linkedEntities.map((entity) => entity.relation).sort()).toEqual([
    'current_link',
    'ref_target',
  ])
  expect(entry.linkedEntities.every((entity) => entity.currentPath.kind === 'none')).toBe(true)
  expect(entry.linkedInstancePaths).toEqual([bob.path])
})

for (const refKind of ['leaf', 'message'] as const) {
  test(`a global ref to a ${refKind} is not an entity association`, () => {
    const { f, extended, alice, historical } = globalRelationsFixture()
    const published = f.commit('publish a non-entity ref beside a valid global link', (tx) => {
      tx.set(extended.$.focusSnapshot, {
        commitId: historical.id,
        path: refKind === 'leaf' ? alice.$.name.path : ['$message'],
      })
    })
    const entry = globalCorpusEntry(f, published.id, 'focusSnapshot')
    expect(entry.linkedEntities).toEqual([
      {
        ref: { commitId: published.id, path: alice.path },
        currentPath: some(alice.path),
        relation: 'current_link',
      },
    ])
    expect(entry.linkedInstancePaths).toEqual([alice.path])
  })
}
