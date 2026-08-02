# M5StickS3 vertical-slice landing contract

Status: **deployed-userspace Stick vertical slice achieved** 2026-07-31. The
same shared `/pcm` and Cap'n Web implementation now works through an installed
production userspace worker, mounts the device capability, streams diagnostics,
invokes `changeColour("green")` from Grok through `env.ITX`, posts every raw
non-PCM provider event to an Iterate stream, and returns audible speech to the
physical M5StickS3. The earlier local-tunnel deterministic, eight-turn, and
interruption runs remain the stronger endurance evidence. Physical-button
provenance and the deferred deployed-worker kill/remount lifecycle are not
silently relabelled as complete.

## Warm-session subscription and eight-turn closure (2026-08-02)

The remaining “works for several turns, then dies” Stick defect was not an
audio queue or Grok failure. A deployed `/pcm` Durable Object generation is
disposable, but the device's Cap'n Web session intentionally remains alive.
Every replacement generation installed fresh event and metrics callbacks on
that same firmware session without releasing the previous generation's
imports. The finite callback table therefore accumulated stale owners until
the device returned `device event subscription limit reached`; from that point
PTT no longer reached userspace even though Wi-Fi and the PCM socket could
still look healthy.

Subscriptions now accept an optional stable logical-owner key. The production
voice worker uses `iterate-kit-voice-pcm-v1` for both its event and metrics
callbacks, so a replacement generation atomically supersedes only the stale
callback belonging to that bridge. Unkeyed diagnostic subscribers remain
independent. An owner collision while a callback or release is in flight is
rejected instead of aliasing generations. Malformed keys release their already
imported Cap'n Web capability before returning an RPC error. Red-first native
tests cover replacement, preservation of unrelated unkeyed observers,
in-flight rejection, and callback-budget recovery. Two deliberately forced
Durable Object replacements then each mounted event and metrics subscriptions
in exactly one attempt with zero failures and both readiness flags true.

The firmware containing this change was freshly built and flashed to fixed MAC
`70:04:1D:D5:45:88` on the same production project and worker configuration
commit `cc1d44cd9a71648b2cae0f2a8405281ce4fbe77e`. Its application image is
1,162,176 bytes, leaving 934,976 bytes in the 2 MiB application partition. The
native firmware suite passed all 52 tests; the Kit TypeScript suite passed 570
tests with one explicit skip, and the Kit typecheck passed.

The retained acceptance run is an unattended **eight-turn** conversation
through production OS, the installed userspace worker, real
`grok-voice-think-fast-2.0`, and one unchanged physical Stick PCM session. It
started silently, reached provider readiness in 655 ms, and completed eight
remote PTT turns. Turn one made Grok invoke
`changeColour({colour: "green"})` through `env.ITX` and retained the successful
device result `{colour: "green", ok: true}`. The remaining turns returned the
requested exact sentences. This run proves remote event authority; it does not
replace the earlier physical-button provenance boundary.

Digital conservation was exact: 4,046 microphone capture, device uplink, and
worker uplink frames; 1,188 worker downlink, device acceptance, DMA submission,
and DMA completion frames; eight completed provider responses; and one
successful tool call. Every audio/socket drop, failure, flush, underrun,
restart, protocol error, WebSocket error, and Wi-Fi disconnect delta was zero,
and every queue drained. Uplink application high water was 1,280 of 20,480
bytes, WebSocket transmitter high water 648 of 910 bytes, downlink high water
five frames, playback high water sixteen frames, and maximum observed
microphone transport-accept age 37 ms. Free heap changed by only 20 bytes
(8,355,096 to 8,355,076); minimum heap stayed 8,333,652 bytes, minimum
internal/DMA heap stayed 51,055 bytes, PSRAM stayed 8,305,500 bytes, and main
stack headroom moved from 2,112 to 2,064 bytes. The point-in-time CPU sample
moved from 166 to 183 permille; it is not represented as an interval average.

The automatic network verdict is `valid` over the 120.89-second audio
interval. All 121 scheduled probes to each of the device, router, and
production worker replied. Maximum RTTs were 87.516, 13.672, and 23.305 ms
respectively; worker average RTT was 14.649 ms. All 122 link samples remained
up at -50 through -47 dBm. DNS took 2.112 ms, HTTPS connection setup 42.002 ms,
and the PCM socket ended open with zero interval disconnects, reconnects,
lower-transport failures, or transport errors. Device-observed PCM totals were
2,589,440 bytes uplink and 760,320 bytes downlink.

The nearby Mac independently transcribed the physical first response exactly
as `I'll use the tool to change the color to green.` The response-to-ambient
peak ratio was 5.797 with no clipping or active-window deficit, so the existing
explicit `independent-stt-provisional` acoustic policy passed. An immediately
preceding otherwise exact three-turn run remains honestly rejected: macOS input
gain was only 27%, producing a 2.314 ratio against the 2.5 bound. Raising input
gain to 75% made the physical signal measurable; future harness evidence should
record that host gain automatically rather than relying on this run note.

Evidence lives under
`apps/kit/evidence/m5sticks3-subscription-owner-fix-eight-turn-network-valid/2026-08-02T11-11-12-603Z/`.
The manifest, network report, raw provider JSONL, and Mac PCM SHA-256 hashes are
respectively
`b3da3dba1d983c5476ae989fa732997e24663cf57c5d61f394362d4cf9204323`,
`10a1e8dba96c93ab86a4b81e62f5cdcd23eac7cdb2a04c688d4a567f5da5c246`,
`46968a65adf4d67b2b1abbb3325a93119209674a5dc6dc533503be18c2d4ca6b`,
and `4714b10d537d32fb8bfa709da8ce71b18ef1ad950a7a8ef5e60441b0d2819d3c`.
The raw journal contains exactly 260 contiguous events, sequences 148 through 407. The acceptance parser correctly used the quiescent warm-session baseline,
but the artifact descriptor still applied its historical “must start at one”
default and labelled that suffix discontinuous. That metadata defect was found
while landing the run, reproduced with a red test, and fixed by passing the
same explicit expected sequence into the artifact writer. The original
evidence was not rewritten; its exact correction is retained alongside it in
`provider-events-continuity-correction.json`.

## Manual-PTT silent-start hardening (2026-08-02)

This section supersedes every historical statement below that treats an
opening Grok greeting as required. The current product contract is strict:
top Button B opens or closes call infrastructure, front Button A owns a manual
push-to-talk turn, and Grok must not speak until a non-empty microphone turn has
ended and userspace has deliberately sent `response.create`. There is no AEC
and no server-side VAD on the Stick.

The person beside the physical device reported both unreliable later turns and
that call start still said `How can I help you?`. Source metrics from an earlier
automated run said `initialGreetingRequests=0`, which ruled out only our old
explicit greeting hook; it did not prevent a provider-initiated response. The
userspace bridge now makes response authorization an actual manual-mode
protocol invariant. An explicit `response.create` authorizes exactly one
provider response. Unauthorized `response.created`, function calls, binary
PCM, and terminal response events are cancelled, retained in the raw provider
journal, excluded from device egress, and counted as
`providerUnsolicitedResponses` / `providerUnsolicitedPcmBytes`. Manual mode also
rejects an `initialGreeting` option at construction. Tests reproduce the
unwanted provider generation and require zero device frames; an explicitly
committed PTT turn remains playable. The current production userspace object is
`e49ad95bdb18550b98a6081b972e784557665c62`.

The same correction exposed an obsolete harness assumption: it judged call
startup by requiring first device PCM within 2.5 seconds, rewarding the exact
unsolicited greeting now forbidden. The call-start gate instead measures
conversation start to `session.updated` readiness; answer latency belongs to
each later PTT release. In the first two fresh physical runs, provider readiness
was 672 ms and 621 ms while both provider/device first-PCM fields correctly
remained null until turn one.

The physical image was freshly rebuilt and flashed to fixed MAC
`70:04:1D:D5:45:88` on the production project
`prj_bd8785e119fe4f1d8631bb95e1dea748`. It is 1,161,344 bytes in a 2,097,152-byte
application partition. Sixteen 20 ms I2S DMA descriptors now provide a bounded
320 ms physical ownership cycle, raised from eight after an exact 250 ms
provider-to-device interarrival incident. This costs 10,240 extra bytes of
internal DMA-capable RAM without introducing a software history queue; the
independent 400 ms freshness fence still destroys stale speech.

The three-turn production run at
`apps/kit/evidence/m5sticks3-silent-start-strict-auth-16dma-valid/2026-08-02T07-32-13-697Z/iterate-kit-acoustic-qcPu4u/`
passed its startup, acoustic, and exact digital gates. It sent 1,518 microphone
frames and completed three real Grok responses. Worker egress, device
acceptance, DMA submission, and DMA completion were all exactly 436 frames;
every flush, underrun, late drop, DMA deadline miss, reset, protocol failure,
WebSocket failure, and Wi-Fi disconnect was zero. Grok invoked
`changeColour({colour: "green"})` through `env.ITX`; the raw stream retained 106
provider events including all three input transcriptions and output lifecycle
sequences. `initialGreetingRequests`, unsolicited responses, and unsolicited
PCM bytes were all zero, while response-create and completed-response counts
were exactly three. Minimum internal/DMA heap was 56,091 bytes, the smallest
main-stack headroom was 2,112 bytes, audio-owner headroom was 6,652 bytes, and
terminal sampled CPU was 278 permille.

That artifact is deliberately still labelled `network-invalid`: one worker
ICMP sample reached 249.544 ms against the 100 ms remote-worker limit. Device
and router maxima were 40.519 ms and 8.89 ms, RSSI stayed above -72 dBm, and
the PCM socket did not disconnect, so the exact audio result is retained but is
not promoted to the separate clean-network acceptance proof. A later attempted
run is retained at
`apps/kit/evidence/m5sticks3-silent-start-strict-auth-16dma-valid/2026-08-02T07-34-51-647Z/`.
During turn three the worker route suffered repeated 147-404 ms probes and
timeouts; the PCM socket disconnected and the deployed generation was
replaced. The harness stopped immediately and classified the interval
`network-invalid` rather than blaming the audio engine or claiming the two
completed turns as a pass. That rejected interval remains useful fault
evidence; the final clean-network gate is closed by the later run below.

