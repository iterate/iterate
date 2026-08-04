# Voice-device adventures — 2026-08-04

Newest entries are prepended below.

## 16:14 — StackChan restored to DTD AEC; production stop/hang-up bug fixed

The user's live observation was decisive: under the prior profile-5 firmware,
ordinary repeated “bye bye” did not interrupt StackChan, while a very loud
“STOP PLEASE” finally did. Together with the retained 3–9% overlap gain and
the absence of capture/transport drops, this classifies the failure as
nonlinear double-talk suppression rather than VAD sensitivity.

StackChan now uses ESP-SR `AFE_TYPE_VC` / VOIP profile 3, the only available
ESP-SR 2.4.7 path here with its double-talk detector enabled. It remains the
same shared constant processed-uplink path: 256-sample processing frames,
18 dB microphone PGA, x10 post-AEC gain, and 80% speaker volume. No target-side
speech detector, mute, or second uplink was added. The application is
1,307,520 bytes with SHA-256
`fa0b05617458aa201d18129361440206d16664c92f47d5932a1af6087e9da2ad`.
The ESP-IDF build and realtime ELF audit passed, and esptool verified exact MAC
`68:EE:8F:D8:53:20` before flashing `/dev/cu.usbmodem2101`.

The first production run stopped on an unrelated exact-oracle miss: the full
normal phrase survived but Grok rendered `cactus` as `test`. The oracle was
returned to `amber`, which the same VOIP profile had already recognized
exactly; no fuzzy match or AEC threshold was introduced. The next run completed
the exact normal turn. During physical overlap, the ordinary-volume Mac prompt
also reached Grok, including “Stop and reply exactly interruption…”. That is a
material improvement over the profile-5 overlap, but the production prompt
then called `endConversation` merely because it contained “Stop”. The call
closed intentionally and the harness correctly failed on the replaced `/pcm`
generation. The occupied room also contributed unrelated speech, and the
interval crossed fixed RTT limits, so it is not a clean AEC acceptance run.
Evidence is retained under
`evidence/stackchan-voip-dtd-volume80-production-grok-20260804/2026-08-04T15-08-49-846Z`.

The userspace semantics now distinguish interruption from hang-up: “stop”,
“pause”, or “be quiet” stops the current reply but keeps the conversation;
only an explicit request to end the conversation, hang up, or go back to sleep
may call `endConversation`. The regression was observed red, then the focused
provider/device/AEC suite passed 76/76. The production project
`prj_0363ecd53eda492e972b07debd56eb46` was updated to userspace commit
`a7a82908a1b7dcbcdf2729cc5b4e30f26ee817fd`. A post-deploy proof was rejected
before stimulus because the occupied room failed the unchanged silence gate.
After teardown, one immediate capability lookup found the mount absent; it
remounted within the next bounded check while the board remained continuously
reachable. Diagnostics then showed control connections 2/disconnects 1 with
zero control WebSocket, protocol, receive, or send errors, RSSI -47 dBm. This
is recorded as a control-lane remount to explain, not silently ignore, during
the next clean run.
Therefore the next gate is exactly one quiet-room production run of normal
speech plus ordinary-volume double-talk; neither the DTD firmware nor the new
prompt is yet called release-accepted.

## 15:47 — StackChan “bye bye” failure reproduced as nonlinear double-talk suppression

The user's report that StackChan needed several repetitions of “bye bye” while
the assistant was speaking is real AEC behavior, not a control-plane or queue
failure. A production-shaped unattended run on exact StackChan MAC
`68:EE:8F:D8:53:20` first completed a normal server-VAD turn with the exact
input and output “Production audio signal cactus is clear and audible.” It then
played a long Grok response through the physical speaker while the nearby Mac
said “Stop and reply exactly interruption test complete.” Grok retained only
“Reply exactly in production system, please.” The provider did open VAD and
the worker did truncate/purge the active response at the hardware-played
boundary; the lost/distorted words are upstream DSP evidence.

The failed run is retained at
`apps/kit/evidence/stackchan-fd-high-perf-volume85-production-grok-cactus-20260804/2026-08-04T14-38-12-722Z/`.
Digital conservation passed. Across the interval there were zero capture
reserve drops, AEC recreates, clipped samples, playback write failures, queue
overflows, underruns, reset failures, or stale-frame discards. Full-pipeline
`FD_HIGH_PERF` suppressed far-only playback by 25.55 dB and preserved a
near-only window at 0.999 normalized gain. During the actual overlapping
phrase, however, representative 512-sample windows retained only roughly
3–9% of the raw near-channel mean after undoing the declared x10 wire gain.
That is the mechanism which makes the first attempted interruption disappear.
The interval is additionally network-invalid because router/device/worker RTT
crossed their fixed validity limits; that does not explain or excuse the local
input-vs-clean suppression measurement.

A controlled pre-NLP profile was also physically rejected rather than adopted
as a shortcut. Image SHA-256
`f428772fa205977d2b9f008e9a687802edd63add8de9d30151ee4c761f8dbac0`
ran within its 32 ms DSP deadline, but Grok transcribed StackChan's own spoken
reply verbatim and created a second response. Blanket nonlinear-filter bypass
therefore fixes near-speech preservation by breaking echo rejection.

