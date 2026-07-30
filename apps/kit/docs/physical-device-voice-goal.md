# Iterate Kit physical-device voice goal

Status: active; direction recorded 2026-07-29, first M5StickS3 physical
control and Grok voice proofs passed 2026-07-30.

This is the goal document for the initial Iterate Kit devices. The first
implementation tranche remains StackChan plus M5StickS3, but the physical
program now explicitly includes all four boards attached to the shared hub:
M5StickS3, Waveshare ESP32-S3 touch screen, Home Assistant Voice Preview
Edition, and StackChan. It preserves the raw goal and decision transcript
because dictated wording can contain important intent that a normalized
specification would otherwise erase.

The transcript is authoritative when this document's summary over-interprets a
decision. Explicitly unresolved choices remain unresolved; implementation
details may be selected by the implementer with continual Fable review.

The two completed Fable realtime-audio reviews and the implementation decisions
drawn from them are tracked in
[`fable-audio-review-reconciliation-2026-07-30.md`](./fable-audio-review-reconciliation-2026-07-30.md).
That ledger is part of the acceptance evidence: findings are not considered
handled merely because they appeared in an agent transcript.

## Outcome

Build a library and a production-shaped proof, not two unrelated demos:

- `k.iterate.com` and a TypeScript CLI can flash and provision both devices
  through a shared headless flashing core.
- That same target/catalog/flash architecture then brings up the Waveshare
  touch device and Home Assistant Voice Preview Edition one by one, without
  forking a second provisioning system.
- StackChan and M5StickS3 firmware share the portable protocol, capability,
  configuration, resource-accounting, and event machinery while keeping
  device-specific hardware code behind small adapters.
- Each device mounts its own ordinary Cap'n Web RPC target at its configured
  `/kit/...` path.
- Cap'n Web control and PCM audio use two independent WebSockets.
- The PCM WebSocket reaches the current Grok realtime voice model through a
  userspace `worker.ts` proxy; the long-lived provider secret never reaches the
  device.
- Both targets work first against a local server exposed through
  `tunnels.iterate.com`, then against a real apps/os preview using a real project
  token, real project secret, and real project agent.
- Memory, binary size, CPU cost, queue bounds, audio latency, AEC quality, and
  long-session drift are measured acceptance properties rather than anecdotes.
- The completion direction is custom, recoverably flashable firmware on all
  four locally attached boards, each able to reach the same Grok speech-to-
  speech service through the Iterate userspace proxy and expose the
  device-appropriate capability surface.

## Settled decisions

### Provisioning and flashing

- Provisioning data is separate from the versioned firmware image.
- Build one reproducible firmware artifact per board/firmware version.
- Wi-Fi SSID, Wi-Fi password, project token, project identifier, and kit path
  live in a dedicated settings/configuration partition.
- The browser and CLI share a headless TypeScript implementation for artifact
  selection, flashing, configuration writing, and post-flash verification.
- Per-user browser-side firmware compilation is not part of this design.
- A project token is acceptable for the first proof. A future design must give
  each device its own independently revocable OAuth session and credentials.

### Capabilities and Cap'n Web

- Do not impose a synthetic nested capability tree on every device.
- A mounted device is an ordinary Cap'n Web RPC target and can expose the
  functions that make sense for that device.
- A device can describe the functions it provides, but the first version does
  not need a generated, universal hierarchy such as
  `display.renderImage()`/`camera.takePhoto()` solely for architectural purity.
- The C Cap'n Web implementation must be peer-symmetric. Above a very thin
  transport role, it must not care which side initiated the conversation.
- The same C capability target used for the outbound mothership connection is
  permanently exposed on the device's Wi-Fi/LAN endpoint for now. It is not
  gated on a USB connection or physical boot gesture. This can be disabled or
  secured more strictly later.
- Authentication still applies; "permanently exposed" means continuously
  reachable, not intentionally anonymous.
