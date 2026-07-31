# Kit v2 implementation plan

Status: **version 1.2, 2026-07-31 (evening)**. Changelog v1.1 → v1.2: the
codex-alignment pass — every drifted fact about codex's v1 tree corrected
against the evening recon (`exploration/codex-v1-alignment-firmware.md`,
`exploration/codex-v1-alignment-host.md`,
`exploration/test-dependency-ladder.md`) and the test-dependency ladder
added to §5; full record in DECISIONS §8. Every major design point is
settled; this document states only the current plan, in the present tense. How each
decision was reached, what it replaced, and every correction of record live
in [`DECISIONS.md`](DECISIONS.md). The remaining open items — none of them
architectural — live in [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md).

Naming rule for all new v2 code: identifiers say what the thing is in normal
words, even if long. No coined nouns, no framework words.

Ground rules: the codex agent's v1 work, its builds, and the physical devices
are untouchable except at the named checkpoints in §4. The PCM wire format v1
(mono 16-bit 16 kHz, 20 ms / 640-byte frames, two websockets, empty-message
end-of-stream) stays exactly as it is; v2 additions are negotiated beside it
and invisible to v1 peers. Where a device has audio, audio is realtime,
resilient, and echo-cancellation-grade. Devices with no audio (e-ink +
buttons) are first-class and must build with no audio code linked in;
partial-audio devices (mic-only, speaker-only) are equally first-class and
link only the audio halves they have.

## 1. The architecture in one page

Keep v1's structure and its careful migration habits. Add two new interfaces
on the audio side — one for the audio hardware (microphone + speaker) and one
for audio processing (echo cancellation and similar, later) — both
non-blocking so they can be tested on the host as plain function calls. Store
and transmit every piece of non-audio data (button presses, lifecycle,
connection changes, diagnostics incidents) as an **event record** in the same
shape apps/os streams use, from the moment the device boots. Write those same
event records to SD card where a card exists. Keep the four delivery
mechanisms (event stream, metrics subscription, diagnostics pump, and the new
SD writer) separate for now; merging them is milestone v2.1 with a defined
trigger (D6). Raw PCM audio never becomes events; it keeps its dedicated fast
path.

The media transport is two always-connected WebSockets — the same design v1
ships and the goal document settled: `/api` (Cap'n Web control) and `/pcm`
(raw PCM frames, mono S16LE 16 kHz, 20 ms / 640-byte frames). The device
maintains both connections at all times (requirement 10). Media is strictly
on-demand at the frame and provider level: PCM flows only during an active
conversation, started and stopped over the control plane by either side
(D8); "inactive" means no frames flow and no Grok session exists — never
that a socket closes. A person uses every board the same way — press the
button to call the assistant, talk naturally, press again to hang up (§2).

### Vocabulary (used consistently everywhere)

- **Control plane** — the `/api` Cap'n Web WebSocket, terminating on a
  stateless worker. Always connected. It carries remote capability calls in
  both directions, and media start/stop signaling.
- **PCM socket** — the `/pcm` WebSocket carrying raw PCM frames (the v1 wire
  format, unchanged). Always connected; frames flow only during a
  conversation. Bit-transparent: what the device sends is what the server
  sees, byte for byte, and vice versa — the chip-exact acoustic oracles rest
  on this.
- **Media session** — the per-conversation provider leg: the worker
  invocation terminating the `/pcm` socket dials the provider when a
  conversation starts and hangs up when it ends. No per-device server state
  outlives a conversation.
- **Stage 0–5** — the numbered work plan. **v2.1** — the trigger-driven
  merge milestone.

### Target component layout

```
vendor/capnweb            kept; also carries the expression-array getter and
                          the flattened-path call envelope (stage 0
                          re-derives the dead-surface list before deleting)
components/core           control plane only; no audio anywhere in it
  itx_mount / itx_connection / peer
  websocket_tx / websocket_rx / frame_writer, spsc_ring, retry_gate
  configuration             + new fields: per-device id, boot counter
  atomic.h                  already exists; the remaining hand-rolled
                            copies (spsc_ring.c at least) migrate into it
  device_events             widened: the 64-byte event record (D4)
  event_types.def           ONE table file listing every event type and every
                            metric field; code generation produces the C enums,
                            the packing/unpacking code, the TypeScript parsers,
                            the SD dictionary, and test fixtures from it
  event_relay               the one audited module that carries events from
                            interrupt handlers / other cores to the owner task
  event_sd_log              SD-card writer, portable part (no hardware in it)
  device_profile.h          per-board settings as plain data (stage 3)
  runtime_diagnostics       kept as-is for v2.0; merge candidate later
components/audio            only linked on boards that have audio
  pcm_websocket / pcm_lane / uplink conductor + sender
                            moved over VERBATIM (no peer-delivery guard
                            exists — a PONG is never delivery credit; §2)
  audio_codec.h             the audio-hardware interface: capture + playback +
                            properties (duplex? reference channel for echo
                            cancellation? input already echo-cancelled? gain
                            ceiling? owns the sample clock?)
  audio_processor.h         the audio-processing interface: AEC/VAD/etc.
  processors/               do-nothing + test-fake implementations now;
                            real esp-sr AEC arrives with StackChan
  audio controller          v1 logic, with its capnweb include removed
components/capabilities     same mechanism as v1
  device_event_stream       codex's finished delivery machine, generalized
                            in place: any event type, the same five
                            delivery invariants (stage 4)
  metrics                   the sampler survives; its three hand-written
                            schema copies are replaced by generated code
  call_control              connect / hangUp / setMuted (§2); replaces v1's
                            push_to_talk capability
  camera / leds / servos / screen / callback_budget   verbatim
components/analysis         deferred until StackChan; then the stackchan
                            40-byte face-render record is adopted verbatim
devices/<board>/            composition roots + per-board profile data
platforms/iterate_esp_idf   itx_transport slims down: Wi-Fi handling moves to
                            a new wifi_station.c built on retry_gate;
                            pcm_transport gets the reconnect fixes (stage 2);
                            m5sticks3_codec.c implements the audio-hardware
                            interface (capture moves to the audio task);
                            sd_card_block_store.c lands with Waveshare
platforms/common            the proven speaker/playback code stays UNTOUCHED
                            until Waveshare gives the codec interface its
                            second user (D2)
targets/<board>/main        main.cpp shrinks toward ≈700 lines (moving
                            baseline 1,347; re-count at the G2 checkpoint)
host                        stateless control worker (the control plane +
                            start/stop signaling) + the /pcm worker holding
                            the always-connected PCM socket and the
                            per-conversation media session (D8), built as
                            ONE media-session module shared by the deployed
                            worker and the local test servers (§5 ladder); a
                            bounded outbox that posts events to the project
                            stream; a stream processor for kit devices
                            (lives in userspace — zero apps/os changes);
                            device-e2e.ts re-frozen at the G2 checkpoint
                            with new test scenarios as sibling scripts; the
                            manual test checklist script; a CLI that reads
                            SD cards
```

## 2. The call model — how a person uses the device

Settled by Jonas 2026-07-31 (G18 in [`DECISIONS.md`](DECISIONS.md)). One
interaction model on every board:

- **The button connects; the button hangs up.** Pressing the button starts a
  conversation with the assistant — like calling a secretary. Pressing again
  ends it. Conversation start and end are the media start/stop transitions of
  D8, signaled over the control plane.
- **The provider's server VAD does all turn-taking**, on every board (VAD =
  voice activity detection; "server VAD" means the provider endpoints each
  utterance from the audio itself). Every xAI session runs with
  `turn_detection: server_vad`; the manual-commit path
  (`turn_detection: null`) is dead in v2 and is deleted with the rest of the
  v1 push-to-talk support once v2 firmware is the deployed fleet.
