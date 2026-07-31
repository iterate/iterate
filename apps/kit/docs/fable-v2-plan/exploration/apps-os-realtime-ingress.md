# Cloudflare Realtime as a userspace ingress path for apps/os

Status: **SHELVED 2026-07-31 (same day)** — Jonas tried the WebRTC
direction and reversed it ("we are doing 'double websocket' for now") —
dual WebSockets stand; this design is preserved in case the direction is
ever revisited (DECISIONS.md §7). Earlier the same day the mechanism had
been settled — Jonas directed: "we need to use this mechanism for workers
realtime" — and the signaling/auth/tenancy design below (SDP over the
control plane; OS core holds the env-level app secret behind an itx
capability; capability URLs carry all project/stream metadata; media-lane
auth inherits control-lane auth via the SDP's session-scoped ICE/DTLS
credentials; the device's WebRTC client is deliberately dumb) was recorded
in DECISIONS.md and folded into PLAN.md's then-transport-track. Originally
produced 2026-07-31 by a forked side-investigation answering Jonas's
question about apps/os userspace ingress.

## How config workers receive the PCM

The Realtime SFU terminates the device's WebRTC/Opus/UDP leg entirely inside
Cloudflare; no UDP ever reaches our code. Its WebSocket adapter bridges each
media track to plain WebSockets:

- **Stream mode (uplink):** one HTTPS call binds a WebRTC track to any
  `wss://` URL we specify; the SFU dials that URL as an ordinary WebSocket
  client and pushes decoded audio as protobuf frames
  (`Packet { sequenceNumber, timestamp, payload }`, fixed 48 kHz s16le
  stereo PCM).
- **Ingest mode (downlink):** our code dials a Cloudflare-issued WebSocket
  endpoint and sends PCM; the SFU encodes to Opus and publishes it as a
  WebRTC track. Each adapter is unidirectional; a conversation needs one of
  each.

So this is not a new ingress _primitive_: audio arrives as an inbound
WebSocket upgrade on the config worker's existing fetch handler — exactly
how the userspace `/pcm` endpoint receives devices today. What changes is
the dialer: Cloudflare's SFU connects to the project worker instead of the
device. Config workers need zero new platform capabilities.

## Metadata binding

The adapter supports no custom headers, but we choose the URL at
adapter-creation time. The control plane mints a capability URL —
`wss://<project-host>/pcm-ingress?token=<capability-token>` — whose token
encodes project id, device id, stream path (`/kit/devices/<id>`),
conversation id, and direction. The worker validates the token on upgrade
and knows the full context before the first frame arrives. Each adapter is
bound 1:1 to a single session+track, so there is no demuxing: one URL, one
stream, unambiguous. Same capability-URL pattern `/pcm` device auth uses
today.

## Deployment shape (matches existing apps/os conventions)

- **One Realtime SFU app per environment** (`prd`, each `preview_N`),
  declared in `envs.ts` as a resource id, secret in that env's Doppler
  config, created/verified by `ensure-resources` (or a once-per-account
  manual step recorded in `envs.ts` if app creation proves dashboard-only).
  Same for the TURN service key.
- **The app secret never leaves OS core.** It is account-scoped and
  all-or-nothing (the SFU API has no per-project scoping), so userspace must
  never hold it — same posture as the Grok key never reaching devices. OS
  exposes conversation setup as an itx capability on the project handle
  (e.g. `realtime.createConversation({devicePath, ...})`): OS core makes the
  SFU API calls (session, tracks, both adapters) and returns what userspace
  can safely hold — session/track ids and the minted capability URLs.
- **Routing = the adapter target URL.** One app serves every project in the
  deployment; the SFU is a dumb pool of sessions; project association lives
  in our minted URLs plus OS bookkeeping (needed anyway for teardown and
  requirement-8 events).

## Provisioning granularity (follow-up clarification)

Adapters are NOT per-project resources: they are **per-track,
per-conversation, ephemeral runtime objects** — created by an HTTPS call at
conversation start (by OS core, holding the env's app secret, on the same
setup path that opens the Grok socket) and gone at conversation end, or
garbage-collected ~30 s after their track goes silent. That call is a
runtime API call, not control-plane provisioning: no account mutation, no
dashboard step, nothing to reconcile or leak — a crashed conversation
leaves nothing behind in Cloudflare that outlives the 30 s GC window. The
ONLY provisioned Cloudflare resource is the one Realtime app per
environment; a new project needs zero Cloudflare-side setup. The
per-conversation adapter/session API round-trips are part of the cold-start
latency budget already inside W1's headline 1.5–4 s estimate — if slow,
that argues for the server-initiated pre-warm lever, never for
pre-provisioning anything per project.

## Operational consequences

1. **Cost attribution is ours to build**: one app = one Cloudflare bill
   line; per-project metering comes from the media session posting its
   per-conversation egress bytes as events (the same event machinery the
   plan already builds).
2. **Limits/sharding**: check per-app concurrency limits in W1; if they ever
   bind, shard to multiple apps behind the same OS capability — the appId is
   an implementation detail below the itx surface.
3. **Local dev caveat**: the egress adapter must dial a _publicly reachable_
   wss URL, so fully-local dev project hosts (`<slug>.localhost`) cannot
   receive SFU traffic directly — local development of this path goes
   through captun / `tunnels.iterate.com` or a preview env, consistent with
   the repo's standing "public callbacks need captun or preview" doctrine.

## Device-side signaling and authentication (follow-up clarification)

The device never addresses the adapter, never holds an SFU credential, and
never transmits project/stream metadata over WebRTC:

1. **Identity is pre-established** — the always-on `/api` control connection
   is authenticated with the provisioned project token, and the kit path /
   device id are known from the mount, before any audio exists.
2. **Signaling rides the control plane** — on "start" the device sends its
   SDP offer as an ordinary control-plane message; OS core (holding the
   env-level app secret) drives the SFU HTTPS API on its behalf and relays
   the SDP answer back down. The device's WebRTC stack never talks to any
   Cloudflare API.
3. **Media-path authentication is the SDP itself** — the answer carries the
   session-scoped ICE credentials and DTLS fingerprint; possession of those
   short-lived, single-session credentials is how a WebRTC peer
   authenticates, and the only way to obtain them is through the
   authenticated control lane, so media-lane auth inherits control-lane
   auth. TURN credentials for hostile networks are minted server-side and
   delivered the same way.
4. **The stream path never crosses the media lane** — the Opus stream
   carries audio only; the project/stream binding lives in the adapter
   target URL minted by OS, so the project worker learns context from the
   URL it is dialed on and the SFU stays ignorant of our tenancy model.

The ESP32's WebRTC client is deliberately dumb: "send this SDP up the
control lane, use the answer that comes back" — same secret-isolation
posture as the Grok key.

## Standing caveats (shared with the Transport track)

Beta API (vendor the protobuf, contract-test it); fixed 48 kHz stereo both
directions (worker downmixes/resamples; xAI accepts 48 kHz natively); egress
side has 5 s best-effort reconnect, ingest side none (worker detects death
and recreates via API); an outbound ingest socket pins a Durable Object —
hold it in the per-conversation stateless media session instead; tracks are
garbage-collected after 30 s without media; $0.05/GB egress after the free
1,000 GB/month (~$0.035/h per always-streaming direction), free during beta.
