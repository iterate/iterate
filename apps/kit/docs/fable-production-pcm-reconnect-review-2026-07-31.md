# Fable Max review: production PCM reconnect and the evidence seam (2026-07-31)

Status: independent read-only review of worktree `c-capabilities` as of
2026-08-01, including the uncommitted changes to
`prove-production-m5sticks3-grok.ts`, `production-pcm-generation.ts`, and
`production-grok-provider-events.ts`. No implementation or test files were
modified. Companion prompt:
[`fable-production-pcm-reconnect-review-prompt-2026-07-31.md`](./fable-production-pcm-reconnect-review-prompt-2026-07-31.md).

## 0. Verdict in one paragraph

The 2026-07-31T23:58 failure was not a generic Wi-Fi outage and not a provider
fault. A sub-second transport-send stall (one lost TCP segment's retransmission
timeout is sufficient to explain it) tripped the firmware's 250 ms capture-age
policy (`ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS`,
`esp_idf_websocket_policy.h:33`), which by design discards the queued
microphone epoch **and** destroys the socket generation; the harness's
one-generation contract (`waitForProductionPcmMetrics`,
`production-pcm-generation.ts:126-141`) then correctly failed the run. The
socket teardown _mechanism_ is justified by opaque TLS/lwIP suffix semantics;
the 250 ms _trigger_ is a mid-turn latency preference enforced as a
session-destroying invariant, and it makes the proof's pass probability a
function of "no single TCP retransmission during a ~10 s hold" — too flaky on
real 2.4 GHz Wi-Fi. The attribution gap named in the prompt is already largely
fixed in the uncommitted failure branch
(`prove-production-m5sticks3-grok.ts:602-659`); two residual holes remain. The
_actual_ top blocker for one clean rerun today is not transport at all: the
2026-08-01T00:12 rerun was network-valid with an exact independent transcript
match and failed only the miscalibrated relative-energy window gate
(`physical-speech-transcription.ts:2,66-71`).

Severity ranking:

