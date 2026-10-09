/**
 * THE VISUALS RELAY, CLIENT SIDE (docs/area/netcode.md, VISUALS RELAY; wire rules in
 * `importVisuals.ts`).
 *
 * Two jobs on one connection:
 *
 *  · OWNER. This seat holds an imported robot, the room's server relays (`importVisuals` in
 *    `SERVER_CAPS`), so after the roster says so this uploads the robot's top picture — and, in a
 *    game with a 3D view, its mesh — in paced 24 KiB chunks. The mesh is the library's if it fits
 *    the relay's 1 MiB and the room's validator takes it (a float GLB from before the store was
 *    compressed), else a float copy made once by the importer engine and cached on the library
 *    record; if even that does not fit, the picture alone goes.
 *  · VIEWER. Another seat's robot is imported and the room says its assets are ready: ask for the
 *    picture (and, in BIOBUZZ with the 3D view on, the mesh), reassemble it, VALIDATE IT AGAIN (the
 *    same checks the room made: bytes off the wire are untrusted, and on a LAN they come from
 *    another player's tab), and hand it to the renderers through `importedAssetsBridge.ts`. A device
 *    that turned "Show other players’ imported robots" off asks for nothing, and a viewer that is
 *    refused or times out keeps the footprint.
 *
 * ⚠️ ONE SESSION OUTLIVES BOTH CONNECTION OWNERS. `LobbyClient` hands its transport to
 * `ServerSession` at `matchStart` and back at a recycle, and both call into the one `importVisuals`
 * below. Binding the SAME transport keeps the state; a different one is a different room and starts
 * clean.
 *
 * ⚠️ NOTHING IS SENT TO A SERVER THAT DID NOT SAY IT HOLDS THE RELAY (`setOffered`), and nothing
 * here is sent per tick: an upload is at most a couple of dozen frames, once.
 */
import type { GameId } from '../types';
import { loadImporterEngine } from '../robotImport/engineLoader';
import { getViewPref, subscribeViewPref } from '../games/biobuzz/graphics/store';
import { registerRelayedAsset, hasRelayedAsset, relayedIdTakenByOther, unregisterRelayedAssets } from './importedAssetsBridge';
import {
  VISUAL_ID_RX,
  VISUAL_MAX_BYTES,
  VISUAL_UPLOAD_GAP_MS,
  base64ToBytes,
  bytesToBase64,
  isVisualKind,
  visualFrames,
  visualSpan,
  type VisualKind,
  type VisualRefusal,
} from './importVisuals';
import { sameImportedRobot } from '../robotImport/libraryIds';
import type { ImportedRobot } from '../types';
import { getShowOthersImported, subscribeShowOthersImported } from './importVisualsPref';
import { encodeMsg, type LobbyPlayer, type ServerMsg } from './protocol';
import type { Transport } from './transport';

/**
 * THE VALIDATORS ARE FETCHED THE FIRST TIME A LOOK NEEDS CHECKING (`visualCheck.ts`). A client that
 * never uploads an imported robot's look and is never sent one never needs them, and they are
 * ~12 KB of the entry chunk when they are imported. A load that fails is a failed check: the look
 * is not used and the footprint stays, which is where every refusal here already ends up.
 */
type VisualCheck = typeof import('./visualCheck');
let checkModule: VisualCheck | null = null;
let checkLoading: Promise<VisualCheck | null> | null = null;
function loadCheck(): Promise<VisualCheck | null> {
  if (checkModule) return Promise.resolve(checkModule);
  checkLoading ??= import('./visualCheck').then(
    (m) => (checkModule = m),
    () => {
      checkLoading = null; // a later look may find the network back
      return null;
    },
  );
  return checkLoading;
}

const REFUSALS: readonly VisualRefusal[] = ['room', 'id', 'size', 'format', 'budget', 'seq', 'dup', 'none', 'busy'];
const isVisualRefusal = (x: unknown): x is VisualRefusal => REFUSALS.includes(x as VisualRefusal);

