/**
 * Final-draft domain invariants for the objective world model.
 *
 * The validator covers the twelve documented rules: flat business structs,
 * shared-body exclusivity, organisation leadership, directed relation laws,
 * relation milestone ownership, numeric bounds, route sensory agreement,
 * temporal bounds, clock monotonicity/step alignment, archive isolation and
 * carry-over isolation. Archive/carry checks inspect the actual canonical diff
 * (including metadata and schema writes) and require exact reverse coverage so
 * an empty or partial audit list cannot hide unreported writes.
 *
 * Only public schema and perspective APIs are used: no perspective path
 * structure is re-implemented except the four-segment memory path supplied by
 * `parseCognitiveMemoryPath`.
 */

import type { Option, Result } from '@sekaisen/core'
import { err, ok } from '@sekaisen/core'
import type { PerspectiveServiceApi } from '@sekaisen/plugin-perspective'
import type {
  EntryLensFor,
  HistoricalNodeInspection,
  HistoricalStructInspection,
  LensOutput,
  MapLens,
  ReadonlySchemaView,
  SchemaError,
  SchemaNode,
  SchemaServiceApi,
  TypedCommitMessage,
} from '@sekaisen/plugin-schema'
import type {
  CommitHash,
  Path,
  StateDiff,
  StateRef,
  Value,
  WorldService,
} from '@sekaisen/plugin-world'
import { decodePathKey, encodePathKey } from '@sekaisen/plugin-world'
import type { WorldModelLenses } from './lenses.ts'
import type { CarryOverPatchMessage, MemoryArchiveMessage, WorldModelMessages } from './messages.ts'
import {
  claimPathKind,
  hasReservedSegment,
  isEntitiesPath,
  isPerspectivesPath,
  isWorldPath,
  pathStartsWith,
} from './paths.ts'
import {
  AGENDA_ROOT_PATH,
  BEAT_ROOT_PATH,
  CHARACTER_ROOT_PATH,
  FUSE_ROOT_PATH,
  ITEM_ROOT_PATH,
  ORGANIZATION_ROOT_PATH,
  RELATION_ROOT_PATH,
  ROUTE_ROOT_PATH,
  WORLD_ROOT_PATH,
} from './schemas.ts'

/** Commit-validator name reported through `validator_rejected`. */
export const WORLD_MODEL_VALIDATOR_NAME = 'world-model-invariants'

/** Failure shape accepted by `ctx.schema.addCommitValidator`. */
export interface WorldModelValidatorFailure {
  readonly path: Path
  readonly validatorName: string
  readonly reason: string
}

/** Validator context (the schema service extends this with `message`). */
export interface WorldModelValidatorContext {
  readonly parentId: Option<CommitHash>
  readonly message: TypedCommitMessage
  readonly draft: ReadonlySchemaView
  readonly diff: StateDiff
}

/** Services required by the validator. */
export interface WorldModelValidatorDeps {
  readonly schema: Pick<SchemaServiceApi, 'viewAt'>
  readonly world: Pick<WorldService, 'hasCommit'>
  readonly perspective: Pick<
    PerspectiveServiceApi,
    'resolveRootPerspectiveAt' | 'parseCognitiveMemoryPath'
  >
  readonly lenses: WorldModelLenses
  readonly messages: WorldModelMessages
}

interface InstanceRecord<TValueSchema extends SchemaNode> {
  readonly id: string
  readonly value: LensOutput<EntryLensFor<TValueSchema>>
}

function failure(path: Path, reason: string): WorldModelValidatorFailure {
  return { path, validatorName: WORLD_MODEL_VALIDATOR_NAME, reason }
}

function listInstances<TValueSchema extends SchemaNode>(
  view: ReadonlySchemaView,
  lens: MapLens<TValueSchema>,
): Result<readonly InstanceRecord<TValueSchema>[], SchemaError> {
  const ids = view.listKeys(lens)
  if (!ids.ok) return ids
  const records: InstanceRecord<TValueSchema>[] = []
  for (const id of ids.value) {
    const value = view.get(lens.at(id))
    if (!value.ok) return value
    if (value.value.kind === 'some') records.push({ id, value: value.value.value })
  }
  return ok(records)
}

