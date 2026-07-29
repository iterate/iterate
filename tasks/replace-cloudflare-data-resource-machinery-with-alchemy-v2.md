---
state: in-progress
priority: high
size: m
dependsOn: []
---

# Replace Cloudflare data-resource machinery with Alchemy v2

## Outcome

Use one small Alchemy v2 stack per deployed environment to own D1, KV, and R2.
The stack writes the generated D1/KV identifiers to a small JSON manifest. The
existing Wrangler config generators validate that manifest and put those
identifiers into ordinary generated `wrangler.jsonc` files. R2 bindings use
the same deterministic worker-name convention as the stack and need no
generated identifier.

Keep Wrangler responsible for Workers and everything coupled to a Worker
deployment: bindings, Durable Object classes, Browser Rendering, dynamic
Worker loaders, named entrypoints, routes, queues, containers, migrations, and
secrets.

This is an all-at-once replacement. Before rollout, destroy every existing
environment and recreate it from empty. There is deliberately no repository
code for:

- importing or adopting Cloudflare resources;
- reconstructing missing Alchemy state;
- reading old IDs from `envs.ts`;
- compatibility or staged migration;
- patching or forking Alchemy.

If an environment's Alchemy state is lost or irreparably inconsistent, destroy
that named environment's data resources, discard the broken stage state, and
recreate it. Do not teach the repo to recover unmanaged objects.

At the selected Alchemy revision, D1/KV/R2 providers silently use an existing
same-name object after a create collision. The first apply therefore has a
hard external precondition: the destructive cutover must prove that all six
old names are absent. We rely on that proof, not on an adoption flag or more
repository machinery.

## Why this boundary

Alchemy is useful where this repo previously duplicated Cloudflare control
plane behavior: create, update, order, retry, persist state, and destroy data
resources. Wrangler remains the source of truth for Worker deployment because
`wrangler dev`, Vite, migrations, containers, service bindings, loaders, and
entrypoints already work there.

The bridge between them is intentionally boring:

```text
pnpm infra deploy --env preview_19
  -> Alchemy Stack
  -> infra/output/preview_19/cloudflare-resources.json
  -> app config generator
  -> gitignored wrangler.jsonc
  -> normal wrangler dev/build/deploy
```

There is one stack invocation per environment, not one per app. Preview
acquisition provisions it once before the app deployments fan out.

## Implementation plan

### 1. Make environment metadata resource-free

- Keep names, hostnames, account IDs, and other stable environment shape in
  `envs.ts`.
- Remove committed D1/KV IDs, `UNPROVISIONED`, and resource-management
  sentinels.
- Derive Auth and Semaphore environment views from the same platform stage
  record.
- Model `dev_global` as the only auth-only deployed stage; all other deployed
  stages have the full platform stack.

### 2. Add the minimal Alchemy stack

- Add one nested, independently locked `infra` workspace so Alchemy's beta
  dependency graph cannot change application resolutions.
- Define one `IterateDataResources` stack with:
  - Auth D1;
  - Semaphore D1 for platform stages;
  - project-directory and worker-build-cache KV namespaces;
  - files and sandboxes R2 buckets;
  - the existing 3-hour preview and 90-day production backup lifecycle rules.
- Use Alchemy's official Cloudflare provider and Cloudflare-backed state store.
- Emit one strict, atomic JSON manifest containing only stage, account, and
  the four generated D1/KV IDs. R2 bucket names are deterministic.
- Provide only two repository commands: `deploy` and `destroy`. Official
  `alchemy deploy --yes` owns state-store installation and refresh.
- Keep the manifest Action fail-closed: the wrapper removes old output before
  apply, and a changing Action input rematerializes the checkout-local file
  only after a successful apply. `alchemy state get` can print JSON but would
  leave stale output readable after an interrupted apply.

### 3. Feed normal Wrangler config generation

- Strictly parse the generated manifest with Zod.
- Reject a wrong stage, wrong account, malformed output, or an auth-only
  manifest used by a platform app.
- Generate only the selected deployed environment block, because CI checks out
  one Alchemy output at a time.
- Preserve the existing local-dev top-level config.
- Continue to produce ordinary JSONC accepted by normal Wrangler and the
  Cloudflare Vite plugin.

### 4. Delete the superseded machinery

- Remove D1/KV/R2 creation and reconciliation from every
  `ensure-resources.ts`.
- Remove D1 row wiping, KV walks, R2 object walks, lifecycle mutation, and
  resource-ID editing.
- Remove their shared helpers and tests.
- Keep only non-Alchemy leaf work in `ensure-resources`: DNS and inbound email.
- Make `erase-data` reset Wrangler-owned Durable Objects and then destroy the
  entire named Alchemy stack. Workers and routes remain parked.
