# WebRTC on the Cloudflare side — live-verified research (2026-07-31)

Scope: the **server half** of Jonas's question on the prior-art report — "check
whether we can do WebRTC — as I understand it, UDP — on Cloudflare Worker."
The device half (esp-webrtc-solution etc.) is a sibling report. Everything
here was verified against **live web sources on 2026-07-31** (the prior-art
report self-declares it had no live verification). Local code citations are
against this worktree.

Our platform today: the `/pcm` proxy is `PcmSessionBridge`
(`apps/kit/src/userspace/config-worker/pcm-proxy.ts:68`) inside the OS
userspace config worker; wire v1 is mono S16LE 16 kHz, 640-byte/20 ms frames
(`pcm-proxy.ts:1-3`); the provider is xAI Grok realtime over
`wss://api.x.ai/v1/realtime`, model pinned `grok-voice-think-fast-2.0`
(`apps/kit/src/userspace/config-worker/providers.ts:146-147`), and we already
mint ephemeral client secrets via `https://api.x.ai/v1/realtime/client_secrets`
(`providers.ts:118`, `apps/kit/src/voice/grok-realtime-voice.ts:46`).

## Verdict table

| #   | Claim / question                                            | Verdict                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | "WebRTC is UDP, so a Worker can't terminate it"             | **CONFIRMED** — Workers/DOs have no inbound UDP (or inbound TCP); nothing on the 2026 roadmap changes this                                                                                                               |
| 2   | Cloudflare Calls still exists                               | **NUANCED** — renamed **Cloudflare Realtime** (SFU + TURN + RealtimeKit); the SFU **can** accept a device's WebRTC peer and hand OUR code the media as **PCM over a plain WebSocket** (the "WebSocket adapter", beta)    |
| 3   | RealtimeKit / Realtime Agents bridge WebRTC to AI providers | **NUANCED** — pipelines exist (beta) but they are STT→LLM→TTS-shaped with a fixed provider list; no speech-to-speech passthrough to xAI; the raw-PCM-to-your-endpoint piece is the SFU adapter, not the agent frameworks |
| 4   | TURN as the answer                                          | **REFUTED as termination** — TURN relays, it never terminates; useful only as a firewall story (TURN/TLS on 443) in front of a real peer                                                                                 |
| 5   | Stream WHIP for conversation                                | **REFUTED** — broadcast-shaped beta (WHIP in → WHEP out only), no server-side media egress to our code                                                                                                                   |
| 6   | xAI accepts WebRTC peers directly                           | **REFUTED** — WebSocket-only API; xAI's own "WebRTC Agent" demo is a self-hosted Node relay (werift + DataChannel), not an xAI endpoint                                                                                  |
| 7   | Device→provider "direct"                                    | Exists only as **direct WebSocket** (ephemeral token — flow we already implement); it forfeits req 8/9/11 and gains almost nothing because the transport is still TCP                                                    |
| 8   | Escape hatch off-platform                                   | Feasible (Fly.io inbound UDP confirmed; LiveKit has a first-class xAI plugin) — but Cloudflare **Containers cannot take inbound UDP either**, so any escape hatch leaves the platform entirely                           |

---

## 1. Can a Worker / Durable Object terminate WebRTC? No.

WebRTC termination needs inbound ICE/STUN + DTLS-SRTP over UDP (with a TCP
fallback). Workers accept **only** HTTP/HTTPS, WebSockets, HTTP/3-at-the-edge,
and email — nothing else, in or out of a DO:

- Workers protocols reference (fetched 2026-07-31): inbound = fetch handler,
  WebSockets, HTTP/3 (terminated by the edge, not exposed as QUIC to your
  code), Email Workers. **UDP is not mentioned anywhere; WebRTC is not
  mentioned anywhere.**
  <https://developers.cloudflare.com/workers/reference/protocols/>