- **Mute is a separate function**: a device-local uplink gate — instantly
  reversible, no server round-trip — with its state always visible on the
  avatar/LED. It exists so the user can talk to people in the room mid-call.
- **Interrupting the assistant**: on boards with echo cancellation
  (StackChan class) the user just speaks — the mic stays open, server VAD
  detects the barge-in. On boards without it (the Stick) interruption is a
  button tap; there is no voice barge-in on the Stick unless server-side
  echo cancellation proves out (G5, open).
- **Echo control without on-device AEC**: the media session suppresses the
  uplink while assistant audio is in flight ("speak-state gating", ~30 lines
  server-side). On the half-duplex Stick the mic/speaker hardware switchover
  enforces the same thing locally; the mic re-arms from the control-plane
  speak-end signal plus local playback-ring drain.
- **Hot-mic privacy** is handled by the visible listening state, the
  silence auto-hangup (the warmth policy in D8), and mute.
- **Device events** (requirement 8): connect, hang-up, mute-toggle, and
  interrupt-tap are ordinary event records, replacing v1's press/release
  vocabulary.
- **Push-to-talk is not built in v2.** v1's proven PTT code is historical.
  Nothing forecloses re-adding PTT later as a per-device profile mode (the
  control plane can carry press/release and the provider supports
  `turn_detection: null`), but it is out of scope.

What this model deletes outright: manual turn commits, the commit race
between the control message and the last audio frames, the tail-delivery
guard, and the in-band end-of-turn frame (D7). Turn boundaries are the
server VAD's job everywhere.

Standing rule (matches codex v1, which deleted its peer-delivery guard on
exactly this ground): a hop-level control reply — a WebSocket PONG above
all — is never end-to-end delivery credit. Freshness and liveness are
judged from observable local facts (capture age, per-frame send duration,
byte progress, generation purge) plus application-level signals, on device
and server alike. Nothing reintroduces a ping-credit scheme — not for PCM,
not for the D8 media lifecycle.

## 3. The eight decisions this plan stands on (D1–D8)

Stated here as settled facts; dates, provenance, and superseded designs are
in [`DECISIONS.md`](DECISIONS.md). Evidence and confidence notes:
`exploration/synthesis-and-open-questions.md` §2.2.

- **D1 — The audio-hardware interface never blocks.** Callers ask "what
  happened since I last asked" and get an answer immediately. This keeps
  host tests plain function calls, works inside ESPHome's cooperative loop,
  and avoids the hole a blocking design has on half-duplex boards (a
  mic/speaker mode switch would sit out a read timeout). Cost: each board's
  implementation builds its own small waiting loop internally (~100 lines
  per board).
