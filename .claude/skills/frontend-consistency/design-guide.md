# Frontend consistency — design guide

The audit (`audit.cjs`) measures whether a site behaves like ONE design system.
This guide is the other half: how to DECIDE what that system is, so the numbers
have something to be consistent WITH — and so the result doesn't look like every
other AI-generated page.

## 1. The root cause of generic ("AI slop") frontends is NO DECISION

A model asked to "make it look good" falls back to the statistical average of
its training data: Inter, indigo-500 gradients, identical rounded cards, dark
mode with glowing accents. The average of all websites belongs to no website.
The fix is not taste — it is **committing decisions to writing before styling
anything**, then holding every screen to them.

## 2. The per-site design contract (Stitch-style `DESIGN.md`)

This repo's own [DESIGN.md](../../../DESIGN.md) (generated with Google Stitch)
is the worked example. Every site you style should get one, committed at the
repo root, written BEFORE the first component. Its structure:

**YAML frontmatter — the tokens (machine-checkable):**
- `colors:` — full role palette with paired inks (`primary`/`on-primary`,
  `surface`/`on-surface`, tonal surface ladder, error pair). Pairing every fill
  with its ink is what makes contrast auditable.
- `typography:` — named ROLES (`display-lg`, `headline-lg`, `body-md`,
  `label-sm`), each with family/size/weight/line-height. Roles, not ad-hoc
  sizes: the audit counts distinct sizes, and a role table keeps that set closed.
- `rounded:` — a radius scale (sm → full), 3-5 steps.
- `spacing:` — a base rhythm (4 or 8px) plus named steps and page margins.

**Prose sections — the decisions (human-checkable):**
- **Brand & Style** — one paragraph naming the personality and the direction
  ("indie-game tactile minimalism", NOT "clean and modern").
- **Colors** — what each role is FOR, and where the palette deliberately breaks
  (DSIM: pastels everywhere, high-contrast red/blue reserved for win/loss).
- **Typography** — why each face, and the division of labor (DSIM: Plus Jakarta
  Sans workhorse, Space Grotesk only for technical labels).
- **Layout & Spacing** — the rhythm and grid, per breakpoint.
- **Elevation & Depth** — the ONE depth model (DSIM: hard offset "block"
  shadows + keycap edges; explicitly NOT blurry realistic shadows).
- **Shapes** — the shape language and where each radius step applies.
- **Components** — per component, the look AND the interaction behavior
  ("on click, moves down 3px to meet its shadow").

A contract this specific overrides the model's statistical pull; a vague one
("modern, accessible") does nothing. When a later change conflicts with the
contract, either follow the contract or amend it in the same commit — never
silently diverge (that divergence is exactly what the audit flags).

## 3. Recognizable AI tells → what to do instead

No element is banned in the abstract — each is a tell because it appears
REGARDLESS of what the site is. Replace it with a decision that could only
belong to THIS site.

**Structure & layout**

| Tell | Replace with |
|---|---|
| Icon-in-rounded-tile stacked above heading, ×3 identical feature cards | Vary card sizes/structures; icon beside heading, or none |
| Thick colored accent border on one side of a rounded card | A subtler cue from the contract's depth model, or nothing |
| Hairline border + wide diffuse shadow on the same card | Commit to ONE: defined edge or soft elevation |
| Nested cards (containers in containers) | Flatten: spacing, typography, dividers |
| Hero = eyebrow pill + oversized full-sentence headline + two CTAs | Lead with the product itself; short display headline only if the copy earns it |
| Numbered section markers (01/02/03) and repeated uppercase kickers | Structure from real content; numbers only for actual sequences |
| Big-number metric + small label ×3 with gradient accents | A presentation specific to what the numbers mean |

**Color & type**

| Tell | Replace with |
|---|---|
| Purple/indigo→blue gradients; cyan-glow-on-dark | A palette derived from the brand/content, committed in the contract |
| Gradient text on headings | Solid ink from the palette |
| Inter/Geist/Space-Grotesk-by-default, one family everywhere | A display face with personality + a refined body face, chosen per site |
| Every element `rounded-2xl` | Radius scale from the contract; cards ≤12-16px, pill only for chips/buttons |
| Dark mode as reflex default | Default theme chosen for the audience; dark only as a real decision |
| Gray text on colored fills | The paired `on-*` ink from the contract |

**Motion & copy**

| Tell | Replace with |
|---|---|
| Fade-in-on-scroll on everything; bounce/elastic easing | Few micro-interactions that communicate state; ease-out; animate only transform/opacity |
| "Build the future", "all-in-one platform", buzzword copy | Specific verb + noun: what the product literally does |
| Broken/placeholder images, plastic AI illustrations | Real product shots, real assets, or nothing |

## 4. No one-size-fits-all: fitting the system to the site

The tables above are DEFAULTS to depart from, not laws. The method:

1. **Derive the direction from the site's actual domain** — who uses it, what
   it does, what it should feel like. A driver-practice game wants tactile
   keycaps and pastel play (DSIM); a legal firm wants editorial restraint; a
   dev tool can be industrial-mono. Same method, different tokens.
2. **Let the contract adjudicate the audit.** Every audit threshold bends to a
   written decision: DSIM's tonal surface ladder legitimately trips the
   near-duplicate-color warning; a brutalist site legitimately has zero radii
   and 100+ colors is still wrong. WARN = "check against the contract";
   FAIL (contrast, focus, overflow) = fix regardless — accessibility floors
   don't bend.
3. **One decision, everywhere.** Consistency is not sameness of sites — it is
   sameness WITHIN a site: the same button is the same button on every page,
   spacing follows one rhythm, depth follows one model. That is what the audit
   measures and what the contract records.

## Sources

- [Impeccable — Slop patterns catalog](https://impeccable.style/slop/)
- [925 Studios — AI slop web design guide](https://www.925studios.co/blog/ai-slop-web-design-guide)
- [Why your AI keeps building the same purple gradient website](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website)
- [MindStudio — the design-system approach to avoiding slop](https://www.mindstudio.ai/blog/claude-design-avoid-ai-slop-design-system)
- [Project Wallace — CSS analytics / design-token metrics](https://www.projectwallace.com/docs/metrics)
- [Netguru — design system audit steps](https://www.netguru.com/blog/design-system-audit)
