---
status: operational-follow-ups
size: large
branch: ops/finish-preview-slots-10-19
started: 2026-07-20
base: af4d2ae48afc3ff66579cf9e5da5e3859c434949
---

# Create preview slots 10–19

## Status

Slots 10–19 are provisioned, deployed, and published in Semaphore's nineteen-
slot production pool. Google has both callback types for every slot; GitHub App
identity/webhooks and every Slack manifest URL are verified. Draft PR #2182
requested preview-14, passed all five deploy/e2e lanes at head `4d8693cd2`, and
proved real Google, GitHub, and Slack connections through OS. Normal cleanup
erased the canary in 18 seconds, released preview-14, and reconciliation is
clean. Remaining work is the separately approved shared-session-root migration
and classification/fix of Cloudflare runtime anomalies observed around the
preview run.

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
- [x] Inventory intended GitHub App names in `iterate` and Slack App names in
  the identified workspace without creating or modifying apps.
  _GitHub slots 11–19 are absent; slot 10 exists under `iterate` with stale
  `.app` URLs and an incomplete permission/event set. Slack workspace
  `T0675PSN873` (`iterate`) has no installed preview-10–19 bots and the signed-in
  owner has no apps with those names._
- [x] Write the exact missing-object plan, per-slot stage states, intended
  writes, current prices, price ceiling request, and stop conditions below.
  _The batch has no purchases. Provider writes, credential generation, and
  stop conditions are enumerated below; production leasing is excluded._
- [x] Obtain explicit approval for the concrete non-production batch.
  _The user approved the six-item batch below on 2026-07-20, requested roughly
  one second between operations, and requested audible `say` progress._
- [x] Add `preview_10`–`preview_19` to `envs.ts` with `UNPROVISIONED` IDs and
  update live operational prose derived from a nine-slot fleet.
  _Added the ten OS/Semaphore entries and updated live nineteen-slot prose in
  commit `37f2057ca`; real resource IDs will replace the markers after ensure._
- [x] Create only approved missing Doppler configs and Auth client/runtime
  secrets; verify config inheritance and secret-name shape.
  _Created all fifty app configs. The provisioner targeted only slots 10–19,
  reported `rotated: false`, and every slot passed config and required-key
  read-back without exposing values._
- [x] Create approved GitHub and Slack apps and pipe credentials directly into
  the matching `os/preview_N` configs.
  _GitHub preview-10 was repaired in place; preview-11–19 were created through
  the state-checked manifest callback flow. Ten Slack bootstrap manifests were
  validated and created sequentially. All twenty Doppler JSON values passed
  read-back and every provider app name/ID was read back without secrets._
- [x] Create Cloudflare resources sequentially, record returned IDs in
  `envs.ts`, and prove idempotence with a clean second ensure pass.
  _Auth, Semaphore, Dummy Petshop, and OS passed twice for every slot. All forty
  assigned D1/KV IDs match live state; named DNS/R2/Queue resources were reused
  on each second pass._
- [x] Run focused preview/config tests, Auth tests, typecheck, lint, and format
  checks; inspect generated Wrangler config for all ten slots.
  _149 focused preview/config tests and 65 Auth tests pass. All five generated
  app blocks were inspected for slots 10–19; full typecheck, lint, and format
  checks are green._
- [x] Push the repository change, open a draft PR early, and keep its external-
  user summary and this ledger current.
  _Draft PR https://github.com/iterate/iterate/pull/2161 is open without the
  `preview` label, so it cannot deploy before the merge/approval boundary._
- [x] Add a backwards-compatible acquisition allow-list and an exact PR-body
  slot selector for a controlled expanded-fleet canary.
  _Stacked PR #2163 keeps old clients on preview-1 through preview-9; this PR
  requires all configured slugs and accepts one standalone directive such as
  `preview_environment=preview-17` without bypassing preview eligibility._
- [x] Merge the repository change before deploying or leasing the slots.
  _PR #2161 squash-merged as `fe1f3d4a`; the production Auth/OS, Semaphore,
  Streams, tunnels, test, lint, and publish checks all passed._
