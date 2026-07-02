/**
 * chatProxyRetry.ts — transient-failure retry for the chat-proxy POST.
 *
 * Extracted from cloudFreeTier.ts (which pulls in Electron + database +
 * Supabase auth) so this pure-fetch logic can be unit tested without mocking
 * the whole main process. See chatProxyRetry.test.ts.
 */
import type { Message } from './agent'

/** Statuses worth a retry: transient gateway/upstream failures, not a diagnosis of a bad key. */
export const RETRYABLE_STATUSES = new Set([502, 503, 504])
export const RETRY_DELAYS_MS = [400, 1200]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * POST to the chat-proxy Edge Function, retrying on transient failures only:
 * a network-level throw (DNS blip, TCP reset) or a 502/503/504 from the
 * function/gateway (an upstream LLM 5xx, or Supabase infra hiccup — both can
 * resolve within a second). Never retries 429 (rate limit) or 401 (bad
 * token) — those are not transient and retrying wastes the user's quota/time.
 * Streams are never partially retried: this only runs before the caller
 * starts reading `response.body`, so a retry can't duplicate output.
 */
export async function postChatProxyWithRetry(
  baseUrl: string,
  anonKey: string,
  token: string,
  messages: Message[],
  systemPrompt: string,
  modelKey: string,
  retryDelaysMs: number[] = RETRY_DELAYS_MS
): Promise<Response> {
  const url = `${baseUrl.replace(/\/$/, '')}/functions/v1/chat-proxy`
  const body = JSON.stringify({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    system: systemPrompt,
    modelKey,
    stream: true
  })

  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${token}`
        },
        body
      })
      if (RETRYABLE_STATUSES.has(response.status) && attempt < retryDelaysMs.length) {
        console.warn(
          `[cloudFreeTier] chat-proxy returned ${response.status} on attempt ${attempt + 1}, retrying…`
        )
        await sleep(retryDelaysMs[attempt])
        continue
      }
      return response
    } catch (err) {
      lastError = err
      if (attempt < retryDelaysMs.length) {
        console.warn(`[cloudFreeTier] chat-proxy network error on attempt ${attempt + 1}, retrying…`, err)
        await sleep(retryDelaysMs[attempt])
        continue
      }
    }
  }
  console.error('[cloudFreeTier] chat-proxy unreachable after retries:', lastError)
  throw new Error('I could not reach the AI service. Please check your connection and try again.')
}
