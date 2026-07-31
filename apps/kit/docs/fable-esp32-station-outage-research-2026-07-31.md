# Fable research: localising and simplifying the physical ESP32 station outage

Status: independent research input, 2026-07-31. Produced from the worktree
`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities` (uncommitted
taskless-control state on top of checkpoint `a0c54771d`), the local ESP-IDF
checkout at `/Users/jonastemplestein/esp/esp-idf` (v5.4.2, commit
`f5c3654a1c`), the retained physical evidence, and external primary sources.
No implementation or test file was modified. Path shorthands used below:

- `FW` = `apps/kit/firmware`
- `IDF` = `/Users/jonastemplestein/esp/esp-idf`
- run `0414` = `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-60s-diagnostics-churn20-inbox8-ping-physical-20260731-0414`
- run `0421` = `…/direct-lan-tone-60s-diagnostics-churn20-inbox8-dual-ping-physical-20260731-0421`
- run `0451` = `…/direct-lan-tone-60s-taskless-control-dual-ping-physical-20260731-0451`

Everything below is classified into: **[measured]** (retained artifact or
directly quoted source), **[source]** (behavior read from code/docs, not yet
observed on this hardware), **[inference]** (deduced from measured facts plus
source), and **[speculation]** (plausible, currently unsupported).

---

## 0. Executive synthesis

1. **[measured]** In three matched loaded runs the M5StickS3's station address
   became completely unreachable for 17.2 s / 18.56 s / 18.48 s while the
   router answered every probe over the same Mac interface. Playback was
   acoustically perfect until abrupt truncation. The device recovered its IP
   (same address, same MAC) and answered pings continuously afterwards, but
   neither application socket ever remounted — including in run 0451, which
   runs the new taskless control transport and a 30-second host grace window.
2. **[inference]** The mid-run outage is **not a reboot**. At every cold boot
   the device mounts its capability (`uptime_ms ≈ 17.26 s`) about **1.2–1.7 s
   before** the first post-reset ICMP reply appears; after the mid-run gap the
   device answered pings for ~17 s with **no** mount against a live, accepting
   server. A crashed device (panic is configured as immediate reboot,
   `CONFIG_ESP_SYSTEM_PANIC_PRINT_REBOOT=y`, `FW/targets/m5sticks3/sdkconfig:1181`)
   would have re-mounted before it became ping-visible.
3. **[inference]** The ~17–19 s figure is a **pipeline, not a single outage**:
   ≤ 8.5 s of in-driver beacon-loss detection (6 s inactive time + 5 probe
   requests at ~500 ms — Espressif-documented), then the firmware's **own
   reconnect ladder**, which after one disconnect event defers the first
   `esp_wifi_connect()` by 2 s and doubles to 4 s/8 s/16 s on each failure
   (`FW/platforms/iterate_esp_idf/itx_transport.c:757-784`), then a full
   all-channel scan + WPA2 + DHCP DISCOVER + a 1–2 s ARP probe
   (`CONFIG_LWIP_DHCP_DOES_ARP_CHECK=y`, sdkconfig:1576). The same ladder runs
   at every boot, and boot-to-network is a **repeatable ~15–17 s on this AP**
   — strong evidence that joining this AP fails several times in a row every
   single time, most plausibly AP-side admission gating (band-steer /
   probe-or-auth withholding), before any mid-run trigger is even considered.
4. **[measured/source]** The **trigger** of the mid-run drop is still unnamed,
   but the discriminating datum already crosses the wire 20 times per second
   and is thrown away: every `getDiagnostics` churn reply carries
   `wifiDisconnects` and `lastWifiDisconnectReason`
   (`apps/kit/src/device/kit-control-diagnostics.ts:38-79`), and the harness
   parses then discards it (`apps/kit/scripts/device-e2e.ts:568-628`). Logging
   the first and last parsed reply is a **zero-firmware-byte change** that
   dates the boot-join failures and names the outage reason code on the next
   failing run.
5. **[inference]** The **failure to remount is a second, independent defect**
   and it is _not fully explained_ by the old managed-client stop hang: run
   0451 uses the taskless control transport (no `esp_websocket_client`
   anywhere in the tree any more) and still never remounted, although ESP-IDF
   v5.4.2 provably clears the netif address on every station disconnect
   (`IDF/components/esp_netif/lwip/esp_netif_lwip.c:1751-1799`), so
   post-outage ICMP proves DHCP re-bound and `IP_EVENT_STA_GOT_IP` fired,
   which resets both retry gates for an immediate reconnect
   (`itx_transport.c:750-756`). The PCM lane's silence _is_ explained: its
   reconnect gate is Wi-Fi-blind and can legally sit at a 16–30 s backoff when
   the station returns (`FW/platforms/iterate_esp_idf/pcm_transport.c:592-671`).
   The control lane's silence is not; §4 lists the three concrete candidates
   and the retained counters that separate them.
6. **Top next actions**, ranked by information per unit of perturbation
   (details §5/§7): (a) retain churn diagnostics host-side and log every
   `/api`+`/pcm` TCP accept/upgrade with a wall clock — host-only; (b) attempt
   a **no-reset harvest** of the retained incident tuple still sitting in the
   Stick's RAM from run 0451; (c) extend the two postmortem windows (module
   constants, override parameters already exist) so they outlive the measured
   outage plus the worst reconnect backoff; (d) one failing run with the
   already-implemented non-resetting serial monitor
   (`ITERATE_KIT_SERIAL_DIAGNOSTICS=1`) to capture the Wi-Fi blob's own
   `bcn_timeout`/reason lines; (e) schema-v3 diagnostics: add
   `wifi_connect_attempts`, got-IP/disconnect timestamps, and the transport
   state + fatal latch. Only after the reason code is named: the A/B ladder in
   §7 (router settings, second AP, IDF v5.4.3, ladder repair).

Nothing here recommends a larger audio buffer, replaying stale audio, or
letting a reconnect turn a failed endurance run green.

---

## 1. Evidence base and reconstructed timelines

### 1.1 The three matched loaded runs

All three: same command shape (60 s deterministic tone, device-clocked
downlink, startup 7, `--control-churn-hz 20`, `--no-flash`), same Stick
(`70:04:1d:d5:45:88`, `192.168.0.21`), same Mac listener
(`192.168.0.169:58685`).

| Quantity                          | 0414 (task control)        | 0421 (task control)             | 0451 (taskless control)        |
| --------------------------------- | -------------------------- | ------------------------------- | ------------------------------ |
| Boot gap (reset → first ICMP)     | ~17.5 s (seq 164–338)      | 18.93 s (wall-clocked)          | 18.94 s (wall-clocked)         |
| `uptime_ms` at mount              | 17,230                     | (mount before ICMP, same shape) | 17,258–17,290                  |
| Mid-run station gap               | ~17.2 s (seq 558–729)      | 18.561 s                        | 18.477 s                       |
| Router loss during gap            | n/a (single ping)          | zero (seq 0–647)                | zero (seq 0–636)               |
| Last device metrics sample        | seq 408 @ uptime 39,392 ms | seq 237 @ uptime 30,383 ms      | seq 185 @ uptime 28,386 ms     |
| Continuous tone before truncation | 21,887.5 ms, 0 gaps        | 12,620 ms, 0 gaps               | (capture retained; same shape) |
| Host PCM gate (4013, TCP RST)     | 27,389 ms, 1,317 frames    | 18,076 ms, 850 frames           | 16,136 ms, 713 frames          |
| Post-gap ICMP with no remount     | ~4.2 s (ping ended)        | 16.86 s                         | ~17.0 s (seq 476–636)          |
| Grace window                      | 6.5 s (timed out)          | 30 s (timed out)                | 30 s (timed out)               |

