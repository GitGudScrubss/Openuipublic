import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BrowserWindow, ipcMain } from 'electron'
import { coerceTier, handleChat } from './agent'
import { getUserTier, getCurrentUser } from './auth/sessionManager'
import { getDb } from './database/init'
import { monthlyVoiceMinuteLimit } from './stripe/pricing'
import { callEdgeFunction } from './edgeFunctions'
import { trackEvent } from './telemetry/posthog'
import { Events } from './telemetry/events'

function emit(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Whisper rejects files larger than 25 MB; reject oversized buffers up front so
// a hostile/forged IPC message can't force a huge allocation or upload.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024
const ALLOWED_AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)(;.*)?$/

const execFileAsync = promisify(execFile)

async function transcribeWithLocalWhisper(audioBuffer: Buffer): Promise<string> {
  const binaryPath = process.env.WHISPER_CPP_PATH
  if (!binaryPath) {
    throw new Error(
      'WHISPER_CPP_PATH is not set. ' +
        'Point it to your compiled whisper.cpp binary, or upgrade to Pro for cloud transcription.'
    )
  }
  const { writeFile, unlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmpPath = join(tmpdir(), `openui-audio-${Date.now()}.wav`)
  await writeFile(tmpPath, audioBuffer)
  try {
    const { stdout } = await execFileAsync(binaryPath, ['-m', 'base', '-f', tmpPath, '-nt'], {
      maxBuffer: 4 * 1024 * 1024
    })
    return stdout.trim()
  } finally {
    await unlink(tmpPath).catch(() => {})
  }
}

/** Turn a non-OK voice-proxy response into a user-facing message. */
async function proxyErrorMessage(response: Response, label: string): Promise<string> {
  let code = ''
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') code = body.error
  } catch {
    /* non-JSON body — fall through to the generic message */
  }
  if (code === 'transcription_unavailable' || code === 'synthesis_unavailable') {
    return `${label} is temporarily unavailable — the voice service is not configured on the server.`
  }
  if (response.status === 429) {
    return "You've reached your voice usage limit. Please try again later."
  }
  return `${label} failed. Please try again in a moment.`
}

/**
 * Transcribe audio to text via the `voice-proxy` Edge Function.
 *
 * OUR OpenAI Whisper key lives ONLY in the Edge Function (never baked into the
 * shipped app), so the client sends the audio with the signed-in user's Supabase
 * token and receives the transcript back — the same server-side-key pattern chat
 * already uses. `callEdgeFunction` throws a friendly error when the user isn't
 * signed in or the session can't be refreshed.
 */
export async function transcribeWithWhisper(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const response = await callEdgeFunction('voice-proxy', {
    action: 'transcribe',
    audioBase64: audioBuffer.toString('base64'),
    mimeType
  })
  if (!response.ok) throw new Error(await proxyErrorMessage(response, 'Voice transcription'))
  const data = (await response.json().catch(() => ({}))) as { text?: unknown }
  return typeof data.text === 'string' ? data.text.trim() : ''
}

// ── Text-to-Speech ──────────────────────────────────────────────────────────

/**
 * Synthesize speech from text via the `voice-proxy` Edge Function. The function
 * prefers ElevenLabs (richer voices) when its key is configured server-side and
 * otherwise falls back to OpenAI TTS — either way the key stays on the server.
 * Returns a Buffer containing MP3 audio.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await callEdgeFunction('voice-proxy', { action: 'synthesize', text })
  if (!response.ok) throw new Error(await proxyErrorMessage(response, 'Text-to-speech'))
  const data = (await response.json().catch(() => ({}))) as { audioBase64?: unknown }
  if (typeof data.audioBase64 !== 'string' || !data.audioBase64) {
    throw new Error('Text-to-speech returned no audio. Please try again.')
  }
  return Buffer.from(data.audioBase64, 'base64')
}

function getVoiceSecondsToday(userId: string): number {
  try {
    const db = getDb()
    const today = new Date().toISOString().slice(0, 10)
    const row = db
      .prepare('SELECT seconds_used FROM voice_usage WHERE user_id = ? AND date = ?')
      .get(userId, today) as { seconds_used: number } | undefined
    return row?.seconds_used ?? 0
  } catch {
    return 0
  }
}

/** Sum of voice seconds used across every day in the current calendar month. */
function getVoiceSecondsThisMonth(userId: string): number {
  try {
    const db = getDb()
    const monthPrefix = new Date().toISOString().slice(0, 7) // "YYYY-MM"
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(seconds_used), 0) AS total FROM voice_usage WHERE user_id = ? AND date LIKE ? || '%'"
      )
      .get(userId, monthPrefix) as { total: number } | undefined
    return row?.total ?? 0
  } catch {
    return 0
  }
}

