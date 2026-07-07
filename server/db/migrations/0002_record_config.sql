-- Store the robot configuration a record run was set with, so the leaderboard can
-- show what each entry was driving. `config` = { spec: RobotSpec, assists:
-- AssistConfig } as JSON; nullable (rows written before this migration have none).
alter table records add column if not exists config jsonb;
