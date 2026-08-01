# M5StickS3 vertical-slice landing contract

Status: **deployed-userspace Stick vertical slice achieved** 2026-07-31. The
same shared `/pcm` and Cap'n Web implementation now works through an installed
production userspace worker, mounts the device capability, streams diagnostics,
invokes `changeColour("green")` from Grok through `env.ITX`, posts every raw
non-PCM provider event to an Iterate stream, and returns audible speech to the
physical M5StickS3. The earlier local-tunnel deterministic, eight-turn, and
interruption runs remain the stronger endurance evidence. Physical-button
provenance and the deferred deployed-worker kill/remount lifecycle are not
silently relabelled as complete.

## Morning-ready deployed conversation checkpoint (2026-08-01)

The complete checkpoint, including source, physical evidence, and concurrent
hardware-port work, is preserved on `origin/c-capabilities` at
`934710ddc74b448a1b0466d9bcfee9a1d1e56b62`. The earlier whole-worktree safety
checkpoint remains independently available as
`origin/backup/c-capabilities-stick-production-20260731` at
`3820bd408536d6cbdbffd56b1594b1b0099ce99b`; neither checkpoint is a merge or a
claim that the later StackChan and Home Assistant ports are finished.

The physical M5StickS3 is flashed, provisioned, mounted, and left idle on the
production test project ready for a human conversation. Press the top Button B
once to connect; hold the front Button A while speaking and release it to hear
Grok; press the top button again to hang up. This is intentionally PTT: the
Stick runs neither VAD nor AEC. The two sockets remain separate—ordinary Cap'n
Web at `os.iterate.com/api` and binary PCM at the userspace app's `/pcm` route.

The current installed userspace source is object
`a4cc2e559da8de1554c5c02f46efb35aa9a31e86`. Its session update selects
`grok-voice-think-fast-2.0`, disables turn detection, and now retains
`keep_context: true`, so repeated PTT turns share a real conversation. The
worker also posts the exact raw non-PCM provider frames to
`/devices/m5sticks3`; the retained run contains 113 ordered frames, including
transcriptions, response lifecycle, three tool calls and outputs, and pings,
with no provider `error` event.

The unattended three-turn acceptance interval is retained at
`apps/kit/evidence/m5sticks3-morning-ready/2026-08-01T01-49-06-986Z/iterate-kit-acoustic-8coYEz/`.
Its immutable source manifest SHA-256 is
`564da2c7b6f1809bef8f6753b38a710462d5542bcde68ff69e10d62fe8cfaf23`.
On one deployed `/pcm` session it sent 1,464 microphone frames and received 324
speaker frames. Worker downlink, device acceptance, DMA submission, and DMA
completion are all exactly 324. All three responses completed and all three
`changeColour` calls succeeded in order green/red/green through `env.ITX`.
Every drop, flush, underrun, failure, restart, reset, protocol error, WebSocket
disconnect, and Wi-Fi disconnect delta is zero. The source reservoir drained;
device playback queues drained; `keep_context` was observed in the raw event
stream rather than inferred from source.

The exact network interval is valid. Forty-four device samples stayed linked
at -53 to -48 dBm with zero Wi-Fi or PCM lifecycle faults. All 43/43 device,
43/43 router, and 43/43 worker probes replied; maximum RTTs were 22.236 ms,
7.406 ms, and 60.11 ms respectively. DNS took 1.637 ms and TLS connect took
47.276 ms. Thus the physical audio judgment is not being made during a bad or
indeterminate network interval.

The nearby Mac independently transcribed Grok's first physical reply exactly
as `Production turn one is green.` The response was coherent, unclipped, and
2.8763 times the ambient maximum. The immutable manifest predates the final
landing policy and therefore records a failure because it counted three 20 ms
windows above the relative threshold rather than four. The current policy
accepts exactly this one-window phase-boundary miss provisionally only when the
independent transcript matches, the response remains at least 2.5x ambient,
and clipping is zero. Two windows still fail. The exact one-window deficit and
the unchanged stricter four-window/fixed-120-RMS misses remain in the artifact;
transport, frame conservation, reset, and network gates were not relaxed.

