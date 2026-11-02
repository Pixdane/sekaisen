import { describe, expect, test } from 'bun:test'
import { InvariantError, type Result } from '@sekaisen/core'
import {
  formatToolValidationFeedback,
  type InferToolOutput,
  type NeutralToolDefinition,
  type NormalizedWireToolSchema,
  normalizeToolSchemas,
  parseToolArguments,
  type ToolObjectNode,
  type ToolSchemaDialect,
  type ToolSchemaNode,
  type ToolStringNode,
  type ToolValidationError,
  t,
  validateToolDefinition,
} from '../packages/plugin-llm/src/tool-schema.ts'

/* -------------------------------------------------------------------------- */
/*                        Compile-time type contracts                        */
/* -------------------------------------------------------------------------- */

type Extends<A, B> = A extends B ? true : false
type TypeAssert<T extends true> = T

/**
 * Never invoked: kept referenced so the type assertions stay on the checked
 * surface without producing runtime work.
 */
function typeContracts(): void {
  const BatchPatchToolSchema = t.obj({
    dryRun: t.bool().default(false).desc('dry run only'),
    note: t.str().optional().desc('optional note'),
    operations: t
      .arr(
        t.discriminatedUnion('op', [
          t.obj({
            op: t.literal('upsert'),
            key: t.str().min(1),
            weight: t.int().min(0).max(100).default(50),
          }),
          t.obj({
            op: t.literal('remove'),
            key: t.str().min(1),
            reason: t.str().nullable(),
          }),
        ]),
      )
      .min(1),
  })

  type Expected = {
    readonly dryRun: boolean
    readonly note?: string
    readonly operations: readonly (
      | { readonly op: 'upsert'; readonly key: string; readonly weight: number }
      | { readonly op: 'remove'; readonly key: string; readonly reason: string | null }
    )[]
  }
  type Actual = InferToolOutput<typeof BatchPatchToolSchema>
  type _Forward = TypeAssert<Extends<Actual, Expected>>
  type _Backward = TypeAssert<Extends<Expected, Actual>>

  const TruthTable = t.obj({
    required: t.str(),
    optional: t.str().optional(),
    nullable: t.str().nullable(),
    optionalNullable: t.str().optional().nullable(),
    defaulted: t.str().default('x'),
    nullableDefault: t.str().nullable().default('x'),
  })
  type ExpectedTruthTable = {
    readonly required: string
    readonly optional?: string
    readonly nullable: string | null
    readonly optionalNullable?: string | null
    readonly defaulted: string
    readonly nullableDefault: string | null
  }
  type TruthActual = InferToolOutput<typeof TruthTable>
  type _TruthForward = TypeAssert<Extends<TruthActual, ExpectedTruthTable>>
  type _TruthBackward = TypeAssert<Extends<ExpectedTruthTable, TruthActual>>

  const plainNode: ToolStringNode = t.str()
  // @ts-expect-error normalized AST nodes carry no builder methods
  plainNode.desc('nope')
  // @ts-expect-error string default must be a string
  t.str().default(1)
  // @ts-expect-error null default requires .nullable()
  t.str().default(null)
  const nullableDefault = t.str().nullable().default(null)
  type _NullableDefault = TypeAssert<
    Extends<InferToolOutput<typeof nullableDefault>, string | null>
  >

  void nullableDefault
  void BatchPatchToolSchema
  void TruthTable
}

void typeContracts

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                  */
/* -------------------------------------------------------------------------- */

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected Ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

function expectFailure<E>(result: Result<unknown, E>): E {
  if (result.ok) throw new Error('expected Err')
  return result.error
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value as Record<string, unknown>
}

function makeTool(name: string, parameters: ToolObjectNode): NeutralToolDefinition {
  return { name, description: `${name} tool`, parameters }
}

function schemaTool(parameters: ToolObjectNode): NeutralToolDefinition {
  return makeTool('nullable_union_tool', parameters)
}

function wireOf(
  tool: NeutralToolDefinition,
  dialect: ToolSchemaDialect,
  options?: { readonly disableStrictTools?: boolean },
): NormalizedWireToolSchema {
  const wires = normalizeToolSchemas([tool], dialect, options)
  const first = wires[0]
  if (first === undefined) throw new Error('missing normalized tool')
  return first
}

function parseJson<T extends ToolObjectNode>(
  schema: T,
  value: unknown,
): Result<InferToolOutput<T>, ToolValidationError> {
  return parseToolArguments(schema, JSON.stringify(value))
}

function nestedRoot(levels: number): ToolObjectNode {
  if (levels <= 1) return t.obj({ leaf: t.str() })
  return t.obj({ child: nestedRoot(levels - 1) })
}

function rawNode(fields: Record<string, unknown>): Record<string, unknown> {
  return { isOptional: false, isNullable: false, hasDefault: false, ...fields }
}

function rawDefinition(
  parameters: Record<string, unknown>,
  name = 'raw_tool',
): NeutralToolDefinition {
  return {
    name,
    description: 'raw handwritten schema',
    parameters: parameters as unknown as ToolObjectNode,
  }
}

/* -------------------------------------------------------------------------- */
/*                          Modifier truth table                             */
/* -------------------------------------------------------------------------- */