- The vendored/rendered C Cap'n Web code must retain a directly runnable
  compatibility suite. Real Cap'n Web tests should run against the C peer, with
  unsupported cases explicitly classified as known failures rather than
  silently omitted.
- Capabilities must be real enough to exercise promises, returned data,
  callbacks/subscriptions, and both initiator directions. Metrics subscriptions
  and photo transfer are important compatibility cases.

The intended project-facing shape is conceptually:

```ts
const stackchan = await itx.kit.get("/kit/stackchan");
await stackchan.renderOnScreen(urlOfPng);
await stackchan.moveServos(...);
```

That example does not mandate those exact method names or a nested schema.

### Device functions

StackChan must expose functions for:

- LED control;
- rendering an image on its display;
- taking a camera photo and returning it;
- servo control;
- starting and ending PCM audio;
- realtime metrics and diagnostics subscription through Cap'n Web.

M5StickS3 must expose only the small application surface needed for:

- rendering an image on its display;
- starting and ending PCM audio;
- realtime metrics and diagnostics subscription through Cap'n Web.

Metrics/diagnostics are infrastructure and therefore do not contradict the
Stick having only image and audio application functions.

The Stick is push-to-talk. Holding and releasing its physical button produce
the same bounded application events that can also be invoked remotely. This is
the basis for later stream cross-posting.

### Audio

- Use two WebSockets:
  1. an ordinary text Cap'n Web connection for RPC and non-PCM events;
  2. a custom binary PCM connection with no Cap'n Web framing.
- Fix protocol v1 to mono signed PCM16LE, 16 kHz, 20 ms frames: 320 samples or
  640 bytes per WebSocket message.
- Keep the device PCM connection independent from the upstream provider
  connection. The userspace proxy performs authentication, ephemeral-secret
  substitution, provider adaptation, and bounded resampling/rechunking where
  required.
- Provider JSON and other non-PCM events never enter the binary PCM lane. For
  the first proof, log the events that would later be posted to a stream.
- StackChan uses continuous raw-audio streaming, provider VAD, full-duplex
  playback, interruptions, and device-specific AEC.
- M5StickS3 uses half-duplex push-to-talk, no AEC, and no simultaneous
  microphone/speaker operation.
- Pressing PTT or otherwise interrupting playback immediately discards bounded
  queued playback. It must not wait for stale speech to drain and does not need
  to tear down the WebSockets.
- The newly released model's versioned identifier is
  `grok-voice-think-fast-2.0`. The first proof pins that identifier rather than
  relying on `grok-voice-latest`, whose rollout date/alias target may change.
- Current xAI Speech-to-Speech accepts raw PCM16LE WebSocket binary messages at
  16 kHz independently for input and output. Therefore protocol v1 needs no
  resampling or base64 conversion in the proxy: after session setup, device
  PCM frames can traverse the userspace proxy as binary bytes. Provider JSON
  lifecycle/transcription events remain on the non-PCM side path.
- M5StickS3 configures `turn_detection.type: null`, sends audio continuously
  for however long the button remains held, and sends
  `input_audio_buffer.commit` plus `response.create` on release. VAD devices
  configure `server_vad` and append/forward audio without a manual commit.
- Do not transplant the older StackChan buffering design blindly. It has
  exhibited increasing delay, large TLS writes, queued microphone audio,
  jagged playback, and memory pressure over time. Reuse useful DSP and
  device-specific work only after measuring its queueing and ownership model.
- Treat audio capture and playback as the firmware's highest-priority
  real-time work. Cap'n Web, metrics encoding, display updates, logging, and
  other capabilities must run as bounded background work and must never sit on
  the audio-critical execution path.
- A complete microphone frame must be offered to the PCM egress immediately;
  a complete server frame must be offered to the speaker immediately. Any
  deliberate prebuffer or batching is a named, configurable policy with a
  measured benefit, not an accidental queue.