| #   | Finding                                                                                                                                                       | Severity | Gate                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| F1  | Relative-energy window gate rejects real, transcribed speech at the −18 dB codec ceiling (00:12 rerun)                                                        | **S1**   | must fix before one clean rerun                |
| F2  | Failure-branch attribution fix exists but is uncommitted; `networkCapture === undefined` paths still write `networkArtifact: null` with no verdict            | **S1**   | must fix before one clean rerun                |
| F3  | 250 ms mid-hold capture-age budget destroys a session on a single sub-second send stall                                                                       | **S2**   | must fix before _reliable_ (repeatable) reruns |
| F4  | Replacement-generation provider frames are never persisted on failure (only the baseline session's)                                                           | S3       | follow-up                                      |
| F5  | Device-initiated policy resets are classified `network-invalid` with no distinct reason; systematic firmware policy failures can be laundered as network luck | S3       | follow-up                                      |
| F6  | `expectedSampleCount` fields are tautological; diagnostics series have no cadence guard (the retained 3.09 s hole passed silently)                            | S3       | follow-up                                      |
| F7  | Journal is receive-only; sent control frames (`commit`, `response.create`, tool outputs) are not journaled                                                    | S3       | follow-up                                      |
| F8  | Minor evidence honesty items (`control.connected` hardcoded, strict payload schema, cleanup close-wait always throws after a reconnect failure)               | S4       | opportunistic                                  |

---

## 1. Reconciled failure narrative (what the retained evidence actually says)

Evidence root:
`apps/kit/evidence/m5sticks3-production-grok-raw-stream-check/2026-07-31T23-58-19-288Z/`
(`failure.json`, `provider-events.jsonl`, `iterate-kit-acoustic-rwgtCh/microphone.pcm16le`).

Wall-clock anchors come from the DO (`endedAtMs`, provider `receivedAtMs`);
device-uptime and host-monotonic clocks are aligned through the diagnostics
observations (device ≈ host − 2 258 ms; host 35 955 ≈ 23:58:26.5Z).

| Time (Z)          | Event                                                                                                                                                                                                                                                                                                                                         | Source                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23:58:27.648      | Old generation `…:8104255a` live: `session.created`, `conversation.created` received                                                                                                                                                                                                                                                          | `provider-events.jsonl` seq 1–2                                                                                                                                                                                                    |
| 23:58:27.710      | `input_audio_buffer.speech_started` (PTT held, mic streaming)                                                                                                                                                                                                                                                                                 | seq 5                                                                                                                                                                                                                              |
| 23:58:29–30.75    | Incremental transcription: “Use the change color tool to make the”                                                                                                                                                                                                                                                                            | seq 6–10, last `receivedAtMs` 23:58:30.753                                                                                                                                                                                         |
| ~23:58:30.5–30.76 | Transport stops accepting: raw writes return would-block 28 consecutive times; one complete 648-byte wire frame sits in the sans-I/O transmitter (high water 648/910); 13 more frames age in the 32-slot ring (high water 8 320 B = 13 × 640)                                                                                                 | `worker.latestBeforeCleanup.deviceMetrics…uplink` (`maximumConsecutiveSendDeferrals: 28`), `buffers.websocketTransmitter/uplinkApplication`                                                                                        |
| ~23:58:31.0       | Oldest queued frame reaches 256 ms ≥ 250 ms → `capture_stale` restart: 13 frames discarded, generation abandoned                                                                                                                                                                                                                              | `lastRestartReason: "capture_stale"`, `lastRestartOldestCaptureAgeMs: 256`, `lastRestartFramesDiscarded: 13`; policy `esp_idf_websocket_policy.h:33`; decision `pcm_uplink_sender.c:256-263`; escalation `pcm_transport.c:539-548` |
| 23:58:31.015      | Device closes the TCP connection without a WS Close handshake (`esp_transport_close`, `websocket_connection.c:618-634`); DO records device close and ends the session. The phrase “WebSocket disconnected without sending Close frame” is the bridge's device-close diagnostic, not Grok speech                                               | `worker.latestBeforeCleanup.previousSession` (`closed: true`, `uplinkFrames: 161`, `endedAtMs: 1785542311015`)                                                                                                                     |
| 23:58:31.448      | Journal batch for seq 9–10 lands on the ITX stream _after_ session death — the journal drain outlives the session by design                                                                                                                                                                                                                   | `createdAt` vs `endedAtMs`                                                                                                                                                                                                         |
| ~23:58:31.3–33.5  | Device retry gate defers 250 ms, then blocking DNS/TCP/TLS/upgrade (up to 10 s budget) on the pinned network task; capture keeps producing while PTT stays held and drops 116 frames (~2.3 s) at the full ring; the harness's single-flight diagnostics RPC stalls 3.09 s across this window (host 39 044 → 42 134)                           | `capture.dropped: 116`; `WEBSOCKET_CONNECT_TIMEOUT_MS`, `pcm_transport.c:58,640-671`; retry policy `esp_idf_websocket_policy.h:34-35`                                                                                              |
| ~23:58:33.5–34.5  | Reconnect succeeds first try (connections 2, disconnects 1, errors 0). New generation `…:b0ff50b3`: fresh Grok conversation; the device-event snapshot arrives with `pushToTalk.started`, so `inputStarted()` re-arms capture (`interrupted: true`) and 90–97 frames of the _tail of the held sentence_ flow into a context-free conversation | `deviceDiagnostics.network`; `device-events.ts:178-183`; `error.observedMetrics`                                                                                                                                                   |
| +~100 ms          | Harness poll sees the replacement generation and throws `ProductionPcmGenerationChangedError` — by design (“the proof deliberately does not follow reconnects”)                                                                                                                                                                               | `production-pcm-generation.ts:109-141`; `failure.json.error`                                                                                                                                                                       |

Network context: all 33 reachability probes replied. Three samples breach the
strict validity caps (`physical-network-run.ts:28-32`): router 65.956 ms > 50 ms
at ~stall+2 s, worker 105.021 ms > 100 ms near PTT start, worker 109.803 ms >
100 ms during reconnect. RSSI held at −65…−68 dBm, `wifiDisconnects` stayed 0,
and the control Cap'n Web socket stayed perfectly clean (0 disconnects/errors,
72 messages). The device cannot see below lwIP (`tlsEgress`/`wifiEgress`
honestly `unavailable`, `pcm_transport.c:1144-1163`), but lwIP's send buffer is
5 760 B ≈ 9 frames ≈ 180 ms; for raw writes to hit would-block for 256 ms+, the
send buffer had to stay full, i.e. no ACK progress — exactly the signature of a
single lost segment waiting out an RTO (or an equivalent Wi-Fi MAC-level stall
burst). The 1 Hz probes cannot exclude a sub-second stall; “every probe
replied” and “the send path stalled > 250 ms” are simultaneously true.

