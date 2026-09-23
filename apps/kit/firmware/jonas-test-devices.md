# Jonas's test devices

Identified on 2026-09-21. Use the ROM MAC / USB serial number as identity;
`/dev/cu.usbmodem*` paths can change after reconnecting a device.

| Device                                       | ROM MAC / USB serial | Evidence                                                                                                 |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| Home Assistant Voice Preview Edition (HAVPE) | `D8:3B:DA:46:20:34`  | Serial boot identifies `iterate-kit-havpe`, XMOS 1.3.1 and this Wi-Fi MAC.                               |
| Satellite1                                   | `14:C1:9F:4F:D2:14`  | Previously identified during recovery; see [bench notes](bench-notes.md#satellite1-rom-recovery-record). |

Waveshare ESP32-S3 RLCD 4.2 has USB serial `94:A9:90:CD:51:B8`.
Factory boot reported `03_Fac`, ES8311/ES7210 and the vendor's RLCD wiring;
Jonas confirmed the display and KEY-button path on this unit.
See its [board notes](devices/waveshare_s3_rlcd/README.md).

ZECTRIX NOTE4 has USB serial `80:45:6B:38:60:84`. Factory boot identifies
`zectrix-s3-epaper-4.2`, xiaozhi 3.6.2. Its full factory backup and current
firmware are documented in [NOTE4 board notes](devices/zectrix_note4/README.md).

Resolve a device's current port passively from the repository root:

```sh
apps/kit/firmware/tools/port-for-mac.sh D8:3B:DA:46:20:34
```

`esptool read_mac` and serial monitors can reset a board. Identify it through
USB metadata before opening its port; leave other attached devices alone.

The HAVPE targets `https://os.iterate.com`, project slug `prj-kit-bench`,
canonical project ID `prj_3afc6e86c9202218ef3c6b7059e5be82`. Its provisioning
uses the canonical ID and a project-scoped personal access token for the
existing `kit-bench@iterate.com` bench account. Credentials belong in the
provisioning partition, never in this file.

On 2026-09-21, its old grant authenticated but reached no projects; serial
reported `project get rejected`. The current bench project also lacked
`itx.voice`. Repair required renewing the device grant against the canonical
project ID and installing the voice service in that project.

Reflashed that day from `ddaf396ff` (firmware matches `origin/main` at
`97ffd6fd6`), with the voice service from `97ffd6fd6`. All 64 firmware host
tests passed. The air-path check opened a call in 2.97 seconds, transcribed
“Hello voice assistant, please say banana, just the word banana” and played
“Banana.” with no reported errors.

Satellite1 was also rebuilt and reflashed on 2026-09-21. It uses the same canonical bench project at `https://os.iterate.com`,
with its own project-scoped grant.
Flash hashes and all 64 host tests passed. The voice check opened a call in
2.47 seconds and returned “Hello? Banana.”; an interruption check stopped
its counting and returned “Stopped.” Both checks reported no errors, and
final health showed an idle call, ready transport, XMOS 1.0.3 and an unmuted mic.

## Voice backend repair — 2026-09-22

Immediate `call ended` came from backend changes: loaded voice subscriptions
still named forbidden `builtins`, fresh conversations lacked their creator
link, `/secrets/openai` was missing after the secret migration, and inherited
WebSocket fetches crossed Workers RPC, which cannot serialize the socket.
Repair the service, project secret and native fetch forwarding; reflashing
does not repair these failures. `apps/os/e2e/voice-agent.e2e.test.ts` runs
the real voice bundles against a WebSocket provider fixture and requires call
acceptance plus two microphone-to-speaker audio round trips. It failed on the
broken production version and passed on the fixed preview and production.

Satellite1's physical proof accepted in 5.33 s, heard the prompt and replied
“Banana.”, with 55 speaker writes and no reported errors. HAVPE needed a USB
reset after its capability stopped responding; no flash was written. A first
retry produced transcripts without speaker writes; the subsequent complete
proof accepted in 3.90 s, heard “What is two plus two?”, replied “Four.” and
recorded 240 speaker writes with no errors. Both calls were ended afterwards.

## Bench website backend repair — 2026-09-21

- Website: https://prj-kit-bench.iterate.app
- `itx.whoami()` now exposes the actual project slug and public URL to agents.
- Config repository: `/repos/config`, with `worker.ts` and publication instructions in `README.md`.
- Apex routing uses the explicit `project/ingress-configured` worker target; source reads and cache keys pin the same Git commit.
- The September 21 failed update had written a repo and ingress event while production still used the old router. Its source also contained a TypeScript annotation unsupported by the JavaScript worker loader. Both were corrected.
- Voice prompts require probing worker code and fetching the public page before claiming success. Firmware and USB devices were not changed for this backend repair.
- Physical HAVPE call at 11:16:28 UTC successfully requested the chicken-joke update. The final deployed backend independently repeated publication and live HTTP verification, and returned the exact hostname on a fresh follow-up. The website was left showing the user's chicken joke.

## Satellite1 OTA proof — 2026-09-21

`itx.clients.satellite1.system.update({url, sha256})` successfully installed the
1,283,664-byte Satellite1 app over Wi-Fi (SHA-256
`ff3a2fb771880a95808079b5805a296d237cf8c63e5d5788719ca792d78b92a5`).
The download was staged through `itx.files` with a one-hour signed URL and
independently hash-checked before calling the updater. Acceptance returned
`true`; the device disappeared briefly, then reconnected within 20 seconds
with lower uptime and `restartNote: "system-update"`. A subsequent health
check confirmed increasing uptime/capture counts, ready transport, a 20 V PD
contract, and zero protocol, codec, amplifier or PD failures. No USB was used.
The temporary remote file was removed. Evidence is retained locally under
`.build/satellite-ota-2026-09-21/`; no post-update voice conversation was tested.
