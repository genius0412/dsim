-- ELO PERSISTS ACROSS SEASONS WITHIN AN ACT.
--
-- New rule: a SEASON reset (new balance_version, same act) wipes only the RECORD boards; the
-- ranked ELO ratings carry over. Ratings are wiped ONLY on an ACT reset (act++). So re-key
-- `elo_ratings` from the season (balance_version) to the ACT. Records/matches stay keyed by
-- balance_version (season) — unchanged; a new season still starts them empty.

alter table elo_ratings add column if not exists act integer not null default 0;

-- backfill each rating's act from its season row (default 0/beta if that season row is gone)
update elo_ratings e
   set act = coalesce(s.act, 0)
  from seasons s
 where s.game = e.game and s.balance_version = e.balance_version;

-- rows that now collide on (user, mode, game, act) — a player rated across two seasons of the
-- same act — collapse to the most-recent season's row (highest balance_version wins).
delete from elo_ratings e
 using elo_ratings e2
 where e.user_id = e2.user_id and e.mode = e2.mode and e.game = e2.game and e.act = e2.act
   and e.balance_version < e2.balance_version;

-- re-key the PK from (…, balance_version) to (…, act), then drop the season column + old index
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'elo_ratings_game_pkey' and conrelid = 'elo_ratings'::regclass) then
    alter table elo_ratings drop constraint elo_ratings_game_pkey;
  end if;
  if exists (select 1 from pg_constraint where conname = 'elo_ratings_pkey' and conrelid = 'elo_ratings'::regclass) then
    alter table elo_ratings drop constraint elo_ratings_pkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'elo_ratings_act_pkey' and conrelid = 'elo_ratings'::regclass) then
    alter table elo_ratings add constraint elo_ratings_act_pkey primary key (user_id, mode, game, act);
  end if;
end $$;

drop index if exists elo_board_idx;
alter table elo_ratings drop column if exists balance_version;
create index if not exists elo_board_idx on elo_ratings (game, act, mode, rating desc);
