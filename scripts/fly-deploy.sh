#!/usr/bin/env bash
# Deploy the DECODE game server to Fly, then RE-APPLY the per-region VM sizes.
#
# Why this wrapper exists: `fly deploy` re-applies fly.toml's single `[[vm]]`
# (shared-cpu-4x) to EVERY machine, which resets the cheaper satellite regions.
# fly.toml has no way to express per-region VM sizes, so we shrink the satellites
# back here. ALWAYS deploy via this script, not a bare `fly deploy`.
#
# Sizing policy: iad (matchmaker + always-warm primary) runs shared-cpu-4x (from
# fly.toml — 4 shared vCPUs, ample headroom for the 60Hz loop without a dedicated
# vCPU's cost). EVERY other region, INCLUDING sjc, runs shared-cpu-1x — much cheaper,
# but SHARED: a sustained match there can burn burst
# credits and throttle the 60Hz loop (the flap risk fly.toml warns about). They rarely
# host a match and auto-stop when idle, so the cost win outweighs it; bump back to a
# performance-* size if a far region starts flapping under real matches. Tune below.
#
# ALPHA: `./scripts/fly-deploy.sh --alpha` deploys the PREVIEW app from fly.alpha.toml
# instead — one region, its own database, and no satellites to re-shrink. The two are kept
# in one script on purpose: a second script is a second thing to forget to update, and the
# only real difference is which config file and which app name.
set -euo pipefail

ALPHA=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --alpha) ALPHA=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- ${ARGS+"${ARGS[@]}"}

if [ "$ALPHA" -eq 1 ]; then
  APP="${FLY_ALPHA_APP:-dsim-alpha}"
  CONFIG=fly.alpha.toml
  echo "==> ALPHA preview deploy ($APP) — production is untouched"
  # -c pins the config: without it `fly deploy` reads fly.toml and would deploy PRODUCTION
  # under an alpha app name, quietly giving the preview production's multi-region VM block.
  deploy_rc=0
update_rc=0 # any satellite whose re-shrink failed — reported at the end, never silent
  # --ha=false: Fly's default launches a SECOND machine for high availability, and for this
  # server that is not redundancy, it is a SPLIT. Rooms live in the process's memory and the
  # routing hints resolve to a REGION, not a machine — so two machines in one region means
  # two players can land on different ones and sit in different rooms with the same code,
  # which is exactly the cross-region bug this app just fixed, one level down.
  fly deploy --remote-only --ha=false -c "$CONFIG" -a "$APP" "$@" || deploy_rc=$?
  if [ "$update_rc" -ne 0 ]; then
  echo "!! AT LEAST ONE SATELLITE WAS NOT RE-SHRUNK (see above). A machine left on fly.toml's"
  echo "   [[vm]] is running shared-cpu-4x AND MAX_ROOMS 24 — costly, and oversubscribed."
fi
if [ "$deploy_rc" -ne 0 ]; then
    echo "!! fly deploy exited $deploy_rc — CHECK THE DEPLOY (fly machine list -a $APP)"
    exit "$deploy_rc"
  fi
  # no satellites here: the preview is single-region, so there is nothing to re-shrink
  echo "==> done. verify: fly machine list -a $APP"
  echo "    health: curl https://$APP.fly.dev/health"
  exit 0
fi

APP="${FLY_APP:-dohun-sim-decode}"

# THE FLEET, DECLARED. This line is the in-repo source of truth for which regions run
# a machine, and `npm run test:mm` asserts that server/regions.ts agrees with it.
#
# It exists because the two drifted and the failure was silent: `ord`, `gru` and `jnb`
# all had live machines while `DEPLOY_REGIONS` still listed five regions, and
# `interRegionMs` answers a RADIUS_MAX-sized penalty for any region it has no row for.
# So a player whose Anycast landing region was missing did not read as "far" — they read
# as unpairable until the search radius saturated six seconds later, and never at all if
# they had asked to stay region-local. Two players in the same city could not be matched
# to each other. Nothing logs when this happens.
#
# ADD A REGION HERE AND IN server/regions.ts (both DEPLOY_REGIONS and the RTT table) IN
# THE SAME CHANGE. The test fails if this list names a region the code does not know.
FLEET_REGIONS=(iad ord sjc lhr syd nrt gru jnb)

