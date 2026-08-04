# Shared `/pcm` session lifecycle — 2026-08-04

## Acceptance status

The firmware now has one ESP-IDF owner for `/pcm` connection lifetime,
credential prewarming, control-generation restarts, bounded transport recovery,
and conversation media gating. M5StickS3, StackChan, and Home Assistant Voice
Preview Edition call that owner instead of maintaining target-local variants.

This is **not yet a claim of complete three-device physical acceptance**. The
newest binaries containing the final callback-owned media gate were freshly
flashed to M5StickS3 and HAVPE and both completed real production Grok paths,
but the current intervals did not pass every independent validity gate:

- M5StickS3 had exact digital accounting and matching provider/Mac-microphone
  transcripts. One run was network-invalid; a clean-network repeat was
  audio-invalid because its relative acoustic-energy gate was missed.
- HAVPE completed an ordinary response and physical interruption twice, with
  green AEC and acoustic checks, but both intervals were network-invalid due to
  router RTT.
- StackChan's exact board was absent from USB. Its final firmware builds and
  passes link/realtime audits, but it still requires flashing and physical
  voice/latency validation on MAC `68:EE:8F:D8:53:20`.

Older network-valid physical artifacts below remain valuable regression
history, but are not silently promoted to acceptance for the newer binary.

## Ownership and invariants

The owner lives in:

- `firmware/platforms/iterate_esp_idf/pcm_session.c`
- `firmware/platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_session.h`

The raw transport's start/poll/restart/stop declarations now live in the
platform-private `firmware/platforms/iterate_esp_idf/pcm_transport_lifecycle.h`.
They are absent from the public component include tree. Consequently a target
cannot hide a bypass behind a newly named wrapper: direct lifecycle use fails
to compile, and the architecture test also rejects importing that private
header from any voice target.

It enforces these invariants:

1. An authenticated, mounted Cap'n Web control generation prewarms `/pcm`
   before a conversation begins.
2. Media may flow only when control is ready, the conversation is active, and
   the raw transport is ready.
3. A control remount closes the media gate immediately and causes exactly one
   raw `/pcm` generation restart. Targets cannot perform a second restart.
4. Once started, the raw transport owns its bounded network reconnect policy;
   the session owner does not replay task creation on ordinary socket loss.
5. A local task-start failure remains a visible failure and is not hidden by a
   later poll or turned into a hot retry loop.
6. Target code supplies only hardware/conversation hooks. StackChan and HAVPE
   provide their full-duplex audio-intent hook; Stick provides its manual-turn
   state cleanup hook. None owns transport lifetime.

The architecture test rejects target source that calls the raw transport
start/poll/restart/stop functions, imports the private lifecycle header,
reintroduces the deleted local lifecycle flags/reconcilers, passes a target
conversation decision into `pcm_session_poll`, or writes the hardware media
gate from more than the one registered session callback.

## Regression proof

- Host CMake/CTest: 89/89 tests passed.
- Full Kit Vitest: 774 tests passed; one intentional live test skipped.
- Kit typecheck passed.
- M5StickS3 firmware built: app `0x12ed70`; 41% app partition free; realtime
  ELF audit passed.
- StackChan firmware built: app `0x13aae0`; 75% free; BSP selection and
  realtime ELF audits passed.
- HAVPE firmware built: app `0x108ae0`; 79% free.

The lifecycle behavior suite covers prewarm, conversation-only media gating,
one restart per control remount, immediate gate closure on control loss,
transport-owned reconnect, persistent task-start failure, missing hardware
hooks, a failed media-gate sink, and generation loss. The shared M5 audio-owner
suite also proves that losing the gate during PTT rejects the intervening frame
and closes capture on the next bounded audio poll without a retry/drop storm.

Three defects discovered during extraction are pinned as regressions: control
loss while the raw socket remained alive incorrectly left media enabled;
task-start failure appeared recovered on the next poll; and a target could
superficially use the shared poll while retaining a second hardware-gate write.
All now fail against the old boundary and pass against the shared owner.

## Fresh exact-device evidence for the newest shared owner

### M5StickS3 `70:04:1D:D5:45:88`

