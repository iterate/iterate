> **⚠️ SUPERSEDED (2026-08-30).** The "maximum simple" refactor LANDED: built-ins now resolve
> DIRECTLY (no config, no mounts, no provenance — `core/config.ts` deleted); `itx.connections`/`connect()`
> → the `rpcStubs` kernel primitive; `workers.get({source})`/`facets.get(ref)` mirror; `runScript(lambda)`;
> `itx.connectToCapnweb(url)` replaces `itx.os`. Read `src/built-ins.ts` + `capability-table-processor.ts`
> for the real surface. The config-gated / exokernel-grant model described below was NOT built (deliberately).

# Clean room — state of play (2026-08-17)

> Written after: the origin/main merge, the iterate-context design thread, and a
> three-agent adversarial review (coherence, simplicity, fact-check — all Fable,
> full source access). This is the single "where are we, what did we propose,
> what must be decided" document. It supersedes nothing; `iterate-context.md`
> stays the design doc and gets corrected per §3/§5.

---

## 1. Ground truth — what exists and runs

**Branch** `wip/kernel-wayfinder-2026-07-30`, merged with origin/main (0 behind),
pushed. Restructure committed: everything lives in `packages/v3/*`.

**Code:** ~2,175 lines of hand-written TS total (20% comment density on top).
Core (`project-worker/src`) = 1,293 lines across 13 files. For scale: apps/os's
`rpc-targets.ts` alone is ~7,700 lines.

**Proven on the live deployment:**

- The don't-pin transport: capnweb terminates at the stateless `/api` edge;
  the DO holds only `{socketId}` on a hibernatable Pager socket and borrows a
  short Workers-RPC leg per call burst. **1000 clients connected, DO
  hibernating (incarnation climbing), calls on 2 of them still resolve.**
  Whole mechanism = 195 lines (`hibernatable-pager.ts` 68 + `hibernatable-stub.ts` 127).
- Dynamic workers, both kinds: stateless (loader isolate) and stateful (user
  `DurableObject` class as facet `"target"` in a dedicated runner DO, native
  `Reflect.apply` dispatch, `env.ITX` = owning host, own SQLite).
- A real SQLite stream: `stream-durable-object.ts` (53 lines) — `append`/`read`,
  AUTOINCREMENT offsets (never reissues a seen offset).
- The `/cap` fetch lane: a mounted fetch-shaped worker reachable by name with a
  native 101 (WebSocket) all the way through — a lane apps/os does not have.

**Three DO classes exist today:** `ItxDurableObject` (capability host, 448
lines — the fattest file), `StreamDurableObject`, `StatefulWorkerDurableObject`
(the runner). Plus deletion-candidate legacy: `index.ts` + `config-worker.ts`
(228 lines, kept only for an old RUNNER binding — violates our own no-backcompat
rule).

**apps/os (now current in this worktree)** independently built the same
hibernatable-Pager design (one generic `HibernatablePagers` + lanes). It is the
mature sibling of our transport, not a competing approach.

---

## 1b. The big picture — components, how they fit, and the work to get there

### The target shape (resolved §4)

```
browser / CLI / device
   │  capnweb WS — the ONE /api door
   ▼
┌─────────────────────────── stateless edge worker ────────────────────────────┐
│ ProjectSession / itx surface: connect() → itx; RETAINS provided client stubs │
│ (free while idle); dials the parent's fetch() to register pagers; forwards   │
│ fetch-lane calls (resolved expression ends in .fetch) as real fetch()        │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │ Workers RPC + real fetch()
                                  ▼
┌──────────────── Stream DO — THE parent (one per context path) ───────────────┐
│ • event log — SQLite append/read, monotonic offsets                          │
│ • ALL hibernatable sockets: the pagers (HibernatableStubs registry)          │
│ • the fetch door: x-itx-pager → accept; fetch-lane → forward into a cap      │
│ • on append: drive subscribed processor facets + page matching subscribers   │
│ • facet host: ctx.facets.get + configure(identity) + dispatch walk +         │
│   shared facet-alarm proxy                                                   │
└──────┬──────────────────────────────────┬────────────────────────────────────┘
       │ facet boundary (in-DO)           │ DO→DO by name
       ▼                                  ▼
┌─ processor facets (MANY per stream) ─┐  ┌─ runner DO (one per stateful cap) ─┐
│ • capability-host processor: mount   │  │ user DurableObject class hosted as │
│   table (all itx-expressions),       │  │ facet "target"; env.ITX = owning   │
│   invoke/provide/describe, fetch-cap │  │ parent; own SQLite                 │
│   dispatch                           │  └────────────────────────────────────┘
│ • userspace processors (loader);     │
│   each folds events → reduced state  │  built-ins (the base case): itx.kv,
└──────────────────────────────────────┘  itx.workers, itx.streams, itx.clients,
                                          itx.controlplane… APP_CONFIG picks what
                                          backs each (first-party vs BYO-cloud =
                                          only itx.controlplane's backing)
```

