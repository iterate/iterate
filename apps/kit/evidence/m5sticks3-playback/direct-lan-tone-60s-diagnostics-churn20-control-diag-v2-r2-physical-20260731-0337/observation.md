# M5StickS3 loaded-playback failure: control stall followed by PCM starvation

Status: retained failing physical evidence, 2026-07-31. This run is not an
endurance pass and is not proof of a root cause.

## Exact run

The target was the M5StickS3 identified immediately before the run as
`70:04:1D:D5:45:88` on `/dev/cu.usbmodem11201`. The harness did not attach a
serial monitor because doing so changes the timing of the audio workload.

```text
pnpm device:e2e -- --no-flash \
  --port /dev/cu.usbmodem11201 \
  --build-directory firmware/targets/m5sticks3/build \
  --direct-lan-host 192.168.0.169 \
  --direct-lan-port 58685 \
  --tone-playback-only \
  --playback-duration-ms 60000 \
  --mount-timeout-ms 180000 \
  --exit-after-remote-proof \
  --device-clocked-downlink \
  --device-clocked-startup-frames 7 \
  --control-churn-hz 20
```

The control-load work unit was one sequential `getDiagnostics()` call at a
requested 20 calls/s. The PCM lane simultaneously sent 640-byte, 20 ms,
16 kHz mono PCM16LE tone frames over the independent `/pcm` WebSocket.

## Artifact integrity

- `run.log`: 71,310 bytes; SHA-256
  `a2492959bff07d075e58dc962914c462f93470a99cbf58b7933d5614d195b978`.
- `iterate-kit-acoustic-eTI3Ko/microphone.pcm16le`: 1,646,592 bytes /
  823,296 samples at 48 kHz; SHA-256
  `45229fb869f72453eb7216017d503a980cbb7cfb9dd070a69725a3aba841ec5c`.
- The recording input was the MacBook Pro built-in microphone, resolved by
  CoreAudio stable ID `BuiltInMicrophoneDevice`; the complete recorder
  executable and arguments are in `run.log`.

## What happened

The device mounted both sockets and initially made clean progress. The last
complete one-second device sample reported:

- `downlinkAccepted=456`, `playbackSubmitted=452`,
  `playbackCompleted=448`;
- `pcmReceiveCalls=2246`, `pcmReceiveChunks=461`;
- zero downlink loss, playback flush, underrun, freshness, driver,
  write-backpressure, protocol, reconnect, and lifecycle incidents;
- current/high-water downlink content of 4/5 frames and playback content of
  4/4 frames;
- CPU 492 permille;
- 6,652 / 2,416 / 960 / 4,000 bytes of stack headroom for the audio owner,
  main, control-network, and PCM-network tasks;
- 131,379 bytes free internal heap and 114,119 bytes minimum free internal
  heap.

The Cap'n Web trace then shows request 175 reaching the device:

```text
push getDiagnostics  elapsed=10379.739 ms  payload=46 bytes
pull 175             elapsed=10379.982 ms  payload=12 bytes
```

No resolve or reject for ID 175 ever returned. Requests 161 through 174 had
resolved normally with 912-byte replies. The host therefore stopped scheduling
new load after the one-second per-call deadline and allowed a bounded 6.5-second
diagnostic grace period. The same control connection neither delivered a
replacement mount nor completed the stuck request during that interval.

The PCM socket continued to have paced host work offered to it, but its send
callbacks then stopped completing. The bridge closed at its explicit
user-space ownership bound instead of accumulating hidden realtime backlog:

- close code/reason: `4013`, `LAN bridge backpressure.`;
- 671 worker-to-device messages / 429,440 payload bytes;
- maximum PCM interarrival before starvation: 34.670 ms;
- maximum buffered bytes: 5,152;
- payload bytes in flight at close: 5,120;
- send callbacks in flight at close: 8;
- oldest outstanding callback at close: 187.740 ms.

Six seconds after the close, no later playback-metrics callback had advanced
the last device sample. The control churn summary was 171 completed, one
failed, 172 started, 199 scheduled, and 27 deliberately skipped while the
single work unit was busy. Maximum observed call latency was 1,002.271 ms.

## Acoustic result

The causal host marker places the earliest possible response playback at
341.333 ms in the capture. Reanalysis with the checked-in 997 Hz oracle found:

- one continuous tone episode from 687.5 to 9,662.5 ms;
- 8,975 ms observed tone span;
- zero internal gaps and zero-millisecond longest internal gap;
- amplitude coefficient of variation 0.0194;
- 99th-percentile amplitude step 0.152 dB and maximum amplitude step
  0.364 dB;
- one 0.10219-radian terminal phase-step deviation, narrowly above the
  0.1-radian strict threshold;
- 51,025 ms missing from the requested 60-second response because the failing
  run was aborted.

This is an abrupt terminal loss after stable playback, not accumulating
audible jitter or a queue that gradually gets deeper before failure.

## Classification and limits

This evidence proves a coupled loss of observable forward progress under the
20 Hz control workload even though control and PCM use separate application
WebSockets and separate bounded rings. It disproves the earlier
capacity-only claim that increasing the control outbox from four to eight
slots fixed the problem.

It does **not** yet distinguish:

- application-owner failure while serializing or publishing the control reply;
- control transport restart/stop behavior that contends with the PCM owner;
- FreeRTOS scheduling starvation between equal-priority Core-0 network tasks;
- a shared TLS/lwIP/Wi-Fi or RF outage;
- a host/network path failure that happened to begin at the control request.

The bridge's 5,120-byte gate proves bounded Node user-space ownership. It is
not a peer-receipt timestamp and does not reveal bytes already accepted by the
Mac kernel. No queue should be enlarged from this evidence.

## Resulting tests and next discriminator

A new real TypeScript-to-C simulator regression completed 512 sequential
retained `getDiagnostics()` replies in 21 ms. That rules out simple
pending-call-table exhaustion and failure to release the one borrowed JSON
buffer; it does not model ESP-IDF task or network scheduling.

The physical build used equal FreeRTOS priority 5 for both Core-0 application
network owners. A red/green host contract now records the intended precedence:
control remains priority 5 and PCM networking is priority 6, both below
ESP-IDF's radio/TCP system tasks. The exact same physical load must be rerun
after flashing that build. A clean rerun would support, but not by itself
prove, scheduler contention; another failure must retain the next causal
counter/trace rather than trigger another buffer increase.
