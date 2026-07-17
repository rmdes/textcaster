import type { Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { cookieHeader, relaySetCookies } from '$lib/server/session'
import { env } from '$env/dynamic/private'

const base = () => env.CORE_API_URL ?? 'http://localhost:8787'

export const actions = {
	register: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const email = String(form.get('email') ?? '').trim()
		const password = String(form.get('password') ?? '')
		if (!email || password.length < 8) return fail(400, { error: 'email and a password of at least 8 characters are required' })
		const cookie = cookieHeader(cookies)
		// register-while-anonymous IS the upgrade: the anon cookie rides along,
		// better-auth links (onLinkAccount re-points the core user server-side)
		const res = await fetch(`${base()}/api/auth/sign-up/email`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: url.origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ email, password, name: email.split('@')[0] })
		})
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { message?: string }
			return fail(res.status === 422 || res.status === 400 ? 400 : 500, { error: body.message ?? 'registration failed' })
		}
		relaySetCookies(cookies, res)
		throw redirect(303, '/')
	}
} satisfies Actions
