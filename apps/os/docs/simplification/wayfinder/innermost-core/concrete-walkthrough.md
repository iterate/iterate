# Concrete walkthrough — one project, the fetch middleware chain, and the real bindings floor

The goal of this doc: make the abstract "itx context / path / parent / capability" stuff **concrete** enough
to argue with. One project, real paths, real Cloudflare bindings, and the canonical example — a dynamic
worker calling `fetch` — walked through every level. Then the full inventory: what workers, DOs, dynamic
workers, and env vars actually exist.

Annotate freely — this is a draft to react to.

---

## 1. The scenario

- Project **acme**, id `prj_acme`, hosted by Iterate (topology B: all workers + a product worker).
- Inside it: the project root **`/`**, and an agent at **`/agents/support-bot`**.
- The agent's code runs _in the itx context of `/agents/support-bot`_. **Executing code in a context is the
  capability host's primary job** — the host hands your function an `itx` bound to that path and runs it:

```ts
// The agent is a STRING of source the host loads as a confined dynamic worker (env.LOADER),
// with env.ITX injected. It just calls NORMAL fetch — no itx.fetch, no raw bindings.
async (itx) => {
  await fetch("https://api.stripe.com/v1/charges", {
    method: "POST",
    headers: { Authorization: "Bearer {{secret:stripe}}" }, // a placeholder, not the real key
  });
};
```

> **Why plain `fetch`?** Agents (and any userspace code) just call the normal global `fetch` — that's what
> LLM-written code does by default. In a confined dynamic worker `globalOutbound` is wired to `itx.fetch`, so
> `fetch(...)` **is** `itx.fetch(...)` — same call, same chain. The `itx` param is there for the _other_
> capabilities (`itx.kv`, `itx.streams`, `itx.secrets`); `fetch` just happens to also be mirrored onto the
> global. The worker has **no** raw fetch and **no** raw bindings — only what `itx` resolves.

We follow that one `fetch` all the way to the internet.

### 1a. Executing code in a context — the core primitive (TWO modes)

Every actor is "some code run with an `itx` bound to a path": the agent above, the project's **config
worker**, a **stream processor**, the `/api` request handler (§5b). The capability host supports **two ways**
to run it, both bound to this `{projectId, path}`:

```ts
// 1. LIVE CALLBACK — you hand it a real function object. Runs with itx in scope.
//    For TRUSTED first-party code (the /api handler §5b, an in-repo processor).
host.run(async (itx) => {
  /* … */
});

// 2. DYNAMIC WORKER FROM A STRING — you hand it source text. The host loads it via the
//    Worker Loader (env.LOADER) into a CONFINED isolate whose only binding is env.ITX.
//    For UNTRUSTED userspace code (agent code, the config worker, user-authored processors).
host.load("async (itx) => { await fetch('https://api.stripe.com/…') }");
```

- Mode 2 is what makes the agent's plain `fetch` above safe: the confined worker's `globalOutbound` → `itx.fetch`,
  so untrusted code uses normal `fetch` and still cannot escape the chain or touch a raw binding.
- Both are "running dynamic workers with capability binding" — one of the innermost concepts. There is no
  ambient authority: the code reaches exactly what `itx` resolves, and nothing else.
- **DO naming for these hosts: steal apps/os's `DurableObjectNameCodec` for now** — faux URLs
  `{projectId}.iterate{path}` (§6). Don't reinvent the name scheme yet.

---

## 2. What a "provided capability" (a mount) actually IS — the data structure

A mount entry is one of a small closed set of kinds. **Two are TRUSTED (config-only); the rest are
USERSPACE-mountable.** This split is the whole security story.

```ts
type MountEntry =
  // ── TRUSTED: only the kernel entrypoint sets these, from deployment config. Userspace can NEVER mount these. ──
  | { kind: "env-binding"; binding: "STREAM" | "KV" | "R2" | "AI" | "LOADER" | "ARTIFACTS" } // a raw binding: no props
  | { kind: "loopback-entrypoint"; entrypoint: string; props: object } // ctx.exports.<E>({props}) — prefixes live HERE
  | { kind: "parent"; ref: ParentRef } // the fallthrough parent (see §4)

  // ── USERSPACE: a confined context MAY provide these at its OWN path. Confinement makes them safe. ──
  | { kind: "live"; ref: { conn: string } } // a Pi/browser/dynamic-worker behind the pager
  | { kind: "itx-expression"; expr: CapnwebExpr }; // a recorded expression
```

