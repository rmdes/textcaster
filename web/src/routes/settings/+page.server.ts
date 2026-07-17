import type { PageServerLoad, Actions } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { updateProfile } from '$lib/api'
import { authedFetch, cookieHeader, hasSession } from '$lib/server/session'

export const load: PageServerLoad = async ({ cookies, parent }) => {
	if (!hasSession(cookies)) throw redirect(303, '/')
	const { me } = await parent()
	return { me }
}

export const actions = {
	save: async ({ request, fetch, cookies, url }) => {
		const form = await request.formData()
		const handle = String(form.get('handle') ?? '').trim()
		const displayName = String(form.get('displayName') ?? '').trim()
		const patch: { handle?: string; displayName?: string } = {}
		if (handle) patch.handle = handle
		if (displayName) patch.displayName = displayName
		try {
			await updateProfile(authedFetch(fetch, url.origin, cookieHeader(cookies)), patch)
		} catch (err) {
			const message = err instanceof Error ? err.message : 'update failed'
			return fail(message === 'handle already taken' ? 409 : 500, { error: message })
		}
		throw redirect(303, '/settings')
	}
} satisfies Actions
