-- 0054 — ACCOUNT TOMBSTONES: a deleted account's SANCTIONS outlive the account.
--
-- `POST /api/user/delete` removes the `profiles` row, and with it everything keyed to it:
-- `profiles.suspended_until` (0043), and `account_standing` / `standing_events` by cascade
-- (0027). The Neon Auth identity is NOT deleted (it lives in the provider), so the same user
-- id is still signed in a second later — and the doors read "no profile row" as "not
-- suspended" and "no standing row" as a full score. A permanently banned player could type
-- DELETE and play again at once; a player locked out of ranked could do the same.
--
-- So `deleteAccount` leaves ONE row here when, and only when, there is a sanction to carry:
-- a suspension still in the future, a ranked lock still in the future, or a standing score
-- below the maximum. `getSuspension` and `getStanding` read it while the account has no row
-- of its own, and `ensureProfile` RE-APPLIES and deletes it the moment the account is
-- re-created.
--
-- ⚠️ MINIMAL ON PURPOSE. The account is being deleted because somebody asked for their data
-- to go, so this holds the opaque auth id and three moderation facts and nothing else: no
-- handle, no username, no email, and NOT `suspended_reason` — that is a moderator's free text
-- about the person and may name somebody. A re-applied suspension therefore shows the door's
-- generic sentence. The ledger (`standing_events`) is not carried either: the escalation rung
-- resets, the score and the lock do not.
--
-- NO FOREIGN KEY, by construction: the row exists precisely because the profile does not.
create table if not exists account_tombstones (
  user_id             text        primary key,
  suspended_until     timestamptz,
  standing_score      integer,
  standing_healed_at  timestamptz,
  restricted_until    timestamptz,
  deleted_at          timestamptz not null default now()
);

comment on table account_tombstones is
  'Sanctions of a DELETED account, carried until the same auth id re-creates a profile (ensureProfile re-applies and deletes the row). Opaque id + suspension deadline + standing score/lock only; no personal data. Written by deleteAccount only when there is a sanction to carry.';
