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
  component's seams or platform headers. Its `audio_playout` classifier is a
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

Run the fastest complete host check from `apps/kit`:

```bash
pnpm firmware:test:host
```

Its build tree is disposable and ignored at `firmware/.build/host`.
