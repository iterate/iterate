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
- add a 76-line Alchemy graph, its Effect/SQLite execution boundary, one strict
  manifest reader, a thin remote CLI, the environment manager dashboard/DO,
  one typed Distilled teardown module, and the required container bootstrap;
- use only the generated root lockfile.

The PR's +4,106 net headline is mostly generated dependency metadata: the root
lock accounts for +2,658 net lines. Excluding the lock and this task record,
application, workflow, and documentation changes are +1,215 net while replacing
the old reset/recovery system and adding the lifecycle API plus dashboard.

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
