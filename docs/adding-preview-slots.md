# Adding preview slots

This runbook expands the shared PR-preview fleet. It is written for the next
expansion, from `preview_1`–`preview_9` to `preview_1`–`preview_19`.

Do not start by adding Semaphore leases. A leased slot is live: CI may claim it,
deploy into it, and later ask `main` to erase it. The repository, Doppler, and
Cloudflare pieces must exist before the lease enters the pool.

## What one slot contains

| Layer         | Per-slot state                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository    | OS and Semaphore environment entries; derived app maps, OAuth audiences, mobile preset, and preview inventory                                                          |
| Doppler       | Branch configs in `os`, `auth`, `semaphore`, `streams-example-app`, and `dummy-petshop`                                                                                |
| Cloudflare    | Two zones, seven Workers, two D1 databases, two KV namespaces, three R2 buckets, one Queue, one AI Search namespace, DNS, routes, container classes, and email routing |
| External apps | One GitHub App and one Slack app for full integration parity                                                                                                           |
| Lease fleet   | One `environment-config-lease` resource in production Semaphore                                                                                                        |

The Workers are OS, its builder and typechecker sidecars, Auth, Semaphore, the
Streams example app, and Dummy Petshop.

## Before changing anything

Use a branch from current `main`. The expansion PR should contain the code edits
and the real Cloudflare resource IDs. Doppler and Cloudflare preparation happen
while that PR is open; adding leases happens only after it merges.

You need access to:

- the Iterate Doppler workspace;
- Cloudflare account `376ef7ed81b0573f93524de763666c15`;
- GitHub App creation for the `iterate` organization;
- the Slack workspace used for preview apps.

Record the live fleet before touching it:

```bash
doppler run --project _shared --config prd -- pnpm preview status
doppler run --project _shared --config prd -- pnpm preview reconcile
```

`reconcile` is useful but narrow. It checks the slots already in Semaphore for
five Doppler configs and two active Cloudflare zones. It does not check
`envs.ts`, resource IDs, secret shape, deployed Workers, OAuth audiences,
Slack/GitHub routing, or e2e health.

### Capacity check

Recalculate capacity immediately before the expansion. Ten slots add:

| Resource             | Added | Live count on 2026-07-17 | Count after expansion | Published account limit |
| -------------------- | ----: | -----------------------: | --------------------: | ----------------------: |
| Workers              |    70 |                      122 |                   192 |                     500 |
| D1 databases         |    20 |                       27 |                    47 |                  50,000 |
| KV namespaces        |    20 |                       18 |                    38 |                   1,000 |
| R2 buckets           |    30 |                       29 |                    59 |               1,000,000 |
| Queues               |    10 |                        9 |                    19 |                  10,000 |
| AI Search namespaces |    10 |                       11 |                    21 |                     100 |

The current OS container caps reserve 75 GiB, 16.25 vCPU, and 196 GB of disk
per slot. Nineteen slots reserve 1.39 TiB, 308.75 vCPU, and 3.72 TB, below the
published limits of 6 TiB, 1,500 vCPU, and 30 TB. Recheck the caps in
`SANDBOX_MAX_INSTANCES` and the current Cloudflare limits instead of copying
these numbers.

