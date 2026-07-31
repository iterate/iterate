# Fable review: fastest correct Stick reconnect path

Status: independent bounded review, 2026-07-31. Produced from the worktree
`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities` (uncommitted
state on top of `8b94c62cd`). No implementation or test file was modified.
Prompt: `fable-stick-reconnect-fastest-path-prompt-2026-07-31.md`. This builds
on, and does not repeat, `fable-esp32-station-outage-research-2026-07-31.md`
("the outage report"); its §2/§3 mechanism analysis is adopted here as given.

Shorthands: `FW` = `apps/kit/firmware`, `US` = `apps/kit/src/userspace/config-worker`.
Classification: **[source]** proved by reading current code, **[test]** pinned
by an existing test, **[hypothesis]** needs a test or a physical read.

---

## 0. Executive synthesis

1. **[source]** The production symptom (device pingable at `192.168.1.210`,
   no `kit.m5sticks3.getDiagnostics`) has exactly one mechanism in the tree
   that is _permanent by design_: `fatal_failure_latched`. Once set, the
   control network task refuses every future socket
   (`FW/platforms/iterate_esp_idf/itx_transport.c:815-817`) while Wi-Fi stays
   associated, so the device pings forever and never mounts. Nothing in
   `FW/targets/m5sticks3/main/main.cpp` ever escalates it — the main loop only
   logs the FAILED state transition (`main.cpp:1237-1258`). The latch is not in
   the diagnostics schema, and diagnostics ride the dead control lane anyway,
   so the condition is remotely invisible by construction.
2. **[source]** The most likely latch trigger in production is the stack-floor
   check: before every socket open the task compares its **lifetime-minimum**
   stack headroom (`uxTaskGetStackHighWaterMark`, which can only fall) against
   a 512-byte floor and latches _permanently_ on one excursion
   (`itx_transport.c:822-834`; floor `esp_idf_itx_transport.h:56`; stack
   8,192 B shared with TLS, `esp_idf_websocket_connection.h:43`). A location
   move means many consecutive TLS handshakes — the deepest stack path — so
   one deep excursion latches the device for the rest of its uptime even
   though a reboot would fully recover it. The non-latched alternative
   (invisible repeated connect failures at the new network — DNS, captive
   portal, IPv6) is bounded by the 250 ms→30 s gate and would eventually
   converge; only the latch matches an indefinitely stuck device.
   **[hypothesis]** Which one it is can be read _today_ without any code
   change: the Stick is on USB, and the non-resetting serial monitor already
   exists (`apps/kit/src/device/python-serial-monitor.ts`, DTR/RTS deasserted).
   Attach it **before** power-cycling; a power cycle destroys the evidence.
3. **[source]** Invariant 2 (control replacement must not strand the device
   event subscription) fails in the userspace worker, not the firmware. The
   subscription is established **once per `/pcm` socket** with a finite retry
   ladder totalling ~15.75 s (`US/worker.ts:317`), then never again for the
   session's lifetime. After a control remount the device's fresh Cap'n Web
   session has no subscribers **[test:
   `m5sticks3_events_test.c::fresh_subscription_replaces_idle_pcm_generation`
   proves the device side handles re-subscription correctly]**, but no code
   in `worker.ts` ever re-invokes `subscribeToEvents`. Silence is
   indistinguishable from "button not pressed": the only recovery lever,
   sequence-gap close (`US/worker.ts:420-427`), cannot fire when zero events
   arrive. `US/device-events.ts:94` even documents "forcing the surrounding
   session manager to resubscribe" — **no such code exists**. `worker.ts` has
   no tests at all (confirmed by inventory; no `worker.test.ts`, zero imports
   from tests).
