# The kernel today + the two-worker split (2026-07-31)

This started as the two-worker-split assessment; expanded (per Jonas) into a full catch-up: what the
kernel is now, an architecture outline, a code breakdown, what was considered & discarded, and the split
itself. Read §1–§7 for the catch-up + architecture + review answers; §8 is the split itself.

---

## 1. Catch-up — what the kernel is, and what happened recently

**What it is.** `apps/kernel` is a **clean-room, pure-play** (no Node compat) reimplementation of the
iterate model — the "simplest possible version" — living on branch `wip/kernel-wayfinder-2026-07-30`
(NOT main), deployed to a throwaway prd account. Self-host is proven live on `*.shiterate.com`
(Cloudflare Access + email one-time-PIN, no auth.iterate.com), and a separate-account/custom-domain copy
runs in Jonas's personal account on `*.mispwoso.com`. Production `apps/os` is untouched throughout.

**The core idea.** ONE worker that: routes a hostname → a project, optionally verifies who you are at a
**wall** (`auth-wall.ts`), and hands a **confined config worker** (userspace, run via Cloudflare Worker
Loader) a single capability — `env.ITX` — plus one **egress door**. Everything the project touches
(streams, secrets, AI, the outside world) goes through that door. Hosted vs. self-host is **config only**
(`APP_CONFIG`).

**Deployed workers (same bundle, config-only differences):**

| worker            | CF account            | hostnames                                                                                                                 | config (wall · directory)                                        |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `kernel-selfhost` | prd `04b3…`           | `iterate.shiterate.com` (control plane) · `*.shiterate.com` (projects) · `niterate.com`→bob (standing custom-domain demo) | Access + email-OTP · kv                                          |
| `kernel`          | prd `04b3…`           | `*.templestein.iterate2.app` · workers.dev                                                                                | Access + auth.iterate.com · auth                                 |
| `kernel-personal` | **personal `05958…`** | `*.mispwoso.com` · workers.dev                                                                                            | none (wide-open) · kv                                            |
| `kernel-mini-os`  | prd `04b3…`           | `kernel-mini-os.…workers.dev`                                                                                             | — (the dashboard _vessel_, a TanStack Start app; not the kernel) |
| `kernel-dev`      | local only            | `*.localhost:<port>` (`pnpm dev`)                                                                                         | none · kv                                                        |

**Recent sequence (all built + proven live, each committed):**

- **Routing table** — hostname→project via config + KV, before the `<slug>.<hostBase>` convention.
- **`/mcp`** — control-plane MCP surface, sibling to `/api` (list/create/reach projects). Now on the
  official `@modelcontextprotocol/server` library (proven via the MCP Inspector CLI _and_ the Claude CLI).
- **egress + secrets** — `itx.secrets` write + placeholder substitution at the egress door (the apps/os
  `getSecret("…")` model): the project door substitutes the project's own secrets; the control-plane door
  substitutes first-party/"platform" secrets (origin-pinned + metered).
- **streams** — a durable-log Durable Object on the **canonical apps/os contract** (`StreamEventInput` →
  offset + idempotency + ephemeral; delivery spine stubbed).
- **ai** — AI as a per-capability-sourced capability (local `env.AI` vs a metered remote). Finding:
  _remote-sourcing a capability == egress through the control plane with a first-party key_ — so
  per-capability sourcing and first-party metered secrets are **one mechanism**.
- **script exec + dynamic capabilities** — MCP `run_script`/`provide`/`invoke`, confined via the loader
  (the apps/os `exec_typescript` model).
- **thermonuclear reviews (3 adversarial agents)** → **fixed a critical live hole** (anonymous callers
  could run code in any project on non-`auth` deployments — now gated).
- **D-C · D-B · D-A · security · reserved-host** — see §4 for full subsections (options, problem, code).
- **two-worker split, step 1** — named the runner interface in-worker (§5+).

~55 tests green throughout; typecheck clean; nothing merged.

---

## 2. Architecture outline (current — one worker, two logical parts)

```
                    Cloudflare edge (one Worker: kernel-selfhost / kernel / kernel-personal)
  request ─────────────────────────────────────────────────────────────────────────────────┐
     │  default.fetch(request, env, ctx)                                                     │
     │   1. appConfigFrom(env)          — parse APP_CONFIG (the one knob)                     │
     │   2. /mcp        → handleMcp     ── CONTROL PLANE (MCP protocol adapter)               │
     │   3. ingress     → routingFor().lookup(host)  ?? resolveIngress(<slug>.<hostBase>)     │
     │   4. /api        → newWorkersRpcResponse(Os)  ── CONTROL PLANE (capnweb front desk)    │
     │   5. dashboard-- → serveDashboard (reverse-proxy to the vessel)                        │
     │   6. else        → dialRunner(ctx).serve(...)  ─────────────┐                          │
     └────────────────────────────────────────────────────────────┼──────────────────────────┘
   CONTROL-PLANE part                                              │  PROJECT-RUNNER part
   · auth-wall.ts   verify injected JWT (or wide open)             ▼
   · directory.ts   which projects + membership (open/kv/auth)   class ProjectRunner (WorkerEntrypoint)
   · routing.ts     hostname → project (config + KV)               · serve()     load+serve config worker
   · classes Os→Session→ProjectCollection (the /api tree,          · runScript() exec, confined
     wall+directory gate)                                          └── mints ProjectEntrypoint (loopback)
   · handleMcp()    MCP tools over the directory + scripting            │
   · serveDashboard() reverse-proxy the dashboard vessel               ▼
                                                              ProjectEntrypoint (WorkerEntrypoint)
   the capnweb Project and ProjectEntrypoint BOTH expose ───────▶ · whoami · fetch (THE egress door)
   the SAME ProjectCapabilities tree (D-A):                       · streams / secrets / ai  (getters)
       project.streams.get(path).append()/.read()                       │  (→ capabilities.ts)
       project.secrets.set()                                            ▼
       project.ai.run()                                          config worker (userspace, confined):
                                                                  sees ONLY { env.ITX } + globalOutbound
   Durable Objects (runner-owned): STREAM_DO (the durable log)   = the ITX tree + the one egress door
   KV: DIRECTORY_KV · ROUTING_KV · SECRETS_KV (+ meter counters)
```

