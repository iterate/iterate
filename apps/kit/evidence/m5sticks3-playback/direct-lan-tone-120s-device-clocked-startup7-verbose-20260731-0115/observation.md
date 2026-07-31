# Two-minute startup-watermark attempt: transport freshness failure

This was a no-flash physical M5StickS3 run against the exact device identity
`70:04:1d:d5:45:88` on `/dev/cu.usbmodem11201`. It requested 120 seconds of
16 kHz mono PCM16 deterministic tone, with device-clocked downlink and a
seven-frame startup watermark. The environment accidentally set
`ITERATE_KIT_VERBOSE_PLAYBACK_METRICS=1`; the implemented switch is
`ITERATE_KIT_VERBOSE_METRICS=1`, so this artifact contains startup and
terminal snapshots rather than the intended one-second series.

The run failed closed after 26.664 seconds:

- close code: `4013` (`LAN bridge backpressure`)
- exact content payload outstanding: 5,120 bytes / eight 640-byte frames
- send callbacks outstanding: eight
- oldest outstanding callback: 159.296 ms
- raw Node WebSocket `bufferedAmount`: 5,152 bytes
- maximum completed callback latency before the stall: 1.051 ms
- maximum worker-to-device frame interarrival before the stall: 34.552 ms
- frames emitted toward the device: 1,283 / 821,120 content bytes

The exact-payload ledger therefore reached its existing 160 ms freshness
budget and deliberately closed rather than accepting a ninth frame or
replaying stale audio after recovery. This is the second startup-watermark run
to expose an approximately 160 ms host-to-device no-progress interval; another
otherwise identical one-minute run completed cleanly. The evidence localizes a
remaining stochastic transport/scheduling fault, not a reason to enlarge the
audio queue or freshness budget.

SHA-256:

- `run.log`:
  `06088360e7647fe1f3ca88fadd93751b545dae6c2f9ed2f8fcb864883830e13c`
- `microphone.pcm16le`:
  `06ebe1cdb5bff15c00ac2c2fc983ecd96a1bb829dbc6270ccc1c4d550b2755bd`
