<script lang="ts">
	import type { ActionData } from './$types'
	import ThemeToggle from '$lib/ThemeToggle.svelte'

	let { form }: { form: ActionData } = $props()
</script>

<svelte:head><title>Log in — Textcaster</title></svelte:head>

<div class="lens">
	<header class="masthead">
		<a href="/">Textcaster</a>
		<ThemeToggle />
	</header>

	<h1>Log in</h1>

	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}

	<form method="POST" action="?/login" class="auth-form">
		<label class="visually-hidden" for="login-email">Email</label>
		<input id="login-email" name="email" type="email" placeholder="email" autocomplete="email" required />
		<label class="visually-hidden" for="login-password">Password</label>
		<input id="login-password" name="password" type="password" placeholder="password" autocomplete="current-password" required />
		<button>Log in</button>
	</form>

	<p class="auth-note">No account yet? <a href="/register">Register</a>.</p>
</div>
