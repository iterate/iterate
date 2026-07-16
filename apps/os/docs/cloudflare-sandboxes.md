# Cloudflare Sandboxes & Containers — platform guide

The **operator + best-practices** companion to [Sandboxes](./sandboxes.md). That
doc is how OUR sandboxes work (create-before-get, instance types, persistence,
egress); this one is the Cloudflare **platform** underneath: how the namespaces
are laid out, how to SSH into a running instance, what features exist, which
we've adopted, and which are deprecated. Every capability links to the
first-party docs — check those for the authoritative, current detail (the
platform moves fast; this file records our stance, not a mirror of Cloudflare's
reference).

First-party roots:

- Sandbox SDK: <https://developers.cloudflare.com/sandbox/> (sitemap: `/sandbox/llms.txt`)
- Containers platform: <https://developers.cloudflare.com/containers/>
- `wrangler containers` CLI: <https://developers.cloudflare.com/workers/wrangler/commands/containers/>
- Changelog (containers): <https://developers.cloudflare.com/changelog/product/containers/>

Versions we pin: `@cloudflare/sandbox` **0.12.3**, `@cloudflare/containers` **0.3.7**
(base image `docker.io/cloudflare/sandbox:0.12.3` in
`apps/os/sandbox/Dockerfile` — keep the tag in lockstep with the SDK or it logs
a version-skew warning).

---

## How the namespaces are laid out

A sandbox is a **container-backed Durable Object**. Our stack maps onto
Cloudflare's primitives like this:

| Layer                          | Ours                                                         | Notes                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| DO namespace bindings          | `SANDBOX_LITE` … `SANDBOX_STANDARD_4`                        | one per instance type (Cloudflare fixes `instance_type` per container class); table in `src/domains/sandboxes/instance-types.ts` |
| DO classes (container classes) | `SandboxLiteDurableObject` … `SandboxStandard4DurableObject` | all extend one abstract `SandboxDurableObject`; one `containers` entry each                                                      |
| DO name → identity             | `{projectId}.iterate{path}`                                  | `DurableObjectNameCodec`; the path IS the sandbox address, always `/sandboxes/<name>` (flat — single-segment names)              |
| Container image                | `sandbox/Dockerfile` → stock `cloudflare/sandbox:0.12.3`     | a one-line FROM; one image shared by every class                                                                                 |
| Cloudflare "applications"      | `os-<env>-sandbox<type>durableobject-<config>`               | one container app per class — the id you pass to `wrangler containers instances`                                                 |
| Instances                      | one per live sandbox (per DO id)                             | torn down (with a `/workspace` snapshot) on `sleep()` or `sleepAfter` idle                                                       |
| Persistent storage             | R2 bucket `os-<env>-sandboxes`, binding `BACKUP_BUCKET`      | one bucket per env; each sandbox is a `/{projectId}{path}` prefix (backup/restore, see [Sandboxes](./sandboxes.md))              |

Key consequences:

- **The path is the identity; the journal routes.** The instance type is
  configuration, not a path segment (a type segment would materialize
  meaningless intermediate folder streams like `/sandboxes/lite`).
  `itx.sandboxes.create` claims the name by appending `create-requested` to
  the `/sandboxes` catalogue stream (idempotency-keyed by path — atomic), and
  `itx.sandboxes.get(path)` reads the claim back to pick the namespace, then
  mints the DO stub from `{projectId}:{path}`. Same path → same sandbox (and
  its snapshot lineage). The catalogue stream _is_ the directory — no separate
  registry, and lookups never materialize per-path streams.
- **Existence is explicit.** A stub only answers once `itx.sandboxes.create`
  recorded the sandbox; addressing never creates (unlike stock `getSandbox`).
- Per-class settings (`instance_type`, `max_instances`, `ssh`,
  `authorized_keys`) are set per instance type in
  `apps/os/scripts/generate-wrangler-config.ts`.
- Instances do not map 1:1 to anything durable except their DO. Disk is
  ephemeral; identity + the create record + the backup handle live in DO
  storage; the container is cattle — the SANDBOX is the pet.

---

## SSH into a running instance

SSH is **enabled** on every sandbox container class (`ssh: { enabled: true }` +
`authorized_keys` in the generated wrangler config). It is account-authenticated
(you need Wrangler **write** access to the container) _and_ gated on your public
key being in `authorized_keys` — and it opens **no public port** (the session
tunnels through Wrangler / the control plane). Docs:
<https://developers.cloudflare.com/containers/ssh/>.

