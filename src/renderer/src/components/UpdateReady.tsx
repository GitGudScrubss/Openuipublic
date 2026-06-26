import { useState, type CSSProperties } from 'react'

export interface UpdateReadyProps {
  version: string
  onRestart: () => void
  onDismiss: () => void
}

/**
 * Shown when a downloaded update is ready to install.
 * Persists after "Later" as a minimal indicator — the update will apply
 * automatically on next quit (autoInstallOnAppQuit is set in the main process).
 */
export default function UpdateReady({ version, onRestart, onDismiss }: UpdateReadyProps): JSX.Element {
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) {
    return (
      <div style={minimalStyle}>
        <span style={dotStyle} />
        <span style={minimalTextStyle}>Update ready — installs on next quit</span>
      </div>
    )
  }

  return (
    <div style={bannerStyle}>
      <span style={textStyle}>Restart to install v{version}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <button
          style={laterBtn}
          onClick={() => {
            setDismissed(true)
            onDismiss()
          }}
        >
          Later
        </button>
        <button style={restartBtn} onClick={onRestart}>
          Restart &amp; Update
        </button>
      </div>
    </div>
  )
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '7px 10px 7px 12px',
  background: 'linear-gradient(135deg, rgba(52,199,89,0.10) 0%, rgba(10,132,255,0.07) 100%)',
  border: '1px solid rgba(52,199,89,0.22)',
  borderRadius: 10,
  marginBottom: 10,
}
const textStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: '#1c1c1e',
  flex: 1,
  minWidth: 0,
}
const restartBtn: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#fff',
  background: '#34c759',
  border: 'none',
  borderRadius: 6,
  padding: '4px 9px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
const laterBtn: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: '#636366',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: '4px 6px',
}
const minimalStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 12px',
  marginBottom: 6,
}
const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: '#34c759',
  flexShrink: 0,
}
const minimalTextStyle: CSSProperties = { fontSize: 11, color: '#8e8e93' }
