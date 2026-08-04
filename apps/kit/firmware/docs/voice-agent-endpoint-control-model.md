# Voice-agent endpoint control model

Status: working contract, with M5StickS3 as the first two-control reference
implementation.

## The endpoint

A voice-agent endpoint is a long-lived local actor with three responsibilities:

1. Maintain its control connection and any currently routed media connections.
2. Continuously reduce local input and time into immediate interaction state.
3. Export a capability tree through which Iterate can inspect or control the
   hardware.

The endpoint is not a remote-controlled collection of GPIO pins. It must remain
locally responsive when the network is slow or absent. A physical edge is
reduced locally first; the resulting semantic action enters the same bounded
device-event queue used by remote semantic capabilities. This gives local and
remote actions one observable order without putting a network round trip in the
physical input path.

## Vocabulary

- **Input signal**: a physical or synthetic fact such as button down, button
  up, wheel delta, touch point, key down, or wake phrase.
- **Gesture**: a local interpretation over input signals and monotonic time,
  such as hold, tap, or double tap.
- **Action**: device-independent intent such as TALK START, TALK STOP, OPEN
  MENU, NEXT ITEM, CHOOSE ITEM, or HANG UP.
- **Capability**: an addressable operation or live resource exported by the
  endpoint. A capability may publish an action, query state, or expose media.
- **Event**: an ordered observation of an accepted action or state transition.
  Events are evidence and synchronization boundaries; they are not required to
  be the mechanism that performs every local effect.
- **Cue**: one semantic presentation fact adapted to sound, light, pixels,
  haptics, or text.
- **Profile**: the declared hardware and presentation capabilities from which
  available actions, menus, and cue adapters are projected.

These terms deliberately separate cause from effect. A front-button down signal
may begin a hold gesture, which publishes TALK START, which changes microphone
state, which emits a LISTENING cue. No layer needs to know that another endpoint
uses a keyboard, touch target, or remotely injected signal for the same action.

## State is several small machines

One giant enum would create impossible combinations and device-specific
branches. The endpoint instead reduces an explicit product of orthogonal state:

| Dimension    | Representative states                                     |
| ------------ | --------------------------------------------------------- |
| Control link | offline, connecting, ready, failed                        |
| Conversation | absent, opening, active, ending, failed                   |
| Media route  | absent, connecting, ready, failed                         |
| Capture      | stopped, momentary, awaiting-second-tap, locked, stopping |
| Playback     | silent, playing, interrupted, failed                      |
| Overlay      | none, context-menu(item), transcript, fault               |
| Presence     | awake, idle, dozing                                       |

Reducers own transitions within a dimension. Reconciliation code owns
cross-dimensional invariants, including:

- capture implies an active or atomically requested conversation;
- a half-duplex endpoint cannot capture and play simultaneously;
- opening an overlay cannot conceal a live momentary microphone;
- HANG UP settles capture before disposing of the media generation;
- an unavailable capability cannot appear as a selectable menu item;
- a rejected STOP remains a bounded, observable obligation until admitted.

## Input and remote-control paths

Physical input follows this path entirely on the device owner:

```text
hardware signal -> gesture reducer -> semantic action -> device event queue
                -> local effect owner -> reduced state -> cue projection
```

Remote semantic capabilities such as `conversation.start`,
`conversation.hangUp`, and `pushToTalk.start/stop` enter at **semantic action**.
They therefore share ordering, validation, effects, and event observation with
physical actions.

A future raw-input capability may enter at **hardware signal** to reproduce the
exact gesture path for unattended hardware tests. It must identify a logical
control and level, not a GPIO number, and must preserve source metadata. It
must not replace semantic capabilities: callers that mean HANG UP should not
have to reverse-engineer a device-specific sequence of button timings.

Neither path requires Iterate to echo a physical input back before the endpoint
responds. That would add network latency, require optimistic UI rollback, and
make an offline button inert.

## Events, capabilities, and live resources

Request/settled event pairs are appropriate for durable actions whose progress
matters, but are not the universal I/O protocol.

- Buttons and gestures produce ordered action/state events.
- A servo exports a command capability and emits requested, reached, stalled,
  or failed observations. A local safety controller may still drive it without
  round-tripping through the event stream.
- A camera exports a bounded snapshot fetch and, where supported, a live video
  resource. Video frames do not become control-plane events.
- Microphone and speaker audio use routed media streams. A control event may
  change which conversation stream owns those frames.
- Screens, LEDs, haptics, and audio cues expose command capabilities where
  remote rendering is useful, while ordinary conversational presentation is
  projected locally from reduced state.

This division keeps high-rate media out of the control log while leaving every
route and lifecycle transition explainable.

## Offline behavior

The endpoint may buffer events only when their replay semantics are explicit:

- transient button edges and touch coordinates expire; replaying them later
  could start a call the person no longer wants;
- current desired state is reduced locally and resynchronized as a snapshot;
- durable user intents require an idempotency key, a bounded retention policy,
  and an explicit expired/abandoned outcome;
- media pre-roll is a separate bounded freshness buffer, not an event backlog.

For push-to-talk from idle, the endpoint begins a bounded microphone pre-roll
while it opens the conversation/media route. Once ready it drains only fresh
frames in order. If connection setup outlasts that bound, the UI must say so;
it must not silently discard the beginning while continuing as if the turn
were complete.

## Consistent presentation language

The semantic cues are shared; each profile selects every adapter it can render.

| Semantic cue         | Screen                     | Light                    | Sound/haptic              |
| -------------------- | -------------------------- | ------------------------ | ------------------------- |
| ready                | awake face / READY         | steady ready colour      | optional soft ready cue   |
| connecting           | CONNECTING / progress      | slow pulse               | periodic bounded dial cue |
| listening, momentary | HLD / REL                  | listening colour         | optional turn-end cue     |
| listening, locked    | LCK / DBL / END            | same hue, distinct pulse | optional turn-end cue     |
| thinking             | face + THINKING            | thinking animation       | short processing motif    |
| speaking             | PCM-driven face            | speaking colour/level    | the speech itself         |
| menu                 | selected action + position | menu colour              | speak selected action     |
| failure              | named fault and recovery   | fault colour/pattern     | bounded fault motif       |

Colour, animation, tone, and wording are adapters for these meanings, not new
states. A light-ring pixel and a small display indicator should therefore use
the same palette. PCM-derived avatar animation is a speaking presentation
adapter; it does not decide conversation or playback state.

Audible cues must respect the audio profile. On a half-duplex board whose
microphone and speaker share I2S ownership, playing a dial or lock sound while
capture is active may interrupt or corrupt speech. Such a profile must provide
a visual or haptic listening signal and may defer an audible cue until after
capture has released the audio hardware. It must not pretend a sound played.

## Navigation projection

Every endpoint exposes the same logical controls where possible:

- **TALK**: direct access to microphone turns and menu selection.
- **MENU**: open the current context menu or move to its next item.
- **CHOOSE**: activate the selected item; TALK supplies this on minimal
  endpoints.
- **BACK/CLOSE**: dismiss an overlay; CLOSE is always the first menu item when
  a dedicated control is absent.

Menus are derived from current state and declared capabilities. A touch screen
shows a context menu on tap; a one- or two-button device speaks or displays one
item at a time; a browser may keep the same menu permanently visible. The
transcript/action stream follows the same projection: persistent pane on a
large display, menu-accessible view on a small one, voice-read view on an
audio-only endpoint.

## M5StickS3 reference profile

The M5StickS3 has a screen, microphone, speaker, no validated AEC, and two
application buttons. M5Unified maps the front button to BtnA/GPIO11 and the top
button to BtnB/GPIO12. The bottom control is hardware reset and is deliberately
not multiplexed as application input.

| Input            | Menu closed                                           | Menu open                      |
| ---------------- | ----------------------------------------------------- | ------------------------------ |
| hold FRONT       | start conversation if needed; talk until release      | choose once on press           |
| double-tap FRONT | lock a continuous long turn; double-tap again to stop | choose once on first press     |
| tap TOP          | stop any active turn, then open menu                  | advance to next available item |

The menu currently projects CLOSE, START CALL or HANG UP, NEXT FACE, and
REBOOT. NEW CONVERSATION is withheld because the target is mounted on one
configured stream and cannot yet settle that action truthfully.

The double-tap reducer starts on the first down edge and keeps one continuous
turn through the bounded inter-tap window. It never manufactures a tiny first
turn. The screen renders `LCK / DBL / END` while latched.

The Stick plays no cue while its microphone owns the shared I2S path. After
capture has ended and released the microphone, the sole audio owner plays one
short turn-complete motif as a catch-up acknowledgement. A new TALK press
preempts that motif immediately so feedback never delays the next utterance.

## Acceptance requirements for another endpoint

A new profile is complete only when it declares and proves:

1. Its input inventory, including controls reserved for reset or safety.
2. Audio concurrency: full duplex with validated AEC, or explicit half duplex.
3. Its TALK/MENU/CHOOSE mapping and gesture timing tests.
4. Capability-derived menus with no action that can only fail.
5. Cue projections for every reachable lifecycle state and named failure.
6. Bounded control/event/media queues and explicit saturation outcomes.
7. Disconnect, replay, and pre-roll freshness policy.
8. Physical and remote semantic actions converging on the same effect owner.
9. Live-resource contracts for any camera or other high-rate sensor.
10. Hardware verification tied to stable device identity, not an incidental USB
    port name.
