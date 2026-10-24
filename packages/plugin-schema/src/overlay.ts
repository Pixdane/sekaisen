import { compareUtf8 } from '@sekaisen/core'
import type { DiffOp, LeafEntry, Path, StateDiff } from '@sekaisen/plugin-world'
import { comparePaths, leafEntryEquals, validatePath } from '@sekaisen/plugin-world'
import type { StateReader, StateWriter } from './runtime.ts'
import { copyValue, EMPTY_STATE } from './runtime.ts'

const EMPTY_KEYS: readonly string[] = Object.freeze([])

/**
 * Sparse copy-on-write trie node. Untouched coordinates have no node at all, so
 * the number of nodes is proportional to the dirty paths, never to the base.
 */
class DraftNode {
  /** Explicitly written leaf at exactly this coordinate. */
  entry: LeafEntry | undefined = undefined
  /** Overlay changes below this coordinate; `undefined` when none were made. */
  children: Map<string, DraftNode> | undefined = undefined
  /** Hides the base leaf/subtree at this coordinate for the overlay lifetime. */
  tombstone = false
  /**
   * Conservative marker: a subtree delete happened at or below this node.
   * Used to avoid emptiness/base scans for write-only dirty branches.
   */
  deleteTouched = false
}

/** Pending pre-order diff visit. `depth` is the parent path length. */
interface DiffTask {
  readonly node: DraftNode
  readonly baseVisible: boolean
  readonly depth: number
  readonly key: string | undefined
}

/** Post-order frame for the iterative final-content computation. */
interface ContentFrame {
  readonly node: DraftNode
  readonly visibleBase: boolean
  iterator: IterableIterator<[string, DraftNode]> | undefined
  content: boolean
  readonly pushed: boolean
}

/** First-touch snapshot of one draft node, sufficient to undo a scope. */
interface DraftSnapshot {
  readonly node: DraftNode
  readonly entry: LeafEntry | undefined
  readonly children: Map<string, DraftNode> | undefined
  readonly tombstone: boolean
  readonly deleteTouched: boolean
}

/**
 * One inserted draft node, sufficient to detach exactly that creation.
 * `siblings` is the Map identity that received the insertion; a later snapshot
 * restoration may replace `parent.children` with a different (pre-scope) Map,
 * so rollback must never infer ownership from `parent` + `key` alone.
 */
interface CreatedNode {
  readonly parent: DraftNode
  readonly key: string
  readonly node: DraftNode
  readonly siblings: Map<string, DraftNode>
}

/** One rollback scope: first-touch snapshots plus nodes created inside it. */
interface RollbackJournal {
  readonly snapshots: Map<DraftNode, DraftSnapshot>
  /** Nodes that did not exist before the scope, in creation order. */
  readonly created: CreatedNode[]
}

function del(path: Path): DiffOp {
  return Object.freeze({ op: 'del', path: Object.freeze([...path]) })
}

/**
 * Mutable physical draft over an immutable {@link StateReader}. Construction
 * neither reads nor copies the base. Writes own their payloads; retained draft
 * storage tracks dirty coordinates and owned payloads, not untouched world data.
 *
 * Deletes install a tombstone: the base leaf and its descendants remain
 * invisible until explicitly rewritten. {@link compileDiff} computes a net,
 * canonical diff between the immutable base and the final overlay state; a
 * value that returns to its base representation produces no operation.
 *
 * Shape conflicts (a leaf plus descendants, or a write below a base leaf) are
 * preserved instead of repaired. Only {@link deleteTree} authorizes replacing
 * a subtree, so full schema validation and World diff rules reject unresolved
 * conflicts.
 *
 * All tree walks use explicit stacks with a shared backtracking path buffer, so
 * schema root paths of thousands of segments cannot overflow the call stack,
 * and a point diff does not allocate one full path copy per level.
 */
export class DraftOverlay implements StateWriter {
  private readonly base: StateReader
  private readonly root = new DraftNode()
  /**
   * Monotonic write counter, incremented by every `setEntry`/`deleteTree` and
   * by rollback. Derived indices (backlinks, link validation) key caches on it
   * so a draft is re-scanned exactly when its physical state changed.
   */
  revision = 0
  /** Undo journals for {@link beginScope}; the newest scope is last. */
  private readonly journals: RollbackJournal[] = []

  constructor(base: StateReader = EMPTY_STATE) {
    this.base = base
  }

