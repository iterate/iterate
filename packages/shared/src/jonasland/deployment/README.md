# Deployment Abstraction

Use this module whenever a caller needs to control a deployment from the outside.

This is a core system interface shared by OS worker, Vitest E2E, CLI, and future runtimes.

## Primary design goal

Callers and tests should not need to change when the deployment topology changes.

If we move from Fly to Kubernetes/GKE, mixed heterogeneous compute, edge+VM hybrids, or personal tailnet hardware (Mac Mini/Raspberry Pi), consumers should still target the same minimal deployment interface.

Fly and Docker are current implementations, not the architectural limit.

## Core idea

From the caller perspective, heterogeneous infrastructure (Docker, Fly, multi-machine topologies) is controlled through one deployment model:

- provision/create
- health/bootstrap checks
- restart/destroy
- a request `fetcher` for routed control-plane/data-plane traffic

## Why this matters

- Same control interface across providers and environments
- External orchestrators can spin up complex topologies behind one API
- Egress behavior can be intercepted from outside by injecting deployment env vars (for example external egress proxy/tunnel paths)
- Enables internet-path E2E validation without bespoke per-provider harnesses
- Enables stable test/eval code even through major infra and architecture rewrites

## Files

- `deployment.ts`: provider-agnostic contracts and bootstrap orchestration
- `docker-deployment.ts`: Docker-flavored deployment config typing helpers
- `fly-deployment.ts`: Fly-flavored deployment config typing helpers