### Network-valid silent-start acceptance closure (2026-08-02 08:13 UTC)

After the upstream route recovered, a freshly reset physical Stick completed a
new unattended three-turn run through the same installed production userspace
object and one `/pcm` generation. Call-open produced no provider or device PCM.
Provider session readiness arrived 739 ms after the remote conversation-start
event; all three later answers followed explicit non-empty remote PTT releases.
The terminal worker ledger contains exactly three `response.create` messages,
three completed responses, zero initial-greeting requests, zero unsolicited
responses, and zero unsolicited PCM bytes.

The physical transport ledger is exact. The Stick captured and userspace
accepted 1,489 microphone frames. Userspace emitted 420 response frames and the
device accepted, submitted to I2S DMA, and completed all 420. Each individual
turn also conserved frames (495/128, 480/144, and 514/148 uplink/downlink).
There were no audio drops, socket drops, playback flushes, underruns, freshness
drops, DMA deadline misses, queue overflows, resets, protocol failures, or
restart incidents. Forty-five live metric callbacks arrived during the run;
both Cap'n Web event and metric subscriptions remained ready with one attempt
and zero failures. The terminal minimum internal/DMA heap was 54,571 bytes,
main-task headroom was 2,272 bytes, audio-owner headroom was 6,652 bytes, and
sampled CPU was 214 permille. All live queues drained to zero.

This artifact is automatically `valid`, not merely a digitally clean result
during an unknown network interval. All 46 device, router, and production
worker probes replied. Their maximum RTTs were respectively 68.145 ms,
14.503 ms, and 26.655 ms; the worker average was 14.655 ms. All 47 device link
samples stayed associated at -50 through -48 dBm. DNS took 1.095 ms, the
measured HTTPS connection took 132.385 ms, and the PCM socket remained open
with zero disconnects, reconnects, lower-transport failures, or transport
errors throughout the 45.369-second evidence interval.

Grok invoked `changeColour({colour: "green"})` through `env.ITX` and the result
was `{colour: "green", ok: true}`. The worker durably appended all 108 observed
non-PCM provider events with zero pending, dropped, or failed appends. The
nearby Mac independently transcribed the first physical reply exactly as
`I'll use the tool to change the color to green.`, matching the provider
transcript. The unchanged fixed 120-RMS acoustic threshold still recorded zero
active windows; under the explicitly approved landing rule this is retained as
an `independent-stt-provisional` acoustic pass, not hidden or used to relax any
transport, frame, reset, brownout, or network criterion. The stricter acoustic
amplitude gate remains follow-up work.

The immutable evidence is under
`apps/kit/evidence/m5sticks3-silent-start-strict-auth-16dma-valid/2026-08-02T08-13-42-361Z/iterate-kit-acoustic-QuSRLw/`.
Its manifest, network report, raw provider journal, and Mac PCM capture hashes
are respectively
`0c3ee652313fb2d62f961301181526b94287e9837e9f9274d61afdae6523d9ca`,
`7f53d609eed89778905512867800b9b5af8bae33b5dedca5f3ae7c84cb59fa0e`,
`eef9bfb89b4163ebb7ba55a670a5c68a072dc6f76937677ebdc8cf6f27d1561a`,
and `1e85d6ddbdfb5158693221fa501d00afe8614a5918e965fc13ad00275433a5ab`.

The exact hashes for the stronger three-turn application artifact are:
manifest `6845bf3f488dae8d3895a2c60fc304fd9e5c35ab115f72c291693d2a01f65260`,
network report `c7394eb9628488fc78c042705d5d1b9e0d3b05b75c39f0f834c4acc4d667932c`,
raw provider journal
`5dec22078335b809fc0ee8b700baac2e3506e783dc9bb4a01fdc316b68a3ee94`,
and flashed firmware
`860a21946706b8f9599d31fc298c3cee77828a875ee8a5c42f80f6220e7527cd`.
The next attempted acceptance interval was rejected before another audio run:
the Stick and router remained local-network healthy (20/20 replies, respective
maximum RTTs 20.437 ms and 6.490 ms), while the production edge measured
547.524-784.199 ms and HTTPS response starts took 2.396-3.507 seconds. An
independent macOS `networkQuality` run at 08:47 UTC measured 1,123.330 ms base
RTT despite 42.1 Mbps down and 17.7 Mbps up. This is the intended use of the
preflight gate: do not manufacture another nominal audio result while the WAN
cannot provide a valid real-time interval.

Production observability independently corroborates the failed third-turn
boundary. OS trace `9b1e77673af0fb8a82a4c424999f7c54` (service `os-prd`,
script version `7e2eca90-858d-4145-9e12-f230643b43d0`) records the outer
`ItxEntrypoint` GET ending `responseStreamDisconnected` after 72 ms and the
stateful `/pcm` generation ending `canceled` after 61,061 ms. Its replacement
attempt is trace `05576c6bca91aa3664cc4e27579699e4`; that outer GET also ended
`responseStreamDisconnected`. Both are untruncated. A separate query from the
fresh deployment at 07:26 UTC onward found zero error-level events for this
project and zero `unsolicited-provider-response` diagnostics, so there is no
evidence of a second userspace exception or a suppressed opening greeting.

The later read-only live snapshot explains why calls attempted during the bad
WAN interval could not work reliably even though the bridge recovered. The
32-slot microphone queue reached 31, recorded seven bounded freshness recovery
incidents, and discarded stale capture instead of retaining conversational
history. At inspection time every queue depth and WebSocket buffered amount
was back at zero, the call was inactive, Wi-Fi remained associated at -54 dBm,
and manual-mode greeting/unsolicited counters were still zero. These are
correct bounded-recovery semantics, but the dropped frames make that physical
interval a failed conversation rather than a successful degraded one.

## Call-start latency diagnosis and fixes (through 2026-08-01 10:14 UTC)

The reported five-to-eight-second `Call connecting` interval was real, but it
was not one indivisible Grok delay. Two independent lifecycle mistakes were
stacked together:

1. Button B used to dispose the physical device's `/pcm` WebSocket along with
   the Grok conversation. The next call therefore paid ESP DNS, TLS, WebSocket,
   userspace routing, and provider setup serially. A physical trace measured
   5.520 seconds before first downlink PCM, including roughly 2.55 seconds in
   the device's new TLS connection. The device lane is now boot-warm and
   survives call hang-up; Button B creates and retires only the provider socket.
2. Hang-up correctly flushed old speech by suspending the Stick's half-duplex
   speaker, but conversation start did not reacquire it. Grok's opening greeting
   reached the device and was then discarded until the first PTT release happened
   to resume output. The diagnostic run retained at
   `apps/kit/evidence/m5sticks3-call-startup-warm-socket-fixed3/2026-08-01T09-10-31-942Z/`
   accepted all 56 greeting frames while submitting and completing zero and
   explicitly flushing all 56. This made a correctly connected call sound dead.

The portable audio contract now has an explicit `prepare_playback` lifecycle
operation. The M5StickS3 conversation-start event does not become active until
the platform audio owner has reacquired speaker hardware. This is deliberately
not hidden in the first PCM frame, a sleep, or `flush_playback`: start failure is
causal and observable, and a PTT interruption does not briefly resume the
speaker just before claiming the shared I2S hardware for the microphone. Native
tests first reproduced the missing operation and now pin the hang-up → prepare
ordering and the physical/remote conversation event path.

After rebuilding and freshly flashing the 1,155,952-byte image (SHA-256
`646e3e396f97f0318e33d8ef205263d7bb2f4aa3b14ad32dd2bb01b70cca32f3`),
the network-valid production run at
`apps/kit/evidence/m5sticks3-call-startup-speaker-ready-valid/2026-08-01T09-21-34-825Z/`
kept the same `/pcm` session before start and after hang-up. Its measured
conversation-start-to-first-device-PCM latency was **1,603 ms**, decomposed as:

- short-lived xAI credential mint: 264 ms;
- xAI WebSocket open: 433 ms;
- session-update acknowledgement: 210 ms;
- Grok generation to its first PCM: 564 ms;
- userspace source-readiness/admission to first device send: 132 ms.

That is the remaining provider-shaped path, not the old device reconnection
path. The greeting contributed 60 accepted, submitted, and completed frames
before PTT, with zero flush, underrun, drop, reset, or playback failure. The
complete run ended at 176 accepted/submitted/completed downlink frames and 495
uplink frames, with all queues drained. Its maximum observed device
receive-to-DMA-start delay was 168 ms; because server and ESP clocks are not
synchronized, this is retained separately rather than presented as a fabricated
sample-exact acoustic-start timestamp.

The evidence classification is `valid`: 16/16 Stick, router, and worker probes
replied; maximum RTTs were 17.527, 6.156, and 34.5 ms; all 17 device samples
remained linked at -65 through -63 dBm; DNS took 1.044 ms and TLS connect took
40.286 ms. The manifest and network SHA-256 values are respectively
`66918659f6b9ca4d52c7ec345edb8d3fc02b021daefad0068d05fe0d23983b22`
and `f767110daf0d9b4dbd39b647914b921860c727ec692cb60c3630ed3a89de3139`.
An immediately preceding digitally clean run remains classified
`network-invalid` because one worker probe reached 158.994 ms; it was not used
as the clean acceptance run.

### Variable credential latency and the final call-edge fix