So: **deliberate device policy converted a ~300 ms transport hiccup into the
loss of the Grok session, and the harness (correctly) converted that into a
failed run.** The stale-frame discard, the generation reset, the fresh
provider conversation, and the immediate proof failure all behaved exactly as
designed and documented. The design question (Q2/Q3) is whether that policy
budget is right; the evidence question (Q1/Q4) is whether the failure explains
itself without a human. At the time of the failure it did not (no
`network.json`); the uncommitted harness now mostly does.

---

## 2. Q1 — Smallest correct fix for automatic durable attribution

### 2.1 What is already correct (verify and commit it)

The uncommitted failure branch (`prove-production-m5sticks3-grok.ts:602-659`)
is the right smallest fix and I verified it against the retained data:

- It builds the classified artifact from the same exact-interval capture with
  `audio: { passed: false, failure: runFailure.message }` and writes
  `network.json` exclusively (`writePhysicalNetworkRunArtifact`, `wx` flag,
  `physical-network-run.ts:528-542`), then embeds
  `{ artifactPath, classification, reasons }` in `failure.json`
  (`networkArtifact`, script lines 696-703).
- Byte progress for the _failed_ generation is recovered through the worker's
  bounded `previousSession` slot
  (`productionPcmGenerationProgress`, `production-pcm-generation.ts:82-107`;
  retention `worker.ts:554-583`). Replayed against the retained failure it
  yields 161 uplink frames — matching
  `previousSession.uplinkFrames: 161` — so `terminal-pcm-no-progress` cannot
  spuriously fire.
- The bogus `dnsAndConnect: { kind: "not-applicable", reason: "direct-lan" }`
  that the retained (old-code) `failure.json` carries for a _deployed-worker_
  route is corrected: `withRemoteDnsAndConnectMeasurement`
  (script lines 1284-1317) always records `kind: "measured"` with explicit
  `not-observed` placeholders when the probe never ran, and
  `measureRemoteDnsAndTlsConnect` resolves with `failure` outcomes instead of
  rejecting (`physical-network-reachability.ts:164-224`), so the failure branch
  cannot lose the artifact to a probe error.
- Replaying the classifier over the retained interval gives
  **`network-invalid`** with reason codes `host-rtt-exceeded` (router 65.956 >
  50 at 42 954; worker 105.021 > 100 at 36 955; worker 109.803 > 100 at
  43 954), `pcm-socket-disconnect` (0→1), `pcm-socket-reconnect` (1→2),
  `pcm-socket-disconnected` (the 42 134 sample where connections == disconnects,
  `physical-network-run.ts:352-357` → `physical-network-validity.ts:320-338`),
  and `terminal-pcm-socket-disconnect`/`-reconnect`
  (`physical-network-validity.ts:416-427`). Automatic, durable, and correct.

The no-pass-laundering property holds structurally: with
`audio.passed === false` the classification can only be `network-invalid`,
`indeterminate`, or `audio-invalid` (`physical-network-run.ts:507-515`), and
the run-level `passed` additionally requires `classification === "valid"`
(script line 865). A network-invalid interval can therefore never become an
audio pass, and an audio pass can never survive a bad network verdict.

### 2.2 Residual holes (the actual remaining “smallest fix”)

