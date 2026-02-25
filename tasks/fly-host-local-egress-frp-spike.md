---
state: todo
priority: high
size: medium
dependsOn: []
---

# Fly -> host-local mock egress via frp (HTTP + WebSocket transport) spike

Use frp as the reverse-tunnel layer so a Fly machine can reach a host-local Vitest mock egress server on random port `X`, while keeping Cloudflare Worker in the request path.

## Why

Current local-only approach (`host.docker.internal:<X>`) works for Docker tests but not for Fly machines. We need a test-only path that:

1. reaches a host-local mock server from Fly,
2. preserves host-based routing semantics already used by Caddy + `cf-proxy-worker`,
3. can carry frp control traffic over WebSocket/WSS through edge infrastructure.

## Goals

1. Prove Fly machine can call host-local mock egress on random `X` through frp.
2. Keep `cf-proxy-worker` in path for the data request.
3. Use frp HTTP proxy type for request routing by Host.
4. Use frp websocket transport (`websocket`/`wss`) between `frpc` and `frps`.
5. Keep spike isolated to test helpers + ephemeral runtime config.

## Non-goals

1. Productionizing frp in machine runtime.
2. Replacing current Docker egress tests.
3. Building a generic tunnel service API.

## Scope

Primary spike touchpoints:

1. `jonasland/e2e/test-helpers/` (new frp fixture + lifecycle)
2. `jonasland/e2e/tests/` (one Fly-targeted egress test)
3. `apps/cf-proxy-worker/` (route usage via existing API, no schema changes)
4. `jonasland/sandbox/caddy/Caddyfile` (frp host routing entries)
5. `sandbox/pidnap.config.ts` (optional: frps process wiring for Fly image/runtime)

## Topology

```text
Vitest host (local)
  mock-egress server on 127.0.0.1:X
  frpc (proxy type=http, customDomains=<internal-data-host>)
        |
        |  control channel (wss/websocket)
        v
CF Worker hostname (control route)
  -> cf-proxy-worker -> Fly app :443/:80 -> Caddy -> frps bindPort

Fly machine outbound egress call
  -> https://<public-data-host>
  -> cf-proxy-worker (route match)
  -> target Fly app (Host overridden for Caddy/frp vhost match)
  -> Caddy -> frps vhostHTTPPort
  -> frpc -> 127.0.0.1:X (host-local mock)
```

## Implementation Plan

### Phase 1: frp runtime fixture (host side)

1. Add test helper to start/stop `frpc` with generated config:
   - random `runId`
   - `localPort = X` from `mockEgressProxy.port`
   - `type = "http"`
   - `customDomains = [<internal data host for this run>]`
   - `transport.protocol = "wss"` (fallback `websocket` for local debug)
2. Add health wait: frpc connected + proxy registered.
3. Add strict cleanup on test completion/failure.

Suggested location: `jonasland/e2e/test-helpers/frp-fixture.ts`.

### Phase 2: Fly-side frps endpoint

1. Run `frps` inside Fly sandbox runtime for spike.
2. Minimal config:
   - `bindPort` for frpc control channel
   - `vhostHTTPPort` for HTTP proxy traffic
   - token auth enabled (`auth.token`)
3. Ensure process is supervised/restartable in the spike flow.

Options:

1. Temporary start via pidnap runtime update in test (preferred for spike speed).
2. Permanent pidnap process entry (defer unless spike succeeds).

### Phase 3: Caddy host routing entries

Add explicit Caddy routes so frp traffic does not fall through to default egress-service upstream.

1. Control host route: `reverse_proxy 127.0.0.1:<frps bindPort>` with WS upgrade pass-through.
2. Data host route (wildcard or run-specific): `reverse_proxy 127.0.0.1:<frps vhostHTTPPort>`.

Important: without explicit host match, Caddy `:80/:443` fallback forwards to `127.0.0.1:19000` (egress service), which is wrong for frp data/control.

### Phase 4: Cloudflare Worker route setup (in path)

Use existing `cf-proxy-worker` route API to create ephemeral routes with TTL:

