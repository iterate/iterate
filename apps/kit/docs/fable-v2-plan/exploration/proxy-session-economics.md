# Proxy/session economics, resilience, and server-side AEC — exploration (reqs 9, 10, 11)

Status: wide exploration artifact for the Kit v2 plan, 2026-07-31. Covers brief
requirements 9 (allow server-side AEC), 10 (degrade/recover gracefully; devices
maintain both websockets at all times), 11 (cannot afford an always-on Grok
session; worker hangs up after inactivity while PCM keeps flowing), plus the
requirement-8 seam for cross-posting non-PCM events to streams.

All file:line references are from the current `c-capabilities` working tree.
Paths without a prefix are relative to `apps/kit/`. Prior-art paths are under
`~/src/github.com/`.

---

## 0. Ground truth: what v1 actually does (verified in source)

### 0.1 There are TWO proxies, and the deployed one is not the documented one

The architecture review and host-pipeline report describe `DevicePcmProxy`
(`src/voice/device-pcm-proxy.ts`, 931 LOC). The _deployed_ userspace path is a
second, independent implementation:

|                    | `DevicePcmProxy` (host/dev/e2e)                                                                                                          | `KitVoiceWorker` + `PcmSessionBridge` (deployed DO)                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location           | `src/voice/device-pcm-proxy.ts` (931 LOC)                                                                                                | `src/userspace/config-worker/worker.ts` (320) + `pcm-proxy.ts` (372) + `providers.ts` (313) + `device-events.ts` (161) + `routes.ts`                                        |
| Used by            | `LocalDevicePeerServer` (`src/device/local-device-peer-server.ts:40-56`), `scripts/device-e2e.ts`, `scripts/voice-e2e.ts`                | the config-worker Durable Object serving the real `/pcm` (`worker.ts:43-52`)                                                                                                |
| Downlink buffering | bounded 8-frame ring + startup watermark + two delivery modes (`device-pcm-proxy.ts:14,24,62`)                                           | **no queue at all** — partial-frame reassembly only, `bufferedAmount` as the only backlog bound (`pcm-proxy.ts:39-52,59`, limit 16×640 B, `worker.ts:22`)                   |
| PTT state machine  | `#inputActive/#responseActive/#responseRequested/#suppressDownlink` (with the two known R9 defects at `device-pcm-proxy.ts:429`, `:238`) | leaner: `#interrupted` + `#responseActive`; `response.cancel` only when a response was observed (`pcm-proxy.ts:131-144`)                                                    |
| Device events      | none (driven externally)                                                                                                                 | subscribes to `kit.m5sticks3.subscribeToEvents` through the project capability host and drives `inputStarted/inputStopped` (`worker.ts:240-257`, `device-events.ts:97-161`) |
| Session registry   | Map keyed by session id, replace-on-reconnect (`device-pcm-proxy.ts:251-252`)                                                            | single `#activePcm`, replaced with close code 4001 (`worker.ts:44,122`)                                                                                                     |

Any v2 design must either merge these or explicitly bless the split. This doc
designs against the _worker_ variant (it is the thing requirement 11 names:
"the config worker userspace server side") and treats `DevicePcmProxy` as the
host-side lab harness.

### 0.2 Provider lifetime is welded to device-socket lifetime — the exact thing req 11 forbids

- The worker dials Grok **inside the device's WebSocket upgrade**: provider
  connect happens before the `WebSocketPair` is created, and a dial failure
  502-rejects the device upgrade (`worker.ts:99-115`; same shape in
  `device-pcm-proxy.ts:202-210`).
- Either socket closing closes the counterpart: device close → provider close
  (`pcm-proxy.ts:97-103`), provider close → device close with 1011
  (`pcm-proxy.ts:104-110`); `DevicePcmProxy` does the same in `#closeFrom`
  (`device-pcm-proxy.ts:843-873`).
- So today: device reconnects when Grok hiccups, and Grok is billed for as long
  as the device stays connected. Both are wrong for v2.

### 0.3 The Grok dial sequence (the thing we will be re-doing on demand)

`connectGrokRealtimeVoice` (worker version, `providers.ts:110-171`; host
version `src/voice/grok-realtime-voice.ts:32-112`):

1. HTTPS `POST https://api.x.ai/v1/realtime/client_secrets` with
   `expires_after: { seconds: 300 }`; in the worker the long-lived key never
   appears — it is an Iterate egress placeholder
   `Bearer getSecret("/secrets/kit/xai-api-key")` (`providers.ts:116-124`).
2. WS connect `wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0`
   carrying the short-lived secret as subprotocol
   `xai-client-secret.<value>` (`providers.ts:136-141`), 10 s open timeout
   (`:144`).
3. `session.update` fixing binary headerless PCM16 @16 kHz both ways,
   `grok-transcribe` input transcription, `turn_detection: null` (manual) for
   the Stick (`providers.ts:145-165`; the worker hardcodes manual at
   `worker.ts:210`). **No ack is awaited** — the socket is returned right after
   `send()` (`providers.ts:166`; flagged in host-pipeline.md too, including the
   sibling defect that a _failed_ setup closes with code 1000).

### 0.4 xAI facts found (2026-07-31)

- **Pricing:** `grok-voice-think-fast-2.0` is **$0.08 / audio minute
  ($4.80/hour)**; `grok-voice-*-1.0` was $0.05/min; the `grok-voice-latest`
  alias moves to 2.0 on 2026-08-05. **Max session duration 30 minutes**, 100
  concurrent sessions per team. (Sources: aicostcheck.com xAI pricing guide
  2026, eesel.ai Grok voice pricing breakdown; docs.x.ai voice page itself
  carries neither pricing nor limits.) The "per audio minute" unit is
  ambiguous — per _connected_ minute vs per _processed-audio_ minute. Cost
  models below carry both; **measure with a deliberately idle session before
  the v2 plan freezes** (open a session, send nothing for 10 min, read the
  bill).
- **Server VAD:** `turn_detection: {type: "server_vad"}` with defaults
  threshold 0.5, `prefix_padding_ms` 300, `silence_duration_ms` 200 (LiveKit
  xAI plugin docs; docs.x.ai shows only the type field).
- **AEC:** no mention of echo cancellation, echo reference input, or device
  speaker echo anywhere in the xAI voice docs (checked
  docs.x.ai/developers/model-capabilities/audio/voice). Same posture as OpenAI
  Realtime: echo handling is the client's problem. Option "provider does the
  AEC" (§3.3.3) is therefore **not available today** and stays parameterized.
