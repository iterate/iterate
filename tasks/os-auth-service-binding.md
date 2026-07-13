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
- Every OS deploy forces an uncached slug lookup through the RPC binding before
  retiring anything. It then deletes and re-lists the live `secret_text`
  binding that `--secrets-file` otherwise preserves, repeats the normal and RPC
  probes against that newly activated version, and only then deletes and
  re-reads the matching Doppler source. Config provisioning and OAuth-client
  sync do not mutate that source because they cannot prove live revocation.
- The first main rollout deploys the new auth and OS revision to every preview
  slot as well as production. This one-release fleet migration removes the old
  client and preserved secret from persistent parked Workers; it is removed in
  a cleanup PR after all nine matrix jobs pass.

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
- Deploy-helper tests prove live Worker and Doppler secret retirement are
  idempotent and fail closed when either system still reports the retired
  value; a response-aware smoke test covers the exact-body RPC proof.
- Preview orchestration tests prove dependencies deploy first while independent
  dependents retain parallelism.

Reference: [Cloudflare Workers RPC service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).
