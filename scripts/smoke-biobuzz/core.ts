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
import { coerceStartIndex, sanitizePlayer } from '../../src/net/sanitize';
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
import { INTAKE_SHORT } from '../../src/ui/labelData';
import type { RobotSpec } from '../../src/types';
import type { HudSnapshot } from '../../src/game';
import type { RecordRankInfo } from '../../src/net/protocol';
import { recordBanner } from '../../src/ui/recordBanner';
import { SPONSOR, sponsorActive } from '../../src/sponsor';
import { BB_HOOD_DEFAULT_DEG, BB_NECTAR_R, BB_POLLEN_R, BB_START_POSES } from '../../src/games/biobuzz/config';
import { elementLine } from '../../src/games/biobuzz/Gallery';
import { categoryDefaultIndex, indexCategory } from '../../src/ui/startPositions';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { bbLauncherOf, bbLiftOf } from '../../src/games/biobuzz/mechs';
import type { BbMechSpec } from '../../src/games/biobuzz/mechs';
import { bbConfigSummary, bbLiftKindLabel } from '../../src/games/biobuzz/labels';
import { BB_PRESET_LIST, BB_REAL_PRESETS, BB_STARTER_BOTS } from '../../src/games/biobuzz/presets';
import { buildWords, shotRange, teamLine } from '../../src/ui/robotLabels';
import { SIM_DT } from '../../src/config';
import { createBiobuzzWorld } from '../../src/games/biobuzz/spawn';
import { biobuzzStep } from '../../src/games/biobuzz/step';
import { biobuzzFieldHud } from '../../src/games/biobuzz/hud';
import { bbCoerce, cmd, setup, type Check } from './harness';

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
  // acts are stored PER GAME (`seasons` keyed on game, `elo_ratings` on game + act), so an
  // act number shared between games is fine; BIOBUZZ's first period is Act 1 · Season 1
  // (owner, 2026-09-12).
  check('biobuzz: records and ranked open at Act 1', simModuleFor('biobuzz').initialAct === 1, String(simModuleFor('biobuzz').initialAct));

  // ---- BIOBUZZ start roles are TOP / BOTTOM, and it has its own editor --------
  // Configure fell into Chain Reaction's editor and the 2v2 screens into DECODE's, the shared
  // start helpers used DECODE's CLOSE/FAR anchor table, and the role bar said CLOSE/FAR.
  section('biobuzz start roles');
  {
    const bb = simModuleFor('biobuzz');
    check('biobuzz: the module brings its own start editor (not CR\'s or DECODE\'s)', !!moduleFor('biobuzz').startEditor);
    check('biobuzz: roles are TOP / BOTTOM', bb.startRoleLabel?.('close') === 'TOP' && bb.startRoleLabel?.('far') === 'BOTTOM');
    const n = bb.startPoseCount;
    const tops = Array.from({ length: n }, (_, i) => i).filter((i) => indexCategory(i, 'biobuzz') === 'close');
    const bottoms = Array.from({ length: n }, (_, i) => i).filter((i) => indexCategory(i, 'biobuzz') === 'far');
    check('biobuzz: two default anchors per role', tops.length === 2 && bottoms.length === 2, `top=[${tops}] bottom=[${bottoms}]`);
    check('biobuzz: anchor 0 is TOP and anchor 1 is BOTTOM (a 2-robot alliance spreads onto them)', indexCategory(0, 'biobuzz') === 'close' && indexCategory(1, 'biobuzz') === 'far');
    check(
      'biobuzz: each role defaults to one of its own anchors',
      indexCategory(categoryDefaultIndex('close', 'biobuzz'), 'biobuzz') === 'close' &&
        indexCategory(categoryDefaultIndex('far', 'biobuzz'), 'biobuzz') === 'far',
    );
    check('biobuzz: anchors are named for their role', Array.from({ length: n }, (_, i) => bb.startAnchorName?.(i) ?? '').every((s, i) => s.startsWith(indexCategory(i, 'biobuzz') === 'close' ? 'TOP' : 'BOTTOM')));
    // THE WORDS FOLLOW THE SCREEN ON A POINT-SYMMETRIC FIELD: for each alliance, a TOP anchor is
    // drawn at the top (actual y >= 0) and is named for the wall it is really on. Red's anchors are
    // the canonical ones rotated 180°, so red's TOP role is the canonical BOTTOM slot.
    for (const alliance of ['blue', 'red'] as const) {
      let bad = '';
      for (let i = 0; i < n; i++) {
        const p = BB_START_POSES[i];
        const actualY = alliance === 'blue' ? p.pos.y : -p.pos.y;
        const label = bb.startRoleLabel?.(indexCategory(i, 'biobuzz'), alliance) ?? '';
        const name = bb.startAnchorName?.(i, alliance) ?? '';
        const wall = p.wall === 'side' ? 'SIDE' : (actualY >= 0) ? 'REAR' : 'AUDIENCE';
        if ((actualY >= 0) !== (label === 'TOP') || name !== `${label} · ${wall} WALL`) {
          if (!bad) bad = `anchor ${i}: y=${actualY} label=${label} name=${name}`;
        }
      }
      check(`biobuzz: ${alliance}'s TOP anchors are the ones drawn at the top, named for their real wall`, bad === '', bad);
    }
    check('decode: roles and anchor categories are unchanged (no module hooks)', !simModuleFor('decode').startRoleLabel && indexCategory(0, 'decode') === 'close');
  }
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

  // ---- the four loadouts both summary surfaces are pinned against --------
  // A launcher is MANDATORY (owner ruling 2026-09-12) and a Box Tube is optional, and a launcher
  // is one of three kinds, so these four are the shapes that print differently: a single turret
  // with and without a tube, a double turret (two cells to name) and a dumper (an edge; its stored
  // hood is no longer printed — a dump is a lob, owner 2026-09-13) with a tube.
  //
  // The Box Tube's name is CLOCK-DEPENDENT by design — it carries the sponsor's product name only
  // inside `SPONSOR.term` — so the expected strings are built from `bbLiftKindLabel` rather than
  // typing either spelling; both spellings are pinned against the term further down.
  const TUBE = bbLiftKindLabel('vslide');
  // ⚠️ THE `line` STRINGS CARRY `BB_DEFAULT_SPEC`'S OWN INTAKE MOUNT, because `rawOf` below
  // builds each loadout on top of that spec and only replaces the mechanism. They say FRONT
  // because the default preset (`BB_PRESETS[0]`, the Pollinator) carries a front sweeper; they
  // said FRONT+BACK while it was the Sniper. A sentence that drifts from the build is exactly
  // what this fixture exists to catch, so the strings stay literal rather than being derived.
  const LOADOUTS: { name: string; mech: BbMechSpec; tiles: string[]; line: string }[] = [
    {
      name: 'single turret',
      mech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
      // a TURRET solves its own elevation per shot, so it has no hood to report
      tiles: ['Single turret / launcher / CENTER', 'No box tube / flower scoring'],
      line: 'Single turret · FRONT sweeper · CENTER launcher · 4 pollen',
    },
    {
      name: 'single turret + Box Tube',
      mech: {
        launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: { kind: 'vslide', mount: 'back' },
      },
      tiles: ['Single turret / launcher / CENTER', `${TUBE} / flower scoring / BACK`],
      line: `Single turret · FRONT sweeper · CENTER launcher · ${TUBE} · BACK · 4 pollen`,
    },
    {
      name: 'double turret',
      mech: {
        launcher: { kind: 'twinturret', mount: 'right', mount2: 'left', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: null,
      },
      tiles: ['Double turret / launcher / RIGHT + LEFT', 'No box tube / flower scoring'],
      line: 'Double turret · FRONT sweeper · RIGHT + LEFT launcher · 4 pollen',
    },
    {
      name: 'dumper + Box Tube',
      mech: {
        launcher: { kind: 'dumper', mount: 'front', hoodDeg: 80 },
        lift: { kind: 'vslide', mount: 'back' },
      },
      tiles: ['Dumper / launcher / FRONT', `${TUBE} / flower scoring / BACK`],
      line: `Dumper · FRONT sweeper · FRONT launcher · ${TUBE} · BACK · 4 pollen`,
    },
  ];
  /** the raw build for a loadout — the flat mirror is set to agree with the container, the way
   * every Builder edit sends it. */
  const rawOf = (m: BbMechSpec): RobotSpec => ({
    ...BB_DEFAULT_SPEC,
    scoreMode: m.launcher.kind,
    shooterMount: m.launcher.mount,
    bbMech: m,
  });
  /** NOT VACUOUS: the COERCED spec still carries the loadout being described. A coercer that
   * moved a turret, dropped `mount2`, re-clamped the hood or relocated the tube would make the
   * text below describe a different robot than the one the test built. */
  const carries = (spec: RobotSpec, m: BbMechSpec): boolean => {
    const got = bbLauncherOf(spec, BB_HOOD_DEFAULT_DEG);
    const want = m.launcher;
    return (
      got.kind === want.kind &&
      got.mount === want.mount &&
      got.mount2 === want.mount2 &&
      (want.kind !== 'dumper' || got.hoodDeg === want.hoodDeg) &&
      (bbLiftOf(spec)?.mount ?? null) === (m.lift?.mount ?? null)
    );
  };

  // ---- the builder hero's per-game stat tiles (the `statTiles` slot) -------
  // THE SAME SEAM BUG THE PRESET LIST HAD, at a second site. `Menu.tsx` picks the hero's
  // mechanism tiles with `mod.statTiles ? <slot> : isDecode ? <intake> : <scoring + catalyst>`.
  // That tail is an `else`, not a default, so a game filling neither branch is shown CHAIN
  // REACTION's tiles — which is how BIOBUZZ once advertised a CATALYST.
  // ---- the results-screen breakdown (the `resultsRows` slot) -------------
  // NOTHING asserted this slot before (BIOBUZZ-AUDIT BB-51), and its own "why it matters"
  // line predicted the consequence exactly: a section silently dropped or reordered ships
  // green. The ORDER is the behaviour — END OF MATCH reads immediately above the PENALTIES
  // that adjust the total, because both are settled at the buzzer.
  section('results breakdown sections (the resultsRows slot)');
  {
    const rows = moduleFor('biobuzz').resultsRows;
    check('biobuzz FILLS the resultsRows slot', typeof rows === 'function');
    check('decode does NOT fill it (its inline branch stays the live path)', !moduleFor('decode').resultsRows);
    check('chain does NOT fill it (its inline branch stays the live path)', !moduleFor('chain').resultsRows);
    // ONLY the titles need a hud here: every value goes through `n()`, which reads 0 from an
    // absent slice rather than throwing, so the order is pinnable without stepping a world.
    // The values themselves are covered by the scoring checks in `rules.ts`.
    const titles = (rows?.({ alliance: 'red' } as unknown as HudSnapshot) ?? []).map(([t]) => t);
    check(
      'END OF MATCH reads immediately above PENALTIES, and RANKING POINTS is gone',
      titles.join(' | ') === 'AUTONOMOUS | HIVE | FLOWER | GARDEN | END OF MATCH | PENALTIES',
      titles.join(' | '),
    );
    // ---- POINTS ONLY, and the COUNT is what the row budget pays with ------
    // The results screen is display-scaled off one viewport unit, and the arithmetic that
    // sized it only closes at NINE rows — 17 of them overruns a 2560x1392 display by ~390px.
    // So the row set is a layout invariant, not a content preference, and nothing asserted
    // it: the section titles above ship green whatever rows hang off them.
    const labels = (rows?.({ alliance: 'red' } as unknown as HudSnapshot) ?? []).flatMap(
      ([, rs]) => rs.map(([label]) => label),
    );
    check('the breakdown is NINE rows — the display scale is sized for exactly this', labels.length === 9, String(labels.length));
    check(
      'points-only, bare labels: no unit parenthetical survives',
      labels.every((l) => !l.includes('(')),
      labels.filter((l) => l.includes('(')).join(' | ') || 'none',
    );
    check(
      'the nine rows, in order',
      labels.join(' | ') ===
        'LEAVE | PARK | TIPS | Up CELL contents | OWNED FLOWER | Bottom NECTAR Bonus | GARDEN | PARK | Fouls awarded',
      labels.join(' | '),
    );
    // `label` is the React key and PARK appears in TWO sections, so uniqueness is only ever
    // per-section — the `<Fragment key={title}>` boundary in Results.tsx is what holds that.
    for (const [title, rs] of rows?.({ alliance: 'red' } as unknown as HudSnapshot) ?? []) {
      const ls = rs.map(([l]) => l);
      check(`${title}: its row labels are unique within the section`, new Set(ls).size === ls.length, ls.join(' | '));
    }
  }

  // ---- the one-panel results banner (the WINNER slot, on a screen with no opponent) ----
  // Every branch here is a product decision about what a finished run was WORTH, and the
  // whole point of the slot is that the six states are told apart at a glance. A silent
  // collapse — two states printing the same thing, or gold landing on the wrong one — is
  // exactly the failure nobody would notice in a screenshot of one of them.
  section('the one-panel results banner (recordBanner)');
  {
    const info = (o: Partial<RecordRankInfo>): RecordRankInfo => ({
      mode: 'solo',
      drivetrain: 'tank',
      score: 0,
      rank: 9,
      total: 128,
      isPB: false,
      isWR: false,
      ...o,
    });
    const wr = recordBanner(info({ isWR: true, isPB: true, rank: 1 }), false);
    const pb = recordBanner(info({ isPB: true, rank: 3 }), false);
    const plain = recordBanner(info({}), false);
    const pending = recordBanner(null, false);
    const practice = recordBanner(null, true);
    check('WORLD RECORD takes the gold fill', wr.text === 'WORLD RECORD' && wr.tone === 'gold', `${wr.text} / ${wr.tone}`);
    // a world record is ALWAYS also a personal best, so the order of those two tests is
    // itself the behaviour — read the other way round, a WR would announce itself as a PB.
    check('a world record outranks the personal best it also is', wr.text !== pb.text, `${wr.text} vs ${pb.text}`);
    check('PERSONAL BEST keeps the ordinary banner', pb.text === 'PERSONAL BEST' && pb.tone === undefined, `${pb.text} / ${pb.tone}`);
    check('a plain placing IS its own banner', plain.text === '#9 OF 128' && plain.tone === 'quiet', `${plain.text} / ${plain.tone}`);
    // blank is RESERVED, not absent: the slot holds its height or the driver row under it
    // jumps when the rank lands. Signed out, alpha and still-computing are all this one.
    check('no rank yet prints nothing at all', pending.text === '', JSON.stringify(pending));
    check('practice says what it is', practice.text === 'PRACTICE' && practice.tone === 'quiet', `${practice.text} / ${practice.tone}`);
    const shown = [wr, pb, plain, practice].map((b) => `${b.text}/${b.tone ?? '-'}`);
    check('no two VISIBLE states print the same banner', new Set(shown).size === shown.length, shown.join(' | '));
  }

  section('builder stat tiles (the per-game hero summary)');
  const bbTiles = moduleFor('biobuzz').statTiles;
  check('biobuzz FILLS the statTiles slot', typeof bbTiles === 'function');
  check('decode does NOT fill it (its inline branch stays the live path)', !moduleFor('decode').statTiles);
  check('chain does NOT fill it (its inline branch stays the live path)', !moduleFor('chain').statTiles);

  /** one tile as the hero renders it: value, caption, and the optional second caption. */
  const fmt = (t: { value: string; label: string; sub?: string }): string =>
    `${t.value} / ${t.label}${t.sub ? ` / ${t.sub}` : ''}`;
  const tilesFor = (raw: unknown): string[] => (bbTiles ? bbTiles(bbCoerce(raw)).map(fmt) : []);

  for (const l of LOADOUTS) {
    const raw = rawOf(l.mech);
    const spec = bbCoerce(raw);
    check(`${l.name}: the coerced spec really carries that loadout`, carries(spec, l.mech), JSON.stringify(spec.bbMech));
    const got = tilesFor(raw);
    check(`stat tiles — ${l.name}`, got.join(' | ') === l.tiles.join(' | '), got.join(' | '));
  }

  // NO FOREIGN VOCABULARY, anywhere in what a BIOBUZZ builder prints. CATALYST is Chain
  // Reaction's word and ARTIFACT is DECODE's; this game's elements are POLLEN and NECTAR.
  // The CR catalyst labels are taken from CR's own map rather than retyped, so a rename
  // there cannot quietly make this check stop covering the string it was written for.
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
  const everyBuild = [...LOADOUTS.map((l) => rawOf(l.mech)), BB_DEFAULT_SPEC, ...(moduleFor('biobuzz').presets?.list ?? [])];
  const printed = everyBuild.flatMap(tilesFor).join(' | ').toLowerCase();
  for (const word of FOREIGN) {
    check(`biobuzz stat tiles never say "${word}"`, !printed.includes(word));
  }
  // and the CAPTIONS are this game's own mechanisms, not the CHAIN arm's two
  const captions = new Set(everyBuild.flatMap((s) => (bbTiles ? bbTiles(bbCoerce(s)).map((t) => t.label) : [])));
  check(
    'the captions are launcher + flower scoring (not CR’s scoring + catalyst)',
    captions.size === 2 && captions.has('launcher') && captions.has('flower scoring'),
    [...captions].join(', '),
  );

  // ---- saved-robot lines (the `labels.configSummary` slot) ------------------
  // THE SAME SEAM BUG THE PRESET LIST HAD, at a second site. `Menu.tsx` picks the detail
  // line under each SAVED robot with `mod.labels?.configSummary ? <slot> : isDecode ?
  // <DECODE fields> : <CR fields>`. A game filling neither branch was described in CHAIN
  // REACTION's words, off the lossy `scoreMode` mirror, with the Box Tube omitted entirely.
  section('saved-robot lines (the per-game config summary)');
  {
    const summary = moduleFor('biobuzz').labels?.configSummary;
    check('biobuzz FILLS the labels.configSummary slot', typeof summary === 'function');
    check('decode does NOT fill labels (its inline arm stays the live path)', !moduleFor('decode').labels);
    check('chain does NOT fill labels (its inline arm stays the live path)', !moduleFor('chain').labels);

    // THE WIRING, pinned at the source. A correct summary that no screen reads is the whole bug
    // this section exists for, and it is invisible to every check that calls the function
    // directly — the same reason the crawler files below are pinned as text.
    // Since 2026-09-22 a saved robot and a preset are ONE card (`RobotCard`), and its one line
    // is `buildWords`, which reads the game's `statTiles` slot BEFORE either inline arm. The
    // long sentence (`labels.configSummary`, above) is still the roster's and the leaderboard's.
    const menu = readRepo('src/ui/Menu.tsx');
    const card = readRepo('src/ui/RobotCard.tsx');
    const labelsSrc = readRepo('src/ui/robotLabels.ts');
    check(
      'Menu.tsx renders saved robots AND presets through RobotCard, with the active game',
      (menu.match(/<RobotCard\b/g) ?? []).length >= 2 && (menu.match(/game=\{settings\.game\}/g) ?? []).length >= 2,
    );
    check(
      'RobotCard prints buildWords as its one `.om` line',
      card.includes('<span className="om">{buildWords(spec, game).join(\' · \')}</span>'),
    );
    check(
      'buildWords reads the statTiles SLOT before the DECODE and CR arms',
      /const tiles = moduleFor\(game\)\.statTiles\?\.\(spec\);\s*\n\s*if \(tiles\)/.test(labelsSrc.replace(/\r\n/g, '\n')),
    );
    // and BOTH shipped arms are there: DECODE names the intake, CR the archetype and catalyst.
    check('the DECODE arm names the intake', labelsSrc.includes('`${INTAKE_SHORT[spec.intake]} intake`'));
    check(
      'the CR arm names the archetype and the catalyst',
      labelsSrc.includes('CHAIN_MODE_LABELS[mode]') && labelsSrc.includes('CHAIN_CATALYST_LABELS[spec.catalystType'),
    );
    // THE PRESET LIST is keyed on the SAME slot as always, so a card can never describe a robot
    // out of a different game's list.
    check(
      'the preset list is keyed on the game slot',
      menu.includes('const presets = gamePresets ? gamePresets.list :'),
    );
    // THE DRIVETRAIN CHROME IS EVERY GAME'S. A filled `Builder` slot used to replace the whole
    // Customize section, and BIOBUZZ lost the drivetrain picker (and name, team, RPM) with it.
    // The picker must render BEFORE the Builder ternary opens, i.e. outside it.
    {
      const drive = menu.indexOf('<h3 className="ds-subh">Drivetrain</h3>');
      const slot = menu.indexOf('{Builder ? (');
      check(
        'Menu.tsx renders the Drivetrain picker outside the Builder slot (before its ternary)',
        drive >= 0 && slot >= 0 && drive < slot,
        `drivetrain@${drive} builder@${slot}`,
      );
    }

    /** the sentence as a saved slot, a leaderboard row and the strategy card all print it. */
    const say = (raw: unknown): string => (summary ? summary(bbCoerce(raw)) : '');
    check('the slot IS bbConfigSummary', summary === bbConfigSummary);

    for (const l of LOADOUTS) {
      const raw = rawOf(l.mech);
      check(`${l.name}: the coerced spec really carries that loadout`, carries(bbCoerce(raw), l.mech));
      check(`saved-robot line — ${l.name}`, say(raw) === l.line, say(raw));
    }
    // A BOX TUBE IS HALF THE BUILD. Two robots differing only by one must not read identically.
    check(
      'a Box Tube CHANGES the sentence',
      say(rawOf(LOADOUTS[0].mech)) !== say(rawOf(LOADOUTS[1].mech)),
    );
    // and so does the NECTAR turret's cell: two double turrets differing only by it are two robots
    check(
      'a double turret’s NECTAR cell CHANGES the sentence',
      say(rawOf(LOADOUTS[2].mech)) !==
        say(rawOf({ ...LOADOUTS[2].mech, launcher: { ...LOADOUTS[2].mech.launcher, mount2: 'backleft' } })),
    );

    const builds: unknown[] = [...LOADOUTS.map((l) => rawOf(l.mech)), BB_DEFAULT_SPEC, ...BB_PRESET_LIST];
    const lines = builds.map(say).join(' | ').toLowerCase();

    // NO FOREIGN VOCABULARY. CATALYST and PARTICLE are Chain Reaction's words; ARTIFACT,
    // SORTER and INERTIA are DECODE's. This game's element is POLLEN. The CR catalyst labels
    // and DECODE's intake names are taken from their own maps rather than retyped. NOT swept:
    // SWEEPER, which both games genuinely use for the same part. A shared word is not a leak.
    const FOREIGN_LINE = [
      ...Object.values(CHAIN_CATALYST_LABELS),
      ...Object.values(INTAKE_SHORT),
      'catalyst',
      'particle',
      'ring stand',
      'accelerator',
      'artifact',
      'sorter',
      'inertia',
      'motif',
      'classifier',
      'drum',
      'no launcher',
      'vertical slide',
    ].map((w) => w.toLowerCase());
    for (const word of FOREIGN_LINE) {
      check(`biobuzz saved-robot lines never say "${word}"`, !lines.includes(word));
    }
    // and the POSITIVE half: every build names this game's own element, so a summary cannot
    // pass the sweep above by saying nothing at all.
    check('every biobuzz build names POLLEN', builds.every((b) => say(b).includes('pollen')));

    // ---- THE CARD LINE (`buildWords`) — every robot card and the hero's build line ----------
    const words = (raw: unknown): string[] => buildWords(bbCoerce(raw), 'biobuzz');
    const cardLines = builds.map((b) => words(b).join(' · ').toLowerCase()).join(' | ');
    for (const word of FOREIGN_LINE) {
      check(`biobuzz card lines never say "${word}"`, !cardLines.includes(word));
    }
    check(
      'a card line is the drivetrain, then the game’s own mechanism words, minus the absent ones',
      builds.every((b) => {
        const w = words(b);
        const tiles = (bbTiles ? bbTiles(bbCoerce(b)) : []).filter((t) => !t.absent);
        return w.length === 1 + tiles.length && w.slice(1).every((x, i) => x.startsWith(tiles[i].value));
      }),
    );
    check(
      'a card line never lists an absent Box Tube ("No box tube")',
      !cardLines.includes('no box tube'),
    );
    check(
      'a Box Tube CHANGES the card line',
      words(rawOf(LOADOUTS[0].mech)).join() !== words(rawOf(LOADOUTS[1].mech)).join(),
    );
    // DECODE and CR take their own arms, in their own words
    const decodeWords = buildWords({ ...DEFAULT_SPEC, intake: 'vector', canSort: true, flywheelInertia: 0.9 }, 'decode');
    check(
      'DECODE card line: drivetrain, intake, sorter, shot range',
      decodeWords.join(' · ') === `${decodeWords[0]} · Vector intake · sorter · ${shotRange(0.9)}`,
      decodeWords.join(' · '),
    );
    const chainWords = buildWords({ ...DEFAULT_SPEC }, 'chain').join(' · ').toLowerCase();
    check('a CR card line never says POLLEN or intake style', !chainWords.includes('pollen') && !chainWords.includes('sloped'), chainWords);
    // THE TEAM LINE: number then name, and nothing at all when there is neither
    check('teamLine: number · name', teamLine({ teamNumber: 12345, teamName: 'Robo Hornets' }) === '12345 · Robo Hornets');
    check('teamLine: empty when there is no team', teamLine({ teamNumber: 0, teamName: '  ' }) === '');
  }

  // ---- the preset cards: ONE StarterBot, no vendor names -------------------
  // Owner ruling 2026-09-12: the kit robots collapse into one card, and nothing user-visible
  // names a company. A vendor name slipping back into a card is exactly the kind of thing
  // nobody reports, because the card still looks fine.
  section('preset cards (one StarterBot, no vendor names)');
  {
    const starters = BB_PRESET_LIST.filter((p) => /starter\s*bot/i.test(p.name));
    check(
      'exactly one StarterBot card',
      starters.length === 1 && BB_STARTER_BOTS.length === 1,
      BB_PRESET_LIST.map((p) => p.name).join(', '),
    );
    check(
      'realCount is 1, and the StarterBot leads the list',
      BB_REAL_PRESETS === 1 && BB_PRESET_LIST[0].name === 'StarterBot',
      `${BB_REAL_PRESETS} / ${BB_PRESET_LIST[0]?.name}`,
    );
    check(
      'the module slot offers that list',
      (moduleFor('biobuzz').presets?.list ?? []).map((p) => p.name).join(',') === BB_PRESET_LIST.map((p) => p.name).join(','),
    );
    const VENDOR = /gobilda|\brev\b|andymark|robits|studica/i;
    const shown = BB_PRESET_LIST.flatMap((p) => [
      p.name,
      p.teamName,
      buildWords(p, 'biobuzz').join(' · '),
      bbConfigSummary(p),
    ]);
    const hits = shown.filter((t) => VENDOR.test(t));
    check('no vendor name in any preset name, team name, card line or summary', hits.length === 0, hits.join(' | '));
    // not vacuous: the sweep read real text for every card, and there is more than one card
    check(
      '...and the sweep actually read every card',
      BB_PRESET_LIST.length >= 4 && shown.every((t) => t.length > 0),
      `${BB_PRESET_LIST.length} cards`,
    );
  }

  // ---- the Box Tube's product name follows the sponsor term --------------
  // "OFFSET™ Box Tube" is part of the sponsorship (docs/sponsor.md), so it has to come down
  // when the term ends, exactly like every placement. The instants come from `SPONSOR.term`
  // itself, so a renewal edits one date and this keeps covering it.
  section('Box Tube label (follows the sponsor term)');
  {
    const from = Date.parse(`${SPONSOR.term.from}T00:00:00Z`);
    const until = Date.parse(`${SPONSOR.term.until}T00:00:00Z`);
    const inside = from + (until - from) / 2;
    const after = until + 24 * 3600e3;
    check('the sponsor is live mid-term (else the next check proves nothing)', sponsorActive(inside));
    check(
      'inside the term the Box Tube carries OFFSET™',
      bbLiftKindLabel('vslide', inside).includes('OFFSET™'),
      bbLiftKindLabel('vslide', inside),
    );
    check(
      'after the term it does not',
      !bbLiftKindLabel('vslide', after).includes('OFFSET'),
      bbLiftKindLabel('vslide', after),
    );
    check('...and reads as the plain part name', bbLiftKindLabel('vslide', after) === 'Box tube');
  }

  // ---- the live HUD shows WHAT is held, not a count ------------------------
  // Owner ruling 2026-09-12: the robot row draws one disc per held element and no count chip.
  // Pinned at the source because a count chip creeping back in still renders plausibly.
  section('BIOBUZZ HUD chips');
  {
    const hudSrc = readRepo('src/games/biobuzz/HudSlots.tsx');
    check('HudSlots.tsx renders no HOPPER count chip', !hudSrc.includes('HOPPER'));
    check('HudSlots.tsx renders the held elements as hopper pips', hudSrc.includes('hopper-pip'));
    // FLOWER IN REACH is now the flower icon's RING, not its own text chip.
    check('HudSlots.tsx draws the flower icon', hudSrc.includes('flower-icon'));
    check(
      '...ringed by the same flowerInReach signal FLOWER IN REACH used to read',
      hudSrc.includes("r?.flowerInReach ? ' reach'"),
    );

    /**
     * THE NECTAR COLUMN IS BACK (owner, 2026-09-22: "Make the top right HUD look like main's
     * top right HUD, with the nectar display too"), reversing the 2026-09-19 removal this pin
     * used to record. `.bb-hud-right` is a dot column, same spelling as STORAGE — never the
     * text chip the 2026-09-19 ruling was actually about — indexed by this alliance's own
     * stock and debt so a driver reads their own supply, not the opponent's.
     */
    check('HudSlots.tsx draws the NECTAR column', hudSrc.includes('bb-hud-right'));
    check(
      "...indexed by this alliance's own stock and debt",
      hudSrc.includes('nectarStock[hud.alliance]') && hudSrc.includes('nectarDue[hud.alliance]'),
    );
    // G410 KEEPS ITS OWN CHIP, and it is a different rule about a different act — a NECTAR
    // entering a FLOWER, not a human player's entry. The NECTAR column returning must not fold
    // the two together.
    check('...and G410 keeps its own separate chip', hudSrc.includes('NECTAR LOCKED'));

    /**
     * THE RAMP UP / RAMP DOWN CHIP IS GONE (owner, 2026-09-22: "Fix the 'Ramp up' thing top
     * right HUD. Just get rid of it. It is self-explanatory if you look at the robot"). It was
     * the one TEXT chip left in this card, and the only fact in it a driver could already see
     * on the built robot without reading a word.
     */
    check(
      'HudSlots.tsx renders no RAMP UP/DOWN chip',
      !hudSrc.includes('RAMP UP') && !hudSrc.includes('RAMP DOWN'),
    );
    const hudRobotSrc = readRepo('src/games/biobuzz/hudRobot.ts');
    check('...and hudRobot.ts carries no leftover rampOut plumbing for it', !hudRobotSrc.includes('rampOut'));

    /**
     * THE FLOWER ICON'S FILL IS A STANDING STATE, NOT A HELD-BUMP FLASH.
     * "Grey before the 1:00 mark" is a standing fact for the rest of the match, unlike a G407
     * warning, which genuinely only matters for a few seconds — so this one reads straight off
     * `nectarLocked` instead of going through `useHeldBump`.
     */
    check(
      'the flower icon fill reads nectarLocked directly, as a standing state',
      hudSrc.includes('f?.nectarLocked === false'),
    );
    check(
      '...and the open class name says so',
      hudSrc.includes("flowerOpen ? ' open'"),
    );
  }

  // ---- ...and the slice really carries the value the chip is indexed by ----
  /**
   * THE BEHAVIOURAL HALF. The source checks above prove the four lines exist; this proves the
   * HUD slice hands the component something to pick between. It is the `none-owed` case
   * specifically because that is the one the chip was written for — a FULL stock with no
   * entitlement is indistinguishable, from outside, from a full stock with one, and it is the
   * state an alliance sits in for most of a match.
   *
   * TELEOP with 90 s left: play is running (so the answer is not the frozen-field `locked`)
   * and the 1:00 dump window has not opened (so it is not `ok` either). One real tick of the
   * BIOBUZZ pipeline, because `nectarWhy` is recomputed in `play.ts` rather than seeded — a
   * freshly built world still reads the `none-left` that `state.ts` starts it at.
   */
  section('BIOBUZZ HUD slice — nectarWhy');
  {
    const w = createBiobuzzWorld('match', 11, [setup(0, 'red', {}, 0), setup(1, 'blue', {}, 0)]);
    w.match.phase = 'teleop';
    w.match.phaseTimeLeft = 90;
    biobuzzStep(w, SIM_DT, new Map([[0, cmd({})], [1, cmd({})]]));
    const hud = biobuzzFieldHud(w);
    const bb = w.biobuzz!;
    check(
      'the field slice carries nectarWhy, per alliance',
      typeof hud.nectarWhy?.red === 'string' && typeof hud.nectarWhy?.blue === 'string',
      JSON.stringify(hud.nectarWhy),
    );
    check(
      'the scene really is a FULL stock with no entitlement (else the next check proves nothing)',
      bb.nectarStock.red > 0 && bb.nectarDue.red === 0 && bb.nectarStock.blue > 0 && bb.nectarDue.blue === 0,
      `red ${bb.nectarStock.red}/${bb.nectarDue.red} · blue ${bb.nectarStock.blue}/${bb.nectarDue.blue}`,
    );
    check(
      'a full stock with nothing owed reads `none-owed`, on BOTH alliances',
      hud.nectarWhy.red === 'none-owed' && hud.nectarWhy.blue === 'none-owed',
      `red ${hud.nectarWhy.red} · blue ${hud.nectarWhy.blue}`,
    );
    check(
      '...and it is the slice answering, not the world default state.ts seeds',
      hud.nectarWhy.red === bb.nectarWhy.red && hud.nectarWhy.red !== 'none-left',
      `slice ${hud.nectarWhy.red} · world ${bb.nectarWhy.red}`,
    );
  }

  // ---- the gallery caption counts what is actually there ------------------
  /**
   * The cell caption under every gallery still read `${world.balls.length} pollen`, written
   * when POLLEN was the only element. `hive-tip` loads 3 NECTAR over 3 POLLEN and the caption
   * said `6 pollen` — and a caption is precisely the line a reader checks a picture against,
   * so the one surface meant to explain a confusing cell was the surface lying about it.
   *
   * `elementLine` classifies through `bbKindOf`, the same function the SCORE uses, so a
   * caption cannot disagree with what the rules think is on the field. The single-element
   * scenes keep their shorter caption, which the second check pins — a caption that always
   * printed `. 0 nectar` would be a different regression.
   */
  section('BIOBUZZ gallery caption — two element sizes, two counts');
  {
    const w = createBiobuzzWorld('match', 17, [setup(0, 'red', {}, 0)]);
    const mk = (id: number, color: 'yellow' | 'red' | 'blue') => ({
      ...w.balls[0], id, color, r: color === 'yellow' ? BB_POLLEN_R : BB_NECTAR_R,
    });
    w.balls = [mk(901, 'yellow'), mk(902, 'yellow'), mk(903, 'yellow'), mk(904, 'red'), mk(905, 'blue')];
    check(
      'a mixed field names both kinds, and never calls a NECTAR a POLLEN',
      elementLine(w) === '3 pollen · 2 nectar',
      elementLine(w),
    );
    w.balls = [mk(901, 'yellow'), mk(902, 'yellow')];
    check(
      '...and a POLLEN-only field keeps the short caption, no zero-nectar tail',
      elementLine(w) === '2 pollen',
      elementLine(w),
    );
  }

  // ---- the phase EVENT says the same word every other surface says --------
  /**
   * ⚠️ `world.events` IS ONE OF THE THREE SURFACES THE TERMINOLOGY RULING BINDS — with the
   * live HUD and the burned-in video overlay. `src/sim/match.ts` pushes `DRIVER-CONTROLLED`
   * for the other seasons; BIOBUZZ runs its own phase machine in `step.ts` and was pushing
   * `TELEOP`, so one event log carried two names for one phase and a viewer reading the
   * overlay against the log saw a disagreement that meant nothing.
   *
   * The negative half matters as much as the positive one: asserting only that the right
   * string is present would still pass if both were pushed.
   */
  section('BIOBUZZ phase events — the shared vocabulary');
  {
    const w = createBiobuzzWorld('match', 13, [setup(0, 'red', {}, 0), setup(1, 'blue', {}, 0)]);
    w.match.phase = 'transition';
    w.match.phaseTimeLeft = SIM_DT / 2; // one tick short of the flip
    const none = new Map([[0, cmd({})], [1, cmd({})]]);
    biobuzzStep(w, SIM_DT, none);
    check(
      'the AUTO -> TELEOP flip really happened (else the next two prove nothing)',
      w.match.phase === 'teleop',
      w.match.phase,
    );
    check(
      'BIOBUZZ announces DRIVER-CONTROLLED, the word the HUD and the overlay use',
      w.events.includes('DRIVER-CONTROLLED'),
      JSON.stringify(w.events),
    );
    check(
      '...and it does NOT also push the season-local `TELEOP`',
      !w.events.includes('TELEOP'),
      JSON.stringify(w.events),
    );
  }

  // ---- participation credit knows every button this game has --------------
  /**
   * `Room.countParticipation` decides whether a driver is AFK for ranked standing, and it
   * does it by listing the commands that count as input. The list is written by hand, so a
   * button added later is simply absent — which is exactly what happened to `bbNectar`: the
   * human-player button landed on bit 128 after the list was written, and a driver whose only
   * input was that key read as idle and lost standing for playing their position.
   *
   * Derived from `RobotCommand` rather than hard-coded, so the NEXT button to land fails here
   * on the day it lands instead of the day somebody is wrongly marked AFK. `server/room.ts`
   * is read as source because the method is private and the room needs a live socket.
   */
  section('server: participation credit covers every BIOBUZZ button');
  {
    const types = readRepo('src/types.ts');
    const roomSrc = readRepo('server/room.ts');
    const iface = types.slice(types.indexOf('interface RobotCommand'));
    const body = iface.slice(0, iface.search(/^\}/m));
    const buttons = [...new Set([...body.matchAll(/^\s*(bb[A-Za-z]+)\??:/gm)].map((m) => m[1]))];
    const moving = roomSrc.slice(roomSrc.indexOf('const moving ='));
    const expr = moving.slice(0, moving.indexOf(';'));
    check(
      'RobotCommand really declares BIOBUZZ buttons (else the next check is vacuous)',
      buttons.length >= 3,
      buttons.join(', '),
    );
    // `bbFireUnaimed` is a seat-only bit (`SEAT_ONLY_BUTTONS`) that never comes without `fire`,
    // which is counted: a driver cannot send it, and an auto seat that sets it is already firing
    const missing = buttons.filter((b) => b !== 'bbFireUnaimed' && !expr.includes(`c.${b}`));
    check(
      'every bb* command counts as driver input, `bbNectar` included',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : buttons.join(', '),
    );
  }

  /**
   * A BIOBUZZ BUILD SURVIVES THE JOIN INTO A RANKED ROOM.
   *
   * A matchmaker-staged room is joined with NO config, and `server/index.ts` used to sanitize
   * the joiner's player with that config's game — 'decode' — so every ranked BIOBUZZ driver
   * arrived as a default robot: `bbMech` dropped and the mounts reset. The join now uses the
   * room's own game. `server/index.ts` opens sockets on import, so that half is read as source.
   */
  section('server: a BIOBUZZ build survives the ranked join');
  {
    const built = BB_PRESET_LIST.find((s) => bbLiftOf(s) !== null) ?? BB_PRESET_LIST[0];
    const wire = JSON.parse(
      JSON.stringify({
        clientId: 'x', name: 'x', teamName: 'T', teamNumber: 1, alliance: 'blue',
        startIndex: 0, ready: false, spec: built, assists: DEFAULT_ASSISTS,
      }),
    );
    const asBiobuzz = sanitizePlayer(wire, 'biobuzz').spec;
    const asDecode = sanitizePlayer(wire, 'decode').spec;
    const mechOf = (s: RobotSpec): string => JSON.stringify(s.bbMech ?? null);
    check(
      'the test build really has a Box Tube (else the checks below prove nothing)',
      bbLiftOf(built) !== null,
      built.name,
    );
    check(
      "sanitized as BIOBUZZ, the build's mechanisms and intake mount survive the wire",
      mechOf(asBiobuzz) === mechOf(built) && asBiobuzz.intakeMount === built.intakeMount,
      mechOf(asBiobuzz),
    );
    check(
      'sanitized as DECODE, they do NOT (so the check above can fail)',
      mechOf(asDecode) !== mechOf(built),
      mechOf(asDecode),
    );
    const indexSrc = readRepo('server/index.ts');
    check(
      "the room join sanitizes the player with the ROOM's game",
      indexSrc.includes('sanitizePlayer(msg.player, r.gameId)') &&
        !indexSrc.includes('sanitizePlayer(msg.player, cfg.game)'),
    );
  }

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
