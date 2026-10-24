import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import type { ObserverRef } from '@sekaisen/plugin-perspective'
import type { HistoricalStructInspection, LensFor } from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver, StateRef } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { claimMember, PerspectiveFixture, present, unwrap } from './perspective-fixture.ts'

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
function corpusEntry(f: PerspectiveFixture, id: CommitHash, observer: ObserverRef, path: Path) {
  const key = encodePathKey(path)
  const entry = unwrap(f.perspective.listSearchableCorpus(id, observer)).find(
    (candidate) => encodePathKey(candidate.path) === key,
  )
  if (!entry) throw new Error(`Expected a corpus entry for ${key}`)
  return entry
}

/**
 * Read one persisted claim record by its `targetRef.path`.
 *
 * The test host inspects the historical Writer table directly; observers only
 * see the resulting projection, never this host-side view.
 */
function claimRecord(
  f: PerspectiveFixture,
  commitId: CommitHash,
  observer: string,
  table: 'observedClaims' | 'discoveredEntities',
  target: Path,
): HistoricalStructInspection {
  const root = present(
    unwrap(f.schema.inspectInstance(commitId, ['perspectives', f.key(observer), table])),
  )
  if (root.nodeKind !== 'map') throw new Error(`Expected a ${table} Map`)
  const candidates = Object.values(root.entries).filter(
    (entry): entry is HistoricalStructInspection => {
      if (entry.nodeKind !== 'struct') return false
      const ref = claimMember(entry, 'targetRef') as StateRef
      return encodePathKey(ref.path) === encodePathKey(target)
    },
  )
  candidates.sort((a, b) => (claimMember(b, 'seq') as number) - (claimMember(a, 'seq') as number))
  if (!candidates[0]) throw new Error(`Expected a ${table} record for ${encodePathKey(target)}`)
  return candidates[0]
}

