# Writing patch notes

How a release gets told to the people who play it. Read this before writing one; the
constraints in §2 are not style preferences, they are what the renderer and the schema
actually accept, and the rules in §4 are the ones that were learned by getting them wrong.

---

## 1. Where a patch note lives

**Patch notes are DATABASE ROWS, not files in this repo.** There is no `CHANGELOG.md` and
adding one would create a second place to look.

`announcements` (migration `0008`) holds every one, with `kind` = `'patch'` | `'season'` |
`'act'`. Players read them in two places, both fed by the same rows:

- **`Announcements.tsx`** — the one-time "What's New" modal. Shows only the last few
  **unseen** items, then never again. This is where a note is actually read.
- **`Changelog.tsx`** — the full feed at `/changelogs`, newest first, reached from the
  footer's "Changes". This is where a note is looked *up*.

Write for the first and it works in the second.

### Publishing

Through **`/admin`** → the announcements panel, or directly:

`POST /api/admin/announcement` with `{kind, title, body, tagline}` — admin JWT, or
`?secret=$ADMIN_SECRET`. `POST /api/admin/announcement/delete?id=…` retires one (it sets
`active` false; the row survives).

⚠️ **It goes to EVERY player the moment it is published.** There is no draft state and no
preview. Write it in a file, read it once more, then post it.

⚠️ **A patch note is a SERVER-side row, so it is live the instant it is posted — including
to clients running the OLD build.** Publish it *after* the deploy it describes, never before,
or the first people to read it go looking for things that are not there yet.

### Fields

| field | patch notes |
|---|---|
| `kind` | `'patch'` |
| `title` | the game and what this is — `DECODE · Act 2` |
| `body` | the note itself, Markdown (§2) |
| `tagline` | **leave empty.** It drives the cinematic season/act reveal; a patch note has no reveal, and a tagline on one just prints a stray line. |

**One note per GAME, not one per release.** DECODE and Chain Reaction have separate
boards, separate seasons and mostly separate players; a combined note makes each of them
read half a page that is not about their game. Shared changes (driving, ranked, the app
itself) get a short section in **both**, written from that game's point of view.

---

## 2. The Markdown you may actually use

`src/ui/markdown.tsx` is a hand-written renderer, not a library — the client bundle is
React + Rapier and nothing else. It renders to React elements rather than
`dangerouslySetInnerHTML`, so an admin-authored body has no HTML-injection surface, and the
cost of that is a small subset:

- `#` … `######` headings
- paragraphs, blank-line separated
- `-` `*` `•` `+` bullets, `1.` / `1)` ordered, **nested by two-space indent**
- `**bold**`, `*italic*`, `` `inline code` ``
- `[label](https://url)` — http(s) and mailto only, everything else is dropped
- `---` horizontal rule

**Anything else renders as its literal text.** That means no tables, no code fences, no
images, no blockquotes, no footnotes, no raw HTML. A table pasted into a note shows up as
a wall of pipes.

---

## 3. Deriving the content

Read `git log --no-merges origin/main..origin/alpha` and group by what a DRIVER notices,
not by subsystem. The commit prefixes (`goal:`, `intake:`, `fouls:`, `chain:`, `sim:`) are
a good first sort, but they are the author's mental model, not the player's — thirty
`goal:` commits are one line in the note: *the gate behaves like a hinged lever now*.

Three tests for whether a change belongs in the note at all:

1. **Would a player notice it without being told?** If yes, it goes in — that is the
   whole point. If it is invisible, leave it out however hard it was.
2. **Would a player be CONFUSED if not told?** Anything that moves a score, a rank, a
   record or a replay goes in even when it is technically invisible. This is the category
   that gets forgotten and causes the support questions.
3. **Is it actually shipping?** A feature behind a flag that is off in this build does not
   exist yet. LAN play is the live example: it is finished, it runs on alpha, and it is
   gated off for production (`VITE_LAN_ENABLED` / `LAN_UPLOADS`, see `.env.example`), so it
   must not appear in a production note. Announcing it would advertise a mode the build
   does not have.

---

## 4. The rules that matter

### Lead with what it COSTS the player

The reflex is to open with the best new feature. Open instead with anything that takes
something away or resets it, because that is what they will notice first and it is the
only part that can make them feel lied to.

For this codebase, three things are always in that category:

- **A `BALANCE_VERSION` bump retires every older replay.** Say so plainly, and say that the
  records themselves are untouched — the server stored the score it computed at the time and
  never re-derives it from the replay, so the leaderboard is unaffected. People assume a
  dead replay link means a lost record.
- **An ACT reset wipes ranked ratings.** A new SEASON inside the same act does not (see
  migration `0013_elo_by_act`). These are different events and the note has to use the right
  word for which one happened.
- **A physics change moves scores.** If head-to-head outcomes or record runs move, say that
  out loud rather than letting somebody discover it against an old personal best.

### Say what changed, not that work happened

"Improved gate physics" tells a driver nothing. "A tap on the gate is worth four to nine
artifacts depending on how the column is packed, instead of a fixed dose" tells them how to
play. Give the number wherever there is one — this project measures everything, so there
usually is.

### The house copy rules apply, and CLAUDE.md owns them

Do not restate them here; they drift. The ones that catch people writing notes:

- **Typographic punctuation.** `’` `“` `”` `…`, never the ASCII ones.
- ⚠️ **Prefer a full stop or a colon to a dash.** A dash-joined appositive is the single
  most-cited tell of machine-written prose, and patch notes attract it badly. Where a dash
  is genuinely right it is `—`.
- **Sentence case headings.** No Title Case, no ALL CAPS.
- **No padding**: simply, just, please note, be sure to, feel free to. No "we're excited to".
- **Terminology is per game and a leak is a bug.** DECODE has **artifacts**; Chain Reaction
  has **particles**, and its ring is a **catalyst** (the *ring stand* is a different object).
  Teleop is **driver-controlled**. DSIM is the app; DECODE and Chain Reaction are seasons of
  it, never the product name.

### Write the fix, not the bug's history

Nobody needs to know it was broken for three weeks or which commit did it. "Tank drive
replays play back correctly" is the note; the archaeology belongs in the commit message.

### Length

A note that cannot be read in a minute will not be. Group ruthlessly, put the consequences
at the top, and let `/changelogs` hold the long tail. If a section runs past six bullets it
is usually two sections or one sentence.

---

## 5. Skeleton

```
# What this is

One or two sentences: the shape of the release, and the single most important
consequence. If something resets, it is named in this paragraph.

## Season and records        ← only when something resets. First, always.
- what reset, what did not, and what that means for their rank and their PBs

## <the biggest player-visible area>
- ...

## <next area>
- ...

## Elsewhere                 ← the small stuff, one line each, no sub-bullets

Shared changes get their own heading in both games' notes, from that game's angle.
```

Drafts live in the scratchpad, not in the repo — the published row is the artifact, and a
committed copy of it is a second source of truth that will go stale the first time a
sentence is edited at publish time.
