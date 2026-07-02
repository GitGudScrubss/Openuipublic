import { describe, it, expect, vi, afterEach } from 'vitest'
import { postChatProxyWithRetry } from './chatProxyRetry'
import type { Message } from './agent'

const messages: Message[] = [{ role: 'user', content: 'hi' }]

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('postChatProxyWithRetry', () => {
  it('returns immediately on success without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await postChatProxyWithRetry('https://proj.supabase.co', 'anon', 'tok', messages, 'sys', 'free-default', [10, 10])

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 429 (rate limit) or 401 (bad token)', async () => {
    for (const status of [429, 401]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status))
      vi.stubGlobal('fetch', fetchMock)
      const res = await postChatProxyWithRetry('https://x.supabase.co', 'anon', 'tok', messages, 'sys', 'free-default', [10, 10])
      expect(res.status).toBe(status)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('retries a 502/503/504 and returns the eventual success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(502, { error: 'llm_error' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await postChatProxyWithRetry('https://x.supabase.co', 'anon', 'tok', messages, 'sys', 'free-default', [10, 10])

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after exhausting retries and returns the last failing response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503))
    vi.stubGlobal('fetch', fetchMock)

    const res = await postChatProxyWithRetry('https://x.supabase.co', 'anon', 'tok', messages, 'sys', 'free-default', [10, 10])

    expect(res.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('retries a network-level throw and eventually throws a friendly error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      postChatProxyWithRetry('https://x.supabase.co', 'anon', 'tok', messages, 'sys', 'free-default', [10, 10])
    ).rejects.toThrow(/could not reach the AI service/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('recovers from a network throw followed by success', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(jsonResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    const res = await postChatProxyWithRetry('https://x.supabase.co', 'anon', 'tok', messages, 'sys', 'free-default', [10, 10])

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
