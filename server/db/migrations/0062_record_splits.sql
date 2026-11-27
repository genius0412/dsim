-- 0062 — AUTO / TELEOP SPLITS ON RECORD RUNS (docs/rooms-and-leaderboards-plan.md §5.1)
--
-- The Auto and TeleOp boards rank a run by the points it earned in that period, net of the fouls it
-- committed in it (the same net the Total board uses). Both are nullable: a row from before this
-- migration has no split and stays off those two boards, and rolling the server back leaves the
-- columns unread.
--
-- ACCESS EXCLUSIVE on `records` (and a SHARE lock for the index) queues behind any open reader and
-- every other query then queues behind it. Give up after 5 s instead (migrate() runs the file in one
-- transaction, so `set local` applies; the boot retries, server/index.ts).
set local lock_timeout = '5s';
alter table records add column if not exists auto_score  integer;
alter table records add column if not exists teleop_score integer;
-- the windowed boards (today / this week / this month) filter on created_at inside one board
create index if not exists records_window_idx on records (game, balance_version, mode, created_at);
