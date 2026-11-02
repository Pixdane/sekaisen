/**
 * Closed tool-argument schema algebra (design document 02, section 1).
 *
 * The AST is self contained inside `@sekaisen/plugin-llm`: it deliberately has
 * no relationship with `@sekaisen/plugin-schema` (the state tree algebra has no
 * unions or object arrays). Only `@sekaisen/core` value types are consumed by
 * this module through the public result types in `tool-schema.ts`.
 */

/** Scalar values representable by a JSON literal node. */
export type ToolScalarValue = string | number | boolean

/* -------------------------------------------------------------------------- */
/*                              AST node shapes                               */
/* -------------------------------------------------------------------------- */

/** Modifier flags shared by every schema node. */
export interface ToolNodeModifiers<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
  TDefault = unknown,
> {
  readonly description?: string
  readonly isOptional: TOptional
  readonly isNullable: TNullable
  readonly hasDefault: THasDefault
  readonly defaultValue?: TDefault
}

/** String node with optional length bounds. */
export interface ToolStringNode<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, string> {
  readonly kind: 'str'
  readonly minLength?: number
  readonly maxLength?: number
}

/**
 * Numeric node (`integerOnly` distinguishes `t.int()` from `t.num()`).
 *
 * Bounds are stored as `minimum` / `maximum` because the fluent builder owns
 * the `min()` / `max()` method names; a node property named `min` cannot also
 * be a callable in TypeScript.
 */
export interface ToolNumberNode<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, number> {
  readonly kind: 'num'
  readonly integerOnly: boolean
  readonly minimum?: number
  readonly maximum?: number
}

/** Boolean node. */
export interface ToolBooleanNode<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, boolean> {
  readonly kind: 'bool'
}

/** Exact scalar literal node. */
export interface ToolLiteralNode<
  V extends ToolScalarValue = ToolScalarValue,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, V> {
  readonly kind: 'literal'
  readonly value: V
}

/** Closed string enumeration node. */
export interface ToolEnumNode<
  TValues extends readonly [string, ...string[]] = readonly [string, ...string[]],
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, TValues[number]> {
  readonly kind: 'enum'
  readonly values: TValues
}

/** Homogeneous array node. */
export interface ToolArrayNode<
  TItem extends ToolSchemaNode = ToolSchemaNode,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, readonly InferToolOutput<TItem>[]> {
  readonly kind: 'arr'
  readonly item: TItem
  readonly minItems?: number
  readonly maxItems?: number
}

/** Fixed object node with declared properties only. */
export interface ToolObjectNode<
  TProps extends Readonly<Record<string, ToolSchemaNode>> = Readonly<
    Record<string, ToolSchemaNode>
  >,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, InferObjectProps<TProps>> {
  readonly kind: 'obj'
  readonly properties: TProps
}

/**
 * Open dictionary node. Any tool containing one anywhere in its AST is
 * statically excluded from OpenAI strict mode and from the Anthropic strict
 * complexity budget.
 */
export interface ToolRecordNode<
  TVal extends ToolSchemaNode = ToolSchemaNode,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<
    TOptional,
    TNullable,
    THasDefault,
    Readonly<Record<string, InferToolOutput<TVal>>>
  > {
  readonly kind: 'record'
  readonly value: TVal
}

/** Untagged union of at least two variants. */
export interface ToolUnionNode<
  TVariants extends readonly [ToolSchemaNode, ToolSchemaNode, ...ToolSchemaNode[]] = readonly [
    ToolSchemaNode,
    ToolSchemaNode,
    ...ToolSchemaNode[],
  ],
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, InferToolOutput<TVariants[number]>> {
  readonly kind: 'union'
  readonly variants: TVariants
}

/* -------------------------------------------------------------------------- */
/*                            Structural AST shapes                           */
/* -------------------------------------------------------------------------- */

/**
 * Shared modifier surface of the closed AST. Shapes carry `defaultValue` as
 * `unknown` so the closed union never instantiates the inference types that
 * concrete nodes expose as their `defaultValue` parameter.
 */
export interface ToolNodeShape {
  readonly description?: string
  readonly isOptional: boolean
  readonly isNullable: boolean
  readonly hasDefault: boolean
  readonly defaultValue?: unknown
}

/** Structural string node. */
export interface ToolStringShape extends ToolNodeShape {
  readonly kind: 'str'
  readonly minLength?: number
  readonly maxLength?: number
}

