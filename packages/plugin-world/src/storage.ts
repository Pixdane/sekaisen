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

/**
 * SQLite-backed persistence and `WeakRef` cache manager for the commit forest.
 *
 * Reconstructs the `OriginIndexTree` and reference pin graph on startup,
 * keeps active `heads` leaves strongly pinned in `hot`, and lazily loads
 * cold leaf values or commit messages on demand.
 */
export class WorldStorage {
  readonly commits = new Map<CommitHash, StoredCommit>()
  readonly heads = new Map<string, CommitHash>()
  readonly pins = new Map<CommitHash, Set<CommitHash>>()
  private readonly weakPool = new Map<string, WeakRef<CacheBox<LeafEntry | Value>>>()
  private readonly hot = new Map<string, CacheBox<LeafEntry | Value>>()
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
      this.refreshHot()
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
          edges.add(entry.ref_commit_id)
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

  /** Register a verified commit topology record and its outgoing reference pins in memory. */
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
    return this.cached(`e:${id}:${pathKey}`, () => {
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

  /** Persist a new `CommitNode` and its outgoing `commit_refs` edges inside an active transaction. */
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
      if (op.op === 'ref') targets.add(op.ref.commitId)
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

  /** Hydrate and collect strong `CacheBox` references for all leaves reachable from `indices`. */
  prepareHot(indices: Iterable<OriginDirectoryNode>) {
    const next = new Map<string, CacheBox<LeafEntry | Value>>()
    const stack: { node: OriginDirectoryNode; pathKey: string }[] = []
    for (const index of indices) stack.push({ node: index, pathKey: '' })
    while (stack.length > 0) {
      const { node, pathKey } = stack.pop()!
      for (const [name, child] of node.children) {
        const childKey = `${pathKey}${encoder.encode(name).byteLength}:${name}`
        if (child.kind === 'dir') stack.push({ node: child, pathKey: childKey })
        else {
          next.set(
            `e:${child.originCommitId}:${childKey}`,
            this.entryBox(child.originCommitId, childKey),
          )
        }
      }
    }
    return next
  }

  /** Atomically replace the strongly pinned `hot` leaf set for active `heads`. */
  installHot(next: ReadonlyMap<string, CacheBox<LeafEntry | Value>>): void {
    this.hot.clear()
    for (const [key, box] of next) this.hot.set(key, box)
  }

  /** Rebuild the `hot` strong-reference map from all currently active `heads`. */
  refreshHot(): void {
    this.installHot(
      this.prepareHot([...new Set(this.heads.values())].map((id) => this.commits.get(id)!.index)),
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
