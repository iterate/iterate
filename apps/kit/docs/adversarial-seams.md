# Adversarial seams for the host rig

`targets/host_cli` runs the device's own C on macOS through
`platforms/iterate_posix`, and it earns its keep: defects reproduce in seconds
instead of a ten-minute flash cycle, and it found eleven real ones in a day.

It also has a structural blind spot, and this document is about closing it.

## The blind spot, stated precisely

The rig's speaker is an `fwrite` into a WAV. **A file has no clock.** It accepts
every frame the instant it is offered, it can never be full, and it can never
run dry. Its socket reaches fifty frames a second without trying. So the ring
never sits below the prefill mark, `iterate_kit_voice_playback_clock_ready`
never returns false in a sustained way, and every latch that only fires when
the consumer is _waiting_ stays unarmed.

Worse than unarmed: **invisible**. A WAV carries no timestamps, so a run that
failed to feed the speaker for 180 ms of a three-second call produces a
recording that is simply 180 ms shorter and sounds perfect. Nothing in the rig
compares the recording against the wall clock, so nothing notices.

Four defects reached the device behind that blind spot:

| defect                                                              | what it needed to be caught                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a latch that left the speaker spinning on an empty ring forever     | a sink that consumes at a true 50 f/s and refuses to run ahead                             |
| concealment "debt" deleting one real word per inserted silence      | the same paced sink                                                                        |
| `response.done` treated as a barge-in, discarding the answer        | the same paced sink                                                                        |
| unsigned-time underflow rebuilding a healthy call 42 times in 3 min | a clock that can return a stamp 1 ms behind one already sampled                            |
| downlink starvation: 9–31 f/s against the 50 realtime needs         | a throttled, clumping downlink — the wire delivered 139 frames in one second, then nothing |

A file-backed sink that always keeps up is not a test double for a converter.
It is an optimist. **Every platform seam needs a knob that makes it behave as
badly as the real thing on its worst day, and the unattended run has to sweep
those knobs rather than always running the easy configuration.**

## Where each knob lives

Three places a knob can go, and the choice is not stylistic — it decides
whether the code under test is still the code that ships.

### Audio sink — a wrapping decorator

**Decision: a decorator that owns only WHEN a frame may be consumed.**
Implemented as `targets/host_cli/cli_paced_sink.{h,c}`.

The sink is already three collaborating things: `cli_speaker` is the queue,
`cli_wav` is the record, `cli_audio_out` is the room. The adversary here is
about _timing_, and none of those three owns timing. Put a rate limiter inside
`cli_wav` and the file writer acquires a clock it has no business having, and
`cli_audio_out` needs a second copy of the same logic. Put it outside the
process and there is nothing to put it outside of — a file sink has no process
boundary to throttle.

A decorator that answers one question — _may a frame be handed over yet, and
what happened while nobody handed one over_ — composes with all three, adds no
copy of the payload, and is under two hundred lines.

It also matches the shape of the thing being modelled. On the device the sink
_is_ a decorator: `i2s_channel_write` is admission control in front of a DMA
queue plus a copy. The host decorator models the admission control and lets
`cli_wav` keep the copy.

### Audio source — inside the seam implementation, except for rate

**Decision: bad microphones are source implementations; a slow microphone is
the paced decorator inverted.**

`cli_wav_source` already carries this design: given no file it synthesises a
bounded voiced tone, because a provider handed silence has nothing to
transcribe. A source that clips, that carries DC offset, that returns 300 bytes
when asked for 640, or whose first 200 ms after start are garbage, cannot be
expressed as a filter over a good source — "the driver returned a short
buffer" is not a transformation of a frame, it is a different thing happening.
So content faults belong in the implementation, selected by flag, alongside the
synthesiser that is already there. `cli_audio_in`'s `short_buffers` counter is
the shape of it: a real capture path really does hand back partial buffers
around start and stop, and the honest model counts and drops them rather than
padding a click onto the front of every turn.

