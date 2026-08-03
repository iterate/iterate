# Voice-device build log — 2026-08-02

Newest entries are prepended. This is an evidence ledger, not a declaration
that the three-device goal is complete.

## 10:28 — Production mounts answer; the complete host suite is green under contention

All three physical devices answered through the real production
`os.iterate.com/api` capability surface after the network move. M5StickS3 and
HAVPE each reported one healthy control connection, no control/Wi-Fi/protocol
errors, and no PCM incident. StackChan likewise remained mounted and reported
no control or PCM error, but retained one historical Wi-Fi disconnect with
ESP-IDF reason 201 (`NO_AP_FOUND`). That bounded event is not erased or called
healthy merely because the current link recovered. A second production
snapshot at device uptime 1,291,098 ms showed the count still exactly one,
with the same control generation and no disconnect/error increment since the
first snapshot at 893,229 ms. Current RSSI was
-72 dBm for Stick, -76 dBm for StackChan, and -75 dBm for HAVPE. These are
reachability/control-plane observations, not an acoustic acceptance run.

Kit's complete TypeScript suite now passes with 710 tests and the one
deliberately live-only test skipped. The first complete run found a real host
harness defect: under heavy parallel load, macOS could starve the fake
CoreAudio recorder's short-lived version process past its fixed two-second
deadline. A deterministic delayed-child regression reproduced the problem.
The bounded capability probe now has a ten-second deadline, distinct from the
later five-second recording-readiness gate; sixteen simultaneous reproductions
and the complete suite pass. This changes only host-tool startup tolerance. It
does not relax any audio frame, transport, reset, buffer, or network-validity
criterion.

The next no-acoustics step is deliberately diagnostic rather than another
blind AEC tuning change. The existing CoreS3 BSP hook observes the exact
128-sample PCM buffer only after TX DMA completion. StackChan's earlier source
proves that this can be paired with RX DMA without delaying audible playout.
The portable finite trace now has a bounded, sequence-checked fifth plane for
that exact speaker signal alongside near, electrical reference, linear AEC,
and clean output. Its test first failed on the absent fifth channel and now
pins plane order, independent storage, continuity, and the no-work idle path.
All 79 native tests pass, including realtime ELF-placement audits. The rebuilt
StackChan image is 1,264,880 bytes (76% of the app partition free), SHA-256
`d28e73f2c8932a8a31949031598d5e02520a1a4c550f0eed98deeee9d7f009d8`.
The host resource profile still reports no allocator dependency, a 1,368-byte
StackChan profile, and a 5,576-byte profile-plus-protocol working set. The
next hardware change is to feed the fifth plane from a bounded TX/RX
completion aligner; until a quiet, network-valid capture establishes that lag
and gain relationship, the live canceller continues consuming its current
electrical reference.

## 10:15 — New guest network is usable for deterministic work, not yet an acoustic AEC oracle

All three active voice targets were reprovisioned onto the current guest Wi-Fi
without changing their device identity, production project, worker origin, or
mounted capability. The password is deliberately absent from this repository.
Non-disruptive USB enumeration on 2026-08-03 again resolved M5StickS3,
StackChan, and Home Assistant Voice Preview Edition by their stable ROM MACs;
their current addresses are `192.168.1.51`, `192.168.1.46`, and
`192.168.1.43`, respectively. A fresh five-packet sample lost no packets. Its
mean/max device RTTs were 33.795/56.571 ms, 43.597/98.589 ms, and
13.530/27.763 ms; the router was 13.014/45.301 ms. This proves present
reachability, not that a later audio interval is network-valid. Every physical
run must still retain and classify its own aligned router/device/worker
evidence.

An earlier instrumented HAVPE interval on this same guest network was correctly
classified `network-invalid`: aligned device/router/worker RTT crossed the
run's limits while the device recorded eight no-progress freshness restarts,
discarding old microphone work so recovery resumed at real time. The sampled
userspace and once-per-second device counters did not share exact boundaries;
their apparent 599-versus-546-frame difference is therefore a conservative
callback bracket, not evidence of frame creation or loss. The harness work
below makes that boundary semantics explicit rather than presenting sampled
metric deltas as exact media accounting.

