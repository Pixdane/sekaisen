import type { None, Option, Result, Some } from '@sekaisen/core'
import type {
  AdvanceHeadInput,
  CommitHash,
  CommitNode,
  Path,
  StateDiff,
  StateRef,
  Value,
  WorldError,
} from '@sekaisen/plugin-world'

/* -------------------------------------------------------------------------- */
/*                          Schema algebra (AST)                             */
/* -------------------------------------------------------------------------- */

/** State-tree leaf value tags (scalars, scalar lists and cross-commit references). */
export type LeafValueKind =
  | 'bool'
  | 'num'
  | 'str'
  | 'bytes'
  | 'ref'
  | 'list:bool'
  | 'list:num'
  | 'list:str'
  | 'list:bytes'

/** Commit-message leaf tags: messages never carry `StateRef` values. */
export type MessageLeafValueKind = Exclude<LeafValueKind, 'ref'>

/**
 * Leaf existence policy: required values must be supplied, defaulted values
 * materialize their declared default, and optional values may be absent.
 * Optional struct fields read as `Option`; lens reads always return an outer
 * `Option` regardless of the node's presence mode.
 */
export type LeafPresence =
  | { readonly mode: 'required' }
  | { readonly mode: 'defaulted'; readonly defaultValue: Value | StateRef }
  | { readonly mode: 'optional' }

/**
 * Container existence policy. Defaulted containers materialize an empty Map
 * or a struct's defaults; optional containers remain absent until written.
 * Map membership is independent of the value schema's presence mode.
 */
export type ContainerPresence =
  | { readonly mode: 'required' }
  | { readonly mode: 'defaulted' }
  | { readonly mode: 'optional' }

/**
 * Declarative node metadata, distinct from per-instance leaf metadata.
 * Keys must be non-empty, well-formed Unicode strings; values follow world's
 * `Value` algebra. Builder `.meta()` calls merge keys rather than replacing
 * the whole dictionary.
 */
export type SchemaMetaMap = Readonly<Record<string, Value>>

/**
 * Open, declaration-mergeable metadata accepted by every builder `.meta()`.
 *
 * Upper plugins extend this interface with `declare module '@sekaisen/plugin-schema'`
 * to obtain compile-time checks for their declarative markers (visibility,
 * salience, link roles, ...) while `plugin-schema` itself stays domain-free.
 * Every present key is persisted flat under `['$schemas', ..., 'metadata', key]`
 * and must be a legal {@link Value}; nesting arrays is forbidden. An `undefined`
 * value means "leave this key unchanged" and is never persisted, so `.meta()`
 * calls compose without having to delete keys explicitly.
 *
 * @example
 * ```ts
 * declare module '@sekaisen/plugin-schema' {
 *   interface SchemaNodeMeta {
 *     readonly visibility?: 'surface' | 'self' | 'ref'
 *   }
 * }
 * ```
 */
export interface SchemaNodeMeta {
  readonly [key: string]: Value | undefined
}

/** Leaf node definition. */
export interface LeafSchemaNode<
  TValueKind extends LeafValueKind = LeafValueKind,
  TPresence extends LeafPresence = LeafPresence,
> {
  readonly nodeKind: 'leaf'
  readonly valueKind: TValueKind
  readonly presence: TPresence
  readonly description: string
  readonly metadata: SchemaMetaMap
}

/** Named struct node definition. */
export interface StructSchemaNode<
  TFields extends Readonly<Record<string, SchemaNode>> = Readonly<Record<string, SchemaNode>>,
  TAllowCustom extends boolean = boolean,
  TPresence extends ContainerPresence = ContainerPresence,
> {
  readonly nodeKind: 'struct'
  readonly fields: TFields
  readonly allowCustom: TAllowCustom
  /**
   * `defaulted` when every child is `defaulted` or `optional`, `required`
   * otherwise. `.optional()` always widens it to `optional`.
   */
  readonly presence: TPresence
  readonly description: string
  readonly metadata: SchemaMetaMap
}

/** Dynamic-key dictionary node definition. */
export interface MapSchemaNode<
  TValueSchema extends SchemaNode = SchemaNode,
  TPresence extends ContainerPresence = ContainerPresence,
> {
  readonly nodeKind: 'map'
  /** Structure of every existing dynamic entry; entries are always present values. */
  readonly valueSchema: TValueSchema
  /** Defaults to `defaulted` (an omitted map materializes as `{}`). */
  readonly presence: TPresence
  readonly description: string
  readonly metadata: SchemaMetaMap
}

/** Closed state-schema algebra: typed leaves, named structs and dynamic Maps. */
export type SchemaNode = LeafSchemaNode | StructSchemaNode | MapSchemaNode

/**
 * Plain AST shape of `S`, with fluent builder methods removed and literal
 * `valueKind`/`presence` generics preserved. `cloneSchema` and every public
 * builder/lens boundary return this shape, so callers are never promised
 * methods that the deep-owned AST does not carry.
 */
export type SchemaNodeOf<S extends SchemaNode> = SchemaNode extends S
  ? S
  : MessageSchemaNode extends S
    ? S
    : SchemaNodeShape<S> extends infer R extends SchemaNode
      ? R
      : never

type SchemaNodeShape<S> =
  S extends LeafSchemaNode<
    infer TValueKind extends LeafValueKind,
    infer TPresence extends LeafPresence
  >
    ? LeafSchemaNode<TValueKind, TPresence>
    : S extends StructSchemaNode<
          infer TFields extends Readonly<Record<string, SchemaNode>>,
          infer TAllowCustom extends boolean,
          infer TPresence extends ContainerPresence
        >
      ? StructSchemaNode<SchemaFieldsOf<TFields>, TAllowCustom, TPresence>
      : S extends MapSchemaNode<
            infer TValueSchema extends SchemaNode,
            infer TPresence extends ContainerPresence
          >
        ? MapSchemaNode<SchemaNodeOf<TValueSchema>, TPresence>
        : never

/** Plain AST shape of a struct field dictionary. */
export type SchemaFieldsOf<TFields extends Readonly<Record<string, SchemaNode>>> = {
  readonly [K in keyof TFields]: SchemaNodeOf<TFields[K]>
}

/* -------------------------------------------------------------------------- */
/*                       Commit-message schema variants                      */
/* -------------------------------------------------------------------------- */

/** Message leaf definition; references are forbidden, including in defaults. */
export interface MessageLeafSchemaNode extends Omit<LeafSchemaNode, 'valueKind' | 'presence'> {
  readonly valueKind: MessageLeafValueKind
  readonly presence:
    | { readonly mode: 'required' }
    | { readonly mode: 'defaulted'; readonly defaultValue: Value }
    | { readonly mode: 'optional' }
}

/** Named message fields; instance-specific custom keys are forbidden. */
export interface MessageStructSchemaNode<
  TFields extends Readonly<Record<string, MessageSchemaNode>> = Readonly<
    Record<string, MessageSchemaNode>
  >,
  TPresence extends ContainerPresence = ContainerPresence,
> extends Omit<StructSchemaNode<TFields, false, TPresence>, 'fields' | 'allowCustom'> {
  readonly fields: TFields
  readonly allowCustom: false
}

/** Message dictionary whose concrete entries follow one message value schema. */
export interface MessageMapSchemaNode<
  TValueSchema extends MessageSchemaNode = MessageSchemaNode,
  TPresence extends ContainerPresence = ContainerPresence,
> extends Omit<MapSchemaNode<TValueSchema, TPresence>, 'valueSchema'> {
  readonly valueSchema: TValueSchema
}

/** Closed message-schema algebra, excluding state references and custom fields. */
export type MessageSchemaNode =
  | MessageLeafSchemaNode
  | MessageStructSchemaNode
  | MessageMapSchemaNode

/* -------------------------------------------------------------------------- */
/*                            Type-level inference                          */
/* -------------------------------------------------------------------------- */

