# LAN / self-hosted servers — design

**Status: DESIGN ONLY. Nothing here is built.** Written 2026-09-11 on branch `perf-load`.

Decided with the owner: LAN matches are **unofficial** — never on a leaderboard, never rated —
but their **replays are still uploaded** for storage and data collection.

## Why this is a capacity feature, not just a convenience

Every room hosted on a team's own laptop is a room the Fly bill never sees. The capacity model
(`docs/capacity.md`) puts 1,000 concurrent players at ~700 rooms, ~63 cores of work and
~70–90 machines under today's one-process-per-machine topology. LAN is the only lever on the
table that reduces the population being served rather than serving it more efficiently — and
at a competition venue, where a whole team is on one network, it is also the lever with the
best latency story: a LAN room's RTT is ~1 ms against ~30–80 ms to the nearest Fly region.

## What already exists

Most of the plumbing is there, which is why this is worth doing.

| piece | state |
|---|---|
| a standalone server binary | **exists** — `npm run server:prod` runs the esbuild bundle `dist-server/index.js` on plain `node`; no `tsx`, no Docker |
| server runs without a database | **exists** — `DATABASE_URL` unset makes every persistence call a no-op and the game, lobby and matches keep working (`server/db/pool.ts`) |
| the client can point at another server | **exists** — `VITE_GAME_SERVER_URL` / `gameServerUrlWith` in `src/net/env.ts` |
| offline-first result upload with a retry backlog | **exists** — `src/net/practiceRuns.ts` + `pendingPracticeUploads()` |
| a results table that structurally cannot reach a leaderboard | **exists** — `practice_runs` (migration 0032) |

So the work is packaging, a server-address UI, and one new table. Not a new server.

## The trust boundary — the one real design problem

A self-hosted server is a machine its operator controls. Anything it reports about a match is,
from the cloud's point of view, client-authored data. Someone can trivially run a patched
server that reports a 900-point match.

`CLAUDE.md` already states the rule this has to obey: *"do not let anything competitive start
reading `user_activity`"*. The same reasoning applies here, and the repo already contains the
pattern that solves it.

**`practice_runs` is the precedent.** It is its own table, and `record_leaderboard` is a view
over `records` — so nothing written to it is reachable from any board, PB, rank or ELO query
*by construction*, not by convention. That is exactly what makes accepting a client-written row
safe at all. A LAN match must be stored the same way.

It is also self-policing where it is displayed: the replay viewer **re-simulates the input log**,
so a score that disagrees with its own replay contradicts itself on screen.

### Rules this imposes

1. **A LAN match may never write `records`, `ranked_*`, ELO, or any `record_leaderboard` source.**
   Enforce it in the schema (separate table) rather than in a `WHERE` clause someone can later
   refactor away.
2. **`sanitizeReplay` still applies.** `setups` reaches `createWorld`, so the container must be
   forced into a shape the sim can safely spawn regardless of where it came from.
3. **Do not credit `user_activity` from a LAN run** — or if it is credited, accept that
   games-played becomes forgeable, which is already the stated trade for `practice_runs`.
4. **The badge/supporter fields stay server-authored.** A LAN server must not be able to
   declare anybody an owner or a supporter.

## Upload path — client-side, not server-side

Two options were considered.

**(a) The LAN server uploads.** It would have to collect each player's Neon Auth JWT and forward
them, which means a new auth path, a new trust relationship, and handing player tokens to a box
the cloud has no reason to trust. Rejected.

**(b) Each client uploads its own copy.** Chosen. It reuses `practiceRuns.ts` wholesale: the
client already receives the full `matchResult` (result + replay) over the wire at match end, it
already knows how to store a run on the device and drain a backlog when a session appears, and
each player's own upload is authenticated as themselves by the existing token flow.

Consequences of (b), all of which the existing practice-run code already handles:

- **Device first, account second.** A LAN match at a venue with no internet still records
  locally and uploads later. This is the same guarantee solo practice already makes, and it is
  the whole reason the backlog drain exists.
