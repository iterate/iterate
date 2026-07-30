# Overnight build log — 2026-07-30 → 07-31

Autonomous run. Goal (Jonas): continue implementing the simplest possible kernel. Prove ingress/egress

- routing, then bring back streams / repos / AI / project-DO / stream-processor-DO / project-creation
  (import from apps/os if possible), plus dynamic workers, **script execution**, dynamic capabilities.
  Especially prove **control plane vs the iterate-product layer** (first-party secrets + integrations
  wrap the generic control plane) — find the minimum elegant interface. Consider **two web apps**:
  (1) a control-plane web app (create projects…), (2) a main dashboard written like the Tasks app.
  Keep a super-detailed log. End with multiple **thermonuclear reviews**: how it could collapse
  differently, how to simplify, how to still move toward apps/os without breaking the topology work.

Rules I'm holding myself to: pure-play kernel (no node compat); never break the production OS worker;
commit+push after each working round; tight timeouts; honest logging of what's blocked vs proven.

Starting point: `9db6622a0` (routing table + /mcp both proven live). Branch
`wip/kernel-wayfinder-2026-07-30`.

---

## Plan (rounds)

- **R1 — Egress + secret substitution (both levels).** The concrete "iterate product wraps the control
  plane" proof: the project egress door substitutes a placeholder the project never sees; a
  control-plane egress door meters/substitutes first-party secrets (Exa/Parallel shape). Buildable now.
- **R2 — Streams.** A durable log as `ITX.streams` (append/subscribe). Try importing the apps/os stream
  ENGINE (`stream-storage.ts` — the trace said it's clean); else hand-roll minimal. Kill `processEvent`.
- **R3 — AI binding as `ITX.ai`** with the sourcing knob (local `env.AI` vs remote proxy) — proves
  per-capability sourcing AND the metered-first-party-secret idea concretely.
- **R4 — Script execution + dynamic capabilities.** An `exec` capability that runs a script against the
  ITX tree (like os `exec_typescript`); `provideCapability`/mount (dynamic capabilities). Note: the
  Worker Loader already proves dynamic workers + confined code — build on it.
- **R5 — Control plane vs iterate-product interface.** The minimum elegant seam: generic CP
  (ingress/egress/routing/wall/directory/mcp) + a product layer that supplies first-party secrets +
  integrations, off-by-config in self-host. Scaffold + document.
- **R6 — Two web apps.** Control-plane web app vs Tasks-style dashboard. Document the split; scaffold if
  time.
- **R7+ — Thermonuclear reviews** (multiple rounds).

## Import feasibility reality (from reuse-feasibility.md, already researched)

The apps/os DO **classes** (`StreamDurableObject`, `RepoDurableObject`) are welded to `rpc-targets.ts`
(7,667 LOC / 87 imports) + the full os `Env` and **cannot import unmodified** into the pure-play kernel.
The stream **engine** (`stream-storage.ts` + 5 helpers, ~1,750 LOC, zero Env/itx coupling) IS importable.
So the honest approach: reuse the engine, hand-roll thin kernel-native DOs around it. I'll spike an
actual import early to confirm/deny in THIS kernel's build, and log the result. "Import from apps/os"
may mean "import the clean engine", not "import the class".

---

## Timeline

### R1 — Egress + secret substitution (both levels) ✅ DONE + PROVEN LIVE

**Built** `src/egress.ts` — the two-level chained egress door:

- `substituteHeaderSecrets(request, scopes, resolve)` — replaces `{{secret:project:NAME}}` /
  `{{secret:platform:NAME}}` tokens in request headers; only the scopes a door owns; unresolved tokens
  left intact for the next door.
- **Project door** (`projectEgress`) — substitutes the project's own secrets (KV `secret:<projectId>:<name>`,
  write-only from userspace), then chains into…
- **Control-plane door** (`controlPlaneEgress`) — substitutes **platform / first-party secrets** (the
  ITERATE-PRODUCT layer, `AppConfig.platformSecrets`), **origin-pinned** (substitutes only for an
  allow-listed destination — anti-exfiltration) and **metered** (a KV counter — the billing hook).
