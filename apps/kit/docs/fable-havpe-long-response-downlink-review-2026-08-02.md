# Fable Max review: HAVPE long-response downlink failure — 2026-08-02

Independent read-only review of the count-to-100 failure on the physical Home
Assistant Voice Preview Edition (session
`prj_4f76ffe131f1495981afd65619f57914:home-assistant-voice-preview-edition:d2a15a10-58c7-475b-9738-52b2df0ede86`).
Produced by the Claude Fable Max background session named in
`voice-device-adventures-2026-08-02.md`. No production code was edited, nothing
was flashed or deployed, and git state was not altered; this file is the only
output.

Label key:

- `C` — confirmed from source in this worktree (file:line cited).
- `M` — measured value retained as an artifact in the repo.
- `M*` — measured value that was live-queried from production and transcribed
  into an untracked doc; no raw artifact exists in the repo to re-verify it.
- `H` — hypothesis or derivation; assumptions stated.

Every failing-session number in this review is `M*` (source:
`voice-device-adventures-2026-08-02.md`, entry 21:27). That matters: the repo
retains no `provider-events.jsonl`, no per-second device series, and no
wall-clock timestamps for this session — only durations transcribed by hand.

---

## 1. Verdict

**What is proven.** The device-side kill mechanism is confirmed from source and
counters. One `ITERATE_KIT_BACKPRESSURE` from
`iterate_kit_pcm_lane_receive_downlink_at` — i.e. one attempt to start a new
frame while all 32 downlink ring slots were occupied — increments exactly
`downlink_receive_failures` and `downlink_ordered_item_losses`, records
`ESP_ERR_NO_MEM`, and deliberately retires the whole PCM socket generation
(`pcm_transport.c:365-384`, C). The device snapshot (received 3,230 /
dropped 1 / depth 0 / high-water 32 / failures 1, M\*) matches that path
exactly and matches no other path in the transport. The 1011
"disconnected without sending Close frame" is the worker's view of that
deliberate device-side teardown (`mark_socket_disconnected` + socket close
without a WS close handshake, C).

**What filled the ring.** Not directly measured — the one-second-aligned series
that would prove it was never captured (the adventures doc concedes this). But
the mechanism space is now small. The consumer is hardware-clocked by the
XMOS's I2S clocks (ESP32-S3 is bus slave, C) and structurally cannot pause
without leaving other counter evidence; the producer-side pacing grid provably
never ran early or bursty (all four pacing counters zero, M\*); sustained clock
drift is quantitatively impossible at the required magnitude (needs ~1.3%,
crystals give ~0.01%, §3.6). The only cause consistent with every measured
number is a **transient delivery redistribution**: a ≥ ~0.7 s stall somewhere
in the CF-edge → Wi-Fi → lwIP path, during which the worker's open-loop 50 fps
kept filling invisible network buffers, followed by TCP delivering the backlog
at line rate into a ring that drains at exactly 50 fps. A backlog of ≥ 33
frames overflows the ring within one or two playback edges, and the first
overflow is generation-fatal by policy. The counters themselves imply ~0.4 s of
consumer idle time inside the 30.68 s send window (§3.1, H-derived) — the
signature of exactly such a stall. Prior measured work on this network makes
≥ 0.7 s outages unremarkable: the Stick reviews measured 160–170 ms delivery
gaps on clean days, and the ESP32 station-outage research measured 4.2 s and
17–19 s Wi-Fi outages on this same lab Wi-Fi.

**The systemic defect** is a composition of three individually-defensible
policies:

1. The worker feeds an **open-loop 20 ms grid** anchored once per response and
   never re-anchored to device consumption (`pcm-proxy.ts:2204-2229`, C). Its
   own doc-comment says "the I2S peripheral remains the authoritative playout
   clock" (`pcm-proxy.ts:241-243`), but no signal from that clock reaches the
   scheduler at burst timescale.
2. The device's 640 ms ring is documented as "measured loss reserve for
   scheduler/TLS bursts" (`main.c:100-104`, C) — but it is actually asked to
   absorb WAN+Wi-Fi redistribution, whose measured tail on this network is
   seconds, not hundreds of milliseconds.
3. Ring overflow is **generation-fatal** on the device, and generation death is
   **response-fatal and conversation-fatal** on the worker: `close()` discards
   the remaining ~46.8 s reservoir with no diagnostic beyond a counter, closes
   the provider socket, and a firmware reconnect gets a brand-new session id —
   the answer and the conversation context are both gone
   (`pcm-proxy.ts:398-409, 707-725`, `worker.ts:276-285, 440-451`, C).

A 75 s response gives roughly one hundred independent ~0.7 s windows for this
composition to fire. This is the first device-side downlink ring-full teardown
in any retained run (M) — it is a tail event — but long responses buy tickets
in that lottery linearly, and the cost is total.

**Smallest robust fix** (§4): on the device, stop consuming socket bytes when
the ring is full instead of tearing down (deferral converts the ring + TCP
receive window into layered elastic buffering with zero loss); on the worker,
stop treating device-socket death mid-response as response death — keep the
reservoir and provider, and resume into the firmware's automatic reconnect.
Either alone survives count-to-100; together they survive multi-second
outages with bounded, counted degradation. The uncommitted depth-feedback
work in the current tree is useful telemetry but **cannot** prevent this
failure mode (§4.6) and must not be shipped as its fix.

---

## 2. Evidence base, and corrections to the record

### 2.1 What each number actually is (C, from source)

