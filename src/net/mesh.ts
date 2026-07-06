import type { SupabaseLobby, SignalMsg } from './lobby';

/**
 * WebRTC full mesh over the lobby's signaling channel. Up to 4 peers (≤6
 * links). For each pair the LOWER peerId is the offerer/initiator and owns the
 * single DataChannel (ordered + reliable — lockstep needs every input in order;
 * that is the simplest correct choice). STUN only (no TURN in v1): if a NAT
 * blocks the direct path the link never opens and the session surfaces a
 * connection error suggesting the same network. TURN is a config-only retrofit.
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

type MeshHandlers = {
  data: (from: string, data: ArrayBuffer | string) => void;
  connect: (peerId: string) => void;
  disconnect: (peerId: string) => void;
};

type SdpSignal = { kind: 'sdp'; sdp: RTCSessionDescriptionInit };
type IceSignal = { kind: 'ice'; candidate: RTCIceCandidateInit };

interface PeerLink {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  /** ICE candidates that arrived before the remote description was set */
  pending: RTCIceCandidateInit[];
  open: boolean;
}

export class RtcMesh {
  private readonly links = new Map<string, PeerLink>();
  /** peers we've already tried to link (kept even after a drop) so a repeated
   * presence sync — or a ghost peer left over from a refresh — is not retried
   * in a tight connect/fail/reconnect loop */
  private readonly attempted = new Set<string>();
  private readonly handlers: Partial<MeshHandlers> = {};

  constructor(
    private readonly lobby: SupabaseLobby,
    private readonly localPeerId: string,
  ) {
    lobby.on('signal', (msg) => void this.onSignal(msg));
  }

  on<K extends keyof MeshHandlers>(event: K, cb: MeshHandlers[K]): void {
    this.handlers[event] = cb;
  }

  /** open links to every other peer — ONCE per peer id (idempotent) */
  connect(peerIds: string[]): void {
    for (const id of peerIds) {
      if (id === this.localPeerId || this.attempted.has(id)) continue;
      this.makeLink(id, this.localPeerId < id); // lower id initiates
    }
  }

  /** peers we currently hold an OPEN channel to */
  connectedPeers(): string[] {
    return [...this.links.entries()].filter(([, l]) => l.open).map(([id]) => id);
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
      link.channel?.close();
      link.pc.close();
    }
    this.links.clear();
  }

  // -------------------------------------------------------------- internals --

  private makeLink(peerId: string, initiator: boolean): PeerLink {
    this.attempted.add(peerId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: PeerLink = { pc, channel: null, pending: [], open: false };
    this.links.set(peerId, link);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.lobby.sendSignal(peerId, { kind: 'ice', candidate: e.candidate.toJSON() } satisfies IceSignal);
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      console.info(`[mesh] ${peerId.slice(0, 6)} pc → ${st}`);
      // 'disconnected' is TRANSIENT — ICE often recovers it; only tear down on a
      // terminal state, else we thrash good links into reconnect loops
      if (st === 'failed' || st === 'closed') this.dropLink(peerId);
    };
    console.info(`[mesh] opening link to ${peerId.slice(0, 6)} (initiator=${initiator})`);

    if (initiator) {
      const channel = pc.createDataChannel('lockstep', { ordered: true });
      this.wireChannel(peerId, link, channel);
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => this.lobby.sendSignal(peerId, { kind: 'sdp', sdp: offer } satisfies SdpSignal))
        .catch(() => this.dropLink(peerId));
    } else {
      pc.ondatachannel = (e) => this.wireChannel(peerId, link, e.channel);
    }
    return link;
  }

  private wireChannel(peerId: string, link: PeerLink, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    link.channel = channel;
    channel.onopen = () => {
      link.open = true;
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
    const data = msg.data as SdpSignal | IceSignal;
    let link = this.links.get(msg.from);
    if (!link) {
      // an inbound offer from a peer we haven't set up (we are the answerer)
      if (data.kind !== 'sdp' || data.sdp.type !== 'offer') return;
      link = this.makeLink(msg.from, false);
    }
    const { pc } = link;
    try {
      if (data.kind === 'sdp') {
        await pc.setRemoteDescription(data.sdp);
        for (const c of link.pending.splice(0)) await pc.addIceCandidate(c);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.lobby.sendSignal(msg.from, { kind: 'sdp', sdp: answer } satisfies SdpSignal);
        }
      } else {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else link.pending.push(data.candidate); // buffer until remote desc is set
      }
    } catch {
      this.dropLink(msg.from);
    }
  }

  private dropLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    const wasOpen = link.open;
    link.open = false;
    link.channel?.close();
    link.pc.close();
    this.links.delete(peerId);
    if (wasOpen) this.handlers.disconnect?.(peerId);
  }
}
