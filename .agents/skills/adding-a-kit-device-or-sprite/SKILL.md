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

Read the task file `tasks/2026-09-09-board-table-and-satellite1.md` before any large change.
It measures the duplication these instructions try not to add to.

---

## Part 1 — Adding a device

### What already exists, and must not be re-invented per board

| Concern                             | Where it is decided                        | Board's job                         |
| ----------------------------------- | ------------------------------------------ | ----------------------------------- |
| What the status lights mean         | `iterate_kit_conversation_lights_animate`  | hand it a snapshot; paint 12 pixels |
| Whether the device needs attention  | `iterate_kit_conversation_needs_attention` | nothing                             |
| The word for the current state      | `iterate_kit_conversation_status_word`     | nothing                             |
| When the face sleeps                | `iterate_kit_face_awake`                   | nothing                             |
| Playout identity / interrupt policy | `iterate_kit_playout_*`                    | nothing                             |
| Wire framing, mu-law, base64        | `voicelab_stream.c`                        | nothing                             |

If you find yourself writing a second answer to any row above, stop: the
answer belongs in `components/core` and the other boards want it too.

### A board is a table

Since 2026-09-09 a board is `struct iterate_kit_board` (header:
`platforms/iterate_esp_idf/components/board/include/iterate/kit/platforms/board.h`)
handed to `iterate_kit_board_run()`. Read `devices/satellite1/satellite1_device.c`
first: it is the smallest complete board (~330 lines) and the FutureProofHomes
Satellite1 talks through it. Then `devices/havpe/havpe_device.c` for a board
with a dial and XMOS pipeline taps.

The table carries the hardware facts and nothing else:

| Field | What it is | Satellite1 |
| --- | --- | --- |
| `facts` | the loop's `iterate_kit_board_facts`: stream/client paths, prose, `turns`, `radio_before_codec` | open mic, `/agents/voice/satellite1` |
| `i2c` | sda/scl/hz; board.c opens the bus | 5/6 @ 400 kHz |
| `boot[]` | GPIO steps in order: rails, reset pulses, boot waits | `{4, 0, 0}` (XMOS runs) |
| `scripts[]` | I2C register scripts, `BEFORE_I2S` or `AFTER_I2S`, with a settle | empty (its chips have drivers) |
| `audio` | `iterate_kit_i2s_codec_facts`: ports, `i2s_std_config_t` pair, DMA, two `iterate_kit_pcm_shape`s, gain, amp GPIO | one duplex slave bus, 48 kHz, ratio 3 |
| `volume` | a register map, or `register_count 0` + `set_volume` | TAS2780 via `set_volume` |
| `ring`, `status_led_gpio`, `button`, `sounds` | WS2812 ring (N % 12 == 0), a link LED, the one grammar button, the two chimes | 24 px, GPIO45, GPIO0 |
| `wake_word` | a WakeNet model name or NULL | `"jarvis"` |

Three things are code because no table can say them:

- `open_codec`: runs AFTER the I2S channels are opened and enabled (TX preloaded
  with silence) but BEFORE the hardware tasks start, so a slave bus with no
  clock cannot block yet. Version gates, SAR-ADC power modes, read-modify-writes
  live here (Satellite1: SPI version poll, TAS2780 init + activate, PCM5122).
