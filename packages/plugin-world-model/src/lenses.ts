/**
 * Lens types for the twelve registered world-model roots.
 *
 * Lenses are created by {@link WorldModelService}; these aliases keep the
 * public `lenses` map precisely typed without hard-coding builder internals.
 */

import type { LensFor, MapLens, SchemaNode, SchemaNodeOf } from '@sekaisen/plugin-schema'
import type {
  AbilitySchema,
  AgendaSchema,
  BeatSchema,
  CharacterSchema,
  FuseSchema,
  ItemSchema,
  LocationSchema,
  LoreSchema,
  OrganizationSchema,
  RelationSchema,
  RouteSchema,
  WorldRootSchema,
} from './schemas.ts'

/** Concrete lens of the global world root. */
export type WorldRootLens = LensFor<SchemaNodeOf<typeof WorldRootSchema>>

/** Concrete defaulted Map lens for one entity collection. */
export type EntityMapLens<TSchema extends SchemaNode> = MapLens<
  SchemaNodeOf<TSchema>,
  { readonly mode: 'defaulted' }
>

/** Strongly typed lenses registered by the world model. */
export interface WorldModelLenses {
  readonly world: WorldRootLens
  readonly locations: EntityMapLens<typeof LocationSchema>
  readonly routes: EntityMapLens<typeof RouteSchema>
  readonly characters: EntityMapLens<typeof CharacterSchema>
  readonly organizations: EntityMapLens<typeof OrganizationSchema>
  readonly relations: EntityMapLens<typeof RelationSchema>
  readonly items: EntityMapLens<typeof ItemSchema>
  readonly abilities: EntityMapLens<typeof AbilitySchema>
  readonly lores: EntityMapLens<typeof LoreSchema>
  readonly fuses: EntityMapLens<typeof FuseSchema>
  readonly agendas: EntityMapLens<typeof AgendaSchema>
  readonly beats: EntityMapLens<typeof BeatSchema>
}
