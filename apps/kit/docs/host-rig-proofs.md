# What the host rig has actually been shown to do

Every number here came from a run against a real preview environment and a
real provider. Where a claim could have been made by reading a counter the
code itself produces, it was checked a second way — a recording measured
independently, or a file read back out of the project. The point of writing
them down is that "it worked" is not a result and does not survive the night.

Environment: `preview_3`, project `jonas-templestein-s-organization` — chosen
because it is NOT the lab project everything had been developed against, and
"works on the one project I have been testing" had already been mistaken for
"works" once.

## The command

```
pnpm cli voicelab talk
```

Prompts for environment, project (slug or `prj_` id) and stream path, then
installs `voice-agent.ts` into the project's config repo, ensures the xAI
secret from the Doppler config, waits for the guest worker to build, appends
the setup events, and hands the terminal to the C.

## 1. A long conversation holds

35 minutes unattended, nine rotating utterances, a forced back-office
consultation every fourth turn.

|                                                   |                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| turns                                             | 85 (84 `complete=ok`; #85 was cut by the run limit at 2100.003s) |
| sequence gaps                                     | **0** across 93,308 received frames                              |
| frames the speaker never got (`roomDrop`)         | **0**                                                            |
| concealment                                       | 48 frames of 72,446 played — 0.066%                              |
| sessions lost / transports restarted / calls lost | 0 / 0 / 0                                                        |
| back-office consultations                         | **21 of 21**                                                     |
| recording                                         | 2100.0s, exactly the wall clock                                  |

## 2. Counting to one hundred, every frame played

The model chunks a long count into several answers. Every one of them:
`received == played`, `conceal=0`, `gaps=0`, `underruns=0`.

Checked independently of the counters: the pretend speaker's recording spans
300.02s against 300s of wall clock and carries 12,514 voiced 10 ms blocks
against the playout timeline's 12,516 — the two missing blocks being the 20 ms
still in flight when the run was killed.

This needed a fix. `ITERATE_KIT_VOICE_TURN_MAX_MS` measured a turn from its
commit, so an answer still playing perfectly well was abandoned at thirty
seconds with hundreds of frames queued (`received=1857 played=1380`). The
deadline now runs from the last frame played, so a turn still producing audio
is never overdue and one that has genuinely stopped still ends exactly when it
used to.

## 3. The back office does real work

Spoken request → front office → `message_back_office` → back-office agent →
itx script → a commit in the project's config repo.

Verified by reading the repo rather than by believing the agent: `voiceproof.txt`
at commit `d60541b3`, containing `Hello from the back office`.

## 4. No real microphone or speaker required

`--pretend-speaker FILE` runs the **live converter** into a file: the same
ring, the same pull, the same starvation and drop accounting, with the loop
doing the pulling instead of CoreAudio's thread. `--mic-record FILE` records
what the microphone path captured.

It matters that this is the same module rather than a second path. That module
had already hidden a defect which made an entire conversation silent while the
WAV beside it recorded the audio perfectly and every counter stayed clean; a
rehearsal that took a different route through it would have proved nothing
about the route a listener hears.

## 5. Device faults reproduce here

| fault                                          | knob                                                                        | measured effect                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| frames lost, repeated, reordered by the sender | `--frame-loss-one-in`, `--frame-duplicate-one-in`, `--frame-reorder-one-in` | `gaps=68` in one turn, against `gaps=0` on every unharnessed run                                           |
| the audio task is preempted                    | `--cpu-stalls-per-min`, `--cpu-stall-max-ms`                                | 24 stalls → `roomDrop=77`, against `roomDrop=0` clean                                                      |
| the clock steps backwards                      | `--clock-skews-per-min`, `--clock-skew-max-ms`                              | a stamp behind one already issued, which no host clock can produce                                         |
| the board's bounded sizes                      | `--device waveshare-s3-amoled`                                              | I2S lead, ring and prefill taken from the firmware's own constants, with a test asserting they still agree |

Every schedule is drawn from a seed before the first frame moves and can be
written out with `--schedule-out` and replayed with `--schedule-in`, because a
seed only reproduces a run against the generator that drew it.

`injLost`, `injDup` and `injLate` are on the pulse line: without them a run
that injected nothing reads exactly like one that injected everything, and a
clean result from a schedule that never fired looks like proof.

## 6. The board does the same thing

Flashed 2026-08-03 with the firmware and a provisioning partition pointing at
the same preview project and the stream `/voicelab/device`, which
`setupVoiceAgent` had prepared exactly as it does for the CLI. Nothing about
the server side is device-specific.

A full journey driven the way a person drives it — press call, wait for live,
hold talk, release, wait for the answer:

| step           |                                                                                |
| -------------- | ------------------------------------------------------------------------------ |
| call went live | 4403 ms                                                                        |
| answered       | 4048 ms — _"I'll get that looked into right away. What were you thinking of?"_ |

Its own counters after that turn: `spkFrames=171`, `spkPlayed=171` — **every
frame received reached the speaker** — with `spkOverflow=0`, `spkSeqGaps=0`,
`spkDecodeFailures=0`, `spkBadFrames=0`, `spkDiscarded=0`, and 356 microphone
frames sent up. `spkConceal=24` and `spkUnderruns=2`, which is the board's
known behaviour when an answer arrives faster than realtime playback.

A note on identifying the board, because getting it wrong cost four flashes of
somebody else's hardware: resolve the port from the USB serial number every
time. `1C:DB:D4:7A:16:C8` is at location `0x01120000`, which macOS names
`/dev/cu.usbmodem11201` — and that mapping was confirmed by reading the MAC
back before writing anything.

The `iterate_kit` provisioning partition is **0x1000 bytes**, not the 0x10000
a first guess produces. An image built at the larger size would have been
written straight past the end of the partition.

## What this still cannot tell you

The analogue path — codec gain staging, amplifier settle, the acoustic path,
whether AEC converges in a room. The chip: PSRAM contention, DIRAM budgets,
real priority inversion, brownout under transmit current. The radio. And the
platform difference, which is the big one: a pointer bug that faults cleanly
on macOS corrupts a neighbouring buffer on the board.

A rig trusted past its reach is worse than one nobody trusts.
