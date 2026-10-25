import type { Option, Result } from '@sekaisen/core'
import { PerspectiveService } from '@sekaisen/plugin-perspective'
import type { SchemaCommitOptions, SchemaTransaction } from '@sekaisen/plugin-schema'
import { SchemaService } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, SqliteDriver } from '@sekaisen/plugin-world'
import { encodePathKey, WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { WorldModelService } from '@sekaisen/plugin-world-model'
import { Context } from 'cordis'

/** Unwrap a real service result, retaining structured error details in failures. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

/** Require a present Option when a scenario has already established existence. */
export function present<T>(value: Option<T>): T {
  if (value.kind === 'none') throw new Error('Expected a present value')
  return value.value
}

/** Canonical encoded entity instance key. */
export function entityKey(kind: string, id: string): string {
  return encodePathKey(['entities', kind, id])
}

/**
 * Isolated real SQLite, World, Schema, Perspective and WorldModel services.
 * The owning test must close {@link driver} after the scenario.
 */
export class WorldModelFixture {
  readonly driver: SqliteDriver = createBunSqliteDriver()
  readonly ctx = new Context()
  readonly world = new WorldService(this.ctx, { driver: this.driver })
  readonly schema = new SchemaService(this.ctx)
  readonly perspective = new PerspectiveService(this.ctx)
  readonly worldModel = new WorldModelService(this.ctx)

  /** Publish one validated main-head transition. */
  commit(message: SchemaCommitOptions['message'], mutate: (tx: SchemaTransaction) => void) {
    return unwrap(this.schema.commit({ head: 'main', message }, mutate))
  }

  /** Current main-head commit id. */
  head(): CommitHash {
    return present(this.world.getHead('main'))
  }

  /** Canonical instance path for a registered entity kind. */
  path(kind: string, id: string): Path {
    return Object.freeze(['entities', kind, id])
  }
}

/** Seed a room, a hall and Alice standing in the room. */
export function seedBase(f: WorldModelFixture, clock = 0) {
  return f.commit('seed objective world', (tx) => {
    tx.patch(f.worldModel.lenses.world, { clock, timeAnchorLabel: 'clock zero' })
    tx.set(f.worldModel.lenses.locations, {
      room: { name: 'Room' },
      hall: { name: 'Hall' },
    })
    tx.set(f.worldModel.lenses.characters.at('alice'), {
      name: 'Alice',
      location: entityKey('location', 'room'),
    })
  })
}
