import { test, expect } from 'vitest'
import { loadConfig } from '../src/config.ts'

test('requires a token', () => {
  expect(() => loadConfig({})).toThrow('TEXTCASTER_TOKEN')
})
test('applies defaults', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't' })
  expect(c.port).toBe(8787)
  expect(c.pollSeconds).toBe(60)
})
test('rejects a non-numeric port', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PORT: 'abc' })).toThrow('TEXTCASTER_PORT')
})
test('rejects a non-numeric poll interval', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_POLL_SECONDS: 'soon' })).toThrow('TEXTCASTER_POLL_SECONDS')
})
test('push defaults off and publicUrl defaults null', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't' })
  expect(c.websub).toEqual({ mode: 'off' })
  expect(c.rssCloud).toBe(false)
  expect(c.publicUrl).toBeNull()
})
test('publicUrl is normalized and must be http(s)', () => {
  const c = loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com/' })
  expect(c.publicUrl).toBe('https://cast.example.com')
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'ftp://x' })).toThrow('TEXTCASTER_PUBLIC_URL')
})
test('websub modes parse: self, external URL, garbage rejected', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, TEXTCASTER_WEBSUB: 'self' }).websub).toEqual({ mode: 'self' })
  expect(loadConfig({ ...base, TEXTCASTER_WEBSUB: 'https://websubhub.com/hub' }).websub).toEqual({ mode: 'external', hubUrl: 'https://websubhub.com/hub' })
  expect(() => loadConfig({ ...base, TEXTCASTER_WEBSUB: 'not a url' })).toThrow('TEXTCASTER_WEBSUB')
})
test('explicitly enabled push without publicUrl fails fast', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_WEBSUB: 'self' })).toThrow('TEXTCASTER_PUBLIC_URL')
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_RSSCLOUD: 'on' })).toThrow('TEXTCASTER_PUBLIC_URL')
})
test('rssCloud accepts only on/off', () => {
  const base = { TEXTCASTER_TOKEN: 't', TEXTCASTER_PUBLIC_URL: 'https://cast.example.com' }
  expect(loadConfig({ ...base, TEXTCASTER_RSSCLOUD: 'on' }).rssCloud).toBe(true)
  expect(() => loadConfig({ ...base, TEXTCASTER_RSSCLOUD: 'yes' })).toThrow('TEXTCASTER_RSSCLOUD')
})
test('pushIn defaults on, accepts off, rejects garbage', () => {
  expect(loadConfig({ TEXTCASTER_TOKEN: 't' }).pushIn).toBe(true)
  expect(loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUSH_IN: 'off' }).pushIn).toBe(false)
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUSH_IN: 'maybe' })).toThrow('TEXTCASTER_PUSH_IN')
})
test('pushIn on without publicUrl is NOT a startup error (dormant, not fatal)', () => {
  expect(() => loadConfig({ TEXTCASTER_TOKEN: 't', TEXTCASTER_PUSH_IN: 'on' })).not.toThrow()
})
