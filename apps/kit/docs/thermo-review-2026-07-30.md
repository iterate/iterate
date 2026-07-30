# Thermo-nuclear review: apps/kit firmware + voice path (2026-07-30)

Status: independent max-effort review of the uncommitted `apps/kit` tree, per
`docs/physical-device-voice-goal.md` § Review discipline. No files were
modified. Findings are ranked; every S1/S2 names the smallest failing
regression that should exist before the fix.

Scope reviewed line-by-line: `firmware/targets/m5sticks3/main/main.cpp`,
`platforms/iterate_esp_idf/{pcm_transport,itx_transport}.c`,
`components/core/src/{pcm_lane,spsc_ring,websocket_text,audio,device_events,
itx_connection,itx_mount,peer,configuration,retry_gate,cpu_usage,
pcm_websocket}.c`, `components/capabilities/src/*`,
`platforms/common/*.hpp`, `platforms/iterate_m5unified/m5unified.cpp`,
`devices/{m5sticks3,stackchan}.c`, M5Unified `Mic_Class`/`Speaker_Class`
internals, `espressif__esp_websocket_client` locking, sdkconfig. Vendored
Cap'n Web, the TS voice proxy, host tests, and the resource/IRAM ledger were
audited by parallel reviewers; their consolidated findings are in §8–§11.

---

## 0. Verdict

The bounded-everything architecture is genuinely good: SPSC rings with
acquire/release discipline, explicit metrics on every edge, no allocation in
the hot path, clean capability modules, and an apps/os-faithful mount chain.
This is far above typical firmware quality. It is not approvable yet, for
three structural reasons:

1. **The failure policy is "brick until power cycle" for a wide class of
   survivable events** (S1-1). One fragmented WebSocket delivery, one >1024-B
   inbound control message, one inbox overflow, one transient server-side
   auth rejection — each permanently latches the transport. The reconnect
   machinery that could recover already exists; the latch just forbids it
   from running. The vendored-capnweb pass (§8) adds three *capacity
   cliffs* that feed the same latch from inside a healthy session: a
   metrics push that reaches 1025 B against the 1024-B slot (guaranteed
   reachable via the INT64_MAX clamp), a 300-byte agent call that exceeds
   the 64-token parse budget, and an outbox-BEGIN backpressure burst of 5
   messages against 4 slots.
2. **The real-time audio path has zero scheduling margin** (S1-3/S1-4): the
   uplink runs at exactly 50 fps with the main loop's 10 ms tick as the only
   clock, audio-adjacent tasks are mis-prioritized (mic/speaker prio 2 under
   four prio-5 network tasks and prio-1 main), and any synchronous log in the
   realtime window can stall the single task that pumps both directions.
3. **The design is at a local maximum that the second device cannot use**
   (§7): StackChan (full duplex + AEC — the headline goal) has no audio
   implementation yet, and the Stick's "everything in one 10 ms prio-1 poll
   loop" model cannot host AEC. The seams to fix are cheap now and expensive
   after StackChan ships.

Two cross-component amplifiers make the first point worse than either side
alone: the TS proxy kills the whole voice session on conditions the device
causes routinely (any reply > 2.6 s of audio, 160 ms of provider
backpressure — §9 V-S1/V-S2), and the test suite compiles the two ESP
transport files and the half-duplex gate into **zero host tests** while
testing everything at non-production capacities (§11) — so none of the
brick paths above has ever been executed by CI.

One premise of this review dissolved under measurement: the **"one-byte
IRAM margin" is an `esp_idf_size` reporting artifact**, not a real
constraint — the binding pool has 194 KB free and 35–45 KB more behind
config flags (§10). Resource pressure is *not* a reason to accept any of
the complexity above.

---

## 1. S1 — will fail in the field

### S1-1 · Protocol-failure latch = permanent brick, on both transports

`latch_protocol_failure` sets `protocol_failure_latched`, which is **never
cleared anywhere**, and the network tasks refuse to restart the socket while
it is set:

- PCM: `platforms/iterate_esp_idf/pcm_transport.c:103-110` (latch),
  `:371-376` (start gate), `:533-537` (poll reports FAILED forever).
- Control: `itx_transport.c:165-172` (latch), `:463-470` (start gate),
  `:776-788` (poll discards + FAILED forever).

Everything routed into the latch is treated as fatal, but most triggers are
*remote or transient* conditions:

- any fragmented PCM downlink delivery (S1-2);
- an inbound control message over the 1024-B inbox slot
  (`websocket_text.c:190-191` → `E_LIMIT` → `fail_receive`
  `itx_transport.c:230-240`);
- control inbox ring overflow — 4 slots; a burst of 5 messages while the
  main loop is stalled bricks the device
  (`websocket_text.c:384-393` → `E_TRANSPORT` on `BACKPRESSURE` → latch);
- any `capnweb_session_receive` parse/limit error, e.g. a legit message that
  overflows the 64-token budget (`itx_transport.c:859-869`);
- any mount failure, **including a transient server-side rejection of
  `authenticate` or `provideCapability`** — a preview redeploy at the wrong
  moment permanently kills the device
  (`itx_mount.c:254-258`, `itx_connection.c:52-59` →
  `ITERATE_KIT_ITX_CONNECTION_FAILED` → `itx_transport.c:882-888` latch).

The goal doc requires "reconnect attempts, classified failures, and retry
state" as *metrics of an ongoing process*, not a tombstone. The devices are
meant to sit on shelves; today they need a human power cycle after events the
server can cause at will.

**Judo fix (deletes complexity):** delete `protocol_failure_latched`
entirely. On protocol failure: count it, `request_restart`, and let the
existing generation/backoff machinery (`socket_generation` bump →
session reset → retry gate up to 30 s) do what it already does for
disconnects. Keep `fatal_failure_latched` only for genuinely local
invariants (stack exhaustion, `ESP_ERR_NO_MEM`, generation wrap). If a
distinction is wanted for repeated failures, add a "N protocol failures
within M minutes → fatal" counter — but the default must be retry.

**Smallest failing regressions:**
- `itx_connection_test.c`: feed one malformed control message → assert
  connection reports failure; then `connection_lost` + `connection_open` on a
  new generation → assert mount restarts and reaches READY (fails today: the
  ESP transport never re-opens; model the transport contract at that layer
  or add an esp-transport-shaped host test).
- `pcm_lane` + transport-policy test: deliver a fragmented frame, then a
  well-formed frame after socket restart → assert frames flow again.
- Mount test: reject `authenticate` once, accept on retry → assert READY.

### S1-2 · PCM downlink treats any fragmented delivery as protocol death

`pcm_lane.c:151-157` rejects any delivery with
`!final_fragment || fragment_offset != 0 || fragment_bytes != message_bytes`,
and `pcm_transport.c:203-208` escalates that to `latch_protocol_failure`
(permanent, see S1-1). Two real-world producers of exactly this shape:

- **Short TLS reads.** `esp_websocket_client` dispatches `WEBSOCKET_EVENT_DATA`
  with whatever `esp_transport_read` returned; a 640-B message whose TLS
  record arrives split across TCP segments produces `data_len < payload_len`
  with `payload_offset` advancing. The rx `buffer_size` is exactly one frame
  (`pcm_transport.c:20,467`), so there is no slack at all.
- **WS-level continuation frames** (opcode 0x00): `message_type()`
  (`pcm_transport.c:152-161`) maps them to `OTHER` → "nonbinary" →
  same latch. Any middlebox/edge that re-fragments (Cloudflare is entitled
  to) kills the device.

The glaring inconsistency: the **control** path already implements exact,
bounded fragment reassembly — `websocket_text_ingress_feed`
(`websocket_text.c:130-220`) tracks opcode/fin/offset and reassembles into
the ring slot. The PCM path got a different, fatal policy for the same
transport phenomenon.

**Judo fix:** reassemble into the already-acquired downlink ring slot —
`write_acquire` on `fragment_offset == 0`, `memcpy` at the offset, publish
on `fin && frame complete`, cancel on mismatch. Zero new memory (the slot is
the buffer), ~20 lines, mirrors the text ingress design. Keep rejection for
nonbinary and wrong-size messages, but a rejection must only restart the
socket (S1-1), never brick.

