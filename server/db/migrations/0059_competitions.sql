-- 0059 — COMPETITIONS (docs/area/competitions.md)
--
-- An FTC-style event: registration, qualification matches drawn by the server, rankings,
-- alliance selection, a playoff bracket, placements. Run by site staff today; the staff table
-- below is what lets a competition be run by its own organizers once creation opens up.
--
-- WHAT IS STORED AND WHAT IS NOT. These tables hold what was DECIDED: who entered, which matches
-- were drawn, what each match scored, which selection picks were made, which bracket was built.
-- The rankings, the live alliance selection, every series' wins and the placements are derived
-- from those on every read (`src/competition/*.ts`), so a corrected result moves everything
-- downstream of it and there is no second copy to fall out of step.
--
-- Purely ADDITIVE, like every migration here: rolling the server back leaves the tables unread.

create table if not exists competitions (
  id              uuid        primary key default gen_random_uuid(),
  -- the URL key, `/<game>/competitions/<slug>`; unique across games
  slug            text        not null unique,
  name            text        not null,
  game            text        not null,
  format          text        not null check (format in ('1v1', '2v2')),
  team_mode       text        not null default 'solo' check (team_mode in ('solo', 'duo')),
  status          text        not null default 'draft'
                  check (status in ('draft', 'published', 'qualification', 'selection', 'playoffs', 'completed', 'cancelled')),
  -- unlisted: reachable by its link, absent from the public list
  visibility      text        not null default 'public' check (visibility in ('public', 'unlisted')),
  -- run by DSIM staff (created by an admin), as opposed to a community event later on
  official        boolean     not null default false,
  summary         text        not null default '',
  description     text        not null default '',
  rules           text        not null default '',
  -- `CompSettings`, coerced on every read and write (src/competition/settings.ts)
  settings        jsonb       not null default '{}'::jsonb,
  capacity        integer     not null check (capacity between 2 and 256),
  -- the Fly region the matches' rooms are hosted in; null = the matchmaker's region
  region          text,
  reg_opens_at    timestamptz,
  reg_closes_at   timestamptz,
  checkin_opens_at timestamptz,
  starts_at       timestamptz,
  -- the seed every draw and every coin is derived from, so the same inputs draw the same schedule
  rng_seed        bigint      not null,
  -- the playoff seeding order (entry ids, best first), frozen when qualifications end so a result
  -- corrected during alliance selection cannot reshuffle captains mid-pick
  seed_order      jsonb,
  -- alliance selection's actions, replayed in order (`SelectionAction[]`)
  selection       jsonb       not null default '[]'::jsonb,
  -- the playoff alliances, frozen when the bracket is built (`PlayoffAlliance[]`)
  alliances       jsonb,
  -- not a foreign key: an admin is an env id, and the competition outlives its creator's account
  created_by      text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz
);
-- the public list: by status, newest first
create index if not exists competitions_status_idx on competitions (status, starts_at desc);

-- who besides site staff may run one competition
create table if not exists competition_staff (
  competition_id  uuid        not null references competitions(id) on delete cascade,
  user_id         text        not null references profiles(user_id) on delete cascade,
  role            text        not null check (role in ('organizer', 'referee')),
  added_by        text        not null,
  added_at        timestamptz not null default now(),
  primary key (competition_id, user_id)
);
create index if not exists competition_staff_user_idx on competition_staff (user_id);

-- one ENTRY is what is scheduled: a player, or a duo (captain + partner) in a 2v2 of duos
create table if not exists competition_entries (
  id              bigserial   primary key,
  competition_id  uuid        not null references competitions(id) on delete cascade,
  -- SET NULL, not cascade: an entry that played keeps its row (and its matches keep both sides)
  -- when the account is deleted; `deleteAccount` scrubs the name
  user_id         text        references profiles(user_id) on delete set null,
  partner_id      text        references profiles(user_id) on delete set null,
  -- the name shown on the schedule: a team name, or the player's handle at sign-up
  name            text        not null,
  number          integer,
  status          text        not null default 'registered'
                  check (status in ('registered', 'waitlist', 'pending', 'withdrawn', 'disqualified')),
  checked_in_at   timestamptz,
  -- an organizer's manual seed, read where there are no qualifications
  seed            integer,
  -- the final place, written when the competition completes
  placement       integer,
  -- an organizer's private note; never served to anyone but the competition's staff
  note            text,
  registered_at   timestamptz not null default now()
);
-- one entry per player per competition, as captain or as partner (the cross-check between the
-- two columns is the registration transaction's, not a constraint's). NOT partial: nulls are
-- distinct in a unique index anyway, so any number of deleted accounts' entries fit, and a partial
-- index cannot serve `where competition_id = $1` (it does not imply the predicate) — every read of
-- a competition's entries, and the cascade when one is deleted, would scan every competition's.
create unique index if not exists competition_entries_user_uq
  on competition_entries (competition_id, user_id);