/** Static JavaScript type for each leaf value tag. */
export type LeafValueTypeMap = {
  bool: boolean
  num: number
  str: string
  bytes: Uint8Array
  ref: StateRef
  'list:bool': readonly boolean[]
  'list:num': readonly number[]
  'list:str': readonly string[]
  'list:bytes': readonly Uint8Array[]
}

/**
 * Core input type of a node, ignoring its own presence wrapper.
 * The `SchemaNode extends S` guard terminates infinite expansion for an
 * uninstantiated `SchemaNode` generic.
 */
export type InferCoreInput<S extends SchemaNode> = SchemaNode extends S
  ? unknown
  : S extends LeafSchemaNode
    ? LeafValueTypeMap[S['valueKind']]
    : S extends StructSchemaNode<infer TFields, boolean, ContainerPresence>
      ? InferStructInput<TFields>
      : S extends MapSchemaNode<infer TVal, ContainerPresence>
        ? Readonly<Record<string, InferCoreInput<TVal>>>
        : never

/** Core output type of a node, ignoring its own presence wrapper. */
export type InferCoreOutput<S extends SchemaNode> = SchemaNode extends S
  ? unknown
  : S extends LeafSchemaNode
    ? LeafValueTypeMap[S['valueKind']]
    : S extends StructSchemaNode<infer TFields, infer TAllowCustom, ContainerPresence>
      ? InferStructOutput<TFields, TAllowCustom>
      : S extends MapSchemaNode<infer TVal, ContainerPresence>
        ? Readonly<Record<string, InferCoreOutput<TVal>>>
        : never

/**
 * Full input type of a node, including its own presence wrapper:
 * optional accepts the core value or `Option`/`null`/`undefined`, defaulted
 * accepts the core value or `undefined`, required accepts only the core value.
 */
export type InferInput<S extends SchemaNode> = SchemaNode extends S
  ? unknown
  : S['presence']['mode'] extends 'optional'
    ? InferCoreInput<S> | Option<InferCoreInput<S>> | null | undefined
    : S['presence']['mode'] extends 'defaulted'
      ? InferCoreInput<S> | undefined
      : InferCoreInput<S>

/**
 * Full output type of a node, including its own presence wrapper:
 * optional yields `Option<core>`, required/defaulted yield the core value.
 */
export type InferOutput<S extends SchemaNode> = SchemaNode extends S
  ? unknown
  : S['presence']['mode'] extends 'optional'
    ? Option<InferCoreOutput<S>>
    : InferCoreOutput<S>

/** Struct write input: required fields mandatory, defaulted omitted, optional nullable. */
export type InferStructInput<TFields extends Readonly<Record<string, SchemaNode>>> = {
  readonly [K in keyof TFields as TFields[K]['presence']['mode'] extends 'required'
    ? K
    : never]: InferCoreInput<TFields[K]>
} & {
  readonly [K in keyof TFields as TFields[K]['presence']['mode'] extends 'defaulted' ? K : never]?:
    | InferCoreInput<TFields[K]>
    | undefined
} & {
  readonly [K in keyof TFields as TFields[K]['presence']['mode'] extends 'optional' ? K : never]?:
    | InferCoreInput<TFields[K]>
    | Option<InferCoreInput<TFields[K]>>
    | null
    | undefined
}

/** Struct read output: optional fields become `Option`, customs become `$custom`. */
export type InferStructOutput<
  TFields extends Readonly<Record<string, SchemaNode>>,
  TAllowCustom extends boolean = false,
> = {
  readonly [K in keyof TFields]: TFields[K]['presence']['mode'] extends 'optional'
    ? Option<InferCoreOutput<TFields[K]>>
    : InferCoreOutput<TFields[K]>
} & (TAllowCustom extends true
  ? {
      readonly $custom: Readonly<
        Record<
          string,
          {
            readonly value: Value | StateRef
            readonly meta: SchemaMetaMap
            readonly spec: LeafSchemaNode
          }
        >
      >
    }
  : unknown)

/** Derived initial presence of a struct node. */
export type DefaultStructPresence<TFields extends Readonly<Record<string, SchemaNode>>> = keyof {
  [K in keyof TFields as TFields[K]['presence']['mode'] extends 'required' ? K : never]: true
} extends never
  ? { readonly mode: 'defaulted' }
  : { readonly mode: 'required' }

/* -------------------------------------------------------------------------- */
/*                                  Optics                                  */
/* -------------------------------------------------------------------------- */

/** Lens over one concrete struct instance and the fields it owns. */
export interface StructLens<
  TFields extends Readonly<Record<string, SchemaNode>> = Readonly<Record<string, SchemaNode>>,
  TAllowCustom extends boolean = boolean,
  TPresence extends ContainerPresence = ContainerPresence,
> {
  readonly opticKind: 'struct'
  readonly path: Path
  readonly schema: StructSchemaNode<TFields, TAllowCustom, TPresence>
  /** Top-level field names this lens explicitly owns. */
  readonly scopedFields: ReadonlySet<string>
  /** Attribute sugar: `lens.$.field`. */
  readonly $: {
    readonly [K in keyof TFields]: LensFor<TFields[K]>
  }
  /** Focus a declared field; an unknown key throws a schema validation failure. */
  field<K extends keyof TFields & string>(key: K): LensFor<TFields[K]>
  /**
   * Create a typed custom-key handle without creating instance data.
   * Reads/writes check the stored leaf kind against `expectedSchema`.
   * Use `SchemaTransaction.defineCustom` to create the key first.
   */
  custom<TLeaf extends LeafSchemaNode>(
    customKey: string,
    expectedSchema: TLeaf,
  ): CustomFieldLens<PlainLeafNode<TLeaf>>
  /** Create a custom-key handle for raw reads or deletion without leaf-kind evidence. */
  customUntyped(customKey: string): UntypedCustomFieldLens
}

/** Lens over a dynamic-key dictionary directory. */
export interface MapLens<
  TValueSchema extends SchemaNode = SchemaNode,
  TPresence extends ContainerPresence = ContainerPresence,
> {
  readonly opticKind: 'map'
  readonly path: Path
  readonly schema: MapSchemaNode<TValueSchema, TPresence>
  /**
   * Focus a dynamic entry without creating it. IDs must be non-empty,
   * well-formed strings without a `$` prefix; invalid IDs throw.
   * Missing entries read as `NONE`, never as the value schema's default.
   */
  at(instanceId: string): EntryLensFor<TValueSchema>
}

/** Normalized plain leaf shape for a leaf schema type. */
export type PlainLeafNode<S extends LeafSchemaNode> =
  SchemaNodeOf<S> extends infer L extends LeafSchemaNode ? L : never

/** Lens for a `Map.at(id)` entry (add/remove semantics regardless of value schema). */
export type EntryLensFor<S extends SchemaNode> =
  S extends StructSchemaNode<infer TFields, infer TAllowCustom, ContainerPresence>
    ? StructLens<SchemaFieldsOf<TFields>, TAllowCustom, { readonly mode: 'optional' }>
    : S extends MapSchemaNode<infer TVal, ContainerPresence>
      ? MapLens<SchemaNodeOf<TVal>, { readonly mode: 'optional' }>
      : S extends LeafSchemaNode
        ? FieldLens<
            Omit<PlainLeafNode<S>, 'presence'> & {
              readonly presence: { readonly mode: 'optional' }
            }
          >
        : never

/** Map a schema node to the matching lens type with plain (builder-free) AST generics. */
export type LensFor<S extends SchemaNode> =
  S extends StructSchemaNode<infer TFields, infer TAllowCustom, infer TPresence>
    ? StructLens<SchemaFieldsOf<TFields>, TAllowCustom, TPresence>
    : S extends MapSchemaNode<infer TVal, infer TPresence>
      ? MapLens<SchemaNodeOf<TVal>, TPresence>
      : S extends LeafSchemaNode
        ? FieldLens<PlainLeafNode<S>>
        : never