The flashed application image is 1,152,464 bytes with SHA-256
`b576c4338e1dd7d75df4b1be2f7ffb88d72537f473e831c959427b15160fb6ee`.
At the end of the clean interval internal/DMA heap had 20,571 bytes free and a
19,456-byte largest block; task stack headrooms were 6,652 bytes (audio), 2,556
bytes (main), 4,584 bytes (control network), and 4,528 bytes (PCM network).
CPU was 195 permille. The allocator's boot-to-run historical minimum was only
279 bytes even though no allocation failed and steady state recovered. That
startup transient is a visible memory-headroom follow-up, not silently called
healthy or used to invalidate the otherwise exact conversation.

## Achieved deployed-userspace slice

The production project is `kit-stick-voice-e2e-20260731`
(`prj_bd8785e119fe4f1d8631bb95e1dea748`), hosted at
`kit--kit-stick-voice-e2e-20260731.iterate.app`. The retained installed worker
configuration is object `a4cc2e559da8de1554c5c02f46efb35aa9a31e86`. The
device authenticated with its project credential, mounted its ordinary Cap'n
Web target through `os.iterate.com/api`, and opened the separate binary `/pcm`
lane. The unattended proof invoked the same bounded conversation and PTT event
paths remotely; the firmware maps the top button to conversation start/stop and
the front button's held/released edges to that same PTT path. No VAD or AEC is
enabled on the Stick.

The best current-code physical run is retained at
`apps/kit/evidence/m5sticks3-production-grok/2026-07-31T22-51-25-938Z/iterate-kit-acoustic-SvSlh5/`.
It passed the acoustic and exact digital gates: 484 microphone frames reached
the worker, 164 response frames were accepted/submitted/completed by the
device, every drop/failure/flush/reset/disconnect delta was zero, and the
nearby Mac independently transcribed exactly `The deploy iterator stick voice
path is working.` once. Response-to-ambient maximum RMS was 9.205x with no
clipped samples. Grok called `changeColour` with `{ "colour": "green" }`; the
raw correlated tool output was `{ "colour": "green", "ok": true }`, and the
device capability changed the physical display.

That particular interval is deliberately retained as **network-invalid**
because two RSSI samples were -77/-76 dBm against the unrelaxed -75 dBm gate,
despite complete reachability and clean socket counters. It is not used to
waive network validity. The separate clean network-valid production run at
`2026-07-31T22-27-23-059Z/iterate-kit-acoustic-uSZH47/` conserved 488 uplink and
164 downlink frames with the same zero-fault ledger. Its original manifest
failed the deliberately over-strict fixed 120-RMS acoustic threshold: ambient
maximum was 7.648 and response maximum 37.139 (4.856x). The retained independent
xAI speech oracle in `acoustic-transcription-independent.json` recovered the
provider's exact sentence, word-timed from 1.566 to 4.597 seconds, while the
recording remained coherent and unclipped. Under the explicitly provisional
safe-gain policy this is the separate clean valid physical run; the 120-RMS
threshold remains recorded as a stricter follow-up rather than being rewritten.

An earlier clean-network run at
`2026-07-31T22-43-33-775Z/iterate-kit-acoustic-wKKvgb/` is retained as a useful
failure: the provider returned speech and a tool call in one response, and the
bridge unnecessarily requested a continuation, making the Stick speak the
sentence twice. The literal raw event sequence produced a regression test. The
bridge now records whether the tool-bearing response already emitted PCM and
only creates a continuation for a tool-only response. This avoids hiding
provider variability behind prompt-specific assumptions.

### Raw Grok event stream

