/**
 * pricing.ts — the single source of truth for OpenUI's subscription tiers, the
 * models each tier may use, and the helpers that gate model routing.
 *
 * CLOUD-FIRST MODEL (Phase A onboarding): every tier — including Free — works
 * out of the box by routing to cloud APIs through the `chat-proxy` Supabase Edge
 * Function (which holds OUR API keys server-side). Ollama is an OPTIONAL local
 * enhancement, never a prerequisite: when it is running we prefer it for the Free
 * tier to save API costs, and as an offline fallback. The app must NEVER require
 * the user to install anything to get a working assistant.
 *
 * Each tier declares a `dailyMessageLimit` (cloud messages/day, enforced
 * server-side by the Edge Function against the `usage_tracking` table) and a
 * nested `models` map split into `cloud` (routed via the proxy) and `local`
 * (routed via Ollama when available).
 *
 * SECURITY: Stripe *price ids* (`price_…`) are NOT secret — they are safe to ship
 * in the Electron app and are used only to tell the `create-checkout` Edge
 * Function which price the user picked. The Stripe *secret key* never appears
 * here (or anywhere in the Electron app); it lives only in Supabase Edge Function
 * secrets. See `.env.example` and `supabase/functions/README.md`.
 */
import { database } from '../database'

export const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    description: 'Get started with AI assistance — no setup required',
    features: [
      '20 cloud messages per day',
      'Local AI (unlimited) if Ollama is installed',
      'Basic OS automation',
      'Local OCR screen reading',
      'Voice input'
    ],
    dailyMessageLimit: 20,
    models: {
      cloud: ['claude-3-5-haiku'],
      local: ['llama3:8b', 'phi3:mini']
    },
    stripePriceId: null // No Stripe price for free
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 19,
    description: 'Advanced AI with cloud models and vision',
    features: [
      '500 cloud messages per day',
      'Claude 3.5 Sonnet + GPT-4o',
      'Cloud vision (screen understanding)',
      'Advanced multi-step automation',
      'Priority processing'
    ],
    dailyMessageLimit: 500,
    models: {
      cloud: ['claude-3-5-sonnet', 'gpt-4o', 'llama3:70b'],
      local: ['llama3:8b', 'phi3:mini']
    },
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 49,
    description: 'Maximum power with custom models',
    features: [
      'Unlimited cloud messages',
      'GLM 5.2 + all premium models',
      'Unlimited vision calls',
      'Workflow chaining',
      'Custom MCP servers',
      'Priority support'
    ],
    dailyMessageLimit: Infinity,
    models: {
      cloud: ['glm-5.2', 'claude-3-5-sonnet', 'gpt-4o', 'llama3:405b'],
      local: ['llama3:8b', 'phi3:mini']
    },
    stripePriceId: process.env.STRIPE_ENTERPRISE_PRICE_ID
  }
} as const

export type TierId = keyof typeof TIERS

/** Ordered low→high so we can compare "is tier A at least tier B". */
const TIER_RANK: Record<TierId, number> = { free: 0, pro: 1, enterprise: 2 }

/**
 * Any locally-run model (Ollama-style `name:tag`, or a known local family) is
 * always permitted on the free tier — the user pulled it themselves and it costs
 * us nothing. Cloud models are only unlocked by an explicit tier listing.
 */
const LOCAL_MODEL_RE = /^(llama|phi|mistral|qwen|gemma|codellama|deepseek|tinyllama)/i

/**
 * Is `model` allowed for `tier`? True when the model is listed in the tier's
 * `models.cloud` or `models.local` arrays, or (free tier only) when it looks like
 * a local Ollama model the user pulled themselves.
 */
export function isModelAllowedForTier(model: string, tier: TierId): boolean {
  const def = TIERS[tier]
  if (!def) return false
  const cloud = def.models.cloud as readonly string[]
  const local = def.models.local as readonly string[]
  if (cloud.includes(model) || local.includes(model)) return true
  if (tier === 'free' && (LOCAL_MODEL_RE.test(model) || model.includes(':'))) return true
  return false
}

/** The maximum cloud messages a tier may send per day (Infinity = unlimited). */
export function dailyMessageLimit(tier: TierId): number {
  return TIERS[tier]?.dailyMessageLimit ?? TIERS.free.dailyMessageLimit
}

/**
 * How long a cached tier may be trusted once Supabase becomes unreachable.
 * Beyond this we refuse to keep "unlocking" paid features and fall back to free.
 * Seconds, to match the `subscription_cache` schema (epoch SECONDS).
 */
export const MAX_CACHE_STALENESS_SEC = 24 * 60 * 60

function coerceTier(value: string | null | undefined): TierId {
  return value === 'pro' || value === 'enterprise' ? value : 'free'
}

/**
 * Best-effort, synchronous read of a user's tier from the local subscription
 * cache (the shared `database.subscriptions` repo). Returns 'free' when there is
 * no cached row, when the paid period has ended, OR when the row is older than
 * `MAX_CACHE_STALENESS_SEC` — i.e. we never trust a stale cache to unlock paid
 * features. For an authoritative value, call `syncSubscriptionStatus()` instead.
 */
export function getTierForUser(userId: string): TierId {
  const sub = database.subscriptions.getCachedSubscription(userId)
  if (!sub?.tier) return 'free'
  const nowSec = Math.floor(Date.now() / 1000)
  // Paid period has ended → downgrade (matches sessionManager.getUserTier).
  if (sub.current_period_end != null && sub.current_period_end <= nowSec) return 'free'
  // Stale cache (>24h since last sync) → don't trust it to unlock paid features.
  if (nowSec - sub.updated_at > MAX_CACHE_STALENESS_SEC) return 'free'
  return coerceTier(sub.tier)
}

/**
 * Clamp a *requested* tier down to what the user is actually entitled to.
 *
 * SECURITY: the chat/voice IPC carries a `tier` chosen by the (untrusted)
 * renderer. This prevents a compromised renderer from escalating itself to Pro/
 * Enterprise: a signed-in user can never route above their verified entitlement.
 * When there is no signed-in user (e.g. local dev before auth lands) we leave the
 * requested tier untouched so local development isn't blocked.
 */
export function clampTierToEntitlement(requested: TierId, userId: string | null): TierId {
  if (!userId) return requested
  const entitled = getTierForUser(userId)
  return TIER_RANK[requested] <= TIER_RANK[entitled] ? requested : entitled
}
