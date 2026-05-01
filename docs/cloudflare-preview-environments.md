# Cloudflare Preview Environments

Preview environments are shared Doppler config leases. A lease is not specific to
one app. It points to one config bag, and every affected app deploys into that
same config.

## Naming

- Semaphore resource type: `cloudflare-preview-environment`
- Semaphore resource slug: `preview-1`, `preview-2`, etc.
- Semaphore resource data: `{ "dopplerConfig": "preview_1" }`, etc.
- Doppler project: app/service dimension, such as `events`, `os2`, or `semaphore`
- Doppler config: environment slot dimension, such as `preview_1`, `prd`, or `dev_jonas_2`
- Alchemy stage: inherited from Doppler as `${DOPPLER_CONFIG}`

The Semaphore lease gives only the config dimension. The preview script chooses
which Doppler projects to deploy.

For example, a PR that affects `os2` leases `preview-1`, reads
`data.dopplerConfig = preview_1`, then runs:

```bash
doppler run --project events --config preview_1 -- pnpm alchemy:up
doppler run --project os2 --config preview_1 -- pnpm alchemy:up
```

The same mechanism applies to local development and production:

- local dev: `alchemy up` with a personal config such as `dev_jonas_2`
- preview: `alchemy up` with a leased `preview_N` config
- production: `alchemy up` with `prd`

## Source Of Truth

- Semaphore database state stores the preview environment inventory and leases
- the managed PR body preview section stores the current PR's lease and app statuses
- Doppler stores each app project's config bag for the leased slot
- there is no app-specific preview pool and no fallback state

The seed for this Semaphore resource type lives in
`scripts/preview/preview-inventory.ts`. Running the seed command makes the live
Semaphore database exactly match that source-code inventory for
`cloudflare-preview-environment`.

## Lifecycle

1. The `Cloudflare Previews` workflow runs the repo-local preview router.
2. The router reads the managed PR body preview section.
3. It tries to renew the existing shared lease. If that fails, it tries to
   reacquire the same slug. If that fails, it acquires any available shared
   preview environment.
4. It compares the PR diff and selects affected apps plus explicit dependencies.
   The temporary dependency graph is in `scripts/preview/apps.ts`; it belongs in
   app manifests or contracts long-term.
5. It deploys each selected app with
   `doppler run --project <app> --config <leased dopplerConfig> -- pnpm alchemy:up`.
6. It records each app's result in the PR body. If any app fails, the overall
   preview is unhealthy and the lease is kept for debugging.
7. The test phase runs preview e2e only for deployed apps recorded in the same PR
   body state.
8. On PR close, cleanup runs `alchemy:down` for apps recorded in state. Only if
   cleanup succeeds does it release the shared Semaphore lease.

## Semaphore Token

The preview router talks to Semaphore with a bearer token. In normal CI and
operator commands, run it through `doppler run --project os --config prd`; the
router reads `SEMAPHORE_API_TOKEN` when present and otherwise falls back to
`APP_CONFIG_SHARED_API_SECRET`.

```bash
doppler run --project os --config prd -- pnpm preview status
doppler run --project semaphore --config prd -- pnpm seed:preview-pool
```

Do not paste the token into scripts or docs.

## Operational Notes

- Preview inventory is provisioned explicitly with `apps/semaphore`
  `seed-cloudflare-preview-environment-pool`.
- The seed is exact for `cloudflare-preview-environment`: drifted resources are
  deleted and missing resources are recreated with the source-code data.
- Only preview domain pairs that are available in the right Cloudflare account
  should have `preview_N` Doppler configs and Semaphore seed entries.
- CI workflows invoke one shared preview lifecycle. The lifecycle code, not the
  workflow matrix, decides which apps deploy.
- Preview deploys do not override `ALCHEMY_STAGE`.
- Deleting the managed PR body preview section is treated as state loss.
- Preview leases are released explicitly on cleanup, not on deploy or test
  failure.
- Manual lifecycle:

```bash
doppler run --project os --config prd -- pnpm preview sync --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview deploy --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview test --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview cleanup --pull-request-number 1234
```
