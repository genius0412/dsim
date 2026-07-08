-- Season archival support. Seasons are keyed by `balance_version` (see 0001);
-- the live season is now DB-controlled (repo.currentSeasonNumber / startNewSeason)
-- so it can be advanced at runtime without a redeploy. Archiving a season and
-- deleting its replays needs a fast bulk delete-by-season on `replays`, which had
-- no index on balance_version (only its PK). Add it. The record/match FKs onto
-- replays are `on delete set null`, so purging archived replays keeps the boards.
create index if not exists replays_season_idx on replays (balance_version);
