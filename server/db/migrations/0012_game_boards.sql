-- PER-GAME boards + periods.
--
-- The sim now runs TWO games (DECODE + Chain Reaction). Every competitive board
-- (records, ranked ELO, match history) and the season/act PERIOD system become
-- keyed by `game` so the two games never share a leaderboard or a period — DECODE
-- and Chain Reaction each advance their own Act → Season progression independently.
--
-- Additive + back-compat: `game` defaults to 'decode', so every existing row and any
-- old client (which sends no game) lands on the DECODE boards exactly where it is now.
-- Chain Reaction seeds its first ACTIVE season (Act 1 · Season 1) at server boot
-- (repo.ensureSeason — needs BALANCE_VERSION, so it is not baked into this SQL).

-- ---------------------------------------------------------------- seasons ----
-- a period is now (game, balance_version); `active` is per-game (one live period each).
alter table seasons add column if not exists game text not null default 'decode';

do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'seasons_pkey' and conrelid = 'seasons'::regclass
  ) then
    alter table seasons drop constraint seasons_pkey;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'seasons_game_bv_pkey' and conrelid = 'seasons'::regclass
  ) then
    alter table seasons add constraint seasons_game_bv_pkey primary key (game, balance_version);
  end if;
end $$;

-- ------------------------------------------------------ game on every board ---
alter table replays add column if not exists game text not null default 'decode';
alter table records add column if not exists game text not null default 'decode';
alter table matches add column if not exists game text not null default 'decode';
alter table elo_ratings add column if not exists game text not null default 'decode';

-- re-key the ELO PK to include game (ranked is no longer split by drivetrain — 0011
-- dropped that column; a user has one rating per game×mode×season).
do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'elo_ratings_pkey' and conrelid = 'elo_ratings'::regclass
  ) then
    alter table elo_ratings drop constraint elo_ratings_pkey;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'elo_ratings_game_pkey' and conrelid = 'elo_ratings'::regclass
  ) then
    alter table elo_ratings add constraint elo_ratings_game_pkey
      primary key (user_id, mode, game, balance_version);
  end if;
end $$;

-- ------------------------------------------------- game-aware board indexes ---
-- boards always filter (game, balance_version, …); drop the game-less indexes and
-- recreate them game-first so the read path stays covered.
drop index if exists records_board_idx;
drop index if exists records_pb_idx;
drop index if exists elo_board_idx;
drop index if exists replays_season_idx;

create index if not exists records_board_idx
  on records (game, balance_version, mode, drivetrain, score desc, created_at);
create index if not exists records_pb_idx
  on records (user_id, mode, drivetrain, game, balance_version, score desc);
create index if not exists elo_board_idx
  on elo_ratings (game, balance_version, mode, rating desc);
create index if not exists replays_season_idx
  on replays (game, balance_version);
create index if not exists matches_game_season_idx
  on matches (game, balance_version);

-- best score per player per segment per game×season (the ranked record board). DROP first:
-- `create or replace view` cannot PREPEND the new `game` column (column reorder is rejected).
drop view if exists record_leaderboard;
create view record_leaderboard as
select distinct on (game, balance_version, mode, drivetrain, user_id)
  game, balance_version, mode, drivetrain, user_id, partner_id, score, replay_id, created_at
from records
order by game, balance_version, mode, drivetrain, user_id, score desc, created_at asc;
