/**
 * Double-channel live perception.
 *
 * Sight and sound are resolved symmetrically but independently:
 * 1. the actor's channel switch gates the whole channel;
 * 2. a channel-specific ceiling stops outward perception at the first closed
 *    container on the parent chain;
 * 3. the public containment/edge expansion inside the ceiling is intersected
 *    with the observer's exclusions;
 * 4. a personal closure adds discovered secret instances and reaches one
 *    `sense_pass` edge hop;
 * 5. co-witnesses are enumerated from the observer's full public visual
 *    domain, never from the caller's refresh batch.
 */

import type { Option } from '@sekaisen/core'
import { compareUtf8, NONE, some } from '@sekaisen/core'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { ClaimEvaluator, FoldResult, LiveFacetInput } from './claims.ts'
import type { FieldNode, PerspectiveGraph, StructInstance } from './graph.ts'
import { fieldInstancePath, linkTargets, pathsEqual } from './graph.ts'
import type { SensoryChannel } from './visibility.ts'
import {
  booleanMeta,
  CONTAINER_OPEN_KEY,
  hasLinkRole,
  SENSORY_ENABLED_KEY,
  SIGHT_ENABLED_KEY,
  SIGHT_OPEN_KEY,
  SOUND_ENABLED_KEY,
  SOUND_OPEN_KEY,
} from './visibility.ts'

const LIVE_INSTANCE: LiveFacetInput = Object.freeze({
  kind: 'direct_scope' as const,
  value: null,
  summary: NONE,
})

/** Build a live field candidate; values are attached later by projections. */
export function liveField(value: LiveFacetInput['value'] = null): LiveFacetInput {
  return { kind: 'direct_scope', value, summary: NONE }
}

/** One channel's public/personal reachability for a single observer. */
export interface ChannelScopeState {
  readonly enabled: boolean
  readonly ceiling: Option<Path>
  /** Standard raw public surface under the ceiling, independent of observer claims. */
  readonly publicPaths: ReadonlyMap<string, Path>
  /** Public paths allowed by cognitive exclusions and semantic ancestor gates. */
  readonly unblockedPaths: ReadonlyMap<string, Path>
  /** Full personal reachability: unblocked public plus discovered/extra closure. */
  readonly reachablePaths: ReadonlyMap<string, Path>
}

/** Combined observer scope. */
export interface ObserverScopeState {
  readonly actor: Path
  readonly sight: ChannelScopeState
  readonly sound: ChannelScopeState
  /** True when the raw public prefix is safe to share byte-for-byte. */
  readonly canUseRawPublicScope: boolean
  readonly divergence: boolean
}

/**
 * One candidate body's own sensory scope and captured cognitive exclusions.
 * Co-witness checks never substitute the recording observer's permissions.
 */
export interface WitnessContext {
  readonly scope: ObserverScopeState
  readonly evaluator: ClaimEvaluator
}

function emptyChannel(): ChannelScopeState {
  return Object.freeze({
    enabled: false,
    ceiling: NONE,
    publicPaths: new Map(),
    unblockedPaths: new Map(),
    reachablePaths: new Map(),
  })
}

/**
 * Channel openness of a container: explicit channel switch, then the master
 * `containerOpen`, then open by default.
 */
export function isChannelOpen(
  graph: PerspectiveGraph,
  path: Path,
  channel: SensoryChannel,
): boolean {
  const instance = graph.instance(path)
  if (instance.kind === 'none') return true
  const meta = instance.value.meta
  const explicit = booleanMeta(meta, channel === 'sight' ? SIGHT_OPEN_KEY : SOUND_OPEN_KEY)
  if (explicit !== undefined) return explicit
  const master = booleanMeta(meta, CONTAINER_OPEN_KEY)
  return master ?? true
}

/**
 * Actor sensory capability: explicit channel switch, then `sensoryEnabled`,
 * then enabled by default. Stored on the body so it travels with the character.
 */