The 2026-08-01 unattended production check makes this lane directly usable as
a forensic artifact rather than leaving raw frames nested inside a large proof
manifest. Its exact 45-frame JSONL is retained at
`apps/kit/evidence/m5sticks3-production-grok-raw-stream-check/2026-08-01T00-12-03-066Z/provider-events.jsonl`.
The records are stream offsets 621–665 and provider sequences 1–45 for one PCM
session. They include the progressively refined microphone transcription, the
final input transcript, the `changeColour({ colour: "green" })` arguments and
correlated `{ colour: "green", ok: true }` output, both response lifecycles,
the completed output transcript, and pings. There is no provider `error` frame
and no provider text about a WebSocket failure. The independently captured Mac
microphone transcript exactly matches Grok's completed output transcript:
`The deploy iterate stick voice path is working.`

That run's network interval is valid and its digital ledger is exact: 482
microphone frames reached the deployed worker, 168 return frames were accepted,
submitted, and completed by the Stick, and every drop, reset, disconnect,
transport-error, and protocol-failure delta is zero. The overall manifest
remains honestly `audio-invalid` because the conservative energy oracle found
only one 20 ms window above 2.5 times the _maximum_ one-second ambient RMS,
instead of four, despite the exact independent speech transcript and a 3.50x
response/ambient maximum ratio. This is retained as an acoustic-oracle false
negative candidate, not rewritten as a clean automated pass and not used to
weaken any transport gate.

The immediately preceding failed check is also retained under
`2026-07-31T23-58-19-288Z/`. Its ten exact provider frames contain no provider
error. The phrase `WebSocket disconnected without sending Close frame.` came
from the userspace bridge's device-side close diagnostic after the firmware
discarded 13 stale microphone frames and replaced the `/pcm` generation; it
was not something Grok said. A regression now recovers the failed generation's
counters from the worker's bounded `previousSession` report, writes
`network.json` even on early proof failure, and exits the finite proof CLI after
flushing its result rather than waiting indefinitely on a closing RPC socket.

The worker cross-posts the exact raw JSON of every non-PCM Grok frame to the
normal Iterate stream `/devices/m5sticks3` as
`events.iterate.com/kit/provider-event`. Each record has a session id, monotonic
sequence, receive timestamp, provider type, and untouched raw payload. The
production proof read the stream back and verified continuity and order for 45
frames, including incremental and final input transcription, response
lifecycle, output transcript, `ping`, function-call arguments, and correlated
function output. No provider error event occurred in the retained run. This is
the diagnostic lane for questions such as whether a spoken complaint referred
to a provider WebSocket event; PCM never enters it.

Posting is bounded and nonblocking: at most 64 events, 256 KiB total, 64 KiB
per event, and eight events per batch. Overflow/post failure is counted and
visible rather than retried into an audio backlog. Provider-event journal
metrics, device metrics subscriptions, PCM accounting, and capability-call
results are all visible from the userspace worker and asserted by the same
production proof.

The ESP-IDF v5.4 transport also emitted `esp_tls_conn_read error` for normal
zero-timeout `WANT_READ/WANT_WRITE` probes even while every frame and socket
counter was exact. A source-transform regression now classifies those retryable
states before logging/capturing an error, while preserving the original log and
TLS error handle for genuine negative results. This repairs contradictory
diagnostics; it does not excuse a transport fault. The patched image rebuilt at
`0x119350` bytes (45% of the 2 MiB app partition free), passed the realtime ELF
audit, and was app-flashed to stable MAC `70:04:1d:d5:45:88` without replacing
its provisioned settings. An unattended production capability sequence then
started a conversation, held/released PTT, and hung up through the deployed
worker. Serial retained the expected `connecting` → `ready` → `stopped` PCM
lifecycle with no TLS error line.

## Historical first landing course: prolonged local-tunnel conversation

