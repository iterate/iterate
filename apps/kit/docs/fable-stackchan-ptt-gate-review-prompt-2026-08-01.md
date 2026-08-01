# Fable review: StackChan PTT/audio publication boundary

Work read-only in
`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.

The M5StickS3 production voice slice is already achieved and must not be
redesigned. We are porting the same manual-PTT `/pcm` and Cap'n Web contract to
StackChan. Review the smallest clean shared-core change needed to gate
continuously captured/AEC-processed audio so only frames belonging to a manual
PTT turn reach the bounded PCM uplink lane.

Inspect at least:

- `apps/kit/firmware/components/core/{include,src}`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/`
- `apps/kit/firmware/targets/stackchan/`
- relevant tests under `apps/kit/firmware/tests/`
- `apps/kit/firmware/AGENTS.md` and its linked reasoning-comment guidance
- the measured prior art in
  `/Users/jonastemplestein/src/github.com/iterate/stackchan`
- relevant ESP-IDF/FreeRTOS/ESP-SR source and primary documentation available
  locally or online

The proposed design is an allocation-free SPSC command gate:

1. The control task enqueues ordered start/stop commands.
2. The AEC task remains the sole PCM uplink producer.
3. It consumes the commands, publishes complete clean frames only while active,
   and publishes the zero-length end-of-turn marker itself after stop so it
   cannot overtake the final accepted frame.
4. A nonblocking callback wakes the WebSocket transport after each accepted
   item.
5. Queue-full, marker-full, inactive-discard, and state-transition outcomes are
   explicit metrics; there is no retry loop or hidden backlog.

Challenge this design. Look especially for cross-core memory-ordering errors,
lost start/stop edges, end-marker races, interaction with AEC continuity,
unbounded latency, false error metrics, needless queues/copies, and ways to
delete or reuse existing machinery. Compare at least two materially different
alternatives, including the simplest credible one. Recommend only near-term
changes that shorten the path to a real StackChan conversation while preserving
the realtime/audio and diagnostic invariants. Include concrete failing tests
that should exist. Do not edit files, flash hardware, deploy, commit, push, or
expose secrets.

Return a concise but technically exact Markdown report with findings ranked by
severity and a final keep/change/delete recommendation.
