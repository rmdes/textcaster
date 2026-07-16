<script lang="ts">
	import type { TimelineEntry } from './types.ts'

	let { onPost }: { onPost: (entry: TimelineEntry) => void } = $props()

	// Browsers allow 6 concurrent HTTP/1.1 connections per origin, and an open
	// EventSource pins one for the tab's lifetime — enough hidden tabs starve
	// every other request (clicks, forms, navigation) into a permanent queue.
	// Hold the stream only while the tab is visible; on return, reopen from the
	// last seen event via ?last= so posts that arrived while hidden replay
	// (consumers dedup by id).
	let visible = $state(true)
	let lastId: string | null = null // deliberately non-reactive: must not reopen the stream per event

	$effect(() => {
		const sync = () => {
			visible = document.visibilityState === 'visible'
		}
		sync()
		document.addEventListener('visibilitychange', sync)
		return () => document.removeEventListener('visibilitychange', sync)
	})

	$effect(() => {
		if (!visible) return
		const es = new EventSource(lastId ? `/stream?last=${encodeURIComponent(lastId)}` : '/stream')
		es.addEventListener('post', (ev) => {
			try {
				const me = ev as MessageEvent
				onPost(JSON.parse(me.data))
				if (me.lastEventId) lastId = me.lastEventId
			} catch {
				// ignore malformed frames
			}
		})
		return () => es.close()
	})
</script>