The exact device was freshly flashed with app image `0x12ed70` and completed
three remotely driven PTT turns through the production userspace `/pcm` worker
and real Grok. Credential readiness preceded conversation start by 26,697 ms;
provider WebSocket open and ready followed conversation start by 471 ms and
670 ms. Capture/uplink was 1,798/1,798 frames and downlink
accepted/submitted/completed was 468/468/468. Audio, protocol, control, PCM,
playback, and Wi-Fi failure/drop/disconnect deltas were zero; uplink high-water
was one frame. The run is correctly rejected as network-invalid because one
aligned device/router/worker RTT sample was 115.414/114.873/113.477 ms:

`evidence/m5sticks3-unified-pcm-session-20260804/2026-08-04T07-30-11-446Z/iterate-kit-acoustic-ipBsBR/manifest.json`

A short repeat after a clean 12-ping baseline again had exact accounting
(811/811 uplink and 164/164/164 downlink), zero transport failures, and exact
provider/Mac-microphone transcript agreement: “The Game Boy face is active and
the zebra is awake.” Its network probes were clean, but the independent
acoustic oracle rejected the interval: response/ambient maximum RMS was
1.948x against 2.5x and no causal window exceeded the relative threshold. The
gate was not loosened:

`evidence/m5sticks3-unified-pcm-session-valid-20260804/2026-08-04T07-34-30-718Z/iterate-kit-acoustic-Wmwd2n/manifest.json`

### HAVPE `D8:3B:DA:46:20:34`

The exact device was freshly flashed with app image `0x108ae0`. Two production
Grok runs each completed the ordinary spoken response and a physical barge-in.
The stronger repeat had 1,969 uplink and 645 downlink frames, 28.037 dB
gain-normalized AEC suppression, 1,951/1,951 capture/clean frames, and zero
capture/drop/measurement/write/queue/policy/reset/underrun/stale failures.
Worst capture-to-uplink was 101 us, playback write 9,987 us, and
receive-to-render 311 ms. Independent acoustic transcription was exact with a
32.14x response/ambient ratio. It remains rejected because the aligned router
RTT reached 95.164 ms and worker RTT 103.608 ms:

`evidence/havpe-unified-pcm-session-valid-20260804/2026-08-04T07-36-33-909Z/failure.json`

The preceding run independently measured 24.58 dB AEC suppression and exact
acoustic transcription but was also network-invalid:

`evidence/havpe-unified-pcm-session-20260804/2026-08-04T07-32-24-901Z/failure.json`

## Earlier exact-device regression evidence

### HAVPE — prior network-valid binary

Evidence:
`evidence/home-assistant-voice-preview-edition-shared-pcm-session-final-20260804/2026-08-04T06-12-02-765Z/manifest.json`

- Exact MAC: `D8:3B:DA:46:20:34`
- Production worker: `kit--kit-havpe-voice-e2e-20260802.iterate.app`
- Credential prewarm: 17,253 ms before conversation
- Provider WebSocket open: 426 ms after conversation start
- Provider ready: 620 ms
- Network classification: valid
- AEC suppression: 24.075 dB gain-normalized
- Capture/uplink: 1,901/1,901 frames, zero drops
- Playback underruns and write/queue/policy/reset failures: zero
- Worst capture-to-uplink: 105 us
- Worst playback write: 10,164 us
- Worst receive-to-render: 311 ms
- Grok and interruption transcripts were retained with contiguous provider
  event sequence 1–89.

### M5StickS3 — prior network-valid binary

Accepted evidence:
`evidence/m5sticks3-shared-pcm-session-network-valid-20260804/2026-08-04T07-02-43-036Z/iterate-kit-acoustic-wNxuA7/manifest.json`

- Exact MAC: `70:04:1D:D5:45:88`
- Recreated production project: `prj_bd8785e119fe4f1d8631bb95e1dea748`
- Production worker: `kit--kit-stick-voice-e2e-20260731.iterate.app`
- Credential ready: 22,502 ms before conversation
- Provider WebSocket open: 441 ms after conversation start
- Provider ready: 641 ms after conversation start
- Uplink captured/sent: 817/817 frames
- Downlink accepted/submitted/completed: 148/148/148 frames
- Audio, uplink, downlink, playback, protocol, control, PCM, and Wi-Fi failure
  deltas: zero
- Maximum uplink application depth: one frame; terminal depth: zero
- The real Grok tool call changed the physical sprite set to
  `gameboy-fine-black`, then the audible provider and independent Mac-microphone
  transcripts both normalized exactly to: “The Game Boy face is active and the
  zebra is awake.”
- Network classification: valid
- The same authenticated PCM session was observed `warm_idle` before the
  remotely started PTT conversation and returned to `warm_idle` after it.

