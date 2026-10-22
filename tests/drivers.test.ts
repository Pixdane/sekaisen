import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvariantError, NONE, some } from '@sekaisen/core'
import {
  type CommitHash,
  type SqliteDriver,
  type SqliteDriverOptions,
  WorldService,
} from '@sekaisen/plugin-world'
import { createBunSqliteDriver } from '@sekaisen/plugin-world/bun'
import { Context } from 'cordis'
import { countAnonymousParameters } from '../packages/plugin-world/src/driver.ts'

function withDriver(run: (driver: SqliteDriver) => void, options?: SqliteDriverOptions): void {
  const driver = createBunSqliteDriver(options)
  try {
    run(driver)
  } finally {
    driver.close()
  }
}

function count(driver: SqliteDriver, table: string): number {
  const row = driver.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get<{ total: number }>()
  if (row.kind !== 'some') throw new Error(`SELECT COUNT(*) returned no row for ${table}`)
  return Number(row.value.total)
}

function one<T>(value: { kind: 'some'; value: T } | { kind: 'none' }): T {
  if (value.kind !== 'some') throw new Error('expected Some but received NONE')
  return value.value
}

describe('anonymous parameter parsing', () => {
  test('counts only anonymous placeholders', () => {
    expect(countAnonymousParameters('INSERT INTO t (a, b) VALUES (?, ?)')).toBe(2)
    expect(countAnonymousParameters('SELECT 1')).toBe(0)
    expect(countAnonymousParameters('SELECT 1 AS foo$bar, ? AS baz$1')).toBe(1)
    expect(countAnonymousParameters('SELECT ?\uFEFF AS x')).toBe(1)
  })

  test('ignores question marks in literals, quoted identifiers, and comments', () => {
    expect(countAnonymousParameters('SELECT \'?\', "?", `?`, [?], ? -- ?\n, /* ? */ ?')).toBe(2)
    expect(countAnonymousParameters('SELECT 1 AS x --\r ?')).toBe(0)
  })

  test('rejects numbered and named parameters', () => {
    for (const sql of [
      'SELECT ?1',
      'SELECT ?name',
      'SELECT :name',
      'SELECT @name',
      'SELECT $name',
      'INSERT INTO amounts VALUES (\uFEFF$amount)',
      'SELECT :\uFEFFname',
    ]) {
      expect(() => countAnonymousParameters(sql)).toThrow(TypeError)
    }
  })

  test('rejects unterminated literals and comments', () => {
    expect(() => countAnonymousParameters("SELECT '?")).toThrow(TypeError)
    expect(() => countAnonymousParameters('SELECT /* ?')).toThrow(TypeError)
    expect(() => countAnonymousParameters('SELECT [?')).toThrow(TypeError)
  })
})

