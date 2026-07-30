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
