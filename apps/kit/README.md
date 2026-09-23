# Iterate Kit

Kit Flasher is the browser installer at `https://k.iterate.com` for the
supported ESP32-S3 voice boards: HA Voice PE, FutureProofHomes Satellite1, M5StickS3,
StackChan, Waveshare AMOLED, Waveshare RLCD 4.2 and ZECTRIX NOTE4. The RLCD has an
experimental KEY-button voice release; see its
[board notes](firmware/devices/waveshare_s3_rlcd/README.md). Its catalog names the boards
`apps/agents/scripts/voice-board.ts` proves through real air. It prepares the selected project,
then flashes a checked source-built release and its private configuration directly over USB.

## What a person needs

Choose your board at `k.iterate.com`, then click **Log in with iterate**. Consent
shows that board's name and vendor icon; choose its project and authorize access.
Each setup starts a unique OAuth client before consent, including two boards of
the same model. After sign-in, enter Wi-Fi, click **Prepare device**, then **Flash
device**. **Set up another device** returns to the public selector and starts fresh
consent; it never silently changes the authorized model.

Prepare installs voice when missing and asks for an OpenAI API key if the project
has none. It verifies voice health before minting a ten-year token scoped to the
chosen project, under the same OAuth client that was authorized. Existing voice
services, secrets and project websites are preserved. Immutable voice files live
under `kit/voice/` in project KV; the `itx.voice` mount is published only after all
uploads succeed. The installer is `apps/agents/voice/install.ts`, shared with voice.iterate.com,
which installs voice without a device.

Client metadata lives at `k.iterate.com/devices/<model>/clients/<uuid>.json`. The
flashed token appears as `Kit <board> <date>` with kind **Device** in your sessions
list and can be revoked individually. **Log out** ends only the browser's setup
session and returns to device selection; already flashed tokens keep working.
Previously provisioned tokens retain their existing identity until prepared again.
Local HTTP development uses the issuer's dynamic client registration with the same
branding; hosted previews exercise the actual metadata client and consent path.

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
Web Tools manifests. `pnpm deploy` runs sync before the web build; a per-PR preview serves
the installer without them. Deployment checks every installer
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
