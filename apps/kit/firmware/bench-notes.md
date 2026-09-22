# Firmware bench notes

This is retained hardware evidence and recovery guidance. The short
[firmware guide](./README.md) is the onboarding path; do not turn an individual
measurement below into a cross-board default.

## Satellite1 / XMOS signal path

- Vendor XMOS source identifies slot 0 as AGC and slot 1 as NS. On shipped
  XMOS `fixed_delay` 1.0.3, slot 1 is AEC+IC+NS, not raw audio. Set
  `diagnostic_slot = -1` when there is no same-microphone raw tap; comparing a
  channel to itself is not an echo oracle.
- `micRawPeak` and `micCleanPeak` show which measured plane moves. An AEC
  comparison needs raw and cancelled taps from the same microphone.
- XMOS is the clock master, so its I2S facts use `I2S_GPIO_UNUSED` for MCLK.
- Satellite volume buttons are active-low while physical mute is active-high.
  Treat their polarities separately or boot can report `micMuted` and reject
  every call.
- Historical echo measurements: gain 16 lost prompt
  prefixes; gains 64, 65 and 70 failed repeated barge transcription. The
  recorded candidate was NS slot 1, Q31 gain 32 before PCM16 and output
  cap 60. It passed short wake/barge tests but a 62-second run self-transcribed,
  so it is evidence to repeat rather than a release verdict.
- That output cap was an echo experiment, not the speaker's power rating:
  volume 60 is DVC -40 dB. Satellite1 now starts at 80 and permits 100. The
  FUSB302B requests fixed supplies up to 20 V, 3 A and 30 W; TAS2780 keeps the
  manufacturer's 15 dBV output gain unless a >=30 W contract and measured
  PVDD >=18 V permit 20 dBV (25 W into 4 ohms). No high-power claim should be
  inferred from the requested voltage alone: inspect `pdState`,
  `pdMilliVolts`, `pdMilliAmps`, `ampPvddCentiVolts` and `ampOutputLevel`.
- On 2026-09-21, the new firmware passed all 65 host tests and the spoken and
  interruption checks at volume 80 on the computer hub. The USB-only path
  reported 5 V / 3 A advertised, measured PVDD 4.53 V, power mode 0 and output
  level 8. A real PD-charger / 20 V / full-output proof is still pending;
  successful protocol simulations are not that hardware evidence.

Judge echo behavior by unwanted replies and interruption of a human speaker,
not only by ASR text.

## Other audio and timing facts

- M5StickS3’s earlier ADC/DAC handoff was a driver limitation; native I2S0 can
  be duplex. Do not infer half-duplex policy from the old implementation.
- `board.c` supplies shared 320-sample processing/capture frames and the normal
  4096-byte capture stack. Do not copy them into a new table. StackChan retains
  its explicit 256/128 cadence and 8192-byte capture stack.
- A zero speaker dry wait becomes two-thirds of the TX ring when table audio
  supplies a clock. Keep an explicit wait only when a board measurement needs
  it.
- Keep managed dependency pins beside the component that needs them: voice owns
  Cap’n Web, board owns `led_strip`, `board_wake_word` owns `esp-sr`, and the
  device owns direct managed drivers. Let target builds regenerate
  `dependencies.lock`.

## Build and configuration checks

- Keep target-only defaults in `targets/<board>/sdkconfig.defaults`. Shared
  defaults are explicit shared values, never inferred from absence.
- A target partition table must retain its `iterate_kit` configuration partition
  and reserve a wake-model partition when needed. Match partition geometry to
  flash size.
- After defaults or partition changes, pass `-D SDKCONFIG=/tmp/<board>.sdkconfig`
  to `idf.py`; an environment-only `SDKCONFIG` is ignored.
- The reviewed press and end WAVs are converted by CMake into each component's
  build directory. The recorded StackChan/Waveshare trim and M5/Waveshare gain
  are inputs to that deterministic rule; do not commit generated C arrays or
  regenerate clips through a network TTS service.

## Instruments and proof

Every counter must move and have a reader. `heapFree` includes PSRAM; inspect
`internalFree`, `internalMin` and `internalLargest` when TLS, Wi-Fi or DMA fail.
Use `health()` before and after an air-path proof.
`apps/agents/scripts/voice-board.ts --device <device_name>` speaks via the Mac
speaker, checks board microphone uplink, playout and transcript, then hangs up;
never run it on a board in use.

The legacy `spkDrops` counter counts response-start controls, even when no PCM
is queued. Use `spkDiscarded` for discarded PCM, `spkSupersededMidplay` for
replacement during playback, `spkOverflow` for queue admission loss, and
`spkStarvedMs`/`spkStarveEvents` for hardware starvation. Compare before/after
deltas; lifetime codec counters can include startup activity.

`playbackQueueOverflows` counts ESP-IDF TX completion-notification queue
overflows, not rejected voice PCM. HAVPE also writes silence while idle to keep
the XMOS AEC reference running, so this counter can advance between calls.
The driver replaces an already-completed descriptor notification; interpret
the delta alongside actual speaker writes, discards, playback failures, and
starvation. A counter increment alone does not establish audible data loss.

Opening a serial monitor reboots many boards. Resolve MAC to USB port passively
with `tools/port-for-mac.sh <ROM MAC>` (it reads `ioreg`); `esptool read_mac`
resets the board. Any early return after
`esp_task_wdt_add(NULL)` causes an unobserved watchdog reboot: park and expose
the fault instead.

## Satellite1 ROM recovery record

On the recovered unit, ROM MAC `14:C1:9F:4F:D2:14` mapped through `ioreg` to
USB bus 1, root port 1. A targeted libusb reset restored a missing ROM serial
descriptor. Match that physical identity before any reset; do not reset a
possible ESP device while another is connected. Re-resolve the port after
recovery. `esptool read-mem 0x6000403c` returning `0x3c000003` showed GPIO0 high.

The installed XMOS firmware was **read**, not flashed: `fixed_delay` v1.0.3,
MD5 `5f5788ecb240082f61acd36f247ea3b2`, SHA-256
`7e3a5d97ca3e90df953c0b2ef575b5d5dcb89c5d84a59e621a3bc7cf2cfd0d52`. A
one-off ESP diagnostic held GPIO4 reset and used SPI to read XMOS external boot
flash, then restored normal firmware. Do not flash XMOS without a new readback
or version-based reason.
