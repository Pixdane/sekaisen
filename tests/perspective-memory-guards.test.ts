import { afterEach, describe, expect, test } from 'bun:test'
import { some } from '@sekaisen/core'
import type { HistoricalNodeInspection, HistoricalStructInspection } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import { claimMember, PerspectiveFixture, present, unwrap } from './perspective-fixture.ts'

const fixtures: PerspectiveFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.driver.close()
})

function setup() {
  const fixture = new PerspectiveFixture()
  fixtures.push(fixture)
  return fixture
}

function nodeAt(f: PerspectiveFixture, commitId: CommitHash, path: Path): HistoricalNodeInspection {
  return present(unwrap(f.schema.inspectInstance(commitId, path)))
}

function structAt(
  f: PerspectiveFixture,
  commitId: CommitHash,
  path: Path,
): HistoricalStructInspection {
  const node = nodeAt(f, commitId, path)
  if (node.nodeKind !== 'struct') throw new Error('Expected a struct node')
  return node
}

function memoryPath(f: PerspectiveFixture, observer: 'alice' | 'bob', memoryId: string): Path {
  return ['perspectives', f.key(observer), 'memories', memoryId]
}

/** Seed one Alice memory carrying narrative metadata and two associations. */
function seedSourceMemory(f: PerspectiveFixture) {
  f.seed()
  const memory = memoryPath(f, 'alice', 'ambush')
  const noteRef: StateRef = { commitId: SELF_COMMIT, path: f.at('note').path }
  const roomRef: StateRef = { commitId: SELF_COMMIT, path: f.at('room').path }
  const seeded = f.commit('record a memory with associations', (tx) => {
    unwrap(
      f.perspective.createMemory(tx, f.at('alice'), {
        id: 'ambush',
        content: 'ALICE_NARRATIVE',
        summary: 'ambush summary',
        tier: 'pinned',
        strength: 7,
        relatedEntities: {
          subject: { targetRef: noteRef, role: 'subject' },
          location: { targetRef: roomRef, role: 'location' },
        },
      }),
    )
  })
  return { memory, seeded, noteRef, roomRef }
}

function relatedEntries(
  f: PerspectiveFixture,
  commitId: CommitHash,
  memory: Path,
): Readonly<Record<string, HistoricalNodeInspection>> {
  const node = nodeAt(f, commitId, [...memory, 'relatedEntities'])
  if (node.nodeKind !== 'map') throw new Error('Expected a relatedEntities map')
  return node.entries
}

function relatedStructAt(
  f: PerspectiveFixture,
  commitId: CommitHash,
  memory: Path,
  slot: string,
): HistoricalStructInspection {
  const node = nodeAt(f, commitId, [...memory, 'relatedEntities', slot])
  if (node.nodeKind !== 'struct') throw new Error('Expected a related entity struct')
  return node
}