- **D2 — Capture moves now; playback moves later.** Microphone capture moves
  behind the new interface immediately (it also moves off the starved main
  task — the v1 review's top defect). The proven speaker/playback stack
  (~3,600 lines incl. tests, physically validated) keeps its exact call
  structure until the Waveshare board becomes its second user; the move is
  then gated on byte-identical output in the tone and PRBS tests.
- **D3 — The audio-processing interface ships now, implementations later.**
  The interface: report your required frame size; a revision counter that
  bumps when it changes; process(mic, reference) → output. Written into the
  contract from day one: if the processor can't run, output silence — never
  raw microphone; the echo-cancellation reference must be built only from
  complete frames; the reference ring resets whenever a capture session
  starts or ends; and the pipeline (not the processor) converts between the
  wire's 320-sample frames and the 512-sample frames esp-sr actually wants.
  These rules are all paid-for lessons from the prior-art study; putting
  them in the contract text now costs nothing and prevents redesign during
  StackChan bring-up.
- **D4 — One 64-byte event record, one generated schema.** Fields: event
  type (16-bit id into a generated table), 40-byte payload, sequence number,
  boot counter, timestamp, delivery status. One table file
  (`event_types.def`) generates every reader and writer (C, TypeScript, SD
  dictionary, fixtures). This kills the current situation where the metrics
  schema is hand-spelled in about seven places (~2,260 lines removed).
- **D5 — Event shapes on the wire are copied from apps/os exactly.** The
  serializer emits the `StreamEventInput` shape field-for-field (verified
  against `packages/iterate/src/processors/schemas.ts`). Device identity
  goes in `metadata.device`, never in `source` (platform-reserved). The
  record has no `path` field — one device = one stream
  (`/kit/devices/<deviceId>`); path is assigned when the platform commits
  the event. The idempotency key is
  `kit-device:<deviceId>:<bootCounter>:<sequence>`, so retries from
  anywhere collapse to exactly-once on the stream. Prerequisite this
  surfaces: devices need a unique id (from the chip's MAC, written at
  provisioning time) — today two Sticks on one project collide.
- **D6 — Keep the four delivery mechanisms for now; merge at a trigger.**
  Codex's `device_event_stream` is written, wired, and tested (still
  uncommitted); we generalize that machine in place instead of replacing
  it. The merge down to one delivery
  mechanism is milestone v2.1 and starts when either (a) the third
  bug/feature has to be fixed in more than one of the four mechanisms, or
  (b) codex's event work has landed and stabilized — whichever comes first.
  Before anything is deleted, old and new run side-by-side on the rig and
  their event logs are diffed. Standing rules for ALL event code: every
  ring has exactly one writing task and exactly one draining task (no
  cross-task readers of ring slots); every IRAM byte is a DIRAM byte, so
  every addition is an entry in the DIRAM ledger next to the 31–60 KB AEC
  reservation. (IRAM/DIRAM = the ESP32's instruction RAM, which comes out
  of the same physical pool as data RAM. Real budget: 142,465 B static free
  / ~77.8 KiB runtime heap, measured before the shared 8 KiB TLS-owner
  task stacks added ~7.2 KiB static — re-measure at the G2 checkpoint; see
  `exploration/contention-knobs.md`.)
- **D7 — PCM wire v2: an optional 16-byte frame header for timestamp
  echo.** Layout (taken from xiaozhi's proven protocol v2): version, frame
  type, reserved, timestamp in ms, payload length — all little-endian.
  Negotiated via the websocket subprotocol; v1 peers never see it. Its one
  job: the device tags each mic frame with the timestamp of the speaker
  audio playing at that moment ("timestamp echo") — the groundwork any
  server-side echo cancellation needs, measurable on the rig. The PCM
  socket is bit-transparent, so the server already holds the exact downlink
  waveform it sent; timestamp echo is the missing alignment piece. The
  header carries no end-of-turn frame — no manual commits exist anywhere
  (§2). A few dozen lines of firmware and worker code.
- **D8 — Both sockets always connected; media strictly on demand.** The
  device maintains the control plane and the PCM socket at all times
  (requirement 10). "On demand" is about what flows, not what is
  connected: when no conversation is active, NO media flows anywhere — no
  PCM frames, no Grok session.
  - **Connections are permanent; frames are not.** "Start media now" /
    "stop media" are ordinary messages on the control plane. It terminates
    on a stateless worker: no per-device server state is held between
    messages, and a reconnect landing anywhere is fine.
  - **Media lifecycle**: a conversation is started by the device (the
    connect button) or by the server (the control-plane "start now" push —
    which doubles as anticipatory pre-warm when the server knows speech is
    imminent, e.g. an agent about to talk). Either side may declare
    inactivity; teardown ends the provider socket and stops the frames —
    the two device sockets stay connected. Every start/stop/inactivity
    transition is an event (requirement 8).
  - **The media session is per-conversation**: the worker invocation
    terminating the `/pcm` socket dials the provider when a conversation
    starts, so the provider socket lives and dies with the conversation,
    never with the device connection. Nothing on the server side outlives
    a conversation.
  - **What replaces held server state**: the mic preroll lives ON-DEVICE —
    at connect the device captures immediately into its own ~2 s ring and
    bursts once the provider is up, so dial latency delays the response but
    loses nothing. Conversation memory across teardowns comes from the
    project stream's own cross-posted transcript events (requirement 8
    paying for itself) plus xAI's 30-minute session-resumption cache.
    In-conversation timers (idle detection, ~25-min rotation under xAI's
    30-min session cap) are plain in-invocation timers — nothing outlives
    the conversation, so no durable alarms.
  - **The critical number is cold start**: connect → provider ready
    (secret mint + Grok dial + `session.updated`), prior estimate
    300–850 ms — the cold-dial benchmark (OPEN-QUESTIONS §3) measures it.
    The device preroll makes it a delay, not a loss; the server-initiated
    pre-warm is the lever if it measures too slow.
  - **Warmth is a pluggable policy, not a constant.** Three independently
    tunable policies, deliberately not entangled: (1) **media warmth** —
    how long the provider leg outlives the last activity, a function of
    cost ($/min), battery, and context signals (recent-use half-life,
    presence hints, schedule) that the SERVER evaluates and drives via the
    control-plane pre-warm/stop push, so smarter heuristics never need
    firmware changes; (2) **provider-session policy** — Grok's 30-min cap,
    rotation point, per-minute cost, owned by the media session;
    (3) **conversation state** — what the user perceives as "talking to the
    secretary", owned by the call model (§2). Each policy gets its own
    knobs in the stage-3 profile/config surface; v2.0 ships dumb defaults
    (fixed idle windows) with the seams in place.
  - What the deployed worker already has (matches codex v1): ephemeral
    secret minting; the device-connection/provider-session split — a
    provider generation attaches and detaches without touching the device
    socket; the commit-ack fence on the dying manual path. What is new v2
    work: dial on conversation start instead of inside the device's
    WebSocket upgrade (today a dial failure 502-rejects the upgrade), dial
    on uplink demand, the idle hangup, awaiting `session.updated` before
    the uplink is live (today `session.update` is fire-and-forget), and a
    clean device end-of-stream on provider death (today the device is left
    mid-response). Correction of record: DECISIONS §5.5/§8.

## 4. The work plan

### Dependencies and checkpoints, stated once

- Every stage ends with the physical tone-playback proof green — an
  invariant, not a milestone.
- "Codex checkpoint" means the specific commit Jonas names (G2); until it
  exists, only work that cannot collide with codex proceeds.