The control owner now treats rejection of an expired remote metrics callback
as a normal terminal subscription outcome, increments the exported
`subscriptionEnds` counter, and continues polling later capability modules in
the same turn. Actual driver errors still fail fast. Focused C and TypeScript
regressions, the complete 79-test native suite, Kit typecheck, and all three
ESP-IDF target builds pass. The complete images are 1,167,040 bytes for
M5StickS3 (930,112 bytes / 44% of its app partition free), 1,264,880 bytes for
StackChan (76% free), and 1,079,872 bytes for HAVPE (79% free). The full Stick
build also exposed an unsafe positional C++ options initializer whose pointer
arguments had drifted into newer boolean fields; it is now a named initializer
so later option growth cannot silently reinterpret values.

The three bounded Fable reviews have finished and were reconciled rather than
blindly applied. The hardware review confirms that HAVPE already consumes the
XMOS-processed AEC channel and should not acquire a second ESP-side canceller.
For StackChan, the highest-value next diagnostic is the existing bit-exact
speaker DMA-completion tap paired with the near, electrical-reference, linear,
and final AEC planes; that distinguishes reference amplitude, alignment, and
engine behaviour without changing the engine first. Final echo suppression,
double-talk, and near-end reconstruction remain deliberately unaccepted in the
current noisy room. Transport, bounded-buffer, reconnect, capability, metric,
build-size, and deterministic waveform work remain valid here.

## 07:12 — Four-stage StackChan evidence localises broadband failure; latest run is network-invalid

StackChan now reports aligned near, electrical-reference, linear-AEC, and
post-NLP peak/mean windows through the existing low-rate metrics capability.
The implementation walks samples outside the platform critical section and
merges only nine fixed accumulator scalars; the extra linear-output scratch is
one fixed 1,024-byte realtime buffer, with no allocation, queue, or new task.
The public AEC metrics schema is now version 3. Red tests first rejected both a
missing fourth signal and the old version-2 TypeScript shape. The two targeted
native tests, 57 relevant Vitest cases, and Kit typecheck then passed. The
flashed StackChan app is 1,262,800 bytes (`0x1344d0`), 1,568 bytes larger than
the preceding image, with SHA-256
`7c343092ab976e28e131354f42223e27c02377334fe309eb1b5a21b17c21e7d0`.
It was selected immediately before flashing by stable USB ROM MAC
`68:EE:8F:D8:53:20`, not by the current `/dev/cu.*` suffix, and flash hashes
verified while preserving its provisioning partition.

The production waveform artifact at
`evidence/stackchan-production-aec-waveform/2026-08-03T06-02-28-367Z`
is deliberately retained as a failed, **network-invalid** run. Ambient, tone,
PRBS, speech-shaped, and near-only phases each completed with exact device/worker
frame accounting and no new capture-reserve drop, bridge error, AEC recreate,
or transport close. During near-repeat, however, only 31,040 of the required
64,000 samples arrived. In the same exact interval production-worker RTT rose
through 183–357 ms, four consecutive reachability probes failed, and all three
reachability series acquired a 5,168.879 ms coverage gap. The automatic
network classifier rejected the run; it cannot be used as either an AEC pass
or an audio-pipeline failure.

The completed phases are nevertheless a decisive calibration observation.
During the far tone, mean magnitudes were approximately near 4,957, reference
1,014, linear 197, and final 183: the linear canceller did almost all of the
suppression and NLP added less than 1 dB. During broadband PRBS they were near
3,513, reference 872, linear 3,268, and final 3,174: linear cancellation was
only about 0.6 dB, again with little NLP effect. Speech-shaped output was near
7,109, reference 711, linear 1,267, and final 1,174, but the raw near channel
also clipped at 32,768. Raising reference PGA had already failed to improve
these outcomes. The active defect is therefore not primarily an NLP threshold:
the reference/alignment/adaptation path cancels a stationary tone but fails on
broadband content, while excessive microphone gain independently destroys some
speech samples before AEC.

