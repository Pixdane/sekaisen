import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { NONE } from '@sekaisen/core'
import { LINK_META_KEYS, linkTraitsOf, SchemaService, s } from '@sekaisen/plugin-schema'
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

const charactersSchema = s.map(
  s.struct({
    name: s.str().default(''),
    home: s.link({ targetRoots: [['places']], onDelete: 'cascade' }).optional(),
    post: s.link({ targetRoots: [['places']], onDelete: 'cascade' }).optional(),
    friend: s.link({ targetRoots: [['characters']], onDelete: 'reject' }).optional(),
    guild: s.link({ targetRoots: [['guilds']], onDelete: 'unlink' }).optional(),
    memberships: s.linkList({ targetRoots: [['guilds']], onDelete: 'unlink' }).default([]),
    parent: s
      .link({ targetRoots: [['characters']], acyclic: true, exclusiveRole: 'parent' })
      .optional(),
    mentor: s
      .link({ targetRoots: [['characters']], acyclic: true, exclusiveRole: 'parent' })
      .optional(),
  }),
)

const placesSchema = s.map(
  s.struct({
    label: s.str().default(''),
    rooms: s.map(s.struct({ label: s.str().default('') })),
  }),
)

const guildsSchema = s.map(s.struct({ label: s.str().default('') }))

function standardRoots(schema: SchemaService) {
  const characters = unwrap(schema.define(['characters'], charactersSchema))
  const places = unwrap(schema.define(['places'], placesSchema))
  const guilds = unwrap(schema.define(['guilds'], guildsSchema))
  return { characters, places, guilds }
}

