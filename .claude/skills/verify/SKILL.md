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

- `npm run build` first; Electron loads `dist/index.html` (see `electron/main.cjs`).
- Write a driver script (CJS) in the scratchpad and run `npx electron <script>`.
- **Gotchas (Windows, this machine):**
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
