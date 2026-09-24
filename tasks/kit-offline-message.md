---
status: in-progress
size: medium
---

# Kit boards say when they can't get online

**Status:** implementation done, waiting on CI's ESP builds and a real-hardware check. Done: firmware change on every board, three spoken clips, host tests (loop, core, board table, Mac transport) and a live Mac-transport run against bad hosts. Missing: ESP-IDF compile of the ESP-only code (CI's Kit Firmware job; no ESP-IDF here), and Misha flashing a HA Voice PE with a wrong Wi-Fi password.

## Problem

Seen twice while dogfooding Kit (k.iterate.com). A Home Assistant Voice Preview Edition flashed with the wrong Wi-Fi password (a paste error) looked like a broken voice agent, not a Wi-Fi problem:

- its status said "connecting to iterate" while it was still trying to join Wi-Fi
- saying "Jarvis" (or pressing the top button) still started a call
- the call was silence, then the spoken "Call ended." after ~20 s (the loop's 20 s opening deadline)
- serial logs showed `transport state=wifi_connecting`, then `opening-timeout`

A PR preview platform deleted when its PR merged fails the same way: calls end with "Call ended." after ~30 s. Nothing on the device says what is wrong.

## Wanted

When a board can't get online, it says so instead of starting a call that can't work. This lives in the shared voice loop and board table, so every board in the catalog gets it.

## Decisions

Made by the agent while fleshing this out; review these first.

1. **Three verdicts, told apart by how far the newest connection attempt got.** Each platform transport reports a stage; the shared loop turns "not online for a while" plus the stage into a verdict:

   | Stage the newest attempt reached                                                                                                              | Verdict       | Spoken                                                                                        | Screen status                      |
   | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
   | no IP lease (wrong password, SSID not visible, 5 GHz-only network)                                                                            | `no-wifi`     | "Couldn't join the Wi-Fi network. Check the password, and that it's a 2.4 gigahertz network." | `couldn't join the Wi-Fi network`  |
   | IP lease, but DNS/TCP/TLS to the OS host failed                                                                                               | `no-internet` | "Joined the Wi-Fi, but couldn't connect to the internet."                                     | `couldn't connect to the internet` |
   | the host answered, but the WebSocket upgrade was refused (HTTP ≠ 101, e.g. a deleted preview's 404) or authenticate/mount failed or timed out | `no-iterate`  | "Connected to the internet, but couldn't reach iterate."                                      | `couldn't reach iterate`           |

   Telling these apart is cheap: the ESP transport already knows whether it has an IP lease, and ESP-IDF's `esp_transport_ws_get_upgrade_request_status()` says whether an HTTP response arrived. The Mac transport parses the status line itself. A Mac never reports `no-wifi`.

2. **Offline means "not online for 15 s", not "not online".** Boot, Wi-Fi join, TLS and mount take a few seconds, and a brief drop must not look like an outage. After 15 s continuously not mounted (since boot, or since the mount was last lost) the verdict is the stage's. The device keeps retrying the whole time; the verdict clears the moment it mounts.

3. **A press while offline doesn't start a call.** No capture, no `wants_call`, no wake chime: the board speaks the verdict's message instead. A press in the first 15 s (the verdict is still "connecting") behaves as today — capture starts so opening words are kept — but if the verdict turns offline before the call is accepted, the activation ends right then and the device speaks the message instead of waiting out the 20 s deadline and saying "Call ended."

4. **Spoken at boot once, then only on a press.** The first offline verdict after power-on is spoken (the person just plugged it in and is listening). Going offline later (router reboot at 3 am) is shown on the ring/screen but not spoken until someone presses.

5. **Status while connecting names the step**: `joining Wi-Fi` while there's no IP lease, `connecting to iterate` after. Today it says `connecting to iterate` from boot.

6. **LED ring**: offline is a slow red pulse, distinct from connecting (amber breathing), muted (steady dim red), media failure (steady red-orange). Screens show the status text. Boards with a 12-pixel diagnostic grid show red network pixels.

7. **Sounds are baked like the existing two**: three new WAVs in `assets/sounds/`, rendered once with OpenAI TTS in `marin` (the voice the existing "Call ended." uses), 16 kHz mono PCM16, converted by `tools/baked-sounds.cmake` into every board. Flash cost is ~250 KB; the smallest app partition (M5StickS3, 2 MiB) has ~700 KB free.

8. **Kit web side unchanged.** Its done screen already says "the board only joins 2.4 GHz networks, check the network and password, then flash again", which matches the `no-wifi` message.

## Checklist

- [x] core: `iterate/kit/connectivity.h` — the stage enum each transport reports, the verdict enum, and the 15 s rule as a pure function with a host test _(components/core/src/connectivity.c, tests/connectivity_test.c)_
- [x] ESP transport: report the stage (IP lease, last open failure had an HTTP response or not, socket open but not mounted) _(`esp_transport_ws_get_upgrade_request_status` read before destroy in websocket_connection.c; `network_stage` atomic in itx_transport.c)_
- [x] Mac transport: report the stage (DNS/TCP/TLS vs HTTP refusal vs mount) _(any response byte = host answered; failure log prints the status line)_
- [x] fake transport: scriptable stage for loop tests _(also `set_last_restart_note`)_
- [x] voice loop: verdict in the view, refuse starts while offline, end an opening activation when the verdict turns offline, notice counter for spoken messages, connecting status names the step, ~~verdict in health~~ and logs _(health is only readable while online, and its 2816-byte buffer fails whole when a field overflows; the verdict is logged on every change instead)_
- [x] board table: offline clips in `struct iterate_kit_board_sounds`; board.c plays the clip on a notice and keeps the session chimes quiet while offline _(clip lookup is `iterate_kit_board_offline_sound`, host-tested in board_table_test.c)_
- [x] every board table (havpe, satellite1, m5sticks3, stackchan, waveshare, waveshare-rlcd, zectrix-note4) references the clips
- [x] ring + diagnostic lights: offline look _(`ITERATE_KIT_NETWORK_OFFLINE`; ring pulses red, grid's network sector red, screen chase red)_
- [x] three WAVs rendered and committed; `make-sounds.py` docstring says how _(gpt-4o-mini-tts/marin, speech loudness matched to call_ended.wav, checked by transcribing with whisper-1)_
- [x] host test driving the loop: boot with no Wi-Fi → spoken `no-wifi` at 15 s; a press → refused, spoken again; a press while connecting → ended early when the verdict turns; online → a press starts a call _(tests/voice_loop_offline_test.c, plus `after-own-restart`; mutation-checked)_
- [x] ~~Mac board proof: `iterate-kit-mac` against an unreachable host and a deleted preview prints the verdicts~~ Mac transport proof instead _(`iterate-kit-mac` blocks in CoreAudio waiting for a microphone permission this session can't grant; a throwaway probe ran the real darwin transport against a deleted preview → `no-iterate` (HTTP 404), `127.0.0.1:9` and a `.invalid` domain → `no-internet`; the classification is also unit-tested in darwin_itx_transport_test.c)_
- [x] firmware README: a paragraph on the offline verdicts _("When a board can't get online")_
- [ ] PR body: real-hardware steps for Misha (HA Voice PE, wrong Wi-Fi password)

## Implementation notes

- Spoken words changed from the first draft for `no-internet`: "Joined the Wi-Fi, but couldn't connect to the internet." reads as the middle rung of the other two.
- The boot notice is skipped when the loop restarted itself (`iterate_kit_platform_last_restart_note()` is non-empty): a board offline for good restarts every 7 minutes (`ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS`), and would otherwise announce itself to an empty room each time.
- A deleted preview (`pr1-deleted-os-preview.iterate-dev-preview.workers.dev/api`) answers the WebSocket upgrade with HTTP 404, confirmed with curl; `os.iterate.com/api` without a token answers 401. Both are `no-iterate`.
- Flash: the three clips are 368 KB of PCM. Smallest headroom is M5StickS3 (2 MiB app slot, 1.37 MB image).
