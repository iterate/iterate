# Judge — Lens 2: Realtime/embedded soundness (2026-07-31)

Status: adversarial judging artifact, exploration round. Scope: the three
candidates (`arch-a-event-spine.md`, `arch-b-pipeline-purist.md`,
`arch-c-minimal-delta.md`) scored ONLY against realtime and embedded
discipline — capture priority, DMA-owned cadence, processor concurrency
rules, reference-signal correctness, PSRAM/IRAM budgets, allocation-free hot
paths, starvation windows, priority inversions, ISR hygiene — plus two
mandated stress scenarios: a 4 s Wi-Fi outage mid-conversation and a
10-minute endurance run. Complexity, LOC, organizational elegance, and
stream-model fidelity are OTHER judges' lenses; they appear here only where
they buy or cost realtime behavior.

Verification note: every load-bearing v1 claim the candidates share was
re-checked against source before scoring. Confirmed: mic pump on the prio-1
main loop with PTT capture polled first
(`targets/m5sticks3/main/main.cpp:1196-1217`); 2×20 ms recorder buffers
(`platforms/common/include/iterate/kit/platforms/bounded_capture.hpp:46`);
the 1 s cross-task command rendezvous
(`platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp:174`,
`commandAcknowledgementMs = 1'000U`); the self-flagged 1-tick PCM receive
poll AND the retry-gate reset on mere `socket_connected`
(`platforms/iterate_esp_idf/pcm_transport.c:600-618`); IRAM 16,383/16,384
bytes used — one byte free — and **77.8 KiB free internal heap at idle**
(`docs/physical-device-voice-goal.md:347-354`); the single-task,
non-ISR-safe `device_events` marshalling contract
(`components/core/include/iterate/kit/device_events.h:75-86`). All three
candidates cite these accurately. The 222-frames/0-drops physical evidence
(`physical-device-voice-goal.md:338-341`) was collected under light load —
the review's warning that the capture margin is structural, not proven,
stands (review §4.1).

---

## 0. The shared floor (what does NOT differentiate them)

All three candidates adopt the same answers to the two biggest realtime
items, so scores are driven by everything else:

- **R1 (capture priority orphan)**: all three move the mic pump to the
  core-1/prio-19 audio owner on `esp_driver_i2s` PDM RX, with the
  half-duplex fence executing inside the codec impl on the owner task
  (A §4 class-1 table; B §3 class-1 table; C §4.1). All three thereby kill
  the 1 s-rendezvous-gaps-the-mic hazard and the display-SPI hazard.
- **R5 (tick-polls)**: all three replace the PCM receive poll with
  socket-driven wakeup and make capture completion-driven.