/** Structural numeric node. */
export interface ToolNumberShape extends ToolNodeShape {
  readonly kind: 'num'
  readonly integerOnly: boolean
  readonly minimum?: number
  readonly maximum?: number
}

/** Structural boolean node. */
export interface ToolBooleanShape extends ToolNodeShape {
  readonly kind: 'bool'
}

/** Structural scalar literal node. */
export interface ToolLiteralShape extends ToolNodeShape {
  readonly kind: 'literal'
  readonly value: ToolScalarValue
}

/** Structural string-enum node. */
export interface ToolEnumShape extends ToolNodeShape {
  readonly kind: 'enum'
  readonly values: readonly [string, ...string[]]
}

/** Structural array node. */
export interface ToolArrayShape extends ToolNodeShape {
  readonly kind: 'arr'
  readonly item: ToolSchemaNode
  readonly minItems?: number
  readonly maxItems?: number
}

/** Structural object node. */
export interface ToolObjectShape extends ToolNodeShape {
  readonly kind: 'obj'
  readonly properties: Readonly<Record<string, ToolSchemaNode>>
}

/** Structural open-dictionary node. */
export interface ToolRecordShape extends ToolNodeShape {
  readonly kind: 'record'
  readonly value: ToolSchemaNode
}

/** Structural untagged union node. */
export interface ToolUnionShape extends ToolNodeShape {
  readonly kind: 'union'
  readonly variants: readonly [ToolSchemaNode, ToolSchemaNode, ...ToolSchemaNode[]]
}

/** Structural discriminated-union node. */
export interface ToolDiscriminatedUnionShape extends ToolNodeShape {
  readonly kind: 'discriminated_union'
  readonly discriminator: string
  readonly variants: readonly ToolObjectShape[]
}

/**
 * Default-instantiating `ToolDiscriminatedUnionNode` (whose discriminator
 * defaults to `string`) would require every variant property to be a literal
 * node. Concrete builders therefore only widen to this shape inside
 * {@link ToolSchemaNode}.
 */

/** Object variant accepted by `t.discriminatedUnion`. */
export type DiscriminatedVariantObject<D extends string> = ToolObjectNode<
  Readonly<
    Record<D, ToolLiteralNode<string, false, false, false>> & Record<string, ToolSchemaNode>
  >,
  false,
  false,
  false
>

/**
 * Tagged object union node. Structural invariants (verified both in the
 * constructor and in `validateToolDefinition`):
 *
 * 1. at least two variants, each a required non-nullable object without default;
 * 2. every variant owns `properties[discriminator]`, a required non-nullable
 *    non-empty string literal without default;
 * 3. discriminator tag values are pairwise distinct.
 */
export interface ToolDiscriminatedUnionNode<
  D extends string = string,
  TVariants extends readonly [
    DiscriminatedVariantObject<D>,
    DiscriminatedVariantObject<D>,
    ...DiscriminatedVariantObject<D>[],
  ] = readonly [
    DiscriminatedVariantObject<D>,
    DiscriminatedVariantObject<D>,
    ...DiscriminatedVariantObject<D>[],
  ],
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNodeModifiers<TOptional, TNullable, THasDefault, InferToolOutput<TVariants[number]>> {
  readonly kind: 'discriminated_union'
  readonly discriminator: D
  readonly variants: TVariants
}

/** Closed union of every legal tool schema node (structural shapes). */
export type ToolSchemaNode =
  | ToolStringShape
  | ToolNumberShape
  | ToolBooleanShape
  | ToolLiteralShape
  | ToolEnumShape
  | ToolArrayShape
  | ToolObjectShape
  | ToolRecordShape
  | ToolUnionShape
  | ToolDiscriminatedUnionShape

/* -------------------------------------------------------------------------- */
/*                       Compile-time output inference                        */
/* -------------------------------------------------------------------------- */

type Prettify<T> = { readonly [K in keyof T]: T[K] } & {}

/** Widened JSON value inferred for a structural (non-literal-flag) node. */
export type ToolSchemaOutput =
  | string
  | number
  | boolean
  | null
  | readonly ToolSchemaOutput[]
  | { readonly [key: string]: ToolSchemaOutput }