- `set_volume`: for a chip with no plain register (TAS2780's DVC map).
- `extra`: a full `iterate_kit_board_ops` for what only this board has (a face,
  servos, a camera, a half-duplex fence, a dial, side buttons). board.c runs its
  own half of every op first, then `extra`'s; `extra->poll` may OR into the
  intent or own the grammar when `button.gpio == -1`.

Everything below the table is shared and must not be re-implemented:
`i2s_codec.c` (hardware tasks, mailboxes, ledger, play_sound, idle silence on
DSP-reference buses, the raw/clean echo oracle), `led_ring.c`, `wake_word.c`,
`codecs/{aic3204,tas2780,pcm5122}.c`, `xmos_{i2c,spi}.c`, and in core
`button.c`, `xmos_control.c`, `starvation_ledger.c`, `pcm_format.c`.

Facts that cost a bench run each, so copy them from the vendor's first-party
config, then MEASURE:

1. **Which I2S slot carries the microphone.** The Satellite1's XMOS source says
   slot 0 = AGC and slot 1 = NS; on the shipped XMOS 1.0.3 slot 1 is silent.
   `micRawPeak`/`micCleanPeak` in `health()` say which one moves. If the board
   has no raw tap, set `diagnostic_slot = -1`, or the oracle reports nonsense.
2. **Button polarity per pin.** The Satellite1's Vol± are inverted and its mute
   is not; treating them alike made a fresh board report `micMuted 1` and refuse
   every call.
3. **MCLK.** When a DSP masters the bus, `.mclk = I2S_GPIO_UNUSED`.
4. **The make-up gain.** x16 after an AGC'd tap fed the provider its own echo on
   the HA Voice PE; the Satellite1 runs its AGC tap at unity.

A new board also needs: a `targets/<board>/` copied from the nearest board
(check `partitions.csv` keeps `iterate_kit` at its offset and, with a wake
word, a `model` partition), a line in `tools/generate-sounds.sh` and an
`assets/make-sounds.py` (or derive the `.inc` from havpe's when the clips are
the same), and an entry in `apps/os/scripts/voicelab/boards.ts`.

### Push-to-talk or open microphone

Decide it from whether the hardware really cancels echo, not from taste (the
board declares it through `facts.turns`; the old codec property that claimed
it was deleted because nobody checked it):

- **Cancellation exists** (StackChan's esp-sr, HA Voice PE's XMOS) →
  **open mic**, `.turns = "vad"`, no turn machine. The microphone rides the
  open call and the provider segments turns.
- **No cancellation** (M5StickS3, Waveshare) → **push-to-talk**, and the turn
  machine with it.

Getting this backwards is not cosmetic. The HA Voice PE shipped with hardware
AEC _and_ push-to-talk: a tap opened a call, the ring showed a call with
nobody listening, and speaking did nothing at all.

If you choose open mic, you inherit three obligations, all already implemented
and all learned the hard way:

- **Duck the capture make-up gain while the speaker plays.** A gain tuned
  under PTT only ever multiplied a person's voice; with the mic open it
  multiplies the echo residual too. ×16 against −15 dB of cancellation hands
  the provider an echo _louder_ than the microphone heard.
- **Do not send your own echo.** While the speaker is active, the uplink
  carries silence unless the loop's own barge machinery says somebody is
  actually talking. Otherwise the provider's VAD hears the device, decides it
  was interrupted, and cancels the answer it is generating.
- **"Playing" must span the pauses inside an answer.** "One. Two. Three." is
  three bursts with real silence between them. Read instant-by-instant, the
  uplink opens in every gap.

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
pnpm --dir apps/kit firmware:test:host          # 62 host tests, seconds
cd apps/kit/firmware/targets/<board> && idf.py build
idf.py -p "$(apps/kit/firmware/tools/port-for-mac.sh <ROM MAC>)" flash
doppler run --config prd -- pnpm cli voicelab boards --project voice-test --only <name>
doppler run --config prd -- pnpm cli voicelab latency --project voice-test --board <name>
```

`port-for-mac.sh` resolves the port with `ioreg` and never touches the board —
`esptool read_mac` resets it, and a `/dev` path picked by eye flashes whichever
board happened to enumerate there. (This step used to name a `port_for_mac`
helper that did not exist anywhere in the repo.)

`voicelab latency` is the answer to "why does it take so long after I press the
button". It splits the wait into the device's own half (`press`: preparing the
conversation) and the server's (`wake`/`dial`/`session`/`accept`), so a slow
bring-up names its phase instead of inviting a guess. It also prints the
device's state — including `restartNote` — for any press that never came up.

`voicelab boards` is the end-to-end proof: it speaks a prompt out of the Mac's
own speaker and requires the board's own microphone to have heard it, then
checks that microphone frames left the device, that an answer reached the
speaker, and that the provider transcribed the words. **It hangs up on every
board it touches** — do not run it while somebody is using one.

Hardware gotchas that have each cost a day:

- Opening the USB console **reboots** these boards. Observe over the stream
  (`health()`), not the serial port.
- Resolve MAC → port passively with `ioreg`; `esptool read_mac` resets boards.
- Any early `return` after `esp_task_wdt_add(NULL)` is a silent 20-second
  reboot loop. Park and show the fault instead.

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
  stream has no voice agent, or has one in push-to-talk posture.
  `pnpm cli voicelab talk --project <slug> --setup-only --stream-path /agents/voice/<board>`
  births the agent BUT with `clientTakesTurns: true`; an open-mic board then
  sends audio the provider never commits (`heard: ""`). Append a
  `voice-agent/configured` with `clientTakesTurns: false` (copy instructions
  and tools from a working board's stream). A bare `agents.get(path).create()`
  births a chat agent, not a voice agent.
- **`no board named havpe`.** `voicelab boards --only` takes the registered
  name or its alias; `voicelab device` takes `--name`.

And the wake word: `wakeWordModel 1` and `wakeWordFrames` climbing prove the
model loaded and audio reaches it; `wakeWordDetections` moves on the word;
`wakeWordMaxUs` against `wakeWordChunkSamples * 1000000 / 16000` is the CPU
budget (6.9 ms of 32 ms on the HA Voice PE). A board flashed app-only after
adding the `model` partition has no model: flash with `idf.py flash`, which
includes `srmodels.bin`.

And before concluding the audio is broken: check whether the _prompt_ explains
it. "Never read out long lists" is in the voice instructions, so a board asked
to count to twelve will say "One. Two." and stop — with nothing wrong anywhere.
