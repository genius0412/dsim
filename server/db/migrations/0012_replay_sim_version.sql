-- REPLAY re-sim gate vs. SEASON stamp were conflated on `replays.balance_version`.
-- The playback gate (src/ui/ReplayView.tsx) only cares that the viewing client's
-- COMPILED sim code (config.BALANCE_VERSION) matches the code that RECORDED the
-- replay — a replay is a deterministic input log and only re-sims exactly under its
-- own sim build. The SEASON number is irrelevant to that. But server/persist.ts
-- stamped `balance_version` with the DB SEASON (currentSeasonNumber), which an admin
-- can advance WITHOUT any physics change, so a season bump made every newly-recorded
-- replay read as "recorded on an older version (Season N)" even though it re-sims
-- perfectly. See config.ts BALANCE_VERSION.
--
-- Split them: `balance_version` STAYS the season (purge-by-season + its index, see
-- 0004), and a new `sim_version` carries the real sim-code version the gate compares.
alter table replays add column if not exists sim_version int;

-- Backfill existing rows. At this migration BALANCE_VERSION = 3 is the highest REAL
-- physics version ever shipped (config.ts), so any replay stamped ABOVE it was a
-- season bump (no physics change) and re-sims under 3 — clamp those down to rescue
-- them, while genuinely older-physics replays (v1/v2) stay correctly gated.
update replays set sim_version = least(balance_version, 3) where sim_version is null;
