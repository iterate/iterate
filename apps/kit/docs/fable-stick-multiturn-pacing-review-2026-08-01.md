# M5StickS3 multi-turn pacing review — 2026-08-01

Independent adversarial review of the production-shaped M5StickS3 voice path
against the goal: prolonged multi-turn manual-PTT conversations through the
deployed userspace `/pcm` worker and real `grok-voice-think-fast-2.0`, with
bounded latency, no accumulating backlog, exact loss accounting, and no
unexplained disconnects. Prompt:
[fable-stick-multiturn-pacing-review-prompt-2026-08-01.md](fable-stick-multiturn-pacing-review-prompt-2026-08-01.md).
No implementation code was changed by this review.

## Reviewed state (important — the tree was moving during review)

This worktree was being actively edited while the review ran. The prompt
describes a pacer that "restarts its grid after a whole-frame timer miss";
during the review that code was replaced in the working tree by a bounded
catch-up implementation, the device lead was raised 8 → 12 frames, pacing
metrics were added, and a third physical run
(`m5sticks3-long-story-pacing-fixed-2026-08-01`) appeared. The review therefore
covers **both** the deployed-at-evidence-time behavior and the current
uncommitted implementation.

Pinned state reviewed:

- HEAD `6cd541cfc`, plus uncommitted changes.
- `src/userspace/config-worker/pcm-proxy.ts` sha1 `1b1a1c86…` (1,841 lines,
  contains `planBoundedPcmAdmission`, `DEVICE_INITIAL_LEAD_FRAMES = 12`).
- `src/userspace/config-worker/pcm-proxy.test.ts` sha1 `c8bc0ea1…` — all 38
  bridge/pacer tests pass on this state.
- Line numbers below are against these files and will drift.

## Verdict, in one paragraph

The audio path is in materially better shape than the prompt assumes. The
68-second run's harness "failure" was a **harness contract bug, not an audio
failure** (§2.1). The operative cause of the remaining playback underruns is
**delivery-path jitter between the worker's send and the device's receive, not
userspace scheduler stalls** — proven by the newest run, which recorded zero
pacing lateness while the device still saw a 170 ms gap (§1.3). Bounded
catch-up (now implemented) is correct and worth keeping as insurance, but the
knob that actually fixes the observed underruns is the device lead raise
8 → 12 frames, which is close to free (§4). One composed-system defect is worth
fixing before long-run soak: the userspace overrun discard and the firmware's
recovery-silence debt can double-drop and, for stalls beyond roughly 400 ms,
degenerate into silence for the rest of the response (§3.3). The fastest path
to the milestone is: fix the harness turn-1 tool clause, land the current
uncommitted pacing work, soften the two remaining session-terminal egress
edges, and re-run the long-story proof (§8).

---

## 1. What the physical evidence shows

Three instrumented runs on the same device/project
(`kit-stick-voice-e2e-20260731`, host RSSI −70…−72 dBm, Wi-Fi power save
disabled in firmware, zero Wi-Fi disconnects in all runs), plus two aborted
preflights.

| | red 18:09Z | fixed 18:29Z | pacing 18:45Z |
|---|---|---|---|
| Userspace reservoir | ~8 s (256 KiB era) | 60 s | 60 s |
| Pacer | restart-grid, lead 8 | restart-grid, lead 8 | **catch-up + metrics**, lead 8 |
| Story audio synthesized | ≥10 s of ~30 s ask | 68.06 s in **11.08 s** (~6.1×) | 56.88 s in **8.66 s** (~6.6×) |
| Reservoir high-water | 254,714 B (overflowed) | 1,836,872 B (~57.4 s) | 1,556,100 B (~48.6 s) |
| Downlink dropped (userspace) | 288,138 B (~9.0 s) | 0 | 0 |
| Device frames accepted/submitted/completed | 145 sent; 97/93/89 at close | 3464/3460/3460 | 2900/2893/2893 |
| Underrun incidents / silence / late-dropped | 0/0/0 (died first) | 2 / 4 / 4 (80 ms) | 5 / 7 / 7 (140 ms) |
| Max device downlink interarrival | 40 ms | **160 ms** | **170 ms** |
| Max receive→DMA-start age | 156 ms | 167 ms | 185 ms |
| Userspace pacing lateness/catch-up/overrun | n/a (not measured) | n/a (not measured) | **0 / 0 / 0** |
| Provider disconnects / retirements | 0 / 0 (then retire-close 4000) | 0 / 0, pings 11/11 | 0 / 0 |
| Uplink | 379 sent, **32 dropped**, 44-deep send deferrals, 547 ms transport-accept stall | 404/404, high-water 1, zero deferrals | 404/404, zero drops |
| Outcome | real reservoir overflow, close 4000 | harness timeout (§2.1) | harness timeout (§2.1) |

