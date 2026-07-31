# Judge — Lens 1: Requirements & Product Fit

Status: adversarial judging artifact, exploration round, 2026-07-31.
Lens: coverage of the 12 brief requirements with heavy weight on the NEW asks
(**8** events-as-streams, **5** SD logging, **9/10/11** resilience +
economics), fidelity to `physical-device-voice-goal.md` settled decisions,
apps/os alignment (verbatim API-shape mirroring), and whether the four-board +
ESPHome future stays genuinely open. Audio-internals quality, LOC accounting,
and migration mechanics are judged **only** insofar as they change requirement
coverage — other lenses own them.

Inputs read in full: `inputs/brief.md` (incl. the late audio-less addendum),
`../physical-device-voice-goal.md`,
`../fable-firmware-architecture-review-2026-07-31.md`, and all three
candidates. Load-bearing claims spot-verified against real source (see §5).

Verdict up front: **A 8.5, C 7.5, B 5.5.** Candidate A is the only one that
actually discharges the two heaviest new asks (8 and 5) at the level the brief
words them; candidate C is the fidelity/product-safety champion that
deliberately fails requirement 1 and under-serves requirement 8's "ideal"
clause; candidate B maximizes the half of the goal doc that was already
strong in v1 and is materially weakest on exactly the requirements this round
was convened for.

---

## 1. Requirement-by-requirement scoring matrix

Weights per the lens: reqs 8, 5, 9, 10, 11 heavy; the rest normal; plus three
lens-specific columns (goal-doc fidelity, apps/os verbatim alignment,
four-board/ESPHome openness).

