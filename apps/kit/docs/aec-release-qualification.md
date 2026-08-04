# Deterministic AEC release qualification

This is the default release-blocking AEC procedure for StackChan and Home
Assistant Voice Preview Edition (HAVPE). It deliberately does **not** use Grok
to generate or capture qualification audio. A purpose-built Kit process on the
Mac owns the exact fixtures, `/api` Cap'n Web peer, `/pcm` server, recorder,
network monitor, and offline artifacts. The device reaches that same process
through Iterate's authenticated Captun gateway at `tunnels.iterate.com`.

Grok remains a later, independent end-to-end gate for provider lifecycle,
server VAD, self-trigger/self-transcription, interruption, and real
conversation. A good Grok turn cannot qualify DSP, and a deterministic DSP
pass cannot qualify Grok.

## Safety and exact hardware

- HAVPE identity: `D8:3B:DA:46:20:34`.
- StackChan identity: `68:EE:8F:D8:53:20`.
- The Waveshare AMOLED identity `1C:DB:D4:7A:16:C8` is denylisted. Never open
  its serial port, reset it, erase it, or flash it as an AEC substitute.
- Resolve ports through
  [`connected-device-inventory.md`](../firmware/docs/connected-device-inventory.md).
  `/dev/cu.usbmodem*` is only the current transport name.
- Do not run StackChan evidence unless the exact StackChan identity is present.

The default sound profile is intentionally residential-room quiet. Record the
actual Mac volume and target firmware/profile in every artifact. Do not raise
volume merely to make a weak oracle pass. The release matrix itself must still
cover every calibrated target volume from quiet through the highest
non-clipping operational level.

## Build and host checks

From the repository root:

```bash
source /Users/jonastemplestein/esp/esp-idf/export.sh

idf.py \
  -C apps/kit/firmware/targets/home-assistant-voice-preview-edition \
  -B "$PWD/apps/.build/home-assistant-voice-preview-edition" \
  build

idf.py \
  -C apps/kit/firmware/targets/stackchan \
  -B "$PWD/apps/.build/stackchan" \
  build

cmake -S apps/kit/firmware -B apps/.build/kit-host-aec \
  -DCMAKE_BUILD_TYPE=Debug
cmake --build apps/.build/kit-host-aec -j
ctest --test-dir apps/.build/kit-host-aec --output-on-failure

pnpm --dir apps/kit exec vitest run \
  src/device/aec-diagnostic-trace.test.ts \
  src/device/aec-fixture-transport.test.ts \
  src/device/aec-fixture-cli-options.test.ts \
  src/device/aec-release-fixture-bundle.test.ts \
  src/device/aec-release-fixture-plan.test.ts \
  src/device/aec-retained-evidence.test.ts \
  src/device/aec-release-calibration.test.ts \
  src/device/aec-release-matrix.test.ts
pnpm --dir apps/kit typecheck
```

The target map files must show cold trace storage in external RAM. Current
reservations are deliberately finite and link-visible:

- HAVPE: 16,000 samples × two planes × two bytes = 64,000 bytes, plus a
  3,200-byte bounded read scratch.
- StackChan: 16,384 samples × three planes × two bytes = 98,304 bytes, plus a
  5,120-byte bounded read scratch.

No trace queue exists. The realtime audio owner performs bounded copies only
while a generation is armed. Cap'n Web reads frozen data later and cannot
backpressure microphone or speaker work.

Every run manifest also retains the exact application binary byte count and
SHA-256 plus the allowlisted build controls that affect audio behavior. HAVPE
records `ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE`; an A/B image built in a
different directory can therefore never be confused with the ordinary image.

## Calibrate and materialize exact fixture bytes