One sentence: **clients talk capnweb to the edge; the edge holds their live
stubs and talks Workers-RPC/fetch to one parent Stream DO per context, which
owns the log and every hibernatable socket and drives its processor facets —
where all capability logic lives — while user stateful code runs in per-cap
runner DOs.**

### How big everything is right now (code lines, comments excluded)

| component                                               |     today | files                                                  |
| ------------------------------------------------------- | --------: | ------------------------------------------------------ |
| edge (session + itx surface)                            |       271 | `worker.ts` 72, `core/itx-surface.ts` 199              |
| capability host DO — **gets dismantled into the facet** |       448 | `itx-durable-object.ts`                                |
| don't-pin transport (proven at 1000)                    |       195 | `hibernatable-pager.ts` 68, `hibernatable-stub.ts` 127 |
| stream (SQLite log)                                     |        40 | `stream-durable-object.ts`                             |
| runner (stateful workers)                               |        73 | `stateful-worker-durable-object.ts`                    |
| expression codec                                        |        43 | `core/itx-expression.ts`                               |
| misc core (names, config, agent runtime)                |        69 | 3 files                                                |
| legacy to delete (§6)                                   |       154 | `index.ts` 112, `config-worker.ts` 42                  |
| **core total**                                          | **1,293** | 13 files                                               |

(Sibling packages, untouched this phase: control-plane 803, shell 38, shared 41.
Calibration: apps/os expresses this same architecture across >10k lines —
`rpc-targets.ts` alone is ~7.7k.)

### The work to get there — increments and expected diff sizes

| #   | increment                              | what it does                                                                                                                                                                                        |             est. diff |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------: |
| 1   | **Deletions + lane collapse**          | drop `index.ts`/`config-worker.ts`, `web` mount, `/ws` echo, idle page, dead code; routes → `/api` + one fetch door + `/state`; terminal-`fetch` rule                                               |      **−~320 / +~30** |
| 2   | **The facet spine** (§8 step 3 — next) | `ProcessorFacet` base (configure/identity, deliver, alarm-proxy client) ~120; Stream-side facet hosting ~80; first fold processor ~40; prove `append → drive → fold → read state` + hibernation e2e |             **+~250** |
| 3   | **Fuse the log into the parent**       | `append`/`read` move into the parent DO; `StreamDurableObject` class + colon codec deleted; `itx.streams` re-pointed                                                                                |             **±~100** |
| 4   | **Expressions as the currency**        | codec grows pipelining + fallback parameter (+~80); dispatch refactored off dotted strings (~100 churn)                                                                                             | **+~80 / ~100 churn** |
| 5   | **One registry + desugar**             | `parkClient`/`parkCapability` merge; `provide(live)` desugars; `itx.clients` surfaced; capability logic completes its move into the facet                                                           |       **−~50 / +~30** |

**End state estimate: the core lands at roughly its current size (~1,200–1,400
code lines) while gaining the full architecture** — processors, reduced state,
the closed capability model, hibernation-with-facets. Nothing here is a
rewrite; every increment is provable on the live deployment before the next.

---

## 2. What the design thread proposed

The conversation converged on a **closed capability model**:

1. **A context IS a stream** — one coordinate, spelled with the apps/os
   `DurableObjectNameCodec` verbatim (URL-shaped `{projectId}.iterate{path}`),
   that is both the append-only log and the capability surface. (API sugar TBD:
   `using itx = project.connect("/")`, `itx.cd("./other-path")`.)
2. **Every capability mount is an itx-expression.** `live` is sugar: park the
   stub in the client/stub registry under a stable key + bind an expression
   that fetches it. The table holds only expressions.
