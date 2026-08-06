# UI modalities across the four boards: where we are, and a framework

2026-08-06, branch `stream-for-audio`. Analysis only — no code changed. Produced from a
full read of the four device UIs, the shared status core, the interaction fast-path, the
audio playout surface, and the branch's docs and commit history, plus three independently
argued design proposals (state-model, modality-capability, interaction-first) that this
doc reconciles.

---

## 1. Where we actually are

The consolidation this branch shipped (96826901d, 53d5ed4a5) already built the thing a
framework needs: **one status language**. Twelve logical lights
(`conversation_lights.h`) in a fixed grammar — pixels 0–2 network, 3–5 assistant
output, 6–8 microphone, 9–11 reserved dark — with one function,
`iterate_kit_conversation_lights_animate`, as "THE ONE PLACE DEVICE STATE BECOMES
LIGHTS". The HAVPE ring renders it physically; all three screens draw the same twelve
dots as an 8-px rail down the left margin plus a breathing bottom banner with a status
word whenever the device cannot hold a conversation
(`conversation_overlay.h:14-43`).

So the four things that look confused are all projections of one model. The confusion is
real, but it lives in four specific classes:

**A. Misplaced or doubled projections.**

- StackChan has **12 physical RGB LEDs** on the body base (PY32 IO-expander,
  `stackchan_body.c:32-50`) — the same count as the language — _and_ draws the fake
  rail on screen. Worse, the body LEDs call the static `lights_render`, never
  `lights_animate` (`stackchan_device.c:453-470`), so during connecting the physical
  LEDs show exactly the "three static amber dots read as a fault" pattern the overlay
  header warns about, while the on-screen rail animates. The two surfaces of one device
  disagree.
- The M5Stick's rail is drawn _inside_ the 160×120 face frame, which sits centered on
  the 240×135 panel with black margins — so the "edge" indicator floats at panel x≈42
  (`m5sticks3_board.cpp:118-135`, `conversation_overlay.c:7-16`). Your instinct that
  it should be at the display edge is a rendering-placement fact, not a taste question.
- Waveshare stacks **three text surfaces**: the shared banner, an always-on green/red
  headline word (`waveshare_display.c:176-189`), and a device-local 64-char free-text
  line with ~20 of its own strings. Only this board has the extra two.

**B. Fake instrumentation.** The rail/ring looks like a meter but mostly isn't:

- `speaker_peak = state==SPEAKING ? 4096 : 0` on HAVPE, M5Stick, and Waveshare — the
  3-dot meter is always full or dark, never metering. Waveshare has a real level
  function (`waveshare_avatar_speaker_level()`) with **zero callers**.
- `microphone_peak` is fed only on HAVPE. `has_wifi_rssi` is never set anywhere, so the
  RSSI banding is dead code and network always shows 3 green.
- Unreachable renderings: `NETWORK_DISCONNECTED` (no producer — a pulled router breathes
  amber "connecting" forever), `restart_armed` magenta, the "starting" word.
- Every fatal park says "audio fault" regardless of cause.

**C. Missing states.** The ones users actually ask about:

- **thinking** — no board can show it. Waveshare actively lies: after turn commit it
  sets UI state SPEAKING with status "thinking", so the headline reads "speaking" and
  the meter shows full while nothing plays (`waveshare_device.c:2853-2879`).
- **reconnecting vs first connecting** — same amber chase; the strings that distinguish
  them are invisible on HAVPE (log-only) and on the Stick (see below).
- **call-opening** — the 1–3 s between tap and call-accepted renders as nothing, and
  speech spoken in that window is **silently discarded** on all four boards.
- On the Stick, _every_ fine-grained status string is invisible while the face renders
  (face_draw success clears dirty before the text paint, `m5sticks3_board.cpp:371-389`);
  only "connecting"/"offline"/"audio fault" can ever appear on that board.

**D. Dark channels.**

- **Audio: zero non-speech feedback anywhere.** No earcon, chime, or tone exists in
  first-party code on any target. The only connect feedback is the provider-spoken TTS
  greeting. Volume changes are blind (RPC reply is the only acknowledgement); no mute
  exists at all.
- The Stick's physical LED is forced dark (`led_brightness = 0`,
  `m5sticks3_board.cpp:244-256`).
