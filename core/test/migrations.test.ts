import { test, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteRepository } from '../src/storage/sqlite.ts'

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'txc-mig-')), 'test.db')
}

test('a fresh database migrates to the current version and works', async () => {
  const file = tempDb()
  const repo = await createSqliteRepository(file)
  const u = await repo.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  expect((await repo.getTimeline(10)).length).toBe(0)
  expect(u.handle).toBe('alice')
  const raw = new Database(file, { readonly: true })
  expect(raw.pragma('user_version', { simple: true })).toBe(1)
  raw.close()
})

test('reopening an already-current database is a no-op', async () => {
  const file = tempDb()
  const first = await createSqliteRepository(file)
  await first.createLocalUser({ handle: 'alice', displayName: 'Alice' })
  const second = await createSqliteRepository(file)
  expect((await second.getUserByHandle('alice'))?.handle).toBe('alice')
})

test('a version-0 database that already has tables fails fast', async () => {
  const file = tempDb()
  const raw = new Database(file)
  raw.exec('CREATE TABLE users (id text)')
  raw.close()
  await expect(createSqliteRepository(file)).rejects.toThrow(/pre-migration database/)
})

test('a database stamped newer than this build fails fast', async () => {
  const file = tempDb()
  const raw = new Database(file)
  raw.pragma('user_version = 99')
  raw.close()
  await expect(createSqliteRepository(file)).rejects.toThrow(/newer than this build/)
})
