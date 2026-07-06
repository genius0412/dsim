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

/**
 * WebRTC ICE servers. STUN discovers each peer's public address; TURN RELAYS
 * media when a direct path is blocked (symmetric/carrier-grade NAT, some
 * corporate/mobile networks) — WITHOUT it those peers never connect and the
 * lockstep match freezes at WAITING.
 *
 * Default TURN is Metered's public "Open Relay" — FREE, no signup, best-effort
 * (fine for practice; can be rate-limited under load). Override with your own
 * (Metered's free 50 GB/mo tier gives dedicated creds, or self-host coturn) via
 * VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL — a comma-separated
 * VITE_TURN_URL adds several transports (udp/tcp/tls) for the widest reach.
 */
const OPEN_RELAY: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

/** synchronous ICE config: free Open Relay by default, or a STATIC TURN
 * credential pair from env. NOTE: a static credential shipped in the bundle can
 * be extracted and used to relay someone else's traffic (bandwidth theft,
 * bounded by your quota) — it is NOT an account secret, but for a secret-free
 * setup prefer VITE_TURN_ICE_URL (ephemeral creds) below. NEVER put a provider
 * API *secret* in a VITE_ var — Vite inlines those into the client bundle. */
export function iceServers(): RTCIceServer[] {
  const url = import.meta.env.VITE_TURN_URL as string | undefined;
  if (!url) return OPEN_RELAY;
  const urls = url
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls,
      username: (import.meta.env.VITE_TURN_USERNAME as string | undefined) ?? '',
      credential: (import.meta.env.VITE_TURN_CREDENTIAL as string | undefined) ?? '',
    },
  ];
}

/**
 * Preferred, SECRET-FREE TURN: if VITE_TURN_ICE_URL is set, fetch ICE servers
 * from it at runtime. That endpoint (e.g. Metered's credentials API, keyed by a
 * PUBLIC api key, or your own serverless function holding the secret) mints
 * SHORT-LIVED credentials — so no long-lived secret ever ships to the browser,
 * and a leaked ephemeral credential simply expires. Falls back to the sync
 * config on any failure so a bad endpoint never breaks connectivity.
 */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  const url = import.meta.env.VITE_TURN_ICE_URL as string | undefined;
  if (!url) return iceServers();
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ICE endpoint ${res.status}`);
    const data: unknown = await res.json();
    const servers = Array.isArray(data)
      ? (data as RTCIceServer[])
      : ((data as { iceServers?: RTCIceServer[] }).iceServers ?? []);
    if (Array.isArray(servers) && servers.length) return servers;
    throw new Error('ICE endpoint returned no servers');
  } catch (e) {
    console.warn('[net] TURN ICE fetch failed, using static config', e);
    return iceServers();
  }
}

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
