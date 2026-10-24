import { afterEach, describe, expect, test } from 'bun:test'
import type { ObserverRef, SearchableCorpusEntry } from '@sekaisen/plugin-perspective'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveFixture, unwrap } from './perspective-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

/** Give each scenario its own real persistence and registered plugin services. */
function setup() {
  const fixture = new PerspectiveFixture()
  drivers.push(fixture.driver)
  return fixture
}

/** Require one authorized field view in expanded inspection output. */
function inspectedField(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, path: Path) {
  const key = encodePathKey(path)
  const field = unwrap(f.perspective.inspect(id, observer, [path])).find(
    (entry) => encodePathKey(entry.path) === key,
  )
  if (!field) throw new Error(`Expected an authorized field view for ${key}`)
  return field
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

describe('perspective effective discovery expansion', () => {
  test('a known-false discovery never promotes new hidden text or a hidden connector environment', () => {
    const f = setup()
    f.seed('room', 'room')
    f.commit('record known-false accounts of a hidden note and connector', (tx) => {
      tx.set(f.at('drawer'), { parent: f.key('room'), text: 'FALSE_DRAWER_OLD' })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
      tx.set(f.at('remoteNote'), { parent: f.key('remote'), text: 'FALSE_ADJACENT_OLD' })
      tx.set(f.edges.at('falseWindow'), {
        name: 'False window',
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      tx.setInstanceMeta(f.edges.at('falseWindow'), { visibility: 'ref' })
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path, {
          belief: 'known_false',
        }),
      )
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('falseWindow').path, {
          belief: 'known_false',
        }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const changed = f.commit('publish new hidden and adjacent text', (tx) => {
      tx.set(f.at('drawer').$.text, 'FALSE_DRAWER_NEW')
      tx.set(f.at('remoteNote').$.text, 'FALSE_ADJACENT_NEW')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    expect(inspectedField(f, changed.id, f.at('alice'), f.at('drawer').$.text.path)).toMatchObject({
      value: 'FALSE_DRAWER_OLD',
      sourceKind: 'observed_claim',
      belief: 'known_false',
    })
    expect(
      f.perspective.inspect(changed.id, f.at('alice'), [f.at('remoteNote').$.text.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    const projection = JSON.stringify(unwrap(f.perspective.projectView(changed.id, f.at('alice'))))
    expect(projection).not.toContain('FALSE_DRAWER_NEW')
    expect(projection).not.toContain('FALSE_ADJACENT_NEW')
  })

  test('a true discovery still authorizes hidden live content and its one-hop environment', () => {
    const f = setup()
    f.seed('room', 'room')
    const discovered = f.commit('discover a hidden drawer and connector', (tx) => {
      tx.set(f.at('drawer'), { parent: f.key('room'), text: 'TRUE_DRAWER_LIVE' })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
      tx.set(f.at('remoteNote'), { parent: f.key('remote'), text: 'TRUE_ADJACENT_LIVE' })
      tx.set(f.edges.at('window'), {
        name: 'Hidden window',
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      tx.setInstanceMeta(f.edges.at('window'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path))
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('window').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    expect(
      inspectedField(f, discovered.id, f.at('alice'), f.at('drawer').$.text.path),
    ).toMatchObject({ value: 'TRUE_DRAWER_LIVE', sourceKind: 'direct_scope' })
    expect(
      inspectedField(f, discovered.id, f.at('alice'), f.at('remoteNote').$.text.path),
    ).toMatchObject({ value: 'TRUE_ADJACENT_LIVE', sourceKind: 'direct_scope' })
  })

  test('corpus link targets use the same discovery validity rule as live access', () => {
    const f = setup()
    f.seed('room', 'room')
    const linked = f.commit('link a visible note to a falsely discovered hidden master', (tx) => {
      tx.set(f.at('hiddenMaster'), { parent: f.key('room'), name: 'Hidden master' })
      tx.setInstanceMeta(f.at('hiddenMaster'), { visibility: 'ref' })
      tx.set(f.at('note').$.delegate, f.key('hiddenMaster'))
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').$.delegate.path))
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('hiddenMaster').path, {
          belief: 'known_false',
        }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    const entry = corpusEntry(f, linked.id, f.at('alice'), f.at('note').$.text.path)
    expect(entry.linkedInstancePaths).not.toContainEqual(f.at('hiddenMaster').path)
    expect(
      inspectedField(f, linked.id, f.at('alice'), f.at('hiddenMaster').$.name.path),
    ).toMatchObject({
      value: 'Hidden master',
      sourceKind: 'observed_claim',
      belief: 'known_false',
    })
  })
})

describe('perspective Map inspection expansion', () => {
  test('a root Map union keeps field-only and discovered members across an unknown off-scene deletion', () => {
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
    f.commit('observe a public archive with a custom leaf', (tx) => {
      tx.set(archives.at('tome'), {
        label: 'Tome',
        inscription: 'Remembered inscription',
        parent: f.key('room'),
      })
      tx.defineCustom(
        archives.at('tome'),
        'rune',
        s.str().desc('archived rune'),
        'remembered rune',
        { summary: 'archival runes' },
      )
      tx.set(archives.at('unseen'), {
        label: 'Unseen',
        inscription: 'UNSEEN_ARCHIVE_SECRET',
        parent: f.key('remote'),
      })
      tx.setInstanceMeta(archives.at('unseen'), { visibility: 'ref' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    f.commit('discover a hidden archive with a custom leaf', (tx) => {
      tx.set(archives.at('sealed'), {
        label: 'Sealed',
        inscription: 'Discovered inscription',
        parent: f.key('room'),
      })
      tx.setInstanceMeta(archives.at('sealed'), { visibility: 'ref' })
      tx.defineCustom(
        archives.at('sealed'),
        'rune',
        s.str().desc('sealed archive rune'),
        'discovered rune',
        { summary: 'sealed archival runes' },
      )
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), archives.at('sealed').path))
    })
    const moved = f.commit(
      'move both known archives out of sight without notifying Alice',
      (tx) => {
        tx.set(archives.at('tome').$.parent, f.key('remote'))
        tx.set(archives.at('sealed').$.parent, f.key('remote'))
      },
    )
    const deleted = f.commit('delete every archive without notifying Alice', (tx) => {
      tx.delete(archives.at('tome'))
      tx.delete(archives.at('sealed'))
      tx.delete(archives.at('unseen'))
    })

    const mapPath = archives.at('tome').path.slice(0, -1)
    const tomePath = archives.at('tome').path
    const sealedPath = archives.at('sealed').path
    const memberPaths = [sealedPath, tomePath].sort((a, b) =>
      encodePathKey(a).localeCompare(encodePathKey(b)),
    )

    const beforeMap = unwrap(f.perspective.inspect(moved.id, f.at('alice'), [mapPath]))
    const beforeMembers = unwrap(f.perspective.inspect(moved.id, f.at('alice'), memberPaths))
    expect(beforeMap).toEqual(beforeMembers)

    const afterMap = unwrap(f.perspective.inspect(deleted.id, f.at('alice'), [mapPath]))
    const afterMembers = unwrap(f.perspective.inspect(deleted.id, f.at('alice'), memberPaths))
    expect(afterMap).toEqual(beforeMap)
    expect(afterMap).toEqual(afterMembers)

    const byKey = new Map(afterMap.map((entry) => [encodePathKey(entry.path), entry] as const))
    expect(byKey.get(encodePathKey([...tomePath, 'inscription']))?.value).toBe(
      'Remembered inscription',
    )
    expect(byKey.get(encodePathKey([...tomePath, '$custom', 'rune']))?.value).toBe(
      'remembered rune',
    )
    expect(byKey.get(encodePathKey([...sealedPath, 'inscription']))?.value).toBe(
      'Discovered inscription',
    )
    expect(byKey.get(encodePathKey([...sealedPath, '$custom', 'rune']))?.value).toBe(
      'discovered rune',
    )
    for (const path of byKey.keys()) {
      expect(path.startsWith(encodePathKey(['archives', 'unseen']))).toBe(false)
    }
    expect(JSON.stringify(afterMap)).not.toContain('UNSEEN_ARCHIVE_SECRET')
  })

  test('deleting an intermediate Map cannot erase its remembered descendant from root or nested inspection', () => {
    const f = setup()
    const shelves = unwrap(
      f.schema.define(
        ['nestedArchives'],
        s.map(
          s.map(
            s.struct({
              text: s.str().desc('historical nested archive text'),
              parent: s
                .link({ targetRoots: [['entities']], onDelete: 'unlink' })
                .optional()
                .meta({ linkRoles: ['parent'], visibility: 'ref' }),
            }),
          ),
        ),
      ),
    )
    f.seed()
    const shelf = shelves.at('shelf')
    const note = shelf.at('note')
    f.commit('observe the nested archive', (tx) => {
      tx.set(shelves, {
        shelf: {
          note: { text: 'remembered across a missing intermediate Map', parent: f.key('room') },
        },
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const away = f.commit('leave the archive before its shelf disappears', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const beforeRoot = unwrap(f.perspective.inspect(away.id, f.at('alice'), [shelves.path]))
    const beforeShelf = unwrap(f.perspective.inspect(away.id, f.at('alice'), [shelf.path]))
    expect(beforeRoot).toEqual(beforeShelf)
    expect(beforeRoot[0]).toMatchObject({
      path: note.$.text.path,
      value: 'remembered across a missing intermediate Map',
      sourceKind: 'observed_claim',
    })
    const deleted = f.commit('delete the entire shelf without notifying its observer', (tx) => {
      tx.delete(shelf)
    })
    expect(unwrap(f.perspective.inspect(deleted.id, f.at('alice'), [shelves.path]))).toEqual(
      beforeRoot,
    )
    expect(unwrap(f.perspective.inspect(deleted.id, f.at('alice'), [shelf.path]))).toEqual(
      beforeShelf,
    )
    expect(unwrap(f.perspective.inspect(deleted.id, f.at('alice'), [note.path]))).toEqual(
      beforeRoot,
    )
  })
})