function structAt(view: ReadonlySchemaView, path: Path): HistoricalStructInspection | undefined {
  const inspection = view.inspectInstance(path)
  if (!inspection.ok || inspection.value.kind === 'none') return undefined
  return inspection.value.value.nodeKind === 'struct' ? inspection.value.value : undefined
}

function nodeAt(
  inspection: HistoricalStructInspection,
  field: string,
): HistoricalNodeInspection | undefined {
  const node = inspection.fields[field]
  return node?.kind === 'some' ? node.value : undefined
}

function scalarAt(inspection: HistoricalStructInspection, field: string): Value | undefined {
  const node = nodeAt(inspection, field)
  return node?.nodeKind === 'leaf' && !isStateRef(node.value) ? node.value : undefined
}

function isStateRef(value: Value | StateRef): value is StateRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value) &&
    'commitId' in value &&
    'path' in value
  )
}

function stringAt(inspection: HistoricalStructInspection, field: string): string | undefined {
  const value = scalarAt(inspection, field)
  return typeof value === 'string' ? value : undefined
}

function refAt(inspection: HistoricalStructInspection, field: string): StateRef | undefined {
  const node = nodeAt(inspection, field)
  return node?.nodeKind === 'leaf' && isStateRef(node.value) ? node.value : undefined
}

function numberAt(inspection: HistoricalStructInspection, field: string): number | undefined {
  const value = scalarAt(inspection, field)
  return typeof value === 'number' ? value : undefined
}

function stringListAt(
  inspection: HistoricalStructInspection,
  field: string,
): readonly string[] | undefined {
  const value = scalarAt(inspection, field)
  if (!Array.isArray(value)) return undefined
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    strings.push(item)
  }
  return Object.freeze(strings)
}

function decodeKey(key: string): Path | undefined {
  try {
    const path = decodePathKey(key)
    return path.length === 0 ? undefined : path
  } catch {
    return undefined
  }
}

/**
 * A discovery Map key is the canonical target path key, not an arbitrary id.
 * Existing target records are updated in place, so the key must round-trip.
 */
function isCanonicalDiscoveryPath(path: Path): boolean {
  if (claimPathKind(path) !== 'discoveredEntities') return false
  const key = path[3]
  if (key === undefined) return false
  const target = decodeKey(key)
  return target !== undefined && encodePathKey(target) === key
}

function clockAt(view: ReadonlySchemaView, lenses: WorldModelLenses): number | undefined {
  const value = view.get(lenses.world.field('clock'))
  if (!value.ok) return undefined
  return value.value.kind === 'some' ? value.value.value : 0
}

function parentClock(
  deps: WorldModelValidatorDeps,
  parentId: Option<CommitHash>,
): number | undefined {
  if (parentId.kind === 'none') return 0
  const view = deps.schema.viewAt(parentId.value)
  if (!view.ok) return undefined
  return clockAt(view.value, deps.lenses)
}

/** True when some physical operation writes below (not at) `path`. */
function hasWriteUnder(diff: StateDiff, path: Path): boolean {
  return diff.some((op) => pathStartsWith(op.path, path) && op.path.length > path.length)
}

/** True when an instance exists in the final draft. */
function presentInDraft(view: ReadonlySchemaView, path: Path): boolean {
  const inspection = view.inspectInstance(path)
  return inspection.ok && inspection.value.kind === 'some'
}

/** True when an instance was absent from the parent view. */
function absentFromParent(parent: ReadonlySchemaView | undefined, path: Path): boolean {
  if (!parent) return true
  const inspection = parent.inspectInstance(path)
  return inspection.ok && inspection.value.kind === 'none'
}

function checkFlatStructFields(
  root: Path,
  struct: Extract<SchemaNode, { readonly nodeKind: 'struct' }>,
): WorldModelValidatorFailure | undefined {
  for (const [field, child] of Object.entries(struct.fields))
    if (child.nodeKind !== 'leaf')
      return failure([...root, field], 'nested_struct_in_entity_forbidden')
  return undefined
}

