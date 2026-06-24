/**
 * client.ts — the single Supabase client used by the Electron main process.
 *
 * SECURITY: this client is created with the Supabase **anon** (publishable) key
 * ONLY. The anon key is safe to ship in a desktop app — it grants nothing beyond
 * what Row Level Security and Edge Function logic allow. The Supabase
 * **service-role** key and the **Stripe secret key** are NEVER present in the
 * Electron app; they live only in Supabase Edge Function secrets, where all
 * privileged Stripe/admin operations happen. The app only ever:
 *   • invokes Edge Functions (`functions.invoke`), and
 *   • reads the signed-in user's own claims (`auth.getUser`).
 */
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

/** True when SUPABASE_URL and SUPABASE_ANON_KEY are both configured. */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
}

/**
 * Lazily create (and memoise) the Supabase client. Throws a clear error if the
 * app is misconfigured so callers can degrade gracefully (fall back to cache).
 *
 * `persistSession: false` because the Electron main process has no browser
 * storage; the auth feature is responsible for restoring a session at startup
 * via `setSupabaseSession()`.
 */
export function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY (anon key only).'
    )
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    })
  }
  return client
}

/**
 * Attach a logged-in user's session to the client so `auth.getUser()` returns
 * that user and `functions.invoke()` carries their JWT. The auth feature calls
 * this after a successful sign-in (and on token refresh).
 */
export async function setSupabaseSession(session: Session): Promise<void> {
  await getSupabase().auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token
  })
}

/** Drop the current session (e.g. on sign-out). */
export async function clearSupabaseSession(): Promise<void> {
  if (client) await client.auth.signOut({ scope: 'local' })
}