Sources: `0414/observation.md`, `0414/ping.log`, `0414/run.log`;
`0421/observation.md`; `0451/run.log`, `0451/device-ping.log`,
`0451/router-ping.log` (0451 has **no observation.md yet** — a provenance gap;
the flashed taskless image is not hash-recorded anywhere. Write one.).

### 1.2 Reconstructed wall-clock timeline for run 0451 [measured + inference]

Wall times from the timestamped sidecars; device times from echoed
`uptime_ms`/`producedAtMs`.

| Wall clock (s, abs) | Event                                                                                                          | Class                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1785469836.47       | esptool RTS reset; device ICMP stops (seq 15)                                                                  | measured                                                            |
| +≈1.5–3             | app_main → M5Unified begin → config read → `esp_wifi_start()`                                                  | source (boot order, `FW/targets/m5sticks3/main/main.cpp:1048-1101`) |
| ≈1785469853.8       | capability mount (uptime 17.26 s)                                                                              | measured (uptime echo)                                              |
| 1785469855.41       | first post-boot ICMP reply (seq 189) — **1.2–1.7 s after mount**                                               | measured                                                            |
| ≈1785469857–61      | churn + playback start; ~460 frames play cleanly                                                               | measured                                                            |
| ≈1785469866.5       | last healthy device evidence: metrics seq 185 (uptime 28,386 ms), resolve id 190                               | measured                                                            |
| 1785469867.44       | last ICMP reply before gap (seq 304)                                                                           | measured                                                            |
| 1785469867–75       | _inferred_: beacons lost → blob probes → `WIFI_EVENT_STA_DISCONNECTED` (reason retained on device, never read) | inference                                                           |
| 1785469885.92       | ICMP resumes (seq 476): station re-associated **and DHCP re-bound** (address had been cleared — §3.2)          | measured + source                                                   |
| 1785469885.9–1902.9 | 17.0 s of continuous ICMP; **no** `/api` or `/pcm` connection at the still-listening host                      | measured                                                            |
| ≈1785469896.8       | 30 s grace expires; teardown; ping stops at seq 636                                                            | measured                                                            |

The host freshness gate (8 outstanding callbacks / 5,120 payload bytes, then
`resetAndDestroy()`,
`apps/kit/src/device/local-fetch-websocket-server.ts:378-382,623-651`) fired
~5 s after the device stopped acking — the macOS ≈131 KiB kernel send buffer
blind window already established in
`fable-esp32-receive-stall-reconciliation-2026-07-31.md`. Nothing new there;
the gate did its job.

### 1.3 What run 0451 adds beyond 0421 [measured]

- The **taskless control transport did not fix non-recovery.** The tree no
  longer contains `esp_websocket_client` at all
  (`FW/platforms/iterate_esp_idf/idf_component.yml` now has empty
  dependencies); control I/O is the same single-owner nonblocking adapter as
  PCM (`FW/platforms/iterate_esp_idf/websocket_connection.c`). Yet the
  post-recovery silence is identical. The 0421 diagnosis (managed client's
  `stop_wait_task()` joining `STOPPED_BIT` with `portMAX_DELAY`) was real, but
  it was **not the only** non-recovery mechanism.
- The `/api` TCP socket was **already dead host-side** by teardown
  (`deviceSocketCloseDisposition: "alreadyClosed"`, 0451 `run.log`): the
  device really tore down its half of the connection during the outage — the
  eager close on Wi-Fi loss (`itx_transport.c:798-805`) or a send failure
  after the netif address was cleared, followed by RSTs to the Mac's
  retransmissions after rejoin. An association-preserved "AP blackhole with
  surviving TCP sessions" is thereby excluded for this run: if the device-side
  pcbs had survived, the pending `resolve` for pull 191 would have arrived
  late on the still-open host socket. It never did.
- `control_network_maximum_work_cycles` jumped to 25,053,891 (~157 ms at
  160 MHz) versus 870,118 in 0414 — the taskless transport's blocking
  `connection_open()` is now measured inside the owner loop's work-cycle
  metric. Expected, but it means that metric now conflates connect passes with
  steady-state passes. Control network stack headroom (min-ever) is 856 bytes
  of 3,072 at mount (0451 `run.log`), versus 960 in the task-based build.

### 1.4 Boot joins are as slow as outage recovery — every time [measured]

Reset → first ICMP: 17.5 s / 18.93 s / 18.94 s. Mount at uptime ≈ 17.23 s /
n/a / 17.26–17.29 s across the runs (and every earlier retained run whose
metrics echo survives shows the same ~17.2 s mount uptime). ESP32-S3 baseline
joins are 1–3 s (multiple sources, §2.3). Something makes **every** join of
this AP take ~13–15 s of Wi-Fi time. That constant is the single most
important unexplained number in the system, because the mid-run outage
duration is `detection + (the same join pipeline)`.

---

## 2. Q1 — Ranked mechanisms for ~17 s of total station unreachability

The productive decomposition is **trigger** (what removed the station from
the air) versus **duration** (why ~17–19 s until it answered again). The
duration is now mostly accounted for by detection + the measured reconnect
pipeline; the trigger remains open with a clear discriminator.

### 2.1 Duration: the reconnect pipeline the firmware itself shapes [source]

After `WIFI_EVENT_STA_DISCONNECTED`, the sole Wi-Fi owner (control network
task) does this (`itx_transport.c:707-796`):

1. The event handler stores the reason, clears `wifi_connected`, sets
   `wifi_retry_later`, wakes the task (`itx_transport.c:401-413`).
2. In the very next task pass **two branches both fire**: the
   `prior_wifi_connected` edge (schedules retry at `now + 1 s`, doubles the
   delay to 2 s, `itx_transport.c:757-769`) and then the `wifi_retry_later`
   exchange (**overwrites** the schedule to `now + 2 s` and doubles again to
   4 s, `itx_transport.c:775-784`). Net effect of one disconnect event: first
   `esp_wifi_connect()` at **+2 s**, with the next-failure delay already 4 s.
3. Each _failed_ connect attempt raises another `WIFI_EVENT_STA_DISCONNECTED`
   → defer by the current delay and double: attempts land at ≈ +2, +6–8,
   +14–17, +30 s (attempt duration ~2–3 s each: all-channel scan
   `WIFI_ALL_CHANNEL_SCAN` is configured, `itx_transport.c:1097`; active dwell
   ~120 ms × 13 channels, Espressif docs).
4. On success: WPA2 4-way, then DHCP **from scratch** — the disconnect path
   not only stopped the client, it sent a DHCPRELEASE and wiped the lease
   (`dhcp_stop` → `dhcp_release_and_stop`,
   `IDF/components/lwip/lwip/src/core/ipv4/dhcp.c:1425-1498`), and
   `CONFIG_LWIP_DHCP_RESTORE_LAST_IP` is **not** set (sdkconfig:1581), so
   every rejoin is a full DISCOVER→OFFER→REQUEST→ACK (the same address
   returns only because the router re-offers it; a lost DISCOVER retries on
   a 250 ms/500 ms/1 s/2 s/4 s backoff,
   `IDF/components/lwip/port/include/lwipopts.h:395`), plus
   `CONFIG_LWIP_DHCP_DOES_ARP_CHECK=y` adds a documented ~1–2 s per bind
   (sdkconfig:1576; `IDF/components/lwip/Kconfig:331-332` — "This process
   lasts 1 - 2 seconds").
5. Only `IP_EVENT_STA_GOT_IP` republishes `wifi_connected`
   (`itx_transport.c:424-428`) — association alone does not.

Detection before all of this: the Wi-Fi blob (closed source,
`IDF/components/esp_wifi/lib`) declares beacon loss after the 6-second
default inactive time, sends 5 unicast probe requests ~500 ms apart, then
raises the disconnect with reason 200 — ≈ **8.5 s worst case**, documented in
Espressif's Wi-Fi guide and FAQ and shown with exact timestamps in
esp-idf issue #941 (`bcn_timout,ap_probe_send_start` → +2.5 s →
`ap_probe_send over`).