A fresh production reproduction showed why the earlier 264 ms credential
sample could not be treated as a bound. With the physical `/pcm` lane still
warm and unchanged, the run retained under
`apps/kit/evidence/m5sticks3-call-startup-current/2026-08-01T09-49-38-290Z/`
took **4,006 ms** from conversation start to first device PCM. Of that interval,
the per-call short-lived xAI credential request alone took **2,670 ms**. The
remaining measured phases were 435 ms to open xAI's WebSocket, 209 ms to make
the provider session ready, 560 ms for Grok to produce its first PCM, and
132 ms to deliver that PCM to the Stick. The run otherwise passed its physical
speech, exact digital, and network gates; this made the synchronous credential
request the causal user-visible regression rather than a Wi-Fi or audio guess.
Its manifest SHA-256 is
`3ad83b0bfc3768035b2b226999e53a9c24f1111ec62e320a5bdabf0a40c7c9da`.

Two bounded probes ruled out tempting but incorrect shortcuts. A direct xAI
API-key WebSocket opened from the Mac in 454 ms, but a production userspace
attempt to return the upgrade through `project.egress.fetch()` never obtained
a provider socket. That call is a serialized Cap'n Web capability method; it
does not preserve the native 101/WebSocket semantics available on Iterate's
platform-owned fetch lane. The retained failure is at
`apps/kit/evidence/m5sticks3-call-startup-direct-egress/2026-08-01T09-59-56-273Z/`
(failure SHA-256
`f3407627a64914cf72460deff9efaebd7a0b770826a6682e5fe9c34fdcb78bc4`).
Separately, reusing one xAI ephemeral credential opened the first socket in
448 ms and returned HTTP 401 for the second, proving that it is single-use and
must not be modelled as a conventional reusable TTL cache.

The deployed userspace worker source object
`e978728ae228b46265e34aedb79431490bdefa42` now mints exactly one unused
credential as soon as an authenticated idle device `/pcm` lane registers.
Button B atomically consumes that credential, opens the provider socket, and
starts minting the successor in parallel with the current call. An unused
credential is refreshed before expiry. The long-lived API key remains confined
to the existing Iterate egress secret substitution, the short-lived value never
leaves the Durable Object, and no billable provider WebSocket is held open while
the device is idle. Prewarm attempt/failure/state/expiry metrics and the last
provider-connect error are exposed in `pcmMetrics()`; failure is observable and
a later call retries rather than inheriting a poisoned cache entry.

The first production physical run of that design is retained under
`apps/kit/evidence/m5sticks3-call-startup-prewarmed/2026-08-01T10-13-45-704Z/`.
Credential preparation took 553 ms but finished **825 ms before** conversation
start. From Button B, xAI WebSocket open took 430 ms, provider session readiness
took 629 ms, first provider PCM arrived at 1,264 ms, and first device PCM was
sent at **1,473 ms**. This is a **2,533 ms / 63.2% reduction** from the fresh
4,006 ms reproduction, without caching speech or changing the required live
Grok opening greeting.

The same run completed a real PTT turn and Grok-driven colour tool call. It
conserved 492 microphone frames and 116/116/116 accepted, submitted, and
completed turn-response frames, with zero drops, flushes, failures, resets, or
protocol errors. The aligned network evidence is valid: all links remained up
at -65 through -62 dBm, DNS took 51.438 ms, TLS connect took 40.075 ms, and no
PCM socket lifecycle counter advanced. The nearby Mac independently transcribed
exactly `Production turn one is green.`, matching Grok. The immutable manifest
nevertheless remains honestly `audio-invalid`: its one-second ambient window
was noisier than the later response, so the relative-energy oracle failed even
though the exact transcript and digital ledger succeeded. This run establishes
the latency/transport result, not a relaxed acoustic-energy threshold. Manifest
and network SHA-256 values are respectively
`0081bc711a0f6d308a22fa1bb877d1565d6ad353ff7adb2ccf217f64e61a702b`
and `202b43412c6104a574c309fbefff538fe704ec5c4ae6770b5495eea77c56fd04`.

Future production proofs now have an explicit **2,500 ms Button-B-to-first-
device-PCM gate**. That ceiling leaves bounded provider variation around the
measured 1,473 ms while deterministically rejecting the old 4,006 ms path.
The regression tests explain why provider connection alone is insufficient:
the measured boundary includes Grok generation and delivery to the physical
device. Tightening the ceiling should follow a distribution of clean runs;
raising it to absorb unexplained delay is forbidden.

## Production capability UI and live-metrics proof (2026-08-01 09:37 UTC)

The panel is now observable through the same production Cap'n Web mount that a
normal app/OS agent receives. From a production project-scoped ITX session,
`itx.kit.m5sticks3.captureScreen()` returned a complete 1,133-byte, 240×135 PNG
with SHA-256
`a4ba3b91ec96d28420dd457345c599ec055e1520f62e2c312857462f0584c0e4`.
The decoded framebuffer says `ITERATE VOICE`, `READY`, `TOP: start call`, and
`Then hold FRONT to talk`. This is the device's framebuffer result, not a
camera-based UI guess. The retained image and structured invocation evidence
are under
`apps/kit/evidence/m5sticks3-production-capabilities/2026-08-01T09-37-00Z/`.

The same project-scoped session subscribed to
`itx.kit.m5sticks3.subscribeToMetrics(cb)` and received the live callback from
the physical C peer. At 939,299 ms uptime it reported 8,377,292 free heap bytes,
96,063 free internal/DMA heap bytes, 8,305,500 free PSRAM bytes, 656 bytes of
minimum task-stack headroom, and 163 permille CPU. Its cumulative audio ledger
remained exact: 495 capture/uplink frames, 176 received/submitted/completed
downlink frames, empty current queues, and zero capture, uplink, downlink,
playback, or protocol failures. This closes the later screenshot request and
the original requirement that metrics be streamed into userspace; it is not a
simulator or direct-USB observation.

A second proof used the product's ordinary production agent loop, not the
operator script as a surrogate. `/agents/kit-device-proof-20260801` received a
normal user chat request, generated an ITX script that called
`changeColour("red")` and `captureScreen()`, then sent a visible web-chat reply
with the returned bytes attached as `m5sticks3-screen.png`. Event offset 531
contains the 1,139-byte attachment in project file storage. Downloading and
decoding that attachment produced a 240×135 PNG with SHA-256
`e80cb84e65c1296106c0549899fc48d5745886c87e8d6eeb87d760ee3f4ede54`;
its framebuffer is visibly red and retains the complete call instructions.
The round trip took 60.767 seconds because it included a full general-agent LLM
turn; this is evidence of agent usability, not the device capability's latency
budget. The exact attached image is retained as `agent-screen-red.png` beside
the direct capability evidence.

## Morning-ready deployed conversation checkpoint (2026-08-01)

### Current-source three-turn acceptance at 06:37 UTC

The latest production userspace object is
`7a2d07d020a6238965d6b9c854be9512253df366`. A fresh unattended run through
that exact object passed three consecutive real-Grok turns on one physical
M5StickS3 `/pcm` connection and is retained at
`apps/kit/evidence/m5sticks3-morning-conversation-clean-network/2026-08-01T06-37-04-147Z/iterate-kit-acoustic-7gbR33/`.
Its manifest SHA-256 is
`14d89614a1c56875dd391b3d44e957df61047e4c817bfdc25da156cdf4fdb128`;
the aligned network artifact is
`fdd2be8bff8aa5132728a7a948146efb68390b0bf3a1641eeecc9bea9217ba5b`.

The Stick captured and the worker received exactly 1,511 microphone frames.
The worker emitted 288 speaker frames and the device accepted, submitted, and
completed exactly 288. All uplink/downlink drops, audio failures, playback
flushes, protocol failures, socket disconnects, Wi-Fi disconnects, and restart
incidents remained zero; every queue drained between turns. The nearby Mac
independently transcribed the first physical reply exactly as `Production turn
one is green.` The response was coherent and unclipped, with an 18.119x
response-to-ambient maximum-RMS ratio. Its provisional acoustic policy remains
the previously documented independent-transcript/relative-energy exception;
no digital, reset, or network gate was relaxed.

The correlated interval is `valid`: all 44/44 Stick, 44/44 router, and 44/44
worker probes replied, with maximum RTTs 41.928, 8.764, and 71.617 ms. Forty-five
device samples remained linked at -60 to -57 dBm. DNS completed in 2.174 ms,
TLS connect in 44.512 ms, and the control and PCM sockets recorded no lifecycle
fault. A preceding otherwise exact three-turn run is retained separately as
`network-invalid` because one worker probe measured 111.813 ms; it was not used
to waive the network gate.

This run also physically exercised the production provider lifecycle bug found
in the preceding attempt. Grok emitted one explicit cancelled `response.done`
before three genuine completed replies. Userspace now reports one cancellation
and three completions; the cancellation neither satisfies the harness's audible
response fence nor sends a fake PCM end marker. The 105 exact raw provider
events were all appended to `/devices/m5sticks3` with no loss, append failure,
provider error, or unclassified response status. Their standalone JSONL SHA-256
is `ed3665072f46d2f9dd7887c3cd5f1062d849b71167567f46d245e7e798213f80`.

The run directly acknowledged the red precondition and retained Grok's bounded
`changeColour({colour: "green"})` call plus `{colour: "green", ok: true}` tool
result through `env.ITX`. The person beside the physical Stick subsequently
reported that its visible red and green backgrounds were reversed. That
physical observation is the acceptance oracle: the M5StickS3 adapter now maps
the shared semantic enum through board-local `m5StickS3PhysicalRed` and
`m5StickS3PhysicalGreen` aliases, leaving the shared capability and correctly
wired StackChan/simulator paths unchanged.

The corrected 1,153,120-byte image (SHA-256
`c1e940690326c9442f8b24970ea8e706cc670102ef3004d9714d46a63393ff87`)
was then freshly flashed to the same MAC and rebooted. A new production run
first invoked semantic red directly and then made Grok invoke semantic green
through `env.ITX`; both calls were acknowledged, the spoken reply played, and
the exact 478 uplink and 112 accepted/submitted/completed downlink frames were
conserved. Every drop, underrun, flush, restart, protocol failure, socket
failure, and Wi-Fi disconnect delta remained zero. The 40 raw provider events
were contiguous from sequence one, and the green tool result was retained with
SHA-256
`891930ebdd67b860f734b2d32304d10653e2f6600a8593bfc0b50a7bc3f8535f`.

