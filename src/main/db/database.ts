/**
 * database.ts — local SQLite store for OpenUI.
 *
 * Backs the authentication layer: the signed-in user's profile, their Supabase
 * auth tokens, and a short-lived cache of their subscription tier. The database
 * lives under Electron's per-user `userData` directory so it is isolated per OS
 * account and survives app restarts.
 *
 * PLATFORM / NATIVE MODULE: `better-sqlite3` is a native addon. Following the
 * same convention as `tools.ts`, it is loaded lazily through an indirect
 * `require()` (a variable argument) so that:
 *   1. electron-vite/rollup leaves it as a runtime require instead of trying to
 *      bundle the `.node` binary, and
 *   2. a missing / ABI-mismatched build surfaces as a friendly Error from
 *      `getDb()` rather than crashing the whole main process at import time.
 *
 * The binary must be built for the running Electron ABI — run
 * `npx electron-rebuild -f -w better-sqlite3` after `npm install`.
 */
import { app } from 'electron'
import { join } from 'path'

// ── minimal self-typed surface of better-sqlite3 ────────────────────────────
// We type only what we use rather than depend on @types/better-sqlite3, so the
// project typechecks and builds even when the native module is not installed.

interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteStatement {
  run(...params: unknown[]): RunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabase {
  prepare(source: string): SqliteStatement
  exec(source: string): void
  pragma(source: string): unknown
  close(): void
}

type SqliteConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => SqliteDatabase

/**
 * require() the first module name that resolves. The array argument means the
 * call is dynamic, so the bundler keeps it as a runtime require (the native
 * `.node` file is never pulled into the JS bundle).
 */
function requireOptional(names: string[]): unknown {
  const failures: string[] = []
  for (const name of names) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(name)
    } catch (err) {
      failures.push(`${name} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  throw new Error(
    `Could not load SQLite native module. Tried: ${failures.join(', ')}. ` +
      'Run `npm install` then `npx electron-rebuild -f -w better-sqlite3`.'
  )
}

let db: SqliteDatabase | null = null

/**
 * The schema is created once on first access. `IF NOT EXISTS` makes this
 * idempotent across restarts and across upgrades that re-run it.
 *
 * Token columns hold ciphertext when Electron's safeStorage is available (see
 * userRepo); they are typed BLOB-compatible TEXT and treated as opaque here.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  avatar_url    TEXT,
  tier          TEXT NOT NULL DEFAULT 'free',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_type    TEXT,
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_cache (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier          TEXT NOT NULL,
  cached_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
`

/**
 * Open (once) and return the SQLite handle. Lazily initialised so the native
 * module is only required when authentication is actually used, and so the
 * database path resolves after the app's userData directory exists.
 */
export function getDb(): SqliteDatabase {
  if (db) return db

  const Database = requireOptional(['better-sqlite3']) as SqliteConstructor
  const file = join(app.getPath('userData'), 'openui.db')

  const handle = new Database(file)
  // WAL gives better concurrency/durability; foreign_keys enforces the ON
  // DELETE CASCADE that ties tokens/subscription rows to their user.
  handle.pragma('journal_mode = WAL')
  handle.pragma('foreign_keys = ON')
  handle.exec(SCHEMA)

  db = handle
  return db
}

/** Close the database (used on app shutdown). Safe to call when never opened. */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