- Timestamp and report residence and scheduling delay at every observable
  ownership boundary, including microphone capture completion, device socket
  send, proxy receive/provider send, device PCM receive, speaker submission,
  and the closest hardware-supported speaker-start or DMA boundary. Do not
  claim provider receipt or acoustic audibility when the available signal only
  proves a preceding boundary.
- Frame duration, DMA geometry, queue capacities, per-wake work budgets,
  startup-prebuffer policy, late/overflow drop policy, underrun recovery,
  interruption epochs, reset/reconnect thresholds, and clock-drift handling
  are explicit tuning knobs with defaults, bounds, and metrics.
- Nominal operation should have no avoidable queueing delay. Every queue tracks
  current depth, high water, residence time, late frames, drops, resets, and
  underflow/overflow classification. Overload recovers by an explicit bounded
  policy rather than accumulating latency.

### Photos and images

- Taking a photo is a first-class capability and is also a Cap'n Web
  compatibility test.
- A photo must not require one unbounded JSON/WebSocket allocation. Prefer a
  returned photo capability or another bounded chunked transfer with metadata.
- The pleasant application API should still allow an image URL, such as
  `renderOnScreen(urlOfPng)`.
- The exact ownership of fetching, validating, resizing, decoding, and
  device-native conversion was not stated clearly enough in the dictated answer
  to treat it as settled. Select it using measured RAM/CPU/binary-size evidence
  and Fable review. Do not add a general-purpose device image pipeline if
  bounded server-side preparation gives the same public behavior.

### Avatar and renderer model

PCM energy alone is insufficient. Define one clean renderer-input data
structure capable of representing:

- idle, listening, thinking, and speaking state;
- audio energy/envelope;
- viseme output from the existing StackChan viseme determination algorithm;
- output from the second candidate algorithm in the StackChan source;
- explicit future stage directions;
- timing/confidence data required to make transitions coherent.

Pluggable analysers produce this structure. Pluggable renderers consume it:
sprite renderers now, procedural renderers later, and non-screen renderers such
as the Home Assistant Voice Preview Edition light ring. The listening state
must be visibly immediate.

Inspect the current `iterate/stackchan` source for both candidate algorithms.
Do not copy its degrading audio queue behavior as part of adopting its visual
pipeline.

### Portability

- The current preferred boundary is an allocation-free portable C core for
  Cap'n Web, capability dispatch, bounded queues, PCM protocol state, metrics,
  and configuration.
- M5Unified/ESP-IDF hardware adapters may be C++ where that is the natural
  integration boundary.
- This boundary is delegated to implementation judgment and ongoing Fable
  review; it is not permission to preserve a poor local maximum.
- Research Home Assistant Voice Preview Edition and Waveshare ESP32-S3 AMOLED
  Touch source and hardware constraints before fixing abstractions that would
  prevent reuse.
- Any ESPHome device should ultimately share an ESPHome adapter even where less
  low-level firmware is shared with the two native ESP-IDF targets.

### Performance, memory, and endurance

The design goal is minimal RAM and as few CPU cycles as possible.

Every off-device and physical report must include, where available:

- firmware binary and partition size;
- static protocol/application working-set estimates;
- free and minimum-ever heap;
- internal RAM and PSRAM separately;
- task stack high-water marks;
- CPU cycles or normalized task utilization;
- PCM ingress/egress frames and bytes;
- queue current depth, high-water mark, capacity, drops, and backpressure;
- audio underruns/overruns;
- reconnect attempts, classified failures, and retry state;
- audio latency and latency drift;
- AEC measurements for StackChan.

All queues, retries, messages, image/photo transfers, and audio buffers are
bounded. Overload must have an explicit policy and metric. It must never turn
into accumulated latency.

Endurance gates are progressive and are run only after the other behavior is
working:

1. one minute;
2. two minutes;
3. progressively longer runs;
4. ten minutes as the initial completion gate.

Do not require a one-hour run for this first milestone. A later gate can grow
beyond ten minutes.