4. **[source/test]** Invariant 3 (no audio replay across a PCM replacement)
   is the healthiest part of the system and needs no work: firmware purges on
   every generation edge (`pcm_transport.c:181-229` begin-generation purge,
   `531-563` abandon-on-close, `826-891` downlink barrier + discard;
   pinned by `pcm_lane_test.c` and `pcm_uplink_{sender,conductor}_test.c`),
   and the worker discards its reservoir and closes last-writer-wins
   (`US/worker.ts:175`, `US/pcm-proxy.ts:551-563`; pinned by
   `pcm-proxy.test.ts::ignores late messages … from a superseded provider
generation`). Do not touch this machinery.
5. **[source]** Two remaining bounded-recovery defects, both already named in
   the outage report and both still present in current source: the Wi-Fi
   double-defer ladder (`itx_transport.c:757-784`; one disconnect ⇒ first
   reconnect at +2 s with the next delay already 4 s) and the PCM retry gate
   that no Wi-Fi recovery ever resets (`pcm_transport.c:598-649`), which can
   legally sleep 16–30 s after the station returns. Plus the silent 30 s
   watchdog hole after an `esp_wifi_connect()` that fails without raising a
   disconnect event (`itx_transport.c:785-796`).
6. The current shape **can** meet the gate. No rewrite is required. The
   shortest route is Option A below (~150 firmware lines net, ~30 worker
   lines, all seams host-testable red-first), with Option B's reboot
   escalation folded in as the last-resort bound.

## 1. Invariant status

| Invariant                                                  | Status                  | Blocking defect                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Outage → one mount + one PCM session, no reboot/human   | **Fails**               | Fatal latch is permanent and unescalated; double-defer + PCM blind gate stretch recovery; nothing supervises "Wi-Fi up but never READY"                                                                                                                 |
| 2. Control replacement can't strand the event subscription | **Fails**               | Worker subscribes once per PCM session, finite ladder, no re-subscribe trigger; device side is correct and test-pinned                                                                                                                                  |
| 3. PCM replacement can't replay old audio                  | **Holds** [source+test] | —                                                                                                                                                                                                                                                       |
| 4. Failures bounded and attributable                       | **Partial**             | Latch/state/attempt counters not in diagnostics schema (outage report D6); worker subscription exhaustion falls off the end with no bridge diagnostic; `#ensureProvider` has no backoff or cap (`US/worker.ts:263-311`)                                 |
| 5. Audio never delayed by control recovery                 | **Holds** (one caveat)  | PCM task prio 6 > control 5, separate sockets, PCM reconnect independent. Caveat: PCM _first start_ is gated on the first control READY (`main.cpp:1260-1283`) — acceptable MVP coupling, but a boot into a latched control plane means no audio either |

## 2. Facts vs hypotheses

Proved from source (beyond §0): control outbox/inbox generation fencing is
correct and careful (`itx_transport.c:606-619`, `1241-1306`); READY-gated
backoff reset prevents handshake storms (`itx_transport.c:738-748`); mount
rejection recovers on a fresh generation **[test:
`esp_idf_itx_transport_test.c::mount_rejection_recovers_on_a_fresh_generation`]**;
`kill()` severs both lanes via `ctx.abort()` (`US/worker.ts:96-108`) and the
firmware treats that as an ordinary generation boundary.

Hypotheses needing a test or a physical read:

- **H1** The production Stick is fatal-latched (vs. failing connects
  invisibly). Discriminator: serial read, zero code change. If serial shows
  `websocket_start_attempts` climbing instead, it is C1 from the outage
  report (per-network connect failure) and the errno is already retained.
- **H2** OS keeps exactly one live provision per path across device remounts
  (stale provision could also explain "no capability" if cleanup lags).
  Verify from the OS side with two forced remounts + a capability listing;
  this repo's local test server replaces unconditionally, production OS is
  unverified here.
- **H3** When the device's control session dies, the worker's exported
  callback gets no error/disposal signal it currently observes. Everything in
  `worker.ts` is consistent with "silent strand" and prior physical evidence
  says so, but the OS-side release behavior is unread; the Option A fix does
  not depend on the answer.

## 3. The three options, ranked

### Option A — targeted repairs in the current shape (recommended)

Firmware (all red-first testable in the existing fake-ESP host rig):

1. **Single defer per disconnect.** Delete the `prior_wifi_connected` edge
   branch's defer/double; the `wifi_retry_later` flag branch is the one
   owner (`itx_transport.c:757-784`). While a session was recently live,
   retry flat at ~1 s before escalating (ESPHome-style policy, outage report
   §6.2-F). Also close the watchdog hole: a failed `esp_wifi_connect()` call
   defers via the gate, not a silent 30 s re-arm.
