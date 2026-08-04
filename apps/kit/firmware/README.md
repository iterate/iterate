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

Run the fastest complete host check from `apps/kit`:

```bash
pnpm firmware:test:host
```

Its build tree is disposable and ignored at `firmware/.build/host`.
