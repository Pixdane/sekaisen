/**
 * Objective entity tree inspection.
 *
 * Only incoming links whose source instance lives below `['entities']` are
 * followed. Perspective-owned entities (`['perspectives']`) can never leak into
 * this objective view. The recursive walk is guarded by the current ancestor
 * path, so cyclic `parent` or combined `parent`/`owner` graphs terminate.
 */

import type { Option, Result } from '@sekaisen/core'
import { NONE, some } from '@sekaisen/core'
import type { PerspectiveError } from '@sekaisen/plugin-perspective'
import { hasLinkRole } from '@sekaisen/plugin-perspective'
import type { ReadonlySchemaView, SchemaServiceApi } from '@sekaisen/plugin-schema'
import type { CommitHash, Path } from '@sekaisen/plugin-world'
import { encodePathKey } from '@sekaisen/plugin-world'
import { attemptWorldModel, domainFailure, expectSchema, fail } from './internal.ts'
import { entityCoordinates, pathStartsWith } from './paths.ts'
import { ENTITIES_ROOT_PATH } from './schemas.ts'
import type { ObjectiveEntityTreeNode } from './types.ts'

interface EntityTreeDeps {
  readonly schema: Pick<SchemaServiceApi, 'viewAt'>
}

function viewFrom(
  deps: EntityTreeDeps,
  commitIdOrView: CommitHash | ReadonlySchemaView,
): ReadonlySchemaView {
  if (typeof commitIdOrView !== 'string') return commitIdOrView
  return expectSchema(deps.schema.viewAt(commitIdOrView))
}

function fieldSnapshot(view: ReadonlySchemaView, path: Path): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = Object.create(null)
  const inspection = expectSchema(view.inspectInstance(path))
  if (inspection.kind === 'none') return fields
  const instance = inspection.value
  if (instance.nodeKind !== 'struct') return fields
  for (const name of Object.keys(instance.writerSpec.fields)) {
    const lens = view.lensAt([...path, name])
    if (!lens.ok) continue
    const value = view.get(lens.value)
    if (value.ok && value.value.kind === 'some') fields[name] = value.value.value
  }
  for (const [name, custom] of Object.entries(instance.customFields))
    if (!(name in fields)) fields[name] = custom.value
  return Object.freeze(fields)
}

function childPaths(
  view: ReadonlySchemaView,
  target: Path,
  role: 'parent' | 'owner',
  ancestors: ReadonlySet<string>,
): readonly Path[] {
  const links = expectSchema(
    view.backlinks(target, {
      filterFieldSpec: (spec) => hasLinkRole(spec, role),
    }),
  )
  const paths = new Map<string, Path>()
  for (const link of links) {
    if (!pathStartsWith(link.sourceRootPath, ENTITIES_ROOT_PATH)) continue
    const source = link.sourceInstancePath
    if (entityCoordinates(source) === undefined) continue
    const key = encodePathKey(source)
    if (ancestors.has(key) || paths.has(key)) continue
    paths.set(key, source)
  }
  return Object.freeze([...paths.values()])
}

function buildNode(
  view: ReadonlySchemaView,
  path: Path,
  ancestors: ReadonlySet<string>,
): ObjectiveEntityTreeNode {
  const coordinates = entityCoordinates(path)
  if (coordinates === undefined) throw new Error('Entity tree node outside registered entity roots')
  const key = encodePathKey(path)
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(key)
  return Object.freeze({
    path,
    kind: coordinates.kind,
    id: coordinates.id,
    fields: fieldSnapshot(view, path),
    containedChildren: Object.freeze(
      childPaths(view, path, 'parent', nextAncestors).map((child) =>
        buildNode(view, child, nextAncestors),
      ),
    ),
    ownedChildren: Object.freeze(
      childPaths(view, path, 'owner', nextAncestors).map((child) =>
        buildNode(view, child, nextAncestors),
      ),
    ),
  })
}

/** Assemble the objective tree rooted at one registered entity instance. */
export function inspectEntityTree(
  deps: EntityTreeDeps,
  commitIdOrView: CommitHash | ReadonlySchemaView,
  rootEntityPath: Path,
): Result<Option<ObjectiveEntityTreeNode>, PerspectiveError> {
  return attemptWorldModel(() => {
    if (entityCoordinates(rootEntityPath) === undefined)
      fail(domainFailure(rootEntityPath, 'invalid_entity_tree_root'))
    const view = viewFrom(deps, commitIdOrView)
    const inspection = expectSchema(view.inspectInstance(rootEntityPath))
    if (inspection.kind === 'none') return NONE
    if (inspection.value.nodeKind !== 'struct')
      fail(domainFailure(rootEntityPath, 'entity_tree_root_not_struct'))
    return some(buildNode(view, rootEntityPath, new Set<string>()))
  })
}
