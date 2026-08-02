# Debugging this device without lying to yourself

The full account — the rules, what each one cost, and the commands — lives in
the **`debug-voice-device` skill**
([`.agents/skills/debug-voice-device/SKILL.md`](../../../../.agents/skills/debug-voice-device/SKILL.md)),
so an agent picks it up without being told. This page is the short version for
anyone already looking at the firmware.

## Start here

```sh
# From apps/os, with a Doppler config pointing at the deployment.
pnpm cli voicelab device --action health --project prj_…
```

Every producer on the device sits behind one gate — voicelab READY, transport
READY, generations equal. Shut, the device answers RPCs perfectly while
starting no calls, sending no audio and pushing no telemetry: alive from
outside, doing nothing. **`gateOpen` is usually the whole answer**, and
`dev-stats` cannot tell you, because `dev-stats` is appended from inside that
same gate.

## The one that invalidates everything else

**Attaching serial reboots this board.** Every time, regardless of DTR/RTS —
it is the USB-Serial-JTAG bridge. The reboot kills the device's session, so
anything running concurrently fails with `Peer closed WebSocket: 1006`, and
you will spend hours diagnosing instability you caused. Serial is for bring-up
and for reading a crash you have already reproduced.

## The rest, in one line each

- **A one-way append can never notice a dead peer.** Audio rides one-way
  appends by design; the socket can be half-open with the transport still
  READY. Liveness is proved (ping resolution, and the bridge's pong), never
  assumed.
- **Metrics can be designed not to see the bug.** Catch-up frames were dropped
  on purpose and so not counted; `speaker.pcm` renders an underrun as a
  seamless join. When a measurement says "fine" and a human says "broken", the
  human is right.
- **Cushions stack.** The device's ~390ms prefill ADDS to the bridge's opening
  burst. Check `spkOverflow` and `spkMarginMaxMs` before blaming Wi-Fi.
- **A stream appended to on a timer gets slower forever.** Health samples are
  ephemeral for this reason.
- **Resolve the port by serial number** (`SER=1C:DB:D4:7A:16:C8`), never by
  `usbmodemNNN` suffix.
- **Rapid redeploys leave zombies**: two bridges answering one turn sounds
  exactly like corruption.
- **PSRAM stays at 40MHz, flash at DIO**, and new static buffers go in PSRAM —
  internal RAM is the TLS handshake's working set.

## The commands worth remembering

```sh
pnpm cli voicelab device --action health     --project prj_…
pnpm cli voicelab probe                      --project prj_… --turns 2
pnpm cli voicelab device --action journey    --project prj_… --out ./journey
pnpm cli voicelab soak                       --project prj_… --minutes 60
pnpm cli voicelab device --action screenshot --project prj_… --out screen.png
pnpm cli voicelab device --action pull       --project prj_… --out ./recording
pnpm cli voicelab device --action tone       --project prj_… --seconds 20
pnpm cli voicelab deploy                     --project prj_…
```

`probe` is the one that removes the device from the question entirely: a call
on a fresh stream, text turns, every provider event printed as it lands.
`tone` removes the model instead — a 440 Hz sine down the same path the voice
takes, so anything audible in the result belongs to the transport or the
board.
