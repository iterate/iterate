# M5StickS3 multi-turn pacing review

Act as an independent, adversarial realtime-audio architect. Review the current production-shaped M5StickS3 voice path, but do not edit implementation code, flash hardware, deploy, or run destructive commands. Write your complete report to:

`apps/kit/docs/fable-stick-multiturn-pacing-review-2026-08-01.md`

The immediate goal is the shortest clean path to prolonged multi-turn manual-PTT conversations through the deployed Iterate userspace `/pcm` worker and real `grok-voice-think-fast-2.0`. We require bounded latency, no accumulating backlog, exact loss accounting, and no unexplained disconnects. The user must not press buttons; the harness triggers capabilities remotely.

Fresh physical evidence is in:

- `apps/kit/evidence/m5sticks3-long-story-red-2026-08-01/2026-08-01T18-09-55-840Z/failure.json`
- `apps/kit/evidence/m5sticks3-long-story-fixed-2026-08-01/2026-08-01T18-29-19-501Z/failure.json`
- adjacent `provider-events.jsonl` and `network.json` artifacts.

The first run found a real fixed-capacity userspace response-reservoir overflow. Current source raises that bounded reservoir to 60 seconds and retires only an oversized provider generation. The second run retained a complete 68.061-second Grok answer without socket closure or userspace overflow, with zero transport/device-lane drops. It nevertheless had two firmware playback underrun incidents: four recovery-silence frames were submitted and four corresponding late content frames were discarded (80 ms total). Detailed playback moved from accepted/submitted/completed 60/60/60 to 3464/3460/3460. Maximum device downlink interarrival was 160 ms. Userspace currently primes eight 20 ms frames, then sends one frame per timer deadline; `nextPcmFrameDeadline()` deliberately restarts its grid after a whole-frame timer miss, permanently spending the lead instead of bounded catch-up. Relevant code:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts` and tests
- `apps/kit/src/voice/pcm-frame-pacer.ts`
- `apps/kit/src/voice/device-pcm-proxy.ts`
- `apps/kit/firmware/platforms/common/include/iterate/kit/platforms/realtime_playback.hpp`
- `apps/kit/firmware/platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp`
- `apps/kit/firmware/platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_realtime_audio_policy.hpp`
- `apps/kit/scripts/prove-production-m5sticks3-grok.ts`

A separate prior multi-turn run also showed one first-frame uplink discard on turn two: the turn-two PCM frame crossed the dedicated `/pcm` WebSocket before the independently delivered Cap'n Web `pushToTalk.started` callback, and userspace mistook it for late turn-one media after the prior end marker. Relevant state machine and regression are near the manual-PTT cases in `apps/kit/src/userspace/config-worker/pcm-proxy.test.ts` and `pcm-proxy.ts`.

Please inspect the code, tests, ESP-IDF direct-I2S contracts/source already available locally, and relevant first-party docs/source. Focus on:

1. Whether bounded deadline catch-up in userspace is the right repair for scheduler stalls, and an exact algorithm that distinguishes a delayed timer with a full source reservoir from genuine provider-source starvation.
2. Whether increasing device lead/DMA descriptor count is necessary or merely masks a userspace pacing defect; quantify RAM/latency/interruption trade-offs.
3. The simplest correct manual-PTT control/media state machine across two WebSockets, including delayed old stop, early new media, markers, reconnects, and exact metrics.
4. Deletions or simplifications that reduce moving parts and time-to-goal without weakening observability or loss/freshness behavior.
5. Specific red tests that exercise real event-loop delay rather than fake timers that silently execute every missed deadline on time.

Give materially different designs and choose one near-term recommendation. Separate evidence from inference. Call out any current reasoning that is wrong. Keep near-term actions bounded to the Stick landing milestone; defer StackChan/HAVPE portability suggestions.
