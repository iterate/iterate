---
name: adding-a-kit-device-or-sprite
description: Add a new ESP32 voice board to apps/kit/firmware, or add a new avatar sprite pack to the shared face. Use when wiring a board's audio/display/buttons, deciding push-to-talk vs open-mic, mounting capabilities, or registering a sprite atlas — and when a board is on the bench and "not working".
publish: false
---

# Adding a Kit device, or a Kit sprite

Two jobs share this file because they share one rule: **the board owns its
hardware facts and nothing else.** Everything a person can see or hear —
what the lights mean, when the face sleeps, what "connecting" looks like, how
a turn ends — is decided once, in `components/core`, for every board at once.

Read `apps/kit/firmware/README.md` for the current ownership and onboarding path.
GPT-Live-1 is the only voice model; a new board adds hardware, never a provider mode.

---

## Part 1 — Adding a device

### What already exists, and must not be re-invented per board

| Concern                             | Where it is decided                        | Board's job                              |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------- |
| What the status lights mean         | `iterate_kit_conversation_lights_animate`  | hand it a snapshot; paint 12 pixels      |
| Whether the device needs attention  | `iterate_kit_conversation_needs_attention` | nothing                                  |
| The word for the current state      | `iterate_kit_conversation_status_word`     | nothing                                  |
| When the face sleeps                | `iterate_kit_face_awake`                   | nothing                                  |
| Playout identity / interrupt policy | `iterate_kit_playout_*`                    | nothing                                  |
| PCM wire framing and base64         | `voicelab_stream.c`                        | nothing                                  |
| Microphone flush timing             | `microphone_flush.h`                       | native queue and hardware capture fence  |
| Physical call grammar and chimes    | `board.c` + `session_grammar.c`            | normalized `read_gestures`, sound output |

If you find yourself writing a second answer to any row above, stop: the
answer belongs in `components/core` and the other boards want it too.

### A board is a table

Since 2026-09-09 a board is `struct iterate_kit_board` (header:
`platforms/iterate_esp_idf/components/board/include/iterate/kit/platforms/board.h`)
handed to `iterate_kit_board_run()`. Read `devices/satellite1/satellite1_device.c`
first: it is a complete table board and the FutureProofHomes
Satellite1 talks through it. Then `devices/havpe/havpe_device.c` for a board
with a dial and XMOS pipeline taps.

The table carries the hardware facts and nothing else:

| Field                                         | What it is                                                                                                       | Satellite1                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `facts`                                       | the loop's `iterate_kit_board_facts`: stream/client paths, prose, `turns`, `radio_before_codec`                  | open mic, `/agents/voice/satellite1`  |
| `i2c`                                         | sda/scl/hz; board.c opens the bus                                                                                | 5/6 @ 400 kHz                         |
| `boot[]`                                      | GPIO steps in order: rails, reset pulses, boot waits                                                             | `{4, 0, 0}` (XMOS runs)               |
| `scripts[]`                                   | I2C register scripts, `BEFORE_I2S` or `AFTER_I2S`, with a settle                                                 | empty (its chips have drivers)        |
| `audio`                                       | `iterate_kit_i2s_codec_facts`: ports, `i2s_std_config_t` pair, DMA, two `iterate_kit_pcm_shape`s, gain, amp GPIO | one duplex slave bus, 48 kHz, ratio 3 |
| `volume`                                      | a register map, or `register_count 0` + `set_volume`                                                             | TAS2780 via `set_volume`              |
| `ring`, `status_led_gpio`, `button`, `sounds` | WS2812 ring (N % 12 == 0), a link LED, the one grammar button, the two chimes                                    | 24 px, GPIO45, GPIO0                  |
| `wake_word`                                   | a WakeNet model name or NULL                                                                                     | `"jarvis"`                            |

Three things are code because no table can say them:

- `open_codec`: runs AFTER the I2S channels are opened and enabled (TX preloaded
  with silence) but BEFORE the hardware tasks start, so a slave bus with no
  clock cannot block yet. Version gates, SAR-ADC power modes, read-modify-writes
  live here (Satellite1: SPI version poll, TAS2780 init + activate, PCM5122).
