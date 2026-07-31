# Independent Fable Max review: fastest sound StackChan port

You are an independent Claude Fable Max reviewer working in
`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.

The immediate engineering task is to port the already-proven M5StickS3 voice
vertical slice to M5Stack StackChan/CoreS3 without creating a second audio
architecture. The production-shaped contract is two authenticated WebSockets:
Cap'n Web capabilities and a bounded PCM-v1 lane. Raw, ordered, non-PCM Grok
events must remain observable in the normal Iterate stream
`/devices/stackchan`. StackChan acceptance is real full-duplex audio,
interruption, and measured AEC. Historic unbounded/seconds-long queues are
explicitly forbidden: after any overload or network outage, stale microphone
or playback history must be discarded so the next conversation is live.

Read deeply, including source rather than only prose:

- `apps/kit/firmware/AGENTS.md`
- `apps/kit/docs/reasoning-comments.md`
- `apps/kit/docs/stackchan-portability-notes-2026-07-31.md`
- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`
- `apps/kit/docs/m5sticks3-vertical-slice-landing-2026-07-31.md`
- `apps/kit/firmware/components/core/`
- `apps/kit/firmware/platforms/iterate_esp_idf/`
- `apps/kit/firmware/targets/m5sticks3/`
- `apps/kit/firmware/targets/stackchan/`
- the read-only prior-art checkout
  `/Users/jonastemplestein/src/github.com/iterate/stackchan`, especially
  `experiments/02-minimal-realtime-aec/firmware-ws`
- the locally installed ESP-IDF, ESP-SR, CoreS3 BSP, I2S, ES7210 and AW88298
  source/docs that actually determine timing and ownership.

Independently propose the shortest clean implementation path. Look hardest for
deletions and architectural simplifications, not incremental layers. Check the
proposed direct-DMA cadence, task/core/priority ownership, bounded queue sizes,
capture/reference alignment, AEC reset semantics, interruption semantics,
observable failure metrics, and how to obtain falsifiable AEC measurements
without inventing a USB diagnostics protocol. Identify concrete defects or
false assumptions in the current code. Distinguish must-fix-before-flash from
follow-up work. Include a minimal test/evidence sequence that gets to physical
proof quickly.

Do not modify production code. Write the complete, evidence-cited report only
to:

`apps/kit/docs/fable-stackchan-fast-port-review-2026-07-31.md`

End with a concise reconciliation checklist for the primary agent. Do not
commit or push.
