/**
 * Atomic convenience primitives over the objective world model.
 *
 * Every multi-write helper is wrapped in one draft savepoint. A domain failure
 * rolls back all writes made by the helper (item/ability edges plus knowledge
 * grants, or timer fields) while preserving writes made earlier in the
 * enclosing transaction.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, ok, some } from '@sekaisen/core'
import type { PerspectiveError, PerspectiveServiceApi } from '@sekaisen/plugin-perspective'
import type { SchemaTransaction } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { atomicWorldModel, domainFailure, expectSchema, fail } from './internal.ts'
import type { WorldModelLenses } from './lenses.ts'
import { entityCoordinates } from './paths.ts'
import { ABILITY_ROOT_PATH, FUSE_ROOT_PATH, ITEM_ROOT_PATH } from './schemas.ts'
import type { GrantAssetKnowledgeOptions } from './types.ts'

interface MutatorDeps {
  readonly perspective: Pick<PerspectiveServiceApi, 'grantKnowledge'>
  readonly lenses: WorldModelLenses
}

function assertEntity(
  tx: SchemaTransaction,
  path: Path,
  allowed: readonly string[],
  reason: string,
): void {
  const coordinates = entityCoordinates(path)
  if (coordinates === undefined || !allowed.includes(coordinates.kind))
    fail(domainFailure(path, reason))
  const inspection = expectSchema(tx.inspectInstance(path))
  if (inspection.kind === 'none') fail(domainFailure(path, reason))
}

function grant(deps: MutatorDeps, tx: SchemaTransaction, observer: Path, targetPath: Path): void {
  const result = deps.perspective.grantKnowledge(tx, observer, targetPath)
  if (!result.ok) fail(result.error)
}

/** Current story clock from the draft (defaults to zero). */
function currentClock(tx: SchemaTransaction, lenses: WorldModelLenses): number {
  const value = expectSchema(tx.get(lenses.world.field('clock')))
  return value.kind === 'some' ? value.value : 0
}

/**
 * Assign an item's physical holder and optionally replace its owner list.
 * Knowledge is granted to the holder when it is a character/organisation and to
 * every supplied owner; `effect`/`limits` default to granted.
 */
export function assignItem(
  deps: MutatorDeps,
  tx: SchemaTransaction,
  itemId: string,
  holderPath: Option<Path>,
  ownerPaths?: readonly Path[],
  knowledgeOptions?: GrantAssetKnowledgeOptions,
): Result<void, PerspectiveError> {
  return atomicWorldModel(tx, () => {
    const itemPath: Path = [...ITEM_ROOT_PATH, itemId]
    const itemLens = deps.lenses.items.at(itemId)
    const item = expectSchema(tx.get(itemLens))
    if (item.kind === 'none') fail(domainFailure(itemPath, 'item_not_found'))

    if (holderPath.kind === 'some')
      assertEntity(tx, holderPath.value, ['character', 'location', 'item'], 'invalid_item_holder')

    const recipients = new Map<string, Path>()
    if (holderPath.kind === 'some') {
      const coordinates = entityCoordinates(holderPath.value)
      if (coordinates?.kind === 'character' || coordinates?.kind === 'organization')
        recipients.set(encodePathKey(holderPath.value), holderPath.value)
    }

    let ownerKeys: readonly string[] | undefined
    if (ownerPaths !== undefined) {
      const keys: string[] = []
      for (const ownerPath of ownerPaths) {
        assertEntity(tx, ownerPath, ['character', 'organization'], 'invalid_item_owner')
        const key = encodePathKey(ownerPath)
        if (!keys.includes(key)) keys.push(key)
        recipients.set(key, ownerPath)
      }
      ownerKeys = Object.freeze(keys)
    }

    const holder = holderPath.kind === 'some' ? some(encodePathKey(holderPath.value)) : NONE
    if (ownerKeys === undefined) tx.patch(itemLens, { holder })
    else tx.patch(itemLens, { holder, owners: ownerKeys })

    const knowEffect = knowledgeOptions?.knowEffect ?? true
    const knowLimits = knowledgeOptions?.knowLimits ?? true
    for (const recipient of recipients.values()) {
      if (knowEffect) grant(deps, tx, recipient, [...itemPath, 'effect'])
      if (knowLimits) grant(deps, tx, recipient, [...itemPath, 'limits'])
    }
    return ok(undefined)
  })
}

/**
 * Attach an ability owner while preserving existing owners. `effect` and
 * `limits` knowledge default to granted; the hidden `flaw` stays secret unless
 * explicitly requested and physically present.
 */