- Wired into `ProjectEntrypoint.fetch` (the one `globalOutbound` door) + added `ProjectEntrypoint.setSecret`.
- `config-worker.ts` `/__egress` path drives the live proof (sets a project secret, fetches an echo with
  3 placeholders).

**Decisions:**

- **The elegant CP↔iterate-product seam = the platform-secret door.** `AppConfig.platformSecrets` is the
  entire iterate-product surface for secrets: present ⇒ iterate-product deployment; absent/[] ⇒ generic
  control plane (self-host). Off-by-config, exactly ADR 0030. No code fork.
- **Placeholder-in-headers convention** (`{{secret:scope:name}}`) — mirrors apps/os's `getSecret(...)`
  placeholder idea but header-scoped and stringly-simple. Secrets ride in headers; bodies untouched.
- **Two scopes, isolated:** a project secret can NEVER resolve a `platform:` token (proven by test) —
  the project store and the platform config are separate resolvers behind separate doors.
- **Origin-pin is the anti-exfiltration primitive** (copied from apps/os `platform-secrets.ts`) — without
  it a malicious userspace worker could ship a first-party key to an attacker origin.

**Proven:** 7 unit tests (scope isolation, origin-pin, metering, two-level chain) + **LIVE** on
`kernel-selfhost` (shiterate.com): `egress-demo.shiterate.com/__egress` → httpbin received
`X-Platform: Bearer PLATFORM-KEY-abc123` (platform, origin-pinned), `X-Project: PROJ-SECRET-123`
(project), `X-Unresolved: {{secret:platform:nope}}` (intact); anti-exfil verified against non-allowlisted
postman-echo (platform token NOT leaked); **meter counter = 1** (only the substituted use counted).
36 tests total green.

**Limitations logged:** KV meter is best-effort (read-modify-write races → a DO-backed meter is the real
fix); secrets are plaintext in KV (a real deploy wants encryption / a Secret DO like apps/os).

### R2 — Streams: the durable log ✅ DONE + PROVEN LIVE

**Built** `src/stream-do.ts` — `StreamDurableObject` (SQLite append-only log, ~40 lines): `append(type,
data) -> seq`, `read(fromSeq) -> events[]`, `count()`. One DO instance per `(projectId, path)`, addressed
by name `<projectId>::<path>` from the unforgeable projectId prop (a project can't reach another's streams).
Exposed via `ProjectEntrypoint.streamAppend/streamRead` (the confined config-worker path); `config-worker`
`/__stream` drives the proof. Kills the `processEvent` stub's emptiness — there's now real storage.

