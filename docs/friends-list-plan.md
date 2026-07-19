# Friends list + audio volume + display-name fix + Contributors page — plan

## Context

Four asks bundled together in one session:

1. A **friends list** (add/search/view players, see online/offline activity) as a
   collapsible right-side panel mirroring the existing left `NavRail`.
2. **Volume sliders** (master / beeping / voice / game sounds) to replace the current
   ON/OFF audio toggles.
3. A **display-name bug**: the header pill (top-right) shows a different name than the
   Profile page / leaderboards for the same account.
4. A **Contributors page**, linked from the footer, styled like the Configure page's
   cards, showing each contributor's Discord avatar, in-game name/username (linking to
   their profile), Discord icon, and GitHub icon.

The main developer's note on process (verbatim, for the record): this session (Claude)
has no Fly.io secrets/deploy access. For any change that needs a DB migration, Claude
generates the `.sql` migration file in `server/db/migrations/`; the **main developer**
is the one who runs `flyctl deploy --remote-only`, which is what actually applies it to
the live Neon DB. **Do not run any deploy step — stop and tell the user when the plan
reaches that point**, per `docs/deploy.md`'s existing protocol.

Everything below is scoped to reuse existing patterns rather than invent new ones —
the codebase already has a `.ds-panel`/`.ds-opt` card system, a `rangeFill()` slider
helper, a `PlayerName`-style profile-link component, and an inline-SVG icon convention.

---

## 1. Friends list

### 1.1 Data model — new migration `server/db/migrations/0016_friends.sql`

Two tables, following the existing style (`text` user ids referencing `profiles`,
`if not exists` everywhere so it's safe to re-run):

```sql
-- pending requests only; deleted on accept/decline
create table if not exists friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user_id text not null references profiles(user_id) on delete cascade,
  to_user_id   text not null references profiles(user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (from_user_id, to_user_id)
);
create index if not exists friend_requests_to_idx on friend_requests(to_user_id);

-- accepted friendships, one row per UNORDERED pair (user_low < user_high avoids
-- storing A→B and B→A separately)
create table if not exists friendships (
  user_low  text not null references profiles(user_id) on delete cascade,
  user_high text not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  check (user_low < user_high)
);
create index if not exists friendships_high_idx on friendships(user_high);

-- last-seen for "Offline for 2d" style labels (see §1.3)
alter table profiles add column if not exists last_seen_at timestamptz;
```

`repo.ts` additions (mirroring existing functions like `setHandle`/`getProfile`):
`sendFriendRequest`, `respondFriendRequest` (accept → delete both possible request
rows + insert into `friendships` with `[min,max]` ordering; decline → delete row),
`removeFriend`, `listFriends(userId)` (join `friendships` either side → `profiles` for
handle/username), `searchUsersByUsername(prefix, limit)` (new, public-safe — see 1.4).

### 1.2 Server endpoints (`server/api.ts`), same Bearer-JWT pattern as `/api/user/handle`

```
GET  /api/friends                     — { friends, incoming, outgoing }  (Bearer)
POST /api/friends/request {username}  — resolve via getProfileByUsername, insert request
POST /api/friends/accept  {fromUserId}
POST /api/friends/decline {fromUserId}
POST /api/friends/remove  {friendUserId}
GET  /api/users/search?q=             — public, username-prefix, min 2 chars, limit 20
GET  /api/friends/status?ids=a,b,c    — online/offline for a set of user ids (§1.3)
POST /api/presence/ping               — Bearer; touches profiles.last_seen_at (§1.3)
```

Reject self-requests, duplicate requests, and requesting an existing friend server-side
(not just client-side) — same defensive posture as `updateUsername`'s 409 handling.

**Search should NOT reuse `searchProfiles`** (the existing admin-only substring-on-handle
search in `repo.ts`, wired into `Admin.tsx`) — that's fine for a moderator but a public
substring search over `handle` lets any/one enumerate every display name. `searchUsersByUsername`
should be a prefix match on the unique `username` column instead (`ilike 'q%'`), which is
the same public data already exposed one-at-a-time via `/api/profile/<username>`.

### 1.3 Online/offline status — the one real architectural decision here

Per the exploration in this session: **there is no existing "is this account currently
browsing the site" signal.** The header's "12 online" count (`server/index.ts`,
`onlineCount`/`authedUsers`) only counts sockets opened for lobby/queue/match — never for
someone sitting on Configure/Records/Profile — by deliberate design, to keep Fly's
auto-stop-to-zero model working (`server/index.ts:51-57`).