  /**
   * Open a rollback scope. Every draft write until the matching
   * {@link commitScope} or {@link rollbackScope} records enough state to undo
   * itself, including intermediate nodes created while walking a path.
   * Scopes nest; accepting an inner scope merges its undo records upward.
   *
   * Used by the three-phase link cascade, which must discard a tentatively
   * applied mutation completely when a `reject` edge remains live.
   */
  beginScope(): void {
    this.journals.push({ snapshots: new Map(), created: [] })
  }

  /** Accept the newest scope, handing its undo records to the enclosing scope. */
  commitScope(): void {
    const journal = this.journals.pop()
    if (journal === undefined) throw new Error('No draft rollback scope is open')
    const parent = this.journals.at(-1)
    if (parent === undefined) return
    for (const [node, snapshot] of journal.snapshots) {
      if (!parent.snapshots.has(node)) parent.snapshots.set(node, snapshot)
    }
    parent.created.push(...journal.created)
  }

  /**
   * Undo every write made since the newest {@link beginScope} and close that
   * scope. Field snapshots are restored first, which may replace a node's
   * children Map with its pre-scope identity. Created nodes are then detached
   * only when their recorded insertion target is still the owning Map and the
   * key still holds that exact node. A key that was re-created after the
   * snapshot therefore never deletes a restored pre-scope child.
   */
  rollbackScope(): void {
    const journal = this.journals.pop()
    if (journal === undefined) throw new Error('No draft rollback scope is open')
    for (const snapshot of journal.snapshots.values()) {
      snapshot.node.entry = snapshot.entry
      snapshot.node.children = snapshot.children
      snapshot.node.tombstone = snapshot.tombstone
      snapshot.node.deleteTouched = snapshot.deleteTouched
    }
    for (let index = journal.created.length - 1; index >= 0; index--) {
      const created = journal.created[index]!
      if (created.parent.children !== created.siblings) continue
      if (created.siblings.get(created.key) !== created.node) continue
      created.siblings.delete(created.key)
    }
    this.revision += 1
  }

  /** Snapshot a node before its first mutation inside the current scope. */
  private record(node: DraftNode): void {
    const journal = this.journals.at(-1)
    if (journal === undefined || journal.snapshots.has(node)) return
    journal.snapshots.set(node, {
      node,
      entry: node.entry,
      children: node.children,
      tombstone: node.tombstone,
      deleteTouched: node.deleteTouched,
    })
  }

  /** Remember an intermediate node that did not exist before the current scope. */
  private recordCreated(
    parent: DraftNode,
    key: string,
    node: DraftNode,
    siblings: Map<string, DraftNode>,
  ): void {
    this.journals.at(-1)?.created.push({ parent, key, node, siblings })
  }

  getEntry(path: Path): LeafEntry | undefined {
    let node = this.root
    let hidden = this.root.tombstone
    for (const key of path) {
      const child = node.children?.get(key)
      if (child === undefined) return hidden ? undefined : this.base.getEntry(path)
      node = child
      if (child.tombstone) hidden = true
    }
    if (node.entry !== undefined) return node.entry
    return hidden ? undefined : this.base.getEntry(path)
  }

  hasEntry(path: Path): boolean {
    let node = this.root
    let hidden = this.root.tombstone
    for (const key of path) {
      const child = node.children?.get(key)
      if (child === undefined) return !hidden && this.base.hasEntry(path)
      node = child
      if (child.tombstone) hidden = true
    }
    if (node.entry !== undefined) return true
    return !hidden && this.base.hasEntry(path)
  }

  childKeys(path: Path): readonly string[] {
    const { node, hidden } = this.locate(path)
    const baseVisible = !hidden
    const children = node?.children
    const names = new Set<string>()
    const memo = new Map<DraftNode, boolean>()
    // One copy of the caller's path; per-child probes push/pop one segment.
    const shared = [...path]
    if (baseVisible) {
      for (const key of this.base.childKeys(path)) {
        const child = children?.get(key)
        if (child === undefined || this.contentOf(shared, child, true, memo, key)) names.add(key)
      }
    }
    if (children !== undefined) {
      for (const [key, child] of children) {
        if (names.has(key)) continue
        if (this.contentOf(shared, child, baseVisible, memo, key)) names.add(key)
      }
    }
    if (names.size === 0) return EMPTY_KEYS
    return Object.freeze([...names].sort(compareUtf8))
  }