describe('perspective temporal transfer semantics', () => {
  test('a remembered ordinary custom leaf survives an unknown ephemeral redefinition and can still be retold', () => {
    const f = setup()
    const relics = unwrap(
      f.schema.define(
        ['relics'],
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
    const lantern = relics.at('lantern')
    const aura = lantern.custom('aura', s.str()).path
    const observed = f.commit('observe an ordinary custom aura', (tx) => {
      tx.set(lantern, { parent: f.key('room') })
      tx.defineCustom(lantern, 'aura', s.str(), 'calm aura', { summary: 'remembered aura' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const left = f.commit('leave the room before the custom key is redefined', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const beforeInspect = unwrap(f.perspective.inspect(left.id, f.at('alice'), [aura]))
    const beforeCorpus = corpusEntry(f, left.id, f.at('alice'), aura)
    const redefined = f.commit('redefine the same custom key as ephemeral', (tx) => {
      tx.defineCustom(lantern, 'aura', s.str().meta({ ephemeral: true }), 'current transient aura')
    })

    const afterInspect = unwrap(f.perspective.inspect(redefined.id, f.at('alice'), [aura]))
    expect(afterInspect).toEqual(beforeInspect)
    expect(corpusEntry(f, redefined.id, f.at('alice'), aura)).toEqual(beforeCorpus)
    expect(unwrap(f.perspective.inspect(redefined.id, f.at('alice'), [aura]))[0]).toMatchObject({
      value: 'calm aura',
      sourceKind: 'observed_claim',
      at: some(observed.id),
      acquiredAt: some(observed.id),
    })
    expect(beforeCorpus).toMatchObject({
      text: 'calm aura',
      factCommitId: observed.id,
      acquiredAtCommitId: observed.id,
      sourceKind: 'observed_claim',
      summary: some('remembered aura'),
    })
    expect(
      unwrap(f.perspective.projectView(redefined.id, f.at('alice'))).mergedInstances[
        encodePathKey(lantern.path)
      ]?.customFields.aura,
    ).toMatchObject({
      summary: some('remembered aura'),
      folded: true,
      sourceKind: 'observed_claim',
      at: some(observed.id),
    })

    const retold = f.commit('retell the remembered aura after the redefinition', (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), aura))
    })
    expect(unwrap(f.perspective.inspect(retold.id, f.at('bob'), [aura]))[0]).toMatchObject({
      value: 'calm aura',
      sourceKind: 'observed_claim',
      at: some(observed.id),
      acquiredAt: some(retold.id),
    })
    expect(corpusEntry(f, retold.id, f.at('bob'), aura)).toMatchObject({
      text: 'calm aura',
      factCommitId: observed.id,
      acquiredAtCommitId: retold.id,
      sourceKind: 'observed_claim',
    })

    const returned = f.commit('retry the ephemeral retelling back in the room', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('room'))
      expect(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), aura)).toMatchObject({
        ok: false,
        error: {
          kind: 'invalid_claim_target',
          targetPath: aura,
          reason: 'cannot_persist_claim_on_ephemeral_field',
        },
      })
    })
    // The rejected current-perception retelling must not disturb Bob's memory.
    expect(unwrap(f.perspective.inspect(returned.id, f.at('bob'), [aura]))[0]).toMatchObject({
      value: 'calm aura',
      sourceKind: 'observed_claim',
      at: some(observed.id),
      acquiredAt: some(retold.id),
    })
  })

  test('a current Reader redefinition cannot revoke an old Writer observation', async () => {
    const f = setup()
    const oldModel = s.map(
      s.struct({
        inscription: s.str(),
        parent: s
          .link({ targetRoots: [['entities']], exclusiveRole: 'parent', onDelete: 'unlink' })
          .optional(),
      }),
    )
    let chronicles!: LensFor<typeof oldModel>
    const original = f.ctx.plugin((scope: Context) => {
      chronicles = unwrap(scope.schema.define(['chronicles'], oldModel))
    })
    await original
    f.seed()
    const path = chronicles.at('tome').$.inscription.path
    const observed = f.commit('remember the Writer declaration before a plugin reload', (tx) => {
      tx.set(chronicles.at('tome'), {
        inscription: 'old persistent inscription',
        parent: f.key('room'),
      })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), path))
    })
    const left = f.commit('leave the tome behind', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const before = corpusEntry(f, left.id, f.at('alice'), path)
    await original.dispose()
    unwrap(
      f.schema.define(
        ['chronicles'],
        s.map(
          s.struct({
            inscription: s.str().meta({ ephemeral: true }),
            parent: s
              .link({ targetRoots: [['entities']], exclusiveRole: 'parent', onDelete: 'unlink' })
              .optional(),
          }),
        ),
      ),
    )
    expect(corpusEntry(f, left.id, f.at('alice'), path)).toEqual(before)
    const synced = unwrap(f.schema.syncSchema({ head: 'main' }))
    expect(corpusEntry(f, synced.id, f.at('alice'), path)).toEqual(before)
    const retold = f.commit(
      'retell the authorized old Writer fact with a new Reader loaded',
      (tx) => {
        unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), path))
      },
    )
    expect(unwrap(f.perspective.inspect(retold.id, f.at('bob'), [path]))[0]).toMatchObject({
      value: 'old persistent inscription',
      sourceKind: 'observed_claim',
      at: some(observed.id),
      acquiredAt: some(retold.id),
    })
  })

  test('persisted rumor bytes remain searchable and retellable after an unknown ephemeral redefinition', () => {
    const f = setup()
    const relics = unwrap(f.schema.define(['rumoredRelics'], s.map(s.struct({}).extensible())))
    f.seed('remote', 'remote')
    const path = [...relics.at('stone').path, '$custom', 'echo']
    const rumor = new Uint8Array([3, 1, 4, 0, 255])
    const heard = f.commit('hear a literal claim without observing its target', (tx) => {
      unwrap(f.perspective.grantRumor(tx, f.at('alice'), path, rumor))
    })
    const before = corpusEntry(f, heard.id, f.at('alice'), path)
    const changed = f.commit('create an unobserved ephemeral target at the rumored path', (tx) => {
      tx.set(relics.at('stone'), {})
      tx.defineCustom(
        relics.at('stone'),
        'echo',
        s.str().meta({ ephemeral: true }),
        'unknown truth',
      )
    })
    expect(corpusEntry(f, changed.id, f.at('alice'), path)).toEqual(before)
    const retold = f.commit('copy only the literal rumor bytes', (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), path))
    })
    expect(unwrap(f.perspective.inspect(retold.id, f.at('bob'), [path]))[0]).toMatchObject({
      value: rumor,
      sourceKind: 'rumor_claim',
      at: some(heard.id),
      acquiredAt: some(retold.id),
    })
  })

  test('a deleted discovered entity is retold structurally while unknown fields stay private', () => {
    const f = setup()
    f.seed('room', 'room')
    const drawer = f.at('drawer')
    const discovered = f.commit('discover a hidden drawer with unknown private state', (tx) => {
      tx.set(drawer, {
        parent: f.key('room'),
        name: 'Drawer',
        text: 'hidden drawer inscription',
        passiveText: 'passive drawer detail',
        privateText: 'DRAWER_PRIVATE',
        hiddenText: 'DRAWER_REF',
      })
      tx.setInstanceMeta(drawer, { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), drawer.path))
    })
    f.commit('delete the discovered drawer before it is retold', (tx) => {
      tx.delete(drawer)
    })

    const identity = f.commit('retell the deleted drawer identity to Bob', (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), drawer.path))
    })
    const record = claimRecord(f, identity.id, 'bob', 'discoveredEntities', drawer.path)
    expect(claimMember(record, 'targetRef')).toEqual({ commitId: discovered.id, path: drawer.path })
    expect(claimMember(record, 'originEventRef')).toEqual({
      commitId: discovered.id,
      path: ['perspectives', f.key('alice'), 'discoveredEntities', f.key('drawer')],
    })
    expect(claimMember(record, 'eventRef')).toEqual({ commitId: identity.id, path: ['$message'] })
    const observedTable = present(
      unwrap(
        f.schema.inspectInstance(identity.id, ['perspectives', f.key('bob'), 'observedClaims']),
      ),
    )
    if (observedTable.nodeKind !== 'map') throw new Error('Expected observedClaims Map')
    expect(
      Object.values(observedTable.entries).some(
        (entry) =>
          entry.nodeKind === 'struct' &&
          encodePathKey((claimMember(entry, 'targetRef') as StateRef).path) ===
            encodePathKey(drawer.path),
      ),
    ).toBe(false)

    // Identity alone carries no field content and must never become a fake
    // field on the enclosing Map.
    expect(f.perspective.inspect(identity.id, f.at('bob'), [drawer.path])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const identityView = unwrap(f.perspective.projectView(identity.id, f.at('bob')))
    expect(identityView.mergedInstances[encodePathKey(['entities'])]).toBeUndefined()
    expect(identityView.schemas[encodePathKey(['entities'])]).toBeUndefined()
    expect(identityView.mergedInstances[f.key('drawer')]).toBeUndefined()

    const retold = f.commit("retell the participant's remembered drawer inscription", (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), drawer.$.text.path))
    })
    const remembered = unwrap(f.perspective.inspect(retold.id, f.at('bob'), [drawer.path]))
    expect(remembered).toHaveLength(1)
    expect(remembered[0]).toMatchObject({
      path: drawer.$.text.path,
      value: 'hidden drawer inscription',
      sourceKind: 'observed_claim',
      at: some(discovered.id),
      acquiredAt: some(retold.id),
    })
    expect(typeof remembered[0]!.value).toBe('string')
    const rememberedText = JSON.stringify(remembered)
    expect(rememberedText).not.toContain('DRAWER_PRIVATE')
    expect(rememberedText).not.toContain('DRAWER_REF')
    expect(rememberedText).not.toContain('passive drawer detail')

    const view = unwrap(f.perspective.projectView(retold.id, f.at('bob')))
    expect(view.mergedInstances[f.key('drawer')]?.fields.text?.value).toBe(
      'hidden drawer inscription',
    )
    expect(view.mergedInstances[encodePathKey(['entities'])]).toBeUndefined()
    expect(view.schemas[encodePathKey(['entities'])]).toBeUndefined()
  })
})

