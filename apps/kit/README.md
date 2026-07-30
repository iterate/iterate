# Iterate Kit

`apps/kit` is the small device installer served at `https://k.iterate.com`.
The first supported hardware class is selected ESP32-S3 devices installed
through [ESP Web Tools](https://esphome.github.io/esp-web-tools/).

## Firmware model

The source of truth is
[`src/firmware/catalog.ts`](./src/firmware/catalog.ts). Device identity,
install method, and release artifact are separate:

- `installMethod` is a discriminated union for `esp-web-tools`,
  `uf2-download`, `webusb-dfu`, or an `external-tool`.
- each release has an independently discriminated artifact;
- ESP releases name every immutable source URL, flash offset, file name, and
  expected SHA-256, plus the reserved configuration partition.

Only ESP Web Tools is implemented in the UI today. The wider model prevents a
future RP2040, Nordic, STM32, or other board from being incorrectly treated as
an ESP merely because it can be installed from a browser.

The two devices currently have no releases on purpose. Stock Home Assistant
Voice and StackChan firmware does not understand Iterate project credentials,
so presenting it as a working Kit image would create a successful flash and a
non-working device. Add the first release only when an Iterate-aware build and
its partition layout exist.

## Bundled assets

`pnpm firmware:sync`:

1. downloads every catalog artifact over HTTPS;
2. rejects any SHA-256 mismatch, unsafe path, or overlapping ESP flash region;
3. emits local ESP Web Tools manifests and binaries under `public/firmware`;
4. emits a public, source-URL-free `catalog.json`.

`pnpm build` runs the sync first. Vite and the Cloudflare plugin then include
the generated directory in the Worker's static assets, so a production flash
does not depend on a third-party firmware host. The generated assets are
gitignored; the reviewed catalog and checksums remain the durable source.

## Private configuration

For an ESP release, the page creates a dynamic ESP Web Tools manifest in the
browser. It adds one generated binary part at the release's declared
configuration offset. Wi-Fi and Iterate credentials therefore travel directly
from browser memory to the connected device and never enter a URL or request
to the Kit Worker.

The raw `iterate-kit/v1` partition is:

| Offset   | Value                            |
| -------- | -------------------------------- |
| `0..7`   | ASCII `ITERKIT1`                 |
| `8..11`  | little-endian JSON byte length   |
| `12..15` | little-endian CRC-32 of the JSON |
| `16..`   | UTF-8 JSON, padded with `0xff`   |

The JSON contains Wi-Fi SSID/password and Iterate `baseUrl`, project slug, and
Project API key. OS resolves the immutable slug to its stable project ID before
checking the key revealed from `/secrets/project-api-key`, so the setup flow
does not expose internal project identity.

Firmware should parse this partition at boot, reject an unknown magic/version
or checksum mismatch explicitly, and retain Improv Wi-Fi or a local recovery
path for credential rotation.