  setEntry(path: Path, entry: LeafEntry): void {
    if (path.length === 0) {
      // World forbids empty-path writes, so a root leaf cannot be represented
      // as a canonical diff. Production schema writes always have a root name.
      throw new TypeError('DraftOverlay.setEntry cannot write the root path')
    }
    validatePath(path)
    // Own the payload before any trie mutation so an invalid entry cannot leave
    // half-created intermediate nodes behind.
    const owned: LeafEntry =
      entry.entryKind === 'ref'
        ? Object.freeze({ entryKind: 'ref' as const, ref: copyValue(entry.ref) })
        : Object.freeze({ entryKind: 'val' as const, value: copyValue(entry.value) })
    let node = this.root
    for (const key of path) {
      let child = node.children?.get(key)
      if (child === undefined) {
        child = new DraftNode()
        const siblings = node.children ?? new Map<string, DraftNode>()
        node.children = siblings
        siblings.set(key, child)
        this.recordCreated(node, key, child, siblings)
      }
      node = child
    }
    // A previous tombstone stays in place: base siblings and descendants stay
    // hidden, and only explicitly rewritten leaves become visible again.
    this.record(node)
    node.entry = owned
    this.revision += 1
  }

  deleteTree(path: Path): void {
    validatePath(path)
    this.revision += 1
    this.record(this.root)
    this.root.deleteTouched = true
    if (path.length === 0) {
      this.root.entry = undefined
      this.root.children = undefined
      this.root.tombstone = true
      return
    }
    let node = this.root
    let hidden = this.root.tombstone
    for (const key of path) {
      let child = node.children?.get(key)
      if (child === undefined) {
        // An ancestor tombstone already hides this coordinate and no dirty
        // writes survive below it, so the delete is a no-op.
        if (hidden) return
        child = new DraftNode()
        const siblings = node.children ?? new Map<string, DraftNode>()
        node.children = siblings
        siblings.set(key, child)
        this.recordCreated(node, key, child, siblings)
      }
      this.record(child)
      child.deleteTouched = true
      node = child
      if (node.tombstone) hidden = true
    }
    node.entry = undefined
    node.children = undefined
    node.tombstone = true
  }

  /**
   * Net canonical diff from the immutable base to the current overlay state.
   * Operations and paths are copied and frozen; payloads are copied so the
   * result is isolated from later draft writes (mutable `Uint8Array` contents
   * stay mutable, matching World value semantics). The result is sorted by
   * {@link comparePaths} and contains no duplicate paths.
   *
   * The walk is iterative and shares one backtracking path buffer, so neither
   * deep root paths nor wide dirty branches grow the call stack or allocate a
   * full path per visited node.
   */
  compileDiff(): StateDiff {
    const ops: DiffOp[] = []
    const memo = new Map<DraftNode, boolean>()
    const path: string[] = []
    const tasks: DiffTask[] = [{ node: this.root, baseVisible: true, depth: 0, key: undefined }]
    while (tasks.length > 0) {
      const task = tasks.pop()!
      path.length = task.depth
      if (task.key !== undefined) path.push(task.key)
      const node = task.node
      const visibleBase = task.baseVisible && !node.tombstone

      // A delete somewhere below can empty this subtree: coalesce into the
      // highest nonempty ancestor that has no final content left. Write-only
      // branches skip this entirely and never enumerate base siblings.
      if ((!visibleBase || node.deleteTouched) && !this.contentOf(path, node, visibleBase, memo)) {
        this.emitEmpty(path, ops)
        continue
      }

      if (node.entry !== undefined) {
        const baseEntry = this.base.getEntry(path)
        // Restoring the base representation is not a diff, even inside a tombstone.
        if (baseEntry === undefined || !leafEntryEquals(baseEntry, node.entry)) {
          const frozen = Object.freeze([...path])
          ops.push(
            node.entry.entryKind === 'ref'
              ? Object.freeze({ op: 'ref' as const, path: frozen, ref: copyValue(node.entry.ref) })
              : Object.freeze({
                  op: 'set' as const,
                  path: frozen,
                  value: copyValue(node.entry.value),
                }),
          )
        }
      } else if (!visibleBase && this.base.hasEntry(path)) {
        ops.push(del(path))
      }

      const children = node.children
      if (visibleBase) {
        if (children === undefined) continue
        const depth = path.length
        for (const [key, child] of children)
          tasks.push({ node: child, baseVisible: true, depth, key })
        continue
      }

      // Base content below a tombstone is only restored by explicit writes;
      // every base branch without final content coalesces into one directory
      // delete. Only direct base children are named here, never their payloads.
      const baseKeys = this.base.childKeys(path)
      const baseKeySet = new Set(baseKeys)
      for (const key of baseKeys) {
        const child = children?.get(key)
        if (child !== undefined && this.contentOf(path, child, false, memo, key)) {
          tasks.push({ node: child, baseVisible: false, depth: path.length, key })
        } else {
          path.push(key)
          ops.push(del(path))
          path.pop()
        }
      }
      if (children !== undefined) {
        for (const [key, child] of children) {
          if (baseKeySet.has(key)) continue
          if (this.contentOf(path, child, false, memo, key))
            tasks.push({ node: child, baseVisible: false, depth: path.length, key })
        }
      }
    }
    ops.sort((a, b) => comparePaths(a.path, b.path))
    return Object.freeze(ops)
  }