function validateFlatEntityStructs(
  view: ReadonlySchemaView,
  root: Path,
): WorldModelValidatorFailure | undefined {
  const schema = view.writerSchemaAt(root)
  if (!schema.ok || schema.value.kind === 'none') return undefined
  const node = schema.value.value
  if (node.nodeKind === 'map') {
    const value = node.valueSchema
    if (value.nodeKind !== 'struct') return failure(root, 'nested_struct_in_entity_forbidden')
    return checkFlatStructFields(root, value)
  }
  if (node.nodeKind !== 'struct') return undefined
  return checkFlatStructFields(root, node)
}

function validateFlatStructs(view: ReadonlySchemaView): WorldModelValidatorFailure | undefined {
  const world = validateFlatEntityStructs(view, WORLD_ROOT_PATH)
  if (world) return world
  for (const root of view.listRootPaths()) {
    if (root.length < 2 || root[0] !== 'entities') continue
    const nested = validateFlatEntityStructs(view, root)
    if (nested) return nested
  }
  return undefined
}

function validateSharedBodies(
  view: ReadonlySchemaView,
  lenses: WorldModelLenses,
): WorldModelValidatorFailure | undefined {
  const records = listInstances(view, lenses.characters)
  if (!records.ok) return failure(CHARACTER_ROOT_PATH, 'schema_read_failed')
  const byId = new Map(records.value.map((record) => [record.id, record.value] as const))
  const groupCache = new Map<string, string>()
  const groupOf = (id: string, visiting: Set<string>): string => {
    const cached = groupCache.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return id
    const record = byId.get(id)
    if (!record) {
      groupCache.set(id, id)
      return id
    }
    const controller = record.controlledBy
    if (!record.sharedBody || controller.kind === 'none') {
      groupCache.set(id, id)
      return id
    }
    const controllerKey = controller.value
    const controllerPath = decodeKey(controllerKey)
    const controllerId = controllerPath?.at(-1)
    if (controllerPath === undefined || controllerId === undefined) {
      groupCache.set(id, id)
      return id
    }
    visiting.add(id)
    const group = groupOf(controllerId, visiting)
    visiting.delete(id)
    groupCache.set(id, group)
    return group
  }
  const staged = new Map<string, string>()
  for (const record of records.value) {
    if (record.value.location.kind === 'none') continue
    const group = groupOf(record.id, new Set<string>())
    const previous = staged.get(group)
    if (previous !== undefined)
      return failure([...CHARACTER_ROOT_PATH, record.id], 'shared_body_multiple_staged_actors')
    staged.set(group, record.id)
  }
  return undefined
}

function validateOrganizations(
  view: ReadonlySchemaView,
  lenses: WorldModelLenses,
): WorldModelValidatorFailure | undefined {
  const records = listInstances(view, lenses.organizations)
  if (!records.ok) return failure(ORGANIZATION_ROOT_PATH, 'schema_read_failed')
  for (const record of records.value) {
    if (record.value.leader.kind === 'none') continue
    if (!record.value.members.includes(record.value.leader.value))
      return failure([...ORGANIZATION_ROOT_PATH, record.id], 'organization_leader_not_in_members')
  }
  return undefined
}

function validateRelations(
  view: ReadonlySchemaView,
  lenses: WorldModelLenses,
  perspective: Pick<PerspectiveServiceApi, 'resolveRootPerspectiveAt' | 'parseCognitiveMemoryPath'>,
): WorldModelValidatorFailure | undefined {
  const records = listInstances(view, lenses.relations)
  if (!records.ok) return failure(RELATION_ROOT_PATH, 'schema_read_failed')
  const pairs = new Set<string>()
  for (const record of records.value) {
    const path: Path = [...RELATION_ROOT_PATH, record.id]
    if (record.value.from === record.value.to) return failure(path, 'relation_self_loop_forbidden')
    const pair = encodePathKey([record.value.from, record.value.to])
    if (pairs.has(pair)) return failure(path, 'duplicate_directed_relation')
    pairs.add(pair)
    for (const score of [record.value.outerScore, record.value.innerScore]) {
      if (score.kind === 'none') continue
      if (!Number.isFinite(score.value) || score.value < -100 || score.value > 100)
        return failure(path, 'score_out_of_range')
    }
    if (record.value.milestones.length === 0) continue
    const fromPath = decodeKey(record.value.from)
    if (fromPath === undefined) return failure(path, 'invalid_relation_milestone_owner')
    const owner = perspective.resolveRootPerspectiveAt(view, fromPath)
    if (!owner.ok) return failure(path, 'invalid_relation_milestone_owner')
    for (const milestoneKey of record.value.milestones) {
      const milestonePath = decodeKey(milestoneKey)
      if (milestonePath === undefined) return failure(path, 'invalid_relation_milestone_owner')
      const coordinates = perspective.parseCognitiveMemoryPath(milestonePath)
      if (coordinates.kind === 'none' || coordinates.value.rootPerspectiveId !== owner.value)
        return failure(path, 'invalid_relation_milestone_owner')
    }
  }
  return undefined
}

