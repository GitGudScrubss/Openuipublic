import { useAuth } from '../context/AuthContext'
import type { Tier } from '../env'

const STATUS: Record<Tier, { dot: string; label: string }> = {
  free: { dot: '#34c759', label: 'Local · Free' },
  pro: { dot: '#7c3aed', label: 'Pro · Cloud' },
  enterprise: { dot: '#b45309', label: 'Enterprise · GPU' }
}

export default function SubscriptionStatus(): JSX.Element {
  const { tier } = useAuth()
  const { dot, label } = STATUS[tier]

  return (
    <div
      className="popup-status"
      style={{ display: 'flex', alignItems: 'center', gap: 5 }}
    >
      <div
        className="status-dot"
        style={{ background: dot, width: 6, height: 6, borderRadius: '50%', flexShrink: 0 }}
      />
      <span style={{ fontSize: 11, color: '#8e8e93', fontWeight: 500, fontFamily: '-apple-system, sans-serif' }}>
        {label}
      </span>
    </div>
  )
}