type KindOutput<S extends ToolSchemaNode> = S extends { readonly kind: 'str' }
  ? string
  : S extends { readonly kind: 'num' }
    ? number
    : S extends { readonly kind: 'bool' }
      ? boolean
      : S extends { readonly kind: 'literal'; readonly value: infer V extends ToolScalarValue }
        ? V
        : S extends {
              readonly kind: 'enum'
              readonly values: infer TValues extends readonly string[]
            }
          ? TValues[number]
          : S extends {
                readonly kind: 'arr'
                readonly item: infer TItem extends ToolSchemaNode
              }
            ? readonly InferToolOutput<TItem>[]
            : S extends {
                  readonly kind: 'obj'
                  readonly properties: infer TProps extends Readonly<Record<string, ToolSchemaNode>>
                }
              ? InferObjectProps<TProps>
              : S extends {
                    readonly kind: 'record'
                    readonly value: infer TVal extends ToolSchemaNode
                  }
                ? Readonly<Record<string, InferToolOutput<TVal>>>
                : S extends {
                      readonly kind: 'union'
                      readonly variants: infer TVariants extends readonly ToolSchemaNode[]
                    }
                  ? InferToolOutput<TVariants[number]>
                  : S extends {
                        readonly kind: 'discriminated_union'
                        readonly variants: infer TVariants extends readonly ToolSchemaNode[]
                      }
                    ? InferToolOutput<TVariants[number]>
                    : never

type BaseOutput<S extends ToolSchemaNode> = S extends unknown
  ? boolean extends S['isOptional']
    ? ToolSchemaOutput
    : KindOutput<S>
  : never

type WithNullability<S extends ToolSchemaNode> = S extends ToolSchemaNode
  ? S['isNullable'] extends true
    ? BaseOutput<S> | null
    : BaseOutput<S>
  : never

/** Output value produced by a node when it is not omitted as an object property. */
export type InferToolOutput<S extends ToolSchemaNode> = WithNullability<S>

/** Whether a declared property is guaranteed to exist on the decoded object. */
type IsGuaranteedKey<S extends ToolSchemaNode> = S['hasDefault'] extends true
  ? true
  : S['isOptional'] extends true
    ? false
    : true

/** Decoded object shape for a property map, honouring the modifier truth table. */
export type InferObjectProps<TProps extends Readonly<Record<string, ToolSchemaNode>>> = Prettify<
  {
    readonly [K in keyof TProps as IsGuaranteedKey<TProps[K]> extends true
      ? K
      : never]: WithNullability<TProps[K]>
  } & {
    readonly [K in keyof TProps as IsGuaranteedKey<TProps[K]> extends false
      ? K
      : never]?: WithNullability<TProps[K]>
  }
>

/* -------------------------------------------------------------------------- */
/*                          Chainable builder interfaces                      */
/* -------------------------------------------------------------------------- */

/** Accepted `.default(...)` input for a node (null only when nullable). */
export type ToolDefaultInput<TNullable extends boolean, TValue> = TNullable extends true
  ? TValue | null
  : TValue

/** Chainable string builder. */
export interface ToolStringBuilder<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolStringNode<TOptional, TNullable, THasDefault> {
  desc(description: string): ToolStringBuilder<TOptional, TNullable, THasDefault>
  optional(): ToolStringBuilder<true, TNullable, THasDefault>
  nullable(): ToolStringBuilder<TOptional, true, THasDefault>
  default(value: ToolDefaultInput<TNullable, string>): ToolStringBuilder<TOptional, TNullable, true>
  min(value: number): ToolStringBuilder<TOptional, TNullable, THasDefault>
  max(value: number): ToolStringBuilder<TOptional, TNullable, THasDefault>
}

/** Chainable numeric builder (shared by `t.num()` and `t.int()`). */
export interface ToolNumberBuilder<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolNumberNode<TOptional, TNullable, THasDefault> {
  desc(description: string): ToolNumberBuilder<TOptional, TNullable, THasDefault>
  optional(): ToolNumberBuilder<true, TNullable, THasDefault>
  nullable(): ToolNumberBuilder<TOptional, true, THasDefault>
  default(value: ToolDefaultInput<TNullable, number>): ToolNumberBuilder<TOptional, TNullable, true>
  min(value: number): ToolNumberBuilder<TOptional, TNullable, THasDefault>
  max(value: number): ToolNumberBuilder<TOptional, TNullable, THasDefault>
}

