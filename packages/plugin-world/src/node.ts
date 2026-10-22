import type { SQLInputValue } from 'node:sqlite'
import { DatabaseSync } from 'node:sqlite'
import type { NativeDatabase } from './driver.ts'
import { createSqliteDriver } from './driver.ts'
import type { SqliteDriver, SqliteDriverOptions } from './types.ts'

/**
 * Creates a SQLite driver backed by Node.js' native `node:sqlite` implementation.
 *
 * Requires Node.js >= 22.13.0. The database defaults to an in-memory database.
 */
export function createNodeSqliteDriver(options: SqliteDriverOptions = {}): SqliteDriver {
  return createSqliteDriver((dbPath): NativeDatabase => {
    const database = new DatabaseSync(dbPath)

    return {
      exec: (sql) => {
        database.exec(sql)
      },
      prepare: (sql) => {
        const statement = database.prepare(sql)
        return {
          run: (...params) => {
            statement.run(...(params as SQLInputValue[]))
          },
          get: (...params) => statement.get(...(params as SQLInputValue[])),
          all: (...params) => statement.all(...(params as SQLInputValue[])),
        }
      },
      close: () => {
        database.close()
      },
    }
  }, options)
}
