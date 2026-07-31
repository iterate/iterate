# Kit v2 — decision log

This file is the history. [`PLAN.md`](PLAN.md) states only the current plan;
every entry here records **when** a decision was settled, **by whom**, **what
it replaced**, and **why** — plus every correction of record. All of it
happened on **2026-07-31**, in one planning day; where a decision moved
during that day, the entry says so — including the day's final move, the
transport reversal (§7). "Jonas" means Jonas settled it in chat;
"planning agents" means it was settled by verified evidence and Jonas did not
object when it was presented.

Section 1 is the part Jonas acts on personally: the amendments he has
made to the goal document. Nothing in this folder edits
`../physical-device-voice-goal.md` — Jonas carries those changes over
himself.

---

## 1. The goal-document amendments (Jonas, 2026-07-31)

The goal document (`../physical-device-voice-goal.md`) is the authoritative
record of settled product decisions. Two of its decisions stand amended
(§1.2, §1.3); a third amendment (§1.1) was made and then **withdrawn by
Jonas later the same day**, so the goal doc's transport decision stands
unamended. Until he edits that file, this table is the record.

### 1.1 WITHDRAWN — target media transport: the WebRTC lane (made and reversed the same day)

- **Goal doc says (and still says, unamended):** the media architecture is
  two independent WebSockets — `/api` (Cap'n Web control) and `/pcm` (raw
  PCM frames) — and the device maintains both at all times.