That calibrated-source run is retained at
`apps/kit/evidence/m5sticks3-colour-calibration/2026-08-01T06-55-51-322Z/`;
its manifest SHA-256 is
`c996277bad6c37d885c650221625ac6fdd6e1edff3d127fba930e3fd6f4bad67`.
Its network classification is `valid`: all 16 device, 16 router, and 16 worker
probes replied with maximum RTTs 78.083, 7.128, and 58.352 ms, while the 17
device samples stayed linked at -60 to -58 dBm. The independent Mac recording
transcribed `Production turn one is green.` exactly and clipped no samples.
This fresh proof validates the corrected firmware's complete command and audio
path; because the harness has no camera aimed at the panel, it does not invent
an optical observation beyond the person's report that established the
calibration.

That historical proof's cleanup invoked conversation hang-up and observed the
then-current `/pcm` generation close. The corrected architecture keeps the
device lane warm and retires only the provider generation. The Stick remains
provisioned and idle: press top Button B once to start a conversation, hold
front Button A while speaking, release it for the reply, and press Button B
again to hang up.

The complete checkpoint, including source, physical evidence, and concurrent
hardware-port work, is preserved on `origin/c-capabilities` at
`934710ddc74b448a1b0466d9bcfee9a1d1e56b62`. The earlier whole-worktree safety
checkpoint remains independently available as
`origin/backup/c-capabilities-stick-production-20260731` at
`3820bd408536d6cbdbffd56b1594b1b0099ce99b`; neither checkpoint is a merge or a
claim that the later StackChan and Home Assistant ports are finished.

The physical M5StickS3 is flashed, provisioned, mounted, and left idle on the
production test project ready for a human conversation. Press the top Button B
once to connect; hold the front Button A while speaking and release it to hear
Grok; press the top button again to hang up. This is intentionally PTT: the
Stick runs neither VAD nor AEC. The two sockets remain separate—ordinary Cap'n
Web at `os.iterate.com/api` and binary PCM at the userspace app's `/pcm` route.

The current installed userspace source is object
`a4cc2e559da8de1554c5c02f46efb35aa9a31e86`. Its session update selects
`grok-voice-think-fast-2.0`, disables turn detection, and now retains
`keep_context: true`, so repeated PTT turns share a real conversation. The
worker also posts the exact raw non-PCM provider frames to
`/devices/m5sticks3`; the retained run contains 113 ordered frames, including
transcriptions, response lifecycle, three tool calls and outputs, and pings,
with no provider `error` event.

The unattended three-turn acceptance interval is retained at
`apps/kit/evidence/m5sticks3-morning-ready/2026-08-01T01-49-06-986Z/iterate-kit-acoustic-8coYEz/`.
Its immutable source manifest SHA-256 is
`564da2c7b6f1809bef8f6753b38a710462d5542bcde68ff69e10d62fe8cfaf23`.
On one deployed `/pcm` session it sent 1,464 microphone frames and received 324
speaker frames. Worker downlink, device acceptance, DMA submission, and DMA
completion are all exactly 324. All three responses completed and all three
`changeColour` calls succeeded in order green/red/green through `env.ITX`.
Every drop, flush, underrun, failure, restart, reset, protocol error, WebSocket
disconnect, and Wi-Fi disconnect delta is zero. The source reservoir drained;
device playback queues drained; `keep_context` was observed in the raw event
stream rather than inferred from source.

The exact network interval is valid. Forty-four device samples stayed linked
at -53 to -48 dBm with zero Wi-Fi or PCM lifecycle faults. All 43/43 device,
43/43 router, and 43/43 worker probes replied; maximum RTTs were 22.236 ms,
7.406 ms, and 60.11 ms respectively. DNS took 1.637 ms and TLS connect took
47.276 ms. Thus the physical audio judgment is not being made during a bad or
indeterminate network interval.

The nearby Mac independently transcribed Grok's first physical reply exactly
as `Production turn one is green.` The response was coherent, unclipped, and
2.8763 times the ambient maximum. The immutable manifest predates the final
landing policy and therefore records a failure because it counted three 20 ms
windows above the relative threshold rather than four. The current policy
accepts exactly this one-window phase-boundary miss provisionally only when the
independent transcript matches, the response remains at least 2.5x ambient,
and clipping is zero. Two windows still fail. The exact one-window deficit and
the unchanged stricter four-window/fixed-120-RMS misses remain in the artifact;
transport, frame conservation, reset, and network gates were not relaxed.

The flashed application image is 1,152,464 bytes with SHA-256
`b576c4338e1dd7d75df4b1be2f7ffb88d72537f473e831c959427b15160fb6ee`.
At the end of the clean interval internal/DMA heap had 20,571 bytes free and a
19,456-byte largest block; task stack headrooms were 6,652 bytes (audio), 2,556
bytes (main), 4,584 bytes (control network), and 4,528 bytes (PCM network).
CPU was 195 permille. The allocator's boot-to-run historical minimum was only
279 bytes even though no allocation failed and steady state recovered. That
startup transient is a visible memory-headroom follow-up, not silently called
healthy or used to invalidate the otherwise exact conversation.

### Fresh pre-handoff validation without reflashing

At 02:30 UTC on 2026-08-01 the deployed worker health route, physical Stick,
USB identity, Cap'n Web mount, project credential, real Grok session, raw event
stream, colour tools, uplink, and playback path were exercised again. The run
completed three remote-PTT turns on one production `/pcm` connection. It sent
1,464 microphone frames, conserved all 324 accepted/submitted/completed
downlink frames, completed three responses, and called the colour capability
green/red/green. The raw artifact contains 113 ordered provider events with no
provider error. The nearby Mac independently transcribed the first response as
`Production turn one is green.`; it contained 20 relative-energy windows,
measured 7.516x ambient maximum, and clipped no samples.

That otherwise clean run is deliberately classified **network-invalid**, not
promoted to a new acceptance run: one aligned router probe reached 62.223 ms
against the 50 ms gate and one worker probe reached 104.568 ms against the
100 ms gate. Its evidence is under
`apps/kit/evidence/m5sticks3-morning-final/2026-08-01T02-30-33-544Z/`.

A bounded retry at 02:32 UTC completed two fully accounted turns. Grok also
emitted a complete third response in the retained raw stream, but the harness
did not observe the matching terminal device-playback metrics before its
finite deadline. The interval independently contained router RTTs of 69.990,
74.467, 79.675, and 93.141 ms and worker RTTs of 103.507 and 123.237 ms, so it
is also correctly **network-invalid**. It is retained under
`apps/kit/evidence/m5sticks3-morning-final-valid/2026-08-01T02-32-58-807Z/`
as a regression lead for callback/metrics freshness under poor connectivity,
not as positive evidence and not as an unexplained success.

An immediate post-run 20-probe diagnostic window was clean (maximum Stick,
router, and worker RTT 22.934, 8.336, and 53.732 ms respectively). This shows
the invalidity was intermittent; it does not retroactively validate either
measured audio interval. Repeating effectively identical conversations until
one happened to sample a quiet router would add little confidence and risk the
known-good device state. The earlier immutable `m5sticks3-morning-ready` run
remains the authoritative network-valid production acceptance. The Stick was
left idle on that same known-good firmware and production configuration.

## Achieved deployed-userspace slice

The production project is `kit-stick-voice-e2e-20260731`
(`prj_bd8785e119fe4f1d8631bb95e1dea748`), hosted at
`kit--kit-stick-voice-e2e-20260731.iterate.app`. The retained installed worker
configuration is object `a4cc2e559da8de1554c5c02f46efb35aa9a31e86`. The
device authenticated with its project credential, mounted its ordinary Cap'n
Web target through `os.iterate.com/api`, and opened the separate binary `/pcm`
lane. The unattended proof invoked the same bounded conversation and PTT event
paths remotely; the firmware maps the top button to conversation start/stop and
the front button's held/released edges to that same PTT path. No VAD or AEC is
enabled on the Stick.

The best current-code physical run is retained at
`apps/kit/evidence/m5sticks3-production-grok/2026-07-31T22-51-25-938Z/iterate-kit-acoustic-SvSlh5/`.
It passed the acoustic and exact digital gates: 484 microphone frames reached
the worker, 164 response frames were accepted/submitted/completed by the
device, every drop/failure/flush/reset/disconnect delta was zero, and the
nearby Mac independently transcribed exactly `The deploy iterator stick voice
path is working.` once. Response-to-ambient maximum RMS was 9.205x with no
clipped samples. Grok called `changeColour` with `{ "colour": "green" }`; the
raw correlated tool output was `{ "colour": "green", "ok": true }`, and the
device capability changed the physical display.

That particular interval is deliberately retained as **network-invalid**
because two RSSI samples were -77/-76 dBm against the unrelaxed -75 dBm gate,
despite complete reachability and clean socket counters. It is not used to
waive network validity. The separate clean network-valid production run at
`2026-07-31T22-27-23-059Z/iterate-kit-acoustic-uSZH47/` conserved 488 uplink and
164 downlink frames with the same zero-fault ledger. Its original manifest
failed the deliberately over-strict fixed 120-RMS acoustic threshold: ambient
maximum was 7.648 and response maximum 37.139 (4.856x). The retained independent
xAI speech oracle in `acoustic-transcription-independent.json` recovered the
provider's exact sentence, word-timed from 1.566 to 4.597 seconds, while the
recording remained coherent and unclipped. Under the explicitly provisional
safe-gain policy this is the separate clean valid physical run; the 120-RMS
threshold remains recorded as a stricter follow-up rather than being rewritten.

