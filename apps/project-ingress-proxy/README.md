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

- `mach_123.iterate.town` -> machine `mach_123`, port `3000`
- `4096__mach_123.iterate.town` -> machine `mach_123`, port `4096`
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
- Canonical service link host is set by `PROJECT_INGRESS_PROXY_CANONICAL_HOST`
- Worker route patterns are controlled by `OS_WORKER_ROUTES`
- All three env vars are required (no fallback defaults)
- OS always fetches into machine ingress port `8080`

### Request ingress flow (authoritative)

For any request whose host matches `PROJECT_INGRESS_PROXY_HOST_MATCHERS`, OS applies this decision tree:

1. Parse ingress target from hostname (`projectSlug` or `machineId`, plus optional port token).
2. Compute canonical project ingress proxy hostname using `PROJECT_INGRESS_PROXY_CANONICAL_HOST`.
3. If request host is not the canonical project ingress proxy host: `301` redirect to canonical project ingress proxy host (same path + query).
4. If request host is the canonical project ingress proxy host:
   - if no Better Auth session on the canonical project ingress proxy host:
     - redirect to control-plane login on `VITE_PUBLIC_URL`
     - after control-plane login, run one-time-token exchange
     - set Better Auth session cookie on the canonical project ingress proxy host
     - redirect back to original canonical project ingress proxy path
   - if session exists: check project/machine authorization
   - if authorized: proxy request into machine ingress (`:8080`)
   - if unauthorized/not found/not routable: return structured error response

Notes:

- Login/auth/static-asset paths are allowed to pass through to the OS app on the canonical project ingress proxy host.
- Session establishment on project ingress uses Better Auth one-time-token exchange from control-plane host to canonical project ingress proxy host.

Canonical service links use:

- `<port>__<machine_id>.<PROJECT_INGRESS_PROXY_CANONICAL_HOST>`
- Example: `4096__mach_123.p.os.iterate.com`

## Ingress env vars

Host roles:

- Control-plane host
  - Base hostname from `VITE_PUBLIC_URL`.
  - Serves `/login` and Better Auth APIs for the OS app.
- Canonical project ingress proxy host
  - Derived from `<target>.<PROJECT_INGRESS_PROXY_CANONICAL_HOST>`.
  - Serves project ingress requests and the one-time-token exchange endpoint.

- `PROJECT_INGRESS_PROXY_CANONICAL_HOST`
  - Single canonical project ingress proxy base host used when constructing machine service links.
  - Must be a hostname only (no wildcard, scheme, port, or path).
  - Must be covered by `PROJECT_INGRESS_PROXY_HOST_MATCHERS`.
- `PROJECT_INGRESS_PROXY_HOST_MATCHERS`
  - Comma-separated hostname glob patterns used to decide if OS should handle ingress routing.
  - Match full incoming hostnames (for example `*.p.os.iterate.com`).
- `OS_WORKER_ROUTES`
  - Comma-separated Cloudflare route host patterns bound to the `os` worker.
  - Must include patterns that cover ingress hostnames.
- `DEV_TUNNEL` (local development)
  - Explicit local tunnel subdomain used by `alchemy.run.ts` (for example `dev-$ITERATE_USER-os`).
  - Canonical host can be set from it in Doppler:
    - `PROJECT_INGRESS_PROXY_CANONICAL_HOST=${DEV_TUNNEL}.dev.iterate.com`

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
