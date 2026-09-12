# Iterate Kit firmware

Every ESP board and the host CLI use the same GPT-Live-1 stream. A board owns
physical audio, controls and display; shared components own the conversation.
The backend owns the OpenAI session and the ordinary Agent. A new board should
therefore be small and mostly data. One `device_name` means one client path,
one voice stream and no per-board model choice.

## Where code belongs

| Path                        | Owns                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| `components/core`           | Cap’n Web, stream protocol, PCM framing, microphone flush and playout state |
| `components/audio`          | PCM conversion, AEC processing and audio accounting                         |
| `components/voice`          | activation, continuous capture and ESP task coordination                    |
| `platforms/iterate_esp_idf` | Wi-Fi, ESP-IDF, codec tasks and provisioning                                |
| `devices/<board>`           | board-only pins, codecs, display and DSP facts                              |
| `targets/<board>`           | target composition, partitions and SDK defaults                             |

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
reference. Give a new board a stable `facts.device_name`; firmware derives its
client `/clients/<device_name>` and voice stream
`/agents/voice/v23/<device_name>` from it.

Register the board once in `apps/kit/src/firmware/catalog.ts`: device identity,
ESP-IDF target, chip and flash plan, including its configuration partition.
Use the target's partition CSV and generated `flasher_args.json` to establish
those offsets. The release builder checks them against the actual binary
partition table. Add the board to `voicelab/boards.ts` for bench selection and
provide its checked-in chime assets if it uses them. The browser selector and
release builder both consume the catalog; neither needs a separate board switch.

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

Kit Flasher prepares the project before it enables USB install: it installs this
Kit build's isolated VoiceAgent guest, verifies `/secrets/openai`, and creates
or verifies `/agents/voice/v23/<device_name>`. It returns the canonical project
ID and stream before flashing. The browser then writes Wi-Fi, OS URL, canonical project
ID and project API key into the versioned `iterate_kit` partition on the
connected board. Credentials never enter the Kit worker or a URL.

At boot, firmware rejects a missing or invalid partition, joins Wi-Fi,
authenticates with the project key and mounts `/clients/<device_name>`. Health
classifies provisioning, Wi-Fi/authentication, mount and audio failures.

## Release and proof

Kit releases are built from this checkout. With ESP-IDF active, run from
`apps/kit`:

```sh
source "$IDF_PATH/export.sh"
pnpm firmware:release
pnpm firmware:sync
```

`firmware:release` builds all five reviewed catalogue targets into a
fingerprinted cache, checks their ESP-IDF flash plans and configuration
partitions, then records a hash for every part. `firmware:sync` only publishes
that current cache as hashed ESP Web Tools parts and manifests. Do not edit
release offsets by hand or substitute downloaded binaries.

Prove code before publishing a release:

```sh
pnpm --dir apps/kit firmware:test:host
cd apps/kit/firmware/targets/<board> && idf.py build
```

Then use a provisioned, idle board for the air-path proof:

```sh
doppler run --config <environment> -- pnpm --dir apps/os cli voicelab boards \
  --project <project> --only <device-name-or-/clients/path>
```

`voicelab boards` talks through real air and hangs up afterward; do not run it
while someone is using the board. Inspect health before and after. A serial
monitor can reboot a board, so use stream health for in-call observation.

For sprites and managed dependency pins, see the
[onboarding skill](../../../.agents/skills/adding-a-kit-device-or-sprite/SKILL.md).
The retained board measurements, USB recovery notes and configuration traps are
in [bench notes](./bench-notes.md).
