# The prompt to paste into a teammate's Claude

Send them this verbatim, with `<owner>/<board-repo>` and `<their-name>` filled in. It is
written to be pasted into a Claude Code session in their dsim checkout.

---

We have a coordination board for kickoff day. Three of us work this repo in parallel from
separate Claude sessions, and it exists so two of us do not build the same thing from
different chats. Read `docs/biobuzz/COORDINATION.md` for the full protocol; this is the
short version.

Set it up for me, once:

1. Make sure my branch has `scripts/coord/` — it landed on `biobuzz-field`. Fetch and merge
   it if it is not here yet.
2. Write `.coord.json` in the repo root (it is gitignored):
   `{ "remote": "<owner>/<board-repo>", "name": "<their-name>" }`
3. Run `npm run coord:setup`. It verifies the board repository is private before it sends
   anything, and refuses if it cannot tell.

Then, for the rest of the session, this is how you should behave:

- **Before starting any new piece of work, run `npm run coord` and read it.** If someone else
  has claimed a path you are about to edit, tell me before you touch it. Do not silently work
  around a collision.
- **When I tell you what we are working on, claim it by path:**
  `npm run coord:claim -- "<what we are doing>" <path> [path…]`
  Claim directories when the work is a directory. Re-claim when the work moves.
- **`npm run coord:claim -- --clear` when we finish a piece.**
- The board republishes my branch, HEAD and dirty files automatically at the end of every
  turn — you do not need to run anything for that, and you must not treat a failure there as
  something to fix mid-task. It exits 0 by design.
- The board is a note, not a lock. It cannot stop anyone editing anything. Git is the truth;
  the board is only intent.

What it sends is built only from `git` output — branch, short HEAD, last commit subject, and
the file paths `git status` reports dirty — plus a label I type deliberately. **Never put
anything from our conversation into a claim label**, and if you notice a secret or personal
detail anywhere in the repo or the chat, tell me instead of publishing anything.