describe('cognitive memory final-draft raw guards', () => {
  test('rejects forged enum strings instead of decoding them to fallbacks', () => {
    const f = setup()
    f.seed()
    const memory = memoryPath(f, 'alice', 'guarded')
    const seeded = f.commit('create a guarded memory', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'guarded',
          content: 'GUARDED_NARRATIVE',
        }),
      )
    })
    const forgeries: readonly (readonly [string, string])[] = [
      ['level', 'L9'],
      ['eventOrigin', 'dream'],
      ['significance', 'epic'],
      ['tier', 'forever'],
      ['belief', 'unknown'],
    ]
    for (const [field, value] of forgeries) {
      const rejected = f.schema.commit(
        { parentId: some(seeded.id), message: `forge ${field}` },
        (tx) => {
          const lens = unwrap(tx.lensAt([...memory, field]))
          if (lens.opticKind !== 'field') throw new Error(`Expected a ${field} leaf`)
          tx.set(lens, value)
        },
      )
      expect(rejected.ok).toBe(false)
      if (!rejected.ok && rejected.error.kind === 'validator_rejected')
        expect(rejected.error.reason).toBe('invalid_memory_level')
    }
  })

  test('rejects forged metrics and undecodable child links from raw storage', () => {
    const f = setup()
    f.seed()
    const memory = memoryPath(f, 'alice', 'measured')
    const seeded = f.commit('create a measured memory', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'measured',
          content: 'MEASURED_NARRATIVE',
        }),
      )
    })
    const negativeStrength = f.schema.commit(
      { parentId: some(seeded.id), message: 'forge a negative strength' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...memory, 'strength']))
        if (lens.opticKind !== 'field') throw new Error('Expected a strength leaf')
        tx.set(lens, -1)
      },
    )
    expect(negativeStrength.ok).toBe(false)
    if (!negativeStrength.ok && negativeStrength.error.kind === 'validator_rejected')
      expect(negativeStrength.error.reason).toBe('invalid_memory_metrics')

    const malformedChild = f.schema.commit(
      { parentId: some(seeded.id), message: 'forge an undecodable child link' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...memory, 'children']))
        if (lens.opticKind !== 'field') throw new Error('Expected a children leaf')
        tx.set(lens, [encodePathKey(['perspectives', f.key('alice')])])
      },
    )
    expect(malformedChild.ok).toBe(false)
    if (!malformedChild.ok && malformedChild.error.kind === 'validator_rejected')
      expect(malformedChild.error.reason).toBe('invalid_memory_child_target')
  })

  test('rejects a forged child level instead of ranking its decoded fallback', () => {
    const f = setup()
    f.seed()
    const detail = memoryPath(f, 'alice', 'detail')
    const seeded = f.commit('record and summarize a detail', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'detail',
          content: 'DETAIL_NARRATIVE',
        }),
      )
      unwrap(
        f.perspective.summarizeMemories(tx, f.at('alice'), {
          id: 'summary',
          level: 'L1',
          childMemoryIds: ['detail'],
          content: 'SUMMARY_NARRATIVE',
        }),
      )
    })
    const rejected = f.schema.commit(
      { parentId: some(seeded.id), message: 'forge the child level' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...detail, 'level']))
        if (lens.opticKind !== 'field') throw new Error('Expected a level leaf')
        tx.set(lens, 'L9')
      },
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok && rejected.error.kind === 'validator_rejected')
      expect(rejected.error.reason).toBe('invalid_memory_level')
  })
})