The next discriminating change is a bounded capability-delivered synchronized
raw/reference/linear/final capture so the harness can measure lag, polarity,
bandwise ERLE, clipping, and drift instead of guessing from one-second
aggregates. This must use PSRAM and a nonblocking realtime tap; USB serial is
explicitly excluded because opening it reboots the board and destroys incident
state. Two new independent Fable max-effort reviews are running in parallel:
one audits both boards' codec/I2S paths and first-party Espressif guidance, and
one compares materially different AEC architectures plus a shared physical
oracle. Their prompts are retained in
`fable-aec-hardware-first-party-prompt-2026-08-03.md` and
`fable-aec-architecture-oracle-prompt-2026-08-03.md`; an earlier reference
calibration review is also still running. Recommendations will be reconciled
against measured evidence rather than applied blindly.

## 05:53 — Off-device StackChan calibration gate is fully green

The complete Kit suite now passes: 88 test files and 690 runnable tests, with
the one explicitly live-only tunnel test skipped; `pnpm typecheck` and
`git diff --check -- apps/kit` also pass. All 77 native C/C++ tests pass. The
host resource profile still reports no allocator dependency, a 1,368-byte
StackChan profile, and a 5,576-byte profile-plus-protocol working set; realtime
audio storage is accounted separately rather than hidden in that number. The
sole stale fixture found by the first full run instantiated StackChan's
userspace PCM bridge at the generic ×1 uplink default even though production
now installs the measured ×8 server-VAD policy. The fixture now obtains the
actual device policy and the readiness contract explicitly rejects ×1,
preventing a future proof harness from waiting forever on a userspace
generation that does not match the deployed calibration.

This is an off-device checkpoint only. It does not supersede the failed
physical `VERYAGGR` double-talk evidence. The next discriminating action
remains flashing the already-built `AEC_NLP_LEVEL_AGGR` image after positively
identifying StackChan in its ROM loader, followed immediately by the strict
waveform proof and then the real provider-edge/interruption proof.
A single identity-resolved, non-resetting probe after the spoken request at
05:55 received no ROM serial byte and wrote nothing, so the board had not
entered the loader; blind retries remain prohibited.

## 04:27 — StackChan ×8 hears normal speech; installed VERYAGGR still destroys barge-in

The StackChan production userspace project now runs config-repo commit
`5da0028a61f921767b1be0b2d81dee12442d3e3b`. Its common zero-retention PCM
bridge applies the smallest replay-proven StackChan uplink multiplier, ×8,
while retaining native and gained peak/RMS plus clipping counters. The change
was pinned by a red-then-green device-policy test; the complete 58-test
provider/bridge calibration set and Kit typecheck pass. No firmware, room
volume, or provider threshold changed for this comparison.

The bounded production run at
`evidence/stackchan-production-grok-aec-x8-20260803/2026-08-03T03-25-06-009Z`
closed both sides of the earlier level diagnosis. Grok opened exactly one VAD
turn for the first moderate Mac prompt, transcribed the complete requested
phrase, and returned “Production audio signal amber is clear and audible.”
StackChan accepted 380 downlink frames and the independent Mac microphone
heard a coherent “Signal amber is clear and audible”; its exact acoustic gate
initially failed because the STT adapter returned only the last of two finalised
segments. The retained raw STT events contain “Production audio.” followed by
“Signal amber is clear and audible,” so the physical recording itself was
complete. A red regression reproduces xAI's non-empty trailing
`transcript.done`; the adapter now merges timed replacement windows and all
four acoustic-STT tests plus typecheck pass. Future manifests also retain the
raw artifact's exact byte/sample intervals and verified microphone provenance,
so this class of oracle fix can be rerun against identical physical audio. A
pre-existing provenance check was moved ahead of microphone acquisition after
its test proved the old ordering could spend the complete startup timeout
before rejecting an unauthorised caller label; all nine macOS capture tests
pass. The second request also opened one turn and produced a long-response
downlink. There were no unsolicited turns, provider disconnects, provider send
failures, or network-invalidating reasons.

The deliberate near-end interruption during that active speaker response did
not produce the required third VAD edge. The run therefore timed out with two
starts/stops/responses instead of three. On-device AEC processed 3,576 frames
without a recreate, reserve drop, bridge error, or playback overflow and
measured 19.35 dB far-only suppression, but observed no aligned near-end window
during the double-talk phase. Thirteen of roughly 1.8 million gained samples
clipped, which remains a strict failure rather than being rounded away. This is
the expected physical signature of the currently installed
`AEC_NLP_LEVEL_VERYAGGR`: ordinary speech is now audible to the provider, while
speech coincident with its much stronger speaker is still removed. Repeating
that firmware cannot discriminate anything further. The already-built
`AEC_NLP_LEVEL_AGGR` image must now be installed and run through the strict
waveform and provider-edge gates before ×8 is considered a settled policy.

