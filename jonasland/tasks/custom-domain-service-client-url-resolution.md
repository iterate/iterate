---
state: todo
priority: high
size: medium
tags:
  - jonasland
  - routing
  - custom-domain
  - events
dependsOn: []
---

# Fix service client URL resolution for custom-domain ingress

## Problem

Services rendered behind custom-domain ingress can load HTML successfully but still construct broken client URLs for follow-up RPC / websocket traffic.

Concrete failure seen on March 9, 2026:

- `https://iterate.iterate-e2e-test-custom-domain-no-cloudflare.com/?transport=websocket`
  - apex routed correctly via default ingress service
- `https://iterate.iterate-e2e-test-custom-domain-no-cloudflare.com/demo/stream?transport=websocket`
  - `events` UI rendered
  - browser-side websocket connect failed because client URL resolution still synthesized a service-prefixed host shape that did not match the active custom-domain routing model

## Goal

Make browser-side service clients resolve correctly and durably for:

- Fly-hosted ingress hosts
- Cloudflare SaaS custom hostnames
- default-service apex hosts
- explicit service subdomain hosts

without relying on ad hoc page-specific overrides.

## Options to evaluate

1. **Registry-assisted resolution**
   - browser asks registry for canonical public URLs before creating service clients
   - likely needs a small endpoint returning service slug -> public URL mapping for the current ingress host

2. **Same-origin browser clients**
   - when UI is already served from the desired service host, browser clients should stay on `location.origin`
   - service-internal routing stays same-origin instead of synthesizing another hostname

## Constraints

- Browser JS cannot set `Host`, `X-Forwarded-Host`, or `X-Forwarded-For` on `fetch` / `WebSocket` requests.
- Any design that depends on trusting client-supplied forwarding headers directly from the browser is invalid.
- If a same-origin proxy pattern is used, forwarding headers must be injected by trusted server-side infra only.
- Default-service apex routing must remain switchable via ingress env without breaking service-host routes.

## Recommended direction

Prefer same-origin client resolution when the current page is already on the target service host, and use registry-assisted canonical URL resolution only when the browser genuinely needs to hop to a different service host.

## Acceptance criteria

- `events` UI websocket and RPC traffic work from:
  - `events.<custom-domain>`
  - apex custom-domain when `events` is the default ingress service
- `home` continues to work from:
  - `home.<custom-domain>`
  - apex custom-domain when `home` is the default ingress service
- no browser code depends on setting `X-Forwarded-*` headers directly
- add tests for service URL resolution across:
  - prefix host mode
  - subdomain host mode
  - default-service apex host
  - explicit service host
