-- RANKED (ELO) no longer divides by DRIVETRAIN — collapse every rating board to
-- one per (user × mode × season). Only the cross-drivetrain 'overall' rows
-- survive (they hold each player's real rating); the per-drivetrain rating rows
-- are dropped. RECORD leaderboards KEEP their per-drivetrain divisions untouched
-- (records.drivetrain stays), as does match_participants.drivetrain (history).
delete from elo_ratings where drivetrain <> 'overall';
drop index if exists elo_board_idx;
alter table elo_ratings drop constraint if exists elo_ratings_pkey;
alter table elo_ratings drop column if exists drivetrain;
alter table elo_ratings add primary key (user_id, mode, balance_version);
create index if not exists elo_board_idx
  on elo_ratings (balance_version, mode, rating desc);