- **Deduplication is required**, because every player in the room uploads the same match. The
  container needs a stable `matchId` (generate it on the LAN server at `finalizeMatch` and put
  it in the `matchResult` broadcast) so the cloud stores one row per match with a participant
  list, not four copies. A `UNIQUE` index on `(match_id)` with an upsert is the mechanism.
- **Disagreement is data.** If two clients upload the same `matchId` with different scores, that
  is worth keeping rather than resolving — it is the signal that one of them was patched. Store
  the first and log the conflict.

## Schema sketch

```sql
-- migration 00NN — unofficial LAN matches. Deliberately NOT joined to `records`.
create table lan_runs (
  id            bigserial primary key,
  match_id      text        not null unique,   -- minted by the hosting server
  game          text        not null,          -- 'decode' | 'chain'
  played_at     timestamptz not null default now(),
  uploaded_by   uuid        not null references profiles(id) on delete cascade,
  host_kind     text        not null,          -- 'lan' | 'selfhost'
  score         jsonb       not null,          -- as reported; never trusted
  participants  jsonb       not null,          -- names/teams as reported
  replay_id     bigint      references replays(id) on delete set null,
  sim_version   int         not null,
  balance_version int       not null
);
```

⚠️ **`replays.behaviour_version` must be populated** (see `CLAUDE.md`) or every stored LAN
replay reads back as `unstamped` and is refused by `replayPlayable` on every build.

Pruning: LAN runs need the same cap-and-sweep `practice_runs` has (`PRACTICE_KEEP`), and the
prune must **delete the pruned runs' replays** — a replay has no back-reference to its run, so
dropping rows alone leaks logs. Account deletion must sweep them for the same reason.

## Client UX

- A **"Connect to a server"** field (address + port), remembered per device. Not in
  `GameSettings` — that syncs to Postgres per account, and a LAN address is a property of
  *where you are*, not *who you are*. Same reasoning as the theme pref living in its own
  `localStorage` key.
- A persistent, unmissable **"LAN — unofficial, not ranked"** banner whenever connected to a
  non-official server. This must be impossible to confuse with a ranked match; someone who
  thinks they are climbing a leaderboard and is not has been actively misled.
- Match results screen says **"Saved to your account as an unofficial match"** and, when
  offline, **"Will upload when you're back online"** — reusing the practice-run copy.

## Server packaging

- Ship `dist-server/` in the **Electron desktop build** with a "Host a LAN game" button. The
  desktop shell is already a thin wrapper and already bundles a `dist`; adding the server bundle
  is a build-config change, not new code.
- Print the LAN address and a join code on screen. A host behind a firewall is the most likely
  support issue, so the host UI should show whether the port is actually reachable rather than
  leaving people to guess.
- **Do not attempt NAT traversal or public self-hosting in v1.** LAN is a bounded, testable
  problem; "host a public server" invites port-forwarding support load and a moderation question
  (public server lists) that nobody has asked for yet.

## Open questions for the owner

1. **Should a LAN match count toward games-played?** Forgeable if yes (see rule 3). Recommend
   **no** for v1 — the data collection goal is served by the replay itself.
2. **Do LAN runs count against the same 10-run keep cap as practice runs, or get their own?**
   Recommend their own cap, since a team scrimmaging all day will generate many.
3. **Anonymous LAN play** — should a signed-out player be able to join a LAN room? Recommend
   yes (it is the practice-mode guarantee), with the run stored on that device only and uploaded
   if they later sign in.

## Suggested order of work

1. `matchId` minted at `finalizeMatch` and carried in `matchResult` — harmless on its own, and
   every later step needs it. Protocol-additive, so older clients ignore it.
2. Migration + `lan_runs` repo functions + `dbtest` coverage (the prune, the cascade, the
   dedup upsert).
3. Client server-address field + the unofficial banner + `uiaudit` green.
4. Upload path reusing `practiceRuns.ts`.
5. Electron "Host a LAN game" packaging.

Steps 1–2 are independent of the UI and can land first.
