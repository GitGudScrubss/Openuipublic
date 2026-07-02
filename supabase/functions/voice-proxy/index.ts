// voice-proxy — Supabase Edge Function (Deno runtime).
//
// The voice sibling of `chat-proxy`: it holds OUR OpenAI (Whisper + TTS) and
// ElevenLabs keys server-side so the Electron client never ships them. The old
// code called the OpenAI/ElevenLabs SDKs directly from the desktop app with
// `process.env.OPENAI_API_KEY` / `process.env.ELEVENLABS_API_KEY` — keys that,
// by design, are NOT baked into the packaged binary, so voice was broken for
// every shipped user. This function closes that gap.
//
// Two actions (POST JSON, with the user's Supabase access token in the
// `Authorization: Bearer …` header):
//   { action: 'transcribe', audioBase64, mimeType } → { text }
//   { action: 'synthesize', text }                  → { audioBase64, mimeType }
//
// Per-tier voice-minute limits stay enforced by the client (`voice.ts`) against
// the local `voice_usage` table, exactly as before; this function's job is to
// verify the caller and keep the keys off the client.
//
// Deploy:  supabase functions deploy voice-proxy
// Secrets: OPENAI_API_KEY  (Whisper transcription + fallback TTS)
//          ELEVENLABS_API_KEY   (optional — preferred TTS voice)
//          ELEVENLABS_VOICE_ID  (optional — overrides the default voice)
//          (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// Whisper rejects files larger than 25 MB; reject oversized buffers up front.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
// Cap TTS input so a forged request can't run up an unbounded synthesis bill.
const MAX_TTS_CHARS = 5_000

// ElevenLabs voice ID — overridable via the ELEVENLABS_VOICE_ID secret.
// Default: "Rachel" (21m00Tcm4TlvDq8ikWAM) — neutral, professional female voice.
const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })
}

/** Decode a base64 string into raw bytes (Deno has no Buffer). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encode raw bytes into base64, chunked to avoid a huge spread-args call. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function transcribe(body: Record<string, unknown>): Promise<Response> {
  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : ''
  if (!audioBase64) return json({ error: 'audio_required' }, 400)

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'audio/webm'
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(audioBase64)
  } catch {
    return json({ error: 'audio_invalid' }, 400)
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: 'audio_invalid' }, 400)
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!openaiKey) return json({ error: 'transcription_unavailable' }, 502)

  const ext = mimeType.includes('ogg')
    ? 'ogg'
    : mimeType.includes('mp4')
      ? 'mp4'
      : mimeType.includes('wav')
        ? 'wav'
        : mimeType.includes('mpeg')
          ? 'mp3'
          : 'webm'

  const form = new FormData()
  form.append('file', new Blob([bytes], { type: mimeType }), `recording.${ext}`)
  form.append('model', 'whisper-1')

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form
  })
  if (!res.ok) {
    console.error('Whisper API error:', res.status, await res.text().catch(() => ''))
    return json({ error: 'transcription_failed' }, 502)
  }
  const data = (await res.json()) as { text?: unknown }
  return json({ text: typeof data.text === 'string' ? data.text.trim() : '' })
}

async function synthesize(body: Record<string, unknown>): Promise<Response> {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return json({ error: 'text_required' }, 400)
  if (text.length > MAX_TTS_CHARS) return json({ error: 'text_too_long' }, 400)

  // Prefer ElevenLabs (richer voices) when its key is set; else OpenAI TTS.
  const elevenKey = Deno.env.get('ELEVENLABS_API_KEY') ?? ''
  if (elevenKey) {
    const voiceId = Deno.env.get('ELEVENLABS_VOICE_ID') ?? DEFAULT_ELEVENLABS_VOICE
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elevenKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    )
    if (!res.ok) {
      console.error('ElevenLabs API error:', res.status, await res.text().catch(() => ''))
      return json({ error: 'synthesis_failed' }, 502)
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    return json({ audioBase64: bytesToBase64(buf), mimeType: 'audio/mpeg' })
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? ''
  if (!openaiKey) return json({ error: 'synthesis_unavailable' }, 502)

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: text, response_format: 'mp3' })
  })
  if (!res.ok) {
    console.error('OpenAI TTS API error:', res.status, await res.text().catch(() => ''))
    return json({ error: 'synthesis_failed' }, 502)
  }
  const buf = new Uint8Array(await res.arrayBuffer())
  return json({ audioBase64: bytesToBase64(buf), mimeType: 'audio/mpeg' })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // 1) Authenticate the caller from their Supabase access token (mirrors
    //    chat-proxy). This is the boundary that keeps OUR voice keys off the
    //    client: only a signed-in user's token unlocks them, and it never leaves
    //    the server.
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return json({ error: 'missing_token' }, 401)

    const { data: userData, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !userData?.user) return json({ error: 'invalid_token' }, 401)

    // 2) Dispatch on the requested action.
    const body = (await req.json()) as Record<string, unknown>
    const action = body.action
    if (action === 'transcribe') return await transcribe(body)
    if (action === 'synthesize') return await synthesize(body)
    return json({ error: 'unknown_action' }, 400)
  } catch (error) {
    console.error('voice-proxy error:', error)
    return json({ error: 'internal_error' }, 500)
  }
})
