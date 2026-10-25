import { afterEach, describe, expect, test } from 'bun:test'
import type { Result } from '@sekaisen/core'
import { some } from '@sekaisen/core'
import type { CarryOverResult, PerspectiveError } from '@sekaisen/plugin-perspective'
import type { HistoricalNodeInspection, HistoricalStructInspection } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef } from '@sekaisen/plugin-world'
import { decodePathKey, encodePathKey } from '@sekaisen/plugin-world'
import {
  claimMember,
  fromCommit,
  PerspectiveFixture,
  present,
  unwrap,
} from './perspective-fixture.ts'

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

function memoryPath(rootId: string, memoryId: string): Path {
  return ['perspectives', rootId, 'memories', memoryId]
}

function memoryIds(f: PerspectiveFixture, commitId: CommitHash, rootId: string): string[] {
  const node = nodeAt(f, commitId, ['perspectives', rootId, 'memories'])
  if (node.nodeKind !== 'map') throw new Error('Expected memories map')
  return Object.keys(node.entries).sort()
}

function stateRef(node: HistoricalStructInspection, field: string): StateRef {
  return claimMember(node, field) as StateRef
}

describe('cross-timeline carry-over', () => {
  test('carries personal claims and memories with historical refs, remapped children and local sequences', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const noteText = [...f.at('note').path, 'text']
    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'source branch'), (tx) => {
        unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), noteText))
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'ambush',
            content: 'Elsa ambushed us in the room.',
            summary: 'Ambush remembered',
          }),
        )
        unwrap(
          f.perspective.summarizeMemories(tx, f.at('alice'), {
            id: 'lesson',
            level: 'L1',
            childMemoryIds: ['ambush'],
            content: 'Always check the room before resting.',
          }),
        )
      }),
    )
    let carried: Result<CarryOverResult, PerspectiveError> | undefined
    const target = unwrap(
      f.schema.commit(
        { parentId: some(seed.id), message: 'carry memories across worlds' },
        (tx) => {
          carried = f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
          })
          expect(carried.ok).toBe(true)
        },
      ),
    )
    if (carried === undefined || !carried.ok) throw new Error('Expected a successful carry-over')
    const result = carried.value
    expect(result.rootPerspectiveId).toBe(rootId)
    expect(result.sourceCommitId).toBe(source.id)
    expect(result.memoryIdMap).toEqual({ ambush: 'ambush', lesson: 'lesson' })
    expect(result.allocatedSeqRange[0]).toBe(1)
    expect(result.allocatedSeqRange[1] - result.allocatedSeqRange[0] + 1).toBe(
      result.carriedClaimKeys.length + result.carriedMemoryPaths.length,
    )
    expect(memoryIds(f, target.id, rootId)).toEqual(['ambush', 'lesson'])
    expect(result.carriedClaimKeys.length).toBeGreaterThan(0)

    const carriedMemory = structAt(f, target.id, memoryPath(rootId, 'ambush'))
    expect(claimMember(carriedMemory, 'ownerPerspectiveId')).toBe(rootId)
    expect(claimMember(carriedMemory, 'content')).toBe('Elsa ambushed us in the room.')
    const acquiredAt = stateRef(carriedMemory, 'acquiredAtRef')
    expect(acquiredAt.commitId).toBe(target.id)
    const factEvent = stateRef(carriedMemory, 'factEventRef')
    expect(factEvent.commitId).toBe(source.id)
    const origin = stateRef(carriedMemory, 'originRef')
    expect(origin.commitId).toBe(source.id)
    expect(origin.path).toEqual(memoryPath(rootId, 'ambush'))

    const summary = structAt(f, target.id, memoryPath(rootId, 'lesson'))
    expect(claimMember(summary, 'children')).toEqual([encodePathKey(memoryPath(rootId, 'ambush'))])
    const childSeq = claimMember(carriedMemory, 'seq') as number
    expect(childSeq).toBeLessThan(claimMember(summary, 'seq') as number)

    const firstClaimPath = decodePathKey(result.carriedClaimKeys[0]!)
    expect(nodeAt(f, target.id, firstClaimPath)).toBeDefined()

    const tree = unwrap(f.perspective.inspectCognitiveMemoryTree(target.id, f.at('alice')))
    expect(tree.map((node) => node.memoryId)).toEqual(['lesson'])
    expect(tree[0]?.subsumedChildren.map((node) => node.memoryId)).toEqual(['ambush'])
  })

  test('does not resurrect an excluded source memory and preserves the exclusion', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'remember a secret'), (tx) => {
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'secret',
            content: 'A secret I later chose to forget.',
          }),
        )
      }),
    )
    const forgotten = unwrap(
      f.schema.commit(fromCommit(source.id, 'forget the secret'), (tx) => {
        unwrap(f.perspective.forgetMemory(tx, f.at('alice'), 'secret', 'exclude'))
      }),
    )
    let carried: Result<CarryOverResult, PerspectiveError> | undefined
    const target = unwrap(
      f.schema.commit(
        { parentId: some(seed.id), message: 'carry forgetting across worlds' },
        (tx) => {
          carried = f.perspective.carryOver(tx, {
            sourceCommitId: forgotten.id,
            observer: f.at('alice'),
          })
          expect(carried.ok).toBe(true)
        },
      ),
    )
    if (carried === undefined || !carried.ok) throw new Error('Expected a successful carry-over')
    expect(carried.value.carriedMemoryPaths).toEqual([])
    expect(memoryIds(f, target.id, rootId)).toEqual([])
    expect(carried.value.carriedClaimKeys).toHaveLength(1)
    const exclusionPath = decodePathKey(carried.value.carriedClaimKeys[0]!)
    const exclusion = structAt(f, target.id, exclusionPath)
    expect(claimMember(exclusion, 'targetPathKey')).toBe(
      encodePathKey(memoryPath(rootId, 'secret')),
    )
    expect(unwrap(f.perspective.inspectCognitiveMemoryTree(target.id, f.at('alice')))).toEqual([])
  })

  test('rejects target id collisions without overwriting or carrying claims', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'source loop'), (tx) => {
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'loop',
            content: 'Source loop memory.',
          }),
        )
      }),
    )
    const targetBase = unwrap(
      f.schema.commit({ parentId: some(seed.id), message: 'target already remembers' }, (tx) => {
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'loop',
            content: 'Target loop memory.',
          }),
        )
      }),
    )
    const target = unwrap(
      f.schema.commit(
        { parentId: some(targetBase.id), message: 'collision must not overwrite' },
        (tx) => {
          const carried = f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
          })
          expect(carried.ok).toBe(false)
          if (!carried.ok && carried.error.kind !== 'memory_conflict')
            throw new Error(`Expected memory_conflict, received ${carried.error.kind}`)
        },
      ),
    )
    expect(claimMember(structAt(f, target.id, memoryPath(rootId, 'loop')), 'content')).toBe(
      'Target loop memory.',
    )
    expect(claimMember(structAt(f, target.id, ['perspectives', rootId]), 'nextSeq')).toBe(2)
  })

  test('reconnects a non-carried child only through an explicit existing mapping', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'source summary'), (tx) => {
        const baby = unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'baby',
            content: 'A small detail.',
          }),
        )
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'parent',
            level: 'L1',
            content: 'A summary of the detail.',
            children: [baby],
          }),
        )
      }),
    )
    const targetBase = unwrap(
      f.schema.commit(
        { parentId: some(seed.id), message: 'target already holds a child' },
        (tx) => {
          unwrap(
            f.perspective.createMemory(tx, f.at('alice'), {
              id: 'existing',
              content: 'Already present on the target branch.',
            }),
          )
        },
      ),
    )
    const target = unwrap(
      f.schema.commit(
        { parentId: some(targetBase.id), message: 'carry with explicit child mapping' },
        (tx) => {
          const carried = f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
            memoryIds: ['parent'],
            existingChildMemoryMap: { baby: 'existing' },
          })
          expect(carried.ok).toBe(true)
          if (carried.ok) expect(carried.value.memoryIdMap).toEqual({ parent: 'parent' })
        },
      ),
    )
    expect(memoryIds(f, target.id, rootId)).toEqual(['existing', 'parent'])
    const parent = structAt(f, target.id, memoryPath(rootId, 'parent'))
    expect(claimMember(parent, 'children')).toEqual([encodePathKey(memoryPath(rootId, 'existing'))])
    const tree = unwrap(f.perspective.inspectCognitiveMemoryTree(target.id, f.at('alice')))
    expect(tree.map((node) => node.memoryId)).toEqual(['parent'])
    expect(tree[0]?.subsumedChildren.map((node) => node.memoryId)).toEqual(['existing'])
  })

  test('rolls back target perspective materialization when child remapping fails', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('note')
    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'materialize a note mind'), (tx) => {
        const child = unwrap(
          f.perspective.createMemory(tx, f.at('note'), {
            id: 'detail',
            content: 'A detail written in the margin.',
          }),
        )
        unwrap(
          f.perspective.createMemory(tx, f.at('note'), {
            id: 'marginalia',
            level: 'L1',
            content: 'Notes about the margin.',
            children: [child],
          }),
        )
      }),
    )
    const target = unwrap(
      f.schema.commit(
        { parentId: some(seed.id), message: 'failed carry must not materialize a mind' },
        (tx) => {
          const carried = f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('note'),
            memoryIds: ['marginalia'],
            existingChildMemoryMap: { detail: 'not_present' },
          })
          expect(carried.ok).toBe(false)
          if (!carried.ok && carried.error.kind !== 'memory_conflict')
            throw new Error(`Expected memory_conflict, received ${carried.error.kind}`)
        },
      ),
    )
    expect(unwrap(f.schema.inspectInstance(target.id, ['perspectives', rootId])).kind).toBe('none')
  })

  test('reacquires known discoveries and preserves independent surviving accounts across branches', () => {
    const f = setup()
    const initial = f.seed('remote', 'remote')
    const known = unwrap(
      f.schema.commit(fromCommit(initial.id, 'already know the note'), (tx) => {
        unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').path))
      }),
    )
    const text = [...f.at('note').path, 'text']
    const source = unwrap(
      f.schema.commit(fromCommit(known.id, 'two independent accounts'), (tx) => {
        unwrap(f.perspective.grantRumor(tx, f.at('alice'), text, 'first account'))
        unwrap(f.perspective.grantRumor(tx, f.at('alice'), text, 'second account'))
      }),
    )
    const before = unwrap(f.perspective.inspect(source.id, f.at('alice'), [text]))
    const target = unwrap(
      f.schema.commit(fromCommit(known.id, 'carry all surviving accounts'), (tx) => {
        unwrap(f.perspective.carryOver(tx, { sourceCommitId: source.id, observer: f.at('alice') }))
      }),
    )
    const after = unwrap(f.perspective.inspect(target.id, f.at('alice'), [text]))
    expect(after[0]?.value).toBe('second account')
    expect(after[0]?.additionalFacets.map((facet) => facet.value)).toEqual(
      before[0]?.additionalFacets.map((facet) => facet.value),
    )
    expect(after[0]?.additionalFacets.map((facet) => facet.value)).toContain('first account')
    expect(
      unwrap(f.perspective.projectView(target.id, f.at('alice'))).mergedInstances[
        encodePathKey(f.at('note').path)
      ],
    ).toBeDefined()
  })

  test('does not mistake an inherited winning record for a personal record with the same map key', () => {
    const f = setup()
    const base = f.seed('remote', 'remote')
    const text = [...f.at('note').path, 'text']
    const source = unwrap(
      f.schema.commit(fromCommit(base.id, 'organisation overrides personal account'), (tx) => {
        unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: ['org'] }))
        unwrap(f.perspective.grantRumor(tx, f.at('alice'), text, 'personal account'))
        unwrap(
          f.perspective.grantRumor(tx, 'org', text, 'organisation account', {
            priority: 3000,
            override: true,
          }),
        )
      }),
    )
    expect(unwrap(f.perspective.inspect(source.id, f.at('alice'), [text]))[0]?.value).toBe(
      'organisation account',
    )
    const target = unwrap(
      f.schema.commit(fromCommit(base.id, 'carry personal acquisitions only'), (tx) => {
        const carried = unwrap(
          f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
          }),
        )
        expect(carried.carriedClaimKeys).toEqual([])
      }),
    )
    expect(
      unwrap(f.perspective.listSearchableCorpus(target.id, f.at('alice'))).some(
        (entry) => encodePathKey(entry.path) === encodePathKey(text),
      ),
    ).toBe(false)
  })
})
