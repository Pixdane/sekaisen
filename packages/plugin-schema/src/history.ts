import type { Option } from '@sekaisen/core'
import { isOption, NONE, some } from '@sekaisen/core'
import type { CommitHash, Path, StateRef } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { cloneStateRef, SchemaFailure } from './builders.ts'
import { checkDrift } from './evolution.ts'
import { decodeMessage } from './message.ts'
import type { SchemaRegistry } from './registry.ts'
import type { Catalog, StateReader } from './runtime.ts'
import { inspectAt, readCatalog } from './runtime.ts'
import { ReadView, unwrap } from './transaction.ts'
import type {
  AnyReadableLens,
  CustomFieldLens,
  FieldLens,
  FieldValueWithMeta,
  HistoricalNodeInspection,
  InferCoreOutput,
  LeafSchemaNode,
  LeafValueTypeMap,
  LensOutput,
  MapLens,
  MessagePrism,
  MessageStructSchemaNode,
  ReadonlySchemaView,
  ResolvedStateRefValue,
  SchemaDriftReport,
  TypedCommitMessage,
} from './types.ts'
import { WorldStateReader, worldResult } from './world-reader.ts'

const WRITER_CATALOG_LIMIT = 64
const SCHEMA_PATH: Path = Object.freeze(['$schemas'])

/**
 * Historical reads over World, independent of active Reader registration
 * state. Every operation receives the calling Cordis context; nothing here
 * captures a root context or World service.
 *
 * Writer catalogs are reused within a bounded cache keyed by the `$schemas`
 * directory revision, but a cache hit is still gated on the requested commit
 * existing.
 */
export class SchemaHistory {
  private readonly writerCatalogs = new Map<CommitHash, Catalog>()
  private readonly registry: SchemaRegistry

  constructor(registry: SchemaRegistry) {
    this.registry = registry
  }

  /**
   * Reuse a parsed Writer catalog only while its `$schemas` directory revision
   * matches. Check the requested commit first, even on hits, so deleted commits
   * never become readable through the cache. Missing/leaf catalogs and parse
   * failures are not cached; errors retain the requested commit's identity.
   *
   * Keep at most 64 successfully parsed revisions in insertion order. Cached
   * catalogs are read-only inputs: Reader registrations remain freshly scoped,
   * and migration/merge code builds separate mutable maps.
   */
  writerCatalog(ctx: Context, commitId: CommitHash, source?: StateReader): Catalog {
    const info = worldResult(ctx.world.getNodeInfo(commitId, SCHEMA_PATH))
    const revision =
      info.kind === 'some' && info.value.nodeKind === 'dir' ? info.value.lastModifiedAt : undefined
    const cache = this.writerCatalogs
    if (revision !== undefined) {
      const cached = cache.get(revision)
      if (cached !== undefined) return cached
    }
    const catalog = readCatalog(source ?? new WorldStateReader(ctx.world, commitId), commitId)
    if (revision !== undefined) {
      if (cache.size >= WRITER_CATALOG_LIMIT) cache.delete(cache.keys().next().value!)
      cache.set(revision, catalog)
    }
    return catalog
  }

  /**
   * Capture a fixed World commit and current Reader catalog for repeated
   * logical reads. Payloads are fetched lazily from World, not copied into a
   * full snapshot; later Reader registrations do not alter this view.
   */
  viewAt(ctx: Context, commitId: CommitHash): ReadonlySchemaView {
    const source = new WorldStateReader(ctx.world, commitId)
    return new ReadView(
      source,
      this.writerCatalog(ctx, commitId, source),
      this.registry.catalog(),
      commitId,
    ).readonlyView()
  }

  get<L extends AnyReadableLens>(
    ctx: Context,
    commitId: CommitHash,
    lens: L,
  ): Option<LensOutput<L>> {
    return unwrap(this.viewAt(ctx, commitId).get(lens))
  }

  getWithMeta<L extends LeafSchemaNode>(
    ctx: Context,
    commitId: CommitHash,
    lens: FieldLens<L> | CustomFieldLens<L>,
  ): Option<FieldValueWithMeta<LeafValueTypeMap[L['valueKind']]>> {
    return unwrap(this.viewAt(ctx, commitId).getWithMeta(lens))
  }