- Stage 0: now; cannot collide. Stage 1: low collision risk. Stage 2: needs
  a codex-quiet window Jonas declares. Stage 3: gated on the named codex
  checkpoint. Stage 4: low firmware / medium worker collision. Stage 5:
  after the v2.0 core.
- v2.1: trigger defined in D6.

Standing cadence: before each stage opens, re-run the read-only checks
(codex collision watch via git status, bug liveness, line counts); every
physical incident either joins the warts list (§8) or becomes a rig
scenario.

### Stage 0 — deletions and live bug fixes

Delete verified-dead code (`bounded_playback.hpp` −772 lines; the unused
half of `websocket_text` −480; unused capnweb surface only after
re-deriving the dead list — the vendor now carries the expression-array
getter and the flattened-path envelope, so the old −350 count is void).
Migrate the remaining hand-rolled atomics copies into the already-tracked
`atomic.h` (`spsc_ring.c` at least). Collapse ~40 copy-pasted CMake test
stanzas into one helper function (−710). One live proxy bug remains (the
oversized-provider-message bound is already fixed, tied to the downlink
reservoir — matches codex v1): the suppressed-downlink leak in the lab
proxy, where suppression set by a text-response request is cleared only in
the push-to-talk branch. Fix it there, and carry the rule into the v2
media session — suppression clears on `response.created`/`response.done`
regardless of input mode, with a rung-1 regression test — because under §2
server VAD is the only mode and the latent branch becomes the hot path.
Make device-clocked the default delivery mode (the device's own sample
clock paces downlink audio; the alternative setting of the same knob,
host-paced mode, has the server pace it); the deployed bridge already runs
the equivalent shape — a 20 ms admission clock with an 8-frame device
lead, the lab's proven physical constants (matches codex v1). Re-check bug
liveness at execution time.

### Stage 1 — structure and resource groundwork

Split `components/core` into `core` + `audio` and remove the `device.h` →
`audio.h` include, then add a CI build that links a no-audio device and
fails if any audio symbol sneaks in. Extract Wi-Fi handling from
`itx_transport.c` into `wifi_station.c` built on `retry_gate`. The resource
chores the echo-cancellation future needs: open the DIRAM ledger (D6) —
its first entry is the shared 8 KiB TLS-owner task-stack constant already
in the tree (+~7.2 KiB static, crash provenance in its comment; matches
codex v1); enable + smoke-test PSRAM **at 80 MHz** (`SPIRAM_SPEED_80M` — v1 runs the
octal PSRAM at half the speed every shipping S3 voice stack uses; PSRAM =
the external RAM chip); flip the CPU 160→240 MHz gated on a tone +
endurance + brownout-history rig pass (G17 — esp-sr's CPU budgets assume
240); one bounded experiment with `SPIRAM_XIP_FROM_PSRAM` (measure IRAM
freed vs tone/PRBS regression; default stays off — this is the documented
option HA Voice PE ships and the escape valve if the DIRAM ledger can't
close at stage 5); record the Wi-Fi IRAM options
(`ESP_WIFI_IRAM_OPT`/`ESP_WIFI_RX_IRAM_OPT`, both already on) as the
~27 KB emergency DIRAM-reclaim lever, decided at stage 5, not now;
boot-time logging of where every buffer actually landed (internal vs
PSRAM). Scaffold the `event_types.def` code generator. Add per-device id +
boot counter to provisioning and the flasher.

### Stage 2 — audio capture ownership and reconnect fixes

`m5sticks3_codec.c`: microphone capture moves off the priority-1 main task
onto the core-1 audio task, using the modern `esp_driver_i2s` API for the
PDM microphone, with the half-duplex mic/speaker switchover handled inside
the codec implementation. Replace the two tick-polling loops with
event-driven wakeups (PCM receive; capture completion). Reconnect fixes:
the PCM retry gate only resets on evidence of forward progress on the new
connection — first raw-byte send progress or first received downlink
frame, stated in local facts because PONG-based delivery confirmation no
longer exists (§2 rule); the bug itself — reset on mere TCP connect — is
still live. `pcm_transport_start` retryability looks already fixed
(stop/start are now symmetric) — re-verify at execution and drop the item
if clean. Reconnect jitter;
a last-resort reboot rung (no control-plane connection for 15 min, or a
fatal latch → flush SD → reboot). Load isolation: pin the lwIP tcpip task
to core 0 (`CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y` — today it floats and
can land on the audio core); Wi-Fi jitter A/B experiments on the rig
(static RX buffer count, AMPDU on/off, block-ack window 6→3) — adopt only
what measured jitter data justifies; the churn scenarios and the nightly
rig run record Wi-Fi stall/outage telemetry (DECISIONS §7 names it the
evidence that would ever reopen the transport decision); the task-watchdog
rule (no busy-waits
on the audio task; the core-1 idle-task watch doubles as a
capture-starvation canary); and the instruction-cache-32KB benchmark that
feeds the stage-5 memory decision. The FIRST thing this stage lands is the
new rig scenario that catches the capture-starvation bug: pre-fix firmware
must FAIL it while control traffic is churning; post-fix firmware must
pass. Transport fixes are proven the way the resumable-WebSocket-header
patch already is (matches codex v1): patch the vendored IDF layer in
place, compile the patched source on the host, and fault-inject there.

### Stage 3 — one schema, per-board profiles

