/**
 * `ctx.worldModel`: declarative objective-world model service.
 *
 * Registers the `['world']` singleton, eleven `['entities', <kind>]`
 * collections and four typed message kinds, then installs the twelve-rule
 * final-draft validator. Reads are pure; every mutation requires a
 * `SchemaTransaction` so CAS, cascades and rollback remain schema-owned.
 *
 * Dependency direction is strictly one-way:
 * `plugin-world -> plugin-schema -> plugin-perspective -> plugin-world-model`.
 */

import type { Option, Result } from '@sekaisen/core'
import type {
  CognitiveMemoryTreeNode,
  ObserverRef,
  PerspectiveError,
} from '@sekaisen/plugin-perspective'
import type {
  LensFor,
  MessagePrism,
  MessageStructSchemaNode,
  ReadonlySchemaView,
  SchemaNode,
  SchemaTransaction,
} from '@sekaisen/plugin-schema'
import { s } from '@sekaisen/plugin-schema'
import type { CommitHash, Path } from '@sekaisen/plugin-world'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { inspectEntityTree as inspectTree } from './entity-tree.ts'
import type { WorldModelLenses } from './lenses.ts'
import type { WorldModelMessages } from './messages.ts'
import {
  CarryOverPatchMessageSchema,
  L0StepMessageSchema,
  ManualEditMessageSchema,
  MemoryArchiveMessageSchema,
} from './messages.ts'
import {
  assignItem as assign,
  consumeTriggeredFuse as consume,
  grantAbility as grant,
  pauseFuse as pause,
  resumeFuse as resume,
} from './mutators.ts'
import { checkWatchedPathsChanged as watched } from './queries.ts'
import {
  ABILITY_ROOT_PATH,
  AbilitySchema,
  AGENDA_ROOT_PATH,
  AgendaSchema,
  BEAT_ROOT_PATH,
  BeatSchema,
  CHARACTER_ROOT_PATH,
  CharacterSchema,
  FUSE_ROOT_PATH,
  FuseSchema,
  ITEM_ROOT_PATH,
  ItemSchema,
  LOCATION_ROOT_PATH,
  LORE_ROOT_PATH,
  LocationSchema,
  LoreSchema,
  ORGANIZATION_ROOT_PATH,
  OrganizationSchema,
  RELATION_ROOT_PATH,
  RelationSchema,
  ROUTE_ROOT_PATH,
  RouteSchema,
  WORLD_ROOT_PATH,
  WorldRootSchema,
} from './schemas.ts'
import type {
  GrantAssetKnowledgeOptions,
  ObjectiveEntityTreeNode,
  WorldModelServiceApi,
} from './types.ts'
import { validateWorldModel } from './validation.ts'

declare module 'cordis' {
  interface Context {
    worldModel: WorldModelService
  }
}

function defineRoot<TSchema extends SchemaNode>(
  ctx: Context,
  path: Path,
  schema: TSchema,
): LensFor<TSchema> {
  const lens = ctx.schema.define(path, schema)
  if (!lens.ok) throw new Error(`WorldModelService failed to register ${path.join('/')}`)
  return lens.value
}

function defineMessage<TKind extends string, TSchema extends MessageStructSchemaNode>(
  ctx: Context,
  kind: TKind,
  schema: TSchema,
): MessagePrism<TKind, TSchema> {
  const prism = ctx.schema.defineMessage(kind, schema)
  if (!prism.ok) throw new Error(`WorldModelService failed to register message ${kind}`)
  return prism.value
}

/**
 * Objective world-model service. Construct after `ctx.world`, `ctx.schema` and
 * `ctx.perspective` exist; registration writes no commit.
 */
export class WorldModelService extends Service implements WorldModelServiceApi {
  /** World, schema and perspective are hard dependencies. */
  static inject = ['world', 'schema', 'perspective']

  readonly lenses: WorldModelLenses
  readonly messages: WorldModelMessages