| Reported                            | Actual semantics                                                                                                                                                                                                                                                                                   | Source                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| "reservoir reached 2,042,196 bytes" | `downlinkQueueHighWaterBytes` — peak **occupancy** of the 2,880,000-byte (90 s) byte ring, not cumulative throughput. 63.8 s. No reservoir overflow occurred (would have retired the provider, not the device).                                                                                    | `pcm-proxy.ts:1678-1681`                          |
| "discarded 1,498,196 bytes"         | `downlinkDroppedBytes` — a **session-lifetime ledger fed by seven distinct sites** (close-discard, pacing overrun, egress overrun, interruption, VAD turn start, response.done paths, overflow). At close, `#discardDownlinkQueue()` added the remaining occupancy with **no diagnostic emitted**. | `pcm-proxy.ts:1900-1912` and the seven call sites |
| "sent 1,534 20-ms frames"           | 12 priming frames + 1,522 grid ticks = 981,760 B = 30.68 s.                                                                                                                                                                                                                                        | `pcm-proxy.ts:1757-1766`                          |
| device "received 3,230"             | `downlink_frames_accepted`, **cumulative since the 19:34:37Z boot**; ~1,696 frames predate this response (ring-ui smoke alone contributed 136, M).                                                                                                                                                 | `main.c:368`                                      |
| device "dropped 1" / "failures 1"   | ring `producer_backpressure` and transport `downlink_receive_failures`; one BACKPRESSURE event increments both.                                                                                                                                                                                    | `main.c:369-374`, `pcm_transport.c:366-370`       |
| "depth 0, high-water 32"            | depth was sampled **after** the generation fence purged the ring; only high-water witnesses the full ring.                                                                                                                                                                                         | `pcm_transport.c:902-908`                         |

### 2.2 Arithmetic reconciliation (H on M\* inputs — it all closes)

- Provider finished delivering while ~580 frames had been sent:
  2,413,366 B (75.4177 s) − 2,042,196 B high-water = 371,170 B = 580.0
  frames ≈ 12 prime + 568 ticks ≈ **t + 11.6 s** — matching the doc's
  "emitted in roughly 11.5 seconds" (≈ 6.5× realtime) to within three frames.
- Close-time occupancy should be 2,413,366 − 981,760 = **1,431,606 B**; the
  ledger says 1,498,196. The ~66,590 B (≈ 104 frames ≈ 2.08 s) difference is
  most plausibly **earlier same-session discards** through the other six
  ledger sites (e.g. response tails at turn boundaries). The day-log's "…and
  discarded 1,498,196 bytes after its physical downstream vanished" slightly
  over-attributes a lifetime ledger to one event. Not material to the
  mechanism; material to reading these counters in future incidents.
- 3,230 − 1,534 = 1,696 prior-boot frames; with dropped=1 lifetime, prior
  turns closed cleanly.

### 2.3 Corrections to the prompt/record

1. **µ-law is not on this path.** Commit 353914631 ("mu-law the downlink too")
   touched only `voicelab_stream.c` — the Cap'n Web voicelab lane used by the
   Waveshare and host-CLI targets. The HAVPE linker map has zero voicelab
   symbols (M). The `/pcm` wire is mono PCM16LE 16 kHz, one 640-byte frame per
   binary message (`pcm_websocket.h:28-33`, C).
2. **Commit 79eb222b2 (answer_done latch) is irrelevant to HAVPE**: it fixed
   `voice_playback_clock.c`, which is not linked into the HAVPE image. The
   HAVPE playout path is `pcm_clock_playback.c`, unchanged since 07-31 (M).
3. **The flashed image has no recorded git provenance** — built from a dirty
   tree (≈ 79eb222b2 + then-uncommitted ring-UI code), recorded only as a
   size + SHA-256 in the ring-ui manifest (M). Process gap; see §7.
4. The two untracked docs disagree in confidence: the adventures entry
   correctly labels the BACKPRESSURE attribution as inference pending an
   aligned reproduction; the HAVPE landing-doc header states "the 32-slot
   device receive lane reached its bound" as fact. The adventures framing is
   the defensible one.
5. Same-day provider-side context not in the prompt: server-VAD threshold 0.1
   double-`speech_started` at 19:10Z (retained failure, M) and
   `silence_duration_ms: 500` deployed from a dirty tree around the incident
   window. Neither caused this failure — a mid-response worker interruption
   would have discarded the reservoir _before_ 1,534 frames and stopped the
   grid; the counters show pacing ran to the close with a full queue — but
   both changed turn behavior that day and belong in the campaign controls.

---

## 3. Q1 — How a nominal 20 ms producer and 20 ms consumer fill a 32-slot ring at t≈31 s

The steady state is: worker admits exactly 50 frames/s on its own clock;
device consumes exactly 50 frames/s on the XMOS clock; ring depth ≈ the
12-frame lead. Depth reaches 32 only if **arrival minus consumption
integrates to +20 frames**. There are only two families: a sustained rate
mismatch (ruled out quantitatively below) or a transient redistribution —
consumption pausing, or arrival pausing-then-bursting. Ranked:

### 3.1 ① TCP/TLS/Wi-Fi stall-then-burst — **leading, and the only candidate consistent with all measurements** (H, strong)

Mechanism, with the actual constants:

- During a delivery stall the worker keeps sending 1×640 B/20 ms — its grid is
  open-loop and its egress checks only workerd-local `bufferedAmount`
  (threshold 10,240 B, never crossed, M\*). The backlog therefore accumulates
  invisibly in the CF-edge kernel socket buffer and the Wi-Fi path. The device
  advertises only `CONFIG_LWIP_TCP_WND_DEFAULT=5760` B ≈ 9 frames of receive
  window (C, sdkconfig:1618), so at most ~9 frames were in flight when the
  stall began; everything else queued upstream.
- Meanwhile the consumer, hardware-clocked, drains the ring: the 12-frame lead
  empties in 240 ms, then the response underruns (zeros, because
  `auto_clear_after_cb=true`, C) for the remainder of the stall.
- On recovery, TCP delivers the backlog window-by-window (~9 frames per RTT).
  The network task drains lwIP far faster than 50 fps (up to 16 chunks per
  ~10 ms pass, `pcm_transport.c:51,424-492`, C), so ring depth ramps at
  hundreds of frames/s against a 50 fps consumer. The 400 ms stale-frame
  policy cannot intervene: frame age is stamped at **lane receive**
  (`received_at_ms`), so burst frames arrive "fresh" (`pcm_clock_playback.c:270`,
  C). Depth crosses 32 within ~100–400 ms of recovery; the 33rd new-frame
  acquire returns BACKPRESSURE; the generation dies ~consistent with a close
  at frame 1,534.
- Break-even: overflow requires backlog ≥ ~33 frames ⇒ **stall ≥ ~0.66 s**
  (12-frame lead drain + 20 further ring-empty frames + a frame or two
  consumed during burst delivery). Anything from 0.25–0.6 s produces only an
  audible gap and survives; ≥ ~0.66 s is fatal. That knife-edge is the design
  problem in one sentence.

Supporting measurements:

- **Derived consumer idle time** (H on M*): sent = 1,534; assume prior turns
  clean (supported by dropped=0 before this event) so this-turn accepted
  ≈ 1,533; consumed = accepted − 32 (depth at overflow) ≈ 1,501 = 30.02 s of
  consumption inside a 30.44 s send window ⇒ **≥ ~0.42 s of ring-empty
  underrun during the response**, i.e. a ≥ ~0.66 s arrival gap counting the
  lead drain. The counters *require\* a stall; they merely cannot say which hop
  stalled. (If some sent frames were stranded in the edge at close, the
  implied gap only grows.)
- Zero pacing lateness/catch-up/overrun (M\*) — note "zero lateness" is
  structurally blind below 20 ms (`pcm-proxy.ts:1729-1735`, C) but zero
  catch-up incidents proves the worker never emitted a burst after priming.
- Prior art: Stick multiturn review measured 160–170 ms device-side delivery
  gaps with zero worker lateness ("gaps are network, not worker", M);
  station-outage research measured 4.2 s / 17–19 s Wi-Fi outages on this
  Wi-Fi (M); the 07-30 LAN-bridge era had a device-origin 4013
  "backpressure" close — same failure class, earlier transport (M).

Sub-variant worth keeping open: **device network-task starvation** (the
`iterate-pcm-net` task, prio 6, core 0) being held off CPU ≥ 0.66 s by Wi-Fi
(prio 23) / lwIP (18) system tasks produces the same signature — bytes pile
up in lwIP/edge, then flood the lane on resume. It is _also_ a delivery
stall, just with a local cause. Discriminator: a starved network task also
stops uplink sends, so `uplink_capture_stale_restarts` /
`maximum_consecutive_send_deferrals` (already exported in the 1 Hz sample,
`main.c:337-356`, C) would fire for stalls ≥ 640 ms. Those values were not
transcribed for the incident — capture them next time (§7).

### 3.2 ② Consumer halt/pause — **no mechanism found** (H, weak)

Everything that stops the HAVPE consumer _discards the ring rather than
letting it fill_ (C):

- Barge-in, generation change, and direct resets all run
  `reset_playback_state` → `i2s_channel_disable` + **discard the entire
  downlink lane** + preload silence + re-enable
  (`voice_pe_audio_owner.c:776-818`). A reset near t≈30 s would _empty_ the
  ring, not overflow it, and would have incremented `playback_resets` /
  `downlink_frames_discarded_by_reset`.
- An `i2s_channel_write` stall longer than 25 ms returns a timeout, which
  triggers that same discard-reset (`:934-983`). Three consecutive failures
  suspend the task — but a suspended playback task can never acknowledge the
  generation fence, so the post-failure reconnect that visibly happened
  (depth 0, session continued) proves the task was alive.
- Task starvation of a priority-24, core-1 task requires an equal/higher
  core-1 hog for ≥ 640 ms. The only candidates are the capture task (also 24,
  but blocked in its own 40 ms-bounded DMA reads) and `ipc1` (24, used only
  for flash-cache suspensions — and no runtime flash writes exist anywhere in
  the target: config is mmap'd read-only, Wi-Fi storage is RAM, no NVS
  commits, C). The 60 ms TX DMA absorbs tick-level jitter.

Nothing here can silently absorb 640 ms. What this hypothesis lacks most is
disproof _in the retained data_ — underrun counters exist
(`underrun_incidents`, `underrun_silence_samples`,
`playback_write_errors`, `playback_resets`) but HAVPE exports none of them
(`has_playback = false`, `main.c:380`, C). §7 fixes that.

### 3.3 ③ Stale generation / state (H, very weak)

