/**
 * SIM WORKERS (`SIM_WORKERS` > 0) — real worker threads, fake sockets. `npm run test:workers`.
 *
 * `server/roomPool.ts` moves every `Room` into a worker thread and leaves main a `RoomHandle`.
 * The room code is unchanged, so what needs proving is the SEAM: that a join, a match, its
 * snapshots, its finalize and its persistence callback all cross the thread boundary and come
 * back intact; that a reconnect reclaims its seat; and that a worker dying takes only its own
 * rooms, tells their clients, and is replaced.
 *
 * Its own process, like `test:mm`: worker threads cost a Rapier init each, and a red `npm test`
 * must keep meaning "physics broke". `npm test` runs it after the shared suite.
 */
import { initPhysics } from '../src/sim/physicsEngine';
import { RoomPool, type RoomHandle } from '../server/roomPool';
import { Room, type Client, type MatchOutcome } from '../server/room';
import { DEFAULT_SPEC, DEFAULT_ASSISTS } from '../src/sim/spawn';
import { quantizeCommand, CLIENT_CAPS, type ServerMsg } from '../src/net/protocol';
import type { RobotCommand } from '../src/types';

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(10);
  }
  return true;
}

/** a fake socket: what reached it, parsed, plus the raw strings */
function sock(id: string, userId?: string): { client: Client; got: ServerMsg[]; raw: string[]; closed: boolean } {
  const s = { got: [] as ServerMsg[], raw: [] as string[], closed: false, client: null as unknown as Client };
  const sendRaw = (str: string): void => {
    s.raw.push(str);
    s.got.push(JSON.parse(str) as ServerMsg);
  };
  s.client = {
    id,
    send: (m) => sendRaw(JSON.stringify(m)),
    sendRaw,
    backlog: () => 0,
    player: { clientId: id, name: id, teamName: 'T', teamNumber: 1, alliance: 'blue', startIndex: 0, ready: true, spec: { ...DEFAULT_SPEC }, assists: { ...DEFAULT_ASSISTS } },
    connected: true,
    disconnectAt: 0,
    caps: CLIENT_CAPS.filter((c) => c !== 'viewready'),
    ...(userId ? { userId } : {}),
  };
  return s;
}
const drive = (t: number): RobotCommand => ({ driveX: Math.sin(t / 60), driveY: Math.cos(t / 40), rotate: 0.3, intake: true, fire: t % 90 > 20 }) as RobotCommand;

await initPhysics();
const pool = new RoomPool(2, { warm: false, log: () => {} });
await pool.ready();
check('pool: two workers started and loaded physics', pool.load().length === 2);

