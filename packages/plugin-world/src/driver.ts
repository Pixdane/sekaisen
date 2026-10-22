import type { Option } from '@sekaisen/core'
import { InvariantError, NONE, some } from '@sekaisen/core'
import type { SqliteDriver, SqliteDriverOptions, SqliteStatement } from './types.ts'

/** The minimal statement surface shared by the Node and Bun native SQLite APIs. */
export interface NativeStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): readonly unknown[]
}

/** The minimal database surface shared by the Node and Bun native SQLite APIs. */
export interface NativeDatabase {
  exec(sql: string): void
  prepare(sql: string): NativeStatement
  close(): void
}

type Durability = 'full' | 'normal'

const IDENTIFIER_START = /^(?!\uFEFF)[A-Za-z_\u0080-\uFFFF]$/
const IDENTIFIER_CHARACTER = /^[A-Za-z0-9_$\u0080-\uFFFF]$/

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1
  while (index < sql.length) {
    if (sql.charAt(index) !== quote) {
      index += 1
      continue
    }
    if (sql.charAt(index + 1) === quote) {
      index += 2
      continue
    }
    return index + 1
  }
  throw new TypeError(`unterminated ${quote} literal in SQL statement`)
}

/**
 * Counts the anonymous `?` placeholders in a SQL statement.
 *
 * Question marks inside string literals, quoted identifiers, bracket identifiers, and comments
 * are ignored. Named (`:name`, `@name`, `$name`, `?name`) and numbered (`?1`) parameters are
 * rejected because the storage protocol only uses anonymous positional parameters.
 */
export function countAnonymousParameters(sql: string): number {
  let count = 0
  let index = 0

  while (index < sql.length) {
    const character = sql.charAt(index)

    if (character === "'" || character === '"' || character === '`') {
      index = skipQuoted(sql, index, character)
      continue
    }

    if (character === '[') {
      const end = sql.indexOf(']', index + 1)
      if (end === -1) {
        throw new TypeError('unterminated bracket identifier in SQL statement')
      }
      index = end + 1
      continue
    }
    if (character === '-' && sql.charAt(index + 1) === '-') {
      index += 2
      while (index < sql.length) {
        if (sql.charAt(index) === '\n') break
        index += 1
      }
      continue
    }

    if (character === '/' && sql.charAt(index + 1) === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) {
        throw new TypeError('unterminated block comment in SQL statement')
      }
      index = end + 2
      continue
    }
    if (character === '\uFEFF') {
      index += 1
      continue
    }

    if (IDENTIFIER_START.test(character)) {
      index += 1
      while (index < sql.length && IDENTIFIER_CHARACTER.test(sql.charAt(index))) {
        index += 1
      }
      continue
    }

    if (character === '?') {
      const next = sql.charAt(index + 1)
      if (next >= '0' && next <= '9') {
        throw new TypeError(
          `numbered parameter "${character}${next}" is not supported; use "?": ${sql}`,
        )
      }
      if (IDENTIFIER_START.test(next) || next === '$') {
        throw new TypeError(
          `named parameter "${character}${next}" is not supported; use "?": ${sql}`,
        )
      }
      count += 1
      index += 1
      continue
    }

    if (character === ':' || character === '@' || character === '$') {
      const next = sql.charAt(index + 1)
      if (IDENTIFIER_CHARACTER.test(next)) {
        throw new TypeError(
          `named parameter "${character}${next}" is not supported; use "?": ${sql}`,
        )
      }
    }

    index += 1
  }

  return count
}

function validateParameters(sql: string, expected: number, params: readonly unknown[]): void {
  if (params.length !== expected) {
    throw new TypeError(
      `SQL statement expects ${expected} anonymous parameter(s) but received ${params.length}: ${sql}`,
    )
  }

  for (let index = 0; index < params.length; index += 1) {
    if (params[index] === undefined) {
      throw new TypeError(
        `SQL parameter at index ${index} is undefined; pass null for an explicit SQL NULL: ${sql}`,
      )
    }
  }
}

function copyRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row

  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? new Uint8Array(value) : value,
    ]),
  )
}

function isThenable(value: unknown): boolean {
  if (value === null) return false
  if (typeof value !== 'object' && typeof value !== 'function') return false
  return 'then' in value && typeof value.then === 'function'
}

class Statement implements SqliteStatement {
  #native: NativeStatement
  #sql: string
  #parameterCount: number

  constructor(native: NativeStatement, sql: string, parameterCount: number) {
    this.#native = native
    this.#sql = sql
    this.#parameterCount = parameterCount
  }

  run(...params: readonly unknown[]): void {
    validateParameters(this.#sql, this.#parameterCount, params)
    this.#native.run(...params)
  }

  get<TRow = Record<string, unknown>>(...params: readonly unknown[]): Option<TRow> {
    validateParameters(this.#sql, this.#parameterCount, params)
    const row = this.#native.get(...params)
    if (row === null || row === undefined) return NONE
    return some(copyRow(row) as TRow)
  }

  all<TRow = Record<string, unknown>>(...params: readonly unknown[]): readonly TRow[] {
    validateParameters(this.#sql, this.#parameterCount, params)
    return this.#native.all(...params).map((row) => copyRow(row) as TRow)
  }
}

class Driver implements SqliteDriver {
  #database: NativeDatabase
  #inTransaction = false

  constructor(database: NativeDatabase) {
    this.#database = database
  }

  exec(sql: string): void {
    this.#database.exec(sql)
  }

  prepare(sql: string): SqliteStatement {
    const parameterCount = countAnonymousParameters(sql)
    return new Statement(this.#database.prepare(sql), sql, parameterCount)
  }

  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) {
      throw new InvariantError('nested SQLite transactions are not allowed')
    }

    this.#inTransaction = true
    let begun = false

    try {
      this.#database.exec('BEGIN IMMEDIATE')
      begun = true

      const result = fn()
      if (isThenable(result)) {
        throw new InvariantError('SQLite transaction callbacks must be synchronous')
      }

      this.#database.exec('COMMIT')
      begun = false
      return result
    } catch (error) {
      if (begun) {
        try {
          this.#database.exec('ROLLBACK')
        } catch {
          // Preserve the original failure; the connection may already be unusable.
        }
      }
      throw error
    } finally {
      this.#inTransaction = false
    }
  }

  close(): void {
    this.#database.close()
  }
}

function configureDatabase(database: NativeDatabase, dbPath: string, durability: Durability): void {
  if (dbPath === ':memory:') return

  database.exec('PRAGMA journal_mode = WAL')
  database.exec(
    durability === 'normal' ? 'PRAGMA synchronous = NORMAL' : 'PRAGMA synchronous = FULL',
  )
}

/**
 * Wraps a native SQLite database with the strict cross-host driver contract.
 *
 * The `open` callback isolates the host-specific constructor and binding types.
 */
export function createSqliteDriver(
  open: (dbPath: string) => NativeDatabase,
  options: SqliteDriverOptions = {},
): SqliteDriver {
  const dbPath = options.dbPath ?? ':memory:'
  const durability: unknown = options.durability ?? 'full'

  if (durability !== 'full' && durability !== 'normal') {
    throw new TypeError(`unsupported SQLite durability: ${String(durability)}`)
  }

  const database = open(dbPath)
  try {
    configureDatabase(database, dbPath, durability)
  } catch (error) {
    database.close()
    throw error
  }

  return new Driver(database)
}
