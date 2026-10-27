/**
 * Fixed-commit read context and historical resolution.
 *
 * Reads capture one schema view per commit and never mutate state. The reader
 * depends only on the four public schema read operations, so it cannot reach
 * registration, commits or transaction internals.
 *
 * `SELF_COMMIT` references resolve against the current transaction/draft graph
 * supplied by the caller; every other reference uses the stored Writer catalog
 * at its own commit. That distinction is what keeps historical facts from
 * being re-interpreted through a newer Reader.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type {
  HistoricalNodeInspection,
  LeafSchemaNode,
  ReadonlySchemaView,
  ResolvedStateRefValue,
  SchemaError,
  SchemaMetaMap,
  StructLens,
} from '@sekaisen/plugin-schema'
import type { CommitHash, Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT, valueEquals } from '@sekaisen/plugin-world'
import { ClaimEvaluator } from './claims.ts'
import type { PerspectiveGraph } from './graph.ts'
import { decodePathKeySafe, PerspectiveGraph as Graph } from './graph.ts'
import { expectSchema, fail, PerspectiveFailure, valueOrRefEquals } from './internal.ts'
import type { ObserverContext, ProjectionDeps } from './projection/context.ts'
import { observerContext } from './projection/context.ts'
import type { ObserverScopeState } from './scope.ts'
import { computeObserverScope } from './scope.ts'
import type { ObserverRef } from './types.ts'

/** The public schema read capabilities perspective depends on. */
export interface SchemaReads {
  viewAt(commitId: CommitHash): Result<ReadonlySchemaView, SchemaError>
  resolveRef(ref: StateRef): Result<ResolvedStateRefValue, SchemaError>
  inspectInstance(
    commitId: CommitHash,
    nodePath: Path,
  ): Result<Option<HistoricalNodeInspection>, SchemaError>
}

/** Canonical observer identity plus concrete entity/root paths when present. */
export interface ResolvedObserver {
  readonly id: string
  /** Staged body path for entity observers. */
  readonly entity: Option<Path>
  /** Delegation root entity path for entity observers. */
  readonly rootEntity: Option<Path>
}

function metaEquals(a: SchemaMetaMap | undefined, b: SchemaMetaMap | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(
    (key) => Object.hasOwn(right, key) && valueEquals(left[key] as Value, right[key] as Value),
  )
}

/** Accept only values representable by a committed message payload. */
export function isPerspectiveValue(value: unknown): value is Value {
  if (value === null) return true
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')
    return true
  if (value instanceof Uint8Array) return true
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item === null ||
        typeof item === 'boolean' ||
        typeof item === 'number' ||
        typeof item === 'string' ||
        item instanceof Uint8Array,
    )
  )
}

/** Normalize a struct lens or explicit path to a path. */
export function observerPath(observer: StructLens | Path): Path {
  return 'opticKind' in observer ? observer.path : observer
}

/** Resolve co-witness selectors to sorted, unique public body path keys. */
export function coWitnessKeys(observers: readonly ObserverRef[] | undefined): readonly string[] {
  if (!observers) return []
  return Object.freeze(
    [
      ...new Set(
        observers.map((observer) =>
          typeof observer === 'string' ? observer : encodePathKey(observerPath(observer)),
        ),
      ),
    ].sort(),
  )
}

/** Bound, non-mutating read/observer context for one schema service. */
export class PerspectiveReader {
  private readonly schema: SchemaReads

  constructor(schema: SchemaReads) {
    this.schema = schema
  }

  /** Fixed committed graph; never a transaction-backed graph. */
  view(commitId: CommitHash): PerspectiveGraph {
    return new Graph(expectSchema(this.schema.viewAt(commitId)), true)
  }

  /**
   * Resolve observed values against their fact snapshot. SELF state references
   * read the current draft, not World's committed history. A pending message
   * remains an opaque reference until publication: relaying its anchor does
   * not invent or prematurely read a message payload.
   */
  resolveHistorical(
    graph: PerspectiveGraph,
    ref: StateRef,
  ): Option<{ value: Value | StateRef; summary: Option<string> }> {
    if (ref.commitId === SELF_COMMIT && ref.path[0] === '$message')
      return some({ value: ref, summary: NONE })
    const resolved =
      ref.commitId === SELF_COMMIT
        ? { targetKind: 'state_node' as const, inspection: graph.inspect(ref.path) }
        : expectSchema(this.schema.resolveRef(ref))
    if (resolved.targetKind === 'commit_message') {
      const value = resolved.value
      if (value.kind === 'none') return NONE
      return some({ value: isPerspectiveValue(value.value) ? value.value : ref, summary: NONE })
    }
    if (resolved.inspection.kind === 'none') return NONE
    const inspection = resolved.inspection.value
    if (inspection.nodeKind !== 'leaf') return some({ value: ref, summary: NONE })
    const summary = inspection.meta.summary
    return some({
      value: inspection.value,
      summary: typeof summary === 'string' ? some(summary) : NONE,
    })
  }