/** Lens over a declared leaf field. */
export interface FieldLens<TLeaf extends LeafSchemaNode = LeafSchemaNode> {
  readonly opticKind: 'field'
  readonly path: Path
  readonly schema: TLeaf
}

/** Lens over an instance-specific custom key with explicit leaf evidence. */
export interface CustomFieldLens<TLeaf extends LeafSchemaNode = LeafSchemaNode> {
  readonly opticKind: 'custom'
  readonly instancePath: Path
  readonly customKey: string
  readonly path: Path
  readonly expectedSchema: TLeaf
}

/** Untyped instance-specific custom key handle (delete / raw read). */
export interface UntypedCustomFieldLens {
  readonly opticKind: 'custom_untyped'
  readonly instancePath: Path
  readonly customKey: string
  readonly path: Path
}

/** Every readable lens accepted by `SchemaService.get` / `ReadonlySchemaView.get`. */
export type AnyReadableLens = StructLens | MapLens | FieldLens | CustomFieldLens

/** Returned value type of `get(lens)`, wrapped in `Option` by the reader. */
export type LensOutput<TLens extends AnyReadableLens> =
  TLens extends StructLens<infer TFields, infer TAllowCustom, ContainerPresence>
    ? InferStructOutput<TFields, TAllowCustom>
    : TLens extends MapLens<infer TVal, ContainerPresence>
      ? Readonly<Record<string, InferCoreOutput<TVal>>>
      : TLens extends FieldLens<infer TLeaf>
        ? LeafValueTypeMap[TLeaf['valueKind']]
        : TLens extends CustomFieldLens<infer TLeaf>
          ? LeafValueTypeMap[TLeaf['valueKind']]
          : never

/* -------------------------------------------------------------------------- */
/*                             Fluent builders                              */
/* -------------------------------------------------------------------------- */

/**
 * Immutable fluent leaf builder. Every modifier returns a new builder.
 * Once composed into another node, the child is exposed as a plain AST.
 * Invalid defaults, descriptions or metadata throw schema failures.
 */
export interface LeafBuilder<
  TKind extends LeafValueKind = LeafValueKind,
  TPresence extends LeafPresence = { readonly mode: 'required' },
> extends LeafSchemaNode {
  readonly valueKind: TKind
  readonly presence: TPresence
  /** Make the leaf defaulted, validating and copying the supplied value. */
  default(
    defaultValue: LeafValueTypeMap[TKind],
  ): LeafBuilder<
    TKind,
    { readonly mode: 'defaulted'; readonly defaultValue: LeafValueTypeMap[TKind] }
  >
  /** Make the leaf optional, discarding any previous default. */
  optional(): LeafBuilder<TKind, { readonly mode: 'optional' }>
  /** Set a well-formed Unicode description; it does not impose a value constraint. */
  desc(description: string): LeafBuilder<TKind, TPresence>
  /** Merge declarative metadata, validating keys and copying values. */
  meta(meta: SchemaNodeMeta): LeafBuilder<TKind, TPresence>
}

/** Immutable struct builder; initial presence is derived from its declared fields. */
export interface StructBuilder<
  TFields extends Readonly<Record<string, SchemaNode>> = Readonly<Record<string, SchemaNode>>,
  TAllowCustom extends boolean = false,
  TPresence extends ContainerPresence = DefaultStructPresence<TFields>,
> extends StructSchemaNode<TFields, TAllowCustom, TPresence> {
  /** Allow instance-specific typed custom leaves in addition to declared fields. */
  extensible(): StructBuilder<TFields, true, TPresence>
  /** Make the container optional without changing its children's presence modes. */
  optional(): StructBuilder<TFields, TAllowCustom, { readonly mode: 'optional' }>
  /** Set a well-formed Unicode description on a new builder. */
  desc(description: string): StructBuilder<TFields, TAllowCustom, TPresence>
  /** Merge validated declarative metadata on a new builder. */
  meta(meta: SchemaNodeMeta): StructBuilder<TFields, TAllowCustom, TPresence>
}

/** Immutable Map builder; defaulted Maps start empty and never create implicit entries. */
export interface MapBuilder<
  TValueSchema extends SchemaNode = SchemaNode,
  TPresence extends ContainerPresence = { readonly mode: 'defaulted' },
> extends MapSchemaNode<TValueSchema, TPresence> {
  /** Make the whole Map optional; entry membership rules are unchanged. */
  optional(): MapBuilder<TValueSchema, { readonly mode: 'optional' }>
  /** Set a well-formed Unicode description on a new builder. */
  desc(description: string): MapBuilder<TValueSchema, TPresence>
  /** Merge validated declarative metadata on a new builder. */
  meta(meta: SchemaNodeMeta): MapBuilder<TValueSchema, TPresence>
}

/* -------------------------------------------------------------------------- */
/*                          Graph links (foreign keys)                      */
/* -------------------------------------------------------------------------- */

/** Behaviour applied to live referencing edges when a linked target disappears. */
export type OnDeletePolicy = 'reject' | 'cascade' | 'unlink'

/**
 * Declarative traits of a graph foreign key built by `s.link` / `s.linkList`.
 *
 * Links are ordinary `str` / `list:str` leaves whose values are canonical
 * `encodePathKey(targetInstancePath)` strings; the traits are stored as flat
 * metadata on the leaf so a Writer catalog is self-describing:
 * `$linkTargetRoots`, `$linkTargetRootsDynamic`, `$linkAcyclic`,
 * `$linkExclusiveRole`, `$linkOnDelete`.
 *
 * Registration rules (checked by `define` / `augment`):
 * - a single-target `s.link` with `onDelete: 'unlink'` MUST be optional, so the
 *   relation can legally become `NONE`;
 * - a multi-target `s.linkList` MUST NOT declare `exclusiveRole`.
 */
export interface LinkTraits {
  /**
   * Target root paths this link may point into, e.g.
   * `[['entities', 'character'], ['entities', 'location']]`.
   *
   * Must be a non-empty array of non-empty identifier paths. Targets are
   * matched with `encodePathKey` prefix semantics.
   */
  readonly targetRoots: readonly Path[]
  /**
   * Explicit opt-in for dynamically registered target roots.
   *
   * When `true`, final link validation additionally accepts a target when it is
   * a live Struct instance under ANY currently registered Writer root of the
   * commit's catalog. Static `targetRoots` still apply and remain mandatory, so
   * this is an add-on (never a replacement) for `hostEntity`-style links whose
   * concrete roots are owned and registered by other plugins after this schema
   * was defined. Targets must still exist and be Struct instances; the flag is
   * persisted (`$linkTargetRootsDynamic`) so historical Writer catalogs keep
   * identical validation semantics.
   */
  readonly dynamicTargetRoots?: boolean
  /**
   * Reject cycles along the union of links sharing the same role tags
   * (`exclusiveRole` and/or metadata `linkRoles`), e.g. `A.master -> B` plus
   * `B.controller -> A`. Once ANY declaration in a union requests acyclicity,
   * every live edge of that union participates, including fields that omit the
   * flag. Activation is a Schema declaration fact: it applies even when the
   * marked field has no live instance or its list is empty. Untagged
   * declarations form a union with themselves (across concrete instances) by
   * schema-declaration identity, never a global untagged union.
   *
   * A link leaf must be owned by a Struct instance (`s.struct` field, including
   * augmented fields); a registered root leaf or a root Map of link values is
   * rejected at registration because backlinks require a source instance.
   */
  readonly acyclic?: boolean
  /**
   * Exclusive relation group (`'parent'`, `'delegate'`, ...). Only legal on a
   * single-target `s.link`: one instance may have at most one non-empty link
   * per exclusive role, guaranteeing a strict single-parent tree.
   */
  readonly exclusiveRole?: string
  /** Target-deletion policy; defaults to `'reject'`. */
  readonly onDelete?: OnDeletePolicy
}

