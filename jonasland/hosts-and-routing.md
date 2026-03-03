# Hosts And Routing

Goal: one front-door Caddy in each deployment. It rewrites/reroutes by host pattern. No test-id logic in Caddy.

## Canonical Internal Service Hosts

Caddy vhosts inside deployment:

- `pidnap.iterate.localhost` -> `127.0.0.1:9876`
- `registry.iterate.localhost` -> `127.0.0.1:8777`
- `events.iterate.localhost` -> `127.0.0.1:19010`
- `orders.iterate.localhost` -> `127.0.0.1:19020`
- `docs.iterate.localhost` -> `127.0.0.1:19050`
- `home.iterate.localhost` -> `127.0.0.1:19030`
- `outerbase.iterate.localhost` -> `127.0.0.1:19040`
- `caddymanager.iterate.localhost` -> `127.0.0.1:8501`
- `caddy-admin.iterate.localhost` -> `127.0.0.1:2019`

Source: [Caddyfile](/Users/jonastemplestein/.superset/worktrees/iterate/fly-v2/jonasland/sandbox/caddy/Caddyfile)

## External Ingress Host Formats

### Docker (host machine -> deployment ingress port)

Supported:

1. `{service}.iterate.localhost:{hostport}`
2. `{service}__{identifier}.proxy.iterate.com` (via explicit Host header to local ingress)
3. `frp.iterate.localhost:{hostport}`

### Fly (public ingress)

Supported:

1. `{identifier}.ingress.iterate.com`
2. `{service}__{identifier}.ingress.iterate.com`
3. `frp__{identifier}.ingress.iterate.com`

For Fly deployments, `FlyDeployment.create` creates two ingress worker routes:

- `{identifier}.ingress.iterate.com` -> `https://<app>.fly.dev`
- `*__{identifier}.ingress.iterate.com` -> `https://<app>.fly.dev`

For FRP on Fly, the FRP helper additionally creates a temporary `frp__{identifier}.ingress.iterate.com` route to the same app target.

## Caddy Service Rewrite Rules

`{service}__{identifier}.ingress.iterate.com` and `{service}__{identifier}.proxy.iterate.com` are handled in Caddy by extracting `{service}` and mapping to:

- upstream localhost port
- canonical internal host `{service}.iterate.localhost`

Caddy forwards upstream with:

- `Host: {service}.iterate.localhost`
- `Forwarded: for=<client-ip>; host=<original external host>; proto=<http|https>`

Unknown `{service}` -> `404 unknown service host pattern`.

## Proxying and Forwarded headers

Forwarding context is standardized on RFC 7239-style `Forwarded` only.

- Canonical format: `Forwarded: for=<ip>; host=<host>; proto=<http|https|ws|wss>`
- `host` and `proto` carry original inbound request context
- `for` is included when client IP is known; omitted when unknown
- No forwarding-context `X-*` headers are used (`X-Iterate-Original-*`, `X-Forwarded-*`, `x-original-*`)
- Caddy sets `Forwarded` on ingress -> upstream hops
- Egress/proxy services consume `Forwarded` and re-emit a single normalized `Forwarded` header upstream

## Caddy FRP Rules

FRP control/data entrypoint is host-routed through Caddy to `127.0.0.1:27000` (`frps`):

- `frp.iterate.localhost`
- `frp__<identifier>.ingress.iterate.com`

No separate public FRP port is exposed. FRP control uses websocket transport through normal ingress.

## Host Header By Hop

### Service request (`events__abc.proxy.iterate.com`)

1. client/ingress worker -> Caddy: `Host: events__abc.proxy.iterate.com`
2. Caddy -> events: `Host: events.iterate.localhost`
3. events service sees canonical host, can inspect `Forwarded` for original host/proto context

### FRP request (`frp__abc.ingress.iterate.com`)

1. frpc -> ingress worker: `Host: frp__abc.ingress.iterate.com`
2. ingress worker -> Fly app: preserves `Host: frp__abc.ingress.iterate.com`
3. Caddy matches `frp__...ingress.iterate.com` and proxies to `127.0.0.1:27000`
4. `frps` handles websocket control session

## Deployment ORPC Clients

Deployment ORPC clients are normal ORPC clients with provider fetch transport:

- client URL: `http://<service-host>/orpc` or `/rpc`
- provider fetcher forwards to deployment ingress and sets `Host: <service-host>`

Refs:

- [deployment.ts](/Users/jonastemplestein/.superset/worktrees/iterate/fly-v2/packages/shared/src/jonasland/deployment/deployment.ts)
- [fly-deployment.ts](/Users/jonastemplestein/.superset/worktrees/iterate/fly-v2/packages/shared/src/jonasland/deployment/fly-deployment.ts)