The first 85% run using an acoustically ambiguous label was stopped because
Grok rendered “amber” as “number”; the raw event retained the opening words.
The harness now uses the phonetically distinct label `cactus` and still
requires exact transcript equality—no alias or fuzzy threshold was added.

The final bounded operating-point candidate lowers only StackChan's speaker
from 85% to 80%; microphone PGA remains 18 dB and post-AEC gain remains x10.
All 55 focused architecture/AEC tests, the ESP-IDF build, and the realtime ELF
audit pass. Esptool independently resolved and flashed only MAC
`68:EE:8F:D8:53:20`; the 1,307,200-byte application has SHA-256
`139f1a0299ac591364db9bb6c097d24af26f74f9eca457b790ca44d78c523b03`.
It booted with AEC profile 5 / 512 samples, joined `mispwoso2` at -43 dBm,
mounted control, and reached lifetime `/pcm` ready. A physical proof attempt
was automatically rejected before stimulus because the occupied room violated
the unchanged pre-prompt silence gate. Thus 80% is flashed for the next valid
quiet-room A/B, but is deliberately not recorded as an AEC fix or acceptance.

## 14:07 — authored sleepy banks, larger Zs, and a modest clean-mic lift

The dozing state now selects the real `sleepy` expression bank already present
in every shipped avatar rather than painting generic eyelids over an awake
face. Those source sheets are explicitly recorded by the original StackChan
pipeline as AI-assisted project art. Each source maps slot 8 to `sleepy`, is
authored on the character's native pixel grid, and is deterministically
compiled through the existing locked four-colour palette and 2x 80x60-to-
160x120 target. This preserves the distinct closed-eye treatment of Dot Matrix
Oracle, Karakuri Brass, and Starbyte instead of making one code-drawn shape
pretend to belong to all three styles.

The built-in image model was also run independently against the current
rendered characters with the same closed-eye requirement. Its fresh edits were
useful as an art-direction check but enlarged and smoothed the source pixels,
so they were deliberately rejected rather than weakening the established
pixel-grid and palette contract. The already-authored sleepy banks are the
model-derived assets that satisfy that contract. The shared overlay keeps only
the requested sleep notation: a 7x7, two-pixel-stroke `Z` and a 5x5 companion,
both at exact integer source pixels.

A render-level native oracle now checks every selectable atlas at the same
sample clock: dozing must select `FACE_EXPRESSION_SLEEPY` at full weight, clear
all retained speech articulation, hold the eyes closed, and produce different
framebuffer pixels before the Z overlay. Exact overlay pixels and bounds are
also asserted. All eight avatar host tests, the focused userspace/architecture
suite (46 tests), Kit typecheck, scoped whitespace checks, the exact StackChan
ESP-IDF build, and its realtime placement audit pass.

StackChan microphone output now receives a modest post-AEC gain lift from x8
to x10 (+1.94 dB). The measured 18 dB analogue PGA setting is intentionally
unchanged: the prior 24 dB experiment nearly railed during far playback and
would spend the headroom needed by AEC. Clipping remains counted in live
metrics. This is built, flashed, and digitally observable, but it is not yet an
occupied-room acoustic sensitivity verdict.

The exact StackChan ROM MAC `68:EE:8F:D8:53:20` was verified before flashing.
The current 1,304,656-byte application has SHA-256
`61a264ab42b17309640745df1ad89cc17c8279a433779aaf329fdea958e56ea3`.
It remounted in production with fresh schema-v4 diagnostics: RSSI -41 dBm,
6,756,220 bytes free heap, 23,051 bytes free internal heap, zero invalid metric
samples, and no control protocol/send/receive failures. The production
userspace source was updated to commit
`cb633471d5d7fe1ed58c9aee720ac528957177cc`; the StackChan prompt now asks Grok
to accompany clearly affirmative answers with `nod` and clearly negative
answers with `shakeHead`, without announcing the gesture or triggering on
quoted/hypothetical/ambiguous language.

One attempted `itx.kit.stackchan.captureScreen()` correctly failed as an
unknown device capability: unlike M5StickS3, StackChan does not yet register the
shared screen-capture module. That gap is retained rather than presenting a
camera observation or host render as a physical screenshot proof. No
Waveshare port was opened, and no acoustic run was attempted in the occupied
room.

## 11:32 — Real speech replaces convenient noise in the release speech oracle

- Fixture schema 2 now synthesizes and retains two independent voices exactly
  once: Daniel is the device-speaker/far-end source and Samantha is the
  Mac-speaker/near-end source. Their PCM and synthesis WAVE hashes are part of
  the immutable bundle contract.
- Every far-end speech, repeated-speech, double-talk, and applicable lifecycle
  phase now uses peak-normalized projections of the retained Daniel bytes.
  Tones, chirps, multi-tone, and impulses remain for deterministic DSP
  diagnosis, but cannot stand in for speech echo suppression: Grok could
  distinguish those patterns from voice without functioning AEC.
- The bundle currently under physical test is
  `evidence/fixture-bundles/havpe-release-real-speech-device-clocked-20260804-01`.
  Its far-speech PCM SHA-256 is
  `1e57883427a5edb5b7e158b542388c72eeafbfb8d777d86398789dc6454164ea`.
