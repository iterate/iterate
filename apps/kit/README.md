# Iterate Kit

Kit Flasher is the browser installer at `https://k.iterate.com` for the
supported ESP32-S3 voice boards: HA Voice PE, FutureProofHomes Satellite1, M5StickS3,
StackChan, Waveshare AMOLED, Waveshare RLCD 4.2 and ZECTRIX NOTE4. The RLCD has an
experimental KEY-button voice release; see its
[board notes](firmware/devices/waveshare_s3_rlcd/README.md). It prepares the selected project,
then flashes a firmware release that CI built from this repository and its private configuration
directly over USB.

## What a person needs

Choose your board at `k.iterate.com`, then click **Log in with iterate**. Consent
shows that board's name and vendor icon; choose its project and authorize access.
Each setup starts a unique OAuth client before consent, including two boards of
the same model. After sign-in, pick the project, enter Wi-Fi (2.4 GHz) and click **Flash
device**. A dialog prepares the project, says which serial port to pick, flashes with
esp-web-tools' `flash` (`src/firmware/flash-device.ts`), then says how to start a call on that
board (`startCall` in `src/firmware/catalog.ts`). The browser's password manager can keep the
Wi-Fi. **Set up another device** returns to the public selector and starts fresh
consent; it never silently changes the authorized model.

A board can belong to another iterate platform, a self-hosted one included: open
`k.iterate.com/.auth/connect?issuer=<its origin>`. Kit checks the origin (https, not one of
iterate's own zones, and its discovery document names it), then the selector's button says
**Log in with &lt;its host&gt;** and consent happens there. The board is flashed with that
platform's address. **Set up another device** keeps the platform.

Preparing installs voice when missing. The form asks for an OpenAI API key as soon as the
picked project turns out to have none. It verifies voice health before minting a ten-year token scoped to the
chosen project, under the same OAuth client that was authorized. Existing voice
services, secrets and project websites are preserved. Immutable voice files live
under `voice/` in project KV; the `itx.voice` mount is published only after all
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
--out /tmp/kit-<id>` (`pnpm firmware:build` in `apps/kit`) with ESP-IDF active; see the
  [firmware guide](./firmware/README.md#release-and-proof).

Kit flashes only these releases: `kit-firmware/` releases of iterate/iterate, which
the Kit Firmware workflow creates. The page lists a board's versions from GitHub's
public API in the browser (`src/firmware/releases.ts`), so the Worker holds no
GitHub token; the picker defaults to the newest, and any older release can be
chosen. The Worker streams each release file from
`/firmware/<device id>/<version>/<file>` (`src/firmware/firmware-proxy.ts`),
because GitHub's download URLs send no CORS headers; the page checks the manifest
(`src/firmware/prepare-manifest.ts`) and adds the install's configuration image
at flash time. Production, the per-PR previews and `pnpm dev` all flash the same
releases with no setup, and deploying Kit builds no firmware.

For board structure, hardware requirements, host tests (`pnpm firmware:test:host`)
and air-path proof, see the [firmware guide](./firmware/README.md). The installer
does not replace that hardware validation. Host tests need cmake and are not part
of Kit's `pnpm test`, which runs the installer's Vitest suite; CI's Test job runs
both on every PR.
