# Fable review: first unattended StackChan Grok voice turn through the deployed userspace `/pcm` path — 2026-08-01

Baseline reviewed: `ce1a98be3` (kit: answer xAI voice keepalives). While this review
was running, `ebaa13332` (fix(kit): preserve StackChan startup audio lead) landed on
the same branch; it addresses exactly question 1 and is evaluated in §1 rather than
re-proposed. No implementation or tests were edited by this review.

Scope is strictly the three questions asked. Adjacent material already covered
elsewhere is referenced, not repeated: port groundwork in
`fable-stackchan-fast-port-review-2026-07-31.md` §2.5, uplink/PTT boundary in
`fable-stackchan-ptt-gate-review-2026-08-01.md`.

## Shortest safe route to one turn

1. Ship the branch as of `ebaa13332` (the startup-lead fix is required; see §1 —
   without it every reply is deterministically clipped ~120–160 ms in).
2. Deploy the config worker, set project kv `kit-pcm-mode=grok`
   (`worker.ts:443-449`), flash the StackChan target, start a conversation so
   `reconcile_pcm_conversation` opens `/pcm` (`targets/stackchan/main/main.c:660-675`).
3. Run exactly one PTT turn: press → speak ~2 s → release → answer plays. Keep the
   turn short and start it promptly after connect: the largest residual risks (§2)
   are provider recycling mid-turn, which today either eats the turn silently or in
   the worst case closes the device lane too.
4. Adjudicate with metrics, not ears (§4). No gain changes are needed before run 1;
   the one measured gain delta versus prior art (§3, −12 dB uplink) is a
   watch-item, not a precondition.

## 1. 160 ms userspace lead vs `maximum_downlink_frame_age_ms = 120` — VERIFIED mismatch

**Mechanism.** The bridge primes the device with eight 20 ms frames sent
back-to-back the moment its 32-frame source watermark fills, then paces one frame
per 20 ms (`DEVICE_INITIAL_LEAD_FRAMES = 8`, `pcm-proxy.ts:25`; burst loop
`pcm-proxy.ts:911-920`). The device stamps each downlink frame with its own
arrival clock when the transport publishes it into the lane
(`platforms/iterate_esp_idf/pcm_transport.c:680-692`), and the playback clock
discards any acquired frame with `now − received_at > maximum_frame_age_ms`,
one frame at a time (`components/core/src/pcm_clock_playback.c:270-284`).

The 8-frame burst arrives at essentially one instant, and CoreS3 render starts
within one 8 ms codec chunk. Frame k of the burst is therefore acquired ~20·k ms
after its stamp: frame 6 at ~120+ε ms and frame 7 at ~140+ε ms. With a 120 ms
limit (pre-fix `targets/stackchan/main/main.c:739`, literal `120U`), frame 7 —
and with any ε > 0 also frame 6 — is discarded on a perfect network:
**20–40 ms of every reply, always, ~120–160 ms into playback**, plus a paired
underrun, with the standing lead then pinned at the gate boundary so any
subsequent scheduling excursion causes further mid-reply stale drops.

**Why only StackChan.** The age gate in this form exists only on the
`iterate_core_s3_audio` platform; both proven physical targets run the Stick
policy of 400 ms (`platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_realtime_audio_policy.hpp:28`).
The 8-frame lead was validated against 400, never against 120. The Stick already
learned this exact lesson once: its initial 200 ms bound sat below a measured
257 ms receive-to-DMA startup excursion and "created clipping rather than
preventing backlog" (`m5sticks3_realtime_audio_policy.hpp:19-27`).

**The landed fix (`ebaa13332`) is the correct minimal one.** It moves the value
into `targets/stackchan/main/stackchan_realtime_policy.h` at the proven 400 ms
and adds precisely the smallest regression test this review would have specified:
`stackchan_accepts_the_userspace_startup_lead` in
`firmware/tests/pcm_clock_playback_test.c:268-308` publishes eight frames at one
instant and renders twenty 128-sample chunks on the 8 ms grid, asserting all
2 560 samples render with `stale_frames_discarded == 0` and
`underrun_incidents == 0`. Verified by inspection: under the old 120 ms limit
that test drops frame 7 (acquired at +136 ms) and fails; at 400 ms it passes.
Sharing the header with the host test means the flashed policy and the tested
policy cannot drift.

**Residual gap (small, flagged not fixed).** The test's
`userspace_initial_lead_frames = 8` (`pcm_clock_playback_test.c:30`) duplicates
the TypeScript `DEVICE_INITIAL_LEAD_FRAMES = 8` with no cross-language tie. 400 ms
tolerates a lead up to ~18 frames; if userspace ever raises the lead past that,
nothing fails until hardware. A one-line guard in the style of
`src/device/firmware-architecture.test.ts` (TS test greps the C policy header and
asserts `400 ≥ 20·(lead+2) + margin`) would pin the cross-layer contract.

## 2. Why a provider close/replacement can still end the device `/pcm` socket

