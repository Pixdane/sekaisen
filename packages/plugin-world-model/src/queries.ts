/**
 * Watch-path queries for agenda and beat preconditions.
 */

import type { Result } from '@sekaisen/core'
import type { PerspectiveError } from '@sekaisen/plugin-perspective'
import type { SchemaServiceApi } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef, WorldService } from '@sekaisen/plugin-world'
import { decodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import { attemptWorldModel, domainFailure, expectSchema, fail } from './internal.ts'
import type { WorldModelLenses } from './lenses.ts'
import { entityCoordinates } from './paths.ts'

interface WatchDeps {
  readonly schema: Pick<SchemaServiceApi, 'viewAt'>
  readonly world: Pick<WorldService, 'isRefChanged'>
  readonly lenses: WorldModelLenses
}

function decodeWatchPath(key: string): Path | undefined {
  try {
    const path = decodePathKey(key)
    return path.length === 0 ? undefined : path
  } catch {
    return undefined
  }
}

/**
 * Return the decoded watch paths whose content differs from the watcher's
 * recorded baseline commit. Only `agenda` and `beat` instances carry
 * watch paths; malformed keys or unknown watchers are domain failures.
 */
export function checkWatchedPathsChanged(
  deps: WatchDeps,
  commitId: CommitHash,
  watcherPath: Path,
): Result<readonly Path[], PerspectiveError> {
  return attemptWorldModel(() => {
    const coordinates = entityCoordinates(watcherPath)
    if (coordinates === undefined || (coordinates.kind !== 'agenda' && coordinates.kind !== 'beat'))
      fail(domainFailure(watcherPath, 'watch_owner_must_be_agenda_or_beat'))
    const view = expectSchema(deps.schema.viewAt(commitId))
    const lens =
      coordinates.kind === 'agenda'
        ? deps.lenses.agendas.at(coordinates.id)
        : deps.lenses.beats.at(coordinates.id)
    const record = expectSchema(view.get(lens))
    if (record.kind === 'none') fail(domainFailure(watcherPath, 'watcher_not_found'))
    const baseline: StateRef = record.value.baselineRef
    const baselineCommit = baseline.commitId === SELF_COMMIT ? commitId : baseline.commitId
    const changed: Path[] = []
    for (const key of record.value.watchPaths) {
      const path = decodeWatchPath(key)
      if (path === undefined) fail(domainFailure(watcherPath, 'invalid_watch_path_key'))
      const isChanged = deps.world.isRefChanged({ commitId: baselineCommit, path }, commitId)
      if (!isChanged.ok) fail(domainFailure(watcherPath, `world_error:${isChanged.error.kind}`))
      if (isChanged.value) changed.push(path)
    }
    return Object.freeze(changed)
  })
}