1. **`networkCapture === undefined` still yields no verdict.** Failures before
   `networkMonitor.start()` (script lines 195-279: capture start, preflight
   hang-up, `waitForWorkerIdle`, `conversation.start`, the 30 s connected-wait,
   red acknowledgement) and the case where `networkMonitor.capture()` itself
   throws in the finally block (lines 538-545) write `failure.json` with
   `networkArtifact: null`. Fix: when `failureNetworkArtifact` is absent, write
   a literal
   `networkArtifact: { classification: "indeterminate", reasons: [{ code: "no-media-interval" | "network-capture-unavailable", … }] }`
   instead of `null`. No fabricated evidence, one unconditional verdict field,
   and “every failed physical run gets a durable attribution” becomes literally
   true. (A run can still die with no JSON only if the filesystem write itself
   fails — acceptable.)
2. **Commit the uncommitted fix.** The retained 23:58 evidence was produced by
   the pre-fix binary; until the working-tree changes land with their tests
   (`production-pcm-generation.test.ts`,
   `production-grok-provider-events.test.ts` additions), the next failure on a
   clean checkout regresses to eyeball-attribution.

### 2.3 Classifier honesty debts (follow-up, not blocking)

- **Tautological completeness.** Every `expectedSampleCount` this producer
  emits is derived from the very sample list it validates
  (`physical-network-run.ts:330-334` for diagnostics, `:384` for reachability),
  so the classifier's `incomplete-*` codes are dead paths. Coverage integrity
  currently rests solely on the reachability gap check
  (`physical-network-validity.ts:239-248`, 1.5 s cap, boundaries pinned to the
  interval ends). The diagnostics-derived lanes (deviceNetwork, socket
  counters) have **no cadence guard at all**: the retained run has a 3.09 s
  diagnostics hole (host 39 044 → 42 134, single-flight sampler stalled across
  the death window) and would still classify as complete. Cumulative counters
  keep disconnect _counts_ visible across the hole, but `linkUp`/RSSI
  transients inside it are unobservable. Fix: derive expected diagnostics
  samples from `interval / sampleIntervalMs` with a tolerance, or add the same
  gap-scan the reachability lanes get, emitting an `indeterminate` reason.
- **Device-policy resets are indistinguishable from network faults (F5).** The
  socket-counter reasons treat any `/pcm` disconnect as network invalidity. A
  `capture_stale` teardown is _self-inflicted_; if a firmware policy defect (or
  an over-tight budget) is the systematic cause, every mildly congested run is
  excused as “network luck” and the proof never converges while each rerun
  looks blameless. The device already exports exact attribution
  (`captureStaleRestarts`, `transportDisconnectRestarts`,
  `noProgressTimeoutRestarts`, `lastRestartReason` — visible in
  `worker.latestBeforeCleanup.deviceMetrics`). Surface it: when the disconnect
  delta is fully explained by `captureStaleRestarts`/`producerBackpressure`
  deltas, add a distinct reason code (e.g. `pcm-socket-device-policy-reset`)
  beside the network-invalid verdict so the trend is countable across retained
  runs. Keep the verdict conservative; make the cause visible.

---

## 3. Q2 — Why a 250 ms freshness breach destroys the session

### 3.1 The mechanism is coherent and mostly _is_ required

Chain, with sources: the sender checks the **oldest** acquired frame's age
before any raw write and, on breach, purges every queued frame and returns
`RESTART` (`pcm_uplink_sender.c:254-263`, `restart_for_freshness`
`:136-193`); the conductor upgrades that to an abandoned generation
(`finish_generation`, `pcm_uplink_conductor.c:263-274`); the platform then
closes the socket precisely because local purging cannot reach lower layers —
“Closing the socket in the requested restart destroys the remaining opaque
TLS/lwIP/Wi-Fi suffix” (`pcm_transport.c:539-548`), echoing the API contract
(“The platform must still close the actual socket to destroy opaque
TLS/lwIP/Wi-Fi bytes”, `pcm_uplink_conductor.h:130-137`).

Two facts make socket death genuinely unavoidable _once you decide queued
bytes must not arrive_:

1. **RFC 6455 forbids abandoning a partially written data frame.** A stalled
   partial frame can only be completed or the connection destroyed; you cannot
   interleave or truncate (`pcm_uplink_conductor.c:303-309`, the
   `data_frame_active` handling). In this incident one complete 648-byte wire
   frame was already committed to the transmitter.
