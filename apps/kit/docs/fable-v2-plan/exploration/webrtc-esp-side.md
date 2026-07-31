# esp-webrtc-solution deep-read — the device side of "can we just use the WebRTC example from ESP?"

Date: 2026-07-31. Live-verified against fresh clones (`~/src/github.com/espressif/esp-webrtc-solution`,
`~/src/github.com/sepfy/libpeer`, `~/src/github.com/openai/openai-realtime-embedded-sdk`) and live web.
All file:line references are to those clones; firmware references are to
`apps/kit/firmware` on branch `c-capabilities`. Companion input under
examination: `inputs/jonas-prior-art-report-2026-07-31.md` (Key Finding 1 and
Tier 1/2 shortlist).

## Verdict up front

**The ESP WebRTC stack is real, current, and good at what it does — but its
core transport engine is a closed-source binary blob, it is device-only
(zero host-testability), and it solves a different problem than ours: a
device that IS the WebRTC peer of the AI provider.** Our architecture
deliberately puts our worker between device and provider (secret isolation,
D8 provider-hangup-while-PCM-flows, server-side transcription cross-posting,
freshness-over-throughput). Cloudflare Workers cannot terminate WebRTC
(TCP-only `connect()`, no UDP), and xAI's voice agent API speaks
WebSocket/SIP/LiveKit — not the OpenAI-style HTTP-SDP WebRTC endpoint the ESP
demo uses. Adopting esp-webrtc is net-simpler **only** if we change the
system architecture to "device dials the provider (or an SFU like LiveKit /
Cloudflare Realtime) directly" — which requirement 11 and D8's worker-side
session split argue against. For the v2 plan as written: **do not adopt;
steal specific patterns** (listed at the end).

---

## 1. What is actually in the repo (structure, licenses, activity)

