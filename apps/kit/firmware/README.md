# Iterate Kit firmware

Every ESP board and the Mac target run the same GPT-Live-1 stream. A board owns
physical audio, controls and display; shared components own the conversation.
The backend owns the OpenAI session and the ordinary Agent. A new board should
therefore be small and mostly data. One `device_name` means one stable client
path and a namespace for fresh conversations, with no per-board model choice.

## Where code belongs

| Path                        | Owns                                                                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/core`           | Cap’n Web peer, itx mount and stream subscription, WebSocket framing, provisioning image decode, session grammar, the announcer (what a board says out loud, and when), microphone flush and playout; it includes no audio or platform header (`tests/verify_core_boundary.cmake`) |
| `components/audio`          | PCM conversion, AEC processing and audio accounting                                                                                                                                                                                                                                |
| `components/capabilities`   | the lent capabilities: conversation, health, speaker and system update on every board; screens, cameras and servos where the hardware exists                                                                                                                                       |
| `components/avatar`         | the PCM-clocked talking head ([its README](components/avatar/README.md))                                                                                                                                                                                                           |
| `components/tinyvoice`      | the board's own small speech synthesizer: a phoneme script in, 16 kHz PCM out, spoken or sung to a tune ([Status voice](#status-voice))                                                                                                                                            |
| `components/voice`          | the voice loop: activation, continuous capture, the two audio tasks and the itx session, compiled once per platform it links                                                                                                                                                       |
| `platforms/iterate_esp_idf` | the ESP-IDF platform: Wi-Fi, ESP-TLS WebSocket transport, the `iterate_kit` partition, OTA, the RTC restart note, board table, codecs, LED ring and wake word                                                                                                                      |
| `platforms/host`            | the host ESP-IDF (`esp_idf/esp_idf.h`): the ESP-IDF primitives the loop names, on a laptop                                                                                                                                                                                         |
| `platforms/darwin`          | the Mac platform: CoreAudio behind the codec interface, VoiceProcessingIO echo cancellation, OpenSSL WebSocket transport, provisioning read from a file                                                                                                                            |
| `devices/<board>`           | board-only pins, codecs, display and DSP facts                                                                                                                                                                                                                                     |
| `targets/<board>`           | target composition, partitions and SDK defaults                                                                                                                                                                                                                                    |
| `devices/mac`               | the Mac as a board: `iterate-kit-mac`, with the keyboard as its button                                                                                                                                                                                                             |
| `tests`                     | host tests; `tests/fakes/esp_idf` is the scriptable platform half a loop test needs                                                                                                                                                                                                |

The loop reaches its platform through five headers under
`iterate/kit/platforms/`: `provisioning.h`, `reset_reason.h`, `restart_note.h`,
`system_update.h` and `itx_transport.h`. It calls `iterate_kit_platform_*` and
`iterate_kit_itx_transport_*` only; no `iterate_kit_esp_*` or darwin name
appears in it.
Each platform provides all five under its own `include/iterate/kit/platforms/`:
on ESP the `iterate_kit` partition, `esp_reset_reason`, an RTC note, OTA and an
ESP-TLS WebSocket over Wi-Fi; on the Mac a file, `"started"`, print-and-exit,
refused, and an OpenSSL WebSocket. Because the transport header defines the
struct the loop keeps, `components/voice/CMakeLists.txt` compiles the loop once
per platform it can link: `iterate-kit-voice` against the ESP headers for the
host tests, `iterate-kit-voice-mac` against darwin's for the Mac.

Do not fork the voice loop for a board. All clients capture before the stream
mounts, retain opening audio, flush the first PCM immediately when ready, and
continue capture through a call. Mute and end discard queued PCM. GPT-Live
handles turn-taking; no board needs push-to-talk because it lacks AEC. Preserve
existing AEC/reference routing and prove room echo and barge-in on the hardware.

## Minimum viable board

Start with `devices/satellite1/satellite1_device.c` for a table board or the
closest existing codec. The table type is
`platforms/iterate_esp_idf/components/board/include/iterate/kit/platforms/board.h`.
A minimum board has a microphone, speaker and one activation button. A wake
word is optional. It does not need AEC, a display or a custom board table: use
the shared loop and a small device implementation unless the hardware facts
need a table. A normal table board needs only:

1. `devices/<board>/<board>_device.c` — `struct iterate_kit_board`, hardware-only
   callbacks and `app_main()`.
2. `devices/<board>/CMakeLists.txt` — that code and direct dependencies.
3. `targets/<board>/CMakeLists.txt` — common components plus the device.
4. `targets/<board>/sdkconfig.defaults` — chip, flash, PSRAM, partition and
   wake-model settings specific to this target.

Put GPIO/I2C/I2S facts, boot/reset order, codec register scripts, volume,
physical controls, chimes and wake-word model in the table. Add code only where
a table cannot describe it: codec initialization with required ordering, an
unusual volume register, or a real board extension such as a display BSP.
Reuse the shared I2S codec, session grammar, LED ring, playout and health path.

Confirm from vendor source, then measure: microphone slot and sample shape,
clock master/MCLK, GPIO polarity, amplifier polarity, gain, DMA sizes, and AEC
reference. Give a new board a stable `facts.device_name`; firmware derives the
itx expression it answers, `itx.clients.<device_name>` (every character outside
`[A-Za-z0-9_]` replaced by `_`, because the far end spells that name in
JavaScript), and its conversation namespace `/agents/voice/v23/<device_name>`
from it.

USB-C boards using a FUSB302B can reuse `fusb302_esp_start()` with their I2C
device and voltage/current/power limits. The driver is a fixed-supply PD 2.0
sink (up to 20 V / 3 A); it never requests PPS, EPR or a power-role swap.
Its private task services the PHY while board code reads a copied status.
`USB_ONLY` is an expected computer-port outcome; `READY` requires Accept and
PS_RDY, and failures retain a reason until reboot. Keep the amplifier off
during initial negotiation and refresh its supply mode after contract changes.
Satellite1 shows the integration: its speaker rating and amplifier gain stay
in the board, independently of the reusable PD driver.

Register the board once in `apps/kit/src/firmware/catalog.ts`: device identity,
ESP-IDF target, chip and flash plan, including its configuration partition.
Use the target's partition CSV and generated `flasher_args.json` to establish
those offsets. The release builder checks them against the actual binary
partition table. Provide its checked-in chime assets if it uses them. The
browser selector and the release builder consume the catalog. The air-path
proof, `apps/agents/scripts/voice-board.ts`, takes the device name on
`--device` and needs no registration.

## Remote screens

`components/capabilities/screen` owns the shared image protocol. A board
provides dimensions, supported/preferred wire formats, refresh timing, a
staging buffer, and submit/status callbacks. `screen.info()` exposes these
facts; `screen.setImage()` accepts contiguous bounded base64 chunks and
`screen.status()` acknowledges hardware completion. Monochrome (`mono1`),
16-level grayscale (`gray4`) and big-endian RGB565 use row-major pixels with
each row padded to whole bytes. Panel-native packing belongs to the driver.

`apps/agents/voice/screen.ts` validates metadata and converts
browser PNGs at the advertised resolution; `voice.setImage` waits for a bounded
refresh acknowledgment. E-paper submits to a separate task so image updates
cannot stall voice capture, playback or button handling. The voice loop checks
registered capabilities to include screen guidance in a call. See the
[NOTE4 adapter](devices/zectrix_note4/README.md) and
[Waveshare adapter](devices/waveshare_s3_rlcd/README.md).

## Status voice

A board says its connection state out loud before it reaches iterate, so a board
without a screen is not silent while it joins Wi-Fi or when its key is refused.
`components/core`'s announcer (`iterate/kit/announcer.h`) decides what and when;
the loop renders the phrase with `components/tinyvoice` and hands the PCM to the
board's `play_clip` op, which on ESP boards is the chime player. A board without
`play_clip` stays silent.

| When                                                    | Says                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| boot after power-on, the reset button or USB            | each connection state that lasts a second, once, until "Ready." (at most 3 minutes) |
| boot after an update, a crash, a watchdog or a brownout | nothing                                                                             |
| a drop after it connected                               | nothing                                                                             |
| the wake word, connected                                | "Hello!" instead of the wake chime                                                  |
| a call ends                                             | "Call ended." (nothing when the voice is off)                                       |
| the wake word, or a press, while not connected          | the current state instead of the chime ("Can't find the Wi-Fi network.")            |

A phrase never cuts off another, and a state that went stale while one played is
skipped. A start gets the voice instead of the chime only while the speaker is
free to answer at once; otherwise it chimes. Narration waits while the
microphone is open, and nothing new starts during a call. The voice is the configuration's
`status-voice` field (Kit's **Status voice**): Greensleeves (the default, and what
an image without the field gets), Daisy Bell, Auld Lang Syne, the Lass of Aughrim,
spoken, or off. Phrases are scaled to the board's speech level
(`ITERATE_KIT_SPEECH_PEAK`, from the same `GAIN` its chime is baked with). Each
one is logged as `status voice: "…"`.

## Build and provision

Install ESP-IDF and build from the target directory. Use a fresh generated SDK
config after changing defaults or partitions:

```sh
cd apps/kit/firmware/targets/<board>
idf.py -B /tmp/iterate-kit-<board> -D IDF_TARGET=esp32s3 \
  -D SDKCONFIG=/tmp/iterate-kit-<board>.sdkconfig build
