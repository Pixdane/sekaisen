/**
 * Declarative perspective metadata injected into `@sekaisen/plugin-schema`
 * through TypeScript declaration merging.
 *
 * Perspective never registers a parallel schema system: every entity, edge and
 * extension field is still created with `ctx.schema.define / augment` and the
 * `s.*` builders. This module only widens {@link SchemaNodeMeta} with the
 * keys understood by the perspective engine and exposes the pure metadata
 * readers used by the rest of the plugin.
 */

import type { LeafSchemaNode, SchemaMetaMap, SchemaNode } from '@sekaisen/plugin-schema'

/** Visibility level of an instance or a single field. */
export type Visibility = 'surface' | 'self' | 'ref'

/**
 * Sensory channel used by live perception.
 *
 * `'sight'` is the default channel; `'sound'` carries soundscape-like fields
 * and is filtered independently by containers and actor senses.
 */
export type SensoryChannel = 'sight' | 'sound'

/**
 * Salience of a persistent surface field during a routine
 * `PerspectiveService.syncScope`.
 *
 * - `'salient'` (default): automatically remembered whenever the observer is
 *   in live direct scope.
 * - `'passive'`: visible/inspectable in the moment but not persisted by a
 *   routine scan unless it is listed in `focusedPaths` or explicitly granted.
 */
export type FieldSalience = 'salient' | 'passive'

/**
 * Topology/semantics role carried by a `s.link` / `s.linkList` foreign key.
 *
 * Roles are stored in leaf metadata as a legal `list:str` under `linkRoles`
 * (see {@link SchemaNodeMeta}); a link may carry several roles.
 */
export type PerspectiveLinkRole =
  /** Spatial/containment tree. At most one non-empty single-target link per instance; union must be acyclic. */
  | 'parent'
  /** Private ownership edge (target mind owns this instance); multiple owners are allowed. */
  | 'owner'
  /** Perspective delegation edge (body/mask to root mind). Single target and acyclic; implies `owner`. */
  | 'delegate'
  /** Summarisation edge: a visible upper instance hides the visible subordinate in routine views. */
  | 'subsumes'
  /** Start endpoint of a directed edge entity; implies `owner`. */
  | 'edge_from'
  /** End endpoint of a directed edge entity. */
  | 'edge_to'
  /** Marks the `edge_to` link of a directed edge whose target environment is sensed across the edge. */
  | 'sense_pass'

/**
 * Perspective metadata added to schema nodes through `declare module`.
 *
 * Every consumer of `@sekaisen/plugin-schema` gets these strongly typed after
 * importing this package. Runtime persistence is the normal flat schema
 * metadata dictionary, so declaring these keys is enough for
 * `ctx.schema.define`/`augment` to store them.
 */
declare module '@sekaisen/plugin-schema' {
  interface SchemaNodeMeta {
    /**
     * Default visibility for a struct instance, or default visibility for a
     * leaf field. Absent means `'surface'`.
     *
     * An instance-level runtime override is stored at
     * `[...instancePath, '$meta', 'visibility']`.
     */
    readonly visibility?: Visibility
    /** Sensory channel a field belongs to. Absent means `'sight'`. */
    readonly sense?: SensoryChannel
    /**
     * Default salience of a persistent `'surface'` field. Absent means
     * `'salient'`. Runtime override: `[...instancePath, '$meta', 'salience']`.
     */
    readonly salience?: FieldSalience
    /**
     * When `true` the field is pure in-the-moment perception (posture,
     * lighting, soundscape). It is never projected from historical memory and
     * claims about it are rejected with `invalid_claim_target`.
     */
    readonly ephemeral?: boolean
    /**
     * Link roles carried by a `s.link`/`s.linkList` field. Stored as a legal
     * `list:str`; values are {@link PerspectiveLinkRole}s.
     */
    readonly linkRoles?: readonly PerspectiveLinkRole[]
    /**
     * Whether `activateDelegate` copies this field between two bodies of the
     * same root mind (for example injuries or base reaction speed).
     */
    readonly sharedAcrossDelegates?: boolean
    /**
     * Explicit opt-in for a declared live global data feed.
     *
     * Honored only on a leaf field of a registered struct **root** (never on
     * Map members, nested instances or instances that merely look global).
     * The value is then read from the current projection commit for every
     * staged physical observer, without requiring the root to be inside that
     * observer's geometric sensory scope. Effective instance and field
     * visibility, staged-body gating and the observer's normal claim/exclusion
     * fold still apply. This is not photon visibility: it grants no ownership,
     * navigation, link-target identity, discovery or memory write.
     */
    readonly globalSurface?: boolean
  }
}

/** Metadata key carrying the runtime instance visibility override. */
export const INSTANCE_VISIBILITY_KEY = 'visibility'
/** Metadata key carrying the runtime instance salience override. */
export const INSTANCE_SALIENCE_KEY = 'salience'
/** Metadata key carrying the runtime instance channel-open master switch. */
export const CONTAINER_OPEN_KEY = 'containerOpen'
/** Metadata key carrying the runtime sight-channel open switch. */
export const SIGHT_OPEN_KEY = 'sightOpen'
/** Metadata key carrying the runtime sound-channel open switch. */
export const SOUND_OPEN_KEY = 'soundOpen'
/** Metadata key carrying the runtime actor sensory master switch. */
export const SENSORY_ENABLED_KEY = 'sensoryEnabled'
/** Metadata key carrying the runtime actor sight switch. */
export const SIGHT_ENABLED_KEY = 'sightEnabled'
/** Metadata key carrying the runtime actor sound switch. */
export const SOUND_ENABLED_KEY = 'soundEnabled'

