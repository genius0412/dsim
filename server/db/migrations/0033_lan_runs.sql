-- UNOFFICIAL MATCHES PLAYED ON A SELF-HOSTED SERVER — kept for the replay and the data,
-- never for a score.
--
-- A LAN match runs on a machine its operator controls, so everything it reports is, from the
-- cloud's point of view, client-authored: somebody can run a patched server that reports a
-- 900-point match. That is exactly the situation `practice_runs` (0032) is in, and this table
-- takes the same answer, for the same reason. `record_leaderboard` is a view over `records`,
-- and every board, PB, rank and ELO query reads that view. A row that cannot reach the view
-- cannot reach a leaderboard by accident, by a later refactor, or by a mistaken `union all`.
-- The separation IS the enforcement. Do not add a join from here to `records`.
--
-- WHAT IS DIFFERENT FROM `practice_runs`: a practice run has exactly one participant and is
-- witnessed by nobody, so the uploader and the player are the same person. A LAN match has
-- several people in it and is witnessed by the host's server, so it needs a stable identity
-- (`match_id`, minted by that server) and a record of who played. The HOST uploads it, under
-- their own account — decided with the owner, and it is what keeps the upload authenticated
-- as somebody without the LAN server ever handling another player's credentials.
--
-- Purely ADDITIVE (create ... if not exists), so rolling the server back is safe: an older
-- build simply never selects from it.
--
-- AMENDED IN PLACE rather than followed by an 0034, and that is only allowed because this
-- migration has never run anywhere: it exists on the `lan-selfhost` branch alone, is on no
-- deployed database, and the runner (server/db/migrate.ts) tracks migrations BY FILENAME with
-- no checksum, so an edit to a file already recorded in `schema_migrations` would be silently
-- skipped. If this table has shipped by the time you read this, add an 0034 instead.
create table if not exists lan_runs (
  id              uuid        primary key default gen_random_uuid(),
  -- minted by the hosting server at finalizeMatch and broadcast with the result. UNIQUE, so
  -- the upload is an upsert: a retry after a flaky connection is free, and a host whose
  -- upload succeeded on the third attempt gets one row rather than three. It is also the only
  -- thing standing between "this match happened once" and a client looping an upload.
  --
  -- CONSTRAINED TO THE SHAPE THE SERVER MINTS (`randomUUID()` at `finalizeMatch`). The API
  -- already refuses anything else, but "the API checks it" is a property of one code path and
  -- this is a property of the table: a freeform text primary identity is an invitation to
  -- squat, to pad, and to store a megabyte of anything under the one column the uploader gets
  -- to choose. Lowercase hex, because that is what `randomUUID()` emits and accepting both
  -- cases would make two spellings of one match two rows.
  match_id        text        not null unique
                  check (match_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- the account that HOSTED, and therefore uploaded. Not "the winner" and not "everyone":
  -- one row, one owner, cascading away with the profile like every other user-owned row.
  host_user_id    text        not null references profiles(user_id) on delete cascade,
  -- which game this match was. Constrained to the games that exist, for the same reason the
  -- id is: the value arrives on a query string from an untrusted client, and the read path
  -- (`lan_host_idx`, and `listLanRuns`' `where game = $2`) silently returns nothing for a
  -- value nothing will ever match, which is the least debuggable way for a typo to fail.
  -- Widen this in the migration that adds the third game.
  game            text        not null default 'decode'
                  check (game in ('decode', 'chain')),
  -- the SEASON, matching `records.balance_version` (0004/0012) so the season replay purge
  -- sweeps these with everything else instead of leaving orphaned logs behind forever
  balance_version integer     not null,
  -- final score per alliance, AS REPORTED. Unverified by construction. It is shown beside the
  -- replay that produced it, and the viewer re-simulates that replay — so a score that
  -- disagrees with its own match contradicts itself on screen, which is the only check that
  -- can exist here and is a surprisingly good one.
  score           jsonb       not null,
  -- who played, as the hosting server reported them: display name, team, alliance. NAMES ONLY
  -- and deliberately not user ids. A LAN guest may be signed out entirely, and attributing a
  -- match to an account on the say-so of a machine the cloud does not trust is exactly the
  -- impersonation primitive `LobbyPlayer.supporter` being server-authored exists to prevent.
  participants    jsonb       not null,
  replay_id       uuid        references replays(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- the only read path there is: one host's own matches, newest first, per game
create index if not exists lan_host_idx
  on lan_runs (host_user_id, game, created_at desc);

-- ...and the purge path, which deletes by the replay a run points at
create index if not exists lan_replay_idx on lan_runs (replay_id);

comment on table lan_runs is
  'Unofficial matches played on a self-hosted / LAN server, uploaded by the HOST under their own account. NOT a leaderboard table: scores here are reported by a server the cloud does not trust and are deliberately unreachable from record_leaderboard. Capped per host by the server (see LAN_KEEP in repo.ts), oldest pruned on insert.';