Receive admission is gated on the accepted generation
(`downlink_generation_accepted`, C); the fence discards the ring on every
generation transition before re-admission (`pcm_transport.c:876-931`, C);
producer fragment state is reset on connect (`mark_socket_connected`, C). No
path was found that lets an old generation's frames occupy the new
generation's ring, and the answer_done latch commit is not in this image
(§2.3.2).

### 3.4 ④ I2S/DMA behavior (H, effectively excluded)

The ESP32-S3 is I2S slave on both buses; the XMOS masters BCLK/WS at 48 kHz
(confirmed in our config, in the first-party ESPHome yaml, and in the XMOS
ffva firmware source, C). Consumption cadence is one blocking 3,840-byte
(10 ms) write per loop against a 60 ms circular DMA with
`auto_clear_after_cb` (underrun ⇒ zeros, never stale replay, C from IDF
v5.4.2 `i2s_common.c`). Divider error is 0 ppm and irrelevant anyway in slave
role. DMA lumpiness is bounded by one 10 ms descriptor. Nothing at this layer
can add or absorb 640 ms.

### 3.5 ⑤ Worker scheduler defect (H, weak)

The grid is deadline-anchored (`nextDeadline = current + framesDue × 20`,
`pcm-proxy.ts:2226`, C), so isolate jitter cannot accumulate; catch-up would
have been counted. A systematically _fast_ workerd `performance.now` (the
only uncounted failure shape) would need to run 1.3% fast — no known
mechanism, and it would also have shown up in every earlier clean run.
Cross-check it once via provider-event wall timestamps in the campaign
(§7.4) and close this permanently.

### 3.6 ⑥ Sustained clock drift (H, quantitatively refuted as the cause)

Filling 20 spare slots over 1,522 ticks requires the producer clock to run
**~1.3%** faster than the XMOS-mastered consumer clock. Crystal budgets are
~±20–50 ppm per side; even a pathological 200 ppm net is 6 ms over 30.68 s —
0.3 frames. Drift also predicts monotone high-water growth across every
earlier response, contradicted by dropped=0 lifetime before this event and by
the Stick completing a 70.86 s response (3,543 frames, zero drops) on the
identical 32-slot profile the day before (M). Drift is real but two orders of
magnitude too small; at 6%/s of correction headroom, the in-progress depth
feedback is solving a hypothesis the arithmetic excludes (§4.6).

---

## 4. Q2 — Fixes

Constraint recap the fix must honor: EOS is an in-band zero-length message
occupying a ring slot (`pcm_lane.c:456-491`, C) — any "just drop on overflow"
policy that can drop EOS wedges the turn, which is exactly why the current
code chose teardown (`pcm_transport.c:371-380` comment). A correct fix must
preserve EOS ordering.

### 4.1 Fix A (recommended minimal landing) — device defers socket reads when the ring is full

Change `receive_downlink` so that, when no fragment is in progress and the
downlink ring has no free slot, the transport **does not call
`websocket_connection_receive`** for that pass and returns to the scheduler
(one tick). The unconsumed bytes stay in TLS/lwIP; lwIP's 5,760 B window
closes; TCP holds the backlog at the CF edge — exactly where it already sat
during the stall — and the ring re-admits one frame per 20 ms as the consumer
frees slots. The overflow becomes _deferral_ instead of _loss_, and the
BACKPRESSURE teardown path remains as a now-unreachable invariant.

- Firmware: a lane query (`downlink free slots` — trivially derivable from
  `iterate_kit_spsc_ring_metrics`) plus a ~10-line gate in
  `pcm_transport.c:424` before the receive call, honoring
  `lane->downlink_fragment_active` (a reserved-slot continuation must always
  be drainable). EOS needs no special case: it needs a slot, and the gate
  guarantees one before any new message is consumed.
- Latency debt: after a T-second stall the response finishes T seconds later.
  Debt is bounded by (stall length + ring), not by policy — acceptable for a
  landing fix and strictly better than losing 46 s of a correct answer.
  Count it (`downlink_deferred_passes`, `deferred_ms_max`).
- **Required companion (ghost-audio guard):** with deferral, seconds of stale
  audio can sit in TCP across a barge-in. On playback reset/interruption the
  ring is purged, but deferred backlog would then stream in and play as a
  ghost. Fix: on interruption, the worker sends the zero-length EOS marker
  (it already does at every other response boundary:
  `pcm-proxy.ts:1410,1437,1722,1890`; the interruption path relies on the
  device-side purge today and must add it), and the firmware enters
  drain-to-EOS after a reset: read and discard downlink messages at full
  speed until the marker. Small state machine, fully host-testable.
