import type { Option, Result } from '@sekaisen/core'
import { InvariantError } from '@sekaisen/core'
import type { CommitHash, CommitNode, Path, StateRef } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { SchemaCommitter } from './commit.ts'
import { SchemaHistory } from './history.ts'
import { SchemaRegistry } from './registry.ts'
import { attempt } from './transaction.ts'
import type {
  AnyReadableLens,
  CommitValidatorFn,
  ContainerPresence,
  CustomFieldLens,
  FieldLens,
  FieldValueWithMeta,
  HistoricalNodeInspection,
  InferCoreOutput,
  LeafSchemaNode,
  LeafValueTypeMap,
  LensFor,
  LensOutput,
  MapLens,
  MessagePrism,
  MessageStructSchemaNode,
  ReadonlySchemaView,
  ResolvedStateRefValue,
  SchemaCommitOptions,
  SchemaDriftReport,
  SchemaError,
  SchemaFieldsOf,
  SchemaNode,
  SchemaTransaction,
  StructLens,
  SyncSchemaOptions,
  TypedCommitMessage,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    schema: SchemaService
  }
}

/**
 * Scoped Reader schemas, typed logical access and explicit evolution over
 * `ctx.world`. Definitions, message kinds and validators follow the calling
 * Cordis scope's lifetime; historical Writer catalogs remain in commits.
 *
 * Successfully parsed Writer catalogs are reused in a bounded cache keyed by
 * the `$schemas` subtree revision, independently of active Reader registrations.
 * Cache hits still require the requested World commit to exist and never
 * certify physical data by themselves. A separate bounded record of successful
 * schema commits enables incremental checks only for an unchanged Reader
 * registration snapshot; unknown parents and `syncSchema` receive full checks.
 * Registered business validators always run, including on empty diffs.
 *
 * Structural and business-rule checks protect schema commit/sync operations,
 * not direct world writes, rebases or head changes. Expected schema failures
 * return `Err`; unrelated callback exceptions and reentrant writes throw.
 */