describe('schema links', () => {
  test('validates link traits and registration rules', () => {
    const { schema } = setup()
    expect(() => s.link({ targetRoots: [] })).toThrow()
    expect(() => s.link({ targetRoots: [[]] })).toThrow()

    const requiredUnlink = schema.define(
      ['actors'],
      s.struct({
        place: s.link({ targetRoots: [['places']], onDelete: 'unlink' }),
      }),
    )
    expect(requiredUnlink.ok).toBe(false)
    if (!requiredUnlink.ok && requiredUnlink.error.kind === 'schema_conflict')
      expect(requiredUnlink.error.reason).toBe('link_unlink_requires_optional')

    const listExclusive = schema.define(
      ['actors'],
      s.struct({
        places: s.linkList({ targetRoots: [['places']], exclusiveRole: 'parent' }).default([]),
      }),
    )
    expect(listExclusive.ok).toBe(false)
    if (!listExclusive.ok && listExclusive.error.kind === 'schema_conflict')
      expect(listExclusive.error.reason).toBe('link_list_exclusive_role_forbidden')

    const valid = unwrap(
      schema.define(
        ['actors'],
        s.struct({
          place: s.link({ targetRoots: [['places']], onDelete: 'unlink' }).optional(),
        }),
      ),
    )
    const placeSpec = valid.schema.fields.place
    expect(placeSpec?.nodeKind).toBe('leaf')
    if (placeSpec?.nodeKind === 'leaf') {
      const traits = linkTraitsOf(placeSpec)
      expect(traits?.onDelete).toBe('unlink')
      expect(traits?.targetRoots.map((path) => [...path])).toEqual([['places']])
    }
    expect(placeSpec?.metadata[LINK_META_KEYS.targetRoots]).toEqual([encodePathKey(['places'])])
  })

  test('indexes live backlinks per fixed view and supports introspection', () => {
    const { schema } = setup()
    const { characters, places } = standardRoots(schema)
    const castle = encodePathKey(['places', 'castle'])
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(places.at('castle'), { label: 'Castle' })
        tx.set(characters.at('alice'), { name: 'Alice', home: castle })
      }),
    )
    const view = unwrap(schema.viewAt(commit.id))
    expect(view.listRootPaths().map((path) => [...path])).toEqual([
      ['characters'],
      ['guilds'],
      ['places'],
    ])
    const links = unwrap(view.backlinks(['places', 'castle']))
    expect(links).toHaveLength(1)
    expect([...links[0]!.sourceInstancePath]).toEqual(['characters', 'alice'])
    expect([...links[0]!.sourceRootPath]).toEqual(['characters'])
    expect([...links[0]!.fieldRelativePath]).toEqual(['home'])
    expect(links[0]!.onDelete).toBe('cascade')
    expect(linkTraitsOf(links[0]!.fieldSpec)?.dynamicTargetRoots).toBe(false)

    expect(
      unwrap(view.backlinks(['places', 'castle'], { sourceRootPath: ['places'] })),
    ).toHaveLength(0)
    expect(
      unwrap(
        view.backlinks(['places', 'castle'], {
          filterFieldSpec: (spec) => spec.metadata[LINK_META_KEYS.acyclic] === true,
        }),
      ),
    ).toHaveLength(0)

    expect({ ...present(unwrap(view.getInstanceMeta(characters.at('alice')))) }).toEqual({})
    const inspection = present(unwrap(view.inspectInstance(['characters', 'alice'])))
    expect(inspection.nodeKind).toBe('struct')
    if (inspection.nodeKind === 'struct') expect({ ...inspection.meta }).toEqual({})

    const instanceLens = unwrap(view.lensAt(['characters', 'alice']))
    expect(instanceLens.opticKind).toBe('struct')
    const fieldLens = unwrap(view.lensAt(['characters', 'alice', 'home']))
    expect(fieldLens.opticKind).toBe('field')
    expect(present(unwrap(view.get(fieldLens)))).toBe(castle)
    const roomLens = unwrap(view.lensAt(['places', 'castle', 'rooms', 'hall']))
    expect(roomLens.opticKind).toBe('struct')
  })

  test('same-path overwrite does not cascade and keeps live reference edges', () => {
    const { schema } = setup()
    const { characters, places } = standardRoots(schema)
    const castle = encodePathKey(['places', 'castle'])
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(places.at('castle'), { label: 'Castle' })
        tx.set(characters.at('alice'), { home: castle })
      }),
    )
    const overwritten = unwrap(
      schema.commit({ head: 'main', message: 'rebuild' }, (tx) => {
        tx.overwriteStruct(places.at('castle'), { label: 'New Castle' })
      }),
    )
    expect(unwrap(schema.get(overwritten.id, characters.at('alice'))).kind).toBe('some')
    const view = unwrap(schema.viewAt(overwritten.id))
    expect(unwrap(view.backlinks(['places', 'castle']))).toHaveLength(1)
    expect(present(unwrap(view.get(places.at('castle')))).label).toBe('New Castle')
  })

  test('draft backlinks observe current edges, patch unlinks and same-draft target removal', () => {
    const { schema } = setup()
    const { characters, places } = standardRoots(schema)
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(places.at('castle'), { label: 'Castle' })
        tx.set(characters.at('bob'), { name: 'Bob' })
        tx.set(characters.at('alice'), {
          home: encodePathKey(['places', 'castle']),
          friend: encodePathKey(['characters', 'bob']),
        })
      }),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'retarget' }, (tx) => {
        tx.patch(characters.at('alice'), { friend: null })
        expect(unwrap(tx.backlinks(['characters', 'bob']))).toHaveLength(0)
        tx.setInstanceMeta(characters.at('alice'), {
          visibility: 'self',
          containerOpen: true,
        })
        expect({ ...present(unwrap(tx.getInstanceMeta(characters.at('alice')))) }).toEqual({
          visibility: 'self',
          containerOpen: true,
        })
        const inspection = present(unwrap(tx.inspectInstance(['characters', 'alice'])))
        if (inspection.nodeKind === 'struct')
          expect({ ...inspection.meta }).toEqual({ visibility: 'self', containerOpen: true })
        // The field was removed in this same draft, so deleting its target is legal.
        tx.delete(characters.at('bob'))
        expect(unwrap(tx.get(characters.at('bob'))).kind).toBe('none')
      }),
    )
    expect(unwrap(schema.get(commit.id, characters.at('bob'))).kind).toBe('none')
    const view = unwrap(schema.viewAt(commit.id))
    expect({ ...present(unwrap(view.getInstanceMeta(characters.at('alice')))) }).toEqual({
      visibility: 'self',
      containerOpen: true,
    })
  })

  test('a single map write can remove a target together with its live reference', () => {
    const { schema } = setup()
    const { characters } = standardRoots(schema)
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(characters.at('bob'), { name: 'Bob' })
        tx.set(characters.at('alice'), {
          name: 'Alice',
          friend: encodePathKey(['characters', 'bob']),
        })
      }),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'atomic' }, (tx) => {
        // Bob disappears and Alice's only reference to him is removed in the
        // same map write, so the post-state has no live reject edge.
        tx.set(characters, { alice: { name: 'Alice', friend: null } })
      }),
    )
    const view = unwrap(schema.viewAt(commit.id))
    expect(unwrap(view.get(characters.at('bob'))).kind).toBe('none')
    expect(unwrap(view.get(characters.at('alice'))).kind).toBe('some')
    expect(unwrap(view.backlinks(['characters', 'bob']))).toHaveLength(0)
  })

  test('reject policy aborts and rolls the draft back without partial mutation', () => {
    const { schema } = setup()
    const { characters } = standardRoots(schema)
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(characters.at('bob'), { name: 'Bob' })
        tx.set(characters.at('alice'), { friend: encodePathKey(['characters', 'bob']) })
      }),
    )
    const rejected = schema.commit({ head: 'main', message: 'delete' }, (tx) => {
      tx.delete(characters.at('bob'))
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.kind).toBe('validation_failed')
      if (rejected.error.kind === 'validation_failed')
        expect(rejected.error.reason).toBe('referenced_target_not_deletable')
    }
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'retry' }, (tx) => {
        let threw = false
        try {
          tx.delete(characters.at('bob'))
        } catch {
          threw = true
        }
        expect(threw).toBe(true)
        // The failed operation must leave no trace in the draft.
        expect(unwrap(tx.get(characters.at('bob'))).kind).toBe('some')
      }),
    )
    expect(unwrap(schema.get(commit.id, characters.at('bob'))).kind).toBe('some')
    expect(unwrap(unwrap(schema.viewAt(commit.id)).backlinks(['characters', 'bob']))).toHaveLength(
      1,
    )
  })

  test('cascade closure deletes sources of nested target instances', () => {
    const { schema } = setup()
    const { characters, places } = standardRoots(schema)
    const hall = encodePathKey(['places', 'wing', 'rooms', 'hall'])
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(places.at('wing'), { label: 'Wing', rooms: { hall: { label: 'Hall' } } })
        tx.set(characters.at('alice'), { home: encodePathKey(['places', 'wing']) })
        tx.set(characters.at('guard'), { name: 'Guard', post: hall })
      }),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'delete wing' }, (tx) => {
        tx.delete(places.at('wing'))
      }),
    )
    const view = unwrap(schema.viewAt(commit.id))
    expect(unwrap(view.get(places.at('wing'))).kind).toBe('none')
    expect(unwrap(view.get(characters.at('alice'))).kind).toBe('none')
    expect(unwrap(view.get(characters.at('guard'))).kind).toBe('none')
    expect(unwrap(view.inspectInstance(['places', 'wing', 'rooms', 'hall'])).kind).toBe('none')
  })

  test('acyclic role union includes co-role fields without their own flag', () => {
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
        tx.set(nodes.at('b'), { name: 'B' })
        tx.set(nodes.at('a'), { name: 'A', left: encodePathKey(['nodes', 'b']) })
      }),
    )
    // `right` does not declare acyclic itself, but shares exclusiveRole 'edge'
    // with `left`; the union must still include both edges and detect a cycle.
    const cycle = schema.commit({ head: 'main', message: 'cross-field cycle' }, (tx) => {
      tx.patch(nodes.at('b'), { right: encodePathKey(['nodes', 'a']) })
    })
    expect(cycle.ok).toBe(false)
    if (!cycle.ok && cycle.error.kind === 'validation_failed')
      expect(cycle.error.reason).toBe('link_cycle')
  })

  test('untagged acyclic declarations do not form one global role union', () => {
    const { schema } = setup()
    const nodes = unwrap(
      schema.define(
        ['nodes'],
        s.map(
          s.struct({
            name: s.str().default(''),
            friend: s.link({ targetRoots: [['nodes']], acyclic: true }).optional(),
            manager: s.link({ targetRoots: [['nodes']], acyclic: true }).optional(),
          }),
        ),
      ),
    )
    const created = unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(nodes.at('a'), { name: 'A', friend: encodePathKey(['nodes', 'b']) })
        tx.set(nodes.at('b'), { name: 'B', manager: encodePathKey(['nodes', 'a']) })
        tx.set(nodes.at('c'), { name: 'C' })
      }),
    )
    expect(created.id.length).toBeGreaterThan(0)

    // `friend` and `manager` are distinct declarations: their union keys are
    // per declaration, so these two edges must not be read as one cycle.
    const sameDeclarationCycle = schema.commit({ head: 'main', message: 'cycle' }, (tx) => {
      tx.patch(nodes.at('b'), { friend: encodePathKey(['nodes', 'c']) })
      tx.patch(nodes.at('c'), { friend: encodePathKey(['nodes', 'a']) })
    })
    expect(sameDeclarationCycle.ok).toBe(false)
    if (!sameDeclarationCycle.ok && sameDeclarationCycle.error.kind === 'validation_failed')
      expect(sameDeclarationCycle.error.reason).toBe('link_cycle')
  })

  test('unlink removes optional links and filters link lists', () => {
    const { schema } = setup()
    const { characters, guilds } = standardRoots(schema)
    const g1 = encodePathKey(['guilds', 'g1'])
    const g2 = encodePathKey(['guilds', 'g2'])
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(guilds.at('g1'), { label: 'One' })
        tx.set(guilds.at('g2'), { label: 'Two' })
        tx.set(characters.at('alice'), { guild: g1, memberships: [g1, g2] })
        tx.set(characters.at('bob'), { memberships: [g1] })
      }),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'delete guild' }, (tx) => {
        tx.delete(guilds.at('g1'))
      }),
    )
    const alice = present(unwrap(schema.get(commit.id, characters.at('alice'))))
    expect(alice.guild.kind).toBe('none')
    expect([...alice.memberships]).toEqual([g2])
    const bob = present(unwrap(schema.get(commit.id, characters.at('bob'))))
    expect([...bob.memberships]).toEqual([])
  })

  test('enforces role-union acyclicity and exclusive roles', () => {
    const { schema } = setup()
    const { characters } = standardRoots(schema)
    const created = unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(characters.at('carol'), { name: 'Carol' })
        tx.set(characters.at('alice'), {
          name: 'Alice',
          parent: encodePathKey(['characters', 'carol']),
        })
        tx.set(characters.at('bob'), {
          name: 'Bob',
          parent: encodePathKey(['characters', 'alice']),
        })
      }),
    )
    const cycle = schema.commit({ head: 'main', message: 'cycle' }, (tx) => {
      tx.patch(characters.at('alice'), { parent: encodePathKey(['characters', 'bob']) })
    })
    expect(cycle.ok).toBe(false)
    if (!cycle.ok && cycle.error.kind === 'validation_failed')
      expect(cycle.error.reason).toBe('link_cycle')

    // `parent` and `mentor` share exclusiveRole 'parent': two non-empty links
    // on the same instance are rejected before the induced graph is inspected.
    const exclusive = schema.commit({ head: 'main', message: 'exclusive' }, (tx) => {
      tx.patch(characters.at('alice'), {
        mentor: encodePathKey(['characters', 'bob']),
      })
    })
    expect(exclusive.ok).toBe(false)
    if (!exclusive.ok && exclusive.error.kind === 'validation_failed')
      expect(exclusive.error.reason).toBe('exclusive_link_conflict')
    expect(unwrap(schema.get(created.id, characters.at('bob'))).kind).toBe('some')
  })

  test('rejects dangling and out-of-root link targets at commit', () => {
    const { schema } = setup()
    const { characters } = standardRoots(schema)
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(characters.at('alice'), { name: 'Alice' })
      }),
    )
    const missing = schema.commit({ head: 'main', message: 'missing' }, (tx) => {
      tx.set(characters.at('alice'), { home: encodePathKey(['places', 'ghost']) })
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok && missing.error.kind === 'validation_failed')
      expect(missing.error.reason).toBe('invalid_link_target')

    const wrongRoot = schema.commit({ head: 'main', message: 'wrong root' }, (tx) => {
      tx.set(characters.at('alice'), { home: encodePathKey(['characters', 'alice']) })
    })
    expect(wrongRoot.ok).toBe(false)
    if (!wrongRoot.ok && wrongRoot.error.kind === 'validation_failed')
      expect(wrongRoot.error.reason).toBe('invalid_link_target')
  })

  test('dynamicTargetRoots opts into roots registered by other plugins', () => {
    const { schema } = setup()
    const entity = unwrap(
      schema.define(['entities'], s.map(s.struct({ label: s.str().default('') }))),
    )
    const perspective = unwrap(
      schema.define(
        ['perspectives'],
        s.map(
          s.struct({
            label: s.str().default(''),
            host: s
              .link({
                targetRoots: [['perspectives']],
                dynamicTargetRoots: true,
                onDelete: 'cascade',
              })
              .optional(),
          }),
        ),
      ),
    )
    const host = encodePathKey(['entities', 'e1'])
    unwrap(
      schema.commit({ head: 'main', message: 'init' }, (tx) => {
        tx.set(entity.at('e1'), { label: 'Entity' })
        tx.set(perspective.at('p1'), { label: 'P1', host })
      }),
    )
    const commit = unwrap(
      schema.commit({ head: 'main', message: 'delete entity' }, (tx) => {
        tx.delete(entity.at('e1'))
      }),
    )
    expect(unwrap(schema.get(commit.id, perspective.at('p1'))).kind).toBe('none')
    const hostSpec = perspective.schema.valueSchema.fields.host
    expect(hostSpec?.nodeKind).toBe('leaf')
    if (hostSpec?.nodeKind === 'leaf') {
      const trait = linkTraitsOf(hostSpec)
      expect(trait?.dynamicTargetRoots).toBe(true)
      expect(trait?.targetRoots.map((path) => [...path])).toEqual([['perspectives']])
    }
  })

  test('resolveRef reads historical state nodes and message sub-paths', () => {
    const { schema } = setup()
    const { characters } = standardRoots(schema)
    const prism = unwrap(
      schema.defineMessage(
        'event',
        s.struct({
          note: s.str().default(''),
          detail: s.struct({ text: s.str().default('') }).optional(),
        }),
      ),
    )
    expect(prism.kind).toBe('event')
    const commit = unwrap(
      schema.commit(
        {
          head: 'main',
          message: { kind: 'event', data: { note: 'hello', detail: { text: 'deep' } } },
        },
        (tx) => {
          tx.set(characters.at('alice'), { name: 'Alice' })
        },
      ),
    )
    const nodeRef = unwrap(
      schema.resolveRef({ commitId: commit.id, path: ['characters', 'alice', 'name'] }),
    )
    expect(nodeRef.targetKind).toBe('state_node')
    if (nodeRef.targetKind === 'state_node') {
      const node = present(nodeRef.inspection)
      expect(node.nodeKind).toBe('leaf')
      if (node.nodeKind === 'leaf') expect(node.value).toBe('Alice')
    }
    const messageRef = unwrap(
      schema.resolveRef({ commitId: commit.id, path: ['$message', 'detail', 'text'] }),
    )
    expect(messageRef.targetKind).toBe('commit_message')
    if (messageRef.targetKind === 'commit_message') {
      expect(messageRef.messageKind).toBe('event')
      expect(present(messageRef.value)).toBe('deep')
    }
    const missing = unwrap(schema.resolveRef({ commitId: commit.id, path: ['$message', 'nope'] }))
    if (missing.targetKind === 'commit_message') expect(missing.value).toEqual(NONE)
    const absent = unwrap(
      schema.resolveRef({ commitId: commit.id, path: ['characters', 'missing'] }),
    )
    expect(absent.targetKind).toBe('state_node')
    if (absent.targetKind === 'state_node') expect(absent.inspection).toEqual(NONE)
  })
})
