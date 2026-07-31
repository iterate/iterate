# M5StickS3 loaded playback with timestamped device/router controls

## Question

The preceding ICMP sidecar proved that the Stick's station address disappeared
during the coupled control/PCM stall, but did not distinguish a general
Mac/router path outage from a failure isolated to the device station. This
matched run therefore timestamped two 10 Hz controls:

- `192.168.0.21`, the M5StickS3 station;
- `192.168.0.1`, the router reached over the same Mac interface.

The host's post-failure observer was also increased from 6.5 seconds to a
bounded 30 seconds. That change affects only collection of retained diagnostic
evidence after the realtime proof has already failed. It does not change the
one-second capability deadline, PCM freshness, queue capacity, retry policy,
or acceptance result.

## Exact setup

- device: M5StickS3
- MAC: `70:04:1d:d5:45:88`
- device IP: `192.168.0.21`
- Mac LAN address and listener: `192.168.0.169:58685`
- router control: `192.168.0.1`
- serial port used only for `esptool` configuration verification:
  `/dev/cu.usbmodem11201`
- firmware image:
  `apps/kit/firmware/targets/m5sticks3/build/iterate-kit-m5sticks3.bin`
- image size: 1,158,112 bytes
- image SHA-256:
  `cb07e78e26f8ac9a329ca960534970bb97c96437b0d81cf881ace35e0a1cac20`

No firmware was flashed and no serial monitor ran during playback. The audio
command was:

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

Each control used macOS `ping -i 0.1`; every output line was prefixed by
`Time::HiRes::time()` in the sidecar process. This supplies an actual wall
clock for received replies rather than deriving timestamps from file metadata.

## Durable artifacts

- [`run.log`](./run.log): 17,915 bytes,
  SHA-256 `112f66478f6dc8bfdaaadc17629e9d6623efdb96824af629899c5f5296c660e0`
- [`device-ping.log`](./device-ping.log): 41,828 bytes,
  SHA-256 `d297daadda2ef207c40a2085e9f1f70ff587de8be288b3faf583b89c665ec40b`
- [`router-ping.log`](./router-ping.log): 51,198 bytes,
  SHA-256 `b33aa6816e59e41184685d5fc92937aa54b361cc8977895f69e2125779ad3ffe`
- [`microphone.pcm16le`](./iterate-kit-acoustic-erUERT/microphone.pcm16le):
  2,248,704 bytes / 1,124,352 mono samples at 48 kHz,
  SHA-256 `9f2d8c406ec65faa5a11bede43e51993fc4aeec21cb408b47fd11db9dca65037`

The first attempted command in this artifact directory failed before touching
the device because the ESP-IDF Python environment was absent. The files above
were overwritten by the complete rerun after sourcing ESP-IDF; their hashes
identify the retained attempt unambiguously.

## Direct observations

The run failed. It is not a 60-second continuity pass.

The PCM bridge reset the device TCP connection with code 4013 at elapsed
18,075.508 ms after reaching the unchanged eight-callback /
5,120-payload-byte freshness gate. At that boundary:

- 850 frames / 544,000 payload bytes had been sent;
- the oldest send callback was 156.961 ms old;
- maximum callback latency before the stall was 0.890 ms;
- maximum host interarrival was 34.960 ms.

Control independently completed 234 `getDiagnostics` cycles. Request 238 was
sent but never resolved. The final previously sampled device counters were
sequence 237 at device uptime 30,383 ms:

- downlink accepted: 607;
- playback submitted/completed: 603 / 599;
- PCM receive calls/chunks: 2,947 / 612.

The one-second capability bound failed, the PCM follow-up timed out after six
seconds, and the enlarged 30-second control diagnostic grace still saw no
replacement mount.

The device ICMP replies contain two and only two gaps:

- after sequence 7 at wall time `1785468007.828476`, sequences 8–183 are
  absent, and sequence 184 returns at `1785468026.757881`;
  this is the expected reset/reboot interval;
- after sequence 316 at `1785468040.756513`, sequences 317–488 are absent,
  and sequence 489 returns at `1785468059.317538`;
  172 scheduled probes are missing, with 18.561 seconds between adjacent
  received replies.

The router control received every sequence from 0 through 647 with no gap
through the same interval. Its RTT was min/average/p99/max
2.085 / 4.746 / 17.051 / 101.997 ms. The device's received-probe RTT was
3.736 / 7.059 / 27.177 / 91.460 ms.

The ARP entry after the run still maps `192.168.0.21` to the Stick's exact MAC,
so the post-gap ICMP replies are not evidence from an unrelated host reusing
the address. After returning at sequence 489, the Stick answered another 160
consecutive ICMP replies through sequence 648—approximately 16.86 seconds—
without either application socket remounting before teardown.

The externally bounded acoustic analysis began at the pre-request marker
`16,384 / 48,000 = 341.333 ms` and found:

- observed tone: 685 through 13,305 ms;
- continuous-tone span: 12,620 ms;
- internal gaps: zero;
- phase discontinuities: zero;
- maximum phase-step error: 0.066073 rad;
- amplitude coefficient of variation: 0.026067;
- p99 / maximum amplitude step: 0.128906 / 0.589992 dB;
- missing requested tone: 47,380 ms;
- maximum analyzer audio buffer: 66,016 bytes.

Playback was therefore clean until abrupt terminal starvation; enlarging a
playback FIFO is neither supported by this evidence nor acceptable.

## Classification

The router control rules out a general Mac-to-router outage for this incident.
Only the M5StickS3 station became unreachable. The remaining causal boundary is
device/AP-station-specific: ESP Wi-Fi/driver state, AP eviction of this
station, or RF behavior local to it.

The later application non-recovery is a second, independently actionable
defect. Source inspection found that the control network task calls
`esp_websocket_client_stop()` as soon as the Wi-Fi event clears
`wifi_connected`. The selected managed component implements that public call
through `stop_wait_task()`, which waits for `STOPPED_BIT` with
`portMAX_DELAY`. Thus the project's documented bounded owner-task policy sits
on an actually unbounded SDK join. That source contract can explain a control
task that never remounts after the station returns, but it does not explain why
the station disappeared in the first place.

The next change must first gain a failing architectural/host regression. The
preferred simplification to test is making the control task own the same
bounded lower `esp_transport_ws` connection abstraction already proven for
PCM, while retaining separate sockets and separate Cap'n Web/PCM policies.
That would remove the hidden managed-client worker and its unbounded stop
rather than wrapping it in another watchdog task. It remains a candidate until
its exact RAM/CPU/code-size delta and physical reconnect behavior are proven.
