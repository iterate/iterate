---
status: in-progress
size: large
---

# Kit boards say (and sing) their connection status

**Status:** implemented; host tests green. Built: the synth component, the config field and Kit
select, the announcer, loop wiring, clip playback on ESP boards and the Mac. Not yet proven: the ESP
builds (CI builds every board) and a board actually singing on the bench.

## Why

A board that is offline or still connecting is silent. Only boards with a screen say "connecting to
iterate". Someone who has just plugged a board in cannot tell "joining Wi-Fi" from "wrong Wi-Fi
password" from "iterate refused the key" without a serial console.

The planning session built a listening page (`explainers.ignoreme/kit-status-voices/` in Misha's
root worktree, not committed). On it, Misha picked a small home-made formant synthesizer
("tinyvoice": a buzz through five resonant filters, Klatt 1980 style, Hawking-ish). It is small
enough to run on the board, so no recordings ship. It can also sing: each vowel takes the next note
of a tune. Misha's pick is Greensleeves.

## Decisions (made without Misha; each is a best guess he can overturn in review)

1. **Voice: tinyvoice, rendered on the board.** It is roughly 300 lines of C plus note tables. Its
   output goes through the path "call ended" already uses (`play_sound()` → the I2S codec). Recordings
   of the same phrases would cost 0.6–1.5 MB of flash. The M5StickS3 has about 680 KB free.
2. **Fixed phrase list.** Each phrase is a hand-written phoneme script in C. The English → phoneme rules
   from the listening page stay on the page; the board never reads arbitrary text.
3. **Setting: "Status voice"** in the Kit Flasher form, next to the Wi-Fi fields:
   Greensleeves (default) / Daisy Bell / Auld Lang Syne / The Lass of Aughrim / Spoken (no tune) / Off.
   - It is stored as configuration tag 6, a short ASCII name (`greensleeves`, `off`, …).
   - Older firmware already skips unknown tags. New firmware reads a missing tag, or a name it does not
     know, as Greensleeves.
   - So there is no `ITERKIT` magic bump and no `configurationFormat`. Boards updated over the air keep
     their old image and sing Greensleeves.
4. **When it speaks.**

   | When                                                                                    | Says                                                                            |
   | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
   | Boot after power-on, the reset button or USB (someone just plugged it in or flashed it) | Narrates until connected: each connection state is said once, if it lasts ≥ 1 s |
   | Boot after an update, crash, watchdog or brownout (nobody there)                        | Nothing                                                                         |
   | Connected, then the connection drops                                                    | Nothing (no singing at 3 am)                                                    |
   | "Jarvis" while connected                                                                | "Hello!" instead of the wake chime                                              |
   | "Jarvis" while not connected                                                            | The current connection state, instead of the chime                              |
   | Button press while not connected                                                        | The current connection state, instead of the chime                              |
   | Button press while connected                                                            | Chime, unchanged                                                                |

   Connection states and phrases:
   - joining Wi-Fi: "Connecting to Wi-Fi."
   - password rejected: "Wi-Fi password didn't work."
   - network not found: "Can't find the Wi-Fi network."
   - Wi-Fi up, iterate not yet: "Connecting to iterate."
   - Wi-Fi up, not connected for 20 s: "Can't reach iterate. Still trying."
   - key refused: "Iterate refused my key. Please set me up again."
   - connected: "Ready."

   Narration rules:
   - A phrase never cuts off another. The next one waits, and a state that went stale while waiting
     is skipped (latest wins).
   - Narration stops after "Ready.", or 3 minutes after boot.
   - Each state is said at most once per boot's narration.

5. **Who decides what.**
   - A pure policy module in `components/core` (the announcer) turns connection facts and control edges
     into "say phrase X".
   - The voice loop owns the synth and the render.
   - A board only plays PCM: two new optional board ops (play a clip, is a clip still playing). A board
     without them stays silent.
6. **Loudness:** the render is scaled to the peak of the board's own baked "call ended" clip, so every
   board speaks as loud as it already says "call ended". That clip already carries the per-board gain.
7. **The Mac target speaks too**, so the whole thing can be heard on a laptop with `iterate-kit-mac`
   before anyone flashes a board.

## Checklist

- [x] tinyvoice as a firmware component: no global state, caller-owned workspace, 4 tunes, phrase scripts _(`components/tinyvoice`; phrase scripts live with the announcer in core; output bit-identical to the listening page)_
- [x] configuration tag 6 `status voice` (C decoder, `make-config-image.py`, TS encoder) + tests _(`configuration_test.c`, `config-image.test.ts`)_
- [x] Kit Flasher "Status voice" select, default Greensleeves _(after the Wi-Fi password field; threaded through `SetupInput`)_
- [x] platform: Wi-Fi failure class (wrong password / not found) in transport metrics; reset "attended" flag _(`wifi_status` in both platforms' metrics; `iterate_kit_platform_reset_by_person()`)_
- [x] announcer policy module + scenario tests _(`announcer.c`, `announcer_test.c`)_
- [x] voice loop: announcer wiring, render, HELLO on wake word, status on offline press + loop test _(`status_voice_*` in `voice_loop.c`; `voice_loop_status_voice_test.c`)_
- [x] board ops on ESP boards (board.c) and the Mac; wake-word start skips the chime when the loop greets _(`play_clip`; view `voice_answers_*`; intent `wake_word`)_
- [x] docs: firmware README (component table, provisioning field), Kit README if the form is described _(new "Status voice" section)_
- [ ] CI green: host tests, every board's firmware build, TS tests

## Implementation notes

_(log; newest last)_

- Decision 1 changed shape slightly: the loop renders synchronously on its own task, not in a render task.
  The host/Mac shim never runs FreeRTOS tasks, and the stall only happens where it is harmless: before
  connecting, or once per boot for "Hello!" (cached afterwards).
- The loop decides a clip is over by time (length + 300 ms), not by asking the board: the StackChan's
  clip player has no "still playing" query, and the shared codec reports "done" before its last slice is copied.
- A rendered status phrase is freed only when the next one replaces it, which is always after the last one's
  tail has passed; "Hello!" is kept.
- The Wi-Fi reason mapping (`wifi_status()` in the ESP transport) uses ESP-IDF 5.4's `WIFI_REASON_*` names;
  only CI's ESP builds compile it.
- Not done, for a follow-up: a ▶ preview of each voice in Kit Flasher (needs the synth in the browser; the
  planning page's WebAssembly build is one route), and health fields for the status voice (the health line's
  budget is tight and truncation drops the whole line).
- After trying it on a Voice PE, Misha asked for "Call ended" in the same voice rather than the recorded
  one: a session's end now gets a sung "Call ended." and the board skips `call_ended.wav`
  (`view.voice_says_call_ended`). Hello and Call ended are rendered once and kept.
- Misha: "we don't need call_ended.wav once we merge this". Deleted: the end of a call is always the loop's
  "Call ended." (silent with the voice off). Its other job, setting how loud speech is on each board,
  is now explicit: make-sounds.py emits `ITERATE_KIT_SPEECH_PEAK` from the board's `GAIN`, into
  `board.sounds.speech_peak`.
