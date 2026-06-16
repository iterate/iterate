# Worker topology

OS deploys as **many small Cloudflare Workers** instead of one big one. Every
Durable Object class is its own worker, the dashboard app is its own worker,
and a tiny ingress router owns all the routes. The point is cold-start speed:
a cold Durable Object isolate loads only the code that object actually runs,
not the whole product. (Before the split, one ~28MB script served everything,
every DO cold start paid for it, and request paths that chain several DOs
paid it several times — see the 2026-06 Slack-latency incident.)

Everything is declared in one place: [`apps/os/alchemy.run.ts`](../alchemy.run.ts).

## The workers

`<n>` is the stage worker name (`os-prd`, `os-preview-N`, `os-dev-<user>`).

| Worker                  | Entry (`src/workers/`) | Owns                                                                                                                                                                                                  | Notable bindings (beyond `APP_CONFIG`)                                                                 | Compat flags                                                              |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `<n>` (ingress)         | `ingress.ts`           | **All routes.** Hostname-level routing only                                                                                                                                                           | `APP`, `PROJECT_HOST`, `MCP` services; `DB`                                                            | none                                                                      |
| `<n>-app`               | `app.ts`               | Dashboard: TanStack SSR + assets, oRPC `/api`, debug routes, stream RPC, app-host itx                                                                                                                 | every DO namespace (cross-script), `LOADER`, `AI`, `DB`, artifacts trio, `MCP`/`PROJECT_HOST` services | `nodejs_compat`, `global_fetch_strictly_public`                           |
| `<n>-stream`            | `stream.ts`            | `StreamDurableObject` (journals, event streams)                                                                                                                                                       | subscriber namespaces: `AGENT`, `PROJECT`, `REPO`, `SLACK_AGENT`, `SLACK_INTEGRATION`                  | none                                                                      |
| `<n>-project`           | `project.ts`           | `ProjectDurableObject` + the **project-host lane** (stateless fetch: project-host itx + ingress-callable dispatch) + `ProjectIngressEntrypoint`, `ItxCapabilityIngress`, `ProjectMcpServerEntrypoint` | loopback union (below)                                                                                 | `nodejs_als`, `global_fetch_strictly_public`                              |
| `<n>-agent`             | `agent.ts`             | `AgentDurableObject` (agent + LLM processors)                                                                                                                                                         | loopback union                                                                                         | `nodejs_compat` (openai), `global_fetch_strictly_public`                  |
| `<n>-itx`               | `itx.ts`               | `ItxDurableObject` (generic extended-context hosts)                                                                                                                                                   | loopback union                                                                                         | `global_fetch_strictly_public`                                            |
| `<n>-mcp`               | `mcp.ts`               | `ProjectMcpServerConnection` + the MCP endpoint (`handleMcpFetch` as default fetch)                                                                                                                   | loopback union + own namespace                                                                         | `nodejs_compat` (agents pkg, better-auth), `global_fetch_strictly_public` |
| `<n>-repo`              | `repo.ts`              | `RepoDurableObject` + the artifact-events **queue consumer**                                                                                                                                          | own ns, `STREAM`, `DO_CATALOG`, `ARTIFACTS` (+account/namespace), `GLOBAL_STREAM_NAMESPACE`            | `nodejs_compat` (isomorphic-git, shell)                                   |
| `<n>-workspace`         | `workspace.ts`         | `WorkspaceDurableObject`                                                                                                                                                                              | own ns, `DO_CATALOG`                                                                                   | `nodejs_compat` (@cloudflare/shell)                                       |
| `<n>-slack-integration` | `slack-integration.ts` | `SlackIntegrationDurableObject`                                                                                                                                                                       | own ns, `SLACK_AGENT`, `AGENT`, `STREAM`, `DB`/`DO_CATALOG`, slack token                               | none                                                                      |
| `<n>-slack-agent`       | `slack-agent.ts`       | `SlackAgentDurableObject`                                                                                                                                                                             | own ns, `STREAM`, `DO_CATALOG`, slack token                                                            | none                                                                      |

Every non-app worker has a tiny default fetch returning
`{"worker": "os-<id>"}` with a 404 — useful as a cold-start probe and a
"which worker am I talking to" check.

## Cross-script Durable Object bindings

A Durable Object class is implemented in exactly one worker; everyone else
binds it as a **cross-script namespace**. In `alchemy.run.ts` each namespace
is declared once with `scriptName` = the owning worker:

```ts
const stream = DurableObjectNamespace<Stream>("stream", {
  className: "StreamDurableObject",
  scriptName: workerNames.stream,
  sqlite: true,
});
```

