# Worker topology

OS deploys as **many small Cloudflare Workers** instead of one big one. Every
Durable Object class is its own worker, the dashboard app is its own worker,
the engine API is its own worker, and a tiny ingress router owns all the
routes. The point is cold-start speed: a cold Durable Object isolate loads
only the code that object actually runs, not the whole product. (Before the
split, one ~28MB script served everything, every DO cold start paid for it,
and request paths that chain several DOs paid it several times — see the
2026-06 Slack-latency incident. Measured on the pre-migration roster, the
split cut fresh Stream DO instantiation from ~1.05s to ~0.40s median; the
shape of the win carries over to the current roster.)

Everything is declared in one place: [`apps/os/alchemy.run.ts`](../alchemy.run.ts).

## The workers

`<n>` is the stage worker name (`os-prd`, `os-preview-N`, `os-dev-<user>`).
Ten workers: ingress, app, api, and seven engine Durable Object workers.

| Worker          | Entry                         | Owns                                                                                                   |
| --------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `<n>` (ingress) | `src/workers/ingress.ts`      | **All routes.** One config parse, then a service-binding forward                                       |
| `<n>-app`       | `src/workers/app.ts`          | Dashboard: TanStack Start SSR + assets + server functions, inbound MCP `/api/mcp`                      |
| `<n>-api`       | `src/next/workers/api.ts`     | The engine API: capnweb `/api/itx` (+ `/api/itx/admin-cookie`), `/__itx_e2e` fixtures, project ingress |
| `<n>-stream`    | `src/next/workers/stream.ts`  | `StreamDurableObject` (journals, event streams)                                                        |
| `<n>-itx`       | `src/next/workers/itx.ts`     | `ItxDurableObject` (capability scopes)                                                                 |
| `<n>-project`   | `src/next/workers/project.ts` | `ProjectDurableObject` + `ProjectEgressEntrypoint`                                                     |
| `<n>-agent`     | `src/next/workers/agent.ts`   | `AgentDurableObject` (agent + LLM provider processors)                                                 |
| `<n>-repo`      | `src/next/workers/repo.ts`    | `RepoDurableObject` (git over Cloudflare Artifacts)                                                    |
| `<n>-secret`    | `src/next/workers/secret.ts`  | `SecretDurableObject`                                                                                  |
| `<n>-worker`    | `src/next/workers/worker.ts`  | `StatefulWorkerDurableObject` (stateful dynamic workers)                                               |

All engine workers (api + the seven DO workers) deploy with the **same
binding set** (`engineBindings` in `alchemy.run.ts`; the matching type is
`src/next/env.ts`): every DO namespace, `AI`, `LOADER` (Worker Loader),
`ARTIFACTS`, `PROJECT_DIRECTORY` (the slug→id KV cache), and the secret
encryption key. Any engine worker can host any capability — exactly like the
single-worker engine they came from — and each re-exports the shared loopback
entrypoints (`ItxEntrypoint`, `ProjectEgressEntrypoint`) so `ctx.exports`
resolves identically in all of them. They all carry `nodejs_compat` (repo git
and dynamic worker loading need Node APIs) and `global_fetch_strictly_public`.

Every DO worker has a tiny default fetch returning a
`{"worker": "os-next-<id>"}` 404 — useful as a cold-start probe and a "which
worker am I talking to" check.

## Cross-script Durable Object bindings

A Durable Object class is implemented in exactly one worker; everyone else
binds it as a **cross-script namespace**. In `alchemy.run.ts` each namespace
is declared once with `scriptName` = the owning worker:

```ts
const stream = DurableObjectNamespace<StreamDurableObject>("stream", {
  className: "StreamDurableObject",
  scriptName: workerNames.stream,
  sqlite: true,
});
```

The same object is passed to the owner (alchemy strips `script_name` and
runs the class migrations there) and to every consumer (alchemy emits a
`script_name` binding). Stubs behave identically to same-script stubs —
`env.STREAM.getByName(...)` works unchanged, RPC and WebSockets included.

**Cycles are fine.** Every engine worker binds every DO namespace (streams
dial their subscriber DOs, subscribers dial streams back). Cloudflare accepts
mutual cross-script bindings as long as both scripts exist.

## Request routing

