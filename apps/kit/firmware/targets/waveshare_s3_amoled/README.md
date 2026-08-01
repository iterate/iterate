# Waveshare ESP32-S3 Touch AMOLED — voicelab voice client

Talks to Grok Voice over **one** Cap'n Web WebSocket to `/api`: microphone
audio goes up as ephemeral `voicelab/mic-frame` stream events, Grok's answer
comes back as `voicelab/spk-frame` events through a live `openConnection`
callback and plays on the ES8311 speaker. A voicelab bridge (a node process
or a userspace `worker.ts`) sits on the same stream and holds the Grok
session.

This is a measurement target, and a deliberate departure from the
dual-WebSocket decision in `apps/kit/docs/fable-v2-plan/DECISIONS.md` — it
exists to answer whether realtime PCM survives the single control socket.

## Testing it on the device

You need: ESP-IDF v5.4.x, the board on USB, a project on some OS deployment,
and an xAI key for the bridge.

**1. Build**

```sh
source ~/esp/esp-idf/export.sh
cd apps/kit/firmware
idf.py -C targets/waveshare_s3_amoled -B ../.build/waveshare-s3-amoled build
```

**2. Flash firmware + provisioning in one shot.** Resolve the port by the
board's stable USB serial, never by the `usbmodemNNN` suffix — see
`firmware/docs/connected-device-inventory.md`. The Waveshare is
`1C:DB:D4:7A:16:C8`:

```sh
port=$(python -m serial.tools.list_ports -v | grep -B3 "SER=1C:DB:D4:7A:16:C8" \
  | grep "^/dev/cu" | tail -1)

cd apps/kit
ITERATE_KIT_WIFI_PASSWORD=... \
ITERATE_KIT_PROJECT_API_KEY=... \
pnpm firmware:flash -- \
  --device waveshare-s3-amoled \
  --port "$port" \
  --wifi-ssid <ssid> \
  --project-id prj_... \
  --base-url https://os.iterate-preview-N.com
```

Secrets are environment-only by design. `--dry-run` prints the exact flash
plan (the `iterate-kit/v1` config partition is discovered from the compiled
partition table, so no offset to remember). The project API key is
`itx.secrets.get("/secrets/project-api-key").reveal()` on that project.

**3. Start a bridge** on the device's stream, from `apps/os`:

```sh
XAI_API_KEY=... doppler run --config preview_N -- pnpm cli voicelab bridge \
  --project prj_... --path /voicelab/dev-waveshare --pace-device
```

`--pace-device` drips Grok's answer at ~2× realtime instead of one burst,
which a device with a bounded inbox needs. Add `--greet "Say hello"` to make
Grok speak first — handy for testing the speaker without saying anything.

**4. Start a call** and then just talk to the board:

```sh
doppler run --config preview_N -- pnpm cli itx run --context prj_... \
  -e 'return await itx.streams.get("/voicelab/dev-waveshare").append({
        type: "voicelab/call-requested",
        payload: { callId: "wsdev", effort: "none" } })'
```

**5. Watch what happened.** The stream is the observability channel —
opening the USB console resets the board:

```sh
doppler run --config preview_N -- pnpm cli itx run --context prj_... -e '
  const heard = []; const said = [];
  using c = await itx.streams.get("/voicelab/dev-waveshare").openConnection({
    connectionKey: "watch", eventTypes: ["voicelab/grok-event"],
    processEventBatch: (b) => {
      for (const e of b.events) {
        const g = e.payload?.event; if (!g) continue;
        if (g.type === "conversation.item.added" && g.item?.role === "user") {
          const t = g.item.content?.find((x) => x.type === "input_audio")?.transcript;
          if (t) heard.push(t);
        }
        if (g.type === "response.output_audio_transcript.done" && g.transcript) {
          said.push(g.transcript);
        }
      }
    },
  });
  await new Promise((r) => setTimeout(r, 40000));
  return { heard, said };'
```

Expected shape of a good run:

```json
{
  "heard": ["What is the capital of Finland? One short sentence."],
  "said": ["Helsinki is the capital of Finland."]
}
```

The device also appends a durable `voicelab/dev-stats` event every 5 s
(frames sent/failed, speaker frames received/played/overflowed, decode
failures, sequence gaps, ping RTT, heap, ring counters, session
generation) — subscribe to that event type the same way for a health view.

**Parking it.** The device streams 50 events/s whenever it is powered and
provisioned. To stop that without unflashing, blank the config partition:

```sh
python -c "open('/tmp/blank.bin','wb').write(b'\xff'*4096)"
python -m esptool --chip esp32s3 --port "$port" --before default_reset \
  --after hard_reset write_flash 0x410000 /tmp/blank.bin
```

It boots, logs `device is not provisioned`, and idles. Re-run step 2 to
bring it back.

## Reading captured audio off the stream

640 PCM bytes base64-encode to **854 characters, not a multiple of 4**.
Decode each frame separately. Joining the strings first misaligns every
frame after the first and produces convincing gain-independent broadband
noise that looks exactly like a dead microphone — this cost hours once
already.

```sh
# hex per frame, then concatenate — never concatenate the base64
... --eval 'return frames.map((f) => Buffer.from(f, "base64").toString("hex")).join("")'
```

Healthy speech through this microphone measures roughly: peak −24 dBFS,
RMS −42, crest factor 8, silences −68 dB (`sox -t raw -r 16000 -e signed
-b 16 -c 1 capture.pcm -n stats`).

## Known limits

- **No hardware AEC** on this board, so the microphone is gated to silence
  while the speaker plays plus a 900 ms tail. Voice barge-in during
  playback is therefore off; interrupting requires an AEC reference or an
  ES7210-class board.
- Mic PGA is 36 dB, tuned for a talker about a metre away.
- Audio bring-up details, the load-bearing codec settings, and two on-device
  diagnostics (`waveshare_audio_dump_registers`, `waveshare_audio_probe_din`)
  are documented in `main/waveshare_audio.c`.