| Req                                 | A event-spine                                                                                                                                                                                                                                            | B pipeline-purist                                                                                                                                                                                                                     | C minimal-delta                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 reduce code/complexity            | **best** (−8 %; machines 4→1; schema ∞→1)                                                                                                                                                                                                                | mid (−4 %; honest: "least LOC-reductive", B §8)                                                                                                                                                                                       | **worst by design** (−1.9 %, host +2.4 %, machines 4→4 — C §0, §9.1)                                                                                                                                                                             | Req 1 is Jonas's first-listed ask; C loses the row on purpose and says so                                                                                                                                                                                                                     |
| 2 test/reason                       | strong ("spine is the assertion surface of all three layers", A §5 row 2)                                                                                                                                                                                | strong (pipeline host-testable; but blocking beat weakens L1 purity, B §9.2)                                                                                                                                                          | strong (seams host-covered; proof ladder frozen)                                                                                                                                                                                                 | near-parity                                                                                                                                                                                                                                                                                   |
| 3 prior-art best practices          | strong (provenance table, A §5 row 3)                                                                                                                                                                                                                    | **best** (verbatim seam translations w/ file:line, B §2)                                                                                                                                                                              | good (≤100-LOC bounded patches, C §1.5)                                                                                                                                                                                                          |                                                                                                                                                                                                                                                                                               |
| 4 pluggable hardware                | strong (full codec vtable + per-board event-class table)                                                                                                                                                                                                 | **best** (codec economy target: new board ≈ 200–300 LOC, B §2.1; one-pipeline/3-modes table §4)                                                                                                                                       | **weakest** (half-codec = self-admitted "third asymmetry era", C §9.2.3; calcifies if Waveshare slips)                                                                                                                                           |                                                                                                                                                                                                                                                                                               |
| **5 SD logs** (heavy)               | **best** — slot-verbatim CRC blocks + DICTIONARY/GAP/**SNAPSHOT** records, boot-moment-zero from slot 1, `readSdEvents` pull, ingest CLI (A §1.6, §3.5, §5 row 5)                                                                                        | **worst** — internally inconsistent ("SD **JSONL** sink" at B §1/§2.5/§6 row 5 while citing the recon's CRC32C **binary** blocks); no read-back capability, no ingest tool, no metrics-snapshot persistence, no boot-zero claim       | good — full portable module + fake + simulator now, hardware at the only zero-conflict board, `readSdEvents`, `sd-ingest.ts` (C §3.4); but only _events_ persist — no 1 Hz snapshot record on card                                               | Req 5's spirit is "in case we are not listening"; A's boot-zero + snapshot records answer it most literally                                                                                                                                                                                   |
| 6 keep the best                     | at risk — the spine collapse rewrites the control plane's correctness core; 5 delivery invariants go from two independent implementations to one (A owns it, §10.1)                                                                                      | strong for control plane, but replaces exactly the audio files codex is hardening (B §9.2 "two-front risk")                                                                                                                           | **best** — the entire premise; proof ladder is the invariant, not a milestone (C §1.4)                                                                                                                                                           |                                                                                                                                                                                                                                                                                               |
| 7 three layers                      | **best** (one event vocabulary across L1 goldens / L2 rig witness / L3 checkride, A §5 row 2)                                                                                                                                                            | strong (uplink echo-loop, AEC 3-phase, mic loopback, B §6 row 7)                                                                                                                                                                      | strong (additive scenarios + no-acoustics scenario + frozen per-device acceptance module, C §5 row 7)                                                                                                                                            |                                                                                                                                                                                                                                                                                               |
| **8 devices as streams** (heaviest) | **the whole candidate** — see §2.1 below                                                                                                                                                                                                                 | **worst** — see §2.2; "periphery by design" (B §0 pt 4)                                                                                                                                                                               | good groundwork — see §2.3                                                                                                                                                                                                                       |                                                                                                                                                                                                                                                                                               |
| **9 server-side AEC** (heavy)       | good (pcm.v2 header + rig alignment scenario, A §5 row 9)                                                                                                                                                                                                | **best** — timestamp_echo as a literal processor variant, on-device playout-timeline alignment kills the network-jitter objection, in-band commit doubles as the PTT commit-race fix (B §5)                                           | good (§3.6 header + ladder; same content as B, less integrated)                                                                                                                                                                                  | All three ship the same 16-B xiaozhi-derived header                                                                                                                                                                                                                                           |
| **10 degrade/recover** (heavy)      | **edge** — same four fixes as the others PLUS every ladder rung transition is an event ⇒ degraded matrix "observable by construction"; `wifi-lost {reason, rssi}` durably answers the station-outage lesson (host discarded churn reasons) (A §5 row 10) | parity (four fixes + degraded matrix + reboot rung, B §6 row 10)                                                                                                                                                                      | parity+ (most concrete: ~10/15-LOC patches with line cites, C §5 row 10)                                                                                                                                                                         | All three: gate-reset-on-confirmed-delivery, fleet jitter, retryable pcm start, Wi-Fi on retry_gate, reboot last rung                                                                                                                                                                         |
| **11 session economics** (heavy)    | strong (DeviceLane + `provider-suspended/resumed` gives the device an honest "asleep" state — nice product touch, A §5 row 11)                                                                                                                           | strong (lane split + preroll + rotation before 30-min cap, B §6 row 11)                                                                                                                                                               | **best** — most operational: pre-minted secret pool, await `session.updated`, provider-death → clean EOS instead of the 1011 cascade, `#suppressDownlink` class deleted structurally, billing assumption flagged unverified (C §5 row 11, §10.4) | All three: NO_UPSTREAM→…→COOLDOWN, DO alarms, 90 s idle, ≈$4 vs $115/day                                                                                                                                                                                                                      |
| 12 pluggable I/O                    | strong (per-board event-class table IS the input surface; renderer vtables; stackchan IR verbatim)                                                                                                                                                       | **over-delivers** (+1,100 analysis component now — conflicts with the goal doc sequencing directive, see §3)                                                                                                                          | defers renderer IR entirely to StackChan bring-up — thin but _directionally compliant_                                                                                                                                                           |                                                                                                                                                                                                                                                                                               |
| — late addendum                     | **home turf** ("the minimal device IS the spine", A §0.3; Class-4 proof §4)                                                                                                                                                                              | contained but conceded (periphery = 80 % of modules, 20 % of design attention, B §9.1); the brief itself names B's bet the organizational risk                                                                                        | clean (R3 split + `device.h` include drop + `has_audio`, C §2)                                                                                                                                                                                   | All three: negative link test, class-4 task model                                                                                                                                                                                                                                             |
| goal-doc fidelity                   | 2 dings: camera deleted; one deliberate wire break (M5)                                                                                                                                                                                                  | 3 dings: camera deleted; early avatar work vs sequencing directive; blocking beat vs the sans-I/O portable-core boundary                                                                                                              | **cleanest** — camera kept, avatar deferred per directive, wire v1 pristine, no breaks                                                                                                                                                           | see §3                                                                                                                                                                                                                                                                                        |
| apps/os verbatim alignment          | **best** — verified verbatim (see §5.2)                                                                                                                                                                                                                  | **worst** — zero mentions of `StreamEventInput`/idempotency/`ephemeral`/`metadata.device` (verified by grep)                                                                                                                          | good — "verbatim StreamEventInput", idempotency keys, `ephemeral:true` (C §3.3, §5 row 8)                                                                                                                                                        | `feedback_mirror_appsos_api_shapes`: copy apps/os shapes VERBATIM                                                                                                                                                                                                                             |
| four boards + ESPHome open          | boards yes (classes 1–4); ESPHome never mentioned outside refused-prior-art lists                                                                                                                                                                        | boards **best** (per-board codec impls incl. `ha_vpe.c`, es8311 shared StackChan+Waveshare; names Wi-Fi extraction "the ESPHome-adapter prerequisite", B §7) — but the **blocking-beat codec is the least ESPHome-hostable contract** | boards yes; ESPHome only as "ESPHome posture" for the reboot rung                                                                                                                                                                                | **Shared failure**: none of the three designs the ESPHome adapter the goal doc settles ("Any ESPHome device should ultimately share an ESPHome adapter", goal doc :252-253). HA VPE — an ESPHome device — is treated as a native ESP-IDF board by all three without confronting that decision |

---

## 2. The heaviest requirement, adjudicated: req 8

The brief's wording is maximalist and candidate-discriminating: _"Ideally the
on-device data structure would also be expressed in terms of events shaped
like that with path, type, payload etc **from the earliest moments** — these
could be logged on SD card etc"_, and the device "receives and emits events
for **button presses** etc" (brief :54-61).

### 2.1 A — full discharge, risks priced

- On-device: events from boot slot 1 (`booted`, `config-loaded`, `wifi-*` —
  A §1.6), StreamEventInput-shaped at every serialization edge, RPC commands
  admitted as events where two sources can race (A §1.3 — a principled
  operational rule, not vibes).
- Off-device: real `stream.append` with deterministic idempotency key
  `kit-device:<id>:<bootEpoch>:<sequence>` (exactly-once over at-least-once),
  `kit-voice/*` worker events with `ephemeral:true` transcription deltas,
  userspace `KitDeviceProcessor` with zero apps/os changes, promotion by file
  move later (A §8.1–8.2).
- The only resume story of the three: `subscribeToEvents({afterSequence})`
  mirroring `openConnection({replayAfterOffset, maxReplayOffsetGap})` at
  64-slot scale (A §8.3).
- Honesty clause priced: PCM never events, gauges via side-slot, admission-rate
  law, path-in-record dropped with the platform-side justification (verified
  correct — see §5.2) and flagged to Jonas (Q1).

Adversarial residue: the "ideal" is bought with the highest-risk single move
of any candidate (A §10.1), a permanent write-amplification discipline that is
"a discipline, not a mechanism" (A §10.4), and a fleet-lockstep wire break
(A §10.7). Those are req-6/keeping-risk costs, not req-8 coverage gaps.

### 2.2 B — the requirement is structurally demoted

Verified by grep: the document contains **zero** occurrences of
`StreamEventInput`, `idempotency`, `ephemeral`, or `metadata.device`. Beyond
that:

- No stream path decision, no `KitDeviceProcessor`, no exactly-once story, no
  resume/replay; cross-posting is one clause ("worker cross-posts kit-voice/\*
  from its two logged seams … via bounded drop-oldest outbox", B §6 row 8).
- The requirement's own example — button presses — rides the `intent_queue`
  (B §1, §3 class-1 row: "buttons→intent queue"), and B never states that
  input edges are mirrored into the observability ring; only the VPE mute
  switch is explicitly "published as an intent + event" (B §3 class 3). So the
  events the requirement names may literally not exist on the device's event
  surface as specified.
- "The on-device data structure expressed in terms of events from the earliest
  moments" is precisely what B refuses ("deliberately NOT the organizing
  principle: no dispatch rides it", B §0 pt 4) — and it maintains TWO
  event-shaped structures (intent queue + observability ring), which is a
  worse mechanism count than v1 on this axis, not better.

B owns this trade (§9.1, §11: "it optimizes the 80 % of modules that aren't
the product's hard part"). Owned or not, under a lens that weights req 8
heaviest, it fails the round's central ask.

### 2.3 C — honest groundwork, capped ideal

- Covers: interned URI `.def` table, 24-B entry with sequence/bootEpoch,
  sink-side serialization to "verbatim `StreamEventInput`", deviceId TLV +
  NVS bootEpoch (correctly identified as a _prerequisite_ — two Sticks on one
  project collide today), idempotency-keyed appends, `KitDeviceProcessor`,
  `ephemeral:true` deltas (C §3.3, §5 row 8). This is arguably the literal
  reading of "start laying the groundwork".
- Caps: coalesce-newest kept, no replay — short control-plane outages produce
  durable gap events where A replays 64 slots ("the 2-to-64-event window is
  accepted loss", C §9.2.4); the 8-byte payload already loses fidelity on day
  one (C's own incident payload carries "kind+value" where A's 12-byte version
  keeps kind/detail/value/total); events remain one of **four** parallel
  delivery machines, so "the on-device data structure" clause is only
  half-honored, deferred behind a trigger ledger (C §9.3 row 1: redesign only
  after the _third_ cross-machine bug).

---

## 3. Goal-doc fidelity findings (settled decisions, checked adversarially)

1. **Camera/photo.** The goal doc settles: StackChan must expose "taking a
   camera photo and returning it" (:127), "Taking a photo is a first-class
   capability and is also a Cap'n Web compatibility test" (:208-210), and
   "Metrics subscriptions and photo transfer are important compatibility
   cases" (:109-110). **A deletes the camera capability** (−160, "defer until
   a target needs it", A §6) and **B deletes it too** (B §7). The trigger
   "until a target needs it" is already true-now: StackChan is on the hub with
   a settled camera requirement. C keeps it and calls the deletion "churn, not
   reduction" (C §1.2) — the only candidate compliant here. (Small LOC, real
   fidelity signal: it shows which candidate re-read the settled decisions.)
2. **Avatar sequencing.** The goal doc's hardware-sequencing continuation:
   "Do not spend time on face/avatar rendering until everything else in these
   slices works" (:635). B lands a +1,100-LOC analysis component early
   (mitigated to spectral+envelope, owned as shelfware risk §9.2) — against
   the directive. C defers entirely — compliant. A adopts the structure but
   schedules `components/analysis` "(later)" — compliant.
3. **Portability boundary.** "Allocation-free portable C core" plus v1's
   review-praised sans-I/O testability: B's blocking `next_beat` is a
   deliberate break ("philosophical break with v1's sans-I/O purity", B §9.2),
   correctly escalated as Jonas decision #1 with C's nonblocking `next_event`
   shape as the in-candidate fallback. Not a violation — the boundary is
   delegated to judgment — but it bets against the property the review names
   v1's biggest advantage over all prior art (review §3), and it is the least
   ESPHome-hostable codec contract (ESPHome components are loop-scheduled; a
   blocking owner call demands its own task inside someone else's framework).
4. **Wire v1 stays.** All three compliant; B/C negotiate `iterate.kit.pcm.v2`
   alongside via subprotocol — consistent with "Negotiate other formats only
   in a later protocol version" (:189). A's M5 event-batch wire break is a
   _control-lane_ schema break, allowed pre-1.0, but it is the only
   fleet-lockstep deploy any candidate requires (A §10.7, Q2).
5. **Observability core/outer split** (:298-313): A's spine+sinks is the
   cleanest structural embodiment (fixed-cost core records; capnweb sink =
   normal path; SD = separately selectable outer sink; per-sink gap/drop
   counts by construction). C keeps the split as-is. B satisfies it too but
   with the JSONL ambiguity of §1 above.
6. **Requirement-10 station-outage lesson** (memory ledger: churn replies
   carried a Wi-Fi reason the host discarded; control non-recovery was a
   second defect): A is the only candidate that makes the reason durable
   end-to-end (`wifi-lost {reason, rssi}` → SD + stream); C carries
   reason+rssi in the payload; B never specifies the wifi payload.

---

## 4. Scores under this lens

| Candidate               |   Score | One-line justification                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A — event-spine**     | **8.5** | Only candidate that fully discharges reqs 8 and 5 as worded, with the strongest apps/os verbatim alignment and best req-1/10 coverage; docked for the req-6 risk concentration (one delivery implementation, wire break) and the camera fidelity miss                                                  |
| **B — pipeline-purist** | **5.5** | Best req 9/3/4 and the best four-board _audio_ story, but materially worst on the two heaviest-weighted new asks (8, 5), worst apps/os mirroring (verified zero verbatim-shape content), and its organizing bet is the one the late addendum explicitly names as the risk                              |
| **C — minimal-delta**   | **7.5** | Every new ask covered to "adequate-or-better" with the best goal-doc fidelity, codex coexistence, and req-11 operational depth; docked for deliberately failing req 1, capping req 8's ideal clause (no replay, 8-B payloads, 4 machines forever-until-trigger), and the half-codec asymmetry on req 4 |

Sensitivity note: these ranks are weight-dependent. If Jonas reads req 8's
"ideally" as genuinely optional groundwork, C rises to ≈8.2 and A drops to
≈8.0 (the spine's risk stops paying for anything mandatory). If the audio
half of the goal doc ("where audio IS present it MUST be realtime, resilient,
good AEC") were this lens's weight instead, B would lead — that is the other
judges' territory.

---

## 5. Verification appendix (claims checked against real source)

1. **Five-boolean duplication** (A's motivating fact, B/C both cite): real.
   `components/capabilities/include/iterate/kit/capabilities/device_event_stream.h:70-74`
   carries `occupied/call_in_flight/callback_budget_reserved/release_pending`
   exactly as claimed duplicated against the metrics scheduler slots.
2. **A's apps/os mirroring is verbatim-accurate**:
   `packages/iterate/src/processors/schemas.ts:11-83` confirms
   `StreamEventInput = {type, payload?, metadata?, source?, idempotencyKey?,
ephemeral?: literal(true)}` with `source` reserved for platform
   processor/copiedFrom provenance (validating A's "never emit `source` at top
   level") and `StreamEvent` adding `offset/createdAt/path` **at commit**
   (schemas.ts:88-93) — validating A's no-path-in-slot argument and C's
   sink-side-serialization plan. B never engages with any of these shapes
   (grep: 0 hits for StreamEventInput/idempotency/ephemeral/metadata.device).
3. **`device_events` entry is 2 bytes today with the marshalling contract as
   quoted**: `components/core/include/iterate/kit/device_events.h:28-35`
   ("deliberately costs two bytes per pending event"), :75-85 ("Platforms must
   first marshal ISR/cross-core edges onto the owner task"). C's widening plan
   and A's tributary generalization both rest on real text.
4. **The worker's `wouldPostToStream` seam exists as described**:
   `apps/kit/src/userspace/config-worker/worker.ts` `#subscribeToDeviceEvents`
   logs device events as "something that WOULD be cross-posted, while no
   durable stream semantics are implied" — the exact seam A/C replace with
   real appends and B leaves one clause for.
5. **B's SD inconsistency**: grep confirms "SD JSONL" at B lines 92/561/722
   coexisting with "CRC32C blocks" claimed from the sd recon in the same
   sentences; no `readSd`/ingest mention anywhere in B.
6. **Camera deletion**: A §6 deletion table (−160 "audit e") and B §7 deleted
   list, vs goal doc :108-110/:127/:208-210 settling photo as first-class +
   compatibility case. C §1.2 keeps it.

---

## 6. Hybrid recommendation (what to graft from whom)

Use **A's event model as the requirements backbone** — the 64-B interned
envelope + X-macro `.def` single source, StreamEventInput-verbatim serializer,
boot-moment-zero vocabulary, idempotency-keyed worker cross-post +
`KitDeviceProcessor`, the `subscribeToEvents({afterSequence})` resume shape,
and the SD sink with slot-verbatim blocks + SNAPSHOT/GAP/DICTIONARY records —
because it is the only design that discharges reqs 8 and 5 as worded and the
only one whose wire shapes verified verbatim against apps/os. But land it
under **C's delivery discipline**: new-files-first waves, proof ladder green
at every gate, codex-conflict sequencing, and C/B's "one delivery machine, two
data sources" (Option B) instead of A's metrics side-slot until Jonas
explicitly buys the purer spine (A itself concedes the side-slot is "a
compromise wearing a design's clothes" and reversible). Graft **B's audio
center wholesale where audio exists** — codec properties + processor seam,
one-pipeline/three-modes with the "new mode = policy row, zero new states"
architecture test, `timestamp_echo`-as-processor for req 9, and the
200–300-LOC-per-board codec economy target — but on **C's nonblocking
`next_event` codec contract** rather than B's blocking beat, since it
preserves the sans-I/O testability the review calls our biggest edge and is
the only shape plausibly hostable inside a future ESPHome adapter (which no
candidate designed and the final plan must at least sketch). Keep C's camera
retention, avatar deferral, frozen `device-e2e.ts`, and its req-11 operational
details (pre-minted secret pool, await `session.updated`, provider-death →
clean EOS); adopt A's rung-transitions-as-events so the req-10 degraded matrix
stays observable by construction.
