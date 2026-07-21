# Adding preview slots

This runbook adds one or more PR-preview slots. It was exercised while adding
`preview_10`–`preview_19`; examples for the next rehearsal use `SLOT=20`.

The important rule is simple: do not add a Semaphore lease until the slot has
been provisioned, deployed, and tested. A lease makes the slot available to CI;
from then on, any eligible PR may claim and erase it.

## The safest automation model

Use one agent and one durable checklist for the whole expansion. The agent may
resume completed steps, but it must never infer permission for a purchase,
overwrite, rotation, or production write.

Work in four phases:

1. **Plan:** inspect git, Doppler metadata, Cloudflare, GitHub, and Slack without
   changing them. Produce the exact slot list, domains, expected app names,
   existing objects, prices, and intended writes.
2. **Approve:** a human approves the concrete batch. Domain approval includes
   exact names and a maximum total price. External-app approval names the
   GitHub organization and Slack workspace. No open-ended approval.
3. **Apply:** create only missing objects. Every operation must be idempotent or
   stop when an object with the intended name already exists.
4. **Verify:** read the resulting state back from each system. Creation output
   alone is not evidence that a slot works.

The approval boundary is:

| Action                                                                    | Agent may do it during planning? | Apply requirement                                        |
| ------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------- |
| Read inventories, validate manifests, check domain availability and price | Yes                              | None                                                     |
| Create branch configs or cloud resources with new slot names              | No                               | Approve the exact slot batch                             |
| Create GitHub or Slack apps                                               | No                               | Approve organization/workspace and app names             |
| Register domains                                                          | No                               | Approve exact domains, current prices, and maximum total |
| Write new per-slot Doppler secrets                                        | No                               | Approve project, configs, and secret names               |
| Seed production Semaphore leases                                          | No                               | Separate approval after all slots pass                   |
| Overwrite, rotate, delete, reclaim, or change production integrations     | No                               | Stop and obtain specific approval                        |

Do not paste credentials into chat, markdown, command arguments, screenshots,
or git. Pipe API responses directly into Doppler and verify only their shape.
Temporary credential files belong in a mode-`0700` directory from `mktemp -d`
outside the repository and must be removed after the write.

### Browser sessions

Use a dedicated, headed Chrome for Testing profile as described in
[Browser testing](browser-testing.md). A human signs into GitHub, Slack, and
Cloudflare once; the agent can then drive the approved batch and the human can
watch it.

Do not import a personal Chrome profile. Playwriter can control an already-open
personal Chrome tab, so use it only when the human explicitly permits that for
this task. The dedicated automation profile is the default because its cookies
and permissions are isolated and disposable.

Browser automation does not weaken the approval boundary. The agent stops on
2FA, CAPTCHA, a changed price, a different workspace or organization, a name
collision, or any page whose final action is outside the approved batch.

### The missing orchestrator

The repository has good idempotent leaf commands, but no durable expansion
orchestrator. For this batch, the agent can run those commands and maintain the
ledger at the end of this document. Before a later expansion, it would be worth
adding a first-class command with this shape:

```text
pnpm preview expand plan     --slots 10-19 --out expansion.json
pnpm preview expand apply    --plan expansion.json --approve <plan-sha256>
pnpm preview expand verify   --plan expansion.json
pnpm preview expand activate --plan expansion.json
```

`plan` would be read-only and contain no secrets. `apply` would reject a stale
plan, require the hash of the reviewed plan, run sequentially, and resume from
verified checkpoints. Domain registration would additionally require the
approved price ceiling in the plan. `activate` would remain separate because
adding production Semaphore leases changes who can use and erase the slots.

The command should call the existing provisioners rather than reimplement
them. Its value is durable state, precondition checks, direct secret piping,
and safe resumption after browser authorization or a provider outage. It
should never gain generic `--force`, `--rotate`, or deletion flags.

### Single-slot rehearsal

