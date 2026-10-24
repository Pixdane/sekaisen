import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import type { ObserverRef, SearchableCorpusEntry } from '@sekaisen/plugin-perspective'
import { PerspectiveService } from '@sekaisen/plugin-perspective'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'
import {
  claimMember,
  fromCommit,
  PerspectiveFixture,
  present,
  unwrap,
} from './perspective-fixture.ts'

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

/** Read one fully expanded field through the restricted observer-facing API. */
function inspectField(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, path: Path) {
  const fields = unwrap(f.perspective.inspect(id, observer, [path]))
  const field = fields.find((entry) => encodePathKey(entry.path) === encodePathKey(path))
  if (!field) throw new Error('Expected the authorized field in inspect output')
  return field
}

/** Normalize only the explicitly permitted live commit coordinates for non-interference. */
function normalizeCorpus(entries: readonly SearchableCorpusEntry[]) {
  return entries.map((entry) =>
    entry.sourceKind === 'direct_scope' || entry.sourceKind === 'self_owned'
      ? { ...entry, factCommitId: '<live>', acquiredAtCommitId: '<live>' }
      : entry,
  )
}

describe('perspective knowledge and source causality', () => {
  test('backfilled observations and later transfers preserve fact time, acquisition time and real source coordinates', () => {
    const f = setup()
    const seed = f.seed()
    const path = f.at('note').$.text.path
    const learned = f.commit('record an earlier observation', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), path, {
          atCommitId: seed.id,
          acquiredAtCommitId: seed.id,
        }),
      )
    })
    const original = f.latestObserved(learned.id, 'alice', path)
    const origin = claimMember(original, 'originEventRef') as StateRef
    expect(origin.commitId).toBe(learned.id)
    expect(present(unwrap(f.schema.inspectInstance(origin.commitId, origin.path))).nodeKind).toBe(
      'struct',
    )
    const changed = f.commit('change the unwitnessed truth', (tx) => {
      tx.set(f.at('note').$.text, 'new unknown truth')
    })
    const old = inspectField(f, changed.id, f.at('alice'), path)
    expect(old).toMatchObject({
      value: 'original text',
      sourceKind: 'observed_claim',
      at: some(seed.id),
      acquiredAt: some(seed.id),
    })
    const relayed = f.commit('tell Bob the old observation', (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), path))
    })
    expect(inspectField(f, relayed.id, f.at('bob'), path)).toMatchObject({
      value: 'original text',
      at: some(seed.id),
      acquiredAt: some(relayed.id),
    })
    expect(claimMember(f.latestObserved(relayed.id, 'bob', path), 'originEventRef')).toEqual(origin)
  })

  test('rumors losslessly retain mixed scalar lists and do not confuse backfill storage with story time', () => {
    const f = setup()
    const seed = f.seed()
    const value: Value = [1, 'a false account', null, new Uint8Array([0, 255]), false]
    const target: Path = ['entities', 'imaginary', 'text']
    const rumor = f.commit('backfill an old rumor', (tx) => {
      unwrap(
        f.perspective.grantRumor(tx, f.at('alice'), target, value, {
          atCommitId: seed.id,
          acquiredAtCommitId: seed.id,
        }),
      )
    })
    expect(inspectField(f, rumor.id, f.at('alice'), target)).toMatchObject({
      value,
      sourceKind: 'rumor_claim',
      at: some(seed.id),
      acquiredAt: some(seed.id),
    })
    const onward = f.commit('relay the encoded rumor', (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), target))
    })
    expect(inspectField(f, onward.id, f.at('bob'), target)).toMatchObject({
      value,
      at: some(seed.id),
      acquiredAt: some(onward.id),
    })
  })

  test('independent rumors in one commit remain separate despite the same claimed relay name', () => {
    const f = setup()
    f.seed()
    const target: Path = ['entities', 'imaginary', 'text']
    f.commit('two independent sources', (tx) => {
      tx.set(f.at('carol'), { name: 'Carol', parent: f.key('remote') })
      unwrap(f.perspective.configurePerspective(tx, f.at('carol'), {}))
      unwrap(f.perspective.grantRumor(tx, f.at('alice'), target, 'the same claim'))
      unwrap(f.perspective.grantRumor(tx, f.at('bob'), target, 'the same claim'))
    })
    const told = f.commit('two reports with one public name', (tx) => {
      unwrap(
        f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('carol'), target, {
          claimedSource: 'a messenger',
          override: false,
        }),
      )
      unwrap(
        f.perspective.propagateKnowledge(tx, f.at('bob'), f.at('carol'), target, {
          claimedSource: 'a messenger',
          override: false,
        }),
      )
    })
    const observed = inspectField(f, told.id, f.at('carol'), target)
    expect(observed.value).toBe('the same claim')
    expect(observed.additionalFacets).toHaveLength(1)
    expect(observed.sources).toEqual(['a messenger'])
    expect(observed.additionalFacets[0]).toMatchObject({
      value: 'the same claim',
      sources: ['a messenger'],
    })
  })

  test('same-origin override reports retain all relays rather than fabricating independent evidence', () => {
    const f = setup()
    const seed = f.seed()
    const path = f.at('note').$.text.path
    f.commit('Alice remembers before leaving', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), path, { atCommitId: seed.id }))
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const told = f.commit('two relays of one observation', (tx) => {
      for (const claimedSource of ['first relay', 'second relay']) {
        unwrap(
          f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), path, {
            override: true,
            claimedSource,
          }),
        )
      }
    })
    const field = inspectField(f, told.id, f.at('bob'), path)
    expect(field.value).toBe('original text')
    expect(field.sources).toEqual(['first relay', 'second relay'])
    expect(field.additionalFacets).toEqual([])
  })

  test('a personal forwarded observation does not suppress the first independent eyewitness origin', () => {
    const f = setup()
    const seed = f.seed()
    const path = f.at('note').$.text.path
    f.commit('Bob obtains a historical observation', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('bob'), path, { atCommitId: seed.id }))
      unwrap(f.perspective.propagateKnowledge(tx, f.at('bob'), f.at('alice'), path))
    })
    const seen = f.commit('Alice now sees for herself', (tx) => {
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const actual = f.latestObserved(seen.id, 'alice', path)
    expect(claimMember(actual, 'eventRef')).toEqual({ commitId: seen.id, path: ['$message'] })
    const ownOrigin = claimMember(actual, 'originEventRef') as StateRef
    expect(ownOrigin.commitId).toBe(seen.id)
    expect(ownOrigin.path.slice(0, 3)).toEqual(['perspectives', f.key('alice'), 'observedClaims'])
    expect(actual.fields.source).toEqual(NONE)
  })

  test('a salient personal observation survives loss of an inherited organization view', () => {
    const f = setup()
    const seed = f.seed()
    const path = f.at('note').$.text.path
    f.commit('share the organization archive', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, 'org:archive', {}))
      unwrap(f.perspective.grantKnowledge(tx, 'org:archive', path, { atCommitId: seed.id }))
      unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: ['org:archive'] }))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const left = f.commit('leave the organization and room', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('alice'), { inherits: [] }))
      tx.set(f.at('alice').$.parent, f.key('remote'))
      tx.set(f.at('note').$.text, 'later unseen value')
    })
    expect(inspectField(f, left.id, f.at('alice'), path)).toMatchObject({
      value: 'original text',
      sourceKind: 'observed_claim',
    })
    const origin = claimMember(
      f.latestObserved(left.id, 'alice', path),
      'originEventRef',
    ) as StateRef
    expect(origin.path[1]).toBe(f.key('alice'))
  })
})