export function isActorSenseEnabled(
  graph: PerspectiveGraph,
  actorPath: Path,
  channel: SensoryChannel,
): boolean {
  const instance = graph.instance(actorPath)
  if (instance.kind === 'none') return false
  const meta = instance.value.meta
  const explicit = booleanMeta(meta, channel === 'sight' ? SIGHT_ENABLED_KEY : SOUND_ENABLED_KEY)
  if (explicit !== undefined) return explicit
  const master = booleanMeta(meta, SENSORY_ENABLED_KEY)
  return master ?? true
}

/**
 * Resolve the channel ceiling: walk parents until a missing parent or a
 * container closed on `channel`.
 */
export function resolveChannelCeiling(
  graph: PerspectiveGraph,
  actorPath: Path,
  channel: SensoryChannel,
): Path {
  const visited = new Set<string>([encodePathKey(actorPath)])
  let current = actorPath
  for (;;) {
    const parent = graph.parentOf(current)
    if (parent.kind === 'none') return current
    current = parent.value
    if (!isChannelOpen(graph, current, channel)) return current
    const key = encodePathKey(current)
    if (visited.has(key)) return current
    visited.add(key)
  }
}

function addPath(target: Map<string, Path>, path: Path): boolean {
  const key = encodePathKey(path)
  if (target.has(key)) return false
  target.set(key, path)
  return true
}

function surfaceInstance(graph: PerspectiveGraph, path: Path): Option<StructInstance> {
  const instance = graph.instance(path)
  if (instance.kind === 'none') return NONE
  return graph.instanceVisibility(instance.value) === 'surface' ? instance : NONE
}

/**
 * Adjacent environment root addressed by an edge's `sense_pass` link.
 *
 * The role is read from the link leaf itself rather than from `edge_to`, so a
 * schema that keeps the two roles on separate leaves still follows the
 * sensory hop it declares. Links are visited in field-name order so repeated
 * resolutions stay deterministic.
 *
 * @param graph - Current containment/edge graph view.
 * @param edgePath - Directed-edge instance path.
 * @returns The adjacent environment root, or `NONE` for a plain edge.
 */
function sensePassTarget(graph: PerspectiveGraph, edgePath: Path): Option<Path> {
  const edge = graph.instance(edgePath)
  if (edge.kind === 'none') return NONE
  const fields = [...edge.value.fields.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const field of fields) {
    if (!hasLinkRole(field.spec, 'sense_pass')) continue
    if (field.value.kind === 'none') continue
    const targets = linkTargets(field.value.value)
    if (targets.length > 0) return some(targets[0]!)
  }
  return NONE
}

/**
 * Whether a directed edge leaves the observer's pre-hop reachable domain.
 *
 * `sense_pass` is directional. Only an edge whose `edge_from` endpoint is
 * already reachable may admit its `edge_to` environment; an edge seen from
 * its destination (a reversed or remote-origin connector) must never pull the
 * observer's own environment, or an unrelated scene, into the closure.
 *
 * @param graph - Current containment/edge graph view.
 * @param edgePath - Directed-edge instance path.
 * @param reachableKeys - Encoded paths reachable before this hop.
 * @returns True when the semantic source endpoint is reachable.
 */
function edgeSourceReachable(
  graph: PerspectiveGraph,
  edgePath: Path,
  reachableKeys: ReadonlySet<string>,
): boolean {
  const edge = graph.instance(edgePath)
  if (edge.kind === 'none') return false
  const from = graph.singleRoleTarget(edge.value, 'edge_from')
  return from.kind === 'some' && reachableKeys.has(encodePathKey(from.value))
}

/**
 * Expand the containment interior of a seed container into `target`.
 *
 * The seed is explored even when it is a closed container (it is the scene
 * root/reference wall itself); descendants only descend through open
 * containers and only surface instances are revealed. This helper never
 * follows `sense_pass` edges, so adjacent environments cannot chain into each
 * other.
 *
 * @param graph - Current containment/edge graph view.
 * @param seed - Root of the environment to collect.
 * @param target - Destination map keyed by {@link encodePathKey}.
 * @param channel - Sensory channel supplying container openness.
 */
