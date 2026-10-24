import type { Option, Result } from '@sekaisen/core'
import { err, InvariantError, NONE, ok, some } from '@sekaisen/core'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import {
  cloneDiff,
  cloneValue,
  hashCommit,
  materializeSelfRefs,
  SELF_COMMIT,
  validatePath,
} from './codec.ts'
import { applyIndex, emptyIndex, fail, locate, PatchError } from './origin.ts'
import { WorldTreeReader } from './reader.ts'
import { rebaseOnto } from './rebase.ts'
import { WorldStorage } from './storage.ts'
import type {
  CommitHash,
  CommitInput,
  CommitNode,
  Path,
  RebaseOptions,
  RebaseOutcome,
  StateRef,
  TreeNodeInfo,
  TreeNodeView,
  Value,
  WorldConfig,
  WorldError,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    world: WorldService
  }
  interface Events {
    'world/committed'(node: CommitNode): void
    'world/head-updated'(headName: string, commitId: Option<CommitHash>): void
  }
}

/**
 * Cordis service implementing the content-addressed world state commit forest.
 *
 * Mounted on `ctx.world`; manages multi-root commit topology, named `heads`
 * with CAS protection, transparent SQLite hydration, leaf deletion, and
 * atomic prefix-root group rebasing.
 *
 * Active Head leaves are strongly resident with per-Head ownership counts.
 * Moves compare persistent origin indexes and skip reference-shared subtrees;
 * SQL hydration is prepared inside the transaction and residency is published
 * before events only after persistence succeeds. Adding aliases or moving
 * between unshared trees can still require a subtree walk.
 */
export class WorldService extends Service<WorldConfig> {
  private readonly storage: WorldStorage
  private readonly reader: WorldTreeReader
  private inWriteOperation: boolean
  readonly config: WorldConfig

  constructor(ctx: Context, config: WorldConfig) {
    const storage = new WorldStorage(config.driver)
    super(ctx, 'world')
    this.config = config
    this.storage = storage
    this.reader = new WorldTreeReader(storage)
    this.inWriteOperation = false
    this.ctx.effect(() => () => {
      if (config.closeOnDispose === true) config.driver.close()
    })
  }

