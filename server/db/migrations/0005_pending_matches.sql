-- Region-aware matchmaking: the designated matchmaker machine STAGES a paired
-- ranked match here, and the fair host-region machine CLAIMS it (delete-returning)
-- when the players reconnect with ?room=<code>. The roster is authoritative (the
-- host ignores client-supplied specs), so a client cannot tamper with a ranked
-- match. Rows are short-lived: deleted on claim, reaped by created_at if abandoned.
create table if not exists pending_matches (
  code        text primary key,
  host_region text        not null,
  mode        text        not null,
  seed        bigint      not null,
  roster      jsonb       not null,
  ranked      boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists pending_matches_created_idx on pending_matches (created_at);
