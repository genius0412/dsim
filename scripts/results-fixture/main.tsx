/**
 * THE RESULTS SCREEN ON FIXTURE PROPS, for `npm run resultsaudit` (`scripts/resultsaudit.mjs`).
 *
 * The real `<Results>` and the app's real stylesheets, imported in `src/main.tsx`'s order, with a
 * finished match handed in as props: no game server, no match to play, every board in a second.
 * Served from the repo root by the audit's own Vite server at `/scripts/results-fixture/`.
 *
 *   ?case=bbVersus | bbSolo | decodeVersus | decodeSolo | chainVersus
 *   &theme=light | dark
 *
 * The scores are chosen to be the WIDEST a board meets: three-digit values on one side and one
 * digit on the other, and BIOBUZZ's longest label ("Bottom NECTAR Bonus"), because those are what
 * wrap a label or push a value column first.
 */
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/space-grotesk';
import '../../src/ui/styles.css';
import '../../src/ui/shell.css';
import '../../src/ui/tutorial.css';
import { applyTheme } from '../../src/theme';
import { Results } from '../../src/ui/Results';
import type { HudSnapshot } from '../../src/game';
import type { Replay, ReplayResult } from '../../src/sim/replay';

const qp = new URLSearchParams(location.search);
applyTheme(qp.get('theme') === 'dark' ? 'dark' : 'light');
const name = qp.get('case') || 'bbVersus';

const decodeScore = (over: Record<string, number> = {}) => ({
  leave: 0, autoClassified: 0, autoOverflow: 0, autoPattern: 0,
  teleClassified: 0, teleOverflow: 0, telePattern: 0, depot: 0, base: 0,
  foulPoints: 0, voided: false, total: 0, ...over,
});

/** only what `<Results>` reads; the rest of a live HUD has no bearing on this screen */
const hudOf = (over: Record<string, unknown>): HudSnapshot =>
  ({
    game: 'decode', mode: 'match', phase: 'post', timeLeft: 0, alliance: 'red',
    score: decodeScore(), oppScore: decodeScore(),
    fouls: { red: { minor: 0, major: 0 }, blue: { minor: 0, major: 0 } },
    resultFinal: true, resultLost: false, rematch: null, windowFocused: true,
    ...over,
  }) as unknown as HudSnapshot;

const seat = (id: number, alliance: 'red' | 'blue', driver: string) => ({
  id, alliance, passive: false,
  spec: { name: driver, teamName: `Team ${id}`, teamNumber: 10000 + id, drivetrain: 'mecanum' },
  assists: {}, startIndex: 0,
});

const bbAlliance = (o: Record<string, number>) => ({
  leaveCount: 0, leave: 0, parkAutoCount: 0, parkAuto: 0, parkTeleCount: 0, parkTele: 0,
  tips: 0, tipPts: 0, cellCount: 0, cellPts: 0, ownedCount: 0, ownedPts: 0, bottomCount: 0,
  bottomPts: 0, gardenCount: 0, gardenPts: 0, foul: 0, total: 0, ...o,
});

const versus = name.endsWith('Versus');
const setups = versus ? [seat(0, 'red', 'Red Driver'), seat(1, 'blue', 'Blue Driver')] : [seat(0, 'red', 'Red Driver')];
let hud: HudSnapshot;
if (name.startsWith('bb')) {
  const red = bbAlliance({ leave: 3, tipPts: 40, gardenPts: 1, total: 44 });
  const blue = bbAlliance({ leave: 6, parkAuto: 5, tipPts: 220, cellPts: 8, ownedPts: 20, bottomPts: 15, gardenPts: 1, parkTele: 10, total: 285 });
  hud = hudOf({
    game: 'biobuzz',
    score: decodeScore({ total: 44 }),
    oppScore: decodeScore({ total: 285 }),
    gameHud: { field: { score: { red, blue } } },
  });
} else if (name.startsWith('chain')) {
  hud = hudOf({
    game: 'chain',
    chain: { scored: 12, oppScored: 10, mult: 2, oppMult: 2, catalysts: 1, oppCatalysts: 1, particlePts: 108,
      oppParticlePts: 90, endgame: 'parked', carrying: false, ringAction: null, storage: 10, mode: 'turret',
      foulPts: 5, oppFoulPts: 0 },
    score: decodeScore({ total: 118 }),
    oppScore: decodeScore({ total: 95 }),
  });
} else {
  hud = hudOf({
    score: decodeScore({ leave: 6, autoClassified: 9, autoPattern: 9, teleClassified: 117, teleOverflow: 4, telePattern: 18, base: 10, total: 173 }),
    oppScore: decodeScore({ leave: 3, autoClassified: 3, teleClassified: 12, depot: 2, base: 20, total: 40 }),
    fouls: { red: { minor: 1, major: 0 }, blue: { minor: 0, major: 1 } },
  });
}

const practiceRun = {
  replay: { setups } as unknown as Replay,
  result: { score: { red: hud.score.total, blue: hud.oppScore.total }, foulPoints: { red: 0, blue: 0 } },
} as unknown as { replay: Replay; result: ReplayResult };
const noop = (): void => {};

createRoot(document.getElementById('root')!).render(
  <Results
    hud={hud}
    final
    lost={false}
    ranked={false}
    eloResults={null}
    canRematch
    onRematch={noop}
    rematchVote={null}
    onRematchVote={noop}
    onExit={noop}
    matchResult={null}
    practiceRun={practiceRun}
    recordResult={null}
    signedIn
    onWatchReplay={noop}
    reportable={[]}
    localRobotId={0}
  />,
);
