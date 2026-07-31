# Kit v2 refactor — exploration brief (2026-07-31)

This folder (`apps/kit/docs/fable-v2-plan/`) is the ONLY writable location for
this planning effort. A separate codex agent is actively implementing v1 in
this worktree: never modify, build, test, or git-mutate anything outside this
folder. Everything else in the repo and in `~/src/github.com/` is read-only
reference.

## LATE ADDENDUM from Jonas (2026-07-31, mid-exploration — binding)

> just FYI we will also have devices that e.g. don't have speaker and mic and
> just an eink screen and some buttons or mic or something. so you just need
> to make sure you don't build yourself in a corner organisationally
>
> where there is audio, it MUST be realtime, resilient, not delayed, good AEC
> etc. but there will be devices without

Consequences every architecture candidate and judge must honor:

- The device matrix is wider than the four voice boards: audio-less devices
  (e-ink + buttons), mic-only devices, speaker-only devices are all real
  future targets. "Has audio" is a per-device capability, not an assumption
  of the core.
- A device with no audio must be buildable/linkable WITHOUT the PCM lane,
  audio controller, processor seam, or PCM transport — and still get the full
  control plane (Cap'n Web, capabilities, events, SD logging, resilience).
- Organizing the entire architecture around the audio dataflow is now an
  explicit organizational risk to weigh (this directly challenges candidate B
  and partially supports A/C); conversely, where audio IS present, nothing
  about the generality may compromise realtime discipline, resilience, or AEC
  quality. Both halves are hard requirements.
- Event core, hardware plugability, and testing layers should treat
  buttons/screen/e-ink-only devices as first-class citizens (e.g. a
  layer-2 rig scenario with no acoustics at all).

## The assignment (verbatim from Jonas)

Use dynamic workflows to come up with a refactor that

1. reduces the amount of code and complexity overall
2. makes everything easier to test and reason about
3. follows best practices taken from other hand-rolled and reference
   implementations everywhere (but allowing for the possibility of ours
   already being better)
4. has clean pluggable APIs for hardware differences to be contained in while
   sharing most code (configurable though so you can add more permissive …)
5. adds a new feature to (if present) write logs to an SD card (in case we are
   not listening)
6. keeps the best things we have done
7. focuses on three layers of testing: 1) super fast host-side unit tests 2) tests on the device with a testing rig where the device is next to the
   computer speaker that is running the tests 3) human-in-the-loop tests with
   physical buttons etc
8. we want to start laying the groundwork for eventually representing these
   devices as "streams" in the github.com/iterate/iterate apps/os sense —
   where the device receives and emits events for button presses etc. Our
   /pcm userspace endpoint would also cross-post to that stream with
   transcription, speak start/end, etc events. Just not the latency-sensitive
   PCM (for now). Ideally the on-device data structure would also be expressed
   in terms of events shaped like that with path, type, payload etc from the
   earliest moments — these could be logged on SD card etc
9. allow for server-side AEC
10. degrade / recover gracefully under failure conditions — the devices must
    attempt to maintain the two websocket connections at all times
11. we cannot afford to have a Grok realtime voice session on at all times —
    so the config worker userspace server side might after some inactivity
    hang up — but the PCM frames keep coming (for now)
12. the pluggable device I/O (lights, screen, etc) on-device

Additional context from Jonas: the deliverable is a detailed implementation
plan, continuously reviewed and validated on this host machine without
interfering with the codex agent writing v1. Process: one big wide exploration
round first (many possibilities, code examples, specific facts/data, stolen
code bits welcome), then extensive high-order organizational questions to
Jonas, then condensation into a small coherent plan. `iterate/stackchan`
(~/src/github.com/iterate/stackchan) may hold voice-pipeline inspiration but
"seems to get worse over time so maybe not such a good example".

## Canonical references (read before your task)

- `inputs/codex-v1-goal.txt` — the original goal given to the v1
  implementation agent.
- `../physical-device-voice-goal.md` — the authoritative goal document
  (settled decisions: PCM v1 wire shape 640 B/20 ms/16 kHz mono S16LE, dual
  websockets, StackChan = duplex+VAD+AEC vs M5StickS3 = half-duplex PTT,
  portable allocation-free C core, bounded-everything, proof ladder,
  observability core/outer split). Consider it always.
- `../fable-firmware-architecture-review-2026-07-31.md` — the fresh
  architecture review of v1 + prior art, with recommendations R1–R13.
- `inputs/agent-reports/` — the six raw deep-read reports behind that review:
  `firmware-core.md`, `firmware-audio.md`, `host-pipeline.md`, `xiaozhi.md`,
  `esphome-intercom.md`, `espressif-prior-art.md`.

## Prior-art clones (read-only)

`~/src/github.com/`: `78/xiaozhi-esp32`, `n-IA-hane/esphome-intercom` +
`esphome-audio-stack` + `esphome-voip-stack`, `espressif/{esp-adf,esp-sr,
esp-idf,esp-dsp,esp-skainet}`, `seekaudio/seekaudio_aec_test`,
`iterate/stackchan`.

## Hard constraints carried over from the goal doc

- Wire v1 stays: mono S16LE 16 kHz, 20 ms/640 B frames, dual sockets
  (`/api` Cap'n Web + `/pcm` binary), zero-length EOS.
- Portable, allocation-free after boot, bounded queues with metrics, audio is
  top-priority realtime work; Cap'n Web/metrics/display are bounded
  background work.
- Grok model pinned `grok-voice-think-fast-2.0`; long-lived provider secret
  never reaches the device.
- Four boards on the hub: M5StickS3, StackChan, Home Assistant Voice Preview
  Edition, Waveshare ESP32-S3 AMOLED Touch. ESPHome devices should ultimately
  share an ESPHome adapter.
- IRAM currently 1 byte free on the Stick image; audio path currently uses no
  PSRAM; AFE FD_LOW_COST needs ~31–60 KB internal + 90–780 KB PSRAM + ~20 %
  of one core.
