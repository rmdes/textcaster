import { test, expect } from 'vitest'
import { createSqliteRepository } from '../src/storage/sqlite.ts'
import { createEventBus } from '../src/domain/bus.ts'
import { createService } from '../src/domain/service.ts'
import { createApp } from '../src/api/app.ts'
import { runSmoke } from '../src/smoke.ts'
import { makeAuth } from './auth-helper.ts'

test('smoke: anonymous sign-in, post, /me, and ops-token user seeding all work end to end', async () => {
  const repo = await createSqliteRepository(':memory:')
  const bus = createEventBus()
  const service = createService(repo, bus)
  const app = createApp({ service, bus, token: 'secret', auth: makeAuth(repo), users: repo })

  await runSmoke(app, 'secret', 'http://web.test')

  expect(await repo.getUserByHandle('smoke-remote')).toBeDefined()
})
