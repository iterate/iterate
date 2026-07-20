---
status: planning-awaiting-github-sudo
size: large
branch: ops/create-preview-slots-10-19
started: 2026-07-20
base: af4d2ae48afc3ff66579cf9e5da5e3859c434949
---

# Create preview slots 10–19

## Status

Read-only planning is roughly 90% complete. Repository, Semaphore, Doppler,
Cloudflare, domain, capacity, GitHub ownership, and Slack workspace inventories
are recorded below; no external state has been changed. The remaining planning
step is a sudo-protected read of the existing `iterate (preview-10)` GitHub App
settings before presenting the concrete apply approval.

## Goal

Expand the preview fleet from `preview_1`–`preview_9` to
`preview_1`–`preview_19`, following `docs/adding-preview-slots.md`.

Each new slot must have repository configuration, inherited Doppler configs,
Cloudflare resources, dedicated GitHub and Slack apps, five deployed apps, a
production Semaphore lease, and one proven assign/run/cleanup lifecycle.

## Assumptions and approval boundaries

- The requested batch is exactly `preview_10`–`preview_19`.
- Planning is read-only. Creating configs, cloud resources, integration apps,
  or domains requires approval of the concrete inventory first.
- Any domain purchase requires approval of the exact names, live prices, and a
  maximum total immediately before registration.
- GitHub App creation is limited to the `iterate` organization after approval.
- Slack App creation is limited to the workspace identified in the plan after
  approval.
- Adding production Semaphore leases is a separate approval after every slot
  has been provisioned, deployed, and verified.
- Existing objects are inspected and reconciled. They are never overwritten,
  rotated, renamed, deleted, or replaced without specific approval.
- Credentials go directly from provider responses to Doppler. They must not
  appear in this task, terminal output, chat, screenshots, or git.

## Checklist

- [x] Record the base SHA and create a branch/worktree with this durable ledger.
  _Started `ops/create-preview-slots-10-19` from `af4d2ae48` in the standard
  sibling worktree path._
- [x] Run read-only Semaphore status and reconciliation from production.
  _Production reports nine resources, seven available, two leased, and zero
  reconciliation issues._
- [x] Inventory `envs.ts`, operational prose, hidden numeric ranges, and every
  repository edit needed for slots 10–19.
  _The canonical maps derive from `envs.ts`; live range prose remains in
  `docs/dev-environments.md` and `apps/os/docs/architecture-and-operations.md`._
- [x] Inventory Doppler config names, inheritance, and required secret-name
  presence across `os`, `auth`, `semaphore`, `streams-example-app`, and
  `dummy-petshop` without printing values.
  _All fifty app configs are missing. `_shared/preview_10` and the retired
  `events/preview_10` config are old residue; `_shared/preview_11`–`preview_19`
  do not exist and must not be created._
- [x] Inventory both Cloudflare zones and every slot-named Worker, D1 database,
  KV namespace, R2 bucket, Queue, container app, DNS record, route, and email
  routing object.
  _All twenty zones are active. Slots 10–19 have no matching account resources,
  DNS records, Worker routes, or enabled Email Routing rules._
- [x] Recalculate current Cloudflare usage and projected capacity from the
  checked-in container settings and current platform limits.
  _The live reservation is 683 GiB / 161.25 vCPU / 1,764 GB disk; the immediate
  post-batch projection is 1,673 GiB / 393.75 vCPU / 4,204 GB against current
  limits of 6 TiB / 1,500 vCPU / 30 TB._
- [x] Check `.com` and `.app` domain status and live registration prices for any
  missing domain without purchasing anything.
  _All twenty zones are already active, so this batch requires no domain
  registration and has a $0 domain-purchase ceiling._
- [ ] Inventory intended GitHub App names in `iterate` and Slack App names in
  the identified workspace without creating or modifying apps.
  _GitHub slots 11–19 are absent; slot 10 exists under `iterate` and awaits a
  sudo-protected settings read. Slack workspace `T0675PSN873` (`iterate`) has no
  installed preview-10–19 bots and the signed-in owner has no apps with those
  names._
- [ ] Write the exact missing-object plan, per-slot stage states, intended
  writes, current prices, price ceiling request, and stop conditions below.