- [x] Deploy Auth, Dummy Petshop, Semaphore, Streams, and OS sequentially for
  each slot from current `main`; verify integrations and operational telemetry.
  _All fifty deployments passed. Fresh-host 522s recovered within bounded
  smoke checks. GitHub identity/webhook checks and all ten Slack full-manifest
  URL verifications passed._
- [ ] Migrate the project-app session secret to matching Auth/OS preview roots,
  remove child overrides, and redeploy Auth/OS together after explicit approval.
- [x] Add the two Google OAuth redirect URIs for every new slot.
  _The shared non-production `dev` client now persists both Auth and OS
  callbacks for previews 1–19, with no missing or duplicate preview URI._
- [x] Prove the preview-14 OS-side Slack/GitHub/Google connections.
  _A disposable project connected all three providers. Gmail profile and the
  dedicated private GitHub smoke repository returned HTTP 200 through itx.
  Slack authenticated `iteratepreview14`, received and routed a signed mention,
  created the thread agent, and replied `preview-14 canary ok`._
- [x] Present the completed provisioning ledger and obtain separate approval
  to add the production Semaphore leases.
  _The user approved publication after reviewing the deployed provider and
  Worker state._
- [x] Seed leases and require nineteen-slot status with zero config drift.
  _Semaphore reports nineteen resources; slots 10–19 were available after
  seeding and reconciliation returned no issues. Preview-14 is now held by
  PR #2182 as explicitly requested._
- [x] Prove the assign/run/cleanup lifecycle with the draft canary PR.
  _PR #2182 claimed preview-14 from its standalone body directive, deployed and
  tested all five apps, then normal cleanup erased OS/Auth/Streams state in 18
  seconds and released the lease. Status reports preview-14 available and
  reconciliation returns `{}`; the `preview` label was removed afterwards._
- [ ] Move this task to `tasks/complete/` with a date prefix after all ten slots
  pass the normal lifecycle.

## Expansion ledger

`created` is not `verified`. Cells stay unchecked until live state has been
read back from the owning system.

| Slot | Domains | Doppler | Cloudflare + second ensure | GitHub | Slack | Five apps | Lease | Lifecycle |
| ---- | ------- | ------- | -------------------------- | ------ | ----- | --------- | ----- | --------- |
| 10   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 11   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 12   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 13   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 14   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☑         |
| 15   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 16   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 17   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 18   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |
| 19   | ☑       | ☑       | ☑                          | ☑      | ☑     | ☑         | ☑     | ☐         |

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
  organization. Its homepage, callback, and webhook URLs all use the stale
  `os.iterate-preview-10.app` host; current instructions require `.com`. It is
  missing repository-advisory write, Actions-variable read, Merge-queue read,
  and email-address read permission, plus explicit `merge_group` and
  `repository_advisory` subscriptions. `installation_repositories` is delivered
  automatically and cannot be explicitly selected. Because the one-time
  manifest credentials were not stored in `os/preview_10`, recovery requires
  approved generation of a new client secret, private key, and webhook secret.
  Existing client secrets and keys will not be deleted in this batch.
- `iterate (preview-11)` through `iterate (preview-19)` and their expected
  slugs return no GitHub App and can be created through the reviewed manifest
  flow after approval. A preview-11 manifest with the exact corrected
  permissions and events in `github-preview-app-manifest.md` reaches GitHub's
  final review page successfully; Create has not been clicked.

Slack workspace: `iterate` (`T0675PSN873`).

- The signed-in owner has no `iterate (preview-10)`–`iterate (preview-19)`
  apps. Workspace-wide bot inventory shows installed apps for previews 1–9 and
  none for 10–19.
- Apply needs one short-lived configuration token for this workspace. Render
  and validate ten bootstrap manifests first; create sequentially only after
  approval, then update to the full manifests and install through OS after the
  Workers are live.

## Intended non-production writes

This is the batch presented for approval:

1. Commit the repository edits above with `UNPROVISIONED` IDs.
2. Create the 50 missing app-level Doppler configs and run the non-rotating Auth
   preview provisioner for slots 10–19.
3. Create Slack apps `iterate (preview-10)`–`iterate (preview-19)` in workspace
   `T0675PSN873` and write only `APP_CONFIG_INTEGRATIONS__SLACK` to their
   matching `os/preview_N` configs.
4. Update preview-10's three URLs from `.app` to `.com`, add the four missing
   permissions and two explicit subscriptions listed above, generate a new
   client secret/private key/webhook secret without deleting old credentials,
   and write the recovered integration to `os/preview_10`. Create GitHub Apps
   preview-11–19 in `iterate` from the reviewed manifest and write each returned
   integration only to the matching OS config.
5. Run the four create-only Cloudflare ensure commands for every slot, paste
   the resulting 40 assigned IDs into `envs.ts`, and require a no-change second
   pass.
6. Test, push, and open a draft PR. Do not deploy or seed leases before the
   repository change merges.

Production Semaphore lease creation is explicitly outside this approval and
will be requested only after all ten slots deploy and verify cleanly.

Stop and request new approval if a target name exists unexpectedly, an owner or
workspace differs, a provider review shows different permissions/URLs, a
purchase is requested, an existing credential would need deletion, an ensure
command wants to replace/delete a resource, or provider capacity differs from
the recorded projection.

## Implementation log

- 2026-07-20: Started from `af4d2ae48` in
  `../worktrees/iterate/create-preview-slots-10-19`. The first pass is limited
  to the runbook's read-only planning phase.
- 2026-07-20: Confirmed production's nine-slot inventory reconciles with zero
  issues; audited all target provider objects without writes; recalculated
  current and projected Cloudflare capacity against the 2026-07-20 official
  limits; and attached Playwriter to the explicitly authorized main Chrome for
  authenticated GitHub/Slack ownership checks.
- 2026-07-20: Completed the sudo-protected preview-10 settings audit. A dry-run
  preview-11 GitHub manifest review exposed invalid UI-label aliases and an
  invalid explicit `installation_repositories` subscription in the merged
  runbook. Corrected the manifest to GitHub's API keys, added the Merge-queue
  permission required by `merge_group`, and reached the final review page
  without clicking Create.
- 2026-07-20: The user explicitly approved the intended non-production writes.
  Production deployment and Semaphore lease creation remain unapproved.
- 2026-07-20: The merged provisioner would have re-written slots 1–9 while
  creating 10–19. Added and tested `--slots 10-19`, then used it to create only
  the approved configs/secrets. All fifty configs and required inherited/local
  secret names passed read-back; no values were printed.
- 2026-07-20: Created GitHub Apps 11–19 through a loopback callback that
  validated per-slot state and wrote conversion responses directly to Doppler.
  Repaired preview-10's `.com` URLs, four permissions, and two events; generated
  additive credentials without deleting the old client secret/private key.
  All ten slugs and credential shapes passed provider/Doppler read-back.
- 2026-07-20: Validated and created Slack bootstrap apps 10–19 through one
  short-lived workspace-scoped configuration token, respecting the Tier-1
  creation interval. Dashboard IDs are `A0BJLTR3K17`, `A0BJK0RRN1Y`,
  `A0BJK11HY1G`, `A0BJCPH0RMZ`, `A0BJFNL8WRK`, `A0BJFNV85LM`, `A0BJFP3960M`,
  `A0BJ3M8628P`, `A0BJM0DSH0R`, and `A0BJCR32X3M`. The clipboard and temporary
  helpers/copies were removed; the token expires within twelve hours.
- 2026-07-20: Preview-10 provisioning created Auth D1
  `7f7562b4-f76a-4c4d-a51e-003e6995f591`, Semaphore D1
  `384502bd-21e2-47df-88dd-b1b76c8ccb40`, their DNS, Dummy Petshop DNS, two OS
  KV namespaces, two R2 buckets, and queue `os-preview-10-events`. The OS ensure
  then stopped on Cloudflare's 405: only one account-level `artifacts` source
  is allowed, while the old reconciler attempted one per worker.