The nearby computer is the precision test controller. It should:

- inject deterministic far-end and near-end audio;
- capture speaker reference, raw microphone, and post-AEC microphone;
- timestamp frames and events;
- collect Cap'n Web callback/subscription metrics;
- calculate echo reduction, near-end damage, drop/underrun rate, queue
  occupancy, heap drift, CPU cost, and latency slope.

Device observability follows a core/outer-layer split:

- the realtime core produces only fixed-cost counters, snapshots, and bounded
  diagnostic records;
- live Cap'n Web callback/subscription export is the normal device-to-host
  diagnostics path and feeds host-side durable artifacts;
- optional microSD persistence is a separately selectable outer sink on
  targets that provide a card;
- do not add a custom firmware-side USB/JTAG diagnostics writer;
- a stalled or absent sink never blocks audio and never creates an unbounded
  device queue;
- every sink records explicit sequence gaps and drop/overflow counts;
- the nearby computer is the authoritative high-fidelity recorder during
  physical tests, while microSD is an optional resilience policy for devices
  that provide it.

The detailed follow-up and acceptance proof are recorded in
[`tasks/kit-bounded-device-diagnostics-capture.md`](../../../tasks/kit-bounded-device-diagnostics-capture.md).

Initial AEC targets remain useful starting hypotheses: approximately 10 dB
far-end echo reduction, less than 3 dB near-end speech damage during
double-talk, and successful interruption. The rig must report exact
measurements so thresholds can be corrected based on the real acoustic
hardware.

The two physical devices are adjacent and can hear one another. Power down,
mute, or acoustically isolate the inactive target during audio and AEC tests.

### Physical evidence: M5StickS3, 2026-07-30

The first target was resolved by stable USB serial
`70:04:1D:D5:45:88`, built with ESP-IDF 5.4.2, and flashed with the normal
esptool path. No firmware-side USB/JTAG diagnostics transport participated in
the proof.

- The device authenticated through a temporary `tunnels.iterate.com` server
  and mounted `itx.kit.m5sticks3`.
- `subscribeToMetrics` delivered the runtime evidence over Cap'n Web.
- Remote push-to-talk start and stop were accepted through the mounted
  capability.
- A held push-to-talk turn captured and sent 222 20 ms microphone frames to
  `grok-voice-think-fast-2.0`. There were no capture drops, send deferrals,
  reconnects, or uplink failures; the application queue high-water mark was
  one frame and maximum reported transport-accept age was 3 ms.
- Grok transcribed the physical microphone input, generated a spoken response,
  and the Stick accepted and completed all 27 response frames with no drops or
  playback failures. A separate direct-playback turn accepted and completed
  all 192 returned frames; its downlink queue high-water mark was six frames
  and speaker queue high-water mark was one.
- At idle, the callback reported approximately 8.44 MiB free heap, 77.8 KiB
  free internal heap, 8.38 MiB free PSRAM, and 4,136 bytes of main-task stack
  headroom. During the full voice proof the observed main-task stack headroom
  floor was 3,016 bytes.
- The linked application image is 1,146,784 bytes. ESP-IDF reports 199,295
  bytes of DIRAM used (58.31%) and 16,383 bytes of IRAM used. The latter leaves
  one byte in that linker region and therefore remains a concrete footprint
  issue to understand before calling memory work complete.

The harness used fresh local project credentials for this physical slice. It
does not satisfy the later preview/production-token acceptance step, and the
temporary tunnel intentionally disappears when the test exits.

The next acoustic tranche deliberately separated test-instrument failures from
device failures:

- FFmpeg's AVFoundation recorder shortened/corrupted captured time; SoX/raw
  CoreAudio recorded the same 997 Hz Stick output cleanly. Physical acceptance
  now requires a recorder loopback control plus sample-count-versus-wall-time
  integrity before interpreting waveform gaps.
