# Sandboxes

> For the platform underneath this — namespace layout, **SSH into an
> instance**, the full Cloudflare feature inventory, deprecations, and ops —
> see [Cloudflare Sandboxes & Containers](./cloudflare-sandboxes.md). This doc
> is how OUR sandboxes work. For the sandbox API itself (exec, files,
> processes, git, tunnels, sessions, code interpreter) the authoritative
> reference is Cloudflare's own docs:
> <https://developers.cloudflare.com/sandbox/> — we deliberately add as little
> as possible on top.

Sandboxes are project-scoped Cloudflare Sandbox containers, kept like
**pets**: each one is explicitly created with a name and a Cloudflare instance type, lives at a
stable path, and has an imperative lifecycle. Nothing on the platform mints a
sandbox implicitly — agents don't get one at birth, and `get()` refuses paths
that were never created.

```ts
// Create once (strict: an existing or destroyed name is an error) …
const { path } = await itx.sandboxes.create({ name: "main", instanceType: "basic" });

// … then address it by path, forever. get() returns the BARE
// @cloudflare/sandbox stub — the SDK's whole surface, nothing wrapped on top.
const sandbox = await itx.sandboxes.get(path); // "/sandboxes/main"
await sandbox.exec("echo hi"); // first command boots the container
await sandbox.gitCheckout("https://github.com/acme/repo", { targetDir: "/workspace/repo" });
await sandbox.startProcess("bun server.js");

await sandbox.sleep(); // snapshot /workspace, tear the container down — the pet survives
await sandbox.start(); // boot now (rather than lazily), snapshot restored
await sandbox.destroy(); // permanent; the name is retired

await itx.sandboxes.list(); // every sandbox stream path in the project
```

