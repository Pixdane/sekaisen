import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import { s } from '@sekaisen/plugin-schema'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveFixture, unwrap } from './perspective-fixture'

const fixtures: PerspectiveFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.driver.close()
})

/** Isolate each capability or persistence boundary in its own SQLite world. */
function setup() {
  const fixture = new PerspectiveFixture()
  fixtures.push(fixture)
  return fixture
}

describe('observer identity is an immutable capability', () => {
  test('mutating the caller-owned path cannot switch any facade read to another mind', () => {
    const f = setup()
    f.seed('room', 'room')
    const state = f.commit('give each mind different private knowledge', (tx) => {
      tx.set(f.at('aliceDiary'), {
        parent: f.key('room'),
        owner: f.key('alice'),
        privateText: 'ALICES_PRIVATE_CONTENT',
      })
      tx.set(f.at('bobDiary'), {
        parent: f.key('room'),
        owner: f.key('bob'),
        privateText: 'BOBS_PRIVATE_CONTENT',
      })
    })
    const path = ['entities', 'alice']
    const facade = unwrap(f.perspective.asObserver(state.id, path))
    const bobSecret = f.at('bobDiary').$.privateText.path
    expect(facade.inspect([bobSecret])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    path[1] = 'bob'
    expect(facade.rootPerspectiveId).toBe(f.key('alice'))
    expect(facade.inspect([bobSecret])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const projected = JSON.stringify(unwrap(facade.projectView()))
    expect(projected).toContain('ALICES_PRIVATE_CONTENT')
    expect(projected).not.toContain('BOBS_PRIVATE_CONTENT')
    const corpus = unwrap(facade.listSearchableCorpus())
    expect(
      corpus.find(
        (entry) =>
          encodePathKey(entry.path) === encodePathKey(f.at('aliceDiary').$.privateText.path),
      ),
    ).toMatchObject({ text: 'ALICES_PRIVATE_CONTENT', sourceKind: 'self_owned' })
    expect(
      corpus.find((entry) => encodePathKey(entry.path) === encodePathKey(bobSecret)),
    ).toBeUndefined()
  })

  test('capturing a delegated body keeps its location rather than substituting the remote root mind', () => {
    const f = setup()
    f.seed('remote', 'remote')
    const staged = f.commit('stage only the delegated body beside the note', (tx) => {
      tx.set(f.at('mask'), { name: 'Mask', parent: f.key('room'), delegate: f.key('alice') })
    })
    const bodyPath = ['entities', 'mask']
    const facade = unwrap(f.perspective.asObserver(staged.id, bodyPath))
    bodyPath[1] = 'bob'
    expect(facade.rootPerspectiveId).toBe(f.key('alice'))
    expect(unwrap(facade.inspect([f.at('note').$.text.path]))[0]).toMatchObject({
      value: 'original text',
      sourceKind: 'direct_scope',
    })
    expect(unwrap(facade.projectView()).mergedInstances[f.key('note')]?.fields.text?.value).toBe(
      'original text',
    )
    expect(
      unwrap(facade.listSearchableCorpus()).find(
        (entry) => encodePathKey(entry.path) === encodePathKey(f.at('note').$.text.path),
      ),
    ).toMatchObject({ text: 'original text', sourceKind: 'direct_scope' })
  })
})

describe('all explicit claim entries respect ephemeral persistence', () => {
  test('grants, rumors and retellings reject an instant without creating a receiver or consuming claim state', () => {
    const f = setup()
    f.seed()
    const instant = f.at('note').$.ephemeralText.path
    const reported = f.commit('see an instant but remember only a persistent fact', (tx) => {
      tx.set(f.at('charlie'), { name: 'Charlie', parent: f.key('remote') })
      tx.set(f.at('note').$.ephemeralText, 'one-time gesture')
      const before = unwrap(tx.inspectInstance(['perspectives']))
      for (const result of [
        f.perspective.grantKnowledge(tx, f.at('alice'), instant),
        f.perspective.grantRumor(tx, f.at('alice'), instant, 'an alleged gesture'),
        f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('charlie'), instant),
      ])
        expect(result).toMatchObject({
          ok: false,
          error: {
            kind: 'invalid_claim_target',
            targetPath: instant,
            reason: 'cannot_persist_claim_on_ephemeral_field',
          },
        })
      expect(unwrap(tx.inspectInstance(['perspectives']))).toEqual(before)
      expect(unwrap(tx.inspectInstance(['perspectives', f.key('charlie')]))).toEqual(NONE)
      unwrap(
        f.perspective.propagateKnowledge(
          tx,
          f.at('alice'),
          f.at('charlie'),
          f.at('note').$.text.path,
        ),
      )
      unwrap(f.perspective.syncScope(tx, f.at('room'), { focusedPaths: [instant] }))
    })
    expect(unwrap(f.perspective.inspect(reported.id, f.at('alice'), [instant]))[0]).toMatchObject({
      value: 'one-time gesture',
      sourceKind: 'direct_scope',
    })
    const gone = f.commit('remove the instant after the attempted retelling', (tx) => {
      tx.set(f.at('note').$.ephemeralText, NONE)
      tx.set(f.at('note').$.text, 'a later scene fact')
    })
    expect(f.perspective.inspect(gone.id, f.at('charlie'), [instant])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    expect(
      JSON.stringify(unwrap(f.perspective.projectView(gone.id, f.at('charlie')))),
    ).not.toContain('one-time gesture')
    expect(
      unwrap(f.perspective.inspect(gone.id, f.at('charlie'), [f.at('note').$.text.path]))[0],
    ).toMatchObject({ value: 'original text', sourceKind: 'observed_claim', at: some(reported.id) })
  })

  test('custom ephemeral leaves cannot enter memory through a retelling', () => {
    const f = setup()
    const items = unwrap(
      f.schema.define(
        ['volatileItems'],
        s.map(
          s
            .struct({
              parent: s
                .link({ targetRoots: [['entities']], onDelete: 'unlink' })
                .optional()
                .meta({ linkRoles: ['parent'], visibility: 'ref' }),
            })
            .extensible(),
        ),
      ),
    )
    f.seed()
    const item = items.at('speaker')
    const pulse = item.custom('pulse', s.str()).path
    const emitted = f.commit('emit an instance-specific transient signal', (tx) => {
      tx.set(item, { parent: f.key('room') })
      tx.defineCustom(item, 'pulse', s.str().meta({ ephemeral: true }), 'a custom instant')
      expect(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), pulse)).toMatchObject(
        {
          ok: false,
          error: {
            kind: 'invalid_claim_target',
            reason: 'cannot_persist_claim_on_ephemeral_field',
          },
        },
      )
    })
    expect(unwrap(f.perspective.inspect(emitted.id, f.at('alice'), [pulse]))[0]).toMatchObject({
      value: 'a custom instant',
      sourceKind: 'direct_scope',
    })
    expect(f.perspective.inspect(emitted.id, f.at('bob'), [pulse])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })
})

describe('perspective configuration uses partial update semantics', () => {
  test('description, priority and empty configuration preserve inherited access; an explicit empty list revokes it', () => {
    const f = setup()
    const seed = f.seed()
    const target = f.at('note').$.text.path
    const joined = f.commit('join an organization with a historical archive', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, 'org:archive', { description: 'Archive' }))
      unwrap(f.perspective.grantKnowledge(tx, 'org:archive', target, { atCommitId: seed.id }))
      unwrap(f.perspective.configurePerspective(tx, f.at('bob'), { inherits: ['org:archive'] }))
    })
    const expected = unwrap(f.perspective.inspect(joined.id, f.at('bob'), [target]))
    const described = f.commit('update only the perspective description', (tx) => {
      unwrap(
        f.perspective.configurePerspective(tx, f.at('bob'), { description: 'new description' }),
      )
    })
    expect(unwrap(f.perspective.inspect(described.id, f.at('bob'), [target]))).toEqual(expected)
    const reprioritized = f.commit('update only the perspective priority', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('bob'), { defaultPriority: 1700 }))
    })
    expect(unwrap(f.perspective.inspect(reprioritized.id, f.at('bob'), [target]))).toEqual(expected)
    const unchanged = f.commit('apply an empty perspective patch', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('bob'), {}))
    })
    expect(unwrap(f.perspective.inspect(unchanged.id, f.at('bob'), [target]))).toEqual(expected)
    const left = f.commit('explicitly leave the organization', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('bob'), { inherits: [] }))
    })
    expect(f.perspective.inspect(left.id, f.at('bob'), [target])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })

  test('an explicit new parent list replaces rather than merges prior inheritance', () => {
    const f = setup()
    f.seed()
    const oldTarget = ['archiveFacts', 'first', 'text']
    const nextTarget = ['archiveFacts', 'second', 'text']
    f.commit('join the first archive', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, 'org:first', {}))
      unwrap(f.perspective.configurePerspective(tx, 'org:second', {}))
      unwrap(f.perspective.grantRumor(tx, 'org:first', oldTarget, 'first archive account'))
      unwrap(f.perspective.grantRumor(tx, 'org:second', nextTarget, 'second archive account'))
      unwrap(f.perspective.configurePerspective(tx, f.at('bob'), { inherits: ['org:first'] }))
    })
    const changed = f.commit('switch to the second archive', (tx) => {
      unwrap(f.perspective.configurePerspective(tx, f.at('bob'), { inherits: ['org:second'] }))
    })
    expect(f.perspective.inspect(changed.id, f.at('bob'), [oldTarget])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    expect(unwrap(f.perspective.inspect(changed.id, f.at('bob'), [nextTarget]))[0]).toMatchObject({
      value: 'second archive account',
      sourceKind: 'rumor_claim',
    })
  })
})