**Smallest failing regression:** `pcm_lane_test.c`: feed one 640-B binary
message as two chunks (offset 0 len 400, offset 400 len 240, fin=1) → assert
one frame is accepted. Fails today with `INVALID_ARGUMENT` +
`downlink_fragmented_messages=1`.

### S1-3 · Task priorities invert the real-time hierarchy

Current lineup (all confirmed in source/sdkconfig):

| Task | Prio | Core | Role |
|---|---|---|---|
| wifi | 23 | 0 | system |
| `iterate-ws` (control WS client) | 5 | any | TLS handshake + rx |
| `iterate-pcm-ws` (PCM WS client) | 5 | any | TLS handshake + rx |
| `iterate-net` / `iterate-pcm-net` | 5 | 1 | send pumps |
| **mic_task / spk_task (M5Unified)** | **2** | any | **I2S DMA drain/fill** |
| **app_main loop** | **1** | 0 | **both audio pumps + capnweb + UI** |

`m5unified.cpp:21-51` accepts the M5Unified defaults (`task_priority = 2`,
unpinned — `Mic_Class.hpp:89-92`, `Speaker_Class.hpp:73-76`); the transports
pin their net tasks to core 1 at prio 5 (`pcm_transport.c:22,503-511`,
`itx_transport.c:24,732-740`); the WS client tasks are created unpinned at
prio 5 (`pcm_transport.c:463-466`, `itx_transport.c:694-698`).

Failure scenario: PCM socket (re)connects **while PTT is held** — mbedtls
handshake burns hundreds of ms at prio 5, freely landing on core 0 —
starving the prio-1 main loop (which re-arms capture and pumps playback) and
the prio-2 mic task. The mic cushion is only ~32 ms (S1-4), so this is
guaranteed audible loss, precisely at "user starts talking after reconnect".

**Fix:** audio above network: raise mic/spk to ≥ 6 via
`M5.Mic.config()`/`M5.Speaker.config()` before `begin()`, pin the two WS
client tasks to core 1 (`task_core_id_set = true, task_core_id = 1`), and
raise the main loop's priority (or move the pumps out of it, §7). Verify
with the existing per-task cycle metrics on the physical rig.

### S1-4 · Uplink capture has zero throughput headroom and an invisible overrun mode

`BoundedCapture::pump` (`bounded_capture.hpp:39-70`) is stop-and-wait with
one buffer, and after `submit` it returns without re-arming; the re-arm
happens on the *next* main-loop iteration. Sustained rate is therefore 1
frame per 2 iterations of the 10 ms loop — **exactly 50 fps, the real-time
requirement, with zero margin**. The slack is M5Unified's I2S DMA ring:
`dma_buf_count=8 × dma_buf_len=128` at `over_sampling=2`
(`Mic_Class.hpp:71,83,86`) ≈ **32 ms**. The mic task discards its staging
state and blocks when no request is queued (`Mic_Class.cpp:588`), so any
main-loop overshoot beyond the cushion is **silent sample loss** — no
counter moves (`capture_frames_dropped` only counts in-flight collisions,
`audio.c:281-284`).

**Fix (one-line-shaped):** after `submit` returns in the same `pump` call,
fall through and immediately `record()` again (the frame was copied into the
lane synchronously; the buffer is free). That doubles drain capacity to one
frame per iteration. Better: queue two `record()` requests (M5Unified
supports exactly two) and make the cadence I2S-driven rather than
tick-driven (§7).

**Smallest failing regression:** host test with a scripted recorder: pump at
10 ms cadence for 10 s of synthetic audio → assert
`frames_submitted == 500 ± 1` *and* that a single 15 ms stall injected into
the pump cadence does not reduce total frames (fails today because the
recorder-side backlog model shows the re-arm gap). On the physical rig:
10-minute PTT hold → assert `capture_frames_sent ≈ elapsed × 50`.

### S1-5 · Two tasks run consumer-side ops on the control outbox ring

The SPSC ring's consumer state (`read_acquired`, `read_index`,
non-atomic — `spsc_ring.c:172-186`) tolerates exactly one consumer task.
The control outbox has two:

- network task: `discard_control_outbox` at `itx_transport.c:495,519` and the
  send path `:333-353`;
- **main task**: `discard_control_outbox` at `itx_transport.c:785` (latched
  branch, runs every 10 ms poll) — while the net task (still alive; the
  latch does not stop it) concurrently discards every 20 ms from core 1.

Both can pass `!read_acquired`, acquire the same slot, and double-release —
advancing `consumer_sequence` past `producer_sequence`; `current_slots`
underflows to ~2³² and `write_acquire` then reports permanent backpressure:
a wedged ring. Today this is masked by "latched = dead anyway" (S1-1), but
the moment the latch becomes recoverable this becomes a first-class wedge;
it is also UB right now.

**Fix:** ring consumer ownership must be exclusive: only the network task
discards the outbox (it already does on `!socket_connected`); delete the
main-task call at `:785` (inbox discard there is fine — main owns the inbox
consumer side). Optionally assert single-consumer with a task-handle check
in debug builds.

**Smallest failing regression:** pthread host test: two threads
acquire/release-discarding one ring while a third publishes → assert
`current_slots ≤ capacity` invariant holds (fails/asserts today).

---

## 2. S2 — correctness under plausible conditions

### S2-1 · Serial diagnostics can still disrupt PCM (the answer is: yes, three ways)

The design intent is right — `reportMetrics` and display refresh are gated
on `!realtimeAudioActive` (`main.cpp:803-821`, `display_refresh_gate.hpp`) —
but the gate has holes:

1. **Un-deduped per-iteration error log.** A persistent device-poll failure
   logs every 10 ms with no state-change dedupe (`main.cpp:687-693`),
   unlike playback (`:782-790`) and transports (state-diffed). Console =
   USB-Serial-JTAG on IDF v5.4.2
   (`sdkconfig: CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`): the driverless
   console TX busy-polls the 64-B HW FIFO with a per-write flush timeout
   (tens of ms) before it decides the host is gone — so with a host that
   opened the port and stopped draining (paused monitor, flow-controlled
   terminal), *each* log line can cost the prio-1 main loop tens of
   busy-spun milliseconds, and a flapping host keeps re-arming the stall.
   Sustained per-iteration logging in that state starves the core-0 idle
   task toward the **task WDT (5 s) → panic reboot**
   (`CONFIG_ESP_TASK_WDT_TIMEOUT_S=5`, `PANIC_PRINT_REBOOT`), and even the
   benign disconnected case burns the flush timeout once per detection
   flap. Either way the capture cushion (S1-4: ~32 ms) is smaller than one
   stalled log line.
2. **Logs inside the realtime window.** `sendAudioEvent` and
   `observeDeviceEvent` (`main.cpp:115-123,257-271`) log at PTT and
   playback boundaries — inside active audio by definition. Transport
   state-change logs (`:724-732,768-778`) also fire mid-audio (e.g. PCM
   READY→CONNECTING on a reconnect during playback). Each is a synchronous
   console write in the only task that pumps audio.
3. **Third parties log too.** `esp_websocket_client` ESP_LOGE on send/read
   errors runs on the prio-5 WS/net tasks; with a wedged console those
   stalls back-pressure into send timeouts (which are themselves logged…).

**Fix:** one deferred-diagnostics ring (bounded, drop-oldest, with a
dropped-count) written by all runtime logging and flushed only in the
`consumeIfIdle` window — the same policy the display already has. Dedupe the
device-poll error by last-status like playback does. Consider
`esp_log_set_vprintf` routing to the ring so component logs obey the same
gate.

**Smallest failing regression:** host-side: not testable; make it a rig
assertion — hold PTT, wedge the console (open port, no reads), assert zero
`capture` gaps and no WDT reset over 60 s.

### S2-2 · One 250 ms send-lock timeout restarts the PCM socket

`esp_websocket_client` reads while holding `client->lock` with
`network_timeout_ms` = **10 s** (`esp_websocket_client.c:1085`, config at
`pcm_transport.c:475-476`); sends take the same lock with the 250 ms policy
timeout (`esp_idf_websocket_policy.h:10`). A partial TLS record on lossy
Wi-Fi ⇒ reader holds the lock until bytes arrive ⇒ uplink send fails once ⇒
`request_restart` (`pcm_transport.c:312-318`) ⇒ full TLS reconnect and
downlink discard — a multi-second glitch escalated from a sub-second stall.
Same pattern on the control transport (`itx_transport.c:355-361`).

