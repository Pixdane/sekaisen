import type { Option } from '@sekaisen/core'
import { compareUtf8, NONE, some } from '@sekaisen/core'
import {
  cloneEntry,
  cloneRef,
  cloneValue,
  comparePaths,
  encodePathKey,
  leafEntryEquals,
} from './codec.ts'
import { fail, locate } from './origin.ts'
import type { StoredCommit, WorldStorage } from './storage.ts'
import type {
  CommitHash,
  LeafEntry,
  OriginTreeNode,
  Path,
  StateRef,
  TreeNodeInfo,
  TreeNodeView,
  Value,
} from './types.ts'

/** Structural equality for detached `TreeNodeView`s, including nested directories. */
export function viewsEqual(a: Option<TreeNodeView>, b: Option<TreeNodeView>): boolean {
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

/**
 * Internal path-tree reader over the in-memory topology and origin indexes.
 *
 * Reads locate leaves through the commit's `OriginIndexTree` and hydrate cold
 * payloads from {@link WorldStorage} on demand. No method caches whole views:
 * `nodeInfo` and `children` stay index-only, while `view` materializes exactly
 * the requested subtree.
 */
export class WorldTreeReader {
  private readonly storage: WorldStorage

  constructor(storage: WorldStorage) {
    this.storage = storage
  }

  /** Resolve the live topology record for `id` or throw `commit_not_found`. */
  requireCommit(id: CommitHash): StoredCommit {
    const record = this.storage.commits.get(id)
    if (!record) fail({ kind: 'commit_not_found', commitId: id })
    return record
  }

  /**
   * Clone one stored leaf and optionally project its `StateRef` while knowing
   * which commit originally wrote the leaf. Rebase uses the origin to
   * force-sync prior self references without letting a remap policy override it.
   */
  private leafEntryAt(
    originCommitId: CommitHash,
    pathKey: string,
    transformRef?: (ref: StateRef, originCommitId: CommitHash) => StateRef,
  ): LeafEntry {
    const entry = cloneEntry(this.storage.entry(originCommitId, pathKey))
    if (!transformRef || entry.entryKind !== 'ref') return entry
    return Object.freeze({
      entryKind: 'ref',
      ref: cloneRef(transformRef(entry.ref, originCommitId)),
    })
  }

  /**
   * Materialize the subtree at `path` from commit `id`.
   *
   * `transformRef` is only used by rebase base views: it receives each ref leaf
   * together with the commit that wrote it. Normal reads leave it undefined and
   * return stored (already materialized) refs unchanged.
   */
  view(
    id: CommitHash,
    path: Path,
    transformRef?: (ref: StateRef, originCommitId: CommitHash) => StateRef,
  ): Option<TreeNodeView> {
    const index = locate(this.requireCommit(id).index, path)
    if (!index) return NONE
    const rootKey = encodePathKey(path)
    if (index.kind === 'leaf') {
      return some(
        Object.freeze({
          nodeKind: 'leaf',
          entry: this.leafEntryAt(index.originCommitId, rootKey, transformRef),
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
              entry: this.leafEntryAt(child.originCommitId, childKey, transformRef),
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

  /** Read index-only node metadata without hydrating payloads or descendants. */
  nodeInfo(id: CommitHash, path: Path): Option<TreeNodeInfo> {
    const node = locate(this.requireCommit(id).index, path)
    if (!node) return NONE
    return some(
      Object.freeze(
        node.kind === 'leaf'
          ? { nodeKind: 'leaf' as const, originCommitId: node.originCommitId }
          : { nodeKind: 'dir' as const, lastModifiedAt: node.lastModifiedAt },
      ),
    )
  }

  /** List direct child names of a directory in UTF-8 byte order. */
  children(id: CommitHash, path: Path): Option<readonly string[]> {
    const node = locate(this.requireCommit(id).index, path)
    if (!node) return NONE
    if (node.kind !== 'dir')
      fail({ kind: 'structure_conflict', path, reason: 'Cannot list children of a leaf' })
    return some(Object.freeze([...node.children.keys()].sort(compareUtf8)))
  }

  /** Read a value leaf (`NONE` when absent, a directory, or a ref leaf). */
  value(id: CommitHash, path: Path): Option<Value> {
    const node = locate(this.requireCommit(id).index, path)
    if (node?.kind !== 'leaf') return NONE
    const entry = this.storage.entry(node.originCommitId, encodePathKey(path))
    return entry.entryKind === 'val' ? some(cloneValue(entry.value)) : NONE
  }

  /** Read a reference leaf (`NONE` when absent, a directory, or a value leaf). */
  ref(id: CommitHash, path: Path): Option<StateRef> {
    const node = locate(this.requireCommit(id).index, path)
    if (node?.kind !== 'leaf') return NONE
    const entry = this.storage.entry(node.originCommitId, encodePathKey(path))
    return entry.entryKind === 'ref' ? some(cloneRef(entry.ref)) : NONE
  }

  /** Read the `message` value attached to commit `id`. */
  message(id: CommitHash): Value {
    this.requireCommit(id)
    return cloneValue(this.storage.message(id))
  }

  /** Resolve `ref` to the `TreeNodeView` at `(ref.commitId, ref.path)`. */
  deref(ref: StateRef): Option<TreeNodeView> {
    let copy: StateRef
    try {
      copy = cloneRef(ref)
    } catch (cause) {
      fail({ kind: 'invalid_path', path: ref.path, reason: String(cause) })
    }
    return this.view(copy.commitId, copy.path)
  }

  /** Return `true` if `(ref.commitId, ref.path)` differs from `(compareId, ref.path)`. */
  isRefChanged(ref: StateRef, compareId: CommitHash): boolean {
    const a = locate(this.requireCommit(ref.commitId).index, ref.path)
    const b = locate(this.requireCommit(compareId).index, ref.path)
    if (a === b) return false
    if (a?.kind === 'leaf' && b?.kind === 'leaf' && a.originCommitId === b.originCommitId)
      return false
    if (a?.kind === 'dir' && b?.kind === 'dir' && a.lastModifiedAt === b.lastModifiedAt)
      return false
    return !viewsEqual(this.view(ref.commitId, ref.path), this.view(compareId, ref.path))
  }
}
