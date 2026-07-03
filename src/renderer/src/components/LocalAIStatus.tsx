import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import type { Tier } from '../env'

const CLOUD_LIMIT: Record<Tier, string> = {
  free: '5 messages/day free',
  pro: '500 messages/day cloud',
  enterprise: 'Unlimited cloud messages'
}

export default function LocalAIStatus(): JSX.Element {
  const { tier } = useAuth()
  // Set when a screen read downgraded to local OCR instead of Claude Vision.
  const [ocrHint, setOcrHint] = useState(false)

  useEffect(() => {
    const off = window.openui.onScreenOcrFallback(() => setOcrHint(true))
    return off
  }, [])

  // Auto-dismiss the hint after a few seconds so it never lingers permanently.
  useEffect(() => {
    if (!ocrHint) return
    const id = window.setTimeout(() => setOcrHint(false), 8000)
    return () => window.clearTimeout(id)
  }, [ocrHint])

  return (
    <>
      {ocrHint && (
        <div style={hintStyle} role="status">
          <span style={{ flex: 1 }}>
            Screen read used local OCR (a Free-tier limit, not an error). Upgrade to Pro for
            precise Claude Vision element detection.
          </span>
          <button
            type="button"
            onClick={() => setOcrHint(false)}
            aria-label="Dismiss"
            style={dismissStyle}
          >
            ✕
          </button>
        </div>
      )}
      <div style={rowStyle}>
        <span style={{ ...dotStyle, background: '#34c759' }} />
        <span style={labelStyle}>Cloud AI · {CLOUD_LIMIT[tier]}</span>
      </div>
    </>
  )
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 16px',
  borderTop: '1px solid rgba(0,0,0,0.06)',
  fontFamily: '-apple-system, sans-serif'
}

const hintStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '8px 16px',
  borderTop: '1px solid rgba(0,0,0,0.06)',
  background: 'rgba(255,159,10,0.12)',
  color: '#b25e00',
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: '-apple-system, sans-serif'
}

const dismissStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: '#b25e00',
  cursor: 'pointer',
  fontSize: 11,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0
}

const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flexShrink: 0
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#8e8e93',
  fontWeight: 500,
  flex: 1
}
