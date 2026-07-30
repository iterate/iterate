# Morning brief — overnight kernel build (2026-07-30 → 07-31)

Read this first. Full detail in `overnight-log-2026-07-30.md`; synthesis in `control-plane-and-product.md`.
Branch `wip/kernel-wayfinder-2026-07-30`, all pushed. **~45 tests green, typecheck clean, everything below
proven LIVE** on `kernel-selfhost` (shiterate.com) unless noted. Production OS untouched.

## What got built + proven (8 rounds)

| round    | what                                                                                                         | proven live                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| (pre)    | **routing table** (host→project, config+KV, before the slug convention)                                      | ✅ KV override on shiterate                                                     |
| (pre)    | **`/mcp`** — control-plane surface, sibling to `/api` (list/create/get projects)                             | ✅ Inspector CLI + Claude CLI                                                   |
| **R1**   | **two-level egress door + secret substitution** — project door + control-plane door, origin-pinned + metered | ✅ httpbin: platform+project substituted, anti-exfil, meter=1                   |
| **R2**   | **streams** — `StreamDurableObject` durable log (append/read), per-project                                   | ✅ 5 events, monotonic, durable across requests+redeploy                        |
| **R3**   | **AI as a per-capability-sourced capability** (local `env.AI` vs metered remote)                             | ✅ Workers AI → "Blue"                                                          |
| **R4**   | **script execution + dynamic capabilities** (MCP `run_script`/`provide`/`invoke`)                            | ✅ Inspector + Claude CLI (exec→whoami, invoke add=15, exec→streamAppend seq 1) |
| **R5/6** | **synthesis**: generic CP vs iterate-product seam; the two web apps                                          | doc                                                                             |
| **R7/8** | **3 thermonuclear reviews + fixed the critical security holes**                                              | ✅ anon scripting now refused on walled selfhost                                |

**The single best architectural finding (R3):** _remote-sourcing a capability == egress through the
control plane with a first-party key._ So per-capability sourcing (M3) + first-party metered secrets (R9)

- "the iterate product" are **one mechanism**: the control-plane egress door + a platform-secret list + a
  meter hook. `AppConfig.platformSecrets` present ⇒ iterate-product; absent ⇒ generic control plane. Same
  worker, same code path. That's the minimum elegant interface you asked for.

---

## ✅ UPDATE (2026-07-31, later): D-C, D-B, D-A + security follow-ups all EXECUTED + proven live

Per your go-ahead, the sequence below is now **done and pushed** (D-D still deferred). All proven live on
`kernel-selfhost`, prod untouched, 48 tests green. Evidence in `overnight-log-2026-07-30.md`; split
decision in `two-worker-split-assessment.md`.

- **D-C** — `platformSecrets` under `AppConfig.product` (the iterate-product boundary). Live.
- **D-B** — adopted apps/os's **canonical stream contract** (`StreamEventInput`/`StreamEvent` from
  `iterate/processors`, type-only): offset (eviction-safe) + idempotencyKey dedup + ephemeral. Delivery
  stubbed. Live.
- **D-A** — **one nested capability tree** (`project.streams.get(path)`/`.secrets`/`.ai`) shared by the
  capnweb `Project` and the loopback `ProjectEntrypoint` (now whoami + egress-door + getters). Live.
- **Security** — optional origin-pin for project secrets; `create_project` gated (walled+anonymous
  refused). Live.
