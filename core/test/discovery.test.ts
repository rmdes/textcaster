import { test, expect } from 'vitest'
import { discoverFeed, parseInReplyTo, truncate } from '../src/domain/discovery.ts'

test('autodiscovery: returns the first alternate feed link, absolute, excluding bare json', () => {
  // microformats-parser rejects a <body> with no element children ("unable to
  // parse HTML"), so the body carries a harmless element — irrelevant to what
  // this test checks (head link parsing/ordering/resolution).
  const html = `<html><head>
    <link rel="alternate" type="application/json" href="/api.json">
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://other.example/atom">
  </head><body><p>hi</p></body></html>`
  const { feedUrl } = discoverFeed(html, 'https://site.example/blog')
  expect(feedUrl).toBe('https://site.example/feed.xml') // relative resolved, json skipped, first feed-typed wins
})

test('autodiscovery: none present → null', () => {
  // Same body-must-have-an-element constraint as above.
  const { feedUrl, hentries } = discoverFeed('<html><head></head><body><p>plain</p></body></html>', 'https://site.example/')
  expect(feedUrl).toBeNull()
  expect(hentries).toEqual([])
})

test('h-feed: a titled article keeps its title; an untitled note has title null (implied-name dropped)', () => {
  const html = `<div class="h-feed">
    <article class="h-entry"><h1 class="p-name">Real Title</h1><div class="e-content">Article body.</div><time class="dt-published" datetime="2026-01-01T10:00:00Z"></time><a class="u-url" href="https://s.ex/a">l</a></article>
    <div class="h-entry"><p class="e-content">Just a note, no title.</p><time class="dt-published" datetime="2026-01-02T10:00:00Z"></time><a class="u-url" href="https://s.ex/n">l</a></div>
  </div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/page')
  expect(hentries).toHaveLength(2)
  const article = hentries.find((h) => h.url === 'https://s.ex/a')!
  const note = hentries.find((h) => h.url === 'https://s.ex/n')!
  expect(article.title).toBe('Real Title')
  expect(article.content).toContain('Article body')
  expect(note.title).toBeNull()
  expect(note.content).toContain('Just a note')
  expect(note.guid).toBe('https://s.ex/n') // guid from u-url
})

test('h-feed: an undated note gets a deterministic guid across two parses (raw-date discipline)', () => {
  const html = `<div class="h-entry"><p class="e-content">dateless and linkless note</p></div>`
  const a = discoverFeed(html, 'https://s.ex/p').hentries[0]
  const b = discoverFeed(html, 'https://s.ex/p').hentries[0]
  expect(a.guid).toBe(b.guid) // fallbackGuid hashes raw fields, not "now"
})

test('h-feed: multiple bare h-entries with NO h-feed wrapper are all mapped (P1)', () => {
  const html = `<div class="h-entry"><p class="e-content">note one</p><a class="u-url" href="https://s.ex/1">l</a></div>
    <div class="h-entry"><p class="e-content">note two</p><a class="u-url" href="https://s.ex/2">l</a></div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/')
  expect(hentries.map((h) => h.url).sort()).toEqual(['https://s.ex/1', 'https://s.ex/2'])
})

test('degenerate HTML (childless body) → nulls, never throws (spec §7)', () => {
  const { feedUrl, hentries } = discoverFeed('<html><head></head><body></body></html>', 'https://s.ex/')
  expect(feedUrl).toBeNull()
  expect(hentries).toEqual([])
})

test('a single h-entry carrying a nested microformat (e.g. h-card) is still mapped', () => {
  const html = `<div class="h-entry"><p class="e-content">hi</p><a class="u-url" href="https://s.ex/1">l</a><div class="h-card">Nested card</div></div>`
  const { hentries } = discoverFeed(html, 'https://s.ex/')
  expect(hentries.map((h) => h.url)).toEqual(['https://s.ex/1'])
})

test('parseInReplyTo: string ref → ref, no context', () => {
  expect(parseInReplyTo('https://a/1')).toEqual({ ref: 'https://a/1', contextAuthor: null, contextSnippet: null })
})
test('parseInReplyTo: single h-cite → url ref + author + snippet', () => {
  const cite = { type: 'cite', url: 'https://a/1', author: { type: 'card', name: 'aaronpk' }, content: { html: '<p>hi</p>', text: 'hi there' } }
  expect(parseInReplyTo(cite)).toEqual({ ref: 'https://a/1', contextAuthor: 'aaronpk', contextSnippet: 'hi there' })
})
test('parseInReplyTo: multi-cite {children:[…]} → first cite ref (F1)', () => {
  const irt = { children: [{ type: 'cite', url: 'https://a/1', author: { name: 'x' } }, { type: 'cite', url: 'https://a/2' }] }
  expect(parseInReplyTo(irt).ref).toBe('https://a/1')
})
test('parseInReplyTo: array url → url[0] (F2)', () => {
  expect(parseInReplyTo({ type: 'cite', url: ['https://a/1', 'https://a/2'], author: { name: 'x' } }).ref).toBe('https://a/1')
})
test('parseInReplyTo: plain-string author', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', author: 'Aaron Parecki' }).contextAuthor).toBe('Aaron Parecki')
})
test('parseInReplyTo: no url → ref null, author kept', () => {
  expect(parseInReplyTo({ type: 'cite', author: { name: 'x' } })).toEqual({ ref: null, contextAuthor: 'x', contextSnippet: null })
})
test('parseInReplyTo: html-only content → snippet null (author-only)', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', author: { name: 'x' }, content: { html: '<p>hi</p>' } }).contextSnippet).toBeNull()
})
test('parseInReplyTo: snippet but NO author → whole context dropped (P4)', () => {
  expect(parseInReplyTo({ type: 'cite', url: 'https://a/1', content: { text: 'hi' } }))
    .toEqual({ ref: 'https://a/1', contextAuthor: null, contextSnippet: null })
})
test('parseInReplyTo: non-cite / undefined → all null', () => {
  expect(parseInReplyTo(undefined)).toEqual({ ref: null, contextAuthor: null, contextSnippet: null })
})

test('truncate: null / empty / all-whitespace → null (never a bare …)', () => {
  expect(truncate(null, 200)).toBeNull()
  expect(truncate('   ', 200)).toBeNull()
})
test('truncate: short string returned as-is (trimmed)', () => {
  expect(truncate('  hi  ', 200)).toBe('hi')
})
test('truncate: >n code points → n + …, code-point-safe at an astral boundary', () => {
  const out = truncate('😀'.repeat(250), 200)!
  expect(Array.from(out)).toHaveLength(201) // 200 code points + the …
  expect(out.endsWith('…')).toBe(true)
  expect(out).not.toContain('�') // no split surrogate
})
