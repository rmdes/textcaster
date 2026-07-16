import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

// SEC-4: HTML we GENERATE from local composes never ships dirty — a member's
// raw <script> in markdown passes through marked (probed) and dies here.
// Remote content is never routed through this: pass-through applies to
// OTHERS' content, not to HTML we author ourselves.
const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'a', 'em', 'strong', 'b', 'i', 'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'del'],
  allowedAttributes: { a: ['href', 'rel'], img: ['src', 'loading'] },
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer' }),
    img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }),
  },
}

export function renderLocalHtml(markdown: string): string {
  return sanitizeHtml(marked.parse(markdown, { async: false }) as string, SANITIZE_CONFIG)
}
