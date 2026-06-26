import { useCallback, useEffect, useRef, useState } from 'react'
import AssistantPopup from './components/AssistantPopup'
import TaskListPopup from './components/TaskListPopup'
import PermissionModal from './components/PermissionModal'
import OnboardingWizard from './components/onboarding/OnboardingWizard'
import ConsentModal from './components/ConsentModal'
import WorkflowsUI from './components/WorkflowsUI'
import { useAssistantAnimations } from './hooks/useAssistantAnimations'
import { useOnboarding } from './hooks/useOnboarding'
import { AuthProvider } from './context/AuthContext'
import type { PermissionTarget } from './env'

/** Brief splash shown while the persisted onboarding flag is read. */
function LoadingScreen(): JSX.Element {
  return (
    <div className="openui-loading">
      <div className="openui-loading-orb">
        <div className="openui-loading-dot" />
      </div>
    </div>
  )
}

function AppShell(): JSX.Element {
  const overlayRef = useRef<HTMLDivElement>(null)
  const recordingRef = useRef<boolean>(false)
  const captionLockedRef = useRef<boolean>(false)

  const [permissionNeeded, setPermissionNeeded] = useState<PermissionTarget | null>(null)
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)

  const { isComplete, isLoading, completeOnboarding } = useOnboarding()
  // The first message typed in onboarding, replayed once the chat mounts.
  const [initialMessage, setInitialMessage] = useState<string | null>(null)

  const showChat = !isLoading && isComplete
  // Only run the popup entrance choreography once the chat UI is mounted.
  useAssistantAnimations(overlayRef, recordingRef, captionLockedRef, showChat)

  useEffect(() => {
    return window.openui.onPermissionDenied((permission) => {
      setPermissionNeeded(permission as PermissionTarget)
    })
  }, [])

  // First-launch privacy consent: show the prompt only while status is UNKNOWN.
  // "Skip" persists a permanent DENIED, so this never reappears on later launches.
  useEffect(() => {
    let cancelled = false
    window.openui
      .getConsentStatus()
      .then((status) => {
        if (!cancelled && status === 'unknown') setConsentNeeded(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
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

  const handleOnboardingComplete = useCallback(
    (firstMessage: string | null): void => {
      setInitialMessage(firstMessage)
      void completeOnboarding()
    },
    [completeOnboarding]
  )

  const handleRunWorkflow = useCallback((workflowName: string): void => {
    window.openui
      .getTier()
      .then((tier) => window.openui.chat(`Run workflow: ${workflowName}`, tier as 'free' | 'pro' | 'enterprise'))
      .catch(() => {})
  }, [])

  return (
    <div ref={overlayRef} className="openui-overlay" onMouseDown={handleBackdrop}>
      {isLoading ? (
        <LoadingScreen />
      ) : !isComplete ? (
        <OnboardingWizard onComplete={handleOnboardingComplete} />
      ) : (
        <>
          <AssistantPopup
            recordingRef={recordingRef}
            captionLockedRef={captionLockedRef}
            onPermissionNeeded={setPermissionNeeded}
            initialMessage={initialMessage}
          />
          <TaskListPopup />
          {/* Workflows toggle button — bottom-left corner */}
          <button
            onClick={() => setShowWorkflows(true)}
            title="Team Workflows"
            style={{
              position: 'fixed',
              bottom: 24,
              left: 24,
              zIndex: 9000,
              background: 'rgba(18,18,22,0.85)',
              border: '1px solid rgba(167,139,250,0.3)',
              borderRadius: 10,
              color: '#a78bfa',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
              padding: '6px 11px',
              backdropFilter: 'blur(8px)',
              letterSpacing: '0.03em'
            }}
          >
            Workflows
          </button>
          {showWorkflows && (
            <WorkflowsUI
              onClose={() => setShowWorkflows(false)}
              onRunWorkflow={handleRunWorkflow}
            />
          )}
          {permissionNeeded && (
            <PermissionModal
              permission={permissionNeeded}
              onDismiss={() => setPermissionNeeded(null)}
            />
          )}
        </>
      )}
      {consentNeeded && <ConsentModal onClose={() => setConsentNeeded(false)} />}
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