/** where the owner's own bytes come from: the device library, or a test */
export interface OwnAssets {
  top(id: string): Promise<Uint8Array | null>;
  /** already small enough for the relay, or null (the picture alone is shared) */
  mesh(id: string): Promise<Uint8Array | null>;
  /** does this device hold a robot with this id itself? Then a relayed look is never lent for it:
   *  the device's own copy is what it draws (absent ⇒ no). With `imp`, only a copy of THAT version
   *  counts: an out-of-date copy is not drawn (`render/importedAssets.ts`), so the relayed look is */
  has?(id: string, imp?: ImportedRobot): Promise<boolean>;
  /** the descriptor of the robot this device's assets for `id` were made for (null: none). An
   *  owner uploads only a look made for the robot its seat holds (absent ⇒ not compared) */
  describe?(id: string): Promise<ImportedRobot | null>;
}

/**
 * WHY THIS SEAT'S OWN LOOK IS NOT REACHING THE ROOM, for the one line the custom-room lobby shows
 * (`Lobby.tsx`, in place of the robot's build line, so nothing moves). A room refusal (`budget`,
 * `format`, `dup`, ...), an upload the room never confirmed, a model this device does not have, or one
 * that is out of date here. Null while the look is on its way, shared, or not this seat's business.
 */
export interface OwnLookTrouble {
  kind: VisualKind;
  reason: VisualRefusal | 'missing' | 'stale';
}

/** the line for `OwnLookTrouble` (docs/area/ui.md copy rules: what failed, and why, in one line) */
export function ownLookLine(t: OwnLookTrouble): string {
  const what = t.kind === 'mesh' ? 'Couldn’t share your 3D model' : 'Couldn’t share your robot’s look';
  switch (t.reason) {
    case 'budget':
      return `${what}: this room is out of space.`;
    case 'format':
    case 'size':
      return `${what}: the room can’t use the file.`;
    case 'dup':
      return `${what}: another robot here has its id.`;
    case 'missing':
      return `${what}: it isn’t on this device.`;
    case 'stale':
      return `${what}: the copy here is out of date.`;
    default:
      return `${what}: the upload didn’t finish.`;
  }
}

/**
 * the library, with the importer engine making (once, cached) a lighter mesh when the stored one is
 * over the cap.
 *
 * ⚠️ THE LIBRARY IS REACHED BY `import()`, NOT IMPORTED: this file is in the entry chunk (the lobby
 * and the match session both hold the client), and a static import dragged the whole IndexedDB
 * layer into the chunk every player downloads, for a read that happens only once a seat holds an
 * imported robot. The renderers' asset seam (`render/importedAssets.ts`) reaches it the same way,
 * so there is one shared `library-*.js` chunk, fetched on first use.
 */
const library = (): Promise<typeof import('../robotImport/library')> => import('../robotImport/library');
export const libraryOwnAssets: OwnAssets = {
  async has(id, imp) {
    try {
      const lib = await library();
      if (!(await lib.topFor(id))) return false;
      return !imp || sameImportedRobot(await lib.descriptorFor(id), imp);
    } catch {
      return false;
    }
  },
  async describe(id) {
    try {
      return await (await library()).descriptorFor(id);
    } catch {
      return null;
    }
  },
  async top(id) {
    const b = await (await library()).topFor(id);
    return b ? new Uint8Array(await b.arrayBuffer()) : null;
  },
  async mesh(id) {
    const lib = await library();
    const full = await lib.meshFor(id);
    if (!full) return null;
    // the stored mesh goes as it is only when the room would take it: a mesh saved since the store
    // was compressed (quantised, meshopt) never is, however small, so it is re-written as float
    if (full.size <= VISUAL_MAX_BYTES.mesh) {
      const bytes = new Uint8Array(await full.arrayBuffer());
      if ((await loadCheck())?.validateMeshGlb(bytes) === null) return bytes;
    }
    const cached = await lib.meshLiteFor(id);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
    try {
      const engine = await loadImporterEngine();
      const out = await engine.liteMesh(await full.arrayBuffer(), VISUAL_MAX_BYTES.mesh);
      if (!out) return null;
      void lib.putMeshLite(id, new Blob([out], { type: 'model/gltf-binary' }));
      return new Uint8Array(out);
    } catch {
      return null;
    }
  },
};

