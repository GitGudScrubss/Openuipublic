/**
 * userRepo.ts — data-access layer for the authenticated user.
 *
 * All reads/writes for the `users`, `auth_tokens` and `subscription_cache`
 * tables go through this module so the rest of the app never touches SQL
 * directly. OpenUI is a single-user desktop app, so "the current user" is simply
 * the (at most one) row in `auth_tokens`.
 *
 * SECURITY: OAuth access/refresh tokens are long-lived credentials for the
 * user's account. They are encrypted at rest with Electron's `safeStorage`
 * (OS keychain–backed) when it is available, and only ever decrypted inside the
 * main process. If the OS cannot provide encryption, we fall back to storing the
 * plaintext token with a logged warning rather than failing the sign-in.
 */
import { safeStorage } from 'electron'
import { getDb } from './database'

export interface UserProfile {
  id: string
  email: string | null
  display_name: string | null
  avatar_url: string | null
  tier: string
}

export interface AuthTokens {
  access_token: string
  refresh_token: string
  token_type: string | null
  /** Epoch milliseconds at which the access token expires. */
  expires_at: number
}

// ── token encryption helpers ────────────────────────────────────────────────
// Encrypted values are stored base64-prefixed with `enc:` so we can tell them
// apart from any plaintext fallback values and decrypt only what we encrypted.

const ENC_PREFIX = 'enc:'

function encryptToken(plain: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
    }
  } catch (err) {
    console.warn('[openui] Token encryption unavailable, storing plaintext:', err)
  }
  return plain
}

function decryptToken(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored // plaintext fallback value
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch (err) {
    console.error('[openui] Failed to decrypt stored token:', err)
    return ''
  }
}

// ── users ───────────────────────────────────────────────────────────────────

/**
 * Insert or update a user profile. The Supabase user id is the stable primary
 * key, so a returning user updates their existing row (and preserves
 * `created_at`). `tier` is the value cached at sign-in time from the user's
 * Supabase metadata.
 */
export function upsertUser(profile: UserProfile): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO users (id, email, display_name, avatar_url, tier, created_at, updated_at)
       VALUES (@id, @email, @display_name, @avatar_url, @tier, @now, @now)
       ON CONFLICT(id) DO UPDATE SET
         email        = excluded.email,
         display_name = excluded.display_name,
         avatar_url   = excluded.avatar_url,
         tier         = excluded.tier,
         updated_at   = excluded.updated_at`
    )
    .run({
      id: profile.id,
      email: profile.email,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      tier: profile.tier,
      now
    })
}

/** Fetch a stored user profile by id, or null if not present. */
export function getUser(id: string): UserProfile | null {
  const row = getDb().prepare('SELECT id, email, display_name, avatar_url, tier FROM users WHERE id = ?').get(id)
  return (row as UserProfile | undefined) ?? null
}

/**
 * The currently signed-in user is the one holding auth tokens. Returns the most
 * recently authenticated user, or null when nobody is signed in.
 */
export function getActiveUser(): UserProfile | null {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.avatar_url, u.tier
         FROM users u
         JOIN auth_tokens t ON t.user_id = u.id
        ORDER BY t.updated_at DESC
        LIMIT 1`
    )
    .get()
  return (row as UserProfile | undefined) ?? null
}

// ── auth tokens ───────────────────────────────────────────────────────────────

/** Store (encrypted) auth tokens for a user, replacing any previous set. */
export function updateAuthTokens(userId: string, tokens: AuthTokens): void {
  getDb()
    .prepare(
      `INSERT INTO auth_tokens (user_id, access_token, refresh_token, token_type, expires_at, updated_at)
       VALUES (@user_id, @access_token, @refresh_token, @token_type, @expires_at, @updated_at)
       ON CONFLICT(user_id) DO UPDATE SET
         access_token  = excluded.access_token,
         refresh_token = excluded.refresh_token,
         token_type    = excluded.token_type,
         expires_at    = excluded.expires_at,
         updated_at    = excluded.updated_at`
    )
    .run({
      user_id: userId,
      access_token: encryptToken(tokens.access_token),
      refresh_token: encryptToken(tokens.refresh_token),
      token_type: tokens.token_type,
      expires_at: tokens.expires_at,
      updated_at: Date.now()
    })
}

/** Read and decrypt the auth tokens for a user, or null when none are stored. */
export function getAuthTokens(userId: string): AuthTokens | null {
  const row = getDb()
    .prepare('SELECT access_token, refresh_token, token_type, expires_at FROM auth_tokens WHERE user_id = ?')
    .get(userId) as
    | { access_token: string; refresh_token: string; token_type: string | null; expires_at: number }
    | undefined
  if (!row) return null
  return {
    access_token: decryptToken(row.access_token),
    refresh_token: decryptToken(row.refresh_token),
    token_type: row.token_type,
    expires_at: row.expires_at
  }
}

/** Remove a user's auth tokens (sign-out). Subscription cache is cleared too. */
export function clearAuthTokens(userId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM subscription_cache WHERE user_id = ?').run(userId)
}

// ── subscription cache ────────────────────────────────────────────────────────

/** Default lifetime of a cached subscription tier before it must be refreshed. */
const TIER_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Cache a user's subscription tier with a TTL. The tier originates from the
 * user's Supabase `app_metadata` and is cached locally so the UI can gate
 * features offline without re-querying Supabase on every check.
 */
export function cacheSubscriptionTier(userId: string, tier: string, ttlMs: number = TIER_CACHE_TTL_MS): void {
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO subscription_cache (user_id, tier, cached_at, expires_at)
       VALUES (@user_id, @tier, @now, @expires_at)
       ON CONFLICT(user_id) DO UPDATE SET
         tier       = excluded.tier,
         cached_at  = excluded.cached_at,
         expires_at = excluded.expires_at`
    )
    .run({ user_id: userId, tier, now, expires_at: now + ttlMs })
}

/**
 * Return the cached subscription tier for a user, or null when there is no
 * cache entry or it has expired (caller should treat that as 'free').
 */
export function getCachedTier(userId: string): string | null {
  const row = getDb()
    .prepare('SELECT tier, expires_at FROM subscription_cache WHERE user_id = ?')
    .get(userId) as { tier: string; expires_at: number } | undefined
  if (!row) return null
  if (row.expires_at <= Date.now()) return null
  return row.tier
}
