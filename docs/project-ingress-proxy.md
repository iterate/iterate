# Project ingress proxy

- Iterate projects should be reachable via public hostnames under .iterate.app . For example misha.iterate.app
- This should work consistently across all machine providers (fly, daytona, docker, whatever)
- Individual services running within a project machine should be reachable via hostname, too

- "Detached" ingress machines should remain reachable - though the hostname need not be as nice

# Step 0 - what we're doing today

We will support the following hostname patterns:

- mach_123.machines.iterate.app -> machine mach_123
- 4096\_\_mach_123.machines.iterate.app -> machine mach_123
- misha.iterate.app -> port 3000 (default) of the currently attached machine of the project with slug "misha"
- 4096\_\_misha.iterate.app -> port 4096 of the currently attached machine of the project with slug "misha"

## How it works

### Machine side

Inside each machine we run new `apps/project-ingress-proxy` process under pidnap supervision. Listens on port 8080. It receives HTTP requests proxied from the os worker with original hostname stored in `X-Iterate-Proxy-Target-Host` header.

It parses the port from the front of the hostname and proxies to localhost:<port>.

### Os

We have a \*.iterate.app CNAME record pointing at our `os` worker (in the future this could be a skinnier worker)

When the `os` worker sees a `*.iterate.app` hostname, it tries to resolve the \* to a "machine".

It doesn't care about the port - the project ingress proxy on the machine handles this.

It then uses the machine provider abstraction to get a fetcher for the machine (which uses a machine provider specific mechanism under the hood).

Then it stores the original hostname in `X-Iterate-Proxy-Target-Host` header and sends through the fetcher.

Behind the scenes this (currently) takes a different path depending on machine provider:

- docker: uses mapped port on host machine
- fly: uses fly public url for the "app" - which connects to port 8080 on the "sandbox" machine
- daytona: uses daytona preview url for port 8080

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
