# Hosts and routing

Single front door is Caddy. All inbound HTTP(S) traffic and all sandbox egress traffic flow through it.

# Configuration

## Files

- `jonasland/sandbox/home-skeleton/.iterate/caddy/Caddyfile`
  - Canonical routing model.
  - Owns built-in ingress routes, route-classification stages, shared dispatch, and the final egress fallback.
- `/home/iterate/.iterate/caddy/registry-service-routes.caddy`
  - Runtime-generated registry fragment.
  - Contains additive ingress route metadata for explicit service hosts.
- `services/registry/src/caddy-sync.ts`
  - Renders registry-managed Caddy fragments and reloads Caddy after validation.
- `services/registry/server.ts`
  - Seeds built-in registry-owned routes and triggers initial synchronization from route storage into Caddy.
- `packages/shared/src/jonasland/ingress-url.ts`
  - Shared public-URL resolver.
  - Encodes how internal service URLs map to public ingress hosts.
- `jonasland/sandbox/entry.sh`
  - Bootstraps dnsmasq and iptables redirect rules so outbound `:80/:443` traffic re-enters Caddy.
- `jonasland/sandbox/pidnap.config.ts`
  - Defines sandbox processes and injects routing env vars into `caddy` / `registry`.

## Cloudflare edge routes

- `iterate.com`
  - `ingress-proxy` has explicit Worker routes for `ingress.iterate.com/*` and `*.ingress.iterate.com/*`.
  - Manual change on 2026-03-09: added `*/* -> ingress-proxy`.
  - Reason: Cloudflare for SaaS custom hostnames on the `iterate.com` zone were not reaching the Worker without a catch-all Worker route on the provider zone.
- `iterate.app`
  - `os` already had `*.iterate.app/*`.
  - Manual change on 2026-03-09: added `*/* -> os`.
  - Reason: same Cloudflare for SaaS requirement for external custom hostnames that terminate on the `iterate.app` zone.
- Important consequence:
  - `*/*` catches any request on the zone that does not have a more-specific Worker route.
  - This changes the fallback behavior for previously-unmatched hosts from "no matching Worker route" to "run the catch-all Worker".
  - On `iterate.com` this was immediately visible in `ingress-proxy` tail logs: unrelated unmatched hosts like `www.iterate.com` and `os2.iterate.com` started hitting the Worker and returning `404`.
  - Treat both manual `*/*` routes as sharp tools. They unblock SaaS custom hostnames, but they also create a broad interception surface and extra log noise until route ownership is tightened.

## Environment variables

### `ITERATE_INGRESS_HOST`

- Default: `iterate.localhost`
- Meaning: the public base host for the sandbox.
- Examples:
  - local docker: `iterate.localhost`
  - Fly: `my-sandbox.fly.dev`
- Consumed by:
  - root Caddyfile host matchers
  - registry route generation
  - public URL resolution

### `ITERATE_INGRESS_ROUTING_TYPE`

- Allowed values:
  - `dunder-prefix`
  - `subdomain-host`
- Default: `subdomain-host`
- Meaning: the preferred generated public host shape for non-default services.
- Examples:
  - `subdomain-host`: `events.my-sandbox.fly.dev`
  - `dunder-prefix`: `events__my-sandbox.fly.dev`
- Consumed by:
  - public URL resolution
  - tests / helper scripts that assert generated public URLs
- Note:
  - Caddy intentionally accepts both explicit host forms even when URL generation chooses only one.

### `ITERATE_INGRESS_DEFAULT_SERVICE`

- Default: `registry`
- Meaning: service slug that owns the naked public hostname.
- Examples:
  - `ITERATE_INGRESS_DEFAULT_SERVICE=registry`
    - `my-sandbox.fly.dev` -> `registry`
  - `ITERATE_INGRESS_DEFAULT_SERVICE=events`
    - `my-sandbox.fly.dev` -> `events`
- Consumed by:
  - root Caddyfile static default-host ingress route
  - registry public URL resolution
  - registry-generated explicit host metadata

