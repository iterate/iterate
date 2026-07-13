# apps/os architecture & code review — July 2026

Reviewed at `f94fc74f0` (post itx-v4 #1585, single-worker #1636, capability-host
#1624), then **rebased onto `origin/main` at `2e33cc925`** and every affected finding
re-verified against the merged tree. The five commits merged in — #1612 (dynamic
worker build pipeline), #1651 (stream-feed raw-event inspector + stream-view
decomposition), #1654 (per-agent sandboxes + MITM egress), and two smaller ones —
moved several findings; the changes are called out inline (⟳ marks a finding the
merge altered) and summarized in §0.

Produced by a review workflow — 14 whole-tree lens critics (layering, collapse,
duplication, path-tracing ×3, state, config, types, failure semantics, docs drift,
dead code, test shape, narrative), 12 subsystem deep-readers, and a dedup pass —
roughly 9M tokens of agent reading across resumes. The adversarial-verification
and completeness stages were curtailed by account quota partway through, so the
findings below are **not** machine-verified end to end; instead **every `file:line`
cited was hand-checked against the merged tree by the reviewer** before inclusion.
Treat citations as verified and severity ordering as the reviewer's judgment.

## 0. What the `origin/main` merge changed

- **#1651 already deleted ~3.9k of the dead code an earlier draft flagged** — the
  entire `packages/ui/src/components/events` feed cluster, including `stream-feed.tsx`
  (988) and `stream-view-reducer.ts` (653). §4 and §6 are updated; the stream view was
  decomposed into `apps/os/src/components/*` with a real raw-event inspector, which
  also softens one §3.8 sub-point.
