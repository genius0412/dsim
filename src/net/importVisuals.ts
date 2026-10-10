/**
 * IMPORTED ROBOT VISUALS RELAY — what both halves of the wire share (docs/area/netcode.md,
 * VISUALS RELAY). DOM-free, no three.js, no `node:` imports: `server/room.ts` is bundled for the
 * browser (the LAN host runs a `Room` in a tab), the Room's relay (`server/importVisuals.ts`)
 * imports this, and so does the client (`src/net/importVisualsClient.ts`).
 *
 * An imported robot's footprint rides the spec (`RobotSpec.imported`) to everyone. Its LOOK — a
 * top-down picture (every viewer, 2D is the default view) and a GLB mesh (BIOBUZZ's 3D view only)
 * — lives on the owner's device, so a custom or LAN room relays it: the owner uploads in chunks,
 * the ROOM holds the bytes in memory for its own life, and a viewer fetches only what it asks for.
 *
 * ⚠️ ONE FRAME CARRIES AT MOST `VISUAL_CHUNK_BYTES` OF PAYLOAD, base64 in a JSON frame. The server
 * drops a frame over 64 KiB (`WS_MAX_PAYLOAD`), the LAN DataChannel's default message size is 64 KiB
 * too, and a socket past 240 messages a second is rate-limited, so a chunk is 24 KiB (32 KiB of
 * base64) and the owner is paced at `VISUAL_UPLOAD_GAP_MS`.
 */

/** advertised by clients on `join`/`rejoin`/`spectate` (`CLIENT_CAPS`) and by the server on
 *  `/api/presence` (`SERVER_CAPS`). A build without it is sent none of these messages and its
 *  own are ignored. It degrades: a viewer without it sees the footprint, as before. */
export const IMPORT_VISUALS_CAP = 'importVisuals';

/** does a client advertising `caps` take part in the relay? */
export function hasVisualsCap(caps: readonly string[] | undefined): boolean {
  return !!caps?.includes(IMPORT_VISUALS_CAP);
}

export type VisualKind = 'top' | 'mesh';
export const VISUAL_KINDS: readonly VisualKind[] = ['top', 'mesh'];
export const isVisualKind = (x: unknown): x is VisualKind => x === 'top' || x === 'mesh';

/** `ImportedRobot.id`: 16 lowercase hex chars (`src/robotImport/library.ts` `ROBOT_ID_RX`) */
export const VISUAL_ID_RX = /^[0-9a-f]{16}$/;

// ---- the limits ---------------------------------------------------------------------------

/** the largest asset of each kind, raw bytes. The library's own mesh may be 4 MB; a bigger one is
 *  made lighter (`liteMesh`, `src/robotImport/engine/lite.ts`) or not relayed at all. */
export const VISUAL_MAX_BYTES: Readonly<Record<VisualKind, number>> = { top: 256 * 1024, mesh: 1024 * 1024 };

/** raw payload bytes per frame. 24 KiB is exactly 32,768 base64 characters, so a frame is about
 *  33 KB of JSON: half the 64 KiB frame cap, and under the DataChannel's 64 KiB default. */
export const VISUAL_CHUNK_BYTES = 24 * 1024;
export const VISUAL_CHUNK_CHARS = (VISUAL_CHUNK_BYTES / 3) * 4;

/** a room holds this many robots' worth: the four seats × (a mesh and a top picture) */
export const VISUAL_ROOM_OWNERS = 4;
export const VISUAL_ROOM_BYTES = VISUAL_ROOM_OWNERS * (VISUAL_MAX_BYTES.top + VISUAL_MAX_BYTES.mesh);
/** every room on one machine, all threads together */
export const VISUAL_PROCESS_BYTES = 64 * 1024 * 1024;
/**
 * What ONE SOURCE (an account, else an address: `Client.budgetKey`) may hold of the process
 * budget, every room and thread together: eight seats' full sets. Without it about 52 sockets held
 * the whole 64 MiB. A venue behind one address with more than eight anonymous imported robots gets
 * outlines for the rest; a signed-in driver is its own source.
 */
export const VISUAL_SOURCE_BYTES = 8 * (VISUAL_MAX_BYTES.top + VISUAL_MAX_BYTES.mesh);

/**
 * The serve caps are RATES over a rolling minute, not totals for the room's life. A lifetime room
 * total ran out after about nine viewer sessions in a busy room, after which nobody new saw a
 * robot's look; and a per-client-id total reset whenever a watcher came back under a new id.
 *  - one viewer SOURCE (account, else address) may be sent 8 MiB a minute: a full room's assets
 *    once and a retry or two;
 *  - the whole room 24 MiB a minute (about 400 KB/s): five full viewer loads a minute.
 * Egress is the bill, so both are charged in full when a request is accepted.
 */
export const VISUAL_SERVE_WINDOW_MS = 60_000;
export const VISUAL_SERVE_CLIENT_BYTES = 8 * 1024 * 1024;
export const VISUAL_SERVE_ROOM_BYTES = 24 * 1024 * 1024;
/** concurrent downloads per viewer: a top and a mesh for each of four owners */
export const VISUAL_STREAMS_PER_CLIENT = 8;