- Delete Auth's pass-through eraser. The auth-only `dev_global` stack can be
  destroyed directly with `pnpm infra destroy --env dev_global`; root destroy
  refuses platform stages unless OS has already reset Worker-owned data.

### 5. Wire deployment

- Preview acquisition: after claiming a slot, run one Alchemy deploy. When
  acquisition erased its stack, deploy the full app fleet against the fresh
  IDs even if the new lease has the same slug as the recorded lease.
  Uninterrupted same-stack updates retain diff-based app selection.
- Production: use one Auth/Semaphore/OS workflow so one revision performs one
  `prd` stack apply before deploying all three Workers.
- Auth-only `dev_global`: provision its single D1 before deploy.
- Never run Alchemy separately from each app deploy.

### 6. Prove lifecycle behavior

Use `preview_19`, which may be destructively recreated:

1. Delete the old preview data resources and discard the experimental state
   store. Prove all six resource names are absent before the first apply;
   neither old objects nor state are migration inputs.
2. Deploy the stack, allowing official Alchemy to install its current
   Cloudflare state store, and validate every manifest identifier against
   Cloudflare.
3. Deploy again and prove resource identities are stable.
4. Interrupt an apply, retry it, and prove Alchemy's persisted state converges.
5. Generate all three Wrangler configs and verify their D1/KV/R2 bindings.
6. Deploy the preview and run its smoke/e2e checks.
7. Destroy the stack, prove every stage-owned D1/KV/R2 object and stack output
   is gone, recreate it, and prove fresh identifiers are generated. The shared
   state Worker and Secrets Store remain until explicit account teardown.

Production rollout is the same destructive cutover applied to every deployed
environment. Before enabling the new push-triggered workflows, quiesce
automatic deploys, erase every existing environment, prove the six names per
platform stage are absent, remove any prototype Alchemy state store out of
band, then recreate every stack and redeploy every app. This is one explicit
release operation with human approval, not a compatibility path in the code.

Live proof status: preview_19's six old data resources were deleted. The
unmodified Alchemy state store then stopped before creating replacements
because both available preview-account tokens lack Cloudflare's account-level
**Secrets Store Write** permission. This is a credential prerequisite, not a
reason to add a local state store, fallback, patch, or bootstrap implementation.
Once the shared preview token has that permission, repeat the seven proof
steps above from the now-empty slot.

## Version and upstream strategy

