-- DECODE 2D — Phase 3 schema (records, ranked ELO, replays, seasons, presets).
-- Postgres (Neon). Idempotent: safe to re-run. Applied by server/db/migrate.ts,
-- which records applied filenames in `schema_migrations`.
--
-- Identity comes from NEON AUTH, which syncs users into `neon_auth.users_sync`
-- (id text, name, email, ...). App tables key off that user id as TEXT. We do
-- NOT hard-FK to neon_auth.users_sync (it is a managed/beta schema that may be
-- absent in local/dev DBs); `profiles` is the app-owned mirror we DO reference.
--
-- SEASONS are keyed to config.ts BALANCE_VERSION: every score/rating/replay is
-- stamped with `balance_version`, so a balance patch (version bump) starts a
-- fresh season while past seasons stay queryable. Boards always filter on it.

-- ---------------------------------------------------------------- seasons ----
create table if not exists seasons (
  balance_version integer primary key,
  name            text        not null,
  started_at      timestamptz not null default now(),
  -- exactly one active season (the current BALANCE_VERSION); older = archived
  active          boolean     not null default true
);

-- --------------------------------------------------------------- profiles ----
-- app-owned player record. `user_id` = the Neon Auth subject (text). `handle`
-- is the public display name on boards (defaults from auth name, editable).
create table if not exists profiles (
  user_id     text        primary key,
  handle      text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------- saved robot presets ----
-- each user's saved RobotSpec builds (preset slots). `spec` is the RobotSpec v2
-- JSON; unique per (user, slot). Independent of the game loop — ships value on
-- its own.
create table if not exists robot_presets (
  id          uuid        primary key default gen_random_uuid(),
  user_id     text        not null references profiles(user_id) on delete cascade,
  slot        integer     not null,
  name        text        not null,
  spec        jsonb       not null,
  updated_at  timestamptz not null default now(),
  unique (user_id, slot)
);

-- ---------------------------------------------------------------- replays ----
-- deterministic input-log replays: {seed, setups, tracks} (NOT video). ~10-30KB
-- rows. Re-simulated by the server to reproduce a match; playable by clients.
-- Stamped with the balance version whose sim build produced them.
create table if not exists replays (
  id              uuid        primary key default gen_random_uuid(),
  format          integer     not null,
  balance_version integer     not null,
  seed            bigint      not null,
  ticks           integer     not null,
  setups          jsonb       not null,
  tracks          jsonb       not null,
  created_at      timestamptz not null default now()
);

-- --------------------------------------------------- record-chasing board ----
-- one row per submitted score-attack run (opponent-free). `mode` = solo|duo,
-- `drivetrain` = the run's drivetrain (duo = shared). `partner_id` set for duo.
-- The leaderboard is derived (best score per user/segment/season); we keep every
-- run so replays stay watchable and PBs are provable.
create table if not exists records (
  id              uuid        primary key default gen_random_uuid(),
  user_id         text        not null references profiles(user_id) on delete cascade,
  partner_id      text        references profiles(user_id) on delete set null,
  mode            text        not null check (mode in ('solo', 'duo')),
  drivetrain      text        not null check (drivetrain in ('mecanum', 'tank', 'swerve', 'xdrive')),
  score           integer     not null,
  balance_version integer     not null,
  replay_id       uuid        references replays(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- leaderboard read path: top scores within a season × mode × drivetrain
create index if not exists records_board_idx
  on records (balance_version, mode, drivetrain, score desc, created_at);
-- personal-best path
create index if not exists records_pb_idx
  on records (user_id, mode, drivetrain, balance_version, score desc);

-- best score per player per segment per season (the ranked board reads this)
create or replace view record_leaderboard as
select distinct on (balance_version, mode, drivetrain, user_id)
  balance_version, mode, drivetrain, user_id, partner_id, score, replay_id, created_at
from records
order by balance_version, mode, drivetrain, user_id, score desc, created_at asc;

-- ------------------------------------------------------------ ranked ELO -----
-- one rating per user × mode × drivetrain × season. `drivetrain='overall'` is
-- the cross-drivetrain aggregate board (2v2 mixed-drivetrain teams land here
-- only). `mode` = '1v1' | '2v2'.
create table if not exists elo_ratings (
  user_id         text        not null references profiles(user_id) on delete cascade,
  mode            text        not null check (mode in ('1v1', '2v2')),
  drivetrain      text        not null,  -- 'mecanum'|'tank'|'swerve'|'xdrive'|'overall'
  balance_version integer     not null,
  rating          integer     not null default 1000,
  games           integer     not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (user_id, mode, drivetrain, balance_version)
);
create index if not exists elo_board_idx
  on elo_ratings (balance_version, mode, drivetrain, rating desc);

-- ------------------------------------------------------ PvP match history ----
create table if not exists matches (
  id              uuid        primary key default gen_random_uuid(),
  mode            text        not null check (mode in ('1v1', '2v2')),
  balance_version integer     not null,
  replay_id       uuid        references replays(id) on delete set null,
  created_at      timestamptz not null default now()
);

create table if not exists match_participants (
  match_id    uuid    not null references matches(id) on delete cascade,
  user_id     text    not null references profiles(user_id) on delete cascade,
  alliance    text    not null check (alliance in ('red', 'blue')),
  drivetrain  text    not null,
  score       integer not null,
  won         boolean not null,
  rating_before integer not null,
  rating_after  integer not null,
  primary key (match_id, user_id)
);
create index if not exists match_participants_user_idx
  on match_participants (user_id, match_id);
