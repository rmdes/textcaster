export interface Config { dbPath: string; token: string; port: number; pollSeconds: number }

function positiveInt(name: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.TEXTCASTER_TOKEN
  if (!token) throw new Error('TEXTCASTER_TOKEN is required')
  return {
    dbPath: env.TEXTCASTER_DB ?? './data/textcaster.db',
    token,
    port: positiveInt('TEXTCASTER_PORT', env.TEXTCASTER_PORT ?? '8787'),
    pollSeconds: positiveInt('TEXTCASTER_POLL_SECONDS', env.TEXTCASTER_POLL_SECONDS ?? '60'),
  }
}
