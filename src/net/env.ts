import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase config, read from Vite env (baked in at build time on Vercel + in
 * the Electron build). When absent, the Multiplayer entry is disabled and the
 * solo game is completely unaffected — there is no runtime network dependency.
 *
 * Uses Supabase's NEW API-key system: the PUBLISHABLE key (`sb_publishable_…`)
 * is the client-safe replacement for the legacy `anon` key and is the only key
 * that may ship in the browser bundle. The SECRET key (`sb_secret_…`) must
 * NEVER be a `VITE_*` var — Vite inlines those into the client, which would leak
 * it — and this client-only app has no use for it (no server, no RLS bypass).
 * The legacy `VITE_SUPABASE_ANON_KEY` is still accepted as a fallback.
 */

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = (): boolean => !!URL && !!KEY;

let client: SupabaseClient | null = null;

/** the shared Supabase client, or null if not configured */
export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured()) return null;
  if (!client) {
    client = createClient(URL as string, KEY as string, {
      realtime: { params: { eventsPerSecond: 20 } },
      auth: { persistSession: false },
    });
  }
  return client;
}
