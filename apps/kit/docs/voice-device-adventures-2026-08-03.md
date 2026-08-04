# Voice-device adventures — 2026-08-03

Newest entries are prepended below. This is an engineering log, not an
acceptance certificate: a device is complete only when the retained evidence
proves the full gate recorded at the end of this file.

## 04:28 — StackChan is physically absent; no substitute target selected

Non-disruptive macOS USB inventory now sees the Stick
`70:04:1D:D5:45:88`, HAVPE `D8:3B:DA:46:20:34`, and the explicitly denylisted
Waveshare `1C:DB:D4:7A:16:C8`. StackChan `68:EE:8F:D8:53:20` and its former
`/dev/cu.usbmodem2101` node are absent. This independently explains the
production device WebSocket close `1006` and the failed remote conversation
start, but does not identify whether the board is unplugged or powered off.

No serial endpoint was opened, no board was reset, and the StackChan image was
not redirected to another identical-VID/PID ESP32-S3. The next step is to
reconnect StackChan, re-enumerate its exact MAC, then perform the already
prepared profile-3 flash and physical proof.

## 04:25 — adversarial handoff retained; source-memory budget is observable

The 496-line Codex + Claude Fable/xhigh adversarial review was read in full
again before further buffer or AEC work. It remains intentionally untracked as
a durable review snapshot: newer source closes the receipt, truncation,
server-VAD, gain-oracle, exact-TX coupling, capture-clock, startup-livelock, and
count-oracle findings listed in its reconciliation header. Its remaining live
claims are not being waived: StackChan profile-3 double-talk quality, the
8/12/32 source-watermark physical A/B, and the long soak still require physical
evidence.

The new 180-second response reservoir was finite but its allocation ceiling was
not visible in `pcmMetrics()`. A public-metrics regression first failed because
the snapshot omitted both policy facts. It now reports
`downlinkResponseReservoirCapacityBytes: 5760000` and
`maximumProviderResponseDurationMs: 180000` beside actual queue/high-water
usage. All 58 PCM-proxy tests and Kit typecheck pass. The dedicated production
project was updated at config-repo commit
`b2bfeb8d7d3c5bd81995666a795d8d1dadc251f5`.

A remote `conversation.start` attempt did not create a new generation; the
worker still returns the prior closed session and its device-side abnormal
WebSocket close (`1006`). Consequently the newly deployed fields have not yet
been observed in a live physical session, and this is not misclassified as an
audio result. The prepared StackChan flash remains the shortest boundary to a
fresh production-shaped run.

## 04:20 — count proof corrected from live provider timing; worker updated

The adversarial review's count-oracle findings were reproduced rather than
waived. A direct `grok-voice-think-fast-2.0` 300..400 response produced
4,920,064 PCM bytes / 153.752 seconds in 20.85 seconds of wall time; a second
300..330 response produced 47.270 seconds. The former 90-second source budget
could not retain the required response, and 12 seconds of worker sends could
not make 25 numbers audible. The worker now has an explicit finite 180-second /
5.76 MB per-call source budget. The interrupted proof waits for 45 seconds of
cumulative hardware-release receipts and still requires the Mac microphone to
transcribe at least 25 exact sequential numbers.

Two regressions failed first: the measured 7,688-frame response was entirely
dropped by the old reservoir, and 2,250 worker sends with only 600 hardware
releases had no valid physical-prefix predicate. Both now pass through public
WebSocket/metrics seams. A separate anti-tautology regression deletes 37 only
from the independent microphone transcript and identifies that acoustic
boundary while accepting the complete provider ledger. Kit typecheck, format,
and 96 test files / 762 runnable tests pass; one opt-in live test is skipped.