**The two logical parts** (one physical worker today; the split peels the CP off):

- **Control plane** — knows _many_ projects: ingress, wall, directory, routing, `/api` front, `/mcp`,
  the egress door's control-plane half, dashboard proxy. Holds no project data (and, as a hard goal, no customer data at all — §7 / the split §8).
- **Project runner** — knows _one_ project at a time: `ProjectRunner` (serve + runScript), the
  `ProjectEntrypoint` (the ITX face + the egress door), the Durable Objects, and the capability tree.

**Deployment archetypes** (all the same worker, config-only): iterate-hosted (loopback) · project worker
in your CF account (capnweb) · project worker on your box (capnweb + tunnel) · self-host (you run the CP
too, loopback). See `topologies-and-axes.md`.

---

## 3. The auth path — how `itx.projects.list()` / `itx.project.get()` know what you can access

**Short answer to "does the wall swap a small JWT for a bigger one?": No.** The wall (`auth-wall.ts`) only
**verifies** the JWT an ingress proxy (Cloudflare Access) injected — it reads identity (`sub` / `email`),
nothing more. It never mints or enlarges a token. "What projects can I reach" is **not** carried in a
JWT — it's resolved, per call, by the **directory**. `itx.projects.list()` / `.get()` are plain ITX/RPC
calls, not tokens.

**The exact code path** (capnweb over `/api`, or the in-worker loopback — same tree):

```
client → /api → Os.authenticate(creds)         kernel.ts  — verifies the wall JWT (or anonymous)
              → Session(caller, directory)      kernel.ts  — identity baked in once
              → session.projects                kernel.ts  — ProjectCollection(caller, directory)
              → .list()  / .get(slug)           kernel.ts  — delegates to ↓
              → directory.list(caller)          directory.ts  ← THE authority (pluggable)
                directory.access(caller, slug)
```

- **Where the code lives:** the tree (`Os`/`Session`/`ProjectCollection`) is `kernel.ts`; the authority is
  `directory.ts`. The caller is `{ credentials: [...] }` — the verified wall JWT decoded for `sub`/`email`.
- **How it knows access — depends on the `directory` provider (config):**
  - `open` — everything reachable (zero-config).
  - `kv` / `local` (single-tenant self-host) — existence only; a project you name exists, no per-user
    membership (you're on your own LAN; that's the model).
  - `auth.iterate.com` (multi-tenant) — the real membership check: `grantsFor(auth, caller)` decodes the
    caller's verified JWT for `custom.sub` (auth's user id, mapped in by Access) or falls back to the
    verified `email`, then calls **`env.AUTH.getUserGrants({userId})`** (or `getUserGrantsByEmail`) over a
    **same-account service binding** to the auth worker. The **auth worker (auth.iterate.com) is the source
    of truth** for which projects/orgs a user has — not a claim in the JWT.

So: the JWT proves _who you are_; the directory (→ the auth worker, in multi-tenant) answers _what you can
reach_, freshly, on every `list`/`get`. No token enlargement, no stale grants baked into a cookie.

**Future `itx.organisations` (or any new authority-backed collection) — same shape, no new token:** add an
`organisations` getter on `Session` returning an `OrganisationCollection` (mirroring `ProjectCollection`),
backed by a new directory method that (for the `auth` provider) calls a new AuthWorker RPC, e.g.
`env.AUTH.getUserOrganizations({userId})`. It reads the same verified caller, asks the same authority. The
pattern is: **`Session.<thing>` → a Collection RpcTarget → the directory → (multi-tenant) an AuthWorker RPC
over the service binding.** Nothing rides in the JWT except identity.

---

## 4. The recent changes explained (problem · options · code)

Written because Jonas wasn't in the room for these. Each: the problem, the options weighed, what was
chosen, and a code sketch.

### D-C — group the iterate-product config under `AppConfig.product`

- **Problem:** which config makes a control plane "the iterate product" (first-party keys, billing,
  integrations) vs. a generic/self-host one? It was scattered (top-level `platformSecrets`), so the
  boundary was a convention, not a thing.
- **Options:** (a) leave it scattered + document; (b) a boolean `isIterateProduct` flag; (c) **group all
  product config under one `product` key**. Chose (c) — the _presence_ of the key IS the boundary.