The independence intent is explicit and the happy path is tested: provider close
detaches only the provider and triggers reconnect
(`pcm-proxy.ts:1055-1073` → `onProviderUnavailable` → `#ensureProvider`,
`worker.ts:232-234, 345-393`; test "keeps the device lane alive when an idle
provider closes…" `pcm-proxy.test.ts:676-720`; design comment
`providers.ts:131-137`). The coupling survives through four mechanisms, ranked
by evidence:

**H1 — `#fail()` closes both sockets, and provider-lane trouble routes into it
(strongest code-certain path).** Every `#fail` ends the session with code 4000,
device socket included (`pcm-proxy.ts:1075-1078`, `close()` at 416-431). Provider
conditions that reach it: `uplink-backpressure` when the provider socket's
`bufferedAmount` exceeds 10 240 B ≈ 320 ms — checked on every mic frame
(`pcm-proxy.ts:480-488`) and on every control send, including commit,
`response.create`, keepalive pong, and function-call output
(`pcm-proxy.ts:1039-1053`); also `socket-error` on an unsupported provider
message shape (`pcm-proxy.ts:557-560`). A provider that dies abnormally (xAI node
loss, network partition) typically stalls its TCP first, so during an active
press the mic-frame check trips `#fail` and kills the device lane in exactly the
window where logs then also show the provider closing — indistinguishable
post-hoc from "provider close took the device down". Critically, the entire unit
suite cannot see this path: the captun socket fake has no `bufferedAmount`, and
`socketBufferedAmount` treats absent as 0 (`pcm-proxy.ts:1152-1173`), so the
backpressure branches are dead in tests and live only under workerd.

**H2 — provider death mid-response never terminates the device's response
(certain code gap; kills the turn, ends the socket only indirectly).**
`#detachProvider` discards the downlink queue (`pcm-proxy.ts:1003-1015`) without
ever sending the zero-length end-of-response marker; `#downlinkResponseDone` is
reset so `#finishDownlinkResponse` (`pcm-proxy.ts:992-1001`) becomes unreachable
for that response. The device drains its ≤160 ms lead, then renders
underrun silence with `response_active` stuck true
(`pcm_clock_playback.c:69-79`); no downlink watchdog exists to close or restart
the socket (the pcm transport's timeouts are uplink-side only —
`pcm_transport.c:600-606, 787, 1062-1077`). The socket survives but the turn
hangs unfinished; when the conversation is subsequently ended, the device itself
tears `/pcm` down (`main.c:637-651`), so the provider close is the root cause of
a device-lane close that arrives seconds later.

**H3 — correlated worker-side closes get misattributed.** The worker closes the
device lane for a Cap'n Web event-sequence gap (`bridge.close(4002)`,
`worker.ts:535-543`) and replaces the session when the device reconnects `/pcm`
(`#closeActivePcm(4001)`, `worker.ts:196`). The network conditions that kill a
provider socket frequently disturb the control lane in the same window, so a
4002 close lands beside the provider close in the same incident.