**Fix:** treat a send timeout as backpressure, not disconnection: retry next
wake while `esp_websocket_client_is_connected()`, restart only after K
consecutive failures (K=3–4 ≈ one second). Keeps bounded latency (uplink
ring still drops-with-metric) without the restart amplifier.

**Smallest failing regression:** not host-testable against the real client;
encode the policy in a transport-shaped host test (fake send that fails N−1
times then succeeds → assert no restart request; fails today at N=2).

### S2-3 · 2-slot downlink ring converts network jitter into dropped speech

`pcmDownlinkSlotCount = 2` (`main.cpp:36`) = 40 ms of jitter absorption
before `producer_backpressure` drops agent speech; total device-side
downlink buffering is ring 2 + playback 3 = 100 ms. TCP delivers bursts
after every retransmit/stall; a 100 ms stall followed by a 5-frame burst
loses 3 frames (60 ms of speech) *even though the information arrived*.
Meanwhile the speaker's own DMA (`dma_buf_count=8 × 256` ≈ 128 ms,
`Speaker_Class.hpp:66-70`) is a hidden buffer *below* the carefully bounded
5-frame pipeline — the bound is already ~230 ms end-to-end, just badly
distributed.

**Fix:** downlink is playback, not conversational input — depth there is
latency-safe as long as *interruption flushes it* (it does:
`flushPlayback` + `discard_downlink`). Raise the ring to 8 slots (+3.8 KB
.bss, §6) and shrink speaker DMA (`dma_buf_count` 3–4) so the buffer lives
where metrics see it. Assert steady-state depth stays ≤2 via the existing
high-water metric on the rig.

### S2-4 · Metrics push size: measured, it is worse than "thin headroom" — see C-S1-1

Initial estimate here was ≈700–800 B against the 1024-B outbox slot; the
vendored-capnweb pass serialized the exact message and found **1025 bytes
at INT64_MAX-clamped counters** — and `main.cpp:154-172` clamps saturated
counters to exactly `INT64_MAX`, so the overflow value is guaranteed
reachable (10-digit counters ≈ one year of frames get to 773 B; the clamp
gets to 1025). Promoted to §8 C-S1-1 with the exact size table, regression
and fix. (`outputCapacity = 128` is confirmed harmless — pure streaming
scratch, §8 preamble.)

### S2-5 · Stale-notify on deleted task handle during transport stop

`itx_transport_stop` joins the network task, but `transport->network_task`
keeps the dangling handle; between task exit and
`esp_event_handler_instance_unregister` (`itx_transport.c:925-945`), a Wi-Fi
event (`wifi_event:189-213`) calls `xTaskNotifyGive` on the deleted task —
UB if the TCB is recycled. Not reachable on the Stick today (stop is never
called) but the transports are the library for every future device.
**Fix:** null `network_task` (atomically) before deleting, and have
`wake_network_task` load it once. Same in `pcm_transport.c`.

### S2-6 · Reconnect discards the first frames of the *new* PCM socket

`pcm_transport_poll` (`pcm_transport.c:539-556`) discards the downlink ring
when the generation changed — but frames from the new socket may already be
in the ring (WS task delivers between CONNECTED and the next 10 ms poll).
Up to ~1 frame typically; bounded and self-healing, but the discard belongs
at disconnect time (or gate on generation *stamped per frame*, which the
2-slot ring makes trivial: just discard on disconnect event instead).
Low priority; note for the shared-transport extraction (§5).

---

## 3. Answers to the specific review questions

### 3a. The downlink producer-to-owner notification path

`receive_websocket_data` (WS client task) → `pcm_lane_receive_downlink` →
ring publish → `downlink_ready` callback → `xTaskNotifyGive(ownerTask)`
(`main.cpp:108-113`) → main loop's terminal
`ulTaskNotifyTake(pdFALSE, 10 ms)` (`main.cpp:828`).

Assessment: **sound**. Context (`&runtime`) is a static with program
lifetime; `ownerTask` is written once in `app_main` before either transport
starts, so publication is safe; the callback runs strictly in task context
(esp_websocket event dispatch), so `xTaskNotifyGive` (not FromISR) is
correct; the callback fires only after a *complete* frame is published
(post-S1-2 reassembly this stays true — keep the callback on publish, not
on fragment).

Caveats worth keeping true by construction:
- The owner task's notification slot (index 0) is now a **shared channel**
  with exactly one producer. Any future `xTaskNotifyGive(ownerTask)` from
  another subsystem silently changes the pdFALSE accounting below. If a
  second producer ever appears, switch to `xTaskNotifyIndexed` or an event
  group, or better: give audio its own task (§7) and keep the main loop on a
  plain tick.
- `downlink_ready` is invoked while the WS task still holds nothing — good;
  it must stay O(1) and never call back into lane/ring (it doesn't).

### 3b. `ulTaskNotifyTake(pdFALSE, …)` — right or wrong?

`pdFALSE` (decrement) makes the notification count a *frame counter*: N
published frames ⇒ N immediate loop passes, and since `pollPlayback`
submits at most one frame per pass (`bounded_playback.hpp:72-138`,
`submitStaged` once), the 1:1 pairing is exactly what drains a burst without
relying on the 10 ms tick. With `pdTRUE` a 2-frame burst would collapse to
one wake and strand the second frame for a tick — still fine at 2× drain
capacity, but pdFALSE is the tighter choice. Verdict: **pdFALSE is correct
here, and deliberately so** — but it is load-bearing on two invariants that
deserve a comment in `main.cpp`: (1) single producer (3a), (2) one-frame-
per-iteration consumption. The transports' own `ulTaskNotifyTake(pdTRUE, …)`
(`pcm_transport.c:359`, `itx_transport.c:387`) are also correct — those
loops drain *all* work per wake, so collapsing is wanted there. The
asymmetry is principled, not accidental; write it down.

One real cost: each notification voids the remainder of the 10 ms sleep, so
during downlink the loop runs ~150 Hz instead of 100 Hz, re-running
`M5.update()`, device poll, and both transport polls per extra pass
(~50 × `mainWorkCycles`-measured iterations/s). That is the price of the
poll-everything loop, not of the notification — see §7.

### 3c. Callback lifetime & cross-task safety (broader audit)

- `downlink_ready` / `sendPcm` / `sendAudioEvent` / metrics driver /
  event observer all point into the static `Runtime` — lifetime is the
  program; no teardown path exists on the Stick target (transport `stop` is
  never called), so no use-after-free windows today. S2-5 is the latent
  exception in the library.
- `capture_send_complete` (`audio.c:38-58`) is documented nowhere as
  main-task-only, yet the controller state it mutates is unsynchronized.
  Every existing transport completes it synchronously from inside
  `send_pcm`. **Judo: delete the completion-callback protocol entirely** —
  the lane's synchronous OK/BACKPRESSURE *is* the completion; the async
  seam is the ring, by design. Removing it deletes
  `capture_frame_in_flight`, `completed_synchronously`,
  `completion_protocol_errors`, and ~40 lines, and closes the cross-task
  hazard by construction. If a future DMA-completion transport appears, add
  the callback back *at that transport's boundary*, not in the core.
- `delivery_complete` (metrics) and the mount continuations run strictly
  from `session_receive`/`session poll` on the main task — safe, and
  `session_ended` correctly wipes subscription slots (`metrics.c:512-528`)
  so no stale imports cross a reconnect.

### 3d. RAM / CPU / IRAM — measured in §10; summary

`runtime` is 26,992 B exact (DWARF), dominated by deliberate bounded
storage: 8 KB control rings, 3.84 KB PCM rings, two 3 KB static task
stacks, 2.56 KB audio frames, ~7.8 KB transport structs. App-level PCM
copies are **3 per frame pair** (mic→ring, ws-rx→ring, ring→playback) =
96 KB/s — the uplink ring→WS send is already zero-copy at app level.
CPU cost of the whole PCM data path is <0.1 % of 160 MHz.

The **"one-byte IRAM margin" is a misreading**: the byte is a permanent
alignment gap after the 1,027-B vector table inside the always-full 16 KiB
I-bus-only window that `esp_idf_size`'s legacy summary reports as "static
IRAM". The linker's real IRAM assert has 262 KB of slack; the binding
resource is the shared D/IRAM pool at **194,344 B free**, and ~35–45 KB
more is available via sdkconfig flash-placement flags if ever needed
(§10). No IRAM emergency exists, and no code should be contorted to save
IRAM bytes.

---

## 4. Structural / code-judo findings (S3)

### S3-1 · Extract the shared ESP WebSocket worker (and Wi-Fi out of itx)

`itx_transport.c` (1042 lines — over the 1 k line bar) and
`pcm_transport.c` (677) duplicate, near-verbatim: the atomic helpers
(×2 ~50 lines each), latch/restart/disconnect bookkeeping, retry-gate
loop skeleton, stack-headroom guard, websocket client config (identical
keepalive/timeouts), static task creation + join-on-stop, work-cycle
accounting, and metrics marshalling. Meanwhile Wi-Fi bring-up/retry — a
device-level resource both sockets depend on — lives *inside* the control
transport (`itx_transport.c:584-757`), which is why the file is huge and
why the PCM transport free-rides on connectivity by accident of ordering.

Cut it as three modules:
1. `esp_idf_wifi_link` — netif/wifi init, credentials, backoff, metrics
   (~250 lines out of itx_transport);
2. `esp_idf_ws_worker` — one parameterized socket worker: {url, headers,
   subprotocol, buffer size, on_data, drain_connected, drain_disconnected}
   (~300 shared lines replacing ~600 duplicated);
3. the two thin policies: text mailbox glue vs PCM lane glue.

This is not cosmetic: StackChan needs the *same* two sockets, and every
policy fix from this review (S1-1, S2-2) currently has to be made twice.

### S3-2 · `metrics.c`: 330 lines of hand-built expression scaffolding

`build_audio_expression`/`build_metrics_expression` (`metrics.c:89-328`)
spend eight lines per integer field and a 18-member workspace struct whose
only job is keeping pointers alive. A table-driven builder —
`struct field { const char *key; int64_t value; }` array + one loop that
emits an object expression — collapses this to ~60 lines and makes "add a
field" a one-liner (it is currently the S2-4 brick hazard *and* eight lines
of ceremony). If the expression API can't express that, that's the missing
canonical helper in `capnweb/expression.h` — add it there, once.

