/**
 * Canonical objective-world schemas.
 *
 * All roots are registered through `ctx.schema.define` by
 * {@link WorldModelService}. Every business struct is flat (leaf fields only)
 * and extensible so external world packages can augment it without nesting
 * another struct inside an entity. Structural topology is expressed with
 * `s.link` / `s.linkList`; cross-commit history uses `s.ref`.
 *
 * Domain invariants that cannot be expressed declaretively are enforced by the
 * final-draft validator in `validation.ts`.
 */

import { PERSPECTIVES_ROOT } from '@sekaisen/plugin-perspective'
import { s } from '@sekaisen/plugin-schema'
import type { Path } from '@sekaisen/plugin-world'
import { SELF_COMMIT } from '@sekaisen/plugin-world'

/** Singleton root holding global world state. */
export const WORLD_ROOT_PATH: Path = Object.freeze(['world'])

/** Parent root of every objective entity collection. */
export const ENTITIES_ROOT_PATH: Path = Object.freeze(['entities'])

/** Spatial location table. */
export const LOCATION_ROOT_PATH: Path = Object.freeze(['entities', 'location'])

/** Directed spatial route table. */
export const ROUTE_ROOT_PATH: Path = Object.freeze(['entities', 'route'])

/** Character table shared by bodies, masks and independent delegates. */
export const CHARACTER_ROOT_PATH: Path = Object.freeze(['entities', 'character'])

/** Organisation and faction table. */
export const ORGANIZATION_ROOT_PATH: Path = Object.freeze(['entities', 'organization'])

/** Directed social relation table. */
export const RELATION_ROOT_PATH: Path = Object.freeze(['entities', 'relation'])

/** Item and recursive container table. */
export const ITEM_ROOT_PATH: Path = Object.freeze(['entities', 'item'])

/** Special ability/skill table. */
export const ABILITY_ROOT_PATH: Path = Object.freeze(['entities', 'ability'])

/** World lore table. */
export const LORE_ROOT_PATH: Path = Object.freeze(['entities', 'lore'])

/** Objective physical/state timer table. */
export const FUSE_ROOT_PATH: Path = Object.freeze(['entities', 'fuse'])

/** Subjective character/organisation agenda table. */
export const AGENDA_ROOT_PATH: Path = Object.freeze(['entities', 'agenda'])

/** Director dramatic beat table. */
export const BEAT_ROOT_PATH: Path = Object.freeze(['entities', 'beat'])

/** Controller storytelling modes; hidden from every character. */
export type StorytellerMode = 'hardcore_sim' | 'balanced' | 'high_drama'

/** Controller modes understood by the scheduler. */
export type CharacterControlMode = 'human' | 'ai_major' | 'ai_minor' | 'inactive'

/** Agenda lifecycle states. */
export type AgendaStatus = 'pending' | 'active' | 'missed' | 'invalidated'

/** Director intervention strengths. */
export type BeatInterventionMode = 'nudge' | 'converge' | 'force' | 'review'

/** Registered objective entity collection kinds, in declaration order. */
export type EntityKind =
  | 'location'
  | 'route'
  | 'character'
  | 'organization'
  | 'relation'
  | 'item'
  | 'ability'
  | 'lore'
  | 'fuse'
  | 'agenda'
  | 'beat'