> **No separate `fetch-middleware` kind.** A userspace fetch interceptor is just a `live` mount at the
> **name** `fetch` whose code calls `itx.parent.fetch(req)` when it wants `next` (§5). Any chain-shaped
> capability works the same way — the middleware _semantics_ come from how the name `fetch` resolves, not
> from a special mount kind. (Env bindings carry no `props`; a raw binding is simply `env.STREAM`.)

Key safety rule (your `itx.kv` prefix worry, resolved):

> **`itx.kv` at `prj_acme` resolves to `{kind:"loopback-entrypoint", entrypoint:"KvEntrypoint", props:{prefix:"prj_acme:"}}`.
> The prefix is set by the kernel entrypoint (§5b) from the DO's OWN projectId (unforgeable — it's the DO
> name), NOT from config. Userspace can only mount `live`/`itx-expression` — it CANNOT mount an
> `env-binding` or `loopback-entrypoint`, so it can never mint a `KvEntrypoint` with a different project's
> prefix.** Prefix isolation is guaranteed by "userspace can't create trusted mounts," not by a runtime check.

---

## 3. The path/parent chain for this project

Each row is an **itx context** = a `{projectId, path}` = its **own** `CapabilityHostDurableObject` (one DO
per path — Jonas: "it's own DO"). Its `parent` is the next row out. `resolve(name)` at any row = **local
mount → constructive default → parent**.

