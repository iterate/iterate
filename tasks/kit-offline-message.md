---
status: in-progress
size: medium
---

# Kit boards say when they can't get online

**Status:** spec written, implementation not started.

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
   | IP lease, but DNS/TCP/TLS to the OS host failed                                                                                               | `no-internet` | "Couldn't connect to the internet."                                                           | `couldn't connect to the internet` |
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

- [ ] core: `iterate/kit/connectivity.h` — the stage enum each transport reports, the verdict enum, and the 15 s rule as a pure function with a host test
- [ ] ESP transport: report the stage (IP lease, last open failure had an HTTP response or not, socket open but not mounted)
- [ ] Mac transport: report the stage (DNS/TCP/TLS vs HTTP refusal vs mount)
- [ ] fake transport: scriptable stage for loop tests
- [ ] voice loop: verdict in the view, refuse starts while offline, end an opening activation when the verdict turns offline, notice counter for spoken messages, connecting status names the step, verdict in health and logs
- [ ] board table: offline clips in `struct iterate_kit_board_sounds`; board.c plays the clip on a notice and keeps the session chimes quiet while offline
- [ ] every board table (havpe, satellite1, m5sticks3, stackchan, waveshare, waveshare-rlcd, zectrix-note4) references the clips
- [ ] ring + diagnostic lights: offline look
- [ ] three WAVs rendered and committed; `make-sounds.py` docstring says how
- [ ] host test driving the loop: boot with no Wi-Fi → spoken `no-wifi` at 15 s; a press → refused, spoken again; a press while connecting → ended early when the verdict turns; online → a press starts a call
- [ ] Mac board proof: `iterate-kit-mac` against an unreachable host and a deleted preview prints the verdicts
- [ ] firmware README: a paragraph on the offline verdicts
- [ ] PR body: real-hardware steps for Misha (HA Voice PE, wrong Wi-Fi password)

## Implementation notes

(log, appended while working)