- **The amendment as made:** the _target_ media path would become the WebRTC
  lane — Opus (a lossy speech codec) over UDP to the Cloudflare Realtime
  SFU, whose WebSocket adapters bridge the audio into our media session as
  PCM — with the proven WS PCM path as default-until-proven and fallback
  after. Settled by Jonas after the WebRTC trawl (_"okay, let's actually
  include that in our plan now. this is what i want."_), overriding the
  trawl's own more conservative recommendation (§4.2, G16). Its rationale:
  UDP loss tolerance plus Opus packet-loss concealment on the device↔edge
  air link, where our receive-stall research measured a ≥4.2 s Wi-Fi outage
  that TCP silently converted into stall-then-burst. A same-day follow-up
  committed the M5StickS3 as a WebRTC-lane target.
- **Withdrawn:** later the same day, after Jonas tried the WebRTC direction
  (§7). The goal doc's two-WebSocket decision stands **unamended**;
  requirement 10 keeps its original wording ("the devices must attempt to
  maintain the two websocket connections at all times"). The
  Stick-as-committed-WebRTC-target statement fell with it.

### 1.2 Interaction model: the call model replaces the per-board PTT/VAD split

- **Goal doc said:** StackChan = full duplex with VAD and AEC; M5StickS3 =
  half-duplex push-to-talk. Two interaction models, chosen per board.
- **Amended to:** one call model on every board — button connects, button
  hangs up, the provider's server VAD does all turn-taking, mute is a
  separate device-local function, push-to-talk is not built in v2 at all.
  Full statement: PLAN §2. Decision history: §4.3 (G18) below.
- **Settled:** Jonas, the last decision of the day: _"okay lock that in."_

### 1.3 Requirement 11: "nothing flows when inactive" replaces "the PCM frames keep coming"

- **Brief and goal doc said:** requirement 11 read "we cannot afford to have
  a Grok realtime voice session on at all times … the server side might
  after some inactivity hang up — **but the PCM frames keep coming (for
  now)**."
- **Amended to:** when no conversation is active, **nothing** flows — no
  PCM frames, no Grok session. Both WebSocket connections stay up
  (requirement 10 unchanged); media is started and stopped over the control
  plane by either side (D8).
- **Settled:** Jonas: _"oh, we should not send PCM frames anymore on
  inactivity … device ALWAYS has a websocket / control plane connection to
  a stateless worker that we can use to tell the device 'start sending
  stuff on webrtc now' … server or device can decide it's inactive and stop
  the webrtc stuff."_ (As first written the amendment was phrased in WebRTC
  terms; the transport reversal (§7) re-grounds it on the two WebSockets —
  the substance, media strictly on demand, is unchanged and was not
  reversed.)
- **Why:** with the provider leg per-conversation, always-flowing PCM buys
  nothing and costs bandwidth, battery, provider money, and a hot-mic
  posture.

---

## 2. How the plan moved during the day (versions of record)

| Version          | What changed                                                                                                                                                                                                                                                                                                                                                                                                                     | Trigger                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1 → v0.2      | First condensed plan out of the exploration round: composite architecture (candidate C's migration frame + B's audio seams + A's event format), D1–D8 first stated, decision register G1–G15 opened with recommended defaults assumed                                                                                                                                                                                            | The synthesis (`exploration/synthesis-and-open-questions.md`) closing the three-candidate + three-judge round                                                                                               |
| v0.2 → v0.3      | Prior-art report trawl folded in: IRAM premise refuted → DIRAM ledger (§5.1), stage-1/2/3 resource chores rewritten (PSRAM 80 MHz, CPU-240 gate, lwIP pinning, flash-write invariant), register grew to G1–G17                                                                                                                                                                                                                   | Jonas supplied an unverified prior-art research report and asked for every claim to be trawled and decisions potentially reopened (`exploration/webrtc-verdict-and-reopened-decisions.md`)                  |
| v0.3 → v0.4      | The transport track (W1–W4) added after Jonas chose the WebRTC lane as target (G16); then the track adversarially reviewed the same day by three independent verifiers and every fix folded in (SFU-leg lifecycle, stereo format, per-direction adapter reconnect, PRBS-through-Opus refutation, DIRAM arithmetic, W2 devkit scoping)                                                                                            | _"okay, let's actually include that in our plan now"_; `exploration/transport-track-adversarial-findings.md`                                                                                                |
| v0.4 → 1.0-draft | D8 reshaped twice by Jonas (stateless worker; media strictly on-demand — §3, D8) with the warmth-policy decomposition; G18 (the call model) settled and propagated everywhere; the accumulated amendment sediment mined into this file and the plan rewritten clean                                                                                                                                                              | Jonas's stateless-worker question, the "nothing flows when inactive" amendment, the secretary-button message, and _"okay lock that in and use some subagents to update / clarify / design the docs better"_ |
| 1.0-draft → 1.1  | THE TRANSPORT REVERSAL: Jonas tried the WebRTC direction and cancelled it — the transport track (W1–W4) removed from PLAN.md, dual WebSockets reinstated as the media transport, goal-doc amendment §1.1 withdrawn, requirement 10 restored to its original wording, D7 and the chip-exact oracles back in full scope on the one media path; D8's media-on-demand reshape and G18's call model kept (both transport-independent) | _"okay actually we DO NOT want the webrtc stuff now - i tried it"_ — full entry: §7                                                                                                                         |
| 1.1 → 1.2        | The codex-alignment pass: drifted codex-v1 facts corrected (peer-delivery guard deleted, event stream + callback budget finished, the provider/device seam and commit-ack fence already deployed, one stage-0 proxy bug already fixed, D8's "unchanged from v1" list corrected — §5.5), eleven codex mechanisms adopted into PLAN, the test-dependency ladder added to PLAN §5                                                   | Jonas's evening directive to review codex's current implementation and align, plus the test-ladder directive — full entry: §8                                                                               |

---

## 3. D1–D8 — provenance

The full current statement of each decision is PLAN §3; evidence and
confidence notes are in `exploration/synthesis-and-open-questions.md` §2.2.
This section records only where each came from and how it changed.

- **D1 — non-blocking audio-hardware interface.** Settled by the synthesis;
  all three adversarial judges independently landed on it. Superseded:
  candidate B's blocking "wait for the next beat" design (B's own risk
  register named the non-blocking shape as its fallback). Why: a blocking
  read has a hole on half-duplex boards (a mode switch would sit out the
  timeout), host tests stay plain function calls, and ESPHome's cooperative
  `loop()` scheduler can host it. Unamended since.
- **D2 — capture moves now, playback moves at Waveshare.** Settled by the
  synthesis. Superseded: moving the whole audio path behind the new
  interface at once. Why: the capture move is forced (the v1 review's top
  defect — capture starving on the main task); the ~3,600-line playback
  stack is physically proven and gets zero-risk treatment until a second
  board needs it, then a byte-identical gate. Unamended since.
- **D3 — audio-processing interface now, implementations later.** Settled by
  the synthesis. Superseded: candidate C's "design the seam when StackChan
  arrives" (the realtime judge showed C's own AEC text contradicted
  esp-sr's actual API) and candidate B's "build the pipeline machinery
  now" (speculative generality). Why: the contract text — fail-closed
  silence, complete-frame references, reference-ring resets, pipeline-owned
  frame-size conversion — costs nothing now and prevents redesign at
  maximum-hardware-risk time. Reinforced (not changed) by the AFE-profile
  trawl (§6.1).
- **D4 — one 64-byte event record, one generated schema.** Settled by the
  synthesis. Superseded: candidate C's 8-byte payload record (no headroom —
  the incident payload already did not fit) and the status quo of the
  metrics schema hand-spelled in about seven places. Why: one table file
  generating every reader and writer is the largest complexity win every
  candidate agreed on (~2,260 lines removed). Unamended since.
- **D5 — wire shapes copied from apps/os exactly.** Settled by the
  synthesis; field names verified against
  `packages/iterate/src/processors/schemas.ts`. Superseded: inventing a
  device event shape and mapping later. Why: `metadata.device` (never
  `source`, which is platform-reserved), no `path` field on device (path is
  assigned at commit), and the `kit-device:<deviceId>:<bootCounter>:<sequence>`
  idempotency key make at-least-once delivery compose to exactly-once on
  the stream. Surfaced the per-device-id prerequisite. Unamended since.
- **D6 — keep four delivery mechanisms; merge at a trigger (v2.1).** Settled
  by the synthesis — the day's most contested call. Superseded: candidate
  A's collapse-to-one-machine in v2.0 (two of three judges overrode it;
  A's additions were ~2× underestimated and raced codex's uncommitted
  `device_event_stream` files) and any dateless deferral (the trigger is
  named). **Amended same day:** its standing rule "zero net IRAM growth
  (there is ONE byte free)" was replaced by the DIRAM ledger after the
  premise was refuted — correction §5.1.
