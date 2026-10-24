import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIOBUZZ_SIM } from '../../src/games/biobuzz/sim';
import { BB_DEFAULT_SPEC } from '../../src/games/biobuzz/robotConfig';
import type { RobotSpec } from '../../src/types';
import { autoAdapterFor, createAutoSeat } from '../../src/auto/zenithAutos';
import { loadZenithAuto, namesUsed } from '../../src/auto/load';
import { autoView } from '../../src/auto/view';
import {
  AUTO_LIBRARY_MAX,
  LIBRARY_FULL,
  importAutos,
  libraryFullFor,
  libraryHasRoom,
  removeAuto,
  restoreAuto,
  upsertAuto,
  type AutoLibraryEntry,
  type GameAutoLibrary,
} from '../../src/auto/library';
import { autoHudLine, autoPreNotice, countOf, endsAtOnce, neverReadsTrue, planVerdict, warningsFact } from '../../src/ui/autoHud';
import { HOST_BUILD, openMessage } from '../../src/ui/zenithOpen';
import { hostLabelFor, playerStartPose } from '../../src/ui/zenithProject';
import { defaultSettings, switchGame } from '../../src/settings';
import { BB_STARTER_BOTS } from '../../src/games/biobuzz/presets';
import { simModuleFor } from '../../src/games/sim';
import { DEFAULT_ASSISTS } from '../../src/sim/spawn';
import type { GameAutoStatus } from '../../src/game';
import { setup, type Check } from './harness';

/**
 * THE AUTOUI LANE: what the Autonomous panel and the match screen say and do about the player's
 * autos (docs/area/autos.md, `src/ui/AutonomousSetup.tsx`, `src/ui/autoHud.ts`, `src/auto/library.ts`).
 *
 * Everything the panel DECIDES lives in DOM-free functions, so it is held here: the library's
 * refusals and its Undo, the plural of a count, and the pre-match line. The three things that are
 * CSS or markup and cannot be run without a browser (the buttons coming before the preview, the
 * picked game's fill on Home) are held the way the rest of this suite holds a rule it cannot
 * execute: by reading the source for the declaration that makes it true.
 *
 * Zenith UX sweep 2026-10-20 (W4-D2, D8 to D15) and 2026-09-28 (DSIM-8) are the findings.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '..', '..', rel), 'utf8');
const adapter = autoAdapterFor('biobuzz');

const entry = (n: number, patch: Partial<AutoLibraryEntry> = {}): AutoLibraryEntry => ({
  id: `id${n}`,
  name: `auto-${n}`,
  auto: `{"n":${n}}`,
  source: 'file',
  savedAt: 1000 - n,
  ...patch,
});

/** a library of `n` entries, newest first, with `active` (by index) switched on or not */
function library(n: number, active: number | null = null, enabled = active !== null): GameAutoLibrary {
  const entries = Array.from({ length: n }, (_, i) => entry(i));
  return { entries, activeId: active === null ? null : entries[active].id, enabled };
}

/** a one-step routine: "1 steps" was its verdict */
function oneStep(extra: Record<string, unknown>[] = []): string {
  return JSON.stringify({
    formatVersion: 3,
    name: 'one-step',
    alliance: 'RED',
    start: { pose: { xIn: -34, yIn: -63.17, headingRad: 1.5708 } },
    steps: [
      ...extra,
      { id: 'leg', kind: 'path', segments: [{ kind: 'line', from: 'current', to: { xIn: -34, yIn: -40 } }], heading: { mode: 'constant', headingRad: 1.5708 } },
    ],
  });
}