/** Chainable boolean builder. */
export interface ToolBooleanBuilder<
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolBooleanNode<TOptional, TNullable, THasDefault> {
  desc(description: string): ToolBooleanBuilder<TOptional, TNullable, THasDefault>
  optional(): ToolBooleanBuilder<true, TNullable, THasDefault>
  nullable(): ToolBooleanBuilder<TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, boolean>,
  ): ToolBooleanBuilder<TOptional, TNullable, true>
}

/** Chainable literal builder. */
export interface ToolLiteralBuilder<
  V extends ToolScalarValue = ToolScalarValue,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolLiteralNode<V, TOptional, TNullable, THasDefault> {
  desc(description: string): ToolLiteralBuilder<V, TOptional, TNullable, THasDefault>
  optional(): ToolLiteralBuilder<V, true, TNullable, THasDefault>
  nullable(): ToolLiteralBuilder<V, TOptional, true, THasDefault>
  default(value: ToolDefaultInput<TNullable, V>): ToolLiteralBuilder<V, TOptional, TNullable, true>
}

/** Chainable string-enum builder. */
export interface ToolEnumBuilder<
  TValues extends readonly [string, ...string[]] = readonly [string, ...string[]],
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolEnumNode<TValues, TOptional, TNullable, THasDefault> {
  desc(description: string): ToolEnumBuilder<TValues, TOptional, TNullable, THasDefault>
  optional(): ToolEnumBuilder<TValues, true, TNullable, THasDefault>
  nullable(): ToolEnumBuilder<TValues, TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, TValues[number]>,
  ): ToolEnumBuilder<TValues, TOptional, TNullable, true>
}

/** Chainable array builder. */
export interface ToolArrayBuilder<
  TItem extends ToolSchemaNode = ToolSchemaNode,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolArrayNode<TItem, TOptional, TNullable, THasDefault> {
  desc(description: string): ToolArrayBuilder<TItem, TOptional, TNullable, THasDefault>
  optional(): ToolArrayBuilder<TItem, true, TNullable, THasDefault>
  nullable(): ToolArrayBuilder<TItem, TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, readonly InferToolOutput<TItem>[]>,
  ): ToolArrayBuilder<TItem, TOptional, TNullable, true>
  min(value: number): ToolArrayBuilder<TItem, TOptional, TNullable, THasDefault>
  max(value: number): ToolArrayBuilder<TItem, TOptional, TNullable, THasDefault>
}

/** Chainable object builder. */
export interface ToolObjectBuilder<
  TProps extends Readonly<Record<string, ToolSchemaNode>> = Readonly<
    Record<string, ToolSchemaNode>
  >,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolObjectNode<TProps, TOptional, TNullable, THasDefault> {
  desc(description: string): ToolObjectBuilder<TProps, TOptional, TNullable, THasDefault>
  optional(): ToolObjectBuilder<TProps, true, TNullable, THasDefault>
  nullable(): ToolObjectBuilder<TProps, TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, InferObjectProps<TProps>>,
  ): ToolObjectBuilder<TProps, TOptional, TNullable, true>
}

/** Chainable open-dictionary builder. */
export interface ToolRecordBuilder<
  TVal extends ToolSchemaNode = ToolSchemaNode,
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolRecordNode<TVal, TOptional, TNullable, THasDefault> {
  desc(description: string): ToolRecordBuilder<TVal, TOptional, TNullable, THasDefault>
  optional(): ToolRecordBuilder<TVal, true, TNullable, THasDefault>
  nullable(): ToolRecordBuilder<TVal, TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, Readonly<Record<string, InferToolOutput<TVal>>>>,
  ): ToolRecordBuilder<TVal, TOptional, TNullable, true>
}

/** Chainable untagged union builder. */
export interface ToolUnionBuilder<
  TVariants extends readonly [ToolSchemaNode, ToolSchemaNode, ...ToolSchemaNode[]] = readonly [
    ToolSchemaNode,
    ToolSchemaNode,
    ...ToolSchemaNode[],
  ],
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolUnionNode<TVariants, TOptional, TNullable, THasDefault> {
  desc(description: string): ToolUnionBuilder<TVariants, TOptional, TNullable, THasDefault>
  optional(): ToolUnionBuilder<TVariants, true, TNullable, THasDefault>
  nullable(): ToolUnionBuilder<TVariants, TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, InferToolOutput<TVariants[number]>>,
  ): ToolUnionBuilder<TVariants, TOptional, TNullable, true>
}

