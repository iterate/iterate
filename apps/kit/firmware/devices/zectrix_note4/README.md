# ZECTRIX NOTE4

ESP32-S3, 16 MiB flash, 8 MiB PSRAM, 400 × 300 SSD2683 e-paper and ES8311
microphone/speaker. This is the monochrome NOTE4, not NOTE4C. Reference source
and license: [NOTICE.md](NOTICE.md). Catalog: `zectrix-note4`;
remote client: `itx.clients.zectrix_note4`.

## Hardware constraints

- **OK / GPIO0** starts/ends calls; hold during reset/reconnection for ROM recovery.
- GPIO17 latches battery power, GPIO42 powers the codec, GPIO46 enables the amp.
  Release inherited factory GPIO holds before configuration; hold GPIO17 only
  after driving it high. A held-low amp can accept PCM without producing sound.
- I2C: SDA47/SCL48. I2S: MCLK14/BCLK15/WS38/DOUT45/DIN16, 16 kHz mono 16-bit.
  Select the **left slot explicitly for RX and TX**: IDF 5.4's S3 Philips macro
  defaults to BOTH even in MONO, producing alternating real/zero samples.
- Vendor mic gain is 30 dB; speaker volume is capped. Side buttons, NFC, RTC and
  battery management are not exposed. Capture has no local AEC/noise suppression.
  The [schematic](https://wiki.zectrix.com/sch_zectrix_note4_developer_kit_v1.0_en.pdf)
  has no dedicated voice DSP. Room echo and barge-in remain unverified.

## Build and recovery

Activate ESP-IDF 5.4.2, then run:

```sh
idf.py -C apps/kit/firmware/targets/zectrix_note4 \
  -B /tmp/iterate-note4-voice -D IDF_TARGET=esp32s3 \
  -D SDKCONFIG=/tmp/iterate-note4-voice.sdkconfig build
```

Configuration is at `0x410000`; credentials never belong in source/releases.
Identify the bench unit by MAC `80:45:6B:38:60:84` using `tools/port-for-mac.sh`.
Factory boot: `zectrix-s3-epaper-4.2`, xiaozhi 3.6.2, ESP-IDF 5.5.2.
Private full-flash backup (16 MiB, restore at offset zero):
`~/.local/share/iterate-kit/backups/note4-80456b386084/factory-2026-09-21.bin`.
SHA-256: `c18514a31e710c32b8bed086f277e4365830056214f3fcadc5b3b323f1d8241f`.
No eFuses were changed; the backup includes factory identity.

## Display

`screen.info()` advertises 400 × 300, preferred `mono1`, optional `gray4`, partial
refresh and a 45-second deadline. The adapter inverts mono1 (1=black) for the
vendor API (1=white). Gray4 packs the left pixel in the high nibble, 0=black.

```ts
await itx.cd("/").voice.setImage({
  device: "zectrix_note4",
  image: { html: "<body style='margin:0'>Hello NOTE4</body>", format: "gray4" },
});
// Restore the voice status screen with the same setter and image: null.
```

The shared screen protocol stages bounded chunks. One display task owns the
pending buffer and keeps refreshes off the voice loop; concurrent uploads fail
as busy. The last chunk is answered once the refresh has shown or failed; `shown: true`
acknowledges the controller, not optical output. A panel failure stops refreshes until reboot.
Status updates coalesce; mono uses a full refresh every twentieth update and
after grayscale. Uploaded images remain until cleared. Drawing instructions:
[screen-context.md](../../../../../packages/voice/src/screen-context.md).

The driver retains five 535-byte vendor calibration tables and shade mapping,
verified against the reference. Mono uses controller OTP waveforms; unused
experimental waveform generators are omitted.

## Bench evidence — 2026-09-21

Flash hashes verified. Installed-service refresh: mono 2.48 s, gray 8.48 s,
zero display/upload/protocol failures; optical grayscale awaits confirmation.
Renderer coverage includes odd-width rows, RGB565 and rejected/failed uploads.
After the I2S fix, an air-path call transcribed 18 + 19 and answered 37 with
123 speaker writes and no reported errors, but the user reported silence.
After the GPIO-hold fix, a speaker-only probe measured 1,413–2,700 microphone
RMS during playback versus 47–70 with DAC muted. Calls ended and volume returned
to 70. This supports acoustic output; loudness/intelligibility remain unverified.
