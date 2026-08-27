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

Not started (spec just written). Native build must come from EAS via the
mobile PR-preview CI (no local Xcode); on-phone verification happens via
iPhone mirroring after ~2am.

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

- [ ] Audio I/O module (`src/lib/voice-audio.ts`): react-native-audio-api
      capture (16kHz mono, Float32→Int16, per-frame RMS) + streaming PCM
      playback; interface + injectable fake.
- [ ] Voice call core (`src/lib/voice-call.ts`): state machine (idle →
      setup → connecting → live → ended), ptt-start append, mic-frame
      uplink, spk-frame downlink with buffer policy, hang-up append,
      caption derivation from lifecycle + colleague-status/note events.
      Pure TS, no RN imports, so it runs in node.
- [ ] Setup marker logic (config hash in AsyncStorage) + `setupVoiceAgent`
      call via `itx.workers.get` (entrypoint ref mirrors
      `apps/os/scripts/voicelab/voice-agent-ref.ts`).
- [ ] UI: voice button on the note pill/composer, pulsing with level; in-call
      sheet (pulse + hang-up + caption).
- [ ] Expo config: react-native-audio-api plugin, NSMicrophoneUsageDescription,
      audio session (playAndRecord / voiceChat / defaultToSpeaker).
- [ ] Unit tests: state machine, caption derivation, PCM conversion + RMS,
      setup-marker hash logic (vitest, fake audio via the DI seam).
- [ ] Headless node wire-driver: run the shipped voice-call module against
      prd `voicelab-eval` with WAV-fed fake audio; assert spk-frames arrive
      and durable transcripts land.
- [ ] Native build via mobile PR-preview CI (fingerprint change → full-install
      QR in PR body).
- [ ] Permanent explainer in `explainers/` (linked from PR; servable via
      iterate.iterate.app/explainers/…).
- [ ] ~2am: iPhone-mirroring test — capture spike first (non-empty frames +
      moving level), then a real conversation.

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
