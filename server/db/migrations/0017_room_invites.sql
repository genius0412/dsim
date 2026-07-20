-- Room invites: "come join my room" for friends, ridden on top of the existing
-- friends system. Purely ADDITIVE (create table if not exists only), so rollback
-- is "deploy the previous server" like every other migration here.
--
-- A DB table rather than an in-memory map on the room registry (server/index.ts's
-- `rooms` Map) because the app is deployed MULTI-REGION on Fly: the POST that
-- sends an invite and the GET /api/friends poll that reads it can land on
-- different machines. Only Postgres is guaranteed shared across them — the same
-- reason friend_requests/friendships live there instead of in-process.
--
-- Ephemeral by nature (a room outlives an invite by minutes, not days).
-- Expiry is enforced at READ time (see listRoomInvites's freshness window in
-- repo.ts), not by a cron job — the write volume here is far too low to need one.
-- A row is deleted on explicit dismiss or once the invitee actually joins.
create table if not exists room_invites (
  id           uuid primary key default gen_random_uuid(),
  from_user_id text not null references profiles(user_id) on delete cascade,
  to_user_id   text not null references profiles(user_id) on delete cascade,
  room         text not null,
  game         text not null default 'decode',
  kind         text not null default 'versus',
  record       text,
  created_at   timestamptz not null default now(),
  check (from_user_id <> to_user_id)
);
create index if not exists room_invites_to_idx on room_invites(to_user_id);
