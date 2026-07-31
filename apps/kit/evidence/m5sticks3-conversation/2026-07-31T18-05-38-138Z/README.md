# M5StickS3 eight-turn real-Grok conversation

Verdict: **PASS — exact audio accounting, network-valid, and physically
transcribed.**

This is the retained prolonged-conversation acceptance run for the local
userspace path. One physical M5StickS3 mounted `kit.m5sticks3` through Captun,
kept one `grok-voice-think-fast-2.0` session alive for eight remote Cap'n Web
PTT epochs, streamed its real microphone to `/pcm`, and played every returned
response through its speaker. macOS `say` supplied repeatable speech near the
Stick; a separate MacBook microphone recorded the room.

## Exact transport and device result

- Microphone: 2,142 frames / 1,370,880 bytes.
- Speaker: 1,008 frames / 645,120 bytes.
- Every turn independently matched userspace accepted, device submitted, and
  device completed counts. There were zero audio/uplink/downlink drops,
  failures, restarts, playback flushes, underruns, resets, and protocol
  failures.
- Uplink, playback, and downlink high-water marks were 3, 4, and 6 frames.
  Both application queues drained to zero after every turn.
- Maximum microphone transport-accept age was 47 ms. Stop-to-first-speaker
  latency stayed between 720.6 and 925.8 ms; it did not accumulate with turn
  number.
- Free heap moved from 8,425,556 to 8,428,140 bytes. The observed minimum was
  8,405,384 bytes. Free internal heap moved from 56,115 to 56,131 bytes, with
  an observed minimum of 28,795 bytes. Per-turn CPU samples ranged from 163 to
  245 permille.

## Conversation and acoustic witness

The provider's final response transcripts were:

1. `Hello there!`
2. `You asked me to remember the codeword lantern.`
3. `Why did the engineer break up with their partner? Too many variables in the relationship!`
4. `engineer`
5. `Lantern engineers light up the world with innovation.`
6. `Three, two, one, lantern.`
7. `Keep innovating with joy, engineer!`
8. `Lantern goodbye!`

Independent MLX Whisper transcription of the eight room-microphone response
slices recovered the same eight replies, including the remembered word and
cross-turn profession. The minor punctuation/capitalisation differences are
retained in `acoustic-response-turn-*-normalized.json`; they are not silently
normalised into provider text.

## Interval-aligned network result

`physical-network-validity.json` classifies the exact 77.226-second audio
interval as `valid` with no reasons:

- Stick: 78/78 replies, 4.017–58.944 ms RTT.
- Router: 78/78 replies, 2.643–11.539 ms RTT.
- Captun origin: 78/78 replies, 12.632–20.183 ms RTT.
- Wi-Fi: 79/79 samples link-up, -56 to -53 dBm, zero disconnects.
- DNS: 1.719 ms; TLS connect: 37.874 ms.
- Terminal PCM socket: zero reconnects, disconnects, or transport errors and
  still open at the interval boundary.

The bounded post-reset reachability warm-up is retained in `timeline.jsonl`
but is outside the strict interval; strict samples were not deleted or relaxed.

## Artifact map and boundary

- `timeline.jsonl`: per-frame chronology, prompts, provider events, per-turn
  timing/resource ledgers, and network preflight.
- `summary.json`, `microphone-uplink.pcm16le`, `speaker-downlink.pcm16le`:
  complete raw PCM ledger and hashes.
- `physical-network-validity.json`: raw diagnostics/reachability observations
  plus automatic verdict.
- `acoustic-witness.wav` and `acoustic-response-turn-*-normalized.{wav,json}`:
  nearby physical microphone evidence and independent transcriptions.

Remote Cap'n Web PTT makes this unattended but does not claim a human pressed
Button A. Captun terminates at the same local userspace `/api` + `/pcm` process;
this run intentionally does not claim deployed dynamic-worker lifecycle proof.
