---
status: in-progress
size: large
---

# Kit boards say (and sing) their connection status

**Status:** spec written from a planning session; implementation not started.

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
   | Button press while not connected                                                        | Chime, then the current connection state                                        |
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

- [ ] tinyvoice as a firmware component: no global state, caller-owned workspace, 4 tunes, phrase scripts
- [ ] configuration tag 6 `status voice` (C decoder, `make-config-image.py`, TS encoder) + tests
- [ ] Kit Flasher "Status voice" select, default Greensleeves
- [ ] platform: Wi-Fi failure class (wrong password / not found) in transport metrics; reset "attended" flag
- [ ] announcer policy module + scenario tests
- [ ] voice loop: announcer wiring, render, HELLO on wake word, status on offline press + loop test
- [ ] board ops on ESP boards (board.c) and the Mac; wake-word start skips the chime when the loop greets
- [ ] docs: firmware README (component table, provisioning field), Kit README if the form is described
- [ ] CI green: host tests, every board's firmware build, TS tests

## Implementation notes

_(log; newest last)_
