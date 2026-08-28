# Interview: mobile-voice-client

## Q1 — turn posture: open-mic vs client-segmented — 2026-08-28T00:0x
(sub-claude recommends open-mic, boards' path; button = press to start call, tap to end)

## A1
Open-mic, agreed — the phone is a boards-class client, not a walkie-talkie. Press = start call, tap again = hang up, model hang_up + 60s idle deadline as backstops. Two riders: (1) open-mic on a phone SPEAKER self-barges without echo cancellation, so the audio session must use iOS voiceProcessing AEC (playAndRecord + defaultToSpeaker + voiceProcessing) — treat AEC as a hard requirement of the audio-lib choice, and if it proves flaky, downgrade gracefully by keeping open-mic but routing to earpiece [guess: AEC-first is the right default; boards prove the posture works with far-field VAD threshold 0.85]. (2) The pulse is pure VU feedback from local mic level, never a turn control.

---
## Q2 — native audio library — researched table (react-native-audio-api vs siteed vs mykin vs live-audio-stream)

## A2
Lock react-native-audio-api (Software Mansion — active, real Expo plugin, iosMode voiceChat = VoiceProcessingIO AEC). We can't spike on-device before the EAS build lands anyway (no local Xcode, phone test happens ~2am), so: (1) put the audio I/O behind one small module boundary (record frames in / pcm chunks out / level callback) so a swap to @siteed/audio-studio is one file, (2) make the 2am on-phone check START with the capture spike (non-empty Int16 frames + level) given open issue #721, and note the earpiece fallback is AVAudioSession-level not library-level. Float32→Int16 conversion + RMS locally is fine. [guess: SW Mansion maintenance beats mykin's purpose-fit; #721 risk accepted because the fallback swap is contained]

---
## Q3 — stream path scheme — recommends stable per-device /agents/voice/mobile-<deviceId>

## A3
Stable per-device, exactly as recommended — the boards' pattern, and it showcases the whole point of this branch (per-stream colleague memory + reconnect recap: the phone keeps ONE ongoing voice relationship, and a call resumes mid-thread). Path /agents/voice/mobile-<deviceId> via the existing getMobileDeviceId(). No slug prettiness needed [guess: raw uuid in the path is fine for a demo; a human can find it via the agents list].

---
## Q4 — setup responsibility — recommends app calls setupVoiceAgent idempotently before every call; skip posture guard

## A4
Yes app-owned setup, no posture-guard port — but not before EVERY call: setup appends occurrence-keyed configured events and pays a warm barrier (~1-2s) each run, which is dead latency on tap. Cache a local marker (AsyncStorage: streamPath -> hash of the config payload we'd send) and only call setupVoiceAgent when the marker mismatches (first ever call, or when we change the baked config in an app update). Failure -> surface error, don't open the mic. [guess: call-start latency matters more than re-assertion; content-hash marker is the cheap idempotence]

---
## Q5 — uplink frame size — recommends 100ms frames, one append per callback, no batching

## A5
One event per capture callback, no batching layer — agreed. But go ~64ms not 100ms: capture APIs hand out power-of-two buffers anyway, and 1024 samples @16k = 64ms lands ~16 appends/s while halving the barge-detection tax; phone RPC can take it. If the library's callback granularity fights us, anything in the 40-100ms band is acceptable — pick what falls out naturally and note the actual number in the task. [guess: 64ms sweet spot; not measured]

---
## Q6 — in-call UI — recommends compact sheet: pulse + hang-up + one-line status/note caption (no transcript)

## A6
B, caption-only — agreed and endorsed: the status/note lane is the novel bit of this branch, and it is one useLiveEvents subscription on durable events. One line of quiet text under the pulse (latest colleague-status activity/phase, or the newest colleague-note briefly), a hang-up control, and the pulse. Also show the boring call lifecycle in the same caption slot (connecting / listening / call ended) so the sheet never looks dead [guess]. No transcript, no scrollback.

---
## Q7 — pre-2am verification plan — unit tests + DI fake audio + expo-web spec; floats a node wire-driver option

## A7
Take the plan, and PROMOTE your floated option: the node wire-driver is the single highest-value pre-phone test — run the app's actual voice-client module (the same TS that ships in the bundle) in node with the fake audio seam feeding say-generated WAV frames, against the real prd voicelab-eval project, and assert spk-frames arrive + durable transcripts land. That is the C converse driver's job done by the NEW code, and it proves everything except native audio before the phone exists. Unit tests as listed. The expo-web Playwright scenario is nice-to-have — do it only if time is spare [guess: prioritization]; never report AEC/barge as tested from the laptop.

---
## Q8 — mic permission — lazy request on first tap; denial -> caption message

## A8
As recommended. One cheap addition: make the denial caption tappable -> Linking.openSettings() since RN has it for free; otherwise identical. Button always visible.

---
## Q9/termination — sub-claude summarized all eight resolved branches and said "ready for Phase 2".
