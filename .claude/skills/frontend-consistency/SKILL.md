---
name: frontend-consistency
description: Audit and enforce frontend design consistency on any website — run a live-DOM audit (typography/color/spacing token sprawl, component style clusters, WCAG contrast, focus-visible, mobile overflow) and style pages to a per-site design contract instead of the generic AI look. Use when asked to audit/review a site's design, check UI consistency, restyle something so it looks less generic/AI-generated, or verify a frontend change didn't drift from the design system.
---

# Frontend consistency

Two halves, use both:

1. **Design** — before styling anything, read [design-guide.md](design-guide.md):
   the per-site design contract (modeled on this repo's Stitch-generated
   [DESIGN.md](../../../DESIGN.md)), the catalog of recognizable AI-generated
   patterns with replacements, and the fit-to-site principles. No one-size-fits-all:
   the contract decides, the audit measures against it.
2. **Measure** — `audit.cjs` (this directory) loads real URLs in Electron and
   reports whether the live DOM behaves like ONE system.

## Run the audit (verified on this machine)

Needs an `electron` devDependency (this repo has one; elsewhere `npm i -D electron`).
On Windows use **PowerShell**, and the `--` before URLs is **required**:

```powershell
& ".\node_modules\.bin\electron.cmd" ".claude\skills\frontend-consistency\audit.cjs" -- https://example.com/
```

Multi-page (cross-page drift is only measured with 2+ URLs) with kept output:

```powershell
$env:FCA_OUT = "C:\path\to\outdir"
& ".\node_modules\.bin\electron.cmd" ".claude\skills\frontend-consistency\audit.cjs" -- http://localhost:4173/ http://localhost:4173/configure/robot http://localhost:4173/records
```

To audit THIS repo's app first: `npm run build`, then `npx vite preview --port 4173`
in another shell.

- Env knobs: `FCA_OUT` (output dir; default temp, printed at boot), `FCA_SETTLE`
  (ms after load, default 1500), `FCA_MAX_FOCUS` (focus samples/page, default 12),
  `FCA_MOBILE=0` (skip 375px pass).
- Outputs in `FCA_OUT`: `report.txt`, `report.json`, `p<N>-desktop.png` /
  `p<N>-mobile.png` per page. **Look at the screenshots** — a blank page means
  the site didn't render and the numbers are garbage.
- Exit **1** = accessibility-floor FAIL (WCAG contrast, no visible focus style,
  mobile horizontal overflow) — fix regardless of design intent. Exit **0** may
  still carry WARNs.

## Interpreting the report

WARNs are heuristics, adjudicated by the site's design contract (see
design-guide.md §4): 18 font sizes is sprawl almost anywhere; near-duplicate
colors may be a deliberate tonal surface ladder (they are in this repo);
button-style clusters count DISTINCT computed looks per page — intended variants
(primary/ghost/danger) are a handful, a long tail of one-offs is drift.
`CROSS-PAGE DRIFT` lists token values used on exactly one page.

## Gotchas (all hit in this session)

- **Agent shells export `ELECTRON_RUN_AS_NODE=1`** (VS Code / Claude Code),
  which makes Electron boot as plain Node and `require('electron').app` come
  back `undefined`. The driver detects this and respawns itself clean — don't
  "fix" the TypeError by editing the require.
- **electron.exe exits -1 silently when passed 2+ bare URL args** (its shell
  tries to open them). The `--` separator prevents it; the driver also inserts
  `--` when respawning. One URL happens to work, which makes this look flaky —
  it isn't.
- **Git Bash on Windows intermittently 127s multi-URL electron invocations**
  even with correct args. Use PowerShell for the invocation; Bash is fine for
  servers (`npx vite preview`).
- The Electron window is real and takes focus on the desktop — not headless.
- Main frame only: iframes are invisible to the audit. Contrast checks skip
  text over `background-image` (pixels unknowable from computed style).
- Theme: a fresh Electron profile resolves the OS theme. This repo's app reads
  `localStorage['decodesim.theme']` — same trick as `scripts/shiftaudit.cjs`
  if you need to force one.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `TypeError: Cannot read properties of undefined (reading 'disableHardwareAcceleration')` | `ELECTRON_RUN_AS_NODE=1` leaked and the respawn guard was removed — restore it (top of audit.cjs) |
| Instant exit -1/255, zero output | URLs passed without `--` — add it |
| Exit 127 from Bash, zero output | Git Bash flake — rerun from PowerShell |
| Report says 0 elements / blank screenshot | Page didn't render in `FCA_SETTLE` ms — raise it, and check the URL serves without auth |
