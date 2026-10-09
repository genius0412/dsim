<!-- governs: src/games/chain/**, src/chainDisclaimer.ts -->
# GAME: Chain Reaction

Everything CR lives in `src/games/chain/`. Nothing CR belongs in `src/config.ts` or `src/sim/`.

*Split out of `CLAUDE.md` on 2026-09-16, **verbatim** — CLAUDE.md is loaded into every
session and this is not needed by most of them. The `governs:` line above is read by
`scripts/docaudit.mjs` and by the editor hook, so keep it accurate when paths move.*

---

# GAME: Chain Reaction (`chain`)

The 2026 Unofficial-FTC CAD-competition game. **Everything CR lives in `src/games/chain/`**
(nothing CR belongs in `src/config.ts` or `src/sim/`). Numbers come from the competition
manual (`cm.pdf` — its page streams are corrupt, so values came from manual PAGES supplied as
images + explicit dimensions); mm are converted via `mm()` (÷25.4). Values still approximated
from description rather than a figure are FLAGGED `APPROX` in `config.ts` — refine those
rather than inventing new ones.

**Fully playable and SCORED** (`CHAIN_SIM.scored = true`), so CR matches ride the ranked/record
boards under their own per-game periods. `startLegality: false` — CR start poses are legal by
construction, so the server's DECODE-only G304 gate stays off.

## Field + elements

- Square 12'×12', walls at ±72 (`CHAIN_HALF_X/Y`), origin center — same frame convention as
  DECODE. Colliders are just the four perimeter walls; there are **no in-field solids**, so
  `chainColliders` has no `dynamic` entry.
- **ACCELERATOR** — the alliance goal, OUTSIDE each side wall (red left x<0, blue right x>0),
  centered in y. `CHAIN_ACCEL_DEPTH` 27.46" out of the wall × `CHAIN_ACCEL_WIDTH` 54.87" along
  it. Its opening HANGS over the field, so launchers score from a stand-off distance, not
  point-blank. The camera bounds (`CHAIN_VIEW_HALF_X`) include the protrusion; the WALLS stay
  at ±72.
- **PARTICLE** — a 3"-OD wiffle ball, **300 of them** (`CHAIN_PARTICLE_SIM`), all simulated.
  Conserved: ground + flight + in-hoppers === 300, always.
- **CATALYST** — a 6"-OD purple ring (4 total). Seated on a **HOOK** (on the accelerator wall
  at y = ±`CHAIN_HOOK_Y`, four total) it raises that accelerator's multiplier.
  **Three MECHANISMS handle it** (`CHAIN_CATALYSTS`, resolved by `chainCatalystGeom(spec)` —
  the ONE resolver, so the action, the HUD prompt and the mass floor can't disagree). One claw
  does both grabbing and placing, so each has a single `reach`, measured from the mounted
  chassis EDGE (`catalystMouth`), plus a `cone` half-angle: **arm** (reach specialist, ±50°,
  slow) · **launcher** (shortest claw, ±35°, plus the inaccurate `fling` catapult) ·
  **turret** (rail + turret, cone = π so facing never matters, fastest, heaviest).
  **The ARM's reach is PER-CHASSIS, not a constant** — see `chainArmReach`. G02/G03 give a
  24" control prism (`CHAIN_PRISM`), so what's legally left to extend is
  `24 − (chassis + any sweeper on that same axis) + the ring radius`. That spans **9" on a
  maxed-out 18" chassis to 17" on a compact one**, making the arm the mechanism you build
  small to exploit; `CHAIN_EXPANSION` is now just the maxed-robot worst case, derived rather
  than assumed. **This never changes the SPRITE**: both `drawCatalystMech` and `RobotPreview`
  draw the arm at the fixed stowed `CHAIN_ARM_DRAW` (2.2"), because an arm is only extended
  while it actuates — top-down it just says which way it points. Do NOT wire the sprite to
  `reach`; drawing it extended made every robot look permanently mid-grab.
- **RING STAND** — a 22.5" vertical pole very close to each field corner (inset APPROX).
  Robots ASCEND (endgame) / DESCEND (auto).
- **LAB AREA** — each alliance's two 24" corner squares on its side: start / leave / park.
- **PARTICLE ZONE** — the central white-tape diamond (`CHAIN_DIAMOND_SIDE` 48" outer side,
  half-diagonal `CHAIN_DIAMOND_R` ≈ 33.94"). Neutral and unprotected — it is the carve-out in
  the auto-protection rule.
- **BEAMS** — four 1"×1" black tubes on the x/y axes, 56" long, running IN from each wall
  (inner end 16" from centre, crossing the diamond). See *Terrain* below.

## Scoring (`CHAIN_PTS`)

Particle **1 pt × the accelerator's multiplier**; `accelMultiplier(state, a)` = 1 + one per
CATALYST seated on that alliance's hooks. Ring-Stand **descend 100** (auto) / **ascend 100**
(endgame); Lab-Area **leave 5** (auto) / **park 5** (endgame). Match timing 30 s auto / 120 s
teleop / last 20 s endgame. The alliance total is recomputed each tick as
`particlePoints + endgame + foulPoints` — endgame status is DERIVED from position
(`endgameOf`: ascended = slow near a stand > parked = centre in a Lab square), and the AUTO
descent is LATCHED (`descentAwarded`) so a robot that came down keeps the points all match.

## Particle lifecycle (bespoke, not Rapier)

Ground particles use a bespoke integrator + a spatial-hash SEPARATION pass so they never
overlap (`separateParticles`, scales to 300 cheaply).

**PRE-MATCH RANDOMIZATION** — the manual has the accelerators fling all 300 particles back out
to randomize the field. We STAGE half inside each goal (`staged` flight balls, inert) and the
launcher ejects `CHAIN_PRELAUNCH_PER_TICK` per goal per tick during the pre-match window
(~2.5 s to clear 150), scattering deterministically off the world RNG.

**In match:** launched → ballistic flight → crosses the wall plane within `CHAIN_ACCEL_HALF_Y`
⇒ **SCORED** (count + points at that instant) → it KEEPS its momentum and BOUNCES inside the
goal box (restitution + friction, `CHAIN_FUNNEL_MIN`..`CHAIN_FUNNEL_S` dwell) → drifts to the
wall-side launcher → **EJECTED back onto the field** (`CHAIN_EJECT_*`, randomized power/arc/
spread). A shot that MISSES the opening is retrieved by a human and thrown back in
(`CHAIN_THROWBACK_*`). Nothing is ever consumed — that is why the count stays at 300.

## Robot archetypes (`RobotSpec.scoreMode`)

- **turret** — a dye-rotor + turreted single shooter: indexes ONE particle per
  `CHAIN_FIRE_INTERVAL` (**13 bps**) from ANY range, auto-aiming. The turret **SLEWS** at
  `CHAIN_TURRET_SLEW` — it cannot snap, so a sudden velocity change (a shove) makes the lead
  solution jump faster than the turret can follow and shots fired mid-correction MISS. Aim is a
  physical state, not a promise. (Contrast DECODE, where the shooter never misses.)
- **twinturret** — two barrels on ONE turret, firing alternately from a real muzzle offset
  (`CHAIN_TWIN_BARREL_OFFSET`). Only **~15 bps** (`CHAIN_TWIN_FIRE_MULT` **1.15**) — a SLIGHT
  edge over the single turret, not a near-doubling (user's call, revised down from 1.65). The
  barrel is not the bottleneck: one indexer and one aim solution gate the rate, so a second
  barrel mostly hides handoff latency. It pays ~24% of its storage (`CHAIN_STORE_TWIN_MULT`)
  and +2.5 lb of mass floor for that, which makes it a NARROW pick — this multiplier is the
  dial if it should become mainline.
- **drum** — a chassis-wide flywheel drum, no turret: streams SINGLE particles at ~**24 bps**
  (`CHAIN_DRUM_INTERVAL` with ±`CHAIN_DRUM_JITTER`) from a RANDOM lateral position across the
  rollers, uniform launch speed. NEVER a rigid uniform line, never a "6-then-wait" burst.
- **dumper** — a chassis-wide catapult: flings the WHOLE hopper at once within
  `CHAIN_DUMP_RANGE` (56"), with side-to-side speed variance (`CHAIN_DUMP_SIDE_VAR`) ⇒ real
  scatter.

**Cadence gotcha:** the turret ACCUMULATES its interval (`fireReadyAt += INTERVAL`) rather than
re-anchoring to `world.time`, so the sub-tick remainder carries and the rate averages exactly
13 bps (a plain re-anchor tick-quantizes to 12 or 15, never 13). An idle-guard clamps
`fireReadyAt` forward so a refilled hopper can't burst-fire accumulated debt.

**Turretless aiming**: drum/dumper have no turret, so **the robot aims by TURNING** —
`chainAimAssist` (called from `chainStep` BEFORE the drivetrain model) overrides `rotate` while
the MANUAL fire button is held, and the shot is gated on `CHAIN_AIM_TOL`. Auto-fire fires
opportunistically and never hijacks the driver's heading. This is BUILT IN, not an option:
`aimAssist` is forced on everywhere (see the assists bullet above), so its `!r.aimAssist`
early-out is unreachable in the product — kept, and kept tested, for if the toggle returns.
A CR TURRET ignores the flag entirely and always tracks. **SHOOTING ON THE MOVE**: a launched
particle inherits the CHASSIS velocity, so both archetypes lead — a turret by offsetting
`turretHeading`, a turretless one by offsetting the whole chassis heading (`leadDir`).

## Mechanism MOUNTS (`src/games/chain/mounts.ts`)

The sweeper intake and the turretless launcher can sit on any chassis edge. Robot frame
throughout: **+x = forward, +y = the robot's LEFT**.

- `RobotSpec.intakeMount`: **front · back · side (both flanks) · frontback (both ends)**.
- `RobotSpec.shooterMount`: **front · back · left · right** (no effect on a turret, which is
  top-mounted — the builder hides the picker for it).
- `intakeSide`/`shooterRear` are **DEPRECATED MIRRORS — never read them.** Use
  `intakeMountOf(spec)` / `shooterMountOf(spec)`. `coerceSpec` resolves the new field (falling
  back to the legacy boolean, so old saves migrate) and keeps the boolean MIRRORED, so a spec
  round-tripped through an older peer/server returns the nearest legal mount instead of
  resetting.
- `mounts.ts` is a **LEAF module** (imports only `types`) on purpose: the mount decides the
  collision footprint, so `src/sim/field.ts` must import it, and anything heavier would cycle.
  It owns `EDGE_ANGLE`/`EDGE_DIR`/`EDGE_PERP` (exact integer unit vectors — no `cos(π/2)`
  residue on the flanks), `edgeGeom(spec, edge) → {dist, span}`, `isEndEdge`.

**A mount moves three things together — change one, change all three:**
1. **CAPTURE** — `chainIntakeMouths(spec)` returns one robot-local rect per mounted edge (so
   `frontback`/`side` are simply two rects); `mouthContains(m, lx, ly, pad)` pads ONLY the
   outward lip. END edges span the chassis WIDTH, FLANK edges its LENGTH.
2. **COLLISION** — `footprintExtents` grows on exactly the mounted edge(s). DECODE resolves to
   `front`, so DECODE geometry is unchanged.
3. **AIM + LAUNCH** — `chainGoalAimHeading` returns `lead − EDGE_ANGLE[mount]` so the robot
   turns the MOUNTED edge at the goal; `launchAt` spreads the launch line across that edge.

The drawn intake bars ARE the grab area (renderer and `interact` share
`chainIntakeMouths`) — keep it that way.

**An IMPORTED robot** (`importMech.ts`; the shared rules are `docs/area/physics.md` "Imported
robots: mechanisms") keeps the mount enums for WHICH edge, and reads positions off the hull and
`imported.mech`: each mouth's lip is where the hull ends inside its placed span, possibly
off-centre (`intakeMouthFrame` draws it there); a turret is the placed shooter, a turretless line
is centred on the placed lip and spread no wider than the hull through it, and both release at
the placed height. The catalyst works from where the hull ends along its mount direction from the
placed base (`catalystOrigin`), so `catalystMouth`, the rail target and the rail's half-travel
(the hull's chord, less `CHAIN_RAIL_MARGIN`) all agree; the arm's reach is `24 − the hull's
extent on that axis + ring radius` (the hull already holds the sweeper), and storage reads the
hull's AREA.

## Ball storage

The manual sets no fixed particle limit (G01 unlimited control; G02 bounds them to an
18"×24"×18" CONTROL PRISM, G03 permits expanding into it), so the practical max is
VOLUME-limited. `chainStorageMax` derives it from footprint area ÷ `CHAIN_STORE_AREA_PER_BALL`
× an archetype factor × a mount factor, clamped to [1, `CHAIN_STORAGE_MAX` 122]:

- archetype — turret `0.55` (loses centre volume to the rotor+shooter), twin turret `0.42` (a
  second shooter assembly eats more), drum/dumper `1.0`.
- mount (`chainMountStoreMult`) — front == back `1.0` (mirror images; a rear sweeper is a free
  stylistic choice), frontback `0.75` (two open ends), side `0.6` (two full-length flanks).

**`CHAIN_STORE_AREA_PER_BALL` is the ONE dial for storage across the whole game** — it is the
cap's only size term, so changing it moves every archetype, mount and chassis by the same
proportion and leaves the relative trade-offs above intact. It was cut 3.6 → **2.67** for a
+35% pass (Aug 2026), with `CHAIN_STORAGE_MAX` 90 → 122, `CHAIN_STORAGE_DEFAULT` 12 → 16 and
each `CHAIN_PRESETS` `ballStorage` scaled to match; `CHAIN_STORAGE_MIN` stays 1 (a floor of one
ball is a floor, not a quantity to scale). Do NOT hand-tune the per-archetype multipliers to
change overall capacity — that silently re-balances the archetypes against each other.

The `ballStorage` slider picks any capacity up to that max; `chainHopperCap` is the ACTIVE cap
read by the sim, renderer, and HUD.

## Terrain — beams + ground clearance (`beams.ts`)

`groundClearance` (0.3–1.5", default 1.0) must be ≥ `CHAIN_BEAM_HEIGHT` 1" to cross a beam, but
more clearance RAISES the centre of gravity (`cogFactor`) and makes the drive sluggish —
`CHAIN_COG_PENALTY` 0.16 generally, and `CHAIN_COG_SWERVE_PENALTY` 0.6 on a squared curve for
SWERVE (tall modules tip and scrub). `chainStep` scales the whole movement command by
`cogFactor` BEFORE the drivetrain model.
**CoG does NOT scale PUSHING FORCE, deliberately.** It scales the COMMAND, i.e. target speed and
turn rate, not accel — so a high-clearance robot is slow but shoves at full strength. That was
checked rather than inherited: total traction is `mass · µ` whichever way the load transfers
between axles, so a raised centre of gravity costs you tipping margin and dynamic response, not
grip. Making clearance a push penalty too would be a CR balance change with no physics behind it.


**Beam crossing is modeled PER WHEEL**, not by chassis overlap: a beam drags only while one of
the four `wheelContacts` is perched on the ridge (within `CHAIN_BEAM_WHEEL_R` 2.5" of the beam
line). So a robot STRADDLING a beam (tube under the belly, all wheels down) rolls DRAG-FREE,
and a perpendicular crossing is TWO distinct bumps (front axle, then rear). Lifted wheels lose
traction: `grounded = (4−wheelsUp)/4` scales the forward retain toward
`CHAIN_BEAM_GROUND_FLOOR` 0.82. Momentum eases the climb only a little
(`CHAIN_BEAM_MOMENTUM_EASE`) — a beam ALWAYS costs speed.

**A strafing MECANUM is CURBED, not dragged** (this was revised twice from feedback — a
velocity drag let the wheel ooze onto the ridge and get stuck on top). Real mecanum climbs a
bump it drives straight at (full-diameter wheel rolls over it — which is why mecanum has the
BEST forward beam traction), but sideways force is the sum of four 45° rollers whose tiny outer
diameter cannot climb a 1" tube. So: a **pre-solve velocity wall** in `beamDrag` caps inward
speed so the leading wheel stops EXACTLY at the near face this tick, plus a **post-solve
positional clamp** `beamStrafeBlock` for numerical slop. It engages only when the crossing is
strafe-dominant (`forwardness < CHAIN_BEAM_STRAFE_BLOCK_FWD` 0.5) and there is a **STRADDLE
GUARD** so a robot already across isn't shoved back. Mecanum ONLY — tank can't strafe, swerve
steers its pods into travel, x-drive is 4-fold symmetric.

Rendering EXAGGERATES the invisible 1" tube (`CHAIN_BEAM_RENDER_H`) and bobs a crossing robot
up with a ground shadow + `CHAIN_BEAM_RUMBLE` shudder — cosmetic only; the physics footprint
stays the flat 1".

## Start poses + roles

**G04**: a robot must begin completely in the Lab Area (tile floor OR already ascended on a
corner Ring Stand). `CHAIN_START_POSES` are four named anchors — LAB·TOP, LAB·BOTTOM, RING
STAND·TOP, RING STAND·BOTTOM — CANONICAL for BLUE and x-MIRRORED for RED (`chainStartPose`).
The anchors are legal by construction for a standard chassis (an import's are fitted, see
"AN IMPORTED ROBOT'S START" below). Starting on a stand ARMS the auto-descent award
(`descentArmed`).

**FREE PLACEMENT — `src/ui/ChainStartEditor.tsx`** (the CR twin of DECODE's
`StartPositionEditor`, replacing the old slider-and-buttons `ChainStartSelector`): a canvas
stage running the REAL `drawChainField` / `drawChainRobot`, drag to place, a heading handle,
numeric X/Y/heading, live legality, and the four anchors as quick-picks. It reuses every
`ds-startpos-*` style, so there is no new CSS for the contrast/shift audits. Rules of the
seam:
- `chainEvalStart(spec,pos)` is the verdict + its REASON (`inLab` / `clearOfStand`), and its
  `legal` is the `chainSnapStart` round-trip the SPAWN runs — never a re-derivation, so the
  ring can't disagree with where the robot actually starts. `extent` is the conservative,
  rotation-agnostic half-extent the rules test, and the editor draws THAT box (not a rotated
  footprint) so a red ring always explains itself. Heading is therefore always free.
- `chainMirrorStart(pose,a)` is canonical↔actual, SELF-INVERSE, mirroring `chainStartPose`.
  Poses are stored CANONICAL, so a placement survives an alliance switch.
- **Snap defaults ON and snaps LIVE during the drag** (DECODE's defaults OFF). G04 plus the
  solid corner assembly leave a narrow legal band — at the widest chassis
  `CHAIN_RINGSTAND_BOX <= CHAIN_LAB - 2*half-extent` is nearly tight — so free-dragging would
  paint almost every drop red. Live snapping makes the robot glide along the legal band.
- **No saved-pose library** (unlike DECODE). `GameSettings.savedStartPoses` is ONE canonical
  list shared across games; a CR pose saved into it would show up unreachable in DECODE's
  Close/Far library. Adding one means namespacing that setting first.
- `startSelectionLegal(game, spec, alliance, pose)` in `src/ui/startPositions.ts` is the
  ready-up / start gate for BOTH games (DECODE G304 via `activeStartLegal`, CR G04 via
  `chainStartLegal`). CR used to be waved through as "legal by construction" — free placement
  ended that.

**AN IMPORTED ROBOT'S START** (integration review 2026-10-02). Its origin is the wheelbase centre,
so its hull's box is OFF-CENTRE, and up to 18 in:
- `chainStartExtents` returns the box's half-extents AND its centre offset (`ox`, `oy`; 0 for a
  standard robot), and every rule (`chainStartLegal`, `chainSnapStart`, `chainEvalStart`) is
  written against the box centre `pos + o`, never the origin. Half-extents "about the origin"
  started a long nose 3 in outside the Lab, a long tail 3 in into the ring stand, and found no
  legal pose at all for an 18-in hull 3 in off-centre.
- ⚠️ **RED IS JUDGED ON ITS HULL FLIPPED LEFT FOR RIGHT.** Poses are canonical (blue) and red's is
  the x-REFLECTION; a reflection is not a rotation, so red's real footprint is the reflected
  canonical footprint of the y-flipped hull. Every start function takes the alliance (default
  blue, which is all a standard robot ever needs) and `CHAIN_SIM.startLegal` passes it.
- The anchors are fitted to the hull (`chainFitAnchor`, called by the spawn AND the editor, so the
  robot starts where it is drawn). A STAND anchor stays one: if the fit at the anchor's heading
  leaves ascend range, the quarter turns are tried for a legal fit still at the stand.
- An 18 × 18 hull has no room for the 0.5-in margin (the reason the builder caps at 17): it is
  never `chainStartLegal`, and the snap seats it FLUSH against the post rather than in it.
- The editor draws the tested box where the rule puts it plus the hull inside it; a centred
  `length × width` rectangle was neither. The heading handle sits past the hull's front
  (`startHandleReach`), and the preview key carries the import.
- A beam holds a no-clearance import at the hull's extent TOWARD the beam (`rotatedPolyBounds`
  by side), not `max(half, front, rear)`, which teleported a short-tailed hull 6.4 in.

**CR roles are TOP / BOTTOM** (which Lab corner), NOT DECODE's CLOSE / FAR. The shared
`StartCat` slots carry them (close = TOP y≥0, far = BOTTOM y<0) via `chainAnchorCat` /
`chainDefaultIndex` / `chainRoleLabel`, so a locked role limits the selector to that corner's
floor + ring-stand anchors and two alliance robots never stack.

## Penalties (`src/games/chain/penalties.ts`)

Only the runtime CONTACT rules are modeled, and all are **MAJOR**, awarded to the victim:

- **G06** — during AUTO, contacting an opponent COMPLETELY within its own Alliance Section (its
  half, EXCLUDING the neutral Particle Zone diamond) → MAJOR on the aggressor.
- **G05** — during ENDGAME, contacting an ASCENDING opponent → MAJOR.

Edge-triggered via `chain.foulEdge` (same discipline as DECODE: fire on the false→true edge,
once while held, again on re-entry) and cleared outside auto/teleop. G01–G04 are structurally
enforced; G07 (de-score) is legal — you can lift a ring off EITHER goal's hook. G02 plowing,
G08, G09 are intentionally not modeled.

## CR pipeline order (`chainStep`)

resolve commands → `chainAimAssist` rotate override → CoG scaling → shared drivetrain/motor
(`updateRobot`) → Rapier + wall containment → `updateChain` (particles, intake, shooter,
accelerator score/recycle, catalysts, endgame) → `updateChainPenalties` → phase/timer machine.
It DELIBERATELY skips DECODE's `updateRobotActions`, goals/gates, penalties, and scoring — CR
owns all of that.

---

