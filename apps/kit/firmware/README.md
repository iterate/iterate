# Iterate Kit firmware

Every ESP board and the host CLI use the same GPT-Live-1 stream. A board owns
physical audio, controls and display; shared components own the conversation.
The backend owns the OpenAI session and the ordinary Agent. A new board should
therefore be small and mostly data. One `device_name` means one stable client
path and a namespace for fresh conversations, with no per-board model choice.

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
reference. Give a new board a stable `facts.device_name`; firmware derives the
itx expression it answers, `itx.clients.<device_name>` (every character outside
`[A-Za-z0-9_]` replaced by `_`, because the far end spells that name in
JavaScript), and its conversation namespace `/agents/voice/v23/<device_name>`
from it.

Register the board once in `apps/kit/src/firmware/catalog.ts`: device identity,
ESP-IDF target, chip and flash plan, including its configuration partition.
Use the target's partition CSV and generated `flasher_args.json` to establish
those offsets. The release builder checks them against the actual binary
partition table. Provide its checked-in chime assets if it uses them. The browser
selector, release builder and `voicelab boards` all consume the catalog; none
needs a separate board registration.

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
Kit build's isolated VoiceAgent guest, verifies `/secrets/openai`, builds the
guest through its health check and durably mounts its setup capability. It
returns the canonical project ID and conversation namespace before flashing.
The browser then writes Wi-Fi, OS URL, canonical project
ID and project API key into the versioned `iterate_kit` partition on the
connected board. Credentials never enter the Kit worker or a URL.

To write that partition by hand instead — which is how an os-next bench board
is provisioned — use `tools/make-config-image.py`. Its `--offset-for <target>`
reads the offset out of the target's own partition CSV; assuming one corrupts
the application and leaves the board looking absent rather than offline.

```sh
python3 tools/make-config-image.py \
  --wifi-ssid <ssid> --wifi-password <password> \
  --os-base-url https://os.iterate2.com \
  --project-id prj-voice --project-api-key "$OPERATOR_SECRET" \
  --out /tmp/cfg.bin
python -m esptool --chip esp32s3 -p /dev/cu.usbmodem2101 \
  write_flash "$(python3 tools/make-config-image.py --offset-for havpe)" /tmp/cfg.bin
```

At boot, firmware rejects a missing or invalid partition, joins Wi-Fi and
mounts. Health classifies provisioning, Wi-Fi/authentication, mount and audio
failures.

## The protocol, as os-next speaks it

The device dials **`wss://<os base url host>/internal/rpc`** — the operator
door, which carries no HTTP gate, so the upgrade needs no header at all. The
blob's project id is a bare DNS-safe **slug** (`prj-voice`); its key field is
the deployment **admin secret**, which reaches every project and is therefore a
bench credential, never a fleet one. A device-scoped grant will replace it
without changing any call below.

The mount is three calls and nothing else:

```
authenticate({ type: "admin-secret", secret })   -> the session
projects.get("<project id>")                     -> the project's ROOT itx
provide("itx.clients.<device_name>", <this device's capability>)
                                                 -> a rewrite-rule handle
```

`projects.get` is pure addressing — one bare string, no options object.
`provide` is os-next's ONE front door for making a name mean this device: after
it, a caller reaches the board as
`root.clients.<device_name>.health()` or `.conversation.start(...)`, and the
remaining steps arrive as the ordinary Cap'n Web path the device's capability
modules already dispatch — no flattening envelope. The rule handle IS the live
provision: releasing it un-does the match and recalls the lent stub, so it is
released before the project handle. Reconnect re-runs all three.

A press then addresses one conversation:

```
root.voice.setupVoiceAgent({ streamPath, visemes })  -> { streamPath }
root.cd(streamPath)                                  -> that context
context.subscribe({ name, consumes: [...], target: <callback> })
context.append({ type, ephemeral, payload })
```

`cd` replaces `streams.get` and makes no call of its own — **a context IS its
stream**. `subscribe` replaces `openConnection`: `connectionKey` is `name`,
`eventTypes` is `consumes`, and the exported callback is the `target` itself.
There is no `maxDeliveryEvents`/`maxDeliveryBytes` to ask for, and a
subscription handle has no `close()` — releasing it is its disposal. Types are
named one by one because `"*"` never sweeps an **ephemeral**, and `spk-frame`
is one.

The server calls that lent callback as a **bare function** with two positional
arguments, `(events, range)`: argument 0 is the events array itself, and
`range` is `{ after, through }`. Delivery is fire-and-forget — nothing is
awaited, nothing is retried, a push past the server's in-flight budget is
dropped, and `readEvents` never returns an ephemeral — so a lost speaker frame
is gone. The device cannot heal that; it counts it (`deliveryGaps` in health)
by checking each `after` against the last `through`, so a gap is visible
rather than silent. The sender's side of that bargain is one speaker frame per
append.

Liveness is two probes on one period
(`ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS`, 60 s, which must stay well inside
os-next's ~100 s idle close). The transport's WebSocket PING asks whether the
TCP hop is half-open, and its PONG is what the liveness watchdog keys on. The
mount's `whoami()` on the project root asks whether the SESSION is there — and
being an application message, it is the kind the idle close actually counts.

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

The two reviewed UI WAVs are committed once. CMake deterministically converts
them into each component build directory with the board's recorded trim and
gain; generated C arrays are never committed and release builds need no audio
service, secret or network access.

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
[onboarding guide](adding-a-board-or-sprite.md).
The retained board measurements, USB recovery notes and configuration traps are
in [bench notes](./bench-notes.md).
