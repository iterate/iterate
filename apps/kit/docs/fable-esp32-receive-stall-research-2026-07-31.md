# Fable research: the physical M5StickS3 "160 ms receive stall" is a ≥4.2-second link outage measured through a 131 KiB blind spot

Status: independent review and measurement report, 2026-07-31. Written by the
Fable Max follow-up run against worktree `c-capabilities`. No implementation
code was modified; the only artifacts added are this document and throwaway
analysis scripts in the job scratch directory. Prompt retained verbatim in
[`fable-esp32-receive-stall-research-prompt-2026-07-31.md`](./fable-esp32-receive-stall-research-prompt-2026-07-31.md).

Sources: the firmware and host source in this worktree (exact `path:line`
citations throughout), ESP-IDF v5.4.2 at `~/esp/esp-idf` (`f5c3654a`, the
checkout the m5sticks3 target builds against; cited as `esp-idf:path:line`),
the retained evidence directories under `apps/kit/evidence/m5sticks3-playback/`
(re-analyzed, not just re-read), new measurements performed on the actual host
Mac during this review, and external prior art (URLs in §12).

---

## 0. Executive summary

**The question this review was asked — "what makes the device reader stop
advancing the TCP receive window for roughly 160 ms" — contains a false
premise.** Three independent lines of evidence, two of them newly measured
during this review, show that each `4013` failure is an **abrupt, total,
bidirectional cessation of all TCP progress between the Mac and the Stick
lasting at least ~4.2 seconds**, not a 160 ms receive-window stall. The
"156.661 ms / 159.296 ms / eight callbacks / 5,152 bytes" signature is the
**last 160 ms of a ~4.3-second outage**, the only part visible to the bridge,
because macOS's default 131,072-byte kernel TCP send buffer silently absorbs
~4.05 seconds of paced audio (send callbacks keep completing normally) before
Node userland ever sees backpressure.

The three lines of evidence (details in §2):

1. **Device-side per-second series (schema 5, run `…-0134`).** The device
   accepted exactly +50 frames/s and made ~248 receive calls/s (one poll every
   ~4 ms), every single second, with zero underruns and a flat 80 ms
   interarrival maximum — up to and including the last delivered sample. Then
   _both_ sockets went silent inside the same one-second window: PCM downlink
   consumption froze **and** the 1 Hz metrics stream on the separate `/api`
   TCP connection stopped arriving. The reader did not degrade and then die;
   the _link_ died between one heartbeat and the next.

2. **Acoustic envelope of all four 4013 failures.** Re-analysis of the
   retained microphone captures (this review, RMS envelope at 5 ms hop) shows
   **zero internal gaps** — playback was flawless until starvation — and a
   terminal silence before capture end of **4.150 s / 4.170 s / 4.145 s /
   4.195 s** across the four runs (`…-0128`, `…-attempt1-0110`, `…-0115`,
   `…-0134`). Four failures, spread over 38 minutes, all silent for the same
   ~4.17 ± 0.03 s before the gate fired.

3. **Byte arithmetic + a live host experiment.** At 644 wire-bytes per frame,
   50 frames/s, the invisible pipeline between the Node ledger and the device
   application is `131,072 B (macOS sendspace, measured on this Mac) +
5,760 B (device TCP window, `targets/m5sticks3/sdkconfig:1619`) ≈ 4.25 s`.
   Terminal silence predicted ≈ 4.06 s + recorder-stop lag ≈ what was
   measured. A loopback probe on this exact Mac/Node/ws (§2.4) confirmed the
   mechanism: after a reader stops, the kernel absorbed **803,712 more bytes
   over 27.3 s** of paced sends — with every send callback completing in
   ≤0.2 ms — before the first callback stuck, at which point `bufferedAmount`
   read exactly **5,152**.

Consequences:

- **The firmware is exonerated for these four failures.** The reader was
  demonstrably alive and polling at ~4 ms cadence to the end; Wi-Fi power
  save is already disabled (`platforms/iterate_esp_idf/itx_transport.c:937`);
  there is no logging, flash write, or I2C on the PCM path (§6). The lwIP
  recvmbox/refused-data cliff the prompt suspected is real and documented
  below with exact arithmetic (§3.3) — but it is a _latent_ hazard that
  requires the reader to be absent ≥~120 ms, which the receive-call counters
  prove did not happen, and it cannot explain the control socket dying in the
  same second.
- **The host bridge is exonerated for the stall itself** (its event loop
  provably kept running: interarrival tracking updated throughout), **but its
  freshness gate measures the wrong boundary.** `ws.send()` callbacks fire on
  _kernel accept_, not device receipt (ws docs + `ws/lib/sender.js`; §2.4), so
  the "160 ms media budget" actually detects failure ~4.3 s late, after
  ~136 KB ≈ 4.2 s of committed stale speech sits in the kernel — and the
  current graceful `close()` leaves that backlog deliverable if the link
  recovers (§3.5). In practice the device's own 2 s + 1 s idle peer probe
  (`esp_idf_websocket_policy.h:46-47`) abandons the connection first and its
  reconnect/RST discards the backlog, which is why no stale replay has been
  _heard_ — the host is currently relying on the device for a guarantee the
  host believes it provides itself.
- **The root cause of the outages themselves is environmental (radio/link
  level) with high probability but is not yet provable from retained
  evidence**, because nothing records Wi-Fi events, nobody keeps the control
  session alive after the failure, and no packet capture exists. §4 shows the
  outage can be _named_ on the very next failing run with zero new firmware
  (runner grace window + sequence-gap arithmetic + tcpdump), and named
  precisely with ~32 bytes of new counters (schema 6).

Ranked root-cause hypotheses for the ≥4.2 s outages (full table §9):
device-side Wi-Fi link event (beacon loss → probe → disassociation cycle, or
AP-side kick) ≈ 55%; Mac-side Wi-Fi interruption (AWDL/scan) ≈ 20%; AP-internal
stall/rekey ≈ 15%; device Wi-Fi-driver/lwIP internal wedge ≈ 10%. All four are
separable by the §7 ladder without touching the audio path.

---

## 1. What this review did

Beyond reading the required sources, this review produced new measurements:

| Measurement                                                   | Method                                                                                | Where                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Terminal-silence + gap analysis of 6 retained captures        | RMS envelope, 10 ms window / 5 ms hop, threshold 0.2×p95, over the raw 48 kHz PCM16LE | job scratch `tone-envelope.mjs`; results §2.2 |
| Per-second device series of the schema-5 failure              | JSON extraction of all 43 `playback_runtime_metrics_sample=` lines                    | `…-0134/run.log`; results §2.1                |
| Host TCP sysctls on the actual test Mac                       | `sysctl`                                                                              | §2.3                                          |
| ws send-callback semantics on the actual Mac/Node/ws versions | loopback server pacing 640 B/20 ms into a client that stops reading                   | §2.4                                          |
| Interarrival-max timeline of the passing verbose run          | same JSON extraction                                                                  | `…-0122/run.log`; §2.5                        |

And it discovered one piece of evidence newer than the engineering brief: a
**fifth** one-hour-later run, `direct-lan-tone-120s-device-clocked-startup7-
schema5-verbose-20260731-0134`, which failed with the identical 4013 signature
at 47.446 s **with the full 1 Hz verbose series enabled and schema 5's
`pcmReceiveCalls`/`pcmReceiveChunks` live** — the exact "next bounded progress
discriminators" the brief said were still pending. That run is the keystone of
this report.

---

## 2. Reconstruction: what actually happens in a 4013 failure