- [ ] Obtain explicit approval for the concrete non-production batch.
- [ ] Add `preview_10`–`preview_19` to `envs.ts` with `UNPROVISIONED` IDs and
  update live operational prose derived from a nine-slot fleet.
- [ ] Create only approved missing Doppler configs and Auth client/runtime
  secrets; verify config inheritance and secret-name shape.
- [ ] Create approved GitHub and Slack apps and pipe credentials directly into
  the matching `os/preview_N` configs.
- [ ] Create Cloudflare resources sequentially, record returned IDs in
  `envs.ts`, and prove idempotence with a clean second ensure pass.
- [ ] Run focused preview/config tests, Auth tests, typecheck, lint, and format
  checks; inspect generated Wrangler config for all ten slots.
- [ ] Push the repository change, open a draft PR early, and keep its external-
  user summary and this ledger current.
- [ ] Merge the repository change before deploying or leasing the slots.
- [ ] Deploy Auth, Dummy Petshop, Semaphore, Streams, and OS sequentially for
  each slot from current `main`; verify integrations and operational telemetry.
- [ ] Present the completed provisioning ledger and obtain separate approval
  to add the production Semaphore leases.
- [ ] Seed leases, require nineteen-slot status and zero reconciliation issues,
  and prove assign/run/cleanup for each slot with a draft canary PR.
- [ ] Move this task to `tasks/complete/` with a date prefix after all ten slots
  pass the normal lifecycle.

## Expansion ledger

`created` is not `verified`. Cells stay unchecked until live state has been
read back from the owning system.

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

## Read-only inventory

Inventory time: 2026-07-20. Live state wins over this record when resuming.

### Fleet and repository

- Base commit: `af4d2ae48afc3ff66579cf9e5da5e3859c434949`.
- Production Semaphore: 9 resources, 7 available, 2 leased, 0 orphaned, 0
  reconciliation issues.
- Repository: add ten `previewSlot(N, {...UNPROVISIONED})` entries and ten
  `semaphorePreviewSlot(N, UNPROVISIONED)` entries to `envs.ts`. The Auth,
  Streams, Dummy Petshop, mobile, OAuth-audience, and lease projections derive
  from those maps.
- Update the live nineteen-slot procedure text in `docs/dev-environments.md`
  and the deployed range in `apps/os/docs/architecture-and-operations.md`.
  Historical nine-slot incident notes and preview-9 command examples stay.

### Domains

Every target has an active Cloudflare zone in the preview account:

| Slot | `.com` | `.app` | DNS/routes before apply |
| ---- | ------ | ------ | ----------------------- |
| 10–19 | active | active | none |

There is no domain purchase in this batch. The approved maximum domain spend
can therefore be `$0`; any later missing-domain or price result invalidates the
plan and requires a new approval.

### Doppler

- Missing configs: `preview_10`–`preview_19` in each of `os`, `auth`,
  `semaphore`, `streams-example-app`, and `dummy-petshop` (50 configs total).
- Create no `_shared` configs. `_shared/preview_10` is old residue and currently
  contains only shared/environment-shaped names; `events/preview_10` inherits
  it. Slots 11–19 have no matching `_shared` branch config.
- `pnpm preview provision-auth-preview-configs` without `--rotate` will ensure
  the Auth preview root and forge key roots, then write each slot's three OAuth
  clients, Auth seed/runtime secrets, and matching OS/Semaphore/Streams client
  credentials. Existing credentials are preserved.
- GitHub and Slack provider responses will be piped directly to
  `os/preview_N`; no credential value will be logged or written to disk in the
  repository.

### Cloudflare

Current account inventory and the immediate post-batch projection:

| Resource | Current | Add | Projected | Current documented limit |
| -------- | ------: | --: | --------: | -----------------------: |
| Workers | 123 | 60 | 183 | 500 paid |
| D1 databases | 27 | 20 | 47 | 50,000 paid |
| KV namespaces | 18 | 20 | 38 | 1,000 |
| R2 buckets | 29 | 20 | 49 | 1,000,000 |
| Queues | 11 | 10 | 21 | 10,000 |
| Container apps | 56 | 70 | 126 | bounded by resources below |