/** does this game draw a robot's mesh anywhere? (BIOBUZZ's 3D view; DECODE and Chain Reaction are 2D) */
export const gameHasMeshView = (game: GameId): boolean => game === 'biobuzz';

const SETTLE_MS = 250;
/** an upload that is not confirmed or refused this long after its last frame is given up on */
const CONFIRM_MS = 10_000;
/** a download that has made no progress this long is dropped (and asked for once more) */
const STALL_MS = 10_000;
/** how many times one asset is asked for before this client settles for the footprint */
const MAX_ASKS = 2;

interface Upload {
  id: string;
  kind: VisualKind;
  timer: ReturnType<typeof setTimeout> | null;
  /** has the last frame gone? */
  sent: boolean;
}
interface Incoming {
  owner: string;
  id: string;
  kind: VisualKind;
  total: number;
  next: number;
  got: number;
  buf: Uint8Array | null;
  lastAt: number;
}

export interface ImportVisualsOptions {
  own?: OwnAssets;
  /** ms to wait after a roster/ready burst before acting on it (a rejoin's `visualReady` follows its roster) */
  settleMs?: number;
  /** does this viewer want meshes? default: BIOBUZZ with the 3D view on */
  meshWanted?: () => boolean;
  /** is the "show other players’ imported robots" preference on? */
  showOthers?: () => boolean;
}

export class ImportVisualsClient {
  private tx: Transport | null = null;
  private offered = false;
  private game: GameId = 'decode';
  private selfId = '';
  /** the robot id this seat holds (from the roster), or null */
  private ownId: string | null = null;
  /** ...and the robot itself, as the room has it (an owner uploads only a look made for it) */
  private ownImp: ImportedRobot | null = null;
  /** other seats' imported robots: owner client id → robot id */
  private readonly roster = new Map<string, string>();
  /** ...and each one's descriptor, so a stale copy in this device's library does not stand in for it */
  private readonly rosterImp = new Map<string, ImportedRobot>();
  /** why this seat's own look is not in the room (`OwnLookTrouble`), and who wants to know */
  private trouble: OwnLookTrouble | null = null;
  private readonly troubleListeners = new Set<() => void>();
  /** what the room says it holds: `${owner}|${kind}` → robot id */
  private readonly ready = new Map<string, string>();
  /** this seat's own assets the room has confirmed: `${id}|${kind}` */
  private readonly mine = new Set<string>();
  /** this seat's own assets not worth trying again: `${id}|${kind}` */
  private readonly noUpload = new Set<string>();
  private readonly uploadTries = new Map<string, number>();
  private upload: Upload | null = null;
  private readonly incoming = new Map<string, Incoming>();
  private readonly asks = new Map<string, number>();
  private settle: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private readonly own: OwnAssets;
  private readonly settleMs: number;
  private readonly meshWanted: () => boolean;
  private readonly showOthers: () => boolean;
  /** robot ids this session handed to the renderers, so leaving the room takes them back */
  private readonly delivered = new Set<string>();

  constructor(opts: ImportVisualsOptions = {}) {
    this.own = opts.own ?? libraryOwnAssets;
    this.settleMs = opts.settleMs ?? SETTLE_MS;
    this.meshWanted = opts.meshWanted ?? (() => gameHasMeshView(this.game) && getViewPref() === '3d');
    this.showOthers = opts.showOthers ?? getShowOthersImported;
  }

  // ---- the connection ----------------------------------------------------------------------

  /** this is the connection the room is on. The same transport keeps the state (a hand-off between
   *  the lobby and the match); another one is another room, so everything starts again. */
  bind(tx: Transport): void {
    if (this.tx === tx) return;
    this.reset();
    this.tx = tx;
  }

