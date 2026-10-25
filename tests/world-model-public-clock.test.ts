import { afterEach, describe, expect, test } from 'bun:test'
import { some } from '@sekaisen/core'
import type { ObserverRef } from '@sekaisen/plugin-perspective'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { WORLD_ROOT_PATH } from '@sekaisen/plugin-world-model'
import { entityKey as key, seedBase, unwrap, WorldModelFixture } from './world-model-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

const WORLD_KEY = encodePathKey(WORLD_ROOT_PATH)
const CLOCK_PATH: Path = [...WORLD_ROOT_PATH, 'clock']
const ANCHOR_PATH: Path = [...WORLD_ROOT_PATH, 'timeAnchorLabel']

function setup(): WorldModelFixture {
  const fixture = new WorldModelFixture()
  drivers.push(fixture.driver)
  return fixture
}

/** Seed the room with Alice, stage Bob beside her and materialize both minds. */
function stagedSetup(f: WorldModelFixture, clock = 10) {
  seedBase(f, clock)
  return f.commit('stage bob and materialize both observers', (tx) => {
    tx.set(f.worldModel.lenses.characters.at('bob'), {
      name: 'Bob',
      location: key('location', 'room'),
    })
    unwrap(f.perspective.configurePerspective(tx, f.path('character', 'alice'), {}))
    unwrap(f.perspective.configurePerspective(tx, f.path('character', 'bob'), {}))
  })
}

/** Merged world instance for one observer, or undefined when it was not surfaced. */
function worldInstance(f: WorldModelFixture, commitId: CommitHash, observer: ObserverRef) {
  return unwrap(f.perspective.projectView(commitId, observer)).mergedInstances[WORLD_KEY]
}

function worldFieldNames(
  f: WorldModelFixture,
  commitId: CommitHash,
  observer: ObserverRef,
): readonly string[] {
  const instance = worldInstance(f, commitId, observer)
  return instance === undefined ? [] : Object.freeze(Object.keys(instance.fields).sort())
}

function expectNotAuthorized(
  f: WorldModelFixture,
  commitId: CommitHash,
  observer: ObserverRef,
  path: Path,
): void {
  expect(f.perspective.inspect(commitId, observer, [path])).toMatchObject({
    ok: false,
    error: { kind: 'not_authorized' },
  })
}

function isStateRef(value: Value | StateRef): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    'commitId' in value &&
    'path' in value
  )
}

/** Observed claim target keys written for one observer, read host-side. */
function observedTargets(f: WorldModelFixture, commitId: CommitHash, observer: Path) {
  const inspected = unwrap(
    f.schema.inspectInstance(commitId, ['perspectives', encodePathKey(observer), 'observedClaims']),
  )
  const targets: string[] = []
  if (inspected.kind === 'none' || inspected.value.nodeKind !== 'map') return targets
  for (const entry of Object.values(inspected.value.entries)) {
    if (entry.nodeKind !== 'struct') continue
    const target = entry.fields.targetRef
    if (target === undefined || target.kind !== 'some') continue
    if (target.value.nodeKind !== 'leaf') continue
    const value = target.value.value
    if (isStateRef(value)) targets.push(encodePathKey(value.path))
  }
  return targets
}