The dedicated StackChan production project now contains these userspace changes
at config-repo commit `8ced731d6d57c5f5e41c1193d599b245f2dc245b`. A warm
post-install `pcmMetrics()` call succeeded. It reports the previous generation
closed/quiescent with 189 uplink frames and zero uplink drops, restart incidents,
send deferrals, protocol failures, queued downlink, or active provider. This is
worker readiness, not physical acceptance: flashing the prepared profile-3
StackChan image still needs the CoreS3 to be placed in its ROM loader once.

## 04:05 — current userspace worker installed and cold-build timeout attributed

The dedicated StackChan production project
`prj_0363ecd53eda492e972b07debd56eb46` now has the reconciled Grok worker
source at config-repo commit
`a2f921b2336aeeb8acff9c320c320c5635b7ec51`. The installer changed only its
18 `apps/kit-voice/**` runtime files, retained the egress-pinned xAI secret,
selected Grok mode, and deliberately aborted the old dynamic-worker
incarnation. This is a deployment checkpoint, not a physical audio pass.

The first read-only incident query reported `pcmMetrics()` missing its 5 s
diagnostic budget while the independent device capability and repo log were
healthy. That result is now attributed rather than normalized. Cloudflare
trace `0a768410f874245931cb110aa5bd402b` shows the first access cold-building the
new dynamic worker successfully: the OS build-coordinator span ran for
3,192 ms and its worker-bundler `createWorker` span ran for 1,485 ms. The warm
direct `pcmMetrics()` call then completed normally. Trace dashboard:
<https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/0a768410f874245931cb110aa5bd402b>.

The returned retained generation is closed and quiescent, as required before
flashing: 189 uplink frames, zero uplink drops, zero restart incidents, zero
send deferrals, zero protocol failures, no queued downlink, and no active
provider. Its last device sample had 6,923,300 bytes free heap, 23,051 bytes
free internal heap, and an uplink application high-water of one 640-byte
frame. The contemporaneous control capability reported -40 dBm RSSI with no
send, receive, protocol, PCM transport, or WebSocket write failures. These are
old-firmware/control-plane readiness facts only; profile-3 AEC still requires
the prepared physical flash and a fresh network-valid waveform run.

## 03:58 — adversarial review reconciled; proof clocks and startup policy hardened

The consolidated Codex + Claude Fable/xhigh review at
`apps/kit/docs/audio-adversarial-review-2026-08-03.md` was read in full and is
intentionally retained. Its claims were checked against newer source rather
than used as a patch list. The current tree already closes release receipts,
hardware-played Grok truncation, automatic-VAD timeout retirement, greeting
interruptibility, provider-generation EOS fencing, StackChan oracle gain/reset
semantics, exact-TX capture coupling, and HAVPE lifetime timing maxima.

Two additional review findings were reproduced red and fixed. Firmware's
startup freshness policy could remain permanently at `N - 1` stale slots when
frames trickled across scan-budget boundaries; the shared playback owner now
retains bounded scan authorization until the first current frame, with 87/87
native tests passing. The worker's 8/12/32 source-readiness policies are now
executable through the public provider/device WebSocket seam and the selected
value is exported in session metrics. Production remains at 32 because a clean
run created that reservoir in 132 ms and its retained half covers a measured
203.28 ms provider gap; the smaller values have not won a physical continuity
A/B.

The opt-in AEC PCM recorder also used `Date.now()` as its cadence clock. A
backward wall-clock correction therefore disabled the observer and destroyed
otherwise valid proof. Schema 3 now retains epoch timestamps for router/device
correlation but uses explicit monotonic boundaries for duration, arrival span,
and maximum-gap gates. Red-then-green tests include a wall clock stepping from
1005 ms back to 995 ms while the monotonic audio cadence remains exact.

The complete Kit checkpoint passes 96 test files and 759 runnable tests, with
only the explicitly live tunnel test skipped; typecheck and scoped formatting
also pass. The prepared StackChan profile-3/18-dB image remains blocked only on
physical ROM entry. Its standard flash plan preserves the provisioned
`iterate_kit` partition at `0x510000`; two elapsed no-reset identity probes
received no loader bytes and wrote nothing. The required action remains one
bottom-RST hold for about three seconds until the green LED. The Waveshare
AMOLED remains untouched.