- **The `pnpm-workspace.yaml` `src/next` reference is gone** — dropped from §4.
- **#1612 (builder sidecar: `apps/os/src/domains/workers/{builder-entrypoint,
artifact-store,materialize,source-masks,build-key}.ts`) and #1654 (per-agent
  sandboxes) are new subsystems that were not in the reviewed tree.** This review does
  not cover them in depth. A targeted spot-check found they do **not** reproduce the
  self-dial (§3.2) or fold-from-zero (§3.5) anti-patterns — the perimeter is not
  worsening on those two axes — but a proper read of both is follow-up work.
- Everything else re-verified unchanged: `rpc-targets.ts`, `ingress.ts`,
  `integration-api.ts`, `mcp-handler.ts`, the stream substrate, the agent processors,
  `types.ts`/`types-source.generated.ts`, `path-proxy.ts`, and the drifted docs were
  untouched by the merge, so those findings stand as written.

Three questions, per the brief:

1. What is the **narrative** — the key ideas this system is trying to prove?
2. Where are there **too many lines** for what could be much simpler?
3. More importantly: where is the architecture **spaghetti rather than onion** —
   where could entire abstractions fall away?

The one-paragraph verdict: **the core engine is in unusually good shape** — the
value-level import graph of `apps/os/src` has zero cycles, authority genuinely flows
through one door, and the stream doctrine is real, not aspirational. The rot is
almost entirely at the **perimeter**: predecessors that were superseded but not
deleted (~14–16k dead LOC, after #1651 cleared ~3.9k of it), docs that narrate the
previous two architectures, and a handful of places where the code still behaves as
if the multi-worker split existed.
The one **architectural** gap that matters is failure semantics: event _delivery_ has
one excellent convention, but side-effect _execution_ has quietly become three
different consistency regimes, and two of them re-create the class of incident
(2026-06-10 deploy-evicted agent turn) the design set out to kill.

---

## 1. The narrative — what this system argues

This is what the code itself says it is trying to prove, reconstructed from the tree
(not from the docs, several of which describe earlier drafts of the argument).

**One worker is the whole product.** `src/worker.ts` (183 lines) exports the fetch
handler and all eight Durable Object classes — Agent, CapabilityHost, Project, Repo,
Secret, Stream, StatefulWorker, CloudflareSandbox. There is no service mesh, no
cross-script binding, no bootstrap ordering. Deployment is one upload; `envs.ts` at
the repo root is the single typed map of every environment, and Doppler holds only
secrets.

**Every durable thing is a stream, and state is a fold of it.** Each DO is named
`{projectId}.iterate{path}` and its state is `reduce(events)` from its own journal.
Creation is itself an event (birth certificates); checkpoints `{offset, state}` are
disposable caches (`CORE_STATE_VERSION` bumps have reset them repeatedly, on
purpose). The doctrine — side effects only in `processEvent`, idempotency keys,
`blockProcessorWhile` for durable obligations, requested/completed event pairs,
by-reference LLM requests where the request event's offset _is_ the request id — is
written down in `docs/domain-objects-and-stream-processors.md` and, unusually, the
code mostly practices it.

**DOs are shells; processors are the program.** The DO classes are 80–150-line
shells that register `StreamProcessor`s on one shared host. The interesting code is
pure folds plus `processEvent` handlers, which is why the heaviest unit tests in the
repo (`slack-processors` 871 lines, `agent-processors` 816) run real processors
against ~80-line in-memory stream fakes and catch real regression classes (webhook
replay, LLM debounce, DO-restart recovery) with no network.

**Security is object-capability, not middleware.** `authenticate()` is the sole
authority door. After it, authority is _holding an RpcTarget whose constructor
asserted access_ — there is no ambient session to re-check, and confinement is by
construction: a stub scoped to a project cannot express a reference outside it.
`ItxAuthContext` is either admin or a set of project ids, and everything else is
capability plumbing.

**itx is a naming convention, not a class.** One `ProjectRpcTarget` serves both the
project root and agent scopes, differing only in the injected `capabilityHost.path`.
Built-ins resolve in-isolate; unknown dotted paths fall through a proxy
(`withInvokeCapabilityFallback`) to the CapabilityHost DO, which resolves by longest
prefix, chaining child→parent — _reads chain up, writes stay local_. Everything
answers `__describe()`, generated from provide-time metadata, so the tree is
self-documenting at every node.

**Agents are just streams plus processors.** An agent is a stream at a path, a
processor that folds its journal into a transcript, and by-reference LLM requests.
Untrusted code runs in Worker Loader isolates with an `env.ITX` loopback and egress
via placeholder substitution — secrets never enter the sandbox; the placeholder is
swapped at the egress proxy.

**The browser is a second host of the same engine, not a second engine.** The
dashboard's stream store runs the same fold code over OPFS, mirroring journals
locally; the UI reads folds, not endpoints.

Two more ideas function as house law and are the right lens for judging the findings
below: **conventions over frameworks** (N rhyming imperative implementations over
spec-objects interpreted by generic machinery — the integrations domain is the
proof), and **capture verbatim, select downstream** (ingress appends everything;
filtering at the door is forbidden).

These are good ideas, coherently held. The review's job is to find where the code
stops practicing them.

---

## 2. What holds up — including what we tried to break and couldn't

An adversarial review is only trustworthy if it reports the attacks that failed.
Each of these was raised as a suspected problem by at least one critic and then
**refuted** on the tree:

- **"There's a D1 catalog behind agents.list."** No — `agents.list` is a fold of
  project processor state (`src/rpc-targets.ts:433` area). The D1 projections died
  with itx-v4 and are genuinely gone.
- **"There are two data planes / two project-create paths."** No — creation goes
  through one path (`session.projects.create`); the auth↔D1 drift wedge from the
  earlier design is resolved by reconcile-on-recover.
- **"The dashboard's two-plane split (server fns vs itx WebSocket) is spaghetti."**
  No — it is a deliberate, clean split: server functions for request-scoped reads,
  the capnweb socket for live capability access. Refuted as a problem; keep it.
- **"capnweb workarounds are smeared everywhere."** No — the fork quirks
  (no-`then`-probe, `getOwnPropertyDescriptor` traps, dup/retain/dispose discipline)
  are concentrated in a few files and pinned by `browser-repl.test.ts` (618 lines).
- **"Dynamic-worker cacheKeys are random."** No — stable content-version keys
  (the loader-isolate-cap incident fix held).
- **"The DIALABLE_LOOPBACKS three-point wiring trap still exists."** No — the trio
  is now co-located in `src/domains/itx/utils.ts:53-107` next to
  `ctx.exports.ItxEntrypoint`; the "passes typecheck, fails at runtime" failure mode
  is structurally gone.
- **"Both deploy command forms in the docs are broken."** No —
  `scripts/lib/deploy-app.ts` falls back to `DOPPLER_CONFIG` when `--env` is absent;
  both forms work.
- **"The test corpus is bloated."** The opposite — see §6; the earlier 2:1 census
  was wrong by ~5×. apps/os runs at ~0.4:1 test-to-src.

Also genuinely strong, and worth saying plainly:

- **Layering is a real onion.** `worker.ts` → ingress → rpc-targets → domains →
  packages, with **zero cycles in the value-level import graph**. The one
  intentional inversion (rpc-targets importing domain engine facades) is documented
  below as optional cleanup, not rot.
- **`slack-webhook-api.ts`** carries a ~70-line comment that is the single best
  piece of doctrine writing in the repo (the 404-auto-disable incident, ACK-200-and-
  drop, capture-verbatim). The integrations domain overall proves the
  conventions-over-frameworks thesis: rhyming imperative flows, incident-hardened
  durability (`blockProcessorWhile` on the Slack forward), no generic machinery.
- **The examples matrix** (one catalogue × four server runtimes + REPL) and the
  87-line e2e `test-helpers.ts` are callsite purity done right: tests hold bare
  capnweb stubs from the product's own `connectItx`.
- **Production test surface is tiny and documented** — `e2e-fixtures.ts` is 146
  lines of stateless canned responses with a comment citing the `__internal/debug`
  incident and forbidding statefulness; the impersonate lane is admin-gated
  de-escalation.

---

## 3. Spaghetti, not onion — where abstractions should collapse

Ordered by how much they matter, not by size.

### 3.1 Side effects have three consistency regimes; two re-create the 2026-06-10 incident class

**The finding.** Event _delivery_ has one convention and it is good. Side-effect
_execution_ has silently forked into three regimes:

1. **At-least-once (correct):** `blockProcessorWhile` + idempotency keys — the
   Slack forward, the project-create saga. Crash → replay → keys dedupe. This is
   the doctrine working.
2. **At-most-once (wrong for its cargo):** `runInBackground` +
   requested/completed event pairs, where **nothing ever reads
   started-but-not-completed evidence after a crash**. The two most valuable
   effects in the product ride this lane: LLM calls and script executions. A
   deploy-time DO eviction mid-call leaves the agent wedged at phase `requested`
   forever — settle-style recovery exists but only recovers `scheduled`
   (`src/domains/agents/agent-processor-implementation.ts:146-178` area), and no
   consumer of the stream/woken signal scans for stale `requested`. This is the
   **2026-06-10 prd incident** (deploy evicted a SlackAgent DO mid-run; the turn
   never replayed) rebuilt into the new architecture with new names.
3. **At-most-once-ever (worst, and load-bearing):** the stream core's own
   `#runInBackground` ancestor announcements and cross-posts fire once with no
   journal evidence at all — a crash between append and announcement loses them
   permanently. Announcements are load-bearing: `agents.list` is folded from them.

