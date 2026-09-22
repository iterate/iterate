# Iterate Kit

Kit Flasher is the browser installer at `https://k.iterate.com` for the
supported ESP32-S3 voice boards: HA Voice PE, FutureProofHomes Satellite1, M5StickS3,
StackChan, Waveshare AMOLED, Waveshare RLCD 4.2 and ZECTRIX NOTE4. The RLCD has an
experimental KEY-button voice release; see its
[board notes](firmware/devices/waveshare_s3_rlcd/README.md). Its catalog names the boards
`apps/os-next/scripts/voice-board.ts` proves through real air. It prepares the selected project,
then flashes a checked source-built release and its private configuration directly over USB.

## What a person needs

Sign in with your Iterate account (the page sends you through OS's OAuth and
back), choose a board release, enter Wi-Fi, pick one of your projects, then click
**Prepare device** and **Flash device**. The prepare step installs the voice agent when missing and asks for an OpenAI API
key if the project has none. It verifies voice health before minting a ten-year
token scoped to that project. Existing voice services and secrets are preserved.
The installer bundles the voice sources at build time, uploads immutable files
under `kit/voice/` in project KV, and publishes only the `itx.voice` mount after
all uploads succeed. Project websites and other apps are unchanged. Each preparation gets a unique OAuth client, with public metadata
at `k.iterate.com/devices/<model>/clients/<uuid>.json` and the vendor's icon.
It appears as `Kit <board> <date>` with kind **Device** in your sessions list.
The token is written to the board and revoked individually from that list,
never refreshed. Previously provisioned tokens retain their existing identity
until the device is prepared again.

Use **Log out** beside your account name to return to the sign-in page.

Wi-Fi and the token stay in browser memory until they are written to the
connected board's `iterate_kit` partition. Neither goes to the Kit worker or a
URL. The board validates the versioned CRC-protected image at boot, joins Wi-Fi,
presents the token as a bearer on OS's `/api`, and is ready for its activation
button or optional wake word.

## Release a firmware build

Kit publishes from source, never from a third-party binary URL. The reviewed
board inventory and flash layout are in
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
Web Tools manifests. `pnpm build` runs sync before the web build. Deployment checks every installer
route, verifies all public manifests and the catalog against the build, and
downloads every firmware part to compare its SHA-256 with the released bytes.
Run `pnpm exec tsx scripts/verify-firmware-assets.ts https://k.iterate.com`
to repeat the asset verification.

Sound assets are checked in; avatar sources are generated locally from their
tracked atlases. Releasing existing boards needs no TTS request. Run host tests
before release:

```sh
pnpm firmware:test:host
```

For board structure, hardware requirements, target builds and air-path proof,
see the [firmware guide](./firmware/README.md). The installer does not replace
that hardware validation.