export function autoUiChecks(check: Check): void {
  // ---- THE LIBRARY REFUSES A NEW NAME AT TWELVE, AND NEVER DROPS THE AUTO AUTO PLAYS (W4-D2) ----
  {
    const full = library(AUTO_LIBRARY_MAX, AUTO_LIBRARY_MAX - 1);
    check(
      'AUTOUI library: a name already in it always has room; a new one has room only below the cap',
      libraryHasRoom(library(AUTO_LIBRARY_MAX - 1), 'brand-new') &&
        !libraryHasRoom(full, 'brand-new') &&
        libraryHasRoom(full, 'auto-3'),
    );
    const out = importAutos(full, [
      { file: 'a.auto.json', name: 'fresh-a', auto: '{}' },
      { file: 'b.auto.json', name: 'fresh-b', auto: '{}' },
    ]);
    check(
      'AUTOUI import: new names into a full library are refused, listed by file, and the library is untouched',
      out.added.length === 0 &&
        out.refused.join() === 'a.auto.json,b.auto.json' &&
        out.lib.entries.length === AUTO_LIBRARY_MAX &&
        out.lib.entries.every((e, i) => e === full.entries[i]) &&
        out.lib.activeId === full.activeId &&
        out.lib.enabled === full.enabled,
      `${out.refused.join()} ${out.lib.entries.length}`,
    );
    const replaced = importAutos(full, [{ file: 'x.auto.json', name: 'auto-3', auto: '{"replaced":true}' }]);
    check(
      'AUTOUI import: a file named like an auto in a full library REPLACES it, in place of the old one, and nothing else goes',
      replaced.added.join() === 'auto-3' &&
        replaced.refused.length === 0 &&
        replaced.lib.entries.length === AUTO_LIBRARY_MAX &&
        replaced.lib.entries[0].auto === '{"replaced":true}' &&
        replaced.lib.entries[0].id === 'id3' &&
        replaced.lib.activeId === full.activeId,
    );
    // the multi-file import that crosses the cap: the first fits, the rest are refused, and the
    // active auto (the OLDEST, the one the old cap dropped) is still there and still the one
    const eleven = library(AUTO_LIBRARY_MAX - 1, AUTO_LIBRARY_MAX - 2);
    const crossed = importAutos(eleven, ['a', 'b', 'c'].map((n) => ({ file: `${n}.auto.json`, name: `fresh-${n}`, auto: '{}' })));
    check(
      'AUTOUI import: three files into eleven add one and refuse two, and the auto AUTO plays survives',
      crossed.added.join() === 'fresh-a' &&
        crossed.refused.join() === 'b.auto.json,c.auto.json' &&
        crossed.lib.entries.length === AUTO_LIBRARY_MAX &&
        crossed.lib.entries.some((e) => e.id === eleven.activeId) &&
        crossed.lib.activeId === eleven.activeId,
      `${crossed.added.join()} | ${crossed.refused.join()}`,
    );
    check(
      'AUTOUI import: the refusal names the files (three, then a count) and says why and what to do',
      libraryFullFor(['a.auto.json']) === `Couldn’t import a.auto.json. ${LIBRARY_FULL}` &&
        libraryFullFor(['a', 'b', 'c']).startsWith('Couldn’t import a, b, c. ') &&
        libraryFullFor(['a', 'b', 'c', 'd', 'e']).startsWith('Couldn’t import a, b, c and 2 more. ') &&
        libraryFullFor(['a']).endsWith('Delete an auto to add another.'),
    );
    // `upsertAuto`'s cap is the last line for the callers that do not ask first: it no longer
    // takes the active auto, which used to move `activeId` to the new, unreviewed file
    const oldestActive = library(AUTO_LIBRARY_MAX, AUTO_LIBRARY_MAX - 1);
    const up = upsertAuto(oldestActive, { name: 'newcomer', auto: '{}', source: 'file', savedAt: 5000 });
    check(
      'AUTOUI library: past the cap, upsertAuto drops the oldest entry that is NOT the active one, never the active one',
      up.entries.length === AUTO_LIBRARY_MAX &&
        up.entries[0].name === 'newcomer' &&
        up.activeId === oldestActive.activeId &&
        up.entries.some((e) => e.id === oldestActive.activeId) &&
        !up.entries.some((e) => e.id === 'id10'),
      `active ${up.activeId}, ${up.entries.length} entries`,
    );
    const plain = upsertAuto(library(AUTO_LIBRARY_MAX, 0), { name: 'newcomer', auto: '{}', source: 'file', savedAt: 5000 });
    check(
      'AUTOUI library: ...and with an ordinary library it still drops the oldest',
      plain.entries.length === AUTO_LIBRARY_MAX && !plain.entries.some((e) => e.id === `id${AUTO_LIBRARY_MAX - 1}`) && plain.activeId === 'id0',
    );
  }

  // ---- DELETE HAS AN UNDO THAT PUTS EVERYTHING BACK (W4-D10) ----
  {
    const lib = library(5, 2, true);
    const out = removeAuto(lib, 'id2');
    check(
      'AUTOUI delete: deleting the auto AUTO plays leaves none on, and remembers where it was and that it was on',
      !!out &&
        out.lib.entries.length === 4 &&
        out.lib.activeId === null &&
        !out.lib.enabled &&
        out.removed.index === 2 &&
        out.removed.wasActive &&
        out.removed.wasEnabled,
    );
    const back = out ? restoreAuto(out.lib, out.removed) : null;
    check(
      'AUTOUI undo: the entry comes back at its own position, as the auto AUTO plays, switched on again',
      !!back &&
        back.ok &&
        back.lib.entries.map((e) => e.id).join() === lib.entries.map((e) => e.id).join() &&
        back.lib.activeId === lib.activeId &&
        back.lib.enabled === true,
    );
    const elsewhere = out ? { ...out.lib, activeId: 'id4', enabled: true } : null;
    const noSteal = out && elsewhere ? restoreAuto(elsewhere, out.removed) : null;
    check(
      'AUTOUI undo: it does not take AUTO back from an auto that was switched on since',
      !!noSteal && noSteal.ok && noSteal.lib.activeId === 'id4' && noSteal.lib.enabled && noSteal.lib.entries.some((e) => e.id === 'id2'),
    );
    const idle = removeAuto(library(5, 2, false), 'id2');
    const idleBack = idle ? restoreAuto(idle.lib, idle.removed) : null;
    check(
      'AUTOUI undo: an auto that was chosen but switched off comes back chosen and switched off',
      !!idleBack && idleBack.ok && idleBack.lib.activeId === 'id2' && !idleBack.lib.enabled,
    );
    const other = removeAuto(lib, 'id0');
    check(
      'AUTOUI delete: deleting another auto leaves the one AUTO plays alone, and its undo does not touch AUTO',
      !!other && other.lib.activeId === 'id2' && other.lib.enabled && !other.removed.wasActive && restoreAuto(other.lib, other.removed).ok === true,
    );
    const filled: GameAutoLibrary = { entries: Array.from({ length: AUTO_LIBRARY_MAX }, (_, i) => entry(100 + i)), activeId: null, enabled: false };
    const crowded = out ? restoreAuto(filled, out.removed) : null;
    check(
      'AUTOUI undo: it is refused with a sentence when the library has filled up since',
      !!crowded && !crowded.ok && crowded.error.includes(LIBRARY_FULL),
      crowded && !crowded.ok ? crowded.error : 'restored',
    );
    const named = out ? restoreAuto({ ...out.lib, entries: [...out.lib.entries, entry(99, { name: 'auto-2' })] }, out.removed) : null;
    check(
      'AUTOUI undo: it is refused when an auto of that name is in the library now (no two share a name)',
      !!named && !named.ok && named.error.startsWith('Couldn’t restore auto-2. '),
    );
    check('AUTOUI delete: an id the library does not hold deletes nothing', removeAuto(lib, 'nope') === null);
  }

  // ---- A COUNT IS PLURAL ONLY WHEN IT IS (W4-D9: "1 steps") ----
  {
    const base = { errors: [], steps: 1, atLeast: false, estimateS: 1.1, periodS: 30 };
    check('AUTOUI plural: one step reads "1 step"', planVerdict(base).text === '1 step, about 1.1 s of 30 s', planVerdict(base).text);
    check('AUTOUI plural: several read "steps", and an estimate with a floor says "at least"', planVerdict({ ...base, steps: 9, atLeast: true, estimateS: 8.3 }).text === '9 steps, at least 8.3 s of 30 s');
    check(
      'AUTOUI plural: one problem reads "1 problem", two read "2 problems", and the first is named',
      planVerdict({ ...base, errors: [{ message: 'no' }] }).text === '1 problem: no' &&
        planVerdict({ ...base, errors: [{ message: 'no' }, { message: 'again' }] }).text === '2 problems: no' &&
        !planVerdict({ ...base, errors: [{ message: 'no' }] }).ok,
    );
    check(
      'AUTOUI plural: one warning is the message under "Warning", several are a count and the first under "Warnings"',
      warningsFact([])?.label === undefined &&
        warningsFact([{ message: 'm' }])?.label === 'Warning' &&
        warningsFact([{ message: 'm' }])?.text === 'm' &&
        warningsFact([{ message: 'm' }, { message: 'n' }])?.label === 'Warnings' &&
        warningsFact([{ message: 'm' }, { message: 'n' }])?.text === '2. First: m',
    );
    check(
      'AUTOUI plural: "It ends" for one command and "These end" for several',
      endsAtOnce(['a']) === 'It ends at once.' &&
        endsAtOnce(['a', 'b']) === 'These end at once.' &&
        neverReadsTrue(['a']) === 'It never reads true.' &&
        neverReadsTrue(['a', 'b']) === 'These never read true.' &&
        countOf(1, 'auto') === '1 auto' &&
        countOf(3, 'auto') === '3 autos',
    );
    if (adapter) {
      // the real one-step file through the real planner, the way the panel builds its verdict
      const v = autoView(loadZenithAuto({ auto: oneStep() }, 'red', { ...BB_DEFAULT_SPEC } as RobotSpec, adapter));
      check('AUTOUI plural: a real one-step auto, planned and viewed, reads "1 step, ..."', v.steps === 1 && planVerdict(v).text.startsWith('1 step, '), planVerdict(v).text);
    }
  }

  // ---- THE PRE-MATCH LINE SAYS WHAT WILL NOT RUN (W4-D13) ----
  {
    const seatStatus = { state: 'waiting', stepId: null, timeS: 0 } as const;
    const st = (patch: Partial<GameAutoStatus> = {}): GameAutoStatus => ({ ...seatStatus, name: 'garden-cycle', problems: [], ...patch });
    check(
      'AUTOUI pre-match: a clean auto, a file the seat cannot load and a flagged auto read exactly as before the clause existed',
      autoPreNotice({ auto: st() })?.text === 'garden-cycle plays in AUTO.' &&
        autoPreNotice({ auto: st() })?.tone === 'ok' &&
        autoPreNotice({ auto: st({ state: 'error', error: 'bad file' }) })?.text === 'Auto off: bad file You drive in AUTO.' &&
        autoPreNotice({ auto: st({ problems: ['The start is in the other half.'] }) })?.text === 'garden-cycle plays in AUTO, but Zenith flags a problem. The start is in the other half.' &&
        autoPreNotice({ auto: st({ unsupported: [], notOnRobot: [] }) })?.text === 'garden-cycle plays in AUTO.',
    );
    const one = autoPreNotice({ auto: st({ unsupported: ['intakeOn'] }) });
    check(
      'AUTOUI pre-match: a command DSIM does not run is named, and the line is a warning',
      one?.tone === 'warn' && one.text === 'garden-cycle plays in AUTO. intakeOn is not in DSIM and ends at once.',
      one?.text,
    );
    check(
      'AUTOUI pre-match: two are "are ... end", three are listed with an "and", and a name used twice is said once',
      autoPreNotice({ auto: st({ unsupported: ['a', 'b'] }) })?.text === 'garden-cycle plays in AUTO. a and b are not in DSIM and end at once.' &&
        autoPreNotice({ auto: st({ unsupported: ['a', 'b', 'c'] }) })?.text === 'garden-cycle plays in AUTO. a, b and c are not in DSIM and end at once.' &&
        autoPreNotice({ auto: st({ unsupported: ['a', 'a'] }) })?.text === 'garden-cycle plays in AUTO. a is not in DSIM and ends at once.',
    );
    check(
      'AUTOUI pre-match: a command this build cannot run is "not on this robot", and both causes are said, DSIM first',
      autoPreNotice({ auto: st({ notOnRobot: ['setRamp'] }) })?.text === 'garden-cycle plays in AUTO. setRamp is not on this robot and ends at once.' &&
        autoPreNotice({ auto: st({ unsupported: ['intakeOn'], notOnRobot: ['setRamp'] }) })?.text ===
          'garden-cycle plays in AUTO. intakeOn is not in DSIM and ends at once. setRamp is not on this robot and ends at once.',
    );
    check(
      'AUTOUI pre-match: a CONDITION DSIM cannot read "never reads true" (a wait on it runs to its timeout), not "ends at once"',
      autoPreNotice({ auto: st({ unsupportedConditions: ['holdingPiece'] }) })?.text === 'garden-cycle plays in AUTO. holdingPiece is not in DSIM and never reads true.' &&
        autoPreNotice({ auto: st({ unsupportedConditions: ['a', 'b'] }) })?.text === 'garden-cycle plays in AUTO. a and b are not in DSIM and never read true.' &&
        autoPreNotice({ auto: st({ unsupported: ['intakeOn'], unsupportedConditions: ['holdingPiece'] }) })?.text ===
          'garden-cycle plays in AUTO. intakeOn is not in DSIM and ends at once. holdingPiece is not in DSIM and never reads true.',
    );
    check(
      'AUTOUI pre-match: a flagged auto keeps its problem first and adds the clause after it',
      autoPreNotice({ auto: st({ problems: ['Over 30 s.'], unsupported: ['intakeOn'] }) })?.text ===
        'garden-cycle plays in AUTO, but Zenith flags a problem. Over 30 s. intakeOn is not in DSIM and ends at once.',
    );
    check(
      'AUTOUI pre-match: an auto that cannot load names no skipped command (it plays nothing at all)',
      !/not in DSIM|not on this robot/.test(autoPreNotice({ auto: st({ state: 'error', error: 'x', unsupported: ['a'] }) })?.text ?? ''),
    );
    if (adapter) {
      // the controller's own composition (`GameController.seatAuto`): a REAL file on a build with no ramp
      const text = oneStep([
        { id: 'a', kind: 'command', name: 'intakeOn', args: {} },
        { id: 'r', kind: 'command', name: 'setRamp', args: { state: 'DEPLOY' } },
      ]).replace('"one-step"', '"skippy"');
      const world = BIOBUZZ_SIM.createWorld('match', 3, [setup(0, 'blue', {}, 2)], undefined, '2d');
      const seat = createAutoSeat(world, 0, { auto: text }, adapter);
      // composed the way `GameController.seatAuto` composes it
      const statusOf = (seat: ReturnType<typeof createAutoSeat>, name: string): GameAutoStatus => {
        const used = seat.loaded ? namesUsed(seat.loaded.written) : { commands: [], conditions: [] };
        return {
          ...seat.status(),
          name,
          problems: [],
          unsupported: used.commands.filter((n) => !adapter.commands.includes(n)),
          unsupportedConditions: used.conditions.filter((n) => !adapter.conditions.includes(n)),
          notOnRobot: seat.loaded ? seat.loaded.notOnRobot.map((c) => c.name) : [],
        };
      };
      const line = autoPreNotice({ auto: statusOf(seat, 'skippy') });
      check(
        'AUTOUI pre-match: a real file with an unknown command and a ramp command on a ramp-less build says both',
        line?.text === 'skippy plays in AUTO. intakeOn is not in DSIM and ends at once. setRamp is not on this robot and ends at once.',
        line?.text,
      );
      const withCondition = JSON.parse(text) as { steps: { endCondition?: { condition: string } }[] };
      withCondition.steps[withCondition.steps.length - 1].endCondition = { condition: 'holdingPiece' };
      const seat2 = createAutoSeat(BIOBUZZ_SIM.createWorld('match', 3, [setup(0, 'blue', {}, 2)], undefined, '2d'), 0, { auto: JSON.stringify(withCondition) }, adapter);
      const line2 = autoPreNotice({ auto: statusOf(seat2, 'skippy') });
      check(
        'AUTOUI pre-match: a real file that waits on a condition DSIM cannot read says it never reads true',
        !!line2 && line2.text.includes('holdingPiece is not in DSIM and never reads true.') && !line2.text.includes('holdingPiece is not in DSIM and ends'),
        line2?.text,
      );
    }
  }

  // ---- THE MARKUP AND CSS RULES THAT CANNOT RUN HERE: HELD BY THEIR DECLARATION ----
  {
    const panel = read('src/ui/AutonomousSetup.tsx');
    const at = (needle: string): number => panel.indexOf(needle);
    check(
      'AUTOUI panel: the library, the buttons and the Play switch come before the preview (the reach at 1280x720, W4-D8)',
      at('className="ds-opts list"') > 0 &&
        at('editInZenith(selected)') > at('className="ds-opts list"') &&
        at('label="Play it in AUTO"') > at('editInZenith(selected)') &&
        at('<Preview') > at('label="Play it in AUTO"'),
    );
    check(
      'AUTOUI panel: the command list is open for an empty library and sits above the preview, where it is found (DSIM-8)',
      /useState\(empty\)/.test(panel) && at('className="ds-auto-cmds"') > at('label="Play it in AUTO"') && at('className="ds-auto-cmds"') < at('<Preview'),
    );
    const game = read('src/ui/GameView.tsx');
    check(
      'AUTOUI copy: the match button reads RESET, the pre-match hint and the Autonomous panel say RESET too (W4-D14)',
      /⟲<\/span> RESET\s*<\/button>/.test(game) && /· reset\s*<\/p>/.test(game) && /and RESET plays it again/.test(panel) && !/Restart plays/.test(panel),
    );
    const css = read('src/ui/shell.css');
    const on = /\.ds-app\.stage-home \.ds-home-games \.ds-seg\.on \{([^}]*)\}/.exec(css)?.[1] ?? '';
    check(
      'AUTOUI home: the picked game on desktop Home carries the accent fill and its ink (it kept the panel fill: dark on dark, white on white, W4-D15)',
      /background:\s*var\(--ds-accent\)/.test(on) && /color:\s*var\(--ds-accent-ink\)/.test(on),
      on.replace(/\s+/g, ' '),
    );
    const list = /\.ds-opts\.list \{([^}]*)\}/.exec(css)?.[1] ?? '';
    check(
      'AUTOUI list: the library list is one column that scrolls inside itself past a few rows (W4-D11)',
      /grid-template-columns:\s*minmax\(0, 1fr\)/.test(list) && /max-height:/.test(list) && /overflow-y:\s*auto/.test(list),
      list.replace(/\s+/g, ' '),
    );
  }

  // ── THE HOST SIDE (src/ui/zenithOpen.ts, zenithProject.ts): what DSIM sends Zenith ──────────────
  {
    // Zenith's DSIM row (Zenith apps/web/src/project/hostOrigins.ts) sets minBuild 2: build 1 vendors a
    // Zenith that cannot read the auto format 4 files Zenith writes, and gets "DSIM needs an update"
    check('AUTOUI host: DSIM says host build 2 or later, the first that reads auto format 4 (Zenith minBuild 2)', HOST_BUILD >= 2, String(HOST_BUILD));
    const project = { name: 'DSIM', robot: {}, field: {}, autos: {} };
    const start = { alliance: 'BLUE' as const, xIn: 34, yIn: 65.4, headingRad: -1.5708 };
    const sent = openMessage({ project, newAuto: true, newAutoStart: start }, true);
    const plain = openMessage({ project, open: 'a' }, true);
    check(
      'AUTOUI host: an open carries the player’s start as newAutoStart, and an open without one carries no key (Zenith W4-7)',
      JSON.stringify(sent.newAutoStart) === JSON.stringify(start) && !('newAutoStart' in plain) && sent.newAuto === true,
      JSON.stringify(sent.newAutoStart),
    );
    const bb = switchGame(defaultSettings(), 'biobuzz');
    const spawn = (s: typeof bb): { x: number; y: number; h: number } => {
      const w = simModuleFor('biobuzz').createWorld('match', 1, [{ id: 0, alliance: s.alliance, spec: s.spec, assists: { ...DEFAULT_ASSISTS }, startIndex: s.startIndex, ...(s.startPose ? { startPose: s.startPose } : {}) }], undefined, '2d');
      const r = w.robots[0];
      return { x: r.pos.x, y: r.pos.y, h: r.heading };
    };
    for (const alliance of ['blue', 'red'] as const) {
      for (const startIndex of [0, 1, 2]) {
        const s = { ...bb, alliance, startIndex, startPose: null };
        const p = playerStartPose(s);
        const w = spawn(s);
        check(
          `AUTOUI host: New in Zenith starts at the pose the robot spawns at (${alliance}, anchor ${startIndex})`,
          p !== null && p.alliance === alliance.toUpperCase() && Math.abs(p.xIn - w.x) < 1e-3 && Math.abs(p.yIn - w.y) < 1e-3 && Math.abs(p.headingRad - w.h) < 1e-3,
          JSON.stringify(p),
        );
      }
    }
    // BIOBUZZ is point-symmetric, so a RED and a BLUE robot on the same anchor are each other's mirror,
    // which is what lets Zenith fold either onto its own alliance as the same canonical start
    const b = playerStartPose({ ...bb, alliance: 'blue', startIndex: 0, startPose: null });
    const r = playerStartPose({ ...bb, alliance: 'red', startIndex: 0, startPose: null });
    check(
      'AUTOUI host: the same anchor on RED is the point mirror of BLUE’s, so Zenith lands both on one start',
      !!b && !!r && Math.abs(b.xIn + r.xIn) < 1e-3 && Math.abs(b.yIn + r.yIn) < 1e-3 && Math.abs(Math.cos(b.headingRad) + Math.cos(r.headingRad)) < 1e-3,
      JSON.stringify({ b, r }),
    );
    const starter = BB_STARTER_BOTS[0];
    check(
      'AUTOUI host: a StarterBot build on the default name is "StarterBot" on Zenith’s bar, a typed name wins (W4-D12)',
      hostLabelFor({ ...bb, spec: { ...starter, name: 'My Robot' } }) === starter.name &&
        hostLabelFor({ ...bb, spec: { ...starter, name: 'Hornet' } }) === 'Hornet' &&
        hostLabelFor({ ...bb, spec: { ...bb.spec, name: '' } }) !== '',
      hostLabelFor({ ...bb, spec: { ...starter, name: 'My Robot' } }),
    );
    const base = { name: 'cycle', problems: [], timeS: 5 } as const;
    check(
      'AUTOUI hud: a shot the auto gave up on is named on the HUD, and STUCK still wins',
      autoHudLine({ phase: 'auto', auto: { ...base, state: 'running', stepId: 'park', cantShoot: 'shoot' } }) === 'AUTO COULDN’T SHOOT ON SHOOT' &&
        autoHudLine({ phase: 'auto', auto: { ...base, state: 'running', stepId: 'park', stuck: true, cantShoot: 'shoot' } }) === 'AUTO STUCK ON PARK' &&
        autoHudLine({ phase: 'teleop', auto: { ...base, state: 'stopped', stepId: null, cantShoot: 'shoot' } }) === null,
      String(autoHudLine({ phase: 'auto', auto: { ...base, state: 'running', stepId: 'park', cantShoot: 'shoot' } })),
    );
  }
}