function validateNumericBounds(
  view: ReadonlySchemaView,
  lenses: WorldModelLenses,
): WorldModelValidatorFailure | undefined {
  const tensionValue = view.get(lenses.world.field('tension'))
  const tension =
    tensionValue.ok && tensionValue.value.kind === 'some' ? tensionValue.value.value : undefined
  if (tension === undefined || !Number.isFinite(tension) || tension < 0 || tension > 100)
    return failure([...WORLD_ROOT_PATH, 'tension'], 'score_out_of_range')

  const items = listInstances(view, lenses.items)
  if (!items.ok) return failure(ITEM_ROOT_PATH, 'schema_read_failed')
  for (const record of items.value)
    if (!Number.isFinite(record.value.quantity) || record.value.quantity < 0)
      return failure([...ITEM_ROOT_PATH, record.id], 'score_out_of_range')

  const routes = listInstances(view, lenses.routes)
  if (!routes.ok) return failure(ROUTE_ROOT_PATH, 'schema_read_failed')
  for (const record of routes.value) {
    if (!Number.isFinite(record.value.travelMinutes) || record.value.travelMinutes < 0)
      return failure([...ROUTE_ROOT_PATH, record.id], 'score_out_of_range')
    if (
      record.value.senseTarget.kind === 'some' &&
      record.value.senseTarget.value !== record.value.to
    )
      return failure([...ROUTE_ROOT_PATH, record.id], 'route_sense_target_mismatch')
  }

  const characters = listInstances(view, lenses.characters)
  if (!characters.ok) return failure(CHARACTER_ROOT_PATH, 'schema_read_failed')
  for (const record of characters.value)
    if (!Number.isFinite(record.value.reactionSpeed) || record.value.reactionSpeed <= 0)
      return failure([...CHARACTER_ROOT_PATH, record.id], 'score_out_of_range')
  return undefined
}

function validWatchPaths(paths: readonly string[]): boolean {
  for (const key of paths) {
    if (decodeKey(key) === undefined) return false
  }
  return true
}

function validateTemporalBounds(
  view: ReadonlySchemaView,
  lenses: WorldModelLenses,
): WorldModelValidatorFailure | undefined {
  const fuses = listInstances(view, lenses.fuses)
  if (!fuses.ok) return failure(FUSE_ROOT_PATH, 'schema_read_failed')
  for (const record of fuses.value) {
    const path: Path = [...FUSE_ROOT_PATH, record.id]
    if (!Number.isInteger(record.value.dueAt)) return failure(path, 'invalid_temporal_bounds')
    if (
      record.value.pausedRemaining.kind === 'some' &&
      (!Number.isFinite(record.value.pausedRemaining.value) ||
        record.value.pausedRemaining.value < 0)
    )
      return failure(path, 'invalid_temporal_bounds')
    if (
      record.value.repeatInterval.kind === 'some' &&
      (!Number.isInteger(record.value.repeatInterval.value) ||
        record.value.repeatInterval.value <= 0)
    )
      return failure(path, 'invalid_temporal_bounds')
  }

  const agendas = listInstances(view, lenses.agendas)
  if (!agendas.ok) return failure(AGENDA_ROOT_PATH, 'schema_read_failed')
  for (const record of agendas.value) {
    const path: Path = [...AGENDA_ROOT_PATH, record.id]
    if (!Number.isInteger(record.value.dueAt)) return failure(path, 'invalid_temporal_bounds')
    if (
      record.value.expiresAt.kind === 'some' &&
      (!Number.isFinite(record.value.expiresAt.value) ||
        record.value.expiresAt.value < record.value.dueAt)
    )
      return failure(path, 'invalid_temporal_bounds')
    if (!validWatchPaths(record.value.watchPaths)) return failure(path, 'invalid_temporal_bounds')
  }

  const beats = listInstances(view, lenses.beats)
  if (!beats.ok) return failure(BEAT_ROOT_PATH, 'schema_read_failed')
  for (const record of beats.value) {
    const path: Path = [...BEAT_ROOT_PATH, record.id]
    if (!Number.isInteger(record.value.dueAt)) return failure(path, 'invalid_temporal_bounds')
    if (!validWatchPaths(record.value.watchPaths)) return failure(path, 'invalid_temporal_bounds')
  }
  return undefined
}

