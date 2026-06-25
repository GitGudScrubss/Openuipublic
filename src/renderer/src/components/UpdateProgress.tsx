import type { CSSProperties } from 'react'

export interface UpdateProgressProps {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bps: number): string {
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

/** Compact download-progress strip shown while an update is downloading (Windows only). */
export default function UpdateProgress({ percent, bytesPerSecond, transferred, total }: UpdateProgressProps): JSX.Element {
  const pct = Math.min(100, Math.max(0, Math.round(percent)))

  return (
    <div style={wrapStyle}>
      <div style={rowStyle}>
        <span style={labelStyle}>Downloading update… {pct}%</span>
        {bytesPerSecond > 0 && <span style={speedStyle}>{formatSpeed(bytesPerSecond)}</span>}
      </div>
      <div style={trackStyle}>
        <div style={{ ...fillStyle, width: `${pct}%` }} />
      </div>
      {total > 0 && (
        <span style={sizeStyle}>
          {formatBytes(transferred)} / {formatBytes(total)}
        </span>
      )}
    </div>
  )
}

const wrapStyle: CSSProperties = {
  padding: '8px 12px',
  background: 'rgba(10,132,255,0.06)',
  border: '1px solid rgba(10,132,255,0.15)',
  borderRadius: 10,
  marginBottom: 10,
}
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 6,
}
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 500, color: '#1c1c1e' }
const speedStyle: CSSProperties = { fontSize: 11, color: '#636366' }
const sizeStyle: CSSProperties = { fontSize: 10, color: '#aeaeb2', marginTop: 4, display: 'block' }
const trackStyle: CSSProperties = {
  height: 4,
  background: 'rgba(0,0,0,0.08)',
  borderRadius: 2,
  overflow: 'hidden',
}
const fillStyle: CSSProperties = {
  height: '100%',
  background: '#0a84ff',
  borderRadius: 2,
  transition: 'width 0.25s ease',
}
