/**
 * SHARED PLUMBING FOR THE COORDINATION BOARD.
 *
 * Three people work this repo in parallel on Kickoff day and the expensive failure is two of
 * them editing the same file from different sessions. The board is a claim per person — what
 * they are touching, by PATH — kept on a branch nobody works on, in a repository nobody ships.
 *
 * ── WHY THE DATA DOES NOT LIVE IN THIS REPOSITORY ──────────────────────────
 * `genius0412/dsim` is PUBLIC. A branch here is world-readable, so a board on it would publish
 * what three people are building, live, to anyone who finds the repo — and an automatic
 * per-turn publisher makes that worse, because nobody is reviewing each write. So the board
 * goes to a SEPARATE PRIVATE repository, and `assertPrivate` refuses to push anywhere that is
 * not one. That check is code rather than a line in a README because the failure is silent:
 * a push to the wrong remote succeeds and looks exactly like a push to the right one.
 *
 * ── WHY THERE IS NO DEFAULT REMOTE ─────────────────────────────────────────
 * Unconfigured, every entry point here is a NO-OP (the hook) or a one-paragraph explanation
 * (the CLIs). It never falls back to `origin`. A default that publishes is a default that
 * publishes somewhere wrong on somebody's machine, once, and that is not recoverable — a
 * public push is public the moment it lands, whatever happens next.
 *
 * ── WHY IT NEVER CHECKS THE BRANCH OUT ─────────────────────────────────────
 * The whole point is not to interrupt a session that is mid-work. Checking out a branch, or
 * stashing to do it, would reach into a working tree somebody is running tests against — and
 * this repo's stash stack is shared across every worktree, so a stash here can lose another
 * session's work. `writeFileToBranch` therefore builds the commit with PLUMBING: a temporary
 * index, `hash-object`, `write-tree`, `commit-tree`, `push`. Nothing touches HEAD, the index,
 * the working tree or the stash. A publish is invisible to whatever else is running.
 *
 * The commits are ORPHANS chained only to each other, so the private repository holds the
 * claim files and nothing else — none of dsim's history follows them over.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_PATH = join(ROOT, '.coord.json');
/** where the config goes when the board is retired — visible, restorable, and not `.coord.json`,
 * which is the only filename anything here looks for. */
export const RETIRED_PATH = join(ROOT, '.coord.retired.json');
export const BRANCH = 'board';
export const REMOTE = 'coord';

/** a claim older than this is shown as STALE — see the note in board.mjs on why it is shown
 * rather than deleted. */
export const STALE_MIN = 90;

/** consecutive runs that must see the board as gone before the tooling disarms itself. */
export const RETIRE_STRIKES = 2;

/**
 * The directory for this checkout's private git state — where the rate-limit and
 * de-duplication stamps live.
 *
 * ⚠️ **NOT `<root>/.git`.** In a WORKTREE that is a FILE containing a `gitdir:` pointer, so
 * writing a stamp inside it fails on every call — and both writers here swallow their errors,
 * because a coordination stamp must never break a turn. The result is a rate limiter that
 * silently never remembers anything and a publish on every single turn. This repo's working
 * convention is a worktree per branch, so that is the common case, not the edge one.
 * `git rev-parse --git-dir` answers correctly in a worktree, a plain clone and a submodule.
 */
export function gitDir() {
  const d = git(['rev-parse', '--absolute-git-dir']);
  return d || join(ROOT, '.git');
}

/** Run git, return trimmed stdout. `ok: false` turns a non-zero exit into `null` instead of
 * a throw — used for the many "does this ref exist yet" questions where absence is normal. */
export function git(args, { input, ok = true, cwd = ROOT, env, raw = false } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
    });
    // `raw` exists for --porcelain, whose FIRST TWO COLUMNS ARE SIGNIFICANT AND MAY BE BLANK.
    // Trimming ate the leading space of the first line of `git status --porcelain`, so a
    // fixed-width parse took one character off the first path — `.gitignore` was published as
    // `gitignore`, which then matches nothing and silently cannot collide. Every other caller
    // wants a trimmed single value, so trimming stays the default.
    return raw ? out : out.trim();
  } catch (e) {
    if (ok) return null;
    throw e;
  }
}