### `ITERATE_EGRESS_PROXY`

- Optional
- Meaning: if set, unmatched outbound traffic is forwarded to this external proxy instead of directly to the real destination.
- Examples:
  - `http://127.0.0.1:19123`
  - FRP bridge / mock HTTP proxy URLs in e2e tests
- Consumed by:
  - egress-routing layer (currently via the sandbox egress path)

## Source of truth split

- Root built-in routes are defined in `jonasland/sandbox/home-skeleton/.iterate/caddy/Caddyfile`.
- Registry writes additive dynamic fragments into `/home/iterate/.iterate/caddy/*.caddy`.
- Built-ins must work before registry starts.
- Optional apps are expected to register routes with registry when they start.

## Ingress vs egress

Request classes:

- External ingress:
  - traffic arriving from Fly / Cloudflare / ingress workers
  - must never fall through to egress
- Internal ingress:
  - service-to-service traffic using local or public sandbox hostnames
  - must stay on ingress even though it originated inside the machine
- Egress:
  - outbound traffic to a host that did not resolve to any sandbox ingress route

High-level rule:

1. Resolve ingress route metadata first.
2. If an ingress route is found, dispatch to the service upstream.
3. Only unmatched traffic may take the egress path.

## Forwarding headers and the one intentional Host rewrite

Trusted ingress proxies may provide `X-Forwarded-Host`. In that case:

- Caddy may use `X-Forwarded-Host` as the effective routing host.
- The original public `Host` is preserved separately for downstream consumers.
- This is the one intentional host rewrite case.

Other forwarded headers:

- `X-Forwarded-For` -> client IP (handled natively by Caddy `trusted_proxies` + `client_ip_headers`)
- `X-Forwarded-Proto` -> scheme (handled natively by Caddy `trusted_proxies`)
- `Forwarded` (RFC 7239) is not used

## Built-in hosts

- Built-ins should always resolve on both:
- `service.iterate.localhost`
- `service.{$ITERATE_INGRESS_HOST}`
- and, where supported by ingress host parsing, `service__{$ITERATE_INGRESS_HOST}`

Current built-ins routed directly by root Caddyfile:

- `pidnap.*` -> `127.0.0.1:17300`
- `registry.*` -> `127.0.0.1:17310`
- `events.*` -> `127.0.0.1:17320`
- `caddy.*` -> `127.0.0.1:2019`
- `openobserve.*` -> `127.0.0.1:5080`
- `otel-collector.*` -> `127.0.0.1:15333`
- `frp.*` -> `127.0.0.1:27000`

Public exposure for admin/observability hosts is currently open by design.
Auth hardening is a separate follow-up.

## External host formats

Supported ingress forms for an ingress host like `my-sandbox.fly.dev`:

- naked default-service host:
  - `my-sandbox.fly.dev`
- explicit subdomain host:
  - `events.my-sandbox.fly.dev`
- explicit dunder-prefix host:
  - `events__my-sandbox.fly.dev`

Legacy / worker-driven formats may still appear in some environments:

- `{service}__{identifier}.ingress.iterate.com`
- `{service}__{identifier}.proxy.iterate.com`
- `{identifier}.ingress.iterate.com`
- `frp__{identifier}.ingress.iterate.com`

## Registry dynamic route flow

Registry owns two things:

1. Resolve public URL from internal URL (`getPublicURL`).
2. Emit dynamic Caddy fragments for registered routes.

High-level lifecycle:

1. Deployment starts (built-ins already routed by root Caddyfile).
2. Registry seeds built-in service routes where needed.
3. Optional services start and register `host -> target` route entries in registry.
4. Registry renders the dynamic fragment from route storage.
5. Registry stages + validates a temporary config view.
6. Registry promotes fragment changes and reloads Caddy.

## Fallback behavior

Unmatched traffic falls through to the egress path.

This is required because machine-level iptables redirect all outbound `:80/:443`
traffic back into Caddy first. The egress path is therefore not an edge-case;
it is the expected final step for all traffic that did not resolve to ingress.