- The first full replay at
  `evidence/havpe-aec-release-matrix-20260804-network-valid-01/2026-08-04T10-06-55-298Z`
  stopped with the exact diagnostic
  `provider-downlink-source-underrun`: the host-paced fixture treated the
  intentional 250 ms source outage as fatal before the ESP could demonstrate
  recovery. That run was retained and was not scored as AEC evidence.
- The shared fixture policy now matches production ownership: 32 source-ready
  frames, eight initial frames sent to the ESP, then device-clocked playout.
  The Mac no longer owns a second competing 20 ms output clock. A fresh
  authenticated HAVPE run is in progress at
  `evidence/havpe-aec-release-real-speech-device-clocked-20260804-01/2026-08-04T10-30-01-278Z`.
  It is not a verdict until acquisition completes, configuration restoration is
  verified, and the independent strict scorer passes.

## 11:18 — The Mac fixture path now acquires calibration and scores release evidence

- Added an automated, authenticated physical calibration mode to the same Kit
  Mac `/api` + `/pcm` server used by the release matrix. It retains exact source
  bytes, raw/clean target traces, whole PCM lanes, clipping counts, metrics,
  socket lifecycle, and interval-aligned network evidence while restoring the
  original Mac volume and device configuration.
- Kept target codec semantics honest: HAVPE records its compiled AIC3204 DAC
  decibels; StackChan records ESP codec volume percentage. They are not exposed
  as a misleading shared percentage.
- Exact HAVPE `D8:3B:DA:46:20:34` completed a network-valid calibration at
  `evidence/havpe-aec-calibration-network-witness-fix-20260804/2026-08-04T10-04-22-402Z`.
  Accepted device PCM peaks are 1,500/6,000/12,000 with zero full-scale source,
  playout, or raw samples. The 12,000 ceiling is a reviewed quiet-room safety
  ceiling, not a claimed electrical maximum. Mac levels 15/25/35% were likewise
  unclipped. The strict contract is
  `evidence/calibration/havpe-D8-3B-DA-46-20-34-rerun.json`.
- Fixed a network-attribution defect exposed by the first run: Captun produces a
  Fetch `WebSocketPair`, not a Node bridge socket. Captun evidence now uses
  device transport counters plus recorder byte progress; direct LAN alone uses
  Node bridge open/close evidence. The original network-invalid diagnostic is
  retained rather than rewritten.
- Materialized the exact 32-phase bundle at
  `evidence/fixture-bundles/havpe-release-20260804-network-valid-01`. A full
  physical HAVPE acquisition is in progress under
  `evidence/havpe-aec-release-matrix-20260804-network-valid-01`; it is not yet a
  verdict.
- Added the fail-closed schema-2 retained scorer. It requires all canonical
  phases, exact fixture/per-phase hashes, whole PCM frames, contiguous device
  traces, target-truthful planes, metrics, bounded socket lifecycle, and an
  independent network verdict before scoring per-window echo suppression and
  near-end preservation. The acquisition manifest deliberately remains
  `acquisition-complete-unscored` until this separate command runs.
- Fixed future trace scheduling so the underrun/recovery phase captures a
  three-second window centered on its exact 250 ms source outage at five
  seconds. The currently running acquisition started before that fix, so it is
  diagnostic and must not be promoted as the final underrun proof even if its
  other rows pass.
- Exact StackChan `68:EE:8F:D8:53:20` is not attached. No substitute board was
  used, and denylisted Waveshare `1C:DB:D4:7A:16:C8` was not opened or touched.

## 10:44 — Shared controller now owns physical phase time

- Moved the minimum monotonic duration invariant into the shared release-matrix
  controller. A target adapter or three-second device trace can no longer mark
  an eight-second or ten-minute phase complete early.
- Added a deterministic 600,000 ms regression test plus ordered source/lifecycle
  tests. Source completion is still awaited; a real overrun is retained rather
  than cancelled to make evidence look punctual.
- Added manifest-owned provider fault controls: an exact 250 ms outage at sample
  80,000 for underrun/recovery, with no catch-up burst, and deliberate provider
  generation retirement which preserves the fixture response index.
- Connected `--fixture-bundle` to the real authenticated physical session. It
  now drives all shared phases, exact near/far sources, lifecycle actions,
  complete `/pcm` recording, per-phase slices, and non-overlapping bounded
  device trace windows, while restoring Mac volume and device credentials.
- Full acquisition is deliberately stamped `acquisition-complete-unscored`.
  The strict 32-phase scorer and measured target calibrations remain explicit
  gates; this entry is not a physical AEC pass.

## 10:20 — HAVPE tap A/B stayed strict; full fixture bytes are now materializable

The exact HAVPE ran two authenticated direct-LAN repetitions using a separately
built XMOS AEC-stage image (`7f0d8c7255f832f8a318c5fe42c60e1554ba391d924bfa6911fab112c6bc4259`).
The first produced excellent DSP measurements—0.902 double-talk similarity and
-46.61 dB far residual—but one router RTT reached 57.592 ms against the fixed
50 ms network gate, so it is `network-invalid`. The unchanged rerun was
network-valid and transport-perfect, but missed the unchanged relative
double-talk gates at 0.081 similarity loss and 8.54 dB residual degradation.
It is `audio-invalid`. Neither result was promoted and no threshold moved.
Artifacts are under `evidence/havpe-aec-direct-lan-aec-tap-20260804*`.