```bash
# From apps/os. Wrap in `doppler run --config <env> --project os --` to target a
# deployed env (prd / preview_N); the Doppler config supplies the CF account.

# 1. Find the container application id (one app per instance type) and the
#    live instance ids:
doppler run --config prd --project os -- pnpm exec wrangler containers list
doppler run --config prd --project os -- pnpm exec wrangler containers instances <APPLICATION_ID>

# 2. SSH into one instance:
doppler run --config prd --project os -- pnpm exec wrangler containers ssh <INSTANCE_ID>

# Or as a normal ssh/scp client via ProxyCommand (added 2026-05-28):
ssh -o ProxyCommand="pnpm exec wrangler containers ssh %h" cloudchamber@<INSTANCE_ID>
```

Because `authorized_keys` is a **class-level** setting applied to all six
classes, one key entry makes **every** sandbox instance reachable — there is no
per-instance provisioning.

**Add your key** (public keys are not secret; they're reviewed like any code):
append `{ name, public_key }` to `SANDBOX_SSH_AUTHORIZED_KEYS` in
`generate-wrangler-config.ts` with your **ed25519** key (the platform rejects
other types) — `gh api users/<login>/keys` or `cat ~/.ssh/id_ed25519.pub` — then
deploy. A key only takes effect for instances started after the deploy.

Caveats:

- SSH won't **start** a stopped instance, and an open SSH session alone won't
  keep an instance alive past `sleepAfter` — hold it with a running process, or
  just re-`exec` to reset the idle timer.
- **Process view**: the **`containers_pid_namespace`** compatibility flag gives
  each container its own pid namespace (its entrypoint as PID 1; SSH shows just
  that sandbox's processes, not the whole VM). It's **default-on at our
  `compatibility_date`** (≥ 2026-04-01) — we stay on the latest date, so we get
  the isolated view for free and do **not** list the flag (we don't carry
  default flags). Docs: <https://developers.cloudflare.com/containers/ssh/>.
- SSH is for humans debugging. Programmatic "run a command in the container" is
  the SDK's `exec()` (goes through our existence + egress guards), not SSH.

---

## Environment variables

Every sandbox carries a durable env-var map applied to every command —
`create({ env })` seeds it, and **`setEnvVars(vars)`** (the SDK's own method,
made durable on our subclass — the stock one only mutates the running
container's memory) merges into it; `undefined` unsets a key, and every call
lands as a `sandbox/configured` event on the sandbox's stream.

**The secret never enters the container.** A value like
`getSecret({ path: "…" })` or `getSecret({ platform: "…" })` is set verbatim as
the env var; when code in the sandbox puts it in a request header, the project
egress path substitutes the real material on the way out (the same allowlist +
substitution used for all sandbox egress — see
[Sandboxes → Egress](./sandboxes.md)). A path-referenced secret must allow the
provider host in its egress allowlist; a platform reference carries its own
origin pin (platform-secrets.ts). **Never pass raw secret material as a
value** — it would sit in the container's environment, its snapshots, and the
`configured` event on the durable stream.

**`GH_TOKEN` for connected projects:** when the project has a GitHub
connection, the sandbox plants `GH_TOKEN` automatically — a `getSecret`
placeholder for the connection secret's `accessToken` (minted/substituted only
at egress). `gh` reads it from the environment natively, and provisioning also
sets a `git http."https://github.com/".extraheader` with
`AUTHORIZATION: Basic base64(x-access-token:$GH_TOKEN)` — GitHub's git
smart-HTTP endpoint rejects Bearer tokens (API-style) and wants Basic with
username `x-access-token`. The placeholder rides inside the base64 payload;
project egress peels Basic Authorization headers before substituting, so plain
`git` and `gitCheckout` against github.com work without token bytes entering
the container. Provisioning also sets `user.name` / `user.email` to brand-lowercase
**`iterate`** plus the first-party GitHub App bot noreply address so commits
show the app avatar. Discovery runs per container start (a new connection is picked up on
the next start); with several connections the lexicographically first
connection name wins; `setEnvVars({ GH_TOKEN })` overrides the pick.

**Nothing else is planted, and nothing is baked into the image.** There is no
bundled coding agent and no automatic repo checkout — a sandbox starts as the
stock image (Ubuntu 22.04, Node 20, Bun, git, curl, jq) plus whatever its
`/workspace` snapshots carry. Install tools at runtime (`apt-get`, `npm -g`,
…); installs into `/workspace` persist across sleep, everything else
reinstalls per container.

---

## Public URLs for sandbox services (quick tunnels)

To reach a server running inside a sandbox from the public internet, use a
**quick tunnel**:

```ts
await sandbox.startProcess("bun server.ts"); // something listening on :8080
const { url } = await sandbox.tunnels.get(8080); // https://<random>.trycloudflare.com
```

It runs `cloudflared` in the container and returns a random
`*.trycloudflare.com` URL. Requires `SANDBOX_TRANSPORT=rpc` (we set it). The
URL is publicly reachable, and cloudflared's outbound connection works through
our egress interception. The URL is **ephemeral** — it changes on container
restart — so fetch it fresh each session; `tunnels.destroy(port)` closes it.
Docs: <https://developers.cloudflare.com/sandbox/api/tunnels/>.

**`exposePort()` preview URLs are fenced off** (the method throws): they route
by a sandbox-ID hostname, and our DO names are never hostname-safe — the URLs
could never resolve. Cloudflare deprecated the API in favor of tunnels anyway.

**We deliberately do NOT use named tunnels** (`tunnels.get(port, { name })`),
even though they'd give a stable `<name>.<zone>` hostname. A named tunnel makes
the SDK **write a proxied CNAME into our DNS at runtime** (`POST
/zones/:id/dns_records` → `<tunnelId>.cfargotunnel.com`) and needs a
`CLOUDFLARE_API_TOKEN` with **Zone:DNS:Edit** reachable from the sandbox flow —
a far larger blast radius than our posture (sandboxes hold no credentials;
secrets inject only at egress). If we ever want stable per-project hostnames,
we'll provision the tunnel + DNS **ourselves** server-side with a scoped token
that never enters a sandbox.

---

## Observability & logging

We deploy with full observability already (`OBSERVABILITY` in
the repo-root `scripts/lib/wrangler-config.ts`: `observability.enabled`, persisted logs +
traces, full sampling). Container stdout/stderr surfaces through the **Workers
Logs** pipeline, so:

- **`wrangler tail`** streams a deployed worker's logs (container output
  included): `doppler run --config prd --project os -- pnpm exec wrangler tail`.
- **Dashboard** (Workers → os → Logs) shows live + historical logs; since
  2026-04-21 the container logs view also inlines the related Worker and Durable
  Object logs, so a request traces across all three.
- **Retention** follows Worker limits (7 days on Paid).
- **Instance metrics** (CPU / memory / disk / instance counts) are a dashboard
  feature of each Containers app, not a wrangler config key.
- **`labels`** — the sandbox classes set `{ app: "iterate-os", component: "sandbox" }`
  so instances are filterable in Containers analytics.
- **Lifecycle as stream events** — our own addition, not Cloudflare's: every
  sandbox appends its whole saga to the stream at its own path —
  `created` → `started` → … → `sleep-requested` →
  `backup-created` → `stopped` → `destroy-requested` → `destroyed` (see
  [Sandboxes → Lifecycle](./sandboxes.md#lifecycle-imperative-commands-evented-completions)).

Docs: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>,
container FAQ <https://developers.cloudflare.com/containers/faq/>.

---

## Feature inventory — adopted, available, avoid

### Adopted

| Feature                                               | Where                                                      | First-party docs                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Backup / restore (workspace persistence)              | `SandboxDurableObject`                                     | [api/backups](https://developers.cloudflare.com/sandbox/api/backups/)                                          |
| Outbound egress control (project policy + MITM)       | per-class `outbound` handlers, `interceptHttps`            | [guides/outbound-traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)                  |
| Instance types, one class per type                    | `instance-types.ts` + `generate-wrangler-config.ts`        | [platform-details/limits](https://developers.cloudflare.com/containers/platform-details/limits/)               |
| Sleep → **destroy** (not stop) to free instance slots | `sleep()` / `onActivityExpired`                            | [platform-details/scaling](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/) |
| Quick tunnels                                         | pass-through `sandbox.tunnels`                             | [api/tunnels](https://developers.cloudflare.com/sandbox/api/tunnels/)                                          |
| SSH into instances                                    | `ssh` + `authorized_keys` in `generate-wrangler-config.ts` | [containers/ssh](https://developers.cloudflare.com/containers/ssh/)                                            |
| Instance labels                                       | `SandboxDurableObject.labels`                              | [containers metrics]                                                                                           |

### Available and worth reaching for (pass-through, not wired into product UI yet)

- **Code interpreter** — stateful Python/JS with rich outputs:
  `createCodeContext` / `runCode` / `runCodeStream`.
  [api/interpreter](https://developers.cloudflare.com/sandbox/api/interpreter/).
- **Sessions** — isolate shell state / env / cwd per workflow:
  `createSession` / `getSession`. [api/sessions](https://developers.cloudflare.com/sandbox/api/sessions/).
- **File watching** — real-time FS change events (`watch`).
  [api/file-watching](https://developers.cloudflare.com/sandbox/api/file-watching/).
- **Interactive terminal in the browser** — PTY over WebSocket via
  `sandbox.terminal(request)` + the shipped `@cloudflare/sandbox/xterm` addon;
  needs an ingress route to be usable — a future dashboard feature.
  [api/terminal](https://developers.cloudflare.com/sandbox/api/terminal/).
- **Docker-in-Docker** — rootless dind for image builds inside a sandbox.
  [guides/docker-in-docker](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/).
- **Regional / jurisdictional placement** — pin containers to regions /
  compliance boundaries. [changelog](https://developers.cloudflare.com/changelog/product/containers/).

### Deprecated / fenced / avoid

- **`exposePort()`** — fenced (throws) on our classes; use **tunnels**.
  [concepts/preview-urls](https://developers.cloudflare.com/sandbox/concepts/preview-urls/).
- **`mountBucket()`** — fenced (throws): its `r2.internal` traffic cannot
  coexist with our catch-all egress interception (verified broken live).
  `/workspace` snapshots are the persistence story.
  [api/storage](https://developers.cloudflare.com/sandbox/api/storage/).
- **HTTP / WebSocket transports** — removed from Sandbox SDK versions released
  **after 2026-07-09**; the future is the **RPC transport**
  (`SANDBOX_TRANSPORT=rpc`, which we set). Treat this as the priority
  migration item when upgrading the SDK.
  [guides/2026-deprecation](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/).
- **Desktop / browser-automation APIs** — removed from the SDK (v0.10.2); use
  Cloudflare Browser Rendering instead.

---

## Instance types, scaling, placement

- **Instance types are per container class** — that is exactly why each type is
  its own DO class (see instance-types.ts). Disk must hold the unpacked image;
  the stock image fits comfortably in every type including `lite` (2 GB).
  Billing is while-running only (active-CPU since 2025-11-21), so idle
  slept-and-snapshotted sandboxes cost nothing.
  [platform-details/limits](https://developers.cloudflare.com/containers/platform-details/limits/).
- **`max_instances`** caps concurrent instances per class; exceeding it
  surfaces as HTTP 503 on sandbox start. Cloudflare validates
  `max_instances × instance memory` against the **account's** concurrent-memory
  quota at deploy time — and the preview account is shared by every preview
  slot — so preview caps are small (`SANDBOX_MAX_INSTANCES` in
  `generate-wrangler-config.ts`).
- **Startup timeouts** (`SANDBOX_INSTANCE_TIMEOUT_MS` / `SANDBOX_PORT_TIMEOUT_MS`,
  both 300s in the generated config) exist to cover a cold-host image pull;
  generous ceilings cost nothing when startup is fast.
- **No autoscaling yet** — Cloudflare's stated roadmap. We use DO-name
  addressing, so this doesn't affect us.

---

## Operations cheatsheet

```bash
# All from apps/os; wrap in `doppler run --config <env> --project os --` for a deployed env.
pnpm exec wrangler containers list                       # container apps (one per instance type)
pnpm exec wrangler containers info <CONTAINER_ID>        # one app's status/config
pnpm exec wrangler containers instances <APPLICATION_ID> # live instances (ids, state, location)
pnpm exec wrangler containers ssh <INSTANCE_ID>          # interactive shell (see SSH section)
pnpm exec wrangler containers delete <CONTAINER_ID>      # tear down an app
pnpm exec wrangler tail                                  # stream logs (container output included)
```

The sandbox smoke recipe lives in
[Sandboxes → Local dev](./sandboxes.md#local-dev-orbstack--docker); the R2
bucket for a new env is created by `pnpm ensure-resources --env <env>`.
