import { useEffect, useRef, useState } from 'react'
import AssistantPopup from './components/AssistantPopup'
import TaskListPopup from './components/TaskListPopup'
import PermissionModal from './components/PermissionModal'
import { useAssistantAnimations } from './hooks/useAssistantAnimations'
import { AuthProvider } from './context/AuthContext'
import type { PermissionTarget } from './env'

function AppShell(): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const recordingRef = useRef<boolean>(false)
  const captionLockedRef = useRef<boolean>(false)

  const [permissionNeeded, setPermissionNeeded] = useState<PermissionTarget | null>(null)

  useAssistantAnimations(overlayRef, recordingRef, captionLockedRef)

  useEffect(() => {
    return window.openui.onPermissionDenied((permission) => {
      setPermissionNeeded(permission as PermissionTarget)
    })
  }, [])

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) window.openui?.hide()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (permissionNeeded) {
          setPermissionNeeded(null)
        } else {
          window.openui?.hide()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [permissionNeeded])

  return (
    <div ref={overlayRef} className="openui-overlay" onMouseDown={handleBackdrop}>
      <AssistantPopup
        recordingRef={recordingRef}
        captionLockedRef={captionLockedRef}
        onPermissionNeeded={setPermissionNeeded}
      />
      <TaskListPopup />
      {permissionNeeded && (
        <PermissionModal
          permission={permissionNeeded}
          onDismiss={() => setPermissionNeeded(null)}
        />
      )}
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