- A genuine one-late-frame run at downlink frame 73 measured a 50,687 us
  EOF-to-refill interval, one underrun/flush, and one ESP-IDF finished-pointer
  queue overflow. The strict runner failed immediately.
- The portable playback policy now writes a bounded zero-silence descriptor,
  drops exactly one subsequently late stale frame using scalar debt, and
  resumes in the same I2S generation. Recovery submission, completion, and
  late discard are exported in playback metrics schema 2.
- The recovery policy adds no PCM queue and grows the host-layout playback
  object only from 280 to 296 bytes. Normal and ASan/UBSan native suites both
  pass 38/38; the Kit TypeScript suite passes 295 tests with one intentional
  skip; typecheck and the ESP-IDF post-link realtime audit pass.
- The current image is 1,154,954 bytes with 209,119 bytes DIRAM used and
  132,641 bytes free. Physical flashing and acoustic validation of this exact
  recovery build remain pending and must not be inferred from host tests.

The dedicated recovery proof may observe one explicitly injected, conserved
incident. The gapless endurance proof remains stricter: every recovery,
underrun, overflow, reset, freshness, and failure counter must remain zero.

### Proof ladder

1. Host tests prove the portable state machines, bounds, failure
   classifications, Cap'n Web compatibility, configuration image, and resource
   accounting.
2. An off-device simulator/harness reports compiled size proxies, process
   memory, CPU, queue behavior, and known Cap'n Web compatibility failures.
3. Each real device is flashed and exercised through a local authenticated
   server published with `tunnels.iterate.com`.
4. Progressive physical audio/AEC/endurance tests pass.
5. A real apps/os preview supplies:
   - a userspace `worker.ts` `/pcm` proxy;
   - a Grok API key stored as a project secret;
   - a real provisioned project token and kit path.
6. Both freshly flashed devices mount into that preview.
7. A normal AI agent in the project invokes observable device behavior, for
   example moving StackChan's servos through
   `itx.kit.get("/kit/stackchan")`.
8. The proof includes deterministic RPC assertions and a live spoken Grok
   smoke test. Model wording is not itself a deterministic assertion.

## Review discipline

At least one Claude Fable max-effort background agent should be reviewing an
active architecture, performance, compatibility, or implementation question
throughout the work.

Reviews must aggressively look for:

- a substantially simpler architecture rather than local cleanup;
- unbounded memory, hidden copies, and allocator churn;
- code-size and internal-RAM regressions;
- blocking work in capture, playback, WebSocket, or callback paths;
- queue designs that accumulate delay;
- asymmetric or duplicated Cap'n Web peer logic;
- abstractions that prevent ESPHome, Home Assistant Voice Preview Edition, or
  Waveshare reuse;
- tests that pass only because the difficult real behavior is absent.

Every concrete Fable defect must gain a failing regression test before its fix
where the behavior is host-testable. Review findings and their disposition
should remain visible in the goal evidence.

## Explicitly open implementation choices

These are not blockers to starting:

- exact direct function names and arguments on each device target;
- whether capability description is hand-written or generated in v1;
- image fetching/conversion ownership;
- the bounded photo-chunk representation that best matches Cap'n Web;
- initial AEC numeric thresholds after the precision rig produces baseline
  measurements;
- exact adapters required for the researched future hardware;
- exact initial function surfaces for the newly added Waveshare and Home
  Assistant Voice Preview Edition targets.

## Verbatim source goal