function expandContainment(
  graph: PerspectiveGraph,
  seed: Path,
  target: Map<string, Path>,
  channel: SensoryChannel,
): void {
  addPath(target, seed)
  const queue: Path[] = [seed]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const container = queue.shift()!
    const key = encodePathKey(container)
    if (visited.has(key)) continue
    visited.add(key)
    if (!pathsEqual(container, seed) && !isChannelOpen(graph, container, channel)) continue
    for (const child of graph.childrenOf(container)) {
      const surface = surfaceInstance(graph, child)
      if (surface.kind === 'none') continue
      if (!addPath(target, child)) continue
      queue.push(child)
    }
  }
}

/**
 * Whether a directed edge is unoccluded on `channel`.
 *
 * Edges must be physically reachable themselves: an edge without a parent is
 * admissible only when one endpoint is already reachable; an edge inside a
 * container requires that container to be reachable and either be the ceiling
 * or open on this channel.
 */
export function isEdgeContainmentUnoccluded(
  graph: PerspectiveGraph,
  edgePath: Path,
  ceilingPath: Path,
  reachableKeys: ReadonlySet<string>,
  channel: SensoryChannel,
): boolean {
  const edge = graph.instance(edgePath)
  if (edge.kind === 'none') return false
  const endpoints: Path[] = []
  for (const link of graph.roleLinks(edge.value, 'edge_from')) endpoints.push(link.target)
  for (const link of graph.roleLinks(edge.value, 'edge_to')) endpoints.push(link.target)
  const parent = graph.parentOf(edgePath)
  if (parent.kind === 'none')
    return endpoints.some((endpoint) => reachableKeys.has(encodePathKey(endpoint)))
  if (!reachableKeys.has(encodePathKey(parent.value))) return false
  return pathsEqual(parent.value, ceilingPath) || isChannelOpen(graph, parent.value, channel)
}

/**
 * Compute the standard public surface under one channel ceiling.
 *
 * Containment is expanded first from the ceiling. Edges are then inspected
 * only for that initial snapshot, so a `sense_pass` edge can merge exactly one
 * adjacent environment (its direct surface containment) without recursively
 * chaining through further sensory edges discovered inside that environment.
 * Edge visitation is tracked independently from instance inclusion: a surface
 * edge whose `parent` is already inside the ceiling is part of the containment
 * snapshot, and that prior membership must not suppress its sensory hop.
 *
 * This function intentionally ignores observer claims; exclusion/hallucination
 * filtering is applied by {@link computeObserverScope}.
 *
 * @param graph - Current containment/edge graph view.
 * @param ceilingPath - Channel ceiling root for this observer.
 * @param channel - Sensory channel being resolved.
 * @returns Public instances and admissible edges keyed by path key.
 */
export function computePublicChannelScope(
  graph: PerspectiveGraph,
  ceilingPath: Path,
  channel: SensoryChannel,
): ReadonlyMap<string, Path> {
  const paths = new Map<string, Path>()
  expandContainment(graph, ceilingPath, paths, channel)
  const reachableKeys = new Set(paths.keys())
  const nodes = [...paths.entries()]
    .sort((a, b) => compareUtf8(a[0], b[0]))
    .map((entry) => entry[1])
  const processedEdges = new Set<string>()
  /**
   * Admit one directed edge and its single sensory hop, at most once.
   *
   * The same edge can be both an instance of the initial containment snapshot
   * and a backlink result of either endpoint. Tracking visitation separately
   * from `paths` makes that overlap harmless. Edge keys are never added to
   * the pre-hop domain, so two edges cannot chain through an adjacent
   * environment regardless of iteration order.
   */
  const processEdge = (edgePath: Path): void => {
    const edgeKey = encodePathKey(edgePath)
    if (processedEdges.has(edgeKey)) return
    processedEdges.add(edgeKey)
    if (!isEdgeContainmentUnoccluded(graph, edgePath, ceilingPath, reachableKeys, channel)) return
    if (surfaceInstance(graph, edgePath).kind === 'none') return
    addPath(paths, edgePath)
    const adjacent = sensePassTarget(graph, edgePath)
    if (adjacent.kind === 'none') return
    if (surfaceInstance(graph, adjacent.value).kind === 'none') return
    if (!isChannelOpen(graph, edgePath, channel)) return
    if (!edgeSourceReachable(graph, edgePath, reachableKeys)) return
    expandContainment(graph, adjacent.value, paths, channel)
  }
  for (const node of nodes) {
    processEdge(node)
    for (const edgePath of graph.edgesTouching(node)) processEdge(edgePath)
  }
  return paths
}

