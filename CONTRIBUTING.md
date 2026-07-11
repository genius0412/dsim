# Contributing to DECODE 2D Simulator

Thanks for your interest in contributing! A few things to know before you send a pull
request.

## Contributor License Agreement (required)

This project requires every contributor to agree to the
[Contributor License Agreement](./CLA.md) (CLA) before their contribution can be merged.

**Why:** the CLA lets the project be maintained and, in the future, offered under
commercial terms (ads, in-app purchases) without having to re-contact every past
contributor. You keep ownership of your work — the CLA is a license, not a sale. Read
[`CLA.md`](./CLA.md) for the exact terms.

### How to sign

Until an automated CLA bot (e.g. [CLA Assistant](https://cla-assistant.io/)) is wired up,
sign manually:

1. Read [`CLA.md`](./CLA.md) in full.
2. Add a line for yourself to [`CONTRIBUTORS.md`](./CONTRIBUTORS.md) in the same pull
   request as your first contribution, in this format:

   ```
   - Full Name <email> — GitHub @handle — signed CLA YYYY-MM-DD
   ```

3. In your pull request description, include the sentence:

   > I have read and agree to the Contributor License Agreement (CLA.md).

That statement plus your entry in `CONTRIBUTORS.md` is your signature. Your PR will not be
merged until it's present.

## Development

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm test           # headless sim verification (run after any src/sim or config change)
npm run build      # tsc (strict) + vite build — must pass before a PR is "done"
```

See `CLAUDE.md` for the full architecture, invariants, and command reference.

## Ground rules

- Run `npm test` and `npm run build` before opening a PR; keep both green.
- Keep `src/sim/` a pure, deterministic state machine (no DOM, clock, `Math.random`, or
  `Date`) — see `CLAUDE.md`.
- Match the style, naming, and comment density of the surrounding code.