3. **Built-ins come from APP_CONFIG as seed mounts.** `APP_CONFIG` carries an
   **array of `capability-provided` event payloads** auto-added to the routing
   table at birth — that is where `itx.kv`, `itx.workers` (name TBD:
   `loader`?), `itx.streams`, `itx.clients`, `itx.controlplane` (name TBD:
   `itx.os` / `itx.platform` — "controlplane is not so cool") come from. The
   trust boundary is _provenance_: these wirings are config-only; untrusted
   appended events may never provide them. Payloads may reference
   **placeholders** — projectId and path are the principal components — to
   produce entrypoint props / DO names per context (placeholder protocol:
   open design). First-party vs BYO-cloud = only which payload backs the
   platform mount. Same worker code both ways.
4. **Running code = `itx.workers.get({type:"stateless"|"stateful", source,
className?})`** — a built-in, not a mount kind. The 5-way `Mount` union
   collapses; **`web` is deleted** (a fetch-shaped worker is a stateless worker
   whose `fetch` you call).
5. **Fetch lane rule:** a call rides the fetch lane iff the _resolved_
   expression's terminal method is `fetch` (workerd's own 101-capable
   distinguished method — a borrowed rule, not an invented one).
6. **Ancestry = routing, not hop-by-hop walking** _(annotation round)_. The
   mount table is a **routing table**: every mount's string form starts with
   `itx`, and resolution is **longest-prefix match** over all candidate mounts
   — network-routing style, "find the most strongly matched candidate."
   The fallback is just the **default route**: a mount at the bare prefix
   `itx` pointing wherever misses go — `itx → itx.cd("/")` (straight to the
   project root; a five-level-deep context never walks five DOs up) or
   `itx → itx.controlplane` (fall back to the platform). Ancestry, built-ins,
   and fallback become ONE mechanism. Needs careful design; can be made
   extremely fast.
7. **Processors run against the stream** as facets (§4); the capability host is
   one processor among many. **Both kinds are DO classes subclassing the
   stream-processor base:** built-in = loopback `ctx.exports` classes;
   userspace = loader-loaded exported classes — exactly the apps/os shape.
8. **Trust model:** inside a project, everything is trusted — any expression may
   reach any parked stub.

---

## 3. Corrections — what the review caught (own errors included)

The fact-checker verified every load-bearing claim. Platform claims (facet
alarms #6810, 101-over-fetch-only, socket ownership, fork mechanics, all
clean-room facts) **hold**. Errors clustered in my description of _current_
apps/os:

| Error                                                                                   | Correction                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "apps/os has a `CapabilityHostDurableObject`"                                           | **Retired.** The capability host is now a plain processor registered inside `processor-facet-durable-object.ts` (`#registerCapabilityHost`, :358). apps/os already consolidated it into the facet-hosting DO.                                                                         |
| Subscription handles are itx-expressions `["capabilityHosts",["get",path],"processor"]` | **Pre-v30.** Since v30 the subscription _name is the facet name_ — no expression. Expressions remain only on the userspace wake lane.                                                                                                                                                 |
| apps/os mount union is `live \| itx-expression`                                         | Tag is **`itx-call`** (still carries an `expression` field).                                                                                                                                                                                                                          |
| "apps/os models OpenAPI/MCP as worker entrypoints" (used to support R12)                | **Wrong.** They are in-process **RpcTarget relays** (`OpenApiRpcTarget`, `McpClientRpcTarget`). apps/os proves "openapi/mcp are not distinct mount kinds," _not_ "everything is a worker entrypoint." R12's precedent claim must be softened; the design choice can stand on its own. |
| "deep dotted calls silently fail"                                                       | They **throw loudly** (`no method "foo.bar"`). Single-key dispatch is still real.                                                                                                                                                                                                     |
| Quarantined-test task file is in `apps/os/tasks/`                                       | It's at repo root `tasks/`.                                                                                                                                                                                                                                                           |
| "fork `websocket-streams.ts` byte-identical to published 0.10.0"                        | **Stale — see §7 (surprise).**                                                                                                                                                                                                                                                        |

Caveat kept honest: workerd **#6702/#6800** (the two issues gating
facet-owned sockets and facet-storage hibernation) came from web research and
were **not re-verified against GitHub** in the final pass; #6810 (facet alarms)
_is_ confirmed in-repo and in workerd source. Before betting the architecture on
#6800's exact behavior, re-verify it (one small task).