Clone HEAD: `e088f30` merge commit dated **2026-07-31** (today — the project
is actively maintained; shallow clone, so commit count not measurable
locally). GitHub: ~385 stars, 73 forks, 58 open issues
(https://github.com/espressif/esp-webrtc-solution, fetched 2026-07-31).

```
components/
  esp_peer          PeerConnection: open C shim + CLOSED prebuilt core (see below)
  esp_webrtc        session orchestration + signaling impls (apprtc/whip/janus/kvs)
  av_render         playback pipeline (decode → i2s render)
  codec_board       board/codec bring-up table (ES8311/ES7210 etc., 18+ boards)
  media_lib_utils   os/thread adapter layer
  webrtc_utils      SNTP time (certs need wall clock)
solutions/
  peer_demo, openai_demo, whip_demo, kvs_master, kms_demo, janus_demo,
  doorbell_demo, doorbell_local, videocall_demo, webrtc_usb_camera,
  rtsp_demo, rtmp_demo
```

`esp_capture` (mic→AFE→encode graph) is **not in the repo** — it is a managed
registry component whose source lives in `espressif/esp-gmf`
(`packages/esp_capture`), pulled in by `esp_webrtc`'s manifest
(`components/esp_webrtc/idf_component.yml:9`, `espressif/esp_capture: "~1.0"`).

### 1.1 The license situation (this matters enormously)

**CONFIRMED — the suspicion was right.** `esp_peer`'s default implementation
is a **per-chip closed-source static library**:
`components/esp_peer/libs/{esp32,esp32s2,esp32s3,esp32s31,esp32c5,esp32c61,esp32p4}/libpeer_default.a`
(1,274,046 bytes for esp32s3). I unpacked the S3 archive: the blob contains
`agent.c.obj, ice.c.obj, stun.c.obj, rtcp.c.obj, rtp.c.obj, sdp.c.obj,
rtp_rolling_buffer.c.obj, rtp_jitter.c.obj, utils.c.obj, buf_mngr.c.obj,
sctp.c.obj, peer_default.c.obj` — i.e. **the entire ICE agent, STUN, RTP/RTCP,
jitter buffer, SDP, and SCTP engine is closed**. Measured `.text` across the
objects: **50,249 bytes of machine code** (the other ~1.2 MB is DWARF debug
info), so the closed core is roughly a 15–25 k-LOC-equivalent library
costing ~50 KB of flash when linked.

What IS open in `components/esp_peer/src/` (3,523 lines total): the
`esp_peer_ops_t` dispatch shim (`esp_peer.c`, 222 L), DTLS-SRTP over mbedTLS
(`dtls_srtp.c` 288 L / `dtls_srtp_v6.c` 380 L for IDF v6/mbedTLS 4.1), and
the socket transports (`transport/udp.c` 334 L, `tcp.c` 1,008 L, `tls.c`
955 L, `peer_tls_esp.c` 217 L). The build links the blob unconditionally
(`components/esp_peer/CMakeLists.txt`: `add_prebuilt_library(...
libs/${IDF_TARGET}/libpeer_default.a)`).

Licenses, checked file by file:

| Component                                         | License                                                                                                                                                                       | Open?                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| esp_peer (shim + blob)                            | **Espressif Modified MIT** — "use EXCLUSIVELY with Espressif Systems products; redistribution for non-Espressif products strictly prohibited" (`components/esp_peer/LICENSE`) | shim source-available, core **binary-only** |
| esp_webrtc                                        | "ESPRESSIF MIT" (Espressif-products-only variant, header of `src/esp_peer_signaling.c`)                                                                                       | source, products-only                       |
| av_render, codec_board, media_lib_utils           | Espressif Modified MIT (each `LICENSE` file)                                                                                                                                  | source, products-only                       |
| esp_capture (registry)                            | Espressif Modified MIT (verified via raw LICENSE at `espressif/esp-gmf/packages/esp_capture`) — and depends on **`espressif/esp-sr: ^2.4`** for its AEC source                | source, products-only; AEC engine below     |
| esp-sr (AFE/AEC/VAD)                              | ESPRESSIF MIT + **prebuilt per-chip `.a` libraries** (`~/src/github.com/espressif/esp-sr/lib/esp32s3/…`)                                                                      | AFE engine **binary-only**                  |
| esp_audio_codec (Opus etc., via av_render `~2.5`) | registry component v2.6.1; license page defers to per-codec third-party notices; encoder implementation form not verifiable from the registry page (flag)                     | partially unclear                           |
| libpeer (upstream)                                | plain MIT (`~/src/github.com/sepfy/libpeer/LICENSE`)                                                                                                                          | fully open                                  |

Practical reading: products-only licensing is a non-issue while every kit
board is an ESP32 (all four hub boards are). The **blob** is the real cost:
no auditing, no patching, no porting, no host builds, and bug turnaround at
Espressif's pace (58 open issues).

### 1.2 IDF pin and target matrix

- Manifests require only `idf: ">=5.0"` (`solutions/openai_demo/main/idf_component.yml`);
  READMEs across peer_demo/openai_demo/whip_demo say "**IDF master branch or
  release v5.4**"; the CMake and changelog explicitly handle **IDF v6.0 /
  mbedTLS 4.1** (esp_peer v1.5.3 fixed the first-boot DTLS handshake there).
  Report's "believed v5.4+" → **NUANCED**: v5.4 is the tested release, v5.0
  the floor, v6 supported.
- Blob targets: esp32, s2, **s3**, s31, c5, c61, p4. **No c2/c3/c6/h2** —
  esp_peer cannot run on those at all. S3 and P4 are the first-class demo
  targets (openai_demo defaults: S3 = Korvo-2 board, P4 = Function-EV).
- esp_peer component version 1.5.3 (`idf_component.yml`), changelog shows
  steady releases: 1.4.2 (renegotiation, ECDSA), 1.5.0 (**TCP + TURNS**),
  1.5.1–1.5.3 (DTLS/SCTP fixes).

## 2. The OpenAI Realtime demo, end to end

`solutions/openai_demo` (1,507 lines of demo `main/*.c`).

**Signaling** (`main/openai_signaling.c`, 353 L): plain HTTPS, no
STUN/TURN server at all. `POST https://api.openai.com/v1/realtime/client_secrets`
with the long-lived API key → ephemeral token; then `POST /v1/realtime/calls`
with the locally-generated SDP offer, Bearer = ephemeral token; the HTTP
response body is the answer SDP (`openai_signaling.c:20-21,102,238-251`).
Model `gpt-realtime-2`, voice `alloy` (`common.h:22-23`). The peer is opened
with `stun_url = NULL` and `ice_use_lite_mode = true, agent_recv_timeout=500`
(`webrtc.c:650-653`) — OpenAI publishes host candidates directly, so ICE is
trivial. Function calls and session events ride the **data channel**
(`enable_data_channel = true, manual_ch_create = true`, `webrtc.c:671-673`,
with cJSON dispatch of `oai` events in `webrtc.c`).

**Opus**: `ESP_PEER_AUDIO_CODEC_OPUS, sample_rate 16000, channel 1`
(`webrtc.c:662-665`); encoder from `esp_audio_codec` via the capture graph.
G711A is the compile-out fallback (`settings.h: WEBRTC_SUPPORT_OPUS`).

**Capture/AEC wiring** (`main/media_sys.c`): the capture source is
`esp_capture_new_audio_aec_src` with, on S3, `.channel = 4,
.channel_mask = 1 | 2` — i.e. **ES7210 in I2S TDM mode, mics in slots 0/1,
hardware playback-loopback reference in the remaining slots**
(`media_sys.c:47-57`; comment: "For S3 when use ES7210 it use TDM mode second
channel is reference data"). The player is forced to 2-channel 16 kHz
output because "reference data is from speaker right channel for ES8311"
(`media_sys.c:90-97`). AEC itself is **esp-sr AFE inside esp_capture**
(esp_capture's manifest depends on `esp-sr ^2.4`). This exactly matches the
prior-art report's "hardware reference channel is the make-or-break detail"
— **CONFIRMED** — and it means the demo's AEC quality is a property of the
Korvo-2-class codec topology, not of WebRTC. On our M5StickS3 (PDM mic, no
ES7210, no TDM loopback) this AEC source has nothing to attach to; StackChan
(ES7210 with speaker-wired TDM slot, verified earlier in the plan) is the
board where it would map.

**Task model** (demo `thread_scheduler`, `main/main.c:160-204`, plus
`esp_webrtc.c`):

| Thread                             | Prio | Stack     | Core | What                                                                                                                            |
| ---------------------------------- | ---- | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pc_task`                          | 18   | **25 KB** | 1    | `esp_peer_main_loop()` every 10 ms (`esp_webrtc.c:282-296`)                                                                     |
| `pc_send`                          | 15   | 4 KB      | 1    | pulls encoded frames from capture sink, `esp_peer_send_audio`, sleeps 20 ms (`AUDIO_FRAME_INTERVAL`, `esp_webrtc.c:39,185-193`) |
| `aenc_0` (Opus enc)                | 10   | **40 KB** | 1    | "For OPUS encoder it need huge stack" (`main.c:170-174`)                                                                        |
| `AUD_SRC` (capture+AFE)            | 15   | **40 KB** | —    | mic read + AFE feed/fetch                                                                                                       |
| `Adec` (Opus dec)                  | 15   | **40 KB** | 0    | decode downlink                                                                                                                 |
| `ARender`                          | 20   | —         | —    | i2s render                                                                                                                      |
| `buffer_in`                        | 10   | 6 KB      | 0    | network→decoder buffering                                                                                                       |
| + blob-internal send/receive tasks |      |           |      | "send and receive in separate task" (esp_webrtc README feature 7)                                                               |

That is ~155 KB of stacks alone vs our three 8 KB static stacks
(`esp_idf_pcm_transport.h:35-37`). The demo's S3 sdkconfig **requires octal
PSRAM at 120 MHz** and pushes lwIP/mbedTLS allocations into SPIRAM
(`sdkconfig.defaults.esp32s3`: `CONFIG_SPIRAM_MODE_OCT=y`,
`SPIRAM_SPEED_120M`, `SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`,
`MBEDTLS_EXTERNAL_MEM_ALLOC=y`, `IDF_EXPERIMENTAL_FEATURES=y`).

**Memory claims**: esp_peer README: "Even on platforms without PSRAM, a
minimal setup uses **< 60 KB** RAM" (peer_demo: two peers on one S3, no
PSRAM — but that is G711/data-channel-class traffic, not the OpenAI voice
demo). Defaults tell the real story for the full demo:
`esp_peer_default_cfg_t` defaults are **400 KB RTP send pool, 100 KB audio
jitter cache, 2×100 KB data-channel caches** (`esp_peer_default.h:20-57`)
— PSRAM-class numbers, tunable downward.

## 3. What the transport actually does

From `esp_peer_default.h`, the esp_peer README, and the blob's object list:

- **ICE**: full agent (controlling/controlled), host+STUN+TURN candidate
  gathering, `max_candidates` default 16, ICE-lite mode toggle, keepalive
  via STUN Binding every 6 s with configurable retry-to-disconnect
  (`alive_binding_retries`, default 5 → **~30 s to declare peer death**,
  vs our 200 ms pong deadline).
- **TURN**: RFC 5766 + RFC 8656 (README); **TURN-over-TCP and TURNS
  (TURN-over-TLS) added in v1.5.0** (changelog; `tcp_support` flag;
  `insecure_skip_turn_cert_verify` for lab TURN servers;
  `transport/tcp.c`+`tls.c` are the open transports). So **UDP-blocked
  networks are covered** — genuinely more than libpeer upstream has.
- **DTLS-SRTP**: open source over mbedTLS (`dtls_srtp.c`), SRTP via
  `espressif/esp_libsrtp` registry dep; needs
  `CONFIG_MBEDTLS_SSL_PROTO_DTLS=y`, `CONFIG_MBEDTLS_SSL_DTLS_SRTP=y`.
- **RTP reliability** (all in the blob): NACK send/handle, jitter buffer
  (`rtp_jitter.c.obj`, default `cache_timeout` **100 ms**, `resend_delay`
  20 ms), sender retransmission (`rtp_rolling_buffer.c.obj`,
  `max_resend_count` 3), RTCP incl. PLI. App-facing frames carry only
  `pts/data/size` (`esp_peer.h:108,117`) — **sequence numbers, RTCP stats,
  and jitter internals are not exposed**.
- **SCTP data channels**: reliable/unreliable, ordered/unordered, SACK,
  fragmentation (blob `sctp.c.obj`; not usrsctp — self-contained).
- **Audio codecs**: OPUS, G711 A/U. Video: H.264, MJPEG.

## 4. libpeer (`sepfy/libpeer`) on its own

- **6,292 lines** of C in `src/` + `include/` (MIT). Deps: mbedtls, libsrtp,
  usrsctp, cJSON, coreHTTP, coreMQTT (submodules).
- **Maturity**: last commit **2025-09-29** in the clone; ~1.5 k stars; issues
  still being filed in 2026 but development has clearly slowed
  ([repo](https://github.com/sepfy/libpeer), [issues](https://github.com/sepfy/libpeer/issues)).
- **Feature floor is much lower than esp_peer**: `rtcp.c` is **58 lines**
  (advertises `nack`/`pli` in SDP, no real RTCP machinery); **no jitter
  buffer, no retransmission**; TURN over **UDP only** (relay allocation in
  `agent.c:195-233`; no TCP/TLS candidate machinery); fixed 20 ms audio
  cadence (`config.h: CONFIG_AUDIO_DURATION 20`).
- **Its one unique virtue for us: it is POSIX-portable** — builds and runs
  on a Linux/macOS host (`examples/generic`), which is why the original
  OpenAI SDK could offer `idf.py set-target linux`. It is the only
  host-testable embedded WebRTC option in this whole space.
- **Role under the OpenAI SDK**: `openai/openai-realtime-embedded-sdk`'s
  `main` branch was gutted to a README that now points at Espressif's
  `openai_demo`; the real code lives on the frozen `esp32` branch (last
  commits Jan 2025): libpeer as a git submodule + esp-libopus, legacy
  `driver/i2s.h`, **8 kHz** sample rate, Opus bitrate 30 kbps, complexity 0,
  no AEC (`src/media.cpp:7-19`). It is a proof-of-concept, superseded —
  the report's Tier-2 "steal end-to-end wiring" is now better served by
  Espressif's own demo. **NUANCED** on the report: "built on libpeer, needs
  PSRAM" is right for the branch, but the SDK is effectively archived.

## 5. The WHIP demo and the Cloudflare/xAI reality check

- `whip_demo`: standard WHIP publish client — POST SDP offer to a WHIP
  endpoint with Bearer token, PATCH for trickle candidates, DELETE to end
  (`components/esp_webrtc/impl/whip_signal/whip_signaling.c`, 307 L; demo
  README documents ICE-lite servers and mediaMTX testing). Demo hardware is
  the **P4** camera board, but the signaling is target-independent and
  audio-only WHIP on S3 is just configuration.
- **Cloudflare**: Workers still cannot do UDP — `connect()` is TCP-only;
  inbound/outbound UDP remains "planned"
  ([Cloudflare blog](https://blog.cloudflare.com/workers-tcp-socket-api-connect-databases/),
  [community](https://community.cloudflare.com/t/does-cloudflare-support-tcp-and-udp-servers/812315)).
  So a WebRTC device leg can never terminate on our worker; it would
  terminate on **Cloudflare Realtime (SFU + TURN service, WHIP/WHEP)** or an
  external SFU, adding a _new_ system between device and worker. That
  evaluation belongs to the server-side report; device-side conclusion: the
  ESP WHIP client is compatible with Cloudflare's WHIP ingest if we go that
  way.
- **xAI**: the Grok voice agent API connects via **WebSocket
  (`wss://api.x.ai/v1/realtime`), SIP, or LiveKit** — there is no
  OpenAI-style HTTP-SDP WebRTC endpoint
  ([xAI docs](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)).
  A direct device→xAI WebRTC session in the openai_demo shape is therefore
  **not possible today**; the WebRTC-shaped route to Grok is LiveKit, and
  there is a first-party **`livekit/client-sdk-esp32`** built on this same
  esp_peer stack ([repo](https://github.com/livekit/client-sdk-esp32),
  [LiveKit blog](https://livekit.com/blog/livekit-sdk-for-esp32-bringing-voice-ai-to-embedded-devices))
  — same blob, same licensing, plus LiveKit's protocol on top.

## 6. Comparison against our v1/v2 PCM path

Baseline (from `inputs/agent-reports/firmware-audio.md` + fresh `wc -l` on
the worktree): portable PCM core (`pcm_lane.c` 696, `pcm_uplink_sender.c`
462, `pcm_uplink_conductor.c` 445, `spsc_ring.c` 257, `websocket_tx.c` 394,
`websocket_frame_writer.c` 190, `websocket_rx.c` 190, `pcm_websocket.c` 63)
≈ **2,700 lines** + ~1,270 header lines; ESP platform layer
(`pcm_transport.c` 1,120 + `websocket_connection.c` 685) ≈ **1,800**;
capture/playback stack (realtime_playback 1,863 + direct_i2s 710 +
bounded_capture 258 + i2s backend 689 + m5sticks3_direct_audio 802) ≈
**4,300**. Total ≈ **10 k lines ours**, plus the big virtual-clock test
suites (conductor test 1,190 L, playback test 1,989 L, …).

**(a) What esp-webrtc would replace / can't replace.** It would replace the
PCM websocket pair-half: lane, sender, conductor, peer-delivery guard,
websocket tx/rx, pcm_transport, websocket_connection (~5.8 k src) and — if
we also adopted esp_capture/av_render — most of the capture/playback stack
(~4.3 k). It **cannot** replace: the Cap'n Web control lane (`/api` itx
mount, capabilities, events) — that talks to OUR worker and must survive
provider hangups, so it stays as a separate WebSocket regardless; the
device-event machinery; provisioning; and all worker-side logic. It also
brings no equivalent of our epoch/generation fencing into physical DMA — the
`av_render` reset on disconnect (`esp_webrtc.c: stop_stream → av_render_reset`)
is a coarse flush, not our acknowledged flush-fence.

**(b) Code-size/complexity delta.** Adopt: delete ~10 k of ours, add ~26 k
lines of open vendor source (esp_webrtc 10.3 k + esp_peer shim 5.8 k +
av_render 6.2 k + codec_board 3.1 k + media_lib_utils 1 k) **plus** the
50 KB closed engine (~15–25 k LOC equivalent) **plus** registry deps
(esp_capture, gmf_audio, esp_audio_codec, esp_libsrtp, esp-sr) **plus**
~1–1.5 k of our own glue (the demo's main is 1.5 k for a hardcoded, global-
static, console-driven app — none of it is product-shaped). Net: far more
total code in the image, far less of it ours to maintain. Complexity moves
from "ours, white-box, proven on the rig" to "vendored, part-black-box,
vendor-paced". Requirement 1 (less code/complexity) is only satisfied under
a reading where vendor code is free; the plan's reading (complexity
concentration, G3) does not treat it as free.

**(c) Host-testability — the decisive axis.** esp_peer/esp_webrtc are
**device-only**: the blob exists for 7 Espressif chips and nothing else, no
linux port anywhere in the repo, and the repo's own test rig is
pytest-embedded against physical DUTs (`conftest.py: SUPPORTED_TARGETS`,
chips only). Our entire transport-policy layer currently runs on the host
under a virtual clock with fault injection
(`tests/pcm_realtime_fault_harness_test.c`, conductor/sender/guard/lane
tests, playback descriptor-identity tests). Adopting esp-webrtc would move
uplink freshness, jitter handling, reconnection, and delivery confirmation
into an unobservable binary that can only be exercised on hardware. This is
a direct regression against requirement 2 and the plan's layer-1 testing
posture — the single strongest reason not to adopt. (If device-side WebRTC
were ever mandatory, **libpeer** is the host-testable path, at the cost of
no jitter buffer/NACK/TURN-TCP and a slowing upstream.)

**(d) Latency, honestly.** Both systems use 20 ms frames. esp-webrtc adds:
Opus algorithmic lookahead (~6.5 ms per RFC 6716) + encode/decode compute
(unmeasured on S3; the demo's own choices — complexity 0, 40 KB stacks,
dedicated tasks — say it is nontrivial) + an adaptive jitter buffer
defaulting to 100 ms cache. Ours adds: zero codec latency (raw PCM), a fixed
80 ms playback prebuffer (4×20 ms descriptors) with 200 ms freshness cap,
and ≤10 ms tick-poll jitter (known wart). On a clean LAN they are roughly a
wash device-side. Under Wi-Fi loss the trade inverts by philosophy: RTP/UDP

- NACK + jitter buffer smooths over loss with added delay and possibly
  replayed-late audio; ours refuses staleness (drop, epoch purge, reconnect-as-
  freshness-boundary) and takes gaps instead. For a voice agent, "fresh gap"
  was our chosen policy — RTP's continuity machinery actively fights it.
  One honest credit to WebRTC: a **direct** device→provider session removes
  our worker hop entirely, and raw-PCM-over-TCP has head-of-line blocking that
  SRTP-over-UDP simply doesn't have. Bandwidth: Opus ≈ 30 kbps vs raw PCM
  256 kbps + WS/TLS overhead — ~8× less airtime, which matters on congested
  RF, not on our office rig.

**(e) Resilience semantics — what RTP/RTCP gives free vs what it doesn't.**
Free with esp-webrtc: per-packet sequence numbers + timestamps (our D7 v2
16-byte header hand-builds exactly this), receiver jitter estimation,
loss-triggered NACK, decode-side PLC, and dual-task send/recv isolation.
NOT free: (1) **our peer-delivery guard's tail-of-utterance guarantee** —
RTCP RR cadence is seconds-scale; our guard barriers at 40 ms and replaces
the connection after 200 ms without confirmation, sized to "PTT release must
not lose the last words." No exposed RTCP surface can reproduce that (the
blob keeps RTCP internal); you'd rebuild it on the data channel. (2)
**Freshness-over-throughput**: the jitter buffer + max_resend 3 is the
opposite policy — it retransmits stale voice. (3) **Epoch purge/generation
fencing to physical DMA**: nothing equivalent. (4) Peer death detection is
~30 s (6 s STUN keepalive × 5 retries) vs our 2 s idle probe / 200 ms
replace. So RTP gives us the D7 header for free but takes away three
policies we consider load-bearing.

**(f) Memory/IRAM on top of 1-byte-free IRAM.** The openai_demo assumes
octal PSRAM + SPIRAM-hosted lwIP/mbedTLS and ~155 KB of task stacks; esp_peer
defaults want 400 KB send pool + 100 KB jitter + 200 KB DC caches (tunable;
absolute floor <60 KB without voice-grade features). DTLS adds a second
mbedTLS context alongside our existing TLS websockets. The blob's ~50 KB
.text appears to be flash-resident (no IRAM sections detected in the
archive), but Wi-Fi+DTLS+SRTP under load is exactly the cache/bus contention
regime the prior-art report warns about, and our Stick image has **1 byte of
IRAM free** and currently zero PSRAM enabled. Verdict: not impossible
(StackChan-class boards with PSRAM, after stage-1 PSRAM enablement), clearly
hostile on the current Stick image.

**(g) PTT/half-duplex and the event lane.** esp_webrtc assumes a
continuously-running full-duplex capture graph (`start_stream` on connect,
`esp_capture_sink_enable` toggles); nothing models our Stick's shared-pin
mic/speaker switchover (synchronous `i2s_del_channel` fence). PTT would be
emulated by muting/disabling the sink — the audio-session lifecycle would
live inside a vendor state machine rather than our audio controller. The
event lane is unaffected either way: Cap'n Web `/api` stays. The provider's
session events (transcription, turn lifecycle) would arrive on the
**data channel directly at the device** instead of at our worker — which
breaks requirement 8's server-side cross-posting to the project stream
unless the device re-uploads them.

## 7. Verdict — when would esp-webrtc be net-simpler?

**Net-simpler only if ALL of these hold:**

1. The far end is a genuine WebRTC/WHIP peer: OpenAI Realtime today; Grok
   only via LiveKit (using LiveKit's own esp32 SDK on this same stack);
   or Cloudflare Realtime SFU via WHIP — each of which inserts a new
   platform between device and worker.
2. We accept the device dialing the provider/SFU directly with on-device
   ephemeral tokens — abandoning D8's split (worker keeps device socket
   forever, provider dialed on demand), requirement 11's shape, and the
   worker's transcription cross-posting position.
3. We accept a device-only-debuggable media transport (losing the
   virtual-clock layer-1 suite for everything between mic and provider).
4. The board has an ES7210-style TDM hardware reference (StackChan yes,
   M5StickS3 no) and we adopt closed esp-sr AFE for AEC.
5. Espressif-products-only licensing + one closed blob in the shipped image
   is acceptable indefinitely.

Condition 2 is the architectural killer for the current plan: requirements
8/9/11 all assume our worker sits in the media path, and Workers cannot
speak UDP/WebRTC. **For v2 as planned: keep the PCM lane.** Revisit only if
the product later wants direct-to-provider sessions (e.g. an OpenAI-Realtime
SKU or a LiveKit-based Grok path) — then esp-webrtc (or LiveKit's SDK on top
of it) is clearly the right device stack and we'd keep the Cap'n Web lane
beside it, with our worker reduced to signaling/token-minting for the media
leg.

**Steal regardless of the verdict** (cheap, no adoption needed):

- The **ephemeral-token signaling pattern** (`client_secrets` → short-lived
  token → SDP/connection) — matches our "long-lived secret never on device"
  rule if we ever do device-dials-provider.
- The **ES7210 TDM `channel_mask = 1|2` + stereo-output-carries-reference**
  wiring (`media_sys.c:47-57,90-97`) as the concrete reference
  implementation for StackChan's D3/G13 AEC bring-up.
- Their **stack-size ground truth** (Opus enc/dec = 40 KB stacks, 25 KB
  peer loop) as budget inputs if we ever put Opus on-device.
- The `esp_peer_default_cfg_t` **jitter/cache tuning surface** as prior art
  for our per-board profile struct (stage 3): every latency/memory knob is
  runtime data, not templates.

## 8. Claim-verification table (vs `inputs/jonas-prior-art-report-2026-07-31.md`)

| Report claim                                                                                                   | Verdict                     | Evidence                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| esp-webrtc-solution exists with esp_webrtc/esp_peer/esp_capture (+media lib), OpenAI + WHIP + P2P demos, S3+P4 | **CONFIRMED**               | repo tree; solutions table in README; media layer is `av_render`+`media_lib_utils`, esp_capture is a registry component from esp-gmf                         |
| "esp_peer … with a default implementation and the ability to sit over libpeer"                                 | **NUANCED**                 | esp_peer is _derived from_ libpeer (README), not layered over it; the default impl is a **closed fork** (blob); alternate impls plug in via `esp_peer_ops_t` |
| IDF pin "believed v5.4+"                                                                                       | **NUANCED**                 | manifest floor `>=5.0`; READMEs: v5.4 release or master; IDF v6.0/mbedTLS 4.1 supported (changelog v1.5.3)                                                   |
| "officially-supported, modern" / active                                                                        | **CONFIRMED**               | HEAD merge commit dated 2026-07-31; esp_peer v1.5.3; 385 stars, 58 open issues                                                                               |
| OpenAI SDK (Tier 2): S3, libpeer, Opus, needs PSRAM                                                            | **NUANCED**                 | true of the frozen `esp32` branch (Jan 2025, 8 kHz, no AEC); `main` now just points at Espressif's demo — effectively archived                               |
| libpeer "de-facto embedded WebRTC, DTLS-SRTP via mbedTLS, ICE, SCTP, RTP"                                      | **CONFIRMED, with caveats** | 6.3 k LOC MIT; but no jitter buffer/retransmission (rtcp.c = 58 L), TURN UDP-only, activity slowed (last commit 2025-09-29)                                  |
| Demo AEC uses esp-sr AFE with ES7210 TDM hardware reference                                                    | **CONFIRMED**               | esp_capture depends on esp-sr ^2.4; `media_sys.c` S3 path = 4-ch TDM, mask 1\|2, stereo playback carries reference                                           |
| (Implied) transport is full ICE/DTLS-SRTP/RTP with TURN                                                        | **CONFIRMED + more**        | TURN RFC5766/8656, **TURN-over-TCP and TURNS since v1.5.0**, NACK/jitter/resend, SCTP data channels                                                          |
| Not stated in report: default impl is closed-source                                                            | **NEW FINDING**             | per-chip `libpeer_default.a`, 50 KB .text (agent/ice/stun/rtp/rtcp/sdp/sctp/jitter all inside); Espressif-products-only license on every repo component      |
| Jonas's "UDP on Cloudflare Worker" hunch                                                                       | **CONFIRMED as blocker**    | Workers `connect()` is TCP-only, UDP unshipped; device-side WebRTC needs Cloudflare Realtime SFU/LiveKit/direct-to-provider, not the worker                  |
| xAI reachable over WebRTC like OpenAI                                                                          | **REFUTED**                 | xAI voice agent = WebSocket/SIP/LiveKit only (docs.x.ai); no HTTP-SDP endpoint                                                                               |

Sources (web): [espressif/esp-webrtc-solution](https://github.com/espressif/esp-webrtc-solution) ·
[esp_capture on the registry](https://components.espressif.com/components/espressif/esp_capture) ·
[esp-gmf/packages/esp_capture LICENSE + manifest](https://github.com/espressif/esp-gmf/tree/main/packages/esp_capture) ·
[esp_audio_codec registry](https://components.espressif.com/components/espressif/esp_audio_codec) ·
[sepfy/libpeer](https://github.com/sepfy/libpeer) ·
[xAI voice agent docs](https://docs.x.ai/developers/model-capabilities/audio/voice-agent) ·
[Cloudflare Workers TCP `connect()`](https://blog.cloudflare.com/workers-tcp-socket-api-connect-databases/) ·
[Cloudflare community: no UDP servers](https://community.cloudflare.com/t/does-cloudflare-support-tcp-and-udp-servers/812315) ·
[livekit/client-sdk-esp32](https://github.com/livekit/client-sdk-esp32) ·
[LiveKit ESP32 blog](https://livekit.com/blog/livekit-sdk-for-esp32-bringing-voice-ai-to-embedded-devices)