2. **Escalate the fatal latch instead of parking on it.** `main.cpp` observes
   `fatal_failure_latched` on either transport → log once, then
   `esp_restart()` after a bounded grace (~10 s). Separately, demote the
   stack-floor latch to its own counter + escalation: it is a heuristic about
   a recoverable condition, not proof of corruption, and reboot fully heals
   it. Export `esp_reset_reason()` in diagnostics so every escalation is
   attributable after the fact.
3. **Give PCM the Wi-Fi signal.** Pass the control transport's atomic
   `wifi_connected` (read-only pointer) into the PCM transport options; the
   PCM gate does not open while Wi-Fi is down and resets on the rising edge.
   Kills the 16–30 s post-recovery sleep.
4. **Control READY with a new generation requests a PCM restart.**
   One call in `main.cpp`'s READY transition:
   `iterate_kit_esp_idf_pcm_transport_request_restart()`. This makes "PCM
   session replaced" the _single_ userspace re-subscription trigger — the
   worker already builds a fresh subscription per `/pcm` socket, and
   invariant 3 already guarantees the replacement is replay-free. No new
   protocol, no epoch beacon, no OS change.
5. **Diagnostics schema v3** (outage report D6, unchanged): attempt counters,
   disconnect/got-IP timestamps, transport state, latch bit, reset reason.

Worker:

6. **Session-lifetime subscription supervisor.** Replace the finite ladder in
   `#establishDeviceEventSubscription` (`US/worker.ts:313-353`) with a loop
   that retries with capped backoff (250 ms → 8 s) until the PCM session
   closes, logging every attempt with the same codes. Exhaustion becomes
   impossible while a session lives; each attempt stays bounded and counted,
   which is what invariant 4 actually requires. Keep the sequence-gap close
   exactly as is — with (4) it now composes into full re-convergence.
7. Make `US/device-events.ts:94`'s comment true (the supervisor is that
   "surrounding session manager") or rewrite it to describe the close.

Cost: ~150 net firmware lines (including deletions), ~30 worker lines.
Vertical proof: the existing `kill()` drill plus a physical location-move
drill (below). Time-to-proof: ~1–2 days including hardware runs.

### Option B — watchdog-first convergence

Only escalation, no ladder repair: if control is not READY for T (≈90 s)
while Wi-Fi is associated → transport restart; not READY for 2T, or fatal
latch → `esp_restart()`. Smallest possible diff and it makes invariant 1
true _by construction_ (a reboot replaces both sockets, the fresh `/pcm`
session re-subscribes). But it does **not** fix subscription stranding for
control-only remounts that don't reboot (still needs A-4 or A-6), it leaves
17–19 s outages at 17–19 s, and it converts every unnamed defect into an
unexplained reboot unless schema v3 lands with it. Verdict: adopt its
reboot escalation as A-2's last-resort bound; do not adopt it alone.

### Option C — one network owner, two sockets, one retry table

The outage report's §6.2 B+C: a single task owns Wi-Fi lifecycle, both
gates as one policy table, both nonblocking socket pumps; drop the
`esp_transport` data path (and its five-patch override) for an owned
connect/upgrade so the merged owner never blocks 10 s in a handshake.
Deletes a task, a stack, a latch, a gate, the 5-vs-6 priority split, and the
double-defer _class_. This is the right long-term shape — but it is a
multi-day structural change, the outage trigger is still unnamed, and
nothing in the source proves the current shape cannot meet the gate.
Explicitly deferred.