interface ClockState {
  readonly clock: number
  readonly parentClock: number
}

function validateClock(
  deps: WorldModelValidatorDeps,
  context: WorldModelValidatorContext,
): WorldModelValidatorFailure | ClockState {
  const clock = clockAt(context.draft, deps.lenses)
  if (clock === undefined || !Number.isInteger(clock))
    return failure([...WORLD_ROOT_PATH, 'clock'], 'clock_regression_forbidden')
  const previous = parentClock(deps, context.parentId)
  if (previous === undefined)
    return failure([...WORLD_ROOT_PATH, 'clock'], 'clock_regression_forbidden')
  const isManualEdit = context.message.kind === 'manual_edit'
  if (context.message.kind === 'manual_edit') {
    const parsed = deps.messages.manualEdit.parse(context.message)
    if (!parsed.ok || parsed.value.kind === 'none')
      return failure(['$message'], 'invalid_manual_edit_message')
  }
  if (!isManualEdit && clock < previous)
    return failure([...WORLD_ROOT_PATH, 'clock'], 'clock_regression_forbidden')
  if (context.message.kind === 'l0_step') {
    const parsed = deps.messages.l0Step.parse(context.message)
    if (!parsed.ok || parsed.value.kind === 'none')
      return failure(['$message'], 'step_time_mismatch')
    const step = parsed.value.value
    if (
      !Number.isInteger(step.storyTimeStart) ||
      !Number.isInteger(step.storyTimeEnd) ||
      step.storyTimeStart < previous ||
      step.storyTimeStart > step.storyTimeEnd ||
      step.storyTimeEnd !== clock
    )
      return failure(['$message'], 'step_time_mismatch')
  }
  return { clock, parentClock: previous }
}