_Rate_ is the exception, and it is timing, not content. A microphone that
delivers 47 frames a second is the paced decorator with the arrow reversed, and
should reuse it rather than grow a second implementation of the same clock.

### Byte stream (`platforms/iterate_posix/tls_stream`) — outside the process

**Decision: a local reshaping proxy, and nothing inside the adapter.**

This is the one seam whose adversary genuinely belongs to somebody else.
`iterate_kit_posix_tls_stream` is a one-owner nonblocking OpenSSL adapter whose
whole value is that `connect`, `read`, and `write` perform exactly one bounded
transition and distinguish scheduler deferral from loss. Threading loss and
delay knobs through it means the code under test is no longer the code that
ships, in the module where that matters most.

There is also a correctness argument that settles it. **A TCP-level adversary
cannot drop, duplicate, or reorder an application frame.** By the time bytes
reach `tls_stream` they are ordered, retransmitted, and MAC-protected; loss on
the wire manifests as _delay_, never as a missing frame. So the wire knob and
the frame knob are two different knobs in two different places:

- **Wire timing** — delay, clumping, stall, reset — goes in a proxy that
  terminates nothing and merely reshapes when bytes move. This reproduces
  exactly what was measured on the device: 139 frames arriving in one second
  and then nothing. The firmware is untouched.
- **Frame loss, duplication, and reordering** are the _sender's_ behaviour and
  the reconnect machinery's, not TCP's. They are injected at the delivery
  boundary — the `on_speaker` callback and the `answer`/`frame` identity that
  `iterate_kit_playout` already classifies — in a host test, not on a socket.

Conflating the two is how a rig ends up "testing packet loss" while proving
nothing about the only kind of loss this system actually suffers.

### Clock — inside the seam, because it is already one

**Decision: a second implementation of the existing function pointer, not a
decorator.**

`iterate_kit_voicelab_options.now_ms` is already a function pointer, and
`cli_runtime_now_ms` is its only implementation. A virtual clock is simply a
second one. A decorator would be wrong here because a decorator implies a real
clock underneath, and half the value of this seam is running with **no real
clock at all** — a sealed rig whose every stamp comes from a counter and whose
runs therefore replay bit for bit.

Honest state of the seam today: the pointer covers the voicelab callbacks, but
`cli_runtime_now_ms` is also called **directly nine times** (six in `main.c`,
three in `cli_capabilities.c`), and `clock_gettime` is read directly in
`main.c` and `platforms/iterate_posix/posix_itx_transport.c`. Every one of
those is a place the rig cannot be made deterministic. Routing them through the
pointer is a prerequisite for everything in the determinism section below, and
it is the cheapest item in this document.

## The knob set

Defaults are chosen so that **every knob off reproduces today's behaviour
exactly**. A knob nobody can turn off does not get left in.

### Sink