## 18:36 — current StackChan AEC is not an acceptance pass

The shared six-phase production-shaped AEC harness ran through the deployed
`/pcm` route and restored the project to real Grok mode afterwards. Durable
evidence is in
`apps/kit/evidence/stackchan-production-aec-waveform-current-20260803/2026-08-03T17-36-50-652Z`.

- Digital transport passed: the socket remained open, there were no device
  restarts or frame drops, and byte accounting was exact (1,772,800 bytes up;
  1,152,000 bytes down).
- The acoustic/DSP gate failed. Far-only PRBS31 (-42.24 dBFS) and
  speech-shaped playback (-44.43 dBFS) passed, but the far-only tone leaked at
  -32.28 dBFS and double-talk degraded from 0.974 repeated-near similarity to
  0.818. The double-talk residual relative to the near source was -8.02 dB.
- Near-only speech was retained (+18.47 dB above ambient), so this is not a
  blanket speaker-active mute result. The remaining defect is selective
  far-end residual plus real double-talk damage in the current ESP-SR VOIP
  configuration.
- The interval is network-invalid because a correlated ~147 ms RTT spike hit
  router, device, and worker together (with additional router spikes of
  93.7/74.7/59.3 ms). RSSI remained excellent (-44..-39 dBm) and the link did
  not reconnect. This invalidates the cadence observation; it does **not**
  excuse the independently measured AEC failures.

The production project is back in Grok mode (`projectModeRestored: true`). No
threshold was relaxed and no far-end gate/mute was introduced.

## 18:02 — resumed the full three-device goal after the greeting correction

All four USB Serial/JTAG identities are present. Current ports are observations
only; every disruptive action must resolve the ROM MAC again immediately before
opening the port:

| Device             | Stable ROM MAC      | Current port            | Action                                 |
| ------------------ | ------------------- | ----------------------- | -------------------------------------- |
| StackChan / CoreS3 | `68:EE:8F:D8:53:20` | `/dev/cu.usbmodem2101`  | in scope                               |
| M5StickS3          | `70:04:1D:D5:45:88` | `/dev/cu.usbmodem11301` | in scope                               |
| HAVPE              | `D8:3B:DA:46:20:34` | `/dev/cu.usbmodem11101` | in scope                               |
| Waveshare AMOLED   | `1C:DB:D4:7A:16:C8` | `/dev/cu.usbmodem11201` | **denylisted: never flash/open/reset** |

The exact StackChan `Hey pal.` production replay retained 121/121 microphone
frames with no clipping and produced the natural reply `Hey there! How can I
help you today?`; the first response event followed Grok speech-stop by 392 ms.
That proves the short-greeting/VAD-tail correction, not full voice acceptance.
The following combined run remained network-invalid and exposed physical
playback-reset/discard and acoustic-level failures, so StackChan AEC and
long-form playout remain the immediate open gate.

The next experiment must distinguish three signals on one aligned timeline:

1. speaker-only playback: post-AEC uplink must be semantically empty;
2. near-only Mac speech: post-AEC uplink must preserve the prompted phrase; and
3. simultaneous speaker + Mac speech: uplink must retain the Mac phrase while
   rejecting the correlated device speaker, and Grok VAD must interrupt.

No speaker-active mute, scalar amplitude gate, higher VAD threshold, or queued
microphone history can count as AEC. The same device-independent assessment and
provider seam must run against StackChan and HAVPE; only capture/playout and UI
drivers may differ.

## Final gate for this campaign

Each freshly restarted physical device must be remotely controllable from the
Mac and audibly/transcript-verifiably complete all of these over its deployed
Iterate userspace `/pcm` path:

- UI exposes connection/call/listen/speak/error state and physical controls;
- StackChan and M5StickS3 render their talking avatar plus the shared compact
  light-ring grammar; HAVPE renders the same facts on its real ring;