This falsifies the tempting one-line “select AEC instead of NS” fix: the tap can
look much cleaner while not yet being repeatably inside the preservation gate,
and earlier production evidence still shows a cold-onset self-trigger. The
ordinary NS application was rebuilt and app-only flashed back to exact MAC
`D8:3B:DA:46:20:34`; the configuration partition was preserved and the
denylisted Waveshare was untouched.

The previously declarative release matrix now has an executable shared fixture
plan. Calibration includes independent Mac quiet/nominal/loud levels as well as
device quiet/nominal/maximum non-clipping PCM levels. The deterministic provider
supports exact per-response durations on one connection, and `pnpm aec:fixtures`
materializes every far source plus one retained near-speech WAVE/PCM, with exact
phase metadata, measured peak, bytes, and SHA-256. Chunk-invariance, matrix
completeness, calibration, bundle writing, and variable-duration provider tests
are green. The full physical lifecycle controller is still a release blocker;
the seven-phase diagnostic runner remains deliberately insufficient.

## 09:58 — network-valid HAVPE run isolates a real DSP double-talk miss

The Mac fixture ran through direct LAN using the exact same authenticated
Cap'n Web and `/pcm` application as Captun. This removed the gateway from the
diagnostic interval without introducing a second fixture implementation. The
exact HAVPE `D8:3B:DA:46:20:34` completed all seven representative phases with
zero microphone/speaker drops, restarts, resets, underruns, reconnects,
recorder loss, or frame-accounting error. Network attribution was valid. The
configuration partition was restored and the denylisted Waveshare was not
opened.

The result is honestly `audio-invalid`, not a transport pass laundered into an
AEC pass. The three-second `/pcm` double-talk capture missed the fixed relative
gate by 1.13 dB (9.13 dB degradation versus an 8 dB limit). A new standalone
offline scorer then recomputed three independently named lanes from retained
and hashed bytes. The bounded one-second device-clean trace also fails: 0.899
near similarity, 1.032 gain, -5.95 dB residual, and 9.02 dB degradation. This
places the defect in the XMOS-selected clean output rather than the socket or
userspace recorder. Raw microphone, clean, exact fixture downlink, and `/pcm`
uplink remain under:

`evidence/havpe-aec-direct-lan-diagnostic-20260804-final/2026-08-04T08-45-53-466Z`

`pnpm aec:score -- <run>` now reproduces the verdict offline, writes
`aec-offline-assessment.json`, hashes all scoring inputs, rejects incomplete
traces, and keeps DSP-only validity separate from transport/network validity.
Two harness defects discovered during physical use also have red/green tests:
the intentionally empty ambient downlink is valid only with explicit opt-in,
and USB ports are re-resolved by exact ROM MAC after reset instead of trusting
a stale `/dev/cu.usbmodem*` name. No AEC threshold was loosened.

## 09:30 — deterministic Mac AEC server and truthful device trace path

AEC qualification no longer depends on Grok audio generation. The existing
local Cap'n Web `/api` and binary `/pcm` fixture now opens through authenticated
Captun by default, using the repository-standard `tunnels.iterate.com` gateway;
direct LAN is an explicit isolation mode. Both transports use the exact same
authenticated fetch application. The harness requires the current device LAN
host in tunnel mode so network attribution cannot silently disappear.

StackChan and HAVPE now mount one shared bounded `aecTrace` capability. Targets
own fixed external-RAM storage while their existing realtime audio owner only
copies an already-produced frame when a trace generation is armed. StackChan
retains 1.024 seconds of raw microphone, physical electrical reference, and
selected clean output (98,304 bytes); HAVPE retains one second of its truthful
same-time XMOS raw and clean taps (64,000 bytes). Missing reference, playout,
or linear taps are represented by an availability mask and absent artifact,
never invented zero PCM. Reset/discontinuity aborts a generation, sequence gaps
are retained, RPC reads are frozen and bounded, and a slow reader cannot queue
or backpressure audio.

The TypeScript retriever validates wire magic/schema/geometry/generation,
reads exact planar PCM in bounded chunks, rejects short replies, releases both
complete and aborted generations, and hashes every retained plane. Each phase
also retains exact fixture-downlink and PCM-uplink slices. Twelve focused
transport/trace tests pass, Kit typecheck passes, both profile tests plus host
simulator/resource builds pass, and exact HAVPE/StackChan ESP-IDF builds pass.
The runbook is `docs/aec-release-qualification.md`. This is implemented harness
support and build evidence, not yet the required full physical matrix verdict.

## 08:42 — one shared `/pcm` owner, fresh physical result classified honestly

The final extraction now makes the ESP-IDF session object the sole owner of
credential prewarming, raw `/pcm` lifetime, control-generation restart,
bounded transport recovery, and the media gate
`control_ready && conversation_active && transport_ready`. Stick, StackChan,
and HAVPE each register only a conversation reader and hardware media-gate
sink, then invoke one argument-free shared poll. Raw lifecycle declarations
are platform-private; the obsolete control-recovery PCM restart action and all
target-local PCM lifecycle flags were deleted.

