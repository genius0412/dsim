# LAN over WebRTC — hosting from a tab

Branch `lan-webrtc`, stacked on `alpha`. This is the design `docs/lan-selfhost.md` names as "the
one design that could remove the terminal later", with the one change that makes it buildable:
**signalling goes through the cloud server we already run.**

Read `docs/lan-selfhost.md` first. It establishes why an https page cannot open `ws://`, why a
browser tab cannot be a server, and why the terminal exists today. This document does not
re-argue any of that.

## What this replaces

| | today (`npm run lan`) | desktop app | this |
|---|---|---|---|
| host needs git | yes | no | **no** |
| host needs Node | yes | no | **no** |
| host needs a download | yes (a clone) | yes (an installer) | **no** |
| host needs a terminal | yes | no | **no** |
| runs on a Chromebook | no | no | **yes** |
| works with no internet at all | yes | yes | **no — see §3** |

The last row is the whole trade, and it is why this does not delete the other two. A venue with
genuinely no internet keeps the desktop app. A venue with a phone hotspot, or school Wi-Fi you
do not want forty players' snapshots on, gets this.

## 1. The cost question: is this a real diversion, or does the server still pay?

**It is a real diversion.** The server's per-match cost goes from a sustained stream to a
handful of kilobytes once, and its CPU cost goes to approximately zero.

What a cloud room costs today, from `docs/capacity.md` (measured, not modelled):

| | DECODE solo | DECODE 2v2 |
|---|---|---|
| downstream per client | 104 KB/s | 235 KB/s |
| downstream per room | 104 KB/s | 940 KB/s |
| CPU | ≈0.09 cores/room weighted; **the sim is ~50% of server CPU** | |

What signalling costs, per guest, once: an SDP offer and an answer (~2–4 KB each once ICE
candidates are folded in) plus a handful of trickled candidates at ~100–200 B. Call it **≤10 KB
per guest**, and it is over in about a second.

A 2v2 match running two and a half minutes:

```
cloud today   940 KB/s × 150 s          ≈ 141 MB egress   + ~0.18 cores for 150 s
this design   3 guests × ~10 KB         ≈  30 KB egress   + ~0 CPU
```

**Roughly 4,700× less egress for the match**, and the room loop — the half of server CPU that
is Rapier stepping — is not running on the server at all. It moved into the host's tab.

Two honest deductions from that number:

- **The replay still uploads at the end.** One authenticated `POST /api/lan` from the host,
  exactly as LAN matches already do today (`src/net/lanRuns.ts`). That is ingress plus a row,
  not a stream, and it is the point of the whole feature — it is how we keep the data.
- **The lobby socket stays open.** Presence, friends and the room-code rendezvous are still
  cloud. An idle WebSocket is bytes-per-minute, not bytes-per-second; `capacity.md` §2's cost
  cliff is snapshot traffic, and snapshots are what this removes.

⚠️ **Do not quote a dollar figure from this section.** `capacity.md` §5 carries a correction
saying its own egress rate was low by roughly 2× and its payload figure light by ~40%. The
ratio above is payload-to-payload, so it survives; the absolute cost does not.

## 2. The latency question

Better, not worse, and by a lot — but be precise about *which* latency.

| | |
|---|---|
| in-match RTT, cloud | **30–80 ms** to the nearest Fly region |
| in-match RTT, this | **~1 ms** — host candidates on the same subnet, traffic never leaves the LAN |
| added to JOIN | ~1 s of signalling, once, before the match |
| added to PLAY | **none** |

The signalling round trip happens while the lobby is assembling, which is time the player is
already spending. Once ICE has picked a pair, the internet is out of the path entirely: if the
hotspot dies mid-match, the match does not notice.

**The transport win is head-of-line blocking, not RTT.** `src/net/transport.ts` already takes a
`{ reliable: false }` lane hint and `WebSocketTransport` ignores it, because one TCP stream
cannot honour it. A DataChannel opened with `{ ordered: false, maxRetransmits: 0 }` can: a lost
input or a lost snapshot is superseded by the next one instead of stalling the stream for a
retransmit. On a clean LAN this is a small win. On congested venue Wi-Fi it is the difference
between a hitch and a freeze, and it is the exact failure `docs/netcodeplan.md` was written to
remove.

