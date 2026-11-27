/**
 * WHEN THE BACKGROUND UPDATE CHECK MAY OPEN A DIALOG (manual mode only).
 *
 * Pure: no `require('electron')`, so `scripts/smoke.ts` loads it directly.
 *
 * Where the app cannot install updates itself (macOS, the portable exe) the launch check is a
 * blocking "a new version is available" dialog. Every push to main now releases, so a player on
 * one of those is behind almost always, and it would open at every launch for a shell whose
 * content (the live site) is already current. So the background check tells a player about a
 * given version ONCE, and at most once a week. The menu's own "Check for Updates" never asks
 * this: a player who asked is always answered.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const bare = (v) => String(v).trim().replace(/^v/i, '');

/**
 * `prefs` is the parsed `update-pref.json` (any shape: a corrupt file reads as `{}`), `latest`
 * the newest release's version, `now` the clock in ms. True when the dialog may open; the caller
 * then stores `notifiedVersion` and `notifiedAt`.
 */
function shouldNotify(prefs, latest, now) {
  if (latest === null || latest === undefined || bare(latest) === '') return false;
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  if (typeof p.notifiedVersion === 'string' && bare(p.notifiedVersion) === bare(latest)) return false;
  const at = p.notifiedAt;
  // a stamp in the future means the clock moved; it must not mute the dialog for years
  if (typeof at === 'number' && Number.isFinite(at) && at <= now && now - at < WEEK_MS) return false;
  return true;
}

module.exports = { shouldNotify, WEEK_MS };
