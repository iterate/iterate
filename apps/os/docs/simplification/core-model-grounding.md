# Core model — grounding (verbs, the wall, size)

> **Purpose.** Pin down the irreducible core of an iterate project — the small set of
> "verbs" + the egress wall — and dissolve the rest into provided capabilities. Every
> open question here is answered from the **current codebase** (Jonas, 2026-07-15:
> "answer all your own questions with the current state of the codebase; use markdown
> files to keep track"). Companion to `DESIGN.md`. Grounding by a 5-agent code audit.

## The claim under test — **CONFIRMED**

The _durable_ core is a handful of verbs + one wall; the "it feels too heavy" weight is the
hardcoded `itx` surface (the **6,014-line `rpc-targets.ts` god-object**), which `DESIGN:D21`
plans to melt into provided capabilities. "Simplify" = run that migration, not redesign the
primitives. **The migration path is already proven by `integrations`** (see §A.5).

## Jonas's answers to the 7 questions (2026-07-15)

- **Q1 mount →** it's **`provideCapability`**; **live capabilities** stay. ✅ (§A)
- **Q2 repo core? →** probably just a provided capability; `itx.fetch` may route through it. (§A.5, §D)
- **Q3 writers →** `append` + `commitFiles` + `files.create`; `fetch` changes nothing itself.
  OPEN: system vs third-party? blobs uniquely referenceable? ✅ answered (§D)
- **Q4 wall observable →** YES; observability-from-within is critical. ✅ (§C — with a gap)
- **Q5 size →** ~50k LOC without comments. ✅ answered (§E — that's the _surface_, spine ~10k)
- **Q6 7th verb →** YES, `schedule`/`alarm` is key, already built. ✅ (§B)
- **Q7 where capability code runs →** three homes. ✅ (§A.3)

---

## Grounding from the code

### A. Capabilities — `provideCapability` (not "mount")

- **The verb:** `provideCapability(input)` (`rpc-targets.ts:3961`, shortcuts at `:4320`/`:3156`)
  appends `events.iterate.com/capability-host/capability-provided`
  (`capability-host-processor-implementation.ts:378`). ("mounted" survives only in prose.)
- **Two kinds** (`capability-host/types.ts:73`):
  - **`live`** — a real value (fn/object), held in an **ephemeral in-isolate map**
    (`…implementation.ts:141`), **session-bound**: calls travel the provider's connection and
    fail `"offline"` when it disconnects (`contract.ts:528`). This is the kind that **should
    keep existing** — the durable one can't replace it.
  - **`itx-expression`** — a **durable** recipe (a walk over the itx surface, `itx/expression.ts:21`),
    re-evaluated against the scope's own itx on every call. "Persisting the **NAME** of a
    capability, never its authority… deleting the stored expression is revocation" (`expression.ts:5-9`).
- **A.3 Where the code runs (three homes):** `live` → **back in the provider's process**
  (browser tab / laptop); `itx-expression` → wherever the leaf runs (evaluated in the
  capability-host DO against `this.#itx`); **`runScript`** → a **loaded dynamic-worker isolate**,
  _not_ the DO (`capability-host-durable-object.ts:78`), with `env.ITX` bound back.
- **A.4 Isolation — airtight to the providing project.** Keyed `{projectId, path}`; a lookup
  miss chains **only up** the same project's scope tree (agent → namespace → project root,
  `…durable-object.ts:91-104`), **never sideways / cross-project**; an expression can't even name
  its own mount path. Revoke is **offset-keyed** (removes exactly that mount) + disposes retained stubs.
- **A.5 The migration is already proven.** Built-ins (`streams`, `repo`, `agents`, …) are
  **hardcoded and always shadow dynamic mounts** — `rejectBuiltinCollision` +
  "a dynamic capability can **never** shadow a built-in name; the built-in always wins"
  (`rpc-targets.ts:4114-4124`, `:3962`). **BUT `integrations` already shows a hardcoded branch and
  a provided `itx-expression` mount sharing ONE address shape**: unknown slugs resolve through
  the capability table (`:2420`), and the describe prose tells userspace to add its own via
  `provideCapability({ path: ["integrations","<slug>"], … })` (`:2466`). → Re-expressing a fat
  branch as a provided capability is feasible; the only asymmetry is the builtin-wins rule.

### B. Scheduler — the 7th verb, `itx.scheduler`

- **The verb:** `itx.scheduler` (= `schedulers.get("/scheduler/primary")`, `rpc-targets.ts:4437`),
  `itx.schedulers.get(path)` for any `/scheduler/**`. Methods: **`set / cancel / trigger / list`**
  (`:744-771`). You schedule an **itx-script** against `{ at } | { in } | { every } | { cron }`
  (`recurrence.ts`).
- **Fires by pure event-sourcing** (no side table): `alarm()` → append **`trigger-requested`** →
  re-ingest → `processEvent` → invoke the script (latest-code-wins) → append **`trigger-completed{outcome}`**
  (`scheduler-processor-implementation.ts:186-212`, `:344-384`). At-least-once.
- **`alarm()` is the single internal time trigger the whole system rests on** ("the only wake
  source the scheduler needs while hibernated", `scheduler-durable-object.ts:31`) — confirms
  `DESIGN:D18` (alarm = one of the two entry points). Durable across eviction/redeploy (shared
  platform alarm + 15-min heartbeat + restart sweep re-launches orphaned triggers).

### C. Observability — strong for metrics/traces, **a real gap on egress**

- **Metrics: strongly observable, first-class itx surface.** `stream.runtimeState()` /
  `getProcessorRuntimeState()` (`itx-api.generated.ts:1086-1109`) return **honest, never-synthesized**
  rates / p50-p95 latency / lag / bytes / mutual-ping RTT (60×1s series). Subscribers self-report
  round-trip consumption (`subscriber-metrics.ts`).
- **Errors: observable where a domain emits them as events** (LLM failures carry `error.message`,
  `agent-processor-contract.ts:294`; per-subscription `lastError`/`parked` via `runtimeState`).
  **GAP:** no project-wide error stream; internal `console.warn/error` is **invisible to userspace**.
- **Egress observability — PARTIAL, and this is the real gap vs "everything observable".**
  Held/denied attempts become **rich durable `human-approval-*` events** (method/url/headers/
  body-hash+preview/secretPaths/outcome, `egress-approvals.ts:75-89`). **But allowed egress leaves
  NO trace** — `if (rules.length === 0) return this.#egress(request)` (`project-durable-object.ts:241`):
  no rule ⇒ straight through, no event, no log. **A project cannot enumerate all bytes that left —
  only what its own rules caught.** (So "the wall is definitely observable" is true for _gated_
  egress, aspirational for _allowed_ egress.)
- **LLM trace: full, by replay.** The inspector rebuilds every request+response by pure fold over
  committed events, zero storage (`llm-request-inspector-panel.tsx:20-31`).

### D. Files & the system boundary

- **`itx.files` is R2, addressed by MUTABLE path** `{projectId}.iterate{path}`, last-write-wins,
  "no versioning, no listing, no quotas" (`project-files.ts:23-25`). → **Blobs are NOT
  content-addressed / not uniquely referenceable** (a re-upload overwrites).
- **Content-addressing exists only for worker BUILD artifacts** (`artifact-store.ts:1-9`,
  `build-key.ts:64-76` — immutable, hash-keyed, "same input, same key"). So: build artifacts ARE
  uniquely referenceable; `itx.files` blobs are not. _(If you want content-addressed blobs, that's
  a change to `itx.files`.)_
- **Writers:** `append` (streams) + `commitFiles` (repo) + `files.put` (R2) are the **primary**
  app-data writers — **but not the total set:** also `secrets.update`, the build-artifact cache,
  and the capability-host table are durable-state writers.
- **The boundary IS the wall — confirmed, by tenancy.** In-system = everything keyed
  `{projectId}.iterate{path}` and project-confined (streams, repos, R2 files, secrets DOs,
  capability hosts — `README.md:37-39`). Third-party = reached **only** via `itx.egress.fetch`
  (allowlist + audit). **One blur:** GitHub-linked repos are an in-system store that **mirrors out**
  to a third party (`rpc-targets.ts:858`).

### E. The real verb set + LOC — spine ~10k, surface ~40k

- **~30 itx roots** fan into **~175 type nodes**. **Genuine core primitives:** the stream
  **event log** (`streams`/`append`/`getEvents`/`subscribe`/`waitForEvent`/`acceptCrossPost` ≈
  **5–6 verbs**, `stream-durable-object.ts:224-1127`), **reduced processor state**, the
  **capability-host mount table**, **egress**, and **dynamic-worker dispatch**. Everything else
  (integrations, email, sandboxes, mcp, openapi, ai, browser, files, scheduler, workspaces, docs)
  is **hardcoded userspace surface**. → **the "~6–7 verbs" claim holds for the event log.**
- **LOC (raw / no-comment):** `rpc-targets.ts` **6014 / 4061** (the god-object) ·
  `stream-durable-object.ts` 1307 / **614** (53% comments) · mint chain **~200 total** (zero
  per-scope branching) · egress ~380.
- **Whole hand-written `src` = 78,231 lines** (+27,915 tests, +5,297 generated). **Core spine
  ≈ 9–14k (~18% of src).** → **The ~50,000-LOC-without-comments target is the SURFACE, not the
  spine.** Melting the god-object into provided capabilities **relocates ~40k of surface into
  userspace**, dropping the _platform_ core toward **~10–15k**. So the number doesn't shrink to 5k;
  it _splits_ into a tiny platform spine + a userspace surface.

---

## Answers to the 3 conceptual questions (code-informed)

1. **Is "the system" defined by the wall?** — **Yes, essentially.** The code draws the line by
   tenancy: in-system = `{projectId}.iterate{…}` (streams/repo/R2/secrets/capabilities);
   third-party = across `itx.egress.fetch`. The one exception to decide on: **GitHub-mirrored
   repos** (in-system store that fans out to a third party).
2. **Is `repo` core because un-revocable?** — **Today, yes by construction:** `repo` is a
   **built-in**, and built-ins **can't be shadowed or revoked** (they always win over the mount
   table). Provided capabilities **can** be revoked (offset-keyed `revoke`); built-ins can't. So
   **the built-in / provided-capability split IS the un-revocable / revocable line.** If `repo`
   became a provided capability, a project could revoke its own hands — so keeping it built-in is
   what makes self-modification un-revocable. _(Decision for Jonas: keep `repo` built-in.)_
3. **What does 50k cover?** — **The whole of `apps/os` (spine + surface).** The spine alone is
   ~10k. The migration _relocates_ the surface to userspace, it doesn't delete it.
