import { test, expect, vi } from 'vitest'
import { actions } from './+page.server.ts'

function formRequest(fields: Record<string, string>): Request {
	const body = new URLSearchParams(fields)
	return new Request('http://x/?/compose', { method: 'POST', body })
}

test('compose posts to the core and redirects', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 201 }))
	await expect(
		actions.compose({ request: formRequest({ handle: 'alice', content: 'hi' }), fetch } as never)
	).rejects.toMatchObject({ status: 303 }) // redirect throws
	expect(fetch).toHaveBeenCalled()
})

test('compose fails without content', async () => {
	const fetch = vi.fn()
	const res = await actions.compose({ request: formRequest({ handle: 'alice' }), fetch } as never)
	expect(res).toMatchObject({ status: 400 })
})

test('compose returns fail(400) when the core rejects the request', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 400 }))
	const res = await actions.compose(
		{ request: formRequest({ handle: 'alice', content: 'hi' }), fetch } as never
	)
	expect(res).toMatchObject({ status: 400 })
	expect((res as { data: { error: string } }).data.error).toMatch(/createPost/)
})

test('addRemote posts to the core and redirects', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 201 }))
	const request = new Request('http://x/?/addRemote', {
		method: 'POST',
		body: new URLSearchParams({ handle: 'bob', feedUrl: 'https://example.com/feed.xml' })
	})
	await expect(actions.addRemote({ request, fetch } as never)).rejects.toMatchObject({
		status: 303
	})
	expect(fetch).toHaveBeenCalled()
})

test('addRemote fails without feedUrl', async () => {
	const fetch = vi.fn()
	const request = new Request('http://x/?/addRemote', {
		method: 'POST',
		body: new URLSearchParams({ handle: 'bob' })
	})
	const res = await actions.addRemote({ request, fetch } as never)
	expect(res).toMatchObject({ status: 400 })
})

test('addRemote returns fail(400) when the core rejects the request', async () => {
	const fetch = vi.fn(async () => new Response(null, { status: 400 }))
	const request = new Request('http://x/?/addRemote', {
		method: 'POST',
		body: new URLSearchParams({ handle: 'bob', feedUrl: 'https://example.com/feed.xml' })
	})
	const res = await actions.addRemote({ request, fetch } as never)
	expect(res).toMatchObject({ status: 400 })
	expect((res as { data: { error: string } }).data.error).toMatch(/addRemoteUser/)
})