## 04:06 — Retained StackChan PCM isolates the VAD envelope and rejects blind gain

A bounded off-device replay at
`evidence/stackchan-vad-replay-20260803/README.md` sent the exact accepted
post-AEC PCM from the failed physical StackChan waveform run through the real
`grok-voice-think-fast-2.0` server-VAD socket. Nearby speech at x4 (+12 dB)
produced no VAD edge; x8 (+18 dB) and x16 (+24 dB) each produced one turn and
the same correct transcript of all intelligible words in the retained
4.06-second source. This confirms that the earlier production count run was
below xAI's VAD envelope rather than lost by its measured network/transport
path.

The result is deliberately not being converted directly into a production
gain. A second replay used a retained **real speaker-speech** `aec-clean.wav`
from the prior StackChan tree, whose original physical assessment passed with
18.64 dB ERLE. At only x4, xAI opened three false turns and transcribed speaker
residue as “Yeah”, “Stop”, and “Hi”. That is stronger evidence than the current
speech-shaped-noise control: the production contract is no false provider
speech edges, not merely a respectable scalar ERLE. The next useful experiment
is still one strict network-valid physical waveform run with the already-built
`AEC_NLP_LEVEL_AGGR` image, followed by an intelligible speaker-only provider
edge check at the smallest candidate gain. The remaining dependency is one
physical three-second bottom-RST hold to place CoreS3 in its ROM downloader; a
fresh non-resetting probe at 04:05 wrote nothing and confirmed it is still
running the app.

## 03:56 — StackChan count prompt reached the room and transport, but not Grok VAD

The first exact 1..100 production run against the currently installed
`VERYAGGR` StackChan firmware is retained at
`evidence/stackchan-count-to-100-pre-nlp/2026-08-03T02-48-07-296Z`. It is a
useful failed calibration, not a conversational pass. The independent Mac
microphone capture transcribes the complete fixture prompt exactly from 5.588
through 13.899 seconds: “Count from one through one hundred in order including
both endpoints saying every number exactly once with no preamble and no
omissions.” The nearby speech therefore really happened at the agreed fixed
40% room-output setting.

The device published 4,968 new capture frames and 4,968 new uplink frames over
the measured interval with zero new capture drop, uplink drop, freshness
restart, PCM disconnect, or Wi-Fi disconnect. RSSI remained -52 dBm. Userspace
accepted 5,000 interval frames, sent them to the live
`grok-voice-think-fast-2.0` socket, and recorded zero provider send failure;
eleven provider pings received eleven pongs. Grok nevertheless emitted zero
`speech_started`, zero `speech_stopped`, and zero response. Its accepted uplink
had peak 445 and RMS 45.15 at the current StackChan x1 policy. The harness
correctly retained the run as `audio-invalid` with no network-invalidating
reason rather than calling an idle provider a network failure.

This closes off another tempting local maximum: repeating the same count run
cannot help, and blindly applying the HAVPE x16 multiplier is unsafe. The old
waveform artifact contains far-only residual peaks above the nearby-speech
peak, so enough unconditional gain to make this prompt cross xAI's 0.1 floor
could also turn speaker echo into speech. The next discriminating experiment
is still the already-built `AEC_NLP_LEVEL_AGGR` firmware followed by the strict
six-phase physical waveform proof. That comparison must show both a preserved
near-end voice and bounded far-only residue before the smallest safe
userspace gain is chosen. The image remains uninstalled because CoreS3 needs
one physical bottom-RST hold to enter its ROM downloader; unsuccessful USB
JTAG and reset-line attempts wrote nothing.

One harness-only production defect was fixed on the way to this evidence:
Doppler exposes the configured xAI secret as `APP_CONFIG_X_AI_API_KEY`, while
the CLI accepted only `XAI_API_KEY`. Both names now feed the same in-memory
secret input and focused tests plus Kit typecheck pass. No credential value was
logged or written to evidence.

## 03:37 — Interrupted 300..400 gate executable; complete host suites green