/**
 * Link constructors merged into {@link SchemaBuilders} (`s.link` / `s.linkList`).
 * Both build plain `str` / `list:str` leaves whose trait metadata is validated
 * immediately; registration-time rules are enforced by the schema service.
 */
export interface SchemaBuildersLinkExtension {
  /** Required single-target foreign key (`str` leaf storing an encoded instance path). */
  link(traits: LinkTraits): LeafBuilder<'str'>
  /** Required multi-target foreign key (`list:str` leaf of encoded instance paths). */
  linkList(traits: LinkTraits): LeafBuilder<'list:str'>
}

/** Fluent schema factories; compose configured children before registration. */
export interface SchemaBuilders extends SchemaBuildersLinkExtension {
  /** Build a required boolean leaf. */
  bool(): LeafBuilder<'bool'>
  /** Build a required finite-number leaf; domain constraints require a validator. */
  num(): LeafBuilder<'num'>
  /** Build a required well-formed Unicode string leaf. */
  str(): LeafBuilder<'str'>
  /** Build a required byte-array leaf; stored and returned buffers are copied. */
  bytes(): LeafBuilder<'bytes'>
  /** Build a required cross-commit reference leaf, not allowed in message schemas. */
  ref(): LeafBuilder<'ref'>
  /** Build a required homogeneous scalar-list leaf; nested lists and refs are forbidden. */
  list<TItem extends 'bool' | 'num' | 'str' | 'bytes'>(
    itemKind: TItem,
  ): LeafBuilder<`list:${TItem}`>
  /**
   * Copy named fields into a plain AST. The struct is required if any direct
   * child is required, otherwise defaulted; it initially disallows customs.
   * Field names must be non-empty, well-formed strings without a `$` prefix.
   */
  struct<TFields extends Readonly<Record<string, SchemaNode>>>(
    fields: TFields,
  ): StructBuilder<SchemaFieldsOf<TFields>, false, DefaultStructPresence<SchemaFieldsOf<TFields>>>
  /** Copy the value schema into a plain AST and build a defaulted, initially empty Map. */
  map<TValueSchema extends SchemaNode>(
    valueSchema: TValueSchema,
  ): MapBuilder<SchemaNodeOf<TValueSchema>, { readonly mode: 'defaulted' }>
}

/* -------------------------------------------------------------------------- */
/*                        Drift reports & inspection                        */
/* -------------------------------------------------------------------------- */

/** Nodes whose missing concrete instances can be materialized without a converter. */
export interface BackfillableSchemaDrift {
  readonly schemaPath: Path
  /** `added_defaulted_node` or `optional_to_defaulted`. */
  readonly reason: 'added_defaulted_node' | 'optional_to_defaulted'
  readonly targetSpec: SchemaNode
  readonly backfillInstanceCount: number
}

/** Declarative or presence changes requiring sync but no explicit converter. */
export interface CompatiblePresenceDrift {
  readonly schemaPath: Path
  /**
   * Presence relaxation or a benign declarative change. `default_value_updated`
   * also covers description / metadata / allowCustom / message-schema edits.
   */
  readonly reason: 'added_optional_node' | 'relaxed_to_optional' | 'default_value_updated'
  readonly targetSpec: SchemaNode
}

/** Compatible custom leaves that can move into newly declared formal fields. */
export interface PromotedCustomFieldDrift {
  readonly structSchemaPath: Path
  readonly fieldKey: string
  readonly targetLeafSpec: LeafSchemaNode
  readonly instancePaths: readonly Path[]
}

/** Writer-only definitions, retained by default and removed only by explicit pruning. */
export interface DormantSchemaDrift {
  readonly schemaPath: Path
  readonly writerSpec: SchemaNode
  readonly existingInstanceCount: number
}

/** A schema transition whose affected instances require an explicit migration. */
export interface IncompatibleSchemaDrift {
  readonly schemaPath: Path
  readonly reason:
    | 'type_changed'
    | 'node_kind_changed'
    | 'added_required_node_with_existing_instances'
    | 'optional_tightened_to_required_with_missing_values'
    | 'custom_field_type_conflict'
    | 'custom_disabled_with_existing_instances'
  readonly writerSpec: Option<SchemaNode>
  readonly readerSpec: SchemaNode
  readonly affectedInstancePaths: readonly Path[]
}

/**
 * Writer-versus-Reader comparison at one commit. `schemaPath` coordinates in
 * findings use `*` for Map entries; instance paths contain concrete IDs.
 * Dormant definitions alone do not make `isClean` false.
 */
export interface SchemaDriftReport {
  readonly commitId: CommitHash
  readonly isClean: boolean
  readonly backfillableNodes: readonly BackfillableSchemaDrift[]
  readonly compatibleChanges: readonly CompatiblePresenceDrift[]
  readonly promotedCustomFields: readonly PromotedCustomFieldDrift[]
  readonly dormantSchemas: readonly DormantSchemaDrift[]
  readonly incompatibilities: readonly IncompatibleSchemaDrift[]
}

/** A copied leaf value with instance metadata and its effective leaf definition. */
export interface FieldValueWithMeta<T> {
  readonly value: T
  readonly meta: SchemaMetaMap
  readonly spec: LeafSchemaNode
}

/** Physical historical leaf decoded according to its stored Writer Schema. */
export interface HistoricalLeafInspection {
  readonly nodeKind: 'leaf'
  readonly path: Path
  readonly writerSpec: LeafSchemaNode
  readonly value: Value | StateRef
  readonly meta: SchemaMetaMap
}

/** Historical struct including Writer fields, dormant names, instance custom leaves and instance metadata. */
export interface HistoricalStructInspection {
  readonly nodeKind: 'struct'
  readonly path: Path
  readonly writerSpec: StructSchemaNode
  readonly fields: Readonly<Record<string, Option<HistoricalNodeInspection>>>
  readonly dormantFieldKeys: readonly string[]
  readonly customFields: Readonly<Record<string, FieldValueWithMeta<Value | StateRef>>>
  /**
   * Instance-level runtime metadata copied from `[...path, '$meta', key]`.
   * Symmetric with leaf metadata: it overrides declarative defaults per
   * instance and is never interpreted by the schema layer itself.
   */
  readonly meta: SchemaMetaMap
}

/** Historical Map containing only physically present, concrete entries. */
export interface HistoricalMapInspection {
  readonly nodeKind: 'map'
  readonly path: Path
  readonly writerSpec: MapSchemaNode
  readonly entries: Readonly<Record<string, HistoricalNodeInspection>>
}

/** Writer-faithful inspection result; unlike a logical read, it does not invent defaults. */
export type HistoricalNodeInspection =
  | HistoricalLeafInspection
  | HistoricalStructInspection
  | HistoricalMapInspection

/**
 * Result of resolving an arbitrary {@link StateRef}.
 *
 * `$message` refs address the commit's decoded message payload instead of the
 * state tree, so they resolve to a message kind plus an optional sub-value.
 * Every other ref faithfully inspects the historical state node it names.
 */
export type ResolvedStateRefValue =
  | {
      readonly targetKind: 'state_node'
      /** Historical node at `(ref.commitId, ref.path)`; `NONE` when physically absent. */
      readonly inspection: Option<HistoricalNodeInspection>
    }
  | {
      readonly targetKind: 'commit_message'
      /** Decoded message kind (`'$text'` for plain string messages). */
      readonly messageKind: string
      /** Value at `ref.path.slice(1)` inside the decoded payload; `NONE` when absent. */
      readonly value: Option<unknown>
    }

/* -------------------------------------------------------------------------- */
/*                                Errors                                    */
/* -------------------------------------------------------------------------- */