Two additional runs in the `fixed` directory (18:19Z, 18:24Z) aborted before
any call: "Timed out waiting for one stable warm device PCM lane before call
start." Consecutive-run warm-lane handoff is flaky and cost two attempts; the
device diagnostics show the previous session's `/pcm` socket dying with 1006
between runs.

### 1.1 The red run's diagnosis was correct

EVIDENCE. The 8-second reservoir filled after ~10 s of a ~6×-realtime
synthesis burst; userspace closed the device socket with 4000 after dropping
9.0 s of response audio. The 60 s reservoir plus retire-only-the-generation
repair is proven by the two later runs: a complete 68.06 s answer was retained
with `providerRetirements 0`, `downlinkDroppedBytes 0`, and no socket churn.
The sizing comment in `pcm-proxy.ts` (3,000 frames) matches the observed ~6×
synthesis rate with ample margin (a 60 s reservoir at 6× tolerates answers of
~72 s before retire; observed answers were 57–68 s).

Separately, the red run shows an **uplink** Wi-Fi/backpressure event unrelated
to the reservoir: 44 consecutive send deferrals, a 547 ms transport-accept
stall, one `producer_backpressure` restart discarding 31 frames (620 ms of the
user's speech). The two later runs, minutes apart on the same radio, had
flawless uplink. INFERENCE: this is environmental radio variance, and it sets
the realistic disturbance scale this path must survive — **sub-second stalls
happen on this Wi-Fi even when everything is healthy**.

### 1.2 The 68-second run: the audio path did its job

EVIDENCE. Greeting (60 frames) and story (3,404 frames = 68.08 s) both
completed; the device consumed 3,464 frames, submitted+completed 3,460, and
substituted exactly 4 recovery-silence frames for 4 late-dropped content
frames (the firmware's one-silence/one-drop equality held exactly). Both
responses reached their end-of-stream boundary on the device
(`endOfStreamResponses 2` in the terminal snapshot). No lane dropped anything.
The provider connection stayed up with 11/11 keepalive ping/pong.

The provider timeline is decisive for starvation analysis: the story's
`response.created` arrived at +11.935 s and `response.done` at +23.019 s —
after that, only 10-second pings. The entire 57.7 s tail of playout ran from a
full userspace reservoir. Neither underrun can be source starvation.

### 1.3 The newest run settles attribution: the gaps are not worker stalls

EVIDENCE. The 18:45Z run carried the new pacing metrics. Across ~58 s of paced
sending, `downlinkPacingCatchUpIncidents = 0`, `downlinkPacingMaximumLatenessMs
= 0`, `downlinkPacingOverrunFrames = 0` — the worker hit every 20 ms deadline.
The device nevertheless measured a 170 ms maximum interarrival and five
underrun incidents. The gap therefore formed **after** the worker's send:
Cloudflare egress, TCP retransmission on a −70 dBm radio, or device-side
receive scheduling. INFERENCE (strong): the 18:29Z run's 160 ms gap has the
same cause; the same workload showed zero worker lateness 16 minutes later.

Consequence: the prompt's central hypothesis — that `nextPcmFrameDeadline()`
restarting its grid "permanently spending the lead" caused the incidents — is
**not what happened in these runs**. The restart-grid defect was real but
latent: it never engaged, because the timer was never a whole frame late. The
underruns are explained by ~170 ms of delivery jitter against a 160 ms
(8-frame) lead — the lead was one frame too short, which is exactly what the
uncommitted lead raise fixes.

### 1.4 Why both "failed" runs actually timed out (harness bug)

EVIDENCE, established by replaying the archived terminal snapshot through the
harness's own predicate helpers (`parseKitMetricsCallback`,
`devicePlaybackCompleted`): every audio/device/provider clause of the turn-1
terminal predicate **passes** on the archived `lastObservedMetrics` of the
18:29Z run. The boundary was reached ≈20 s before the 90 s deadline. The one
clause that can never pass is:

```
!requiresDeviceTool || metrics.providerFunctionCalls > baseline.providerFunctionCalls
```

`productionGrokTurnRequiresDeviceTool(turn)` returns `turn === 1`
(`src/device/production-grok-turn-policy.ts:13`) — turn 1 **always** demands a
`changeColour` function call. The long-story phrase override elicits a story;
Grok never calls the tool (`providerFunctionCalls 0` in both snapshots); the
predicate stays false; the wait burns its full 90 s and reports
`ProductionPcmWaitTimeoutError`. Three of the day's five run attempts were
consumed by harness contract issues (this one twice, warm-lane twice), zero by
the audio path after the reservoir fix. **Fixing the scenario/tool coupling is
the single highest-leverage change for time-to-goal.**

---

## 2. Corrections to current reasoning

1. **"Timed out waiting for the Grok response and device playback boundary" ≠
   audio failure.** §1.4. The prompt treats the 18:29Z run as partially failed;
   as an audio artifact it is a pass with two 2-frame blemishes.
2. **The scheduler-stall framing over-indexed on the worker.** §1.3. Bounded
   catch-up is still right to have (workerd isolates *can* stall; nothing in
   these three runs proves they never will), but it is insurance, not the fix
   for the observed 160–170 ms gaps. Any design work that only repairs
   userspace pacing would have left the underruns in place.
3. **"Detailed playback moved … to 3464/3460/3460" reads as loss but is exact
   accounting working.** 3,464 accepted = 3,460 submitted + 4 flushed; 4
   flushed = 4 recovery silences = 80 ms substituted, all counted. The
   firmware's no-backlog invariant (silence count == late-drop count) held in
   both runs (4:4, 7:7).
4. **The prompt's uplink first-frame concern is already covered.** The
   two-socket ordering defect (turn-two first frame beating
   `pushToTalk.started`) has a faithful regression at
   `pcm-proxy.test.ts` ("does not drop the first PCM frame when the next PTT
   control edge arrives later"), which exercises the *harder* ordering (END₁
   and FRAME₂ both beating STOP₁) with monotonic count reconciliation.
5. One smaller misread to retire: the policy header's claim that "the host
   fault rig tests the exact target policy" is currently false — the rig pins
   its own `maximumFrameAgeMs = 200U` (`firmware/tests/realtime_playback_test.cpp:41`)
   while the production policy is 400 ms
   (`m5sticks3_realtime_audio_policy.hpp:28`). Drift-by-copy is exactly what
   that header exists to prevent.

---

## 3. Q1 — bounded deadline catch-up in userspace

### 3.1 Is it the right repair? Yes — with the corrected role

For **worker-side** stalls (armed timer serviced late while the reservoir holds
frames), bounded catch-up is the only correct repair: the frames exist, the
device can absorb up to the already-proven lead burst, and restarting the grid
would convert one stall into a permanently spent lead (every subsequent ≥20 ms
jitter becomes an underrun). For **source starvation** (reservoir empty), a
fresh grid with no burst is correct: there was no armed obligation, and
bursting later provider output would move provider latency into the device.
For **network** stalls (§1.3), catch-up does nothing — the frames were already
sent — and only device-side lead absorbs the gap.

### 3.2 The implemented algorithm is the exact one I would specify

`planBoundedPcmAdmission(currentDeadline, now, frame, maxBurst)`
(`pcm-proxy.ts:1816`):

- `latenessMs = max(0, now − deadline)`; `framesDue = 1 + ⌊lateness/20⌋`;
  `framesToSend = min(framesDue, lead)`; `nextDeadline = deadline +
  framesDue×20` (original absolute grid preserved — no drift, sub-frame slips
  repaid); `overrun = framesDue − framesToSend`.
- Starvation is distinguished *structurally*, not heuristically: when the ring
  has no complete frame and the response is not done, `#scheduleDownlink` sets
  `#nextDownlinkAt = 0` (`pcm-proxy.ts:1384-1392`), so the next enqueue takes
  the `deadline ≤ 0` branch — one frame, fresh grid, no invented catch-up.
  This is precisely "a delayed timer with a full source reservoir" (armed
  deadline in the past) vs "genuine provider-source starvation" (no armed
  deadline). Correct.
- The burst ceiling equals the startup lead — the same burst size the device
  demonstrably absorbs at every response start, and 12 « the firmware's
  32-frame/640 ms lane, so a catch-up burst cannot overflow the device.
  Post-burst frame age ≈ lead×20 ≈ 240 ms < the 400 ms freshness bound.
- New metrics (`downlinkPacingCatchUpFrames/Incidents`,
  `downlinkPacingMaximumLatenessMs`, `downlinkPacingOverrunFrames`, diagnostic
  `downlink-pacing-overrun` — notably **non-terminal**) close the attribution
  gap that made §1.3 impossible to establish for the earlier runs. This is the
  most valuable part of the change: worker-clock truth at the send boundary,
  device-clock truth at the receive boundary, disagreement = network.

Three bridge-level tests pin the three regimes (restore-lead, overrun-discard,
fresh-grid-after-dry) using a deliberate `performance.now` skew so the callback
observes real lateness under fake timers. They pass on the pinned state.

### 3.3 CONFIRMED-by-derivation defect: overrun discard composes badly with firmware recovery debt

This is the one place the new userspace policy and the existing firmware
policy implement the *same* idea twice and can fight. Derived from code, not
reproduced on hardware — treat as PLAUSIBLE-high until the composed rig test
(§7) runs.

Mechanism. During a sender-side stall longer than the lead, the firmware
starves, writes one recovery-silence frame per 20 ms slot, and records an equal
**drop debt**: "TCP preserves order — the next content frames are the expired
slots' frames — discard exactly that many"
(`realtime_playback.hpp:1141-1232`). The new userspace overrun path *also*
discards the elapsed frames (`pcm-proxy.ts:1419-1448`) and then sends current
audio. The firmware cannot tell current from stale (frame age restarts at
device receive), so its debt discards up to `debt` frames of **current**
speech: for a stall of S ms, total loss ≈ 2×(S−lead)/20 frames instead of
(S−lead)/20.

Worse, for S ≳ lead + burst (~400 ms at lead 12): the burst (≤12 frames) pays
at most 12 debt; while debt remains positive the firmware keeps substituting
silence (content submission is gated on `recoveryDropDebt_ == 0`) and pays
debt at ≈1 frame per 20 ms against arrivals of 1 frame per 20 ms — a
**net-zero treadmill that can hold the response in silence until its END
marker** (the fault rig's own test name "endOfStreamClosesUnpayableRecoveryDebt"
acknowledges unpayable debt exists; nothing bounds it mid-response). Evidence
that recovery works *today* (4:4, 7:7 paid promptly) is consistent: those were
network gaps, where the worker kept sending on-grid during the gap and TCP
redelivered the backlog as a burst that out-ran the debt.

Fix (small, firmware-local, keeps every invariant): **cap the debt**. When
`recoveryDropDebt_` would exceed a bound (e.g. `2 × DmaFrameCount`, or the
lead), stop substituting and take the existing `resetAfterUnderrun()` path —
one classified rebuffer, debt cleared, resume from whatever arrives next. That
converts a long stall into one bounded gap instead of an unbounded silence
tail, and it makes the userspace overrun discard *harmless* (the double-drop
shrinks to ≤ debt-cap frames). Alternative — dropping the userspace overrun
discard and letting firmware debt own all beyond-lead loss — is worse: it
reintroduces the treadmill for worker stalls (post-stall delivery is exactly
1-in-1-out) and leaves permanent delay if debt under-counts. Keep the
userspace discard; bound the firmware debt.

### 3.4 Residual gap in the repair

Catch-up assumes `performance.now()` and `setTimeout` share a clock domain in
workerd and that a late callback *observes* its lateness. The new tests mock
the skew; nothing yet demonstrates it live (§7, test 1).

---

## 4. Q2 — device lead and DMA descriptors

**The lead raise is necessary; more DMA descriptors are not.**

The observed disturbance is 160–170 ms of delivery jitter with a full
reservoir and an on-time sender (§1.3). Only device-side buffering absorbs
that. The knobs:

| Knob | Effect | Cost | Verdict |
|---|---|---|---|
| Lead 8 → 12 frames (160 → 240 ms) | Absorbs the observed 170 ms with ~70 ms margin | Zero device RAM (frames sit in the existing 32-frame/640 ms lane); steady receive→DMA age rises ~160 → ~240 ms, still 160 ms under the 400 ms freshness bound; +80 ms more discarded on barge-in (already exact-counted); no first-audio latency change (priming is a burst) | **Do it** (already in tree) |
| Lead beyond ~16 | More absorption | Age ~320 ms leaves only ~80 ms freshness margin → false whole-epoch resets; needs `maximumFrameAgeMs` raised, which raises worst-case staleness everywhere | Don't, without new gap evidence |
| DMA descriptors 4 → 8 | +80 ms hardware absorption | +5,120 B **internal DMA-capable** RAM (floor ≈70 KB today) + doubles the pre-start fill; duplicates absorption the lane already provides at zero cost; ESP-IDF 5.4.2 contract (verified locally: 4 × 1,280 B, 3-entry finished queue, auto-clear-before-cb silence) is tuned around 4 | **Don't** |
| Userspace catch-up | Repairs worker stalls ≤ burst | Already landed | Keep (insurance + attribution metrics) |

So: increasing device lead is *not* masking a userspace pacing defect — the
18:45Z run proves the pacer was blameless while the device still starved. It is
the correct, nearly-free fix for a measured network-path disturbance. The
firmware's four-descriptor DMA layer performed flawlessly in all three runs
(zero driver failures, overflows, deadline misses; min reuse-lead 19.7 ms in
the worst 40 ms owner-wake excursion).

One coupling to fix while touching constants:
`PCM_SOCKET_BACKLOG_LIMIT_BYTES = 16 × 640` (`worker.ts:42`) is now only 4
frames above the 12-frame prime/catch-up burst. Any lead raise silently eats
this margin, and `#sendDevice` **fails the whole session** when the bound is
crossed. Derive it from the lead (e.g. `(DEVICE_INITIAL_LEAD_FRAMES + 8) ×
FRAME_BYTES`) or static-assert the relationship.

Related robustness cliff (recommend softening, same freshness semantics): a
device-side TCP stall ≥ ~320 ms while paced sends continue trips the
`#sendDevice` backlog guard → terminal 4000 "Device egress could not accept the
current playback frame". The red run demonstrated 547–880 ms radio stalls are
real on this network. The overrun-discard machinery built for pacing is the
right response here too: while `bufferedAmount` exceeds the bound, drop the
elapsed frames from the ring head with a `downlink-pacing-overrun`-style
diagnostic instead of killing the call, and keep terminal failure for the
marker/socket-dead cases. That removes the most likely future "unexplained
disconnect" without adding any invisible queue.

---

## 5. Q3 — the manual-PTT control/media state machine

### 5.1 What it is now (and why it's already near-minimal)

The design principle is sound and hard-won: **the media socket owns every
media fact; the control socket contributes only provenance and one watchdog.**

- Turn start = first non-empty PCM frame after idle (`#beginUplinkTurn`):
  supersedes any uncommitted turn, discards the downlink queue, cancels an
  active response (barge-in by construction). Cap'n Web `started` only
  increments a counter.
- Turn end = zero-length marker, ordered behind all speech on the same socket:
  commit → `input_audio_buffer.committed` → `response.create`. Empty turns
  (marker with no frames) are absorbed, never committed.
- `stopped` before its marker arms one 1.5 s watchdog; reconciliation is by
  monotonic counts (`uplinkControlStops ≤ uplinkEndMarkers` clears), which
  makes every legal cross-socket reordering idempotent — including the nasty
  END₁/FRAME₂-before-STOP₁ interleaving, which has a dedicated regression.
- Provider sockets are disposable generations behind a stable device lane:
  attach fences by identity, `#uplinkFramesInTurn` resets on attach (a new
  generation has an empty input buffer), late events/closes from a superseded
  generation are ignored, and mic frames during a swap are dropped *visibly*
  (`uplinkUnavailableFrames`), never queued.

I attempted to construct a simpler correct machine and failed: removing the
watchdog loses the lost-marker bound; removing the marker loses ordering with
speech; moving turn-start to the control edge reintroduces the first-frame
loss. The simplification opportunities are all *around* the machine, not in it
(§6). The server-VAD half of the class is out of scope here (already landed
for StackChan) and shares the downlink/interruption plumbing; do not split it
for this milestone.

### 5.2 Sharp edges to accept or soften (ranked)

1. **Device-egress backpressure is session-terminal** — soften to
   overrun-drop (§4). Highest product risk on real Wi-Fi.
2. **Marker-timeout is session-terminal** — acceptable: WS is ordered and
   reliable, so a missing marker implies the media socket is dead anyway;
   1.5 s bounds a Grok buffer left open. Keep.
3. **Provider swap mid-press absorbs the turn** (frames sent to the dead
   generation are gone; if none reached the replacement, END commits nothing
   and the press goes unanswered). Visible in `emptyUplinkTurns` +
   `uplinkUnavailableFrames`; freshness-correct (buffering the mic would
   violate the no-mic-queue rule). Accept; the product layer can prompt a
   re-press.

### 5.3 Exact metrics: now sufficient

The union now covers every loss class with an owner: userspace conservation
(`uplink*/downlink*Dropped`, `uplinkUnavailableFrames`, `emptyUplinkTurns`),
boundaries (`uplinkTurns/EndMarkers/ControlStarts/Stops/EndMarkerTimeouts`),
reservoir (`downlinkQueuedBytes/HighWater/Partial`), **pacing (new: catch-up
frames/incidents/max-lateness/overrun)**, provider lifecycle
(connections/disconnects/retirements/responses/keepalives/sendFailures), and
firmware truth (interarrival max/samples, receive→DMA ages, underrun
silence/late-drop equality, freshness/prebuffer/backpressure/EOS counters, per
±layer buffer occupancy with evidence grades). The 18:45Z run demonstrates the
attribution power: pacing zeros + device 170 ms gap = network, no guesswork.
The only addition I'd argue for: count sends skipped/dropped due to device
`bufferedAmount` separately from pacing overrun if §4's softening lands, so
radio stalls and isolate stalls stay distinguishable.

---

## 6. Q4 — deletions and simplifications (time-to-goal ranked)

1. **Decouple the harness tool requirement from the turn number.** Make the
   scenario (phrase) declare whether it requires a device tool;
   `productionGrokTurnRequiresDeviceTool(turn)` keyed on `turn === 1` is what
   turned two clean audio runs into 90-second timeouts (§1.4). Also make the
   boundary wait *progress-aware* (extend while `downlinkFrames` or device
   playback counters advance): a fixed 90 s response budget is one long answer
   away from the same false negative even with the tool clause fixed.
2. **Diagnose the warm-lane preflight flake** (two aborted runs). Likely
   cross-run state: the previous session's device `/pcm` socket died with 1006
   while the new run demanded a stable lane. One retry-with-power-cycle or a
   longer lane-settle budget removes a third of today's run attrition.
3. **Lab/production pacer divergence.** `pcm-frame-pacer.ts`
   (`nextPcmFrameDeadline`, restart-grid) is now semantically different from
   the deployed `planBoundedPcmAdmission`; the lab `DevicePcmProxy` and the
   deterministic provider still use the old policy, so lab runs cannot
   reproduce production pacing behavior. The install mechanism forces
   `pcm-proxy.ts` to stay import-free (verbatim allow-list copy to
   `apps/kit-voice/`, enforced by `install.test.ts`), so sharing means adding
   the planner file to `runtimeSourceNames` — or, cheaper for this milestone,
   porting the planner into `pcm-frame-pacer.ts` and documenting that
   `pcm-proxy.ts` embeds it by contract with a matching unit-test pair.
4. **Wire the firmware fault rig to the real policy header** — it pins
   `maximumFrameAgeMs = 200U` locally while production is 400 ms (§2.5),
   defeating the header's stated purpose and silently halving the staleness
   bound the rig proves.
5. **Derive `PCM_SOCKET_BACKLOG_LIMIT_BYTES` from the lead** (§4).
6. Metric nomenclature: `providerRetirements` vs `providerDisconnects`
   overlap (retire increments both paths' counters via `#detachProvider`).
   Fine to keep — retire is intentional, disconnect is observed — but a
   one-line docstring distinguishing them would prevent the next reviewer's
   double-take. No deletion.

Nothing in the bridge itself earns deletion; its size is mostly load-bearing
accounting, and the recent live edits *removed* the one real duplication (the
private restart-grid copy is gone).

---

## 7. Q5 — red tests that exercise real delay

What exists now is good: the three regime tests skew `performance.now` under
fake timers so a callback genuinely observes lateness — the exact antidote to
"fake timers execute every missed deadline on time". Gaps, in priority order:

1. **Live blocked-event-loop test (no fake timers).** Prime a response, then
   synchronously occupy the loop ~120 ms (busy spin or `Atomics.wait`) past an
   armed deadline; assert one catch-up burst ≤ lead on the real clock pair,
   grid preserved, zero drops. This is the only test that would catch a
   workerd/Node divergence between `setTimeout` servicing and
   `performance.now` — the mocked tests assume the pairing. Mark it a slow
   lane; ~150 ms budget.
2. **Composed sender×firmware rig for §3.3.** Drive
   `RealtimePlayback` (host rig) with a scripted lane feed reproducing: gap of
   G ms → K silences; then (a) stale heads in order (network-stall shape) and
   (b) overrun-discarded current heads after a bounded burst (worker-stall
   shape). Assert total loss ≤ K + burst and — the red assertion today —
   **debt reaches zero within N pumps** for G up to several seconds. This
   fails now for case (b) with G ≳ lead + burst and becomes the regression
   test for the debt cap.
3. **Harness predicate unit test**: a story-phrase turn with the terminal
   predicate must be satisfiable with `providerFunctionCalls = 0` (red today;
   guards §1.4 from regressing when scenarios are added).
4. **Constant-coupling pin**: `PCM_SOCKET_BACKLOG_LIMIT_BYTES ≥
   (DEVICE_INITIAL_LEAD_FRAMES + slack) × frame bytes`, so a future lead bump
   cannot silently create a startup-burst session kill.
5. **Planner edge unit tests** (pure function, one file): lateness exactly one
   frame, lateness ≫ reservoir, `deadline = 0` resume, float-grid drift over
   10⁴ frames. The bridge tests cover the regimes; the planner deserves its
   own table.

---

## 8. Materially different designs, and the recommendation

**A. Worker-clocked open-loop pacing + bounded catch-up + fixed device lead +
firmware silence/debt/freshness** — the current trajectory, including the
uncommitted edits. Two independent bounded buffers (60 s reservoir in the DO,
240 ms lead + 640 ms lane on device), each with exact loss accounting, no
feedback loop, no protocol additions.

**B. Credit-based device-clocked flow control** (device grants send credits on
its own playout clock; worker sends only on credit). Self-tuning to jitter and
kills the open-loop assumption — but adds a protocol surface to `/pcm`, a new
failure mode (credit starvation on a lost control frame), device-side work on
the 20 ms path, and it converts every network stall into sender-visible
backpressure that still needs the same drop-or-delay policy decision. Wrong
trade for one device landing next week.

**C. Adaptive lead** (worker widens/narrows the prime from device-reported
interarrival maxima, which already stream to the worker every ~1 s). Cheap-ish,
but it's a feedback loop with a 1 s stale input chasing a 170 ms phenomenon,
and the static answer (240 ms) currently covers the observed worst case with
margin. Revisit only if evidence shows gaps ≳ 240 ms on healthy runs.

**D. Device-buffered model** (push the whole response to the device as fast as
TCP allows; device paces from PSRAM; delete userspace pacing entirely). The
honest radical alternative — PSRAM could even hold it (8.3 MB free vs 1.9 MB
per minute). Rejected on measured grounds: it floods a −70 dBm radio at 6×
realtime exactly when the uplink needs it (the red run shows concurrent-load
uplink starvation is real), moves the freshness/discard problem onto the
device without the DO's observability, makes barge-in discard and loss
accounting a firmware-only story, and abandons the deliberate 640 ms device
ceiling ("stale conversation must not survive an outage"). It also does
nothing for the actual failure mode (last-170 ms delivery jitter exists at any
transfer rate).

**Recommendation: A**, i.e. land what is in the tree, plus the two bounded
hardenings from this review (firmware debt cap §3.3; device-egress softening
§4), plus the harness fixes (§6.1–6.2). Concretely, for the Stick milestone,
in order:

1. Fix `productionGrokTurnRequiresDeviceTool` coupling + progress-aware
   boundary wait (harness only — unblocks acceptance immediately).
2. Land the uncommitted pacing work (catch-up, lead 12, pacing metrics; tests
   are green on the pinned state) and redeploy the userspace worker.
3. Re-run the long-story proof ×3. Acceptance: `providerRetirements 0`, all
   `*DroppedBytes 0`, pacing counters 0 (or catch-up incidents with zero
   overrun), `underrunIncidents 0` (gaps ≤ 240 ms), silence:late-drop equality
   if any, `providerDisconnects 0`, harness exits on predicate — not timeout.
4. Firmware debt cap → `resetAfterUnderrun` + composed rig test (§7.2).
5. Soften device-egress backpressure to overrun-drop; derive the backlog
   limit from the lead.
6. Fault-rig policy-header wiring; planner unit tests; live blocked-loop test.

Defer beyond the milestone: lab-proxy catch-up port (or accept documented
divergence), adaptive lead, credit-based designs, all StackChan/HAVPE
portability work.

## What this review did not verify

- Whether workerd's device-side `WebSocket.bufferedAmount` is populated in
  production (the guards treat `undefined` as zero; if unpopulated, the
  backlog cliff in §4 cannot fire — and also provides no protection).
- The physical memory bank of the device lane rings (assumed non-DMA-critical;
  only the 5,120 B DMA payload is internal-DMA-bound, verified against ESP-IDF
  v5.4.2 sources).
- §3.3 on hardware — derived from `realtime_playback.hpp` and the new
  userspace discard path; the composed rig test is specified in §7.2 to close
  it.
- Attribution of the 18:29Z run's 160 ms gap is inference from the 18:45Z
  run's measurement (marked in §1.3); the earlier run predates the pacing
  metrics.

— Review executed 2026-08-01 (evening), against pinned state in §Reviewed
state; evidence directories `m5sticks3-long-story-{red,fixed,pacing-fixed}-2026-08-01`.
