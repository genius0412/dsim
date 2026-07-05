# DECODE 2D Simulator

A 2D top-down driver-practice simulator for the FIRST Tech Challenge 2025–26 game
**DECODE presented by RTX**. Drive an 18×18 in mecanum robot with a front intake and a
turreted flywheel shooter, and play a full solo match with faithful DECODE scoring.

## Features

- **Faithful field**: 12×12 ft field, corner goals with 9-slot classifier ramps, gates,
  secret-tunnel returns, obelisk motif display, launch zones/lines, loading zones,
  depot, base zones, and all 24 purple + 12 green artifacts in official spawn layout.
- **Full match flow**: 30 s AUTO → 8 s transition → 2:00 TELEOP with live scoring —
  classified (3), overflow (1), pattern (2/slot vs the randomized motif), leave (3),
  depot (1), base return (5/10).
- **Realistic robot**: mecanum wheel-saturation kinematics with real-motor speed and
  acceleration, turret mounted behind the center of rotation with an exact
  lead-compensated aim solution (the shooter never misses), burst fire, physical goal
  basin + flowing classifier with a flow-held gate.
- **Driver options**: red/blue alliance viewed from your own drive-team wall,
  field-centric or robot-centric driving, aim assist / auto intake / auto fire
  configured in the menu, keyboard and gamepad input, configurable chassis size and
  intake style (compact vs extended) within the 18 in FTC limit.

## Run it

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the production build
```

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Drive / strafe | WASD | Left stick |
| Turn | Q / E or ◄ / ► | Right stick X |
| Intake (hold) | Shift or K | LT / B |
| Shoot | Space | RT / A |
| Start match | Enter | Start |
| Restart | R | Back / Select |
| Menu | Esc | — |

Drive style, aim assist, auto intake, and auto fire are configured in the main menu.

## Deploy to Vercel

The app is a static Vite build — import the repo into Vercel and it deploys with zero
configuration (framework preset: Vite, output `dist/`).

## Desktop app (Electron)

```bash
npm run electron   # run the desktop shell against the current build
npm run dist       # package a Windows installer into release/
```

## Architecture notes

`src/sim/` is a pure, deterministic, serializable state machine — it consumes per-tick
`RobotCommand`s keyed by robot id plus a seeded PRNG, and never touches the DOM or the
clock. Rendering (`src/render/`), input (`src/input/`), and the React UI (`src/ui/`)
sit on top. Adding more robots (2v2 multiplayer) means adding `RobotState`s and
command sources; the physics, scoring, and match flow already handle any robot count.

`npx tsx scripts/smoke.ts` runs a headless verification of the sim (spawn layout,
drive ratios, classification, gate, intake, match phases, scoring).
