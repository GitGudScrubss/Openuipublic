/**
 * authGate.ts — Centralised auth and tier-access checks for IPC handlers.
 */
import { getCurrentUser, getUserTier, type UserProfile } from './sessionManager'
import type { TierId } from '../stripe/pricing'

const TIER_ORDER: TierId[] = ['free', 'pro', 'enterprise']

export async function requireAuth(): Promise<UserProfile | null> {
  return await getCurrentUser()
}

export function requireTier(minimumTier: TierId): boolean {
  const tier = getUserTier() as TierId
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minimumTier)
}