### S3-3 · `takePhoto` shape contradicts the settled photo decision

`camera.c:9-43` returns the whole photo as one `reply_set_bytes` (base64 in
one message). The goal doc settles "must not require one unbounded
JSON/WebSocket allocation; prefer a returned photo capability or bounded
chunked transfer". With 1024-B outbox slots this works only for test-sized
images and cannot scale by tuning. Since a photo *capability with bounded
chunk reads* is also the flagship Cap'n Web compatibility case, the current
shape is a placeholder pretending to be a feature. Either implement the
chunk-read capability now or mark the module explicitly simulator-only.

### S3-4 · `renderPngUrl` bypasses the display gate

`m5unified.cpp:145-155` calls `showStatus` (synchronous SPI fills) directly
from capability dispatch — inside the realtime window if audio is active.
All display work should funnel through `DisplayRefreshGate` (store the
pending status, mark dirty); today the gate covers the periodic path but
not the RPC path. Same discipline as S2-1.

### S3-5 · Smaller items

- `audio.c:208-217`: `playback_flush_pending = true` set twice; the first
  assignment inside the `playback_active` branch is dead.
- `atomic_saturating_increment` CAS loops appear in four files; one
  `iterate/kit/atomics.h` header ends the copy-paste (and the subtle
  memory-order divergence between copies: pcm_transport uses ACQ/REL
  wrappers, pcm_lane relaxed — both defensible, but pick once).
- `main.cpp` `sampleRuntimeMetrics`/`reportMetrics` duplicate the
  metric-summing logic (addMetricValue chains vs the raw log lines) —
  acceptable, but the 190-line `reportMetrics` printf is at the edge of
  scannability; a small struct-of-lines formatter would halve it. Not
  blocking.
- `wifi_configuration` stack struct in `itx_transport_start` retains the
  password bytes after use; `memset` it before returning (README promises
  credential hygiene).
- `valid_header_token` (`pcm_transport.c:118-130`) is the right guard;
  note the API key also lives permanently in `auth_headers` — fine (needed
  for reconnect) but worth a comment since README promises wipe-on-failure.

---

## 5. Race/blocking audit summary (asked: "blocking, fragmentation, race, bounded-latency, local-maximum")

| Edge | Verdict |
|---|---|
| spsc_ring producer/consumer pairing (uplink: main→pcm-net; downlink: ws→main; inbox: ws→main; outbox: main→net) | correct acquire/release ordering, single-task each side — **except S1-5** |
| `discard_downlink` from main during CONNECTING | same-task as playback consumer — safe |
| `downlink_ready` → notify | safe, task context, complete-frame granularity (3a) |
| `send_uplink` holds ring slot across a ≤250 ms blocking send | bounded; capture backpressure counted; acceptable |
| `esp_websocket_client` reader-lock vs send timeout | **S2-2** restart amplifier |
| fragmentation | control: reassembled correctly; PCM: **S1-2** fatal |
| bounded latency | every queue bounded with metrics ✓; distribution wrong (S2-3); speaker DMA is an unmetered 128 ms annex |
| long-session drift | no unbounded growth found in kit core; subscription slots recycle; §8 covers capnweb slot hygiene; u32 cycle counters wrap benignly (deltas), `metrics.c` saturates |
| local maximum | **§7** — the main-loop-owns-audio shape |

---

## 6. Exact structure sizes (compile-time, from source)

Per-frame constants: 640 B/frame, 50 fps, 32 KB/s per direction.

| Object | Bytes | Where |
|---|---|---|
| control inbox+outbox storage | 2 × 4 × 1024 = 8192 | `main.cpp:70-75` |
| PCM uplink ring | 4 × 640 = 2560 | `main.cpp:80` |
| PCM downlink ring | 2 × 640 = 1280 | `main.cpp:82` |
| playback frames | 3 × 640 = 1920 | `bounded_playback.hpp:282` |
| capture frame | 640 | `bounded_capture.hpp:73` |
| itx net task stack (static) | 3072 (+ ~700 struct) | `esp_idf_itx_transport.h:38` |
| pcm net task stack (static) | 3072 (+ ~600 struct) | `esp_idf_pcm_transport.h:24,79-81` |
| WS client task stacks (heap, ×2) | 2 × 4096 | client configs (`task_stack`) |
| screen URL scratch | 513 | `main.cpp:30` |
| capnweb arrays (8 calls/8 exp/8 imp/64 tokens/128 out) | ≈ 3–4 KB | `main.cpp:24-28` |
| WS client rx/tx buffers (heap, ×2) | 1024 + 640 | client configs |
| S2-3 proposal (+6 downlink slots) | +3840 | — |

`runtime` total is printed at boot (`static_bytes`); §10 pins the .bss/IRAM
ledger from the map file.

---

## 7. Design question: shared event-driven audio scheduler

**Short answer: yes — but as a per-device audio task with an I2S-driven
frame clock, not as a new abstraction layer. The current shape is a
defensible v1 for the Stick and an impossible base for StackChan; cut the
seam now while it is ~150 lines.**

Today the main loop is the audio scheduler: a 10 ms prio-1 tick that pumps
capture and playback between everything else, with one notification path
grafted on to tighten downlink latency (3b), priorities inverted under it
(S1-3), a zero-margin uplink (S1-4), and log-induced jitter (S2-1). Each of
those has a local patch, but they are four symptoms of one decision:
**audio deadlines share a task with unbounded-latency work** (capnweb
dispatch, display, logging, transport bookkeeping).

StackChan cannot inherit this: full duplex + AEC needs capture and playback
pumped *simultaneously* at 20 ms cadence with the far-end reference aligned
to the near-end frame, plus per-frame DSP (AEC, viseme/energy analysis for
the renderer contract). That work is deadline-bound and belongs on a
dedicated priority; the goal doc explicitly forbids porting StackChan's old
degrading-queue design, and it also warns against preserving a poor local
maximum here.

