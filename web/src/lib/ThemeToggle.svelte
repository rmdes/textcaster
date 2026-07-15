<script lang="ts">
	import { browser } from '$app/environment';

	function toggle() {
		const root = document.documentElement;
		const dark = root.dataset.theme
			? root.dataset.theme === 'dark'
			: matchMedia('(prefers-color-scheme: dark)').matches;
		const next = dark ? 'light' : 'dark';
		root.dataset.theme = next;
		localStorage.theme = next;
	}
</script>

{#if browser}
	<button type="button" class="theme-toggle" onclick={toggle} aria-label="Toggle light/dark theme">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
		</svg>
	</button>
{/if}
