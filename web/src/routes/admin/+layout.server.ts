import { error } from '@sveltejs/kit'
import type { LayoutServerLoad } from './$types'

export const load: LayoutServerLoad = async ({ parent }) => {
	const { me } = await parent()
	if (!me?.isAdmin) throw error(404, 'Not found') // admin-only; hide existence
	return {}
}