⚠️ **This is not the P2P mesh that was deleted.** `netcodeplan.md` §25 killed a full mesh of
lockstep peers over a shared TURN server, where any one failing edge wedged the match. This is
a **star**: one authoritative room, N client links, all on the same subnet, no TURN, no
lockstep, no cross-peer determinism requirement. The authority model does not change — it moves.
What carries over from that experience is the warning about ICE state handling: `disconnected`
and `failed` are different, and treating them the same is what made a blip indistinguishable
from a drop.

## 3. Why signalling is the cloud, and what that costs us

Two peers cannot talk until they have exchanged SDP and ICE candidates, and that exchange needs
a channel that already works. `docs/lan-selfhost.md` listed the options and left mDNS as "the
interesting third option".

**mDNS is not available and should be struck from the plan.** A page cannot advertise or query
an mDNS service record — there is no Web API for it. WebRTC's `.local` candidates are *candidate
obfuscation* that the browser resolves internally; they are not a discovery mechanism a page can
enumerate. Local discovery from a tab needs a native helper, and a native helper can simply run
the server — which is the desktop app we already have. The idea is circular.

So: **the game server relays signalling between two authenticated sockets.** It already holds a
socket for every player, already knows room codes (`src/net/roomCode.ts`), and already
authenticates. Forwarding an opaque blob between two clients in the same room is a message
router, not an architecture.

What that costs, stated plainly so nobody is surprised later:

- **The handshake needs the internet.** No internet at the venue, no LAN match by this path.
  The desktop app and `npm run lan` remain the answer for that case, and the UI must say so
  rather than failing at ICE with nothing a player can read.
- **Guests load the page from the cloud too.** There is no service worker in the repo (only
  `public/manifest.webmanifest`), so a cold guest with no internet has nothing to load. Offline
  caching is separate work, not a prerequisite for the first version.

## 4. Architecture

```
            ┌──────────── cloud (Fly) ────────────┐
            │  lobby · room codes · SIGNALLING    │   ~10 KB per guest, once
            │  POST /api/lan  ← replay, at the end│
            └───────▲──────────────────▲──────────┘
                    │                  │
              host tab             guest tab
                    │                  │
                    └──── LAN, ~1 ms ──┘
                      RTCDataChannel × N
                   (snapshots down, input up)

   host tab                              guest tab
   ├─ Worker: Room (authoritative)       ├─ ServerSession (unchanged)
   │    60 Hz step, 30 Hz snapshot       └─ Transport = DataChannelTransport
   ├─ its own ServerSession (loopback)
   └─ uploads the replay when done
```

The client half is genuinely small, because the seams were already there:

- `Transport` (`src/net/transport.ts`) is an 8-method interface the client already talks to
  instead of a `WebSocket`. `DataChannelTransport` is an implementation.
- `Client` (`server/room.ts`) is already an interface — `send` / `sendRaw?` / `backlog?` — and
  every test already drives a room through it with no socket at all. A DataChannel-backed
  `Client` is a shim, not a refactor.
- The protocol is JSON strings (`encodeMsg` / `decodeClientMsg`), which a DataChannel carries
  unchanged.

## 5. What was in the way, and is not any more

`server/room.ts` was said to be one `node:` import from portable. It was two things, and the
second one was invisible:

| | |
|---|---|
| `node:crypto`'s `randomUUID` | now `crypto.randomUUID()` — same function, Node 19+ and every browser |
| **`server/ranked.ts` → `./db/repo` → `pg`** | the room imported ONE pure function (`eloMode`) and got a Postgres driver reaching for `net`, `tls`, `dns`, `fs`. Split to `server/eloMode.ts`; `ranked.ts` re-exports it so callers are unchanged. |
| `process.env` at module scope in `channel.ts` and `moderation.ts` | now `envVar()` (`server/runtimeEnv.ts`), which reads through `globalThis` and MISSES in a tab instead of throwing `ReferenceError` during module init |

With those three, `server/room.ts` bundles for `--platform=browser` with **no shims and no
errors**. That was the load-bearing assumption of this whole design and it is now checked rather
than asserted.

## 6. The risk that is actually hard

**Timer throttling — MEASURED, and the answer decides the architecture.** `Room` drives itself
with `setInterval` at 60 Hz (`room.ts`, `this.loop`). A browser throttles timers in a hidden
tab, so a host who switches tabs could freeze the match for everybody. This was the assumption
most likely to be wrong in a way that only shows up in a gym, so it was measured before the UI
existed rather than after.

Both a page-thread `setInterval(…, 1000/60)` and an identical one inside a dedicated Worker,
run side by side in the same hidden tab for **7 minutes**, counting ticks into 15-second
buckets (Chrome 140, Windows 11, `visibilityState: 'hidden'` throughout):

