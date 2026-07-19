-- Friends list: mutual-consent friendships, pending requests, one-way blocks,
-- and a skinny presence table.
--
-- Purely ADDITIVE (create table if not exists only — no drops, no type changes),
-- so rolling back is "deploy the previous server": the old code simply never
-- touches these tables. migrate() runs the whole file in one transaction.

-- pending requests only; the row is DELETED on accept/decline/cancel, so this
-- table stays small and "is there a pending request" is a plain existence check.
create table if not exists friend_requests (
  id           uuid primary key default gen_random_uuid(),
  from_user_id text not null references profiles(user_id) on delete cascade,
  to_user_id   text not null references profiles(user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (from_user_id, to_user_id),
  -- a self-request is also rejected in the handler; this makes it impossible
  check (from_user_id <> to_user_id)
);
create index if not exists friend_requests_to_idx on friend_requests(to_user_id);
create index if not exists friend_requests_from_idx on friend_requests(from_user_id);

-- accepted friendships, ONE row per unordered pair. Storing (least, greatest)
-- rather than both directions means "are these two friends" is a primary-key
-- lookup and a friendship can never half-exist (A→B present, B→A missing).
create table if not exists friendships (
  user_low   text not null references profiles(user_id) on delete cascade,
  user_high  text not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  check (user_low < user_high)
);
create index if not exists friendships_high_idx on friendships(user_high);

-- one-way blocks. The blocker stops receiving requests from the blocked user,
-- and blocking tears down any existing friendship + pending requests in BOTH
-- directions (see respondToBlock in repo.ts). This is the harassment control:
-- it is enforced server-side inside sendFriendRequest, never client-side.
create table if not exists friend_blocks (
  blocker_id text not null references profiles(user_id) on delete cascade,
  blocked_id text not null references profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists friend_blocks_blocked_idx on friend_blocks(blocked_id);

-- Presence gets its OWN skinny table rather than columns on `profiles`, for two
-- reasons that both matter here:
--
--  1. WRITE AMPLIFICATION. The heartbeat rewrites one row per signed-in user
--     every ~30s. Postgres UPDATE is copy-on-write, so putting last_seen_at on
--     `profiles` would rewrite the WHOLE row every time — including the
--     `settings` jsonb — and leave a dead tuple behind, on the same table every
--     leaderboard, profile, and match save also reads. Here the churn lands on
--     a two-column page nobody else touches and rows stay narrow enough for HOT
--     updates.
--  2. IT MAKES DATA EXPOSURE STRUCTURAL. `profiles` is read by several PUBLIC
--     paths (getProfile, getProfileByUsername, getUserStats). If last-seen lived
--     there, keeping it out of public responses would be a standing discipline
--     that one future `select *` silently breaks. In its own table a public
--     query has to opt in with a join it has no reason to write.
create table if not exists user_presence (
  user_id      text primary key references profiles(user_id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  -- null / 'online' = automatic. 'dnd' still counts as present (red dot).
  -- 'invisible' is applied in the SQL that BUILDS the friends response, not in
  -- the React component — a server that sent {online:true,status:'invisible'}
  -- and trusted the client not to render it would leave the truth sitting in a
  -- network response any friend can read in devtools.
  status       text check (status is null or status in ('online', 'dnd', 'invisible'))
);