Before the deployed slice above, the deliberately narrowed landing path was the existing local userspace
`/api` + `/pcm` implementation exposed through Captun at
`tunnels.iterate.com`. The Stick uses its provisioned project credentials,
mounts its ordinary Cap'n Web target through that public origin, streams its
physical microphone through `/pcm`, and receives real
`grok-voice-think-fast-2.0` audio through the same userspace process. Remote
Cap'n Web push-to-talk events and macOS `say` make the proof unattended while
the operator is away; no physical button prompt is permitted in this phase.

The retained acceptance run is not one smoke turn. The harness passed a short
multi-turn conversation and then extended to eight turns, retaining for every
turn:

- the injected prompt, provider lifecycle and transcription events, and exact
  turn timestamps;
- raw microphone-uplink, speaker-downlink, and nearby-Mac acoustic captures;
- exact device receive/submit/completion frame conservation, zero loss/reset/
  failure deltas, queue drain, and heap/CPU observations;
- stop-to-provider, stop-to-first-downlink, and stop-to-audible-completion
  timing; and
- one automatic network verdict spanning the exact conversational interval,
  with device RSSI/link and control/PCM socket counters, device/router/tunnel
  reachability, and tunnel DNS/TLS-connect evidence.

A run with bad network evidence is retained as `network-invalid`, never used to
judge the audio path, and never promoted to a pass. A run with incomplete
network evidence is `indeterminate`. Only a separately clean `valid` interval
can land the conversational gate. The deterministic local return remains a
diagnostic oracle and does not substitute for the prolonged real-Grok run.

For that earlier landing phase, deployed dynamic-worker installation, generation
replacement, `.kill()`/remount behaviour, and preview/production lifecycle
proof are explicitly deferred. The already-observed deployed callback/
generation defect remains recorded evidence, not a reason to keep blocking the
physical conversation on Cloudflare lifecycle debugging.

After the Stick conversation is solid, hardware work remains ordered:
StackChan full-duplex/interruption/measured AEC, then Home Assistant Voice
Preview Edition through the shared core. Face/avatar work stays deferred until
those audio and capability slices work.

This narrows the immediate proof order without shrinking the persistent
physical-device voice goal. StackChan, Waveshare, Home Assistant Voice Preview
Edition, AEC, and ten-minute endurance remain required by the parent goal, but
they do not block landing one production-shaped M5StickS3 path.

## Retained prolonged real-Grok conversation

The acceptance artifact is
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T18-05-38-138Z/`.
Its local README records the complete evidence map and exact values. In one
provider session, eight remote Cap'n Web PTT turns sent 2,142 microphone frames
and returned 1,008 speaker frames. Every turn independently conserved accepted,
submitted, and completed PCM with no drop, flush, failure, restart, reset, or
protocol delta. Queue high waters remained 3/4/6 frames, heap returned slightly
above baseline, and stop-to-first-speaker latency stayed between 720.6 and
925.8 ms rather than increasing by turn.

The provider maintained cross-turn context (`lantern`, then `engineer`) and all
eight physical speaker replies were independently recovered from bounded
nearby-Mac microphone slices. The 77.226-second interval was automatically
`valid`: all 78 device/router/Captun reachability probes replied, all 79 Wi-Fi
samples were link-up at -56 to -53 dBm, and the PCM socket had no reconnect,
disconnect, or transport error.

## Retained real-Grok interruption and recovery

The acceptance artifact is
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T18-33-07-329Z/`.
After a fresh app flash, the mounted remote PTT capability interrupted a live
counting response and immediately opened a second microphone epoch. Grok
reported the first response `cancelled`, transcribed the replacement request,
and completed `Interruption successful.` The nearby physical microphone
independently recovered `One.` before the cut and `Interruption successful.`
after it.

The exact device ledger was 115 accepted speaker frames = 103 completed + 12
generation-flushed, with zero transport drops/failures/restarts and drained
queues. Device RPC interruption took 110.050 ms; fresh speaker PCM arrived
992.026 ms after the second release. The complete 18.462-second interval was
network-valid with 19/19 replies from each reachability target, -54 to -53 dBm
Wi-Fi, and zero socket lifecycle faults.

