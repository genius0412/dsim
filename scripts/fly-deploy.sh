#!/usr/bin/env bash
# Deploy the DECODE game server to Fly, then RE-APPLY the per-region VM sizes.
#
# Why this wrapper exists: `fly deploy` re-applies fly.toml's single `[[vm]]`
# (performance-2x) to EVERY machine, which resets the cheaper satellite regions.
# fly.toml has no way to express per-region VM sizes, so we shrink the satellites
# back here. ALWAYS deploy via this script, not a bare `fly deploy`.
#
# Sizing policy: iad (matchmaker + always-warm primary) and sjc keep performance-2x
# for smooth match hosting; the low-traffic satellites run performance-1x (cheaper,
# still DEDICATED cpu so the 60Hz loop never throttle-flaps). Tune SATELLITES below.
set -euo pipefail

APP="${FLY_APP:-dohun-sim-decode}"
SATELLITES=(lhr syd nrt)
SATELLITE_SIZE=performance-1x

echo "==> fly deploy ($APP)"
fly deploy --remote-only -a "$APP" "$@"

echo "==> re-applying per-region VM sizes (satellites -> $SATELLITE_SIZE)"
ids=$(fly machine list -a "$APP" --json | node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const want = new Set(process.argv.slice(1));
  for (const m of data) if (want.has(m.region)) console.log(`${m.region} ${m.id}`);
' "${SATELLITES[@]}")

while read -r region id; do
  [ -z "$id" ] && continue
  fly machine update "$id" --vm-size "$SATELLITE_SIZE" -a "$APP" -y >/dev/null
  echo "   $region ($id) -> $SATELLITE_SIZE"
done <<< "$ids"

echo "==> done. verify: fly machine list -a $APP"
