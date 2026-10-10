-- 0063 — AUTO-ONLY RUNS (docs/rooms-and-leaderboards-plan.md §4, §5.1)
--
-- A run can end at the AUTO buzzer (`World.runLength` 'auto', replay format 5). It is a different
-- game from a full run, so it never ranks against one: every board except Auto filters on
-- `run_length = 'full'`. `records` defaults to 'full', so every existing row is one. `replays` is
-- nullable (null = full) because a replay row's reader treats an absent value as a full run.
-- Rolling the server back leaves both columns unread; an older server would put an auto-only row
-- on the Total board, which is why the client gates auto-only runs on the server's `rooms2` cap.
set local lock_timeout = '5s';
alter table records add column if not exists run_length text not null default 'full';
-- `not valid`: a migration is one transaction here (no CONCURRENTLY), so the constraint is added
-- without scanning the table; it still binds every new row
alter table records drop constraint if exists records_run_length_chk;
alter table records add constraint records_run_length_chk check (run_length in ('full', 'auto')) not valid;
alter table replays add column if not exists run_length text;