describe('cognitive memory propagation field exclusions', () => {
  test('copies the visible narrative and associations for an unexcluded sender', () => {
    const f = setup()
    const { seeded } = seedSourceMemory(f)
    const propagated = f.commit('retell the memory', (tx) => {
      unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush'))
    })
    const target = memoryPath(f, 'bob', 'ambush')
    expect(claimMember(structAt(f, propagated.id, target), 'content')).toBe('ALICE_NARRATIVE')
    const entries = relatedEntries(f, propagated.id, target)
    expect(Object.keys(entries).sort()).toEqual(['location', 'subject'])
    expect(claimMember(relatedStructAt(f, propagated.id, target, 'subject'), 'role')).toBe(
      'subject',
    )
    expect(seeded.id).toBeDefined()
  })

  test('refuses to propagate when only the narrative field is excluded', () => {
    const f = setup()
    const { memory } = seedSourceMemory(f)
    const excluded = f.commit('hide the narrative field', (tx) => {
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...memory, 'content']))
    })
    const attempt = unwrap(
      f.schema.commit(
        { parentId: some(excluded.id), message: 'retell a hidden narrative' },
        (tx) => {
          const result = f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush')
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error.kind).toBe('not_authorized')
        },
      ),
    )
    const bobMemories = nodeAt(f, attempt.id, ['perspectives', f.key('bob'), 'memories'])
    expect(bobMemories.nodeKind).toBe('map')
    if (bobMemories.nodeKind === 'map') expect(Object.keys(bobMemories.entries)).toHaveLength(0)
  })

  test('drops the whole relatedEntities map when it is excluded', () => {
    const f = setup()
    const { memory } = seedSourceMemory(f)
    const excluded = f.commit('hide the association map', (tx) => {
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...memory, 'relatedEntities']))
    })
    const propagated = unwrap(
      f.schema.commit(
        { parentId: some(excluded.id), message: 'retell without associations' },
        (tx) => {
          unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush'))
        },
      ),
    )
    const target = memoryPath(f, 'bob', 'ambush')
    expect(claimMember(structAt(f, propagated.id, target), 'content')).toBe('ALICE_NARRATIVE')
    expect(Object.keys(relatedEntries(f, propagated.id, target))).toHaveLength(0)
  })

  test('drops only the excluded association slot', () => {
    const f = setup()
    const { memory } = seedSourceMemory(f)
    const excluded = f.commit('hide the subject slot', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), [
          ...memory,
          'relatedEntities',
          'subject',
        ]),
      )
    })
    const propagated = unwrap(
      f.schema.commit({ parentId: some(excluded.id), message: 'retell the visible slot' }, (tx) => {
        unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush'))
      }),
    )
    const target = memoryPath(f, 'bob', 'ambush')
    expect(Object.keys(relatedEntries(f, propagated.id, target))).toEqual(['location'])
  })

  test('drops an association whose targetRef is excluded', () => {
    const f = setup()
    const { memory } = seedSourceMemory(f)
    const excluded = f.commit('hide the subject coordinate', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), [
          ...memory,
          'relatedEntities',
          'subject',
          'targetRef',
        ]),
      )
    })
    const propagated = unwrap(
      f.schema.commit(
        { parentId: some(excluded.id), message: 'retell visible coordinates' },
        (tx) => {
          unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush'))
        },
      ),
    )
    const target = memoryPath(f, 'bob', 'ambush')
    expect(Object.keys(relatedEntries(f, propagated.id, target))).toEqual(['location'])
  })

  test('uses the documented default role when only the role is excluded', () => {
    const f = setup()
    const { memory, seeded } = seedSourceMemory(f)
    const excluded = f.commit('hide the subject role', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), [
          ...memory,
          'relatedEntities',
          'subject',
          'role',
        ]),
      )
    })
    const propagated = unwrap(
      f.schema.commit({ parentId: some(excluded.id), message: 'retell without the role' }, (tx) => {
        unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush'))
      }),
    )
    const target = memoryPath(f, 'bob', 'ambush')
    const subject = relatedStructAt(f, propagated.id, target, 'subject')
    expect(claimMember(subject, 'role')).toBe('participant')
    expect(claimMember(subject, 'targetRef')).toEqual({
      commitId: seeded.id,
      path: f.at('note').path,
    })
  })

  test('does not leak excluded tier or strength metadata', () => {
    const f = setup()
    const { memory } = seedSourceMemory(f)
    const excluded = f.commit('hide retention metadata', (tx) => {
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...memory, 'tier']))
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...memory, 'strength']))
    })
    const propagated = unwrap(
      f.schema.commit({ parentId: some(excluded.id), message: 'retell safe metadata' }, (tx) => {
        unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush'))
      }),
    )
    const target = memoryPath(f, 'bob', 'ambush')
    const copied = structAt(f, propagated.id, target)
    expect(claimMember(copied, 'tier')).toBe('active')
    expect(claimMember(copied, 'strength')).toBe(1)
    expect(claimMember(copied, 'content')).toBe('ALICE_NARRATIVE')
  })

  test('refuses to propagate when a historical fact reference is excluded', () => {
    const f = setup()
    const { memory } = seedSourceMemory(f)
    const excluded = f.commit('hide the snapshot coordinate', (tx) => {
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...memory, 'factSnapshotRef']))
    })
    const attempt = unwrap(
      f.schema.commit(
        { parentId: some(excluded.id), message: 'retell a hidden snapshot coordinate' },
        (tx) => {
          const result = f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'ambush')
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.error.kind).toBe('not_authorized')
        },
      ),
    )
    const bobMemories = nodeAt(f, attempt.id, ['perspectives', f.key('bob'), 'memories'])
    expect(bobMemories.nodeKind).toBe('map')
    if (bobMemories.nodeKind === 'map') expect(Object.keys(bobMemories.entries)).toHaveLength(0)
  })
})
