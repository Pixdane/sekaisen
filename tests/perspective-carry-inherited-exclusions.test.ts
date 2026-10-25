import { afterEach, describe, expect, test } from 'bun:test'
import type { Result } from '@sekaisen/core'
import { some } from '@sekaisen/core'
import type { CarryOverResult, PerspectiveError } from '@sekaisen/plugin-perspective'
import type { HistoricalStructInspection } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
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

function setup(): PerspectiveFixture {
  const fixture = new PerspectiveFixture()
  fixtures.push(fixture)
  return fixture
}

function structAt(
  f: PerspectiveFixture,
  commitId: CommitHash,
  path: Path,
): HistoricalStructInspection {
  const node = present(unwrap(f.schema.inspectInstance(commitId, path)))
  if (node.nodeKind !== 'struct') throw new Error(`Expected a struct at ${encodePathKey(path)}`)
  return node
}

function memoryPath(rootId: string, memoryId: string): Path {
  return ['perspectives', rootId, 'memories', memoryId]
}

function memoryIds(f: PerspectiveFixture, commitId: CommitHash, rootId: string): string[] {
  const inspection = unwrap(
    f.schema.inspectInstance(commitId, ['perspectives', rootId, 'memories']),
  )
  if (inspection.kind === 'none') return []
  const node = inspection.value
  if (node.nodeKind !== 'map') throw new Error('Expected the memories map')
  return Object.keys(node.entries).sort()
}

/** Host-side read of stored exclusion records; tests bypass projection only here. */
function exclusionRecords(
  f: PerspectiveFixture,
  commitId: CommitHash,
  rootId: string,
): {
  key: string
  targetPathKey: string
  priority: number
  seq: number
}[] {
  const inspection = unwrap(
    f.schema.inspectInstance(commitId, ['perspectives', rootId, 'exclusions']),
  )
  if (inspection.kind === 'none') return []
  const node = inspection.value
  if (node.nodeKind !== 'map') throw new Error('Expected the exclusions map')
  const records: {
    key: string
    targetPathKey: string
    priority: number
    seq: number
  }[] = []
  for (const [key, entry] of Object.entries(node.entries)) {
    if (entry.nodeKind !== 'struct') throw new Error('Expected an exclusion struct')
    records.push({
      key,
      targetPathKey: claimMember(entry, 'targetPathKey') as string,
      priority: claimMember(entry, 'priority') as number,
      seq: claimMember(entry, 'seq') as number,
    })
  }
  return records.sort((a, b) => a.key.localeCompare(b.key))
}

function exclusionTargets(f: PerspectiveFixture, commitId: CommitHash, rootId: string): string[] {
  return exclusionRecords(f, commitId, rootId)
    .map((record) => record.targetPathKey)
    .sort()
}

function corpusEntry(f: PerspectiveFixture, commitId: CommitHash, observer: string, path: Path) {
  return unwrap(f.perspective.listSearchableCorpus(commitId, f.at(observer))).find(
    (entry) => encodePathKey(entry.path) === encodePathKey(path),
  )
}