An earlier clean-network run at
`2026-07-31T22-43-33-775Z/iterate-kit-acoustic-wKKvgb/` is retained as a useful
failure: the provider returned speech and a tool call in one response, and the
bridge unnecessarily requested a continuation, making the Stick speak the
sentence twice. The literal raw event sequence produced a regression test. The
bridge now records whether the tool-bearing response already emitted PCM and
only creates a continuation for a tool-only response. This avoids hiding
provider variability behind prompt-specific assumptions.

### Raw Grok event stream

The 2026-08-01 unattended production check makes this lane directly usable as
a forensic artifact rather than leaving raw frames nested inside a large proof
manifest. Its exact 45-frame JSONL is retained at
`apps/kit/evidence/m5sticks3-production-grok-raw-stream-check/2026-08-01T00-12-03-066Z/provider-events.jsonl`.
The records are stream offsets 621–665 and provider sequences 1–45 for one PCM
session. They include the progressively refined microphone transcription, the
final input transcript, the `changeColour({ colour: "green" })` arguments and
correlated `{ colour: "green", ok: true }` output, both response lifecycles,
the completed output transcript, and pings. There is no provider `error` frame
and no provider text about a WebSocket failure. The independently captured Mac
microphone transcript exactly matches Grok's completed output transcript:
`The deploy iterate stick voice path is working.`

That run's network interval is valid and its digital ledger is exact: 482
microphone frames reached the deployed worker, 168 return frames were accepted,
submitted, and completed by the Stick, and every drop, reset, disconnect,
transport-error, and protocol-failure delta is zero. The overall manifest
remains honestly `audio-invalid` because the conservative energy oracle found
only one 20 ms window above 2.5 times the _maximum_ one-second ambient RMS,
instead of four, despite the exact independent speech transcript and a 3.50x
response/ambient maximum ratio. This is retained as an acoustic-oracle false
negative candidate, not rewritten as a clean automated pass and not used to
weaken any transport gate.

The immediately preceding failed check is also retained under
`2026-07-31T23-58-19-288Z/`. Its ten exact provider frames contain no provider
error. The phrase `WebSocket disconnected without sending Close frame.` came
from the userspace bridge's device-side close diagnostic after the firmware
discarded 13 stale microphone frames and replaced the `/pcm` generation; it
was not something Grok said. A regression now recovers the failed generation's
counters from the worker's bounded `previousSession` report, writes
`network.json` even on early proof failure, and exits the finite proof CLI after
flushing its result rather than waiting indefinitely on a closing RPC socket.

The worker cross-posts the exact raw JSON of every non-PCM Grok frame to the
normal Iterate stream `/devices/m5sticks3` as
`events.iterate.com/kit/provider-event`. Each record has a session id, monotonic
sequence, receive timestamp, provider type, and untouched raw payload. The
production proof read the stream back and verified continuity and order for 45
frames, including incremental and final input transcription, response
lifecycle, output transcript, `ping`, function-call arguments, and correlated
function output. No provider error event occurred in the retained run. This is
the diagnostic lane for questions such as whether a spoken complaint referred
to a provider WebSocket event; PCM never enters it.

Posting is bounded and nonblocking: at most 64 events, 256 KiB total, 64 KiB
per event, and eight events per batch. Overflow/post failure is counted and
visible rather than retried into an audio backlog. Provider-event journal
metrics, device metrics subscriptions, PCM accounting, and capability-call
results are all visible from the userspace worker and asserted by the same
production proof.

The ESP-IDF v5.4 transport also emitted `esp_tls_conn_read error` for normal
zero-timeout `WANT_READ/WANT_WRITE` probes even while every frame and socket
counter was exact. A source-transform regression now classifies those retryable
states before logging/capturing an error, while preserving the original log and
TLS error handle for genuine negative results. This repairs contradictory
diagnostics; it does not excuse a transport fault. The patched image rebuilt at
`0x119350` bytes (45% of the 2 MiB app partition free), passed the realtime ELF
audit, and was app-flashed to stable MAC `70:04:1d:d5:45:88` without replacing
its provisioned settings. An unattended production capability sequence then
started a conversation, held/released PTT, and hung up through the deployed
worker. Serial retained the expected `connecting` → `ready` → `stopped` PCM
lifecycle with no TLS error line.

## Historical first landing course: prolonged local-tunnel conversation

Before the deployed slice above, the deliberately narrowed landing path was the existing local userspace
`/api` + `/pcm` implementation exposed through Captun at
`tunnels.iterate.com`. The Stick uses its provisioned project credentials,
mounts its ordinary Cap'n Web target through that public origin, streams its
physical microphone through `/pcm`, and receives real
`grok-voice-think-fast-2.0` audio through the same userspace process. Remote
Cap'n Web push-to-talk events and macOS `say` make the proof unattended while
the operator is away; no physical button prompt is permitted in this phase.

The retained acceptance run is not one smoke turn. The harness passed a short
multi-turn conversation and then extended to eight turns, retaining for every
turn:

- the injected prompt, provider lifecycle and transcription events, and exact
  turn timestamps;
- raw microphone-uplink, speaker-downlink, and nearby-Mac acoustic captures;
- exact device receive/submit/completion frame conservation, zero loss/reset/
  failure deltas, queue drain, and heap/CPU observations;
- stop-to-provider, stop-to-first-downlink, and stop-to-audible-completion
  timing; and
- one automatic network verdict spanning the exact conversational interval,
  with device RSSI/link and control/PCM socket counters, device/router/tunnel
  reachability, and tunnel DNS/TLS-connect evidence.

A run with bad network evidence is retained as `network-invalid`, never used to
judge the audio path, and never promoted to a pass. A run with incomplete
network evidence is `indeterminate`. Only a separately clean `valid` interval
can land the conversational gate. The deterministic local return remains a
diagnostic oracle and does not substitute for the prolonged real-Grok run.

For that earlier landing phase, deployed dynamic-worker installation, generation
replacement, `.kill()`/remount behaviour, and preview/production lifecycle
proof are explicitly deferred. The already-observed deployed callback/
generation defect remains recorded evidence, not a reason to keep blocking the
physical conversation on Cloudflare lifecycle debugging.

After the Stick conversation is solid, hardware work remains ordered:
StackChan full-duplex/interruption/measured AEC, then Home Assistant Voice
Preview Edition through the shared core. Face/avatar work stays deferred until
those audio and capability slices work.

This narrows the immediate proof order without shrinking the persistent
physical-device voice goal. StackChan, Waveshare, Home Assistant Voice Preview
Edition, AEC, and ten-minute endurance remain required by the parent goal, but
they do not block landing one production-shaped M5StickS3 path.

## Retained prolonged real-Grok conversation

The acceptance artifact is
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T18-05-38-138Z/`.
Its local README records the complete evidence map and exact values. In one
provider session, eight remote Cap'n Web PTT turns sent 2,142 microphone frames
and returned 1,008 speaker frames. Every turn independently conserved accepted,
submitted, and completed PCM with no drop, flush, failure, restart, reset, or
protocol delta. Queue high waters remained 3/4/6 frames, heap returned slightly
above baseline, and stop-to-first-speaker latency stayed between 720.6 and
925.8 ms rather than increasing by turn.

The provider maintained cross-turn context (`lantern`, then `engineer`) and all
eight physical speaker replies were independently recovered from bounded
nearby-Mac microphone slices. The 77.226-second interval was automatically
`valid`: all 78 device/router/Captun reachability probes replied, all 79 Wi-Fi
samples were link-up at -56 to -53 dBm, and the PCM socket had no reconnect,
disconnect, or transport error.

## Retained real-Grok interruption and recovery

The acceptance artifact is
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T18-33-07-329Z/`.
After a fresh app flash, the mounted remote PTT capability interrupted a live
counting response and immediately opened a second microphone epoch. Grok
reported the first response `cancelled`, transcribed the replacement request,
and completed `Interruption successful.` The nearby physical microphone
independently recovered `One.` before the cut and `Interruption successful.`
after it.

The exact device ledger was 115 accepted speaker frames = 103 completed + 12
generation-flushed, with zero transport drops/failures/restarts and drained
queues. Device RPC interruption took 110.050 ms; fresh speaker PCM arrived
992.026 ms after the second release. The complete 18.462-second interval was
network-valid with 19/19 replies from each reachability target, -54 to -53 dBm
Wi-Fi, and zero socket lifecycle faults.

An earlier valid attempt at `2026-07-31T18-25-45-863Z/` exposed a harness-only
negative latency caused by assigning stale generation PCM to turn 2. A red
regression test led to a provider `response.created` causal fence, and the
retained rerun above proves the corrected positive measurement. The older raw
artifact remains retained rather than silently discarded.

## Achieved unattended local-userspace slice

