# Waveshare ESP32-S3 RLCD 4.2

Catalog: `waveshare-rlcd-4-2`; client: `itx.clients.waveshare_rlcd_4_2`.
Uses the shared Kit voice loop. Hardware: ESP32-S3 N16R8, 16 MiB flash,
8 MiB PSRAM, ST7305 reflective monochrome LCD (400 × 300 landscape),
ES7210 ADC, ES8311 DAC, two microphones and an 8-ohm 2 W speaker.
The panel needs ambient light; it has no backlight and is not e-paper.

## Controls and audio

- **KEY / GPIO18** starts/ends a call. **BOOT / GPIO0** is ROM recovery;
  **PWR** is the hardware power button.
- 16 kHz / 16-bit stereo I2S: MIC1 feeds voice, MIC2 the diagnostic meter.
  The schematic's MIC3 speaker reference is unused. No XMOS/local AEC;
  `softwareAec: 0` is explicit in health.
- Capture stays continuous. ADC gain is 24 dB plus fixed 16x digital gain;
  speaker volume is capped. Echo, distance and barge-in remain experimental.
- RTC, sensors, microSD, Bluetooth and battery monitoring are not exposed.

## Build and recovery

Activate ESP-IDF **5.4.2**, then run:

```sh
idf.py -C apps/kit/firmware/targets/waveshare_s3_rlcd \
  -B /tmp/iterate-rlcd-voice -D IDF_TARGET=esp32s3 \
  -D SDKCONFIG=/tmp/iterate-rlcd-voice.sdkconfig build
```

The driver needs no vendor-example 5.5 APIs; Kit's TCP transport patch is
incompatible with 5.5.3. The voice target reserves configuration at `0x410000`.

Identify MAC `94:A9:90:CD:51:B8` using `tools/port-for-mac.sh`; USB paths change.
Factory boot: `03_Fac`, IDF 5.5.2. Private 16 MiB factory-backup SHA-256:
`bcc1a40deab31029bcc28700a255ace1f4dd1454dc2fd79cdc3c4e70a8866c86`.
Provisioning targets the canonical `prj-kit-bench` project on os.iterate2.com;
credentials are excluded from source and public releases.

## Display

```ts
await itx.cd("/").voice.setImage({
  device: "waveshare_rlcd_4_2",
  image: { html: "<h1>Hello</h1>" },
});
// Pass image: null to restore the voice status screen.
```

The shared screen protocol advertises 400 × 300 `mono1`, stages bounded chunks
and writes only complete frames. ST7305 command **0x20** gives the required
1=black polarity; the vendor's 0x21 setting inverts our pixels. The setter waits
for `screen.status()` refresh completion. Health exposes uploads and failures.
HTML, fonts and conversion stay on the server. The
[drawing guide](../../../../agents/voice/screen-context.md)
is supplied through the screen capability, with a licensed ASCII pixel font
embedded in project KV; it needs no external font fetch.

## Bench evidence — 2026-09-21

Flash hashes verified; Jonas confirmed the Hello World display and KEY press.
The first answer-only air-path check did not prove capture. After the 16x gain
fix, a call opened in 2.53 s, transcribed 18 + 19 and answered 37 with no codec
or display failures; 18 clipped samples mean broader gain/echo testing remains.
Fresh HTML took 648–1,537 ms to panel-write acknowledgement; repeats 337–356 ms.
A delegated-model update took 8.1 s with increasing upload count and zero errors.
These timings exclude optical settling; the pixel-font example rendered without
grey pixels. Seven voice models are now published by the Kit release pipeline.

## References

[Board docs](https://docs.waveshare.com/ESP32-S3-RLCD-4.2) ·
[schematic](https://files.waveshare.com/wiki/ESP32-S3-RLCD-4.2/ESP32-S3-RLCD-4.2-schematic.pdf) ·
[vendor source](https://github.com/waveshareteam/ESP32-S3-RLCD-4.2).
Register initialization and pixel packing derive from the Apache-2.0 example;
see [NOTICE.md](NOTICE.md) and [LICENSE.waveshare.md](LICENSE.waveshare.md).
