# Multiplayer (Phase D) — WebRTC lockstep over a Supabase lobby

Real-people 1–4 human multiplayer (up to 2v2). Empty slots spawn no robot. The
sim core is unchanged and authoritative on every peer; only **inputs** cross the
wire. Chromium-family browsers only in v1 (Chrome/Edge/Electron) — float
determinism is not guaranteed cross-engine, and a live checksum makes any
divergence visible.

## How it fits together (`src/net/`)

| File | Role |
|---|---|
| `env.ts` | Reads `VITE_SUPABASE_URL` + the new `VITE_SUPABASE_PUBLISHABLE_KEY` (legacy `VITE_SUPABASE_ANON_KEY` accepted as fallback). `supabaseConfigured()` gates the whole feature; absent ⇒ Multiplayer hidden, solo untouched. |
| `protocol.ts` | Quantizes each `RobotCommand` to 4 bytes (3 int8 axes + button bits) **at the producer**, and the producer steps that same dequantized value locally, so every peer feeds its sim identical inputs. Binary command packets; JSON control messages (start / restart / checksum / bye). |
| `checksum.ts` | `worldHash(world)` — FNV-1a over rounded robot poses, ball positions, scores, `rngState`, tick. Rounding lives ONLY here. |
| `lockstep.ts` | Input-delay buffer. Local input for tick T is scheduled at `T + INPUT_DELAY` (8 ticks ≈ 66 ms) and sent immediately; `canStep(T)` is true once every connected robot has T. A disconnected robot drops from the wait-set and runs on `ZERO_CMD`. |
| `lobby.ts` | `SupabaseLobby` — one Realtime channel per room code (presence + broadcast, no tables). Host = lexicographically smallest `peerId`. Relays WebRTC SDP/ICE and the host's start/restart. |
| `mesh.ts` | `RtcMesh` — full mesh ≤4 peers, lower id offers, one ordered+reliable DataChannel per link, STUN only (no TURN in v1). |
| `session.ts` | `NetSession` — ties mesh + lockstep + host authority. The only object `GameController` consumes; `null` ⇒ solo path is bit-identical. |

`GameController` drives the fixed-timestep loop through the session in
multiplayer: `produce()` authors + sends local inputs `INPUT_DELAY` ahead, then
it drains sim steps only while `canStep(tick)` holds (a stall shows `WAITING ·
<driver>`), running `checkpoint()` every 120 ticks to compare hashes (mismatch ⇒
`DESYNC` chip). The match world is built from the host's `matchStart{seed,
setups}` and starts immediately (no controller-local seed/countdown). Restart is
host-authored.

## Setup

1. Create a free Supabase project. Under **Settings → API Keys**, copy the
   Project URL and the **publishable key** (`sb_publishable_…`). Do NOT use the
   secret key — it must never ship in a client bundle, and this app doesn't need
   it.
2. `cp .env.example .env` and fill in `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_PUBLISHABLE_KEY`. Restart `npm run dev`.
3. On Vercel, add the same two env vars (Project → Settings → Environment
   Variables) and redeploy. For Electron, export them before `npm run dist`.

When the vars are present the menu shows **MULTIPLAYER (2v2)**.

## Manual 2-tab verification checklist

WebRTC loops back fine between two tabs on one machine.

- [ ] `npm run dev`, open two tabs on `localhost:5173`.
- [ ] Both: MULTIPLAYER → same room code (e.g. `TEST1`) → CREATE / JOIN. Each
      tab appears in the other's driver list; the link dot turns green.
- [ ] Pick alliances, READY UP in both. Host tab's **START MATCH** unlocks.
- [ ] Host starts. Both drop into the field on the same seed/motif; each drives
      only its own robot; the other robot mirrors its peer's inputs smoothly.
- [ ] Play ~30 s. The `NET`/checksum stays quiet (no `DESYNC` chip).
- [ ] Freeze one tab (DevTools → pause) briefly: the other shows `WAITING ·
      <driver>` and halts at the same tick, then catches up on resume.
- [ ] Close one tab mid-match: the other keeps running; the gone robot goes idle
      (ZERO_CMD), no desync.
- [ ] Host presses restart: both rebuild on a new seed together.
- [ ] Repeat with an Electron window joining a browser tab (same room code).

If a link never turns green across different machines/networks, that is the
no-TURN limitation — try the same LAN; TURN is a later config-only retrofit.
