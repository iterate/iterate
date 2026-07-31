# M5StickS3 60-second playback with 20 Hz control churn and ICMP sidecar

## Question

The preceding eight-slot inbox run showed both independent WebSocket
connections stop making device-side progress at about the same time. This run
kept the firmware, audio contract, control load, and physical acoustic oracle
unchanged and added a 10 Hz ICMP sidecar to answer one narrower question:

> While the two application sockets are stalled, is the device's station IP
> still reachable?

This is a path-localisation experiment. ICMP cannot by itself distinguish a
device Wi-Fi/driver problem from an AP/RF problem, and it says nothing about
application correctness while the station is reachable.

## Exact setup

Firmware target:

- device: M5StickS3, MAC `70:04:1d:d5:45:88`
- serial port used only by `esptool` to read configuration:
  `/dev/cu.usbmodem11201`
- device IPv4 address: `192.168.0.21`
- Mac direct-LAN server: `192.168.0.169:58685`
- firmware image:
  `apps/kit/firmware/targets/m5sticks3/build/iterate-kit-m5sticks3.bin`
- image size: 1,158,112 bytes
- image SHA-256:
  `cb07e78e26f8ac9a329ca960534970bb97c96437b0d81cf881ace35e0a1cac20`

No serial monitor was attached and no firmware was flashed. The audio command
was:

```text
pnpm --dir apps/kit device:e2e -- \
  --no-flash \
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

The sidecar command was:

```text
ping -D -i 0.1 -c 1200 192.168.0.21
```

On this macOS host, `ping -D` did not add wall-clock timestamps. Consequently
the ICMP alignment below uses the requested 100 ms cadence and sequence
numbers, not invented timestamp precision. The next experiment must timestamp
both the device and router control pings explicitly.

## Durable artifacts

- [`run.log`](./run.log): 18,440 bytes,
  SHA-256 `49668118809f8cb7dfec15143240cc9040465f18cf27ee153659e08f1f1f88e5`
- [`ping.log`](./ping.log): 37,961 bytes,
  SHA-256 `0e1584bb42746718a86b8ee472a787b263f9025a7c42082526f77f95763210e9`
- [`microphone.pcm16le`](./iterate-kit-acoustic-hp386a/microphone.pcm16le):
  2,883,584 bytes / 1,441,792 mono samples at 48 kHz,
  SHA-256 `50298704160905bba77cea8f4165d1000ad2bd8c0090934b2e710b67b2683163`

## Direct observations

The run failed. It did not produce a valid 60-second endurance proof.

The PCM bridge crossed its strict eight-callback / 5,120-payload-byte
user-space freshness gate at elapsed 27,389.406 ms and reset the device TCP
connection with close code 4013. At that boundary:

- 1,317 frames / 842,880 payload bytes had been sent;
- the oldest outstanding callback was 159.439 ms old;
- maximum callback latency observed before the stall was 0.974 ms;
- maximum audio-frame interarrival was 34.372 ms.

The control connection independently completed 400 `getDiagnostics` cycles.
Resolve 403 arrived at control elapsed 23,287.342 ms. Push/pull 404 left the
Mac at 23,309.703 / 23,309.744 ms and never received a response. The bounded
one-second RPC failed; the existing 6.5-second diagnostic grace then expired
before a replacement mount appeared.

The ICMP log is not random 44.9% packet loss. All 347 missing replies form
exactly two contiguous intervals:

- sequence 164 through 338 inclusive: 175 probes, approximately 17.5 seconds;
  this is the expected reset/reboot reachability gap before the test mounted;
- sequence 558 through 729 inclusive: 172 probes, approximately 17.2 seconds;
  this begins during the run and overlaps the coupled control/PCM loss of
  progress.

Replies are continuous immediately before and after the second interval. For
received probes, RTT was min/average/max 3.709 / 6.657 / 64.375 ms.

The acoustic oracle found:

- analysis marker: 341.333 ms;
- observed tone: 715.0 through 22,602.5 ms;
- continuous-tone span: 21,887.5 ms;
- internal gaps: zero;
- phase discontinuities: one;
- maximum phase-step error: 0.117135 rad;
- amplitude coefficient of variation: 0.030148;
- p99 / maximum amplitude step: 0.128906 / 0.655947 dB;
- missing requested tone: 38,112.5 ms.

The tone therefore remained substantially continuous while data flowed and
then truncated abruptly; it did not gradually accumulate a playable backlog.

The last pre-playback resource sample reported 123,155 bytes free internal/DMA
heap, 115,591 bytes minimum, and stack headroom of 6,652 bytes for audio,
2,496 bytes for main, 960 bytes for control networking, and 4,272 bytes for
PCM networking. This sample cannot prove resource state at the later outage,
but it does not show initial memory exhaustion.

## Classification

This run localises the observed failure below the Node event loop, the PCM
reader, Cap'n Web dispatch, and both application socket queues: during the
coupled stall, the M5StickS3 station address itself was unreachable. It does
not yet distinguish:

- an ESP-IDF Wi-Fi/lwIP/driver disconnect or radio stall;
- an AP-side station eviction;
- RF interference or another shared local-path failure.

The host currently destroys the replacement opportunity after only 6.5
seconds, while the measured reachability outage lasts about 17.2 seconds. The
next change therefore extends only the failed-run diagnostic observation
window. It must not increase audio buffering, retry stale PCM, or make this
failed run count as recovered.

The next physical discriminator is the same run with explicitly timestamped
parallel pings to both `192.168.0.21` and the local router. If the router stays
reachable while only the Stick disappears, the host/AP uplink is excluded.
Waiting through the measured outage should then let the replacement control
mount return the retained ESP-IDF Wi-Fi disconnect reason and transport tuple.