- The 30-minute cap means even a hypothetical "always-on" design must rotate
  sessions; there is no such thing as a permanently-open Grok socket.

### 0.5 Firmware reconnect machinery v2 builds on

- `retry_gate` (`firmware/components/core/src/retry_gate.c`, 76 LOC): pure
  timestamp gate, exponential 2× with saturating compare-before-double
  (`:48-59`), **deliberately no jitter** — "fleet-level jitter policy needs
  entropy/device identity and belongs in the outer platform layer"
  (`retry_gate.c:6-12`).
- Shared policy: WS retry 250 ms → 30 s
  (`firmware/platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_websocket_policy.h:62-63`);
  peer-delivery guard: PING per 4 frames, ≤8 unconfirmed (160 ms), forced
  barrier at 40 ms, replace at 200 ms without PONG, idle probe 2 s / 1 s
  timeout (`:56-61`), with compile-time ordering proofs (`:81-109`).
- Control transport: READY-gated backoff reset — a TCP/TLS/upgrade success does
  **not** reset the gate; only the application publishing READY after
  authenticate+mount does (`firmware/platforms/iterate_esp_idf/itx_transport.c:738-748`).
  Wi-Fi loss closes the WS eagerly (`:798-805`); Wi-Fi retry is a
  hand-rolled doubling backoff duplicated twice (`:757-768`, `:775-784` —
  already flagged as R13).
- PCM transport: **resets its gate on mere socket connect**
  (`firmware/platforms/iterate_esp_idf/pcm_transport.c:616-618`) — unlike
  control. An endpoint that accepts TLS+upgrade and then dies immediately
  resets PCM backoff every attempt → reconnect churn at connect rate. A v2
  fix: reset only on first _confirmed_ delivery (first peer-guard PONG or
  first downlink frame). Cheap, and symmetric with control's READY gating.
- PCM start is attempted **once**, after the first control READY
  (`firmware/targets/m5sticks3/main/main.cpp:1262-1284`); after that the PCM
  transport owns its own reconnects forever. If that single
  `pcm_transport_start` fails (allocation/task creation), PCM never starts
  until reboot — a real (if unlikely) gap for req 10.
- Reconnect is a freshness boundary, not retransmission: on socket death the
  conductor abandons the generation, purges ring + retained frame, then closes
  the socket to kill opaque TLS bytes, in that order (`pcm_transport.c:560-584`).

### 0.6 What flows when: important asymmetry between device shapes

The M5StickS3 is strictly half-duplex PTT: capture runs only while the button
is held (`firmware/platforms/iterate_m5unified/include/iterate/kit/platforms/m5unified.hpp:19-28`).
So for the Stick, "PCM keeps coming" (req 11) means _bursts during presses_,
and idle means literally zero uplink frames. The StackChan/duplex shape streams
capture continuously (`firmware/components/core/src/audio.c:20-23` keeps
capture running in full-duplex mode precisely so an AEC gets a continuous
timeline). The on-demand-provider design must be correct for both traffic
shapes; the cost/wake design differs sharply between them (§1.4).

---

## 1. (a) Always-on device sockets, on-demand provider

### 1.1 The structural refactor: split "device lane" from "upstream attachment"

Today the bridge is born holding both sockets (`pcm-proxy.ts:69-116`) and dies
with either. v2 inverts this: the **device lane** (accepted `/pcm` socket +
its partial-frame reassembly + counters) lives as long as the device socket;
an **upstream session** attaches to and detaches from it. Provider generations
come and go under a stable device generation.

Proposed state machine for the upstream side (per device lane):

```
        ┌────────────────────────────────────────────────────────┐
        │                                                        ▼
  NO_UPSTREAM ──trigger──► DIALING ──open+ack──► ACTIVE ──idle T──► DRAINING
        ▲                     │                    │  ▲               │
        │        dial failed  │      provider died │  │ activity      │ provider
        │                     ▼                    │  │ during drain  │ closed
        └───────────────── COOLDOWN ◄──────────────┘  └───────────────┘
                     (retry-gate delay, then back to NO_UPSTREAM;
                      a fresh trigger during COOLDOWN waits out the gate)
```

- **NO_UPSTREAM** — device sockets healthy, no provider. Inbound PCM handled
  per §1.2. Timer-free.
- **DIALING** — mint (if no pre-minted secret) → WS connect → `session.update`
  → **await `session.updated`** (v2 change; today nothing is awaited,
  `providers.ts:145-166`). Inbound PCM during DIALING goes to the preroll ring
  (§1.2). Bounded by the existing 10 s open timeout plus a 3 s ack timeout.
- **ACTIVE** — the current relay behavior. Every uplink frame, control send,
  or provider event resets the inactivity clock. Also owns the **session-age
  rotation**: at ~25 min (30-min xAI cap) mark "rotate at next turn boundary"
  and re-dial at the next `response.done`, so the cap never fires mid-turn.
- **DRAINING** — inactivity timer fired but a response may still be in flight:
  refuse new turn commits, wait for `response.done` (bounded, e.g. 30 s),
  then `provider.close(1000)`. Any device activity (PTT press, energy trigger)
  during DRAINING cancels the drain and returns to ACTIVE — the session is
  still paid for, use it.
- **COOLDOWN** — mirror of the firmware's `retry_gate` on the server side
  (250 ms → 30 s, jittered here since the worker has entropy): protects xAI
  from mint/dial storms and us from burning mint quota during provider
  outages. A dial failure in COOLDOWN also emits a device-visible signal
  (§1.5) so a pressed PTT doesn't feel dead silently.

Device-socket close in any state tears down the lane; provider close in ACTIVE
→ NO_UPSTREAM **without touching the device socket** — send the zero-length
EOS first so the device ends playback at a clean frame boundary instead of the
underrun/poison path (this alone is strictly more graceful than today's
`close(1011, "Provider socket closed.")` at `pcm-proxy.ts:104-110`).

Where the timer lives: `KitVoiceWorker` is a Durable Object; use
`ctx.storage.setAlarm()` for the inactivity deadline rather than `setTimeout`
so the hang-up survives DO eviction. (With an idle Stick sending zero frames,
the DO can actually hibernate between turns; the firmware's idle peer probes
are RFC 6455 PINGs, `esp_idf_websocket_policy.h:60-61`, which workerd answers
at the runtime layer without waking the DO. A duplex device streaming 50
frames/s never hibernates; DO duration cost ≈ 0.125 GB × 86,400 s =
10,800 GB-s/day ≈ **$0.135/day/device** at $12.50/M GB-s — noise next to Grok.)

