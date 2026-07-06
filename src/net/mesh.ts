import type { SupabaseLobby, SignalMsg } from './lobby';
import { iceServers, loadIceServers } from './env';

/**
 * WebRTC full mesh over the lobby's signaling channel. Up to 4 peers (≤6
 * links). For each pair the LOWER peerId is the offerer/initiator and owns the
 * single DataChannel (ordered + reliable — lockstep needs every input in order;
 * that is the simplest correct choice). ICE = STUN + TURN (see env.iceServers):
 * TURN relays when a direct path is blocked, so NAT-bound peers connect instead
 * of the match freezing at WAITING. A link that neither opens within
 * CONNECT_TIMEOUT_MS nor recovers is reported 'failed' so the lobby can surface
 * it (and the host can kick) rather than everyone stalling forever.
 */

/** a link that hasn't opened its DataChannel within this is reported failed */
const CONNECT_TIMEOUT_MS = 20000;
/** stop waiting for more ICE candidates and send the SDP anyway (a slow/blocked
 * TURN server can otherwise stall gathering forever) */
const ICE_GATHER_TIMEOUT_MS = 3000;

type MeshHandlers = {
  data: (from: string, data: ArrayBuffer | string) => void;
  connect: (peerId: string) => void;
  disconnect: (peerId: string) => void;
  /** the link to this peer could not be established (timeout or ICE failure) */
  failed: (peerId: string) => void;
};

// NON-TRICKLE signaling: a single complete SDP (with all ICE candidates already
// embedded) is the ONLY message per side. Trickling each candidate as its own
// broadcast flooded the rate-limited, best-effort Supabase channel, so with
// several peers connecting at once candidates were dropped and pairs got stuck
// at "connecting" — randomly, differently per client. One bundled SDP each way
// (offer + answer) is well under the rate limit and has nothing to lose mid-flight.
type SdpSignal = { kind: 'sdp'; sdp: RTCSessionDescriptionInit };

interface PeerLink {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  open: boolean;
  /** true once the link has failed/timed out (reported once) */
  failed: boolean;
  /** connect-timeout handle, cleared on open */
  timer: ReturnType<typeof setTimeout> | null;
}

/** after a failed link, wait this long before a presence-driven retry (so a
 * ghost / unreachable peer isn't hammered in a tight connect/fail loop) */
const RETRY_COOLDOWN_MS = 8000;

export class RtcMesh {
  private readonly links = new Map<string, PeerLink>();
  /** peerId -> ms of last failure; throttles retries and drives the lobby's
   * "failed" status. Cleared when a link finally opens. */
  private readonly failedAt = new Map<string, number>();
  private readonly handlers: Partial<MeshHandlers> = {};
  /** resolved ICE config (may include ephemeral TURN creds fetched at runtime);
   * null until loaded — makeLink falls back to the sync default meanwhile */
  private ice: RTCIceServer[] | null = null;

  constructor(
    private readonly lobby: SupabaseLobby,
    private readonly localPeerId: string,
  ) {
    lobby.on('signal', (msg) => void this.onSignal(msg));
    // fetch ICE config once up front (resolves well before the mesh actually
    // connects, which waits on lobby presence + ready-up)
    void loadIceServers().then((s) => {
      this.ice = s;
    });
  }

  on<K extends keyof MeshHandlers>(event: K, cb: MeshHandlers[K]): void {
    this.handlers[event] = cb;
  }

  /** open links to every other peer. Idempotent (skips peers with a live link);
   * a failed peer is retried after RETRY_COOLDOWN_MS so a recovered network or a
   * reloaded peer reconnects instead of being blocked forever. */
  connect(peerIds: string[]): void {
    const now = Date.now();
    for (const id of peerIds) {
      if (id === this.localPeerId || this.links.has(id)) continue;
      const failed = this.failedAt.get(id);
      if (failed !== undefined && now - failed < RETRY_COOLDOWN_MS) continue; // throttle
      this.makeLink(id, this.localPeerId < id); // lower id initiates
    }
  }

  /** peers we currently hold an OPEN channel to */
  connectedPeers(): string[] {
    return [...this.links.entries()].filter(([, l]) => l.open).map(([id]) => id);
  }

  /** per-peer link status for the lobby's connection dots */
  linkStatus(peerId: string): 'open' | 'connecting' | 'failed' | 'none' {
    const l = this.links.get(peerId);
    if (l?.open) return 'open';
    if (l) return l.failed ? 'failed' : 'connecting';
    return this.failedAt.has(peerId) ? 'failed' : 'none';
  }

  /** send to every open peer (ArrayBuffer = command packet, string = control) */
  broadcast(data: ArrayBuffer | string): void {
    for (const link of this.links.values()) {
      if (link.open && link.channel) link.channel.send(data as ArrayBuffer);
    }
  }

