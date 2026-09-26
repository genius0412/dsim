/**
 * STAFF IDS, parsed from the environment once. Split out of `index.ts` so the site gate
 * (`siteState.ts`) and the HTTP API can ask "is this an admin" without importing the server.
 */
// accounts allowed to use the admin API (their auth-JWT `sub`/userId). Set as a
// Fly secret: ADMIN_USER_IDS="uuid1,uuid2". Empty => admin API is locked to nobody.
export const ADMIN_LIST = (process.env.ADMIN_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const ADMIN_IDS = new Set(ADMIN_LIST);

/**
 * The OWNER — one account, badged apart from the admins it otherwise sits with.
 *
 * Defaults to the FIRST id in `ADMIN_USER_IDS` rather than requiring a second
 * secret, because that list has always been owner-first in practice and a feature
 * that silently does nothing until someone sets an env var they were never told
 * about is worse than a documented default. Set `OWNER_USER_ID` explicitly to
 * override it.
 *
 * Owner implies admin: the gate above is `ADMIN_IDS`, and the owner is in it.
 */
export const OWNER_ID = (process.env.OWNER_USER_ID ?? '').trim() || ADMIN_LIST[0] || null;
