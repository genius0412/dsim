# Zenith fixtures

Test routines for the AUTO lane (`scripts/smoke-biobuzz/autos.ts`), written for DSIM.

- `garden-cycle.auto.json` sweeps the garden and plays every command DSIM runs.
- `preload-park.auto.json` with `waypoints.json` names every pose by waypoint, so it checks that
  refs are inlined before the file is mirrored and played.
