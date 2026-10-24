# Zenith fixtures

Test routines for the AUTO lane (`scripts/smoke-biobuzz/autos.ts`), written for DSIM.

- `garden-cycle.auto.json` sweeps the garden and plays every command DSIM runs.
- `preload-park.auto.json` with `waypoints.json` names every pose by waypoint, so it checks that
  refs are inlined before the file is mirrored and played.
- `format4.auto.json` is auto format 4: a `transfer`, an `envelope` on a command and a path with
  `rejoinFrom`, in open field on the BLUE side.
- `starter/` is Zenith's public starter example (`examples/starter/autos` at Zenith `bfea96a5`,
  MIT), unedited: the four autos and their waypoints. The AUTO lane loads each against DSIM's robot
  file. Only Zenith's public examples belong here.
