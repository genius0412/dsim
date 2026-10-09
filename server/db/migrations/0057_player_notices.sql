-- 0057 — PLAYER NOTICES and RATING REFUNDS
--
-- Every moderation outcome used to stop at the moderator. A misscore claim was upheld and the
-- filer never heard; a score was corrected and the players found out, if at all, by spotting a
-- different number in their history; reports were upheld and the reporters were left to assume
-- nothing happened; a standing edit or an upheld verdict moved a player's number and lock with
-- nothing telling them so at the moment it happened. This is the inbox those outcomes write to.
--
-- WHAT A ROW HOLDS: the FACTS (`data`, jsonb) and a moderator's own words (`message`), never
-- composed prose. `src/notices.ts` words a notice from its facts on the client, so the copy
-- can change without a migration and without rewriting rows already sent.
--
-- Purely ADDITIVE (create-if-not-exists), like every migration here: rolling the server back
-- leaves both tables sitting unread.

create table if not exists player_notices (
  id         bigserial   primary key,
  -- the RECIPIENT. Cascades: a notice is about the account it was sent to, and a deleted
  -- account's inbox is personal data like the rest of it.
  user_id    text        not null references profiles(user_id) on delete cascade,
  -- closed vocabulary, `NOTICE_KINDS` in src/notices.ts. A kind this build does not know is
  -- skipped by the client rather than shown as a blank card.
  kind       text        not null,
  game       text,
  data       jsonb       not null default '{}'::jsonb,
  -- shown to the recipient VERBATIM, length-capped at the API boundary (NOTICE_MESSAGE_MAX)
  message    text,
  created_at timestamptz not null default now(),
  -- null = unread: the pop-up shows it on the next return to the menus
  read_at    timestamptz
);

-- the only reads: one account's inbox, newest first, and its unread rows (a subset of the
-- same scan). Leads with the foreign key's column, as dbtest's schema rule requires.
create index if not exists player_notices_user_idx on player_notices (user_id, created_at desc);

-- RATING GIVEN BACK after a score correction flipped a ranked result (see `refundMatchRatings`).
-- One row per player per match, and the primary key is what makes it ONCE: a match corrected
-- twice cannot refund the same loss twice.
create table if not exists rating_refunds (
  match_id   uuid        not null references matches(id) on delete cascade,
  user_id    text        not null references profiles(user_id) on delete cascade,
  points     integer     not null,
  -- not a foreign key: an admin is an env id (ADMIN_USER_IDS), same as every audit column
  admin_id   text        not null,
  at         timestamptz not null default now(),
  primary key (match_id, user_id)
);
create index if not exists rating_refunds_user_idx on rating_refunds (user_id);