/** Metadata key written by `s.link` for its target roots. */
export const LINK_TARGET_ROOTS_KEY = '$linkTargetRoots'
/** Metadata key written by `s.link` for role-union acyclicity. */
export const LINK_ACYCLIC_KEY = '$linkAcyclic'
/** Metadata key written by `s.link` for the exclusive role group. */
export const LINK_EXCLUSIVE_ROLE_KEY = '$linkExclusiveRole'
/** Metadata key written by `s.link` for its delete policy. */
export const LINK_ON_DELETE_KEY = '$linkOnDelete'

const SENSORY_CHANNELS: readonly SensoryChannel[] = ['sight', 'sound']
const LINK_ROLES: readonly PerspectiveLinkRole[] = [
  'parent',
  'owner',
  'delegate',
  'subsumes',
  'edge_from',
  'edge_to',
  'sense_pass',
]

/** Type guard for a declared {@link Visibility}. */
export function isVisibility(value: unknown): value is Visibility {
  return value === 'surface' || value === 'self' || value === 'ref'
}

/** Type guard for a declared {@link SensoryChannel}. */
export function isSensoryChannel(value: unknown): value is SensoryChannel {
  return typeof value === 'string' && SENSORY_CHANNELS.includes(value as SensoryChannel)
}

/** Type guard for a declared {@link FieldSalience}. */
export function isFieldSalience(value: unknown): value is FieldSalience {
  return value === 'salient' || value === 'passive'
}

/** Type guard for a declared {@link PerspectiveLinkRole}. */
export function isPerspectiveLinkRole(value: unknown): value is PerspectiveLinkRole {
  return typeof value === 'string' && LINK_ROLES.includes(value as PerspectiveLinkRole)
}

/**
 * Read the declared visibility metadata, defaulting to `'surface'`.
 *
 * This is a pure accessor: it never applies instance-level `$meta` overrides.
 */
export function visibilityOfSpec(spec: SchemaNode | undefined): Visibility {
  return isVisibility(spec?.metadata.visibility) ? spec.metadata.visibility : 'surface'
}

/**
 * Read the declared sensory channel of a leaf, defaulting to `'sight'`.
 *
 * Pure accessor; live scope must additionally gate on container openness and
 * actor sensory switches.
 */
export function senseOfSpec(spec: SchemaNode | undefined): SensoryChannel {
  return isSensoryChannel(spec?.metadata.sense) ? spec.metadata.sense : 'sight'
}

/**
 * Read the declared salience of a node, defaulting to `'salient'`.
 *
 * Pure accessor; runtime `$meta.salience` overrides are applied by the scope
 * engine.
 */
export function salienceOfSpec(spec: SchemaNode | undefined): FieldSalience {
  return isFieldSalience(spec?.metadata.salience) ? spec.metadata.salience : 'salient'
}

/** True when a leaf was declared `ephemeral: true` (never persisted as a claim). */
export function isEphemeralSpec(spec: SchemaNode | undefined): boolean {
  return spec?.metadata.ephemeral === true
}

/**
 * True when a leaf was explicitly declared `globalSurface: true`.
 *
 * Declaration-only by design: a runtime `$meta` override can hide a global
 * feed through ordinary visibility, but can never opt an undeclared leaf in.
 */
export function isGlobalSurfaceSpec(spec: SchemaNode | undefined): boolean {
  return spec?.metadata.globalSurface === true
}

/** True when a leaf was declared `sharedAcrossDelegates: true`. */
export function isSharedAcrossDelegates(spec: SchemaNode | undefined): boolean {
  return spec?.metadata.sharedAcrossDelegates === true
}

/**
 * Encode the perspective roles declared on a link leaf.
 *
 * Explicit `linkRoles` are authoritative. For convenience the schema's own
 * `$linkExclusiveRole` is accepted as an implicit role when it names one of
 * the perspective roles, so `s.link({ exclusiveRole: 'parent' })` works even
 * if the caller forgot the metadata. Unknown tags are ignored.
 */
export function linkRolesOfSpec(spec: LeafSchemaNode | undefined): readonly PerspectiveLinkRole[] {
  if (!spec) return []
  const roles: PerspectiveLinkRole[] = []
  const declared = spec.metadata.linkRoles
  if (Array.isArray(declared)) {
    for (const role of declared)
      if (isPerspectiveLinkRole(role) && !roles.includes(role)) roles.push(role)
  }
  const exclusive = spec.metadata[LINK_EXCLUSIVE_ROLE_KEY]
  if (isPerspectiveLinkRole(exclusive) && !roles.includes(exclusive)) roles.push(exclusive)
  return Object.freeze(roles)
}

/** True when the declared schema metadata contains at least one of `roles`. */
export function hasLinkRole(
  spec: LeafSchemaNode | undefined,
  ...roles: PerspectiveLinkRole[]
): boolean {
  const declared = linkRolesOfSpec(spec)
  return roles.some((role) => declared.includes(role))
}

/** True when a leaf is a foreign-key link (`s.link` or `s.linkList`). */
export function isLinkSpec(spec: LeafSchemaNode | undefined): boolean {
  if (!spec) return false
  return (
    Object.hasOwn(spec.metadata, LINK_TARGET_ROOTS_KEY) ||
    Object.hasOwn(spec.metadata, LINK_EXCLUSIVE_ROLE_KEY) ||
    spec.metadata.linkRoles !== undefined
  )
}

/**
 * Read a boolean runtime metadata attribute.
 *
 * Only genuine booleans count; malformed runtime metadata is treated as absent
 * rather than as a truthy value, keeping perception deterministic.
 */
export function booleanMeta(meta: SchemaMetaMap | undefined, key: string): boolean | undefined {
  const value = meta?.[key]
  return typeof value === 'boolean' ? value : undefined
}
