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

## Firmware releases

Every firmware change merged to main becomes a GitHub release of each board it
affects, tagged `kit-firmware/<device id>/<version>`, for example
`kit-firmware/home-assistant-voice-preview-edition/002574-2026-09-23-b2a4558`. The
version is main's first-parent commit count (six digits), the UTC commit date and
the short sha, so versions sort as strings; the board reports it in `X-Iterate-Fw`.
A release holds the build's flash files and `manifest.json`, a standard
[esp-web-tools manifest](https://esphome.github.io/esp-web-tools/) with one extra
field, `configurationPartition`, where Kit writes the install's configuration
image. `src/firmware/catalog.ts` (`firmwareReleaseTag`, `FIRMWARE_VERSION_PATTERN`)
and `scripts/firmware-release.ts` (`firmwareManifest`) own this contract.

The Kit Firmware workflow (`.depot/workflows/kit-firmware.yml`) builds a board
only when its inputs changed since its newest release: the firmware tree minus the
other boards' `devices/<board>` and `targets/<board>`, the host and Mac code, the
tests and the docs (`firmwareInputs`). A build fails when the board read a tracked
file outside its inputs, changed a tracked file, or produced a flash layout that
disagrees with its own partition table. Each board builds in its own leg, so main
releases in about 5 minutes. Releases are never marked Latest; the daily `v…`
release stays the repository's Latest. A pull request that touches firmware runs
the same builds and lists what it would publish.

- **Recovery.** Every run compares each board with its newest release, so the
  daily 05:17 UTC run (or the next firmware push) releases what a failed run left
  behind. A failure on main posts to Slack.
- **Builder changes.** `scripts/firmware-release.ts` is not a release input. After
  changing it, dispatch Kit Firmware on main with `devices=all` to rebuild every board.
- **Yanking.** Merge the fix first, which releases a newer version, then
  `gh release delete <tag> --cleanup-tag --yes` (an admin, once a tag ruleset
  protects `kit-firmware/**`). Deleting first makes the next run
  rebuild the bad commit, since the planner then compares with the older release.
- **Stray drafts.** A publish killed mid-upload can leave a draft release. Drafts
  have no tag, so nothing lists them; delete it in the releases page.
- **Bench builds.** `node apps/kit/scripts/firmware-release.ts build --device <id>
--out /tmp/kit-<id>` with ESP-IDF active; see the
  [firmware guide](./firmware/README.md#release-and-proof).

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
