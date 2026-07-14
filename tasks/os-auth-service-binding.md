---
state: done
priority: medium
size: medium
tags: [os, auth, security, performance, cloudflare]
---

# Move OS-to-auth runtime calls onto a Workers RPC service binding

OS now reaches auth's runtime project directory and token introspection through
a required Cloudflare Workers RPC service binding. The old shared-token HTTP
transport and its runtime routes were deleted; there is no compatibility shim
or fallback.

## Shipped design

- `@iterate-com/auth-contract/worker` exports the abstract default
  `AuthWorker`. This is the single worker-runtime contract for project
  creation, slug lookup, user-project membership, project-id minting, and
  opaque OAuth token introspection.
- Auth's default `AuthWorker` implements public `fetch` and the privileged RPC
  methods. Public requests can invoke only `fetch`; Cloudflare exposes the RPC
  methods to OS through its same-account service binding.
- Every deployed OS environment has a required `AUTH` binding to its matching
  auth worker. The binding omits an `entrypoint` selector so Cloudflare targets
  the default export; possession of that same-account binding is the RPC
  credential.
- Local OS development binds the local auth worker for loopback issuers and a
  matching remote auth deployment for known deployed issuers. Unknown issuers
  fail config generation instead of silently crossing environments.
- Preview deployment uses dependency-ordered batches: auth finishes before OS
  starts. Production uses one workflow and one revision to deploy auth before
  OS. A fixed non-cancelling concurrency group serializes that complete cutover
  even for manual dispatches from different refs. New environments and manual
  deployments use the same target-first order. There is deliberately no old
  HTTP route to bridge version skew.
- Every OS deploy fails before touching any deployed resource unless both the
  resolved Doppler config and current Worker bindings omit the forbidden old
  token name. The invariant is non-mutating; resurrected credentials require
  explicit operator remediation. After deployment, a random uncached slug
  lookup proves the RPC binding reaches Auth's default entrypoint with OS's
  exact project-miss response.
- The one-release preview-fleet cutover completed on 2026-07-14. It drained old
  lifecycle checks, force-acquired all nine Semaphore slots without erasing
  project data, and deployed Auth then OS sequentially in every slot. Every
  deployed OS used the default Auth RPC binding and passed a fresh cache-miss
  lookup; the final all-slot pass confirmed the retired token absent from every
  live Worker and Doppler config before releasing all nine leases. The temporary
  workflow, script, and fleet-wide concurrency gate were then removed. The
  `scripts/preview/deployment-epoch` CI floor still rejects stale PR branches
  before any app deploy. Direct deployment from an old checkout is unsupported
  because code in that checkout cannot enforce a newer floor.

## Remaining public service-token surface

Auth's `APP_CONFIG_SERVICE_AUTH_TOKEN` remains only for public oRPC procedures
used by deploy-time and test-seeding Node scripts, which cannot possess a
Workers binding. OS no longer receives that token or an equivalent auth-wide
secret at runtime.

## Verification

- Auth project-directory unit tests cover canonical id minting, exact-id
  creation/adoption, cross-organization slug conflicts, slug lookup,
  user-scoped membership listing, and invalid input.
- Opaque-token introspection tests cover inactive reasons, hashing at the
  trust boundary, membership-derived claims, project selection, and admin
  role reconstruction.
- Wrangler config tests prove every deployed OS environment targets its
  matching auth worker's default entrypoint, local/remote selection is
  fail-closed, and the old runtime secret cannot enter generated OS
  configuration.
- Deploy-helper and OS deployment tests prove Worker and Doppler absence checks
  fail closed without mutating or exposing a resurrected value, run before any
  deployment preparation, and reject a wrong-body RPC 404 after deployment.
- Depot run `w23f561lz8` deployed and verified all nine preview slots, re-listed
  all nine Workers, re-read all nine Doppler configs, and released the fleet
  only after all retired-token checks passed.
- Preview orchestration tests prove dependencies deploy first while independent
  dependents retain parallelism, ordinary acquisition never force-evicts a live
  lease, and destructive reclaim requires explicit operator force. Parsed
  workflow tests retain the breaking CI deployment epoch and prove normal
  deploy/cleanup serialization is scoped per PR rather than through the removed
  fleet-wide maintenance gate.

Reference: [Cloudflare Workers RPC service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).
