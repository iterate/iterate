# Environment Config Leases For Cloudflare PR Previews

Environment config leases for PR previews are shared Doppler config leases. A
lease is not specific to one app. It points to one config bag, and every
affected app deploys into that same config.

## Naming

- Semaphore resource type: `environment-config-lease`
- Semaphore resource slug: `preview-2`, `preview-3`, etc.
- Semaphore resource data: `{ "dopplerConfig": "preview_2" }`, etc.
- Doppler project: app/service dimension, such as `events`, `os2`, or `semaphore`
- Doppler config: environment config dimension, such as `preview_2`, `prd`, or `dev_jonas_2`
- Alchemy stage: inherited from Doppler as `${DOPPLER_CONFIG}`

The Semaphore lease gives only the config dimension. The preview script chooses
which Doppler projects to deploy.

For example, a PR that affects two new-style apps leases `preview-2`, reads
`data.dopplerConfig = preview_2`, then runs the same primitive for each selected
app:

```bash
cd apps/os2
doppler run --project os2 --config preview_2 -- pnpm exec tsx ./alchemy.run.ts

cd ../semaphore
doppler run --project semaphore --config preview_2 -- pnpm exec tsx ./alchemy.run.ts
```

Legacy preview-managed apps still use their package `alchemy:up` / `alchemy:down`
scripts until migrated.

The same mechanism applies to local development and production:

- local dev: `alchemy up` with a personal config such as `dev_jonas_2`
- preview: `alchemy up` with a leased `preview_N` config
- production: `alchemy up` with `prd`

## Source Of Truth

- Semaphore database state stores the environment config lease inventory for PR previews
- the managed PR body preview section stores the current PR's lease and app statuses
- Doppler stores each app project's config bag for the leased environment config
- there is no app-specific resource inventory and no fallback state

The seed for this Semaphore resource type lives in
`scripts/preview/preview-inventory.ts`. Running the seed command makes the live
Semaphore database exactly match that source-code inventory for
`environment-config-lease`.

## Lifecycle

1. The `Cloudflare Previews` workflow runs the repo-local preview router.
2. The router reads the managed PR body preview section.
3. It tries to renew the existing shared lease. If that fails, it tries to
   reacquire the same slug. If that fails, it acquires any available shared
   environment config lease.
4. It compares the PR diff and selects affected apps plus explicit dependencies.
   The temporary dependency graph is in
   `@iterate-com/shared/apps/new-style-cloudflare-apps`; it belongs in app
   manifests or contracts long-term.
5. It deploys selected apps with the leased Doppler config. New-style apps run
   `doppler run --project <app> --config <leased dopplerConfig> -- pnpm exec tsx ./alchemy.run.ts`
   with the app directory as the working directory.
   Legacy preview-managed apps run their package `alchemy:up` / `alchemy:down`
   scripts for now.
6. It records each app's result in the PR body. If any app fails, the overall
   preview is unhealthy and the lease is kept for debugging.
7. The test phase runs preview e2e only for deployed apps recorded in the same PR
   body state.
8. On PR close, cleanup destroys apps recorded in state. Only if cleanup
   succeeds does it release the environment config lease.

## Semaphore Token

The preview router talks to Semaphore with a bearer token. In normal CI and
operator commands, run it through `doppler run --project os --config prd`; the
router reads `SEMAPHORE_API_TOKEN` when present and otherwise falls back to
`APP_CONFIG_SHARED_API_SECRET`.

```bash
doppler run --project os --config prd -- pnpm preview status
doppler run --project semaphore --config prd -- pnpm --dir apps/semaphore seed:environment-config-leases
```

Do not paste the token into scripts or docs.

## Operational Notes

- Environment config lease inventory for PR previews is provisioned explicitly
  with `pnpm --dir apps/semaphore seed:environment-config-leases`.
- The current source-code seed contains `preview_2` through `preview_9`. Add
  new entries only after the matching Doppler configs and app-specific
  Cloudflare prerequisites exist.
- The seed is exact for `environment-config-lease`: drifted resources are
  deleted and missing resources are recreated with the source-code data.
- Only provision Semaphore seed entries when the matching `preview_N` Doppler
  configs exist for the preview-managed apps and the app-specific Cloudflare
  prerequisites are in the right accounts. For os2, numbered previews currently
  use `os2-preview-N.iterate.com` on the existing `iterate.com` zone and leave
  project-host bases empty.
- CI workflows invoke one shared preview lifecycle. The lifecycle code, not the
  workflow matrix, decides which apps deploy.
- Preview deploys do not override `ALCHEMY_STAGE`.
- Deleting the managed PR body preview section is treated as state loss.
- Environment config leases are released explicitly on cleanup, not on deploy or test
  failure.
- Manual lifecycle:

```bash
doppler run --project os --config prd -- pnpm preview sync --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview deploy --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview test --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview cleanup --pull-request-number 1234
```
