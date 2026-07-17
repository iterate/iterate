# Worker topology

OS deploys one **product Worker** per environment (`os-prd`, `os-preview-N`):
the TanStack Start dashboard, the capnweb itx API, ingress routing, and every
Durable Object class live in that single script. Three deliberately narrow
sidecars quarantine the bundler, typechecker, and cold-sensitive script loader.

The entry is [`src/worker.ts`](../src/worker.ts). Its fetch handler makes the
one hostname/path routing decision (shared logic in `src/ingress.ts`):

| Lane            | What                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| MCP host        | rewritten onto the app's `/api/mcp` mount                                  |
| api lanes       | capnweb `/api`, operator sessions, Slack webhooks, project ingress         |
| everything else | dashboard SSR + server functions; client assets served from Workers Assets |

Product Durable Object classes are same-script bindings declared by class name
in `wrangler.jsonc` (no namespace IDs). The script-executor sidecar has
cross-script bindings to the existing CapabilityHost and Project namespaces;
it does not host another copy of either class.

## Sidecars

| Worker                     | Purpose                                                                                              | Authority                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `os-<env>-builder`         | Dynamic Worker builds; the only script carrying esbuild-wasm (~14MB).                                | `WORKER_BUILD_CACHE` KV only.                                                                                                |
| `os-<env>-typechecker`     | Capability declarations and itx script typechecking; the only script carrying TypeScript/tswasm.     | No bindings.                                                                                                                 |
| `os-<env>-script-executor` | Loads and invokes one `runScript` Dynamic Worker without cold-starting another full product isolate. | Worker Loader plus cross-script CapabilityHost and Project DO namespaces; no routes, storage, secrets, compiler, or bundler. |

The product worker reaches them through `BUILDER`, `TYPECHECKER`, and
`SCRIPT_EXECUTOR` service bindings. `deploy.ts` deploys the builder and
typechecker first because a name binding to a missing script fails the product
deploy. The executor has a circular deployment dependency: the product binds
the executor service, while the executor binds product-owned Durable Object
classes. When those classes are absent on a new or parked slot, deploy creates
an authority-free executor bootstrap, deploys the product, and immediately
replaces the bootstrap with the full executor before any smoke probe. An
incomplete deployment therefore fails executor calls explicitly instead of
running with partial authority. Local dev runs all three real sidecars as Vite
`auxiliaryWorkers` in the same workerd.

The script executor is intentionally a separate stateless loader owner per
call. A CapabilityHost DO can own only four simultaneous fresh Dynamic Worker
starts on hosted Workers; using a stateless owner preserves 20-way script
concurrency. The executor receives only `{ projectId, scopePath }` coordinates,
mints stable named DO stubs locally, and gives the Dynamic Worker the exact
CapabilityHost stub for its itx plus the Project stub for egress. No native
service stub crosses RPC (which would require workerd's unstable catch-all
`experimental` flag), and the sidecar stays a single-digit-KiB bundle.

`runScript` prepares the durable obligation on the CapabilityHost, returns
from that host RPC, and invokes the executor from the original top-level ITX
request. Dynamic Worker callbacks therefore enter the host through a bounded
lineage. The host's shared alarm retains the absolute deadline and reconciles
lost ownership without replaying userspace.

The builder is slated for deletion when builds move into the sandbox container
([tasks/os-sandbox-worker-builds.md](../../../tasks/os-sandbox-worker-builds.md)).

## Why one product worker

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
- `wrangler.jsonc` plus `wrangler.builder.jsonc`,
  `wrangler.typechecker.jsonc`, `wrangler.script-executor.jsonc`, and the
  deployment-only `wrangler.script-executor-bootstrap.jsonc` — generated from
  envs.ts (all gitignored; vite.config.ts regenerates them before every
  dev/build, `pnpm gen:wrangler` by hand). Top level is local dev; each env gets
  a flattened block selected at build time via `CLOUDFLARE_ENV`.

Secrets live in Doppler only. `secrets.required` in the config lists their
names: local dev (`doppler run -- vite dev`) loads exactly those keys from
process.env, and `pnpm run deploy --env <name>` ships them atomically with the
code via `wrangler deploy --secrets-file`.

## Lifecycle scripts (apps/os/scripts)

| Command                           | What                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`                        | local dev server (vite + workerd); `start --detach`/`status`/`attach`/`kill` for parallel worktrees |
| `pnpm run deploy --env preview_3` | ensure resources → deploy prerequisites → build/deploy product+secrets → finalize executor → smoke  |
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
The old `os-<env>` per-DO scripts (`os-<env>-stream`, `-agent`, …) are dead
afterwards and can be deleted from the Cloudflare dashboard at leisure —
deleting them cascades nothing the new world uses.