```

Run shared checks from `apps/kit`:

```sh
pnpm firmware:test:host
```

### The Mac as a board

`pnpm firmware:build:host` (from `apps/kit`) configures and builds every host
target into `firmware/.build/host`, `iterate-kit-mac` among them. It runs the
voice loop the ESP boards run, with the Mac's hardware behind the same
interfaces: CoreAudio behind the codec interface (`platforms/darwin/darwin_audio_codec.c`),
Apple's VoiceProcessingIO where the HAVPE has its XMOS, the keyboard as the
button, the provisioning image read from a file. `devices/mac/mac_device.c` pumps the
loop's two audio tasks on one thread — a control step, two capture steps and a
playback step every 5 ms — the way the voice loop tests pump them.

```sh
cd apps/kit
pnpm firmware:build:host
firmware/.build/host/iterate-kit-mac --config /tmp/cfg.bin --name mac
```

`--config` takes the ITERKIT1 image `tools/make-config-image.py` writes for a
board; the Wi-Fi fields ride along unused. It speaks its [status](#status-voice)
through the laptop's speaker too, so `--status-voice` can be auditioned here. `--name` sets the device name, `mac`
by default. `--no-aec` keeps the plain capture and playback queues instead of
VoiceProcessingIO. Space or return presses the button and `q` leaves; when
stdin is not a terminal the button is remote-only. The Mac lends
`itx.clients.<name>` with the shared capabilities plus `button.press`, so
`voice-board.ts --device <name>` proves it the way it proves a board. Its
`system.update` mounts and refuses; a restart the loop asks for prints the note
and ends the process. Health carries `macCaptureFrames`, `macCaptureDropped`,
`macPlaybackStarved` and `macVoiceProcessing`.

### Provisioning

Kit Flasher's **Prepare device** step installs the voice agent when missing,
asks for an OpenAI key if needed, and verifies `itx.voice.health()` before it mints a personal access token scoped to that
project with no expiry, listed as the device (`Kit <board> <date>`) in the
person's OS sessions list. The browser writes Wi-Fi, OS URL, project id and that
token into the versioned `iterate_kit` partition on the connected board.
Credentials never enter the Kit worker or a URL. The token is retired by
revocation from that list.

To write that partition by hand instead — which is how a bench board is
provisioned — use `tools/make-config-image.py`. Its `--offset-for <target>`
reads the offset out of the target's own partition CSV; assuming one corrupts
the application and leaves the board looking absent rather than offline.

```sh
python3 tools/make-config-image.py \
  --wifi-ssid <ssid> --wifi-password <password> \
  --os-base-url https://os.iterate.com \
  --project-id prj-voice --project-api-key "$KIT_TOKEN" \
  --status-voice greensleeves \
  --out /tmp/cfg.bin
