<script lang="ts">
	import type { PageData, ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<svelte:head><title>Settings — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>Settings</h1>

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<form method="POST" action="?/save" class="auth-form">
		<label class="visually-hidden" for="settings-handle">Handle</label>
		<input id="settings-handle" name="handle" placeholder="handle" value={data.me?.user.handle ?? ''} />
		<label class="visually-hidden" for="settings-display-name">Display name</label>
		<input id="settings-display-name" name="displayName" placeholder="display name" value={data.me?.user.displayName ?? ''} />
		<button>Save</button>
	</form>
</div>