describe('carry-over inherits source exclusion protection', () => {
  for (const includeClaims of [false, true]) {
    test(`keeps inherited content, summary and association exclusions effective (includeClaims: ${includeClaims})`, () => {
      const f = setup()
      const seed = f.seed()
      const rootId = f.key('alice')
      const organisation = 'org:carry'
      const noteRef: StateRef = { commitId: seed.id, path: f.at('note').path }
      const aliceRef: StateRef = { commitId: seed.id, path: f.at('alice').path }

      const journalPath = memoryPath(rootId, 'journal')
      const diaryPath = memoryPath(rootId, 'diary')
      const journalContent = [...journalPath, 'content']
      const diaryContent = [...diaryPath, 'content']
      const diarySummary = [...diaryContent, '$meta', 'summary']
      const witnessSlot = [...diaryPath, 'relatedEntities', 'witness']
      const droppedTarget = [...diaryPath, 'relatedEntities', 'dropped', 'targetRef']
      const keptRole = [...diaryPath, 'relatedEntities', 'kept', 'role']
      const unrelated = [...f.at('bob').path, 'name']

      const source = unwrap(
        f.schema.commit(fromCommit(seed.id, 'organisation hides personal narrative'), (tx) => {
          unwrap(
            f.perspective.configurePerspective(tx, f.at('alice'), {
              inherits: [organisation],
            }),
          )
          unwrap(
            f.perspective.createMemory(tx, f.at('alice'), {
              id: 'journal',
              content: 'INHERITED_SECRET',
            }),
          )
          unwrap(
            f.perspective.createMemory(tx, f.at('alice'), {
              id: 'diary',
              content: 'DIARY_VISIBLE',
              summary: 'DIARY_SUMMARY',
              relatedEntities: {
                witness: { targetRef: noteRef, role: 'witness' },
                dropped: { targetRef: noteRef, role: 'informant' },
                kept: { targetRef: aliceRef, role: 'subject' },
              },
            }),
          )
          unwrap(
            f.perspective.createMemory(tx, f.at('alice'), {
              id: 'visible',
              content: 'VISIBLE_NARRATIVE',
              significance: 'notable',
            }),
          )
          unwrap(
            f.perspective.excludeKnowledge(tx, organisation, journalContent, { priority: 5000 }),
          )
          unwrap(f.perspective.excludeKnowledge(tx, organisation, diarySummary, { priority: 5000 }))
          unwrap(f.perspective.excludeKnowledge(tx, organisation, witnessSlot, { priority: 5000 }))
          unwrap(
            f.perspective.excludeKnowledge(tx, organisation, droppedTarget, { priority: 5000 }),
          )
          unwrap(f.perspective.excludeKnowledge(tx, organisation, keptRole, { priority: 5000 }))
          unwrap(f.perspective.excludeKnowledge(tx, organisation, unrelated, { priority: 5000 }))
        }),
      )

      // Ground truth: the inherited view already hides these fields at source.
      expect(corpusEntry(f, source.id, 'alice', journalContent)).toBeUndefined()
      const sourceDiary = corpusEntry(f, source.id, 'alice', diaryContent)
      if (sourceDiary === undefined) throw new Error('Expected the source diary entry')
      expect(sourceDiary.summary.kind).toBe('none')
      expect(sourceDiary.linkedEntities.map((entity) => entity.role)).toEqual(['participant'])

      const base = unwrap(
        f.schema.commit(
          { parentId: some(seed.id), message: 'pre-membership target base' },
          () => {},
        ),
      )

      let carried: Result<CarryOverResult, PerspectiveError> | undefined
      const target = unwrap(
        f.schema.commit(
          fromCommit(base.id, 'carry the organisation-protected narratives'),
          (tx) => {
            carried = f.perspective.carryOver(tx, {
              sourceCommitId: source.id,
              observer: f.at('alice'),
              includeClaims,
              memoryIds: ['journal', 'diary', 'visible'],
              mapMemoryId: (oldMemoryId) => {
                if (oldMemoryId === 'journal') return 'carried_journal'
                if (oldMemoryId === 'diary') return 'carried_diary'
                return oldMemoryId
              },
            })
            expect(carried.ok).toBe(true)
          },
        ),
      )
      if (carried === undefined || !carried.ok) throw new Error('Expected a successful carry-over')
      expect(carried.value.memoryIdMap).toEqual({
        journal: 'carried_journal',
        diary: 'carried_diary',
        visible: 'visible',
      })
      expect(memoryIds(f, target.id, rootId)).toEqual([
        'carried_diary',
        'carried_journal',
        'visible',
      ])

      // Organisation membership itself is never carried; protection is local.
      expect(claimMember(structAt(f, target.id, ['perspectives', rootId]), 'inherits')).toEqual([])

      const carriedJournalPath = memoryPath(rootId, 'carried_journal')
      const carriedDiaryPath = memoryPath(rootId, 'carried_diary')
      const carriedJournalContent = [...carriedJournalPath, 'content']
      const carriedDiaryContent = [...carriedDiaryPath, 'content']
      expect(exclusionTargets(f, target.id, rootId)).toEqual(
        [
          encodePathKey(carriedJournalContent),
          encodePathKey([...carriedDiaryContent, '$meta', 'summary']),
          encodePathKey([...carriedDiaryPath, 'relatedEntities', 'witness']),
          encodePathKey([...carriedDiaryPath, 'relatedEntities', 'dropped', 'targetRef']),
          encodePathKey([...carriedDiaryPath, 'relatedEntities', 'kept', 'role']),
        ].sort(),
      )

      // The exact narrative stays stored privately; only the view is restricted.
      const carriedJournal = structAt(f, target.id, carriedJournalPath)
      expect(claimMember(carriedJournal, 'content')).toBe('INHERITED_SECRET')
      expect(claimMember(carriedJournal, 'level')).toBe('L0')
      const hidden = f.perspective.inspect(target.id, f.at('alice'), [carriedJournalContent])
      expect(hidden.ok).toBe(false)
      if (!hidden.ok) expect(hidden.error.kind).toBe('not_authorized')
      expect(corpusEntry(f, target.id, 'alice', carriedJournalContent)).toBeUndefined()

      const view = unwrap(f.perspective.projectView(target.id, f.at('alice')))
      const journalView = view.privateView.selfInstances[encodePathKey(carriedJournalPath)]
      expect(journalView?.fields.content).toBeUndefined()
      expect(journalView?.fields.level).toBeDefined()

      const carriedDiary = corpusEntry(f, target.id, 'alice', carriedDiaryContent)
      if (carriedDiary === undefined) throw new Error('Expected the carried diary entry')
      expect(carriedDiary.text).toBe('DIARY_VISIBLE')
      expect(carriedDiary.summary.kind).toBe('none')
      expect(carriedDiary.linkedEntities.map((entity) => entity.role)).toEqual(['participant'])
      const diaryView = view.privateView.selfInstances[encodePathKey(carriedDiaryPath)]
      expect(diaryView?.fields.content?.value).toBe('DIARY_VISIBLE')
      expect(diaryView?.fields.content?.summary.kind).toBe('none')
      expect(diaryView?.fields.level).toBeDefined()

      // An unrelated, fully visible memory keeps its narrative and safe metadata.
      const visible = unwrap(
        f.perspective.inspect(target.id, f.at('alice'), [
          [...memoryPath(rootId, 'visible'), 'content'],
        ]),
      )
      expect(visible[0]?.value).toBe('VISIBLE_NARRATIVE')
      const visibleView =
        view.privateView.selfInstances[encodePathKey(memoryPath(rootId, 'visible'))]
      expect(visibleView?.fields.significance?.value).toBe('notable')
    })
  }

  test('copies only inherited exclusions covering selected memories', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const organisation = 'org:scope'
    const selectedPath = memoryPath(rootId, 'selected')
    const skippedPath = memoryPath(rootId, 'skipped')
    const selectedContent = [...selectedPath, 'content']
    const skippedContent = [...skippedPath, 'content']
    const unrelated = [...f.at('bob').path, 'name']

    const source = unwrap(
      f.schema.commit(
        fromCommit(seed.id, 'organisation mixes selected and unrelated rules'),
        (tx) => {
          unwrap(
            f.perspective.configurePerspective(tx, f.at('alice'), { inherits: [organisation] }),
          )
          unwrap(
            f.perspective.createMemory(tx, f.at('alice'), {
              id: 'selected',
              content: 'SELECTED_SECRET',
            }),
          )
          unwrap(
            f.perspective.createMemory(tx, f.at('alice'), {
              id: 'skipped',
              content: 'SKIPPED_SECRET',
            }),
          )
          unwrap(
            f.perspective.excludeKnowledge(tx, organisation, selectedContent, { priority: 5000 }),
          )
          unwrap(
            f.perspective.excludeKnowledge(tx, organisation, skippedContent, { priority: 5000 }),
          )
          unwrap(f.perspective.excludeKnowledge(tx, organisation, unrelated, { priority: 5000 }))
        },
      ),
    )

    const base = unwrap(
      f.schema.commit(
        { parentId: some(seed.id), message: 'target branch without the organisation' },
        () => {},
      ),
    )
    const target = unwrap(
      f.schema.commit(fromCommit(base.id, 'carry one protected memory only'), (tx) => {
        unwrap(
          f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
            memoryIds: ['selected'],
            mapMemoryId: () => 'kept',
          }),
        )
      }),
    )

    expect(memoryIds(f, target.id, rootId)).toEqual(['kept'])
    expect(exclusionTargets(f, target.id, rootId)).toEqual([
      encodePathKey([...memoryPath(rootId, 'kept'), 'content']),
    ])
    expect(claimMember(structAt(f, target.id, ['perspectives', rootId]), 'inherits')).toEqual([])
    const hidden = f.perspective.inspect(target.id, f.at('alice'), [
      [...memoryPath(rootId, 'kept'), 'content'],
    ])
    expect(hidden.ok).toBe(false)
  })

  test('keeps colliding personal and inherited exclusion keys distinct', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const organisation = 'org:collision'
    const journalPath = memoryPath(rootId, 'journal')
    const journalContent = [...journalPath, 'content']

    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'personal and inherited exclusions collide'), (tx) => {
        unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: [organisation] }))
        // Personal key `${content}#1`, later duplicated by the organisation's
        // own first exclusion with the same source sequence number.
        unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), journalContent, { priority: 500 }))
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'journal',
            content: 'COLLIDING_SECRET',
          }),
        )
        unwrap(f.perspective.excludeKnowledge(tx, organisation, journalContent, { priority: 5000 }))
      }),
    )

    expect(corpusEntry(f, source.id, 'alice', journalContent)).toBeUndefined()

    const base = unwrap(
      f.schema.commit({ parentId: some(seed.id), message: 'pre-membership target base' }, () => {}),
    )
    const target = unwrap(
      f.schema.commit(fromCommit(base.id, 'carry colliding exclusion keys'), (tx) => {
        unwrap(
          f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
            includeClaims: true,
            memoryIds: ['journal'],
            mapMemoryId: () => 'renamed',
          }),
        )
      }),
    )

    const carriedContent = encodePathKey([...memoryPath(rootId, 'renamed'), 'content'])
    const records = exclusionRecords(f, target.id, rootId)
    expect(records).toHaveLength(2)
    expect(new Set(records.map((record) => record.key)).size).toBe(2)
    expect(records.map((record) => record.seq).sort((a, b) => a - b)).toEqual([1, 2])
    expect(records.map((record) => record.targetPathKey)).toEqual([carriedContent, carriedContent])
    expect(records.map((record) => record.priority).sort((a, b) => a - b)).toEqual([500, 5000])
    expect(claimMember(structAt(f, target.id, memoryPath(rootId, 'renamed')), 'content')).toBe(
      'COLLIDING_SECRET',
    )
    expect(
      f.perspective.inspect(target.id, f.at('alice'), [
        [...memoryPath(rootId, 'renamed'), 'content'],
      ]).ok,
    ).toBe(false)
  })

  test('rolls back inherited protective exclusions when the carry fails', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const organisation = 'org:rollback'
    const parentPath = memoryPath(rootId, 'parent')
    const parentContent = [...parentPath, 'content']

    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'organisation protects a summary memory'), (tx) => {
        unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: [organisation] }))
        const detail = unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'detail',
            content: 'A small detail.',
          }),
        )
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'parent',
            level: 'L1',
            content: 'PARENT_SECRET',
            children: [detail],
          }),
        )
        unwrap(f.perspective.excludeKnowledge(tx, organisation, parentContent, { priority: 5000 }))
      }),
    )

    const base = unwrap(
      f.schema.commit({ parentId: some(seed.id), message: 'pre-membership target base' }, () => {}),
    )
    const target = unwrap(
      f.schema.commit(fromCommit(base.id, 'failed carry must not leak protection'), (tx) => {
        const carried = f.perspective.carryOver(tx, {
          sourceCommitId: source.id,
          observer: f.at('alice'),
          memoryIds: ['parent'],
          existingChildMemoryMap: { detail: 'missing' },
        })
        expect(carried.ok).toBe(false)
        if (!carried.ok && carried.error.kind !== 'memory_conflict')
          throw new Error(`Expected memory_conflict, received ${carried.error.kind}`)
      }),
    )

    expect(memoryIds(f, target.id, rootId)).toEqual([])
    expect(exclusionTargets(f, target.id, rootId)).toEqual([])
    expect(claimMember(structAt(f, target.id, ['perspectives', rootId]), 'nextSeq')).toBe(1)
  })
})