  /** Resolve the deepest draft node at `path` and whether its base is hidden. */
  private locate(path: Path): { node: DraftNode | undefined; hidden: boolean } {
    let node: DraftNode | undefined = this.root
    let hidden = this.root.tombstone
    for (const key of path) {
      const child: DraftNode | undefined = node?.children?.get(key)
      if (child === undefined) return { node: undefined, hidden }
      node = child
      if (child.tombstone) hidden = true
    }
    return { node, hidden }
  }

  /**
   * Whether the final tree has any leaf at or below the current `path`.
   * Iterative post-order over dirty nodes; base subtrees are inspected only by
   * direct child names where no overlay node already covers them.
   *
   * `key` is pushed for the duration of the call when `node` itself is the
   * child being probed; the shared buffer ends at its original length.
   */
  private contentOf(
    path: string[],
    node: DraftNode,
    baseVisible: boolean,
    memo: Map<DraftNode, boolean>,
    key?: string,
  ): boolean {
    const cached = memo.get(node)
    if (cached !== undefined) return cached
    const baseLength = path.length
    if (key !== undefined) path.push(key)
    const frames: ContentFrame[] = [
      {
        node,
        visibleBase: baseVisible && !node.tombstone,
        iterator: node.children?.entries(),
        content: node.entry !== undefined,
        pushed: key !== undefined,
      },
    ]
    let result = false
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      if (frame.content) {
        memo.set(frame.node, true)
        if (frame.pushed) path.pop()
        frames.pop()
        if (frames.length === 0) result = true
        else frames[frames.length - 1]!.content = true
        continue
      }
      const iterator = frame.iterator
      if (iterator !== undefined) {
        const next = iterator.next()
        if (!next.done) {
          const [childKey, child] = next.value
          const childCached = memo.get(child)
          if (childCached === true) {
            frame.content = true
            continue
          }
          if (childCached === false) continue
          if (child.entry !== undefined) {
            memo.set(child, true)
            frame.content = true
            continue
          }
          path.push(childKey)
          frames.push({
            node: child,
            visibleBase: frame.visibleBase && !child.tombstone,
            iterator: child.children?.entries(),
            content: false,
            pushed: true,
          })
          continue
        }
        frame.iterator = undefined
      }
      let content = false
      if (frame.visibleBase) {
        if (this.base.hasEntry(path)) {
          content = true
        } else {
          const children = frame.node.children
          for (const childKey of this.base.childKeys(path)) {
            if (children === undefined || !children.has(childKey)) {
              content = true
              break
            }
          }
        }
      }
      memo.set(frame.node, content)
      if (frame.pushed) path.pop()
      frames.pop()
      if (content) {
        if (frames.length === 0) result = true
        else frames[frames.length - 1]!.content = true
      }
    }
    // Frames pop exactly what they pushed; only ever shrink defensively.
    if (path.length > baseLength) path.length = baseLength
    return result
  }

  /**
   * Emit deletions for a subtree that has no final content. The root path
   * cannot appear in a World diff, so it expands into top-level child deletes.
   */
  private emitEmpty(path: Path, ops: DiffOp[]): void {
    if (path.length > 0) {
      if (this.base.hasEntry(path) || this.base.childKeys(path).length > 0) ops.push(del(path))
      return
    }
    for (const key of this.base.childKeys(path)) ops.push(del([key]))
  }
}
