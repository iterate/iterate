# Kit v2 — open questions

Status: 2026-07-31, updated after the evening codex-alignment pass (PLAN
v1.2, DECISIONS §8). Everything still genuinely open, none of it
architectural. G11 and G18 are settled, and G16 was settled and then
reversed the same day (the media transport is the two WebSockets — the
reversal is [`DECISIONS.md`](DECISIONS.md) §7); all three live in
DECISIONS.md. The register numbers below are kept stable from the original
G1–G17 list so answers stay traceable.

Two kinds of item live here:

- **Questions for Jonas.** Each states the question, why it matters, the
  default the plan currently runs on, what changes if answered differently,
  and when the default hardens (the point after which flipping it costs
  real rework). Silence means the default ships.
- **Measurements and go-aheads** (§3) and the **watchlist** of external
  facts that can move under us (§4).

When an item is answered: edit PLAN.md, add the entry to DECISIONS.md,
delete it here.

---

## 1. Needs an answer soonest

### G2 — name the codex checkpoint; who declares quiet windows

- **Question:** which commit of codex's v1 work is the checkpoint that
  gates stage 3, and how are the codex-quiet windows (stage 2) declared?
- **Why it matters:** stage 3 regenerates the metrics schema codex is
  actively editing; stage 2 touches audio files. Until the checkpoint is
  named, only no-collision work (stages 0–1) proceeds.
- **Since the alignment pass (PLAN v1.2):** the checkpoint also fixes
  every moving baseline v1.2 dated against it — the metrics.c/main.cpp
  line counts, the DIRAM re-measure (the 8 KiB TLS-owner stacks added
  ~7.2 KiB static), the `device-e2e.ts` re-freeze (2,746 lines at the
  evening recon), and the vendor-capnweb dead-surface re-audit. Much of
  codex's day is uncommitted or untracked (`device_event_stream`, the
  whole config worker), so the checkpoint must be a commit that actually
  contains that work. D6's trigger (b) — codex's event work landed and
  stable — is close: the event stream has been stable in the working tree
  since the morning of 2026-07-31.
- **Assumed default:** parallel agent, new-files-first; Jonas names the
  checkpoint commit and acks each stage opening in the task doc.
- **If answered differently:** handoff-to-codex after v1 lands → stages 2–3
  can be aggressive and several "generalize in place" choices become
  cheap "replace".
- **Hardens:** the moment stage 2 wants to open.

### G15 — an owner for the warts list; confirm the definition of done

- **Question:** who owns the eight-entry known-warts list (PLAN §8), and is
  PLAN §7's done-list confirmed as written?
- **Why it matters:** every wart carries a measurable fix-trigger; triggers
  are review discipline, not mechanism. A deferred fix with no owner is how
  v1.5-forever happens — the failure mode the whole minimal-delta strategy
  bets against.
- **Assumed default:** the list is a standing review item with Jonas as
  owner of record; the done-list stands as written.
- **If answered differently:** no owner → the honest alternative is pulling
  the v2.1 merge into v2.0 now (deferred-with-no-owner is the worst of
  both); a slimmer done-list → say which proof drops, each maps to a
  requirement.
- **Hardens:** immediately — it is governance, not code.

### G17 — the 160→240 MHz CPU flip and the uncommitted rail-sag fix

- **Question:** flip the Stick's CPU to 240 MHz in stage 1 behind the rig
  gate (tone + endurance + brownout-history check green before it sticks;
  reverting is one line), or hold at 160 MHz until the −18 dB rail-sag fix
  is committed and re-proven?
- **Why it matters:** every shipping S3 voice stack runs 240 MHz and
  esp-sr's CPU budgets assume it (~1.5× at 160 MHz); but the Stick has a
  brownout history under audio load and 240 MHz raises draw.
- **Assumed default:** flip in stage 1 behind the rig gate.
- **If answered differently:** hold at 160 → the stage-1 chore shrinks.
- **Hardens:** stage 1 execution. Related watch item: the rail-sag fix
  itself is still uncommitted (§4) and separately confounds the
  battery/brownout endurance numbers.

---

## 2. Register items running on assumed defaults

Lower urgency: each has a recommended default already written into PLAN.md,
and a real fork Jonas can still take.

### G1 — event-machinery ambition

- **Question:** does the merge down to one delivery mechanism stay a
  trigger-driven v2.1 milestone, or land inside v2.0?