/** Chainable discriminated-union builder. */
export interface ToolDiscriminatedUnionBuilder<
  D extends string = string,
  TVariants extends readonly [
    DiscriminatedVariantObject<D>,
    DiscriminatedVariantObject<D>,
    ...DiscriminatedVariantObject<D>[],
  ] = readonly [
    DiscriminatedVariantObject<D>,
    DiscriminatedVariantObject<D>,
    ...DiscriminatedVariantObject<D>[],
  ],
  TOptional extends boolean = boolean,
  TNullable extends boolean = boolean,
  THasDefault extends boolean = boolean,
> extends ToolDiscriminatedUnionNode<D, TVariants, TOptional, TNullable, THasDefault> {
  desc(
    description: string,
  ): ToolDiscriminatedUnionBuilder<D, TVariants, TOptional, TNullable, THasDefault>
  optional(): ToolDiscriminatedUnionBuilder<D, TVariants, true, TNullable, THasDefault>
  nullable(): ToolDiscriminatedUnionBuilder<D, TVariants, TOptional, true, THasDefault>
  default(
    value: ToolDefaultInput<TNullable, InferToolOutput<TVariants[number]>>,
  ): ToolDiscriminatedUnionBuilder<D, TVariants, TOptional, TNullable, true>
}

/** Root constructor namespace (`t.*`). Every call returns a frozen builder node. */
export interface ToolBuilder {
  str(): ToolStringBuilder<false, false, false>
  num(): ToolNumberBuilder<false, false, false>
  int(): ToolNumberBuilder<false, false, false>
  bool(): ToolBooleanBuilder<false, false, false>
  literal<const V extends ToolScalarValue>(value: V): ToolLiteralBuilder<V, false, false, false>
  enum<const TValues extends readonly [string, ...string[]]>(
    values: TValues,
  ): ToolEnumBuilder<TValues, false, false, false>
  arr<TItem extends ToolSchemaNode>(item: TItem): ToolArrayBuilder<TItem, false, false, false>
  obj<TProps extends Readonly<Record<string, ToolSchemaNode>>>(
    properties: TProps,
  ): ToolObjectBuilder<TProps, false, false, false>
  record<TVal extends ToolSchemaNode>(value: TVal): ToolRecordBuilder<TVal, false, false, false>
  union<const TVariants extends readonly [ToolSchemaNode, ToolSchemaNode, ...ToolSchemaNode[]]>(
    variants: TVariants,
  ): ToolUnionBuilder<TVariants, false, false, false>
  discriminatedUnion<
    const D extends string,
    const TVariants extends readonly [
      DiscriminatedVariantObject<D>,
      DiscriminatedVariantObject<D>,
      ...DiscriminatedVariantObject<D>[],
    ],
  >(
    discriminator: D,
    variants: TVariants,
  ): ToolDiscriminatedUnionBuilder<D, TVariants, false, false, false>
}

/* -------------------------------------------------------------------------- */
/*                        Definitions, parsing, wire schema                   */
/* -------------------------------------------------------------------------- */

/** Provider-independent tool definition accepted by `prepareChatCall`. */
export interface NeutralToolDefinition<S extends ToolObjectNode = ToolObjectNode> {
  readonly name: string
  readonly description: string
  readonly parameters: S
}

/** A single argument-validation mismatch. */
export interface ToolFieldIssue {
  readonly path: readonly string[]
  readonly expected: string
  readonly received: string
  readonly message: string
}

/** Expected argument-decoding failure (never thrown). */
export type ToolValidationError =
  | { readonly kind: 'malformed_json'; readonly rawPreview: string; readonly detail: string }
  | { readonly kind: 'root_not_object'; readonly receivedType: string }
  | { readonly kind: 'schema_mismatch'; readonly issues: readonly ToolFieldIssue[] }

/** Wire dialect selected from route capabilities at prepare time. */
export type ToolSchemaDialect =
  | 'openai-strict'
  | 'openai-non-strict'
  | 'openai-responses'
  | 'anthropic'
  | 'google-gemini'
  | 'google-gemini-cca'
  | 'moonshot-mfjs'

/** Fully static, request-ready wire tool schema. */
export interface NormalizedWireToolSchema {
  readonly name: string
  readonly description: string
  readonly strict: boolean
  readonly jsonSchema: Readonly<Record<string, unknown>>
}