/** an upload that has gone quiet this long is dropped (and its reservation with it) */
export const VISUAL_PUT_STALE_MS = 60_000;
/** how often a room with an upload open sweeps for quiet ones (a timer, not the next upload) */
export const VISUAL_SWEEP_EVERY_MS = VISUAL_PUT_STALE_MS / 4;

// ---- pacing -------------------------------------------------------------------------------

/**
 * The owner sends a frame every this many ms: 33 frames a second against a 240-a-second bucket,
 * with the 60 Hz input stream beside it (`MSG_RATE_LIMIT`). A 1 MiB mesh is 43 frames, about 1.3 s.
 */
export const VISUAL_UPLOAD_GAP_MS = 30;

/** the room's download pump runs this often */
export const VISUAL_STREAM_TICK_MS = 20;
/** a socket with more than this queued (`ws.bufferedAmount`; on a worker room, the mirror of it,
 *  which reports from 16 KiB up) is not handed another chunk. Well under `SNAP_BACKLOG_BYTES`
 *  (256 KB), because a snapshot that finds its socket backed up is skipped and the next one is a
 *  full keyframe — a download must never be what causes that. */
export const VISUAL_STREAM_BACKLOG_BYTES = 40 * 1024;
/** while a match is being played a viewer's stream is held to one chunk per this many ms
 *  (about 240 KB/s), so a late spectator's download cannot crowd out its snapshots */
export const VISUAL_STREAM_LIVE_GAP_MS = 100;

/** frames a payload of `total` bytes takes */
export const visualFrames = (total: number): number => Math.ceil(total / VISUAL_CHUNK_BYTES);

/** the byte range chunk `seq` of a `total`-byte asset covers */
export function visualSpan(total: number, seq: number): { start: number; end: number } {
  const start = seq * VISUAL_CHUNK_BYTES;
  return { start, end: Math.min(total, start + VISUAL_CHUNK_BYTES) };
}

/**
 * MAY THE ROOM WRITE A VIEWER'S NEXT CHUNK NOW? The one pacing rule, pure so a check can pin it.
 * `backlog` is undefined for a socket the room cannot read (the LAN tab host's DataChannel, a
 * test): those are paced by time alone, one chunk per pump.
 */
export function streamMayWrite(o: { backlog: number | undefined; now: number; lastAt: number; live: boolean }): boolean {
  if (o.backlog !== undefined && o.backlog >= VISUAL_STREAM_BACKLOG_BYTES) return false;
  if (o.live && o.now - o.lastAt < VISUAL_STREAM_LIVE_GAP_MS) return false;
  return true;
}

// ---- base64 -------------------------------------------------------------------------------

type NodeBuffer = {
  from(data: ArrayBuffer | Uint8Array | string, enc?: string | number, len?: number): Uint8Array & { toString(enc: string, start?: number, end?: number): string };
};
const NODE_BUFFER = (globalThis as { Buffer?: NodeBuffer }).Buffer;

/** `bytes[start, end)` as base64 */
export function bytesToBase64(bytes: Uint8Array, start = 0, end = bytes.length): string {
  if (NODE_BUFFER) return NODE_BUFFER.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString('base64', start, end);
  let s = '';
  // 8 KiB at a time: String.fromCharCode(...args) has an argument limit
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
  return btoa(s);
}

const B64_RX = /^[A-Za-z0-9+/]*={0,2}$/;

/** base64 → bytes, or null when `s` is not well-formed base64 (Node's decoder is forgiving:
 *  it would skip a stray character, and this is attacker-controlled input) */
export function base64ToBytes(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64_RX.test(s)) return null;
  if (NODE_BUFFER) return new Uint8Array(NODE_BUFFER.from(s, 'base64'));
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---- refusals -----------------------------------------------------------------------------------

export type VisualRefusal = 'room' | 'id' | 'size' | 'format' | 'budget' | 'seq' | 'dup' | 'none' | 'busy';

/** plain sentences (docs/area/ui.md): what happened, and what the viewer sees instead */
export const VISUAL_REFUSAL_COPY: Readonly<Record<VisualRefusal, string>> = {
  room: 'Couldn’t share your robot’s look here. Only custom and LAN rooms show imported robots. Others see its outline.',
  id: 'Couldn’t share your robot’s look. It doesn’t match the robot you picked. Others see its outline.',
  size: 'Couldn’t share your robot’s look. The file is too large to send. Others see its outline.',
  format: 'Couldn’t share your robot’s look. The file isn’t a picture or model the room can use. Others see its outline.',
  budget: 'Couldn’t share your robot’s look. This room is out of space for it. Others see its outline.',
  seq: 'Couldn’t share your robot’s look. The upload was interrupted. Others see its outline.',
  dup: 'Couldn’t share your robot’s look. Another driver here already uses a robot with the same id. Others see its outline.',
  none: 'That robot’s look isn’t available. It is shown as an outline.',
  busy: 'Couldn’t download that robot’s look right now. It is shown as an outline.',
};