/** Stable reason codes for rejected schema inputs and transaction operations. */
export type SchemaValidationReason =
  | 'missing_required_field'
  | 'type_mismatch'
  | 'cannot_delete_non_optional_node'
  | 'custom_not_allowed_on_struct'
  | 'custom_key_shadows_struct_field'
  | 'undefined_custom_key'
  | 'instance_not_found'
  /** A `reject` link still points at an instance removed by this operation. */
  | 'referenced_target_not_deletable'
  /** A link value does not encode an existing, permitted Struct instance. */
  | 'invalid_link_target'
  /** The role union of acyclic links would contain a directed cycle. */
  | 'link_cycle'
  /** Two non-empty links of the same exclusive role exist on one instance. */
  | 'exclusive_link_conflict'

/**
 * Expected schema-layer failures returned by Result-based APIs.
 * Transaction mutators and fluent builders throw schema failures; a surrounding
 * `commit` converts those failures into `Err`. Unrelated exceptions propagate.
 */
export type SchemaError =
  | {
      readonly kind: 'invalid_schema_identifier'
      readonly identifier: string
      readonly reason: string
    }
  | {
      readonly kind: 'schema_conflict'
      readonly path: Path
      readonly reason:
        | 'duplicate_definition'
        | 'overlapping_root_path'
        | 'mandatory_field_in_augment'
        | 'augment_target_not_struct'
        | 'field_name_collision'
        | 'ref_not_allowed_in_message'
        /** Single-target link with `onDelete: 'unlink'` must be optional. */
        | 'link_unlink_requires_optional'
        /** `exclusiveRole` is only meaningful on single-target links. */
        | 'link_list_exclusive_role_forbidden'
        /**
         * A link leaf is reachable from a registered root without crossing a
         * Struct instance (for example root `s.link()` or root
         * `s.map(s.link())`). Backlinks and validation are Struct-owned, so
         * such placements would otherwise be registered but silently skipped.
         */
        | 'link_source_struct_required'
        /**
         * A custom leaf definition carries `$link*` metadata. Custom leaves are
         * not traversed by the link scanners, so they cannot own backlinks or
         * participate in link validation.
         */
        | 'link_custom_field_forbidden'
        /** `$link*` metadata is malformed or attached to a non-string leaf. */
        | 'invalid_link_traits'
    }
  | {
      readonly kind: 'schema_drift_requires_sync'
      readonly commitId: CommitHash
      readonly reason: string
    }
  | {
      readonly kind: 'schema_type_mismatch'
      readonly commitId: CommitHash
      readonly path: Path
      readonly expectedKind: string
      readonly actualKind: string
    }
  | {
      readonly kind: 'unmigrated_required_field'
      readonly commitId: CommitHash
      readonly path: Path
    }
  | {
      readonly kind: 'corrupted_instance_data'
      readonly commitId: CommitHash
      readonly path: Path
      readonly reason: string
    }
  | {
      readonly kind: 'validation_failed'
      readonly path: Path
      readonly reason: SchemaValidationReason
      readonly detail: string
    }
  | {
      readonly kind: 'validator_rejected'
      readonly path: Path
      readonly validatorName: string
      readonly reason: string
    }
  | {
      readonly kind: 'incompatible_schema_drift'
      readonly commitId: CommitHash
      readonly incompatibilities: readonly IncompatibleSchemaDrift[]
      readonly migrationError?: string
    }
  | {
      readonly kind: 'message_decode_error'
      readonly commitId: CommitHash
      readonly reason: string
    }
  | {
      readonly kind: 'world_error'
      readonly error: WorldError
    }

/* -------------------------------------------------------------------------- */
/*                         Migration & service API                          */
/* -------------------------------------------------------------------------- */

/** Any subtree value a migration function may return. */
export type MigrationInputValue =
  | Value
  | StateRef
  | None
  | Some<MigrationInputValue>
  | { readonly $val: Value | StateRef; readonly $meta?: SchemaMetaMap }
  | {
      readonly [key: string]: MigrationInputValue | undefined
    }

/**
 * Synchronous, pure converter for one concrete target node. All inspections
 * read the immutable pre-migration commit, not earlier converter results.
 * Return `ok(value)` using the target node's input shape, or `err(reason)` to
 * abort sync with `incompatible_schema_drift`. Unrelated thrown exceptions
 * propagate. Promoted leaf converters may return `NONE` to remove an optional
 * target or reset a defaulted target while retaining its instance metadata.
 */
export type NodeMigrationFn = (ctx: {
  /** Concrete destination path; Map wildcards have been replaced by instance IDs. */
  readonly targetNodePath: Path
  /** Writer-faithful source node, or `NONE` for a newly added, previously absent node. */
  readonly oldInspection: Option<HistoricalNodeInspection>
  /** Inspect another logical path in the same immutable source commit. */
  readonly inspectBeforeMigration: (
    nodePath: Path,
  ) => Result<Option<HistoricalNodeInspection>, SchemaError>
}) => Result<MigrationInputValue, string>

/** Explicit schema synchronization of an existing named head. */
export interface SyncSchemaOptions {
  /** Head to migrate; an explicit `expected` adds the world's CAS requirement. */
  readonly head: string | AdvanceHeadInput
  /** Keep Writer-only definitions/data by default; prune removes uncovered dormant data. */
  readonly dormantPolicy?: 'keep' | 'prune'
  /**
   * Converters keyed by `encodePathKey(schemaPath)`, using `*` at Map entry
   * positions. A converter runs per affected concrete instance, not once per
   * schema definition. Incompatible existing instances require a converter.
   */
  readonly fieldMigrations?: Readonly<Record<string, NodeMigrationFn>>
}

/** Discriminated message payload; schema commits encode registered kinds as binary data. */
export interface TypedCommitMessage<TKind extends string = string, TData = unknown> {
  readonly kind: TKind
  readonly data: TData
}

/** Typed message constructor/parser with a copied, builder-free schema AST. */
export interface MessagePrism<TKind extends string, TSchema extends MessageStructSchemaNode> {
  readonly kind: TKind
  readonly schema: SchemaNodeOf<TSchema>
  /**
   * Validate input, copy values and materialize defaults. Optional fields use
   * genuine `some()`/`NONE` wrappers, or raw values/null/undefined on input;
   * same-shaped plain business objects are not Options.
   * @throws A schema failure when the input does not satisfy this schema.
   */
  create(input: InferCoreInput<TSchema>): TypedCommitMessage<TKind, InferCoreOutput<TSchema>>
  /**
   * Validate and normalize a generic decoded message. A different kind yields
   * `ok(NONE)`; an invalid matching payload yields `Err<SchemaError>`.
   * This checks the prism's schema, not the original commit's Writer Schema.
   */
  parse(raw: TypedCommitMessage): Result<Option<InferCoreOutput<TSchema>>, SchemaError>
}

/** Parent selection, optional head advancement and message for a schema commit. */
export interface SchemaCommitOptions {
  /** Explicit parent takes precedence over `head`; `NONE` creates a root commit. */
  readonly parentId?: Option<CommitHash>
  /**
   * Head to advance atomically. Without `parentId`, its current value selects
   * the parent; without an explicit expectation, CAS expects that parent.
   * Omitting both `parentId` and `head` creates a root without advancing a head.
   */
  readonly head?: string | AdvanceHeadInput
  /** Plain text, or a typed payload whose kind must be actively registered. */
  readonly message: TypedCommitMessage | string
}

/**
 * Read-only logical access using Writer definitions and a captured Reader catalog.
 * Historical views read requested payloads lazily from a fixed World commit;
 * transaction views observe their current draft. Reads may synthesize defaults
 * without persisting them. Missing optional ancestors and Map members short-circuit
 * to absence; incompatible kinds, unmigrated required nodes and detected Writer
 * corruption return structured errors.
 */
export interface ReadonlySchemaView {
  /**
   * Read a lens's core value in an outer `Option`. An optional field within a
   * returned struct has its own `Option`; a direct leaf read is not double-wrapped.
   */
  get<TLens extends AnyReadableLens>(lens: TLens): Result<Option<LensOutput<TLens>>, SchemaError>

