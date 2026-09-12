---
name: adding-a-kit-device-or-sprite
description: Add an ESP32 voice board to apps/kit/firmware, or add a shared face sprite pack.
publish: false
---

# Add a Kit board or sprite

Read [the firmware guide](../../../apps/kit/firmware/README.md) first. It is
canonical for board ownership, provisioning, build, installer and proof steps.
GPT-Live-1 is the only voice model: a board contributes hardware facts, never a
provider mode or a different voice protocol.

## Board rules

A board is `struct iterate_kit_board` in
`platforms/iterate_esp_idf/components/board/include/iterate/kit/platforms/board.h`.
Start from the closest `devices/<board>/<board>_device.c`, preferably
`devices/satellite1/satellite1_device.c` for a table-driven board.

- Put pins, I2S facts, boot/reset order, codec scripts, physical controls and
  genuinely board-only code in `devices/<board>/`.
- Reuse `board.c`, the shared voice loop, `i2s_codec.c`, playout, microphone
  flushing, session grammar and conversation ring. Do not create a second
  capture loop, uploader, wire dialect, model option or push-to-talk mode.
- Continuous capture begins before mounting so the first words survive startup.
  Capture continues for the call. Physical mute/end discard queued PCM and fence
  stale callbacks. Keep existing AEC/reference routing; lack of AEC is not a
  reason to add PTT.
- Confirm pin polarity, I2S slot/clock ownership, gain, amplifier polarity and
  any AEC path from vendor source, then measure on hardware. A counter must be
  observable through health or a focused test.

The normal minimum is four files:

1. `devices/<board>/<board>_device.c`
2. `devices/<board>/CMakeLists.txt`
3. `targets/<board>/CMakeLists.txt`
4. `targets/<board>/sdkconfig.defaults`

Add a source-built release only through the documented Kit pipeline. Do not put
credentials in firmware defaults or an artifact; the installer writes the
versioned `iterate_kit` configuration partition.

## Sprite packs

Source assets live in `components/avatar/assets/<slug>.png` and `.json`.
Add the corresponding public atlas header and CMake source name, then run:

```sh
pnpm --dir apps/kit firmware:configure
```

It generates ignored atlas C sources and the catalogue include. Do not edit
those outputs. Keep local playout energy as the baseline animation signal;
remote visemes are an existing optional Waveshare overlay.

## Bench proof

Run the focused host tests, build the target, provision it with a real project
and use `voicelab boards --only <device-name-or-client-path>` only on an idle
board. Read health before changing audio code. A serial monitor reboots many
boards; the stream health capability is the in-call instrument.