### 2.1 The keystone run (`…-0134`, schema 5, verbose)

Host view at close (`…-0134/run.log:125`): close 4013 at `elapsedMs`
47,446 ms (elapsed is PCM-socket-open-relative, not tone-relative —
`local-fetch-websocket-server.ts:237,272`), 2,316 frames / 1,482,240 bytes
sent, max interarrival 34.708 ms, max completed callback latency 1.696 ms,
eight callbacks / 5,120 payload bytes outstanding, oldest 158.221 ms,
`bufferedAmount` 5,152.

Device view, last 7 of 43 one-second samples (extracted from the same log):

| seq | producedAtMs | acceptedΔ | receiveCallsΔ | receiveChunksΔ | run-max interarrival | underruns | CPU‰ |
| --- | ------------ | --------- | ------------- | -------------- | -------------------- | --------- | ---- |
| 38  | 53,299       | +50       | 248           | 50             | 80 ms                | 0         | 285  |
| 39  | 54,309       | +50       | 250           | 51             | 80 ms                | 0         | 288  |
| 40  | 55,309       | +50       | 248           | 50             | 80 ms                | 0         | 289  |
| 41  | 56,309       | +50       | 244           | 51             | 80 ms                | 0         | 293  |
| 42  | 57,309       | +50       | 248           | 50             | 80 ms                | 0         | 284  |
| 43  | 58,309       | +50       | 250           | 51             | 80 ms                | 0         | 295  |
| 44  | 59,309       | +50       | 248           | 50             | 80 ms                | 0         | 285  |

Sample 45 (due ≈60,309) never arrived. Nothing arrived again on either socket
before the host tore everything down at close+191 ms. Observations that carry
the whole diagnosis:

- The PCM network task made ~248 receive calls _every second_ — a poll every
  ~4 ms — including the final second. `pcmReceiveCalls` "advances immediately
  before a nonblocking lower-transport read"
  (`components/capabilities/include/iterate/kit/capabilities/metrics.h:106-114`).
  The reader never slowed, never starved, never widened its poll gap.
- `downlinkAccepted` never shows a frozen value in any delivered sample. If
  the PCM downlink had stalled while the control uplink lived, samples 45-49
  would have arrived showing a frozen count. They did not arrive at all:
  **device→host delivery died in the same ≤1 s window as host→device
  consumption.** Two independent TCP connections, two directions, one death.
- Zero underruns through 59.3 s: the audio owner was still being fed on time
  at the last heartbeat. The 80 ms interarrival maximum was set once at ~8 s
  into the tone (seq 11) and never exceeded — no degradation precedes death.

Frame ledger closure: at 20 ms/frame the host had sent ≈2,108 frames by the
inferred outage onset T0 (§2.2 puts T0 ≈ elapsed 43.2 s ≈ device uptime
60.3 s); linear extrapolation of the device series gives accepted ≈2,103 at
T0. Difference ≈5 frames ≈ the steady-state startup reserve riding in the
downlink ring (downlink high-water 5-6 in the passing runs,
`docs/audio-streaming-problem-and-evidence-2026-07-30.md:713-716,766-767`).
Sent-by-close (2,316) − accepted-at-T0 (≈2,103) ≈ **213 frames ≈ 4.26 s of
audio committed but never consumed** — the kernel + in-flight backlog.

### 2.2 The acoustic invariant across all four failures

New envelope analysis of every retained 4013 capture (and two passing
controls). "Terminal silence" = capture end − last 5 ms window with tone
energy:

| Run                                                    | Close (elapsed) | Frames sent | Internal gaps ≥15 ms | Terminal silence           |
| ------------------------------------------------------ | --------------- | ----------- | -------------------- | -------------------------- |
| `…-strict-20260731-0128`                               | ~9.3 s          | 416         | 0                    | **4.150 s**                |
| `…-startup7-attempt1-20260731-0110`                    | 24.864 s        | 1,189       | 0                    | **4.170 s**                |
| `…-startup7-verbose-20260731-0115` (120 s ask)         | 26.664 s        | 1,283       | 0                    | **4.145 s**                |
| `…-startup7-schema5-verbose-20260731-0134` (120 s ask) | 47.446 s        | 2,316       | 0                    | **4.195 s**                |
| control: `…-attempt2-0111` (clean 60 s pass)           | —               | 3,001       | 0                    | 0.485 s (EOS→teardown lag) |
| control: `…-verbose-0122` (clean 60 s pass)            | —               | 3,001       | 0                    | 0.535 s                    |

Playback is _perfect_ until it stops (zero gaps — the device was healthy), and
the stop-to-close interval is the same ~4.17 s in every failure regardless of
when in the run it happened (4 s in, 20 s in, 43 s in). A constant is a
pipeline, not a coincidence: it is the drain time of a fixed-size buffer at a
fixed rate. Decomposition: tone dies at T0 + ~0.19 s (ring reserve ~5-6 frames

- 4 DMA descriptors); the gate fires at T0 + (131,072 + ~5,760 − in-flight)
  / 32,200 B/s + 0.16 s (eight frames filling the Node ledger) ≈ T0 + 4.25 s;
  SoX stop lag ~0.1-0.15 s. Predicted terminal silence ≈ 4.16-4.21 s. Measured:
  4.145-4.195 s. This arithmetic uses only measured constants.

Note what this also means: the failure onsets were ≈4.9 s, ≈20.4 s, ≈22.2 s,
≈43.0 s after socket open. The apparent "both failures near 25 s" clustering
in the brief dissolves with four data points; §7 of the host-code review also
confirms **no code boundary exists near 25 s** (ladder stages are 60/120/600 s
and the failing runs were not ladder runs; `playback-endurance-ladder.ts:35`,
`device-e2e.ts:469-471`).

### 2.3 The host-side blind spot, quantified

Measured on the test Mac (Darwin 24.6.0):

```
net.inet.tcp.sendspace: 131072      net.inet.tcp.autosndbufmax: 4194304
net.inet.tcp.recvspace: 131072      net.inet.tcp.autosndbufinc: 8192
net.inet.tcp.rexmt_slop: 200        net.inet.tcp.enable_tlp: 1
```

XNU constants (apple-oss-distributions/xnu, `bsd/netinet/tcp_timer.h:190,274-284`):
retransmit floor `TCPTV_REXMTMIN` = 30 ms, plus `TCPTV_REXMTSLOP` = 200 ms
added to every computed RTO — so the Mac's first retransmit of the head
segment fires ≈230 ms into the outage, then backs off exponentially
(~0.23, 0.46, 0.92, 1.84, 3.7 s…). Tail-loss probe is enabled but needs SACK
from the peer to be useful, and the device build has `LWIP_TCP_SACK_OUT`
off (esp-idf default; `esp-idf:components/lwip/port/include/lwipopts.h:608-611`).
During a total outage none of this matters — nothing is deliverable — but it
frames what the pcap in §7 will look like.

The ledger/gate itself (verified in source this review):

- Close rule is **bytes only**, checked against the _next_ payload before
  sending: `payloadBytes > 5,120 − payloadBytesInFlight → close 4013`
  (`src/device/local-fetch-websocket-server.ts:325-341`, budget constant
  `:7`). The "oldest callback age" is computed only _at_ close (`:264-267`).
  **160 ms is emergent** (8 × 20 ms), not a configured deadline.