  /** List concrete Map member IDs in path order; a logically absent Map yields `[]`. */
  listKeys(ctx: Context, commitId: CommitHash, lens: MapLens): readonly string[] {
    return unwrap(this.viewAt(ctx, commitId).listKeys(lens))
  }

  /**
   * Inspect a logical path using the commit's Writer Schema, including dormant
   * fields and custom leaves. Returns physical history, not Reader defaults.
   */
  inspectInstance(
    ctx: Context,
    commitId: CommitHash,
    path: Path,
  ): Option<HistoricalNodeInspection> {
    const source = new WorldStateReader(ctx.world, commitId)
    return inspectAt(
      source,
      this.writerCatalog(ctx, commitId, source),
      this.registry.catalog(),
      commitId,
      path,
    )
  }

  /**
   * Read a plain string as `{ kind: '$text', data: message }`, or decode binary
   * message data with the commit's Writer catalog. Active registration is not
   * required for historical decoding.
   */
  getMessage(ctx: Context, commitId: CommitHash): TypedCommitMessage {
    const message = worldResult(ctx.world.getMessage(commitId))
    if (typeof message === 'string') return Object.freeze({ kind: '$text', data: message })
    if (!(message instanceof Uint8Array))
      throw new SchemaFailure({
        kind: 'message_decode_error',
        commitId,
        reason: 'Expected encoded message bytes or a plain string',
      })
    const writer = this.writerCatalog(ctx, commitId)
    try {
      return decodeMessage(message, (kind) => writer.messages.get(kind))
    } catch (cause) {
      if (cause instanceof SchemaFailure)
        throw new SchemaFailure({
          kind: 'message_decode_error',
          commitId,
          reason: cause.message,
        })
      throw cause
    }
  }

  /**
   * Decode with the historical Writer catalog, then validate/normalize through
   * the supplied prism. A different message kind yields `NONE`.
   */
  getMessageAs<K extends string, S extends MessageStructSchemaNode>(
    ctx: Context,
    commitId: CommitHash,
    prism: MessagePrism<K, S>,
  ): Option<InferCoreOutput<S>> {
    return unwrap(prism.parse(this.getMessage(ctx, commitId)))
  }

  /**
   * Resolve an arbitrary state reference. `$message` refs decode the commit
   * message through its stored Writer schema; `Option` wrappers are unwrapped
   * at every step. Other refs delegate to {@link inspectInstance}.
   */
  resolveRef(ctx: Context, ref: StateRef): ResolvedStateRefValue {
    const checked = cloneStateRef(ref)
    if (checked.path[0] !== '$message')
      return Object.freeze({
        targetKind: 'state_node' as const,
        inspection: this.inspectInstance(ctx, checked.commitId, checked.path),
      })
    const message = this.getMessage(ctx, checked.commitId)
    let current: unknown = message.data
    for (const segment of checked.path.slice(1)) {
      if (isOption(current)) current = current.kind === 'none' ? undefined : current.value
      if (
        current === null ||
        typeof current !== 'object' ||
        Array.isArray(current) ||
        current instanceof Uint8Array
      )
        return Object.freeze({
          targetKind: 'commit_message' as const,
          messageKind: message.kind,
          value: NONE as Option<unknown>,
        })
      if (!Object.hasOwn(current, segment))
        return Object.freeze({
          targetKind: 'commit_message' as const,
          messageKind: message.kind,
          value: NONE as Option<unknown>,
        })
      current = (current as Record<string, unknown>)[segment]
    }
    const value: Option<unknown> = isOption(current)
      ? current
      : current === undefined
        ? NONE
        : some(current)
    return Object.freeze({
      targetKind: 'commit_message' as const,
      messageKind: message.kind,
      value,
    })
  }

  /**
   * Compare the commit's stored Writer catalog with active Reader definitions.
   * Dormant definitions alone leave `isClean` true; counts are always computed.
   */
  drift(ctx: Context, commitId: CommitHash): SchemaDriftReport {
    const source = new WorldStateReader(ctx.world, commitId)
    return checkDrift(
      source,
      this.writerCatalog(ctx, commitId, source),
      this.registry.catalog(),
      commitId,
    )
  }
}
