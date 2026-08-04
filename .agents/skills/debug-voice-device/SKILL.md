---
name: debug-voice-device
description: Diagnose the Waveshare ESP32-S3 voice device and its userspace voicelab bridge — "nothing comes out of the speaker", choppy audio, calls that never start, sessions that die overnight. Use before touching a serial cable, because attaching one reboots the evidence away.
---

# Debugging the voice device

## Deterministic AEC qualification is a Mac fixture job

Do not use Grok to qualify StackChan or HAVPE AEC. Follow
[`apps/kit/docs/aec-release-qualification.md`](../../../apps/kit/docs/aec-release-qualification.md)
for the release-blocking path: a purpose-built authenticated Kit process on the
Mac owns the exact playback/near-end bytes, `/api` peer, `/pcm` server,
recorder, interval-aligned network monitor, raw/reference/clean artifacts, and
offline scorer. The device reaches it through a random Captun URL under
`tunnels.iterate.com`; the public URL alone is insufficient because both lanes
require the run's fresh project secret. Direct LAN is an explicit diagnostic
isolation mode, not a replacement release proof.

Run `pnpm aec:calibrate`, materialize the immutable 32-phase fixture bundle,
run `pnpm aec:physical`, then independently run `pnpm aec:score`. Normal and
exception cleanup restores Mac output volume and the saved device configuration;
never interrupt the temporary configuration interval with `kill -9` or USB
unplug. Grok follows only as the independent production conversation,
self-trigger, server-VAD, and interruption gate. A Grok success cannot qualify
DSP, and a deterministic AEC success cannot qualify Grok.

The retained matrix uses independent real speech voices: Daniel through the
device speaker, Samantha through the Mac. Speech and double-talk qualification
must use those byte-identical retained sources; artificial tones/noise are
diagnostic probes only. Otherwise a provider may simply distinguish speech
from a convenient interference pattern and give a false impression that echo
was cancelled.

The device is an ESP32-S3 that holds one Cap'n Web session to `/api` and
rides the streams abstraction for audio. Its server side is userspace code:
`apps/os/scripts/voicelab/config-repo/worker.ts`, deployed into the project's
config repo. Everything below is an ordinary capability call — nothing here
needs privileged access, and an agent can run all of it.

## Run these three, in this order

```sh
# From apps/os, with a Doppler config pointing at the deployment.
pnpm cli voicelab device --action health  --project prj_…   # what state is it in?
pnpm cli voicelab probe  --project prj_… --turns 2          # is the BRIDGE fine, with no device involved?
pnpm cli voicelab journey --project prj_… --out ./journey   # drive it the way a person does
```

**`health` first, always.** Every producer on the device sits behind one
gate — voicelab READY, transport READY, generations equal. With that gate
shut the device answers RPCs perfectly while starting no calls, sending no
audio and pushing no telemetry: alive from outside, doing nothing. `gateOpen`
is usually the whole answer, and `dev-stats` cannot tell you because
`dev-stats` is appended from inside the same gate.

**`probe` second**, because it removes the device entirely: it opens a call on
a fresh stream, takes text turns, and prints every provider event with
timings. "The second turn never answers" becomes a question about the bridge
or an observation about the device in one command.

## The rules that cost the most

### `/dev/cu.usbmodemNNNNN` IS NOT A BOARD

Four ESP32s sit on this desk and macOS renumbers the ports when any of them
is replugged. `usbmodem11301` was the Waveshare in the morning and a
different board by the evening.

Four flashes went to the wrong chip before anyone noticed, and every signal
that should have caught it was explained away instead:

- esptool reported `Hash of data verified` — it had, on the wrong board;
- `uptimeMs` never reset after a flash — read as a flaky reset pin;
- a counter kept climbing through code that had been DELETED — read as a
  stale build.

Any one of those is proof the running image is not the one just written.
Together they are conclusive, and they were still not enough, because each
had a plausible individual excuse. **Resolve the board by SERIAL NUMBER
before every flash**, and confirm afterwards that `uptimeMs` went backwards:

```sh
system_profiler SPUSBDataType | grep -B 8 "Serial Number: 1C:DB:D4:7A:16:C8"
# Location ID 0x0112.... -> /dev/cu.usbmodem112xx
```

A capability call is the honest reset — `restart()` over itx reboots the
board that is actually serving `kit.<name>`, which is by definition the one
under test.

### Attaching serial REBOOTS this board

Every time, regardless of DTR/RTS — it is the USB-Serial-JTAG bridge. Worse
than losing a boot: the reboot kills the device's session, so anything
running concurrently fails with `Peer closed WebSocket: 1006` and **you will
diagnose instability you caused**. Serial is for bring-up and for reading a
crash you have already reproduced. Everything else goes through `health` and
the telemetry on the stream.

### A one-way append can never notice a dead peer

Audio rides one-way appends by design, so the socket can be half-open — TCP
dead, transport still READY — with nothing on the device able to tell. The
device now proves liveness instead of assuming it: a ping whose append does
not resolve in 15s replaces the transport, no round trip at all for 180s
restarts the chip, and a call is believed only while its bridge keeps
answering (the pong is the one bridge event that arrives during a silent
call). If you add a lane, ask what proves it is still working.

