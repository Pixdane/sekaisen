/**
 * Path classification helpers shared by validation and queries.
 */

import { PERSPECTIVES_ROOT } from '@sekaisen/plugin-perspective'
import type { EntityKind } from './schemas.ts'

const ENTITY_KINDS: readonly EntityKind[] = Object.freeze([
  'location',
  'route',
  'character',
  'organization',
  'relation',
  'item',
  'ability',
  'lore',
  'fuse',
  'agenda',
  'beat',
])

/** True when `path` equals `prefix` or continues below it. */
export function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  if (path.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false
  return true
}

/** True for any physically written path below `['entities']`. */
export function isEntitiesPath(path: readonly string[]): boolean {
  return path[0] === 'entities'
}

/** True for any physically written path below `['world']`. */
export function isWorldPath(path: readonly string[]): boolean {
  return path[0] === 'world'
}

/** True for any path below perspective storage. */
export function isPerspectivesPath(path: readonly string[]): boolean {
  return pathStartsWith(path, PERSPECTIVES_ROOT)
}

/** Decode a canonical entity instance path, or `undefined` for anything else. */
export function entityCoordinates(
  path: readonly string[],
): { readonly kind: EntityKind; readonly id: string } | undefined {
  if (path.length !== 3 || path[0] !== 'entities') return undefined
  const kind = path[1]
  const id = path[2]
  if (kind === undefined || id === undefined) return undefined
  for (const candidate of ENTITY_KINDS) if (candidate === kind) return { kind, id }
  return undefined
}

/** Claim Map field names under a perspective node. */
export type ClaimMapKind = 'discoveredEntities' | 'observedClaims' | 'rumorClaims' | 'exclusions'

/** Claim map field names, used to enumerate claim records in a diff. */
export const CLAIM_MAP_KINDS: readonly ClaimMapKind[] = Object.freeze([
  'discoveredEntities',
  'observedClaims',
  'rumorClaims',
  'exclusions',
])

/** True when any segment belongs to the schema reserved `$` namespace. */
export function hasReservedSegment(path: readonly string[]): boolean {
  for (const segment of path) if (segment.startsWith('$')) return true
  return false
}

/** Claim collection named by `['perspectives', P, <kind>, key, ...]`, if any. */
export function claimPathKind(path: readonly string[]): ClaimMapKind | undefined {
  if (path.length < PERSPECTIVES_ROOT.length + 3) return undefined
  if (!pathStartsWith(path, PERSPECTIVES_ROOT)) return undefined
  const kind = path[PERSPECTIVES_ROOT.length + 1]
  if (kind === undefined) return undefined
  for (const candidate of CLAIM_MAP_KINDS) if (candidate === kind) return candidate
  return undefined
}
