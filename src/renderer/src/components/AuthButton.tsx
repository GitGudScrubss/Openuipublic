import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import type { Tier } from '../env'

const TIER_BADGE: Record<Tier, { label: string; bg: string; color: string }> = {
  free: { label: 'Free', bg: '#e5e5ea', color: '#636366' },
  pro: { label: 'Pro', bg: '#e9d5ff', color: '#7c3aed' },
  enterprise: { label: 'Enterprise', bg: '#fef3c7', color: '#b45309' }
}

export default function AuthButton(): JSX.Element {
  const { user, tier, isAnonymous } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  if (!user || isAnonymous) {
    return (
      <button
        onClick={() => window.openui.login()}
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#ffffff',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          border: 'none',
          borderRadius: 8,
          padding: '4px 10px',
          cursor: 'pointer',
          letterSpacing: '-0.01em',
          fontFamily: '-apple-system, sans-serif'
        }}
      >
        Sign in
      </button>
    )
  }

  const badge = TIER_BADGE[tier]
  const initials = user.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : (user.email ?? user.id).slice(0, 2).toUpperCase()

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setMenuOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0
        }}
      >
        {/* Avatar */}
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: user.avatar_url ? 'transparent' : 'linear-gradient(135deg, #667eea, #764ba2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden'
          }}
        >
          {user.avatar_url ? (
            <img src={user.avatar_url} width={24} height={24} style={{ objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{initials}</span>
          )}
        </div>
        {/* Tier badge */}
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            background: badge.bg,
            color: badge.color,
            borderRadius: 6,
            padding: '2px 6px',
            letterSpacing: '-0.01em',
            fontFamily: '-apple-system, sans-serif'
          }}
        >
          {badge.label}
        </span>
      </button>

      {menuOpen && (
        <div
          style={{
            position: 'absolute',
            top: 30,
            right: 0,
            background: 'rgba(255,255,255,0.97)',
            backdropFilter: 'blur(12px)',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
            width: 180,
            zIndex: 1000,
            overflow: 'hidden'
          }}
        >
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #f2f2f7' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#1c1c1e', fontFamily: '-apple-system, sans-serif' }}>
              {user.name || user.email}
            </div>
            <div style={{ fontSize: 10, color: '#8e8e93', marginTop: 2, fontFamily: '-apple-system, sans-serif' }}>
              {user.email}
            </div>
          </div>
          <MenuItem
            label="Manage Subscription"
            onClick={() => { window.openui.openPortal(); setMenuOpen(false) }}
          />
          <MenuItem
            label="Sign Out"
            onClick={() => { window.openui.logout(); setMenuOpen(false) }}
            danger
          />
        </div>
      )}

      {/* Dismiss menu on outside click */}
      {menuOpen && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 999 }}
          onClick={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}

function MenuItem({
  label,
  onClick,
  danger
}: {
  label: string
  onClick: () => void
  danger?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        padding: '9px 12px',
        fontSize: 12,
        color: danger ? '#ff3b30' : '#1c1c1e',
        cursor: 'pointer',
        fontFamily: '-apple-system, sans-serif'
      }}
    >
      {label}
    </button>
  )
}
