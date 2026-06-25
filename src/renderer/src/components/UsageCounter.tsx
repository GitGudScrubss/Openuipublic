import { useEffect, useState } from 'react'
import type { UsageUpdatePayload } from '../env'

/**
 * Small header counter showing the day's remaining cloud messages
 * (e.g. "15/20 today"). Driven entirely by `openui:usage-update`, which the
 * main process emits after every turn. It renders nothing until the first
 * update arrives, and nothing for non-metered turns (Enterprise / local AI),
 * so unlimited users never see a quota.
 */
export default function UsageCounter(): JSX.Element | null {
  const [usage, setUsage] = useState<UsageUpdatePayload | null>(null)

  useEffect(() => window.openui.onUsageUpdate(setUsage), [])

  // Nothing to show before the first turn, or when the tier isn't metered.
  if (!usage || usage.unlimited || usage.limit === null || usage.remaining === null) return null

  // Warn as the balance runs low (≤20% remaining), then red at zero.
  const low = usage.remaining <= Math.max(1, Math.ceil(usage.limit * 0.2))
  const color = usage.remaining === 0 ? '#ff3b30' : low ? '#ff9500' : '#8e8e93'

  return (
    <div
      className="popup-usage"
      title={`${usage.remaining} of ${usage.limit} daily cloud messages remaining`}
      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
    >
      <span style={{ fontSize: 11, color, fontWeight: 500, fontFamily: '-apple-system, sans-serif' }}>
        {usage.remaining}/{usage.limit} today
      </span>
    </div>
  )
}