Regenerate the metrics schema from `event_types.def`, starting from the
schema-v3 shape already shipping (the `network` object with its
evidence-flagged RSSI; a five-layer buffer chain) — this deletes the
hand-written copies and splits the ~1,500-line, still-growing metrics.c
into sampler + subscriptions (re-count at the G2 checkpoint). Turn per-board settings into data: one profile struct per
board (frame geometry, ring capacities, freshness windows, priorities, gain
ceiling, has*sd / has_aec_reference flags), compile-time defaulted, a safe
subset overridable at provisioning time, and every value reported through
metrics so each physical run records the knobs it ran with. Wire constants
(640/320/16 kHz/20 ms, subprotocol strings) generated into both C and
TypeScript from one table — this also removes the TS/TS duplication of the
subprotocol and frame-size constants between `src/voice/` and the config
worker. Profile additions: the echo-suppression
aggressiveness level (`aec_nlp_level` — the one tunable echo-vs-near-end
lever; only works in the FD modes) as a per-board knob; a
`requires_pm_locks` tripwire with an architecture test asserting "power
management off OR call-scoped frequency locks held" (power management is
off today, so frequency-scaling can't corrupt I2S timing — the test guards
against someone enabling it later without the locks); per-task CPU%
(`uxTaskGetSystemState`) as generated metric fields. Two generated-schema
defaults (both match codex v1): optional fields get the `has*`
evidence-flag pattern — absence is the only honest reading during a roam;
and the profile's gain ceiling is board power policy — user volume may
attenuate below it, never exceed it without a new physical power proof.

### Stage 4 — events, SD, worker

Widen `device_events` to the 64-byte record; event types for the earliest
boot steps (booted, config-loaded, wifi-connecting, …); every
connect/disconnect/degrade transition becomes an event, so the
degraded-mode matrix is observable by construction; the call-model events
(connect, hang-up, mute-toggle, interrupt-tap — §2). Generalize
`device_event_stream` in place — the base is finished and tested, so this
is a contained refactor: widen the two-type enum, replace the single
`current_active` bool with a per-type current-state/snapshot policy, and
settle the fate of the push-to-talk-specific `active` wire field. The five
delivery invariants carry over verbatim (matches codex v1): one owner with
release-before-replace handoff (an idle callback is replaceable on the
same session; an in-flight one is refused with the offered import
released; a rejected callback ends the subscription); every accepted owner
gets a current-state snapshot; at most one delivery in flight, never
reordered; a bounded queue where saturation replaces the newest entry and
the loss is receiver-detectable (sequence gap + cumulative
`coalescedNotifications`); and session end preserves the boot-local
sequence and current physical state for the next snapshot. The wire record
keeps its shape: `{schemaVersion, sequence, type, source, result,
snapshot, coalescedNotifications}`. Callback slots keep the shared budget
and its burst arithmetic (one callback = push+pull outbound,
resolve+release inbound; capacity is concurrency, not subscriber count),
with `call_control` inheriting the event stream's first-polled slot
priority. New capability surfaces ride the existing flattened-path
`invokeCapability` envelope — the static method table stays the only
dispatcher (matches codex v1). Golden-log tests: drive a scenario,
serialize the event log, diff against a checked-in expectation.

SD writer: portable core + fake block store + simulator sink (the hardware
adapter waits for Waveshare); on-card format = the 64-byte records verbatim
in CRC-protected 4 KiB blocks inside preallocated files (torn tail =
CRC-detected, never garbage), plus dictionary / time-anchor / gap /
snapshot records; a `read-sd-card-log` CLI decodes cards using the same
generated schema. Verified detail the writer must respect
(`exploration/validation-hardware-2026-07-31.md`): preallocating a
contiguous FAT file records its FULL size in the directory up front, so the
directory never tracks how much was really written — recovery always finds
the write frontier by scanning blocks for valid CRC + magic, the CRC
framing must treat never-written regions as arbitrary card garbage (stamp
or erase ahead of the frontier), and the writer opens the file read-write
and seeks to its recovered frontier (append mode would jump to the end of
the whole preallocated extent).

Worker: the always-connected `/pcm` socket with the per-conversation media
session — a delta on the deployed worker, not a rebuild: the
device-connection/provider-session seam already exists (provider
generations replace without touching the device socket; matches codex v1),
so what lands here is D8's remaining list — dial on conversation start
instead of inside the device's upgrade, dial on uplink demand, the idle
hangup, await `session.updated`, a clean device end-of-stream on provider
death — plus the bounded stream outbox, the kit-device stream processor,
and `/pcm` cross-posting (transcription, speak start/end, turn lifecycle;
transcription deltas marked ephemeral). The media session is built as the
one shared module of §5's dependency ladder: the merge of the deployed
bridge (correctness — the commit-ack fence, generation replacement,
sequence-gap closes) and the lab proxy (observability — per-frame hooks,
socket-close and response-complete observers, spoken operator cues),
wrapped by the userspace worker, the local Node server, and the workerd
harness; the lab proxy is deleted at parity after one clean physical run
on the shared core. Named migration this stage owns: today's `/pcm`
terminates on a Durable Object, and moving to per-conversation stateless
invocations changes the server's shape — the one-current-generation
arbitration the Durable Object provides needs a new home. Every provider
session runs server VAD; the manual-commit path is dead code from here on and is deleted with
the v1 push-to-talk support once v2 firmware is the deployed fleet (§2).
Speak-state gating for boards without echo cancellation is implemented
here, in the media session; the half-duplex mic re-arm uses the
control-plane speak-end signal plus local playback-ring drain (§2). PCM v2
header + timestamp echo (D7). Tag the `/pcm` socket with IP precedence 6
so Wi-Fi puts it in the voice queue, which never aggregates frames (the
surgical alternative to disabling aggregation globally).

Call-time invariant (trawl-verified): **no NVS/OTA/internal-flash writes
during audio sessions** — a flash write suspends every other task and
busy-parks the second core, so it would gap both capture and playback; SD
writes are exempt by construction (different bus), so SD logging during
calls is safe; the rig asserts no flash-write events occur inside capture
sessions, and future OTA schedules into D8's idle window. Watchdog trips
become an event record type. The manual test checklist script (§5,
layer 3) and the rig speech toolset land here.

### Stage 5 — boards

**Waveshare** first: the SD hardware adapter (it has the only conflict-free
SD slot), and the codec-interface value test — its ES8311 codec
implementation should cost ≲300 lines by sharing the interface; if it costs
more, the interface failed and gets fixed before StackChan. This is also
when the playback stack folds behind the codec interface, gated on
byte-identical rig output (D2).

