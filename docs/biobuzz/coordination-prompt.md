# Onboarding a teammate

The board repository is **`featurescript/dsim-coord`** (private).

**The behaviour lives in `CLAUDE.md`, not in a pasted prompt.** Every Claude session in this
repo reads it, so a teammate does not have to remember to paste anything, and it keeps working
across new sessions, restarts and machines for as long as the board is live. What follows is
only the one-time setup.

## What to send them

> 1. Accept the GitHub invitation to **`featurescript/dsim-coord`** — check your
>    notifications. Setup cannot work until you have.
> 2. In your dsim checkout, on a branch that has `scripts/coord/`, tell your Claude:
>
>    > Set up the dsim coordination board for me. Write `.coord.json` in the repo root with
>    > `{ "remote": "featurescript/dsim-coord", "name": "<your-name>" }` and run
>    > `npm run coord:setup`. Then read the "Parallel sessions" section of CLAUDE.md and
>    > follow it for the rest of the weekend.
>
> That is all. From then on it republishes itself at the end of every turn, and every new
> session picks the rules up from `CLAUDE.md` on its own.

`<your-name>` becomes their claim's filename, so: lowercase, no spaces.

## Two failures worth pre-empting

- **"could not ask GitHub whether … is private"** — `gh` is not installed or not signed in on
  their machine. Different from the next one.
- **"no longer exists, or this account's access to it has been removed"** — almost always an
  unaccepted invitation, not a broken `gh`. `coord:setup` says so explicitly.

## Turning it off, for everybody

Delete the board repository, or remove someone from it. Their tooling confirms it over two
runs and then retires itself: `.coord.json` becomes `.coord.retired.json`, the `coord` remote
is dropped, and every command becomes a silent no-op. `CLAUDE.md` tells the session that a
retired board means work normally.

Nobody has to uninstall anything, and no session has to be told.
