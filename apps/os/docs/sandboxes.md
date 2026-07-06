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
await sandbox.readFile("/workspace/repos/project/README.md");
await sandbox.startProcess("bun server.js");
```

Lifecycle is the SDK's best-practice default: getting a sandbox is cheap (no
container), the first command boots it, and the SDK's durable `sleepAfter`
idle alarm (3m) stops it again. Durable Object storage and identity survive
sleep. The container's own disk does **not** — but `/workspace` comes back,
because going to sleep snapshots it to R2 and the next start restores it (see
below), which is what makes a sandbox restorable rather than merely
long-lived.

`get(path)` returns the **bare `@cloudflare/sandbox` Durable Object stub** —
no wrapper. Everything the SDK exposes (exec, files, processes, git, ports,
tunnels, `destroy()`, …) is callable directly; see the
[Sandbox SDK docs](https://developers.cloudflare.com/sandbox/).

## `/workspace` persists across sleep (R2 backup/restore)

Cloudflare container disk is **ephemeral** — there is no persistent volume
([FAQ](https://developers.cloudflare.com/containers/faq/)), and a sandbox that
sleeps loses its filesystem. `CloudflareSandboxDurableObject` closes that gap
with the Sandbox SDK's
[backup/restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/),
hung off the SDK's own lifecycle hooks:

- **`onActivityExpired`** (the idle-timer hook — the one moment the container
  is still running but about to go away; `onStop` is too late, the container
  is already gone) snapshots `/workspace` with
  [`createBackup`](https://developers.cloudflare.com/sandbox/api/backups/) —
  gitignore-aware and `node_modules`-excluded, so archives stay small — stores
  the returned handle in Durable Object storage, then **destroys** the
  container (not the SDK's stop: a stopped container keeps its instance
  assignment against `max_instances` forever — see the method's docstring; the
  snapshot is what makes destroy loss-free). A backup failure never wedges the
  container alive; the handle keeps pointing at the last good snapshot.
- **`onStart`** provisions the workspace in the background: restore the newest
  snapshot (seconds), then clone the repo if the checkout is still missing.
  `ensureProjectRepo()` is the awaitable guarantee.
- Backups expire after **90 days idle** (SDK `ttl`): long enough that any
  still-wanted workspace comes back intact, short enough that e2e churn
  doesn't accumulate in R2 forever. An expired workspace degrades to a fresh
  clone.

Plumbing: **one bucket per env**, `${osWorkerName}-sandboxes`, created by
`ensure-resources` (create-only) and bound as `BACKUP_BUCKET` — that exact
binding name is the SDK's contract, as are the `BACKUP_BUCKET_NAME` /
`CLOUDFLARE_R2_ACCOUNT_ID` vars and the `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` presigning secrets. The secrets are optional and select
the transfer mode: **with** them the SDK presigns
`*.r2.cloudflarestorage.com` URLs and the container transfers archives
directly — fast, and through project egress like every other container
request; **without** them (local dev always — presigned URLs don't exist under
`wrangler dev` — and any deployed env until R2 keys are minted into Doppler)
archives stream through the Durable Object's `BACKUP_BUCKET` binding — slower,
but zero-config, and persistence works either way.

**Honest limit:** this is snapshot-granular, not a continuously-persistent
disk. A container that _crashes_ (rather than idling out) loses what changed
since the last snapshot. Durable work belongs in the repo — committed and
pushed.

## Lifecycle hooks → stream events

The sandbox subclass turns its container lifecycle into ordinary stream
events, appended to the stream at the sandbox's **own path** — for an agent's
sandbox that is the agent's own journal, so the agent (and anything tailing
the stream) sees its sandbox's history. The event catalog is the **sandbox
processor contract** (`sandbox-processor-contract.ts`); the Durable Object
builds every event through it (`SandboxProcessorContract.buildEvent`), so
emission and declaration cannot drift. `SandboxProcessor`
(`sandbox-processor-implementation.ts`) holds the contract and folds the
events into a small status projection (`running`, `lastBackupId`) — it takes
no actions and is not yet wired to a processor host.

| Hook / moment                | Event (`events.iterate.com/sandbox/…`)                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `onStart`                    | `container-started`                                                                                                                       |
| workspace restored           | `workspace-restored` (with `backupId`)                                                                                                    |
| workspace freshly cloned     | `workspace-cloned`                                                                                                                        |
| background provisioning died | `workspace-setup-failed` (with `error`; the next `ensureProjectRepo()` retries from scratch)                                              |
| `onActivityExpired` backup   | `backup-created` (with `backupId`) / `backup-failed` (with `error`)                                                                       |
| `onStop`                     | `container-stopped` (may arrive on wake — the SDK delivers a stop that happened while the Durable Object was hibernated on the next wake) |

Appends are best-effort by design: lifecycle telemetry never blocks or fails a
container start/stop.

## The project repo is always checked out

Every sandbox has the project repo at `/workspace/repos/project` (credentials
are embedded in the git remote, so `git pull`/`push` work inside the sandbox),
and that path is the **default working directory** — a bare `exec("ls")` lists
the project, like a developer's shell. This is UNCONDITIONAL: every public
command and file operation (`exec`, `startProcess`, `readFile`/`writeFile`,
`gitCheckout`, `createSession`, …) awaits provisioning internally before
touching the container, so the first thing any caller does already sees the
checkout — no `await sandbox.ensureProjectRepo()` first (it stays available to
await the checkout deterministically). An explicit `cwd` always wins.

Because the workspace is snapshot-restored, the clone effectively runs
**once**: later starts restore the checkout from the backup (a fast marker
probe makes the clone a no-op), and only a first boot — or an expired/failed
backup — pays for a full clone. Guarding also closes an integrity window: a
write that landed before the snapshot restore would be silently clobbered by
it.

Provisioning cannot run synchronously inside container startup: `onStart`
executes inside the container framework's `blockConcurrencyWhile`, which has a
hard ~30s budget, kills the fresh container on cancellation (verified live —
an over-budget `onStart` resets the Durable Object), and input-gates timer
events — so nothing in there can even bound itself with a deadline. So
`onStart` only kicks provisioning off; `ensureProjectRepo()` is the awaitable
guarantee.

### Other persistence mechanisms Cloudflare documents, and why not them

- **[`mountBucket`](https://developers.cloudflare.com/sandbox/api/storage/)**
  (the SDK's "persistent storage": R2 as a live FUSE filesystem) was tried
  first — continuous persistence beats snapshots on paper. It is incompatible
  with our egress model in practice: its credential-less R2-binding mode sends
  s3fs traffic to the magic host `r2.internal`, serviced by the SDK's own
  per-host container-egress interceptor, which our catch-all
  all-egress-through-project-policy handler necessarily swallows. Verified
  broken on a real preview — every filesystem op on the mount returned
  `Input/output error`. Composing the two would mean exempting storage traffic
  from project egress policy; backup/restore needs no exemption (presigned
  transfers are plain HTTPS to real hosts, through project egress).
- **[Raw R2 FUSE mount](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)**
  hand-rolled in the Dockerfile is the same mechanism minus the management —
  same conflict, plus S3 credentials inside the container.
- **Durable Object storage** (`ctx.storage`) is key/value, not a filesystem —
  right for the identity record and the backup handle this class keeps, not a
  repo checkout or build tree.

## Egress: all sandbox traffic goes through project policy

A sandbox container has **no direct internet path**. Every outbound request it
makes — HTTP and, because `interceptHttps = true`, HTTPS — is intercepted by
the `@cloudflare/containers` proxy and forwarded to the owning project's
Durable Object, the same decision point `ProjectEgressEntrypoint` gives dynamic
workers' `globalOutbound`. So a sandbox reaches the outside world only through
the same allow/deny/secret-substitution policy as the rest of the project.

Wiring (three points):

- `src/worker.ts` re-exports `ContainerProxy` from `@cloudflare/sandbox` —
  the SDK dials it via `ctx.exports.ContainerProxy` to route intercepted
  egress; without the export, interception throws at container start. This is
  a same-script WorkerEntrypoint export on the OS worker, not a separate
  sandbox worker.
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
is a same-script Durable Object in the os worker
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
      const r = await sb.exec("ls");
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
   (the historical failure mode where a self-referential cross-script
   binding dropped `ctx.id.name`).

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