The architecture suite additionally requires exactly one hardware gate write
per target, so a board cannot retain a second target-local reconciler while
superficially calling the shared owner. It passes 35/35. Host C tests pass
89/89, Kit passes 774 tests with one intentional live skip, and typecheck plus
scoped whitespace checks pass. Fresh firmware image sizes are `0x12ed70`
(Stick), `0x13aae0` (StackChan), and `0x108ae0` (HAVPE); all three build and the
required realtime/BSP audits pass.

Exact Stick and HAVPE devices were freshly flashed and both completed real
production Grok voice paths with exact digital conservation and no transport
failure/drop/reset drift. Stick completed three remote PTT turns; HAVPE
completed ordinary response plus physical interruption with 28.037 dB AEC
suppression. These current artifacts are deliberately not called accepted:
the richest Stick and both HAVPE intervals were network-invalid, while a clean
network Stick repeat missed the independent relative acoustic-energy gate even
though provider and Mac transcripts matched exactly. StackChan MAC
`68:EE:8F:D8:53:20` remains physically absent. Full paths and measurements are
in `docs/shared-pcm-session-lifecycle-2026-08-04.md`; the adjacent denylisted
Waveshare was not touched.

A final non-disruptive USB inventory at 08:44 found only Stick
`70:04:1D:D5:45:88`, denylisted Waveshare `1C:DB:D4:7A:16:C8`, and HAVPE
`D8:3B:DA:46:20:34`; StackChan was still absent. This used USB descriptors and
did not open a serial port or reset any board.

## 07:39 — shared lifecycle gates rebuilt from current sources

The current shared `/pcm` session owner and all host behavior tests rebuilt
cleanly: 89/89 C tests passed, including the dedicated lifetime-prewarm,
control-remount, control-loss, bounded network-recovery, and one-shot local
start-failure cases. The target-bypass architecture test and strengthened
physical count oracle passed in a 61-test focused Vitest run.

All three exact firmware targets also rebuilt without error. Current image
sizes are 0x12ede0 bytes for M5StickS3 (41% app partition free), 0x13ab60 for
StackChan (75% free), and 0x108a80 for HAVPE (79% free). Stick and StackChan's
realtime ELF placement audits passed. This is build/architecture evidence, not
a substitute for the still-open network-valid Stick rerun or absent physical
StackChan proof.

## 07:37 — Stick 1..100 is physically exact but network-invalid

The corrected production Stick runner consumed the real `count-to-100`
scenario and retained independent overlapping-window Mac-microphone evidence.
Both the provider and acoustic ledgers contain every integer 1..100 exactly
once. Digital accounting was exact: 725 capture/uplink frames and 3,492
accepted/submitted/completed downlink frames, with zero drops, failures,
underruns, flushes, resets, protocol faults, Wi-Fi disconnects, control-socket
disconnects, or PCM-socket disconnects. Provider readiness from conversation
start was 608 ms and the response/ambient maximum-RMS ratio was 6.663x.

The artifact is nevertheless rejected, as designed, because its correlated
network interval contained router RTTs of 90.555 and 96.720 ms against the
50 ms gate and a worker RTT of 102.851 ms against the 100 ms gate. Preserve it
as exact audio/lifecycle evidence under bad network, not as acceptance:

`evidence/m5sticks3-count-to-100-overlap-oracle-20260804/2026-08-04T06-34-59-290Z/iterate-kit-acoustic-edcWut/manifest.json`

## 07:24 — the first Stick “count” pass was an oracle failure

The public proof CLI accepted `--count-to-100`, returned `passed: true`, and
produced network-valid physical evidence. Inspection of the retained raw Grok
events and independent Mac-microphone transcript proved that it had actually
run the ordinary `changeSpriteSet` oracle and said only “The Game Boy face is
active and the zebra is awake.” The M5StickS3 proof parsed `options.scenario`
but never consumed it. This artifact is deliberately classified invalid and
must never be cited as count evidence:

`evidence/m5sticks3-count-to-100-shared-pcm-session-20260804/2026-08-04T06-20-17-407Z/iterate-kit-acoustic-BkxocP/manifest.json`

This is exactly the dangerous class of harness defect where a green executable
proves its default scenario rather than the scenario named on its command
line. Fix it red-first at the public scenario/manifest seam; require both the
provider transcript and the independently recorded Mac transcript to contain
the exact inclusive count ledger. Do not infer physical count success from
frame conservation alone.

## 07:17 — shared lifecycle validation and attachment state

The shared ESP-IDF `/pcm` owner is in all three firmware targets. A fresh host
configure/build registered its previously stale test target and passed 89/89
C tests; the target-bypass architecture suite passed 35/35. Exact final
firmware builds are green for Stick, StackChan, and HAVPE. Physical lifecycle
evidence is fully green on HAVPE and digitally/acoustically green on Stick,
with the latter's earlier short turn classified network-invalid for one
104.416 ms worker RTT against the 100 ms gate.

Non-disruptive USB enumeration found:

