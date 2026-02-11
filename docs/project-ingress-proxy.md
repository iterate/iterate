# Project ingress proxy

- Iterate projects should be reachable via public hostnames under both `.iterate.town` and `.iterate.app`
- This should work consistently across all machine providers (fly, daytona, docker, whatever)
- Individual services running within a project machine should be reachable via hostname, too

- "Detached" ingress machines should remain reachable - though the hostname need not be as nice

# Step 0 - what we're doing today

We support the following hostname patterns:

- mach_123.machines.iterate.town -> machine mach_123
- 4096\_\_mach_123.machines.iterate.town -> machine mach_123
- misha.iterate.town -> port 3000 (default) of the active machine of project slug "misha"
- 4096\_\_misha.iterate.town -> port 4096 of the active machine of project slug "misha"

The same matcher logic exists for `.iterate.app` hosts in code, but we cannot run live validation there yet.

## How it works

### Machine side

Inside each machine we run new `apps/project-ingress-proxy` process under pidnap supervision. Listens on port 8080. It receives HTTP requests proxied from the os worker with original hostname stored in `X-Iterate-Proxy-Target-Host` header.

It parses the target from the header and proxies to `localhost:<port>`.

Supported `X-Iterate-Proxy-Target-Host` forms:

- `<port>__<hostname>`
- `localhost:<port>`
- `127.0.0.1:<port>`

Non-local explicit host:port targets are rejected.

### Os

We route wildcard hostnames to the `os` worker.

When the `os` worker sees a supported hostname, it resolves the host to a machine record.

It does not connect directly to target service ports.

It always forwards via machine ingress on port `8080` and puts the original host in `X-Iterate-Proxy-Target-Host`.

The machine ingress proxy then routes to the final local service port.

Behind the scenes:

- docker: fetch transport uses host-mapped URL for container port `8080`
- fly: ingress goes through app ingress to container port `8080`
- daytona: ingress uses preview URL for port `8080`

## Infra tasks

- [ ] Create `*.machines.iterate.app` wildcard CNAME to OS ingress target
- [ ] Enable Cloudflare Total TLS for `iterate.town` (wildcard cert auto-issuance)

# Future improvements

- [ ] Instead of `os` worker, make a much skinnier project ingress worker. We'd need to use some better_auth stuff in it, though.
- [ ] Use cloudflare consistently across all machine providers (instead of different mechanisms for each)
  - [ ] Create cloudflare_tunnels table in os worker and create cloudflare tunnel when a project deployment is created. Pass tunnel token into machine
  - [ ] Provide per-tunnel tunnel token
  - [ ] Secure all ingress into cloudflare tunnels using cloudflare access
- [ ] Allow customers to use `opencode.misha.iterate.app` and `some-service.misha.iterate.app` so they can share cookies - using cloudflare total SSL
- [ ] Allow customers to expose custom services in their iterate.config.ts and make them available as [service-name].[project-slug].iterate.app
- [ ] "Ingress email worker" serving \*@[project].iterate.app using cloudflare email workers (bot@iterate.com resend shortcut notwithstanding - we need both)
- [ ] Performance: Get the routing data closer to the edge - our planetscale database is completely the wrong data store for this. Should be a mega skinny proxy - maybe use D1 or KV or planetscale with aggressive hyperdrive cache