An earlier valid attempt at `2026-07-31T18-25-45-863Z/` exposed a harness-only
negative latency caused by assigning stale generation PCM to turn 2. A red
regression test led to a provider `response.created` causal fence, and the
retained rerun above proves the corrected positive measurement. The older raw
artifact remains retained rather than silently discarded.

## Achieved unattended local-userspace slice

The retained run at
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T12-18-12-256Z/`
is the landing evidence for the autonomous Stick slice. No person pressed the
device: the test controller invoked the mounted Cap'n Web `pushToTalk`
capability, kept the physical microphone streaming while macOS spoke the test
prompt, released the semantic PTT event, forwarded that live PCM through the
real local userspace `/pcm` implementation to `grok-voice-think-fast-2.0`, and
played the response on the physical Stick.

The result conserved 428 microphone frames / 273,920 bytes and 244 speaker
frames / 156,160 bytes. The Stick accepted, submitted, and completed exactly
244 / 244 / 244 returned frames. Every drop, flush, underrun, reset, failure,
and protocol-failure counter remained zero; all queues returned to zero. The
room-microphone recording was independently transcribed as:

> The unattended stick voice test passed with clear continuous playback.

The exact 14.987-second interval was automatically classified network-valid.
All 16 device diagnostics and all 15 device/router/worker reachability samples
arrived, RSSI stayed from -39 to -32 dBm, and the PCM socket recorded zero
reconnects, disconnects, or transport errors while conserving the same byte
counts.

The run also proves the source/device buffer distinction introduced after an
observed 203.28 ms Grok packet gap. Userspace waits for a bounded 32-frame
source reservoir but sends only the existing eight-frame startup lead to the
Stick, then one frame per media deadline. Host tests prove the split, including
short-response completion, and the full Kit suite passes 426 tests with one
explicit live test skipped.

The current target build is 1,150,208 bytes with 45% of the 2 MiB application
partition free. The physical run observed a 105,539-byte internal-heap floor,
2,376 bytes of main-task stack headroom, and roughly 330 permille peak CPU while
the microphone streamed. DIRAM is 70.06% used. The ESP-IDF size report leaves
only one byte in its 16 KiB IRAM segment; the realtime ELF audit passes, but
that footprint remains a visible portability risk rather than being normalized.

This lands the requested autonomous local bridge path, not every criterion in
the broader contract below. In particular, it does not silently substitute for
the production Cloudflare userspace route or the final physical Button A
provenance check. Those remain separate, honest gates; neither requires
repeating this already-sufficient local audio proof.

## Credible achieved slice

A retained run may be called the Stick vertical slice only when one freshly
flashed image has proved, in order:

1. the normal TypeScript flashing/provisioning path wrote the firmware and
   settings partition for the stable M5StickS3 identity;
2. the device reached a real Iterate userspace app/worker, authenticated, and
   mounted its Cap'n Web capability at its configured `/kit/...` path;
3. a physical held-button push-to-talk interval continuously emitted 640-byte,
   20 ms microphone frames to that app's `/pcm` path before button release;
4. the same userspace path forwarded a live turn to
   `grok-voice-think-fast-2.0`, retained provider lifecycle/transcription
   evidence, and relayed returned PCM to the device;
5. the Stick played the returned audio audibly, with device counters and a
   nearby-Mac recording proving what reached the speaker path; and
6. a deterministic mode in the same userspace `/pcm` implementation can return
   known tone or PRBS PCM, so provider variability is not allowed to erase the
   transport/audio oracle.

The deterministic return is not a substitute for the live Grok spoken smoke
test. The live smoke test is not a substitute for deterministic byte and
acoustic evidence.

## Historical blockers and shortest path (resolved for this slice)

This section records the evidence that selected the eventual landing path. The
brownout and safe-gain blocker described here is resolved in the retained
deterministic and conversational runs above; it is no longer the current Stick
blocker.

- the ROM printed `Brownout detector was triggered`;
- reset reason was `RTC_SW_SYS_RST`;
- saved PC `0x403758a2` resolves to `rtc_brownout_isr_handler` in ESP-IDF
  5.4.2;
- the reset occurred after only 43 returned tone frames while Wi-Fi/control
  calls were still progressing.

Therefore the fastest honest route is:

1. bound Stick speaker output to the board/library's normal safe gain rather
   than continuing to tune WebSocket recovery around power resets;
2. prove a short and then one-minute deterministic return through the existing
   userspace `/pcm` path with no brownout;
3. add an automatic network-validity verdict to the physical evidence;
4. freshly flash and run physical PTT through the real userspace Grok mode;
5. retain an explicit achieved/deferred ledger.

Disabling the ESP brownout detector is forbidden. Increasing audio queues is
not a power fix.

## Achieved deterministic sub-gate

The exact image built at `0x118820` bytes was freshly flashed through
`pnpm device:e2e` to MAC `70:04:1d:d5:45:88`. Its ES8311 output ceiling is
fixed at -18 dB rather than disabling brownout protection.

The direct-LAN userspace path mounted `/api` and `/pcm`, returned 3,000
deterministic 20 ms frames over 60 seconds, and the device accepted, submitted,
and completed all 3,000. All drop, underrun, recovery, reset, playback-failure,
and protocol-failure counters remained zero. Application downlink high water
was six frames and speaker high water was four.

The nearby Mac's independent 48 kHz microphone recording passed the strict
continuity oracle:

- observed tone span: 59,955 ms for 60,000 ms requested;
- missing tone: 45 ms, within the 200 ms duration allowance;
- internal gaps and phase discontinuities: zero;
- maximum phase-step error: 0.097757 rad against a 0.1 rad bound; and
- maximum amplitude step: 0.981 dB against a 1.5 dB bound.

The exact interval was automatically classified `valid`, not inferred from the
audio result. It retained 63 successful Cap'n Web diagnostic snapshots and 62
successful samples each for the Stick, router, and local worker. RSSI stayed
between -43 and -40 dBm; maximum RTTs were 24.433 ms, 19.578 ms, and 0.267 ms
respectively. PCM transferred 1,920,000 bytes with zero reconnects,
disconnects, or transport errors and was still open at the measurement
boundary.

This proves the fresh-flash, deterministic-return, audio-continuity, and
network-attribution sub-gate. It does **not** yet prove the real deployed
userspace worker or physical-button/manual-turn propagation to that worker.

## Achieved direct-LAN real-Grok sub-gate

The same local userspace fetch handler then ran the real
`grok-voice-think-fast-2.0` path over the Stick's direct LAN connection. A
remote Cap'n Web PTT operation kept the microphone lane open while the nearby
Mac spoke `Please reply with exactly: Local device voice is working.` Grok's
input transcription and output transcript both matched exactly. The human
observer then independently confirmed that the returned sentence was audible
from the Stick: `it worked!`

The digital result conserved the complete observed run:

- microphone uplink: 242 frames / 154,880 bytes;
- speaker downlink accepted, submitted, and completed: 116 / 116 / 116 frames,
  or 74,240 bytes;
- application downlink high water: six frames; speaker high water: four;
- zero uplink/downlink drops, underruns, flushes, failures, protocol failures,
  reconnects, or resets;
- maximum microphone transport-accept age: 27 ms; and
- local bridge maximum payload in flight: 4,480 bytes / seven frames, with a
  0.611 ms maximum send-callback latency and 24.117 ms maximum downlink
  interarrival.

The provider delivered 50,888 response bytes in only 235 ms, including one
20,552-byte WebSocket message. That exposed and fixed a userspace boundary
error: provider message size had incorrectly been treated as device jitter
capacity. The proxy now retains a bounded userspace response reservoir, primes
only the configured device lead, and replenishes it at 20 ms media deadlines.
The literal observed packetization is a regression test.

This is a genuine device/Grok/speaker round trip, but it is still a sub-gate:
the PTT edge was invoked remotely, this particular voice interval did not yet
write the automatic network-validity artifact, and it bypassed Captun. The next
retained run uses physical Button A, the public tunnel, per-direction raw PCM
recordings, and the same userspace handler.

## Exact autonomous regression proof

A later multi-turn run exposed two separate userspace/harness defects rather
than a vague acoustic problem:

- one legal Grok WebSocket message was 73,400 bytes, exceeding an arbitrary
  64 KiB per-message guard; and
- after that guard was corrected, a complete observed response totalled
  148,222 bytes, exceeding the old four-second userspace response reservoir
  because xAI generated 4.63 seconds of audio in under one second.

The userspace reservoir is now an explicit bounded eight-second/256,000-byte
budget. This does not increase the ESP queue: the Stick still receives only
its finite realtime lead, interruption destroys the retained generation, and
overflow remains terminal and observable. A literal seven-message production
trace proves byte conservation under worst-case callback batching.

The same investigation found that the harness had accepted a failed response
with 46 frames received, 12 played, and 34 flushed. Queue depth zero only
proved that work disappeared; it did not prove audibility. The replacement
gate counts frames accepted at the userspace-to-device WebSocket boundary and
requires that exact delta in device receive, submit, and completion counters,
with no drop, flush, reset, or failure counter changing.

The first autonomous run through that strict gate passed:

- mounted capability: `kit.m5sticks3`;
- remote PTT drove a continuous 278-frame microphone interval;
- Grok input transcript matched the complete injected sentence;
- Grok replied `The autonomous device test is working.`;
- userspace observed 128 speaker frames and the Stick accepted, submitted, and
  completed exactly 128 / 128 / 128;
- downlink and playback queues returned to zero with zero drops, flushes,
  failures, or protocol failures; and
- the local PCM bridge closed normally after the verdict.

This repeatable mode no longer requires a person to press Button A: the same
mounted capability supplies remote start/stop while `say` provides a nearby
acoustic input. Physical Button A remains a distinct final provenance gate.
The run did not start the full reachability monitor, so its network verdict is
retained as `indeterminate`, not promoted from clean bridge counters. Its
machine-readable evidence is under
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T11-53-00Z-autonomous-grok-exact/`.

