import { afterEach, describe, expect, test } from 'bun:test'
import type { ObserverRef } from '@sekaisen/plugin-perspective'
import type { CommitHash, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { claimMember, PerspectiveFixture, unwrap } from './perspective-fixture.ts'

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

/** Require the restricted observer API to reject an unauthorized exact field. */
function expectNotAuthorized(
  f: PerspectiveFixture,
  id: CommitHash,
  observer: ObserverRef,
  path: Path,
): void {
  expect(f.perspective.inspect(id, observer, [path])).toMatchObject({
    ok: false,
    error: { kind: 'not_authorized' },
  })
}

/** Read one authorized field view; a missing view is a scenario failure. */
function inspectedField(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, path: Path) {
  const key = encodePathKey(path)
  const field = unwrap(f.perspective.inspect(id, observer, [path])).find(
    (entry) => encodePathKey(entry.path) === key,
  )
  if (!field) throw new Error(`Expected an authorized field view for ${key}`)
  return field
}

/** One merged instance view from an agent projection. */
function merged(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, idName: string) {
  return unwrap(f.perspective.projectView(id, observer)).mergedInstances[f.key(idName)]
}

/** Serializable agent projection used for content-leak assertions. */
function projectionJson(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef): string {
  return JSON.stringify(unwrap(f.perspective.projectView(id, observer)))
}

/** Full legal retrieval corpus used for content-leak assertions. */
function corpusJson(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef): string {
  return JSON.stringify(unwrap(f.perspective.listSearchableCorpus(id, observer)))
}

/** One corpus entry; a missing entry is a scenario failure, not an empty assertion. */
function corpusEntry(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, path: Path) {
  const key = encodePathKey(path)
  const entry = unwrap(f.perspective.listSearchableCorpus(id, observer)).find(
    (candidate) => encodePathKey(candidate.path) === key,
  )
  if (!entry) throw new Error(`Expected a corpus entry for ${key}`)
  return entry
}

describe('perspective live authorization is independent of content arbitration', () => {
  test('ordinary high-priority room knowledge does not disable either sensory channel', () => {
    const f = setup()
    const seeded = f.seed()
    expect(inspectedField(f, seeded.id, f.at('alice'), f.at('note').$.text.path).value).toBe(
      'original text',
    )
    const known = f.commit('learn the room at high priority without excluding it', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('room').path, { priority: 2000 }))
      tx.set(f.at('note').$.text, 'CURRENT_NOTE_AFTER_ROOM_KNOWLEDGE')
      tx.set(f.at('speaker'), {
        parent: f.key('room'),
        voice: 'CURRENT_SOUND_AFTER_ROOM_KNOWLEDGE',
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectedField(f, known.id, f.at('alice'), f.at('note').$.text.path)).toMatchObject({
      value: 'CURRENT_NOTE_AFTER_ROOM_KNOWLEDGE',
      sourceKind: 'direct_scope',
    })
    expect(inspectedField(f, known.id, f.at('alice'), f.at('speaker').$.voice.path)).toMatchObject({
      value: 'CURRENT_SOUND_AFTER_ROOM_KNOWLEDGE',
      sourceKind: 'direct_scope',
    })
    expect(merged(f, known.id, f.at('alice'), 'note')?.fields.text?.value).toBe(
      'CURRENT_NOTE_AFTER_ROOM_KNOWLEDGE',
    )
    expect(corpusEntry(f, known.id, f.at('alice'), f.at('note').$.text.path)).toMatchObject({
      text: 'CURRENT_NOTE_AFTER_ROOM_KNOWLEDGE',
      sourceKind: 'direct_scope',
    })
    expect(
      claimMember(f.latestObserved(known.id, 'alice', f.at('note').$.text.path), 'targetRef'),
    ).toEqual({
      commitId: known.id,
      path: f.at('note').$.text.path,
    })
  })

  test('high-priority discovery preserves live access through hidden containers and connectors', () => {
    const f = setup()
    f.seed()
    const discovered = f.commit(
      'discover a container and one-hop connector at high priority',
      (tx) => {
        tx.set(f.at('drawer'), { parent: f.key('room') })
        tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
        tx.set(f.at('drawerNote'), {
          parent: f.key('drawer'),
          text: 'LIVE_DISCOVERED_CONTAINER_TEXT',
        })
        tx.set(f.at('remoteNote'), {
          parent: f.key('remote'),
          voice: 'LIVE_DISCOVERED_CONNECTOR_SOUND',
        })
        tx.set(f.edges.at('secretWindow'), {
          from: f.key('room'),
          to: f.key('remote'),
          parent: f.key('room'),
        })
        tx.setInstanceMeta(f.edges.at('secretWindow'), { visibility: 'ref' })
        unwrap(
          f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path, { priority: 2000 }),
        )
        unwrap(
          f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('secretWindow').path, {
            priority: 2000,
          }),
        )
        unwrap(f.perspective.syncScope(tx, f.at('room')))
      },
    )
    expect(
      inspectedField(f, discovered.id, f.at('alice'), f.at('drawerNote').$.text.path),
    ).toMatchObject({
      value: 'LIVE_DISCOVERED_CONTAINER_TEXT',
      sourceKind: 'direct_scope',
    })
    expect(
      inspectedField(f, discovered.id, f.at('alice'), f.at('remoteNote').$.voice.path),
    ).toMatchObject({
      value: 'LIVE_DISCOVERED_CONNECTOR_SOUND',
      sourceKind: 'direct_scope',
    })
  })

  test('a stronger room rumor cannot revive an excluded ceiling on either channel', () => {
    const f = setup()
    f.seed('room', 'remote')
    const excluded = f.commit('exclude the room under a stronger account of it', (tx) => {
      tx.set(f.at('note').$.text, 'EXCLUDED_SCENE_SECRET')
      tx.set(f.at('speaker'), { parent: f.key('room'), voice: 'EXCLUDED_SCENE_SOUND' })
      /*
       * A claim anchored on the ceiling path itself outlives the exclusion.
       * Fold survival alone used to re-enable both channels and expose the
       * real note and speaker; memory must stay memory.
       */
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), f.at('room').path, 'RUMORED_ROOM_FACT', {
          priority: 3000,
        }),
      )
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), f.at('room').$.name.path, 'RUMORED_ROOM_NAME', {
          priority: 3000,
        }),
      )
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('room').path, { priority: 2000 }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    const noteText = f.at('note').$.text.path
    const speakerVoice = f.at('speaker').$.voice.path
    expectNotAuthorized(f, excluded.id, f.at('alice'), noteText)
    expectNotAuthorized(f, excluded.id, f.at('alice'), speakerVoice)
    expect(merged(f, excluded.id, f.at('alice'), 'note')).toBeUndefined()
    expect(merged(f, excluded.id, f.at('alice'), 'speaker')).toBeUndefined()

    const projected = projectionJson(f, excluded.id, f.at('alice'))
    const corpus = corpusJson(f, excluded.id, f.at('alice'))
    for (const secret of ['EXCLUDED_SCENE_SECRET', 'EXCLUDED_SCENE_SOUND']) {
      expect(projected).not.toContain(secret)
      expect(corpus).not.toContain(secret)
    }
    /* The stronger literal account itself is still retained as private memory. */
    expect(projected).toContain('RUMORED_ROOM_NAME')
    expect(corpusEntry(f, excluded.id, f.at('alice'), f.at('room').$.name.path)).toMatchObject({
      text: 'RUMORED_ROOM_NAME',
      sourceKind: 'rumor_claim',
    })
    expect(inspectedField(f, excluded.id, f.at('alice'), f.at('room').$.name.path)).toMatchObject({
      value: 'RUMORED_ROOM_NAME',
      sourceKind: 'rumor_claim',
    })
    /* syncScope must not persist the objective text it never perceived. */
    expect(() => f.latestObserved(excluded.id, 'alice', noteText)).toThrow()
    expect(() => f.latestObserved(excluded.id, 'alice', speakerVoice)).toThrow()
  })

  test('an exhausted adjacent root cannot leak through a public window on either channel', () => {
    const f = setup()
    f.seed('room', 'remote')
    const windowed = f.commit('mount a window into a room covered by a stronger account', (tx) => {
      tx.set(f.at('remoteNote'), { parent: f.key('remote'), text: 'ADJACENT_ROOT_SECRET' })
      tx.set(f.at('remoteSpeaker'), {
        parent: f.key('remote'),
        voice: 'ADJACENT_ROOT_SOUND',
      })
      tx.set(f.edges.at('window'), {
        name: 'Window',
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), f.at('remote').path, 'RUMORED_REMOTE_FACT', {
          priority: 3000,
        }),
      )
      unwrap(
        f.perspective.grantRumor(
          tx,
          f.at('alice'),
          f.at('remote').$.name.path,
          'RUMORED_REMOTE_NAME',
          { priority: 3000 },
        ),
      )
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('remote').path, {
          priority: 2000,
        }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    const remoteNoteText = f.at('remoteNote').$.text.path
    const remoteSpeakerVoice = f.at('remoteSpeaker').$.voice.path
    expectNotAuthorized(f, windowed.id, f.at('alice'), remoteNoteText)
    expectNotAuthorized(f, windowed.id, f.at('alice'), remoteSpeakerVoice)
    expect(merged(f, windowed.id, f.at('alice'), 'remoteNote')).toBeUndefined()
    expect(merged(f, windowed.id, f.at('alice'), 'remoteSpeaker')).toBeUndefined()

    const projected = projectionJson(f, windowed.id, f.at('alice'))
    const corpus = corpusJson(f, windowed.id, f.at('alice'))
    for (const secret of ['ADJACENT_ROOT_SECRET', 'ADJACENT_ROOT_SOUND']) {
      expect(projected).not.toContain(secret)
      expect(corpus).not.toContain(secret)
    }
    expect(projected).toContain('RUMORED_REMOTE_NAME')
    expect(corpusEntry(f, windowed.id, f.at('alice'), f.at('remote').$.name.path)).toMatchObject({
      text: 'RUMORED_REMOTE_NAME',
      sourceKind: 'rumor_claim',
    })
    expect(inspectedField(f, windowed.id, f.at('alice'), f.at('remote').$.name.path)).toMatchObject(
      { value: 'RUMORED_REMOTE_NAME', sourceKind: 'rumor_claim' },
    )
    expect(() => f.latestObserved(windowed.id, 'alice', remoteNoteText)).toThrow()
    expect(() => f.latestObserved(windowed.id, 'alice', remoteSpeakerVoice)).toThrow()
  })

  test('a super-excluded discovered container or connector stays memory', () => {
    const f = setup()
    f.seed('room', 'room')
    const discovered = f.commit('discover then exclude a concealed container and edge', (tx) => {
      tx.set(f.at('cabinet'), { parent: f.key('room'), name: 'Cabinet' })
      tx.set(f.at('cabinetNote'), { parent: f.key('cabinet'), text: 'HIDDEN_CONTAINER_SECRET' })
      tx.set(f.at('cabinetSpeaker'), {
        parent: f.key('cabinet'),
        voice: 'HIDDEN_CONTAINER_SOUND',
      })
      tx.setInstanceMeta(f.at('cabinet'), { visibility: 'ref' })
      tx.set(f.at('vault'), { name: 'Vault' })
      tx.set(f.at('vaultNote'), { parent: f.key('vault'), text: 'HIDDEN_EDGE_SECRET' })
      tx.set(f.at('vaultSpeaker'), { parent: f.key('vault'), voice: 'HIDDEN_EDGE_SOUND' })
      tx.set(f.edges.at('sealedWindow'), {
        name: 'Sealed window',
        from: f.key('room'),
        to: f.key('vault'),
        parent: f.key('room'),
      })
      tx.setInstanceMeta(f.edges.at('sealedWindow'), { visibility: 'ref' })
      /*
       * Stronger discovery records outlive the later exclusion. They remain
       * valid knowledge, but no content claim can cancel a super-exclusion,
       * so neither the hidden container nor the hidden connector may reveal
       * its real contents.
       */
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('cabinet').path, { priority: 3000 }),
      )
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('sealedWindow').path, {
          priority: 3000,
        }),
      )
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('cabinet').path, { priority: 2000 }),
      )
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.edges.at('sealedWindow').path, {
          priority: 2000,
        }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    const secrets = [
      'HIDDEN_CONTAINER_SECRET',
      'HIDDEN_CONTAINER_SOUND',
      'HIDDEN_EDGE_SECRET',
      'HIDDEN_EDGE_SOUND',
    ] as const
    const cabinetNoteText = f.at('cabinetNote').$.text.path
    for (const path of [
      cabinetNoteText,
      f.at('cabinetSpeaker').$.voice.path,
      f.at('vaultNote').$.text.path,
      f.at('vaultSpeaker').$.voice.path,
    ])
      expectNotAuthorized(f, discovered.id, f.at('alice'), path)
    for (const idName of ['cabinetNote', 'cabinetSpeaker', 'vaultNote', 'vaultSpeaker'])
      expect(merged(f, discovered.id, f.at('alice'), idName)).toBeUndefined()

    const projected = projectionJson(f, discovered.id, f.at('alice'))
    const corpus = corpusJson(f, discovered.id, f.at('alice'))
    for (const secret of secrets) {
      expect(projected).not.toContain(secret)
      expect(corpus).not.toContain(secret)
    }
    /* The discoveries themselves remain readable memory, never present sight. */
    expect(
      inspectedField(f, discovered.id, f.at('alice'), f.at('cabinet').$.name.path),
    ).toMatchObject({ value: 'Cabinet', sourceKind: 'observed_claim' })
    expect(
      inspectedField(f, discovered.id, f.at('alice'), f.edges.at('sealedWindow').$.name.path),
    ).toMatchObject({ value: 'Sealed window', sourceKind: 'observed_claim' })
    expect(() => f.latestObserved(discovered.id, 'alice', cabinetNoteText)).toThrow()
  })

  test('a whole-tree exclusion hides default live and learned fields but keeps a literal', () => {
    const f = setup()
    f.seed('room', 'room')
    const learned = f.commit('learn the note by ordinary sight', (tx) => {
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const excluded = f.commit('exclude the whole tree but keep a stronger literal', (tx) => {
      tx.set(f.at('note').$.text, 'REAL_CURRENT_SECRET')
      tx.set(f.at('note').$.voice, 'REAL_CURRENT_SOUND')
      unwrap(
        f.perspective.grantRumor(
          tx,
          f.at('alice'),
          f.at('note').$.text.path,
          'RUMORED_LITERAL_TEXT',
          { priority: 3000 },
        ),
      )
      unwrap(f.perspective.excludeKnowledge(tx, f.at('alice'), [], { priority: 2000 }))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    const literal = inspectedField(f, excluded.id, f.at('alice'), f.at('note').$.text.path)
    expect(literal).toMatchObject({
      value: 'RUMORED_LITERAL_TEXT',
      sourceKind: 'rumor_claim',
    })
    expect(literal.additionalFacets).toEqual([])
    /* Default-priority live perception and the earlier learned claims are gone. */
    expectNotAuthorized(f, excluded.id, f.at('alice'), f.at('note').$.name.path)
    expectNotAuthorized(f, excluded.id, f.at('alice'), f.at('note').$.voice.path)
    expectNotAuthorized(f, excluded.id, f.at('alice'), f.at('room').$.name.path)

    const projected = projectionJson(f, excluded.id, f.at('alice'))
    const corpus = corpusJson(f, excluded.id, f.at('alice'))
    for (const secret of ['REAL_CURRENT_SECRET', 'REAL_CURRENT_SOUND', 'original text']) {
      expect(projected).not.toContain(secret)
      expect(corpus).not.toContain(secret)
    }
    expect(projected).toContain('RUMORED_LITERAL_TEXT')
    expect(corpusEntry(f, excluded.id, f.at('alice'), f.at('note').$.text.path)).toMatchObject({
      text: 'RUMORED_LITERAL_TEXT',
      sourceKind: 'rumor_claim',
    })
    /* syncScope runs under the same empty-prefix exclusion and persists nothing new. */
    expect(() => f.latestObserved(excluded.id, 'alice', f.at('note').$.voice.path)).toThrow()
    expect(f.latestObserved(excluded.id, 'alice', f.at('note').$.text.path)).toBeDefined()
    expect(f.latestObserved(learned.id, 'alice', f.at('note').$.text.path)).toBeDefined()
  })

  test('an inherited whole-tree exclusion filters inherited and personal claims', () => {
    const f = setup()
    f.seed('room', 'room')
    f.commit('learn the note by ordinary sight', (tx) => {
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const inherited = f.commit('inherit an organization that excluded the whole tree', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, 'org:silent', {}))
      unwrap(f.perspective.excludeKnowledge(tx, 'org:silent', [], { priority: 2000 }))
      unwrap(
        f.perspective.grantRumor(tx, 'org:silent', f.at('note').$.text.path, 'INHERITED_LITERAL', {
          priority: 3000,
        }),
      )
      unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: ['org:silent'] }))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })

    const literal = inspectedField(f, inherited.id, f.at('alice'), f.at('note').$.text.path)
    expect(literal).toMatchObject({ value: 'INHERITED_LITERAL', sourceKind: 'rumor_claim' })
    /* The personal learned claim at default priority is filtered by the inherited mask. */
    expect(literal.additionalFacets).toEqual([])
    expectNotAuthorized(f, inherited.id, f.at('alice'), f.at('note').$.name.path)
    expectNotAuthorized(f, inherited.id, f.at('alice'), f.at('room').$.name.path)

    const projected = projectionJson(f, inherited.id, f.at('alice'))
    const corpus = corpusJson(f, inherited.id, f.at('alice'))
    expect(projected).not.toContain('original text')
    expect(corpus).not.toContain('original text')
    expect(projected).toContain('INHERITED_LITERAL')
    expect(corpusEntry(f, inherited.id, f.at('alice'), f.at('note').$.text.path)).toMatchObject({
      text: 'INHERITED_LITERAL',
      sourceKind: 'rumor_claim',
    })
  })

  test('super-exclusions use the observer default priority, not a hard-coded threshold', () => {
    const f = setup()
    f.seed()
    const equal = f.commit('allow reacquisition at the root default priority', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { defaultPriority: 1500 }))
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('note').path, { priority: 1500 }),
      )
      tx.set(f.at('note').$.text, 'REACQUIRED_AT_CUSTOM_DEFAULT')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectedField(f, equal.id, f.at('alice'), f.at('note').$.text.path)).toMatchObject({
      value: 'REACQUIRED_AT_CUSTOM_DEFAULT',
      sourceKind: 'direct_scope',
    })
    const excluded = f.commit('exclude above the default despite stronger room knowledge', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('note').path, { priority: 1501 }),
      )
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('room').path, { priority: 2000 }))
      tx.set(f.at('note').$.text, 'BLOCKED_ABOVE_CUSTOM_DEFAULT')
    })
    expectNotAuthorized(f, excluded.id, f.at('alice'), f.at('note').$.text.path)
  })

  test('a publicly present but excluded observer is not a co-witness', () => {
    const f = setup()
    f.seed('room', 'room')
    const synced = f.commit(
      'sync with one excluded witness and one high-priority knowledgeable witness',
      (tx) => {
        tx.set(f.at('charlie'), { parent: f.key('room'), name: 'Charlie' })
        unwrap(f.perspective.configurePerspective(tx, f.at('charlie'), {}))
        unwrap(
          f.perspective.grantKnowledge(tx, f.at('charlie'), f.at('room').path, { priority: 2000 }),
        )
        unwrap(
          f.perspective.excludeKnowledge(tx, f.at('bob'), f.at('note').path, { priority: 2000 }),
        )
        unwrap(f.perspective.syncScope(tx, f.at('room')))
      },
    )
    expectNotAuthorized(f, synced.id, f.at('bob'), f.at('note').$.text.path)
    expect(inspectedField(f, synced.id, f.at('charlie'), f.at('note').$.text.path).sourceKind).toBe(
      'direct_scope',
    )
    const aliceClaim = f.latestObserved(synced.id, 'alice', f.at('note').$.text.path)
    expect(claimMember(aliceClaim, 'coWitnesses')).toEqual([f.key('charlie')])
  })

  test('co-witness exclusions are inherited, field-specific and channel-specific despite surviving fiction', () => {
    const f = setup()
    f.seed('room', 'room')
    const synced = f.commit(
      'Bob can hear the note but cannot see its excluded inscription',
      (tx) => {
        tx.set(f.at('note').$.voice, 'A_PUBLIC_NOTE_SOUND')
        unwrap(f.perspective.configurePerspective(tx, 'org:restricted', {}))
        unwrap(
          f.perspective.excludeKnowledge(tx, 'org:restricted', f.at('note').$.text.path, {
            priority: 2000,
          }),
        )
        unwrap(
          f.perspective.configurePerspective(tx, f.at('bob'), { inherits: ['org:restricted'] }),
        )
        unwrap(
          f.perspective.grantRumor(tx, f.at('bob'), f.at('note').$.text.path, 'PRIVATE_FICTION', {
            priority: 3000,
          }),
        )
        unwrap(f.perspective.syncScope(tx, f.at('room')))
      },
    )
    expect(inspectedField(f, synced.id, f.at('bob'), f.at('note').$.text.path)).toMatchObject({
      value: 'PRIVATE_FICTION',
      sourceKind: 'rumor_claim',
    })
    expect(
      claimMember(f.latestObserved(synced.id, 'alice', f.at('note').$.text.path), 'coWitnesses'),
    ).toEqual([])
    expect(
      claimMember(f.latestObserved(synced.id, 'alice', f.at('note').$.voice.path), 'coWitnesses'),
    ).toEqual([f.key('bob')])
    expect(inspectedField(f, synced.id, f.at('bob'), f.at('note').$.voice.path)).toMatchObject({
      value: 'A_PUBLIC_NOTE_SOUND',
      sourceKind: 'direct_scope',
    })
  })
})
