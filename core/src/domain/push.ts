import type { Repository } from './repository.ts'
import type { Config } from '../config.ts'
import type { TimelineEntry } from './types.ts'
import { feedUrls } from './feed.ts'

const PUSH_TIMEOUT_MS = 10_000

export interface Push {
  onLocalPost(entry: TimelineEntry): Promise<void>
}

export interface PushDeps {
  repo: Repository
  config: Config
  fetchFn?: typeof fetch
}

async function publishPing(hubUrl: string, topic: string, fetchFn: typeof fetch): Promise<void> {
  await fetchFn(hubUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // hub.url duplicates hub.topic for hub compatibility (websubhub.com et al).
    body: new URLSearchParams({ 'hub.mode': 'publish', 'hub.topic': topic, 'hub.url': topic }).toString(),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  })
}

export function createPush(deps: PushDeps): Push {
  const { repo, config } = deps
  const fetchFn = deps.fetchFn ?? fetch
  void repo // used from Task 6 onward (self-hub delivery)

  return {
    // Seam contract (spec H4): this method NEVER rejects. It runs inside a
    // synchronous EventEmitter dispatch with no global rejection handler —
    // an escape here is process-fatal.
    // ponytail: N rapid posts = N regenerations × M subscribers, no
    // coalescing; debounce per topic when it matters.
    async onLocalPost(entry: TimelineEntry): Promise<void> {
      try {
        if (entry.source !== 'local') return
        if (!config.publicUrl) return
        const pushEnabled = config.websub.mode !== 'off' || config.rssCloud
        if (!pushEnabled) return
        const topics = feedUrls(config.publicUrl, entry.author.handle)

        if (config.websub.mode === 'external') {
          for (const topic of [topics.xml, topics.json]) {
            try {
              await publishPing(config.websub.hubUrl, topic, fetchFn)
            } catch (err) {
              console.error(`websub publish ping failed for ${topic}:`, err instanceof Error ? err.message : err)
            }
          }
        }
      } catch (err) {
        console.error('push dispatch failed:', err instanceof Error ? err.message : err)
      }
    },
  }
}
