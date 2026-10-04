-- 0060 — COMPETITION RANKING POINTS (docs/area/competitions.md)
--
-- Ranking points per each game's Competition Manual (`src/competition/manual.ts`): bonus RPs read
-- what the game measured in a match, a referee can rule on them, and cards escalate into DQs.
-- Like 0059 these columns hold what was DECIDED or MEASURED; the RP each match gave, the effective
-- DQs and the rankings are derived from them on every read.
--
-- Purely ADDITIVE: every column is nullable with no default, so a row from before this migration
-- reads as "unknown", and rolling the server back leaves the columns unread.

-- what the game measured per alliance (`AllianceFacts`), `{"red": {...}, "blue": {...}}`: reported
-- by the room for a played match, patched by a referee. Null = unknown (a forfeit, a result typed
-- by hand, or a row from before 0060), never 0.
alter table competition_matches add column if not exists facts jsonb;
-- a referee's bonus-RP rulings per alliance, `{"red": {"pattern": "award"}, "blue": {...}}`
alter table competition_matches add column if not exists rp_rulings jsonb;
-- cards the SIM showed in the played match, per entry id: `{"12": "yellow"}`. Replaced by each
-- played result; a referee's own cards are kept apart in `ref_cards`.
alter table competition_matches add column if not exists cards jsonb;
-- cards a REFEREE showed in this match, per entry id, the same shape as `cards`
alter table competition_matches add column if not exists ref_cards jsonb;
-- the competition's ranking rules (`ResolvedRanking`), FROZEN when qualifications start under the
-- manual scheme, so a later edit of a manual table cannot re-rank an event already under way.
-- Null = not frozen: read the live table.
alter table competitions add column if not exists rp_table jsonb;
-- the accounts a log line is about (`data.users`, on every line about an entry), so deleting an
-- account finds every line that names it, an entry deleted before the start included
create index if not exists competition_log_users_idx on competition_log using gin ((data -> 'users'));