References: [Workers](https://developers.cloudflare.com/workers/platform/limits/),
[Containers](https://developers.cloudflare.com/containers/platform-details/limits/),
[D1](https://developers.cloudflare.com/d1/platform/limits/),
[KV](https://developers.cloudflare.com/changelog/post/2025-01-27-kv-increased-namespaces-limits/),
[R2](https://developers.cloudflare.com/r2/platform/limits/),
[Queues](https://developers.cloudflare.com/queues/platform/limits/), and
[AI Search](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).

## 1. Teach the repository about slots 10–19

Make these edits together. A partial edit can produce a healthy-looking Worker
that cannot authenticate or cannot be leased safely.

### Make `envs.ts` the source of truth

In `envs.ts`, add:

- `preview_10`–`preview_19` to `envs`, using `previewSlot(N, ...)` with all
  three resource IDs set to `UNPROVISIONED`;
- the same names to `semaphoreEnvs`, using `semaphorePreviewSlot(N,
UNPROVISIONED)`;

Do not invent IDs and do not copy IDs from another slot. OS and Auth deliberately
share the slot's Auth D1 ID; Semaphore has its own D1 ID.

The other three maps have no independent per-slot resource IDs. Their preview
entries already derive from `envs`:

- `authEnvs` preview entries derive from `envs`, with fixed test OTP enabled;
- `dummyPetshopEnvs` preview entries derive from each OS preview's slot number;
- `streamsExampleEnvs` preview entries derive from each OS preview's slot
  number.

Keep their production and Auth `dev_global` entries explicit. Type each derived
map so a missing or extra deployed environment is a type error.

### Derived fleet projections

`envs.ts` exports a preview-only projection derived from the `envs` entries and
their `dopplerConfig` values. The following consumers already use it:

- Doppler provisioning and Semaphore inventory use the projected slot numbers
  in `scripts/preview/preview.ts`;
- the four Auth audience sets in `apps/auth/src/server/oauth-resources.ts` use
  `envs`, `semaphoreEnvs`, and
  `streamsExampleEnvs`;
- `targets` in `apps/os/scripts/sync-auth-clients.ts` use `envs`;
- `SERVER_PRESETS` in `apps/mobile/src/lib/servers.ts` use `envs`.

Do not add another numeric slot list or an exact-range unit test. The remaining
`scripts/preview/preview.test.ts` cases cover behavior that deployed-env smoke
tests do not isolate: dependency ordering, diff selection, retry and force-push
handling, inventory add/delete semantics, lease ownership, failed cleanup,
reclaim, and GC.

The Streams example app declares `previewDependencies: ["auth"]` because its
deploy fetches and bakes Auth's JWKS. Preserve that dependency: an old slot can
hide incorrect first-deploy ordering.

Search again before moving on:

```bash
rg -n 'nine slots|all nine|1–9|1\.\.9|length: 9|\[1, 2, 3, 4, 5, 6, 7, 8, 9\]' \
  envs.ts scripts apps docs .depot
```

Historical incident notes need not be rewritten. Operational descriptions and
live fleet counts do.

## 2. Create the Doppler branch configs

Do not create `_shared/preview_11`–`preview_19`. Deployed apps inherit shared
Cloudflare credentials from their project-level `preview` root, which inherits
`_shared/preview`. Environment-shaped public values now come from `envs.ts`.
`_shared/preview_10` already exists as old residue and is not a template.

First create the two configs the provisioner does not create:

```bash
for project in os dummy-petshop; do
  for n in $(seq 10 19); do
    config="preview_$n"
    doppler configs get "$config" --project "$project" --json >/dev/null 2>&1 ||
      doppler configs create "$config" --project "$project" --environment preview
  done
done
```

Then run the repository provisioner from the expansion branch. It reads the
updated `previewEnvironmentSlotNumbers`, creates `auth`, `semaphore`, and
`streams-example-app` configs, and writes the three per-slot Auth clients plus
their matching secrets.

```bash
pnpm preview provision-auth-preview-configs
```

Do not pass `--rotate`. Without it, existing slots retain their current client
secrets, Better Auth secrets, and service tokens. The command still writes
live Doppler state, including the existing preview root configs, so review its
scope before running it.

For every new config, verify:

- `doppler configs get preview_N --project PROJECT --json` reports environment
  `preview`;
- `doppler secrets --project PROJECT --config preview_N --only-names` includes
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`;
- Auth has `AUTH_SEED_OAUTH_CLIENTS`, `APP_CONFIG_BETTER_AUTH_SECRET`, and
  `APP_CONFIG_SERVICE_AUTH_TOKEN`;
- OS, Semaphore, and Streams have their matching
  `APP_CONFIG_ITERATE_AUTH__CLIENT_ID` and client secret;
- Semaphore and Streams have `AUTH_FORGE_PRIVATE_JWK`.

`apps/os/scripts/sync-auth-clients.ts` is not the preview-stack provisioner.
It predates isolated per-slot Auth and can point every target at whichever Auth
config wraps the command. Do not run `pnpm auth:sync-clients` for this work.

## 3. Add per-slot integration apps

The platform deploys without real Slack or GitHub apps because both config
blocks are optional. That is not full preview parity: Slack e2e silently skips
without a signing secret, and GitHub e2e uses Dummy Petshop rather than the
deployment's real GitHub App.

### GitHub

Create one GitHub App per slot. Use the permissions and events in
`apps/os/docs/github-preview-app-manifest.md`, with these corrections:

- all app, callback, and webhook URLs use
  `https://os.iterate-preview-N.com`, not `.app`;
- the Doppler JSON key is `webhookSecret`, matching `apps/os/src/config.ts`,
  not `webhookSigningSecret`;
- write each value directly to `os/preview_N`; do not put a slot credential in
  `os/preview`.

The essential URLs are:

```text
Homepage: https://os.iterate-preview-N.com
Callback: https://os.iterate-preview-N.com/api/integrations/github/callback
Webhook:  https://os.iterate-preview-N.com/api/integrations/github/webhook
```

The value stored in `APP_CONFIG_INTEGRATIONS__GITHUB` is:

```json
{
  "appId": "...",
  "appSlug": "iterate-preview-N",
  "oauthClientId": "...",
  "oauthClientSecret": "...",
  "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...",
  "webhookSecret": "..."
}
```

Do not use the bulk script currently printed in the GitHub runbook. Besides
the wrong hostname and secret key, its redirect-capture example does not pipe
the background server's code back to the conversion step.

After OS is deployed, authenticate as the App and verify `GET /app` returns
`iterate-preview-N`, then verify `GET /app/hook/config` returns that slot's
`.com` webhook URL.

### Slack

Follow `apps/os/docs/slack-preview-app-manifest.md` for each slot:

1. Create `iterate (preview-N)` with its bootstrap manifest.
2. Store `APP_CONFIG_INTEGRATIONS__SLACK` directly in `os/preview_N`.
3. Deploy OS.
4. Save the full manifest so Slack can verify the now-live request URLs.
5. Install it to the preview/test workspace and merge its `xoxb-` token into
   the same JSON as `botToken`.

The Slack guide's `.com` URLs and `webhookSigningSecret` key are correct.
Test `botToken` with `auth.test`; presence in Doppler is not proof that a token
has not been revoked.

### Dummy Petshop

`APP_CONFIG_INTEGRATIONS__PETSHOP` is inherited from `os/preview`. It needs
OAuth client credentials but no per-slot override: OS derives the provider
origin by replacing its own `os.` hostname with `dummy-petshop.`. OS deploy
fails if this integration config is absent in a preview.

## 4. Create Cloudflare resources and record their IDs

For the 10–19 expansion, both `iterate-preview-N.com` and
`iterate-preview-N.app` already exist as active full zones for slots 10–20.
This was checked on 2026-07-17. At that point slots 10–19 had no matching DNS,
Workers, D1, KV, R2, Queues, or AI Search namespaces. Recheck both facts.

If either zone is missing or not active, stop. `ensure-resources` creates DNS
records inside an existing zone; it does not register a domain or create a
zone.

Run resource creation sequentially to keep Cloudflare management API traffic
bounded:

```bash
for n in $(seq 10 19); do
  pnpm --dir apps/auth ensure-resources --env "preview_$n"
  pnpm --dir apps/semaphore ensure-resources --env "preview_$n"
  pnpm --dir apps/dummy-petshop ensure-resources --env "preview_$n"
  pnpm --dir apps/os ensure-resources --env "preview_$n"
done
```

There is no Streams `ensure-resources` command. Its deploy creates its DNS
record before uploading the Worker.

OS resource creation also installs R2 expiry rules, creates the Queue and event
subscription, creates an AI Search namespace, enables inbound Email Routing,
and installs the zone catch-all. Read every warning. In particular,
`ensureAiSearchNamespace` logs a warning and continues when AI Search creation
fails. Treat that warning as a failed slot: create the namespace manually and
verify it before proceeding.

Outbound Email Service onboarding is a separate dashboard action because
Cloudflare has no public API for it. Complete it for each new
`iterate-preview-N.app` sender domain if preview email sending is expected.

Paste the printed IDs into the expansion branch:

- OS `projectDirectoryKvId` and `workerBuildCacheKvId`;
- the shared OS/Auth `authDbId`;
- Semaphore `resourcesDbId`.

Run every `ensure-resources` command again. The second pass must report the
recorded IDs as matching reality and make no new resources.

## 5. Verify and merge the repository change

At minimum, run:

```bash
pnpm --dir apps/os exec vitest --root ../.. run \
  scripts/preview/preview.test.ts \
  apps/os/scripts/generate-wrangler-config.test.ts \
  apps/dummy-petshop/src/generate-wrangler-config.test.ts
pnpm --dir apps/auth test
pnpm typecheck
pnpm lint
pnpm format:check
```

Inspect the generated Wrangler configs and confirm every new env selects its
own worker names, routes, D1/KV IDs, and preview container caps.

Open and merge the expansion PR before deploying or leasing the new fleet. Its
own PR preview will continue using one of slots 1–9. Do not seed Semaphore from
the branch.

## 6. Bootstrap the Workers from current `main`

Pull current `main` after the expansion merges. Deploy each new slot directly
while it is still absent from Semaphore. There is no legitimate lease holder
to race yet.

Auth must be serving before OS, Semaphore, or Streams tries to bake its JWKS.
Dummy Petshop must be serving before OS preview e2e. Use this order:

```bash
for n in $(seq 10 19); do
  target_env="preview_$n"
  pnpm --dir apps/auth run deploy --env "$target_env"
  pnpm --dir apps/dummy-petshop run deploy --env "$target_env"
  pnpm --dir apps/semaphore run deploy --env "$target_env"
  pnpm --dir apps/streams-example-app run deploy --env "$target_env"
  pnpm --dir apps/os run deploy --env "$target_env"
done
```

Each deploy downloads its own Doppler config and fails before upload if required
secrets, resource IDs, runtime config, migrations, JWKS, routes, or smoke probes
are wrong. Do not replace a failed deploy with a curl-only health check.

Finish the Slack full-manifest step after OS is live. Verify GitHub App metadata
and webhook config now too.

## 7. Add the slots to Semaphore

This is the point at which CI can discover the new slots. Run from current
`main`, never from an old checkout: inventory sync deletes unexpected entries,
so a pre-expansion checkout would remove slots 10–19 again.

```bash
doppler run --project semaphore --config prd -- \
  pnpm --dir apps/semaphore seed:environment-config-leases

doppler run --project _shared --config prd -- pnpm preview status
doppler run --project _shared --config prd -- pnpm preview reconcile
```

Stop unless `status` reports 19 slots and `reconcile` reports zero issues.

## 8. Prove every new slot through the normal lifecycle

Use a small draft canary PR that touches a preview-shared path. For each new
slot, pin the PR, run the full app fleet and e2e, then clean it up:

```bash
PR=<canary-pr-number>

for n in $(seq 10 19); do
  doppler run --project _shared --config prd -- \
    pnpm preview assign --pull-request-number "$PR" --slot "$n"

  doppler run --project _shared --config prd -- \
    pnpm preview run --pull-request-number "$PR" --allow-draft --all-apps

  doppler run --project _shared --config prd -- \
    pnpm preview cleanup --pull-request-number "$PR"
done
```

This proves more than first-deploy smoke tests: Semaphore assignment, entry
erase, Auth reseeding, dependency ordering, all five deployments, full preview
e2e, cleanup, and release. Check the canary PR's managed preview table, CI logs,
Cloudflare traces, and `pnpm preview status` after each run. An unexplained
error, skipped Slack test, unreleased lease, or mismatched final state is a
failed slot.

After all ten pass, close the canary PR and run `status` and `reconcile` once
more. The expansion is complete only when all 19 slots are present, available
or legitimately leased, and free of reconciliation issues.

## Operator record

Keep this table in the expansion PR. Check a cell only after its corresponding
verification has passed; creating a resource is not the same as verifying it.

| Slot | Doppler | Cloudflare IDs + second ensure | GitHub + Slack verified | Five apps deployed | Lease present | Full lifecycle passed |
| ---- | ------- | ------------------------------ | ----------------------- | ------------------ | ------------- | --------------------- |
| 10   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 11   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 12   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 13   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 14   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 15   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 16   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 17   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 18   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |
| 19   | ☐       | ☐                              | ☐                       | ☐                  | ☐             | ☐                     |

## Known drift found during the 2026-07-17 audit

These are reasons to verify behavior from code and live metadata instead of
cloning an old slot blindly:

- `_shared/preview_10` exists, but no app-level `preview_10` config or matching
  Cloudflare resource existed. It is partial historical state.
- All current OS preview configs inherit one GitHub credential for the
  `iterate (preview-1)` App; its webhook points only at preview 1. The per-slot
  GitHub runbook describes the right isolation model but has the hostname,
  secret-key, and bulk-script defects listed above.
- Slack configs are per slot, but the stored preview 3 and preview 6 bot tokens
  returned `invalid_auth`. New slots must validate credentials, not copy shape.
- `apps/dummy-petshop/scripts/deploy.ts` says “workers.dev only, no routes, no
  DNS”; its generated Wrangler config and `ensure-resources` use a custom route
  and proxied DNS.
- The audit found Streams' missing Auth dependency; this documentation PR also
  fixes the deploy graph.
- Existing environment docs describe nine slots and the generic four-step
  environment bring-up. Neither is a complete fleet-expansion procedure.
