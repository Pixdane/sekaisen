import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import type { Visibility } from '@sekaisen/plugin-perspective'
import { s } from '@sekaisen/plugin-schema'
import type { SqliteDriver } from '@sekaisen/plugin-world'
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

/** Canonical parent link used with different presence policies in these scenarios. */
const parentLink = () =>
  s.link({
    targetRoots: [['entities']],
    acyclic: true,
    exclusiveRole: 'parent',
  })
/** Canonical delegate link keeping every test body under the same root mind. */
const delegateLink = () =>
  s.link({
    targetRoots: [['entities']],
    acyclic: true,
    exclusiveRole: 'delegate',
    onDelete: 'unlink',
  })

describe('delegate activation parent preflight', () => {
  test('a required source parent rejects before writes and preserves earlier transaction writes', () => {
    const f = setup()
    const rigid = unwrap(
      f.schema.define(
        ['rigidBodies'],
        s.map(
          s.struct({
            parent: parentLink(),
            delegate: delegateLink().optional(),
            label: s.str().optional(),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage bodies whose source parent cannot be cleared', (tx) => {
      tx.set(rigid.at('anchor'), { parent: f.key('room'), delegate: f.key('alice') })
      tx.set(rigid.at('mask'), { parent: f.key('remote'), delegate: f.key('alice') })
    })

    const committed = f.commit('wanted', (tx) => {
      tx.set(f.at('note').$.text, 'prior write survives')
      const before = unwrap(tx.inspectInstance(['rigidBodies']))
      expect(
        f.perspective.activateDelegate(tx, rigid.at('anchor'), rigid.at('mask')),
      ).toMatchObject({
        ok: false,
        error: {
          kind: 'schema_error',
          error: {
            kind: 'validation_failed',
            path: rigid.at('anchor').$.parent.path,
            reason: 'cannot_delete_non_optional_node',
          },
        },
      })
      expect(unwrap(tx.inspectInstance(['rigidBodies']))).toEqual(before)
    })

    expect(committed.message).toBe('wanted')
    expect(unwrap(f.schema.get(committed.id, f.at('note').$.text))).toEqual(
      some('prior write survives'),
    )
    expect(unwrap(f.schema.get(committed.id, rigid.at('anchor').$.parent))).toEqual(
      some(f.key('room')),
    )
    expect(unwrap(f.schema.get(committed.id, rigid.at('mask').$.parent))).toEqual(
      some(f.key('remote')),
    )
  })

  test('an absent source parent clears a stale optional destination location', () => {
    const f = setup()
    f.seed()
    f.commit('stage a mask with stale coordinates', (tx) => {
      tx.set(f.at('mask'), { name: 'Mask', delegate: f.key('alice'), parent: f.key('remote') })
      tx.set(f.at('alice').$.parent, NONE)
    })

    const activated = f.commit('activate a body that has no location', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })

    expect(unwrap(f.schema.get(activated.id, f.at('mask').$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(activated.id, f.at('alice').$.parent))).toEqual(NONE)
  })

  test('a source schema without any parent field also contributes no location', () => {
    const f = setup()
    const rootless = unwrap(
      f.schema.define(
        ['rootlessBodies'],
        s.map(
          s.struct({
            delegate: delegateLink().optional(),
            label: s.str().optional(),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage a rootless source and a stale destination', (tx) => {
      tx.set(rootless.at('anchor'), { delegate: f.key('alice'), label: 'Rootless' })
      tx.set(f.at('mask'), { name: 'Mask', delegate: f.key('alice'), parent: f.key('remote') })
    })

    const activated = f.commit('activate a body whose schema has no parent slot', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, rootless.at('anchor'), f.at('mask')))
    })

    expect(unwrap(f.schema.get(activated.id, f.at('mask').$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(activated.id, rootless.at('anchor').$.label))).toEqual(
      some('Rootless'),
    )
  })

  test('a destination without a parent declaration keeps the no-location behavior', () => {
    const f = setup()
    const noParentTargets = unwrap(
      f.schema.define(
        ['noParentTargets'],
        s.map(
          s.struct({
            delegate: delegateLink().optional(),
            label: s.str().optional(),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage a destination with no location slot', (tx) => {
      tx.set(noParentTargets.at('mask'), { delegate: f.key('alice'), label: 'Mask' })
    })

    const activated = f.commit('activate into the destination without a parent field', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), noParentTargets.at('mask')))
    })

    expect(unwrap(f.schema.get(activated.id, f.at('alice').$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(activated.id, noParentTargets.at('mask').$.label))).toEqual(
      some('Mask'),
    )
  })

  test('a required destination parent rejects before any write', () => {
    const f = setup()
    const requiredTargets = unwrap(
      f.schema.define(
        ['requiredTargets'],
        s.map(
          s.struct({
            delegate: delegateLink().optional(),
            parent: parentLink(),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage a required destination and detach the source', (tx) => {
      tx.set(requiredTargets.at('mask'), { delegate: f.key('alice'), parent: f.key('remote') })
      tx.set(f.at('alice').$.parent, NONE)
    })

    const committed = f.commit('reject the unrepresentable target location', (tx) => {
      const beforeEntities = unwrap(tx.inspectInstance(['entities']))
      const beforeTargets = unwrap(tx.inspectInstance(['requiredTargets']))
      expect(
        f.perspective.activateDelegate(tx, f.at('alice'), requiredTargets.at('mask')),
      ).toMatchObject({
        ok: false,
        error: {
          kind: 'schema_error',
          error: {
            kind: 'validation_failed',
            path: requiredTargets.at('mask').$.parent.path,
            reason: 'cannot_delete_non_optional_node',
          },
        },
      })
      expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
      expect(unwrap(tx.inspectInstance(['requiredTargets']))).toEqual(beforeTargets)
    })

    expect(unwrap(f.schema.get(committed.id, requiredTargets.at('mask').$.parent))).toEqual(
      some(f.key('remote')),
    )
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.parent))).toEqual(NONE)
  })

  test('a defaulted destination parent rejects instead of inventing a location', () => {
    const f = setup()
    const defaultedTargets = unwrap(
      f.schema.define(
        ['defaultedTargets'],
        s.map(
          s.struct({
            delegate: delegateLink().optional(),
            parent: parentLink().default(f.key('room')),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage a defaulted destination and detach the source', (tx) => {
      tx.set(defaultedTargets.at('mask'), { delegate: f.key('alice') })
      tx.set(f.at('alice').$.parent, NONE)
    })

    const committed = f.commit('reject the defaulted target location', (tx) => {
      const beforeEntities = unwrap(tx.inspectInstance(['entities']))
      const beforeTargets = unwrap(tx.inspectInstance(['defaultedTargets']))
      expect(
        f.perspective.activateDelegate(tx, f.at('alice'), defaultedTargets.at('mask')),
      ).toMatchObject({
        ok: false,
        error: {
          kind: 'schema_error',
          error: {
            kind: 'validation_failed',
            path: defaultedTargets.at('mask').$.parent.path,
            reason: 'cannot_delete_non_optional_node',
          },
        },
      })
      expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
      expect(unwrap(tx.inspectInstance(['defaultedTargets']))).toEqual(beforeTargets)
    })

    expect(unwrap(f.schema.get(committed.id, defaultedTargets.at('mask').$.parent))).toEqual(
      some(f.key('room')),
    )
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.parent))).toEqual(NONE)
  })
})

describe('delegate activation atomic transfer', () => {
  test('a later incompatible shared value rolls back location and preserves earlier transaction writes', () => {
    const f = setup()
    const receiving = unwrap(
      f.schema.define(
        ['receivingBodies'],
        s.map(
          s.struct({
            delegate: delegateLink().optional(),
            parent: parentLink().optional(),
            condition: s.num().meta({ sharedAcrossDelegates: true }),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage a receiver with a different shared value kind', (tx) => {
      tx.set(receiving.at('mask'), {
        delegate: f.key('alice'),
        parent: f.key('remote'),
        condition: 3,
      })
      tx.set(f.at('item'), { parent: f.key('alice'), owner: f.key('alice') })
    })

    const committed = f.commit('wanted', (tx) => {
      tx.set(f.at('note').$.text, 'prior write survives the rollback')
      const beforeEntities = unwrap(tx.inspectInstance(['entities']))
      const beforeReceiving = unwrap(tx.inspectInstance(['receivingBodies']))
      expect(f.perspective.activateDelegate(tx, f.at('alice'), receiving.at('mask'))).toMatchObject(
        { ok: false, error: { kind: 'schema_error' } },
      )
      expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
      expect(unwrap(tx.inspectInstance(['receivingBodies']))).toEqual(beforeReceiving)
    })

    expect(committed.message).toBe('wanted')
    expect(unwrap(f.schema.get(committed.id, f.at('note').$.text))).toEqual(
      some('prior write survives the rollback'),
    )
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.parent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.condition))).toEqual(some('well'))
    expect(unwrap(f.schema.get(committed.id, f.at('item').$.parent))).toEqual(some(f.key('alice')))
    expect(unwrap(f.schema.get(committed.id, receiving.at('mask').$.parent))).toEqual(
      some(f.key('remote')),
    )
    expect(unwrap(f.schema.get(committed.id, receiving.at('mask').$.condition))).toEqual(some(3))
  })

  test('a child metadata failure rolls back already reparented children and runtime visibility', () => {
    const f = setup()
    f.seed()
    f.commit('stage two carried children with remembered visibility', (tx) => {
      tx.set(f.at('mask'), { name: 'Mask', delegate: f.key('alice'), parent: f.key('remote') })
      tx.set(f.at('kit'), { parent: f.key('alice'), owner: f.key('alice') })
      tx.set(f.at('satchel'), { parent: f.key('alice'), owner: f.key('alice') })
      tx.setInstanceMeta(f.at('kit'), { visibility: 'ref' })
      tx.setInstanceMeta(f.at('satchel'), { visibility: 'ref' })
    })

    const committed = f.commit('fail after the first child was reparented', (tx) => {
      const beforeEntities = unwrap(tx.inspectInstance(['entities']))
      expect(
        f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask'), {
          concealTransferredChildren: true,
          visibilityOverrides: {
            [encodePathKey(f.at('satchel').path)]: {} as unknown as Visibility,
          },
        }),
      ).toMatchObject({ ok: false, error: { kind: 'schema_error' } })
      expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
    })

    const view = unwrap(f.schema.viewAt(committed.id))
    for (const child of [f.at('kit'), f.at('satchel')]) {
      expect(unwrap(f.schema.get(committed.id, child.$.parent))).toEqual(some(f.key('alice')))
      expect(unwrap(f.schema.get(committed.id, child.$.owner))).toEqual(some(f.key('alice')))
      expect({ ...present(unwrap(view.getInstanceMeta(child))) }).toMatchObject({
        visibility: 'ref',
      })
    }
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.parent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(committed.id, f.at('mask').$.parent))).toEqual(some(f.key('remote')))
  })

  test('a normal transition moves location and cargo and copies optional absence', () => {
    const f = setup()
    f.seed()
    const activated = f.commit('activate with an absent shared value', (tx) => {
      tx.set(f.at('mask'), {
        name: 'Mask',
        delegate: f.key('alice'),
        parent: f.key('remote'),
        condition: 'stale mirror',
      })
      tx.set(f.at('item'), { parent: f.key('alice'), owner: f.key('alice') })
      tx.set(f.at('alice').$.condition, NONE)
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })

    expect(unwrap(f.schema.get(activated.id, f.at('alice').$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(activated.id, f.at('mask').$.parent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(activated.id, f.at('mask').$.condition))).toEqual(NONE)
    expect(unwrap(f.schema.get(activated.id, f.at('item').$.parent))).toEqual(some(f.key('mask')))
    expect(unwrap(f.schema.get(activated.id, f.at('item').$.owner))).toEqual(some(f.key('mask')))
  })
})

describe('delegate role slots and identity transitions', () => {
  test('populated role slots win over empty aliases for bodies and carried children', () => {
    const f = setup()
    const bodies = unwrap(
      f.schema.define(
        ['aliasedBodies'],
        s.map(
          s.struct({
            altParent: parentLink().optional(),
            parent: parentLink().optional(),
            delegate: delegateLink().optional(),
          }),
        ),
      ),
    )
    const carriedParent = s
      .link({
        targetRoots: [['entities'], ['aliasedBodies']],
        exclusiveRole: 'parent',
        acyclic: true,
      })
      .optional()
    const carriedOwner = s
      .link({ targetRoots: [['entities'], ['aliasedBodies']], exclusiveRole: 'owner' })
      .optional()
    const cargo = unwrap(
      f.schema.define(
        ['aliasedCargo'],
        s.map(
          s.struct({
            altParent: carriedParent,
            parent: carriedParent,
            altOwner: carriedOwner,
            owner: carriedOwner,
          }),
        ),
      ),
    )
    f.seed()
    const mask = bodies.at('mask')
    const spare = bodies.at('spare')
    const item = cargo.at('item')
    const committed = f.commit(
      'transfer through populated and then empty role declarations',
      (tx) => {
        tx.set(mask, { parent: f.key('remote'), delegate: f.key('alice') })
        tx.set(spare, { delegate: f.key('alice') })
        tx.set(item, { parent: f.key('alice'), owner: f.key('alice') })
        unwrap(f.perspective.activateDelegate(tx, f.at('alice'), mask))
        expect(unwrap(tx.get(mask.$.altParent))).toEqual(NONE)
        expect(unwrap(tx.get(mask.$.parent))).toEqual(some(f.key('room')))
        expect(unwrap(tx.get(item.$.altParent))).toEqual(NONE)
        expect(unwrap(tx.get(item.$.parent))).toEqual(some(encodePathKey(mask.path)))
        expect(unwrap(tx.get(item.$.altOwner))).toEqual(NONE)
        expect(unwrap(tx.get(item.$.owner))).toEqual(some(encodePathKey(mask.path)))

        // All destination slots are absent: the first declaration is the stable fallback.
        unwrap(f.perspective.activateDelegate(tx, mask, spare))
      },
    )
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(committed.id, mask.$.altParent))).toEqual(NONE)
    expect(unwrap(f.schema.get(committed.id, mask.$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(committed.id, spare.$.altParent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(committed.id, spare.$.parent))).toEqual(NONE)
    expect(unwrap(f.schema.get(committed.id, item.$.altParent))).toEqual(NONE)
    expect(unwrap(f.schema.get(committed.id, item.$.parent))).toEqual(
      some(encodePathKey(spare.path)),
    )
    expect(unwrap(f.schema.get(committed.id, item.$.altOwner))).toEqual(NONE)
    expect(unwrap(f.schema.get(committed.id, item.$.owner))).toEqual(
      some(encodePathKey(spare.path)),
    )
  })

  test('same-path activation leaves optional and required bodies and their cargo unchanged', () => {
    const f = setup()
    const rigid = unwrap(
      f.schema.define(['identityBodies'], s.map(s.struct({ parent: parentLink() }))),
    )
    f.seed()
    const committed = f.commit('self activation is an identity operation', (tx) => {
      tx.set(f.at('alice').$.name, 'wanted')
      tx.set(f.at('item'), { parent: f.key('alice'), owner: f.key('alice') })
      tx.setInstanceMeta(f.at('item'), { visibility: 'ref' })
      tx.set(rigid.at('body'), { parent: f.key('remote') })
      const beforeEntities = unwrap(tx.inspectInstance(['entities']))
      const beforeRigid = unwrap(tx.inspectInstance(['identityBodies']))
      unwrap(
        f.perspective.activateDelegate(tx, f.at('alice'), f.entities.at('alice'), {
          concealTransferredChildren: true,
          visibilityOverrides: { [f.key('item')]: 'surface' },
        }),
      )
      unwrap(f.perspective.activateDelegate(tx, rigid.at('body'), rigid.at('body')))
      expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
      expect(unwrap(tx.inspectInstance(['identityBodies']))).toEqual(beforeRigid)
    })
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.parent))).toEqual(some(f.key('room')))
    expect(unwrap(f.schema.get(committed.id, f.at('alice').$.name))).toEqual(some('wanted'))
    expect(unwrap(f.schema.get(committed.id, f.at('item').$.parent))).toEqual(some(f.key('alice')))
    expect(unwrap(f.schema.get(committed.id, rigid.at('body').$.parent))).toEqual(
      some(f.key('remote')),
    )
  })
})

