import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { makeAuth } from './auth-helper.ts'

// The reviewer-approved assertion: prove the flag toggles OUR conditional,
// not better-auth's schema output (which is better-auth's to test).
test('generateOpenAPISchema is present only when the flag is on', async () => {
  const repo = await createSqliteRepository(':memory:')
  const off = makeAuth(repo)              // flag defaults off
  const on = makeAuth(repo, null, true)   // flag on
  expect(typeof (off.api as Record<string, unknown>).generateOpenAPISchema).toBe('undefined')
  expect(typeof (on.api as Record<string, unknown>).generateOpenAPISchema).toBe('function')
})
