// Compose drafts in localStorage: closing the dialog (backdrop, Esc, reload)
// never loses writing. Callers clear on confirmed submit success only.
export type Draft = { content?: string }

const PREFIX = 'rsc:draft:'

export function loadDraft(key: string): Draft {
	try {
		const parsed = JSON.parse(localStorage.getItem(PREFIX + key) ?? '{}')
		return typeof parsed === 'object' && parsed !== null ? parsed : {}
	} catch {
		return {}
	}
}

export function saveDraft(key: string, draft: Draft): void {
	try {
		if (Object.values(draft).some((v) => v?.trim())) localStorage.setItem(PREFIX + key, JSON.stringify(draft))
		else localStorage.removeItem(PREFIX + key)
	} catch {
		// quota/private-mode failures degrade to no persistence
	}
}
