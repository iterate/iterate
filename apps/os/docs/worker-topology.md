# Worker topology

OS deploys as **one Cloudflare Worker per environment** (`os-prd`,
`os-preview-N`): the TanStack Start dashboard, the capnweb itx API, ingress
routing, and **all eight Durable Object classes** live in a single script.

The entry is [`src/worker.ts`](../src/worker.ts). Its fetch handler makes the
one hostname/path routing decision (shared logic in `src/ingress.ts`):

| Lane            | What                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| MCP host        | rewritten onto the app's `/api/mcp` mount                                  |
| api lanes       | capnweb `/api`, operator sessions, Slack webhooks, project ingress         |
| everything else | dashboard SSR + server functions; client assets served from Workers Assets |

Durable Object classes (all same-script bindings — declared by class name in
wrangler.jsonc, no namespace IDs, no cross-script anything): Agent,
CapabilityHost, Project, Repo, Secret, Stream, StatefulWorker, and the
container-backed CloudflareSandbox (`sandbox/Dockerfile`, built by
`wrangler deploy`).

## The builder sidecar (the "+1")

One deliberate exception to "one worker": dynamic worker BUILDS run in a
separate `os-<env>-builder` worker ([`src/builder.ts`](../src/builder.ts),
generated config `wrangler.builder.jsonc`) — the only script carrying the
bundler toolchain (esbuild-wasm, ~14MB), so the product script stays small.
It is the minimum possible worker: a pure build function (files in, artifact
out) whose only binding is the `WORKER_BUILD_CACHE` KV — no DOs, no routes,
no secrets. The os worker calls it via the `BUILDER` service binding on
artifact-cache misses; deploy.ts deploys it first (a name binding to a
missing script fails the deploy). Local dev runs it as a vite
`auxiliaryWorkers` entry in the same workerd. Slated for deletion when
builds move into the sandbox container
([tasks/os-sandbox-worker-builds.md](../../../tasks/os-sandbox-worker-builds.md)).

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
- `wrangler.jsonc` — generated from envs.ts (gitignored; vite.config.ts
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
| `pnpm run deploy --env preview_3` | build → deploy+secrets (one version) → smoke probe                                                  |
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