The last planned spoken-count variant is now an executable physical oracle,
not a checklist item. For 300..400, the StackChan runner requires an exact
independently transcribed audible prefix of at least 25 consecutive numbers,
then performs a real full-duplex near-end interruption, verifies the physical
playback purge and provider outcome ledger, and independently transcribes the
short replacement reply from its own acoustic interval. A complete 300..400
answer is rejected because it would prove that the requested interruption did
not happen. The unbroken 1..100, 100..200, and 200..300 variants continue to
require their entire inclusive sequences without an omission, repetition, or
reordering.

After formatting, all 687 Kit TypeScript tests pass (with only the explicitly
live tunnel test skipped), Kit typecheck passes, and all 77 native C/C++ host
tests pass. A shared project-ingress resolver also removes the need to reset
and read-flash a healthy ESP merely to recover its key: an explicit project key
still wins, while a Doppler-backed harness can use admin authority solely to
reveal that project's born key in memory, dispose the admin connection, and
run the measured path with project-secret auth. A live production resolution
proved that path without logging the key. The moderate 40% Mac-output fixture
is retained across both the StackChan and HAVPE production Grok runners;
volume is no longer being treated as a separate investigation. The sole
immediate hardware dependency remains installing the already-built
less-destructive StackChan NLP image after its CoreS3 has physically entered
download mode.

## 03:25 — Later count gates executable; USB-JTAG fallback rejected cleanly

The physical Grok runner is no longer hard-coded to 1..100. Its shared CLI and
outer flash/provision runner now select exact 1..100, 100..200, or 200..300
acceptance intervals. One inclusive range drives the prompt, provider-output
ledger, independent Mac-microphone ledger, physical-speech comparison, and
manifest, so a healthy short conversation cannot be mislabeled as a later
endurance run. The spoken-number parser now handles digit and compound-word
forms through 400, including optional “and”, while still rejecting omissions,
repetitions, and reordering at the exact first divergent position. Twenty-three
focused tests and Kit typecheck pass. The required 300..400 interrupted variant
remains separate because accepting a deliberately cancelled prefix needs a
different oracle from an unbroken inclusive range.

The attempted no-button StackChan recovery is also now exhausted without a
write. There is no OTA partition or installed OTA capability. Temporarily
powering off the separate three-device USB hub left the CoreS3 as the only
eligible Espressif target; both installed Espressif OpenOCD releases still
failed at macOS's USB string-descriptor boundary before JTAG attach. The hub was
restored immediately, all four stable USB serial identities reappeared, and
StackChan and HAVPE both remained reachable on their prior LAN addresses. No
flash bytes were written and no ambiguous adapter was ever opened. The built
NLP-policy image therefore still awaits M5Stack's documented three-second
bottom-RST download-mode entry.

## 03:06 — StackChan double-talk failure isolated; less-destructive NLP policy built

The first complete, network-valid production waveform run is retained at
`evidence/stackchan-production-aec-waveform/2026-08-03T01-45-53-719Z`.
Every phase retained contiguous accepted-uplink ordinals with no truncation.
Five of six phase clocks passed; the speech-shaped far-end phase covered
4,020 ms of PCM over a 4,188 ms accepted span, a measured 168 ms expansion
against the unchanged 60 ms realtime limit. That cadence miss remains a real
failure, but it does not explain the repeatable acoustic result because the
near-only, near-repeat, and double-talk phase clocks all passed and the
correlated network interval was valid.

The exact miss is not being assigned to the network. During that phase the
board stayed at -51 to -52 dBm with zero reconnects, board/router RTT stayed
roughly 3–15 ms, and production-worker RTT stayed 13–26 ms. The AEC owner kept
processing 31–32 of its 32 ms blocks per second with no capture-reserve drop,
bridge error, or AEC recreate. The device reported 42 WebSocket send deferrals
over the complete run but no new capture/uplink drop or freshness restart;
because that cumulative counter is not retained per phase, it is a candidate
rather than a causal attribution. A corrected-firmware comparison must retain
the same strict cadence gate and may not call the 168 ms expansion network
noise.

