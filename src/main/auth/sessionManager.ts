/**
 * sessionManager.ts — lifecycle of the signed-in session.
 *
 * Reads/writes go through userRepo (SQLite); token refresh goes through
 * Supabase. OpenUI is single-user, so "the current user" is whoever holds the
 * stored auth tokens (`userRepo.getActiveUser`). All of this runs in the main
 * process; the renderer only ever sees the derived profile/tier over IPC.
 */
import { BrowserWindow } from 'electron'
import { getSupabaseClient } from './supabaseClient'
import {
  getActiveUser,
  getAuthTokens,
  updateAuthTokens,
  clearAuthTokens,
  getCachedTier,
  cacheSubscriptionTier,
  type UserProfile
} from '../db/userRepo'

/** Refresh proactively this often. */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
/** Treat a token as "needs refresh" once it is within this window of expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000 // 5 minutes

/** True when a non-expired access token is stored locally. */
export function isAuthenticated(): boolean {
  const user = getActiveUser()
  if (!user) return false
  const tokens = getAuthTokens(user.id)
  if (!tokens) return false
  return tokens.expires_at > Date.now()
}

/**
 * Exchange the stored refresh token for a fresh access token via Supabase and
 * persist the new pair. Returns false when there is no session to refresh or the
 * refresh token is no longer valid.
 */
export async function refreshSession(): Promise<boolean> {
  const user = getActiveUser()
  if (!user) return false
  const tokens = getAuthTokens(user.id)
  if (!tokens?.refresh_token) return false

  try {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: tokens.refresh_token })
    const session = data?.session
    if (error || !session) return false

    // Supabase reports expires_at in epoch SECONDS; store epoch ms.
    const expiresAt = session.expires_at
      ? session.expires_at * 1000
      : Date.now() + (session.expires_in ?? 3600) * 1000

    updateAuthTokens(user.id, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      token_type: session.token_type ?? null,
      expires_at: expiresAt
    })

    // Keep the cached tier fresh from the refreshed claims, if present.
    const tier = (session.user?.app_metadata as Record<string, unknown> | undefined)?.tier
    if (typeof tier === 'string') cacheSubscriptionTier(user.id, tier)

    return true
  } catch (err) {
    console.error('[openui] refreshSession failed:', err)
    return false
  }
}

/**
 * Return the cached user profile, refreshing the session first when the access
 * token is at/near expiry. Returns null when nobody is signed in.
 */
export async function getCurrentUser(): Promise<UserProfile | null> {
  const user = getActiveUser()
  if (!user) return null

  const tokens = getAuthTokens(user.id)
  if (tokens && tokens.expires_at <= Date.now() + EXPIRY_SKEW_MS) {
    await refreshSession() // best effort; profile is still returned either way
  }
  return getActiveUser()
}

/**
 * Sign out: drop local tokens, revoke the Supabase session, and tell the
 * renderer. Never throws — a failed network sign-out must not leave the user
 * stuck "signed in" locally.
 */
export async function logout(win?: BrowserWindow | null): Promise<void> {
  const user = getActiveUser()
  if (user) clearAuthTokens(user.id)

  try {
    await getSupabaseClient().auth.signOut()
  } catch (err) {
    console.warn('[openui] Supabase signOut failed (local tokens already cleared):', err)
  }

  if (win && !win.isDestroyed()) win.webContents.send('openui:auth-logout')
}

/** Return the cached subscription tier, defaulting to 'free' when stale/absent. */
export function getUserTier(): string {
  const user = getActiveUser()
  if (!user) return 'free'
  return getCachedTier(user.id) ?? 'free'
}

// ── proactive refresh loop ────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start a 30-minute loop that refreshes the access token before it expires. The
 * timer is unref'd so it never by itself keeps the app alive, and each tick is a
 * no-op unless a user is signed in (i.e. it only does work while the app has an
 * active session). Idempotent — calling again restarts a single timer.
 */
export function startTokenRefreshLoop(win?: BrowserWindow | null): void {
  stopTokenRefreshLoop()
  refreshTimer = setInterval(() => void tick(win), REFRESH_INTERVAL_MS)
  // Do not let this timer hold the process open on its own.
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref()
}

/** Stop the proactive refresh loop (e.g. on app shutdown). */
export function stopTokenRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

async function tick(win?: BrowserWindow | null): Promise<void> {
  const user = getActiveUser()
  if (!user) return // no active session ⇒ nothing to refresh
  const tokens = getAuthTokens(user.id)
  if (!tokens) return

  // Only spend a network call when the token would expire before the next tick.
  if (tokens.expires_at > Date.now() + REFRESH_INTERVAL_MS + EXPIRY_SKEW_MS) return

  const ok = await refreshSession()
  if (!ok) {
    // The refresh token is dead — force a clean logout so the UI reflects it.
    await logout(win)
  }
}
