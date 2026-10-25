import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import type { ObserverRef, SearchableCorpusEntry } from '@sekaisen/plugin-perspective'
import type { CommitHash, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import { claimMember, PerspectiveFixture, present, unwrap } from './perspective-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function setup() {
  const fixture = new PerspectiveFixture()
  drivers.push(fixture.driver)
  return fixture
}

/** Exact cognitive memory instance path under Alice's canonical root. */
function aliceMemoryPath(f: PerspectiveFixture, id: string): Path {
  return ['perspectives', f.key('alice'), 'memories', id]
}

/** One corpus entry for an exact path; a missing entry is a scenario failure. */
function corpusEntry(
  f: PerspectiveFixture,
  id: CommitHash,
  observer: ObserverRef,
  path: Path,
): SearchableCorpusEntry {
  const key = encodePathKey(path)
  const entry = unwrap(f.perspective.listSearchableCorpus(id, observer)).find(
    (candidate) => encodePathKey(candidate.path) === key,
  )
  if (!entry) throw new Error(`Expected a corpus entry for ${key}`)
  return entry
}

/** Read one perspective field from the committed state tree. */
function perspectiveNumber(
  f: PerspectiveFixture,
  id: CommitHash,
  observer: string,
  field: 'nextSeq',
): number {
  const node = present(unwrap(f.schema.inspectInstance(id, ['perspectives', f.key(observer)])))
  if (node.nodeKind !== 'struct') throw new Error('Expected a perspective struct')
  return claimMember(node, field) as number
}