### Metrics can be designed not to see the bug

Real examples from this device:

- Catch-up frames are dropped _on purpose_, so they were not counted as
  errors — while an unbounded catch-up loop discarded seconds of speech.
- `speaker.pcm` is a bare concatenation of successful writes, so a DMA
  underrun appears as a **seamless join**. A stuttering device produces a
  clean recording. Only the gap between writes shows timing defects.
- `spkMarginMinMs` is a floor: once it hits 0 it stays 0 for the call.
- Concealment is only a defect _mid-answer_. The buffer legitimately empties
  when an answer ends.

When a measurement says "fine" and a human says "broken", the human is right
and the measurement is answering a different question.

### Cushions stack

The device waits ~390ms of prefill before it plays anything, and the bridge
adds its own opening burst (`BURST_MS`). They ADD. Against a 900ms internal
ring, a 450ms burst put the steady-state margin at 811-898ms — full — and one
answer overflowed it 64 times, which is a second and a quarter of speech
discarded on arrival. That is what "very choppy" sounds like. Check
`spkOverflow` and `spkMarginMaxMs` before believing any theory about Wi-Fi.

### A stream appended to on a timer gets slower forever

Durable events accumulate in the stream's Durable Object. A `dev-stats`
append every 5 seconds eventually took **700-1000ms against 72ms on a fresh
stream**; every handshake step is one append, so the device took 22 seconds
to boot. Health samples are ephemeral now. If you find yourself appending on
a timer, ask whether anyone will ever want it back.

The same trap on the worker side: the bridge used to reopen its stream
connection whenever no batch had arrived for 5s — which is the normal state
of an idle call — and each cycle appended the platform's connection
bookkeeping to the stream, on a timer, forever.

### Resolve the port by serial number, never by suffix

`usbmodemNNN` is assigned by enumeration order. With several boards attached
"the first one" is a coin flip, and flashing the wrong board is silent.

```sh
PORT=$(python -m serial.tools.list_ports -v | grep -B2 "SER=1C:DB:D4:7A:16:C8" \
       | grep "^/dev/cu" | head -1)
```

The Waveshare is `1C:DB:D4:7A:16:C8`. This rule was written down before it was
broken; writing it down is not the same as following it.

### Rapid redeploys leave zombies

A worker redeploy does not stop the previous isolate: its Grok socket and its
stream subscription stay live, so **two bridges answer the same turn** and
their audio interleaves — which sounds exactly like corruption. Bridges stamp
a `bridgeId` and stand down when a newer one takes the call, but when a
measurement looks impossible (more audio arriving than exists), suspect this
first.

## Proving it, rather than asserting it

```sh
pnpm cli voicelab soak --project prj_… --minutes 60 --every 45 --out soak.json
```

Every failure this lab has had arrives on a clock — the push budget running
out, a bridge evicted without saying so, a Durable Object filling up — so
nothing shorter than the target duration tells you anything. The soak reports
counters over TIME and its verdict is PASS only if every turn was answered,
nothing that must never move moved, and the device never restarted (a device
that rebooted has pristine counters afterwards; only `uptimeMs` going
backwards gives it away).

Note `watchReopens` in the summary: that is the soak replacing its OWN
watcher, not a device fault. A dead watcher does not report an error, it
reports a silent call — the first run of this soak "found" four unanswered
turns that the bridge had in fact answered.

## StackChan/HAVPE AEC uses the deterministic Mac fixture first

Do not use Grok audio to qualify AEC on StackChan or Home Assistant Voice
Preview Edition. Follow
[`apps/kit/docs/aec-release-qualification.md`](../../../apps/kit/docs/aec-release-qualification.md):
materialize byte-exact far/near fixtures, expose the same authenticated local
`/api` and `/pcm` handler through Captun at `tunnels.iterate.com`, retain raw /
reference / clean outputs, and score offline. Grok is a later independent
conversational/self-trigger gate. This separation prevents provider generation
and network variability from being misclassified as DSP behavior.

## Building and flashing

```sh
cd apps/kit/firmware && source ~/esp/esp-idf/export.sh
idf.py -C targets/waveshare_s3_amoled -B ../../.build/waveshare_s3_amoled build
idf.py -C targets/waveshare_s3_amoled -B ../../.build/waveshare_s3_amoled -p "$PORT" -b 921600 flash
```

Deploying the server side is a command, not a paste:

```sh
pnpm cli voicelab deploy --project prj_…    # commits config-repo/worker.ts
```

## Two settings that are not free to change

- **PSRAM stays at 40MHz and flash at DIO.** Raising PSRAM to 80MHz "to match
  the reference" caused consistent TLS signature-verification failures —
  marginal memory timing corrupts crypto long before anything visible.
- **Internal RAM is the TLS handshake's working set.** New static buffers
  belong in PSRAM (`EXT_RAM_BSS_ATTR`); putting them in internal `.bss` failed
  `mbedtls_ssl_setup` with `MBEDTLS_ERR_SSL_ALLOC_FAILED` and the device could
  not connect at all.
