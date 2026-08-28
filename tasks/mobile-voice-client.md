---
status: ready
size: large
base: voice-colleague-per-stream
---

# Mobile voice client

The Expo iOS app becomes the third dumb client of the voice-agent facet —
after the C host CLI and the ESP32 boards — with a voice button on the
floating note pill that starts an open-mic voice call, pulsing with local mic
level. Same protocol, same backend (contract 16.0.0 on the base branch), zero
server changes.

Interview log: [mobile-voice-client.interview.md](./mobile-voice-client.interview.md)
(grill-you, 8 questions, all decisions below trace to it).

## Status summary

Done except one box: the physical-phone check. Implemented, unit-tested (16
tests), live-proven from Node against prd (real answer audio + durable
transcript, 15s round trip), EAS native build green (7be698bb, install QR in
PR #2537), all CI green, explainer published. The 02:00 iPhone-mirroring
attempt was blocked on the screen-control approval dialog — first tap in the
morning is the capture spike.

## Decisions (from the interview)

- **Posture**: open-mic (`clientTakesTurns: false`), boards' path. Press =
  start call, tap = hang up; model `hang_up` + 60s idle deadline as backstops.
  AEC via AVAudioSession `voiceChat` mode (VoiceProcessingIO) is a hard
  requirement; earpiece routing is the library-independent fallback.
- **Audio library**: `react-native-audio-api` (Software Mansion), behind one
  small module boundary (mic frames in / PCM chunks out / level callback) so
  swapping to `@siteed/audio-studio` is a one-file change if capture issue
  #721 bites on-device.
- **Stream path**: stable per device — `/agents/voice/mobile-<deviceId>`
  (existing `getMobileDeviceId()`), so the per-stream colleague + reconnect
  recap give the phone one ongoing voice relationship.
- **Setup**: app-owned `setupVoiceAgent` via `itx.workers.get`, run only when
  a local AsyncStorage marker (config-payload hash per streamPath) mismatches.
  Setup failure surfaces an error and never opens the mic. No
  posture-flip-guard port (device owns its path, one posture ever).
- **Uplink**: one `mic-frame` append per capture callback, ~64ms (1024
  samples @16kHz) target, no batching layer; record the actual frame size the
  library yields. Downlink: `openConnection` ephemeral `spk-frame`s, the
  three-line buffer policy (clear-before-frame / write / last-frame fence).
- **UI**: voice icon on/next to the floating note pill; in-call it expands to
  a compact sheet — pulse (local RMS), hang-up, one caption line shared by
  call lifecycle (connecting / listening / ended) and the colleague
  status/note lane (via `useLiveEvents` over the durable events).
- **Permissions**: lazy mic request on first tap; denial → tappable caption
  → `Linking.openSettings()`; button always visible.

## Checklist

- [x] Audio I/O module (`src/lib/voice-audio.ts`): react-native-audio-api
      capture (16kHz mono, Float32→Int16, per-frame RMS) + streaming PCM
      playback; interface + injectable fake. _Interface in voice-audio.ts;
      react-native-audio-api impl in voice-audio-native.ts (AudioRecorder
      capture, AudioBufferQueueSourceNode playback, voiceChat AEC session)._
- [x] Voice call core (`src/lib/voice-call.ts`): state machine (idle →
      setup → connecting → live → ended), ptt-start append, mic-frame
      uplink, spk-frame downlink with buffer policy, hang-up append,
      caption derivation from lifecycle + colleague-status/note events.
      Pure TS, no RN imports, so it runs in node. _Done as specced; 64ms
      frames (1024 samples), ≤8 in-flight appends then drop._
- [x] Setup marker logic _(voice-setup.ts: FNV-1a config hash, AsyncStorage marker via DI)_ (config hash in AsyncStorage) + `setupVoiceAgent`
      call via `itx.workers.get` (entrypoint ref mirrors
      `apps/os/scripts/voicelab/voice-agent-ref.ts`).
- [x] UI: voice button _(components/voice-call-button.tsx, wired into note-composer overlay both collapsed and expanded)_ on the note pill/composer, pulsing with level; in-call
      sheet (pulse + hang-up + caption).
- [x] Expo config: react-native-audio-api plugin _(app.json; background/android modes off)_, NSMicrophoneUsageDescription,
      audio session (playAndRecord / voiceChat / defaultToSpeaker).
- [x] Unit tests: state machine _(16 tests: voice-pcm/voice-setup/voice-call .test.ts)_, caption derivation, PCM conversion + RMS,
      setup-marker hash logic (vitest, fake audio via the DI seam).
- [x] Headless node wire-driver _(e2e/voice-roundtrip.e2e.test.ts — PASSED against prd voicelab-eval, 15s)_: run the shipped voice-call module against
      prd `voicelab-eval` with WAV-fed fake audio; assert spk-frames arrive
      and durable transcripts land.
- [x] Native build via mobile PR-preview CI _(finished: EAS build 7be698bb, after two pod fixes — reanimated + worklets are hard deps of react-native-audio-api; ffmpeg disabled)_
- [x] Permanent explainer in `explainers/` _(mobile-voice-client.html; servable at iterate.iterate.app/explainers/mobile-voice-client?sha=mobile-voice-client)_ (linked from PR; servable via
      iterate.iterate.app/explainers/…).
- [ ] ~2am: iPhone-mirroring test — capture spike first (non-empty frames +
      moving level), then a real conversation. _Attempted 02:00: computer-use
      access to iPhone Mirroring came back user_denied (nobody awake to
      approve), so the on-phone check is the ONE remaining box. Morning path:
      scan the full-install QR in PR #2537's body (build 7be698bb), open a
      project, tap the mic button, say something — then
      `pnpm cli voicelab transcript --project iterate --path /agents/voice/mobile-<deviceId>`
      shows what the phone heard. Everything up to the native audio layer is
      already live-proven from Node._

## Out of scope

Android; boards; TestFlight/App Store; background/lock-screen audio; any
voice-agent contract change; transcript/scrollback UI; resurrecting PR
#1605's WebRTC architecture.

## Guesses and assumptions (flagged in the interview)

- AEC-first (speaker + voiceProcessing) is the right default; earpiece only
  as fallback.
- react-native-audio-api over @mykin-ai's purpose-built lib: maintenance
  beats purpose-fit; capture issue #721 risk accepted because the swap seam
  is contained.
- Raw device UUID in the stream path is acceptable for a demo.
- Setup-on-marker-mismatch (not every call): call-start latency matters more
  than re-assertion.
- ~64ms uplink frames: unmeasured sweet spot, 40–100ms band acceptable.
- Lifecycle states share the caption slot so the sheet never looks dead.
- Playwright expo-web scenario deprioritized below the node wire-driver.

## On-device round 1 (morning, Misha's phone)

First physical test found one library bug with five symptoms:
react-native-audio-api 0.13.3's `AudioBufferQueueSourceNode.start()` throws
on its OWN default parameter (`offset = -1` sentinel vs its `offset < 0`
range check) — so playback setup always threw, after the call was already
minted server-side: "call failed" flashed, live captions overwrote it with
"listening", the server heard zero mic frames (deaf call), hang-up was wired
to a null handle, and the 60s idle deadline reaped it.

Fixes + the push-to-talk pivot (Misha's call):

- [x] `queue.start(0, 0)` dodges the sentinel bug; play/clear hardened so a
      bad frame can never take down the delivery callback (and with it the
      socket). _voice-audio-native.ts_
- [x] Audio-start failure now ends the call cleanly (connection closed, no
      deaf mint); hang-up ends locally FIRST, obituary appended after — a
      wedged socket cannot eat the button. _voice-call.ts_
- [x] Push-to-talk: `clientTakesTurns: true` (marker v2 re-runs setup and
      flips existing device streams), handle gains `setTalking()`; durable
      ptt-start per press (first press mints), ephemeral ptt-end commits the
      turn; mic frames flow only while held. Captions: "ringing…" → "hold
      the mic to talk" → "listening…" while held. _voice-setup.ts,
      voice-call.ts_
- [x] Sheet rework: big hold-to-talk mic button, slim level bar above it
      (JS-driven — width is not native-animatable), ✕ collapse, ended-note
      now dismisses instead of restarting. _voice-call-button.tsx_
- [x] Unit tests reworked for PTT (9 call-core tests incl. wedged-socket
      hang-up and failed-mic cleanup); live e2e reworked to drive the press/
      release edges — passed against prd in 20s.
- [x] `misha` project provisioned (template a3a86480 + openai secret).

## On-device round 3+4 (it works!)

Round 3 (ring + playback fixes) confirmed working on-device. Round 4 polish,
all from live feedback:

- [x] ✕ removed; the sheet is a transparent Modal — tapping anywhere outside
      minimises it (call keeps going behind the floating button).
- [x] Output selector: speaker ↔ earpiece toggle on the sheet (AVAudioSession
      defaultToSpeaker flip — the library exposes no output-device API).
      Every call starts on speaker: hold-to-talk means the phone is in front
      of you.
- [x] The call says hi at pickup: `greeting` on the certificate (facet
      17.0.0, on the base branch) — session.updated plants one system item +
      response.create; the transcript recap makes it "hi again" for a
      returning caller, free. Suppressed when the caller is already
      mid-sentence. The mobile mint press moved back to call start so the
      dial happens during the ring, and the ring now sounds until
      conversation-accepted (the actual pickup).
- [x] Templates upgraded to 17.0.0 on voicelab-eval, pr2537 (preview_2),
      misha, iterate; e2e green against the greeting flow.
