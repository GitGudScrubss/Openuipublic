/**
 * planner.ts — the PLANNING stage of the interactive agent (Milestone 1).
 *
 * The old behaviour was a purely reactive loop: the model emitted one tool,
 * saw the result, then reasoned about the next — so the user only ever saw the
 * task list grow "one out of one". This module adds an explicit planning pass:
 * before executing anything, we ask the model to decompose a task-shaped request
 * into a short ordered checklist. handleChat then shows the WHOLE checklist up
 * front, gets a single approval, and drives the executor to completion — ticking
 * steps off as it goes.
 *
 * The plan is deliberately tool-agnostic prose (not tool JSON): it's a
 * human-readable checklist. The executor (agent.ts) is what maps each step to
 * concrete tool calls and checks it off via the `complete_step` checkpoint.
 */
import type { BrowserWindow } from 'electron'
import { callModel, extractFirstJsonObject, type Message } from './agent'
import type { Tier } from './tools'

/** A fully-formed plan: a one-line goal plus an ordered list of step titles. */
export interface Plan {
  summary: string
  steps: string[]
}

/** Upper bound on plan size — keeps the checklist scannable and the loop bounded. */
const MAX_STEPS = 8

/**
 * Cheap gate deciding whether a message is worth a planning pass at all. Plain
 * conversation and simple questions ("hi", "what's the weather?") skip planning
 * entirely and take the fast reactive path. False positives are harmless:
 * generatePlan returns null for anything that doesn't decompose into ≥2 steps,
 * so at worst we spend one extra model call.
 */
const TASK_RE =
  /\b(open|launch|start|close|quit|send|message|whatsapp|email|schedule|book|find|search|locate|clean|empty|recycle|delete|remove|move|copy|rename|download|install|navigate|browse|go to|fill|log ?in|sign ?in|create|make|set ?up|play|pause|screenshot|record|reopen|restore|debug|deploy|organi[sz]e|reply|draft|compose)\b/i
const SEQ_RE = /\b(then|after that|and then|first|next|finally|afterwards)\b|;/i

export function looksLikeTask(message: string): boolean {
  const m = message.trim()
  if (!m) return false
  return TASK_RE.test(m) || SEQ_RE.test(m)
}

const PLANNER_SYSTEM_PROMPT = `You are the PLANNING stage of OpenUI, an AI assistant that automates a user's computer (opening apps, browsing the web, searching files, sending messages, editing the calendar, cleaning up files, and so on).

Your ONLY job right now is to break the user's request into a short ordered checklist of concrete steps OpenUI will perform. Do NOT perform anything and do NOT emit tool calls — just the plan.

Respond with ONLY a raw JSON object — no prose before/after, no markdown code fences:
{"summary": "<one short sentence naming the goal>", "steps": ["<step 1>", "<step 2>", ...]}

Rules:
- Each step is a short imperative phrase a person could tick off (≤ 12 words).
- Use 2 to ${MAX_STEPS} steps. Order them by dependency (a step that needs a previous result comes later). Merge trivial actions; never pad.
- Prefer opening a DESKTOP app over its website when both exist (e.g. WhatsApp Desktop before WhatsApp Web).
- If the request is a single trivial action, or is just conversation / a question that needs no computer actions, return {"summary": "", "steps": []}.`

/**
 * Ask the model to decompose `message` into an ordered plan. Returns a Plan only
 * when the request genuinely needs ≥2 steps; otherwise null (the caller then
 * falls back to the normal single-loop path).
 *
 * The planning tokens are NOT streamed to the chat UI — we pass a discarding
 * onDelta so the user sees the finished checklist (via the task list), not the
 * raw JSON being generated.
 */
export async function generatePlan(
  win: BrowserWindow,
  tier: Tier,
  message: string
): Promise<Plan | null> {
  const messages: Message[] = [{ role: 'user', content: message }]
  // Discard streamed tokens: planning output is structural JSON, never shown.
  const raw = await callModel(win, tier, messages, PLANNER_SYSTEM_PROMPT, () => {})

  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  const steps = Array.isArray(obj.steps)
    ? obj.steps
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_STEPS)
    : []

  if (steps.length < 2) return null
  return { summary: summary || 'Task plan', steps }
}
