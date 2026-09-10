---
name: verify
description: Drive the built DECODE sim GUI via Electron and capture screenshots — use to verify UI/game changes at the real surface (menu, HUD, in-game input).
---

# Verifying this app end-to-end

Two surfaces:

1. **Sim core** (`src/sim/`, `src/config.ts`): `npm test` (scripts/smoke.ts) IS the
   runtime surface — it drives full worlds headlessly. Add a check per behavior change.
2. **GUI** (menu, HUD, input, audio wiring): drive the real app via Electron.

## Electron GUI drive recipe (no Playwright needed)

- **`ELECTRON=1 npm run build` — NOT a bare `npm run build`.** `vite.config.ts` sets
  `base: '/'` by default (the web build); under `file://` that makes the bundle's
  `/assets/index-*.js` resolve to the filesystem root and 404 **silently** — no console
  error, no failed-load event, just a permanently blank white window (`#root` stays
  empty forever). `ELECTRON=1` switches to a relative `./` base, matching what `npm run
  dist`/`npm run electron` already do. If a screenshot comes back blank, check this
  BEFORE assuming the app broke — `document.body.innerHTML.length` staying tiny (~30
  chars, just the empty `<div id="root">`) confirms it's this, not your change.
- Electron loads `dist/index.html` (see `electron/main.cjs`).
- Write a driver script (CJS) in the scratchpad and run `npx electron <script>`.
- **Gotchas (Windows, this machine):**
  - Agent shells export `ELECTRON_RUN_AS_NODE=1`, which makes a bare `npx electron
    script.cjs` run the script as plain Node — `app`/`BrowserWindow` are `undefined`.
    Unset it for the invocation: `env -u ELECTRON_RUN_AS_NODE npx electron script.cjs`.
  - `electron` must resolve `require('electron')` from a real `node_modules` — a driver
    script living outside the repo (e.g. the session scratchpad) fails with
    `Cannot find module 'electron'`. Put the script inside the project directory
    (delete it when done) rather than the scratchpad.
  - `capturePage()` throws `UnknownVizError` unless you call
    `app.disableHardwareAcceleration()` AND
    `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`,
    and `win.show(); win.focus();` before capturing.
  - Set `webPreferences: { backgroundThrottling: false }` or rAF (the game loop) stalls.
  - React: never `.click()` two buttons in one `executeJavaScript` call — the second
    handler sees stale props (state batching). One click per call, ~120 ms apart.
- Drive with `executeJavaScript`: `element.click()` works on React buttons;
  `window.dispatchEvent(new KeyboardEvent('keydown', {key:'j', bubbles:true}))`
  reaches both the menu capture listeners and the in-game `Keyboard` class
  (send a matching `keyup` to release held keys).
- Observe via DOM: hopper pips `.hopper-pip` (class `empty`), HUD chips `.chip`
  (text REVERSED / GATE OPEN), keycaps `.keycap`, and
  `localStorage['decodesim.settings.v1']` for persistence.
- Clean up: `localStorage.removeItem('decodesim.settings.v1')` at the end so the
  run doesn't leave test bindings on the user's machine.

Working example from a past session: rebind fire→J, check steal/UNBOUND, reload for
persistence, ENTER FIELD in Free Drive + Robot-centric, hold J to fire (pips empty),
press F for the REVERSED chip.

## Contact sheets: `scripts/shots.cjs` (the BIOBUZZ gallery)

A second, cheaper surface than driving the app: a DEV ROUTE that renders many worlds as
stills, screenshotted in both themes into one contact sheet. Use it whenever a change
touches a renderer, a sprite, a mount or a piece of ball physics — it is the only way to
see twenty-six robot builds at once, and reading the PNGs afterwards is the point of it.

```bash
npm run dev
npx electron scripts/shots.cjs
```

Output: `scratch/shots/<short-sha>[-dirty]/<cell>.<theme>.png` plus an `index.html`
contact sheet (one row per cell, one column per theme). `scratch/` is gitignored, so a
run never shows up in a commit.

Flags: `--scene a,b` (only those cells), `--theme dark`, `--port <n>` (default 4173, i.e.
`npm run preview`; pass `5173` for `npm run dev`), `--path <route>` (default
`/biobuzz/gallery`), `--out <dir>`.

- **`--path` needs `MSYS_NO_PATHCONV=1` in Git Bash.** MSYS rewrites a leading-slash
  argument into a Windows path, so `--path /biobuzz/gallery` arrives as
  `C:/Program Files/Git/biobuzz/gallery` and the load fails with `ERR_INVALID_URL`.
- **Before `devRoutes` is wired**, mount the gallery yourself: a gitignored
  `scratch/gallery.html` + `scratch/gallery.tsx` that `initTheme()`, awaits
  `initPhysics()` and renders `<BiobuzzGallery />`, then
  `npx electron scripts/shots.cjs --port 5173 --path /scratch/gallery.html`.
- **`capturePage(rect)` CLIPS to the viewport, silently.** A cell taller than the window
  loses its bottom in the PNG with no error, and the window cannot exceed the display's
  work area (the OS clamps it) — so cells are laid out to fit a laptop screen. If a
  screenshot looks cropped, that is this, not a CSS bug.
- The run FREEZES animations (an injected stylesheet) and forces an explicit theme via
  `localStorage['decodesim.theme']`, removing it afterwards — so a sheet is comparable
  between runs and does not leave a theme behind.
- Exits non-zero when it captured nothing, and says so when the dev route is not mounted.

### What the sheet is for — read these cells

- `settle-60@0` vs `@300` — a NULL TEST. The two must be the SAME picture; if the field
  drifts, the ball solver is not at rest.
- `pile-slow/med/fast@30..120` and `corner-pile` — a POLLEN must never end up inside a
  chassis. This is how the plow's fixed-step push was caught (a robot at 80 in/s gained
  on the ball every tick and eventually contained it).
- `intake-line@45..240` — the hopper count in the caption must step up exactly as pollen
  vanish from the line: the drawn mouths ARE the capture areas.
- `launch-wall-bounce@20..240` — where pollen leave from, the arc, and the wall bounce.
- `archetype-<mode>-<mount>@0` — 26 sheets, three chassis sizes each, canvas sprite beside
  the builder's SVG preview. If two DIFFERENT mounts render the same picture, a coercer is
  resetting the mount (exactly what a missing `coerceSpec` game arm does).

### Measure, don't squint

A 300px cell will not tell you whether a penetration is 0.1" or 1.5". When a picture looks
wrong, write a throwaway `scratch/*.ts` and print the number — `npx tsx scratch/x.ts`,
with `await initPhysics()` at the top and `bbSceneAt(scene, tick)` to rebuild the exact
world a cell shows. That is what turned "those balls look like they are in the robot" into
a one-line fix.
