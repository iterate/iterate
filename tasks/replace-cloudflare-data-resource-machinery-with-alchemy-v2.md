---
state: in-progress
priority: high
size: m
dependsOn: []
---

# Replace Cloudflare data-resource machinery with Alchemy v2

## Outcome

Use one fresh Alchemy v2 stack per deployed environment for exactly six
independent data resources:

- Auth and Semaphore D1 databases;
- project-directory and worker-build-cache KV namespaces;
- files and sandboxes R2 buckets, including their lifecycle rules.

Alchemy emits the generated binding identities (D1/KV IDs and R2 bucket names)
to one strict JSON manifest. The existing config generators combine that
manifest with `envs.ts` and emit ordinary gitignored `wrangler.jsonc`. Local
`wrangler dev`, Vite, build, and deploy remain normal Wrangler workflows.

Wrangler continues to own everything coupled to a Worker: Worker scripts,
bindings, Durable Object classes, Browser Rendering, dynamic loaders, named
entrypoints, routes, containers, migrations, and secrets.

This is an all-at-once replacement. We will destroy every environment and
recreate it from empty. The repository deliberately contains no application
code for import, adoption, missing-state reconstruction, legacy ID fallback,
compatibility branches, or Alchemy patches. Unmodified Alchemy providers keep
their native deterministic-name reconciliation for interrupted creates during
an ordinary apply.

## Implementation

### Stack and config bridge

1. `apps/env-manager/src/alchemy/environment-resources.ts` defines the shared
   graph. `dev_global` contains only Auth D1; platform stages contain all six
   resources.
2. Every apply runs inside the deployed environment manager's named,
   per-stage Durable Object. The same object stores its Alchemy state in
   SQLite, serializes lifecycle operations, and returns validated output to a
   thin local CLI. The CLI atomically writes
   `apps/env-manager/.alchemy/output/<stage>/cloudflare-resources.json`.
3. `scripts/lib/alchemy-resources.ts` validates the manifest kind and every
   generated binding identity before any config generator can use the output.
4. `envs.ts` contains stable Worker names and hostnames, never physical D1/KV
   IDs or R2 bucket names.
5. Preview, production, and Auth-only `dev_global` all call the same deployed
   graph. The manager itself always runs in the preview account and uses
   account-specific Cloudflare tokens from Secrets Store.

### Whole-environment teardown

`pnpm infra destroy --env <stage>` is the only destructive lifecycle command.
It is explicit, idempotent, and ordered:

1. Delete and verify every container application attached to the OS Worker's
   Durable Object namespaces.
2. Delete the eight stage Workers: OS, its two compiler sidecars, Auth,
   Semaphore, Docs, dummy Petshop, and streams example. For each Worker,
   discover owned Durable Object classes from instantiated namespaces and
   script bindings, upload a no-DO stub whose declarative exports mark every
   owned class `state: "deleted"`, then delete the script with `force=true`.
   (`force=true` alone does not delete DO classes, and Workers using
   declarative exports reject legacy migrations.) Verify both Workers and
   namespaces are absent.
3. Drain the cursor-paginated repositories in `${osWorkerName}-repos` after no
   Worker can create more, then verify the Artifacts namespace is empty.
   Cloudflare exposes no API to delete an Artifacts namespace itself; an empty
   implicit namespace is the only unavoidable remainder. Alchemy's
   `Artifacts.Namespace` is likewise a binding marker, not a provisioned
   resource with create/destroy operations.
4. Destroy the Alchemy stack and remove its generated manifest.

`dev_global` runs the same path for its single Auth Worker and Auth D1.
Production destroy is dashboard-only and the Worker requires a production
Iterate Auth browser session, so forge-signed CI bearer tokens cannot invoke
the destructive lane.

This replaces the parked-worker/tombstone reset, adoption guards, retired
queue/secret migrations, per-app erasers, and the reset-before-destroy
handshake. A partial run is resumed by running the same command again.

### Container bootstrap