2. **Bytes accepted by esp-tls/lwIP are irretrievable.** There is no unsend;
   the ~5 760 B lwIP send buffer plus TLS internals can hold ~180 ms+ of
   speech. Closing the TCP connection — and, server-side, replacing the
   session identity so late frames are rejected by generation
   (`worker.ts:191-196`; `pcm-proxy.ts:247-296`) — is the only mechanism that
   guarantees the suffix dies.

So the answer to “is teardown required by opaque TLS/TCP suffix semantics?” is:
**yes, teardown is the correct mechanism _given a violated freshness bound_.**
The architecture is internally consistent and the host tests pin the semantics
(`capture_age_expiry_purges_queued_history_before_send`,
`pcm_uplink_conductor_test.c:474-493`;
`disconnect_purges_the_whole_microphone_epoch`, `:521-545`).

### 3.2 But the trigger encodes the wrong invariant mid-turn

What actually needs to be true is turn-boundary hygiene, not per-frame
mid-turn latency:

- **The dangerous leak is cross-turn.** Frames captured in turn N must never
  arrive after the DO's `input_audio_buffer.commit` for turn N, because the
  bridge relays any device binary regardless of turn state
  (`pcm-proxy.ts:363-399` has no turn gate) and Grok's manual-turn buffer would
  fold them into turn N+1. Today the _only_ thing bounding that race is the
  tight staleness budget: the release edge travels device → OS → DO over the
  Cap'n Web lane while the PCM tail travels the `/pcm` lane, and nothing
  orders them.
- **Within a held turn, late-but-ordered audio is harmless.** Turn detection is
  manual (`turn_detection: { type: null }`, `providers.ts:204`; confirmed in
  the retained `session.updated`). Grok buffers input until commit; delivering
  frames 300–800 ms late during a hold produces a byte-identical committed
  turn. The 250 ms budget therefore enforces a _latency preference_ at the
  price of the entire session — in this incident it cost a healthy
  conversation, the tail of the user's sentence went to a fresh context-free
  conversation, and the run died, all to avoid ≤ ~400 ms of in-order delay that
  the provider cannot even observe as staleness.

The failure probability compounds: at 50 frames/s over ~10 s of hold, a single
lwIP RTO (≥ ~300 ms without fast retransmit) anywhere in the window kills the
run. That is exactly the flake class the retained evidence shows, and reruns
do not fix a base rate.

### 3.3 Recommended shape (bounded, not speculative)

1. **Retune the mid-hold budget to the ring bound.** The 32-slot ring already
   caps worst-case application staleness at 640 ms. Raising
   `ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS` from 250 to 640 (one constant,
   `esp_idf_websocket_policy.h:33`) makes a single RTO survivable while the
   existing `restart_after_no_progress_ms = 500` remains the true dead-socket
   detector and `maximum_frame_send_duration_ms = 1000` still bounds one
   frame's wire time. Note the init-time invariant
   `maximum_frame_send_duration_ms >= restart_after_no_progress_ms`
   (`pcm_uplink_sender.c:203-206`) is unaffected.
2. **Make the turn boundary explicit instead of racing it.** Mirror the
   downlink's zero-length end-of-response marker (`pcmEndOfResponse`,
   `pcm-proxy.ts:29,474`) on the uplink: on PTT release the device drains the
   remaining ring frames and sends one empty binary frame; the DO defers
   `input_audio_buffer.commit` until it sees the marker (with a bounded 1–2 s
   fence timeout, after which it destroys the generation exactly as today) and
   drops-with-count any binary that arrives between marker and the next
   `inputStarted()`. This removes the cross-turn leak _structurally_, ends the
   commit/tail race, and makes the staleness budget purely a latency knob.
   ~30 firmware lines beside the existing release path, ~20 DO lines, both
   host-testable; it reuses an idiom the protocol already has.
3. **Do not** pursue per-frame timestamp headers, WebSocket-level flush tricks,
   or keeping the socket while trying to invalidate its suffix — the first is
   protocol churn the marker makes unnecessary, the latter two are impossible.

With (1)+(2), stale speech still cannot leak across a commit, sub-second
stalls stop destroying sessions, and genuine socket death still restarts
within 500 ms.

---