export function grantAbility(
  deps: MutatorDeps,
  tx: SchemaTransaction,
  abilityId: string,
  ownerPath: Path,
  knowledgeOptions?: GrantAssetKnowledgeOptions,
): Result<void, PerspectiveError> {
  return atomicWorldModel(tx, () => {
    const abilityPath: Path = [...ABILITY_ROOT_PATH, abilityId]
    const abilityLens = deps.lenses.abilities.at(abilityId)
    const ability = expectSchema(tx.get(abilityLens))
    if (ability.kind === 'none') fail(domainFailure(abilityPath, 'ability_not_found'))
    assertEntity(tx, ownerPath, ['character', 'organization'], 'invalid_ability_owner')

    const ownerKey = encodePathKey(ownerPath)
    const owners = ability.value.owners.includes(ownerKey)
      ? ability.value.owners
      : Object.freeze([...ability.value.owners, ownerKey])
    tx.patch(abilityLens, { owners })

    if (knowledgeOptions?.knowEffect ?? true) grant(deps, tx, ownerPath, [...abilityPath, 'effect'])
    if (knowledgeOptions?.knowLimits ?? true) grant(deps, tx, ownerPath, [...abilityPath, 'limits'])
    if ((knowledgeOptions?.knowFlaw ?? false) && ability.value.flaw.kind === 'some')
      grant(deps, tx, ownerPath, [...abilityPath, 'flaw'])
    return ok(undefined)
  })
}

/** Pause a running fuse and freeze `max(0, dueAt - clock)` minutes. */
export function pauseFuse(
  deps: MutatorDeps,
  tx: SchemaTransaction,
  fuseId: string,
): Result<void, PerspectiveError> {
  return atomicWorldModel(tx, () => {
    const path: Path = [...FUSE_ROOT_PATH, fuseId]
    const lens = deps.lenses.fuses.at(fuseId)
    const fuse = expectSchema(tx.get(lens))
    if (fuse.kind === 'none') fail(domainFailure(path, 'fuse_not_found'))
    if (fuse.value.pausedRemaining.kind === 'some') fail(domainFailure(path, 'fuse_already_paused'))
    const remaining = Math.max(0, fuse.value.dueAt - currentClock(tx, deps.lenses))
    tx.patch(lens, { pausedRemaining: some(remaining) })
    return ok(undefined)
  })
}

/** Resume a paused fuse from the current clock. */
export function resumeFuse(
  deps: MutatorDeps,
  tx: SchemaTransaction,
  fuseId: string,
): Result<void, PerspectiveError> {
  return atomicWorldModel(tx, () => {
    const path: Path = [...FUSE_ROOT_PATH, fuseId]
    const lens = deps.lenses.fuses.at(fuseId)
    const fuse = expectSchema(tx.get(lens))
    if (fuse.kind === 'none') fail(domainFailure(path, 'fuse_not_found'))
    const paused = fuse.value.pausedRemaining
    if (paused.kind === 'none') fail(domainFailure(path, 'fuse_not_paused'))
    if (!Number.isInteger(paused.value))
      fail(domainFailure(path, 'fuse_paused_remaining_not_integer'))
    const dueAt = currentClock(tx, deps.lenses) + paused.value
    tx.patch(lens, { dueAt, pausedRemaining: NONE })
    return ok(undefined)
  })
}

/**
 * Consume a due fuse: one-shot instances are deleted, recurring instances have
 * their due time advanced by exactly one interval.
 */
export function consumeTriggeredFuse(
  deps: MutatorDeps,
  tx: SchemaTransaction,
  fuseId: string,
): Result<void, PerspectiveError> {
  return atomicWorldModel(tx, () => {
    const path: Path = [...FUSE_ROOT_PATH, fuseId]
    const lens = deps.lenses.fuses.at(fuseId)
    const fuse = expectSchema(tx.get(lens))
    if (fuse.kind === 'none') fail(domainFailure(path, 'fuse_not_found'))
    if (fuse.value.pausedRemaining.kind === 'some') fail(domainFailure(path, 'fuse_paused'))
    const clock = currentClock(tx, deps.lenses)
    if (clock < fuse.value.dueAt) fail(domainFailure(path, 'fuse_not_due'))
    const interval = fuse.value.repeatInterval
    if (interval.kind === 'some') {
      if (!Number.isInteger(interval.value) || interval.value <= 0)
        fail(domainFailure(path, 'invalid_repeat_interval'))
      tx.patch(lens, { dueAt: fuse.value.dueAt + interval.value })
    } else {
      tx.delete(lens)
    }
    return ok(undefined)
  })
}