- **Code:** `AppConfig.product?: { platformSecrets?: PlatformSecret[] }` (grows to hold integrations +
  billing). "Generic control plane" = literally `!cfg.product`. Egress reads `cfg.product?.platformSecrets`.

### D-B — adopt apps/os's canonical stream contract (don't reinvent it)

- **Problem:** the kernel's first stream DO had a made-up shape (`{seq,ts,type,data}`). apps/os's real
  streams have offsets, idempotency, ephemeral, reduce/deliver — building on a fake shape means a rewrite
  at migration.
- **Options:** (a) keep the toy shape; (b) **import the apps/os storage engine** (`StreamEventLog`); (c)
  **import the contract TYPES only** and implement storage. Spiked (b): the engine lives in apps/os (not
  the `iterate` package) and drags `sqlfu` + workspace deps into the pure-play kernel — rejected. Chose
  (c): `import type { StreamEventInput, StreamEvent } from "iterate/processors"` (type-only ⇒ zero runtime
  dep) and ~140 lines of SQLite storage against it.
- **Code:** `append(input: StreamEventInput): StreamEvent` with `offset` (SQLite autoincrement, eviction-
  safe via `sqlite_sequence`), `idempotencyKey` UNIQUE (re-append returns the committed event), `ephemeral`,
  ISO `createdAt`. Delivery spine (subscription cursors, reduce/fold, offset-CAS) **stubbed** — the
  _interface_ is real, only _delivery_ is deferred, so the future migration is a drop-in.

### D-A — unify the two project surfaces into one capability tree

- **Problem:** there were TWO disjoint surfaces — the capnweb `Project` (only `create`/`mapHostname`) and a
  flat `ProjectEntrypoint` (`streamAppend`/`aiRun`/`setSecret`…). The promised nested tree was never built;
  the two didn't even overlap.
- **Options:** (a) keep both + a hand-maintained mirror; (b) **one nested `RpcTarget` tree** shared by both
  doors. Chose (b) — capnweb's `RpcTarget` IS `cloudflare:workers`', so one class tree serves both
  transports (promise-pipelined over the loopback).
- **Code:** `capabilities.ts` `ProjectCapabilities` with getters `streams` / `secrets` / `ai`. Both the
  capnweb `Project` and the loopback `ProjectEntrypoint` expose it. `ProjectEntrypoint` shrank to
  `whoami` + the egress-door `fetch` + those getters. Userspace now writes
  `env.ITX.streams.get(path).append(input)` / `.secrets.set()` / `.ai.run()`.

### Security follow-ups (from the thermonuclear reviews)

- **Root cause (Jonas, review):** the _real_ bug was ingress — `/api` and `/mcp` were shadowed on EVERY
  hostname routing to the worker, including project public hosts. That's what let an anonymous internet
  caller reach `/mcp` (→ `run_script`/`create_project`) on a host Cloudflare Access doesn't front. **Fixed
  structurally: `/api` + `/mcp` answer ONLY on the control-plane host** (`onControlPlaneHost` in
  `kernel.ts`); on a project host they're just paths the config worker serves. Proven live
  (`iterate.shiterate.com/mcp` works; `alice.shiterate.com/mcp` reaches the project, not the MCP server).
- **Defense-in-depth (belt-and-suspenders now, not the only line):** `scriptingAllowed({ walled,
authenticated })` still withholds the scripting façade + `create_project` for a walled+anonymous caller
  (in case a CP host is misconfigured without Access in front). Plus **optional** `allowedOrigins` on
  project secrets (opt-in origin-pin) and `redirect:"manual"` at the egress door (a pinned origin can't 302
  a secret away).
- **Code:** the host gate in `kernel.ts`; `scriptingAllowed(...)`; `secrets.set(name, value, allowedOrigins?)`.

### Reserved control-plane host (ADR 0031) — one hostname for self-host

- **Problem:** every subdomain was interpreted as a project slug, so the control-plane console + a
  custom-domain scheme seemed to need extra domains.
- **Options:** (a) a second domain for the console; (b) **a reserved control-plane host** resolved before
  the slug convention. Chose (b).
- **Code:** `AppConfig.controlPlaneHost` (e.g. `iterate.shiterate.com`) → served as the console, not a
  project; `/api`+`/mcp` are host-agnostic so they answer there too. Custom domains: a route on a custom
  apex (`bob.com`→bob) also serves `docs.bob.com` as bob's `docs` app (one level). Proven live via worker
  routes + the KV table (`niterate.com`→bob). From the worker's view, self-host worker-routes and
  iterate-hosted Cloudflare-for-SaaS look identical — same `Host → {projectId, app}` lookup.

---

## 5. Code breakdown (apps/kernel, LOC; ~30–40% is explanatory comment)

