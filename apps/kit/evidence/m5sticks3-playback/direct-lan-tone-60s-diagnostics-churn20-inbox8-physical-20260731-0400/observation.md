# Physical observation: eight-slot control inbox under 20 Hz control load

Date: 2026-07-31  
Device: M5StickS3, ROM MAC `70:04:1D:D5:45:88`  
Port resolved immediately before the run: `/dev/cu.usbmodem11201`  
Result: **failed, with a different and more informative failure signature**

## Question

The preceding run proved that four control-inbox slots could not retain the
causally valid overlap of two subscription callback lifecycles and one
single-flight `getDiagnostics()` lifecycle. This run asks the corresponding
narrow question: does the reviewed minimum of eight slots prevent that
specific control-inbox-pressure failure while 20 Hz control traffic competes
with device-clocked PCM?

It does. The run did not pass the wider 60-second contract, however. Both PCM
delivery and Cap'n Web replies abruptly stopped making device-side progress
after about 28.3 seconds. The host did not detect its hidden PCM backlog until
about 4.8 seconds later. This is a separate coupled endpoint/path outage, not
evidence that the control inbox needs to grow again.

## Exact workload

The image used ESP-IDF 5.4.2, the PCM network task at priority 6, the control
network task at priority 5, and the eight-slot control inbox. Its app binary
was 1,158,112 bytes with SHA-256
`cb07e78e26f8ac9a329ca960534970bb97c96437b0d81cf881ace35e0a1cac20`.
The binary passed the build-time ISR IRAM/DIRAM audit. No serial monitor was
attached during playback.

```sh
ITERATE_KIT_PYTHON=/Users/jonastemplestein/.espressif/python_env/idf5.4_py3.14_env/bin/python \
ITERATE_KIT_ACOUSTIC_OUTPUT_DIRECTORY=<this-directory> \
pnpm device:e2e -- \
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

## What happened

- Control completed 490 calls and started call 491. The final call exceeded
  the explicit 1,000 ms deadline. Seventy scheduled cycles were skipped while
  that one permitted call was busy.
- The final complete control reply was `resolve(493)` at 28,937.8 ms. The
  following `push(getDiagnostics)` / `pull(494)` was sent at 28,959.0 /
  28,959.2 ms and never resolved.
- There was no control inbox-pressure diagnostic, protocol-generation
  replacement, or remount before the outage. This is the material distinction
  from the four-slot run.
- PCM sent 1,602 complete 640-byte frames / 1,025,280 bytes before the host's
  strict eight-frame freshness gate fired at 33,105.9 ms.
- At that point eight send callbacks covered 5,120 payload bytes. The oldest
  callback was 155.45 ms old; maximum user-space `bufferedAmount` was 5,152
  bytes. The bridge used `net.Socket.resetAndDestroy()`, recorded
  `deviceSocketCloseDisposition="tcpReset"`, and therefore made the old TCP
  generation—including opaque kernel backlog—undeliverable.
- The 6.5-second control diagnostic grace period timed out, as did the
  replacement capability mount. A six-second post-close PCM diagnostic probe
  also timed out.
- The last retained device playback sample had sequence 510, was produced at
  device uptime 45,489 ms, and reported 1,359 accepted / 1,355 submitted /
  1,351 completed frames. It cannot tell us which physical network layer
  stopped because no later diagnostic reply crossed the same failed path.
- The control bridge remained locally open until harness disposal at
  36,510.6 ms. It had exchanged 546,290 device-to-worker bytes across 681
  messages and 38,582 worker-to-device bytes across 1,543 messages. Its
  terminal code 3000 therefore describes cleanup, not successful recovery.

The host PCM gate measures only bytes whose `ws.send()` callbacks have not
completed. macOS can accept roughly 128 KiB into opaque TCP state before those
callbacks expose pressure. At 32,000 PCM payload bytes per second, that is
roughly four seconds of speech. The acoustic end at 28,277.5 ms followed by
the host gate at 33,105.9 ms is the same hidden-backlog shape. Increasing an
application ring cannot solve it and would worsen freshness.

## Acoustic evidence

The preserved MacBook Pro microphone artifact was re-analysed with the
checked-in streaming 997 Hz oracle from the causal provider-request marker at
341.333 ms:

- observed tone: 692.5–28,277.5 ms;
- continuous observed span: 27,585 ms;
- internal gaps: 0;
- phase discontinuities: 0;
- maximum phase-step error: 0.070598 radians;
- amplitude coefficient of variation: 0.032422;
- p99 amplitude step: 0.128906 dB;
- maximum amplitude step: 0.570301 dB;
- missing tone due to abrupt truncation: 32,415 ms;
- total captured duration: 35,712 ms.

So the audible interval remained clean until it ended abruptly. This is not
the earlier “jiggly” playback pathology, nor a gradual queue-overflow
signature.

## Resource and integrity evidence

- `run.log`: 18,372 bytes, SHA-256
  `4743ff5283235580674c768310f29e42e36b68eb5d5af78a245cd74f3c653b83`
- `microphone.pcm16le`: 3,428,352 bytes / 1,714,176 samples, SHA-256
  `3e2784b79dc40ff31696ff254bd62e5bd5ad137790eb12e04fa612e7e763820b`
- pre-playback free/minimum internal heap: 121,619 / 112,983 bytes;
- audio/main/control/PCM task stack headroom:
  6,652 / 2,496 / 960 / 4,288 bytes;
- the eight-slot change costs exactly 5,152 bytes of static control-inbox
  storage relative to four slots: four 1,280-byte messages plus four `size_t`
  length entries.

## Classification and next proof

The eight-slot inbox change passes the specific bounded-burst question: the
prior inbox-pressure signature is absent. The full physical acceptance case
still fails.

The directly observed class is an abrupt coupled loss of device progress on
both independent WebSockets. The evidence does **not** yet distinguish
device Wi-Fi/lwIP/driver loss, access-point/RF loss, or the Mac-side network
path. It also does not justify more buffering. The next useful proof must:

1. deterministically show that hard-aborting an old PCM generation prevents
   delayed stale playback and that a replacement generation immediately
   resumes current audio;
2. preserve the separate bounded device peer-probe/reconnect contract;
3. add a low-perturbation reachability/packet-boundary observation to the next
   physical reproduction so the coupled outage can be assigned to a layer.
