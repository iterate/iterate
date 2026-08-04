# Fable Max: simplest StackChan semantic AEC oracle

Work read-only in `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.
Write exactly one report:
`apps/kit/docs/fable-stackchan-semantic-oracle-review-2026-08-03.md`.
Do not edit code, flash hardware, deploy, or create any other file.

Independently audit the shortest route to prove this exact product invariant on
the physical StackChan through the deployed Iterate userspace `/pcm` worker and
real Grok server-side VAD:

- far-end device-speaker-only audio produces no provider `speech_started`, no
  input transcription, and no response;
- independent Mac-speaker speech triggers server VAD promptly, including while
  the device speaker is active, and remains intelligible enough to transcribe;
- transport loss/reset/heap/network failures are separate validity gates.

Inspect the current worker, provider raw-event capture, production Grok proof
scripts, deterministic AEC waveform fixture, AEC assessment, firmware metrics,
and latest evidence at
`apps/kit/evidence/stackchan-exact-tx-reference-reset-fix-20260803/2026-08-03T15-21-34-016Z/`.
Also compare prior reports in `apps/kit/docs/*stackchan*aec*` and the measured
prior-art AEC tooling under
`/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/`.

Focus on simplifying the harness and avoiding false conclusions. Explain:

1. Which existing command can prove the semantic invariant with least new code.
2. Whether post-worker x8 gain invalidates acoustic thresholds or causes Grok VAD
   false positives, and the cleanest way to observe both native and egress truth.
3. Why the latest recorder did not close complete and whether that is a product,
   harness-cleanup, or network defect.
4. What can be deleted, combined, or deferred right now.
5. A bounded next-run matrix with numeric pass/fail criteria; never substitute a
   speaker-active energy gate for AEC because near-end double-talk must survive.

End with at most five ordered actions and call out uncertainty honestly.
