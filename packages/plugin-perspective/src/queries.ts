/**
 * Read-only query orchestration.
 *
 * Every query captures one committed graph and resolves the observer against
 * it. No query materializes a perspective or writes a claim. The observer
 * facade is the only restricted capability surface and intentionally exposes
 * neither adjudication nor any mutating method.
 */

import type { Result } from '@sekaisen/core'
import type { StructLens } from '@sekaisen/plugin-schema'
import type { CommitHash, Path } from '@sekaisen/plugin-world'
import { attemptPerspective, fail } from './internal.ts'
import { buildCorpus } from './projection/corpus.ts'
import { adjudicatePaths, inspectPaths } from './projection/inspect.ts'
import { buildProjection, buildPublicProjection } from './projection/views.ts'
import type { PerspectiveReader } from './reader.ts'
import { observerPath } from './reader.ts'
import { ALL_PERSPECTIVE_ID } from './schemas.ts'
import type {
  AdjudicatedPathResult,
  AgentWorldProjection,
  InspectedFieldView,
  ObserverRef,
  PerspectiveError,
  ScenePublicProjection,
  ScopedObserverPerspective,
  SearchableCorpusEntry,
} from './types.ts'

/**
 * Resolve an observer to its canonical root perspective id.
 *
 * Entity observers follow `'delegate'` links to the root body; named
 * perspective ids are returned unchanged.
 */
export function resolveRootPerspective(
  reader: PerspectiveReader,
  commitId: CommitHash,
  observer: ObserverRef,
): Result<string, PerspectiveError> {
  return attemptPerspective(() => reader.resolveObserver(reader.view(commitId), observer).id)
}

/**
 * Host-only raw standard public surface rooted at `sceneRoot`.
 *
 * This bypasses observer memory and divergence checks and is therefore NOT
 * an agent-safe projection: it must never be handed to a restricted
 * character agent when its own view diverges (blind/deaf, split ceilings,
 * super-priority exclusion or hallucination). Use {@link projectView} for
 * agents and this method for tools, UI inspection or shared-prefix tooling
 * only when the caller independently knows the raw surface is appropriate.
 * Publicly-visible link fields are emitted as their encoded pointer strings,
 * never dereferenced into hidden endpoint state.
 */
export function projectScopePublic(
  reader: PerspectiveReader,
  commitId: CommitHash,
  sceneRoot: StructLens | Path,
): Result<ScenePublicProjection, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = reader.view(commitId)
    return buildPublicProjection(
      reader.depsFor(graph, commitId, ALL_PERSPECTIVE_ID),
      observerPath(sceneRoot),
    )
  })
}

/** Build a safe agent projection for one observer. */
export function projectView(
  reader: PerspectiveReader,
  commitId: CommitHash,
  observer: ObserverRef,
): Result<AgentWorldProjection, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = reader.view(commitId)
    const resolved = reader.resolveObserver(graph, observer)
    const deps = reader.depsFor(graph, commitId, resolved.id)
    const ctx = reader.contextFor(graph, deps, resolved)
    return buildProjection(deps, ctx)
  })
}

/** Fully expand requested field/instance paths. */
export function inspect(
  reader: PerspectiveReader,
  commitId: CommitHash,
  observer: ObserverRef,
  targetPaths: readonly Path[],
): Result<readonly InspectedFieldView[], PerspectiveError> {
  return attemptPerspective(() => {
    const graph = reader.view(commitId)
    const resolved = reader.resolveObserver(graph, observer)
    const deps = reader.depsFor(graph, commitId, resolved.id)
    const ctx = reader.contextFor(graph, deps, resolved)
    return inspectPaths(deps, ctx, targetPaths, (path) =>
      fail({ kind: 'not_authorized', rootPerspectiveId: resolved.id, targetPath: path }),
    )
  })
}

/**
 * Host-only subjective/objective comparison for adjudication.
 *
 * The objective half reads the current commit through schema inspection, so
 * this API must only be exposed to Scene/World adjudicators and never to a
 * restricted character tool closure. `matchesObjectiveTruth` compares the
 * observer's primary value with the objective leaf value; an unauthorized or
 * missing subjective facet yields `false`. The method is read-only and does
 * not reveal the objective value through `inspect`/`projectView`.
 */
export function inspectForAdjudication(
  reader: PerspectiveReader,
  commitId: CommitHash,
  observer: ObserverRef,
  targetPaths: readonly Path[],
): Result<readonly AdjudicatedPathResult[], PerspectiveError> {
  return attemptPerspective(() => {
    const graph = reader.view(commitId)
    const resolved = reader.resolveObserver(graph, observer)
    const deps = reader.depsFor(graph, commitId, resolved.id)
    const ctx = reader.contextFor(graph, deps, resolved)
    return adjudicatePaths(deps, ctx, targetPaths)
  })
}

/** Pre-filtered legal retrieval corpus. */
export function listSearchableCorpus(
  reader: PerspectiveReader,
  commitId: CommitHash,
  observer: ObserverRef,
): Result<readonly SearchableCorpusEntry[], PerspectiveError> {
  return attemptPerspective(() => {
    const graph = reader.view(commitId)
    const resolved = reader.resolveObserver(graph, observer)
    const deps = reader.depsFor(graph, commitId, resolved.id)
    const ctx = reader.contextFor(graph, deps, resolved)
    return buildCorpus(deps, ctx)
  })
}

/**
 * Read-only capability facade locked to one observer and commit.
 *
 * Methods close over an owned, frozen observer path (or immutable string),
 * retaining delegated-body perception while rejecting both mutable-input
 * aliasing and identity spoofing through `fn.call(other)`. The facade exposes
 * only `projectView`, `inspect` and `listSearchableCorpus`; it never exposes
 * adjudication, mutations, the world or the schema. All methods remain pure:
 * they create no perspective nodes and never advance heads.
 */
export function asObserver(
  reader: PerspectiveReader,
  commitId: CommitHash,
  observer: ObserverRef,
): Result<ScopedObserverPerspective, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = reader.view(commitId)
    const boundObserver =
      typeof observer === 'string' ? observer : Object.freeze([...observerPath(observer)])
    const resolved = reader.resolveObserver(graph, boundObserver)
    const facade: ScopedObserverPerspective = Object.freeze({
      commitId,
      rootPerspectiveId: resolved.id,
      projectView: () => projectView(reader, commitId, boundObserver),
      inspect: (paths: readonly Path[]) => inspect(reader, commitId, boundObserver, paths),
      listSearchableCorpus: () => listSearchableCorpus(reader, commitId, boundObserver),
    })
    return facade
  })
}
