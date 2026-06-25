/**
 * db.ts — SQLite persistence for users, conversations, and messages.
 *
 * better-sqlite3 is lazy-loaded via require() so the bundle typechecks and
 * builds even when the native package is absent (e.g. before electron-rebuild).
 * When unavailable, every function falls back to in-memory Maps/arrays — the
 * app works for the session but data does not survive a restart.
 *
 * To enable persistence: npm install better-sqlite3 && npx electron-rebuild
 */
import { app } from 'electron'
import { join } from 'node:path'

export interface UserRow {
  id: string
  email: string
  name: string
  avatar_url: string
  auth_token: string
  tier: string
  tier_cached_at: number
  created_at: number
}

export interface MessageRow {
  id: string
  conversation_id: string
  user_id: string
  role: string
  content: string
  created_at: number
}

export interface ConversationRow {
  id: string
  user_id: string
  title: string
  created_at: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any = null
let dbInitialized = false

const inMemoryUsers = new Map<string, UserRow>()
const inMemoryMessages: MessageRow[] = []
const inMemoryConversations = new Map<string, ConversationRow>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openDatabase(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sqlite3 = require('better-sqlite3')
    const dbPath = join(app.getPath('userData'), 'openui.db')
    const instance = new Sqlite3(dbPath) as { exec: (sql: string) => void; prepare: (sql: string) => unknown }
    instance.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        auth_token TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL DEFAULT 'free',
        tier_cached_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New conversation',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, created_at DESC);
    `)
    return instance
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDb(): any {
  if (!dbInitialized) {
    dbInitialized = true
    db = openDatabase()
  }
  return db
}

// ── User CRUD ────────────────────────────────────────────────────────────────

export function dbGetUser(id: string): UserRow | null {
  const d = getDb()
  if (d) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (d.prepare('SELECT * FROM users WHERE id = ?').get(id) as any) ?? null
  }
  return inMemoryUsers.get(id) ?? null
}

export function dbUpsertUser(user: UserRow): void {
  const d = getDb()
  if (d) {
    d.prepare(`
      INSERT INTO users (id, email, name, avatar_url, auth_token, tier, tier_cached_at, created_at)
      VALUES (@id, @email, @name, @avatar_url, @auth_token, @tier, @tier_cached_at, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, name=excluded.name, avatar_url=excluded.avatar_url,
        auth_token=excluded.auth_token, tier=excluded.tier, tier_cached_at=excluded.tier_cached_at
    `).run(user)
  } else {
    inMemoryUsers.set(user.id, user)
  }
}

export function dbUpdateUserTier(id: string, tier: string): void {
  const now = Date.now()
  const d = getDb()
  if (d) {
    d.prepare('UPDATE users SET tier = ?, tier_cached_at = ? WHERE id = ?').run(tier, now, id)
  } else {
    const u = inMemoryUsers.get(id)
    if (u) inMemoryUsers.set(id, { ...u, tier, tier_cached_at: now })
  }
}

// ── Message persistence ──────────────────────────────────────────────────────

export function dbSaveMessage(msg: MessageRow): void {
  const d = getDb()
  if (d) {
    d.prepare(`
      INSERT OR IGNORE INTO messages (id, conversation_id, user_id, role, content, created_at)
      VALUES (@id, @conversation_id, @user_id, @role, @content, @created_at)
    `).run(msg)
  } else {
    inMemoryMessages.push(msg)
  }
}

export function dbGetConversationMessages(conversationId: string): MessageRow[] {
  const d = getDb()
  if (d) {
    return d.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as MessageRow[]
  }
  return inMemoryMessages.filter((m) => m.conversation_id === conversationId)
}

// ── Conversation CRUD ────────────────────────────────────────────────────────

export function dbUpsertConversation(conv: ConversationRow): void {
  const d = getDb()
  if (d) {
    d.prepare(`
      INSERT OR IGNORE INTO conversations (id, user_id, title, created_at)
      VALUES (@id, @user_id, @title, @created_at)
    `).run(conv)
  } else {
    inMemoryConversations.set(conv.id, conv)
  }
}

export function dbGetRecentConversations(userId: string, limit = 20): ConversationRow[] {
  const d = getDb()
  if (d) {
    return d.prepare(
      'SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as ConversationRow[]
  }
  return [...inMemoryConversations.values()]
    .filter((c) => c.user_id === userId)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit)
}
