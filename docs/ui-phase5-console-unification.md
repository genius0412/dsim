# UI Phase 5 — Unify the full-screen "console" surfaces

**Status: DONE.** §5, §6 and §8.1 landed in `23906fe`; §8.2 (Escape) landed after it.
§9 verified: `npm run build` + `npm test` green, and an Electron drive of `/record`,
`/ranked`, `/lobby` confirms `.ds-console` + `.ds-console-in` with no `.ds-app`/`.ds-main`,
a `<Logo>` mark on each, and Esc backing out to `/modes` on all three.

Two deltas from the plan as written, both deliberate:

- **`.ds-console-in` uses `maxWidth: 520`, not the 460 §4 suggested** — it matches Lobby
  exactly, which is the whole point of the phase.
- **Both screens render through a local `page(title, sub, body)` helper** rather than
  inlining the scaffold twice per file.

**Blast radius:** `src/ui/` only · **Sim:** untouched (`npm test` is a canary, not a target)

Part of the low-poly UI redesign. Phases 1–4 and most of 6 are landed; this is one of
the two remaining pieces (the other is [Phase 6](./ui-phase6-accessibility.md)).

---

## 1. Goal

There are four **full-screen, shell-less surfaces** — screens that take over the whole
viewport with no top bar and no nav rail, because they own a modal task (connect, queue,
ready up) with their own back/Esc semantics:

| Screen | File | Scaffold today |
|---|---|---|
| Custom room lobby | `Lobby.tsx:170`, `:280` | `.ds-console` ✅ |
| Duo record lobby | `Lobby.tsx` (same, `config.kind='record'`) | `.ds-console` ✅ |
| Pre-match strategy | `MatchStrategy.tsx:115`, `:145` | `.ds-console` ✅ |
| **Record run launcher** | **`RecordRun.tsx:113`, `:139`** | **`.ds-app` + `.ds-main` ❌** |
| **Ranked matchmaking** | **`Matchmaking.tsx:199`, `:247`** | **`.ds-app` + `.ds-main` ❌** |

Move the two ❌ rows onto `.ds-console`, so one scaffold serves every modal surface.

---

## 2. Correcting the original plan's premise

> The approved plan says: *"stops two elements both claiming `height:100vh; overflow-y:auto`."*

**That is false, and the doc should not repeat it.** `App.tsx` returns these screens
**early**, before `AppShell` is ever constructed:

```
App.tsx:288   if (screen === 'game')        return <GameView …/>
App.tsx:302   if (screen === 'lobby')       return <Lobby …/>
App.tsx:314   if (screen === 'record')      return <RecordRun …/>      ← self-wraps .ds-app
App.tsx:328   if (screen === 'duorecord')   return <Lobby …/>
App.tsx:341   if (screen === 'matchmaking') return <Matchmaking …/>    ← self-wraps .ds-app
App.tsx:356   if (screen === 'replay' …)    return <ReplayView …/>
App.tsx:378   return <AppShell …>                                      ← the only other .ds-app
```

Exactly one `.ds-app` is mounted at any time. There is no double-scroll-container bug.
Do the migration for the three reasons below instead — and if none of them convinces you,
**don't do it**, because the current code is not broken.

---

## 3. The three real reasons

### R1 — A visible scaffold swap mid-flow (the only user-facing defect)

`Matchmaking` renders inside `.ds-app`. The moment a match pairs, it hands the entire
screen to `MatchStrategy` (`Matchmaking.tsx:226-244`), which renders inside `.ds-console`.
The two scaffolds do not look alike:

|  | `.ds-app` (`shell.css:110`) | `.ds-console` (`shell.css:1392`) |
|---|---|---|
| background | flat `var(--ds-bg)` | `var(--ds-bg)` **+ a mint radial gradient** at 50% −8% |
| content width | `.ds-main` `max-width: 1080px` | `.ds-console-in` `min(900px, 94vw)` |
| padding | `28px 22px 48px` | `26px 0 72px` |
| box-sizing | inherited | **reset to `border-box`** for the whole subtree |

So at the instant a ranked match is found, the background gains a mint glow and the
content column narrows by 180px. That is a flash the player sees, every ranked match.

### R2 — Shell classes used outside the shell

`.ds-main` is defined as the shell's **content column**: `flex: 1` (it expects to be a
flex child of `.ds-body`, next to the rail), `max-width: 1080px`, `min-width: 0` (so
tables shrink instead of stretching the rail row). `RecordRun` and `Matchmaking` use it
with no rail, no `.ds-body`, and then override it inline:

```tsx
<main className="ds-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
```

`display: grid` discards the `flex: 1`. `place-items: center` fights the 1080px
`margin: 0 auto`. The inline `minHeight: 70vh` exists only because `.ds-main` has no
height of its own outside the shell. Every property in that style attribute is
compensating for a class that does not belong here.

### R3 — Coupling: the rail can silently deform two screens it doesn't own

