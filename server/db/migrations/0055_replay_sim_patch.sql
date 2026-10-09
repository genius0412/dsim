-- 0055 — REPLAYS REMEMBER THE `SIM_PATCH` THEY WERE RECORDED UNDER.
--
-- `SIM_PATCH` (`src/config.ts`) is a behaviour fix inside one SIM_VERSION that keeps older
-- replays playable: a replay re-simulates under the rules its patch names. Patch 1 is BIOBUZZ
-- 3D's "an element joins a FLOWER through the top only", and it shipped WITHOUT the stamp, so
-- every 3D replay recorded before it re-simulated into a different match (the top eight
-- records replayed at 55–186 against a real 674–726). NULL here reads as patch 0: the old rule.
--
-- THE BACKFILL: rows recorded after patch 1 went live but before the recorder stamped it.
-- Only BIOBUZZ 3D on SIM_VERSION 4 is affected by patch 1; every other row stays NULL, which
-- is exact for it (the gated rule is 3D BIOBUZZ's alone).
--   * CLIENT-recorded (practice runs, LAN archives): the site build had the rule from
--     2026-09-27 08:34:35Z.
--   * SERVER-recorded (everything else): the game server restarted onto it 17:15:16–17:16:25Z.
--     A restart ends every room and a match lasts ~2.7 min, so nothing saved before 17:16:30
--     ran the new rule and nothing saved after it ran the old one.
--
-- THE DEFAULT is 1 so an insert from a machine still on the unstamped build during this
-- deploy's rolling restart — which runs patch 1 — lands stamped. Current code writes the
-- column explicitly. A later patch raises the default in its own migration.
alter table replays add column if not exists sim_patch smallint;

update replays set sim_patch = 1
 where sim_patch is null
   and game = 'biobuzz' and physics = '3d' and behaviour_version = 4
   and (
     (created_at >= '2026-09-27T08:34:35Z'
       and (id in (select replay_id from practice_runs where replay_id is not null)
         or id in (select replay_id from lan_runs where replay_id is not null)))
     or created_at >= '2026-09-27T17:16:30Z'
   );

alter table replays alter column sim_patch set default 1;