The acoustic result localised a policy error rather than an alignment or
transport error. The two broadband far-only challenges were suppressed to
-41.57 and -59.36 dBFS, while the fixed tone narrowly missed at -39.01 dBFS.
Moderate Mac speech measured -51.13 dBFS alone and -42.09 dBFS during
double-talk, but its waveform similarity collapsed from 0.665 in the repeated
near-only control to 0.138 during simultaneous device playback. The device's
far-end path was roughly 30–40 times stronger at the microphone than that
nearby voice. The configured `AEC_NLP_LEVEL_VERYAGGR` was therefore removing
near-end interruption along with residual echo—the exact failure mode the
full-duplex product may not trade away for prettier far-only numbers.

A source-level regression now pins the shared CoreS3 owner to Espressif's
documented default `AEC_NLP_LEVEL_AGGR` and rejects `VERYAGGR`; it failed before
the source change and passes afterwards (31 focused tests). The resulting
physical StackChan image builds successfully, including the BSP provenance and
realtime ISR ELF audits. Installing it is the current physical blocker:
StackChan is still exactly identified as USB serial `68:EE:8F:D8:53:20`, but
its CoreS3 reset-delay circuit did not enter ROM download mode under standard
esptool, explicit USB reset, or a three-second host control-line hold. No flash
bytes were written. M5Stack's own recovery procedure requires the bottom RST
button held about three seconds until the green LED; one such physical entry
is required before the comparison run. Acoustic stimuli remain at the agreed
moderate fixed profile rather than becoming a separate volume investigation.

The verification pass also caught one host-harness defect rather than hiding
it: the Apple-only microphone input test target was declared before the
directory-wide `-UNDEBUG` policy, so MinSizeRel rejected it because its
assertions would have been compiled away. That target now opts into
`-UNDEBUG` at its own declaration; its native executable and all assertions
pass. The focused architecture suite is 31/31 green, and the complete Kit
suite is 669/669 green with only the explicitly live tunnel test skipped.

## 02:09 — Production AEC waveform path is exact; two runs invalidated by WAN degradation

The deployed production harness can now switch the existing StackChan worker
from Grok to a six-response deterministic provider, run the real `/pcm` lane
through the physical speaker, room, microphone, and on-device AEC, capture only
the post-gain PCM that the worker actually accepted, and restore Grok. Raw PCM
capture is structurally unavailable in Grok mode. The mode transition is
fenced by polling `/health` on the same dynamic-worker stub because `itx.kv` is
Workers KV and its acknowledged writes are eventually consistent across edge
locations. The harness also treats the exact `ctx.abort("kill requested")`
rejection from `worker.kill()` as successful generation retirement, reacquires
a fresh stub after every kill, and fails closed unless Grok restoration is
observed. Eight focused suites (43 tests) and Kit typecheck pass.

The first fenced run at
`evidence/stackchan-production-aec-waveform/2026-08-03T01-02-49-429Z`
completed ambient plus four physical responses before the near-only capture
fell to 161 frames in 4,129 ms instead of 203–209. The second at
`evidence/stackchan-production-aec-waveform/2026-08-03T01-06-21-284Z`
was exact through ambient, three distinct far-end challenges, and near-only:
152/152, 201/203, 203/204, 203/204, and 205/204 frames respectively, all within
the strict three-frame boundary tolerance and with no truncated frames. The
next identical near-repeat fell to 177 frames in 4,179 ms instead of 206–212,
so the harness stopped before double-talk rather than accepting a biased AEC
comparison.

Both failures are automatically and durably classified `network-invalid`, not
AEC failures. In the second interval the physical local path stayed healthy:
StackChan RSSI was -52 dBm with no Wi-Fi disconnect, StackChan RTT was usually
4–14 ms, and the current gateway `192.168.1.254` stayed around 3–8 ms. In the
same aligned interval, worker RTT climbed 87, 93, 99, 108, 140, 160, 247, 321,
and 404 ms before one missed probe. Immediately afterwards, independent WAN
probes still showed 20% loss and 140 ms average RTT to `1.1.1.1`, while the
gateway remained 4 ms. The application correctly discarded stale mic frames
instead of accumulating conversational delay. No capture-completeness,
transport-conservation, reset, or network-validity threshold has been relaxed.

Acoustic playback remains deliberately moderate and always restores the
preceding Mac setting. The 30% StackChan run put nearby speech only 4.6 dB above
ambient, below the unchanged 15 dB comparison gate, so the next fixture uses
the already-reviewed 40% residential ceiling—still less than half the former
85–90% setting. Volume remains a fixture knob, not a separate workstream. The
next physical run must wait for a clean WAN window and must complete all phases
in one network-valid interval before AEC is judged. StackChan → HAVPE remains
the order for the shared waveform proof; the long Grok counting/interruption
gates remain pending after AEC.

