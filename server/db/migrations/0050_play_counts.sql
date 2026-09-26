-- 0050 — GAMES PLAYED, COUNTED AT THE SOURCE (the homepage counters).
--
-- The homepage used to derive "games played" from `records` and `matches`, which left out
-- everything those tables never hold: a server match with no signed-in player in it (dropped
-- before any write), a Discord Activity room (everyone in an embed is signed out), solo
-- practice and LAN matches (both run off the cloud). This table counts every one of them.
--
-- ONE ROW PER (UTC day, game, source, mode), incremented in place. A counter, not an event
-- log: the homepage reads a sum, and a row per match would make that sum an unbounded scan,
-- which is the cost `getGlobalStats`' memo was written to contain.
--
--   source  record   server record run (solo/duo board)
--           ranked   matchmade ranked match
--           custom   server custom room (code, bots, friends)
--           discord  server room opened from a Discord Activity
--           practice solo practice on the local sim, reported by a client that was online
--           lan      self-hosted match, reported by its host's client when online
--   mode    solo | duo | 1v1 | 2v2 — the match's format
--
-- The homepage folds these into its own categories (`getGlobalStats`); keep the raw split
-- here so a later surface can ask a question the homepage does not.
--
-- Purely ADDITIVE, so rolling the server back is safe: an older build never reads it.
create table if not exists play_counts (
  day    date   not null,
  game   text   not null,
  source text   not null check (source in ('record', 'ranked', 'custom', 'discord', 'practice', 'lan')),
  mode   text   not null check (mode in ('solo', 'duo', '1v1', '2v2')),
  n      bigint not null default 0,
  primary key (day, game, source, mode)
);

-- BACKFILL from the tables that already hold history, so the homepage number does not drop
-- on the deploy. Discord rooms, anonymous rooms and practice runs of signed-out players were
-- never kept anywhere, so they start at zero. `practice_runs` and `lan_runs` are capped per
-- user, so their share of history is a floor. Runs once: the runner tracks migrations by name.
insert into play_counts (day, game, source, mode, n)
select (created_at at time zone 'utc')::date, coalesce(game, 'decode'), 'record', mode, count(*)
  from records group by 1, 2, 4
union all
select (created_at at time zone 'utc')::date, coalesce(game, 'decode'),
       case when ranked then 'ranked' else 'custom' end, mode, count(*)
  from matches group by 1, 2, 3, 4
union all
select (created_at at time zone 'utc')::date, coalesce(game, 'decode'), 'practice', 'solo', count(*)
  from practice_runs group by 1, 2
union all
select (created_at at time zone 'utc')::date, coalesce(game, 'decode'), 'lan',
       case when jsonb_typeof(participants) <> 'array' then '1v1'
            when jsonb_array_length(participants) >= 4 then '2v2' else '1v1' end, count(*)
  from lan_runs group by 1, 2, 4
on conflict (day, game, source, mode) do nothing;

comment on table play_counts is
  'Games played per UTC day × game × source (record/ranked/custom/discord/practice/lan) × mode (solo/duo/1v1/2v2). Counters only, no identity. Feeds /api/stats (the homepage).';
