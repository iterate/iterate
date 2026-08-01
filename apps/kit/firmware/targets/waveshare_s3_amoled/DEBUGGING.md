# Debugging this device without lying to yourself

Hard-won rules. Each one cost hours; several invalidated conclusions that
looked solid at the time.

## 1. Opening the serial port REBOOTS the board

Every time. Regardless of `DTR`/`RTS` — setting them low before `open()` does
not help, the ESP32-S3's USB-Serial-JTAG resets on host attach.

The consequences are worse than losing a boot:

- A reboot kills the device's Cap'n Web session, so any test running
  concurrently fails with `Peer closed WebSocket: 1006`. **You will diagnose
  session instability that you caused.** That happened repeatedly here.
- "The capability is offline" during a test usually means the device is
  re-mounting after a reset you triggered, not that anything is wrong.

**So: never attach serial while measuring.** Serial is for bring-up and for
reading a crash you have already reproduced. Everything else goes through
telemetry on the stream.

## 2. Telemetry is the instrument, not the console

`voicelab/dev-stats` (ephemeral, every 5s) carries the health of everything:
transport failures, inbox depth and discards, concealment and catch-up
counters, buffer margin floor and ceiling, DMA headroom, session and
connection generations. Read it with a live `openConnection`; it costs the
device nothing and does not perturb what it measures.

Two counters need care:

- `spkMarginMinMs` is a floor. Once it hits 0 it stays 0 for the call — read
  it as "did we ever get close", not "are we close now".
- Concealment is only a defect **mid-answer**. The buffer legitimately
  empties when an answer ends, and counting that read one underrun per
  answer no matter how healthy the pipe was.

## 3. Metrics can be designed not to see the bug

Two real examples from this device:

- Catch-up frames are dropped _on purpose_, so they were not counted as
  errors — while an unbounded catch-up loop was discarding seconds of speech
  at a time. The counters said "zero underruns" and the speaker said
  otherwise.
- `speaker.pcm` is a bare concatenation of successful writes with no
  timestamps, so a DMA underrun appears as a **seamless join**. A stuttering
  device produces a clean-looking recording. Timing defects are invisible in
  that file by construction; only the gap between writes shows them.

When a measurement says "fine" and a human says "broken", the human is
right and the measurement is answering a different question.

## 4. Reproduce the user's journey, not an approximation

`pnpm cli voicelab device --action journey` drives exactly what a person
does — press call, wait for it to be _live_, hold talk, release, wait for the
answer — timing every step and screenshotting the display at each one. "It
takes forever" and "the screen is stuck" are only actionable once you can see
which step stalled and what the screen showed while it did.

## 5. A stream you keep appending to gets slower forever

Durable events accumulate in the stream's Durable Object. `dev-stats` was
durable and appended every 5 seconds for as long as any device had ever run;
appends on that path eventually took **700-1000ms each against 72ms on a
fresh stream**. Every handshake step is one append, so the device took 22
seconds to boot and calls felt glacial.

Health samples are ephemeral. If you find yourself appending something on a
timer, ask whether anyone will ever want it back.

## 6. Resolve the port by serial number, never by suffix

`usbmodemNNN` is assigned by enumeration order. With several boards attached,
"the first one" is a coin flip — and flashing the wrong board is silent.

```sh
PORT=$(python -m serial.tools.list_ports -v | grep -B2 "SER=1C:DB:D4:7A:16:C8" \
       | grep "^/dev" | head -1)
```

The Waveshare is `1C:DB:D4:7A:16:C8`. This rule was written down before it
was broken; writing it down is not the same as following it.

## 7. Rapid redeploys leave zombies

A worker redeploy does not stop the previous isolate. Its Grok socket and its
stream subscription stay live, so **two bridges answer the same turn** and
their audio interleaves — which sounds exactly like corruption. Bridges now
stamp a `bridgeId` and stand down when they see a newer one take the call,
but when a measurement looks impossible (more audio arriving than exists),
suspect this first.

## The commands worth remembering

```sh
# From apps/os, with a Doppler config pointing at the deployment.
pnpm cli voicelab device --action journey    --project prj_… --out ./journey
pnpm cli voicelab device --action status     --project prj_…
pnpm cli voicelab device --action screenshot --project prj_… --out screen.png
pnpm cli voicelab device --action pull       --project prj_… --out ./recording
pnpm cli voicelab device --action tone       --project prj_… --seconds 20
```

`tone` is the one that removes the model from the loop entirely: a 440 Hz
sine down the same path the voice takes. Anything audible in the result
belongs to the transport or the device.
