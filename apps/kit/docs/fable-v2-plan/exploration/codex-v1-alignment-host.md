# Codex v1 alignment — host & worker delta recon

Snapshot taken 2026-07-31 ~19:15 BST against the live c-capabilities worktree.
Codex is actively editing (`scripts/device-e2e.ts` mtime 19:05, minutes before
this read; `config-worker/*` 15:07–15:08; `voice/device-pcm-proxy.ts` 13:17).
Everything below is a moving snapshot: re-grep before acting on a line number.
Scope: the host/worker side only — `src/userspace/config-worker/`,
`src/voice/device-pcm-proxy.ts`, `src/device/local-device-peer-server.ts` +
`local-fetch-websocket-server.ts`, `scripts/device-e2e.ts`, and the install
path. Firmware delta is a separate recon.

The headline: **codex has already built a real chunk of what the plan
schedules as stage-4 worker work** (provider/device lifetime split, the PTT
commit-ack fence), **one of the two flagged lab-proxy defects is fixed and one
is not**, and **the local-server-vs-tunnel duality Jonas points at already
runs one shared fetch handler across both transports** — the missing piece is
only that the local `/pcm` lane runs a different PCM implementation than the
deployed worker.

---

## 1. Facts table: plan assumption → current reality → impact

| #   | Plan/exploration assumption                                                                                                                                                                                                                                                                                                                       | Reality in the tree right now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Impact on the plan                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The deployed `/pcm` proxy welds provider lifetime to the device socket** (`proxy-session-economics.md` §0.2; `transport-track-adversarial-findings.md` W1 blocker: "PcmSessionBridge takes exactly one device WS + one provider WS and device-close tears down the whole session"; provider death → 1011 cascade at old `pcm-proxy.ts:104-110`) | **No longer welded.** `PcmSessionBridge.attachProvider()` (`pcm-proxy.ts:197-236`) installs a fresh provider generation without disturbing the device lane; `#detachProvider` (`:599-616`) survives provider close/error, discards the downlink queue, and calls `onProviderUnavailable`; the worker's `#ensureProvider` (`worker.ts:263-311`) then re-dials with attempt counters. Provider death **does not** close the device socket. Stale-generation events are fenced by socket identity (`:222`). Device close still ends everything (correct direction).                                                                                                                                                                                                                                                                                                                                                                                                                         | The W1 "hidden dependency on stage 4's D8 split" has substantially shrunk: the device-connection/provider-session seam **exists in deployed code today**. D8's remaining delta is the _economics_, not the seam — see row 2. Rewrite the D8 stage-4 text as a delta on top of `attachProvider`, not as introducing the split. |
| 2   | D8 worker work list: dial-on-conversation-start, idle hangup, await `session.updated`, clean device end-of-stream on provider death                                                                                                                                                                                                               | Still missing, precisely: (a) the provider is **still dialed inside the device's WebSocket upgrade** and a dial failure still 502-rejects the upgrade (`worker.ts:151-168`); (b) re-dial triggers are only provider-detach and PTT press/release — a mic frame with no provider is dropped with a `provider-unavailable` diagnostic but does **not** trigger a dial (`pcm-proxy.ts:313-324`); (c) no idle timer / DO alarm anywhere; (d) provider death discards the downlink but sends **no end-of-stream marker** to the device — the device is left mid-response without EOS (`#detachProvider` never calls `#sendDevice(pcmEndOfResponse)`); (e) `session.update` is still fire-and-forget, zero `session.updated` handling anywhere in the tree (grep clean; `providers.ts:167-189`).                                                                                                                                                                                               | D8 is still real work, but its item list should be restated: seam done; dial-on-demand, uplink-demand trigger, idle hangup, `session.updated` await, and clean-EOS-on-provider-death remain.                                                                                                                                  |
| 3   | The two `wouldPostToStream:true` seams live at `worker.ts:245-253` and `:269` (cited in arch-a, arch-c, os-streams, synthesis)                                                                                                                                                                                                                    | Both seams still exist, **moved**: device events at `worker.ts:383-399` (inside `#subscribeToDeviceEvents`, same "WOULD be cross-posted" comment) and provider events at `worker.ts:407-412` (`#onPcmDiagnostic`, `wouldPostToStream: diagnostic.code === "provider-event"`). Bonus third seam: the **local harness** now logs `would_post_to_stream event=…` per provider event too (`device-e2e.ts:482`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Requirement-8 replacement plan intact; update every line citation. The harness echo means golden-log work can diff local and deployed streams against the same vocabulary.                                                                                                                                                    |
| 4   | PTT commit race: worker sends `input_audio_buffer.commit` and `response.create` back-to-back (a flagged risk)                                                                                                                                                                                                                                     | **Fixed in the worker, not in the lab proxy.** Worker: `inputStopped()` sets `#responseAfterCommitPending` and sends only `commit`; `response.create` goes out on the `input_audio_buffer.committed` ack (`pcm-proxy.ts:264-283`, `:383-388`); a new press supersedes an unacked release (`:244-262`); the tone provider now acks `committed` so tone mode exercises the same fence (`providers.ts:87-101` — the comment records that a mock skipping the ack deadlocked every real PTT release). Lab proxy still sends both back-to-back (`device-pcm-proxy.ts:499-516`).                                                                                                                                                                                                                                                                                                                                                                                                               | The worker is now the _reference implementation_ for the commit path. Under the v2 call model (server VAD everywhere) this whole class dies anyway, but until v2 firmware is the fleet, any local testing of PTT semantics through the lab proxy tests the **wrong** state machine. Another argument for §4 below.            |
| 5   | R9 defect: `#suppressDownlink` leak at `device-pcm-proxy.ts:429` — "a text turn in server-vad mode blackholes downlink forever"                                                                                                                                                                                                                   | **Still present.** Codex HAS modified the file (+308 lines vs HEAD — contradicting OPEN-QUESTIONS §13's "NOT in the modified set"), but the leak survives: field declared `:431`, set unconditionally in `requestTextResponse` (`:531`), cleared only at `:676` inside the `#inputMode === "push-to-talk"` branch of `response.created`. A server-vad session that takes a text turn never re-opens downlink. Mitigating: every current physical voice run passes `pcmInputMode: "push-to-talk"` (`device-e2e.ts:515`), so the leak is latent, not biting.                                                                                                                                                                                                                                                                                                                                                                                                                               | Keep on the wave-0 fix list (v2 runs server-VAD everywhere, so the latent branch becomes the hot path). One line of the two-defect list survives.                                                                                                                                                                             |
| 6   | R9 defect: 64 KiB provider-message admission vs the small downlink ring (`device-pcm-proxy.ts:238`)                                                                                                                                                                                                                                               | **Fixed.** `maximumProviderMessageBytes` now defaults to the downlink reservoir itself (`:320-328`, comment cites a real 73,400-byte Grok message that the old magic number cut mid-sentence) and is validated to never exceed it (`:216-223`). The reservoir also grew: `defaultMaximumDownlinkFrames = 400` (`:20`) = 256,000 B, startup watermark 3 frames default / 32 in device-clocked physical runs. Oversized messages now die with a distinct `provider-pcm-message-budget-exceeded` close (4013) instead of a mislabeled overflow (`:625-633`, `:707-709`).                                                                                                                                                                                                                                                                                                                                                                                                                    | Delete from the wave-0 list. Only the row-5 defect remains.                                                                                                                                                                                                                                                                   |
| 7   | `device-e2e.ts` is "1,752 lines, physically proven, FROZEN; new scenarios are sibling scripts"                                                                                                                                                                                                                                                    | Now **2,746 lines** and the most actively edited file in the tree (mtime 19:05 — during this recon). New since the count: `--physical-voice-turns` (finite Grok conversation from physical Button A, spoken run boundaries through the Stick), `--network-device-host`, playback endurance ladder, PRBS31, playback-recovery proof, control-churn, device-clocked delivery flags. The sibling-script pattern _also_ exists (`prove-production-m5sticks3-grok.ts` 31 KB, `…-tone.ts`, `…-grok-from-device.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The freeze decision needs restating against a file ~1,000 lines bigger than the one the plan froze. The decomposition question (OPEN-QUESTIONS: "decompose device-e2e.ts now → −600 lines") is getting more expensive weekly.                                                                                                 |
| 8   | Config-worker file sizes per `proxy-session-economics.md` §0.1: worker 320 / pcm-proxy 372 / providers 313                                                                                                                                                                                                                                        | Now **490 / 706 / 336** + `device-events.ts` 160 + `routes.ts` 122 (all with sibling tests, 7 files installed). New surface the plan doesn't mention: `kill()` — deliberate DO abort as an operational/test primitive severing all sockets (`worker.ts:96-108`); `pcmMetrics()` with a **persisted previous-session snapshot** in DO `storage.kv` surviving eviction (`:439-465`); a device-event subscription retry ladder 0→8 s tolerating `/pcm`-before-mount cold-boot ordering (`:313-353`); PTT sequence-gap → visible close 4002 rather than guessing (`:414-428`).                                                                                                                                                                                                                                                                                                                                                                                                               | These are exactly the "generation boundary is visible, never silent" mechanisms the plan asks stage 4 to guarantee. Cite them as existing, not future.                                                                                                                                                                        |
| 9   | Lab (`DevicePcmProxy`) and worker (`PcmSessionBridge`) are two unrelated implementations drifting apart                                                                                                                                                                                                                                           | Still two implementations, but they have **converged on constants and started sharing modules**: worker constants 400-frame reservoir / 32-frame watermark / 8-frame device lead (`pcm-proxy.ts:23-27`) exactly match the lab's device-clocked physical configuration (`device-e2e.ts:124`, startup frames 8/32); `device-e2e.ts` now imports and drives the **worker's** `subscribePcmBridgeToDeviceEvents` from `config-worker/device-events.ts` (`device-e2e.ts:104-107`, `:944-967`); the production proof scripts import the worker's `PcmSessionMetrics`/`DeviceEventSessionMetrics` types and `kitVoiceWorkerRef`. Still duplicated: the PCM session core, the Grok dialer (host `grok-realtime-voice.ts` uses the raw key; worker mints a short-lived client secret through the egress placeholder, `providers.ts:124-194`), the `/health`+`/pcm`+`/api` routing, and the `ITERATE_KIT_PCM_SUBPROTOCOL` constant (defined in both `device-pcm-proxy.ts:5` and `pcm-proxy.ts:3`). | Code-sharing is already codex's direction of travel. §3/§4 below say what to unify next.                                                                                                                                                                                                                                      |
| 10  | (implicit in the plan's test story) testing worker behavior requires the deployed userspace worker                                                                                                                                                                                                                                                | **The worker's PCM core already runs in plain Node vitest**: `pcm-proxy.test.ts` (429 lines) instantiates `PcmSessionBridge` against captun's `WebSocketPair`; `pcm-proxy.ts:669-690` deliberately tolerates captun's standards-shaped sockets (`readyState === undefined` ⇒ open, absent `bufferedAmount` ⇒ 0). `routes.ts`, `providers.ts` (via `createPair`/`createWebSocket`/`fetchCredential` injection), and `device-events.ts` are dependency-injected and Node-tested too. Only `worker.ts` itself (the DO shell) requires workerd.                                                                                                                                                                                                                                                                                                                                                                                                                                              | This is the load-bearing fact for Jonas's test-ladder directive: ~80% of worker behavior is already testable with zero deployment. See §4.                                                                                                                                                                                    |

Line numbers verified at snapshot time; treat as anchors to re-grep, not as
stable references.

---

## 2. What each side is, today

**Deployed path** (installed by `scripts/install-userspace-worker.ts`): seven
TS source files copied verbatim into the project's config repo as
`apps/kit-voice/*` plus a managed root `worker.ts` that routes
`x-iterate-app: kit` to the dynamic worker (`install-plan.ts:14-33`,
`install.ts` — secret pinned first, source committed second, mode KV flipped
last). No wrangler config, no bundler: OS's dynamic worker loader hosts the
TS directly. `KitVoiceWorker extends IterateDurableObject`; `/api` is a
byte-for-byte reverse proxy to a **hard-coded** `https://os.iterate.com`
(`routes.ts:30-31`) with platform routing headers stripped; `/pcm` is the
device←→provider bridge; device events arrive via
`project.capabilityHosts.get("/").invokeCapability({path: ["kit","m5sticks3","subscribeToEvents"]})`.

**Local path** (`device-e2e.ts` and friends): `LocalDevicePeerServer` (147
lines) exposes the same three routes from one `fetch(request)`: `/health`,
`/pcm` → `DevicePcmProxy` (the 1,113-line lab proxy), `/api` → a capnweb
session hosting the peer root directly (the laptop _plays OS_). The physical
device dials it exactly as it would dial production.

**The transport duality Jonas points at already exists and is deliberate.**
One `server.fetch` is fronted by either:

- `LocalFetchWebSocketServer.listen({fetch: (r) => server.fetch(r), host, port})`
  (`device-e2e.ts:554-584`) — 697 lines of Node `http`+`ws` that host a
  Workers-shaped fetch/WebSocket handler on a real LAN socket, with per-socket
  bridge metrics (payload-in-flight, send-callback latency, control-message
  trace); or
- `createCaptunTunnel({fetch: (r) => server.fetch(r), gateway, name, token})`
  (`device-e2e.ts:590-597`) — the same handler behind a stable
  tunnels.iterate.com URL.

The in-tree comment states the intent verbatim (`device-e2e.ts:547-553`):
"This route deliberately reuses the exact same fetch handler and peer state
as Captun. Only the runtime transport changes." Captun's `WebSocketPair` /
`createWebSocketResponse` are the common socket fabric on the Node side;
workerd's natives serve the same shapes in production.

**What is shared vs duplicated across the two paths right now:**

| Concern                                                                                | Local harness                                                                                                                       | Deployed worker                                                                                                                                  | Status                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device-event subscription state machine (snapshot, sequence gaps, press/release edges) | `subscribePcmBridgeToDeviceEvents`                                                                                                  | same function                                                                                                                                    | **shared** (worker module imported by the harness)                                                                                                                                                                                              |
| PCM session core                                                                       | `DevicePcmProxy` (PTT no ack fence; server-vad text-turn leak; session Map; host-paced + device-clocked modes; rich observer hooks) | `PcmSessionBridge` (commit-ack fence; provider generation replacement; single session; device-clocked-equivalent only; diagnostics channel only) | **duplicated + diverged** — worker is ahead on correctness, lab is ahead on observability hooks (`onPcmFrame`, `onSocketClose`, `onDownlinkResponseComplete`, `requestTextResponse` spoken cues) that the physical evidence pipeline depends on |
| Grok dial                                                                              | raw `XAI_API_KEY` (`grok-realtime-voice.ts`)                                                                                        | short-lived client secret minted through egress `getSecret(…)` placeholder (`providers.ts`)                                                      | duplicated; both fire-and-forget `session.update`                                                                                                                                                                                               |
| Deterministic providers                                                                | tone/PRBS classes in `src/voice/`                                                                                                   | `connectDeterministicTone` in `providers.ts` (with commit-ack behavior)                                                                          | duplicated                                                                                                                                                                                                                                      |
| Routing `/health` `/pcm` `/api`                                                        | inline in `LocalDevicePeerServer.fetch`                                                                                             | `routes.ts`                                                                                                                                      | duplicated (small)                                                                                                                                                                                                                              |
| Auth                                                                                   | `authenticate(projectId, bearer)` callback; bearer accepted via header or `iterate-bearer.` subprotocol                             | `authenticateProjectBearer` against project secrets; header only                                                                                 | same shape, different credential source; subprotocol-vs-header asymmetry worth one glance                                                                                                                                                       |
| Wire constants                                                                         | `pcmFrameBytes = 640` literal; own `ITERATE_KIT_PCM_SUBPROTOCOL`                                                                    | `ITERATE_KIT_PCM_FRAME_BYTES` etc. in `pcm-proxy.ts`                                                                                             | duplicated — the stage-3 "one table generates C and TS" item should also kill this TS/TS duplication                                                                                                                                            |
| `/api` meaning                                                                         | hosts the capnweb peer locally                                                                                                      | reverse proxy to OS                                                                                                                              | structurally different **by role** — the local server is OS-plus-worker in one process; the seam that abstracts it is exactly `subscribeToDeviceEvents` + `authenticate`, both already extracted                                                |

---

## 3. The test ladder as it exists (cheapest → most expensive)

1. **Node vitest, zero deps** — worker modules run against captun socket
   pairs (`pcm-proxy.test.ts`, `providers.test.ts`, `routes.test.ts`,
   `device-events.test.ts`) plus the whole lab-proxy suite. Seconds.
2. **Local Node server, direct LAN** — real firmware (or the simulator)
   dials `LocalFetchWebSocketServer` on the laptop. No cloud dependency at
   all; Grok optional (tone/PRBS providers). Isolates device/audio timing
   from tunnel cadence; exposes the device's LAN address for the network
   monitor.
3. **Same fetch handler behind the captun tunnel** — adds real Internet,
   TLS, and reconnect adversity; still zero OS/userspace deployment. Needs
   only `CAPTUN_TOKEN`.
4. **Deployed userspace worker** — `install-userspace-worker.ts --apply`
   into a real project, then `prove-production-m5sticks3-grok.ts` /
   `…-tone.ts` (full acoustic + network evidence, human button provenance or
   `--remote-ptt`). This is the rung that costs a deploy cycle, a project,
   OS availability, and physical attendance.

Rungs 1–3 exist and are exercised daily. The gap Jonas names is that rungs
2–3 run `DevicePcmProxy` while rung 4 runs `PcmSessionBridge` — so today the
cheap rungs prove a _sibling_ of the deployed lane, not the lane itself. The
fix is not more infrastructure; it is making rungs 2–3 wrap the worker's own
modules.

---

## 4. Sketch: one shared module, three wrappers

**What `worker.ts` actually touches beyond its own modules** (the complete
list — this is why the extraction is small):

- from `env.ITX.get()` (a disposable project session): `projectId`,
  `secrets.get(path).reveal()`, `kv.get(key)`, `egress.fetch(request)`,
  `capabilityHosts.get("/").invokeCapability({args, path})`;
- from the DO: `ctx.storage.kv.get/put` (one bounded previous-session
  snapshot), `ctx.waitUntil`, `ctx.abort` (kill only);
- globals: `WebSocketPair`, `crypto.randomUUID`, timers.

**The shared module** (lives beside `pcm-proxy.ts` in
`config-worker/`, so the installer ships it verbatim): extract `#handlePcm`
plus the active-session bookkeeping (`ActivePcmSession`, `#ensureProvider`,
the subscription retry ladder, `#rememberClosedPcm`) out of the DO class into
a plain class/factory taking exactly those dependencies:

```ts
// config-worker/session-owner.ts (name illustrative)
export interface KitVoiceSessionDeps {
  connectProvider(mode: KitVoiceMode): Promise<WebSocket>;
  loadCredential(): Promise<{ projectId: string; projectToken: string }>;
  readMode(): Promise<KitVoiceMode>;
  subscribeToDeviceEvents(cb: (event: DeviceEvent) => void): Promise<void>;
  createSocketPair(): { client: WebSocket; server: WebSocket };  // accepted
  rememberClosedSession?(report: ClosedPcmSessionReport): void;   // storage.kv | memory
  readPreviousSession?(): ClosedPcmSessionReport | undefined;
  waitUntil(p: Promise<unknown>): void;
  log(code: string, severity: Severity, detail: unknown): void;
}
export function createKitVoiceSessionOwner(deps: KitVoiceSessionDeps): {
  handlePcm(request: Request): Promise<Response>;
  inputStarted(): boolean;  inputStopped(): boolean;
  pcmMetrics(): …;  close(code: number, reason: string): void;
}
```

`handleKitVoiceRequest` already has this dependency-injected shape; its one
localization need is making the `/api` proxy target (`os.iterate.com`,
`routes.ts:31`) a parameter.

**The three wrappers:**

- **Userspace worker** (`worker.ts` shrinks to a shell): adapts `env.ITX` /
  `ctx` to the deps, keeps `kill()`. Behavior byte-identical — the extraction
  is a move, not a rewrite.
- **Local Node server**: `LocalDevicePeerServer` builds the same owner with
  `subscribeToDeviceEvents` = the local capnweb mount (it already imports the
  shared subscription function), `authenticate` = the peer credentials,
  `connectProvider` = tone/PRBS/Grok-with-raw-key, storage = memory. Fronted
  unchanged by `LocalFetchWebSocketServer` (rung 2) or the captun tunnel
  (rung 3). The lab proxy's observability hooks (`onPcmFrame`,
  `onSocketClose`, `onDownlinkResponseComplete`) must be ported onto
  `PcmSessionBridge` first — the physical evidence pipeline
  (conversation recorder, frame conservation, acoustic markers) consumes
  them; the worker's diagnostics channel alone does not carry per-frame
  observations. `requestTextResponse` (spoken operator cues) also needs a
  home in the shared core — the physical conversation harness cannot run
  without it.
- **Miniflare/workerd harness (optional rung 3.5)**: hosts the _actual_
  `worker.ts` DO. Feasibility facts: the config-worker sources are
  dependency-free ESM TS (only `iterate/sdk` + relative imports — no `node:`
  imports, so **no `nodejs_compat`**); the DO needs a recent compat date for
  synchronous `storage.kv` and `ctx.abort` (both supported by current
  miniflare/workerd); `WebSocketPair`/101 responses are native. There is no
  wrangler config for it today (apps/kit's generated `wrangler.jsonc` is the
  TanStack web app) — the harness would be a ~50-line vitest-pool-workers or
  miniflare setup whose only real work is a **fake `ITX` binding** exposing
  the five members listed above. What this rung uniquely buys: the strict
  branches the captun-tolerant helpers skip (real `readyState`, real
  `bufferedAmount` backpressure), the 101 response hand-off, and
  workerd-only accept semantics — `providers.ts:75-83` records a real bug
  class ("accepting only the renderer looks plausible in unit fakes but
  fails the first real production send") that only this rung or rung 4
  catches. What it cannot replicate: OS's dispatch envelope (the
  `x-iterate-app` header routing, `worker.base.ts` wrapping, the real ITX
  capability transport) — that stays rung 4's job, which is fine: rung 4
  then exists to prove _integration_, not logic.

**Consequence for the plan text:** state the ladder explicitly in §5
(Testing) and in the stage-4 worker item: worker logic changes are developed
and proven on rungs 1–3 (same modules, minutes per cycle), rung 3.5 when
socket semantics are in doubt, and the deployed userspace worker is reserved
for integration proof — the last, most expensive rung, not the default loop.

---

## 5. Concrete plan edits this recon motivates

1. **DECISIONS/PLAN citations**: move the `wouldPostToStream` seams to
   `worker.ts:383-399` / `:407-412`; retire every "welded provider lifetime"
   claim (rows 1–2) and restate D8 as: seam built; dial-on-demand +
   uplink-demand trigger + idle alarm + `session.updated` await +
   clean-EOS-on-provider-death remain.
2. **Wave-0 defect list**: drop the oversized-provider-message item (fixed);
   keep the `#suppressDownlink` server-vad leak (decl `:431`, set `:531`,
   cleared only `:676`) — note it becomes hot-path under the v2 server-VAD
   call model. Correct OPEN-QUESTIONS §13: `device-pcm-proxy.ts` IS in the
   modified set now.
3. **Adopt the worker as the reference PCM implementation** and schedule the
   lab-proxy retirement as: port observer hooks + text cues onto
   `PcmSessionBridge`, switch `LocalDevicePeerServer` to the shared owner,
   freeze `DevicePcmProxy`, delete after one clean physical run on the shared
   core.
4. **Testing §5**: add the four-rung ladder above verbatim as policy
   ("test as much as possible with as few dependencies as possible"); note
   that the direct-LAN/captun duality over one fetch handler already exists
   and is the pattern to extend, and that the deployed userspace worker is
   the final integration rung only.
5. **`device-e2e.ts` freeze wording**: the file is 2,746 lines (not 1,752)
   and still growing; either re-freeze at the post-codex boundary or commit
   to the sibling-script pattern that `prove-production-*.ts` already
   demonstrates.
6. **Stage-3 constants table**: include the TS/TS duplication
   (`ITERATE_KIT_PCM_SUBPROTOCOL`, frame bytes) between `src/voice/` and
   `config-worker/`, not just C/TS.
