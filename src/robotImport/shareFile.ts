/**
 * ROBOT IMPORT — THE SHARE FILE (plan §3.3). One `.glb` that any glTF viewer opens and that
 * carries the DSIM setup in `asset.extras.dsim`, so importing it restores the robot with no
 * wizard. No three.js: the GLB container is edited at the byte level.
 *
 * GLB 2.0 layout (glTF 2.0 spec, "Binary glTF Layout"): a 12-byte header (magic `glTF`,
 * version 2, total length), then chunks of [u32 length, u32 type, data]. The JSON chunk comes
 * first and is padded with SPACES to a 4-byte boundary; the BIN chunk is padded with ZEROS. All
 * integers little-endian. Editing the JSON therefore means re-padding it and rewriting the two
 * lengths; every chunk after it is copied byte for byte, which keeps their alignment.
 */
import type { GameId, RobotSpec } from '../types';
import type { ImportSetup } from './types';

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const HEADER = 12;
const GAMES: readonly GameId[] = ['decode', 'chain', 'biobuzz'];
/** a robot name longer than this is not one the editor wrote */
const MAX_NAME = 64;

export const SHARE_FORMAT = 'dsim-robot';
export const SHARE_VERSION = 1;

export interface SharePayload {
  format: typeof SHARE_FORMAT;
  v: typeof SHARE_VERSION;
  game: GameId;
  spec: RobotSpec;
  setup: ImportSetup;
  name: string;
}

export type ShareReadError =
  | 'too-short'
  | 'not-glb'
  | 'bad-version'
  | 'bad-length'
  | 'bad-chunk'
  | 'bad-json'
  | 'not-dsim'
  | 'newer-version'
  | 'bad-payload';

export type ShareReadResult =
  | { ok: true; payload: SharePayload; json: Record<string, unknown> }
  | { ok: false; error: ShareReadError; message: string };

interface Parsed {
  json: Record<string, unknown>;
  /** byte offset of the first chunk after the JSON one */
  restAt: number;
  total: number;
}

const fail = (error: ShareReadError, message: string): { ok: false; error: ShareReadError; message: string } => ({ ok: false, error, message });

function parseGlb(bytes: Uint8Array): Parsed | { ok: false; error: ShareReadError; message: string } {
  if (bytes.byteLength < HEADER + 8) return fail('too-short', 'Couldn’t read this file: it is too short to be a .glb. Export it again and retry.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return fail('not-glb', 'Couldn’t read this file: it is not a binary glTF (.glb).');
  if (dv.getUint32(4, true) !== 2) return fail('bad-version', 'Couldn’t read this file: only glTF 2.0 .glb files are supported.');
  const total = dv.getUint32(8, true);
  if (total > bytes.byteLength || total < HEADER + 8 || total % 4 !== 0) {
    return fail('bad-length', 'Couldn’t read this file: it is cut short or damaged. Download it again.');
  }
  const jsonLen = dv.getUint32(HEADER, true);
  const jsonType = dv.getUint32(HEADER + 4, true);
  if (jsonType !== CHUNK_JSON || jsonLen % 4 !== 0 || HEADER + 8 + jsonLen > total) {
    return fail('bad-chunk', 'Couldn’t read this file: its first chunk is not glTF JSON.');
  }
  // every chunk after the JSON one must tile the rest of the file exactly
  let at = HEADER + 8 + jsonLen;
  const restAt = at;
  while (at < total) {
    if (at + 8 > total) return fail('bad-chunk', 'Couldn’t read this file: a chunk runs past the end.');
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    if (len % 4 !== 0 || at + 8 + len > total || (type === CHUNK_JSON)) {
      return fail('bad-chunk', 'Couldn’t read this file: a chunk is damaged.');
    }
    at += 8 + len;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER + 8, HEADER + 8 + jsonLen)));
  } catch {
    return fail('bad-json', 'Couldn’t read this file: its glTF JSON is damaged.');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return fail('bad-json', 'Couldn’t read this file: its glTF JSON is not an object.');
  return { json: json as Record<string, unknown>, restAt, total };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** the `asset.extras.dsim` block of a GLB, validated for shape (the spec is coerced by the caller) */
export function readShareFile(input: ArrayBuffer | Uint8Array): ShareReadResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const parsed = parseGlb(bytes);
  if ('ok' in parsed) return parsed;
  const asset = parsed.json.asset;
  const dsim = isObj(asset) && isObj(asset.extras) ? asset.extras.dsim : undefined;
  if (!isObj(dsim) || dsim.format !== SHARE_FORMAT) {
    return fail('not-dsim', 'This .glb has no DSIM setup in it, so it opens in the import editor.');
  }
  if (typeof dsim.v !== 'number' || dsim.v > SHARE_VERSION) {
    return fail('newer-version', 'This robot was exported by a newer version of DSIM. Reload the page and try again.');
  }
  if (dsim.v !== SHARE_VERSION) return fail('bad-payload', 'Couldn’t read this robot’s setup: its version is not one DSIM wrote.');
  if (typeof dsim.game !== 'string' || !GAMES.includes(dsim.game as GameId)) {
    return fail('bad-payload', 'Couldn’t read this robot’s setup: it names a game DSIM doesn’t have.');
  }
  if (!isObj(dsim.spec) || !isObj(dsim.setup)) return fail('bad-payload', 'Couldn’t read this robot’s setup: the robot or its setup is missing.');
  if (typeof dsim.name !== 'string' || dsim.name.length > MAX_NAME) return fail('bad-payload', 'Couldn’t read this robot’s setup: its name is missing or too long.');
  return {
    ok: true,
    json: parsed.json,
    payload: {
      format: SHARE_FORMAT,
      v: SHARE_VERSION,
      game: dsim.game as GameId,
      spec: dsim.spec as unknown as RobotSpec,
      setup: dsim.setup as unknown as ImportSetup,
      name: dsim.name,
    },
  };
}

