import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export function bearerAuth(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`)
  return async (c, next) => {
    const header = Buffer.from(c.req.header('authorization') ?? '')
    if (header.length !== expected.length || !timingSafeEqual(header, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  }
}
