import { test, expect, beforeEach } from 'vitest'
import { loadDraft, saveDraft } from './draft.ts'

const store = new Map<string, string>()
globalThis.localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k)
} as Storage

beforeEach(() => store.clear())

test('save then load round-trips a draft', () => {
	saveDraft('compose', { handle: 'ric', content: 'hello **world**' })
	expect(loadDraft('compose')).toEqual({ handle: 'ric', content: 'hello **world**' })
})

test('a never-saved key loads as an empty draft', () => {
	expect(loadDraft('compose')).toEqual({})
})

test('corrupt stored JSON loads as an empty draft', () => {
	store.set('textcaster:draft:compose', '{nope')
	expect(loadDraft('compose')).toEqual({})
})

test('a non-object stored value loads as an empty draft', () => {
	store.set('textcaster:draft:compose', '123')
	expect(loadDraft('compose')).toEqual({})
})

test('saving an all-blank draft removes the stored entry', () => {
	saveDraft('compose', { handle: 'ric', content: 'x' })
	saveDraft('compose', { handle: '  ', content: '' })
	expect(store.has('textcaster:draft:compose')).toBe(false)
})

test('keys are namespaced per composer', () => {
	saveDraft('compose', { content: 'a' })
	saveDraft('reply:p-1', { content: 'b' })
	expect(loadDraft('compose').content).toBe('a')
	expect(loadDraft('reply:p-1').content).toBe('b')
})