## Corrected WebSocket PING/PONG model

The PCM firmware currently being replaced used client-originated WebSocket
PINGs as delivery barriers: four accepted microphone frames queued a PING,
eight supposedly "unconfirmed" frames stopped admission, and a matching PONG
released the window. That inference is invalid through Captun. RFC control
frames terminate at the immediate WebSocket peer; Captun forwards application
messages to the local fetch handler through its own Cap'n Web tunnel, but does
not expose the gateway's PONG as proof that local userspace—or Grok—consumed
the preceding PCM.

The correction is deliberately narrower than deleting WebSocket compliance:
the device must still reply to an incoming PING with a PONG. What is removed is
the PING-based PCM credit/admission policy and all telemetry claiming
end-to-end peer delivery. Current-audio safety remains owned by the bounded
application ring, maximum frame age, bounded send/no-progress deadlines, and
visible reconnect/drop diagnostics. If end-to-userspace delivery credit later
proves necessary, it must be an explicit application-level PCM ACK forwarded
through Captun—not an RFC PONG.

## Automatic network-validity verdict

Every physical audio evidence bundle must correlate the exact requested audio
interval against:

- device Wi-Fi RSSI/link state and reconnect/disconnect events;
- device and router reachability, RTT, and loss over the same wall-clock
  interval;