**Ranking.** Time-to-vertical-proof: B > A ≫ C, but B alone is incomplete.
Long-term clarity: C > A > B. **Do A (with B's reboot bound inside it) now;
schedule C after the trigger is named and A's physical drill passes.**

## 4. Regression tests that must fail before each fix

Firmware host suite (`FW/tests/`, ctest via the vitest hook in
`stackchan-simulator.e2e.test.ts` — note the canonical build dir is
`apps/kit/.build/host`; the stale `firmware/build-host*` trees under-run the
suite and still reference the deleted delivery-guard test):

- `esp_idf_itx_transport_test.c::one_disconnect_defers_exactly_one_wifi_attempt`
  — fails today on the double-defer (A-1).
- `esp_idf_itx_transport_test.c::failed_wifi_connect_call_defers_by_gate_not_watchdog`
  — fails today on the 30 s hole (A-1).
- `esp_idf_itx_transport_test.c::fatal_latch_is_visible_and_requests_bounded_restart`
  — fails today: latch is silent and absent from metrics (A-2, A-5).
- `esp_idf_pcm_transport_test.c::wifi_recovery_resets_the_pcm_retry_gate`
  — fails today: the gate is Wi-Fi-blind (A-3).
- Composition-level (new small test against the two transports wired as in
  `main.cpp`): `control_remount_requests_pcm_generation_replacement` — fails
  today: no coupling exists (A-4).

Worker suite (new `US/worker.test.ts` — currently zero coverage of the file
that owns every session/replacement decision):

- `subscription survives a mount that takes longer than sixteen seconds` —
  fails today: the ladder exhausts and falls off the end (A-6).
- `a control-session replacement re-establishes the device event
subscription through a pcm generation replacement` — fails today (A-4+A-6;
  simulate by never delivering events on the first subscription and driving
  a second `/pcm` upgrade, asserting `subscribeToEvents` is invoked again and
  the old bridge got closed with 4001).
- `a device event sequence gap closes the pcm generation` — implemented at
  `US/worker.ts:420-427` but never tested; pin it before touching the file.
- `subscription attempts and failures are retained across the generation
boundary` — pins `#rememberClosedPcm` counters (invariant 4).

## 5. Deletions and simplifications

Already done in this worktree — keep them: `esp_websocket_client` fully
removed; `pcm_peer_delivery_guard.{h,c}` deleted; PONG-based delivery
inference removed from uplink policy (`esp_idf_websocket_policy.h` documents
its absence; the connection still answers PINGs, which is all RFC 6455
requires).

To delete/fix in the A tranche: the double-defer branch; the 30 s silent
watchdog re-arm; the stale `FW/build-host*` / `build-*` CMake trees (one of
which still lists the deleted delivery-guard test); the false resubscribe
comment in `device-events.ts`. Small and non-blocking: give
`retry_gate_test.c` named cases like its siblings; bound `#ensureProvider`
with the same capped backoff as the subscription supervisor.

Not inherited from stackchan (verified against its source): its 12-second
drop-newest output FIFO plus 4-second speaker FIFO (~16 s of accumulable
speech), its 12-try-then-brick Wi-Fi retry, its 3-attempts-then-give-up WS
restart. Worth copying from stackchan: the shape of
`tools/test_realtime_reconnect.py` — N forced reconnect cycles, recovery
within a bound, and the attempt counter must have _strictly increased_ so the
test cannot pass vacuously. Its two-socket analogue here is the `kill()`
drill: invoke the flattened `["kill"]` path, then assert
`getDiagnostics` answers and a remote PTT turn completes within a bound,
with both firmware generation counters advanced.

## 6. Checklist

Near-term (ordered):

- [ ] **Before anything resets the device:** attach the non-resetting serial
      monitor to `70:04:1D:D5:45:88` and read the control transport state —
      names latch vs. failing connects (H1) with zero code change.
- [ ] Write the four failing worker tests + new `worker.test.ts`; land the
      session-lifetime subscription supervisor (A-6, A-7).
- [ ] Write the five failing firmware host tests; land A-1…A-4.
- [ ] Diagnostics schema v3 incl. latch bit + reset reason (A-5 / D6).
- [ ] Vertical proof: `kill()` drill (both lanes replaced → remount +
      re-subscription + PTT turn within bound) and one physical
      location-move drill; retain the evidence per the usual gates.
- [ ] Verify H2 against production OS (two forced remounts → exactly one
      capability at `kit.m5sticks3`).

Explicitly deferred:

- [ ] Option C (single network owner + owned connect/upgrade, drop the
      `esp_transport` override) — after the outage trigger is named.
- [ ] Router/IDF-5.4.3/second-AP A/Bs from the outage report §7.2 step 4.
- [ ] Stale CMake tree cleanup + `firmware-architecture.test.ts` check that
      every `tests/*_test.*` has a matching `add_test`.
- [ ] `retry_gate_test.c` named cases; `#ensureProvider` backoff.