| component                | file                     |        LOC | what it is                                                                                                                                               |
| ------------------------ | ------------------------ | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **kernel**               | `kernel.ts`              |    **695** | the router + capnweb tree (Os→Session→ProjectCollection→Project) + `ProjectEntrypoint` + `ProjectRunner` + `dialRunner` + `handleMcp` + `serveDashboard` |
| MCP                      | `mcp.ts`                 |        239 | Streamable-HTTP JSON-RPC adapter; tools (list/create/get + run/provide/invoke)                                                                           |
| directory                | `directory.ts`           |        213 | which projects exist + membership — open / local / kv / auth.iterate.com providers                                                                       |
| capability tree          | `capabilities.ts`        |        148 | the ONE `ProjectCapabilities` tree (streams/secrets/ai) shared by both doors (D-A)                                                                       |
| stream DO                | `stream-do.ts`           |        142 | durable-log Durable Object; canonical `StreamEventInput` contract (offset + idempotency)                                                                 |
| egress                   | `egress.ts`              |        140 | two-level egress door + secret substitution (project + platform, origin-pinned + metered)                                                                |
| config worker            | `config-worker.ts`       |        121 | the confined userspace payload (a JS string loaded by the Worker Loader)                                                                                 |
| dynamic                  | `dynamic.ts`             |        108 | script execution + dynamic-capability registry + the scripting security gate                                                                             |
| project-app-session      | `project-app-session.ts` |         98 | the narrow, 15-min, per-project on-behalf-of token                                                                                                       |
| routing                  | `routing.ts`             |         69 | hostname→project table (config + KV)                                                                                                                     |
| wall                     | `auth-wall.ts`           |         47 | identity: verify an injected JWT, or wide-open                                                                                                           |
| **src total (non-test)** |                          | **~2,020** |                                                                                                                                                          |
| tests                    | `*.test.ts` × 6          |       ~670 | unit + a real-workerd e2e (`kernel.e2e.test.ts`, 221)                                                                                                    |
| dashboard vessel         | `mini-apps/os/**`        |       ~274 | the separately-deployed dashboard app (a TanStack Start remote app)                                                                                      |

**`kernel.ts` internal split** (the 695): config/auth helpers ~175 · ingress+hash ~45 · the capnweb tree
(Project/Collection/Session/Os) ~150 · `ProjectEntrypoint` ~50 · `ProjectRunner` ~57 · `dialRunner` ~8 ·
the fetch router ~48 · `handleMcp` ~78 · `serveDashboard` ~45. (Splitting `kernel.ts` into
`control-plane.ts` + `runner.ts` files is the natural next tidy-up — see §5 step 2.)

_Context:_ apps/os's equivalent surface is `rpc-targets.ts` alone at **7,667 LOC** (+ the domains it pulls
in). The whole clean-room kernel is ~2,000 — the simplification is real, not cosmetic.

---

## 6. Considered and discarded (the forks that shaped this)

- **One identical bundle + a `role` knob** (control-plane/runner/both) — _discarded._ Byte-identical only
  helps frequently-invoked workers; some workers are necessarily large (ESBuild-in-a-worker), and the
  Cloudflare-idiomatic shape is SOA. So it's _many small workers, identical per-worker_, not one bundle.
- **Import apps/os's `StreamDurableObject` / `StreamEventLog` engine** — _discarded._ The class is welded
  to `rpc-targets.ts` (7,667 LOC) and the engine drags `sqlfu` + the `iterate` workspace package into the
  dependency-free pure-play kernel. **Kept the contract, dropped the engine:** import the canonical
  `StreamEventInput`/`StreamEvent` _types_ (type-only, zero runtime) and implement ~140 lines of storage.
- **Split the RUNNER off into its own worker** — _discarded as impossible._ The confined config worker's
  `env.ITX` is a **loopback** (`ctx.exports`), which is **same-worker-only**. So the loader + entrypoint +
  config-worker-serving are necessarily ONE worker (the runner). Only the _control plane_ can peel off.
- **A big-bang two-worker split now** — _discarded (risk)._ Traded proven single-worker coherence for a
  half-tested cross-worker RPC surface at the end of an autonomous run. Did the **named-interface seam**
  (step 1) instead, which de-risks the real split to a one-line binding swap.
- **`/mcp` (and `/api`) as paths shadowed on EVERY hostname** — _discarded (review)._ They're
  **control-plane** surfaces; shadowing them on project hosts was the root of the anonymous-`/mcp` hole.
  Now served ONLY on the control-plane host; on a project host they're plain userspace paths.
- **Fold secrets + capabilities + the meter into the stream DO** ("everything is the log", D-D) —
  _deferred, not discarded._ Powerful (the meter becomes "count of egress events", the racy KV meter
  vanishes) but a bigger bet; parked at Jonas's instruction.
- **Origin-pin ALL project secrets by default** — _discarded._ Breaks the common case (a project sending
  its own key to its own API). Made it **opt-in** (`allowedOrigins`); the auth gate already stops the
  cross-tenant attack.

---

## 7. Review answers + open design questions

Answers to Jonas's doc-review questions, plus two things they surfaced (the iterate-product-as-a-worker
design, and a verified constraint on dynamic capabilities).

### `ai` is not really like `streams`/`secrets` — it's an ENV binding, which is a form of platform secret

