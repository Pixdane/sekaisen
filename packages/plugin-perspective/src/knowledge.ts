/**
 * Claim-writing commands: observation, discovery, rumor and exclusion.
 *
 * These commands decide temporal anchors, priorities and origin chains, then
 * hand complete records to the storage writer. Reads used for classification
 * are fixed to the fact snapshot (`atCommitId`) while the write itself always
 * targets the caller's current transaction.
 */

import type { Result } from '@sekaisen/core'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import type { Path, StateRef, Value } from '@sekaisen/plugin-world'
import { encodePathKey, encodeValue, SELF_COMMIT } from '@sekaisen/plugin-world'
import { assertPersistentClaimTarget } from './claim-policy.ts'
import type { PerspectiveGraph } from './graph.ts'
import { PerspectiveGraph as Graph } from './graph.ts'
import { attemptPerspective } from './internal.ts'
import type { PerspectiveReader } from './reader.ts'
import { coWitnessKeys } from './reader.ts'
import type { ExclusionClaimInput, PerspectiveRecord, RumorClaimInput } from './schemas.ts'
import { PERSPECTIVES_ROOT } from './schemas.ts'
import { appendClaim, bumpSeq, ensurePerspective, perspectiveRecord } from './store.ts'
import type {
  ExcludeKnowledgeOptions,
  GrantKnowledgeOptions,
  GrantRumorOptions,
  ObserverRef,
  PerspectiveError,
} from './types.ts'
import { isEphemeralSpec } from './visibility.ts'

/**
 * Record a historical observation of a leaf field, or discover an instance.
 *
 * Classification and field expansion are performed against the fact view
 * selected by `options.atCommitId` (a historical commit, or the current draft
 * for `SELF_COMMIT`). A now-deleted hidden instance is therefore still
 * classified as a Struct and only its old surface fields are captured; newer
 * current fields can never leak into the grant. Current transaction state is
 * still used to resolve the observer and write the records.
 *
 * - Custom leaves use their real `[...instancePath, '$custom', key]` paths;
 *   no logical alias is invented that could fail World's SELF validation.
 * - Message targets use `['$message', ...]`. Pending SELF messages can be
 *   relayed as opaque anchors before publication; committed scalar/list
 *   payloads are resolved afterward, while structured nodes retain refs.
 * - Leaf targets are rejected with `invalid_claim_target` when their schema
 *   declares `ephemeral: true` (or its stored Writer spec did).
 * - Instance targets write a discovery record keyed by the entity path key
 *   plus one observation per non-ephemeral `'surface'` field present at the
 *   fact view.
 * - `targetRef.commitId` is `atCommitId` (default `SELF_COMMIT`);
 *   `eventRef` is `acquiredAtCommitId` (default `SELF_COMMIT`).
 * - Unless `originEventRef` is supplied, each record's origin defaults to
 *   that record's own path in the current commit, guaranteeing the origin
 *   resolves even for backfilled history.
 * - Co-witnesses are stored as public body path keys; delegation roots are
 *   never substituted.
 */
export function grantKnowledge(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  targetPath: Path,
  options?: GrantKnowledgeOptions,
): Result<void, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = new Graph(tx)
    const resolved = reader.resolveObserver(graph, observer)
    const at = options?.atCommitId ?? SELF_COMMIT
    const source = at === SELF_COMMIT ? graph : reader.view(at)
    const target = source.inspect(targetPath)

    if (target.kind === 'some' && target.value.nodeKind !== 'leaf') {
      ensurePerspective(tx, resolved.id, resolved.rootEntity)
      writeDiscovery(tx, resolved.id, perspectiveRecord(tx, resolved.id), targetPath, options)
      for (const field of surfaceFields(source, targetPath)) {
        writeObservation(tx, resolved.id, perspectiveRecord(tx, resolved.id), field.path, options)
      }
      return
    }
    assertPersistentClaimTarget(
      reader,
      source,
      targetPath,
      at === SELF_COMMIT ? 'live' : 'historical',
    )
    ensurePerspective(tx, resolved.id, resolved.rootEntity)
    writeObservation(tx, resolved.id, perspectiveRecord(tx, resolved.id), targetPath, options)
  })
}