- **Frame-path purity**: none of the three puts an allocation, a lock, a
  format call, or an unbounded queue on the 20 ms path. A's spine touches
  audio only via a nonblocking SPSC push at ownership boundaries (§5 row
  addendum: "~100 ns"); B runs the processor inline in the beat with no
  queue between codec and lane (§11 "one buffering boundary per direction
  stays law"); C's copy-out capture is 640 B × 50 Hz = 32 KB/s of memcpy
  (§3.2), identical to B's (B §2.1). All acceptable — a 640 B copy is ~1–2 µs
  at 240 MHz.
- **Retry-ladder fixes** (gate reset on confirmed delivery, retryable
  `pcm_transport_start`, fleet jitter, Wi-Fi backoff on `retry_gate`):
  present in all three (A §5 row 10; B §6 row 10; C §5 row 10).
- **The uplink echo-loop rig scenario** as the physical regression test for
  the R1 fix: all three include it.

Given that floor, the lens question becomes: **what NEW realtime machinery
does each candidate add, how well is its concurrency specified, how honestly
is the AEC future budgeted, and what happens in the two stress scenarios.**

---

## 1. Candidate A — event spine

### 1.1 Strengths under this lens

1. **The PCM lane is constitutionally protected.** §0's honesty clause and
   §1.6's admission-rate law ban per-frame telemetry, per-descriptor
   completions, per-tick anything, and PCM itself from the spine — forever.
   The audio path's only spine duty is a fire-and-forget tributary push at
   ownership boundaries (§1.7 table: per-reconnect / per-press / per-turn /
   per-incident rates). This is the right latency law, stated as law.
2. **Audio never depends on spine liveness.** Publish never blocks, never
   fails (§1.2 admission rule 1); a wedged main task cannot back-pressure
   the audio owner (§10.3 owns this explicitly). The dependency arrow
   (`audio` depends on `spine`, never the reverse — §2 dependency law) is
   the correct direction.
3. **RAM stated honestly, to the byte**: spine 4,096 B + tributaries
   2,048 B + side-slot 1,280 B ≈ +6.8 KiB net internal (§1.2). Nobody
   discovers it in `sizeof(Runtime)`.
4. **The tributary is the right formalization** of the marshalling rule v1
   already imposes prose-only (`device_events.h:80-85` — verified: "Platforms
   must first marshal ISR/cross-core edges onto the owner task"). Making the
   ISR→SPSC→owner idiom (already proven by the EOF path,
   `m5sticks3_direct_audio.hpp:33-37`) a single audited module is exactly
   the concurrency-discipline consolidation R8 wants.
5. Boundary events give the degraded-mode matrix and `route-applied
{elapsed_us}` (§1.7) — button-to-capture becomes a _measured_ interval.
   Good observability of the realtime path without touching it.

### 1.2 Weaknesses under this lens (the adversarial part)

1. **Spine liveness = prio-1 main-task health on the most contended core,
   and the doc knows it (§10.3) but underprices the outage case.** The main
   task sits at prio 1 on core 0 beneath control net (5), PCM net (6), lwIP
   (18), and Wi-Fi (23). During reconnect churn — the exact moment the
   spine should be recording `wifi-lost`/`pcm-lost`/incident history — TLS
   handshake bursts starve admission. Tributaries are 8 slots each (§1.2
   diagram). A 4 s outage mid-conversation produces, from the audio owner
   alone: `pcm-lost`, peer-guard trip incident, uplink purge incident,
   underrun incident(s), `playback-drained`, then on recovery
   `pcm-connected`, `route-applied`, `capture-started`… — bursts near or
   past 8 before a starved owner drains. Drop-new policy (§3.3) then drops
   the _newest_ edges: a kept `pcm-lost` whose matching `pcm-connected` was
   dropped leaves retained-latest (§1.4) showing a stale "lost" state until
   the next transition. Loss is counted, gap facts fire — but the design's
   own selling point ("what happened while we weren't listening") is
   thinnest precisely in its marquee scenario. v1's four independent
   machines degraded independently; A concentrates the degradation.
2. **The R12 drained-edge is routed through the wrong core at the wrong
   priority.** §1.7: "the audio controller consumes `playback-drained` from
   the spine like any other input." Path: audio owner (core 1, prio 19)
   → tributary → main-task admission (10 ms tick, prio 1, core 0) → handler
   chain on main task → async `request_route` back to the audio owner.
   That is a cross-core round trip through the system's most starvable task
   for a turn-start-latency edge. B detects the same edge locally inside
   the beat loop with zero hops (B §2.3). During post-outage TLS churn the
   mic-open defer in AUTO_STOP could lag by hundreds of ms. Not a
   regression vs v1 (v1 lacks R12), but the worst of the three designs for
   this edge.
3. **Cross-task spine readers are underspecified — a real C11 data race in
   the sketch.** Class 2's SD sink task (core 0, prio 2) holds a cursor
   into a lapped ring whose single writer is the main task (§4 class-2
   table: "SD sink … spine cursor → batcher"). A lapped-ring reader racing
   the writer's overwrite of the slot it is copying needs per-slot
   validation (copy, then re-check the writer's sequence) or it hands the
   SD framer a torn 64-byte record; and `log.h`'s `next_sequence` is a
   plain `uint32_t` documented "single writer: owner task only" (§3.2) yet
   read cross-task by every cursor. The GAP result handles _logical_ laps,
   not _physical_ torn copies. Fixable (seqlock-per-slot or
   copy-and-revalidate), but the candidate that adds the most new
   lock-free machinery specifies this least — in a codebase whose R8 lesson
   is that hand-rolled memory-order code is where the bugs live. Note the
   internal inconsistency: §4 class 2 also mentions a "64 KiB PSRAM
   tributary-to-sink ring" for SD, which is a _different_ topology than
   "spine cursor → batcher" — two designs blended.
4. **New ISR surface with the IRAM question unasked.** The topology diagram
   (§1.2) shows "button GPIO ISR → tributary (ISR-safe, 8 slots)" and
   class 3 gives the VPE dial the ISR-variant tributary — but v1 has no
   button ISR at all (buttons are polled: `main.cpp:1220`
   `takeButtonAChange`). A adds ISR context + a 64 B-record ISR publisher
   to an image with **one byte of IRAM free** and never mentions IRAM. A
   non-IRAM GPIO ISR is functionally legal but is blocked during flash
   writes (NVS boot-epoch writes are now on A's boot path, §1.6) — edge
   timestamps stall exactly then. B and C both state IRAM-delta-zero
   explicitly (B §5.2, C §7.2); A is silent.
5. **The seqlock side-slot adds a third concurrency primitive** (after the
   lapped ring and the tributaries) to carry 1 Hz gauges — honest about the
   teaching cost (§10.6) but under this lens it is one more hand-rolled
   memory-order mechanism whose failure mode (torn sample accepted as
   sample-missed) must be proven, not assumed, cross-core (SD task reads
   it, §1.5).
6. **Internal-RAM posture vs the AEC future.** +6.8 KiB internal against
   77.8 KiB free internal heap at idle (`physical-device-voice-goal.md:347`)
   is affordable today — but standalone FD AEC needs ~31 KB internal and
   full AFE 60.2 KB (review §4.5). After full AFE, A's spine machinery
   would occupy ~40 % of the remaining internal headroom. A schedules R4
   but takes no position on this composition; the number deserves to be in
   §1.2 and is not.
7. **The spine does not advance a single realtime property** — §10.9 says
   so itself. Under this lens A is a large, mostly-orthogonal bet that
   _consumes the team's risk budget_ (its M3/M4 rewires touch the control
   plane's correctness core) without buying capture, cadence, AEC, or
   budget headroom. Its AEC story is one line ("+1,000 later") with none of
   B's chunk-size, reference-tap, or per-stage-budget design.

### 1.3 Stress scenarios

- **4 s Wi-Fi outage mid-conversation**: audio behavior identical to the
  shared floor (epoch purge, capture-age ceiling, underrun silence,
  generation fence — all verbatim v1). New failure surface: event history
  thins (weakness 1), drained-edge/mic-open sluggish during recovery churn
  (weakness 2). SD record of the outage — the feature's raison d'être — is
  the part most at risk. Grade: audio unharmed, observability degraded
  when it matters most.
- **10 min endurance**: spine at ~1–2 events/s (metrics-sampled 1 Hz +
  incidents) laps a 64-slot ring every ~32–64 s; all sinks keep up
  trivially; seqlock writer at 1 Hz. No endurance hazard beyond v1.
  Admission-rate law is "discipline, not mechanism" (§10.4, its own words) —
  the first chatty producer added in v2.1 blinds a sink mid-run and only
  drop counters notice.

**Score: 5.5/10.** Realtime-neutral centerpiece, correctly firewalled from
the frame path, but it adds the most new lock-free machinery with the least
concurrency specification, concentrates event liveness on the most starvable
task, routes a turn-latency edge through that task, opens an ISR/IRAM
question it never asks, and spends the whole risk budget on things this lens
doesn't score.

---

## 2. Candidate B — pipeline purist

### 2.1 Strengths under this lens

1. **It is the only candidate designed _from_ the prior-art realtime
   lessons rather than merely patching toward them.** The priority ladder
   (audio 19 > PCM net 6 > control 5 > UI 1, §3), DMA-owned cadence as the
   organizing rule (§0.2), the snapshot pattern (read per-frame-mutable
   atomics once per beat, §2.3, esphome `audio_pipeline.cpp:790-816`), the
   drain handshake for DSP rebuilds on a dedicated prio-3 task with a
   depth-1 latest-wins queue (§2.2, `esp_aec.cpp:168-187`), fail-closed
   silence (`esp_afe.cpp:1612-1615`), mutation-by-owning-task
   (`afe_audio_engine.cc:317-368`) — every rule this lens judges against is
   a named, load-bearing part of the design with provenance.
2. **Reference-signal correctness is actually designed, not gestured at.**
   Complete-frames-only ref append (esphome `audio_pipeline.cpp:1728-1737`),
   ref-ring reset on session edges, configurable 0–10 ms predelay (ADF
   contract), and — decisively — **hardware TDM reference preferred over
   the software tap** (§4 table: ES7210 slot 1 MIC3, stackchan
   `audio_pipeline.c:446-482`, superseding R11's software-tap assumption).
   B also passes explicit NULL reference when nothing is audible rather
   than zeros, documented with the esphome contrast (§2.2). No other
   candidate touches this level.
3. **The AEC chunk-size problem is solved in the seam, uniquely.**
   `frame_spec.samples_per_frame` may be 512 (32 ms, `aec_get_chunksize`,
   stackchan `audio_pipeline.c:826`) while the wire stays 320/20 ms, "the
   pipeline re-frames" (§2.2). A never mentions it; C's design contradicts
   it (see §3.2 below). This is the difference between a seam that will
   survive first contact with esp-sr and one that won't.
4. **Turn machinery lives on the audio task** — intents drained at beat
   cadence on core 1/prio 19 (§2.3), drained-edge mic-open and warmup as
   local mode rules, barge-in purge local. PTT handling is immune to core-0
   TLS churn (contrast A weakness 2). Combined with the in-band commit
   (type-2 zero-length v2 frame, §5.2), a PTT turn completes even with the
   control lane down — directly serving requirement 10 with realtime means.
5. **Budget honesty with teeth**: inline FD AEC ≈ 6.4 ms of a 32 ms chunk
   (~20 % core, review §4.5) is named, the per-stage µs telemetry with an
   over-budget counter is imported as a **zero-tolerance endurance counter**
   (§9.2), and the escape hatch (feed/fetch worker split at prio 18 clocked
   by a feed semaphore, esphome `esp_afe.cpp:1902-1938`) is pre-planned
   behind the same seam. Explicit **zero IRAM** claim for the v2 header
   (§5.2), AEC phase gated on R4's IRAM clawback + PSRAM smoke (§8).
6. **Descriptor identity survives by contract**: beats carry descriptor
   _identity_ + EOF timestamp exactly as the v1 ISR does (§2.1), so the
   3,093 LOC of physical-correctness tests keep proving the same claims.

### 2.2 Weaknesses under this lens

1. **The blocking beat has an unspecified idle-clocking hole — the classic
   blocked-loop-needs-a-doorbell defect.** `run_once` = "drain intents →
   codec.next_beat(block)" (§2.3). On the half-duplex Stick between turns,
   route = IDLE: no capture DMA, no playback DMA, therefore **no beats** —
   the loop is clocked by `timeout_ms` alone, and a PTT press intent
   arriving one instruction after the task blocks waits out the full
   timeout. Prior art never hits this because xiaozhi/esphome audio tasks
   always have running DMA. The fix is known (block on an event group /
   task notification that combines DMA completion AND intent-queue
   doorbell — v1's owner already blocks on notifications), but the
   candidate's signature interface does not specify it, and its press-to-
   capture latency claim silently depends on it. This is the deepest hole
   in the document.
2. **It rewires the crown jewel's harness.** RealtimePlayback survives
   verbatim as a _policy object_, but its call sites move inside codec
   impls and its completions become beats (§2.3 options: `playback_policy`
   routed through the pipeline). The M2 gate ("byte-identical, thresholds
   unchanged") is the right discipline, but this is genuine surgery on the
   physically-proven path — the incident-bought silence-recovery/
   generation-poison behaviors must re-prove through a new call topology.
   C deliberately refuses exactly this risk.
3. **Inline AEC in the beat is a standing overrun risk.** 6.4 ms today;
   add NS or a slower NLP setting and the beat overruns, delaying refills
   against a 4-descriptor/80 ms DMA window. The guard (telemetry counter)
   detects, not prevents; the escape hatch is a task-model change mid-
   bring-up. Acceptable engineering, but it is the candidate's own §9.2
   admission and it lands on the highest-risk hardware phase (StackChan).
4. **Pipeline gravity is a permanent tax** (§9.1, owned): the best task in
   the system attracts work. The per-beat work-budget assertion is the
   right guard but is an assertion, not an architecture.
5. **The event ring inherits the same cross-task SD-reader torn-copy
   underspecification as A** (§2.5 sinks include an SD task at prio 2
   reading per-sink cursors) — lower stakes because the ring is periphery
   carrying no control decisions, but the spec hole is the same and should
   be closed once, centrally.
6. **The blocking beat costs L1 determinism.** Pipeline tests need
   scripted-codec + pthread-fake threads rather than pure sans-I/O calls
   (§9.2 first bullet, owned, with the nonblocking fallback named). Under
   this lens that matters because the mode machine — the component most
   likely to harbor turn-edge races — is tested under the less
   deterministic harness.

### 2.3 Stress scenarios

- **4 s Wi-Fi outage mid-conversation**: the best of the three. The audio
  task is fully isolated on core 1 with no network dependency; capture
  beats keep clocking; the uplink lane purges by epoch; downlink underruns
  to silence with same-generation resume. Intents keep being handled at
  beat cadence (PTT still works), and the in-band commit means a release
  during the outage still terminates the turn correctly when the PCM
  socket returns — no cross-socket commit race. Recovery churn on core 0
  cannot touch the pipeline. Residual weakness: button _sensing_ is still
  polled on the starved main task (all three share this), and the idle-beat
  doorbell hole (weakness 1) applies if the outage happens between turns.
- **10 min endurance**: per-stage µs telemetry with zero-tolerance
  over-budget counters is precisely the endurance instrument this lens
  wants; clock-drift handling (`i2s_channel_tune_rate`, review §4.6) is not
  explicitly claimed by any candidate but B's beat/descriptor structure is
  where it would land naturally. Inline-AEC drift is the one watched risk.

**Score: 8.0/10.** The lens's native candidate: it converts every paid-for
prior-art lesson into load-bearing structure, is the only one with a
credible AEC-forward design (chunk re-framing, hardware ref, budgets,
escape hatch), and behaves best in both stress scenarios. Docked for the
unspecified idle-beat doorbell, the measured-but-real surgery on the proven
playback harness, and the inline-AEC overrun exposure.

---

## 3. Candidate C — minimal delta

### 3.1 Strengths under this lens

1. **Smallest possible blast radius on physically-proven realtime code.**
   The 3.6 k-LOC descriptor-identity playback stack is not merely preserved
   — it is _not even rewired_ (§3.2 scope note: playback folds under the
   codec vtable only when Waveshare provides a second customer). Every
   incident-bought behavior (brownout ceiling, silence-recovery,
   generation poison) keeps its exact call topology. Under a lens that
   prices regression risk to proven realtime behavior, this is the
   strongest single property any candidate offers.
2. **The nonblocking-event codec is the best clock-discipline compromise on
   offer.** All ops nonblocking, owner-task-only, cadence = DMA completion
   events via the existing ISR→SPSC→notify idiom generalized (§3.2). It
   fixes R1/R5 (capture completion-driven, on the owner, fence internal
   and asynchronous with `ROUTE_APPLIED`) while keeping sans-I/O purity —
   the pipeline stays testable as pure function calls. Notably, **B itself
   names this exact shape as its fallback** if the blocking beat degrades
   testability (B §9.2/§12.1). C also has no idle-doorbell hole: the owner
   blocks on notifications that intents can also fire, the idiom v1
   already uses.
3. **Concurrency-conservative event fan-out.** No new lapped multi-reader
   ring, no seqlock, no ISR-variant publisher: observers are nonblocking
   callbacks that copy into per-sink bounded queues _on the owner task at
   publish time_ (§3.3), and the SD feeder is a plain SPSC under the
   existing proven contract. The cross-task torn-read hazard that A and B
   both leave unspecified **cannot occur** in C's topology. Fewest new
   memory-order obligations of the three — exactly the R8 direction.
4. **Explicit embedded-budget discipline**: "IRAM delta: zero by rule"
   (§7.2); R4 chores scheduled in waves 1–2 _before_ anything in wave 5
   needs them; SD ring in PSRAM with an 8 KiB internal DMA-capable batch
   buffer, `has_sd`-gated so the Stick pays nothing; refusal of SD-on-NOR
   for the Stick precisely because cache-suspension stalls are the
   `CONFIG_I2S_ISR_IRAM_SAFE` hazard class (§11) — a genuinely
   embedded-literate refusal.
5. **Every wave gated on the physical proof ladder** (§1 rule 4, §8), with
   the uplink echo-loop scenario created _by the wave that needs it_ as its
   own regression test (§8 wave 2). For realtime code, migration discipline
   IS a correctness property; C's is the tightest.
6. The four req-10 fixes are stated at patch precision (~10/15 LOC each,
   §5 row 10) against verified defects (gate reset on `socket_connected`
   confirmed at `pcm_transport.c:616-618`).

### 3.2 Weaknesses under this lens

1. **The AEC future is under-designed to the point of glibness — the
   deferred-risk mirror of its near-term safety.** §4.2: "the audio owner's
   frame loop calls the esp_sr FD_LOW_COST processor synchronously per
   20 ms frame (~19.6 % of core 1)". But FD AEC's chunk size is dictated by
   the engine (`aec_get_chunksize` — stackchan measured 512 samples/32 ms;
   B §2.2 cites it), and C's own §3.1 comment fixes
   `samples_per_frame: 320 = 20 ms`. `frame_spec` _could_ answer 512, but
   then nothing in C re-frames 320-sample wire frames into 512-sample
   processor chunks — no staging design, no latency accounting for the
   extra ≤12 ms of chunking buffer, no statement of who owns it. The seam
   as sketched will not survive first contact with esp-sr without rework,
   and that rework lands during StackChan bring-up — the maximum-hardware-
   risk moment. This is a memory of exactly the "seam exists but doesn't
   fit the engine" failure the review's §4.2 was written to prevent.
2. **The reference tap is homeless.** The processor contract demands
   complete-frames-only reference enforced by "the codec/tap layer"
   (§3.1 comment), but C's codec is capture+route-only — playback, where
   the TX tap must live, is outside the codec until Waveshare. So in the
   StackChan software-tap fallback, the ref ring must be grafted onto the
   untouched RealtimePlayback stack with no designed seam. B places it
   precisely (ref append at DESCRIPTOR_COMPLETED, complete frames only,
   §2.3); C waves at it via R11.
3. **The half-codec asymmetry is a live realtime seam, not just an
   organizational wart.** The half-duplex fence (amp off → channel disable
   → channel delete → PDM RX up) spans capture AND playback teardown;
   C puts it inside `m5sticks3_codec.c` on the owner task — same task as
   playback, so no cross-task hazard — but the fence must reach across the
   codec/template boundary into I2S lifecycle owned by the direct-audio
   stack. The wart ledger (§9.3) gives this a date (Waveshare), which is
   honest, but until then the most delicate hardware sequence in the tree
   straddles two idioms.
4. **Endurance instrumentation does not advance.** C inherits v1's metrics
   and adds gap facts, but nothing like B's per-stage µs/over-budget
   counters arrives before the AEC phase that needs them. Its endurance
   confidence is inherited, not extended.
5. Four bounded-delivery machines persist — under this lens that is
   _neutral_ (all are bounded background work at low priority; none touch
   the frame path), and I explicitly decline to punish C for it. The cost
   is other judges' business.

### 3.3 Stress scenarios

- **4 s Wi-Fi outage mid-conversation**: essentially v1's physically
  characterized behavior plus the four targeted fixes — the _highest
  confidence_ prediction of the three because the least has changed. The
  known 17–19 s outage class (detection + double-defer ladder; churn
  replies discarded host-side) is addressed by the same retry-ladder
  unification all three share. Without B's in-band commit **in the same
  early wave** (C ships the v2 header in wave 4), a release during a
  control-lane-only outage still rides the cross-socket commit race until
  then. Event history during the outage: per-sink bounded queues on the
  owner task — same starvation exposure as A's admission (main task,
  prio 1) but with shallower machinery and v1-equivalent behavior.
- **10 min endurance**: the proof ladder and frozen thresholds run
  unchanged over a mostly-unchanged image — best short-term endurance
  certainty, least new endurance insight.

**Score: 7.0/10.** The safest hands on the proven hot path, the cleanest
concurrency story, the best migration discipline, and the correct clock
compromise — but it banks that safety by deferring the hard realtime design
(AEC chunking, reference tap, playback-under-codec) to exactly the phase
where hardware risk peaks, and its §4.2 AEC paragraph would not survive a
design review against esp-sr's actual API.

---

## 4. Head-to-head on the lens's specific checklist

| Criterion                                                    | A                                                                                       | B                                                                      | C                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Capture priority (R1)                                        | adopted                                                                                 | adopted (native)                                                       | adopted                                       |
| DMA-owned cadence                                            | adopted via R5                                                                          | **the organizing rule**; but idle-doorbell hole                        | adopted, nonblocking-notify variant (no hole) |
| Processor concurrency discipline (dirty-flag/drain/snapshot) | referenced                                                                              | **fully designed, provenance per rule**                                | header-comment level                          |
| Ref-signal correctness                                       | deferred to R11                                                                         | **hardware TDM ref + complete-frames + predelay + NULL-ref semantics** | demanded of an unbuilt "tap layer"            |
| AEC chunk-size reality (512 vs 320)                          | unaddressed                                                                             | **re-framing in the seam**                                             | contradicted by own text                      |
| PSRAM/IRAM budgets                                           | RAM honest; **IRAM silent despite new ISR surface**                                     | IRAM-zero explicit; AEC gated on R4                                    | IRAM-zero by rule; R4 scheduled earliest      |
| Allocation-free hot path                                     | preserved                                                                               | preserved                                                              | preserved                                     |
| New lock-free machinery risk                                 | **highest** (lapped multi-reader ring + seqlock + ISR tributary; torn-read unspecified) | medium (ring periphery, same spec hole)                                | **lowest** (reuses proven SPSC only)          |
| Starvation windows                                           | spine admission + R12 edge on starved prio-1 task                                       | audio task fully isolated; idle-beat timeout                           | v1-equivalent                                 |
| Priority inversion                                           | none (async routes)                                                                     | none (try-lock + silence fallback)                                     | none                                          |
| Unbounded queues                                             | none                                                                                    | none                                                                   | none                                          |
| 4 s outage behavior                                          | audio fine; **history thins at the worst moment**                                       | **best**: turn machinery survives, in-band commit                      | v1-proven + fixes; commit race until wave 4   |
| 10 min endurance                                             | fine; rate-law is discipline-only                                                       | **best instrumented** (per-stage µs, zero-tolerance)                   | proven but not advanced                       |
| Risk to proven playback path                                 | low (untouched)                                                                         | **medium (harness rewired, gated)**                                    | **zero (untouched by design)**                |

---

## 5. Scores

- **A — event-spine: 5.5/10.** Correctly firewalled from the frame path and
  honest about being orthogonal to audio (§10.9), but under this lens it is
  the highest-machinery, lowest-payoff candidate: three new hand-rolled
  concurrency mechanisms with the torn-read and IRAM questions unasked, a
  turn-latency edge routed through the starvable main task, and event
  liveness concentrated where outages starve it.
- **B — pipeline-purist: 8.0/10.** The only candidate that _is_ the
  prior-art lesson set; only credible AEC-forward design; best outage and
  endurance behavior. Loses two points for the unspecified idle-beat
  doorbell, the (gated but real) surgery on the proven playback harness,
  and the inline-AEC overrun exposure.
- **C — minimal-delta: 7.0/10.** Best protection of proven realtime
  behavior, cleanest concurrency, best migration discipline, and the right
  clock compromise — held back by an AEC design that is not just thin but
  self-contradictory on chunk size, a homeless reference tap, and endurance
  instrumentation that never advances.

## 6. Hybrid recommendation (from this lens only)

Build the audio center from B and the change-management from C; take from A
only the tributary. Concretely: adopt B's codec+processor+pipeline seam
positions, its reference discipline (hardware TDM ref first, complete-
frames-only, predelay), its chunk-size re-framing, its per-stage µs
telemetry, and its early in-band-commit/timestamp-echo wire work — but run
the pipeline on **C's nonblocking-event codec clocking** (task-notification
cadence, which B itself names as its fallback), which closes B's idle-
doorbell hole and keeps L1 sans-I/O determinism. Keep **C's playback rule**:
RealtimePlayback's call topology untouched until Waveshare provides a second
codec customer, with B's M2 byte-identical gate as the acceptance if the
fold happens earlier. Reject A's spine for v2 under this lens (keep the
B/C event-ring periphery with the sampler outside), but adopt A's tributary
as the single audited ISR/cross-core marshalling module — and require, as
merge conditions on any event infrastructure: (i) a specified
torn-read/atomic-cursor protocol for any cross-task ring reader, (ii)
IRAM-delta-zero, and (iii) an internal-RAM ledger entry against the 77.8 KiB
free / 31–60 KB AEC composition. All of A's remaining realtime content
(R1/R5 adoption, boundary events, route-applied timing) is already present
in the B+C composite.
