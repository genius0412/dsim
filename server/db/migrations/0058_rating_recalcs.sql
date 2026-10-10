-- RATING RECALCULATION (2026-10-03).
--
-- Glicko-2 is sequential, so changing how a rating is computed means re-rating every match
-- of the act in order (`server/ratingRecalc.ts`). Three things make that exact and undoable:
--
--  1. `matches.rating_rules` names the rule set that rated the match (`RULE_SETS` in
--     server/ranked.ts). NULL on every older row, which is dated instead (`ruleSetAt`).
--  2. `match_participants.away` / `.early` are what the room told the rating update about
--     partner absence. The ratings alone cannot give them back. NULL on older rows.
--  3. `rating_recalcs` is one row per APPLIED recalculation: what it changed and, in
--     `backup`, every value it overwrote, so it can be put back by hand.

alter table matches add column if not exists rating_rules text;
alter table match_participants add column if not exists away real;
alter table match_participants add column if not exists early boolean;

create table if not exists rating_recalcs (
  id         bigserial   primary key,
  game       text        not null,
  act        integer     not null,
  rules      text        not null,
  -- not a foreign key: an admin is an env id, or 'secret' for the deploy-script path
  admin_id   text        not null,
  summary    jsonb       not null,
  -- { boards: [...], history: [...], participants: [...] } — the rows as they were
  backup     jsonb       not null,
  applied_at timestamptz not null default now()
);