---

## 4. THE central fork: where does the capability host run? — **RESOLVED (Jonas, 2026-08-17)**

The reviewers converged on calling processors-as-SQLite-facets a blocker via
workerd #6800. **That verdict did not survive contact with the shipped code**,
and Jonas overruled it:

- The repo's own read of #6800 (`tasks/stream-processors-as-facets.md:104`,
  `tasks/dual-mode-stream-processors.md:161`): SQLite facets impose a
  **~70–140s post-activity billing tail** through the parent — _"moot for
  already-pinned Stream DOs, real for quiet hosts."_ A bounded tail, **not**
  permanent pinning; R1's headline (idle ≠ pinned forever) stands.
- **apps/os ships this exact architecture**: the Stream DO terminates all
  hibernatable sockets + pagers, hosts processors as SQLite facets (with the
  shared facet-alarm proxy slots), recovers _"keyed facet lanes for watcher
  sockets that hibernated across"_ (`stream-durable-object.ts:1099`), and its
  generated API docs assert _"a watched idle stream hibernates at zero
  duration."_ The guard is a required e2e (dual-mode task): userspace facet
  processor + live liveState subscriber, go idle, **assert the Stream DO
  hibernates** — the test that keeps facets from silently re-introducing
  pinning.

**The clean-room target is therefore Jonas's original model = apps/os's
production shape:**

- The **Stream DO** is the parent: it terminates every hibernatable WebSocket,
  owns the pagers, and is the go-between for parked RPC stubs.
- **Processors run as SQLite facets on the Stream** — there will be _many_ per
  stream; the capability host is one of them.
- The **runner DO** stays for user stateful workers (one per stateful
  capability), as today.