The retained run at
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T12-18-12-256Z/`
is the landing evidence for the autonomous Stick slice. No person pressed the
device: the test controller invoked the mounted Cap'n Web `pushToTalk`
capability, kept the physical microphone streaming while macOS spoke the test
prompt, released the semantic PTT event, forwarded that live PCM through the
real local userspace `/pcm` implementation to `grok-voice-think-fast-2.0`, and
played the response on the physical Stick.

The result conserved 428 microphone frames / 273,920 bytes and 244 speaker
frames / 156,160 bytes. The Stick accepted, submitted, and completed exactly
244 / 244 / 244 returned frames. Every drop, flush, underrun, reset, failure,
and protocol-failure counter remained zero; all queues returned to zero. The
room-microphone recording was independently transcribed as:

> The unattended stick voice test passed with clear continuous playback.

The exact 14.987-second interval was automatically classified network-valid.
All 16 device diagnostics and all 15 device/router/worker reachability samples
arrived, RSSI stayed from -39 to -32 dBm, and the PCM socket recorded zero
reconnects, disconnects, or transport errors while conserving the same byte
counts.

The run also proves the source/device buffer distinction introduced after an
observed 203.28 ms Grok packet gap. Userspace waits for a bounded 32-frame
source reservoir but sends only the existing eight-frame startup lead to the
Stick, then one frame per media deadline. Host tests prove the split, including
short-response completion, and the full Kit suite passes 426 tests with one
explicit live test skipped.

The current target build is 1,150,208 bytes with 45% of the 2 MiB application
partition free. The physical run observed a 105,539-byte internal-heap floor,
2,376 bytes of main-task stack headroom, and roughly 330 permille peak CPU while
the microphone streamed. DIRAM is 70.06% used. The ESP-IDF size report leaves
only one byte in its 16 KiB IRAM segment; the realtime ELF audit passes, but
that footprint remains a visible portability risk rather than being normalized.

This lands the requested autonomous local bridge path, not every criterion in
the broader contract below. In particular, it does not silently substitute for
the production Cloudflare userspace route or the final physical Button A
provenance check. Those remain separate, honest gates; neither requires
repeating this already-sufficient local audio proof.

## Credible achieved slice

A retained run may be called the Stick vertical slice only when one freshly
flashed image has proved, in order:

1. the normal TypeScript flashing/provisioning path wrote the firmware and
   settings partition for the stable M5StickS3 identity;
2. the device reached a real Iterate userspace app/worker, authenticated, and
   mounted its Cap'n Web capability at its configured `/kit/...` path;
3. a physical held-button push-to-talk interval continuously emitted 640-byte,
   20 ms microphone frames to that app's `/pcm` path before button release;
4. the same userspace path forwarded a live turn to
   `grok-voice-think-fast-2.0`, retained provider lifecycle/transcription
   evidence, and relayed returned PCM to the device;
5. the Stick played the returned audio audibly, with device counters and a
   nearby-Mac recording proving what reached the speaker path; and
6. a deterministic mode in the same userspace `/pcm` implementation can return
   known tone or PRBS PCM, so provider variability is not allowed to erase the
   transport/audio oracle.

The deterministic return is not a substitute for the live Grok spoken smoke
test. The live smoke test is not a substitute for deterministic byte and
acoustic evidence.

## Historical blockers and shortest path (resolved for this slice)

This section records the evidence that selected the eventual landing path. The
brownout and safe-gain blocker described here is resolved in the retained
deterministic and conversational runs above; it is no longer the current Stick
blocker.

- the ROM printed `Brownout detector was triggered`;
- reset reason was `RTC_SW_SYS_RST`;
- saved PC `0x403758a2` resolves to `rtc_brownout_isr_handler` in ESP-IDF
  5.4.2;
- the reset occurred after only 43 returned tone frames while Wi-Fi/control
  calls were still progressing.

Therefore the fastest honest route is:

1. bound Stick speaker output to the board/library's normal safe gain rather
   than continuing to tune WebSocket recovery around power resets;
2. prove a short and then one-minute deterministic return through the existing
   userspace `/pcm` path with no brownout;
3. add an automatic network-validity verdict to the physical evidence;
4. freshly flash and run physical PTT through the real userspace Grok mode;
5. retain an explicit achieved/deferred ledger.

Disabling the ESP brownout detector is forbidden. Increasing audio queues is
not a power fix.

## Achieved deterministic sub-gate

The exact image built at `0x118820` bytes was freshly flashed through
`pnpm device:e2e` to MAC `70:04:1d:d5:45:88`. Its ES8311 output ceiling is
fixed at -18 dB rather than disabling brownout protection.

The direct-LAN userspace path mounted `/api` and `/pcm`, returned 3,000
deterministic 20 ms frames over 60 seconds, and the device accepted, submitted,
and completed all 3,000. All drop, underrun, recovery, reset, playback-failure,
and protocol-failure counters remained zero. Application downlink high water
was six frames and speaker high water was four.

The nearby Mac's independent 48 kHz microphone recording passed the strict
continuity oracle:

- observed tone span: 59,955 ms for 60,000 ms requested;
- missing tone: 45 ms, within the 200 ms duration allowance;
- internal gaps and phase discontinuities: zero;
- maximum phase-step error: 0.097757 rad against a 0.1 rad bound; and
- maximum amplitude step: 0.981 dB against a 1.5 dB bound.

The exact interval was automatically classified `valid`, not inferred from the
audio result. It retained 63 successful Cap'n Web diagnostic snapshots and 62
successful samples each for the Stick, router, and local worker. RSSI stayed
between -43 and -40 dBm; maximum RTTs were 24.433 ms, 19.578 ms, and 0.267 ms
respectively. PCM transferred 1,920,000 bytes with zero reconnects,
disconnects, or transport errors and was still open at the measurement
boundary.

This proves the fresh-flash, deterministic-return, audio-continuity, and
network-attribution sub-gate. It does **not** yet prove the real deployed
userspace worker or physical-button/manual-turn propagation to that worker.

## Achieved direct-LAN real-Grok sub-gate

The same local userspace fetch handler then ran the real
`grok-voice-think-fast-2.0` path over the Stick's direct LAN connection. A
remote Cap'n Web PTT operation kept the microphone lane open while the nearby
Mac spoke `Please reply with exactly: Local device voice is working.` Grok's
input transcription and output transcript both matched exactly. The human
observer then independently confirmed that the returned sentence was audible
from the Stick: `it worked!`

The digital result conserved the complete observed run:

- microphone uplink: 242 frames / 154,880 bytes;
- speaker downlink accepted, submitted, and completed: 116 / 116 / 116 frames,
  or 74,240 bytes;
- application downlink high water: six frames; speaker high water: four;
- zero uplink/downlink drops, underruns, flushes, failures, protocol failures,
  reconnects, or resets;
- maximum microphone transport-accept age: 27 ms; and
- local bridge maximum payload in flight: 4,480 bytes / seven frames, with a
  0.611 ms maximum send-callback latency and 24.117 ms maximum downlink
  interarrival.

The provider delivered 50,888 response bytes in only 235 ms, including one
20,552-byte WebSocket message. That exposed and fixed a userspace boundary
error: provider message size had incorrectly been treated as device jitter
capacity. The proxy now retains a bounded userspace response reservoir, primes
only the configured device lead, and replenishes it at 20 ms media deadlines.
The literal observed packetization is a regression test.

This is a genuine device/Grok/speaker round trip, but it is still a sub-gate:
the PTT edge was invoked remotely, this particular voice interval did not yet
write the automatic network-validity artifact, and it bypassed Captun. The next
retained run uses physical Button A, the public tunnel, per-direction raw PCM
recordings, and the same userspace handler.

## Exact autonomous regression proof

A later multi-turn run exposed two separate userspace/harness defects rather
than a vague acoustic problem:

- one legal Grok WebSocket message was 73,400 bytes, exceeding an arbitrary
  64 KiB per-message guard; and
- after that guard was corrected, a complete observed response totalled
  148,222 bytes, exceeding the old four-second userspace response reservoir
  because xAI generated 4.63 seconds of audio in under one second.

The userspace reservoir is now an explicit bounded eight-second/256,000-byte
budget. This does not increase the ESP queue: the Stick still receives only
its finite realtime lead, interruption destroys the retained generation, and
overflow remains terminal and observable. A literal seven-message production
trace proves byte conservation under worst-case callback batching.

The same investigation found that the harness had accepted a failed response
with 46 frames received, 12 played, and 34 flushed. Queue depth zero only
proved that work disappeared; it did not prove audibility. The replacement
gate counts frames accepted at the userspace-to-device WebSocket boundary and
requires that exact delta in device receive, submit, and completion counters,
with no drop, flush, reset, or failure counter changing.

The first autonomous run through that strict gate passed:

- mounted capability: `kit.m5sticks3`;
- remote PTT drove a continuous 278-frame microphone interval;
- Grok input transcript matched the complete injected sentence;
- Grok replied `The autonomous device test is working.`;
- userspace observed 128 speaker frames and the Stick accepted, submitted, and
  completed exactly 128 / 128 / 128;
- downlink and playback queues returned to zero with zero drops, flushes,
  failures, or protocol failures; and
- the local PCM bridge closed normally after the verdict.

This repeatable mode no longer requires a person to press Button A: the same
mounted capability supplies remote start/stop while `say` provides a nearby
acoustic input. Physical Button A remains a distinct final provenance gate.
The run did not start the full reachability monitor, so its network verdict is
retained as `indeterminate`, not promoted from clean bridge counters. Its
machine-readable evidence is under
`apps/kit/evidence/m5sticks3-conversation/2026-07-31T11-53-00Z-autonomous-grok-exact/`.

## Corrected WebSocket PING/PONG model

The PCM firmware currently being replaced used client-originated WebSocket
PINGs as delivery barriers: four accepted microphone frames queued a PING,
eight supposedly "unconfirmed" frames stopped admission, and a matching PONG
released the window. That inference is invalid through Captun. RFC control
frames terminate at the immediate WebSocket peer; Captun forwards application
messages to the local fetch handler through its own Cap'n Web tunnel, but does
not expose the gateway's PONG as proof that local userspace—or Grok—consumed
the preceding PCM.

The correction is deliberately narrower than deleting WebSocket compliance:
the device must still reply to an incoming PING with a PONG. What is removed is
the PING-based PCM credit/admission policy and all telemetry claiming
end-to-end peer delivery. Current-audio safety remains owned by the bounded
application ring, maximum frame age, bounded send/no-progress deadlines, and
visible reconnect/drop diagnostics. If end-to-userspace delivery credit later
proves necessary, it must be an explicit application-level PCM ACK forwarded
through Captun—not an RFC PONG.

## Automatic network-validity verdict

Every physical audio evidence bundle must correlate the exact requested audio
interval against:

- device Wi-Fi RSSI/link state and reconnect/disconnect events;
- device and router reachability, RTT, and loss over the same wall-clock
  interval;
- DNS/connect timings and control/PCM socket progress/reconnect diagnostics;
- device reset/brownout evidence; and
- host bridge delivery and queue/freshness counters.

The machine-readable result has one of three values:

- `valid`: required network evidence is present and remains inside explicit
  bounds for the audio interval;
- `network-invalid`: correlated evidence proves a link/path outage, excessive
  RTT/loss, failed DNS/connect, or reconnect during the interval;
- `indeterminate`: required evidence is missing or cannot be aligned.

An audio failure in a `network-invalid` run is not attributed to the playback
pipeline. Such a run also cannot prove audio good. A separate `valid` run is
required for a positive audio verdict. Brownout/reset is a device-invalid
hardware/power failure, not a network-invalid escape hatch.

## Late-call reset and long-response correction (2026-08-01 23:20 UTC)

The report that otherwise successful multi-turn calls eventually reset or cut
off was reproduced and had two independent causes. Neither was attributed to
Wi-Fi or the ESP audio owner without evidence.

First, the platform `StatefulWorkerDurableObject` returned a child-facet
WebSocket directly from a capability call. The outer Durable Object could then
be evicted while the accepted socket was still live, terminating a healthy
device `/pcm` generation. The outer object now accepts and relays both text and
binary frames itself, so its lifetime owns the returned socket. The production
OS deployment containing that correction is
`7e2eca90-858d-4145-9e12-f230643b43d0`. Its regression keeps the same
generation alive for 150 seconds, crosses a separate capability call, and then
proves byte-exact text and binary traffic. A later failure during a different
OS deployment was separately classified from Cloudflare's explicit `This
script has been upgraded` close reason; it was not normalized as an audio bug.

Second, Grok generated a measured 71.88-second story much faster than realtime.
The then-current 60-second/1.92 MB userspace reservoir filled at 1,869,680
bytes, deliberately dropped 1,938,262 bytes, and closed the provider with the
explicit reason `The bounded userspace playback reservoir filled before
realtime playout caught up.` The Stick had played only 566 frames even though
its own queue, heap, sockets, and correlated network interval were healthy.
That failure is retained at
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-01T23-04-21-731Z/`
(failure SHA-256
`fa0e6f5f624aef872f76a37bacc19fc7800be05fea3ffb47a4b411bf3ad85618`).

