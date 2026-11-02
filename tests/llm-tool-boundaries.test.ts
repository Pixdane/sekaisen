import { describe, expect, test } from 'bun:test'
import { InvariantError, type Result } from '@sekaisen/core'
import {
  type InferToolOutput,
  type NeutralToolDefinition,
  parseToolArguments,
  type ToolFieldIssue,
  type ToolObjectNode,
  type ToolValidationError,
  t,
  validateToolDefinition,
} from '../packages/plugin-llm/src/tool-schema.ts'

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

function makeTool(name: string): NeutralToolDefinition {
  return { name, description: 'boundary probe', parameters: t.obj({ value: t.str() }) }
}

function nameFailure(name: string): string {
  return expectFailure(validateToolDefinition(makeTool(name)))
}

function parseRaw<T extends ToolObjectNode>(
  schema: T,
  raw: string,
): Result<InferToolOutput<T>, ToolValidationError> {
  return parseToolArguments(schema, raw)
}

function mismatchIssues(result: Result<unknown, ToolValidationError>): readonly ToolFieldIssue[] {
  const failure = expectFailure(result)
  if (failure.kind !== 'schema_mismatch') {
    throw new Error(`expected a schema mismatch, got ${failure.kind}`)
  }
  return failure.issues
}

function rawNode(fields: Record<string, unknown>): Record<string, unknown> {
  return { isOptional: false, isNullable: false, hasDefault: false, ...fields }
}

function rawIntDefinition(defaultValue: unknown): NeutralToolDefinition {
  return {
    name: 'raw_int_tool',
    description: 'handwritten integer schema',
    parameters: rawNode({
      kind: 'obj',
      properties: {
        n: rawNode({ kind: 'num', integerOnly: true, hasDefault: true, defaultValue }),
      },
    }) as unknown as ToolObjectNode,
  }
}

function expectCanonicalZero(value: unknown): void {
  expect(Object.is(value, 0)).toBe(true)
  expect(Object.is(value, -0)).toBe(false)
}

/* -------------------------------------------------------------------------- */
/*                              Tool name limits                             */
/* -------------------------------------------------------------------------- */

describe('tool name boundaries', () => {
  test('accepts a single ASCII letter and the full 64-character name', () => {
    expect(validateToolDefinition(makeTool('a')).ok).toBe(true)
    expect(validateToolDefinition(makeTool('A')).ok).toBe(true)
    expect(validateToolDefinition(makeTool('a'.repeat(64))).ok).toBe(true)
    expect(validateToolDefinition(makeTool(`A_1-${'z'.repeat(60)}`)).ok).toBe(true)
  })

  test('rejects a name longer than 64 characters', () => {
    expect(nameFailure('a'.repeat(65))).toContain('1-64')
  })

  test('requires the first character to be an ASCII letter', () => {
    for (const name of ['1tool', '_tool', '-tool']) {
      expect(validateToolDefinition(makeTool(name)).ok).toBe(false)
      expect(nameFailure(name)).toContain('start with an ASCII letter')
    }
    // Length is not the only gate: 64 characters with an invalid first char fail.
    expect(validateToolDefinition(makeTool(`_${'a'.repeat(63)}`)).ok).toBe(false)
  })

  test('rejects characters outside the portable ASCII alphabet', () => {
    for (const name of ['tool name', 'tool.name', 'tool/name', 'tool+name', 'tööl']) {
      expect(validateToolDefinition(makeTool(name)).ok).toBe(false)
    }
    expect(nameFailure('tool name')).toContain('ASCII letters, digits')
    expect(nameFailure('tool.name')).toContain('ASCII letters, digits')
  })

  test('still rejects an empty name with the non-empty diagnostic', () => {
    expect(nameFailure('')).toContain('non-empty')
  })
})

/* -------------------------------------------------------------------------- */
/*                            Integer safe bounds                            */
/* -------------------------------------------------------------------------- */