  sendTo(peerId: string, data: ArrayBuffer | string): void {
    const link = this.links.get(peerId);
    if (link?.open && link.channel) link.channel.send(data as ArrayBuffer);
  }

  close(): void {
    for (const link of this.links.values()) {
      if (link.timer) clearTimeout(link.timer);
      link.channel?.close();
      link.pc.close();
    }
    this.links.clear();
  }

  // -------------------------------------------------------------- internals --

  private makeLink(peerId: string, initiator: boolean): PeerLink {
    const pc = new RTCPeerConnection({ iceServers: this.ice ?? iceServers() });
    const link: PeerLink = { pc, channel: null, open: false, failed: false, timer: null };
    this.links.set(peerId, link);
    // a link that never opens must FAIL LOUDLY (lobby shows it, host can kick)
    // instead of leaving every peer stalled at WAITING forever
    link.timer = setTimeout(() => {
      if (!link.open) this.failLink(peerId);
    }, CONNECT_TIMEOUT_MS);

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      console.info(`[mesh] ${peerId.slice(0, 6)} pc → ${st}`);
      // 'disconnected' is TRANSIENT — ICE often recovers it; only act on a
      // terminal state, else we thrash good links into reconnect loops
      if (st === 'failed') this.failLink(peerId);
      else if (st === 'closed') this.dropLink(peerId);
    };
    console.info(`[mesh] opening link to ${peerId.slice(0, 6)} (initiator=${initiator})`);

    if (initiator) {
      const channel = pc.createDataChannel('lockstep', { ordered: true });
      this.wireChannel(peerId, link, channel);
      // non-trickle: gather all candidates, then send ONE complete offer SDP
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => this.iceComplete(pc))
        .then(() => this.sendLocalSdp(peerId, pc))
        .catch(() => this.failLink(peerId));
    } else {
      pc.ondatachannel = (e) => this.wireChannel(peerId, link, e.channel);
    }
    return link;
  }

  /** resolve once ICE gathering completes (or a safety timeout elapses) so the
   * SDP we then send carries every candidate — no separate trickle messages */
  private iceComplete(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = (): void => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    });
  }

  /** send our current (candidate-laden) local description to a peer */
  private sendLocalSdp(peerId: string, pc: RTCPeerConnection): void {
    const sdp = pc.localDescription;
    if (sdp) this.lobby.sendSignal(peerId, { kind: 'sdp', sdp: sdp.toJSON() } satisfies SdpSignal);
  }

  private wireChannel(peerId: string, link: PeerLink, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    link.channel = channel;
    channel.onopen = () => {
      link.open = true;
      link.failed = false;
      this.failedAt.delete(peerId);
      if (link.timer) {
        clearTimeout(link.timer);
        link.timer = null;
      }
      console.info(`[mesh] channel OPEN to ${peerId.slice(0, 6)}`);
      this.handlers.connect?.(peerId);
    };
    channel.onclose = () => {
      if (link.open) {
        link.open = false;
        console.info(`[mesh] channel CLOSED to ${peerId.slice(0, 6)}`);
        this.handlers.disconnect?.(peerId);
      }
    };
    channel.onmessage = (e) => this.handlers.data?.(peerId, e.data);
  }

  private async onSignal(msg: SignalMsg): Promise<void> {
    const data = msg.data as SdpSignal;
    if (data.kind !== 'sdp') return; // non-trickle: full SDP is the only signal
    let link = this.links.get(msg.from);
    if (!link) {
      // an inbound offer from a peer we haven't set up (we are the answerer)
      if (data.sdp.type !== 'offer') return; // a stray answer with no link
      link = this.makeLink(msg.from, false);
    }
    const { pc } = link;
    try {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        // gather our candidates, then reply with ONE complete answer SDP
        await pc.setLocalDescription(await pc.createAnswer());
        await this.iceComplete(pc);
        this.sendLocalSdp(msg.from, pc);
      }
    } catch {
      this.failLink(msg.from);
    }
  }

  /** the link could not be established (timeout / ICE failure). Report it once
   * so the lobby can show it + the host can kick, then tear down. */
  private failLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (link?.failed) return;
    this.failedAt.set(peerId, Date.now()); // status + retry throttle
    console.warn(`[mesh] link to ${peerId.slice(0, 6)} FAILED to connect`);
    this.handlers.failed?.(peerId);
    this.dropLink(peerId);
  }

  private dropLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    const wasOpen = link.open;
    link.open = false;
    if (link.timer) {
      clearTimeout(link.timer);
      link.timer = null;
    }
    link.channel?.close();
    link.pc.close();
    this.links.delete(peerId);
    if (wasOpen) this.handlers.disconnect?.(peerId);
  }
}
