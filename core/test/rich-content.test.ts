import { test, expect } from 'vitest'
import { parseFeedWithMeta } from '../src/domain/ingest.ts'
import { renderLocalHtml } from '../src/domain/markdown.ts'
import { renderRssFeed, renderJsonFeed } from '../src/domain/feed.ts'
import type { User, Post } from '../src/domain/types.ts'

test('source:markdown is captured verbatim into ParsedItem.contentMarkdown', async () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:source="http://source.scripting.com/"><channel><title>t</title>
<item><guid>g1</guid><description>&lt;p&gt;html&lt;/p&gt;</description><source:markdown>**md** with [link](https://x.ex)</source:markdown></item>
<item><guid>g2</guid><description>plain</description></item>
</channel></rss>`
  const { items } = await parseFeedWithMeta(rss)
  expect(items[0].contentMarkdown).toBe('**md** with [link](https://x.ex)')
  expect(items[1].contentMarkdown).toBeNull()
})

const alice: User = { id: 'u1', kind: 'local', handle: 'alice', displayName: 'Alice', feedUrl: null, createdAt: '2026-01-01T00:00:00.000Z' }
const basePost: Post = { id: 'p1', authorId: 'u1', source: 'local', guid: 'g-1', title: null, content: '', url: null, publishedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }
const ctx = { publicUrl: 'https://cast.example', hubUrl: null, rssCloud: false }

test('renderLocalHtml renders markdown and sanitizes raw HTML a member typed (SEC-4)', () => {
  const html = renderLocalHtml('**bold** then <script>alert(1)</script> and https://a.ex/1')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<a href="https://a.ex/1" rel="noreferrer">') // GFM autolink + forced rel
  expect(html).not.toContain('<script>')
})

test('RSS dual contract: local posts emit rendered description + raw source:markdown', () => {
  const xml = renderRssFeed(alice, [{ ...basePost, content: '**hello** world' }], ctx)
  expect(xml).toContain('<strong>hello</strong>')
  expect(xml).toContain('<source:markdown>**hello** world</source:markdown>')
})

test('RSS pass-through: remote posts re-emit content untouched + stored markdown verbatim', () => {
  const remote = { ...basePost, id: 'p2', guid: 'g-2', source: 'remote' as const, content: '<p>as-authored &amp; untouched</p>', contentMarkdown: '**their** source' }
  const xml = renderRssFeed(alice, [remote], ctx)
  expect(xml).toContain('as-authored') // content not re-rendered/sanitized
  expect(xml).toContain('<source:markdown>**their** source</source:markdown>')
})

test('JSON Feed: local posts carry content_html (rendered) + content_text (raw markdown)', () => {
  const json = JSON.parse(renderJsonFeed(alice, [{ ...basePost, content: '**hello**' }], ctx))
  expect(json.items[0].content_html).toContain('<strong>hello</strong>')
  expect(json.items[0].content_text).toBe('**hello**')
})

test('JSON Feed ingest prefers content_html over content_text (our own feeds emit rendered HTML + raw markdown)', async () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 't',
    items: [{ id: 'g1', content_html: '<p><strong>hi</strong></p>', content_text: '**hi**' }],
  })
  const { items } = await parseFeedWithMeta(json)
  expect(items[0].content).toBe('<p><strong>hi</strong></p>')
})

test('reply+markdown co-occurrence: a LOCAL reply carries inReplyTo AND source:markdown in the same item', () => {
  const reply = { ...basePost, content: '**re** body', inReplyTo: 'https://a.ex/1' }
  const xml = renderRssFeed(alice, [reply], ctx)
  expect(xml).toContain('<source:inReplyTo')
  expect(xml).toContain('<thr:in-reply-to')
  expect(xml).toContain('<source:markdown>**re** body</source:markdown>')
})

// Drift canary: same hostile fixtures as web's render.test.ts hostile block,
// run against core's renderLocalHtml. Two sanitizer configs, one behavioral
// contract — this catches the allowlist drifting apart between them.
test('renderLocalHtml hostile fixtures never survive (drift canary vs web/src/lib/server/render.ts)', () => {
  expect(renderLocalHtml('<script>alert(1)</script>ok')).not.toContain('script')
  expect(renderLocalHtml('<img src="x" onerror="p()">')).not.toContain('onerror')
  expect(renderLocalHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  expect(renderLocalHtml('<img src="data:image/png;base64,xx">')).not.toContain('data:')
  expect(renderLocalHtml('<svg onload="p()"></svg>')).not.toContain('svg')
  expect(renderLocalHtml('<p class="x" style="y">attrs stripped</p>')).not.toContain('class=')
  expect(renderLocalHtml('<a href="//evil.com">x</a>')).not.toContain('href=')
})