python -m esptool --chip esp32s3 -p /dev/cu.usbmodem2101 \
  write_flash "$(python3 tools/make-config-image.py --offset-for havpe)" /tmp/cfg.bin
```

`$KIT_TOKEN` is a personal access token scoped to the project: the one Kit
Flasher's Prepare device step mints, or one from the Dash's Sessions page or
`pnpm exec iterate tokens create --name <board> --project <project> --never-expires`.
The same image is what `iterate-kit-mac --config` reads.

At boot, firmware rejects a missing or invalid partition, joins Wi-Fi and
mounts. Health classifies provisioning, Wi-Fi/authentication, mount and audio
failures.

The device dials `wss://<os base url host>/api` — the OS's public endpoint — with
the blob's key as `Authorization: Bearer` on the upgrade: a personal access
token the Kit page minted for the person who set the device up, scoped to the
one project, revocable from that person's sessions list. Both transports send
it, ESP-TLS on a board and OpenSSL on the Mac. The blob's project id is the
project's `prj_<hex>` id; `projects.get` also accepts its slug (`prj-voice`).
The mount's three calls, the subscription shape and the delivery contract are
documented where they live: `components/core/include/iterate/kit/itx_mount.h`
and `stream_subscription.h`.

The device keeps one authenticated WebSocket and Cap'n Web session. Stream
`subscribe()` and live-state `subscribe()` create independent subscription
handles on that session; neither means opening another WebSocket. Releasing a
subscription must leave the session, device mount and other subscriptions alive.

