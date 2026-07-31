# Startup-seven one-minute attempt 1

This is a retained failed physical discriminator, not an acceptance artifact.
The initial shell invocation accidentally addressed the `tee` output path
relative to `apps/kit` as though it were the repository root, so no raw
`run.log` was created. The microphone recording and exact terminal evidence
printed by the runner were preserved rather than silently discarding the run.

Command parameters:

- no flash;
- exact serial port `/dev/cu.usbmodem11201`;
- esptool-reported MAC `70:04:1d:d5:45:88`;
- direct LAN `192.168.0.169:58685`;
- deterministic 997 Hz tone for 60,000 ms / 3,000 frames;
- device-clocked downlink;
- `deviceClockedStartupFrames = 7`.

Terminal PCM bridge evidence:

- close code: 4013;
- close reason: `LAN bridge backpressure.`;
- elapsed: 24,864.078292 ms;
- worker-to-device messages/bytes before close: 1,189 / 760,960;
- maximum worker-to-device interarrival: 42.279125 ms;
- maximum raw socket buffered bytes: 5,152;
- maximum exact PCM payload bytes in flight: 5,120 / eight frames;
- exact PCM payload bytes in flight at close: 5,120 / eight frames;
- maximum send callbacks in flight and at close: eight;
- oldest callback age at close: 156.661458 ms;
- maximum callback latency: 2.566125 ms.

The exact payload ledger proves that this was a real exhaustion of the fixed
160 ms media budget, not WebSocket framing overhead. Closing is the intended
freshness outcome: the bridge must not retain more old conversation and replay
it after the stall.

The preserved Mac microphone recording contains 1,163,264 samples at 48 kHz.
Its SHA-256 is
`54bb284799bfa0513c2e1d13c5a4d43f96cbbe0b22437c1800178d68017c3c02`.
Because the strict transport gate aborted the run and the raw runner log was
not captured, this artifact must not be reported as a completed one-minute
acoustic assessment.