export class SchemaService extends Service {
  /** World owns physical commits, persistence and atomic head/CAS operations. */
  static inject = ['world']
  private readonly registry: SchemaRegistry
  private readonly history: SchemaHistory
  private readonly committer: SchemaCommitter
  private busy = false
  /**
   * Attach `ctx.schema` to a context with an existing `ctx.world` service.
   * @throws Error if the world dependency is missing.
   */
  constructor(ctx: Context) {
    if (!ctx.world) throw new Error('SchemaService requires ctx.world')
    super(ctx, 'schema')
    this.registry = new SchemaRegistry()
    this.history = new SchemaHistory(this.registry)
    this.committer = new SchemaCommitter(this.registry, this.history)
  }
  /**
   * Register a copied Reader root and return a typed, scoped lens. A root path
   * must be non-empty, use valid identifiers and not overlap another active root.
   * Registration does not persist a commit. Scope disposal unregisters the
   * Reader definition without deleting the historical Writer data.
   * @see LensFor
   */
  define<S extends SchemaNode>(path: Path, node: S): Result<LensFor<S>, SchemaError> {
    return attempt(() => this.registry.define(this.ctx, path, node))
  }
  /**
   * Register non-required extra fields for an active struct schema and return
   * a lens owning the target's base and extra fields. The original lens keeps
   * its narrower scope. Targets under `Map.at(id)` apply to every Map entry.
   * The augmentation is unregistered when its calling Cordis scope is disposed.
   * @see StructLens
   */
  augment<
    TBase extends Readonly<Record<string, SchemaNode>>,
    TCustom extends boolean,
    TPresence extends ContainerPresence,
    TExtra extends Readonly<Record<string, SchemaNode>>,
  >(
    target: StructLens<TBase, TCustom, TPresence>,
    extraFields: TExtra,
  ): Result<StructLens<SchemaFieldsOf<TBase & TExtra>, TCustom, TPresence>, SchemaError> {
    return attempt(() => this.registry.augment(this.ctx, target, extraFields))
  }
  /**
   * Register a unique message kind in the calling scope. Message schemas cannot
   * contain references or extensible structs. The returned prism creates and
   * parses payloads; stored Writer catalogs allow decoding after plugin unload.
   * @see MessagePrism
   */
  defineMessage<K extends string, S extends MessageStructSchemaNode>(
    kind: K,
    node: S,
  ): Result<MessagePrism<K, S>, SchemaError> {
    return attempt(() => this.registry.defineMessage(this.ctx, kind, node))
  }
  /**
   * Register a synchronous business rule over the final, structurally validated
   * draft. Both `commit` and `syncSchema` invoke a snapshot of registrations in
   * insertion order before calling world; the first rejection aborts the call
   * with `validator_rejected`, without its commit or head update being persisted.
   *
   * Rules must return `ok(undefined)` or
   * `err({ path, validatorName, reason })`, not `Err<SchemaError>` from a read.
   * Ordinary exceptions propagate. Callbacks should be side-effect-free:
   * rejection cannot undo external effects or direct world operations.
   * Reads, `world.commit` and `world.rebase` do not execute these rules.
   *
   * @param validator Rule receiving the parent, read-only final draft and copied physical diff.
   * @returns A disposer for this independent registration. Calling-scope disposal also unregisters it.
   * @see CommitValidatorFn
   * @example
   * ```ts
   * import { err, ok } from '@sekaisen/core'
   * import type { FieldLens, LeafSchemaNode } from '@sekaisen/plugin-schema'
   * import { SchemaService } from '@sekaisen/plugin-schema'
   *
   * export function registerNonNegativeHp(
   *   schema: SchemaService,
   *   hp: FieldLens<LeafSchemaNode<'num'>>,
   * ): () => void {
   *   return schema.addCommitValidator(({ draft }) => {
   *     const current = draft.get(hp)
   *     if (!current.ok) {
   *       return err({
   *         path: hp.path,
   *         validatorName: 'nonNegativeHp',
   *         reason: current.error.kind,
   *       })
   *     }
   *     return current.value.kind === 'some' && current.value.value < 0
   *       ? err({
   *           path: hp.path,
   *           validatorName: 'nonNegativeHp',
   *           reason: 'hp must be non-negative',
   *         })
   *       : ok(undefined)
   *   })
   * }
   * ```
   */
  addCommitValidator(validator: CommitValidatorFn): () => void {
    return this.registry.addCommitValidator(this.ctx, validator)
  }
  /**
   * Capture a fixed World commit and current Reader catalog for repeated logical
   * reads. Payloads are fetched lazily from World, not copied into a full snapshot.
   * Reader defaults may be virtual; later registrations do not alter this view.
   * The backing World commit and storage must remain available for later reads.
   * @see ReadonlySchemaView
   */
  viewAt(commitId: CommitHash): Result<ReadonlySchemaView, SchemaError> {
    return attempt(() => this.history.viewAt(this.ctx, commitId))
  }
  /**
   * Read a lens through the current Reader schema. Optional ancestor/member
   * absence returns `ok(NONE)`; invalid commits, incompatible kinds, missing
   * required nodes and detected Writer corruption return structured errors.
   * Reads load the Writer catalog and requested subtree, not the entire world.
   * @see ReadonlySchemaView.get
   */
  get<L extends AnyReadableLens>(
    commitId: CommitHash,
    lens: L,
  ): Result<Option<LensOutput<L>>, SchemaError> {
    return attempt(() => this.history.get(this.ctx, commitId, lens))
  }
  /**
   * Read a copied leaf value with its instance metadata and effective spec.
   * Absent leaves return `NONE`; virtual default values have empty metadata.
   * @see ReadonlySchemaView.getWithMeta
   */
  getWithMeta<L extends LeafSchemaNode>(
    commitId: CommitHash,
    lens: FieldLens<L> | CustomFieldLens<L>,
  ): Result<Option<FieldValueWithMeta<LeafValueTypeMap[L['valueKind']]>>, SchemaError> {
    return attempt(() => this.history.getWithMeta(this.ctx, commitId, lens))
  }
  /**
   * List concrete Map member IDs in path order; a logically absent Map yields `[]`.
   * As with a Map read, member values are still read and validated before listing.
   */
  listKeys(commitId: CommitHash, lens: MapLens): Result<readonly string[], SchemaError> {
    return attempt(() => this.history.listKeys(this.ctx, commitId, lens))
  }
  /**
   * Inspect a logical path using the commit's Writer Schema, including dormant
   * fields and custom leaves. This returns physical history rather than
   * synthesized Reader defaults; absent or undeclared paths yield `NONE`.
   */
  inspectInstance(
    commitId: CommitHash,
    path: Path,
  ): Result<Option<HistoricalNodeInspection>, SchemaError> {
    return attempt(() => this.history.inspectInstance(this.ctx, commitId, path))
  }
  /**
   * Read a plain string as `{ kind: '$text', data: message }`, or decode binary
   * message data with the commit's Writer catalog. Active registration is not
   * required for historical decoding; malformed encodings return
   * `message_decode_error`.
   * Only the message and Writer catalog are loaded, not unrelated state payloads.
   */
  getMessage(commitId: CommitHash): Result<TypedCommitMessage, SchemaError> {
    return attempt(() => this.history.getMessage(this.ctx, commitId))
  }
  /**
   * Decode with the historical Writer catalog, then validate/normalize through
   * the supplied prism. A different message kind yields `ok(NONE)`; a matching
   * kind must satisfy the prism's schema, which may differ from the Writer's.
   */
  getMessageAs<K extends string, S extends MessageStructSchemaNode>(
    commitId: CommitHash,
    prism: MessagePrism<K, S>,
  ): Result<Option<InferCoreOutput<S>>, SchemaError> {
    return attempt(() => this.history.getMessageAs(this.ctx, commitId, prism))
  }
  /**
   * Resolve an arbitrary state reference.
   *
   * `$message` refs decode the commit message through its stored Writer schema
   * and walk the remaining segments through the payload. `Option` wrappers are
   * transparently unwrapped at every step, so refs can address nested optional
   * fields directly; a missing segment yields `ok(... value: NONE)` rather than
   * an error. All other refs delegate to {@link inspectInstance}, which is
   * Writer-faithful and therefore unaffected by later mutation or deletion.
   *
   * @param ref Caller-supplied reference; copied before use.
   * @returns `state_node` or `commit_message` discriminated result.
   * @remarks Invalid refs and unreadable commits return structured failures.
   */
  resolveRef(ref: StateRef): Result<ResolvedStateRefValue, SchemaError> {
    return attempt(() => this.history.resolveRef(this.ctx, ref))
  }
  private write<T>(fn: () => T): Result<T, SchemaError> {
    if (this.busy) throw new InvariantError('Reentrant schema write operation')
    this.busy = true
    try {
      return attempt(fn)
    } finally {
      this.busy = false
    }
  }
  /**
   * Mutate a lazy copy-on-write draft synchronously, validate its final
   * Writer-covered state, run every registered validator and persist the net
   * diff through world with atomic head/CAS. No full World snapshot is copied.
   * Active Reader/Writer drift requires `syncSchema`; dormant-only differences
   * are retained. The transaction's mutation methods close when `mutate` exits.
   *
   * @param options Parent selection, optional head advancement and plain/typed message.
   * @param mutate Optional synchronous callback; return `Err<SchemaError>` to reject.
   * @returns The physical world commit, or a structured schema/validator/world failure.
   * @remarks Rejection creates no commit/head update for this operation, but cannot
   * undo callback side effects or direct world writes. Expected schema failures
   * thrown by mutators become `Err`; other exceptions propagate.
   * A retained, validated parent under the same Reader registration snapshot
   * reuses its drift preflight and validates changed branches plus ancestor
   * structure; unchanged Writer data is trusted. Unknown/unretained parents or
   * changed Reader registrations receive final full validation after `mutate`.
   * Reader definitions changed inside callbacks, validators or observers cannot
   * certify the output for that newer registration snapshot.
   * Restoring physical values and metadata exactly produces no diff operations.
   * Draft/read-only views require the backing World storage to remain available.
   * @throws TypeError if the callback returns a Promise/thenable.
   * @throws InvariantError if called reentrantly during a schema write or validator.
   * @see SchemaCommitOptions
   * @see CommitValidatorFn
   */
  commit(
    options: SchemaCommitOptions,
    mutate?: (tx: SchemaTransaction) => void | Result<void, SchemaError>,
  ): Result<CommitNode, SchemaError> {
    return this.write(() => this.committer.commit(this.ctx, options, mutate))
  }
  /**
   * Compare the commit's stored Writer catalog with active Reader definitions
   * without writing data. Dormant definitions alone leave `isClean` true.
   * Always computes the report, including concrete instance counts; validated
   * commit records only elide the internal unchanged-Reader commit preflight.
   * @see SchemaDriftReport
   */
  checkDrift(commitId: CommitHash): Result<SchemaDriftReport, SchemaError> {
    return attempt(() => this.history.drift(this.ctx, commitId))
  }
  /**
   * Synchronize the current tip of an existing head to the active Reader schema.
   * Backfills, promotions, supplied migrations and optional pruning build a
   * copy-on-write draft; every converter reads the immutable pre-migration
   * source, never another converter's output. All final Writer-covered data and
   * registered validators must pass before world atomically persists the net
   * `syncSchema` diff and advances the head with CAS.
   * This always performs final full validation, regardless of parent records.
   *
   * @param options Head/expectation, dormant policy (default `keep`) and per-schema converters.
   * @returns The sync commit, or a structured drift/migration/validator/world failure.
   * @remarks Missing heads fail; incompatible existing instances need converters.
   * Failure persists no commit/head update for this call. Converter/validator
   * side effects are not rolled back, and unrelated thrown exceptions propagate.
   * @throws InvariantError if called reentrantly during another schema write.
   * @see SyncSchemaOptions
   * @see CommitValidatorFn
   */
  syncSchema(options: SyncSchemaOptions): Result<CommitNode, SchemaError> {
    return this.write(() => this.committer.sync(this.ctx, options))
  }
}
