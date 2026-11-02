-- 0064 — A DUO RECORD KEEPS HOW THE PARTNER DROVE (owner, 2026-11-01: field-centric / robot-centric,
-- auto intake and the rest "isn't shown for the duo PARTNER. it SHOULD show").
--
-- `records.config` stored the partner's BUILD (`partnerSpec`) but only the first driver's assists,
-- so the board had nothing to print under the partner's robot. `persistMatch` now writes
-- `partnerAssists`; this fills it for the duo runs already on the boards, from the run's replay,
-- whose `setups` hold every robot's spec AND assists.
--
-- ⚠️ THE PARTNER'S SETUP IS FOUND BY ITS BUILD, NOT ITS POSITION. A replay names no account, and
-- the first driver is the first SIGNED-IN participant in client order, which a reconnect reorders,
-- so `setups[1]` is not reliably the partner. A setup is the partner's when its spec equals the
-- stored `partnerSpec` AND the OTHER setup's equals the stored `spec` (names aside: both are
-- moderated, possibly at different times). Two drivers on identical builds match both ways round;
-- that is only taken when their assists agree, so it cannot pick the wrong one. A run whose replay
-- is gone, or that matches neither way, keeps no value and the board says it was not saved.
--
-- Idempotent: a row that already has the key is never touched, so a rerun changes nothing.
set local lock_timeout = '5s';

with cand as (
  select r.id, p.value -> 'assists' as assists
    from records r
    join replays rp on rp.id = r.replay_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(rp.setups) = 'array' then rp.setups else '[]'::jsonb end
    ) with ordinality as p(value, i)
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(rp.setups) = 'array' then rp.setups else '[]'::jsonb end
    ) with ordinality as q(value, j)
   where r.mode = 'duo'
     and jsonb_typeof(r.config -> 'partnerSpec') = 'object'
     and not (r.config ? 'partnerAssists')
     and case when jsonb_typeof(rp.setups) = 'array' then jsonb_array_length(rp.setups) end = 2
     and p.i <> q.j
     and jsonb_typeof(p.value -> 'assists') = 'object'
     and (p.value -> 'spec') - 'name' - 'teamName' = (r.config -> 'partnerSpec') - 'name' - 'teamName'
     and (q.value -> 'spec') - 'name' - 'teamName' = (r.config -> 'spec') - 'name' - 'teamName'
), sure as (
  select id, (array_agg(assists))[1] as assists
    from cand
   group by id
  having count(distinct assists) = 1
)
update records r
   set config = r.config || jsonb_build_object('partnerAssists', sure.assists)
  from sure
 where r.id = sure.id;