The ingress worker is the only worker with routes (the app base URL, the MCP
hostname, and each project hostname base + wildcards). It is the trust
boundary: it strips the internal forwarding headers from inbound requests,
then forwards whole requests over service bindings:

```
                    ┌────────────► <n>-app  (MCP hostname → /api/mcp)
browser ──► <n> ────┼────────────► <n>-api  (engine lanes: /api/itx[...],
 (routes)  ingress  │              /__itx_e2e/*, /prj_<id>/*, and project
                    │              platform hosts <slug>.<base>)
                    └────────────► <n>-app  (OS host → dashboard)
```

The routing decision itself lives in `src/next/ingress.ts` and is shared with
the app worker: in local dev the browser talks to vite (the app worker)
directly, so the app worker runs the same decision first and forwards engine
traffic over the same `NEXT_API` service binding. One code path, no dev/prod
fork.

For project platform hosts, the api worker resolves slug → project id through
the auth worker's project directory (via the `PROJECT_DIRECTORY` KV cache) and
dispatches the request to the project's seeded worker. The app and api workers
have **no routes and no workers.dev URL** — they are reachable only through
the ingress worker's service bindings.

Worker-to-worker forwarding deliberately uses default-entrypoint `fetch()`
rather than RPC named entrypoints: whole-request forwarding is the documented
use case for the HTTP interface, and alchemy 0.83's local dev drops
`__entrypoint__` on named-entrypoint service bindings.

## Local dev: one workerd, all workers

`pnpm dev` runs **all** workers inside vite's single workerd via
`@cloudflare/vite-plugin`'s `auxiliaryWorkers`:

1. `alchemy.run.ts` (local mode) writes a wrangler config per worker under
   `.alchemy/local/workers/` plus a manifest (`.alchemy/local/aux-workers.json`),
   and gives each Worker resource a `dev.url` so alchemy does not also run
   it in its own miniflare.
2. `vite.config.ts` reads the manifest and passes the configs as
   `auxiliaryWorkers`.
3. The browser talks to vite directly (`http://localhost:<port>`, project
   hosts as `<slug>.localhost:<port>`); the app worker's embedded routing
   decision handles the engine/project-host lanes over the same service
   bindings the ingress uses in production. The ingress worker isn't part of
   the dev loop (it would be a no-op hop in front of vite).

Why one workerd instead of wrangler's cross-process dev registry: the
registry proxy dials remote Durable Objects **by hex id**, which loses
`ctx.id.name` — and every engine DO derives its identity from its name
(`src/next/domains/durable-object-names.ts`). In one workerd, cross-script
`getByName` keeps names intact, exactly like production.

## Fresh-stage bootstrap (two-pass deploy)

Cloudflare rejects a cross-script DO binding whose target script doesn't
exist yet (error 10061). On the **first** deploy of a fresh stage the mutual
engine-worker bindings are therefore unsatisfiable in one pass.
`alchemy.run.ts` handles this automatically: it checks which worker scripts
exist, omits cross-script bindings whose target is missing (with a loud
warning), and re-executes itself once after finalize to wire them up.
Steady-state deploys (all scripts exist) never take this path; local dev
never needs it (one workerd, lazy resolution).

So: `doppler run --project os --config <config> -- pnpm run deploy` against a
fresh stage just works — it deploys twice under the hood.

## Operational notes

- **Observability**: every worker ships full-sample logs/traces
  (`ITERATE_WORKER_OBSERVABILITY`). When querying, remember the worker names
  are per-domain: agent turns live under `os-prd-agent`, stream delivery
  under `os-prd-stream`, capnweb/API traffic under `os-prd-api`, dashboard
  SSR under `os-prd-app`.
  `apps/os/docs/debugging-deployed-os-workers.md` has query patterns.
- **The `workers` export** in `alchemy.run.ts` feeds the per-worker `Env`
  types (`src/lib/worker-env.d.ts`). The engine does not use the ambient
  `Env`: engine code imports `Env`/`nextEnv` from `src/next/env.ts`
  explicitly.
- **streams-example-app** (`apps/streams-example-app`) binds the Stream DO
  cross-script; its `script_name` is `os-prd-stream`.
- The `ARTIFACTS` binding type exists only on deployed workers; local dev
  has no Cloudflare Artifacts emulation and repo code feature-checks
  `env.ARTIFACTS`.
