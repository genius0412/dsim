# DECODE Sim — Big Update

*Everything new since the last public release.*

---

## 🤖 Robot Building & Feel

- **Rebuilt physical intake.** Three distinct intakes — **Sloped**, **Vector Wheel**, and **Triangle** — now actually grab, funnel, and store balls based on real geometry. Where a ball enters the mouth changes how fast it's swallowed, wedges funnel off-center balls to the center, and the Triangle can scoop two at once.
- **Real-motor drivetrains.** Tank, Swerve, Mecanum, and X-Drive have been re-tuned against real hardware. Each has a genuine niche: tank hits hardest with no strafe, swerve is the strongest but least precise (its pods visibly steer and wobble), mecanum is light/instant but weaker, and X-Drive is a nimble novelty.
- **Power draw matters.** Spinning up the flywheel and running the intake now pull current from your drive motors — pushing power and speed drop while you're working, and a spun-up flywheel costs the most when driving *away* from your goal.
- **Flywheel recovery & inertia.** Your first shot is always instant, but heavier flywheels take longer to recover between long-range shots. Close-range cyclers want a *little* inertia now, not zero.
- **Held balls are physical** — preloads and captured artifacts ride inside the robot and jostle for their storage slots.
- **Smoother, always-solved shooter** — the launch solution is now a smooth minimum-speed arc at every distance, including point-blank.
- **Robot presets** based on real teams, a **saved robot library** (up to 3 builds), and a **saved auto library** (up to 4 routines).
- **More build stats** — see your robot's max linear and angular acceleration in My Robot.

## 🎯 Start Positions & Strategy

- **Configurable, rulebook-legal start positions** with a drag-and-rotate editor — snapping is optional and illegal poses are never saved.
- **Close / Far start library** with per-category memory, so your favorite setups are one tap away.
- **2v2 role swap** — partners can trade Close/Far roles by mutual consent.
- **Pre-match strategy window** (20s) with audio cues before ranked matches.

## 🥅 Gate & Scoring Accuracy

- **The gate is now a real lever** (per the official manual figure): it sticks out of the classifier, you physically push it open, and it swings shut under gravity. Ram it harder and it opens faster — with no more "hitbox jolt" when you drive in.
- A tap **latches** it open and flowing balls hold it open, so you don't have to keep pressing.
- **Faster goal drain** — balls funnel out of the basin and down the ramp more smoothly.
- **Scoring timing now matches the manual exactly** — Classified/Overflow, Auto Pattern, Teleop Pattern, Depot, Leave, and Base are each locked in at the correct moment (including letting balls come to rest after the buzzer), so final scores are always accurate.
- **Triangle intake fires faster** up close.

## ⚖️ Penalties

- **New G408 (over-possession / plowing)** — controlling more than 3 artifacts, with a short grace period, now draws a minor penalty.

## 🕹️ Autonomous

- **Realistic auto driving** — no more instant heading snaps or unrealistic chassis speeds.
- **Auto runs in multiplayer**, too.

## 🌐 Multiplayer & Connection

- **Much smoother online play** — anti-stutter snapshot handling and a prediction cap keep remote robots gliding even on a shaky connection.
- **Live connection-quality readout** with a ping graph, so you can see exactly how healthy your link is.
- **Region-aware matchmaking** routes you to the nearest server for lower latency.
- **Reconnect grace** — a brief drop no longer ends your match; you're reconnected automatically.
- **One game per player** and cleaner rejoin handling (restart/rematch was removed to fix desyncs — return to the lobby for a fresh game).

## 🏆 Accounts, Career & Leaderboards

- **Public usernames & profile pages** — share your profile with a button.
- **Career** (formerly My Stats) with a full **match-history overhaul**: every match type, all participants, watchable replays, filters, and paging.
- **2v0 Duo record runs** — chase records with a partner; both drivers appear on the boards.
- **Shareable room codes**, auto-generated for private games.
- **Seasons** — boards archive cleanly when a new season opens, with in-game cinematic reveals for new seasons and acts.
- **In-app patch notes & announcements**.

## 🎨 Interface

- **Full visual redesign** on a cohesive low-poly design system, with a unified navigation shell and console screens.
- **Dark mode** across the entire app — including the in-match HUD — with accessibility polish.
- **Homepage redesign** and countless spacing/layout fixes.
- Controls and server-region settings now live in **Account settings**.

## 🛡️ Fair Play

- **Anti-cheat** — robot specs and settings are validated and sanitized on every layer, so impossible builds can't reach a ranked match.
- **Moderation tools** for keeping leaderboards and display names clean.

---

### Fixes
- Ranked will never match you against yourself again (the frozen "ghost" robot bug).
- Fixed networked-robot glitches (NaN positions) between client versions.
- Minimum username length raised to 4.
- Career now shows the season *name*, matching the Leaderboard.
- Numerous UI spacing and layout overlaps resolved.