`.ds-main`'s `flex: 1` / `min-width: 0` exist **for the rail row**. The next time the
rail's sizing changes, these two shell-less screens change too, for no reason, and
nothing in either file hints at the dependency. This is the maintenance argument, and
it's the strongest one.

---

## 4. Target scaffold

```
.ds-console                      min-height:100vh; height:100%; overflow-y:scroll
│                                bg = radial mint glow + --ds-bg; box-sizing reset
└── .ds-console-in               width:min(900px,94vw); margin:0 auto
    │                            padding:26px 0 72px; flex column; gap:22px
    ├── .ds-head                 flex row, gap 14px, wrap
    │   ├── button.ds-back       "← Back" / "← Leave"
    │   └── span.ds-mark         <Logo size={24}/> + APP_NAME
    ├── .ds-title > h1           clamp(26px,4vw,40px); <span class="accent"> for the tinted word
    ├── p.ds-sub                 usually style={{marginTop:-10}}
    ├── .ds-panelbox             (optional) the bordered form card — Lobby's entry screen
    ├── section.ds-sec           (repeatable) > h2 + content
    ├── .ds-actions              the CTA row
    └── p.ds-hint                trailing helper copy
```

`.ds-console-in` accepts a narrower `style={{ maxWidth: 520 }}` for form-shaped screens
(`Lobby.tsx:171` already does this). Both migrated screens are form/status shaped, so
**use `maxWidth: 460`** to preserve their current measure.

> `.ds-console` already sets `overflow-y: scroll` (not `auto`) for the same reason
> `.ds-app` does: a centered inner column must not slide sideways by half a scrollbar
> when content grows past the viewport. Don't "clean that up".

---

## 5. Migration — `RecordRun.tsx`

Two returns. Both currently open with `.ds-app` + `.ds-main` + a centered `<div>`.

### 5a. Server picker (`RecordRun.tsx:111-136`)

```tsx
// BEFORE
<div className="ds-app">
  <main className="ds-main" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
    <div style={{ textAlign: 'center', maxWidth: 460 }}>
      <p className="ds-eyebrow">Record Run · {mode === 'duo' ? 'Duo 2v0' : 'Solo 1v0'}</p>
      <h1 className="ds-h1">Choose a server</h1>
      …
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="ds-btn ghost" onClick={onCancel}>← Back</button>
        <button className="ds-btn" onClick={() => setConfirmed(true)}>Start run →</button>
      </div>
    </div>
  </main>
</div>
```

```tsx
// AFTER
<div className="ds-console">
  <div className="ds-console-in" style={{ maxWidth: 460 }}>
    <div className="ds-head">
      <button className="ds-back" onClick={onCancel}>← Back</button>
      <span className="ds-mark"><Logo size={24} />{APP_NAME}</span>
    </div>
    <div className="ds-title">
      <h1>Record <span className="accent">Run</span></h1>
    </div>
    <p className="ds-sub" style={{ marginTop: -10 }}>
      {mode === 'duo' ? 'Duo 2v0' : 'Solo 1v0'} · pick the region with the lowest ping.
      We'll remember your choice.
    </p>
    <div className="ds-panelbox">
      <ServerPicker value={pick} onChange={(id) => { setPick(id); onPreferServer?.(id); }} />
      <div className="ds-actions">
        <button className="ds-cta" onClick={() => setConfirmed(true)}>START RUN ▶</button>
      </div>
    </div>
  </div>
</div>
```

Notes:
- `← Back` moves from a bottom button into `.ds-head`, matching Lobby. The bottom
  `.ds-btn ghost` disappears; **`onCancel` must stay wired**, it's the only exit.
- The `.ds-eyebrow` line is absorbed into the `.ds-title` + `.ds-sub` pair. Console
  screens don't use `.ds-eyebrow` (Lobby/MatchStrategy don't).
- `.ds-h1` → `.ds-title > h1`. They are different rules (`shell.css:575` vs `:1474`);
  the console one is a plain `h1` selector and takes `.accent`.
- `Start run →` becomes `.ds-cta` (pill CTA), consistent with `CREATE ROOM ▶`.

### 5b. Connecting / error (`RecordRun.tsx:138-161`)

Same envelope. Keep the `error ? … : …` branch verbatim inside `.ds-panelbox`; render
the error through `<p className="ds-form-err">⚠ {error}</p>` as Lobby does
(`Lobby.tsx:251`) rather than an `.ds-sub`, so failures read as failures. Keep the
"first run after a quiet spell waits a few seconds for the server to wake" copy — it's
load-bearing (cold-boot Rapier WASM, `RecordRun.tsx:62-68`).

### 5c. Imports to add

```ts
import { APP_NAME } from '../seasons';
import { Logo } from './Logo';
```

---

## 6. Migration — `Matchmaking.tsx`