Agreed with your framing. `streams` and `secrets` are the project's **own data** (its DOs / its KV rows)
— storage that follows the project. `ai` is different: `env.AI` is a **platform binding** (Workers AI, an
account-level resource). In the sourcing model that's exactly a **first-party/platform secret** — "give me
AI from _somewhere_" — which is why `ai.source: "remote"` collapses into the control-plane egress door
(remote-source == egress + a first-party key). So: `ai` could even be pure userspace (a project brings its
own key and calls an LLM through its own egress) — it's only "interesting" _because_ it's commonly a
platform binding the control plane provides. Storage-shaped (streams/secrets/repos) = the project's;
service-shaped (ai/search/browser) = sourced, often from the platform. That distinction is real and worth
keeping.

### What is `caller`? Could it grow tracing/context?

`caller` is currently `{ credentials: Credential[] }` — the verified identity for this request (the wall
JWT decoded, or a project-app-session, or empty=anonymous). It is **request context**, and yes — it's the
natural home to grow. Adding `traceparent`/`tracestate` (W3C trace context), a request id, or a "call
colour"/tenant tag would live right here and ride the same path the caller already rides (stamped as
`x-iterate-*` headers to the config worker; carried in the capnweb session). Recommend keeping it a small
typed context object (`{ credentials, trace?, requestId? }`) rather than smuggling these into the JWT.

### Sidebar: what is `sub`? (OAuth/OIDC)

`sub` = "subject" — the **stable unique id of the authenticated user** inside a JWT (OIDC standard claim).
When Cloudflare Access fronts a request, it injects a JWT whose `sub` is **Cloudflare's** user id (not
auth.iterate.com's). Access can also copy custom claims from the upstream IdP into a `custom` object — we
map auth.iterate.com's own user id into `custom.sub`. So the kernel prefers `custom.sub` (auth's id) and
falls back to the verified `email`. `sub` is just "who you are, stably"; `email` is the human-readable
fallback. Neither says anything about _what you can access_ — that's the directory's job (§3).

### How does `directory` get injected into `Session(caller, directory)`? And how does Access+auth interact?

`directory` is built per request by **`directoryFor(cfg, env)`** (in `directory.ts`) from `APP_CONFIG`'s
`directory.provider` — `open` / `local` / `kv` / `auth.iterate.com`. `Os.authenticate()` calls
`directoryFor(cfg, env)` and hands the result to `Session`. So the authority is **pluggable via config**:
flip `directory.provider` and the same `session.projects.list()` code resolves against a different backend.

The Access + auth.iterate.com interaction, concretely (the hosted/`auth` provider):

1. A browser hits `iterate.…com`; **Cloudflare Access** intercepts, runs the login against **auth.iterate.com
   as the IdP** (OIDC), and on success injects a signed `Cf-Access-Jwt-Assertion` header.
2. The kernel's wall (`auth-wall.ts`) **verifies** that JWT against Access's public keys (JWKS) + audience.
   It reads identity (`custom.sub` = auth's user id, or `email`). It does NOT enlarge the token.
3. `session.projects.list()` → `directory.access/list(caller)` → (auth provider) `grantsFor(auth, caller)`
   → **`env.AUTH.getUserGrants({ userId })`** over a same-account service binding to the auth worker.
   **auth.iterate.com is the source of truth** for which projects/orgs that user has.
   So the Access JWT is used only to _identify_ you; the kernel then _asks_ auth (via the service binding)
   what you can reach. The two are separate: Access = "who are you" (front door), auth worker = "what do you
   have" (directory authority).

> **Caveat — don't front iterate-hosted-at-scale with Cloudflare Access.** Access is priced/modeled for a
> **bounded, admin-curated population** (Zero Trust seats; allow-lists of email domains/groups) — great for
> a self-hosting company's own team, wrong for a public product with thousands of self-serve users (per-seat
> cost, no consumer signup flow). Because the wall is **pluggable** ("wall or nothing"), this is a
> wall-_choice_ fix, not an architecture change: **iterate-hosted → the wall is auth.iterate.com issuing its
> own JWT** (consumer auth, self-serve, no per-seat cost), which the kernel verifies exactly the same way;
> **self-host (bounded team) → Access/OIDC proxy is fine**; **wide-open → no wall.** One open item before
> committing the hosted swap: the MCP machine/agent auth lane was proven via Access's Managed-OAuth-for-MCP,
> so hosted needs an equivalent MCP-OAuth path through auth.iterate.com. _(Flagged from a review; verify.)_

### The iterate-product as a SEPARATE worker (you asked me to explore this)

Today the product layer is config (`AppConfig.product.platformSecrets`). You proposed making it a separate
worker the control plane binds — `env.PRODUCT`. Here's the design (from a focused exploration):

- **The binding:** one optional `env.PRODUCT` service binding on the control plane. Absent ⇒ generic/self-
  host; present ⇒ the iterate hosted product. It's **bidirectional but narrow** (only two edges cross):
  - **Outbound (product → CP → project):** the egress door's secret resolver already takes a
    `resolve(scope, name, origin) → value|null` callback (`egress.ts`). The product worker just _becomes
    that resolver_: `env.PRODUCT.egressSecret(name, origin)` (origin-pin + the key vault move behind the
    binding). `itx.ai`'s `remote` source is the same call — remote-sourcing a capability == egress + a
    first-party key. Self-host (no `PRODUCT`) ⇒ `ai` falls back to `local`.
  - **Inbound (internet → product → CP):** the product worker owns the Slack/GitHub OAuth apps + webhook
    URLs (first-party secrets that never touch the CP). It verifies the webhook, maps it to a `projectId`,
    and calls **into** the CP with the **born project-secret key** (the per-project API key a remote app
    already uses) — e.g. `env.CONTROL_PLANE.deliver(projectId, bornKey, event)`. So the product needs its
    own back-binding to the CP.
