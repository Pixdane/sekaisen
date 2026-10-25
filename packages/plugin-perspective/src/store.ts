/**
 * Perspective storage writer.
 *
 * This module owns only the physical shape of `['perspectives']` writes:
 * materialization, claim collection maps and the per-perspective sequence.
 * Claim policy (timestamps, priorities, origin defaults, evidence) is decided
 * by the command modules and passed in as a complete claim input.
 */

import type { Option } from '@sekaisen/core'
import type { MapLens, SchemaTransaction } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveGraph as Graph } from './graph.ts'
import { expectSchema, fail } from './internal.ts'
import { fieldLensAt, structLensAt } from './lenses.ts'
import type {
  CognitiveMemoryInput,
  ExclusionClaimInput,
  ObservedClaimInput,
  PerspectiveRecord,
  RumorClaimInput,
} from './schemas.ts'
import { DEFAULT_PERSPECTIVE_PRIORITY, PERSPECTIVES_ROOT } from './schemas.ts'

/** Current record, falling back to the virtual empty record. */
export function perspectiveRecord(tx: SchemaTransaction, id: string): PerspectiveRecord {
  return new Graph(tx).perspectiveOrDefault(id)
}

/**
 * Materialize a perspective node when missing.
 *
 * Host binding is written only for entity observers; named perspectives keep
 * an absent optional `hostEntity`.
 */
export function ensurePerspective(
  tx: SchemaTransaction,
  id: string,
  hostEntity: Option<Path>,
): void {
  const graph = new Graph(tx)
  if (graph.perspective(id).kind === 'some') return
  const map = graph.mapLens(PERSPECTIVES_ROOT)
  if (map.kind === 'none')
    fail({
      kind: 'schema_error',
      error: {
        kind: 'validation_failed',
        path: PERSPECTIVES_ROOT,
        reason: 'type_mismatch',
        detail: 'perspectives root is not a Map',
      },
    })
  const current = expectSchema(tx.get(map.value))
  const entries = current.kind === 'some' ? current.value : {}
  const input: Record<string, unknown> = {
    description: '',
    defaultPriority: DEFAULT_PERSPECTIVE_PRIORITY,
    inherits: [],
    nextSeq: 1,
    discoveredEntities: {},
    observedClaims: {},
    rumorClaims: {},
    exclusions: {},
    memories: {},
  }
  if (hostEntity.kind === 'some') input.hostEntity = encodePathKey(hostEntity.value)
  tx.set(map.value, { ...entries, [id]: input })
}

function claimMap(tx: SchemaTransaction, id: string, field: string): MapLens {
  const entry = structLensAt(tx, [...PERSPECTIVES_ROOT, id])
  const lens = entry.field(field)
  if (lens.opticKind !== 'map')
    fail({
      kind: 'schema_error',
      error: {
        kind: 'validation_failed',
        path: [...PERSPECTIVES_ROOT, id, field],
        reason: 'type_mismatch',
        detail: 'claim collection is not a Map',
      },
    })
  return lens
}

/** Append one claim record under its deterministic key. */
export function appendClaim(
  tx: SchemaTransaction,
  id: string,
  field: 'observedClaims' | 'discoveredEntities' | 'rumorClaims' | 'exclusions',
  key: string,
  input: ObservedClaimInput | RumorClaimInput | ExclusionClaimInput,
): void {
  const map = claimMap(tx, id, field)
  const current = expectSchema(tx.get(map))
  const entries = current.kind === 'some' ? current.value : {}
  tx.set(map, { ...entries, [key]: input })
}

/** Advance the per-perspective write sequence. */
export function bumpSeq(tx: SchemaTransaction, id: string, next: number): void {
  tx.set(fieldLensAt(tx, [...PERSPECTIVES_ROOT, id, 'nextSeq']), next)
}

/**
 * Create one cognitive memory entry.
 *
 * The Map entry lens is optional, so this creates or replaces exactly the
 * requested id. Callers reject id collisions before writing; the whole memory
 * command runs inside one transaction savepoint.
 */
export function writeMemory(
  tx: SchemaTransaction,
  perspectiveId: string,
  memoryId: string,
  input: CognitiveMemoryInput,
): void {
  const lens = structLensAt(tx, [...PERSPECTIVES_ROOT, perspectiveId, 'memories', memoryId])
  tx.set(lens, input)
}

/**
 * Patch mutable memory fields without resetting unspecified fields.
 *
 * `content` leaf metadata (the micro-summary) is written separately through
 * `setWithMeta`; this helper covers the struct's ordinary leaves and links.
 */
export function patchMemory(
  tx: SchemaTransaction,
  perspectiveId: string,
  memoryId: string,
  patch: Record<string, unknown>,
): void {
  const lens = structLensAt(tx, [...PERSPECTIVES_ROOT, perspectiveId, 'memories', memoryId])
  tx.patch(lens, patch)
}
