# Tiny production-grade C WebSocket clients — research memo (2026-07-30)

Status: independent Fable max-effort research pass, per
`docs/physical-device-voice-goal.md` § Review discipline. Question: should
`espressif/esp_websocket_client` 1.8.0 remain Iterate Kit's ESP32 transport,
be wrapped/patched, or be replaced — and if replaced, with which prior art?
No implementation code was modified. All library findings come from reading
actual upstream source in Go-style checkouts under
`~/src/github.com/<org>/<repo>` (commits pinned in §10), the exact vendored
component, and the real m5sticks3 linker map — not package artifacts or
marketing pages. §8.1–8.5 review the uncommitted `apps/kit` state as of
~09:25 on 2026-07-30 (portable pieces: `websocket_frame_writer.c`,
`websocket_tx.c`, the `PROGRESS` sender outcome, PCM lane chunk
reassembly); §8.6 is a same-day second pass over the now-compiling
single-owner worker (`websocket_connection.c` + rewritten
`pcm_transport.c`, ~09:30 tree).

## 0. Executive summary

**Replacement is justified, and no existing library should be adopted
wholesale.** The evidence supports exactly the design now in flight: a
single-owner worker per socket that keeps ESP-IDF's `esp_transport_ws` for
the handshake and receive path, and drives a firmware-owned, host-tested,
allocation-free RFC 6455 transmit state machine (`websocket_tx` +
`websocket_frame_writer`) directly over the retained TLS transport — no
`esp_websocket_client`, no esp_event loop, no client task, no shared
mutexes.

Why not keep the incumbent: 1.8.0 is the current upstream tip (no fixes to
adopt), and its pain is architectural, not configurational — a reader that
holds a lock for up to 10 s mid-frame, its own PING/PONG writes budgeted at
10 s against the same tx lock the audio sender needs, a tick-vs-ms units bug
that makes the 250 ms tx-lock timeout 2.5 s, per-received-frame heap churn
inside esp_event, a partial-write recovery that corrupts the WebSocket
stream, and — in the kit's `SEPARATE_TX_LOCK` build — concurrent
`mbedtls_ssl_read`/`ssl_write` on one TLS context, outside mbedTLS's
documented contract (§2).

