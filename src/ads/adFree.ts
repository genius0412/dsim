/**
 * WHO NEVER SEES AN AD. Pure, so `npm test` holds it: a supporter (a paid membership), staff (an
 * owner or admin, who are entitled by role and so arrive here as `supporter` too), and a
 * CONTRIBUTOR (an access group an admin grants, `AccessGroup` in `src/net/protocol.ts`). Beta
 * testers and devs are NOT exempt: they are testers, not people who have given something to the
 * project, and the owner's list was supporter, admin and contributor.
 *
 * `undefined` for any field means "the server did not say" (an older build, or a swallowed
 * failure), which is NOT exempt: an ad gate fails toward showing ads only after it has settled, and
 * `AdsProvider` already holds ads back until it has (the other half of "fail closed").
 *
 * UX ONLY. The server never enforces anything on this: an ad is a render decision, and the worst a
 * wrong answer does is show or hide a rectangle.
 */
export interface AdExemptionFacts {
  supporter?: boolean;
  /** 'owner' | 'admin' */
  role?: string;
  contributor?: boolean;
}

export function isAdFree(e: AdExemptionFacts | null | undefined): boolean {
  if (!e) return false;
  return e.supporter === true || e.role === 'owner' || e.role === 'admin' || e.contributor === true;
}