/**
 * `.coord.json` — NOT committed (it names a private repository and this one is public).
 * `{ "remote": "owner/repo" | "git@…" | "https://…", "name": "saket" }`
 */
export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw.remote !== 'string' || !raw.remote.trim()) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : defaultName();
  return { remote: raw.remote.trim(), name: slug(name) };
}

/** the git identity, as a fallback display name. Nothing depends on it being unique across
 * people — a collision just means two people share a claim file, which they will notice. */
function defaultName() {
  return git(['config', 'user.name']) || 'unknown';
}

/** one path segment, safe as a filename and as a git ref component. */
export function slug(s) {
  const out = String(s)
    .toLowerCase()
    .split('')
    .map((ch) => (/[a-z0-9]/.test(ch) ? ch : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return out || 'unknown';
}

/** `owner/repo` from any of the spellings a person might paste. Returns null when it is not
 * a GitHub remote — which `assertPrivate` treats as "cannot verify", i.e. refuse. */
export function githubSlug(remote) {
  const m =
    /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote) ||
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(remote);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * REFUSE TO PUBLISH TO ANYTHING THAT IS NOT A PRIVATE GITHUB REPOSITORY.
 *
 * Verified through `gh`, on every process that publishes, because visibility is not a
 * property of the URL: a repository can be flipped to public later by anyone with admin on
 * it, and the board would keep pushing to it without a word. "Cannot tell" is a REFUSAL and
 * not a warning — an unverifiable remote is exactly the case where the cost of being wrong is
 * the thing the user asked to avoid.
 */
export function assertPrivate(remote) {
  const slugged = githubSlug(remote);
  if (!slugged) {
    return { ok: false, reason: 'notgithub', why: `not a GitHub remote, so its visibility cannot be checked: ${remote}` };
  }
  const out = ghJson(['repo', 'view', slugged, '--json', 'isPrivate,visibility']);
  if (!out) {
    // TWO VERY DIFFERENT SITUATIONS LOOK IDENTICAL HERE, and conflating them is what would
    // make this thing outstay its welcome. `gh` failing on THIS machine (not installed, not
    // signed in, no network) means "I cannot tell" — refuse, keep everything, try next turn.
    // `gh` working fine while the BOARD specifically cannot be resolved means the board is
    // gone or this account's access to it was removed — which is the owner switching the
    // whole system off, and the only correct response is to stand down. So ask `gh` a
    // question that does not involve the board before deciding which one this is.
    if (!ghWorks()) {
      return { ok: false, reason: 'unverifiable', why: `could not ask GitHub whether ${slugged} is private (is \`gh\` installed and signed in?)` };
    }
    return { ok: false, reason: 'retired', why: `${slugged} no longer exists, or this account's access to it has been removed` };
  }
  if (out.isPrivate !== true) {
    return { ok: false, reason: 'public', why: `${slugged} is ${String(out.visibility || 'not private').toUpperCase()} — the board must not be published to a repository anyone can read` };
  }
  return { ok: true, reason: 'ok', slug: slugged };
}

/** does `gh` work AT ALL on this machine, independently of the board? The answer is what
 * separates "the board is gone" from "I cannot see anything right now". */
function ghWorks() {
  return ghJson(['api', 'user', '--jq', '{login:.login}']) !== null;
}

/**
 * STAND DOWN. The board is over: the repository was deleted or this account was removed from
 * it, which is how the owner turns the system off for everybody at once without having to
 * reach three machines.
 *
 * The config is RENAMED rather than deleted — a person should be able to see what happened and
 * put it back — and renaming is enough, because every entry point keys on `.coord.json`
 * existing. After this the hook is a no-op on every future turn, with no further network
 * calls, until somebody deliberately restores the file.
 */
export function retire(why) {
  const stamp = new Date().toISOString();
  try {
    if (existsSync(CONFIG_PATH)) renameSync(CONFIG_PATH, RETIRED_PATH);
  } catch { /* if the rename fails the next run simply tries again */ }
  try {
    writeFileSync(join(gitDir(), 'coord-retired'), `${stamp} ${why}
`);
  } catch { /* a breadcrumb is a nicety; never fail a turn over it */ }
  try {
    git(['remote', 'remove', REMOTE]);
    git(['update-ref', '-d', `refs/remotes/${REMOTE}/${BRANCH}`]);
  } catch { /* likewise */ }
  for (const f of ['coord-tick', 'coord-last', 'coord-retire', 'coord-refused']) {
    try { rmSync(join(gitDir(), f), { force: true }); } catch { /* likewise */ }
  }
  return { stamp, why };
}

/** how many consecutive runs have now seen the board as gone. A single 404 is not proof —
 * a blip should not tear down three people's setup — so the disarm needs it twice. */
export function retireStrikes(add) {
  const f = join(gitDir(), 'coord-retire');
  let n = 0;
  try { n = Number(readFileSync(f, 'utf8').trim()) || 0; } catch { /* first strike */ }
  if (!add) { try { rmSync(f, { force: true }); } catch { /* nothing to clear */ } return 0; }
  n += 1;
  try { writeFileSync(f, String(n)); } catch { /* an un-writable stamp just means no memory */ }
  return n;
}

function ghJson(args) {
  try {
    const out = execFileSync('gh', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** point the `coord` remote at the configured repository, idempotently. */
export function ensureRemote(remote) {
  const url = githubSlug(remote) && !remote.includes('://') && !remote.includes('@')
    ? `https://github.com/${githubSlug(remote)}.git`
    : remote;
  const existing = git(['remote', 'get-url', REMOTE]);
  if (existing === null) git(['remote', 'add', REMOTE, url], { ok: false });
  else if (existing !== url) git(['remote', 'set-url', REMOTE, url], { ok: false });
  return url;
}

export function fetchBoard() {
  // a missing branch is the normal first-run state, not an error.
  git(['fetch', '--quiet', REMOTE, `+refs/heads/${BRANCH}:refs/remotes/${REMOTE}/${BRANCH}`]);
  return git(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${BRANCH}`]);
}

/** every claim currently on the board, newest first. */
export function readClaims() {
  const head = git(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${BRANCH}`]);
  if (!head) return [];
  const listing = git(['ls-tree', '--name-only', `${head}:claims`]) || '';
  const out = [];
  for (const file of listing.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const body = git(['show', `${head}:claims/${file}`]);
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // a claim file that is not JSON is somebody mid-edit or a bad merge — skip it rather
      // than fail the whole board, which is the one thing that must always render.
    }
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

/**
 * Commit `content` at `path` on the board branch and push it — no checkout, no index, no
 * working-tree write. Retries on a non-fast-forward, which is the ordinary outcome when two
 * people publish at once: each writes a DIFFERENT file, so re-reading the newer tree and
 * rebuilding on top always converges. Nothing is ever overwritten, so no force is needed.
 */
export function writeFileToBranch(path, content, message, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const parent = fetchBoard();
    const idx = mkdtempSync(join(tmpdir(), 'coord-idx-'));
    const indexFile = join(idx, 'index');
    try {
      const env = { GIT_INDEX_FILE: indexFile };
      if (parent) git(['read-tree', parent], { env, ok: false });
      const blob = git(['hash-object', '-w', '--stdin'], { input: content, ok: false });
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env, ok: false });
      const tree = git(['write-tree'], { env, ok: false });
      const args = ['commit-tree', tree, '-m', message];
      if (parent) args.push('-p', parent);
      const commit = git(args, { ok: false });
      git(['push', '--quiet', REMOTE, `${commit}:refs/heads/${BRANCH}`], { ok: false });
      // keep the local tracking ref honest so a board read right after a publish is current.
      git(['update-ref', `refs/remotes/${REMOTE}/${BRANCH}`, commit]);
      return { ok: true, commit };
    } catch (e) {
      lastErr = e;
    } finally {
      rmSync(idx, { recursive: true, force: true });
    }
  }
  return { ok: false, error: lastErr };
}

/** minutes since an RFC3339 stamp; Infinity when it is missing or unparseable. */
export function ageMin(iso) {
  const t = Date.parse(String(iso || ''));
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

/**
 * The paths a claim effectively covers: the ones its owner NAMED, plus the ones their working
 * tree is actually dirty on. Both matter and for different reasons — the named paths are
 * intent (what they are about to touch, which git cannot know yet) and the dirty paths are
 * fact (what they have already changed, which they may have forgotten to name).
 */
export function claimPaths(claim) {
  const named = Array.isArray(claim.paths) ? claim.paths : [];
  const dirty = Array.isArray(claim.auto?.dirty) ? claim.auto.dirty : [];
  return [...new Set([...named, ...dirty].map((p) => String(p).replace(/\\/g, '/').trim()).filter(Boolean))];
}

/** directory-aware prefix overlap: `src/games` covers `src/games/biobuzz/step.ts`, and
 * `src/games` does NOT cover `src/gameshow.ts`. */
export function overlaps(a, b) {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** every pair of active claims that touch the same path. This is the whole anti-double-up
 * mechanism, and it is computable precisely because claims are keyed on paths. */
export function collisions(claims) {
  const live = claims.filter((c) => ageMin(c.updatedAt) <= STALE_MIN);
  const out = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (live[i].name === live[j].name) continue;
      const hit = [];
      for (const pa of claimPaths(live[i])) {
        for (const pb of claimPaths(live[j])) if (overlaps(pa, pb)) hit.push(pa === pb ? pa : `${pa} ∩ ${pb}`);
      }
      if (hit.length) out.push({ a: live[i], b: live[j], paths: [...new Set(hit)] });
    }
  }
  return out;
}

/** what this working tree is doing RIGHT NOW — the only thing the automatic publisher sends.
 * Derived entirely from git: no conversation text, no file contents, no environment. */
export function localState() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || '(detached)';
  const head = git(['rev-parse', '--short', 'HEAD']) || '';
  const headSubject = git(['log', '-1', '--format=%s']) || '';
  const porcelain = git(['status', '--porcelain'], { raw: true }) || '';
  const dirty = porcelain
    .split('\n')
    // Two status columns, one space, then the path — MATCHED, never sliced at a fixed width,
    // so a blank status column cannot shift the path by a character.
    .map((l) => /^..\s(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].split(' -> ').pop().replace(/^"|"$/g, '').trim())
    .filter(Boolean)
    .slice(0, 40);
  return { branch, head, headSubject, dirty, at: new Date().toISOString() };
}

export function explainUnconfigured() {
  if (existsSync(RETIRED_PATH)) {
    let when = '';
    try { when = readFileSync(join(gitDir(), 'coord-retired'), 'utf8').trim(); } catch { /* fine */ }
    return [
      'The coordination board has been RETIRED — the board repository is gone, or this',
      'account no longer has access to it. Nothing is published any more and nothing here',
      'needs doing; work normally.',
      ...(when ? ['', `  ${when}`] : []),
      '',
      `The old config was kept at ${RETIRED_PATH}. Renaming it back to .coord.json is all it`,
      'takes to start again, if the board comes back.',
    ].join('\n');
  }
  return [
    'The coordination board is not configured in this checkout.',
    '',
    `Create ${CONFIG_PATH} (it is gitignored — it names a PRIVATE repository and this one is public):`,
    '',
    '  { "remote": "owner/dsim-coord", "name": "yourname" }',
    '',
    'Then: npm run coord:setup',
  ].join('\n');
}
