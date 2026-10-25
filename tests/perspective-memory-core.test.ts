import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
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

/** Inspect one physical node without giving the scenario an omniscient API. */
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

function memoryPath(f: PerspectiveFixture, memoryId: string): Path {
  return ['perspectives', f.key('alice'), 'memories', memoryId]
}

function summaryMeta(f: PerspectiveFixture, commitId: CommitHash, path: Path): unknown {
  const memory = structAt(f, commitId, path)
  const content = present(memory.fields.content!)
  if (content.nodeKind !== 'leaf') throw new Error('Expected a leaf content field')
  return content.meta.summary
}

describe('cognitive memory lifecycle', () => {
  test('creates, summarizes and persists owner, summary and related-entity coordinates', () => {
    const f = setup()
    f.seed()
    const rootId = f.key('alice')
    const memory = memoryPath(f, 'ambush')
    const summary = memoryPath(f, 'lesson')
    const related = { commitId: SELF_COMMIT, path: f.at('note').path } as StateRef
    const created = f.commit('remember an event and summarize it', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'ambush',
          content: 'I remember the ambush in the room.',
          summary: 'Ambush remembered',
          relatedEntities: { subject: { targetRef: related, role: 'subject' } },
        }),
      )
      unwrap(
        f.perspective.summarizeMemories(tx, f.at('alice'), {
          id: 'lesson',
          level: 'L1',
          childMemoryIds: ['ambush'],
          content: 'Be careful before entering the room.',
        }),
      )
    })

    const stored = structAt(f, created.id, memory)
    expect(claimMember(stored, 'ownerPerspectiveId')).toBe(rootId)
    expect(claimMember(stored, 'seq')).toBe(1)
    expect(claimMember(stored, 'level')).toBe('L0')
    expect(claimMember(stored, 'belief')).toBe('believed')
    expect(claimMember(stored, 'content')).toBe('I remember the ambush in the room.')
    expect(claimMember(stored, 'tier')).toBe('archive')
    expect(summaryMeta(f, created.id, memory)).toBe('Ambush remembered')
    const relatedMap = nodeAt(f, created.id, [...memory, 'relatedEntities'])
    if (relatedMap.nodeKind !== 'map') throw new Error('Expected relatedEntities map')
    const relation = relatedMap.entries.subject
    if (relation?.nodeKind !== 'struct') throw new Error('Expected related entity struct')
    const targetRef = claimMember(relation, 'targetRef') as StateRef
    expect(targetRef.commitId).toBe(created.id)
    expect(targetRef.path).toEqual(f.at('note').path)

    const summaryRecord = structAt(f, created.id, summary)
    expect(claimMember(summaryRecord, 'level')).toBe('L1')
    expect(claimMember(summaryRecord, 'seq')).toBe(2)
    expect(claimMember(summaryRecord, 'children')).toEqual([encodePathKey(memory)])
    expect(claimMember(structAt(f, created.id, ['perspectives', rootId]), 'nextSeq')).toBe(3)

    const tree = unwrap(f.perspective.inspectCognitiveMemoryTree(created.id, f.at('alice')))
    expect(tree).toHaveLength(1)
    expect(tree[0]?.memoryId).toBe('lesson')
    expect(tree[0]?.subsumedChildren[0]?.memoryId).toBe('ambush')
  })

  test('updates content and summary metadata without consuming sequence', () => {
    const f = setup()
    f.seed()
    const rootId = f.key('alice')
    const memory = memoryPath(f, 'note')
    f.commit('remember a note', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'note',
          content: 'first wording',
          summary: 'first summary',
        }),
      )
    })
    const updated = f.commit('revise narrative and summary', (tx) => {
      unwrap(
        f.perspective.updateMemory(tx, f.at('alice'), 'note', {
          content: 'second wording',
          summary: some('second summary'),
          strength: 2,
          tier: 'pinned',
        }),
      )
    })
    expect(summaryMeta(f, updated.id, memory)).toBe('second summary')
    expect(claimMember(structAt(f, updated.id, memory), 'tier')).toBe('pinned')
    expect(claimMember(structAt(f, updated.id, memory), 'strength')).toBe(2)
    expect(claimMember(structAt(f, updated.id, ['perspectives', rootId]), 'nextSeq')).toBe(2)

    const cleared = f.commit('remove the micro summary', (tx) => {
      unwrap(
        f.perspective.updateMemory(tx, f.at('alice'), 'note', {
          summary: NONE,
        }),
      )
    })
    expect(summaryMeta(f, cleared.id, memory)).toBeUndefined()
    expect(claimMember(structAt(f, cleared.id, memory), 'content')).toBe('second wording')
    expect(claimMember(structAt(f, cleared.id, ['perspectives', rootId]), 'nextSeq')).toBe(2)
  })

  test('forgetting evolves tier, belief and exclusions without deleting the record', () => {
    const f = setup()
    f.seed()
    const rootId = f.key('alice')
    const memory = memoryPath(f, 'promise')
    f.commit('remember a promise', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'promise',
          content: 'I promised to return.',
        }),
      )
    })
    const archived = f.commit('archive the promise', (tx) => {
      unwrap(f.perspective.forgetMemory(tx, f.at('alice'), 'promise', 'archive'))
    })
    expect(claimMember(structAt(f, archived.id, memory), 'tier')).toBe('archive')
    const doubted = f.commit('mark the promise false', (tx) => {
      unwrap(f.perspective.forgetMemory(tx, f.at('alice'), 'promise', 'known_false'))
    })
    expect(claimMember(structAt(f, doubted.id, memory), 'belief')).toBe('known_false')
    expect(claimMember(structAt(f, doubted.id, ['perspectives', rootId]), 'nextSeq')).toBe(2)

    const excluded = f.commit('exclude the memory', (tx) => {
      unwrap(f.perspective.forgetMemory(tx, f.at('alice'), 'promise', 'exclude'))
    })
    expect(structAt(f, excluded.id, memory)).toBeDefined()
    expect(claimMember(structAt(f, excluded.id, ['perspectives', rootId]), 'nextSeq')).toBe(3)
    const exclusions = nodeAt(f, excluded.id, ['perspectives', rootId, 'exclusions'])
    if (exclusions.nodeKind !== 'map') throw new Error('Expected exclusions map')
    const entries = Object.values(exclusions.entries)
    expect(entries).toHaveLength(1)
    const exclusion = entries[0]
    if (exclusion?.nodeKind !== 'struct') throw new Error('Expected exclusion struct')
    expect(claimMember(exclusion, 'targetPathKey')).toBe(encodePathKey(memory))
    expect(unwrap(f.perspective.inspectCognitiveMemoryTree(excluded.id, f.at('alice')))).toEqual([])
  })

  test('a failed multi-field update leaves no partial memory state', () => {
    const f = setup()
    f.seed()
    const rootId = f.key('alice')
    const memory = memoryPath(f, 'steady')
    f.commit('create the steady memory', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'steady',
          content: 'A steady recollection.',
        }),
      )
    })
    const failed = f.commit('reject an invalid child list', (tx) => {
      const result = f.perspective.updateMemory(tx, f.at('alice'), 'steady', {
        tier: 'pinned',
        children: [['perspectives', rootId, 'memories', 'missing']],
      })
      expect(result.ok).toBe(false)
    })
    const stored = structAt(f, failed.id, memory)
    expect(claimMember(stored, 'tier')).toBe('active')
    expect(claimMember(structAt(f, failed.id, ['perspectives', rootId]), 'nextSeq')).toBe(2)
  })
})