**H4 — shared Durable Object lifetime.** The device socket is a plain
`server.accept()` (`worker.ts:201`), not a hibernation accept; any isolate death
(userspace config-app deploy, `kill()`'s `ctx.abort` at `worker.ts:110-122`)
severs provider and device simultaneously.

Two adjacent findings that lose the turn without closing the socket, recorded
because they gate the "one unattended turn" goal: a failed `#ensureProvider`
attempt schedules no retry — the next attempt waits for the next
`onProviderUnavailable` edge (`worker.ts:375-393`); and the device is never told a
press landed on a dead generation, because `inputStarted()`/`inputStopped()`
return values are discarded (`device-events.ts:180, 190`).

**Smallest verification (specified, not implemented).** (a) A bridge test:
provider dispatches PCM without `response.done`, then closes → assert the device
receives the zero-length marker and `downlinkResponseDone` state recovers
(fails today, pinning H2). (b) A workerd-runtime (not captun) test or a
deliberate metric — e.g. asserting `uplink-backpressure` produces provider
detach + reconnect rather than session `#fail` once that behavior is chosen —
for H1; as long as backpressure-equals-session-death is intended, it should at
least be a distinct close code so field logs can separate H1 from H3.

## 3. One-run AEC/gain blockers from `iterate/stackchan` measured prior art

Prior art (repo `~/src/github.com/iterate/stackchan`, experiment
`02-minimal-realtime-aec`) directly observed the unattended turn FAILING on this
hardware under server VAD with continuous uplink: the device transcribed its own
playback as user input and self-answered, twice, in independent bundles
(`local/device-evidence/20260729T143623Z-sprite-eyebrows/device.log:118-136` —
assistant says "Yes, I can hear you loud and clear!", 1.66 s later the server
transcribes "Yes, I can hear you." as user speech; repeated in
`…155035Z-post-reflash-latency/device.log:123-158`). Best-measured AEC still
leaked intelligible echo (19.2 dB ERLE, residual transcribed at 0.537 similarity,
`local/device-evidence/current-sprite-poc/live-now/bounded-aec-assessment/assessment.json`),
and every semantic-gated tuning sweep failed its own confirmation re-run
(`local/aec-runs/*/tuning.json`, ERLE spread 20–30 dB run-to-run).

**None of that blocks run 1 here, by design.** The kit session pins manual turn
detection (`turn_detection: { type: null }`, `providers.ts:210`) and admits mic
audio to the uplink only inside an ordered PTT turn
(`request_uplink_active`/`capture_tap_enabled`,
`core_s3_audio_owner.c:1076, 772, 860`; intent reconciler wiring
`main.c:539-556`). A single non-overlapping turn — speak, release, listen — sends
Grok no audio while the speaker plays, so echo and AEC quality are outside the
critical path of the first turn. They return only for barge-in and overlapped
second turns.

The kit also already carries the two prior-art hardware fixes whose absence
produced silent or broken runs, and upgrades a third:

- AW88298 64-BCLK register fix, with read-back verification
  (`core_s3_audio_owner.c:40-42, 253-279`; prior art
  `firmware-ws/main/audio_pipeline.c:41-43, 174-207`, which measured
  −89.93 dBFS speaker silence before the fix).
- The +15 dB speaker volume-map extension so 100 % reaches M5Stack's own codec
  level (`core_s3_audio_owner.c:46-55`; prior art `audio_pipeline.c:152-165`).
- The AEC reference is now a **measured hardware loopback** — TDM slot 1 is MIC3,
  an analogue divider across actual speaker output
  (`core_s3_audio_owner.c:283-287`) — where prior art fed a software copy of
  intended playback and attributed its 20–30 dB ERLE irreproducibility to
  43–87 ms reference misalignment and DMA-tap sequence skips
  (`local/claude-aec-investigation-prompt.md:48-56`).

**The one evidence-backed gain watch-item: uplink level is ~12 dB below the
proven configuration.** Prior art settled on 24 dB analog mic gain **plus a
12 dB digital uplink stage** (`firmware-ws/main/app_config.h:48-58`:
`STACKCHAN_MIC_GAIN_DB 24`, `STACKCHAN_UPLINK_GAIN_DB 12`), after measuring that
low gain makes the provider deaf (at 18 dB analog, a loud prompt peaked
−37.4 dBFS and "Grok never detected speech",
`local/claude-aec-fable-prompt.md:20-26`) while 37 dB analog self-triggers VAD.
The kit runs 24 dB analog (`main.c:744`) with no digital uplink stage anywhere in
`core_s3_audio_owner.c`. Because the kit commits turns manually, quiet audio is
still processed — this degrades transcription rather than gating the turn — so it
is a likely first suspect if run 1 "hears" wrongly, and the single next lever if
so. Speaker side is the safe direction: prior art added +8 dB digital playback
gain plus a limiter that the kit omits, so the robot speaks ~8 dB quieter than
prior-art "known good"; no brownout has ever been recorded on CoreS3 (that
ceiling is the Stick's ES8311 story, `providers.ts:6-17`).

Carried-over risk to observe, not act on: the same esp-sr engine and mode
(`AEC_MODE_FD_HIGH_PERF`, filter 4, NLP 2 — `core_s3_audio_owner.c:35-37, 421`)
showed 774 ms worst-case processing spikes, 8.8 % over-budget frames and 2.5 %
DMA queue overflows in prior art's combined 32 ms loop
(`local/device-evidence/20260729T210000Z-known-good-deploy/final-status.json`).
The kit isolates AEC on its own core-1 task below the 8 ms codec owner with a
discontinuity-aware capture reserve, which should contain this to capture-side
drops; `maximum_aec_linear_us` / `maximum_aec_nlp_us` will say.

## 4. Adjudicating run 1

- Reply clipped/short at start → `stale_frames_discarded`,
  `maximum_receive_to_render_ms` (must stay ≪ 400 with ~140–160 typical peak);
  regression of §1.
- Turn silently eaten → worker log `provider-unavailable` /
  `provider-reconnect-failed` with `previousSession.lastSocketClose.source ==
"provider"` (`worker.ts` `#rememberClosedPcm`); §2 no-retry edge.
- Device socket died mid-turn → close code separates causes today only
  partially: 4000 = bridge `#fail` (H1 family), 4001 = replaced by new `/pcm`,
  4002 = event-sequence gap, 1012/abort = kill; `downlinkQueueHighWaterBytes`
  and `providerBufferedBytes` in the retained previous-session report point at
  backpressure.
- Answer plays but hangs unfinished (no end marker) → firmware
  `underrun_incidents` rising with `response_active` stuck, worker
  `providerDisconnects ≥ 1` in the same session; H2 exactly.
- Grok mishears → `providerPcmPeakSample`/`providerPcmRmsSample` prove provider
  output level; for the uplink direction compare `tdm_slot_peak[0]` against the
  §3 −12 dB uplink delta before touching any gain.
