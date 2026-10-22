import { afterEach, describe, expect, test } from 'bun:test'
import type { Option, Result } from '@sekaisen/core'
import { isNone, isOption, isSome, NONE, some } from '@sekaisen/core'
import type {
  LensFor,
  MessagePrism,
  SchemaError,
  SchemaNode,
  SchemaTransaction,
} from '@sekaisen/plugin-schema'
import { SchemaService, s } from '@sekaisen/plugin-schema'
import type { SqliteDriver } from '@sekaisen/plugin-world'
import { WorldService } from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

function present<T>(value: Option<T>): T {
  if (value.kind === 'none') throw new Error('Expected present value')
  return value.value
}

const drivers: SqliteDriver[] = []
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function setup() {
  const driver = createBunSqliteDriver()
  drivers.push(driver)
  const ctx = new Context()
  const world = new WorldService(ctx, { driver })
  const schema = new SchemaService(ctx)
  return { ctx, world, schema }
}

/**
 * Compile-time only checks: kept in a function that is never invoked, but
 * referenced so the type assertions stay part of the checked surface.
 */
function optionAndBuilderTypeContracts(): void {
  // @ts-expect-error a same-shaped dictionary is business data, not an Option
  const plainNone: Option<number> = { kind: 'none' }
  // @ts-expect-error a same-shaped dictionary is business data, not an Option
  const plainSome: Option<number> = { kind: 'some', value: 1 }
  const leaf = s.struct({ n: s.num() }).fields.n
  // @ts-expect-error the normalized AST carries no builder methods
  leaf.default(1)
  const map = s.map(s.num())
  // @ts-expect-error the normalized AST carries no builder methods
  map.valueSchema.optional()
  const nested = s.map(s.struct({ list: s.list('str') }).optional())
  // @ts-expect-error nested builder children are normalized too
  nested.valueSchema.fields.list.default(['x'])
  const txContract = (tx: SchemaTransaction, lens: LensFor<typeof map>) => {
    tx.set(lens.at('a'), 2)
    const read: Result<Option<number>, SchemaError> = tx.get(lens.at('a'))
    return read
  }
  void plainNone
  void plainSome
  void txContract
}
void optionAndBuilderTypeContracts

describe('Option nominal contract', () => {
  test('only some() and NONE are genuine options', () => {
    expect(isOption(NONE)).toBe(true)
    expect(isOption(some(1))).toBe(true)
    expect(isOption({ kind: 'none' })).toBe(false)
    expect(isOption({ kind: 'some', value: 1 })).toBe(false)
    expect(isOption(null)).toBe(false)
    expect(isOption([])).toBe(false)
    expect(isOption(Object.create(some(1)))).toBe(false)

    expect(isNone(NONE)).toBe(true)
    expect(isSome(NONE)).toBe(false)
    expect(isSome(some(1))).toBe(true)
    expect(isNone(some(1))).toBe(false)

    expect(Object.isFrozen(NONE)).toBe(true)
    expect(Object.isFrozen(some(1))).toBe(true)
    // The marker is non-enumerable, so wire/deep-equality shapes stay stable.
    expect(Object.keys(NONE)).toEqual(['kind'])
    expect(Object.keys(some(1))).toEqual(['kind', 'value'])
  })
})

describe('schema metadata validation', () => {
  test('empty keys fail structurally and do not poison registration', async () => {
    const { ctx, schema } = setup()
    expect(() => s.str().meta({ '': 'x' })).toThrow()
    expect(() => s.struct({ n: s.num() }).meta({ '': 1 })).toThrow()

    const invalid: SchemaNode = {
      nodeKind: 'struct',
      fields: {
        nested: {
          nodeKind: 'map',
          valueSchema: {
            nodeKind: 'leaf',
            valueKind: 'num',
            presence: { mode: 'required' },
            description: '',
            metadata: { '': 1 },
          },
          presence: { mode: 'defaulted' },
          description: '',
          metadata: {},
        },
      },
      allowCustom: false,
      presence: { mode: 'defaulted' },
      description: '',
      metadata: {},
    }
    const good = s.struct({ hp: s.num() })
    let failure!: Result<LensFor<SchemaNode>, SchemaError>
    let lens!: LensFor<typeof good>
    const fiber = ctx.plugin((scope: Context) => {
      failure = scope.schema.define(['actors'], invalid)
      lens = unwrap(scope.schema.define(['actors'], good))
    })
    await fiber

    expect(failure).toMatchObject({
      ok: false,
      error: { kind: 'validation_failed', reason: 'type_mismatch' },
    })
    const node = unwrap(
      schema.commit({ head: 'main', message: 'metadata' }, (tx) => tx.set(lens, { hp: 5 })),
    )
    expect(unwrap(schema.get(node.id, lens.$.hp))).toEqual(some(5))
    await fiber.dispose()
  })
})