/**
 * Whether `path` is live on the standard public surface.
 *
 * Visibility is already established by the graph. Cognitive access is checked
 * independently of the winning content facet: ordinary high-priority knowledge
 * must not disable perception, and stronger fiction cannot lift an exclusion.
 *
 * @param graph - Current graph view.
 * @param evaluator - Claim evaluator for the owning observer.
 * @param path - Candidate public instance or edge path.
 * @returns True when the path exists and no super-exclusion forbids access.
 */
function channelHasLiveInstance(
  graph: PerspectiveGraph,
  evaluator: ClaimEvaluator,
  path: Path,
): boolean {
  if (graph.instance(path).kind === 'none') return false
  return evaluator.allowsLive(path)
}

/**
 * Intersection gate for hidden (`'ref'`) instances and directed edges.
 *
 * Discovery validity comes from the evaluator's single canonical
 * `effectiveDiscoveredPaths` predicate, so live access, remembered structural
 * expansion and corpus target authorization cannot disagree about inherited
 * records, exclusions, overrides or `known_false` discoveries. The predicate
 * folds without a live producer because present physical existence is never
 * evidence of discovery.
 *
 * Live permission is then checked independently against super-exclusions.
 * Neither a discovery's high priority nor a rumor replacing a content facet
 * changes that permission. Physical existence is guaranteed by enumeration.
 *
 * @param evaluator - Claim evaluator for the owning observer.
 * @param discoveredKeys - Encoded paths already authorized by
 *   {@link ClaimEvaluator.effectiveDiscoveredPaths} for this snapshot.
 * @param path - Hidden instance or directed-edge path.
 * @returns True when the hidden candidate is discovered and live-permitted.
 */
function hiddenCandidateReachable(
  evaluator: ClaimEvaluator,
  discoveredKeys: ReadonlySet<string>,
  path: Path,
): boolean {
  if (!discoveredKeys.has(encodePathKey(path))) return false
  return evaluator.allowsLive(path)
}

/**
 * Resolve one sensory channel for an observer.
 *
 * Public containment and edges come from {@link computePublicChannelScope}.
 * The ceiling and every admitted candidate must pass cognitive exclusions,
 * independently of content-fold winners. High-priority normal knowledge
 * cannot revoke perception; a stronger rumor cannot reopen an excluded scene.
 * Hidden (`'ref'`) candidates additionally require an effective discovery,
 * while ordinary surface children in discovered containers stay live. An open
 * `sense_pass` edge merges exactly one adjacent surface environment, never a
 * chain of further sensory hops.
 *
 * @param graph - Current graph view for the staged observer.
 * @param evaluator - Claim evaluator for the observer's perspectives.
 * @param actorPath - Observer body path.
 * @param channel - Sensory channel to resolve.
 * @returns Channel enablement, ceiling, public and personal reachability.
 */