- **Sidecar, not a front.** You noted it "almost wraps the control plane again." Two models: (a) **sidecar**
  — product sits beside the CP, CP calls out for capabilities, product calls back in for webhooks; (b)
  **front** — all ingress lands on product which decorates + forwards. **Recommend sidecar** — the
  bidirectionality is real but _narrow_ (one resolver callback out, one `deliver` call in); a front would
  route the 99% of traffic that touches no first-party thing through the product for nothing, re-growing the
  fat front the split dissolves. Trade-off: the born-key auth on `deliver` must be rock-solid (product is now
  an authenticated CP client).
- **The payoff you wanted:** "the main difference is a single config setting pointing at a worker binding."
  Exactly — deploy iterate-hosted _with_ `env.PRODUCT`; deploy self-host _without_ it. Same generic CP.
- **This lines up with the two-worker split:** the product worker is the _third_ worker (CP · runner ·
  product); "many small workers" (your point in §8-review below) is where this is all heading anyway.

### VERIFIED constraint: `env.ITX.<dynamic>` does NOT work — dynamic capabilities need an explicit accessor

You flagged: "we'll have dynamic capabilities from Durable Objects, and you can't call `env.iterate.<random
method that doesn't exist>` — verify whether a WorkerEntrypoint can return a proxy." **Spiked it on real
workerd. Result:**

- `env.ITX.whoami()` (declared method) ✅ · `env.ITX.streams.get(...)` (declared getter → nested) ✅
- **`env.ITX.banana()` (undeclared) ❌ →** _"The RPC receiver does not implement the method 'banana'."_ A
  returned Proxy does **not** help — the workers-RPC / capnweb layer enumerates declared methods; there is
  no catch-all across the RPC boundary.
- **Requirement, therefore:** dynamic capabilities (provided by a project's DO at runtime) MUST be reached
  via an **explicit** accessor — `env.ITX.invoke("banana", args)` (or `env.ITX.capability("banana")`) — a
  _declared_ method that takes the capability name as data. This mirrors apps/os's
  `invokeCapability(path, args)` + `resolveLongestPrefix`. **You cannot do `env.ITX.banana`.** (This makes
  the D-A getter tree a _fixed_ builtin surface — `streams`/`secrets`/`ai` — with dynamic capabilities
  hanging off an `invoke`/`capability` method, NOT off arbitrary property names. The current
  `provide/invokeCapability` at the MCP layer already follows this; userspace-facing `env.ITX.invoke` is the
  piece to add when userspace needs dynamic caps.)

### D-B streams — "fine for now, but eventually import & use the SAME stream" (noted)

Agreed and recorded. The current native stream DO uses the canonical _contract_ but a fresh _implementation_.
The end state is importing and running apps/os's actual `StreamDurableObject` (processors, delivery spine,
obligations). That likely means **relaxing the no-node-compat rule** for the runner worker (the engine pulls
`sqlfu` + workspace deps). Since the runner is a separate worker (the split), it can carry node-compat while
the control plane stays pure-play. Parked until the streams re-implementation has budget.

---

## 8. The two-worker split

## ✅ STEP 1 DONE + PROVEN LIVE (2026-07-31) — the runner interface is named in-worker

