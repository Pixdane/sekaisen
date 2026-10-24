import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function present<T>(value: Option<T>): T {
  if (value.kind === 'none') throw new Error('Expected present value')
  return value.value
}

function expectConflict(
  result: { ok: boolean; error?: unknown },
  reason: string,
  path?: readonly string[],
): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  const error = result.error as {
    readonly kind: string
    readonly reason?: string
    readonly path?: readonly string[]
  }
  expect(error.kind).toBe('schema_conflict')
  expect(error.reason).toBe(reason)
  if (path !== undefined) expect([...(error.path ?? [])]).toEqual([...path])
}

function expectValidationFailure(result: { ok: boolean; error?: unknown }, reason: string): void {
  expect(result.ok).toBe(false)
  if (result.ok) return
  const error = result.error as { readonly kind: string; readonly reason?: string }
  expect(error.kind).toBe('validation_failed')
  expect(error.reason).toBe(reason)
}

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function setup() {
  const driver = createBunSqliteDriver()
  drivers.push(driver)
  const ctx = new Context()
  const world = new WorldService(ctx, { driver })
  const schema = new SchemaService(ctx)
  return { ctx, world, schema }
}

describe('schema integrity audit', () => {
  test('rollback preserves pre-scope writes when a scoped overwrite is rejected', () => {
    const { schema } = setup()
    const places = unwrap(
      schema.define(
        ['places'],
        s.map(
          s.struct({
            label: s.str().default(''),
            rooms: s.map(s.struct({ label: s.str().default('') })),
          }),
        ),
      ),
    )
    // Declaring a link into `places` makes overwriteStruct take the rollback
    // scope even though no character instance participates in this scenario.
    unwrap(
      schema.define(
        ['characters'],
        s.map(
          s.struct({
            name: s.str().default(''),
            home: s.link({ targetRoots: [['places']], onDelete: 'reject' }).optional(),
          }),
        ),
      ),
    )
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(places.at('castle'), { label: 'Original', rooms: { hall: { label: 'Hall' } } })
      }),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'preserve wanted' }, (tx) => {
        const castle = places.at('castle')
        tx.patch(castle, { label: 'Wanted' })
        // `label` is written before `rooms` rejects, so the failed overwrite
        // creates a same-key node under a fresh children Map. Rolling back must
        // restore the snapshot and remove only that creation, never the
        // restored pre-scope `label` node.
        expect(() =>
          tx.overwriteStruct(castle, {
            label: 'Broken',
            // @ts-expect-error Exercise runtime rejection of a malformed Map payload.
            rooms: 42,
          }),
        ).toThrow()
        expect(present(unwrap(tx.get(castle))).label).toBe('Wanted')
        expect(present(unwrap(tx.get(castle.$.rooms.at('hall')))).label).toBe('Hall')
      }),
    )
    const final = present(unwrap(schema.get(commit.id, places.at('castle'))))
    expect(final.label).toBe('Wanted')
    expect(final.rooms.hall?.label).toBe('Hall')
  })

  test('rejects source-less link placements at registration', () => {
    const { schema } = setup()
    const results = [
      schema.define(['badRootLeaf'], s.link({ targetRoots: [['places']] })),
      schema.define(['badRootList'], s.linkList({ targetRoots: [['places']] }).default([])),
      schema.define(['badRootMap'], s.map(s.link({ targetRoots: [['places']] }))),
      schema.define(['badNestedMap'], s.map(s.map(s.link({ targetRoots: [['places']] })))),
    ]
    for (const result of results) expectConflict(result, 'link_source_struct_required')
  })

  test('registers Struct-owned roots with nested Map-owned link sources', () => {
    const { schema } = setup()
    const places = unwrap(
      schema.define(['places'], s.map(s.struct({ label: s.str().default('') }))),
    )
    const characters = unwrap(
      schema.define(
        ['characters'],
        s.map(
          s.struct({
            name: s.str().default(''),
            home: s.link({ targetRoots: [['places']] }).optional(),
            roster: s.map(s.link({ targetRoots: [['places']] })),
          }),
        ),
      ),
    )
    const castle = encodePathKey(['places', 'castle'])
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(places.at('castle'), { label: 'Castle' })
        tx.set(characters.at('alice'), { home: castle, roster: { inn: castle } })
      }),
    )
    const view = unwrap(schema.viewAt(commit.id))
    const links = unwrap(view.backlinks(['places', 'castle']))
    expect(links).toHaveLength(2)
    for (const entry of links)
      expect([...entry.sourceInstancePath]).toEqual(['characters', 'alice'])
    expect(links.map((entry) => encodePathKey(entry.fieldRelativePath)).sort()).toEqual(
      [encodePathKey(['home']), encodePathKey(['roster', 'inn'])].sort(),
    )
  })

  test('augment keeps direct and Map links owned by the target Struct', () => {
    const { schema } = setup()
    const places = unwrap(
      schema.define(['places'], s.map(s.struct({ label: s.str().default('') }))),
    )
    const characters = unwrap(
      schema.define(['characters'], s.map(s.struct({ name: s.str().default('') }))),
    )
    const augmented = unwrap(
      schema.augment(characters.at('alice'), {
        home: s.link({ targetRoots: [['places']], onDelete: 'unlink' }).optional(),
        roster: s.map(s.link({ targetRoots: [['places']] }).optional()),
      }),
    )
    const castle = encodePathKey(['places', 'castle'])
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'augment links' }, (tx) => {
        tx.set(places.at('castle'), { label: 'Castle' })
        tx.set(augmented, { name: 'Alice', home: castle, roster: { inn: castle } })
      }),
    )
    const alice = present(unwrap(schema.get(commit.id, augmented)))
    expect(alice.name).toBe('Alice')
    expect(alice.home.kind).toBe('some')
    if (alice.home.kind === 'some') expect(alice.home.value).toBe(castle)
  })

  test('rejects link metadata on custom leaf definitions', () => {
    const { schema } = setup()
    const actors = unwrap(
      schema.define(['actors'], s.map(s.struct({ name: s.str().default('') }).extensible())),
    )
    const created = unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(actors.at('alice'), { name: 'Alice' })
      }),
    )
    const rejected = schema.commit({ head: 'main', message: 'custom link' }, (tx) => {
      tx.defineCustom(
        actors.at('alice'),
        'friend',
        s.link({ targetRoots: [['actors']] }).optional(),
        encodePathKey(['actors', 'alice']),
      )
    })
    expectConflict(rejected, 'link_custom_field_forbidden', [
      'actors',
      'alice',
      '$custom',
      'friend',
    ])
    const view = unwrap(schema.viewAt(created.id))
    expect(present(unwrap(view.get(actors.at('alice')))).name).toBe('Alice')
  })

  test('untagged acyclicity cannot collide with a public role named declaration:0', () => {
    const { schema } = setup()
    const nodes = unwrap(
      schema.define(
        ['nodes'],
        s.map(
          s.struct({
            name: s.str().default(''),
            friend: s.link({ targetRoots: [['nodes']], acyclic: true }).optional(),
            manager: s
              .link({ targetRoots: [['nodes']], exclusiveRole: 'declaration:0' })
              .optional(),
          }),
        ),
      ),
    )
    const created = unwrap(
      schema.commit({ head: 'main', message: 'independent role namespaces' }, (tx) => {
        tx.set(nodes.at('a'), { name: 'A' })
        tx.set(nodes.at('b'), { name: 'B' })
        tx.set(nodes.at('a').$.friend, encodePathKey(['nodes', 'b']))
        tx.set(nodes.at('b').$.manager, encodePathKey(['nodes', 'a']))
      }),
    )
    const view = unwrap(schema.viewAt(created.id))
    expect(unwrap(view.get(nodes.at('a').$.friend))).toEqual(some(encodePathKey(['nodes', 'b'])))
    expect(unwrap(view.get(nodes.at('b').$.manager))).toEqual(some(encodePathKey(['nodes', 'a'])))

    const cycle = schema.commit({ head: 'main', message: 'actual friend cycle' }, (tx) => {
      tx.set(nodes.at('b').$.friend, encodePathKey(['nodes', 'a']))
    })
    expectValidationFailure(cycle, 'link_cycle')
  })

  test('distinct untagged declarations stay separate across concrete Map entries', () => {
    const { schema } = setup()
    const nodes = unwrap(
      schema.define(
        ['nodes'],
        s.map(
          s.struct({
            name: s.str().default(''),
            friend: s.link({ targetRoots: [['nodes']], acyclic: true }).optional(),
            peer: s.link({ targetRoots: [['nodes']], acyclic: true }).optional(),
          }),
        ),
      ),
    )
    const created = unwrap(
      schema.commit({ head: 'main', message: 'separate untagged declarations' }, (tx) => {
        tx.set(nodes.at('a'), { name: 'A' })
        tx.set(nodes.at('b'), { name: 'B' })
        tx.set(nodes.at('a').$.friend, encodePathKey(['nodes', 'b']))
        tx.set(nodes.at('b').$.peer, encodePathKey(['nodes', 'a']))
      }),
    )
    const view = unwrap(schema.viewAt(created.id))
    expect(unwrap(view.get(nodes.at('a').$.friend))).toEqual(some(encodePathKey(['nodes', 'b'])))
    expect(unwrap(view.get(nodes.at('b').$.peer))).toEqual(some(encodePathKey(['nodes', 'a'])))

    const cycle = schema.commit({ head: 'main', message: 'same peer declaration cycle' }, (tx) => {
      tx.set(nodes.at('a').$.peer, encodePathKey(['nodes', 'b']))
    })
    expectValidationFailure(cycle, 'link_cycle')
  })

  test('acyclic activation comes from an absent marked declaration', () => {
    const { schema } = setup()
    const nodes = unwrap(
      schema.define(
        ['nodes'],
        s.map(
          s.struct({
            name: s.str().default(''),
            left: s
              .link({ targetRoots: [['nodes']], acyclic: true, exclusiveRole: 'edge' })
              .optional(),
            right: s.link({ targetRoots: [['nodes']], exclusiveRole: 'edge' }).optional(),
          }),
        ),
      ),
    )
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(nodes.at('a'), { name: 'A' })
        tx.set(nodes.at('b'), { name: 'B' })
        tx.set(nodes.at('c'), { name: 'C' })
      }),
    )
    // `left` has no value on any instance. Its acyclic declaration must still
    // activate the shared 'edge' union, so the `right` cycle is rejected.
    const cycle = schema.commit({ head: 'main', message: 'right cycle' }, (tx) => {
      tx.patch(nodes.at('a'), { right: encodePathKey(['nodes', 'b']) })
      tx.patch(nodes.at('b'), { right: encodePathKey(['nodes', 'a']) })
    })
    expectValidationFailure(cycle, 'link_cycle')
    const chain = unwrap(
      schema.commit({ head: 'main', message: 'right chain' }, (tx) => {
        tx.patch(nodes.at('a'), { right: encodePathKey(['nodes', 'b']) })
        tx.patch(nodes.at('b'), { right: encodePathKey(['nodes', 'c']) })
      }),
    )
    const view = unwrap(schema.viewAt(chain.id))
    expect(unwrap(view.get(nodes.at('a').$.right))).toEqual(some(encodePathKey(['nodes', 'b'])))
    expect(unwrap(view.get(nodes.at('b').$.right))).toEqual(some(encodePathKey(['nodes', 'c'])))
    expect(unwrap(view.get(nodes.at('a').$.left))).toEqual(NONE)
  })

  test('acyclic activation comes from a marked root with no live instance', () => {
    const { schema } = setup()
    const nodes = unwrap(
      schema.define(
        ['nodes'],
        s.map(
          s.struct({
            name: s.str().default(''),
            right: s.link({ targetRoots: [['nodes']], exclusiveRole: 'edge' }).optional(),
          }),
        ),
      ),
    )
    // `anchors` declares the only acyclic 'edge' link and receives no instance.
    unwrap(
      schema.define(
        ['anchors'],
        s.map(
          s.struct({
            left: s
              .link({ targetRoots: [['nodes']], acyclic: true, exclusiveRole: 'edge' })
              .optional(),
          }),
        ),
      ),
    )
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(nodes.at('a'), { name: 'A' })
        tx.set(nodes.at('b'), { name: 'B' })
      }),
    )
    const cycle = schema.commit({ head: 'main', message: 'right cycle' }, (tx) => {
      tx.patch(nodes.at('a'), { right: encodePathKey(['nodes', 'b']) })
      tx.patch(nodes.at('b'), { right: encodePathKey(['nodes', 'a']) })
    })
    expectValidationFailure(cycle, 'link_cycle')
    const chain = unwrap(
      schema.commit({ head: 'main', message: 'right chain' }, (tx) => {
        tx.patch(nodes.at('a'), { right: encodePathKey(['nodes', 'b']) })
      }),
    )
    expect(present(unwrap(schema.get(chain.id, nodes.at('a').$.right)))).toBe(
      encodePathKey(nodes.at('b').path),
    )
  })

  test('acyclic activation comes from a marked list that stays empty', () => {
    const { schema } = setup()
    const nodes = unwrap(
      schema.define(
        ['nodes'],
        s.map(
          s.struct({
            name: s.str().default(''),
            right: s.link({ targetRoots: [['nodes']], exclusiveRole: 'owner' }).optional(),
          }),
        ),
      ),
    )
    const lists = unwrap(
      schema.define(
        ['lists'],
        s.map(
          s.struct({
            edges: s
              .linkList({ targetRoots: [['nodes']], acyclic: true })
              .default([])
              .meta({ linkRoles: ['owner'] }),
          }),
        ),
      ),
    )
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(nodes.at('a'), { name: 'A' })
        tx.set(nodes.at('b'), { name: 'B' })
        // Materializes the default empty list; no live edge is emitted.
        tx.set(lists.at('box'), {})
      }),
    )
    const cycle = schema.commit({ head: 'main', message: 'right cycle' }, (tx) => {
      tx.patch(nodes.at('a'), { right: encodePathKey(['nodes', 'b']) })
      tx.patch(nodes.at('b'), { right: encodePathKey(['nodes', 'a']) })
    })
    expectValidationFailure(cycle, 'link_cycle')
    const chain = unwrap(
      schema.commit({ head: 'main', message: 'right chain' }, (tx) => {
        tx.patch(nodes.at('a'), { right: encodePathKey(['nodes', 'b']) })
      }),
    )
    const view = unwrap(schema.viewAt(chain.id))
    expect(present(unwrap(view.get(lists.at('box')))).edges).toEqual([])
  })
})