describe('delegate activation canonical role semantics', () => {
  test('implicit exclusiveRole parent children follow the activated body and their implicit owner updates', () => {
    const f = setup()
    const cargo = unwrap(
      f.schema.define(
        ['cargo'],
        s.map(
          s.struct({
            label: s.str().optional(),
            secret: s.str().optional().meta({ visibility: 'self' }),
            parent: s
              .link({
                targetRoots: [['entities']],
                acyclic: true,
                exclusiveRole: 'parent',
                onDelete: 'unlink',
              })
              .optional(),
            owner: s
              .link({
                targetRoots: [['entities']],
                exclusiveRole: 'owner',
                onDelete: 'unlink',
              })
              .optional(),
          }),
        ),
      ),
    )
    f.seed('room', 'room')
    f.commit('prepare implicit-role cargo around an inactive body', (tx) => {
      tx.set(f.at('mask'), { name: 'Mask', delegate: f.key('alice') })
      tx.set(cargo.at('satchel'), {
        label: 'Satchel',
        secret: 'satchel secret',
        parent: f.key('alice'),
        owner: f.key('alice'),
      })
      tx.set(cargo.at('bystander'), {
        label: 'Bystander',
        parent: f.key('room'),
        owner: f.key('room'),
      })
      tx.set(cargo.at('stowed'), {
        label: 'Stowed',
        parent: f.key('mask'),
        owner: f.key('mask'),
      })
    })
    const activated = f.commit('activate the mask body', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    expect(unwrap(f.schema.get(activated.id, cargo.at('satchel').$.parent))).toEqual(
      some(f.key('mask')),
    )
    expect(unwrap(f.schema.get(activated.id, cargo.at('satchel').$.owner))).toEqual(
      some(f.key('mask')),
    )
    expect(unwrap(f.schema.get(activated.id, cargo.at('bystander').$.parent))).toEqual(
      some(f.key('room')),
    )
    expect(unwrap(f.schema.get(activated.id, cargo.at('bystander').$.owner))).toEqual(
      some(f.key('room')),
    )
    expect(unwrap(f.schema.get(activated.id, cargo.at('stowed').$.parent))).toEqual(
      some(f.key('mask')),
    )
    expect(unwrap(f.schema.get(activated.id, cargo.at('stowed').$.owner))).toEqual(
      some(f.key('mask')),
    )
    expect(
      unwrap(
        f.perspective.inspect(activated.id, f.at('mask'), [cargo.at('satchel').$.secret.path]),
      )[0],
    ).toMatchObject({ value: 'satchel secret', sourceKind: 'self_owned' })
    const told = f.commit('the activated body retells its implicit-owner secret', (tx) => {
      unwrap(
        f.perspective.propagateKnowledge(
          tx,
          f.at('mask'),
          f.at('bob'),
          cargo.at('satchel').$.secret.path,
        ),
      )
    })
    expect(
      unwrap(f.perspective.inspect(told.id, f.at('bob'), [cargo.at('satchel').$.secret.path]))[0],
    ).toMatchObject({ value: 'satchel secret', sourceKind: 'observed_claim' })
  })

  test('shared absence resets a defaulted destination rather than retaining its stale value', () => {
    const f = setup()
    const bodies = unwrap(
      f.schema.define(
        ['defaultBodies'],
        s.map(
          s.struct({
            delegate: s.link({ targetRoots: [['entities']], exclusiveRole: 'delegate' }).optional(),
            condition: s.str().default('healthy').meta({ sharedAcrossDelegates: true }),
          }),
        ),
      ),
    )
    f.seed()
    const activated = f.commit('reset the stale destination to its declared default', (tx) => {
      tx.set(f.at('alice').$.condition, NONE)
      tx.set(bodies.at('mask'), { delegate: f.key('alice'), condition: 'stale injury' })
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), bodies.at('mask')))
    })
    expect(unwrap(f.schema.get(activated.id, bodies.at('mask').$.condition))).toEqual(
      some('healthy'),
    )
  })

  test('an unrepresentable shared absence rejects activation before moving either body or its children', () => {
    const f = setup()
    const bodies = unwrap(
      f.schema.define(
        ['requiredBodies'],
        s.map(
          s.struct({
            delegate: s.link({ targetRoots: [['entities']], exclusiveRole: 'delegate' }).optional(),
            parent: s.link({ targetRoots: [['entities']], exclusiveRole: 'parent' }).optional(),
            condition: s.str().meta({ sharedAcrossDelegates: true }),
          }),
        ),
      ),
    )
    f.seed()
    const unchanged = f.commit(
      'catch the rejected activation and commit unchanged bodies',
      (tx) => {
        tx.set(f.at('alice').$.condition, NONE)
        tx.set(f.at('satchel'), { parent: f.key('alice'), owner: f.key('alice') })
        tx.set(bodies.at('mask'), { delegate: f.key('alice'), condition: 'cannot clear' })
        const beforeEntities = unwrap(tx.inspectInstance(['entities']))
        const beforeBodies = unwrap(tx.inspectInstance(['requiredBodies']))
        expect(f.perspective.activateDelegate(tx, f.at('alice'), bodies.at('mask'))).toMatchObject({
          ok: false,
          error: {
            kind: 'schema_error',
            error: {
              kind: 'validation_failed',
              reason: 'cannot_delete_non_optional_node',
              path: bodies.at('mask').$.condition.path,
            },
          },
        })
        expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
        expect(unwrap(tx.inspectInstance(['requiredBodies']))).toEqual(beforeBodies)
      },
    )
    expect(unwrap(f.schema.get(unchanged.id, f.at('alice').$.parent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(unchanged.id, f.at('satchel').$.parent))).toEqual(
      some(f.key('alice')),
    )
    expect(unwrap(f.schema.get(unchanged.id, bodies.at('mask').$.parent))).toEqual(NONE)
  })

  test('shared delegate state synchronizes absence instead of leaving a stale mirror', () => {
    const f = setup()
    f.seed()
    f.commit('prepare a stale disguise mirror', (tx) => {
      tx.set(f.at('mask'), {
        name: 'Disguise',
        delegate: f.key('alice'),
        condition: 'stale state',
      })
      tx.set(f.at('alice').$.condition, 'injured')
    })
    const copied = f.commit('activate with the source value present', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    expect(unwrap(f.schema.get(copied.id, f.at('mask').$.condition))).toEqual(some('injured'))

    const cleared = f.commit('clear the source condition and re-activate', (tx) => {
      tx.set(f.at('alice').$.condition, NONE)
      tx.set(f.at('mask').$.condition, 'stale mirror')
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    expect(unwrap(f.schema.get(cleared.id, f.at('mask').$.condition))).toEqual(NONE)

    const restored = f.commit('restore the source condition', (tx) => {
      tx.set(f.at('alice').$.condition, 'rested')
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    expect(unwrap(f.schema.get(restored.id, f.at('mask').$.condition))).toEqual(some('rested'))

    const reverse = f.commit('clear the disguise condition and copy absence back', (tx) => {
      tx.set(f.at('mask').$.condition, NONE)
      tx.set(f.at('alice').$.condition, 'stale reverse')
      unwrap(f.perspective.activateDelegate(tx, f.at('mask'), f.at('alice')))
    })
    expect(unwrap(f.schema.get(reverse.id, f.at('alice').$.condition))).toEqual(NONE)
  })
})