- A payload leaves the ledger in the `ws.send` callback (`:359-381`), which is
  the `net.Socket#write` completion callback (`ws/lib/sender.js` `sendFrame`:
  header+payload written under one cork, callback on the payload chunk). Node
  docs: the write callback runs "when the data is finally written out" — i.e.
  **flushed to the kernel buffer**, and `bufferedAmount` "deviates from the
  HTML standard … all framing bytes are included" and counts only userland
  bytes (`_socket._writableState.length + _sender._bufferedBytes`,
  `ws/lib/websocket.js:120-124`). 5,152 = 8 × (640 + 4-byte unmasked
  server-frame header). The kernel's 131,072 bytes are invisible to all of it.

So the gate's _real_ detection latency for a total stall is
`sendspace / (644 × 50) ≈ 4.07 s`, plus 0.16 s to fill the ledger. The
constraint document's requirement — "Socket acceptance is not peer receipt"
(`docs/audio-streaming-problem-and-evidence-2026-07-30.md:97-99`) — is stated
but not yet enforced by this boundary: the callback _is_ socket acceptance.

One correct claim must be preserved: the callback **does** bound payload
_ownership_ (after it fires, Node no longer references the buffer — the kernel
copied it). The ledger is the right tool for buffer reuse. It is the wrong
tool for freshness.

### 2.4 Live proof of the mechanism on this exact stack

Loopback experiment run during this review (Node v24.4.0, ws 8.19.0 from
`apps/kit/node_modules`, macOS defaults; script in job scratch):
a ws server paces 640-byte binary sends every 20 ms with per-send callbacks; a
ws client stops reading (socket pause) after 25 frames.

Result: healthy callback latency 0.10-0.17 ms with `bufferedAmount` 0; after
the reader stopped, the server flushed **1,248 more frames (803,712 wire
bytes) over 27.26 s** — every callback completing promptly — before the
first callback stuck; at the moment an 8-outstanding/oldest≥150 ms
"ledger-gate" condition was reached, `bufferedAmount` read **exactly 5,152**.
(Loopback absorbs more than the LAN case because the paused client's own
131,072-byte receive buffer and autosndbuf growth add to the server's
sendspace; on the real link the device's 5,760-byte window replaces that term,
giving the ~4.25 s observed.) The probe demonstrates all three load-bearing
semantics at once: callback = kernel-accept; `bufferedAmount` = userland only;
"8 × 644 stuck" = the moment the kernel finally refuses — the _end_ of the
kernel's absorption, not the start of the peer's stall.

### 2.5 Why the outage-duration distribution looks bimodal

Observed failure modes across the direct-LAN campaign: sub-100 ms ingress
pauses (passing runs recorded 41→59→60→80→90 ms running maxima, absorbed by
the 7-frame reserve — `…-0122/run.log`), a small number of one-underrun
strict-gate stops (~100-300 ms pauses: runs `…-0052`, `…-2341`,
schema-4 ingress run), and the four ≥4.2 s 4013 outages. Nothing between
~0.3 s and ~4.2 s has ever been observed — partly instrumental censoring
(the byte gate _cannot_ see a 0.5-4 s outage: the kernel absorbs it, the
device recovers with a burst, the counter gate then reports it as a cluster of
underruns — and any ≥0.3 s outage already fails the strict counter gate as
underruns, so 4013 only ever fires for outages long enough to fill the
kernel), and plausibly partly real: multi-second bidirectional deaths are the
signature of link-loss/reassociation cycles rather than ordinary
retransmission jitter. Session base rate that night: ≈4 outages in ≈250 s of
streaming across six attempts (order of magnitude one per minute of airtime),
which makes a single clean 60 s run (two occurred) entirely consistent with
the same environment — the clean minute is survivorship, not contradiction.

---

## 3. Q1 — Mechanism taxonomy: what can stop the peer's window from advancing

Grouped by layer; **status** = relationship to the four observed 4013
failures. "Latent" = real, source-proven, but excluded for these runs by the
evidence in §2.

### 3.1 Radio / link level — _the observed class_

| #   | Mechanism                                                                                                                                                                                                                                                                                                                                                            | Status                      | Evidence / source                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Device-side disassociation cycle: missed beacons → `bcn_timeout` → active AP probes → `WIFI_EVENT_STA_DISCONNECTED` → scan/auth/assoc reconnect. Typical 1-10 s, kills both directions instantly.                                                                                                                                                                    | **Best fit**                | Blob strings `bcn_timeout,ap_probe_send_start` present in `libnet80211.a`; PS is off so this is not sleep-related; nothing in retained evidence can see these events (no serial reader attached; no counters — §4 fixes)                                                              |
| M2  | AP-side removal or stall: deauth (steering, load, inactivity misjudgment), group-key rekey stall, channel switch (CSA), AP queue wedge. GTK rekey alone is reported at ~1 s latency; a kick is multi-second.                                                                                                                                                         | Plausible                   | esp-idf issue #15345 comment: "if WPA3-SAE has GTK rekeying like WPA2, we routinely see latency of ~1 s during this process"; home-AP behavior otherwise unobservable without AP logs/pcap                                                                                            |
| M3  | Mac-side radio leaves the channel: AWDL availability windows (AirDrop/AirPlay/Continuity), location/diagnostic scans. Documented cause of recurring latency spikes on Macs; typical spikes are ~100 ms-2 s, 4+ s is atypical but a scan storm is possible. Kills both directions _from the Mac's viewpoint_ — indistinguishable from M1/M2 in the current artifacts. | Plausible                   | apple.stackexchange #451646 ("significant jitter … on Wi-Fi", awdl0 workaround broken on Ventura+ → `awdlkiller`); Apple's own `net.inet.tcp.awdl_rtobase=100`; OWL paper (arXiv:1808.03156): nodes "tune their Wi-Fi radio to a different channel" outside availability windows      |
| M4  | Interference burst (2.4 GHz-only ESP32-S3; microwave, neighbor, BT). Produces exactly "stall then burst" at the Wi-Fi layer per Espressif's own engineer.                                                                                                                                                                                                            | Plausible as trigger for M1 | esp-idf issue #15345 (Espressif): "the packet … was not transmitted promptly at the hardware layer due to some reason (most likely interference) … packets from the upper-layer app are queued in the Wi-Fi software layer's wait queue … then transmitted in frame aggregation form" |

Why the link class fits: abrupt onset with zero degradation in the 1 Hz series
(§2.1), simultaneous death of two independent TCP connections in opposite
directions, ≥4.2 s duration (censored — the host closed first; true duration
unknown), perfect recovery by the next run minutes later, and a clean run
interleaved between failures on the same hardware and build.

### 3.2 Device Wi-Fi driver level

| #   | Mechanism                                                                                                                                                            | Status                                           | Evidence                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M5  | Dynamic RX buffer exhaustion: zero-copy `wlanif` pbufs pin Wi-Fi RX buffers until lwIP/app consume them; recvmbox+refused occupancy pins at most 7 (< 32 configured) | Excluded as initiator (needs an app stall first) | `esp-idf:components/esp_netif/lwip/netif/wlanif.c:146-183`; `CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM=32`                                                                                                                                                  |
| M6  | AMPDU RX block-ack window (6) holds segments back for reordering after a loss; missed block-acks need a BAR round trip                                               | Latent, ~10-25 ms scale, not 4 s                 | issue #15345 measurements; `RX_BA_WIN=6`; Espressif suggested AMPDU-off, reporter measured it _didn't help_ — do not cargo-cult this switch                                                                                                             |
| M7  | Wi-Fi power save (DTIM buffering delays RX up to the DTIM cycle)                                                                                                     | **Excluded** — PS explicitly off                 | `itx_transport.c:936-947` (`esp_wifi_set_ps(WIFI_PS_NONE)`); ESP-IDF docs: "the delay in receiving Wi-Fi data may be the same as the DTIM cycle" (`esp-idf:docs/en/api-guides/wifi.rst:1799`) — cite kept because every future reviewer will suspect it |