Two live lifecycle defects were found and fixed before these runs. Calling
`worker.kill()` really did abort the request after killing the generation, so
the previous harness falsely treated success as failure and retained a dead
stub. Separately, an acknowledged KV mode write did not mean the selected edge
had observed it; one early run proved Grok had opened instead of the intended
deterministic provider. The new exact-abort helper and same-worker mode fence
have direct regression tests, and no conversational Grok PCM was retained by
the rejected diagnostic capture.

## 00:41 — HAVPE AEC-only physical gate reconciled; room output reduced

The retained AEC-only run at
`evidence/home-assistant-voice-preview-edition-aec-physical/2026-08-02T23-27-41-344Z`
is now threshold-versioned in `AEC-ONLY-REASSESSMENT.md`. It had exact transport,
valid network evidence, three clean far-only challenges, negligible residual
speaker correlation, 0.909 double-talk near-speech similarity at 0.931 gain,
and identical independent 11-word transcripts with and without simultaneous
device playback. The original artifact remains immutable and records the two
old-gate misses.

The waveform oracle now requires 15 dB of comparison headroom, matching its
-6 dB absolute residual floor, and permits at most 0.10 similarity loss / 8 dB
residual degradation from the repeated-room control. Absolute near-speech,
far-leakage, frame conservation, reconnect/reset, recorder, and network gates
were not relaxed. Five focused suites (39 tests) and Kit typecheck pass.

The production harness's Mac `say` volume was found hard-coded at 85% and was
never restored. It now uses 50% and restores the exact previous setting on all
exit paths. Future broadband AEC fixtures move only modestly from Mac 35% to
30% and device stimulus coefficients down ten percent; the physical SNR gate
still fails closed if that comfort reduction makes a run unmeasurable.

The deployed VAD policy name is also corrected from stale `xmos-aec-ns` to
`xmos-aec`; its first production calibration remains fixed gain ×8, threshold
0.1, 400 ms prefix, and 500 ms silence. The next gate is a bounded real-Grok
conversation on the freshly proven AEC tap, not another loud synthetic sweep.

## 21:36 — One semantic presence frame, several physical renderers

The cross-device UI contract is now deliberately narrower than a shared
drawing API. A standalone, host-testable C producer will emit one immutable
semantic **presence frame** from the whole conversation state and the latest
PCM-derived expression state. At minimum that frame carries control-plane and
call connectivity, call phase, network quality/fault state, conversation
elapsed time, recent audio level, and the existing viseme/mouth controls. It
must not know about sockets, displays, LED drivers, sprite atlases, or a target's
pixel geometry.

Thin physical adapters consume exactly that frame. HAVPE maps it to its twelve
LEDs; small-screen targets render the same recognisable ring structure as a
tiny pixel grid alongside their device-specific instructions and avatar; and
StackChan can map it to both of its LED arrays as well as its face. This lets
the same conversational expression drive pixels or LEDs without forcing an
LED target through a framebuffer abstraction. Adapters may choose geometry and
brightness, but they may not independently reinterpret transport or call
state. The existing avatar pose/viseme types will be inspected and extended or
wrapped rather than duplicated.

This refactor follows the current HAVPE long-response landing gate: the physical
count-to-100 disconnect is still the first blocker, so the semantic model will
not be allowed to conceal or postpone that measured transport failure.

## 21:28 — Shared glanceable UI and final physical acceptance contract

The device UI now has one additional cross-target requirement: every target
must render the same recognisable call-state ring model. HAVPE renders it on
its physical twelve-pixel ring; StackChan and M5StickS3 must render a tiny
pixel-grid version on their screens next to device-specific control
instructions. The shared semantic states are at least control-plane connected,
idle/no call, call connecting, listening/PTT capture, provider speaking,
degraded network, and fault. Physical drawing remains target IO; the state
model and colour/segment meaning belong in shared, host-testable code.

