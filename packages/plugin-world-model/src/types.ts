/**
 * Public world-model service types and query results.
 */

import type { Option, Result } from '@sekaisen/core'
import type {
  CognitiveMemoryTreeNode,
  ObserverRef,
  PerspectiveError,
} from '@sekaisen/plugin-perspective'
import type { ReadonlySchemaView, SchemaTransaction } from '@sekaisen/plugin-schema'
import type { CommitHash, Path } from '@sekaisen/plugin-world'
import type { WorldModelLenses } from './lenses.ts'
import type { WorldModelMessages } from './messages.ts'

/** One node of the objective entity containment/ownership tree. */
export interface ObjectiveEntityTreeNode {
  /** Canonical instance path, always below `['entities']`. */
  readonly path: Path
  /** Registered entity collection kind (for example `'character'`). */
  readonly kind: string
  /** Concrete Map member id. */
  readonly id: string
  /** Declared fields read through the final-draft Writer schema. */
  readonly fields: Readonly<Record<string, unknown>>
  /** Direct children attached through `'parent'` links below `['entities']`. */
  readonly containedChildren: readonly ObjectiveEntityTreeNode[]
  /** Direct dependants attached through `'owner'` links below `['entities']`. */
  readonly ownedChildren: readonly ObjectiveEntityTreeNode[]
}

/** Knowledge to grant when assigning an item or ability. */
export interface GrantAssetKnowledgeOptions {
  /** Grant `effect` knowledge (default `true`). */
  readonly knowEffect?: boolean
  /** Grant `limits` knowledge (default `true`). */
  readonly knowLimits?: boolean
  /** Grant `ability.flaw` knowledge (default `false`). */
  readonly knowFlaw?: boolean
}

/**
 * Public service contract registered as `ctx.worldModel`.
 *
 * All mutation methods require a `SchemaTransaction`; multi-write helpers use
 * one draft savepoint so a later domain failure restores every write made by
 * that helper while preserving earlier caller writes.
 */
export interface WorldModelServiceApi {
  readonly lenses: WorldModelLenses
  readonly messages: WorldModelMessages

  /** Assign an item holder and optionally replace owners, granting knowledge. */
  assignItem(
    tx: SchemaTransaction,
    itemId: string,
    holderPath: Option<Path>,
    ownerPaths?: readonly Path[],
    knowledgeOptions?: GrantAssetKnowledgeOptions,
  ): Result<void, PerspectiveError>

  /** Attach an ability owner, granting selected ability knowledge. */
  grantAbility(
    tx: SchemaTransaction,
    abilityId: string,
    ownerPath: Path,
    knowledgeOptions?: GrantAssetKnowledgeOptions,
  ): Result<void, PerspectiveError>

  /** Pause a running fuse and freeze its remaining minutes. */
  pauseFuse(tx: SchemaTransaction, fuseId: string): Result<void, PerspectiveError>

  /** Resume a paused fuse from the current world clock. */
  resumeFuse(tx: SchemaTransaction, fuseId: string): Result<void, PerspectiveError>

  /** Consume a due fuse (delete one-shot, advance recurring). */
  consumeTriggeredFuse(tx: SchemaTransaction, fuseId: string): Result<void, PerspectiveError>

  /** Return watch paths whose content changed since the item's baseline. */
  checkWatchedPathsChanged(
    commitId: CommitHash,
    watcherPath: Path,
  ): Result<readonly Path[], PerspectiveError>

  /** Assemble the purely objective containment/ownership tree. */
  inspectEntityTree(
    commitIdOrView: CommitHash | ReadonlySchemaView,
    rootEntityPath: Path,
  ): Result<Option<ObjectiveEntityTreeNode>, PerspectiveError>

  /** Delegate to the public perspective memory-tree query. */
  inspectCognitiveMemoryTree(
    commitIdOrView: CommitHash | ReadonlySchemaView,
    observer: ObserverRef,
  ): Result<readonly CognitiveMemoryTreeNode[], PerspectiveError>
}