- M5StickS3 uses PTT; StackChan and HAVPE use continuous server VAD with local
  AEC that passes speaker-only, near-only and simultaneous double-talk tests;
- count 1–100 with every number present in the independent Mac capture;
- continue 100–200 and 200–300; start 300–400 and prove bounded interruption;
- sustain many back-and-forth turns without reconnect, heap/frame drift,
  accumulating delay, clipping, underrun, reset, brownout or unexplained loss;
- retain provider events/transcripts, acoustic audio, device PCM/accounting,
  memory/CPU/compiled size, and interval-aligned network classification.

The goal remains active until all three devices satisfy every applicable gate.

# 2026-08-03 18:58 UTC — repeated “Hey pal” incident landed

The latest StackChan report was not a Wi-Fi or frame-loss incident. Retained
production metrics showed a healthy -41 dBm link, no PCM transport error, and
complete downlink conservation. The exact accepted device PCM independently
transcribed as `Hey, pal!`, while Grok Realtime revised it to `PayPal.`. A
production instruction regression now makes any one-or-two-word first turn a
neutral opening and prevents the optional sprite tool from interpreting words
such as `play`. Five exact-byte provider replays passed before deployment.

Production config commit:
`86d9d40fd8c5b9cc36726a0ec4af469e71b99bcf`.

Physical evidence:
`evidence/stackchan-grok-uplink-incident-20260803/2026-08-03T18-58-31-078Z/`.
The response was `Hey! How can I help?`; first provider PCM followed VAD stop
by 623 ms, the device capacity receipt followed by another 126 ms, and all
77 ordered downlink items drained with no queue, in-flight item, or drop left.
The harness now has a tested terminal fence and cannot hang up merely because
xAI emitted `response.done` while speaker-bound audio remains queued.

## 2026-08-04 03:38 UTC — metrics polling exposed a platform lifecycle defect

A controlled production experiment separated a real platform reset from the
audio pipeline. The M5StickS3 had one healthy boot-warm `/pcm` socket
(`9` lifetime connections, `8` disconnects). Calling the userspace worker's
read-only `pcmMetrics()` capability once closed that socket, advanced the
device to `9/9`, and caused its bounded reconnect to recover at `10/9`. The
same one-call experiment reproduced a second time.

Cloudflare trace `967bccb43154e736917d99b252d4523d` places the
`dynamic_worker.stateful.call` at `03:38:57.361Z–03:38:58.313Z`; the worker
session's durable `endedAtMs` is `03:38:58.294Z`, inside that call. Trace
`bd2a3e620f21ec124c565d722b69657c` then records the replacement
`dynamic_worker.stateful.fetch` at `03:39:02.318Z`. Device TLS error `0x8008`
is ESP-IDF's `ESP_ERR_ESP_TLS_TCP_CLOSED_FIN`: a peer FIN with `errno == 0`,
not a Wi-Fi, certificate, or handshake failure.

The defect was already fixed on this branch by retaining WebSocket ownership
at the outer `StatefulWorkerDurableObject` and relaying frames to the child
facet. Without that retention, Cloudflare may evict the apparently idle outer
object while the facet's socket remains live; the next RPC creates a new outer
incarnation and retires the old facet, silently cutting off `/pcm`.

The fix was deployed to isolated `preview_17` as OS version
`554a3f78-aa25-4edb-9df0-594bf26d40bb`. Its deployed-only regression waited
150 seconds beyond the outer-DO eviction window, invoked a read-only capability,
then proved that the original socket still had the identical facet generation
and echoed an exact 640-byte binary PCM-shaped frame. It passed in 169.064 s.

