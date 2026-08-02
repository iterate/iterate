# Fable review prompt: StackChan interruption and fastest physical proof — 2026-08-02

Work read-only in `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities` except for writing your final report to:

`apps/kit/docs/fable-stackchan-interruption-proof-review-2026-08-02.md`

Do not edit implementation, tests, firmware, configuration, evidence, git state, deployments, or hardware. Do not commit or push.

## Immediate context

- The M5StickS3 production vertical slice is already closed with a network-valid, three-turn, exact-conservation proof. Do not reopen it.
- StackChan is next. It must use the shared architecture, local ESP-SR AEC, Grok server VAD, real full-duplex playback, measured interruption, retained metrics/events, and no accumulating queue delay.
- Prior physical StackChan evidence under `apps/kit/evidence/stackchan-*` already measured about 5.97 dB echo suppression, preserved near-end speech, one completed server-VAD turn, and audible Grok playback, but the overall run was network-invalid and later barge-in timed out.
- The device is now in a better Wi-Fi location. The target project is `prj_0363ecd53eda492e972b07debd56eb46`; its deployed userspace worker is stale and is about to be replaced from current source.
- A newly added regression in `pcm-proxy.test.ts` reproduces two Grok `speech_started` edges separated by `speech_stopped` while the first hardware playback purge acknowledgement is still pending. Current uncommitted code in `pcm-proxy.ts` coalesces the second edge behind the existing downlink barrier and exports `playbackInterruptionsCoalesced` rather than issuing a second concurrent Cap'n Web call. The focused test and all 41 PCM proxy tests pass.
- The C `conversation.interruptPlayback()` capability remains deliberately one-slot and rejects an independently concurrent caller; its promise resolves only after the audio-owner token completes.

## Review task

Independently trawl the current userspace worker, C capability, CoreS3 audio owner, StackChan target, host tests, production proof harness, retained evidence, local prior-art checkout at `/Users/jonastemplestein/src/github.com/iterate/stackchan`, and applicable first-party ESP-IDF / ESP-SR / codec source and documentation already on disk. Internet research is allowed only where it materially closes a first-party fact.

Answer, with source paths/symbols and confidence labels:

1. Is userspace coalescing safe under all relevant orderings? Prove or falsify the key invariant: while the first purge is pending, no downlink sample associated with a later response can become physically reachable. Include conversation boundaries, late promise settlement, provider `response.created`/binary reordering, socket closure, and a second speech cycle.
2. Would making the C capability itself multi-waiter/idempotent be materially safer, or merely add state/RAM and expand the bug surface? Recommend one bounded near-term design, not a menu.
3. Identify missing red tests at public seams that can catch a real session-killing or stale-audio regression. Avoid implementation-coupled tests.
4. Give the shortest production-shaped sequence to obtain first a retained normal StackChan turn, then measured AEC, then a real barge-in proof. Point out any harness rule that still erases valid earlier phases.
5. Propose deletions, cleanups, or architectural/harness simplifications that reduce time-to-goal. Explicitly call out tempting DSP, watchdog, buffer, or abstraction changes that should _not_ be made before measurement.
6. Audit runtime implications: audio priority, blocking, buffer bounds/freshness, internal RAM, stack, and metric cost. Do not infer a DSP defect from a network-invalid interval.

Reconcile the earlier report `apps/kit/docs/fable-stackchan-fastest-next-proof-2026-08-02.md`; do not repeat it. Keep this review bounded to near-term actionable findings. End with a ranked go/no-go checklist for the next physical run.