- StackChan's servos are remote-RPC-only — an idle robot and a listening robot hold the
  same pose (`move_head` has no local caller).
- HAVPE's hardware mute slider and rotary are read nowhere; if the slider cuts the mics,
  the ring would show "listening" over a silenced mic.

**E. The control scheme is captured nowhere.** The "pick it up, hold, just talk —
connection warms in the background" scheme appears in no doc, task, or commit message.
The machinery half-exists: every board pre-creates the next conversation stream while
idle (tap-to-live-mic is 2.6–3.7 s warm, per 96826901d), but hold-to-talk boards still
require a _separate call-toggle tap_ before the talk button means anything, and the
`talk_button` reducer that implements the full PTT grammar (including double-tap lock)
is dead code — all four boards poll raw held levels. Meanwhile two tracked docs
(`consolidation-plan.md:100` A2, and the stream-stack review's feature matrix) still
describe control schemes the fleet no longer runs.

---

## 2. Current surface map

|                 | Waveshare                                  | M5Stick                             | StackChan                                    | HAVPE                                            |
| --------------- | ------------------------------------------ | ----------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Physical lights | none                                       | 1 LED, **forced dark**              | 12 body LEDs, **static only**                | 12-LED ring, animated (the language, done right) |
| Drawn lights    | rail in face frame                         | rail in face frame (floats at x≈42) | rail in face frame (redundant with body)     | —                                                |
| Face            | doze/wake + server visemes                 | doze/wake                           | doze/wake + envelope mouth                   | —                                                |
| Text            | banner + headline word + free-text line    | banner only (strings invisible)     | banner only (strings log-only)               | none (log-only)                                  |
| Audio feedback  | none                                       | none                                | none                                         | none                                             |
| Motion          | —                                          | —                                   | servos, remote-only                          | —                                                |
| Input           | BOOT tap=call, BOOT hold=talk, PWR tap=end | side tap=call, front hold=talk      | whole-screen tap=call, open mic (server VAD) | tap=call, open mic (server VAD)                  |

Turn-taking is decided by `capture_is_echo_cancelled` (SKILL.md rule — the one piece of
this that _is_ well documented): AEC boards (HAVPE XMOS, StackChan esp-sr) run open mic
with server VAD; no-AEC boards (Waveshare, Stick) run manual push-to-talk.

---

## 3. The framework

### 3.1 The state vocabulary: a diff on today's eight words

Keep the existing word list as the canonical states; fix it rather than replace it:

| Change   | State                              | Producer (all exist today, mostly unwired)                                                                                                                                 |
| -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| keep     | **ready**                          | `link_ready`, no call. Asleep face IS this state's rendering.                                                                                                              |
| keep     | **in call / listening / speaking** | but `speaking` must be grounded in _physical playout_ (StackChan's I2S tap + 180 ms hangover is the reference implementation) — never a transcript event or UI flag.       |
| **add**  | **thinking**                       | TURN*COMMIT (PTT) / provider turn-end (VAD) → first proven-played frame. The single biggest hole; both PTT boards already \_know* this moment and set an invisible string. |
| **add**  | **reconnecting**                   | was ready this boot && !`link_ready`. Different remedy than first connect ("patience" vs "check the router"), so a different state.                                        |
| keep     | **connecting**                     | first bring-up only.                                                                                                                                                       |
| **wire** | **offline**                        | transport in WIFI_CONNECTING past a grace — the renderer exists, give it its producer (`itx_transport.c:719-760` already knows).                                           |
| split    | **fault(cause)**                   | `park_with_fault` grows a cause class; stop labeling storage/display failures "audio fault".                                                                               |
| delete   | ~~starting~~                       | unreachable (no board passes NULL).                                                                                                                                        |

Plus one orthogonal flag rendered **always, on every surface**: **mic-live** — the mic
is hot (open-mic boards between turns, remote PTT held). Fixes the HAVPE honesty bug
where the mic sector goes dark after RESPONSE_DONE while frames still hit the wire, and
makes the currently-invisible remote-talk case visible on Waveshare. Mic-live is not a
static dot — it is amplitude-modulated (§3.6).

Priority: fault masks everything; offline/reconnecting/connecting mask conversation
phase on the status surface (you cannot honestly render "listening" into a void — the
existing belief/intent split already thinks this way); within a call, listening beats
speaking beats thinking. One shared reducer in `components/core` computes the state from
board-supplied facts, deleting the four duplicated per-board
`IDLE/CONNECTING/LISTENING/SPEAKING` enums (StackChan's is literally write-only today).

**Honesty rules** (the discipline the codebase already applies to lights, applied to the
whole language): every rendered state has a producer, every produced state a rendering;
meters are measured or absent — a board without a tap shows the binary baseline dot,
never a synthetic full meter.

### 3.2 Channel charters: which modality says what

- **Lights** (physical ring, body LEDs, or drawn rail) carry _persistent states_ — and
  the _live signals_ (§3.6), the one content kind that must update in real time.
- **Audio** carries _transitions_ — edges, never levels. A speaker can't hold a state
  without becoming an alarm. This one rule answers "what do we do with audio" and "what
  does a no-lights no-screen device do" simultaneously.
- **Text** is _escalation_, not wallpaper: attention states ("connecting",
  "reconnecting", "offline", fault causes) and action prompts ("hold the front button to
  talk"). A healthy device's screen is a face, not a dashboard.
- **The face** carries conversation phase: asleep=ready, attending, listening pose,
  thinking pose (new), viseme/envelope mouth=speaking.
- **Motion** (servos) is reinforcement only, never the sole carrier of anything.

**One surface per fact per device.** A board with real LEDs does not also draw fake
LEDs: StackChan's body LEDs switch to `lights_animate` and the on-screen rail is
suppressed when the body probe succeeds (drawn rail returns as fallback when the body is
absent). Screens without physical LEDs draw the rail as a _stand-in_ — same language,
drawn because there is no better organ — and it belongs at the true panel edge
(Stick: composite at panel x=0 full height, outside the face frame), not floating in
the face's margin.

### 3.3 The audio layer (the missing channel)

Five locally-synthesized earcons, ≤400 ms, no assets, no server verb:

1. **ack-tick** (~60 ms, ≤80 ms from button-down) — proves the press registered. The
   single most important cue in the product; today: nothing.
2. **call-live** — the prepared call was accepted (open-mic boards' wake).
3. **hold-on** (rising) — you asked for something the backend can't serve yet.
4. **sorry** (descending) — buffered speech had to be dropped / interaction failed.
   The _only_ permitted way to discard captured speech.
5. **fault-buzz** (triple, once at park, never looping).

Plus a **volume blip played at the new volume** on setVolume (fixes the blind volume
UX; persist the setting while at it).

Architecture: the speaker path is deliberately single-writer (generation-tagged queue,
one playback task; a second PCM writer is what froze the StackChan face). So earcons are
**not** a queue push — they render in each playback task's existing dry/priming branch
(`waveshare_device.c:1065-1113` and siblings) from a one-slot mailbox: dropped if the
speaker is busy, never queued stale, never played over the answer. On no-AEC boards the
ack-tick must complete before capture opens (the Stick's half-duplex handoff gap does
this for free; Waveshare's ordering is load-bearing). On AEC boards an earcon is
speaker output the canceller must see as reference — same as any TTS frame.

Silent states stay silent; a device is mute until touched or until something changes.
One extra rule makes a hypothetical audio-only board complete: **input echoes state** —
a press while ready acts and ticks; a press while connecting/offline answers hold-on; a
press while parked answers the fault buzz.

### 3.4 The control scheme, written down (normative)

This section is the first artifact to state the scheme; nothing else in the repo does.

**Hold-to-talk boards (no AEC — Waveshare, M5Stick): hold implies call.** There is no
separate "start a call" gesture. Button-down means "I'm talking to you, now":

- If a call is live → it's a turn (today's behavior).
- If not → place the prepared-ahead call _while capturing the user's speech into a
  local pre-live buffer_ (~8 s, µ-law, PSRAM), flushed as the first turn on
  call-accepted. The user never learns the word "call". The second button becomes
  end/sleep only.
- Captured speech is **never discarded silently** — the sorry earcon is the only exit.

**Open-mic boards (AEC — HAVPE, StackChan): tap is a privacy gesture**, wake/sleep, not
session management. The `capture_is_echo_cancelled` rule (SKILL.md) stays the decider
for which model a board runs. Mic-live is always rendered while awake.

**Feedback timeline from button-down (PTT):** flush ≤30 ms → ack-tick ≤80 ms → surface
shows _hearing_ with a real mic level ≤100 ms → release silent (walkie-talkie grammar:
the answer is the confirmation) → _thinking_ at +300 ms of dead air → hold-on cue if the
call isn't accepted by release+2 s → sorry + drop only at +8 s.

Latency budgets and the buffer window are coupled constants — they need a long-session
soak, not a demo (failures will appear at turn 15, not turn 1). And the burst-flushed
first turn needs a bench proof that the provider's VAD/transcription handles it.

### 3.5 Target per-board mapping

|        | Waveshare                                                                                               | M5Stick                                                                                   | StackChan                                                                                                                                                        | HAVPE                                         |
| ------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Lights | drawn rail (only board with no LEDs at all)                                                             | drawn rail at true panel edge; physical LED = attention tier + mic-live                   | **body LEDs, animated**; rail only if body absent                                                                                                                | ring, unchanged (already right)               |
| Face   | doze/wake + visemes + thinking pose                                                                     | same                                                                                      | same + local servo poses (attend/asleep/slump)                                                                                                                   | —                                             |
| Text   | banner + one action line; headline word deleted; free-text strings folded into the canonical vocabulary | banner + action line (drawn over/beside the face, not on the unreachable fallback screen) | banner only                                                                                                                                                      | — (earcons are its prose)                     |
| Audio  | 5 earcons + volume blip                                                                                 | same                                                                                      | same                                                                                                                                                             | same — needs them most                        |
| Input  | hold=talk-implies-call; PWR tap=end                                                                     | front hold=talk-implies-call; side tap=end                                                | tap=wake/sleep; wire `barge_in_admit` (currently flushes on provider speech_started unconditionally — the false-barge-in class HAVPE measured 6× in one session) | tap=wake/sleep; read the mute slider + rotary |

### 3.6 Live signals: state only the device knows, shown in real time

There is a third content kind besides states and transitions: **continuous client-side
signals** — facts that exist only on the device and change at frame rate. The canonical
one is **post-AEC microphone amplitude**; playout level and the button-held level are
the others. These can never ride the stream: a round trip is too slow at 20 ms frame
rate, and — more importantly — it would prove the wrong thing. The point of showing the
mic level locally is precisely that it certifies the _device_, not the server.

Because that is the deeper role of this class: **the live meter is the liveness
instrument.** A level that moves when you speak proves the entire client-side chain end
to end — mic hardware → AEC → capture task → snapshot → render loop — with one glance.
A frozen meter is the on-device, human-visible symptom of exactly the stuck-firmware
class we have already been bitten by (the frozen-face incident: a dead mouth and stuck
level dots meant a wedged pipeline; `faceFrames` in `health()` is the _remote_
instrument for it — this is its local counterpart). And the probe is interactive, which
resolves the silence-vs-stuck ambiguity: say something and watch it move.

Rules:

- **Fed from the real tap, always.** HAVPE is the reference implementation: per-20 ms
  frame peak over the post-AEC processed frame, published lock-free,
  explicitly presentation-only (`havpe_device.c:826-861`, `havpe_ui.h:32-40`). Wiring
  this same tap on the other three boards is the concrete work behind "meters are
  measured or absent" — a synthetic level is worse than none, because it forfeits the
  liveness proof (a fake meter animates while the real pipeline is wedged).
- **While the mic is hot, at least one element on every board is amplitude-modulated.**
  This is the mic-live flag's real rendering: a level-tracking element, not a static dim
  dot. Per board: HAVPE's mic sector (already real); the screens' rail mic sector
  (or an edge glow during listening); StackChan's body mic sector; the Stick's single
  physical LED brightness-tracking the mic peak — a one-pixel VU meter.
- **Update at UI tick rate, change-gated by view equality.** The existing machinery
  already handles this correctly: log-banded levels (256/1024/4096) plus
  `lights_equal`'s render-and-compare mean high-resolution signal noise cannot cause
  SPI flicker, while real speech visibly moves the display.
- **This class survives every fork.** Even if Fork 1 kills the drawn rail on some
  screens, the live mic meter must land somewhere on every board — it is not telemetry
  decoration; it is the one instrument that tells you the thing is actually hearing you
  and the firmware is not stuck.

### 3.7 Fact origin: local or remote, and the UI must not care

Orthogonal to _what_ a fact is, there is _where it came from_. Most triggers can
originate two ways: **locally** (a GPIO edge, a touch, real microphone frames) or
**remotely** (a capability call — `pushToTalk.start`, `conversation.start` — or a test
script inserting the same event). Two requirements, both normative:

1. **Local origin renders at local latency.** A physical press or a mic frame reaches
   the surface at poll/frame rate with zero network involvement — the network is never
   in the loop between a person's finger and the light that acknowledges it.
2. **Remote origin renders identically.** A test script inserting a PTT-start, or a
   capability call flipping call intent, must produce exactly the UI a physical press
   produces — same state, same lights, same earcon. This is what makes every rendering
   in this doc assertable from a bench script without hands on the device.

The rule that delivers both by construction: **remote triggers inject facts at the same
entry point as physical ones — upstream of the shared reducer — and never paint
renderings directly.** The codebase already believes this where it works: remote PTT and
conversation events go onto the same bounded device-event queue and land on the same
display-owned flags the physical buttons set ("calling audio directly from RPC dispatch
was rejected as creating two owners of capture state", `push_to_talk.c:7-13`;
`waveshare_device.c:1410-1435`). Everything downstream — reducer → snapshot →
renderers — is shared, so origin-transparency is free.

What this dimension adds or fixes:

- **Physical edges currently bypass the device-event queue** (they are polled straight
  into the flags), so the queue's stated "one total order for physical and remote
  transitions" is only half-realized. Convergence at the flags is sufficient for
  rendering; if we ever need ordering guarantees between a physical release and a
  remote stop, the edges belong on the queue too.
- **Live signals (§3.6) are origin-transparent one level up.** You remotely "trigger"
  a mic-level rendering by injecting frames upstream of the capture tap (as the host
  CLI's WAV/tone injection already does), never by writing the meter — a
  directly-painted meter would forfeit the liveness proof, since it animates without
  exercising the pipeline.
- **Remote facts that today render as nothing:** a remote party holding the mic open is
  invisible on the Waveshare screen (the mic-live flag fixes this); boards that
  deliberately refuse a remote trigger (StackChan/HAVPE answer PTT with STATE_ERROR)
  refuse it in the RPC reply, which is the correct surface — the room does not need to
  see rejected remote attempts.
- This is the same argument the untracked event-contract doc makes from the other side:
  state you can inject and assert from off-device is state you can test. The two
  compose — remote injection drives the pipeline, the stream projection would let a
  host test read the result.

---

## 4. The forks to actually discuss

The three design lenses agreed on almost everything above (earcons, thinking,
honesty-of-meters, one-surface-per-fact, hold-implies-call, the shared reducer). They
split on three things — these are the real conversation:

**Fork 1 — does the 12-dot sector grammar belong on screens at all?**

- _Keep (two lenses):_ it's the one language every surface shares; on screens it's the
  stand-in for lights; learn it once. Move it to the true edge (Stick), suppress it
  where real LEDs exist (StackChan).
- _Kill (interaction lens):_ the network/speaker/mic trisection is an engineer's
  instrument panel; the face + banner + earcons carry everything a person needs; demote
  the rail to a bench/debug toggle (long-press or RPC) and let `health()` carry the
  telemetry.
- My read: keep the 12-light language as the _lights-channel_ grammar — it's what makes
  the HAVPE ring and StackChan body coherent, and deleting it strands the ring with no
  vocabulary. Whether screens draw the stand-in rail is then a per-board call: Waveshare
  (no LEDs) yes; Stick yes-at-the-edge (a 1.14" panel's bezel indicator is genuinely
  useful at arm's length); StackChan no (body LEDs own it). This matches your instincts
  board-for-board.

**Fork 2 — how does _thinking_ render on lights?**

- _Sector option:_ assign the reserved fourth quarter (pixels 9–11) as the turn sector —
  call-opening fill, thinking breathe, remote-talk pixel. Keeps the grammar intact and
  finally gives the reserved quarter its agreed meaning.
- _Whole-surface option:_ thinking is a slow whole-surface pulse/swirl; motion already
  means "working on it", and 3 dim pixels are too subtle for the state users most ask
  about — especially at the ring's brightness floors and for colorblind users.
- My read: whole-surface for thinking (it's a foreground moment, not telemetry), which
  also means the reserved quarter stays reserved rather than gaining a fourth meaning.

**Fork 3 — RSSI: wire it or delete the banding?**
Wiring is one `esp_wifi_sta_get_ap_info()` call per board and gives the only "works in
the kitchen, dies in the garden" diagnostic; deleting honors "no unreachable words."
Either is fine; the current state (dead code rendering a permanent lie of 3 green bars)
is the only wrong answer.

Related but bigger: the untracked `2026-08-06-voice-agent-event-contract.md` argues
device state should be a stream projection so the ring is assertable off-device. This
framework makes the on-device model coherent but doesn't move it onto the stream —
compatible, separate decision.

---

## 5. Migration sketch (ordered; each step ships alone)

1. **Shared state reducer + thinking.** One core reducer computing the canonical state
   from board facts; delete the four per-board enums (`havpe_ui.h:20-24`,
   `m5sticks3_board.h:34-37`, `waveshare_display.h:10-15`,
   `stackchan_device.c:372-377`). Kills the Waveshare "speaking-while-thinking" lie in
   the same stroke.
2. **Honesty pass.** Ground speaking in the playout tap fleet-wide; wire
   `waveshare_avatar_speaker_level()`; feed real mic peaks; producer for
   offline/reconnecting; fault causes; delete restart-magenta and "starting"; decide
   Fork 3.
3. **Earcon component.** `components/core` pure PCM synth + one-slot mailbox in each
   playback task's dry branch; ack-tick first, volume blip + persistence with it.
4. **Surface placement.** StackChan: body → `lights_animate`, screen rail suppressed
   when body present. Stick: rail composited at panel x=0. Waveshare: headline deleted,
   free-text folded into the canonical vocabulary.
5. **Hold-implies-call + pre-live buffer** on the two PTT boards. The product-defining
   change and the only risky one — bench-prove the burst-flushed first turn and the
   abort path first.
6. **Dark hardware.** Stick LED driven; StackChan local servo poses (+ a lease so
   remote `servos.move` and status motion don't fight); HAVPE mute slider + rotary.
7. **Paper.** This doc (or its successor) becomes `docs/status-language.md`; reconcile
   `consolidation-plan.md` A2 and the review matrix to the `capture_is_echo_cancelled`
   rule; write the missing IMPLEMENTATION-LOG entries (the review already ordered both).

---

## Appendix: defect/doc-rot inventory found along the way

Dead or unreachable surface: `restart_armed` magenta; RSSI banding; NETWORK_DISCONNECTED
red; "starting"; `talk_button.c` (full PTT grammar incl. double-tap lock — zero device
callers); `barge_in_forget`/`barge_in_person_present` (documented measured failure
modes, zero callers); `waveshare_avatar_speaker_level()`; Waveshare face-switching
plumbing (`request_slug` etc., no caller); `havpe_button_talk_held()`;
`STACKCHAN_STATUS_RAIL_WIDTH 13` (dead constant, and the device.c comment still says
"13-pixel rail").

Honesty bugs: Waveshare headline "speaking" during thinking; Stick SPEAKING on first
transcript fragment before any audio; HAVPE mic sector dark over a hot mic between
turns; StackChan body LEDs static-amber during connect while the screen chases;
synthetic 4096 peaks (3 boards).

Doc rot: `waveshare_device.c:21-25` says BOOT toggles / PWR is held (wiring is the
opposite); talk-edge log prints "PWR down" while reading the upper/BOOT button; HAVPE
strings and model instructions still say "hold the button to talk" post-open-mic-flip;
`consolidation-plan.md:100` A2 ("PTT on every board") doubly stale; stream-stack review
feature matrix stale about HAVPE from the commit that added it; Stick's two earliest
boot-failure paths still plain-`return` instead of `park_with_fault` (reproducing the
silent reboot loop the park was built to eliminate); StackChan lacks the barge-in admit
gate on an open-mic board.
