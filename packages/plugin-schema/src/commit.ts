import type { Option, Result } from '@sekaisen/core'
import { NONE } from '@sekaisen/core'
import type {
  AdvanceHeadInput,
  CommitHash,
  CommitNode,
  StateDiff,
  Value,
} from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { SchemaFailure } from './builders.ts'
import { checkDrift, migrateState } from './evolution.ts'
import type { SchemaHistory } from './history.ts'
import { validateStateLinks } from './links.ts'
import { encodeMessage } from './message.ts'
import { DraftOverlay } from './overlay.ts'
import type { SchemaRegistry } from './registry.ts'
import type { Catalog } from './runtime.ts'
import {
  cloneCatalog,
  copyValue,
  EMPTY_STATE,
  effectiveCatalog,
  materializeDefaultNode,
  validateState,
  writeCatalog,
} from './runtime.ts'
import { ReadView, Transaction } from './transaction.ts'
import type {
  SchemaCommitOptions,
  SchemaError,
  SchemaTransaction,
  SyncSchemaOptions,
} from './types.ts'
import { validateChangedState } from './validation.ts'
import { WorldStateReader, worldResult } from './world-reader.ts'

const VALIDATED_COMMIT_LIMIT = 256

/**
 * Commit/sync orchestration over the shared registry and history roles. World
 * keeps ownership of physical commits, persistence and atomic head/CAS
 * operations. Every operation receives the calling Cordis context.
 *
 * Both public paths converge on `finish`, which validates the final draft
 * (incrementally only for retained parents under an unchanged Reader snapshot),
 * runs a snapshot of business validators in insertion order — including on
 * empty diffs — and only then publishes through World and records the commit
 * certificate for the captured Reader revision.
 */
export class SchemaCommitter {
  private readonly registry: SchemaRegistry
  private readonly history: SchemaHistory
  /** Bounded LRU certificates for Writer data under captured Reader revisions. */
  private readonly validatedCommits = new Map<CommitHash, symbol>()

  constructor(registry: SchemaRegistry, history: SchemaHistory) {
    this.registry = registry
    this.history = history
  }

  /**
   * Mutate a lazy copy-on-write draft synchronously, validate its final
   * Writer-covered state, run every registered validator and persist the net
   * diff through world with atomic head/CAS.
   */
  commit(
    ctx: Context,
    options: SchemaCommitOptions,
    mutate?: (tx: SchemaTransaction) => void | Result<void, SchemaError>,
  ): CommitNode {
    const parentId =
      options.parentId !== undefined
        ? options.parentId
        : options.head !== undefined
          ? ctx.world.getHead(typeof options.head === 'string' ? options.head : options.head.name)
          : NONE
    const commitId = parentId.kind === 'some' ? parentId.value : ('' as CommitHash)
    const before =
      parentId.kind === 'some' ? new WorldStateReader(ctx.world, parentId.value) : EMPTY_STATE
    const reader = this.registry.catalog()
    const readerRevision = this.registry.readerRevision
    const writer =
      parentId.kind === 'some'
        ? this.history.writerCatalog(ctx, parentId.value, before)
        : cloneCatalog(reader)
    const incremental =
      parentId.kind === 'some' && this.validatedCommits.get(parentId.value) === readerRevision
    if (parentId.kind === 'some' && !incremental) {
      const drift = checkDrift(before, writer, reader, parentId.value)
      if (
        drift.backfillableNodes.length ||
        drift.compatibleChanges.length ||
        drift.promotedCustomFields.length ||
        drift.incompatibilities.length
      ) {
        throw new SchemaFailure({
          kind: 'schema_drift_requires_sync',
          commitId: parentId.value,
          reason: 'Active Reader Schema differs from Writer Schema; call syncSchema first',
        })
      }
    }
    const catalog = effectiveCatalog(reader, writer, true)
    const draft = new DraftOverlay(before)
    if (parentId.kind === 'none') {
      writeCatalog(draft, reader)
      for (const root of reader.roots.values())
        materializeDefaultNode(draft, root.path, root.schema)
    }
    const tx = new Transaction(draft, catalog, reader, commitId, writer)
    try {
      const result = mutate?.(tx.asTransaction())
      if (result && typeof result === 'object' && 'then' in result)
        throw new TypeError('Schema transactions must be synchronous')
      if (result && !result.ok) throw new SchemaFailure(result.error)
    } finally {
      tx.finish()
    }
    let message: Value
    if (typeof options.message === 'string') message = options.message
    else {
      const schema = reader.messages.get(options.message.kind)
      if (!schema)
        throw new SchemaFailure({
          kind: 'validation_failed',
          path: [],
          reason: 'type_mismatch',
          detail: 'Message kind is not registered',
        })
      message = encodeMessage(options.message, schema)
    }
    return this.finish(
      ctx,
      draft,
      catalog,
      reader,
      parentId,
      message,
      readerRevision,
      incremental ? 'incremental' : 'full',
      options.head,
    )
  }

