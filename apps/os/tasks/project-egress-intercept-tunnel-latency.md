---
state: draft
priority: high
size: medium
dependsOn: []
tags: [os, performance, cloudflare, intercept-tunnel]
---

# Project egress intercept tunnel: fix ~1.3s connect latency

## Problem

Tunnel establishment via `createCaptunTunnel()` takes **~1.3s p50** (range 1.0-2.0s) even after the Project Durable Object is warm. This makes the intercept tunnel unusable for latency-sensitive workflows.

## Root cause

Each `createCaptunTunnel()` call opens a new WebSocket, which means a new TCP+TLS connection. Each new connection to our OS Worker triggers a fresh Worker isolate cold start.

**Comparison (send→firstByte on WebSocket upgrade, same Cloudflare account):**

| Worker                     | Bundle size | send→firstByte  |
| -------------------------- | ----------- | --------------- |
| Captun standalone (~100KB) | tiny        | **64-96ms**     |
| OS Worker (7000+ modules)  | massive     | **1185-1986ms** |

DNS (20ms), TCP (17ms), and TLS (28ms) are identical. The entire ~1.1s difference is in Cloudflare starting the Worker isolate and running it to the point where it returns the 101 response.

Once the Worker is warm, the server-side ingress path is fast:

| Step                                           | Cold       | Warm        |
| ---------------------------------------------- | ---------- | ----------- |
| D1 ingress route lookup                        | 226ms      | 9-13ms      |
| `dispatchFetchCallable` (service binding → DO) | 1220ms     | 11-13ms     |
| **Total server time**                          | **1239ms** | **22-60ms** |

But this warmth is per-TCP-connection — each new WebSocket goes through cold start again.

## Evidence

Benchmarked against `preview_5` with `pnpm benchmark:intercept-tunnel`:

```
Sequential (n=50):  p50=1278ms  p90=2782ms  mean=1471ms  failures=0
Concurrency 5:      p50=1236ms  p90=1810ms  mean=1242ms  failures=0
Concurrency 10:     p50=1426ms  p90=1951ms  mean=1573ms  failures=0
```

Phase breakdown per new TCP connection to `iterate.iterate-preview-5.app`:

```
dns=20ms  tcp=17ms  tls=24ms  send→firstByte=1724ms  total=1785ms
```

vs captun standalone worker at `captun-bench-test.iterate-dev-preview.workers.dev`:

```
dns=20ms  tcp=18ms  tls=28ms  send→firstByte=64ms   total=130ms
```

## Solution options

### Option A: Fast-path in the OS Worker entry point

Short-circuit the intercept tunnel route before loading the full app. In `entry.workerd.ts`, detect `/__iterate/intercept-project-egress` path early (before `withEvlog`, before D1 queries) and route directly to the DO. This avoids the full module graph initialization cost if Cloudflare defers it.

Risk: Cloudflare may still initialize the full module graph regardless.

### Option B: Separate lightweight Worker for tunnel ingress

Deploy a small Worker (like captun's) that handles only `*.iterate-preview-N.app/__iterate/intercept-project-egress` and forwards directly to the Project DO. This guarantees fast cold starts (~100ms).

Risk: Adds operational complexity (another Worker to deploy/maintain).

### Option C: Persistent control channel

Instead of creating a new WebSocket per tunnel session, maintain a persistent connection and multiplex tunnel creation as RPC calls over it. The first connect pays cold start, subsequent ones are instant.

Risk: More complex client/server protocol. Requires captun changes.

### Option D: Worker size reduction

Reduce the OS Worker bundle size so cold starts are faster. Tree-shake unused routes, lazy-load heavy dependencies.

Risk: Large effort, benefits unclear without measurement.

## Additional finding: DO `scriptThrewException` on every tunnel disconnect

Every tunnel disconnect causes `Error: Network connection lost.` (close code 3000) reported as `scriptThrewException` in Cloudflare DO analytics. This is a Cloudflare runtime behavior when a WebSocket opened via `serverSocket.accept()` is closed by the peer — not a code bug. It inflates error metrics but doesn't affect functionality.

Potential mitigation: use the hibernatable WebSocket API (`webSocketMessage()`/`webSocketClose()` handlers on the DO class) instead of `serverSocket.accept()` + event listeners.

## Files

- Benchmark script: `apps/os/scripts/benchmark-project-egress-intercept-tunnel.ts`
- Vendored captun server (for future patching): `apps/os/src/lib/captun/`
- Ingress entry point: `apps/os/src/entry.workerd.ts`
- Project ingress entrypoint: `apps/os/src/domains/projects/entrypoints/project-ingress-entrypoint.ts`
- Captun PR with analysis: https://github.com/iterate/captun/pull/4
