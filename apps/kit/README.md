# Iterate Kit

Kit Flasher is the browser installer at `https://k.iterate.com` for the five
supported ESP32-S3 voice boards: HA Voice PE, FutureProofHomes Satellite1, M5StickS3,
StackChan and Waveshare AMOLED. It prepares the selected project, then flashes
a checked source-built release and its private configuration directly over USB.

## What a person needs

Choose a board release, enter Wi-Fi, the OS URL, project slug and that project's
API key, then click **Prepare device** and **Flash device**. The prepare step installs
this Kit build's isolated VoiceAgent guest, checks `/secrets/openai`, resolves
the canonical project ID, and returns `/agents/voice/v23/<device_id>`. It
requires a valid OS host, project slug/key and no active call before writing.

Wi-Fi stays in browser memory until it is written to the connected board's
`iterate_kit` partition. The project key authenticates directly to the chosen OS
host and is also written to the board. Neither credential goes to the Kit worker
or a URL. The board validates the versioned CRC-protected image at boot, joins Wi-Fi, authenticates,
mounts `/clients/<device_id>` and is ready for its activation button or optional
wake word.

## Release a firmware build

Kit publishes from source, never from a third-party binary URL. The reviewed
five-target inventory and flash layout are in
[`src/firmware/catalog.ts`](./src/firmware/catalog.ts). With ESP-IDF active:

```sh
cd apps/kit
source "$IDF_PATH/export.sh"
pnpm firmware:release
pnpm firmware:sync
```

`firmware:release` builds every catalog target into a fingerprinted local cache,
checks ESP-IDF's flash plan and `iterate_kit` partition against the catalogue,
and records a hash for each generated part. `firmware:sync` accepts only that
current cache, copies the hashed parts into `public/firmware`, and writes ESP
Web Tools manifests. `pnpm build` runs sync before the web build.

Sound assets are checked in; avatar sources are generated locally from their
tracked atlases. Releasing existing boards needs no TTS request. Run host tests
before release:

```sh
pnpm firmware:test:host
```

For board structure, hardware requirements, target builds and air-path proof,
see the [firmware guide](./firmware/README.md). The installer does not replace
that hardware validation.