- **Two-worker split — STEP 1 DONE + live** (see two-worker-split-assessment.md): named the runner
  interface in-worker (`ProjectRunner` WorkerEntrypoint: `serve` + `runScript`), reached via the one
  chokepoint `dialRunner(ctx)`. **Key experiment passed: `ctx.exports` works inside a WorkerEntrypoint**,
  so the physical split (step 2) is a binding swap at `dialRunner`, not a rewrite. Steps 2–4 (physically
  split into `apps/kernel-runner`; give `/api`+`/mcp` the CP's own host; cross-account capnweb) remain,
  each a dedicated provable increment.

---

## DECISIONS (original list — now largely executed above; kept for context)

### D-A. Unify the two "project" surfaces into ONE RpcTarget tree ⭐ (biggest simplification)

Today there are **two disjoint surfaces**: the capnweb `Project` (only `projectId`/`create`/`mapHostname`)
and the flat `ProjectEntrypoint` (all runtime caps: `streamAppend`/`aiRun`/`setSecret`…). The tree the code
comment _promises_ (`project.streams.get(path).append()`, `.secrets`, `.fetch`, `.exec`) **was never
built**. Recommendation: build that one nested tree; `ProjectEntrypoint` shrinks to a ~10-line adapter that
only exists for the `globalOutbound` Fetcher requirement. Then MCP/`/api` stop re-entering the tree from
the side, and `BUILTIN_CAPABILITY_NAMES` derives from the tree instead of a hand-mirror. **Cost:** the
confined config worker calls nested capnweb stubs (leans on path-pipelining to stay one round-trip — your
memory says it works). _This is the refactor I'd do first, but it's your call on the shape._

### D-B. Adopt apps/os's stream CONTRACT now (biggest trajectory de-risk)

The native `StreamDurableObject` is a _different contract_ from apps/os (no offsets / idempotency / reduce
/ subscription cursors). "processEvent killed" was wrong — the reduce/deliver step is **absent**. If we
build processors/agents/live-state on the naive `{seq,ts,type,data}` shape, we get a second incompatible
stream impl that needs a rewrite at migration. **De-risk cheaply:** do the `stream-storage.ts`
verbatim-import spike (feasibility says it's clean — only `sqlfu` + `iterate/processors` deps) and adopt
its `StreamEventInput`/offset/idempotency shape on `append` NOW, keeping delivery stubbed. Converts a future
rewrite into a present dependency spike.

### D-C. Group product config under `AppConfig.product` (cheap, high-clarity)

Move `platformSecrets` (+ future integrations, billing) under one `product` key so "generic control plane"
= "config with no `product`" — a boundary, not a convention. Even cleaner: a separate `apps/iterate` module
owns the `product` config + integration receivers; the generic kernel has zero product code (ADR 0030 at a
module boundary). _Small, low-risk; I left it undone only to avoid churning the live proofs mid-night._

### D-D. (radical, your taste) Fold secrets + capabilities + meter into the stream DO

`setSecret`/`provideCapability`/`streamAppend` are all "append to the project's durable state"; the meter is
_literally the count of egress events_. Collapsing four stores (STREAM_DO + 3 KV key-schemes) into one
per-project DO of typed log entries would kill the racy KV meter for free and make "everything is the
project's durable log" real. This is the "log is the computer" direction — powerful, but a bigger bet.

---

## Security follow-ups still open (R8 fixed the CRITICAL ones; these are next)

- **`create_project` / `list_projects` are still anonymous on walled deployments.** Less dangerous than
  scripting (no code/secrets), and "emerge with a project" (ADR 0029) wants create to work — but a walled
  _multi-tenant_ deployment should gate them on membership. (kv/open single-tenant = intentionally open.)
- **Project secrets aren't origin-pinned** (only platform secrets are). The R8 auth gate closes the
  anonymous-attacker path; a buggy in-project script can still leak its own project's secret anywhere. Add
  optional per-secret `allowedOrigins`.
- **Secrets are plaintext in KV** — a real deploy wants encryption / a Secret DO (like apps/os).
- **Meter is best-effort KV** (races) — a DO-backed meter (or D-D) is the fix.
- **exec cache key** uses length+djb2 — a real content digest (async `crypto.subtle`) is proper.

## The one structural wart the two-worker split removes

`/api` + `/mcp` currently answer on project hostnames (the fetch handler resolves a project host, then
intercepts the path). Their clean home is the **control plane's OWN hostname**, headless. That's the
forcing function for splitting the one worker into CP + project-runner workers (ADR 0017) — the next
topology step, and it also makes walling `/mcp` natural (closing the R8 hole at the edge, not just in code).

## Where I'd go next (my recommendation)

1. **D-C** (group product config — 30 min, clean win).
2. **D-B** (stream-storage.ts import spike — the trajectory de-risk).
3. **D-A** (unify surfaces — the big simplification) — but only after you confirm the tree shape.
4. Then the **two-worker split** (gives `/api`+`/mcp` a walled home; unlocks cross-account for real).