Qualification begins from a target-specific calibration JSON accepted by
`src/device/aec-release-calibration.ts`. It must identify the exact ROM MAC,
the target's real fixed codec control, three strictly increasing and physically
measured device PCM peak levels (`quiet`, `nominal`,
`maximum-non-clipping`), the rejected clipped candidate or reviewed safety
ceiling, and three strictly increasing Mac output levels (`quiet`, `nominal`,
`loud`). HAVPE records the compiled AIC3204 DAC setting in decibels; StackChan
records its ESP codec volume percentage. Treating those unlike controls as one
percentage would make the calibration look comparable while lying about the
hardware. Every accepted level records zero source, playout, and raw-microphone
clipping. A profile copied between devices or a convenient loud value with no
measured boundary is rejected.

Acquire that calibration through the same authenticated Mac fixture server and
physical session used by the release matrix:

```bash
cd apps/kit

doppler run --project os --config dev -- \
  pnpm aec:calibrate -- \
    --device home-assistant-voice-preview-edition \
    --device-host <CURRENT_HAVPE_LAN_IP> \
    --calibration-output \
      evidence/calibration/havpe-D8-3B-DA-46-20-34.json \
    --output-directory evidence/havpe-aec-calibration-20260804
```

The acquisition exercises ordered device PCM peaks 1,500, 3,000, 6,000,
9,000, and 12,000, then the retained Mac near-end source at 15%, 25%, and 35%
system output volume. It records full-scale sample counts in each available
device trace plane plus the exact fixture sources, `/pcm` lanes, metrics, and
network intervals. A clipped candidate cannot be followed by an accepted
candidate. If the reviewed operational ceiling is reached without clipping,
the JSON says so explicitly; this is a residential test safety boundary, not a
claim to have found the electrical maximum. The command restores the original
Mac output volume and device configuration even on failure.

Before opening a tunnel or flashing temporary credentials, materialize the
complete shared matrix into a new immutable directory:

```bash
cd apps/kit

pnpm aec:fixtures -- \
  --calibration evidence/calibration/havpe-D8-3B-DA-46-20-34.json \
  --run-id havpe-release-20260804-01 \
  --output evidence/fixture-bundles/havpe-release-20260804-01
```

This command synthesizes two independent real-voice sources once: Daniel is
the far-end voice played by the device speaker and Samantha is the near-end
voice played by the Mac. It decodes and hashes their exact PCM, repeats the
near-end PCM into one gap-free WAVE covering the longest near-end phase,
projects every phase from the shared matrix, and writes every far-end PCM
source in full before hardware playback. Speech, double-talk, repeated speech,
and speech lifecycle rows use the retained Daniel source rather than synthetic
noise. Tones, chirps, multi-tone, and impulses remain as deliberately diagnostic
DSP probes; they are not the primary speech oracle. It supports the
matrix's variable response durations—including the ten-minute stability
phase—on one provider connection. Each source is chunk-invariant, checked
and normalized to its exact calibrated PCM peak, and named by phase ID. The
physical controller
must replay these retained bytes; re-running `say` or a signal generator during
acquisition is not equivalent evidence.

The fixture-bundle layout is:

```text
<bundle>/
  fixture-manifest.json
  near/
    synthesized-once.wav
    deterministic-speech.wav
    deterministic-speech.pcm16le
  far-speech/
    synthesized-once.wav
    synthesized-once.pcm16le
  far/
    <phase-id>.pcm16le
```

`fixture-manifest.json` contains the validated calibration, exact phase order,
durations, source parameters/seeds, Mac volume per near phase, byte counts,
measured peaks, source-clipping count, and SHA-256 hashes. Both one-shot `say`
outputs are retained as synthesis provenance. `deterministic-speech.wav` is the
single exact-duration near-end file played by `afplay`, so no process-relaunch
gaps can enter near-only or double-talk evidence. Each far-end speech phase is
an exact peak-normalized projection of the retained Daniel PCM. This matters
because a provider can distinguish convenient noise from speech even when AEC
is absent; release evidence therefore cannot rely on noise classification as a
proxy for echo cancellation. Preparing the bundle performs no USB or network
operation and is safe to repeat with a new output directory. Never overwrite a
bundle already cited by physical evidence.

