import type { CommitHash, Path, StateDiff } from '@sekaisen/plugin-world'
import { assertIdentifier } from './builders.ts'
import type { Catalog, StateReader } from './runtime.ts'
import { childKeys, hasNode, inspectNode, validateNodeHeader, validateState } from './runtime.ts'
import type { MapSchemaNode, SchemaNode, StructSchemaNode } from './types.ts'

/**
 * Validate a final draft against an unchanged Writer Catalog while trusting the
 * already-validated base state for every physical coordinate the diff did not
 * touch.
 *
 * Preconditions:
 * - `state` is the final physical tree; `diff` is the complete canonical net
 *   diff from a state that was valid for `catalog`.
 * - `catalog` is the final Writer Catalog. If `$schemas` changed, the caller
 *   supplies the catalog read from `state`; any catalog change falls back to
 *   the independent full traversal.
 *
 * The routing is a sparse trie of physical diff prefixes:
 * - An operation marks its exact node as whole; a whole ancestor subsumes every
 *   descendant operation and is validated with {@link inspectNode}.
 * - Untouched physical subtrees and unrelated roots are never traversed.
 * - Dirty ancestors only need {@link validateNodeHeader}; a present ancestor
 *   descends into dirty Struct fields in schema order and dirty Map members in
 *   UTF-8 key order.
 * - A leaf (including metadata-only edits), a whole node, a container whose
 *   `$exists` discriminator changed, and a Struct whose `$custom` subtree
 *   changed are inspected whole. A presence flip can expose previously absent
 *   required/defaulted children, and custom validation rules stay in one place.
 * - A deleted Map member is allowed even when the member value schema is
 *   required or defaulted, because the member's final physical subtree is
 *   absent. Existence is probed through the discriminating leaf first, so an
 *   unchanged nested Map is never enumerated just to prove it exists.
 *
 * Error precedence therefore matches the full oracle: Catalog root order,
 * Struct declaration order, then Map UTF-8 key order. Business validators are
 * not part of this routine.
 */
export function validateChangedState(
  state: StateReader,
  catalog: Catalog,
  commitId: CommitHash,
  diff: StateDiff,
): void {
  if (changesCatalog(diff)) {
    // Definitions are shared by every root: only the full traversal can prove
    // the final tree against a changed Catalog.
    validateState(state, catalog, commitId)
    return
  }
  const changes = buildChangeTrie(diff)
  if (changes === undefined) return
  for (const root of catalog.roots.values()) {
    const dirty = locateDirty(changes, root.path)
    if (dirty === undefined) continue
    if (dirty === true) inspectNode(state, root.path, root.schema, root.schema, commitId)
    else validateDirtyNode(state, root.path, root.schema, dirty, commitId)
  }
}

/** Sparse tree of dirty physical path prefixes. */
interface DirtyPrefix {
  /** A diff operation ended here, so the whole logical node is dirty. */
  whole: boolean
  children: Map<string, DirtyPrefix> | undefined
}

/**
 * Build the dirty-prefix trie. Operations are canonical and path-sorted, but a
 * later ancestor delete still subsumes earlier descendants; marking a node
 * whole drops the descendants and every later descendant walk stops early.
 */
function buildChangeTrie(diff: StateDiff): DirtyPrefix | undefined {
  if (diff.length === 0) return undefined
  const root: DirtyPrefix = { whole: false, children: undefined }
  for (const op of diff) {
    let node = root
    let shadowed = false
    for (const key of op.path) {
      if (node.whole) {
        shadowed = true
        break
      }
      let child = node.children?.get(key)
      if (child === undefined) {
        child = { whole: false, children: undefined }
        if (node.children === undefined) node.children = new Map()
        node.children.set(key, child)
      }
      node = child
    }
    if (shadowed) continue
    node.whole = true
    node.children = undefined
  }
  return root
}

/** A change to `$schemas` (or the whole tree) invalidates Catalog trust for all roots. */
function changesCatalog(diff: StateDiff): boolean {
  for (const op of diff) {
    if (op.path.length === 0 || op.path[0] === '$schemas') return true
  }
  return false
}

/**
 * Find the dirty subtree covering a registered root. `true` means a whole
 * ancestor already subsumes the root; `undefined` means the root is untouched.
 */
function locateDirty(branch: DirtyPrefix, path: Path): DirtyPrefix | true | undefined {
  let node = branch
  for (const key of path) {
    if (node.whole) return true
    const child = node.children?.get(key)
    if (child === undefined) return undefined
    node = child
  }
  return node.whole ? true : node
}

/** Whether the sparse routing must defer to full node inspection. */
function isWholeChange(writer: MapSchemaNode | StructSchemaNode, dirty: DirtyPrefix): boolean {
  if (dirty.whole) return true
  const children = dirty.children
  if (children === undefined) return true
  // The anchor changed, so the node may be newly created or newly removed;
  // full inspection re-checks required/defaulted children and orphaning.
  if (children.has('$exists')) return true
  // Custom field specs, collisions, and removals are validated by inspectNode.
  return writer.nodeKind === 'struct' && children.has('$custom')
}

function validateDirtyNode(
  state: StateReader,
  path: Path,
  writer: SchemaNode,
  dirty: DirtyPrefix,
  commitId: CommitHash,
): void {
  if (writer.nodeKind === 'leaf' || isWholeChange(writer, dirty)) {
    inspectNode(state, path, writer, writer, commitId)
    return
  }
  if (!validateNodeHeader(state, path, writer, commitId)) return
  const children = dirty.children
  if (children === undefined) return
  if (writer.nodeKind === 'map') {
    // Canonical diff order gives the trie UTF-8 sibling insertion order.
    for (const [key, child] of children) {
      // A newly written key must be a valid identifier; unchanged members are
      // trusted and are neither enumerated nor validated again.
      assertIdentifier(key)
      const at = [...path, key]
      // Removed Map members are valid even for required/defaulted value
      // schemas; probe existence before applying Writer presence rules.
      if (!mapEntryExists(state, at, writer.valueSchema)) continue
      validateDirtyNode(state, at, writer.valueSchema, child, commitId)
    }
    return
  }
  // Header already rejected final unknown children. Visit only dirty declared
  // fields, in declaration order, preserving full-traversal precedence.
  for (const [key, field] of Object.entries(writer.fields)) {
    const child = children.get(key)
    if (child === undefined) continue
    validateDirtyNode(state, [...path, key], field, child, commitId)
  }
}

/**
 * Whether a dirty Map member survived to the final tree. The discriminating
 * leaf is checked first, so an existing anchored nested Map is not enumerated.
 * Only when no discriminator and no leaf entry exist can a direct child name
 * list distinguish a fully removed member from orphan data.
 */
function mapEntryExists(state: StateReader, path: Path, spec: SchemaNode): boolean {
  if (hasNode(state, path, spec)) return true
  if (state.hasEntry(path)) return true
  return childKeys(state, path).length > 0
}