// ═══ 1. JOIN → MATCH → SNAPSHOTS → FINALIZE → onResult ON MAIN ═════════════════════════
{
  const outcomes: MatchOutcome[] = [];
  let emptied = false;
  const active: string[] = [];
  const h = pool.createRoom(
    'rec-w1',
    () => (emptied = true),
    { kind: 'record', record: 'solo', game: 'decode' },
    async (o) => {
      outcomes.push(o);
      return { record: { mode: 'solo', drivetrain: 'mecanum', score: 1, pb: true, wr: false, rank: 1, total: 1 } } as never;
    },
    (uid) => active.push('+' + uid),
    (uid) => active.push('-' + uid),
  );
  const s = sock('p1', 'user-1');
  h.add(s.client);
  check('join: add set the caller\'s conn synchronously (index.ts reads it right back)', typeof s.client.conn === 'number' && s.client.conn > 0);
  check('join: a fresh handle answers the join-path reads before any mirror arrives', h.canJoin() && h.isAbandonable() === false && h.gameId === 'decode');
  await until(() => s.got.some((m) => m.t === 'welcome'));
  check('join: the worker room welcomed the client through main', s.got.some((m) => m.t === 'welcome'));
  h.onMessage('p1', { t: 'start' });
  await until(() => s.got.some((m) => m.t === 'matchStart'));
  check('match: matchStart arrived', s.got.some((m) => m.t === 'matchStart'));
  // real time, on the worker's own clock: inputs flow in, snapshots flow out
  const t0 = Date.now();
  let tick = 0;
  while (Date.now() - t0 < 1500) {
    tick++;
    h.onMessage('p1', { t: 'input', tick, q: quantizeCommand(drive(tick)) } as never);
    await sleep(16);
  }
  const snaps = s.raw.filter((x) => x.startsWith('{"t":"snapshot"'));
  check('snapshots: the worker clock stepped the match and streamed snapshots to the socket', snaps.length >= 20, `${snaps.length} in 1.5 s`);
  const ticks = snaps.map((x) => (JSON.parse(x) as { serverTick: number }).serverTick);
  check('snapshots: serverTick only moves forward', ticks.every((t, i) => i === 0 || t > ticks[i - 1]));
  check('mirror: main sees the running match without asking (hasWorld, summary)', h.hasWorld && h.summary() !== null && !h.canJoin());
  check('locks: the room took the driver\'s single-game lock ON MAIN', active.includes('+user-1'), active.join(','));
  // finish it: the test seam pumps it to the buzzer and through the settle inside the worker
  await pool.advanceForTest(h, 800, true);
  await until(() => outcomes.length > 0 && s.got.some((m) => m.t === 'recordResult'));
  check('finalize: matchResult (with the replay) reached the socket', s.got.some((m) => m.t === 'matchResult' && !!(m as { replay?: unknown }).replay));
  check('finalize: onResult ran ON MAIN with the authoritative outcome', outcomes.length === 1 && outcomes[0].participants[0]?.userId === 'user-1', `${outcomes.length}`);
  check('finalize: the persist answer went BACK to the room, which revealed it (recordResult)', s.got.some((m) => m.t === 'recordResult'), s.got.slice(-6).map((m) => m.t).join(','));
  check('finalize: the lock was released on main', active.includes('-user-1'), active.join(','));
  h.detach('p1', s.client.conn, true);
  await until(() => emptied);
  check('teardown: a clean leave emptied the room and main\'s onEmpty ran', emptied);
}

// ═══ 2. RECONNECT / REATTACH ════════════════════════════════════════════════════════════
{
  const h = pool.createRoom('rec-w2', () => {}, { kind: 'record', record: 'solo', game: 'chain' });
  const a = sock('p2');
  h.add(a.client);
  await until(() => a.got.some((m) => m.t === 'welcome'));
  const token = (a.got.find((m) => m.t === 'welcome') as { seatToken?: string } | undefined)?.seatToken;
  h.onMessage('p2', { t: 'start' });
  await until(() => a.raw.some((x) => x.startsWith('{"t":"snapshot"')));
  // the socket drops (not clean): the seat is held
  h.detach('p2', a.client.conn, false);
  await sleep(100);
  const b = sock('p2');
  const nc = await h.reattach('p2', b.client.send, b.client.sendRaw, b.client.backlog, token, false);
  check('reattach: a held seat is reclaimed across the thread boundary (a fresh conn key)', typeof nc === 'number' && nc !== a.client.conn, String(nc));
  await until(() => b.got.some((m) => m.t === 'rejoined') && b.raw.some((x) => x.startsWith('{"t":"snapshot"')));
  check('reattach: the new socket got welcome + rejoined + a full resync snapshot', b.got.some((m) => m.t === 'welcome') && b.got.some((m) => m.t === 'rejoined' && (m as { ok: boolean }).ok));
  const before = a.raw.length;
  await sleep(300);
  check('reattach: the dropped socket is not sent anything any more', a.raw.length === before);
  // the OLD socket's late close must not knock the reclaimed seat offline
  h.detach('p2', a.client.conn, false);
  const n0 = b.raw.length;
  await sleep(300);
  check('reattach: a superseded socket closing late is ignored (the new one keeps streaming)', b.raw.length > n0 + 5, `${b.raw.length - n0}`);
  const bad = await h.reattach('p2', () => {}, () => {}, () => 0, 'not-the-token', false);
  check('reattach: a wrong seat token is refused (null), as in-process', bad === null);
  h.detach('p2', nc ?? 0, true);
}

