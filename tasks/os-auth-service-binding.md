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
- Immediately after the first main production rollout, an operator drains or
  cancels pre-cutover preview/cleanup runs and explicitly dispatches the
  one-release preview-fleet workflow. It shares the temporary global gate with
  preview deploy and cleanup, drains any still-running legacy checks, then
  audibly force-acquires all nine Semaphore slots without erasing project data.
  Auth and OS deploy sequentially in every slot through the normal exact-smoke
  and retirement path; a final nine-slot pass enforces Worker and Doppler
  absence. Leases release only after complete success. The permanent
  `scripts/preview/deployment-epoch` floor rejects stale branches before any app
  deploy, so old Auth cannot be rolled back ahead of a failed old OS deploy. The
  cutover workflow, script, and temporary gates are removed in a cleanup PR
  after the dispatch passes.

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
- Deploy-helper and OS deployment tests prove live Worker and Doppler secret
  retirement are idempotent and fail closed when either system still reports
  the retired value, a wrong-body RPC 404 cannot trigger deletion, and every
  post-revocation probe must pass before a normal deploy removes its source.
  Preview-fleet cutover tests prove the drain precedes whole-fleet acquisition,
  every slot deploys before final retirement and release, a failed deployment
  retains all maintenance leases, and a partial pre-deploy acquisition unwinds.
- Preview orchestration tests prove dependencies deploy first while independent
  dependents retain parallelism.

Reference: [Cloudflare Workers RPC service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).