One small workaround remains. Cloudflare still cannot container-enable a
Durable Object namespace created through declarative `exports`; only a legacy
migration upload whose metadata names the container class can create it in the
required state. Before the first OS deploy, `ensureContainerClasses` uploads a
minimal 503 module that creates only missing container classes. Wrangler's
real deploy immediately replaces it and adopts the classes through `exports`.

This is first-deploy machinery, not recovery or compatibility machinery.
Delete it when the Cloudflare control plane supports container-enabled
exports.

## Version choices

The prototype uses unmodified upstream Alchemy commit
[`cd6671e297…`](https://github.com/alchemy-run/alchemy/commit/cd6671e297375282104ba81ec6dcb6347ab7a0fd).
It includes two destroy fixes missing from published `2.0.0-beta.65`:

- [`663d4670`](https://github.com/alchemy-run/alchemy/commit/663d4670)
  removes persisted stack output after complete destroy;
- [`cd6671e2`](https://github.com/alchemy-run/alchemy/commit/cd6671e297375282104ba81ec6dcb6347ab7a0fd)
  aggregates sibling deletion failures.

There is no local patch. The exact-SHA `pkg.ing` package is built by
[Alchemy's own main-branch package workflow](https://github.com/alchemy-run/alchemy/blob/cd6671e297375282104ba81ec6dcb6347ab7a0fd/.github/workflows/pr-package.yml)
from that upstream commit. That workflow deliberately retains commit tags
after PR closure so existing install URLs continue to resolve. A direct pnpm
Git-subdirectory dependency was also tested and rejected: Alchemy's source
package depends on monorepo `workspace:*` packages and does not commit its
built `lib` exports, so consuming Git directly would require custom
build/package machinery. Keep the retained upstream artifact until npm's
`next` release includes the fixes; the package URL does not have a separate
SRI, but it is not a local fork or an expiring PR artifact.

`apps/env-manager` is a normal root workspace and uses the repository's one
root `pnpm-lock.yaml`. There is no nested workspace or Alchemy lockfile. The
large positive raw diff is mostly pnpm's generated resolution changes from
adding Alchemy, Effect 4, TanStack Start, and their build tooling to that shared
dependency graph.

Latest Alchemy main adds Worker-side capabilities that do not improve the
D1/KV/R2 boundary, and its newer commit package was not available from
`pkg.ing` when checked. Alchemy's current root Cloudflare export also brings
Node/Bun compatibility imports into a Worker bundle; the provider and
credential services needed here have no granular public package export. Keep
`nodejs_compat`, prove the actual deployed bundle, and remove it when Alchemy
publishes a Worker-safe granular entry point rather than carrying a local
packaging patch.

Wrangler's experimental provisioning remains create-only. Verified against
Wrangler 4.116.0 and workers-sdk main on 2026-07-30, the newest typed
`defineSettings` direction is not ready here: upgrading beyond 4.107 also
forces a repository-wide Workers Types v5 transition, while containers,
auxiliary Vite Workers, configurable filenames/`--config`, and D1
`migrations_dir` remain blockers. Revisit typed config when those are
first-class; do not add an adapter layer now.

## Complexity

The previous recovery-oriented attempt added roughly 4,500 lines plus a local
Alchemy patch. This version deletes the patch and the custom recovery control
plane.

The main code movement is:

- delete the 703-line DO reset, 425-line reset tests, parked Worker, per-app
  erasers, and retired deployment shims;
- add a 69-line Alchemy graph, its Effect/SQLite execution boundary, one strict
  manifest reader, a thin remote CLI, the environment manager dashboard/DO,
  one typed Distilled teardown module, and the required container bootstrap;
- use only the generated root lockfile.

The PR's roughly +5.3k net headline is mostly generated dependency metadata:
the root lock accounts for +2,658 net lines. Excluding the lock and this task
record, application, workflow, and documentation changes are +2,219 net while
replacing the old reset/recovery system and adding the lifecycle API plus
dashboard.

## Thermonuclear lifecycle review

Three independent read-only reviews identified five issues. All five findings
were confirmed against the code; the suggested cross-worktree manifest
generation check was rejected as a separate false solution.

1. **Fail-closed local manifest — confirmed.** `infra destroy` now removes the
   calling worktree's Wrangler input manifest before asking the manager to
   mutate Cloudflare. A failed or partial remote destroy therefore cannot leave
   that worktree with deployable stale IDs. `infra deploy` already invalidated
   before apply and atomically materialized the canonical output afterward.
2. **Destructive lease duration/fencing — confirmed.** A live `preview_18`
   destroy took 41m44s while reclaim and GC used an unrenewed 30-minute hold.
   Destructive paths now use the normal three-hour lease and renew its exact
   opaque token before work, at most every five minutes, and after work. A lost,
   mismatched, or failed renewal aborts the exact environment-manager operation;
   the Durable Object propagates cancellation into both the Cloudflare control
   plane Effect and Alchemy Effect. It checks the abort signal before the
   Worker/DO phase and again before the Alchemy phase. Completion without a
   final renewal, and every `release=false`, are explicit ownership failures.
3. **Affinity after an ownership gap — confirmed.** A recorded slug whose exact
   token no longer renews is only an affinity hint. Automation may acquire it
   non-force, but must destroy the whole environment before reuse. Matching
   holder text cannot recover a token, force-reissue a lease, or preserve a
   deployment.
4. **Duplicate cleanup obligation — confirmed and deleted.** The Semaphore
   `preview-stack` resource type, record creation/deletion protocol, conflict
   recovery, and GC inventory were removed. Semaphore now owns only live lease
   arbitration/fencing. Hourly GC reads every claimable environment's manager
   status directly, takes an eligible slot non-force, re-reads under the fence,
   destroys, and releases. A failed/non-empty manager lifecycle is the sole
   durable cleanup obligation.
5. **Triplicated resource truth — confirmed and collapsed.** Alchemy's SQLite
   stack output is the only durable resource manifest. `environment_state`
   persists lifecycle/progress/error only; startup and operation completion
   project validated resources from canonical output and reconcile settled
   `empty`/`ready` labels against its presence. The CLI JSON remains an
   ephemeral Wrangler input. Cloudflare teardown consumes the canonical
   `AlchemyResources` type instead of a hand-copied union.

The README-linked documentation audit found one stale sentence claiming that a
still-free recorded slot could be re-taken without destruction. The docs now
match the code: only exact uninterrupted-token renewal preserves a deployment;
every ownership gap destroys before reuse. Obsolete `preview-stack` wording in
the slot guide was also removed.

### Rejected addition: manifest generation/freshness handshake

A manager generation embedded in local JSON would add a second comparison
protocol without closing the race: Cloudflare could still be destroyed after a
remote freshness check and before Wrangler deploy. It would also make ordinary
Wrangler config generation and local `wrangler dev` depend on a live manager,
contrary to the config bridge's purpose. The supported production and preview
paths run `infra deploy` immediately before config generation, preview mutation
is lease-fenced, and an arbitrary worktree must do the same. Deleted D1/KV/R2
identities fail Cloudflare binding validation rather than silently targeting a
new resource. The fail-closed local invalidation fixes the actionable bug;
cross-worktree operation serialization belongs to the deployment lease/workflow,
not a manifest generation counter.

### Post-push review: retired OS secret

Cursor correctly found stale Auth documentation claiming every OS deploy still
asserted and removed `APP_CONFIG_ITERATE_AUTH__SERVICE_TOKEN`; that prose was
deleted. Restoring the retired-secret deploy path was rejected as legacy
rollout machinery: this PR's accepted rollout destroys/recreates every
environment, current code has no writer for that binding, and live checks found
the name absent from all twenty OS Doppler configs, all 56 deployed preview OS
Workers, and `os-prd`.

### Final Bugbot review

Two final-head findings were confirmed and reduced:

- `infra check` promises to verify the Alchemy-owned D1/KV/R2 stack, but its
  control-plane helper also required every Wrangler Worker. The helper is now
  explicitly named `assertAlchemyResourcesExist` and no longer lists or checks
  Workers. A freshly provisioned data stack is therefore healthy before the
  independently owned Worker rollout.
- Dashboard destroy did not share the CLI's exact-operation restart
  classification. The bounded destroy client is now one browser-safe module
  used by both callers. Every batch supplies an exact operation ID; a dropped
  session opens a fresh connection and continues only if durable state
  classifies that exact request as a manager restart. Regression tests prove
  exact restart continuation, rejection of an unrelated operation, and
  cancellation of the exact active operation on lease loss.
- The recovered restart classification was durable, but the server blocked
  deploy/check only while the lifecycle was literally `destroying`. Recovery
  changes that lifecycle to `failed`, leaving a race before the destroy client
  reconnects. One state-machine assertion now treats that exact classified
  failure as the same cleanup fence: only another destroy may start until it
  converges. Unrelated destroy failures remain ordinary failures and do not
  acquire this fence.

### Post-push lifecycle run: high-cardinality Artifacts cleanup

The first full PR run on `c1350b4` found a real watchdog mismatch rather than an
Alchemy hang. Handover of `preview_7` spent the workflow's entire 20-minute
limit deleting runtime-created repositories from `os-preview-7-repos`;
Workers Observability recorded 3,126 distinct `DELETE` responses, all HTTP 202,
and zero HTTP 429s before Depot cancelled the job.

This cleanup cannot be collapsed into an Alchemy namespace delete. Both the
pinned/current Alchemy `Cloudflare.Artifacts.Namespace` implementation and
Wrangler `origin/main` model namespaces as implicit: Cloudflare creates one on
the first repository write, exposes namespace list/get, and exposes deletion
only per repository. The deletion concurrency remains ten. The observed rate,
roughly 870 calls per five minutes, stays below Cloudflare's documented
1,200-per-five-minute cumulative Client API limit and leaves budget for Worker,
DO, container, D1, KV, and R2 calls; increasing concurrency would trade a
bounded data-dependent prefix for account-wide 429s.

The recovery run then exposed the true cardinality after its initial listing:
53,143 repositories remained in `os-preview-7-repos`. At the deliberately safe
deletion rate that is a roughly 5.5-hour one-time drain, so a 60-minute limit
would merely move the same unexplained cancellation. The workflow backstop is
six hours while individual deploy/test watchdogs remain unchanged. Env-manager
publishes Worker, container, and Artifacts teardown progress into the existing
lifecycle state, including each 100 completions, so a long destroy is
explicitly classified instead of presenting an empty `destroying` state.

That recovery also proved a single multi-hour manager RPC is invalid. The
environment Durable Object was reset at exactly 40 minutes with
`Durable Object storage operation exceeded timeout which caused object to be
reset` (Workers trace `0179ed356032fb7b4cfa006fcbd8371`). It had deleted 6,700
repositories, renewed the exact Semaphore lease throughout, emitted no 429,
and then durably classified the interrupted operation as failed. This was a
request-lifetime failure, not an Alchemy hang, API-rate failure, or lost lease.

Artifact cleanup is therefore an explicit convergent protocol: one manager RPC
deletes at most 1,000 repositories, re-reads canonical Cloudflare inventory,
and returns either complete or more-work-remains. A successful partial batch
persists `destroying` with `operationFinishedAt`; no repository list, count, or
cursor is persisted. The CLI and dashboard close the Cap'n Web session after
each batch and open a new one for the next batch. An interrupted batch remains
`failed`; a caller/lease abort cancels only its exact operation; at most 100
batches may run in one command. The sole additional continuation case is the
manager's exact durable `restarted while destroying` classification. It
rechecks caller cancellation and renews the exact Semaphore token before every
new destructive batch; every other error propagates. Every continuation
re-inventories Cloudflare. Alchemy SQLite remains the sole durable resource
manifest, Cloudflare remains the canonical Wrangler-resource inventory, and
env-manager remains the sole cleanup-obligation authority.

The first bounded recovery then exposed a separate one-hour credential
boundary. Ten batches settled successfully, but both clients had memoized
their forge-minted one-hour admin bearer. The next manager connection and the
Semaphore renewal returned 401; renewal loss cancelled exact manager operation
`6310cfaa-3fa4-4fce-8922-a70dca682e46`, which settled `failed`, and the failed
release left the lease visibly parked. This was an authentication defect, not
an ownership gap disguised as success. Semaphore now forge-mints on every API
request, while the manager client caches only the Doppler forge key and mints
for each WebSocket connection. A regression test advances beyond the token TTL
and proves a fresh credential is returned. Explicit pre-minted token overrides
remain caller-owned. Recovery re-acquired the same slot through the explicit
force lane, treated the new lease token as an ownership gap, and resumed from
fresh Cloudflare inventory.

The next recovery run proved why that one restart classification must be
continuable. After ten more complete batches and 900 deletions in the eleventh,
Cloudflare terminated the Durable Object's WebSocket with
`This script has been upgraded` (trace
`3fecea4b5badbbca9a8e2844797a03b5`). The request still ran Worker version
`4454aa48…`; Cloudflare's deployment inventory showed that version had been
unchanged since 21:41:37Z, more than two hours earlier. This was therefore the
documented Durable Object runtime/placement shutdown case, not a hidden deploy.
The old client failed closed, released its exact lease, and left the manager
durably `failed`. The final client continues only that exact recovered-destroy
state matching the failed request's operation ID, never a transport status,
error substring, resource failure, old restart record, or lease abort. It then
starts a fresh bounded operation from canonical inventory, and the existing
100-operation ceiling still bounds the command.

A subsequent production-shaped drain crossed both clients' original one-hour
bearer lifetime without interruption. The original process opened manager
batch eleven after the boundary, then renewed its exact Semaphore token at
00:55:24Z and extended the lease to 03:55:24Z. Semaphore telemetry recorded
29/29 HTTP 200 responses and no non-200 response during that first hour. This
proves the per-connection/per-request minting in the real lifecycle path in
addition to its time-advanced unit test.

The same run completed the historical `preview_7` drain in 9,135.4s
(2h32m15s), including 25 full bounded operations and a final 458-repository
operation. Exact-token renewal remained uninterrupted through the final phase,
the final renewal and release both succeeded, and manager lifecycle settled
`empty`. Full-run env-manager telemetry contained 25,464 HTTP 202, 551 HTTP
200, and 418 HTTP 404 outbound spans, with zero 401/403/409/429/5xx. The 404s
were the fully explained behavior of the then-deployed build rechecking eight
already deleted Workers before each Artifact batch. Final code inventories
Workers and namespaces first and skips those calls. Semaphore recorded 67 HTTP
200 and no other response or error event.

There was one error event at the start of that run: Cloudflare moved the
Durable Object from the previous Worker version at 23:55:24Z, trace
`ac29b9c4022492480a7a9c3596195cb4`. The manager durably classified the exact
operation as `restarted while destroying`; the caller re-inventoried under the
same live lease and continued. There were no later error events. This is the
single modeled restart continuation described above, not a generic transport
retry.

## Proof and rollout

Use reserved `preview_18` and `preview_19` as disposable proof stages:

1. Destroy the stage and prove all Workers, DO namespaces, container apps,
   Artifact repos, D1, KV, and R2 resources are absent.
2. Apply Alchemy and validate every manifest identifier against Cloudflare.
3. Apply again and prove identities are stable.
4. Generate and inspect Auth, Semaphore, and OS Wrangler configs.
5. Deploy the full preview and run smoke/e2e.
6. Destroy, rerun destroy to prove idempotence, recreate, and verify fresh
   identifiers.
7. Interrupt an apply, retry it, and verify persisted state converges.

For rollout, quiesce automatic deploys, explicitly nuke all deployed
environments, discard prototype state out of band, then recreate and redeploy
the fleet. A merge is not permission to erase production. After the fleet is
healthy, restore and verify the production lease inventory:

```bash
doppler run --project semaphore --config prd -- \
  pnpm --dir apps/semaphore seed:environment-config-leases
doppler run --project _shared --config prd -- pnpm preview status
doppler run --project _shared --config prd -- pnpm preview reconcile
```

`status` must report the intended claimable inventory and `reconcile` must
report zero issues before preview automation is re-enabled. `preview-18` and
`preview-19` remain absent from that inventory because they are reserved for
destructive lifecycle proof.

Earlier prototype proof on `preview_5` after granting Secrets Store Write:

- eight stable no-op applies averaged 4.92s;
- four resource creates averaged 12.36s and four destroys averaged 19.70s;
- two complete fresh fleet deploys took 223.00s and 200.86s;
- two complete environment destroys took 29.60s and 33.28s;
- both destroys left zero matching Workers, container apps, Artifact repos, D1
  databases, KV namespaces, and R2 buckets. A later first-party Distilled
  source audit caught the incorrect assumption that `force=true` alone deletes
  DO classes; final proof must use declarative deleted-class exports and
  require zero matching namespaces;
- no 429 or rate-limit backoff occurred. One first-cycle Wrangler asset upload
  retried successfully; the second full cycle had no upload retry.

The one-time Alchemy state-store replacement initially observed the old Worker
version for 59.47s after upload and failed explicitly. A normal rerun converged
without a patch. Final CI on `f7070bbc9` then deployed the complete preview and
passed smoke/e2e in 5m41s with no 429, rate-limit backoff, or unexplained
control-plane failure.

Final lifecycle-review proof on reserved `preview_18` and PR-owned
`preview_15`:

- `preview_18` invalidated its local manifest before the remote destroy
  completed, then destroyed in 49.75s. Restoring that stale manifest and asking
  Wrangler to apply Auth D1 migrations failed closed with Cloudflare `7404`
  (`database ... could not be found`); it did not bind or create anything.
- An already-empty repeat destroy took 26.36s. Fresh Alchemy creation took
  5.84s and an exact no-op apply took 1.86s, with byte-identical output and
  stable physical IDs.
- Caller cancellation interrupted a remote destroy in under two seconds. The
  Durable Object settled to `failed` with the exact operation ID and
  `cancelled by caller`, then a normal destroy converged in 35.49s. A first
  attempt made immediately after deploying env-manager was interrupted by
  Cloudflare moving the Durable Object from Worker version `7123d5b4…` to
  `f58f7471…`; Workers Observability trace `772e9be368fd728be1ddd3bc8886a9f7`
  classified it explicitly as `This script has been upgraded`, and the settled
  version passed the controlled cancellation.
- Recreating `preview_18` after verified absence took 8.23s. All four
  ID-addressed D1/KV resources received new physical IDs; the two name-addressed
  R2 buckets retained their declared names.
- A production-shaped forced reclaim of this PR's complete `preview_15` fleet
  took 137.8s remotely / 141.28s end to end, renewed and verified its exact
  lease, released it successfully, and left the environment-manager lifecycle
  `empty`. Direct Cloudflare API audits for both destroyed slots found zero
  matching Workers, Durable Object namespaces, container apps, D1 databases,
  KV namespaces, R2 buckets, and Artifact repositories.
- The new manager-backed GC dry run read all seventeen claimable environments
  and found zero non-empty environments without a live tenant.
- The production Semaphore inventory was converged from nineteen historical
  rows to the canonical seventeen claimable rows. `preview_18` and
  `preview_19` remain compiled, disposable env-manager proof stages but are
  physically absent from Semaphore, not merely filtered during acquisition.

Post-review manager build `7a7f9136-e909-41a0-af5a-f01318ba5eea` deployed and
passed its health smoke. On that build:

- `preview_18` again proved its local manifest absent while remote destroy was
  still active, then settled `empty` in 13.97s after the deployment handoff.
  The immediate first call had failed explicitly in 4.29s while Cloudflare
  moved the named Durable Object to the new Worker version; it retained no
  manifest and was not normalized as lifecycle success.
- Fresh Alchemy creation took 6.19s. The exact no-op apply took 1.68s and
  retained byte-identical SHA-256
  `5b94bb5466fa3c2627ae148976aab950d03f71029da7bd133be08735ac95ec8f`
  plus identical D1/KV IDs. The Alchemy-stack check passed while this
  reserved-slot step intentionally left Wrangler Workers absent;
  Worker-inclusive proof belongs to preview CI.
- Destroy after that create took 12.33s and a repeat-empty destroy took 11.09s.
  Both settled `empty` and the local manifest remained absent.
- The repeat-empty run exposed inaccurate progress wording: it verified eight
  Workers absent without deleting them but reported all eight deleted. Final
  code now counts actual deletions and reports both that count and the
  verified-absent total; its regression test asserts zero Worker delete calls
  and the exact progress record.

The final manager build `41cfe873-ff55-4901-ac52-d998536b221b` then deployed
and passed its health smoke. Reserved `preview_19` supplied an independent
historical-leak proof:

- The local manifest was absent while teardown ran. Six full bounded
  1,000-repository operations plus a final 751-repository operation deleted
  6,751 Artifact repositories. The same CLI invocation then destroyed the
  canonical Alchemy stack and settled lifecycle `empty` in 2,332.98s
  (38m52.98s).
- The first repeat started 22 seconds after Worker upload, while Cloudflare was
  still moving the named Durable Object: telemetry contained both old
  `7a7f9136…` and new `41cfe873…` versions. It succeeded in 11.62s but retained
  the old progress wording, so it is not claimed as final-code proof.
- At 102 seconds after upload, the repeat ran entirely on `41cfe873…`, took
  11.72s, and correctly reported `Deleted 0 Workers; verified all 8 Workers
  and their Durable Object namespaces absent.` Canonical state remained
  `empty`, its Artifact inventory was empty, and the local manifest remained
  absent.
- A separate authenticated Cloudflare API audit found zero matching Workers,
  Durable Object namespaces, container applications, old D1/KV/R2 identities,
  or Artifact repositories.
- The exact final window, 2026-07-31 03:12:40–03:13:15Z in account
  `376ef7ed81b0573f93524de763666c15`, contained 51 env-manager telemetry
  events (47 `otel`, four `cloudflare-workers`), all `info` and all on version
  `41cfe873…`. Every one of 18 HTTP response spans was 200; there were no
  error events or 4xx/5xx. Trace `3c385cf79613d8982d14a3ec5db3d97d`
  contained the 9.77s environment operation with 44 spans and no missing
  parents. Its native Durable Object `GET` outlived Cloudflare's 12ms
  `durable_object_subrequest` handoff span; that parent represents the
  dispatch, not the WebSocket operation lifetime, and no application semantic
  span contract was violated. The two `canceled` and two
  `responseStreamDisconnected` presentations are the duplicated normal
  Cap'n Web client-close outcomes and remained outside the error signal.

## Acceptance criteria

- [x] No Alchemy patch, application-level adoption/import, dual-read, or legacy
      resource config.
- [x] `envs.ts` contains no D1/KV/R2 physical identifiers.
- [x] Wrangler config generation consumes one strict Alchemy manifest.
- [x] Local `wrangler dev` remains normal.
- [x] Preview acquisition provisions once before app fan-out.
- [x] One destroy command owns Artifacts repos, containers, Workers/DOs, and
      the Alchemy stack.
- [x] Claude Fable Max and Codex GPT-5.6 Sol Max reviews incorporated.
- [ ] Live create, repeat apply, full Worker deploy/smoke, repeated
      destroy/recreate, and post-destroy absence proven on the final code.
- [ ] Preview e2e proven by CI on the final pushed revision.
- [x] Alchemy comes from its retained, upstream-built exact-commit package;
      direct Git consumption and the older npm prerelease were rejected with
      documented reasons.
- [ ] All-environment destructive rollout receives explicit human approval.
