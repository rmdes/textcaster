import { authedFetch, cookieHeader } from '$lib/server/session'
import { getAdminOverview } from '$lib/api'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ fetch, url, cookies }) => {
	const f = authedFetch(fetch, url.origin, cookieHeader(cookies))
	return { overview: await getAdminOverview(f) }
}