- `set_volume`: for a chip with no plain register (TAS2780's DVC map).
- `extra`: a full `iterate_kit_board_ops` for what only this board has (a face,
  servos, a camera, a half-duplex fence, a dial, side buttons). board.c runs its
  own half of every op first, then `extra`'s. `extra->poll` handles board-only
  UI; `read_gestures` supplies normalized call input when `button.gpio == -1`.
  The shared board poll owns grammar, intent, and chime ordering for every board.
  Set `play_sound` only for a dedicated hardware sound path.

Everything below the table is shared and must not be re-implemented:
`i2s_codec.c` (hardware tasks, mailboxes, ledger, play*sound, idle silence on
DSP-reference buses, the raw/clean echo oracle), `led_ring.c`, `wake_word.c`,
`codecs/{aic3204,tas2780,pcm5122}.c`, `xmos*{i2c,spi}.c`; in core `button.c`and`xmos_control.c`; and in audio `starvation_ledger.c`and`pcm_format.c`.

Facts that cost a bench run each, so copy them from the vendor's first-party
config, then MEASURE:

1. **Which I2S slot carries the microphone.** The Satellite1's XMOS source says
   slot 0 = AGC and slot 1 = NS; on the shipped XMOS 1.0.3, slot 1 is a real
   AEC+IC+NS plane. Neither plane is raw.
   `micRawPeak`/`micCleanPeak` in `health()` say which one moves. If the board
   has no raw tap, set `diagnostic_slot = -1`, or the oracle reports nonsense.
2. **Button polarity per pin.** The Satellite1's Vol± are inverted and its mute
   is not; treating them alike made a fresh board report `micMuted 1` and refuse
   every call.
3. **MCLK.** When a DSP masters the bus, `.mclk = I2S_GPIO_UNUSED`.
4. **The make-up gain and speaker volume.** Measure them as one acoustic
   system. Satellite1's NS slot 1 is real; gain 16 missed prompt prefixes.
   At gain 64, 70 and 65 failed strict repeated barge transcription; volume 60
   passed short wake/barge proofs but later self-transcribed in a 62 s run, so
   it is not release-ready. Current firmware uses NS slot 1 at gain 32 with
   output cap 60, after applying Q31 gain before PCM16 conversion. Its first
   AEC and barge evidence meets the documented keyword criterion but has
   partial ASR; a repeated barge proof is required. Do not promote a board
   signal path until its complete AEC/quiet/barge proof is verified.

### Four files and one sound invocation

A board using the existing components creates four source/config files:

1. `devices/<board>/<board>_device.c`: the hardware table, any board-only
   operations, and `app_main()` calling `iterate_kit_board_run(&board)`.
   Include `assets/sounds_generated.inc`; its static symbols are
   `sound_chime_press` and `sound_chime_ended`.
2. `devices/<board>/CMakeLists.txt`: register that source and the components
   it directly requires. There is no device entry header or sound-file guard.
3. `targets/<board>/CMakeLists.txt`: set
   `SDKCONFIG_DEFAULTS "../common/sdkconfig.defaults;sdkconfig.defaults"`,
   include `../common/components.cmake`, append the device and any optional
   `avatar`, `board_wake_word`, or `core_s3_board` directories, then include
   ESP-IDF's `project.cmake` and name the project. There is no `main/`.
4. `targets/<board>/sdkconfig.defaults`: only the target's own settings.
   Set `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME` to the relative
   `../common/partitions-<geometry>.csv` whose rows match the board. Preserve
   the provisioning offset and choose a model partition for a wake word.
   Common defaults move only explicitly shared key/value pairs; absence is
   not evidence that another target wants the same setting.

Add one invocation to `tools/generate-sounds.sh`, using `tools/make-sounds.py`
with its WORK directory and `name=file` pairs; carry `--trim-wake` and
`--gain 5/2` only where the board's measurements require them. The shell
script creates asset directories; the common ignore rules cover the output.
Managed pins live beside the CMakeLists that requires them: voice owns
capnweb, board owns led_strip, board_wake_word owns its esp-sr pin, and the
device owns its directly required managed drivers. Let ESP-IDF regenerate
`dependencies.lock` during the target build.

After defaults or partitions change, generate a fresh configuration with
`idf.py -B /tmp/<board>-build -D SDKCONFIG=/tmp/<board>.sdkconfig build`.
Use the CMake `-D` argument: an environment-only `SDKCONFIG` assignment is ignored.
This preserves local generated files while proving the committed defaults.

Omit the shared 320-sample processing/capture frames and 4096-byte
capture stack: board.c fills these before the loop validates them. A zero
speaker dry wait becomes two thirds of the TX ring when `audio` is present;
keep explicit measured waits for board-owned audio. StackChan's 256/128
cadences and 8192-byte capture stack remain explicit.

`voicelab boards --only <name>` resolves any client name or existing alias
through `deviceClientPath` and reads `pushToTalk` from `health()`. No board
registration is needed for that command; `BOARDS` only supplies the default
list when `--only` is omitted.

### Push-to-talk or open microphone

Decide it from whether the hardware really cancels echo, not from taste (the
board declares it through `facts.turns`; the old codec property that claimed
it was deleted because nobody checked it):

- **Cancellation exists** (StackChan's esp-sr, HA Voice PE's XMOS) →
  **open mic**. The microphone rides the
  open call and the provider segments turns.
- **No cancellation** (M5StickS3, Waveshare) → a **local hold-to-talk gate**. It is a hardware constraint, not provider turn control.

Getting this backwards is not cosmetic. The HA Voice PE shipped with hardware
AEC _and_ push-to-talk: a tap opened a call, the ring showed a call with
nobody listening, and speaking did nothing at all.

For an open-mic board, send the measured AEC/processed microphone plane at its
measured fixed gain. Do not add speaker-time ducking, muting, or a double-talk
gate based on an assumption that speech playout is echo: the current StackChan
processor explicitly forbids those policies, and the HAVPE's measured hardware
AEC is the evidence used to select open mic. Prove the actual board's residual
and barge behaviour with `health()` plus `voicelab boards`; change the posture
or signal path only when that evidence contradicts the board's claim.

### Instruments: the rule that keeps boards debuggable

**Every counter must be able to move, and something must read it.** The
recurring defect in this tree is a counter that structurally cannot change, or
one nothing exports — five separate instances, each of which cost hours.

Two specific traps:

- **`heapFree` counts PSRAM.** On a board with 8 MB of it, a number near six
  million looks like abundance while the internal heap — the only kind TLS,
  Wi-Fi and DMA can use — is down to scraps. Publish `internalFree`,
  `internalMin`, `internalLargest`.
- **A hardware thing you compare against yourself is not an oracle.** To
  measure echo cancellation, put the _same microphone_ on a raw tap and a
  cancelled tap. Comparing two different microphones produced +2.7 dB — which
  is exactly the number that proves the instrument is honest, because no
  cancellation was expected there.

### Proving it works

```bash
pnpm --dir apps/kit firmware:test:host
cd apps/kit/firmware/targets/<board> && idf.py build
idf.py -p "$(apps/kit/firmware/tools/port-for-mac.sh <ROM MAC>)" flash
doppler run --config prd -- pnpm cli voicelab boards --project voice-test --only <name>
```

`port-for-mac.sh` resolves the port with `ioreg` and never touches the board —
`esptool read_mac` resets it, and a `/dev` path picked by eye flashes whichever
board happened to enumerate there. (This step used to name a `port_for_mac`
helper that did not exist anywhere in the repo.)

`voicelab boards` is the end-to-end proof: it speaks a prompt out of the Mac's
own speaker and requires the board's own microphone to have heard it, then
checks that microphone frames left the device, that an answer reached the
speaker, and that the provider transcribed the words. **It hangs up on every
board it touches** — do not run it while somebody is using one.

Use `voicelab device --action health` before and after that proof to inspect
the board's actual counters and state. There is no `voicelab latency` command;
do not add a made-up measurement step to a board procedure.

Hardware gotchas that have each cost a day:

- Opening a serial monitor **reboots** these boards, including with pyserial
  DTR/RTS cleared. Attach it before a call and treat the next boot as a fresh
  test; use stream `health()` for in-call observation.
- Resolve MAC → port passively with `ioreg`; `esptool read_mac` resets boards.
- Any early `return` after `esp_task_wdt_add(NULL)` is a silent 20-second
  reboot loop. Park and show the fault instead.

### Recovering a missing ROM USB descriptor

For the recovered Satellite1, cached ROM MAC `14:C1:9F:4F:D2:14` mapped in
`ioreg` to `USB device@01100000`: bus 1, root port 1, not `hub0-1`. When the
ROM/esptool was silent and no serial descriptor was available, a targeted
libusb reset restored the descriptor and ROM response. Match physical identity
first; never reset a guessed ESP device when another board is attached:

```python
import usb.core
from usb.backend import libusb1

backend = libusb1.get_backend(
    find_library=lambda _: "/opt/homebrew/lib/libusb-1.0.dylib"
)
matches = [d for d in usb.core.find(
    find_all=True, idVendor=0x303A, idProduct=0x1001, backend=backend
) if d.bus == 1 and tuple(d.port_numbers) == (1,)]
assert len(matches) == 1
matches[0].reset()
```

Then prove the intended board is responsive with
`esptool read-mem 0x6000403c`; `0x3c000003` means GPIO0 is high. Re-resolve the
port from the cached ROM MAC before flashing or reading anything else.

The Satellite1 XMOS image was read back, not reflashed: vendor `fixed_delay`
v1.0.3 is installed at
`/tmp/futurehomes-satellite1-xmos-installed.bin` (MD5
`5f5788ecb240082f61acd36f247ea3b2`; SHA-256
`7e3a5d97ca3e90df953c0b2ef575b5d5dcb89c5d84a59e621a3bc7cf2cfd0d52`). A
temporary ESP application held GPIO4 to reset XMOS and switch the ESP SPI bus
to direct access to XMOS's external boot flash for diagnostic readback only.
It released GPIO4 low and restored normal ESP firmware. Do not flash the XMOS
unless its readback or version establishes a different need.

---

## Part 2 — Adding a sprite pack

### What a sprite pack is

One 160×120 RGB565 avatar, compiled into the firmware as a palette plus an
RLE blob, rendered by the shared engine in `components/avatar`. The engine
adds blinks, glances and breathing itself (`face_performance`), so a pack does
not animate idle life — it supplies poses and the engine performs them.

### Registering one

Three files, and only the first is hand-written:

1. `include/iterate/kit/avatar/fspp_<slug>_cores3_fine_atlas.h` +
   `src/…_atlas.c` — **generated**, never hand-edited. The header carries the
   pack's provenance and CC0 dedication; keep it.
2. `src/face_avatar_catalog_generated.inc` — the catalogue entry: slug, human
   name, atlas pointer, work size (80×60), and flags. Regenerated by the
   pipeline, so change the pack rather than this file.
3. `components/avatar/CMakeLists.txt` — add the new `.c` to
   `ITERATE_KIT_AVATAR_SOURCES`.

Nothing else changes. Every board that renders the shared face picks the new
pack up, and `face_avatar_registry_select_slug()` can address it by name.

> **The generator is not in this repo.** The headers say
> `Generated by tools/sprite-pipeline/avatar_pipeline.py`, which lives with the
> sprite work, not here. Until it is vendored in, treat generated atlases as
> inputs you receive; do not hand-edit a blob.

### The one constraint a new pack must respect

**Leave the left margin empty.** The status rail occupies source columns 0–7
on every screen. Measured across the five shipped packs, the narrowest free
left margin is 18 columns — the rail fits inside all of them. A pack that
draws to the left edge will have the rail sitting on its face.

Check a new pack before shipping it: render it on the host and find the
drawn extents. Renderer, atlas and catalogue all build in the host tree, so
this needs no hardware.

### Looking at a pack without a board

The host build links the avatar component, so a twenty-line program can render
any pack to a PPM and you can simply look at it — which is how the margin
figures above were obtained, and how the status band was designed. Prefer that
to flashing: it is seconds, not minutes, and it cannot brick anything.

---

## When a board is on the bench and "not working"

In order, because each step is cheaper than the next:

1. **`health()` over the stream.** `gateOpen` is usually the whole answer: a
   closed gate answers RPCs while starting no calls and sending no audio.
2. **`internalFree` / `internalMin`.** TLS failing to allocate an AES context
   presents as a socket that dies mid-sentence, and `heapFree` will look fine.
3. **`conversation`** — the stream path the device chose, so you can read the
   transcript without guessing a UTC second.
4. **The lights.** A comet chasing round means not connected; still means
   settled. Three green is a healthy network sector.
5. **Only then the console**, accepting that opening it reboots the board.

Two things that look like a dead board and are not (2026-09-09):

- **The call never becomes active, `ptt-start` repeats on the stream.** The
  stream has no voice agent, or has the wrong turn posture. Set up an open-mic
  board with `pnpm cli voicelab talk --project <slug> --setup-only --open-mic
--stream-path /agents/voice/<board>`. The command appends the configured
  voice-agent event itself. It refuses a posture change on an existing stream;
  inspect that refusal and use `--flip-turn-posture` only for a deliberate
  migration. Do not hand-append `voice-agent/configured`: that bypasses the
  guard that prevents a silent posture flip. A bare `agents.get(path).create()`
  births a chat agent, not a voice agent.
- **Selecting a board.** `voicelab boards --only` accepts any client name,
  path, or existing alias such as `havpe`; `voicelab device` takes `--name`.

And the wake word: `wakeWordModel 1` and `wakeWordFrames` climbing prove the
model loaded and audio reaches it; `wakeWordDetections` moves on the word;
`wakeWordMaxUs` against `wakeWordChunkSamples * 1000000 / 16000` is the CPU
budget (6.9 ms of 32 ms on the HA Voice PE). The model is a separate flash
partition: cable-flash `idf.py flash` before testing a wake-word build, because
OTA updates do not install `srmodels.bin`. Do not ship or OTA a wake-word image
until its model-partition behaviour is explicitly handled and verified.
WakeNet history boundaries destroy and recreate the model rather than call
`clean()`; both bench boards completed three wake/call cycles without a reset
and with frames resuming. Keep a detection soak in release acceptance, because
it proves the live board and its model partition together.

And before concluding the audio is broken: check whether the _prompt_ explains
it. "Never read out long lists" is in the voice instructions, so a board asked
to count to twelve will say "One. Two." and stop — with nothing wrong anywhere.