  /** the connection is being closed by its owner: forget the room if it is still ours */
  release(tx: Transport): void {
    if (this.tx === tx) this.reset();
  }

  /** does this room's server hold the relay? Only then does an owner upload. */
  setOffered(offered: boolean): void {
    if (this.offered === offered) return;
    this.offered = offered;
    this.poke();
  }

  setGame(game: GameId): void {
    if (this.game === game) return;
    this.game = game;
    this.poke();
  }

  /** the server (re)seated this client: it holds nothing of ours that we have not heard it confirm */
  onWelcome(clientId: string): void {
    this.selfId = clientId;
    this.mine.clear();
    this.noUpload.clear();
    this.uploadTries.clear();
    this.cancelUpload();
    this.setTrouble(null);
    this.poke();
  }

  /** the roster changed: who holds an imported robot, and which */
  noteRoster(selfId: string, players: readonly LobbyPlayer[]): void {
    if (selfId) this.selfId = selfId;
    this.roster.clear();
    this.rosterImp.clear();
    const was = this.ownImp;
    this.ownId = null;
    this.ownImp = null;
    for (const p of players) {
      const imp = (p.spec as { imported?: ImportedRobot } | undefined)?.imported;
      const id = imp?.id;
      if (typeof id !== 'string' || !VISUAL_ID_RX.test(id)) continue;
      if (p.clientId === this.selfId) {
        this.ownId = id;
        this.ownImp = imp!;
      } else {
        this.roster.set(p.clientId, id);
        this.rosterImp.set(p.clientId, imp!);
      }
    }
    // an upload for a robot this seat no longer holds is a waste of the owner's frames
    if (this.upload && this.upload.id !== this.ownId) this.cancelUpload();
    // another robot (or none): what was said about the last one's look no longer applies
    if (!this.ownImp || !was || !sameImportedRobot(was, this.ownImp) || was.id !== this.ownImp.id) this.setTrouble(null);
    this.poke();
  }

  /** forget the room: stop sending, drop what is half received, give the renderers their blobs back */
  reset(): void {
    this.cancelUpload();
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
    this.stopWatchdog();
    this.tx = null;
    this.offered = false;
    this.selfId = '';
    this.ownId = null;
    this.ownImp = null;
    this.roster.clear();
    this.rosterImp.clear();
    this.ready.clear();
    this.mine.clear();
    this.noUpload.clear();
    this.uploadTries.clear();
    this.incoming.clear();
    this.asks.clear();
    this.dropDelivered();
    this.setTrouble(null);
  }

  private dropDelivered(): void {
    unregisterRelayedAssets(this.delivered);
    this.delivered.clear();
  }

  // ---- what the room says ------------------------------------------------------------------

  /** a `visual*` frame from the room (`LobbyClient` and `ServerSession` forward them here) */
  handle(m: ServerMsg): void {
    if (m.t === 'visualReady') this.onReady(m);
    else if (m.t === 'visualChunk') this.onChunk(m);
    else if (m.t === 'visualRefused') this.onRefused(m);
  }

  private onReady(m: Extract<ServerMsg, { t: 'visualReady' }>): void {
    if (typeof m.owner !== 'string' || !isVisualKind(m.kind) || typeof m.id !== 'string' || !VISUAL_ID_RX.test(m.id)) return;
    if (m.owner === this.selfId) {
      // the room holds our upload
      this.mine.add(`${m.id}|${m.kind}`);
      if (this.trouble?.kind === m.kind) this.setTrouble(null);
      if (this.upload && this.upload.id === m.id && this.upload.kind === m.kind) {
        this.cancelUpload();
        this.poke();
      }
      return;
    }
    this.ready.set(`${m.owner}|${m.kind}`, m.id);
    this.poke();
  }