Implemented `ProjectRunner extends WorkerEntrypoint<Env>` with `serve(request, projectId, app,
callerHeader)` + `runScript(projectId, code, args)` — the two operations coupled to `ctx.exports` +
`env.LOADER`. The control plane now reaches it through **`dialRunner(ctx)`** — the ONE chokepoint ("the
dial"): today `ctx.exports.ProjectRunner({})` (co-located loopback); in step 2 the ONLY line that changes
(→ `env.RUNNER` service binding, or a capnweb-dialed remote stub). No behavior change.

**The load-bearing experiment PASSED:** `this.ctx.exports.ProjectEntrypoint({props})` **works inside a
`WorkerEntrypoint`** — the runner mints its own per-project ITX loopback. (This was THE unknown; it's why
exec was kept at the kernel level overnight.) In step 2 the runner worker mints its OWN `ProjectEntrypoint`
export the same way, so the physical split is now a **binding swap at `dialRunner`**, not a rewrite.

Two calling-convention facts discovered: (1) `ctx.exports.<Entrypoint>(options)` requires an Options object
even with no props — pass `{}`. (2) Passing a `Request` and returning a `Response` across the loopback stub
works (workers-RPC / the capnweb fork pass Request/Response by value).

**Proven LIVE** on `kernel-selfhost` (`split1.shiterate.com`): public site + confinement
(`seenBindings:["ITX"]`), streams (offset 1), egress (X-Project + X-Platform), ai ("Blue") — all served
_through_ `ProjectRunner.serve`. runScript-via-runner covered by the wide-open e2e (scripting is auth-gated
on walled selfhost). 48 tests green, typecheck clean, prod untouched.

**Remaining runner interface method for step 2:** `capabilities(projectId) → ProjectCapabilities` (the
`/api` tree access) — today the capnweb `Project` builds `ProjectCapabilities` inline from `env` (no
`ctx.exports`/loader), so it's not the hard part; in step 2, when the runner owns the DO/KV/AI env,
`Project.#caps()` calls `runner.capabilities(projectId)` instead. Noted, not needed for step 1.

---

## Original assessment (below) — the plan step 1 just started executing

## What the split is (ADR 0017)

Peel the **control plane** (ingress · wall · directory · routing · `/api` front · `/mcp` · dashboard
proxy · webhook ingress) off from the **project runner** (the `ProjectWorkerEntrypoint` + `env.LOADER`

- the DOs + serving the confined config worker + the `ProjectCapabilities` tree).

## What the split actually BUYS us (Jonas: "I need to understand this — it adds self-host complexity")

Fair — for a self-hoster, two workers is marginally more to deploy than one. Honest accounting:

**It's already inevitable for other reasons.** We want **many small workers** (SOA) regardless: the dynamic
worker builder (ESBuild-in-a-worker) is huge and must be its own worker; the iterate-product layer wants to
be its own worker (§7); AI/sandbox/browser capabilities are separate. So "one monolith" was never the end
state — the CP/runner split is one instance of a decomposition that's happening anyway. Given that, the
question isn't "one vs two" but "where are the seams" — and CP/runner is a clean one.

**What it buys (in rough priority):**

1. **Cross-account / BYO-Cloudflare-account** — the whole self-hosting lattice. The CP (ours) reaches a
   runner in _your_ account over capnweb. Impossible in one worker (loopback is same-account). This is the
   product reason.
2. **A truly data-free control plane** (#4 below) — if the CP holds no customer data, a customer can bring
   their own account for the runner and iterate never stores their bytes. The split is what makes "CP holds
   only metadata" enforceable rather than aspirational.
3. **A stable runner API** (#4 below) — once the runner is reached over a defined RPC/HTTP contract, anyone
   (even a Rust reimplementation) can build a project runner that plugs into our control plane.
4. **Independent scaling/deploy/isolation** — the runner (heavy: loader, DOs, AI) scales and fails
   independently of the thin CP.

**What it costs:** one more worker + one binding to configure; a defined CP↔runner interface (which we get
for free-ish because D-A already made the capability tree one serializable `RpcTarget`). For a single-box
self-hoster who wants _simple_, the "collapsed" mode (CP+runner co-located, one deploy) stays available —
the split is about _enabling_ the distributed modes, not _forcing_ them.

## Can the control plane hold TRULY no customer data? And could a Rust runner plug in? (#4)

**Goal (Jonas): the CP holds only metadata — not Slack/GitHub webhook bodies, not project data — so people
can bring their own Cloudflare account and iterate never stores their bytes.** This is achievable and worth
making a hard rule:

- **Project data** (streams, secrets, repos, files) already lives in the _runner's_ DOs/KV — move the runner
  to the customer's account and their data is in their account, full stop.
- **Webhook bodies** (the one leak): today first-party webhook ingress would land on the CP. The fix is the
  **product worker** (§7) owns webhook ingress and **immediately forwards** the body to the runner (via
  `deliver(projectId, bornKey, event)`) — the CP/product retains only _routing metadata_ (which
  installation → which project), never the payload, or at most a short-TTL buffer. **Rule: the control
  plane persists routing tables + directory rows + nothing customer-shaped.** (This is ADR 0006/R7 —
  "iterate is the HTTP edge, never the store" — made concrete.)

**The project-runner API contract (so a Rust/anything reimplementation can plug in):** the runner is
whatever answers this interface behind the CP — the CP doesn't care what language/runtime implements it,
only that it speaks the contract. Two options:

- **Option A — Workers-RPC / capnweb (same-account or cross-account):** the runner is a WorkerEntrypoint (or
  a capnweb endpoint) exposing:
  - `serve(request, projectId, app, caller) → Response` — HTTP for a project's app (loads/runs userspace).
  - `authenticate(props) → ProjectCapabilities` — the ITX tree (streams/secrets/ai/…) as an RPC stub.
  - `runScript(projectId, code, args) → result` — ad-hoc exec.
    A non-JS runner can't be a _loopback_ WorkerEntrypoint, but it CAN be a capnweb endpoint over WebSocket —
    which is exactly the cross-account transport. So **a Rust runner exposes a capnweb server implementing
    `serve`/`authenticate`/`runScript`**, and the CP dials it identically to a JS runner in another account.
- **Option B — plain HTTP + a narrow JSON contract** (if capnweb-in-Rust is too much): the runner is any
  HTTPS service the CP forwards to, with a small header/JSON protocol for `serve` (the CP proxies the
  request + stamps the caller) and a JSON-RPC surface for the ITX capabilities. Less elegant (no capability
  stubs / pipelining) but language-agnostic and dead simple.

**Recommendation:** define the contract as **capnweb (Option A)** — it's the same interface the JS runner
already exposes, so cross-account + BYO-runtime fall out of one definition; offer the **HTTP/JSON subset
(Option B)** as the "I don't want to implement capnweb" fallback. Either way, the requirement to state
plainly: **the project runner is defined by an INTERFACE, not an implementation — anyone can build one that
runs behind our control plane, and the control plane holds no customer data.**

## The hard constraint that shapes everything (verified in code)

The confined config worker is loaded with `env.ITX` + `globalOutbound` bound to a **loopback**
`ProjectEntrypoint` minted via `ctx.exports.ProjectEntrypoint({props})` (`kernel.ts:490-502`). **Loopback
bindings are same-worker only.** Therefore the loader + the `ProjectEntrypoint` + serving the config
worker **must stay in ONE worker** — that worker IS the runner. The CP cannot load a config worker whose
`env.ITX` loopbacks into a _different_ worker.

So the split is asymmetric: the **runner is necessarily one worker**; the **control plane peels off** and
reaches the runner over a binding.

## What binds CP→runner today (the three in-worker couplings, all via `ctx.exports`/`env.LOADER`)

1. **Serving the config worker** — `makeEntry(ctx.exports) → env.LOADER.get(...) → fetch` (`:488-513`).
2. **The `/api` capnweb tree** — `new Os(...)` → `ProjectCapabilities` reads `env.STREAM_DO`/`SECRETS_KV`/
   `AI` directly, in-worker (`capabilities.ts`).
3. **`/mcp` scripting** — `ctx.exports.ProjectEntrypoint` + `env.LOADER` for `run_script`/exec (`:557-564`).

## What the split therefore REQUIRES (the real work)

The runner must expose a **`ProjectWorkerEntrypoint`** (WorkerEntrypoint) the CP calls over a service
binding (same account) or capnweb (cross-account):

- `serve(projectId, app, request, publishedCaller) → Response` — loads + serves the confined config worker.
- `authenticate(props) → <the ProjectCapabilities tree>` — for `/api` and `/mcp` scripting, returned as an
  RPC stub (the tree is already `RpcTarget`s — this is why D-A mattered: one tree, serializable over RPC).
- `runScript(projectId, code, args) → result` — exec stays runner-side (needs the loader).
  The CP's fetch handler then: resolve ingress + wall + routing (CP-local) → for project-scoped work, call
  `env.RUNNER.serve(...)` / `.authenticate(...)`. This is a genuine new cross-worker RPC surface with new
  failure modes (tree-stub lifetime across the binding, serve streaming, error propagation).

## Why NOT an autonomous big-bang now

- **Primary motivation already handled:** the security reason to wall `/mcp` at a separate host is closed
  in code (the `writeAllowed`/`scriptingAllowed` gate — walled+anonymous refused, proven live).
- **The real payoff is cross-account** (the CP dials a _remote_ runner via capnweb — mutual credential,
  pinned session), which is a large multi-step effort well beyond one safe increment.
- **Risk vs. state:** the single worker is coherent and fully proven live (routing, egress, streams, ai,
  mcp, scripting, the unified tree). A big-bang CP↔runner RPC restructure at the end of an autonomous run
  would trade proven coherence for a half-tested new interface. Partial-split-left-half-done would also
  violate the "no speculative indirection / conventions over frameworks" preferences.
- **D-A made the split CHEAPER, not urgent:** the capability tree is now ONE serializable `RpcTarget`
  surface, so `authenticate() → tree` over the binding is a clean handoff when we do split. We bought the
  option; we don't have to exercise it now.

## The deliberate plan (when Jonas is ready — sequenced, each provable)

1. **Name the runner interface** in-worker first: a `ProjectWorkerEntrypoint` (WorkerEntrypoint) with
   `serve()` + `authenticate()` + `runScript()`, still co-located, CP calls it via `ctx.exports` (no
   behavior change — pure seam). Prove parity live. _(This is the one genuinely-safe first step; ~1 focused
   session. I did NOT do it now to avoid leaving a half-seam, but it's the clean starting point.)_
2. **Split the worker:** move `ProjectWorkerEntrypoint` + `env.LOADER` + DOs into `apps/kernel-runner`;
   the CP `env.RUNNER` service-binds it (same account). Ingress/wall/routing/mcp-read stay in the CP.
   Prove: iterate-hosted + self-host still serve, `/api`+`/mcp` work through the binding.
3. **Give `/api`+`/mcp` the CP's own hostname** (not project hosts) — closes the R8 hole at the edge, not
   just in code. Per **ADR 0031**, this is a **reserved host on the SAME base domain** (e.g.
   `iterate.yourdomain.com`) that ingress resolves _before_ the `<slug>` convention — so full self-host
   still burns only ONE hostname (`iterate.` = the console + `/api` + `/mcp`; `<slug>.` = projects).
4. **Cross-account:** the CP dials a _remote_ runner via capnweb (mutual credential + pinned session).
   This is the lattice payoff (ADR 0017 / the "your CF account" + "your box" archetypes).

## Recommendation

Leave the system as the coherent, fully-proven **one worker**. Do the split as step 1→2 in a dedicated
session with live parity proofs at each step. The groundwork (D-A's single serializable tree, the config
`product` boundary, the `dialProject`-shaped couplings all funneling through `ctx.exports`/`env.LOADER`)
is in place, so the split is now a localized change — exactly as intended.
