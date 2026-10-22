import type { Result } from '@sekaisen/core'
import type { CommitHash, LeafEntry, Path, WorldError, WorldService } from '@sekaisen/plugin-world'
import { SchemaFailure } from './builders.ts'
import type { StateReader } from './runtime.ts'

const EMPTY_KEYS: readonly string[] = Object.freeze([])

/** Preserve the schema service's structured boundary for expected World failures. */
export function worldResult<T>(result: Result<T, WorldError>): T {
  if (!result.ok) throw new SchemaFailure({ kind: 'world_error', error: result.error })
  return result.value
}

/**
 * Read a fixed World commit without capturing its complete state tree.
 * Payloads are fetched only for requested physical leaves. Presence and direct
 * child lookup use the in-memory origin index, never materializing descendants.
 * No values or catalogs are cached; World retains ownership of commit lifetime.
 */
export class WorldStateReader implements StateReader {
  private readonly world: WorldService
  private readonly commitId: CommitHash

  constructor(world: WorldService, commitId: CommitHash) {
    this.world = world
    this.commitId = commitId
  }

  getEntry(path: Path): LeafEntry | undefined {
    const value = worldResult(this.world.getValue(this.commitId, path))
    if (value.kind === 'some') return Object.freeze({ entryKind: 'val', value: value.value })
    const ref = worldResult(this.world.getRef(this.commitId, path))
    return ref.kind === 'some' ? Object.freeze({ entryKind: 'ref', ref: ref.value }) : undefined
  }

  hasEntry(path: Path): boolean {
    const info = worldResult(this.world.getNodeInfo(this.commitId, path))
    return info.kind === 'some' && info.value.nodeKind === 'leaf'
  }

  childKeys(path: Path): readonly string[] {
    const info = worldResult(this.world.getNodeInfo(this.commitId, path))
    // Flat Snapshot readers have no descendants under a leaf. Preserve that
    // behavior instead of changing malformed-directory handling into a World error.
    if (info.kind === 'none' || info.value.nodeKind === 'leaf') return EMPTY_KEYS
    const keys = worldResult(this.world.listChildren(this.commitId, path))
    return keys.kind === 'some' ? keys.value : EMPTY_KEYS
  }
}
