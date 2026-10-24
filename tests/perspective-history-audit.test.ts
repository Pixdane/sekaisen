import { afterEach, describe, expect, test } from 'bun:test'
import { some } from '@sekaisen/core'
import type { ObserverRef, SearchableCorpusEntry } from '@sekaisen/plugin-perspective'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveFixture, present, unwrap } from './perspective-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

/** Give each scenario its own real World/Schema/Perspective history. */
function setup() {
  const fixture = new PerspectiveFixture()
  drivers.push(fixture.driver)
  return fixture
}

/** One corpus entry; a missing entry is a scenario failure, not an empty assertion. */
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

describe('perspective audited historical instances', () => {
  test('unknown off-scene deletion keeps expanded inspection, view, schema, descriptions and custom classification identical', () => {
    const f = setup()
    const archives = unwrap(
      f.schema.define(
        ['archives'],
        s.map(
          s
            .struct({
              label: s.str().desc('archive display label'),
              inscription: s.str().desc('carved archive inscription'),
              parent: s
                .link({
                  targetRoots: [['entities']],
                  acyclic: true,
                  exclusiveRole: 'parent',
                  onDelete: 'unlink',
                })
                .optional()
                .meta({ linkRoles: ['parent'], visibility: 'ref' }),
            })
            .desc('a chronicled archive')
            .extensible(),
        ),
      ),
    )
    f.seed('room', 'room')
    const observed = f.commit('observe an archive with descriptions and custom metadata', (tx) => {
      tx.set(archives.at('tome'), {
        label: 'Tome',
        inscription: 'A remembered inscription',
        parent: f.key('room'),
      })
      tx.defineCustom(
        archives.at('tome'),
        'rune',
        s.str().desc('archived rune'),
        'remembered rune',
        {
          summary: 'archival runes',
        },
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const moved = f.commit('move the archive out of sight without telling its observer', (tx) => {
      tx.set(archives.at('tome').$.parent, f.key('remote'))
    })
    const archivePath = archives.at('tome').path
    const archiveKey = encodePathKey(archivePath)
    const beforeView = unwrap(f.perspective.projectView(moved.id, f.at('alice')))
    const beforeInspect = unwrap(f.perspective.inspect(moved.id, f.at('alice'), [archivePath]))
    const inscription = beforeInspect.find(
      (entry) =>
        encodePathKey(entry.path) === encodePathKey(archives.at('tome').$.inscription.path),
    )
    const rune = beforeInspect.find(
      (entry) => encodePathKey(entry.path) === encodePathKey([...archivePath, '$custom', 'rune']),
    )
    expect(inscription).toMatchObject({
      value: 'A remembered inscription',
      description: 'carved archive inscription',
      sourceKind: 'observed_claim',
      at: some(observed.id),
      acquiredAt: some(observed.id),
    })
    expect(rune).toMatchObject({
      value: 'remembered rune',
      description: 'archived rune',
      summary: some('archival runes'),
      sourceKind: 'observed_claim',
    })
    expect(beforeView.mergedInstances[archiveKey]?.customFields.rune?.summary).toEqual(
      some('archival runes'),
    )
    expect(beforeView.mergedInstances[archiveKey]?.customFields.rune?.value).toBeUndefined()
    expect(beforeView.mergedInstances[archiveKey]?.fields.rune).toBeUndefined()
    expect(beforeView.schemas[archiveKey]).toMatchObject({
      description: 'a chronicled archive',
      fields: {
        label: { description: 'archive display label' },
        inscription: { description: 'carved archive inscription' },
        rune: { description: 'archived rune' },
      },
    })

    const deleted = f.commit(
      'delete the off-scene archive without notifying its observer',
      (tx) => {
        tx.delete(archives.at('tome'))
      },
    )
    const afterView = unwrap(f.perspective.projectView(deleted.id, f.at('alice')))
    const afterInspect = unwrap(f.perspective.inspect(deleted.id, f.at('alice'), [archivePath]))
    expect(afterView).toEqual(beforeView)
    expect(afterInspect).toEqual(beforeInspect)
    expect(afterView.schemas[archiveKey]).toEqual(beforeView.schemas[archiveKey])
    expect(afterView.privateView.schemas[archiveKey]).toEqual(
      beforeView.privateView.schemas[archiveKey],
    )
    expect(afterView.mergedInstances[archiveKey]?.customFields.rune?.summary).toEqual(
      some('archival runes'),
    )
    expect(afterView.mergedInstances[archiveKey]?.fields.inscription?.value).toBe(
      'A remembered inscription',
    )
  })

  test('deleting a discovered hidden entity leaves no ghost field or ghost parent bucket', () => {
    const f = setup()
    f.seed('room', 'room')
    const discovered = f.commit('discover a hidden drawer', (tx) => {
      tx.set(f.at('drawer'), { parent: f.key('room'), text: 'hidden drawer inscription' })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const drawerKey = f.key('drawer')
    const inScene = unwrap(f.perspective.projectView(discovered.id, f.at('alice')))
    expect(inScene.mergedInstances[drawerKey]?.fields.text?.value).toBe('hidden drawer inscription')

    const moved = f.commit('move the discovered drawer out of sight', (tx) => {
      tx.set(f.at('drawer').$.parent, f.key('remote'))
    })
    const beforeView = unwrap(f.perspective.projectView(moved.id, f.at('alice')))
    const beforeInspect = unwrap(
      f.perspective.inspect(moved.id, f.at('alice'), [f.at('drawer').path]),
    )
    expect(beforeInspect[0]).toMatchObject({
      path: f.at('drawer').$.text.path,
      value: 'hidden drawer inscription',
      sourceKind: 'observed_claim',
    })

    const deleted = f.commit('delete the discovered drawer', (tx) => {
      tx.delete(f.at('drawer'))
    })
    const after = unwrap(f.perspective.projectView(deleted.id, f.at('alice')))
    expect(after).toEqual(beforeView)
    expect(unwrap(f.perspective.inspect(deleted.id, f.at('alice'), [f.at('drawer').path]))).toEqual(
      beforeInspect,
    )
    const entitiesKey = encodePathKey(['entities'])
    // The discovery record identifies the entity; it must never be re-read as a
    // leaf claim and manufacture a bucket for the enclosing Map root.
    expect(after.mergedInstances[entitiesKey]).toBeUndefined()
    expect(after.schemas[entitiesKey]).toBeUndefined()
    for (const view of Object.values(after.mergedInstances)) {
      for (const field of [...Object.values(view.fields), ...Object.values(view.customFields)]) {
        expect(field.value).not.toBeNull()
      }
    }
    expect(after.mergedInstances[drawerKey]?.fields.text?.value).toBe('hidden drawer inscription')
  })
})

describe('perspective audited corpus links', () => {
  test('hidden delegate targets stay out of visible corpus links until explicitly observed, and rumors cannot probe them', () => {
    const f = setup()
    f.seed('room', 'room')
    const seeded = f.commit('hide a delegate edge behind a visible master', (tx) => {
      tx.set(f.at('master'), { name: 'Master', parent: f.key('room') })
      tx.set(f.at('note').$.name, 'Note')
      tx.set(f.at('note').$.delegate, f.key('master'))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const noteText = f.at('note').$.text.path
    expect(corpusEntry(f, seeded.id, f.at('alice'), noteText).linkedInstancePaths).toEqual([])

    const taught = f.commit('teach Alice the hidden delegate edge explicitly', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').$.delegate.path))
    })
    expect(corpusEntry(f, taught.id, f.at('alice'), noteText).linkedInstancePaths).toContainEqual(
      f.at('master').path,
    )
    expect(
      corpusEntry(f, taught.id, f.at('alice'), f.at('note').$.delegate.path).linkedInstancePaths,
    ).toContainEqual(f.at('master').path)

    const correctRumor = f.commit('repeat the correct hidden target as a rumor', (tx) => {
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), f.at('note').$.delegate.path, f.key('master'), {
          priority: 2000,
          override: true,
          belief: 'believed',
        }),
      )
    })
    expect(corpusEntry(f, correctRumor.id, f.at('alice'), noteText).linkedInstancePaths).toEqual([])
    expect(
      corpusEntry(f, correctRumor.id, f.at('alice'), f.at('note').$.delegate.path)
        .linkedInstancePaths,
    ).toEqual([])

    const wrongRumor = f.commit('repeat a wrong hidden target as a rumor', (tx) => {
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), f.at('note').$.delegate.path, f.key('note'), {
          priority: 2000,
          override: true,
          belief: 'believed',
        }),
      )
    })
    expect(corpusEntry(f, wrongRumor.id, f.at('alice'), noteText).linkedInstancePaths).toEqual([])
  })

  test('remembered corpus edges keep their fact-time pointer after an unseen link edit', () => {
    const f = setup()
    f.seed('room', 'room')
    const fact = f.commit('link a note to the first master and observe it', (tx) => {
      tx.set(f.at('master'), { name: 'Master', parent: f.key('room') })
      tx.set(f.at('otherMaster'), { name: 'Other master', parent: f.key('room') })
      tx.set(f.at('note').$.delegate, f.key('master'))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    f.commit('move the note away while learning its hidden edge at fact time', (tx) => {
      tx.set(f.at('note').$.parent, f.key('remote'))
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').$.delegate.path, {
          atCommitId: fact.id,
        }),
      )
    })
    const edited = f.commit('rewrite the unseen link to another visible entity', (tx) => {
      tx.set(f.at('note').$.delegate, f.key('otherMaster'))
    })
    const remembered = corpusEntry(f, edited.id, f.at('alice'), f.at('note').$.text.path)
    expect(remembered.factCommitId).toBe(fact.id)
    expect(remembered.linkedInstancePaths).toContainEqual(f.at('master').path)
    expect(remembered.linkedInstancePaths).not.toContainEqual(f.at('otherMaster').path)
  })

  test('publicly visible link fields contribute their authorized target paths to the corpus', () => {
    const f = setup()
    f.seed('room', 'remote')
    const connected = f.commit('open a public doorway into the remote room', (tx) => {
      tx.set(f.edges.at('doorway'), {
        name: 'An open doorway',
        from: f.key('room'),
        to: f.key('remote'),
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const doorwayTo = corpusEntry(f, connected.id, f.at('alice'), f.edges.at('doorway').$.to.path)
    expect(doorwayTo.linkedInstancePaths).toContainEqual(f.at('room').path)
    expect(doorwayTo.linkedInstancePaths).toContainEqual(f.at('remote').path)
  })
})

describe('perspective audited raw public surface', () => {
  test('scene public is observer-independent and never carries private discovery or rumor facets', () => {
    const f = setup()
    f.seed('room', 'room')
    const scene = f.commit('create private and public knowledge around one raw surface', (tx) => {
      tx.set(f.at('secret'), { parent: f.key('remote'), text: 'REMOTE_SECRET_TEXT' })
      tx.set(f.at('drawer'), { parent: f.key('room'), text: 'DISCOVERED_DRAWER_TEXT' })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
      tx.set(f.edges.at('doorway'), {
        name: 'An open doorway',
        from: f.key('room'),
        to: f.key('remote'),
      })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path))
      unwrap(
        f.perspective.grantRumor(
          tx,
          f.at('alice'),
          f.at('secret').$.text.path,
          'RUMOR_ONLY_SECRET',
          { belief: 'suspected' },
        ),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const aliceView = unwrap(f.perspective.projectView(scene.id, f.at('alice')))
    const bobView = unwrap(f.perspective.projectView(scene.id, f.at('bob')))
    expect(aliceView.scenePublic).toEqual(bobView.scenePublic)
    expect(aliceView.scenePublic).toEqual(
      some(unwrap(f.perspective.projectScopePublic(scene.id, f.at('room')))),
    )
    const raw = JSON.stringify(aliceView.scenePublic)
    expect(raw).not.toContain('RUMOR_ONLY_SECRET')
    expect(raw).not.toContain('DISCOVERED_DRAWER_TEXT')
    for (const view of Object.values(present(aliceView.scenePublic).instances)) {
      for (const field of [...Object.values(view.fields), ...Object.values(view.customFields)]) {
        expect(field.sourceKind).toBe('direct_scope')
        expect(field.additionalFacets).toEqual([])
      }
    }
  })
})