| elapsed, tab hidden | page thread | dedicated Worker |
|---|---|---|
| 0–30 s | 59.1 → 59.7 Hz | 58.5 Hz |
| 30–45 s | **3.6 Hz** | 58.9 Hz |
| 45 s – 5 min | **1.1 – 2.4 Hz** | 50.4 – 62.3 Hz |
| 5–6 min | **0.017 Hz** (one wake per minute) | 60.9 Hz |
| whole run | — | **60.08 Hz average**, 25,236 ticks in 420.0 s |

So the page thread is not "roughly 1 Hz" — it is 60 Hz for about half a minute, then ~1 Hz,
then **one tick per minute** once Chrome's intensive throttling engages at the five-minute mark.
A match hosted on the page thread does not degrade, it stops. The Worker held 60 Hz for the
entire run and never entered either regime.

⚠️ **A SHORT SAMPLE MEASURES NOTHING HERE.** The first attempt at this was a 5-second A/B, and
it reported the page thread at 304 ticks / 5 s against the Worker's 277 — i.e. the page winning.
That window sits entirely inside the grace period above. Anything shorter than about a minute
hidden is measuring the un-throttled regime, and the conclusion inverts once the clamp lands.

Consequences, which are the design and not a nicety:

1. **The room runs in a dedicated Worker** (`src/lan/hostWorker.ts`). This is load-bearing.
   Moving the loop back onto the page for any reason breaks hosting outright.
2. **A Screen Wake Lock while hosting** (`hostRuntime.ts` `acquireWakeLock`), best-effort — it
   is unavailable on some browsers and rejects when the page is not visible, so it cannot be
   relied on and is not required.
3. **The Worker reports its own health** every 2 s (`HostOut.health`: `tickHz`, `behind`) and
   the LAN panel warns the host when it drifts. A throttled host does not announce itself — it
   just runs the match slowly for everyone else — so the one person who can fix it is told.

Second risk, smaller: the host pays its own sim (~0.09 cores) on top of rendering its own view.
Fine on a laptop; to be measured on a Chromebook, which is the machine this feature is for.

## 7. Plan

Each step was independently testable and landed on its own. All five are done.

1. **Make the room browser-safe.** ✅ §5. Bundles clean, `server:check` and `npm test` unchanged.
2. **Signalling relay in the server.** ✅ `server/lanSignal.ts` — an additive `ClientMsg`/
   `ServerMsg` pair forwarding an opaque payload between two members of a room. Routing comes
   from the registry, never from the message; no existing client notices.
3. **`DataChannelTransport`** ✅ `src/net/lanPeer.ts` — behind the existing `Transport`
   interface, plus the offer/answer/ICE dance.
4. **Room in a Worker** ✅ `src/lan/hostWorker.ts`, fed by the `Client` shim. §6 measured here.
5. **UI** ✅ host from the web LAN page; guests join by room code.

### What has been verified, and how

Source-shape checks live in `npm test` (`lan signal:` / `lan rtc:` / `lan host:` / `lan tab:`).
Those pin decisions; they do not prove the thing runs. These were run live in a browser:

| what | result |
|---|---|
| `Room` + Rapier WASM boot in a dedicated Worker | `ready` at **230 ms** |
| a full match stepping in that Worker | `matchStart`, then **29.4 Hz** snapshots over 5 s (design rate 30 Hz) |
| lane routing off the encoded frame | **every** snapshot on the hot lane; `welcome`/`roster` on control |
| the Worker's self-measurement | `tickHz` 48.7 → 62.4, drift **11 ms → 2 ms** |
| 60 Hz in a hidden tab, 7 minutes | Worker **60.08 Hz**; page thread 1–2 Hz, then 1/min (§6) |
| a real `RTCPeerConnection` handshake, both ends in one page | both lanes **open** in 2.5 s |
| which ICE pair actually carried it | **`host` candidate over udp** — direct, no relay, as §3 requires |
| lane selection through `DataChannelTransport` | `join` → control, `{reliable:false}` input → hot, both delivered |

⚠️ **NOT yet verified end-to-end between two machines**, and it cannot be until the server
carrying `lanSignal.ts` is deployed — hosting claims a code through the CLOUD rendezvous and
verifies an auth token there, so the first real host-and-guest test is a post-deploy one. The
handshake above stands in for it: it is the same code on both ends, with the rendezvous faked.