The same relay reached production at `2026-08-04T03:55Z` as OS version
`9f136599-2b8a-408c-91cb-dd7e10f1a319`. To avoid deploying the feature branch's
53-commit lag behind `origin/main`, the production build used a clean detached
worktree at main commit `67290ad2fc23df69a2492f46ccd40bc0706c904e`
with only `stateful-worker-durable-object.ts` patched; that source was
byte-identical to the preview-tested branch source. This was an uncommitted
one-file deployment checkpoint, not a merge, commit, or PR. All deployment
smokes passed. The release tool therefore labels the release with the main
commit even though the recorded one-file patch was also present.

The real production Stick regression at `2026-08-04T03:58:36Z` then sampled
the mounted device, called `pcmMetrics()`, waited three seconds, and sampled it
again. Before and after were identical at one PCM connection, zero PCM
disconnects, zero PCM errors, and zero PCM transport incidents. Control also
remained at one connection, zero disconnects, and zero errors; Wi-Fi remained
connected at -45 dBm. Userspace returned the same open session
`6e1c668b-7fff-4afd-ae6a-bf4cf62c598d` with no recorded socket close. This is
the production-shaped proof that metrics observation no longer destroys the
lane it observes.

Consequences for evidence classification:

- any physical run whose `/pcm` close aligns with a harness worker-metrics RPC
  on the old production OS is **platform-lifecycle-invalid**, not evidence of
  an audio queue, provider ping/pong, AEC, or Wi-Fi failure;
- the provider ping/pong path is independently healthy (17 received and 17
  returned in the final warm session, with zero provider-send failures);
- metrics polling remains a required proof seam and must not be disabled as a
  workaround; the proven relay is now in production and physical acceptance
  may resume with metrics polling enabled;
- independently measured AEC and acoustic failures remain failures. This
  classification does not relax or supersede any audio threshold.

## 2026-08-04 03:59–04:03 UTC — post-fix Stick voice evidence

The first physical run after the production lifecycle deployment is retained
at
`evidence/m5sticks3-production-post-lifecycle-fix-20260804/2026-08-04T03-59-41-927Z/`.
It passed end to end and was automatically classified `valid`. The existing
warm `/pcm` session survived call start, remote PTT, a real
`grok-voice-think-fast-2.0` turn, the `changeSpriteSet` tool call through
userspace `env.ITX`, complete physical playback, call hang-up, and all harness
metrics reads. Provider-ready latency from conversation start was 919 ms. The
independent Mac-microphone transcription exactly matched Grok's retained
output transcript: `The Game Boy face is active and the zebra is awake.`

Digital accounting was exact: 801 microphone frames sent and received, 164
downlink frames accepted/submitted/completed, and zero audio drops, failures,
flushes, protocol failures, uplink restarts, Wi-Fi disconnects, or PCM/control
WebSocket disconnects. Heap moved from 8,314,540 to 8,314,432 bytes; retained
minimum heap did not move. The acoustic result uses the previously documented
provisional low-volume independent-STT gate; the stricter fixed-level acoustic
gate remains a follow-up and no transport or network threshold changed.

Two subsequent three-turn runs each completed all three real Grok turns on the
same warm session with exact per-turn playback and no accumulating queue or
heap drift, but both overall artifacts correctly remain `network-invalid`:

- `evidence/m5sticks3-production-post-lifecycle-fix-multiturn-20260804/2026-08-04T04-01-03-237Z/`
  observed one router RTT of 54.036 ms against the unchanged 50 ms ceiling;
- `evidence/m5sticks3-production-post-lifecycle-fix-multiturn-rerun-20260804/2026-08-04T04-02-40-722Z/`
  observed two aligned host-side/Wi-Fi intervals: device/router/worker all rose
  together to roughly 80–85 ms, then recovered the next second.

The second three-turn run conserved 1,815 uplink frames and 452 downlink frames
with zero drops, flushes, reconnects, or protocol failures and retained the
three exact provider transcripts. That is useful transport evidence, but it is
not promoted to the clean multi-turn acceptance run. The network-invalid
classification remains authoritative until a separate multi-turn interval
passes the unchanged network oracle.
