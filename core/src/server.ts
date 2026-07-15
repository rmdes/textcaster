import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.ts'
import { createSqliteRepository } from './storage/sqlite.ts'
import { createEventBus } from './domain/bus.ts'
import { createService } from './domain/service.ts'
import { createApp } from './api/app.ts'
import { pollAll } from './domain/ingest.ts'

const config = loadConfig()
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })

const repo = await createSqliteRepository(config.dbPath)
const bus = createEventBus()
const service = createService(repo, bus)
const app = createApp({ service, bus, token: config.token })

async function loop() {
  try { await pollAll(repo, bus) } catch (err) { console.error('pollAll failed:', err instanceof Error ? err.message : err) }
  setTimeout(loop, config.pollSeconds * 1000)
}
setTimeout(loop, config.pollSeconds * 1000)

serve({ fetch: app.fetch, port: config.port })
console.log(`textcaster core listening on :${config.port}`)