Pipeline totals [inference]:

| Branch                 | Detection | 1st attempt | Failures                | Join+DHCP | Total         |
| ---------------------- | --------- | ----------- | ----------------------- | --------- | ------------- |
| Zero failed reconnects | 6–8.5 s   | +2 s        | —                       | 3–5 s     | 11–15.5 s     |
| One failed reconnect   | 6–8.5 s   | +2 s        | +2–3 s fail, +4 s defer | 3–5 s     | **17–22.5 s** |
| Two failed reconnects  | 6–8.5 s   | +2 s        | +12–15 s                | 3–5 s     | 23–30 s       |

The observed 17.2/18.5/18.5 s sits exactly on the one-failed-reconnect
branch. The boot joins sit on a two-to-three-failure ladder (initial delay
1 s at boot because `WIFI_EVENT_STA_START` sets `wifi_retry_now`,
`itx_transport.c:392-399`): attempts at ≈ 0, +3, +8, +15 s — matching the
constant ~13–15 s of Wi-Fi time to GOT_IP at every boot. In other words:
**join attempts against this AP appear to fail ~1–3 times consistently, and
the firmware's doubling ladder stretches those failures into the observed
constant.** What fails the individual attempts is the remaining trigger-side
question (§2.2, AP admission gating being the leading candidate).

### 2.2 Trigger: ranked mechanisms