Earlier evidence retained for comparison:

Evidence:
`evidence/m5sticks3-shared-pcm-session-final-20260804/2026-08-04T06-13-35-778Z/iterate-kit-acoustic-CKaKIf/manifest.json`

- Exact MAC: `70:04:1D:D5:45:88`
- Production worker: `kit--kit-stick-voice-e2e-20260731.iterate.app`
- Credential prewarm: 24,640 ms before conversation
- Provider WebSocket open: 478 ms
- Provider ready: 685 ms
- Uplink captured/sent: 819/819 frames
- Downlink accepted/submitted/completed: 164/164/164 frames
- Audio/uplink/downlink drops or failures: zero
- Uplink/control/PCM restarts, disconnects, or errors: zero
- Wi-Fi disconnect delta: zero
- Provider and Mac acoustic transcript both normalized exactly to: “The Game
  Boy face is active and the zebra is awake.”
- Network classification: invalid solely because one worker RTT was 104.416 ms
  against the 100 ms validity threshold.

The combined config-read/flash wrapper reset the Stick and then attempted to
open its temporarily vanished USB node. Re-resolving the exact ROM MAC and
using the standard ESP-IDF flash path succeeded. This is a harness
re-enumeration defect, not evidence of a firmware lifecycle failure. The
wrapper no longer has a remembered Stick serial-port default: every destructive
read/flash transaction must now receive a freshly resolved `/dev/cu.*` path;
the stable ROM MAC remains retained in provenance.

A longer corrected 1..100 run on the same device retained exact independent
provider and Mac-microphone ledgers, 725/725 capture/uplink frames and
3,492/3,492/3,492 accepted/submitted/completed downlink frames, with zero
drops, underruns, resets, faults, or disconnects. It remains rejected solely
as network-invalid because the interval contained router RTTs of 90.555 and
96.720 ms and a worker RTT of 102.851 ms:
`evidence/m5sticks3-count-to-100-overlap-oracle-20260804/2026-08-04T06-34-59-290Z/iterate-kit-acoustic-edcWut/manifest.json`.

A fresh 1..100 run after the final production-project reprovision again
normalized exactly to 1 through 100 in both the provider and Mac-microphone
ledgers, with 720/720 capture/uplink frames and
3,368/3,368/3,368 accepted/submitted/completed downlink frames. It was rejected
solely because router RTT reached 72.474 ms against the 50 ms gate; that run's
own manifest remains authoritative and no metric is borrowed into the accepted
run:
`evidence/m5sticks3-shared-pcm-session-clean-network-20260804/2026-08-04T06-59-21-233Z/iterate-kit-acoustic-oY081L/manifest.json`.

During cold validation the worker hostname had survived a production project
recreation, while the device still carried the deleted project's ID and key.
Cloudflare traces classified every `/pcm` upgrade as `client_error` and showed
the hostname resolving to `prj_bd8785e119fe4f1d8631bb95e1dea748` while the
device presented `prj_65441737530642949cadaf7fe399368b`. Reprovisioning the
exact Stick with the current project's credential fixed the lane immediately.
This was a deployment-identity mismatch, not a transport retry or shared-owner
failure; the failed interval is retained at
`evidence/m5sticks3-shared-pcm-session-clean-network-20260804/2026-08-04T06-54-20-002Z/failure.json`.

### HAVPE — fresh-flash confirmation retained, network-invalid

The final binary was freshly flashed to exact MAC `D8:3B:DA:46:20:34` and then
completed both a real Grok response and a physical barge-in proof through the
shared owner. That new interval was correctly rejected because router RTT
reached 79.747 ms and 64.823 ms against the 50 ms gate:
`evidence/havpe-shared-pcm-session-network-valid-20260804/2026-08-04T07-04-19-525Z/failure.json`.

It does not replace or weaken the earlier network-valid HAVPE acceptance above.

## Remaining gate

1. Obtain one network-valid and acoustically valid interval on each freshly
   flashed attached device. The current firmware functioned physically; the
   independent oracle classifications above remain authoritative.
2. When StackChan MAC `68:EE:8F:D8:53:20` is physically present, resolve it by
   ROM MAC, flash the already-green final build, and run the same production
   conversation/latency/network-attribution proof.

Do not substitute the adjacent Waveshare AMOLED device
(`1C:DB:D4:7A:16:C8`) for StackChan or flash it.