### 3.3 lwIP level — the latent cliff the prompt suspected

The arithmetic, from source, for the record:

- One recvmbox slot holds one `recv_tcp` callback's pbuf chain ≈ one TCP
  segment for this paced stream (`esp-idf:components/lwip/lwip/src/api/api_msg.c:336-346`).
  Six slots × 644-byte segments = **3,864 bytes buffered, well under the
  5,760-byte window** — the mailbox, not the window, is the binding
  constraint for small segments. The Kconfig sizing formula
  (`recommended = WND/MSS + 2`) assumes MSS-sized segments
  (`esp-idf:components/lwip/Kconfig:691-700`); at 644 B/segment the window
  holds ~9 segments versus 6 slots. Willow (production S3 voice device) sized
  it 18 with a 23,040 window for exactly this class of workload
  (`HeyWillow/willow sdkconfig.defaults`).
- When the mailbox is full, the 7th segment becomes `refused_data` (already
  ACKed, window already shrunk), and **every subsequent data segment is
  dropped with no ACK of any kind** — `tcp_input` frees it before ACK
  processing (`esp-idf:components/lwip/lwip/src/core/tcp_in.c:432-447`; the
  only exception is a zero-window-probe empty ACK). Refused data is re-offered
  on each new segment arrival and by `tcp_fasttmr` every **250 ms**
  (`esp-idf:components/lwip/lwip/src/core/tcp.c:1487-1530`).
- The sender then recovers only by its own RTO: on this Mac ≈230 ms first try
  (§2.3). So a genuine app-reader absence of ≥~120 ms (6 undrained slots at
  20 ms spacing) escalates into a 200-500 ms TCP-level stall. **This is a real
  mechanism whose output would look like the prompt's "~160 ms" class.**
- Additional small-segment subtleties: reading one 644-byte frame never
  triggers an immediate window-update ACK (threshold = min(WND/4, 4×MSS) =
  1,440 bytes; `esp-idf:components/lwip/lwip/src/core/tcp.c:1000-1009`,
  `opt.h:1516`), and with `LWIP_TCPIP_CORE_LOCKING` **off by default in
  IDF 5.4** (`esp-idf:components/lwip/Kconfig:37-46`) every app `recv()`
  round-trips through the tcpip thread's mailbox and blocks on an op
  semaphore (`esp-idf:…/api/tcpip.c:442-465`) — a "nonblocking" read is only
  as nonblocking as the tcpip thread is responsive.

