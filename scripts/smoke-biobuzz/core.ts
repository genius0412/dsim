/**
 * SHARED-CORE checks for the game-agnostic seam (Phase 0 items 2-4 and 7).
 *
 * They live in the BIOBUZZ suite rather than being appended to `scripts/smoke.ts`
 * on purpose: `smoke.ts` is the ~1289-check physics transcript that is diffed
 * against a recorded baseline (`docs/biobuzz/baseline-alpha.md`), and this work
 * has to be provably free of NEW failures there. Nothing below steps physics —
 * these are the registry, the clamps, the channel rule and the two STATIC
 * crawler files.
 *
 * `field.ts` and `robot.ts` are the two lanes' files; this one is the seam's, and
 * it stays owned by whoever owns the shared core.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_IDS, coerceGameId, isGameId, type GameId } from '../../src/games/types';
import { GAMES, moduleFor, registeredGames } from '../../src/games';
import { SIM_GAMES, simModuleFor } from '../../src/games/sim';
import { coerceStartIndex } from '../../src/net/sanitize';
import { coerceSetup, DEFAULT_ASSISTS, DEFAULT_SPEC } from '../../src/sim/spawn';
import {
  SEASONS,
  gameVisibleOn,
  seasonVisibleOn,
  visibleGameIdsOn,
  visibleSeasonsOn,
} from '../../src/seasons';
import { HOME_DESC } from '../../src/seo';
import { CHAIN_CATALYST_LABELS } from '../../src/games/chain/labels';
import { BB_HOOD_DEFAULT_DEG } from '../../src/games/biobuzz/config';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { bbLauncherOf, bbLiftOf } from '../../src/games/biobuzz/mechs';
import type { BbMechSpec } from '../../src/games/biobuzz/mechs';
import { bbCoerce, type Check } from './harness';

/** a section heading in the log — the suite is read as a transcript, like smoke.ts */
function section(title: string): void {
  console.log(`
---- ${title} ${'-'.repeat(Math.max(0, 70 - title.length))}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepo = (p: string): string => readFileSync(join(root, p), 'utf8');

export function coreChecks(check: Check): void {
  // ---- registry integrity, for EVERY id ------------------------------------
  // Both registries are typed PARTIAL and both resolvers fall back to DECODE, so
  // an unregistered id is a SILENT downgrade: a player picks the game, gets a
  // DECODE world, and nothing says so. Assert every id in the union is actually
  // registered, in BOTH registries, and that each module agrees about its own id.
  section('registry integrity');
  check('GAME_IDS starts with decode (the fallback)', GAME_IDS[0] === 'decode');
  check('GAME_IDS has no duplicates', new Set(GAME_IDS).size === GAME_IDS.length);
  for (const id of GAME_IDS) {
    const sim = simModuleFor(id);
    check(`${id}: registered in GAMES (client)`, !!GAMES[id]);
    check(`${id}: registered in SIM_GAMES (server-safe)`, !!SIM_GAMES[id]);
    check(`${id}: moduleFor id round-trips`, moduleFor(id).id === id);
    check(`${id}: simModuleFor id round-trips`, sim.id === id);
    check(
      `${id}: startPoseCount is a positive integer`,
      Number.isInteger(sim.startPoseCount) && sim.startPoseCount > 0,
      String(sim.startPoseCount),
    );
    check(
      `${id}: initialAct is a non-negative integer`,
      Number.isInteger(sim.initialAct) && sim.initialAct >= 0,
      String(sim.initialAct),
    );
    check(`${id}: has a SEASONS entry`, SEASONS.some((s) => s.key === id));
  }
  check(
    'registeredGames() covers every id',
    registeredGames().length === GAME_IDS.length,
    `${registeredGames().length}/${GAME_IDS.length}`,
  );
  // every game's initialAct is distinct: a shared act would put two games' first
  // ranked period in the same bucket
  check(
    'initialAct is distinct per game',
    new Set(GAME_IDS.map((g) => simModuleFor(g).initialAct)).size === GAME_IDS.length,
  );
  // the back-compat rule: an absent or unknown game is DECODE, never a throw
  check('moduleFor(undefined) is decode', moduleFor(undefined).id === 'decode');
  check('simModuleFor(null) is decode', simModuleFor(null).id === 'decode');
  check('simModuleFor("nope") is decode', simModuleFor('nope' as GameId).id === 'decode');

  // ---- coerceGameId / isGameId --------------------------------------------
  section('game id coercion');
  for (const id of GAME_IDS) {
    check(`coerceGameId round-trips ${id}`, coerceGameId(id) === id);
    check(`isGameId accepts ${id}`, isGameId(id));
  }
  check('coerceGameId(undefined) is decode', coerceGameId(undefined) === 'decode');
  check('coerceGameId("nope") is decode', coerceGameId('nope') === 'decode');
  check('coerceGameId honours its fallback', coerceGameId('nope', 'chain') === 'chain');
  check('coerceGameId("DECODE") is decode (no case folding)', coerceGameId('DECODE') === 'decode');
  check('isGameId rejects a non-string', !isGameId(3));
  check('isGameId rejects "nope"', !isGameId('nope'));

  // ---- per-game start-index clamp (item 3) --------------------------------
  // The clamp used DECODE's five anchors for every game. CR has four, so index 4
  // survived a switch to CR; a game with FEWER anchors than DECODE would accept
  // an index it cannot resolve at all.
  section('per-game start-index clamp');
  const cr = simModuleFor('chain').startPoseCount;
  const dec = simModuleFor('decode').startPoseCount;
  check('DECODE has more anchors than CR (the reason this bug hid)', dec > cr, `${dec} vs ${cr}`);
  check('CR keeps index 3', coerceStartIndex(3, 'chain') === 3);
  check('DECODE keeps index 4', coerceStartIndex(4, 'decode') === 4);
  check(`CR clamps index 4 to ${cr - 1}`, coerceStartIndex(4, 'chain') === cr - 1);
  check(
    'an unknown game clamps as decode',
    coerceStartIndex(4, 'nope' as GameId) === 4 &&
      coerceStartIndex(99, 'nope' as GameId) === dec - 1,
  );
  check('an absent game clamps as decode', coerceStartIndex(4, undefined) === 4);
  check('a negative index clamps to 0', coerceStartIndex(-2, 'chain') === 0);
  check('a non-number index is 0', coerceStartIndex('3', 'chain') === 0);
  check('NaN is 0', coerceStartIndex(Number.NaN, 'decode') === 0);
  // coerceSetup reads the same count
  const setup = (startIndex: number, game?: GameId): number =>
    coerceSetup(
      {
        id: 0,
        alliance: 'blue',
        spec: { ...DEFAULT_SPEC },
        assists: { ...DEFAULT_ASSISTS },
        startIndex,
      },
      game,
    ).startIndex;
  check('coerceSetup: CR keeps index 3', setup(3, 'chain') === 3);
  check('coerceSetup: DECODE keeps index 4', setup(4, 'decode') === 4);
  check(`coerceSetup: CR clamps index 4 to ${cr - 1}`, setup(4, 'chain') === cr - 1);
  check('coerceSetup: an unknown game clamps as decode', setup(4, 'nope' as GameId) === 4);

  // ---- channel visibility (item 4) ----------------------------------------
  // The PURE rule, tested in the leaf module. `src/seasonVisibility.ts` reads the
  // live channel from `src/net/env.ts`, which touches `import.meta.env` at load
  // and cannot be imported here at all — the same split as `roomJoinRegion`.
  section('season channel visibility');
  const stable = visibleGameIdsOn('stable');
  const alpha = visibleGameIdsOn('alpha');
  check('decode is visible on stable', stable.includes('decode'));
  check('chain is visible on stable', stable.includes('chain'));
  check('decode is visible on alpha too', alpha.includes('decode'));
  check('chain is visible on alpha too', alpha.includes('chain'));
  for (const s of SEASONS) {
    const on = (c: string): boolean => !s.channels || (s.channels as readonly string[]).includes(c);
    check(
      `${s.key}: visibility matches its channels (${s.channels ? s.channels.join('+') : 'all'})`,
      seasonVisibleOn(s, 'stable') === on('stable') && seasonVisibleOn(s, 'alpha') === on('alpha'),
    );
    check(
      `${s.key}: gameVisibleOn agrees with seasonVisibleOn`,
      gameVisibleOn(s.key, 'stable') === seasonVisibleOn(s, 'stable') &&
        gameVisibleOn(s.key, 'alpha') === seasonVisibleOn(s, 'alpha'),
    );
    check(
      `${s.key}: appears in the id list for exactly the channels it allows`,
      stable.includes(s.key) === on('stable') && alpha.includes(s.key) === on('alpha'),
    );
  }
  // an unknown channel string sees only the UNRESTRICTED seasons — the safe
  // direction: a typo'd VITE_APP_CHANNEL must not reveal a private season
  check(
    'an unknown channel sees only unrestricted seasons',
    visibleSeasonsOn('nope').every((s) => !s.channels),
  );
  // an id with no season is visible (nothing restricts it) rather than throwing
  check('gameVisibleOn is true for an id with no season', gameVisibleOn('nope' as GameId, 'stable'));

  // ---- the builder hero's per-game stat tiles (the `statTiles` slot) -------
  // THE SAME SEAM BUG THE PRESET LIST HAD, at a second site. `Menu.tsx` picks the
  // hero's mechanism tiles with `mod.statTiles ? <slot> : isDecode ? <intake> :
  // <scoring + catalyst>`. That tail is an `else`, not a default, so a game filling
  // neither branch is not shown "no per-game tile" — it is shown CHAIN REACTION's,
  // which is how BIOBUZZ came to advertise a "Claw arm · CATALYST" chip off
  // `spec.catalystType`, a field `coerceBiobuzzSpec` DELETES. It rendered a plausible
  // tile the whole time, which is why nothing reported it.
  section('builder stat tiles (the per-game hero summary)');
  const bbTiles = moduleFor('biobuzz').statTiles;
  check('biobuzz FILLS the statTiles slot', typeof bbTiles === 'function');
  // the two shipped games keep their inline branches: filling the slot for them would
  // put a behaviour change inside a commit whose only job is making room for a third.
  check('decode does NOT fill it (its inline branch stays the live path)', !moduleFor('decode').statTiles);
  check('chain does NOT fill it (its inline branch stays the live path)', !moduleFor('chain').statTiles);

  /** one tile as the hero renders it: value, caption, and the optional second caption. */
  const fmt = (t: { value: string; label: string; sub?: string }): string =>
    `${t.value} / ${t.label}${t.sub ? ` / ${t.sub}` : ''}`;
  const tilesFor = (raw: unknown): string[] => (bbTiles ? bbTiles(bbCoerce(raw)).map(fmt) : []);

  // ALL FOUR LOADOUTS. `bbMech` is two independently-optional slots, so a build may carry a
  // launcher, a lift, both or neither — and an ABSENT mechanism has to SAY so rather than
  // vanish, or the reader cannot tell a launcher-less robot (Studica's StarterBot) from a
  // tile the page failed to draw. Pinned as the exact user-visible text.
  const LOADOUTS: { name: string; mech: BbMechSpec; want: string[] }[] = [
    {
      name: 'launcher + lift',
      mech: {
        launcher: { kind: 'drum', mount: 'front', hoodDeg: 40 },
        lift: { kind: 'vslide', mount: 'back', maxZ: 24 },
      },
      want: ['Drum shooter / launcher / FRONT · 40° hood', 'Vertical slide / lift / BACK · 24" high'],
    },
    {
      name: 'launcher only',
      mech: {
        launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: null,
      },
      // a TURRET solves its own elevation per shot, so it has no hood to report
      want: ['Turret shooter / launcher / CENTER', 'No lift / lift'],
    },
    {
      name: 'lift only',
      mech: { launcher: null, lift: { kind: 'vslide', mount: 'center', maxZ: 29 } },
      want: ['No launcher / launcher', 'Vertical slide / lift / CENTER · 29" high'],
    },
    {
      name: 'neither (a drivetrain and a sweeper — a real, legal build)',
      mech: { launcher: null, lift: null },
      want: ['No launcher / launcher', 'No lift / lift'],
    },
  ];
  for (const l of LOADOUTS) {
    const raw = { ...BB_DEFAULT_SPEC, bbMech: l.mech };
    // NOT VACUOUS: assert the COERCED spec still carries the loadout being described. A
    // coercer that nulled the launcher would make "No launcher" pass for the wrong reason —
    // and `src/sim/spawn.ts` writes `scoreMode` unconditionally, so a launcher-less build is
    // exactly the one at risk of growing a phantom turret on the way through.
    const spec = bbCoerce(raw);
    check(
      `${l.name}: the coerced spec really carries that loadout`,
      (bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG) !== null) === (l.mech.launcher !== null) &&
        (bbLiftOf(spec) !== null) === (l.mech.lift !== null),
    );
    const got = tilesFor(raw);
    check(`stat tiles — ${l.name}`, got.join(' | ') === l.want.join(' | '), got.join(' | '));
  }

  // NO FOREIGN VOCABULARY, anywhere in what a BIOBUZZ builder prints. CATALYST is Chain
  // Reaction's word and ARTIFACT is DECODE's; this game's elements are POLLEN and NECTAR.
  // The CR catalyst labels are taken from CR's own map rather than retyped, so a rename
  // there cannot quietly make this check stop covering the string it was written for.
  // (The four ARCHETYPE names are deliberately shared between the two games — see
  // `bbLauncherOf` — so they are not, and cannot be, part of this list.)
  const FOREIGN = [
    ...Object.values(CHAIN_CATALYST_LABELS),
    'catalyst',
    'particle',
    'ring stand',
    'accelerator',
    'artifact',
    'sorter',
    'motif',
    'classifier',
  ].map((s) => s.toLowerCase());
  const everyBuild = [
    ...LOADOUTS.map((l) => ({ ...BB_DEFAULT_SPEC, bbMech: l.mech })),
    BB_DEFAULT_SPEC,
    ...(moduleFor('biobuzz').presets?.list ?? []),
  ];
  const printed = everyBuild.flatMap(tilesFor).join(' | ').toLowerCase();
  for (const word of FOREIGN) {
    check(`biobuzz stat tiles never say "${word}"`, !printed.includes(word));
  }
  // and the CAPTIONS are this game's own mechanisms, not the CHAIN arm's two
  const captions = new Set(everyBuild.flatMap((s) => (bbTiles ? bbTiles(bbCoerce(s)).map((t) => t.label) : [])));
  check(
    'the captions are launcher + lift (not CR’s scoring + catalyst)',
    captions.size === 2 && captions.has('launcher') && captions.has('lift'),
    [...captions].join(', '),
  );

  // ---- the STATIC crawler files -------------------------------------------
  // `public/robots.txt` and `public/sitemap.xml` are hand-written and do NOT read
  // the registry, so a season flipping to `stable` needs both edited by hand — an
  // omission nothing else would ever report. Pinned per VISIBLE season.
  section('static route lists (public/robots.txt, public/sitemap.xml)');
  const robots = readRepo('public/robots.txt');
  const sitemap = readRepo('public/sitemap.xml');
  const html = readRepo('index.html');
  const visible = visibleSeasonsOn('stable');
  for (const s of visible) {
    check(
      `sitemap.xml lists the /${s.key} landing page`,
      sitemap.includes(`<loc>https://www.playdsim.com/${s.key}</loc>`),
    );
    check(`robots.txt disallows /${s.key}/play`, robots.includes(`Disallow: /${s.key}/play`));
    check(`robots.txt disallows /${s.key}/replay/`, robots.includes(`Disallow: /${s.key}/replay/`));
    check(`robots.txt disallows /${s.key}/account`, robots.includes(`Disallow: /${s.key}/account`));
  }
  for (const s of SEASONS.filter((x) => !visible.some((v) => v.key === x.key))) {
    check(
      `sitemap.xml does NOT list the hidden /${s.key}`,
      !sitemap.includes(`/${s.key}<`),
    );
    check(
      `robots.txt does NOT name the hidden /${s.key}`,
      !robots.includes(`/${s.key}/`),
    );
  }
  // the crawler copy in index.html ships before any JS runs, so it cannot be
  // derived — it is pinned against the registry-built sentence instead
  check('index.html carries the registry-built home description', html.includes(HOME_DESC), HOME_DESC);
  check(
    'index.html carries it in all four places (3 meta tags + the JSON-LD)',
    html.split(HOME_DESC).length - 1 === 4,
    String(html.split(HOME_DESC).length - 1),
  );
}