describe('message option normalization', () => {
  test('business kind none/some and real Option wrappers survive commit and decode', async () => {
    const { ctx, schema } = setup()
    const payload = s.struct({
      noneShaped: s.struct({ kind: s.str() }).optional(),
      someShaped: s.struct({ kind: s.str(), value: s.num() }).optional(),
      present: s.num().optional(),
      absent: s.str().optional(),
      dict: s.map(s.struct({ kind: s.str(), value: s.num() })),
    })
    let prism!: MessagePrism<'event', typeof payload>
    const fiber = ctx.plugin((scope: Context) => {
      prism = unwrap(scope.schema.defineMessage('event', payload))
    })
    await fiber

    const message = prism.create({
      noneShaped: { kind: 'none' },
      someShaped: some({ kind: 'some', value: 7 }),
      present: some(3),
      absent: NONE,
      dict: {
        alpha: { kind: 'none', value: 1 },
        beta: { kind: 'some', value: 2 },
      },
    })

    expect(message.data.noneShaped).toEqual(some({ kind: 'none' }))
    expect(message.data.someShaped).toEqual(some({ kind: 'some', value: 7 }))
    expect(message.data.present).toEqual(some(3))
    expect(message.data.absent).toBe(NONE)
    expect(message.data.dict).toEqual({
      alpha: { kind: 'none', value: 1 },
      beta: { kind: 'some', value: 2 },
    })

    const parsed = unwrap(prism.parse(message))
    expect(present(parsed)).toEqual(message.data)

    const node = unwrap(schema.commit({ message }))
    expect(unwrap(schema.getMessage(node.id))).toEqual(message)
    expect(unwrap(schema.getMessageAs(node.id, prism))).toEqual(some(message.data))

    expect('optional' in prism.schema.fields.noneShaped).toBe(false)
    // @ts-expect-error the normalized message schema carries no builder methods
    expect(prism.schema.fields.noneShaped.optional).toBeUndefined()
    await fiber.dispose()
  })

  test('a real absent wrapper omits an optional field while a plain dict is data', async () => {
    const { ctx, schema } = setup()
    const payload = s.struct({
      record: s.struct({ kind: s.str(), value: s.str() }).optional(),
    })
    let prism!: MessagePrism<'record', typeof payload>
    const fiber = ctx.plugin((scope: Context) => {
      prism = unwrap(scope.schema.defineMessage('record', payload))
    })
    await fiber

    const presentMessage = prism.create({
      record: { kind: 'some', value: 'business' },
    })
    expect(presentMessage.data.record).toEqual(some({ kind: 'some', value: 'business' }))

    const absentMessage = prism.create({ record: NONE })
    expect(absentMessage.data.record).toBe(NONE)

    const first = unwrap(schema.commit({ message: presentMessage }))
    const second = unwrap(schema.commit({ message: absentMessage }))
    expect(unwrap(schema.getMessage(first.id))).toEqual(presentMessage)
    expect(unwrap(schema.getMessage(second.id))).toEqual(absentMessage)
    await fiber.dispose()
  })
})

describe('builder and lens AST contracts', () => {
  test('runtime ASTs and declared types both omit builder methods', async () => {
    const { ctx, schema } = setup()
    const root = s.struct({
      n: s.num(),
      m: s.map(s.num()),
      inner: s.struct({ flag: s.bool().optional() }),
    })

    const leaf = root.fields.n
    expect(leaf.nodeKind).toBe('leaf')
    expect('default' in leaf).toBe(false)
    expect('optional' in root.fields.m.valueSchema).toBe(false)
    expect('default' in root.fields.inner.fields.flag).toBe(false)

    const presence: 'required' = leaf.presence.mode
    const valueKind: 'num' = leaf.valueKind
    const mapValuePresence: 'required' = root.fields.m.valueSchema.presence.mode
    const innerFlagPresence: 'optional' = root.fields.inner.fields.flag.presence.mode
    expect([presence, valueKind, mapValuePresence, innerFlagPresence]).toEqual([
      'required',
      'num',
      'required',
      'optional',
    ])

    const chained = s
      .struct({ n: s.num().default(1) })
      .optional()
      .extensible()
      .desc('root')
    const chainedPresence: 'optional' = chained.presence.mode
    const chainedFieldPresence: 'defaulted' = chained.fields.n.presence.mode
    expect([chainedPresence, chainedFieldPresence, chained.allowCustom]).toEqual([
      'optional',
      'defaulted',
      true,
    ])
    expect('default' in chained.fields.n).toBe(false)

    let lens!: LensFor<typeof root>
    const fiber = ctx.plugin((scope: Context) => {
      lens = unwrap(scope.schema.define(['actors'], root))
    })
    await fiber

    expect('default' in lens.schema.fields.n).toBe(false)
    expect('optional' in lens.field('m').schema.valueSchema).toBe(false)
    const lensPresence: 'required' = lens.schema.fields.n.presence.mode
    expect(lensPresence).toBe('required')
    // @ts-expect-error the cloned lens AST carries no builder methods
    expect(lens.schema.fields.n.default).toBeUndefined()

    const node = unwrap(
      schema.commit({ head: 'main', message: 'write' }, (tx) => {
        tx.set(lens, { n: 4, m: { a: 5 } })
        const read: Result<Option<number>, SchemaError> = tx.get(lens.$.n)
        expect(read.ok).toBe(true)
      }),
    )
    expect(unwrap(schema.get(node.id, lens.$.n))).toEqual(some(4))
    expect(unwrap(schema.get(node.id, lens.$.m.at('a')))).toEqual(some(5))
    await fiber.dispose()
  })
})