The same object is passed to the owner (alchemy strips `script_name` and
runs the class migrations there) and to every consumer (alchemy emits a
`script_name` binding). Stubs behave identically to same-script stubs —
`env.STREAM.getByName(...)` works unchanged, RPC and WebSockets included.

**Cycles are fine.** The stream worker binds every subscriber namespace (it
dials subscribers by binding name embedded in the subscription), and every
subscriber binds `STREAM` back. Cloudflare accepts mutual cross-script
bindings as long as both scripts exist.

## The loopback union

itx resolves loopback capabilities through `ctx.exports`, which only sees
classes exported from the _same_ script. Every itx-hosting worker (project,
agent, itx, mcp, app) therefore re-exports
[`src/workers/shared/loopback-exports.ts`](../src/workers/shared/loopback-exports.ts)
— one module, identical `ctx.exports` everywhere — and carries the
`loopbackUnionBindings` those classes need (see `alchemy.run.ts`).

The loopback classes are deliberately thin (fetch + D1 + DO stubs). Keeping
them thin is what keeps the itx-hosting workers small: **never value-import
a Durable Object implementation module from a capability or shared
module.** Name/stub helpers live in separate light modules for exactly this
reason (`repo-durable-object-name.ts`, `project-durable-object-ref.ts`,
`artifact-token.ts`, `ingress/host-headers.ts`, `itx/cap-host-ingress.ts`).
If you add an import and a worker suddenly needs `nodejs_compat` or doubles
in size, trace it with esbuild:

```bash
pnpm exec esbuild src/workers/<w>.ts --bundle --metafile=/tmp/meta.json \
  --format=esm --platform=node --conditions=workerd,worker,browser \
  '--external:cloudflare:workers' '--external:node:*' '--alias:~=./src' \
  '--loader:.wasm=file' '--loader:.sql=text' --outfile=/tmp/out.js
```

## Request routing

The ingress worker is the only worker with routes (`os.iterate.com`,
`iterate.app` + `*.iterate.app`, the MCP hostname, the event-docs
hostname). Its entire job: one config parse, at most one D1 ingress-rule
lookup, one service-binding forward
([`src/workers/shared/router.ts`](../src/workers/shared/router.ts)):

```
                    ┌────────────► <n>-mcp     (MCP hostname)
browser ──► <n> ────┼────────────► <n>-project (ingress-rule match: project
 (routes)  ingress  │               hosts, custom hostnames, cap hosts —
                    │               resolved rule rides an internal header)
                    └────────────► <n>-app     (everything else)
```

- The matched rule is forwarded on `x-iterate-resolved-ingress` so the
  project worker doesn't repeat the D1 lookup. The internal headers are
  trustworthy because (a) the ingress worker strips them from inbound
  requests — it is the trust boundary — and (b) the app/project/mcp workers
  have **no routes and no workers.dev URL**: they are only reachable via
  service bindings from workers that just resolved the rule. This matches
  Cloudflare's own framing of bindings as capability grants ("a named
  entrypoint is only accessible to Workers which have explicitly declared a
  binding to it").
- Deviation from first-party guidance worth knowing: Cloudflare recommends
  RPC named entrypoints over `fetch()` forwarding for worker-to-worker
  calls. The router lanes use default-entrypoint `fetch()` deliberately —
  whole-request forwarding is the documented use case for the HTTP
  interface, and alchemy 0.83's local dev drops `__entrypoint__` on
  named-entrypoint service bindings (see `Worker.experimentalEntrypoint`).
  Revisit if that lands upstream.
- App-lane requests get `x-iterate-routed-lane: app`, so the app worker
  skips re-routing.
- The **app worker runs the same router first** when a request reaches it
  without that header (local dev, workers.dev). One routing code path — no
  dev/prod fork.
