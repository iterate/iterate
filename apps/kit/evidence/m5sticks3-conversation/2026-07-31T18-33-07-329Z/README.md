# M5StickS3 real-Grok interruption proof

Verdict: **PASS — stale speech was audibly cut off, exactly conserved as
played-or-flushed, followed by a fresh audible reply on a network-valid run.**

Before this run, the app image was freshly written and hash-verified on the
M5StickS3 at `/dev/cu.usbmodem11201`, MAC `70:04:1D:D5:45:88`. The image is
1,150,192 bytes (`0x118cf0`) with 45% of its 2 MiB app partition free. App-only
flashing deliberately preserved the already authenticated settings partition
and Captun origin.

The autonomous harness then used the mounted Cap'n Web `pushToTalk` capability
to ask real `grok-voice-think-fast-2.0` to count slowly. Once 26 returned
20 ms frames had crossed the device socket, it asserted PTT again on the
physical Stick before cancelling the provider generation. While that PTT
epoch remained held, the physical microphone streamed the replacement prompt;
release produced the fresh reply `Interruption successful.`

## Causal and frame ledger

- Grok terminated the first response explicitly as `cancelled` and the second
  as `completed` in the same provider session.
- Microphone: 645 frames / 412,800 bytes, with zero drops or failures.
- Speaker: 115 accepted frames = 103 DMA-completed + 12 explicitly
  generation-flushed frames. Nothing is hidden in a generic drop counter.
- The first generation reached 31 accepted frames before cancellation fully
  propagated: 19 completed and 12 were flushed. The fresh response accounted
  for the remaining 84 accepted/completed frames.
- Downlink, playback, and uplink high-water marks were 6, 4, and 1 frames.
  Queues ended at zero. Transport accept age peaked at 1 ms.
- There were zero downlink/uplink drops, transport failures, restart incidents,
  playback failures, and protocol failures.

The device accepted the interrupting RPC in 110.050 ms. The first reply had
been present for 366.996 ms at the request boundary. Replacement microphone
PCM appeared 82.222 ms after device acceptance. After replacement PTT release,
Grok created the response in 306.694 ms, fresh speaker PCM reached the Stick in
992.026 ms, provider completion arrived in 995.648 ms, and the downlink drained
in 2,514.804 ms.

## Physical acoustic witness

The nearby MacBook microphone—not the digital provider stream—independently
transcribed the short pre-interruption speaker interval as `One.` and the fresh
speaker interval as `Interruption successful.` Those bounded slices are
`acoustic-interrupted-prefix-normalized.{wav,json}` and
`acoustic-fresh-response-normalized.{wav,json}`. The uncut room recording is
`acoustic-witness.wav`; the exact userspace downlink transcribes as
`1. Interruption successful.`

## Interval-aligned network and resources

`physical-network-validity.json` classifies the exact 18.462-second interval
as `valid` with no reasons:

- Stick: 19/19 replies, 3.958–11.608 ms RTT.
- Router: 19/19 replies, 3.189–5.191 ms RTT.
- Captun origin: 19/19 replies, 13.855–40.366 ms RTT.
- Wi-Fi: 20/20 samples link-up, -54 to -53 dBm, zero disconnects.
- DNS: 20.224 ms; TLS connect: 36.640 ms.
- Terminal PCM socket: zero reconnects, disconnects, or transport errors and
  still open at the interval boundary.

Free heap was 8,434,196 bytes at baseline and 8,434,228 at completion, with an
8,411,768-byte observed minimum. Free internal heap was 56,143 then 56,175
bytes, with a 27,463-byte observed minimum. CPU samples were 162 permille at
baseline, 335 while the second microphone epoch was held, and 169 at the end.

## Instrumentation correction and boundary

The preceding otherwise-valid run in `../2026-07-31T18-25-45-863Z/` exposed a
harness bug: a stale first-generation frame was assigned to turn 2 and yielded
an impossible negative fresh-speaker latency. A regression test now requires a
new provider `response.created` causal fence before speaker PCM can start the
replacement turn's clock. This run is the retained acceptance artifact because
it proves the corrected positive 992.026 ms measurement; the earlier raw run
remains available rather than being erased.

This is a real physical-microphone and physical-speaker barge-in proof driven
by remote Cap'n Web PTT. It does not claim human Button A provenance or the
deferred deployed dynamic-worker generation/remount lifecycle.
