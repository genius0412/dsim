/**
 * Game-server config, read from Vite env (baked in at build time on Vercel + in
 * the Electron build). When absent, the Multiplayer entry is hidden and the solo
 * game is completely unaffected — there is no runtime network dependency.
 *
 * Phase 0 replaced the P2P stack (Supabase Realtime lobby + WebRTC mesh + TURN)
 * with a single authoritative game server, so this collapses to one URL. Point
 * it at the `server/` package (default ws://localhost:8787 in dev; a Fly.io wss://
 * URL in prod).
 */

const GAME_SERVER = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;

export const gameServerConfigured = (): boolean => !!GAME_SERVER;

export const gameServerUrl = (): string => GAME_SERVER ?? '';