- DNS/connect timings and control/PCM socket progress/reconnect diagnostics;
- device reset/brownout evidence; and
- host bridge delivery and queue/freshness counters.

The machine-readable result has one of three values:

- `valid`: required network evidence is present and remains inside explicit
  bounds for the audio interval;
- `network-invalid`: correlated evidence proves a link/path outage, excessive
  RTT/loss, failed DNS/connect, or reconnect during the interval;
- `indeterminate`: required evidence is missing or cannot be aligned.

An audio failure in a `network-invalid` run is not attributed to the playback
pipeline. Such a run also cannot prove audio good. A separate `valid` run is
required for a positive audio verdict. Brownout/reset is a device-invalid
hardware/power failure, not a network-invalid escape hatch.

## Explicit deferrals for this landing

The following do not block the Stick slice and must be reported as deferred,
not silently dropped:

- StackChan flash/camera/LED/servo/full-duplex/AEC completion;
- Waveshare and Home Assistant device firmware;
- public `k.iterate.com` UX completeness beyond the already shared flashing
  core;
- ten-minute and loaded multi-device endurance;
- final production OAuth/device-token hardening;
- a final simplified create-once/direct-RX audio architecture if the current
  bounded path passes this vertical proof.

## Required hardware order after the Stick lands

The deferrals above are a sequencing decision, not a reduction of the parent
goal. Once the freshly flashed Stick has passed deterministic `/pcm` return
and the live Grok spoken slice, continue in this order:

1. Inspect `/Users/jonastemplestein/src/github.com/iterate/stackchan` before
   changing StackChan firmware. Reuse or adapt its measured codec, microphone,
   speaker, DSP, and AEC findings through the shared core. Do not inherit its
   known accumulating-delay/queueing behaviour.
2. Prove StackChan on the same capability and userspace `/pcm` architecture
   with the smallest honest board adapter. Acceptance requires measured
   full-duplex audio, interruption, and AEC effectiveness on the physical
   device; compilation or one-way sound is insufficient.
3. Bring up Home Assistant Voice Preview Edition through that shared
   architecture as the next hardware-portability proof.
4. Do not implement face/avatar rendering until all of those audio and
   capability slices work, including Home Assistant Voice Preview Edition.

The Waveshare target remains in the parent portability scope but does not
interpose itself ahead of this explicit Stick → StackChan → Home Assistant
audio order.

## Evidence locations

- Parent goal:
  [`physical-device-voice-goal.md`](./physical-device-voice-goal.md)
- Realtime problem/evidence map:
  [`audio-streaming-problem-and-evidence-2026-07-30.md`](./audio-streaming-problem-and-evidence-2026-07-30.md)
- Brownout diagnostic run:
  `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-60s-taskless-control-serial-diagnostic-20260731-0508/`
- Passing fresh-flash deterministic run:
  `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-60s-fresh-network-classified-20260731-0549/iterate-kit-acoustic-CO8nEq/`
  - PCM recording SHA-256:
    `cddf79f63ce949d8e97b264397079107161b962fe6d70fdd0c354fdf47b30279`
  - network artifact SHA-256:
    `145b103cee9f1ed5208fbd234c7b40f55b83aa5dc31c1e6c92c162fd930fa461`
- Passing unattended real-Grok conversation, exact PCM, independent acoustic
  transcription, automatic network verdict, and current build footprint:
  `apps/kit/evidence/m5sticks3-conversation/2026-07-31T12-18-12-256Z/`
- Complete remote recovery checkpoint:
  `origin/backup/c-capabilities-full-checkpoint-20260730T2345Z` at
  `a0c54771d7b92991387eef7644234c57e0529440`
- Complete deployed-slice recovery checkpoint:
  `origin/backup/c-capabilities-stick-production-20260731`; verified content
  commit `3820bd408536d6cbdbffd56b1594b1b0099ce99b`. This is a backup
  checkpoint, not a completion claim; it includes the fresh raw-provider-event
  proof artifacts and the first build-proven shared CoreS3/StackChan audio
  owner.