- Risks: while gated, PINGs are also unread — bounded in practice because the
  gate lifts within 20 ms whenever the consumer is alive; in consumer-dead
  pathologies the existing 500 ms no-progress and peer timeouts still
  recover. The gate must also never starve the _uplink_ half of the loop
  (it doesn't: it gates only the receive call).

### 4.2 Fix A′ (fallback minimal) — counted drop-newest for frames, deferred EOS

If pausing reads proves awkward against the WS control plane: on ring-full,
drop the **frame** with counters (as uplink already does for mic audio —
`pcm_lane.c:22-27` documents that policy asymmetry) and hold a `pending_eos`
flag so a marker is published the moment a slot frees. The existing 400 ms
receive-to-render age policy then automatically trims a burst-pinned ring
back to fresh within ~0.5 s. Behavior after a 2 s stall: silence, ~0.6 s of
resumed stale audio, one counted skip, then live. Survives everything,
loses stall-length audio (counted, not silent). ~20 lines; no socket-layer
changes. Weaker than A (loses content A retains) but strictly dominates
today's policy.

### 4.3 Fix B (worker, strongly recommended alongside A) — resume the response across device reconnect

Today device-close ⇒ discard reservoir ⇒ close provider ⇒ next firmware
reconnect gets a fresh session id, so **any** device-side generation loss
costs the answer _and_ the conversation (C, §1 item 3). The firmware already
reconnects on its own within ~250 ms–30 s (`esp_idf_websocket_policy.h:44-45`)
and fences generations correctly. Change `worker.ts` so a device close with
an active response parks the bridge (reservoir + provider + conversation
intact) for a bounded window (e.g. 15 s); a reconnect from the same device id
re-attaches, re-primes 12 frames, and resumes the grid from the reservoir
playhead. Worker-only; no protocol change; converts _today's_ failure from
"answer lost" to "~1–2 s audible gap". Also fixes the unrelated-but-real
defect that conversation context dies on every PCM socket blip.

### 4.4 Fix C (protocol v2) — credit/consumed flow control

Device reports consumed-frame count (a small TEXT message on `/pcm` every
250–500 ms, or a control-lane event); worker sends only up to
`consumed + window` (window ≈ ring size). Closes the loop end-to-end, makes
depth continuously observable at 2–4 Hz without the metrics subscription, and
lets the worker distinguish "device consuming, network slow" from "device
gone". This is the principled successor to the 1 Hz depth feedback (§4.6).
It does **not** replace Fix A: any cloud-side loop is behind the same stalled
pipe and cannot act during the stall; local absorption remains necessary.
(The unused `voice/device-pcm-proxy.ts` already names this future: "a
provider/device credit protocol can replace this finite reservoir".)

### 4.5 Fix D (principled architecture) — the device owns both the clock and the buffer

Make the stated principle real: the worker stops pacing entirely and forwards
provider audio as fast as credit allows; the device buffers seconds in a
PSRAM ring (§8), plays at its DAC clock, owns skip-to-live policy (trim to
≤ N ms of debt with one counted skip), and drains-to-EOS on interruption.
Deletions this unlocks: the 20 ms admission clock, catch-up/lateness/overrun
machinery, the egress-overrun drop, the depth-feedback corrector, and most of
the worker reservoir (retained only as the resume source for Fix B, or
dropped if the provider can re-serve). Evaluation against the required
criteria in the table below.

### 4.6 The uncommitted depth-feedback WIP (evaluate before shipping)

The working tree adds `observeDeviceDownlinkDepth`: 1 Hz device depth via the
metrics subscription; if depth > 12, push the next deadline later by ≤ 3
frames per observation (`pcm-proxy.ts:548-581`,
`DEVICE_DEPTH_FEEDBACK_MAXIMUM_CORRECTION_FRAMES = 3`, `worker.ts:698-700`).
Judgment: **keep it as drift trim and telemetry; do not credit it against
this incident.** It corrects ≤ 60 ms/s — sized for a ≤ 6% clock error that
§3.6 shows cannot exceed ~0.01% — and it is structurally unable to prevent
the burst kill: during the stall no samples arrive (same network), the fill
completes in a few hundred ms between 1 Hz samples, and no correction can
recall frames already in the edge buffers. Worth keeping because
`deviceDownlinkDepthMaximumFrames` is exactly the cross-clock observation the
campaign needs, and a _sustained_ skew of a few frames is worth trimming on
multi-minute responses. If Fix A lands, its corrections should be near-zero;
assert that in tests rather than letting two control loops fight.

### 4.7 Comparison

| Criterion                           | A defer                             | A′ drop                    | B resume                                | C credit                              | D device-owned                         |
| ----------------------------------- | ----------------------------------- | -------------------------- | --------------------------------------- | ------------------------------------- | -------------------------------------- |
| Survives ≥0.7 s stall               | yes, no loss                        | yes, counted loss          | n/a alone (turn survives via reconnect) | steady-state only; needs A for bursts | yes                                    |
| Bounded latency                     | debt = stall length (counted)       | ≤ 640 ms                   | gap ≈ reconnect time                    | lead-bounded                          | policy-bounded (skip-to-live)          |
| Audio continuity                    | full content, shifted               | gap = stall                | 1–2 s gap on socket death               | best steady-state                     | best overall                           |
| RAM                                 | none                                | none                       | worker only (existing reservoir)        | none                                  | +168–336 KB PSRAM (§8)                 |
| CPU                                 | nil                                 | nil                        | nil                                     | nil                                   | nil (32 kB/s memcpy)                   |
| Control-plane complexity            | none                                | none                       | worker session lifecycle                | new message both ends                 | largest, but deletes more than it adds |
| Observability                       | +defer counters                     | +drop counters             | +resume counters                        | depth at 2–4 Hz                       | one true queue on-device               |
| Long replies / reconnect / recovery | unbounded replies; recovery = drain | unbounded; recovery = skip | reconnect = resume                      | unbounded                             | unbounded; recovery local              |

**Recommendation:** land A + B now (A is ~30 firmware lines + one worker
line for interruption-EOS; B is a worker-only lifecycle change); add C when
touching the protocol next; treat D as the shape the system converges to.
Do not land a bigger ring alone (§8).

---

## 5. Q3 — Ownership model, simplifications, deletions

**The stated model is right and the implementation contradicts it.** Three
places in the tree already assert that the device's DAC is the only real
clock (`pcm-proxy.ts:241-243`; `main.c:1061-1064`; the Stick pacing review).
Yet the actual playout master is the worker's `performance.now` grid, and the
device's clock has no channel back except a 1 Hz metrics sample feeding a
≤ 3-frame nudge. The system has already grown three compensators for the
missing signal — catch-up bursts, egress-overrun drops, and now depth
feedback — each added after a measured incident (lead 8→12 after the 170 ms
gaps; reservoir 4 s→8 s→60 s→90 s after successive Stick overflows, M). That
history is the tell: open-loop cloud pacing into an opaque bounded queue
forces every disturbance to be patched at a new layer. The ownership answer
is: **the device owns playout (clock, buffer, staleness/skip policy); the
worker owns supply (provider lifecycle, reservoir/resume); the network owns
nothing** — it is flow-controlled, not trusted.

Concrete simplifications and deletions (beyond §4):

1. **Delete the dead shadow implementation** `apps/kit/src/voice/device-pcm-proxy.ts`
   - `pcm-frame-pacer.ts` (unused in production, different constants, a
     terminal 4013 overflow policy) — it is a standing source of confusion
     with the real `config-worker/pcm-proxy.ts`.
2. **Fix or delete the implied-but-unwired fault knobs**: every
   `cli_fault_schedule` wire knob (`WIRE_STALL`, `WIRE_THROTTLE`,
   `WIRE_RESET`, frame fates) is generated, documented, flag-parsed — and
   consumed nowhere (only CLOCK\_\* is wired). Unconsumed fault knobs are
   worse than absent ones: they read as coverage. Wire WIRE_STALL into the
   stack-A fake (§6) or remove the knobs.
3. **Stale comments that misdescribe the system**: `main.c:1061` says
   playback is clocked every 8 ms (it is 10 ms / 160 samples);
   `pcm_transport.c:47` still explains the receive burst in terms of a
   fragmented 640-byte frame while the lane rejects WS-fragmented messages.
4. **Export what exists instead of adding new schema**: underrun/reset/write
   counters and `downlink_maximum_interarrival_ms` are already computed on
   device and already have schema fields in the capabilities metrics
   component; HAVPE just sets `has_playback=false`. The observability gap
   that made this incident undiagnosable is a wiring gap, not a design gap.
5. **Keep** (explicitly reviewed, still right): the SPSC lane and its
   ownership discipline; in-band EOS ordering; the generation fence; the
   uplink freshness policy (mic is correctly freshness-over-completeness —
   the asymmetry with the speaker path is principled and should be stated
   once in `pcm_lane.c` rather than rediscovered); the reservoir as
   provider-burst absorber (6.5× realtime generation is measured).
6. **Challenge worth recording**: `pcm_transport.c:37` "Reconnect is a
   freshness boundary, not a retransmission mechanism" is correct for the
   microphone and wrong for the speaker. Generated speech is a durable
   artifact; only its head is freshness-sensitive. Fix B is the minimal
   worker-side acknowledgment of that asymmetry.

---

## 6. Q4 — Red host tests

Context from the inventory: the exact incident is already reproduced in
miniature by `esp_idf_pcm_transport_test.c:537`
(`ordered_item_loss_forces_a_fresh_socket_generation`) — **as a green test
asserting the current teardown policy**. The red suite below flips that
contract and adds the missing seams. Two harness gaps must be fixed first:
the PCM websocket fake caps pending items at 5 and forbids enqueue after
consumption starts (`fake_esp_idf_pcm_websocket.c:16-66`), and
`pcm_clock_playback_test` fixes `lane_capacity=8`; both need
parameterization to model 32-slot reality.

Run: `cmake -S apps/kit/firmware -B apps/kit/firmware/build-host && cmake
--build apps/kit/firmware/build-host --parallel && ctest --test-dir
apps/kit/firmware/build-host -R <id>`; worker tests
`pnpm --dir apps/kit exec vitest run src/userspace/config-worker/pcm-proxy.test.ts`.

- **T1 — stall-then-burst survives (transport, C).** Extend the fake with a
  gated queue (`hold()`/`release()`, capacity ≥ 48). Script: accept 12
  frames, hold 40 frames while advancing the fake monotonic clock 800 ms,
  release all. Red assertion on current code: `downlink_ordered_item_losses
== 0 && websocket_disconnects == 0 &&` every frame either accepted or
  still unconsumed. Keep a companion green test: EOS is never dropped and
  always arrives after the last accepted frame.
- **T2 — consumer stalled, frames keep arriving (transport, C).** Freeze the
  consumer side (stop draining the lane; the existing
  `iterate_kit_fake_network_task_pause()` pauses the wrong task for this)
  while the fake delivers 40 frames over 800 ms of fake-clock time. Assert:
  bounded depth ≤ 32, deferral counter > 0, zero losses, PONG obligations
  still serviced within the deferral bound.
- **T3 — sustained skew never tears down (clock playback + lane, C).**
  Producer stamps at 20.00 ms spacing, consumer renders at 20.13 ms
  (0.65%, 10× worst crystal) for 300 virtual seconds. Assert: depth bounded,
  teardown never requested, conservation `accepted == rendered +
stale_discards + deferred`, and the never-asserted counters
  (`timestamp_regressions`, `downlink_interarrival_clock_regressions`)
  exercised.
- **T4 — mid-response device close + resume (worker, vitest).** The
  inventory found zero tests that close the device socket. Script: 75 s
  response, close `device.client` at t=30 s, attach a new device pair within
  the resume window. Red on current code (everything discarded, provider
  closed). Assert after Fix B: reservoir retained, re-prime 12, total
  delivered = enqueued − played-before-close − counted, EOS delivered,
  same provider socket.
- **T5 — burst after stall at the worker seam (vitest).** Model a device
  socket whose `bufferedAmount` grows while sends continue (the current
  test's static override never accumulates). Assert the worker's behavior is
  _declared_ (defer or counted drop) rather than accidental, and that
  `downlinkDroppedBytes` attribution per site is visible (the close-discard
  today emits no diagnostic — make silence itself a red assertion).
- **T6 — long reply / memory pressure (transport + lane, C).** Parameterize
  ring capacity; run a 600 s synthetic response through a 32-slot and a
  256-slot PSRAM-sized ring under repeating 1 s stall/burst cycles. Assert:
  high-water ≤ capacity, zero heap growth (sanitized lane
  `build-host-sanitized`), and the end-to-end conservation invariant the
  inventory found missing at every seam: `proxy_sent == lane_accepted +
counted_losses + still_deferred` and `frames_acquired == frames_released`.
- **T7 — ghost-audio guard (transport, C).** With deferral active and 30
  frames parked, inject interruption/reset; assert drain-to-EOS discards
  the parked backlog (counted) and the first post-EOS frame plays fresh.

These tests are the "no unbounded backlog, no silent data loss" contract:
every frame is played, counted-dropped, counted-deferred, or
counted-discarded — and a generation never dies for a full ring.

---

## 7. Q5 — Smallest exact physical evidence campaign

Retro first (no flashing): the durable provider events for the failing
session still exist in production storage, and `#rememberClosedPcm`
(`worker.ts:748-780`) persisted one bounded close snapshot to the DO KV.
Pull both once via the prd CLI and attach them to the evidence tree so every
`M*` above becomes `M`. Cost: minutes; also yields wall timestamps to close
§3.5.

Then the smallest instrumented reproduction — one device, one Mac, N=3
count-to-100 runs (plus reruns only if a run is network-invalid):

1. **Device, per second (wire the existing schema, don't invent one):** set
   `has_playback=true`-equivalent export for HAVPE carrying
   `downlink {received, dropped, depth, high_water}` **plus**
   `underrun_incidents`, `underrun_silence_samples`,
   `stale_frames_discarded`, `playback_resets`,
   `downlink_frames_discarded_by_reset`, `playback_write_errors`,
   lane `downlink_maximum_interarrival_ms` (reset per sample window), the
   uplink deferral trio (already exported), Wi-Fi RSSI (already exported),
   and — after Fix A — deferral counters. All fields already exist as
   counters or schema; this is wiring in `sample_runtime_metrics`.
2. **Worker, per second:** ring-buffer the last ~120 s of
   `{framesSent, queuedBytes, highWater, catchUp, lateness, overrun,
egressOverrun, bufferedAmount, depthObservation}` inside the bridge and
   flush it into the close snapshot and into each run's evidence dir. The
   close snapshot exists; only the series is new.
3. **Provider lifecycle:** retain `provider-events.jsonl` with wall
   timestamps for response.created/audio deltas/response.done (harness
   already does this for harness runs; the gap was live sessions).
4. **Network validity (the standard the day-log itself set):** on the Mac, a
   1 Hz timestamped probe series (ping gateway + RSSI) started before the
   turn and ended after transcription, so the run is network-valid or
   network-invalid _by data_, never network-unknown. A run with a stall
   ≥ 400 ms that still completes is a _stronger_ pass than a clean run —
   label both.
5. **Acoustic truth:** Mac `say` prompts the device; record the speaker with
   SoX (not ffmpeg/avfoundation — it drops ~20% of frames, per the
   M5StickS3 capture artifact finding); transcribe and assert every number
   1–100 in order; retain WAV + transcript + alignment offsets.
6. **Alignment key:** every stream carries either wall time (Mac, worker,
   provider) or device uptime; the worker logs one `(wall, device uptime)`
   pair per metrics sample, anchoring all series to one timeline at ±1 s.
7. **Provenance (fixes §2.3.3):** the flash manifest records `git describe
--dirty`, the sdkconfig hash, and the image SHA already captured.

Pass criteria per run: all 100 numbers transcribed in order; zero downlink
drops/failures/disconnects during the response; depth high-water < 32 (or
< capacity post-fix) with the per-second series retained; underrun silence
budget explicit; network-valid. Three consecutive passes, at least one of
which shows a ≥ 200 ms network disturbance absorbed, ends the incident.

---

## 8. Q6 — Memory placement and ring sizing

Current placement (C, linker-map-verified): both PCM rings live in internal
DRAM inside `static struct havpe_runtime` (`.bss.runtime` = 86,600 B at
0x3fca5c40); a downlink slot is ~656 B (kind + received_at + 640 B frame), so
the ring costs ~21 KB internal. PSRAM is 8 MB octal @80 MHz (auto-detected;
N16R8 per first-party board), already used for the 128 KiB control slots via
`EXT_RAM_BSS_ATTR` and for the mbedTLS heap; runtime metrics export free
PSRAM/internal on every sample.

**Is a larger HAVPE ring safe?** Mechanically yes, with the same pattern the
control slots use: move only the slot **storage** to `EXT_RAM_BSS_ATTR`
PSRAM; keep the `iterate_kit_spsc_ring` bookkeeping (sequences, atomics) in
internal DRAM (the S32C1I/PSRAM atomics workaround in sdkconfig is exactly
why the sequences should not move). The ring is CPU-memcpy'd on both sides —
never DMA'd — so PSRAM caching is the only cost: 32 kB/s of traffic against
an ~40 MB/s octal bus is noise, and the audio tasks already tolerate
PSRAM-XIP instruction fetch. A 256-slot (5.12 s, ~168 KB) or 512-slot ring
is a small fraction of free PSRAM and returns ~21 KB of scarce internal
DRAM as a bonus.

**But capacity is not the fix, per the review's own constraint and the
system's own history.** The reservoir went 4 s → 8 s → 60 s → 90 s in two
days, each step after a new overflow (M); a 5 s device ring merely moves the
cliff to a 5 s stall (measured outages on this Wi-Fi reach 17–19 s) and makes
the unbounded-latency-debt and barge-in-flush problems _worse_ by deepening
the opaque queue. Sizing guidance:

- With **Fix A (defer)**: keep 32 slots internal. Deferral makes ring
  capacity a latency-debt bound, not a survival bound; 640 ms is a fine debt
  cap, and the TCP window is the elastic layer.
- With **Fix A′ (drop)**: 128–256 PSRAM slots meaningfully reduce loss
  windows and are safe as above — paired with the drop policy, never
  instead of it.
- With **Fix D**: the PSRAM ring becomes the primary buffer by design
  (2–8 s), and the skip-to-live policy is what bounds debt — capacity is
  then a product choice, not a crash margin.

---

## 9. Appendix

### 9.1 Where the backlog physically sits during a stall (C)

Worker isolate (`bufferedAmount`, observed < 10,240 B) → CF edge kernel
socket buffer (invisible, holds the bulk: 0.7 s stall ≈ 22 KB) → Wi-Fi/AP
queues → device lwIP receive window (5,760 B ≈ 9 frames) → mbedTLS record
(≤ 16 KB, PSRAM) → WS receive storage (exactly one 640 B frame,
`esp_idf_pcm_transport.h:212-213`) → 32-slot lane → 60 ms I2S DMA → XMOS →
codec (TLV320AIC3204 — note: no TAS2780 exists on this board; earlier notes
saying otherwise are wrong).

### 9.2 `downlinkDroppedBytes` ledger sites (C)

reservoir overflow (`:1616`), pacing overrun (`:1754`),
`#discardDownlinkQueue` (`:1832` — via close, conversation end, uplink turn
start, VAD speech_started, response.done paths, provider detach, overflow
w/o provider), device-socket-not-open (`:1843`), egress overrun (`:1868`),
interrupted provider PCM (`:1169`), unsolicited manual-mode PCM (`:1934`).
Read it as a ledger, never as one event.

### 9.3 Timeline (UTC, M except where noted)

19:34:37Z flash #2 (ring-ui, dirty tree ≈ 79eb222b2 + ring-UI; smoke: 136
downlink frames, 0 drops) → incident between 19:34Z and ~20:27Z (M\*): boot
accumulates ~1,696 downlink frames over prior turns → count-to-100 response:
provider done in ~11.5 s; reservoir peak 2,042,196 B at ~t+11.6 s; grid sends
1,534th frame at ~t+30.6 s; ring hits 32; one BACKPRESSURE; generation
retired; worker sees 1011; discards 1,431,606 B (+ ~66.6 KB earlier ledger)
→ post-failure snapshot (cumulative): 3,230 / 1 / 0 / 32 / 1 → 20:27:57Z
HEAD commit d00a5b242; adventures + landing docs written (untracked).

### 9.4 Primary sources

Firmware: `pcm_transport.c` (esp. 348-492), `pcm_lane.c` (409-565, 654-725),
`spsc_ring.c`, `pcm_clock_playback.c`, `voice_pe_audio_owner.c` (esp.
566-694, 776-984), `main.c` (HAVPE target, esp. 64-108, 326-395,
1053-1065, 1244-1250), `esp_idf_websocket_policy.h`, HAVPE `sdkconfig`.
Worker: `config-worker/pcm-proxy.ts` (esp. 33-49, 231-243, 398-409,
548-581, 707-725, 1655-1784, 1852-1936, 2204-2229), `worker.ts` (276-285,
440-451, 698-700, 748-780), `pcm-proxy.test.ts`. Tests/harness:
`esp_idf_pcm_transport_test.c`, `fake_esp_idf_pcm_websocket.c`,
`pcm_clock_playback_test.c`, `pcm_lane_test.c`, `spsc_ring_test.c`,
host-CLI seam modules. Docs/evidence: `voice-device-adventures-2026-08-02.md`,
`home-assistant-voice-preview-edition-vertical-slice-landing-2026-08-02.md`,
`m5sticks3-vertical-slice-landing-2026-07-31.md` (reservoir history),
`fable-stick-multiturn-pacing-review-2026-08-01.md` (160–170 ms gap
measurements), `apps/kit/evidence/*` HAVPE and Stick runs cited inline.
First-party: `esphome/home-assistant-voice-pe` yaml (I2S secondary, 48 k/32,
GPIO map), `voice-kit-xmos-firmware` ffva (I2S master 48 k, DS3 reference
path), ESP-IDF v5.4.2 (`i2s_std.c`, `i2s_common.c`, S3 `soc_caps.h` — no
APLL).