- HAVPE `D8:3B:DA:46:20:34` at `/dev/cu.usbmodem11101`
- denylisted Waveshare `1C:DB:D4:7A:16:C8` at
  `/dev/cu.usbmodem11201` — never open, reset, or flash it
- M5StickS3 `70:04:1D:D5:45:88` at `/dev/cu.usbmodem11301`
- StackChan `68:EE:8F:D8:53:20` absent

Both attached voice devices are reachable: Stick `192.168.0.21`, HAVPE
`192.168.0.33`. Continue exact long-count and multi-turn work on those boards
without substituting another `303a:1001` device for StackChan.

# 10:38 — Exact Mac release fixtures now have a trustworthy replay seam

- Far sources are normalized to their exact calibrated PCM peak before hashing;
  the previous shaped-speech coefficient was only a conservative ceiling.
- Bundle verification now recomputes the canonical 32-phase shared plan,
  rejects phase-order/identity/near-source drift, resolves symlinks before
  reading, and hashes a phase immediately before replay.
- Near speech is synthesized once, then repeated into one exact-duration
  20-second PCM/WAVE file. Physical phases no longer need repeated `afplay`
  launches with unmeasured scheduler gaps.
- Provider response indices can now remain provider-scoped across deliberate
  reconnects. A bounded one-phase replay handoff prevents a reconnect from
  rewinding the bundle or requiring all long sources in memory.
- `runAecReleaseMatrixController()` owns phase iteration and lifecycle/source
  choreography for both targets; tests prove no adapter-local phase loop is
  needed and a failed phase cannot receive a completion marker.
- Deterministic completion no longer contains the Grok self-trigger field.
  That is correctly a separate later production gate.
- Exact HAVPE `D8:3B:DA:46:20:34` is present at USB and `192.168.0.33`.
  Router reachability was healthy (20/20, 3.8 ms average), but the first device
  ping burst queued badly (10% reported loss, 112 ms average including three
  435–855 ms replies). No acoustic result was classified from that preflight.
  Exact StackChan `68:EE:8F:D8:53:20` remains absent. Denylisted Waveshare was
  observed but not opened or touched.
- Remaining release gates are unchanged: acquire a measured exact-device
  calibration, connect the controller to the physical lifecycle/trace/scorer
  adapter, then retain one network-valid full HAVPE matrix and the identical
  exact-StackChan matrix. The ordinary HAVPE NS firmware remains restored.

## 11:52 — all three play devices are current and production-online

The occupied room is not a valid acoustic/AEC qualification environment, so
the in-progress HAVPE real-speech matrix was deliberately interrupted. Its
partial directory is retained at
`evidence/havpe-aec-release-real-speech-device-clocked-20260804-01/2026-08-04T10-30-01-278Z/`
and is classified **room-invalid and incomplete**. It must never be scored or
promoted as AEC evidence. The interruption also exposed a harness defect:
SIGINT did not restore the temporary device provisioning. That cleanup path is
a release gate for the later quiet-room matrix, not a reason to keep running
noise fixtures around a person working in the room.

Fresh current-source builds and full flashes completed for all three exact
targets. Esptool verified the ROM MAC immediately before each write:

- M5StickS3 `70:04:1D:D5:45:88` (`/dev/cu.usbmodem11301`)
- StackChan `68:EE:8F:D8:53:20` (`/dev/cu.usbmodem2101`)
- HAVPE `D8:3B:DA:46:20:34` (`/dev/cu.usbmodem11101`)

The denylisted Waveshare `1C:DB:D4:7A:16:C8` at
`/dev/cu.usbmodem11201` was enumerated without opening and was not flashed.
The current images are `0x12ed90` bytes (Stick, 41% app partition free),
`0x13b630` (StackChan, 75% free), and `0x1095f0` (HAVPE, 79% free). Stick and
StackChan realtime placement audits passed. HAVPE's temporary dead-tunnel
configuration was replaced with its existing production project
`prj_4f76ffe131f1495981afd65619f57914`; no credential was logged.

Production checks then proved more than USB presence. Every device mounted its
Cap'n Web capability, returned schema-v4 diagnostics, delivered a fresh
once-per-second metrics callback, and was associated with the correct live
userspace `/pcm` session. Invalid userspace metric samples were zero. The
initial Wi-Fi readings were Stick -46 dBm, StackChan -44 dBm, and HAVPE -32
dBm. Control and PCM WebSocket error counters were zero on all three.

One silent real-provider lifecycle was exercised through each production
userspace worker. Remote `conversation.start()` opened a real Grok session and
reached a ready provider in 1,446 ms on Stick, 1,804 ms on StackChan, and
1,331 ms on HAVPE. No initial greeting, unsolicited response, or provider
error was created. Remote hang-up returned every device to warm idle and left
control/PCM error counters at zero. This is deliberately a broad playability
smoke, not the deferred physical acoustic/AEC acceptance.

Visible capability probes also succeeded for Stick avatar selection,
StackChan avatar selection, and HAVPE's LED ring. StackChan's advertised
`servos.move()` returned the explicit error `hardware capability unavailable`:
the generic adapter is mounted, but the current target still initializes its
physical screen/LED/servo/camera ops as NULL. Do not represent those hardware
methods as working until their single-owner BSP operations are injected and
physically verified. Voice, face selection, production `/pcm`, metrics, and
call lifecycle remain available for play now.

