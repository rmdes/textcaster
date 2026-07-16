// Click-to-expand long posts, with rss.chat's two hard-won rules baked in
// (client worknotes 7/7 + 7/14/26):
// 1. decide whether the post is clipped AT CLICK TIME (images/layout may have
//    changed heights since render — a render-time decision goes stale);
// 2. a drag-select ends with a click — that click must not toggle.
// The DOM is the state here: no reactive bookkeeping for a purely visual fold.
export function toggleClamp(e: MouseEvent) {
	if ((e.target as HTMLElement).closest('a')) return // link clicks navigate, never toggle
	if (window.getSelection()?.toString()) return
	const el = e.currentTarget as HTMLElement
	if (el.classList.contains('expanded')) el.classList.remove('expanded')
	else if (el.scrollHeight > el.clientHeight) el.classList.add('expanded')
}
