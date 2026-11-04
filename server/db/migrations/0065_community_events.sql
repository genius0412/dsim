-- 0065 — COMMUNITY EVENTS (the global toasts)
--
-- The events every online client is told about: a new world record, a new No.1 in ranked, a new
-- supporter. A row is written by whichever machine saw the event (`server/communityEvents.ts`) and
-- read by every machine through a 10-second cache, which is what carries an event across Fly
-- machines, satellites and room worker threads without any of them talking to each other. Clients
-- reach it through the site status poll they already make (`GET /api/status?ev=<cursor>`).
--
-- NOT `announcements` (0008): that table is the "What's new" patch notes an admin writes.
--
-- TINY BY CONSTRUCTION: every insert prunes the table to its newest 200 rows and its last day, so
-- it never grows past a page of rows and the cursor read (`id > $1`) is a primary-key range scan.
--
-- A row holds FACTS (`data`: names, mode, score), never prose; the client words it.
--
-- Purely ADDITIVE, like every migration here: rolling the server back leaves the table unread.

create table if not exists community_events (
  id         bigserial   primary key,
  -- closed vocabulary, `COMMUNITY_KINDS` in src/net/protocol.ts
  kind       text        not null,
  game       text,
  -- WHO IT NAMES. Cascades: an event about an account goes with the account (the names in `data`
  -- are personal data). Null for an anonymous supporter.
  user_id    text        references profiles(user_id) on delete cascade,
  -- a duo record's other driver
  partner_id text        references profiles(user_id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- each foreign key leads an index of its own (dbtest's schema rule): an account deletion finds its
-- rows without scanning the table
create index if not exists community_events_user_idx on community_events (user_id);
create index if not exists community_events_partner_idx on community_events (partner_id);