Before replay, the bundle loader recomputes the canonical shared plan from the
retained calibration, requires all 32 phase IDs in exact order, verifies every
far/near association and exact realized peak, resolves symlinks inside the
bundle, and hashes the selected file. Far sources are loaded one phase at a
time; the ten-minute source does not require retaining the whole bundle in
memory. Provider response numbering is provider-scoped, so an intentional
WebSocket generation change cannot rewind playback to phase zero.

## Resolve the current LAN address

Captun provides the public route, but the harness also needs the device's
current LAN IP for interval-aligned reachability/RTT evidence. First consult a
recent serial boot log or router lease table. A non-disruptive ARP lookup is
also useful after the device has spoken on the LAN:

```bash
arp -an | rg -i 'da:46:20:34'
arp -an | rg -i '8f:d8:53:20'
```

macOS `arp` may omit leading zeroes in individual octets, hence the distinctive
suffix search. Confirm the result against the exact USB identity before any
flash.

## Default Captun run

`CAPTUN_TOKEN` belongs in Doppler shared dev configuration. Do not export it
into shell history or write it into evidence. Use a random tunnel unless a
stable name is explicitly required:

```bash
cd apps/kit

doppler run --project os --config dev -- \
  pnpm aec:physical -- \
    --device home-assistant-voice-preview-edition \
    --device-host <CURRENT_HAVPE_LAN_IP> \
    --fixture-bundle evidence/fixtures/<HAVPE_BUNDLE> \
    --output-directory evidence/havpe-aec-release-matrix-20260804
```

For StackChan, only when exact MAC `68:EE:8F:D8:53:20` is attached:

```bash
cd apps/kit

doppler run --project os --config dev -- \
  pnpm aec:physical -- \
    --device stackchan \
    --device-host <CURRENT_STACKCHAN_LAN_IP> \
    --fixture-bundle evidence/fixtures/<STACKCHAN_BUNDLE> \
    --output-directory evidence/stackchan-aec-release-matrix-20260804
```

The script discovers the matching USB identity, reads and retains the current
device configuration partition, creates a fresh random project ID and project
secret, opens a random Captun URL, and flashes only the temporary configuration
partition. Both `/api` and `/pcm` use that fresh project secret. Possessing or
guessing the public tunnel URL is therefore insufficient to mount or stream.
The exact same `LocalDevicePeerServer.fetch` handler serves Captun and the
explicit direct-LAN fallback; there is no friendlier second fixture server.
Captun terminates the public WebSocket into a Fetch `WebSocketPair`, so no Node
bridge socket exists in that mode. Its terminal PCM evidence therefore comes
from device-observed transport counters plus monotonic recorder byte progress.
Only direct-LAN mode may claim actual Node bridge open/close events. Inventing
empty bridge events for Captun would incorrectly classify a healthy tunneled
run as network-invalid.

Normal completion and ordinary exceptions close the conversation, recorder,
network monitor, Captun connection, and local peer, then restore the original
configuration bytes and reset the device. Do not use `kill -9` or unplug USB
during the temporary configuration interval. If the host is forcibly killed,
re-run the firmware flash with the intended saved credentials before treating
the device as restored.

### Explicit direct-LAN isolation mode

Use this only to separate Captun/gateway behavior from device DSP. It does not
replace the production-shaped tunneled run:

```bash
MAC_LAN_IP="$(ipconfig getifaddr en0)"
test -n "$MAC_LAN_IP"

pnpm aec:physical -- \
  --device home-assistant-voice-preview-edition \
  --direct-lan-host "$MAC_LAN_IP" \
  --direct-lan-port 8789 \
  --device-host <CURRENT_HAVPE_LAN_IP> \
  --fixture-bundle evidence/fixtures/<HAVPE_BUNDLE> \
  --output-directory evidence/havpe-aec-direct-lan-diagnostic
```