## 4. Q3 — Should the `/pcm` DO preserve one Grok session across a device reconnect?

**No — not for this slice, and probably not later either.** Keep the simple
contract and state it explicitly.

Why preservation buys almost nothing here:

- The mid-utterance audio is unrecoverable _by design_: the device purged it
  (`iterate_kit_pcm_uplink_conductor_begin_generation` doc,
  `pcm_uplink_conductor.h:114-128`), so an adopted session could only continue
  a sentence with a hole in it — worse than a clean restart.
- Each generation's Grok conversation is already context-free
  (`keep_context: false` in the retained `session.updated`); there is no
  conversational state worth carrying at this stage of the program.
- The proof's epistemics _require_ the one-generation unit: counters on
  opposite sides of a reconnect cannot prove a lossless conversation
  (`production-pcm-generation.ts:109-118`). A preserved provider session would
  not un-fail the proof; it would only blur the boundary.
- The system already recovers _availability_ correctly and quickly: the
  device's retry gate reconnects, the DO mints a fresh generation and provider
  (`#handlePcm` connects the provider _before_ closing the old session, so a
  failed connect leaves the old session intact — `worker.ts:172-196`), and the
  device-event snapshot re-arms held PTT into the new session
  (`device-events.ts:178-183`; observed in the evidence as
  `interrupted: true`, 90–97 tail frames).

The simpler recovery contract to document and test: **device reconnect ⇒ new
sessionId ⇒ fresh provider conversation ⇒ PTT state re-derived from the event
snapshot; the closed generation survives exactly once in `previousSession`
(memory + DO KV, `worker.ts:554-583`); the harness treats any generation
change as terminal, attributable evidence.** One wart to fix while
documenting: after a reconnect-shaped failure the cleanup's closed-generation
wait (script lines 557-564) can never succeed — it pins
`expectedSessionId = baselineWorker.sessionId` while the active metrics carry
the replacement id, so it always throws a second
`ProductionPcmGenerationChangedError` that `runFailure ??=` discards. Match
via `metrics.previousSession` instead, or skip the wait when the generation
already changed.

If a future call-model slice ever justifies preservation, the tight spec is:
adoption keyed by (`projectId`, `deviceId`, prior `sessionId`) under the same
project bearer; a single bounded hold (≤ 5 s) on device close before the
provider is torn down; adoption always sets `interrupted = true` and discards
the entire 400-frame downlink reservoir (never resume playback across a gap);
one adoption per hold window, monotonic device connection generation to reject
the older socket racing back; memory bound = the existing bridge plus one
timer. But prefer provider-level context re-establishment (replay
instructions/history on a fresh socket) over socket-level adoption — it avoids
the seam entirely.

---

## 5. Q4 — Raw provider-event capture audit

