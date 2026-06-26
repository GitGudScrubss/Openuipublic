import { useState, useEffect, useCallback, useRef } from 'react'

export function RecorderUI(): JSX.Element {
  const [isRecording, setIsRecording] = useState(false)
  const [currentActions, setCurrentActions] = useState<RecorderAction[]>([])
  const [macros, setMacros] = useState<RecorderMacro[]>([])
  const [macroName, setMacroName] = useState('')
  const [playingMacro, setPlayingMacro] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [pendingText, setPendingText] = useState('')
  const blinkRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [dotCount, setDotCount] = useState(0)

  const loadMacros = useCallback(async () => {
    const list = await window.openui.recorderGetMacros()
    setMacros(list as RecorderMacro[])
  }, [])

  useEffect(() => {
    void loadMacros()
  }, [loadMacros])

  useEffect(() => {
    if (isRecording) {
      blinkRef.current = setInterval(() => setDotCount((d) => (d + 1) % 4), 500)
    } else {
      if (blinkRef.current) clearInterval(blinkRef.current)
      setDotCount(0)
    }
    return () => {
      if (blinkRef.current) clearInterval(blinkRef.current)
    }
  }, [isRecording])

  const handleStartStop = useCallback(async () => {
    if (isRecording) {
      const actions = (await window.openui.recorderStop()) as RecorderAction[]
      setCurrentActions(actions)
      setIsRecording(false)
      setStatus(`Captured ${actions.length} event(s)`)
    } else {
      await window.openui.recorderStart()
      setIsRecording(true)
      setCurrentActions([])
      setStatus('')
    }
  }, [isRecording])

  const handleAddClick = useCallback(async () => {
    await window.openui.recorderRecordClick(0, 0, 'left')
    setStatus('Click at current cursor position recorded')
  }, [])

  const handleAddKeypress = useCallback(async () => {
    const text = pendingText.trim()
    if (!text) return
    await window.openui.recorderRecordKeypress(text)
    setPendingText('')
    setStatus(`Keypress "${text}" recorded`)
  }, [pendingText])

  const handleSave = useCallback(async () => {
    const name = macroName.trim()
    if (!name || currentActions.length === 0) return
    await window.openui.recorderSaveMacro(name, currentActions)
    setMacroName('')
    setCurrentActions([])
    setStatus(`Macro "${name}" saved`)
    await loadMacros()
  }, [macroName, currentActions, loadMacros])

  const handlePlay = useCallback(
    async (macro: RecorderMacro) => {
      if (playingMacro) return
      setPlayingMacro(macro.name)
      setStatus(`Playing "${macro.name}"…`)
      await window.openui.recorderPlay(macro.actions as RecorderAction[])
      setPlayingMacro(null)
      setStatus('')
    },
    [playingMacro]
  )

  const handleDelete = useCallback(
    async (name: string) => {
      await window.openui.recorderDeleteMacro(name)
      setStatus(`Macro "${name}" deleted`)
      await loadMacros()
    },
    [loadMacros]
  )

  const recordingDots = '.'.repeat(dotCount)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        fontFamily: 'inherit',
        fontSize: '14px',
        color: 'var(--text-primary, #e2e8f0)',
        background: 'var(--surface-secondary, #1e293b)',
        borderRadius: '8px',
        maxWidth: '480px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontWeight: 600, fontSize: '15px' }}>Action Recorder</span>
        {isRecording && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              background: '#ef4444',
              color: '#fff',
              borderRadius: '999px',
              padding: '2px 10px',
              fontSize: '12px',
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: '#fff',
                animation: 'pulse 1s infinite',
              }}
            />
            REC{recordingDots}
          </span>
        )}
      </div>

      {/* Record / Stop button */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <button
          onClick={() => void handleStartStop()}
          style={{
            padding: '7px 16px',
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '13px',
            background: isRecording ? '#ef4444' : '#3b82f6',
            color: '#fff',
          }}
        >
          {isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>

        {isRecording && (
          <>
            <button
              onClick={() => void handleAddClick()}
              style={{
                padding: '7px 12px',
                borderRadius: '6px',
                border: '1px solid #475569',
                cursor: 'pointer',
                fontSize: '12px',
                background: 'transparent',
                color: 'var(--text-primary, #e2e8f0)',
              }}
            >
              + Click
            </button>

            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="text"
                value={pendingText}
                onChange={(e) => setPendingText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleAddKeypress()}
                placeholder="Type text…"
                style={{
                  padding: '6px 10px',
                  borderRadius: '5px',
                  border: '1px solid #475569',
                  background: '#0f172a',
                  color: 'inherit',
                  fontSize: '12px',
                  width: '110px',
                }}
              />
              <button
                onClick={() => void handleAddKeypress()}
                style={{
                  padding: '6px 10px',
                  borderRadius: '5px',
                  border: '1px solid #475569',
                  cursor: 'pointer',
                  fontSize: '12px',
                  background: 'transparent',
                  color: 'var(--text-primary, #e2e8f0)',
                }}
              >
                + Type
              </button>
            </div>
          </>
        )}
      </div>

      {/* Events preview */}
      {currentActions.length > 0 && !isRecording && (
        <div
          style={{
            fontSize: '12px',
            color: '#94a3b8',
            background: '#0f172a',
            borderRadius: '6px',
            padding: '8px 10px',
          }}
        >
          {currentActions.length} event(s) recorded
          <span style={{ marginLeft: '8px', color: '#64748b' }}>
            ({currentActions.filter((a) => a.type === 'mousemove').length} moves,{' '}
            {currentActions.filter((a) => a.type === 'mouseclick').length} clicks,{' '}
            {currentActions.filter((a) => a.type === 'keypress').length} text inputs)
          </span>
        </div>
      )}

      {/* Save macro */}
      {currentActions.length > 0 && !isRecording && (
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            type="text"
            value={macroName}
            onChange={(e) => setMacroName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSave()}
            placeholder="Macro name…"
            style={{
              flex: 1,
              padding: '6px 10px',
              borderRadius: '5px',
              border: '1px solid #475569',
              background: '#0f172a',
              color: 'inherit',
              fontSize: '13px',
            }}
          />
          <button
            onClick={() => void handleSave()}
            disabled={!macroName.trim()}
            style={{
              padding: '6px 14px',
              borderRadius: '5px',
              border: 'none',
              cursor: macroName.trim() ? 'pointer' : 'not-allowed',
              background: macroName.trim() ? '#22c55e' : '#374151',
              color: '#fff',
              fontWeight: 600,
              fontSize: '13px',
            }}
          >
            Save
          </button>
        </div>
      )}

      {/* Status message */}
      {status && (
        <div style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>{status}</div>
      )}

      {/* Saved macros list */}
      {macros.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '6px', color: '#94a3b8' }}>
            Saved Macros
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {macros.map((macro) => (
              <div
                key={macro.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#0f172a',
                  borderRadius: '6px',
                  padding: '7px 10px',
                  gap: '8px',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '13px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {macro.name}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>
                    {macro.actions.length} events &middot;{' '}
                    {new Date(macro.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={() => void handlePlay(macro)}
                  disabled={!!playingMacro}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '5px',
                    border: 'none',
                    cursor: playingMacro ? 'not-allowed' : 'pointer',
                    background: playingMacro === macro.name ? '#6b7280' : '#3b82f6',
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 600,
                    minWidth: '48px',
                  }}
                >
                  {playingMacro === macro.name ? '…' : '▶ Play'}
                </button>
                <button
                  onClick={() => void handleDelete(macro.name)}
                  disabled={!!playingMacro}
                  style={{
                    padding: '4px 8px',
                    borderRadius: '5px',
                    border: '1px solid #475569',
                    cursor: playingMacro ? 'not-allowed' : 'pointer',
                    background: 'transparent',
                    color: '#f87171',
                    fontSize: '12px',
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {macros.length === 0 && !isRecording && currentActions.length === 0 && (
        <div style={{ fontSize: '12px', color: '#475569', textAlign: 'center', padding: '8px 0' }}>
          No saved macros. Start recording to create one.
        </div>
      )}
    </div>
  )
}
