# Waveshare ESP32-S3 RLCD 4.2

Board ID / Kit selector: `waveshare-rlcd-4-2`. The os-next client is
`itx.clients.waveshare_rlcd_4_2`; it uses the same shared voice loop and
project voice service as HAVPE. No os-next backend changes are needed.

## Controls and hardware

- **KEY** (GPIO18, active low): start a conversation; press again to end it.
- **BOOT** (GPIO0): ROM download/recovery control; not the voice button.
- **PWR**: hardware power button; not a third interchangeable application key.
- ESP32-S3-WROOM-1-N16R8: dual-core LX7 up to 240 MHz, 16 MiB flash,
  8 MiB octal PSRAM, 2.4 GHz Wi-Fi and Bluetooth LE.
- ST7305 monochrome reflective LCD, 300 × 400 pixels (400 × 300 landscape).
  No backlight: readable in ambient light, not self-illuminating in darkness.
  It is an LCD, not an e-paper panel with a power-off image-retention promise.
- Two microphones, ES7210 ADC, ES8311 DAC, amplifier and supplied 8-ohm 2 W
  speaker. SPI/I2S/I2C pins are confirmed against the vendor schematic and
  factory boot logs, not another Waveshare board's pinout.
- SHTC3 temperature/humidity sensor, PCF85063 RTC with backup battery header,
  microSD slot, GPIO expansion, USB-C flashing/logging, 18650 holder and
  charging circuit. The `-EN` package is sold without the 18650 battery.

The current firmware uses the screen, KEY, Wi-Fi, microphone and speaker.
Bluetooth, microSD, sensors, RTC and battery monitoring are hardware expansion
options, not capabilities this firmware currently exposes to the agent.
The conversational model runs in the existing cloud voice service; it is not
an on-device LLM.

## Builds

`waveshare_s3_rlcd_hello` is the offline display/button proof. It needs no
network configuration to run. `waveshare_s3_rlcd` is the voice target.
Only the voice target is published on k.iterate.com. The Hello World target
is a local hardware diagnostic. Both reserve `iterate_kit` at `0x410000`;
the voice installer performs the normal project/Wi-Fi preparation.

Use ESP-IDF **5.4.2** for the Kit release pipeline. Although the vendor's
current examples request 5.5+, this small driver needs no 5.5 APIs, and Kit's
existing guarded TCP transport patch is incompatible with 5.5.3. The initial
Hello World proof also built and ran with 5.5.3.

```sh
export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.4_py3.14_env"
source "$HOME/esp/esp-idf/export.sh"
idf.py -C apps/kit/firmware/targets/waveshare_s3_rlcd \
  -B /tmp/iterate-rlcd-voice -D IDF_TARGET=esp32s3 \
  -D SDKCONFIG=/tmp/iterate-rlcd-voice.sdkconfig build
```

## Audio scope

This initial port uses standard stereo I2S at 16 kHz / 16 bits, selecting
ES7210 MIC1 for uplink and MIC2 for the local diagnostic meter. The ADC's MIC3
has an analogue loudspeaker reference in the schematic; it is not read by
this initial two-channel port. `softwareAec: 0` is explicit in health.
Do not describe the two microphones or reference circuit as built-in echo
cancellation. Unlike HAVPE, this board has no XMOS voice processor.

Capture remains continuous throughout calls. There is no push-to-talk or
speaker-dependent microphone gate. Gain is 24 dB at the ADC plus fixed 16x digital make-up gain; speaker volume
is capped conservatively. Room echo, distance and barge-in need separate
measurements before treating this experimental target as a HAVPE replacement.

## Agent-controlled images

The agent uses `itx.cd("/").voice.setImage({ device: "waveshare_rlcd_4_2",
image: { html } })`; passing `image: null` to that same setter restores the
normal status screen. New Waveshare conversations receive the canonical
[Markdown drawing guide](../../../../os-next/examples/voice-agent/screen-context.md)
as a `context-added` event. It includes a tested pixel-font layout, borders,
SVG/canvas alignment, font loading and source references.

