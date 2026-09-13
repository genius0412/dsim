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
import { INTAKE_SHORT } from '../../src/ui/labelData';
import type { RobotSpec } from '../../src/types';
import { SPONSOR, sponsorActive } from '../../src/sponsor';
import { BB_HOOD_DEFAULT_DEG } from '../../src/games/biobuzz/config';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import { bbLauncherOf, bbLiftOf } from '../../src/games/biobuzz/mechs';
import type { BbMechSpec } from '../../src/games/biobuzz/mechs';
import { bbConfigSummary, bbLiftKindLabel } from '../../src/games/biobuzz/labels';
import {
  BB_PRESET_LIST,
  BB_REAL_PRESETS,
  BB_STARTER_BOTS,
  bbPresetLines,
} from '../../src/games/biobuzz/presets';
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

  // ---- the four loadouts both summary surfaces are pinned against --------
  // A launcher is MANDATORY (owner ruling 2026-09-12) and a Box Tube is optional, and a launcher
  // is one of three kinds, so these four are the shapes that print differently: a single turret
  // with and without a tube, a double turret (two cells to name) and a dumper (an edge and a
  // hood) with a tube.
  //
  // The Box Tube's name is CLOCK-DEPENDENT by design — it carries the sponsor's product name only
  // inside `SPONSOR.term` — so the expected strings are built from `bbLiftKindLabel` rather than
  // typing either spelling; both spellings are pinned against the term further down.
  const TUBE = bbLiftKindLabel('vslide');
  const LOADOUTS: { name: string; mech: BbMechSpec; tiles: string[]; line: string }[] = [
    {
      name: 'single turret',
      mech: { launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG }, lift: null },
      // a TURRET solves its own elevation per shot, so it has no hood to report
      tiles: ['Single turret / launcher / CENTER', 'No box tube / flower scoring'],
      line: 'Single turret · FRONT+BACK sweeper · CENTER launcher · 4 pollen',
    },
    {
      name: 'single turret + Box Tube',
      mech: {
        launcher: { kind: 'turret', mount: 'center', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: { kind: 'vslide', mount: 'back' },
      },
      tiles: ['Single turret / launcher / CENTER', `${TUBE} / flower scoring / BACK`],
      line: `Single turret · FRONT+BACK sweeper · CENTER launcher · ${TUBE} · BACK · 4 pollen`,
    },
    {
      name: 'double turret',
      mech: {
        launcher: { kind: 'twinturret', mount: 'right', mount2: 'left', hoodDeg: BB_HOOD_DEFAULT_DEG },
        lift: null,
      },
      tiles: ['Double turret / launcher / RIGHT + LEFT', 'No box tube / flower scoring'],
      line: 'Double turret · FRONT+BACK sweeper · RIGHT + LEFT launcher · 4 pollen',
    },
    {
      name: 'dumper + Box Tube',
      mech: {
        launcher: { kind: 'dumper', mount: 'front', hoodDeg: 80 },
        lift: { kind: 'vslide', mount: 'back' },
      },
      tiles: ['Dumper / launcher / FRONT · 80° hood', `${TUBE} / flower scoring / BACK`],
      line: `Dumper · FRONT+BACK sweeper · FRONT launcher · ${TUBE} · BACK · 4 pollen`,
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

    // THE WIRING, pinned at the source. A correct `bbConfigSummary` that no screen reads is
    // the whole bug this section exists for, and it is invisible to every check that calls
    // the function directly — the same reason the crawler files below are pinned as text.
    const menu = readRepo('src/ui/Menu.tsx');
    check(
      'Menu.tsx reads the slot for the saved-robot line',
      menu.includes('const gameSummary = mod.labels?.configSummary;'),
    );
    check(
      'Menu.tsx renders it as the `.om` detail line',
      menu.includes('<span className="om">{gameSummary(r)}</span>'),
    );
    // and BOTH shipped arms are still there, byte for byte.
    check(
      'the DECODE saved-robot arm is unchanged',
      menu.includes('{INTAKE_SHORT[r.intake]} · {r.flywheelInertia} inertia'),
    );
    check(
      'the CR saved-robot arm is unchanged',
      menu.includes('{CHAIN_MODE_LABELS[r.scoreMode ?? CHAIN_DEFAULT_SCORE_MODE]}'),
    );
    // THE PRESET CARD BODY is keyed on the SAME slot that picks the LIST, so the words under a
    // card can never describe a robot out of a different game's list.
    check(
      'the preset card body is keyed on the same slot as the preset list',
      menu.includes('const presets = gamePresets ? gamePresets.list :') &&
        menu.includes('{gamePresets ? ('),
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
    const shown = BB_PRESET_LIST.flatMap((p) => {
      const l = bbPresetLines(p);
      return [p.name, p.teamName, l.meta, l.zone ?? '', bbConfigSummary(p)];
    });
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
    check('HudSlots.tsx shows the FLOWER IN REACH chip', hudSrc.includes('FLOWER IN REACH'));
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