The userspace reservoir is now 4,500 frames: a finite 90-second/2.88 MB
per-call budget. This does not enlarge the ESP queue or permit replay after an
outage. The device still receives at most its 12-frame/240 ms lead, and
interruption, socket failure, or overflow discards the userspace generation in
one observable operation. A literal 3,600-frame/72-second regression first
failed against the old bound and now proves complete realtime delivery; the
overflow test still proves terminal, accounted recovery beyond the new bound.
The deployed userspace source object is
`d830139b5a6ad4d8720c33a4335f3342938bf2ea`.

The fresh physical production run under
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-01T23-20-19-310Z/`
then completed a 70.86-second Grok response on one session. The worker emitted
3,543 frames; the Stick accepted, submitted, and audibly completed exactly
3,543, with zero drops, flushes, underruns, restarts, reconnects, provider
disconnects, or protocol failures. The response-reservoir high-water mark was
1,946,188 bytes, below the 2.88 MB bound. Device free heap changed from
8,372,500 to 8,372,424 bytes, every queue drained, and the PCM socket remained
open after 2,267,520 received bytes. Network attribution was independently
`valid`: 84/84 device-link samples stayed between -44 and -40 dBm, all 83
expected reachability samples existed for the Stick/router/worker, their
maximum RTTs were 27.842/7.926/16.080 ms, DNS took 35.030 ms, and TLS connect
took 42.318 ms.

The immutable run manifest remains honestly `audio-invalid`, but only because
the independent xAI STT helper used a fixed 30-second total timeout while it
was deliberately replaying a 73.157-second Mac-microphone interval in realtime.
Two red-first harness regressions now make the timeout equal to artifact
duration plus 30 seconds of completion grace and assemble xAI's finalized
chunks while replacing its overlapping speech-final tail. Reprocessing the
retained microphone bytes produced a complete 197-word transcript from `Once
upon a time` through `within his circuits`, closely following Grok's retained
195-word story. This proves recognizable physical speech across the whole
interval, but it is not relabelled as the stricter exact-transcript acceptance:
the independent recognizer made substitutions such as `workplace` for
`workshop` and `Asuka` for `Azure`. The immutable manifest, network artifact,
and assembled transcription SHA-256 values are respectively
`bb2065f5805a5a27ed4e48ce4a8dd99cef794fb316b2c8f35ab1a7889defb4ed`,
`4da361ca79bfce9be90d25bc8d046eac1472df8a6a6635e80692699c8921212b`,
and `ed0192433791ddf90573ddff1029cded0baefcbd70bf456ac06bf747570b6df9`.

An immediately preceding attempt failed 1.6 seconds into the reply because the
Mac harness's top-level `/api/itx` control session closed with `Network
connection lost.` The device control and PCM sockets, Grok socket, frame
counters, and correlated physical network interval all remained healthy. That
non-reproducing attempt is retained as a harness-control-invalid run at
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-01T23-09-55-409Z/`
(failure SHA-256
`7c46be5e9319922cd9363cfc9260746ba602563a152de1a0c5c9febd04c73dfa`),
not used to judge audio or waive the later clean run.

The same deployed userspace object then passed a fresh three-turn physical
regression at
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-01T23-36-53-106Z/`.
One PCM session handled three remotely driven PTT turns, 1,499 microphone
frames, 444 userspace downlink frames, and exactly 444 accepted, submitted,
and completed playback frames. Every drop, audio failure, protocol failure,
WebSocket disconnect, Wi-Fi disconnect, playback flush, and provider failure
counter remained zero; all application queues drained at the end. The worker
also completed the colour tool call and appended 120 raw provider events with
zero event drops or append failures. The device heap changed from 8,372,520 to
8,372,420 bytes and the final CPU sample was 250 permille.

The interval's automatic network verdict was `valid`: all 48 expected device
link samples were present at -43 to -40 dBm, all 47 expected reachability
samples were present for the Stick, router, and production worker, their worst
RTTs were 27.104 ms, 6.817 ms, and 18.413 ms respectively, DNS took 34.526 ms,
TLS/connect took 41.329 ms, and the PCM socket remained open with no transport
errors. Independent STT exactly recovered `The screen is green and the zebra
is awake.` from the Mac microphone, matching the provider transcript. The
immutable manifest, network artifact, and provider-event log SHA-256 values
are respectively
`e81fdae0008aa40af8011348e7ec262d9993e2b13979771321a630e542629bec`,
`d02bbbc149314e9009f493b8d5816b1d7991960ed5c5fb1a2f4845cebe039405`,
and `77a64f1d991b0b64f58ca6169cd1f44fac67eb1249fda60182159a349fcab8e3`.
The unchanged absolute 120-RMS acoustic threshold still misses at the current
brownout-safe gain; this run uses the previously agreed exact-STT plus causal
relative-energy provisional acoustic gate and does not relax any digital,
reset, or network requirement.

## PTT callback regression and production recovery (2026-08-02 02:49 UTC)

The later report that several conversations did not work at all was real and
was not an audio-quality fluctuation. The Stick opened its production `/pcm`
socket, but the worker never observed subsequent PTT events and therefore sent
no microphone frames to Grok. Before the fix, the worker reported seven device
event subscription attempts and seven failures; the only accepted events were
the initial snapshots delivered while each subscription was being created.

The root cause was failure ownership in `worker.ts`. It subscribed to the
critical device-event control plane and the metrics observability plane in one
try/catch. The event subscription succeeded, then the metrics subscription
failed, and the shared catch disposed the Cap'n Web project session that owned
the already-live PTT callback. A new `DeviceSubscriptionCoordinator` keeps one
bounded project session but gives the two subscriptions independent lifecycles:
an event failure still releases and retries the session, while a metrics failure
is retried and reported without destroying the working event callback.

The red-first regression models exactly that partial-success sequence. It
proves that the event callback remains callable and that its project is not
released after repeated metrics-capacity failures. A second installer
regression proves the new runtime module is included in the deployed source
bundle. The full userspace/config-worker lane passes 83 tests and the Kit
package typecheck. The corrected production config commit is
`f5d06f2fa1d8ffb87aa6dc8acca09f3102a3ff0a`, parent
`d830139b5a6ad4d8720c33a4335f3342938bf2ea`.

After the worker restart, one production Cap'n Web subscription generation
remained healthy across four fresh calls and nine remotely driven PTT cycles:
event and metrics attempts both remained one, both readiness flags remained
true, and both failure counters remained zero. A final three-turn physical
microphone proof used macOS `say`/`afplay` as a repeatable nearby speaker. The
Stick microphone captured each prompt, the deployed `/pcm` worker sent it to
`grok-voice-think-fast-2.0`, and raw events retained in `/devices/m5sticks3`
contained exact final input and output transcripts for turns one, two, and
three (`Production conversation turn N succeeded.`).

Digital accounting at the final snapshot was exact: device capture/uplink and
worker uplink were all 6,648 frames, worker/device downlink were both 1,368
frames, and 1,360 completed plus eight cumulative flushed frames accounted for
all 1,368 received frames. Those eight flushes already existed before the
three-turn proof because the stress harness deliberately began PTT before an
initial greeting had drained; no new flush occurred during the exact turns.
Every drop, provider failure/disconnect, send failure, end-marker timeout,
protocol failure, audio failure, and restart counter remained zero; all queues
drained. Final free heap was 8,378,364 bytes, the boot minimum was 8,352,336
bytes, and final CPU use was 152 permille. The device reported -43 dBm, zero
Wi-Fi/control/PCM disconnects, and a ten-packet post-run probe had zero loss.

This emergency proof is deliberately classified
`production-path-valid-acoustic-oracle-indeterminate`, not promoted to the
formal all-or-nothing acoustic acceptance. The Herdr daemon's CoreAudio process
opened the Mac microphone but received zero samples, so it could not record the
Stick speaker independently. The failed bounded recorder run is retained as
`host-harness-invalid`. The device driver nevertheless reported completed
playback for every non-interrupted return frame. The formal interval-aligned
network monitor was also not running; device counters span the call and the
post-run probe was healthy, but the strict network verdict remains
`indeterminate` rather than being inferred as `valid`.

The complete structured recovery summary, exact transcripts, counters,
classification, and caveats are retained at
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-02T02-49-05Z-subscription-recovery/summary.json`.

