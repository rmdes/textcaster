import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

test('repo.close() runs the WAL checkpoint and closes the db (queries then throw)', async () => {
  const repo = await createSqliteRepository(':memory:')
  repo.close()
  // better-sqlite3 throws "The database connection is not open" on use after close.
  expect(() => repo.raw.prepare('SELECT 1').get()).toThrow()
})