**Why it is excluded for the four failures:** `pcmReceiveCalls` advanced ~248/s
through the final delivered second (the reader drains the mailbox every ~4 ms;
steady-state mailbox depth ≈ 0-1), the drops would be downlink-only (the
control socket's device→host direction shares nothing with this path), and
recovery would be sub-second, not ≥4.2 s. A tcpip-thread _wedge_ would explain
bidirectionality (both sockets' recv/send API messages queue behind it) but
has no identified 4-second blocking mechanism in this firmware (no LOCKS
shared with app code; no blocking callbacks registered), would likely trip the
5 s task watchdog's idle starvation detection only in spin cases, and gets
cleanly discriminated by the §4 counters — kept at low probability rather than
zero.

### 3.4 Application (firmware) level

All latent; all excluded for these runs by the receive-call cadence and the
control socket's simultaneous death:

- **Poll cadence**: the loop's idle wait is `ulTaskNotifyTake(pdTRUE, 1 tick)`
  = 0-10 ms at `CONFIG_FREERTOS_HZ=100` (`pcm_transport.c:587-613`) and there
  is **no socket-driven wakeup** (acknowledged in-source TODO,
  `pcm_transport.c:599-605`). Anything that descheduled the task for N ticks
  would stall the window by N×10 ms — and is currently _unmeasurable_ because
  `network_task_max_work_cycles` starts counting only after the wait returns
  (`pcm_transport.c:612-615`). §4 adds the missing inter-pass-gap metric.
- **Burst-abort on control frames**: `receive_downlink` ends its 8-chunk burst
  early on any PING/PONG (`pcm_transport.c:429-436`); worst case one extra
  tick of latency, bounded, not a stall.
- **Blocking connect in-task**: reconnects block the PCM task up to 10 s
  (`pcm_transport.c:53-58,640-642`) — irrelevant to a connected steady state
  but worth knowing when reading `pcm_network_maximum_work_cycles` ≈ 3.7-4.2 M
  cycles ≈ 23-26 ms at the configured **160 MHz** (`sdkconfig:1136-1139`):
  that maximum is the connect pass, saturated once, hence "stayed unchanged
  throughout" in the brief. It was never going to move during a stall.
- **Core-0 contention set**: Wi-Fi task (prio 23, pinned 0), esp_timer (22,
  pinned 0), sys_evt (20), tcpip (18, floating), `iterate-ws` (5, unpinned),
  `iterate-net` (5, core 0), `iterate-pcm-net` (5, core 0). Same-priority
  round-robin advances on 10 ms tick boundaries. Nothing here runs for
  seconds; nothing above priority 5 in this firmware does unbounded work
  (§6 audit: no runtime NVS/flash writes anywhere in the app path, no I2C off
  the audio owner, no esp_timer callbacks registered by app code, zero
  `ESP_LOG` in the PCM task).
- **USB-Serial-JTAG console with no reader attached**: a task that logs while
  the host isn't draining busy-spins **up to 50 ms per stalled write, with no
  yield** (`esp-idf:components/esp_driver_usb_serial_jtag/src/usb_serial_jtag_vfs.c:72-171`;
  official docs confirm the "one-time wait of 50 ms"). The PCM task never
  logs; but the _Wi-Fi/tcpip_ tasks log exactly when a link event happens —
  at priority 23/18 on core 0 — so an RF incident can additionally inject
  50 ms-class core-0 stalls right when catch-up work is needed. Secondary
  amplifier, not initiator.

### 3.5 Host level

- **Kernel send-buffer invisibility** — the observed measurement artifact
  (§2.3-2.4). Not a stall mechanism on its own; it is why a 4.3 s outage
  reports as 160 ms.
- **Node event-loop stall** — excluded: `workerToDeviceMaximumInterarrivalMs`
  kept updating through both documented stalls (42.279 / 34.552 ms maxima),
  i.e. the provider timer, proxy, and bridge handler ran every ~20-42 ms while
  the callbacks sat. The send path is one synchronous macrotask chain with no
  awaits (host review §10; `device-pcm-proxy.ts` device-clocked drain is a
  plain `while` loop, `:719-734`).
- **Graceful-close stale-backlog delivery** — latent correctness gap: at 4013
  the bridge calls `ws.close(4013)` (`local-fetch-websocket-server.ts:251-256,
491-498`), which queues a close frame _behind_ 5,152 stuck bytes and leaves
  ~131 KB of stale audio in the kernel, which macOS will dutifully retransmit
  and deliver if the link recovers within its retry horizon. Today the device
  independently abandons the connection at ≤ T0+3 s (idle probe 2 s + 1 s
  pong deadline, `esp_idf_websocket_policy.h:46-47`) and a post-recovery RST
  from the device's closed socket discards the backlog — the accidental
  reason no stale burst has been heard. For outages shorter than the probe
  deadline the firmware's catch-up policy (underrun silence + one-for-one
  late-frame drops) already realigns to real time (`docs/…problem-and-
evidence…:266-271`). The fix (§4, `resetAndDestroy`) makes the host stop
  depending on the peer for its own guarantee.

---

## 4. Q2 — the smallest metric that names each mechanism on the next run

Ordered by cost. The first tier requires **zero firmware changes and no
serial connection** and would have fully classified the `…-0134` failure.

### Tier 0 — runner-only (an evening's work, no device impact)

1. **Post-failure grace window.** Today the runner disposes the control
   session ~191 ms after the 4013 (`…-0115/run.log:44`), destroying the one
   channel that will carry the post-mortem. Keep `/api` (and the process)
   alive ≥60 s after any PCM failure and log every late sample. The metrics
   sampler keeps producing while disconnected ("a busy callback simply misses
   intervals and receives the newest future sample",
   `components/capabilities/include/…/metrics.h:260-272`), and counters are
   cumulative, so the first delivered post-recovery sample contains the whole
   story:
   - `sequence` gap × 1 s = **outage duration on the device clock**;
   - `pcmReceiveCalls` delta across the gap ≈ 248/s × gap ⇒ reader alive and
     polling through the outage (link problem) vs ≈0 ⇒ reader/tcpip wedged
     (device problem) — the exact discriminator the brief asked for, already
     shipped in schema 5;
   - `pcmReceiveChunks`/`downlinkAccepted` deltas ⇒ how much of the kernel
     backlog arrived after recovery;
   - guard counters (`idle_peer_probe_timeouts`, restart reasons) ⇒ whether
     the device declared peer death at T0+3 s as designed.
2. **Print the rolling history at close.** The runner already holds the last
   64 observations in memory and never prints them
   (`scripts/device-e2e.ts:1157-1158`); a bridge-4013 close currently persists
   no device snapshot at all (host review §8). Dump `{baseline, last,
history}` on _any_ close, not only counter-policy failures.
3. **tcpdump ring buffer on the Mac** during failure-hunting runs
   (`tcpdump -i <if> -w ring.pcap -C 50 -W 4 host <device-ip>`): zero device
   perturbation, and one captured failure separates the §3.1 candidates
   almost completely — retransmissions-with-no-ACKs (link dead beyond the
   Mac), ACKs-arriving-with-shrinking-window (device app stall — would
   indict §3.3/3.4 after all), or the Mac itself not transmitting (M3).
4. **Two control pings** logged from the Mac during runs (`ping -i 0.2` to
   the AP and to a second, wired host): if the AP ping dies during the outage
   window, the Mac side is implicated (M3); if both survive while the device
   is dark, the device/AP-to-device leg is implicated (M1/M2/M4).

### Tier 1 — schema 6: ~32 bytes of new bounded counters (firmware)

All saturating u32 in the existing 1 Hz sample; no logging, no allocation, no
audio-path work. Handlers already exist for the event loop that Wi-Fi events
arrive on (`sys_evt`, priority 20):

| Field                                                                                     | Source                                                                                                   | Names                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `wifi_disconnect_events`, `wifi_last_disconnect_reason`, `wifi_last_disconnect_uptime_ms` | `WIFI_EVENT_STA_DISCONNECTED` (carries the 802.11 reason code: beacon timeout vs deauth vs assoc expiry) | M1 vs M2 directly                                                                                                                       |
| `wifi_beacon_timeout_events`                                                              | `WIFI_EVENT_STA_BEACON_TIMEOUT`                                                                          | M1                                                                                                                                      |
| `wifi_reconnects`                                                                         | `WIFI_EVENT_STA_CONNECTED` after first                                                                   | recovery cycle count                                                                                                                    |
| `wifi_rssi_dbm` (sampled 1 Hz)                                                            | `esp_wifi_sta_get_rssi()`                                                                                | marginal-link trend before events                                                                                                       |
| `pcm_last_receive_chunk_age_ms`                                                           | now − last `receive_chunks` advance                                                                      | "how long since any downlink byte", live                                                                                                |
| `pcm_network_max_inter_pass_gap_ms`                                                       | max of (pass start − previous pass start) in the network task                                            | the _currently unmeasurable_ scheduler-starvation axis (§3.4); closes the gap the brief identified in `pcm_network_maximum_work_cycles` |

CPU: a handful of subtractions per pass (~tens of cycles at 160 MHz);
RAM: ~32 bytes. Red-first: extend the fake-platform metrics test to assert
serialization (`tests/metrics_subscription_test.c` pattern), then the
simulator, then flash.

### Tier 2 — make the host gate measure progress, not kernel-accept

Two independent options; either detects a total stall in <1 s instead of
~4.3 s **without adding any buffering or relaxing the 160 ms freshness
budget** (detection latency and staleness budget are different quantities —
the budget stays; the _detector_ stops lying):

- **(a) Device-truth gate:** the bridge (or runner) already receives
  `downlinkAccepted` at 1 Hz on the control socket; alarm when
  `framesSent − downlinkAccepted` exceeds budget+reserve for ≥1 sample while
  sends continue. No firmware change; couples the gate to the metrics path.
- **(b) Host-side barrier ping:** the host sends a WS PING on the PCM socket
  every 250 ms with a 500 ms pong deadline. The firmware already parses PINGs
  on the PCM network task and queues the PONG reply ahead of data
  (`websocket_connection.c:537-561`, `websocket_tx.c:349-369`) — this is the
  exact mirror of the device's own uplink delivery barrier
  (`pcm_peer_delivery_guard.c:25-42`), so it introduces no new concept, and
  RFC 6455 ordering makes a returned pong prove consumption of every
  preceding PCM byte. Cost: 2+12 bytes each way, 4×/s. This is the simplest
  honest downlink-progress signal and works even when the metrics socket is
  the thing that died.

Plus, in the same change: **close with `socket.resetAndDestroy()`** (Node
≥18.3) on 4013 instead of graceful close, discarding the kernel backlog so
stale speech is unsendable by construction (§3.5). One line plus a regression:
fake device stops reading, later resumes — must receive RST, not 131 KB of old
tone.

---

## 5. Q3 — is the polling loop the simplest robust design?

The measured verdict first: in the failing runs the loop polled ~248×/s,
missed zero frames, absorbed 80-90 ms delivery pauses within its 7-frame
reserve, and died only when the link did. **The loop is not implicated, and no
redesign should be motivated by these failures.** Comparison for the record:

| Design                                                                                                                                     | Worst-case ingress latency | Idle cost                                                                                   | Failure modes                                                                                                                                                                                                                                                  | Verdict                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Current**: notify-wait 1 tick → receive burst (8) → bounded uplink (4) → receive burst, `wait=0` on progress (`pcm_transport.c:587-706`) | one tick (10 ms) + pass    | ~100-250 wakeups/s, each ~µs-scale                                                          | none observed; latency invisible next to the 140 ms reserve                                                                                                                                                                                                    | **Keep**                                                                                                                           |
| `select()` on the raw fd with 10 ms cap (uplink still notification-driven)                                                                 | ~0 ms for downlink         | wakes only on data — fewer idle wakeups                                                     | must trust transport-internal buffering; the project's IDF patch already fixed the spillover-poll bypass (`idf_overrides/tcp_transport/patch_transport.cmake:36-56`), so this is now _possible_; select round-trips tcpip like everything else                 | The acknowledged in-source TODO (`pcm_transport.c:599-605`). Worth doing for CPU hygiene and jitter, **not** as a fix for this bug |
| Blocking `recv(SO_RCVTIMEO=20 ms)` single task                                                                                             | ~0 ms                      | minimal                                                                                     | at 100 Hz, timeouts <10 ms floor to 0 (nonblocking!) and 10 ms → 0-10 ms (`esp-idf:…/port/freertos/sys_arch.c:312` floors mbox fetches); uplink work then waits behind the block — hurts PTT mode where TX matters                                             | No: multiplexing loss for no measured gain                                                                                         |
| Separate RX and TX tasks                                                                                                                   | ~0 ms                      | +1 task, +3-4 KB stack, cross-task state for tx/rx counters and the shared transport handle | the single-owner invariant (`websocket_connection.c:31-35`) is load-bearing today; splitting reintroduces the esp_websocket_client shared-context class of bugs the project just escaped                                                                       | No, absent a measured deadline miss                                                                                                |
| Event callbacks (`esp_websocket_client` style)                                                                                             | driver-dependent           | —                                                                                           | already replaced deliberately; upstream issue history is damning for this workload: parser desync on slow reads (esp-protocols #680), timeout/zero-length confusion (#858), keepalive starvation under continuous RX (#927), unserialized fragmentation (#687) | Stays rejected                                                                                                                     |

Two small metric repairs belong with whatever is touched next, because the
next investigation will lean on them: (1) timestamp each receive call rather
than reusing one pass-level `now_us` for both receive legs and the uplink leg
(`pcm_transport.c:679-694`; `esp_timer_get_time()` costs ~1 µs — the current
sharing quantizes `downlink_maximum_interarrival_ms` to pass cadence);
(2) exclude connect passes from `network_task_max_work_cycles` or count them
separately (§3.4), so the metric can finally distinguish a slow steady-state
pass from a reconnect.

---

## 6. Q4 — priority/core placement, lwIP sizing, transport parsing: causal?

**Not causal for the observed failures** — the §2 evidence stands regardless
of scheduling detail, and every specific suspect audits clean:

- **Priorities/cores** (`pcm_transport.c:834-842` prio 5 core 0;
  audio owner prio 19 core 1, `m5sticks3_direct_audio.cpp:360-368`;
  system set per `sdkconfig`): the reader held a 4 ms effective cadence at
  priority 5 _with_ Wi-Fi/timer/event tasks above it — measured, not argued.
  The floating tcpip task (`CONFIG_LWIP_TCPIP_TASK_AFFINITY=0x7FFFFFFF`) and
  the unpinned `iterate-ws` are the only mild irregularities; pinning tcpip to
  core 0 (Willow does; `CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0=y`) is a
  reasonable determinism tweak, not a fix.
- **lwIP sizing**: the recvmbox-6 cliff is real (§3.3) but requires a ≥120 ms
  reader absence that provably did not occur. Note carefully **what bumping it
  does and does not do**: recvmbox depth does not extend retained audio — the
  5,760-byte window caps buffered bytes regardless — it only converts
  "ACK-silent drop + sender RTO" into "window-closed backpressure", i.e. it
  removes a _drop amplifier_, not a freshness bound. A bump to 9-12 slots
  (+12-24 bytes of queue storage, transiently up to ~4 KB more pbuf/Wi-Fi-RX
  pinning) is therefore a _safe_ config change by this codebase's own rules,
  but with no observed incident to its name it should ride behind the §7
  instrumentation, not ahead of it.
- **esp_transport_ws parsing**: upstream v5.4.2 genuinely has the hazards the
  prompt worried about — payload stalls destroying frame state, poll blind to
  buffered spillover, PING handled as a silent zero-read with a blocking
  auto-pong in the reader's context (`esp-idf:components/tcp_transport/
transport_ws.c:447-673,916-987`) — and **this project already neutralized
  them**: the checked-in IDF override patches zero-read/partial-frame
  handling and the spillover poll bypass (`platforms/iterate_esp_idf/
idf_overrides/tcp_transport/*`), and PCM control frames propagate to the
  firmware's own classifier which _queues_ PONGs behind the TX conductor
  instead of writing inline (`websocket_connection.c:359,537-561`). The
  remaining vanilla-IDF caveats matter only for the control socket's
  `esp_websocket_client`, which has its own task and 10 s/15 s ping policy
  (`itx_transport.c:951-971`).
- **Console**: USJ 50 ms busy-spin per stalled write with no host reader
  (§3.4) — keep serial detached for acceptance runs as now, but stop needing
  logs at all via the Tier-1 counters. Do not silence Wi-Fi logs; count them.

---

## 7. Q5 — smallest red-first sequence that localizes the fault

Strictly ordered; no step enlarges any queue or budget; each has a red state
before a green.

1. **Red host regression for the gate semantics** (off-device, deterministic;
   generalizes the loopback probe from §2.4 into `apps/kit` tests): a fake
   device socket stops reading mid-stream. Assert what is currently true —
   the 4013 fires only after ~sendspace/rate seconds and a later resumed
   reader receives stale frames after the "close". Then implement Tier-2
   (progress gate + `resetAndDestroy`) and flip the assertions: gate fires
   within its declared detection deadline; resumed reader sees RST and zero
   post-close frames. Files: `local-fetch-websocket-server.ts` (+ its test).
2. **Runner post-mortem (Tier 0.1-0.2)**: red = a simulated late sample after
   a forced PCM close is currently dropped; green = grace window + rolling
   history dump land it in the artifact. Zero firmware.
3. **One failure-hunting session with passive capture (Tier 0.3-0.4)**:
   tcpdump ring + dual pings + (optionally) `wdutil` logging on the Mac.
   Repeat 60-120 s tone runs until one 4013. Expected classification power:
   pcap alone separates "Mac transmitted into silence" (M1/M2/M4 — no ACKs,
   clean exponential retransmit ladder), "device ACKed but window closed"
   (would resurrect §3.3-3.4), "Mac stopped transmitting" (M3). The ping
   logs split M3 from AP-wide problems.
4. **Schema 6 counters (Tier 1)**: red = simulator/fake asserts the new
   fields serialize and saturate; flash; rerun until failure. The
   post-recovery sample then _names_ the event (`wifi_last_disconnect_reason`
   is an 802.11 reason code) with no serial attached.
5. **Targeted A/B only after 3-4 point somewhere**: candidates, cheapest
   adequate first — different AP/channel for the device (M2/M4); Mac on
   Ethernet to the AP (removes M3 entirely); `awdlkiller`/`ifconfig awdl0
down` (M3, noting Ventura+ re-enables — cite in §12); recvmbox 9-12 iff
   the pcap showed the zero-window/refused signature (it has not, so far).
6. **Quantify before declaring victory**: with ~1 outage/minute-of-airtime
   base rate that night, a fix claim needs ~10× the mean time between
   failures in clean runtime (e.g. 10 consecutive clean 60 s runs ≈ p<0.01
   under the old rate), which the existing ladder runner can drive once its
   `runtime` wiring is restored (`device-e2e.ts:469-471` currently throws).

Explicitly _not_ in the sequence: raising the 160 ms budget (forbidden and
useless — the budget was never the detector's problem), adding any host or
device queue, switching the PCM lane to UDP (ESPHome/snapcast prior art shows
TCP is workable at these rates with honest buffering; the product constraint
here is freshness, and the failure is environmental), or changing tick rate /
CPU frequency (rejected without measurement in the standing reconciliation,
and nothing in this evidence implicates them).

---

## 8. Q6 — where the system is tying itself in knots, and what to delete

1. **Three freshness detectors police the same direction; none measures the
   actual claim.** The host byte-gate (nominal 160 ms, actual ~4.3 s), the
   device idle probe (2 s + 1 s), and TCP keepalive (10 s + 3×5 s,
   `websocket_connection.c:36-47`) all approximate "is the peer consuming
   speech on time" — and the strongest of them is the _device's_, while the
   host's, which fires the visible failure, is the one measuring a kernel
   buffer. The simplification is not more machinery: **promote one
   authoritative progress signal per direction** (Tier 2b barrier ping
   mirrors the device's existing uplink design; or Tier 2a device-truth), and
   demote the byte ledger to what it actually is — a buffer-ownership bound —
   and `bufferedAmount` to a diagnostic. This _deletes_ policy: the
   "raw bufferedAmount vs exact payload ledger" dual accounting
   (`local-fetch-websocket-server.ts:309-312,393-396` + the explanatory
   comment block) collapses to one number plus one progress deadline.
2. **The close path claims a guarantee it delegates to the peer.** "The bridge
   must not retain more old conversation" is enforced in userland while
   ~131 KB sits kernel-retained (§3.5). `resetAndDestroy()` on freshness
   close makes the guarantee local and lets the comment stop being
   aspirational. One line, one regression.
3. **Metrics that answer the previous question, not the next one.**
   `network_task_max_work_cycles` (conflates connect), single pass-level
   timestamps (quantize interarrival), rolling history that is never printed,
   and a sampler whose evidence dies with the runner's eagerness to dispose —
   §4-§5 repairs are all deletions of ambiguity rather than new systems. The
   schema-5 receive-calls/chunks counters were exactly right; they just need
   the runner to stay alive long enough to read them after an incident.
4. **What should _not_ be simplified away**: the device-clocked pacing, the
   7-frame startup reserve, the fixed rings, the generation fences, and the
   burst/uplink/receive loop shape all just demonstrated 42+ seconds of
   flawless 20 ms cadence under real RF with a 29% CPU budget — the
   architecture criticized as a possible local maximum in the earlier reviews
   is, on this axis, measurably sound. The knots are in the _observability and
   close semantics around_ the data path, not in the data path.

---

## 9. Ranked hypotheses with uncertainty

For the ≥4.2 s bidirectional outages (the 4013 class):

| Rank | Hypothesis                                                                                                     | P (subjective) | For                                                                                                                                                                                           | Against / what would change my mind                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Device↔AP link event: beacon loss/interference → probe → disassoc/reassoc cycle, or AP-side deauth/steer/rekey | ~0.55          | abrupt bidirectional death; ≥4.2 s duration typical of reassoc cycles; 2.4 GHz-only radio in a home RF environment; PS already off; device otherwise perfectly healthy; recovered by next run | a pcap showing the Mac _also_ deaf to the AP, or Wi-Fi counters showing zero disconnect events during a failure                                        |
| 2    | Mac-side radio interruption (AWDL windows / scan storm)                                                        | ~0.20          | Macs demonstrably do this; the runner cannot see it; both observed directions die from the Mac's perspective too                                                                              | AP-ping from the Mac surviving through an outage; Ethernet A/B showing no change                                                                       |
| 3    | AP-internal stall (rekey, queue wedge, firmware hiccup) affecting one client                                   | ~0.15          | home-AP realities; GTK-rekey ~1 s reports exist (longer stalls plausible on failure)                                                                                                          | AP logs / second-client control traffic surviving                                                                                                      |
| 4    | Device Wi-Fi-driver or tcpip-thread wedge ≥4.2 s                                                               | ~0.10          | would neatly explain bidirectionality; blob is unobservable                                                                                                                                   | `pcmReceiveCalls` continuing to advance across an outage (Tier-0 sequence-gap readout) — that single number moves nearly all of this mass to ranks 1-3 |

For the sub-100 ms ingress-jitter class (absorbed today; occasionally
~100-300 ms causing single recoverable underruns): ordinary 802.11
retransmission/aggregation delay (Espressif's stall-then-burst explanation,
issue #15345), possible AWDL blips, AP queueing — worth one pcap for texture,
not worth design changes; the 7-frame reserve is doing precisely its job
(90 ms absorbed in the clean verbose minute, `…-0122`).

Honest uncertainties: (a) outage durations are right-censored at ~4.3 s — the
host always closes first; true durations could be 5 s or 50 s; (b) the
schema-4 failures (`0110`, `0115`, `0128`) lack per-second series, so
"reader alive to the end" is directly proven only for `0134` — the acoustic
and arithmetic invariants are what tie all four together; (c) nothing here
explains _why that night_ — RF environments have weather; only the §7
instrumentation makes the question answerable.

---

## 10. Cost accounting for every recommendation

| Change                                                   | RAM                                                 | CPU                                                             | Audio-path risk                                                         |
| -------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Runner grace window + history dump + late-sample logging | 0 device                                            | 0 device                                                        | none (host only)                                                        |
| tcpdump / control pings / wdutil during hunts            | 0 device                                            | 0 device                                                        | none                                                                    |
| Schema-6 counters (Tier 1)                               | ~32 B                                               | ~tens of cycles/s + one RSSI call/s                             | none (sys_evt/main task context)                                        |
| Host progress gate (Tier 2a or 2b)                       | 0 device                                            | 2b: one queued 2-byte PONG per 250 ms on the PCM net task (~µs) | none; detection-only                                                    |
| `resetAndDestroy` on freshness close                     | 0                                                   | 0                                                               | none                                                                    |
| Per-call timestamps + connect-excluded work-cycle max    | 0                                                   | ~1 µs per receive call                                          | none                                                                    |
| (Conditional) recvmbox 6→9..12                           | +12-24 B queue; transient ≤~4 KB extra pbuf pinning | 0                                                               | none to freshness (window still caps bytes); changes drop behavior only |
| (Deferred) select-based wakeup                           | ~0                                                  | fewer wakeups                                                   | touch only with the A/B rig; not motivated by this incident             |

---

## 11. Reconciliation with the clean minute and the failures

The clean 60 s runs and the four 4013 runs are the _same system in the same
environment_ separated only by whether a multi-second link event happened to
fall inside the window: interleaved results that night were fail (01:10),
pass (01:11), fail (01:15), pass (01:22), fail (01:28), fail (01:34). The
passing minutes carried 60-90 ms delivery pauses absorbed by the reserve —
the small-scale texture of the same radio environment. Neither the firmware
nor the host code changed behavior between a pass and a failure; the retained
per-second series shows the device performing identically in both until the
instant of link death. The "exactly eight frames / 5,120 bytes /
~157-159 ms" repetition across failures is not a mysterious matched stall
length — it is the gate's own saturation shape (8 × 640-byte budget, checked
against the next frame), reached ~4.25 s after any sufficiently long total
outage, every time, deterministically. The brief's instinct — "the next
experiment must localize why the device TCP receive path stops making
progress, not enlarge the freshness budget" — was right; the localization
answer is that "the device TCP receive path" was never the moving part: the
link under both sockets was.

---

## 12. Source register

**Worktree (key anchors).** Host: `src/device/local-fetch-websocket-server.ts:7,120-124(ws),217-224,237,251-280,281-298,299-357,359-396,491-510`;
`src/voice/device-pcm-proxy.ts:24-36,72-84,240,629-652,713-734,801-810,843-873`;
`scripts/device-e2e.ts:302,312-334,398-415,469-471,678-712,736-750,1064-1075,1105-1127,1157-1191,1286-1300`;
`src/device/playback-endurance-ladder.ts:35`; `src/device/m5sticks3-playback-endurance-target.ts:50-74,88-156,599-616`;
`src/device/kit-playback-metrics.ts:81-128`; `src/device/kit-device-contract.ts:154-180`.
Firmware: `platforms/iterate_esp_idf/pcm_transport.c:30-71,43-52,53-58,231-240,323-343,382-472,504-518,537-547,587-722,781-842,863-928,1106-1163`;
`platforms/iterate_esp_idf/websocket_connection.c:31-55,102-118,196-231,303-391,406-410,447-494,537-561`;
`platforms/iterate_esp_idf/itx_transport.c:525-534,826-855,912-971,1001-1009`;
`platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_websocket_policy.h:15,37-50,61-93,108-121`;
`platforms/iterate_esp_idf/idf_overrides/tcp_transport/{CMakeLists.txt,patch_transport.cmake:36-183}`;
`components/core/src/{pcm_lane.c:171-214,411,449,571, pcm_peer_delivery_guard.c:6-42,296-476, websocket_rx.c:68-190, websocket_tx.c:169-217,349-369, pcm_uplink_conductor.c:326-512, pcm_uplink_sender.c:6-12,239-336}`;
`components/capabilities/{src/metrics.c:730-815,905-914, include/iterate/kit/capabilities/metrics.h:106-114,260-272}`;
`platforms/iterate_m5unified/{m5sticks3_direct_audio.cpp:77,288-345,360-422,676-732, m5unified.cpp:50-119,242-333, include/…/m5sticks3_direct_audio.hpp:103-110,127,171-172}`;
`targets/m5sticks3/main/main.cpp:242-267,326-333,730-759,810-829`;
`targets/m5sticks3/sdkconfig:1136-1139,1196-1201,1261-1294,1404,1546,1561,1609-1648,1732-1733,2161` and `sdkconfig.defaults:7-18`.
Docs/evidence: `docs/audio-streaming-problem-and-evidence-2026-07-30.md` (esp. lines 615-780),
`docs/fable-audio-review-reconciliation-2026-07-30.md`,
`evidence/m5sticks3-playback/direct-lan-tone-{60s-…-attempt1-…-0110/observation.md, 120s-…-0115/{run.log,observation.md}, 120s-…-schema5-…-0134/run.log, 60s-…-strict-…-0128/}` plus the six re-analyzed `microphone.pcm16le` captures.

**ESP-IDF v5.4.2 (`~/esp/esp-idf`, f5c3654a).**
`components/lwip/lwip/src/api/api_msg.c:332-346,773,1672-1688`;
`src/core/tcp_in.c:432-447,512-530,576-584,1467-1473,1548-1618,1665-1666`;
`src/core/tcp.c:947,1000-1009,1487-1601,1878-1943`;
`src/include/lwip/opt.h:1516`; `src/include/lwip/priv/tcp_priv.h:116-126,449-461`;
`src/api/{sockets.c:964-1063, api_lib.c:582-703, tcpip.c:268-271,442-465}`;
`components/lwip/{Kconfig:37-46,639-641,691-700,817-823, port/include/lwipopts.h:44-59,608-611,665,877,891, port/freertos/sys_arch.c:159-184,214,252,298-323,536-539}`;
`components/tcp_transport/{transport_ws.c:105-134,337-350,447-673,916-987, transport_ssl.c:158-183,296-327}`;
`components/esp_wifi/{include/esp_wifi.h:656-669, include/esp_wifi_types_generic.h:369, Kconfig:25-59,194-239, esp32s3/esp_adapter.c:330-343,672}`;
`components/esp_netif/lwip/netif/wlanif.c:146-183`;
`components/esp_driver_usb_serial_jtag/src/usb_serial_jtag_vfs.c:72-171,302-319`;
`components/esp_timer/{src/esp_timer.c:506-509, Kconfig:50-68}`; `components/esp_system/include/esp_task.h:27-46`;
`docs/en/api-guides/wifi.rst:1799-1805`, `docs/en/api-guides/performance/speed.rst:222`.

**External.**
ESP-IDF S3 Wi-Fi guide (PS latency = DTIM cycle; PS_NONE): docs.espressif.com/projects/esp-idf/en/v5.4/esp32s3/api-guides/wifi.html.
esp-idf #9766 (PS on: 285-2,278 ms pings; PS off: <10 ms). esp-idf #15345
(Espressif engineer: hardware-layer stall → wait-queue → aggregated burst;
AMPDU-off measured unhelpful; GTK rekey ~1 s comment).
esp-protocols issues #680, #858, #927, #942, #687, #777 (esp_websocket_client
realtime hazards). ESPHome voice_assistant (TCP native-API audio, 512 ms mic
ring, 2,000 ms stall watchdog; HA Voice PE: speaker `buffer_duration: 100ms`,
media `buffer_size: 500000`). snapclient ESP32 (~758 ms buffer on Wroom);
squeezelite-esp32 (480 KB + ~1.45 MB buffers); Willow (S3 voice:
`WIFI_PS_NONE`, `LWIP_TCP_RECVMBOX_SIZE=18`, `TCP_WND/SND_BUF=23040`,
`SACK_OUT=y`, lwIP pinned CPU0). ws docs (`doc/ws.md`: callback "when data is
written out"; bufferedAmount deviations) and `lib/{websocket.js,sender.js}`.
Node `net` docs (`socket.write` callback semantics). XNU
`bsd/netinet/{tcp_timer.h,tcp_timer.c,tcp_output.c}` (REXMTMIN 30 ms,
REXMTSLOP 200 ms, TLP). apple.stackexchange #451646 + `jamestut/awdlkiller`
(AWDL jitter; awdl0 semantics on Ventura+); Stute et al., arXiv:1808.03156
(AWDL channel-hopping mechanism).

---

## Appendix A — the five-second ledger, one failure end to end (run `…-0134`)

```
device uptime   event
──────────────  ────────────────────────────────────────────────────────────
17.2 s          PCM socket open (bridge elapsed 0); mount, subscriptions
~18.3 s         tone start; 7-frame startup burst; steady 50 fps thereafter
18.3→60.3 s     42 s of perfection: +50 frames/s, ~248 receive-calls/s,
                0 underruns, interarrival max 80 ms (set once, ~26 s uptime),
                CPU ~29%, heap flat. Host callbacks ≤1.7 ms.
≈60.3 s  T0     ALL TCP progress stops, both sockets, between two 1 Hz
                heartbeats. Sample 44 (59.3 s) is the last ever delivered.
T0+~0.19 s      device ring (~5 frames) + DMA (4 descriptors) exhausted →
                tone dies (mic: last tone energy 42.55 s capture time)
T0+~0.23 s      macOS first RTO (30 ms floor + 200 ms slop) — retransmits
                begin, exponential backoff, nothing deliverable
≤T0+3 s         device idle peer probe (2 s cadence, 1 s pong deadline)
                declares the peer dead, abandons the socket (per policy;
                unobservable in retained artifacts — Tier-0 fixes this)
T0+~4.05 s      macOS 131,072-byte send buffer finally full; the next
                ws.send() callback cannot complete; Node ledger starts aging
T0+~4.21 s      8th frame enters the ledger (5,120 B); oldest ≈158 ms
T0+~4.23 s      9th frame arrives → byte gate → close 4013; bufferedAmount
                5,152 = 8 × 644; elapsed 47.446 s
close+191 ms    runner disposes /api; post-mortem evidence dies with it
capture end     terminal silence 4.195 s (= T0+…close+SoX stop − tone death)
```

Every number above is either read directly from the artifacts or derived from
measured constants; no step requires an unobserved mechanism.
