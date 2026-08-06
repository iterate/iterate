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

Read `apps/kit/docs/2026-08-06-stream-stack-review.md` before any large change.
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
| Whether a barge-in is real          | `iterate_kit_barge_in_*`                   | feed it the mic peak                |
| Playout identity / interrupt policy | `iterate_kit_playout_*`                    | nothing                             |
| Wire framing, mu-law, base64        | `voicelab_stream.c`                        | nothing                             |

If you find yourself writing a second answer to any row above, stop: the
answer belongs in `components/core` and the other boards want it too.

### The nine things a board actually owns

1. **Pins and buses** (`<board>_audio.c`). Copy them from the vendor's own
   first-party configuration, not from a datasheet reading. For the HA Voice
   PE these came from `esphome/home-assistant-voice-pe/home-assistant-voice.yaml`;
   getting a bus wrong is invisible until an echo canceller silently has no
   reference.
2. **A codec** — `iterate_kit_audio_codec_ops` with `read`/`write`, plus
   `iterate_kit_audio_codec_properties`. Three properties change behaviour
   everywhere else, so get them right:
   - `capture_is_echo_cancelled` — **true only if hardware or DSP actually
     cancels.** This is what decides push-to-talk vs open-mic (see below).
   - `has_reference_channel` — true only if the capture bus really carries the
     speaker signal. Intended playback is not a measured reference.
   - `capture_clock_is_hardware_owned`.
3. **A speaker level** — `<board>_audio_set_volume(percent, applied)` and
   `<board>_audio_volume()`, mounted through the shared `speaker` capability.
   Every board has a _ceiling with a measured reason_ (a brownout limit, a
   distortion knee, an AEC headroom budget). Clamp to it and **report what you
   applied**, so a caller learns the ceiling by asking for more.
4. **A display or a ring**, which renders the shared snapshot and nothing else.
5. **Buttons.** Never put a held gesture on a pin the hardware treats as power.
6. **Board-specific capabilities** (servos, camera). One portable capability in
   `components/capabilities` + one board driver of function pointers. The
   servo module is the reference; the camera module is the reference for
   anything that returns more bytes than fit in one message.
7. **A `health()` renderer.** See "instruments" below.
8. **A `run()`** that composes the above. Today this is ~1,500 duplicated
   lines per board; the review's §3.3 plans to hoist it. Until then, copy the
   nearest board **and re-read every comment you copied** — the two most
   expensive bugs of the consolidation week were duplicates, not logic errors.
9. **A mount path**: `{"kit", "<name>"}`.

### Push-to-talk or open microphone

Decide it from `capture_is_echo_cancelled`, not from taste:

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
  carries silence unless `iterate_kit_barge_in_person_present` says somebody is
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
pnpm --dir apps/kit firmware:test:host          # 60 host tests, seconds
cd apps/kit/firmware/targets/<board> && idf.py build
idf.py -p "$(port_for_mac <ROM MAC>)" flash     # resolve by MAC, never /dev path
doppler run --config prd -- pnpm cli voicelab boards --project voice-test --only <name>
```

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

And before concluding the audio is broken: check whether the _prompt_ explains
it. "Never read out long lists" is in the voice instructions, so a board asked
to count to twelve will say "One. Two." and stop — with nothing wrong anywhere.
