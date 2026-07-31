# M5StickS3 taskless-control playback A/B with timestamped controls

## Question

The preceding physical run found two distinct problems:

1. the M5StickS3 station alone became unreachable for approximately 18.6
   seconds while the router remained continuously reachable; and
2. neither application WebSocket remounted after the station returned.

Source inspection then found an unbounded `portMAX_DELAY` task join beneath
the managed control WebSocket client's stop operation. This A/B removes that
hidden client task entirely. The Cap'n Web owner now uses the same fixed-buffer,
taskless lower ESP-IDF WebSocket connection as the independent PCM owner.

The experiment asks whether that simplification cures application recovery. It
does **not** claim to address the original station outage.

## Exact setup

- device: M5StickS3
- MAC: `70:04:1d:d5:45:88`
- device IP: `192.168.0.21`
- Mac LAN listener: `192.168.0.169:58685`
- router control: `192.168.0.1`
- serial port used only to read the existing provisioning partition:
  `/dev/cu.usbmodem11201`
- firmware image:
  `apps/kit/firmware/targets/m5sticks3/build/iterate-kit-m5sticks3.bin`
- image size: 1,147,952 bytes
- image SHA-256:
  `4fa1cdf699d9de802716d3a1995a7264e6b279eab00816cd690ccd187fe0c093`

The newly built image had already been flashed and verified before this run.
No serial monitor ran during playback. The audio command was:

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

Two independent macOS `ping -i 0.1` processes targeted the Stick and router.
Every output line was prefixed by `Time::HiRes::time()`.

## Durable artifacts

- [`run.log`](./run.log): 17,939 bytes,
  SHA-256 `ffd6346353489829d24c5f52c019d61b2bdd10320aa7fc7de223b19f305ec21c`
- [`device-ping.log`](./device-ping.log): 40,891 bytes,
  SHA-256 `bad7c092d1de2c32f9f3df8b9a3db468879fe87270352d53c922e2ccb8b29223`
- [`router-ping.log`](./router-ping.log): 50,370 bytes,
  SHA-256 `27ef9b835abc1d13caa3d3f8fd5622e0b67143c64b352527524187ab992837ea`
- [`microphone.pcm16le`](./microphone.pcm16le): 1,986,560 bytes /
  993,280 mono samples at 48 kHz,
  SHA-256 `3dce3441904931c7d94c451f19e038131e62519d8d21418d1882c90b1d073c94`

## Direct observations

The run failed. It is not a 60-second continuity or recovery pass.

The PCM bridge failed closed with code 4013 at PCM-session elapsed
16,136.321 ms after reaching the unchanged eight-callback /
5,120-payload-byte freshness gate. At that boundary:

- 713 frames / 456,320 payload bytes had been sent toward the device;
- the oldest outstanding callback was 159.022 ms old;
- maximum completed callback latency before the stall was 2.184 ms;
- maximum host downlink interarrival was 34.883 ms.

Control independently completed 187 `getDiagnostics()` cycles. Request 188
was started but never resolved. The last device sample, produced before the
outage, reported:

- downlink accepted: 462;
- playback submitted/completed: 459 / 455;
- PCM receive calls/chunks: 2,650 / 467;
- free/minimum internal heap: 124,491 / 118,443 bytes;
- control/PCM network task stack headroom: 856 / 4,296 bytes.

The one-second control deadline failed, the six-second PCM follow-up timed
out, and a bounded 30-second grace period saw no replacement capability mount.

The Stick ICMP evidence contains exactly two gaps:

- after sequence 14 at wall time `1785469836.469831`, sequences 15–189
  are absent, and sequence 190 returns at `1785469855.407979`;
  175 scheduled probes are missing and adjacent received replies are
  18.938 seconds apart. This overlaps the expected reset/reboot interval.
- after sequence 304 at `1785469867.441791`, sequences 305–476 are absent,
  and sequence 477 returns at `1785469885.918786`;
  172 scheduled probes are missing and adjacent replies are 18.477 seconds
  apart. This is the in-run station outage.

The router received every sequence from 0 through 636 through both intervals.
After the in-run gap, the Stick answered another 160 consecutive probes through
sequence 636—approximately 17 seconds—without either WebSocket remounting.
The ARP entry still mapped `192.168.0.21` to the exact device MAC.

The externally bounded acoustic analysis began at the pre-request marker
`16,384 / 48,000 = 341.333 ms` and found:

- observed tone: 692.5 through 10,522.5 ms;
- continuous-tone span: 9,830 ms;
- internal gaps: zero;
- phase discontinuities: two at the strict 0.1-radian threshold;
- maximum phase-step error: 0.112724 rad;
- amplitude coefficient of variation: 0.027395;
- p99 / maximum amplitude step: 0.152344 / 0.642247 dB;
- missing requested tone: 50,170 ms;
- maximum analyzer audio buffer: 66,016 bytes.

The tone was continuous in amplitude while present, but the two small
phase-threshold violations mean this artifact is not called perfectly
jitter-free. Its decisive defect is abrupt early truncation.

## Memory and size A/B

Removing `esp_websocket_client` reduced the application binary by 10,160
bytes, from 1,158,112 to 1,147,952 bytes. Explicit fixed receive/transmit
workspaces increased static DIRAM/BSS by 4,968 bytes, but removal of the
managed client's runtime task and allocations improved the first comparable
device sample:

- free internal heap: 117,535 to 126,459 bytes, +8,924;
- minimum free internal heap: 114,219 to 118,443 bytes, +4,224;
- largest internal block: 31,744 to 34,816 bytes, +3,072.

The ESP-IDF build and realtime placement audit passed. IRAM remains
16,383 / 16,384 bytes used, so there is still only one byte of IRAM margin.

## Classification

This A/B falsifies the hypothesis that the managed client's unbounded stop
join was sufficient to explain non-recovery. It was a real boundedness defect,
and removing it yields a simpler ownership model, a smaller image, and more
runtime heap, but the same station-specific outage occurred and the new direct
control connection also failed to remount.

The shared fault boundary is now below Cap'n Web and the managed-client
abstraction. The leading candidates are:

- the common lower WebSocket/parent-transport read or close contract;
- the shared Wi-Fi event/reconnect lifecycle;
- a device task becoming blocked during the station outage despite the Wi-Fi
  interface later serving ICMP.

No buffer should be enlarged in response. The next implementation change must
first have a deterministic red test that reproduces a bounded owner failing to
observe or recover from a lower-transport outage.