**Why this is the top finding.** It is not a bug hunt item; it is the _architecture_
failing to say which guarantee a side effect gets. The doctrine document says
"requested/completed pairs" as if the pair itself were the guarantee — but a pair
without a stale-`requested` scanner is just at-most-once with better bookkeeping.

**The collapse.** One rule: _every_ side effect is either (a) inside
`blockProcessorWhile` with an idempotency key, or (b) a requested/completed pair
**plus a recovery scan** that re-drives stale `requested` on wake. For agents that
scan is ~30–40 lines next to the existing settle recovery
(`agent-processor-implementation.ts:146-178`); for ancestor announcements, make the
announcement an appended obligation (an event the processor retries) rather than a
fire-and-forget call. Then delete the third regime — it should not exist.

### 3.2 The worker still HTTP-dials itself: three `engineBatchSession` copies

Three separate copies of the same private helper POST a capnweb batch to **this
deployment's own public `/api`**:

- `src/domains/integrations/integration-api.ts:37-44` — every OAuth callback dials
  the public URL with the **admin API secret**, under two
  `no-capnweb-http-batch` lint suppressions (`:10`, `:40`).
- `src/domains/inbound-mcp-server/mcp-handler.ts:434-441` — **every MCP `exec_js`**
  pays a network round-trip to the machine it is already on.
- `src/lib/project-server-fns.ts:183-190` — SSR root redirect, same pattern, same
  suppression.

