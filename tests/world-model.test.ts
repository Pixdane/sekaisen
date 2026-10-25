import { afterEach, describe, expect, test } from 'bun:test'
import type { Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { SchemaError } from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'
import type { CommitNode, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { ITEM_ROOT_PATH } from '@sekaisen/plugin-world-model'
import {
  entityKey as key,
  present,
  seedBase,
  unwrap,
  WorldModelFixture,
} from './world-model-fixture.ts'

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

type Fixture = WorldModelFixture

function setup(): Fixture {
  const fixture = new WorldModelFixture()
  drivers.push(fixture.driver)
  return fixture
}

function expectRejected(result: Result<CommitNode, SchemaError>, reason: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  if (result.error.kind !== 'validator_rejected')
    throw new Error(`Expected validator rejection, got ${JSON.stringify(result.error)}`)
  expect(result.error.reason).toBe(reason)
}

describe('world model registration and clock invariants', () => {
  test('registers twelve roots and four typed messages', () => {
    const f = setup()
    expect(Object.keys(f.worldModel.lenses).sort()).toEqual(
      [
        'abilities',
        'agendas',
        'beats',
        'characters',
        'fuses',
        'items',
        'locations',
        'lores',
        'organizations',
        'relations',
        'routes',
        'world',
      ].sort(),
    )
    expect(f.worldModel.messages.l0Step.kind).toBe('l0_step')
    expect(f.worldModel.messages.memoryArchive.kind).toBe('memory_archive')
    expect(f.worldModel.messages.manualEdit.kind).toBe('manual_edit')
    expect(f.worldModel.messages.carryOverPatch.kind).toBe('carry_over_patch')
  })

  test('accepts aligned l0 steps, rejects regressions and only typed manual edits may rewind', () => {
    const f = setup()
    seedBase(f)
    const first = f.commit(
      f.worldModel.messages.l0Step.create({
        storyTimeStart: 0,
        storyTimeEnd: 5,
        summary: 'five minutes pass',
      }),
      (tx) => {
        tx.patch(f.worldModel.lenses.world, { clock: 5 })
      },
    )
    expect(unwrap(f.schema.get(first.id, f.worldModel.lenses.world.field('clock')))).toEqual(
      some(5),
    )

    expectRejected(
      f.schema.commit({ head: 'main', message: 'regress clock' }, (tx) => {
        tx.patch(f.worldModel.lenses.world, { clock: 4 })
      }),
      'clock_regression_forbidden',
    )
    expect(f.head()).toBe(first.id)

    expectRejected(
      f.schema.commit(
        {
          head: 'main',
          message: f.worldModel.messages.l0Step.create({
            storyTimeStart: 0,
            storyTimeEnd: 10,
            summary: 'misaligned step',
          }),
        },
        (tx) => {
          tx.patch(f.worldModel.lenses.world, { clock: 9 })
        },
      ),
      'step_time_mismatch',
    )

    expectRejected(
      f.schema.commit({ head: 'main', message: 'manual_edit' }, (tx) => {
        tx.patch(f.worldModel.lenses.world, { clock: 1 })
      }),
      'clock_regression_forbidden',
    )

    const rewound = f.commit(
      f.worldModel.messages.manualEdit.create({ summary: 'author rewind' }),
      (tx) => {
        tx.patch(f.worldModel.lenses.world, { clock: 1 })
      },
    )
    expect(unwrap(f.schema.get(rewound.id, f.worldModel.lenses.world.field('clock')))).toEqual(
      some(1),
    )
  })
})

describe('entity domain invariants', () => {
  test('rejects a second staged member of the same physical body', () => {
    const f = setup()
    seedBase(f)
    f.commit('create mask without a location', (tx) => {
      tx.set(f.worldModel.lenses.characters.at('night_owl'), {
        name: 'Night Owl',
        controlledBy: key('character', 'alice'),
        sharedBody: true,
      })
    })
    expectRejected(
      f.schema.commit({ head: 'main', message: 'stage mask' }, (tx) => {
        tx.patch(f.worldModel.lenses.characters.at('night_owl'), {
          location: key('location', 'room'),
        })
      }),
      'shared_body_multiple_staged_actors',
    )
    const staged = unwrap(
      f.schema.get(f.head(), f.worldModel.lenses.characters.at('night_owl').field('location')),
    )
    expect(staged).toEqual(NONE)

    f.commit('stage distinct independent body', (tx) => {
      tx.set(f.worldModel.lenses.characters.at('clone'), {
        name: 'Clone',
        controlledBy: key('character', 'alice'),
        sharedBody: false,
        location: key('location', 'room'),
      })
    })
  })

  test('rejects an organisation leader outside the member list', () => {
    const f = setup()
    seedBase(f)
    expectRejected(
      f.schema.commit({ head: 'main', message: 'create guild' }, (tx) => {
        tx.set(f.worldModel.lenses.organizations.at('guild'), {
          name: 'Guild',
          leader: key('character', 'alice'),
        })
      }),
      'organization_leader_not_in_members',
    )
    f.commit('create guild with leader membership', (tx) => {
      tx.set(f.worldModel.lenses.organizations.at('guild'), {
        name: 'Guild',
        leader: key('character', 'alice'),
        members: [key('character', 'alice')],
      })
    })
  })

  test('rejects self relations, duplicate directed pairs, bad scores and route sensory mismatch', () => {
    const f = setup()
    seedBase(f)
    f.commit('create second actor', (tx) => {
      tx.set(f.worldModel.lenses.characters.at('bob'), { name: 'Bob' })
    })

    expectRejected(
      f.schema.commit({ head: 'main', message: 'self relation' }, (tx) => {
        tx.set(f.worldModel.lenses.relations.at('self'), {
          from: key('character', 'alice'),
          to: key('character', 'alice'),
        })
      }),
      'relation_self_loop_forbidden',
    )

    f.commit('create directed relation', (tx) => {
      tx.set(f.worldModel.lenses.relations.at('alice_bob'), {
        from: key('character', 'alice'),
        to: key('character', 'bob'),
      })
    })
    expectRejected(
      f.schema.commit({ head: 'main', message: 'duplicate relation' }, (tx) => {
        tx.set(f.worldModel.lenses.relations.at('copy'), {
          from: key('character', 'alice'),
          to: key('character', 'bob'),
        })
      }),
      'duplicate_directed_relation',
    )

    expectRejected(
      f.schema.commit({ head: 'main', message: 'bad item quantity' }, (tx) => {
        tx.set(f.worldModel.lenses.items.at('bad'), { name: 'Bad', quantity: -1 })
      }),
      'score_out_of_range',
    )

    expectRejected(
      f.schema.commit({ head: 'main', message: 'bad reaction' }, (tx) => {
        tx.set(f.worldModel.lenses.characters.at('slow'), { name: 'Slow', reactionSpeed: 0 })
      }),
      'score_out_of_range',
    )

    expectRejected(
      f.schema.commit({ head: 'main', message: 'bad route sense target' }, (tx) => {
        tx.set(f.worldModel.lenses.routes.at('door'), {
          from: key('location', 'room'),
          to: key('location', 'hall'),
          senseTarget: key('location', 'room'),
        })
      }),
      'route_sense_target_mismatch',
    )
  })
})

describe('atomic item, ability and fuse helpers', () => {
  test('assignItem grants knowledge and preserves owners while a failed helper rolls back', () => {
    const f = setup()
    seedBase(f)
    f.commit('create item and ability', (tx) => {
      tx.set(f.worldModel.lenses.items.at('sword'), {
        name: 'Sword',
        effect: 'cuts deeply',
        limits: 'heavy',
      })
      tx.set(f.worldModel.lenses.abilities.at('fire'), {
        name: 'Fire',
        effect: 'burns',
        limits: 'costs mana',
        flaw: 'water',
      })
    })

    const gave = f.commit('give sword', (tx) => {
      unwrap(
        f.worldModel.assignItem(tx, 'sword', some(f.path('character', 'alice')), [
          f.path('character', 'alice'),
        ]),
      )
    })
    const sword = present(unwrap(f.schema.get(gave.id, f.worldModel.lenses.items.at('sword'))))
    expect(sword.holder).toEqual(some(key('character', 'alice')))
    expect(sword.owners).toEqual([key('character', 'alice')])
    const effect = unwrap(
      f.perspective.inspect(gave.id, f.path('character', 'alice'), [
        [...f.path('item', 'sword'), 'effect'],
      ]),
    )
    expect(effect[0]?.value).toBe('cuts deeply')

    const gifted = f.commit('grant fire', (tx) => {
      unwrap(
        f.worldModel.grantAbility(tx, 'fire', f.path('character', 'alice'), { knowFlaw: true }),
      )
      unwrap(
        f.worldModel.grantAbility(tx, 'fire', f.path('character', 'alice'), { knowFlaw: true }),
      )
    })
    const fire = present(unwrap(f.schema.get(gifted.id, f.worldModel.lenses.abilities.at('fire'))))
    expect(fire.owners).toEqual([key('character', 'alice')])
    const flaw = unwrap(
      f.perspective.inspect(gifted.id, f.path('character', 'alice'), [
        [...f.path('ability', 'fire'), 'flaw'],
      ]),
    )
    expect(flaw[0]?.value).toBe('water')

    const failedCommit = unwrap(
      f.schema.commit({ head: 'main', message: 'failed assign' }, (tx) => {
        tx.patch(f.worldModel.lenses.items.at('sword'), { name: 'Renamed' })
        const result = f.worldModel.assignItem(tx, 'sword', some(f.path('location', 'hall')), [
          f.path('location', 'hall'),
        ])
        expect(result.ok).toBe(false)
        const current = present(unwrap(tx.get(f.worldModel.lenses.items.at('sword'))))
        expect(current.name).toBe('Renamed')
        expect(current.holder).toEqual(some(key('character', 'alice')))
      }),
    )
    expect(failedCommit.id.length).toBeGreaterThan(0)

    f.commit('move sword without replacing owners', (tx) => {
      unwrap(f.worldModel.assignItem(tx, 'sword', some(f.path('location', 'hall'))))
    })
    const moved = present(unwrap(f.schema.get(f.head(), f.worldModel.lenses.items.at('sword'))))
    expect(moved.holder).toEqual(some(key('location', 'hall')))
    expect(moved.owners).toEqual([key('character', 'alice')])
  })

  test('pause, resume and consume fuse timers with due and paused guards', () => {
    const f = setup()
    f.commit('seed timers', (tx) => {
      tx.patch(f.worldModel.lenses.world, { clock: 5 })
      tx.set(f.worldModel.lenses.locations.at('room'), { name: 'Room' })
      tx.set(f.worldModel.lenses.fuses.at('one'), {
        host: key('location', 'room'),
        dueAt: 10,
      })
      tx.set(f.worldModel.lenses.fuses.at('recurring'), {
        host: key('location', 'room'),
        dueAt: 10,
        repeatInterval: 5,
      })
      tx.set(f.worldModel.lenses.fuses.at('later'), {
        host: key('location', 'room'),
        dueAt: 20,
      })
    })

    f.commit('pause one-shot', (tx) => {
      unwrap(f.worldModel.pauseFuse(tx, 'one'))
    })
    let one = present(unwrap(f.schema.get(f.head(), f.worldModel.lenses.fuses.at('one'))))
    expect(one.pausedRemaining).toEqual(some(5))

    f.commit('advance to eight', (tx) => {
      tx.patch(f.worldModel.lenses.world, { clock: 8 })
    })
    f.commit('resume one-shot', (tx) => {
      unwrap(f.worldModel.resumeFuse(tx, 'one'))
    })
    one = present(unwrap(f.schema.get(f.head(), f.worldModel.lenses.fuses.at('one'))))
    expect(one.dueAt).toBe(13)
    expect(one.pausedRemaining).toEqual(NONE)

    f.commit('early consume is a domain failure', (tx) => {
      const result = f.worldModel.consumeTriggeredFuse(tx, 'one')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('invalid_claim_target')
    })

    f.commit('advance to thirteen', (tx) => {
      tx.patch(f.worldModel.lenses.world, { clock: 13 })
    })
    f.commit('consume due timers', (tx) => {
      unwrap(f.worldModel.consumeTriggeredFuse(tx, 'one'))
      unwrap(f.worldModel.consumeTriggeredFuse(tx, 'recurring'))
    })
    expect(unwrap(f.schema.get(f.head(), f.worldModel.lenses.fuses.at('one')))).toEqual(NONE)
    const recurring = present(
      unwrap(f.schema.get(f.head(), f.worldModel.lenses.fuses.at('recurring'))),
    )
    expect(recurring.dueAt).toBe(15)

    f.commit('pause later', (tx) => {
      unwrap(f.worldModel.pauseFuse(tx, 'later'))
    })
    f.commit('paused timer cannot be consumed', (tx) => {
      const result = f.worldModel.consumeTriggeredFuse(tx, 'later')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('invalid_claim_target')
      const pauseAgain = f.worldModel.pauseFuse(tx, 'later')
      expect(pauseAgain.ok).toBe(false)
      const current = present(unwrap(tx.get(f.worldModel.lenses.fuses.at('later'))))
      expect(current.pausedRemaining).toEqual(some(7))
    })
    f.commit('resume later', (tx) => {
      unwrap(f.worldModel.resumeFuse(tx, 'later'))
    })
    const later = present(unwrap(f.schema.get(f.head(), f.worldModel.lenses.fuses.at('later'))))
    expect(later.dueAt).toBe(20)
    expect(later.pausedRemaining).toEqual(NONE)
  })
})

describe('watched preconditions', () => {
  test('checkWatchedPathsChanged reports exactly the changed baseline paths', () => {
    const f = setup()
    seedBase(f)
    const conditionPath = Object.freeze(['entities', 'character', 'alice', 'condition'])
    const agendaPath = f.path('agenda', 'watch')
    const seeded = f.commit('seed watched agenda', (tx) => {
      tx.set(f.worldModel.lenses.agendas.at('watch'), {
        host: key('character', 'alice'),
        dueAt: 10,
        summary: 'watch Alice',
        watchPaths: [encodePathKey(conditionPath)],
      })
    })
    expect(unwrap(f.worldModel.checkWatchedPathsChanged(seeded.id, agendaPath))).toEqual([])

    const injured = f.commit('injure Alice', (tx) => {
      tx.patch(f.worldModel.lenses.characters.at('alice'), { condition: 'injured' })
    })
    const changed = unwrap(f.worldModel.checkWatchedPathsChanged(injured.id, agendaPath))
    expect(changed).toHaveLength(1)
    expect(encodePathKey(changed[0]!)).toBe(encodePathKey(conditionPath))

    const invalid = f.worldModel.checkWatchedPathsChanged(injured.id, f.path('character', 'alice'))
    expect(invalid.ok).toBe(false)
  })
})

describe('objective entity tree', () => {
  test('separates containment from ownership and never leaks perspective nodes', () => {
    const f = setup()
    seedBase(f)
    const seeded = f.commit('populate objective tree', (tx) => {
      tx.set(f.worldModel.lenses.items.at('sword'), {
        name: 'Sword',
        holder: key('character', 'alice'),
        owners: [key('character', 'alice')],
      })
      tx.set(f.worldModel.lenses.abilities.at('fire'), {
        name: 'Fire',
        owners: [key('character', 'alice')],
      })
      tx.set(f.worldModel.lenses.agendas.at('plan'), {
        host: key('character', 'alice'),
        dueAt: 3,
        summary: 'Train',
      })
    })

    const tree = present(
      unwrap(f.worldModel.inspectEntityTree(seeded.id, f.path('location', 'room'))),
    )
    expect(tree.kind).toBe('location')
    const alice = tree.containedChildren.find((node) => node.id === 'alice')
    if (!alice) throw new Error('Expected Alice in the room containment tree')
    expect(alice.containedChildren.map((node) => node.id)).toContain('sword')
    expect(alice.ownedChildren.map((node) => node.id)).toEqual(
      expect.arrayContaining(['sword', 'fire', 'plan']),
    )
    const kinds = new Set<string>()
    const visit = (node: typeof tree) => {
      kinds.add(node.kind)
      for (const child of node.containedChildren) visit(child)
      for (const child of node.ownedChildren) visit(child)
    }
    visit(tree)
    expect([...kinds].sort()).toEqual(['ability', 'agenda', 'character', 'item', 'location'])
  })

  test('terminates on a cyclic combined owner graph', () => {
    const f = setup()
    seedBase(f)
    const seeded = f.commit('create sword', (tx) => {
      tx.set(f.worldModel.lenses.items.at('sword'), {
        name: 'Sword',
        holder: key('character', 'alice'),
        owners: [key('character', 'alice')],
      })
    })
    const augmented = unwrap(
      f.schema.augment(f.worldModel.lenses.characters.at('alice'), {
        ownedBy: s
          .link({ targetRoots: [ITEM_ROOT_PATH], onDelete: 'unlink' })
          .optional()
          .meta({ linkRoles: ['owner'] }),
      }),
    )
    unwrap(f.schema.syncSchema({ head: 'main' }))
    f.commit('close owner cycle', (tx) => {
      tx.set(augmented.field('ownedBy'), key('item', 'sword'))
    })
    const tree = present(
      unwrap(f.worldModel.inspectEntityTree(f.head(), f.path('character', 'alice'))),
    )
    const sword = tree.ownedChildren.find((node) => node.id === 'sword')
    if (!sword) throw new Error('Expected the sword owner edge')
    expect(sword.ownedChildren.map((node) => node.id)).not.toContain('alice')
    expect(seeded.id.length).toBeGreaterThan(0)
  })
})