function validateArchive(
  deps: WorldModelValidatorDeps,
  context: WorldModelValidatorContext,
  state: ClockState,
  parent: ReadonlySchemaView | undefined,
): WorldModelValidatorFailure | undefined {
  const parsed = deps.messages.memoryArchive.parse(context.message)
  if (!parsed.ok || parsed.value.kind === 'none')
    return failure(['$message'], 'invalid_memory_archive_commit')
  const message: MemoryArchiveMessage = parsed.value.value
  if (message.archiveLevel !== 'L1' && message.archiveLevel !== 'L2')
    return failure(['$message'], 'invalid_memory_archive_commit')
  const archiveLevel = message.archiveLevel
  if (state.clock !== state.parentClock)
    return failure([...WORLD_ROOT_PATH, 'clock'], 'invalid_memory_archive_commit')
  for (const op of context.diff) {
    if (isEntitiesPath(op.path) || pathStartsWith(op.path, ['$schemas']))
      return failure(op.path, 'invalid_memory_archive_commit')
    if (isWorldPath(op.path)) {
      const allowedClock =
        op.op === 'set' &&
        op.path.length === 2 &&
        op.path[1] === 'clock' &&
        op.value === state.clock
      if (!allowedClock) return failure(op.path, 'invalid_memory_archive_commit')
    }
    if (op.path[0] !== 'perspectives' && op.path[0] !== 'world')
      return failure(op.path, 'invalid_memory_archive_commit')
  }

  const created = new Set<string>()
  for (const key of message.createdMemoryKeys) {
    const path = decodeKey(key)
    if (path === undefined || hasReservedSegment(path))
      return failure(['$message'], 'invalid_memory_archive_commit')
    const coordinates = deps.perspective.parseCognitiveMemoryPath(path)
    if (coordinates.kind === 'none') return failure(['$message'], 'invalid_memory_archive_commit')
    const perspectiveId = coordinates.value.rootPerspectiveId
    if (!message.perspectiveIds.includes(perspectiveId))
      return failure(['$message'], 'invalid_memory_archive_commit')
    if (!absentFromParent(parent, path) || !presentInDraft(context.draft, path))
      return failure(path, 'invalid_memory_archive_commit')
    if (!hasWriteUnder(context.diff, path)) return failure(path, 'invalid_memory_archive_commit')
    if (!validateArchivedMemory(context.draft, deps, path, perspectiveId, archiveLevel))
      return failure(path, 'invalid_memory_archive_commit')
    created.add(encodePathKey(path))
  }

  // Reverse coverage: every newly created memory in the real diff must be audited.
  for (const touched of touchedMemoryInstances(context.diff, deps.perspective)) {
    if (!absentFromParent(parent, touched)) continue
    if (!created.has(encodePathKey(touched)))
      return failure(touched, 'invalid_memory_archive_commit')
    const coordinates = deps.perspective.parseCognitiveMemoryPath(touched)
    if (
      coordinates.kind === 'none' ||
      !message.perspectiveIds.includes(coordinates.value.rootPerspectiveId)
    )
      return failure(touched, 'invalid_memory_archive_commit')
  }
  return undefined
}

const LEVEL_RANK: Readonly<Record<string, number>> = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
})

function validateArchivedMemory(
  view: ReadonlySchemaView,
  deps: WorldModelValidatorDeps,
  path: Path,
  perspectiveId: string,
  archiveLevel: 'L1' | 'L2',
): boolean {
  const inspection = structAt(view, path)
  if (!inspection) return false
  if (stringAt(inspection, 'ownerPerspectiveId') !== perspectiveId) return false
  if (stringAt(inspection, 'level') !== archiveLevel) return false
  const seq = numberAt(inspection, 'seq')
  if (seq === undefined || !Number.isInteger(seq) || seq < 1) return false
  const children = stringListAt(inspection, 'children')
  if (children === undefined || children.length === 0) return false
  const parentRank = LEVEL_RANK[archiveLevel] ?? -1
  for (const childKey of children) {
    const childPath = decodeKey(childKey)
    if (childPath === undefined) return false
    const coordinates = deps.perspective.parseCognitiveMemoryPath(childPath)
    if (coordinates.kind === 'none' || coordinates.value.rootPerspectiveId !== perspectiveId)
      return false
    const child = structAt(view, childPath)
    if (!child) return false
    const childLevel = stringAt(child, 'level')
    const childSeq = numberAt(child, 'seq')
    const childRank = childLevel === undefined ? -1 : (LEVEL_RANK[childLevel] ?? -1)
    if (childRank < 0 || childRank >= parentRank) return false
    if (childSeq === undefined || !Number.isInteger(childSeq) || childSeq > seq) return false
  }
  return true
}

/** Memory instance prefixes touched by the canonical diff. */
function touchedMemoryInstances(
  diff: StateDiff,
  perspective: Pick<PerspectiveServiceApi, 'parseCognitiveMemoryPath'>,
): readonly Path[] {
  const paths = new Map<string, Path>()
  for (const op of diff) {
    for (let depth = 1; depth <= op.path.length; depth++) {
      const instance = Object.freeze(op.path.slice(0, depth))
      if (hasReservedSegment(instance)) continue
      if (perspective.parseCognitiveMemoryPath(instance).kind === 'none') continue
      paths.set(encodePathKey(instance), instance)
      break
    }
  }
  return Object.freeze([...paths.values()])
}

