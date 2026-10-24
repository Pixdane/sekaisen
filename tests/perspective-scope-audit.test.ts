import { afterEach, describe, expect, test } from 'bun:test'
import { NONE } from '@sekaisen/core'
import type { ObserverRef } from '@sekaisen/plugin-perspective'
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

/** Read one fully expanded field through the restricted observer-facing API. */
function inspectField(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, path: Path) {
  const fields = unwrap(f.perspective.inspect(id, observer, [path]))
  const field = fields.find((entry) => encodePathKey(entry.path) === encodePathKey(path))
  if (!field) throw new Error('Expected the authorized field in inspect output')
  return field
}

/** Return one merged instance view from an agent projection. */
function merged(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, idName: string) {
  return unwrap(f.perspective.projectView(id, observer)).mergedInstances[f.key(idName)]
}

describe('perspective scope edge and exclusion audit', () => {
  test('a public window parented in the scene reveals its adjacent environment', () => {
    const f = setup()
    f.seed('room', 'remote')
    const seen = f.commit('open a window mounted in the room', (tx) => {
      tx.set(f.at('remoteNote'), {
        parent: f.key('remote'),
        text: 'SEEN_THROUGH_PUBLIC_WINDOW',
      })
      tx.set(f.edges.at('window'), {
        name: 'Window',
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const path = f.at('remoteNote').$.text.path
    expect(inspectField(f, seen.id, f.at('alice'), path)).toMatchObject({
      value: 'SEEN_THROUGH_PUBLIC_WINDOW',
      sourceKind: 'direct_scope',
    })
    expect(merged(f, seen.id, f.at('alice'), 'remoteNote')?.fields.text?.value).toBe(
      'SEEN_THROUGH_PUBLIC_WINDOW',
    )
    const scenePublic = unwrap(f.perspective.projectView(seen.id, f.at('alice'))).scenePublic
    expect(scenePublic).not.toEqual(NONE)
    if (scenePublic.kind === 'some')
      expect(scenePublic.value.instances[f.key('remoteNote')]?.fields.text?.value).toBe(
        'SEEN_THROUGH_PUBLIC_WINDOW',
      )
  })

  test('a discovered window parented in the scene stays private to its discoverer', () => {
    const f = setup()
    f.seed('room', 'room')
    const seen = f.commit('discover a hidden window mounted in the room', (tx) => {
      tx.set(f.at('remoteNote'), {
        parent: f.key('remote'),
        text: 'DISCOVERED_WINDOW_SECRET',
      })
      tx.set(f.edges.at('window'), {
        name: 'Hidden window',
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      tx.setInstanceMeta(f.edges.at('window'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('window').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const path = f.at('remoteNote').$.text.path
    expect(inspectField(f, seen.id, f.at('alice'), path)).toMatchObject({
      value: 'DISCOVERED_WINDOW_SECRET',
      sourceKind: 'direct_scope',
    })
    expect(f.perspective.inspect(seen.id, f.at('bob'), [path])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    expect(merged(f, seen.id, f.at('bob'), 'remoteNote')).toBeUndefined()
    const aliceProjection = unwrap(f.perspective.projectView(seen.id, f.at('alice')))
    if (aliceProjection.scenePublic.kind === 'some')
      expect(JSON.stringify(aliceProjection.scenePublic.value)).not.toContain(
        'DISCOVERED_WINDOW_SECRET',
      )
  })

  test('reversed and unreachable edge origins cannot reveal their own environments', () => {
    const f = setup()
    f.seed('room', 'remote')
    const opened = f.commit('mount connectors whose sources are not in the room', (tx) => {
      tx.set(f.at('vault'), { name: 'Vault' })
      tx.set(f.at('remoteNote'), { parent: f.key('remote'), text: 'REVERSED_SECRET' })
      tx.set(f.at('vaultNote'), { parent: f.key('vault'), text: 'UNREACHABLE_SECRET' })
      tx.set(f.edges.at('reversed'), {
        from: f.key('remote'),
        to: f.key('room'),
        parent: f.key('room'),
      })
      tx.set(f.edges.at('unreachable'), {
        from: f.key('vault'),
        to: f.key('room'),
        parent: f.key('room'),
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    for (const [idName, secret] of [
      ['remoteNote', 'REVERSED_SECRET'],
      ['vaultNote', 'UNREACHABLE_SECRET'],
    ] as const) {
      expect(
        f.perspective.inspect(opened.id, f.at('alice'), [f.at(idName).$.text.path]),
      ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
      expect(merged(f, opened.id, f.at('alice'), idName)).toBeUndefined()
      expect(
        JSON.stringify(unwrap(f.perspective.projectView(opened.id, f.at('alice')))),
      ).not.toContain(secret)
    }
  })

  test('a later parented edge cannot chain through an earlier one-hop environment', () => {
    const f = setup()
    f.seed('room', 'remote')
    const chained = f.commit('mount a window and downstream connectors', (tx) => {
      tx.set(f.at('vault'), { name: 'Vault' })
      tx.set(f.at('hiddenRoom'), { name: 'Hidden room' })
      tx.set(f.at('remoteNote'), { parent: f.key('remote'), text: 'FIRST_HOP_VISIBLE' })
      tx.set(f.at('vaultNote'), { parent: f.key('vault'), text: 'CHAINED_SECRET' })
      tx.set(f.at('hiddenNote'), { parent: f.key('hiddenRoom'), text: 'HIDDEN_CHAIN_SECRET' })
      tx.set(f.edges.at('awindow'), {
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      tx.set(f.edges.at('zchain'), {
        from: f.key('remote'),
        to: f.key('vault'),
        parent: f.key('room'),
      })
      tx.set(f.edges.at('zhidden'), {
        from: f.key('remote'),
        to: f.key('hiddenRoom'),
        parent: f.key('room'),
      })
      tx.setInstanceMeta(f.edges.at('zhidden'), { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), f.edges.at('zhidden').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(
      inspectField(f, chained.id, f.at('alice'), f.at('remoteNote').$.text.path),
    ).toMatchObject({ value: 'FIRST_HOP_VISIBLE', sourceKind: 'direct_scope' })
    expect(
      f.perspective.inspect(chained.id, f.at('alice'), [f.at('vaultNote').$.text.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    expect(merged(f, chained.id, f.at('alice'), 'vaultNote')).toBeUndefined()
    expect(
      f.perspective.inspect(chained.id, f.at('alice'), [f.at('hiddenNote').$.text.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    expect(merged(f, chained.id, f.at('alice'), 'hiddenNote')).toBeUndefined()
    expect(
      JSON.stringify(unwrap(f.perspective.projectView(chained.id, f.at('alice')))),
    ).not.toContain('CHAINED_SECRET')
    expect(
      JSON.stringify(unwrap(f.perspective.projectView(chained.id, f.at('alice')))),
    ).not.toContain('HIDDEN_CHAIN_SECRET')
  })

  test('an excluded adjacent child is hidden while a legal sibling stays visible on both channels', () => {
    const f = setup()
    f.seed('room', 'remote')
    const excluded = f.commit('exclude only one object behind a public window', (tx) => {
      tx.set(f.at('remoteItem'), { parent: f.key('remote'), text: 'EXCLUDED_CHILD_SECRET' })
      tx.set(f.at('legalItem'), { parent: f.key('remote'), text: 'LEGAL_SIBLING_TEXT' })
      tx.set(f.at('legalSpeaker'), { parent: f.key('remote'), voice: 'LEGAL_SIBLING_SOUND' })
      tx.set(f.edges.at('window'), {
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('remoteItem').path, {
          priority: 2000,
        }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(
      f.perspective.inspect(excluded.id, f.at('alice'), [f.at('remoteItem').$.text.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    expect(merged(f, excluded.id, f.at('alice'), 'remoteItem')).toBeUndefined()
    expect(merged(f, excluded.id, f.at('alice'), 'legalItem')?.fields.text?.value).toBe(
      'LEGAL_SIBLING_TEXT',
    )
    expect(merged(f, excluded.id, f.at('alice'), 'legalSpeaker')?.fields.voice?.value).toBe(
      'LEGAL_SIBLING_SOUND',
    )
  })

  test('an exclusion on the adjacent root hides every descendant, including sound', () => {
    const f = setup()
    f.seed('room', 'remote')
    const excluded = f.commit('exclude the adjacent room by its semantic root', (tx) => {
      tx.set(f.at('remoteItem'), { parent: f.key('remote'), text: 'ANCESTOR_EXCLUDED_TEXT' })
      tx.set(f.at('remoteSpeaker'), { parent: f.key('remote'), voice: 'ANCESTOR_EXCLUDED_SOUND' })
      tx.set(f.edges.at('window'), {
        from: f.key('room'),
        to: f.key('remote'),
        parent: f.key('room'),
      })
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), f.at('remote').path, { priority: 2000 }),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(
      f.perspective.inspect(excluded.id, f.at('alice'), [f.at('remoteItem').$.text.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    expect(
      f.perspective.inspect(excluded.id, f.at('alice'), [f.at('remoteSpeaker').$.voice.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    expect(merged(f, excluded.id, f.at('alice'), 'remoteItem')).toBeUndefined()
    expect(merged(f, excluded.id, f.at('alice'), 'remoteSpeaker')).toBeUndefined()
    const projection = unwrap(f.perspective.projectView(excluded.id, f.at('alice')))
    expect(projection.scenePublic).toEqual(NONE)
    expect(JSON.stringify(projection)).not.toContain('ANCESTOR_EXCLUDED_TEXT')
    expect(JSON.stringify(projection)).not.toContain('ANCESTOR_EXCLUDED_SOUND')
  })

  test('a runtime-published hidden leaf cannot carry a rumor into the shared prefix', () => {
    const f = setup()
    f.seed('room', 'room')
    const poisoned = f.commit('publish a hidden leaf and add an unconfirmed account', (tx) => {
      tx.setWithMeta(f.at('note').$.hiddenText, 'RUNTIME_PUBLIC_TEXT', { visibility: 'surface' })
      unwrap(
        f.perspective.grantRumor(
          tx,
          f.at('alice'),
          f.at('note').$.hiddenText.path,
          'RUNTIME_PRIVATE_RUMOR',
          { priority: 1500, override: false, belief: 'suspected' },
        ),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const alice = unwrap(f.perspective.projectView(poisoned.id, f.at('alice')))
    expect(alice.scenePublic).toEqual(NONE)
    expect(JSON.stringify(alice.scenePublic)).not.toContain('RUNTIME_PRIVATE_RUMOR')
    const bob = unwrap(f.perspective.projectView(poisoned.id, f.at('bob')))
    expect(bob.scenePublic).not.toEqual(NONE)
    expect(JSON.stringify(bob.scenePublic)).not.toContain('RUNTIME_PRIVATE_RUMOR')
  })

  test('a coexisting unconfirmed rumor forces the private view out of the shared prefix', () => {
    const f = setup()
    f.seed('room', 'room')
    const poisoned = f.commit('add an unconfirmed account beside the observed text', (tx) => {
      unwrap(
        f.perspective.grantRumor(
          tx,
          f.at('alice'),
          f.at('note').$.text.path,
          'PRIVATE_RUMOR_TEXT',
          { priority: 1500, override: false, belief: 'suspected', source: 'a passing stranger' },
        ),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const alice = unwrap(f.perspective.projectView(poisoned.id, f.at('alice')))
    expect(alice.scenePublic).toEqual(NONE)
    const field = inspectField(f, poisoned.id, f.at('alice'), f.at('note').$.text.path)
    expect(field).toMatchObject({ value: 'PRIVATE_RUMOR_TEXT', sourceKind: 'rumor_claim' })
    expect(field.additionalFacets.some((facet) => facet.sourceKind === 'direct_scope')).toBe(true)
    const bob = unwrap(f.perspective.projectView(poisoned.id, f.at('bob')))
    expect(bob.scenePublic).not.toEqual(NONE)
    expect(JSON.stringify(bob.scenePublic)).not.toContain('PRIVATE_RUMOR_TEXT')
    if (bob.scenePublic.kind === 'some')
      expect(bob.scenePublic.value.instances[f.key('note')]?.fields.text?.value).toBe(
        'original text',
      )
  })
})
