# Worker topology

OS deploys one primary Cloudflare Worker per environment (`os-prd`,
`os-preview-N`): the TanStack Start dashboard, capnweb itx API, ingress
routing, product-state Durable Objects, and project sandbox classes live in a
single script. Two route-less infrastructure sidecars carry the typechecker
and the deployment-wide worker-builder pool.

The entry is [`src/worker.ts`](../src/worker.ts). Its fetch handler makes the
one hostname/path routing decision (shared logic in `src/ingress.ts`):

| Lane            | What                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| MCP host        | rewritten onto the app's `/api/mcp` mount                                  |
| api lanes       | capnweb `/api`, operator sessions, Slack webhooks, project ingress         |
| everything else | dashboard SSR + server functions; client assets served from Workers Assets |

Main-worker Durable Object classes (same-script bindings — declared by class
name in wrangler.jsonc, no namespace IDs): Agent,
CapabilityHost, Project, Repo, Secret, Stream, StatefulWorker, and the
container-backed CloudflareSandbox (`sandbox/Dockerfile`, built by
`wrangler deploy`).

## Infrastructure sidecars

One deliberate exception to "one worker": `itx.docs.typecheck` runs in a
separate `os-<env>-typechecker` worker (`src/typechecker.ts`, generated
config `wrangler.typechecker.jsonc`) — the only script carrying the
TypeScript compiler (tswasm, ~30MB wasm), so the product script stays small.
The typechecker is the minimum possible worker: a pure function (files in, diagnostics
out) with no bindings at all. The os worker calls it via the `TYPECHECKER`
service binding; deploy.ts deploys it first (a name binding to a missing
script fails the deploy). Local dev runs it as a vite `auxiliaryWorkers`
entry in the same workerd.

Dynamic worker builds go through one deployment-global
`WorkerBuildCoordinatorDurableObject` on the route-less
`os-<env>-builder` sidecar. Its RPC is deliberately technology-neutral: source
files + build options in, loader-ready modules or a modeled source-build
failure out. A bounded in-memory semaphore runs at most 16 distinct builds,
queues one additional wave of 16, and coalesces simultaneous calls for the
same content key. Infrastructure failures throw and remain retryable; the
coordinator stores no artifacts or project state.

The current private backend load-balances those builds over four stock
standard-4 Cloudflare Sandbox containers. The pool has no project credentials,
catalogue entry, stream, or public route. Each build uses sessionless bounded
commands and its own directory; pinned pnpm installs production dependencies
with scripts disabled (npm is retained only for committed npm lockfiles), and
pinned Wrangler performs the canonical dry-run bundle. pnpm's content-addressed
store and the Bun-installed platform toolchain are shared while a member is
warm; neither is baked into a custom image, preserving the stock image's fast
cold placement. A future backend such as Depot can replace this adapter without
changing the OS worker binding or build contract.

That sidecar name deliberately reuses the retired esbuild-wasm builder Worker
(Workers are never deleted), but none of its old service API survives. The
primary OS Worker externally binds only the coordinator namespace via
`script_name`; the container namespace is private to the sidecar. Local dev
runs the identical recipe on the host toolchain via `/__dev/worker-build` and
does not start the sidecar.

Both sidecars deploy in parallel with the main Vite build and resource
preparation. Preview tests start only after the main upload and all seven
container application rollouts (six project sizes plus the builder pool) are
authoritatively complete.

## Why one worker

The 2026-06 per-DO split (PR #1500) existed to shrink an ~89MB script whose
bulk was sourcemaps and client assets bundled as worker modules. That problem
is gone — the vite build ships a ~2.7MB server entry (assets go to Workers
Assets, sourcemaps aren't uploaded) — and the split's costs were real:
sequential cross-script cold starts on every request chain, cross-script RPC
subscriptions pinning DOs awake for hours, a two-pass deploy bootstrap, and
eleven scripts of duplicated dependencies. Benchmarked (2026-07-03), the
merged script starts in ~130–160ms — faster than any single per-DO worker
did — and same-script DO hops reuse the loaded isolate.

## Configuration

Everything is declared in two places:

- [`envs.ts`](../../../envs.ts) (repo root) — the typed map of deployed
  environments: hostnames, worker names, Cloudflare account, resource IDs.
- `wrangler{,.builder,.typechecker}.jsonc` — generated from envs.ts (gitignored; vite.config.ts
  regenerates it before every dev/build, `pnpm gen:wrangler` by hand). Top
  level is local dev; each env gets a flattened block selected at build time
  via `CLOUDFLARE_ENV`. Its header comments explain the layout.

Secrets live in Doppler only. `secrets.required` in the config lists their
names: local dev (`doppler run -- vite dev`) loads exactly those keys from
process.env, and `pnpm run deploy --env <name>` ships them atomically with the
code via `wrangler deploy --secrets-file`.

## Lifecycle scripts (apps/os/scripts)

| Command                           | What                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`                        | local dev server (vite + workerd); `start --detach`/`status`/`attach`/`kill` for parallel worktrees |
| `pnpm run deploy --env preview_3` | parallel build/resources/sidecars → deploy+secrets (one version) → rollout + smoke proofs           |
| `pnpm ensure-resources --env X`   | create-only bring-up (KV, auth D1, DNS); reconciles IDs into envs.ts                                |
| `pnpm erase-data --env X`         | wipe auth D1 rows + project-directory KV; DOs become unreachable orphans                            |

Workers are never deleted and routes/DNS are ensure-only, so deploys can't
strand an environment's hostnames (the old zombie-route/522 class is
structurally gone). There is no Cloudflare API to delete DO instances; the
only storage-reclaim path is a `deleted_classes`/re-add migration dance —
run rarely, if ever, since orphaned storage costs pennies.

## Notes

- **streams-example-app** (`apps/streams-example-app`) re-exports OS's
  `StreamDurableObject` class from its own worker entry and binds it
  same-script (`class_name` only, no `script_name`). It shares stream code with
  OS, not OS's Durable Object namespace.
- The `ARTIFACTS` binding type exists only on deployed workers; local dev
  has no Cloudflare Artifacts emulation and repo code feature-checks
  `env.ARTIFACTS`.
- Local dev containers are off by default (`dev.enable_containers: false` in
  wrangler.jsonc) so `pnpm dev` never needs Docker; sandbox DOs fail at
  their constructor until you enable them.

## Cutover from the 11-worker topology

The first single-worker deploy to an env that previously ran the per-DO
split creates FRESH Durable Object namespaces on the merged script — every
existing stream/agent/project DO in that env becomes an unreachable orphan.
That's a data reset, not a code deploy: pair it with `erase-data` and an
auth redeploy so the env is coherently empty rather than half-remembered.
The old `os-<env>` per-DO scripts (`os-<env>-stream`, `-agent`, …) remain
parked and unbound. They are retained under the fleet-wide rule that Workers
are never deleted.
