/**
 * workflows.ts — Team/Shared Workflow persistence and I/O.
 *
 * Workflows are saved locally to <userData>/workflows.json and can be exported
 * to / imported from arbitrary file paths via Electron's native save/open
 * dialogs. The format is intentionally portable (plain JSON) so teams can
 * commit workflow files to source control and share them.
 */
import { dialog, app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A single tool invocation inside a workflow. */
export interface WorkflowStep {
  tool: string
  args: Record<string, unknown>
}

/**
 * A named, sharable automation sequence. `trigger` is a human-readable
 * description of when to run it (e.g. "Every Monday morning"). The agent
 * interprets it; OpenUI does not schedule it automatically.
 */
export interface Workflow {
  name: string
  description: string
  trigger: string
  steps: WorkflowStep[]
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function workflowsPath(): string {
  return join(app.getPath('userData'), 'workflows.json')
}

async function loadWorkflows(): Promise<Workflow[]> {
  try {
    const raw = await readFile(workflowsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Workflow[]) : []
  } catch {
    return []
  }
}

async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  await writeFile(workflowsPath(), JSON.stringify(workflows, null, 2), 'utf-8')
}

function isValidWorkflow(w: unknown): w is Workflow {
  if (typeof w !== 'object' || w === null) return false
  const obj = w as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name.trim()) return false
  if (typeof obj.description !== 'string') return false
  if (typeof obj.trigger !== 'string') return false
  if (!Array.isArray(obj.steps)) return false
  for (const step of obj.steps as unknown[]) {
    if (typeof step !== 'object' || step === null) return false
    const s = step as Record<string, unknown>
    if (typeof s.tool !== 'string' || !s.tool.trim()) return false
    if (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args)) return false
  }
  return true
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Return all locally saved workflows. */
export async function getWorkflows(): Promise<Workflow[]> {
  return loadWorkflows()
}

/**
 * Open a native save dialog and write the workflow to the chosen path.
 * Returns `{ ok: true }` on success or `{ ok: false, error }` on cancel/failure.
 */
export async function exportWorkflow(workflow: Workflow): Promise<{ ok: boolean; error?: string }> {
  const safeName = workflow.name.replace(/[^A-Za-z0-9_-]/g, '_')
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export Workflow',
    defaultPath: `${safeName}.workflow.json`,
    filters: [{ name: 'Workflow files', extensions: ['json'] }]
  })
  if (canceled || !filePath) return { ok: false, error: 'Cancelled' }

  try {
    await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Open a native open dialog (when `filePath` is omitted), read + validate the
 * chosen file, then upsert it into the local workflows store.
 */
export async function importWorkflow(
  filePath?: string
): Promise<{ ok: boolean; workflow?: Workflow; error?: string }> {
  let targetPath = filePath
  if (!targetPath) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import Workflow',
      filters: [{ name: 'Workflow files', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths[0]) return { ok: false, error: 'Cancelled' }
    targetPath = filePaths[0]
  }

  let raw: string
  try {
    raw = await readFile(targetPath, 'utf-8')
  } catch (err) {
    return {
      ok: false,
      error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'Invalid JSON in workflow file.' }
  }

  if (!isValidWorkflow(parsed)) {
    return {
      ok: false,
      error:
        'File does not contain a valid workflow. ' +
        'Expected: { name, description, trigger, steps: [{ tool, args }] }.'
    }
  }

  const workflows = await loadWorkflows()
  const idx = workflows.findIndex((w) => w.name === parsed.name)
  if (idx >= 0) {
    workflows[idx] = parsed
  } else {
    workflows.push(parsed)
  }
  await saveWorkflows(workflows)

  return { ok: true, workflow: parsed }
}

/**
 * Delete a workflow by name from local storage.
 */
export async function deleteWorkflow(name: string): Promise<{ ok: boolean; error?: string }> {
  const workflows = await loadWorkflows()
  const filtered = workflows.filter((w) => w.name !== name)
  if (filtered.length === workflows.length) {
    return { ok: false, error: `Workflow "${name}" not found.` }
  }
  await saveWorkflows(filtered)
  return { ok: true }
}

/**
 * Look up a workflow by name — used by the `run_workflow` tool to hand back
 * the step list to the agent for sequential execution.
 */
export async function findWorkflow(
  name: string
): Promise<{ ok: boolean; workflow?: Workflow; error?: string }> {
  const workflows = await loadWorkflows()
  const workflow = workflows.find((w) => w.name === name)
  if (!workflow) return { ok: false, error: `Workflow "${name}" not found.` }
  return { ok: true, workflow }
}
