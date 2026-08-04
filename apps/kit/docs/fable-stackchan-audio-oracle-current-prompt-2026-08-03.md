# StackChan audio-oracle and harness simplification review

Use Claude Fable with maximum effort. Work read-only except for writing the
final report to
`apps/kit/docs/fable-stackchan-audio-oracle-current-review-2026-08-03.md`.
Do not modify firmware or tests.

Independently inspect the current StackChan audio implementation, production
userspace `/pcm` worker, host/device harnesses, exact raw Grok events, and the
newest evidence:

- `apps/kit/scripts/prove-production-stackchan-grok.ts`
- `apps/kit/scripts/prove-local-aec.ts`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts`
- `apps/kit/evidence/stackchan-analog-reference-voip-20260803/2026-08-03T18-00-26-107Z`
- `apps/kit/evidence/stackchan-production-grok-receipt-fix-20260803/2026-08-03T18-19-08-334Z`

The newest firmware fixed an interruption flow-control defect: a production
run now has 364 items sent, 364 acknowledged, zero in flight, zero receipt
timeouts, three completed interruption barriers and an open socket. Do not
reopen that solved transport question unless you find contradictory evidence.

The remaining issue is acoustic/semantic: a short “Hey pal” turn was transcribed
as “Playtime” by Grok and as “Yeah, and one PayPal” by an independent STT pass.
Long prompts are mostly intelligible, but real barge-in evidence shows imperfect
near transcription and self-talk/VAD contamination. The current harness also
labels harmless transcription variants as “contaminated” and its acoustic Mac
mic window can miss physically audible output.

Propose the smallest decisive, reproducible oracle stack that separates:

- raw mic hardware quality;
- local AEC far-only suppression;
- local AEC double-talk near preservation;
- the exact accepted PCM reaching userspace/Grok;
- Grok transcription/provider behavior;
- physical speaker playout;
- VAD self-trigger versus genuine near speech.

Prefer reusing exact captured PCM and deterministic electrical/acoustic stimuli.
Identify deletions or simplifications to the current harness that reduce false
failures without weakening transport conservation, socket/reset, double-talk,
or network-validity gates. Give no more than five near-term actions in rank
order, each tied to an existing seam/file and a concrete pass/fail result.