- **Why it matters:** the maximal reading of requirement 8 puts the
  one-machine end state in v2.0; the risk ledger (racing codex's in-flight
  event stream, ~2× underestimated additions) says defer.
- **Assumed default:** event format everywhere now; machinery merge at the
  D6 trigger (third cross-mechanism fix, or codex's event work stable).
- **If answered differently:** the merge lands in stage 4 with the
  side-by-side log-diff gate mandatory, accepting the codex race.
- **Hardens:** gradually — each mechanism generalized in place makes the
  later merge cheaper, an early merge riskier.

### G3 — how requirement 1 ("less code") binds

- **Question:** literal total-line-count reduction, or complexity
  concentration?
- **Why it matters:** it decides how v2.0 is judged. Audited honest
  ceiling: −8 % without cutting proven audio/test code; the plan lands
  −3…−5 % in v2.0, plus the structural counts (schema spelling sites 7→1,
  delivery mechanisms 4→2→1, the call model deleting the turn-boundary
  machinery outright).
- **Assumed default:** complexity concentration.
- **If answered differently:** literal → pull the v2.1 merge forward and
  delete host-paced delivery (the server-paced alternative to the
  device-clocked default stage 0 sets — two settings of the same delivery
  knob) plus other live-but-redundant surfaces now (conflicts with G12's
  camera guard).
- **Hardens:** when v2.0 is judged done (PLAN §7).

### G4 — board order and the HA Voice PE track

- **Question:** confirm Waveshare → StackChan → HA Voice PE, with VPE as
  purpose-built firmware and the ESPHome adapter designed-for but not
  built.
- **Why it matters:** Waveshare is the SD landing vehicle (only
  conflict-free slot), the codec-interface value test, and the
  playback-fold trigger (D2); StackChan is the maximum-risk audio phase.
  The goal doc and the adapter task doc point opposite ways for VPE.
- **Assumed default:** as stated (PLAN stage 5).
- **If answered differently:** StackChan first → the playback fold and the
  first real AEC land simultaneously (schedule slack), SD hardware waits;
  VPE-on-adapter → the adapter enters v2 scope and VPE's "audio must be
  realtime" needs an answer the adapter's control-only first scope
  excludes.
- **Hardens:** stage 5 opening.

### G5 — voice barge-in on the Stick (reshaped by G18)

- **Question:** is talking over the assistant on the Stick a product goal
  worth funding the server-side echo-cancellation ladder beyond its free
  rungs? Under the call model the Stick's interruption is a button tap;
  voice barge-in there requires the server to cancel the assistant's own
  audio out of the mic signal.
- **Why it matters:** the Stick can never do on-device AEC (PDM mic, no
  reference channel). The ladder now: speak-state gating (built server-side
  in stage 4, free) → a server-side canceller (the speex echo canceller
  compiled to WebAssembly, benchmarked first — estimated ~1–3 % of a worker
  core; the `/pcm` path is bit-transparent, so the server holds the exact
  downlink waveform it sent, and D7's timestamp echo provides the
  alignment) → true voice barge-in.
- **Assumed default:** gating only; the canceller waits for demonstrated
  product pull.
- **If answered differently:** "yes, fund it" → the WASM benchmark moves
  into v2.0 next to the stage-4 worker work.
- **Hardens:** stage 4 scope freeze.

### G6 — the one wire break (reshaped by G18)

- **Question:** when does the control-plane event batch shape move to the
  apps/os `StreamEventInput` shape verbatim? (The other half of the
  original question — the in-band commit replacing the control-lane commit
  — died with G18: no commits exist.)
- **Why it matters:** it is the only fleet-lockstep firmware+worker deploy
  anything requires, allowed pre-1.0, and it lands while codex's v1 worker
  is the production consumer.
- **Assumed default:** bundled with the v2.1 merge, and optional even then.
- **If answered differently:** now → stage 4 grows the lockstep ceremony;
  never-unless-forced → the flat v1 batch shape survives indefinitely.
- **Hardens:** v2.1.

### G7 — which capability calls become events

- **Question:** confirm the line: anything two sources can race on
  (mute-toggle, gain changes — connect/hang-up are already events per
  PLAN §2) goes through the event core so the total order arbitrates;
  imperative side effects (screen render, servo moves) stay direct calls;
  reads never. And: is resume/replay (`subscribeToEvents({afterSequence})`,
  ≤64-slot replay) required in v2.0?
- **Why it matters:** without the line, every future racy knob reinvents
  ordering; with "everything-as-events", every capability pays
  amplification. Replay turns short control-plane outages from durable gaps
  into recovered events.
- **Assumed default:** racy-knobs-only; the replay argument sits in the
  wire contract now and is implemented when the widened ring lands.
- **If answered differently:** replay-day-one moves the ring work into
  stage 4's critical path.
- **Hardens:** stage 4's event-type table.

### G8 — record-shape details (embedded in D4/D5)

- **Question:** final confirmation of three sticky representation choices —
  40-byte payloads, no `path` field in the on-device record (one device =
  one stream), device identity in `metadata.device`.
- **Why it matters:** each was verified against the apps/os schema and each
  is annoying to migrate after the generator and SD dictionary exist.
- **Assumed default:** yes to all three.
- **If answered differently:** per-record paths (+2-byte interned column)
  make sub-streams like `/kit/devices/<id>/voice` expressible.
- **Hardens:** stage 1's generator scaffold — confirm before it lands.

### G9 — SD on-card format

- **Question:** binary (the 64-byte records verbatim in CRC-protected
  blocks, decoded by the `read-sd-card-log` CLI) or JSONL a laptop can
  read?
- **Why it matters:** binary wins crash-exactness (torn tail =
  CRC-detected, never garbage), 3–5× density, zero publisher-side
  formatting; JSONL wins requirement 5's pull-the-card-into-a-laptop
  spirit. Value-laden, not technical.
- **Assumed default:** binary + CLI; the 1 Hz metrics snapshots also go to
  card.
- **If answered differently:** JSONL → bigger, snprintf on the publisher
  path, torn-tail ambiguity accepted, and the gap-analysis tool is still
  needed.
- **Hardens:** stage 4's writer.

### G10 — SD privacy posture

- **Question:** cards will hold transcription-adjacent events and
  connection metadata on removable, unencrypted storage — and under the
  call model an open call is a hot mic, so the events are chattier than
  under PTT. Default-on for dev devices? Encrypt at rest?
- **Why it matters:** it is the one place the plan writes
  conversation-adjacent data somewhere physically walk-away-able.
- **Assumed default:** on by default for the dev fleet, no encryption in
  v2.0, provisioning flag to disable.
- **If answered differently:** encryption required → per-segment AES lands
  with the writer, laptop readability dies, and G9's JSONL option dies
  with it.
- **Hardens:** the first board with a slot leaves the desk (Waveshare,
  stage 5).

### G12 — goal-doc guards (camera, avatar timing)

- **Question:** confirm camera stays and face/viseme analysis waits for
  StackChan (then adopts the stackchan 40-byte render record verbatim).
- **Assumed default:** yes to both.
- **If answered differently:** avatar earlier → integer spectral + envelope
  analysis only, MFCC stays host-side.
- **Hardens:** stage 5.

### G13 — any local VAD at all (reshaped by G18)

- **Question:** with the provider's server VAD owning turn-taking on every
  board, does StackChan bring-up need any on-device voice-activity
  detection (for example as a cheap uplink gate or a wake-word
  prerequisite)?
- **Assumed default:** none; add only if bring-up shows a concrete,
  measured need. (The AEC choice itself — standalone FD_LOW_COST — is
  settled; DECISIONS §6.)
- **If answered differently:** a local VAD joins the audio-processing
  interface's implementations with its own DIRAM ledger entry.
- **Hardens:** StackChan bring-up.

### G14 — testing posture

- **Question:** confirm the frozen-e2e rule (new scenarios as siblings,
  shared plumbing extracted at the fourth), nightly non-blocking rig runs,
  the manual checklist per flash, and the audio-less CI citizen now. The
  freeze baseline is re-taken at the G2 checkpoint: the file is 2,746
  lines at the evening recon (not the 1,752 v1.1 froze) and still growing,
  while the sibling pattern already runs as the `prove-production-*.ts`
  scripts.
- **Assumed default:** yes to all — the only frame that survives the live
  git status.
- **If answered differently:** decompose `device-e2e.ts` now → −600 lines
  sooner, at refactor risk on the physical-evidence path with no green-run
  diff protecting it — a fork that gets more expensive every week the file
  grows; strictly-manual rig → regressions like capture
  starvation surface only when someone remembers.
- **Hardens:** stage 2's first sibling scenario and the nightly setup.

---

## 3. Measurements awaiting go-ahead

Both are small paid probes against the live xAI API, run from the
scratchpad, never touching the worktree.

- **xAI billing probe — demoted to tuning by D8's reshape.** Open a
  session, send nothing for ten minutes, read the bill: per-connected-minute
  or per-processed-audio-minute? With media strictly on-demand there is no
  always-on cost for this to veto — it now only tunes the conversation idle
  window and the warmth-policy defaults. Run it before those defaults are
  frozen past "dumb" (stage 4); freezing conservative without it is
  acceptable.
- **Cold-dial benchmark.** Twenty scripted dials against `api.x.ai` with
  per-phase timestamps (secret mint / WebSocket connect /
  `session.updated`), prior estimate 300–850 ms. Measures D8's cold-start
  number (connect → provider ready) and sizes the on-device preroll ring.
  Transport-independent — it measures the Grok dial itself. Run standalone
  from the scratchpad whenever convenient, before stage 4 freezes the
  warmth-policy defaults.

---

## 4. Watchlist — external facts that can move under us

Standing review at each stage boundary (the cadence PLAN §4 already
prescribes).

| Item                                                                                             | Why it is watched                                                                                                                                                                                                                                                                                                                                         | On change                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| xAI realtime session cap + resumption cache                                                      | The 30-minute session cap and 30-minute session-resumption cache underpin rotation and conversation memory (D8); verified live 2026-07-31                                                                                                                                                                                                                 | Re-verify the cap/cache numbers before stage 4 freezes the rotation and warmth-policy defaults                                         |
| xAI pricing ($0.08/min, web-sourced)                                                             | Feeds the warmth-policy cost inputs                                                                                                                                                                                                                                                                                                                       | Confirm against a real bill when the billing probe runs                                                                                |
| esp-sr releases                                                                                  | FD AEC types arrived in 2.4.3; `aec_nlp_level` semantics are the one echo-vs-near-end lever                                                                                                                                                                                                                                                               | Re-check the FD tables and the stage-5 budget numbers at StackChan bring-up                                                            |
| esp-gmf                                                                                          | Refusal upheld with a named trigger                                                                                                                                                                                                                                                                                                                       | Runtime-recombinable media graphs or the codec matrix ever needed → re-evaluate GMF v1.x before hand-rolling                           |
| ESP32-P4 + ESP32-C6 board class (a bigger application chip paired with a Wi-Fi companion chip)   | Nothing in the design precludes it; escalation triggers recorded                                                                                                                                                                                                                                                                                          | Sustained audio-processing load >60–70 % of a core, or dropouts surviving the stage-2 fixes → open the board question                  |
| The −18 dB rail-sag fix (in the working tree since the morning of 2026-07-31, still uncommitted) | Gates G17's CPU flip and confounds the battery/brownout endurance numbers until committed and re-proven                                                                                                                                                                                                                                                   | Commit + re-prove, then unblock both                                                                                                   |
| TCP-stall telemetry (stage-2 churn scenarios + nightly rig)                                      | Kept deliberately after the transport reversal (DECISIONS §7): recorded stall telemetry is the evidence that would ever reopen the transport decision                                                                                                                                                                                                     | A sustained pattern of multi-second stalls in the nightly trend → reopen the transport question with data in hand                      |
| Live-bug liveness (stage 0's lab-proxy fix)                                                      | One of v1.1's two proxy bugs is already fixed (the oversized-provider-message bound); the survivor — the suppressed-downlink leak — lives only in the lab proxy, since the deployed bridge has no server-VAD mode                                                                                                                                         | Re-check at stage 0 execution; the rule itself (suppression clears regardless of input mode) goes into the v2 media session either way |
| Lab-proxy/deployed-bridge divergence (`DevicePcmProxy` vs `PcmSessionBridge`)                    | The two host PCM implementations diverged within one day; every day before the shared media-session module (PLAN §5) lands widens the merge                                                                                                                                                                                                               | A second contradictory fix across the pair → pull the shared-module merge forward                                                      |
| Bring-up confirmations on physical hardware                                                      | Vendor-source-verified claims awaiting one physical check each: Waveshare SD pins (CLK=2/CMD=1/D0=3, SDMMC 1-bit); StackChan ES7210 TDM slot-1 echo reference + AW88298 register 0x06=0x20; HA VPE post-XMOS 16 kHz echo-cancelled input, 48 kHz output, ESP32 as I2S clock-slave; idle-heap re-measure on the running Stick (needs a codex-quiet window) | Confirm at each board's bring-up; a miss reopens the relevant stage-5 design detail                                                    |