**T1 — AP-side eviction or admission gating (deauth, probe/auth withholding,
airtime fairness). Likely; not yet named.**
Consistent with: only this station lost while the router path stayed
perfect (0421/0451 router logs); the _constant_ slow boot join on this AP;
external prior art — TP-Link Deco mesh withheld auth from ESP stations
(`AUTH_EXPIRE` every ~2 s per attempt) until a router firmware fix
(ESPEasy #4976); Meraki documents 2.4 GHz probe-response withholding for
band steering; ASUS airtime fairness documented (by Wyze) to drop ESP-class
clients; hostapd `ap_max_inactivity` eviction exists but defaults to 300 s.
Predicts: retained reason ∈ {1 UNSPECIFIED, 2 AUTH_EXPIRE, 4/8 deauth/leave,
or repeated 201/2 on the reconnect attempts}. The router model at
`192.168.0.1` is not recorded in any artifact — it should be.

**T2 — Beacon-loss (reason 200) from RF interference or buffer starvation
under load. Plausible; second.**
The classic load-linked mechanism (beacons dropped when RX buffers are
exhausted) is weakened here because power save is explicitly off
(`esp_wifi_set_ps(WIFI_PS_NONE)`, `itx_transport.c:1122`) — Espressif's own
fix advice for bcn_timeout under load is exactly `esp_wifi_set_ps(0)`
(issues #9108/#9339) and that is already the configured state. RX buffers
are stock (static RX 10, dynamic RX 32, BA win 6, MGMT_SBUF 32,
sdkconfig:1272-1291) and the offered load is modest (~100 pkt/s each way,
~90 kbit/s). Two residual sub-mechanisms stay live: (a) 2.4 GHz interference
near a Mac + USB3 gear; (b) **TX-side buffer starvation** — the build uses
dynamic Wi-Fi TX buffers with PSRAM enabled
(`CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM=32`, sdkconfig:1277), against
Espressif's explicit guidance that "If PSRAM is enabled, 'Static' should be
selected to guarantee enough WiFi TX buffers"
(`IDF/components/esp_wifi/Kconfig:75`); Espressif's FAQ also lists
management-buffer exhaustion as a bcn_timeout cause. Predicts: retained
reason == 200 and `wifi_disconnects` incrementing exactly once per incident,
plus (optionally) `esp_wifi_statis_dump` counters on a serial lane. One
adjacent wrinkle: `CONFIG_ESP_WIFI_STA_DISCONNECTED_PM_ENABLE=y`
(sdkconfig:1304) powers the RF module down while disconnected and idle, and
v5.4.3 fixes a sleep hang "during the transmission of probe requests after
beacon timeout" — a disconnected-state power-management bug could stretch
the ladder's per-attempt cost on exactly this IDF version. Bluetooth
coexistence, the other classic bcn_timeout co-factor (issue #941), is off
(`CONFIG_BT_ENABLED` unset, sdkconfig:617).

**T3 — ESP-IDF v5.4.2 station-management defects. Plausible amplifier,
unlikely sole cause.**
v5.4.3 explicitly fixes "inactive time reset when wifi disconnect",
"disconnect when sta scan in connected state", "scan done event miss", and a
sleep hang "during the transmission of probe requests after beacon timeout"
(v5.4.3 release notes). Any of these could lengthen detection or make an
attempt fail spuriously; none obviously creates the initial deafness.
Discriminated by an IDF-bump A/B _after_ the reason code is known.

**T4 — Device-local resource failure (heap, stacks, queues, CPU). Effectively
excluded for the outage itself.**
Last pre-outage samples: ≥115 KiB min free internal heap, largest block
34.8 KiB, all queue/failure counters zero, stack headrooms stable
(0414/0451 `run.log`). App tasks run at priorities 1–6 plus audio 19 on core
1 — all far below the Wi-Fi task and lwIP (`tcpip` priority 18, no affinity,
sdkconfig:1546,1648; Wi-Fi task priority set in the blob, pinned core 0), so
no application task can starve ICMP echo (answered in `tcpip`) even if it
spins. TWDT is 5 s/print-only and watches only the idle tasks
(sdkconfig:1215-1220; `IDF/components/esp_system/task_wdt/task_wdt.c:430-435`),
so starvation would log to the unread console, not reset. CPU runs at
160 MHz, not the S3's available 240 (sdkconfig:1136-1139) — playback-time
CPU is ~30%, so headroom exists but is not the issue here.

**T5 — Whole-device reset (panic/brownout/TWDT-panic). Excluded.**
Panic reboots immediately (`CONFIG_ESP_SYSTEM_PANIC_PRINT_REBOOT=y`,
REBOOT_DELAY 0, sdkconfig:1181-1184; coredump disabled, sdkconfig:1338) and a
rebooted device mounts _before_ it becomes ping-visible (§1.2). Post-outage:
17 s ping-visible, zero mounts, against a listening server that accepts any
number of fresh `/api` sessions and replaces mounts unconditionally
(`apps/kit/src/device/local-device-peer.ts:295-318`).

**T6 — Host/AP-path failure (Mac Wi-Fi, router uplink). Excluded for these
incidents** by the untouched 10 Hz router control (0421/0451) and healthy
RTTs immediately before each gap.

**T7 — Power-save / DTIM pathologies. Excluded as configured** —
`WIFI_PS_NONE` before `esp_wifi_start()` (`itx_transport.c:1122`); confirm
once on a serial lane (absence of `pm start` in the boot log) and then stop
re-litigating it.

### 2.3 Where the timing does _not_ match [honesty section]

- If every reconnect attempt succeeded immediately, the pipeline yields
  11–15.5 s — _below_ the observed 17.2–18.6 s. The model requires ≈ one
  failed reconnect attempt per incident (or a slower detection than 8.5 s).
  Nothing retained yet proves those attempt failures; `wifi_connect_attempts`
  exists as a counter (`itx_transport.c:788-790`) but is **not** in the
  diagnostics schema (`FW/components/capabilities/include/iterate/kit/capabilities/metrics.h:133-174`).
- The beacon-loss detection numbers (6 s + 5×500 ms) are blob behavior:
  documented and issue-corroborated, not visible in the local source tree.
  Treat the 8.5 s as Espressif-documented, not measured on this device.
- The boot-time share before `esp_wifi_start()` is now bounded from source:
  the selected M5Unified/M5GFX path contains ≈350 ms of deliberate delays
  (two 100 ms waits, a 13 ms panel reset, a 130 ms ST7789 sleep-out —
  `M5GFX.cpp:2604,2607,2616`, `Panel_ST7789.hpp:79`), the 8 MB PSRAM memtest
  is strided (1 word in 8, `IDF/components/esp_psram/esp_psram.c:533-545`)
  and costs tens of milliseconds, and the M5 components touch neither Wi-Fi
  nor power management. Pre-Wi-Fi boot is therefore ~1–2 s, which pins
  **~14–16 s of every boot on the join + DHCP pipeline itself**. A single
  serial-lane boot log turns that subtraction into a measurement.

---

## 3. The second defect: no remount after the station returns

### 3.1 The host cannot be the reason [measured/source]

The device dials the host, never the reverse
(`apps/kit/src/device/local-device-peer.ts:165-177`). During both 30 s grace
windows the LAN listener stayed up; every fresh `/api` upgrade creates a new
session and `mount()` replaces any live mount with generation+1 — there is no
host-side session pinning to reject a replacement
(`local-device-peer.ts:295-318`, `local-device-peer-server.ts:97-113`).

### 3.2 Post-outage ICMP proves GOT_IP fired [source, v5.4.2]

`esp_netif_action_disconnected` → `esp_netif_down`
(`IDF/components/esp_netif/esp_netif_handlers.c:82-86`), and
`esp_netif_down_api` stops DHCP, resets the stored IP info, and
**unconditionally clears the lwIP netif address**
(`netif_set_addr(lwip_netif, IP4_ADDR_ANY4, …)`) before `netif_set_down`
(`IDF/components/esp_netif/lwip/esp_netif_lwip.c:1751-1799`). A station that
answers ICMP again therefore has **completed re-association and a fresh DHCP
bind** — at which point `esp_netif_dhcpc_cb` raises `IP_EVENT_STA_GOT_IP`
(same-address rebinds included), the handler sets `wifi_connected`
(`itx_transport.c:424-428`), and the GOT_IP edge resets both the Wi-Fi ladder
and the WebSocket retry gate "for immediate recovery"
(`itx_transport.c:750-756`).

So in run 0451 the control transport had `wifi_connected=1`, a reset retry
gate, a reachable listening server, and ~11 s of grace left — and produced no
visible connection. That is a real defect (or a real, unlogged connect
failure), not scheduling bad luck.

### 3.3 PCM's silence is explained by its own design [source]

The PCM transport deliberately owns no Wi-Fi state
(`FW/platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_pcm_transport.h:149-151`).
During the outage it detects peer death within ≤3 s (idle probe 2 s + pong
deadline 1 s, `esp_idf_websocket_policy.h:60-61`), then blindly retries
`connection_open()` (blocking, up to 10 s each) on a 250 ms→30 s doubling
gate that **nothing resets when the station returns**
(`pcm_transport.c:589-671`). Fast connect failures while the netif is down
walk the gate to 16–30 s, so the first post-recovery PCM attempt can
legitimately land 13–27 s _after_ GOT_IP — outside every grace window used so
far. Not a mystery; still a design smell (§6).

### 3.4 Control non-recovery: three discriminable candidates

**C1 — The reconnect attempts happen and fail, invisibly. [speculation with
a retained witness]** Any failure retains `last_websocket_transport_errno`
and bumps `websocket_start_attempts` (`itx_transport.c:835-864`). If e.g. the
first TCP connect after GOT_IP fails (ARP re-resolution, transient
`EHOSTUNREACH`), the gate defers 250→500 ms→…: that alone cannot consume
11 s unless every attempt fails, which would leave a large retained
`websocket_start_attempts`. **Discriminator: read the retained tuple** (§5.1,
§5.2).

**C2 — The fatal latch closed the door. [speculation with a retained
witness]** Before every open, the task checks its own **lifetime-minimum**
stack headroom and latches a permanent fatal failure below 512 bytes
(`itx_transport.c:822-834`; floor in `esp_idf_itx_transport.h:53`). Measured
minimum headroom is already 856 bytes at mount (0451). One deeper excursion
anywhere in the task's life — e.g. the teardown path plus diagnostics
sampling racing — permanently poisons the check because
`uxTaskGetStackHighWaterMark` never recovers. A fatal latch also exactly
matches "no attempts at all". **Discriminators:**
`control_network_stack_exhaustions` (already in the 1 Hz sample,
`main.cpp:768-771`) and, to be added, the latch bit + transport state in the
diagnostics schema. Note the latch is _designed_ never to clear
(`itx_transport.c:304-308,1187-1199`) — correct for corruption, harsh for a
stack-headroom heuristic.

**C3 — `wifi_connected` never got republished. [speculation]** Requires
either a lost/blocked default event loop delivery or a DHCP bind without the
got-ip callback — both contradicted by §3.2 unless the event loop task was
wedged (nothing in the app runs at or above its priority on core 0).
Retained got-IP counters/timestamps (schema v3, §5.4) make this falsifiable.

The 0421 mechanism (managed client stop joining `STOPPED_BIT` with
`portMAX_DELAY`) stands as the explanation _for the old firmware only_, now
verified against the byte-identical upstream v1.8.0 source: the join is
`xEventGroupWaitBits(..., STOPPED_BIT, false, true, portMAX_DELAY)` in
`stop_wait_task()` (`esp_websocket_client.c:542-556`), the bit is set only
when the private task exits (`:1451`), and that task can sit ~10 s per
blocking operation (`esp_transport_connect`/read/write all take
`network_timeout_ms` = 10 s defaults, `:31-35,1085,1204-1207,1306,1359`) —
with DNS resolution a **plain unbounded** `getaddrinfo`
(`IDF/components/esp-tls/esp_tls.c:210`). The component is deleted from the
tree (`idf_component.yml` diff; `managed_components/` no longer contains it)
and its deadlock/stop-race changelog through v1.8.0 (esp-protocols issues
#412, #625) is a documented reason not to bring it back.

---

## 4. Q2 — Smallest non-perturbing discriminators per mechanism

Ordered by information gained per unit of added perturbation. "Retained"
means: written at incident time into fixed storage, read later through the
existing one-shot `getDiagnostics` (fixed 1,280-byte caller-owned reply,
single-flight, no idle wire traffic — `FW/components/capabilities/src/metrics.c:962-1114`).

| #   | Discriminator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Change surface                                                                                                   | Separates                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Host: retain first+last parsed churn diagnostics; log both on failure.** The 912-byte resolves already carry `wifiDisconnects`, `lastWifiDisconnectReason`, `websocketStartAttempts`, errno/status tuple, 20×/s.                                                                                                                                                                                                                                                                                                                            | Host only (`device-e2e.ts:568-628` keeps the parse result it already computes)                                   | Boot-join failure count + reasons (first reply, ≈mount+50 ms); pre-outage baseline (last reply). T1 vs T2 at boot; frames the mid-run trigger.                                                                             |
| D2  | **Host: log every `/api`/`/pcm` TCP accept, upgrade start, upgrade failure with wall time.**                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Host only (`local-fetch-websocket-server.ts` upgrade path)                                                       | C1 (SYN arrives, upgrade fails) vs C2/C3 (nothing arrives) vs host-refusal (excluded but then proven).                                                                                                                     |
| D3  | **No-reset harvest of run 0451's retained tuple, possibly today.** The Stick has not been reflashed; unless it was power-cycled since, the retained incident (`last_wifi_disconnect_reason`, counters) is still in RAM and the device is still dialing `192.168.0.169:58685` on its 30 s gate. Start the LAN listener at that exact origin **without** the esptool config read (it hard-resets via RTS — `device-e2e.ts` startup, run.log "Hard resetting via RTS pin"); wait ≥60 s for a mount; call `getDiagnostics`.                       | Host only; needs a listener-only mode                                                                            | If it mounts: names the outage reason **and** proves control recovery works on long horizons (pointing at C1/backoff or window-length artifacts). If it never mounts while pingable: C2 (latch) confirmed almost outright. |
| D4  | **Extend the postmortem windows to outlive the failure being studied.** Constants: remount wait 25 s + one-shot fetch 25 s inner, 30 s outer grace, 6 s PCM follow-up (`apps/kit/src/device/control-mount-diagnostics.ts:59-60`, `device-e2e.ts:1186`). The outer 30 s races an inner path that can legitimately need 50 s, and PCM alone can need GOT_IP+27 s. Make outer ≥ 90 s via the existing `timeoutMs` overrides (both helpers already accept one; the harness just doesn't pass it).                                                 | Host only                                                                                                        | Turns every future failing run into a retained-tuple read instead of a destroyed opportunity. Post-failure observation only; acceptance semantics unchanged.                                                               |
| D5  | **Serial lane on one failing run: `ITERATE_KIT_SERIAL_DIAGNOSTICS=1`** — the pyserial monitor already exists, opens with DTR/RTS deasserted so it cannot reset the device (`apps/kit/src/device/python-serial-monitor.ts:8-15`). Captures the blob's own `bcn_timout,ap_probe_send_start`, reason prints, `wifi:state:` transitions with timestamps.                                                                                                                                                                                          | Env flag; bounded perturbation (console writes from Wi-Fi/net contexts; USB-Serial/JTAG console, sdkconfig:1205) | Direct detection-phase timing; T1 (deauth reason logged immediately) vs T2 (bcn_timeout then probes); per-attempt failure reasons during the ladder; boot-time breakdown (§2.3).                                           |
| D6  | **Diagnostics schema v3 (device, ~48–64 B static + serializer lines):** add `wifi_connect_attempts` (counter exists, `itx_transport.c:788-790`), `sta_connected_events`, `got_ip_events`, `last_disconnect_uptime_ms`, `last_got_ip_uptime_ms`, `last_websocket_open_result`+`_uptime_ms`, current itx state + `fatal_failure_latched` + current retry delays. All owner-written, sampled through the existing snapshot; fits the 2 KiB slot budget (checked by the existing maximum-width serializer regression pattern, `metrics.c:90-92`). | Device, small; red-first C test                                                                                  | C1 vs C2 vs C3 in one read; converts §2.1's ladder model from inference to measurement (attempt counts + timestamps).                                                                                                      |
| D7  | **Router-side evidence:** record router make/model/firmware in observations; pull its station/DHCP/steering logs for the incident window; then the §7 router A/Bs.                                                                                                                                                                                                                                                                                                                                                                            | None (documentation) → router config                                                                             | T1 directly (eviction/steering visible AP-side), and explains the constant slow join if admission gating is configured.                                                                                                    |
| D8  | **Passive 2.4 GHz capture (monitor-mode sniffer on the AP channel) during one failing run.** Gold standard: distinguishes AP deauth frames (T1), the Stick's probe storms after beacon loss (T2), and pure silence (RF).                                                                                                                                                                                                                                                                                                                      | External hardware only; zero device/host change                                                                  | T1 vs T2 vs RF conclusively; also measures the AP's response latency to the Stick's reconnect probes/auth (the per-attempt failure cost in §2.1).                                                                          |
| D9  | **`esp_wifi_statis_dump(0xffff)` on `WIFI_EVENT_STA_BEACON_TIMEOUT`** (Espressif's own triage advice, issue #9108) — only meaningful with D5's serial lane; gate it behind the same env-driven build knob if added.                                                                                                                                                                                                                                                                                                                           | Device, log-only, serial lane only                                                                               | T2 sub-causes (rx_abort, buffer exhaustion counters).                                                                                                                                                                      |

Explicitly rejected as first steps: periodic device logging (steals CPU from
the thing being measured), any queue growth, host retry of stale PCM, or
counting a reconnect as success (all per the standing contract).

---

## 5. Q3 — The exact reconnect timing, with sources

### 5.1 What is in this tree [source]

- Disconnect handling and ladder: `FW/platforms/iterate_esp_idf/itx_transport.c:401-413`
  (event), `750-796` (edge + `wifi_retry_later` double-defer + attempt +
  30 s watchdog re-arm). Constants `WIFI_RETRY_INITIAL_MS = 1000`,
  `WIFI_RETRY_MAX_MS = 30000`, `WIFI_CONNECT_WATCHDOG_MS = 30000`
  (`itx_transport.c:52-55`).
- One subtle hazard: after each `esp_wifi_connect()` the next eligibility is
  set to `now + 30 s` (watchdog); an attempt that fails _without_ raising a
  disconnect event (e.g. `esp_wifi_connect()` returning an error while a
  previous connect is still in flight) leaves a silent 30 s hole
  (`itx_transport.c:786-796`).
- WebSocket gate: 250 ms → 30 s doubling, reset only by READY (control,
  `itx_transport.c:738-748`) or `socket_connected` (PCM,
  `pcm_transport.c:616-618`), plus the GOT_IP edge for control only
  (`itx_transport.c:750-756`). `retry_gate_defer` doubles per call
  (`FW/components/core/include/iterate/kit/retry_gate.h:34-41`).
- Station config affecting join time: `WIFI_ALL_CHANNEL_SCAN` +
  `WIFI_CONNECT_AP_BY_SIGNAL` (`itx_transport.c:1097-1099`), WPA2 threshold +
  PMF capable/not-required + `WPA3_SAE_PWE_BOTH` (`1106-1112`),
  `WIFI_PS_NONE` (`1122`), credentials in RAM only (`1113`).
- DHCP: full DISCOVER on each rejoin (`CONFIG_LWIP_DHCP_RESTORE_LAST_IP`
  unset, sdkconfig:1581) + ARP check ~1–2 s (`CONFIG_LWIP_DHCP_DOES_ARP_CHECK=y`,
  sdkconfig:1576).
- Netif teardown proving the ICMP⇒GOT_IP implication:
  `IDF/components/esp_netif/lwip/esp_netif_lwip.c:1751-1799` (address cleared,
  ip-lost timer armed), `esp_netif_handlers.c:82-86`.

### 5.2 What is blob/doc-only [source, not locally verifiable]

- 6 s station inactive time: default documented at
  `IDF/components/esp_wifi/include/esp_wifi.h:1323-1338`
  (`esp_wifi_set_inactive_time`, "Default 6s", minimum 3 s; no Kconfig knob).
  Beacon timeout → 5 probe requests → `WIFI_EVENT_STA_DISCONNECTED`:
  `IDF/docs/en/api-guides/wifi.rst:1275-1279`; the ~500 ms probe spacing is
  visible only in issue #941's timestamped log (`bcn_timout` → +2.5 s →
  disassoc) — the state machine itself lives in
  `IDF/components/esp_wifi/lib/esp32s3/libnet80211.a` (closed).
- `esp_wifi_connect()` "attempts to connect only once"; reconnect is
  explicitly the application's job (`esp_wifi.h:443-445`,
  `wifi.rst:1263`). The connect-scan is a specific-AP all-channel scan with
  default 120 ms dwell per channel (`wifi.rst:595-596,743`) ⇒ ≈1.6 s per
  attempt on 13 × 2.4 GHz channels; failed attempts surface as another
  disconnect event (reasons 201/2/15/203/204,
  `esp_wifi_types_generic.h:109-171`). `failure_retry_cnt` is zeroed here
  (single try per call) and the roaming app is compiled out
  (`wifi_default.c:86-91`).
- Reason codes relevant to the trigger table:
  `WIFI_REASON_AUTH_EXPIRE = 2`, `DISASSOC_DUE_TO_INACTIVITY = 4`,
  `ASSOC_LEAVE = 8`, `BEACON_TIMEOUT = 200`, `NO_AP_FOUND = 201`,
  `ASSOC_FAIL = 203`, `HANDSHAKE_TIMEOUT = 204`
  (`IDF/components/esp_wifi/include/esp_wifi_types_generic.h:109-171`).
- v5.4.2 ships a beacon-RX fix and v5.4.3 ships four station-management fixes
  in exactly this area (release notes; §2.2 T3).
- lwIP TCP for context on §1.3: an ESTABLISHED connection survives a 17–19 s
  link outage by design — initial RTO 1.5 s (`CONFIG_LWIP_TCP_RTO_TIME=1500`,
  sdkconfig:1629), shift-based backoff, abort only after 12 retransmissions
  (`IDF/components/lwip/lwip/src/core/tcp.c:163-164,1241-1243,1301-1303`),
  which accumulates to minutes. The device-side sockets died because the
  firmware closed them (Wi-Fi-loss teardown), not because TCP gave up.

### 5.3 Where the arithmetic still disagrees

Stated plainly: **no combination of documented station-side timings reaches
17–19 s without at least one failed reconnect attempt** (or a detection
window materially longer than the documented 8.5 s). The missing term —
per-attempt failure, its reason, and its cost — is precisely what D1/D5/D6
retain. Until then the one-failure branch is the best fit, not a proof.

---

## 6. Q4 — Challenging the two-network-task architecture

### 6.1 What today's structure actually is [source]

Six schedulable actors touch the network path: Wi-Fi blob task (pinned core
0, `CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0=y` sdkconfig:1288; priority set
inside the blob), lwIP `tcpip` (prio 18, 3,072 B stack, no affinity,
sdkconfig:1546-1651), default event loop task, main/app task (core 0, prio 1,
10 ms loop, `main.cpp:1124-1276` — which also runs `M5.update()`'s ~100 Hz
one-byte PMIC I2C poll, a negligible but real core-0 tenant), control network
task (core 0, prio 5, 3,072 B stack), PCM network task (core 0, prio 6,
6,144 B stack). Both app network tasks are the same pattern instantiated twice:
notify-or-tick loop, retry gate, stop/restart flags, stack-floor fatal latch,
blocking `connection_open`, nonblocking single-owner I/O over the same
`websocket_connection` adapter, atomics-only metrics. The differences are
policy tables, Wi-Fi ownership (control only), and the lane payloads.

The product invariant is **separate sockets** — RPC must never queue behind
audio and purging stale audio must not touch the capability session
(`main.cpp:38-41`). That invariant does **not** require separate tasks,
separate reconnect policies, or separate Wi-Fi views; those are
implementation accidents that this incident turned into failure modes:

- PCM cannot see Wi-Fi, so it burns its backoff ladder against a dead netif
  and then sleeps through recovery (§3.3) — measured consequence: zero PCM
  remount within 30 s in three runs.
- Control owns Wi-Fi policy but shares nothing: the got-IP reset, the
  disconnect reason, and the ladder state are invisible to PCM and to
  diagnostics consumers of the PCM plane.
- The double-defer (edge + flag) is exactly the kind of policy duplication a
  single owner would not have (§2.1 step 2).
- Two blocking 10 s `connection_open` calls exist, one per task; each freezes
  that task's own restart/notify handling while it runs — the same
  head-of-line blocking the product forbids elsewhere.

### 6.2 Alternatives compared

**A. Status quo + targeted repairs.**
Keep both tasks; share the Wi-Fi signal (one atomic published by the control
owner, read by PCM's gate), reset PCM's gate on GOT_IP, fix the double-defer,
and cap the mid-session Wi-Fi ladder at ~5 s. Cost: +~30 lines, zero RAM.
Deletes nothing. Fastest path to correct recovery, weakest simplification.

**B. One network-owner task, two sockets (recommended A/B candidate).**
A single task owns Wi-Fi lifecycle, both retry gates (as one policy with two
lanes), and both nonblocking socket pumps; readiness comes from the existing
notify hints plus the same 1-tick idle wait. The rings, lanes, generation
fences, and the two _sockets_ stay exactly as they are — the invariant is
preserved at the socket/protocol layer, where it belongs.
Deletes: one 3,072 B stack + TCB, one stop/join path, one retry-gate
instance, the 5-vs-6 priority split and its compile-time proof, the
duplicated stack-floor latch, one work-cycle metric family. Estimated −3.5
KiB internal RAM, −150–250 lines, one fewer scheduling interaction to reason
about. Preconditions: `connection_open` must stop blocking (else control
handshakes stall PCM service — unacceptable). That means a staged
nonblocking connect, which `esp_transport` does not offer — see C.
Priority question dissolves: the merged owner runs at 6.

**C. Drop `esp_transport` for the data path; keep esp-tls only for TLS
(sans-I/O direction the codebase is already 80% into).**
Today the portable layer already owns WebSocket TX framing/masking and RX
classification (`websocket_connection.c` uses the transport only for
connect/read/write), and the build carries a **five-patch override** of
`tcp_transport` to force nonblocking semantics onto it
(`FW/platforms/iterate_esp_idf/idf_overrides/tcp_transport/patch_transport.cmake`
— handshake spillover, zero-read ≠ EOF ×2, log suppression, WANT_WRITE
classification). Replacing the parent transport with a raw lwIP socket (plus
esp-tls when wss returns) deletes: the override component and its five
patches, the hidden HTTP-upgrade buffer semantics, and the blocking connect
(a nonblocking `connect()` + gate-driven completion check integrates with B).
Adds: ~150–250 lines of owned connect/upgrade code (the HTTP upgrade request
is a fixed ~200-byte string; the response parse is a bounded header scan the
RX classifier can absorb). Net code size likely ~neutral, dependency surface
materially smaller, and the "patched vendor component drifts on IDF upgrade"
risk (explicitly flagged in the override's own CMake) disappears.

**D. Return to `esp_websocket_client`.** Rejected on evidence: its stop/task
model caused the 0421 hang class by construction (portMAX_DELAY join), its
changelog is a list of exactly these deadlock/race repairs through v1.8.0,
and the taskless replacement already exists and passes the suite. Nothing in
the outage evidence implicates the taskless data path.

**E. Move tasks/priorities/affinity.** No evidence: both incidents leave the
scheduler exonerated for ICMP (system tasks outrank everything app-side), and
the audio owner never missed a deadline while the network was alive. The
5-vs-6 split solved a real observed starvation between the two app tasks;
merging (B) removes the need rather than re-tuning it.

**F. ESPHome-style Wi-Fi manager policy (adopt policy, not framework).**
The largest credible prior art (ESPHome, powering the HA Voice PE) runs _one_
network owner with: 500 ms cooldown between attempts, per-BSSID retry
counting, phased escalation (fast connect → hidden → full scan → adapter
restart), and an explicit note that connect failures are detected by events,
not timeouts (`wifi_component.cpp` constants). ESP-ADF's `periph_wifi` is a
one-timer reconnect in one owner task. Both support: single owner, fast
fixed retry while a session is live, escalate slowly only when the world
stays broken — the opposite shape of today's "defer 2 s then double".
Concrete adoptable policy: while a realtime session was recently live, retry
at a flat ≈1 s with a per-BSSID cap before escalating; pin BSSID+channel from
the previous association for the first attempts (halves scan time; falls back
to all-channel).

**G. UDP/RTP for the PCM lane.** Out of scope for this incident (the station
itself vanished; transport framing was not the failure) and contradicts the
current deliberately-simple `/pcm` contract. Not pursued.

Recommendation: **A immediately** (it is small and evidence-driven), then
**B+C as one A/B lane** once the trigger is named, because B without C
re-introduces head-of-line blocking through the blocking connect.

---

## 7. Q5/Q6 — The audio contract, and the red-first experiment sequence

### 7.1 Contract check for every change proposed here

| Change                             | Playable-ASAP                    | Discard-stale                          | Bounded RAM   | Metrics   | Audio priority              |
| ---------------------------------- | -------------------------------- | -------------------------------------- | ------------- | --------- | --------------------------- |
| D1–D5 host/observation changes     | untouched                        | untouched                              | untouched     | improved  | untouched                   |
| D6 schema v3                       | untouched                        | untouched                              | +≤64 B static | improved  | sampled on app task only    |
| A (share Wi-Fi signal, fix ladder) | faster recovery to _fresh_ audio | unchanged (generation purge preserved) | zero          | unchanged | unchanged                   |
| B (one owner)                      | unchanged                        | unchanged                              | −3.5 KiB      | merged    | one fewer core-0 competitor |
| C (raw socket + esp-tls)           | unchanged                        | unchanged                              | ~neutral      | unchanged | removes 10 s blocking opens |

No proposal increases any audio queue, replays stale PCM, or reclassifies a
reconnect as success. Recovery-time improvements change how fast _fresh_
audio resumes; failed endurance runs stay failed.

### 7.2 Red-first sequence (each step falsifiable before the next)

**Step 0 (now, free): provenance + harvest.** Write `0451/observation.md`
(image hash unrecorded). Attempt D3's no-reset harvest before anything
resets the Stick. Either outcome is evidence (§4 D3).

**Step 1 (host-only red tests):** (a) churn observer retains first+last
diagnostics and the failure log asserts their presence (red: current code
drops them — `device-e2e.ts:568-628`); (b) accept/upgrade logging with wall
clock on both endpoints (red: today a failed upgrade is invisible); (c) grace
windows: red test that `settleControlMountOutcome`'s outer window exceeds the
inner observer's worst case (today 30 s < 25+25 s,
`control-mount-diagnostics.ts:59-60`), then pass evidence-derived overrides
(≥90 s) from the harness. Rerun the churn20 dual-ping lane until one failure:
this run alone should name the boot-join reasons (first reply), the outage
reason (retained tuple via remount or harvest), and whether control ever
dialed (accept log).

**Step 2 (device schema v3, red-first C tests):** maximum-width serializer
regression extended for the new fields; single-flight and reply-capacity
tests unchanged (`metrics.c` patterns already exist). Physical rerun: the
ladder model in §2.1 becomes measured (`wifi_connect_attempts`, timestamps).

**Step 3 (off-device fault injection — the rig exists):** the host suite
already fakes the ESP platform (`FW/tests/fakes/fake_esp_idf_platform.c`,
new `fake_esp_idf_control_websocket.c`). Add red tests that inject the
measured sequence — disconnect event storm, N failed connects, GOT_IP edge,
connect attempts failing k times post-recovery — and assert: single defer per
disconnect (kills the double-defer), gate reset on recovery for **both**
lanes, no fatal latch from transient stack-floor readings, remount within a
bounded number of passes. These are scheduling-policy tests; they do not
pretend to model RF (per the standing rule, the simulator never stands in
for the radio).

**Step 4 (physical A/Bs, one variable each, only after the reason code is
named):**

- Router: record model/firmware; disable band steering / airtime fairness or
  create a dedicated fixed-channel 2.4 GHz SSID → if boot joins collapse to
  1–3 s and mid-run outages stop or shorten, T1 is confirmed structurally.
- Second AP (phone hotspot / spare AP, same placement): cheapest T1/T2 split.
- IDF v5.4.3 bump alone (release-note fixes in exactly this area): T3.
- Ladder repair alone (flat 1 s mid-session retry + BSSID/channel pin):
  should cut the _duration_ term by ~8–12 s regardless of trigger — run it
  last so it cannot mask the trigger measurement.
- Optional: D8 sniffer alongside any of the above.

**Step 5:** only after cause + recovery are proven, fold A→B→C architecture
A/Bs through the usual gates (host contracts, memory/IRAM budget, matched
physical runs).

---

## 8. Q7 — Local maxima: complexity the code created for itself

1. **Two copies of one network-owner pattern** (tasks, gates, latches,
   stop paths, work-cycle metrics) to protect an invariant that lives at the
   socket layer. The 5-vs-6 priority split plus its compile-time proof exists
   only because there are two tasks to misorder. §6.2-B deletes the class.
2. **A five-patch vendored override to force nonblocking behavior onto
   `esp_transport`**, whose own CMake warns it breaks on IDF upgrades —
   while the portable layer already implements WebSocket framing both ways.
   The remaining value of `esp_transport` is connect + TLS; esp-tls provides
   TLS directly. §6.2-C deletes the override and the blocking connect.
3. **Reconnect policy grew by accretion**: an edge branch _and_ a flag branch
   both defer-and-double (double-defer); a 30 s connect watchdog can silently
   swallow an attempt; the WebSocket gate resets on READY, `socket_connected`,
   _and_ GOT_IP depending on lane. One owner, one table of (state → next
   attempt at) with the session-recency rule from §6.2-F is smaller and
   testable in the existing host rig.
4. **Diagnostics nearly answer this incident but stop one field short**:
   reasons and errno are retained, but attempt counts/timestamps/state/latch
   are not; the host receives the retained tuple 20×/s and discards it; the
   postmortem windows are shorter than the failure they were built to
   observe. All three are small, measured fixes (D1/D4/D6) — the
   observability system is a local maximum of _collection_ without
   _retention_.
5. **The ~17 s boot-to-voice constant is the join pipeline, not init code**:
   the M5 driver path adds ≈350 ms, the strided PSRAM memtest tens of
   milliseconds, and nothing else before `esp_wifi_start()` is multi-second
   (§2.3). Treating the slow boot as inevitable background cost has hidden a
   Wi-Fi admission problem that is _also_ the mid-run outage's duration term.
   Measure once with D5; whatever fixes the boot join almost certainly
   shortens the outage too — and it is a product cost, not just a test
   artifact.
6. **Panic/coredump posture wastes its evidence**: panic → instant reboot
   with print to an unread USB console, coredump `NONE` (sdkconfig:1181-1184,
   1338). A retained-reason surface exists (`esp_reset_reason()`) and is not
   exported in metrics. One field in schema v3 closes it (and would have
   excluded T5 in one read instead of an inference chain).

---

## 9. Classification ledger

**Measured facts.** Three coupled outages with per-run ICMP gap bounds;
router path clean in 2/2 dual-ping runs; same-MAC same-IP recovery; no
remount within 30 s in 2/2 extended-grace runs (one per transport
architecture); mount-precedes-ICMP boot ordering; constant ~17.2 s mount
uptime and 17.5–18.9 s boot ICMP gaps; clean acoustics until abrupt
truncation; pre-outage device health (heap/stacks/counters); host gate
mechanics and its ~5 s kernel blind window; sdkconfig values quoted above;
`/api` socket already dead at teardown in 0451.

**Source-supported inference.** The outage is not a reboot; post-outage ICMP
implies DHCP re-bind and GOT_IP (v5.4.2 netif teardown source); the duration
decomposes as detection (blob-documented ≤8.5 s) + the tree's own ladder
(+2 s first attempt, doubling) + join/DHCP (~3–5 s), requiring ≈1 failed
attempt to match observation; PCM's missing remount follows from its
Wi-Fi-blind backoff; control's missing remount is a real defect with three
candidates (C1 attempts-failing-invisibly, C2 fatal-latch, C3 lost got-IP);
the 0421 stop-hang explains only the old architecture.

**Speculation.** AP-side admission gating as the shared cause of slow boots
and per-attempt reconnect failures (strong external prior art, zero local
proof yet); RX-starvation beacon loss under load despite PS_NONE; v5.4.2
station-management bugs as amplifier; C2's one-time stack excursion.

**Safe diagnostic changes (no A/B needed).** D1, D2, D4 (host-only); D3
harvest; D5 serial lane on a failure-hunting run; D6 schema v3 + reset-reason
field; recording router identity in observations.

**Candidate fixes requiring A/B proof.** Ladder repair (single defer, flat
~1 s session-recent retry, BSSID/channel pin); sharing the Wi-Fi signal with
PCM's gate; longer-horizon merged owner (§6.2-B) and raw-socket/esp-tls data
path (§6.2-C); router reconfiguration; IDF v5.4.3. None may be judged by
"the run passed" alone; each must show the retained counters moving the way
the mechanism predicts.

**Explicitly not recommended.** Larger audio or control queues; retrying
stale frames; shortening freshness budgets to compensate; treating reconnect
as success; reverting to `esp_websocket_client`; speculative buffer/AMPDU
tuning before the reason code is on the record.

---

## Appendix A — Key source anchors

| Fact                                                                                                                                                                                                                 | Anchor                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wi-Fi events → flags only; owner reconnects                                                                                                                                                                          | `FW/platforms/iterate_esp_idf/itx_transport.c:385-428`                                                                                                                  |
| Double-defer ladder                                                                                                                                                                                                  | `itx_transport.c:750-784`                                                                                                                                               |
| Connect watchdog 30 s                                                                                                                                                                                                | `itx_transport.c:786-796`                                                                                                                                               |
| Eager WS close on Wi-Fi loss                                                                                                                                                                                         | `itx_transport.c:798-805`                                                                                                                                               |
| Stack-floor fatal latch                                                                                                                                                                                              | `itx_transport.c:822-834`; floor `include/iterate/kit/platforms/esp_idf_itx_transport.h:52-53`                                                                          |
| All-channel scan, WPA2/PMF/SAE, PS_NONE, RAM creds                                                                                                                                                                   | `itx_transport.c:1097-1122`                                                                                                                                             |
| GOT_IP resets both gates                                                                                                                                                                                             | `itx_transport.c:750-756`                                                                                                                                               |
| PCM Wi-Fi-blind reconnect, blocking open, 250 ms→30 s gate                                                                                                                                                           | `FW/platforms/iterate_esp_idf/pcm_transport.c:587-671`                                                                                                                  |
| PCM idle probe 2 s + 1 s pong deadline; priorities 5/6                                                                                                                                                               | `FW/platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_websocket_policy.h:51-63`                                                                           |
| Nonblocking single-owner WS adapter; keepalive 10/5/3; NODELAY                                                                                                                                                       | `FW/platforms/iterate_esp_idf/websocket_connection.c:36-47,301-431`                                                                                                     |
| tcp_transport 5-patch override                                                                                                                                                                                       | `FW/platforms/iterate_esp_idf/idf_overrides/tcp_transport/patch_transport.cmake`                                                                                        |
| Retained diagnostics tuple (schema 2)                                                                                                                                                                                | `FW/components/capabilities/include/iterate/kit/capabilities/metrics.h:125-174`; serializer `FW/components/capabilities/src/metrics.c:962-1114`                         |
| Netif address cleared on disconnect (ICMP ⇒ DHCP re-bind)                                                                                                                                                            | `IDF/components/esp_netif/lwip/esp_netif_lwip.c:1751-1799`; `IDF/components/esp_netif/esp_netif_handlers.c:82-86`                                                       |
| DHCP lease released at disconnect; full DISCOVER on rejoin; 250 ms→4 s DISCOVER backoff                                                                                                                              | `IDF/components/lwip/lwip/src/core/ipv4/dhcp.c:920-951,1425-1498`; `IDF/components/lwip/port/include/lwipopts.h:357-368,395`                                            |
| 6 s inactive time API; 5-probe recovery; reason-code enum                                                                                                                                                            | `IDF/components/esp_wifi/include/esp_wifi.h:1323-1338`; `IDF/docs/en/api-guides/wifi.rst:1275-1279`; `IDF/components/esp_wifi/include/esp_wifi_types_generic.h:109-171` |
| `esp_websocket_client` v1.8.0 unbounded stop join; 10 s blocking ops; unbounded getaddrinfo                                                                                                                          | upstream `esp_websocket_client.c:542-556,1451,31-35,1085,1204-1207` (byte-identical to the deleted managed component); `IDF/components/esp-tls/esp_tls.c:210`           |
| TCP survives 17–19 s outages (RTO 1.5 s, 12 retransmissions)                                                                                                                                                         | `IDF/components/lwip/lwip/src/core/tcp.c:163-164,1241-1243,1301-1303`; sdkconfig:1612,1629                                                                              |
| TWDT print-only (no panic), watches idle tasks                                                                                                                                                                       | `IDF/components/freertos/app_startup.c:185-199`; `IDF/components/esp_system/task_wdt/task_wdt.c:430-435,481`                                                            |
| M5 boot delays ≈350 ms; no Wi-Fi/PM/ISR in M5 components; ~100 Hz PMIC poll in `M5.update()`                                                                                                                         | `managed_components/m5stack__m5gfx/src/M5GFX.cpp:2604-2646`; `m5stack__m5unified/src/M5Unified.cpp:3203-3215`; agent-audited grep (no esp_wifi/esp_pm hits)             |
| sdkconfig: RX buffers 10/32, BA 6, MGMT_SBUF 32, tcpip prio 18/no-affinity, TCP wnd/sndbuf 5760, TCP recvmbox 6, DHCP ARP check, no lease restore, panic=reboot, TWDT 5 s print, coredump none, 160 MHz, 100 Hz tick | `FW/targets/m5sticks3/sdkconfig:1064-1651` (lines quoted in text)                                                                                                       |
| Host gate + TCP RST; host accepts any remount                                                                                                                                                                        | `apps/kit/src/device/local-fetch-websocket-server.ts:378-427,623-651`; `apps/kit/src/device/local-device-peer.ts:295-318`                                               |
| Postmortem constants 25 s/30 s/6 s with unused overrides                                                                                                                                                             | `apps/kit/src/device/control-mount-diagnostics.ts:51-60,124-155`; `apps/kit/scripts/device-e2e.ts:1186`                                                                 |
| Churn parses-and-drops diagnostics 20×/s                                                                                                                                                                             | `apps/kit/scripts/device-e2e.ts:568-628`; `apps/kit/src/device/kit-control-diagnostics.ts:38-91`                                                                        |
| Non-resetting serial monitor exists                                                                                                                                                                                  | `apps/kit/src/device/python-serial-monitor.ts:8-15`; env gate `device-e2e.ts:384-397`                                                                                   |

## Appendix B — External sources relied on

- Espressif ESP-IDF Wi-Fi guide + FAQ: 6 s inactive time; 60-beacon loss →
  5 probe requests → reason 200; scan dwell defaults; reason-code semantics
  (incl. `WIFI_REASON_CONNECTION_FAIL` for AP blacklists).
- esp-idf issue #941 (timestamped `bcn_timout` → 2.5 s probe phase), #9108
  (bcn_timeout under sustained TX; Espressif advice `esp_wifi_set_ps(0)`,
  `esp_wifi_statis_dump`), #9339 (S3 10 s assoc stall, 4-way timeout, TP-Link
  Deco), #14008 (S3 join failures on channel 1, TP-Link), #11615 (post-
  bcn_timeout stack wedge).
- ESPEasy #4976 + TP-Link community thread: Deco withheld auth
  (`AUTH_EXPIRE` ~2 s/attempt) until router firmware fix.
- Meraki band-steering doc (2.4 GHz probe withholding, 60 s memory); Wyze/ASUS
  airtime-fairness advisories; hostapd `ap_max_inactivity` default 300 s.
- esp-protocols `esp_websocket_client` issues #412/#625 and CHANGELOG
  (stop/destroy deadlocks and races fixed piecemeal through v1.8.0).
- ESP-IDF v5.4.2/v5.4.3/v5.5.x release notes (beacon/inactive-time/scan
  fixes post-dating the flashed v5.4.2).
- ESPHome `wifi_component.cpp` (single-owner policy constants), ESP-ADF
  `periph_wifi.c` (timer-paced single-owner reconnect), Willow `was.c`
  (managed-client workarounds) as prior art for §6.2-F.