/** Global world state and clock root. */
export const WorldRootSchema = s
  .struct({
    /** Monotonic story clock in accumulated minutes. */
    clock: s
      .num()
      .default(0)
      .meta({ visibility: 'surface', globalSurface: true })
      .desc('current accumulated story minutes (monotonic integer)'),
    /** Calendar explanation for `clock = 0`. */
    timeAnchorLabel: s
      .str()
      .default('')
      .meta({ visibility: 'surface', globalSurface: true })
      .desc('calendar anchor description for clock zero'),
    /** Controller-only storytelling mode. */
    storytellerMode: s
      .str()
      .default('balanced')
      .meta({ visibility: 'ref' })
      .desc('storyteller mode: hardcore_sim | balanced | high_drama'),
    /** Controller-only global dramatic tension (0..100). */
    tension: s
      .num()
      .default(0)
      .meta({ visibility: 'ref' })
      .desc('global dramatic tension score (0..100)'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('global world state and clock root')

/** Spatial location with a single containment parent. */
export const LocationSchema = s
  .struct({
    name: s.str().meta({ visibility: 'surface' }).desc('location name'),
    parent: s
      .link({
        targetRoots: [LOCATION_ROOT_PATH],
        exclusiveRole: 'parent',
        acyclic: true,
        onDelete: 'reject',
      })
      .optional()
      .meta({ visibility: 'surface', linkRoles: ['parent'] })
      .desc('containing region or parent location'),
    layout: s
      .str()
      .default('')
      .meta({ visibility: 'surface' })
      .desc('architecture, terrain and layout description'),
    props: s
      .str()
      .default('')
      .meta({ visibility: 'surface', salience: 'passive' })
      .desc('fixed furnishings and background detail'),
    weather: s
      .str()
      .optional()
      .meta({ visibility: 'surface', ephemeral: true })
      .desc('current transient weather'),
    lighting: s
      .str()
      .optional()
      .meta({ visibility: 'surface', ephemeral: true, sense: 'sight' })
      .desc('current transient lighting and visibility'),
    soundscape: s
      .str()
      .optional()
      .meta({ visibility: 'surface', ephemeral: true, sense: 'sound' })
      .desc('current transient ambient sound'),
    isTemporary: s
      .bool()
      .default(false)
      .meta({ visibility: 'ref' })
      .desc('whether this is an unpublished temporary scene'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('spatial location node')

/** Directed route between two locations. */
export const RouteSchema = s
  .struct({
    from: s
      .link({ targetRoots: [LOCATION_ROOT_PATH], onDelete: 'cascade' })
      .meta({ visibility: 'surface', linkRoles: ['edge_from'] })
      .desc('route start location'),
    to: s
      .link({ targetRoots: [LOCATION_ROOT_PATH], onDelete: 'cascade' })
      .meta({ visibility: 'surface', linkRoles: ['edge_to'] })
      .desc('route end location'),
    senseTarget: s
      .link({ targetRoots: [LOCATION_ROOT_PATH], onDelete: 'unlink' })
      .optional()
      .meta({ visibility: 'surface', linkRoles: ['sense_pass'] })
      .desc('adjacent sensory transmission target (must equal to)'),
    direction: s
      .str()
      .default('')
      .meta({ visibility: 'surface' })
      .desc('direction and entrance text'),
    pathKind: s.str().default('passage').meta({ visibility: 'surface' }).desc('route kind'),
    travelMinutes: s.num().default(1).meta({ visibility: 'surface' }).desc('travel minutes'),
    transitions: s
      .list('str')
      .default([])
      .meta({ visibility: 'surface' })
      .desc('intermediate scene descriptions during travel'),
    isLocked: s
      .bool()
      .default(false)
      .meta({ visibility: 'surface' })
      .desc('whether locked or blocked'),
    requiredItem: s
      .link({ targetRoots: [ITEM_ROOT_PATH], onDelete: 'unlink' })
      .optional()
      .meta({ visibility: 'ref' })
      .desc('item required to unlock or traverse'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('directed spatial route edge')

/** Character body, mask or independent delegate. */
export const CharacterSchema = s
  .struct({
    name: s.str().meta({ visibility: 'surface' }).desc('displayed name or title'),
    appearance: s.str().default('').meta({ visibility: 'surface' }).desc('appearance'),
    dress: s.str().default('').meta({ visibility: 'surface' }).desc('current clothing'),
    location: s
      .link({
        targetRoots: [LOCATION_ROOT_PATH],
        exclusiveRole: 'parent',
        acyclic: true,
        onDelete: 'reject',
      })
      .optional()
      .meta({ visibility: 'surface', linkRoles: ['parent'] })
      .desc('current location, absent when off-stage'),
    condition: s
      .str()
      .default('正常')
      .meta({ visibility: 'surface', sharedAcrossDelegates: true })
      .desc('body condition and injuries'),
    subPosition: s
      .str()
      .optional()
      .meta({ visibility: 'surface', ephemeral: true })
      .desc('in-scene sub position'),
    posture: s
      .str()
      .default('站立')
      .meta({ visibility: 'surface', ephemeral: true })
      .desc('current posture'),
    currentAction: s
      .str()
      .optional()
      .meta({ visibility: 'surface', ephemeral: true })
      .desc('current ongoing action'),
    personality: s.str().default('').meta({ visibility: 'self' }).desc('core personality'),
    origin: s.str().default('').meta({ visibility: 'self' }).desc('origin and past'),
    speechStyle: s
      .list('str')
      .default([])
      .meta({ visibility: 'self' })
      .desc('speech style examples'),
    valueHierarchy: s
      .list('str')
      .default([])
      .meta({ visibility: 'self' })
      .desc('values ordered from highest to lowest'),
    longTermGoal: s.str().default('').meta({ visibility: 'self' }).desc('long-term goal'),
    shortTermGoal: s.str().default('').meta({ visibility: 'self' }).desc('current short-term goal'),
    home: s
      .link({ targetRoots: [LOCATION_ROOT_PATH], onDelete: 'unlink' })
      .optional()
      .meta({ visibility: 'self' })
      .desc('home location'),
    routine: s.str().default('').meta({ visibility: 'self' }).desc('default daily routine'),
    reactionSpeed: s
      .num()
      .default(100)
      .meta({ visibility: 'self', sharedAcrossDelegates: true })
      .desc('base reaction speed, positive'),
    controlledBy: s
      .link({
        targetRoots: [CHARACTER_ROOT_PATH],
        exclusiveRole: 'delegate',
        acyclic: true,
        onDelete: 'cascade',
      })
      .optional()
      .meta({ visibility: 'ref', linkRoles: ['delegate'] })
      .desc('true controlling character behind this body or mask'),
    sharedBody: s
      .bool()
      .default(false)
      .meta({ visibility: 'ref' })
      .desc('whether this character shares the controller body'),
    trueName: s.str().optional().meta({ visibility: 'ref' }).desc('objective true name'),
    controlMode: s
      .str()
      .default('ai_minor')
      .meta({ visibility: 'ref' })
      .desc('control mode: human | ai_major | ai_minor | inactive'),
    isTemporary: s
      .bool()
      .default(false)
      .meta({ visibility: 'ref' })
      .desc('whether this is an unpublished temporary character'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('character entity (body, mask or independent delegate)')

/** Organisation or faction. */
export const OrganizationSchema = s
  .struct({
    name: s.str().meta({ visibility: 'surface' }).desc('organisation name'),
    creed: s.str().default('').meta({ visibility: 'surface' }).desc('public creed and image'),
    leader: s
      .link({ targetRoots: [CHARACTER_ROOT_PATH], onDelete: 'unlink' })
      .optional()
      .meta({ visibility: 'self', linkRoles: ['owner'] })
      .desc('organisation leader'),
    members: s
      .linkList({ targetRoots: [CHARACTER_ROOT_PATH], onDelete: 'unlink' })
      .default([])
      .meta({ visibility: 'self' })
      .desc('organisation members'),
    headquarters: s
      .link({ targetRoots: [LOCATION_ROOT_PATH], onDelete: 'unlink' })
      .optional()
      .meta({ visibility: 'self' })
      .desc('secret headquarters location'),
    agenda: s.str().default('').meta({ visibility: 'self' }).desc('long-term internal agenda'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('organisation or faction entity')

/** Directed social relation edge. */
export const RelationSchema = s
  .struct({
    from: s
      .link({
        targetRoots: [CHARACTER_ROOT_PATH, ORGANIZATION_ROOT_PATH],
        onDelete: 'cascade',
      })
      .meta({ visibility: 'surface', linkRoles: ['edge_from', 'owner'] })
      .desc('relation subject holding the attitude'),
    to: s
      .link({
        targetRoots: [CHARACTER_ROOT_PATH, ORGANIZATION_ROOT_PATH],
        onDelete: 'cascade',
      })
      .meta({ visibility: 'surface', linkRoles: ['edge_to'] })
      .desc('relation target'),
    role: s.str().default('').meta({ visibility: 'surface' }).desc('social role or label'),
    outerSummary: s
      .str()
      .default('')
      .meta({ visibility: 'surface' })
      .desc('outward attitude summary'),
    outerScore: s
      .num()
      .optional()
      .meta({ visibility: 'surface' })
      .desc('outward score (-100..100)'),
    innerSummary: s.str().default('').meta({ visibility: 'self' }).desc('private true attitude'),
    innerScore: s.num().optional().meta({ visibility: 'self' }).desc('private score (-100..100)'),
    milestones: s
      .linkList({ targetRoots: [PERSPECTIVES_ROOT], onDelete: 'unlink' })
      .default([])
      .meta({ visibility: 'self' })
      .desc('cognitive memory milestones owned by the from perspective'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('directed social relation edge')

/** Item and recursive container. */
export const ItemSchema = s
  .struct({
    name: s.str().meta({ visibility: 'surface' }).desc('item name'),
    holder: s
      .link({
        targetRoots: [CHARACTER_ROOT_PATH, LOCATION_ROOT_PATH, ITEM_ROOT_PATH],
        exclusiveRole: 'parent',
        acyclic: true,
        onDelete: 'reject',
      })
      .optional()
      .meta({ visibility: 'surface', linkRoles: ['parent'] })
      .desc('current physical holder, location or outer container'),
    owners: s
      .linkList({ targetRoots: [CHARACTER_ROOT_PATH, ORGANIZATION_ROOT_PATH], onDelete: 'unlink' })
      .default([])
      .meta({ visibility: 'self', linkRoles: ['owner'] })
      .desc('item owners'),
    subPosition: s
      .str()
      .optional()
      .meta({ visibility: 'surface', ephemeral: true })
      .desc('specific worn or placed position'),
    appearance: s.str().default('').meta({ visibility: 'surface' }).desc('item appearance'),
    quantity: s.num().default(1).meta({ visibility: 'surface' }).desc('quantity, non-negative'),
    effect: s.str().default('').meta({ visibility: 'ref' }).desc('true effect and mechanism'),
    limits: s.str().default('').meta({ visibility: 'ref' }).desc('use cost and restrictions'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('item and container entity')

/** Special ability or skill. */
export const AbilitySchema = s
  .struct({
    name: s.str().meta({ visibility: 'surface' }).desc('ability name'),
    appearance: s
      .str()
      .default('')
      .meta({ visibility: 'surface' })
      .desc('observable manifestation'),
    owners: s
      .linkList({ targetRoots: [CHARACTER_ROOT_PATH, ORGANIZATION_ROOT_PATH], onDelete: 'unlink' })
      .default([])
      .meta({ visibility: 'self', linkRoles: ['owner'] })
      .desc('ability owners'),
    effect: s
      .str()
      .default('')
      .meta({ visibility: 'ref' })
      .desc('ability effect and resolution rules'),
    limits: s.str().default('').meta({ visibility: 'ref' }).desc('cost, cooldown and restrictions'),
    flaw: s.str().optional().meta({ visibility: 'ref' }).desc('hidden weakness or side effect'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('special ability or skill entity')

/** World lore entry, hidden by default. */
export const LoreSchema = s
  .struct({
    title: s.str().meta({ visibility: 'surface' }).desc('lore title'),
    category: s.str().default('general').meta({ visibility: 'surface' }).desc('lore category'),
    content: s.str().meta({ visibility: 'surface' }).desc('lore body'),
    relatedEntities: s
      .linkList({
        targetRoots: [['entities']],
        dynamicTargetRoots: true,
        onDelete: 'unlink',
      })
      .default([])
      .meta({ visibility: 'surface' })
      .desc('entities related to this lore'),
  })
  .extensible()
  .meta({ visibility: 'ref' })
  .desc('world lore entity (ref by default)')

/** Objective physical or state timer. */
export const FuseSchema = s
  .struct({
    host: s
      .link({
        targetRoots: [LOCATION_ROOT_PATH, CHARACTER_ROOT_PATH, ITEM_ROOT_PATH],
        exclusiveRole: 'parent',
        acyclic: true,
        onDelete: 'cascade',
      })
      .meta({ visibility: 'surface', linkRoles: ['parent'] })
      .desc('host location, body or item'),
    dueAt: s.num().meta({ visibility: 'surface' }).desc('absolute due story minute'),
    pausedRemaining: s
      .num()
      .optional()
      .meta({ visibility: 'surface' })
      .desc('frozen remaining minutes while paused'),
    repeatInterval: s
      .num()
      .optional()
      .meta({ visibility: 'surface' })
      .desc('positive repeat interval, absent for one-shot'),
    sense: s
      .str()
      .default('sight')
      .meta({ visibility: 'surface' })
      .desc('trigger channel: sight | sound'),
    summary: s
      .str()
      .default('')
      .meta({ visibility: 'surface' })
      .desc('observable timer description'),
    effect: s.str().default('').meta({ visibility: 'ref' }).desc('due effect and rules'),
  })
  .extensible()
  .meta({ visibility: 'surface' })
  .desc('objective physical or state timer')

/** Subjective agenda item. */
export const AgendaSchema = s
  .struct({
    host: s
      .link({ targetRoots: [CHARACTER_ROOT_PATH, ORGANIZATION_ROOT_PATH], onDelete: 'cascade' })
      .meta({ visibility: 'self', linkRoles: ['owner'] })
      .desc('character or organisation owning this plan'),
    after: s
      .linkList({ targetRoots: [AGENDA_ROOT_PATH], acyclic: true, onDelete: 'unlink' })
      .default([])
      .meta({ visibility: 'surface' })
      .desc('blocking predecessor agenda items'),
    targets: s
      .linkList({
        targetRoots: [['entities']],
        dynamicTargetRoots: true,
        onDelete: 'unlink',
      })
      .default([])
      .meta({ visibility: 'surface' })
      .desc('target locations, characters or items'),
    dueAt: s.num().meta({ visibility: 'surface' }).desc('scheduled story minute'),
    expiresAt: s
      .num()
      .optional()
      .meta({ visibility: 'surface' })
      .desc('optional expiry story minute'),
    priority: s.num().default(500).meta({ visibility: 'surface' }).desc('agenda priority'),
    status: s
      .str()
      .default('pending')
      .meta({ visibility: 'surface' })
      .desc('pending | active | missed | invalidated'),
    baselineRef: s
      .ref()
      .default({ commitId: SELF_COMMIT, path: [] })
      .meta({ visibility: 'surface' })
      .desc('state snapshot when the plan was created'),
    watchPaths: s
      .list('str')
      .default([])
      .meta({ visibility: 'surface' })
      .desc('encoded precondition path keys'),
    summary: s.str().meta({ visibility: 'surface' }).desc('one-line plan summary'),
    detail: s.str().default('').meta({ visibility: 'surface' }).desc('detailed plan description'),
  })
  .extensible()
  .meta({ visibility: 'self' })
  .desc('subjective character or organisation agenda item')

/** Director dramatic beat. */
export const BeatSchema = s
  .struct({
    host: s
      .link({
        targetRoots: [
          LOCATION_ROOT_PATH,
          CHARACTER_ROOT_PATH,
          ORGANIZATION_ROOT_PATH,
          RELATION_ROOT_PATH,
        ],
        onDelete: 'cascade',
      })
      .optional()
      .meta({ visibility: 'ref' })
      .desc('optional focus entity; absent means world-level beat'),
    after: s
      .linkList({ targetRoots: [BEAT_ROOT_PATH], acyclic: true, onDelete: 'unlink' })
      .default([])
      .meta({ visibility: 'ref' })
      .desc('predecessor beats'),
    targets: s
      .linkList({
        targetRoots: [['entities']],
        dynamicTargetRoots: true,
        onDelete: 'unlink',
      })
      .default([])
      .meta({ visibility: 'ref' })
      .desc('target entities'),
    dueAt: s.num().meta({ visibility: 'ref' }).desc('scheduled story minute'),
    priority: s.num().default(1000).meta({ visibility: 'ref' }).desc('dramatic priority'),
    interventionMode: s
      .str()
      .default('nudge')
      .meta({ visibility: 'ref' })
      .desc('nudge | converge | force | review'),
    baselineRef: s
      .ref()
      .default({ commitId: SELF_COMMIT, path: [] })
      .meta({ visibility: 'ref' })
      .desc('state snapshot when the beat was created'),
    watchPaths: s
      .list('str')
      .default([])
      .meta({ visibility: 'ref' })
      .desc('encoded critical precondition path keys'),
    summary: s.str().meta({ visibility: 'ref' }).desc('one-line beat summary'),
    directive: s.str().default('').meta({ visibility: 'ref' }).desc('director directive'),
  })
  .extensible()
  .meta({ visibility: 'ref' })
  .desc('director dramatic beat (ref to every character)')