function computeChannel(
  graph: PerspectiveGraph,
  evaluator: ClaimEvaluator,
  actorPath: Path,
  channel: SensoryChannel,
): ChannelScopeState {
  if (!isActorSenseEnabled(graph, actorPath, channel)) return emptyChannel()
  const ceiling = resolveChannelCeiling(graph, actorPath, channel)
  if (!evaluator.allowsLive(ceiling)) return emptyChannel()
  const publicPaths = new Map(computePublicChannelScope(graph, ceiling, channel))
  const unblockedPaths = new Map<string, Path>()
  for (const [key, path] of publicPaths)
    if (
      channelHasLiveInstance(graph, evaluator, path) &&
      survivesObserverExclusions(graph, evaluator, path)
    )
      unblockedPaths.set(key, path)

  const extra = new Map<string, Path>()
  const queue: Path[] = []
  const ceilingKey = encodePathKey(ceiling)
  const discoveredKeys = new Set(
    evaluator.effectiveDiscoveredPaths().map((path) => encodePathKey(path)),
  )

  const visitedContainers = new Set<string>()
  const processedEdges = new Set<string>()
  const adjacentKeys = new Set<string>()
  /*
   * The origin domain for a sensory hop is the observer's initial containment
   * plus personal discoveries, never an environment admitted by an earlier
   * hop. `computePublicChannelScope` merges adjacent public environments into
   * `publicPaths`, so those keys are excluded by requiring initial
   * containment membership. A later parented edge therefore cannot bootstrap
   * itself from a preceding one-hop environment regardless of visit order.
   */
  const initialContainment = new Map<string, Path>()
  expandContainment(graph, ceiling, initialContainment, channel)
  const initialKeys = new Set(initialContainment.keys())
  /*
   * Only the initial containment seeds the walk. Adjacent environments are
   * merged as surfaces but never queued, so their sensory edges cannot chain
   * and hidden objects behind a window are not discovered by looking at it.
   */
  for (const [key, path] of initialContainment)
    if (unblockedPaths.has(key) && (key === ceilingKey || isChannelOpen(graph, path, channel)))
      queue.push(path)
  const originKeys = (): Set<string> => {
    const keys = new Set<string>()
    for (const key of initialKeys) if (unblockedPaths.has(key)) keys.add(key)
    for (const key of extra.keys()) if (!adjacentKeys.has(key)) keys.add(key)
    return keys
  }
  const sensedEdges = new Set<string>()
  /**
   * Apply one edge's sensory hop at most once, whether the edge surfaced as a
   * containment child, as a discovered container, or as an endpoint backlink.
   */
  const applySenseHop = (edgePath: Path): void => {
    const edgeKey = encodePathKey(edgePath)
    if (sensedEdges.has(edgeKey)) return
    if (sensePassTarget(graph, edgePath).kind === 'none') return
    sensedEdges.add(edgeKey)
    addSensePassEnvironment(
      graph,
      evaluator,
      edgePath,
      extra,
      channel,
      originKeys(),
      adjacentKeys,
      discoveredKeys,
    )
  }
  while (queue.length > 0) {
    const container = queue.shift()!
    const containerKey = encodePathKey(container)
    if (visitedContainers.has(containerKey)) continue
    visitedContainers.add(containerKey)
    const fromExtra = extra.has(containerKey)
    if (
      (unblockedPaths.has(containerKey) || fromExtra) &&
      isEdgeContainmentUnoccluded(graph, container, ceiling, originKeys(), channel)
    )
      applySenseHop(container)

    for (const child of graph.childrenOf(container)) {
      const childKey = encodePathKey(child)
      if (unblockedPaths.has(childKey) || extra.has(childKey)) continue
      const instance = graph.instance(child)
      if (instance.kind === 'none') continue
      const visibility = graph.instanceVisibility(instance.value)
      if (visibility === 'ref') {
        if (!hiddenCandidateReachable(evaluator, discoveredKeys, child)) continue
        if (!addPath(extra, child)) continue
      } else if (visibility === 'surface' && fromExtra) {
        if (!evaluator.allowsLive(child)) continue
        if (!addPath(extra, child)) continue
      } else {
        continue
      }
      if (isChannelOpen(graph, child, channel)) queue.push(child)
    }

    for (const edgePath of graph.edgesTouching(container)) {
      const edgeKey = encodePathKey(edgePath)
      if (processedEdges.has(edgeKey)) continue
      processedEdges.add(edgeKey)
      const edge = graph.instance(edgePath)
      if (edge.kind === 'none') continue
      if (!isEdgeContainmentUnoccluded(graph, edgePath, ceiling, originKeys(), channel)) continue
      const visibility = graph.instanceVisibility(edge.value)
      if (visibility === 'ref') {
        if (!hiddenCandidateReachable(evaluator, discoveredKeys, edgePath)) continue
        addPath(extra, edgePath)
      } else if (visibility === 'surface') {
        // A public edge was already merged as raw public surface; an edge that
        // is only reachable through a discovered container joins the private
        // closure here. Either way the sensory hop below runs exactly once.
        const alreadyPublic = unblockedPaths.has(edgeKey)
        if (!alreadyPublic) {
          const parent = graph.parentOf(edgePath)
          const parentExtra = parent.kind === 'some' && extra.has(encodePathKey(parent.value))
          if (!fromExtra && !parentExtra) continue
          if (!evaluator.allowsLive(edgePath)) continue
          if (!addPath(extra, edgePath)) continue
        }
      } else {
        continue
      }
      // Edge visitation is separate from instance inclusion: the child pass
      // may already have added this edge (or public containment may have), and
      // that membership must never suppress its `sense_pass` environment.
      applySenseHop(edgePath)
      if (isChannelOpen(graph, edgePath, channel)) queue.push(edgePath)
    }
  }

  const reachablePaths = new Map([...unblockedPaths, ...extra])
  return Object.freeze({
    enabled: true,
    ceiling: some(ceiling),
    publicPaths,
    unblockedPaths,
    reachablePaths,
  })
}