Why not any of the surveyed libraries: every serious candidate fails at
least one hard constraint — license (Mongoose GPLv2-dual, noPoll LGPL),
architecture (lws's event-loop ownership + malloc-on-backpressure, CivetWeb
thread-per-connection), allocation model (wslay_event's malloc per message),
platform (libuwsc/libws are libev/Linux), or maintenance (WIC dead 4 years
with zero unit tests; the once-popular libwsclient's GitHub namespace was
hijacked and deleted) (§4). What the survey _does_ supply is proven design
patterns for the bespoke worker — Zephyr's incremental parser and
deferred-unmask arithmetic, curl's single-slot pending-control-frame and
recv-meta contract, coreMQTT's transport interface and idle-driven
keepalive, wslay_frame's want-read/want-write surfacing — all cited in §4.4
and already visibly reflected in the landed `websocket_tx` design.

Net cost of the replacement: ≈ **−7 to −11 KB flash, −7 to −8 KB heap per
socket plus removal of 50 alloc/free per second**, one fewer priority-5 task
per socket, and structural elimination of thermo-review items S2-2 (lock
contention) and the S2-1 client-log hazard (§8.4). The remaining risk is
concentrated in eleven correctness traps in the esp worker — most
importantly the blocking-mode tension in `esp_transport_ws`'s read path
(T1) — each listed in §8.3 with the smallest failing test that should exist
before the code.

**Second pass, same day (~10:00): the worker now exists and compiles**
(`websocket_connection.c` + rewritten `pcm_transport.c`, PCM socket only).
§8.6 reviews it line-by-line against real IDF transport source. Headline:
the architecture landed correctly — single owner, resumable writer over the
parent TLS handle, `O_NONBLOCK` + `TCP_NODELAY`, control frames at frame
boundaries, **and the S1-1 protocol latch is deleted** (T10 resolved). Two
new S1 defects come from the interaction between full-nonblocking reads and
`esp_transport_ws`'s stall handling: a mid-frame zero-byte read makes the
IDF transport **destroy its own frame bookkeeping** (`bytes_remaining = 0`)
and the kit then restarts the socket — reachable on every frame whose
header and payload records split across a poll boundary (Node's `ws`
library writes them as two TLS records by construction); and the
deferral-restart threshold, written for 250 ms blocking sends, now counts
10 ms nonblocking probes — the socket restarts after **~40 ms** of routine
TCP backpressure (Wi-Fi power-save stalls exceed this daily). Both have
small fixes (§8.6 N-S1-1/N-S1-2).

## 1. Requirements the transport must satisfy

From `docs/physical-device-voice-goal.md`:

- Two independent wss clients: control (Cap'n Web text, ≤1024-B messages)
  and PCM (640-B binary frames at 50/s each direction, protocol v1 fixed).
- Audio is the highest-priority realtime work; the transport must never sit
  on the audio-critical path, and a complete frame must be offered to the
  socket immediately — any batching is a named policy.
- Every queue bounded and metered; overload has an explicit policy and can
  never become accumulated latency.
- Reconnect is an ongoing, metered process, not a tombstone.
- Delay metrics at every observable ownership boundary, including "device
  socket send" — the transport must expose an honest definition of "sent".
- Allocation-free portable C core, host-testable; ESP-IDF at the edge only;
  ESPHome / HA Voice PE / Waveshare reuse must stay possible.
- Minimal RAM/CPU as measured acceptance properties.

From `docs/thermo-review-2026-07-30.md` (transport-relevant):

- S1-1 protocol-failure latch must become retry-with-backoff.
- S1-2 PCM downlink fragmentation must reassemble into the ring slot.
- S1-3 the two client-internal tasks (prio 5, unpinned) invert the realtime
  hierarchy; TLS handshakes starve audio.
- S2-1(3) `esp_websocket_client` ESP_LOG on error paths runs on prio-5
  tasks; a wedged console turns backpressure into send timeouts.
- S2-2 send/read lock contention escalates transient stalls into restarts
  (half-addressed since: the PCM uplink got the transient-send-deferral
  policy; the control lane still restarts on the first short send,
  `itx_transport.c` `send_control_messages`).
- S3-1 extract one shared ESP websocket worker; both transports duplicate
  ~600 lines.
- §10 resource ledger: no IRAM emergency; D/IRAM pool 194,344 B free; flash
  at 54.19 % of the 2 MB factory partition. Resource pressure is _not_ a
  reason to accept complexity, and modest code growth for correctness is
  affordable.

## 2. Incumbent audit — `esp_websocket_client` 1.8.0

Sources: vendored copy
`firmware/targets/m5sticks3/managed_components/espressif__esp_websocket_client/`
(byte-identical to upstream tag `websocket-v1.8.0`), upstream
`espressif/esp-protocols` @ `314b192`, linker map
`firmware/targets/m5sticks3/build/iterate-kit-m5sticks3.map`. Line numbers
are `esp_websocket_client.c` unless noted.

**Version reality.** `git log websocket-v1.8.0..HEAD --
components/esp_websocket_client` is empty: 1.8.0 (tagged 2026-07-22) _is_
upstream HEAD. There is no newer upstream code to adopt, and none of the
issues below has an upstream fix.

**Task and locks.** The kit build sets `ESP_WS_CLIENT_SEPARATE_TX_LOCK=y`,
so there are two recursive mutexes. The client task loop takes
`client->lock`, runs its state machine, releases, then
`esp_transport_poll_read(transport, 1000)`; when readable it retakes the
lock and calls `recv` (:1372–1392). `recv` loops `esp_transport_read(...,
network_timeout_ms)` — the firmware passes **10 000 ms** — under
`client->lock`; a frame torn across TCP segments costs one 10 s-capped wait
per gap, all while holding the lock, and each chunk _synchronously
dispatches_ `WEBSOCKET_EVENT_DATA` under that lock (:1108, handlers run on
the ws task). Data sends contend only on `tx_lock` in this build, but:

- **Units bug (open upstream #1090):** `WEBSOCKET_TX_LOCK_TIMEOUT_MS` (250)
  is passed as **ticks** to `xSemaphoreTakeRecursive` (:1121, :1290,
  :1343). At `CONFIG_FREERTOS_HZ=100` the "250 ms" control-frame lock wait
  is really **2.5 s**.
- The client's own PING (:1306), PONG answer (:1141), and CLOSE echo
  (:1359) each hold `tx_lock` with a **10 s** write budget
  (`network_timeout_ms`), so during TCP backpressure the audio sender's
  250 ms `send_bin` times out against its own client's keepalive — this is
  the dominant _transient_ deferral source, and it writes zero caller
  bytes, which is what makes the kit's whole-frame retry safe today.
- If instead the transport-level `poll_write` inside `_ws_write` times out,
  the client takes `client->lock` with `portMAX_DELAY` (convoying behind a
  potentially 10 s reader), heap-allocates and logs an error message,
  dispatches `WEBSOCKET_EVENT_ERROR`, and **aborts the whole connection**
  (:742–768) — open issue #942 complains about exactly this.
- **Partial-write corruption:** if the payload write returns short (>0),
  the send loop wraps the _remainder_ in a **new continuation-frame
  header** (:731–772, opcode zeroed at :770) even though the original
  frame header already declared the full length — permanent framing desync
  (issue family #687/#680/#882). The corruption happens inside one
  `send_bin` call; no caller policy can observe or prevent it.
- **PONG-timeout abort:** a sender pinning `tx_lock` for >2.5 s when a
  server PING arrives makes the PONG lock take fail → `ESP_FAIL` → treated
  as a recv error → `abort_connection` (:1121–1126 → :1388–1391).
- **mbedTLS contract violation:** in this build the reader's
  `mbedtls_ssl_read` (under `client->lock`) runs concurrently with a
  sender's `mbedtls_ssl_write` (under `tx_lock`) **on one
  `mbedtls_ssl_context`** — outside mbedTLS's documented thread contract.
  It survives only because static in/out buffers are disjoint; with
  `MBEDTLS_DYNAMIC_BUFFER` it crashes. Upstream #1111 was closed after
  analyzing only the single-lock build.

**Allocation.** Steady state is _not_ allocation-free: every received frame
costs one ~56-B `calloc`+`memcpy`+`free` inside `esp_event_post_to`
(esp_event.c:926–935) — 50 alloc/free per second on the PCM downlink alone,
plus a `malloc`'d formatted error message on every transport error. Every
send memcpy's into the shared 1024-B `tx_buffer` (:738) because the
underlying transport masks in place. Each stop/start cycle (the kit's
reconnect) frees and recreates the 4096-B task stack + TCB, the transport
list, the 1024-B upgrade buffer, and the ~22–25 KB TLS session (upstream
#1104 reports SRAM leaks on reconnection).

**Logging.** Healthy steady state logs nothing (LOGD compiled out), but the
degraded paths log per occurrence _from the sender task_: the deferral case
fires `ESP_LOGE "Could not lock ws-client within %u timeout"` (:716) every
250 ms during a stall, and `transport_ssl.c:226` adds an `ESP_LOGW` per
transport-level send timeout — a direct S2-1 audio-jitter amplifier on a
wedged console.

**Cost (measured from the map).** `libespressif__esp_websocket_client.a`
= **11,834 B** flash (8,499 text + 3,335 rodata); `libtcp_transport.a`
= 11,455 B (transport_ws 6,904, transport_ssl 3,147, core 1,404) — the
latter stays either way. Runtime heap per connected socket ≈ 30–33 KB
(≈22–25 KB TLS, 4 KB task stack + TCB, client buffers, 1 KB upgrade
buffer), ≈ 60–65 KB for both sockets, plus the per-frame event churn.

**What is patchable vs intrinsic.** Local patches could fix the tick-units
bug (one line), rate-limit the deferral log, shrink `network_timeout_ms` to
2–3 s (bounds reader holds _and_ control-write budgets ~4×), effectively
disable the client PING, and convert the write-timeout abort into a
returnable error (#942). Not patchable without forking: per-event heap
dispatch, event-handlers-under-lock, the memcpy per send, the
CONT-desync send loop, the task-per-start lifecycle, and the two-lock
TLS-concurrency model. The wrap-and-patch path therefore has a real but
low ceiling.

## 3. The foundation beneath — `esp_transport_ws` + `esp-tls`

Source: `espressif/esp-idf` checkout v5.5.3 (`2c211b23`); the only
functional `transport_ws.c` delta vs the firmware's 5.4.2 is HTTP-redirect
support, irrelevant here. Everything below is reachable public API on
5.4.2, and this layer is **already linked** under the incumbent.

- **Handshake:** `esp_transport_ws_set_config` carries path, subprotocol,
  pre-formatted custom header lines, and auth — exactly what the kit
  builds today into a bounded stack buffer. `Sec-WebSocket-Accept` is
  SHA-1-verified (transport_ws.c:327–351). Bytes over-read past the 101
  (piggybacked first frames) are retained and served to later reads
  (:353–367). Gap: ≤5.5.3 `ws_poll_read` is blind to that spillover buffer
  (fixed on master by `9feedcbf`, 2026-02-18) — a worker must drain-read
  once after connect. `Sec-WebSocket-Protocol` echo is never verified —
  parity with the incumbent, acceptable against our own server.
- **Read model:** one `esp_transport_read` returns a _chunk with
  bookkeeping_: header parsed when the previous frame is exhausted, then a
  single parent read of `min(len, bytes_remaining)` into the **caller's
  buffer**; accessors `esp_transport_ws_get_read_payload_len` /
  `_get_read_opcode` / `_get_fin_flag`; the caller accumulates the offset.
  This is precisely the `(opcode, fin, payload_len, offset, chunk)` event
  shape the kit's host-tested reassemblers already consume — and because
  the destination buffer is caller-supplied, the worker can read PCM
  payload bytes **directly into the acquired ring slot**, deleting today's
  rx_buffer→ring memcpy.
- **Control frames:** with `propagate_control_frames=true` (what the
  incumbent itself sets) they surface to the caller and the read path is
  strictly allocation-free; the auto-handling mode mallocs per control
  frame and returns 0 indistinguishably from a timeout. A worker should
  use propagate=true and own PING/PONG/CLOSE policy.
- **Send path:** stack-built 16-B header, then the payload is
  **XOR-masked in place in the caller's buffer** and XOR-restored after
  (:415–436) — zero copy, zero allocation, but two parent writes per frame
  (header, payload) = two TLS records, and **nothing in the stack ever
  sets `TCP_NODELAY`** (zero grep hits across tcp_transport, esp-tls, and
  the client). A worker that pre-assembles header+masked payload in its
  own storage and writes once through the _parent_ (TLS) handle avoids the
  two-record split, the in-place scribble, and the Nagle interaction — the
  landed `websocket_frame_writer` is exactly this.
- **Partial writes:** the payload write can return short after the header
  has already declared the full length (esp_mbedtls_write short-exits on
  `WANT_READ/WRITE`, esp_tls_mbedtls.c:422–453); the transport keeps no
  resume state — the only correct recovery is pushing the remaining raw
  bytes on the parent handle. This is the incumbent's CONT-desync bug and
  the exact hole the resumable frame writer closes.
- **Blocking model:** all verbs are select-bounded per call, but the
  socket stays _blocking_ with `SO_RCVTIMEO`/`SO_SNDTIMEO` fixed at
  connect time from the connect timeout (esp_tls.c:275–292). The ws handle
  has no `connect_async`; true nonblocking requires an off-label
  `fcntl(O_NONBLOCK)` or post-connect `setsockopt` timeout surgery via
  `esp_transport_get_socket` — the central trap for the proposed worker
  (T1, §8.3). DNS (`getaddrinfo`) is unbounded by any timeout.
- **Thread contract:** zero locks anywhere in tcp_transport; single caller
  per socket is the intended model (the incumbent's two mutexes exist only
  to serve its multi-writer API). One worker task per socket needs no
  locking at all — and stays inside mbedTLS's documented contract.
- **Quality:** transport_ws has real host tests (catch2/CMock, including
  byte-by-byte fragmented reads). But ≤5.5.3 performs none of the 2026
  RFC-validation batch fixed after v5.5.3 on master (`85da1a05`,
  `1ac71105`, `7f2006b3`, `5eff7a17`: RSV bits, reserved opcodes,
  fragmented/oversized control frames; `d22d5e83`: 64-bit length into
  `int`), and its frame parser needed several 2024 rounds
  (`53e63eb1` mem-corruption and friends) to stabilize. The kit's own
  ingress validation (already the plan) neutralizes most of that exposure.
- **Bonus:** `CONFIG_ESP_TLS_CLIENT_SESSION_TICKETS` enables TLS session
  resumption — worth enabling for a reconnect-heavy voice device.

**Conclusion:** everything a thin client needs exists here; what
`esp_websocket_client` adds on top (task, two locks, esp_event dispatch,
tx memcpy path, 1 s poll cadence, abort-on-timeout policy, broken partial
sends) is precisely what the kit doesn't want. A ~250–350-line worker plus
the already-landed portable modules replaces the 1,712-line client.

## 4. Candidate survey

### 4.1 wslay — the one adoptable codec (as a reference or vendored frame layer)

`tatsuhiro-t/wslay` @ `0e7d106` (v1.1.1, MIT, last commit 2022-08-25).
Two layers, no I/O, no threads, no locks anywhere:

- **`wslay_frame`** (438 LOC): a pure incremental codec with
  `WANT_READ/WANT_WRITE` resume at any byte boundary, per-frame
  `genmask` callback, control-frame ≤125/FIN enforcement, and a
  callback-free `wslay_frame_write` that serializes header+payload into a
  caller buffer with masking fused into the copy (frame.c:271–274). One
  malloc at init — or zero if vendored with the 13-line init replicated
  into static storage. ~2.6 KB flash. This is the cleanest standalone
  WS codec found anywhere in this survey.
- **`wslay_event`** (1,082 LOC): session layer with auto-PONG, close FSM,
  UTF-8 DFA, RSV policing — but **malloc(48+len)+memcpy+free per queued
  outbound message** (event.c:191,202,803), ≥2 mallocs + 2 copies per
  received message in default mode (zero-heap RX exists via
  `no_buffering`), and an **unbounded send queue** with no backpressure
  signal. At 50 frames/s this violates the allocation-free steady state on
  TX; acceptable at control-socket rates only.

Quality: 2,065 LOC of CUnit tests (1-byte-at-a-time delivery, interleaved
control frames, non-minimal length-encoding rejection, close FSM,
no_buffering), CI with ASan+UBSan, Autobahn-exercised via examples.
Handshake, keepalive initiation, timeouts, and queue bounding are all
embedder responsibilities. Four years idle against a protocol frozen since
2011 with zero dependencies — bit-rot surface is essentially nil, but the
correct consumption mode is _vendor and own the 4 .c files_, not a live
dependency. Verdict: **do not adopt wslay_event; use wslay_frame as the
canonical cross-reference** (or vendored codec) for the firmware's own
writer/parser — its want-read/want-write shape is exactly the landed
`websocket_frame_writer` contract.

### 4.2 libwebsockets — reject for this device, keep as a correctness reference

`warmcat/libwebsockets` @ `5a86bc7` (2026-07-29, actively maintained; MIT
core, the mbedTLS wrapper — which this build would use — is Apache-2.0).

- **Ownership inverted:** lws is a serialized single-threaded event loop,
  explicitly not thread-safe (`README.coding.md:144-153`); `lws_service`
  owns a blocking select with sul-timer-derived sleeps and cannot be
  pumped non-blockingly from a loop the firmware owns. The sanctioned
  cross-thread wake, `lws_cancel_service`, is emulated on FreeRTOS/lwip
  with a **pair of UDP loopback sockets** (freertos-pipe.c:41-48) — every
  20 ms audio-frame handoff would cost a UDP self-datagram plus a
  WRITEABLE-callback round trip.
- **Buffer contract:** every `lws_write` buffer needs `LWS_PRE` (16 B on
  ESP32) of valid headroom — contaminating the 640-B ring-slot layout or
  forcing a copy per frame; writes are legal only inside WRITEABLE
  callbacks.
- **Not allocation-free under backpressure:** a partial send heap-allocates
  a buflist segment per stalled frame (core-net/output.c:66,195-198 →
  buflist.c:70) — the guarantee breaks exactly when a voice device is most
  sensitive, and lws buffers instead of exposing a bounded-drop policy.
- **Footprint:** realistic client compile surface ~50–75k lines
  (core-net 23,313 + roles/http 23,098 pulled in by the h1 upgrade +
  roles/ws 6,195 + tls glue), honest flash estimate **~100–200 KB** vs the
  incumbent's ~23 KB total.
- **FreeRTOS plat state:** the 1.6k-line core plat is clean, but the
  packaging is IDF-3.x era (legacy `component.mk` depending on the removed
  `openssl` component; `tcpip_adapter_dhcpc_stop()` — deleted in IDF 5 —
  in the driver layer; no `idf_component.yml`; 2017-era esp32 README). An
  IDF 5.4.2 port would be owned by us.

Strengths worth keeping on the shelf: Autobahn-exercised framing, correct
fragmentation/close handling, auto-pong staged to frame boundaries, and
timestamped validity pings with hangup detection — a good semantic
reference for the worker's keepalive policy.

### 4.3 Disqualified with evidence

| Library                             | HEAD                          | License check                                                                | Fatal problems (cites in checkout)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mongoose** (`cesanta/mongoose`)   | `03be168`, 2026-07-29, active | `LICENSE:5-16` — GPLv2 **or paid commercial**; no permissive option          | License alone disqualifies static linking into closed firmware. Also: TX iobuf is uncapped (audio grows it 32 KB/s during a stall) with calloc+copy+zeroize churn at 512-B boundary crossings (iobuf.c:19-54); RX cap closes the connection rather than backpressuring; TLS is direct-mbedTLS, bypassing esp-tls. Otherwise the _best_ architecture of this group: single-thread poll loop, and the whole client WS codec is `src/ws.c` = **301 lines** — the proof of how small this problem is (incremental in-place-unmask parser :66-94, stack header builder :96-122, in-buffer fragment reassembly :214-233). Clean-room reference only, given GPL. |
| **noPoll** (`ASPLes/nopoll`)        | `8d16aa3`, 2025-08-12         | LGPL-2.1 — static-link relink obligations unmeetable on locked-down firmware | OpenSSL-only TLS hardwired in private headers (nopoll_private.h:41-47) — impossible on IDF; per-send malloc+memcpy (nopoll_conn.c:4478); on EWOULDBLOCK **sleeps 100 ms in a retry loop up to 50×** inside send (:4571-4578); `rand()` masking (:4425-4427); per-message RX mallocs; fragmentation punted to callers. 9,998 LOC. Nothing to salvage.                                                                                                                                                                                                                                                                                                      |
| **CivetWeb** (`civetweb/civetweb`)  | `588860e`, 2026-04-19         | MIT ✓                                                                        | WS client spawns a **mandatory pthread per connection** (civetweb.c:19715) plus a fabricated server context per client (:19705-19709); per-send malloc+mask+free (:14018-14040); 23,275-LOC single file of server to get a client; no ESP-IDF port, OpenSSL-primary.                                                                                                                                                                                                                                                                                                                                                                                      |
| **cwebsocket** (`m8rge/cwebsocket`) | `36f84f2`, 2015-03-30         | MIT ✓                                                                        | Not a client at all: masked-input-only _server_ frame parser for 2015 Arduinos (requires mask bit on input, websocket.c:288; no client handshake, no TX masking, no RNG in the tree), no TLS, no fragmentation, `assert()` error handling, zero tests, dead 11 years.                                                                                                                                                                                                                                                                                                                                                                                     |
| **payden/libwsclient**              | —                             | —                                                                            | The once-popular pthread-based C client's GitHub namespace was transferred into a since-deleted crypto-bot repo; the underlying repo ID 404s. A supply-chain cautionary tale for depending on small standalone WS clients.                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 4.4 Artisan prior art and the patterns worth lifting

- **WIC** (`cjhdev/wic` @ `54d1240`, 2021-06-29, MIT/Apache mix): the
  closest single prior art to the kit's design values — C99, zero-malloc,
  user-supplied rx buffer, TX buffers requested through a callback _typed
  by frame class_ so PONG/CLOSE have reserved pools (wic.h:154-162,
  264-285), push-parser with RX backpressure (message re-delivered when the
  consumer refuses it), partial-message delivery with `fin=false` when the
  buffer fills (wic.c:1106-1132). But: dead four years, **zero unit tests**
  (Autobahn examples only), TX capped at 16-bit lengths (wic.c:1627-1635),
  per-byte hot loops, and a vendored 3,015-line Joyent http_parser for one
  101 response. Design reference, not a dependency.
- **libuwsc** (`zhaojh329/libuwsc` @ `02ad309`, 2021-09-06, MIT): libev +
  Linux + realloc-growable buffers + "Not support fragment"
  (uwsc.c:101-104) + zero tests → rejected. Two liftable gems: the
  one-tick keepalive machine (connect timeout, ping schedule, 5 s pong
  grace, 3-miss breaker — uwsc.c:603-641) and vectored masking with a
  running mask offset (uwsc.c:548-559).
- **Zephyr websocket client**
  (`zephyrproject-rtos/zephyr` `subsys/net/lib/websocket/`, Apache-2.0,
  actively maintained; websocket.c 1,319 LOC + 471 LOC of split-boundary
  ZTESTs): **the best liftable core of the survey.** A 5-state incremental
  header parser driven by a single `parser_remaining` counter
  (websocket.c:796-906) proven against 1..12-byte split feeds; deferred
  _bulk in-place unmask with the mask phase recomputed arithmetically_
  (`offset = message_len - remaining - count`, :1065-1076) — correct
  across arbitrary partial reads with no per-byte state; an
  iovec partial-send loop with an absolute deadline (`sendmsg_all`,
  :559-614); and a recv contract (chunk + `*remaining` + type flags) that
  is isomorphic to the kit's existing reassembler events. Do not copy: the
  masked-send `k_malloc` full-payload copy (:743-754), the unreachable
  CLOSE auto-reply compare (0x08 vs 0x08|FIN), or the 4-byte key nonce.
- **curl `lib/ws.c`** (@ `7d5398f`, 2,069 LOC, active daily): pattern
  mining only. Independently validates the kit's recv event shape (every
  chunk carries `{flags, offset, len, bytesleft}`, ws.c:574-587); the
  **single-slot pending control frame injected only at frame boundaries**
  (ws.c:109-124, 630-647, 995-1002) — O(1) auto-pong that cannot corrupt
  an in-flight frame; the encoder's `payload_remain` + running mask index
  guard for declared-length streaming sends (:97-104, 901-906); and
  env-forced tiny-chunk/EAGAIN/zero-mask fault injection for tests
  (:965-969, 1391-1400, 1714-1733).
- **coreMQTT** (`FreeRTOS/coreMQTT` @ `5be5f95`, MIT, active): not
  WebSocket — the _shape_ template for a production embedded protocol
  client. `TransportInterface_t` (transport_interface.h:191-247, 302-309):
  send/recv function pointers over an opaque context, **>0 bytes moved,
  0 = retryable and MUST NOT mean disconnect, <0 fatal**; zero allocation;
  injected clock; `sendBuffer`/`sendMessageVector` bounded partial-send
  loops with wraparound-safe elapsed time; `handleKeepAlive` runs only on
  no-data iterations with a pong deadline. Quality bar: 22,617 lines of
  unit tests + 108 CBMC proof directories + documented MISRA compliance.
  The landed `websocket_tx` raw-write contract is recognizably this shape.

### 4.5 Gap check

A sweep of GitHub topic/awesome lists and the ESP-IDF component registry
found **no further candidate** meeting client-mode + C99 + RTOS orientation

- real tests + permissive license. The registry contains only Espressif's
  own client (plus wrappers built on it). Rejected quickly: picows (Python),
  lwsock (C++/Linux), SharkSSL WS client (proprietary), libws
  (libevent/Linux, dead), wsServer (server-only). The niche the kit needs —
  allocation-free, transport-agnostic, host-testable, maintained — is
  genuinely unoccupied; the two systems that fill it credibly (Zephyr's
  client, curl's ws.c) are embedded in larger stacks and liftable as
  _patterns_, not linkable modules.

## 5. Comparison matrix

Focus axes from the research brief. "Own worker" = the in-flight design
(§8): `esp_transport_ws` handshake/RX + `websocket_tx` writer over the
parent TLS handle, one worker task per socket.

| Axis                     | esp_websocket_client 1.8.0                                 | esp_transport_ws + own worker                      | wslay (frame / event)                   | libwebsockets                        | Mongoose                  | noPoll                         | CivetWeb               | Zephyr (pattern)              |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------- | --------------------------------------- | ------------------------------------ | ------------------------- | ------------------------------ | ---------------------- | ----------------------------- |
| Ownership                | own task + esp_event, 2 locks                              | **single owner, no locks**                         | none (codec)                            | owns event loop/task                 | owns poll loop            | blocking calls                 | thread per conn        | caller-driven                 |
| Full-duplex safety       | concurrent TLS r/w outside mbedTLS contract                | single-task alternation, in contract               | n/a (embedder)                          | single service thread                | single thread             | app mutexes                    | reader thread + writer | single caller                 |
| Ping/pong contention     | PING/PONG hold tx_lock w/ 10 s budget; pong-timeout aborts | control frames at frame boundaries via single slot | event: auto-pong queue; frame: embedder | auto-pong staged on service thread   | frame-boundary            | blocking                       | server loop            | surfaced to caller            |
| Partial write            | short write → new CONT header (stream desync)              | **resumable same-frame writer**                    | frame layer resumes exactly             | buflist malloc+copy                  | iobuf grows (uncapped TX) | 100 ms sleep loop              | blocking loop          | iovec loop w/ deadline        |
| RX fragmentation surface | chunk events (opcode/fin/len/offset)                       | same events, read into ring slot                   | chunk callbacks (no offset)             | callbacks + remaining APIs           | whole message only        | whole message, joins on caller | whole message          | chunk + remaining             |
| Bounded queues           | shared tx buffer; event queue                              | **SPSC rings only, all metered**                   | event queue unbounded                   | buflist unbounded                    | TX iobuf unbounded        | mallocs                        | n/a                    | caller buffers                |
| Steady-state allocs      | ~56 B calloc/free per rx frame + memcpy/send               | **zero**                                           | frame: zero; event: per message         | zero until backpressure, then malloc | zero until growth         | per message                    | per send               | zero (rx), malloc (masked tx) |
| TLS separation           | esp-tls ✓                                                  | esp-tls ✓                                          | bring your own ✓                        | own mbedTLS wrapper (Apache-2)       | own mbedTLS glue          | OpenSSL only                   | OpenSSL-primary        | sockets/TLS-socket            |
| Reconnect                | disabled; kit gate                                         | kit gate (unchanged)                               | embedder                                | optional helpers                     | app                       | app                            | app                    | app                           |
| Flash cost               | 11.8 KB (+11.5 KB transport, stays)                        | **≈ −7…−11 KB net vs incumbent**                   | +2.6 KB (frame)                         | +100–200 KB                          | ~5.4 k LOC subset         | 10 k LOC                       | 23 k LOC               | pattern only                  |
| License                  | Apache-2 (Espressif)                                       | first-party                                        | MIT                                     | MIT + Apache-2 wrapper               | GPLv2/commercial          | LGPL-2.1                       | MIT                    | Apache-2                      |
| Maintenance              | tip = 1.8.0; issues open, unfixed                          | ours (small, host-tested)                          | idle 4 y, frozen protocol               | very active                          | very active               | maintenance-only               | active                 | very active                   |
| Tests                    | none host-runnable for kit paths                           | kit host tests (landed + §8.3 list)                | strong CUnit + ASan CI                  | Autobahn/Sai                         | vendor CI                 | own regression                 | server-centric         | split-boundary ZTESTs         |

## 6. Decision: replace — the evidence, condensed

1. **The incumbent's defects are architectural and unfixed upstream** (§2):
   locking topology, event-dispatch heap churn, partial-write stream
   corruption, keepalive-vs-sender contention, and an out-of-contract TLS
   concurrency model. 1.8.0 is upstream HEAD; issues #1090/#942/#687/#680/
   #882/#1104 sit open. Wrapping cannot reach any of these; patching
   reaches four of them and stops.
2. **The foundation the incumbent stands on is exactly what the kit wants**
   (§3): allocation-free steady state with `propagate_control_frames=true`,
   caller-supplied read buffers (zero-copy into ring slots), no locks,
   single-caller contract, TLS stays esp-tls, and it is already linked —
   the replacement _deletes_ 11.8 KB and two tasks rather than adding a
   dependency.
3. **No third-party client fits** (§4): each fails on license,
   architecture, allocation model, platform, or maintenance. The survey's
   constructive output is a pattern library, and Mongoose's 301-line
   `ws.c` is the existence proof that the codec itself is small.
4. **The kit already owns most of the hard parts, host-tested**: the
   incremental text-message reassembler, the SPSC rings, the retry gate,
   the deferral policy — and, as of this morning, the resumable frame
   writer and serialized TX engine (§8.1). The marginal new code is the
   ~250–350-line esp worker.

Recommendation ranked (also the answer to "replace or wrap/patch"):

1. **Replace** with the single-owner worker over `esp_transport_ws` +
   `websocket_tx` (the in-flight design), subject to the §8.3 trap list.
2. **If the replacement stalls**, apply the four-patch stopgap to the
   vendored client (tick-units fix, deferral-log rate limit,
   `network_timeout_ms` 2–3 s, #942 abort→error) — it meaningfully derisks
   the field failure modes but keeps per-frame heap churn and the TLS
   concurrency violation, so it is a bridge, not a destination.
3. **Do not adopt** lws, Mongoose, noPoll, CivetWeb, WIC, or libuwsc.
   Keep wslay_frame and Zephyr's parser as the codec references (and
   candidates for a future own-RX phase, §8.5).

## 7. Reconciliation with the deferral refactor and the realtime reviews

**The transient-send-deferral refactor is validated and extended by this
research.** The audit resolved the one open safety question: with the
incumbent, the deferral case (`tx_lock` wait timeout) writes zero caller
bytes, so retrying the same retained frame is wire-safe; the dangerous
partial-write case never surfaces as a deferral — it either corrupts inside
the client (CONT wrap) or aborts the connection. The refactor's policy was
therefore sound, but blind: it cannot distinguish "lock contention" from
"TCP backpressure", and it inherits a logging side effect (the client's
per-deferral `ESP_LOGE` fires from the kit's own network task — an S2-1
amplifier the thermo review didn't attribute).

The new sender contract (`pcm_uplink_sender.h:15-29`) now encodes the
research's conclusion directly: `PROGRESS` (bytes of the retained frame
reached the connection; resume the _same_ WebSocket frame) vs
`TEMPORARILY_UNAVAILABLE` (zero progress; same-frame retry safe) vs
`DISCONNECTED` (delivery uncertain; replace the socket). Under the new
worker, deferrals become honest: `WOULD_BLOCK` from a nonblocking-style
write probe, with partial frames resumed byte-exactly by the frame writer
instead of re-sent. The deferral _counters and restart threshold_ carry
over unchanged; only their trigger becomes truthful.

Two gaps the replacement must (and naturally does) close:

- **S2-2's second half:** the control lane still restarts on the first
  short send. Under S3-1's shared worker, control sends flow through the
  same `websocket_tx` + deferral policy as PCM — one implementation, both
  lanes, closing the asymmetry without a second policy copy.
- **The goal doc's "device socket send" timestamp**: with esp-tls, a
  completed write means _accepted by the TLS layer_ (a record can sit in
  mbedTLS's out buffer across a stall) — the metric should be named
  "TLS-accepted" not "on wire" (§8.3 T8).

**Realtime audio-path recommendations (thermo §7, S1-3, S2-1):** the
replacement is strictly aligned. It deletes the two unpinned prio-5 client
tasks (S1-3's inversion shrinks to firmware-owned, pinnable tasks only),
deletes the client's error-path logging from the send path (S2-1(3)), and
removes 50 heap ops/s from the downlink (goal §performance). It is also a
precondition-friendly step for the §7 audio-task extraction: the worker
model keeps all socket work on one task per socket, so moving the audio
pumps to a dedicated prio-6 task later changes _nothing_ in the transport
contract — the rings remain the only cross-task boundary. Conversely,
nothing in this replacement blocks StackChan: the same worker + tx engine
serves the full-duplex device, and the PCM lane's new chunk reassembly
(S1-2's fix shape) already landed.

## 8. Review of the in-flight single-owner implementation (prioritized)

Tree state reviewed: uncommitted `apps/kit` at ~09:25, 2026-07-30.

### 8.1 What landed, and its assessment

- **`components/core/src/websocket_frame_writer.c`** (164 LOC + host
  test): one complete masked client frame in caller storage;
  `begin/pending/advance/reset/busy`; a short write resumes inside the
  same declared frame. Header layouts (6/8/14 B) and mask-bit handling
  verified correct; control frames capped at 125 B; `begin` while busy →
  `BACKPRESSURE`. This module _is_ the CONT-desync fix, and matches the
  wslay_frame/curl `payload_remain` pattern. One nit: the `SIZE_MAX`
  overflow guard is looser than the later storage check needs, but modular
  arithmetic makes `header_size` exact and the storage bound rejects
  first — no reachable defect.
- **`components/core/src/websocket_tx.c`** (229 LOC + host test): the
  serialized single-owner TX FSM. Raw-write contract is coreMQTT-shaped
  (`WROTE` 1..n / `WOULD_BLOCK` / `DISCONNECTED`, zero-written enforced on
  the latter two); control frames use curl's single-slot
  park-and-inject-at-frame-boundary pattern; data resume requires the same
  (opcode, size) — the payload is already staged, so the retained ring
  frame's stable pointer satisfies it. Host tests cover partial-write
  resume with exact wire bytes (deterministic masks), pong deferral to the
  PCM frame boundary, and the bounded second-control-slot rejection.
  Assessment: correct, small, and the right shape; policy gaps are T3/T4
  below.
- **`pcm_uplink_sender` + `PROGRESS`**: contract documented in the header,
  wired through `pcm_transport.c:320-321`. Note the current
  esp_websocket_client-based `send_uplink_frame` can never report
  `PROGRESS` — the outcome is dormant until the worker lands (fine; the
  host tests define it).
- **`pcm_lane` downlink chunk reassembly**: chunked delivery of one
  unfragmented frame now accumulates into the acquired ring slot
  (offset-checked, cancel-on-mismatch, publish on completion;
  `UNAVAILABLE` = mid-reassembly, silently continued by the transport).
  This implements the thermo S1-2 "judo fix" for the dominant short-TLS-
  read case. **Remaining S1-2 gap:** true WS continuation frames
  (opcode 0x0, `fin=0`) are still rejected (`pcm_lane.c` `!final_fragment`
  → `INVALID_ARGUMENT`, and opcode 0 maps to `OTHER` → nonbinary) — and
  the rejection still feeds `latch_protocol_failure`. An edge that
  re-fragments (Cloudflare is entitled to) still kills the socket, today
  permanently (T10).

### 8.2 The proposed esp worker (not yet written) — shape check

The design named in the continuation — `esp_transport_ws` for
handshake/receive, the retained parent TLS handle for the custom resumable
writer, nonblocking fd + `TCP_NODELAY`, serialized ping/pong/data, no
esp_event/client task/locks — is the correct synthesis of §2–§4, and §3
confirms every required primitive is public API on IDF 5.4.2. It also
subsumes thermo S3-1: one parameterized worker (url/headers/subprotocol/
buffer geometry/lane glue) serves both sockets and deletes the ~600
duplicated lines.

### 8.3 Correctness traps, each with the smallest failing test to write first

_(Second-pass disposition: the compiled worker resolves T2, T7, T8, T10,
T11, half of T5, and decides T1 as full-`O_NONBLOCK` — see §8.6 for the
per-trap table and the new findings that decision exposes. T3, T4→N-S1-2,
T6 and T9 remain open.)_

The worker should be TDD'd against a scripted fake transport (the §11
fake-client pattern from the thermo review; curl's env-forced
tiny-chunk/EAGAIN fault injection is the model). Traps ranked:

- **T1 · The RX blocking-mode tension (the central design decision).**
  `esp_transport_ws`'s header read (`ws_read_header` → `read_exact_size`)
  treats a 0 return mid-header as an error, and with a blocking socket the
  payload/header reads can block up to `SO_RCVTIMEO` _in the worker task
  that also pumps TX_. Naively setting `O_NONBLOCK` makes every torn
  header (partial TLS record) a spurious protocol error → restart storm;
  keeping the 10 s connect-time `SO_RCVTIMEO` recreates the incumbent's
  worst-case reader stall inside our own task (TX pump frozen; uplink ring
  fills in 80 ms and drops with metrics — audible). Recommended policy:
  keep the fd blocking; after connect, `setsockopt` `SO_RCVTIMEO`/
  `SO_SNDTIMEO` down to a bounded worker budget (≈50–250 ms); gate reads
  on `poll_read(0)`; classify a torn-header timeout as a _retryable_ read
  (no restart) unless repeated. **Failing tests:** (a) fake transport
  delivers a frame header split 1+1 bytes across two reads → worker
  accepts the frame, zero restarts; (b) fake read stalls 200 ms mid-frame
  → TX deferral counters move, no restart, audio drop metrics increment;
  (c) `O_NONBLOCK`-style 0-return mid-header → classified retryable.
- **T2 · TX reset on socket generation change.** A half-written frame in
  `websocket_tx` must never survive onto a new socket. The worker must
  call `iterate_kit_websocket_tx_reset` in its stop/restart path (and the
  sender's retained frame is discarded separately by `discard_pending` —
  both, not either). **Failing test:** begin a frame, deliver
  `WOULD_BLOCK`, restart the socket, send again → first bytes on the new
  socket are a complete fresh frame header (today only guaranteed by
  convention).
- **T3 · Single control slot policy.** `queue_control` rejects a second
  control frame (`BACKPRESSURE`) — so (a) two server PINGs inside one
  flush window answer the _older_ ping and drop the newer (RFC 6455
  §5.5.3 prefers the most recent; curl overwrites — "we keep only one"),
  and (b) a CLOSE cannot preempt a parked PONG. Overwrite-newest (and
  let CLOSE displace anything) is one line and matches curl. **Failing
  test:** queue PONG(a) then PONG(b) → wire carries exactly one pong with
  payload b; queue PONG then CLOSE → CLOSE wins the slot.
- **T4 · Trickle liveness.** `PROGRESS` resets the deferral streak, so a
  pathological 1-byte-per-poll connection sends one 20 ms frame in ~13 s
  and never trips `restart_after_consecutive_deferrals`; only the
  (worker-owned) pong deadline would eventually fire. Bound frame age:
  restart when one frame stays incomplete longer than N ms (name it in the
  policy header next to the deferral constants). **Failing test:**
  scripted raw writer yields 1 byte per call → assert restart requested
  within the policy bound (fails today: no bound exists).
- **T5 · Inbound control-frame validation is the worker's job.** ≤5.5.3
  transport_ws performs none of the 2026 RFC checks: an oversized (>125 B)
  or fragmented PING reaches the worker, and `queue_control` will
  correctly refuse >125 B — the worker must then _drop and count_, not
  restart, and must handle a PING arriving in chunks (control frames can
  still be delivered split by the chunked read model). CLOSE needs status
  parse + echo + restart-not-brick. **Failing tests:** 200-B ping → pong
  skipped, metric incremented, connection alive; CLOSE mid-stream → clean
  generation bump, reconnect, frames flow again.
- **T6 · Handshake spillover drain.** ≤5.5.3 `ws_poll_read` cannot see
  bytes buffered during the upgrade; a server that pipelines its first
  frame behind the 101 stalls until unrelated traffic arrives. Worker must
  issue one unconditional read pass after connect. **Failing test:** fake
  transport returns 101+first-frame in one connect read → frame delivered
  without further socket activity.
- **T7 · One writer path, enforced.** After the handshake, _all_ TX must
  flow through `websocket_tx` on the parent TLS handle; any residual use
  of `esp_transport_ws` send helpers (send_raw ping, `_ws_write`'s
  len==0-means-PING quirk, close helper) would interleave with a partial
  frame and desync the stream — and would also scribble masks into caller
  buffers. Enforce structurally (the worker never stores the ws-transport
  send functions) and with an architecture test greping the worker for
  `esp_transport_ws_send`/`esp_transport_write(ws` calls. Also set
  `TCP_NODELAY` via `esp_transport_get_socket` post-connect (nothing in
  the stack does), and note the parent-handle write path must use
  `esp_transport_get_payload_transport_handle` (which deliberately resets
  ws read bookkeeping — call it once at connect, not per write).
- **T8 · esp-tls write granularity and "sent" semantics.** mbedTLS accepts
  a ≤4 KB record wholly or not at all; a record can be _accepted_ (counted
  written) while still flushing from mbedTLS's out buffer across several
  later calls, and `WANT_WRITE` after acceptance surfaces as
  `WOULD_BLOCK` on the _next_ frame. Consequences: `PROGRESS` will be rare
  in practice (both kit message sizes fit one record) — fine — and the
  uplink "sent" timestamp means TLS-accepted, which the metrics naming
  should reflect. The raw-write shim must map: >0 → `WROTE(n)`; 0 or
  WANT\_\* with nothing accepted → `WOULD_BLOCK`; hard error / peer close →
  `DISCONNECTED`. Never report a byte count on `WOULD_BLOCK`
  (`websocket_tx` treats that as `FAILED` by contract — good).
- **T9 · Keepalive ownership moves to the worker.** Client PING scheduling
  and the pong deadline died with `esp_websocket_client`. Adopt the
  coreMQTT/libuwsc shape: ping on idle (tx-idle ≥ interval), pong deadline
  with a miss counter feeding the existing retry gate; PING shares the T3
  control slot (a due ping skips its tick when a pong is parked —
  bounded). PCM's 50 fps traffic is its own liveness signal; the control
  socket is where this matters. **Failing test:** scripted quiet link →
  ping emitted at interval; withhold pong → restart via retry gate at the
  policy bound.
- **T10 · The S1-1 latch is still in the tree.** Every new rejection path
  (lane `INVALID_ARGUMENT`, tx `FAILED`) still funnels into
  `latch_protocol_failure` → `ITERATE_KIT_ESP_IDF_PCM_FAILED` forever
  (`pcm_transport.c:103-110,559-567`; same on control). Landing a better
  transport under a permanent latch preserves the brick; S1-1's
  delete-the-latch fix must ship with (or before) the worker, with the
  thermo §11 regressions. The continuation-frame gap (§8.1) makes this
  concrete: an edge that re-fragments today bricks the device _through
  the brand-new reassembly code_.
- **T11 · Mask RNG.** `websocket_tx` takes a random callback — wire it to
  `esp_fill_random` (hardware TRNG), never `rand()` (the noPoll
  anti-pattern). Zero-payload PING/CLOSE work (`begin` accepts NULL/0).
  `Sec-WebSocket-Protocol` echo remains unverified (transport limitation,
  incumbent parity) — acceptable against our own server, note it in the
  worker header.

### 8.4 Cost accounting (evidence-based)

Per socket, replacing the client with the worker:

| Resource                  | Removed                                                                                                                 | Added                                                                                                                               | Net                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Flash                     | client archive 11,834 B                                                                                                 | writer 164 + tx 229 + worker ~300–350 LOC ≈ 3–5 KB                                                                                  | **−7…−9 KB** (transport_ws/ssl/esp-tls unchanged, already linked)      |
| Heap, steady              | client task stack 4,096 + TCB ~360; rx/tx buffers (PCM 1,280 / control 2,048); esp_event loop; ~56 B calloc/free × 50/s | tx frame storage (static): 648 B PCM / 1,032 B control; worker state in existing transport struct                                   | **≈ −7…−8 KB heap + zero steady-state allocs**                         |
| Heap, per reconnect       | task+TCB+transport-list+upgrade-buffer churn (client recreates all)                                                     | TLS session only (~22–25 KB, unavoidable both ways; enable session tickets)                                                         | less churn, fewer #1104-class leak surfaces                            |
| Copies per PCM frame pair | TX: ring→tx_buffer memcpy + in-place mask + unmask-restore; RX: rx_buffer→ring memcpy                                   | TX: one fused mask-copy into frame storage; RX: read into staging then lane memcpy into ring slot (direct-into-slot possible later) | **−1 XOR pass per TX frame; RX copy count unchanged as landed (§8.6)** |
| Tasks                     | 1 × prio-5 unpinned client task per socket                                                                              | none (existing pinned network task absorbs the socket)                                                                              | −2 tasks total; S1-3 surface shrinks                                   |
| CPU                       | event dispatch + double XOR + extra wakeups                                                                             | 646-B XOR at 50/s (≈0.03 % of 160 MHz)                                                                                              | negligible either way; fewer wakeups                                   |

### 8.5 Is there a materially cleaner design?

Two alternatives were seriously considered and rejected _for now_:

1. **Own RX parser over raw esp-tls (drop transport_ws after the
   handshake).** Structurally resolves T1 (an incremental parser is
   nonblocking-native — Zephyr's 5-state machine and wslay_frame prove the
   shape at 200–440 LOC), removes the ≤5.5.3 validation gaps, and frees
   the 1024-B transport read buffer. Cost: the kit re-owns header parsing
   (the code Espressif needed 2024–2026 to harden) and its tests. Verdict:
   the natural **phase 2** if T1's blocking-mode compromise measures badly
   on the rig — the worker's raw-read seam should be designed so the
   parser can slot in without touching `websocket_tx` or the lanes.
   Keeping transport_ws for the _handshake_ is right in both phases.
2. **Wrap-and-patch the incumbent** (four local patches, §6). Lower
   immediate risk, but retains per-frame heap churn, dispatch-under-lock,
   the memcpy send path, and the mbedTLS contract violation — and the
   patches must be re-carried on every component update. A bridge at
   best; the mbedTLS concurrency issue alone justifies single-owner.

Also examined and rejected: adopting wslay_event for the control socket
only (malloc per message, unbounded queue — two policies for one problem);
lws (§4.2); a shared single worker task for both sockets (couples control
TLS handshake stalls to PCM liveness; keep one worker per socket, the
current structure).

### 8.6 Second-pass review: the compiled implementation (~09:30 tree)

Scope: `platforms/iterate_esp_idf/websocket_connection.c` (565 L, new) +
`include/.../esp_idf_websocket_connection.h`, rewritten `pcm_transport.c`
(761 L), `websocket_protocol.h`, and the wiring into
`websocket_tx`/`pcm_uplink_sender`/`pcm_lane`. PCM socket only;
`itx_transport.c` still runs esp_websocket_client (so the −11.8 KB flash
win is **not yet realized** — the client archive stays linked; bin grew
3.2 KB to 1,139,648 B with both stacks present, as expected mid-migration).
IDF behavior verified against `components/tcp_transport/transport_ws.c` and
`transport_ssl.c` in the v5.5.3 checkout (the 5.4.2 delta is redirects
only), not from documentation.

#### What landed correctly (and which §8.3 traps it closes)

| Trap                             | Disposition in the compiled code                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 blocking mode                 | **Decided: full `O_NONBLOCK`** + per-call `timeout_ms` (receive is called with 0). `configure_socket` sets `O_NONBLOCK` + `TCP_NODELAY` post-connect (websocket_connection.c:254-280). The decision is coherent — but it exposes N-S1-1/N-S2-1 below, because `esp_transport_ws`'s read path is not stall-tolerant.                             |
| T2 tx reset on generation change | **Closed.** `tx_reset` at open (:364), on read-disconnect (:416), and in close (:536); `pcm_transport` restart path always goes through `connection_close` (pcm_transport.c:372-384).                                                                                                                                                           |
| T3 control-slot policy           | **Open, and sharper now**: `queue_control` rejection is mapped to `RECEIVE_PROTOCOL_FAILURE` (websocket_connection.c:463-467, 482-486) — a second PING inside one flush window, or CLOSE arriving while a PONG is parked, now _restarts the socket_ instead of dropping (N-S2-4).                                                               |
| T4 trickle liveness              | Superseded by **N-S1-2** — the deferral threshold's unit problem is worse than the trickle case.                                                                                                                                                                                                                                                |
| T5 inbound control validation    | **Half closed**: ≤125 B + FIN enforced (:368-376). But a control payload split across chunks → PROTOCOL_FAILURE → restart (N-S2-4), and the oversized-ping response is restart, not drop-and-count.                                                                                                                                             |
| T6 spillover drain               | **Open.** No post-connect drain read; `ws_read_header`'s first act is a _parent_ poll (transport_ws.c:529-535), which cannot see bytes retained in `ws->buffer` from the upgrade — a server-pipelined first frame waits for unrelated socket bytes (N-S2-5).                                                                                    |
| T7 one writer path               | **Closed.** All TX flows through `websocket_tx` over the parent handle captured at init (:168-172); no `esp_transport_ws` send API is referenced anywhere; `TCP_NODELAY` set; single pre-masked buffer per frame = one TLS record.                                                                                                              |
| T8 write-shim mapping            | **Closed, correctly**: >0 → `WROTE(n)` (partial counted, :173-179); 0 / `ESP_TLS_ERR_SSL_WANT_READ/WRITE` / errno EAGAIN-family → `WOULD_BLOCK` (:180-193); else DISCONNECTED with errno capture. Matches the coreMQTT contract.                                                                                                                |
| T9 keepalive                     | **Open by design**: no WS-level PING initiator anywhere; liveness = TCP keepalive 10/5/3 (websocket_connection.c:18-22) + Cloudflare idle closes. Dead-server-live-TCP goes undetected (N-S2-6).                                                                                                                                                |
| T10 S1-1 latch                   | **Closed — the big one.** `protocol_failure()` now counts + disconnects + restarts through the retry gate; only local invariants latch fatal (pcm_transport.c:119-136), and the state machine doc-comments the policy. Restart/stop/start lifecycle is re-entrant (:564-565), stop timeout 12 s > the 10 s connect it must outlast (:19, :644). |
| T11 mask RNG                     | **Closed**: `esp_fill_random` (:139-147).                                                                                                                                                                                                                                                                                                       |

Also verified good: single-task ownership keeps mbedTLS inside its
documented contract; steady state is allocation-free (no esp_event, no
per-frame heap anywhere in the new path); PEER_CLOSE echoes the close
(payload included) then restarts (:477-488 → pcm_transport.c:270-276);
`payload_size < 0` catches the transport's 64-bit-length `int` overflow
(:424-431); worker loop order receive→control→send→receive drains pongs at
frame boundaries with minimal latency (pcm_transport.c:458-468).

#### New findings (severity-ranked; kit cites + IDF v5.5.3 cites)

**N-S1-1 · A mid-frame zero-byte read desyncs the IDF transport and
restarts the socket — reachable on every normally-framed stall.**
Mechanism, all verified in source: when a frame's header has been parsed
but its payload bytes haven't arrived yet, the next `receive(timeout=0)`
enters `ws_read` with `bytes_remaining > 0`, which calls `ws_read_payload`
directly (no poll gate); the TLS read returns 0 (`ssl_read` maps
`WANT_READ`→timeout, transport_ssl.c:276-284) and `ws_read` then executes
`ESP_LOGE + ws->frame_state.bytes_remaining = 0; return rlen` —
**deliberately zeroing its own frame bookkeeping** (transport_ws.c:674-679;
`ws_read_payload` adds a second `ESP_LOGE`, :478-480). The remaining
payload bytes of that frame will be parsed as a _new header_ on the next
call — garbage opcode/length. Before that even manifests, the kit layer
compounds it: `result==0` with the opcode still set (accessor gates only on
`header_received`, transport_ws.c:933-940) takes the data path and resets
`receive_payload_offset` (websocket_connection.c:491-492), and the
zero-byte chunk reaches `pcm_lane`, whose `fragment_bytes == 0` check
returns `INVALID_ARGUMENT` → `protocol_failure` → restart
(pcm_transport.c:183-216). Net: **any header/payload record gap observed by
the 10 ms loop = socket restart + double ESP_LOGE**, and the restart is
what hides the transport desync.
_How often:_ our own stack makes this ordinary — Node's `ws` sender writes
frame header and payload as **two separate socket writes**
(websockets/ws `lib/sender.js:558-563` @ 61349ec: `cork(); write(list[0]);
write(list[1]); uncork()`), i.e. two TLS records per server frame; they
usually share one TCP segment, but any congestion/retransmit split between
them lands in this path. This is precisely the fragmentation-robustness
class S1-2 was meant to close, resurfacing one layer down.
_Smallest failing tests:_ (a) fake transport delivering one 640-B frame as
header-read, then a zero-byte read, then payload-read → assert one frame
accepted, zero restarts, zero protocol_failures (fails today at three
layers); (b) same with the split _inside_ the payload (chunk, zero-read,
chunk).
_Fix ladder:_ (1) connection-side mid-frame poll gate — when
`receive_payload_offset > 0` (or opcode pending), `esp_transport_poll_read`
first and return IDLE on 0 — never _enters_ `ws_read` without data;
removes the common case but not the partial-TLS-record case (poll sees
ciphertext, decrypt still yields WANT_READ); (2) project-local override of
`transport_ws.c` changing the two `<= 0` payload checks to `< 0` and
dropping the `bytes_remaining = 0` on timeout (~4 lines — complete fix,
must be carried across IDF updates); (3) the §8.5 phase-2 own parser
(complete fix, removes the dependency). Recommended: (1) now + (2) or (3)
before field endurance runs; connection must additionally treat
`byte_count==0 && payload_size>0` as wait-not-data.

**N-S1-2 · The deferral-restart threshold now measures 10 ms probes, not
250 ms sends: restart after ~40 ms of routine backpressure.**
`NETWORK_TASK_POLL_MS = 2` is clamped to one FreeRTOS tick =
**10 ms real** (`CONFIG_FREERTOS_HZ=100`; pcm_transport.c:15, 397-405).
Each wake makes at most one send attempt; a `WOULD_BLOCK` probe
(`poll_write(0)`→0, transport_ssl.c:225-228) returns `TX_DEFERRED` →
sender `TEMPORARILY_UNAVAILABLE` → `consecutive_send_deferrals++`; at
`RESTART_AFTER_DEFERRALS = 4` the frame is discarded and the socket
restarted. Old semantics: 4 × 250 ms blocking timeouts ≈ 1 s of sustained
stall. New semantics: **4 × ~10 ms probes ≈ 40 ms** — inside the range of
ordinary Wi-Fi modem-power-save and AP-buffering stalls (100 ms beacon
intervals), during exactly the moments the deferral machinery was built to
absorb. `esp_idf_websocket_policy_test.c:7-13` still pins the constant to
[3,4], test-enforcing the wrong unit; `SEND_TIMEOUT_MS` is now orphaned on
the PCM path (only itx references it).
_Smallest failing test:_ scripted raw-writer returning `WOULD_BLOCK` for
150 ms of simulated time then accepting → assert the frame is retained and
sent, no restart (fails today after 4 polls); plus the T4 trickle bound.
_Fix:_ make the bound time-based (no-progress-for-X-ms on the retained
frame, X ≈ 500–1000 ms for PCM; PROGRESS resets the clock), expressed in
the policy header with its own test; the counter stays as a metric.

**N-S2-1 · Torn frame header → hard restart.** `read_exact_size` treats a
0-byte read mid-header as `-1` (`ESP_LOGW` + return, transport_ws.c:
503-508); `ws_read_header` has a parent poll gate only _before the first
byte_ (:529-535) — a 2-byte basic header, extended length, or (masked-peer)
mask key split across readable windows returns −1 → connection maps
`result < 0` to DISCONNECTED (websocket_connection.c:413-418) → restart.
Much rarer than N-S1-1 (requires a split inside a ≤4-byte span) but the
same storm class; only fix-ladder options (2)/(3) close it.
_Failing test:_ header delivered 1 byte + 1 byte across two windows →
frame accepted (fails today).

**N-S2-2 · Log-storm vectors on the hot task, at 10 ms cadence.** Every
would-block write probe logs `ESP_LOGW` from `ssl_write`
(transport_ssl.c:225-228); every mid-frame stall logs `ESP_LOGE` twice in
transport_ws (:480, :675) plus `esp_tls_conn_read error` (`ssl_read`,
transport_ssl.c:277) — all from the prio-5 worker. Under backpressure +
wedged console (thermo S2-1 scenario) this is up to ~100 log lines/s
blocking the network task, and unlike the incumbent this task also owns
reconnect. _Mitigation now:_ `esp_log_level_set("transport_ws", ESP_LOG_NONE)`
and `esp_log_level_set("transport", ESP_LOG_NONE)` (or the tags' actual
names) at worker init, or route via the thermo S2-1 deferred-diagnostics
ring; the metrics already count every one of these events, so the logs are
redundant. _Rig assertion:_ console-wedge + 60 s backpressure → no WDT,
bounded log bytes.

**N-S2-3 · `WANT_WRITE` during a TLS read is not mapped → restart.**
`ssl_read` maps only `WANT_READ`/`TIMEOUT` to 0; `MBEDTLS_ERR_SSL_WANT_WRITE`
(TLS 1.3 KeyUpdate/ticket flows with a full send buffer) propagates as a
large negative → `read_exact_size`/`ws_read` error → DISCONNECTED restart
(transport_ssl.c:276-284; websocket_connection.c:413-418). Rare; the
connection should treat `ESP_TLS_ERR_SSL_WANT_WRITE` from reads as IDLE.
_Failing test:_ fake read returning WANT_WRITE once → no restart.

**N-S2-4 · Control-frame policy converts tolerable events into restarts.**
(a) A control payload arriving in >1 chunk → `receive_payload_offset !=
payload_size` → PROTOCOL_FAILURE (websocket_connection.c:445-453) — same
two-record mechanism as N-S1-1, and Node `ws` pings are also two writes.
(b) Second PING while a PONG is parked → `queue_control` BACKPRESSURE →
PROTOCOL_FAILURE (:463-467) — the RFC 6455 §5.5.3 most-recent-ping rule
suggests _overwrite_, not reject-then-die. (c) CLOSE while a PONG is parked
→ same path (:477-486) — restart happens anyway, but the close echo is
skipped. _Fixes:_ overwrite-newest in the single slot (CLOSE always wins);
tolerate multi-chunk control payloads by accumulating like data (≤125 B in
the storage) — both small, both in kit code only.
_Failing tests:_ two pings one window → exactly one pong (payload of the
second), alive; ping split into two chunks → one pong, alive; close-while-
pong-parked → close echo on the wire before teardown.

**N-S2-5 · Handshake spillover still invisible (T6 confirmed against
source).** The parent-poll gate at the top of `ws_read_header` cannot see
`ws->buffer` bytes retained from the upgrade; `esp_transport_read_internal`
would serve them (transport_ws.c:114-143) but is never reached when the
socket is quiet. One unconditional `receive()` pass after `connection_open`
(before the poll-gated loop takes over) fixes it. _Failing test:_ fake
transport returns 101+first-frame in the connect read → frame delivered
with no further socket activity.

**N-S2-6 · No WS-level liveness (T9 open).** TCP keepalive (10/5/3 ≈ 25 s)
detects dead TCP; a live-TCP-wedged-server (proxy hang) is undetected
forever on an idle PCM socket, and PTT uplink into a wedged server only
dies at the N-S1-2/N-S2-1 bounds. The tx engine + control slot make a
client PING + pong-deadline ≈ 40 lines (coreMQTT `handleKeepAlive` shape,
libuwsc numbers). Decide per-socket: control socket yes; PCM arguably
covered by traffic when active — but _idle_ PCM (device listening, nobody
talking) is the exposed case.

**N-S3 (smaller, condensed).**

- Empty data frame (payload_len 0): `ws_read` returns 0 with the opcode
  set (transport_ws.c:668-671) → connection data path → lane
  `message_bytes != 640` → restart. Drop-and-count instead
  (websocket_connection.c:491-497 is the seam).
- `NETWORK_TASK_POLL_MS = 2` is misleading — actual cadence is 10 ms at
  `FREERTOS_HZ=100`; either rename to match reality or raise the tick rate
  deliberately (CPU cost) — don't leave the constant lying.
- TLS handshake now runs on the 6144-B static worker stack
  (`ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_STACK_BYTES`,
  esp_idf_pcm_transport.h:25) with a 512-B pre-open headroom guard. The
  incumbent did TLS on a 4096-B task, so 6144 is plausible — but the guard
  reads the high-water _before_ the handshake spike; gate on the rig via
  the existing `network_task_stack_high_water_bytes` metric during
  cert-bundle verification, not on the guard.
- `websocket_connection.c` is compiled into **zero host tests** (only the
  portable writer/tx are tested) — the receive state machine, exactly where
  N-S1-1/N-S2-4 live, repeats the thermo §11 pattern. The pragmatic seam:
  extract the post-read classification (result/opcode/len/fin/offset →
  chunk|control|idle|failure) into a portable function and host-test it
  against scripted sequences; the IDF-touching remainder shrinks to ~150
  lines.
- RX copy count is unchanged as landed (staging buffer → lane memcpy); the
  read-directly-into-ring-slot option remains available later via
  `pcm_lane`'s acquire-before-read shape.
- CPU at idle: ~2 `select(0)` syscalls + one task wake per 10 ms ≈ 200
  selects/s — well under 0.5 % of 160 MHz; the existing work-cycle metrics
  will confirm. During stalls, N-S2-2's logging dominates cost — fix that,
  not the loop.

#### Local maximum? No — but the weak joint is now precisely located

The compiled design is the intended stepping stone, not a trap: single
owner, portable TX engine, bounded storage, latch deleted, honest metrics
on every new edge. Every S1/S2 above is either kit-side policy (N-S1-2,
N-S2-4/5/6, fixable in tens of lines against existing host-test seams) or
the **`ws_read` stall-handling dependency** (N-S1-1/N-S2-1/N-S2-3) — the
one piece of borrowed code whose failure semantics fight the nonblocking
design. That dependency is exactly what §8.5's phase-2 own parser replaces,
and the `receive()` chunk contract already matches the parser's natural
output, so the swap touches nothing above the connection layer. Decision
rule worth writing down: if the rig's endurance runs show
`protocol_failures`/`websocket_disconnects` climbing under induced RF
stress after the kit-side fixes land, go straight to the parser (or the
4-line local transport_ws override as the bridge) rather than tuning
restart thresholds — restarts that exist only to mask a stall-intolerant
reader are the local maximum to refuse.

## 9. Final ranked recommendation

1. **Proceed with the single-owner replacement — now landed for PCM and
   architecturally right (§8.6).** Before rig endurance runs, land in this
   order: (a) the N-S1-2 time-based no-progress bound (replaces the
   probe-counted deferral threshold + its wrong-unit policy test); (b) the
   N-S1-1 mitigations — mid-frame poll gate + byte_count==0-is-wait in the
   connection, then the 4-line local `transport_ws` override or the
   phase-2 parser for the partial-record remainder; (c) N-S2-2 log
   silencing for the transport tags; (d) N-S2-4 control-slot
   overwrite-newest + multi-chunk control tolerance; (e) N-S2-5 post-
   connect drain read; (f) the N-S2-6 keepalive decision. Each has its
   smallest failing test named in §8.6; the connection's post-read
   classifier should be extracted portable so those tests run on the host.
2. **Extract it once, per thermo S3-1**: the worker is the shared
   `esp_idf_ws_worker`; the control lane inherits the deferral policy and
   sheds its first-short-send restart (S2-2 fully closed).
3. **Hold wslay_frame + Zephyr's parser as the phase-2 RX option** if rig
   measurements show T1's bounded read stalls still audible; design the
   worker's read seam for that swap now.
4. **Do not adopt** any surveyed library wholesale (licenses,
   architecture, allocation, maintenance — §4/§5). Use curl/coreMQTT/
   Zephyr/wslay as the pattern references cited in §4.4, and Mongoose only
   as a clean-room existence proof.
5. **Stopgap only if needed:** the four-patch vendored-client bridge (§6).

## 10. Sources

Local checkouts (Go-style, inspected at these commits on 2026-07-30):

| Repo                                 | Commit              | Notes                                                                                                                                                                                                         |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| github.com/espressif/esp-protocols   | `314b192`           | tag `websocket-v1.8.0` = HEAD of the component; vendored copy byte-identical                                                                                                                                  |
| github.com/espressif/esp-idf         | `2c211b23` (v5.5.3) | tcp_transport/esp-tls; 5.4.2 delta = ws redirects only; post-5.5.3 master fixes cited: `9feedcbf`, `85da1a05`, `1ac71105`, `7f2006b3`, `5eff7a17`, `cfec8480`, `d22d5e83`, `e19d2a9a`, `5c43ec14`, `ec09815e` |
| github.com/tatsuhiro-t/wslay         | `0e7d106` (v1.1.1)  | MIT; last commit 2022-08-25                                                                                                                                                                                   |
| github.com/warmcat/libwebsockets     | `5a86bc7`           | 2026-07-29; MIT + Apache-2 mbedTLS wrapper                                                                                                                                                                    |
| github.com/cesanta/mongoose          | `03be168`           | 2026-07-29; GPLv2/commercial                                                                                                                                                                                  |
| github.com/ASPLes/nopoll             | `8d16aa3`           | 2025-08-12; LGPL-2.1                                                                                                                                                                                          |
| github.com/civetweb/civetweb         | `588860e`           | 2026-04-19; MIT                                                                                                                                                                                               |
| github.com/m8rge/cwebsocket          | `36f84f2`           | 2015-03-30; MIT                                                                                                                                                                                               |
| github.com/zhaojh329/libuwsc         | `02ad309`           | 2021-09-06; MIT                                                                                                                                                                                               |
| github.com/zephyrproject-rtos/zephyr | `577e42a` (sparse)  | `subsys/net/lib/websocket` + tests; Apache-2.0                                                                                                                                                                |
| github.com/curl/curl                 | `7d5398f`           | 2026-07-30; `lib/ws.c`                                                                                                                                                                                        |
| github.com/FreeRTOS/coreMQTT         | `5be5f95`           | 2026-07-06; MIT                                                                                                                                                                                               |
| github.com/websockets/ws             | `61349ec`           | 2026-01-05; `lib/sender.js` two-write frame evidence (§8.6 N-S1-1)                                                                                                                                            |

Upstream issue references (espressif/esp-protocols): #1090 (tx-lock ticks),
#942 (abort on write timeout), #687/#680/#882 (fragmentation/desync
family), #1111 (TLS read/write concurrency; closed without covering the
SEPARATE_TX_LOCK build), #1104 (reconnect SRAM leak), #1030, #964,
#777/#874, #673, #980/#581. payden/libwsclient: GitHub repo ID 6098565 →
404 (namespace hijacked, then deleted).

Kit sources reviewed line-by-line: `platforms/iterate_esp_idf/
{websocket_connection,pcm_transport,itx_transport}.c` (+ their headers),
`components/core/src/{websocket_text,websocket_frame_writer,websocket_tx,
pcm_lane,pcm_uplink_sender,retry_gate,spsc_ring}.c`,
`websocket_protocol.h`, policy header + tests (`pcm_uplink_sender_test.c`,
`websocket_frame_writer_test.c`, `websocket_tx_test.c`,
`esp_idf_websocket_policy_test.c`), `targets/m5sticks3/sdkconfig`,
`build/iterate-kit-m5sticks3.map`, and the vendored
`espressif__esp_websocket_client`. Second pass additionally verified IDF
`transport_ws.c` `ws_read`/`ws_read_header`/`ws_read_payload`/
`read_exact_size`/`esp_transport_read_internal` and `transport_ssl.c`
`ssl_read`/`ssl_write`/`base_poll_read` line-by-line in the v5.5.3
checkout.