/** Claim instance prefixes (`['perspectives', P, kind, key]`) touched by a diff. */
function touchedClaimInstances(diff: StateDiff): readonly Path[] {
  const paths = new Map<string, Path>()
  for (const op of diff) {
    const path = op.path
    if (claimPathKind(path) === undefined || path.length < 4) continue
    const instance = Object.freeze(path.slice(0, 4))
    if (hasReservedSegment(instance)) continue
    paths.set(encodePathKey(instance), instance)
  }
  return Object.freeze([...paths.values()])
}

function validateCarryOver(
  deps: WorldModelValidatorDeps,
  context: WorldModelValidatorContext,
  state: ClockState,
  parent: ReadonlySchemaView | undefined,
): WorldModelValidatorFailure | undefined {
  const parsed = deps.messages.carryOverPatch.parse(context.message)
  if (!parsed.ok || parsed.value.kind === 'none')
    return failure(['$message'], 'invalid_carry_over_commit')
  const message: CarryOverPatchMessage = parsed.value.value
  if (context.parentId.kind === 'none' || context.parentId.value !== message.rewindTargetCommitId)
    return failure(['$message'], 'invalid_carry_over_commit')
  if (
    message.sourceCommitId === message.rewindTargetCommitId ||
    !deps.world.hasCommit(message.sourceCommitId as CommitHash)
  )
    return failure(['$message'], 'invalid_carry_over_commit')
  if (state.clock !== state.parentClock)
    return failure([...WORLD_ROOT_PATH, 'clock'], 'invalid_carry_over_commit')

  const carriedItems = new Set<string>()
  for (const key of message.carriedItemKeys) {
    const path = decodeKey(key)
    if (path === undefined || path.length !== 3 || path[0] !== 'entities' || path[1] !== 'item')
      return failure(['$message'], 'invalid_carry_over_commit')
    if (!presentInDraft(context.draft, path) || !hasWriteUnder(context.diff, path))
      return failure(path, 'invalid_carry_over_commit')
    carriedItems.add(key)
  }

  for (const op of context.diff) {
    if (pathStartsWith(op.path, ['$schemas'])) return failure(op.path, 'invalid_carry_over_commit')
    if (isWorldPath(op.path)) {
      const allowedClock =
        op.op === 'set' &&
        op.path.length === 2 &&
        op.path[1] === 'clock' &&
        op.value === state.clock
      if (!allowedClock) return failure(op.path, 'invalid_carry_over_commit')
      continue
    }
    if (isEntitiesPath(op.path)) {
      const id = op.path[2]
      const instance =
        op.path.length >= 3 && id !== undefined && !id.startsWith('$')
          ? Object.freeze(op.path.slice(0, 3))
          : undefined
      if (
        instance === undefined ||
        instance.length !== 3 ||
        instance[1] !== 'item' ||
        !carriedItems.has(encodePathKey(instance))
      )
        return failure(op.path, 'invalid_carry_over_commit')
      continue
    }
    if (!isPerspectivesPath(op.path)) return failure(op.path, 'invalid_carry_over_commit')
  }

  const carriedMemories = new Set<string>()
  for (const key of message.carriedMemoryKeys) {
    const path = decodeKey(key)
    if (path === undefined || hasReservedSegment(path))
      return failure(['$message'], 'invalid_carry_over_commit')
    const coordinates = deps.perspective.parseCognitiveMemoryPath(path)
    if (coordinates.kind === 'none') return failure(['$message'], 'invalid_carry_over_commit')
    if (!message.carriedPerspectiveIds.includes(coordinates.value.rootPerspectiveId))
      return failure(['$message'], 'invalid_carry_over_commit')
    if (!absentFromParent(parent, path) || !presentInDraft(context.draft, path))
      return failure(path, 'invalid_carry_over_commit')
    if (!hasWriteUnder(context.diff, path)) return failure(path, 'invalid_carry_over_commit')
    const inspection = structAt(context.draft, path)
    if (
      !inspection ||
      stringAt(inspection, 'ownerPerspectiveId') !== coordinates.value.rootPerspectiveId
    )
      return failure(path, 'invalid_carry_over_commit')
    carriedMemories.add(key)
  }

  for (const path of touchedMemoryInstances(context.diff, deps.perspective)) {
    if (!carriedMemories.has(encodePathKey(path)) || !absentFromParent(parent, path))
      return failure(path, 'invalid_carry_over_commit')
  }

  const carriedClaims = new Set<string>()
  for (const key of message.carriedClaimKeys) {
    const path = decodeKey(key)
    const kind = path === undefined ? undefined : claimPathKind(path)
    if (path === undefined || kind === undefined)
      return failure(['$message'], 'invalid_carry_over_commit')
    const claimKey = path[3]
    if (claimKey === undefined || claimKey.length === 0 || claimKey.startsWith('$'))
      return failure(['$message'], 'invalid_carry_over_commit')
    if (!message.carriedPerspectiveIds.includes(path[1] ?? ''))
      return failure(['$message'], 'invalid_carry_over_commit')
    // Discovery records are keyed by canonical target path and may be reacquired
    // in place; every other claim table only accepts newly appended entries.
    const existing = !absentFromParent(parent, path)
    if (existing && kind !== 'discoveredEntities') return failure(path, 'invalid_carry_over_commit')
    if (kind === 'discoveredEntities' && !isCanonicalDiscoveryPath(path))
      return failure(path, 'invalid_carry_over_commit')
    if (!presentInDraft(context.draft, path) || !hasWriteUnder(context.diff, path))
      return failure(path, 'invalid_carry_over_commit')
    if (kind === 'discoveredEntities') {
      const inspection = structAt(context.draft, path)
      const target = inspection === undefined ? undefined : refAt(inspection, 'targetRef')
      if (target === undefined || encodePathKey(target.path) !== claimKey)
        return failure(path, 'invalid_carry_over_commit')
      const seq = inspection === undefined ? undefined : numberAt(inspection, 'seq')
      if (seq === undefined || !Number.isInteger(seq) || seq < 1)
        return failure(path, 'invalid_carry_over_commit')
      if (existing) {
        const previous = parent === undefined ? undefined : structAt(parent, path)
        const previousSeq = previous === undefined ? undefined : numberAt(previous, 'seq')
        if (previousSeq === undefined || seq <= previousSeq)
          return failure(path, 'invalid_carry_over_commit')
      }
    }
    carriedClaims.add(key)
  }

  for (const path of touchedClaimInstances(context.diff)) {
    if (!carriedClaims.has(encodePathKey(path))) return failure(path, 'invalid_carry_over_commit')
    if (claimPathKind(path) !== 'discoveredEntities' && !absentFromParent(parent, path))
      return failure(path, 'invalid_carry_over_commit')
  }
  return undefined
}

