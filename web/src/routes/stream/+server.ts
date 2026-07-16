import type { RequestHandler } from './$types'
import { env } from '$env/dynamic/private'
import { renderPostHtml } from '$lib/server/render'

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
	// COR-3: a real SSE frame transformer, not a body pipe. Frames are
	// buffered across chunks and split on the blank-line delimiter; id: and
	// event: lines pass through BYTE-VERBATIM (the Last-Event-ID replay
	// contract rests on them); only post events' data: JSON is enriched.
	// Anything unparseable forwards untouched — the client falls back to
	// plaintext, never raw.
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ''
	const enrichFrame = (frame: string): string => {
		if (!/^event: post$/m.test(frame)) return frame
		return frame
			.split('\n')
			.map((line) => {
				if (!line.startsWith('data: ')) return line
				try {
					const entry = JSON.parse(line.slice(6))
					return `data: ${JSON.stringify({ ...entry, contentHtml: renderPostHtml(entry) })}`
				} catch {
					return line
				}
			})
			.join('\n')
	}
	const transformed = upstream.body!.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true })
				const frames = buffer.split('\n\n')
				buffer = frames.pop() ?? ''
				for (const frame of frames) controller.enqueue(encoder.encode(enrichFrame(frame) + '\n\n'))
			},
			flush(controller) {
				if (buffer) controller.enqueue(encoder.encode(enrichFrame(buffer)))
			}
		})
	)
	return new Response(transformed, {
		status: upstream.status,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache'
		}
	})
}
