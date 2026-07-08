-- Public USERNAME: a unique, lowercase [a-z0-9] handle that keys a player's public
-- profile URL (/profile/<username>) and @-mention on the boards. Distinct from
-- `handle` (the freeform display name): handle is what's SHOWN, username is the
-- stable, unique slug. Nullable so LEGACY profiles (created before this migration)
-- keep working until the player is prompted to choose one — a unique index lets
-- many rows stay NULL (Postgres treats NULLs as distinct) while forbidding dupes.
alter table profiles add column if not exists username text;

-- usernames are stored already-lowercased & validated ([a-z0-9]), so a plain
-- unique index is case-exact and sufficient. Reads by username hit it directly.
create unique index if not exists profiles_username_key on profiles (username);
