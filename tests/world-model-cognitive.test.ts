import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { SchemaError, TypedCommitMessage } from '@sekaisen/plugin-schema'
import type { CommitHash, CommitNode, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { entityKey as key, seedBase, unwrap, WorldModelFixture } from './world-model-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function setup(): WorldModelFixture {
  const fixture = new WorldModelFixture()
  drivers.push(fixture.driver)
  return fixture
}

function expectRejected(result: Result<CommitNode, SchemaError>, reason: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  if (result.error.kind !== 'validator_rejected')
    throw new Error(`Expected validator rejection, got ${JSON.stringify(result.error)}`)
  expect(result.error.reason).toBe(reason)
}

function memoryPath(rootId: string, memoryId: string): Path {
  return Object.freeze(['perspectives', rootId, 'memories', memoryId])
}

describe('cognitive cross-checks', () => {
  test('relation milestones must belong to the from perspective', () => {
    const f = setup()
    seedBase(f)
    const alice = f.path('character', 'alice')
    const bob = f.path('character', 'bob')
    const memories = f.commit('seed cognitive memories', (tx) => {
      tx.set(f.worldModel.lenses.characters.at('bob'), { name: 'Bob' })
      unwrap(f.perspective.createMemory(tx, alice, { id: 'alice_mem', content: 'Alice remembers' }))
      unwrap(f.perspective.createMemory(tx, bob, { id: 'bob_mem', content: 'Bob remembers' }))
    })
    const aliceRoot = unwrap(f.perspective.resolveRootPerspective(memories.id, alice))
    const bobRoot = unwrap(f.perspective.resolveRootPerspective(memories.id, bob))
    expectRejected(
      f.schema.commit({ head: 'main', message: 'foreign milestone' }, (tx) => {
        tx.set(f.worldModel.lenses.relations.at('bad'), {
          from: key('character', 'alice'),
          to: key('character', 'bob'),
          milestones: [encodePathKey(memoryPath(bobRoot, 'bob_mem'))],
        })
      }),
      'invalid_relation_milestone_owner',
    )
    f.commit('owned milestone', (tx) => {
      tx.set(f.worldModel.lenses.relations.at('good'), {
        from: key('character', 'alice'),
        to: key('character', 'bob'),
        milestones: [encodePathKey(memoryPath(aliceRoot, 'alice_mem'))],
      })
    })
  })

  test('memory_archive audits created summaries and freezes objective writes', () => {
    const f = setup()
    seedBase(f)
    const alice = f.path('character', 'alice')
    const memories = f.commit('seed summary inputs', (tx) => {
      for (const id of ['m1', 'm2', 'm3', 'm4'])
        unwrap(f.perspective.createMemory(tx, alice, { id, content: `memory ${id}` }))
    })
    const root = unwrap(f.perspective.resolveRootPerspective(memories.id, alice))
    const summaryPath = memoryPath(root, 'summary_1')
    const archive = f.worldModel.messages.memoryArchive.create({
      archiveLevel: 'L1',
      perspectiveIds: [root],
      createdMemoryKeys: [encodePathKey(summaryPath)],
      summary: 'summarise first pair',
    })
    const archived = f.commit(archive, (tx) => {
      unwrap(
        f.perspective.summarizeMemories(tx, alice, {
          id: 'summary_1',
          level: 'L1',
          childMemoryIds: ['m1', 'm2'],
          content: 'pair summary',
          archiveChildrenTier: false,
        }),
      )
    })
    const tree = unwrap(f.worldModel.inspectCognitiveMemoryTree(archived.id, alice))
    const summary = tree.find((node) => node.memoryId === 'summary_1')
    expect(summary?.level).toBe('L1')
    expect(summary?.subsumedChildren.length).toBe(2)

    const emptyAudit = f.worldModel.messages.memoryArchive.create({
      archiveLevel: 'L1',
      perspectiveIds: [root],
      createdMemoryKeys: [],
      summary: 'hidden summary',
    })
    expectRejected(
      f.schema.commit({ head: 'main', message: emptyAudit }, (tx) => {
        unwrap(
          f.perspective.summarizeMemories(tx, alice, {
            id: 'summary_bad',
            level: 'L1',
            childMemoryIds: ['m3', 'm4'],
            content: 'unaudited summary',
            archiveChildrenTier: false,
          }),
        )
      }),
      'invalid_memory_archive_commit',
    )
    expect(unwrap(f.schema.inspectInstance(f.head(), memoryPath(root, 'summary_bad')))).toEqual(
      NONE,
    )

    expectRejected(
      f.schema.commit({ head: 'main', message: emptyAudit }, (tx) => {
        tx.set(f.worldModel.lenses.items.at('contraband'), { name: 'Contraband' })
      }),
      'invalid_memory_archive_commit',
    )
  })

  test('carry_over_patch validates new memories, claims and carried item paths', () => {
    const f = setup()
    const seed = seedBase(f)
    const alice = f.path('character', 'alice')
    const source = f.commit('seed carried memory', (tx) => {
      unwrap(f.perspective.createMemory(tx, alice, { id: 'm1', content: 'carried memory' }))
    })
    const root = unwrap(f.perspective.resolveRootPerspective(source.id, alice))

    const options: {
      readonly parentId: Option<CommitHash>
      message: TypedCommitMessage | string
    } = { parentId: some(seed.id), message: 'carry placeholder' }
    const carried = unwrap(
      f.schema.commit(options, (tx) => {
        const result = unwrap(
          f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: alice,
            memoryIds: ['m1'],
            mapMemoryId: (oldMemoryId) => `carried_${oldMemoryId}`,
          }),
        )
        options.message = f.worldModel.messages.carryOverPatch.create({
          sourceCommitId: source.id,
          rewindTargetCommitId: seed.id,
          carriedPerspectiveIds: [result.rootPerspectiveId],
          carriedMemoryKeys: result.carriedMemoryPaths.map(encodePathKey),
          carriedClaimKeys: result.carriedClaimKeys,
          summary: 'carry memory',
        })
      }),
    )
    const carriedTree = unwrap(f.worldModel.inspectCognitiveMemoryTree(carried.id, alice))
    expect(carriedTree.some((node) => node.memoryId === 'carried_m1')).toBe(true)
    expect(root.length).toBeGreaterThan(0)

    const hiddenOptions: {
      readonly parentId: Option<CommitHash>
      message: TypedCommitMessage | string
    } = { parentId: some(seed.id), message: 'carry placeholder' }
    const hidden = f.schema.commit(hiddenOptions, (tx) => {
      const result = unwrap(
        f.perspective.carryOver(tx, {
          sourceCommitId: source.id,
          observer: alice,
          memoryIds: ['m1'],
          mapMemoryId: (oldMemoryId) => `hidden_${oldMemoryId}`,
        }),
      )
      hiddenOptions.message = f.worldModel.messages.carryOverPatch.create({
        sourceCommitId: source.id,
        rewindTargetCommitId: seed.id,
        carriedPerspectiveIds: [result.rootPerspectiveId],
        carriedMemoryKeys: [],
        carriedClaimKeys: result.carriedClaimKeys,
        summary: 'hide carried memory',
      })
    })
    expectRejected(hidden, 'invalid_carry_over_commit')
    expect(f.world.getHead('carry_hidden')).toEqual(NONE)

    const whitelistOptions: {
      readonly parentId: Option<CommitHash>
      message: TypedCommitMessage | string
    } = { parentId: some(seed.id), message: 'carry placeholder' }
    const whitelist = f.schema.commit(whitelistOptions, (tx) => {
      const result = unwrap(
        f.perspective.carryOver(tx, {
          sourceCommitId: source.id,
          observer: alice,
          memoryIds: ['m1'],
          mapMemoryId: (oldMemoryId) => `whitelist_${oldMemoryId}`,
        }),
      )
      whitelistOptions.message = f.worldModel.messages.carryOverPatch.create({
        sourceCommitId: source.id,
        rewindTargetCommitId: seed.id,
        carriedPerspectiveIds: [result.rootPerspectiveId],
        carriedMemoryKeys: result.carriedMemoryPaths.map(encodePathKey),
        carriedClaimKeys: result.carriedClaimKeys,
        carriedItemKeys: [encodePathKey(alice)],
        summary: 'whitelist a character as an item',
      })
    })
    expectRejected(whitelist, 'invalid_carry_over_commit')
    expect(f.world.getHead('carry_whitelist')).toEqual(NONE)
  })

  test('reacquires an existing discovered entity without copying objective entities', () => {
    const f = setup()
    seedBase(f)
    const alice = f.path('character', 'alice')
    const item = f.path('item', 'locket')
    const target = f.commit('target already knows the locket', (tx) => {
      tx.set(f.worldModel.lenses.items.at('locket'), { name: 'Locket' })
      unwrap(f.perspective.grantKnowledge(tx, alice, item))
    })
    const source = f.commit('source remembers the locket', (tx) => {
      unwrap(f.perspective.createMemory(tx, alice, { id: 'm1', content: 'the locket' }))
    })
    const aliceRoot = unwrap(f.perspective.resolveRootPerspective(source.id, alice))
    const options: {
      readonly parentId: Option<CommitHash>
      message: TypedCommitMessage | string
    } = { parentId: some(target.id), message: 'carry placeholder' }
    const carried = unwrap(
      f.schema.commit(options, (tx) => {
        const result = unwrap(
          f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: alice,
            memoryIds: ['m1'],
            mapMemoryId: (oldMemoryId) => `known_${oldMemoryId}`,
          }),
        )
        options.message = f.worldModel.messages.carryOverPatch.create({
          sourceCommitId: source.id,
          rewindTargetCommitId: target.id,
          carriedPerspectiveIds: [result.rootPerspectiveId],
          carriedMemoryKeys: result.carriedMemoryPaths.map(encodePathKey),
          carriedClaimKeys: result.carriedClaimKeys,
          summary: 'carry known discovery',
        })
      }),
    )
    const discoveryPath = Object.freeze([
      'perspectives',
      aliceRoot,
      'discoveredEntities',
      encodePathKey(item),
    ])
    expect(unwrap(f.schema.inspectInstance(carried.id, discoveryPath)).kind).toBe('some')
    expect(unwrap(f.schema.get(carried.id, f.worldModel.lenses.items.at('locket')))).not.toEqual(
      NONE,
    )
  })
})
