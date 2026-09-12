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
artifacts, depending on how tightly the ramp is packed" tells them how to play.

### ⚠️ The reader is an FTC team. Do not write down to them.

**"Written for players" does NOT mean simplified.** This was got wrong once already and the
notes had to be redone: "weight and gearing" for *mass and drive RPM*, "running your intake
costs you push" for *power draw reduces pushing power*, "pushing artifacts somewhere" for
*G408*. Every one of those is longer, vaguer and less useful than the term it replaced.

The people reading this design drivetrains, argue about gear ratios and read the
Competition Manual. **Technical vocabulary is the most efficient and most respectful way to
tell them what changed.** Use it exactly:

- **mass**, not weight. **Drive RPM**, not gearing. **Power draw**, not "current things cost".
- **Flywheel inertia**, **traction limit**, **restitution**, **yaw**, **indexer**, **cone**,
  **reach** — all fair game, all precise.
- **Rule numbers.** G408, G422, G02/G03, G04. A driver knows what G408 is; "the possession
  rule" makes them work out which one you mean.
- The game's own nouns are obviously free: artifact, particle, catalyst, classifier, gate,
  Lab Area, ring stand, accelerator.

### What to cut instead

The axis to cut along is not "technical", it is **usable**. Two things fail that test, and
neither is a domain term.

**Implementation vocabulary** — words this *codebase* invented, which name nothing to
somebody outside it: solver, tick, frame, authority, slop clamp, position authority, round
loop, constant. Some are ordinary English, which is exactly why they slip through. "The
strafe curb is a slop clamp", "account standing on its own axis", "the catch area is at the
roller nip" all read as English and say nothing.

**Spec dumps that inform no decision.** The test for a number is not "did we measure it":

> **Would a player change what they build, or what they do with the sticks, because of this
> number?**

Four-to-nine artifacts on a gate tap passes — it tells you when to tap and when to hold.
Fifteen seconds before a practice run is kept passes. "Roughly 17 in of reach on a compact
robot against 9 in on a maxed-out one" passes: it is a reason to build small. Roller
diameters in millimetres, a tick rate, an internal frame count and "the cadence carries its
remainder so the rate is not tick-quantised" all fail. Cut those; the commit message already
has them.

Note the difference between the two halves of that: *a 250 RPM minimum-mass mecanum used to
out-push a maxed tank* is a fine sentence, because it shows the size of a bug that has been
fixed. The same fact written as three specs in a row — `250 rpm`, `42 lb`, `435 rpm` — is
not, because nobody picks a build by reciting numbers at it. Same measurement, different
job.

**Where both failure modes resolve is the consequence.** Not what the code now does, but
what the player now does: *lining up matters now*, *drop the intake before you commit to a
push*, *do not park on the outflow*, *build small if you want to play the arm*. A bullet
that cannot be turned into advice or into something visibly different belongs in
**Elsewhere** as one flat line, or nowhere.

### The house copy rules apply, and CLAUDE.md owns them

Do not restate them here; they drift. The ones that catch people writing notes:

- **Typographic punctuation.** `’` `“` `”` `…`, never the ASCII ones.
- ⚠️ **NO EM DASHES. None.** Not one, anywhere in a patch note. A dash-joined appositive is
  the single most-cited tell of machine-written prose, and every one of them is a full stop,
  a colon, a comma or a rewrite. This is stricter than the rest of the app's copy, and it is
  deliberate: a note is the most-read prose DSIM publishes.
- **Sentence case headings.** No Title Case, no ALL CAPS.
- **No padding**: simply, just, please note, be sure to, feel free to. No "we're excited to".

### ⚠️ Sentence shapes that read as AI, and what to write instead

These are not style nits. They are the constructions a reader recognises instantly, and
every one below was written into a real draft of these notes and had to be pulled out.

- **"X is a real Y."** *Pushing is a real force* → **"Pushing is calculated using forces."*
  Say the mechanism. "Real" is doing emphasis, not information, and it implies the old one
  was fake.
- **"like the X they are" / "as the X they form."** *Wheels render as the diamond they form*
  → **"Wheels render as a diamond."**
- ⚠️ **Never invent a physical description of a game element.** A draft said *artifacts
  collide like the foam balls they are*, which is two mistakes: the construction above, and
  a material nobody had checked. The Competition Manual is the only authority on what a game
  piece is made of, and a simile is almost never worth the risk — say what it DOES
  ("artifacts bounce, deflect and scatter") and the sentence is both safer and more useful.
- **"X reads as X."** *Terrain reads as terrain* → say what the player sees: **"The robot
  lifts, casts a shadow and thumps."**
- **"A is A"** restatements. *A pile pushes as a pile* → **"You can push a whole pile."**
- **Grand openers.** *The biggest update DSIM has had.* Cut it. Open on the heading and the
  headline bullets; let the content be the claim.

The common fault is a sentence that sounds like it is saying something while carrying no
new fact. Read each bullet and ask what a player learns from it. If the answer is "that we
are pleased with it", delete it.
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
# Welcome to <the period this opens>

Four or five BOLD one-line headlines, most consequential first. If something
resets, it is the first bullet. No opening paragraph: the heading and these
bullets are the summary.

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