**Import decision (answers Jonas's "hopefully import from apps/os"):** the apps/os `StreamDurableObject`
CANNOT import into the pure-play kernel (welded to `rpc-targets.ts` — confirmed in reuse-feasibility.md).
Its storage ENGINE (`stream-storage.ts`) _is_ clean but importing it drags `sqlfu` + the `iterate`
workspace package into the dependency-free pure-play kernel. **Decision: a ~40-line native SQLite DO proves
the topology (the actual goal) and keeps the kernel dep-free.** Engine reuse is a migration-time
optimization, deferred — NOT needed to prove streams work across deployments. (Same call will apply to
repos.)

**Platform gotcha discovered (cost ~2 deploys):** wrangler **named environments do NOT inherit top-level
`durable_objects` / `migrations`** (nor kv/secrets/worker*loaders — that's why they're repeated per-env).
The DO was bound top-level but absent in `env.selfhost`, so `env.STREAM_DO` was undefined at runtime
("no STREAM_DO bound") while local unstable_dev (which uses the top-level-ish test config) worked. Fix:
repeat `durable_objects` + `migrations` in EVERY env block (selfhost/dev/personal + wrangler.test.jsonc).
*(Worth a memory: "wrangler named-env configs inherit almost nothing — repeat every binding block.")\_

**Proven:** 1 e2e test (append persists across requests + per-project isolation) + **LIVE** on
`kernel-selfhost`: `stream-demo2.shiterate.com/__stream` appended 5 events across many separate HTTP
requests → read back `count:5, seqs:[1,2,3,4,5]` (monotonic, durable across requests AND a redeploy).
37 tests green. Note: subscribe is poll-based (read fromSeq); WebSocket fan-out deferred (not needed yet).

### R3 — AI as a PER-CAPABILITY-SOURCED capability ✅ DONE + PROVEN LIVE

**Built** `ProjectEntrypoint.aiRun(prompt)` + `AppConfig.ai` sourcing knob:

- `ai.source: "local"` → the project worker's own `env.AI` (Workers AI, its account).
- `ai.source: "remote"` → dispatch to a configured endpoint with `authorization: Bearer
{{secret:platform:<name>}}` **through `controlPlaneEgress`** — substituted + origin-pinned + metered.

**The elegant unification (the key architectural finding tonight):** _remote-sourcing a capability IS
egress through the control plane with a first-party secret._ AI-remote, Exa, Parallel, any metered
first-party API — all the SAME mechanism (R1's control-plane door). So "per-capability sourcing" (M3) and
"first-party metered secrets" (R9) are not two features — they're one: **a capability's `remote` source is
a metered platform-secret egress.** This collapses two roadmap items into one door. Storage-shaped caps
(streams/repos) stay local (follow the project worker); service-shaped caps (ai/search/…) get the knob.

**Proven:** LOCAL live on `ai-demo.shiterate.com/__ai` → real Workers AI returned "Blue". REMOTE branch is
`controlPlaneEgress` — already proven LIVE in R1 (substitution + origin-pin + meter), so covered by
construction. `config-worker /__ai` drives it. 37 tests green (no new unit test — remote path shares R1's
tested door; noted as a small gap). Self-host default committed as `ai.source=local` (your own AI).

### R4 — Script execution + dynamic capabilities ✅ DONE + PROVEN LIVE (both official tools)

**Built** `src/dynamic.ts` + 4 new MCP tools (control-plane-driven, the os `exec_typescript` model):

- `execScriptInProject` — runs an arbitrary `async (itx,args) => …` string CONFINED, via the SAME Worker
  Loader that runs the config worker (only `env.ITX` + the egress door bound). Dynamic workers + script
  execution fall straight out of the loader we already had.
- `capabilityRegistry` — `provide(name, code)` / `code(name)` / `list()` over KV
  (`capability:<projectId>:<name>`). **Event-shadowing rule enforced:** `provide` rejects any
  `BUILTIN_CAPABILITY_NAMES` — a dynamic capability can never shadow a builtin (ADR config- vs
  event-shadowing).
- MCP tools: `run_script`, `provide_capability`, `invoke_capability`, `list_capabilities` — advertised
  only when the deployment passes a scripting facade. Wired in `handleMcp` using `ctx.exports.
ProjectEntrypoint` (the confinement mint) + `env.LOADER`; every op resolves the project through the
  directory first (membership gate).

**Decisions:**

- **Script execution lives on the CONTROL PLANE (MCP), not inside the project worker** — it needs
  `ctx.exports` + the loader (kernel-level), and "run code across projects" is a control-plane power. Same
  reasoning as MCP itself (ADR 0022). A project's OWN config worker is already dynamic code; `run_script`
  is the _ad-hoc_ version driven from outside.
- **Dynamic capability = a stored script + the exec path.** `invoke` = load code from the registry, run it
  via `execScriptInProject`. Minimal, and it reuses exec entirely. (apps/os's capability host adds
  prefix-resolution + mounts; deferred — not needed to prove the idea.)
- **Confinement is identical to the config worker** — a run_script script sees only `env.ITX`; it can call
  streams/ai/secrets through it but touches no raw binding.

**Proven:** 2 unit tests (registry round-trip + builtin-shadow rejection) + 3 e2e (run_script→whoami,
provide→invoke add=5, scripting tools in tools/list) + **LIVE** on `kernel-selfhost`:

- direct: `run_script async (itx)=>itx.whoami()` → `{projectId:"exec-demo"}`; `invoke add(7,8)` → `15`.
- **official MCP Inspector CLI**: `run_script` → `{pid:"exec-demo", sum:42}`.
- **Claude CLI** (`--mcp-config`): drove `run_script` → `itx.streamAppend('cli-log',…)` → **seq 1** — ties
  Claude CLI → MCP → script exec → confined ITX → the R2 durable log, all live in one call.
  42 tests green.

### R7 — Thermonuclear reviews (3 parallel adversarial reviewers) ✅

Three lenses: simplify/collapse · apps/os-trajectory · security/correctness. Full findings folded into
`morning-brief-2026-07-31.md`. Headlines:

- **Security (CRITICAL, live-exploitable):** anonymous internet caller could `run_script` in ANY project
  on open/local/kv deployments — the directory's `access()` ignores the caller for 3 of 4 providers, and
  `/mcp` is reachable on hosts Cloudflare Access doesn't front. Fixed in R8. Also: project secrets not
  origin-pinned (exfiltratable — mostly closed by the R8 auth gate); redirect-follow leaks platform
  secrets on custom headers (fixed).
- **Simplify:** the two project surfaces (capnweb `Project` control-verbs vs flat `ProjectEntrypoint`
  runtime methods) don't overlap — the promised `project.streams.get(path)` tree was never built. Unify
  into ONE RpcTarget tree. Fold secrets+capabilities+meter into the stream DO ("everything is the
  project's durable state"; the meter = count of egress events). → morning brief.
- **Trajectory:** the native stream DO is a DIFFERENT CONTRACT from apps/os (no offsets/idempotency/
  reduce/subscription-cursors) — "processEvent killed" is wrong, it's ABSENT. De-risk: adopt apps/os's
  `StreamEventInput`/offset contract + do the `stream-storage.ts` verbatim-import spike SOON. → morning brief.

### R8 — Fix the critical security findings ✅ + PROVEN LIVE

- **Scripting requires auth on a walled deployment** (`scriptingAllowed({walled, authenticated})`,
  dynamic.ts): walled + anonymous ⇒ scripting facade withheld (tools hidden + calls refused); wide-open
  (no wall, LAN/Pi) ⇒ on by design. Unit-tested. **Live-verified:** anonymous `/mcp` on walled selfhost
  now shows only `list/create/get_project`; `run_script` → "unknown tool".
- **`redirect: "manual"` at the control-plane egress door** — stops a pinned origin 302-ing a platform
  secret to an unpinned hop.
- Exec cache key now includes code length (djb2 collision hardening).
- 45 tests green. Deferred (in brief): membership-gate `create_project`/`list` for walled multi-tenant;
  per-secret origin-pin for project secrets; stronger content digest for exec cache.

---

## Continuation 2026-07-31 (D-C → D-B → D-A → security → two-worker split)

### D-C — Group product config under `AppConfig.product` ✅ DONE + LIVE

Moved `platformSecrets` from top-level into `AppConfig.product` (grows to hold integrations + billing).
The seam is now a boundary: **"generic control plane" = config with no `product` key.** Refs updated to
`cfg.product?.platformSecrets`. selfhost APP_CONFIG nests it under `product`. 45 tests green; live-verified
on `dc-verify.shiterate.com/__egress` — platform secret still substitutes from `product.platformSecrets`.

### D-B — Adopt apps/os's canonical stream contract ✅ DONE + LIVE

**Import spike result:** the storage _engine_ (`StreamEventLog`) lives in apps/os (not exported from the
`iterate` package) — NOT importable into the pure-play kernel. BUT the **contract types** (`StreamEvent`,
`StreamEventInput`, `StreamOffsetConflictError`) ARE exported from `iterate/processors` and import cleanly
(type-only ⇒ zero runtime dep, kernel stays pure-play). So the right move: adopt the CANONICAL contract
type directly and implement storage against it — better than copying stream-storage.ts.

- Added `iterate` (workspace) as a type-only dep; dropped `sqlfu` (unused — engine not imported).
- `stream-do.ts` rewritten: `append(input: StreamEventInput) -> StreamEvent` with **offset** (autoincrement,
  survives eviction via `sqlite_sequence` — the `highestAssignedOffset` semantics), **idempotencyKey**
  (UNIQUE — re-append returns the committed event, no new row/offset), **ephemeral** (`true|undefined`),
  ISO-string `createdAt`, `path`. Table `events(offset,type,created_at,idempotency_key,ephemeral,payload,
metadata,source)`.
- **Deliberately stubbed** (the delivery spine): subscription cursors / park-resume / obligations /
  reduce-fold / offset-conflict CAS. `read(afterOffset)` is poll-based replay. The kernel's stream
  _interface_ is now the real one; only _delivery_ is stubbed — future migration is a drop-in, not a rewrite.
- 46 tests green (added idempotency-dedup e2e). **LIVE** on `db-verify.shiterate.com`: offsets [1,2]
  monotonic; `idem=KEY9` twice → same offset 1, count stays 1; ISO createdAt + path present.

### D-A — Unify the two project surfaces into ONE nested capability tree ✅ DONE + LIVE

Before: two disjoint surfaces — the capnweb `Project` (control verbs only: projectId/create/mapHostname)
and the flat `ProjectEntrypoint` (streamAppend/aiRun/setSecret…); the promised tree was never built.

- **New `capabilities.ts`**: `ProjectCapabilities` (RpcTarget) with getters `streams`/`secrets`/`ai` →
  `StreamHandle`(append/read) · `Secrets`(set) · `AiCapability`(run). capnweb's RpcTarget IS the
  cloudflare:workers one, so the SAME class tree serves both transports; nested getters promise-pipeline.
  Standalone `makeMeter(kv)` (floats the KV write — no ExecutionContext needed, so one meter serves both
  paths).
- Wired into BOTH doors: the capnweb `Project` gained `get streams/secrets/ai` (threaded `env` through
  Os→Session→ProjectCollection→Project); `ProjectEntrypoint` reduced to `whoami` + the egress-door `fetch`
  (the ONLY thing that must stay a real Fetcher.fetch — WS upgrades) + the same three getters. Flat
  `streamAppend/streamRead/setSecret/aiRun` DELETED.
- `BUILTIN_CAPABILITY_NAMES` now the tree's top-level members (whoami/fetch/streams/secrets/ai) — closer
  to derivable-from-the-tree (the hand-mirror shrinks). config-worker uses `env.ITX.streams.get(path)
.append()` / `.secrets.set()` / `.ai.run()`.
- 46 tests green. **LIVE** on `da-verify.shiterate.com`: streams (2 events via the tree), secrets+egress
  (X-Project + X-Platform substituted), ai.run → "Blue" — all through the nested tree, pipelined over the
  loopback. `/api` capnweb `Project` exposes the identical tree (same class; covered by construction).

### Security follow-ups (post-D-A) ✅ DONE + LIVE

Closed two of the deferred R8 items:

1. **Optional origin-pin for PROJECT secrets** (egress.ts): `secrets.set(name, value, allowedOrigins?)`.
   Stored as `{value, allowedOrigins?}` (legacy bare strings still resolve = unrestricted). A pinned secret
   substitutes at egress ONLY for an allow-listed destination — a script can't exfiltrate it elsewhere.
   Unpinned = substitutes anywhere (the project's own footgun; the R8 auth gate stops an anonymous
   attacker acting AS the project). 3 unit tests.
2. **`create_project` write-authority gate**: walled + anonymous ⇒ refused (same `scriptingAllowed` rule
   as the scripting facade; consolidated). The authenticated "emerge with a project" flow is unaffected.
   **LIVE:** anonymous create on walled selfhost → "create requires authentication on a walled deployment".
   48 tests green; egress regression-checked live.
   **Still open (bigger, documented in morning-brief):** secrets plaintext in KV (want encryption/Secret DO);
   KV meter races (DO-backed — overlaps deferred D-D); exec cache key content-digest; and the deeper
   `auth`-directory org-membership check on create (needs an auth RPC).
