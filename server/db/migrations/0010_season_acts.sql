-- ACT dimension for the competitive-period system.
--
-- A `balance_version` row in `seasons` is one SEASON. Seasons are grouped into
-- ACTS: multiple seasons per act, both 1-indexed for display, with ACT 0 reserved
-- for the historical beta / pre-season. The displayed "Season N" is the season's
-- 1-indexed ORDINAL WITHIN ITS ACT (derived in listSeasons via row_number), so it
-- is always contiguous from 1 regardless of the underlying balance_version — which
-- is why the old raw "Season 3" (balance_version 3) looked wrong.
--
-- `act` defaults to 0 so all existing rows (and any data-only ghost versions)
-- land in the beta act until an admin explicitly starts Act 1.
alter table seasons add column if not exists act integer not null default 0;

-- The default name is no longer a baked-in "Season N" string — the structured
-- "Act X · Season Y" label is computed at read time. `name` now holds ONLY an
-- admin's optional custom title (null = use the structured label).
alter table seasons alter column name drop not null;
