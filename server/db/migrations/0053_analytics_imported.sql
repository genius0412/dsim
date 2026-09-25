-- 0053 — ANALYTICS HISTORY FROM BEFORE DSIM COUNTED ITSELF.
--
-- Until September 2026 the site also ran Vercel Web Analytics. It was removed once the admin
-- console's own analytics covered everything it showed, and its daily aggregates were exported
-- (`scripts/vercel-analytics-export.mjs`) and loaded here (`scripts/import-vercel-analytics.ts`)
-- so the dashboard keeps that history.
--
-- A SEPARATE TABLE, not rows in `analytics_daily`: the two sources overlap by days and were
-- counted differently (ours honours Do Not Track and Global Privacy Control, the host's did not,
-- and each filters bots its own way), so adding them together would be wrong on exactly the
-- overlap days. The
-- dashboard reads it for the days before DSIM's own count began and ignores the rest
-- (`importContext` in server/analytics.ts), so each day comes from exactly one source.
--
-- Same shape as `analytics_daily` minus what the source never had (sessions, bounces, game):
--   dim = 'total'  val = '*'
--   dim = 'path' | 'ref' | 'country' | 'device' | 'os' | 'browser' | 'utm_*'
--   dim = 'event'  val = event name        (views = event count)
--   dim = 'evprop' val = 'name|key|value'  (views = event count)
-- Paths are scrubbed by the same `normalizePath` the live beacon uses before they land here.
--
-- No user id, IP or user-agent column (dbtest asserts that for every `analytics_*` table), no
-- foreign key, and nothing but the primary key as an index.
create table if not exists analytics_imported (
  source   text    not null,
  day      date    not null,
  dim      text    not null,
  val      text    not null,
  views    integer not null default 0,
  visitors integer not null default 0,
  primary key (source, day, dim, val)
);