  /** Read a copied leaf value, its instance metadata and effective spec; virtual defaults have no metadata. */
  getWithMeta<TLeaf extends LeafSchemaNode>(
    fieldLens: FieldLens<TLeaf> | CustomFieldLens<TLeaf>,
  ): Result<Option<FieldValueWithMeta<LeafValueTypeMap[TLeaf['valueKind']]>>, SchemaError>

  /** Read a custom leaf using its stored kind instead of caller-supplied type evidence. */
  getCustomUntyped(
    lens: UntypedCustomFieldLens,
  ): Result<Option<FieldValueWithMeta<Value | StateRef>>, SchemaError>

  /**
   * List concrete Map member IDs in path order; an absent Map yields an empty array.
   * Member values are read and validated, just as for a Map get; this is not a
   * shallow physical directory listing that bypasses malformed-member errors.
   */
  listKeys(mapLens: MapLens): Result<readonly string[], SchemaError>

  /**
   * Root paths addressable by trusted introspection in this fixed view: the
   * union of the captured Reader roots and the view's Writer roots (including
   * Writer-only dormant roots), deduplicated and sorted by UTF-8 key. Map roots
   * are included. Mutation-addressable lenses remain Reader-only.
   */
  listRootPaths(): readonly Path[]

  /**
   * Inspect the physical node at a logical path using the Writer catalog bound
   * to this view. Unlike `get`, defaults are never invented: absent nodes yield
   * `NONE` and only physically stored fields/custom leaves are returned.
   * On a transaction this reads the current draft, including writer-faithful
   * physical layout of nodes created earlier in the same callback.
   */
  inspectInstance(nodePath: Path): Result<Option<HistoricalNodeInspection>, SchemaError>

  /**
   * Resolve the Writer declaration at `nodePath` without reading or requiring a
   * physical value, ancestor container or concrete Map member.
   *
   * Traversal starts at the longest matching Writer root bound to this view and
   * walks declared Struct fields, Map value schemas (every concrete member ID
   * resolves to the same value declaration) and stored instance-specific custom
   * leaf specs. A declared optional leaf, an absent Map member and any nested
   * path below an absent ancestor therefore still yield their declaration.
   * Historical views use the Writer catalog stored in their commit, so later
   * Reader registrations and active Reader-only definitions never leak into an
   * old view. Transaction drafts use the same Writer-faithful basis as
   * {@link ReadonlySchemaView.inspectInstance}, so declarations created in the
   * current draft (root definitions for a new root commit and custom specs
   * written earlier in the callback) are visible.
   *
   * The returned AST is a deep, frozen copy owned by the caller; no state is
   * materialized and no write occurs. Paths outside the Writer catalog, paths
   * that descend through a leaf, and unknown custom keys yield `NONE`. A stored
   * custom declaration that is structurally malformed (including a missing
   * `$spec`) surfaces as `corrupted_instance_data` rather than `NONE`; an
   * absent `$spec` for an unknown custom key remains `NONE`.
   */
  writerSchemaAt(nodePath: Path): Result<Option<SchemaNode>, SchemaError>

  /**
   * Build the real lens for any path covered by a captured Reader root:
   * Struct instances, Map roots, concrete Map entries (dynamic IDs) and nested
   * declared field paths. Map-entry lenses are normalized to optional presence,
   * mirroring `mapLens.at(id)`, so `tx.delete` and optional writes accept them.
   * Paths outside the captured Reader catalog return `Err` (never a guess).
   */
  lensAt(nodePath: Path): Result<AnyReadableLens, SchemaError>

  /**
   * Read instance-level runtime metadata (`[...instancePath, '$meta', key]`).
   * `NONE` means the Struct instance is logically absent; a virtual defaulted
   * instance yields `some({})` because it has no physical metadata.
   */
  getInstanceMeta(lens: StructLens): Result<Option<SchemaMetaMap>, SchemaError>

  /**
   * Live incoming link edges pointing at `targetInstancePath` in this exact view.
   *
   * Backed by an index built from the view's physical state that is bound to the
   * view (fixed commit or current draft) and invalidated whenever the draft
   * changes, so results never leak across commits or stale drafts. Locating the
   * target bucket is O(1); copying/filtering the `k` results is O(k). Only
   * currently live edges are returned: the source instance must exist and its
   * link leaf must currently point at the target.
   */
  backlinks(
    targetInstancePath: Path,
    filter?: BacklinkQueryFilter,
  ): Result<readonly BacklinkEntry[], SchemaError>
}

/** Struct patch input: every key optional; only optional fields accept null/NONE. */
export type InferStructPatch<TFields extends Readonly<Record<string, SchemaNode>>> = {
  readonly [K in keyof TFields]?: TFields[K]['presence']['mode'] extends 'optional'
    ? InferCoreInput<TFields[K]> | Option<InferCoreInput<TFields[K]>> | null | undefined
    : InferCoreInput<TFields[K]> | undefined
}

/** Lenses accepted by `tx.delete` (required/defaulted intrinsic nodes excluded). */
export type DeletableLens =
  | StructLens<Readonly<Record<string, SchemaNode>>, boolean, { readonly mode: 'optional' }>
  | MapLens<SchemaNode, { readonly mode: 'optional' }>
  | FieldLens<LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }>
  | CustomFieldLens
  | UntypedCustomFieldLens

/** One live incoming graph edge found by {@link ReadonlySchemaView.backlinks}. */
export interface BacklinkEntry {
  /** Path of the source Struct instance emitting the reference. */
  readonly sourceInstancePath: Path
  /** Registered root path the source instance belongs to. */
  readonly sourceRootPath: Path
  /** Link field path relative to `sourceInstancePath` (e.g. `['pet', 'owner']`). */
  readonly fieldRelativePath: Path
  /** Full leaf definition of the link field, including its `$link*` metadata. */
  readonly fieldSpec: LeafSchemaNode
  /** Copy of the field's target-deletion policy. */
  readonly onDelete: OnDeletePolicy
}

/** Optional narrowing applied by {@link ReadonlySchemaView.backlinks}. */
export interface BacklinkQueryFilter {
  /** Only return edges whose source instance belongs to this registered root. */
  readonly sourceRootPath?: Path
  /**
   * Custom predicate over the link field's full leaf definition, e.g. filtering
   * on `fieldSpec.metadata['linkRoles']`. Throwing propagates to the caller.
   */
  readonly filterFieldSpec?: (spec: LeafSchemaNode) => boolean
}

/**
 * Mutable draft supplied only to the synchronous `SchemaService.commit` callback.
 * Mutations affect subsequent reads in this draft, not the parent commit.
 * The draft lazily overlays the immutable parent and owns written payloads.
 * Reads require the backing World storage to remain available.
 * Required ancestors must already exist; mutation methods throw schema failures
 * rather than returning `Result`. Let failures escape to reject the draft;
 * individual mutators are not savepoints, so wrap a group whose caught failure
 * must not leave partial writes in {@link SchemaTransaction.atomic}.
 * Mutation methods throw after the callback ends. Use `some()`/`NONE` for
 * actual Option wrappers; plain `kind`/`value` objects remain business data.
 */
export interface SchemaTransaction extends ReadonlySchemaView {
  /**
   * Run a synchronous callback as one draft savepoint.
   *
   * Every physical write made by `operation` — values, deletes, custom leaf
   * definitions and metadata — is isolated through the draft's nested rollback
   * journals. If `operation` returns normally, the savepoint is accepted and
   * its writes merge into any enclosing scope. If it throws, every enclosed
   * write is restored to the state captured at entry and the exact thrown value
   * crosses this boundary unchanged; the caller may catch it, keep earlier
   * (pre-savepoint) writes and either continue or let the draft commit them.
   *
   * Scopes nest: an inner successful savepoint is undone by an outer rollback,
   * and link-cascade scopes opened by mutators compose with the savepoint.
   * This is a synchronous-only primitive; returning a thenable throws
   * `TypeError` and rolls the savepoint back. The transaction must still be
   * active. This method is deliberately absent from
   * {@link ReadonlySchemaView}.
   *
   * @param operation Synchronous draft mutation closure.
   * @returns The callback's return value after the savepoint is accepted.
   * @throws The callback's exact thrown value after rolling its writes back.
   */
  atomic<T>(operation: () => T): T