# EVERY region except the always-warm primary (iad) runs the cheap shared size.
# sjc joined this list 2026-07-20 (cost pass): US West is redundant with iad for
# the ~75% of games that are solo record runs, and it auto-stops when idle anyway.
#
# ord joined 2026-09-13, on the same argument sjc joined on, and to close a gap rather
# than to save money: ord is the ONLY host candidate that was never deliberately sized.
# Being absent from this list does not leave it alone — it leaves it on fly.toml's
# `[[vm]]`, which `fly deploy` re-applies to every machine, so it has been quietly
# running the primary's shared-cpu-4x (and, per the default below, MAX_ROOMS 24) by
# omission. ord↔iad is 22ms, i.e. near-duplicate coverage of the always-warm primary,
# which is word for word the case made for sjc above. Memory needs no verification here:
# SATELLITE_MEMORY and fly.toml both say 1024, so moving ord in changes the CPU size and
# the room cap and nothing else. Revert this one line if ord ever starts flapping.
#
# ⚠️ gru/jnb are still NOT here, and the repo disagrees with itself about why. The note
# that used to sit here (and the one in server/regions.ts) says they run at 512MB, under
# the 1024 Node+Rapier needs — but this script's own header says `fly deploy` re-applies
# fly.toml's 1024mb to EVERY machine, and they are not exempt from that. Both cannot be
# true unless they were created outside this script and have never been deployed to. So
# the 512 premise is UNVERIFIED, and it points the wrong way if it is wrong: if they have
# been through a deploy they are already 4x/1024 and adding them here DOWNSIZES them.
# TO FINISH 4.4:
#   1. `fly machine list -a dohun-sim-decode --json` — read their real size/memory/state.
#   2. add them here, and DEPLOY THAT ALONE. The re-shrink loop runs only after
#      `fly deploy` returns (minutes, it waits on health checks), so this list must land
#      one deploy AHEAD of DEPLOY_REGIONS — and `fly machine update --vm-memory` REBOOTS
#      the machine, which kills any room `bestHost` staged there in the meantime.
#   3. only then add gru/jnb to DEPLOY_REGIONS in server/regions.ts (and drop the stale
#      512MB note above the gru row there). That is the latency win: today a São Paulo
#      player's match hosts in iad at 118ms and a Johannesburg player's in lhr at 155ms,
#      on machines that exist in their own city.
# The mmsmoke row check is already written against RTT_UNKNOWN rather than a literal 300,
# so the four genuinely-long pairs that appear then (syd↔jnb 395, nrt↔jnb 355, gru↔jnb
# 340, syd↔gru 315) stay green instead of reading as missing rows.
SATELLITES=(ord sjc lhr syd nrt)
SATELLITE_SIZE=shared-cpu-1x
SATELLITE_MEMORY=1024 # MB — shared-cpu-1x defaults to 256MB, too tight for Node+tsx+Rapier
# MAX_ROOMS for a satellite. The default (server/index.ts) is 24 for EVERY region with
# FLY_REGION set, and it was sized for iad: fly.toml's own COST PASS note says the size
# that used to flap was shared-cpu-**1x**, "whose sustained baseline is a fraction of a
# core ≈ ONE busy room", and docs/deploy.md's table gives shared-cpu-1x 3–5 driven rooms
# with margin. 24 on a 1x machine is not a guard, it is no cap at all.
# 6 is above both figures on purpose, so it stays a RUNAWAY GUARD (see server/index.ts)
# and not an admission limit: most rooms are PARKED (0.031 cores) rather than driven
# (0.075), and 6 parked rooms is ~0.19 cores. It IS a tighter guard than 24 was — 24 is
# 3–4.8× iad's 5–8 band, 6 is only 1.2–2× the satellites' 3–5 band. If satellites start
# refusing players with `region_full` while `/api/perf` shows headroom, the next step is
# 8–10, not back to 24.
# ⚠️ IT MUST BE APPLIED HERE, NOT IN fly.toml. `fly deploy` regenerates machine config
# from fly.toml — the same mechanism this script's header documents for the VM size — so
# a hand-run `fly machine update --env` reverts on the next deploy, silently. A fly.toml
# `[env]` block is the wrong fix in the other direction: it would cap iad at 6 too.
# ⚠️ THE COST OF A CAP THAT BITES, stated because the matchmaker cannot see it. A staged
# RANKED match is created through the same `join` path this cap gates (server/index.ts), and
# the matchmaker is NOT load-aware — so a satellite already at its cap refuses the room with
# `region_full`, nobody connects, `RANKED_JOIN_GRACE_MS` lapses, and `cancelPending` charges
# the innocent players a NO-SHOW dodge. That is true at 24 as well; 6 makes it reachable
# sooner. It is still the right trade: 24 driven rooms on a shared-cpu-1x is the flapping this
# whole loop exists to prevent, and a flap drops EVERY room on the machine, not one. If
# `/api/perf` ever shows a satellite refusing at 6 with headroom to spare, raise this to 8-10
# — do NOT go back to 24, and do not "fix" it by exempting staged rooms from the cap unless
# the exemption is verified against `pending_matches` (a room CODE is client-supplied, so
# trusting its shape would be an admission bypass).
SATELLITE_MAX_ROOMS=6

