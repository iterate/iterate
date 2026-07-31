# Judge — Lens 3: simplicity, testability, migration cost

Status: adversarial judging artifact, exploration round, 2026-07-31. Scope of
this lens ONLY: net-LOC and concept-count honesty (their estimates audited),
host-testability of every new seam (layer-1 sub-second), executability of the
three-layer test story, cognitive load for a new contributor, and REALISTIC
migration with a codex agent actively landing v1 in this worktree. Penalties
for speculative generality and invented framework nouns per Jonas's standing
feedback (conventions over frameworks, no invented concept names, itx-shaped
first-party code). Audio quality, event-model elegance, prior-art fidelity are
other judges' lenses — where I mention them it is only as they interact with
mine.

Verdict up front: **C 7.5, A 6.0, B 4.5.** C wins this lens because migration
realism and estimate honesty are where the three candidates differ most, and C
is the only one whose plan survives contact with what the codex agent is doing
in this tree _today_. A has the best end-state mechanism count and the best
unified test vocabulary but underestimates its own additions by roughly 2× on
the spine modules and schedules its two riskiest cutovers against files that
do not even exist in committed form yet. B fails the brief's requirement 1
hardest, builds three abstractions with one customer each, and rewires the
physically-proven audio path mid-flight.

---

## 1. Ground facts I verified before scoring

### 1.1 LOC claims — audited against the tree

Candidate C claims it re-verified with `wc -l` (arch-c §0, lines 8-12). I
re-ran the measurement. **All ten match exactly:**

| File                                                | Claimed | Measured |
| --------------------------------------------------- | ------: | -------: |
| `components/capabilities/src/metrics.c`             |   1,510 |  1,510 ✓ |
| `targets/m5sticks3/main/main.cpp`                   |   1,349 |  1,349 ✓ |
| root `CMakeLists.txt`                               |   1,008 |  1,008 ✓ |
| `platforms/common/.../realtime_playback.hpp`        |   1,863 |  1,863 ✓ |
| `platforms/common/.../bounded_playback.hpp`         |     389 |    389 ✓ |
| `components/core/src/device_events.c`               |     198 |    198 ✓ |
| `components/capabilities/src/device_event_stream.c` |     549 |    549 ✓ |
| `components/core/src/runtime_diagnostics.c`         |     505 |    505 ✓ |
| `platforms/iterate_esp_idf/itx_transport.c`         |   1,624 |  1,624 ✓ |
| `platforms/iterate_esp_idf/pcm_transport.c`         |   1,181 |  1,181 ✓ |

(One nit: C's §1.1 file list places `device_event_stream.c` under
`components/core/src/`; it actually lives in `components/capabilities/src/` —
the LOC is right, the path is wrong. Cosmetic.)

### 1.2 The duplication claims — real

- The five-boolean delivery duplication all three candidates cite is real:
  `occupied / call_in_flight / callback_budget_reserved / release_pending`
  appear in `components/capabilities/include/iterate/kit/capabilities/device_event_stream.h`
  (struct `iterate_kit_device_event_stream`, ~lines 64-78) **and** in
  `metrics.h` (`iterate_kit_metrics_subscription`, ~lines 313-320). The cited
  line numbers in the candidates are off by a few lines but the substance is
  exact. This is a live fix-it-twice bug surface, not a rhetorical device.
- `device.h:4` includes `audio.h` — verified. The late-addendum "audio-less
  link set" gap is real in v1, and all three candidates fix it the same way
  (R3 split + include drop), so it does not differentiate them.

### 1.3 The codex agent's actual in-flight file set — the fact that decides this lens

`git status` (read-only) shows the v1 agent currently has **modified**:
`metrics.{c,h}`, `main.cpp`, `itx_mount.c`, `peer.c`, `itx_transport.c`,
`m5sticks3.{c,h}`, `m5sticks3_direct_audio.cpp`, the three ESP-IDF transport
_headers_ (not `pcm_transport.c` itself), root + capabilities `CMakeLists.txt`,
simulator files, `device-e2e.ts`, `acoustic-tone-analysis.ts`, and six
firmware test files including `m5sticks3_events_test.c` and
`metrics_subscription_test.c`. And — this is the detail none of the three
candidates fully priced — **untracked NEW files**:

```
?? components/capabilities/include/iterate/kit/capabilities/device_event_stream.h
?? components/capabilities/src/device_event_stream.c
?? components/capabilities/include/iterate/kit/capabilities/callback_budget.h
?? components/capabilities/src/callback_budget.c
```

The codex agent is _writing the event-stream delivery machine right now_. It
is not yet committed anywhere. Consequences per candidate:

- **A** plans (M3) to delete `device_event_stream` and re-implement its five
  invariants inside a new `event_subscription`, porting `m5sticks3_events_test.c`
  as the gate — a test file codex is simultaneously editing. A prices M3
  "medium — coordinate a quiet window" (arch-a §9). That is underpriced: you
  cannot cleanly port and then delete a module whose first version has not
  finished landing. The realistic outcome is M3 waits weeks, or the port is
  done twice.
- **C** plans to _generalize_ the same module in place ("delivery machine
  untouched; notification carries `{type, payload, sequence}`", arch-c §6.2)
  — it builds on top of whatever codex lands, and codex's tests remain the
  pins. This composes with the in-flight work instead of racing it.
- **B** routes the same machinery into its event-ring capnweb sink at M4 with
  the same ported-suite gate as A — same underpricing as A, slightly less
  total surface.

Second collision: B's center (M2 codec-under-the-Stick, M3 pipeline) rewrites
`m5sticks3_direct_audio.cpp` and the capture pump in `main.cpp` — **both in
codex's modified set right now**. B admits this is its two-front risk
(arch-b §9.2: "the pipeline replaces exactly the files v1's agent is actively
hardening (audio.c, capture pump, transports)") — n.b. `audio.c` is actually
_not_ in the modified set, but `m5sticks3_direct_audio.cpp` and `main.cpp`
are, so the admission is materially correct while being sloppy on the
specific file. C's wave 2 touches the same area but with a much smaller blast
radius (capture+route only; playback untouched); A's R1 move is the same
scope as C's.

Third: all three defer the R7 metrics X-macro until codex's metrics work
lands (A M4 "after v1 stabilizes"; B M4; C wave 3 "MUST wait for their
checkpoint"). Only C states the cost out loud: it "makes the biggest
complexity win the _latest_ one" (arch-c §9.2.5). Credit for honesty; the
constraint binds all three equally.

---

## 2. Candidate A — event-spine

### 2.1 Strengths under this lens

1. **Best end-state mechanism count, honestly framed.** "Places-a-counter-is-
   spelled 7→1; bespoke delivery machines 4→1; 'something happened' queue
   disciplines 4→1" (arch-a §7). The five-invariant delivery machine written
   once (§3.4) kills a duplication I verified is real (§1.2 above). A also
   explicitly disclaims the LOC headline: "The honest headline is not the
   −8%" — the right epistemic posture.
2. **The best unified test vocabulary of the three.** "The spine is the
   assertion surface of all three layers" (§5 row 2): L1 golden JSONL diffs,
   L2 rig subscribes to the event feed as its ordering witness, L3 checkride
   asserts against the same stream and diffs the SD ledger. One vocabulary
   across layers is a genuine simplicity win no other candidate matches.
3. **Every new seam is host-testable sub-second.** The spine is pure C,
   single-writer, virtual-clock-friendly; the tributary reuses the
   seeded-schedule SPSC test idiom that already exists (`spsc_ring_test.c`
   links pthreads today); `event_subscription` tests port the
   `metrics_subscription_test.c` idiom. No seam requires hardware or sleeps.
   The sans-I/O property v1 is best at survives fully.
4. **Best-in-class self-criticism.** §10 lists ten failure modes including
   "it is the highest-risk single move of any candidate" and the admission
   that the metrics side-slot is "a compromise wearing a design's clothes"
   (§10.6). A judge can trust a document that prosecutes itself; most of my
   §2.2 findings are pre-admitted there, which mitigates but does not erase
   them.
5. **New-files-first sequencing (M0-M2) is genuinely zero-collision**, and
   the M2 parallel-ledger diff (spine beside `device_events`, rig diffs the
   two) is the strongest cutover-verification device proposed by any
   candidate.

### 2.2 Weaknesses under this lens

1. **The spine addition estimate is ~2× optimistic.** A claims the collapse
   is −2,082 deleted / +1,250 added = −830 net (§7). Audit against v1
   analogs, module by module, in the same house style (options structs,
   metrics structs, reasoning comments — the style that makes v1's
   `device_event_stream` 653 LOC for ONE single-subscriber machine):
   `log.{h,c}` (admission + handler chain + cursors + lap/gap + metrics) —
   claimed within the 350-core envelope, realistic 350-450 given
   `device_events` is already 329 for a strictly simpler queue;
   `tributary.{h,c}` with task- and ISR-variant memory-order pairings —
   realistic 200-300 (`spsc_ring` is 257+header for a byte ring);
   `serialize.{h,c}` — per-type JSON to StreamEventInput shape + binary
   packer; the existing `getDiagnostics` snprintf formatter is 206 LOC for
   _one_ shape, so ~24 typed payload emitters even table-driven is 250-400;
   `event_subscription` preserving five invariants + class masks + interval
   pacing + snapshot + scratch proofs — realistic 450-650 vs. the 653-LOC
   single-purpose v1 machine it generalizes; plus `retained`, `sideslot`,
   `console_sink`, the `.def` table + payload structs. **Realistic firmware
   sum ≈ 1,800-2,200, not 1,250**; the −830 spine net erodes to roughly
   −100…−500, and A's −8% total erodes to ≈ −6…−7%. The "~150-LOC TS
   generator emitting the zod union + SD-ingest decoder table + wire-constant
   fixtures" (§3.1 comment) is similarly optimistic — three output targets
   from one generator is 250-400 LOC of TS in practice. A's framing
   pre-absorbs this ("the honest headline is not the −8%"), so this is an
   erosion, not a falsification — but under a lens that audits estimates, it
   costs points.
2. **Migration is the longest and most collision-prone, and §1.3 above makes
   it worse than A prices it.** M3 deletes a module that exists only as
   codex's untracked working files; M4 is "high-touch on codex's files"; M5
   is a deliberate fleet-lockstep wire break. Three of eight milestones are
   coordination-gated. The improved L2/L3 test story (event feed as rig
   witness, SD-ledger diff) arrives at M5/M7 — _after_ the two riskiest
   cutovers, so the new test vocabulary cannot protect the migration that
   builds it. That is backwards from a pure-migration standpoint, and it is
   the structural reason A cannot win this lens: its value density is at the
   END of its dependency chain.
3. **Concept load is net-positive even though mechanism count drops.** A new
   contributor must learn: spine, tributaries, admission vs. origin time,
   cursors, gap-as-read-result, event classes/masks, `handler_status`
   stamping, boot epochs, retained-latest, and the side-slot seqlock with its
   "the spine carries a reference, never the sample" rule. Ten new concepts
   against four retired ones. The steady state is _coherent_ (everything is
   one idiom), but the button-press trace goes from v1's
   ISR → queue → handler/observer to
   ISR → tributary → drain → admission → handler chain → status stamp → N
   cursored sinks. A admits the teaching cost only for the side-slot (§10.6);
   it applies to the whole.
4. **Invented-noun penalty, applied.** §11 refuses "EventBus/Journal/
   Telemetry Fabric" and then the document's organizing nouns are "spine",
   "tributary", and "side-slot" — three coined metaphors, one of them the
   title. "Tributary" names what v1 calls marshalling onto the owner task
   (`device_events.h:80-85` contract) and what the codebase already spells
   `spsc_ring`; a name like `event_relay` or plain reuse would rhyme with the
   tree. This is exactly the `feedback_no_invented_concept_names` class, in
   miniature. Minor but real; the deliverable's own §11 shows awareness the
   rule exists.
5. **The write-amplification governor is a norm, not a mechanism** — §1.6's
   admission-rate law is enforced by debug asserts + review. A predicts its
   own incident ("expect one incident where a misjudged event rate laps the
   ring", §10.4). Under a simplicity lens, a design whose central resource is
   protected by discipline inherits a standing review burden on every future
   PR that publishes an event.

### 2.3 Score: 6.0

Best steady-state, best test vocabulary, honest self-prosecution; loses on
realistic migration (value at the end of the chain, cutovers racing codex's
uncommitted work), ~2× optimism on additions, and coined nouns.

---

## 3. Candidate B — pipeline purist

### 3.1 Strengths under this lens

1. **Honest LOC accounting, stated against interest.** "Candidate B is the
   least LOC-reductive of plausible v2 shapes" (arch-b §8) — −4% total, with
   the deltas itemized and the two divergences from the audit (declining the
   spine collapse; adding analysis now) named. Its individual estimates are
   the most defensible of the three where they can be cross-checked against
   prior art (xiaozhi's seven codecs = 1,541 LOC supports the "+1,100 for 3
   impls + scripted" claim, though house-style comments will push it up
   20-30%).
2. **The one falsifiable architecture claim in the whole exploration.** "If
   StackChan bring-up needs a new pipeline state (not a new processor/codec),
   the architecture bet lost" (§4), plus the executable guard "new mode = new
   policy row, zero new states" as an architecture test (§9.2). Under a
   testability lens, a design that states its own kill criterion is worth
   real credit.
3. **Concrete, early, physical regression tests.** The M2 uplink echo-loop
   scenario ("pre-M2 firmware should fail it under `--control-churn-hz` load,
   post-M2 must not", §10) is the best-designed single test in any candidate:
   it creates the regression test for the R1 fix in the same milestone as the
   fix. (C shares this scenario at wave 2.)
4. **Class-4 (audio-less) containment is real**: negative link test from day
   one, `core`/`events`/`capabilities` linkable with zero audio symbols
   (§0.1) — equivalent to A and C on the addendum, no penalty.

### 3.2 Weaknesses under this lens

1. **It fails requirement 1 hardest and spends the savings on abstractions
   with one customer each.** −4% total, and the additions are: a codec vtable
   with ONE production implementation until Waveshare/StackChan hardware
   exists; a three-mode pipeline of which exactly ONE mode (MANUAL_STOP)
   ships on real hardware in v2.0; a processor seam whose only non-test
   implementations are `null` and `timestamp_echo`; and +1,100 LOC of
   analyser stack that B itself flags as "shelfware... exercised only by host
   tests and the Stick status screen until CoreS3 bring-up" (§9.2). That is
   textbook speculative generality under this lens — four seams built ahead
   of their second customer. The prior-art provenance (xiaozhi/esphome
   converged on these exact seams) is a genuine mitigation — these are
   _proven_ shapes, not invented ones — but proven elsewhere is not needed
   here yet, and the brief's requirement 1 says reduce.
2. **The blocking beat trades away v1's crown testability property and knows
   it.** §9.2: "a philosophical break with v1's sans-I/O purity... pipeline
   tests need the scripted codec + thread fakes rather than pure function
   calls," with a tripwire (≤5 s native suite) rather than a guarantee, and a
   fallback (nonblocking event codec) that is literally Candidate C's §3.2
   design. When your own risk register's mitigation is the other candidate's
   default, the other candidate wins that point. In practice a scripted codec
   returning beats synchronously keeps L1 sub-second — but that discipline
   must now be _maintained_ against a contract that says "may block", forever.
3. **Worst codex collision profile at the center.** M2/M3 rewrite
   `m5sticks3_direct_audio.cpp` + the `main.cpp` capture pump —
   currently-modified files — and replace `audio.c` with a new pipeline while
   the physical proof ladder must stay green. B prices this honestly
   ("merge friction and a long-lived divergence if v1 work continues past
   M2", §9.2) but has no mitigation beyond "coordinate". Unlike A, B cannot
   reorder around it: the collision IS the center of the candidate. Also §9.2
   names `audio.c` as actively-hardened when it is not in the modified set —
   a small factual sloppiness in exactly the section that needed precision.
4. **Periphery honesty cuts against it under the addendum.** "The periphery
   is 80% of the module count and gets ~20% of the design attention" (§9.1).
   B keeps two delivery machines (sampler + event ring) plus the five-boolean
   dedup, i.e., it takes the _medium_ dedup (−600) and leaves the concept
   count of the control plane roughly where v1 has it, while ADDING
   beat/route/mode/analyser/pose/render-key/stage-cue vocabulary. Net new
   concepts for a contributor: ~10-12, the highest of the three, concentrated
   in the subsystem the audio-less fleet never links.
5. **Cognitive load asymmetry.** For an audio engineer arriving from
   xiaozhi/esphome, B is the _lowest_-load candidate — the seams match the
   industry's shapes ("codec", "processor", "pipeline" are prior-art
   vocabulary, not coinages — no invented-noun penalty there; "beat" is a
   coined but small and well-defined noun). For everyone else — and the
   addendum says the fleet grows toward everyone else — B's best design
   effort is in the part of the tree they will not touch.

### 3.3 Score: 4.5

Honest numbers and the best falsifiable claims, but under THIS lens it is the
wrong shape: least reduction, most speculative surface area, testability
regression at the core seam by its own admission, and its center collides
head-on with the in-flight v1 work.

---

## 4. Candidate C — minimal delta

### 4.1 Strengths under this lens

1. **The most honest estimates in the exploration, and the only re-measured
   ones.** All ten `wc -l` claims verified exact (§1.1). The headline is
   stated against interest twice: "−1.9%... If Jonas wants a −10%+ LOC
   headline, this is the wrong candidate" (§0) and "Host code grows...
   +2.4%" (§9.1). The gap to the audit's −8% is itemized to the line
   (§9.1: the refused collapses sum to the missing −6.4k). Nothing to
   deduct: when I audit C's numbers, C has already audited them.
2. **Best migration realism, by construction and verified against the live
   git status.** Wave 0 touches zero codex-modified files (checked: the wave-0
   deletions — `bounded_playback`, `websocket_text` halves, capnweb
   responder — are all outside the modified set except a two-line root-CMake
   coordination C explicitly names). The wave-3 gate on codex's metrics
   checkpoint is stated. And the decisive point from §1.3: C _generalizes_
   the `device_event_stream` machine codex is writing today, keeping its
   delivery machinery "untouched" (§6.2) — the only candidate whose
   requirement-8 path composes with the uncommitted v1 work instead of
   deleting it. Every wave "independently landable and independently
   revertable"; the tone proof is a per-wave invariant, not a milestone
   ceremony (§1 rule 4) — the tightest proof-ladder preservation of the
   three.
3. **Every new seam is host-testable AND sans-I/O pure.** The codec contract
   is nonblocking `next_event` + `read` (§3.2) — L1 tests are pure function
   calls, no scripted-blocking discipline to maintain; this is the design B
   lists as its own fallback. `event_sd_log` ships with
   `fake_block_store.c` (virtual-clock stall/yank/corrupt scripting) and
   simulator wiring _before_ any hardware adapter exists (§3.4). The
   pthread-fakes rule is promoted to a merge gate and the two documented
   holes (`websocket_connection.c`, `peer.c`) are closed (§5 row 2). Nothing
   in C's L1 story needs anything cut over first.
4. **The three-layer story is executable earliest and cheapest.** L2 keeps
   the physically-proven `device-e2e.ts` frozen and adds scenarios as
   sibling scripts (§5 row 7) — no decomposition risk before the new
   scenarios exist; the checkride is a ~200-LOC CLI; nothing depends on a
   wire break or a machinery cutover. Against A (whose rig-witness upgrade
   waits for M5) this is the difference between a test story that protects
   the migration and one the migration must survive to reach.
5. **The wart ledger (§9.3) is the best simplicity _instrument_ in any
   candidate.** Eight named warts, each with carried cost and a measurable
   trigger ("the THIRD time a delivery bug must be fixed in more than one
   machine ⇒ do the collapse as v2.1's single milestone"; "when the FOURTH
   additive scenario lands ⇒ extract the phase-runner"). This converts
   "minimal delta calcifies" from a vibe into a standing review item — and it
   is honest that this is discipline, not mechanism (same criticism I level
   at A's admission-rate law; C at least confines the discipline to review
   checkpoints rather than every event-publishing PR).
6. **Zero invented nouns; maximal convention reuse.** Every name in C is
   either v1's name, a review-recommendation name, or industry-standard.
   Half-codec-now-full-codec-at-Waveshare is the _anti_-speculative move:
   abstraction deferred until the second customer exists, priced at one
   admitted asymmetry era with a dated exit (§9.2.3, §9.3 row 7).

### 4.2 Weaknesses under this lens

1. **Concept count goes UP and C says so** (§9.4: "the conceptual count of
   mechanisms goes UP (codec contract + old playback contract; event queue +
   four sinks; two proxies; two diagnostics paths) before triggers bring it
   down"). The steady-state inventory is the largest of the three: all of
   v1's mechanisms survive PLUS processor seam, half-codec, profile, SD pump,
   widened events. The verified five-boolean duplication (§1.2) stays written
   twice _indefinitely_ unless trigger #1 fires — a standing fix-it-twice
   tax on the control plane's correctness core. For a contributor who knows
   v1 the learning delta is minimal; for a genuinely new contributor the
   total surface is the widest, including the "third asymmetry era" where
   capture speaks `audio_codec.h` and playback speaks templates.
2. **The 8-byte event payload has zero headroom.** §3.3: "8 bytes covers
   every current producer" — true only for the leanest packings (gap
   expected/actual = exactly 8 B; incident must drop either `detail` or
   `total_count` — A's equivalent incident payload is 12 B, and A's analysis
   justified 40 B slots partly on incident/route-applied shapes). The first
   producer needing three fields forces a schema bump on the module C most
   wants to leave stable. This is minimal-delta over-applied: widening to 16
   or 24 B costs ~256-512 B of RAM and would remove a predictable churn
   point.
3. **Its additions carry the same ~20-30% house-style optimism I charged A
   with**, just against a headline that doesn't depend on them:
   `upstream-session.ts` at +300 for a five-state DO state machine with
   alarms, preroll, secret pool, and transcript replay — which C itself
   calls "the worker's most complex logic ever" (§9.1) — will plausibly run
   450-600. Since C sells near-zero risk rather than reduction, the overrun
   damages the ledger, not the thesis. Small deduction.
4. **The stackchan failure shape is the real long-term hazard and C's
   mitigation is procedural.** §9.2.1 names it: "add beside, never rewire is
   _the same gesture_" that buried stackchan's 4.5k-LOC core under 60k of
   accretion. Wave gates + trigger ledger are the answer; both are norms.
   Under this lens I weight near-term migration realism above long-horizon
   accretion risk (a v2.1 collapse remains available "at roughly the same
   cost as now", §10.1 — and A's M0-M2 spine work is largely reusable then),
   but a judge scoring a 2-year horizon could defensibly dock C a point here.
5. **Two proxies drift** (§9.2.2): every `/pcm` change lands twice or the lab
   harness silently diverges — and C's own trigger for merging is _detecting
   the first divergence_, i.e., the failure is the trigger. Weakest row in
   the wart ledger.

### 4.3 Score: 7.5

Wins on all three of this lens's axes: estimates that survive audit, seams
that are host-testable without any cutover prerequisite, and the only
migration plan that composes with the codex agent's uncommitted work. Held
below 8 by the admitted upward concept count, the standing five-boolean
duplication, the 8-byte payload corner, and discipline-dependent triggers.

---

## 5. Head-to-head under the lens

### 5.1 Estimate honesty (audited)

|     | Claimed total Δ | My audited Δ                                                     | Verdict                                         |
| --- | --------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| A   | −8% (78.8k)     | ≈ −6…−7% (spine adds ~1.8-2.2k not 1.25k; TS generator +100-250) | optimistic on additions; framing pre-hedged     |
| B   | −4% (81.7k)     | ≈ −3…−4% (codec/pipeline/analysis +20-30% house-style)           | honest headline, mild add-side optimism         |
| C   | −1.9% (83.7k)   | ≈ −1…−2% (worker module +150-300 over)                           | most honest; only candidate that re-measured v1 |

All three stand on the audit's measured v1 = 85,310, which I spot-verified
(10/10 files exact). The audit's own −8% ceiling ("a −30% headline would
require cutting proven audio policy or test coverage") is sound and all three
respect it — no candidate is selling fantasy reduction. Differentiation is
entirely on the additions side, where C < B < A in optimism.

### 5.2 Concept accounting (new contributor, steady state)

|     | New concepts                                                                    | Retired concepts                                                                   | Delivery machines   | Standing duplications                                       |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| A   | ~10 (spine, tributary, cursor/gap, classes, side-slot, epochs, handler_status…) | 4 (device_events idiom, event-stream machine, metrics scheduler, diagnostics pump) | **1** (+sink pumps) | none (the point)                                            |
| B   | ~10-12 (beat, route, mode, processor, analyser/pose/key/cues, ring cursors…)    | ~3 (controller triplet, capture ledger, blocking fence)                            | 2                   | five-boolean pair partially deduped                         |
| C   | ~5-6 (processor, half-codec, profile, SD pump, widened events)                  | 0                                                                                  | 4-5                 | five-boolean pair stays; two proxies; two diagnostics paths |

No candidate reduces total concept count in v2.0. A minimizes _mechanisms_
(one idiom everywhere) at the price of the steepest one-time learning curve;
C minimizes _learning delta from v1_ at the price of the widest inventory; B
concentrates its concepts in the subsystem the growing audio-less fleet never
links.

### 5.3 When does the three-layer test story become executable?

| Layer                           | A                                                             | B                                                                         | C                                                                             |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| L1 new seams sub-second         | M0 (spine goldens; pure C) ✓                                  | M3 (pipeline via scripted codec; blocking-contract discipline required) ◑ | wave 1-2 (nonblocking codec, null/fake processor, fake block store; purest) ✓ |
| L2 upgraded rig                 | **M5** (event feed as witness requires the wire break)        | M2 (uplink echo loop — excellent)                                         | wave 2 (same echo-loop scenario; e2e frozen)                                  |
| L3 checkride                    | M5+ (asserts against new stream shape)                        | M4-M6                                                                     | wave 4, no cutover prerequisite                                               |
| Behavioral-suite ports as gates | M3+M4 (two big ports, racing codex's edits to the same tests) | M4 (one port)                                                             | none needed (existing suites keep pinning existing machines)                  |

C's story is executable earliest and gates nothing on a cutover; A's best
ideas arrive after its riskiest milestones; B is in between with the single
best individual scenario.

### 5.4 Migration collision with codex (from the live git status)

|     | Touches codex-modified files                                                                                             | Touches codex-UNTRACKED new files                          | Lockstep deploys                        |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------- |
| A   | M3 (events tests), M4 (metrics.{c,h}, main.cpp)                                                                          | **M3 deletes `device_event_stream` while codex writes it** | M5 wire break (fleet lockstep)          |
| B   | M1 (itx_mount/peer via moves), **M2-M3 (m5sticks3_direct_audio.cpp, main.cpp — the audio center)**, M4 (metrics + tests) | M4 (event-stream machinery reroute)                        | none forced (v2 subprotocol negotiated) |
| C   | wave 1 (moves; gated), wave 3 (metrics — explicitly gated on codex checkpoint)                                           | **generalizes rather than replaces**                       | none (subprotocol negotiated)           |

---

## 6. Scores

| Candidate           | Score (this lens only) |
| ------------------- | ---------------------: |
| A — event-spine     |                **6.0** |
| B — pipeline-purist |                **4.5** |
| C — minimal-delta   |                **7.5** |

---

## 7. Hybrid recommendation (what to graft from whom)

**Use C's migration frame as the plan's skeleton** — waves, all-additive
bias, per-wave tone-proof invariant, explicit codex gates, and the wart
ledger with triggers (§9.3) carried verbatim into the final plan as a
standing review item. It is the only frame that survives the live git
status.

**Graft from A, in this order:**

1. **The 40-byte payload and the slot layout** (arch-a §1.1) into C's widened
   `device_events` entry, replacing C's 8-byte payload. Cost ≈ +512 B RAM at
   32 slots; removes the one predictable schema-bump churn point in C. Take
   A's per-type packed payload structs and `payload_truncated` flag; skip the
   side-slot and `sideslot_reference` for v2.0 (audit Option B — sampler
   stays outside; C's position — is simpler to teach and reversible).
2. **The single X-macro `.def` generator serving events AND metrics AND the
   SD dictionary AND TS** (arch-a §3.1) — C already has two `.def` files; one
   generator serving both is pure win with no extra cutover.
3. **The delivery-machine collapse as the pre-named v2.1 milestone**, exactly
   at C's trigger #1 (third cross-machine delivery fix) or when codex's
   event-stream work is landed and stable — whichever first. A's M2
   parallel-ledger diff is the verification device to use when that day
   comes. Do NOT schedule it inside v2.0.
4. **Boot-moment-zero events + the `booted`/`config-loaded`/`wifi-*`
   vocabulary** (arch-a §1.6) — costs a few rows in the `.def` table, makes
   the SD sink answer requirement 5's exact scenario from slot 1.

**Graft from B, scoped by C's discipline:**

5. **The uplink echo-loop rig scenario as the R1 regression gate** (arch-b
   §10 M2 / arch-c wave 2 — they independently converged; adopt B's sharper
   formulation: pre-fix firmware must FAIL it under control-churn load).
6. **The falsifiable-claim idiom**: adopt "new listening shape = new policy
   row, zero new states" as an architecture test the day the pipeline/mode
   machinery exists — but build that machinery per C's scoping (processor
   seam + null/fake now; modes when StackChan forces them), not B's
   three-modes-day-one.
7. **B's codec economy target as an acceptance criterion** (a new board's
   audio = profile + ~200-300-LOC codec file "or the seam has failed") —
   applied to C's half-codec at Waveshare time.

**Refuse:** B's blocking `next_beat` (keep C's nonblocking `next_event`;
sans-I/O purity is v1's crown asset and B's own fallback is C's design); B's
+1,100 analysis component before CoreS3 hardware (B's own shelfware warning,
§9.2); A's M5 wire-break inside v2.0 (pin it to a Jonas-chosen lockstep
window or fold it into the v2.1 collapse); and all three candidates' habit of
scheduling the R7 metrics X-macro "after codex stabilizes" without a date —
the final plan should name the concrete codex checkpoint it gates on, because
R7 is the single biggest complexity win (−2,260) in every candidate and it is
currently last in line in all of them.

---

## 8. Caveats on this judgment

- This lens deliberately under-weights audio quality and event-model
  elegance. A judge scoring requirement-8 maximalism will rank A higher; a
  judge scoring AEC-readiness will rank B higher. Both would be right under
  their lenses; the hybrid above is designed to be compatible with either
  graft direction.
- My collision analysis reads a snapshot. If codex's v1 checkpoint merges
  next week and v1 goes quiet, A's M3/M4 risk drops a full grade (6.0 → ~7)
  and the case for scheduling the collapse inside v2.0 strengthens; B's
  center risk drops less, because its collision is with the _proven physical
  behavior_ of the audio path, not just with in-flight edits.
- C's score assumes the wart-ledger triggers are actually enforced (they are
  review discipline, not mechanism). If Jonas does not want to carry a
  standing review item, C degrades toward v1.5-forever and the 2-year
  simplicity ranking inverts in A's favor.
