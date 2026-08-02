# Fable Max checkpoint: StackChan production proof and AEC oracle

Perform a bounded, read-only, max-effort review of the current
`c-capabilities` worktree. Do not edit files, deploy, flash hardware, or invoke
any state-changing external API. Return a concise report with exact evidence.

## Immediate goal

Prove one physical M5Stack StackChan conversation through the real production
OS userspace worker and Grok `grok-voice-think-fast-2.0`. StackChan continuously
sends locally echo-cancelled mono PCM16 at 16 kHz while Grok owns server VAD.
Grok's greeting and replies must play loudly on StackChan; a nearby Mac speaker
provides deterministic near-end speech and its microphone records the physical
return. The proof must retain raw Grok events/transcripts, one-second device
and AEC metrics, PCM accounting, and interval-aligned network attribution.

An earlier probe accidentally used a second `workers.get(...)` ITX client
during the call. That caused the dynamic worker incarnation to be replaced and
cleanly FIN-closed the device socket. The next harness must acquire exactly one
project session and one `KitVoiceWorker` handle and retain them from preflight
through all evidence reads and cleanup.

The deployed provider configuration now explicitly uses server VAD threshold
0.5, 400 ms prefix padding, and 1000 ms silence. The prior implicit xAI default
was threshold 0.85; measured clean near-end StackChan speech had peaks around
1400--2300 and mean absolute values around 130--330, so the default apparently
did not trigger. Do not recommend firmware gain unless evidence shows the
explicit threshold still fails; avoiding avoidable clipping/headroom loss is a
goal.

## Inspect

- `apps/kit/src/device/stackchan-aec-assessment.ts`
- `apps/kit/src/device/stackchan-aec-assessment.test.ts`
- `apps/kit/scripts/prove-production-m5sticks3-grok.ts`
- `apps/kit/scripts/prove-production-grok-from-device.ts`
- `apps/kit/src/userspace/config-worker/worker.ts`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts`
- `apps/kit/src/userspace/config-worker/providers.ts`
- `apps/kit/firmware/targets/stackchan/main/stackchan_audio_owner.*`
- `apps/kit/firmware/targets/stackchan/main/main.c`
- `apps/kit/firmware/components/core/src/core_s3_audio_owner.c`
- `apps/kit/evidence/stackchan-aec-probe/live-2026-08-01T17-39Z/device-metrics.json`
- `apps/kit/docs/fable-stackchan-aec-signal-review-2026-08-01.md`
- matching first-party ESP-IDF 5.4.2 / ESP-SR code at
  `/Users/jonastemplestein/esp/esp-idf` and locally fetched M5Stack BSP sources.

Use primary upstream documentation/source if web research materially settles a
question. Explicitly distinguish first-party facts, deductions from retained
evidence, and uncertainty.

## Questions

1. Are the far-end suppression and near-end preservation gates measuring the
   right channels and quantities? Identify false-pass/false-fail risks and the
   smallest correction, with a test.
2. Are the 3 dB suppression, 0.5--2.0 preservation, 30 ms processing, and 100
   ms capture-to-uplink provisional limits defensible for this landing proof?
   Do not invent stricter numbers without a cited physical/source basis.
3. What exact same-session state transitions and counters prove server VAD,
   response playback, and barge-in without relying on timing folklore?
4. Can any current test-harness layer or concept be deleted? Prefer the
   shortest reliable production-shaped proof over a framework rewrite.
5. Identify only blockers for the next physical run. Put StackChan endurance,
   HAVPE/XMOS portability, and optional sophistication in a clearly deferred
   section.

For each actionable finding include severity, file/symbol evidence, the failure
it explains or prevents, and the smallest fix plus regression test. Say plainly
if the current design is already adequate for the next run.
