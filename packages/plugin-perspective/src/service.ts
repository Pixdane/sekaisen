/**
 * `ctx.perspective`: the Cordis service owning the epistemic layer.
 *
 * Design boundaries:
 * - All structure is registered through `ctx.schema` (`define` plus the
 *   perspective commit validator); no private schema internals are imported.
 * - Every mutation requires a `SchemaTransaction`, so CAS, net-disappearance
 *   cascades and final validation remain schema-owned.
 * - Every read is pure and fixed to one commit; reads never materialize minds
 *   and never advance heads.
 * - The `asObserver` facade captures an immutable observer identity so callers
 *   cannot spoof it through `this` or mutate an input path after creation.
 *
 * Domain work lives in ordinary internal modules: `reader` (fixed-commit reads
 * and historical resolution), `store` (claim storage), `configure`,
 * `knowledge`, `propagate`, `sync`, `transfer` and `queries`. This class is the
 * Cordis façade plus registration; it owns no algorithms of its own.
 */

import type { Result } from '@sekaisen/core'
import type { SchemaTransaction, StructLens } from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path, Value } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { configurePerspective as configure } from './configure.ts'
import {
  excludeKnowledge as exclude,
  grantKnowledge as grant,
  grantRumor as rumor,
} from './knowledge.ts'
import { propagateKnowledge as propagate } from './propagate.ts'
import {
  inspectForAdjudication as adjudicate,
  listSearchableCorpus as corpus,
  inspect as inspectObserver,
  asObserver as observe,
  projectView as projectObserver,
  projectScopePublic as publicScene,
  resolveRootPerspective as resolveRoot,
} from './queries.ts'
import { PerspectiveReader } from './reader.ts'
import { PERSPECTIVES_ROOT, PerspectiveNodeSchema } from './schemas.ts'
import { syncScope as synchronize } from './sync.ts'
import { validatePerspectiveTopology } from './topology.ts'
import { activateDelegate as activate } from './transfer.ts'
import type {
  ActivateDelegateOptions,
  AdjudicatedPathResult,
  AgentWorldProjection,
  ConfigurePerspectiveInput,
  ExcludeKnowledgeOptions,
  GrantKnowledgeOptions,
  GrantRumorOptions,
  InspectedFieldView,
  ObserverRef,
  PerspectiveError,
  PerspectiveServiceApi,
  PropagateKnowledgeOptions,
  ScenePublicProjection,
  ScopedObserverPerspective,
  SearchableCorpusEntry,
  SyncScopeOptions,
} from './types.ts'

declare module 'cordis' {
  interface Context {
    perspective: PerspectiveService
  }
}

/**
 * Perspective service. Construct after `ctx.world` and `ctx.schema` exist.
 *
 * The constructor registers the `['perspectives']` Map root and the topology
 * commit validator in the calling Cordis scope. Root registration writes no
 * commit, so it is safe before the first world transition.
 */
export class PerspectiveService extends Service implements PerspectiveServiceApi {
  /** Schema and world are hard dependencies. */
  static inject = ['world', 'schema']

  private readonly reader: PerspectiveReader

  constructor(ctx: Context) {
    if (!ctx.schema) throw new Error('PerspectiveService requires ctx.schema')
    super(ctx, 'perspective')
    const definition = ctx.schema.define(PERSPECTIVES_ROOT, s.map(PerspectiveNodeSchema))
    if (!definition.ok)
      throw new Error(
        `PerspectiveService failed to register perspectives: ${definition.error.kind}`,
      )
    ctx.schema.addCommitValidator(({ draft }) => validatePerspectiveTopology(draft))
    this.reader = new PerspectiveReader({
      viewAt: (commitId) => this.ctx.schema.viewAt(commitId),
      resolveRef: (ref) => this.ctx.schema.resolveRef(ref),
      inspectInstance: (commitId, path) => this.ctx.schema.inspectInstance(commitId, path),
    })
  }

  /** Resolve an observer to its canonical root perspective id. */
  resolveRootPerspective(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<string, PerspectiveError> {
    return resolveRoot(this.reader, commitId, observer)
  }

  /** Materialize/update one perspective node inside a transaction. */
  configurePerspective(
    tx: SchemaTransaction,
    observer: ObserverRef,
    config: ConfigurePerspectiveInput,
  ): Result<void, PerspectiveError> {
    return configure(this.reader, tx, observer, config)
  }

  /** Record a historical observation of a leaf field, or discover an instance. */
  grantKnowledge(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    options?: GrantKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return grant(this.reader, tx, observer, targetPath, options)
  }

  /** Record a literal rumor/hallucination payload. */
  grantRumor(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    rumorValue: Value,
    options?: GrantRumorOptions,
  ): Result<void, PerspectiveError> {
    return rumor(this.reader, tx, observer, targetPath, rumorValue, options)
  }

  /** Copy the sender's current subjective facet to another observer. */
  propagateKnowledge(
    tx: SchemaTransaction,
    fromObserver: ObserverRef,
    toObserver: ObserverRef,
    targetPath: Path,
    options?: PropagateKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return propagate(this.reader, tx, fromObserver, toObserver, targetPath, options)
  }

  /** Add a path-prefix exclusion inside a transaction. */
  excludeKnowledge(
    tx: SchemaTransaction,
    observer: ObserverRef,
    targetPath: Path,
    options?: ExcludeKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return exclude(this.reader, tx, observer, targetPath, options)
  }

  /** Refresh persistent surface memories for observers in a scene subtree. */
  syncScope(
    tx: SchemaTransaction,
    sceneRoot: StructLens | Path,
    options?: SyncScopeOptions,
  ): Result<void, PerspectiveError> {
    return synchronize(this.reader, tx, sceneRoot, options)
  }

  /** Move a controlled body: location, followed children and shared fields. */
  activateDelegate(
    tx: SchemaTransaction,
    fromInstanceLens: StructLens,
    toInstanceLens: StructLens,
    options?: ActivateDelegateOptions,
  ): Result<void, PerspectiveError> {
    return activate(tx, fromInstanceLens, toInstanceLens, options)
  }

  /** Host-only raw standard public surface rooted at `sceneRoot`. */
  projectScopePublic(
    commitId: CommitHash,
    sceneRoot: StructLens | Path,
  ): Result<ScenePublicProjection, PerspectiveError> {
    return publicScene(this.reader, commitId, sceneRoot)
  }

  /** Build a safe agent projection for one observer. */
  projectView(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<AgentWorldProjection, PerspectiveError> {
    return projectObserver(this.reader, commitId, observer)
  }

  /** Fully expand requested field/instance paths. */
  inspect(
    commitId: CommitHash,
    observer: ObserverRef,
    targetPaths: readonly Path[],
  ): Result<readonly InspectedFieldView[], PerspectiveError> {
    return inspectObserver(this.reader, commitId, observer, targetPaths)
  }

  /** Host-only subjective/objective comparison for adjudication. */
  inspectForAdjudication(
    commitId: CommitHash,
    observer: ObserverRef,
    targetPaths: readonly Path[],
  ): Result<readonly AdjudicatedPathResult[], PerspectiveError> {
    return adjudicate(this.reader, commitId, observer, targetPaths)
  }

  /** Pre-filtered legal retrieval corpus. */
  listSearchableCorpus(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<readonly SearchableCorpusEntry[], PerspectiveError> {
    return corpus(this.reader, commitId, observer)
  }

  /** Read-only capability facade locked to one observer and commit. */
  asObserver(
    commitId: CommitHash,
    observer: ObserverRef,
  ): Result<ScopedObserverPerspective, PerspectiveError> {
    return observe(this.reader, commitId, observer)
  }
}