| Property             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Exact bytes          | **Pass.** `raw` is the exact received text frame; parsing is for dispatch only and never rewrites it (`pcm-proxy.ts:436-449`); journal embeds it verbatim (`provider-event-stream.ts:110-124`); JSONL re-emits it as a JSON string — lossless (`production-grok-provider-events-artifact.ts:48-67`). PCM never enters the lane.                                                                                                                                                                  |
| Order & identity     | **Pass.** Per-generation sequence assigned at observation; `sessionId` scopes the generation; `path` is the ownership boundary and is filtered before payload parse (`production-grok-provider-events.ts:76-86`); idempotency key `kit-provider-event:${sessionId}:${sequence}` makes stream appends replay-safe.                                                                                                                                                                                |
| Continuity           | **Pass.** Strict parser enforces 1..N (`:100-111`); the new tolerant parser retains partial evidence on failure; the artifact records exact discontinuities and a verdict (`-artifact.ts:46-55,79-85`). A dropped event leaves a numbered hole — honest by construction. The retained failure artifact is `contiguous-from-one`, 1..10.                                                                                                                                                          |
| Bounded backpressure | **Pass.** 64 events / 256 KiB pending / 64 KiB per event / batches of 8; single drain promise; `observe()` never awaits; append failure drops the queue once with exact counters and a diagnostic (`provider-event-stream.ts:17-20,83-131,160-196`). The proof asserts the journal quiescent and exact (script lines 393-397, 440-461).                                                                                                                                                          |
| Secrets              | **Adequate.** The artifact writer refuses to write if the project key or xAI key appears, preferring no artifact over redaction (`-artifact.ts:69-75`). Two accepted bounds worth recording: the durable _stream_ copy is not guarded by that tripwire, and the short-lived minted client secret (`credential.value`, `providers.ts:153-163`) is not in `sensitiveValues` (it never leaves the worker; Grok has never been observed echoing it).                                                 |
| Failure usability    | **One real gap (F4).** The failure branch parses only `baselineWorker.sessionId` (script lines 505-519), so the replacement generation's frames — 8 control events on `…:b0ff50b3`, the exact forensics for what the fresh conversation heard and when — exist in the durable stream but in no retained artifact. Retain both: also parse `failureWorkerSnapshot.sessionId` when it differs and write a second artifact (or a grouped one) beside `provider-events.jsonl`.                       |
| Schema robustness    | Minor: `ProviderEventPayload` is `z.strictObject` (`production-grok-provider-events.ts:16-22`) — any additive worker payload field breaks the harness's _failure capture_ first. Use a passthrough/versioned parse. `getEvents` `limit: 500` is ample for one turn; a multi-generation failing run could exceed it — note only.                                                                                                                                                                  |
| Sent lane            | **Gap (F7).** Only received frames are journaled. `session.update`, `input_audio_buffer.commit`, `response.create`/`cancel`, and `conversation.item.create` (tool outputs) are reconstructable only via echoes (`session.updated`, `committed`, `conversation.item.added`). For interruption and duplicate-response forensics (the 22:43 double-speech incident was exactly this class), journal sent control frames through the same bounded journal with a direction field. Small and bounded. |

---

## 6. Q5 — Deletions and simplifications that shorten time-to-reliable-proof

Grounded in the two most recent unattended runs (23:58 failure, 00:12 rerun):

1. **Recalibrate the relative-energy window gate (F1 — the current blocker).**
   The 00:12 rerun (`…/2026-08-01T00-12-03-066Z/iterate-kit-acoustic-KZ8Ilm/`)
   was network-valid with an exact digital ledger, mic transcript ==
   provider transcript (“the deploy iterate stick voice path is working”),
   RMS ratio 3.50×, zero clipping — and failed solely on
   “1 window ≥ 4 above 2.5 × ambient-max” (`manifest.json`;
   `physical-speech-transcription.ts:2,66-71`). The threshold 14.317 × 2.5 =
   35.79 sits _above the response's p99_ (28.72): the gate demands four 20 ms
   windows louder than the 99th percentile of genuine speech at the
   brownout-safe −18 dB ceiling (`providers.ts:6-17`). Ambient _max_ over ~50
   windows is an extreme-value statistic; rebase the threshold on a robust
   ambient statistic (e.g. 2.5 × ambient p95, or keep max but require windows
   above ambient-max × 1.5) while keeping the exact-STT, causal-ratio, and
   zero-clipping gates unchanged. Red test = the literal 00:12 numbers.
2. **One-constant firmware retune plus the turn fence (F3, §3.3).** Everything
   else in the transport held: zero protocol failures, zero worker-side drops,
   clean control lane, exact conservation on both neighbouring runs.
3. **Stop manufacturing healthy-looking evidence.**
   `socketCounters.control.connected` is hardcoded `true`
   (`physical-network-run.ts:341`) — derive it or drop the field; dead
   `incomplete-*` classifier paths (F6) likewise pretend to check something the
   producer cannot fail.
4. **Don't build:** DO-side session preservation (§4), multi-generation
   harness following, per-frame timestamp headers, any PONG-based delivery
   credit (already explicitly rejected, `pcm_uplink_conductor.h:88-93`), or a
   second acoustic oracle — the fixed 120-RMS gate is already correctly
   demoted to a recorded follow-up; leave it demoted.
5. **Automate the rerun loop now that verdicts are automatic.** The CLI exits
   after flushing (script lines 1319-1332). A tiny wrapper that reruns on
   `network-invalid`, stops on `audio-invalid` (defect signal!), and stops on
   the first `passed: true` converts strict gates from a babysitting cost into
   wall-clock only. This is safe _only_ because network-invalid can never be a
   pass (§2.1) — keep that invariant test-pinned.

