import type { Option, Result } from '@sekaisen/core'
import { compareUtf8, err, InvariantError, NONE, ok, some } from '@sekaisen/core'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import {
  applyRemapPolicy,
  cloneDiff,
  cloneEntry,
  cloneRef,
  cloneValue,
  comparePaths,
  encodePathKey,
  hashCommit,
  leafEntryEquals,
  validatePath,
} from './codec.ts'
import { applyIndex, emptyIndex, isPrefix, locate, PatchError } from './origin.ts'
import { WorldStorage } from './storage.ts'
import type {
  CommitHash,
  CommitInput,
  CommitNode,
  DiffOp,
  LeafEntry,
  OriginTreeNode,
  Path,
  PathConflictDetail,
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

function fail(error: WorldError): never {
  throw new PatchError(error)
}

function sameOption(a: Option<CommitHash>, b: Option<CommitHash>): boolean {
  return a.kind === 'none' ? b.kind === 'none' : b.kind === 'some' && a.value === b.value
}

function viewsEqual(a: Option<TreeNodeView>, b: Option<TreeNodeView>): boolean {
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind
  const stack: [TreeNodeView, TreeNodeView][] = [[a.value, b.value]]
  while (stack.length > 0) {
    const [left, right] = stack.pop()!
    if (left.nodeKind !== right.nodeKind) return false
    if (left.nodeKind === 'leaf' && right.nodeKind === 'leaf') {
      if (!leafEntryEquals(left.entry, right.entry)) return false
      continue
    }
    if (
      left.nodeKind !== 'dir' ||
      right.nodeKind !== 'dir' ||
      left.entries.size !== right.entries.size
    )
      return false
    for (const [name, child] of left.entries) {
      const other = right.entries.get(name)
      if (!other) return false
      stack.push([child, other])
    }
  }
  return true
}

function transformView(
  view: Option<TreeNodeView>,
  transform: (ref: StateRef) => StateRef,
): Option<TreeNodeView> {
  if (view.kind === 'none') return NONE
  if (view.value.nodeKind === 'leaf') {
    return some(
      Object.freeze({
        nodeKind: 'leaf',
        entry:
          view.value.entry.entryKind === 'ref'
            ? Object.freeze({ entryKind: 'ref', ref: transform(view.value.entry.ref) })
            : cloneEntry(view.value.entry),
      }),
    )
  }
  const rootEntries = new Map<string, TreeNodeView>()
  const stack: {
    readonly source: ReadonlyMap<string, TreeNodeView>
    readonly target: Map<string, TreeNodeView>
  }[] = [{ source: view.value.entries, target: rootEntries }]
  const postOrder: {
    readonly entries: Map<string, TreeNodeView>
    readonly parent?: Map<string, TreeNodeView>
    readonly key?: string
  }[] = [{ entries: rootEntries }]

  while (stack.length > 0) {
    const current = stack.pop()!
    const items = [...current.source]
    for (const [key] of items) current.target.set(key, null as unknown as TreeNodeView)
    for (let i = items.length - 1; i >= 0; i--) {
      const [key, child] = items[i]!
      if (child.nodeKind === 'leaf') {
        current.target.set(
          key,
          Object.freeze({
            nodeKind: 'leaf',
            entry:
              child.entry.entryKind === 'ref'
                ? Object.freeze({ entryKind: 'ref', ref: transform(child.entry.ref) })
                : cloneEntry(child.entry),
          }),
        )
      } else {
        const childEntries = new Map<string, TreeNodeView>()
        postOrder.push({ entries: childEntries, parent: current.target, key })
        stack.push({ source: child.entries, target: childEntries })
      }
    }
  }
  for (let i = postOrder.length - 1; i >= 0; i--) {
    const item = postOrder[i]!
    const dir: TreeNodeView = Object.freeze({ nodeKind: 'dir', entries: item.entries })
    if (item.parent && item.key !== undefined) item.parent.set(item.key, dir)
    else return some(dir)
  }
  return NONE
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
  private inWriteOperation: boolean
  readonly config: WorldConfig

  constructor(ctx: Context, config: WorldConfig) {
    const storage = new WorldStorage(config.driver)
    super(ctx, 'world')
    this.config = config
    this.storage = storage
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

  private requireCommit(id: CommitHash) {
    const record = this.storage.commits.get(id)
    if (!record) fail({ kind: 'commit_not_found', commitId: id })
    return record
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
      if (!sameOption(actual, expected))
        fail({ kind: 'head_cas_mismatch', headName: name, expected, actual })
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
    return this.attempt(() => this.requireCommit(id).parentId)
  }

  /** Return all direct child commit hashes of `id`. */
  getChildren(id: CommitHash): Result<readonly CommitHash[], WorldError> {
    return this.attempt(() => Object.freeze([...this.requireCommit(id).children]))
  }

  /** Return all live commit hashes that reference `id` via `StateRef`. */
  getReferencingCommits(id: CommitHash): Result<readonly CommitHash[], WorldError> {
    return this.attempt(() => {
      this.requireCommit(id)
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
      const target = this.requireCommit(id)
      this.checkCas(name, expected)
      const previous = this.storage.heads.get(name)
      if (previous === id) return
      const oldIndex = previous === undefined ? undefined : this.requireCommit(previous).index
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
      const oldIndex = this.requireCommit(previous).index
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

  private view(id: CommitHash, path: Path): Option<TreeNodeView> {
    const index = locate(this.requireCommit(id).index, path)
    if (!index) return NONE
    const rootKey = encodePathKey(path)
    if (index.kind === 'leaf') {
      return some(
        Object.freeze({
          nodeKind: 'leaf',
          entry: cloneEntry(this.storage.entry(index.originCommitId, rootKey)),
        }),
      )
    }
    const rootEntries = new Map<string, TreeNodeView>()
    const stack: {
      readonly node: OriginTreeNode & { readonly kind: 'dir' }
      readonly atKey: string
      readonly entries: Map<string, TreeNodeView>
    }[] = [{ node: index, atKey: rootKey, entries: rootEntries }]
    const postOrder: {
      readonly entries: Map<string, TreeNodeView>
      readonly parent?: Map<string, TreeNodeView>
      readonly key?: string
    }[] = [{ entries: rootEntries }]

    while (stack.length > 0) {
      const current = stack.pop()!
      const sorted = [...current.node.children].sort(([a], [b]) => comparePaths([a], [b]))
      for (const [name] of sorted) current.entries.set(name, null as unknown as TreeNodeView)
      for (let i = sorted.length - 1; i >= 0; i--) {
        const [name, child] = sorted[i]!
        const childKey = `${current.atKey}${encodePathKey([name])}`
        if (child.kind === 'leaf') {
          current.entries.set(
            name,
            Object.freeze({
              nodeKind: 'leaf',
              entry: cloneEntry(this.storage.entry(child.originCommitId, childKey)),
            }),
          )
        } else {
          const childEntries = new Map<string, TreeNodeView>()
          postOrder.push({ entries: childEntries, parent: current.entries, key: name })
          stack.push({ node: child, atKey: childKey, entries: childEntries })
        }
      }
    }
    for (let i = postOrder.length - 1; i >= 0; i--) {
      const item = postOrder[i]!
      const dir: TreeNodeView = Object.freeze({ nodeKind: 'dir', entries: item.entries })
      if (item.parent && item.key !== undefined) item.parent.set(item.key, dir)
      else return some(dir)
    }
    return NONE
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
      const node = locate(this.requireCommit(id).index, path)
      if (!node) return NONE
      return some(
        Object.freeze(
          node.kind === 'leaf'
            ? { nodeKind: 'leaf' as const, originCommitId: node.originCommitId }
            : { nodeKind: 'dir' as const, lastModifiedAt: node.lastModifiedAt },
        ),
      )
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
      const node = locate(this.requireCommit(id).index, path)
      if (!node) return NONE
      if (node.kind !== 'dir')
        fail({ kind: 'structure_conflict', path, reason: 'Cannot list children of a leaf' })
      return some(Object.freeze([...node.children.keys()].sort(compareUtf8)))
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
      return this.view(id, path)
    })
  }

  /** Read the value leaf at `path` in commit `id` (`NONE` if absent, a directory, or a ref leaf). */
  getValue(id: CommitHash, path: Path): Result<Option<Value>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      const node = locate(this.requireCommit(id).index, path)
      if (node?.kind !== 'leaf') return NONE
      const entry = this.storage.entry(node.originCommitId, encodePathKey(path))
      return entry.entryKind === 'val' ? some(cloneValue(entry.value)) : NONE
    })
  }

  /** Read the `StateRef` leaf at `path` in commit `id` (`NONE` if absent, a directory, or a value leaf). */
  getRef(id: CommitHash, path: Path): Result<Option<StateRef>, WorldError> {
    return this.attempt(() => {
      this.checkPath(path)
      const node = locate(this.requireCommit(id).index, path)
      if (node?.kind !== 'leaf') return NONE
      const entry = this.storage.entry(node.originCommitId, encodePathKey(path))
      return entry.entryKind === 'ref' ? some(cloneRef(entry.ref)) : NONE
    })
  }

  /** Read the `message` value attached to commit `id`. */
  getMessage(id: CommitHash): Result<Value, WorldError> {
    return this.attempt(() => {
      this.requireCommit(id)
      return cloneValue(this.storage.message(id))
    })
  }

  /** Dereference `ref`, returning the `TreeNodeView` at `(ref.commitId, ref.path)`. */
  deref(ref: StateRef): Result<Option<TreeNodeView>, WorldError> {
    return this.attempt(() => {
      let copy: StateRef
      try {
        copy = cloneRef(ref)
      } catch (cause) {
        fail({ kind: 'invalid_path', path: ref.path, reason: String(cause) })
      }
      return this.view(copy.commitId, copy.path)
    })
  }

  /** Return `true` if the content at `(ref.commitId, ref.path)` differs from `(compareId, ref.path)`. */
  isRefChanged(ref: StateRef, compareId: CommitHash): Result<boolean, WorldError> {
    return this.attempt(() => {
      this.checkPath(ref.path)
      const a = locate(this.requireCommit(ref.commitId).index, ref.path)
      const b = locate(this.requireCommit(compareId).index, ref.path)
      if (a === b) return false
      if (a?.kind === 'leaf' && b?.kind === 'leaf' && a.originCommitId === b.originCommitId)
        return false
      if (a?.kind === 'dir' && b?.kind === 'dir' && a.lastModifiedAt === b.lastModifiedAt)
        return false
      return !viewsEqual(this.view(ref.commitId, ref.path), this.view(compareId, ref.path))
    })
  }

  /**
   * Atomically validate, persist and index a commit, optionally advancing a Head.
   * Head residency updates use only the affected origin branches and are
   * published with topology before events. Replaying an existing canonical
   * commit reuses its stored index; it never creates a duplicate commit event.
   */
  commit(input: CommitInput): Result<CommitNode, WorldError> {
    return this.write(() => this.commitInternal(input))
  }
  private commitInternal(input: CommitInput): CommitNode {
    if (input.parentId.kind === 'some') this.requireCommit(input.parentId.value)
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
    const diff = cloneDiff(input.diff ?? [])
    for (const op of diff) {
      if (op.op === 'ref' && !this.hasCommit(op.ref.commitId))
        fail({ kind: 'dangling_ref', refCommitId: op.ref.commitId, refPath: op.ref.path })
    }
    const parentId = input.parentId.kind === 'some' ? some(input.parentId.value) : NONE
    const id = hashCommit(parentId, message, diff)
    const existing = this.storage.commits.get(id)
    const isNew = existing === undefined
    // Preserve canonical object sharing when an existing hash is replayed.
    const index =
      existing?.index ??
      applyIndex(
        parentId.kind === 'some' ? this.requireCommit(parentId.value).index : emptyIndex(id),
        diff,
        id,
      )
    const node = Object.freeze({ id, parentId, message, diff })
    const headChanged = advance !== undefined && previousHead !== id
    const hot = this.storage.driver.transaction(() => {
      if (isNew) this.storage.insert(node)
      if (headChanged && advance) this.storage.writeHead(advance.name, id)
      return headChanged
        ? this.storage.prepareHot(
            previousHead === undefined ? undefined : this.requireCommit(previousHead).index,
            index,
          )
        : undefined
    })
    if (isNew)
      this.storage.add({
        id,
        parentId,
        index,
        children: new Set(),
        references: new Set(diff.filter((op) => op.op === 'ref').map((op) => op.ref.commitId)),
      })
    if (headChanged && advance) this.storage.heads.set(advance.name, id)
    if (hot) this.storage.installHot(hot)
    if (isNew) this.emitCommitted(node)
    if (headChanged && advance) this.emitHead(advance.name, some(id))
    return Object.freeze({ ...node, message: cloneValue(message), diff: cloneDiff(diff) })
  }

  /** Safely delete a leaf commit if it has no children, no incoming `StateRef` pins, and no `head` pointers. */
  popLeaf(id: CommitHash): Result<void, WorldError> {
    return this.write(() => {
      const record = this.requireCommit(id)
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
   */
  rebase(
    sourceChainIds: readonly CommitHash[],
    ontoId: CommitHash,
    options: RebaseOptions = {},
  ): Result<RebaseOutcome, WorldError> {
    return this.write(() => {
      const sourceIds = Object.freeze([...sourceChainIds])
      this.requireCommit(ontoId)
      for (let i = 0; i < sourceIds.length; i++) {
        const source = this.requireCommit(sourceIds[i]!)
        if (
          i > 0 &&
          (source.parentId.kind === 'none' || source.parentId.value !== sourceIds[i - 1])
        ) {
          fail({ kind: 'structure_conflict', path: [], reason: 'source_chain_is_not_contiguous' })
        }
      }
      const remapped = new Map(options.initialRemap)
      const policy = options.remapRefs ?? 'none'
      let tip = ontoId
      for (let i = 0; i < sourceIds.length; i++) {
        const sourceId = sourceIds[i]!
        const source = this.requireCommit(sourceId)
        const transform = (ref: StateRef): StateRef => {
          let mapped: StateRef
          try {
            mapped = cloneRef(applyRemapPolicy(ref, policy, new Map(remapped)))
          } catch (cause) {
            if (cause instanceof InvariantError) throw cause
            fail({ kind: 'invalid_value', path: ref.path, reason: String(cause) })
          }
          if (!this.hasCommit(mapped.commitId))
            fail({ kind: 'dangling_ref', refCommitId: mapped.commitId, refPath: mapped.path })
          return mapped
        }
        const effective = cloneDiff(
          this.storage
            .diff(sourceId)
            .map((op) => (op.op === 'ref' ? { ...op, ref: transform(op.ref) } : op)),
        )
        const groups: { root: Path; ops: DiffOp[] }[] = []
        for (const op of effective) {
          const group = groups.at(-1)
          if (group && isPrefix(group.root, op.path)) group.ops.push(op)
          else groups.push({ root: op.path, ops: [op] })
        }
        const conflicts: PathConflictDetail[] = []
        const reportedAncestors = new Set<string>()
        const retained: DiffOp[] = []
        for (const group of groups) {
          const base =
            source.parentId.kind === 'some'
              ? transformView(this.view(source.parentId.value, group.root), transform)
              : NONE
          const desired = this.desiredView(base, group.root, group.ops)
          const target = this.view(tip, group.root)
          let ancestorConflict = false
          let targetCursor: OriginTreeNode | undefined = this.requireCommit(tip).index
          let baseCursor: OriginTreeNode | undefined =
            source.parentId.kind === 'some'
              ? this.requireCommit(source.parentId.value).index
              : undefined
          let ancestorKey = ''
          for (let depth = 1; depth < group.root.length; depth++) {
            const seg = group.root[depth - 1]!
            ancestorKey += encodePathKey([seg])
            if (reportedAncestors.has(ancestorKey)) {
              ancestorConflict = true
              break
            }
            targetCursor = targetCursor?.kind === 'dir' ? targetCursor.children.get(seg) : undefined
            baseCursor = baseCursor?.kind === 'dir' ? baseCursor.children.get(seg) : undefined
            const reason =
              targetCursor?.kind === 'leaf'
                ? 'structure_conflict'
                : desired.kind === 'some' && baseCursor?.kind === 'dir' && !targetCursor
                  ? 'target_deleted_subtree'
                  : undefined
            if (reason) {
              const ancestorPath = Object.freeze(group.root.slice(0, depth))
              const targetAncestor = this.view(tip, ancestorPath)
              const baseAncestor =
                source.parentId.kind === 'some'
                  ? transformView(this.view(source.parentId.value, ancestorPath), transform)
                  : NONE
              const incomingAncestor = this.desiredView(
                baseAncestor,
                ancestorPath,
                effective.filter((op) => isPrefix(ancestorPath, op.path)),
              )
              conflicts.push(
                Object.freeze({
                  path: ancestorPath,
                  reason,
                  baseNode: baseAncestor,
                  targetNode: targetAncestor,
                  incomingNode: incomingAncestor,
                }),
              )
              reportedAncestors.add(ancestorKey)
              ancestorConflict = true
              break
            }
          }
          if (ancestorConflict) continue
          if (viewsEqual(target, desired)) continue
          if (viewsEqual(target, base)) {
            retained.push(...group.ops)
            continue
          }
          const reason =
            desired.kind === 'none'
              ? 'source_deleted_modified_subtree'
              : target.kind === 'none' && base.kind === 'some'
                ? 'target_deleted_subtree'
                : target.kind === 'some' &&
                    desired.kind === 'some' &&
                    target.value.nodeKind !== desired.value.nodeKind
                  ? 'structure_conflict'
                  : 'value_diverged'
          conflicts.push(
            Object.freeze({
              path: group.root,
              reason,
              baseNode: base,
              targetNode: target,
              incomingNode: desired,
            }),
          )
        }
        if (conflicts.length)
          return Object.freeze({
            status: 'conflict',
            currentTipId: tip,
            conflictedSourceId: sourceId,
            remainingSourceIds: Object.freeze(sourceIds.slice(i)),
            remappedIds: new Map(remapped),
            conflicts: Object.freeze(conflicts),
          })
        const result = this.attempt(() =>
          this.commitInternal({
            parentId: some(tip),
            message: this.storage.message(sourceId),
            diff: retained,
          }),
        )
        if (!result.ok) {
          if (result.error.kind === 'storage_error')
            fail({
              ...result.error,
              partialRebase: { currentTipId: tip, completedRemap: new Map(remapped) },
            })
          fail(result.error)
        }
        remapped.set(sourceId, result.value.id)
        tip = result.value.id
      }
      return Object.freeze({ status: 'completed', newTipId: tip, remappedIds: new Map(remapped) })
    })
  }

  private desiredView(
    base: Option<TreeNodeView>,
    root: Path,
    ops: readonly DiffOp[],
  ): Option<TreeNodeView> {
    const leaves = new Map<string, { path: Path; entry: LeafEntry }>()
    if (base.kind === 'some') {
      const collectStack: { node: TreeNodeView; path: Path }[] = [{ node: base.value, path: root }]
      while (collectStack.length > 0) {
        const { node, path } = collectStack.pop()!
        if (node.nodeKind === 'leaf') leaves.set(encodePathKey(path), { path, entry: node.entry })
        else {
          for (const [name, child] of node.entries) {
            collectStack.push({ node: child, path: [...path, name] })
          }
        }
      }
    }
    for (const op of ops)
      if (op.op === 'del') {
        for (const [key, leaf] of leaves) if (isPrefix(op.path, leaf.path)) leaves.delete(key)
      }
    for (const op of ops)
      if (op.op !== 'del')
        leaves.set(encodePathKey(op.path), {
          path: op.path,
          entry:
            op.op === 'set'
              ? { entryKind: 'val', value: cloneValue(op.value) }
              : { entryKind: 'ref', ref: cloneRef(op.ref) },
        })
    if (!leaves.size) return NONE
    const rootLeaf = leaves.get(encodePathKey(root))
    if (rootLeaf)
      return some(Object.freeze({ nodeKind: 'leaf', entry: cloneEntry(rootLeaf.entry) }))

    interface DirBuilder {
      readonly entries: Map<string, TreeNodeView>
      readonly children: Map<string, DirBuilder>
    }
    const rootBuilder: DirBuilder = { entries: new Map(), children: new Map() }
    const allBuilders: DirBuilder[] = [rootBuilder]
    const sortedLeaves = [...leaves.values()].sort((a, b) => comparePaths(a.path, b.path))
    for (const leaf of sortedLeaves) {
      let cursor = rootBuilder
      for (let d = root.length; d < leaf.path.length - 1; d++) {
        const seg = leaf.path[d]!
        let child = cursor.children.get(seg)
        if (!child) {
          child = { entries: new Map(), children: new Map() }
          cursor.children.set(seg, child)
          cursor.entries.set(seg, null as unknown as TreeNodeView)
          allBuilders.push(child)
        }
        cursor = child
      }
      const lastSeg = leaf.path[leaf.path.length - 1]!
      cursor.entries.set(
        lastSeg,
        Object.freeze({ nodeKind: 'leaf', entry: cloneEntry(leaf.entry) }),
      )
    }
    for (let i = allBuilders.length - 1; i >= 0; i--) {
      const builder = allBuilders[i]!
      for (const [seg, childBuilder] of builder.children) {
        builder.entries.set(seg, Object.freeze({ nodeKind: 'dir', entries: childBuilder.entries }))
      }
    }
    return some(Object.freeze({ nodeKind: 'dir', entries: rootBuilder.entries }))
  }
}
