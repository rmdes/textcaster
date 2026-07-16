import { test, expect } from 'vitest'
import { splitLinks } from './linkify'

test('plain text passes through as one segment', () => {
	expect(splitLinks('no links here')).toEqual([{ text: 'no links here' }])
})

test('a bare URL becomes a link segment; trailing punctuation stays text', () => {
	expect(splitLinks('see http://scripting.com/2026/07/16.html. Nice.')).toEqual([
		{ text: 'see ' },
		{ text: 'http://scripting.com/2026/07/16.html', url: 'http://scripting.com/2026/07/16.html' },
		{ text: '. Nice.' }
	])
})

test('multiple URLs and https', () => {
	const segs = splitLinks('a https://a.ex/1 b https://b.ex/2')
	expect(segs.filter((s) => s.url).map((s) => s.url)).toEqual(['https://a.ex/1', 'https://b.ex/2'])
})

test('only http(s) matches — javascript: stays text', () => {
	expect(splitLinks('click javascript:alert(1) now')).toEqual([{ text: 'click javascript:alert(1) now' }])
})