1. Control public host -> Fly target, with `headers.host = <caddy control host>`.
2. Data public host -> Fly target, with `headers.host = <internal data host used by frpc customDomains>`.

Notes:

1. `cf-proxy-worker` already preserves `connection` + `upgrade` on websocket requests in `createUpstreamHeaders`.
2. Worker normalizes route matching (exact first, wildcard fallback), so prefer exact run-scoped hosts for simpler cleanup.

### Phase 5: Test wiring

1. Start `mockEgressProxy()` (gets random `X`).
2. Bring up frp fixture (`frpc`) against route-provisioned control host.
3. Configure machine egress to call `https://<public-data-host>` via existing external egress path.
4. Assert mock records the request + headers proving egress path executed.

### Phase 6: Cleanup + failure ergonomics

1. Delete worker routes (or rely on short TTL + explicit delete).
2. Stop frpc process.
3. Stop temporary frps process if started dynamically.
4. Emit route/run ids in test logs for postmortem.

## WebSocket pass-through notes

1. frp control channel uses WebSocket/WSS at transport layer (`transport.protocol`).
2. `cf-proxy-worker` must preserve WS upgrade headers end-to-end. Current implementation keeps `connection`/`upgrade` for WS requests; this is required for frpc<->frps handshake.
3. Caddy control-host route must accept/forward upgrade traffic to frps bind port.
4. Keepalive/idle behavior is a risk: long-lived WS control channels can be dropped by intermediaries; set aggressive reconnect and test timeout handling.
5. Egress addon behavior is separate: `sandbox/egress-proxy-addon.py` bypasses WS requests directly, so this spike targets HTTP egress payload traffic while WS is used for frp transport control.

## Host routing interactions (Caddy + cf-proxy-worker)

1. `cf-proxy-worker` resolves by inbound host and can override outbound `Host` via route headers.
2. Caddy routing in sandbox is host-driven; wrong host means fallback to egress service.
3. frp HTTP proxy routing is also host-driven (`customDomains` / `subdomain`).
4. Therefore we need consistent host mapping across three layers:
   - public worker host (test-facing)
   - Caddy match host (machine ingress-facing)
   - frp `customDomains` host (frps vhost-facing)
5. Recommended spike pattern:
   - keep public host stable per run (`<run>.frp-egress.<worker-domain>`),
   - rewrite host at worker to a Caddy/frp-internal host (`<run>.frp-egress.iterate.localhost`),
   - configure frpc `customDomains` to that internal host.

## Config complexity (vs chisel-style baseline)

1. Extra components:
   - frps process in Fly machine
   - frpc process on test host
   - 2 ephemeral worker routes (control + data)
   - Caddy host rules for frp
2. Extra dynamic values per test run:
   - random mock port `X`
   - frp auth token
   - run-scoped hosts
3. More host-mapping coupling than chisel:
   - frp HTTP vhost routing depends on Host correctness
   - requires deliberate worker `Host` rewrite + matching Caddy rules
4. Operational overhead:
   - process lifecycle + reconnection behavior
   - route cleanup
   - cert/TLS alignment for `wss`

Net: feasible but higher config surface than a raw TCP reverse tunnel.

## Validation

1. Unit-ish checks:
   - frp fixture generates expected configs for run id + port `X`
   - route creation/deletion calls use expected host mappings
2. Integration checks:
   - frpc establishes WS control channel through worker path
   - Fly machine HTTP egress reaches host-local mock on random `X`
   - request/response integrity (status/body/headers)
3. Failure drills:
   - kill frpc mid-test -> assert predictable failure + cleanup
   - delete data route while control alive -> assert route_not_found path

## Acceptance Criteria

1. One Fly-backed Vitest case passes end-to-end with host-local mock on random `X`.
2. Cloudflare Worker is in data path and used for route control.
3. WS transport between frpc and frps succeeds through worker+caddy.
4. No leaked long-lived routes/processes after test completion.

## Decision output

After spike, record one of:

1. Proceed with frp for Fly egress tests.
2. Proceed with constraints (list required guardrails).
3. Reject frp approach (document concrete blocker, pick alternate).