- 2026-07-20: Reproduced and fixed that defect test-first. Deploy setup now
  backfills only exact-repo subscriptions; deployed repo creation/replacement
  synchronously ensures the exact subscription before a push. The Cloudflare
  token is now a required deployment secret (present in production and all 19
  preview configs), and an explicit deployment marker prevents local dev from
  mutating account subscriptions. The 36 focused tests and changed-file lint
  pass. OS typecheck reaches an unrelated existing duplicate-React-types error
  in `packages/ui` (`message.tsx` and `spinner.tsx`) and reports no changed-file
  errors.
- 2026-07-20: The preview-10 retry passed the former subscription failure and
  created OS/events/MCP/project-host DNS plus enabled Email Routing. Cloudflare
  then rejected the catch-all with code 2016 because `os-preview-10` is not yet
  deployed. Fixed this second ordering defect test-first: pre-deploy setup now
  records the one explicit deferral, while OS deploy requires the Worker and
  installs the rule after upload. Missing zones and every non-404 API failure
  remain fatal. All 39 focused tests and changed-file lint pass.
- 2026-07-20: The repaired OS ensure completed its pre-deploy phase and returned
  project-directory KV `975b82fbaaf94f2285c2a080b0893f9d` and build-cache KV
  `225a2d03540343c8a80a80e8ee81a92e`; both are now recorded in `envs.ts`.
  The subsequent four-command second ensure is recorded below.
- 2026-07-20: Preview-10 passed the complete Auth, Semaphore, Dummy Petshop,
  and OS second ensure. Every assigned ID matches `envs.ts`; no object was
  created or changed. The documented email catch-all deferral remains until
  first OS deploy and is tracked under the five-app deployment checkpoint.
- 2026-07-20: Provisioned previews 11–19 sequentially with an audible pause
  before every operation. For each slot, recorded its Auth D1, Semaphore D1,
  project-directory KV, and build-cache KV IDs, then reran all four ensures.
  Every second pass reused the exact IDs and named resources, with no creation,
  warning, collision, or drift. No `UNPROVISIONED` marker remains in the new OS
  or Semaphore entries.
- 2026-07-20: Verification initially exposed a pre-existing pnpm peer-resolution
  defect: `lucide-react` and `streamdown` declarations resolved mobile's React
  19.1 types while UI used 19.2. Added package extensions declaring their
  `@types/react` peer. UI now resolves 19.2, mobile remains on 19.1, both
  independently typecheck, and the full monorepo typecheck is green. The 149
  focused tests, 65 Auth tests, full lint, full format check, and generated
  five-app config audit for every new slot all pass.
- 2026-07-20: Pushed `ops/create-preview-slots-10-19` and opened draft PR #2161
  without a preview label. The PR body separates completed non-production
  provisioning from the unapproved post-merge deploy and production lease
  phases.
- 2026-07-20: The first CI lint/typecheck run found one dead export left by the
  Artifacts subscription refactor. Removed `queueIdForWorkerEventQueue`; its 14
  focused tests, full knip, and full typecheck pass locally before the retry.
- 2026-07-20: PR head `6b42dc148` passed every check, including full tests and
  lint/typecheck. GitHub reports clean merge state with zero reviews and zero
  unresolved threads. The repo has no active dispatchable review-monitor
  workflow, so no passive process is being represented as a persistent monitor.
- 2026-07-21: Merged prerequisite PR #2163 after two Bugbot fixes hardened
  allow-list-aware waiter dispatch. Merged current `main` into #2161, retargeted
  it to `main`, and marked it ready for review.
- 2026-07-21: Fixed two valid #2161 Bugbot findings test-first. Requested-slot
  assignment now erases an adopted slot unless it matches the PR's recorded
  provenance. Artifact creation now runs exact-subscription setup only before
  the first push, preserving interrupted-create recovery without making seeded
  repository lookup depend on Cloudflare's subscriptions API. After merging
  current `main`, all 2,113 OS unit tests, 120 preview-tool tests, full
  monorepo typecheck, lint, and format checks pass locally.
