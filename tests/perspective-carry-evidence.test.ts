import { afterEach, describe, expect, test } from 'bun:test'
import type { Result } from '@sekaisen/core'
import { some } from '@sekaisen/core'
import type { CarryOverResult, PerspectiveError } from '@sekaisen/plugin-perspective'
import type { HistoricalStructInspection } from '@sekaisen/plugin-schema'
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

function claimFullPath(rootId: string, table: string, key: string): string {
  return encodePathKey(['perspectives', rootId, table, key])
}

describe('carry-over evidence and exclusions', () => {
  test('carries every same-origin contributor, keeps independent origins, and remaps canonical evidence', () => {
    const f = setup()
    const seed = f.seed('remote', 'remote')
    const rootId = f.key('alice')
    const text = [...f.at('note').path, 'text']
    const name = [...f.at('note').path, 'name']
    const obscured = [...f.at('note').path, 'obscured']
    const textKey = encodePathKey(text)
    const nameKey = encodePathKey(name)
    const sharedOrigin: StateRef = { commitId: seed.id, path: ['$message'] }
    const journalPath = memoryPath(rootId, 'journal')
    const linksPath = memoryPath(rootId, 'links')
    const journalContent = [...journalPath, 'content']
    const linksWitness = [...linksPath, 'relatedEntities', 'witness']

    const claims = unwrap(
      f.schema.commit(fromCommit(seed.id, 'two sources and independent origins'), (tx) => {
        unwrap(
          f.perspective.grantRumor(tx, f.at('alice'), text, 'shared account', {
            originEventRef: sharedOrigin,
            source: 'bob',
            coWitnesses: [f.at('bob'), f.at('note')],
          }),
        )
        unwrap(
          f.perspective.grantRumor(tx, f.at('alice'), text, 'shared account', {
            originEventRef: sharedOrigin,
            source: 'charlie',
            coWitnesses: [f.at('note'), f.at('bob')],
          }),
        )
        unwrap(
          f.perspective.grantRumor(tx, f.at('alice'), name, 'independent value', {
            source: 'dave',
          }),
        )
        unwrap(
          f.perspective.grantRumor(tx, f.at('alice'), name, 'independent value', {
            source: 'erin',
          }),
        )
        unwrap(
          f.perspective.grantRumor(tx, f.at('alice'), obscured, 'old account', {
            source: 'old',
          }),
        )
        unwrap(
          f.perspective.grantRumor(tx, f.at('alice'), obscured, 'new account', {
            source: 'new',
            override: true,
          }),
        )
        unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), journalContent))
        unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), linksWitness))
      }),
    )

    const source = unwrap(
      f.schema.commit(fromCommit(claims.id, 'memories cite canonical claim paths'), (tx) => {
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'journal',
            content: 'Do not leak this narrative.',
            supportingClaimKeys: [
              claimFullPath(rootId, 'rumorClaims', `${textKey}#1`),
              claimFullPath(rootId, 'rumorClaims', `${textKey}#2`),
              `${nameKey}#3`,
              claimFullPath(rootId, 'exclusions', `${encodePathKey(journalContent)}#7`),
              claimFullPath(rootId, 'rumorClaims', `${encodePathKey(obscured)}#5`),
            ],
          }),
        )
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'links',
            content: 'Association filtering survives renaming.',
            relatedEntities: {
              kept: {
                targetRef: { commitId: seed.id, path: f.at('bob').path },
                role: 'participant',
              },
              witness: {
                targetRef: { commitId: seed.id, path: f.at('alice').path },
                role: 'witness',
              },
            },
          }),
        )
      }),
    )

    const targetBase = unwrap(
      f.schema.commit({ parentId: some(seed.id), message: 'target branch anchor' }, (tx) => {
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'anchor',
            content: 'A target-branch memory.',
          }),
        )
      }),
    )

    let carried: Result<CarryOverResult, PerspectiveError> | undefined
    const target = unwrap(
      f.schema.commit(
        { parentId: some(targetBase.id), message: 'carry evidence across worlds' },
        (tx) => {
          carried = f.perspective.carryOver(tx, {
            sourceCommitId: source.id,
            observer: f.at('alice'),
            mapMemoryId: (oldMemoryId) => {
              if (oldMemoryId === 'journal') return 'carried_journal'
              if (oldMemoryId === 'links') return 'carried_links'
              return oldMemoryId
            },
          })
          expect(carried.ok).toBe(true)
        },
      ),
    )
    if (carried === undefined || !carried.ok) throw new Error('Expected a successful carry-over')
    const result = carried.value
    expect(result.memoryIdMap).toEqual({ journal: 'carried_journal', links: 'carried_links' })

    const textAfter = unwrap(f.perspective.inspect(target.id, f.at('alice'), [text]))
    expect(textAfter).toHaveLength(1)
    expect(textAfter[0]?.sources).toEqual(['bob', 'charlie'])
    expect(textAfter[0]?.coWitnesses).toEqual([f.key('bob'), f.key('note')])
    expect(textAfter[0]?.additionalFacets).toEqual([])

    const nameAfter = unwrap(f.perspective.inspect(target.id, f.at('alice'), [name]))
    expect(nameAfter[0]?.value).toBe('independent value')
    expect(nameAfter[0]?.sources).toEqual(['erin'])
    expect(nameAfter[0]?.additionalFacets).toHaveLength(1)
    expect(nameAfter[0]?.additionalFacets[0]).toMatchObject({
      value: 'independent value',
      sources: ['dave'],
    })

    const carriedJournalPath = memoryPath(rootId, 'carried_journal')
    const carriedJournalContent = [...carriedJournalPath, 'content']
    const carriedLinksPath = memoryPath(rootId, 'carried_links')
    const carriedLinksWitness = [...carriedLinksPath, 'relatedEntities', 'witness']
    const journal = structAt(f, target.id, carriedJournalPath)
    expect(claimMember(journal, 'supportingClaimKeys')).toEqual([
      claimFullPath(rootId, 'rumorClaims', `${textKey}#2`),
      claimFullPath(rootId, 'rumorClaims', `${textKey}#3`),
      claimFullPath(rootId, 'rumorClaims', `${nameKey}#4`),
      claimFullPath(rootId, 'exclusions', `${encodePathKey(carriedJournalContent)}#7`),
    ])

    const exclusionTargets = result.carriedClaimKeys
      .map(decodePathKey)
      .filter((path) => path[2] === 'exclusions')
      .map((path) => claimMember(structAt(f, target.id, path), 'targetPathKey'))
    expect([...exclusionTargets].sort()).toEqual(
      [encodePathKey(carriedJournalContent), encodePathKey(carriedLinksWitness)].sort(),
    )

    const view = unwrap(f.perspective.projectView(target.id, f.at('alice')))
    const journalKey = encodePathKey(carriedJournalPath)
    expect(view.privateView.selfInstances[journalKey]).toBeDefined()
    expect(view.privateView.selfInstances[journalKey]?.fields.content).toBeUndefined()
    const hiddenContent = f.perspective.inspect(target.id, f.at('alice'), [carriedJournalContent])
    expect(hiddenContent.ok).toBe(false)
    if (!hiddenContent.ok) expect(hiddenContent.error.kind).toBe('not_authorized')

    const linksEntry = unwrap(f.perspective.listSearchableCorpus(target.id, f.at('alice'))).find(
      (entry) => encodePathKey(entry.path) === encodePathKey([...carriedLinksPath, 'content']),
    )
    if (linksEntry === undefined) throw new Error('Expected a carried links corpus entry')
    expect(linksEntry.linkedEntities.map((entity) => entity.role)).toEqual(['participant'])
  })

  test('includeClaims false keeps only exclusions protecting migrated memory fields', () => {
    const f = setup()
    const seed = f.seed()
    const rootId = f.key('alice')
    const journalPath = memoryPath(rootId, 'journal')
    const away = [...f.at('bob').path, 'name']

    const source = unwrap(
      f.schema.commit(fromCommit(seed.id, 'private memory and unrelated rumor'), (tx) => {
        unwrap(
          f.perspective.createMemory(tx, f.at('alice'), {
            id: 'journal',
            content: 'FIELD_ONLY_HIDDEN_NARRATIVE',
          }),
        )
        unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [...journalPath, 'content']))
        unwrap(f.perspective.grantRumor(tx, f.at('alice'), away, 'unrelated rumor'))
      }),
    )

    let carried: Result<CarryOverResult, PerspectiveError> | undefined
    const target = unwrap(
      f.schema.commit({ parentId: some(seed.id), message: 'memories without claims' }, (tx) => {
        carried = f.perspective.carryOver(tx, {
          sourceCommitId: source.id,
          observer: f.at('alice'),
          includeClaims: false,
          mapMemoryId: (oldMemoryId) => (oldMemoryId === 'journal' ? 'carried' : oldMemoryId),
        })
        expect(carried.ok).toBe(true)
      }),
    )
    if (carried === undefined || !carried.ok) throw new Error('Expected a successful carry-over')
    expect(carried.value.carriedClaimKeys).toHaveLength(1)
    const carriedPath = memoryPath(rootId, 'carried')
    expect(claimMember(structAt(f, target.id, carriedPath), 'content')).toBe(
      'FIELD_ONLY_HIDDEN_NARRATIVE',
    )
    const hidden = f.perspective.inspect(target.id, f.at('alice'), [[...carriedPath, 'content']])
    expect(hidden.ok).toBe(false)
    if (!hidden.ok) expect(hidden.error.kind).toBe('not_authorized')
    expect(
      unwrap(f.perspective.listSearchableCorpus(target.id, f.at('alice'))).some(
        (entry) => encodePathKey(entry.path) === encodePathKey(away),
      ),
    ).toBe(false)
  })
})