The judo is that the codebase is *already shaped for this* — the lane is the
cross-task boundary (SPSC, task-safe), the pumps are already platform
functions (`pollCapture`/`pollPlayback`), and the audio controller is
already policy-only. The move:

1. **`audio_task` (per device, shared skeleton, prio ~6, core pinned):**
   blocks on the recorder (M5Unified `record()` completion or raw I2S
   read — the mic *is* the 20 ms clock; no timer needed), then per frame:
   capture → lane submit → notify uplink; drain downlink lane → AEC
   reference alignment (StackChan) → playback submit; run analysers →
   publish renderer-input snapshot. Half-duplex (Stick) is the degenerate
   case: one direction active at a time, same loop.
2. **Main loop keeps** capnweb, transports, button, display, metrics — all
   tick-tolerant; drops `pollPlayback`/`audio_poll`/`downlinkReady`
   entirely (the notification path in 3a moves inside the audio task and
   becomes "block on lane", which the ring already supports via its
   sequence variables — or keep the give/take pair targeted at the audio
   task, unchanged in shape).
3. **Cross-task contracts to define (small):** the audio controller's
   lifecycle calls (`push_to_talk`, `interrupt_playback`) become messages
   into the audio task (one more tiny SPSC or an atomics-guarded command
   word) — or the controller stays on main and only *pump + DSP* move,
   which requires nothing new except making `capture_active` /
   `playback_active` atomics. Start with the latter; it is the smallest
   correct cut.
4. The event queue, metrics, and renderer state stay main-side; the audio
   task publishes into lanes/atomics only. No new allocation, no new
   layer — one new task and a relocation of two existing pump calls.

What this buys immediately, on the Stick: S1-3 and S1-4 disappear
structurally (audio no longer competes with TLS or logging), 3b's extra
main-loop iterations vanish, and the physical-rig latency numbers stop
depending on display/log behavior. What it buys next quarter: StackChan's
AEC has a home, and the "renderer-input data structure" from the goal doc
has a producer with a deterministic cadence.

**Recommendation:** do S1-1/S1-2/S1-5 + the one-line S1-4 re-arm now (they
are transport/lane fixes, independent of scheduling); land the audio task as
its own PR *before* StackChan audio starts, with the host-side proof being
the existing bounded-capture/playback tests re-driven from a separate
pthread at hostile interleavings.

---

## 8. Vendored Cap'n Web C peer (parallel deep-review)

Verdict: the core session library is unusually clean for embedded C — id
spaces correct and monotonic (no ABA), refcounts balance on every traced
path, parser overflow-safe, and the writer genuinely streams (the 128-byte
`outputCapacity` is pure coalescing scratch; proven by the existing
13-byte-scratch/4096-byte-payload test). The dangers live at the
library/transport contract boundary:

### C-S1-1 · Metrics push crosses the 1024-B outbox slot at large counter values — session-fatal, and the clamp guarantees the killing value

The whole-message cap is the transport slot: every fragment of one message
accumulates into a single 1024-B outbox slot; overflow → `E_LIMIT` →
writer converts to `E_TRANSPORT` → `capnweb_session_finish_message`
**terminalizes the session** (`writer.c:13-26`, `session.c:61-84`,
`websocket_text.c:296-305`). The exact serialized metrics push
(`["push",["pipeline",-13,[],[{…}]]]`, 8 root + 24 audio integers):

| counter width | message bytes |
|---|---|
| 1 digit | 521 |
| 6 digits | 661 |
| 10 digits | 773 |
| INT64_MAX (19 digits) | **1025** |

`main.cpp:154-172` deliberately clamps saturated counters to `INT64_MAX` —
i.e. the saturation-protection value is precisely the one that serializes
to 1025 > 1024 and kills the session. Realistic drift: PCM frame counters
reach 10 digits within a year at 50 fps; `uptimeMs` in ~115 days; callback
export ids grow monotonically across resubscribes. Death = full remount
dropping all subscriptions, then the same sample kills the next session:
a reconnect loop. Also blocks `CAPNWEB_REPLY_BYTES` over ~760 raw bytes
(base64 ×4/3) — the camera path can never work through this transport as
configured (compounds S3-3).
**Regression:** `metrics_subscription_test.c` — all-INT64_MAX sample
through a 1024-B-slot outbox fixture; assert session stays OPEN. Fails
today. **Fix:** (a) derive slot size from the metrics schema
(≥2048 + static_assert), or better (b) let the esp transport span one
logical message across multiple slots — it already receives BEGIN/DATA/END
framing and throws that information away; (b) also unblocks bytes replies.

### C-S1-2 · 64-token inbound budget: a normal agent-authored call aborts the session