---

## 7. Red regression tests to write (each must fail first)

1. **Early-failure literal verdict (F2).** Harness unit: a run failing before
   `networkMonitor.start()` (and one where `capture()` throws) must write
   `failure.json` with
   `networkArtifact.classification === "indeterminate"` and a
   `no-media-interval` / `network-capture-unavailable` reason — today it
   writes `null`.
2. **Retained-failure replay.** Feed `buildPhysicalNetworkRunArtifact` the
   23:58 fixtures (10 diagnostics observations, 33 reachability samples,
   previousSession progress 161/0) and assert `network-invalid` with exactly
   the reason codes listed in §2.1 — pins the classifier against the real
   incident.
3. **Diagnostics cadence (F6).** Same fixtures: the 3.09 s diagnostics hole
   must surface an `indeterminate` reason (or a duration-derived
   expected-count mismatch) — today the artifact reports complete coverage.
4. **Conductor survives one RTO (F3).** Host C test beside
   `capture_age_expiry_purges_queued_history_before_send`
   (`pcm_uplink_conductor_test.c:474`): frame submitted at t=0, raw writer
   defers until t=400, then accepts — with the 640 ms budget expect `SENT` and
   zero restart incidents; at t=700 expect `capture_stale` with a full purge.
5. **Turn fence (§3.3.2).** DO test (captun pair): device sends 3 frames + one
   empty marker; `inputStopped()`; assert `input_audio_buffer.commit` is sent
   only after the marker; a binary frame arriving after the marker and before
   the next `inputStarted()` is dropped and counted, never relayed; marker
   timeout destroys the generation.
6. **Both-generation retention (F4).** Synthetic stream containing session A
   seq 1..10 and session B seq 1..8: the failure path must persist both
   sessions' frames durably — today only A survives.
7. **Acoustic recalibration (F1).** `assessPhysicalSpeechTranscription` (or
   its successor statistic) with the literal 00:12 numbers (ambient max
   14.3167, response max 50.1244, p95 21.18, p99 28.72, exact transcript
   match, 0 clipped) must pass; an all-silent response with a coincidentally
   matching transcript must still fail.
8. **Policy-reset attribution (F5).** Classifier input where the pcm
   disconnect delta equals the `captureStaleRestarts` delta and all probes are
   healthy must carry the distinct device-policy reason code beside the
   verdict.

---

## 8. Action checklist for the primary agent

1. Commit the uncommitted harness work (failure-branch `network.json`,
   `previousSession` progress, tolerant parser, CLI exit-after-flush) together
   with its tests — the retained failure predates it. Do not rely on it while
   it exists only in a worktree.
2. Close the two S1 holes: literal `indeterminate` verdict when
   `networkCapture` is missing (test 1), and the acoustic window-gate
   recalibration with the 00:12 red test (test 7) — that gate, not transport,
   blocked the last otherwise-clean rerun.
3. Raise `ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS` 250 → 640 (the ring
   bound) with conductor red test 4; keep `restart_after_no_progress_ms=500`
   and the teardown-on-restart mechanism exactly as is.
4. Add the uplink end-of-turn marker + DO commit fence + late-frame drop
   (test 5); afterwards the staleness budget is a latency knob, not a
   correctness bound.
5. On failure, also retain the replacement generation's provider frames
   (test 6), and record device-policy resets with their own reason code
   (test 8) so self-inflicted teardowns can't accumulate as “bad Wi-Fi”.
6. Wrap the proof CLI in a bounded rerun loop: rerun on `network-invalid`,
   halt on `audio-invalid`, stop on first pass. Keep the
   network-invalid-is-never-a-pass invariant pinned by test 2.
7. Follow-ups, in order: sent-frame journaling (F7), diagnostics cadence
   guard (F6), payload schema passthrough, `control.connected` honesty, and
   the cleanup close-wait matching `previousSession` (§4).

Nothing here requires new platform machinery; every item is a bounded change
to files this review cites, and items 1–2 alone should make the next
unattended rerun both attributable and passable.