  private onRefused(m: Extract<ServerMsg, { t: 'visualRefused' }>): void {
    if (!isVisualKind(m.kind)) return;
    if (m.op === 'put') {
      const key = `${m.id}|${m.kind}`;
      if (m.reason === 'seq' && (this.uploadTries.get(key) ?? 0) < 2) {
        // an interrupted upload (a lost frame on a LAN lane): start it over, twice at most
        this.uploadTries.set(key, (this.uploadTries.get(key) ?? 0) + 1);
      } else {
        this.noUpload.add(key);
        if (m.id === this.ownId) this.noteTrouble(m.kind, isVisualRefusal(m.reason) ? m.reason : 'seq');
      }
      if (this.upload && this.upload.id === m.id && this.upload.kind === m.kind) this.cancelUpload();
      this.poke();
      return;
    }
    // a download was refused: the footprint stays, and this is not asked for again
    const key = `${m.owner}|${m.kind}`;
    this.incoming.delete(key);
    this.asks.set(key, MAX_ASKS);
  }

  // ---- acting on it ------------------------------------------------------------------------

  /** something that may call for a request or an upload changed: look again, after the burst */
  poke(): void {
    if (this.settle || !this.tx) return;
    this.settle = setTimeout(() => {
      this.settle = null;
      this.act();
    }, this.settleMs);
  }

  /** the one place anything is decided */
  act(): void {
    if (!this.tx) return;
    this.maybeUpload();
    this.maybeRequest();
  }

  private ownKinds(): VisualKind[] {
    return gameHasMeshView(this.game) ? ['top', 'mesh'] : ['top'];
  }

  private maybeUpload(): void {
    const tx = this.tx;
    if (!tx || !this.offered || this.upload || !this.ownId) return;
    const id = this.ownId;
    for (const kind of this.ownKinds()) {
      const key = `${id}|${kind}`;
      if (this.mine.has(key) || this.noUpload.has(key)) continue;
      void this.startUpload(id, kind);
      return;
    }
  }

  private async startUpload(id: string, kind: VisualKind): Promise<void> {
    const key = `${id}|${kind}`;
    const up: Upload = { id, kind, timer: null, sent: false };
    this.upload = up;
    void loadCheck(); // in step with the library read below
    let bytes: Uint8Array | null = null;
    // ⚠️ ONLY A LOOK MADE FOR THE ROBOT THIS SEAT HOLDS: after an edit on another device this
    // device's library can hold the OLD model under the same id, and sending it would put the old
    // model on the new hull on every other screen (`render/importedAssets.ts` refuses it here too)
    const want = this.ownImp;
    let stale = false;
    try {
      if (want && this.own.describe) stale = !sameImportedRobot(await this.own.describe(id), want);
      if (!stale) bytes = kind === 'top' ? await this.own.top(id) : await this.own.mesh(id);
    } catch {
      bytes = null;
    }
    if (this.upload !== up) return; // cancelled while reading
    const check = bytes ? await loadCheck() : null;
    if (this.upload !== up) return; // cancelled while the validators loaded
    if (!bytes || !check || check.validateVisual(kind, bytes)) {
      // nothing to share (a robot opened on another device, an out-of-date copy, an unusable file):
      // the outline it is, and the lobby says why. A mesh too big even when made lighter is not
      // trouble: the picture is shared and the 3D view shows the placeholder.
      this.noUpload.add(key);
      this.upload = null;
      if (stale) this.noteTrouble(kind, 'stale');
      else if (kind === 'top' && !bytes) this.noteTrouble(kind, 'missing');
      else if (bytes) this.noteTrouble(kind, 'format');
      this.poke();
      return;
    }
    const total = bytes.length;
    const frames = visualFrames(total);
    let seq = 0;
    const sendNext = (): void => {
      up.timer = null;
      const tx = this.tx;
      if (this.upload !== up || !tx || !tx.isOpen || this.ownId !== id) {
        if (this.upload === up) this.cancelUpload();
        return;
      }
      const span = visualSpan(total, seq);
      tx.send(encodeMsg({ t: 'visualPut', kind, id, total, seq, data: bytesToBase64(bytes!, span.start, span.end) }));
      seq++;
      if (seq < frames) {
        up.timer = setTimeout(sendNext, VISUAL_UPLOAD_GAP_MS);
        return;
      }
      up.sent = true;
      // the room answers with `visualReady` (ours) or `visualRefused`; silence is a refusal
      up.timer = setTimeout(() => {
        if (this.upload !== up) return;
        this.noUpload.add(key);
        this.cancelUpload();
        this.noteTrouble(kind, 'seq');
      }, CONFIRM_MS);
    };
    sendNext();
  }