The final post-smoke snapshot found all three idle with no provider attached,
fresh device metrics less than one second old, zero invalid metric samples, and
zero control/PCM WebSocket errors. Respectively for Stick, StackChan, and
HAVPE, RSSI was -40/-59/-39 dBm; free internal heap was
94,135/23,051/63,931 bytes (lifetime minima 53,427/20,991/49,519); and sampled
CPU was 176/440/58 permille. StackChan has the smallest internal-heap margin,
but this single snapshot is an observation rather than an endurance verdict.

## 13:25 — StackChan body controls landed; 400 ms VAD and decisive tools are live

This corrects the 11:52 snapshot above: StackChan's physical body adapter is no
longer unavailable. The audited CoreS3 BSP now enables the AW9523 external
power rails with a read-modify-write and readback, preserving unrelated output
bits. The body then identifies PY32 firmware version `0x41` and exposes its two
servos plus one atomic 12-pixel RGB565 frame. The UART completion deadline is
100 ms, matching M5Stack's first-party control path; the earlier 5 ms deadline
was not a realtime-audio safeguard and falsely reported normal servo writes as
I/O failures under system load.

The shared conversation-light renderer now drives StackChan's real LEDs rather
than drawing a fake strip in the display sidebar. Logical pixels 0 through 5
are one physical run and 6 through 11 are the other, so the tested healthy-link
state places three green pixels on one side. The display keeps the face as the
primary element, uses a muted text-only side rail, excludes the Game Boy-style
sprite, and retains only `dot-matrix-oracle`, `karakuri-brass`, and `starbyte`.
Idle is the sleeping/breathing state and whole-screen tap toggles the call.

After rebuilding and flashing exact StackChan MAC `68:EE:8F:D8:53:20`, real
production ITX calls through project `prj_0363ecd53eda492e972b07debd56eb46`
returned acknowledged success for:

- `changeSpriteSet("starbyte")`
- a complete nod trajectory and return to neutral
- a complete left/right head-shake trajectory and return to neutral
- remote conversation start and remote hang-up

The userspace Grok session exposes those operations as `changeSpriteSet`,
`nod`, `shakeHead`, and `endConversation`. Tool results require the underlying
C capability to return exact `true`; the model cannot claim an unacknowledged
physical action succeeded. The prompt now prefers safe reversible action to a
permission question, asks only when the missing answer materially changes the
outcome or safety, and explicitly chooses a supported face itself when the user
asks for a face change without naming one. It may occasionally make a
delightful surprise, but unrelated words still cannot infer a device action or
hang-up.

Every server-VAD session now sends `silence_duration_ms: 400`. This is one
shared provider configuration used by StackChan's low-level AEC profile and
HAVPE's XMOS AEC profile; the PTT-only Stick correctly does not instantiate
server VAD. Focused tests assert the exact 400 ms value for both profiles. The
same runtime source was installed in all three production projects:

- StackChan `prj_0363ecd53eda492e972b07debd56eb46`, source
  `7e5e163cdbcad77a0042c8f544fc4bcad398ce34`
- HAVPE `prj_4f76ffe131f1495981afd65619f57914`, source
  `e08af4b96e13128c9e9297ba9890b0ebce67c6b1`
- M5StickS3 `prj_bd8785e119fe4f1d8631bb95e1dea748`, source
  `0106f385ce1afc41f60d727f6c694da1ffe0345e`

A retained StackChan `session.updated` event independently showed the exact new
instructions, all four tools, and `{type: "server_vad", threshold: 0.1,
prefix_padding_ms: 400, silence_duration_ms: 400}`. The final idle health sample
had RSSI -45 dBm, 6,757,100 bytes free heap, 23,051 bytes free internal heap,
fresh metrics, and zero control/PCM socket disconnect, protocol, send, receive,
TLS, or raw-write failures. The current post-build StackChan application is
1,287,744 bytes (`0x13a640`) with SHA-256
`1dfe20b01e0160ac5f55ac24eb81ece25555b0bc15a9b639e88fa7673a832c0f`.

The host StackChan hardware adapter test, shared avatar/light/touch/control C
tests, focused provider/tool tests, Kit typecheck, ESP-IDF build, and realtime
placement audit pass. No occupied-room acoustic run was attempted. Therefore
this is production control/body/VAD deployment evidence, not the still-deferred
quiet-room StackChan/HAVPE AEC release qualification or a visual color claim.

## 13:42 — A real shared dozing visual is live on both screen devices

The earlier closed-eye lifecycle state was not an adequate visual contract: it
could be mistaken for an ordinary animation frame and did not provide the
requested recognisable sleeping sprite. A new allocation-free shared avatar
module now owns the dozing treatment for both StackChan and M5StickS3. It holds
the eyes closed, suppresses mouth/speaking articulation, and overlays a muted
large `Z` plus small `z` in the top-right of the 160x120 avatar product. Awake
conversation states use the normal selected sprite set; changing face therefore
does not create a second, target-local sleep implementation.