- Carry the known costs deliberately: the ~70–140s quiet-host tail (accepted;
  e2e-guarded), no facet alarms (#6810 — parent proxies, apps/os pattern),
  facet stubs non-serializable (parent→facet delivery is direct), and the
  #6702 `getWebSockets`-leak caveat (sockets stay parent-side anyway).

The simplifier's "no facets" option C is retired; its still-valid pieces
(delete `index.ts`, deep-dispatch fix, registry/noun collapses, currency fix)
live on in §5/§6.

---

## 5. Other decisions needed (ranked)

1. **Grow the expression codec or shrink the claims.** The closed model (R13)
   and ancestry (R11) both _require_ two features the codec deliberately lacks:
   **multi-hop pipelining** (a call returning a stub you call again —
   `["clients",["get",key]]` then `.method()`) and **parameterization** (a
   fallback expression must receive the missed call). Today both are
   special-cased in code; "everything is an expression" is doc-fiction until
   the codec grows. Also: the internal currency must become expressions —
   dotted-string dispatch **cannot represent** mid-path call args, so the
   `provide(live)` desugar is unrepresentable today. **Decision (Jonas): grow
   the codec — dedicated jam session to design it** (together with the
   longest-prefix routing model from §2.6, which the codec must serve).
2. **One registry — but naming + semantics need a proper jam session
   (Jonas).** The mechanics point stands (one `park(key, meta)` under the
   hood; two access semantics — fan-out-allSettled vs single-key-throws —
   must not silently merge). Open with Jonas: what IS this thing called — a
   hibernatable RPC stub? a hibernatable socket? `itx.clients`? — and what the
   exact access semantics are. Important enough to get on the same page
   before building.
3. **"Warm/cold" plainly stated** _(rewritten — the compressed version was
   unclear)_. What actually happens when the DO calls a live client
   capability: it does **not** open a websocket per call. It sends one tiny
   `wake` frame over the client's already-open pager socket; the edge relay
   answers by lending the DO a direct Workers-RPC stub (a "leg"); the DO then
   makes ordinary RPC calls over that leg at full speed. The leg is dropped
   the moment no calls are in flight, so the DO can hibernate again. Net: a
   **burst** of calls pays the wake once, then runs at plain-RPC speed; only
   the _first_ call after idleness pays the wake round-trip. This is already
   built and shipped (`hibernatable-stub.ts` — leg held while `inFlight >
0`). The earlier "warm phase / cold phase / eviction machinery" framing
   made it sound like a state machine still to build — it isn't. The only
   knob we might ever add: keep the leg alive N seconds after the last call
   (a few lines, in the parent) if measurement shows many isolated single
   calls each paying a wake. One honest footnote: for a capability living in
   a _browser_, the client's capnweb websocket is always the final hop — the
   leg optimization removes per-call websocket _setup_, not the client's own
   socket.
4. **Reword R1 honestly:** the _subscription lane_ never pins; a tab pins only
   while its provided capabilities are being invoked (burst / TTL). R1's
   absolute wording only holds for tabs nobody calls.
5. **APP_CONFIG: wire it for real, as seed mounts (Jonas — supersedes the
   `{fallback}`-only restatement).** The shape is an **array of
   `capability-provided` payloads** automatically added to the routing table
   (§2.3): the built-ins plus the default `itx` route. Payloads may use
   placeholders — projectId and path are the principal components — to
   produce entrypoint props and DO names; the placeholder protocol is an open
   design item. `parseAppConfig` is dead code today — wire it. (Still true:
   `ctx.exports.X({props})` loopbacks aren't mintable from inside a DO, so
   prop-parameterized roots resolve at the edge/worker layer.)
6. **One name codec = the apps/os codec, copied verbatim (Jonas).** Adopt
   apps/os's URL-shaped `DurableObjectNameCodec` (`{projectId}.iterate{path}`)
   and delete the clean-room's colon (`prj_x:/path`) and double-colon
   (`prj_x::/path::cap`) spellings; the runner name becomes the codec string
   plus one segment.
7. **Doc surgery** (`iterate-context.md`): merge R2+R3; demote R4/R9 (they are
   implementation decisions wearing requirement numbers); cut R5/R6
   (duplicates/scene-setting); move R7 to open-questions; fold §3's
   corrections; fix W2.

---

## 6. Decided-but-undone (safe to land, no open decision)

- **Delete the `web` mount kind**; fetch-lane = resolved expression's terminal
  method is `fetch`. One door that carries the **full serialized expression**
  (the current `?cap=`/`x-itx-cap` callPath reduction drops call args — it
  cannot address `itx.workers.get({...}).fetch`).
- **Delete `index.ts` + `config-worker.ts`** (228 lines of pre-skeleton
  backcompat; re-point the control-plane RUNNER binding).
- **Fix deep dispatch in the runner**: split the dotted method, walk segments,
  `Reflect.apply` the terminal (3 lines).
- **Small deletions:** the no-op `idle` page variant; unused
  `captureExpression`; the `/ws` demo echo socket; the four near-identical
  `LOADER.get` blocks → one helper; `incarnation` counter → dev-only.
- **Edge routes:** collapse toward `/api` + one fetch door + `/state`
  (today: six routes — apps/os's lane sprawl in miniature).

---

## 7. Surprise found during fact-check

The local capnweb fork checkout (`~/src/github.com/iterate/capnweb`) is sitting
on a branch **`defer-upgrade-materialization`** (HEAD `48166d0`) — the exact
Level-2 fix `live-capnweb-ws-handler.md` recommends, already started.
**Resolved (Jonas): someone else owns that work — R3b is off our plate.** No
clean-room increment should touch it; we just consume the fork when it lands.

---

## 8. Proposed next increment (under the resolved §4 target)

1. Land §6 (pure deletions + the deep-dispatch fix). Core shrinks below ~1,100
   lines while gaining capability.
2. Merge toward one parent: the Stream DO becomes the context's single
   addressable parent (log + all hibernatable sockets + pagers + the fetch
   door); adopt the apps/os name codec verbatim.
3. **The first processor facet on the Stream** — `ctx.facets.get` +
   `configure({parentName, projectId, path})` + segment-walk dispatch (the
   apps/os pattern, which §4 makes load-bearing again), **both kinds from the
   start**: one built-in (`ctx.exports` loopback class) and one userspace
   (loader) processor, folding events into reduced state. Prove
   `append → drive facet → fold → read state` live, then the hibernation e2e
   (facet present, idle ⇒ Stream hibernates — mirror the dual-mode task's
   required test).
4. **Jam sessions before building further** (Jonas): (a) the expression codec
   - the longest-prefix routing table (§2.6/§5.1) — pipelining, the default
     `itx` route, APP_CONFIG seed mounts + placeholders; (b) the registry's
     name and exact semantics (§5.2).
5. Then: `provide(live)` desugars into the one registry; the routing table
   replaces the four-tier dispatch ladder; capability-host logic completes
   its move into its processor facet.
