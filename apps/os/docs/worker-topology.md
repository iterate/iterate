# Worker topology

OS deploys one product Worker per environment (`os-prd`, `os-preview-N`): the
TanStack Start dashboard, the capnweb itx API, ingress routing, and all OS
Durable Object classes live in a single script. Two stateless compiler
sidecars keep large Wasm toolchains out of that product isolate.

The entry is [`src/worker.ts`](../src/worker.ts). Its fetch handler makes the
one hostname/path routing decision (shared logic in `src/ingress.ts`):

| Lane            | What                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| MCP host        | rewritten onto the app's `/api/mcp` mount                                  |
| api lanes       | capnweb `/api`, operator sessions, Slack webhooks, project ingress         |
| everything else | dashboard SSR + server functions; client assets served from Workers Assets |

Durable Object classes (all same-script bindings — declared by class name in
wrangler.jsonc, no namespace IDs, no cross-script anything): Agent,
AgentCollection, CapabilityHost, Device, Project, Repo, Scheduler, Secret,
Stream, StatefulWorker, WorkerBuildCoordinator, WorkspaceV2, and one
container-backed CloudflareSandbox class per supported instance size
(`sandbox/Dockerfile`, built by `wrangler deploy`). WorkerBuildCoordinator is
sharded by immutable build key and holds only live single-flight state; build
artifacts remain in KV.

## Compiler sidecars (the "+2")

`itx.docs.typecheck` runs in a
separate `os-<env>-typechecker` worker (`src/typechecker.ts`, generated
config `wrangler.typechecker.jsonc`) — the only script carrying the
TypeScript compiler (tswasm, ~30MB wasm), so the product script stays small.
It is the minimum possible worker: a pure function (files in, diagnostics
out) with no bindings at all. The os worker calls it via the `TYPECHECKER`
service binding; deploy.ts deploys it first (a name binding to a missing
script fails the deploy). Local dev runs it as a vite `auxiliaryWorkers`
entry in the same workerd.

Dynamic worker builds run in the equally small
`os-<env>-worker-bundler` sidecar (`src/worker-bundler.ts`, generated config
`wrangler.worker-bundler.jsonc`). It accepts inert source strings over a
service binding and makes the source's direct `createWorker` or `createApp`
call. It has no state, project authority, filesystem checkout, shell, or
container. App assets stay in OS's artifact cache and asset requests re-enter
the sidecar so worker-bundler's own `handleAssetRequest` owns their routing;
only server modules enter Worker Loader. Deploy and local Vite start both
compiler sidecars before/beside OS.

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
  environments: hostnames, worker names, and Cloudflare account.
- `wrangler.jsonc` — generated from envs.ts plus Alchemy's data-resource manifest
  (gitignored; vite.config.ts regenerates it before every dev/build,
  `pnpm gen:wrangler` by hand). Top level is local dev; each env gets a
  flattened block selected at build time via `CLOUDFLARE_ENV`. Its header
  comments explain the layout.

Secrets live in Doppler only. `secrets.required` in the config lists their
names: local dev (`doppler run -- vite dev`) loads exactly those keys from
process.env, and `pnpm run deploy --env <name>` ships them atomically with the
code via `wrangler deploy --secrets-file`.

## Lifecycle scripts (apps/os/scripts)

| Command                           | What                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev`                        | local dev server (vite + workerd); `start --detach`/`status`/`attach`/`kill` for parallel worktrees |
| `pnpm run deploy --env preview_3` | build → deploy+secrets (one version) → smoke probe                                                  |
| `pnpm ensure-resources --env X`   | create-only DNS and inbound Email Routing setup                                                     |
| `pnpm infra destroy --env X`      | delete Artifact repos, container apps, Workers/DO namespaces, then the Alchemy D1/KV/R2 stack       |

Normal deploys are upserts. Full environment teardown force-deletes each
Worker; Cloudflare deletes that Worker's Durable Object namespaces, instances,
storage, and alarms at the same time. The next deployment recreates routes and
Workers from the generated config.

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