- 2026-07-21: Fixed Bugbot's public-import event race test-first. After the
  atomic Cloudflare import becomes ready, OS installs the exact-repository
  subscription, reads the imported branch head from Artifacts, and appends an
  idempotent queue-shaped initial-push fact. This preserves commit/task facts
  without transferring Git history through the Worker. All 2,114 OS unit
  tests, OS typecheck, and changed-file lint/format checks pass locally.
- 2026-07-21: Fixed Bugbot's slot-move notice finding test-first. A successful
  `preview_environment` move now names the directive as the reason; only an
  unrequested move says the old lease lapsed and was taken. All 187 scripts
  tests and changed-file lint/format checks pass locally.
- 2026-07-21: Fixed Bugbot's missing-zone provisioning regression test-first.
  Create-only setup now reports Email Routing as deferred when its zone has not
  been created yet, so D1/KV reconciliation can still print the IDs needed for
  `envs.ts`; post-deploy reconciliation continues to fail hard until the zone
  exists. All 14 focused tests, OS typecheck, and changed-file lint/format
  checks pass locally.
- 2026-07-21: Fixed Bugbot's interrupted requested-slot move test-first. When
  the Semaphore already attributes both old and requested slots to the PR, the
  assigner reissues its own requested lease, completes the normal erase, and
  releases the old recorded lease. It never force-evicts another holder. All
  188 scripts tests, scripts typecheck, and changed-file lint/format checks
  pass locally.
- 2026-07-21: Fixed two further Bugbot findings test-first. Failed exact-slot
  acquisition now releases any unrelated lease adopted earlier in the attempt,
  combining assignment and release errors if both fail. The directive parser
  ignores fenced Markdown examples and HTML comments while still accepting one
  actionable whole-line directive. All 190 scripts tests, scripts typecheck,
  and changed-file lint/format checks pass locally.
- 2026-07-21: Corrected exact-slot failure cleanup test-first. A failed move now
  preserves the PR's recorded working lease; only an unrelated lease adopted
  during the attempt is released. All 191 scripts tests, scripts typecheck, and
  changed-file lint/format checks pass locally.
- 2026-07-21: Preview e2e exposed an exact-subscription scalability defect.
  Preview-6 project creation timed out because each fresh repo scanned all
  29,018 account subscriptions (291 API pages, overwhelmingly preview-5)
  before its first push. Runtime lookup now filters by the worker's queue and
  exponentially probes then binary-searches name-sorted pages; deploy-time
  reconciliation also filters by queue. The two failed smoke calls were
  `log_6c4dd43707fb4342afd3904b1d576133` and
  `log_7994cc2aba7046429a3ffcecd52522de`; the latter traces to
  `cd8ed0b43cce8ac8988f2b5d3247f74f`. All 2,116 OS unit tests, OS typecheck,
  and changed-file lint/format checks pass locally.
- 2026-07-21: Fixed Bugbot's sorted-page overshoot finding test-first. If an
  exponential probe lands after the desired subscription, lookup now brackets
  and searches the skipped pages instead of declaring the subscription absent
  and attempting a duplicate POST. The regression places the existing item on
  page 3 and later names on page 4. All 2,116 OS unit tests, OS typecheck, lint,
  and changed-file format checks pass locally.
- 2026-07-21: Post-merge deployment stopped before its first write because
  Auth preview-10 lacked `APP_CONFIG_PROJECT_APP_SESSION_SECRET`. The remote-app
  auth change made that secret required, but preview provisioning did not copy
  one shared value into both Auth and OS. The provisioner now creates or
  preserves one per-slot value and rejects divergent existing values. The live
  command will run without `--rotate`, so existing OAuth and app credentials
  remain unchanged.
