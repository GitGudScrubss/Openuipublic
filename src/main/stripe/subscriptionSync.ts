/**
 * subscriptionSync.ts — keeps the local tier in sync with the authoritative
 * subscription state held by Supabase + Stripe, and acts as the IPC hub for the
 * Stripe feature (it owns the reference to the main window).
 *
 * Source-of-truth flow:
 *   Stripe webhook → Supabase `app_metadata.tier`  (authoritative)
 *   syncSubscriptionStatus() reads that + cross-checks live Stripe status via an
 *   Edge Function, writes the result into the UNTRUSTED local cache, and tells
 *   the renderer when the tier changes.
 */
import { BrowserWindow } from 'electron'
import { getSupabase, isSupabaseConfigured } from '../supabase/client'
import { getCachedSubscription, setCachedSubscription } from './subscriptionCache'
import { getTierForUser, type TierId } from './pricing'

const SYNC_INTERVAL_MS = 5 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let focusHandlerAttached = false

/**
 * The Supabase id of the currently signed-in user, or null when signed out.
 * The auth feature sets this on login/logout. For local development before auth
 * lands, it can be seeded from OPENUI_DEV_USER_ID.
 */
let currentUserId: string | null = process.env.OPENUI_DEV_USER_ID?.trim() || null

export function getCurrentUserId(): string | null {
  return currentUserId
}

export function setCurrentUserId(userId: string | null): void {
  currentUserId = userId?.trim() || null
}

/** Register the main window so tier/payment events can be pushed to the UI. */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

/** Send an IPC message to the renderer, guarding against a destroyed window. */
export function emitToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function coerceTier(value: unknown): TierId {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

/**
 * Fetch the user's authoritative tier from Supabase (app_metadata.tier, written
 * by the Stripe webhook) and cross-check live Stripe status via the
 * `check-subscription` Edge Function, then update the local cache. Emits
 * `openui:tier-changed` to the renderer when the tier differs from the cache.
 *
 * If Supabase is unreachable or unconfigured we fall back to the cached tier —
 * but only while it is fresh (< 24h, enforced by `getTierForUser`).
 *
 * Returns the resolved current tier.
 */
export async function syncSubscriptionStatus(userId: string): Promise<TierId> {
  const cached = getCachedSubscription(userId)
  const previousTier: TierId = cached?.tier ?? 'free'

  if (!isSupabaseConfigured()) {
    // Nothing to verify against — never trust a stale cache to unlock paid tiers.
    return getTierForUser(userId)
  }

  try {
    const supabase = getSupabase()

    // 1) Authoritative claim: the tier baked into the user's JWT by the webhook.
    let tier: TierId | null = null
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    if (!userErr) {
      const metaTier = userData?.user?.app_metadata?.tier
      if (metaTier) tier = coerceTier(metaTier)
    }

    // 2) Live cross-check with Stripe (status + period end + customer id). The
    //    Edge Function holds the Stripe secret key; we only receive the result.
    let stripeStatus: string | null = cached?.stripeStatus ?? null
    let stripeCustomerId: string | null = cached?.stripeCustomerId ?? null
    let currentPeriodEnd: number | null = cached?.currentPeriodEnd ?? null

    const { data: subData, error: subErr } = await supabase.functions.invoke('check-subscription', {
      body: { userId }
    })
    if (!subErr && subData && typeof subData === 'object') {
      const d = subData as {
        tier?: unknown
        status?: unknown
        customerId?: unknown
        currentPeriodEnd?: unknown
      }
      if (d.tier) tier = coerceTier(d.tier)
      if (typeof d.status === 'string') stripeStatus = d.status
      if (typeof d.customerId === 'string') stripeCustomerId = d.customerId
      if (typeof d.currentPeriodEnd === 'number') currentPeriodEnd = d.currentPeriodEnd
    }

    const resolvedTier: TierId = tier ?? 'free'

    setCachedSubscription({
      userId,
      tier: resolvedTier,
      stripeStatus,
      stripeCustomerId,
      currentPeriodEnd,
      updatedAt: Date.now()
    })

    if (resolvedTier !== previousTier) {
      emitToRenderer('openui:tier-changed', resolvedTier)
    }
    return resolvedTier
  } catch (err) {
    // Supabase/Stripe unreachable — degrade to the (freshness-guarded) cache.
    console.error(
      '[openui] Subscription sync failed; using cached tier:',
      err instanceof Error ? err.message : err
    )
    return getTierForUser(userId)
  }
}

/**
 * Start syncing the signed-in user's subscription:
 *   • every 5 minutes,
 *   • whenever the main window regains focus,
 *   • plus an immediate sync right now.
 * Idempotent — calling it more than once won't stack timers/listeners. The loop
 * idles harmlessly while there is no signed-in user.
 *
 * In a full auth flow, call this right after a successful login.
 */
export function startSubscriptionSyncLoop(): void {
  const tick = (): void => {
    const userId = getCurrentUserId()
    if (userId) void syncSubscriptionStatus(userId)
  }

  if (!syncTimer) syncTimer = setInterval(tick, SYNC_INTERVAL_MS)

  if (mainWindow && !mainWindow.isDestroyed() && !focusHandlerAttached) {
    mainWindow.on('focus', tick)
    focusHandlerAttached = true
  }

  tick()
}

/** Stop the periodic sync (e.g. on shutdown). */
export function stopSubscriptionSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}

/**
 * Called when a checkout window (or the `openui://payment-success` deep link)
 * reports success. Forces an immediate sync — don't wait for the 5-minute loop —
 * then notifies the renderer so it can celebrate / unlock the UI.
 */
export async function handlePaymentSuccess(userId: string): Promise<void> {
  const id = userId || getCurrentUserId()
  if (id) await syncSubscriptionStatus(id)
  emitToRenderer('openui:payment-success')
}
