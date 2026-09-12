# The coordination board

Three people work this repo in parallel on kickoff day, in separate Claude sessions on
separate machines. The expensive failure is two of them building the same thing from
different chats and finding out at merge time.

The board is one claim per person — what they are touching, **by path** — published to a
branch nobody works on, in a **separate private repository**. Every session refreshes its own
claim automatically at the end of each turn. Nobody has to remember to post anything.

It is a **note, not a lock.** Nothing here can stop anyone editing anything, and nothing here
ever touches your working tree.

---

## What it costs you

Nothing, on the turn. The `Stop` hook does two cheap file checks and then hands the network
work to a detached child process, so a slow push cannot add its latency to your session. It
is rate-limited to one publish per 20 seconds, skips entirely when nothing a reader would see
has changed, and exits 0 whatever happens — a coordination push failing is not something your
session should have to hear about.

It never checks out a branch, never writes to your index or working tree, and never touches
the stash. (That last one matters here: this repo's stash stack is shared across every
worktree, so a stash from a background job could destroy another session's work. The publisher
builds its commit with git plumbing — `hash-object`, `write-tree`, `commit-tree`, `push` —
against a temporary index in the system temp directory.)

---

## Setup, once per machine

1. **One person creates a private repository** for the board — `dsim-coord`, or any name.
   It holds nothing but the claim files. It must be **private**; the tooling refuses to
   publish to anything else.
2. Everyone gets **read/write access** to it.
3. Each person writes `.coord.json` in their checkout (it is gitignored — it names a private
   repository and this one is public):

   ```json
   { "remote": "owner/dsim-coord", "name": "yourname" }
   ```

4. Then:

   ```bash
   npm run coord:setup
   ```

   It verifies the repository is private **before** adding the remote, then publishes once to
   prove the round trip works. If it refuses, it says exactly why and nothing has been sent.

Skipping setup is a supported state: with no `.coord.json`, the hook exits immediately and
every command explains itself in a paragraph instead of failing. It never falls back to
`origin`.

---

## Using it

**See who is where** — do this before you start a piece of work, and any time you are about
to open a file you did not expect to touch:

```bash
npm run coord
```

Collisions print first, in red, because they are the only thing on the board anyone has to act
on. Everything below them is context.

**Say what you are about to touch** — paths, not a task name:

```bash
npm run coord:claim -- "field geometry from Section 9" src/games/biobuzz/config.ts docs/biobuzz-reference.md
```

```bash
npm run coord:claim -- --clear
```

It prints the board afterwards, so claiming and checking are one habit rather than two
commands to remember.

**Why paths and not task names.** "Working on scoring" and "doing the scoring rules" are the
same work under two names and no program can tell. `src/games/biobuzz/elements.ts` overlaps
`src/games/biobuzz/` exactly, mechanically, with no judgement — so the board can flag it
itself instead of hoping somebody reads a list. A directory claim covers everything under it
and does not cover a look-alike sibling (`src/games/biobuzz` does not swallow
`src/games/biobuzzard.ts`). It also matches how this repo already divides work: the lane
contract says a lane must never edit files another lane owns, and a path claim is that rule,
made visible.

---

## Reading the board

```
bob  3m ago
    turret mechanism
    branch biobuzz-robot  @ a4f19c2  feat(biobuzz): sweeper capture band
    ◆ src/games/biobuzz/robot.ts
    · src/games/biobuzz/elements.ts
```

- `◆` — claimed deliberately, through `coord:claim`. Intent: what they are about to touch.
- `·` — dirty in their working tree, straight from `git status`. Fact: what they have already
  changed, including what they forgot to claim.
- **`STALE`** past 90 minutes. Stale claims are **shown, not hidden**. A claim nobody has
  refreshed in an hour and a half is probably finished work, and is possibly somebody who
  walked away mid-edit with a dirty tree — those need different responses and the board cannot
  tell them apart. Hiding them would turn "I do not know" into a confident wrong answer.
  Stale claims stop raising collisions, but they stay on screen.

The board is intent. **Git is truth** — it says what actually landed.

---

## What is sent, and what cannot be

The automatic publisher sends exactly one JSON document per person:

| field | source |
|---|---|
| `name` | your `.coord.json` |
| `label`, `paths` | **only** what you typed into `coord:claim` |
| `auto.branch`, `auto.head`, `auto.headSubject` | `git rev-parse` / `git log -1 --format=%s` |
| `auto.dirty` | the paths in `git status --porcelain`, capped at 40 |
| `updatedAt` | the clock |

**That is the whole payload, and the restriction is structural rather than a policy.** The
automatic half is built only from `git` output. It never reads the conversation, never reads a
file's contents, never copies the environment, and cannot be handed free text. So an
accidental paste into a chat — a key, a password, somebody's personal detail — cannot reach
the board, because the chat is not an input to it. The one piece of free text on the board is
the label, and a person has to type it into `coord:claim` deliberately.

Note what `auto.dirty` does carry: **file names**, from your working tree. Not their contents,
but a path like `src/games/biobuzz/scoring.ts` does say what you are building.

---

## Privacy

`genius0412/dsim` is **public**. A branch in it is world-readable, so a board there would
publish what three people are building, live, to anyone who finds the repo. An automatic
per-turn publisher makes that worse, because nobody reviews each write.

So:

- The board goes to a **separate private repository**, and `assertPrivate` refuses to push
  anywhere that is not one.
- That check runs on **every process that publishes, every run** — not once at setup.
  Visibility is not a property of a URL: anyone with admin on the board repository can flip it
  public later, and a check done once would go on pushing to it without a word.
- **"Cannot tell" is a refusal**, not a warning. A remote that is not GitHub, or a `gh` that
  is not installed or not signed in, refuses. An unverifiable remote is exactly the case where
  the cost of being wrong is the thing this is protecting.
- A refusal on the silent hook path leaves a note at `<git-dir>/coord-refused` so a publisher
  that has quietly stopped is distinguishable from one that is working.
- There is **no default remote.** Unconfigured, every entry point is a no-op or an
  explanation. A default that publishes is a default that publishes somewhere wrong on
  somebody's machine, once — and a public push is public the moment it lands.

**What this does not protect against**, stated plainly so nobody is surprised:

- Anyone with read access to the private board repository sees every claim, and so does
  GitHub.
- A guard that refuses on the next run cannot un-send what a previous run already pushed. If
  the board repository is made public at 2pm, everything published before 2pm is public.
  Refusing afterwards is all any check can do. If that happens, make it private again and
  treat what was on the board as disclosed.
- Anyone who can write to the board can write anything to it, including as somebody else. The
  claim file is keyed by name, not by identity.

---

## Files

| path | what it is |
|---|---|
| `scripts/coord/lib.mjs` | shared plumbing: the privacy guard, the checkout-free commit, collision detection |
| `scripts/coord/setup.mjs` | `npm run coord:setup` — verify private, add the remote, prove the round trip |
| `scripts/coord/hook.mjs` | the `Stop` hook: rate-limit, then spawn the publisher detached |
| `scripts/coord/publish.mjs` | builds and pushes this machine's claim |
| `scripts/coord/board.mjs` | `npm run coord` — render it |
| `scripts/coord/claim.mjs` | `npm run coord:claim` — declare paths |
| `.coord.json` | per-machine config. **Gitignored.** |

The `Stop` hook is wired in `.claude/settings.local.json`, guarded as
`[ ! -f … ] || node …`, so a checkout without these scripts is unaffected.
