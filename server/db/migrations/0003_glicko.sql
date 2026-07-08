-- Glicko-2 ratings (chess.com-style): each rating gains a rating DEVIATION (RD,
-- the confidence interval) and a VOLATILITY. New/idle players carry a high RD so
-- their rating swings hard early, then settles as RD shrinks with games played.
-- Existing rows become provisional again (RD 350) so they re-converge cleanly.
alter table elo_ratings add column if not exists rd  real not null default 350;
alter table elo_ratings add column if not exists vol real not null default 0.06;
