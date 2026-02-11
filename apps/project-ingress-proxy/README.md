# Project ingress proxy

`apps/project-ingress-proxy` is the machine-side ingress process for Iterate machines.

It sits in the middle of the OS control-plane ingress flow:

1. Public hostnames route to the `os` worker.
2. The `os` worker decides whether hostname should use project ingress matching.
3. OS resolves hostname -> machine + target port.
4. OS forwards request into that machine on port `8080`.
5. This proxy receives request and routes to `localhost:<target-port>`.

The target port is carried in `X-Iterate-Proxy-Target-Host`.

## Current scope (step 0)

Supported public hostname forms:

- `mach_123.machines.iterate.town` -> machine `mach_123`, port `3000`
- `4096__mach_123.machines.iterate.town` -> machine `mach_123`, port `4096`
- `misha.iterate.town` -> active machine for project slug `misha`, port `3000`
- `4096__misha.iterate.town` -> active machine for project slug `misha`, port `4096`

Equivalent `.iterate.app` matching exists in code paths, but we cannot fully validate live traffic there yet.

## Machine process behavior

Pidnap runs this process on every machine (see `sandbox/pidnap.config.ts`).

Behavior:

- Listens on `0.0.0.0:8080`
- `GET /health` returns `200 OK`
- Requires `X-Iterate-Proxy-Target-Host` on non-health requests
- Accepts these target-header forms:
  - `<port>__<hostname>`
  - `localhost:<port>`
  - `127.0.0.1:<port>`
- Rejects non-local explicit `host:port` targets
- Proxies HTTP + WebSocket traffic to `localhost:<port>`

Header handling:

- Rewrites `Host` to `localhost:<port>`
- Removes `X-Iterate-Proxy-Target-Host` before upstream forward
- Sets `X-Iterate-Proxy-Via` from inbound `Host`

## OS-side behavior

OS-side ingress resolution/proxying lives in `apps/os/backend/services/project-ingress-proxy.ts`.

Key points:

- Host matching is controlled by `PROJECT_INGRESS_PROXY_HOST_MATCHERS`
- Worker route patterns are controlled by `OS_WORKER_ROUTES`
- Both env vars are required (no fallback defaults)
- OS always fetches into machine ingress port `8080`

Provider path to machine ingress:

- Docker: host-mapped URL for container port `8080`
- Fly: app ingress to machine port `8080`
- Daytona: preview URL for port `8080`

## Related files

- Machine proxy server: `apps/project-ingress-proxy/server.ts`
- Target header parsing: `apps/project-ingress-proxy/proxy-target-host.ts`
- OS ingress resolver: `apps/os/backend/services/project-ingress-proxy.ts`
- OS worker entrypoint routing: `apps/os/backend/worker.ts`
- Worker route/env wiring: `apps/os/alchemy.run.ts`
- Machine process supervisor config: `sandbox/pidnap.config.ts`

## Tasks and follow-ups

Tracked follow-ups:

- `tasks/project-ingress-proxy-improvements.md`
- `tasks/project-ingress-proxy-secret-auth.md`