describe('SQLite driver contract', () => {
  test('defaults to an in-memory database and supports exec/run/get/all', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT')
      const insert = driver.prepare('INSERT INTO items (id, name) VALUES (?, ?)')

      expect(insert.run(1, 'alpha')).toBeUndefined()
      insert.run(2, 'beta')

      expect(
        driver.prepare('SELECT name FROM items WHERE id = ?').get<{ name: string }>(1),
      ).toEqual({ kind: 'some', value: { name: 'alpha' } })
      expect(
        driver
          .prepare('SELECT name FROM items ORDER BY id')
          .all<{ name: string }>()
          .map((row) => row.name),
      ).toEqual(['alpha', 'beta'])
      expect(driver.prepare('SELECT name FROM items WHERE id = ?').get(3)).toBe(NONE)
    })
  })

  test('rejects missing, extra, and undefined parameters', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE params (a INTEGER, b TEXT) STRICT')
      const insert = driver.prepare('INSERT INTO params (a, b) VALUES (?, ?)')

      expect(() => insert.run(1)).toThrow(TypeError)
      expect(() => insert.run(1, 'x', 2)).toThrow(TypeError)
      expect(() => insert.run(undefined, 'x')).toThrow(TypeError)
      expect(() => insert.run(1, undefined)).toThrow(TypeError)

      insert.run(1, null)

      const select = driver.prepare('SELECT a FROM params WHERE b IS ?')
      expect(() => select.get()).toThrow(TypeError)
      expect(() => select.get(null, 'extra')).toThrow(TypeError)
      expect(() => select.all(undefined)).toThrow(TypeError)
      expect(one(select.get<{ a: number }>(null)).a).toBe(1)
    })
  })

  test('ignores question marks in quoted text and comments when binding', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE quoted (a INTEGER, b TEXT) STRICT')
      driver.prepare("INSERT INTO quoted (a, b) VALUES (?, '?') -- ?\n/* ? */").run(1)
      expect(one(driver.prepare('SELECT b FROM quoted').get<{ b: string }>()).b).toBe('?')
      expect(one(driver.prepare('SELECT 1 AS foo$bar').get<{ foo$bar: number }>()).foo$bar).toBe(1)
      expect(one(driver.prepare('SELECT 1 AS x --\r ?').get<{ x: number }>()).x).toBe(1)
      expect(one(driver.prepare('SELECT ?\uFEFF AS x').get<{ x: number }>(7)).x).toBe(7)
      expect(() => driver.prepare('INSERT INTO quoted VALUES (1, \uFEFF$amount)')).toThrow(
        TypeError,
      )
    })
  })

  test('rejects named and numbered parameters at prepare time', () => {
    withDriver((driver) => {
      for (const sql of ['SELECT ?1', 'SELECT :name', 'SELECT @name', 'SELECT $name']) {
        expect(() => driver.prepare(sql)).toThrow(TypeError)
      }
    })
  })

  test('returns independent copies for BLOB values', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT')
      const insert = driver.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)')
      insert.run(1, new Uint8Array([1, 2, 3]))
      insert.run(2, new Uint8Array([4, 5]))

      const select = driver.prepare('SELECT data FROM blobs WHERE id = ?')
      const first = one(select.get<{ data: Uint8Array }>(1))
      const second = one(select.get<{ data: Uint8Array }>(2))

      expect(first.data).toEqual(new Uint8Array([1, 2, 3]))
      expect(first.data).not.toBe(second.data)

      first.data[0] = 99
      expect(one(select.get<{ data: Uint8Array }>(1)).data).toEqual(new Uint8Array([1, 2, 3]))

      const rows = driver.prepare('SELECT data FROM blobs ORDER BY id').all<{ data: Uint8Array }>()
      expect(rows[0]?.data).not.toBe(rows[1]?.data)
      expect(rows[0]?.data).toEqual(new Uint8Array([1, 2, 3]))
      expect(rows[1]?.data).toEqual(new Uint8Array([4, 5]))

      expect(select.get(3)).toBe(NONE)
    })
  })

  test('preserves __proto__ column aliases as own properties', () => {
    withDriver((driver) => {
      const row = one(
        driver.prepare(`SELECT 'value' AS "__proto__"`).get<Record<string, unknown>>(),
      )
      expect(Object.hasOwn(row, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
      // biome-ignore lint/suspicious/noProto: Intentionally exercise __proto__ own-property preservation.
      expect(row.__proto__).toBe('value')
    })
  })

  test('commits successful transactions and returns the callback result', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE tx (id INTEGER PRIMARY KEY) STRICT')

      const result = driver.transaction(() => {
        driver.prepare('INSERT INTO tx (id) VALUES (?)').run(1)
        return 'committed'
      })

      expect(result).toBe('committed')
      expect(count(driver, 'tx')).toBe(1)
    })
  })

  test('rolls back thrown transactions, rethrows, and stays usable', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE tx (id INTEGER PRIMARY KEY) STRICT')
      const failure = new Error('rollback me')

      let caught: unknown
      try {
        driver.transaction(() => {
          driver.prepare('INSERT INTO tx (id) VALUES (?)').run(1)
          throw failure
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toBe(failure)
      expect(count(driver, 'tx')).toBe(0)

      driver.transaction(() => {
        driver.prepare('INSERT INTO tx (id) VALUES (?)').run(2)
      })
      expect(count(driver, 'tx')).toBe(1)
    })
  })

  test('rejects Promise and thenable callbacks and rolls back', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE tx (id INTEGER PRIMARY KEY) STRICT')

      expect(() =>
        driver.transaction(() => {
          driver.prepare('INSERT INTO tx (id) VALUES (?)').run(1)
          return Promise.resolve('not allowed')
        }),
      ).toThrow(InvariantError)

      expect(() =>
        driver.transaction(() => {
          driver.prepare('INSERT INTO tx (id) VALUES (?)').run(2)
          // biome-ignore lint/suspicious/noThenProperty: Intentionally exercise rejection of thenables.
          return { then: () => undefined }
        }),
      ).toThrow(InvariantError)

      expect(count(driver, 'tx')).toBe(0)
    })
  })

  test('rejects nested transactions with InvariantError and rolls back the outer one', () => {
    withDriver((driver) => {
      driver.exec('CREATE TABLE tx (id INTEGER PRIMARY KEY) STRICT')

      expect(() =>
        driver.transaction(() => {
          driver.prepare('INSERT INTO tx (id) VALUES (?)').run(1)
          return driver.transaction(() => 2)
        }),
      ).toThrow(InvariantError)

      expect(count(driver, 'tx')).toBe(0)
      expect(driver.transaction(() => 3)).toBe(3)
    })
  })

  test('applies WAL with FULL durability by default for file databases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sekaisen-driver-'))
    try {
      withDriver(
        (driver) => {
          const journal = one(driver.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>())
          expect(journal.journal_mode).toBe('wal')
          const synchronous = one(
            driver.prepare('PRAGMA synchronous').get<{ synchronous: number }>(),
          )
          expect(synchronous.synchronous).toBe(2)
        },
        { dbPath: join(directory, 'full.sqlite') },
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('applies WAL with NORMAL durability when requested', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sekaisen-driver-'))
    try {
      withDriver(
        (driver) => {
          const journal = one(driver.prepare('PRAGMA journal_mode').get<{ journal_mode: string }>())
          expect(journal.journal_mode).toBe('wal')
          const synchronous = one(
            driver.prepare('PRAGMA synchronous').get<{ synchronous: number }>(),
          )
          expect(synchronous.synchronous).toBe(1)
        },
        { dbPath: join(directory, 'normal.sqlite'), durability: 'normal' },
      )
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test('rejects invalid durability values', () => {
    expect(() => createBunSqliteDriver({ durability: 'unsafe' as unknown as 'full' })).toThrow(
      TypeError,
    )
  })
  test('close releases the native connection', () => {
    const driver = createBunSqliteDriver()
    driver.close()
    expect(() => driver.prepare('SELECT 1').get()).toThrow()
  })

  test('Node createNodeSqliteDriver and Bun createBunSqliteDriver round-trip the same archive file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sekaisen-cross-host-'))
    const dbPath = join(directory, 'shared.sqlite')
    try {
      const script = `
        import { Context } from 'cordis'
        import { NONE, some } from './packages/core/src/index.ts'
        import { WorldService } from './packages/plugin-world/src/index.ts'
        import { createNodeSqliteDriver } from './packages/plugin-world/src/node.ts'
        const driver = createNodeSqliteDriver({ dbPath: process.argv[1] })
        const ctx = new Context()
        const world = new WorldService(ctx, { driver })
        const r = world.commit({
          parentId: NONE,
          message: ['\\uFEFFnode-msg', false, 42, new Uint8Array([7, 8]), null],
          diff: [
            { op: 'set', path: ['\\uFEFFk', 'numText'], value: '000123' },
            { op: 'set', path: ['flag'], value: true },
          ],
          advanceHead: '\\uFEFFmain',
        })
        if (!r.ok) throw new Error(JSON.stringify(r.error))
        console.log(r.value.id)
        driver.close()
      `
      const proc = Bun.spawnSync(['node', '--input-type=module', '-e', script, dbPath], {
        cwd: join(import.meta.dir, '..'),
      })
      if (proc.exitCode !== 0) {
        throw new Error(`Node driver subprocess failed: ${new TextDecoder().decode(proc.stderr)}`)
      }
      const nodeCommitId = new TextDecoder().decode(proc.stdout).trim() as CommitHash
      let bunChildId = '' as CommitHash

      withDriver(
        (driver) => {
          const world = new WorldService(new Context(), { driver })
          expect(world.getHead('\uFEFFmain')).toEqual(some(nodeCommitId))
          expect(world.getMessage(nodeCommitId)).toEqual({
            ok: true,
            value: ['\uFEFFnode-msg', false, 42, new Uint8Array([7, 8]), null],
          })
          expect(world.getValue(nodeCommitId, ['\uFEFFk', 'numText'])).toEqual({
            ok: true,
            value: some('000123'),
          })
          expect(world.getValue(nodeCommitId, ['flag'])).toEqual({
            ok: true,
            value: some(true),
          })
          const child = world.commit({
            parentId: some(nodeCommitId),
            message: '\uFEFFbun-child',
            diff: [{ op: 'ref', path: ['refToRoot'], ref: { commitId: nodeCommitId, path: [] } }],
            advanceHead: '\uFEFFmain',
          })
          if (!child.ok) throw new Error(JSON.stringify(child.error))
          bunChildId = child.value.id
        },
        { dbPath },
      )

      const verifyScript = `
        import { Context } from 'cordis'
        import { InvariantError, NONE, some } from './packages/core/src/index.ts'
        import { WorldService } from './packages/plugin-world/src/index.ts'
        import { createNodeSqliteDriver } from './packages/plugin-world/src/node.ts'
        const driver = createNodeSqliteDriver({ dbPath: process.argv[1] })
        const world = new WorldService(new Context(), { driver })
        const head = world.getHead('\\uFEFFmain')
        if (head.kind !== 'some') throw new Error('missing head')
        const msg = world.getMessage(head.value)
        if (!msg.ok || msg.value !== '\\uFEFFbun-child') throw new Error('bad message')
        const deepPath = Array(3000).fill('x')
        const deep = world.commit({
          parentId: some(head.value),
          message: 'deep',
          diff: [{ op: 'set', path: deepPath, value: 7 }],
        })
        if (!deep.ok) throw new Error('deep commit failed')
        const nodeView = world.getNode(deep.value.id)
        if (!nodeView.ok || nodeView.value.kind !== 'some') throw new Error('deep getNode failed')
        driver.prepare("UPDATE commits SET msg_raw = CAST(X'EDA080' AS TEXT) WHERE id = ?").run(deep.value.id)
        const reloaded = new WorldService(new Context(), { driver })
        let threw = false
        try { reloaded.getMessage(deep.value.id) } catch (e) { threw = e instanceof InvariantError }
        if (!threw) throw new Error('expected InvariantError on invalid UTF-8 in Node')
        console.log(head.value)
        driver.close()
      `
      const verifyProc = Bun.spawnSync(
        ['node', '--input-type=module', '-e', verifyScript, dbPath],
        { cwd: join(import.meta.dir, '..') },
      )
      if (verifyProc.exitCode !== 0) {
        throw new Error(
          `Node verification subprocess failed: ${new TextDecoder().decode(verifyProc.stderr)}`,
        )
      }
      expect(new TextDecoder().decode(verifyProc.stdout).trim()).toBe(bunChildId)
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
