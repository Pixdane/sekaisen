import type { Option, Result } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import {
  applyRemapPolicy,
  cloneDiff,
  cloneEntry,
  cloneRef,
  cloneValue,
  comparePaths,
  encodePathKey,
  SELF_COMMIT,
} from './codec.ts'
import { fail, isPrefix } from './origin.ts'
import { viewsEqual } from './reader.ts'
import type { StoredCommit } from './storage.ts'
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
  StateDiff,
  StateRef,
  TreeNodeView,
  Value,
  WorldError,
} from './types.ts'

/**
 * Internal read/replay contract for a rebase run.
 *
 * `commit` must be the service's atomic commit orchestration without a public
 * write guard: the caller already holds the write lock and dispatches events.
 * Its input factory runs inside the service's error boundary, preserving
 * `partialRebase` reporting when message hydration fails.
 */
export interface RebaseContext {
  readonly requireCommit: (id: CommitHash) => StoredCommit
  readonly hasCommit: (id: CommitHash) => boolean
  readonly view: (
    id: CommitHash,
    path: Path,
    transformRef?: (ref: StateRef, originCommitId: CommitHash) => StateRef,
  ) => Option<TreeNodeView>
  readonly message: (id: CommitHash) => Value
  readonly diff: (id: CommitHash) => StateDiff
  readonly commit: (input: () => CommitInput) => Result<CommitNode, WorldError>
}

/**
 * Replay contiguous `sourceChainIds` onto `ontoId` using atomic prefix-root
 * group three-way prechecks, stopping on the first conflict without writing
 * partial state.
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
export function rebaseOnto(
  ctx: RebaseContext,
  sourceChainIds: readonly CommitHash[],
  ontoId: CommitHash,
  options: RebaseOptions = {},
): RebaseOutcome {
  const sourceIds = Object.freeze([...sourceChainIds])
  ctx.requireCommit(ontoId)
  for (let i = 0; i < sourceIds.length; i++) {
    const source = ctx.requireCommit(sourceIds[i]!)
    if (i > 0 && (source.parentId.kind === 'none' || source.parentId.value !== sourceIds[i - 1])) {
      fail({ kind: 'structure_conflict', path: [], reason: 'source_chain_is_not_contiguous' })
    }
  }
  const remapped = new Map(options.initialRemap)
  const policy = options.remapRefs ?? 'none'
  let tip = ontoId
  for (let i = 0; i < sourceIds.length; i++) {
    const sourceId = sourceIds[i]!
    const source = ctx.requireCommit(sourceId)
    const transform = (ref: StateRef): StateRef => {
      let mapped: StateRef
      try {
        mapped = cloneRef(applyRemapPolicy(ref, policy, new Map(remapped)))
      } catch (cause) {
        if (cause instanceof InvariantError) throw cause
        fail({ kind: 'invalid_value', path: ref.path, reason: String(cause) })
      }
      if (!ctx.hasCommit(mapped.commitId))
        fail({ kind: 'dangling_ref', refCommitId: mapped.commitId, refPath: mapped.path })
      return mapped
    }
    const forceSelfSync = (ref: StateRef, originCommitId: CommitHash): StateRef => {
      if (ref.commitId === originCommitId) {
        const replacement = remapped.get(originCommitId)
        if (replacement !== undefined) {
          if (!ctx.hasCommit(replacement))
            fail({ kind: 'dangling_ref', refCommitId: replacement, refPath: ref.path })
          return cloneRef({ commitId: replacement, path: ref.path })
        }
      }
      return transform(ref)
    }
    const effective = cloneDiff(
      ctx.diff(sourceId).map((op) => {
        if (op.op !== 'ref') return op
        if (op.ref.commitId === sourceId)
          return {
            op: 'ref' as const,
            path: op.path,
            ref: { commitId: SELF_COMMIT, path: op.ref.path },
          }
        return { ...op, ref: transform(op.ref) }
      }),
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
          ? ctx.view(source.parentId.value, group.root, forceSelfSync)
          : NONE
      const desired = desiredView(base, group.root, group.ops)
      const target = ctx.view(tip, group.root)
      let ancestorConflict = false
      let targetCursor: OriginTreeNode | undefined = ctx.requireCommit(tip).index
      let baseCursor: OriginTreeNode | undefined =
        source.parentId.kind === 'some' ? ctx.requireCommit(source.parentId.value).index : undefined
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
          const targetAncestor = ctx.view(tip, ancestorPath)
          const baseAncestor =
            source.parentId.kind === 'some'
              ? ctx.view(source.parentId.value, ancestorPath, forceSelfSync)
              : NONE
          const incomingAncestor = desiredView(
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
      // Desired SELF_COMMIT leaves never byte-equal a materialized target
      // ref, so a self write cannot be pruned as a same-change no-op here.
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
    const result = ctx.commit(() => ({
      parentId: some(tip),
      message: ctx.message(sourceId),
      diff: retained,
    }))
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
}

/** Apply one atomic prefix-root group on top of its effective base view. */
function desiredView(
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
  if (rootLeaf) return some(Object.freeze({ nodeKind: 'leaf', entry: cloneEntry(rootLeaf.entry) }))

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
    cursor.entries.set(lastSeg, Object.freeze({ nodeKind: 'leaf', entry: cloneEntry(leaf.entry) }))
  }
  for (let i = allBuilders.length - 1; i >= 0; i--) {
    const builder = allBuilders[i]!
    for (const [seg, childBuilder] of builder.children) {
      builder.entries.set(seg, Object.freeze({ nodeKind: 'dir', entries: childBuilder.entries }))
    }
  }
  return some(Object.freeze({ nodeKind: 'dir', entries: rootBuilder.entries }))
}