| knob                 | units         | default                          | targets                                                                                                                          |
| -------------------- | ------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--speaker-pace`     | frames/second | `0` (off)                        | reader spinning on an empty ring; concealment debt; `response.done` as barge-in; any deficit a file silently absorbed            |
| sink depth           | frames        | `4` (the board's 90 ms I2S lead) | how long a scheduler stall is absorbed before the listener hears it; at `0` every stall is audible, at `8` a 160 ms stall is not |
| refusal to run ahead | —             | implied by pacing                | catch-up bursts that hardware would have refused; the loop's four-frame stall forgiveness                                        |

Implemented: `--speaker-pace`. Depth defaults to the device's lead and is the
next flag to expose.

### Source

| knob             | units            | default   | targets                                                                                  |
| ---------------- | ---------------- | --------- | ---------------------------------------------------------------------------------------- |
| capture rate     | frames/second    | `50`      | uplink starvation; the mic queue's drop-oldest policy under a slow producer              |
| short buffers    | 1-in-N callbacks | off       | partial-buffer handling at turn start; already counted by `cli_audio_in.short_buffers`   |
| clipping         | dBFS ceiling     | off       | the full-scale sample path — this is exactly where the mu-law encoder defect below lived |
| DC offset / gain | LSB / dB         | `0` / `0` | AEC and endpointing behaviour against a badly levelled input                             |

### Byte stream (proxy) and delivery (in-process)

| knob                 | units                    | default     | where    | targets                                                 |
| -------------------- | ------------------------ | ----------- | -------- | ------------------------------------------------------- |
| downlink rate        | frames/second            | unthrottled | proxy    | the measured 9–31 f/s starvation                        |
| burst / gap clumping | frames per burst, gap ms | off         | proxy    | 139 frames in one second then nothing                   |
| stall                | ms                       | off         | proxy    | the 17–19 s outages that look like a reboot and are not |
| reset                | after N bytes            | off         | proxy    | reconnect and recycle paths, mid-answer                 |
| frame loss           | 1-in-N                   | off         | delivery | sequence-gap accounting, concealment                    |
| frame duplication    | 1-in-N                   | off         | delivery | playout identity: a duplicate must not be played twice  |
| frame reordering     | window, frames           | off         | delivery | `answer`/`frame` classification of a superseded answer  |

### Clock

| knob           | units        | default | targets                                                                                                              |
| -------------- | ------------ | ------- | -------------------------------------------------------------------------------------------------------------------- |
| jitter         | ± ms         | `0`     | deadline arithmetic that assumes evenly spaced stamps                                                                |
| monotonic skew | ms backwards | `0`     | **the 42-rebuilds-in-3-minutes defect**: an unsigned elapsed-time underflow trips every supervision deadline at once |
| rate           | multiplier   | `1.0`   | long-run behaviour (wraparound, saturation) without waiting a day                                                    |

`cli_paced_sink` already refuses to subtract a backwards stamp and counts it in
`skew_stamps`; a clock that can _produce_ one is what makes that assertion
worth having outside a unit test.

### CPU

| knob            | units             | default | targets                                                                                                                                                                        |
| --------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stall injection | ms, at a schedule | off     | **the device's task is preempted; the CLI's is not.** Everything the loop forgives during a stall — the four-frame playback clamp, the mic deadline clamp — is invisible today |

This is the knob that makes the paced sink earn its place: a stall with a file
sink costs nothing and reports nothing; the same stall with a converter is
silence the listener heard.

## Determinism

### What must be seeded

One PRNG per session, seeded once, consumed in a **fixed order** by a schedule
generator that runs to completion _before_ the session starts. A generator
consulted lazily, mid-run, is not reproducible: any change to how often a knob
is asked for a decision reshuffles every subsequent draw. Generating the whole
schedule up front makes it an artifact — printable, diffable, attachable to a
bug.

The schedule covers: stall times and durations, clock jitter and skew events,
downlink rate changes and clump boundaries, loss/duplication/reordering
selections, utterance order, and turn gaps.

### What must not consult a real clock

- the sink model (`cli_paced_sink` reads no clock — the caller passes the
  stamp, which is why the deliverable test below can drive it from a counter),
- the source model,
- the schedule generator,
- the loop's own `now`, sampled once per iteration and passed down — which
  `cli_main_run_loop` already does correctly, and the nine direct
  `cli_runtime_now_ms` calls already do not.

### What cannot be made deterministic

**With real network I/O in the loop, nothing is.** TCP timing, provider
latency, model sampling, TLS session resumption, DNS, and macOS scheduling are
all outside the seed. Pretending otherwise would be the same category of
optimism this document exists to remove. So there are two lanes and they make
different promises:

- **Sealed lane** — virtual clock, no sockets, every seam a model. A seed
  replays the run bit for bit. This is where `cli_paced_sink_test` lives, where
  regressions are gated, and where a failure is a fact rather than a report.
- **Live lane** — real provider, real wire, injections driven by the seeded
  schedule. **A seed reproduces what we did to the system, not what happened to
  it.** That is still worth having: it turns "it failed once, overnight" into
  "it failed under schedule `0x8f31a44c`, and here is that schedule again",
  which is the difference between a bug you can chase and one you cannot.

Say which lane a result came from, every time. A sealed-lane pass is a proof; a
live-lane pass is evidence.

## How the unattended run sweeps

### Enumerated matrix — the gate

Small, total, and every cell meaningful:

```
pacing        { off, 50 f/s }
sink depth    { 2, 4, 8 }
downlink      { 50, 30, 9 } frames/second
```

Eighteen cells, a fixed number of turns each, run in the sealed lane on every
change. **Each cell carries an expected outcome**, and this is not a detail: at
9 f/s the correct result is _heavy concealment and no restart_, not clean
audio. A matrix without per-cell expectations either fails constantly and gets
muted, or asserts so little that it passes through real regressions.

### Seeded random schedules — the search

The overnight run draws a seed per session, composes a schedule across every
knob above, runs it, and records the seed. A fixed matrix finds the faults
somebody predicted; after the first week it stops finding anything. Random
schedules find the combinations nobody thought to enumerate — which is where
all five defects in the opening table actually came from.

Both, not either. The matrix is the regression gate; the schedules are the
search.

### Reporting a failure so it can be replayed

- The seed goes in `cli_report`'s summary and in the first log line of the
  session, so a truncated log still carries it.
- A failing session prints its seed last as well as first, because that is
  where anybody looks.
- `--schedule-seed 0x…` re-runs the identical schedule; in the sealed lane that
  is an identical run.
- The schedule itself — not just the seed — goes in the report, because a seed
  is only reproducible against the same generator, and generators get edited.

## The worked seam

`targets/host_cli/cli_paced_sink.{h,c}` models the converter's clock and
nothing else: a fixed-depth queue drained one frame per period, refusing a
caller that tries to run ahead, counting a frame of true silence for every
drain boundary that found nothing. Unpaced — the default — it accepts
everything and reports nothing, which is exactly the file sink it wraps.

`tests/cli_paced_sink_test.c` runs the CLI's own playback loop twice over a
virtual clock: same ring, same audio, same 200 ms scheduler stall, only the
sink swapped. It prints what it found:

```
3000 ms call: file sink recorded 2820 ms and reported nothing;
converter recorded 3060 ms and reported 120 ms of silence
```

The file-backed run is immaculate and its recording is 180 ms short of the
call. The converter's run reports 120 ms of silence — the stall minus the
80 ms the DMA lead covered — and its recording spans the call. Pointed at a
sink that always keeps up, the test fails on
`converter.converter_underruns > 0`; that is the whole point of it.

## What this still cannot catch

Every item here is a real failure mode of the shipped device that no host rig
reaches, however adversarial its seams. Listing them is part of the design: a
rig that is trusted beyond its reach is more dangerous than one nobody trusts.

**Audio hardware.** I2S DMA descriptor underrun and the pop it makes;
amplifier settle and turn-on transients; codec clock-domain drift between
capture and playback; ADC self-noise, gain staging, and the analogue clipping
that produced full-scale samples; the acoustic path itself — echo, room
response, the enclosure, and whether AEC converges in it.

**The chip.** PSRAM contention and cache misses on the real bus; IRAM and DIRAM
budgets; FreeRTOS priority inversion and genuine preemption, which the
cooperative loop can only caricature; heap fragmentation over a day; brownout
under transmit current; thermal behaviour; flash write stalls; the watchdog.

**The radio.** Wi-Fi outages, 802.11 roaming, the station-outage ladder that
looked like a reboot and was not, DHCP renewal, captive portals, and the
seventeen-to-nineteen-second detection-plus-backoff sequences that no proxy
reproduces because they are not about bytes.

**The platform difference.** The host has an MMU, virtual memory, a preemptive
scheduler, and gigabytes; the ESP32-S3 has none of those. A pointer bug that
faults cleanly on macOS corrupts a neighbouring buffer on the device, and a
stack depth that is fine here is a crash there.

**And the honest one about this rig:** the paced sink models a converter's
_admission and timing_. It does not model a converter. It cannot tell you the
audio sounded wrong — only that it arrived late, or not at all.
