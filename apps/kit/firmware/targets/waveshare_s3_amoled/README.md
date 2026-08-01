# Waveshare ESP32-S3 Touch AMOLED — the Iterate voice device

A complete voice device on one Cap'n Web WebSocket to `/api`: microphone audio
goes up as ephemeral `voicelab/mic-frame` stream events, the answer comes back
as `voicelab/spk-frame` events through a live `openConnection` callback and
plays on the ES8311 speaker, and the screen shows the call state and the
transcript as it arrives.

**Nothing runs off-device.** Pressing call asks the project's own userspace
`worker.ts` to open the Grok session (`itx.worker.startCall`) over the socket
the device already holds; the worker holds that session detached. No laptop
bridge, no second connection.

Turn taking is **manual**, like the M5StickS3 — no VAD anywhere. The upper
side button toggles the call, the lower one is held while speaking. That is
also the whole echo story on a board with no AEC reference: the microphone is
only ever on the wire while the button is down, and pressing it cancels the
answer in flight rather than talking over it.

A deliberate departure from the dual-WebSocket decision in
`apps/kit/docs/fable-v2-plan/DECISIONS.md` — this target exists to answer
whether realtime PCM survives a single control socket. It does.

## The capability

The device mounts itself at `itx.kit.waveshare`, and everything a person can
do at the board an agent can do remotely through the same intent flags:

```ts
await itx.kit.waveshare.conversation.start(); // = upper button
await itx.kit.waveshare.pushToTalk.start(); // = holding the lower button
await itx.kit.waveshare.pushToTalk.stop(); // release: commits the turn
await itx.kit.waveshare.conversation.hangUp();
await itx.kit.waveshare.setBackground("#1e293b"); // or "navy", "teal", …

const meta = await itx.kit.waveshare.takeScreenshot(); // {width,height,chunks,…}
const part = await itx.kit.waveshare.readScreenshotChunk(0); // bytes

await itx.kit.waveshare.recording.status(); // {card,recording,written,onDisk}
await itx.kit.waveshare.recording.size("mic.pcm");
await itx.kit.waveshare.recording.read("mic.pcm", 0); // bytes

await itx.kit.waveshare.setVolume(85); // 0-100; 100 audibly distorts, see below
await itx.kit.waveshare.setMicGain(30); // dB, 0-48
```

## The device can measure its own audio

Because it can play a tone and record with its own microphone, its analog
chain is measurable without ears or a scope: append `voicelab/spk-frame`
events carrying a sine, hold `pushToTalk`, then pull `mic.pcm` back and
compare harmonics to the fundamental. That is how the volume ceiling below
was found, and how "is this static or a dropout?" stops being a matter of
opinion. `pnpm cli voicelab device --action tone` sends the tone.

## Every call is recorded

A call wipes `/sdcard/iterate` and writes `mic.pcm` (exactly what went on the
wire), `speaker.pcm` (exactly what was played) and `call.log` (turn edges,
transcript lines, errors). Both PCM files are 16 kHz mono S16LE. This is the
only honest way to argue about echo, clipping or dropouts, and it is how the
uplink bug below was found.

## Building and flashing

ESP-IDF v5.4.x, board on USB. Resolve the port by the board's stable USB
serial, never by the `usbmodemNNN` suffix — see
`firmware/docs/connected-device-inventory.md`; the Waveshare is
`1C:DB:D4:7A:16:C8`.

```sh
source ~/esp/esp-idf/export.sh
cd apps/kit/firmware
idf.py -C targets/waveshare_s3_amoled -B ../../.build/waveshare_s3_amoled build
idf.py -C targets/waveshare_s3_amoled -B ../../.build/waveshare_s3_amoled \
  -p /dev/cu.usbmodemXXXX -b 921600 flash
```

Provisioning (Wi-Fi + project key) lives in the `iterate_kit` partition at
`0x410000`; see `apps/kit/src/firmware/config-image.ts`. The project needs the
voicelab `worker.ts` deployed (`apps/os/scripts/voicelab/config-repo/`) and an
`xai` secret.

## Driving it without hands

From `apps/os`, with a Doppler config pointing at the deployment:

```sh
pnpm cli voicelab device --action status     --project prj_…
pnpm cli voicelab device --action call       --project prj_…
pnpm cli voicelab device --action turn       --project prj_… --seconds 3
pnpm cli voicelab device --action pull       --project prj_… --out ./recording
pnpm cli voicelab device --action screenshot --project prj_… --out screen.png
```

`pull` writes the PCM lanes as WAVs, so they open in anything.

## Board facts that cost real time

- **The panel, the touch controller and their neighbours only leave reset when
  EXIO0/1/2/6 on the TCA9554 are pulsed LOW for 20 ms and then HIGH**, exactly
  as Waveshare's own sketches do. Nothing in the BSP does it (its
  `BSP_LCD_RST` is "not connected"), so without the pulse the vendor's own
  LVGL demo is black on this board too. Display bring-up therefore precedes
  the codec's — they share those lines.
- **Internal RAM is the Wi-Fi driver's budget.** The BSP's default 100-line
  LVGL buffer is 73 KiB from `MALLOC_CAP_DEFAULT`, so it can land in PSRAM,
  and every flush then wants an equally large internal bounce buffer for SPI
  DMA. At 40-line internal stripes the station associated but never completed
  DHCP. 24 lines leaves ~150 KiB free and DHCP lands in 4 s.
- **The SH8601 takes QSPI windows in even pairs.** An odd-edged flush lands
  shifted — stale rectangles where a label was redrawn — so invalidated areas
  are snapped outwards.
- **FatFs only writes a directory entry on sync**, so `stat` of a file that is
  still open reports the size it had when created: zero. Readers sync first.
- **The BSP's `bsp_display_start()` is unusable on this panel.** It registers
  the QSPI panel through `lvgl_port_add_disp_rgb()`, which writes five
  pointers past the end of a 64-byte `sh8601_panel_t` — into the heap the SPI
  driver allocates from — and it silently discards the buffer flags you pass
  it, leaving the draw buffer in PSRAM so every flush needs a full-size
  internal bounce allocation. Bring the panel up with `bsp_display_new` +
  `lvgl_port_add_disp` and DMA-capable internal buffers.
- **`CONFIG_ESP_MAIN_TASK_PRIORITY` does not exist.** The app task is fixed at
  priority 1; if it matters, call `vTaskPrioritySet` at the top of
  `app_main`.
- **One ES8311 instance, one `IN_OUT` handle.** Two `esp_codec_dev` handles
  over one I2S data interface means the second `open()` disables both
  channels and rewrites the slot config the first just set — which reads as
  broadband noise on the microphone and invites a bogus `no_dac_ref`
  workaround.

## The outbound message rate is the budget, not bandwidth

The taskless control socket sustains roughly 25–50 TLS messages per second and
every one-way append costs **two** of them (push + release). At 4 frames per
append that is 25 messages/s — exactly the ceiling — and a batch was skipped
whenever the outbox was short. Measured: a 3 s turn put 43,520 bytes on the
wire where realtime is 96,000.

Now 8 frames (160 ms) per append is 12.5 messages/s, and the drain window
advances only on a batch that actually went out — the 640 ms mic queue absorbs
the wait. Measured after: a 3 s hold captures 3.20 s.

## Volume: full scale is not the loudest useful setting

Measured by acoustic loopback, 440 Hz, second harmonic relative to the
fundamental:

| volume | 2nd harmonic |                                            |
| ------ | ------------ | ------------------------------------------ |
| 100    | −16.8 dB     | distorting — and still distorting with the |
|        |              | mic at 6 dB and 13 dB below clipping, so   |
|        |              | it is the amplifier, not mic saturation    |
| 60     | −34.9 dB     | clean                                      |

So "turn it all the way up" makes this speaker worse rather than louder. The
default is 85; `setVolume` tunes it live.

## Known limits

- No AEC. Push-to-talk is what makes that fine; a continuously open microphone
  next to this speaker hears itself.
- One call per stream. Starting a second supersedes the first — before that
  fix two bridges answered every turn and their audio interleaved.
- Long filenames are off in the FatFs config, so recording names are 8.3.
- A released turn waits up to 1.5 s for the uplink to drain before
  committing. If it times out the call log says "tail dropped" rather than
  truncating the utterance silently.
