# Physical observation: PCM priority 6 under 20 Hz control load

Date: 2026-07-31  
Device: M5StickS3, ROM MAC `70:04:1D:D5:45:88`  
Port resolved immediately before flash: `/dev/cu.usbmodem11201`  
Result: **failed**, after materially longer continuous playback

## Question

The preceding 20 Hz loaded run stopped receiving PCM after about 21 seconds
while both application-owned network tasks ran at FreeRTOS priority 5 on Core 0. This run asks one narrow question: does giving the PCM socket owner priority
6 preserve audio progress under the otherwise identical workload?

This is not a general proof that task priority fixes the architecture. A pass
would only establish one measured scheduler policy; a failure must retain the
separate control, PCM, acoustic, and queue evidence needed to find the next
bound.

## Exact workload

The image was built with ESP-IDF 5.4.2. Its app binary was 1,158,112 bytes and
passed the build-time ISR IRAM/DIRAM audit. It was flashed only after USB serial
enumeration resolved the expected ROM MAC to exactly one port. No serial
monitor was attached during playback.

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

The earlier sibling directory without `-r2-` is a preserved harness-launch
failure (`spawn python ENOENT`). It performed no playback and is not included
in this observation.

## What happened

- The host delivered 2,589 complete 640-byte PCM frames, or 51.78 seconds of
  source audio.
- The PCM bridge sent 1,656,960 bytes with a maximum 39.34 ms interarrival
  interval. It had zero buffered bytes and zero send callbacks in flight when
  deliberately stopped after the control failure.
- The loaded Cap'n Web loop completed 897 calls and started 898. One call
  failed; 106 scheduled cycles were correctly skipped while the single
  permitted call was busy.
- At about 51.74 seconds, two subscription callbacks overlapped request 900/901.
  The device's four-slot control inbox reached high water 4 and recorded one
  producer-backpressure incident.
- That complete incoming RPC message could not be retained. The adapter
  classified it as `CAPNWEB_E_TRANSPORT` (`-4`), replaced generation 1, and
  explicitly discarded one old-generation outbox message rather than replaying
  it.
- Generation 2 authenticated and remounted, so recovery itself was bounded and
  observable. The harness still failed—as it should—because a supposedly
  healthy loaded acceptance run changed capability generations.

The diagnostic's earlier `lastWifiDisconnectReason=205` means ESP-IDF
`WIFI_REASON_CONNECTION_FAIL`, but it is not by itself timestamped to this
incident. The directly causal evidence is the inbox pressure, receive status
`-4`, protocol-failure generation 1, and generation replacement. This note
therefore does not attribute the failure to Wi-Fi.

## Acoustic evidence

The preserved MacBook Pro microphone artifact was analysed from the causal
provider-request marker at 341.333 ms:

- observed tone: 685–52,180 ms;
- continuous observed span: 51,495 ms;
- internal gaps: 0;
- phase discontinuities: 0;
- maximum phase-step error: 0.0621 radians;
- amplitude coefficient of variation: 0.0412;
- p99 amplitude step: 0.1055 dB;
- maximum amplitude step: 0.4262 dB;
- missing tone due to the aborted run: 8,505 ms.

Thus the change materially improved the prior scheduler failure and the audible
portion itself was continuous. It did **not** pass the 60-second contract,
because the control burst ended the session early.

## Resource and integrity evidence

- `run.log`: 22,873 bytes, SHA-256
  `51a064d2a2608cfdd291ecbe1ec5588491a0482853bb63ca06f8fcd25dc83b67`
- `microphone.pcm16le`: 5,009,408 bytes / 2,504,704 samples, SHA-256
  `54c68eb4cd665a490d2cfb9f812499a1909314abe13ef6f364a0df1883f21217`
- pre-playback free/minimum internal heap: 128,247 / 123,247 bytes;
- audio/main/control/PCM task stack headroom:
  6,652 / 2,496 / 960 / 4,064 bytes;
- no stack exhaustion, audio incident, or playback-driver failure was observed
  before the control generation ended.

## Consequence

Keep the one-level PCM priority as a measured improvement, but do not call it a
root-cause fix. The next red/green change is separate: the target's control
inbox must contain the causally valid seven-message overlap made from two
subscription resolve/release pairs plus one single-flight RPC
push/pull/previous-release lifecycle. Eight slots is the smallest power-of-two
capacity that covers that burst. Any pressure beyond that reviewed bound must
still fail the generation explicitly; it must not become an unbounded control
backlog.