| Container reservation | Current | Add | Immediate projected | Account limit |
| --------------------- | ------: | --: | ------------------: | ------------: |
| Memory | 683 GiB | 990 GiB | 1,673 GiB | 6 TiB |
| vCPU | 161.25 | 232.5 | 393.75 | 1,500 |
| Disk | 1,764 GB | 2,440 GB | 4,204 GB | 30 TB |

One retired `os-preview-5-builder-*` container app remains live. It is counted
above, is not a template for new slots, and will not be deleted in this task.

Each slot adds these named objects:

- Workers: `auth-preview-N`, `dummy-petshop-preview-N`,
  `semaphore-preview-N`, `streams-example-app-preview-N`, `os-preview-N`, and
  `os-preview-N-typechecker`.
- D1: `auth-preview-N-auth-db` and `semaphore-preview-N-resources`.
- KV: `os-preview-N-project-directory` and
  `os-preview-N-worker-build-cache`.
- R2: `os-preview-N-sandboxes` and `os-preview-N-files`.
- Queue: `os-preview-N-events`.
- Containers: six OS sandbox-size apps plus the `standard-3`, four-instance
  Worker Builder pool (seven apps, 99 GiB / 23.25 vCPU / 244 GB per slot).
- DNS and routes: OS, events, MCP, Auth, Semaphore, Dummy Petshop, Streams,
  project-host apex/wildcard, and the project-host Email Routing catch-all.

### External apps

GitHub organization: `iterate`.

- `iterate (preview-10)` exists as private App ID `4233983`, slug
  `iterate-preview-10`, owned by `iterate`, with no installation in the
  organization. Its public external URL is the stale
  `https://os.iterate-preview-10.app`; current instructions require `.com`.
  Callback/webhook settings still need the sudo-protected read. Because the
  one-time manifest credentials were not stored in `os/preview_10`, recovery
  will require separately approved changes/credential generation rather than
  pretending this App is new.
- `iterate (preview-11)` through `iterate (preview-19)` and their expected
  slugs return no GitHub App and can be created through the reviewed manifest
  flow after approval.

Slack workspace: `iterate` (`T0675PSN873`).

- The signed-in owner has no `iterate (preview-10)`–`iterate (preview-19)`
  apps. Workspace-wide bot inventory shows installed apps for previews 1–9 and
  none for 10–19.
- Apply needs one short-lived configuration token for this workspace. Render
  and validate ten bootstrap manifests first; create sequentially only after
  approval, then update to the full manifests and install through OS after the
  Workers are live.

## Intended non-production writes

This is the batch that will be presented for approval after the final GitHub
read:

1. Commit the repository edits above with `UNPROVISIONED` IDs.
2. Create the 50 missing app-level Doppler configs and run the non-rotating Auth
   preview provisioner for slots 10–19.
3. Create Slack apps `iterate (preview-10)`–`iterate (preview-19)` in workspace
   `T0675PSN873` and write only `APP_CONFIG_INTEGRATIONS__SLACK` to their
   matching `os/preview_N` configs.
4. Recover the existing GitHub preview-10 App only through separately approved
   exact setting/credential changes; create GitHub Apps preview-11–19 in the
   `iterate` organization; write only `APP_CONFIG_INTEGRATIONS__GITHUB` to the
   matching OS configs.
5. Run the four create-only Cloudflare ensure commands for every slot, paste
   the resulting 40 assigned IDs into `envs.ts`, and require a no-change second
   pass.
6. Test, push, and open a draft PR. Do not deploy or seed leases before the
   repository change merges.

Production Semaphore lease creation is explicitly outside this approval and
will be requested only after all ten slots deploy and verify cleanly.

## Implementation log

- 2026-07-20: Started from `af4d2ae48` in
  `../worktrees/iterate/create-preview-slots-10-19`. The first pass is limited
  to the runbook's read-only planning phase.
- 2026-07-20: Confirmed production's nine-slot inventory reconciles with zero
  issues; audited all target provider objects without writes; recalculated
  current and projected Cloudflare capacity against the 2026-07-20 official
  limits; and attached Playwriter to the explicitly authorized main Chrome for
  authenticated GitHub/Slack ownership checks.
