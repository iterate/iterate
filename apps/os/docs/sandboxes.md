# Sandboxes

Project-scoped Cloudflare Sandbox containers, addressed by path like every
other domain object. A sandbox path may be ANY non-root project path,
arbitrarily nested: sandboxes live in their own Durable Object namespace, so
a sandbox path never collides with the stream or agent at the same path — it
names them. Two spellings of the same primitive:

- **Every agent owns the sandbox at its own path.** `itx.sandbox` in an agent
  scope is a PROVIDED CAPABILITY, not a built-in: the birth certificate mounts
  a durable itx-expression (`["sandboxes", ["get", <agent path>]]`) on the
  agent's capability host, so every `itx.sandbox.<method>(...)` re-evaluates
  `itx.sandboxes.get(<the agent's /agents/... path>)` at call time and
  dispatches inside the capability host. The Durable Object + identity are
  minted (no container) at birth, and the mount replays with the stream.
- **Standalone sandboxes** conventionally live under
  `/sandboxes/cloudflare/<anything>` via `itx.sandboxes.get(path)`.

```js
await itx.sandbox.exec("echo mine"); // an agent's own sandbox (dotted capability calls)
const sandbox = await itx.sandboxes.get("/sandboxes/cloudflare/whatever");
await sandbox.exec("echo hi"); // first command boots the container
await sandbox.ensureProjectRepo(); // await the project repo clone
await sandbox.readFile("/workspace/repo/README.md");
await sandbox.startProcess("bun server.js");
```

Lifecycle is the SDK's best-practice default, unchanged: getting a sandbox is
cheap (no container), the first command boots it, and the SDK's durable
`sleepAfter` idle alarm (default 10m) stops it again. Durable Object storage
and identity survive sleep; the container filesystem does not — every start
re-provisions (the repo clone below), which is what makes a sandbox
restorable rather than merely long-lived.