  depsFor(graph: PerspectiveGraph, commitId: CommitHash, rootId: string): ProjectionDeps {
    let historical: Map<CommitHash, PerspectiveGraph> | undefined
    return {
      graph,
      evaluator: this.evaluatorFor(graph, rootId),
      commitId,
      graphAt: (id: CommitHash) => {
        if (id === commitId) return graph
        const cached = historical?.get(id)
        if (cached !== undefined) return cached
        const snapshot = this.view(id)
        historical ??= new Map()
        historical.set(id, snapshot)
        return snapshot
      },
    }
  }

  resolveObserver(graph: PerspectiveGraph, observer: ObserverRef): ResolvedObserver {
    if (typeof observer === 'string') {
      const decoded = decodePathKeySafe(observer)
      if (decoded.kind === 'some' && graph.instance(decoded.value).kind === 'some') {
        const root = graph.delegateRoot(decoded.value)
        return { id: encodePathKey(root), entity: some(decoded.value), rootEntity: some(root) }
      }
      const record = graph.perspective(observer)
      if (record.kind === 'some' && record.value.hostEntity.kind === 'some') {
        return {
          id: observer,
          entity: some(record.value.hostEntity.value),
          rootEntity: some(record.value.hostEntity.value),
        }
      }
      return { id: observer, entity: NONE, rootEntity: NONE }
    }
    const path = observerPath(observer)
    if (graph.instance(path).kind === 'none')
      fail({ kind: 'observer_entity_not_found', observer: encodePathKey(path) })
    const root = graph.delegateRoot(path)
    return { id: encodePathKey(root), entity: some(path), rootEntity: some(root) }
  }

  evaluatorFor(graph: PerspectiveGraph, rootId: string): ClaimEvaluator {
    return new ClaimEvaluator(graph.perspectives(), rootId, (ref) =>
      this.resolveHistorical(graph, ref),
    )
  }

  /** Build observer context for projections without mutating anything. */
  contextFor(
    graph: PerspectiveGraph,
    deps: ProjectionDeps,
    observer: ResolvedObserver,
  ): ObserverContext {
    let scope: Option<ObserverScopeState> = NONE
    if (observer.entity.kind === 'some') {
      const evaluator = this.evaluatorFor(graph, observer.id)
      scope = some(computeObserverScope(graph, evaluator, observer.entity.value))
    }
    return observerContext(deps, observer.id, observer.entity, observer.rootEntity, scope)
  }

  /** Current objective leaf value and metadata, if the path is a leaf. */
  currentLeaf(
    graph: PerspectiveGraph,
    path: Path,
  ): Option<{ value: Value | StateRef; meta: SchemaMetaMap }> {
    const inspection = graph.inspect(path)
    if (inspection.kind === 'none' || inspection.value.nodeKind !== 'leaf') return NONE
    return some({ value: inspection.value.value, meta: inspection.value.meta })
  }

  /**
   * Whether a recorded fact snapshot still equals the current leaf value and
   * metadata. Historical facts are inspected through their stored Writer
   * catalog; SELF facts read the current draft.
   */
  historicalMatchesCurrent(
    graph: PerspectiveGraph,
    ref: StateRef,
    current: Option<{ value: Value | StateRef; meta: SchemaMetaMap }>,
  ): boolean {
    if (current.kind === 'none') return false
    const inspection =
      ref.commitId === SELF_COMMIT
        ? graph.inspect(ref.path)
        : expectSchema(this.schema.inspectInstance(ref.commitId, ref.path))
    if (inspection.kind === 'none') return false
    const leaf = inspection.value
    if (leaf.nodeKind !== 'leaf') return false
    return (
      valueOrRefEquals(leaf.value, current.value.value) && metaEquals(leaf.meta, current.value.meta)
    )
  }

  /**
   * Effective leaf declaration for a path: the live lens when available, else
   * the Writer-faithful inspection result. Non-leaf and absent paths yield
   * `undefined`.
   */
  leafSpecAt(graph: PerspectiveGraph, path: Path): LeafSchemaNode | undefined {
    try {
      const lens = graph.fieldLens(path)
      if (lens.kind === 'some') return lens.value.schema
    } catch (cause) {
      if (!(cause instanceof PerspectiveFailure)) throw cause
    }
    const inspection = graph.inspect(path)
    return inspection.kind === 'some' && inspection.value.nodeKind === 'leaf'
      ? inspection.value.writerSpec
      : undefined
  }
}