  private cancelUpload(): void {
    const up = this.upload;
    if (!up) return;
    if (up.timer) clearTimeout(up.timer);
    this.upload = null;
  }

  private wantedKinds(): VisualKind[] {
    return this.meshWanted() ? ['top', 'mesh'] : ['top'];
  }

  private maybeRequest(): void {
    const tx = this.tx;
    if (!tx || !tx.isOpen) return;
    if (!this.showOthers()) return;
    for (const [owner, id] of this.roster) {
      // ⚠️ never this seat's own robot id: a seat that claimed it cannot lend this viewer a look for it
      if (id === this.ownId) continue;
      for (const kind of this.wantedKinds()) {
        const key = `${owner}|${kind}`;
        if (this.ready.get(key) !== id) continue; // the room does not say it has this robot's asset
        // an asset is (owner, id): one this owner already lent, or an id another owner's look holds
        if (hasRelayedAsset(owner, id, kind) || relayedIdTakenByOther(owner, id) || this.incoming.has(key)) continue;
        const asked = this.asks.get(key) ?? 0;
        if (asked >= MAX_ASKS) continue;
        this.asks.set(key, asked + 1);
        this.incoming.set(key, { owner, id, kind, total: 0, next: 0, got: 0, buf: null, lastAt: Date.now() });
        tx.send(encodeMsg({ t: 'visualGet', owner, id, kind }));
        void loadCheck(); // the validators arrive while the room answers, so the first look is checked on the spot too
        this.startWatchdog();
      }
    }
  }

