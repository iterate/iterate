---
state: todo
priority: high
size: medium
tags:
  - jonasland
  - e2e
  - frp
  - networking
dependsOn: []
---

# Add `useFrpTunnel({ deployment })` helper for e2e

## Scope

- Create a test helper that starts an FRP client on the test runner and connects to deployment-side FRPS.
- Ensure the tunnel is routable from inside the deployment and exposes a stable proxy URL for tests.
- Wire deployment runtime env via lightweight API (`~/.iterate/.env`) by setting `ITERATE_EXTERNAL_EGRESS_PROXY` to the FRP data proxy URL.
- Handle lifecycle cleanly (startup readiness, logs/debug surface, teardown of FRP client and temporary ingress route for Fly).

## Acceptance criteria

- Helper API exists and is usable as `useFrpTunnel({ deployment, ... })` in e2e tests.
- Fly path creates/removes temporary ingress route for FRP control-plane connectivity.
- Deployment egress traffic can be observed through runner-side mock via FRP tunnel when `ITERATE_EXTERNAL_EGRESS_PROXY` is set.
- Helper returns/records enough diagnostics (control host/protocol/client logs) to debug connection failures.