Shared C clients use `components/core/include/iterate/kit/stream_subscription.h`:
`iterate_kit_stream_get()` borrows the mounted project, and each stream or
live-state subscription has its own caller-owned handle and callback. Close
only the handle you own. Keep its storage until `reclaimable()` says both the
pending RPC and remote callback references have finished. The generic layer
does not choose a stream path or manage the socket. Available concurrency is
bounded by the device's configured Cap'n Web tables; exhaustion is an explicit
error. The voice loop reserves two call slots so a new call can open while the
previous call finishes releasing its resources.

A button press or wake word starts capture immediately and chooses a fresh
`/agents/voice/v23/<device_name>/<UTC timestamp>-<activation>` path. Setup puts
the ordinary Agent and voice processor on that stream. Opening PCM stays in
the device's bounded FIFO until setup and the direct stream subscription are
ready. Microphone and speaker events travel directly through that stream.

## Release and proof

A merge to main releases every board whose inputs changed, as the GitHub release
`kit-firmware/<device id>/<version>` ([Kit firmware releases](../README.md#firmware-releases)).
A board's inputs are the firmware tree minus the other boards' `devices/<board>` and
`targets/<board>`, the host and Mac code, the tests and the docs; the release build
fails if the board reads a tracked file outside them.

For a bench build of the same thing, from the repository root with ESP-IDF active:

```sh
node apps/kit/scripts/firmware-release.ts build --device <id> --out /tmp/kit-<id>
cd /tmp/kit-<id>/release/assets
esptool.py --chip esp32s3 write_flash \
  $(jq -r '.builds[0].parts[]|"\(.offset) \(.path|ltrimstr("./"))"' manifest.json) \
  "$(jq -r .configurationPartition.offset manifest.json)" /tmp/cfg.bin
```

`/tmp/cfg.bin` is an image from `tools/make-config-image.py` (see Provisioning).
The build runs CI's checks (flash layout, inputs, an unchanged tree) and reports
its version as `dev`. Do not edit release offsets by hand or substitute
downloaded binaries.

The one recorded sound, the press chime, is committed once in `assets/sounds/`,
where every board reads it; everything a board says is rendered on the board
([Status voice](#status-voice)). CMake deterministically converts the chime into
each component build directory with the board's recorded trim and gain;
generated C arrays are never committed and release builds need no audio
service, secret or network access.

Prove code before publishing a release:

```sh
pnpm --dir apps/kit firmware:test:host
cd apps/kit/firmware/targets/<board> && idf.py build
```

Then use a provisioned, idle device — a board or `iterate-kit-mac` — for the
air-path proof:

```sh
cd apps/agents
WORKER_BASE_URL=https://os.iterate.com ITERATE_BEARER_TOKEN=itk_… PROJECT=prj-voice \
  pnpm exec tsx scripts/voice-board.ts --device <device_name> \
    --prompt "Hello there. Please reply with the single word banana." --expect banana
```

`ITERATE_BEARER_TOKEN` is a personal access token for the device's project
(the Dash's Sessions page, or `pnpm exec iterate --config prd tokens create`;
[credentials](../../os/docs/credentials.md)).
`voice-board.ts` asks the device to start a conversation (a remote press),
speaks the prompt out of this Mac's speaker so the device's microphone has to
hear it, watches the conversation for what the provider heard and said back,
and hangs up. `--device` takes the `itx.clients.` spelling of the device name;
its header comment documents `--prompt` and `--expect`. Do not run it while
someone is using the device. Inspect health before and after. A serial monitor
can reboot a board, so use stream health for in-call observation.

For sprites and managed dependency pins, see the
[onboarding guide](adding-a-board-or-sprite.md).
The retained board measurements, USB recovery notes and configuration traps are
in [bench notes](./bench-notes.md).