function recordVoiceUsage(userId: string, seconds: number): void {
  try {
    const db = getDb()
    const today = new Date().toISOString().slice(0, 10)
    db.prepare(
      `INSERT INTO voice_usage (user_id, date, seconds_used) VALUES (?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET seconds_used = seconds_used + excluded.seconds_used`
    ).run(userId, today, seconds)
  } catch (err) {
    console.error('[voice] Failed to record usage:', err)
  }
}

export function registerVoiceIPC(win: BrowserWindow): void {
  ipcMain.handle('openui:voice', async (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return
    const { audio, mimeType, tier } = payload as Record<string, unknown>

    // Validate the audio payload: must be a byte view (Uint8Array over IPC),
    // non-empty and within Whisper's size limit.
    if (!ArrayBuffer.isView(audio)) {
      emit(win, 'openui:chat:error', 'Invalid voice request: audio payload missing.')
      return
    }
    if (audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
      emit(win, 'openui:chat:error', 'Invalid voice request: audio is empty or too large.')
      return
    }
    const safeMime = typeof mimeType === 'string' && ALLOWED_AUDIO_MIME.test(mimeType) ? mimeType : 'audio/webm'
    const safeTier = coerceTier(tier)
    const audioBuffer = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)

    // Use server-side tier for whisper routing — free tier uses local whisper.cpp
    // (if configured), pro/enterprise use the OpenAI Whisper API.
    const serverTier = getUserTier()
    const userId = (await getCurrentUser())?.id ?? 'anonymous'

    // Enforce the per-tier Whisper transcription cap before hitting the API.
    // Free is metered monthly (120 min/month); Pro keeps a generous daily cap;
    // Enterprise is unlimited. Free's cap is monthly (not daily) specifically so
    // it can't be topped up by simply waiting for the next day.
    if (serverTier === 'free') {
      const capSeconds = monthlyVoiceMinuteLimit('free') * 60
      const used = getVoiceSecondsThisMonth(userId)
      if (used >= capSeconds) {
        emit(win, 'openui:chat:error', 'Monthly voice limit reached. Upgrade to Pro for more voice time.')
        return
      }
    } else if (serverTier === 'pro') {
      const cap = 3600
      const used = getVoiceSecondsToday(userId)
      if (used >= cap) {
        emit(win, 'openui:chat:error', 'Daily voice limit reached. Upgrade to Enterprise for unlimited voice time.')
        return
      }
    }

    trackEvent(Events.VOICE_RECORDING_STARTED)

    let transcript: string
    try {
      if (serverTier === 'free') {
        if (!process.env.WHISPER_CPP_PATH) {
          emit(
            win,
            'openui:chat:error',
            'Voice transcription requires a Pro subscription for cloud accuracy. ' +
              'Set WHISPER_CPP_PATH to use a local Whisper model instead.'
          )
          return
        }
        transcript = await transcribeWithLocalWhisper(audioBuffer)
      } else {
        transcript = await transcribeWithWhisper(audioBuffer, safeMime)
      }
    } catch (err) {
      trackEvent(Events.VOICE_TRANSCRIPTION_FAILED)
      const message = err instanceof Error ? err.message : String(err)
      emit(win, 'openui:chat:error', message)
      return
    }

    if (!transcript) {
      trackEvent(Events.VOICE_TRANSCRIPTION_FAILED)
      emit(win, 'openui:chat:error', 'No speech detected in the recording.')
      return
    }

    // Rough duration estimate: compressed audio at ~12 KB/s
    const durationSeconds = Math.round(audioBuffer.byteLength / 12000)
    recordVoiceUsage(userId, durationSeconds)
    trackEvent(Events.VOICE_RECORDING_COMPLETED, {
      duration_seconds: durationSeconds,
      tier: safeTier,
      transcription_method: 'whisper'
    })

    // Push transcript to renderer so it can show it in #transcript-bubble
    // before the agent response starts streaming.
    emit(win, 'openui:voice:transcript', transcript)

    // Feed the transcribed text directly into the agent router.
    await handleChat(win, transcript, safeTier, true)
  })
}
