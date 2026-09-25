-- 0051 — LOCKDOWN SCOPE, AND THE ACCESS GROUPS THAT MAY BYPASS IT.
--
-- 0023's window only ever meant "no new matches". It now carries a SCOPE:
--   matches  the old behaviour: joins, queueing, LAN hosting and new starts are refused
--   site     the whole app is closed: every page shows the closed screen, and the server
--            also refuses spectating, LAN joins and every /api write (server/siteState.ts)
-- plus the player-facing redirect (a link + its label) and the ACCESS GROUPS that pass it.
-- Admins (ADMIN_USER_IDS) always pass and are not a group.
--
-- Defaults reproduce 0023 exactly, so an older server reading the row and an older console
-- writing it both keep meaning "matches, nobody bypasses".
alter table maintenance add column if not exists scope text not null default 'matches';
alter table maintenance drop constraint if exists maintenance_scope;
alter table maintenance add constraint maintenance_scope check (scope in ('matches', 'site'));
alter table maintenance add column if not exists redirect_url text;
alter table maintenance add column if not exists redirect_label text;
alter table maintenance add column if not exists bypass text[] not null default '{}';

-- ACCESS GROUPS: beta testers, developers and contributors. Membership is by USER ID, never
-- by handle (handles change); the console resolves a player tag to an id at grant time.
-- Cascades with the profile: a deleted account leaves no membership behind.
--
-- Each deployment keeps its own list. The alpha server reads the alpha database, so alpha
-- testers are granted THERE (docs/deploy.md).
create table if not exists access_members (
  user_id    text        not null references profiles (user_id) on delete cascade,
  grp        text        not null,
  granted_by text        not null,
  granted_at timestamptz not null default now(),
  note       text        not null default '',
  primary key (user_id, grp),
  constraint access_members_grp check (grp in ('beta', 'dev', 'contributor'))
);
-- the console's list, one group at a time, newest first
create index if not exists access_members_grp_idx on access_members (grp, granted_at desc);