  /**
   * Replace fields owned by the struct lens, preserving out-of-scope augment,
   * dormant and custom data on an existing instance. Omitted owned optional
   * fields are removed and defaulted fields reset; required fields must be
   * supplied. Omitting an existing defaulted struct recursively resets its
   * owned fields without deleting its extensions. Optional containers accept
   * `null`/`NONE` to remove the whole node.
   */
  set<
    TFields extends Readonly<Record<string, SchemaNode>>,
    TAllowCustom extends boolean,
    TPresence extends ContainerPresence,
  >(
    lens: StructLens<TFields, TAllowCustom, TPresence>,
    input: TPresence extends { readonly mode: 'optional' }
      ? InferStructInput<TFields> | Option<InferStructInput<TFields>> | null
      : InferStructInput<TFields>,
  ): void

  /**
   * Replace Map membership: omitted members are deleted, present members are
   * scoped-updated and new members initialized. Surviving entries retain
   * out-of-scope fields, customs and leaf metadata. Entry values must be
   * present even if the value schema is optional/defaulted.
   */
  set<TValueSchema extends SchemaNode, TPresence extends ContainerPresence>(
    lens: MapLens<TValueSchema, TPresence>,
    entries: TPresence extends { readonly mode: 'optional' }
      ?
          | Readonly<Record<string, InferCoreInput<TValueSchema>>>
          | Option<Readonly<Record<string, InferCoreInput<TValueSchema>>>>
          | null
      : Readonly<Record<string, InferCoreInput<TValueSchema>>>,
  ): void

  /**
   * Write a declared leaf, preserving its instance metadata. An optional leaf
   * or Map entry accepts `null`/`NONE` for deletion, or `some(value)` for a write.
   */
  set<TLeaf extends LeafSchemaNode>(
    lens: FieldLens<TLeaf>,
    value: TLeaf['presence'] extends { readonly mode: 'optional' }
      ? LeafValueTypeMap[TLeaf['valueKind']] | Option<LeafValueTypeMap[TLeaf['valueKind']]> | null
      : LeafValueTypeMap[TLeaf['valueKind']],
  ): void

  /** Write an already-defined custom leaf; stored leaf-kind evidence is checked. */
  set<TLeaf extends LeafSchemaNode>(
    lens: CustomFieldLens<TLeaf>,
    value: LeafValueTypeMap[TLeaf['valueKind']],
  ): void

  /**
   * Write a leaf and patch its instance metadata. Null metadata values delete
   * keys; omitted keys survive. All metadata keys/values are validated before
   * writing the leaf. This operation cannot store null as a metadata value.
   */
  setWithMeta<TLeaf extends LeafSchemaNode>(
    lens: FieldLens<TLeaf> | CustomFieldLens<TLeaf>,
    value: LeafValueTypeMap[TLeaf['valueKind']],
    meta: Readonly<Record<string, Value | null>>,
  ): void

  /**
   * Merge instance-level runtime metadata into a physically existing Struct.
   * Values are validated and copied before any write; `null` deletes that key,
   * and omitted keys survive. Absent or virtual instances fail with
   * `validation_failed` / `instance_not_found`; this never creates an instance
   * or touches fields, customs, leaf metadata or `$exists`.
   */
  setInstanceMeta(lens: StructLens, meta: Readonly<Record<string, Value | null>>): void

  /**
   * Update only supplied fields on an existing struct, within the lens scope.
   * Omitted or undefined keys are left unchanged; supplied composite values
   * use `set` semantics rather than a recursive partial merge.
   */
  patch<
    TFields extends Readonly<Record<string, SchemaNode>>,
    TAllowCustom extends boolean,
    TPresence extends ContainerPresence,
  >(
    lens: StructLens<TFields, TAllowCustom, TPresence>,
    partialInput: InferStructPatch<TFields>,
  ): void

  /**
   * Read/modify/write a declared leaf synchronously. Optional fields receive
   * an `Option` and may return `null`/`NONE` to delete. Required/defaulted fields
   * receive a core value. Transaction lifetime and ancestor existence are
   * checked before invoking the updater; its exceptions propagate.
   */
  update<TLeaf extends LeafSchemaNode>(
    lens: FieldLens<TLeaf>,
    updater: (
      current: TLeaf['presence'] extends { readonly mode: 'optional' }
        ? Option<LeafValueTypeMap[TLeaf['valueKind']]>
        : LeafValueTypeMap[TLeaf['valueKind']],
    ) => TLeaf['presence'] extends { readonly mode: 'optional' }
      ? LeafValueTypeMap[TLeaf['valueKind']] | Option<LeafValueTypeMap[TLeaf['valueKind']]> | null
      : LeafValueTypeMap[TLeaf['valueKind']],
  ): void

  /** Read/modify/write an existing custom leaf's core value; absence rejects before the updater runs. */
  update<TLeaf extends LeafSchemaNode>(
    lens: CustomFieldLens<TLeaf>,
    updater: (
      current: LeafValueTypeMap[TLeaf['valueKind']],
    ) => LeafValueTypeMap[TLeaf['valueKind']],
  ): void

  /**
   * Define an instance-specific leaf on an existing extensible struct.
   * The key cannot shadow active or dormant formal fields. Redefinition must
   * retain the stored leaf kind. A concrete initial value is always required,
   * regardless of the leaf's presence mode. Supplied metadata is validated
   * before writing and merged with existing metadata; omitted keys survive.
   */
  defineCustom<
    TFields extends Readonly<Record<string, SchemaNode>>,
    TPresence extends ContainerPresence,
    TLeaf extends LeafSchemaNode,
  >(
    lens: StructLens<TFields, true, TPresence>,
    customKey: string,
    leafSchema: TLeaf,
    initialValue: LeafValueTypeMap[TLeaf['valueKind']],
    meta?: SchemaMetaMap,
  ): CustomFieldLens<PlainLeafNode<TLeaf>>

  /**
   * Destructively replace a struct subtree, including custom data and metadata.
   * Unlike scoped `set`, out-of-scope values are not preserved: defaults are
   * reinitialized and an unsupplied out-of-scope required field rejects the write.
   */
  overwriteStruct<
    TFields extends Readonly<Record<string, SchemaNode>>,
    TAllowCustom extends boolean,
    TPresence extends ContainerPresence,
  >(lens: StructLens<TFields, TAllowCustom, TPresence>, input: InferStructInput<TFields>): void

  /**
   * Remove an optional node, concrete Map member or custom leaf with its subtree
   * and metadata. Required/defaulted intrinsic nodes are not deletable.
   * Deleting an absent permitted target is a no-op; custom evidence is checked.
   */
  delete(lens: DeletableLens): void
}

/**
 * Synchronous final-draft business rule, run after structural validation and
 * before world persistence by both `commit` and `syncSchema`.
 * Every registered rule runs on incremental commits and empty no-op diffs too;
 * structural validation records never cache business-rule acceptance.
 * Validators run in registration order from a registration snapshot; the
 * first `err({ path, validatorName, reason })` aborts with `validator_rejected`.
 * No commit/head update is performed by that schema operation on rejection.
 * Unrelated thrown exceptions propagate instead of becoming validator errors.
 *
 * Keep callbacks free of external side effects: rejecting a draft cannot undo
 * callback side effects or direct world writes. Async validators are unsupported.
 * Reads and direct `world.commit`/`world.rebase` do not invoke these rules.
 */
