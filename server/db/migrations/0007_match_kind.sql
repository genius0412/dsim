-- Distinguish RANKED from CUSTOM versus matches, and let a match carry no ELO.
-- Until now every versus match (matchmade or private/custom) landed in `matches`
-- identically and moved ELO. We add a `ranked` flag (set from the room) so the
-- Career history can label Ranked vs Custom, and custom games can persist for the
-- history/replay WITHOUT a rating change. Existing rows predate the split and are
-- overwhelmingly matchmade, so they default to ranked = true.
alter table matches add column if not exists ranked boolean not null default true;

-- A custom (unranked) match still records who played + the replay, but has no
-- rating delta, so the per-participant rating columns become nullable. Ranked rows
-- keep their values; a null before/after means "not rated" (shown with no ELO Δ).
alter table match_participants alter column rating_before drop not null;
alter table match_participants alter column rating_after  drop not null;