> your goal just got a whole lot more ambitious . you can structure the work however you want, but by the end of the night you need to make it
> so
>
> - the CLI script and k.iterate.com website can deploy firmware to BOTH the stackchan and s3 stick
> - the firmwares should share as much code as possible with each other
> - stackchan should provide functionality to control the LEDs, show image on screen, capture webcame image and control servos, and start/end pcm audio
>   stream. audio stream should use grok model in VAD and just stream raw audio. AEC MUST provably work
> - for the stick s3, the only provided capability should be to show an image and start/end pcm stream. use push-to-talk and not VAD. no AEC / duplex.
> - for both devices, longer sessions should continue to work and not accumulate delays or whatever
> - use rendered sprites like in the ~/src/github.com/iterate/stackchan experiments - we want to have pluggable algorithsm that turn the pcm stream into
> - both devices should have a capability to stream metrics and diagnostics etc through capnweb
> - IMPORTANT: for debugging in situations where the device can't reach our mothership, it'd be good to expose the SAME capability capnweb rpc target
>   (but the C version) at some internal API endpoint, where we run a lil webserver. the reason i mention this is because it affects how the capnweb c
>   client is written. just like the original capnweb, it should beyond a very thin top layer of the implementation not care which side "initiated" the
>   conversation
> - the animated avatars should show clearly when they are "listening"
> - research how home assistant voice preview edition and waveshare esp32 s3 amoled touch work so we can make sure that most of the code we work can be
>   used there
> - grok model to always use the today-released voice 2.0 thinking fast or whatever it's called
>   THEN
> - both devices with the firmware must be able to connect to a real apps/os preview deployment with
>   - a userspace worker.ts that has the /pcm endpoint that proxies through to grok
>   - a grok api key loaded as secret into the project
>     we should then be able to prove that we can e.g. ask a normal ai agent on that project in the preview deployment to e.g. control the servos of
>     itx.kit.get("/kit/stackchan") or something. oh and when flashing the firmware, one input should be the "kit path" obvs
>     frequently use claude fable xhigh cli to double check your work and ensure you're not in a local maximum trap.

## Verbatim decision transcript

### Provisioning

Question:

> First decision: should provisioning data be separate from the firmware image?
>
> My recommendation: **yes**. Build one versioned firmware artifact per board, then have a shared TypeScript flasher library write Wi‑Fi credentials, project token, project ID, and kit path into a dedicated encrypted settings/NVS partition. Both `k.iterate.com` and the CLI call that same library.
>
> That avoids compiling custom firmware per user, makes updates reproducible, and lets us test flashing without exposing a build toolchain in the browser.
>
> Are you happy to lock that in?

Answer:

> ok

### AEC and question format

Question:

> Next: what counts as “AEC provably works” on Stackchan?
>
> My recommendation: device-side AEC receives the exact speaker-reference samples and live microphone samples, with a reproducible physical test that:
>
> - plays known speech through the speaker while recording,
> - measures meaningful echo reduction before/after AEC,
> - still detects nearby human speech and permits interruption,
> - runs continuously for at least 30 minutes with bounded queues and no increasing latency.
>
> The StickS3 remains strictly half-duplex push-to-talk with no AEC.
>
> Is that the acceptance criterion you want?

Answer:

> ask me all questions at once to avoid going super deep on some random thing that doesn't matter - i want the most important questions
>
> A/C probably works. You need to build yourself a rig that can measure things very precisely. Bear in mind that both the stick and the stack chan are right next to a computer you are on

### Consolidated architecture questions

Questions:

> Got it. I’ll use the nearby computer as the precision test controller: deterministic audio injection, USB diagnostics, pre/post-AEC capture, timing, heap, CPU, queue depth, and long-run drift.
>
> These are the important unresolved decisions; everything else can be discovered or implemented without bothering you.
>
> 1. **Canonical capability API**
>
>    Recommendation: `itx.kit.get("/kit/stackchan")` returns a versioned capability tree with `describe()`, `display.renderImage()`, `camera.takePhoto()`, `servos.move()`, `leds.set()`, `audio.start()/stop()`, and `metrics.subscribe(cb)`. Generate both TypeScript types and C declarations from one schema.
>
> 2. **Shared firmware boundary**
>
>    Recommendation: an allocation-free portable C core owns Cap’n Web, capability dispatch, bounded queues, metrics, and PCM protocol state. Thin C++ adapters own M5Unified hardware. ESPHome gets a separate adapter around the same C core.
>
> 3. **Audio v1 wire format**
>
>    Recommendation: fix v1 at mono PCM16LE, 16 kHz, 20 ms/640-byte frames. Keep Cap’n Web and PCM on separate persistent WebSockets. StackChan is full-duplex with server VAD and device AEC; StickS3 is half-duplex PTT. Interruptions immediately discard queued playback without closing either socket. Negotiate other formats only in a later protocol version.
>
> 4. **Photos and other large results**
>
>    Recommendation: don’t return an entire JPEG inside one Cap’n Web message. `takePhoto()` returns a `Photo` capability with metadata and bounded chunk reads. This prevents base64 copies and large transient RAM use. Is that API acceptable?
>
> 5. **Rendering images**
>
>    Recommendation: keep the pleasant `renderImage({url})` API, but let the userspace worker fetch, validate, resize, and convert the image to the device’s native dimensions/format before transferring it in bounded chunks. The device should not carry a general-purpose image-download pipeline merely to satisfy the URL-shaped API. For direct local debugging, also accept already-prepared bytes.
>
> 6. **Local Cap’n Web server**
>
>    Recommendation: the C peer engine is genuinely symmetric; initiator versus acceptor is only a thin transport adapter. The device’s LAN endpoint is disabled normally and enabled by USB or a physical boot gesture, authenticated with its provisioned token. I would not permanently expose it on Wi‑Fi.
>
> 7. **Avatar architecture**
>
>    Recommendation: a shared, pluggable firmware-side state engine converts PCM energy plus explicit listening/thinking/speaking events into a tiny normalized avatar state. Each board has its own sprite renderer. “Listening” must follow the local microphone/PTT state immediately, not wait for a server round trip.
>
> 8. **Physical quality gates**
>
>    Recommendation: require a one-hour run on each device with bounded queue depth, no monotonic latency growth, no post-warmup heap loss, no unexplained reconnects, and zero nominal-load PCM drops. For StackChan AEC, capture speaker reference, raw mic, and cleaned mic; initially gate on at least 10 dB far-end echo reduction, less than 3 dB near-end speech damage during double-talk, and successful spoken interruption. The laptop can inject the independent near-end test signal.
>
> 9. **Flasher scope**
>
>    Recommendation: `k.iterate.com` initially supports Chromium/Web Serial. A shared headless TypeScript package handles artifact selection, flashing, configuration-partition writing, verification, and diagnostics; both the site and Node CLI call it. No per-user firmware compilation.
>
> 10. **Final preview proof**
>
>     Recommendation: the hard acceptance test is a real apps/os preview with a real project secret and `worker.ts` Grok proxy. Both freshly flashed devices connect to their configured kit paths, survive the endurance run, and a normal project agent successfully invokes observable hardware capabilities. Use deterministic RPC tests for assertions plus one live spoken Grok smoke test rather than making model wording part of every automated run.
>
> Reply with “all recommendations” or just list the numbers you want changed.

Answer:

> We don't need on the first question this like fake tree that each device can just expose a bunch of functions for now we don't need this like Agree on number two but it's totally up to you and fable number three definitely fix Yeah Agree No, I think the Yes, okay Ah yeah i think it's fine to take photos a good idea but yeah you should you should make sure your captain web tests are runnable now that you've rendered the code and um you might need to have had some capabilities there we do want to permanently expose the um capability tree on wi-fi for now we can turn that off later for security reasons I think um it's not just pcm energy if you leave on the seventh question if you read the stack chance source code there's like a vsem i don't know how to say that v-i-s-e-m-e determination algorithm or something and then there's another second one that might be interesting and then there's also potentially in the future like stage uh um stage directions and and like all of this yeah like she just needs a clean interface um to the to the sprite renderer or in the future we might also have procedural ones or something or maybe on the home assistant voice preview edition we actually try to sort of render it on the light ring so that all needs to draw from the same data structure.
>
> Yeah I wouldn't say one hour. I would say maybe 10 minutes for now, or start with one minute when one minute is good, do two minutes, and so on, but only when everything else is really done. Flash or scope, yeah, like there should be some shared core that a CLI and k.itray.com both kind of share. The final preview proof sounds good to me, but until you get there, you can use a tunnel running locally. The preview proof should also use a real project token and so on, like really be like the full, full, full proof. What else did I want to say? Yeah, just be mindful of. Obviously, the devices are both next to each other and can hear each other, so you might need to turn one off when you're experimenting with the other, and so on.
>
> Also, I would like you to write all of this in a file and give me that we just agreed, and give me a file name for it that I'll put in the goal. You need, especially verbatim, things that I said, and questions and answers need to be in there.
>
> What else before I go? Bum-bum-bum. Oh yeah, memory and performance characteristics are incredibly important, and Fable is really good at that, so make sure at any point in time there's at least one Fable running in the background, double-checking or triple-checking one thing or the other that you've come up with.