describe('cognitive memory projection and corpus', () => {
  test('personal memories are private self instances and expose filtered entity refs', () => {
    const f = setup()
    f.seed()
    const remembered = f.commit('remember the note subjectively', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'memory-1',
          content: 'Alice remembers the note',
          summary: 'note memory',
          relatedEntities: {
            subject: {
              targetRef: { commitId: SELF_COMMIT, path: f.at('note').path },
              role: 'subject',
            },
            field: {
              targetRef: { commitId: SELF_COMMIT, path: f.at('note').$.text.path },
              role: 'invalid-leaf-target',
            },
          },
        }),
      )
    })
    const memoryPath = aliceMemoryPath(f, 'memory-1')
    const memoryKey = encodePathKey(memoryPath)
    const contentPath = [...memoryPath, 'content']

    const alice = unwrap(f.perspective.projectView(remembered.id, f.at('alice')))
    expect(alice.privateView.selfInstances[memoryKey]).toBeDefined()
    expect(alice.privateView.selfInstances[memoryKey]?.fields.content).toMatchObject({
      folded: true,
      summary: some('note memory'),
      seq: 1,
      sourceKind: 'observed_claim',
      belief: 'believed',
    })
    expect(alice.privateView.selfInstances[memoryKey]?.fields.content?.value).toBeUndefined()
    expect(alice.schemas[memoryKey]?.fields.factEventRef).toBeUndefined()

    const bob = unwrap(f.perspective.projectView(remembered.id, f.at('bob')))
    expect(bob.privateView.selfInstances[memoryKey]).toBeUndefined()
    expect(bob.privateView.offSceneKnownInstances[memoryKey]).toBeUndefined()
    expect(bob.mergedInstances[memoryKey]).toBeUndefined()
    const denied = f.perspective.inspect(remembered.id, f.at('bob'), [memoryPath])
    expect(denied.ok).toBe(false)
    expect(denied.ok ? undefined : denied.error.kind).toBe('not_authorized')

    const entry = corpusEntry(f, remembered.id, f.at('alice'), contentPath)
    expect(entry).toMatchObject({
      text: 'Alice remembers the note',
      summary: some('note memory'),
      seq: 1,
      sourceKind: 'observed_claim',
      factCommitId: remembered.id,
      acquiredAtCommitId: remembered.id,
    })
    const subject = entry.linkedEntities.find(
      (entity) => encodePathKey(entity.ref.path) === encodePathKey(f.at('note').path),
    )
    expect(subject).toMatchObject({
      relation: 'memory_entity',
      role: 'subject',
      currentPath: some(f.at('note').path),
    })
    expect(
      entry.linkedEntities.some(
        (entity) => encodePathKey(entity.ref.path) === encodePathKey(f.at('note').$.text.path),
      ),
    ).toBe(false)
    expect(entry.linkedEntities.every((entity) => entity.ref.path[0] !== '$message')).toBe(true)
    expect(entry.linkedInstancePaths).toContainEqual(f.at('note').path)
    expect(
      unwrap(f.perspective.listSearchableCorpus(remembered.id, f.at('bob'))).some(
        (candidate) => encodePathKey(candidate.path) === encodePathKey(contentPath),
      ),
    ).toBe(false)

    const inspectedMemory = unwrap(
      f.perspective.inspect(remembered.id, f.at('alice'), [contentPath]),
    )[0]
    expect(inspectedMemory).toMatchObject({
      value: 'Alice remembers the note',
      summary: some('note memory'),
      seq: 1,
      sourceKind: 'observed_claim',
    })
    const adjudicatedMemory = unwrap(
      f.perspective.inspectForAdjudication(remembered.id, f.at('alice'), [contentPath]),
    )[0]
    expect(adjudicatedMemory).toMatchObject({
      authorized: true,
      matchesObjectiveTruth: true,
    })
    expect(adjudicatedMemory?.subjective.kind).toBe('some')
  })

  test('inherited organization memories stay readable off-scene with local sequences', () => {
    const f = setup()
    f.seed()
    const organization = 'org:archive'
    f.commit('record an organization memory', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, organization, {
          id: 'archive-memory',
          content: 'ORG_ARCHIVE_NARRATIVE',
        }),
      )
    })
    const inherited = f.commit('Alice inherits the archive knowledge source', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: [organization] }))
    })
    const memoryPath = ['perspectives', organization, 'memories', 'archive-memory']
    const memoryKey = encodePathKey(memoryPath)

    const alice = unwrap(f.perspective.projectView(inherited.id, f.at('alice')))
    expect(alice.privateView.selfInstances[memoryKey]).toBeUndefined()
    expect(alice.privateView.offSceneKnownInstances[memoryKey]).toBeDefined()
    expect(alice.mergedInstances[memoryKey]?.fields.content?.value).toBe('ORG_ARCHIVE_NARRATIVE')

    const bob = unwrap(f.perspective.projectView(inherited.id, f.at('bob')))
    expect(bob.privateView.offSceneKnownInstances[memoryKey]).toBeUndefined()
    expect(bob.mergedInstances[memoryKey]).toBeUndefined()

    const entry = corpusEntry(f, inherited.id, f.at('alice'), [...memoryPath, 'content'])
    expect(entry).toMatchObject({ text: 'ORG_ARCHIVE_NARRATIVE', seq: 1 })
    expect(entry.linkedEntities).toEqual([])
    expect(entry.linkedInstancePaths).toEqual([])
  })

  test('exclusions hide memories from projection, inspection and retrieval', () => {
    const f = setup()
    f.seed()
    const created = f.commit('record a memory that will be excluded', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'forgotten',
          content: 'EXCLUDED_MEMORY_NARRATIVE',
        }),
      )
    })
    const memoryPath = aliceMemoryPath(f, 'forgotten')
    const memoryKey = encodePathKey(memoryPath)

    const excluded = f.commit('exclude the memory instance', (tx) => {
      unwrap(f.perspective.forgetMemory(tx, f.at('alice'), 'forgotten', 'exclude'))
    })
    const view = unwrap(f.perspective.projectView(excluded.id, f.at('alice')))
    expect(view.privateView.selfInstances[memoryKey]).toBeUndefined()
    expect(view.mergedInstances[memoryKey]).toBeUndefined()
    const inspected = f.perspective.inspect(excluded.id, f.at('alice'), [memoryPath])
    expect(inspected.ok).toBe(false)
    expect(inspected.ok ? undefined : inspected.error.kind).toBe('not_authorized')
    expect(
      unwrap(f.perspective.listSearchableCorpus(excluded.id, f.at('alice'))).some(
        (candidate) => encodePathKey(candidate.path) === encodePathKey([...memoryPath, 'content']),
      ),
    ).toBe(false)

    const restored = f.commit('record a second memory for field-level exclusion', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'field-excluded',
          content: 'FIELD_EXCLUDED_NARRATIVE',
        }),
      )
    })
    const fieldMemory = aliceMemoryPath(f, 'field-excluded')
    const fieldExcluded = f.commit('exclude only the content field', (tx) => {
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...fieldMemory, 'content']))
    })
    expect(restored.id).toBeDefined()
    const fieldView = unwrap(f.perspective.projectView(fieldExcluded.id, f.at('alice')))
    expect(fieldView.mergedInstances[encodePathKey(fieldMemory)]).toBeDefined()
    expect(
      unwrap(f.perspective.listSearchableCorpus(fieldExcluded.id, f.at('alice'))).some(
        (candidate) => encodePathKey(candidate.path) === encodePathKey([...fieldMemory, 'content']),
      ),
    ).toBe(false)
    const excludedContent = f.perspective.inspect(fieldExcluded.id, f.at('alice'), [
      [...fieldMemory, 'content'],
    ])
    expect(excludedContent.ok).toBe(false)
    expect(excludedContent.ok ? undefined : excludedContent.error.kind).toBe('not_authorized')
    expect(
      unwrap(
        f.perspective.inspect(fieldExcluded.id, f.at('alice'), [[...fieldMemory, 'level']]),
      )[0],
    ).toMatchObject({ value: 'L0', sourceKind: 'observed_claim' })
    expect(created.id).toBeDefined()
  })

  test('summary folding hides children unless the parent is known false', () => {
    const f = setup()
    f.seed()
    const detail = f.commit('record a detailed recollection', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'detail',
          content: 'DETAIL_NARRATIVE',
        }),
      )
    })
    const summarized = f.commit('summarize the detail', (tx) => {
      unwrap(
        f.perspective.summarizeMemories(tx, f.at('alice'), {
          id: 'summary',
          level: 'L1',
          childMemoryIds: ['detail'],
          content: 'SUMMARY_NARRATIVE',
        }),
      )
    })
    expect(detail.id).toBeDefined()
    const childPath = aliceMemoryPath(f, 'detail')
    const parentPath = aliceMemoryPath(f, 'summary')

    const foldedView = unwrap(f.perspective.projectView(summarized.id, f.at('alice')))
    expect(foldedView.mergedInstances[encodePathKey(parentPath)]).toBeDefined()
    expect(foldedView.mergedInstances[encodePathKey(childPath)]).toBeUndefined()
    const childEntry = corpusEntry(f, summarized.id, f.at('alice'), [...childPath, 'content'])
    expect(childEntry.isFoldedInDefaultView).toBe(true)
    expect(childEntry.text).toBe('DETAIL_NARRATIVE')
    const parentEntry = corpusEntry(f, summarized.id, f.at('alice'), [...parentPath, 'content'])
    expect(parentEntry.isFoldedInDefaultView).toBe(false)

    const falsified = f.commit('mark the summary known false', (tx) => {
      unwrap(f.perspective.forgetMemory(tx, f.at('alice'), 'summary', 'known_false'))
    })
    const unfolded = unwrap(f.perspective.projectView(falsified.id, f.at('alice')))
    expect(unfolded.mergedInstances[encodePathKey(childPath)]).toBeDefined()
    expect(
      corpusEntry(f, falsified.id, f.at('alice'), [...childPath, 'content']).isFoldedInDefaultView,
    ).toBe(false)
  })

  test('memory entity links never leak off-scene objective existence or reappearance', () => {
    const f = setup()
    f.seed()
    const discovered = f.commit('discover a hidden keepsake', (tx) => {
      tx.set(f.at('secret'), {
        name: 'Secret keepsake',
        parent: f.key('remote'),
        text: 'SECRET_OBJECTIVE_TEXT',
      })
      tx.setInstanceMeta(f.at('secret'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('secret').path))
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'about-secret',
          content: 'MEMORY_ABOUT_SECRET',
          relatedEntities: {
            keepsake: {
              targetRef: { commitId: SELF_COMMIT, path: f.at('secret').path },
              role: 'item',
            },
          },
        }),
      )
    })
    const memoryPath = aliceMemoryPath(f, 'about-secret')
    const contentPath = [...memoryPath, 'content']
    const first = corpusEntry(f, discovered.id, f.at('alice'), contentPath)
    const firstLinks = first.linkedEntities
    expect(firstLinks).toHaveLength(1)
    expect(firstLinks[0]).toMatchObject({
      ref: { commitId: discovered.id, path: f.at('secret').path },
      relation: 'memory_entity',
      role: 'item',
      currentPath: NONE,
    })

    const deleted = f.commit('delete the hidden keepsake', (tx) => {
      tx.delete(f.at('secret'))
    })
    const afterDelete = corpusEntry(f, deleted.id, f.at('alice'), contentPath)
    expect(afterDelete.linkedEntities).toEqual(firstLinks)

    const recreated = f.commit('recreate the hidden keepsake objectively', (tx) => {
      tx.set(f.at('secret'), { name: 'Recreated keepsake', parent: f.key('remote') })
      tx.setInstanceMeta(f.at('secret'), { visibility: 'ref' })
    })
    const afterRecreate = corpusEntry(f, recreated.id, f.at('alice'), contentPath)
    expect(afterRecreate.linkedEntities).toEqual(firstLinks)
  })

  test('source link authorization prevents rumor dereference and unauthorized targets', () => {
    const f = setup()
    f.seed('room', 'room')
    const fact = f.commit('teach a hidden delegate edge', (tx) => {
      tx.set(f.at('master'), { name: 'Master', parent: f.key('room') })
      tx.set(f.at('otherMaster'), { name: 'Other master', parent: f.key('room') })
      tx.set(f.at('note').$.delegate, f.key('master'))
      tx.set(f.at('secret'), { name: 'Secret', parent: f.key('remote') })
      tx.setInstanceMeta(f.at('secret'), { visibility: 'ref' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(fact.id).toBeDefined()
    const taught = f.commit('move the note away and learn its hidden edge at fact time', (tx) => {
      tx.set(f.at('note').$.parent, f.key('remote'))
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').$.delegate.path, {
          atCommitId: fact.id,
        }),
      )
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'link-memory',
          content: 'LINK_MEMORY_NARRATIVE',
          relatedEntities: {
            authorized: {
              targetRef: { commitId: SELF_COMMIT, path: f.at('master').path },
              role: 'participant',
            },
            unauthorized: {
              targetRef: { commitId: SELF_COMMIT, path: f.at('secret').path },
              role: 'hidden-target',
            },
          },
        }),
      )
    })
    const noteText = f.at('note').$.text.path
    const noteEntry = corpusEntry(f, taught.id, f.at('alice'), noteText)
    expect(
      noteEntry.linkedEntities.find(
        (entity) =>
          entity.ref.commitId === fact.id &&
          encodePathKey(entity.ref.path) === encodePathKey(f.at('master').path),
      ),
    ).toMatchObject({ relation: 'historical_link', currentPath: some(f.at('master').path) })
    expect(
      noteEntry.linkedEntities.some(
        (entity) => encodePathKey(entity.ref.path) === encodePathKey(f.at('otherMaster').path),
      ),
    ).toBe(false)

    const memoryLinks = corpusEntry(f, taught.id, f.at('alice'), [
      ...aliceMemoryPath(f, 'link-memory'),
      'content',
    ]).linkedEntities
    expect(memoryLinks.map((entity) => entity.role)).toEqual(['participant'])
    expect(memoryLinks[0]?.currentPath).toEqual(some(f.at('master').path))
    expect(memoryLinks.every((entity) => entity.ref.path[0] !== '$message')).toBe(true)

    const rumor = f.commit('overwrite the hidden edge with a rumor', (tx) => {
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), f.at('note').$.delegate.path, f.key('master'), {
          priority: 2000,
          override: true,
          belief: 'believed',
        }),
      )
    })
    expect(corpusEntry(f, rumor.id, f.at('alice'), noteText).linkedEntities).toEqual([])
  })

  test('live facets expose nextSeq while stored claims expose their record sequence', () => {
    const f = setup()
    const seeded = f.seed()
    const synced = f.commit('synchronize the visible room', (tx) => {
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(seeded.id).toBeDefined()
    const nextSeq = perspectiveNumber(f, synced.id, 'alice', 'nextSeq')
    const noteText = f.at('note').$.text.path
    const liveView = unwrap(f.perspective.projectView(synced.id, f.at('alice')))
    expect(liveView.mergedInstances[f.key('note')]?.fields.text).toMatchObject({
      sourceKind: 'direct_scope',
      seq: nextSeq,
    })

    const observedSeq = claimMember(f.latestObserved(synced.id, 'alice', noteText), 'seq') as number
    const away = f.commit('leave the observed room', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const inspected = unwrap(f.perspective.inspect(away.id, f.at('alice'), [noteText]))[0]
    expect(inspected).toMatchObject({ sourceKind: 'observed_claim', seq: observedSeq })
    expect(corpusEntry(f, away.id, f.at('alice'), noteText).seq).toBe(observedSeq)
  })
})

describe('historical whole-instance grants', () => {
  test('record historical self fields only when ownership existed in that snapshot', () => {
    const f = setup()
    f.seed()
    const owned = f.commit('create an owned keepsake', (tx) => {
      tx.set(f.at('keepsake'), {
        name: 'Keepsake',
        parent: f.key('room'),
        owner: f.key('alice'),
        privateText: 'SECRET_AT_GRANT',
      })
    })
    f.commit('transfer ownership and rewrite the private state', (tx) => {
      tx.set(f.at('keepsake').$.owner, f.key('bob'))
      tx.set(f.at('keepsake').$.privateText, 'SECRET_LATER')
    })
    const granted = f.commit('grant the historical whole instance', (tx) => {
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('keepsake').path, {
          atCommitId: owned.id,
        }),
      )
    })
    const privatePath = f.at('keepsake').$.privateText.path
    const inspected = unwrap(f.perspective.inspect(granted.id, f.at('alice'), [privatePath]))[0]
    expect(inspected).toMatchObject({
      value: 'SECRET_AT_GRANT',
      sourceKind: 'observed_claim',
      at: some(owned.id),
      acquiredAt: some(granted.id),
    })
    expect(inspected?.seq).toBeGreaterThan(0)
  })
})