describe('integer safe-integer boundaries', () => {
  const intSchema = t.obj({ n: t.int() })

  test('accepts both safe-integer extremes', () => {
    expect(unwrap(parseRaw(intSchema, `{"n":${Number.MAX_SAFE_INTEGER}}`)).n).toBe(
      Number.MAX_SAFE_INTEGER,
    )
    expect(unwrap(parseRaw(intSchema, `{"n":${Number.MIN_SAFE_INTEGER}}`)).n).toBe(
      Number.MIN_SAFE_INTEGER,
    )
  })

  test('rejects integers outside the safe range', () => {
    for (const raw of [`{"n":${2 ** 53}}`, `{"n":${-(2 ** 53)}}`, '{"n":1e25}', '{"n":-1e25}']) {
      const issue = mismatchIssues(parseRaw(intSchema, raw))[0]
      expect(issue?.expected).toBe('safe integer')
      expect(issue?.message).toContain('safe integer range')
    }
  })

  test('rejects fractional integers', () => {
    for (const raw of ['{"n":1.5}', '{"n":-1.5}', '{"n":0.5}']) {
      const issue = mismatchIssues(parseRaw(intSchema, raw))[0]
      expect(issue?.path).toEqual(['n'])
      expect(issue?.expected).toBe('safe integer')
    }
  })

  test('num nodes still accept any finite double', () => {
    const numSchema = t.obj({ n: t.num() })
    expect(unwrap(parseRaw(numSchema, '{"n":1.5}')).n).toBe(1.5)
    expect(unwrap(parseRaw(numSchema, '{"n":1e25}')).n).toBe(1e25)
    expect(unwrap(parseRaw(numSchema, `{"n":${2 ** 53}}`)).n).toBe(2 ** 53)
    expect(unwrap(parseRaw(numSchema, `{"n":${Number.MAX_VALUE}}`)).n).toBe(Number.MAX_VALUE)
    const overflow = mismatchIssues(parseRaw(numSchema, '{"n":1e400}'))[0]
    expect(overflow?.message).toContain('finite')
  })

  test('constructor default validation agrees with the parser', () => {
    expect(() => t.int().default(2 ** 53)).toThrow(InvariantError)
    expect(() => t.int().default(Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => t.int().default(Number.MIN_SAFE_INTEGER)).not.toThrow()
    expect(() => t.num().default(2 ** 53)).not.toThrow()
  })

  test('handwritten int defaults are checked against the safe range', () => {
    const invalid = expectFailure(validateToolDefinition(rawIntDefinition(2 ** 53)))
    expect(invalid).toContain('default value is invalid')
    expect(invalid).toContain('safe integer')
    expect(validateToolDefinition(rawIntDefinition(Number.MAX_SAFE_INTEGER)).ok).toBe(true)

    const accepted = unwrap(
      parseToolArguments(rawIntDefinition(Number.MAX_SAFE_INTEGER).parameters, '{}'),
    ) as { readonly n: number }
    expect(accepted.n).toBe(Number.MAX_SAFE_INTEGER)
  })
})

/* -------------------------------------------------------------------------- */
/*                            Negative zero decoding                         */
/* -------------------------------------------------------------------------- */

describe('negative zero canonicalization', () => {
  test('decoded -0 becomes +0 for numeric nodes, literals, and nested values', () => {
    const schema = t.obj({
      num: t.num(),
      int: t.int(),
      lit: t.literal(0),
      nested: t.obj({ value: t.num() }),
      list: t.arr(t.num()),
      map: t.record(t.num()),
    })
    const output = unwrap(
      parseToolArguments(
        schema,
        '{"num":-0,"int":-0,"lit":-0,"nested":{"value":-0},"list":[-0],"map":{"a":-0}}',
      ),
    )
    expectCanonicalZero(output.num)
    expectCanonicalZero(output.int)
    expectCanonicalZero(output.lit)
    expectCanonicalZero(output.nested.value)
    expectCanonicalZero(output.list[0])
    expectCanonicalZero(output.map.a)
  })

  test('defaults are stored and emitted as +0, including nested defaults', () => {
    const schema = t.obj({
      num: t.num().default(-0),
      int: t.int().default(-0),
      lit: t.literal(0).default(-0),
      nested: t.obj({ value: t.num() }).default({ value: -0 }),
      list: t.arr(t.num()).default([-0]),
      map: t.record(t.num()).default({ a: -0 }),
    })
    const output = unwrap(parseToolArguments(schema, '{}'))
    expectCanonicalZero(output.num)
    expectCanonicalZero(output.int)
    expectCanonicalZero(output.lit)
    expectCanonicalZero(output.nested.value)
    expectCanonicalZero(output.list[0])
    expectCanonicalZero(output.map.a)
  })

  test('builders and handwritten defaults stay canonical', () => {
    expectCanonicalZero(t.literal(-0).value)
    expectCanonicalZero(t.num().default(-0).defaultValue)

    expect(validateToolDefinition(rawIntDefinition(-0)).ok).toBe(true)
    const output = unwrap(parseToolArguments(rawIntDefinition(-0).parameters, '{}')) as {
      readonly n: number
    }
    expectCanonicalZero(output.n)
  })
})

/* -------------------------------------------------------------------------- */
/*                             Undefined properties                          */
/* -------------------------------------------------------------------------- */

describe('undefined property handling', () => {
  test('missing optional properties are omitted rather than set to undefined', () => {
    const schema = t.obj({
      required: t.str(),
      optional: t.str().optional(),
      defaulted: t.str().default('x'),
      nested: t.obj({ inner: t.str().optional() }),
    })
    const output = unwrap(parseToolArguments(schema, '{"required":"r","nested":{}}'))
    expect(Object.hasOwn(output, 'optional')).toBe(false)
    expect(Object.keys(output).sort()).toEqual(['defaulted', 'nested', 'required'].sort())
    expect(Object.hasOwn(output.nested, 'inner')).toBe(false)
    expect(JSON.stringify(output)).toBe('{"required":"r","defaulted":"x","nested":{}}')
  })

  test('undefined entries in an object default are normalized away', () => {
    const schema = t.obj({
      nested: t
        .obj({ inner: t.str().optional() })
        .default({ inner: undefined } as unknown as { readonly inner?: string }),
    })
    const output = unwrap(parseToolArguments(schema, '{}'))
    expect(Object.hasOwn(output.nested, 'inner')).toBe(false)
    expect(JSON.stringify(output.nested)).toBe('{}')
  })

  test('handwritten defaults with undefined entries stay parseable', () => {
    const parameters = rawNode({
      kind: 'obj',
      properties: {
        nested: rawNode({
          kind: 'obj',
          properties: { inner: rawNode({ kind: 'str', isOptional: true }) },
          hasDefault: true,
          defaultValue: { inner: undefined },
        }),
      },
    }) as unknown as ToolObjectNode
    const definition: NeutralToolDefinition = {
      name: 'raw_default_tool',
      description: 'handwritten default',
      parameters,
    }
    expect(validateToolDefinition(definition).ok).toBe(true)

    const output = unwrap(parseToolArguments(parameters, '{}')) as {
      readonly nested: Record<string, unknown>
    }
    expect(JSON.stringify(output)).toBe('{"nested":{}}')
    expect(Object.hasOwn(output.nested, 'inner')).toBe(false)
  })

  test('record defaults containing undefined are rejected at construction', () => {
    expect(() =>
      t.record(t.num()).default({ a: undefined } as unknown as Record<string, number>),
    ).toThrow(InvariantError)
  })
})
