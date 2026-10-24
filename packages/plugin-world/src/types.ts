import type { Brand, Option } from '@sekaisen/core'

/* -------------------------------------------------------------------------- */
/*                           Paths, values, references                       */
/* -------------------------------------------------------------------------- */

/** Content-addressed SHA-256 hexadecimal identifier for a {@link CommitNode}. */
export type CommitHash = Brand<string, 'CommitHash'>

/** A path coordinate: one directory/key name per segment. */
export type Path = readonly string[]

/** Closed scalar leaf value. */
export type ScalarValue = null | boolean | number | string | Uint8Array

/** Closed value allowed at a path-tree leaf. */
export type Value = ScalarValue | readonly ScalarValue[]

/**
 * Cross-commit coordinate reference pointing to a path subtree or leaf at a
 * specific {@link CommitHash}.
 */
export interface StateRef {
  /**
   * Target commit. Inside `CommitInput.diff` only, {@link SELF_COMMIT} may be
   * used to address the commit being created; it is hashed canonically and
   * materialized to the real id before storage or reads.
   */
  readonly commitId: CommitHash
  /** Empty path means the whole state tree at `commitId`. */
  readonly path: Path
}

/** Discriminated union representing either a value leaf or a reference leaf. */
export type LeafEntry =
  | { readonly entryKind: 'val'; readonly value: Value }
  | { readonly entryKind: 'ref'; readonly ref: StateRef }

/* -------------------------------------------------------------------------- */
/*                              Canonical diffs                              */
/* -------------------------------------------------------------------------- */

/** Atomic path-tree mutation within a {@link StateDiff}. */
export type DiffOp =
  | { readonly op: 'set'; readonly path: Path; readonly value: Value }
  | { readonly op: 'ref'; readonly path: Path; readonly ref: StateRef }
  | { readonly op: 'del'; readonly path: Path }

/** Canonical, path-sorted sequence of {@link DiffOp} entries for a commit. */
export type StateDiff = readonly DiffOp[]

/** Immutable node in the world state commit forest. */
export interface CommitNode {
  readonly id: CommitHash
  readonly parentId: Option<CommitHash>
  readonly message: Value
  readonly diff: StateDiff
}
/** Optional CAS expectation for `commit({ ... advanceHead })`. */
export interface AdvanceHeadInput {
  /** Named cursor; aliases pointing at one commit remain independent Heads. */
  readonly name: string
  /**
   * When supplied (including `NONE`), the current head value must match
   * exactly. When omitted, an existing head must already point at
   * `parentId`; a missing head may be created.
   */
  readonly expected?: Option<CommitHash>
}

export interface CommitInput {
  /** Parent node; `NONE` creates a new root. */
  readonly parentId: Option<CommitHash>
  readonly message: Value
  /**
   * Canonical diff. `op === 'ref'` may use {@link SELF_COMMIT} to point at the
   * commit being created; such targets skip historical existence checks but
   * must exist in this commit's final state tree, be `[]`, or start with
   * `'$message'`. They are materialized to the new id before persistence.
   */
  readonly diff?: StateDiff
  /**
   * Optionally validate and advance a named cursor atomically with the commit.
   * Its leaf residency is prepared inside the transaction and published before events.
   */
  readonly advanceHead?: string | AdvanceHeadInput
}

/* -------------------------------------------------------------------------- */
/*                            Origin index tree                              */
/* -------------------------------------------------------------------------- */

export interface OriginDirectoryNode {
  readonly kind: 'dir'
  /** Commit that last changed this directory's structure or leaves. */
  readonly lastModifiedAt: CommitHash
  readonly children: ReadonlyMap<string, OriginTreeNode>
}

export interface OriginLeafNode {
  readonly kind: 'leaf'
  /** Commit whose diff wrote the leaf's current value. */
  readonly originCommitId: CommitHash
}

export type OriginTreeNode = OriginDirectoryNode | OriginLeafNode

/* -------------------------------------------------------------------------- */
/*                            Views and conflicts                            */
/* -------------------------------------------------------------------------- */

/** A path-tree node view: a leaf entry or a directory of child views. */
export type TreeNodeView =
  | { readonly nodeKind: 'leaf'; readonly entry: LeafEntry }
  | { readonly nodeKind: 'dir'; readonly entries: ReadonlyMap<string, TreeNodeView> }

/**
 * Detached node metadata from the in-memory origin index. Contains no leaf
 * payloads or child maps and does not require loading values from storage.
 * Leaf metadata intentionally does not distinguish value and reference entries.
 */
export type TreeNodeInfo =
  | {
      readonly nodeKind: 'leaf'
      /** Commit whose diff last wrote this leaf, including equal-value rewrites. */
      readonly originCommitId: CommitHash
    }
  | {
      readonly nodeKind: 'dir'
      /**
       * Revision of this directory's structure or descendant leaves. Unchanged
       * subtrees retain their revision across later commits. This is not a
       * content hash: rewriting an equal value can produce a new revision.
       */
      readonly lastModifiedAt: CommitHash
    }