Then **StackChan**: echo cancellation per D3 — use its built-in hardware
echo-reference channel (the ES7210's TDM slot 1 is wired across the
speaker output — verified in the stackchan clone; better than the software
tap earlier reviews assumed), standalone FD_LOW_COST AEC behind the
audio-processing interface (not the full AFE — the FD type was added to
esp-sr in April 2026 specifically for full-duplex barge-in and is the only
option inside our CPU/RAM budgets; `exploration/afe-profile-decision.md`).
Turn-taking stays with the provider's server VAD on every board (§2); a
local VAD is added only if bring-up shows a concrete need (G13). Full
duplex, voice barge-in, and measured echo reduction ≥10 dB with <3 dB
near-end damage per the goal doc; the face/viseme analysis component lands
here, adopting the stackchan render record verbatim. Bring-up notes now in
the contract: the interface's frame-size self-report is normative (FD says
512 samples; other modes differ); AEC output buffers must be 16-byte
aligned; bring-up follows the seven-rung fallback ladder with measured
triggers; per-stage cycle counts feed the acceptance numbers; the Wi-Fi
IRAM options and cache geometry get re-decided here against the DIRAM
ledger. The concrete reference for the hardware-loopback wiring is
Espressif's own esp-webrtc-solution demo (`media_sys.c:47-57`, ES7210
channel mask selecting mic + reference slots).

Then **Home Assistant Voice PE** as purpose-built firmware: its mic input
arrives already echo-cancelled from the XMOS chip — the codec interface's
"input already echo-cancelled" property exists for exactly this. Also
verified: the ESP32 is I2S _slave_ on both buses there (the XMOS masters
the clocks), so the codec interface must not assume it owns the sample
clock — one more property, not a redesign. The ESPHome adapter stays
designed-for (D1's non-blocking interface and stage 1's splits are its two
prerequisites) but is not built in v2.

### Milestone v2.1 — pre-named, trigger-driven

Merge the four delivery mechanisms into one (trigger in D6), verified by
the side-by-side log diff before any deletion. Optionally, the one
coordinated firmware+worker deploy that changes the control-plane event
batch shape to the apps/os `StreamEventInput` shape verbatim (G6).

## 5. Testing: three layers and the test-dependency ladder

- **Layer 1 — host, fast (<5 s native, <30 s vitest warm).** Golden
  event-log diffs; contract tests against the do-nothing and test-fake
  audio processors; the "real platform adapter compiled against pthread
  fakes" technique becomes a merge rule, with its two known coverage holes
  closed (the errno classifier + URL parser in `websocket_connection.c`,
  the envelope unwrap in `peer.c` — re-locate both at execution; codex has
  edited `peer.c`); the patched tcp_transport override (resumable
  WebSocket-header framing) is a first-class host-tested surface (matches
  codex v1); fuzzing on the websocket reader and
  the provisioning TLV decoder; a replay corpus built from real rig
  captures; the no-audio link test.