// ═══ 3. CAPACITY: A STALE MIRROR CAN ONLY REFUSE, NEVER DOUBLE-ADMIT ═════════════════════
{
  const h = pool.createRoom('rec-w3', () => {}, { kind: 'record', record: 'solo', game: 'decode' });
  const one = sock('c1');
  const two = sock('c2');
  let refused = false;
  h.add(one.client);
  // same turn: main's mirror still says "joinable" — exactly the race
  check('capacity: the mirror has not seen the first add yet (the race is real)', h.canJoin());
  h.add(two.client, { onRefused: () => (refused = true) });
  await until(() => refused);
  check('capacity: the worker refused the second driver of a solo room', refused);
  check('capacity: ...with the door\'s own sentence', two.got.some((m) => m.t === 'error' && /full|running/.test((m as { message: string }).message)));
  h.detach('c1', one.client.conn, true);
}

// ═══ 4. A WORKER CRASH TAKES ONLY ITS OWN ROOMS ═════════════════════════════════════════
{
  const rooms: { h: RoomHandle; s: ReturnType<typeof sock>; evicted: boolean; emptied: boolean }[] = [];
  for (let i = 0; i < 4; i++) {
    const s = sock('k' + i, 'ku' + i);
    const rec = { h: null as unknown as RoomHandle, s, evicted: false, emptied: false };
    rec.h = pool.createRoom('rec-k' + i, () => (rec.emptied = true), { kind: 'record', record: 'solo', game: 'decode' }, undefined, () => {}, () => {});
    rec.h.add(s.client, { onEvicted: () => (rec.evicted = true) });
    rec.h.onMessage('k' + i, { t: 'start' });
    rooms.push(rec);
  }
  await until(() => rooms.every((r) => r.s.raw.some((x) => x.startsWith('{"t":"snapshot"'))));
  const victim = pool.workerOf(rooms[0].h);
  const onVictim = rooms.filter((r) => pool.workerOf(r.h) === victim);
  const others = rooms.filter((r) => pool.workerOf(r.h) !== victim);
  check('crash: rooms were spread across both workers (least-loaded placement)', onVictim.length > 0 && others.length > 0, `${onVictim.length}/${others.length}`);
  await pool.crashWorkerForTest(victim);
  await until(() => onVictim.every((r) => r.evicted) && pool.respawns === 1);
  check('crash: every room on the dead worker told its socket (error frame) and evicted it', onVictim.every((r) => r.evicted && r.s.got.some((m) => m.t === 'error')));
  check('crash: ...and left the directory (main\'s onEmpty ran for each)', onVictim.every((r) => r.emptied));
  const counts = others.map((r) => r.s.raw.length);
  await sleep(400);
  check('crash: rooms on the OTHER worker kept streaming', others.every((r, i) => r.s.raw.length > counts[i] + 5));
  check('crash: a replacement worker was started', pool.respawns === 1 && pool.load().length === 2);
  await pool.ready();
  const s = sock('after');
  const h = pool.createRoom('rec-after', () => {}, { kind: 'record', record: 'solo', game: 'decode' });
  h.add(s.client);
  await until(() => s.got.some((m) => m.t === 'welcome'));
  check('crash: the pool keeps serving new rooms after the replacement', s.got.some((m) => m.t === 'welcome'));
  for (const r of others) r.h.detach(r.s.client.id, r.s.client.conn, true);
  h.detach('after', s.client.conn, true);
}

// ═══ 5. SAME BYTES AS IN-PROCESS ═════════════════════════════════════════════════════════
// The worker encodes what main would have: a roster/welcome sent through `send` arrives as the
// same JSON an in-process room writes. (Snapshots are covered by "snapshot wire:" in npm test —
// the encoder is the same module on either thread.)
{
  const local = new Room('rec-same', () => {}, { kind: 'record', record: 'solo', game: 'decode' });
  const ls = sock('same');
  local.add(ls.client);
  const h = pool.createRoom('rec-same', () => {}, { kind: 'record', record: 'solo', game: 'decode' });
  const ws = sock('same');
  h.add(ws.client);
  await until(() => ws.raw.length >= ls.raw.length);
  const strip = (x: string): string => x.replace(/"seatToken":"[^"]+"/, '"seatToken":"*"');
  check('bytes: the worker room\'s first frames are byte-identical to an in-process room\'s', ws.raw.slice(0, ls.raw.length).map(strip).join('\n') === ls.raw.map(strip).join('\n'), `${ls.raw.length} frames`);
  h.detach('same', ws.client.conn, true);
}

await pool.close();
console.log(failures === 0 ? `\nALL PASS (${passes} checks)` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