For `preview_20`, keep one ledger row and use `SLOT=20` throughout. Do not turn
a single-slot rehearsal into another range expansion.

The order is:

1. Add `preview_20` to `envs.ts` with `UNPROVISIONED` IDs.
2. Confirm both zones, provider names, capacity, prices, and the exact writes.
3. Create the five Doppler configs and provision Auth without `--rotate`.
4. Create the dedicated GitHub App and Slack bootstrap app.
5. Run every create-only Cloudflare ensure, record the returned IDs, then run
   every ensure again and require no changes.
6. Test and merge the repository change. A merge deploys production; it does
   not deploy the new preview slot.
7. Deploy the five preview apps from current `main`.
8. Upgrade Slack to the full manifest and verify its URLs. Add the two Google
   OAuth redirect URIs. Verify the GitHub App through its API.
9. Present the ledger and obtain separate approval for the production
   Semaphore lease write.
10. Add the `preview` label to a draft canary whose body contains exactly
    `preview_environment=preview-20`, then prove deploy, e2e, and cleanup.

Each failed checkpoint stops the rehearsal. Fix the runbook or automation at
the point of failure before retrying the slot.

## What one slot contains

| Layer         | Per-slot state                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository    | OS and Semaphore resource IDs; derived Auth, Streams, Dummy Petshop, OAuth-audience, mobile, and lease projections                           |
| Doppler       | `preview_N` in `os`, `auth`, `semaphore`, `streams-example-app`, and `dummy-petshop`                                                         |
| Cloudflare    | Two zones, seven Workers, two D1 databases, two KV namespaces, two R2 buckets, one Queue, DNS, routes, six container apps, and email routing |
| External apps | One GitHub App and one Slack app for full integration parity                                                                                 |
| Lease fleet   | One production Semaphore `environment-config-lease` resource                                                                                 |

The seven Workers are OS, its typechecker and worker-bundler sidecars, Auth,
Semaphore, Streams, and Dummy Petshop. OS deploys six sandbox container
classes. AI Search and the container-backed builder were removed in July 2026;
old account objects may still exist and are not a slot template.

## 0. Build the expansion plan

Start from current `main` in a branch and worktree. Record the commit SHA and
run the read-only fleet checks:

```bash
doppler run --project _shared --config prd -- pnpm preview status
doppler run --project _shared --config prd -- pnpm preview reconcile
```

`reconcile` checks existing Semaphore entries, five Doppler configs, and two
active zones. It does not check `envs.ts`, secret shape, deployed Workers,
resource IDs, integration apps, or end-to-end health.

For every proposed slot, the plan must contain:

- both domain names and current zone status;
- every existing Doppler config, Cloudflare object, GitHub App, and Slack app
  with the intended name;
- the exact missing objects to create;
- current account capacity and projected capacity;
- the GitHub organization and Slack workspace IDs;
- any domain price and the maximum approved total;
- a `not-started`, `created`, or `verified` state for each stage.

On 2026-07-20, `iterate-preview-10` through `iterate-preview-19` had active
`.com` and `.app` zones but no matching DNS records or Cloudflare resources.
Recheck; live state wins over this note.

### Capacity

Ten slots currently add 70 Workers, 20 D1 databases, 20 KV namespaces, 20 R2
buckets, and 10 Queues. The 2026-07-20 preview account held 123 Workers, 27 D1
databases, 18 KV namespaces, 29 R2 buckets, and 11 Queues before expansion.
Some are retired objects, which explains differences from slot-count maths.

The current caps reserve 67 GiB memory, 15.25 vCPU, and 180 GB disk per slot.
Nineteen slots reserve 1,273 GiB, 289.75 vCPU, and 3,420 GB. Recalculate from
`SANDBOX_MAX_INSTANCES` and Cloudflare's current limits immediately before
applying the plan.

