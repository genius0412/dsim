/**
 * BOOT JIT WARM-UP — a short headless busy match per game, before the first real one.
 *
 * WHY: V8 compiles hot functions only after it has watched them run, so the FIRST match a fresh
 * process plays pays for the compilation. Measured on one room (`docs/capacity.md`, "Cold
 * first match"): the first match after a boot costs 30–60% more CPU than the second, with a
 * DECODE pre/auto phase at 5–6 ms a tick against 1.6 warm and single ticks of 100–390 ms. Every
 * satellite AUTO-STOPS when idle (fly.toml), so the first player on a woken machine always got
 * that match — the "it lags when I start playing" report, on a machine with nobody else on it.
 *
 * WHAT IT RUNS: a real `Room` per game, on the physics a server room of that game actually uses
 * (`serverPhysics` — a BIOBUZZ server room is always 3D, so there is no 2D BIOBUZZ path to warm),
 * driven by a scripted busy robot through the same `input` → `frameCommands` → `step` → recorder
 * → `broadcastSnapshot` (slim + encode) path a live room takes. Nothing about it is game-shaped
 * beyond the command, so a game added to `GAME_IDS` is warmed with no change here, and anything
 * that happens at world-build time (a statics cache, an engine built up front) is warmed simply
 * by building the world. The rooms are never registered with the server, never persist (no
 * callbacks), take no user lock (no userId), and are left CLEANLY at the end, which stops them
 * and frees any 3D world.
 *
 * ⚠️ IT MUST NEVER COST A PLAYER ANYTHING. The server is already LISTENING when this runs
 * (`/health` answers from the first moment, as it always has), and this does not gate joins:
 * it runs in SLICES of `SLICE_MS` and yields to the event loop between them, so a join, a
 * `/health` probe or a live room's tick waits at most one slice. A player who arrives during the
 * warm-up is served at once — their match merely shares the core with it for a few seconds.
 *
 * `WARMUP=0` (also `false`/`no`/`off`) is the kill switch, parsed as forgivingly as `WS_COMPRESS`.
 */
import * as C from '../src/config';
import { GAME_IDS, type GameId } from '../src/games/types';
import { quantizeCommand, type ClientMsg } from '../src/net/protocol';
import { DEFAULT_ASSISTS, DEFAULT_SPEC } from '../src/sim/spawn';
import type { RobotCommand } from '../src/types';
import { Room, type Client } from './room';

/** ticks per game. Past this the curve is flat: the functions that matter are compiled. */
export const WARMUP_TICKS = 900;
/** the longest the warm-up holds the event loop at once */
const SLICE_MS = 4;

export const warmupEnabled = (env: string | undefined): boolean => !/^(0|false|no|off)$/i.test((env ?? '').trim());

/** a busy robot: driving, turning, intaking, firing, and each game's mechanism buttons */
function busy(tick: number): RobotCommand {
  const p = tick / 60;
  return {
    driveX: Math.sin(p * 0.9),
    driveY: Math.cos(p * 0.7),
    rotate: Math.sin(p * 1.3) * 0.5,
    intake: true,
    fire: tick % 90 > 20,
    catalyst: tick % 300 < 30,
    bbPlace: tick % 240 === 118,
    bbPlaceNectar: tick % 240 === 238,
  } as RobotCommand;
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Warm every game. Resolves with what it did; never rejects (a game that throws is logged and
 * skipped — a warm-up failure must not take down a server that can otherwise play).
 */
export async function warmUp(ticksPerGame = WARMUP_TICKS): Promise<{ ms: number; ticks: number; games: GameId[] }> {
  const t0 = performance.now();
  let ticks = 0;
  const games: GameId[] = [];
  for (const game of GAME_IDS) {
    let room: Room | null = null;
    try {
      const client: Client = {
        id: 'warmup',
        send: () => {},
        // a REAL string sink, so the shared body is built and handed over exactly as for a socket
        sendRaw: () => {},
        player: {
          clientId: 'warmup',
          name: 'warmup',
          teamName: 'DSIM',
          teamNumber: 0,
          alliance: 'blue',
          startIndex: 0,
          ready: true,
          spec: { ...DEFAULT_SPEC },
          assists: { ...DEFAULT_ASSISTS },
        },
        connected: true,
        disconnectAt: 0,
      };
      room = new Room(`warmup-${game}`, () => {}, { kind: 'record', record: 'solo', game });
      room.add(client);
      room.onMessage('warmup', { t: 'start' });
      const w = room.worldForTest();
      if (!w) throw new Error('the warm-up room did not start');
      // straight to AUTO: robots do not move in `pre`, and a countdown warms nothing
      if (w.match.preCountdown != null) w.match.preCountdown = C.SIM_DT;
      let n = 0;
      while (n < ticksPerGame) {
        const slice = performance.now();
        do {
          const cur = room.worldForTest();
          if (!cur || cur.match.phase === 'post') break;
          const tick = cur.tick + 1;
          const msg: ClientMsg = { t: 'input', tick, q: quantizeCommand(busy(tick)) };
          room.onMessage('warmup', msg);
          // the synchronous pump the smoke suite uses: stepOnce + a broadcast on its cadence
          room.advanceForTest(1);
          n++;
        } while (n < ticksPerGame && performance.now() - slice < SLICE_MS);
        if (room.worldForTest()?.match.phase === 'post') break;
        await yieldToLoop();
      }
      ticks += n;
      games.push(game);
    } catch (e) {
      console.warn(`[warmup] ${game} skipped:`, e);
    } finally {
      // leave the way a player pressing Back leaves a solo run: a CLEAN detach, which empties
      // the room and stops it — freeing a 3D world with it (`Room.stop`)
      room?.detach('warmup', undefined, true);
    }
    await yieldToLoop();
  }
  return { ms: performance.now() - t0, ticks, games };
}
