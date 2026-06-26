import { mouse, keyboard, Button } from '@nut-tree-fork/nut-js'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// libnut provides synchronous native helpers for window title lookup
let libnut: { getActiveWindow: () => number; getWindowTitle: (h: number) => string } | null = null
try {
  libnut = require('@nut-tree-fork/libnut-win32') as typeof libnut
} catch {
  // non-Windows platforms ship different libnut variants; window title is omitted
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MouseMoveAction {
  type: 'mousemove'
  x: number
  y: number
  window: string
  timestamp: number
}

export interface MouseClickAction {
  type: 'mouseclick'
  x: number
  y: number
  button: 'left' | 'right'
  window: string
  timestamp: number
}

export interface KeypressAction {
  type: 'keypress'
  text: string
  timestamp: number
}

export interface DelayAction {
  type: 'delay'
  ms: number
  timestamp: number
}

export type RecorderAction = MouseMoveAction | MouseClickAction | KeypressAction | DelayAction

export interface Macro {
  name: string
  actions: RecorderAction[]
  createdAt: string
}

// ── Internal state ─────────────────────────────────────────────────────────────

let _recording = false
let _actions: RecorderAction[] = []
let _pollInterval: ReturnType<typeof setInterval> | null = null
let _lastX = -1
let _lastY = -1
let _startTime = 0

const MOVE_THRESHOLD_PX = 8
const POLL_INTERVAL_MS = 50

// ── Persistence ────────────────────────────────────────────────────────────────

function macrosPath(): string {
  return path.join(app.getPath('userData'), 'macros.json')
}

export function loadMacros(): Macro[] {
  try {
    const raw = fs.readFileSync(macrosPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Macro[]) : []
  } catch {
    return []
  }
}

function writeMacros(macros: Macro[]): void {
  fs.writeFileSync(macrosPath(), JSON.stringify(macros, null, 2), 'utf-8')
}

export function saveMacro(name: string, actions: RecorderAction[]): Macro {
  const macros = loadMacros()
  const existing = macros.findIndex((m) => m.name === name)
  const macro: Macro = { name, actions, createdAt: new Date().toISOString() }
  if (existing >= 0) macros[existing] = macro
  else macros.push(macro)
  writeMacros(macros)
  return macro
}

export function deleteMacro(name: string): boolean {
  const macros = loadMacros()
  const next = macros.filter((m) => m.name !== name)
  if (next.length === macros.length) return false
  writeMacros(next)
  return true
}

// ── Recording ──────────────────────────────────────────────────────────────────

function activeWindowTitle(): string {
  try {
    if (!libnut) return ''
    const handle = libnut.getActiveWindow()
    return libnut.getWindowTitle(handle) ?? ''
  } catch {
    return ''
  }
}

export function isRecording(): boolean {
  return _recording
}

export async function startRecording(): Promise<void> {
  if (_recording) return
  _recording = true
  _actions = []
  _startTime = Date.now()
  _lastX = -1
  _lastY = -1

  _pollInterval = setInterval(() => {
    if (!_recording) return
    void (async () => {
      try {
        const pos = await mouse.getPosition()
        const dx = Math.abs(pos.x - _lastX)
        const dy = Math.abs(pos.y - _lastY)
        if (dx > MOVE_THRESHOLD_PX || dy > MOVE_THRESHOLD_PX) {
          _actions.push({
            type: 'mousemove',
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            window: activeWindowTitle(),
            timestamp: Date.now() - _startTime,
          })
          _lastX = pos.x
          _lastY = pos.y
        }
      } catch {
        // transient nut-js errors during polling are non-fatal
      }
    })()
  }, POLL_INTERVAL_MS)
}

export async function stopRecording(): Promise<RecorderAction[]> {
  _recording = false
  if (_pollInterval !== null) {
    clearInterval(_pollInterval)
    _pollInterval = null
  }
  return [..._actions]
}

export function recordClickAction(x: number, y: number, button: 'left' | 'right' = 'left'): void {
  if (!_recording) return
  _actions.push({
    type: 'mouseclick',
    x,
    y,
    button,
    window: '',
    timestamp: Date.now() - _startTime,
  })
}

export function recordKeypressAction(text: string): void {
  if (!_recording) return
  _actions.push({
    type: 'keypress',
    text,
    timestamp: Date.now() - _startTime,
  })
}

// ── Playback ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function playRecording(actions: RecorderAction[]): Promise<void> {
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]

    // Replay timing gaps between actions, clamped to 2 s to avoid huge waits
    if (i > 0) {
      const gap = Math.min(action.timestamp - actions[i - 1].timestamp, 2000)
      if (gap > 0) await sleep(gap)
    }

    if (action.type === 'mousemove') {
      await mouse.setPosition({ x: action.x, y: action.y })
    } else if (action.type === 'mouseclick') {
      await mouse.setPosition({ x: action.x, y: action.y })
      await sleep(40)
      await mouse.click(action.button === 'right' ? Button.RIGHT : Button.LEFT)
    } else if (action.type === 'keypress') {
      await keyboard.type(action.text)
    } else if (action.type === 'delay') {
      await sleep(action.ms)
    }
  }
}