/** Conflict descriptor reported when a rebase precheck detects divergence. */
export interface PathConflictDetail {
  readonly path: Path
  readonly reason:
    | 'value_diverged'
    | 'structure_conflict'
    | 'target_deleted_subtree'
    | 'source_deleted_modified_subtree'
  readonly baseNode: Option<TreeNodeView>
  readonly targetNode: Option<TreeNodeView>
  readonly incomingNode: Option<TreeNodeView>
}

/* -------------------------------------------------------------------------- */
/*                                  Rebase                                   */
/* -------------------------------------------------------------------------- */

/** Strategy controlling how {@link StateRef} commit IDs are rewritten during rebase. */
export type RemapRefsPolicy =
  | 'none'
  | 'in_chain'
  | ((ref: StateRef, remappedIds: ReadonlyMap<CommitHash, CommitHash>) => CommitHash)

/** Options for {@link WorldService.rebase}. */
export interface RebaseOptions {
  /** Previously accumulated oldCommitId -> newCommitId remaps for resuming. */
  readonly initialRemap?: ReadonlyMap<CommitHash, CommitHash>
  /** Ref remapping policy for both incoming diffs and the effective base. */
  readonly remapRefs?: RemapRefsPolicy
}

/** Outcome of a {@link WorldService.rebase} invocation. */
export type RebaseOutcome =
  | {
      readonly status: 'completed'
      readonly newTipId: CommitHash
      readonly remappedIds: ReadonlyMap<CommitHash, CommitHash>
    }
  | {
      readonly status: 'conflict'
      readonly currentTipId: CommitHash
      readonly conflictedSourceId: CommitHash
      readonly remainingSourceIds: readonly CommitHash[]
      readonly remappedIds: ReadonlyMap<CommitHash, CommitHash>
      readonly conflicts: readonly PathConflictDetail[]
    }

/* -------------------------------------------------------------------------- */
/*                                   Errors                                  */
/* -------------------------------------------------------------------------- */

/** Controlled operational errors returned by {@link WorldService}. */
export type WorldError =
  | { readonly kind: 'commit_not_found'; readonly commitId: CommitHash }
  | { readonly kind: 'head_not_found'; readonly headName: string }
  | { readonly kind: 'invalid_head_name'; readonly headName: string; readonly reason: string }
  | {
      readonly kind: 'head_cas_mismatch'
      readonly headName: string
      readonly expected: Option<CommitHash>
      readonly actual: Option<CommitHash>
    }
  | { readonly kind: 'invalid_path'; readonly path: Path; readonly reason: string }
  | { readonly kind: 'invalid_value'; readonly path: Path; readonly reason: string }
  | {
      readonly kind: 'invalid_diff'
      readonly path: Path
      readonly reason:
        | 'duplicate_path'
        | 'overlapping_del_prefix'
        | 'overlapping_write_prefix'
        | 'delete_non_existent_path'
        | 'empty_path'
    }
  | {
      readonly kind: 'structure_conflict'
      readonly path: Path
      readonly reason: string
    }
  | {
      readonly kind: 'dangling_ref'
      readonly refCommitId: CommitHash
      readonly refPath: Path
    }
  | {
      readonly kind: 'leaf_not_deletable'
      readonly commitId: CommitHash
      readonly reason: 'has_children' | 'pinned_by_refs' | 'pointed_by_head'
      readonly referencedByCommits: readonly CommitHash[]
      readonly pointedByHeads: readonly string[]
    }
  | {
      readonly kind: 'storage_error'
      readonly reason: string
      readonly cause?: unknown
      /** Successful prefix retained when a rebase fails during storage I/O. */
      readonly partialRebase?: {
        readonly currentTipId: CommitHash
        readonly completedRemap: ReadonlyMap<CommitHash, CommitHash>
      }
    }

/* -------------------------------------------------------------------------- */
/*                            SQLite driver contract                         */
/* -------------------------------------------------------------------------- */

/** Prepared SQLite statement supporting strict positional parameter binding. */
export interface SqliteStatement {
  run(...params: readonly unknown[]): void
  get<TRow = Record<string, unknown>>(...params: readonly unknown[]): Option<TRow>
  all<TRow = Record<string, unknown>>(...params: readonly unknown[]): readonly TRow[]
}

/** Synchronous host SQLite driver abstraction injected into {@link WorldService}. */
export interface SqliteDriver {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  /** Immediately executes BEGIN IMMEDIATE ... COMMIT/ROLLBACK; no async or nesting. */
  transaction<T>(fn: () => T): T
  close(): void
}
/** Options for the host-specific `createNodeSqliteDriver` / `createBunSqliteDriver` factories. */
export interface SqliteDriverOptions {
  /** Database file path; `':memory:'` or omitted selects an in-memory database. */
  readonly dbPath?: string
  /** Disk durability (default `'full'`: WAL + synchronous=FULL). */
  readonly durability?: 'full' | 'normal'
}

/** Configuration for registering {@link WorldService} in Cordis. */
export interface WorldConfig {
  /** Explicitly injected host SQLite driver. */
  readonly driver: SqliteDriver
  /** Close the injected driver on plugin dispose. Defaults to `false`. */
  readonly closeOnDispose?: boolean
}
