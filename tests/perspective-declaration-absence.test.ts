import { afterEach, describe, expect, test } from 'bun:test'
import { NONE } from '@sekaisen/core'
import type { LensFor } from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'
import type { Context } from 'cordis'
import { claimMember, PerspectiveFixture, unwrap } from './perspective-fixture.ts'

const fixtures: PerspectiveFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.driver.close()
})

/** Give each declaration/absence boundary an isolated real SQLite history. */
function setup(): PerspectiveFixture {
  const fixture = new PerspectiveFixture()
  fixtures.push(fixture)
  return fixture
}

describe('historical persistence follows Writer declarations, not physical values', () => {
  test('absent ephemeral leaves, optional ancestors and Map members reject without claim writes', () => {
    const f = setup()
    const effects = unwrap(
      f.schema.define(
        ['effects'],
        s.map(
          s.struct({
            nested: s.struct({ pulse: s.str().optional().meta({ ephemeral: true }) }).optional(),
            stream: s.map(s.str().meta({ ephemeral: true })),
          }),
        ),
      ),
    )
    const seeded = f.seed()
    const paths = [
      f.at('note').$.ephemeralText.path,
      f.at('ghost').$.ephemeralText.path,
      effects.at('ghost').$.nested.$.pulse.path,
      effects.at('ghost').$.stream.at('silent').path,
    ]
    for (const path of paths)
      expect(unwrap(f.schema.inspectInstance(seeded.id, path))).toEqual(NONE)

    const attempted = f.commit(
      'reject every absent transient fact but remember ordinary absence',
      (tx) => {
        const before = unwrap(tx.inspectInstance(['perspectives']))
        for (const path of paths) {
          expect(
            f.perspective.grantKnowledge(tx, f.at('alice'), path, { atCommitId: seeded.id }),
          ).toMatchObject({
            ok: false,
            error: {
              kind: 'invalid_claim_target',
              targetPath: path,
              reason: 'cannot_persist_claim_on_ephemeral_field',
            },
          })
          expect(unwrap(tx.inspectInstance(['perspectives']))).toEqual(before)
        }
        unwrap(
          f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').$.passiveText.path, {
            atCommitId: seeded.id,
          }),
        )
      },
    )
    expect(
      claimMember(
        f.latestObserved(attempted.id, 'alice', f.at('note').$.passiveText.path),
        'targetRef',
      ),
    ).toEqual({
      commitId: seeded.id,
      path: f.at('note').$.passiveText.path,
    })
  })

  test('missing historical fields keep their Writer restrictions after the current Reader reverses them', async () => {
    const f = setup()
    const oldModel = s.map(
      s.struct({
        formerlyTransient: s.str().optional().meta({ ephemeral: true }),
        formerlyDurable: s.str().optional(),
      }),
    )
    let signals!: LensFor<typeof oldModel>
    const original = f.ctx.plugin((scope: Context) => {
      signals = unwrap(scope.schema.define(['signals'], oldModel))
    })
    await original
    const seeded = f.seed()
    const transient = signals.at('missing').$.formerlyTransient.path
    const durable = signals.at('missing').$.formerlyDurable.path
    expect(unwrap(f.schema.inspectInstance(seeded.id, transient))).toEqual(NONE)
    expect(unwrap(f.schema.inspectInstance(seeded.id, durable))).toEqual(NONE)
    await original.dispose()
    unwrap(
      f.schema.define(
        ['signals'],
        s.map(
          s.struct({
            formerlyTransient: s.str().optional(),
            formerlyDurable: s.str().optional().meta({ ephemeral: true }),
          }),
        ),
      ),
    )
    unwrap(f.schema.syncSchema({ head: 'main' }))

    const remembered = f.commit('honor the missing fields declarations at fact time', (tx) => {
      const before = unwrap(tx.inspectInstance(['perspectives']))
      expect(
        f.perspective.grantKnowledge(tx, f.at('alice'), transient, { atCommitId: seeded.id }),
      ).toMatchObject({
        ok: false,
        error: { kind: 'invalid_claim_target', reason: 'cannot_persist_claim_on_ephemeral_field' },
      })
      expect(unwrap(tx.inspectInstance(['perspectives']))).toEqual(before)
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), durable, { atCommitId: seeded.id }))
      const afterHistoricalGrant = unwrap(tx.inspectInstance(['perspectives']))
      expect(f.perspective.grantKnowledge(tx, f.at('alice'), durable)).toMatchObject({
        ok: false,
        error: { kind: 'invalid_claim_target', reason: 'cannot_persist_claim_on_ephemeral_field' },
      })
      expect(unwrap(tx.inspectInstance(['perspectives']))).toEqual(afterHistoricalGrant)
    })
    expect(claimMember(f.latestObserved(remembered.id, 'alice', durable), 'targetRef')).toEqual({
      commitId: seeded.id,
      path: durable,
    })
  })
})
