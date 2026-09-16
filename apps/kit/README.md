# Iterate Kit

Kit Flasher is the browser installer at `https://k.iterate.com` for the five
supported ESP32-S3 voice boards: HA Voice PE, FutureProofHomes Satellite1, M5StickS3,
StackChan and Waveshare AMOLED. Its catalog also names the boards that
`voicelab boards` proves through real air. It prepares the selected project,
then flashes a checked source-built release and its private configuration directly over USB.

## What a person needs

Sign in with your Iterate account (the page sends you through OS's OAuth and
back), choose a board release, enter Wi-Fi, pick one of your projects, then click
**Prepare device** and **Flash device**. The prepare step checks that the project
has a voice agent installed (`apps/os-next/scripts/voice-install.ts` installs it;
the project also needs `/secrets/openai`) and mints a ten-year personal access
token scoped to that project, named `Kit <board> <date>` in your OS sessions list.
The token is written to the board and revoked from that list, never refreshed.

Wi-Fi and the token stay in browser memory until they are written to the
connected board's `iterate_kit` partition. Neither goes to the Kit worker or a
URL. The board validates the versioned CRC-protected image at boot, joins Wi-Fi,
presents the token as a bearer on OS's `/api`, and is ready for its activation
button or optional wake word.

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
