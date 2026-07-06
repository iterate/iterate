# Cloudflare Sandboxes & Containers — platform guide

The **operator + best-practices** companion to [Sandboxes](./sandboxes.md). That
doc is how OUR sandbox works (identity, persistence, egress, the repo checkout);
this one is the Cloudflare **platform** underneath it: how the namespaces are
laid out, how to SSH into a running instance, what features exist, which we've
adopted, and which are deprecated. Every capability links to the first-party
docs — check those for the authoritative, current detail (the platform moves
fast; this file records our stance, not a mirror of Cloudflare's reference).

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

| Layer                          | Ours                                                    | Notes                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| DO namespace binding           | `SANDBOX`                                               | `env.SANDBOX`, declared in the generated wrangler config                                                                                     |
| DO class (the container class) | `CloudflareSandboxDurableObject`                        | extends the SDK's `Sandbox`; one `containers` entry names it                                                                                 |
| DO name → identity             | `{projectId}.iterate{path}`                             | `DurableObjectNameCodec`; the path IS the sandbox address (an agent's own `/agents/...` path, or `/sandboxes/cloudflare/...` for standalone) |
| Container image                | `sandbox/Dockerfile` → `cloudflare/sandbox:0.12.3`      | one image for the whole class                                                                                                                |
| Cloudflare "application"       | `os-<env>-cloudflaresandboxdurableobject-<config>`      | the container app the class deploys as — the id you pass to `wrangler containers instances`                                                  |
| Instances                      | one per live sandbox (per DO id)                        | ephemeral; idle-destroyed after `sleepAfter` (3m)                                                                                            |
| Persistent storage             | R2 bucket `os-<env>-sandboxes`, binding `BACKUP_BUCKET` | one bucket per env; each sandbox is a `/{projectId}{path}` prefix (backup/restore, see [Sandboxes](./sandboxes.md))                          |
| Workspace inside the container | `/workspace`, repo at `/workspace/repos/project`        | `/workspace/repos/project` is the default `cwd`; the baked platform repo is exposed at `/workspace/repos/github.com/iterate/iterate`         |

Key consequences:

- **The path is the identity.** `itx.sandboxes.get(path)` mints the DO stub from
  `{projectId}:{path}`; same path → same sandbox (and its snapshot lineage).
  There is no separate registry — the DO namespace _is_ the directory.
- **One container class, one image, one config** for every sandbox. Per-class
  settings (`instance_type`, `max_instances`, `ssh`, `authorized_keys`, egress)
  apply to every instance uniformly — see `apps/os/scripts/generate-wrangler-config.ts`.
- Instances do not map 1:1 to anything durable except their DO. Disk is
  ephemeral; identity + the backup handle live in DO storage; the container is
  cattle.

---

## SSH into a running instance

SSH is **enabled** on the sandbox container class (`ssh: { enabled: true }` +
`authorized_keys` in the generated wrangler config). It is account-authenticated
(you need Wrangler **write** access to the container) _and_ gated on your public
key being in `authorized_keys` — and it opens **no public port** (the session
tunnels through Wrangler / the control plane). Docs:
<https://developers.cloudflare.com/containers/ssh/>.

```bash
# From apps/os. Wrap in `doppler run --config <env> --project os --` to target a
# deployed env (prd / preview_N); the Doppler config supplies the CF account.

# 1. Find the container application id and the live instance ids:
doppler run --config prd --project os -- pnpm exec wrangler containers list
doppler run --config prd --project os -- pnpm exec wrangler containers instances <APPLICATION_ID>

# 2. SSH into one instance:
doppler run --config prd --project os -- pnpm exec wrangler containers ssh <INSTANCE_ID>

# Or as a normal ssh/scp client via ProxyCommand (added 2026-05-28):
ssh -o ProxyCommand="pnpm exec wrangler containers ssh %h" cloudchamber@<INSTANCE_ID>
```

Because `authorized_keys` is a **class-level** setting, one key entry makes
**every** sandbox instance reachable — there is no per-instance provisioning.

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
  the SDK's `exec()` (goes through our egress + cwd guards), not SSH.

---

## Environment variables & running a coding agent

Every sandbox carries a durable env-var map — a `Record<string,string>` applied
to every command (`exec`, `startProcess`, …), conventionally ALL_CAPS keys.

**Defaults for code-out-of-the-box:** every sandbox starts with
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY` pointed at conventional project secret
paths (`/secrets/openai-api-key`, `/secrets/anthropic-api-key`) as `getSecret`
placeholders. Seed a provider key at one of those paths and an agent's sandbox
can run Codex immediately — the sandbox DO runs the **warm-up script**
(`sandbox/warmup.sh`, baked into the image at `/opt/iterate/warmup.sh`) **in the
background during provisioning**, memoized per container, which does
`codex login --with-api-key` (reading the env placeholder) so it's ready by the
time the sandbox is used and callers never write a login line (Codex 0.142 won't
use the env key directly). Warm-up completion is a `sandbox/warmed-up` event on
the sandbox's stream (see the lifecycle saga below); add container-side setup by
editing the script, not the DO. Nothing seeded → the var is harmless until a
call actually uses it (egress substitution then fails loudly).

Override or add to the defaults with `configureEnvVars` (explicit config wins):

```ts
await itx.sandbox.configureEnvVars({
  // value is a getSecret placeholder — the material never enters the container
  ANTHROPIC_API_KEY: 'getSecret({ path: "/secrets/anthropic-api-key" })',
  OPENAI_API_KEY: 'getSecret({ path: "/secrets/openai-api-key" })',
});
```

It merges into the stored map (keys are never deleted; set one to `""` to
blank it, which also masks a default), persists it in
Durable Object storage, and re-applies it on every container start (so it
survives sleep/restart). It records a `sandbox/configured` **event** on the
sandbox's stream whose `env` carries the map that was set (key → value). Values
are `getSecret({ path })` placeholders (or non-secret literals), so they're safe
to journal — **never pass raw secret material as a value**, since it would land
on the durable stream.

**The secret never enters the container.** A value like
`getSecret({ path: "…" })` is set verbatim as the env var; when the coding
agent puts it in a request header to the model API, the project egress path
substitutes the real material on the way out (the same
allowlist + substitution used for all sandbox egress — see
[Sandboxes → Egress](./sandboxes.md)). So an agent reads `ANTHROPIC_API_KEY`
from its environment and calls Claude, but the key lives only in the secret
system. The secret at that path must allow the provider host (e.g.
`api.anthropic.com` / `api.openai.com`) in its egress allowlist.

**The coding agent** is baked into our own image (`sandbox/Dockerfile`), not a
Cloudflare image variant (what else the image bakes — `root/`, the platform
monorepo — is [Sandboxes → Deployment](./sandboxes.md#deployment)'s story). We
ship the **Codex CLI** (`codex`, on PATH), which uses `OPENAI_API_KEY`:

```ts
// No login line needed — the warm-up script logs Codex in (reading the
// OPENAI_API_KEY env placeholder) in the background during provisioning. Both
// that login and the model call egress through project policy, which
// substitutes the real key for the placeholder, so `codex exec` uses the
// project's secret without the key ever entering the container.
const r = await itx.sandbox.exec(
  "codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox" +
    ' "summarize README.md in one line"', // defaults to gpt-5.5/high
);
```

Why baked, not the `-opencode` variant or a runtime install: OpenCode's `run`
does a ~45s cold bootstrap per call, and installing an agent at container start
is slow AND unreliable (the sandbox's egress is intercepted + HTTPS-MITM'd, so
`npm`/installer downloads hang or fail at runtime). At **build** time the
network is clean, so baking is faster (zero per-run install) and reliable. Cost
is real but minimal: `@openai/codex` is a single ~280MB statically-linked Rust
binary (npm pulls linux-x64 only — nothing to trim), pulled once per instance
and cached in Cloudflare's registry.

Claude Code is **not baked yet** (it adds another ~240MB self-contained binary,
and we have no Anthropic key wired to exercise it). Add it the same way — a
`RUN curl -fsSL https://claude.ai/install.sh | bash` line (its native installer,
symlinked onto PATH) — when there's an Anthropic key in the secret system. There
is no first-party `-claude`/`-codex` Cloudflare image variant.

---

## Public URLs for sandbox services (quick tunnels)

To reach a server running inside a sandbox from the public internet, use a
**quick tunnel**:

```ts
await itx.sandbox.startProcess("bun server.ts"); // something listening on :8080
const { url } = await itx.sandbox.tunnels.get(8080); // https://<random>.trycloudflare.com
```

It runs `cloudflared` in the container and returns a random
`*.trycloudflare.com` URL. Requires `SANDBOX_TRANSPORT=rpc` (we set it). The
URL is publicly reachable, and cloudflared's outbound connection works through
our egress interception. The URL is
**ephemeral** — it changes on container restart — so fetch it fresh each
session; `tunnels.destroy(port)` closes it. Docs:
<https://developers.cloudflare.com/sandbox/api/tunnels/>.

**We deliberately do NOT use named tunnels** (`tunnels.get(port, { name })`),
even though they'd give a stable `<name>.<zone>` hostname. A named tunnel makes
the SDK **write a proxied CNAME into our DNS at runtime** (`POST
/zones/:id/dns_records` → `<tunnelId>.cfargotunnel.com`) and needs a
`CLOUDFLARE_API_TOKEN` with **Zone:DNS:Edit** reachable from the sandbox flow —
a far larger blast radius than our posture (sandboxes hold no credentials;
secrets inject only at egress). If we ever want stable per-project hostnames
like `x--y.iterate.app`, we'll provision the tunnel + DNS **ourselves**
server-side with a scoped token that never enters a sandbox, and run
`cloudflared` against the pre-created tunnel — our own machinery, not the SDK's
DNS writes.

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
  feature of the Containers app, not a wrangler config key.
- **`labels`** — the sandbox DO sets `{ app: "iterate-os", component: "sandbox" }`
  so instances are filterable in Containers analytics.
- **Lifecycle as stream events** — our own addition, not Cloudflare's: every
  sandbox appends its whole start → provision → warm-up saga to the stream at
  its own path — `container-started` → (`workspace-restored` | `workspace-cloned`)
  → `warmed-up` (or `warmup-failed`) → … → `backup-created` / `backup-failed` →
  `container-stopped` (see [Sandboxes](./sandboxes.md#lifecycle-hooks--stream-events)).
  For an agent's sandbox that is the agent's own journal.

Docs: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>,
container FAQ <https://developers.cloudflare.com/containers/faq/>.

---

## Feature inventory — adopted, available, avoid

### Adopted

| Feature                                              | Where                                                      | First-party docs                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Backup / restore (workspace persistence)             | `CloudflareSandboxDurableObject`                           | [api/backups](https://developers.cloudflare.com/sandbox/api/backups/)                                          |
| Outbound egress control (project policy + MITM)      | `outbound` handler, `interceptHttps`                       | [guides/outbound-traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)                  |
| Git checkout per sandbox                             | `#cloneProjectRepo`                                        | [guides/git-workflows](https://developers.cloudflare.com/sandbox/guides/git-workflows/)                        |
| Idle → **destroy** (not stop) to free instance slots | `onActivityExpired`                                        | [platform-details/scaling](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/) |
| SSH into instances                                   | `ssh` + `authorized_keys` in `generate-wrangler-config.ts` | [containers/ssh](https://developers.cloudflare.com/containers/ssh/)                                            |
| Instance labels                                      | `CloudflareSandboxDurableObject.labels`                    | [containers metrics]                                                                                           |

### Available and worth reaching for (not wired yet)

- **Code interpreter** — stateful Python/JS with rich outputs (matplotlib PNGs,
  DataFrame HTML): `createCodeContext` / `runCode` / `runCodeStream`.
  [api/interpreter](https://developers.cloudflare.com/sandbox/api/interpreter/).
  A natural fit for agent "run this analysis" without shelling out.
- **Sessions** — isolate shell state / env / cwd per workflow:
  `createSession` / `getSession`. [api/sessions](https://developers.cloudflare.com/sandbox/api/sessions/).
- **Named tunnels** — stable public URL for a service in a sandbox
  (`sandbox.tunnels.get(port, { name })`) — but **deliberately not used as the
  SDK ships it**: it writes DNS at runtime with a broad token (see
  [Public URLs](#public-urls-for-sandbox-services-quick-tunnels)). Only worth
  reaching for via our own server-side provisioning; use quick tunnels until
  that exists. [api/tunnels](https://developers.cloudflare.com/sandbox/api/tunnels/).
- **Interactive terminal in the browser** — PTY over WebSocket via
  `sandbox.terminal(request)` + the shipped `@cloudflare/sandbox/xterm` addon;
  the in-product equivalent of SSH for end users.
  [api/terminal](https://developers.cloudflare.com/sandbox/api/terminal/).
- **File watching** — real-time FS change events (`watch`).
  [api/file-watching](https://developers.cloudflare.com/sandbox/api/file-watching/).
- **Docker-in-Docker** — rootless dind for image builds inside a sandbox (no
  iptables; ephemeral image store).
  [guides/docker-in-docker](https://developers.cloudflare.com/sandbox/guides/docker-in-docker/).
- **Regional / jurisdictional placement** — pin containers to regions /
  compliance boundaries (launched 2026-04-05). Relevant if we ever have data-
  residency requirements. [changelog](https://developers.cloudflare.com/changelog/product/containers/).
- **Rollout controls** — `rollout_step_percentage` / `rollout_active_grace_period`
  in the `containers` block for gradual instance replacement. Low value for our
  ephemeral, idle-destroyed sandboxes (a rollout is just cold boots + re-clone),
  so left at defaults; worth revisiting if sandboxes ever hold long-lived state.
  [platform-details/rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/).

### Deprecated / avoid

- **`exposePort()`** — deprecated in favor of **tunnels** for public URLs. Don't
  add new `exposePort` usage. [concepts/preview-urls](https://developers.cloudflare.com/sandbox/concepts/preview-urls/).
- **HTTP / WebSocket transports** — being removed from Sandbox SDK versions
  released **after 2026-07-09**; the future is the **RPC transport**
  (`SANDBOX_TRANSPORT=rpc`). Our pinned 0.12.3 (2026-07-01) is _before_ the
  cutoff, so we're not broken — **but the next SDK bump past a post-cutoff
  release must move to RPC first.** Tunnels and code-interpreter already require
  RPC. Treat this as the priority migration when upgrading the SDK; verify egress
  interception + backup/restore still work on a preview when flipping.
  [guides/2026-deprecation](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/).
- **Desktop / browser-automation APIs** — removed from the SDK (v0.10.2); use
  Cloudflare Browser Rendering instead.

---

## Instance types, scaling, placement

- **Custom `instance_type`** (`{ vcpu: 0.25, memory_mib: 1024, disk_mb: 8000 }`)
  — not a named tier, because the disk must hold the UNPACKED image: the
  baked-monorepo image is ~3 GB unpacked, over `lite`'s 2 GB. An image bigger
  than the instance disk fails at instance provisioning
  (`ImagePullRequestedDiskSizeToSmall`), NOT at deploy — the push succeeds, the
  rollout wedges the app "degraded", and every sandbox op surfaces
  `transport_disposed` (observed live). If the image grows, grow `disk_mb` with
  it. Billing is while-running (active-CPU since 2025-11-21), so idle-destroyed
  sandboxes keep a large pool cheap.
  [platform-details/limits](https://developers.cloudflare.com/containers/platform-details/limits/).
- **`max_instances`** caps concurrent instances; exceeding it returns HTTP 503.
  Ours is deliberately high (see the comment in `generate-wrangler-config.ts`):
  under e2e churn the platform keeps released slots "assigned" in a warm pool
  that rides at the cap, and start latency grows as it saturates — so the cap
  must exceed a whole marathon's _cumulative_ creations, not the concurrent
  count.
- **No autoscaling yet** — Cloudflare's stated roadmap. Routing is manual
  (`getContainer(name)` for sticky, `getRandom(N)` for stateless pools); we use
  DO-name addressing, so this doesn't affect us.

---

## Operations cheatsheet

```bash
# All from apps/os; wrap in `doppler run --config <env> --project os --` for a deployed env.
pnpm exec wrangler containers list                       # container apps
pnpm exec wrangler containers info <CONTAINER_ID>        # one app's status/config
pnpm exec wrangler containers instances <APPLICATION_ID> # live instances (ids, state, location)
pnpm exec wrangler containers ssh <INSTANCE_ID>          # interactive shell (see SSH section)
pnpm exec wrangler containers delete <CONTAINER_ID>      # tear down an app
pnpm exec wrangler tail                                  # stream logs (container output included)
```

Our own sandbox smoke (proves repo checkout + cwd + egress on a real instance)
lives in [Sandboxes → Local dev](./sandboxes.md#local-dev-orbstack--docker); the R2 bucket for a new env is
created by `pnpm ensure-resources --env <env>`.