/** Record a literal rumor/hallucination payload. */
export function grantRumor(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  targetPath: Path,
  rumorValue: Value,
  options?: GrantRumorOptions,
): Result<void, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = new Graph(tx)
    const resolved = reader.resolveObserver(graph, observer)
    assertPersistentClaimTarget(reader, graph, targetPath)
    ensurePerspective(tx, resolved.id, resolved.rootEntity)
    const record = perspectiveRecord(tx, resolved.id)
    const at = options?.atCommitId ?? options?.acquiredAtCommitId ?? SELF_COMMIT
    const acquiredAt = options?.acquiredAtCommitId ?? at
    const priority = options?.priority ?? record.defaultPriority
    const seq = record.nextSeq
    const key = `${encodePathKey(targetPath)}#${seq}`
    const origin =
      options?.originEventRef ??
      ({
        commitId: SELF_COMMIT,
        path: [...PERSPECTIVES_ROOT, resolved.id, 'rumorClaims', key],
      } as StateRef)
    const input: RumorClaimInput = {
      seq,
      targetPathKey: encodePathKey(targetPath),
      factEventRef: { commitId: at, path: ['$message'] },
      eventRef: { commitId: acquiredAt, path: ['$message'] },
      originEventRef: origin,
      encodedValue: encodeValue(rumorValue),
      priority,
      override: options?.override ?? false,
      belief: options?.belief ?? 'suspected',
      coWitnesses: coWitnessKeys(options?.coWitnesses),
      ...(options?.rumorSummary !== undefined ? { rumorSummary: options.rumorSummary } : {}),
      ...(options?.source !== undefined ? { source: options.source } : {}),
    }
    appendClaim(tx, resolved.id, 'rumorClaims', key, input)
    bumpSeq(tx, resolved.id, seq + 1)
  })
}

/**
 * Add a path-prefix exclusion inside a transaction.
 *
 * `[]` names the entire tree. Priority and inheritance ordering still apply:
 * stronger literal claims may survive, but they cannot revive live access
 * removed by the exclusion.
 */
export function excludeKnowledge(
  reader: PerspectiveReader,
  tx: SchemaTransaction,
  observer: ObserverRef,
  targetPath: Path,
  options?: ExcludeKnowledgeOptions,
): Result<void, PerspectiveError> {
  return attemptPerspective(() => {
    const graph = new Graph(tx)
    const resolved = reader.resolveObserver(graph, observer)
    ensurePerspective(tx, resolved.id, resolved.rootEntity)
    const record = perspectiveRecord(tx, resolved.id)
    const seq = record.nextSeq
    const key = `${encodePathKey(targetPath)}#${seq}`
    const input: ExclusionClaimInput = {
      seq,
      targetPathKey: encodePathKey(targetPath),
      eventRef: { commitId: options?.atCommitId ?? SELF_COMMIT, path: ['$message'] },
      priority: options?.priority ?? record.defaultPriority,
    }
    appendClaim(tx, resolved.id, 'exclusions', key, input)
    bumpSeq(tx, resolved.id, seq + 1)
  })
}

function writeDiscovery(
  tx: SchemaTransaction,
  id: string,
  record: PerspectiveRecord,
  entityPath: Path,
  options?: GrantKnowledgeOptions,
): void {
  const at = options?.atCommitId ?? SELF_COMMIT
  const acquiredAt = options?.acquiredAtCommitId ?? SELF_COMMIT
  const key = encodePathKey(entityPath)
  const seq = record.nextSeq
  const origin =
    options?.originEventRef ??
    ({
      commitId: SELF_COMMIT,
      path: [...PERSPECTIVES_ROOT, id, 'discoveredEntities', key],
    } as StateRef)
  appendClaim(tx, id, 'discoveredEntities', key, {
    seq,
    targetRef: { commitId: at, path: entityPath },
    eventRef: { commitId: acquiredAt, path: ['$message'] },
    originEventRef: origin,
    priority: options?.priority ?? record.defaultPriority,
    override: options?.override ?? true,
    belief: options?.belief ?? 'believed',
    coWitnesses: coWitnessKeys(options?.coWitnesses),
    ...(options?.source !== undefined ? { source: options.source } : {}),
  })
  bumpSeq(tx, id, seq + 1)
}

function writeObservation(
  tx: SchemaTransaction,
  id: string,
  record: PerspectiveRecord,
  targetPath: Path,
  options?: GrantKnowledgeOptions,
): void {
  const at = options?.atCommitId ?? SELF_COMMIT
  const acquiredAt = options?.acquiredAtCommitId ?? SELF_COMMIT
  const seq = record.nextSeq
  const key = `${encodePathKey(targetPath)}#${seq}`
  const origin =
    options?.originEventRef ??
    ({
      commitId: SELF_COMMIT,
      path: [...PERSPECTIVES_ROOT, id, 'observedClaims', key],
    } as StateRef)
  appendClaim(tx, id, 'observedClaims', key, {
    seq,
    targetRef: { commitId: at, path: targetPath },
    eventRef: { commitId: acquiredAt, path: ['$message'] },
    originEventRef: origin,
    priority: options?.priority ?? record.defaultPriority,
    override: options?.override ?? true,
    belief: options?.belief ?? 'believed',
    coWitnesses: coWitnessKeys(options?.coWitnesses),
    ...(options?.source !== undefined ? { source: options.source } : {}),
  })
  bumpSeq(tx, id, seq + 1)
}

function surfaceFields(graph: PerspectiveGraph, instancePath: Path): readonly { path: Path }[] {
  const instance = graph.instance(instancePath)
  if (instance.kind === 'none') return []
  return [...instance.value.fields.values()]
    .filter((field) => graph.fieldVisibility(field) === 'surface')
    .filter((field) => !isEphemeralSpec(field.spec))
    .filter((field) => field.value.kind === 'some')
}