`get(path)` returns the **bare `@cloudflare/sandbox` Durable Object stub** —
no wrapper. Everything the SDK exposes (exec, files, processes, git, ports,
tunnels, `destroy()`, …) is callable directly; see the
[Sandbox SDK docs](https://developers.cloudflare.com/sandbox/). Getting a
sandbox is cheap; the first command starts the container. Every container
start also kicks off a clone of the project repo to `/workspace/repo`
(credentials are embedded in the git remote, so `git pull`/`push` work inside
the sandbox); `await sandbox.ensureProjectRepo()` before work that depends on
it. The clone cannot run synchronously inside container startup:
`onStart` executes inside the container framework's `blockConcurrencyWhile`,
which has a hard ~30s budget, kills the fresh container on cancellation, and
input-gates timer events — so nothing in there can even bound itself with a
deadline. Slow cold starts (first boot under Rosetta locally) would brick the
sandbox instead of merely delaying the clone.

## Egress: all sandbox traffic goes through project policy

A sandbox container has **no direct internet path**. Every outbound request it
makes — HTTP and, because `interceptHttps = true`, HTTPS — is intercepted by
the `@cloudflare/containers` proxy and forwarded to the owning project's
Durable Object, the same decision point `ProjectEgressEntrypoint` gives dynamic
workers' `globalOutbound`. So a sandbox reaches the outside world only through
the same allow/deny/secret-substitution policy as the rest of the project.

Wiring (three points):

- `src/workers/sandbox.ts` re-exports `ContainerProxy` from
  `@cloudflare/containers` — the SDK dials it via `ctx.exports.ContainerProxy`
  to route intercepted egress; without the export, interception throws at
  container start.
- `CloudflareSandboxDurableObject` sets `static outbound` (the catch-all egress
  handler) and `interceptHttps = true`. The handler runs in the ContainerProxy
  WorkerEntrypoint, so it only has the container's opaque Durable Object id; it
  calls `egressProjectId()` on the instance to recover the project, then
  forwards to `projectStub(env.PROJECT, projectId).fetch(request)`.
- HTTPS interception is a TLS man-in-the-middle: the stock `cloudflare/sandbox`
  image installs the Cloudflare-provided container CA
  (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) at container start when
  `SANDBOX_INTERCEPT_HTTPS` is set, which the SDK sets from the `interceptHttps`
  flag — so no Dockerfile change is needed for the container to trust it.

## Deployment

The domain lives in `src/domains/sandboxes/cloudflare/`; the container class
deploys as its own `os-<stage>-sandbox` worker
([worker topology](./worker-topology.md)) with the image built from
`Dockerfile.sandbox` (`docker.io/cloudflare/sandbox:<sdk-version>` — keep the
tag in lockstep with the `@cloudflare/sandbox` version in package.json; the
SDK logs a version-skew warning otherwise).

## Identity: why `get()` is async

Every domain object derives identity from its Durable Object name
(`{projectId}.iterate{path}`). Container-backed Durable
Objects are the exception: the runtime does not reliably surface
`ctx.id.name` to them (the local dev runtime drops it entirely), which is why
the upstream SDK's `getSandbox()` helper pushes the name in rather than
reading it. We do the same: `itx.sandboxes.get(path)` awaits
`ensureIdentity({ projectId, path })` on the stub before handing it out, and
the sandbox falls back to that durable record whenever `ctx.id.name` is
missing. Consequence: dial sandboxes through `itx.sandboxes.get(path)` — a
raw `env.SANDBOX.getByName(...)` stub that was never primed fails loudly on
first container start.

## Local dev (OrbStack / Docker)

`pnpm dev` never requires Docker: by default the sandbox worker binds a plain
Durable Object namespace and any sandbox call fails at the constructor with
"Container is not enabled". To run real sandboxes locally:

```bash
# OrbStack (or Docker Desktop) must be running
OS_SANDBOX_CONTAINER_LOCAL_DEV=true pnpm dev start --detach
```

Startup builds the image from `Dockerfile.sandbox` (first run pulls the
~500MB base image — a couple of minutes) and vite prints
`⚡️ Containers successfully built`. Containers are created lazily: the first
`exec` boots the container, so expect it to take tens of seconds locally
(first-boot Rosetta warmup); the repo clone completes in the background after
that. Rebuilding the image requires a dev server restart.

Smoke test (against a project you created locally — verified end-to-end on
OrbStack/Apple Silicon 2026-07-03):

```bash
doppler run --project os --config dev -- pnpm --dir apps/os cli itx run \
  --context prj_… \
  -e 'const sb = await itx.sandboxes.get("/sandboxes/cloudflare/smoke");
      await sb.ensureProjectRepo();
      const r = await sb.exec("ls /workspace/repo");
      return { exitCode: r.exitCode, stdout: r.stdout };'
```

Clean up afterwards with `await sb.destroy()` — otherwise the container idles
until `sleepAfter`.

### Apple Silicon snags (all handled, so you don't have to)

Local container support routes each container's egress through a paired
`cloudflare/proxy-everything` sidecar that workerd launches next to it. Three
upstream sharp edges bit us on Apple Silicon + OrbStack; the repo carries the
fixes, documented here in case they resurface:

1. **The egress sidecar must run natively.** Upstream
   `@cloudflare/vite-plugin` pulls the sidecar with a hardcoded
   `--platform linux/amd64`; under Rosetta the sidecar's transparent-proxy
   setsockopt fails and the sidecar dies instantly. Symptom chain: `exec`
   returns `"Container failed to start"` →
   `docker ps -a | grep workerd-…-proxy` shows `Exited (1)` →
   `docker logs <that container>` says
   `Fatal error: setsockoptint: protocol not available`. Fix: vite.config.ts
   sets `MINIFLARE_CONTAINER_EGRESS_IMAGE_PLATFORM` to the host platform
   (supported upstream since @cloudflare/vite-plugin 1.43).
2. **The default sidecar reference pins an amd64-only digest**, so even a
   host-platform pull can't resolve arm64 from it. `apps/os/vite.config.ts`
   defaults `MINIFLARE_CONTAINER_EGRESS_IMAGE` to the digest-free multi-arch
   tag instead.
3. **Same-script containers only.** The single-worker topology declares the
   container in wrangler.jsonc's `containers` alongside a same-script DO
   binding — there is no cross-script `script_name` to get wrong anymore
   (the historical alchemy-era failure mode where a self-referential
   cross-script binding dropped `ctx.id.name`).

Two more facts worth knowing:

- **The sandbox container itself runs amd64 under Rosetta locally** —
  `cloudflare/sandbox` publishes no arm64 image. That's fine for the sandbox
  runtime (a Bun control server + your processes), just slower than native.
- **Keep the cloudflare catalog pins moving together** (vite-plugin,
  wrangler, miniflare, workerd in pnpm-workspace.yaml) — a compat-date
  mismatch between them breaks `pnpm dev` with ERR_RUNTIME_FAILURE.

### Debugging

- `docker ps -a | grep workerd-` — one container per running sandbox DO plus
  its `-proxy` egress sidecar; `docker logs` either of them.
- A repeating `Using http transport` log from `component: 'sandbox-do'` with
  no container activity means the Durable Object keeps failing before the
  container layer — historically: identity/name parsing at construction.
- `docker images | grep cloudflare-dev` — the locally-built sandbox images
  (`cloudflare-dev/cloudflaresandboxdurableobject:<hash>`).