describe('tool schema modifier truth table', () => {
  const schema = t.obj({
    required: t.str(),
    optional: t.str().optional(),
    nullable: t.str().nullable(),
    optionalNullable: t.str().optional().nullable(),
    defaulted: t.str().default('fallback'),
    nullableDefault: t.str().nullable().default('nullable-fallback'),
  })

  test('missing optional keys are not defined; defaults are filled', () => {
    const output = unwrap(parseJson(schema, { required: 'r', nullable: null }))
    expect(output.required).toBe('r')
    expect(output.nullable).toBeNull()
    expect(Object.hasOwn(output, 'optional')).toBe(false)
    expect(Object.hasOwn(output, 'optionalNullable')).toBe(false)
    expect(output.defaulted).toBe('fallback')
    expect(output.nullableDefault).toBe('nullable-fallback')
    expect(Object.keys(output).sort()).toEqual(
      ['defaulted', 'nullable', 'nullableDefault', 'required'].sort(),
    )
    expect(Object.isFrozen(output)).toBe(true)
  })

  test('null means omission unless nullable or defaulted', () => {
    const output = unwrap(
      parseJson(schema, {
        required: 'r',
        nullable: 'n',
        optional: null,
        optionalNullable: null,
        defaulted: null,
        nullableDefault: null,
      }),
    )
    expect(Object.hasOwn(output, 'optional')).toBe(false)
    expect(Object.hasOwn(output, 'optionalNullable')).toBe(true)
    expect(output.optionalNullable).toBeNull()
    expect(output.defaulted).toBe('fallback')
    expect(Object.hasOwn(output, 'nullableDefault')).toBe(true)
    expect(output.nullableDefault).toBeNull()
  })

  test('valid values are all written', () => {
    const output = unwrap(
      parseJson(schema, {
        required: 'r',
        nullable: 'n',
        optional: 'o',
        optionalNullable: 'oa',
        defaulted: 'd',
        nullableDefault: 'nd',
      }),
    )
    expect(output.optional).toBe('o')
    expect(output.optionalNullable).toBe('oa')
    expect(output.defaulted).toBe('d')
    expect(output.nullableDefault).toBe('nd')
  })

  test('required keys reject omission and null', () => {
    const missing = expectFailure(parseJson(schema, { nullable: null }))
    expect(missing.kind).toBe('schema_mismatch')
    if (missing.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(missing.issues).toHaveLength(1)
    expect(missing.issues[0]?.path).toEqual(['required'])
    expect(missing.issues[0]?.received).toBe('missing')

    const nulled = expectFailure(parseJson(schema, { required: null, nullable: null }))
    expect(nulled.kind).toBe('schema_mismatch')
    if (nulled.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(nulled.issues[0]?.message).toContain('may not be null')
  })

  test('declared keys only: unknown input keys are ignored', () => {
    const output = unwrap(parseJson(schema, { required: 'r', nullable: null, extra: 1 }))
    expect(Object.hasOwn(output, 'extra')).toBe(false)
  })

  test('defaults are deep-cloned and isolated per call', () => {
    const source = ['a']
    const defaultSchema = t.obj({ tags: t.arr(t.str()).default(source) })
    source.push('mutated-after-construction')
    const first = unwrap(parseJson(defaultSchema, {}))
    const second = unwrap(parseJson(defaultSchema, {}))
    expect(first.tags).toEqual(['a'])
    expect(Object.isFrozen(first.tags)).toBe(true)
    expect(first.tags).not.toBe(second.tags)
  })

  test('nested object defaults are reused safely', () => {
    const defaultSchema = t.obj({
      config: t.obj({ mode: t.str().default('auto'), retries: t.int().default(1) }).default({
        mode: 'auto',
        retries: 1,
      }),
    })
    const output = unwrap(parseJson(defaultSchema, {}))
    expect(output.config).toEqual({ mode: 'auto', retries: 1 })
  })
})

/* -------------------------------------------------------------------------- */
/*                          Nullable union variants                          */
/* -------------------------------------------------------------------------- */

describe('nullable union variants', () => {
  const nullableValue = t.union([t.str().nullable(), t.num()])
  const schema = t.obj({
    value: nullableValue,
    optionalValue: nullableValue.optional(),
    defaulted: nullableValue.default(null),
    nested: t.union([t.union([t.str().nullable(), t.bool()]), t.num()]),
    list: t.arr(nullableValue),
    map: t.record(nullableValue),
  })

  test('null is accepted by a union with a nullable branch', () => {
    const output = unwrap(
      parseJson(schema, {
        value: null,
        nested: null,
        list: [null, 3],
        map: { a: null, b: 4 },
      }),
    )
    expect(output.value).toBeNull()
    expect(output.nested).toBeNull()
    expect(output.list).toEqual([null, 3])
    expect(Reflect.get(output.map, 'a')).toBeNull()
    expect(Reflect.get(output.map, 'b')).toBe(4)
  })

  test('non-null branches still validate normally', () => {
    expect(
      unwrap(parseJson(schema, { value: 'text', nested: true, list: [], map: {} })).value,
    ).toBe('text')
    expect(unwrap(parseJson(schema, { value: 7, nested: 7, list: [], map: {} })).value).toBe(7)

    const bad = expectFailure(parseJson(schema, { value: true, nested: 1, list: [], map: {} }))
    expect(bad.kind).toBe('schema_mismatch')
    if (bad.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(bad.issues.map((issue) => issue.path)).toEqual([['value']])
  })

  test('missing stays omitted or defaulted while explicit null is preserved', () => {
    const empty = unwrap(parseJson(schema, { value: 'v', nested: 1, list: [], map: {} }))
    expect(Object.hasOwn(empty, 'optionalValue')).toBe(false)
    expect(Object.hasOwn(empty, 'defaulted')).toBe(true)
    expect(empty.defaulted).toBeNull()

    const explicitNull = unwrap(
      parseJson(schema, {
        value: 'v',
        nested: 1,
        optionalValue: null,
        defaulted: null,
        list: [],
        map: {},
      }),
    )
    expect(Object.hasOwn(explicitNull, 'optionalValue')).toBe(true)
    expect(explicitNull.optionalValue).toBeNull()
    expect(explicitNull.defaulted).toBeNull()
  })

  test('missing required union field still fails', () => {
    const failure = expectFailure(parseJson(schema, { nested: 1, list: [], map: {} }))
    expect(failure.kind).toBe('schema_mismatch')
    if (failure.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(failure.issues.map((issue) => issue.path)).toEqual([['value']])
  })

  test('wire normalization exposes the nullable union branch as nullable', () => {
    const wire = wireOf(schemaTool(schema), 'google-gemini')
    const value = recordOf(recordOf(recordOf(wire.jsonSchema).properties).value)
    const branches = value.anyOf
    expect(Array.isArray(branches)).toBe(true)
    if (!Array.isArray(branches)) throw new Error('expected anyOf branches')
    const nullableBranches = branches.filter(
      (branch) =>
        typeof branch === 'object' && branch !== null && Reflect.get(branch, 'nullable') === true,
    )
    expect(nullableBranches).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/*                             Prototype safety                              */
/* -------------------------------------------------------------------------- */

describe('tool schema prototype safety', () => {
  test('declared __proto__ and constructor keys decode as own data properties', () => {
    const schema = t.obj({
      ['__proto__']: t.str(),
      constructor: t.str(),
      map: t.record(t.num()),
    })
    const output = unwrap(
      parseToolArguments(
        schema,
        '{"__proto__":"polluted","constructor":"ctor","map":{"__proto__":1,"constructor":2,"a":3}}',
      ),
    )
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
    expect(Object.hasOwn(output, '__proto__')).toBe(true)
    expect(Reflect.get(output, '__proto__')).toBe('polluted')
    expect(Reflect.get(output, 'constructor')).toBe('ctor')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    const map = output.map
    expect(Object.getPrototypeOf(map)).toBeNull()
    expect(Object.hasOwn(map, '__proto__')).toBe(true)
    expect(Reflect.get(map, '__proto__')).toBe(1)
    expect(Reflect.get(map, 'constructor')).toBe(2)
    expect(Reflect.get(map, 'a')).toBe(3)
  })

  test('record defaults preserve prototype-less dictionaries and own __proto__', () => {
    const source = JSON.parse('{"__proto__":1,"safe":2}') as Record<string, number>
    const schema = t.obj({ map: t.record(t.num()).default(source) })
    const output = unwrap(parseJson(schema, {}))
    expect(Object.getPrototypeOf(output.map)).toBeNull()
    expect(Reflect.get(output.map, '__proto__')).toBe(1)
    expect(Reflect.get(output.map, 'safe')).toBe(2)
    expect(({} as Record<string, unknown>).safe).toBeUndefined()
  })

  test('schema construction with __proto__ keys never touches Object.prototype', () => {
    const schema = t.obj({ ['__proto__']: t.obj({ evil: t.bool() }) })
    expect(({} as Record<string, unknown>).evil).toBeUndefined()
    expect(({} as Record<string, unknown>).kind).toBeUndefined()
    expect(Object.hasOwn(schema.properties, '__proto__')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*                       Discriminated union dispatch                        */
/* -------------------------------------------------------------------------- */

describe('discriminated union decoding', () => {
  const schema = t.obj({
    operations: t.arr(
      t.discriminatedUnion('op', [
        t.obj({
          op: t.literal('upsert'),
          key: t.str().min(1),
          weight: t.int().min(0).max(100).default(50),
        }),
        t.obj({
          op: t.literal('remove'),
          key: t.str().min(1),
          reason: t.str().nullable(),
        }),
      ]),
    ),
  })

  test('dispatches only into the matched variant', () => {
    const output = unwrap(
      parseJson(schema, {
        operations: [
          { op: 'upsert', key: 'k' },
          { op: 'remove', key: 'k', reason: null },
        ],
      }),
    )
    expect(output.operations[0]).toEqual({ op: 'upsert', key: 'k', weight: 50 })
    expect(output.operations[1]).toEqual({ op: 'remove', key: 'k', reason: null })
  })

  test('reports only the matched branch issue with a precise path', () => {
    const failure = expectFailure(parseJson(schema, { operations: [{ op: 'remove', key: 'k' }] }))
    expect(failure.kind).toBe('schema_mismatch')
    if (failure.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(failure.issues.map((issue) => issue.path)).toEqual([['operations', '0', 'reason']])
  })

  test('unknown or missing discriminators report the tag enumeration', () => {
    const unknown = expectFailure(
      parseJson(schema, { operations: [{ op: 'nope', key: 'k', reason: null }] }),
    )
    expect(unknown.kind).toBe('schema_mismatch')
    if (unknown.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(unknown.issues[0]?.path).toEqual(['operations', '0', 'op'])
    expect(unknown.issues[0]?.expected).toContain('"upsert"')
    expect(unknown.issues[0]?.expected).toContain('"remove"')

    const missing = expectFailure(parseJson(schema, { operations: [{ key: 'k' }] }))
    expect(missing.kind).toBe('schema_mismatch')
    if (missing.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(missing.issues[0]?.path).toEqual(['operations', '0', 'op'])
    expect(missing.issues[0]?.received).toBe('missing')
  })

  test('extra properties in a matched variant are ignored', () => {
    const output = unwrap(
      parseJson(schema, {
        operations: [{ op: 'remove', key: 'k', reason: 'why', extra: true }],
      }),
    )
    expect(Object.hasOwn(output.operations[0] as object, 'extra')).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*                     Constructor invariant enforcement                     */
/* -------------------------------------------------------------------------- */

describe('tool schema constructor invariants', () => {
  test('invalid bounds, enums, and child modifiers throw InvariantError', () => {
    expect(() => t.str().min(2).max(1)).toThrow(InvariantError)
    expect(() => t.str().min(-1)).toThrow(InvariantError)
    expect(() => t.num().min(5).max(4)).toThrow(InvariantError)
    expect(() => t.num().max(Number.POSITIVE_INFINITY)).toThrow(InvariantError)
    expect(() => t.enum([] as unknown as readonly [string, ...string[]])).toThrow(InvariantError)
    expect(() => t.enum(['a', 'a'] as unknown as readonly [string, ...string[]])).toThrow(
      InvariantError,
    )
    expect(() => t.arr(t.str().optional())).toThrow(InvariantError)
    expect(() => t.arr(t.str().default('x'))).toThrow(InvariantError)
    expect(() => t.record(t.str().optional())).toThrow(InvariantError)
    expect(() => t.record(t.str().default('x'))).toThrow(InvariantError)
  })

  test('discriminated unions reject bad tags and non-object variants', () => {
    expect(() =>
      t.discriminatedUnion('kind', [
        t.obj({ kind: t.literal('same') }),
        t.obj({ kind: t.literal('same') }),
      ]),
    ).toThrow(InvariantError)
    expect(() =>
      t.discriminatedUnion('kind', [
        t.obj({ kind: t.literal('a') }),
        t.obj({ kind: t.literal('b'), nested: t.obj({ kind: t.literal('x') }) }),
      ]),
    ).not.toThrow()
    expect(() =>
      t.discriminatedUnion('kind', [
        t.obj({ kind: t.literal('a') }),
        t.obj({ kind: t.literal('b') }),
      ]),
    ).not.toThrow()
  })

  test('defaults are normalized and must conform to the schema', () => {
    expect(() => t.str().min(3).default('ab')).toThrow(InvariantError)
    expect(() => t.int().default(1.5)).toThrow(InvariantError)
    expect(() => t.str().default(0 as unknown as string)).toThrow(InvariantError)
    expect(() => t.str().nullable().default(null)).not.toThrow()
    const output = unwrap(parseJson(t.obj({ n: t.int().min(2).default(3) }), {}))
    expect(output.n).toBe(3)
  })

  test('builders are frozen and immutable', () => {
    const base = t.str().min(1)
    const extended = base.max(5)
    expect(Object.isFrozen(base)).toBe(true)
    expect(Object.isFrozen(extended)).toBe(true)
    expect(base.maxLength).toBeUndefined()
    expect(base).not.toBe(extended)
    expect(Reflect.get(extended, 'minLength')).toBe(1)
    expect(Reflect.get(extended, 'maxLength')).toBe(5)
  })
})

/* -------------------------------------------------------------------------- */
/*                       Definition structural validation                    */
/* -------------------------------------------------------------------------- */

describe('validateToolDefinition', () => {
  test('accepts builder and handwritten definitions', () => {
    expect(validateToolDefinition(makeTool('builder_tool', t.obj({ a: t.str() }))).ok).toBe(true)
    const handwritten = rawDefinition(
      rawNode({
        kind: 'obj',
        properties: {
          a: rawNode({ kind: 'str', minLength: 1 }),
        },
      }),
    )
    expect(validateToolDefinition(handwritten).ok).toBe(true)
  })

  test('rejects malformed names, descriptions, and roots', () => {
    expect(
      expectFailure(validateToolDefinition(rawDefinition(rawNode({ kind: 'str' })))),
    ).toContain('object schema node')
    expect(
      expectFailure(validateToolDefinition(rawDefinition(rawNode({ kind: 'obj' }), 'bad name'))),
    ).toContain('tool.name')
    expect(
      expectFailure(
        validateToolDefinition(rawDefinition(rawNode({ kind: 'obj' }), 'a'.repeat(65))),
      ),
    ).toContain('tool.name')
    const nullableRoot = rawNode({ kind: 'obj', properties: {}, isNullable: true })
    expect(expectFailure(validateToolDefinition(rawDefinition(nullableRoot)))).toContain(
      'may not be nullable',
    )
    const wrongDescription = {
      name: 'tool',
      description: 1,
      parameters: t.obj({}),
    } as unknown as NeutralToolDefinition
    expect(expectFailure(validateToolDefinition(wrongDescription))).toContain('tool.description')
  })

  test('rejects invalid node invariants', () => {
    expect(
      expectFailure(
        validateToolDefinition(
          rawDefinition(
            rawNode({
              kind: 'obj',
              properties: { bad: rawNode({ kind: 'str', isOptional: 'no' }) },
            }),
          ),
        ),
      ),
    ).toContain('isOptional')
    expect(
      expectFailure(
        validateToolDefinition(
          rawDefinition(
            rawNode({
              kind: 'obj',
              properties: { bad: rawNode({ kind: 'str', minLength: 5, maxLength: 2 }) },
            }),
          ),
        ),
      ),
    ).toContain('minLength')
    expect(
      expectFailure(
        validateToolDefinition(
          rawDefinition(
            rawNode({
              kind: 'obj',
              properties: {
                list: rawNode({
                  kind: 'arr',
                  item: rawNode({ kind: 'str', isOptional: true }),
                }),
              },
            }),
          ),
        ),
      ),
    ).toContain('may not be optional')
    expect(
      expectFailure(
        validateToolDefinition(
          rawDefinition(
            rawNode({
              kind: 'obj',
              properties: { bad: rawNode({ kind: 'enum', values: ['a', 'a'] }) },
            }),
          ),
        ),
      ),
    ).toContain('unique')
    expect(
      expectFailure(
        validateToolDefinition(
          rawDefinition(
            rawNode({
              kind: 'obj',
              properties: {
                bad: rawNode({ kind: 'str', hasDefault: true, defaultValue: 5 }),
              },
            }),
          ),
        ),
      ),
    ).toContain('default value is invalid')
    expect(
      expectFailure(
        validateToolDefinition(
          rawDefinition(
            rawNode({
              kind: 'obj',
              properties: { bad: rawNode({ kind: 'str', defaultValue: 'x' }) },
            }),
          ),
        ),
      ),
    ).toContain('defaultValue requires hasDefault')
  })

  test('rejects duplicate discriminator tags and malformed variants', () => {
    const duplicate = rawNode({
      kind: 'obj',
      properties: {
        choice: rawNode({
          kind: 'discriminated_union',
          discriminator: 'kind',
          variants: [
            rawNode({
              kind: 'obj',
              properties: { kind: rawNode({ kind: 'literal', value: 'same' }) },
            }),
            rawNode({
              kind: 'obj',
              properties: { kind: rawNode({ kind: 'literal', value: 'same' }) },
            }),
          ],
        }),
      },
    })
    expect(expectFailure(validateToolDefinition(rawDefinition(duplicate)))).toContain(
      'duplicate discriminator tag',
    )

    const nonLiteral = rawNode({
      kind: 'obj',
      properties: {
        choice: rawNode({
          kind: 'discriminated_union',
          discriminator: 'kind',
          variants: [
            rawNode({ kind: 'obj', properties: { kind: rawNode({ kind: 'str' }) } }),
            rawNode({
              kind: 'obj',
              properties: { kind: rawNode({ kind: 'literal', value: 'b' }) },
            }),
          ],
        }),
      },
    })
    expect(expectFailure(validateToolDefinition(rawDefinition(nonLiteral)))).toContain(
      'string literal',
    )
  })

  test('rejects cyclic handwritten schemas', () => {
    const cyclic = rawNode({ kind: 'obj', properties: {} })
    const properties = recordOf(cyclic.properties)
    properties.self = cyclic
    expect(expectFailure(validateToolDefinition(rawDefinition(cyclic)))).toContain(
      'cyclic schema reference',
    )
  })
})

/* -------------------------------------------------------------------------- */
/*                        Zero-throw argument parsing                        */
/* -------------------------------------------------------------------------- */

describe('parseToolArguments', () => {
  test('reports malformed JSON with a well-formed preview', () => {
    const failure = expectFailure(parseToolArguments(t.obj({ a: t.str() }), '{"a":'))
    expect(failure.kind).toBe('malformed_json')
    if (failure.kind !== 'malformed_json') throw new Error('unexpected failure kind')
    expect(failure.rawPreview.isWellFormed()).toBe(true)
    expect(formatToolValidationFeedback(failure)).toContain('not valid JSON')
  })

  test('requires an object root', () => {
    for (const [raw, type] of [
      ['[]', 'array'],
      ['null', 'null'],
      ['1', 'number'],
      ['"text"', 'string'],
    ] as const) {
      const failure = expectFailure(parseToolArguments(t.obj({ a: t.str() }), raw))
      expect(failure.kind).toBe('root_not_object')
      if (failure.kind !== 'root_not_object') throw new Error('unexpected failure kind')
      expect(failure.receivedType).toBe(type)
    }
  })

  test('enforces numeric, integer, and string constraints', () => {
    const schema = t.obj({ n: t.int().min(2), s: t.str().min(3).max(4) })
    const failure = expectFailure(parseJson(schema, { n: 1.5, s: 'ab' }))
    expect(failure.kind).toBe('schema_mismatch')
    if (failure.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(failure.issues.map((issue) => issue.path)).toEqual([['n'], ['s']])
    expect(formatToolValidationFeedback(failure)).toContain('$.n')
    expect(formatToolValidationFeedback(failure)).toContain('$.s')
  })

  test('rejects lone surrogates in strings', () => {
    const failure = expectFailure(parseToolArguments(t.obj({ a: t.str() }), '{"a":"\\ud800"}'))
    expect(failure.kind).toBe('schema_mismatch')
    if (failure.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(failure.issues[0]?.message).toContain('well-formed')
  })

  test('an invalid handwritten schema is a program defect', () => {
    const invalid = t.str() as unknown as ToolObjectNode
    expect(() => parseToolArguments(invalid, '{}')).toThrow(InvariantError)
  })
})

/* -------------------------------------------------------------------------- */
/*                        Dialect strictness downgrades                      */
/* -------------------------------------------------------------------------- */

describe('static strict downgrade', () => {
  test('OpenAI strict accepts depth 5 and rejects depth 6', () => {
    expect(wireOf(makeTool('depth5', nestedRoot(5)), 'openai-strict').strict).toBe(true)
    expect(wireOf(makeTool('depth6', nestedRoot(6)), 'openai-strict').strict).toBe(false)
    expect(wireOf(makeTool('depth5', nestedRoot(5)), 'openai-responses').strict).toBe(true)
    expect(wireOf(makeTool('depth6', nestedRoot(6)), 'openai-responses').strict).toBe(false)
  })

  test('OpenAI strict downgrades records and honours disableStrictTools', () => {
    const openTool = makeTool('open_map', t.obj({ map: t.record(t.num()) }))
    expect(wireOf(openTool, 'openai-strict').strict).toBe(false)
    expect(wireOf(openTool, 'openai-strict', { disableStrictTools: true }).strict).toBe(false)

    const closedTool = makeTool('closed', t.obj({ a: t.str() }))
    expect(wireOf(closedTool, 'openai-strict', { disableStrictTools: true }).strict).toBe(false)
    expect(wireOf(closedTool, 'openai-non-strict').strict).toBe(false)
    expect(wireOf(closedTool, 'google-gemini').strict).toBe(false)
  })

  test('Anthropic budget is request-level', () => {
    const closedTool = makeTool('closed', t.obj({ a: t.str() }))
    expect(wireOf(closedTool, 'anthropic').strict).toBe(true)

    const eight = Array.from({ length: 8 }, (_, index) =>
      makeTool(`tool_${index}`, t.obj({ a: t.str() })),
    )
    const nine = Array.from({ length: 9 }, (_, index) =>
      makeTool(`tool_${index}`, t.obj({ a: t.str() })),
    )
    for (const normalized of normalizeToolSchemas(eight, 'anthropic')) {
      expect(normalized.strict).toBe(true)
    }
    for (const normalized of normalizeToolSchemas(nine, 'anthropic')) {
      expect(normalized.strict).toBe(false)
    }
  })

  test('Anthropic budget downgrades the whole request on any violation', () => {
    const recordTool = makeTool('with_map', t.obj({ map: t.record(t.num()) }))
    const plainTool = makeTool('plain', t.obj({ a: t.str() }))
    const normalized = normalizeToolSchemas([plainTool, recordTool], 'anthropic')
    expect(normalized.map((entry) => entry.strict)).toEqual([false, false])

    expect(wireOf(makeTool('depth4', nestedRoot(4)), 'anthropic').strict).toBe(true)
    expect(wireOf(makeTool('depth5', nestedRoot(5)), 'anthropic').strict).toBe(false)
    expect(
      wireOf(makeTool('closed', t.obj({ a: t.str() })), 'anthropic', {
        disableStrictTools: true,
      }).strict,
    ).toBe(false)
  })

  test('Anthropic property plus union-variant budget is 64', () => {
    const makeWide = (stringProperties: number): NeutralToolDefinition => {
      const properties: Record<string, ToolSchemaNode> = {}
      for (let index = 0; index < stringProperties; index++) {
        properties[`p${index}`] = t.str()
      }
      properties.choice = t.union([t.str(), t.num()])
      return makeTool('wide', t.obj(properties))
    }
    expect(wireOf(makeWide(61), 'anthropic').strict).toBe(true)
    expect(wireOf(makeWide(62), 'anthropic').strict).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*                     Mutable handwritten AST caching                       */
/* -------------------------------------------------------------------------- */

describe('normalizer cache safety', () => {
  test('mutable handwritten schemas are re-normalized after every edit', () => {
    const parameters = rawNode({
      kind: 'obj',
      properties: { label: rawNode({ kind: 'str', minLength: 2 }) },
    })
    const tool = rawDefinition(parameters)

    const first = wireOf(tool, 'openai-strict')
    const firstProperties = recordOf(recordOf(first.jsonSchema).properties)
    expect(recordOf(firstProperties.label).description).toContain('minLength: 2')

    const properties = recordOf(parameters.properties)
    const label = recordOf(properties.label)
    label.minLength = 5

    const second = wireOf(tool, 'openai-strict')
    const secondProperties = recordOf(recordOf(second.jsonSchema).properties)
    expect(recordOf(secondProperties.label).description).toContain('minLength: 5')
    expect(second.jsonSchema).not.toBe(first.jsonSchema)

    properties.extra = rawNode({ kind: 'bool' })
    const third = wireOf(tool, 'openai-strict')
    const thirdSchema = recordOf(third.jsonSchema)
    expect(thirdSchema.required).toContain('extra')
    expect(Object.keys(recordOf(thirdSchema.properties))).toContain('extra')
  })

  test('mutable handwritten discriminator edits take effect on the next parse', () => {
    const variantA = rawNode({
      kind: 'obj',
      properties: { kind: rawNode({ kind: 'literal', value: 'a' }) },
    })
    const variantB = rawNode({
      kind: 'obj',
      properties: { kind: rawNode({ kind: 'literal', value: 'b' }) },
    })
    const parameters = rawNode({
      kind: 'obj',
      properties: {
        choice: rawNode({
          kind: 'discriminated_union',
          discriminator: 'kind',
          variants: [variantA, variantB],
        }),
      },
    })
    const tool = rawDefinition(parameters)

    expect(parseToolArguments(tool.parameters, '{"choice":{"kind":"a"}}').ok).toBe(true)

    const choice = recordOf(recordOf(parameters.properties).choice)
    const variantList = choice.variants
    if (!Array.isArray(variantList)) throw new Error('expected variants')
    const firstVariant = recordOf(variantList[0])
    const literal = recordOf(recordOf(firstVariant.properties).kind)
    literal.value = 'c'

    expect(parseToolArguments(tool.parameters, '{"choice":{"kind":"a"}}').ok).toBe(false)
    expect(parseToolArguments(tool.parameters, '{"choice":{"kind":"c"}}').ok).toBe(true)
  })

  test('frozen builders remain memoized by identity', () => {
    const tool = makeTool('memoized', t.obj({ label: t.str().min(2) }))
    const first = wireOf(tool, 'openai-strict')
    const second = wireOf(tool, 'openai-strict')
    expect(second.jsonSchema).toBe(first.jsonSchema)
  })
})

/* -------------------------------------------------------------------------- */
/*                         Dialect shape normalization                       */
/* -------------------------------------------------------------------------- */

describe('dialect normalization', () => {
  const tool = makeTool(
    'demo',
    t.obj({
      name: t.str().min(2).max(5).desc('label'),
      count: t.int().min(0).default(3),
      note: t.str().optional(),
      mode: t.enum(['a', 'b']).nullable(),
    }),
  )

  test('openai-strict closes objects, requires all keys, and spills constraints', () => {
    const wire = wireOf(tool, 'openai-strict')
    expect(wire.strict).toBe(true)
    const schema = recordOf(wire.jsonSchema)
    expect(Object.isFrozen(schema)).toBe(true)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['name', 'count', 'note', 'mode'])

    const properties = recordOf(schema.properties)
    const name = recordOf(properties.name)
    expect(name.minLength).toBeUndefined()
    expect(name.maxLength).toBeUndefined()
    expect(name.description).toBe('label [minLength: 2; maxLength: 5]')

    const count = recordOf(properties.count)
    expect(count.minimum).toBeUndefined()
    expect(count.default).toBeUndefined()
    expect(count.description).toContain('default: 3')
    expect(count.description).toContain('minimum: 0')
    expect(Array.isArray(count.anyOf)).toBe(true)

    const note = recordOf(properties.note)
    expect(Array.isArray(note.anyOf)).toBe(true)
    const mode = recordOf(properties.mode)
    expect(Array.isArray(mode.anyOf)).toBe(true)
  })

  test('openai-non-strict keeps constraints and defaults as keywords', () => {
    const wire = wireOf(tool, 'openai-non-strict')
    expect(wire.strict).toBe(false)
    const schema = recordOf(wire.jsonSchema)
    expect(schema.additionalProperties).toBeUndefined()
    expect(schema.required).toEqual(['name', 'mode'])

    const properties = recordOf(schema.properties)
    const name = recordOf(properties.name)
    expect(name.minLength).toBe(2)
    expect(name.maxLength).toBe(5)
    const count = recordOf(properties.count)
    expect(count.minimum).toBe(0)
    expect(count.default).toBe(3)
    const mode = recordOf(properties.mode)
    expect(Array.isArray(mode.anyOf)).toBe(true)
  })

  test('anthropic strict closes objects without forcing null wrapping', () => {
    const wire = wireOf(tool, 'anthropic')
    expect(wire.strict).toBe(true)
    const schema = recordOf(wire.jsonSchema)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['name', 'mode'])

    const properties = recordOf(schema.properties)
    expect(recordOf(properties.note)).toEqual({ type: 'string' })
    expect(Array.isArray(recordOf(properties.mode).anyOf)).toBe(true)
    expect(recordOf(properties.name).minLength).toBe(2)
  })

  test('gemini folds nullability, degrades numeric literals, and orders properties', () => {
    const geminiTool = makeTool(
      'gemini',
      t.obj({
        text: t.str().nullable(),
        numeric: t.literal(5),
        flag: t.literal(true),
        label: t.literal('x'),
        map: t.record(t.num()),
      }),
    )
    const wire = wireOf(geminiTool, 'google-gemini')
    expect(wire.strict).toBe(false)
    const schema = recordOf(wire.jsonSchema)
    expect(schema.propertyOrdering).toEqual(['text', 'numeric', 'flag', 'label', 'map'])

    const properties = recordOf(schema.properties)
    const text = recordOf(properties.text)
    expect(text.nullable).toBe(true)
    expect(text.anyOf).toBeUndefined()

    const numeric = recordOf(properties.numeric)
    expect(numeric.type).toBe('NUMBER')
    expect(numeric.enum).toBeUndefined()
    expect(numeric.description).toContain('Allowed values: 5')

    const flag = recordOf(properties.flag)
    expect(flag.type).toBe('BOOLEAN')
    expect(flag.description).toContain('Allowed values: true')

    const label = recordOf(properties.label)
    expect(label.enum).toEqual(['x'])

    const map = recordOf(properties.map)
    expect(map.additionalProperties).toBeUndefined()
    expect(map.description).toContain('Arbitrary string keys map to number.')
  })

  test('empty tool lists and repeated normalization are stable', () => {
    expect(Object.isFrozen(normalizeToolSchemas([], 'openai-strict'))).toBe(true)
    expect(normalizeToolSchemas([], 'openai-strict')).toHaveLength(0)

    const first = wireOf(tool, 'openai-strict')
    const second = wireOf(tool, 'openai-strict')
    expect(first.jsonSchema).toBe(second.jsonSchema)
    expect(first).not.toBe(second)
    expect(Object.isFrozen(first)).toBe(true)
  })

  test('invalid dialects and definitions throw InvariantError', () => {
    expect(() => normalizeToolSchemas([], 'unknown' as unknown as ToolSchemaDialect)).toThrow(
      InvariantError,
    )
    const broken = rawDefinition(
      rawNode({ kind: 'obj', properties: { a: rawNode({ kind: 'str', minLength: -1 }) } }),
    )
    expect(() => normalizeToolSchemas([broken], 'openai-strict')).toThrow(InvariantError)
  })
})

/* -------------------------------------------------------------------------- */
/*                        Discriminated union projection                     */
/* -------------------------------------------------------------------------- */

describe('flat discriminated union projection', () => {
  const targetSchema = t.discriminatedUnion('kind', [
    t.obj({
      kind: t.literal('file'),
      path: t.str(),
      mode: t.enum(['r', 'w']).optional(),
    }),
    t.obj({
      kind: t.literal('dir'),
      path: t.str(),
      recursive: t.bool(),
    }),
  ])
  const tool = makeTool('patch', t.obj({ target: targetSchema }))

  test('Cloud Code Assist and MFJS flatten into one object', () => {
    for (const dialect of ['google-gemini-cca', 'moonshot-mfjs'] as const) {
      const wire = wireOf(tool, dialect)
      const root = recordOf(wire.jsonSchema)
      const target = recordOf(recordOf(root.properties).target)
      const expectedType = dialect === 'google-gemini-cca' ? 'OBJECT' : 'object'
      const expectedString = dialect === 'google-gemini-cca' ? 'STRING' : 'string'
      expect(target.type).toBe(expectedType)
      expect(target.anyOf).toBeUndefined()

      const discriminator = recordOf(recordOf(target.properties).kind)
      expect(discriminator).toEqual({ type: expectedString, enum: ['file', 'dir'] })
      expect(target.required).toEqual(['kind', 'path'])

      const properties = recordOf(target.properties)
      expect(Object.hasOwn(properties, 'path')).toBe(true)
      expect(target.required).not.toContain('mode')
      expect(target.required).not.toContain('recursive')
      expect(recordOf(properties.recursive).description).toContain('[When kind="dir": required]')
    }
  })

  test('Gemini uppercases structural types without renaming user keys', () => {
    const typed = makeTool(
      'typed',
      t.obj({
        type: t.str(),
        nested: t.obj({ type: t.num(), list: t.arr(t.bool()) }),
      }),
    )
    const root = recordOf(wireOf(typed, 'google-gemini').jsonSchema)
    const properties = recordOf(root.properties)
    expect(Object.keys(properties)).toEqual(['type', 'nested'])
    expect(recordOf(properties.type)).toEqual({ type: 'STRING' })
    expect(recordOf(properties.nested).type).toBe('OBJECT')
    const nested = recordOf(recordOf(properties.nested).properties)
    expect(Object.keys(nested)).toEqual(['type', 'list'])
    expect(recordOf(nested.type)).toEqual({ type: 'NUMBER' })
    expect(recordOf(nested.list).type).toBe('ARRAY')
    expect(recordOf(recordOf(nested.list).items).type).toBe('BOOLEAN')
  })

  test('Moonshot keeps lowercase JSON Schema types', () => {
    const typed = makeTool('typed_mfjs', t.obj({ value: t.str() }))
    const root = recordOf(wireOf(typed, 'moonshot-mfjs').jsonSchema)
    expect(root.type).toBe('object')
  })

  test('Gemini keeps discriminated unions as anyOf', () => {
    const wire = wireOf(tool, 'google-gemini')
    const target = recordOf(recordOf(recordOf(wire.jsonSchema).properties).target)
    const branches = target.anyOf
    expect(Array.isArray(branches)).toBe(true)
    if (Array.isArray(branches)) expect(branches).toHaveLength(2)
  })

  test('the original AST still validates flat-projected arguments', () => {
    const parseSchema = t.obj({ target: targetSchema })
    const valid = unwrap(
      parseJson(parseSchema, {
        target: { kind: 'dir', path: '/tmp', recursive: false },
      }),
    )
    expect(valid.target).toEqual({ kind: 'dir', path: '/tmp', recursive: false })

    const missingPath = expectFailure(
      parseJson(parseSchema, {
        target: { kind: 'dir', recursive: false },
      }),
    )
    expect(missingPath.kind).toBe('schema_mismatch')
    if (missingPath.kind !== 'schema_mismatch') throw new Error('unexpected failure kind')
    expect(missingPath.issues.map((issue) => issue.path)).toEqual([['target', 'path']])
  })
})

/* -------------------------------------------------------------------------- */
/*                          Feedback formatting                              */
/* -------------------------------------------------------------------------- */

describe('formatToolValidationFeedback', () => {
  test('renders malformed, root, and schema failures deterministically', () => {
    const malformed: ToolValidationError = {
      kind: 'malformed_json',
      rawPreview: '{"a":',
      detail: 'Unexpected end of JSON input',
    }
    expect(formatToolValidationFeedback(malformed)).toContain('Raw arguments preview: {"a":')

    const root: ToolValidationError = { kind: 'root_not_object', receivedType: 'array' }
    expect(formatToolValidationFeedback(root)).toContain('received array')

    const schemaFailure = expectFailure(
      parseJson(t.obj({ list: t.arr(t.num()) }), { list: [1, 'x'] }),
    )
    expect(schemaFailure.kind).toBe('schema_mismatch')
    const feedback = formatToolValidationFeedback(schemaFailure)
    expect(feedback).toContain('Tool arguments did not match the tool schema:')
    expect(feedback).toContain('$.list[1]')
  })
})
