import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskCard, TaskUpdatePayload } from '../env'
import { appKindForTool, type AppKind } from '../lib/appKind'

/**
 * TaskActivityContext — the single source of truth for the task board (#4) and
 * the live activity panel (#5). It groups the agent's per-turn IPC events into
 * task *cards*:
 *
 *   • `beginTask(title, kind)` — called by the chat UI when a new turn starts,
 *     so the card gets a real title (the user's request) rather than "Untitled".
 *   • `openui:task:update` — one step (tool call or plan row) of the current card.
 *   • `openui:chat:tool`  — which app the agent is driving right now (for the tile).
 *   • `openui:chat:done` / `openui:chat:error` — finalize the current card.
 *
 * Turns started outside the chat UI (autonomous mode, workflow runs) never call
 * `beginTask`; for those a card is created lazily on the first step so nothing is
 * lost. Multiple `ipcRenderer.on` listeners per channel are fine — the chat view
 * subscribes to the same events independently.
 */
interface TaskActivityValue {
  tasks: TaskCard[]
  /** App currently being driven, or null when idle — powers the activity tile. */
  activeApp: AppKind | null
  /** Name of the tool running right now, or null — powers the thinking status. */
  activeTool: string | null
  /** Open a new task card for a turn about to be sent. Returns the card id. */
  beginTask: (title: string, kind: 'chat' | 'assigned') => string
}

const TaskActivityContext = createContext<TaskActivityValue | null>(null)

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

export function TaskActivityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tasks, setTasks] = useState<TaskCard[]>([])
  const [activeApp, setActiveApp] = useState<AppKind | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)

  // Id of the card currently accepting steps. A ref so IPC callbacks (registered
  // once) always read the latest value without re-subscribing.
  const currentIdRef = useRef<string | null>(null)

  /** Patch the card with `id`, leaving the rest of the list untouched. */
  const patchCard = useCallback((id: string, patch: (c: TaskCard) => TaskCard): void => {
    setTasks((prev) => {
      const i = prev.findIndex((c) => c.id === id)
      if (i === -1) return prev
      const next = prev.slice()
      next[i] = patch(next[i])
      return next
    })
  }, [])

  const beginTask = useCallback((title: string, kind: 'chat' | 'assigned'): string => {
    const id = newId()
    const card: TaskCard = {
      id,
      title: title.trim() || 'New task',
      status: 'in_progress',
      kind,
      steps: [],
      startedAt: Date.now()
    }
    currentIdRef.current = id
    setTasks((prev) => [...prev, card])
    setActiveApp(null)
    setActiveTool(null)
    return id
  }, [])

  /** Ensure there's a current card (lazily create one for external turns). */
  const ensureCard = useCallback((): string => {
    if (currentIdRef.current) return currentIdRef.current
    const id = newId()
    currentIdRef.current = id
    setTasks((prev) => [
      ...prev,
      { id, title: 'Background task', status: 'in_progress', kind: 'chat', steps: [], startedAt: Date.now() }
    ])
    return id
  }, [])

  useEffect(() => {
    // A step of the current card. Upsert by step id so status transitions
    // (pending → working → done/error) update the same row.
    const offTask = window.openui.onTask((step: TaskUpdatePayload) => {
      const cardId = ensureCard()
      patchCard(cardId, (c) => {
        const i = c.steps.findIndex((s) => s.id === step.id)
        const steps = c.steps.slice()
        if (i === -1) steps.push(step)
        else steps[i] = { ...steps[i], ...step }
        return { ...c, steps }
      })
    })

    // Which app is being driven right now — sets the card's icon and the tile.
    const offTool = window.openui.onToolCall(({ tool }) => {
      const kind = appKindForTool(tool)
      const cardId = ensureCard()
      patchCard(cardId, (c) => ({ ...c, currentApp: kind }))
      setActiveApp(kind)
      setActiveTool(tool)
    })

    const finalize = (status: 'done' | 'failed'): void => {
      const id = currentIdRef.current
      if (id) {
        patchCard(id, (c) => ({
          ...c,
          // A card with a failed step is a failed task even if the turn "completes".
          status: status === 'failed' || c.steps.some((s) => s.status === 'error') ? 'failed' : 'done',
          endedAt: Date.now()
        }))
      }
      currentIdRef.current = null
      setActiveApp(null)
      setActiveTool(null)
    }

    const offDone = window.openui.onDone(() => finalize('done'))
    const offError = window.openui.onError(() => finalize('failed'))
    // Turn boundary — the active-app tile should go idle between turns.
    const offReset = window.openui.onTaskReset(() => {
      setActiveApp(null)
      setActiveTool(null)
    })

    return () => {
      offTask()
      offTool()
      offDone()
      offError()
      offReset()
    }
  }, [ensureCard, patchCard])

  return (
    <TaskActivityContext.Provider value={{ tasks, activeApp, activeTool, beginTask }}>
      {children}
    </TaskActivityContext.Provider>
  )
}

export function useTaskActivity(): TaskActivityValue {
  const ctx = useContext(TaskActivityContext)
  if (!ctx) throw new Error('useTaskActivity must be used within a TaskActivityProvider')
  return ctx
}