The premise is written down and is now false: `integration-api.ts:30-32` still says
these routes are "served by the api worker … which has the engine bindings" — a
sentence about the deleted two-worker topology (#1636 made it one script). The
in-process shape already exists 40 lines away in the same codebase:
`src/worker.ts:119-120` constructs `new ProjectCollectionRpcTarget({ auth:
trustedInternalAuthContext(), … })` directly.

**Why it matters beyond LOC:** the self-dial converts an in-isolate function call
into a public-surface network call carrying the admin secret, adds a real
failure/latency mode to every OAuth callback and MCP script execution, and requires
standing first-party suppressions of a house lint rule — the definition of the
callsite-purity rule being violated by first-party code.

**The collapse:** one `engineSession(ctx)` helper that returns an in-process
authenticated root; delete all three copies, both URL constructions, the
admin-secret plumbing on this path, and the three lint suppressions.

### 3.3 Ingress routes every request twice — the multi-worker vestige says so itself

`src/ingress.ts:196-198` (`apiWorkerRequest`) is a "cheap synchronous pre-filter"
deciding whether a request "belongs to the api pipeline" — before the real
`decideIngressRoute` runs. Its own TODO reads: _"collapse into one
decideIngressRoute pass in worker.ts — vestige of the deleted multi-worker
topology."_

Also in the residue family, a **dead read/strip pair**: `worker.ts:224-231`
(`stripInternalHeaders`, called at `:89`) strips seven `x-*` headers. Five are
legitimate anti-spoofing — ingress _sets_ `x-iterate-app` / `x-itx-project-id` /
`x-iterate-url-prefix` as trusted, and `ingress.test.ts` confirms client-supplied
copies are stripped. But `x-iterate-resolved-ingress` and `x-iterate-ingress-hostname`
have **zero setters** anywhere in `src`. Worse, `ingress.ts:164` reads
`x-iterate-ingress-hostname` as the _first_ preference for the ingress host — but
because `stripInternalHeaders` runs first (`worker.ts:89`), that read is always null
and always falls through to `x-forwarded-host`. Both header ends are the ingress-worker
→ app-worker handshake of the deleted split; nothing produces them now.

**The collapse:** do what the TODO says. One routing pass, delete the pre-filter
and both dead header lanes. This is small in lines but large in "why are there two
of these?" reader tax — routing is the first thing anyone traces.

### 3.4 Push delivery carries ~1,100 lines of machinery the pull lane already distrusts

The stream substrate's push-delivery apparatus — generations, `ingestChain`, poison
handling in `src/domains/streams/stream-processor-host.ts:209-326`, plus its share
of `stream-connections.ts` — totals roughly 1,100 lines against ~850 for the
journal engine itself. Then #1611 added a `catchUp` pull lane _because push could
not be trusted_ after wake/deploy. Both now run.

For configured same-script DO subscribers, push is now only a latency optimization
— correctness already comes from pull. A **nudge-then-pull** shape (push carries no
payload, only "you have mail"; subscriber pulls from its own offset) deletes an
estimated 200–300 lines of ordering/poison/generation machinery and removes the
entire class of "push delivered out of order / twice / to a stale generation" bugs
by construction. Related twins to fold while there: `retainProcessEventBatch`
(`stream-connections.ts:363`) and `retainStateChangeCallback`
(`stream-processor.ts:637`) are the same ~40-line retention helper written twice.

Two loose ends in the same substrate:

- **`getEvents` defaults `limit` to `MAX_SAFE_INTEGER`**
  (`stream-durable-object.ts:267-268`) — an unbounded journal read on the public
  itx surface; agents' prompt rebuilds use it and pull full `llm-response-chunk`
  spam because `getEvents` lacks the `eventTypes` filter that `subscribe` already
  has. Default the limit; add the filter (~10 lines).
- **Producer-less surface** (~100 lines): the pause door, `metadata-updated` (zero
  producers), cross-post rules exercised only by e2e. Delete until a producer
  exists; the journal keeps the history if it comes back.

### 3.5 Fold-from-zero on hot paths — the doctrine's own primitives, unused

The doctrine says checkpoints make folds cheap. Four places ignore the primitives
and re-fold from offset zero on hot paths:

| Site                                                                                               | Cost                                                                                                                                    | Fix (house primitive)                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `src/domains/integrations/connect-flows.ts:489-491`                                                | full team-directory fold **per Slack webhook**, on a singleton DO                                                                       | checkpoint the fold                                    |
| `src/domains/integrations/google-tokens.ts:81-83` (`readGoogleTokenState` → `readAllStreamEvents`) | full token-stream fold **per `gmail.request`**                                                                                          | checkpoint the fold                                    |
| agent checkpoint write path (fixed)                                                                | formerly duplicated the **whole transcript** into one unchunked KV cell per batch — O(N²) write amplification toward the ~2 MB cell cap | bounded mutable tail plus immutable SQL history chunks |
| agent prompt rebuild                                                                               | reads the **full journal including chunk spam** (see §3.4)                                                                              | `eventTypes` filter + bounded read                     |

The remaining fold-from-zero fixes are small uses of machinery the substrate
already ships. They are worth fixing soon not only for speed but because each
example teaches readers that fold-from-zero is acceptable on hot paths — the
doctrine erodes by example.

The agent checkpoint now publishes one metadata/128 KiB tail row as the commit
marker and seals older history into immutable SQL rows. Chunk insertion, metadata
publication, and generation replacement share one synchronous transaction; any
missing or malformed row discards the whole cache and refolds the journal. Local
workerd measurements put steady append-and-checkpoint p50 17%, 33%, and 52% below
the former full snapshot at roughly 310 KiB, 600 KiB, and 1 MiB histories. Cold
p50 changed by +2%, +1%, and -1%; cold p95 was noisy and reached about +20% at
600 KiB because activation reads more rows.

Ordinary checkpoints still write about one billed row, with an occasional chunk
row when the tail seals. Cold activation reads one metadata row plus roughly one
row per 128 KiB of history. Stored bytes remain approximately one transcript.
The implementation is isolated to the Agent host: deleting its two cache tables
and refolding, or restoring the generic checkpoint adapter, collapses it without
changing the journal or processor contract.

### 3.6 `src/rpc-targets.ts` (2,566 lines): the pattern is load-bearing at the core, over-applied at the leaves

The god-file critique is half right. For the core trio (Unauthenticated → Session →
Project), the single file is **earning its size**: `ITX_SURFACE_MEMBER_NAMES` is
derived by prototype reflection and enforced as the capability namespace
(`rpc-targets.ts:787`, `:1330`, `:1357` — mounts cannot shadow members), and one
file _is_ the auditable authority surface — the security argument reads top to
bottom.

What does not need to be there: ~400 lines of leaf execution logic — OpenAPI
operation execution (`:2366-2566`), the MCP client, and the Slack/Gmail/Integrations
proxies (`:582-739`) — which are domain logic that happens to be reachable via a
capability, not authority code. Move them to their domains; keep thin
authority-asserting stubs in rpc-targets. Optional second step: move the DO-facing
engine facades (~450 lines) out as well, making the layering strictly
one-directional (rpc-targets → domains, never the reverse).

### 3.7 Processor state is the one boundary without a type tie — and `types.ts` ships the lie to agents

Every other boundary in the system is tied together (`satisfies`, generated types,
freshness tests). Processor **state** is the exception: `AgentProcessorState` in
`src/types.ts` is missing fields the real fold carries — `llmConfigConfigured`
and `requestGeneration` exist in the contract schema
(`agent-processor-contract.ts:139,161`) and drive real behavior
(`agent-processor-implementation.ts:232-274`) but appear nowhere in `types.ts` —
and the facade launders the difference with `state as unknown as PublicState`
(`rpc-targets.ts:2109`). Because `types.ts` is literally shipped to
agents (via `ITX_TYPES_SOURCE`), **the published contract lies about observable
state** — an agent reading its own state sees fields the types say don't exist.

Fix shape (already proven in-repo by the secrets domain): each processor's public
state type gets a `satisfies`/projection tie to the fold's return type, enforced at
compile time; delete the `as unknown as` casts.

### 3.8 The dashboard has two socket-recovery stacks and renders fake telemetry

- **Two independent recovery mechanisms fight over the same WebSocket**, and the
  code says so out loud: `src/itx/itx-react.tsx:71-72` claims it owns the whole
  reconnect story so "no consumer hand-rolls epochs or watchdogs" — yet
  `domains/streams/client-libraries/browser/stream-browser-store.ts` hand-rolls
  exactly that (44 references to epoch/nudge/probe fencing). One of the two is
  redundant; the store owns the mirror, so the itx-react watchdog is the candidate
  to fold in.
- **Fake telemetry, and now self-documented as fake.** `stream-processors-panel.tsx`
  renders a per-subscription "RTT" from `fakeRtt()` (`:348` — its own comment:
  _"Deterministic fake RTT for preview data"_) and an "events/s" stat computed as
  `(0.4 + (metrics.rttNow % 7) / 10)` (`:250`); `stream-view-header.tsx:116` renders
  the same `rttNow`. Delete it or wire it to the real socket ping — a fabricated
  latency number on an operations panel is worse than no number.
- ⟳ **Softened by #1651.** An earlier draft flagged a third "raw-events" subscription
  whose only output was a `COUNT(*)`. #1651 decomposed the stream view and added a
  real raw-event _inspector_ panel, which plausibly gives that leg a genuine consumer
  now. Re-confirm the live subscription count against the decomposed
  `apps/os/src/components/project-stream-view.tsx` before acting; do not assume the
  leg is still dead.

### 3.9 Lint rules that no longer bind

- `no-raw-durable-object-binding-access` matches `env`-receiver patterns, but the
  canonical import is now `itxEnv` — the rule is **vacuous** (and
  `src/domains/integrations/integration-streams.ts:18-21` bypasses it today).
  Re-point the rule at the real import shape.
- The rule's allowlist blesses `src/workers/**` — a directory that no longer exists
  — and cites a spec doc that was never written.
- `no-capnweb-http-batch` has three standing first-party suppressions, all on the
  §3.2 self-dial path; they disappear with it. A house rule that first-party code
  permanently suppresses is a rule the codebase has voted against — fix the code
  (here) or the rule, but not the standoff.

### 3.10 Config: the tool lane never moved onto `envs.ts`

The runtime moved to one typed environment map; the **tooling did not**.
`scripts/preview/preview.ts` (3,647 lines) refuses to import `envs.ts`;
`sync-auth-clients.ts` hand-copies the env map; `readPreviewAppConfig` shells out to
Doppler for values `envs.ts` already types. There are **three** OAuth-client
provisioning implementations. Smaller residue in the same family: JWKS is
unconditionally pinned into Doppler (arming a break-glass override nobody intends),
4 of 11 `OPTIONAL_SECRETS` have no consumer, `AppConfig.typeIdPrefix` and
`pickAppConfigEnv` are dead, the browser receives public config via three channels
where one would do, and the config zod-parses twice.

The collapse is directional, not clever: scripts import `envs.ts` like the runtime
does; one OAuth-client provisioner; delete the dead fields and channels.

---

## 4. Too many lines — dead code and committed mirrors

Everything in this table is deletable or collapsible with **zero product change**.
Estimated total: **~14–16k LOC** — down from an earlier draft's ~18k because ⟳ #1651
already deleted ~3.9k of it (the `packages/ui` events feed cluster, incl.
`stream-feed.tsx` 988 and `stream-view-reducer.ts` 653) and the `src/next` workspace
entry is gone.

| What                         | Where                                                        |    LOC | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------ | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⟳ Unreachable UI components  | `packages/ui` (of 12.4k src LOC)                             |  ~6–7k | After #1651 removed the events cluster, apps/os imports ~35 UI modules (`agent-ui-reducer`, `stream-path-label`, `events/types`, `ai-elements/message`, plus ~30 shadcn primitives). Surviving dead clusters: **ai-elements minus message ~2.8k** (`prompt-input.tsx` 1,404), `terminal.tsx` 381 + mobile-keyboard-toolbar 591, and an estimated ~3k unused shadcn primitives (needs a reachability pass to bound exactly). |
| Committed generated mirror   | `src/types-source.generated.ts` + generator + freshness test | ~1,100 | The generator's stated reason (no raw-import in the bundler) is stale: the build is Vite, `?raw` imports exist, and all three consumers (`src/rpc-targets.ts:31`, `src/components/itx-repl-types.ts:3`, `src/domains/agents/agent-processor-contract.ts:2`) bundle through Vite. Replace with `import src from "~/types.ts?raw"`; delete the mirror, the generator, the script entry, and the freshness test.               |
| Second dispatch engine       | `src/itx/path-proxy.ts`                                      |    177 | Imported only by `browser-repl.test.ts`; reserves a `describeItx` name the surface no longer uses. The live dispatch is `withInvokeCapabilityFallback`. Delete; re-point the test at the live engine.                                                                                                                                                                                                                       |
| Manual QA page               | `src/routes/**/reactivity.tsx`                               |   ~450 | Hand-driven reactivity playground on a product route.                                                                                                                                                                                                                                                                                                                                                                       |
| Dead interrupt lane          | agents domain                                                |    ~45 | Zero emitters of `interrupt-current-request`; the UI appends `llm-request-cancelled` directly (`routes/**/agents/streams/$.tsx:52-62`).                                                                                                                                                                                                                                                                                     |
| Twin retention wrappers      | `stream-connections.ts:363` / `stream-processor.ts:637`      |    ~40 | Same helper, written twice (§3.4).                                                                                                                                                                                                                                                                                                                                                                                          |
| Producer-less stream surface | streams domain                                               |   ~100 | Pause door, `metadata-updated`, cross-post rules with no non-test producers (§3.4).                                                                                                                                                                                                                                                                                                                                         |
| Dead integration metadata UI | `routes/**/integrations.tsx`                                 |    ~25 | Renders fields no flow writes.                                                                                                                                                                                                                                                                                                                                                                                              |
| Dead config surface          | config module                                                |    ~30 | `typeIdPrefix`, `pickAppConfigEnv`, double zod parse, 4 consumer-less `OPTIONAL_SECRETS`.                                                                                                                                                                                                                                                                                                                                   |

Also in the "committed weight" family though not dead: `itx.e2e.test.ts` is a
2,965-line monolith holding ~60% of the e2e lane — it is why global
`maxConcurrency` sits at 2. Splitting it (the existing high-priority task) is a
wall-clock fix, not a correctness one.

Misplacement (move, don't delete): `SLACK_AGENT_SYSTEM_PROMPT` lives in the
projects domain but belongs to integrations/agents; `agent-ui-reducer` (614 lines,
the surviving fold in `packages/ui`) is tested only from apps/os with zero tests in
its own package — it argues the fold layer belongs in `apps/os`. ⟳ #1651 already
acted on the other half of this: it moved the stream-view fold out of `packages/ui`
and deleted the untested `stream-view-reducer.ts` an earlier draft flagged here.

---

## 5. Doc drift — the docs describe two previous architectures

Highest-consensus finding across all fourteen critics. The pattern: #1585 and
#1636 updated docs by string-substitution, so every doc that _narrates_ topology
drifted while the doctrine docs (which describe invariants, not inventories)
stayed true.

| Doc                                                                                                                                                                                                                      | Verdict                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/domain-objects-and-stream-processors.md`, `docs/os-rules.md`, root `docs/architecture.md`, `worker-topology.md` (one note aside), debugging guides, `doppler-backed-scripts.md`, `removed-test-coverage-itx-v4.md` | **Current and clean.**                                                                                                                                                                                                                                                                                                                                                        |
| `apps/os/AGENTS.md` (entry-point doc)                                                                                                                                                                                    | **Self-contradicting**: "Ten deployed workers" (line 20) vs "(one worker, all DO classes)" (line ~188); dead `src/workers/` paths; a dangling half-sentence at line 190 (editing artifact of #1636); an "in flight" Slack/Google note refuted by #1624 a day before HEAD; claims `src/itx/` contains `e2e/` (moved).                                                          |
| `apps/os/docs/architecture-and-operations.md`                                                                                                                                                                            | Runtime Shape and Deployment sections narrate the ten-worker split verbatim — `src/workers/api.ts`, `src/workers/app.ts`, ingress/app division, cross-script DO bindings, two-pass bootstrap. All structurally gone.                                                                                                                                                          |
| `src/README.md`                                                                                                                                                                                                          | Healthiest working doc (capability tree, four-nouns, auth lanes all verified) — but the Layout table lists a nonexistent `workers/` row and `nextEnv`, and omits `integrations`/`sandboxes`.                                                                                                                                                                                  |
| `CONTEXT.md` (910 lines)                                                                                                                                                                                                 | **Highest-risk**: it is a _language_ doc — it exists to shape how agents talk about the system — and ~550–600 lines teach vocabulary the code refuses: D1-backed secrets, D1 projections, StreamsBackend, ReposCapability, extend/super, `OutboundMcpFromOurClientCapability`, `itx.workspace`. 116 lines name dead symbols directly; some Avoid-rules ban now-correct terms. |
| `sandboxes.md`                                                                                                                                                                                                           | Self-contradicts: line 33 (own sandbox worker) vs 107-111 (same-script containers — correct).                                                                                                                                                                                                                                                                                 |
| `worker-topology.md`                                                                                                                                                                                                     | One stale note: says streams-example-app binds cross-script via `script_name os-prd`; the same PR made it a same-script re-export. Even the doc of record drifted inside the PR that established it.                                                                                                                                                                          |
| Historical docs (`itx-design.md`, `itx-authority-research.md`, `DECISIONS.md`, …)                                                                                                                                        | **Properly labeled** — genuinely good discipline. Residual: 985 lines sit as the _default_ README/DECISIONS of the live `src/itx/` folder, and one banner sentence is false (e2e location).                                                                                                                                                                                   |

**The fix is deletion and single-sourcing, not more prose**: every inventory
(workers, routes, domains) should exist in exactly one place — ideally generated or
adjacent to the code it lists — and every other doc links to it. Rewrite
`CONTEXT.md` against today's vocabulary (or cut it to the doctrine and links).
Estimated **−800 to −1,800 prose lines** with zero new machinery.

---

## 6. Tests — lean, honest, and lopsided in a diagnostic way

Corrected census (the review brief's own 70k/2:1 figure was wrong by ~5×): apps/os
test files total **12,282 LOC ≈ 0.4:1** test-to-src (colocated unit ~49%,
e2e/vitest ~36%, examples/TUI/support ~15%). This is a lean corpus, and its best
parts are exemplary — deterministic processor folds against in-memory stream fakes,
capnweb semantics pinned in `browser-repl.test.ts`, an honest
`removed-test-coverage-itx-v4.md` ledger whose every checked claim held.

The lopsidedness is the diagnostic part. The corpus over-invests in **network
choreography** exactly where the platform's consistency boundaries wobble — the
skipped known-failing `waitForEvent` leak test, the ~12-way append-loss task, repo
read-your-write retries, `stream-lifecycle.e2e` deadlines widened 1.5s→10s by
#1644 — and under-invests where contract tests would be cheapest:

- **`StreamDurableObject` (1,151 LOC) has 212 LOC of unit coverage.** The
  deterministic in-process lane was dropped in #1585 under a cross-script rationale
  that #1636 dissolved — the DO is same-script again and can be tested in-process.
  Restoring that lane is the single highest-leverage test investment; it would pin
  the §3.1/§3.4 semantics (announcement durability, catchUp/push equivalence)
  without a network.
- **The fold layer in `packages/ui` is inverted:** zero tests live in the package;
  `agent-ui-reducer` (614 LOC) is tested only cross-package from apps/os. ⟳ #1651
  removed the sharpest example (the untested `stream-view-reducer`), but the
  structural point stands — the reducer that survives is still tested from the wrong
  side of the package boundary.

---

## 7. Prioritized actions

**P0 — correctness (the architecture-level gap):**

1. Stale-`requested` recovery scan for agent LLM/script effects (~30–40 lines beside
   the existing settle recovery, `agent-processor-implementation.ts:146-178`) —
   closes the rebuilt 2026-06-10 incident class. (§3.1)
2. Make ancestor announcements durable obligations (appended + retried), not
   fire-and-forget — `agents.list` depends on them. (§3.1)
3. Bound `getEvents` (limit default + `eventTypes` filter). (§3.4)

**P1 — collapse (delete abstractions, not just lines):**

4. Kill the three self-dial `engineBatchSession` copies → one in-process
   `engineSession(ctx)`; drop the three lint suppressions and the false comment. (§3.2)
5. One routing pass: do `ingress.ts:196`'s own TODO; delete `apiWorkerRequest` and
   the dead `x-iterate-resolved-ingress` / `x-iterate-ingress-hostname` read/strip
   pair. (§3.3)
6. Delete the ~6–7k dead `packages/ui` files (`packages/mock-http-proxy` already removed)
   (ai-elements-minus-message, terminal/mobile, unused shadcn). (§4)
7. `types-source.generated.ts` → Vite `?raw` import; delete mirror + generator +
   freshness test (~1.1k). Verify with a 5-minute spike first. (§4)
8. Nudge-then-pull for configured DO subscribers; fold the twin retention wrappers;
   delete the producer-less surface (~300–450 total). (§3.4)
9. Checkpoint the two hot-path folds; fix the agent-checkpoint KV transcript cell. (§3.5)

**P2 — hygiene (stop the erosion):**

10. Docs single-sourcing pass: fix `AGENTS.md` / `architecture-and-operations.md` /
    `src/README.md` inventories; rewrite or gut `CONTEXT.md` (−800..−1,800 lines). (§5)
11. Restore the in-process `StreamDurableObject` unit lane; split `itx.e2e.test.ts`. (§6)
12. `satisfies` ties for processor state; delete the `as unknown as` launder at
    `rpc-targets.ts:2109`. (§3.7)
13. Move ~400 lines of leaf execution out of `rpc-targets.ts`. (§3.6)
14. Re-point the vacuous DO-binding lint rule at `itxEnv`; purge the dead allowlist. (§3.9)
15. Scripts onto `envs.ts`; one OAuth-client provisioner; delete dead config. (§3.10)
16. Dashboard: fold the itx-react watchdog into the store's recovery stack; delete
    the `fakeRtt()` / fake-`events/s` telemetry; re-confirm the raw-events
    subscription count post-#1651 before touching it. (§3.8)

**Follow-up not covered here:** a proper read of the two subsystems the merge
introduced — #1612's builder pipeline (`domains/workers/{builder-entrypoint,
artifact-store,materialize,source-masks}.ts`) and #1654's per-agent sandboxes +
MITM egress. Spot-checked clean on self-dial and fold-from-zero; not otherwise
reviewed.

---

_Review artifacts: 14 lens-critic reports and 12 subsystem maps live in the review
workflow run (`wf_f4a954dc-404`); the automated adversarial-verify and completeness
stages were curtailed by account quota, so the findings above are the deduplicated
subset with **every citation hand-verified against the merged tree** (`2e33cc925`)._