- **D7 — optional 16-byte PCM frame header.** Settled by the synthesis; all
  three candidates independently specified the identical header (layout
  from xiaozhi's proven protocol v2). **Original scope: two jobs** —
  timestamp echo, and an in-band end-of-turn frame that killed the
  cross-socket commit race on PTT release. **Amended twice:** (1) the
  transport-track adversarial review corrected the claim that RTP covers
  the header's jobs on the WebRTC lane (RTP carries uplink timing only;
  timestamp echo needs a device-side playback-position report — findings
  file, both "requirement 9" findings); (2) **G18 deleted the end-of-turn
  job entirely** — no manual commits exist anywhere. **Then re-grounded by
  the transport reversal (§7):** with the WebRTC lane cancelled, amendment
  (1) is a historical caveat — the header applies to the one media path,
  the `/pcm` socket, where it is again the server-side-AEC groundwork
  mechanism. Current scope: timestamp echo only, on `/pcm`.
- **D8 — always-on control plane; media strictly on demand.** The decision
  that moved the most. **First form** (synthesis, v0.1–v0.2): a worker
  split into a device-connection half and a provider-session half on a
  per-device Durable Object with alarm-driven states
  (dialing → active → draining → cooldown), a 90 s idle hangup, ~25 min
  rotation, transcript replay, and a server-side 2 s mic preroll ring —
  with "the PCM frames keep coming" per requirement 11 as then written.
  **Reshaped twice by Jonas (same day):**
  1. _"why are you saying 'our DO'? why wouldn't our audio websocket proxy
     between us and grok be a stateless worker?"_ — the per-device session
     Durable Object died (correction §5.3). The control plane terminates on
     a stateless worker; the media session is one stateless invocation per
     conversation holding all media sockets; an ephemeral
     conversation-scoped coordinator Durable Object survived only as a W1
     fallback (fell away with the reversal — §5.3).
  2. The requirement-11 amendment (§1.3): media strictly on demand, started
     and stopped over the control plane by either side; the mic preroll
     moved on-device; conversation memory moved to the project stream's
     transcript events plus xAI's session-resumption cache.
     **Plus one addition from the secretary message:** Jonas: _"if I'm at work
     maybe it'll sort of stay warm for longer. There's a kind of separate
     heuristic of how long grok sessions can be and so on but these are all
     sort of slightly separate concerns"_ — recorded as the three
     independently tunable policies (media warmth / provider-session
     policy / conversation state) that PLAN §3 D8 now carries.
     **Reconciled by the transport reversal (§7):** the stateless-worker
     preference and the media-on-demand substance stand; with dual WebSockets
     reinstated, "on demand" applies to frames and the provider session (both
     device sockets stay connected, requirement 10), the media session is the
     `/pcm`-terminating invocation dialing the provider per conversation, and
     every SFU/adapter-leg mention in the history above is historical.

---

## 4. The register items Jonas settled

