import type { Option, Result } from '@sekaisen/core'
import { some } from '@sekaisen/core'
import { PerspectiveService } from '@sekaisen/plugin-perspective'
import type { HistoricalStructInspection, SchemaTransaction } from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'

/** Unwrap a real service result, retaining structured error details in failures. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

/** Require a present value when a scenario has already established its existence. */
export function present<T>(value: Option<T>): T {
  if (value.kind === 'none') throw new Error('Expected a present value')
  return value.value
}

/**
 * Read a stored claim member without giving the observer an omniscient API.
 * Only the test host uses this historical Writer inspection helper.
 */
export function claimMember(claim: HistoricalStructInspection, key: string): Value | StateRef {
  const node = present(claim.fields[key]!)
  if (node.nodeKind !== 'leaf') throw new Error(`Expected claim leaf ${key}`)
  return node.value
}

/**
 * Isolated real SQLite, World, Schema and Perspective services for a scenario.
 * Business objects always use registered schemas and normal transactions.
 * The owning test must close {@link driver} after the scenario finishes.
 */
export class PerspectiveFixture {
  /** Isolated persistence connection, owned by the test. */
  readonly driver: SqliteDriver = createBunSqliteDriver()
  /** Cordis context shared by the three real services. */
  readonly ctx = new Context()
  /** Authoritative content-addressed world and history. */
  readonly world = new WorldService(this.ctx, { driver: this.driver })
  /** Typed transaction and historical-inspection service. */
  readonly schema = new SchemaService(this.ctx)
  /** Physical business instances with independent visibility and sensory fields. */
  readonly entities = unwrap(
    this.schema.define(
      ['entities'],
      s.map(
        s.struct({
          name: s.str().optional(),
          text: s.str().optional(),
          passiveText: s.str().optional().meta({ salience: 'passive' }),
          voice: s.str().optional().meta({ sense: 'sound' }),
          ephemeralText: s.str().optional().meta({ ephemeral: true }),
          privateText: s.str().optional().meta({ visibility: 'self' }),
          hiddenText: s.str().optional().meta({ visibility: 'ref' }),
          condition: s.str().optional().meta({ sharedAcrossDelegates: true, visibility: 'self' }),
          parent: s
            .link({
              targetRoots: [['entities']],
              acyclic: true,
              exclusiveRole: 'parent',
              onDelete: 'unlink',
            })
            .optional()
            .meta({ linkRoles: ['parent'], visibility: 'ref' }),
          owner: s
            .link({ targetRoots: [['entities']], onDelete: 'unlink' })
            .optional()
            .meta({ linkRoles: ['owner'], visibility: 'ref' }),
          delegate: s
            .link({
              targetRoots: [['entities']],
              acyclic: true,
              exclusiveRole: 'delegate',
              onDelete: 'unlink',
            })
            .optional()
            .meta({ linkRoles: ['delegate'], visibility: 'ref' }),
          subsumes: s
            .linkList({ targetRoots: [['entities']], acyclic: true, onDelete: 'unlink' })
            .default([])
            .meta({ linkRoles: ['subsumes'], visibility: 'ref' }),
        }),
      ),
    ),
  )
  /** Directed sensory connections live separately from ordinary objects. */
  readonly edges = unwrap(
    this.schema.define(
      ['edges'],
      s.map(
        s.struct({
          name: s.str().optional(),
          from: s
            .link({ targetRoots: [['entities']], onDelete: 'cascade' })
            .meta({ linkRoles: ['edge_from'] }),
          to: s
            .link({ targetRoots: [['entities']], onDelete: 'cascade' })
            .meta({ linkRoles: ['edge_to', 'sense_pass'] }),
          parent: s
            .link({
              targetRoots: [['entities']],
              acyclic: true,
              exclusiveRole: 'parent',
              onDelete: 'unlink',
            })
            .optional()
            .meta({ linkRoles: ['parent'], visibility: 'ref' }),
        }),
      ),
    ),
  )
  /** Observer-specific knowledge, perception and restricted read capabilities. */
  readonly perspective = new PerspectiveService(this.ctx)

  /** Obtain a typed business instance lens used by multiple scenario mutations. */
  at(id: string) {
    return this.entities.at(id)
  }

  /** Produce the canonical graph pointer for a business instance. */
  key(id: string) {
    return encodePathKey(this.at(id).path)
  }

  /** Publish one validated scenario transition and advance the isolated main head. */
  commit(message: string, mutate: (tx: SchemaTransaction) => void) {
    return unwrap(this.schema.commit({ head: 'main', message }, mutate))
  }

  /** Seed two disconnected rooms and explicitly register their observer minds. */
  seed(aliceParent = 'room', bobParent = 'remote') {
    return this.commit('seed perspective scene', (tx) => {
      tx.set(this.entities, {
        room: { name: 'Room' },
        remote: { name: 'Remote room' },
        alice: { name: 'Alice', parent: this.key(aliceParent), condition: 'well' },
        bob: { name: 'Bob', parent: this.key(bobParent), condition: 'well' },
        note: { name: 'Note', parent: this.key('room'), text: 'original text' },
      })
      unwrap(this.perspective.configurePerspective(tx, this.at('alice'), {}))
      unwrap(this.perspective.configurePerspective(tx, this.at('bob'), {}))
    })
  }

  /** Find the newest persisted personal observed claim for one exact logical target. */
  latestObserved(commitId: CommitHash, observer: string, target: Path) {
    const root = present(
      unwrap(
        this.schema.inspectInstance(commitId, [
          'perspectives',
          this.key(observer),
          'observedClaims',
        ]),
      ),
    )
    if (root.nodeKind !== 'map') throw new Error('Expected observed claim Map')
    const candidates = Object.values(root.entries).filter(
      (entry): entry is HistoricalStructInspection => {
        if (entry.nodeKind !== 'struct') return false
        const ref = claimMember(entry, 'targetRef') as StateRef
        return encodePathKey(ref.path) === encodePathKey(target)
      },
    )
    candidates.sort((a, b) => (claimMember(b, 'seq') as number) - (claimMember(a, 'seq') as number))
    if (!candidates[0]) throw new Error('Expected a personal observed claim for the target')
    return candidates[0]
  }
}

/** Build explicit parent options for independent, fixed-history branch scenarios. */
export function fromCommit(id: CommitHash, message: string) {
  return { parentId: some(id), message }
}