Do not publish `0.0.0.0` as the configured device URL. It is a useful bind
address, but not a destination the ESP can dial. Resolve and record the Mac's
current Wi-Fi address as above. Direct LAN still uses the same fresh project
secret and authenticated `/api` plus `/pcm` handler; it is scoped to the local
subnet rather than exposed as an unauthenticated convenience service.

Selecting a LAN port without a LAN host, combining direct LAN with a named
tunnel, omitting `CAPTUN_TOKEN` in tunnel mode, or omitting `--device-host` in
tunnel mode fails before USB mutation.

## Fixtures and matrix

The retained release matrix is defined in
`src/device/aec-release-matrix.ts`; calibration policy is in
`src/device/aec-release-calibration.ts`. The complete qualification must cover:

- ambient/silence at every calibrated volume;
- stationary tones, multi-tone/chirp/sweeps, impulses/transients, retained real
  device-speaker speech, and long nonstationary speech;
- repeated and changing playback;
- near-only, far-only, and true double-talk at multiple relative near/far
  levels;
- start/stop/restart, generation changes, underrun/recovery, and long-duration
  stability.

Every defect becomes a deterministic host/simulator fixture. Never loosen an
oracle to obtain a pass. In particular, intentional harness interruption must
be classified separately from unexplained resets, and StackChan scoring must
respect the firmware's declared selector gain rather than compare incompatible
raw/processed scales.

`aec:fixtures` makes the whole matrix executable data rather than a target-local
phase list. `runAecReleaseMatrixController()` now owns target-independent phase
ordering, lifecycle dispatch, near/far source choreography, minimum monotonic
phase duration, and completion markers; architecture tests fail if a short
device trace or target adapter silently reduces (for example) the ten-minute
stability row to a few seconds. The retained-file-to-provider replay seam is
also implemented and tested. The underrun row carries one manifest-owned 250 ms
source outage after exactly 80,000 samples; recovery resets the source pacer so
it cannot emit a catch-up burst. Provider-generation retirement preserves the
provider-wide fixture index instead of accidentally replaying phase zero.

With `--fixture-bundle`, `aec:physical` now runs the shared 32-phase controller
through the same authenticated Mac server and physical session. It replays one
hash-verified far file at a time, uses the one exact retained near WAVE at the
calibrated Mac volumes, performs the declared conversation/provider/underrun
lifecycle actions, and retains non-overlapping onset/settled/tail device traces
where the phase is long enough. It also retains the complete `/pcm` lanes,
per-second metrics, network intervals, and per-phase media slices. Without
`--fixture-bundle`, the command intentionally retains the seven-phase rapid
diagnostic lane.

Full-matrix acquisition deliberately leaves
`qualification: "acquisition-complete-unscored"` in its immutable manifest.
`aec:score` recognizes that schema-2 manifest, independently reopens and hashes
the retained evidence, and writes the strict completion verdict. This prevents
acquisition success from being confused with AEC success. A measured
calibration JSON and a scored, network-valid physical run are required for each
exact device. Do not cite a complete acquisition, green short run, or
materialized bundle as final AEC acceptance.

The fixture server uses the same production-shaped playout ownership as the
userspace PCM bridge: it requires 32 far-end frames before declaring the source
ready, sends an initial lead of eight frames, and thereafter lets the device
I2S clock request/release frames. The Mac does not run a competing 20 ms
playout clock. A planned source outage must consequently appear as a bounded
device underrun followed by recovery, never as a host-side `setTimeout()`
failure or catch-up burst.

## Artifact layout

Calibration acquisition writes a timestamped run beside the strict JSON. Its
`calibration-acquisition.json` preserves every candidate observation and the
reason the three accepted levels were selected; `manifest.json` labels the run
`calibration-acquisition-only`. Candidate source PCM, device trace planes,
whole `/pcm` lanes, metrics, socket lifecycle, and
`physical-network-validity.json` remain under that timestamped directory. The
strict calibration JSON contains only the validated contract consumed by the
fixture materializer, not the acquisition's incidental diagnostics.

Each run creates an immutable timestamped directory:

```text
<run>/
  manifest.json
  capability-description.json
  physical-network-validity.json
  aec-assessment.json
  aec-offline-assessment.json             # created by `aec:score`
  aec-traces.json
  aec-traces/
    <phase>/
      onset/                              # full matrix; bounded device trace
      settled/                            # when the phase can fit it
      tail/                               # non-overlapping final window
      metadata.json
      raw-microphone.pcm16le
      clean.pcm16le
      electrical-reference.pcm16le       # StackChan only
      completed-dma-playout.pcm16le       # only if genuinely exposed
      linear.pcm16le                      # only if genuinely exposed
      fixture-downlink.pcm16le
      pcm-uplink.pcm16le
  pcm/
    ...complete conversation lanes...
  mac-near-source.wav
  phase-markers.json
  release-phase-markers.json             # full matrix
  release-phase-artifacts.json           # full `/pcm` slices + hashes
  general-metrics.json
  aec-metrics.json
  provider-events.json
```

`manifest.json.firmwareApplication` identifies the exact flashed application
bytes independently of the temporary credential partition. The physical run
must also reference the immutable fixture-bundle manifest and verify each
played phase hash against it once the full-matrix controller is enabled.

`metadata.json` records the wire schema, sample rate, frame/capture geometry,
plane availability bitmask, trace generation, first/last contiguous audio-frame
sequence, completion/abort counts, and read bound. Missing files mean an
unavailable tap. They must never be synthesized as zero PCM or cited as
silence. `aec-traces.json` records byte counts, paths, and SHA-256 hashes.

`fixture-downlink.pcm16le` is the exact server-authored playback interval.
StackChan additionally retains its physical electrical AEC input. HAVPE's XMOS
keeps its private reference internal, so the fixture downlink plus device
playback-completion counters establish stimulus provenance without pretending
to be a same-time electrical reference.

## Repeatable offline scoring

Recompute a retained run without a device, network, provider, or Mac audio
playback:

```bash
cd apps/kit
pnpm aec:score -- evidence/<run-family>/<timestamped-run>
```

The command writes `aec-offline-assessment.json` and exits nonzero for a failed
gate. It hashes every JSON/PCM/WAVE input it consumed. For schema-2 release
evidence it first requires the canonical 32 phases, exact fixture and per-phase
hashes, whole 20 ms `/pcm` frames, target-truthful device planes, contiguous
trace frame sequences, metrics, bounded socket lifecycle, and an independently
composed network verdict. It then scores every retained onset, settled, and tail
window for clipping, far-end challenge energy, settled ERLE/residual echo, and
near-end preservation against the matching retained near-only control. HAVPE
must provide raw and clean planes; StackChan must additionally provide its real
electrical reference. A missing private HAVPE XMOS reference is not invented.

Historical schema-1 seven-phase diagnostics retain their three-lane report:

- `deviceSignal` scores the bounded clean tap captured inside the firmware
  audio owner. It deliberately uses a zero-fault signal-only validity baseline
  so a socket or network failure cannot alter the DSP verdict.
- `pcmTransport` scores the exact clean PCM accepted by the Mac `/pcm` server
  and applies the retained transport/network validity counters.
- `rawMicrophone` applies the same calculations to the pre-DSP microphone as a
  diagnostic A/B. Its overall pass bit is never accepted as AEC evidence: raw
  audio is expected to contain speaker echo.

The acquisition manifest records the exact offset and duration of the
assessment slice within `mac-near-source.wav`. Schema-1 runs produced before
that field use the historical fixed one-second lead and three-second interval.
The offline scorer rejects incomplete traces, mismatched sample rates, odd PCM
lengths, missing phases, and malformed validity instead of guessing.

## Validity and verdicts

Network and DSP validity are independent axes:

- Network validity uses interval-aligned device/router reachability, RTT/loss,
  DNS/connect/socket lifecycle, Wi-Fi RSSI/reconnects, bridge byte progress, and
  device transport counters.
