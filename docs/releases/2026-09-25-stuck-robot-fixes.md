# Stuck robot fixes: patch notes (2026-09-25)

Three `patch` announcements, one per game (`docs/patch-notes.md`). Nothing here has been
published. Publish **after** the deploy that carries these fixes, never before: a note is live
for every client the moment it is posted.

What ships: the ramp freeze and ramp swing fixes (`5216595f`), the toggle debounce, server
input gap-fill and gamepad dropout hold with `SIM_VERSION` 4 (`fa125d2f`), and the hive-frame
set-down (`194d23bd`). `BALANCE_VERSION` does not move, so no board, rating or season resets.

⚠️ **The FLOWER ring-plate fix is still in progress.** Its line in the BIOBUZZ note sits
between `<!-- PENDING: flower trap -->` and `<!-- /PENDING -->`. Set `FLOWER=keep` in the
publishing block only if that fix is in the deploy; the default cuts it. The markers are never
posted either way.

The bodies have no `# Welcome to …` heading (`docs/patch-notes.md` §5): a patch opens no new
period, and the card title above the body already names the note. The bold bullets at the top
are the summary.

---

## Note 1: BIOBUZZ

- kind: `patch`
- title: `BIOBUZZ · Ramp and controller fixes`
- tagline: empty

~~~markdown
- **Replays from before this update** still play, with a note that the ending may land differently. Records, ratings and seasons are unchanged.
- **A ramp robot can no longer freeze for the rest of a match.**
- **The ramp deploys and folds only when you press it.**

## Deployable ramp

- **A ramp that ends up inside a wall or field part folds, and the robot drives away.** Folding at speed just short of a wall could leave the ramp deployed inside it, and every later fold press was refused. Driving a deployed ramp across the HIVE’s foot bars could wedge the robot the same way.
- **One press is one toggle.** A controller dropout or button glitch lasting a split second counted as a release and a new press, so the ramp deployed and folded straight back.
- **The ramp still folds back if its swing would hit a wall, a FLOWER, the HIVE’s 2-in foot bars or another robot.** That is intended. Give it room before you press.

## 3D field

- **A robot that ends up overlapping the HIVE frame is set down beside it.** It used to be lifted onto the foot bar and stuck there.
<!-- PENDING: flower trap -->
- **A robot no longer catches on a FLOWER’s bottom ring plate** and stops moving.
<!-- /PENDING -->

## Controls

These apply to every game.

- **A toggle ignores a release shorter than about 40 ms**: the ramp, and the drive-mode swap on a butterfly drivetrain.
- **Online, a lost packet no longer reads as a released button.** A held button could flicker off for an instant and toggle twice.
- **A controller that disconnects for a split second keeps its buttons held.** Bluetooth pads do this, and every button used to release.
~~~

---

## Note 2: DECODE

- kind: `patch`
- title: `DECODE · Controller fixes`
- tagline: empty

~~~markdown
- **Replays from before this update** still play, with a note that the ending may land differently. Records, ratings and seasons are unchanged.
- **A toggle ignores a release shorter than about 40 ms**, so a glitching button can’t swap a butterfly drivetrain’s drive mode twice.
- **Online, a lost packet no longer reads as a released button.** A held button could flicker off for an instant and toggle twice.
- **A controller that disconnects for a split second keeps its buttons held.** Bluetooth pads do this, and every button used to release.
~~~

---

## Note 3: Chain Reaction

- kind: `patch`
- title: `Chain Reaction · Controller fixes`
- tagline: empty

~~~markdown
- **Replays from before this update** still play, with a note that the ending may land differently. Records, ratings and seasons are unchanged.
- **A toggle ignores a release shorter than about 40 ms**, so a glitching button can’t swap a butterfly drivetrain’s drive mode twice.
- **Online, a lost packet no longer reads as a released button.** A held button could flicker off for an instant and toggle twice.
- **A controller that disconnects for a split second keeps its buttons held.** Bluetooth pads do this, and every button used to release.
~~~

---

## Publishing (release manager)

Run from the repo root in Git Bash, after the production deploy is verified. `ADMIN_SECRET`
is in `D:\Projects\2ddecodesim\.env`; load it into the shell, don't print it.

The route is `POST /api/admin/announcement` with a JSON body `{kind, title, body, tagline}`
and the secret in the query string (`server/index.ts`). `note N` reads the Nth title and the
Nth `~~~markdown` body from this file, applies `FLOWER`, and prints the JSON, so the text
posted is exactly the text above. `--url-query` URL-encodes the secret into the query string
the way `-G --data-urlencode` would; `-G` itself cannot be used, because it turns the request
into a GET and curl refuses it beside a request body. Needs curl 7.87 or later (`curl
--version`).

```sh
GS=https://dohun-sim-decode.fly.dev
NOTES=docs/releases/2026-09-25-stuck-robot-fixes.md
FLOWER=cut   # keep: publish the FLOWER ring-plate line (only if that fix is deployed)

note() {
  node -e '
    const fs = require("fs");
    const [file, n, flower] = process.argv.slice(1);
    const md = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const titles = [...md.matchAll(/^- title: `(.+)`$/gm)].map((m) => m[1]);
    const bodies = [...md.matchAll(/^~~~markdown\n([\s\S]*?)^~~~$/gm)].map((m) => m[1]);
    let body = bodies[n - 1];
    body = flower === "keep"
      ? body.replace(/^<!-- \/?PENDING[^\n]*-->\n/gm, "")
      : body.replace(/^<!-- PENDING[^\n]*-->\n[\s\S]*?^<!-- \/PENDING -->\n/gm, "");
    process.stdout.write(JSON.stringify({ kind: "patch", title: titles[n - 1], body: body.trimEnd(), tagline: "" }));
  ' "$NOTES" "$1" "$FLOWER"
}

# read what will be posted before posting it
for n in 1 2 3; do note $n | node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log("=== " + j.title + "\n" + j.body + "\n")'; done

# Posted in reverse so BIOBUZZ, the one with the most in it, is newest and heads the list.

# 3. Chain Reaction
note 3 > /tmp/note-3.json
curl -sS --url-query "secret=$ADMIN_SECRET" -H "content-type: application/json" --data-binary @/tmp/note-3.json "$GS/api/admin/announcement"

# 2. DECODE
note 2 > /tmp/note-2.json
curl -sS --url-query "secret=$ADMIN_SECRET" -H "content-type: application/json" --data-binary @/tmp/note-2.json "$GS/api/admin/announcement"

# 1. BIOBUZZ
note 1 > /tmp/note-1.json
curl -sS --url-query "secret=$ADMIN_SECRET" -H "content-type: application/json" --data-binary @/tmp/note-1.json "$GS/api/admin/announcement"

# check: all three listed, BIOBUZZ first
curl -sS "$GS/api/announcements?limit=3"
```

Each post answers `{"ok":true,"announcement":{…}}`. A wrong note is retired with
`curl -sS -X POST --url-query "secret=$ADMIN_SECRET" --url-query "id=<id>" "$GS/api/admin/announcement/delete"`
(sets `active` false; the row stays).
