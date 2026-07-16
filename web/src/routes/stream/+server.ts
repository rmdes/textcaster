import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const GET: RequestHandler = async ({ request }) => {
	// EventSource sends Last-Event-ID on auto-reconnect; forwarding it lets core
	// replay missed posts through this proxy. A FRESH EventSource (e.g. reopened
	// after a hidden tab released its connection) cannot set that header, so
	// ?last= is the query-param fallback — the header wins when both exist.
	const lastEventId = request.headers.get('last-event-id') ?? new URL(request.url).searchParams.get('last')
	const upstream = await fetch(`${base()}/timeline/stream`, {
		signal: request.signal,
		headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {}
	})
	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }
		})
	}
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	})
}
