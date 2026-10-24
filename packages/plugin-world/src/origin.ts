import { InvariantError } from '@sekaisen/core'
import type {
  CommitHash,
  OriginDirectoryNode,
  OriginTreeNode,
  Path,
  StateDiff,
  WorldError,
} from './types.ts'

/* -------------------------------------------------------------------------- */
/*                         Origin index tree helpers                          */
/* -------------------------------------------------------------------------- */

/** Create an empty root {@link OriginDirectoryNode} stamped with `id`. */
export function emptyIndex(id: CommitHash): OriginDirectoryNode {
  return Object.freeze({ kind: 'dir', lastModifiedAt: id, children: new Map() })
}

/**
 * Locate the {@link OriginTreeNode} at `path` within `root`, or return
 * `undefined` if any segment is missing or crosses a leaf.
 */
export function locate(root: OriginTreeNode, path: Path): OriginTreeNode | undefined {
  let node: OriginTreeNode | undefined = root
  for (const segment of path) {
    if (node?.kind !== 'dir') return undefined
    node = node.children.get(segment)
  }
  return node
}

function update(
  root: OriginDirectoryNode,
  path: Path,
  replacement: OriginTreeNode | undefined,
  id: CommitHash,
): OriginDirectoryNode {
  const spine: OriginDirectoryNode[] = [root]
  let cursor = root
  for (let depth = 0; depth < path.length - 1; depth++) {
    const segment = path[depth]!
    const child = cursor.children.get(segment)
    if (child?.kind === 'leaf') throw new InvariantError('Origin update crossed a leaf')
    const next = child ?? emptyIndex(id)
    spine.push(next)
    cursor = next
  }
  let currentChild: OriginTreeNode | undefined = replacement
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const parent = spine[depth]!
    const segment = path[depth]!
    const children = new Map(parent.children)
    if (currentChild && (currentChild.kind === 'leaf' || currentChild.children.size > 0)) {
      children.set(segment, currentChild)
    } else {
      children.delete(segment)
    }
    currentChild = Object.freeze({ kind: 'dir', lastModifiedAt: id, children })
  }
  return currentChild as OriginDirectoryNode
}

/** Internal exception carrying a structured {@link WorldError} from index application. */
export class PatchError extends Error {
  readonly worldError: WorldError

  constructor(worldError: WorldError) {
    super(worldError.kind)
    this.worldError = worldError
  }
}

/** Throw a {@link WorldError} as the internal {@link PatchError} carrier. */
export function fail(error: WorldError): never {
  throw new PatchError(error)
}

/**
 * Apply a canonical two-phase `diff` (`del` phase followed by `set`/`ref` phase)
 * onto `base`, returning a new structurally shared {@link OriginDirectoryNode}
 * stamped with `id` and pruning any directories that become empty.
 */
export function applyIndex(
  base: OriginDirectoryNode,
  diff: StateDiff,
  id: CommitHash,
): OriginDirectoryNode {
  let root = base
  for (const op of diff) {
    if (op.op !== 'del') continue
    if (!locate(root, op.path)) {
      throw new PatchError({
        kind: 'invalid_diff',
        path: op.path,
        reason: 'delete_non_existent_path',
      })
    }
    root = update(root, op.path, undefined, id)
  }
  for (const op of diff) {
    if (op.op === 'del') continue
    let cursor: OriginTreeNode | undefined = root
    for (let depth = 0; depth < op.path.length - 1; depth++) {
      cursor = cursor?.kind === 'dir' ? cursor.children.get(op.path[depth]!) : undefined
      if (cursor?.kind === 'leaf') {
        throw new PatchError({
          kind: 'structure_conflict',
          path: op.path,
          reason: 'ancestor_is_leaf',
        })
      }
    }
    if (locate(root, op.path)?.kind === 'dir') {
      throw new PatchError({
        kind: 'structure_conflict',
        path: op.path,
        reason: 'path_is_directory',
      })
    }
    root = update(root, op.path, Object.freeze({ kind: 'leaf', originCommitId: id }), id)
  }
  return root
}

/** Return `true` when `prefix` is equal to or a strict prefix of `path`. */
export function isPrefix(prefix: Path, path: Path): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index])
}
