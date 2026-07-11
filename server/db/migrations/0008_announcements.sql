-- ANNOUNCEMENTS — patch notes / bug fixes / new-season + new-act reveals shown to a
-- player the first time they open the app AFTER one is published. Persisted (not the
-- ephemeral in-memory `serverNotice`) so it survives a deploy and is still shown to a
-- player who was offline when it went out. "Seen" is tracked client-side in
-- localStorage (works for anon + signed-in), so no per-user state lives here.
create table if not exists announcements (
  id            uuid        primary key default gen_random_uuid(),
  kind          text        not null,               -- 'patch' | 'season' | 'act'
  title         text        not null,
  body          text        not null default '',     -- newline-separated bullet lines
  -- optional headline for the cinematic season/act reveal (e.g. an act subtitle)
  tagline       text,
  published_at  timestamptz not null default now(),
  active        boolean     not null default true
);

-- newest active first — the client pulls a short recent window
create index if not exists announcements_feed_idx
  on announcements (published_at desc) where active;
