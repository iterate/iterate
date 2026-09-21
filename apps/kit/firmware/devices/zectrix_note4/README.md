# ZECTRIX NOTE4

ESP32-S3 / 16 MiB flash / 8 MiB PSRAM, 400 × 300 SSD2683 e-paper,
ES8311 microphone/speaker. This target is for the black-and-white NOTE4,
not the four-colour NOTE4C. Hardware facts come from the official reference
linked in [NOTICE.md](NOTICE.md).

The front **OK** button (GPIO0, active low) starts/ends a conversation using
the shared Kit voice loop. It is also the ROM boot strap: hold it while
resetting/reconnecting for recovery. GPIO17 latches battery power; GPIO42
powers the codec; GPIO46 enables the amplifier. Release the factory firmware’s
GPIO holds before configuring these pins; otherwise a held-low amplifier can
accept PCM writes without producing sound. Hold GPIO17 only after the shared
boot sequence has driven the battery latch high. I2C uses SDA47/SCL48;
I2S uses MCLK14/BCLK15/WS38/DOUT45/DIN16 at 16 kHz, mono 16-bit,
with **both RX and TX explicitly selecting the left slot**. IDF 5.4's S3
Philips macro defaults to BOTH even in MONO: the initial bench capture had
alternating real/zero samples and twice the expected duration. Do not replace
this explicit slot configuration with that default macro.
The initial port uses the vendor's 30 dB mic gain, no digital boost, a capped
speaker volume, and no echo cancellation. Side buttons, NFC, RTC and battery
management are not exposed by this minimal firmware.

## Build and restore

Use ESP-IDF 5.4.2, like the other Kit targets:

```sh
export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.4_py3.14_env"
source "$HOME/esp/esp-idf/export.sh"
idf.py -C apps/kit/firmware/targets/zectrix_note4 \
  -B /tmp/iterate-note4-voice -D IDF_TARGET=esp32s3 \
  -D SDKCONFIG=/tmp/iterate-note4-voice.sdkconfig build
```

The catalog ID is `zectrix-note4`, remote client `itx.clients.zectrix_note4`.
The shared 16 MiB partition table reserves configuration at `0x410000`.
Credentials belong in that partition, never in source or release artifacts.
The Kit release builder validates offsets and publishes source-built parts.

Bench unit USB serial / ROM MAC: `80:45:6B:38:60:84`. Resolve its port using
`tools/port-for-mac.sh` before flashing. Its factory firmware identifies
`zectrix-s3-epaper-4.2`, xiaozhi 3.6.2, ESP-IDF 5.5.2. These facts are
consistent with NOTE4 hardware; they do not independently authenticate its
seller or manufacturing provenance.

The full 16 MiB factory image is preserved locally, outside git:
`~/.local/share/iterate-kit/backups/note4-80456b386084/factory-2026-09-21.bin`.
SHA-256: `c18514a31e710c32b8bed086f277e4365830056214f3fcadc5b3b323f1d8241f`.
Restoring that image at offset zero restores its original firmware and data.
No eFuses were changed. Keep the backup private; it includes factory identity.

## Remote images

This board uses the shared `capabilities/screen` module, also used by Waveshare
RLCD. `screen.info()` advertises 400 × 300, `mono1` (preferred), `gray4`, partial
refresh support and a 45-second refresh deadline. The transport is independent
of resolution and panel wiring. `mono1` has 1=black, while the vendor EPD API
has 1=white; the board adapter handles the inversion. `gray4` uses high nibble
first, 0=black and 15=white.

```ts
await itx.cd("/").voice.setImage({
  device: "zectrix_note4",
  image: { html: "<body style='margin:0'>Hello NOTE4</body>", format: "gray4" },
});
// Restore the normal voice status screen:
await itx.cd("/").voice.setImage({ device: "zectrix_note4", image: null });
```

Rendering and conversion run on the server. The board stages bounded chunks
and refreshes only a complete image. A separate display task keeps slow e-paper
work off the voice/control loop. The single pending refresh owns its buffer;
a second upload is rejected as busy. `screen.status()` distinguishes pending,
shown and failed. The server waits for refresh completion before returning
`shown: true`; this is a controller acknowledgment, not optical inspection.
Health counts uploads, display updates and failures. A panel failure stops
further refreshes until reboot instead of retrying forever.

Status changes coalesce in a one-item queue. Monochrome normally uses partial
refresh, with a full refresh every twentieth update and after grayscale.
An uploaded image stays visible until cleared. The screen guide is attached
to calls based on the registered screen capability, not a board-name list.

## Driver size

The display driver lives directly in this board directory. Its grayscale
header contains only five 535-byte vendor calibration tables and the shade
mapping, verified byte-for-byte against the reference implementation. The
unused experimental waveform generators are omitted. Monochrome refreshes
use the controller's built-in OTP waveforms.

## Bench evidence — 2026-09-21

Flash hashes verified. Preview worker sent monochrome and grayscale through
the same renderer/transport as Waveshare: NOTE4 mono 2.69 s, gray 8.28 s;
Waveshare mono 0.83 s (server timings include render/transfer/refresh).
Both devices reported zero display, upload and protocol failures. The shared
firmware host suite passed 66 tests; renderer/worker tests passed 23, including
odd-width rows, RGB565 colour packing and rejected/incomplete/failed uploads.
RGB565 conversion is host-tested; neither of these monochrome panels advertises
colour support. Installed-service image proof also passed (mono 2.48 s,
gray 8.48 s, Waveshare 0.68 s). Optical grayscale awaits user confirmation.

After correcting the I2S slot mask, the air-path test opened a call in 1.92 s,
transcribed “What does eighteen plus nineteen? Please answer with just the
result” and generated “37”, with 123 speaker writes and no reported errors.
That test checked transcription and driver writes, not audible playback; the
user reported silence. The subsequent startup fix releases inherited GPIO holds
and corrects battery-latch ordering before repeating speaker verification.
The capture fix was grounded in a recording: the old PCM alternated real
samples with zeroes and had twice the duration. This is still an experimental
board without AEC; a single arithmetic exchange does not prove room echo
rejection or barge-in performance.

A speaker-only probe (no Mac speech) then generated “This is the Note Four
speaker test. One, two, three.” The on-device microphone recorded 1,413–2,700
RMS PCM units during playback versus 47–70 in a repeat with the DAC muted.
Both calls ended and volume was restored to 70. This supports acoustic output
after the GPIO fix; loudness/intelligibility still awaits the user's report.

## Echo cancellation and noise suppression

The [official V1.0 schematic](https://wiki.zectrix.com/sch_zectrix_note4_developer_kit_v1.0_en.pdf)
shows a single analog microphone, ES8311 codec and speaker amplifier, with no
XMOS or other dedicated voice DSP. The vendor's ES8311 adapter sets
`input_reference_ = false` and `input_channels_ = 1`. Upstream Xiaozhi's
[device-AEC configuration](https://github.com/78/xiaozhi-esp32/blob/main/main/Kconfig.projbuild)
does not include ZECTRIX among supported boards; its current AFE code also
sets `ns_init = false`. That is evidence about published reference/upstream
code, not proof of the private consumer firmware's processing configuration.

Decision (2026-09-21): keep passthrough capture and rely on OpenAI's audio
handling. Local AEC and noise suppression are intentionally out of scope for
this minimal firmware. This choice does not establish measured echo rejection
or interruption performance on the device.