Token cost ≈ 10 framing + 2/object-field + 1/array-element; 64 tokens ≈ a
~27-field args object or ~50-element array — inside a ~300-byte message the
1024-B inbox slot happily admits (~340 tokens' worth). Inbound args are
authored by *agents* (the product's normal use); one
`leds.set({…, pattern:[…40 ints]})` → parse hits token 65 →
`abort_with_status(TOKEN_LIMIT)` — and abort is the *protocol-correct*
response (push ids are implicit and ordered; an unparseable push cannot be
skipped), so the bug is sizing, not behavior (`session.c:825-829`,
`json.c:37-39`, `main.cpp:27`). An authenticated-but-sloppy peer can hold
the device in a permanent reconnect loop with a 300-byte message.
**Regression:** `itx_connection_test.c` — push with a 60-element int array
in one frame; assert session survives (per-call TypeError fine, abort
not). Fails today; note `session_test.c:469` currently pins the abort and
must be updated with the capacity fix. **Fix:** derive
`tokenCapacity ≥ controlSlotCapacity / 3` (≈342 tokens ≈ 8.2 KB — trivial
on the S3) with a static_assert.

### C-S2-1 · Outbox BEGIN-backpressure is terminal though zero bytes were emitted

Mid-message failure handling is coherent (writer poisons, ring reservation
cancelled, borrowed payloads released — tested). But `start_message`
treats a failed **BEGIN** — nothing on the wire — as the same terminal
`TRANSPORT_FAILED` (`session.c:55-68` vs the doc's own rationale "a
*partially emitted* message cannot be recovered"). Normal operation
produces bursts of exactly ring capacity: mount's `project_completed`
emits release+push+pull inside one receive (+1 prior release) = 4
messages; a 2-subscription metrics tick = 4 (every call is push+pull,
`call.c:101-129`) — against 4 outbox slots drained 4/20 ms. Any
coincidence beyond 4 (a resolve to an inbound pull in the same iteration
as a metrics tick, during one Wi-Fi send stall) tears the session down.
Over days this approaches certainty. In isolation this would present as
"device randomly remounts" — but composed with S1-1, every session-terminal
event latches the transport, so today it presents as a **permanent brick**;
the same composition upgrades C-S1-1 and C-S1-2. Fixing S1-1 downgrades
all three from brick to remount-loop; fixing the capacity cliffs removes
the loop.
**Regression:** vendor `session_test.c` — fixture fails the Nth BEGIN
once; assert session stays OPEN with a retryable error (fails today);
firmware `websocket_text_test.c` — fill the 4-slot ring, attempt a 5th
send, assert non-terminal. **Fix (judo):** BEGIN failure returns a soft
retryable status without terminalizing; metrics poll skips the tick,
responder leaves the reply DEFERRED. Deletes the failure class instead of
tuning ring sizes. (Note `test_transport_failure_is_terminal…` pins only
the DATA case — keep that.)

### C-S2-2 · `set_error` string lifetime undocumented; propagation aliases another slot's pointers

Reply errors store raw `const char*` (`reply.c:113-127`), serialized at
*pull* time and retained until remote release; pipelined error propagation
copies the *pointers* between pending slots (`session.c:515-521`). The
obvious embedded idiom — `snprintf` into a stack buffer +
`reply_set_error` — is a use-after-scope that intermittently serializes
garbage. Every in-tree caller passes literals, so coverage is structurally
blind. **Regression:** dispatch handler formats the message in a local
buffer; pull later; assert text under
`-fsanitize-address-use-after-scope` (fails today). **Fix:** document
"literals only", or better copy into small fixed fields in
`capnweb_pending_call` (also fixes the aliasing).

### C-S2-3 · Vendoring dropped the JS interop suite the README depends on

`vendor/capnweb/README.md:19-30` references
`__tests__/c-interop.test.ts` + a known-failures ledger; neither exists in
the tree, and `tests/native_peer.c` (693 lines) is the stdio peer *for*
that suite — now an orphan with no driver. `session_test.c` only proves
the C peer agrees with itself. Unverified load-bearing interop claims:
does the JS peer send `["release",id,1]` for every resolved promise
import (if not: the 8 pending slots exhaust after 8 pushes — the canonical
slot-exhaustion death)? Does the JS decoder accept the C writer's
**unpadded base64** (`writer.c:194-209`)? Which expression forms does the
JS peer emit (each unsupported one is a terminal abort,
`session.c:473-479,863-871`)? **Fix:** restore the interop suite wired to
`capnweb-native-peer` against the npm `capnweb` package; the goal doc
explicitly requires the compatibility suite to remain runnable.

### C-S3 (condensed)

- **Reentrancy rules exist only as prose** — enforced for `receive`, not
  for the two paths that corrupt: a responder resolved from inside a send
  callback wedges the call permanently (reply committed, `pulled`
  consumed, never re-attempted — `responder.c` `get_deferred_pending`
  should reject `session->sending` before mutating); and
  `capnweb_session_close` from a send callback is a use-after-release of
  the borrowed payload mid-serialization (`session.c:972-999` has no
  guard). Two one-line guards + two ASAN tests.
- **Completion-callback double-signal:** BEGIN-failure inside `call_*`
  fires the just-allocated import's completion via terminalize *and*
  returns non-OK (`call.c:87-104`), while `E_LIMIT` returns non-OK with no
  completion — two contradictory contracts, neither documented. Clear the
  import entry before failure return; rule becomes "non-OK ⇒ completion
  never runs".
- **No outbound pipelining** (`call.c:70` rejects `capability.id > 0`)
  while the inbound side serves pipelined pushes — the one real peer
  asymmetry. Mount pays 3 RTTs where 1 would do and feeds the C-S2-1
  burst. The wire format is identical; allow positive target ids naming a
  live import.
- **Reply-kind logic smeared across ≥4 switches** in the 1010-line
  session.c (`reply_is_publishable`, discard/release, serialization,
  `release_pending`'s capability special-case) — consolidate
  validate/serialize/dispose per kind into reply.c; that is the
  decomposition worth doing (not a mechanical file split).
- Nits (verified): impossible-failure branches mislabeled
  `TRANSPORT_FAILED` (`session.c:640-645,676-685`); redundant `\r\n` strip
  (`:814-816`); `reference_expression_is_well_formed` deletable; O(index)
  `value_array_at` → O(n²) arg loops (fine at 64 tokens, note at 342);
  empty WS text frame aborts the session (ignore it instead); depth-limit
  overflow reported as TOKEN_LIMIT; invalid UTF-8 passes through
  (intermediary hazard); unparsed capabilities inside resolve payloads
  leak remote export entries (document); stale README build paths.

Coverage honesty: `session_test.c` (21 cases) is strong on lifecycle;
`fuzz_session.c` covers memory safety but with output discarded cannot
observe protocol correctness/backpressure/wedges; corpus is 3 seeds.
Nothing covers C-S1-1/C-S2-1 (need a bounded transport fixture), C-S2-2
(all callers use literals), the reentrancy rules, release-count > 1,
import-table exhaustion, or any cross-implementation claim.

## 9. TS voice proxy / pacing / uplink (parallel deep-review)

Deployment reality check first: `/pcm` is served only by
`LocalDevicePeerServer` (`src/device/local-device-peer-server.ts:71-78`), a
Node process behind a captun tunnel; the kit Worker serves nothing
PCM-related. The "userspace Worker proxy" has **no Worker deployment path
yet** — and the current design (per-frame `setTimeout`, in-memory
`#sessions`, control-plane calls into a long-lived process) will need a DO
rework when it gets one. Decide that before the wrangler route appears.

**The pacing question (the review's #1 ask): the proxy does pace.**
`#relayProviderPcm` rings the audio, `#scheduleDownlink` +
`#sendNextDownlinkFrame` (`src/voice/device-pcm-proxy.ts:370-443`) emit one
640-B frame per 20 ms — the device's 2-slot ring is respected on the wire.
The defects are in the backlog behind the pacer and the pacer's arithmetic:

### V-S1 · Any assistant reply over ~2.6 s of audio kills the session

`maximumDownlinkQueuedBytes` defaults to `frameBytes × 128` = 81,920 B =
**2.56 s** of audio (`device-pcm-proxy.ts:149-152`); drain is pinned to
real time by the pacer, provider TTS arrives faster than real time, so a
reply of duration D at g× real-time speed peaks at `D·(1−1/g)` of backlog:
at burst speed anything > 2.56 s **overflows**, and overflow is
`#fail("device-downlink-queue-overflow", 4013)` — both sockets closed
mid-utterance (`:371-374, 476-493`). A single 64 KiB provider delta (the
per-message cap, `:150`) is already 2.05 s of audio; two deltas < 1.5 s
apart die instantly. Nobody has seen it because both e2e scripts prompt
"Reply in one very short sentence", and the unit suite celebrates the
failure as correct with a tiny 2-frame cap
(`device-pcm-proxy.test.ts:318-334`).
**Regression:** default proxy; provider sends 3 × 32,000-B messages
back-to-back; assert no failure and continued frame delivery — fails today
on the third message. **Fix:** size the ring for the longest plausible
reply (60 s = 1.92 MB, trivial in Node/Workers); on true overflow truncate
the *response* (drop remainder + `response.cancel`), never the session.

### V-S2 · Cadence re-anchors to actual send time — systematic slow drift

`#nextDownlinkAt = Date.now() + 20` at each send (`:438`) means every
`setTimeout` lateness ε is permanent: at ε = 1 ms the proxy delivers
47.6 fps against the device's crystal 50 fps — the device's 2-slot ring
underruns every ~20 frames (periodic dropout) and S1 arrives sooner.
**Regression:** fake timers firing 21 ms late; after 50 frames assert send
time within one frame of `t0 + 49×20 ms` (drifts ~49 ms today).
**Fix:** anchored schedule (`#nextDownlinkAt += 20` from a fixed origin),
catch-up bounded to ~2 frames per macrotask.

### V-S2 · 160 ms of provider backpressure kills the session

`maximumBufferedBytes` defaults to 8 frames = 5,120 B (`:149`); one uplink
frame while `bufferedAmount` exceeds it → `#fail` closes everything
(`:310-312`); the same gate blocks `commit`/`create`/`cancel` (`:468-474`).
A routine >160 ms TCP stall to xAI ends the call; a PTT release during the
stall dies too. Hidden in tests because captun's `PairedWebSocket` has no
`bufferedAmount` at all, so the guard silently no-ops on the device lane.
**Fix:** drop mic frames (count them) under backpressure; fail only after
sustained saturation; control messages bypass the audio gate entirely.

### V-S2 · Server-VAD barge-in plays up to 2.56 s of stale audio

Only PTT `inputStarted()` clears the downlink queue (`:270-273`); in
`server-vad` mode (the default in `LocalDevicePeerServer:45`) the
provider's speech-started/cancellation events are forwarded to observers
and trigger **nothing** — after a barge-in the ring keeps draining the old
reply for seconds. This composes with firmware behavior: the Stick discards
downlink while the mic is hot, but the stale tail plays *after release*.
**Regression:** send 64,000 B of audio then
`{"type":"input_audio_buffer.speech_started"}`; assert no further frames
(~97 drain today). **Fix:** clear the queue on the provider's
speech-started/cancelled family — this is also what makes the bigger V-S1
ring safe.

### V-S2 · The reused `#downlinkFrame` buffer is sent by reference

One shared `Uint8Array` (`:204/231`) is zero-filled and overwritten per
frame (`:413`) and handed to `send()` (`:434`); captun's `PairedWebSocket`
delivers **the same object** via `queueMicrotask`. Wire bytes currently
survive only because the tunnel bridge copies in a microtask before the
next macrotask overwrite — scheduling luck, not a contract; any in-process
consumer that retains `event.data` reads the last frame's bytes for every
frame. **Regression:** retain two consecutive frames without copying;
assert frame 1 unchanged after frame 2 (fails today). **Fix:** slice per
send (640 B / 20 ms is nothing).

### V-S2 · `z.strictObject` on the xAI credential response

`GrokClientSecret = strictObject({expires_at, value})`
(`grok-realtime-voice.ts:3-6`): the day xAI adds a response field, every
voice connect fails with "malformed client credential" — an outage caused
by our validator. The proxy's own event schema already does `looseObject`
correctly. **Fix:** validate only what you read.

### V-S3 (condensed)

- **No `session.updated` ack validation** (`grok-realtime-voice.ts:90-123`):
  if the provider ignores the 16 kHz output request, 24 kHz audio plays
  1.5× slow and pitch-shifted and every e2e still prints
  `voice_e2e_passed` (they count frames, never audio properties). Also
  `turn_detection: {type: null}` is an unproven shape (convention is
  `turn_detection: null`); if VAD isn't actually off, unsolicited
  `response.created` with `!inputActive && !responseRequested` falls
  through un-suppressed (`device-pcm-proxy.ts:335-342`). Require + validate
  the ack before going live.
- **Response lifecycle keyed on bare event types, no response id**
  (`:333-352`): a late `response.done` (cancelled old) after
  `response.created` (new) corrupts `#responseActive`/`#downlinkResponseDone`
  and splices zero-padded partial frames mid-utterance (`:394,412-430`).
  Track `response.id`.
- **Credential mint has no timeout** (`grok-realtime-voice.ts:53-64`): a
  black-holed HTTPS POST to api.x.ai wedges the device `/pcm` upgrade
  forever; `connectTimeoutMs` covers only the WS handshake. Add
  `AbortSignal.timeout`.
- **`inputMode` ↔ `turnDetection` coupled by convention**: call sites must
  remember to pair `pcmInputMode: "push-to-talk"` with
  `turnDetection: "manual"`; derive one from the other at a single point.
- **PCM constants not single-sourced**: `640`/`20 ms`/subprotocol literals
  duplicated across 5 TS files and the C header;
  `firmware-architecture.test.ts:100` pins a *third re-typed literal*
  instead of importing the TS constant, so drift isn't caught. Export one
  `ITERATE_KIT_PCM_V1` object; assert the C header against it.

### V-S4 nits

Non-constant-time bearer compare (`local-device-peer.ts:240-248` — repo
precedent is constant-time); dead `!descriptor` check
(`device-pcm-proxy.ts:114-118`); zero-length provider binary kills the
session instead of being ignored; no `input_audio_buffer.clear` on
`inputStarted`; wall-clock-brittle pacing unit test
(`device-pcm-proxy.test.ts:295-316` — use fake timers); e2e logs raw
provider transcripts into CI logs.

Untested load-bearing code: the downlink ring wrap seam
(`device-pcm-proxy.ts:380-382, 425-430` — hand-verified correct, never
executed by any test), odd-length deltas, >64 KiB deltas. The live e2e
asserts "≥1 frame + response.done" and closes while the queue drains —
it proves transport, not audio.

## 10. Measured RAM / CPU / IRAM ledger (parallel measurement)

**Build provenance first:** there are two builds in the tree and
`apps/kit/.build/m5sticks3/` is **stale** (predates the `Runtime` struct;
zero Wi-Fi objects linked; 459 KB bin). The current build is
`firmware/targets/m5sticks3/build/` (IDF 5.4.2, -Os, 160 MHz, octal
PSRAM): **1,136,416 B bin = 54.19 % of the 2 MB factory partition,
960,736 B headroom** (partitions.csv: nvs/phy/factory 0x200000/iterate_kit
0x1000; no OTA slots — an A/B scheme at this size still fits the 8 MB
flash). Delete or ignore the stale `.build` tree — it also hosts the stale
ctest views from §11.

### The "one-byte IRAM margin" — verified, and it is a misreading

`esp_idf_size` prints `Used static IRAM: 16383 bytes (1 remain, 100.0 %
used)` for **both** builds, byte-identically. Anatomy (current map):
`.iram0.vectors` = 1,027 B at 0x40374000; `.iram0.text` is 4-byte aligned
so it starts at 0x40374404 — the **1 byte at 0x40374403 is a permanent
alignment gap** after the vector table. The tool's "static IRAM" is only
the 16 KiB I-bus-only window [0x40374000, 0x40378000), which is always
full because total IRAM code (96,000 B) long ago overflowed into the
D/IRAM-shared region. The byte was "1 remain" before Wi-Fi was linked and
is "1 remain" after +30 KB of Wi-Fi IRAM. It cannot be spent and nothing
is about to overflow: the linker's real IRAM assert has **262,144 B of
slack** (96,000 used of 358,144, map L103672). **Nobody is one byte from
anything.**

The actually binding resource on the S3 is the **shared D/IRAM pool**:
every IRAM byte above the 16 KiB window costs one DRAM byte
(`.dram0.dummy` = 79,616 B mirrors it). Pool usage: IRAM-over-window
79,616 + .data 20,428 + .bss 47,368 = **147,416 B used, 194,344 B free**
(43.1 %). "IRAM savings" are DRAM-heap savings, byte for byte.

### Region table (current map, authoritative)

| Region | Length | Used | Free |
|---|---|---|---|
| iram0_0_seg | 358,144 | 96,000 | 262,144 (aliased w/ dram) |
| dram0_0_seg | 341,760 | 147,416 | **194,344** |
| flash text | 8,388,576 | 784,628 | — |
| flash rodata | — | 235,108 real | — |
| rtc fast/slow | 8,168/8,192 | 28/0 | — |

Runtime heap adds the ROM-reserved tail (~84 KB) + unused dcache (32 KB)
≈ ~310 KB internal before task/driver allocations, plus 8 MB PSRAM
(`SPIRAM_USE_MALLOC=y`, <16 KB allocations forced internal).

### `runtime` global: 26,992 B exact (DWARF-verified)

Largest single DRAM object (57 % of app .bss). Members: itx transport
3,816 (embeds 3,072 static stack) · PCM transport 3,952 (3,072 stack +
258 auth headers) · control ring storage 8,192 · PCM rings 3,840 ·
platform 2,672 (2,560 of it audio frames — matches the host
resource-profile output exactly) · tokens 64×24 = 1,536 · configuration
421 · scratches 641 · capnweb tables/rings ~1,922. App static total
(main + core + capnweb + platforms) = **27,001 B RAM, 29,119 B flash** —
the ESP-IDF system (Wi-Fi ~36 KB, freertos 19 KB, hal 16 KB…) dwarfs it,
which is the right shape.

### CPU / copies at full audio

Wakeups: main 100/s + two net tasks 50/s each + per-frame notifies
(≤50/s each direction) ≈ **≤300/s** for the instrumented tasks. App-level
memcpy at full duplex-equivalent: **3 copies × 640 B × 50/s = 96,000 B/s**
— mic→uplink-ring, WS-rx→downlink-ring, downlink-ring→playback buffer;
the uplink ring→WS send is already **zero-copy at app level**
(`send_uplink` passes the ring slot pointer to
`esp_websocket_client_send_bin`; the client's internal mask/copy still
moves ~32 KB/s). Total incl. library/driver copies ≈ 190–220 KB/s —
<0.1 % of 160 MHz; the per-task cycle metrics already exist to confirm
on-device. The one avoidable app copy: record directly into a
write-acquired uplink slot (holds a producer slot for the 20 ms record
window; 4-slot ring makes it feasible) — worth doing only as part of the
§7 audio-task move, not before. The playback staging copy is deliberate
and not safely removable (M5Unified retains `playRaw` pointers).

### Ranked D/IRAM (= internal heap) saving opportunities

| # | Change | Saves (measured) | Risk |
|---|---|---|---|
| 1 | `FREERTOS_PLACE_FUNCTIONS_INTO_FLASH=y` | up to 15,260 | low-med (slightly slower scheduler paths) |
| 2 | `ESP_WIFI_RX_IRAM_OPT=n` | **9,628 exact** | low here — costs Wi-Fi RX throughput headroom; PCM needs 32 KB/s |
| 3 | `ESP_WIFI_IRAM_OPT=n` | **7,087 exact** | low-med; test latency under load |
| 4 | `HEAP_PLACE_FUNCTION_INTO_FLASH=y` | 5,881 | low |
| 5 | `SPI_FLASH_ROM_IMPL=y` | ~7–10 K | med-high; validate against this flash+PSRAM combo |

Combined realistic: **~35–45 KB more internal heap** (+~20 % over today's
194 KB free). Not recommended: `SPI_MASTER_ISR_IN_IRAM=n` (display DMA
glitches during flash writes). DRAM-side there is no waste to reclaim —
everything big inside `runtime` is deliberate bounded storage; the soft
knobs (control slots, task stacks) are behavior contracts, not fat.

Host resource profiles: `iterate-stackchan-resource-profile` runs and its
numbers cross-check DWARF (platform 2,672 B; ~600 ns/servo RPC on the
host; protocol working set 4,112 B). Gap: `vendor/capnweb/tools/
resource_profile.c` is **not built** in the host tree — wire it into
CMake so the vendored library's own working-set numbers stay measured.

## 11. Test-honesty audit + missing regressions (parallel audit)

**Headline:** the portable core is genuinely well tested (at times
byte-exact), but the two files where the real-world hazards live —
`itx_transport.c` (1042 lines) and `pcm_transport.c` (677) — are compiled
into **zero host tests**, as is `m5unified.cpp` (the half-duplex speaker
gate). The fake-header pattern that would make them testable already exists
(`tests/fakes/esp_partition.h`, used by the esp-idf configuration test) and
was simply never extended to `esp_websocket_client`/FreeRTOS. Every host
test also runs at capacities that differ from production: main.cpp ships
`tokenCapacity=64`, `outputCapacity=128`; **every** fixture tests at 128
tokens (itx_connection_test.c:11, itx_mount_test.c:10,
m5sticks3_events_test.c:26, metrics_subscription_test.c:11; simulator
256/128). Nobody has proven the production device can parse its own mount
handshake within 64 tokens.

Per-hazard verdicts (details and exact line cites in the audit itself):

| Hazard | Verdict |
|---|---|
| Fragmented downlink → latch | lane rejection tested (`pcm_lane_test.c:129-179`); the **permanent latch and non-recovery are uncovered and undocumented** |
| SPSC cross-core | real pthread stress exists (`spsc_ring_test.c:122-182`); **two-consumer outbox discard race uncovered; no TSAN config at all** |
| PTT half-duplex edges | press-during-playback order "stop,flush,interrupt,capture" well covered (`audio_controller_test.c:161-218`); **uncovered: release with frame in flight (a lost completion wedges capture forever — `audio.c:113-116` gates poll on `capture_frame_in_flight`, nothing clears it on stop; deleted entirely by the §3c judo), button bounce bursts, remote playback racing held PTT (the real defense in `m5unified.cpp:107-112` is compiled into no test)** |
| Overflow paths | event-queue overflow covered at unit level; **uncovered: publish-after-drain (queue-not-wedged), remote pushToTalk overflow as reply-error-not-session-death, token/output budgets at production sizes, inbox-overflow survivability** |
| Long-session drift | **uncovered** — no soak test loops mount/subscribe/reconnect asserting slot arrays end empty; generation-saturation guard untested |
| Reconnect | connection-layer generation bump + re-auth covered (`itx_connection_test.c:174-222`); **transport-level choreography (outbox drain-before-reset, generation convergence, wake-loss deadlock shape at `itx_transport.c:805-847`) uncovered** |
| Simulator e2e | real capnweb RpcSession over stdio against the C binary — genuine dispatch, C→TS callbacks, overflow-with-session-survival, golden config image; **no WebSocket, no mount chain, no PCM lane/rings, no reconnect** |

Tautological/mocking-the-subject: `esp_idf_websocket_policy_test.c` asserts
constants against bounds; `spsc_ring_test.c:56,68` asserts internal storage
addresses; the e2e PTT "audio" path mocks `sendPcm` — the production lane
path (`main.cpp:118-145`) is absent from the only end-to-end lane.

Wiring: all 19 tests are correctly registered in the canonical
`.build/host` tree; **stale shadow build dirs** (`firmware/build-host/` — 17
tests; `.build/architecture-red/` — 1 test) silently under-run the suite if
ctest is invoked there; delete/ignore them, and extend
`firmware-architecture.test.ts` to assert every `tests/*_test.*` has an
`add_test`.

**Ranked missing regressions** (1–2 are specs against the S1 bugs and must
fail today):
1. PCM transport recovers after a fragmented frame (new fake-client
   harness; asserts restart-after-latch or reassembly — fails today).
2. Outbox discard is single-consumer (two-thread discard + TSAN build —
   races today; production fix: drop `itx_transport.c:785`).
3. Inbox overflow survivable (5th message into 4-slot inbox → count +
   re-open, not FAILED-forever).
4. Production budgets carry the full handshake (64 tokens/128 out/8 slots
   replay of mount + subscribe + reconnect; negative: 70-token message →
   clean E_LIMIT abort).
5. Lost uplink completion cannot wedge the mic (press → submit → release
   without completing → press again → capture must resume; moot if the
   completion protocol is deleted per §3c — then this becomes its
   deletion-proof).
6. Speaker never plays while PTT held (host-compile the m5unified gate or
   extract it; mic-active pump discards, release resumes).
7. Bounce burst + overflow leaves queue usable (4 events one poll;
   9th publish backpressures; subsequent publish succeeds).
8. Remote pushToTalk overflow → "hardware is busy" reply, session healthy.
9. Reconnect discards stale outbound before gen N+1 opens (asserts
   `authenticate` is the first gen-2 text; no gen-1 bytes on gen-2 socket).
10. Soak: 100 reconnect cycles, byte-identical steady-state cycles, all
    capnweb slot arrays empty at the end.
11. E2e session end/rebirth over the wire (subscription stops firing; fresh
    subscribe works).
12. Meta-test: every `tests/*_test.*` file is wired into CMake.

---

## 12. Priority order (what to do, in order)

Firmware:
1. **S1-1** delete the protocol latch; retry with backoff (+ regressions
   §11 #1/#3/#4).
2. **S1-2** bounded downlink reassembly into the ring slot (+ regression).
3. **S1-5** single-consumer ownership of the control outbox (+ TSAN stress
   test §11 #2).
4. **S1-4** same-pump re-arm in `BoundedCapture` (+ throughput regression);
   **§3c** delete the capture completion protocol (also closes §11 #5).
5. **S1-3** priority/pinning corrections (rig-verified).
6. **S2-1** deferred-diagnostics ring; dedupe device-poll log.
7. **S2-2** send-failure hysteresis before restart.
8. **C-S1-1** outbox slot ≥ worst-case metrics push (or multi-slot
   messages) + all-INT64_MAX regression; **C-S1-2** token budget derived
   from slot size (§11 #4); **C-S2-1** BEGIN-backpressure made retryable;
   **S2-3** ring depth rebalance.
8b. **C-S2-3** restore the JS interop suite (goal doc requires it);
    **C-S2-2** error-string lifetime (document or copy).

Voice proxy (independent, can land in parallel):
9. **V-S1** downlink queue sized for real replies + response-scoped
   truncation; **V-S2** VAD barge-in flush (they compose).
10. **V-S2** anchored pacing; backpressure = drop-not-die; per-send copy;
    `looseObject` credential parse; mint timeout.

Structure (before StackChan audio starts):
11. **§7** audio task extraction.
12. **S3-1** ws-worker/wifi-link extraction (folds S1-1/S2-2 into one
    place); host-test harness for the extracted worker (§11 fake-client
    pattern).
13. **S3-2/S3-3/S3-4** metrics table-builder, photo capability decision,
    display-gate discipline; single-source PCM constants across TS/C
    (§9 V-S3).

Hygiene (cheap, any time): delete/ignore the stale `apps/kit/.build/` and
`firmware/build-host/` trees (§10 provenance, §11 wiring — both currently
mislead tools and ctest); build `vendor/capnweb/tools/resource_profile.c`
in the host tree (§10); add the §11 #12 meta-test. Explicitly **not**
worth doing: any IRAM-motivated code contortion (§10 — the one-byte margin
is a reporting artifact).