### 1.2 Inbound device PCM with no upstream: four options

| Option                       | Mechanism                                                                                                       | Cost                                      | Verdict                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Discard + count**       | drop frame, `++noUpstreamDroppedFrames`                                                                         | ~0                                        | Baseline; correct for downlink-only periods, wrong alone for PTT (loses the utterance head during DIALING)                                                                                                                                                 |
| **B. Preroll ring**          | bounded ring of the last N frames (2 s = 100 × 640 B = 64 KB); flushed into the fresh provider socket on attach | 64 KB DO memory, ~0 CPU                   | **Recommended.** Directly stolen from xiaozhi's 2 s wake-word preroll upload (`~/src/github.com/78/xiaozhi-esp32/main/audio/wake_word_audio_cache.cc:26-27`, upload at `application.cc:890-897`) — it exists to kill exactly this class of head-truncation |
| **C. Energy gate**           | compute frame RMS; below threshold → discard, above → treat as a dial trigger + feed ring                       | ~320 mul-adds/frame ≈ 1-2 µs in JS — free | Needed for duplex devices only; it is the _trigger_, with B as the _buffer_. Threshold + 300 ms hangover; false-trigger rate is a first-class metric because every false trigger costs a mint+dial                                                         |
| **D. Server-VAD-armed wake** | keep a _cheap_ always-on upstream (e.g. a Grok 1.0 session or a non-LLM VAD service) just for wake decisions    | $$$ or new infra                          | Rejected for v2: reintroduces an always-on paid session or a whole new service to run a VAD we can compute in 2 µs ourselves                                                                                                                               |

Recommended composition: **A for downlink-idle, B always, C as the duplex
trigger.** For the Stick, the trigger is not energy at all (§1.3), and B means
zero words lost even when the dial takes a full second.

Sketch (worker side, replaces the welded constructor):

```ts
type UpstreamState =
  | { tag: "no-upstream" }
  | { tag: "dialing"; startedAt: number; abort: AbortController }
  | { tag: "active"; socket: WebSocket; idleDeadline: number; openedAt: number }
  | { tag: "draining"; socket: WebSocket; drainDeadline: number }
  | { tag: "cooldown"; gate: RetryGate }; // jittered 250ms→30s, mirrors firmware retry_gate.c

class DeviceLane {
  readonly #device: WebSocket;                 // lives for the device generation
  readonly #preroll = new FrameRing(100);      // 2s, drop-oldest (xiaozhi wake cache shape)
  #upstream: UpstreamState = { tag: "no-upstream" };

  onDeviceFrame(frame: Uint8Array) {
    switch (this.#upstream.tag) {
      case "active":
        this.#upstream.idleDeadline = now() + IDLE_MS;    // any uplink is activity
        this.#send(this.#upstream.socket, frame);
        return;
      case "no-upstream":
      case "cooldown":
        this.#preroll.push(frame);
        this.#maybeDial("uplink-pcm");                    // trigger §1.3(2)
        return;
      case "dialing":
        this.#preroll.push(frame);                        // flushed on attach
        return;
      case "draining":
        this.#cancelDrain();                              // still paid for — reuse it
        this.#send(this.#upstream.socket, frame);
        return;
    }
  }

  async #attach(socket: WebSocket) {
    await this.#awaitSessionUpdated(socket, 3_000);       // v2: actually ack
    for (const frame of this.#preroll.drain()) socket.send(frame); // ≤64KB burst
    this.#upstream = { tag: "active", socket, idleDeadline: now() + IDLE_MS, openedAt: now() };
    await this.#ctx.storage.setAlarm(this.#upstream.idleDeadline); // DO alarm, eviction-proof
  }

  onProviderClosed() {                                    // device socket untouched
    this.#sendDevice(EOS);                                // clean frame-boundary stop
    this.#upstream = { tag: "no-upstream" };
    this.#postStreamEvent({ type: "voice.session.ended", ... }); // §4
  }
}
```

This also deletes the `#suppressDownlink` bug class outright (the R9 defect at
`device-pcm-proxy.ts:429` where a text turn in server-vad mode blackholes
downlink forever): suppression-by-flag is replaced by truncation-by-detach —
clear queue, send EOS, done.

### 1.3 What re-arms a dial

Enumerated, all of which should funnel into one `#maybeDial(trigger)`:

1. **`pushToTalk.started` device event** over the existing control-plane
   subscription (`worker.ts:240-257` → `device-events.ts:143-148`). Earliest
   possible signal — fires before the first mic frame (capture start costs the
   Stick an I2S teardown fence first, `m5unified.cpp:297-341`), buying the
   dial ~100-200 ms of head start.
2. **First uplink PCM frame with no upstream** (implicit demand). The most
   robust trigger: needs no control plane at all, so it still works in the
   degraded PCM-up/control-down state (§2.2). For the Stick this fires only
   during a press by construction.
3. **Explicit RPC** — `requestTextResponse` / a future `voice.wake` capability
   call (assistant-initiated speech, timers, announcements).