- TCP sockets doc (page last-updated **2026-06-19**): `connect()` is
  **outbound TCP only**; _"Support for handling inbound TCP connections is
  coming soon. Currently, it is not possible to make an inbound TCP
  connection to your Worker."_ No UDP support of any kind, either direction.
  <https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>
- Roadmap state: "Socket Workers" (inbound raw TCP/UDP/QUIC) was promised in
  the 2021 blog post and the promise is still in "coming soon" state five
  years later; the 2023 `connect()` launch shipped only the outbound half.
  <https://blog.cloudflare.com/introducing-socket-workers/>,
  <https://blog.cloudflare.com/workers-tcp-socket-api-connect-databases/>

Even a DataChannel-only WebRTC session (no media, like xAI's demo) is
SCTP-over-DTLS-over-UDP — equally impossible to terminate in a Worker.

**Jonas's one-liner is exactly right.** A Worker cannot be a WebRTC peer.
What changed since anyone last looked: Cloudflare built a managed service
that terminates WebRTC _for_ you and hands your Worker the media on a
WebSocket — next section.

## 2. Cloudflare Realtime (né Calls): the SFU + the WebSocket adapter

Cloudflare Calls was renamed **Cloudflare Realtime**; the umbrella now holds
three products: **RealtimeKit** (beta, from the Dyte acquisition), the
**Realtime SFU** (the old Calls), and the **TURN service**.
<https://developers.cloudflare.com/realtime/>,
<https://www.cloudflare.com/products/turn-sfu/>

**The SFU:** unopinionated pub/sub over Sessions (PeerConnections) and Tracks
(MediaStreamTracks); no SDK; signaling is a bespoke **HTTPS API** (`POST
/apps/{appId}/sessions/new` with SDP offer/answer, `/tracks/new`,
`/renegotiate`) — WHIP-like but not WHIP.
<https://developers.cloudflare.com/realtime/sfu/introduction/>,
<https://developers.cloudflare.com/realtime/sfu/sessions-tracks/>
Pricing: **$0.05/GB egress, first 1,000 GB/month free**; TURN is free when
used with the SFU. <https://developers.cloudflare.com/realtime/>

**The part that answers Jonas's question — the WebSocket adapter**
(<https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/>,
fetched 2026-07-31, explicitly **beta**):

- Created by one HTTP call (`POST /v1/apps/{appId}/adapters/websocket/new`).
- **Stream mode (egress):** the SFU decodes a WebRTC Opus track and **dials
  out to any `wss://` URL you name** — i.e. our existing worker — pushing
  **16-bit signed little-endian PCM, 48 kHz, stereo** in protobuf frames
  (`Packet { sequenceNumber, timestamp, payload }`).
- **Ingest mode:** the reverse — we send PCM over a WebSocket, the SFU
  encodes to Opus and publishes it as a WebRTC track to the device
  (max 32 KB per message; each adapter is unidirectional, so a conversation
  needs one of each).
- Since **2026-05-29** the Stream side auto-reconnects to our endpoint for up
  to 5 s with a bounded audio backlog ("best effort… not gapless or
  exactly-once").
  <https://developers.cloudflare.com/changelog/post/2026-05-29-websocket-adapter-auto-reconnect/>
- No custom auth headers documented — the endpoint must authenticate via
  capability URL (token in the wss URL), which is how `/pcm` device auth
  works today anyway.
- The launch framing is precisely our use case: _"WebRTC audio in Workers
  works by leveraging Cloudflare's Realtime SFU, which converts WebRTC audio
  in Opus codec to PCM and streams it to any WebSocket endpoint you
  specify."_ (blog, **2025-08-29**)
  <https://blog.cloudflare.com/cloudflare-realtime-voice-ai/>

**So: YES — a device can speak real WebRTC (Opus over UDP) to Cloudflare,
and our own DO consumes/produces the audio as PCM over WebSockets it already
knows how to serve.** Cost of the PCM leg at 48 kHz stereo s16le =
192 KB/s ≈ 0.69 GB/h per direction ⇒ ≈ $0.035/h/direction after the free
1,000 GB (free while the adapter is beta); the WebRTC leg itself is
Opus ≈ 32 kbps ≈ 14 MB/h. We would down-mix/resample 48 k stereo → 16 k mono
in the DO (trivial decimation), or skip resampling entirely — xAI accepts
48 kHz PCM natively (§6).

## 3. RealtimeKit and Realtime Agents (the Dyte acquisition)

- **RealtimeKit**: SDK/API suite (meetings, participants, recording,
  webhooks) on top of the SFU. **"Currently in Beta and available at no cost
  during this period."** Published GA price list: **$0.0005/min audio-only
  participant**, $0.002/min A/V, $0.003–0.010/min recording, raw RTP export
  to R2 $0.0005/min.
  <https://developers.cloudflare.com/realtime/realtimekit/>,
  <https://developers.cloudflare.com/realtime/realtimekit/pricing/>
- **Realtime Agents** (announced 2025-08-29): `RealtimeAgent` JavaScript
  classes running **in Durable Objects**, pipelines of STT/LLM/TTS components
  (Deepgram Flux STT, ElevenLabs TTS, Workers AI; interception hooks between
  stages). The npm package `@cloudflare/realtime-agents` sits at **0.0.6,
  last published 2025-08-29** (registry checked live 2026-07-31) — one
  release burst at launch, nothing since.
- The 2026 (Agents Week) incarnation is `withVoice(Agent)` in the
  `cloudflare/agents` SDK — **beta**, browser-mic-over-**WebSocket**
  transport (not WebRTC), same STT→LLM→TTS shape
  (`WorkersAIFluxSTT`, `DeepgramSTT`, `ElevenLabsTTS`, `WorkersAITTS`).
  <https://developers.cloudflare.com/agents/guides/build-a-voice-agent/>

**Fit verdict: NUANCED-poor.** Both agent frameworks assume they _are_ the
voice pipeline (they transcribe, think, and synthesize). Neither documents a
speech-to-speech passthrough to an external realtime provider (OpenAI
Realtime, xAI), nor custom raw-PCM egress — for that Cloudflare's own blog
points you at the SFU WebSocket adapter and you write the bridge yourself,
which is exactly the code we already have in `PcmSessionBridge`. Using
Realtime Agents would mean replacing Grok speech-to-speech with a
Deepgram+LLM+ElevenLabs sandwich — a product change, not a transport change.

## 4. Cloudflare TURN — relay, never termination

Managed TURN at `turn.cloudflare.com`: TURN/UDP 3478 (alt 53), TURN/TCP 3478
(alt 80), **TURN/TLS 5349 (alt 443)**; free with the SFU, $0.05/GB
standalone. <https://developers.cloudflare.com/realtime/turn/>

TURN allocates relay addresses and forwards encrypted SRTP; it never decrypts
or terminates media — there must still be a real WebRTC peer on the far side.
Since we have no self-hosted peer, TURN alone buys us nothing; paired with
the SFU it is the firewall story (a device behind a hostile network can reach
the SFU via TURN-over-TLS on 443 — the same port profile as our current
WebSocket, so no new firewall exposure either way).

## 5. Cloudflare Stream WHIP/WHEP — broadcast only

Stream's WebRTC support ("Sub-second latency live streaming (using WHIP) and
playback (using WHEP) to unlimited concurrent viewers") is **beta**,
broadcast-shaped, and closed-world: WHIP ingest can only be consumed via
WHEP playback (no WHIP→HLS, no recording, no server-side egress of frames to
your code). <https://developers.cloudflare.com/stream/webrtc-beta/>
Since March 2025 its backend is being migrated onto the Realtime SFU anyway
(<https://webrtchacks.com/how-cloudflare-glares-at-webrtc-with-whip-and-whep/>,
<https://developers.cloudflare.com/stream/changelog/>). **Unusable for a
conversation loop** — there is no path from a WHIP ingest into our worker or
into a provider. REFUTED as an option.

## 6. xAI Grok realtime voice: WebSocket-only — no WebRTC endpoint

Checked live at docs.x.ai (2026-07-31):

- Transport: _"Build real-time, speech-to-speech voice agents over
  WebSockets"_ — `wss://api.x.ai/v1/realtime?model=…`, OpenAI-Realtime-API
  compatible. No SDP/WebRTC endpoint exists anywhere in the docs.
  <https://docs.x.ai/developers/model-capabilities/audio/voice>,
  <https://docs.x.ai/developers/model-capabilities/audio/voice-agent>
- Formats: `audio/pcm` (Linear16 LE) at **8/16/22.05/24/32/44.1/48 kHz**
  (default 24 k), `audio/pcmu`, `audio/pcma`, `audio/opus` (24 kHz only);
  input/output formats independent; JSON-base64 or **raw binary WebSocket
  frames**. Session resumption cache expires after 30 minutes.
- Auth: server-side API key, or **ephemeral client tokens** ("Short-lived
  tokens for client-side apps… Keeps your API key off the client",
  `xai-client-secret.` prefix) — the endpoint our worker already calls
  (`providers.ts:118`).
- The docs' **"WebRTC Agent" demo is not an xAI WebRTC endpoint.** It is
  `xai-org/xai-cookbook/voice-examples/agent/webrtc`: a **Node.js relay
  server** (Express + `werift`) that terminates browser WebRTC itself,
  carries PCM16 over a **DataChannel** (not RTP/Opus — so none of WebRTC's
  media-loss concealment), and forwards to xAI over WebSocket:
  _"Server-side relay between WebRTC (browser) and WebSocket (XAI API)."_
  <https://github.com/xai-org/xai-cookbook/tree/main/voice-examples/agent/webrtc>
- Everyone bridging WebRTC to Grok runs their own media plane: LiveKit's
  first-class plugin (`livekit-agents[xai]~=1.5`,
  `xai.realtime.RealtimeModel`) <https://docs.livekit.io/agents/models/realtime/plugins/xai/>;
  Voximplant's telephony integration (2026-01-15)
  <https://github.com/voximplant/grok-voice-agent-example>.

**Verdict: REFUTED — unlike OpenAI, xAI does not accept WebRTC peers.**
Any WebRTC plan for us terminates at Cloudflare (§2) or at infrastructure we
run (§8), never at the provider.

## 7. The "direct-to-provider" variant, honestly evaluated

Given §6, "device does WebRTC straight to the provider" **does not exist for
Grok today**. The real direct variant is **device → xAI over WSS with an
ephemeral token** (the worker only mints `client_secrets` — a flow our code
already implements, and demonstrated in the wild by Expo/react-native apps
streaming 24 kHz PCM16 directly with ephemeral tokens,
<https://github.com/EvanBacon/grok-voice-demo>).

What we would lose:

- **Req 8 (cross-post events):** transcription/turn/speak events arrive only
  on the device's socket. There is no server-side hook on a client-held xAI
  session, so the stream cross-poster in D8/stage 4 dies; the device would
  have to re-upload events it heard — over the control socket we kept anyway.
- **Req 9 (server-side AEC) and D7 (timestamp echo):** no server-side media
  path ⇒ nothing to run AEC on and nowhere to observe timestamp echo. Dead.
- **Req 11 / D8 (hang up when idle):** the worker can refuse to mint tokens
  but cannot hang up a session it isn't in. Idle-hangup becomes device
  firmware policy plus token TTL — the enforcement point moves onto the
  least-updatable component in the fleet, and "the PCM frames keep coming"
  (req 11's second half) stops being true for the server.
- **Observability:** everything `/pcm` gives us — `PcmSessionMetrics`,
  the acoustic ledger, PRBS proofs, conversation recording, the rig's
  host-side oracle — all of it assumes media transits our DO.
- **Provider agility:** model pinning, provider swap, session rotation and
  transcript replay across hangups (D8) all live server-side today.

What we would gain: removal of one anycast WebSocket hop (the DO), and the
DO-duration cost while sessions run. **Not gained:** provider-grade
jitter/loss handling — the path is still WebSocket/TCP end-to-end, with the
same head-of-line behavior as today, just with fewer places to observe it.

**Verdict: bad trade.** It deletes requirements 8, 9, and 11's server half
to save a hop that Cloudflare's anycast already makes cheap.

## 8. The non-Cloudflare escape hatch

- **Cloudflare Containers is NOT an escape hatch:** public beta (June 2025),
  and _"Because all Container requests are passed through a Worker,
  end-users cannot make non-HTTP TCP or UDP requests to a Container
  instance."_
  <https://developers.cloudflare.com/containers/platform-details/architecture/>,
  <https://blog.cloudflare.com/containers-are-available-in-public-beta-for-simple-global-and-programmable/>
  So WebRTC termination is impossible **anywhere** on Cloudflare compute —
  only the managed SFU/TURN products do UDP.
- **Fly.io can:** inbound UDP is supported (bind the special
  `fly-global-services` address, dedicated IPv4 required, external/internal
  port must match, ~72 bytes of MTU overhead ⇒ ~1,300-byte usable packets —
  fine for RTP). <https://fly.io/docs/networking/udp-and-tcp/>
- The turnkey shape would be **LiveKit** (self-hosted on a UDP-capable VM,
  or LiveKit Cloud) with the xAI plugin (§6) — genuinely production-proven
  WebRTC→Grok bridging.
- **Why it fights doctrine:** the platform is "Iterate's Cloudflare Workers
  platform" (repo CLAUDE.md); envs, deploys, secrets, and observability are
  Workers+Doppler-shaped (`envs.ts`, per-app wrangler deploys), and the kit
  host deliberately lives in OS **userspace** with zero apps/os changes
  (PLAN §1). A second always-on media plane on Fly/LiveKit is a new
  operational domain (patching, scaling, region placement, secret rotation,
  incident surface) bought to solve a problem Cloudflare's SFU already
  solves inside the platform — and its per-VM economics fight D8's
  dial-on-demand model. Feasible; not justified.

---

## Options matrix

Scoring: ✓✓ strong / ✓ adequate / ~ partial / ✗ fails. "Latency" is the
device↔provider media path; all options share Grok's model latency.

|                                              | **A. device→worker WS (today)**                                                                                   | **B. device→CF SFU (WebRTC) → WS adapter → our DO**                                                             | **C. device→xAI direct WS (ephemeral token)**           | **D. device→non-CF WebRTC gateway (LiveKit/Fly)**                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Works at all today                           | ✓✓ deployed, physically proven                                                                                    | ✓ SFU live; **adapter beta**; device needs a full WebRTC stack (the hard half)                                  | ✓✓ token flow already written (`providers.ts:118`)      | ✓ proven tech (LiveKit xAI plugin), new infra                             |
| Latency                                      | ✓ one anycast WS hop; TCP retransmit stalls under Wi-Fi loss (observed: ≥4.2 s link outage masked by TCP buffers) | ✓ adds Opus encode + SFU + decode (~tens of ms, unpublished); **UDP loss-tolerance + Opus PLC on the air link** | ✓ same TCP semantics as A minus one edge hop (≈nothing) | ✓ good; extra WAN leg to wherever the VM lives                            |
| Cost                                         | ✓✓ xAI usage + DO duration only                                                                                   | ✓ + ~$0.03–0.07/h SFU PCM egress post-free-tier (free in beta) + Opus leg ~14 MB/h                              | ✓✓ xAI only                                             | ✗ always-on VM + dedicated IPv4 (Fly) or LiveKit Cloud per-minute; egress |
| Observability / req 8                        | ✓✓ all media transits `PcmSessionBridge`                                                                          | ✓✓ **unchanged** — PCM still transits our DO; SFU adds per-frame seq+timestamps                                 | ✗ no server media path; device must self-report         | ~ rebuildable, all new plumbing                                           |
| Req 9 (server AEC) / D7                      | ✓ per plan (timestamp echo)                                                                                       | ✓ same, plus 48 kHz both-direction PCM at the DO                                                                | ✗                                                       | ~ possible in gateway                                                     |
| Req 11 / D8 (idle hangup, PCM keeps flowing) | ✓✓ D8 as designed                                                                                                 | ✓✓ D8 unchanged (worker still owns the Grok dial)                                                               | ✗ enforcement moves to firmware + token TTL             | ✓ gateway owns dialing                                                    |
| Complexity                                   | ✓✓                                                                                                                | server: **small** (the adapter is just another WS client of `/pcm`); device: **large** (ICE/DTLS-SRTP/Opus)     | server: smaller; fleet: larger (policy in firmware)     | ✗✗ new ops domain                                                         |
| Platform fit                                 | ✓✓                                                                                                                | ✓ all-Cloudflare; beta dependency                                                                               | ✓ but bypasses the platform's session control           | ✗✗                                                                        |

## Recommendation

**Stay on A (device→worker WebSocket) for v2.0 — and note that B is the
platform-native WebRTC lane if we ever want one, requiring almost no server
rearchitecture.** Reasons:

1. Nothing WebRTC would fix is a _server-side_ problem. The Cloudflare side
   was never the blocker — and the one genuine WebRTC benefit (loss-tolerant
   UDP + Opus PLC) applies only to the device↔edge air link.
2. The direct-to-provider fantasy is off the table: xAI is WebSocket-only
   (§6), so every WebRTC design still needs a terminator we rent (CF SFU) or
   run (Fly/LiveKit).
3. B's server half degenerates into "the SFU is just another WebSocket
   client of our `/pcm` DO" — PCM in protobuf frames at 48 kHz instead of
   raw 640-byte frames at 16 kHz. D8, req 8, req 9, req 11 all survive
   untouched. That means **deferring B costs us nothing**: no v2.0 decision
   is foreclosed, and a future spike is ~a resampler + protobuf codec +
   adapter-lifecycle calls on the worker side. The expensive half of B is
   firmware (ICE/DTLS-SRTP/Opus on an S3 that currently has 1 byte of IRAM
   free) — which is the device report's territory, and PLAN stage 2's
   reconnect/jitter fixes plus D7's timestamp echo are the cheaper first
   rungs on the same ladder.
4. C and D each destroy more requirements than they discharge (§7, §8).

**Single strongest counterargument:** our own field evidence says TCP is the
fragile layer — the receive-stall investigation found a ≥4.2 s Wi-Fi outage
that TCP dutifully turned into a silent stall-then-burst, exactly the failure
mode RTP-over-UDP with Opus PLC degrades through gracefully; Espressif now
ships a supported device stack for it (esp-webrtc-solution), and Cloudflare
now runs the terminator with a PCM tap our architecture can consume
natively. If rig/field telemetry shows multi-second TCP stalls are common in
real deployments, option B stops being an option and becomes the roadmap —
and because B reuses `/pcm` wholesale, adopting it late wastes none of the
v2.0 work. The honest hedge: keep B's two prerequisites alive (per-frame
timestamps via D7, and the SFU adapter's beta status on a watchlist) and
re-score after stage 2's reconnect fixes meet the rig's network-churn
scenarios.

## Pointers for PLAN.md

No decision reopens. Suggested additions: (a) a one-line note under D8 that
the provider-session half must stay transport-agnostic on its device side —
"device connection" may someday be an SFU adapter connection; (b) §8's
watchlist gains "Cloudflare Realtime WebSocket adapter beta → GA (pricing +
API stability)" and "xAI WebRTC endpoint (none today)".
