# Iterate Kit firmware

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