  private attempt<T>(fn: () => T): Result<T, WorldError> {
    try {
      return ok(fn())
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause
      if (cause instanceof PatchError) return err(cause.worldError)
      if (cause && typeof cause === 'object' && 'worldError' in cause)
        return err(cause.worldError as WorldError)
      return err({
        kind: 'storage_error',
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
    }
  }

  private write<T>(fn: () => T): Result<T, WorldError> {
    if (this.inWriteOperation) throw new InvariantError('Reentrant world write operation')
    this.inWriteOperation = true
    try {
      return this.attempt(fn)
    } finally {
      this.inWriteOperation = false
    }
  }

  private checkPath(path: Path): void {
    try {
      validatePath(path)
    } catch (cause) {
      fail({ kind: 'invalid_path', path, reason: String(cause) })
    }
  }

  private checkName(name: string): void {
    if (typeof name !== 'string' || !name.length || !name.isWellFormed())
      fail({
        kind: 'invalid_head_name',
        headName: name,
        reason: 'Head name must be a nonempty well-formed string',
      })
  }

  private checkCas(name: string, expected: Option<CommitHash> | undefined): void {
    if (expected !== undefined) {
      const actual = this.getHead(name)
      const matches =
        actual.kind === 'none'
          ? expected.kind === 'none'
          : expected.kind === 'some' && actual.value === expected.value
      if (!matches) fail({ kind: 'head_cas_mismatch', headName: name, expected, actual })
    }
  }

  private emitCommitted(node: CommitNode): void {
    // Cordis emit stops on the first exception. Dispatch individual callbacks so
    // one faulty listener cannot hide a committed update from subsequent ones.
    for (const callback of this.ctx.events.dispatch('emit', ['world/committed', node])) {
      try {
        callback(
          Object.freeze({ ...node, message: cloneValue(node.message), diff: cloneDiff(node.diff) }),
        )
      } catch (cause) {
        this.ctx.logger.warn('world/committed listener failed', cause)
      }
    }
  }

  private emitHead(name: string, id: Option<CommitHash>): void {
    for (const callback of this.ctx.events.dispatch('emit', ['world/head-updated', name, id])) {
      try {
        callback(name, id)
      } catch (cause) {
        this.ctx.logger.warn('world/head-updated listener failed', cause)
      }
    }
  }

  /** Return all root commit hashes (`parentId === NONE`) in the forest. */
  listRoots(): readonly CommitHash[] {
    return Object.freeze(
      [...this.storage.commits.values()]
        .filter((row) => row.parentId.kind === 'none')
        .map((row) => row.id),
    )
  }

  /** Return all leaf commit hashes (commits with no children) in the forest. */
  listLeaves(): readonly CommitHash[] {
    return Object.freeze(
      [...this.storage.commits.values()].filter((row) => !row.children.size).map((row) => row.id),
    )
  }

  /** Return the parent commit hash of `id` (`NONE` when `id` is a root). */
  getParent(id: CommitHash): Result<Option<CommitHash>, WorldError> {
    return this.attempt(() => this.reader.requireCommit(id).parentId)
  }

  /** Return all direct child commit hashes of `id`. */
  getChildren(id: CommitHash): Result<readonly CommitHash[], WorldError> {
    return this.attempt(() => Object.freeze([...this.reader.requireCommit(id).children]))
  }

  /**
   * Return all live commit hashes that reference `id` via `StateRef`.
   *
   * Self anchors (`ref.commitId === commit.id`) are not pin edges, so a commit
   * never appears in its own referencing list.
   */
  getReferencingCommits(id: CommitHash): Result<readonly CommitHash[], WorldError> {
    return this.attempt(() => {
      this.reader.requireCommit(id)
      return Object.freeze([...(this.storage.pins.get(id) ?? [])])
    })
  }

  /** Return `true` if `id` exists in the commit forest. */
  hasCommit(id: CommitHash): boolean {
    return this.storage.commits.has(id)
  }

  /** Return a frozen snapshot of all named head cursors (`name -> CommitHash`). */
  listHeads(): Readonly<Record<string, CommitHash>> {
    return Object.freeze(Object.fromEntries(this.storage.heads))
  }

  /** Return the commit hash pointed to by head `name`, or `NONE` if absent. */
  getHead(name: string): Option<CommitHash> {
    const id = this.storage.heads.get(name)
    return id === undefined ? NONE : some(id)
  }

  /**
   * Create or move named cursor `name` to `id`, optionally checking `expected`
   * via CAS. Each name owns its reachable leaves independently of aliases.
   * Hydration and persistence must succeed before the cursor and residency
   * changes are published; `world/head-updated` observes the final state.
   */
  setHead(name: string, id: CommitHash, expected?: Option<CommitHash>): Result<void, WorldError> {
    return this.write(() => {
      this.checkName(name)
      const target = this.reader.requireCommit(id)
      this.checkCas(name, expected)
      const previous = this.storage.heads.get(name)
      if (previous === id) return
      const oldIndex =
        previous === undefined ? undefined : this.reader.requireCommit(previous).index
      const hot = this.storage.driver.transaction(() => {
        this.storage.writeHead(name, id)
        return this.storage.prepareHot(oldIndex, target.index)
      })
      this.storage.heads.set(name, id)
      if (hot) this.storage.installHot(hot)
      this.emitHead(name, some(id))
    })
  }

  /**
   * Delete named cursor `name`, optionally checking `expected` via CAS.
   * Leaves held by other Heads remain strongly resident. Removing the final
   * Head releases residency without rescanning its departing state tree.
   * Persistence failure leaves both the cursor and live ownership counts intact.
   */
  deleteHead(name: string, expected?: Option<CommitHash>): Result<void, WorldError> {
    return this.write(() => {
      this.checkName(name)
      this.checkCas(name, expected)
      const previous = this.storage.heads.get(name)
      if (previous === undefined) fail({ kind: 'head_not_found', headName: name })
      const oldIndex = this.reader.requireCommit(previous).index
      const hot = this.storage.driver.transaction(() => {
        this.storage.driver
          .prepare('DELETE FROM heads WHERE name = CAST(? AS TEXT)')
          .run(new TextEncoder().encode(name))
        return this.storage.prepareHot(oldIndex, undefined)
      })
      this.storage.heads.delete(name)
      if (hot) this.storage.installHot(hot)
      this.emitHead(name, NONE)
    })
  }

  /**
   * Read frozen, detached node metadata from the origin index without SQLite
   * access, leaf-value copying or descendant traversal. The path defaults to
   * the root; an absent path returns `ok(NONE)`, while an empty root is a directory.
   * Leaf info exposes its origin commit, not its value/reference kind or payload.
   *
   * Directory `lastModifiedAt` is a subtree revision, not a content hash. It
   * remains stable when only unrelated subtrees change, but an equal-value
   * rewrite inside the directory can advance it.
   * @returns `commit_not_found` or `invalid_path` for invalid coordinates.
   * @see TreeNodeInfo
   */
  getNodeInfo(id: CommitHash, path: Path = []): Result<Option<TreeNodeInfo>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      return this.reader.nodeInfo(id, path)
    })
  }

  /**
   * Enumerate only a directory's direct child names in UTF-8 byte order.
   * Returns a frozen, detached array; it never exposes the internal child Map,
   * reads SQLite, copies leaf values or materializes descendant views.
   *
   * An absent path returns `ok(NONE)`; an empty directory returns `ok(some([]))`.
   * An exact leaf path (including a reference) returns `structure_conflict`,
   * not an empty listing. The path defaults to the root.
   * @remarks For path depth d and k direct children, work is O(d + k log k)
   * excluding string-byte costs; allocating the returned names array costs O(k).
   * @returns `commit_not_found` or `invalid_path` for invalid coordinates.
   */
  listChildren(id: CommitHash, path: Path = []): Result<Option<readonly string[]>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      return this.reader.children(id, path)
    })
  }

  /**
   * Materialize the complete subtree at `path` (defaults to root `[]`) as a
   * detached leaf/directory view. This visits descendants, copies leaf values
   * and may hydrate them from SQLite. For index-only reads without descendant
   * materialization, use `getNodeInfo` or `listChildren` instead.
   */
  getNode(id: CommitHash, path: Path = []): Result<Option<TreeNodeView>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      return this.reader.view(id, path)
    })
  }

  /** Read the value leaf at `path` in commit `id` (`NONE` if absent, a directory, or a ref leaf). */
  getValue(id: CommitHash, path: Path): Result<Option<Value>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      return this.reader.value(id, path)
    })
  }

  /** Read the `StateRef` leaf at `path` in commit `id` (`NONE` if absent, a directory, or a value leaf). */
  getRef(id: CommitHash, path: Path): Result<Option<StateRef>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      return this.reader.ref(id, path)
    })
  }

  /** Read the `message` value attached to commit `id`. */
  getMessage(id: CommitHash): Result<Value, WorldError> {
    return this.attempt(() => this.reader.message(id))
  }

  /** Dereference `ref`, returning the `TreeNodeView` at `(ref.commitId, ref.path)`. */
  deref(ref: StateRef): Result<Option<TreeNodeView>, WorldError> {
    return this.attempt(() => this.reader.deref(ref))
  }

  /** Return `true` if the content at `(ref.commitId, ref.path)` differs from `(compareId, ref.path)`. */
  isRefChanged(ref: StateRef, compareId: CommitHash): Result<boolean, WorldError> {
    return this.attempt(() => {
      this.checkPath(ref.path)
      return this.reader.isRefChanged(ref, compareId)
    })
  }

  /**
   * Atomically validate, persist and index a commit, optionally advancing a Head.
   * Head residency updates use only the affected origin branches and are
   * published with topology before events. Replaying an existing canonical
   * commit reuses its stored index; it never creates a duplicate commit event.
   *
   * `diff` entries may use {@link SELF_COMMIT} to reference this very commit.
   * They skip historical existence checks, are hashed as the literal `$self`
   * and are materialized to the new id in storage and every returned view.
   * A self target must exist in the final post-diff tree, be the empty path
   * (whole tree), or start with the reserved `'$message'` prefix; otherwise
   * the commit fails with `dangling_ref`.
   */
  commit(input: CommitInput): Result<CommitNode, WorldError> {
    return this.write(() => this.commitInternal(input))
  }
  private commitInternal(input: CommitInput): CommitNode {
    if (input.parentId.kind === 'some') this.reader.requireCommit(input.parentId.value)
    const advance =
      typeof input.advanceHead === 'string' ? { name: input.advanceHead } : input.advanceHead
    let previousHead: CommitHash | undefined
    if (advance) {
      this.checkName(advance.name)
      previousHead = this.storage.heads.get(advance.name)
      this.checkCas(
        advance.name,
        advance.expected ?? (previousHead === undefined ? undefined : input.parentId),
      )
    }
    let message: Value
    try {
      message = cloneValue(input.message)
    } catch (cause) {
      fail({ kind: 'invalid_value', path: [], reason: String(cause) })
    }
    const canonicalDiff = cloneDiff(input.diff ?? [])
    for (const op of canonicalDiff) {
      if (op.op === 'ref' && op.ref.commitId !== SELF_COMMIT && !this.hasCommit(op.ref.commitId))
        fail({ kind: 'dangling_ref', refCommitId: op.ref.commitId, refPath: op.ref.path })
    }
    const parentId = input.parentId.kind === 'some' ? some(input.parentId.value) : NONE
    const id = hashCommit(parentId, message, canonicalDiff)
    const diff = materializeSelfRefs(id, canonicalDiff)
    const existing = this.storage.commits.get(id)
    const isNew = existing === undefined
    // Preserve canonical object sharing when an existing hash is replayed.
    const index =
      existing?.index ??
      applyIndex(
        parentId.kind === 'some' ? this.reader.requireCommit(parentId.value).index : emptyIndex(id),
        diff,
        id,
      )
    for (const op of diff) {
      if (op.op !== 'ref' || op.ref.commitId !== id) continue
      const target = op.ref.path
      if (target.length === 0 || target[0] === '$message') continue
      if (!locate(index, target))
        fail({ kind: 'dangling_ref', refCommitId: SELF_COMMIT, refPath: target })
    }
    const node = Object.freeze({ id, parentId, message, diff })
    const headChanged = advance !== undefined && previousHead !== id
    const hot = this.storage.driver.transaction(() => {
      if (isNew) this.storage.insert(node)
      if (headChanged && advance) this.storage.writeHead(advance.name, id)
      return headChanged
        ? this.storage.prepareHot(
            previousHead === undefined ? undefined : this.reader.requireCommit(previousHead).index,
            index,
          )
        : undefined
    })
    if (isNew) {
      const references = new Set<CommitHash>()
      for (const op of diff) {
        if (op.op === 'ref' && op.ref.commitId !== id) references.add(op.ref.commitId)
      }
      this.storage.add({
        id,
        parentId,
        index,
        children: new Set(),
        references,
      })
    }
    if (headChanged && advance) this.storage.heads.set(advance.name, id)
    if (hot) this.storage.installHot(hot)
    if (isNew) this.emitCommitted(node)
    if (headChanged && advance) this.emitHead(advance.name, some(id))
    return Object.freeze({ ...node, message: cloneValue(message), diff: cloneDiff(diff) })
  }

  /**
   * Safely delete a leaf commit if it has no children, no incoming `StateRef`
   * pins, and no `head` pointers. A commit that only anchors itself is still
   * deletable because self references never create pin edges.
   */
  popLeaf(id: CommitHash): Result<void, WorldError> {
    return this.write(() => {
      const record = this.reader.requireCommit(id)
      const referencedByCommits = Object.freeze([...(this.storage.pins.get(id) ?? [])])
      const pointedByHeads = Object.freeze(
        [...this.storage.heads].filter(([, target]) => target === id).map(([name]) => name),
      )
      const reason = record.children.size
        ? 'has_children'
        : pointedByHeads.length
          ? 'pointed_by_head'
          : referencedByCommits.length
            ? 'pinned_by_refs'
            : undefined
      if (reason)
        fail({
          kind: 'leaf_not_deletable',
          commitId: id,
          reason,
          referencedByCommits,
          pointedByHeads,
        })
      this.storage.driver.transaction(() => {
        this.storage.driver.prepare('DELETE FROM commit_refs WHERE source_commit_id = ?').run(id)
        this.storage.driver.prepare('DELETE FROM diff_entries WHERE commit_id = ?').run(id)
        this.storage.driver.prepare('DELETE FROM commits WHERE id = ?').run(id)
      })
      this.storage.remove(id)
    })
  }

  /**
   * Replay contiguous `sourceChainIds` onto `ontoId` using atomic prefix-root group
   * three-way prechecks, stopping on the first conflict without writing partial state.
   *
   * Self references are aligned across both sides of the replay:
   * - a source ref whose target is the source node itself is dehydrated to
   *   {@link SELF_COMMIT}, skipping the policy and the historical existence
   *   check until the new node materializes it;
   * - a base-view ref written by a source node that is already in the remap
   *   table is force-synced to that node's replacement regardless of
   *   `remapRefs`, so previously replayed self anchors do not look like
   *   external divergence;
   * - a desired self reference never equals a target reference to an existing
   *   commit, so the same-change pruning cannot drop it.
   *
   * `options.initialRemap` seeds the remap table for resuming across batches.
   */
  rebase(
    sourceChainIds: readonly CommitHash[],
    ontoId: CommitHash,
    options: RebaseOptions = {},
  ): Result<RebaseOutcome, WorldError> {
    return this.write(() =>
      rebaseOnto(
        {
          requireCommit: (id) => this.reader.requireCommit(id),
          hasCommit: (id) => this.storage.commits.has(id),
          view: (id, path, transformRef) => this.reader.view(id, path, transformRef),
          message: (id) => this.storage.message(id),
          diff: (id) => this.storage.diff(id),
          commit: (input) => this.attempt(() => this.commitInternal(input())),
        },
        sourceChainIds,
        ontoId,
        options,
      ),
    )
  }
}
