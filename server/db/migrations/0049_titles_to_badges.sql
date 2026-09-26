-- 0049 — TITLES FOLD INTO BADGES (owner, 2026-09-24: "titles are now essentially the same thing
-- as badges. Just combine it all to badges … and remove titles completely").
--
-- Every competitive grant since 0048 delivered a title AND a badge for the same finish, so the
-- title said nothing the badge did not. The one title with no badge twin was the GitHub star's,
-- `title:stargazer`; it becomes the `stargazer` badge (src/badges.ts). Which act or season a
-- badge came from stays on its grant's `reason`, which the profile's trophy case reads.
--
-- Order matters: the grants are rewritten FIRST, so the "wear it" step below can count the new
-- stargazer badge off them.

-- ── 1. the ledger: title items out, the star's title becomes its badge ──────────────────────
-- Order within `items` is kept (`with ordinality`), so the star grant reads badge, then decal.
-- A grant left with no items would be a grant for nothing; none exists (every competitive grant
-- carried a badge), but `coalesce` keeps the column's `not null` honest if one ever did.
update reward_grants g
   set items = coalesce((
         select jsonb_agg(
                  case when e.it->>'id' = 'title:stargazer'
                       then '{"kind":"badge","id":"stargazer"}'::jsonb
                       else e.it end
                  order by e.ord)
           from jsonb_array_elements(g.items) with ordinality as e(it, ord)
          where e.it->>'kind' <> 'title' or e.it->>'id' = 'title:stargazer'
       ), '[]'::jsonb)
 where jsonb_typeof(g.items) = 'array'
   and exists (select 1 from jsonb_array_elements(g.items) as x(it) where x.it->>'kind' = 'title');

-- ── 2. whoever was WEARING a title now wears its badge, if they hold it and have room ──────
-- A podium title maps to its podium badge, a record title to Record Holder, the star to the
-- stargazer badge. "Hold it" is the same count `badgeCounts` (repo.ts) takes: claimed,
-- unrevoked grants carrying the id — so a retired per-season title (0045), which never came
-- with a badge, maps to nothing and is simply taken off. "Room" is MAX_EQUIPPED_BADGES (3,
-- src/badges.ts): the title had its own slot, and three badges the player chose are not
-- displaced for it.
with wear as (
  select p.user_id,
         case
           when p.title = 'title:stargazer' then 'stargazer'
           when p.title ~ '^award:[^:]+:[^:]+:ranked(_act)?:' then
             case regexp_replace(p.title, '^.*:', '')
               when '1' then 'ranked-gold'
               when '2' then 'ranked-silver'
               when '3' then 'ranked-bronze'
             end
           when p.title ~ '^award:[^:]+:[^:]+:record_' then 'record-holder'
         end as badge
    from profiles p
   where p.title is not null
), held as (
  select w.user_id, w.badge, count(*)::int as n
    from wear w
    join reward_grants g on g.user_id = w.user_id and g.claimed_at is not null and g.revoked_at is null
    cross join lateral jsonb_array_elements(g.items) as x(it)
   where w.badge is not null and x.it->>'kind' = 'badge' and x.it->>'id' = w.badge
   group by w.user_id, w.badge
)
update profiles p
   set equipped_badges = p.equipped_badges || jsonb_build_array(jsonb_build_object('id', h.badge, 'n', h.n))
  from held h
 where p.user_id = h.user_id
   and jsonb_typeof(p.equipped_badges) = 'array'
   and jsonb_array_length(p.equipped_badges) < 3
   and not exists (select 1 from jsonb_array_elements(p.equipped_badges) as b(it) where b.it->>'id' = h.badge);

-- ── 3. the star's title leaves the inventory ─────────────────────────────────────────────────
-- A claimed ledger title was written into `profiles.cosmetics` beside the decal (0044's jsonb
-- array). The badge has no inventory entry — it is read off the grant — so the id goes.
update profiles set cosmetics = cosmetics - 'title:stargazer' where cosmetics ? 'title:stargazer';

-- ── 4. nobody wears a title any more ─────────────────────────────────────────────────────────
-- The COLUMN STAYS, like every retired column here: a rollback's older server still selects
-- it, and it reads null, which that server renders as "no title".
update profiles set title = null where title is not null;

comment on column profiles.title is
  'RETIRED 0049: titles folded into badges. Always null; nothing reads or writes it. Kept so an older server still finds the column.';
comment on table season_awards is
  'RETIRED 0048: no longer written. Its rows stay in the profile trophy case (trophyCase, server/db/repo.ts). Titles, which it once made wearable, were retired in 0049.';
