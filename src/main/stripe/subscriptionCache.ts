/**
 * subscriptionCache.ts — local cache of each signed-in user's subscription tier.
 *
 * SECURITY: this cache is treated as UNTRUSTED. It exists only to make the UI
 * feel instant and to keep working briefly when Supabase is unreachable — it is
 * never the source of truth. The source of truth is the user's Supabase
 * `app_metadata.tier` (written by the Stripe webhook) which `subscriptionSync`
 * verifies live. Pro/Enterprise features must gate on a verified sync, and the
 * cache is only honoured for at most `MAX_CACHE_STALENESS_MS` (see pricing.ts).
 *
 * STORAGE: backed by SQLite via `better-sqlite3`, which is an optional native
 * addon. Following the project convention for native modules (see tools.ts), it
 * is loaded lazily with `require()` so the bundle still typechecks/builds when
 * the binary is absent (e.g. a dev box where it hasn't been `electron-rebuild`d).
 * If it cannot load, we transparently fall back to an in-memory map: the app
 * keeps working and simply re-syncs from Supabase on next launch.
 */
import { app } from 'electron'
import { join } from 'node:path'
import type { TierId } from './pricing'

// Type-only import — erased at compile time, so it never emits a runtime
// require. The real module is loaded lazily in `openDb()` below.
type SqliteDatabase = import('better-sqlite3').Database

export interface CachedSubscription {
  userId: string
  tier: TierId
  /** Raw Stripe subscription status, e.g. 'active' | 'past_due' | 'canceled'. */
  stripeStatus: string | null
  /** Stripe customer id, used as a hint when opening the billing portal. */
  stripeCustomerId: string | null
  /** Stripe convention: epoch SECONDS at which the current paid period ends. */
  currentPeriodEnd: number | null
  /** epoch MS (`Date.now()`) at which this row was last synced. Drives staleness. */
  updatedAt: number
}

/** Shape of a raw row as returned by better-sqlite3. */
interface SubscriptionRow {
  user_id: string
  tier: string
  stripe_status: string | null
  stripe_customer_id: string | null
  current_period_end: number | null
  updated_at: number
}

let db: SqliteDatabase | null = null
let triedOpen = false
const memory = new Map<string, CachedSubscription>()

function coerceTier(value: string): TierId {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

/**
 * Open (once) the SQLite database, creating the table if needed. Returns null
 * when better-sqlite3 cannot be loaded, in which case callers use the in-memory
 * fallback. The result is memoised so the load is attempted at most once.
 */
function openDb(): SqliteDatabase | null {
  if (triedOpen) return db
  triedOpen = true
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('better-sqlite3') as unknown
    const Ctor = ((mod as { default?: unknown }).default ?? mod) as new (path: string) => SqliteDatabase
    const file = join(app.getPath('userData'), 'subscription-cache.db')
    const handle = new Ctor(file)
    handle.exec(
      `CREATE TABLE IF NOT EXISTS subscription_cache (
         user_id            TEXT PRIMARY KEY,
         tier               TEXT NOT NULL DEFAULT 'free',
         stripe_status      TEXT,
         stripe_customer_id TEXT,
         current_period_end INTEGER,
         updated_at         INTEGER NOT NULL
       );`
    )
    db = handle
  } catch (err) {
    console.warn(
      '[openui] better-sqlite3 unavailable — using in-memory subscription cache:',
      err instanceof Error ? err.message : err
    )
    db = null
  }
  return db
}

/** Read the cached subscription for a user, or null if none is stored. */
export function getCachedSubscription(userId: string): CachedSubscription | null {
  const handle = openDb()
  if (!handle) return memory.get(userId) ?? null

  const row = handle
    .prepare('SELECT * FROM subscription_cache WHERE user_id = ?')
    .get(userId) as SubscriptionRow | undefined
  if (!row) return null

  return {
    userId: row.user_id,
    tier: coerceTier(row.tier),
    stripeStatus: row.stripe_status,
    stripeCustomerId: row.stripe_customer_id,
    currentPeriodEnd: row.current_period_end,
    updatedAt: row.updated_at
  }
}

/** Insert or update the cached subscription row for a user. */
export function setCachedSubscription(rec: CachedSubscription): void {
  const handle = openDb()
  if (!handle) {
    memory.set(rec.userId, rec)
    return
  }

  handle
    .prepare(
      `INSERT INTO subscription_cache
         (user_id, tier, stripe_status, stripe_customer_id, current_period_end, updated_at)
       VALUES
         (@userId, @tier, @stripeStatus, @stripeCustomerId, @currentPeriodEnd, @updatedAt)
       ON CONFLICT(user_id) DO UPDATE SET
         tier               = excluded.tier,
         stripe_status      = excluded.stripe_status,
         stripe_customer_id = excluded.stripe_customer_id,
         current_period_end = excluded.current_period_end,
         updated_at         = excluded.updated_at`
    )
    .run({
      userId: rec.userId,
      tier: rec.tier,
      stripeStatus: rec.stripeStatus,
      stripeCustomerId: rec.stripeCustomerId,
      currentPeriodEnd: rec.currentPeriodEnd,
      updatedAt: rec.updatedAt
    })
}

/** Remove one user's cached row, or the whole cache (e.g. on sign-out). */
export function clearSubscriptionCache(userId?: string): void {
  const handle = openDb()
  if (!handle) {
    if (userId) memory.delete(userId)
    else memory.clear()
    return
  }
  if (userId) handle.prepare('DELETE FROM subscription_cache WHERE user_id = ?').run(userId)
  else handle.exec('DELETE FROM subscription_cache')
}