  private onChunk(m: Extract<ServerMsg, { t: 'visualChunk' }>): void {
    if (!isVisualKind(m.kind) || typeof m.owner !== 'string') return;
    const key = `${m.owner}|${m.kind}`;
    const inc = this.incoming.get(key);
    // only what was asked for, from the owner asked, for the robot the roster names
    if (!inc || inc.id !== m.id || !this.showOthers()) return;
    const total = m.total;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > VISUAL_MAX_BYTES[inc.kind]) return this.abort(key);
    if (m.seq === 0) {
      inc.total = total;
      inc.buf = new Uint8Array(total);
      inc.next = 0;
      inc.got = 0;
    }
    if (!inc.buf || m.seq !== inc.next || total !== inc.total) return this.abort(key);
    const bytes = base64ToBytes(m.data);
    const span = visualSpan(total, m.seq);
    if (!bytes || bytes.length !== span.end - span.start) return this.abort(key);
    inc.buf.set(bytes, span.start);
    inc.got += bytes.length;
    inc.next++;
    inc.lastAt = Date.now();
    if (inc.got < total) return;
    const buf = inc.buf;
    const tx = this.tx;
    // ⚠️ `incoming` keeps the entry until the look is judged: a poke while the validators load would
    // otherwise find the asset neither held nor in flight and ask for it again
    const done = (check: VisualCheck | null): void => {
      if (this.tx !== tx || this.incoming.get(key) !== inc) return; // the room was left, or the download dropped, meanwhile
      this.incoming.delete(key);
      if (!check || check.validateVisual(inc.kind, buf)) {
        this.asks.set(key, MAX_ASKS); // the owner's bytes are not a picture or a model: no second try
        return;
      }
      void this.deliver(inc.owner, inc.id, inc.kind, buf, tx);
    };
    // the first look waits for the validators; every later one is checked on the spot, as before
    if (checkModule) done(checkModule);
    else void loadCheck().then(done);
  }

  /**
   * Lend a validated asset to the renderers, keyed (owner, id), unless this viewer must not:
   *  · the roster no longer names this robot for that owner (it changed while this travelled);
   *  · it is this seat's OWN robot id, or one this device's library holds — what a viewer draws for
   *    its own robots is its own copy, never another seat's upload under the same id;
   *  · another owner's look already holds this id.
   */
  private async deliver(owner: string, id: string, kind: VisualKind, bytes: Uint8Array, tx: Transport | null): Promise<void> {
    if (this.roster.get(owner) !== id || id === this.ownId) return;
    if (hasRelayedAsset(owner, id, kind) || relayedIdTakenByOther(owner, id)) return;
    let mine = false;
    try {
      // a copy of THIS version only: an out-of-date one here is not drawn, so the relayed look is
      mine = (await this.own.has?.(id, this.rosterImp.get(owner))) ?? false;
    } catch {
      mine = false;
    }
    // the room may have been left, or the robot changed, while the library answered
    if (mine || this.tx !== tx || this.roster.get(owner) !== id || id === this.ownId || !this.showOthers()) return;
    if (registerRelayedAsset(owner, id, kind, bytes)) this.delivered.add(id);
  }

  private abort(key: string): void {
    this.incoming.delete(key);
    this.poke(); // one more go, if the count allows
  }

  // ---- stalls ------------------------------------------------------------------------------

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, inc] of this.incoming) {
        if (now - inc.lastAt > STALL_MS) {
          this.incoming.delete(key);
          changed = true;
        }
      }
      if (changed) this.poke();
      if (!this.incoming.size) this.stopWatchdog();
    }, 2000);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  // ---- the device preference and the view ----------------------------------------------------

  /** the preference or the view changed */
  refresh(): void {
    if (!this.showOthers()) {
      // off means the outline: take back what was delivered, and stop what is on its way
      this.incoming.clear();
      this.asks.clear();
      this.dropDelivered();
      return;
    }
    // back on, or the 3D view came up: what was never asked for may be asked for now
    this.poke();
  }

  // ---- this seat's own look, for the lobby's line ---------------------------------------------

  /** why this seat's own look is not in the room, or null (`OwnLookTrouble`) */
  ownLookTrouble(): OwnLookTrouble | null {
    return this.trouble;
  }

  /** told whenever `ownLookTrouble()` changes; returns the unsubscribe */
  subscribeOwnLook(cb: () => void): () => void {
    this.troubleListeners.add(cb);
    return () => {
      this.troubleListeners.delete(cb);
    };
  }

  /** the first trouble stands (the picture's, which every viewer needs, before the mesh's) */
  private noteTrouble(kind: VisualKind, reason: OwnLookTrouble['reason']): void {
    if (this.trouble && (this.trouble.kind === 'top' || kind === 'mesh')) return;
    this.setTrouble({ kind, reason });
  }

  private setTrouble(t: OwnLookTrouble | null): void {
    if (this.trouble === t || (this.trouble && t && this.trouble.kind === t.kind && this.trouble.reason === t.reason)) return;
    this.trouble = t;
    for (const cb of [...this.troubleListeners]) {
      try {
        cb();
      } catch {
        /* a listener's throw is its own */
      }
    }
  }

  /** TEST SEAM: what this client is doing */
  stateForTest(): { uploading: boolean; incoming: number; mine: string[]; delivered: string[] } {
    return { uploading: !!this.upload, incoming: this.incoming.size, mine: [...this.mine], delivered: [...this.delivered] };
  }
}

/** the app's one session (see the header) */
export const importVisuals = new ImportVisualsClient();

// the two things that change what a viewer wants, for the life of the tab
subscribeShowOthersImported(() => importVisuals.refresh());
subscribeViewPref(() => importVisuals.refresh());
