-- PER-SEASON ELO SNAPSHOT (historical standings).
--
-- Ratings live in `elo_ratings` keyed by ACT (persist across seasons, reset on act). But a
-- leaderboard/career for a PAST season must show the rating FROZEN at that season's end, not the
-- live act rating. So on every rated match we also upsert the player's post-match rating into
-- `elo_history`, keyed by the match's SEASON (balance_version). While a season is live this row
-- tracks the latest rating; once the season rolls it stops updating → it IS the end-of-season
-- state. Archived-season boards read here; the LIVE season keeps reading `elo_ratings` (by act)
-- so it still lists every currently-placed player, not only those active this season.
create table if not exists elo_history (
  user_id         text        not null,
  mode            text        not null check (mode in ('1v1', '2v2')),
  game            text        not null default 'decode',
  balance_version integer     not null,          -- the SEASON this snapshot belongs to
  rating          integer     not null,
  rd              double precision not null default 350,
  vol             double precision not null default 0.06,
  games           integer     not null default 0, -- act-cumulative games as of this match
  updated_at      timestamptz not null default now(),
  primary key (user_id, mode, game, balance_version)
);
create index if not exists elo_history_board_idx
  on elo_history (game, balance_version, mode, rating desc);
