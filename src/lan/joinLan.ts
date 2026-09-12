/**
 * JOINING A TAB-HOSTED LAN ROOM — the guest half, which is the small one.
 *
 * A guest does nothing special: it gets a `Transport` and hands it to the stock `LobbyClient`,
 * exactly as it would a `WebSocketTransport`. Everything that makes this a LAN match is behind
 * the interface.
 *
 * The rendezvous socket is closed as soon as the DataChannel is up. It has no further job — the
 * peers are connected and the cloud is out of the path — and leaving it open would mean a guest
 * holding a cloud socket for the whole match, which is the cost this feature exists to avoid.
 */
import { LanSignalClient } from '../net/lanSignalClient';
import { connectToLanHost, DataChannelTransport } from '../net/lanPeer';
import type { Transport } from '../net/transport';

export interface LanJoin {
  transport: Transport;
  /** the normalized code actually joined */
  code: string;
}

/**
 * Ask the rendezvous for `code`'s host, connect to it, and return a transport.
 *
 * Throws `LanSignalError` when the code is wrong or unhosted (a thing the player retypes) and a
 * plain `Error` when the handshake itself fails (a thing about the network). The caller shows
 * the message; both are written to be read by a player.
 */
export async function joinLanRoom(code: string): Promise<LanJoin> {
  const signals = new LanSignalClient();
  try {
    const { hostId, code: joined } = await signals.join(code);
    const link = await connectToLanHost(signals, hostId);
    return { transport: new DataChannelTransport(link), code: joined };
  } finally {
    // up or not, the introduction is over
    signals.close();
  }
}
