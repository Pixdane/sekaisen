import type { SQLQueryBindings } from 'bun:sqlite'
import { Database } from 'bun:sqlite'
import type { NativeDatabase } from './driver.ts'
import { createSqliteDriver } from './driver.ts'
import type { SqliteDriver, SqliteDriverOptions } from './types.ts'

/**
 * Creates a SQLite driver backed by Bun's native `bun:sqlite` implementation.
 *
 * The database defaults to an in-memory database and Bun strict mode is always enabled.
 */
export function createBunSqliteDriver(options: SqliteDriverOptions = {}): SqliteDriver {
  return createSqliteDriver((dbPath): NativeDatabase => {
    const database = new Database(dbPath, { strict: true })

    return {
      exec: (sql) => {
        database.run(sql)
      },
      prepare: (sql) => {
        const statement = database.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql)
        return {
          run: (...params) => {
            statement.run(...(params as SQLQueryBindings[]))
          },
          get: (...params) => statement.get(...(params as SQLQueryBindings[])),
          all: (...params) => statement.all(...(params as SQLQueryBindings[])),
        }
      },
      close: () => {
        database.close()
      },
    }
  }, options)
}
