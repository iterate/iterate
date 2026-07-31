# M5StickS3 unattended real-Grok vertical proof

Verdict: **passed**, with exact digital accounting, an independent acoustic
transcription, and a network-valid interval. No person pressed the device.

## Production-shaped path exercised

The harness remotely invoked the Stick's mounted Cap'n Web `pushToTalk`
capability, spoke a deterministic prompt from macOS into the physical Stick
microphone, streamed PCM over the device's independent `/pcm` WebSocket through
the real local userspace bridge, called `grok-voice-think-fast-2.0`, and played
the returned PCM through the Stick speaker. The control and PCM sockets both
used the same userspace app; this run did not use the production Cloudflare
deployment.

The userspace source policy retained up to 32 generated frames before starting
while priming only the existing eight-frame device lead. This split was added
after a prior physical cue observed a 203.28 ms provider packet gap: provider
jitter is absorbed in Mac memory without increasing ESP RAM or dumping a
larger burst into its WebSocket path.

## Exact media evidence

- Stick microphone to Grok: 428 frames / 273,920 bytes, SHA-256
  `0aaefdb731b8050f5d669064b5c5d65b27b1817351d7f8731b45a0a43a488f02`.
- Grok to Stick speaker: 244 frames / 156,160 bytes, SHA-256
  `faf1cf6a29751adc5c26f84e94dbb8903c2389a0bbaf3a40e77aa7512a54f670`.
- Device counters at completion: downlink accepted 244, playback submitted
  244, playback completed 244.
- Zero capture/uplink/downlink/playback drops or failures, zero flushed frames,
  zero underrun/freshness/DMA-deadline incidents, zero resets, and zero protocol
  failures. All queues returned to zero.
- Device high-water marks were one uplink frame, six downlink frames, and four
  playback descriptors. Maximum measured receive-to-DMA-start delay was 175 ms;
  maximum device-observed downlink interarrival was 50 ms. The userspace bridge
  measured 23.376 ms maximum worker-to-device interarrival.
- The xAI output transcript was: “The unattended stick voice test passed with
  clear, continuous playback.”

`microphone-uplink.pcm16le`, `speaker-downlink.pcm16le`, `summary.json`, and
`timeline.jsonl` retain the exact digital lanes and event timing.

## Independent acoustic witness

The built-in Mac microphone recorded the room throughout the physical run.
`acoustic-room.wav` has SHA-256
`5513342f8b9901b24488897573577b83a6895e44146fea5478a9882e5aa7b988`.
An independent `gpt-4o-transcribe` call returned:

> The unattended stick voice test passed with clear continuous playback.

The raw CoreAudio capture and its verified input provenance remain under
`iterate-kit-acoustic-ChfQet/`; `acoustic-transcription.json` records the
transcription model, source digest, text, and usage.

## Network-valid classification

`physical-network-validity.json` automatically classified the exact 14.987 s
audio interval as `valid`, with no reasons:

- all 16 expected on-device diagnostics samples arrived;
- Wi-Fi remained associated throughout, RSSI ranged from -39 to -32 dBm, and
  the pre-existing disconnect count did not change;
- all 15 expected device, router, and userspace-host reachability samples
  replied; maximum device RTT was 22.905 ms and maximum router RTT was
  14.868 ms;
- the PCM socket stayed open with zero reconnects, disconnects, or transport
  errors and conserved the same 273,920 uplink / 156,160 downlink bytes.

## Resource evidence

During the run the lowest observed internal heap was 105,539 bytes; the lowest
observed main-task stack headroom was 2,376 bytes. Audio-owner, control-network,
and PCM-network stack headroom remained 6,652, 5,912, and 6,336 bytes
respectively. Observed CPU reached roughly 330 permille while transmitting the
spoken prompt and was 260 permille at final playback conservation.

`firmware-build-footprint.json` records the current target build: a 1,150,208
byte binary with 45% of the 2 MiB application partition free. DIRAM is 70.06%
used. The reported 16 KiB IRAM segment has only one byte remaining; the realtime
ELF audit passed, but this is a real portability/maintenance pressure and must
not be hidden.

## Remaining boundary

This is the credible local-userspace Stick vertical slice. It does not yet
prove the production userspace worker route or a human physical-button edge.
The latter was deliberately omitted because the run had to be autonomous; the
same semantic start/stop events were exercised remotely through Cap'n Web.