- DSP validity uses raw/reference/clean waveforms, frame continuity, clipping,
  convergence/reconvergence, ERLE/residual echo, near-end preservation,
  distortion/false suppression, resets/drops, and long-run drift.

Bad network classifies the physical interval as network-invalid; it does not
make DSP good or bad by assumption. Healthy network strengthens transport
attribution but cannot substitute for waveform gates. A release pass requires
a separate clean valid run when an otherwise useful physical run was
network-invalid.

The first network-valid HAVPE isolation run is retained at
`evidence/havpe-aec-direct-lan-diagnostic-20260804-final/2026-08-04T08-45-53-466Z`.
Transport was frame-perfect: zero drops, restarts, resets, underruns,
reconnects, or recorder loss. It is **not** an AEC pass. Offline scoring locates
the failure inside the device-clean XMOS output as well as `/pcm`: the
one-second clean trace preserved double-talk at 0.899 similarity and 1.032
gain, but its residual was -5.95 dB against a -6 dB gate and degradation from
the repeat control was 9.02 dB against the fixed 8 dB gate. The three-second
`/pcm` interval measured 9.13 dB degradation. Thresholds were not loosened.

After deterministic AEC qualification, run the real Grok voice acceptance
separately and retain raw provider events/transcriptions. Reject any far-end
self-trigger/self-transcription, missing `conversation.item.truncate` during
physical barge-in, provider lifecycle error, unbounded response delay, or
frame/heap drift.

Provider self-trigger is deliberately absent from
`assessAecReleaseMatrixCompletion()`: the deterministic Mac server has no STT
provider, and adding that semantic dependency would reintroduce generation
variability into the DSP verdict. It is a mandatory result of the later Grok
acceptance, not a field to mark true on every deterministic phase.

## Troubleshooting

- **No mount:** verify Captun token/config, current Wi-Fi, and that the device
  received the temporary URL. A 40-second mount timeout is a failure, not a
  reason to loop forever.
- **`aecTrace` absent:** the device is running old firmware. Rebuild and flash
  the exact target; do not score only aggregate metrics.
- **Trace aborted:** inspect `metadata.json` and transport/audio reset metrics.
  A frame-sequence gap, capture reset, or AEC recreation intentionally freezes
  the generation as failed. Do not retry invisibly.
- **Trace remains armed:** firmware trace geometry does not match the active DSP
  frame size or audio never ran. Target startup now validates geometry; treat a
  regression here as a build/boot defect.
- **HAVPE has no reference file:** expected. Its XMOS does not export the private
  reference. Do not manufacture one.
- **Captun bad, direct LAN clean:** preserve both runs. The direct result helps
  isolate gateway/network behavior but the tunneled network-valid run remains
  required.
- **USB port vanished after reset:** the harness re-enumerates by the exact ROM
  MAC and Espressif VID/PID before every flash/run/restore operation. A supplied
  `--port` is only an assertion about the current mapping. Do not cache or
  substitute a `/dev/cu.usbmodem*` path by hand.
- **Offline clean and `/pcm` disagree:** inspect the hashed inputs and retained
  transport counters. The clean trace is the DSP-local oracle; `/pcm` is the
  production transport oracle. Neither is permission to hide failure in the
  other lane.
- **Choppy/late audio:** first correlate the exact interval with network and
  buffer/reset counters. Healthy network makes the audio pipeline suspect; bad
  network invalidates that interval but does not qualify audio.
- **Fixture bundle already exists:** choose a new run ID/output directory. Do
  not erase or mutate an evidence source which may already be referenced.
- **Fixture peak exceeds calibration:** reject the bundle. This is a generator
  or calibration-contract defect, not permission to clamp the file silently.
- **Matrix completion reports missing phases:** the short diagnostic runner was
  used, or a lifecycle action did not complete. Preserve the partial artifacts
  and rerun only the failed, explicitly identified acquisition after fixing the
  controller; never mark absent phases as skipped/pass.