Sizes are Cloudflare's container **instance types, verbatim** — `lite`,
`basic` (default), `standard-1` … `standard-4`
([limits](https://developers.cloudflare.com/containers/platform-details/limits/)).
Cloudflare fixes the instance type per container class, so each instance type is its
own Durable Object class + namespace (`src/domains/sandboxes/instance-types.ts` is the
canonical table). The type is **configuration, not identity**: it never
appears in the path. `create` claims the name by appending
`create-requested` to the **`/sandboxes` catalogue stream** (idempotency-keyed
by path, so the stream's native dedup settles racing creates atomically), and
`get` routes to the right namespace by that claim's instance type. The
catalogue and not the sandbox's own stream because ANY read materializes a
stream — routing lookups through per-sandbox streams would mint a junk stream
for every typo'd `get`. Honest about the one thing a sandbox can never change,
without a type segment in every address.

Paths are flat — **`/sandboxes/<name>`**, names are one path segment. The
streams system materializes every path prefix as a stream (a new stream
announces itself to all ancestors), so a nested path like
`/sandboxes/lite/main` would mint a meaningless intermediate "folder" stream
(`/sandboxes/lite`) that shows up in listings but is not a sandbox. The path
scheme otherwise follows the collection-prefix convention (`/secrets/...`,
`/repos/...`, `/agents/...`). The prefix makes sandbox addresses
discoverable; it does not implicitly create a processor on any stream.

The image is the **stock Cloudflare sandbox image**
(`sandbox/Dockerfile` is a one-line `FROM docker.io/cloudflare/sandbox:<sdk-version>`
— Ubuntu 22.04, Node 20, Bun, git, curl, jq;
[what's in it](https://developers.cloudflare.com/sandbox/configuration/dockerfile/)).
Nothing is baked in: tools a workload needs are installed inside the sandbox
at runtime, and what's installed under `/workspace` persists (below). This is
what keeps builds and deploys fast — no image bake, and all six instance-type classes
share one cached image.

## Lifecycle: imperative commands, evented completions

Every lifecycle verb appears on the sandbox's own stream as a
`<verb>-requested` / past-tense pair (the command, then the reality — see
`sandbox-processor-contract.ts`):

| Command                                                                        | What happens                                                                                                                                                  | Events                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `itx.sandboxes.create({ name, instanceType?, sleepAfter?, keepAlive?, env? })` | Durable record written; no container boots. Strict — destroyed names are retired, not recycled.                                                               | `create-requested` (on the `/sandboxes` catalogue) → `created` (+ `configured` when `env` given) |
| `start()`                                                                      | Boot the container now, restore `/workspace`, apply env vars. Also happens implicitly when a command reaches a stopped sandbox.                               | `start-requested` → `started` (implicit wakes emit `started` only)                               |
| `sleep()`                                                                      | Snapshot `/workspace` to R2, then tear the container down. The sandbox stays created. The idle timer (`sleepAfter`, default 10m) does the same automatically. | `sleep-requested` → `backup-created` → `stopped`                                                 |
| `destroy()`                                                                    | Permanent: container torn down, record tombstoned, `get()` refuses the path forever.                                                                          | `destroy-requested` → `stopped` → `destroyed`                                                    |

`started`/`stopped` are the authoritative signal (they also fire for implicit
wakes and idle sleeps); the `-requested` events are the record of who asked.
`create-requested` is the one durable-by-contract append — it IS the name
claim and the routing record, so `create` awaits it. Requested and ancillary
audit facts are best-effort; the `created`/`started`/`stopped`/`destroyed`
completions that drive UI state are appended and folded before their lifecycle
boundary returns. `SandboxProcessor` is hosted by the Sandbox Durable Object
and folds the events into a small projection (`status`, `running`,
`instanceType`, `lastBackupId`, `env`) exposed through
`itx.sandboxes.processor(path)` and `itx.sandboxes.liveState(path)`. It takes no
actions, disables recovery so it does not compete for the Containers SDK's
alarm, and receives durable stream wakes through the sandbox collection.

## `/workspace` persists across stop/sleep (R2 backup/restore)

Cloudflare container disk is **ephemeral** — there is no persistent volume
([FAQ](https://developers.cloudflare.com/containers/faq/)), and Cloudflare's
own docs describe sleep as state loss. What makes our sandboxes pets rather
than goldfish is the Sandbox SDK's
[backup/restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/),
hung off the SDK's own lifecycle hooks:

- **`sleep()` and `onActivityExpired`** (the idle-timer hook — the one moment
  the container is still running but about to go away; `onStop` is too late)
  snapshot `/workspace` with
  [`createBackup`](https://developers.cloudflare.com/sandbox/api/backups/) —
  `node_modules`-excluded, gitignore-aware inside git checkouts — store the
  returned handle in Durable Object storage, then **destroy** the container
  (not the SDK's stop: a stopped container keeps its instance assignment
  against `max_instances` forever; the snapshot is what makes destroy
  loss-free). A backup failure never wedges the container alive; the handle
  keeps pointing at the last good snapshot.
- The **first guarded command** after a start restores the newest snapshot
  (seconds) and re-applies the env-var map. `onStart` itself only resets
  per-container state — it cannot kick provisioning off (it runs inside the
  container framework's `blockConcurrencyWhile`, hard ~30s budget), and it
  doesn't need to: every public op awaits readiness internally.
- Backups expire after **90 days idle** — the SDK checks its `ttl` only at
  restore time; actual R2 deletion is a bucket lifecycle rule on the
  `backups/` prefix, set by `ensure-resources`. An expired workspace degrades
  to an empty one.

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
disk. A container that _crashes_ (rather than stopping cleanly) loses what
changed since the last snapshot. Durable work belongs in a repo — committed
and pushed.

### Other persistence mechanisms Cloudflare documents, and why not them

- **[`mountBucket`](https://developers.cloudflare.com/sandbox/api/storage/)**
  (the SDK's "persistent storage": R2 as a live FUSE filesystem) was tried
  first — continuous persistence beats snapshots on paper. It is incompatible
  with our egress model in practice: its credential-less R2-binding mode sends
  s3fs traffic to the magic host `r2.internal`, serviced by the SDK's own
  per-host container-egress interceptor, which our catch-all
  all-egress-through-project-policy handler necessarily swallows. Verified
  broken on a real preview — every filesystem op on the mount returned
  `Input/output error`. Backup/restore needs no exemption (presigned
  transfers are plain HTTPS to real hosts, through project egress).
- **[Raw R2 FUSE mount](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)**
  hand-rolled in the Dockerfile is the same mechanism minus the management —
  same conflict, plus S3 credentials inside the container.
- **Durable Object storage** (`ctx.storage`) is key/value, not a filesystem —
  right for the create record, identity, and the backup handle this class
  keeps, not a build tree.

## Environment variables

Every sandbox carries a durable env-var map applied to every command —
`create({ env })` seeds it, `setEnvVars(vars)` merges into it (the SDK's own method name, made durable) (each call
emits a `configured` event). Values are conventionally
`getSecret({ path })` placeholders: the material stays in the secret system
and is substituted only at the egress door, so code in the sandbox reads e.g.
`OPENAI_API_KEY` from its environment and calls the provider while the real
key never enters the container (or its snapshots). **Never pass raw secret
material as a value** — it would land on the durable stream.

When the project has a GitHub connection, the sandbox plants **`GH_TOKEN`**
automatically (a placeholder for the connection secret's `accessToken`,
re-discovered per container start; lexicographically-first connection wins;
`setEnvVars({ GH_TOKEN })` overrides) and configures git with Basic
`http.extraheader` for github.com — so `gh`, curl-with-Bearer, and
git-over-https against github.com work out of the box, and `gitCheckout` is
the way to get code into a sandbox. Every sandbox also gets stock git
`user.name` / `user.email` as **`iterate`** + the first-party GitHub App bot
noreply address so commits pushed from the sandbox show the iterate app
avatar. Nothing else is planted: there is no baked coding agent
and no automatic repo checkout — a sandbox starts as the stock image plus
whatever its snapshots carry.

## Egress: all sandbox traffic goes through project policy

A sandbox container has **no direct internet path**. Every outbound request it
makes — HTTP and, because `interceptHttps = true`, HTTPS — is intercepted by
the `@cloudflare/containers` proxy and forwarded to the owning project's
Durable Object, the same decision point `ProjectEgressEntrypoint` gives dynamic
workers' `globalOutbound`. So a sandbox reaches the outside world only through
the same allow/deny/secret-substitution policy as the rest of the project.

**WebSockets:** outbound HTTP/1.1 `wss://` handshakes and duplex frames use this
same MITM path. Header secrets use `getSecret` on the upgrade; application
frames remain opaque. Released `ws` receives complete close semantics, but the
stock image's built-in Node `WebSocket` currently misses the reciprocal close
event and can wait until timeout. Details:
[sandbox-websocket-egress.md](./sandbox-websocket-egress.md).

Wiring (three points):

- `src/worker.ts` re-exports `ContainerProxy` from `@cloudflare/sandbox` —
  the SDK dials it via `ctx.exports.ContainerProxy` to route intercepted
  egress; without the export, interception throws at container start. This is
  a same-script WorkerEntrypoint export on the OS worker, not a separate
  sandbox worker.
- Every instance-type subclass registers the egress handler (the containers SDK keys
  its outbound registry by class name) and the base class sets
  `interceptHttps = true`. The handler runs in the ContainerProxy
  WorkerEntrypoint, so it only has the container's opaque Durable Object id;
  it calls `egressProjectId()` on the instance (via the instance type's own namespace)
  to recover the project, then forwards to
  `projectStub(env.PROJECT, projectId).fetch(request)`.
- HTTPS interception is a TLS man-in-the-middle: the stock `cloudflare/sandbox`
  image installs the Cloudflare-provided container CA
  (`/etc/cloudflare/certs/cloudflare-containers-ca.crt`) at container start when
  `SANDBOX_INTERCEPT_HTTPS` is set, which the SDK sets from the `interceptHttps`
  flag — so no Dockerfile change is needed for the container to trust it.

### OpenAI → Cloudflare AI Gateway

JSON **POST/PUT** to **`api.openai.com`** (chat/completions, responses, …) are
routed at **project egress** (sandbox MITM, worker `egress.fetch`, …). An
explicit project or platform `getSecret(...)` reference takes the normal
pinned secret lane; this keeps the same credential if a WebSocket client falls
back to HTTP. Without an explicit reference, JSON POST/PUT uses the Workers AI
**gateway binding only** — the same door and **platform** OpenAI key as agent
BYOK — and caller `Authorization` is replaced, so a dummy key is sufficient.
Gateway requests carry `cf-aig-metadata` with at least
`{ projectId, source: "project-egress" }`, plus BYOK-parity collect-log headers.
`OpenAI-*` and `Accept` caller headers are forwarded. Other bare methods (for
example GET `/v1/models`) are **not** rewritten and use normal project egress
(dummy keys will 401). Implementation: `openai-ai-gateway-egress.ts` +
`ProjectDurableObject.#egressOpenAiViaAiGateway`.

## Deployment

The domain lives in `src/domains/sandboxes/`; the container classes are
same-script Durable Objects in the os worker
([worker topology](./worker-topology.md)) — **one class per instance type**, all
sharing one implementation (`cloudflare/cloudflare-sandbox-durable-object.ts`)
and one image built from `sandbox/Dockerfile`
(`docker.io/cloudflare/sandbox:<sdk-version>` — keep the tag in lockstep with
the `@cloudflare/sandbox` version in package.json; the SDK logs a version-skew
warning otherwise). Per-class `instance_type` and `max_instances` are set in
`scripts/generate-wrangler-config.ts` (`SANDBOX_MAX_INSTANCES`) — deploy-time
memory quota is validated per account, so preview caps are small.

## Identity: why `get()` is async

Every domain object derives identity from its Durable Object name
(`{projectId}.iterate{path}`). Container-backed Durable Objects are the
exception: the runtime does not reliably surface `ctx.id.name` to them (the
local dev runtime drops it entirely), which is why the upstream SDK's
`getSandbox()` helper pushes the name in rather than reading it. We do the
same, at create: `itx.sandboxes.create` records the identity write-once, and
`itx.sandboxes.get(path)` awaits `assertCreated({ projectId, path })` on the
stub before handing it out — which is also what enforces "pets are created,
never minted by addressing". Consequence: dial sandboxes through
`itx.sandboxes` — a raw `env.SANDBOX_*.getByName(...)` stub that was never
created refuses every command.

## Local dev (OrbStack / Docker)

`pnpm dev` never requires Docker: by default the sandbox classes bind plain
Durable Object namespaces and any sandbox call fails at the constructor with
"Container is not enabled". To run real sandboxes locally:

```bash
# OrbStack (or Docker Desktop) must be running
OS_SANDBOX_CONTAINER_LOCAL_DEV=true pnpm dev start --detach
```

Startup builds the (one-line) image from `sandbox/Dockerfile` (first run
pulls the ~500MB base image — a couple of minutes) and vite prints
`⚡️ Containers successfully built`. Containers are created lazily: the first
`exec` boots the container, so expect it to take tens of seconds locally
(first-boot Rosetta warmup). Rebuilding the image requires a dev server
restart.

Smoke test (against a project you created locally):

```bash
doppler run --project os --config dev -- pnpm --dir apps/os cli itx run \
  --context prj_… \
  -e 'const { path } = await itx.sandboxes.create({ name: "smoke", instanceType: "lite" });
      const sb = await itx.sandboxes.get(path);
      const r = await sb.exec("ls /");
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
   containers in wrangler.jsonc's `containers` alongside same-script DO
   bindings — there is no cross-script `script_name` to get wrong anymore
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
  (`cloudflare-dev/sandbox<type>durableobject:<hash>`).