echo "==> fly deploy ($APP)"
# NOTE: do NOT let a non-zero deploy skip the re-shrink below. `fly deploy` exits
# non-zero on transient api.machines.dev flakes (health-check wait timeouts, cancelled
# requests) even when every machine actually updated — and with `set -e` that aborted
# the script mid-way, silently leaving the satellites on shared-cpu-4x. Observed
# 2026-07-20. So capture the status, ALWAYS re-shrink, and re-raise at the end.
deploy_rc=0
# --ha=false: the note on the ALPHA deploy line above applies here word for word, and
# harder — production has EIGHT regions where the preview has one. Fly's default launches
# a SECOND machine for high availability, and for this server that is not redundancy, it
# is a SPLIT: rooms live in the process's memory and `routeTarget` resolves a room code to
# a REGION, not to a machine, so the proxy is free to put two players sharing one code on
# different machines. Two lobbies, one code, both sides waiting, no error on either
# screen. docs/deploy.md ("Can a region run TWO machines?") is the long form.
# ⚠️ THIS FLAG IS PREVENTIVE ONLY, and it was missing from this line for the life of the
# script. It stops a second machine being CREATED; it cannot remove one Fly already made,
# so the duplicate-region warning below is the half that finds existing damage.
fly deploy --remote-only --ha=false -a "$APP" "$@" || deploy_rc=$?
[ "$deploy_rc" -ne 0 ] && echo "!! fly deploy exited $deploy_rc — re-applying VM sizes anyway, then failing"

echo "==> re-applying per-region VM sizes (satellites -> $SATELLITE_SIZE/${SATELLITE_MEMORY}MB, MAX_ROOMS=$SATELLITE_MAX_ROOMS)"
ids=$(fly machine list -a "$APP" --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const want = new Set(process.argv.slice(1));
  // Fly keeps destroyed rows in this JSON after a replace. Drop them BEFORE both uses
  // below: a dead id handed to `fly machine update` fails the deploy, and counting one
  // would print the duplicate warning on every healthy deploy.
  const live = data.filter((m) => m.state !== "destroyed");
  // TWO MACHINES IN ONE REGION IS THE SILENT SPLIT described on the deploy line above,
  // and --ha=false only prevents a NEW one. This deploy ran without that flag until
  // 2026-09-13, so a duplicate may already exist; nothing else in the repo can see it.
  // stderr, NOT stdout: this stdout is captured into `ids` and read line-by-line as
  // "region id" pairs by the loop below, so a warning on stdout would be handed to
  // `fly machine update` as a machine id.
  const byRegion = new Map();
  for (const m of live) byRegion.set(m.region, (byRegion.get(m.region) ?? 0) + 1);
  for (const [r, n] of byRegion)
    if (n > 1) console.error(`!! ${r} has ${n} machines — ONE PER REGION is load-bearing: two players sharing a room code can land in different rooms, silently. Destroy the extra (docs/deploy.md).`);
  for (const m of live) if (want.has(m.region)) console.log(`${m.region} ${m.id}`);
' "${SATELLITES[@]}")

while read -r region id; do
  [ -z "$id" ] && continue
  # --env is safe to pass alongside the size flags only because fly.toml has NO `[env]`
  # block, so there is nothing else in machine env for it to clobber (Fly SECRETS are a
  # separate mechanism and are untouched). Re-check that if an `[env]` block is ever added.
  # ⚠️ TOLERATE A FAILURE HERE, for the same reason the `fly deploy` line above is guarded.
  # `set -euo pipefail` is on (line 21), so an unguarded non-zero exit on the FIRST satellite
  # aborts the script and leaves EVERY remaining satellite on shared-cpu-4x with MAX_ROOMS 24
  # — which is verbatim the failure observed 2026-07-20 and the whole reason this loop exists.
  # `--env` is the newest flag on this line and the one most likely to be renamed or dropped by
  # a flyctl upgrade; a CLI change must degrade to a loud line, not to a silently half-resized
  # fleet. The mmsmoke check reads this SCRIPT, not the CLI, so it gives no signal here.
  if fly machine update "$id" --vm-size "$SATELLITE_SIZE" --vm-memory "$SATELLITE_MEMORY" --env MAX_ROOMS="$SATELLITE_MAX_ROOMS" -a "$APP" -y >/dev/null; then
    echo "   $region ($id) -> $SATELLITE_SIZE/${SATELLITE_MEMORY}MB, MAX_ROOMS=$SATELLITE_MAX_ROOMS"
  else
    update_rc=1
    echo "!! $region ($id) UPDATE FAILED — it may still be on fly.toml's size/MAX_ROOMS. Check: fly machine list -a $APP"
  fi
done <<< "$ids"

if [ "$deploy_rc" -ne 0 ]; then
  echo "!! VM sizes re-applied, but 'fly deploy' had exited $deploy_rc — CHECK THE DEPLOY."
  echo "   Often a transient API flake with the rollout actually complete; confirm every"
  echo "   machine shares one IMAGE and is 1/1: fly machine list -a $APP"
  exit "$deploy_rc"
fi

echo "==> done. verify: fly machine list -a $APP"