create unique index if not exists competition_entries_partner_uq
  on competition_entries (competition_id, partner_id);
-- the foreign keys' own indexes: "my competitions", and the account-deletion cascade
create index if not exists competition_entries_user_idx on competition_entries (user_id);
create index if not exists competition_entries_partner_idx on competition_entries (partner_id);

-- the bracket, as built. Static once the playoffs start; wins are counted from the matches.
create table if not exists competition_series (
  competition_id  uuid        not null references competitions(id) on delete cascade,
  key             text        not null,
  -- the whole `SeriesSpec`: side, round, position, labels, best-of, seeds and feeds
  spec            jsonb       not null,
  primary key (competition_id, key)
);

create table if not exists competition_matches (
  id              bigserial   primary key,
  competition_id  uuid        not null references competitions(id) on delete cascade,
  stage           text        not null check (stage in ('qual', 'playoff')),
  round           integer     not null default 0,
  number          integer     not null,
  series_key      text,
  status          text        not null default 'scheduled' check (status in ('scheduled', 'called', 'done', 'void')),
  -- how many times this match has been called; a result from an older call is ignored
  attempt         integer     not null default 0,
  -- the staged room of the CURRENT call. Region-coded so the proxy routes a join to its machine.
  room_code       text        unique,
  called_at       timestamptz,
  -- the first join that built the room took the call (exactly once; see `claimCompetitionRoom`)
  claimed_at      timestamptz,
  finished_at     timestamptz,
  red_score       integer,
  blue_score      integer,
  red_foul        integer     not null default 0,
  blue_foul       integer     not null default 0,
  winner          text        check (winner in ('red', 'blue', 'tie')),
  source          text        check (source in ('played', 'forfeit', 'manual')),
  -- entries disqualified in this match (no ranking points from it)
  dq              bigint[]    not null default '{}',
  -- the archived match and its replay, when it was played on the server
  match_id        uuid        references matches(id) on delete set null,
  replay_id       uuid        references replays(id) on delete set null,
  -- shown publicly beside the result ("Replayed after a disconnect")
  note            text,
  -- why the last call did not produce a match, for the referee ("@x did not connect")
  call_note       text,
  unique (competition_id, stage, number)
);
create index if not exists competition_matches_match_idx on competition_matches (match_id);
create index if not exists competition_matches_replay_idx on competition_matches (replay_id);
-- the runner's sweep: called matches across every running competition
create index if not exists competition_matches_called_idx on competition_matches (status, called_at)
  where status = 'called';

create table if not exists competition_match_slots (
  match_id        bigint      not null references competition_matches(id) on delete cascade,
  alliance        text        not null check (alliance in ('red', 'blue')),
  slot            smallint    not null,
  entry_id        bigint      not null references competition_entries(id) on delete cascade,
  surrogate       boolean     not null default false,
  primary key (match_id, alliance, slot)
);
create index if not exists competition_match_slots_entry_idx on competition_match_slots (entry_id);

-- what happened, in order: the public timeline and the organizers' trail. Every staff action
-- ALSO goes to `admin_audit`; this one is per competition and partly public.
create table if not exists competition_log (
  id              bigserial   primary key,
  competition_id  uuid        not null references competitions(id) on delete cascade,
  at              timestamptz not null default now(),
  -- a user id, 'system' for the runner, never a name (names change)
  actor           text        not null,
  kind            text        not null,
  data            jsonb       not null default '{}'::jsonb,
  -- shown on the public page; an organizer-only line is false
  public          boolean     not null default true
);
create index if not exists competition_log_comp_idx on competition_log (competition_id, at desc);
