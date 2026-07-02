import { describe, it, expect, vi, beforeEach } from 'vitest'

// pricing.ts pulls in the shared database layer (native better-sqlite3) purely
// for the cached-subscription read. Mock it so these stay pure unit tests.
const getCachedSubscription = vi.fn()
vi.mock('../database', () => ({
  database: { subscriptions: { getCachedSubscription: (id: string) => getCachedSubscription(id) } }
}))

import {
  isModelAllowedForTier,
  dailyMessageLimit,
  monthlyVoiceMinuteLimit,
  getTierForUser,
  clampTierToEntitlement,
  MAX_CACHE_STALENESS_SEC
} from './pricing'

const nowSec = (): number => Math.floor(Date.now() / 1000)

beforeEach(() => {
  getCachedSubscription.mockReset()
})

describe('isModelAllowedForTier', () => {
  it('allows only the free tier model on free', () => {
    expect(isModelAllowedForTier('claude-3-5-haiku', 'free')).toBe(true)
    expect(isModelAllowedForTier('claude-3-5-sonnet', 'free')).toBe(false)
    expect(isModelAllowedForTier('gpt-4o', 'free')).toBe(false)
  })

  it('allows pro models on pro', () => {
    expect(isModelAllowedForTier('claude-3-5-sonnet', 'pro')).toBe(true)
    expect(isModelAllowedForTier('gpt-4o', 'pro')).toBe(true)
    expect(isModelAllowedForTier('glm-5.2', 'pro')).toBe(false)
  })

  it('rejects unknown models and tiers', () => {
    expect(isModelAllowedForTier('nonexistent-model', 'enterprise')).toBe(false)
    // @ts-expect-error — exercising a bad tier at runtime
    expect(isModelAllowedForTier('gpt-4o', 'platinum')).toBe(false)
  })
})

describe('limit helpers', () => {
  it('returns the documented per-tier caps', () => {
    expect(dailyMessageLimit('free')).toBe(5)
    expect(dailyMessageLimit('pro')).toBe(500)
    expect(dailyMessageLimit('enterprise')).toBe(Infinity)
    expect(monthlyVoiceMinuteLimit('free')).toBe(120)
    expect(monthlyVoiceMinuteLimit('enterprise')).toBe(Infinity)
  })

  it('falls back to free limits for an unknown tier', () => {
    // @ts-expect-error — runtime robustness for a bad tier value
    expect(dailyMessageLimit('bogus')).toBe(5)
  })
})

describe('getTierForUser', () => {
  it('is free when there is no cached subscription', () => {
    getCachedSubscription.mockReturnValue(undefined)
    expect(getTierForUser('u1')).toBe('free')
  })

  it('returns a fresh paid tier', () => {
    getCachedSubscription.mockReturnValue({
      tier: 'pro',
      updated_at: nowSec(),
      current_period_end: nowSec() + 3600
    })
    expect(getTierForUser('u1')).toBe('pro')
  })

  it('downgrades to free once the paid period has ended', () => {
    getCachedSubscription.mockReturnValue({
      tier: 'pro',
      updated_at: nowSec(),
      current_period_end: nowSec() - 10
    })
    expect(getTierForUser('u1')).toBe('free')
  })

  it('does not trust a stale cache to keep paid features unlocked', () => {
    getCachedSubscription.mockReturnValue({
      tier: 'enterprise',
      updated_at: nowSec() - MAX_CACHE_STALENESS_SEC - 60,
      current_period_end: nowSec() + 100000
    })
    expect(getTierForUser('u1')).toBe('free')
  })
})

describe('clampTierToEntitlement (security)', () => {
  it('leaves the requested tier untouched when there is no signed-in user', () => {
    expect(clampTierToEntitlement('enterprise', null)).toBe('enterprise')
    expect(getCachedSubscription).not.toHaveBeenCalled()
  })

  it('prevents a renderer from escalating above its entitlement', () => {
    // User is genuinely free; a compromised renderer asks for enterprise.
    getCachedSubscription.mockReturnValue(undefined)
    expect(clampTierToEntitlement('enterprise', 'u1')).toBe('free')
  })

  it('allows requesting at or below the real entitlement', () => {
    getCachedSubscription.mockReturnValue({
      tier: 'pro',
      updated_at: nowSec(),
      current_period_end: nowSec() + 3600
    })
    expect(clampTierToEntitlement('pro', 'u1')).toBe('pro')
    expect(clampTierToEntitlement('free', 'u1')).toBe('free')
    // Requesting above entitlement clamps down to pro.
    expect(clampTierToEntitlement('enterprise', 'u1')).toBe('pro')
  })
})