Recommended v1 model (extends that same polling pattern, not a standing socket):

- A tiny hook mounted once at the `AppShell` level (i.e. wherever the friends panel
  itself is mounted, see §1.5) calls `POST /api/presence/ping` every ~30s **only while
  signed in**. The server sets `profiles.last_seen_at = now()`.
- `GET /api/friends/status?ids=...` returns, per id: `online` (last_seen_at within ~45s)
  or `offline` + `last_seen_at` (client formats "Offline for 2d" the same way anywhere
  else in the app already formats relative time, if such a helper exists — else add one).
- This is intentionally coarse: it means "online" ≈ "has the app open somewhere," not
  "in a match." Richer sub-labels (screenshot shows "In Menu" / "In Match (4:12)") need
  the per-user activity tag to travel through the existing per-machine `presence` heartbeat
  (`0015_presence.sql`'s `authed jsonb` column) — doable as a **follow-up**: extend each
  authed entry from a bare user id to `{id, activity: 'lobby'|'queue'|'match'}`, but the
  exact match **timer** (`4:12`) would need room start-times threaded through too, which
  `room.ts` has in-memory per-machine but isn't in the cross-machine `presence` table today.
  **Recommend shipping v1 with just Online/Offline (+ last-seen), and treating the
  richer activity labels as a stretch goal** — flag this trade explicitly to your dev
  before they decide it's worth the extra plumbing.
- **"Do Not Disturb"**: cheapest to make this a manual, Discord-style status the player
  sets themselves (`profiles.status: 'online'|'dnd'|'invisible'|null`, null = automatic),
  not something inferred. Small addition to the same migration + a toggle in the panel.

### 1.4 Client: `src/net/api.ts` additions

`fetchFriends()`, `sendFriendRequest(username)`, `respondFriendRequest(fromUserId, accept)`,
`removeFriend(userId)`, `searchUsers(query)`, `fetchFriendsStatus(ids)`, `pingPresence()` —
same `getJson`/Bearer-JWT-fetch shape as the existing `updateHandle`/`fetchProfile` calls
right above them in that file.

### 1.5 Client: `FriendsPanel` component (mirrors `NavRail`, not `position: fixed`)

New `src/ui/FriendsPanel.tsx` + CSS added to `shell.css` next to `.ds-rail`. Structural
twin of `NavRail`/`.ds-rail`: a flex sibling (never `position:fixed` — `AppShell.tsx`'s
`.ds-body` is a flex row specifically so panels scroll with `.ds-app`, the app's one
scroll container), mirrored to the right side of `.ds-body`:

```tsx
// AppShell.tsx — .ds-body becomes a 3-way flex row when showRail is true
{showRail ? (
  <div className="ds-body">
    <NavRail active={active} onNav={onNav} showAdmin={showAdmin} />
    <main className="ds-main">{children}</main>
    <FriendsPanel onOpenProfile={onOpenProfile} />
  </div>
) : ( ... )}
```

`showRail` (already `screen !== 'home'` in `App.tsx`) is the exact same condition the
user described ("not on the home page") — reuse it verbatim rather than inventing a
second prop, so the two rails always agree about which screens show chrome.

- **Collapse/expand**: local `useState<boolean>` for expanded/collapsed, persisted to
  `localStorage['decodesim.friendsPanelOpen']` (device-level UI pref, same tier as
  `decodesim.theme` — NOT synced to the account, since it's just a layout choice).
  Collapsed state renders a slim icon-rail (a people/friends glyph button) at a fixed
  small width, same idea as `.ds-rail`'s width but the opposite edge; expanded renders
  the full list at ~240–260px.
- **Sections** (per the screenshot): "Online" (avatar + colored status dot + activity
  label), "Offline" (grayed avatar + "Offline for Xd"), an "Add friends" search box +
  results list, and incoming/outgoing request rows (Accept/Decline buttons on incoming).
- **Not signed in / auth disabled**: render a compact "Sign in to add friends" state,
  matching `AccountButton`'s / `Account.tsx`'s existing `IdentityDisabled` fallback
  rather than a bare empty panel.
- **Row component**: reuse the existing `PlayerName`-shaped pattern from
  `src/ui/Leaderboard.tsx` (handle + `@username`, click → `onOpenProfile(username)`) for
  every friend/search-result/request row instead of writing new profile-link logic —
  it's exactly "handle, username, click-through to profile" already.
- Search results and the friend list both link straight to `/profile/<username>` via the
  `openProfile()` plumbing that already exists in `App.tsx` (`navigate('profile', {username})`).

**Scope note on full-screen surfaces**: `game`/`lobby`/`matchmaking`/`record`/`duorecord`/
`replay` bypass `AppShell` entirely today (`App.tsx` early-returns before ever reaching
it), so the friends panel won't appear there without extra plumbing. Treat "every screen
except Home" as "every `AppShell`-wrapped screen" for v1 (Modes, Configure, Records,
Profile, Watch, Download, Account, Admin) — extending into live-match/lobby screens is a
separate, larger change (those screens intentionally own their own minimal chrome) and
should be its own follow-up if wanted.

---

## 2. Volume sliders (master / beeping / voice / game sounds)

Today there are only two booleans (`GameSettings.audio: { sounds, voice }`,
`src/types.ts:418-421`), and "beeping" (synthesized SFX) vs. "game sounds" (the FIRST
field-recording WAVs) are **not distinct categories anywhere** — both are gated by the
one `sounds` boolean in `src/audio.ts`. This is a real (small) refactor, not just a UI
change.

### 2.1 `src/types.ts` / `src/settings.ts`

```ts
audio: {
  master: number; // 0–1
  game: number;   // 0–1 — the 6 FIRST field-recording cues (start/end/resume/warning/...)
  sfx: number;    // 0–1 — synthesized shoot/intake/gate tones + countdown beep fallback
  voice: number;  // 0–1 — announcer speech; 0 substitutes the beep fallback, same as today
};
```

- `defaultSettings()`: `{ master: 1, game: 1, sfx: 1, voice: 1 }`.
- `coerceSettings()`: clamp each 0–1 (reuse the existing `clamp()` used for
  `parkSpeedPct`); **migrate the legacy boolean shape** so old saved settings don't
  reset to silent: if `s.audio.sounds`/`s.audio.voice` are booleans (no numeric fields
  present), map `true → 1` / `false → 0` onto `game`, `sfx`, and `voice` respectively,
  `master` defaults to `1`.

### 2.2 `src/audio.ts` (`MatchAudio`)

Replace `soundsEnabled`/`voiceEnabled` booleans with the four gain fields above.
Every hardcoded volume literal becomes `master * category * originalLiteral`:

- `play(cue)` (the 6 WAV cues, currently `a.volume = 0.55` fixed at construction) →
  set `a.volume` on each `play()` call to `masterVolume * gameVolume * 0.55` (was a
  static per-element `.volume`; now recomputed per play so slider changes apply live).
- `tone()`/`noiseBurst()` (feeds `sfxShoot`/`sfxIntake`/`sfxGate`/`beep`) → multiply the
  `vol` parameter by `masterVolume * sfxVolume` at each call site (or once, inside
  `tone`/`noiseBurst` themselves, since every caller already funnels through those two).
- `say()` → `u.volume = masterVolume * voiceVolume * 0.9`; keep the existing fallback
  behavior exactly (`voiceVolume === 0` ⇒ substitute `beep()` on `interrupt` calls, same
  as today's `!voiceEnabled` branch) so countdown timing/UX doesn't change.
- `ensureCtx()`/`muted` getter: full silence (skip creating an `AudioContext` at all)
  when `masterVolume === 0`, same early-out the current `muted` getter gives for `sounds:false`.

`src/game.ts:264-265` wiring becomes:
```ts
this.audio.masterVolume = settings.audio.master;
this.audio.gameVolume = settings.audio.game;
this.audio.sfxVolume = settings.audio.sfx;
this.audio.voiceVolume = settings.audio.voice;
```

### 2.3 `src/ui/AudioSection.tsx` — reuse the existing slider pattern, not a new one

The app already has a styled range input (`rangeFill()` in `src/ui/rangeFill.ts` +
`.ds-range` CSS + the `.ds-field`/`cap`/`val` markup used throughout `Menu.tsx` and
`ControlsSection.tsx` for every other numeric setting). Swap the two `.ds-opt` ON/OFF
buttons in the "Audio" `.ds-panel` for four sliders in that exact idiom:

```tsx
<label className="ds-field">
  <span className="cap">Master <span className="val">{Math.round(settings.audio.master * 100)}%</span></span>
  <input className="ds-range" type="range" min={0} max={100} step={5}
    value={settings.audio.master * 100} style={rangeFill(settings.audio.master * 100, 0, 100)}
    onChange={(e) => setAudio({ master: Number(e.target.value) / 100 })} />
</label>
```
...repeated for Game sounds / Beeping (SFX) / Voice lines, all inside the same
`.ds-panel` "Audio" card (no new card needed). Keep the existing hint text about voice
falling back to beeps when its slider is at 0%.

---

## 3. Display-name bug — root cause found and confirmed

**The header pill and the Profile page read the display name from two different, never-
synced sources.**

- `src/ui/AccountButton.tsx:39` — `<b>{user.name ?? user.email ?? 'Player'}</b>` — this is
  the **raw Neon Auth session name** (whatever was typed at sign-up, or the Google OAuth
  name) via `authClient.useSession()`. It is never updated after sign-up.
- `src/ui/Account.tsx`'s `DisplayName` component (the one the Profile screenshot shows)
  fetches the **app's own mutable `handle`** via `fetchProfile(userId)` — literally
  commented `// load the current handle from the server (may differ from the auth name)`
  (`Account.tsx:131`) — and that's what gets saved via `POST /api/user/handle` and shown
  on leaderboards/public profiles.

So the moment someone edits their display name in Profile (auth name "syun gin" → handle
"Fe"), the header pill keeps showing the stale auth name forever, because it was never
wired to `handle` at all. This matches the screenshots exactly (pill: "syun gin", public
profile header: "Fe").

### Fix

- Lift a small `handle: string | null` state into `App.tsx` alongside the existing
  `accountUserId` (`App.tsx:299`), populated by `fetchProfile(uid)` once per sign-in —
  same call `DisplayName` already makes, just hoisted up (or folded into `AccountSync`'s
  existing `onUser` callback, extending it to also deliver the fetched handle).
- Pass `handle` down to `AccountButton` and render `handle ?? user.name ?? user.email ??
  'Player'` instead of `user.name ?? ...` (`AccountButton.tsx:39`).
- Thread an `onSaved(handle)` callback down through `Account` → `Identity` →
  `DisplayName`, called right after `updateHandle()` resolves (`Account.tsx:156-159`), so
  the header updates **immediately** on save rather than waiting for next reload/refetch.

No DB/migration/server change needed — this is purely a client wiring fix.

---

## 4. Contributors page

### 4.1 Data source — new `src/contributors.ts`

No Discord OAuth or avatar data exists anywhere in this codebase (auth is Neon Auth only;
`server/auth.ts` has no Discord fields). A contributor's Discord avatar/links are **not**
derivable from the account system, so this needs a small hand-maintained static config,
cross-referenced with the existing `CONTRIBUTORS.md` (currently: Dohun Kim as owner, plus
4 pre-CLA contributors — Baron/@BaronClaps, Shaan Sridhara, testimonies, therealkingcob):

```ts
export interface Contributor {
  discordAvatarUrl: string;
  discordUrl: string;   // profile or invite link — clarify which with the team
  githubUrl: string;
  inGameUsername: string; // the ONLY thing used to look up their live handle — see below
}
export const CONTRIBUTORS: Contributor[] = [ /* filled in by hand */ ];
```

Someone (you, coordinating with each contributor) needs to collect each person's Discord
avatar URL, Discord link, GitHub link, and in-game `username` — this file is not
self-service and has to be updated by hand per new contributor, same as `CONTRIBUTORS.md`
already is today.

**Don't hardcode the display name** — the whole point of §3's fix is that `handle` is the
one source of truth and can change any time. The Contributors card should fetch each
person's *current* handle live via the existing `fetchProfileByUsername(username)` (same
call `Profile.tsx` already makes) at render time, so a contributor's card never goes
stale if they rename themselves later.

### 4.2 Route + footer wiring

- Add `'contributors'` to the `Screen` union in `App.tsx`, a `screenSuffix` case
  (`/contributors`), a `parseScreen` branch, and a render branch
  `{screen === 'contributors' && <Contributors onOpenProfile={openProfile} />}` inside
  the existing `AppShell` children block.
- **Do not** copy `Download`'s admin-only gate (`App.tsx:326-329`) — Contributors is public.
- `AppShell.tsx`'s footer (`.ds-foot-links`, line 108) gets a 4th entry next to
  Download/GitHub/Discord: a new `onContributors` prop mirroring the existing
  `onDownload` prop, wired the same way (`button` → `navigate('contributors')`).

### 4.3 Component + styling — reuse `.ds-panel` / `.ds-opt`, not `Admin.tsx`'s bespoke style

Per this session's research, "the configure page's box style" is `.ds-panel` (the
titled-card style used by `AudioSection`/`Configure`'s sections) and `.ds-opt` (the
individual card style already used for both toggle-buttons and `<a>` link-cards on
Download's "build it yourself" section) — **not** `Admin.tsx`'s one-off `.admin-card`
(different border-radius, no shared header bar, was built as its own thing).

`src/ui/Contributors.tsx`:
```tsx
<section className="ds-panel">
  <div className="ds-panel-h"><span className="ds-panel-title">Contributors</span></div>
  <div className="contributors-grid" style={{ padding: 16 }}>
    {CONTRIBUTORS.map((c) => <ContributorCard key={c.inGameUsername} {...c} onOpenProfile={onOpenProfile} />)}
  </div>
</section>
```
Each `ContributorCard` is an `.ds-opt`-styled block (new `.contributor-card` CSS
extending `.ds-opt`'s tokens — border, `--ds-block-sm` shadow, hover lift — added to
`shell.css`) laid out as: Discord avatar image (left, circular) — display name (button,
`onOpenProfile`) + `@username` underneath (both from the live `fetchProfileByUsername`
call, same `PlayerName`-shape as Leaderboard rows) — a small icon row underneath with the
Discord glyph and GitHub glyph (copy the exact inline `<svg fill="currentColor">` paths
from `src/ui/HomeMenu.tsx:78-88`, the only place these icons exist today — no icon
library in this codebase), each linking out via `c.discordUrl`/`c.githubUrl`.

Build everything from `--ds-*` tokens (per `CLAUDE.md`'s theming rule) so
`npm run contrast` stays green — check contrast on avatar-adjacent text and the icon
color against `--ds-panel` in both themes once built.

---

## Verification

- `npm test` after any `src/sim`/`src/config.ts`/`src/audio.ts` change (audio volume
  logic doesn't touch `sim/`, but `game.ts` wiring is worth a smoke pass regardless).
- `npm run build` (tsc strict + vite) before calling anything done.
- `npm run contrast` after adding the friends-panel and Contributors CSS (new tokens/text
  pairs).
- Manual pass via the `verify` skill (Electron) or `npm run dev`: sign in as two test
  accounts (two browser profiles), send/accept/decline a friend request, confirm status
  flips online/offline, confirm the header pill and Profile page now show the *same* name
  after an edit, drag all four volume sliders to 0/50/100 and confirm each category
  actually mutes independently (shoot SFX vs. match-start WAV vs. announcer voice), and
  click through a Contributors card into a live profile page.
- **Do not run `flyctl deploy`** — once the migration file + server endpoints are
  written, stop and hand off to the user so their main developer can deploy it.
