<script lang="ts">
	import { splitLinks } from './linkify'

	// Bare URLs render as anchors (rss.chat: "links show up the moment you save
	// them"). Segments render as elements, never markup — no {@html}, no XSS.
	let { text }: { text: string } = $props()
	const segments = $derived(splitLinks(text))
</script>

{#each segments as seg, i (i)}{#if seg.url}<a href={seg.url} rel="noreferrer">{seg.text}</a>{:else}{seg.text}{/if}{/each}
