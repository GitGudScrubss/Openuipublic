/**
 * ActivityPanel (#5) — the right-side "here's what I'm doing right now" panel.
 *
 * Top: a live tile for the app currently being driven (browser, WhatsApp, …),
 * shown only while a turn is executing. There is no screenshot-streaming channel
 * to the renderer (and adding one would widen the IPC surface), so the tile is a
 * live app *icon* + current-action state with a scanline animation — the honest
 * visual of "controlling the Browser right now", not a fabricated screen capture.
 *
 * Bottom: a running history of completed tasks, most recent on top, so the user
 * can see what's been done. All data comes from TaskActivityContext.
 */
import type { TaskCard } from '../env'
import { useTaskActivity } from '../context/TaskActivityContext'
import { metaForKind } from '../lib/appKind'
import AppIcon from './AppIcon'

function durationLabel(card: TaskCard): string {
  if (!card.endedAt) return ''
  const ms = card.endedAt - card.startedAt
  if (ms < 1000) return '<1s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function HistoryRow({ card }: { card: TaskCard }): JSX.Element {
  const meta = metaForKind(card.currentApp ?? 'thinking')
  return (
    <div className={`ou-hist-row ${card.status}`}>
      <span className={`ou-hist-icon ${meta.kind}`}>
        <AppIcon kind={meta.kind} size={14} />
      </span>
      <div className="ou-hist-body">
        <span className="ou-hist-title">{card.title}</span>
        <span className="ou-hist-sub">
          {card.status === 'failed' ? 'Failed' : 'Completed'}
          {card.steps.length > 0 ? ` · ${card.steps.length} step${card.steps.length === 1 ? '' : 's'}` : ''}
          {durationLabel(card) ? ` · ${durationLabel(card)}` : ''}
        </span>
      </div>
      <span className={`ou-hist-dot ${card.status}`} aria-hidden="true" />
    </div>
  )
}

export default function ActivityPanel(): JSX.Element | null {
  const { tasks, activeApp } = useTaskActivity()

  const running = tasks.find((c) => c.status === 'in_progress')
  const history = tasks
    .filter((c) => c.status !== 'in_progress' && (c.steps.length > 0 || c.kind === 'assigned'))
    .slice()
    .reverse()

  // Nothing to show — stay out of the way on an idle window.
  if (!activeApp && history.length === 0) return null

  const meta = activeApp ? metaForKind(activeApp) : null

  return (
    <aside className="ou-activity" aria-label="Live activity">
      <div className="ou-activity-header">Activity</div>

      {meta ? (
        <div className={`ou-activity-tile ${meta.kind}`}>
          <div className="ou-activity-screen">
            <div className="ou-activity-scanline" />
            <div className={`ou-activity-glyph ${meta.kind}`}>
              <AppIcon kind={meta.kind} size={40} />
            </div>
          </div>
          <div className="ou-activity-caption">
            <span className="ou-activity-live">
              <span className="ou-activity-live-dot" />
              Live
            </span>
            <span className="ou-activity-app">Controlling {meta.label}</span>
            <span className="ou-activity-phrase">{running?.title ?? meta.phrase}</span>
          </div>
        </div>
      ) : (
        <div className="ou-activity-idle">
          <span className="ou-activity-idle-dot" />
          Idle — no app being controlled
        </div>
      )}

      <div className="ou-activity-history-label">Recent tasks</div>
      <div className="ou-activity-history">
        {history.length === 0 ? (
          <div className="ou-activity-history-empty">Completed tasks will appear here.</div>
        ) : (
          history.map((card) => <HistoryRow key={card.id} card={card} />)
        )}
      </div>
    </aside>
  )
}