- Project-host itx (`/__itx`) terminates in the project worker's stateless
  fetch (itx Law 7: Cap'n Web never terminates in a DO).
- **Admin debug routes are app-host-only** (deliberate change from the
  monolith, which incidentally served them on every hostname it routed):
  `handleDebugRoutes` (`/__debug/*`, `/api/itx/openapi-fixture`) runs only
  in the app worker, so the admin debug surface no longer exists on
  customer-facing project/custom hostnames. Operator tooling and the itx e2e
  fixtures already target the app base URL.

## Local dev: one workerd, twelve workers

`pnpm dev` runs **all** workers inside vite's single workerd via
`@cloudflare/vite-plugin`'s `auxiliaryWorkers`:

1. `alchemy.run.ts` (local mode) writes a wrangler config per worker under
   `.alchemy/local/workers/` plus a manifest (`.alchemy/local/aux-workers.json`),
   and gives each Worker resource a `dev.url` so alchemy does not also run
   it in its own miniflare.
2. `vite.config.ts` reads the manifest and passes the configs as
   `auxiliaryWorkers`.
3. The browser talks to vite directly (`http://localhost:<port>`,
   project hosts as `<slug>.localhost:<port>`); the app worker's embedded
   router handles the project-host/MCP lanes over the same service bindings
   the ingress uses in production. The ingress worker isn't part of the dev
   loop (it would be a no-op hop in front of vite).

Why one workerd instead of wrangler's cross-process dev registry: the
registry proxy dials remote Durable Objects **by hex id**, which loses
`ctx.id.name` — and Stream and itx DOs derive their identity from their
name. In one workerd, cross-script `getByName` keeps names intact, exactly
like production.

## Fresh-stage bootstrap (two-pass deploy)

Cloudflare rejects a cross-script DO binding whose target script doesn't
exist yet (error 10061). On the **first** deploy of a fresh stage the
stream↔subscriber cycle is therefore unsatisfiable in one pass.
`alchemy.run.ts` handles this automatically: it checks which worker scripts
exist, omits cross-script bindings whose target is missing (with a loud
warning), and re-executes itself once after finalize to wire them up.
Steady-state deploys (all scripts exist) never take this path; local dev
never needs it (one workerd, lazy resolution).

So: `pnpm cf:deploy` against a fresh stage just works — it deploys twice
under the hood.

## Operational notes

- **Observability**: every worker ships full-sample logs/traces
  (`ITERATE_WORKER_OBSERVABILITY`). When querying, remember the worker
  names are now per-domain: Slack processing logs live under
  `os-prd-slack-integration`, agent turns under `os-prd-agent`, etc.
  `apps/os/docs/debugging-deployed-os-workers.md` has the updated query
  patterns.
- **The `workers` export** in `alchemy.run.ts` feeds the global `Env` type
  (`src/lib/worker-env.d.ts`): one `Env` = the union of all workers'
  bindings, resolved lazily through interface inheritance (a type-alias
  intersection trips TS7022 cycles). Whether a binding exists at runtime
  depends on the worker — narrow per-class Env types remain the precision
  mechanism.
- **streams-example-app** (`apps/streams-example-app`) binds the Stream DO
  cross-script; its `script_name` is `os-prd-stream` now.
- The `artifacts` binding type exists only on deployed workers; local dev
  has no Cloudflare Artifacts emulation and repo code feature-checks
  `env.ARTIFACTS` (same as before the split).

## Measured impact

Measured 2026-06-12 on preview slot 3, A/B on the same slot: old topology =
main @ `62e649fd4` (one monolith), new = this topology. Script sizes are the
full uploaded content (Workers Scripts API `content/v2`, all modules).
Cold-start probe: TTFB of `/__durable-objects/stream/<fresh-name>/`
immediately after a fresh deploy — each fresh name instantiates a new Stream
DO, which is what chained request paths (e.g. Slack webhook →
slack-integration → stream → agent) pay per hop.

**Script sizes** (what every cold isolate of that worker loads):

| Worker                      | Uploaded size | vs monolith (28.3MB)                                                                       |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| ingress                     | 1.3MB         | 22× smaller                                                                                |
| stream                      | 2.3MB         | 12×                                                                                        |
| slack-agent                 | 2.1MB         | 14×                                                                                        |
| slack-integration           | 2.5MB         | 11×                                                                                        |
| workspace                   | 3.3MB         | 9×                                                                                         |
| repo                        | 3.8MB         | 7×                                                                                         |
| itx / project / mcp / agent | 19.6–23.5MB   | ~14MB of each is `esbuild.wasm` (precompiled; see tasks/os-source-build-builder-worker.md) |
| app                         | 27.3MB        | the TanStack SSR bundle — but no Durable Object ever loads it anymore                      |

**Fresh Stream DO instantiation** (TTFB, post-deploy, same colo):

|        | old monolith | new topology     |
| ------ | ------------ | ---------------- |
| median | 1.05s (n=8)  | **0.40s** (n=12) |
| min    | 0.93s        | 0.33s            |

The residual ~0.3s floor and occasional ~1.2–1.7s outliers are Durable
Object placement + storage init, which the split doesn't touch. The script
load component — which the old topology paid per DO isolate, and chained
paths paid several times — is what dropped. Dashboard (app worker) warm
requests are unchanged (~70ms); its cold SSR boot (~0.8s) is also unchanged,
but is paid only on the app lane, never by Durable Objects.
