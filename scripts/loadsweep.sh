#!/usr/bin/env bash
# CAPACITY SWEEP — run scripts/loadtest.ts at a ladder of room counts and collect the JSON.
#
# Answers one question: at how many rooms does this machine stop keeping its promises?
# Everything else in docs/capacity.md is read off the slope this produces.
#
#   ./scripts/loadsweep.sh [outdir] [shape] [secs] [url]
#     outdir  where the per-step JSON lands (default .loadtest-out/sweep)
#     shape   solo | 1v1 | 2v2 | duo | mix   (default solo — one socket per room, so the
#             CPU-per-ROOM slope is not confounded with the cost per SOCKET)
#     secs    measurement window per step (default 45)
#     url     ws base (default ws://localhost:8787)
#
# ⚠️ THE GAP BETWEEN STEPS IS NOT POLITENESS. A room whose drivers vanish mid-match holds
# their slots for RECONNECT_GRACE_MS (45s) and keeps running its 60 Hz loop the whole time —
# measured: `/api/perf` still reported 2 rooms and 0.18 cores with zero players connected.
# Starting the next step inside that window would count the previous step's ghosts.
set -euo pipefail

OUT="${1:-.loadtest-out/sweep}"
SHAPE="${2:-solo}"
SECS="${3:-45}"
URL="${4:-ws://localhost:8787}"
STEPS="${STEPS:-1 2 4 8 12 16 24 32 40 48}"
GAP="${GAP:-50}"

mkdir -p "$OUT"
echo "==> sweep: shape=$SHAPE secs=$SECS url=$URL steps=[$STEPS] -> $OUT"
for n in $STEPS; do
  echo "--- $n rooms ---"
  # --predict 0: a predicting bot runs a full 60 Hz Rapier step in the HARNESS process, and on
  # a one-box run that steals the cores being measured. Reconcile distance is a separate,
  # small run (see docs/capacity.md), never part of the ladder.
  npx tsx scripts/loadtest.ts --url "$URL" --rooms "$n" --shape "$SHAPE" --secs "$SECS" \
    --ramp 8 --predict 0 --json "$OUT/${SHAPE}-${n}.json" || echo "!! step $n failed, continuing"
  node -e "setTimeout(()=>{}, ${GAP}000)"
done
echo "==> done. summarise: npx tsx scripts/loadsummary.ts $OUT"
