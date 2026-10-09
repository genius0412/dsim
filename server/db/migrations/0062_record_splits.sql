-- 0062 — AUTO / TELEOP SPLITS ON RECORD RUNS (docs/rooms-and-leaderboards-plan.md §5.1)
--
-- The Auto and TeleOp boards rank a run by the points it earned in that period, net of the fouls it
-- committed in it (the same net the Total board uses). Both are nullable: a row from before this
-- migration has no split and stays off those two boards, and rolling the server back leaves the
-- columns unread.
alter table records add column if not exists auto_score   integer;
alter table records add column if not exists teleop_score integer;
-- the windowed boards (today / this week / this month) filter on created_at inside one board
create index if not exists records_window_idx on records (game, balance_version, mode, created_at);
