> **⚠️ SUPERSEDED.** This document describes an earlier shape of the clean room and is kept as
> history. The current surface is `docs/clean-room-api-walkthrough.md`; the layer map is
> `LAYERS.md`; the design of record for subscriptions and processors is
> `docs/design-onion-subscriptions-processors.md`.

# The Iterate Context — a concrete design (v1, for annotation)

> Requirements-first, like the consolidation doc. v1 folds in three research
> passes (facet WebSocket hibernation; parent↔facet wiring; the WS-capability
> fetch path) and your 14 annotations from v0. Genuinely-open decisions are
> marked **[OPEN]**. Nothing here is decided.

---

## Requirements

**R1 — A subscribed browser tab must not pin the Durable Object.** Idle → the DO
hibernates (~$0) → the tab is still subscribed → the next `append` wakes the DO →
the tab receives the event. The headline.

**R1a — Connecting is _becoming a client with capabilities_.** A tab that connects
automatically registers as a client and provides default capabilities (e.g. "navigate
the page") — not just a passive subscriber. `provideCapability` adds more.

**R2 — capnweb terminates only in the stateless `/api` worker.** The DO is reached
only over Workers RPC. (Hard rule.)

**R3 — Anything carrying an HTTP request/response — including a 101 upgrade — crosses
a worker/DO boundary only through a method named `fetch`** (a 101 can't cross an RPC
call). This splits into two cases we must not conflate:

- **R3a — a _mounted_ fetch-capability**, reached by _naming the mount_ over `fetch`
  (a `web`/dynamic-worker mount that itself serves WebSockets). **Tractable now.**
- **R3b — a _live_ capnweb-provided fetch handler** offering WebSockets. **Harder** —
  needs a frame bridge; this is what the quarantined apps/os test targets. Separate work.

**R4 — Processors run as facets** — and there are **two kinds**: _built-in_ (a static
class from `ctx.exports`, inheriting the host worker's env) and _userspace_ (loaded via
the Worker Loader, which injects `env.ITX`). v1 demonstrates the userspace/loader path;
the design must accommodate both.

**R5 — A context's events have (today) two kinds of consumer:** (A) the processors
(facets), (B) connected clients that subscribed by handing in a callback the server
invokes. Future consumers exist too (webhook receivers, push targets — apps/os has these).

**R6 — Connecting is providing** (see R1a).

**R7 — [OPEN] How many durable-object classes: two or three?** Not decided. The certain
two are (1) the `Stream` (log + transport) and (2) the capability-host, run as a facet.
Whether a third is ever warranted is an open question, not a closed "no."

**R8 — prod is resettable; no backcompat shims** (house rule).

**R9 — The parent DO must (a) hand each facet its identity + a back-channel, and
(b) forward arbitrary (including deep, dotted) method calls onto any facet.** apps/os
has the precedent; the clean-room does not yet (see gaps).

**R10 — The high-volume connected-callback path must not go through a WebSocket when a
warm in-memory RPC stub exists.** Providing clients can be invoked at high volume; the
websocket is the _cold-fallback_ transport, not the hot path (see "Two-phase capabilities").

**R11 — Ancestry (parent-context fallback).** A context at a sub-path (e.g.
`/agents/myagent`) has its own capabilities; on a **local miss it falls back to
its parent path**, ultimately the root `/`. The fallback is itself an
itx-expression the context is born with (apps/os does exactly this — a one-hop
fallback to the root host). Ancestry is modeled, not special-cased.

**R12 — Built-ins are config-driven worker-entrypoint roots.** The base-case
capabilities (`itx.kv`, `itx.workers`, `itx.streams`, `itx.clients`,
`itx.controlplane`, …) are the only non-expressions. **Each is a worker
entrypoint** — a stub you call methods/`fetch` on directly. You obtain it as a
**direct binding** (`env.X`, called directly — _not_ `env.X.getByName`, which is
DO-namespace syntax for a specific instance) or a **prop-parameterized loopback
entrypoint** (`ctx.exports.X({props})`); `getByName` appears only when the root
is a DO _instance_ (a stream, a stateful worker). What an entrypoint does
_internally_ — hit KV, dial a remote capnweb server, speak OpenAPI/MCP — is
encapsulated, so **"remote capnweb", "openapi", "mcp" are not distinct root
kinds; they are just worker entrypoints** (apps/os models openapi/mcp exactly
this way). `env.APP_CONFIG` chooses which entrypoint backs each built-in.
**`itx.controlplane` — a direct binding to the in-account control-plane worker
(first-party) vs. a loopback entrypoint that dials our control plane over capnweb
(customer's account) — is the ONLY difference between the two deployment
topologies. Same project-worker code; `APP_CONFIG` flips the root.** (Remote-dial
auth deferred.)

**R13 — Every capability is an itx-expression; `live` is sugar.** A provided live
capability = park the stub in the `clients`/`hibernatableCapabilities` registry
under a key + bind an expression that fetches it (`["clients", ["get", key]]`).
The capability table holds only expressions; the only non-expressions are the
built-in roots (R12). Trust model: inside a project everything is trusted, so any
expression may reach any parked stub.

---

## The shape in one picture

```
        capnweb WS                       Workers RPC              facet boundary
 browser ──────────►  /api worker  ──────────────────►  Stream DO ───────────►  processor facets
  tab                (ProjectSession)      fetch()        (base)   ctx.facets.get   • capability-host
   │                  • terminates capnweb                 │ owns:                    (one of them)
   │                  • retains provided STUBS             │ • event log            • userspace processors
   │                    at the edge (free while idle)      │   append / read        • …
   └── pager WS ──────• dials Stream.fetch to register     │ • hibernatable         each facet:
      (hibernatable)    a PAGER                            │   pager sockets        • gets identity via
                       • on a Page, lends a transient      │ • the fetch() door       configure(parentName…)
                         RPC leg                           │ • drives facets on     • reached via replayPath
                                                           │   append               • no sockets of its own
                                                           └─ pages subscribers       (today — see hibernation §)
```

One context = one `Stream` DO (name = the context ref `<projectId>:<path>`) hosting
**many processor facets**, of which the **capability-host** is one built-in member. From
outside there is one addressable thing.

---

## The classes

### `Stream` (base DO) — log + transport, dumb about capabilities

```ts
class Stream {
  append(events: Event[]): { fromOffset: number; toOffset: number };
  read(afterOffset: number, limit?: number): Event[];

  // THE fetch door (R3). Branches:
  //   x-itx-pager   → acceptWebSocket + stamp attachment + 101      (register a pager)
  //   x-itx-cap     → forward to the facet that owns that mount     (reach a fetch-capability, R3a)
  fetch(request: Request): Promise<Response>;

  // R9(b): forward ANY (deep) method onto a named facet — replayPath(Reflect.apply walk)
  invokeOnFacet(facetName: string, path: string[], args: unknown[]): Promise<unknown>;

  // paging, called BY a facet (facets own no sockets today)
  page(connectionKey: string, page: Page): void;

  // hibernation handlers (the base owns the sockets — see § below)
  webSocketClose(ws): void;
}
```

On `append` (DO awake), after commit: (1) drive each subscribed facet
(`facet.deliver({fromOffset,toOffset})`) — consumer A; (2) page each subscriber pager
whose **filter** matches — consumer B (wake-only; the relay re-reads with `read`).

### The processor facets — capability-host is one of them

The capability-host facet holds the capability table (records: `live | itx-expression`),
does `invokeCapability`/`provideCapability`/`describe`, and dispatches fetch-capabilities.
It looks like apps/os's capability-host processor. **Other** processors (built-in and
userspace) run as sibling facets on the same `Stream`. None of them owns a socket today;
each reaches the outside by asking the parent (`Stream.page`, `Stream`-held pager).

### [OPEN] two classes or three?

Certain: `Stream` + capability-host-facet. The live question is whether some concern
(e.g. a distinct coordination object, or splitting transport from log) ever justifies a
third addressable DO. Default lean: **no third** — but it's explicitly open, not closed.

---

## Parent ↔ facet channel (research pass 2)

Two findings reshape this from v0:

1. **Identity via `configure(name)`, not a live self-stub, not env.** The parent calls a
   first-contact `configure({ parentName, projectId, path })` on the facet; the facet
   **stashes it durably** and re-resolves a fresh parent stub _per call_. This is the one
   mechanism that works for **both** built-in and userspace facets — a built-in facet
   inherits the _host worker's_ env (it can't be handed a parent-chosen env), and DO/facet
   stubs must not outlive their RPC turn. `env.ITX` injection is a **loader-only
   convenience**, never load-bearing for identity or the back-channel. _(Your v0 "parent
   calls connect() passing a reference to itself" was the right shape — corrected to
   pass a **name**, not a stub.)_
