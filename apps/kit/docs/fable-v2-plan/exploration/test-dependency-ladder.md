# Plan-assumption audit + the test-dependency ladder

Status: written 2026-07-31 evening (snapshot taken ≈19:10; codex was editing
`scripts/device-e2e.ts` as recently as 19:05). Two jobs, per Jonas's
directive of the same evening:

1. **Audit every claim PLAN.md v1.1 makes about codex's v1** against the
   working tree as it stands tonight, marking what is verified, what has
   drifted, and what needs the deeper firmware/host recon passes.
2. **Design the test-dependency ladder**: "the userspace worker in apps/os is
   the last, most expensive bit — a normal local web server behind a
   tunnels.iterate.com tunnel tests 80 % of the functionality with far faster
   turnaround; the test server should share code paths with the config
   worker; test as much as possible with as few dependencies as possible."
   Section 2 below is plan-ready text.

Everything here reads a **moving snapshot**: 61 tracked files under
`apps/kit` are modified-uncommitted and the whole `apps/kit/src/userspace/`
tree is untracked. File mtimes are quoted where freshness matters.

---

## 1. Plan-assumption audit

Legend: **VERIFIED** = checked directly tonight, holds. **DRIFTED** = the
plan's number or wording is stale against tonight's tree. **REFUTED** = the
claim is wrong about today's code. **RECON** = needs the firmware or host
deep-read to settle semantics; noted which.

