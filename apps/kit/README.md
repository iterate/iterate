# Iterate Kit

`apps/kit` is the small device installer served at `https://k.iterate.com`.
The first supported hardware class is selected ESP32-S3 devices installed
through the headless [esptool-js](https://github.com/espressif/esptool-js)
Web Serial API.

## Firmware model

The source of truth is
[`src/firmware/catalog.ts`](./src/firmware/catalog.ts). Device identity,
install method, and release artifact are separate:

- `installMethod` is a discriminated union for `esp-serial`,
  `uf2-download`, `webusb-dfu`, or an `external-tool`.
- each release has an independently discriminated artifact;
- ESP releases name every immutable source URL, flash offset, file name, and
  expected SHA-256, plus the reserved configuration partition.

Only ESP serial flashing is implemented in the UI today. The wider model prevents a
future RP2040, Nordic, STM32, or other board from being incorrectly treated as
an ESP merely because it can be installed from a browser.

The devices currently have no releases on purpose. Stock Home Assistant
Voice and StackChan firmware does not understand Iterate project credentials,
so presenting it as a working Kit image would create a successful flash and a
non-working device. Add the first release only when an Iterate-aware build and
its partition layout exist.

## Bundled assets

`pnpm firmware:sync`:

1. downloads every catalog artifact over HTTPS;
2. rejects any SHA-256 mismatch, unsafe path, or overlapping ESP flash region;
3. emits verified binaries under `public/firmware`;
4. emits a public, source-URL-free `catalog.json`.

`pnpm build` runs the sync first. Vite and the Cloudflare plugin then include
the generated directory in the Worker's static assets, so a production flash
does not depend on a third-party firmware host. The generated assets are
gitignored; the reviewed catalog and checksums remain the durable source.

## Private configuration

For an ESP release, the browser and CLI use the same typed flash-plan builder.
It verifies every catalog digest and adds one generated binary part at the
release's declared configuration offset. The browser drives `esptool-js`
directly, so Wi-Fi and Iterate credentials travel from browser memory to the
connected device and never enter a URL or request to the Kit Worker.

The raw `iterate-kit/v1` partition is:

| Offset   | Value                            |
| -------- | -------------------------------- |
| `0..7`   | ASCII `ITERKIT1`                 |
| `8..11`  | little-endian TLV payload byte length |
| `12..15` | little-endian CRC-32 of the payload   |
| `16..`   | bounded UTF-8 TLV fields, then `0xff` |

The five fields are Wi-Fi SSID/password and Iterate `baseUrl`, stable
`prj_…` project ID, and Project API key. The decoder uses fixed buffers and
does not allocate.

Firmware should parse this partition at boot, reject an unknown magic/version
or checksum mismatch explicitly, and clear credential buffers after every
failure.

## Runtime WebSockets

The device uses two independent WebSocket connections:

1. The control socket is ordinary Cap'n Web. It accepts text, continuation,
   ping, pong, and close frames only. A binary frame is a classified protocol
   failure; PCM is never multiplexed into this connection.
2. The PCM socket uses the `iterate.kit.pcm.v1` WebSocket subprotocol. It
   accepts binary messages only and has its own bounded queues, reconnect
   lifecycle, backpressure, and metrics.

PCM v1 deliberately has no per-frame application header. The control plane
negotiates immutable uplink and downlink shapes before opening the PCM socket:
encoding, sample rate, channel count, and samples per channel. One binary
WebSocket message is exactly one signed 16-bit little-endian PCM frame;
direction is implied by its sender, and WebSocket ordering supplies frame
ordering. This avoids a second copy and per-frame parsing on the device. The
proxy is responsible for rechunking or resampling provider audio to the
negotiated shape.

Push-to-talk, interruption, listening state, transcriptions, and every other
non-PCM event stay on the Cap'n Web capability/event plane. A failure or
backpressure event on one socket must not silently discard, restart, or poison
the other socket.

The local userspace proof connects `/pcm` to xAI without involving `apps/os`.
It rejects a deliberately invalid project bearer over the public tunnel before
opening any provider connection, mints an ephemeral xAI WebSocket credential
using the server-only API key, streams raw 16 kHz PCM in both directions, and
prints every non-PCM provider event as the frame that would later be posted to
the device stream:

```bash
doppler run --project voice --config dev_jonas -- pnpm --dir apps/kit voice:e2e
```

By default the harness synthesizes its input with macOS `say`; set
`ITERATE_KIT_VOICE_PCM_FILE` to test anywhere with an existing raw mono
PCM16LE 16 kHz recording. Neither the project bearer nor the xAI key is
printed.

## Local firmware CLI

The browser and CLI both use `prepareFirmwareFlashPlan`, including digest
verification, overlap checks, and the exact same configuration encoder. For a
local ESP-IDF build:

```bash
ITERATE_KIT_WIFI_PASSWORD=... \
ITERATE_KIT_PROJECT_API_KEY=... \
pnpm firmware:flash -- \
  --port /dev/cu.usbmodemNNN \
  --wifi-ssid ... \
  --project-id prj_...
```

Use `--dry-run` to validate and print offsets and byte counts without opening
the serial port. Secret values are accepted only through environment variables
and are never printed or placed in esptool arguments.