  /**
   * Synchronize the current tip of an existing head to the active Reader
   * schema. Converters read the immutable pre-migration source; all final data
   * and validators pass before World persists the net diff and advances the
   * head. Always performs final full validation.
   */
  sync(ctx: Context, options: SyncSchemaOptions): CommitNode {
    const name = typeof options.head === 'string' ? options.head : options.head.name
    const parentId = ctx.world.getHead(name)
    if (parentId.kind === 'none')
      throw new SchemaFailure({
        kind: 'world_error',
        error: { kind: 'head_not_found', headName: name },
      })
    const before = new WorldStateReader(ctx.world, parentId.value)
    const writer = this.history.writerCatalog(ctx, parentId.value, before)
    const reader = this.registry.catalog()
    const readerRevision = this.registry.readerRevision
    const migrated = migrateState(before, writer, reader, parentId.value, options)
    return this.finish(
      ctx,
      migrated.draft,
      migrated.catalog,
      reader,
      parentId,
      'syncSchema',
      readerRevision,
      'full',
      options.head,
    )
  }

  /**
   * Validate one final draft, run business rules and atomically publish it.
   * Positive records are installed only after World success, using the Reader
   * snapshot captured before callbacks/converters, validators and observers.
   */
  private finish(
    ctx: Context,
    draft: DraftOverlay,
    catalog: Catalog,
    reader: Catalog,
    parentId: Option<CommitHash>,
    message: Value,
    readerRevision: symbol,
    mode: 'full' | 'incremental',
    head?: string | AdvanceHeadInput,
  ): CommitNode {
    const commitId = parentId.kind === 'some' ? parentId.value : ('' as CommitHash)
    let diff: StateDiff
    if (mode === 'incremental') {
      diff = draft.compileDiff()
      validateChangedState(draft, catalog, commitId, diff)
    } else {
      // Unknown parents are checked after mutation, so callbacks may repair
      // malformed values. Keep their validation-before-diff error ordering.
      validateState(draft, catalog, commitId)
      diff = draft.compileDiff()
    }
    // Link semantics are re-checked on the final state regardless of the write
    // path that produced it (low-level draft writes, migrations, cascades).
    validateStateLinks(draft, catalog)
    const view = new ReadView(draft, catalog, reader, commitId).readonlyView()
    for (const validator of this.registry.validators()) {
      const exposedDiff: StateDiff = Object.freeze(
        diff.map((op) =>
          Object.freeze(
            op.op === 'set'
              ? { ...op, value: copyValue(op.value) }
              : op.op === 'ref'
                ? { ...op, ref: copyValue(op.ref) }
                : { ...op },
          ),
        ),
      )
      const result = validator({ parentId, draft: view, diff: exposedDiff })
      if (!result.ok) throw new SchemaFailure({ kind: 'validator_rejected', ...result.error })
    }
    const node = worldResult(
      ctx.world.commit({
        parentId,
        message,
        diff,
        ...(head === undefined
          ? {}
          : {
              advanceHead:
                typeof head === 'string'
                  ? { name: head, expected: parentId }
                  : { ...head, expected: head.expected ?? parentId },
            }),
      }),
    )
    // Capture the operation's Reader revision, not registrations changed by
    // callbacks, validators or World observers while this operation was active.
    const validated = this.validatedCommits
    if (mode === 'incremental' && parentId.kind === 'some') {
      validated.delete(parentId.value)
      validated.set(parentId.value, readerRevision)
    }
    validated.delete(node.id)
    if (validated.size >= VALIDATED_COMMIT_LIMIT) validated.delete(validated.keys().next().value!)
    validated.set(node.id, readerRevision)
    return node
  }
}