### 1.1 The headline drift findings (read these first)

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Consequence for PLAN.md                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **There are now TWO host-side PCM proxies, and the deployed one is brand-new.** The rig/local proxy is `src/voice/device-pcm-proxy.ts` (`DevicePcmProxy`, 1,113 lines, modified today 13:17, +308-line uncommitted diff). The deployed proxy is `src/userspace/config-worker/pcm-proxy.ts` (`PcmSessionBridge`, 706 lines, **untracked**, mtime 15:08 today). They share constants but no session code.                                                                                                                                                                                                                                                                                                   | Stage 0's "fix the two live bugs in the deployed v1 /pcm proxy" now points at an ambiguous target; and the ladder's shared-module principle (§2.6) is not just nice-to-have — it is the fix for an already-real duplication.                                                                                                           |
| 2   | **`pcm_peer_delivery_guard` is deleted** (git shows `D` for the .c, .h, and test; codex removed it today).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PLAN §1's verbatim-move list ("pcm_websocket / pcm_lane / uplink conductor + sender / **peer_delivery_guard** moved over VERBATIM") is stale — the module no longer exists. Codex converged with G18 (which mooted the tail-delivery guard) on its own. Remove it from the list.                                                       |
| 3   | **`device-e2e.ts` is 2,746 lines, not 1,752, and growing** (mtime 19:05 tonight; ~+1,465 changed lines uncommitted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §5 layer 2's "FROZEN at 1,752 lines" freezes a moving file at a stale number. The freeze policy survives; the baseline must be re-taken at the G2 codex checkpoint, not from the morning audit.                                                                                                                                        |
| 4   | **"Await `session.updated` before the uplink is live" is NOT v1's deployed shape.** `connectGrokRealtimeVoice` (providers.ts:166-189) sends `session.update` and returns immediately; the bridge forwards mic frames the moment the provider socket is open. `grep -rn 'session.updated' src scripts` matches **nothing**.                                                                                                                                                                                                                                                                                                                                                                                | D8's "Unchanged from v1's deployed shape: … await `session.updated` before the uplink is live" is wrong as a description of today; awaiting `session.updated` is **new v2 work**, and DECISIONS.md should carry the correction.                                                                                                        |
| 5   | **Provider welded to the device socket — confirmed, and stronger than assumed.** `KitVoiceWorker.#handlePcm` (worker.ts:126-252) dials the provider (tone or Grok) _before_ completing the device's WebSocket upgrade, and `#ensureProvider` re-dials it every time it drops, for as long as the device socket lives. In grok mode a Grok session exists whenever `/pcm` is connected.                                                                                                                                                                                                                                                                                                                    | Exactly the requirement-11 violation D8 fixes. VERIFIED — the media-on-demand work is real, not already done.                                                                                                                                                                                                                          |
| 6   | **The deployed `/pcm` terminates on a Durable Object**, not a stateless worker: `KitVoiceWorker extends IterateDurableObject`, holding per-generation in-memory state plus one bounded kv snapshot (`kit:previous-pcm-session`), with a deliberate `kill()`/`ctx.abort()` crash primitive.                                                                                                                                                                                                                                                                                                                                                                                                                | PLAN never claims v1 is stateless, but stage 4 should name the migration explicitly: DO-owned session → per-conversation stateless invocation is a _change of server shape_, with the "one current generation" arbitration (which the DO currently provides) needing a new home.                                                       |
| 7   | **Stage 0's two proxy bugs: one may already be fixed, the other can't exist in the deployed proxy yet.** (a) `device-pcm-proxy.ts:707` now has an explicit oversized-provider-message check (`provider-pcm-message-budget-exceeded`, `#maximumProviderMessageBytes`) — added or present in a file codex touched today. (b) The suppressed-downlink structure that leaks in server-VAD mode is still visibly suspect there (`#suppressDownlink` is cleared only inside the `push-to-talk` branch, :671-677) — but the _deployed_ `PcmSessionBridge` has **no server-VAD mode at all** (manual commits only), so the leak cannot exist in it; the risk is inheriting the pattern when v2 builds server VAD. | Stage 0's own "re-check both bugs are still present at execution time" is not a formality — it is due now, and the fix location has moved. The real stage-0/4 obligation: the v2 media session's server-VAD path must clear suppression on `response.created`/`response.done` regardless of input mode, with a rung-1 regression test. |
| 8   | **`atomic.h` already exists and is tracked** (`firmware/components/core/include/iterate/kit/atomic.h`, a documented relaxed-only helper set), while at least `spsc_ring.c` still hand-rolls its own copies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Stage 0's "merge the 8 copies into `atomic.h`" is partially done by codex; the remaining count needs the firmware recon. The stage-0 item shrinks.                                                                                                                                                                                     |
| 9   | **Firmware event/PTT vocabulary is still v1.** `push_to_talk.c/h` exist; `main.cpp:1224` publishes push-to-talk events; the deployed worker closes the PCM generation on a "Push-to-talk event sequence gap" (worker.ts:426) and runs Grok with `turnDetection: "manual"` (worker.ts:259 → `turn_detection: { type: null }`, providers.ts:184).                                                                                                                                                                                                                                                                                                                                                           | VERIFIED: the call-model transition (G18) has not started — as DECISIONS §7 honestly notes. `providers.ts` already accepts `"server-vad"` as an option, so the provider seam for §2 exists.                                                                                                                                            |
| 10  | **Stream posting is a stub.** The worker subscribes to device events via the capability path `["kit","m5sticks3","subscribeToEvents"]` and logs each one with `wouldPostToStream: true` — "no durable stream semantics are implied" (worker.ts:386-399). No outbox, no stream processor, no cross-posting exists.                                                                                                                                                                                                                                                                                                                                                                                         | VERIFIED — stage 4's worker items are genuinely new work; nothing to generalize in place on the posting side.                                                                                                                                                                                                                          |

### 1.2 Claim-by-claim table

Wire and transport:

| Claim (PLAN location)                                                                                   | Status       | Evidence                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCM wire v1: mono S16LE 16 kHz, 20 ms / 640-byte frames, empty-message end-of-stream (ground rules, §1) | VERIFIED     | `pcm-proxy.ts:1-3` (640, 16 kHz, subprotocol `iterate.kit.pcm.v1`), `:27` (`pcmEndOfResponse = new Uint8Array(0)`); firmware side needs no re-check (unchanged constants)                                                                                                                                      |
| Two websockets `/api` + `/pcm`, `/api` = Cap'n Web (§1)                                                 | VERIFIED     | `routes.ts` — `/api` is a byte-for-byte reverse proxy to `os.iterate.com`, `/pcm` goes to the DO                                                                                                                                                                                                               |
| v1 subprotocol negotiation seam for pcm.v2 (D7)                                                         | VERIFIED     | worker.ts:133-137 rejects upgrades without the v1 subprotocol — the negotiation point D7 needs exists                                                                                                                                                                                                          |
| Ephemeral secret minting unchanged (D8)                                                                 | VERIFIED     | providers.ts:130-157 — mint via `https://api.x.ai/v1/realtime/client_secrets`, 1 h expiry, long-lived key only as an egress placeholder (`Bearer getSecret("/secrets/kit/xai-api-key")`)                                                                                                                       |
| Await `session.updated` unchanged (D8)                                                                  | **REFUTED**  | headline finding 4                                                                                                                                                                                                                                                                                             |
| Provider death → clean device end-of-stream unchanged (D8)                                              | RECON (host) | `PcmSessionBridge.#detachProvider` discards the queue and triggers a provider re-dial; no end-of-stream frame is sent to the device on provider death (EOS is sent only on `response.done`/interrupt paths). Likely also new v2 work, not preserved behavior — host recon to confirm against the rig proxy too |
| Delivery-mode knob exists; today's default is host-paced (stage 0)                                      | VERIFIED     | `device-pcm-proxy.ts:82` (`"device-clocked" \| "host-paced"`), `:315` (`?? "host-paced"`). Nuance: the deployed `PcmSessionBridge` is a third shape — a 20 ms admission clock with an 8-frame device lead, I2S remaining the playout clock (pcm-proxy.ts header comment)                                       |

Firmware structure and resources:

| Claim                                                                                                                                                 | Status             | Evidence                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CPU at 160 MHz today (stage 1)                                                                                                                        | VERIFIED           | sdkconfig: `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=160`                                                                                                                                                             |
| Octal PSRAM at half speed (stage 1)                                                                                                                   | VERIFIED           | `CONFIG_SPIRAM_SPEED=40`, `SPIRAM_SPEED_80M` not set                                                                                                                                                         |
| lwIP tcpip task floats across cores (stage 2)                                                                                                         | VERIFIED           | `CONFIG_LWIP_TCPIP_TASK_AFFINITY_NO_AFFINITY=y`                                                                                                                                                              |
| Wi-Fi IRAM options both already on (stage 1)                                                                                                          | VERIFIED           | `CONFIG_ESP_WIFI_IRAM_OPT=y`, `CONFIG_ESP_WIFI_RX_IRAM_OPT=y`                                                                                                                                                |
| Power management off today (stage 3 tripwire premise)                                                                                                 | VERIFIED           | `CONFIG_PM_ENABLE` not set                                                                                                                                                                                   |
| `bounded_playback.hpp` verified-dead, −772 lines (stage 0)                                                                                            | VERIFIED (wording) | header is 389 lines + test 383 = 772 with its test; PLAN's phrasing compresses "file + test" into the filename                                                                                               |
| Unused half of `websocket_text` −480 (stage 0)                                                                                                        | RECON (firmware)   | file 538 + test 413 lines exist; the −480 is the egress/ingress half incl. tests with ~300 residual (audit §b2); "still unused" needs re-check — core files changed today                                    |
| Unused capnweb surface −350 (stage 0)                                                                                                                 | RECON (firmware)   | `responder.c` exists; **codex modified `capnweb.h` and `value.c` today** (+14 lines in value.c) — the dead-surface list must be re-derived before deleting, exactly as stage 0's "after a double-check" says |
| ~40 copy-pasted CMake test stanzas, −710 (stage 0)                                                                                                    | VERIFIED           | 38 `add_executable` stanzas in `firmware/CMakeLists.txt`                                                                                                                                                     |
| 8 hand-written atomics copies merge into `atomic.h` (stage 0)                                                                                         | DRIFTED            | headline finding 8 — `atomic.h` already exists/tracked; remaining copy count needs firmware recon                                                                                                            |
| Capture on the priority-1 main task; two tick-polling loops; PCM retry gate resets on mere TCP connect; `pcm_transport_start` once per boot (stage 2) | RECON (firmware)   | `pcm_transport.c` and `itx_transport.c` were both modified by codex today — every stage-2 bug-liveness claim needs re-verification at execution time, not just re-assertion                                  |
| `metrics.c` is 1,510 lines with three hand-written schema copies (stage 3, D4)                                                                        | VERIFIED ±         | 1,508 lines tonight (123-line uncommitted diff today); copy count needs firmware recon after codex's edits                                                                                                   |
| `main.cpp` baseline ≈1,349 → target ≈700 (§1)                                                                                                         | VERIFIED ±         | 1,347 lines tonight (105-line diff today)                                                                                                                                                                    |
| Layer-1 coverage holes: errno classifier + URL parser in `websocket_connection.c`, envelope unwrap in `peer.c` (§5)                                   | RECON (firmware)   | `peer.c` modified today — holes may have moved                                                                                                                                                               |
| Six acoustic thresholds spelled in ≥3 files (§5)                                                                                                      | RECON (host)       | not re-checked tonight                                                                                                                                                                                       |
| DIRAM budget 142,465 B static / ~77.8 KiB heap (D6)                                                                                                   | RECON (firmware)   | from the morning's contention-knobs pass; 61 firmware files changed since — re-measure at each stage boundary as PLAN already prescribes                                                                     |

Events, capabilities, worker:

| Claim                                                                                       | Status               | Evidence                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex is writing `device_event_stream` right now (D6, stage 4)                              | VERIFIED ±           | exists, **untracked**, 549 lines + 104-line header, but stable since 09:51 this morning — "being written" has become "written, not landed". D6's trigger (b) ("codex's event work has landed and stabilized") is closer than the plan's phrasing implies |
| `callback_budget` capability exists (§1 verbatim list)                                      | VERIFIED             | untracked, 43 lines + header                                                                                                                                                                                                                             |
| camera / leds / servos / screen exist (§1)                                                  | VERIFIED             | all present in `components/capabilities`                                                                                                                                                                                                                 |
| v1 firmware implements push-to-talk semantics (§2, DECISIONS §7)                            | VERIFIED             | headline finding 9                                                                                                                                                                                                                                       |
| Two Sticks on one project collide / no per-device id (D5)                                   | RECON (host)         | worker session ids are `projectId:uuid` per connection; device-identity story needs the host recon                                                                                                                                                       |
| `StreamEventInput` shape verified against `packages/iterate/src/processors/schemas.ts` (D5) | VERIFIED (existence) | file exists at that path; field-shape re-verification belongs to the host recon                                                                                                                                                                          |
| Stream outbox / kit stream processor / cross-posting do not exist yet (stage 4)             | VERIFIED             | headline finding 10                                                                                                                                                                                                                                      |
| Userspace worker = zero apps/os changes (§1)                                                | VERIFIED (direction) | `scripts/install-userspace-worker.ts` installs the config worker's seven source files through the project API key (`installKitVoiceUserspace`); no apps/os edits involved                                                                                |
| −18 dB rail-sag fix uncommitted (OPEN-QUESTIONS §4)                                         | VERIFIED             | `m5sticks3_direct_audio.cpp` modified-uncommitted; providers.ts:6-17 documents −18 dB as the operative measured ceiling                                                                                                                                  |

### 1.3 What the audit changes in PLAN.md (summary for main)

- §1 layout: drop `peer_delivery_guard` from the verbatim list; note `atomic.h`
  exists.
- §3 D8: correct the "unchanged from v1's deployed shape" list — only secret
  minting survives verification; `session.updated` awaiting and clean EOS on
  provider death are new work. Correction entry belongs in DECISIONS §5.
- §4 stage 0: retarget the two bug fixes (one likely fixed, one now a
  design rule for the v2 server-VAD path); shrink the atomics item.
- §4 stage 4: name the DO→stateless-invocation migration and the new home for
  "one current generation" arbitration.
- §5: re-baseline `device-e2e.ts` at the G2 checkpoint; add §2 below as the
  dependency axis.

---

## 2. The test-dependency ladder (plan-ready)

> Proposed home: a new subsection of PLAN §5, after the three layers. The
> ladder is **the dependency axis of layer-2 and layer-3 testing** — it says
> _which host the device (or simulated device) talks to_, from fewest
> dependencies to most. It does not replace the layers: layer 1 is rung 1 by
> definition, and every layer-2 rig scenario and layer-3 checklist run states
> which rung it runs on. Default rung for everything: the lowest one that can
> express the scenario.

### 2.1 The rule

**A bug reproducible on rung N is fixed and regression-tested at rung N,
never higher.** When a bug first appears at rung N+k, the first move is to
drive it _down_ the ladder to the lowest rung that reproduces it; the
regression test lives at that rung forever. Corollary: a scenario is promoted
up the ladder only for what the higher rung uniquely provides, and the
promotion says what that is.

Lower rungs are not merely cheaper — they are _different_, and each
difference catches bugs its neighbors mask. Tonight's deployed proxy carries
the proof in its own comments: the scratch-buffer aliasing bug ("a whole
provider burst arrived as repeated copies of its final frame") was invisible
in production workerd, which happens to snapshot sends eagerly, and was
caught **through the captun tunnel** whose standards-shaped sockets retain
the view (pcm-proxy.ts:515-521). The expensive rung masked it; the cheap rung
exposed it.

### 2.2 The rungs

**Rung 1 — pure host unit tests. No network, no device, no runtime beyond
Node/native.** Vitest with captun's in-memory `WebSocketPair` for everything
Workers-shaped; the native cmake host tests with pthread fakes for firmware
C. Today's seeds: `config-worker/*.test.ts` already drive the deployed
`PcmSessionBridge` through in-memory socket pairs; the firmware host suite.

- _Proves:_ session/bridge logic, pacing math under fake timers, frame
  validation, provider control fences (commit → committed → response.create),
  event codecs and golden-log diffs, every fail-closed rule.
- _Cannot prove:_ real TCP backpressure (captun fakes omit `bufferedAmount` —
  the bridge's tolerant `socketBufferedAmount()` treats absent as zero, so
  every backpressure branch is untestable here), workerd runtime semantics,
  wall-clock timing, anything acoustic.
- _Turnaround:_ <5 s native, <30 s warm vitest.

**Rung 2 — a local Node web server on the LAN; the device connects
directly.** The same fetch-handler code served over real TCP by
`local-fetch-websocket-server.ts` (Node http + ws adapting Workers-shaped
`fetch(Request) → Response` including WebSocket upgrades). This is what
`device-e2e.ts` runs today: `LocalDevicePeerServer` behind the Node adapter,
the Stick pointed at the laptop's LAN address. Zero external dependencies:
no Cloudflare, no apps/os, no tunnel; the provider is the deterministic
tone/fixture provider by default, or real Grok dialed straight from the
laptop when the scenario is about the provider. The firmware simulator can
stand in for the device to exercise the server across real TCP without
hardware.

- _Proves:_ the full wire contract against a real device — real TCP
  backpressure and buffering, real Wi-Fi jitter, the chip-exact acoustic
  oracles, reconnect/churn drills, capture starvation, all six new rig
  scenarios, the layer-3 checklist. **This is where ~80 % of stage-2 and
  stage-4 functionality is provable.**
- _Cannot prove:_ workerd/DO semantics (eviction, CPU limits, `waitUntil`,
  native socket behavior), the public-internet path, real project-token
  auth, egress secret substitution, stream posting.
- _Turnaround:_ server starts in <1 s; edit-to-retest ~10 s including device
  reconnect; acoustic scenarios take the minutes their audio takes.

**Rung 3 — the same local server behind a tunnels.iterate.com captun
tunnel.** One flag on the same run (`device-e2e.ts --tunnel-name`,
`CAPTUN_GATEWAY`). Adds exactly one dependency: the public edge.

- _Proves:_ everything rung 2 proves, plus public-URL realism — internet RTT
  and jitter on the real path, TLS, tunnel-edge WebSocket behavior
  (standards-shaped socket semantics that already caught the aliasing bug),
  the device configured exactly as it is against production.
- _Cannot prove:_ workerd/DO semantics, real token/secret/stream paths.
- _Turnaround:_ rung 2 plus a few seconds of tunnel establishment; the edit
  loop stays fully local.

**Rung 4 — miniflare/workerd hosting the ACTUAL config-worker module,
locally.** New (nothing runs this today; `wrangler` is already a dependency
of apps/kit). Load the same seven files the installer uploads —
`worker.ts`, `pcm-proxy.ts`, `providers.ts`, `routes.ts`, … — into local
workerd with a stubbed `env.ITX` (a small local object implementing
`get()` → `{ projectId, secrets, kv, egress.fetch, capabilityHosts }`).
Point the device (or simulator) at it directly or through the rung-3 tunnel.

- _Proves:_ workerd runtime semantics on the shipped module — DO lifecycle
  and the one-current-generation arbitration, `ctx.waitUntil`, `ctx.abort`,
  native workerd WebSockets with real `bufferedAmount` (the strict branches
  rung 1 cannot reach), CPU-time behavior of the pacing loop, the `#log`
  shape.
- _Cannot prove:_ real project-token minting and auth against OS, real
  egress `getSecret` substitution, capability routing through the platform,
  stream commits, production dispatch headers.
- _Turnaround:_ ~10-30 s per restart; scenarios cost the same as rungs 2-3.
- _Build note:_ the itx stub is the only real work here, and it is the same
  stub rung 2 wants for credential/`readMode` dependencies — build it once.

**Rung 5 — a real apps/os project with the userspace worker installed. The
last, most expensive rung.** `scripts/install-userspace-worker.ts
--project-id … --apply` against a preview or production project.

- _Proves:_ the residue only this rung can — real project API-key auth end
  to end, egress placeholder substitution against live xAI, the capability
  path to the mounted device through the platform, stream posting once
  built, worker-dispatch headers, cold starts across real DOs, and the
  full-proof acceptance runs (PLAN §7).
- _Cannot prove faster than the rungs below it:_ anything else — and it
  actively masks some bugs (finding in §2.1).
- _Turnaround:_ minutes per iteration — install roundtrip, deployed-log
  access, shared-environment coordination, xAI spend. Use it for acceptance
  and for the five integration seams above; never for logic debugging.

Orthogonal to all rungs, the **provider axis**: deterministic tone /
recorded fixtures by default; live Grok only when the scenario is about the
provider. Every rung supports both (rung 1 uses the tone provider's socket
pair directly). Dependencies — workerd runtime, public network, apps/os,
xAI — toggle independently; a scenario states the minimal set it needs.

### 2.3 One media-session module for every rung

The local server and the userspace config worker **share one media-session
module** — the code that owns a device PCM socket, its per-conversation
provider leg, the pacing, the suppression/gating, and the diagnostics — so
rungs 2-4 exercise the same code that ships at rung 5, differing only in
adapters and injected dependencies.

Today's tree is the seed _and_ the cautionary tale. The seams already exist:
`routes.ts`'s `handleKitVoiceRequest` takes injected
`fetchApi`/`handlePcm`/`readMode` dependencies; `PcmSessionBridge` is
already written runtime-portable (its tolerant `readyState`/`bufferedAmount`
helpers exist precisely so captun fakes and native workerd sockets both
work); `local-fetch-websocket-server.ts` already turns any fetch handler
into a real LAN server. But the session logic itself is duplicated:
`DevicePcmProxy` (rig, has server-VAD and device-clocked modes) and
`PcmSessionBridge` (deployed, manual-commit only, admission-clock pacing)
have already diverged in one day. The v2 media session (D8, stage 4) is
written once, as the merge of the two, with the union of their modes; the
local server becomes the Node adapter around it plus local dependency
implementations; `DevicePcmProxy` is deleted at parity. From then on a
rung-2 pass is direct evidence about shipped code, not about a lookalike.

### 2.4 Where each planned piece of work sits

| Work                                                                                                                                            | Home rung                                              | Escalates to                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Media-session logic: on-demand provider dial, idle hangup, `session.updated` gate, EOS on provider death, speak-state gating, suppression rules | 1                                                      | 2 (real device timing), 4 (workerd), 5 (acceptance)       |
| Stage-2 reconnect fixes + churn scenarios; capture-starvation gate                                                                              | 2                                                      | 3 (public-path churn), nightly rig                        |
| PCM v2 header + timestamp echo (D7)                                                                                                             | 1 (codec) → 2 (±0.5 ms alignment vs PRBS ground truth) | —                                                         |
| Acoustic scenarios (tone, PRBS, AEC proof, barge-in stopwatch)                                                                                  | 2                                                      | — (bit-transparent path makes higher rungs add nothing)   |
| Call-model capability + device events (stage 4 firmware↔worker contract)                                                                        | 1 (golden logs) → 2                                    | 5 (capability path through platform)                      |
| Event outbox + stream posting                                                                                                                   | 1 (fake stream) → 4 (workerd + itx stub)               | 5 (real stream commits, idempotency against the platform) |
| Layer-3 manual checklist                                                                                                                        | 2 or 3                                                 | 5 once per release, as the acceptance pass                |
| DO→stateless migration behavior, `kill()` recovery                                                                                              | 4                                                      | 5                                                         |

### 2.5 Relation to the three layers, restated

Layer 1 _is_ rung 1. Layers 2 and 3 are scenario sets; the ladder is where
their server side runs. The six new rig scenarios all land on rung 2 by
default; a scenario names a higher rung only by stating what that rung
uniquely provides (public path → 3, workerd semantics → 4, platform
integration → 5). The §7 done-list is the only work that _requires_ rung 5.