References: [Workers](https://developers.cloudflare.com/workers/platform/limits/),
[Containers](https://developers.cloudflare.com/containers/platform-details/limits/),
[D1](https://developers.cloudflare.com/d1/platform/limits/),
[KV](https://developers.cloudflare.com/kv/platform/limits/),
[R2](https://developers.cloudflare.com/r2/platform/limits/), and
[Queues](https://developers.cloudflare.com/queues/platform/limits/).

## 1. Teach the repository about slots 10–19

In `envs.ts`, add `preview_10`–`preview_19` to `envs` using
`previewSlot(N, ...)`, with all three resource IDs set to `UNPROVISIONED`. Add
the same names to `semaphoreEnvs` using
`semaphorePreviewSlot(N, UNPROVISIONED)`.

Never invent IDs or copy them from another slot. OS and Auth intentionally
share the Auth D1 ID; Semaphore has its own D1 ID.

The resource-free maps and consumers derive from `envs.ts`:

- `authEnvs`, `dummyPetshopEnvs`, and `streamsExampleEnvs`;
- the preview provisioner and Semaphore inventory;
- Auth audiences and per-slot OAuth client targets;
- mobile server presets.

Streams keeps `previewDependencies: ["auth"]` so the orchestrator selects and
tests one coherent Auth + relying-party revision. This is selection, not deploy
ordering: both derive the same signing key from Doppler and deploy concurrently.
Do not add another numeric slot list or an exact-range test.

Search for operational prose and hidden ranges before moving on:

```bash
rg -n 'nine slots|all nine|1–9|1\.\.9|length: 9|\[1, 2, 3, 4, 5, 6, 7, 8, 9\]' \
  envs.ts scripts apps docs .depot
```

Historical incident notes do not need rewriting. Live procedures do.

## 2. Confirm domains

`ensure-resources` creates records in an existing zone. It does not register a
domain or create a zone.

If a domain is missing, use Cloudflare Registrar's domain-check API to confirm
availability and the real-time price immediately before approval. Registration
is billable and non-refundable. The agent may call the registration API only
after a human approves the exact domain and price ceiling. A changed name or
price invalidates that approval.

Cloudflare registration requires a Registrar write token, a default payment
method, registrant contact, and acceptance of the registration agreement. A
successful registration normally creates the authoritative Cloudflare zone;
read it back and wait for `active` before continuing.

References: [Registrar API](https://developers.cloudflare.com/registrar/registrar-api/)
and [register a domain](https://developers.cloudflare.com/api/resources/registrar/subresources/registrations/methods/create/).

## 3. Create Doppler configs

Do not create `_shared/preview_11`–`preview_19`. App configs inherit shared
Cloudflare credentials from their project-level `preview` root, which inherits
`_shared/preview`. `_shared/preview_10` is old residue, not a template.

After approval, create the two configs the provisioner does not create:

```bash
for project in os dummy-petshop; do
  for n in $(seq 10 19); do
    config="preview_$n"
    doppler configs get "$config" --project "$project" --json >/dev/null 2>&1 ||
      doppler configs create "$config" --project "$project" --environment preview
  done
done
```

Then run:

```bash
pnpm preview provision-auth-preview-configs
```

Do not pass `--rotate`. Without it, existing client secrets, Better Auth
secrets, and service tokens are preserved. The command still writes live
Doppler state, so its exact config list belongs in the approved plan.

Verify names, inheritance, and required-secret presence without printing
values. Auth must have its OAuth seed and runtime secrets; OS, Semaphore, and
Streams must have matching per-slot Auth client IDs and secrets; Semaphore and
Streams must have `AUTH_FORGE_PRIVATE_JWK`. OS must also have
`APP_CONFIG_INTEGRATIONS__PETSHOP`; an OS deploy cannot infer the Dummy Petshop
client.

`APP_CONFIG_PROJECT_APP_SESSION_SECRET` is one non-production value, shared by
Auth and OS and inherited from each project's `dev` and `preview` roots. A
`preview_N` child must not override it. The projects cannot inherit from one
another, so their two roots contain the same value. The provisioner verifies
that the Auth and OS roots agree and fails if a child shadows the root.

If an older fleet has per-slot overrides, migrate it as a separately approved
operation: set the matching Auth/OS roots first, remove only the named child
overrides, verify effective values without printing them, then redeploy Auth
and OS together. This invalidates existing preview sessions. Never delete the
child overrides before both roots are present and equal.

Do not run `pnpm auth:sync-clients`. That older command can point every target
at the Auth config wrapping the command; it is not the isolated preview-stack
provisioner.

## 4. Create integration apps

The Workers can deploy without Slack or GitHub config, but that is not a
complete slot. Slack e2e skips without a signing secret, and GitHub e2e uses
Dummy Petshop instead of the slot's real GitHub App.

### Slack: API first, browser for authorization

Use [the Slack preview-app runbook](../apps/os/docs/slack-preview-app-manifest.md).
The preferred path is Slack's App Manifest API, not ten rounds of form entry:

1. A human generates an app configuration token for the approved test
   workspace. It is user-and-workspace scoped, not app scoped, and normally
   expires after 12 hours.
2. The agent renders and validates all ten manifests before creating anything.
3. After approval, call `apps.manifest.create` sequentially; its Tier 1 rate
   limit is at least one request per minute.
4. Pipe `client_id`, `client_secret`, and `signing_secret` from each response
   directly into `os/preview_N` as `APP_CONFIG_INTEGRATIONS__SLACK`.
5. After OS is live, use the dedicated browser profile to install each app
   through OS's Connect Slack flow. This captures the bot token and claims the
   workspace in OS; installing only from Slack's dashboard is insufficient.

Use the bootstrap manifest until OS can answer Slack's URL verification. Then
apply the full manifest with `apps.manifest.update`. Slack's editor may save the
manifest while still showing **URL isn't verified**; click **Click here to
verify** and wait until that state disappears. Read back the Events API URL,
five bot events, Interactivity URL, Agent View, OAuth callback, and scopes.
Never store the configuration token in git or a long-lived shared preview
config.

Do not install every preview bot into a shared workspace at once. Broad
`message.*` subscriptions make duplicate delivery and duplicate replies likely.
For fleet verification, claim one slot through an OS test project, run the real
Slack round trip, then disconnect it before moving to the next slot.

### GitHub: manifest flow with one approved browser batch

Use [the GitHub preview-app runbook](../apps/os/docs/github-preview-app-manifest.md).
GitHub has no `POST /apps`; the supported manifest flow includes a GitHub review
screen. That does not require ten manual handoffs:

1. Start a local callback receiver and render the ten manifests with a unique
   anti-CSRF `state` for each slot.
2. Open the organization manifest forms in the dedicated browser profile.
3. Confirm the review screen shows `iterate`, the exact ten app names, `.com`
   callback/webhook URLs, and the approved permissions.
4. Once the human approves that batch, the agent may click each Create button,
   capture its one-time code, and call
   `POST /app-manifests/{code}/conversions`.
5. Pipe each conversion response directly into `os/preview_N`. The runtime key
   is `webhookSecret`, not `webhookSigningSecret`.

Stop on an existing app name. Inspect and reconcile it; never create a
near-duplicate or overwrite its settings by guesswork.

Authenticate as each created App and require:

- `GET /app` returns the exact `iterate-preview-N` slug;
- `GET /app/hook/config` returns
  `https://os.iterate-preview-N.com/api/integrations/github/webhook`.

Creation output is not verification. The final smoke still installs the App
through OS and delivers a signed webhook.

### Google: update the shared preview OAuth client

The Auth sign-in flow and OS Google integration use the same non-production
Google OAuth client across preview slots. Add both redirect URIs for every new
slot:

```text
https://auth.iterate-preview-N.com/api/auth/callback/google
https://os.iterate-preview-N.com/api/integrations/google/callback
```

This is a Google Cloud Console write and may require a different signed-in
account from GitHub or Slack. Record the owning project/client in the plan and
stop if the selected account cannot see it. Do not modify the separate
production client.

The Google Console can display rapidly bulk-filled rows that its form model has
not registered. A save then returns HTTP 400 and restores the previous list.
Add redirects in small batches with normal typed input. After every save,
reload the client and require the new values to persist. The slots 10–19
rehearsal succeeded in batches of six after one nineteen-row bulk fill failed.

## 5. Create Cloudflare resources and record IDs

Run management calls sequentially so retries and rate limits remain legible:

```bash
for n in $(seq 10 19); do
  pnpm --dir apps/auth ensure-resources --env "preview_$n"
  pnpm --dir apps/semaphore ensure-resources --env "preview_$n"
  pnpm --dir apps/dummy-petshop ensure-resources --env "preview_$n"
  pnpm --dir apps/os ensure-resources --env "preview_$n"
done
```

Streams has no `ensure-resources`; its deploy creates its DNS record. OS also
installs R2 lifecycle rules, creates its Queue and exact-repo event
subscriptions, and enables inbound Email Routing. On a brand-new slot the
Email Routing catch-all is explicitly deferred because Cloudflare rejects a
Worker action until that script exists; the first OS deploy installs and
verifies the catch-all after uploading the Worker.

Outbound Email Service onboarding remains a Cloudflare dashboard step. Within
the approved batch, an agent may drive it using the dedicated browser profile,
but must stop before onboarding a different sender domain or changing existing
DNS. Verify each sender after saving.

Paste these IDs into the branch:

- OS `projectDirectoryKvId` and `workerBuildCacheKvId`;
- the shared OS/Auth `authDbId`;
- Semaphore `resourcesDbId`.

Run every `ensure-resources` command again. The second pass must match the
recorded IDs and create nothing. Before the first OS deploy, its one expected
deferred result is `Email Routing catch-all ... deferred until worker ...
deploys`; any collision, warning, different ID, or other new object is a failed
checkpoint.

## 6. Test and merge the repository change

Run:

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

Inspect generated Wrangler config for every new environment. Names, routes,
D1/KV IDs, and container caps must be slot-specific.

Merge this branch before deployment or leasing. Never seed production
Semaphore from an unmerged expansion branch.

The normal merge-to-`main` workflows deploy production Auth/OS, Semaphore,
Streams, and Tunnels. They do not deploy newly added preview environments.

## 7. Deploy from current `main`

Pull current `main` after the expansion merges. Deploy while the slots are
still absent from Semaphore, so there is no lease holder to race.

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

Auth, OS, Semaphore, and Streams may deploy concurrently; they derive the same
public signing key from Doppler and do not fetch one another's JWKS. Dummy
Petshop must precede OS e2e. Do not replace a failed deploy with a curl-only
health check; the deploy command validates secrets, resources, migrations,
routes, and smoke probes.

Fresh hostnames can return Cloudflare 522 while edge certificates propagate.
The deploy smoke owns that bounded retry. Auth's post-deploy OAuth-client seed
retries only Cloudflare 522–526 on a bounded 78-second schedule; an
unclassified status such as 500 remains an immediate failure.

Preview orchestration resolves every public app origin from `envs.ts`, the
same source that generates Worker routes. It reads Doppler only for readiness
bearer secrets, merges those with the repository-owned origin, and injects
that origin as `APP_CONFIG_BASE_URL` into each app's e2e process. Do not add
`APP_CONFIG_BASE_URL` duplicates to each Doppler child: OS and Semaphore
intentionally never had them, and requiring them made a correctly provisioned
slot fail before its deploy command started.

Now update Slack from bootstrap to full manifests, complete Slack installation
through OS, and verify each GitHub App's `/app` identity and webhook URL.

## 8. Approve and add Semaphore leases

This is a separate production write. Present the completed verification ledger
and obtain approval immediately before running it from current `main`:

```bash
doppler run --project semaphore --config prd -- \
  pnpm --dir apps/semaphore seed:environment-config-leases

doppler run --project _shared --config prd -- pnpm preview status
doppler run --project _shared --config prd -- pnpm preview reconcile
```

Stop unless `status` reports nineteen slots and `reconcile` reports zero
issues.

Slot handover attempts its atomic Durable Object retirement before looking at
other Workers. Cloudflare rejects the retirement and names every Worker whose
external binding blocks it; cleanup then inspects and detaches only those named
Workers, verifies their settings, and retries. Do not restore an eager account-
wide settings scan: concurrent preview handovers multiplied that scan across
roughly 183 Workers, made every chunk receive a 120-second `Retry-After`, and
could not fit inside CI even after a five-minute cooldown. An unclassified
retirement failure remains fatal, so this optimisation does not bypass the
handover erase.

## 9. Prove the normal lifecycle

Use a small draft canary PR that touches a preview-shared path. The normal CI
path is a standalone body directive plus the `preview` label:

```text
preview_environment=preview-20
```

Markdown examples and comments do not count. The directive selects a slot but
does not make a draft eligible; the label does that. For a fleet sweep, pin,
run, and clean one new slot at a time:

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

After each slot, inspect the managed PR table, CI logs, Cloudflare traces, and
`pnpm preview status`. An unexplained error, skipped Slack test, unhealthy
storage shard, unreleased lease, or mismatched final state fails the slot. Do
not keep feeding work to a sick slot; leave it unavailable and record the
reason until automatic health quarantine exists.

Close the canary only after all ten slots have passed. Run `status` and
`reconcile` once more.

## Resuming safely

Keep this ledger in the expansion PR. `created` is not `verified`; mark the
cell only after reading the state back from the owning system.

| Slot | Domains | Doppler | Cloudflare + second ensure | GitHub | Slack | Five apps | Lease | Lifecycle |
| ---- | ------- | ------- | -------------------------- | ------ | ----- | --------- | ----- | --------- |
| 10   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 11   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 12   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 13   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 14   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 15   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 16   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 17   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 18   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 19   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |

Before resuming, rerun the planning inventory and compare it with this ledger.
If the systems disagree, trust the read-back and investigate. Never “finish” a
half-created object by rotating or replacing credentials unless that action is
explicitly approved.

## Drift found while writing this runbook

- `_shared/preview_10` exists without an app-level stack. It is residue, not a
  template.
- Existing OS preview configs inherited one preview-1 GitHub credential even
  though a GitHub App has only one webhook URL.
- Stored Slack bot tokens for preview 3 and preview 6 returned `invalid_auth`;
  secret presence is not credential verification.
- Slots 10–19 initially had matching Auth/OS session secrets per slot, but the
  values differed across slots and shadowed empty preview roots. Root
  inheritance is the required shape for later slots.
- New OS configs lacked `APP_CONFIG_INTEGRATIONS__PETSHOP`; provisioning now
  writes the fixed Dummy Petshop client before deployment.
- Slack bootstrap manifests preserve OAuth callbacks and scopes but omit Event
  subscriptions, Interactivity, Agent View, and App Home until OS can pass URL
  verification.
- A green merge-to-main production rollout does not deploy preview workers or
  publish new Semaphore leases.
- The old GitHub runbook used `.app` OS URLs, the wrong webhook key, and a
  broken callback-capture script.
- The old Slack bulk guide duplicated manifests and asked humans to paste
  secrets into chat. It has been replaced by the Manifest API workflow.
- Dummy Petshop's deploy comment claimed there was no route or DNS, while its
  generated config uses both.
- Streams lacked its Auth dependency; the expansion change fixes the deploy
  graph.
- AI Search and the container-backed builder were removed after the first
  audit. Their retired account objects demonstrate why code and live state
  must both be checked immediately before expansion.
