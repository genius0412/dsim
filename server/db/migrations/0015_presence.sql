-- Cross-machine presence aggregation.
--
-- The app runs ONE machine per Fly region, and each machine tracks its live sockets
-- ONLY in memory. GET /api/presence is anycast-routed to whichever machine is nearest
-- the caller, so it reports just THAT machine's count — a client polling an empty
-- region (or a freshly cold-started one) sees "0 online" while players are connected
-- to another region (usually the warm matchmaker region). Fix: every machine
-- heartbeats its snapshot here, and /api/presence returns the SUM across machines with
-- a fresh heartbeat (de-duping signed-in users who are on more than one region).
create table if not exists presence (
  machine text primary key,          -- FLY_MACHINE_ID (unique per machine)
  region text not null default '',
  online int not null default 0,     -- open sockets on this machine
  authed jsonb not null default '[]'::jsonb, -- distinct signed-in userIds on this machine
  q1v1 int not null default 0,       -- ranked 1v1 queue depth (matchmaker region only)
  q2v2 int not null default 0,       -- ranked 2v2 queue depth (matchmaker region only)
  updated_at timestamptz not null default now()
);
create index if not exists presence_fresh_idx on presence (updated_at);