Two returns to convert (`:197-223` signed-out, `:246-323` queue). The `strategy` branch
at `:226-244` returns `<MatchStrategy>` and is **already correct** — leave it alone.

- **Signed-out** (`:199`): `.ds-console` / `.ds-console-in` `maxWidth: 460`, `.ds-head`
  with `← Home`, title `Ranked`, `.ds-panelbox` holding the sign-in `.ds-cta`.
- **Queue** (`:247`): same envelope. Title becomes
  `{searching ? <>Finding a <span className="accent">match…</span></> : <>Ranked <span className="accent">matchmaking</span></>}`.
  Wrap the mode segs + presence line + `Only my region` opt + CTA in one `.ds-panelbox`.
  The `.ds-segs` / `.ds-opts` / `.ds-form-err` / `.ds-hint` classes are already
  console-native and need no change.
- The searching branch's two buttons (`Expand search`, `Cancel`) go into `.ds-actions`.

**Do not** move `wireStrategy`, `find`, `joinAssignedMatch`, `teardown`, or the
`useEffect(() => teardown, [])`. This is a JSX-only change.

Once both branches are `.ds-console`, **R1 disappears**: the handoff to `MatchStrategy`
keeps the same background, gradient, and column width.

---

## 7. Explicitly out of scope

- **No nav rail on these screens.** They are modal tasks with their own back semantics,
  and `Matchmaking` surrenders the whole screen to `MatchStrategy` when paired — a rail
  would offer navigation out of a match that's already counting down.
- **No retint of `.ds-console`.** The plan called for this ("retint the dark radial
  gradient for light"), but it was already done in Phase 1: `shell.css:1398-1400` is
  now `radial-gradient(… color-mix(in srgb, var(--ds-accent) 10%, transparent) …)` over
  `var(--ds-bg)`. Nothing to do.
- **No changes to `Lobby` or `MatchStrategy`**, beyond §8 if you take it.

---

## 8. Two consistency bugs worth fixing while you're in here

Both are pre-existing, cheap, and in the blast radius anyway.

1. **`Lobby` renders its brand mark two different ways.** `Lobby.tsx:177` uses
   `<Logo size={24} />`; `Lobby.tsx:287` uses `<span className="glyph">D</span>`, as
   does `MatchStrategy.tsx:121`. The `glyph` span is the pre-`Logo.tsx` fallback.
   Standardize on `<Logo size={24} />` in all four places.

2. ~~**Only `Lobby` handles Escape**~~ — **DONE.** Lifted into `src/ui/useEscape.ts` and
   used by `Lobby`, `RecordRun`, and `Matchmaking`. Esc is defined as a shortcut for
   whatever the visible `.ds-back` button does, never a second exit path.

   `MatchStrategy` **deliberately has no Esc** (commented in its docblock): `onLeave`
   forfeits a paired ranked match for the whole room, so it stays a deliberate click.
   For the same reason `Matchmaking` passes `enabled: !strategy` — once it hands the
   viewport to `MatchStrategy`, the parent's Esc must not reach past the child and
   forfeit. That `enabled` flag is the whole reason the hook takes a second argument.

---

## 9. Verification

```sh
export PATH="$HOME/.nvm/versions/node/v26.5.0/bin:$PATH"   # node lives in nvm only
npm run build     # tsc strict + vite
npm test          # ~205 smoke checks — MUST stay green; a failure means you left src/ui
```

Then drive the real UI (the `verify` skill's recipe):

```sh
npx vite preview --port 4173      # SPA fallback, real URL routing
env -u ELECTRON_RUN_AS_NODE npx electron <driver>.cjs   # driver must live inside the repo
```

Manual checks:

1. `/record` → server picker (multi-region only) → connecting screen. Back button exits
   to `/modes`. Cold-boot retry copy still shows.
2. `/ranked` signed out → sign-in card. Signed in → queue → **watch the background
   through the pairing handoff**: the mint gradient and the 900px column must not jump
   when `MatchStrategy` mounts. This is the regression R1 was about, and it's the one
   thing a screenshot diff will catch.
3. `/lobby` and `/duo-record` unchanged (they were already `.ds-console`).
4. Re-run the layout-shift auditor — now `scripts/shiftaudit.cjs` (`npm run shiftaudit`), not
   a scratchpad file. **Done in Phase 7b: 888 state changes · 0 shifts, both themes.** Note it
   had been silently SKIPPING the live HUD since this phase landed: its in-game navigation
   clicked `.ds-menu-btn` / `.ds-tile`, the very classes this phase deleted, so it logged
   `canvas=false` and moved on. Fixed to match on button text.
   Still open: `/record` and `/ranked` are absent from its `PAGES` array. Both are gated on
   `gameServerConfigured()`, so covering them needs a preview build with `VITE_GAME_SERVER_URL`.

Both `.ds-app` and `.ds-console` use `overflow-y: scroll`, so no new scrollbar-driven
horizontal shift can appear — but confirm anyway, since that bug shipped once already.
