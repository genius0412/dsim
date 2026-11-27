-- 0061 — WHICH SETUP A CUSTOM ROOM WAS (docs/rooms-and-leaderboards-plan.md §2.1)
--
-- `matches.mode` stays '1v1' | '2v2' (it has check constraints, and the rating code reads it). A
-- host-shaped room can be a 3v1 or a 1v0, which `mode` cannot say, so the room's preset is kept
-- beside it: 'custom' | 'casual-1v1' | 'casual-2v2'. Null = a ranked or staged match, or a row
-- from before this migration.
--
-- Purely ADDITIVE and nullable: rolling the server back leaves the column unread.
--
-- ACCESS EXCLUSIVE on `matches` for an instant, but it queues behind any open reader and then every
-- other query queues behind it. Give up after 5 s instead (migrate() runs the file in one
-- transaction, so `set local` applies; the boot retries, server/index.ts).
set local lock_timeout = '5s';
alter table matches add column if not exists preset text;