  constructor(ctx: Context) {
    if (!ctx.schema) throw new Error('WorldModelService requires ctx.schema')
    if (!ctx.world) throw new Error('WorldModelService requires ctx.world')
    if (!ctx.perspective) throw new Error('WorldModelService requires ctx.perspective')
    super(ctx, 'worldModel')

    this.lenses = Object.freeze({
      world: defineRoot(ctx, WORLD_ROOT_PATH, WorldRootSchema),
      locations: defineRoot(ctx, LOCATION_ROOT_PATH, s.map(LocationSchema)),
      routes: defineRoot(ctx, ROUTE_ROOT_PATH, s.map(RouteSchema)),
      characters: defineRoot(ctx, CHARACTER_ROOT_PATH, s.map(CharacterSchema)),
      organizations: defineRoot(ctx, ORGANIZATION_ROOT_PATH, s.map(OrganizationSchema)),
      relations: defineRoot(ctx, RELATION_ROOT_PATH, s.map(RelationSchema)),
      items: defineRoot(ctx, ITEM_ROOT_PATH, s.map(ItemSchema)),
      abilities: defineRoot(ctx, ABILITY_ROOT_PATH, s.map(AbilitySchema)),
      lores: defineRoot(ctx, LORE_ROOT_PATH, s.map(LoreSchema)),
      fuses: defineRoot(ctx, FUSE_ROOT_PATH, s.map(FuseSchema)),
      agendas: defineRoot(ctx, AGENDA_ROOT_PATH, s.map(AgendaSchema)),
      beats: defineRoot(ctx, BEAT_ROOT_PATH, s.map(BeatSchema)),
    })

    this.messages = Object.freeze({
      l0Step: defineMessage(ctx, 'l0_step', L0StepMessageSchema),
      memoryArchive: defineMessage(ctx, 'memory_archive', MemoryArchiveMessageSchema),
      manualEdit: defineMessage(ctx, 'manual_edit', ManualEditMessageSchema),
      carryOverPatch: defineMessage(ctx, 'carry_over_patch', CarryOverPatchMessageSchema),
    })

    ctx.schema.addCommitValidator(({ parentId, message, draft, diff }) =>
      validateWorldModel(
        {
          schema: this.ctx.schema,
          world: this.ctx.world,
          perspective: this.ctx.perspective,
          lenses: this.lenses,
          messages: this.messages,
        },
        { parentId, message, draft, diff },
      ),
    )
  }

  assignItem(
    tx: SchemaTransaction,
    itemId: string,
    holderPath: Option<Path>,
    ownerPaths?: readonly Path[],
    knowledgeOptions?: GrantAssetKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return assign(this.mutatorDeps(), tx, itemId, holderPath, ownerPaths, knowledgeOptions)
  }

  grantAbility(
    tx: SchemaTransaction,
    abilityId: string,
    ownerPath: Path,
    knowledgeOptions?: GrantAssetKnowledgeOptions,
  ): Result<void, PerspectiveError> {
    return grant(this.mutatorDeps(), tx, abilityId, ownerPath, knowledgeOptions)
  }

  pauseFuse(tx: SchemaTransaction, fuseId: string): Result<void, PerspectiveError> {
    return pause(this.mutatorDeps(), tx, fuseId)
  }

  resumeFuse(tx: SchemaTransaction, fuseId: string): Result<void, PerspectiveError> {
    return resume(this.mutatorDeps(), tx, fuseId)
  }

  consumeTriggeredFuse(tx: SchemaTransaction, fuseId: string): Result<void, PerspectiveError> {
    return consume(this.mutatorDeps(), tx, fuseId)
  }

  checkWatchedPathsChanged(
    commitId: CommitHash,
    watcherPath: Path,
  ): Result<readonly Path[], PerspectiveError> {
    return watched(
      { schema: this.ctx.schema, world: this.ctx.world, lenses: this.lenses },
      commitId,
      watcherPath,
    )
  }

  inspectEntityTree(
    commitIdOrView: CommitHash | ReadonlySchemaView,
    rootEntityPath: Path,
  ): Result<Option<ObjectiveEntityTreeNode>, PerspectiveError> {
    return inspectTree({ schema: this.ctx.schema }, commitIdOrView, rootEntityPath)
  }

  inspectCognitiveMemoryTree(
    commitIdOrView: CommitHash | ReadonlySchemaView,
    observer: ObserverRef,
  ): Result<readonly CognitiveMemoryTreeNode[], PerspectiveError> {
    return this.ctx.perspective.inspectCognitiveMemoryTree(commitIdOrView, observer)
  }

  private mutatorDeps() {
    return { perspective: this.ctx.perspective, lenses: this.lenses }
  }
}

export default WorldModelService
