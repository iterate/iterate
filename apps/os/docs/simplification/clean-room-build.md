# Clean-room build — discovering the architecture incrementally

A blank-canvas walkthrough, grown live with Jonas. **Invariant held at every step:**
the same thing must run **self-deployed** (`wrangler deploy` to your own Cloudflare
account) _and_ **iterate-hosted**, differing only by config/bindings (the ~5 knobs).

We start from the self-deployed core, because that's the honest floor.

**Scope (Jonas):** backend-only. Ignore the TanStack Start / React OS dashboard entirely
for now — it's a stateless proxied front-end (§14) that layers on later. Aim for
**pure-play workers**: ideally no Node.js compat, just web-standard APIs
(`fetch`/`Request`/`Response`/streams/WebCrypto) — leaner cold starts, and
miniflare/Raspberry-Pi friendly (the self-host-anywhere vision). The _kernel_ stays pure;
individual config workers can opt into node compat per-project if a user's npm package needs it.

---

## Step 0 — one worker: the kernel

Start with a single Cloudflare Worker (`wrangler deploy` ships it → the self-host unit).
The kernel is ITSELF just composed fetch functions — the same shape a config worker uses.
(Jonas: model the loop as _partial fetch handlers_ to **rhyme** with userspace.)

```ts
// each stage: (Request, ctx) => Response | undefined   (undefined = fall through)
export default {
  fetch: chain(
    // A. WELL-KNOWN KERNEL ENDPOINTS — not the project's config worker:
    //    /api (capnweb RPC), /mcp (MCP server), OAuth callbacks, inbound webhooks.
    //    (Jonas: these feel like they belong HERE in the kernel, not in config workers. ✓)
    wellKnownEndpoints,

    // B. IDENTIFY the actor.   ⚠ TERMINOLOGY UNSURE (Jonas): verifyActor? authenticate?
    //    whois? — attach {who, issuer, claims}; see identity-and-actors.md.
    identify,

    // C. ROUTE TO THE PROJECT — a project is just a projectId parameter (see below).
    (req, ctx) => ProjectEntrypoint({ projectId: ctx.projectId }).fetch(req),
  ),
};
```