describe('delegate activation preserves co-ownership', () => {
  test('scalar owner fields migrate only source edges and retain a remote co-owner private access', () => {
    const f = setup()
    const owner = s
      .link({ targetRoots: [['entities']] })
      .optional()
      .meta({ linkRoles: ['owner'], visibility: 'ref' })
    const cargo = unwrap(
      f.schema.define(
        ['jointCargo'],
        s.map(
          s.struct({
            parent: parentLink().optional(),
            ownerA: owner,
            ownerB: owner,
            emptyOwner: owner,
            privateText: s.str().meta({ visibility: 'self' }),
          }),
        ),
      ),
    )
    f.seed()
    const staged = f.commit('stage shared and merely borrowed cargo', (tx) => {
      tx.set(f.at('mask'), { parent: f.key('remote'), delegate: f.key('alice') })
      tx.set(cargo.at('shared'), {
        parent: f.key('alice'),
        ownerA: f.key('bob'),
        ownerB: f.key('alice'),
        privateText: 'JOINT_PRIVATE_CONTENT',
      })
      tx.set(cargo.at('borrowed'), {
        parent: f.key('alice'),
        ownerA: f.key('bob'),
        privateText: 'BOBS_BORROWED_PRIVATE_CONTENT',
      })
    })
    expect(
      unwrap(
        f.perspective.inspect(staged.id, f.at('bob'), [cargo.at('shared').$.privateText.path]),
      )[0],
    ).toMatchObject({ value: 'JOINT_PRIVATE_CONTENT', sourceKind: 'self_owned' })
    const activated = f.commit('move the Alice edge, not the first owner declaration', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    const view = unwrap(f.schema.viewAt(activated.id))
    expect(unwrap(view.get(cargo.at('shared').$.ownerA))).toEqual(some(f.key('bob')))
    expect(unwrap(view.get(cargo.at('shared').$.ownerB))).toEqual(some(f.key('mask')))
    expect(unwrap(view.get(cargo.at('shared').$.emptyOwner))).toEqual(NONE)
    expect(unwrap(view.get(cargo.at('borrowed').$.parent))).toEqual(some(f.key('mask')))
    expect(unwrap(view.get(cargo.at('borrowed').$.ownerA))).toEqual(some(f.key('bob')))
    expect(unwrap(view.get(cargo.at('borrowed').$.ownerB))).toEqual(NONE)
    expect(unwrap(view.get(cargo.at('borrowed').$.emptyOwner))).toEqual(NONE)
    expect(
      unwrap(
        f.perspective.inspect(activated.id, f.at('bob'), [cargo.at('shared').$.privateText.path]),
      )[0],
    ).toMatchObject({ value: 'JOINT_PRIVATE_CONTENT', sourceKind: 'self_owned' })
    expect(
      unwrap(
        f.perspective.inspect(activated.id, f.at('mask'), [cargo.at('shared').$.privateText.path]),
      )[0],
    ).toMatchObject({ value: 'JOINT_PRIVATE_CONTENT', sourceKind: 'self_owned' })
    expect(
      f.perspective.inspect(activated.id, f.at('mask'), [cargo.at('borrowed').$.privateText.path]),
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    expect(
      unwrap(f.perspective.listSearchableCorpus(activated.id, f.at('bob'))).find(
        (entry) =>
          encodePathKey(entry.path) === encodePathKey(cargo.at('shared').$.privateText.path),
      ),
    ).toMatchObject({ text: 'JOINT_PRIVATE_CONTENT', sourceKind: 'self_owned' })
  })

  test('owner lists replace source targets, deduplicate stably and leave unrelated lists untouched', () => {
    const f = setup()
    const cargo = unwrap(
      f.schema.define(
        ['listCargo'],
        s.map(
          s.struct({
            parent: parentLink().optional(),
            owners: s
              .linkList({ targetRoots: [['entities']] })
              .default([])
              .meta({ linkRoles: ['owner'], visibility: 'ref' }),
            privateText: s.str().meta({ visibility: 'self' }),
          }),
        ),
      ),
    )
    f.seed()
    f.commit('stage owners with an existing destination and repeated identities', (tx) => {
      tx.set(f.at('mask'), { parent: f.key('remote'), delegate: f.key('alice') })
      tx.set(cargo.at('shared'), { parent: f.key('alice'), privateText: 'LIST_PRIVATE_CONTENT' })
      tx.setWithMeta(
        cargo.at('shared').$.owners,
        [f.key('bob'), f.key('alice'), f.key('mask'), f.key('bob'), f.key('alice')],
        { summary: 'joint owners' },
      )
      tx.set(cargo.at('unrelated'), {
        parent: f.key('alice'),
        owners: [f.key('bob'), f.key('bob')],
        privateText: 'UNRELATED_OWNER_CONTENT',
      })
    })
    const activated = f.commit('transfer only list references to the source body', (tx) => {
      unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
    })
    expect(unwrap(f.schema.get(activated.id, cargo.at('shared').$.owners))).toEqual(
      some([f.key('bob'), f.key('mask')]),
    )
    expect(unwrap(f.schema.get(activated.id, cargo.at('unrelated').$.owners))).toEqual(
      some([f.key('bob'), f.key('bob')]),
    )
    expect(
      present(unwrap(f.schema.getWithMeta(activated.id, cargo.at('shared').$.owners))).meta,
    ).toMatchObject({
      summary: 'joint owners',
    })
    for (const observer of [f.at('bob'), f.at('mask')])
      expect(
        unwrap(
          f.perspective.inspect(activated.id, observer, [cargo.at('shared').$.privateText.path]),
        )[0],
      ).toMatchObject({ value: 'LIST_PRIVATE_CONTENT', sourceKind: 'self_owned' })
    expect(
      f.perspective.inspect(activated.id, f.at('mask'), [cargo.at('unrelated').$.privateText.path]),
    ).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })

  test('combined parent-owner slots and every remaining source edge migrate atomically', () => {
    const f = setup()
    const owner = s
      .link({ targetRoots: [['entities']] })
      .optional()
      .meta({ linkRoles: ['owner'] })
    const cargo = unwrap(
      f.schema.define(
        ['mixedCargo'],
        s.map(
          s.struct({
            parentOwner: parentLink()
              .optional()
              .meta({ linkRoles: ['parent', 'owner'] }),
            ownerAgain: owner,
            coOwner: owner,
            owners: s
              .linkList({ targetRoots: [['entities']] })
              .default([])
              .meta({ linkRoles: ['owner'] }),
            privateText: s.str().meta({ visibility: 'self' }),
          }),
        ),
      ),
    )
    f.seed()
    const item = cargo.at('item')
    const activated = f.commit(
      'roll back a failed mixed transfer, then retry in the same transaction',
      (tx) => {
        tx.set(f.at('alice').$.name, 'wanted')
        tx.set(f.at('mask'), { parent: f.key('remote'), delegate: f.key('alice') })
        tx.set(item, {
          parentOwner: f.key('alice'),
          ownerAgain: f.key('alice'),
          coOwner: f.key('bob'),
          owners: [f.key('alice'), f.key('bob'), f.key('mask')],
          privateText: 'MIXED_OWNER_CONTENT',
        })
        const beforeEntities = unwrap(tx.inspectInstance(['entities']))
        const beforeCargo = unwrap(tx.inspectInstance(['mixedCargo']))
        expect(
          f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask'), {
            visibilityOverrides: { [encodePathKey(item.path)]: {} as unknown as Visibility },
          }),
        ).toMatchObject({ ok: false, error: { kind: 'schema_error' } })
        expect(unwrap(tx.inspectInstance(['entities']))).toEqual(beforeEntities)
        expect(unwrap(tx.inspectInstance(['mixedCargo']))).toEqual(beforeCargo)
        unwrap(f.perspective.activateDelegate(tx, f.at('alice'), f.at('mask')))
      },
    )
    expect(unwrap(f.schema.get(activated.id, item.$.parentOwner))).toEqual(some(f.key('mask')))
    expect(unwrap(f.schema.get(activated.id, item.$.ownerAgain))).toEqual(some(f.key('mask')))
    expect(unwrap(f.schema.get(activated.id, item.$.coOwner))).toEqual(some(f.key('bob')))
    expect(unwrap(f.schema.get(activated.id, item.$.owners))).toEqual(
      some([f.key('mask'), f.key('bob')]),
    )
    expect(unwrap(f.schema.get(activated.id, f.at('alice').$.name))).toEqual(some('wanted'))
    expect(
      unwrap(f.perspective.inspect(activated.id, f.at('bob'), [item.$.privateText.path]))[0],
    ).toMatchObject({ value: 'MIXED_OWNER_CONTENT', sourceKind: 'self_owned' })
  })
})