The shared `capabilities/screen` module advertises resolution and supported
formats through `screen.info()`: this panel exposes 400 × 300 `mono1`.
The board initializes ST7305 with `0x20` (normal polarity): a set `mono1`
bit is black, and zero is white. The vendor's `0x21` setting reverses our
pixels, making both status text and uploaded images appear as negatives.
Cloudflare Chromium uses those dimensions; server-side conversion handles
monochrome, grayscale or RGB565 according to the target's advertised formats.
`screen.setImage` stages bounded chunks, including the selected format, and
writes the panel only once a complete frame arrives. `screen.status()` reports
refresh completion. The same protocol serves NOTE4's slower grayscale panel.
PNG, fonts and HTML stay off the device. Health exposes upload counts,
failures and whether an image is shown. The voice loop advertises screen
presence from its registered capability rather than a server board-name list.

The font is a 2,492-byte printable-ASCII subset of Press Start 2P, licensed
under the SIL OFL. The voice installer embeds it into the project's
`screen-font.css` KV entry, so each HTML render needs no external
font request. The tested example's complete screenshot contains zero grey
pixels; its text and rules survive one-bit conversion exactly.

Bench timing, 2026-09-21: three fresh-HTML calls took 648–1,537 ms from the
remote caller through the final panel-write acknowledgment; identical repeats
took 337–356 ms. Those figures exclude model generation and optical LCD
settling. A real delegated-model test produced a new image and its completion
reply in 8.105 seconds, with the upload count increasing and zero errors.

## Retained bench evidence — 2026-09-21

Identified unit: USB serial / ROM MAC `94:A9:90:CD:51:B8`. Resolve the current
port with `firmware/tools/port-for-mac.sh`; never rely on the observed
`/dev/cu.usbmodem11201` remaining stable.

- Factory boot: `03_Fac`, ESP-IDF 5.5.2, 16 MiB flash, 8 MiB PSRAM.
- Full 16 MiB factory backup SHA-256:
  `bcc1a40deab31029bcc28700a255ace1f4dd1454dc2fd79cdc3c4e70a8866c86`.
- Hello World flashed, hashes verified, boot logged success. Jonas confirmed
  the visible display and KEY press; serial independently recorded the press.
- Voice firmware flashed with the existing idle HAVPE's provisioning image
  (same bench grant), targeting the canonical project behind `prj-kit-bench`
  on `https://os.iterate2.com`. No credential is in source or public firmware.
- First air-path proof: call active in 3052 ms; response transcript `Banana.`,
  55 speaker writes, no codec capture/playback or display failures. The proof
  captured no input transcript; its answer-only PASS was not treated as proof
  of input transcription accuracy. A subsequent arithmetic test failed at
  unity gain. After the board-only 16x gain correction, it transcribed
  “What does 18 plus 19? Please answer with just the result”, answered “37”,
  and passed in a call that opened in 2532 ms with no reported errors.
  Post-call health: no codec capture/playback or display failures; 18 clipped
  samples were counted, so gain and echo still need broader room testing.
- Shared firmware host tests: 64/64. Kit tests: 16/16. Kit typecheck and production web build passed.
- Release pipeline built and synced seven releases across the six boards.
  The new files are local artifacts, not a deployment to `k.iterate.com`.

## Vendor references

- [Board documentation](https://docs.waveshare.com/ESP32-S3-RLCD-4.2)
- [Schematic](https://files.waveshare.com/wiki/ESP32-S3-RLCD-4.2/ESP32-S3-RLCD-4.2-schematic.pdf)
- [Vendor source](https://github.com/waveshareteam/ESP32-S3-RLCD-4.2)
- [Product and package contents](https://www.waveshare.com/product/arduino/boards-kits/esp32-s3/esp32-s3-rlcd-4.2.htm)

The ST7305 register sequence and landscape pixel packing are adapted from
Waveshare's Apache-2.0 example; see `NOTICE.md` and `LICENSE.waveshare.md`.