Before the three-device goal may be called complete, each device must be cold
restarted and exercised physically. The harness—not a human—must invoke the
same call-toggle and restart paths exposed by the real button state machine;
for the Stick it must also invoke press-and-hold PTT. It must speak through the
adjacent Mac using `say`, allowing for command-to-acoustic onset delay, record
the actual device speaker through the Mac microphone, and retain aligned
provider, device, worker, acoustic, and network evidence. A counter or provider
transcript without an audible physical conversation is not acceptance.

## 21:27 — HAVPE count-to-100 failure localised below Grok

The user asked the physical Home Assistant Voice Preview Edition to count to 100. It became inaudible after roughly 37 and the call could not continue.
The failed production session was:

`prj_4f76ffe131f1495981afd65619f57914:home-assistant-voice-preview-edition:d2a15a10-58c7-475b-9738-52b2df0ede86`

This was not an xAI generation crash. The durable provider stream contains a
complete output transcript through 100, and `response.done` reports
75.4176666666667 seconds of generated audio. The provider emitted that future
audio in roughly 11.5 seconds. The production worker then realtime-paced only
1,534 20-ms frames (about 30.68 seconds) before the device-originated `/pcm`
generation disappeared with close code 1011 and reason `WebSocket disconnected
without sending Close frame.` The worker's response reservoir consequently
reached 2,042,196 bytes and discarded 1,498,196 bytes after its physical
downstream vanished.

The first post-failure device snapshot reported cumulative downlink received
3,230, dropped 1, depth 0, high-water 32, and receive failures 1. The firmware
downlink SPSC ring has exactly 32 slots. In the current transport source, one
`ITERATE_KIT_BACKPRESSURE` while publishing a consumed WebSocket item increments
exactly the drop/failure counters above, records `ESP_ERR_NO_MEM`, and retires
the PCM socket generation. This is a strong source-and-counter match, but the
snapshot was not sampled at the exact failure edge, so the next reproduction
must retain aligned one-second depth, failure, playback-owner, worker pacing,
provider, and network observations before promoting the attribution from
inference to measured causal proof.

The most important harness blind spot is now explicit: the userspace unit tests
model a WebSocket peer that accepts every frame immediately. They verify a
72-second response reservoir and a 12-frame startup lead, but do not model a
separate hardware playback clock, TCP/TLS delivery bunching, or a finite
32-frame device receive ring. A red host model for those independent clocks is
the next implementation gate.

Network probes immediately after the incident were clean, but no probe series
covered its exact interval. The historical run is therefore network-unknown,
not network-valid and not proof of an audio-clock defect. A clean subsequent
count-to-100 run remains mandatory.

## 21:27 — HAVPE endpointing shortened, applied value acknowledged

The deployed xAI session now sends `silence_duration_ms: 500` for the named
HAVPE `xmos-aec-ns` profile; StackChan remains at 1,000 ms pending its separate
pause/AEC calibration. A live `session.updated` event acknowledged exactly:

```json
{
  "type": "server_vad",
  "threshold": 0.1,
  "silence_duration_ms": 500,
  "prefix_padding_ms": 400
}
```

xAI's official Voice Agent documentation publishes a range of 0–10,000 ms for
`silence_duration_ms` but does not publish its omitted default. It does publish
the server-VAD threshold default as 0.85 and prefix-padding default as 333 ms.
An authenticated direct `grok-voice-think-fast-2.0` probe also could not
materialise the missing default: `session.created` returned only `type: null`,
and after updating with only `{ type: "server_vad" }`, `session.updated` echoed
only that type rather than expanding silence, threshold, or prefix values.
Thus 500 ms is the app's explicit HAVPE setting (the previous app setting was
1,000 ms), not a claimed provider default.
The current threshold 0.1 is an explicit measured override, not a provider
default. Two low-level ambient bursts of 84–554 ms already triggered it in one
live silent interval, so faster endpointing and that unusually sensitive
threshold must be calibrated together rather than treating “500 ms” alone as
latency improvement.

## Background independent review

Claude Fable Max background session `114ea3be` is reading the worker scheduler,
ESP-IDF transport/I2S source, HAVPE driver path, retained evidence, and
first-party guidance. Its bounded report target is
`fable-havpe-long-response-downlink-review-2026-08-02.md`; implementation is not
blocked on it and its recommendations will be reconciled against tests and
physical evidence rather than accepted automatically.
