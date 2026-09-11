# Iterate Kit firmware

## What a client is

A client does exactly four things, and nothing else:

1. **Maintain the connection** — one WebSocket to `/api`, kept alive with the
   transport's full correctness grammar (generations, session-scoped
   discards, mount deadlines, backoff).
2. **Render state onto the local output surfaces** — screen, lights, sound,
   vibration, servos. State is both local (mic input amplitude, whether
   `/api` is connected, haptic/audio-visual button feedback) and remote (the
   live state of the agent stream).
3. **Respond to physical IO** — button presses, mic input, touch. Every
   physical input is also exposed as a remote-triggerable capability, and
   every actuation — physical or injected — appends a stream event, so the
   server can both cause and audit it.
4. **Provide device capabilities to Cap'n Web** — face.set, screen.show,
   servo moves, volume, camera, restart: whatever this body can do, offered
   as callable capabilities.

Everything under those four is a _driver_: XMOS bring-up, AEC, mic and
speaker buffers are the same class of code as a panel driver — hardware
truth behind a clean seam, never policy. Conversation logic, turn-taking
doctrine, and anything resembling "what should happen next" lives on the
server; if a piece of device code is not one of the four responsibilities
or a driver serving them, it is in the wrong repo.

Firmware is split at two ownership boundaries:

- `components/core` owns the control plane and must not include the audio
  component's seams or platform headers. Its `voice_playout` classifier is a
  core policy module, not hardware access.
- `components/audio` owns board-independent capture, processing, and playout.
- `platforms` owns operating-system and ESP-IDF integrations.
- `devices` owns board profile data, while `targets` only compose a device.

Phase 0 established these boundaries before implementation was imported. Keep
platform-private headers out of public include paths; a component that bypasses
a seam should fail to compile. The architecture check also rejects
audio-component seam or platform includes added to `components/core`.

## The two itx transports rhyme on purpose

`platforms/iterate_esp_idf/itx_transport.c` and
`platforms/darwin/posix_itx_transport.c` implement the same connection
grammar — socket generations, mount deadlines, session-scoped discards,
READY-gated retry reset — under two different ownership models: the device
splits the work across a Wi-Fi-owning network task and the application
poll (every shared flag is an atomic with documented publication order),
while the Mac CLI runs single-owner and can discard a dead generation
synchronously. A shared "transport core" was attempted and rejected during
the 2026-08 shrink: every line that looks duplicated differs in which task
may touch it, so extracting it means abstracting clocks, atomics, and
ring ownership behind callbacks — a framework where the codebase wants two
short rhyming implementations. If you change the grammar, change it in
both files in the same commit.

## The playout step is shared, and the transport is not, for the same reason

`components/core/src/voice_playout.c` is the one speaker pass both the board
(`components/voice/src/voice_loop.c`) and the Mac CLI
(`targets/host_cli/main.c`) run — prime, take a frame, hole or end, skip or
play, report — with only the ring and the sink injected as callbacks. That
is the abstraction the transport refused, and it is right here because the
ownership is different: playout is single-owner on both targets (one task on
the board, the one loop on the host), so nothing inside the step is an
atomic and no callback crosses a task. The two owners had drifted apart
twice in one week before it was shared (2026-09-06 and 2026-09-09, both
the answer timeline failing to restart, each on a path the other had
fixed). What stays in each owner is exactly what is theirs: the queue's
generations and reprime handshake, the codec's bounded wait, the room's
lead — and the underrun promotion, which on the board is an app-task read
of a playback-task stamp and so cannot live in a single-owner module.

## Shared client controls

`components/core/src/voice_uplink.c` owns microphone batching and turn markers
for both clients. It preserves speech while admission is pending, snapshots the
queued tail at release, flushes that tail within a deadline, and bounds stuck
PTT input and outbox backpressure. Server VAD sends no PTT markers. Failed
publications stop the uplink and report a fault; adapters replace the session
instead of continuing with an ambiguous turn. Its cumulative counters survive
session resets.

The ESP application task supplies FreeRTOS queue operations and maps uplink
notifications to the capture fence and view. It publishes capture permission
to the capture task through atomics. `targets/host_cli/cli_uplink.c` supplies the
host microphone queue, WAV preparation, recovery request, and reporting stamps.
Terminal input, scripted conversations, recording, and room playback accounting
remain CLI responsibilities. Each adapter supplies readiness; the ESP client
also waits for call acceptance before sending its dial buffer.

Physical controls follow one path through `board.c`: GPIO, injected taps, and
`read_gestures` produce normalized gestures; the shared session grammar produces
intent and ordered chimes. Board callbacks read hardware, render any dedicated
sound path, and handle board-specific menus. They do not run another copy of the
call grammar.

`provider_mode.c` owns validation, silent boot adoption, changed-selection
persistence, and settled-selection announcements. `provider_mode_nvs.c` supplies
the ESP store. HAVPE and StackChan retain their namespaces, defaults, allowed
modes, and mode assets; each apply callback updates its live configuration
(including HAVPE's stream path and turn posture together). A failed write is
reported while the live selection remains applied.

Run the fastest complete host check from `apps/kit`:

```bash
pnpm firmware:test:host
```

Its build tree is disposable and ignored at `firmware/.build/host`.