/**
 * Whether an instance and every semantic ancestor survive the observer's
 * effective super-priority exclusions.
 *
 * Claim folds key exclusions by physical schema prefix, while business
 * containment is a semantic `'parent'` graph. An exclusion recorded on a
 * remote scene root must still hide its descendants even when those
 * descendants are Map siblings in the physical schema, so the whole parent
 * chain is checked explicitly for each candidate. Content claims neither
 * remove these permissions nor cancel exclusions on any ancestor.
 *
 * @param graph - Current containment/edge graph view.
 * @param evaluator - Claim evaluator for the owning observer.
 * @param path - Adjacent instance candidate.
 * @returns False when the path or a semantic ancestor is super-excluded.
 */
function survivesObserverExclusions(
  graph: PerspectiveGraph,
  evaluator: ClaimEvaluator,
  path: Path,
): boolean {
  const visited = new Set<string>()
  let current = path
  for (;;) {
    const key = encodePathKey(current)
    if (visited.has(key)) return true
    visited.add(key)
    if (!evaluator.allowsLive(current)) return false
    const parent = graph.parentOf(current)
    if (parent.kind === 'none') return true
    current = parent.value
  }
}

/**
 * Merge the direct surface environment behind a one-hop `sense_pass` edge.
 *
 * The adjacent root and every surface descendant must pass the observer's
 * effective exclusion filter, including exclusions anchored on semantic
 * ancestors rather than physical path prefixes. Higher-priority content
 * claims cannot cancel any such exclusion. The environment is merged into
 * the private extra closure only and never queued, so sensory edges inside
 * it cannot chain into further hops. Keys
 * introduced solely by this hop are recorded in `adjacentKeys` so they cannot
 * serve as the source of a second sensory hop. The edge itself must be open
 * and must leave the pre-hop reachable domain.
 *
 * @param graph - Current containment/edge graph view.
 * @param evaluator - Claim evaluator for the owning observer.
 * @param edgePath - Directed edge carrying the `sense_pass` link.
 * @param extra - Personal extra reachability map for this channel.
 * @param channel - Sensory channel being resolved.
 * @param reachableKeys - Pre-hop paths allowed to source this sensory hop.
 * @param adjacentKeys - Set receiving paths newly introduced by this hop.
 * @param discoveredKeys - Encoded paths authorized by the canonical discovery predicate.
 */