- 2026-07-21: Provisioned the missing session and Dummy Petshop config, then
  deployed all five apps for slots 10–19. Every final smoke passed. Fresh
  hostname 522s remained inside bounded readiness checks; two Auth OAuth-client
  seeds exposed a missing post-smoke retry, now covered by a bounded 522–526
  regression test while unclassified 500s still fail immediately.
- 2026-07-21: Authenticated as every preview GitHub App and verified the exact
  slug and `.com` webhook URL through `GET /app` and `GET /app/hook/config`.
  Upgraded Slack apps 10–19 from bootstrap to full manifests in the logged-in
  browser and explicitly verified every Events API URL.
- 2026-07-21: Audited session-secret inheritance. Auth and OS match within each
  preview slot but slots differ and both preview roots are empty; Auth/OS dev
  roots already match. The follow-up provisioner now models one non-production
  root value and rejects child overrides. Live migration remains separately
  approved because it invalidates existing preview sessions.
- 2026-07-21: Added and persisted Google Auth and OS integration callbacks for
  previews 10–19 on the shared non-production OAuth client. A rapid nineteen-
  row bulk fill returned HTTP 400 and rolled back; normal typed batches of six
  persisted, and a final reload found all 38 preview callbacks exactly once.
- 2026-07-21: Published the approved Semaphore resources. Production reports
  nineteen total slots and zero config drift. Adding the `preview` label to
  draft PR #2182 caused its standalone selector to claim preview-14 exactly.
- 2026-07-21: Cancelled the first preview-14 lifecycle run while it was safely
  parked at 503. The preceding fifty-app deployment had exhausted Cloudflare's
  five-minute API budget, so each ten-Worker chunk of the required external DO-
  binding scan received a 120-second `Retry-After` and could not fit inside the
  CI budget.
- 2026-07-21: Cancelled a second attempt after a five-minute quiet period when
  four concurrent preview jobs kept the shared Cloudflare budget saturated.
  Reproduced the fleet-scaling defect and changed DO cleanup to try the atomic
  retirement first, inspect only binding-owner Workers named by Cloudflare,
  verify each detach, and retry. Normal cleanup now makes zero Worker-settings
  reads; named-reference and unclassified-failure tests keep the path fail-
  closed. The runbook records the new invariant and removes the ineffective
  cooldown advice.
- 2026-07-21: The next run erased preview-14 in 14 seconds, proving the targeted
  cleanup under production-shaped load. OS and Semaphore then failed before
  their deploy commands because preview orchestration required a Doppler
  `APP_CONFIG_BASE_URL` even though their routes and public origins live only
  in `envs.ts`. Auth, Streams, and Dummy Petshop deployed successfully. Merged
  current `main`; orchestration now resolves every public origin from `envs.ts`
  and merges only readiness bearer secrets from Doppler. Regression tests cover
  an origin absent from Doppler and the origin-plus-bearer combination.
- 2026-07-21: The corrected run deployed all five preview-14 apps. Auth, Dummy
  Petshop, and Streams e2e passed. OS e2e then showed that the repo-owned origin
  also has to enter its test process as `APP_CONFIG_BASE_URL`; orchestration now
  injects the recorded origin without duplicating it in Doppler. Semaphore's
  twelve assertions passed, but a failed first attempt left its concurrent
  sibling waiter unobserved long enough for Vitest to report a rejection; both
  waiters now receive rejection handlers immediately and settle in `finally`.
  The complete live Semaphore suite passes against preview-14.
- 2026-07-21: That run passed all non-OS apps but surfaced eleven OS retries
  during a burst of stream timeouts and one Cloudflare subscriptions API 500.
  The only surviving failure reached the project-app sign-in page, whose
  accessible snapshot exposed `Continue with iterate` as a link while the test
  selected a button. Both project-app sign-ins now select the rendered link.
  After merging current `main` (including its project-create fast path), the
  complete real-member/project-app authentication scenario passed against
  preview-14 in 37 seconds with retries disabled.
- 2026-07-21: The first full rerun failed during Cloudflare's deployment
  handover: an internal Durable Object storage reset was followed by
  machine-move and network-loss errors. A stable-deployment rerun passed every
  completed scenario but hit the local eight-minute orchestration ceiling
  after Watchman spent sixty seconds falling back to its node crawler.
