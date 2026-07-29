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

Alchemy emits the four generated D1/KV identifiers to one strict JSON
manifest. The existing config generators combine that manifest with `envs.ts`
and emit ordinary gitignored `wrangler.jsonc`. Local `wrangler dev`, Vite,
build, and deploy remain normal Wrangler workflows.

Wrangler continues to own everything coupled to a Worker: Worker scripts,
bindings, Durable Object classes, Browser Rendering, dynamic loaders, named
entrypoints, routes, containers, migrations, and secrets.

This is an all-at-once replacement. We will destroy every environment and
recreate it from empty. The repository deliberately contains no import,
adoption, missing-state reconstruction, legacy ID fallback, compatibility
branch, or Alchemy patch.

## Implementation

### Stack and config bridge

1. `infra/alchemy.run.ts` defines one stage-aware stack. `dev_global` contains
   only Auth D1; platform stages contain all six resources.
2. A small Alchemy Action atomically writes
   `infra/output/<stage>/cloudflare-resources.json` only after a successful
   apply.
3. `scripts/lib/alchemy-resources.ts` validates kind, stage, account, and every
   identifier before any config generator can use the output.
4. `envs.ts` contains stable names and hostnames, never physical D1/KV IDs.
5. Preview and production workflows apply the stack once before app deploys
   fan out.

### Whole-environment teardown

`pnpm infra destroy --env <stage>` is the only destructive lifecycle command.
It is explicit, idempotent, and ordered:

1. Delete and verify every container application attached to the OS Worker's
   Durable Object namespaces.
2. Force-delete the seven stage Workers: OS, its two compiler sidecars, Auth,
   Semaphore, dummy Petshop, and streams example. Cloudflare's supported
   `force=true` Worker deletion also deletes each script's Durable Object
   namespaces, instances, storage, and alarms. Verify both Workers and
   namespaces are absent.
3. Drain the cursor-paginated repositories in `${osWorkerName}-repos` after no
   Worker can create more, then verify the Artifacts namespace is empty.
   Cloudflare exposes no API to delete an Artifacts namespace itself; an empty
   implicit namespace is the only unavoidable remainder. Alchemy's
   `Artifacts.Namespace` is likewise a binding marker, not a provisioned
   resource with create/destroy operations.
4. Destroy the Alchemy stack and remove its generated manifest.

`dev_global` runs the same path for its single Auth Worker and Auth D1.
Production additionally requires `--yes-i-mean-prd`.

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

There is no local patch. The `pkg.ing` URL is suitable only for this prototype:
it expires and has no integrity hash. Merge only after Alchemy publishes a
release containing both fixes with a working dependency graph.

Alchemy stays in a nested, independently locked workspace. Folding it into
the root lock was tested: it reduced raw lockfile lines but rewrote hundreds
of unrelated application peer resolutions. The isolated 3,335-line generated
lock has more lines and much less application risk.

Latest Alchemy main adds Worker-side capabilities that do not improve the
D1/KV/R2 boundary. Wrangler's experimental provisioning remains create-only.
Its experimental typed `cloudflare.config.ts` direction is not ready here:
containers, auxiliary Vite Workers, configurable filenames, and D1
`migrations_dir` remain blockers. Revisit typed config when those are
first-class; do not add an adapter layer now.

## Complexity

The previous recovery-oriented attempt added roughly 4,500 lines plus a local
Alchemy patch. This version deletes the patch and the custom recovery control
plane.

The main code movement is:

- delete the 703-line DO reset, 425-line reset tests, parked Worker, per-app
  erasers, and retired deployment shims;
- add one ~120-line Alchemy stack, one strict manifest reader, one root CLI,
  one focused Wrangler-resource destroy helper, and the required container
  bootstrap;
- keep the generated 3,335-line isolated Alchemy lock.

The PR's positive line count is therefore generated dependency metadata.
Excluding that lock and this task record, the implementation is substantially
net-negative.

## Proof and rollout

Use `preview_19` as the disposable proof stage:

1. Grant the shared preview Cloudflare token account-level Secrets Store Write.
2. Destroy the stage and prove all Workers, DO namespaces, container apps,
   Artifact repos, D1, KV, and R2 resources are absent.
3. Apply Alchemy and validate every manifest identifier against Cloudflare.
4. Apply again and prove identities are stable.
5. Generate and inspect Auth, Semaphore, and OS Wrangler configs.
6. Deploy the full preview and run smoke/e2e.
7. Destroy, rerun destroy to prove idempotence, recreate, and verify fresh
   identifiers.
8. Interrupt an apply, retry it, and verify persisted state converges.

For rollout, quiesce automatic deploys, explicitly nuke all deployed
environments, discard prototype state out of band, then recreate and redeploy
the fleet. A merge is not permission to erase production.

Current live blocker: preview_19's old data resources were deleted, but both
available preview tokens lack Secrets Store Write, so stock Alchemy stops
before creating replacements. Do not work around that credential prerequisite
with a local state store or patch.

## Acceptance criteria

- [x] No Alchemy patch, adoption/import, dual-read, or legacy resource config.
- [x] `envs.ts` contains no D1/KV/R2 physical identifiers.
- [x] Wrangler config generation consumes one strict Alchemy manifest.
- [x] Local `wrangler dev` remains normal.
- [x] Preview acquisition provisions once before app fan-out.
- [x] One destroy command owns Artifacts repos, containers, Workers/DOs, and
      the Alchemy stack.
- [x] Claude Fable Max and Codex GPT-5.6 Sol Max reviews incorporated.
- [ ] Live deploy, repeat apply, interrupted apply, destroy/recreate, and
      preview e2e proven after the token permission is fixed.
- [ ] Published Alchemy release replaces the expiring prototype pin.
- [ ] All-environment destructive rollout receives explicit human approval.
