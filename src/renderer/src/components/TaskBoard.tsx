/**
 * TaskBoard — the top-right docked task panel (#4). It grows out of the original
 * TaskListPopup: it keeps that file's live agent-status plumbing (the Autonomous
 * "Background Agent" banner + toggles, driven by the same IPC), but the flat
 * one-row-per-tool list is now an Asana-style board of clickable *task cards*.
 *
 * Cards come from TaskActivityContext, which groups each turn's tool calls under
 * the user's request. A card shows title + status; clicking expands it to the
 * individual steps/tool calls that ran, each with its pending/working/done/error
 * state. The card entrance is still animated by useAssistantAnimations via the
 * preserved `#task-popup` id.
 */
import { useEffect, useState } from 'react'
import type { AutonomousStatus, TaskCard, TaskStatus } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import { metaForKind } from '../lib/appKind'
import AppIcon from './AppIcon'

function CheckIcon(): JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
      <path d="M20 6L9 17l-5-5" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StepCheck({ status }: { status: TaskStatus }): JSX.Element {
  if (status === 'done') return <div className="task-check done"><CheckIcon /></div>
  if (status === 'working') return <div className="task-check working"><div className="task-spinner" /></div>
  if (status === 'error') {
    return (
      <div className="task-check error">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
          <path d="M18 6L6 18M6 6l12 12" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </div>
    )
  }
  return <div className="task-check pending" />
}

/** Small pill toggle used for the Autonomous / I'm-busy switches. */
function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className={`auto-toggle ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="auto-toggle-track">
        <span className="auto-toggle-thumb" />
      </span>
      <span className="auto-toggle-label">{label}</span>
    </button>
  )
}

function autonomousLine(status: AutonomousStatus): string {
  switch (status.state) {
    case 'working':
      return status.currentTask ? `Background Agent Working… — ${status.currentTask}` : 'Background Agent Working…'
    case 'monitoring':
      return status.detail ?? 'Monitoring — will work while you are away'
    case 'paused':
      return 'Paused — welcome back'
    default:
      return 'Autonomous mode off'
  }
}

function statusText(status: TaskCard['status']): string {
  if (status === 'in_progress') return 'In progress'
  if (status === 'done') return 'Done'
  return 'Failed'
}

function TaskCardRow({ card }: { card: TaskCard }): JSX.Element {
  // Auto-expand while running; collapse once it settles (user can re-open).
  const [expanded, setExpanded] = useState(card.status === 'in_progress')
  useEffect(() => {
    if (card.status === 'in_progress') setExpanded(true)
  }, [card.status])

  const meta = metaForKind(card.currentApp ?? 'thinking')
  const doneSteps = card.steps.filter((s) => s.status === 'done').length

  return (
    <div className={`ou-card ${card.status}`}>
      <button type="button" className="ou-card-head" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className={`ou-card-appicon ${meta.kind}`}>
          <AppIcon kind={meta.kind} size={15} />
        </span>
        <span className="ou-card-title">{card.title}</span>
        <span className={`ou-card-badge ${card.status}`}>{statusText(card.status)}</span>
        <svg
          className={`ou-card-chevron ${expanded ? 'open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {card.steps.length > 0 && (
        <div className="ou-card-meta">
          {doneSteps}/{card.steps.length} steps
        </div>
      )}

      {expanded && card.steps.length > 0 && (
        <div className="ou-card-steps">
          {card.steps.map((step) => (
            <div key={step.id} className={`ou-step ${step.status}`}>
              <StepCheck status={step.status} />
              <div className="ou-step-body">
                <div className={`task-label ${step.status}`}>{step.label}</div>
                {step.detail && (step.status === 'working' || step.status === 'error') && (
                  <div className={`task-sublabel ${step.status === 'error' ? 'error' : ''}`}>{step.detail}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TaskBoard(): JSX.Element {
  const { tasks } = useTaskActivity()
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState<AutonomousStatus>({ active: false, state: 'disabled' })

  // Autonomous Coding Mode: hydrate current status, then subscribe to updates.
  useEffect(() => {
    let live = true
    window.openui
      .getAutonomousStatus()
      .then((s) => {
        if (live) {
          setAuto(s)
          setEnabled(s.active)
        }
      })
      .catch(() => {})
    const off = window.openui.onAutonomousStatus((s) => {
      setAuto(s)
      setEnabled(s.active)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const toggleEnabled = (): void => {
    const next = !enabled
    setEnabled(next)
    if (!next) setBusy(false)
    window.openui.setAutonomousEnabled(next)
  }

  const toggleBusy = (): void => {
    const next = !busy
    setBusy(next)
    window.openui.setBusy(next)
  }

  const working = auto.active && auto.state === 'working'

  // Only surface cards that actually spawned multi-step work (or were explicitly
  // assigned) — plain one-shot chat answers shouldn't clutter the board. Newest
  // on top so an in-flight task is always visible; the full log lives in the
  // activity panel's history.
  const boardCards = tasks.filter((c) => c.steps.length > 0 || c.kind === 'assigned').slice().reverse()
  const activeCount = boardCards.filter((c) => c.status === 'in_progress').length

  return (
    <div id="task-popup" className="ou-taskboard">
      <div className="ou-taskboard-header">
        <div className="task-popup-title-row">
          <div className="task-icon-badge">
            <CheckIcon />
          </div>
          <span className="ou-taskboard-heading">Tasks</span>
        </div>
        <span className="ou-taskboard-count">
          {boardCards.length === 0 ? 'Idle' : activeCount > 0 ? `${activeCount} active` : `${boardCards.length} recent`}
        </span>
      </div>

      {/* Background Agent banner — visible whenever Autonomous Coding Mode is on. */}
      {auto.active && (
        <div className={`autonomous-banner ${auto.state}`}>
          {working ? <div className="autonomous-pulse" /> : <div className="autonomous-dot" />}
          <div className="autonomous-text">
            <div className="autonomous-line">{autonomousLine(auto)}</div>
            {auto.detail && auto.state === 'working' && <div className="autonomous-detail">{auto.detail}</div>}
          </div>
        </div>
      )}

      <div className="ou-taskboard-list">
        {boardCards.length === 0 ? (
          <div className="ou-taskboard-empty">
            <span className="ou-taskboard-empty-title">No tasks yet</span>
            <span className="ou-taskboard-empty-sub">Ask OpenUI to do something and it shows up here.</span>
          </div>
        ) : (
          boardCards.map((card) => <TaskCardRow key={card.id} card={card} />)
        )}
      </div>

      {/* Autonomous-mode controls: master switch + manual "I'm busy" override. */}
      <div className="autonomous-controls">
        <Toggle label="Autonomous" on={enabled} onClick={toggleEnabled} />
        <Toggle label="I'm busy" on={busy} onClick={toggleBusy} />
      </div>

      <div className="task-popup-footer">
        <div className="footer-dot" />
        <span className="ou-taskboard-footer-text">Llama 3 · Running locally · 0 cloud calls</span>
      </div>
    </div>
  )
}
