#!/usr/bin/env bash
# Safe production deploy: WARN every connected player with a live countdown,
# WAIT for them to wrap up, THEN deploy the game server.
#
# The server broadcasts a `serverNotice` banner (with a countdown to the restart)
# to every open socket and re-sends it to anyone who connects during the window,
# so nobody is caught mid-match by a redeploy. After the wait it runs the normal
# deploy wrapper (scripts/fly-deploy.sh — deploy + re-apply per-region VM sizes)
# and polls /health until the new machine is serving.
#
# Usage:
#   ADMIN_SECRET=... scripts/announce-deploy.sh ["message"] [wait_seconds]
#
# ADMIN_SECRET must match the Fly secret of the same name (the announce endpoint
# accepts it via ?secret=, so this needs no signed-in browser session). Set once:
#   fly secrets set ADMIN_SECRET='<random>' -a dohun-sim-decode
#
# Defaults: a generic message + a 300s (5 min) warning. Pass 0 to deploy now.
set -euo pipefail

APP="${FLY_APP:-dohun-sim-decode}"
HOST="${DECODE_HOST:-https://dohun-sim-decode.fly.dev}"
# NOTE: no apostrophe in this default — a literal ' inside "${1:-…}" is parsed by
# bash as an unterminated single quote (script fails to parse), so keep it out.
MSG="${1:-Server updating shortly — you will be reconnected automatically}"
WAIT="${2:-300}"
: "${ADMIN_SECRET:?set ADMIN_SECRET (matches the Fly secret) to authorize the announce}"

echo "==> announcing restart in $((WAIT / 60))m${WAIT}s to every connected client"
# -G + --data-urlencode builds a correctly-encoded query string; -X POST keeps it
# a POST (the endpoint reads query params, not a body). --fail => non-2xx aborts.
curl -fsS -G -X POST "$HOST/api/admin/announce" \
  --data-urlencode "seconds=$WAIT" \
  --data-urlencode "secret=$ADMIN_SECRET" \
  --data-urlencode "msg=$MSG"
echo

if [ "$WAIT" -gt 0 ]; then
  echo "==> waiting ${WAIT}s for players to finish (banner is live)…"
  sleep "$WAIT"
fi

echo "==> deploying ($APP)"
"$(dirname "$0")/fly-deploy.sh"

echo "==> verifying /health"
for _ in $(seq 1 40); do
  if curl -fsS --max-time 5 "$HOST/health" | grep -q ok; then
    echo "==> healthy — deploy complete"
    exit 0
  fi
  sleep 3
done
echo "WARNING: /health did not return ok within ~2 min after deploy" >&2
exit 1