describe('perspective perception, attention and public witnesses', () => {
  test('passive details stay inspectable without automatic memory, and focus never persists ephemeral fields', () => {
    const f = setup()
    f.seed()
    const before = f.commit('walk past two details', (tx) => {
      tx.set(f.at('note').$.passiveText, 'a passive inscription')
      tx.set(f.at('note').$.ephemeralText, 'a momentary gesture')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const passive = f.at('note').$.passiveText.path
    const ephemeral = f.at('note').$.ephemeralText.path
    expect(inspectField(f, before.id, f.at('alice'), passive).value).toBe('a passive inscription')
    const walkedAway = f.commit('walk away without focusing', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    expect(f.perspective.inspect(walkedAway.id, f.at('alice'), [passive])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const focused = f.commit('return and examine the inscription', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('room'))
      unwrap(f.perspective.syncScope(tx, f.at('room'), { focusedPaths: [passive, ephemeral] }))
      expect(f.perspective.grantKnowledge(tx, f.at('alice'), ephemeral)).toMatchObject({
        ok: false,
        error: { kind: 'invalid_claim_target' },
      })
      expect(
        f.perspective.grantRumor(tx, f.at('alice'), ephemeral, 'a fake gesture'),
      ).toMatchObject({
        ok: false,
        error: { kind: 'invalid_claim_target' },
      })
    })
    const departed = f.commit('leave after focusing', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    expect(inspectField(f, departed.id, f.at('alice'), passive)).toMatchObject({
      value: 'a passive inscription',
      at: some(focused.id),
    })
    expect(f.perspective.inspect(departed.id, f.at('alice'), [ephemeral])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })

  test('closet vision and hearing have independent ceilings and a blind actor still hears outside', () => {
    const f = setup()
    f.seed()
    const inside = f.commit('enter a visually closed closet', (tx) => {
      tx.set(f.at('closet'), { parent: f.key('room') })
      tx.setInstanceMeta(f.at('closet'), { sightOpen: false, soundOpen: true })
      tx.set(f.at('insideNote'), { parent: f.key('closet'), text: 'inside the closet' })
      tx.set(f.at('speaker'), { parent: f.key('room'), voice: 'audible outside' })
      tx.set(f.at('alice').$.parent, f.key('closet'))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectField(f, inside.id, f.at('alice'), f.at('insideNote').$.text.path).value).toBe(
      'inside the closet',
    )
    expect(inspectField(f, inside.id, f.at('alice'), f.at('speaker').$.voice.path).value).toBe(
      'audible outside',
    )
    expect(
      f.perspective.inspect(inside.id, f.at('alice'), [f.at('note').$.text.path]),
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    expect(unwrap(f.perspective.projectView(inside.id, f.at('alice'))).scenePublic).toEqual(NONE)
    const blind = f.commit('blindfold the actor but preserve hearing', (tx) => {
      tx.setInstanceMeta(f.at('alice'), { sightEnabled: false, soundEnabled: true })
      tx.set(f.at('speaker').$.voice, 'a new sound')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectField(f, blind.id, f.at('alice'), f.at('speaker').$.voice.path)).toMatchObject({
      value: 'a new sound',
      sourceKind: 'direct_scope',
    })
    expect(unwrap(f.perspective.projectView(blind.id, f.at('alice'))).scenePublic).toEqual(NONE)
  })

  test('entity discovery has a valid self origin even when it creates no surface field observations', () => {
    const f = setup()
    f.seed()
    const discovery = f.commit('discover an unnamed hidden drawer', (tx) => {
      tx.set(f.at('drawer'), { parent: f.key('room') })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path))
    })
    const recordPath = ['perspectives', f.key('alice'), 'discoveredEntities', f.key('drawer')]
    const stored = present(unwrap(f.schema.inspectInstance(discovery.id, recordPath)))
    if (stored.nodeKind !== 'struct') throw new Error('Expected discovery record')
    expect(claimMember(stored, 'originEventRef')).toEqual({
      commitId: discovery.id,
      path: recordPath,
    })
    expect(
      unwrap(f.schema.resolveRef(claimMember(stored, 'originEventRef') as StateRef)),
    ).toMatchObject({
      targetKind: 'state_node',
      inspection: { kind: 'some', value: { nodeKind: 'struct' } },
    })
  })

  test('discovered hidden containers include surface children and closing them freezes historical knowledge', () => {
    const f = setup()
    f.seed('room', 'room')
    const discovered = f.commit('discover an open hidden drawer', (tx) => {
      tx.set(f.at('drawer'), { parent: f.key('room') })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
      tx.set(f.at('insideNote'), { parent: f.key('drawer'), text: 'a hidden old note' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const path = f.at('insideNote').$.text.path
    expect(inspectField(f, discovered.id, f.at('alice'), path).value).toBe('a hidden old note')
    expect(f.perspective.inspect(discovered.id, f.at('bob'), [path])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const closed = f.commit('close the drawer and change its contents', (tx) => {
      tx.setInstanceMeta(f.at('drawer'), { containerOpen: false })
      tx.set(f.at('insideNote').$.text, 'a hidden new note')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectField(f, closed.id, f.at('alice'), path)).toMatchObject({
      value: 'a hidden old note',
      sourceKind: 'observed_claim',
      at: some(discovered.id),
    })
  })

  test('historical entity discovery expands the fact snapshot after the current entity was deleted', () => {
    const f = setup()
    f.seed()
    const fact = f.commit('store an undiscovered historical drawer', (tx) => {
      tx.set(f.at('drawer'), { parent: f.key('room'), text: 'a historical drawer inscription' })
      tx.setInstanceMeta(f.at('drawer'), { visibility: 'ref' })
    })
    const acquired = f.commit('discover the old drawer only after its deletion', (tx) => {
      tx.delete(f.at('drawer'))
      unwrap(
        f.perspective.grantKnowledge(tx, f.at('alice'), f.at('drawer').path, {
          atCommitId: fact.id,
        }),
      )
    })
    expect(inspectField(f, acquired.id, f.at('alice'), f.at('drawer').$.text.path)).toMatchObject({
      value: 'a historical drawer inscription',
      sourceKind: 'observed_claim',
      at: some(fact.id),
      acquiredAt: some(acquired.id),
    })
    const discoveryPath = ['perspectives', f.key('alice'), 'discoveredEntities', f.key('drawer')]
    const discovery = present(unwrap(f.schema.inspectInstance(acquired.id, discoveryPath)))
    if (discovery.nodeKind !== 'struct') throw new Error('Expected historical discovery record')
    expect(claimMember(discovery, 'targetRef')).toEqual({
      commitId: fact.id,
      path: f.at('drawer').path,
    })
  })

  test('public link fields expose their encoded endpoints without granting private target access', () => {
    const f = setup()
    f.seed()
    const connected = f.commit('open a public sensory doorway', (tx) => {
      tx.set(f.at('remote').$.privateText, 'private information behind the endpoint')
      tx.set(f.edges.at('doorway'), {
        name: 'An open doorway',
        from: f.key('room'),
        to: f.key('remote'),
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const fromPath = f.edges.at('doorway').$.from.path
    expect(inspectField(f, connected.id, f.at('alice'), fromPath)).toMatchObject({
      value: f.key('room'),
      sourceKind: 'direct_scope',
    })
    const projection = unwrap(f.perspective.projectView(connected.id, f.at('alice')))
    const edge = projection.mergedInstances[encodePathKey(f.edges.at('doorway').path)]
    expect(edge?.fields.to?.value).toBe(f.key('remote'))
    expect(
      f.perspective.inspect(connected.id, f.at('alice'), [f.at('remote').$.privateText.path]),
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })

  test('a discovered hidden sense connector remains private and its outer closed container blocks it', () => {
    const f = setup()
    f.seed('room', 'room')
    const looking = f.commit('look through a personal hidden connector', (tx) => {
      tx.set(f.at('housing'), { parent: f.key('room') })
      tx.set(f.at('remoteNote'), {
        parent: f.key('remote'),
        text: 'private view through connector',
      })
      tx.set(f.edges.at('window'), {
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('housing'),
      })
      tx.setInstanceMeta(f.edges.at('window'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('window').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const path = f.at('remoteNote').$.text.path
    expect(inspectField(f, looking.id, f.at('alice'), path).sourceKind).toBe('direct_scope')
    expect(f.perspective.inspect(looking.id, f.at('bob'), [path])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const alicePublic = unwrap(f.perspective.projectView(looking.id, f.at('alice'))).scenePublic
    if (alicePublic.kind === 'some')
      expect(JSON.stringify(alicePublic.value)).not.toContain('private view through connector')
    const blocked = f.commit('close the connector housing', (tx) => {
      tx.setInstanceMeta(f.at('housing'), { containerOpen: false })
      tx.set(f.at('remoteNote').$.text, 'unseen replacement')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectField(f, blocked.id, f.at('alice'), path)).toMatchObject({
      value: 'private view through connector',
      sourceKind: 'observed_claim',
      at: some(looking.id),
    })
  })

  test('public body witnesses do not reveal a delegate master or exclude a blind hearing witness', () => {
    const f = setup()
    f.seed('room', 'room')
    const seen = f.commit('publicly hear a sound with a masked body', (tx) => {
      tx.set(f.at('master'), { name: 'Secret master' })
      tx.set(f.at('masked'), {
        name: 'Masked visitor',
        parent: f.key('room'),
        delegate: f.key('master'),
      })
      tx.set(f.at('speaker'), { parent: f.key('room'), voice: 'shared sound' })
      tx.setInstanceMeta(f.at('bob'), { sightEnabled: false, soundEnabled: true })
      unwrap(f.perspective.configurePerspective(tx, f.at('masked'), {}))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const witnesses = claimMember(
      f.latestObserved(seen.id, 'alice', f.at('speaker').$.voice.path),
      'coWitnesses',
    )
    expect(witnesses).toContain(f.key('bob'))
    expect(witnesses).toContain(f.key('masked'))
    expect(witnesses).not.toContain(f.key('master'))
  })

  test('witnesses are independent of refresh batch and new witnesses refresh an unchanged fact', () => {
    const f = setup()
    const seed = f.seed('room', 'room')
    const arranged = f.commit('Alice enters an open inner container', (tx) => {
      tx.set(f.at('openA'), { parent: f.key('room') })
      tx.set(f.at('alice').$.parent, f.key('openA'))
    })
    const path = f.at('note').$.text.path
    const narrow = unwrap(
      f.schema.commit(fromCommit(arranged.id, 'refresh inner actors'), (tx) => {
        unwrap(f.perspective.syncScope(tx, f.at('openA')))
      }),
    )
    const broad = unwrap(
      f.schema.commit(fromCommit(arranged.id, 'refresh all room actors'), (tx) => {
        unwrap(f.perspective.syncScope(tx, f.at('room')))
      }),
    )
    expect(claimMember(f.latestObserved(narrow.id, 'alice', path), 'coWitnesses')).toEqual(
      claimMember(f.latestObserved(broad.id, 'alice', path), 'coWitnesses'),
    )
    expect(claimMember(f.latestObserved(narrow.id, 'alice', path), 'coWitnesses')).toContain(
      f.key('bob'),
    )
    const alone = unwrap(
      f.schema.commit(fromCommit(seed.id, 'Alice observes alone'), (tx) => {
        tx.set(f.at('bob').$.parent, f.key('remote'))
        unwrap(f.perspective.syncScope(tx, f.at('room')))
      }),
    )
    const joined = unwrap(
      f.schema.commit(fromCommit(alone.id, 'Bob joins the unchanged scene'), (tx) => {
        tx.set(f.at('bob').$.parent, f.key('room'))
        unwrap(f.perspective.syncScope(tx, f.at('room')))
      }),
    )
    const refreshed = f.latestObserved(joined.id, 'alice', path)
    expect(claimMember(refreshed, 'eventRef')).toEqual({ commitId: joined.id, path: ['$message'] })
    expect(claimMember(refreshed, 'coWitnesses')).toContain(f.key('bob'))
  })
})

describe('perspective isolation and ownership', () => {
  test('unknown remote edits and deletions cannot change views, corpus or inspection errors', () => {
    const f = setup()
    f.seed()
    const initial = f.commit('establish a visible world and remote secret', (tx) => {
      tx.set(f.at('secret'), { parent: f.key('remote'), text: 'UNSEEN_SECRET_ORIGINAL' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const edited = unwrap(
      f.schema.commit(fromCommit(initial.id, 'edit only an unknown secret'), (tx) => {
        tx.set(f.at('secret').$.text, 'UNSEEN_SECRET_REPLACEMENT')
      }),
    )
    const deleted = unwrap(
      f.schema.commit(fromCommit(initial.id, 'delete only an unknown secret'), (tx) => {
        tx.delete(f.at('secret'))
      }),
    )
    const originalView = unwrap(f.perspective.projectView(initial.id, f.at('alice')))
    const originalCorpus = normalizeCorpus(
      unwrap(f.perspective.listSearchableCorpus(initial.id, f.at('alice'))),
    )
    const originalError = f.perspective.inspect(initial.id, f.at('alice'), [
      f.at('secret').$.text.path,
    ])
    expect(originalError).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    for (const version of [edited, deleted]) {
      expect(unwrap(f.perspective.projectView(version.id, f.at('alice')))).toEqual(originalView)
      expect(
        normalizeCorpus(unwrap(f.perspective.listSearchableCorpus(version.id, f.at('alice')))),
      ).toEqual(originalCorpus)
      expect(
        f.perspective.inspect(version.id, f.at('alice'), [f.at('secret').$.text.path]),
      ).toEqual(originalError)
    }
  })

  test('hallucination survives a weaker prefix mask and cannot leak the objective shared block', () => {
    const f = setup()
    f.seed()
    const changed = f.commit('mask the truth and impose a stronger hallucination', (tx) => {
      tx.set(f.at('note').$.text, 'CONFIDENTIAL_OBJECTIVE_TRUTH_7C91')
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('note').path, { priority: 1500 }),
      )
      unwrap(
        f.perspective.grantRumor(
          tx,
          f.at('alice'),
          f.at('note').$.text.path,
          'subjective blue door',
          {
            priority: 2000,
            override: true,
            belief: 'believed',
          },
        ),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const projected = unwrap(f.perspective.projectView(changed.id, f.at('alice')))
    expect(projected.scenePublic).toEqual(NONE)
    expect(JSON.stringify(projected)).not.toContain('CONFIDENTIAL_OBJECTIVE_TRUTH_7C91')
    expect(inspectField(f, changed.id, f.at('alice'), f.at('note').$.text.path).value).toBe(
      'subjective blue door',
    )
    const adjudicated = unwrap(
      f.perspective.inspectForAdjudication(changed.id, f.at('alice'), [f.at('note').$.text.path]),
    )[0]
    expect(adjudicated).toMatchObject({
      authorized: true,
      subjective: { kind: 'some', value: { value: 'subjective blue door' } },
      objective: {
        kind: 'some',
        value: { nodeKind: 'leaf', value: 'CONFIDENTIAL_OBJECTIVE_TRUTH_7C91' },
      },
      matchesObjectiveTruth: false,
    })
    const hostPublic = unwrap(f.perspective.projectScopePublic(changed.id, f.at('room')))
    expect(hostPublic.instances[f.key('note')]?.fields.text?.value).toBe(
      'CONFIDENTIAL_OBJECTIVE_TRUTH_7C91',
    )
  })

  test('restricted facade binds observer identity and reads never materialize memory or move heads', () => {
    const f = setup()
    const seeded = f.seed('room', 'room')
    const privateState = f.commit('give Bob a private object', (tx) => {
      tx.set(f.at('diary'), {
        parent: f.key('room'),
        owner: f.key('bob'),
        privateText: 'BOBS_PRIVATE_DIARY',
      })
    })
    const facade = unwrap(f.perspective.asObserver(privateState.id, f.at('alice')))
    const before = unwrap(f.schema.inspectInstance(privateState.id, ['perspectives']))
    const head = f.world.getHead('main')
    expect(
      facade.inspect.call({ rootPerspectiveId: f.key('bob') }, [f.at('diary').$.privateText.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    unwrap(facade.projectView())
    unwrap(facade.listSearchableCorpus())
    expect(f.world.getHead('main')).toEqual(head)
    expect(unwrap(f.schema.inspectInstance(privateState.id, ['perspectives']))).toEqual(before)
    expect(
      inspectField(f, privateState.id, f.at('bob'), f.at('diary').$.privateText.path),
    ).toMatchObject({
      value: 'BOBS_PRIVATE_DIARY',
      sourceKind: 'self_owned',
      at: NONE,
      acquiredAt: NONE,
    })
    expect(unwrap(f.perspective.projectView(seeded.id, f.at('alice'))).rootPerspectiveId).toBe(
      f.key('alice'),
    )
  })

  test('ownership grants self fields but never ref secrets or remote surface truth, and bodyless minds cannot perceive', () => {
    const f = setup()
    f.seed()
    const state = f.commit('separate ownership from perception', (tx) => {
      tx.set(f.at('ownedBox'), {
        parent: f.key('remote'),
        owner: f.key('alice'),
        text: 'a remote surface change',
        privateText: 'an authorized private state',
        hiddenText: 'a secret even the owner does not know',
      })
      unwrap(f.perspective.configurePerspective(tx, 'org:bodyless', {}))
      expect(
        f.perspective.propagateKnowledge(
          tx,
          f.at('alice'),
          f.at('bob'),
          f.at('ownedBox').$.hiddenText.path,
        ),
      ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    })
    expect(
      inspectField(f, state.id, f.at('alice'), f.at('ownedBox').$.privateText.path),
    ).toMatchObject({
      value: 'an authorized private state',
      sourceKind: 'self_owned',
    })
    for (const path of [f.at('ownedBox').$.text.path, f.at('ownedBox').$.hiddenText.path])
      expect(f.perspective.inspect(state.id, f.at('alice'), [path])).toMatchObject({
        ok: false,
        error: { kind: 'not_authorized' },
      })
    expect(
      f.perspective.inspect(state.id, 'org:bodyless', [f.at('note').$.text.path]),
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    expect(inspectField(f, state.id, f.at('bob'), f.at('ownedBox').$.text.path).sourceKind).toBe(
      'direct_scope',
    )
    const view = unwrap(f.perspective.projectView(state.id, f.at('alice')))
    expect(view.mergedInstances[f.key('ownedBox')]?.fields).toEqual({
      privateText: expect.objectContaining({ value: 'an authorized private state' }),
    })
  })

  test('custom leaves use their physical paths for projection, private access and persistent memory', () => {
    const f = setup()
    const items = unwrap(
      f.schema.define(
        ['customItems'],
        s.map(
          s
            .struct({
              parent: s
                .link({ targetRoots: [['entities']], onDelete: 'unlink' })
                .optional()
                .meta({ linkRoles: ['parent'], visibility: 'ref' }),
              owner: s
                .link({ targetRoots: [['entities']], onDelete: 'unlink' })
                .optional()
                .meta({ linkRoles: ['owner'], visibility: 'ref' }),
            })
            .extensible(),
        ),
      ),
    )
    f.seed()
    const box = items.at('box')
    const inscription = box.custom('inscription', s.str())
    const privateMark = box.custom('privateMark', s.str())
    const hiddenMark = box.custom('hiddenMark', s.str())
    const seen = f.commit('observe an extensible object', (tx) => {
      tx.set(box, { parent: f.key('room'), owner: f.key('alice') })
      tx.defineCustom(box, 'inscription', s.str(), 'an old custom inscription')
      tx.defineCustom(
        box,
        'privateMark',
        s.str().meta({ visibility: 'self' }),
        'a private custom mark',
      )
      tx.defineCustom(
        box,
        'hiddenMark',
        s.str().meta({ visibility: 'ref' }),
        'an unknown custom secret',
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(inspectField(f, seen.id, f.at('alice'), inscription.path).value).toBe(
      'an old custom inscription',
    )
    expect(inspectField(f, seen.id, f.at('alice'), privateMark.path).sourceKind).toBe('self_owned')
    expect(f.perspective.inspect(seen.id, f.at('alice'), [hiddenMark.path])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const left = f.commit('leave before the public custom leaf changes', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
      tx.set(inscription, 'an unseen replacement')
    })
    expect(inspectField(f, left.id, f.at('alice'), inscription.path)).toMatchObject({
      value: 'an old custom inscription',
      at: some(seen.id),
    })
    const view = unwrap(f.perspective.projectView(left.id, f.at('alice')))
    expect(view.mergedInstances[encodePathKey(box.path)]?.customFields.inscription?.value).toBe(
      'an old custom inscription',
    )
  })

  test('explicit witnesses are materialized before public evidence while ordinary objects stay mindless', () => {
    const f = setup()
    f.seed()
    const seen = f.commit('refresh new explicit witnesses in and outside the scene', (tx) => {
      tx.set(f.at('zed'), { name: 'Zed', parent: f.key('room') })
      tx.set(f.at('carol'), { name: 'Carol', parent: f.key('remote') })
      tx.set(f.at('chair'), { name: 'Chair', parent: f.key('room') })
      tx.set(f.at('remoteNote'), { text: 'a remote observed fact', parent: f.key('remote') })
      unwrap(
        f.perspective.syncScope(tx, f.at('room'), {
          additionalWitnesses: [f.at('zed'), f.at('carol')],
        }),
      )
    })
    expect(
      claimMember(f.latestObserved(seen.id, 'alice', f.at('note').$.text.path), 'coWitnesses'),
    ).toContain(f.key('zed'))
    expect(unwrap(f.schema.inspectInstance(seen.id, ['perspectives', f.key('chair')]))).toEqual(
      NONE,
    )
    const moved = f.commit('move Carol away without another refresh', (tx) => {
      tx.set(f.at('carol').$.parent, f.key('room'))
    })
    expect(inspectField(f, moved.id, f.at('carol'), f.at('remoteNote').$.text.path)).toMatchObject({
      value: 'a remote observed fact',
      sourceKind: 'observed_claim',
      at: some(seen.id),
    })
  })

  test('historical and same-commit message events can be acquired, relayed and retrieved without state-root guessing', () => {
    const f = setup()
    const original = f.seed()
    const path = ['$message']
    const learned = f.commit('learn an earlier event', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), path, { atCommitId: original.id }))
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), path))
    })
    expect(inspectField(f, learned.id, f.at('bob'), path)).toMatchObject({
      value: 'seed perspective scene',
      at: some(original.id),
      acquiredAt: some(learned.id),
    })
    const current = f.commit('a newly reported event', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), path))
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), path))
    })
    expect(inspectField(f, current.id, f.at('bob'), path)).toMatchObject({
      value: 'a newly reported event',
      at: some(current.id),
      acquiredAt: some(current.id),
    })
    expect(
      unwrap(f.perspective.listSearchableCorpus(current.id, f.at('bob'))).find(
        (entry) => encodePathKey(entry.path) === encodePathKey(path),
      ),
    ).toMatchObject({ text: 'a newly reported event' })
  })

  test('parent-role unions reject cycles and multiple parents without native acyclic annotations', () => {
    const f = setup()
    const actors = unwrap(
      f.schema.define(
        ['unannotatedParents'],
        s.map(
          s.struct({
            first: s
              .link({ targetRoots: [['unannotatedParents']] })
              .optional()
              .meta({ linkRoles: ['parent'] }),
            second: s
              .link({ targetRoots: [['unannotatedParents']] })
              .optional()
              .meta({ linkRoles: ['parent'] }),
          }),
        ),
      ),
    )
    const seeded = f.seed()
    const a = encodePathKey(actors.at('a').path)
    const b = encodePathKey(actors.at('b').path)
    const cycle = f.schema.commit(
      { head: 'main', message: 'reject a cross-field parent cycle' },
      (tx) => {
        tx.set(actors, { a: { first: b }, b: { second: a } })
      },
    )
    expect(cycle.ok).toBe(false)
    expect(f.world.getHead('main')).toEqual(some(seeded.id))
    const multiple = f.schema.commit(
      { head: 'main', message: 'reject two parent fields' },
      (tx) => {
        tx.set(actors, { a: { first: b, second: b }, b: {} })
      },
    )
    expect(multiple.ok).toBe(false)
    f.commit('accept an acyclic single-parent forest', (tx) => {
      tx.set(actors, { a: { first: b }, b: {} })
    })
  })

  test('delegate activation transfers location, carried children and shared fields without changing the root mind', () => {
    const f = setup()
    f.seed()
    f.commit('prepare an inactive body and carried object', (tx) => {
      tx.set(f.at('mask'), { name: 'Disguise', delegate: f.key('alice'), condition: 'stale state' })
      tx.set(f.at('item'), { parent: f.key('alice'), owner: f.key('alice'), text: 'carried item' })
      tx.set(f.at('alice').$.condition, 'injured')
    })
    const activated = f.commit('activate the disguise body', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    expect(unwrap(f.schema.get(activated.id, f.at('alice').$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(activated.id, f.at('mask').$.parent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(activated.id, f.at('mask').$.condition))).toEqual(some('injured'))
    expect(unwrap(f.schema.get(activated.id, f.at('item').$.parent))).toEqual(some(f.key('mask')))
    expect(unwrap(f.schema.get(activated.id, f.at('item').$.owner))).toEqual(some(f.key('mask')))
    expect(unwrap(f.perspective.resolveRootPerspective(activated.id, f.at('mask')))).toBe(
      f.key('alice'),
    )
  })
})

describe('perspective retrieval and registration boundaries', () => {
  test('folded supporting memories remain searchable without expanding unauthorized foreign memories', () => {
    const f = setup()
    f.seed()
    const observed = f.commit('summarize two different memory ownership domains', (tx) => {
      tx.set(f.at('detail'), { parent: f.key('room'), text: 'raw supporting recollection' })
      tx.setWithMeta(f.at('detail').$.text, 'raw supporting recollection', {
        summary: 'brief detail',
      })
      tx.set(f.at('foreign'), {
        parent: f.key('remote'),
        owner: f.key('bob'),
        privateText: 'FORBIDDEN_FOREIGN_L0_5F21',
      })
      tx.set(f.at('summary'), {
        parent: f.key('room'),
        text: 'short abstraction',
        subsumes: [f.key('detail'), f.key('foreign')],
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const view = unwrap(f.perspective.projectView(observed.id, f.at('alice')))
    expect(view.mergedInstances[f.key('summary')]?.fields.text?.value).toBe('short abstraction')
    expect(view.mergedInstances[f.key('detail')]).toBeUndefined()
    const corpus = unwrap(f.perspective.listSearchableCorpus(observed.id, f.at('alice')))
    const detail = corpus.find(
      (entry) => encodePathKey(entry.path) === encodePathKey(f.at('detail').$.text.path),
    )
    expect(detail).toMatchObject({
      text: 'raw supporting recollection',
      summary: some('brief detail'),
      isFoldedInDefaultView: true,
      factCommitId: observed.id,
      acquiredAtCommitId: observed.id,
      priority: 1000,
      belief: 'believed',
    })
    expect(JSON.stringify(corpus)).not.toContain('FORBIDDEN_FOREIGN_L0_5F21')
  })

  test('unseen subsumption edits cannot change historical folding or discard searchable evidence', () => {
    const f = setup()
    f.seed()
    f.commit('observe a summary and its supporting detail', (tx) => {
      tx.set(f.at('detail'), { parent: f.key('room'), text: 'supporting historical evidence' })
      tx.set(f.at('memo'), {
        parent: f.key('room'),
        text: 'a known summary',
        subsumes: [f.key('detail')],
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const away = f.commit('leave the summary scene', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const before = unwrap(f.perspective.projectView(away.id, f.at('alice')))
    expect(before.mergedInstances[f.key('detail')]).toBeUndefined()
    const corpusBefore = normalizeCorpus(
      unwrap(f.perspective.listSearchableCorpus(away.id, f.at('alice'))),
    )
    expect(
      corpusBefore.find(
        (entry) => encodePathKey(entry.path) === encodePathKey(f.at('detail').$.text.path),
      ),
    ).toMatchObject({ text: 'supporting historical evidence', isFoldedInDefaultView: true })
    const unseen = f.commit('change only an unseen folding relationship', (tx) => {
      tx.set(f.at('memo').$.subsumes, [])
    })
    expect(unwrap(f.perspective.projectView(unseen.id, f.at('alice')))).toEqual(before)
    expect(
      normalizeCorpus(unwrap(f.perspective.listSearchableCorpus(unseen.id, f.at('alice')))),
    ).toEqual(corpusBefore)
  })

  test('historical text summaries and content hashes do not follow unseen metadata changes', () => {
    const f = setup()
    f.seed()
    const seen = f.commit('read a summarized note', (tx) => {
      tx.setWithMeta(f.at('note').$.text, 'original text', { summary: 'the known summary' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const departed = f.commit('leave the note behind', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const before = inspectField(f, departed.id, f.at('alice'), f.at('note').$.text.path)
    const corpusBefore = unwrap(f.perspective.listSearchableCorpus(departed.id, f.at('alice')))
    const pathKey = encodePathKey(f.at('note').$.text.path)
    const textBefore = corpusBefore.find((entry) => encodePathKey(entry.path) === pathKey)
    const changed = f.commit('rewrite only unknown metadata', (tx) => {
      tx.setWithMeta(f.at('note').$.text, 'original text', { summary: 'UNSEEN_CHANGED_SUMMARY' })
    })
    const after = inspectField(f, changed.id, f.at('alice'), f.at('note').$.text.path)
    expect(after).toEqual(before)
    expect(after).toMatchObject({
      summary: some('the known summary'),
      at: some(seen.id),
      acquiredAt: some(seen.id),
    })
    const textAfter = unwrap(f.perspective.listSearchableCorpus(changed.id, f.at('alice'))).find(
      (entry) => encodePathKey(entry.path) === pathKey,
    )
    expect(textAfter).toEqual(textBefore)
    expect(textAfter?.summary).toEqual(some('the known summary'))
  })

  test('same-priority forgetting permits current relearning and persists that new observation', () => {
    const f = setup()
    f.seed()
    f.commit('initial observation', (tx) => {
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const relearned = f.commit('forget then see the same fact again', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('note').$.text.path, {
          priority: 1000,
        }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const away = f.commit('leave after relearning', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    expect(inspectField(f, away.id, f.at('alice'), f.at('note').$.text.path)).toMatchObject({
      value: 'original text',
      sourceKind: 'observed_claim',
      at: some(relearned.id),
      acquiredAt: some(relearned.id),
    })
  })

  test('stored Writer domains remain readable when their Reader registration is dormant', () => {
    const f = setup()
    const original = f.seed()
    const expected = unwrap(f.perspective.projectView(original.id, f.at('alice')))
    const restoredContext = new Context()
    new WorldService(restoredContext, { driver: f.driver })
    const restoredSchema = new SchemaService(restoredContext)
    const restoredPerspective = new PerspectiveService(restoredContext)
    expect(unwrap(restoredSchema.viewAt(original.id)).listRootPaths()).toContainEqual(['entities'])
    expect(unwrap(restoredSchema.viewAt(original.id)).lensAt(f.at('alice').path).ok).toBe(false)
    expect(unwrap(restoredPerspective.projectView(original.id, f.at('alice').path))).toEqual(
      expected,
    )
    expect(
      unwrap(
        restoredPerspective.inspect(original.id, f.at('alice').path, [f.at('note').$.text.path]),
      )[0],
    ).toMatchObject({ value: 'original text', sourceKind: 'direct_scope' })
  })

  test('domains registered after Perspective startup support validated host links and host deletion cascade', () => {
    const driver = createBunSqliteDriver()
    drivers.push(driver)
    const ctx = new Context()
    new WorldService(ctx, { driver })
    const schema = new SchemaService(ctx)
    const perspective = new PerspectiveService(ctx)
    const lateActors = unwrap(schema.define(['lateActors'], s.map(s.struct({ name: s.str() }))))
    const alice = lateActors.at('alice')
    const aliceId = encodePathKey(alice.path)
    const created = unwrap(
      schema.commit({ head: 'main', message: 'register a late host' }, (tx) => {
        tx.set(alice, { name: 'Alice' })
        unwrap(perspective.configurePerspective(tx, alice, {}))
      }),
    )
    const mind = present(unwrap(schema.inspectInstance(created.id, ['perspectives', aliceId])))
    if (mind.nodeKind !== 'struct') throw new Error('Expected the hosted perspective')
    expect(claimMember(mind, 'hostEntity')).toBe(aliceId)
    const deleted = unwrap(
      schema.commit({ head: 'main', message: 'remove the late host' }, (tx) => {
        tx.delete(alice)
      }),
    )
    expect(unwrap(schema.inspectInstance(deleted.id, ['perspectives', aliceId]))).toEqual(NONE)
    expect(unwrap(schema.inspectInstance(created.id, ['perspectives', aliceId])).kind).toBe('some')
  })
})