/**
 * Validate one final draft. Runs on every schema commit and sync; a validator
 * rejection aborts the commit before World persistence.
 */
export function validateWorldModel(
  deps: WorldModelValidatorDeps,
  context: WorldModelValidatorContext,
): Result<void, WorldModelValidatorFailure> {
  const flat = validateFlatStructs(context.draft)
  if (flat) return err(flat)

  const shared = validateSharedBodies(context.draft, deps.lenses)
  if (shared) return err(shared)

  const organizations = validateOrganizations(context.draft, deps.lenses)
  if (organizations) return err(organizations)

  const relations = validateRelations(context.draft, deps.lenses, deps.perspective)
  if (relations) return err(relations)

  const numeric = validateNumericBounds(context.draft, deps.lenses)
  if (numeric) return err(numeric)

  const temporal = validateTemporalBounds(context.draft, deps.lenses)
  if (temporal) return err(temporal)

  const clock = validateClock(deps, context)
  if ('reason' in clock) return err(clock)

  let parent: ReadonlySchemaView | undefined
  if (context.parentId.kind === 'some') {
    const view = deps.schema.viewAt(context.parentId.value)
    if (!view.ok) return err(failure(WORLD_ROOT_PATH, 'invalid_parent_commit'))
    parent = view.value
  }

  if (context.message.kind === 'memory_archive') {
    const archive = validateArchive(deps, context, clock, parent)
    if (archive) return err(archive)
  }
  if (context.message.kind === 'carry_over_patch') {
    const carry = validateCarryOver(deps, context, clock, parent)
    if (carry) return err(carry)
  }
  return ok(undefined)
}