describe('cognitive memory final-draft validation', () => {
  test('rejects cross-perspective child links, invalid sequences and owner mismatches', () => {
    const f = setup()
    f.seed()
    const bobRoot = f.key('bob')
    const aliceMemory = memoryPath(f, 'foldable')
    const aliceSummary = memoryPath(f, 'top')
    const bobMemory: Path = ['perspectives', bobRoot, 'memories', 'foreign']
    const seeded = f.commit('seed memories for tampering', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'foldable',
          content: 'Alice details',
        }),
      )
      unwrap(
        f.perspective.summarizeMemories(tx, f.at('alice'), {
          id: 'top',
          level: 'L1',
          childMemoryIds: ['foldable'],
          content: 'Alice summary',
        }),
      )
      unwrap(
        f.perspective.createMemory(tx, f.at('bob'), {
          id: 'foreign',
          content: 'Bob details',
        }),
      )
    })
    const crossOwner = f.schema.commit(
      { parentId: some(seeded.id), message: 'tamper child owner' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...aliceSummary, 'children']))
        if (lens.opticKind !== 'field') throw new Error('Expected children field')
        tx.set(lens, [encodePathKey(bobMemory)])
      },
    )
    expect(crossOwner.ok).toBe(false)
    if (!crossOwner.ok) {
      expect(crossOwner.error.kind).toBe('validator_rejected')
      if (crossOwner.error.kind === 'validator_rejected')
        expect(crossOwner.error.reason).toBe('invalid_memory_child_owner')
    }

    const badSeq = f.schema.commit(
      { parentId: some(seeded.id), message: 'tamper sequence' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...aliceMemory, 'seq']))
        if (lens.opticKind !== 'field') throw new Error('Expected seq field')
        tx.set(lens, 99)
      },
    )
    expect(badSeq.ok).toBe(false)
    if (!badSeq.ok && badSeq.error.kind === 'validator_rejected')
      expect(badSeq.error.reason).toBe('invalid_memory_metrics')

    const badOwner = f.schema.commit(
      { parentId: some(seeded.id), message: 'tamper owner' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...aliceMemory, 'ownerPerspectiveId']))
        if (lens.opticKind !== 'field') throw new Error('Expected owner field')
        tx.set(lens, bobRoot)
      },
    )
    expect(badOwner.ok).toBe(false)
    if (!badOwner.ok && badOwner.error.kind === 'validator_rejected')
      expect(badOwner.error.reason).toBe('memory_owner_mismatch')
  })

  test('rejects objective message snapshots even when the reference itself is well formed', () => {
    const f = setup()
    f.seed()
    const aliceMemory = memoryPath(f, 'objective')
    const seeded = f.commit('create memory for snapshot tampering', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'objective',
          content: 'Subjective narrative',
        }),
      )
    })
    const rejected = f.schema.commit(
      { parentId: some(seeded.id), message: 'tamper snapshot ref' },
      (tx) => {
        const lens = unwrap(tx.lensAt([...aliceMemory, 'factSnapshotRef']))
        if (lens.opticKind !== 'field') throw new Error('Expected snapshot ref field')
        tx.set(lens, { commitId: seeded.id, path: ['$message'] })
      },
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok && rejected.error.kind === 'validator_rejected')
      expect(rejected.error.reason).toBe('invalid_memory_refs')
  })
})