| itx context                      | parent                | notable mounts (who set them)                                                                                           |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `prj_acme` `/agents/support-bot` | `prj_acme` `/`        | `fetch` — a `(userspace)` `live` mount at the name `fetch` (the agent's own interceptor)                                |
| `prj_acme` `/` (project root)    | **the control plane** | `fetch` `(config)`, `secrets` `(config)` — reads the project's own keys, `kv/r2/streams/ai/run` = constructive defaults |
| control-plane context            | **the product**       | `fetch` `(config)` — routing/metering, directory, ingress                                                               |
| product context                  | **terminal**          | `fetch` `(config)` — first-party keys, Slack/GitHub receivers                                                           |
| terminal                         | —                     | the real `globalThis.fetch`; the real `env.*` bindings                                                                  |

**Legend — "who set them":** `(config)` = the trusted kernel entrypoint installed this mount from deployment
config; the middleware _code_ is kernel-provided even when the _data_ it uses is the project's (the `/`
`fetch` middleware is kernel code that reads the project's own `secrets`). `(userspace)` = the running code
mounted it at its own path. Only `(config)` mounts may be `env-binding` / `loopback-entrypoint` / `parent`.

**The parent is itself just a capability** (your instinct): at `/agents/support-bot` the parent is a mount
`{kind:"parent", ref:"/"}`; at `/` the parent is a **config** mount pointing at the control plane —
`{kind:"parent", ref:{via:"service-binding", binding:"CONTROL_PLANE"}}` (same account) — an RPC stub you call
into and check whether the call succeeds. `env.APP_CONFIG.rootParent` decides what `/`'s parent is.

---

## 4. How `/`'s parent (the "backstop") is expressed — from config only

`env.APP_CONFIG` is **ONE config for the WHOLE deployment.** Iterate's hosted deployment is a _single_ worker
with _one_ set of env vars serving _thousands_ of projects — so there is **no `projectId` in here.** It names
the parent and the default-leaf bindings; the projectId is supplied per request (next paragraph).

```jsonc
// env.APP_CONFIG — deployment-wide, IDENTICAL for every project the worker serves:
{
  "rootParent": { "via": "service-binding", "binding": "CONTROL_PLANE" }, // same-account → the control plane
  "defaults": {
    // the constructive-default leaves = REAL bindings (the floor)
    "kv": { "entrypoint": "KvEntrypoint" }, // NB: no prefix here — filled per-DO (below)
    "r2": { "entrypoint": "R2Entrypoint" },
    "streams": { "binding": "STREAM" },
    "ai": { "binding": "AI" },
    "artifacts": { "binding": "ARTIFACTS" },
    "run": { "binding": "LOADER" },
  },
}
```

**So where does `prj_acme` come from?** From the **DO name**, not from config. Routing (§5b) resolves an
incoming request → a projectId, then gets the `CapabilityHostDurableObject` named `{projectId}.iterate/`
(faux-URL DO names, exactly as apps/os does in `durable-object-names.ts`). That DO's _own name_ is the
unforgeable projectId. When `/` mounts `itx.kv`, the kernel fills `KvEntrypoint`'s `prefix` from
`this.projectId` (the DO name) — **never** from static config. One deployment config therefore serves every
project; isolation comes from per-DO identity, not from per-project config.

Swap `rootParent` / `defaults` and the same code runs against a different floor (Miniflare on a Pi, a
different account) — the D11 override story, now literally these two fields. That is the _only_ thing that
differs self-host vs hosted vs BYO.

---

## 5. The `fetch` middleware chain — the canonical example, walked through

`fetch` is **both ingress and egress**, modeled as a **middleware chain along the parent path**. Each
context's `fetch` capability is a middleware: it may HANDLE the request (a hostname meaningful in its context)
or **delegate outward to its parent's `fetch`** (`next`). The ONLY way to actually reach the internet is the
**terminal** fetch (kernel-provided), so every request that egresses passes through every outer middleware —
**metering/first-party keys are unbypassable** (userspace has no raw fetch; its only way out is to delegate
outward).

`next` is literally _"call `fetch` on my parent context"_ — `parentItx.fetch(request)`. The parent is an RPC
stub; you call it and see if it succeeds. Recurses to the terminal.

### The Stripe call, step by step

Agent code (confined, `/agents/support-bot`) → `fetch("https://api.stripe.com/...", {Authorization: "Bearer {{secret:stripe}}"})`.
Its `globalOutbound` is wired to `itx.fetch` at `/agents/support-bot`.

1. **`/agents/support-bot` .fetch** (a userspace `live` mount at the name `fetch`, if the agent registered one): "is
   `api.stripe.com` a hostname I handle? No (I only intercept `tools.internal`)." → **delegate**:
   `parent.fetch(request)`.
2. **`/` (project root) .fetch** (config middleware): sees the `{{secret:stripe}}` placeholder → looks up
   `itx.secrets.get("stripe")` **at `/`** (the project's Stripe key, a `secrets` capability whose default is a
   Secret domain object) → **substitutes** the real key into the header. api.stripe.com isn't project-special
   otherwise → **delegate**: `parent.fetch(request)` (the control plane).
3. **control-plane .fetch** (config middleware): deployment-level concerns — rate-limit, egress allow-list,
   audit. Nothing Stripe-special → **delegate**: `parent.fetch(request)` (the product).
4. **product .fetch** (config middleware): first-party metered keys — _if this were_ `api.exa.ai` it would
   substitute Iterate's Exa key + append a metering event. For Stripe: nothing → **delegate** to the terminal.
5. **terminal .fetch** (kernel): the real `globalThis.fetch("https://api.stripe.com/...")` with the
   now-substituted header → the response streams back down the chain to the agent.

**Secret substitution accretes outward:** the project's own secret at `/`; Iterate's first-party keys at the
product. Each level substitutes what it owns and delegates the rest. Ingress is the same chain in reverse
(product → control-plane → `/` → `/agents/support-bot`'s handler).

### Why this is safe

- Userspace's inner middleware can mock/intercept its OWN outbound, but to actually egress it must delegate
  outward — it has no raw fetch. So it cannot skip metering or exfiltrate around the product layer.
- Each middleware only sees the request as it flows; the terminal (real fetch) is kernel-only.

---

## 5b. Ingress — what happens when an authed browser hits `os.iterate.com/api`

This is the mirror of §5 (egress), and it makes "the kernel entrypoint" concrete. Ingress is `fetch` flowing
**inward** through the shell onion (product → control-plane → `/`), the exact reverse of egress.

1. **Browser → product worker.** `POST os.iterate.com/api` with a session cookie / JWT. In topology B the
   public hostname terminates at the **product** worker (the outermost shell). Its `fetch` middleware is the
   ingress door: CORS, the first-party OAuth clients, rate-limit.
2. **Authenticate + resolve the target project.** The product/control-plane authenticates the session → a
   user identity, and resolves _which project_ this request is for (subdomain, path, or an explicit
   `projectId` the user is authorized for — `assertCanAccessProject`, `auth.ts:164`). **The projectId is
   established HERE, from the request + auth — not from config.** A `null`/global projectId (admin) addresses
   the outer shells' own streams (the platform project).
3. **Dispatch inward to the project's context.** The control plane gets the `CapabilityHostDurableObject` for
   `{projectId}.iterate/` — the project-root itx context. The DO _name_ carries the now-trusted projectId;
   from here in it is unforgeable. (This is where the per-DO prefix in §2/§4 comes from.)
4. **Run the handler as code in the `/` context.** The `/api` logic is itself
   `host.run(async (itx) => handleApi(itx, request))` (§1a) — it executes with `itx` bound to `/` (or a
   deeper path if the request targets `/agents/support-bot`). Everything it touches — streams, kv, secrets,
   fetch — resolves through the same mount fold → parent chain → floor.
5. **Response streams back out** through control-plane → product → browser (the same chain, unwinding).

So the **kernel entrypoint** = **ingress door + router + real-binding holder + code executor.** It is the one
trusted place that (a) holds `env.STREAM/KV/R2/AI/LOADER/ARTIFACTS`, (b) turns a request into a
`{projectId, path}` context, and (c) runs code in that context via `host.run`. Userspace never runs here — it
only runs _inside_ a context, seeing only `env.ITX`.

---

## 6. The full inventory (what actually gets deployed)

### Statically deployed workers

1. **Kernel project entrypoint** (`prj_acme`'s runner). Holds the REAL bindings (`env.STREAM/KV/R2/AI/LOADER/
ARTIFACTS`), `env.APP_CONFIG`, `env.CONTROL_PLANE` (service binding). Hosts the capability-host DOs, mints
   the loopback entrypoints, loads dynamic workers, vends the default leaves. **This is "where everything
   begins."** Trusted; userspace never runs here.
2. **Control-plane worker** — parent of `/`. Routing/directory/ingress, the control-plane `fetch` middleware,
   `/api`, `/mcp`. Its parent is the product.
3. **Product worker** (topology B only) — parent of the control plane. First-party keys, metering,
   Slack/GitHub receivers, the product `fetch` middleware.

### Durable Objects (in the kernel project entrypoint)

- **`CapabilityHostDurableObject`** — the itx context. **Each `{projectId, path}` gets its OWN DO** (Jonas:
  "it's own DO") — `/`, `/agents/support-bot`, each repo/stream is its own capability host. Holds the mount
  fold + resolve + pagers + `host.run`. (Was open fork D21 — now resolved: own DO per path, not ride-a-parent.)
- **`StreamDurableObject`** — the event-log backing behind `itx.streams` (via `env.STREAM`).
- Domain-object DOs (agent, repo, secret, scheduler) — each a fold over its stream.

### Dynamic workers (loaded via `env.LOADER`)

- **The config worker** — userspace project code, confined, sees only `env.ITX` bound to `/`.
- **Agent code** — confined, `env.ITX` bound to `/agents/support-bot`. This is what ran the Stripe fetch.

### Loopback entrypoints (minted via `ctx.exports`, props-parameterized, TRUSTED)

- `KvEntrypoint({prefix})`, `R2Entrypoint({prefix})` — the prefixed KV/R2 leaves.
- `ItxEntrypoint({props:{projectId, path}})` — hands out the itx surface at a scope (the confined `env.ITX`).
- (StreamEntrypoint etc. as needed.)

### Env vars / config

- Real bindings: `STREAM`, `KV`, `R2`, `AI`, `LOADER`, `ARTIFACTS`.
- `CONTROL_PLANE` (service binding to the parent).
- `APP_CONFIG` (§4) — `rootParent` + `defaults`. The ONLY thing that differs self-host vs hosted vs BYO.

---

## 7. The three things this is meant to nail (react to these)

1. **The parent is just a (privileged, config-set) mounted capability** — an RPC stub you call and check.
   `{kind:"parent", ref:…}`. Root's parent comes from `env.APP_CONFIG.rootParent`, never userspace.
2. **`fetch` is one method, a middleware chain along the parent path** — ingress inward, egress outward; each
   level substitutes its own secrets/keys and delegates `next = parent.fetch`; the terminal (real fetch) is
   kernel-only, so outer concerns can't be bypassed.
3. **The floor is the real env bindings** — the constructive defaults ARE `env.STREAM/KV/R2/AI/LOADER/
ARTIFACTS`, vended by the trusted kernel entrypoint via prefixed loopback entrypoints; userspace sees only
   `env.ITX` and resolves down to them. Swap the floor (config) → same code, different environment.

## Open questions to settle

- **Is `fetch` special (a built-in middleware chain) or just another capability that happens to be
  chain-shaped?** It's the one capability whose resolution is "run mine, then the parent's" (`next =
parent.fetch`) rather than "mine XOR the parent's." Does anything else want that shape — auth? logging? If
  several do, the fold grows a per-name "combine" rule instead of a `fetch` special-case.
- **Where does a userspace `fetch` middleware run** — it's a `live` mount at the name `fetch` (a pager
  callback into the agent's dynamic worker) invoked per request. Latency of a per-request hop into userspace?
  Do we pay it only when the agent actually registered one (else the name `fetch` resolves straight to the
  parent)?

## Changelog

- **2026-08-04 (annotation pass):** reframed the scenario as `async (itx) => …` and added §1a (`host.run` =
  the core "execute code in a context" primitive); dropped `props` from `env-binding` and the separate
  `fetch-middleware` kind (it's a `live` mount at the name `fetch`); **made `APP_CONFIG` deployment-wide
  (no `projectId`; projectId comes from the DO name)**; added §5b (ingress from an authed browser);
  resolved D21 (each context = its own DO); fixed the §3 "who set them" legend.