## Conversation-reset repair and long-reply proof (2026-08-02 03:47 UTC)

The subsequent report that ordinary multi-turn calls still eventually stopped
working exposed two more independent faults. Neither was accepted as random
provider or network variability:

1. The firmware event stream had only one callback slot. A second diagnostic
   `subscribeToEvents()` call could silently release and replace the deployed
   worker's callback, leaving the worker's subscription status looking ready
   while it could no longer receive PTT edges. The stream now has two bounded,
   independent observer slots over one fixed eight-event history. A slow
   observer snapshot-resynchronizes instead of blocking or replacing the
   realtime observer; a third observer is rejected without mutating either
   live subscription.
2. Playback recovery could retain an arbitrarily large amount of historical
   silence debt after a sufficiently long scheduling stall. A newly arrived
   reply could then be consumed as debt from a past DMA epoch instead of being
   played. Recovery is now bounded to two complete DMA cycles. Beyond that
   bound, the owner starts a new local DMA epoch and prebuffers the current
   audio; stale timing debt cannot grow across later replies.

The native regressions explain why each policy exists: two subscribers must
both receive a later physical PTT event, slot exhaustion must be explicit, and
a fresh frame after prolonged recovery debt must be rebuffered rather than
discarded. All 48 host tests passed under ASAN and UBSAN. The freshly linked
image is 1,160,022 bytes and reports 205,995 / 341,760 bytes of static DIRAM;
the post-link realtime placement audit passes. The ESP-IDF summary still shows
16,383 / 16,384 bytes in its small IRAM accounting window, so that measurement
is retained rather than described as comfortable headroom.

The corrected image was freshly flashed, without replacing provisioning, to
the Stick with ROM MAC `70:04:1D:D5:45:88` on the then-current port
`/dev/cu.usbmodem11201`. After boot, Wi-Fi was -43 to -44 dBm and both the
deployed worker event subscription and metrics subscription remained ready at
one attempt and zero failures. A simultaneous second production Cap'n Web
event observer saw snapshot sequence 9 plus conversation start/end sequences
10 and 11, while the worker accepted those same events and retained its
original subscription generation. This is the live proof that diagnostics can
no longer steal PTT control from the worker.

A three-turn deployed-production proof then conserved all 1,494 microphone
frames from device capture through worker uplink and all 440 returned frames
through worker egress, device admission, DMA submission, and completion. It
recorded zero drops, underruns, flushes, resets, reconnects, protocol failures,
or heap drift, and its interval was network-valid. The nearby Mac microphone
independently transcribed `The screen is green and the zebra is awake.` exactly
as Grok emitted it. The immutable manifest retained its stricter fixed-level
acoustic miss rather than being relabelled; the evidence is under
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-02T03-40-19-133Z/`.

Finally, the exact user-reported long-story shape passed through the same
deployed worker. One held PTT turn sent 396 microphone frames and Grok returned
2,172 frames (43.436 seconds of output audio); all 2,172 were accepted,
submitted, and completed. There were zero drops, underruns, DMA deadline
misses, freshness resets, playback flushes, WebSocket/Wi-Fi disconnects, or
provider failures. Uplink high water was one frame, playback high water was
four frames, PSRAM was unchanged, and free heap changed by 112 bytes across
the 54.5-second measured interval. All 56 expected link samples were present
at -45 to -42 dBm. The Stick, router, and production worker each returned all
55 probes, with worst RTTs of 12.175, 5.685, and 22.039 ms respectively; DNS
was 2.176 ms and connect/TLS was 38.574 ms. The automatic network verdict was
`valid` with no reasons.

The Mac capture independently recovered the complete story text. Its
response-to-baseline maximum-RMS ratio was 7.977, while the deliberately
stricter fixed 120-RMS follow-up gate still recorded zero qualifying windows.
The agreed independent-STT plus causal-energy policy passed, and the immutable
overall manifest is `passed: true`; the stricter loudness gate remains open and
no transport, reset, frame-conservation, or network requirement was relaxed.
The evidence is under
`apps/kit/evidence/m5sticks3-production-grok-from-device/2026-08-02T03-43-45-125Z/`.
Its manifest, network artifact, provider-event log, and raw Mac capture hashes
are respectively
`c0a97f1865a21bc15c33291fe02e72e33b3f042ac678c46a3f92a66ef4878fb6`,
`e174230c3fdf54cb2100bd0adfb1ac3ca3a209f780beed2a6e75eeb9f6e71869`,
`d9ec701f473fa52bdbb32a958389f84123c872ba42c0bfecc983b8efc604db0b`,
and `0c1ad7ec4d9418bb6528a32324301de54bad60f46a46bb00cc48b8d20323e317`.

## Dedicated recovery key and deferred conversation-policy correction

The 2026-08-01 Stick build leaves the two programmable controls dedicated to
their product jobs: Button B starts/ends a call and Button A is held for PTT.
The screen now identifies the separate hardware-managed power key as the
recovery control: one click resets the complete device, two clicks powers it
off. This recovery path deliberately sits below the application event loop and
both WebSockets, so it remains useful in precisely the wedged state that needs
a reboot; implementing `esp_restart()` on a normal application button would
have coupled recovery to the code that may be stuck.

The build was flashed to the freshly resolved port for stable ROM MAC
`70:04:1D:D5:45:88`, without replacing the provisioning partition. A live
production Cap'n Web `getDiagnostics()` call after boot reported one control
connection, zero control disconnects/errors, Wi-Fi connected at -61 dBm, and
32,895 ms uptime. A separate `captureScreen()` call returned a 1,018-byte PNG
whose framebuffer visibly includes `PWR: reboot  PWRx2: off`; its SHA-256 is
`3882a295634af257ba823fa27ad2dd3f9d650e79533fac46309596a25b3c589c` and it is
retained under
`apps/kit/evidence/m5sticks3-power-button/2026-08-01T20-34-33-858Z/`.
This proves the freshly flashed UI and production capability mount, while the
actual reset semantics come from the StickS3 hardware contract; no human power
press was claimed for this unattended run.

Two later product decisions are recorded without expanding this focused
recovery change:

- Connecting a call must not make the assistant speak first. Grok should
  respond only after the user supplies a PTT turn.
- Pressing PTT while assistant audio is playing currently muddles the turn and
  playback state. That needs a separate deterministic interruption/flush test
  and correction; it is explicitly deferred from the recovery-key task, not
  accepted as working behaviour.

## Explicit deferrals for this landing

The following do not block the Stick slice and must be reported as deferred,
not silently dropped:

- StackChan flash/camera/LED/servo/full-duplex/AEC completion;
- Waveshare and Home Assistant device firmware;
- public `k.iterate.com` UX completeness beyond the already shared flashing
  core;
- ten-minute and loaded multi-device endurance;
- final production OAuth/device-token hardening;
- a final simplified create-once/direct-RX audio architecture if the current
  bounded path passes this vertical proof.

## Required hardware order after the Stick lands

The deferrals above are a sequencing decision, not a reduction of the parent
goal. Once the freshly flashed Stick has passed deterministic `/pcm` return
and the live Grok spoken slice, continue in this order:

1. Inspect `/Users/jonastemplestein/src/github.com/iterate/stackchan` before
   changing StackChan firmware. Reuse or adapt its measured codec, microphone,
   speaker, DSP, and AEC findings through the shared core. Do not inherit its
   known accumulating-delay/queueing behaviour.
2. Prove StackChan on the same capability and userspace `/pcm` architecture
   with the smallest honest board adapter. Acceptance requires measured
   full-duplex audio, interruption, and AEC effectiveness on the physical
   device; compilation or one-way sound is insufficient.
3. Bring up Home Assistant Voice Preview Edition through that shared
   architecture as the next hardware-portability proof.
4. Do not implement face/avatar rendering until all of those audio and
   capability slices work, including Home Assistant Voice Preview Edition.

The Waveshare target remains in the parent portability scope but does not
interpose itself ahead of this explicit Stick → StackChan → Home Assistant
audio order.

## Evidence locations

- Parent goal:
  [`physical-device-voice-goal.md`](./physical-device-voice-goal.md)
- Realtime problem/evidence map:
  [`audio-streaming-problem-and-evidence-2026-07-30.md`](./audio-streaming-problem-and-evidence-2026-07-30.md)
- Brownout diagnostic run:
  `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-60s-taskless-control-serial-diagnostic-20260731-0508/`
- Passing fresh-flash deterministic run:
  `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-60s-fresh-network-classified-20260731-0549/iterate-kit-acoustic-CO8nEq/`
  - PCM recording SHA-256:
    `cddf79f63ce949d8e97b264397079107161b962fe6d70fdd0c354fdf47b30279`
  - network artifact SHA-256:
    `145b103cee9f1ed5208fbd234c7b40f55b83aa5dc31c1e6c92c162fd930fa461`
- Passing unattended real-Grok conversation, exact PCM, independent acoustic
  transcription, automatic network verdict, and current build footprint:
  `apps/kit/evidence/m5sticks3-conversation/2026-07-31T12-18-12-256Z/`
- Complete remote recovery checkpoint:
  `origin/backup/c-capabilities-full-checkpoint-20260730T2345Z` at
  `a0c54771d7b92991387eef7644234c57e0529440`
- Complete deployed-slice recovery checkpoint:
  `origin/backup/c-capabilities-stick-production-20260731`; verified content
  commit `3820bd408536d6cbdbffd56b1594b1b0099ce99b`. This is a backup
  checkpoint, not a completion claim; it includes the fresh raw-provider-event
  proof artifacts and the first build-proven shared CoreS3/StackChan audio
  owner.