2. **Invocation via `replayPath` (R9b).** One parent verb resolves the facet
   (`ctx.facets.get`) and `replayPath({ path, args, target: facetStub })` — a
   receiver-preserving `Reflect.apply` walk down the dotted path. Supports deep calls
   (`mount.foo.bar`) that single-key dispatch cannot.

The only per-facet-kind fork is which binding re-resolves `parentName` (built-in →
inherited `env.STREAM`; userspace → injected `env.ITX`). Everything above that seam is
shared.

---

<details>
<summary><b>How WebSocket hibernation works with Durable Object facets</b> (research pass 1 — click to expand)</summary>

**Verdict: a facet CAN own hibernatable WebSockets** — but we keep them on the parent
_today_ for two production reasons, not a capability limit.

- **Source-proven CAN.** In workerd (`main`), the `HibernationManager` is **per-actor**
  (`io/worker.h:898-901`), and `ctx.acceptWebSocket` binds to the _current_ actor with no
  root-vs-facet check (`api/actor-state.c++:1206-1238`); facet actors are built with the
  hibernation event type wired (`server/server.c++:3852-3866`). The **only** capability
  workerd withholds from facets is **alarms** (`server.c++:1199-1214`, "TODO: Support
  alarms in facets"; `actor-sqlite.c++:1216`). Contributor confirmation: workerd **#6702**
  ("facets can have their own WebSocket clients"; kentonv: "a facet runs in its own
  execution context").
- **Do NOT conflate** with hibernatable _RPC stubs_ (workerd #6087 / capnweb #36) — that
  is a separate, still-unsolved problem. Native `acceptWebSocket` hibernation already works
  per-actor.
- **Why keep sockets on the parent anyway (today):**
  1. **workerd #6702 (prod bug):** a freshly-bootstrapped facet's `getWebSockets()` returns
     the **parent's** sockets in production (fine in local dev). The pager enumerates
     `getWebSockets(tag)` on every page/claim — so a facet-owned pager is unsafe until this
     is fixed in the prod runtime.
  2. **workerd #6800:** a parent with SQLite facets can't hibernate for ~70-140s after work
     completes (the client-count check recurses over facets), independent of who owns the
     socket — eroding the exact billing win that motivates R1.
- **So:** the `Stream` base owns the hibernatable pager sockets; facets route wakes/pages
  through it (`Stream.page`). This matches apps/os today (every `acceptWebSocket` is on the
  outer DO; facet-hosted lanes dial back to the parent-held pager) and the Agents-SDK
  workaround (never enumerate `getWebSockets` from a facet).
- **Revisit** pushing the transport into the facet (which would shrink the base toward
  nothing) only once #6702 is confirmed fixed in prod and #6800's stall is acceptable.
- Doc-honesty flags: apps/os's `processor-facet-durable-object.ts:395` ("facets hold no
  hibernatable sockets") is stated as platform fact but is an architecture _choice_ — worth
  correcting; the alarm comments are correctly structural (#6810). This verdict rests on
  workerd source + the #6702 statement; **no Cloudflare doc affirms facet WS hibernation**,
  and no facet in apps/os or v3 has ever actually called `acceptWebSocket` — the spike
  stands un-run.

</details>

---

## Two-phase capabilities (research + your #9 — the hot path)

A provided capability is resolved through a lookup: an `itx-expression`/path is matched in
the table to _how to reach it_. It resolves to **one of two phases**:

- **Warm (hot path).** The provider's Workers-RPC stub is **held in memory** in the DO/host.
  Invocation is a direct RPC call — **no websocket in the loop** (R10). This is what serves
  high-volume connected callbacks. Cost: a retained live stub **pins the DO**.
- **Cold (fallback).** After an idle timeout the warm stub is **evicted**; the record falls
  back to the **pager**. Invocation now: `page` the relay → the relay hands back a transient
  RPC stub → call it → (optionally re-warm). The DO holds no stub → it can hibernate.

So: **yes, the DO does hold the Workers-RPC stub — while warm.** It is _not_ "everything via
websocket." The websocket is the eviction-survival path, and re-materializes the warm stub
on demand. Where the idle boundary sits is the tuning knob between "cheap to invoke" and
"cheap to idle."

---

## Concrete walkthroughs

### W1 — browser subscribes, DO hibernates, append delivers (proves R1)

1. Tab dials `wss://…/api`; its capnweb session lives in the worker (free). It also
   registers as a client and provides default caps (R1a).
2. Tab calls `subscribe(filter, onEvents)`. The worker **retains `onEvents` at the edge** and
   dials `Stream.fetch` with `x-itx-pager` → the DO `acceptWebSocket`s, stamps
   `{ connectionKey, deliveredOffset, filter }`, returns 101. The DO now holds only a
   hibernatable socket → **it hibernates.**
3. Another client calls `append(e)` → worker → `Stream.append(e)` → the DO wakes, commits.
4. The DO pages the tab's relay `{ type: "wake", replayAfter }` (free outbound send), only if
   the tab's **filter** matches (subscribers are not all-or-nothing — your #14).
5. The relay (alive inside the tab's still-open worker invocation) calls `Stream.read(after)`
   and invokes `onEvents`. **The tab never pinned the DO.**
6. Tab closes → worker execution context cancels → pager socket closes → `Stream.webSocketClose`
   wakes the DO → the transport is dropped. Presence drops (`itx.rpcStubs.list()` no longer names
   it); the mount stays in the table until revoked — nothing is told "client left."

### W2 — provide a live capability, invoke it warm, then after eviction (proves R10)

1. Client `provideCapability({ path:["nav"], type:"live", capability: stub })`. The worker
   retains the stub at the edge; the capability-host facet records the mount and (warm) can
   hold the live RPC stub for the hot path.
2. **Warm invoke:** `invokeCapability(["nav"], args)` → capability-host facet → direct RPC on
   the in-memory stub. High-volume, no websocket. (Pins the DO while warm.)
3. **Idle → evict:** the warm stub drops; the mount falls back to the pager.
4. **Cold invoke:** capability-host facet asks the parent to `page` the client's relay → the
   relay hands back a transient stub → invoke → optionally re-warm. DO could hibernate between.

### W3 — reach a _mounted_ web capability over `fetch`, with a 101 (proves R3a)

1. Browser → `GET`/WS-upgrade at the edge → the worker forwards a **real `fetch`** to
   `Stream.fetch` with `x-itx-cap: <mount path>`.
2. `Stream.fetch` routes to the facet that owns that mount → `facet.fetch(request)` (real
   fetch across the boundary → the 101 tunnels).
3. The facet resolves the `web`/dynamic-worker mount (Worker Loader) and returns its
   `accept()`ed 101, which flows straight back out. **Every hop was a `fetch` method.**
   _(This is the clean-room `/cap` lane, which apps/os lacks — apps/os's one fetch lane is
   keyed on a `DynamicWorkerRef`, not a mount name.)_

**R3b (the harder half):** a _live capnweb-provided_ WS handler (the quarantined
`live-capability-websocket.e2e.test.ts`) is **not** solved by W3 — the socket is tunnelled
across the capnweb session as a stream pair, materialized too early, and dies at the first
internal RPC hop. The fix keeps it in stream-pair form across hops and re-materializes a real
`WebSocketPair` only at the final fetch exit. Separate follow-up; the clean-room returns `501`
here today.

---

## Where today's clean-room maps — and the concrete gaps to close

| today (`packages/v3/project-worker`)                                | becomes / gap                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `StreamDurableObject`                                               | `Stream` — add the `fetch` door + pager ownership + drive-facets-on-append + `invokeOnFacet`                |
| `ItxDurableObject` (capability logic)                               | moves into the **capability-host facet** (one of many processor facets)                                     |
| `ProjectSession` (edge)                                             | ~unchanged; dials `Stream.fetch` for pagers; forwards `fetch` for web-caps                                  |
| `HibernatableStubs` / `hibernatable-pager.ts`                       | the base's pager machinery (parent-owned; see hibernation §)                                                |
| `/cap` + `#fetchWeb` + `web` mount                                  | already the R3a lane — keep                                                                                 |
| **gap:** no `configure()` identity delivery                         | port apps/os's `configure(name)` **before** hosting a built-in DO class as a facet (env.ITX can't cover it) |
| **gap:** single-key facet dispatch (`Reflect.get(facet,"foo.bar")`) | port `replayPath` segment-walk (deep calls silently fail today)                                             |
| **gap:** live-provider WS returns `501`                             | the R3b frame bridge — deferred                                                                             |

---

## The open questions to annotate

- **[OPEN] R7 — two classes or three.** Lean: two (`Stream` + capability-host facet). Confirm
  or name the concern that would force a third.
- **[OPEN] Public surface / R9.** The parent owns `invokeOnFacet` (replayPath) regardless — so
  "edge talks to `Stream`, `Stream` forwards to facets" falls out naturally. Does the edge ever
  need a facet stub directly, or is the single `Stream` surface enough?
- **[RESOLVED-for-now] Socket ownership.** Parent owns the hibernatable sockets today (workerd
  #6702/#6800); facet-owned is a future option once those clear. Annotate if you want the spike
  run now anyway.
- **[OPEN] Subscribe lane.** With filters + batching living inside the model (your #14), is the
  one-pager-lane subscribe enough, or do specific fan-out shapes still want a dedicated
  subscriber lane like apps/os? This is a _when-to-optimize_ question, not a _dumb-vs-smart_ one.