- **Layer 2 — the rig (device next to this computer; the computer's
  speaker is the other talker).** `device-e2e.ts` (2,746 lines at the
  evening recon and still growing under codex) is re-frozen at the G2
  checkpoint; new scenarios are sibling scripts sharing its helpers — the
  pattern the `prove-production-*.ts` scripts already run; shared plumbing
  gets extracted only when the fourth scenario lands. The six new scenarios: capture-starvation gate (stage 2), AEC
  proof (computer speaks known audio while the device plays known audio;
  measure echo reduction, near-end damage, interruption), barge-in
  stopwatch (voice barge-in on AEC boards, ≤250 ms initial budget;
  interrupt-tap latency is the Stick's row), timestamp-echo alignment
  (echoed stamps vs the PRBS31 ground truth, ±0.5 ms), speak-state gating
  on the Stick (uplink verifiably suppressed while assistant audio plays;
  a tap interrupts within budget), and provider-death mid-utterance (the
  Grok socket dies; the device receives a clean end-of-stream within
  budget). Plus one scenario with no acoustics at all, for the audio-less
  device class. The rig also runs nightly (tone + 1-minute endurance),
  non-blocking, for trend data.
- **Layer 3 — human in the loop.** A scripted checklist
  (`manual-device-checklist.ts`, <5 min, frozen steps): connect with the
  real button → speak a phrase → mute while talking to a person in the
  room → tap to interrupt the assistant → hang up with the button; plus
  kill the access point mid-conversation, and pull + diff the SD card log
  against the host's evidence. Each step's expectation is asserted against
  the device's own event stream. Run per flash. This layer alone proves
  button feel, perceived latency, avatar states, and "does it sound
  right".

### The test-dependency ladder (rungs 1–5)

The ladder is the dependency axis of layers 2 and 3: it says which server
the device (or simulated device) talks to, from fewest dependencies to
most. Layer 1 is rung 1 by definition; every layer-2 scenario and layer-3
checklist run states its rung. Default rung for everything: the lowest one
that can express the scenario. The apps/os userspace worker is the LAST
rung, reserved for final acceptance and integration proof — never the
development loop. (Distinct from the physical proof ladder — tone → PRBS →
endurance — which is a scenario set that itself runs on a rung.)

**The rule: a bug reproducible on rung N is fixed and regression-tested at
rung N, never higher.** When a bug first appears at rung N+k, drive it
down to the lowest rung that reproduces it; the regression test lives
there forever. A scenario is promoted up only for what the higher rung
uniquely provides, and the promotion says what that is. Lower rungs are
not merely cheaper — each rung's differences catch bugs its neighbors
mask: the scratch-buffer aliasing bug (a whole provider burst arriving as
repeated copies of its final frame) was invisible in production workerd,
which snapshots sends eagerly, and was caught through the captun tunnel's
standards-shaped sockets. The expensive rung masked it; the cheap rung
exposed it.

1. **Pure host unit tests.** Vitest with in-memory WebSocket pairs for
   everything Workers-shaped; the native cmake host tests with pthread
   fakes for firmware C. The deployed bridge's own tests already run this
   way. Proves: session/bridge logic, pacing math under fake timers, frame
   validation, provider control fences
   (commit → committed → response.create), event codecs, golden-log diffs,
   every fail-closed rule. Cannot prove: real TCP backpressure (the
   in-memory fakes omit `bufferedAmount`), workerd runtime semantics,
   wall-clock timing, anything acoustic. Turnaround: <5 s native, <30 s
   warm vitest.
2. **A local Node web server on the LAN; the device connects directly.**
   The same fetch handler served over real TCP
   (`local-fetch-websocket-server.ts`); the Stick pointed at the laptop's
   LAN address. Zero external dependencies — no Cloudflare, no apps/os, no
   tunnel; the deterministic tone/fixture provider by default, real Grok
   dialed from the laptop only when the scenario is about the provider;
   the simulator can stand in for hardware. Proves: the full wire contract
   against a real device — real TCP backpressure, real Wi-Fi jitter, the
   chip-exact acoustic oracles, reconnect/churn drills, capture
   starvation, all six rig scenarios, the layer-3 checklist. **~80 % of
   stage-2 and stage-4 functionality is provable here.** Turnaround:
   edit-to-retest ~10 s plus whatever the audio takes.
3. **The same local server behind a tunnels.iterate.com captun tunnel.**
   One flag on the same run — the direct-LAN/tunnel duality over one fetch
   handler already exists in `device-e2e.ts`. Adds exactly one dependency,
   the public edge: internet RTT and jitter on the real path, TLS,
   tunnel-edge WebSocket behavior (the standards-shaped socket semantics
   that caught the aliasing bug), the device configured exactly as against
   production. The edit loop stays fully local.
4. **Miniflare/workerd hosting the ACTUAL config-worker module, locally.**
   New — nothing runs this today; wrangler is already a dependency. Load
   the same source files the installer uploads into local workerd with a
   small fake `ITX` binding (project id, secret reveal, kv get, egress
   fetch, capability invoke); point the device or simulator at it directly
   or through the rung-3 tunnel. Proves: workerd runtime semantics on the
   shipped module — Durable Object lifecycle and the
   one-current-generation arbitration, `waitUntil`/`abort`, native sockets
   with real `readyState`/`bufferedAmount` (the strict branches rung 1
   cannot reach). Cannot prove: real auth, real egress secret
   substitution, capability routing through the platform, stream commits.
   Prerequisite: the `/api` proxy target becomes a parameter (it is
   hard-coded to `os.iterate.com` today).
5. **A real apps/os project with the userspace worker installed — the
   last, most expensive rung.** `install-userspace-worker.ts --apply`,
   then the production proof scripts. Proves only the residue: real
   project-key auth end to end, egress placeholder substitution against
   live xAI, the capability path to the mounted device through the
   platform, stream posting once built, worker-dispatch headers, cold
   starts across real Durable Objects, and the §7 acceptance runs. Costs
   an install roundtrip, a project, OS availability, xAI spend, and
   physical attendance — and it actively masks some bugs (the rule
   above). Used for acceptance and the integration seams; never for logic
   debugging.

Orthogonal to every rung, the provider axis: deterministic tone / recorded
fixtures by default; live Grok only when the scenario is about the
provider. Every rung supports both, and a scenario states the minimal
dependency set it needs.

**One media-session module for every rung.** The local server and the
userspace config worker share one media-session module — the code owning a
device PCM socket, its per-conversation provider leg, pacing,
suppression/gating, and diagnostics — so rungs 2–4 exercise the code that
ships at rung 5, differing only in adapters and injected dependencies. The
seams already exist (dependency-injected routing, a runtime-portable
bridge, the fetch-to-LAN adapter, the shared device-event subscription
module); the session logic itself is currently duplicated between the lab
proxy and the deployed bridge, which diverged within a single day. The v2
media session (D8, stage 4) is written once as the merge of the two, with
the union of their modes; the lab proxy is deleted at parity. From then on
a rung-2 pass is direct evidence about shipped code, not about a
lookalike.

Where each planned piece of work sits:

| Work                                                                                                                                   | Home rung                                        | Escalates to                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| Media-session logic: on-demand dial, idle hangup, `session.updated` gate, EOS on provider death, speak-state gating, suppression rules | 1                                                | 2 (device timing), 4 (workerd), 5 (acceptance)      |
| Stage-2 reconnect fixes + churn scenarios; capture-starvation gate                                                                     | 2                                                | 3 (public-path churn), nightly rig                  |
| PCM v2 header + timestamp echo (D7)                                                                                                    | 1 (codec) → 2 (±0.5 ms vs the PRBS ground truth) | —                                                   |
| Acoustic scenarios (tone, PRBS, AEC proof, barge-in stopwatch)                                                                         | 2                                                | — (bit-transparency makes higher rungs add nothing) |
| Call-model capability + device events                                                                                                  | 1 (golden logs) → 2                              | 5 (capability path through the platform)            |
| Event outbox + stream posting                                                                                                          | 1 (fake stream) → 4 (workerd + the itx stub)     | 5 (real stream commits)                             |
| Layer-3 manual checklist                                                                                                               | 2 or 3                                           | 5 once per release, as the acceptance pass          |
| DO→stateless migration behavior, worker-abort recovery                                                                                 | 4                                                | 5                                                   |

### Rig tooling and ground rules

- **Never open the Stick's USB serial port to inspect a live incident**
  (matches codex v1's device-inventory note): opening the port resets the
  firmware even with DTR and RTS off, destroying the pre-reset transport
  state. Tooling identifies devices by USB metadata; listing ports is
  safe.
- **Rig speech toolset** (real voices, not macOS `say`). Two small CLIs in
  `apps/kit`, provider-pluggable behind one interface, keyed via Doppler:
  - `speak-to-pcm "<text>"` — text → 16 kHz mono S16LE PCM (file, or
    played through the computer speaker as the far-end talker in rig
    scenarios). Providers: our own Grok realtime path first (we already
    have the proxy code and the key, and it tests with the same voice the
    product uses), ElevenLabs as the quality alternative, and a local
    model (e.g. Piper / Kokoro) as the no-network fallback.
  - `transcribe-pcm <file>` — PCM → text with word-level timestamps (so
    scenarios can assert not just WHAT was said but WHEN — feeds latency
    assertions). Provider: local whisper.cpp first (no key, offline,
    deterministic across runs), API providers optional.

  Determinism rule: rig scenarios never call a TTS API at test time —
  utterances are synthesized once, content-addressed, and cached as
  fixtures (same discipline as the existing tone/PRBS fixtures); live
  synthesis is a fixture-generation step, not a test step. Transcription
  assertions use normalized text matching with a similarity threshold, and
  exact word-timestamp windows only where the scenario is about timing.
  These CLIs also serve the layer-3 checklist (speak a scripted phrase at
  the device; transcribe what the device played back) and SD-card evidence
  review. Lands in stage 4.

- **Thresholds live in ONE module**, keyed by device — today the six
  acoustic numbers are spelled in at least three files. The chip-exact
  oracles (997 Hz tone phase, PRBS31) rest on the PCM socket's
  bit-transparency and are fully valid on it.

## 6. How each requirement is discharged

The requirements are the twelve in `inputs/brief.md` plus the device-class
addendum. One row is restated as amended (DECISIONS.md §1): requirement 11
by the "nothing flows when inactive" amendment (§1.3). Requirement 10
stands as originally written: the devices must attempt to maintain the two
websocket connections at all times.

| #   | Requirement                                                               | Where                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | less code/complexity                                                      | stages 0+3 deletions & generation: −3…−5 % lines in v2.0 (−8 % ceiling); schema spelling sites 7→1; delivery mechanisms 4→2 now, →1 in v2.1; the call model deletes the turn-boundary machinery outright (§2)                                                                                 |
| 2   | easier to test/reason                                                     | non-blocking interfaces (D1), sans-I/O cores kept, golden logs, §5                                                                                                                                                                                                                            |
| 3   | best practices from reference impls                                       | D1/D2/D3/D7 are the prior-art lesson set; the review's "what we already do better" list is preserved verbatim                                                                                                                                                                                 |
| 4   | pluggable hardware APIs                                                   | audio-hardware + audio-processing interfaces, per-board profiles, composition roots (stages 1–3)                                                                                                                                                                                              |
| 5   | SD logs                                                                   | portable writer (stage 4) + Waveshare hardware (stage 5); records on card = the same 64-byte events; honest caveat: only 2 of 4 current boards have a slot                                                                                                                                    |
| 6   | keep the best                                                             | verbatim-module list in §1; frozen e2e; playback untouched until its gated move (D2)                                                                                                                                                                                                          |
| 7   | three test layers                                                         | §5 — plus the test-dependency ladder: rungs 1–5, the apps/os userspace worker last, for acceptance only                                                                                                                                                                                       |
| 8   | devices as streams                                                        | D4+D5 (stage 4): apps/os-shaped events from boot — connect, hang-up, mute-toggle, interrupt-tap included; stream processor; /pcm cross-posting; the merge to one delivery state machine = v2.1                                                                                                |
| 9   | server-side AEC                                                           | D7 timestamp echo (stage 4): mic frames tagged with the speaker timestamp playing at that instant; the bit-transparent PCM socket means the server already holds the exact downlink waveform, so timestamp echo completes the groundwork; the G5 ladder decides how far past groundwork to go |
| 10  | degrade/recover; maintain the two websocket connections at all times      | stage 2 reconnect fixes (retry-gate reset only on forward progress — first byte sent or first downlink frame, never mere connect; reconnect jitter; the last-resort reboot rung) + every connect/disconnect/degrade transition an event + rig churn drills                                    |
| 11  | no unnecessary Grok session — **as amended: nothing flows when inactive** | D8: both sockets stay connected; frames and the provider session are strictly per-conversation, started and stopped over the control plane by either side; device-side preroll masks dial latency                                                                                             |
| 12  | pluggable device I/O                                                      | capability vtables kept; buttons produce events; profiles declare what exists (stages 1–4)                                                                                                                                                                                                    |
| —   | audio-less / partial-audio devices (addendum)                             | stage 1 split + no-audio link test + no-acoustics scenario; partial-audio boards link only the audio halves they have (ground rules)                                                                                                                                                          |

## 7. What "done" means for v2.0

Full physical proof ladder green (tone → PRBS → endurance rung 3 — the
acoustic ladder, distinct from §5's dependency ladder) · the six new rig
scenarios plus the no-acoustics scenario green · manual checklist pass on
the Stick (the call-model steps in §5) · Waveshare bring-up with an
SD-vs-host log diff · the no-audio link test in CI · the kit-device stream
processor live on a dashboard. (G15 may amend.) These acceptance runs are
the one job reserved for the dependency ladder's last rung — a real
apps/os install.

## 8. The known-warts list (standing review item)

Eight known warts are carried deliberately, each with its cost and a
measurable trigger for fixing it (full ledger:
`exploration/arch-c-minimal-delta.md` §9.3). Headlines: four delivery
mechanisms until the third cross-mechanism fix (→ v2.1 merge);
`runtime_diagnostics` living beside the event log; the metrics sampler
outside the event core; the capture-moved/playback-not-moved asymmetry
until Waveshare (the only date-triggered one). This list needs an owner
(G15) — a deferred fix with no trigger and no owner is how v1.5-forever
happens.

## 9. Where everything else lives

- [`DECISIONS.md`](DECISIONS.md) — the decision log: dates, who settled
  what, superseded designs, the goal-document amendments Jonas is carrying
  into `../physical-device-voice-goal.md`, the transport reversal, and
  every correction of record.
- [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md) — the still-open items (with
  the plan's assumed defaults), the measurements awaiting go-ahead, and
  the watchlist.
- [`README.md`](README.md) — index of this folder, including the status of
  each exploration file.
- `inputs/` — the original brief, the v1 goal, and the raw agent reports.
- `exploration/` — immutable historical artifacts from the exploration and
  review rounds; cited throughout as evidence, never edited.