### Realtime-audio continuation

> yeah we need to somehow make sure the audio work is kept "realtime" while doing other stuff in background when possible. send a fable subagent to read all esp32 docs around this for patterns and read on the internet what others do etc and come up with some ideas
>
> we must process audio with top priority

> in general there must be no delays of audio in or out or whatever because of queuing, buffering, etc. we need a simple, rock solid design. when an output PCM frame comes from the socket, we need to be in a position to play it ASAP
>
> when an input microphone frame comes in, we need to send it ASAP
>
> the system needs to rigorously track and emit delay metrics such as
>
> - time from receiving pcm frame from server to it being audibly played on speaker
> - depth of certain buffers
> - time between when mic frame was recorded and grok receives it
>
> i assume there would be well defined tuning knobs like
>
> - policies for when to drop / reset buffers
> - size of mic chunks to send as frames
> - probably more others
>
> send a fable subagent to explore this rich design space with use of esp32 and c audio processing best practices and come up with multiple different possible designs to help you refactor and clean up

### Direct-playback and long-hold continuation

> ghggnot working - maybe start by trying to play something straight from grok on the device lol
> also be a bit more generous on the memory if the s3 stick can afford it - i worry you are constraining yourself too much with a four frame ring etc

> also we need to send push to talk frames while the button is down as it may be a long time

### Backlog and recovery continuation

> see if you can satisfy yourself that under all conditions of network / reconnects / lag / packet loss / whatever do we build up an unacceptable badklog or buffer. soon as network improves, we should be able to hold a realtime convo again . we should be able to express this as tests

> we also need to i think just clear the mic buffer waiting to be sent to the websocket if we haven't been able to send prior stuff
>
> should then result in some error being logged in a visible place and accessible via diagnostics etc
>
> in addition to network issues, memory pressure and buffers filling up etc must also be handled well and elegantly / simply / following best practice of c audio processing in such systems

### Physical diagnostics continuation

> and you need to have some system to generate and pull logs of metrics and log lines / diagnostics from the device - and possibly even write them to microsd card if there is one - but that should be decided on the "outer layer" - but once you get to device testing, it's just super important that you can do tests with very high fidelity logs and metrics streams without blowing out each device's memory
>
> if you can't get to this right now, you should put this in a task markdown file

### Four-device continuation

> I mean you just need to, like I said before, the devices we have connected are four on that USB hub:
>
> - the S3 Stick
> - the S3 Waveshare device, which has a touch screen
> - the Home Assistant Voice Preview Edition
> - the Stack Chan with the servos and whatnot
>
> You should basically discover all these and take yourself some notes on how to discover them. Also if I ever re-plug the USB hub, how to re-find them, what their MAC addresses are, or whatever, like all that stuff.

> And then we should really push towards a point where you ought to be able to actually flash custom firmware on all of these devices and continue pursuing your goal one by one. You actually want them to be able to speak to the GROK Voice API, the new version that launched yesterday or today, the Voice 2.0 Real Thinking Fast, whatever.