/**
 * A copy of `glb` whose JSON carries `asset.extras.dsim = payload` (and whatever else `extras`
 * already held). Throws on a GLB that is not well formed — the input is always the engine's own
 * bake, so a throw here is a bug, not a user error.
 */
export function writeShareFile(glb: ArrayBuffer | Uint8Array, payload: Omit<SharePayload, 'format' | 'v'>): Uint8Array {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const parsed = parseGlb(bytes);
  if ('ok' in parsed) throw new Error(`writeShareFile: ${parsed.message}`);
  const json = parsed.json;
  const asset: Record<string, unknown> = isObj(json.asset) ? { ...json.asset } : { version: '2.0' };
  const extras = isObj(asset.extras) ? { ...asset.extras } : {};
  extras.dsim = { format: SHARE_FORMAT, v: SHARE_VERSION, game: payload.game, spec: payload.spec, setup: payload.setup, name: payload.name };
  asset.extras = extras;
  const text = new TextEncoder().encode(JSON.stringify({ ...json, asset }));
  const padded = (text.length + 3) & ~3;
  const rest = bytes.subarray(parsed.restAt, parsed.total);
  const total = HEADER + 8 + padded + rest.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(HEADER, padded, true);
  dv.setUint32(HEADER + 4, CHUNK_JSON, true);
  out.set(text, HEADER + 8);
  out.fill(0x20, HEADER + 8 + text.length, HEADER + 8 + padded);
  out.set(rest, HEADER + 8 + padded);
  return out;
}

/**
 * A minimal valid GLB around a JSON object and an optional BIN payload — the shape the tests and
 * the dev harness build fixtures with. Not used to bake (GLTFExporter does that).
 */
export function buildGlb(json: Record<string, unknown>, bin?: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = (text.length + 3) & ~3;
  const bl = bin ? (bin.length + 3) & ~3 : 0;
  const total = HEADER + 8 + jl + (bin ? 8 + bl : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(HEADER, jl, true);
  dv.setUint32(HEADER + 4, CHUNK_JSON, true);
  out.set(text, HEADER + 8);
  out.fill(0x20, HEADER + 8 + text.length, HEADER + 8 + jl);
  if (bin) {
    const at = HEADER + 8 + jl;
    dv.setUint32(at, bl, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);
  }
  return out;
}