`KernelEnv` holds the raw Cloudflare bindings — R2, KV, DO namespaces, AI, the
WorkerLoader — which self-host auto-provisions in your account. (Jonas: kernel-holds-R2
= fine ✓ — that's the whole "kernel holds bindings, exposes capabilities" split.) Nothing
in this loop needs a _hosted_ binding; hosted just fills the knobs (which issuers
`identify` trusts, which base the ingress matches, whether egress substitutes iterate's keys).

### The unification Jonas spotted (worth pulling on)

> "A project worker entry point parameterized with a projectId prop … is very specifically
> the same as the thing `env.ITX` is bound to."

**Yes** — today `env.ITX` is literally `ItxEntrypoint({ props: { projectId, … } })`, an
already-projectId-parameterized `WorkerEntrypoint`. So one projectId-parameterized
entrypoint can be BOTH what the kernel routes a project request to AND what a config
worker's `env.ITX` binds to:

```ts
// The project's capabilities — a plain in-memory object the kernel constructs and calls DIRECTLY.
class ProjectCapabilities /* name TBD */ {
  constructor(props: { projectId; actor; env: KernelEnv }) {}

  // INBOUND — what calls INTO the project (kernel-facing; called in-memory, 0 hops):
  fetch(req); // run the project's config-worker fetch handler
  processEvent(event); // run the project's config-worker processEvent handler

  // OUTBOUND — the capability tree the project is handed as env.ITX:
  get itx(); // { append, follow, fetch /* EGRESS: the one door OUT */, secret, actor, kv, ai, … }
}
```

**Two `fetch`es, opposite directions (Jonas's question):** the _ingress_ `fetch(req)` is the
project's inbound **handler** (the kernel calls it) — NOT on `itx`. The _egress_ `itx.fetch(req)` is
the one door **out** — a capability, ON `itx`. Same signature, opposite roles (the ingress==egress
rhyme). `processEvent` is an inbound handler like the first, not a capability. So: **`itx` = the
outbound capability tree; `fetch`/`processEvent` = the inbound handlers.** Kept separate on purpose —
merging them would conflate in vs out.

**Hops, and what `env.ITX` is (Jonas):** the capabilities object itself is NOT a WorkerEntrypoint —
the kernel constructs it in-memory and calls `.fetch`/`.processEvent`/`.itx` directly (**0 hops**;
a loopback WorkerEntrypoint would cost a needless RPC + isolate hop). **`env.ITX` IS a _thin project
WorkerEntrypoint_** that wraps this same object and exposes its `.itx` to the confined config worker
across the isolate boundary — **1 hop, and unavoidable** (that boundary _is_ confinement; the confined
worker must not touch the object's memory, which holds raw bindings + secrets). External clients reach
`.itx` via `/api`/`/mcp` over the network. So: one capabilities object; the kernel calls it in-memory,
confined + external callers pay the boundary they inherently cross.

**Consequence:** "a project" is not a heavyweight object — it's a **projectId parameter**
that scopes an otherwise-identical, kernel-provided entrypoint. The kernel is
project-agnostic; parameterize it with a projectId and you have "a project." (Today this is
split across `ItxEntrypoint` + `DynamicWorkerRunner`; collapsing them into one
projectId-parameterized entrypoint is the direction.)

### `/api`, `/mcp`, and `env.ITX` are the same tree, different doors (Jonas)

The `/api` fetch route and `env.ITX.get()` are fundamentally the **same thing** — both
hand you the project's capability tree (`ProjectEntrypoint({projectId})`). They differ only
by _transport_ and _how the actor is authenticated_:

- `env.ITX.get()` — **internal** door: Workers RPC, in-deployment, already-trusted.
- `/api` — **external** door: capnweb over WebSocket; authenticate the actor, then serve the
  same tree. (capnweb and Workers RPC are both object-capability RPC — two transports, one tree.)
- `/mcp` — the MCP-protocol external door onto the same tree.

**The one distinction to keep crisp:** this is the **control surface** (the capability tree —
append/follow/secrets/agents…). It is NOT the project's **own web app** — the config
worker's `fetch`, served at the project's hostname to its users. `/api`+`/mcp`+`env.ITX` =
three doors onto the control tree; the config worker's `fetch` = the app the project serves.

## Step 0 — the minimal `itx` (the kernel's API)

What a confined config worker is handed. The seed: one write, one read, one door out,
plus who's calling.

```ts
itx = {
  append(streamPath, event),   // the log — one write
  follow(streamPath),          // the log — one read
  fetch(request),              // egress — the one door out (secret substitution here)
  secret(name),                // read a secret
  actor,                       // the verified actor from step 2
}
```

Everything else — `kv`, `ai`, `agents`, integrations — is built _on top_ of these,
added as capabilities/packages. (`kv` wraps a raw binding → kernel; the agent is a
package → userspace _code_, platform-_hosted_.)

## Step 0 — the config worker template (what every project is born with)

```ts
import { IterateWorkerEntrypoint } from "iterate/sdk";
import { Agent } from "iterate/agent"; // first-party package, wired visibly

export default class extends IterateWorkerEntrypoint {
  #agent = Agent.create(this.itx);
  async fetch(req: Request) {
    /* serve; or proxy to a stateless front-end */
  }
  async processEvent(event) {
    await this.#agent.processEvent(event);
  }
}
```

---

## The workers (topology)

Ignoring the build/bundler/typechecker/loader sidecars, the pure-play backend is essentially
**one deployed worker — the kernel** — that exports a few entrypoints + DOs:

- **`default { fetch }`** — ingress (the composed fetch functions above).
- **`ProjectEntrypoint`** (WorkerEntrypoint, props `{projectId}`) — `{fetch, processEvent}` + exposes
  `itx`. It's what the kernel routes project requests to (`.fetch`), delivers events to
  (`.processEvent`), what `env.ITX` binds to (`.itx`), and what `/api`+`/mcp` serve. Its
  `fetch`/`processEvent` drive the project's _confined config worker_ (also `{fetch, processEvent}`).
- **`ProjectEgressEntrypoint`** (WorkerEntrypoint) — the one door out.
- **DO classes** — the durable state: the stream/log DO, the secret DO, etc.

- **Config workers** = user code, run _inside_ the kernel via the WorkerLoader (the ignored
  sidecar) — not separately deployed.
- **"os" is a _project_** (`projectId: "os"`) holding operator capabilities — **NOT a separate worker.**
- **The dashboard** is deferred — a future _stateless front-end worker_, out of backend scope.

So: **no separate "os worker."** One kernel worker (multiple entrypoints + DOs), config workers
running inside it. **`{fetch, processEvent}` is the _project's_ shape**, appearing at two levels —
the privileged `ProjectEntrypoint` and the confined config worker it drives. The kernel is _not_
itself `{fetch, processEvent}`; it's the substrate that **invokes** projects' `{fetch, processEvent}`
(ingress → `fetch`; event delivery → `processEvent`).

## Next layers to discover (open — pick one with Jonas)

- **The durable log.** `append`/`follow` need a stream durable object — the first
  piece of real state. How is it addressed (`{projectId, path}`), who wakes processors?
- **Secrets.** Where stored; how substituted at the egress door; the "self-refreshing
  secret" kind (OAuth).
- **The agent's durable host.** When a warm DO appears; platform-hosted vs user-hosted.
- **When a second worker becomes necessary** (egress entrypoint? the typechecker
  sidecar? the stateless OS front-end?) — and why the split is forced.
