# DECODE Sim — Big Update

*Everything new since the last public release.*

---

## 🤖 Robot Building & Feel

- **Rebuilt physical intake.** The three intakes — **Sloped**, **Vector Wheel**, and **Triangle** — now actually grab, funnel, and store artifacts from real geometry. *Where* a ball enters the mouth changes how fast it's swallowed, wedges funnel off-center balls toward the middle, and the Triangle can scoop two at once. The Vector Wheel now spans your full chassis width for a clean, predictable front grab.
- **Real-motor drivetrains, each with a genuine niche.** Tank, Swerve, Mecanum, and X-Drive are tuned against real hardware and rebalanced so every one has a reason to exist: **Tank** hits hardest with no strafe, **Swerve** is the strongest all-rounder but the least precise (its four pods visibly steer and wobble), **Mecanum** is light, instant, and precise but weaker in a shoving match, and **X-Drive** is a nimble novelty. No single drivetrain is strictly best.
- **Power draw matters.** Spinning up the flywheel and running the intake pull current off your drive motors — your top speed and pushing power dip while you're working, and a spun-up flywheel costs the most when you're driving *away* from your goal.
- **Flywheel recovery & inertia.** Your first shot is always instant, but heavier flywheels take longer to recover between long-range shots. Close-range cyclers now want a *little* inertia, not zero.
- **Held balls are physical** — preloads and captured artifacts ride inside the robot and jostle for their storage slots.
- **Smoother, always-solved shooter** — the launch arc is now a smooth minimum-speed solution at every distance, including point-blank. The shooter still never misses.
- **Robot presets** based on real teams, a **saved robot library** (up to 3 builds), and a **saved auto library** (up to 4 routines).
- **More build stats** — max linear and angular acceleration now show in My Robot.
- **Builder guardrails** — sensible per-drivetrain and per-intake minimum chassis sizes keep every build legal and physically buildable.

## 🎯 Start Positions & Strategy

- **Configurable, rulebook-legal start positions** with a drag-and-rotate editor — snapping is optional, and an illegal pose is previewed but never saved.
- **Close / Far start library** with per-category memory, so your favorite setups are one tap away.
- **2v2 role swap** — partners can trade Close/Far roles by mutual consent.
- **Pre-match strategy window** (with audio cues) before ranked matches.
- **Invalid starts are blocked** — the match won't begin with an illegal starting pose; it tells you and jumps you straight to fixing it instead of silently relocating your robot.

## 🥅 Gate & Scoring Accuracy

- **The gate is now a real lever** (matching the official manual figure): it sticks out of the classifier, you physically push it open, and it swings shut under gravity. Ram it harder and it opens faster — with no more "hitbox jolt" as you drive in.
- A tap **latches** it open, and flowing balls hold it open, so you don't have to keep pressing.
- **Faster goal drain** — artifacts funnel out of the basin and down the ramp more smoothly.
- **Scoring timing now matches the manual exactly** — Classified/Overflow, Auto Pattern, Teleop Pattern, Depot, Leave, and Base each lock in at the correct moment, including letting balls come to rest after the buzzer, so final scores are always right.
- **Triangle intake fires faster** up close.

## ⚖️ Penalties

- **New G408 (over-possession / plowing)** — controlling more than three artifacts, past a short grace period, now draws a penalty.

## 🕹️ Autonomous

- **Realistic auto driving** — no more instant heading snaps or impossible chassis speeds.
- Auto runs in local solo practice. It's **not enabled in online matches yet** while we finish syncing it with the match server.

## 🌐 Multiplayer & Connection

- **Much smoother online play** — anti-stutter snapshot handling plus Minecraft-style entity interpolation keep remote robots gliding even on a shaky link.
- **Live connection-quality readout** with real ping, snapshot rate, and jitter, so you can see exactly how healthy your connection is.
- **Region-aware matchmaking** routes you to the nearest of our global servers for lower latency.
- **Reconnect grace** — a brief drop no longer ends your match; you're reconnected automatically.
- **One game per player** with cleaner rejoin handling (restart/rematch was removed to kill desyncs — return to the lobby for a fresh game).

## 🏆 Accounts, Career & Leaderboards

- **Public usernames & profile pages** — share your profile with a button.
- **Career** (formerly My Stats) with a full **match-history overhaul**: every match type, all participants, both alliances' final scores, watchable replays, filters, and paging.
- **One ranked ladder per mode.** Ranked is no longer split by drivetrain — it's a single Glicko-2 rating per mode, so the ladder reflects the whole field. **Record boards keep their per-drivetrain buckets** (plus a **Mixed** board for mixed-drivetrain duos).
- **2v0 Duo record runs** — chase records with a partner; both drivers and both drivetrains appear on the boards.
- **Acts & Seasons** — competitive periods are now organized as **Act → Season**, with dedicated Act and Season selectors on the Leaderboard and in Career. Boards archive cleanly when a period rolls over, and you can look back at your **end-of-season final stats**. New acts and seasons open with an in-game cinematic reveal.
- **Shareable room codes**, auto-generated for private games and scoped to the right mode.
- **In-app patch notes & announcements** (now with rich formatting).

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
- Fixed networked-robot glitches (NaN positions) between different client versions.
- Held balls of *other* robots now track their bodies correctly online.
- Fast reconnects no longer fail to a "Connection lost" screen.
- Room codes are scoped to their mode — a duo-record code can't drop you into a custom match.
- Minimum username length raised to 4.
- Career now shows the season *name*, matching the Leaderboard.
- Numerous UI spacing and layout overlaps resolved.
</content>
</invoke>