4. **Energy gate over threshold** (duplex devices, §1.2-C).
5. Later: wake-word event from the device (xiaozhi's shape) — arrives as just
   another device event on the same queue, no new mechanism.

Use 1 _and_ 2 together: 1 is an optimization, 2 is the correctness backstop.

### 1.4 Re-dial latency budget, and how to hide it

Estimated cold-dial budget from a Cloudflare DO (**estimates — must be
measured**; instrument `#maybeDial` with per-phase timestamps and run 20 dials
via `scripts/device-e2e.ts`, which already logs structured lines):

| Phase                                | Estimate        | Notes                                                                                                                                                       |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS mint (`client_secrets`)        | 150-450 ms      | TCP+TLS to api.x.ai + server mint; egress placeholder adds one internal hop (`providers.ts:116-124`)                                                        |
| WS connect (TCP+TLS+upgrade)         | 100-250 ms      | no connection reuse across dials                                                                                                                            |
| `session.update` → `session.updated` | 30-150 ms       | today fire-and-forget (`providers.ts:145-166`); v2 should await the ack — sending PCM before the session is configured risks the provider misreading format |
| **Total cold**                       | **~300-850 ms** |                                                                                                                                                             |
| **With pre-minted secret**           | **~150-400 ms** | mint drops out                                                                                                                                              |

Hiding it:

- **Pre-minted secret pool.** Secrets live 300 s (`providers.ts:118`). A DO
  alarm re-mints every ~4 min while the device lane is up. Mints are HTTPS
  calls with no session cost. Cuts the visible budget roughly in half. (Verify
  xAI doesn't rate-limit or bill mints; nothing in docs says it does.)
- **Press-duration masking + preroll flush** (the big one). With manual turn
  detection, nothing is needed from the provider until `input_audio_buffer.commit`
  at release (`pcm-proxy.ts:146-153`). Median PTT utterances are >1 s; the
  dial completes during the press, the preroll ring backfills the head, and
  the added end-to-end latency is `max(0, dialTime − pressDuration)` — usually
  zero. Only sub-400 ms taps pay anything.
- **Local earcon, not provider greeting.** The device already owns capture
  start; a local "listening" chirp (a stored 100 ms asset through the existing
  playback path) acknowledges the press instantly regardless of upstream
  state. Never ask the provider to acknowledge presence.
- **Greeting suppression + context replay.** Fresh sessions must not say
  "hello again": keep `instructions` explicit about never greeting
  (`providers.ts:160`), and on re-dial replay recent conversation turns as
  `conversation.item.create` text items before the first commit — we already
  receive input transcriptions (`grok-transcribe`, `providers.ts:153`) and
  response transcripts as provider events, so the worker can retain a bounded
  transcript (say last 20 turns) per device lane. This converts "hang up after
  inactivity" from "forget the conversation" into "pause the conversation" —
  without it, req 11's cost saving silently costs conversational memory.
  (~40 LOC; the single most user-visible piece of this whole section.)

### 1.5 Policy variants with cost/latency numbers

Parameterize: `C` = $/min connected (0.08 today), `D` = dial time (~0.5 s
cold), `T_idle` = inactivity window. If billing turns out to be
per-processed-audio-minute instead of per-connected-minute, V-B/V-D collapse
toward V-A's cost and `T_idle` can be generous — measure first (§0.4).

**V-A — press-scoped session (aggressive).** Dial on trigger, hang up at
`response.done` + 5 s grace.

- Cost: 50 turns/day × ~30 s ≈ 25 min → **$2.00/day**.
- Latency: every turn is a cold dial, masked per §1.4; multi-turn context via
  transcript replay only.
- Risk: replay fidelity becomes conversation quality; rapid back-and-forth
  pays repeated mints.

**V-B — idle-window session (recommended default).** `T_idle` = 90 s,
DRAINING semantics as §1.1.

- Cost: a 10-turn/5-min conversation bills ~6.5 min; 8 conversations/day →
  ~52 min → **$4.16/day**. Worst case (pathological 90 s-spaced single turns)
  degrades toward always-on within the interaction period only.
- Latency: first turn per conversation pays one masked dial; warm turns pay
  zero. Context is native within the window, replayed across windows.
- This is xiaozhi's own shape: it opens the audio channel on demand and closes
  it after the interaction, with a power timer gating codec state at 15 s idle
  (`audio_service.cc:778-796`).

**V-C — duplex VAD-armed (StackChan later).** Continuous device PCM; energy
gate (§1.2-C) triggers dial; `T_idle` = 45-60 s; preroll ring mandatory
because the utterance head _always_ predates the dial.

- Cost: driven by false-trigger rate F: cost/day ≈ (true + F) × (avg session).
  Instrument F from day one; tune threshold/hangover against it.
- Latency: gate detection (~100-300 ms of speech) + dial − prefix_padding.
  Server VAD's 300 ms prefix padding (§0.4) means the provider tolerates a
  slightly ragged head; the preroll flush covers the rest.

**V-D — always-on (rejected, for the record).** 24 h × $4.80/h =
**$115/day/device**, plus forced rotation every 30 min anyway (§0.4). This is
the option req 11 exists to forbid; it survives only as the comparison row.

### 1.6 Roads not taken (a)

- **Hold-open with silence injection** (send comfort noise to keep the session
  "warm"): pays full price for silence and probably counts as audio minutes —
  strictly worse than V-B.
- **Provider socket pooling across devices**: realtime sessions carry
  conversation + voice state; a pooled socket is a different conversation.
  Meaningless.
- **Device-controlled hangup** (device RPC tells worker to disconnect
  provider): wrong owner — cost policy is a server concern, and the device
  cannot see billing or provider health. The device only ever expresses
  demand.
- **Keeping `DevicePcmProxy`'s host-paced clock in the on-demand design**: the
  worker bridge already has no clock (`pcm-proxy.ts:39-52`), and the firmware
  owns playout (`device-pcm-proxy.ts:707-718` concedes this). On-demand
  attach/detach makes a host media clock even more wrong — a fresh upstream
  must never inherit a stale deadline grid. Device-clocked forwarding only.

---

## 2. (b) Device-side always-maintain

### 2.1 Reconnect ladders — build on retry_gate + generation fencing

What exists is already the right skeleton (§0.5). v2 changes, smallest first:

1. **Fix the PCM gate-reset asymmetry**: reset PCM backoff on first confirmed
   delivery (first peer-guard PONG or first downlink frame), not on socket
   connect (`pcm_transport.c:616-618` vs control's `itx_transport.c:738-748`).
   ~10 LOC + a host test in `tests/esp_idf_pcm_transport_test.c`.
2. **Add fleet jitter at the platform layer**, where `retry_gate.c:6-12` says
   it belongs: `delay += hash(deviceId, attempt) % (delay/4)`. Prevents
   synchronized reconnect storms after an AP/worker restart. ~15 LOC.
3. **Unify the Wi-Fi backoff onto `retry_gate`** (kills the duplicated inline
   doubling at `itx_transport.c:757-768,775-784`; already R13).
4. **Retry `pcm_transport_start`**: the once-only attempt
   (`main.cpp:1262-1284`) becomes a retry-gated attempt so a transient start
   failure can't permanently kill audio until reboot.
5. **Escalation ladder with an explicit last rung.** Today the ladders retry
   forever at 30 s; `fatal_failure_latched` (e.g. stack-floor breach,
   `pcm_transport.c:630-635`) stops a transport permanently until power cycle.
   Steal ESPHome's posture: its `api.reboot_timeout` (default 15 min) reboots
   the device when no client connects — the honest last rung for an appliance.
   For us: **if (no control READY for N minutes) OR (fatal latch) → log to
   SD (req 5) → reboot.** With an allocation-free static image, reboot is
   ~2-3 s and is the cheapest full-state reset we own. N default 15 min,
   provisioning-tunable (R6's knob surface).

Ladder as it should read end-to-end (per lane):

```
socket attempt (250ms → 30s, jittered)          retry_gate, per socket
  └─ backoff reset only on proven service       READY (control) / first delivery (PCM)
wifi loss → close sockets eagerly               itx_transport.c:798-805 (keep)
wifi retry (1s → 60s, jittered)                 unified onto retry_gate
no control READY for 15 min OR fatal latch      SD-log + reboot (new)
```

### 2.2 Degraded-mode state matrix

Key structural fact: physical PTT edges drive the audio controller **locally**
through the device event queue (`firmware/devices/m5sticks3/m5sticks3.c:41-87`)
— capture/playback control never depends on the network. What the network adds
is (i) the worker learning of the edges (control lane) and (ii) audio actually
going anywhere (PCM lane).

| State                                                                        | Capture policy                                                                                                                                  | Playback policy                                                                                   | Event policy                                                                                                                                                   | Worker-side effect                                                                                                                                                                    | UI/LED (req 12 pluggable I/O)                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Both up** (nominal)                                                        | normal                                                                                                                                          | normal                                                                                            | events flow to subscriber                                                                                                                                      | full function                                                                                                                                                                         | idle/solid                                                                                                                                             |
| **Control up, PCM down**                                                     | PTT press accepted locally; frames dropped at `sendPcm`'s READY gate (`main.cpp:368-384`) with counters; optionally capture-to-SD (req 5) later | none possible; controller keeps discard-while-suspended behavior                                  | events still delivered (subscription is on control)                                                                                                            | worker sees PTT edges with no PCM lane → must NOT commit turns; upstream stays NO_UPSTREAM                                                                                            | double-blink amber "voice offline"; short error earcon on press                                                                                        |
| **PCM up, control down**                                                     | press works locally; frames flow to worker                                                                                                      | downlink works                                                                                    | events queue device-side: `device_event_stream`'s bounded coalescing queue replaces-newest + counts (`device_event_stream.c:90-108`); SD log preserves history | worker gets PCM but **no PTT edges** → in manual mode, commit never fires. Two mitigations: (1) dial-trigger 2 (§1.3) still opens upstream; (2) **in-band commit marker** — see below | slow-blink amber; voice may still work if in-band commit ships                                                                                         |
| **Both sockets down, Wi-Fi up**                                              | local press → error earcon; drop + count (SD memo recording is a future option, not v2)                                                         | drain ring then clean stop (EOS never arrives → underrun path; acceptable, socket is dead anyway) | queue + SD                                                                                                                                                     | lane gone; DO lane object torn down                                                                                                                                                   | fast-blink amber                                                                                                                                       |
| **Wi-Fi down**                                                               | as above                                                                                                                                        | as above                                                                                          | as above                                                                                                                                                       | nothing                                                                                                                                                                               | red; screen shows SSID + last Wi-Fi `reason` code (the churn-reply discard lesson from the station-outage incident: surface the reason, don't drop it) |
| **Provider down, everything else up** (server-side state, device can't tell) | normal                                                                                                                                          | worker sends EOS at detach → clean stop                                                           | normal                                                                                                                                                         | NO_UPSTREAM/COOLDOWN; device-visible only as "no reply" → worker SHOULD push a `voice.unavailable` event down the control lane so the device can earcon/LED instead of dead air       | single amber pulse on failed turn                                                                                                                      |
| **Mount failed / fatal latch**                                               | —                                                                                                                                               | —                                                                                                 | —                                                                                                                                                              | —                                                                                                                                                                                     | solid red "needs provisioning" (`main.cpp:1128-1146`) or reboot ladder rung                                                                            |

The **in-band commit marker** worth designing now: downlink already carries an
in-band zero-length EOS on `/pcm` (`pcm_websocket.h`, brief hard constraint).
Making the _uplink_ symmetric — device sends a zero-length binary message at
PTT release = "utterance complete, commit" — puts the turn boundary on the
same ordered byte stream as the audio it terminates, which is where it
semantically belongs (it also removes a cross-socket ordering race: today the
commit arrives via control→worker→`inputStopped` while the last frames race up
the PCM socket; `DevicePcmProxy` even chains the commit behind a pending Blob
conversion to compensate, `device-pcm-proxy.ts:402-413`). v1-compat note: the
current worker bridge fails the generation on any non-640-byte uplink message
(`pcm-proxy.ts:176-185`), so the server must learn zero-length-uplink first;
it is a pure server-side addition that v1 firmware simply never exercises.
With the v2 header (§3.2) it becomes a typed frame instead.

### 2.3 What "graceful" means for a mid-utterance drop, per direction

**Uplink drop (user speaking, PCM socket dies):**

- Firmware: conductor abandons the generation and purges the mic epoch —
  already policy (`pcm_transport.c:560-584`); at most 160 ms of speech was
  unconfirmed in flight (peer guard, policy header `:57`). No replay on
  reconnect — reconnect is a freshness boundary. Keep all of it.
- Device UX: the failure must surface **at press time, not at release**: LED
  flash + short buzz the moment `sendPcm` starts rejecting, so the user stops
  talking into a dead mic instead of discovering it 10 s later.
- Worker: with a persistent upstream (§1), a half-received utterance must not
  commit: on device-lane loss mid-turn, send `input_audio_buffer.clear` (not
  commit) and cross-post `utterance.aborted` (§4). Today this case can't
  happen (device loss kills the provider outright); in v2 it can, and clear-
  not-commit is the graceful half.

**Downlink drop (assistant speaking, PCM socket dies):**

- Firmware: ring holds ≤640 ms; EOS will never arrive. Options: (i) hard-mute
  instantly, (ii) play out the ring then underrun. Choose (ii)-with-a-cap:
  play at most ~200 ms more (one freshness window), then stop via the normal
  generation flush — cutting mid-phoneme instantly on every blip is more
  jarring than 200 ms of tail. Either way the stop is _attributed_: error
  earcon + LED, so silence reads as "connection lost", not "assistant
  finished".
- Worker: provider response is now unhearable; `response.cancel` upstream
  (stop paying for TTS nobody hears), keep the transcript, cross-post
  `speak.aborted{atMs}`. If the device lane returns within a short window, do
  **not** resume mid-response (freshness doctrine); the transcript is the
  recovery artifact.

**Provider drop mid-response (device fine):** worker sends EOS → device ends
playback cleanly at a frame boundary (normal-completion path, no poison), then
NO_UPSTREAM + cross-post. Strictly better than today's 1011 cascade teardown
(`pcm-proxy.ts:104-110`).

**Control drop mid-utterance (PTT held, manual mode):** release edge can't
reach the worker. Without the in-band marker, the worker must time-bound an
uncommitted turn (e.g. commit-or-clear after 10 s of uplink silence following
last frame); with the in-band marker (§2.2) the case disappears. The worker's
existing sequence-gap policy — close the PCM generation on any control event
gap (`worker.ts:279-286`, `device-events.ts:127-134`) — stays: an inverted
held/released state is worse than a reconnect.

---

## 3. (c) Server-side AEC (requirement 9: _allow_ for it)

Why this exists: the Stick has a PDM mic and no loopback channel — device AEC
is structurally impossible there (xiaozhi's own Stick-S3 port sets
`input_reference_ = false`; Kconfig allowlists AEC boards —
`~/src/github.com/78/xiaozhi-esp32/Kconfig.projbuild:904-916`). Server-side
echo cancellation is the only full-duplex path for that hardware. The review
already recommends timestamp echo (R11 tail); this section designs it.

### 3.1 The prior art wire mechanism, verbatim

xiaozhi protocol v2 header (`~/src/github.com/78/xiaozhi-esp32/main/protocols/protocol.h:17-24`):

```c
struct BinaryProtocol2 {
    uint16_t version;
    uint16_t type;          // Message type (0: OPUS, 1: JSON)
    uint32_t reserved;      // Reserved for future use
    uint32_t timestamp;     // Timestamp in milliseconds (used for server-side AEC)
    uint32_t payload_size;  // Payload size in bytes
    uint8_t payload[];      // Payload data
} __attribute__((packed));
```

Serialized big-endian (`htons/htonl`, `websocket_protocol.cc:29-36`); the wire
version is negotiated out-of-band via a `Protocol-Version` HTTP header on the
WS handshake (`websocket_protocol.cc:104`) plus a `version` field in the hello
(`:202`). The echo loop (`audio_service.cc`):

- **Downlink:** server stamps each audio packet with a timestamp; the _output
  task_ records each played packet's timestamp into `timestamp_queue_`
  (`audio_service.cc:345-347`), bounded at `MAX_TIMESTAMPS_IN_QUEUE = 3`
  (`audio_service.h:39-45`).
- **Uplink:** the encode path stamps each outgoing mic frame with
  `timestamp_queue_.front()` (`audio_service.cc:546-553`) — "this mic frame
  was captured while the speaker was playing server-time T". Device advertises
  `features.aec` in its hello (`websocket_protocol.cc:204-206`).

The crucial property: **alignment is computed on the device**, in the device's
own playout timeline, so network jitter in either direction is irrelevant to
reference alignment. The server keeps its sent-audio ring indexed by the
timestamps it assigned and slices the reference at the echoed T.

### 3.2 Our v2 wire change (recommendation: per-frame header, negotiated subprotocol)

Options considered:

| Option                                                       | Shape                                                                                                                                 | Verdict                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **W1. Per-frame 16-byte header** (xiaozhi layout)            | subprotocol `iterate.kit.pcm.v2`; uplink messages 656 B; `type` field gains 0=PCM, 2=EOS/commit (zero payload), 3=event-JSON reserved | **Recommended** — one struct, self-describing messages, the `type` field also solves §2.2's in-band commit and reserves the §4 event lane                                                                                      |
| W2. Lean 8-byte header (`u32 flags+type`, `u32 timestampMs`) | smaller                                                                                                                               | Saves 8 B/frame (1.2 % of payload) at the cost of no version field and no room to grow. Not worth the second format                                                                                                            |
| W3. Side-channel timestamps on `/api`                        | control-plane messages "played T at t"                                                                                                | **Rejected**: cross-socket ordering skew is exactly what the timestamp echo exists to avoid; Cap'n Web dispatch adds bounded-but-real latency and the association back to specific PCM frames re-imports the alignment problem |
| W4. Trailing timestamp (640 B + 4 B suffix)                  | minimal parse change                                                                                                                  | Rejected: 644-byte messages break every "exactly frameBytes" check anyway, so we gain nothing over a proper header                                                                                                             |

Deviations from xiaozhi, deliberate:

- **Little-endian fields.** Our payload is S16**LE** and both ends are LE
  (Xtensa, V8); network byte order would buy interop with nobody and cost
  `htons/htonl` calls in the one place we're byte-budgeted. Documented as a
  conscious deviation from the stolen layout.
- **Negotiation via WS subprotocol, not an extra header**: device offers
  `iterate.kit.pcm.v2, iterate.kit.pcm.v1`; server answers with one. This is
  standard `Sec-WebSocket-Protocol` machinery both stacks already speak
  (`pcm-proxy.ts` / `worker.ts:80-85` check the offered list; firmware sets the
  subprotocol in its upgrade). **v1 peers are unaffected**: a v1-only server
  answers `v1` and the device sends bare 640-B frames — the raw-PCM fast path
  is intact, and v2 framing only ever exists when both ends agreed.
- `timestamp` semantics: `u32 playoutMs` = the wire timestamp of the downlink
  frame whose DMA EOF most recently completed, in the worker-assigned
  downlink timeline; `0` = "nothing audible" sentinel (worker starts its
  timeline at 1). Wraps at ~49.7 days; sessions rotate every 30 min (§0.4), so
  wrap handling is a comparison helper, not a design problem.

Device-side cost, concretely:

- We already have both timestamp domains: downlink frames carry
  `receivedAtMs`, and every DMA descriptor completion publishes `eofAtUs` +
  the frame metadata that produced it
  (`firmware/platforms/common/include/iterate/kit/platforms/realtime_playback.hpp:83-99`).
  Add the 4-byte wire timestamp to `RealtimePlaybackFrameMetadata` (+4 B × 32
  downlink slots = 128 B) and a `currently_audible_timestamp` atomic published
  by the audio owner on each completion.
- Uplink sender: the masked wire workspace grows 648 → 664 B
  (`ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(656)`); the conductor stamps the
  header from the atomic at acquire time. ~60 LOC firmware total, no new
  tasks, no IRAM (important: IRAM has one byte free — review §4.5; the
  timestamp publish is plain C in the existing owner task, not ISR code).
- Worker: keep a **reference ring of sent downlink PCM** indexed by assigned
  timestamp — 2 s = 64 KB per lane covers any AEC tail; stamp on send, slice
  on echoed T. ~40 LOC.

### 3.3 Where cancellation could run

**3.3.1 In the Cloudflare worker (WASM speex-MDF or WebRTC AEC3).**

- Feasibility: speexdsp's MDF echo canceller compiles to WASM cleanly (pure C,
  no threads/SIMD required; SIMD128 helps). WebRTC AEC3 is C++ and heavier but
  has been compiled to WASM in several projects.
- CPU per 20 ms frame (16 kHz mono, 100-200 ms tail): the best public anchor
  found is a joint AEC+enhancement system quoted at 0.55 ms per 10 ms frame
  (5.5 % CPU) on a desktop core (PercepNet echo-control paper, arXiv
  2102.05245) — and that includes a neural enhancement stage we would not run.
  Engineering estimate for speex-MDF alone in WASM: **~0.2-0.6 ms per 20 ms
  frame** (1-3 % of one core); AEC3 ~2-3× that. Mark as estimate; benchmark
  with a 60 s PCM fixture in workerd before believing it.
- Cost: 50 frames/s × ~0.4 ms = 20 ms CPU/s ≈ 72,000 CPU-ms/hour ≈ **$0.0014
  per session-hour** at Workers' $0.02/M CPU-ms. Compute cost is noise next to
  the $4.80/h provider bill.
- Alignment: solved by §3.2 — the echoed timestamp selects the reference slice
  in the worker's ring; residual error is frame quantization (±20 ms) +
  acoustic path (~1-3 ms), both inside a 100-200 ms adaptive tail, with the
  standard NLP stage soaking the residual. The classic reason server-side
  AEC fails (unknown network delay) is exactly what the device-side stamp
  removes.
- Risks: DO single-threadedness (0.5 ms/frame steals from relay latency —
  fine; 2 ms/frame would not be), WASM instantiation per DO wake, and filter
  state loss on DO eviction mid-session (acceptable: reconverges in ~1 s).

**3.3.2 On the "nearby computer" rig only (test-time AEC).** Run speexdsp
natively in the layer-2 rig (brief req 7): the rig terminates `/pcm`, has the
same reference ring, and produces ERLE/AECMOS evidence using the seekaudio
evaluation harness methodology the review already recommends stealing (review
§4.6/§7). Zero production risk, validates the v2 timestamp mechanism
end-to-end (including the device's stamp accuracy, measurable by
cross-correlating the reference slice against the actual echo), and gives us
the acceptance numbers _before_ deciding 3.3.1. **Do this first.**

**3.3.3 Upstream provider does it.** Not available: xAI documents no echo
reference input and no AEC (§0.4); server VAD alone will happily hear the
device's own TTS. Parameterize: if xAI ships an `input_audio_echo_reference`
(OpenAI hasn't either), the worker already holds both streams and the
timestamps and can adapt in a day. Watch item, not a plan item.

**3.3.4 Don't cancel — suppress/duck via speak-state gating.** The worker
knows speaking state exactly (`#responseActive`: set on `response.created`
/ first binary chunk, cleared on `response.done`, `pcm-proxy.ts:219,264-269`).
Policy: while speaking, drop uplink frames (or don't forward to the provider)
unless a barge-in condition passes — e.g. frame energy > (echo-predicted
energy at echoed-T + margin), a poor-man's half-duplex that needs only the
§3.2 timestamps and the reference ring. ~30 LOC, no DSP. This is the v2.0
shipping answer for the Stick in any server-VAD experiment; it is exactly
xiaozhi's `kListeningModeAutoStop` semantics enforced server-side rather than
device-side.

### 3.4 Recommendation ladder (c)

1. **Ship the v2 header + timestamp echo now** (§3.2): ~60 LOC firmware,
   ~40 LOC worker, ignorable by v1 peers, and it unblocks _every_ option
   above plus the §2.2 in-band commit and §4 event lane. This is requirement
   9's "allow for" fully discharged.
2. **Rig AEC as acceptance harness** (3.3.2) — proves stamp accuracy and
   produces ERLE baselines.
3. **Speak-state gating in the worker** (3.3.4) as the immediate duplex-ish
   mode for reference-less hardware.
4. **Worker WASM speex** (3.3.1) only when a real product need for true
   barge-in-during-speech on the Stick exists — and benchmark first.
5. StackChan device-side AEC stays the R11 plan (hardware reference,
   FD_LOW_COST behind the R2 processor seam); server AEC is the Stick's path,
   not StackChan's.

---

## 4. (d) `/pcm` cross-posting non-PCM events to streams (req 8)

### 4.1 The seam already exists as logs

The worker already marks exactly the two cross-post points, literally logging
`wouldPostToStream: true`:

- Accepted device events (PTT edges) inside the capability callback
  (`worker.ts:247-252`).
- Provider events (`provider-event` diagnostics — transcriptions, response
  lifecycle) in `#onPcmDiagnostic` (`worker.ts:266-271`); the bridge surfaces
  every provider JSON event as a diagnostic (`pcm-proxy.ts:254-262`), parsed
  loosely so unknown event shapes cannot disturb the audio lane.

Device events already arrive shaped as `{schemaVersion, sequence, source,
type, ...}` with an ordered boot-local sequence and snapshot semantics
(`device-events.ts:1-9`, brief req 8's "path, type, payload" shape is one
renaming away).

### 4.2 Event catalog (initial)

| Stream event `type`                                 | Source                                                                                                                                        | Payload sketch                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `device.pushToTalk.started/.stopped`                | device event subscription (exists)                                                                                                            | `{sequence, source: "physical"\|"remote"}`                          |
| `voice.utterance.transcribed`                       | provider `conversation.item.input_audio_transcription.*`                                                                                      | `{text, turnId}`                                                    |
| `voice.speak.started`                               | derived: first downlink binary of a response (the bridge already treats first binary as conclusive response activity, `pcm-proxy.ts:213-219`) | `{turnId, atMs}`                                                    |
| `voice.speak.transcript`                            | provider response transcript deltas, coalesced per turn                                                                                       | `{text, final}`                                                     |
| `voice.speak.ended`                                 | EOS sent to device / `response.done`                                                                                                          | `{turnId, playedMs}`                                                |
| `voice.speak.aborted`                               | §2.3 downlink drop / barge-in cancel                                                                                                          | `{turnId, atMs, reason}`                                            |
| `voice.session.dialing/.active/.ended/.unavailable` | §1.1 state machine transitions                                                                                                                | `{trigger, dialMs, provider, sessionAgeMs}`                         |
| `device.lane.connected/.lost`                       | device socket lifecycle                                                                                                                       | `{generation, closeCode, reason}`                                   |
| (later, v2 wire) `voice.audible.until`              | echoed device playout timestamps                                                                                                              | `{playoutMs}` — the device-truth "it was actually heard up to here" |

Note the two-truths point: the worker knows _sent_ times, the device knows
_audible_ times. Pre-v2-wire, `speak.started/ended` are server-observed;
post-v2 the echoed timestamps let the worker also post device-observed edges.
Both are honest as long as each says which clock it is.

### 4.3 Posting mechanism sketch (never blocks the PCM lane)

The worker already holds a project handle per session
(`worker.ts:158-166`). Posting is a bounded, drop-oldest outbox flushed
asynchronously — the "always an event at head / no HOL blocking" shape,
mirroring how the firmware's own event queue coalesces
(`device_event_stream.c:90-108`):

```ts
class StreamOutbox {
  readonly #events: StreamEvent[] = []; // capacity 64, drop-oldest + count
  #flushing = false;
  droppedEvents = 0;

  post(event: Omit<StreamEvent, "ts" | "seq">) {
    // sync, called from PCM handlers
    if (this.#events.length >= 64) {
      this.#events.shift();
      this.droppedEvents += 1;
    }
    this.#events.push({ ...event, ts: Date.now(), seq: this.#nextSeq++ });
    if (!this.#flushing) this.#ctx.waitUntil(this.#flush()); // fire and account
  }

  async #flush() {
    this.#flushing = true;
    try {
      while (this.#events.length > 0) {
        const batch = this.#events.splice(0, 16);
        // one atomic append per batch; path names the device lane
        await this.#project.streams.append("/devices/kit/m5sticks3", batch);
      }
    } catch {
      this.droppedEvents += 1; /* stream loss must never fail audio */
    } finally {
      this.#flushing = false;
    }
  }
}
```

Rules baked in: (1) `post()` is synchronous and allocation-bounded — the PCM
message handlers never await; (2) stream unavailability degrades to counted
loss, never to audio-lane failure; (3) PCM frames themselves are explicitly
excluded (req 8: "just not the latency-sensitive PCM (for now)"); (4) the
same shaped events are what the device logs to SD (req 5) — one event
vocabulary end-to-end, so an SD card from an offline device and a stream from
an online one read identically. The `streams.append` capability itself is an
apps/os design question (flagged for the interview round), but everything on
the `/pcm` side is buildable now against the logged seam.

---

## 5. Consolidated v2 recommendations (this topic's slice)

1. **Split device lane from upstream session** in the worker; upstream
   attach/detach with NO_UPSTREAM → DIALING → ACTIVE → DRAINING → COOLDOWN,
   DO-alarm idle timer, EOS-on-detach. (§1.1)
2. **Preroll ring (2 s) + dial-on-demand triggers** (PTT event + first-frame
   backstop) + pre-minted secret + await `session.updated`. (§1.2-1.4)
3. **Policy V-B (90 s idle window) as default**, with transcript replay across
   hangups and session rotation before the 30-min provider cap; V-A/V-C as
   config. Measure idle billing before freezing `T_idle`. (§1.5)
4. **Firmware ladder polish**: PCM gate reset on confirmed delivery; jitter in
   the platform wrapper; retryable PCM start; unify Wi-Fi backoff on
   retry_gate; SD-log + reboot as the explicit last rung (~15 min). (§2.1)
5. **Degraded-mode matrix** with per-state LED/earcon policy and press-time
   (not release-time) failure surfacing; in-band uplink commit marker to make
   PTT survive control-lane loss. (§2.2-2.3)
6. **PCM v2 wire**: 16-byte little-endian header (xiaozhi BinaryProtocol2
   layout), subprotocol-negotiated, timestamp echo from existing
   `eofAtUs`/metadata plumbing; ~100 LOC total across both ends. (§3.2)
7. **AEC ladder**: rig-side speex first (evidence), worker speak-state gating
   second (product), worker WASM speex only on proven need, provider-side if
   xAI ever ships a reference input. (§3.3-3.4)
8. **Stream cross-posting** via bounded drop-oldest outbox at the two seams
   the worker already logs; one event vocabulary shared with SD logging. (§4)

Open questions to put to Jonas in the interview round:

- Merge `DevicePcmProxy` into the worker bridge (one proxy, two hosts) or keep
  the lab/prod split? (§0.1 — my lean: one bridge core, host adapters.)
- Idle-window length and whether transcript replay across hangups is wanted
  (conversation memory vs cost vs privacy of retaining transcripts in the DO).
- Is per-connected-minute or per-audio-minute billing confirmed by
  measurement? Changes `T_idle` economics an order of magnitude. (§0.4)
- Does the uplink in-band commit marker replace the control-lane PTT commit
  path outright (one truth), or run alongside it (belt and braces)? (§2.2)
- Reboot-as-last-rung: acceptable for all four hub boards, or does any device
  role (e.g. a servo mid-motion StackChan) forbid unattended reboot? (§2.1)

## Sources (web)

- xAI pricing/session caps: [AI Cost Check — xAI Grok API Pricing 2026](https://aicostcheck.com/blog/xai-grok-pricing-guide-2026), [eesel — Grok Voice Agent Builder pricing](https://www.eesel.ai/blog/grok-voice-agent-builder-pricing), [eesel — xAI pricing guide](https://www.eesel.ai/blog/xai-pricing)
- xAI voice/VAD docs: [docs.x.ai — Voice overview](https://docs.x.ai/developers/model-capabilities/audio/voice), [LiveKit xAI realtime plugin](https://docs.livekit.io/agents/models/realtime/plugins/xai/)
- AEC CPU anchor: [PercepNet-based joint echo control (arXiv 2102.05245)](https://arxiv.org/pdf/2102.05245), [speexdsp echo-cancellation test repo](https://github.com/gdalsanto/speexdsp-test)