export type CommitValidatorFn = (ctx: {
  /** Parent of the candidate commit; `NONE` when creating a root. */
  readonly parentId: Option<CommitHash>
  /** Candidate message decoded with its Writer schema; plain strings use kind `$text`. */
  readonly message: TypedCommitMessage
  /** Read-only logical view of all final changes, including defaults and migrations. */
  readonly draft: ReadonlySchemaView
  /** Canonical physical tree diff, including schema/metadata writes; values are copied per validator. */
  readonly diff: StateDiff
}) => Result<void, { readonly path: Path; readonly validatorName: string; readonly reason: string }>

/**
 * Documented `SchemaService` surface. The concrete Cordis service class is
 * owned by `service.ts`; this interface breaks the type-only dependency cycle.
 */
export interface SchemaServiceApi {
  /**
   * Register a copied Reader root in the calling Cordis scope and return its lens.
   * Paths must be non-empty and use valid schema identifiers; active roots may
   * neither duplicate nor overlap. Disposing the scope unregisters the Reader
   * definition but does not delete historical data. Registration itself writes
   * no commit; existing histories may require `syncSchema`.
   */
  define<TSchema extends SchemaNode>(
    basePath: Path,
    schema: TSchema,
  ): Result<LensFor<TSchema>, SchemaError>

  /**
   * Register extra fields for a struct schema in the calling scope. Fields must
   * not collide with active fields or contain required nodes, recursively.
   * A target reached through `Map.at(id)` augments the schema for every entry,
   * not only that instance. The returned lens owns the target's base and extra
   * fields; the original lens retains its narrower write scope.
   */
  augment<
    TBaseFields extends Readonly<Record<string, SchemaNode>>,
    TAllowCustom extends boolean,
    TPresence extends ContainerPresence,
    TExtraFields extends Readonly<Record<string, SchemaNode>>,
  >(
    target: StructLens<TBaseFields, TAllowCustom, TPresence>,
    extraFields: TExtraFields,
  ): Result<
    StructLens<SchemaFieldsOf<TBaseFields & TExtraFields>, TAllowCustom, TPresence>,
    SchemaError
  >

  /**
   * Register a scoped message kind and return its typed prism. Kinds must be
   * unique identifiers; refs and extensible structs are forbidden recursively.
   * Persisted messages remain decodable through their Writer catalog after unload.
   */
  defineMessage<TKind extends string, TSchema extends MessageStructSchemaNode>(
    kind: TKind,
    schema: TSchema,
  ): Result<MessagePrism<TKind, TSchema>, SchemaError>

  /**
   * Register a synchronous final-draft rule for `commit` and `syncSchema`.
   * Each call is an independent registration, even for the same function.
   * @returns A disposer for this registration; the calling Cordis scope also owns its lifetime.
   * @see CommitValidatorFn for ordering, failure, side-effect and bypass guarantees.
   */
  addCommitValidator(validator: CommitValidatorFn): () => void

  /**
   * Capture a fixed World commit and the current Reader catalog as a reusable
   * logical view. Obtains the Writer catalog from a bounded subtree-revision
   * cache, parsing on a miss; state values remain lazy. Reader definitions are
   * captured independently of that cache.
   * Later Reader registrations do not change this view. The backing World commit
   * and storage must remain available for subsequent reads.
   */
  viewAt(commitId: CommitHash): Result<ReadonlySchemaView, SchemaError>

  /** Read through the current Reader schema; `NONE` means logical absence, not an invalid commit. */
  get<TLens extends AnyReadableLens>(
    commitId: CommitHash,
    lens: TLens,
  ): Result<Option<LensOutput<TLens>>, SchemaError>

  /** Read a leaf plus instance metadata and effective spec through the current Reader schema. */
  getWithMeta<TLeaf extends LeafSchemaNode>(
    commitId: CommitHash,
    fieldLens: FieldLens<TLeaf> | CustomFieldLens<TLeaf>,
  ): Result<Option<FieldValueWithMeta<LeafValueTypeMap[TLeaf['valueKind']]>>, SchemaError>

  /** List logical Map member IDs after validating their values; absent Maps yield `[]`. */
  listKeys(commitId: CommitHash, mapLens: MapLens): Result<readonly string[], SchemaError>

  /**
   * Inspect physical historical data through the stored Writer Schema, including
   * dormant fields. The path is logical (not `$val`); no Reader defaults are invented.
   */
  inspectInstance(
    commitId: CommitHash,
    nodePath: Path,
  ): Result<Option<HistoricalNodeInspection>, SchemaError>

  /**
   * Decode binary messages using the commit's Writer message schema, even if its
   * plugin is unloaded. Plain strings return `{ kind: '$text', data: message }`.
   */
  getMessage(commitId: CommitHash): Result<TypedCommitMessage, SchemaError>

  /** Decode a commit message then parse with the supplied prism; a different kind yields `ok(NONE)`. */
  getMessageAs<TKind extends string, TSchema extends MessageStructSchemaNode>(
    commitId: CommitHash,
    prism: MessagePrism<TKind, TSchema>,
  ): Result<Option<InferCoreOutput<TSchema>>, SchemaError>

  /**
   * Resolve an arbitrary state reference.
   *
   * - `ref.path[0] === '$message'` decodes `getMessage(ref.commitId)` and walks
   *   `ref.path.slice(1)` through the payload, unwrapping `Option` wrappers so a
   *   caller may address nested optional fields directly. Absent sub-paths yield
   *   `ok({ targetKind: 'commit_message', messageKind, value: NONE })`.
   * - Every other ref faithfully inspects `(ref.commitId, ref.path)` through the
   *   stored Writer catalog, so historical values survive later mutation/deletion.
   *
   * Messaging requires the backing World commit; invalid refs return a
   * structured failure rather than throwing.
   */
  resolveRef(ref: StateRef): Result<ResolvedStateRefValue, SchemaError>

  /**
   * Apply one synchronous copy-on-write draft callback without copying the full
   * World state. Validate the final Writer-covered state and run every registered
   * business rule before atomically persisting the net diff through world.
   * Active schema drift requires prior sync; dormant-only drift is retained.
   * Returning `Err<SchemaError>` or throwing a schema failure rejects the draft.
   * Validator rejection or world CAS failure creates no commit for this call;
   * callback side effects are not rolled back. Ordinary exceptions, async
   * callbacks and reentrant schema writes throw rather than returning `Err`.
   * Exact physical restoration, including metadata, emits no diff operations;
   * a retained validated parent with unchanged Reader registrations enables
   * incremental structural checks and drift preflight reuse. Other parents and
   * changed registrations receive final full validation after the callback.
   * Definitions registered inside callbacks/validators do not certify the output
   * for the newer Reader snapshot; all business rules still run on every call.
   * @see SchemaCommitOptions for parent selection and head expectations.
   */
  commit(
    options: SchemaCommitOptions,
    mutate?: (tx: SchemaTransaction) => void | Result<void, SchemaError>,
  ): Result<CommitNode, SchemaError>

  /**
   * Compare the stored Writer catalog with active Reader definitions without
   * modifying state. Always computes the full report and instance counts;
   * validated-commit records do not suppress this explicit query.
   */
  checkDrift(commitId: CommitHash): Result<SchemaDriftReport, SchemaError>

  /**
   * Migrate the current tip of an existing head to the active Reader schema,
   * preserving dormant definitions unless explicitly pruned. Converters always
   * read the immutable source, isolated from earlier draft writes. The lazy
   * copy-on-write draft passes full structural and registered validator checks
   * before world commit/CAS; failure leaves this operation's commit and head
   * update unpersisted. Only the net diff is persisted; its message is `syncSchema`.
   */
  syncSchema(options: SyncSchemaOptions): Result<CommitNode, SchemaError>
}