The prototype uses the exact, unmodified upstream snapshot
[`cd6671e297…`](https://github.com/alchemy-run/alchemy/commit/cd6671e297375282104ba81ec6dcb6347ab7a0fd).
It contains both required destroy fixes:
[`663d4670`](https://github.com/alchemy-run/alchemy/commit/663d4670)
removes persisted stack output after complete destroy, and
[`cd6671e2`](https://github.com/alchemy-run/alchemy/commit/cd6671e297375282104ba81ec6dcb6347ab7a0fd)
aggregates independent deletion failures instead of abandoning remaining
siblings. Published `2.0.0-beta.65` predates both fixes.

Alchemy main was inspected at
`77899a587d09200d631209faa3008bcae9ba7755`. Its current source snapshot cannot
run through `pkg.ing` because it imports
`@distilled.cloud/cloudflare-runtime/platform-proxy`, which the currently
resolved `@distilled.cloud/cloudflare-runtime@0.13.10` does not export.

The working `pkg.ing` snapshot is also deliberately ephemeral: Alchemy's own
service applies a three-week default TTL, so this commit's URL should expire
around 2026-08-18, and the URL lock entry has no integrity hash. It is suitable
for the prototype only. Do not merge it, vendor a tarball, mirror an
unpublished build, or add a local patch. Upgrade to the first published
Alchemy beta containing both fixes and a working dependency graph.

## Typed Wrangler config research

Workers SDK main was inspected at
`beec0fbc9d3adec24bc42e31a21fe7f82badb543`. The current experimental direction
is a runtime `cloudflare.config.ts` using `defineWorker`, plus an optional
tooling `wrangler.config.ts`, enabled by `--experimental-new-config`.
That flag is already present in this repo's published Wrangler 4.107.0
(`@cloudflare/vite-plugin` support shipped in 1.40.0); a main snapshot is not
needed to try it.

This could eventually remove generated `wrangler.jsonc`: an async typed config
could read the same fail-closed manifest and return Worker bindings directly.
It does not remove the manifest until Alchemy exposes a safe machine-readable
stack-output bridge. It is not ready for this repo yet:

- containers are explicitly unsupported;
- Vite rejects auxiliary Workers;
- Vite rejects its existing `config`/`configPath` integration in experimental
  mode;
- the experimental loader expects fixed filenames;
- typed D1 bindings cannot express the `migrations_dir` used by Auth and
  Semaphore.

Durable Object lifecycle is represented by declarative typed exports
(`created`, `deleted`, `renamed`, and transfer states), not a typed rendering
of legacy migration arrays. Containers, D1 migration directories, and the
multi-Worker Vite topology are sufficient blockers for this repo.

Track the upstream commits which introduced this direction:
`3cf9d0e9d`, `e8561c262`, `6c7df19bc`, `317ce1f32`, and `a50f73a06`.
Do not upgrade Wrangler or the Vite plugin to an unpublished snapshot for this
work: Workers SDK main contains no relevant typed-config improvement over the
latest stable packages. Revisit when containers, D1 migration directories,
sidecars, and Vite config selection are expressible without a compatibility
layer.

## Complexity and code savings

The previous recovery-oriented attempt added roughly 4,500 lines and included
a 1,620-line source-plus-compiled Alchemy patch. This design deletes the patch
entirely and adds no replacement recovery framework.

Actual hand-written surface:

| Concern | Before | After |
| --- | ---: | ---: |
| Alchemy patch/fork | ~1,620 lines | 0 |
| Adoption, physical-identity, generation, and state-repair code | several thousand lines | 0 |
| Alchemy stack | 0 | 106 lines |
| Infra CLI wrapper | 0 | 76 lines |
| Strict output loader | 0 | 56 lines |
| D1/KV/R2 ensure/wipe/lifecycle helpers | ~170 lines | 0 |
| Committed resource-ID matrix | ~200 lines | 0 |

Excluding generated package locks and this task document, the implementation
currently deletes 389 net hand-written lines: 930 additions (including 277
lines in new implementation files) replace 1,319 deleted lines. More
importantly, the custom failure-state surface falls from a second control plane
to one stack, one manifest action, and one strict reader.

Alchemy has a 3,335-line generated lockfile under `infra`; the root lockfile is
unchanged. The infra command installs that exact nested lock before invoking
Alchemy, keeping beta peer resolution out of every application workspace.

## Review

Before merge, run both requested independent CLI reviews:

- Claude Fable Max, against this task, the repository diff, Alchemy source, and
  Workers SDK source;
- Codex GPT-5.6 Sol at maximum reasoning, against the same inputs.

Require each reviewer to look for:

- unnecessary compatibility or recovery code;
- accidental split ownership between Alchemy and Wrangler;
- lifecycle/destroy failure modes;
- preview and production concurrency races;
- unsupported or newly supported Cloudflare resources;
- a cleaner path in current Alchemy or experimental Wrangler source;
- claims not backed by first-party code or documentation.

Record actionable findings here and change the implementation rather than
adding defensive machinery by default.

Review status:

- Codex GPT-5.6 Sol Max confirmed the Alchemy/Wrangler ownership boundary. Its
  actionable findings are incorporated: production applies are serialized;
  preview handover carries an explicit stack-destroyed signal, including
  erased/reacquired same-slug leases; infrastructure and dependency changes
  close every deploy trigger; Alchemy has its own nested lock; the cutover
  explicitly quiesces automatic deploys and tears down old account-level state
  once; and the latest typed-config source claims are corrected.
- Claude Fable Max completed a hostile review against the full diff and
  first-party Alchemy/Workers SDK source. Incorporated findings: the
  prerelease URL is an expiring prototype pin; name collisions can be silently
  adopted and therefore require a proved-empty cutover; the Action stays for
  fail-closed output, not because `state get` lacks JSON; generator variants
  are consolidated and no longer read manifests at import time; root destroy
  owns destructive guards; the pass-through Auth eraser and one-use preview
  selection helper are deleted; Semaphore environments are derived rather
  than duplicated; and stale workflow/skill/docs language is removed.
  Suggestions that would add inventory/adoption machinery, vendor the
  unpublished package, or pre-provision before preview erase were rejected.

## Acceptance criteria

- [x] No Alchemy patch, fork, explicit adoption/import, dual-read, or legacy
      resource configuration remains.
- [x] `envs.ts` contains no D1/KV/R2 physical identifiers.
- [ ] One Alchemy deploy creates every data resource for a stage and writes one
      validated manifest.
- [x] Normal Wrangler config generation consumes the manifest.
- [x] Local `wrangler dev` remains unchanged.
- [x] Preview acquisition provisions once before app fan-out.
- [ ] Destroy/recreate and interrupted-apply behavior are proven on a live
      disposable preview.
- [x] Tests, typecheck, lint, and format pass.
- [x] Both requested CLI reviews are incorporated.
- [ ] Rollout has one explicit all-environment nuke/recreate procedure and
      human approval, with no compatibility branch.