- 2026-07-21: Depot attempt 2 passed all 59 browser tests and 161 of 162 OS
  Vitest assertions. The one failure reused smoke project
  `preview-mcp-smoke-9ae15adc`; its config repo had durably recorded
  `repos/create-failed` after Cloudflare returned HTTP 500/code 15000 while
  reading exact-subscription page 8. That terminal fact correctly kept the
  project unready, but retrying the preview could never heal it. Cloudflare API
  reads now retry transient 408/429/5xx responses at most twice, log every
  absorbed attempt, and never replay mutations. The new regression is green
  alongside 47 event/repo processor tests.
- 2026-07-21: Merged current `main` normally and reran preview-14 at
  `4d8693cd2`. Every required check passed. The five-app preview run deployed
  exact-head revisions; Auth passed 5 scenarios, Semaphore 12, Streams 21 API
  plus 31 browser scenarios, Dummy Petshop 6, and OS passed with one bounded
  retry of the live-stream delivery control.
- 2026-07-21: Used a disposable preview-14 project to prove external providers
  through the product surface. Google Auth and OS callback redirects completed;
  Gmail `/users/me/profile` returned HTTP 200. GitHub installation `148103582`
  read `iterate/iterate-os-linked-repo-smoke` through Octokit with HTTP 200.
  Slack connection `t0675psn873` authenticated as `iteratepreview14`, joined
  `#slack-agent-e2e-test`, received the CI actor's signed mention, configured
  the route, created its thread agent, and replied `preview-14 canary ok` in
  thread <https://iterate-com.slack.com/archives/C096Q1M4Y86/p1784660547967219>.
- 2026-07-21: The first Gmail read correctly failed after an accidental UI
  disconnect: the journal contained `google/disconnected`, and the connection
  secret had been made unusable by clearing its egress pin and material.
  Reconnecting restored both Google origins and material, after which the read
  passed. A visible historical connection row is therefore not proof that the
  connection is live; verify its status or perform the provider call.
- 2026-07-21: The ad-hoc Slack smoke reported `invalid_auth` for
  `os/preview_14`'s CI trigger actor, then succeeded with the canonical
  `_shared/prd` actor. The product connection token itself passed `auth.test`.
- 2026-07-21: A 30-minute `os-preview-14` telemetry audit after CI found 28
  error-level events. Intentional test events (`kill requested` and the explicit
  retry-path failure) are understood, but Durable Object storage resets,
  network loss, Worker cancellation/hangs, and default-project-worker readiness
  failures remain operational follow-up. The canary is functionally green, but
  the task stays open under the repository's no-unexplained-errors rule.
- 2026-07-21: Ran the ordinary PR cleanup after the provider canaries. It
  reacquired the lapsed-but-free preview-14 lease, erased Auth/OS/Streams state,
  parked OS and Streams at 503, and released the lease in 18 seconds. Production
  status then reported 19 total / 17 available / 2 active / 0 orphaned, and
  reconciliation returned `{}`. Removed #2182's `preview` label so the draft
  cannot immediately reacquire another slot.
- 2026-07-22: Corrected the CI-trigger diagnosis. `os/preview_14` does not have
  `SLACK_CI_BOT_TOKEN`; the ad-hoc command sent `Bearer undefined`, so its
  `invalid_auth` response did not identify a stale secret. `_shared/prd` is the
  canonical live actor. Fresh `auth.test` calls also found the preview 3 and 6
  product-bot fallback tokens healthy. Updated the smoke preflight to fail
  clearly on a missing variable and verify the canonical actor before posting.
- 2026-07-22: Merged current `main` normally. Main deliberately retired the
  Cloudflare Artifacts subscription-delivery path, so the merge drops this
  branch's obsolete exact-subscription retry and regression while retaining the
  preview-origin and shared-session-secret work. The scripts suite (266 tests),
  scripts typecheck, focused formatting, and diff checks pass.