function addSensePassEnvironment(
  graph: PerspectiveGraph,
  evaluator: ClaimEvaluator,
  edgePath: Path,
  extra: Map<string, Path>,
  channel: SensoryChannel,
  reachableKeys: ReadonlySet<string>,
  adjacentKeys: Set<string>,
  discoveredKeys: ReadonlySet<string>,
): void {
  if (!isChannelOpen(graph, edgePath, channel)) return
  if (!edgeSourceReachable(graph, edgePath, reachableKeys)) return
  const target = sensePassTarget(graph, edgePath)
  if (target.kind === 'none') return
  const targetInstance = graph.instance(target.value)
  if (targetInstance.kind === 'none') return
  const targetVisibility = graph.instanceVisibility(targetInstance.value)
  if (targetVisibility === 'self') return
  if (
    targetVisibility === 'ref' &&
    !hiddenCandidateReachable(evaluator, discoveredKeys, target.value)
  )
    return
  const collected = new Map<string, Path>()
  expandContainment(graph, target.value, collected, channel)
  for (const [key, path] of collected) {
    if (!survivesObserverExclusions(graph, evaluator, path)) continue
    // Only paths that this hop introduces are hop-derived. Personal
    // discoveries already present in `extra` stay legitimate origins.
    const discoveredEarlier = extra.has(key)
    if (addPath(extra, path) && !discoveredEarlier) adjacentKeys.add(key)
  }
}

/**
 * Live direct-perception candidate for one surface field.
 *
 * The candidate carries the real current value so divergence checks observe
 * the same payload the raw public projection would emit. Hidden fields yield
 * `NONE`; visibility is resolved through the graph's effective runtime rule.
 *
 * @param graph - Current graph view for visibility.
 * @param instance - Owning instance.
 * @param field - Surface candidate field.
 * @returns The live candidate, or `NONE` when the field is not publicly live.
 */
function fieldLive(
  graph: PerspectiveGraph,
  instance: StructInstance,
  field: FieldNode,
): Option<LiveFacetInput> {
  if (graphFieldHidden(graph, instance, field)) return NONE
  if (field.value.kind === 'none') return NONE
  const summary = field.meta.summary
  return some({
    kind: 'direct_scope',
    value: field.value.value,
    summary: typeof summary === 'string' ? some(summary) : NONE,
  })
}

/**
 * Whether a field is absent from the standard public surface.
 *
 * Effective runtime visibility and effective instance visibility are both
 * consulted, so `$meta.visibility` overrides cannot smuggle private fields
 * into the raw public prefix.
 *
 * @param graph - Current graph view for effective visibility.
 * @param instance - Owning instance.
 * @param field - Field to classify.
 * @returns True when the field is not publicly visible.
 */
function graphFieldHidden(
  graph: PerspectiveGraph,
  instance: StructInstance,
  field: FieldNode,
): boolean {
  if (graph.fieldVisibility(field) !== 'surface') return true
  return graph.instanceVisibility(instance) !== 'surface'
}

/**
 * Whether a fold is exactly the standard raw public surface.
 *
 * A raw public prefix contains no memory facet at all: only the injected live
 * `direct_scope` producer may survive. An exclusion that removes every facet,
 * any persisted observation, or a coexisting rumor — including an
 * `override: false` alternative that would otherwise ride along in
 * `additionalFacets` — forces the isolated per-observer view.
 *
 * @param fold - Folded instance or field result.
 * @returns True when the fold is the pure one-facet live public surface.
 */
function isStandardPublicFold(fold: FoldResult): boolean {
  return fold.facets.length === 1 && fold.facets[0]!.sourceKind === 'direct_scope'
}

/**
 * Whether the observer's public domains diverge from the raw public surface.
 *
 * Both channels must be enabled with a shared ceiling, and every public
 * instance and public field fold must be the standard live-only surface.
 * Inspecting all surviving facets (not only `primary`) prevents any private
 * alternate account from entering a supposedly byte-identical shared prefix.
 *
 * @param graph - Current graph view.
 * @param evaluator - Claim evaluator for the observer.
 * @param sight - Resolved sight channel.
 * @param sound - Resolved sound channel.
 * @returns True when a private or filtered view must be used.
 */