The decision register (G1–G18) was the running list of questions posed to
Jonas, each carried in the plan with a recommended default until answered.
Three were settled by him explicitly — and one of those (G16) he reversed
later the same day (§7); the rest still run on their defaults and live in
[`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md).

### 4.1 G11 — session economics → reshaped into media-on-demand

- **As posed:** confirm the always-on-lane defaults — 90 s idle hangup,
  ~25 min session rotation, transcript replay across hangups — and
  authorize the two paid measurements (billing unit, cold-dial).
- **As settled:** Jonas answered the question by dissolving its premise
  (§1.3): there is no always-on media to economize. The V-B policy
  parameters (V-B = the 90-second idle-hangup variant the economics
  exploration compared; ≈ $4.16/day vs $115/day always-on at $0.08/min)
  survive only as historical sizing evidence
  (`exploration/proxy-session-economics.md`, now historical); the
  idle/rotation ideas live on inside D8's three warmth policies with dumb
  defaults in v2.0.
- **Consequence for the measurements:** the xAI billing probe is demoted
  from decision-blocking to tuning; the cold-dial benchmark now feeds D8's
  cold-start number (connect → provider ready). Both still await go-ahead
  (OPEN-QUESTIONS §3).

### 4.2 G16 — WebRTC posture → the target lane → REVERSED the same day

- **As posed** (added in v0.3 by the WebRTC trawl): keep WebRTC
  watchlist-only (recommended, $0 now) or fund the option-B firmware spike
  — decided by whether graceful survival of multi-second Wi-Fi outages
  mid-conversation is a v2 product requirement.
- **As settled:** Jonas went past both options: _"i think it would be cool
  to try to integrate the cloudflare realtime stuff"_, then _"okay, let's
  actually include that in our plan now. this is what i want."_ The WebRTC
  lane became the **target** media transport (goal-doc amendment §1.1); the
  transport track W1–W4 was added the same hour and adversarially reviewed
  the same day.
- **Superseded:** the trawl's own recommendation ("keep the WS lane for
  v2.0; name B as the zero-regret future lane") — its analysis stands, its
  conservatism was overridden by the owner.
- **Reversed:** later the same day, after Jonas tried the WebRTC direction:
  _"okay actually we DO NOT want the webrtc stuff now - i tried it."_ Full
  entry: §7. Where the plan landed is, in effect, the trawl's conservative
  recommendation minus the watchlist framing — the stall telemetry is still
  collected as the evidence that would ever reopen this.

### 4.3 G18 — the call interaction model (settled late in the day; unaffected by the transport reversal)

- **As posed:** how is "the user definitely wants to talk now" represented
  on the WebRTC lane — and Jonas's own counter-question: _"maybe … when you
  press the button, it's like 'Connect to secretary' and you press the
  button again, you hang up … You could still have a mute function. What do
  you think?"_
- **As settled** (_"okay lock that in"_): the call model, PLAN §2. Button =
  connect ("call the secretary"); button again = hang up. The provider's
  server VAD does all turn-taking on every lane and every board (phrased
  when two lanes existed; after §7 there is one media path, the `/pcm`
  socket). Mute is a
  separate device-local uplink gate, instantly reversible, visible on the
  avatar/LED — for talking to people in the room. **Push-to-talk is not
  built in v2 at all** — not on the WebRTC lane, not on the WS PCM lane;
  v1's proven PTT code is historical; re-adding PTT later as a per-device
  profile mode stays possible (the control plane can carry press/release;
  the provider supports manual commits) but is out of scope.
- **Superseded / deleted outright:**
  - the goal doc's per-board PTT/VAD split (amendment §1.2);
  - the **entire W3 turn-boundary design** — manual commits, the commit
    race between the control message and the last audio frames, the
    tail-delivery guard, and the "commit carries the final RTP sequence
    number" mechanism (which had been _added by the adversarial review only
    hours earlier_ as the fix for the commit race — deleted unbuilt, the
    cheapest possible fate for the track's most delicate machinery);
  - the "PTT tail delivery under induced uplink loss" rig scenario;
  - D7's in-band end-of-turn frame (§3, D7) — the pcm.v2 header survives
    only for timestamp echo on the WS PCM lane;
  - the `turn_detection: null` provider path — every xAI session runs
    server VAD; the manual-commit worker path is deleted with the v1
    push-to-talk support once v2 firmware is the deployed fleet.
- **Renames and replacements of record:**
  - capability `push_to_talk` → **`call_control`** (connect / hangUp /
    setMuted) — a v1→v2 rename;
  - device-event vocabulary: press/release → **connect, hang-up,
    mute-toggle, interrupt-tap** (still ordinary event records,
    requirement 8);
  - the layer-3 manual checklist steps → connect → speak →
    mute-while-talking-to-a-person → tap-to-interrupt → hang-up;
  - echo control on boards without AEC → server-side speak-state gating in
    the media session (uplink suppressed while assistant audio is in
    flight); the Stick gets no voice barge-in unless the G5 server-AEC
    ladder proves out — interruption there is a button tap.
- **Accepted knowingly:** an open call is a hot mic until someone hangs up
  or the silence policy does; the visible listening state, the silence
  auto-hangup (D8 warmth policy), and mute carry that weight deliberately —
  PTT had been accidentally privacy-preserving.

---

## 5. Corrections of record

Things the plan (or its inputs) asserted that were later shown wrong, with
what replaced them. Kept here so nobody re-derives the wrong version.

### 5.1 "One byte of IRAM free" — misread; the real budget is the DIRAM ledger

The goal doc's 16,383/16,384 figure was read (including by the v1
architecture review) as "any new `IRAM_ATTR` code will not link." The
linker map refutes this: v1's IRAM code (96,000 B) fills the 16 KB
instruction-only block and **legally spills 79,616 B into shared D/IRAM**
(the ESP32-S3's instruction RAM and data RAM come out of one physical
pool). New IRAM code links fine at 1:1 DIRAM cost. The real, finite budget
is DIRAM: **142,465 B static free / ~77.8 KiB runtime heap**, against the
31–60 KB internal the AEC future needs. D6's rule was restated from "zero
net IRAM growth" to "every IRAM byte is a DIRAM byte — ledger entry
required," and the stage-1 chore reframed from firefight to ledger. This
also unblocked the config adopt-list items that had looked IRAM-blocked.
Evidence: `exploration/contention-knobs.md` §1.2;
`exploration/webrtc-verdict-and-reopened-decisions.md` §2.3.

### 5.2 "The proof ladder gates the WebRTC lane as-is" — refuted; PRBS31 does not survive Opus

W4 originally gated lane promotion on the existing physical proof ladder
(tone → PRBS → endurance). Measured refutation: the PRBS31 oracle's
chip-exact decode (0.8 soft-correlation threshold) round-tripped through
libopus passes **0–6.5 % of chips** (6.5 %/3.2 % per carrier at 32 kbps
direct; 0.0 % at 64 kbps via the 48 kHz SFU path) — a noise-like test
signal is exactly what a speech codec quantizes worst. Worse, Opus
packet-loss concealment makes the tone rung's continuity check able to
_pass during real outages_ — the instruments' semantics invert on a lossy
lane. Consequence: the chip-exact oracles are WS-PCM-lane-only by
declaration; W1 carries an oracle-equivalence deliverable and W4's gate is
codec-aware (adapter sequence/timestamp continuity + device decode-loss/PLC
counters + word-level transcription assertions). Evidence: the
adversarial review's libopus round-trip experiment, recorded with both
W4-gate findings in `exploration/transport-track-adversarial-findings.md`.

**After the transport reversal (§7)** this is a historical caveat only: the
one media path is bit-transparent PCM, so the chip-exact oracles (997 Hz
phase, PRBS31) are fully valid again. The measurement stands on the record
for any future lossy-codec transport.

### 5.3 The per-device session Durable Object — dead

v0.x D8 held the provider-session state machine on a per-device Durable
Object with `storage.setAlarm`-driven states, and the transport track
inherited "the /pcm DO" throughout its research files. Jonas's question —
_"why wouldn't our audio websocket proxy between us and grok be a stateless
worker?"_ — exposed that nothing needs to outlive a conversation: with
media per-conversation, one stateless invocation can hold every media
socket with one shared lifetime, the mic preroll lives on-device,
conversation memory lives in the project stream plus xAI's resumption
cache, and in-conversation timers are plain in-invocation timers. The
ephemeral conversation-scoped coordinator Durable Object survives only as a
W1 fallback if cross-lane coordination cannot reach the invocation any
other way. Note when reading `exploration/webrtc-cloudflare-side.md` and
parts of the findings file: their "/pcm DO" wording predates this and is
historical. The stateless-worker conclusion survives the transport
reversal (§7): with dual WebSockets, the `/pcm`-terminating invocation
holds the provider socket per conversation; the ephemeral coordinator DO
fallback fell away with the SFU legs it existed to coordinate.

### 5.4 Smaller corrections (all folded into PLAN the same day)

| Was asserted                                                        | Correction                                                                                                                                                                                                                                                                                                               | Where recorded                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| "RTP timestamps native" discharges requirement 9 on the WebRTC lane | RTP covers uplink timing only; timestamp echo is a cross-direction mechanism (mic frames tagged with the speaker timestamp playing at that instant); on the WebRTC lane it must be re-homed as a device playback-position report over the control plane, or server-AEC groundwork is WS-lane-scoped (decided from W2)    | findings file; the cancelled transport track (§7)                         |
| Adapter reconnect treated as symmetric                              | Auto-reconnect exists for the egress (stream) side only, 5 s best-effort with a backlog that can replay stale audio; the ingest side has none — death means recreate via the API and re-drive the track pull                                                                                                             | findings file; the cancelled transport track (§7)                         |
| "xAI accepts 48 kHz natively so possibly zero resampling"           | The adapter format is fixed 48 kHz s16le **stereo** both directions; channel conversion is mandatory both ways; the media session's canonical internal rate stays 16 kHz mono so a mid-call lane fallback is a transport swap, not a format renegotiation                                                                | findings file; the cancelled transport track (§7)                         |
| The SFU leg could sit warm cheaply                                  | SFU tracks are garbage-collected after 30 s without media; sessions survive 30 s of lost connectivity; no ICE restart exists; warm-keeping costs $0.035/h stereo-doubled — hence the cold-by-default lifecycle, with intra-conversation silences riding Opus DTX                                                         | findings file; the cancelled transport track (§7)                         |
| "Our proven playback ring is the receive reorderer"                 | It is an in-order FIFO; choosing libpeer means patching it to surface RTP sequence numbers and building our own depacketizer + packet-loss-concealment invocation                                                                                                                                                        | findings file; the cancelled transport track (§7)                         |
| Grok reachable via WebRTC like OpenAI Realtime                      | Refuted live: xAI's realtime API is WebSocket-only; its "WebRTC Agent" demo is a self-hosted relay, not an endpoint                                                                                                                                                                                                      | `exploration/webrtc-verdict-and-reopened-decisions.md` §1.1               |
| A Cloudflare Worker can terminate WebRTC/UDP                        | Refuted live: Workers/Durable Objects have no UDP either direction; hence the Realtime SFU with WebSocket adapters is the only in-platform shape                                                                                                                                                                         | same, §1.1                                                                |
| Prior-art report: "use the VC AFE profile for full-duplex"          | Refuted: the report predates `AFE_TYPE_FD` (esp-sr 2.4.3, 2026-04-28), which Espressif added specifically for full-duplex barge-in and documents as the recommended default; FD_LOW_COST is also the only option inside our CPU/RAM budgets, and the one echo-vs-near-end lever (`aec_nlp_level`) only works in FD modes | `exploration/afe-profile-decision.md`                                     |
| Prior-art report: various Kconfig advice                            | Wi-Fi IRAM options already default-on (live question is _disabling_ them to reclaim ~27 KB); `esp_pm_lock` advice moot (power management is off — the call would error); v4-era symbol names stale                                                                                                                       | `exploration/report-reconciliation.md`; `exploration/contention-knobs.md` |

### 5.5 D8's "unchanged from v1's deployed shape" list — two of three items were never v1 behavior

Plan v1.1 carried "await `session.updated` before the uplink is live" and
"provider death → a clean device end-of-stream" as behavior preserved from
v1's deployed worker. The 2026-07-31 evening recon refuted both: the
deployed worker sends `session.update` fire-and-forget (no
`session.updated` handling exists anywhere in the tree), and provider
death discards the downlink without sending the device any end-of-stream.
Both are new v2 work; only ephemeral secret minting survives as preserved
behavior — and the recon also found the third thing v1.1 understated: the
device-connection/provider-session seam itself is already deployed (§8).
PLAN v1.2 restates D8 accordingly. Evidence:
`exploration/test-dependency-ladder.md` §1.1,
`exploration/codex-v1-alignment-host.md` rows 1–2.

---

## 6. Other dispositions of record

- **Realtime signaling and ingress: SDP over the control plane,
  capability-URL media auth — settled by Jonas, then SHELVED the same day
  by the transport reversal (§7).** Jonas directed 2026-07-31: _"we need to
  use this mechanism for workers realtime."_ The design (evidence:
  `exploration/apps-os-realtime-ingress.md`, a forked side-investigation
  into apps/os ingress): the device sends its SDP offer (SDP = the
  offer/answer handshake WebRTC uses to negotiate a connection) as an
  ordinary control-plane message, and our worker drives the SFU HTTPS API
  on its behalf — the device never holds any SFU credential; the env-level
  Realtime app secret never leaves OS core; adapters are per-conversation
  runtime objects, so a new project needs zero Cloudflare-side setup. With
  the WebRTC direction cancelled, this mechanism is not being built; the
  design is preserved (status header updated in the exploration file) in
  case the direction is ever revisited.
- **StackChan AEC profile: standalone FD_LOW_COST behind the
  audio-processing interface, hardware TDM echo-reference first.** Settled
  by planning agents against live esp-sr sources (§5.4 last-but-one row);
  the hardware reference (ES7210 TDM slot 1 wired across the speaker
  output) was verified in the stackchan clone and supersedes the earlier
  software-tap assumption. G13's remaining open sliver (any _local_ VAD at
  all, now that server VAD owns turn-taking) is in OPEN-QUESTIONS.
- **esp-gmf / esp-adf framework refusal upheld** (fixed pipeline,
  host-testable, Espressif's own latency-critical examples bypass their
  framework), with a named re-evaluation trigger: runtime-recombinable
  media graphs or the codec matrix ever needed → re-evaluate GMF v1.x
  before hand-rolling.
- **"Opus on device: not now" — briefly closed by G16, back in force after
  the reversal (§7); re-examined for the WebSocket path at Jonas's question
  (2026-07-31 evening) and reaffirmed with sharper reasoning.** Opus over
  the WebSocket lane is not nonsense — xiaozhi ships exactly that
  (16 kHz mono, complexity 0, VBR, DTX) on this SoC. But on TCP there is no
  packet loss, only delay, so Opus's loss-concealment half is worthless
  there and it buys bandwidth alone (256 kbps → ~25–30 kbps) — and
  bandwidth is not our binding constraint, while the costs are exactly what
  the proof discipline is built on: the chip-exact oracles die (§5.2's
  0–6.5 % measurement applies identically), ~40 KB + 40 KB task stacks +
  ~30 KB codec state hit the DIRAM ledger, encode CPU lands on a 160 MHz
  Stick pre-G17, and the wire grows a negotiated codec surface. Reopen
  trigger: bandwidth becoming scarce (cellular/battery board, many devices
  per access point, worker egress cost at fleet scale). When reopened, the
  natural shape is a subprotocol-negotiated wire beside PCM v1, per-device
  profile flag — and consider uplink-only Opus first (compress the mic
  path; keep the downlink raw so the tone/PRBS acoustic oracles stay
  bit-exact where they run).
- **Goal-doc guards restored by the synthesis:** camera stays (photo is a
  first-class capability and Cap'n Web compatibility test — candidates A
  and B had both deleted it); face/viseme analysis defers to StackChan and
  then adopts the stackchan 40-byte render record verbatim.
- **The prior-art report's weight verdict:** a competent directional survey
  that changed zero architecture-level decisions — 17 claims already in the
  plan, 7 superseded by live data, 5 refuted, 7 config-level adoptions (of
  which the flash-write-during-audio rule and lwIP core-pinning matter
  most). Trust it as a checklist generator, not a decision source. Full
  scorecard: `exploration/webrtc-verdict-and-reopened-decisions.md` §4.
- **The transport track was adversarially reviewed the same day it was
  written** (three independent verifiers, findings verbatim in
  `exploration/transport-track-adversarial-findings.md`); every accepted
  fix was folded into PLAN before execution started, and its two
  turn-boundary findings were then mooted by G18. The review's practice —
  verify against live vendor docs and real builds, not memory — caught
  §5.2, §5.4, and the W2 devkit scoping, and is worth repeating at each
  stage boundary.

---

## 7. The transport reversal — dual WebSockets stand (Jonas, 2026-07-31, end of day)

**Decided:** G16 is reversed. The media transport is the dual-WebSocket
design, exactly as the goal document originally settled and as codex's v1
implements: the `/api` Cap'n Web control WebSocket plus the `/pcm` binary
PCM WebSocket (mono S16LE 16 kHz, 20 ms / 640-byte frames). "For now": this
is a present-tense decision, not a forever-ban — the WebRTC research is
preserved as history only.

**Verbatim:** _"okay actually we DO NOT want the webrtc stuff now - i tried
it. update all plans and docs to make this very clear. we are doing 'double
websocket' for now - just like the current codex agent's implementation."_

### What it cancels

- **The entire transport track (W1–W4)** — removed from PLAN.md. Compact
  record of the cancelled design: W1 was the server half — provision a
  Cloudflare Realtime SFU app; a per-conversation media session dialed by
  the SFU's egress adapter, itself dialing the ingest adapter and Grok so
  all sockets shared one lifetime; measurements for cold start (the
  headline: connect → media-up, estimated 1.5–4 s), latency, post-outage
  recovery, DTX behavior, egress cost, and worker CPU; plus an
  oracle-recalibration deliverable because PRBS31 does not survive Opus
  (§5.2). W2 was a device-half bake-off on a PSRAM-enabled devkit between
  Espressif's `esp-webrtc-solution` (closed transport blob, no per-packet
  telemetry) and `sepfy/libpeer` (MIT, needed RTP-surface patches), with
  "all Opus/WebRTC state in PSRAM" as the hypothesis to disprove. W3 was
  integration behind device-profile flags with a stack-conditional degraded
  ladder (UDP → TURN-TLS:443 → WS fallback), re-homed timestamp echo, and
  its rig-scenario set. W4 was a codec-aware migration gate promoting the
  lane to per-board default. The SFU-leg lifecycle section (cold by
  default; 30 s track GC; no ICE restart; $0.035/h warm cost), the
  Stick-as-committed-WebRTC-target statement, and the W1/W2 rows of the
  v2.0 done-list all fall with the track. Full detail survives in
  `exploration/webrtc-esp-side.md`, `exploration/webrtc-cloudflare-side.md`,
  and `exploration/transport-track-adversarial-findings.md` (all
  historical).
- **Goal-doc amendment §1.1** — withdrawn. The goal doc's "Cap'n Web
  control and PCM audio use two independent WebSockets" decision stands
  unamended.
- **The Realtime signaling/ingress mechanism directive from earlier the
  same day** (§6, first bullet) — shelved; the design is preserved in
  `exploration/apps-os-realtime-ingress.md`.
- **The SFU/adapter research direction generally** — the adapter beta→GA
  and xAI-WebRTC-endpoint watch items are dropped from OPEN-QUESTIONS; the
  W1 provisioning go-ahead is withdrawn.

### What it does NOT cancel (all transport-independent, all kept)

- **G18, the call model** (§4.3): button connects and hangs up, the
  provider's server VAD does all turn-taking, mute is device-local,
  push-to-talk is not built. Honest note: codex's v1 firmware implements
  push-to-talk semantics, so the call-model transition — the `call_control`
  capability replacing `push_to_talk`, every provider session on server
  VAD — remains real v2 work on the dual-websocket transport.
- **D8's media-on-demand reshape** (§3, D8) — reconciled, not reversed:
  both sockets stay connected at all times; "inactive" means no PCM frames
  flow and no Grok session exists, never that a socket closes. The
  surviving improvements over the deployed v1 proxy: the provider dialed
  on demand per conversation, the idle hangup, await `session.updated`, a
  clean device end-of-stream on provider death, the on-device preroll ring
  masking dial latency, and the three separately tunable policies (media
  warmth / provider session / conversation state).
- **D7** (§3, D7) — the pcm.v2 16-byte header with timestamp echo, fully in
  scope on the one media path as the server-side-AEC groundwork (G18 had
  already removed the end-of-turn half).
- **G11's dissolution** (§4.1) — the idle hangup and the warmth policies
  stand as reshaped; the cold-dial benchmark stays (it measures the Grok
  dial, which is transport-independent).

### Reinstated facts

- Requirement 10 returns to its original wording: "the devices must attempt
  to maintain the two websocket connections at all times."
- The chip-exact acoustic oracles (997 Hz phase, PRBS31) are fully valid —
  the media path is bit-transparent PCM. The PRBS-does-not-survive-Opus
  measurement (§5.2) is a recorded historical caveat only.
- The TCP-stall telemetry keeps being collected (stage-2 churn scenarios +
  the nightly rig) — it is the evidence that would ever reopen this
  decision.

---

## 8. The codex-alignment pass (Jonas, 2026-07-31, evening — PLAN v1.2)

**Directive (verbatim gist):** (1) _"review the current implementation the
codex agent arrived at and update your plans accordingly to be more
aligned / learn from it"_; (2) _"make it clear that when testing this, the
'userspace worker in apps/os' is sort of the last, most expensive bit. a
normal local web server behind tunnels.iterate.com tunnel is probably
better and much faster turnaround to test 80% of the functionality.
perhaps that test server can even use the same kinds of code paths as the
userspace config worker will. could even run in miniflare. but the idea is
to test as much as we can with as few dependencies as we can."_

Three read-only recon passes were taken against the live tree
(~19:00–19:15, codex still editing — every number is a moving snapshot
dated to that window) and PLAN v1.2 was corrected from them:
`exploration/codex-v1-alignment-firmware.md`,
`exploration/codex-v1-alignment-host.md`,
`exploration/test-dependency-ladder.md`.

### What had drifted (plan v1.1 → the tree that evening)

- **Codex deleted the peer-delivery guard wholesale** (~1,714 lines with
  its test, plus the client-PING machinery and policy constants): a
  WebSocket PONG proves only hop-level ordered parsing, and using it as
  PCM delivery credit stalled long push-to-talk behind a false
  acknowledgement boundary. PCM freshness is now governed by local facts
  only. This killed v1.1's "peer_delivery_guard moved over VERBATIM —
  strongest code in the tree" line, resolved the latent §1-vs-§2
  contradiction in codex's favor, and made the stage-2 retry-gate fix as
  worded ("reset after the first confirmed delivered frame")
  unimplementable — v1.2 restates it in local facts (first byte progress /
  first downlink frame). The underlying bug (gate resets on mere connect)
  is still live; the companion "start once per boot" bug looks already
  fixed.
- **`device_event_stream` + `callback_budget` are finished and fully
  wired**, not "being written": a five-module device profile with the
  event stream polled first, four tested scenarios, all five delivery
  invariants implemented, a generic record with exactly three
  push-to-talk touchpoints. The "generalize in place" bet got cheaper and
  D6's trigger (b) got closer.
- **The deployed worker already has the provider/device seam and the
  commit-ack fence.** The "provider lifetime welded to the device socket"
  claim is dead: provider generations attach and detach without touching
  the device lane, and `response.create` waits for the commit ack. D8's
  remaining delta is precisely: dial on conversation start (today still
  dialed inside the device upgrade, 502 on failure), dial on uplink
  demand, the idle hangup, the `session.updated` await, clean device
  end-of-stream on provider death.
- **D8's "unchanged from v1" list corrected** — §5.5.
- **One stage-0 proxy bug was already fixed** (the oversized-provider-
  message bound, now tied to the downlink reservoir); the suppressed-
  downlink leak survives only in the lab proxy — the deployed bridge has
  no server-VAD mode — so the stage-0 item became a lab-proxy fix plus a
  design rule for the v2 server-VAD path.
- **Numbers moved and keep moving**: metrics.c 1,508 / main.cpp 1,347
  (both grew that day), `device-e2e.ts` 2,746 (not the 1,752 v1.1 froze),
  vendor capnweb grew (expression-array getter + the flattened-path
  envelope, so the stage-0 dead-surface count is void), `atomic.h` already
  exists tracked, and both network task stacks share one 8 KiB TLS-owner
  constant (+~7.2 KiB static — now the DIRAM ledger's opening entry).
  Every "today" number in PLAN is dated against the G2 checkpoint.
- Unchanged and still valid: the stage-0 dead-code deletions
  (`bounded_playback.hpp`, the unused `websocket_text` half); the −18 dB
  brownout fix is in-tree but still uncommitted.

### What was adopted from codex (marked "matches codex v1" in PLAN)

1. The PONG rule as a standing design rule (PLAN §2): a hop-level control
   reply is never end-to-end delivery credit; freshness and liveness come
   from observable local facts plus application-level signals.
2. The notification wire shape `{schemaVersion, sequence, type, source,
result, snapshot, coalescedNotifications}` — explicit schema version,
   snapshot as a first-class resync marker, receiver-detectable
   coalescing.
3. Latest-state-wins overflow: saturation replaces the newest queued
   entry, preserving older causal order, with the loss explicit.
4. Release-before-replace callback handoff: idle callbacks replaceable on
   the same session, in-flight ones refused with the offered import
   released, a rejected callback ends the subscription.
5. Session-end state preservation: keep the boot-local sequence and
   current physical state for the next snapshot — aligns with D5's
   `bootCounter:sequence` idempotency.
6. The shared callback budget as transport-burst arithmetic; capacity is
   concurrency, not subscriber count; events outrank metrics for slots.
7. The 8 KiB TLS-owner stack as one named shared constant with crash
   provenance (mbedTLS P-384 verify crossed the canary at 3072 on
   hardware; per-caller budgets rejected as postponing the same crash).
8. The flattened-path `invokeCapability` envelope — the static method
   table stays the only dispatcher; `call_control` rides the same bridge.
9. The `has_` evidence-flag pattern as the default for optional metric
   fields.
10. The patched-IDF-plus-host-test template (the resumable
    WebSocket-header patch) as the proof pattern for stage-2 transport
    fixes.
11. The serial-open-resets-the-device ground rule for all rig tooling and
    diagnosis procedures.

### The test-dependency ladder

Directive (2) became PLAN §5's ladder subsection: five rungs — host unit
tests → local Node LAN server → the same server behind a captun tunnel →
miniflare/workerd hosting the actual config-worker module → a real apps/os
install — with fix-at-lowest-rung as the rule, the one-shared-media-
session-module principle (the v2 media session is the merge of the lab
proxy and the deployed bridge; the lab proxy is deleted at parity), and
the apps/os userspace worker reserved as the last rung for acceptance and
integration proof only. The recon found the ladder mostly seeded in the
tree already: the direct-LAN/tunnel duality runs one shared fetch handler,
the deployed bridge's modules run in plain Node vitest, and the harness
already imports the worker's device-event subscription module — the one
gap is that the cheap rungs currently run a sibling of the deployed PCM
implementation, which is exactly what the shared module closes.
