# Independent Fable Max review: fastest clean M5StickS3 vertical proof

Work read-only in
`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.
Do not edit implementation or tests. Write your complete durable report to:

`apps/kit/docs/fable-m5sticks3-time-to-goal-review-2026-07-31.md`

This is a bounded review to reduce time-to-goal, not a request to broaden the
project. Prioritize the shortest production-shaped route to this exact slice:

1. freshly flash M5StickS3 with the normal shared TypeScript path;
2. connect it to a real Iterate userspace app/worker and mount its Cap'n Web
   capability;
3. hold the physical PTT button and prove microphone PCM reaches the
   userspace `/pcm` endpoint continuously before release;
4. forward a real turn to `grok-voice-think-fast-2.0`;
5. relay returned PCM and hear it on the Stick;
6. retain a deterministic tone/PRBS return mode in the same userspace path so
   provider variability is separable from transport/audio correctness.

Read first:

- `apps/kit/docs/m5sticks3-vertical-slice-landing-2026-07-31.md`
- `apps/kit/docs/physical-device-voice-goal.md`
- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`
- `apps/kit/docs/fable-esp32-receive-stall-reconciliation-2026-07-31.md`
- the current `apps/kit/` source and tests;
- the latest retained evidence under
  `apps/kit/evidence/m5sticks3-playback/`, especially
  `direct-lan-tone-60s-taskless-control-serial-diagnostic-20260731-0508`.

The latest decisive fact is that the ROM reported a brownout and reset under
speaker load. Saved PC `0x403758a2` resolves to ESP-IDF's
`rtc_brownout_isr_handler`. Challenge any continued networking work that is
actually compensating for that reset.

Your report must:

- propose concrete deletions, cleanups, architectural simplifications, and
  harness simplifications ranked by **hours saved before the vertical proof**;
- identify what should be deferred even if it remains part of the parent goal;
- identify any current abstraction that is a local maximum;
- distinguish changes required before the proof from cleanup that can follow;
- propose the smallest safe response to the speaker-load brownout, using
  M5StickS3/M5Unified/ES8311 source evidence and never disabling brownout
  protection;
- inspect whether mocked tone/PRBS already traverses the real userspace `/pcm`
  codepath and state the minimum missing work, if any;
- inspect whether a real userspace worker/preview/Grok mode already exists and
  give exact commands/files for the fastest real run;
- propose a minimal automatic network-validity evidence contract correlating
  RSSI/link/reconnect, device/router ping RTT/loss, DNS/connect, sockets, and
  the exact audio interval;
- list tests to delete, retain, or add, favoring one or two high-value red
  regressions rather than another sprawling framework;
- include file/line evidence and flag unsupported guesses explicitly.

Do not require StackChan, four-device support, AEC, or perfect ten-minute
endurance before this Stick slice. Do not recommend larger audio buffers as a
generic fix. Do not write a long future-platform design. Finish the report,
then stop.
