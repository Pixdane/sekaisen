import type { Option } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import {
  cloneDiff,
  cloneRef,
  decodePathKey,
  decodeStoredValue,
  encodePathKey,
  encodeStoredValue,
  utf8Decoder,
} from './codec.ts'
import { applyIndex, emptyIndex } from './origin.ts'
import type {
  CommitHash,
  CommitNode,
  LeafEntry,
  OriginDirectoryNode,
  OriginTreeNode,
  SqliteDriver,
  StateDiff,
  Value,
} from './types.ts'

const encoder = new TextEncoder()

function decodeRawText(bytes: unknown, label: string): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new InvariantError(`Corrupted ${label}: expected raw UTF-8 bytes`)
  }
  try {
    const text = utf8Decoder.decode(bytes)
    if (!text.isWellFormed()) throw new TypeError('lone surrogate')
    return text
  } catch (cause) {
    throw new InvariantError(`Corrupted ${label}: invalid UTF-8 sequence`, { cause })
  }
}

function resolveRawPayload(raw: unknown, textBytes: unknown, storageClass: string): unknown {
  if (storageClass.toLowerCase() === 'text') {
    return decodeRawText(textBytes, 'stored text value')
  }
  return raw
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val TEXT NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY, parent_id TEXT, msg_type INTEGER NOT NULL, msg_raw ANY) STRICT;
CREATE TABLE IF NOT EXISTS diff_entries (
 commit_id TEXT NOT NULL, path_key TEXT NOT NULL, op INTEGER NOT NULL,
 val_type INTEGER, val_raw ANY, ref_commit_id TEXT, ref_path_key TEXT,
 PRIMARY KEY (commit_id, path_key)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS commit_refs (source_commit_id TEXT NOT NULL, target_commit_id TEXT NOT NULL,
 PRIMARY KEY (source_commit_id, target_commit_id)) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_commit_refs_target ON commit_refs (target_commit_id);
CREATE TABLE IF NOT EXISTS heads (name TEXT PRIMARY KEY, commit_id TEXT NOT NULL) STRICT;
`

/* -------------------------------------------------------------------------- */
/*                         In-memory topology & cache                         */
/* -------------------------------------------------------------------------- */

/** In-memory topology record and origin index tree for a persisted commit. */
export interface StoredCommit {
  readonly id: CommitHash
  readonly parentId: Option<CommitHash>
  readonly children: Set<CommitHash>
  /**
   * Commit ids referenced by this node's `StateRef` leaves. Self anchors
   * (`ref.commitId === id`) are intentionally absent so they never pin the node.
   */
  readonly references: Set<CommitHash>
  readonly index: OriginDirectoryNode
}

/** Object wrapper used as the target of `WeakRef` entries in the value cache. */
class CacheBox<T> {
  readonly value: T

  constructor(value: T) {
    this.value = value
  }
}

/** Strongly pinned leaf entry and the number of active Heads that reach it. */
export interface HotEntry {
  readonly box: CacheBox<LeafEntry>
  readonly count: number
}

/**
 * Prepared residency change for one Head transition.
 *
 * A `patch` carries the final state of every affected key (`undefined` releases
 * the key); `clear` releases every key without walking the departing tree. An
 * `undefined` {@link WorldStorage.prepareHot} result means no change at all.
 */
export type HotUpdate =
  | { readonly kind: 'patch'; readonly entries: ReadonlyMap<string, HotEntry | undefined> }
  | { readonly kind: 'clear' }

const CLEAR_HOT: HotUpdate = Object.freeze({ kind: 'clear' })

function hotKey(origin: CommitHash, pathKey: string): string {
  return `e:${origin}:${pathKey}`
}

function childPathKey(pathKey: string, name: string): string {
  return `${pathKey}${encoder.encode(name).byteLength}:${name}`
}

type HotJob =
  | {
      readonly kind: 'pair'
      readonly oldNode: OriginTreeNode
      readonly newNode: OriginTreeNode
      readonly pathKey: string
    }
  | {
      readonly kind: 'add' | 'remove'
      readonly node: OriginTreeNode
      readonly pathKey: string
    }

/**
 * SQLite-backed persistence and `WeakRef` cache manager for the commit forest.
 *
 * Reconstructs the `OriginIndexTree` and reference pin graph on startup,
 * keeps active Head leaves strongly pinned with per-Head ownership counts,
 * and lazily loads cold values or weak-only commit messages. Head transitions
 * stage sparse residency patches and skip reference-shared index subtrees;
 * live counts change only when the caller publishes a successful transaction.
 *
 * Self-referencing `StateRef`s (`commitId === node.id`) are canonicalized by
 * excluding them from `commit_refs`, `pins` and startup reconciliation, so a
 * commit is never pinned by its own anchor. Any persisted self edge is
 * rejected as corruption.
 */
export class WorldStorage {
  readonly commits = new Map<CommitHash, StoredCommit>()
  readonly heads = new Map<string, CommitHash>()
  readonly pins = new Map<CommitHash, Set<CommitHash>>()
  private readonly weakPool = new Map<string, WeakRef<CacheBox<LeafEntry | Value>>>()
  private readonly hot = new Map<string, HotEntry>()
  private readonly registry = new FinalizationRegistry<{
    key: string
    ref: WeakRef<CacheBox<LeafEntry | Value>>
  }>(({ key, ref }) => {
    if (this.weakPool.get(key) === ref) this.weakPool.delete(key)
  })

  readonly driver: SqliteDriver

  constructor(driver: SqliteDriver) {
    this.driver = driver
    try {
      driver.transaction(() => {
        const encoding = driver.prepare('PRAGMA encoding').get<{ encoding: string }>()
        if (encoding.kind === 'none' || encoding.value.encoding.toUpperCase() !== 'UTF-8') {
          throw new InvariantError(
            `Unsupported SQLite encoding: ${encoding.kind === 'some' ? encoding.value.encoding : 'unknown'}`,
          )
        }
        driver.exec(SCHEMA)
        const meta = driver
          .prepare('SELECT CAST(val AS BLOB) AS val_bytes FROM meta WHERE key = ?')
          .get<{ val_bytes: Uint8Array }>('format_version')
        if (meta.kind === 'none') {
          const count = driver
            .prepare('SELECT count(*) AS count FROM meta')
            .get<{ count: number }>()
          if (count.kind === 'none' || count.value.count !== 0)
            throw new InvariantError('Missing format_version in nonempty metadata')
          driver.prepare('INSERT INTO meta (key, val) VALUES (?, ?)').run('format_version', '1')
        } else {
          const version = decodeRawText(meta.value.val_bytes, 'format_version')
          if (version !== '1') throw new InvariantError(`Unsupported world format: ${version}`)
        }
        this.loadTopology()
      })
      this.initializeHot()
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause
      throw new InvariantError('World storage initialization failed', { cause })
    }
  }

  private loadTopology(): void {
    const rawRows = this.driver
      .prepare(
        'SELECT CAST(id AS BLOB) AS id_bytes, CASE WHEN parent_id IS NOT NULL THEN CAST(parent_id AS BLOB) ELSE NULL END AS parent_bytes FROM commits',
      )
      .all<{ id_bytes: Uint8Array; parent_bytes: Uint8Array | null }>()
    const rows = rawRows.map((row) => ({
      id: decodeRawText(row.id_bytes, 'commit id') as CommitHash,
      parent_id:
        row.parent_bytes !== null
          ? (decodeRawText(row.parent_bytes, 'parent commit id') as CommitHash)
          : null,
    }))
    const pending = new Map(rows.map((row) => [row.id, row]))
    const rawDiffRows = this.driver
      .prepare(
        'SELECT CAST(commit_id AS BLOB) AS commit_bytes, CAST(path_key AS BLOB) AS path_bytes, op, val_type, val_raw IS NOT NULL AS has_raw, CASE WHEN ref_commit_id IS NOT NULL THEN CAST(ref_commit_id AS BLOB) ELSE NULL END AS ref_id_bytes, CASE WHEN ref_path_key IS NOT NULL THEN CAST(ref_path_key AS BLOB) ELSE NULL END AS ref_path_bytes FROM diff_entries',
      )
      .all<{
        commit_bytes: Uint8Array
        path_bytes: Uint8Array
        op: number
        val_type: number | null
        has_raw: number
        ref_id_bytes: Uint8Array | null
        ref_path_bytes: Uint8Array | null
      }>()
    const diffRows = rawDiffRows.map((row) => ({
      commit_id: decodeRawText(row.commit_bytes, 'diff commit_id') as CommitHash,
      path_key: decodeRawText(row.path_bytes, 'diff path_key'),
      op: row.op,
      val_type: row.val_type,
      has_raw: row.has_raw,
      ref_commit_id:
        row.ref_id_bytes !== null
          ? (decodeRawText(row.ref_id_bytes, 'diff ref_commit_id') as CommitHash)
          : null,
      ref_path_key:
        row.ref_path_bytes !== null ? decodeRawText(row.ref_path_bytes, 'diff ref_path_key') : null,
    }))
    const ids = new Set(rows.map((row) => row.id))
    const diffs = new Map<CommitHash, StateDiff>()
    for (const row of rows) {
      if (
        typeof row.id !== 'string' ||
        !row.id.length ||
        !row.id.isWellFormed() ||
        (row.parent_id !== null && !ids.has(row.parent_id))
      ) {
        throw new InvariantError(`Invalid commit topology: ${row.id}`)
      }
    }
    const grouped = new Map<CommitHash, (typeof diffRows)[number][]>()
    for (const row of diffRows) {
      if (!ids.has(row.commit_id)) throw new InvariantError(`Orphan diff: ${row.commit_id}`)
      const group = grouped.get(row.commit_id) ?? []
      group.push(row)
      grouped.set(row.commit_id, group)
    }
    const expectedEdges = new Map<CommitHash, Set<CommitHash>>()
    for (const row of rows) {
      const diff = cloneDiff(
        (grouped.get(row.id) ?? []).map((entry) => {
          const path = decodePathKey(entry.path_key)
          if (entry.op === 0) {
            if (
              entry.val_type !== null ||
              entry.has_raw !== 0 ||
              entry.ref_commit_id !== null ||
              entry.ref_path_key !== null
            ) {
              throw new InvariantError(`Invalid del metadata: ${row.id}/${entry.path_key}`)
            }
            return { op: 'del' as const, path }
          }
          if (entry.op === 1) {
            if (
              entry.val_type === null ||
              entry.ref_commit_id !== null ||
              entry.ref_path_key !== null
            ) {
              throw new InvariantError(`Invalid set metadata: ${row.id}/${entry.path_key}`)
            }
            return { op: 'set' as const, path, value: null }
          }
          if (
            entry.op !== 2 ||
            entry.val_type !== null ||
            entry.has_raw !== 0 ||
            entry.ref_commit_id === null ||
            entry.ref_path_key === null ||
            !ids.has(entry.ref_commit_id)
          ) {
            throw new InvariantError(`Invalid ref metadata: ${row.id}/${entry.path_key}`)
          }
          const edges = expectedEdges.get(row.id) ?? new Set<CommitHash>()
          // A StateRef to its own commit is a self anchor, never a pin edge.
          if (entry.ref_commit_id !== row.id) edges.add(entry.ref_commit_id)
          expectedEdges.set(row.id, edges)
          return {
            op: 'ref' as const,
            path,
            ref: cloneRef({
              commitId: entry.ref_commit_id,
              path: decodePathKey(entry.ref_path_key),
            }),
          }
        }),
      )
      diffs.set(row.id, diff)
    }
    const actualEdges = new Map<CommitHash, Set<CommitHash>>()
    for (const edge of this.driver
      .prepare(
        'SELECT CAST(source_commit_id AS BLOB) AS source_bytes, CAST(target_commit_id AS BLOB) AS target_bytes FROM commit_refs',
      )
      .all<{ source_bytes: Uint8Array; target_bytes: Uint8Array }>()) {
      const sourceId = decodeRawText(
        edge.source_bytes,
        'commit_refs.source_commit_id',
      ) as CommitHash
      const targetId = decodeRawText(
        edge.target_bytes,
        'commit_refs.target_commit_id',
      ) as CommitHash
      if (!ids.has(sourceId) || !ids.has(targetId))
        throw new InvariantError('Orphan commit_refs edge')
      if (sourceId === targetId)
        throw new InvariantError(`commit_refs contains a self edge: ${sourceId}`)
      const edges = actualEdges.get(sourceId) ?? new Set<CommitHash>()
      edges.add(targetId)
      actualEdges.set(sourceId, edges)
    }
    for (const id of ids) {
      const expected = expectedEdges.get(id) ?? new Set<CommitHash>()
      const actual = actualEdges.get(id) ?? new Set<CommitHash>()
      if (actual.size !== expected.size || [...actual].some((target) => !expected.has(target))) {
        throw new InvariantError(`commit_refs reconciliation failed for ${id}`)
      }
    }
    // Each edge is visited once, including deep histories (no recursive ancestor walks).
    const children = new Map<CommitHash, CommitHash[]>()
    const ready: CommitHash[] = []
    for (const row of rows) {
      if (row.parent_id === null) ready.push(row.id)
      else {
        const list = children.get(row.parent_id) ?? []
        list.push(row.id)
        children.set(row.parent_id, list)
      }
    }
    for (let cursor = 0; cursor < ready.length; cursor++) {
      const id = ready[cursor]!
      const row = pending.get(id)!
      const parentId = row.parent_id === null ? NONE : some(row.parent_id)
      const base = row.parent_id === null ? emptyIndex(id) : this.commits.get(row.parent_id)!.index
      const index = applyIndex(base, diffs.get(id)!, id)
      this.add({
        id,
        parentId,
        children: new Set(),
        references: expectedEdges.get(id) ?? new Set(),
        index,
      })
      pending.delete(id)
      for (const childId of children.get(id) ?? []) ready.push(childId)
    }
    if (pending.size)
      throw new InvariantError(`Cycle in commit forest: ${[...pending.keys()].join(', ')}`)
    for (const row of this.driver
      .prepare(
        'SELECT CAST(name AS BLOB) AS name_bytes, CAST(commit_id AS BLOB) AS id_bytes FROM heads',
      )
      .all<{ name_bytes: Uint8Array; id_bytes: Uint8Array }>()) {
      const name = decodeRawText(row.name_bytes, 'head name')
      const commitId = decodeRawText(row.id_bytes, 'head commit_id') as CommitHash
      if (!name.length || !name.isWellFormed() || !ids.has(commitId))
        throw new InvariantError(`Invalid head: ${name}`)
      this.heads.set(name, commitId)
    }
  }

  /**
   * Register a verified commit topology record and its outgoing reference pins
   * in memory. Self anchors are absent from `record.references`, so they never
   * appear in `pins` or `getReferencingCommits`.
   */
  add(record: StoredCommit): void {
    this.commits.set(record.id, record)
    if (record.parentId.kind === 'some')
      this.commits.get(record.parentId.value)!.children.add(record.id)
    for (const target of record.references) {
      const sources = this.pins.get(target) ?? new Set<CommitHash>()
      sources.add(record.id)
      this.pins.set(target, sources)
    }
  }

  private cached<T extends LeafEntry | Value>(key: string, load: () => T): CacheBox<T> {
    const found = this.weakPool.get(key)?.deref()
    if (found) return found as CacheBox<T>
    const box = new CacheBox(load())
    const ref = new WeakRef(box)
    this.weakPool.set(key, ref)
    this.registry.register(box, { key, ref })
    return box
  }

  /** Read a leaf entry `(id, pathKey)`, hydrating from SQLite on a `weakPool` miss. */
  entry(id: CommitHash, pathKey: string): LeafEntry {
    return this.entryBox(id, pathKey).value
  }
  private entryBox(id: CommitHash, pathKey: string): CacheBox<LeafEntry> {
    return this.cached(hotKey(id, pathKey), () => {
      const row = this.driver
        .prepare(
          "SELECT op, val_type, val_raw, CASE WHEN typeof(val_raw) = 'text' THEN CAST(val_raw AS BLOB) ELSE NULL END AS text_bytes, typeof(val_raw) AS storage_class, CASE WHEN ref_commit_id IS NOT NULL THEN CAST(ref_commit_id AS BLOB) ELSE NULL END AS ref_id_bytes, CASE WHEN ref_path_key IS NOT NULL THEN CAST(ref_path_key AS BLOB) ELSE NULL END AS ref_path_bytes FROM diff_entries WHERE commit_id = ? AND path_key = CAST(? AS TEXT)",
        )
        .get<{
          op: number
          val_type: unknown
          val_raw: unknown
          text_bytes: Uint8Array | null
          storage_class: string
          ref_id_bytes: Uint8Array | null
          ref_path_bytes: Uint8Array | null
        }>(id, encoder.encode(pathKey))
      if (row.kind === 'none')
        throw new InvariantError(`Origin points to missing entry: ${id}/${pathKey}`)
      const data = row.value
      if (data.op === 1) {
        if (data.ref_id_bytes !== null || data.ref_path_bytes !== null)
          throw new InvariantError('set entry contains ref columns')
        const raw = resolveRawPayload(data.val_raw, data.text_bytes, data.storage_class)
        return Object.freeze({
          entryKind: 'val',
          value: decodeStoredValue(data.val_type, raw, data.storage_class),
        })
      }
      if (
        data.op === 2 &&
        data.val_type === null &&
        data.val_raw === null &&
        data.ref_id_bytes !== null &&
        data.ref_path_bytes !== null
      ) {
        try {
          return Object.freeze({
            entryKind: 'ref',
            ref: cloneRef({
              commitId: decodeRawText(data.ref_id_bytes, 'ref_commit_id') as CommitHash,
              path: decodePathKey(decodeRawText(data.ref_path_bytes, 'ref_path_key')),
            }),
          })
        } catch (cause) {
          throw new InvariantError(`Invalid persisted reference: ${id}/${pathKey}`, { cause })
        }
      }
      throw new InvariantError(`Invalid leaf row: ${id}/${pathKey}`)
    })
  }

  /** Read a commit's `message`, hydrating from `commits.msg_raw` on a `weakPool` miss. */
  message(id: CommitHash): Value {
    return this.cached(`m:${id}`, () => {
      const row = this.driver
        .prepare(
          "SELECT msg_type, msg_raw, CASE WHEN typeof(msg_raw) = 'text' THEN CAST(msg_raw AS BLOB) ELSE NULL END AS text_bytes, typeof(msg_raw) AS storage_class FROM commits WHERE id = ?",
        )
        .get<{
          msg_type: unknown
          msg_raw: unknown
          text_bytes: Uint8Array | null
          storage_class: string
        }>(id)
      if (row.kind === 'none') throw new InvariantError(`Missing commit message: ${id}`)
      const raw = resolveRawPayload(
        row.value.msg_raw,
        row.value.text_bytes,
        row.value.storage_class,
      )
      return decodeStoredValue(row.value.msg_type, raw, row.value.storage_class)
    }).value
  }

  /** Load and canonicalize the full `StateDiff` of `id` from `diff_entries`. */
  diff(id: CommitHash): StateDiff {
    const rows = this.driver
      .prepare(
        "SELECT CAST(path_key AS BLOB) AS path_bytes, op, val_type, val_raw, CASE WHEN typeof(val_raw) = 'text' THEN CAST(val_raw AS BLOB) ELSE NULL END AS text_bytes, typeof(val_raw) AS storage_class, CASE WHEN ref_commit_id IS NOT NULL THEN CAST(ref_commit_id AS BLOB) ELSE NULL END AS ref_id_bytes, CASE WHEN ref_path_key IS NOT NULL THEN CAST(ref_path_key AS BLOB) ELSE NULL END AS ref_path_bytes FROM diff_entries WHERE commit_id = ?",
      )
      .all<{
        path_bytes: Uint8Array
        op: number
        val_type: unknown
        val_raw: unknown
        text_bytes: Uint8Array | null
        storage_class: string
        ref_id_bytes: Uint8Array | null
        ref_path_bytes: Uint8Array | null
      }>(id)
    try {
      return cloneDiff(
        rows.map((row) => {
          const pathKey = decodeRawText(row.path_bytes, 'diff path_key')
          const path = decodePathKey(pathKey)
          if (
            row.op === 0 &&
            row.val_type === null &&
            row.val_raw === null &&
            row.ref_id_bytes === null &&
            row.ref_path_bytes === null
          )
            return { op: 'del' as const, path }
          if (row.op === 1 && row.ref_id_bytes === null && row.ref_path_bytes === null) {
            const raw = resolveRawPayload(row.val_raw, row.text_bytes, row.storage_class)
            return {
              op: 'set' as const,
              path,
              value: decodeStoredValue(row.val_type, raw, row.storage_class),
            }
          }
          if (
            row.op === 2 &&
            row.val_type === null &&
            row.val_raw === null &&
            row.ref_id_bytes !== null &&
            row.ref_path_bytes !== null
          )
            return {
              op: 'ref' as const,
              path,
              ref: cloneRef({
                commitId: decodeRawText(row.ref_id_bytes, 'ref_commit_id') as CommitHash,
                path: decodePathKey(decodeRawText(row.ref_path_bytes, 'ref_path_key')),
              }),
            }
          throw new InvariantError(`Invalid diff row: ${id}/${pathKey}`)
        }),
      )
    } catch (cause) {
      if (cause instanceof InvariantError) throw cause
      throw new InvariantError(`Invalid persisted diff: ${id}`, { cause })
    }
  }

  /**
   * Persist a new `CommitNode` and its outgoing `commit_refs` edges inside an
   * active transaction. A `StateRef` whose target equals `node.id` is a self
   * anchor and is deliberately not written to `commit_refs`.
   */
  insert(node: CommitNode): void {
    const message = encodeStoredValue(node.message)
    this.driver
      .prepare(
        `INSERT INTO commits (id,parent_id,msg_type,msg_raw) VALUES (?,?,?,${message.type === 3 ? 'CAST(? AS TEXT)' : '?'})`,
      )
      .run(
        node.id,
        node.parentId.kind === 'some' ? node.parentId.value : null,
        message.type,
        message.raw,
      )
    const targets = new Set<CommitHash>()
    for (const op of node.diff) {
      const stored = op.op === 'set' ? encodeStoredValue(op.value) : null
      this.driver
        .prepare(
          `INSERT INTO diff_entries (commit_id,path_key,op,val_type,val_raw,ref_commit_id,ref_path_key) VALUES (?,CAST(? AS TEXT),?,?,${stored?.type === 3 ? 'CAST(? AS TEXT)' : '?'},?,CAST(? AS TEXT))`,
        )
        .run(
          node.id,
          encoder.encode(encodePathKey(op.path)),
          op.op === 'del' ? 0 : op.op === 'set' ? 1 : 2,
          stored?.type ?? null,
          stored?.raw ?? null,
          op.op === 'ref' ? op.ref.commitId : null,
          op.op === 'ref' ? encoder.encode(encodePathKey(op.ref.path)) : null,
        )
      if (op.op === 'ref' && op.ref.commitId !== node.id) targets.add(op.ref.commitId)
    }
    const statement = this.driver.prepare(
      'INSERT INTO commit_refs (source_commit_id,target_commit_id) VALUES (?,?)',
    )
    for (const target of targets) statement.run(node.id, target)
  }

  /** Insert or update a named head cursor in the `heads` table. */
  writeHead(name: string, id: CommitHash): void {
    this.driver
      .prepare(
        'INSERT INTO heads (name,commit_id) VALUES (CAST(? AS TEXT),?) ON CONFLICT(name) DO UPDATE SET commit_id=excluded.commit_id',
      )
      .run(encoder.encode(name), id)
  }

  /**
   * Initialize the strong residency map once from the persisted `heads`.
   *
   * Active Heads are grouped by their exact index object and each distinct root
   * is walked once with the group size as its weight, so aliases and no-op
   * commits (which share an index object with their parent) keep per-Head
   * counts without re-walking the same tree.
   */
  private initializeHot(): void {
    const weights = new Map<OriginDirectoryNode, number>()
    for (const id of this.heads.values()) {
      const index = this.commits.get(id)!.index
      weights.set(index, (weights.get(index) ?? 0) + 1)
    }
    const stack: { node: OriginTreeNode; pathKey: string; weight: number }[] = []
    for (const [index, weight] of weights) stack.push({ node: index, pathKey: '', weight })
    while (stack.length > 0) {
      const { node, pathKey, weight } = stack.pop()!
      if (node.kind === 'dir') {
        for (const [name, child] of node.children)
          stack.push({ node: child, pathKey: childPathKey(pathKey, name), weight })
        continue
      }
      const key = hotKey(node.originCommitId, pathKey)
      const current = this.hot.get(key)
      this.hot.set(
        key,
        Object.freeze({
          box: current?.box ?? this.entryBox(node.originCommitId, pathKey),
          count: (current?.count ?? 0) + weight,
        }),
      )
    }
  }

  /**
   * Prepare the residency change for one Head transition without mutating `hot`.
   *
   * `oldIndex`/`newIndex` are that Head's indexes before and after the
   * transition (`undefined` = absent Head); `heads` must still describe the
   * pre-transition topology. Added leaves that are not already resident are
   * hydrated here, so callers run this inside the transaction that writes the
   * new Head state. Counts are per Head: every alias contributes separately.
   *
   * Preparation may populate weak entries, but never changes strong ownership.
   * Install the returned plan only after that transaction succeeds, before any
   * other Head transition. A sole Head leaving for an absent or empty state
   * produces a clear plan without walking the old tree.
   */
  prepareHot(
    oldIndex: OriginDirectoryNode | undefined,
    newIndex: OriginDirectoryNode | undefined,
  ): HotUpdate | undefined {
    if (oldIndex === newIndex) return undefined
    if (
      oldIndex !== undefined &&
      this.heads.size === 1 &&
      (newIndex === undefined || newIndex.children.size === 0)
    )
      return CLEAR_HOT
    const patch = new Map<string, HotEntry | undefined>()
    const stack: HotJob[] = []
    if (oldIndex === undefined) {
      if (newIndex !== undefined) stack.push({ kind: 'add', node: newIndex, pathKey: '' })
    } else if (newIndex === undefined) {
      stack.push({ kind: 'remove', node: oldIndex, pathKey: '' })
    } else {
      stack.push({ kind: 'pair', oldNode: oldIndex, newNode: newIndex, pathKey: '' })
    }
    while (stack.length > 0) {
      const job = stack.pop()!
      if (job.kind === 'pair') {
        this.diffNode(job.oldNode, job.newNode, job.pathKey, patch, stack)
      } else if (job.node.kind === 'dir') {
        for (const [name, child] of job.node.children)
          stack.push({ kind: job.kind, node: child, pathKey: childPathKey(job.pathKey, name) })
      } else if (job.kind === 'add') {
        this.addLeaf(job.node.originCommitId, job.pathKey, patch)
      } else {
        this.removeLeaf(job.node.originCommitId, job.pathKey, patch)
      }
    }
    return patch.size > 0 ? { kind: 'patch', entries: patch } : undefined
  }

  /** Apply a plan from {@link prepareHot}; no SQL is issued and no tree is walked. */
  installHot(update: HotUpdate): void {
    if (update.kind === 'clear') {
      this.hot.clear()
      return
    }
    for (const [key, entry] of update.entries) {
      if (entry === undefined) this.hot.delete(key)
      else this.hot.set(key, entry)
    }
  }

  /**
   * Walk one `(oldNode, newNode)` pair iteratively, enqueueing only changed
   * children. Identical node objects are skipped before their children or
   * descendant names are read, and equal-origin leaf pairs cancel outright.
   */
  private diffNode(
    oldNode: OriginTreeNode,
    newNode: OriginTreeNode,
    pathKey: string,
    patch: Map<string, HotEntry | undefined>,
    stack: HotJob[],
  ): void {
    if (oldNode === newNode) return
    if (oldNode.kind === 'leaf') {
      if (newNode.kind === 'leaf') {
        if (oldNode.originCommitId === newNode.originCommitId) return
        this.removeLeaf(oldNode.originCommitId, pathKey, patch)
        this.addLeaf(newNode.originCommitId, pathKey, patch)
        return
      }
      this.removeLeaf(oldNode.originCommitId, pathKey, patch)
      stack.push({ kind: 'add', node: newNode, pathKey })
      return
    }
    if (newNode.kind === 'leaf') {
      stack.push({ kind: 'remove', node: oldNode, pathKey })
      this.addLeaf(newNode.originCommitId, pathKey, patch)
      return
    }
    for (const [name, oldChild] of oldNode.children) {
      const newChild = newNode.children.get(name)
      if (newChild === undefined) {
        stack.push({ kind: 'remove', node: oldChild, pathKey: childPathKey(pathKey, name) })
      } else if (newChild !== oldChild) {
        stack.push({
          kind: 'pair',
          oldNode: oldChild,
          newNode: newChild,
          pathKey: childPathKey(pathKey, name),
        })
      }
    }
    for (const [name, newChild] of newNode.children) {
      if (oldNode.children.has(name)) continue
      stack.push({ kind: 'add', node: newChild, pathKey: childPathKey(pathKey, name) })
    }
  }

  /** Record one Head leaving a physical leaf coordinate; never mutates live counts. */
  private removeLeaf(
    origin: CommitHash,
    pathKey: string,
    patch: Map<string, HotEntry | undefined>,
  ): void {
    const key = hotKey(origin, pathKey)
    const current = this.hot.get(key)
    if (!current || current.count < 1)
      throw new InvariantError(`Hot residency underflow: ${origin}/${pathKey}`)
    if (current.count === 1) {
      patch.set(key, undefined)
      return
    }
    patch.set(key, Object.freeze({ box: current.box, count: current.count - 1 }))
  }

  /** Record one Head entering a physical leaf coordinate, hydrating only absent boxes. */
  private addLeaf(
    origin: CommitHash,
    pathKey: string,
    patch: Map<string, HotEntry | undefined>,
  ): void {
    const key = hotKey(origin, pathKey)
    const current = this.hot.get(key)
    patch.set(
      key,
      Object.freeze({
        box: current?.box ?? this.entryBox(origin, pathKey),
        count: (current?.count ?? 0) + 1,
      }),
    )
  }

  /** Remove a leaf commit from in-memory topology and release its outgoing reference pins. */
  remove(id: CommitHash): void {
    const record = this.commits.get(id)!
    if (record.parentId.kind === 'some')
      this.commits.get(record.parentId.value)!.children.delete(id)
    for (const target of record.references) {
      const pins = this.pins.get(target)!
      pins.delete(id)
      if (!pins.size) this.pins.delete(target)
    }
    this.commits.delete(id)
  }
}