function diverges(
  graph: PerspectiveGraph,
  evaluator: ClaimEvaluator,
  sight: ChannelScopeState,
  sound: ChannelScopeState,
): boolean {
  if (!sight.enabled || !sound.enabled) return true
  if (sight.ceiling.kind === 'none' || sound.ceiling.kind === 'none') return true
  if (!pathsEqual(sight.ceiling.value, sound.ceiling.value)) return true
  const domains = new Map<string, Path>([...sight.publicPaths, ...sound.publicPaths])
  for (const [key, path] of domains) {
    const instance = graph.instance(path)
    if (instance.kind === 'none') continue
    if (!survivesObserverExclusions(graph, evaluator, path)) return true
    if (!isStandardPublicFold(evaluator.fold(path, LIVE_INSTANCE))) return true
    for (const field of instance.value.fields.values()) {
      if (graphFieldHidden(graph, instance.value, field)) continue
      const channel = field.spec.metadata.sense === 'sound' ? 'sound' : 'sight'
      const domain = channel === 'sight' ? sight : sound
      if (!domain.publicPaths.has(key)) continue
      const live = fieldLive(graph, instance.value, field)
      if (live.kind === 'none') continue
      if (!isStandardPublicFold(evaluator.fold(field.path, live.value))) return true
    }
  }
  return false
}

/**
 * Full observer scope for one staged body at one fixed view.
 *
 * Callers must already have resolved `actorPath` to an existing struct
 * instance; a missing actor is a caller error and throws via graph access.
 */
export function computeObserverScope(
  graph: PerspectiveGraph,
  evaluator: ClaimEvaluator,
  actorPath: Path,
): ObserverScopeState {
  const sight = computeChannel(graph, evaluator, actorPath, 'sight')
  const sound = computeChannel(graph, evaluator, actorPath, 'sound')
  const divergence = diverges(graph, evaluator, sight, sound)
  return Object.freeze({
    actor: actorPath,
    sight,
    sound,
    canUseRawPublicScope: !divergence,
    divergence,
  })
}

/**
 * Body co-witnesses for one observed field.
 *
 * Recorder and candidate bodies must remain publicly visible, preserving the
 * one-way anti-spoiler rule for hidden observers. The target must be in their
 * own unblocked public channel domains under the same ceiling. Each candidate
 * is checked against its own inherited/individual exclusions, including exact
 * field exclusions, independently of whichever content facet wins its fold.
 * Only public body path keys are stored, never delegation roots.
 *
 * @param graph - Current graph of public bodies and containment.
 * @param scope - Recording body's effective scope.
 * @param targetPath - Field being observed.
 * @param channel - Target's sensory channel.
 * @param resolveWitness - Resolve each candidate's own context, or `NONE` if
 *   it is not an observer body. Callers may cache stable contexts per sync.
 * @returns Sorted public body keys of observers authorized to perceive it.
 */
export function coWitnessesFor(
  graph: PerspectiveGraph,
  scope: ObserverScopeState,
  targetPath: Path,
  channel: SensoryChannel,
  resolveWitness: (body: Path) => Option<WitnessContext>,
): readonly string[] {
  if (!scope.sight.enabled) return []
  const actor = graph.instance(scope.actor)
  if (actor.kind === 'none' || graph.instanceVisibility(actor.value) !== 'surface') return []
  const channelScope = channel === 'sight' ? scope.sight : scope.sound
  const actorKey = encodePathKey(scope.actor)
  const targetInstance = fieldInstancePath(targetPath)
  const targetKey = encodePathKey(targetInstance)
  if (!channelScope.unblockedPaths.has(targetKey)) return []
  const actorCeiling = channelScope.ceiling
  if (actorCeiling.kind === 'none') return []
  const actorCeilingKey = encodePathKey(actorCeiling.value)
  const keys: string[] = []
  for (const [key, candidate] of scope.sight.unblockedPaths) {
    if (key === actorKey) continue
    if (!channelScope.unblockedPaths.has(key)) continue
    const witness = resolveWitness(candidate)
    if (witness.kind === 'none') continue
    const candidateScope =
      channel === 'sight' ? witness.value.scope.sight : witness.value.scope.sound
    if (!candidateScope.enabled || !candidateScope.unblockedPaths.has(targetKey)) continue
    if (!witness.value.evaluator.allowsLive(targetPath)) continue
    if (
      candidateScope.ceiling.kind === 'none' ||
      encodePathKey(candidateScope.ceiling.value) !== actorCeilingKey
    )
      continue
    keys.push(key)
  }
  return Object.freeze(keys.sort(compareUtf8))
}
