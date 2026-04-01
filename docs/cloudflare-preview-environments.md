# Cloudflare Preview Environments

Preview environments for `example`, `events`, `semaphore`, and `ingress-proxy` are pooled resources leased by production Semaphore.

## Naming

- `previewEnvironmentType`: app-specific pool name like `example-preview-environment`
- `previewEnvironmentIdentifier`: deployed worker identity like `example-preview-1`
- `previewEnvironmentAlchemyStageName`: slot stage like `preview-1`
- `previewEnvironmentDopplerConfigName`: Doppler branch config like `stg_1`
- `previewEnvironmentWorkersDevHostname`: workers.dev host like `example-preview-1.iterate.workers.dev`

The identifier is the important name to pass around. It is what the deployed worker ends up being called.

## Source Of Truth

- Semaphore `resources` stores the static pool inventory
- Semaphore `preview_assignments` stores active PR ownership and lease bookkeeping
- The sticky GitHub PR comment is only a UI projection of Semaphore state

## Lifecycle

1. A PR workflow for an affected app calls `preview.create` on production Semaphore.
2. Semaphore reuses the current PR assignment when possible, otherwise claims a free slot from the app-specific pool.
3. On every PR push, the app workflow tears the preview down and recreates it from scratch before testing.
4. The app deploys with Doppler config `stg_N` and Alchemy stage `preview-N`.
5. The app runs its network preview tests against the deployed workers.dev URL.
6. On PR close, the app workflow runs `pnpm alchemy:down`.
7. After teardown succeeds, the workflow calls `preview.destroy` with the exact `previewEnvironmentSemaphoreLeaseId` to release the lease and clear the assignment.

## Operational Notes

- `preview.create` no longer seeds inventory implicitly. Run `preview.ensureInventory` before turning the workflows on.
- Doppler `stg_N` configs are also an explicit rollout precondition.
- UI release for preview environments should stay teardown-aware. Releasing a lease without `alchemy:down` leaves Cloudflare resources behind.
- Expired leases are reclaimable in Semaphore, but v1 does not auto-run teardown on lease expiry.
