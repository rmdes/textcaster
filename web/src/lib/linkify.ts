// Split plain text into text/link segments so bare URLs render as anchors
// WITHOUT any HTML injection surface — segments are rendered as elements,
// never as markup (no {@html} anywhere).
export type Segment = { text: string; url?: string }

const URL_RE = /https?:\/\/[^\s<>"']+/g
const TRAILING = /[.,!?;:)\]]+$/

export function splitLinks(text: string): Segment[] {
	const out: Segment[] = []
	let last = 0
	for (const m of text.matchAll(URL_RE)) {
		let url = m[0]
		// trailing punctuation belongs to the sentence, not the URL
		const trimmed = url.replace(TRAILING, '')
		if (trimmed !== url) url = trimmed
		if (m.index > last) out.push({ text: text.slice(last, m.index) })
		out.push({ text: url, url })
		last = m.index + url.length
	}
	if (last < text.length) out.push({ text: text.slice(last) })
	return out
}