describe('declared world clock global feed', () => {
  test('staged observers project, inspect, search and asObserver the live clock', () => {
    const f = setup()
    const seeded = stagedSetup(f, 10)
    const alice = f.path('character', 'alice')

    const world = worldInstance(f, seeded.id, alice)
    if (world === undefined) throw new Error('Expected the global world feed')
    expect(Object.keys(world.fields).sort()).toEqual(['clock', 'timeAnchorLabel'])
    expect(world.fields.clock?.value).toBe(10)
    expect(world.fields.timeAnchorLabel?.value).toBe('clock zero')

    const inspected = unwrap(f.perspective.inspect(seeded.id, alice, [WORLD_ROOT_PATH]))
    expect(inspected.map((entry) => encodePathKey(entry.path)).sort()).toEqual(
      [CLOCK_PATH, ANCHOR_PATH].map(encodePathKey).sort(),
    )
    expect(inspected.find((entry) => entry.path.at(-1) === 'clock')?.value).toBe(10)

    const corpus = unwrap(f.perspective.listSearchableCorpus(seeded.id, alice))
    expect(
      corpus.find((entry) => encodePathKey(entry.path) === encodePathKey(CLOCK_PATH))?.text,
    ).toBe('10')
    expect(
      corpus.find((entry) => encodePathKey(entry.path) === encodePathKey(ANCHOR_PATH))?.text,
    ).toBe('clock zero')

    const rawWorld = unwrap(f.perspective.projectScopePublic(seeded.id, WORLD_ROOT_PATH))
    expect(Object.keys(rawWorld.instances[WORLD_KEY]?.fields ?? {}).sort()).toEqual([
      'clock',
      'timeAnchorLabel',
    ])
    expect(rawWorld.instances[WORLD_KEY]?.fields.clock?.value).toBe(10)

    const facade = unwrap(f.perspective.asObserver(seeded.id, alice))
    const facadeWorld = unwrap(facade.projectView()).mergedInstances[WORLD_KEY]
    expect(facadeWorld?.fields.clock?.value).toBe(10)
    expect(unwrap(facade.inspect([CLOCK_PATH]))[0]?.value).toBe(10)
    expect(
      unwrap(facade.listSearchableCorpus()).some(
        (entry) => encodePathKey(entry.path) === encodePathKey(CLOCK_PATH),
      ),
    ).toBe(true)
  })

  test('a staged blind observer still receives the declared data feed', () => {
    const f = setup()
    stagedSetup(f, 14)
    const alice = f.path('character', 'alice')
    const muted = f.commit('disable all of alice senses', (tx) => {
      tx.setInstanceMeta(f.worldModel.lenses.characters.at('alice'), { sensoryEnabled: false })
    })

    /* Global feeds are declared data, not photons: blindness does not revoke them. */
    expect(worldInstance(f, muted.id, alice)?.fields.clock?.value).toBe(14)
    expect(unwrap(f.perspective.projectView(muted.id, alice)).scenePublic.kind).toBe('none')
  })

  test('each committed read uses the commit clock without syncScope', () => {
    const f = setup()
    const seeded = stagedSetup(f, 10)
    const alice = f.path('character', 'alice')
    const advanced = f.commit('advance the clock', (tx) => {
      tx.patch(f.worldModel.lenses.world, { clock: 25, timeAnchorLabel: 'Year 2' })
    })

    expect(worldInstance(f, seeded.id, alice)?.fields.clock?.value).toBe(10)
    expect(worldInstance(f, advanced.id, alice)?.fields.clock?.value).toBe(25)
    expect(worldInstance(f, advanced.id, alice)?.fields.timeAnchorLabel?.value).toBe('Year 2')
  })

  test('syncScope omits global feeds and never freezes them as observations', () => {
    const f = setup()
    stagedSetup(f, 10)
    const alice = f.path('character', 'alice')
    const synced = f.commit('sync the room', (tx) => {
      unwrap(f.perspective.syncScope(tx, f.path('location', 'room')))
    })

    const targets = observedTargets(f, synced.id, alice)
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.some((target) => target.startsWith(WORLD_KEY))).toBe(false)
    expect(worldInstance(f, synced.id, alice)?.fields.clock?.value).toBe(10)

    const advanced = f.commit('advance the clock after sync', (tx) => {
      tx.patch(f.worldModel.lenses.world, { clock: 30 })
    })
    expect(worldInstance(f, advanced.id, alice)?.fields.clock?.value).toBe(30)
  })

  test('protected ref fields and non-opted augment fields stay hidden', () => {
    const f = setup()
    const seeded = stagedSetup(f, 10)
    const alice = f.path('character', 'alice')

    expect(worldFieldNames(f, seeded.id, alice)).toEqual(['clock', 'timeAnchorLabel'])
    expectNotAuthorized(f, seeded.id, alice, [...WORLD_ROOT_PATH, 'storytellerMode'])
    expectNotAuthorized(f, seeded.id, alice, [...WORLD_ROOT_PATH, 'tension'])
    const corpusText = JSON.stringify(unwrap(f.perspective.listSearchableCorpus(seeded.id, alice)))
    expect(corpusText).not.toContain('storytellerMode')
    expect(corpusText).not.toContain('tension')
    const projected = unwrap(f.perspective.projectView(seeded.id, alice))
    expect(Object.keys(projected.schemas[WORLD_KEY]?.fields ?? {}).sort()).toEqual([
      'clock',
      'timeAnchorLabel',
    ])
    expect(JSON.stringify(projected.schemas[WORLD_KEY])).not.toContain('storytellerMode')
  })

  test('unrelated surface roots stay invisible and opt-in augment fields surface generically', () => {
    const f = setup()
    const info = unwrap(
      f.schema.define(
        ['info'],
        s.struct({ banner: s.str().default('top').meta({ visibility: 'surface' }) }),
      ),
    )
    stagedSetup(f, 10)
    const alice = f.path('character', 'alice')
    const published = f.commit('write an unrelated surface root', (tx) => {
      tx.set(info, { banner: 'top' })
    })

    expect(
      unwrap(f.perspective.projectView(published.id, alice)).mergedInstances.info,
    ).toBeUndefined()

    const extended = unwrap(
      f.schema.augment(f.worldModel.lenses.world, {
        weatherSummary: s.str().default('calm').meta({ visibility: 'surface' }),
        epochLabel: s.str().default('dawn').meta({ visibility: 'surface', globalSurface: true }),
      }),
    )
    unwrap(f.schema.syncSchema({ head: 'main' }))
    const augmented = f.commit('write augmented world fields', (tx) => {
      tx.patch(extended, { weatherSummary: 'rain', epochLabel: 'dusk' })
    })

    expect(worldFieldNames(f, augmented.id, alice)).toEqual([
      'clock',
      'epochLabel',
      'timeAnchorLabel',
    ])
    expect(worldInstance(f, augmented.id, alice)?.fields.weatherSummary).toBe(undefined)
    expect(worldInstance(f, augmented.id, alice)?.fields.epochLabel?.value).toBe('dusk')
  })

  test('off-stage bodies, organisation entities and named perspectives are denied', () => {
    const f = setup()
    seedBase(f, 7)
    const seeded = f.commit('materialize off-stage and abstract observers', (tx) => {
      tx.set(f.worldModel.lenses.characters.at('ghost'), { name: 'Ghost' })
      tx.set(f.worldModel.lenses.organizations.at('guild'), { name: 'Guild' })
      unwrap(f.perspective.configurePerspective(tx, f.path('character', 'ghost'), {}))
      unwrap(f.perspective.configurePerspective(tx, f.path('organization', 'guild'), {}))
      unwrap(f.perspective.configurePerspective(tx, 'org:absent', {}))
    })

    for (const observer of [
      f.path('character', 'ghost'),
      f.path('organization', 'guild'),
      'org:absent',
    ]) {
      expect(worldInstance(f, seeded.id, observer)).toBe(undefined)
      expectNotAuthorized(f, seeded.id, observer, CLOCK_PATH)
    }
  })

  test('exclusions and hallucinations fold normally and never enter scenePublic', () => {
    const f = setup()
    const seeded = stagedSetup(f, 10)
    const room = f.path('location', 'room')
    const alice = f.path('character', 'alice')
    const bob = f.path('character', 'bob')

    const rawScene = unwrap(f.perspective.projectScopePublic(seeded.id, room))
    expect(rawScene.instances[WORLD_KEY]).toBe(undefined)
    const sharedScene = unwrap(f.perspective.projectView(seeded.id, alice)).scenePublic
    expect(sharedScene).toEqual(unwrap(f.perspective.projectView(seeded.id, bob)).scenePublic)
    expect(sharedScene).toEqual(some(rawScene))

    const rumored = f.commit('hallucinate the clock', (tx) => {
      unwrap(
        f.perspective.grantRumor(tx, alice, CLOCK_PATH, 999, {
          priority: 2500,
          override: true,
          belief: 'believed',
        }),
      )
    })
    expect(worldInstance(f, rumored.id, alice)?.fields.clock?.value).toBe(999)
    expect(worldInstance(f, rumored.id, bob)?.fields.clock?.value).toBe(10)

    const aliceScene = unwrap(f.perspective.projectView(rumored.id, alice)).scenePublic
    expect(aliceScene).toEqual(unwrap(f.perspective.projectView(rumored.id, bob)).scenePublic)
    expect(aliceScene).toEqual(some(unwrap(f.perspective.projectScopePublic(rumored.id, room))))
    expect(JSON.stringify(aliceScene)).not.toContain('999')

    const excluded = f.commit('exclude the clock', (tx) => {
      unwrap(f.perspective.excludeKnowledge(tx, alice, CLOCK_PATH, { priority: 3000 }))
    })
    expect(worldFieldNames(f, excluded.id, alice)).toEqual(['timeAnchorLabel'])
    expectNotAuthorized(f, excluded.id, alice, CLOCK_PATH)
    expect(worldInstance(f, excluded.id, bob)?.fields.clock?.value).toBe(10)
  })

  test('runtime field and root visibility overrides hide the feed', () => {
    const f = setup()
    stagedSetup(f, 10)
    const alice = f.path('character', 'alice')
    const clock = f.worldModel.lenses.world.field('clock')
    const fieldHidden = f.commit('hide the clock leaf at runtime', (tx) => {
      tx.setWithMeta(clock, 10, { visibility: 'ref' })
    })

    expect(worldFieldNames(f, fieldHidden.id, alice)).toEqual(['timeAnchorLabel'])
    expectNotAuthorized(f, fieldHidden.id, alice, CLOCK_PATH)

    const rootHidden = f.commit('hide the world root at runtime', (tx) => {
      tx.setInstanceMeta(f.worldModel.lenses.world, { visibility: 'ref' })
    })
    expect(worldInstance(f, rootHidden.id, alice)).toBe(undefined)
    expectNotAuthorized(f, rootHidden.id, alice, ANCHOR_PATH)
  })

  test('branches and manual rewinds read their own commit clock', () => {
    const f = setup()
    const seeded = stagedSetup(f, 10)
    const alice = f.path('character', 'alice')
    const advanced = f.commit('advance the main clock', (tx) => {
      tx.patch(f.worldModel.lenses.world, { clock: 40 })
    })
    const branch = unwrap(
      f.schema.commit(
        {
          parentId: some(seeded.id),
          message: f.worldModel.messages.manualEdit.create({ summary: 'branch rewind' }),
        },
        (tx) => {
          tx.patch(f.worldModel.lenses.world, { clock: 3 })
        },
      ),
    )
    expect(worldInstance(f, branch.id, alice)?.fields.clock?.value).toBe(3)
    expect(worldInstance(f, advanced.id, alice)?.fields.clock?.value).toBe(40)

    const rewound = f.commit(
      f.worldModel.messages.manualEdit.create({ summary: 'main rewind' }),
      (tx) => {
        tx.patch(f.worldModel.lenses.world, { clock: 2 })
      },
    )
    expect(worldInstance(f, rewound.id, alice)?.fields.clock?.value).toBe(2)
    expect(worldInstance(f, advanced.id, alice)?.fields.clock?.value).toBe(40)
  })
})
