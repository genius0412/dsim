-- 0052 — SITE BANNERS: admin-authored lines in the strip where the restart notice appears.
--
-- The restart notice lived in ONE machine's memory, so a POST that landed on iad reached the
-- players on iad and nobody else. Every banner, the restart countdown included, is a row here
-- now; each machine reads the live set on a short timer and pushes a change to its own
-- sockets (server/siteState.ts).
--
--   kind      info | known-bug | warning | restart. `restart` carries the countdown in
--             `ends_at` and is also sent as the legacy `serverNotice` for older clients.
--   message   one short line; the tiny Markdown subset (links, bold, code) renders
--   starts_at null = now;  ends_at null = until someone ends it
--   game      null = every game, else a GameId
--   channel   null = every client channel, else 'stable' | 'alpha'
--   revision  bumped on every edit, so a player who dismissed revision 1 sees revision 2
--
-- "End" sets ends_at to now and keeps the row for the console's history; "delete" removes it.
create table if not exists banners (
  id         bigserial   primary key,
  kind       text        not null,
  message    text        not null,
  starts_at  timestamptz,
  ends_at    timestamptz,
  game       text,
  channel    text,
  revision   int         not null default 1,
  created_by text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint banners_kind check (kind in ('info', 'known-bug', 'warning', 'restart'))
);
-- the live-set read every machine makes: rows that have not ended
create index if not exists banners_ends_idx on banners (ends_at);