StackChan derives dozing directly from `conversation_active == false`.
M5StickS3 derives it from the same lifecycle boundary: boot/control-connect,
ready, and failed/idle states doze, while connecting/listening/thinking/
speaking conversation states wake the face. A native C oracle checks pixel
bounds, deterministic overlay geometry, closed-eye state, cleared mouth state,
and no-op behavior on undersized buffers. An architecture test also fails if
either screen target bypasses the shared preparation or overlay functions.

The native avatar and doze tests, all 36 firmware architecture tests, both
ESP-IDF builds, and StackChan's realtime ELF placement audit pass. Exact
MAC assertions preceded both flashes; esptool independently reported StackChan
`68:EE:8F:D8:53:20` and M5StickS3 `70:04:1D:D5:45:88`. The flashed application
images are:

- StackChan: 1,301,760 bytes, SHA-256
  `eb4806c28aaa2e69f824c5bc7af12b0a4e091759decf12f22293bdde053b14a8`
- M5StickS3: 1,228,896 bytes, SHA-256
  `99591329e915fc89539d77b1a3e4021693ab29670a823ff9ebab2fbc2ea7c5da`

Both exact boards remounted their production capabilities after flashing.
M5StickS3 reported RSSI -43 dBm, fresh event/metrics subscriptions, and zero
control or PCM disconnect/error counters. StackChan reported RSSI -42 dBm and
fresh subscriptions; its control channel was clean, while its separately
tracked lifetime `/pcm` counters recorded two TLS transport failures during
post-flash warm-idle attempts before reconnecting. That startup transport
behavior is retained as a separate operational issue rather than being hidden
inside this renderer acceptance. No Waveshare port was opened and no acoustic
test was run in the occupied room.

## 14:48 — Decisive body-language prompt and real screen capture are live

StackChan's production Grok prompt now gives the model concrete social
semantics instead of merely listing tool names. An affirmative answer should
use `nod` while speaking; in particular, “Are you there?” means call `nod` and
say “Yes, I'm here.” A request to “go back to sleep” means call
`endConversation` without asking for confirmation (a brief sign-off is
allowed). The deployed StackChan worker in project
`prj_0363ecd53eda492e972b07debd56eb46` uses source commit
`ea386f2f63b36c984222dfb5d927834842ad626a`; focused tests pin both the prompt
examples and the tool descriptions so later wording cannot silently erase
these behaviors.

`itx.kit.stackchan.captureScreen()` is now a real byte-returning Cap'n Web
capability. It captures the single 160x120 RGB565 source framebuffer that is
expanded exactly 2x onto the 320x240 panel. It therefore reports the display
owner's actual image without adding a camera oracle, LCD readback path, LVGL
snapshot tree, or second UI owner. The framebuffer mutex covers only the
coherent 38.4 KiB copy; compression and Cap'n Web transfer happen after the
lock is released, so an RPC cannot hold the 15 Hz render path behind network
work.

The first physical implementation exposed two useful real-device failures.
Holding the framebuffer mutex over SPI made the capture deadline depend on a
full panel transfer, so ownership was narrowed to the source image. ESP-ROM's
PNG convenience wrapper then failed despite 6.75 MiB of free PSRAM because its
hidden miniz state tried to consume the roughly 23 KiB remaining internal
heap. The accepted encoder instead allocates the filtered rows, `tdefl` state,
and bounded PNG result explicitly in PSRAM; it writes PNG chunks and CRCs into
the caller-owned result and uses the Sub filter plus bounded RLE/greedy
deflation. The generic capability owns exactly one returned result and invokes
the platform release once after Cap'n Web serialisation.

Two consecutive production captures on exact StackChan MAC
`68:EE:8F:D8:53:20` returned valid, visually inspected sleeping-face PNGs and
logged a matching release each time:

- 3,016 bytes, SHA-256
  `247e3efd0ef30dd0af3b19ea4fdab0418b76f65fd3fd3abad4e17c421b4d804b`
- 3,018 bytes, SHA-256
  `fba886d190c386ede2cef9e52a98bf1ef7b876e67a475f96d07039551d02a000`

Both physical encodes took 57–58 ms in total, including 32 ms in deflate. This
replaces an otherwise valid 968-byte default-miniz result that required about
11 seconds of PSRAM hash search and was therefore rejected as an operational
design. The retained artifacts are under
`apps/kit/evidence/device-screen-captures/`. The flashed application is
1,304,656 bytes (`0x13e850`), SHA-256
`61a264ab42b17309640745df1ad89cc17c8279a433779aaf329fdea958e56ea3`,
leaving 75.1% of the smallest 5 MiB application partition free.

The native StackChan control test, simulator build and 20-test E2E suite,
realtime ELF placement audit, ESP-IDF build, Kit typecheck, and the 67 focused
provider/architecture/simulator tests pass. The final device snapshot was on
Wi-Fi at -49 dBm and the control protocol/send/receive/error counters remained
zero. It also retained four lifetime `/pcm` TLS transport incidents and two
Wi-Fi disconnects from this boot. Those are a separate conversational-voice
release gate: screen-capture success does not reclassify them, and no acoustic
test was run in the occupied room. The denylisted Waveshare was never opened
or flashed.
