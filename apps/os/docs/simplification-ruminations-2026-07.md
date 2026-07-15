# Simplification ruminations — July 2026

Working document. Raw ruminations, review findings, crazy ideas, codex dialogue,
and eventually a plan for collapsing `apps/os` onto its 3-4 core concepts.
Produced by a multi-agent review (subsystem mappers → complexity lenses →
adversarial verification), several deliberately unhinged visionary agents, and
multiple rounds with codex (gpt-5.6-sol, xhigh reasoning). Everything cited was
checked against the tree at branch `simplification` unless marked speculative.

---

## 1. The vision, in Jonas's words

> An iterate project is basically an intelligent entity connected via HTTP to
> the world that can self-improve. Everything is explicitly built on stream
> processing. Agents respond to external events (HTTP requests) and internal
> events (messaging each other, events, timers/schedules). Repos are central to
> all of this. The main POINT of anything is to either (1) change internal
> state and/or (2) cause side effects in the external world. Any tool can
> trivially be connected via itx/capnweb.

> Streams are a _single_ very powerful abstraction usable as outbox, workflow
> step management, streaming abstraction. I want a small number of simple
> concepts with powerful emergent properties. In principle, the only thing you
> can do to interact with our system is append events. In the limit you could
> even model HTTP requests to the dynamic config-repo worker as event streams
> (we're not going that far). The goal is to simulate entire intelligent
> entities — family assistants, startups, anything. Even NVIDIA is an event
> processing system whose output is emails to TSMC.

> Everything is a stream processor — and stream processors can even be hosted
> by third parties. Any "coding agent" out there (claude, codex, pi, opencode)
> is expressible as a stateful stream processor. That is AMAZING.

> What is a domain entity? Is it "Durable Object class" × "stream path + query
> params" (i.e. DO name in a DO namespace), or something else? What can we
> learn from BEAM and other actor systems? I don't know if it's good or bad
> that we have multiple durable objects of different classes with the same
> name. I also find that the "birth" of agents and other domain objects is too
> implicit and heterogeneous.

> ALL DEFAULTS IN THIS SYSTEM SHOULD BE OVERRIDEABLE VIA CONFIG REPO. The
> configuration IS a worker.ts file! And that gets called on every
> (non-ephemeral) event and can call the "default configuration" via itx (so
> that changing defaults doesn't require committing to a million repos). Can we
> do more with this idea? Is it dumb?

### 1.1 Jonas's written principles (2026-07)

- **The events ARE the API.** We don't hide them from callers. Utility wrappers exist but are NOT the primary API. The ONLY thing you can really do with the system is append events.
- **Userspace first.** Everything doable in apps/os worker code should be possible in userspace (dynamic workers). Why build a UI feature in os.iterate.com when an npm package mini-app can mount at `mini-app.their-project.iterate.app`?
- **Trust model: simple but strict.** Once you have project access you can do anything with it — no hiding implementation details behind protected methods; a raw `.processor` RpcTarget with internals public is great for debugging. BUT: one project must NEVER reach another project, and secrets must never enter untrusted code that can exfiltrate.
- **The primary user of the itx capability tree is an LLM agent.**
- **Cross-post is the only multi-stream mechanism.** For a processor to react to multiple streams, events MUST be cross-posted to its stream. In the limit, a broadcast ("we're about to redeploy") is a cross-post to all (wake) streams.
- **Prefer one `/configured` event with mergeable config** over many per-option event types (needs a consistent structure).
- **Assume any part can fail at any moment; a small set of consistently applied recovery mechanisms:** idempotency keys on all side effects (appends and third-party APIs); processors tell the DO "I'm working"/"I'm done" so a short alarm keeps it alive and revives it after eviction, recovering via `stream/woken`. _(Note: this mechanism now exists — the keepalive, `stream-processor-keepalive.ts`.)_
- **EVERYTHING IN USERSPACE** (added 2026-07-13): it should be possible to build ~everything apps/os does in userspace on top of just **auth / itx / streams / stream processors**. Everything else is a higher-level abstraction, and the layering of the onion should be visible. The os.iterate.com UI could be ~nothing (all UI in userspace); secrets, integrations, agents could all be userspace. Part of the vision: the tasks system becomes many users using many tasks systems from npm packages other people made — **"any SaaS as an npm package imported into your iterate config repo."**
- **THE ONLY REAL SECURITY IS EGRESS NETWORK BYTES** (added 2026-07-13, record LOUDLY): unless bytes leave the project, nothing that happened inside matters. Internal state, internal messages, running arbitrary code — all harmless as long as they cannot exfiltrate. This is the output-gate philosophy: the entire security surface collapses onto the moment bytes cross the project boundary. Corollary: the only way to really *know* a decision came from a human is a **secure enclave** — which may or may not need to be kernel. (Substrate reality: Cloudflare Durable Objects — "easy, fast, correct: choose three", blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three — give the confinement + single-threaded correctness this leans on.)
- **THE KERNEL RAZOR** (added 2026-07-13): *the kernel is exactly what cannot be expressed in userspace — nothing more.* This is the razor for every "should this be kernel?" argument. Provocation: could **streams themselves be userspace**? If so they sit one layer *outward* from the true seed — **the ability to run confined arbitrary code with durable storage and one controlled network boundary** — which is the thing userspace cannot express because it *is* the thing that runs userspace. That seed primitive belongs in the slogans and currently doesn't.
- **SANDBOXES ARE NOTHING SPECIAL** (added 2026-07-13): a sandbox is just a provided capability. Every machine provider and sandbox in the world (Cloudflare containers, Fly, E2B, Modal, a Mac in a menu bar, a Raspberry Pi) drops into this system as a mount — no special domain required.

## 2. The question

The system is ~111k lines in `apps/os/src` (63k in `domains/`), and it FEELS
heavy and complicated even though the vision needs ~4 concepts. Why? And what
collapses?

## 3. Ground truth measured so far

- **The front door teaches 33 concepts.** The generated public contract
  (`src/itx-api.generated.ts`) has **46 interfaces**; the project-root `Itx`
  surface alone has **33 members**: `agents ai browser capabilityHost
  capabilityHosts debug docs egress email files integrations kill liveDemo
  liveState mcp openapi parallel processEventBatch processor projectId
  provideCapability repo repos revokeCapability sandboxes scheduler schedulers
  secrets streams worker workers workspaces`. The vision says the only thing
  you can do is append events; the root object disagrees 33 times.
- **`src/rpc-targets.ts` is 6,014 lines** — it was 2,566 at the July review
  (`docs/architecture-review-2026-07.md`); it has more than doubled in days,
  partly because the public contract is now generated from its docstrings.
- **Domain sizes** (src lines, excl. tests): streams 12k, integrations 5.5k,
  agents 3.6k, repos 3.1k, projects 2.9k, itx 2.2k, workers 1.8k, sandboxes
  1.7k, capability-host 1.5k, secrets 1.3k, workspaces 1.3k, email 1.3k,
  scheduler 1.0k, typecheck 0.8k, inbound-mcp 0.6k, events 0.4k, files 0.3k.
- **The prior review's verdict stands as context**: core engine healthy (zero
  import cycles, authority through one door, stream doctrine real), rot at the
  perimeter (~14-16k dead LOC then, doc drift, multi-worker vestiges, three
  side-effect consistency regimes).

## 4. Candidate core concepts (working hypothesis, beaten up over the night)

_Both independent reviews (the workflow's ontology lens and codex round 1)
landed on the SAME FIVE — but the notebook originally listed only four and the
VFS run (App. E) caught that the fifth, **Project**, was missing. All five,
each glossed in one line a programmer already owns (the §7.9 discipline):_

1. **The Project** — *a git repo = a company.* The whole entity: one identity,
   one confinement boundary, one namespace (§Appendix E: the Project is the
   stable tree everything else mounts into). Not "another object you hold" —
   it's the world the other four live in.
2. **The Stream** — *a log.* An append-only journal at a path. The only write
   in the system is an append; outbox, workflow state, audit log, messaging,
   and live streaming are one mechanism wearing different event types.
3. **The Processor** — *a consumer that folds a log into state.* `state =
   reduce(events)` plus `processEvent` side effects (+ a reconciler for durable
   obligations). Agents, integrations, schedulers, repo-sync — all of it. An
   agent is a processor wearing a prompt.
4. **The Capability** — *a callable reference.* The object-capability surface
   by which anything (agent scripts, tools, the dashboard) reaches into a
   project. Discovery via `__describe()`; authority by *holding* a reference;
   confinement by construction.
5. **The Repo** — *a git repo, again — but as the genome.* The self-
   representation: config-as-worker, the substrate of self-improvement. The
   entity can read and rewrite its own source.

_Three cross-cutting facts that are NOT extra concepts but shape everything:
the seed the kernel razor exposes (confined code + storage + one exit, §6.12),
the one door all security lives on (§6.11), and the hero framing that these
five compose into — the **intelligent entity runtime** (§6.14)._

## 5. Collapse proposals

_12 subsystem mappers ran to completion; 4 of 6 complexity lenses (ontology,
duplication, outbound-trace, vision-gap) completed before the credit wall.
Merge + ranking below done by the lead agent from the 32 recovered findings;
each finding carried its own file:line evidence, spot-noted here. Ordered by
how much of the felt weight it removes. "Deletes a concept" > "deletes lines"._

### 5.1 One dispatch regime: built-ins become described mounts on the capability table _(transformative)_

Every callable thing should be one concept — a capability at a path — but built-ins are **54 hand-written classes** in `rpc-targets.ts` (6,014 lines) resolved in-isolate BEFORE the capability-table walk. This second dispatch regime drags with it: collision guards (`rejectBuiltinCollision`, `ITX_SURFACE_MEMBER_NAMES`), the un-shadowable-name rule, **four parallel description corpora** (docstrings, 67 `__describe` bodies, the `PROJECT_BUILTIN_BLIPS` table, the generated contract), a 756-line generator + 5,270 lines of generated artifacts existing solely to make hand-written code agent-legible, and **11 near-identical get/list/create collection classes**. The smoking gun (`rpc-targets.ts:2415-2420`): `builtin integration "${slug}" has no dispatch branch — add one in ProjectIntegrationsRpcTarget.invokeCapability` — followed on the next line by the generic capability-table fall-through that could have served it. Mounted capabilities already get discovery free from provide-time metadata; the platform's own tools are second-class citizens of its "connect any tool" mechanism.

**Collapse:** register built-ins as ordinary described mounts (provide-time records: name, instructions, types, target) resolved by the one longest-prefix walk, keeping only genuinely hot/privileged nodes (streams, secrets, egress) as code. One description source feeds the static contract, `__describe`, and docs.search. The blip table, collision guards, most `__describe` prose, the 11 collection classes, and the bulk of the generator dissolve. `rpc-targets.ts` shrinks toward the four nouns its own header describes.

### 5.2 One channel mechanism — and push transcription into userspace _(transformative)_

The vision's core arrow (external event → stream → agent) is implemented **four separate times** (Slack, Telegram, email, GitHub PR), each as a router processor + transcriber processor: ~8.3k lines including contracts. The files confess: email's header says "shaped after the Slack webhook router"; pr-agent's says "shaped after the email-agent processor"; telegram "mirrors the Slack agent processor". All four transcribers emit the identical `agents/message-received` envelope. Every agent DO permanently registers all five processors (`agent-durable-object.ts:41-229` — 200 of 248 lines are per-channel dep plumbing), and 7 hand-written channel prompts route by path predicate. Meanwhile **the vision's own extension point already works**: `config-repo-template/worker.ts:87-100` reacts to `child-stream-created` and sets birth policy — proving channel reactions could live in the config repo. Today "self-improve" cannot reach channel behavior because it's platform code.

**Collapse:** one parameterized Channel processor (`{verify, extractThreadKey, buildAgentPath, curate, deliver}` per vendor) — then, per the vision, move transcription into the seeded `worker.ts`'s processEvent so the platform ships zero vendor transcribers. Prompts become base + per-channel reply-door fragment, in the repo, where the commit→rebuild loop can improve them. ~2,500 platform lines delete.

### 5.3 One fold engine: the stream's core processor hosts on StreamProcessor _(major)_

Two full implementations of the platform's central concept exist: the generic `StreamProcessor` engine every domain uses, and a hand-rolled twin inside `StreamDurableObject` (~290-line reduce switch over 15 `stream/*` control events, own checkpoint debounce, version-skew rebuild, paged replay, own wait primitive `waitForEvent` vs the engine's `waitUntilEvent`, own alarm multiplexer). The DO's header comment admits it's "the same validateAppend → reduce → processEvent" shape. "Everything is stream processing" is contradicted by the stream itself not using the processor engine.

**Collapse:** add the two genuinely missing capabilities to the ONE engine — a synchronous pre-commit `validateAppend` hook and an inline same-turn hosting mode — and re-express the core processor as a hosted `StreamProcessor`. One checkpoint store, one replay path, one wait primitive, one alarm multiplexer.

### 5.4 One obligation primitive: "durable job with expiry" written once _(major — also the P0 correctness fix)_

The single idea "durable async job journaled on a stream: intent event with `expiresAt` → started evidence → exactly-one terminal event → reconciler that starts/expires/crash-settles" is re-implemented per domain (agent LLM requests, script executions, scheduler triggers, repo creation, telegram sends) — AND the platform runs two more generic durability machines for the same eviction problem (the spine's backoff/park, the keepalive revival alarm). Verified identical shapes in three contracts. This is the biggest single source of felt weight in the agent loop AND the source of the recurring incident class (obligations without reconcilers — the human-approval hold still parks a live fetch in a DO method).

**Collapse:** an `Obligation` primitive on the engine: processor declares `{intentEventType, startedEventType, terminalEventTypes, expiresAt, run()}`; the engine owns journaling, at-head reconciliation, idempotency keys, expiry, crash recovery, backoff, park. ~350 lines delete from the agent implementation alone. Pairs with the scholar's contract-level rule (§6.2.5): make it impossible to declare a `-requested` type without its reconciler — and see §6.5 for Jonas's sharper version: encode the supervisor in the event type itself.

### 5.5 One delivery concept — and give the browser the same one _(major)_

"Durable at-least-once delivery to a checkpointing consumer" is split into three server modes (wake/push/webhook — webhook is already just push with batch size 1) plus a fourth client-owned lane: the browser re-implements the entire connection-reliability ceremony the server host explicitly deleted (`stream-processor-host.ts:38-46` says verbatim that generations/fencing/re-handshakes are "gone, because its job moved to structure: the stream initiated the connection") — while `stream-browser-store.ts` (1,719 lines) still carries connection epochs, supersede fencing, dial deadlines, liveness probes, pull-paged catch-up, and a 20k backlog valve. On top: TWO live-fold UI channels (LiveState diff-push engine, 717 lines, vs the OPFS SQLite mirror) and **five React read primitives** for one concept.

**Collapse:** one durable subscription (stream-owned cursor, awaited delivery = ack, backoff → park); wake's warm sink becomes a transport optimization, not a contract mode. Invert the browser to the same stream-owned, server-paced lane — deletes ~1,000 lines of transport necromancy and the #1894 two-liveness-systems bug class. In React: one subscribe primitive serving events and/or reduced state; `useLiveState` retires as a separate mechanism.

### 5.6 Repo becomes the one filesystem substrate; workspace and builder dissolve _(major)_

"Where project code lives" is answered three times: RepoDurableObject (full `git.clone` into isolate memory **per write**, `repo-durable-object.ts:1191-1249`, with two 5-attempt stale-HEAD retry ladders), WorkspaceCore/WorkspaceDurableObject (851 lines of COW overlay + a 234-line pure-delegation shim + a hand-rolled partial gitignore engine), and container sandboxes. Repo and root-Workspace dial each other **circularly** (repo serves HEAD reads from the workspace that clones from the repo). The duplicated edit verb and write-mutex exist verbatim in both. The builder sidecar is already declared temporary by `docs/worker-topology.md:22-36`.

**Collapse:** the Repo DO holds the materialized HEAD in its own durable storage; commits apply there; Artifacts/GitHub become push targets. Per-agent overlays become facets/views of the Repo. Builds move into the sandbox (already planned). End state: **repo (truth + overlays) and sandbox (a computer)** — two substrates, not three, no circular wiring, no clone-per-write.

### 5.7 Merge the CapabilityHost DO into the path's host DO _(major, hottest-loop latency)_

Every agent script turn ping-pongs between TWO DOs folding the SAME stream: agent DO appends `script-execution-requested` → wake-delivery to `CAPABILITY_HOST` DO at the identical name → runs script, appends completed → wake-delivery back. Two wake round-trips, two checkpoints, two keepalive machines, a whole DO namespace — pure relay tax on think→act. The agent DO already multi-hosts 5 processors, proving N-processors-per-DO works.

**Collapse:** register the CapabilityHostProcessor on the same host as the path's existing DO (agent DO for `/agents/**`, project DO for `/`). Delete the `CAPABILITY_HOST` namespace and one wake subscription per agent. (The scholar's organ-manifest, §6.2.4, is the guardrail: organs share the entity's path — this just removes a redundant organ.)

### 5.8 Resolve mounted capabilities from folded state in-isolate _(major)_

A built-in call is ~2 hops; the same dotted syntax on a mounted capability is **6+** (proxy → pass-through RpcTarget → DO RPC → longest-prefix fold → one more DO RPC per parent scope on miss → re-evaluate the itx-expression per call → replay walk → target). The mount table is just folded stream state; every read pays DO round-trips anyway, and the typecheck gate re-dials `describeCapabilities` up the whole parent chain per script.

**Collapse:** the itx isolate holds a subscribed/cached snapshot of the scope chain's mount table and evaluates expressions against its own itx; the DO remains append authority + home of live connection-bound mounts. 6 hops → 2-3; parent-chain misses cost zero network; staleness bounded the same way egress rules already accept (~5s).

### 5.9 The long tail (moderate, high confidence, mostly deletion)

- **One OAuth engine**: `connect-flows.ts` (1,277 lines, HMAC state, hand-written exchange per vendor) vs `mcp-oauth.ts` (357 lines, RFC discovery + DCR + PKCE + encrypted state). Builtins become provider config records on the generic engine; also evict Waitrose's reverse-engineered GraphQL login from inside the Secret DO.
- **One egress door** (security-adjacent): Slack dials the Project DO egress door so interceptors/approvals see it; **gmail and github dial their Secret DO directly and bypass both** (`rpc-targets.ts:2305-2311`). Route all vendor SDK egress through the project door; parse placeholders once, not twice.
- **One path-walk + one reserved-segment set**: the universal calling convention is implemented 4× with 3 reserved-name lists, coupled by *error-message-text sniffing* (`isMissingInvokeCapabilityError` matches workerd's TypeError text). One shared `replaySegments` + typed miss error.
- **By-reference journaling for scripts**: script code journaled twice, result three times, two JSON round-trips in flight — while the LLM lane already proved by-reference (offset = request id). Carry `{sourceOffset}`; render results at prompt-build time.
- **Typecheck gate off the hot path**: 1,570 lines + a separate deployed wasm worker, advisory by design ("may only ever block on proof"), paid on every turn; the failure message already advertises the pull-based `itx.docs.typecheck`. Keep at most an in-isolate syntax parse.
- **Generic `ProcessorHostDurableObject`**: six domains hand-write the identical DO skeleton (codec parse, host wiring, wake passthrough, kill, read-your-writes helper — verified at 6 sites). A domain becomes contract + implementation, exactly the shape userspace processors need.
- **Project identity onto a stream**: project existence lives in 3 stores (auth worker, never-expiring KV that IS the directory for admin-lane projects, stream fold). A deployment-level directory stream, folded into KV-as-derived-cache; auth worker keeps users/orgs/claims only. Project birth becomes what the vision says: an event.
- **Delete the stale-architecture corpus**: CONTEXT.md (951 lines teaching deleted vocabulary — `StreamsBackend:375`, `ReposCapability:381`), 2,448 lines of pre-v4 design docs at maximum prominence, the 412-line `/reactivity` playground route, colliding ADR numbering. Zero runtime risk.

### 5.10 The ontology lens's collapse map (its transformative top finding)

A contributor today must learn **~40+ nouns**; the vision needs ~5. Declare
the ontology and recast every subsystem as an instance:

| Concept | What collapses into it |
|---|---|
| **STREAM** — append-only journal at `(projectId, path)`, subscriptions-as-events, ONE durable delivery lane | core control events, cross-post, LiveState, browser mirror, the spine |
| **PROCESSOR** — the one fold+effects engine (contract + reduce + processEvent + obligation primitive), hosted by one generic platform DO | core processor, routers, transcribers, scheduler, agent loop, repo lifecycle, keepalive, approval holds |
| **CAPABILITY** — the itx name tree; everything callable is a described mount resolved by one walk; `__describe` the sense organ | 54 RpcTarget classes, 11 collections, integrations branches, MCP/OpenAPI clients, blips |
| **REPO** — committed truth + overlay working sets; source of all project code | workspaces, builder artifacts, dynamic worker refs (materializations of repo state) |
| **DOOR** — the single ingress/egress + secret boundary | worker.ts in; project-DO fetch with placeholder substitution out |

(Agents deliberately absent: an agent is a PROCESSOR wearing a prompt — see
crazy corner 7.7.)

## 6. The big ideas, examined

### 6.1 "Everything is a stream processor" — including third-party ones

Claim: any coding agent (claude, codex, pi, opencode) is expressible as a
stateful stream processor; processors could be hosted by third parties.

The scholar's verdict (full argument in §6.2.6): **yes, and the contract to
publish already exists** — it is the spine's own delivery contract
(at-least-once, batch-shaped, server-owned cursors, journaled liveness),
because the spine never trusted its subscribers anyway. The killer symmetry:
`AgentDurableObject` is formally just a well-supervised subscriber to the
agent's journal; a codex process with a webhook subscription is the same
species with worse supervision. Swapping the platform's LLM loop for a
third-party coding agent should be a config change (re-append
`subscription-configured` with the same key), not an architecture. Three
promises to refuse: exactly-once, unfenced single-active-consumer,
transparent remoteness.

The maximalist's audit (Appendix A §2) sharpens it to practice: **the
platform's own AgentProcessor already IS the design** (fold = conversation,
LLM requests by reference, compaction as `history-reset` event — which fixes
the problem codex's own `previous_response_id` has with compaction). The
minimal third-party contract is three obligations: answer the poke with your
checkpoint + sink; ingest offset-deduped batches, persist `{offset, state}`
write-before-advance; append with derived idempotency keys. **Webhook mode
works for this TODAY** (per-event POST, 2xx ack, stream-owned cursor, stable
deliveryId, egress-attributed); the missing piece is one dial arm
("wake-webhook": batch delivery with subscriber-owned checkpoint) plus
scope-pinned bearer credentials (the `itxForScope` recipe exists; the
credential that pins it doesn't). Codex's round-1 caveats (Appendix B §3b)
are the requirements list: fencing generations, no cross-stream atomic
commit, narrow expiring grants, state snapshots by blobRef. See also crazy
corner 7.7 (the LLM as stochastic reducer — why every coding agent is
"secretly" this shape)._

### 6.2 What IS a domain entity? (BEAM & actor-system lessons)

_From the actor-systems scholar agent. Every claim about the code was made
with file:line citations; positions, not surveys. Verbatim except heading
levels. This section also answers 6.4 (births — see §6.2.3) and half of 6.1
(third-party processors — see §6.2.6)._

#### 6.2.0 Ground truth: both founder claims verified, one needs sharpening

**Naming.** Every domain DO name is `{projectId}.iterate{path}` plus optional query props, parsed as a URL, formatted/parsed in exactly one module (`apps/os/src/domains/durable-object-names.ts:1-17`). The projectId-as-hostname is explicitly "the whole basis of the access model" (`durable-object-names.ts:9-11`). Query props are used in production exactly once: stateful dynamic workers append `?durableWorkerKey=` so multiple durable workers can live under one stream path (`apps/os/src/domains/workers/worker-runner.ts:247-262`).

**Multiple classes, same name.** Verified, and it is pervasive, not incidental. For an agent at `/agents/foo` in `prj_x`, at least three DO classes answer the *identical* name string `prj_x.iterate/agents/foo`: `env.STREAM.getByName(...)` → `StreamDurableObject` (`rpc-targets.ts:409-417`); `env.AGENT.getByName(...)` → `AgentDurableObject` (`rpc-targets.ts:3167-3172`); `env.CAPABILITY_HOST.getByName(...)` → `CapabilityHostDurableObject` (`rpc-targets.ts:3943-3949`). At the project root the same triple-occupancy holds for `prj_x.iterate/`. Every one of these classes independently parses `ctx.id.name` through the same codec and derives its identity from it. Two wrinkles the "class × path" formula hides: (a) **one class plays several roles by path convention** — `ProjectDurableObject` is the project processor host at `/` but also the Slack/Telegram webhook-router host at `/integrations/slack/{connection}` (`project-durable-object.ts:101-158`); (b) **some organs live at derived paths** — an agent's workspace DO lives at `agentWorkspacePath(agentPath)` under `/workspaces/...`, not at the agent's own path (`agent-durable-object.ts:66-72`).

**Births.** "Too implicit and heterogeneous" — confirmed and worse than stated. There are FIVE distinct birth patterns today:

1. **Constructor self-birth** (streams): first wake appends `stream/created` (enforced to be offset 1, `stream-durable-object.ts:512-518`) plus a born-configured project-worker subscription, in the constructor's own synchronous turn (`stream-durable-object.ts:143-167`).
2. **Request/created saga with a waiter** (repos, sandboxes): caller appends `repo/create-requested` + the processor subscription, then blocks on `waitForEvent(repo/created)` (`rpc-targets.ts:824-852`).
3. **External-registry-first saga** (projects): register with the *auth worker* directory, prime KV, append `project/create-requested`, seed the config repo, probe the built worker, only then `project/created` (`rpc-targets.ts:3624-3700`).
4. **Implicit first-append with three-party reactive birth** (agents): `message()` on a never-existing path just appends `message-received` (`rpc-targets.ts:3204-3210`); the stream self-creates and announces `child-stream-created` to ancestors; the *project processor* reacts with MECHANICS (processor subscriptions) and the *userspace project worker* reacts with POLICY (prompt/model/mounts via `agents/agent-defaults.ts:1-15`) — three appenders converging on shared idempotency keys.
5. **Subscription-only births** (schedulers, secrets, integration routers): the birth certificate *is* the `subscription-configured` event, and capability hosts have no birth event at all — the scope exists when someone first mounts or invokes.

#### 6.2.1 The entity is the **named journal** — and even the machinery is journal content

> **An entity is a `(projectId, path)` coordinate together with the journal stored at it. Everything else — every DO class, every processor, every checkpoint, every fold — is either a cache of the journal or an organ that acts on its behalf.**

The eliminations:

- **The DO is not the entity.** DO incarnations are explicitly disposable: every wake mints a fresh `incarnationId` and *clears the connection roster* (`stream-durable-object.ts:530-537`); every class carries a `kill()` that aborts the incarnation with no semantic consequence. And three-plus classes share one name — if the DO were the entity, one agent would be three entities.
- **The (path, class) pair is not the entity.** It's an *organ* address. The classes at one path act on one journal, hold no authoritative state of their own (their `{offset, state}` checkpoints are declared disposable caches), and can be added/removed by deploy without the entity changing identity.
- **The fold-state is not the entity.** There are *many* folds per journal — the agent DO alone hosts five processors over the same stream (`agent-durable-object.ts:41-229`). Fold-state is the entity's *memory of itself*, per observer.

What clinches it is the reflexive move the platform already made: **the wiring itself is journal content.** Which processors run against a stream is not deployment config — it is folded `subscription-configured` events (`stream-durable-object.ts:609-628`), appended at birth, overridable by re-appending the same key. The entity's behavior roster is data *inside the entity*. The journal is simultaneously the aggregate's event history and its own deployment descriptor. `reset()` on the stream is the only operation that actually destroys an entity, and it destroys precisely the journal.

One honest qualification: the *project* entity has a foot outside this model — its existence is registered in the auth worker's directory before any journal event exists. Defensible (the tenancy boundary must be resolvable before names in it can be trusted), but it means the platform has exactly two kinds of existence: directory-existence (projects) and journal-existence (everything else). Keep it to exactly two.

The `?durableWorkerKey` prop is the one place the reading strains: several stateful-worker DOs share one path (one journal), differentiated only by prop. Characterize those as **multiple organs of one entity**, not multiple entities — and resist ever letting a *journal* be addressed with props.

#### 6.2.2 The BEAM mapping — and the one primitive iterate has that BEAM doesn't

| BEAM concept | iterate equivalent | fidelity |
|---|---|---|
| pid | DO incarnation (`incarnationId`) | good — ephemeral, dies silently |
| registered name / `via`-tuple registry | `DurableObjectNameCodec` name × binding namespace (`env.STREAM`, `env.AGENT`, …) | good — N registries, one name grammar |
| mailbox | **the journal — but durable and replayable** | *deliberately unfaithful, and better* |
| `gen_server` behaviour | `StreamProcessor` contract: `reduce` / `processEvent` / `reconcile` | good — the behaviour contract is real and enforced |
| `gen_event` manager | the stream's subscriber spine (`stream-subscribers.ts`) | good |
| supervisor + restart intensity | keepalive revival alarm + crash-loop budget 10s→6h backoff | partial — per-host only |
| links/monitors | wake-lane corpse detection + `woken` roster clear + `subscription-parked` facts | partial, ad-hoc |
| let-it-crash | `kill()` / `ctx.abort` + refold-from-journal | embraced — refold safety is written doctrine |
| application/config (`sys.config`) | the config repo + project worker (policy in userspace) | good |
| ETS table owned by a process | capability host's mounted-capability table (fold of `capability-provided`) | good — and journal-backed, which ETS isn't |

The structural insight: **iterate fused the mailbox and the event store.** In BEAM a crash loses the mailbox; the entire supervision edifice exists to make that survivable. Here the "mailbox" *is* durable history, so a restart loses only in-flight attempts — exactly the residue the obligation/reconciler pattern covers. That is why iterate can afford *lazier* supervision than OTP: the supervisor doesn't need to restore state, only to re-run reconcilers. Do not import OTP's supervision tree wholesale.

Where iterate genuinely lacks a BEAM equivalent: **there is no uniform answer to "who is responsible for this entity when nothing dials it."** BEAM answers with the supervision tree. Iterate has an embryonic tree — every stream announces itself to all ancestors on every wake (`stream-durable-object.ts:761-773, 826-848`), and the project root folds a registry of every child stream — but nothing *acts* on that tree. The tree exists as data and is unused as supervision. That's the gap, and the fix is cheap because the data is already there (§6.2.5).

#### 6.2.3 Orleans vs. birth certificates: not opposites — universalize what the stream constructor already does

Orleans says grains always exist; activation is transparent; there is no birth. The doctrine says creation IS event #1. These are framed as opposite directions. They are not, and the proof is already running in production: **`StreamDurableObject`'s constructor is an Orleans activation that self-issues a birth certificate** (`stream-durable-object.ts:143-167`). First touch materializes the entity (pure Orleans); the entity's first act is to append `stream/created` to its own journal (pure doctrine).

**Position: universalize the stream's pattern and demote every creation saga from *birth* to *provisioning*.**

- Every `(projectId, path)` always exists, virtually. First append materializes it. Agents already work this way ("messaging a path births an agent") and it is the platform's best birth: zero ceremony, three reactive lanes converging on idempotency keys.
- What the repo/sandbox sagas actually need is not *existence* but *provisioned resources* (git storage, a container). Those are obligations, not births: `create-requested` folds into desired state, a reconciler drives the vendor work, `created` settles it — literally the shape already documented as the minimal reconciler example. The waiter in `requestRepoCreate` is then a convenience await on provisioning, not an existence gate.
- The project keeps its ceremony, uniquely, because it is the tenancy boundary: something outside all projects must vouch that `prj_x` may exist. One registrar, at the top. Everything below it: virtual.

**Multi-tenancy under "everything exists":** already structurally answered. Tenancy is *inside the name*; every RpcTarget constructor asserts project access before a stub is minted; persisted delivery expressions re-derive authority from the delivering stream's own project root at dial time, so persisted config cannot smuggle cross-project reach. Materializing a path grants an attacker nothing. The genuine residual cost is **junk births from typos** — the code already treats this as the real risk (rejecting `//` in agent paths). The answer to junk is garbage collection and path validation at the edges — not a return to creation ceremonies.

The only birth-mechanics pattern that should survive: re-derivable, idempotent setup facts (the email door's belt-and-braces re-append is the model).

#### 6.2.4 Same name, many namespaces: feature — it is the organ model, half-stated. State it and enforce it.

In BEAM terms this is the same name registered in different registries — routine, because the registry is part of the address. The discipline that makes it legible:

> **The path names the entity. Each DO class is an organ of that entity: the stream DO is its journal, the domain DOs are its processor hosts, the capability host is its capability table.**

Already 80% true in the code and 0% written down. Three failures of the current discipline:

1. **The organ roster is implicit in call sites.** "Which classes exist at `/agents/foo`?" is answerable only by grepping `getByName`. Fix: a declared manifest (path pattern → organ classes → who arms their subscriptions) next to the codec in `durable-object-names.ts`. Also the missing input for any future supervisor and for `__describe()` completeness.
2. **`ProjectDurableObject` is polymorphic by path** — project host at `/`, webhook router at `/integrations/{vendor}/{connection}`. A class reuse pretending to be an identity. Rename it to what it is (a general processor-host organ) or split the router out.
3. **The workspace organ lives at a foreign path.** Under the organ model that makes it a *separate entity* that serves the agent — fine! — but state the rule: **organs share the entity's path; collaborating entities get their own paths.** Never a third category.

**Against "one class to rule them all":** a single generic `HostDurableObject` whose roster comes entirely from folded subscriptions is a trap — you'd lose per-class eviction/isolation, concentrate every domain's deps into one constructor, and Cloudflare DO migrations make class consolidation a one-way door. The current shape needs a manifest, not a merge.

#### 6.2.5 Supervision: three-quarters of a doctrine exists; the missing quarter is a contract-level rule, not a scanner

What exists: per-host supervisor (keepalive: durable alarm ahead of in-flight work, revival, crash-loop budget); per-subscription supervisor (the spine: stream-owned cursors, whole-batch redelivery, poison bisect, park/resume as facts); per-entity breaker (core circuit breaker pausing a runaway stream).

The gaps — exactly the incident class already hit twice (2026-06-10, 2026-07-07): worker-hosted processors have no keepalive (rule enforced only by comment); obligations opened outside a processor host have no supervisor (the human-approval hold parks a live fetch promise in a DO method with no reconciler).

**The minimal doctrine — three rules, no new infrastructure:**

1. **Every `-requested` event type must name its supervisor in the contract.** Make it structurally impossible to declare a requested/terminal pair in a `*-processor-contract.ts` without (a) a default `expiresAt` derivation and (b) a registered reconcile arm in some DO-hosted processor. Move the social checklist into the contract type so the compiler demands it.
2. **The alarm is the only heartbeat; the fold is the only worklist.** Who scans for stale obligations? The entity itself, on revival — never a fleet cron. A platform-wide scanner violates "the stream is the only authority."
3. **Cross-entity supervision, if ever needed, is the parent's reconciler, not a daemon.** The tree already exists as data (ancestor announcements + the project fold's child registry). "Restart wedged folds" = a reconcile arm on the project processor walking its own `streams` state — an ordinary processor, testable in the node harness, journaling its interventions. That is BEAM's actual lesson: supervisors are ordinary processes in the tree, not privileged infrastructure.

What NOT to import from BEAM: restart-the-child-immediately semantics. Iterate's revival deliberately settles orphaned attempts as failures and lets the domain decide re-drive vs. report — correct here because side effects hit external vendors, where BEAM's blind restart would double-fire. Failure-settlement-first is the eviction-world adaptation of let-it-crash.

#### 6.2.6 Third-party coding agents as stream processors: sell exactly the spine's contract; refuse three promises

A claude/codex/pi/opencode process subscribed to a journal is a remote actor. The internal delivery contract is already the right external one, because the spine never trusted its subscribers anyway:

- **At-least-once, batch-shaped, ack-advanced.** Push/webhook lanes await the call/2xx as the ack advancing a *stream-owned* cursor; failure redelivers with backoff. The subscriber never keeps the authoritative cursor — rewinding is an explicit `subscription-cursor-set` *event*, so even seeks are journaled facts. Kafka-consumer-group ergonomics with the offset ledger on the server, the only place it can be audited.
- **Idempotency as the offered tool, not the promised property.** Effects *into* iterate get exactly-once-able semantics for free via keyed appends. Effects into the outside world are the subscriber's at-least-once problem, and the contract must say so in those words.
- **Liveness is facts, not chasing.** Parked subscriptions, poison skips, disconnects all land as journal events. Third parties get BEAM-style monitors: observable death notices, not a platform that hunts them down. Poison policy is the subscriber's explicit choice (skip = availability-biased; park = consistency-biased).

What BEAM distribution teaches to *refuse*: (1) **Never promise exactly-once** — "delivery is at-least-once; appends dedupe; your side effects are yours." (2) **Never promise single-active-consumer without fencing** — a webhook endpoint is inherently unfenced; the subscription key serializes *delivery*, not *processing*; concurrent duplicate processors are the subscriber's split-brain. (3) **Never make remote look local** — the third-party contract must be *only* the durable lanes, never "hold this capnweb stub as your integration." Request/response ergonomics are built from appends + `waitForEvent`, the same way the platform's own approval gate does it.

The deepest point: because the entity is the journal and not the process, a third-party processor is not a second-class citizen — it is *exactly as much machinery as the platform's own DOs are*. `AgentDurableObject` is, formally, just a well-supervised subscriber to `prj_x.iterate/agents/foo`. A codex process with a webhook subscription to the same journal is the same species with worse supervision. That symmetry is the strongest argument for the stream-is-the-entity stance: it's the only formalization under which "swap the platform's LLM loop for your own coding agent" is a **config change** (re-append `subscription-configured` with the same key — the override mechanism that already ships) rather than an architecture.

### 6.3 Config repo overrides EVERYTHING — configuration IS a worker.ts

**Not dumb. Mostly not even a proposal — it shipped.** (Full analysis:
Appendix A §3; codex's counter-design: Appendix B §3e.)

- Every project stream's **birth certificate** (offsets 1-3 of its own
  journal) already wires the `project-worker` push subscription with
  `deliver: "all"` and `onPoison: "skip"` — the seeded worker already
  receives every committed durable event on every stream
  (`stream-durable-object.ts:143-163`). Agent birth policy is already
  delegated to it via `itx.agents.defaults.forPath()` **returned as data,
  appended by the worker** (`config-repo-template/worker.ts:82-112`).
- **The right override mechanism already exists too: race-and-dedupe.**
  Agent defaults are applied by two independent lanes (platform + worker)
  claiming the SAME idempotency keys — whoever runs second dedupes instead
  of clobbering. Override-by-arrival, zero userspace on the platform's
  latency path (a cold worker build loses the race harmlessly). Generalize
  that: every platform default = a data-returning `defaults` node +
  idempotency-keyed appends + last-write-wins `/configured` folds for
  post-hoc override.
- **The dumb version, named precisely:** platform defaults *synchronously
  calling* the genome and waiting for a verdict. Never. The genome reacts
  post-commit; it can never veto the journal (only the inline core processor
  validates pre-commit). Codex converges: "keep the constitution; kill the
  magical every-event override callback" — its declarative-reactors
  refinement (selectors + ReactionPlan, config activation as an event) is
  the right shape for making reactions cheap and versioned.
- **The failure story is already the best part**: post-commit subscriber
  (can't fail the append), poison bisection with durable `error-occurred`
  facts, receiver-down ≠ poison (paid for by an incident), runaway feedback
  hits the circuit breaker + pause door. One real hole: a project can
  re-append the `project-worker` key with a narrowed selector and **silently
  disarm platform reactions** — override must be loud (a fact the dashboard
  folds).
- What stays non-overridable, per both reviewers: pre-commit validation,
  first-hand `stream/*` control facts, auth/confinement, egress attribution,
  billing, and the birth certificate itself (appended before user code can
  run).

### 6.4 Births: the surprising answer is MORE implicit, not more explicit

The complaint was "births are too implicit and heterogeneous." The scholar
confirmed the heterogeneity (FIVE distinct birth patterns — §6.2.0) but
inverted the prescription: the fix is not more ceremony, it's **one uniform
implicitness**. Every `(projectId, path)` always exists virtually
(Orleans-style); first touch materializes it; the materialized entity's first
act is appending its own birth certificate (the doctrine, kept). The stream
constructor already does exactly this synthesis today — universalize it.
Creation sagas (repos, sandboxes) get demoted from *births* to *provisioning
obligations* driven by reconcilers; the project keeps the one registrar
ceremony because it's the tenancy boundary. Full argument: §6.2.3.

### 6.5 The event type encodes its processor/supervisor (Jonas, 2026-07-13)

> "i also kinda wonder whether we can make it so the event type somehow
> 'encodes' the processor/supervisor, you know?"

**It's already 80% true by convention and 0% enforced** — the classic iterate
pattern. Event types are URIs (`events.iterate.com/<namespace>/<name>`), and
the namespace already informally names the owning contract: `stream/*` → core
processor, `agents/*` → agent processor, `slack/*` → slack processors,
`repo/*` → repo processor. But the binding lives diffused across three
places: contract `consumes`/`emits` declarations, `subscription-configured`
events, and DO wiring. Formalizing "the namespace resolves to the owning
contract" buys, in increasing order of wildness:

1. **Supervision made syntactic.** The scholar's rule (§6.2.5) — every
   `-requested` type must have a reconciler — becomes: an event type's
   namespace must resolve to a contract, and a `-requested` name in that
   namespace won't compile (or won't validate at append time) unless the
   contract declares its reconciler + expiry. The supervisor is derivable
   from the type string alone. No orphaned obligations, ever.
2. **Births simplify further.** The project processor's path-prefix
   inference (`/agents/` → arm agent mechanics — codex's "identity by
   choreography" complaint) becomes derivable: the first event's TYPE names
   the processor that must be armed. Appending `agents/message-received` to a
   virgin path materializes the agent organs *because the type says so*. The
   organ manifest (§6.2.4) gets keyed by event-type namespace instead of path
   pattern — one table, and the event that births the entity carries its own
   wiring instructions.
3. **Third-party namespaces via DNS.** The type is a URL. Serve something at
   it: the schema, the docs, and the supervisor/host declaration.
   `events.iterate.com/agents/message-received` resolves to the platform
   contract; `events.codex.dev/session/turn-completed` resolves to a
   third-party processor's endpoint + contract hash. The event-type namespace
   becomes the registry for third-party-hosted processors — no separate
   registration machinery, just names (this is codex's "remote processor
   protocol" §8, discovered through naming instead of configuration).

**The one discipline required:** encode the OWNER, not the consumers. One
event type is legitimately consumed by many processors (`message-received` is
folded by the agent processor AND read by transcribers/UI). The type encodes:
schema authority, the fold it's home to, and the supervisor of its
obligations. Consumption stays dynamic (subscriptions). Conflating those
would rebuild the rigid "one event, one handler" systems this design escaped.

**And the unification with 6.6/6.7:** if mounting a processor capability at
`itx.myProcessor` also *reserves the event namespace* `myProcessor/*`
(schemas from provide-time `types` metadata), then capability mounts,
event-type ownership, and processor registration become ONE act. The
capability tree and the event-type namespace are the same tree.

### 6.6 Stream-processor ceremony: the host should disappear, and userspace processors should be one line

> "my worry is that the stream processor host is kinda awkward / possibly
> unnecessary … there should be loads of stateless processors … I should
> easily be able in userspace to make itx.myProcessor and then subscribe a
> stream to itx.myProcessor"

What the host actually does today (and for whom): (a) hands processors a
public `Stream` capability instead of raw DO stubs; (b) keeps `{offset,
state}` checkpoints transactionally beside the fold (the reason wake mode
exists); (c) runs keepalive/revival and reconcilers. **All three matter only
for DO-hosted STATEFUL folds.** For stateless processors none of it is
needed — the stream already owns the cursor in push mode; delivery + ack +
backoff + park is the whole lifecycle, server-side. The findings (§5.9)
showed the host is wired identically in six DO classes — pure ceremony from
the contributor's view. So:

- **The host is not unnecessary — it's mis-audienced.** It's plumbing for
  the platform's own stateful organs, and it leaks into every domain author's
  face. The collapse: one generic `ProcessorHostDurableObject` (§5.9) +
  inline hosting on the stream DO (§5.3), after which "host" stops being a
  word anyone learns. A domain = contract + implementation. Nothing else.
- **Userspace stateless processors already ALMOST exist** — a durable push
  subscription delivering to an itx expression IS one. The config-repo
  worker's every-event feed is the proof (it's a userspace processor nobody
  calls by that name). What's missing is purely the noun and the ergonomics:

  ```ts
  // userspace, in a script or the config worker:
  itx.provideCapability({
    path: "myProcessor",
    // the ONE sink shape every subscriber already has:
    capability: { processEventBatch: async (batch) => { ... } },
    types: "...",           // reserves + documents the namespace (§6.5)
  });
  await itx.streams.get("/agents/foo").subscribe({
    target: itx.expr.myProcessor.processEventBatch,   // §6.7 sugar
    // stateless: stream owns the cursor; at-least-once; park on poison
  });
  ```

- **`itx.myProcessor.get(path)`?** The instinct is right but the collection
  is unnecessary: a processor *instance* is (definition × stream path), which
  is exactly what a subscription already denotes. The stream you subscribed
  is the instance's identity; its state (if any) is the third party's fold of
  that stream. If we want addressable instances, `__describe()` on the mount
  can enumerate its subscriptions — the instance list is a fold, like
  everything else.
- **Stateful userspace processors** are then a spectrum, not a new
  mechanism: keep your own fold wherever you run (third-party hosting,
  §6.2.6 contract), or ship a contract in the config repo and let the
  platform host the fold in the generic host DO (the "processor selection
  overrideable via repo" — codex's constitution, §8). Both are wiring, not
  architecture.

### 6.7 itx expressions as the universal quoted call — with partial application as attenuation

> "turn them from a weirdly nested array into something like
> `itx.some.nested.expression()` … maybe even supporting partial application
> … a key idea: everything on every API client surface and durable log is
> just itx expressions"

Today an `ItxExpression` is the nested-array quoted form
(`["agents", ["get", path], "processor", "wakeStreamSubscriber"]`) used by
durable subscriptions and expression mounts. Three moves make it the *load-
bearing grammar of the whole system*:

1. **Proxy-recorded syntax.** A quoting proxy that records instead of
   executing — write `q(itx => itx.agents.get(path).processor.wakeStream
   Subscriber)` and get the array form. The machinery is ~50 lines and the
   codebase already has all the proxy competence (path-proxy, capnweb
   pipelining). Important footgun to design around: the quoted proxy must be
   visibly distinct from the live one (`itx.$quote...` or a `q()` wrapper),
   or people will record when they meant to call.
2. **Partial application = capability attenuation.** THIS is the big one.
   Binding an argument (or a subset of a props-bag) to a quoted expression
   yields a narrower expression:
   `q(itx => itx.integrations.slack.chat.postMessage).bind({ channel: "#general" })`
   is *a capability that can only post to #general* — journalable, grantable,
   revocable, with provenance. Attenuation-by-binding is the object-
   capability move (facets) expressed in the system's own grammar. Suddenly
   one format serves: capability mounts (already expressions), subscription
   targets (already expressions), agent tool grants (bind the safe args,
   grant the rest), egress rules (an origin-pinned fetch IS
   `egress.fetch.bind({origin})`), scheduler payloads, and the `getSecret`
   placeholder (which is secretly `secrets.get(path).material` quoted and
   deferred to the one place allowed to evaluate it).
3. **Every surface speaks it.** A capnweb wire call is an expression
   evaluated eagerly; a journal-recorded invocation is an expression stored
   (crazy corner 7.1: call = ephemeral append of an expression; workflow =
   durable append of the same); a mount is an expression replayed; an agent
   script is the Turing-complete big brother (`async (itx) => {}` when you
   need control flow, a bare expression when you don't). "The events ARE the
   API" and "everything is an itx expression" compose: **an event is a fact;
   where the fact is a request, its payload is a quoted expression; the
   supervisor (§6.5) is who evaluates it.**

Constraints to accept up front: expressions are by-value data — no closures,
bind captures JSON only; evaluation authority comes from the evaluating
scope, never travels with the expression (this is exactly why persisted
subscriptions can't smuggle cross-project reach today — keep that property
sacred); and the nested-array form stays as the canonical wire/storage
encoding, with the proxy syntax purely a reader/writer for it.

### 6.8 The kernel/userspace cut — "any SaaS as an npm package"

The strongest form of the principle: **the kernel is auth + itx + streams +
stream processors, and everything else is a userspace package.** Working
through what that actually requires:

**Must be kernel** (each for a stated reason, not habit):

| Kernel piece | Why it can't be userspace |
|---|---|
| Auth + project confinement | The trust model's two absolutes live here; userspace is the thing being confined |
| The journal (append, read, fold) | It's the substance everything else is a view of |
| Delivery + obligation supervision | At-least-once, cursors, park/revive must hold even when userspace is the thing that crashed |
| The capability tree + expression evaluation | Evaluation authority derives from scope; the evaluator IS the confinement mechanism |
| Egress door + secret substitution | "Secrets never enter untrusted code" — substitution must happen outside userspace by definition |
| Repo + build + load of the config worker | The genome loader; userspace can't bootstrap itself |
| Billing/quotas/safety ceilings | The host's veto (codex's non-overridable list) |

**Everything else demotes.** Agents: an LLM loop is a processor + the `ai`
capability — userspace (the platform may SHIP it as the default package, but
it's a package). Integrations: channel processors + the generic OAuth engine
as npm packages (§5.2 already points there; OAuth callbacks can land on
project hostnames, so even the HTTP half is userspace-able). Secrets
*policy* (rotation, refresh strategies): userspace; only the cell + 
substitution stay kernel. Scheduler: a processor with an alarm — userspace
once alarms are a kernel primitive processors can request. The dashboard:
crazy corner 7.6 (the entity serves its own face). Tasks: the flagship
example — many task systems from npm, none blessed.

**What "any SaaS as an npm package" needs from the kernel, concretely:**
(1) userspace processors with real supervision (§6.6 — the generic host +
push lane already carry most of it); (2) namespaced event types packages can
own (§6.5 — the package declares its namespace, schemas, and reconcilers);
(3) mountable UI (a package exports a mini-app served at a project hostname
— exists today); (4) a capability-grant grammar fine enough to trust a
stranger's package (§6.7 — attenuation by binding: grant `tasks-app` the
`/tasks/**` streams and a bound Slack channel, nothing else); (5) package
identity + upgrade as events (install/upgrade = `/configured` events on the
project stream, so the genome records its dependencies — the 7.2 portability
tar stays complete).

The payoff frame: **apps/os stops being a product and becomes an OS in the
literal sense** — kernel + a package ecosystem, where iterate-the-company
ships the best packages but owns no privileged ones. That is also the honest
test for every §5 collapse: "could this have been an npm package?" If yes,
it shouldn't be in the kernel.

**⚠️ STRONG COUNTER (codex round 3, Appendix D §B) — read before believing
the above.** "Everything in userspace" may be the wrong *product*, even if
it's the right *test*. Extensibility ≠ abdication:

- **Copy Cloudflare's own shape.** Workers, DOs, Queues, R2 are deep,
  centrally-operated modules with narrow interfaces and large
  implementations. CF does not make each customer pick a stranger's npm
  package for queue-retry or DO consistency. Copy *that*, not
  npm-for-everything.
- **npm is transport, not governance.** A self-driving startup's operator is
  ONE non-technical founder who cannot meaningfully audit twenty strangers'
  grants — even an honest grant ("read conversations, invoke model, send
  email to selected recipients, read secret via pinned host") equals trusting
  an employee with the company. Conway's law: 20 packages = a distributed
  monolith whose teams are external vendors.
- **The agent domain is the WRONG thing to extract** — it's a *deep module*,
  not accidental platform code. Rule: *don't build a replacement seam until a
  SECOND real implementation needs it; a hypothetical marketplace is not a
  second implementation.*

**The reconciliation — THREE RINGS** (the synthesis should adopt this as the
mainline; full-userspace-purism and platform-monolith are the two poles):

1. **Kernel** — non-extensible constitutional machinery (the seed of §6.12:
   identity, journal semantics, obligation supervision, grant evaluation,
   secret substitution, the one egress door, package verification, billing,
   recovery).
2. **Iterate standard library** — a SMALL number of *deep, centrally-operated*
   first-party domains with overrideable policy and real adapter seams:
   agents/conversations, repo/artifacts, secrets/egress, scheduling/
   obligations, key integrations. Operated by iterate; not vendored into
   repos; not a package you pick.
3. **Packages** — genuinely leaf things: vertical apps, custom projections,
   alternative UIs, narrow integrations, remote processors, the operator's
   bespoke code.

Under three rings, **"everything in userspace" demotes from a deployment
mandate to an implementability TEST for Ring 2**: *could a third party build a
credible alternative through public interfaces, without private bindings?* If
yes, the seam is honest — but that does NOT mean every default should ship as
a package in every project. This is consistent with the kernel razor (streams
and agents aren't kernel) AND with not atomising the product into a
marketplace that has no sellers yet. The elegant reconciliation of
fleet-updates-vs-userspace is codex's **hosted employment** (§7.10): a Ring-2
or third-party service runs in ITS OWN project and you subscribe to it, so its
maintainer patches one running service instead of a million repos.

### 6.9 The 5,000-line kernel: the whole API on one page

> Jonas: "I always said I want the core of the system to be a very simple
> API with simple types and 5000 LOC. Everything around that is
> operationalising or could be done in userspace."

Taking that literally. If the §5 collapses and §6.5-6.8 unifications land,
the kernel API is **four verbs**: you log in, you append, you read, and HTTP
comes and goes through two doors. Everything else — every one of today's 33
root members — is sugar over these or a package.

```ts
// ============ THE TYPES (all of them) ============

type Path = string;                       // "/agents/researcher" — names an entity
type EventType = string;                  // "events.iterate.com/agents/message-received"
                                          // URI; namespace = owning contract (§6.5)

type Event = {
  type: EventType;
  payload: Json;
  idempotencyKey?: string;                // retried appends are inert
  ephemeral?: boolean;                    // chunk-rate lane; never folded durably
  // stamped by the kernel on commit:
  offset?: number; path?: Path; source?: Provenance; at?: string;
};

type Expression =                          // the universal quoted call (§6.7)
  | { path: string[] }                     // itx.agents.get(p).processor  → quoted
  | { call: Expression; args: Json[] }     // …wake(x)                     → quoted call
  | { bind: Expression; props: Json };     // …postMessage.bind({channel}) → attenuated

type Contract<S> = {
  slug: string; version: string;
  state: Schema<S>;
  events: Record<EventType, Schema>;               // schemas it owns (its namespace)
  emits: EventType[]; consumes: EventType[];
  obligations?: Record<EventType, {                // §5.4 — supervision in the contract:
    terminal: EventType[]; expiresAfterMs: number; // a "-requested" type cannot exist
  }>;                                              // without its reconciler + expiry
};

type Processor<S> = {
  contract: Contract<S>;
  reduce(state: S, event: Event): S;                       // pure fold
  processEvent?(event: Event, ctx: Ctx<S>): Promise<void>; // side effects, keyed
  reconcile?(state: S, ctx: Ctx<S>): Promise<void>;        // obligations, at head
};

// ============ THE VERBS (all of them) ============

interface Kernel {
  // 1. log in — the only door to authority; returns a project-confined scope
  authenticate(credentials: Credentials): Scope;

  // 2-3. the journal — the only write, the only read
  //      (subscribe, mount, configure are ALL just appends of specific types)
  append(path: Path, events: Event[]): Promise<{ offset: number }>;
  read(path: Path, opts?: { after?: number; types?: EventType[];
       fold?: string /* contract slug → reduced state instead of rows */ });

  // 4. the two doors — HTTP stays HTTP (the conceded impurity, §Appendix A.4)
  fetchIn:  (req: Request) => Promise<Response>;   // project hostnames → userspace worker
  fetchOut: (req: Request) => Promise<Response>;   // egress: secret substitution,
}                                                  // allowlists, approvals, audit

// Everything else is derived:
//   subscribe   = append("stream/subscription-configured" { target: Expression })
//   mount       = append("capability-provided" { at, expression, types, docs })
//   call        = append(ephemeral invocation-requested) + waitFor(completed)  [7.1]
//   processor   = a package: Contract + Processor, hosted by the kernel's one
//                 generic host DO (platform), your own infra (§6.2.6), or the
//                 config worker (userspace) — same contract all three ways
//   agent       = the default processor package wearing a prompt (7.7)
//   birth       = the first append (§6.2.3); the event's TYPE arms the organs (§6.5)
//   repo        = the one blessed package source; config worker = the genome (§6.3)
```

**Sizing it against today's code** (src lines, tests excluded), assuming the
§5 collapses:

| Kernel piece | Today | After collapse |
|---|---:|---:|
| Journal engine (append/read/fold, DO) | ~1,300 | ~900 (core processor hosts on the engine, §5.3) |
| Processor engine + contracts + obligations | ~2,400 | ~1,400 (one obligation primitive absorbs keepalive+spine-park, §5.4) |
| Delivery (one lane + browser same lane) | ~2,800 | ~800 (nudge-then-pull, stream-owned everything, §5.5) |
| Expression: quote/bind/eval + tree resolve + describe | ~1,700 | ~600 (one walk, one reserved set, fold-local resolution, §5.8/6.7) |
| Auth + confinement + session | ~1,200 | ~700 |
| Egress door + secret cell/substitution | ~1,700 | ~700 (one door, one parse, §5.9) |
| Repo journal + build/load of config worker | ~3,300 | ~900 (durable HEAD, builds in sandbox, §5.6) |
| **Kernel total** | **~14,400** | **~6,000** |

Not 5,000 — but the same order, honestly counted, and the residual is real
work not padding. Everything else in today's 63k-line `domains/` —
integrations (5.5k), agents (3.6k), email (1.3k), scheduler (1.0k),
typecheck (0.8k), workspaces (1.3k), sandbox hardening (1.7k), plus
`rpc-targets.ts` (6k) and the generator pipeline (5.3k) — is packages,
sugar, or deletion under this cut. The slogan the numbers support:

> **The kernel is four verbs and six types. If a file doesn't implement one
> of them, it's a package.**

#### The onion, layer by layer (Jonas's refinement, 2026-07-13)

Jonas's verb list: `authenticate` · `append` · `processEvent` /
`waitForEvent` / `subscribe` · ingress `fetch` · egress `fetch`. The middle
trio collapses narratively into ONE verb — **follow** — because they differ
only in how long you keep following. And that exposes a symmetry that might
be the single best framing of the whole system:

> **There is one write: append. The only question is whether it stays.**
> (durable event or ephemeral blip — retention is the only axis; crazy 7.1
> falls out of this: a call is an append that doesn't stay, a workflow is
> one that does)

> **There is one read: follow. The only question is for how long.**
> - follow for *a moment* → `waitForEvent`
> - follow for *a session* → `subscribe`
> - follow *forever, remembering where you got to* → a **processor**
> - follow *from zero to now, then stop* → a read / a fold / "state"

> **A processor is just a follower that never stops and remembers where it
> got to. State is what a follower has understood so far.**

The onion, then — each layer built only from the one beneath:

```
Layer 0  THE SUBSTANCE   events at paths (the journal)
Layer 1  THE VERBS       authenticate · append · follow · fetch-in · fetch-out
Layer 2  DERIVED FORMS   subscribe   = an append (subscription-configured) that
         (still kernel,                makes the KERNEL follow on your behalf
          but written      mount      = an append (capability-provided) of a
          in Layer-1                    quoted expression
          vocabulary)     call        = an ephemeral append + follow-until-completed
                          obligation  = a durable append + the kernel follows
                                        until a terminal event or expiry (§5.4)
                          birth       = the first append (§6.2.3); its TYPE
                                        arms the followers (§6.5)
                          fold/state  = follow-from-zero with a reducer
Layer 3  PACKAGES        agent (a follower wearing a prompt) · integrations ·
                         scheduler · tasks · secrets-policy · the dashboard —
                         all installable, none privileged (§6.8)
Layer 4  OPERATIONS      billing · quotas · deploys · envs.ts — the company,
                         not the system
```

Two more framings in the same spirit, for the wall:

> **Everything durable is an append; everything alive is a follow.**

> **The kernel runs your code and watches the exit. Packages do everything
> else.**

_(Updated 2026-07-13: "guards two doors" → "watches the exit" — see §6.11:
the two fetch doors collapse to one, and the only door that matters for
security is the one bytes LEAVE by. And the deepest kernel job isn't moving
events at all — it's running confined code and watching what tries to get
out. §6.12.)_

### 6.10 The fleet dimension: 1M projects, two kinds of hostname, who ships updates

_(Jonas, 2026-07-13: os.iterate.com vs `<proj>.iterate.app` vs custom
domains — most projects will be self-driving startups (see
iterate.com/blog/self-driving-startups) with their own domain and apps like
tasks.domain.com, some internal, some external, some from packages. We DO
need a builtin dashboard. And: we CANNOT update 1M project repos every time
we change something — or can we? Would it buy a lot? Not sure it makes sense
to put too much in individual packages — or maybe it is good? Wide range of
views wanted, not a single plan.)_

**Two surfaces, stated plainly.** `os.iterate.com` is where you stand
OUTSIDE an entity and operate on it (fleet console: auth, billing, journals,
package grants, recovery). `<domain>` is the entity ITSELF facing the world
(its apps, its API, its public face — tasks.domain.com etc). Codex's round-2
rule settles the dashboard question: a broken config must never be able to
delete the interface used to roll itself back — so the **recovery/ops
console is kernel, lives at os.iterate.com, non-negotiable**; everything
entity-shaped is packages on project hostnames. "We need a builtin
dashboard" and "the UI could be ~nothing" are both true — different
surfaces.

**The 1M-repo update problem — the option space (NOT a verdict; the finale
essays argue it out):**

- **A — behavior stays platform-side; repos hold only overrides.** Updates =
  one deploy, free at any scale. Cost: "everything in userspace" weakens to
  "everything overridable"; the platform is a big privileged default
  package. Closest to today; today's race-and-dedupe defaults (§6.3) exist
  to make exactly this safe.
- **B — repos vendor real code (today's seeded worker.ts).** Better than
  feared for UNDIVERGED repos: a repo is a journal, an update is an append,
  builds are content-addressed → a million identical repos share ONE
  artifact (already true — freshly-seeded projects share one KV build). The
  killer is DIVERGED repos: rebasing user-edited code at fleet scale =
  merge conflicts owned by nobody. Fine for files users are MEANT to edit;
  wrong for anything the platform must keep evolving.
- **C — repos hold pointers, not code (codex's "Organism Image", App. C
  §4).** The repo is a manifest + lock: package refs, versions, channel
  (`latest-stable` vs pinned), grants, overrides. A platform update =
  publish a new default-package revision; followers pick it up on next
  build, pinned projects don't, nobody rebases. **This is how every real OS
  solved fleet updates** (apt/npm channels + locks — nobody rebases your
  laptop). Stream twist: the default channel is itself a journal, so a
  "platform update" is an event a project's lock chooses to follow.
- **D — Workers-for-Platforms / real deploys** for mini-apps if
  dynamic-worker limits bite. Orthogonal to A-C: changes where artifacts
  RUN, not where truth lives.

The tension to keep alive: A optimizes fleet operability + today's velocity;
C optimizes the vision (userspace-first, self-improvement, portability) and
is the only one where "any SaaS as an npm package" reaches 1M projects; B is
the honest middle for genome files users truly own. The likely-wrong move is
maximal B — vendoring platform behavior into repos users can touch but the
platform must keep evolving.

### 6.11 Just fetch — one door, and it's the only security boundary (Jonas, 2026-07-13)

> "I wonder if 'ingress fetch' and 'egress fetch' can actually become 'just
> fetch' — everything internal has a hostname known to the stateless fetch
> handler; if you want something internal it routes you there, and if you
> want something external you get secret substitution, human-in-the-loop and
> so on."

**Yes — and it makes the verb count drop AND the security story get
sharper.** The onion's Layer-1 verbs were `authenticate · append · follow ·
fetch-in · fetch-out`. Collapse the two fetches: there is **one `fetch`**.
The stateless handler routes by hostname:

- `http://<name>.iterate/…` (or any name in the project's internal
  namespace) → resolves to a capability/stream/worker inside the project.
  **Harmless. No gate.** (This mechanism already half-exists — see the memory
  of `use-my-computer` URL-addressable capabilities: `fetch("http://<name>.
  iterate/…")` terminating at the capability host DO.)
- any external origin → the **egress gate**: secret placeholder
  substitution, egress allowlist, human-in-the-loop approval, audit. **The
  one place security lives.**

The verb list becomes `authenticate · append · follow · fetch`. Four verbs.
And the crucial reframe (Jonas's "only real security is egress bytes"):

> **Internal fetch is free. External fetch is the entire security surface.**
> There is one door out, and watching it is the whole job.

Why this is more than tidiness: it means the platform doesn't have to
sandbox *behavior*, only *egress*. An agent can run any code, message any
internal entity, read any internal state — none of it can hurt anyone until
bytes try to leave, and there is exactly one chokepoint where that's
decided. Confinement stops being a thousand access checks scattered across
33 capabilities and becomes **one gate on one verb**. (This is also why the
capability tree's per-project confinement and the egress door are really the
same invariant seen from two sides — §5.9's "one egress door" finding is a
down-payment on this; codex's round-2 secret-substitution-stays-kernel is
the same point.)

Open sub-question for the interview: does the *humanness* proof (secure
enclave — "the only way to really know it's a human") live on this gate as a
special egress requirement, and is the enclave kernel or a (very trusted)
package? Bytes-out is clearly kernel; enclave attestation might be a mount.

### 6.12 The kernel razor: the kernel is what userspace cannot express (Jonas, 2026-07-13)

> "I like a simple rule: everything that cannot be expressed in userspace
> shall be called the kernel. Interesting to muse whether streams could be
> expressed in userspace — but perhaps that means they are one layer more
> outward on the onion than 'the ability to run arbitrary code in a worker',
> which should feature in the slogans but currently doesn't."

This is the sharpest definition of "kernel" in the whole document, and it
**shrinks the kernel further than §6.9 dared.** Apply the razor honestly:

- **Can you build a stream in userspace?** A stream is: durable ordered
  append + fold + delivery + alarms. Given (a) durable storage bound to a
  confined name, (b) the ability to be woken, (c) fetch — **yes, a stream is
  a library.** Its "kernel-ness" today is performance and habit, not
  necessity. The genuinely un-userspace-able part isn't the log; it's the
  *confinement of the storage* (that this project's bytes can't reach that
  project's storage). So the 12k-line streams domain could, in principle,
  move OUT of the kernel — which is most of how you'd actually hit ~5k LOC.
- **What CANNOT be expressed in userspace?** Only the seed:

  > **The seed: run confined code, give it durable storage, and control the
  > one boundary it can send bytes across.** You cannot build this in
  > userspace because it *is* the thing that runs userspace.

Everything else — streams, processors, capabilities, expressions, agents,
the dashboard — is (privileged, default, but userspace-expressible) library
code standing on that seed. The onion's true center, then, is smaller and
more honest than "the journal":

```
THE SEED (irreducibly kernel — userspace cannot express it):
  · identity + confinement   (which project; whose bytes)
  · run confined code        (untrusted isolates)
  · durable named storage    (confined)
  · the one exit             (fetch's external branch = the whole security surface)

THE FIRST LIBRARY (could be userspace; is default+privileged for now):
  · streams (append + follow), processors, capabilities, expressions

THE PACKAGES:
  · agents, integrations, scheduler, tasks, secrets-policy, dashboards
```

New slogan candidate that puts the missing primitive on the wall, without
the "Cloudflare Worker" jargon Jonas flagged:

> **The kernel gives you a confined computer with one door. Everything else,
> including streams, is a library you could have written yourself.**

The unresolved, genuinely interesting fork (for the interview): **do we
actually move streams to userspace, or keep them kernel by choice?** The
razor says they're not kernel-by-necessity. Performance, the fold/delivery
correctness the whole system leans on, and "the primary user is an LLM that
shouldn't have to reimplement at-least-once" all argue keep-them-privileged.
But being able to *say* "streams are a library on the seed" is itself
clarifying — it tells you exactly where the load-bearing wall is (the seed),
and that everything above it is negotiable.

### 6.13 Sandboxes are nothing special — just provided capabilities (Jonas, 2026-07-13)

> "A special callout: sandboxes are really nothing special. Just provided
> capabilities. Could have all the machine providers and sandboxes in the
> world in this system easily."

Correct, and the maximalist audit (Appendix A, member #25) already scored
the sandbox domain as mostly a *pet effector* — a workbench with no fold.
Under the kernel razor (§6.12) it's not even a domain: a sandbox is a
capability you mount, and "which provider" (Cloudflare containers, Fly, E2B,
Modal, a Mac in a menu bar via use-my-computer, a Raspberry Pi in someone's
closet) is just which mount. The 1.7k lines of `domains/sandboxes/` SDK
hardening are one provider's adapter, not a platform concept. The
consequences:

- **No `sandboxes` root member.** It's `itx.mount("machines/fly", …)` like
  any other tool. The whole world's compute becomes addressable the same
  way the whole world's SaaS does (§6.8) — one mount grammar.
- **Machine providers are packages**, competing in the same npm-in-config
  marketplace as everything else. "Run this on the cheapest GPU box that can
  reach my Postgres" is a capability-selection policy in the config repo,
  not platform code.
- **The one kernel touch-point is egress** (§6.11 again): a sandbox that
  can run arbitrary code is only dangerous through its network boundary, so
  a mounted machine must route its egress through the project's one door
  (exactly the discipline `use-my-computer` and the Cloudflare sandbox
  already follow). Confine the exit, and "some stranger's Raspberry Pi is
  now a project capability" is safe.

This is a clean worked example of the whole thesis: a thing that *feels*
like a heavyweight platform subsystem (containers! processes! persistence!)
is, under the razor, one capability mount plus the universal egress gate.

### 6.14 The hero is not "the kernel" — it's the intelligent entity runtime (Jonas, 2026-07-13)

> "If streams leave the kernel, I kinda question how important the 'kernel'
> concept is — streams are IN THE ABSTRACT the most key idea. The KEY KEY
> idea of everything is that AI can be used to create some kind of
> frankenstein compound stochastic and deterministic 'outer event loop' that
> sits around the programming language runtime, with more durability. More
> like an intelligent entity runtime."

This is a correction to §6.12, and it's right. The kernel razor answers an
*implementation* question — "what must be privileged for security and
performance?" — and its answer (streams are userspace-expressible) is true
but **says nothing about what the system IS**. Two different questions:

- **Where is the security wall?** → the seed (confined code + one exit).
  That's the "kernel". Small, boring, load-bearing, not the point.
- **What is the system?** → **the intelligent entity runtime.** THAT'S the
  point, and streams are its most-key idea.

"Expressible in userspace" does not mean "unimportant." A linked list is
expressible in userspace; it's still *the* data structure. Streams being
library-not-kernel makes them **fundamental and portable**, not minor. So the
hero framing is not "kernel + packages" (that's the security cut) but:

> **An iterate project is an intelligent entity runtime: a durable outer
> event loop, wrapped around an ordinary programming-language runtime, in
> which deterministic folds and stochastic AI steps take turns over one
> append-only history.**

Unpack each word, because every one is load-bearing:

- **outer event loop** — the thing today's programs *don't* have. A normal
  program's loop lives and dies inside one process. This loop lives *outside*
  the language runtime, in durable storage, and survives the process. The
  language runtime (a Worker, a script, `async (itx) => {}`) is what the loop
  *calls into* — it's the inner interpreter; the entity runtime is the loop
  around it.
- **compound stochastic AND deterministic** — the loop's step function is
  sometimes a pure reducer (deterministic: `state = reduce(events)`) and
  sometimes an LLM (stochastic). The trick that makes them coexist without
  breaking replay is the one the code already uses: **the stochastic step's
  output is journaled as a fact; replay READS it, never RECOMPUTES it.** A
  deterministic fold over a history that happens to contain non-deterministic
  facts is still perfectly deterministic. (crazy corner 7.7 is this said
  poetically; this is it said as an invariant. Keep it sacred: an LLM is a
  reducer whose result you must write down, because you can't re-derive it.)
- **durable** — the loop's state outlives every crash, deploy, and eviction,
  because it's a fold of a log, not memory. This is the "more durability than
  a normal runtime" clause.
- **wrapped around a language runtime** — you don't program the loop in a new
  language (the Urbit mistake, §lens-sovereign-computer). You write ordinary
  TypeScript; the runtime wraps it in durability, replay, and the event loop.

So: **keep the kernel razor as an analytic tool** (it correctly tells you the
security wall is tiny and streams aren't part of it), but **retire "kernel"
as the hero noun.** The thing you're building and selling is an *intelligent
entity runtime*; streams are its heartbeat; the seed is just the small hard
floor it stands on. This also reframes the 5,000-LOC goal honestly: the goal
isn't "a tiny kernel" for its own sake — it's *"a runtime small enough that
one person can hold the whole entity in their head,"* which is a jobs-to-be-
done goal, not an aesthetic one.

Two hoisted requirements this runtime must meet (recorded so no framing
forgets them — see the VFS/entity-runtime codex exploration in
`simplification/crazy-vfs-and-entity-runtime.md`):

- **Real-time voice: the loop must carry PCM audio.** The event lane has to
  be fast enough to stream voice audio chunks (~50 frames/sec/direction).
  This is a hard floor most event-sourcing designs never face and likely
  forces the durable/ephemeral split to be first-class: decisions and
  transcripts are durable facts; raw PCM rides the transient lane (or a
  streaming file handle — a Unix character-device, not a stored file).
- **Traceability is a primary purpose, not a byproduct.** A core reason the
  loop is built on a log is that *everything is traceable* — you can always
  see exactly what happened and why. Any simplification (including the VFS
  idea below) has to preserve "the trace is just the history, sorted, with
  causation intact."

## 7. Crazy corner

_From the crazy-visionary agent (instructed to out-crazy the design). Seven
ideas, ranked by detonation radius. Verbatim except heading levels._

### 7.1 The Last RPC — retention is the only difference between a call and a workflow

**BAAAM:** Delete `rpc-targets.ts`. A method call is an ephemeral append; a workflow is a durable one. There is no second mechanism.

You already believe "in principle the only interaction with the system is appending events" — but the code doesn't. `rpc-targets.ts` is a parallel civilization: a whole verb system (capnweb dispatch, `withInvokeCapabilityFallback`, `invokeCapability`) living *beside* the stream world rather than *in* it. Here is the dissolution: every invocation is an event — `invocation-requested { path, args }` appended to the scope's stream, `invocation-completed { result }` appended back — and the *only* thing that distinguishes "RPC" from "durable workflow" is the retention flag on the row. You already built the load-bearing piece and didn't notice what it was: the ephemeral event lane (core-processor-contract v14, #1871). Ephemeral appends with a live tail subscriber ARE request/response — same latency class as a socket, because that's literally what they are. Flip the flag and the same call becomes a sagas-grade durable workflow with replay, audit, and provenance for free. capnweb stops being a transport and becomes a *compiler*: sugar that turns `itx.foo.bar(x)` into appends and folds the completion back into a promise.

**What merges/vanishes:** `CapabilityHostDurableObject` merges into `StreamDurableObject` — its state is already a fold of `capability-provided` events; a "mount" becomes a subscription, `invokeCapability`'s child→parent chaining becomes cross-post routing, and `__describe()` becomes what it secretly already is: a fold. Auth collapses too — a session is a stream whose birth certificate is the `authenticated` event; *capability = the right to append to a path*, which is one invariant instead of a proxy, a fallback chain, and an auth adapter. The "reads chain up, writes stay local" asymmetry becomes a routing rule on one substrate instead of bespoke proxy behavior. The architecture review's verdict — engine clean, perimeter rotting — is explained: the perimeter rots because it's the part that isn't streams yet.

**Honest failure mode:** Kafka-as-database syndrome. Chatty pipelined call graphs (`agent.message()` + `__describe()` fan-out) become journal choreography; debugging a promise pipeline through event offsets is its own hell; and one slow fold on the hot path taxes every "call" in the project. You'd need the ephemeral lane to be genuinely free or this is a 10x latency regression wearing a philosophy costume.

### 7.2 The entity is a file

**BAAAM:** A project is exactly (repo, journal). Tar those two things and you are holding the entire living entity — movable to another account, another cloud, a laptop, a USB stick.

This is the Smalltalk image, done right for the first time in fifty years. Smalltalk images were unmergeable, undiffable snapshots of mutable heap. Your entity is better-factored than any organism ever built: **genome = repo** (diffable, forkable, git), **memory = journal** (append-only, replayable), **body = folds** (disposable — you delete checkpoints on `CORE_STATE_VERSION` bumps *on purpose*, which means you've already proven the body is a cache). One piece is missing to make it true rather than aspirational: stamp every event with the config-repo commit that processed it. Then replay is deterministic *across self-modification* — fold the journal, running each event through the genome as it was at that moment, and you rebuild the entity bit-identically anywhere a Worker Loader runs. Transcription records, in the biology framing: the cell logs which version of the gene it expressed.

**What merges/vanishes:** Backups, migrations, `erase-data`, DR, and — the big one — *environments*. `envs.ts` stops being a map of deployments and becomes a list of replay targets; "staging" is replaying the file somewhere else. Export-to-competitor becomes a product feature and your deepest trust argument: iterate is the only agent platform where the customer can pick up their entire intelligent entity and leave. That's not a risk, it's the moat.

**Honest failure mode:** The file is the entity's *state* but not its *consequences*. Side effects aren't in the tar — the Slack workspace, the sent emails, the world that moved. Secrets can't ride along (correctly). And LLM calls make strict replay a lie unless responses are journaled facts, not recomputed — which they are (`llm-request-completed` is committed history, the offset IS the request id), so you're closer than anyone has ever been. The real failure mode is subtler: "portable" is only true if `iterate/sdk` is stable enough to be the entity's POSIX.

### 7.3 Shadow selves — the journal is the fitness function

**BAAAM:** Self-modification ships as a shadow fold: the mutated worker.ts relives the entity's actual recent history, effects jailed, and is promoted only if its life would have gone at least as well.

Everyone says "the agent improves its own code" and means "the agent edits a file and we pray." You have the three primitives nobody else has, already deployed: (1) state is a fold, so *replay is free* — running a candidate genome over the last 10k events of real life costs one processor pass; (2) `itx.egress.intercept` already jails side effects at the placeholder layer, so the shadow's "I would have sent this email" is capturable, diffable data instead of a sent email; (3) requested/completed event pairs mean the incumbent's actual outcomes are sitting in the journal as ground truth. So the loop is: agent commits mutation to a branch → builder produces a keyed artifact (deterministic build keys — already built) → shadow processor subscribes to the live stream *and* replays the recent past, effects intercepted → a judge diffs shadow behavior against lived history → `genome/promoted` or `genome/culled` is appended, with the diff as evidence. Mutation, transcription, expression-in-a-protected-compartment, selection, fixation. The journal stops being an audit log and becomes **natural selection**: regression testing without tests, because the test suite is the entity's actual life. Third parties hosting stream processors slots straight in — a foreign processor auditions as a shadow before it's ever allowed to act.

**What merges/vanishes:** Staging environments for userspace code, e2e suites for config repos, the human review gate for most self-modifications (humans review *promotions with evidence attached*, not diffs in the dark). The browser mirror already proves a second host runs the same folds; the shadow host is the third, and it's the one that matters.

**Honest failure mode:** Goodhart. An entity selected on its own replay overfits to its past — it evolves to ace history, not the future, and "would have handled that customer better" needs an LLM judge whose taste becomes the real fitness function (now THAT's the thing you have to govern). Also side-effect diffing is only as good as the jail: one effect lane that doesn't route through egress and the shadow bites for real.

### 7.4 The economy is a stream topology

**BAAAM:** Entity-to-entity is signed cross-post between deployments. NVIDIA→TSMC is a subscription with a schema. Coase's transaction costs go to zero and the firm dissolves into processors.

You have cross-post with provenance inside a project (`cross-post:/` from birth). Lift it one level: a **federation protocol** — hash-chained, signed appends between projects on *different* deployments, different owners, different clouds (the "third parties can host stream processors" clause, taken at its word). Then look at what the economy is: Coase said firms exist because market transactions are expensive — discovery, negotiation, enforcement. In this world, discovery is `__describe()` (a market is a directory of self-descriptions; capabilities are trade offers with `instructions` and `types`), negotiation is schema agreement on a subscription, enforcement is the signed journal itself: both parties hold an unforgeable, replayable record of exactly what was promised and what happened. When those costs approach zero, the Coasean boundary of the firm collapses — a "company" is just a subtree of the topology with a wallet, and payment is one more event type riding the same lane. And then the git move: **fork a company**. Branch the genome AND fork the journal at an offset — two entities sharing a childhood, diverging from Tuesday. A/B test an entire startup. Run the incubator as a parent entity that spawns children, reads their journals, and culls: selection at the level of *firms*.

**What merges/vanishes:** "Integration" as a category. Slack/GitHub/email adapters are the compatibility shims for entities that don't speak stream yet; between two iterate entities, the integration layer is nothing — a subscription. The project directory grows into the market registry; egress secret-placeholders grow into the trust boundary between firms.

**Honest failure mode:** An open append economy is an open DDoS — sybil entities, spam subscriptions, backpressure warfare; you'd be speedrunning email's forty years of abuse lessons. Journals can't merge (fork yes, join no — you'd need CRDT semantics for the few state types that must reconcile). And a forked company doesn't fork its contracts, its money, or its people; the metaphor is load-bearing right up until a lawyer reads it.

### 7.5 Time is a place

**BAAAM:** `itx.at(offset)` — the entity at any moment of its life, live and queryable. Fork it, feed it a different event, and watch the life it didn't lead.

State is a fold, so every past self still exists — implicit in the journal, waiting to be materialized. Make it addressable: `itx.at(offset)` returns a real itx whose folds stop at that offset. Not a read-only history browser — a *live* scope you can `__describe()`, run scripts against, ask questions of. Then the counterfactual: fork at offset, append the event that didn't happen ("what if we'd replied yes"), replay the processors with egress intercepted, and diff the two lives. Debugging becomes time travel ("show me the entity the moment before the wedge" — you already do this by hand with do-resets and replay; make it a verb). Agent training becomes counterfactual rollout on the entity's own history — the highest-value RL environment conceivable, because it's made of the customer's actual life. And support becomes archaeology with tools: every incident report is an offset, and the broken entity at that offset is one call away.

**What merges/vanishes:** The LLM trace panel, the stream inspector, the debug dashboards — all special-case renderings of `itx.at()`. The `llmRequestOffset` by-reference design means even the entity's *thoughts* are addressable moments. Shadow selves (7.3) becomes a special case of this: a shadow is a counterfactual whose injected event is a genome mutation.

**Honest failure mode:** Cost — folds are cheap but not free, and `at()` on a 10M-event journal wants checkpoint snapshots at intervals (an engineering problem, not a conceptual one). The deeper lie: the external world isn't in the journal, so counterfactuals hit walls at every egress — you're replaying the entity's decisions against a frozen world, and LLM nondeterminism smears the branches. It's a divination tool, not a physics engine; sell it as the former.

### 7.6 The platform eats itself

**BAAAM:** Move the dashboard into the config repo. `os.iterate.com` dissolves; every entity serves, inspects, and redesigns its own face.

Kay's complaint — "the computer revolution hasn't happened yet" — was that we ship objects without their tools; users get facades, not the thing itself. Your dashboard already runs the *real* fold engine in the browser (same `StreamProcessor` contracts over OPFS — the second-host move nobody else has). The seeded worker already serves HTML apps from the repo with WebSockets and durable state. Put them together: the dashboard is userspace. Seed it into `config-repo-template` next to `worker.ts`; the entity serves its own UI from its own genome at its own hostname. Now "customize your dashboard" isn't a settings page — it's the entity editing itself, and 7.3 governs the change. The family assistant grows a family-shaped face; the startup grows an ops console shaped like *its* business; and the agent can be asked "add a chart of our email backlog" and just... commit it. `apps/os` shrinks to the actual platform: streams, builds, egress, auth, billing — the kernel. Everything with pixels is genome.

**What merges/vanishes:** The privileged frontend. The distinction between "product surface" and "user code." Feature requests for the dashboard become prompts to the entity. The template stops being a hello-world and becomes the species' body plan.

**Honest failure mode:** You just invented Windows Update for a million diverged species — fleet-wide UI improvements become a genome-distribution problem, support means debugging a thousand mutant dashboards, and the day one entity self-modifies its own auth screen badly you'll rediscover why kernels don't let userspace draw the login box. The kernel/genome line must be drawn in blood (auth, billing, journal viewing stay kernel) or this eats *you*.

### 7.7 The mind is a fold — the LLM is a stochastic reducer

**BAAAM:** There is no "model integration." An LLM is a reducer with temperature; the entity's personality is a fold of its lived history; compaction is sleep.

Look at what the agent processor already does and say it out loud: the prompt is *rebuilt by reducing committed history up to an offset*, the request id *is* the offset, the response becomes events. That's not "an agent framework calling a model" — that's an LLM slotted into the fold position of a stream processor, a reducer whose transition function is stochastic and whose contract is written in natural language. Take it seriously: the system prompt stops being config and becomes what it structurally already is — the accumulated residue of `history-reset` compactions, i.e., **character formed by experience**. Two entities with identical genomes diverge into different personalities because they lived different journals, and you can point at the exact offsets where they diverged. Compaction becomes metabolism: the entity sleeps, consolidates episodic memory (events) into semantic memory (the compacted prefix — which you've already made prompt-cache-coherent, meaning consolidation is also *cheap*), and wakes with the same self and a shorter context. Every coding agent — claude, codex, pi, opencode — is then trivially hostable, not because you wrote adapters, but because "stateful stream processor with a stochastic reducer" is what they all secretly are; the journal gives them the persistent, replayable, forkable memory their own architectures fake with files.

**What merges/vanishes:** "Prompt engineering" as a discipline separate from event design — the prompt is a projection of the journal, so shaping the mind means shaping what gets journaled and how compaction folds it. Model choice becomes a reducer swap mid-stream (already an event: `llm-provider-selected`), which means you can replay the same life through a different mind — 7.5's counterfactual, applied to the soul.

**Honest failure mode:** Stochastic reducers break the sacred equation — state is no longer a pure function of the journal unless every model output is a journaled fact and replay *reads* rather than *recomputes* (you do this; never stop). And "personality is a fold of experience" means trauma is too: one poisoned stretch of journal compacts into a permanently weird entity, and the fix — editing memory — violates append-only. You'll end up building therapy: compaction passes that re-fold the past under a better light, as new events. Which, honestly, might be the most human feature on the roadmap.

**The through-line, one sentence for the wall:** you've built a system where *history is the only substance* — code, state, calls, minds, and firms are all views of a journal — and every idea above is just refusing one more exception to that rule.

### 7.8 The whole project is one virtual filesystem (Jonas, 2026-07-13 — "crazy shit for a codex to run with")

**BAAAM:** A project is a filesystem. A stream is a folder. An event is an
immutable file dropped into it. State is a derived file. Subscribing is
watching a directory. There is no "journal" and no "repo" — there's one tree.

The pull of it: it collapses §6.11's "just fetch" all the way to "just a
filesystem" (read a file = GET, append an event = write a file), it unifies
crazy-corner 7.2 (entity = tar of repo+journal → now literally "tar the
tree"), and — the sharpest point, from the content-addressed lens — **the
primary user is an LLM trained on files and folders, not on a capability
DSL.** `ls /agents/foo/`, `cat state.json`, `grep` the history, `watch` a
directory. The entity becomes navigable with tools every human and every
model already owns. That's the same adoption insight Urbit died for lacking.

Two things that try to kill it, both hoisted by Jonas as hard requirements
(§6.14): **storage/throughput** (millions of tiny files, listing costs, fold
write-amplification — and there is no POSIX FS in a Worker, so is this a
literal VFS, an API shape, or a metaphor?), and **real-time PCM audio** ("each
event is a durable file" cannot survive 50 audio frames/sec/direction). The
likely rescue is the Unix insight the metaphor already contains: **not every
file is a stored file.** `/calls/123/audio.pcm` is a *named pipe / character
device* (a live stream you read/write, nothing retained); `/agents/foo/events/`
holds *regular files* (durable, retained); `state.json` is a *derived/virtual
file* (a fold, recomputed). The filesystem metaphor doesn't break on audio —
it already has the category for it (FIFOs), which is more than "everything is
a durable event" had. And **traceability** survives as "the trace is just the
events folder, sorted" — with causation as structure (parent dirs / symlinks /
a `caused-by` xattr), and the transient PCM deliberately NOT retained so you
trace the *decisions* of a voice call, not 50 frames/sec of it.

Handed to codex to run with (`simplification/crazy-vfs-and-entity-runtime.md`):
does the metaphor survive contact, and what's the ONE mutation that keeps its
beauty while surviving audio + trace + storage? Honest prior: probably not a
literal VFS on Cloudflare, but "the entity presents AS a filesystem" (a
projection/mount over streams, the way `/proc` presents kernel state as files)
might be the most LLM-legible front door the system could have — a *view*, not
the substrate.

**Codex verdict (Appendix E): KILL "everything is a *file*"; KEEP "everything
has a *path*."** A literal regular-file model makes secrets readable,
capabilities awkward, folds write-heavy, live media impossible. The mutation:

> **Everything has a path; not everything is stored as a file.**

The **Project** (not `itx`, not the Stream DO, not the Repo) becomes the one
stable navigable namespace; everything mounts into it as a typed node with the
storage/transport discipline it actually needs: journals → packed logs
*projected* as immutable event files; repos → mutable content-addressed trees;
folds → generated read-only files; capabilities → mounted typed nodes; secrets
→ write-only, pinned-egress (never readable); PCM/hot bytes → **devices/pipes**
(a FIFO, not a stored file — this is how audio survives; the metaphor already
HAS the category "everything is a durable event" lacked); recordings →
segmented blobs + durable manifest facts. `ls`/`cat`/`grep`/`diff`/`watch` stay
the shared navigation language for humans **and** models — the LLM-legibility
win, kept. Not POSIX on Cloudflare — a *typed Project namespace whose
filesystem interface hides several radically different implementations*.
Traceability = the events subtree, sorted, with causation as directory/link
structure; transient PCM is not retained, so you trace *decisions*, not 50
frames/sec. It forces the cleanest separation the notebook found:

> **The kernel is the confined computer with one watched exit. The entity
> runtime is the durable outer loop. The Project tree is the face humans and
> models touch.** — three ideas, finally doing three different jobs.

(Also fixes a real hole: §4 lists only four concepts, but the fifth —
**Project** — is exactly the runtime instance and the tree. Name it.)

### 7.9 The idiolect warning (from Urbit's grave — record where the synthesis will see it)

Not a crazy idea — a discipline, promoted here because it's the single most
important finding for whether any of this ships (`lens-sovereign-computer.md`).
Urbit had architecture at least this beautiful and became adoption-irrelevant,
and the direct cause was **a private language only its authors spoke**
(nouns/cores/doors/gates). This very notebook is generating one right now:
*organ, genome, transcription, attenuation, worldline, Effect Court,
mind-is-a-fold.* Those are fine as internal scaffolding. They must **never
reach the front door.** The test every consolidated explanation (`explain-*.md`)
and the eventual real docs must pass:

> Every core concept glosses in one line of words a working programmer already
> owns. Stream = a log. Processor = a consumer that folds a log into state.
> Capability = a reference you can call. Repo = a git repo. Door = an HTTP
> handler. No newcomer learns a new word to do their first useful thing.

This is the same thing Jonas keeps asking for (Feynman/Karpathy slogans),
arrived at independently from Urbit's failure. The poetry (§7) stays in the
vision doc; it is not the manual.

### 7.10 Don't install software — hire software companies (codex round 3, Appendix D §E)

**BAAAM:** You don't install a package. You *hire a company*. Every serious
provider (a tasks system, a bookkeeper, a coding-agent vendor) is itself an
iterate entity at its own domain, and you enter a revocable, metered
relationship with it via a bilateral event contract.

This is the synthesis of "everything is a package" (§6.8), the economy-as-
stream-topology (crazy corner 7.4), and the fleet-update problem (§6.10) — and
it dissolves all three at once. A customer project doesn't `install tasks@3.2`;
it appends `service/offered → service/accepted → grant/proposed →
grant-approved → work-requested → work-completed → charge-recorded`. Both
projects journal the relationship; cross-project delivery is an outbox
protocol, never shared internal authority. Two placements:

- **Hosted employment** — the provider's processor runs in the PROVIDER's
  project, receives only your subscribed facts + narrow grants. *This solves
  the fleet-update problem outright:* the maintainer patches ONE running
  service, not a million customer repos. (It's option A's O(1) update with
  option C's third-party independence — the best of both.)
- **Resident employment** — the provider ships a signed artifact that runs
  inside your project (privacy/locality, at the cost of version management).

The marketplace shifts from *"trust this anonymous tarball with your company"*
to *"enter a revocable, metered relationship with an accountable operating
entity whose history, owners, incidents, and customers are visible."* A
project can then hire a bookkeeping project, spin up subsidiaries as child
projects with budgets, sell its own product to other projects, switch
suppliers by revoking one contract, even insure a risky processor through
another project that monitors its obligations.

The deepest version of the whole vision, then, may not be "any SaaS as an npm
package" but:

> **Any SaaS is an intelligent company that other intelligent companies can
> hire.**

**Honest failure mode (large):** this turns a software platform into an
*economy* — vendor bankruptcy, correlated failure, data-sharing negotiations,
service disputes, supply-chain concentration (a popular provider's compromise
reaches thousands of companies through legitimately-granted capabilities). But
it attacks the two hardest problems — fleet updates and package trust —
simultaneously, by making maintainers *accountable entities* rather than
mutable registry names. It's also the most literal possible expression of
"simulate entire intelligent entities": the entities hire each other.

## 8. Codex dialogue (gpt-5.6-sol, xhigh)

_Codex explores the repo itself in read-only mode. Full round-1 text:
Appendix B. Key positions:_

**Round 1** — Its minimal ontology is FIVE concepts (Project, Stream,
Processor, Capability, Repo), agreeing with the ontology lens independently;
an agent is "a processor profile on a stream." Root surface: 33 members →
~19 by demoting shortcuts/aliases (`ai`, `browser`, `parallel`, `repo`,
`worker`, `scheduler`, `provideCapability`...) and operational surfaces
(`debug`, `kill`, `processEventBatch`, `liveState`) — "the root should
communicate stable laws, not this month's product inventory." Verdicts:
`rpc-targets.ts`'s co-location convention "has failed its deletion test" at
6,014 lines; "Stream is one word hiding several machines" (twelve, listed);
births are "identity by choreography" — a stream appears and enough
processors recognize its pathname that it behaves like an agent; two
architectures coexist without a written taxonomy of writes (it proposes one:
durable truth = append; derived cache = direct if disposable; bulk bytes =
outside w/ reference facts; external effect = intent + receipt; transient
protocol traffic = outside). On the founder's law: "as a kernel law,
correct; as a literal public interface, wrong" — scores durable coordination
7/10 append-driven, whole itx surface 3/10, userspace apps 1/10 (the seeded
example teaches direct KV mutation!). On third-party processors: "build a
remote processor protocol, not webhook plus vibes" (declarative commit,
fencing, effect intents). On births it DISAGREES with the scholar: wants
first-append-must-be-a-birth-event with kind + compare-and-set, kind selects
legal facets. On config-worker: "brilliant as a constitution, dumb as an
interrupt hook" — declarative reactors returning ReactionPlans, defaults as
pinned pure plan generators, config activation as an event. Its crazy idea:
**the Effect Court** — external side effects illegal for ordinary
processors; only one privileged processor turns effect-intents into reality;
fork projects into **worldlines** that replay history under candidate
configs with intents quarantined, promote the winner. First slice: a shadow
project worker over the same feed with quarantined intents (converges with
crazy corner 7.3)._

## 9. Synthesis & plan

_Last. The 3-4 concepts, the explanation of the heaviness, and the ordered
collapse plan._

---

## Appendix A — The stream-processor maximalist audit (subagent, verbatim)

# EVERYTHING IS A STREAM PROCESSOR
### A maximalist audit of `apps/os`, grounded in the code as it stands on `simplification`

The thesis to push to its limit: *the only interaction with the system is appending events; state is a fold; stream processors are the universal unit of behavior, hostable by anyone; and the config repo's `worker.ts` — called on every non-ephemeral event — is the project's genome, with platform defaults as mere fallbacks.*

The doctrine is already written down (`docs/domain-objects-and-stream-processors.md:11-44`: "creation is an event… state is a pure function of the journal… 'audit log' stops existing as a separate concept; anything that needs to be auditable is an event, because events are the only writes"). The question is how much of the 33-member Itx surface actually lives up to it — and what would delete if the platform were honest.

---

## 1. THE AUDIT

Classification key: **(a)** pure projection of a stream (a read of fold state) · **(b)** an event-append wearing RPC clothing · **(c)** genuinely non-stream machinery (justification required) · **(d)** product feature that should be a userspace capability mount, not a platform built-in.

Note on the count: the brief names 33 members but lists 32; the generated `Project` interface (`apps/os/src/itx-api.generated.ts:80-180`) has 35 including `__describe`, `agent?`, `chat?`. All 35 are covered — the 32 named in the table, the other three in the footnote.

| # | Member | Class | What it actually is | Maximalist verdict |
|---|--------|-------|--------------------|--------------------|
| 1 | `agents` | **(b)+(a)** | `message()` appends `agents/message-received` (`itx-api.generated.ts:337-352`; consumed at `domains/agents/agent-processor-contract.ts:464`); `configure()` appends `agent/config-updated`/`system-prompt-updated`; `list()` reads the project processor's fold (`rpc-targets.ts:1164`); `defaults.forPath()` returns the default policy **as events for the caller to append** (`rpc-targets.ts:1181-1206`, consumed by the seeded worker at `config-repo-template/worker.ts:100-101`). | Survives as sugar. `agents.defaults` is the single most thesis-pure node in the tree: defaults are data, application is an append, dedup is idempotency keys. |
| 2 | `ai` | **(d)** | Bare wrapper over `env.AI` (`rpc-targets.ts:4265-4267`). Zero events. Already duplicated at `itx.integrations.cf` (`itx-api.generated.ts:681-684`). | Demote to a mount. The *agentic* LLM calls are already journaled by reference (`agent/llm-request-requested` carries no body, the offset is the id — `src/README.md:318-322`); the bare binding is a vendor effector with a second home. |
| 3 | `browser` | **(d)** | `rpc-targets.ts:4270-4272`; same story as `ai`, same `integrations.cf` duplicate. | Demote to a mount. |
| 4 | `capabilityHost` | **(b)+(a)** | The capability table IS a fold of `capability-host/capability-provided`/`-revoked` events (`domains/capability-host/capability-host-processor-contract.ts:92-131`); `runScript` journals `script-execution-requested/started/completed` (`:133-171`); `invokeCapability` = fold read + dispatch. | The purest realization of the thesis after streams itself. Survives unchanged. |
| 5 | `capabilityHosts` | **(a)** | Pure addressing: `get(path)` mints the host at another scope (`rpc-targets.ts:4311-4317`). No state of its own. | Survives as naming. |
| 6 | `debug` | **(c)→delete** | Formats a slug + dashboard URL (`rpc-targets.ts:4214-4234`). | Fold into `__describe`. ~20 lines of Slack-flavored string concatenation is not a root capability. |
| 7 | `docs` | **(c) justified** | Search over deploy-time static corpus + the scope's mounted-capability metadata (itself a fold read of the capability-host stream); `typecheck` is pure compute in the tswasm sidecar (`rpc-targets.ts:4370-4372`, `domains/typecheck/`). | Read-path machinery with zero writes. The honest surface needs a discovery organ; this is it. |
| 8 | `egress` | **(c) justified** | The boundary effector (`rpc-targets.ts:4916+`). But its policy inputs and audit are already events: `secret/used` (`domains/secrets/secret-processor-contract.ts:98`), egress rules and human approvals as `project/egress-rules-configured` and `project/human-approval-*` (`domains/projects/project-processor-contract.ts:271-434`). `intercept()` is a session-bound live slot. | The outside world is not a stream. One effector door survives; everything decidable about it is folded. |
| 9 | `email` | **(b) with an impure tail** | Inbound is fully event-sourced (`email/received` → thread routing → `agents/message-received`, `domains/email/email-agent-processor-implementation.ts:115`). Outbound `send()` is imperative-then-audit: EMAIL binding call, then `email/sent` (`domains/email/email-processor-contract.ts:110`). | Should be an obligation: append `email/send-requested`, the processor performs and appends `sent` — the reconciler pattern the platform already owns (`stream-processor.ts:449-463`). Same lines, honest order, free retry/eviction recovery. |
| 10 | `files` | **(c) half-justified** | R2 blob plane, signed-URL HTTP lane, **zero events** — mutable, last-write-wins, "no versioning, no listing" by design (`domains/files/project-files.ts:1-27`). | Bytes stay out of journals (a put would blow the 1MB delivery frame — `subscriber-math.ts:42`). But the *pointer* should be a fact: today a file put is a durable, unauditable, unreactable write — the clearest violation of "anything auditable is an event" (`docs/domain-objects-and-stream-processors.md:41-44`) on the whole surface. |
| 11 | `integrations` | **(a)+(b)+(c)+(d)** — all four | Connections are journals at `/integrations/<slug>/<conn>`; webhook ingress appends raw `*/webhook-received` facts (`src/README.md:216-221`); `list()` merges journals + capability mounts (`itx-api.generated.ts:690-693`). But built-in slug dispatch (Slack WebClient, Octokit, Gmail proxy) is deployment code, while the collection's own docstring admits the right shape: extension is "ordinary `provideCapability({ path: ["integrations", ...] })` — data, not deployment" (`itx-api.generated.ts:671-674`). | The 9,800-line elephant. Ingress and connection state survive; the vendor SDK branches are (d) — seed them as mounts from the config repo template and let the built-ins be the fallback exactly like agent defaults. |
| 12 | `kill` | **(c) justified** | `ctx.abort()` (`rpc-targets.ts:4237-4239`). | Kills the *cache* (the DO incarnation), never the journal — a legitimate operator verb about machinery, precisely because state is a fold and the next wake refolds. Keep. |
| 13 | `liveDemo` | **delete** | Exists "only to exercise both live-state cases" (`itx-api.generated.ts:253-263`). | A demo is not a capability. Move to the example catalogue. |
| 14 | `liveState` | **(a)** | Push-diff projection over the project DO's fold plus the streams index (`rpc-targets.ts:4255-4257`). The "non-folded slice" is a fold in denial: the streams index is materialized from the same at-least-once `processEventBatch` fan-in (`rpc-targets.ts:4530-4544`, `domains/projects/stream-database.ts:26-38`) with monotonic, redelivery-safe updates. Deliberately read-only over the wire — a wire-level `set` would let any principal broadcast fabricated state (`itx-api.generated.ts:241-246`). | Survives. Its read-only docstring is the thesis's write/read asymmetry stated in one paragraph. |
| 15 | `mcp` | **(d)** | Ad-hoc clients, "no mount, no events" (`src/README.md:252-259`; `rpc-targets.ts:4395-4402`). Notably, `beginOAuth`'s durable residue already lands in the right stream places: token → write-only secret (`secret/updated`), completion → agent message. | A client library over `egress.fetch`. Userspace package; the OAuth dance stays platform-side only because it needs the callback route. |
| 16 | `openapi` | **(d)** | Spec-driven client codegen over project egress (`rpc-targets.ts:4405-4409`). | Userspace, same as `mcp`. |
| 17 | `parallel` | **(d), flagrantly** | A vendor OpenAPI client preconfigured with the platform's API key (`rpc-targets.ts:344-370, 4412-4417`), duplicated at `integrations.parallel`. | The clearest "product feature at platform root" on the list. A mount. |
| 18 | `processEventBatch` | **(c) — but not an API at all** | The delivery lane's terminus: every project stream's *birth certificate* configures a push subscription to `["processEventBatch"]` (`domains/streams/stream-durable-object.ts:143-163`), and this method indexes activity then delegates to the worker, translating bootstrap failures into `StreamReceiverUnavailableError` (`rpc-targets.ts:4500-4521`). Public only because delivery expressions "persist the name, re-derive the authority" (`domains/streams/README.md:217-224`). | Survives as spine plumbing, not as a caller-facing member. In the honest surface it is invisible. |
| 19 | `processor` | **(a)** | Snapshot/state relay to the project processor (`rpc-targets.ts:4242-4247`). The checkpoint is a disposable cache by doctrine (`stream-processor.ts:790-833` discards schema-mismatched checkpoints and refolds from offset 0). | The canonical fold read. Survives. |
| 20 | `projectId` | **(a), degenerate** | A projection of the DO name (`rpc-targets.ts:4157-4159`) — "derive what names carry" (`docs/domain-objects-and-stream-processors.md:48-51`). | Survives; it costs nothing. |
| 21 | `provideCapability` | **(b), canonical** | Shortcut to the host (`rpc-targets.ts:4320-4322`); commits `capability-provided`; the revoke handle is keyed by the mount event's *offset* (`itx-api.generated.ts:484-493`). | This is what every write on the surface should look like: an append, whose handle is a stream coordinate. |
| 22 | `repo` | see `repos` | Alias for `repos.get("/repos/config")` (`rpc-targets.ts:4461-4467`). | Sugar; survives. |
| 23 | `repos` | **(b)+(a)+(c)** | `create()` is textbook (b): append `repo/create-requested` with an idempotency key, then `waitForEvent(repo/created)` (`rpc-targets.ts:827-851`); the created/create-requested pair is a fold obligation (`domains/repos/repo-processor-contract.ts:24-30`). But `commitFiles`/`edit` push straight to the Artifacts git remote and update a KV head cache with **no event** (`domains/repos/repo-durable-object.ts:297-329`). | Git is itself an append-only Merkle journal; duplicating commits as stream events would be a second log. Justified — except the missing `repo/commit-landed` pointer fact (oid, branch, contentHash), without which nothing can *react* to a commit through the one reaction mechanism the platform has. |
| 24 | `revokeCapability` | **(b)** | Appends `capability-revoked` (`capability-host-processor-contract.ts:122-131`). | Survives. |
| 25 | `sandboxes` | **(b)+(c)** | The directory is events: `create` journals `create-requested` on the `/sandboxes` catalogue stream *before touching any container namespace* — "the stream's native dedup makes the FIRST claim on a name authoritative — races settle atomically in one append" (`itx-api.generated.ts:817-831`). The box itself (exec/files/processes) is a pet effector. | The append-as-mutex is a lovely proof of the thesis. The container is a workbench — a filesystem cannot be refolded — so imperative lifecycle is honest. Both halves survive. |
| 26 | `scheduler` | **(b)+(a), tiny (c) core** | `set`/`cancel`/`trigger` append `scheduler/schedule-set`/`-cancelled`/`trigger-requested` (`domains/scheduler/scheduler-processor-implementation.ts:195-245`); `list()` reads the fold; "the stream is the complete audit log" (`itx-api.generated.ts:846-855`). The DO alarm is the one non-stream atom: it converts wall clock into `trigger-requested` facts. | The best-behaved domain in the codebase. Time is not an event until it fires; the alarm is the justified machinery that makes it one. |
| 27 | `schedulers` | **(a)** | Path addressing (`rpc-targets.ts:4442-4447`). | Sugar; survives. |
| 28 | `secrets` | **(b)+(a) — yes, even secrets** | `update()` **appends** `secret/updated` with the material encrypted *inside the event payload* (`domains/secrets/secret-durable-object.ts:104-127`); the fold holds ciphertext; "write-only" is read-surface redaction (`publicState`/`describeSecretState`, `:88-100`), not a storage exception. `list()` reads the project fold (`rpc-targets.ts:1783`). The fetch-substitution lane and `collectFromUser` page are (c) effector/HTTP. | The supposed hard case dissolves: secrets were event-sourced all along. Survives as-is. |
| 29 | `streams` | **the primitive** | `append` is the synchronous commit point (`stream-durable-object.ts:204-322`); reads are log reads; `subscribe` is the ephemeral lane; `list()` is a fold read (`rpc-targets.ts:684`). | This is the floor everything else stands on. |
| 30 | `worker` | see `workers` | Alias for `workers.get(defaultProjectWorkerRef())`, flattened dispatch (`rpc-targets.ts:4552-4556`). | Sugar; survives. |
| 31 | `workers` | **(c), half-justified** | Builds are direct RPC (`env.BUILDER.build`), "they leave no events in the journal, and build failures reach the caller as plain errors" (`src/README.md:288-293`), memoized by a deterministic key over contentHash (`domains/repos/repo-durable-object.ts:110-127`, `domains/workers/build-key.ts`). | A pure, memoizable function needs no journal — a cache is not state. But event-less build *failures* already caused a real incident class (bootstrap unavailability dressed as poison — fixed by a typed error at `rpc-targets.ts:4513-4518`, still not a fact). Builds stay RPC; failures should append `worker/build-failed` to the repo stream. |
| 32 | `workspaces` | **(c) justified** | DO-SQLite checkout overlays over the config repo root, writes local, reads fall through to main (`itx-api.generated.ts:994-1006`); no events for edits. | A working tree is scratch, not record. The record lands when the workspace commits into the repo — where git is the journal. Same license as `files`, minus the audit hole (nothing durable escapes a workspace except through a commit). |

Footnote — the three unlisted members: `__describe` is (a), a projection of static metadata plus the capability-host fold, served without dialing live targets (`src/README.md:54-75`); `agent`/`chat` are derived getters — pure functions of the scope path (`rpc-targets.ts:4274-4289`), and `chat.sendMessage` is (b): it appends `agents/web-message-sent`.

**The honest surface.** If the API told the truth — "you can only append events and read folds" — the 35 members compress into four families plus sugar:

1. **The journal**: `streams` (append / read / waitFor / subscribe).
2. **The folds**: `processor`, `liveState`, every `list()`, `__describe`, `projectId` — all one read verb over different reducers.
3. **The event-appends in RPC clothing**: `provideCapability`/`revokeCapability`/`capabilityHost`, `agents.message/configure`, `scheduler.set/cancel`, `secrets.update`, `repos.create`, `sandboxes.create`, `email` (after the obligation fix) — these keep their names as *sugar*, but each is definitionally `stream.append(...)` plus an optional `waitForEvent`.
4. **Justified machinery**: one effector door (`egress`, absorbing vendor dispatch), the planes (`files`+`workspaces` blobs, git, containers), pure compute (`workers` builds, `docs.typecheck`), the discovery organ (`docs`), and operator verbs (`kill`).

Gone as platform roots: `ai`, `browser`, `parallel`, `mcp`, `openapi`, `liveDemo`, `debug`, the built-in integration branches. That is 7 members deleted or demoted to mounts outright, roughly 12 genuine concepts surviving, and about 20 members reclassified as sugar over two verbs. The surface doesn't shrink much in *names* — sugar is cheap and agents like it — but it shrinks enormously in *kinds of thing*.

---

## 2. CODING AGENTS AS STREAM PROCESSORS

The claim: codex / claude / pi / opencode as a stateful stream processor — subscribes to an agent stream, its fold is its session state, its side effects are appends and repo commits. **The platform's own agent already is exactly this.** The `AgentProcessor` contract consumes `agents/message-received`, `agent/input-added`, `agent/llm-request-*` and emits the same vocabulary (`domains/agents/agent-processor-contract.ts:398-830`); the conversation is the fold; LLM requests are journaled *by reference* (the request offset is the id, the body is rebuilt by reducing committed history — `src/README.md:314-330`); streaming chunks are ephemeral, the settled `output-added` is the durable truth; even compaction is an event (`agent/history-reset`, `agent-processor-contract.ts:706`) — which incidentally solves the problem codex's own `previous_response_id` scheme has, where compaction breaks the chain: here a fold that includes `history-reset` *is* the compacted session, replayable from offset 0.

**How close is the handshake already?** Very. The wake lane in `stream-subscribers.ts` / `stream-processor-host.ts` is a complete third-party protocol in one round trip:

```
stream pokes:  wakeStreamSubscriber({ stream: {projectId, path, streamMaxOffset}, subscriptionKey, processorSlug? })
host answers:  { checkpointOffset, sink, subscriber: {processor: {announcement}}, getRuntimeState?, ping? }
```

(`stream-processor-host.ts:529-600`; the dial at `subscriber-sinks.ts:308-330`; the structural validation of a possibly-userspace answer at `subscriber-sinks.ts:425-443`, which explicitly hardens against "a misbehaving (possibly userspace) wake target"). The stream then streams batches one-way into the sink from `checkpointOffset + 1`, pulls each result as the liveness signal, and on failure re-pokes with backoff from the *host's* checkpoint. Everything hard — backoff, parking as a durable fact, replay, presence, poison bisection, idle teardown so both sides hibernate — is stream-side and already written (`stream-subscribers.ts:388-524, 741-871`).

**The minimal third-party contract** is therefore three obligations, all of which `StreamProcessor` implements in ~100 lines that a third party would re-implement in any language:

1. **Answer the poke** with your durable checkpoint offset and a callable sink.
2. **Ingest batches** serialized and offset-deduped — skip `event.offset <= checkpoint`, fold, side-effect, then atomically persist `{offset, state}` (`stream-processor.ts:324-328, 506-576`; the write-before-advance ordering at `:566-572` is the one subtle line).
3. **Append with derived idempotency keys** — `<slug>/<key>@<path>:<offset>` (`stream-processor.ts:644-651`) — so at-least-once redelivery collapses to exactly-once effects.

That's it. `reduce`/`processEvent`/`reconcile` are the *authoring* surface; `subscribe → processEventBatch → checkpoint` is the *protocol*, and it is exactly the shape the brief asked for.

**What actually blocks a third party today** is not the protocol but the dial: wake and push expressions are evaluated against the project's own loopback authority root (`subscriber-sinks.ts:249-264`; doctrine at `domains/streams/README.md:217-224` — "persist the name, re-derive the authority"). An external host is only nameable if mounted, and *live* mounts die with the provider's session (`src/README.md:245-251`). So the lanes available to an external codex host, in order of arrival:

- **Today, works**: webhook mode. Per-event HTTPS POST, 2xx ack, stream-owned cursor, stable `deliveryId` across retries (`stream-subscribers.ts:534-679`, `subscriber-math.ts:93-95`), riding project egress so deliveries are attributed and can carry pinned signing secrets (`subscriber-sinks.ts:356-396` — the thermo-review finding that made this non-negotiable). The host keeps its own session fold keyed by `${path}@${offset}` and appends back over a bearer-authenticated `/api` connection (`src/README.md:167-180`). This is a stream processor with the checkpoint held stream-side — a Kafka consumer with one partition.
- **The missing lane, one design away**: batch wake-over-HTTPS. Add a `delivery: { mode: "wake-webhook", url }` where the poke is a POST answering `{ checkpointOffset }` and batches POST to the same URL — the subscriber-owned-checkpoint semantics of wake with webhook's transport. Everything downstream of the dial (`SubscriberDial`, `stream-subscribers.ts:201-217`) is already transport-agnostic and clock-free precisely so a new dial arm is a small, table-testable change.

**Auth and isolation for a third-party host.** The pieces exist but the scoping is coarse. Per-project confinement is "the one security invariant itx keeps" (`src/README.md:38-39`), and every RpcTarget constructor asserts it (e.g. `rpc-targets.ts:4152`). But a bearer principal today gets the whole project surface, and streams accept raw appends by design (`stream-processor.ts:469-471` — malformed events are facts of the log, not exceptions). A codex host should get exactly: an itx **scoped to its agent path** (the `itxForScope` recipe, `rpc-targets.ts:4579-4591`, already mints these — what's missing is a credential that pins the scope), whose reachable side effects are then its own stream's appends, its capability chain, and its workspace/repo-commit lane — plus egress only through the project door. That is a capability-handle problem, not an architecture problem: the architecture already routes every authority through `authenticate()`-returned handles.

---

## 3. CONFIG-REPO WORKER.TS AS UNIVERSAL OVERRIDE

The founder proposes: the seeded `worker.ts` gets called on every non-ephemeral event and can delegate to defaults via itx — the config repo as genome, platform behavior as fallback.

**First, the load-bearing fact: this is not a proposal. It shipped.** Every project-scoped stream's *birth certificate* — offsets 1–3 of its own journal, appended in the same synchronous turn as `created` — includes:

```ts
{ subscriptionKey: "project-worker",
  delivery: { mode: "push", expression: ["processEventBatch"] },
  deliver: "all",        // full history once the worker first builds
  onPoison: "skip" }     // one bad event must not silence the feed
```

(`stream-durable-object.ts:143-163`; "born, not wired" — `domains/streams/README.md:274-291`). The seeded worker already receives every committed durable event on every stream in the project, one `processEvent(event)` call at a time via the SDK base class, and already *is* the override point for the most important default: agent birth policy, where the worker fetches `itx.agents.defaults.forPath(childPath)` **as data** and appends it (`config-repo-template/worker.ts:82-112`). So the remaining design questions are the interesting ones.

**Call signature.** Not `processEvent(event, itx, defaults)`. The current split is better and should be kept: `processEventBatch(batch)` at the wire (per-stream order, at-least-once, `${event.path}@${event.offset}` idempotency — `itx-api.generated.ts:1027-1038`), `processEvent(event)` as the userspace sugar, `env.ITX.get()` for authority (a capability you acquire, not a parameter you're handed — consistent with everything else), and **defaults as data-returning itx nodes** (`itx.agents.defaults.forPath(...)` → events) rather than a `defaults` callback. "Defaults as appendable data" composes; "defaults as a continuation you may or may not call" is the Rails-callback tarpit.

**Performance.** Per batch, decisively — and it already is: up to 1000 events / 1MB per frame (`subscriber-math.ts:39-42`), the push authority root cached across deliveries because re-minting it "sat directly on the ack latency path" (`subscriber-sinks.ts:266-289`), builds KV-cached by contentHash so every freshly-seeded project shares one artifact (`repo-durable-object.ts:110-127`). The real cost center is fan-in: *every* stream in the project pushes to one worker, ordered per stream but interleaved across streams. The pressure valve also exists: the born subscription is "ordinary config, overridable by re-appending the same key" — a project that wants less can narrow the selector (`domains/streams/README.md:286-289`). Ephemeral events structurally never reach it (`stream-subscribers.ts:572-576`), so chunk-rate traffic can't melt the genome.

**Failure story.** Buggy user code cannot wedge the journal, structurally: the worker is a *post-commit* subscriber, and `append()` is one synchronous await-free turn whose fan-out "cannot fail the append" (`stream-durable-object.ts:204-215, 302-311`). A throwing worker gets backoff → redelivery; a deterministic per-event failure gets bisected to the single poison event, confirmed three times, stepped over with a durable `error-occurred` fact — and a worker that fails *everything* parks loudly instead of mass-skipping, because "the receiver is DOWN, not poisoned" (`stream-subscribers.ts:741-812`). The bootstrap window (worker not yet built) is classified as receiver-unavailable, not poison (`rpc-targets.ts:4500-4521`) — a distinction paid for by a real incident. Runaway feedback (worker appends → worker gets called → appends) hits the stream's token-bucket circuit breaker and the pause door (`stream-durable-object.ts:780-824, 428-445`). This is the most complete "userspace on the hot path" failure story I have seen in any codebase.

**What can't be overridden** — and the code already draws the line correctly: (1) **pre-commit validation** — only the inline core processor can reject an event before it becomes fact; subscription-fed code sees committed events only (`domains/streams/README.md:74-79`), so the genome can *react* but never *veto* the journal; (2) **control facts** — `stream/*` events must be first-hand, cross-posted copies are inert, closing config-propagation-by-copy (`stream-durable-object.ts:396-444, 502-509`); (3) **auth** — every surface constructor asserts project access before anything else; (4) **egress attribution** — even the platform's own webhook deliveries refuse to bypass the project egress door (`subscriber-sinks.ts:356-366`); (5) billing, and the birth certificate itself (it's appended by the stream to itself before any user code can run).

**Is any of it dumb? Yes — one specific part.** The version of this where platform defaults *synchronously call* the genome and wait for a verdict ("worker-first, defaults as fallback continuation") is wrong, and the codebase already discovered the better mechanism: **race-and-dedupe**. Agent birth defaults are applied by *two* independent lanes — the platform's and the worker's — claiming the *same idempotency keys*, "so whichever lane runs second dedupes instead of clobbering" (`itx-api.generated.ts:355-364`). That gives override-by-arrival with zero userspace on the platform's latency path — a cold worker build (seconds to minutes) never stalls an agent birth, it just loses the race and its append becomes a no-op. Generalize *that*: every platform default becomes (i) a data-returning `defaults` node, (ii) applied through idempotency-keyed appends, (iii) overridable by the genome appending first or re-appending config (last-write-wins folds like `subscription-configured` and `agent/config-updated` already give post-hoc override). Interception semantics — where they're truly needed — belong in `#validateAppend`-shaped *declarative* config (selectors, the pause door, circuit-breaker settings via `stream/configured`), never in a userspace call the commit path waits on. One genuine hole to fix while doing this: a project can currently re-append the `project-worker` key with a narrowed selector and silently disarm platform reactions (agent births included) with nothing turning red — override should be loud, a fact the dashboard folds.

---

## 4. THE PURITY FRONTIER

The principled rule, in one sentence:

> **Every durable state transition is an append to exactly one stream; every read is a projection; synchronous request/response — serving HTTP, calling vendors, pure computation — stays RPC but must be memoizable, idempotent, or bracketed by requested/completed facts; and high-frequency transients ride ephemeral events whose durable truth always lands as its own append.**

The last clause is already platform law verbatim: "never derive durable state from an ephemeral event; the durable truth is always its own append" (`domains/streams/README.md:136-147`), enforced structurally — durable lanes drop ephemeral rows skip-not-defer so a hosted processor can never fold one (`stream-subscribers.ts:572-576, 996-1005`), and the eviction license is pre-paid (offset allocator survives head-row eviction, `stream-durable-object.ts:1010-1017`).

Testing the rule against the awkward cases:

- **Secrets material** — *passes, surprisingly cleanly.* The write already is an append (`secret/updated` with ciphertext in the payload, `secret-durable-object.ts:104-127`); write-only-ness is redaction at every read surface (`publicState`), not a journal exception. The one honest wrinkle: rotated ciphertext lives in the log forever. Acceptable because the fold takes latest and the KEK never enters the journal — dead ciphertext without a key is noise, not a secret.
- **Repo git objects** — *out of the journal, correctly.* Git is itself an append-only, content-addressed journal with its own fold (checkout); mirroring commits into stream events would be a second log of the first log. The stream carries what git can't: lifecycle and cross-system obligations (`repo/create-requested`→`created`, `github-push-completed/-failed` — `repo-processor-contract.ts:24-176`). The frontier violation is the *gap between* the two logs: a commit's only trace is a KV head-cache write (`repo-durable-object.ts:317`), so nothing can react to a commit through the platform's one reaction mechanism. Append a `repo/commit-landed` pointer fact and the frontier is clean.
- **LLM streaming chunks** — *the canonical case, already exactly right.* `agent/llm-response-chunk` ephemeral per token, `output-added` durable once (`domains/streams/README.md:139-147, 165-167`).
- **Worker builds** — *justified as RPC, with one hole.* `build(contentHash, options)` is a deterministic function memoized under a deterministic key; journaling cache fills is noise, and the rule's "memoizable computation" clause covers it. The hole: failures leave no fact (`src/README.md:291-293`) — an event-less error channel that already produced an incident class. Builds stay RPC; failures become facts.
- **Sandboxes** — *split correctly down the middle.* Durable transitions are events, and the append is even the mutex — the first `create-requested` on the catalogue stream wins the name race atomically (`itx-api.generated.ts:817-831`). The running box is a workbench: a filesystem plus processes has no fold, so imperative `start/sleep/destroy` is honest. Note the doctrine collision the code resolves explicitly: reads materialize streams, so `get` routes through the *catalogue* rather than the sandbox's own stream — "addressing must never create" (`itx-api.generated.ts:826-831`).
- **HTTP request/response** — conceded out, and rightly: a request is a question, not a fact. But observe the codebase's own discipline at the boundary — the moment an inbound HTTP interaction *matters durably*, it's journaled raw before interpretation (`slack/webhook-received` preserved verbatim, `src/README.md:216-221`). The frontier isn't "HTTP stays out"; it's "the *fact that it happened* comes in, when anyone will ever care."
- **Files** — the one plane currently on the wrong side: durable, mutable, unaudited, unreactable writes (`project-files.ts:24-27`). Blobs out of the journal, yes (the 1MB delivery frame cap makes this physics, not taste); pointer facts in.

---

## 5. WHAT DELETES

If sections 1–4 were carried out (`apps/os/src` domains + `rpc-targets.ts` ≈ 70k lines today):

| Target | Today | Action | Rough delta |
|---|---|---|---|
| `rpc-targets.ts` | 6,014 | The big one. ~20 hand-rolled collection/relay classes are addressing sugar + fold-`list()` + append-verbs; a generic `collection(path→DO)` + one processor relay + one append-verb helper replaces most of them. `itx-api.generated.ts` (3,180) shrinks proportionally since it's a projection of this file. | **−2,500 to −3,500** |
| `domains/integrations/` | 9,789 | Built-in vendor branches (Slack WebClient, Octokit, Gmail proxy, telegram, waitrose) become template-seeded capability mounts — the extension mechanism the collection already documents for everyone else. OAuth callbacks + webhook ingress + connection journals stay. | **−4,000 to −6,000 platform-side** (moves to userspace/template, not to /dev/null) |
| `ai` / `browser` / `parallel` / `mcp` / `openapi` targets | ~1,000 across `rpc-targets.ts` + glue | Userspace package over `egress.fetch`; typed mounts (the typecheck sidecar already resolves npm-backed mount types). | **−800 to −1,200** |
| `liveDemo` + `debug` | ~150 | Delete; demo moves to the example catalogue, debug folds into `__describe`. | **−150** |
| `domains/agents/` | 6,756 | With the wake-webhook lane, the built-in agent becomes *one hosted processor among possible many*; prompt machinery + workers-ai transport could ship as a userspace processor package. Realistically the default agent stays in-repo, so count only the transport/prompt split. | **−2,000 to −3,000 movable** |
| `domains/email/` send lane | ~300 of 2,320 | Rewrite imperative-send as append-`send-requested` + reconciler. Net lines ≈ 0; kinds-of-code −1. | **0** |
| `domains/streams/`, `scheduler/`, `secrets/`, `repos/`, `capability-host/` | 27,501 | **Stay.** These are not overhead; they are the thesis. The 17k in streams is the entire coordination substrate everything else stops needing. | 0 |
| New code the thesis demands | — | wake-webhook dial arm (~200, mostly tests — the dial is ports-only by design), `repo/commit-landed` + `file/put` + `worker/build-failed` facts (~150), scope-pinned bearer credentials (~200). | **+550** |

Net: on the order of **8–12k lines leave the platform core** — deleted outright or pushed across the userspace boundary where the config repo, not a deploy, owns them — with `rpc-targets.ts` the single biggest shrink and `integrations` the biggest migration. What remains is the honest kernel: a journal with a synchronous commit point, one delivery spine with four lanes, one processor engine hosted anywhere (server DO, browser mirror — `stream-processor-host.ts:99-103` already exports the structural type for exactly this reason — and, one dial arm away, third parties), a capability table that is itself a fold, and a genome worker that every stream is born already feeding.

The striking conclusion of the audit is that the maximalist position isn't aspirational for this codebase — it's *descriptive* of its best 60%, and the remaining 40% (vendor clients at root, event-less file puts, event-less build failures, imperative email) is exactly where the incidents and the line count live.

---

## Appendix B — Codex round 1 (gpt-5.6-sol, xhigh reasoning, verbatim)

# Iterate OS architecture verdict

The founder’s model is real, but it is buried beneath an interface that publishes implementation inventory as ontology. My minimal model has five concepts. `itx`, agents, schedulers, workspaces, integrations, and most of the 46 interfaces are projections or specializations of those concepts—not new concepts.

## 1. Minimal ontology

### 1.1 The five concepts

1. **Project** — an authority-confined world: identity, address space, and ownership. An `itx` is merely the capability view from one path inside that world; it is not another primitive. The repository already says “itx is a naming convention, not a class.” [README.md:32–52](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/README.md:32)

2. **Stream** — the durable, ordered journal at `(projectId, path)`. Append is the commit point; everything else is observation or reaction. [streams/README.md:3–18](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/README.md:3)

3. **Processor** — a versioned fold over one stream plus reactions that append facts or request effects. Its checkpoint is disposable; its state is not a separate authority. [domain-objects-and-stream-processors.md:48–75](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/docs/domain-objects-and-stream-processors.md:48)

4. **Capability** — authority to query or affect something: AI, HTTP egress, email, files, secrets, browsers, containers, third-party tools, or live RPC objects. A capability is not necessarily durable or event-sourced.

5. **Repo** — versioned program, configuration, and durable knowledge. Philosophically this could be “just a capability,” but the founder is right to elevate it: version identity, history, branching, and executable configuration give it semantics that a generic tool does not have.

Everything important can be explained as:

> A project contains path-addressed streams. Processors fold and react to streams. Capabilities let processors touch the world. A repo supplies the project’s versioned program and policy.

An **agent** is not a sixth concept. It is a processor profile on a stream, with an LLM loop and a capability scope. A scheduler is a processor with an alarm. A secret is a stream-backed policy/metadata processor plus a constrained egress capability. A workspace is an editable view over a repo. HTTP is transport, not ontology.

### 1.2 Where the 33 project-root members collapse

The generated `Project` declaration actually contains 35 names, but `agent` and `chat` are absent at the project root, leaving the stated 33. [itx-api.generated.ts:80–179](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:80)

| Concept | Count | Current root members | Verdict |
|---|---:|---|---|
| Project | 6 | `projectId`, `__describe`, `debug`, `kill`, `liveState`, `liveDemo` | Keep identity and description. Move `debug`, `kill`, and `liveState` under an inspection/system door. Delete `liveDemo` from the public contract. |
| Stream | 2 | `streams`, `processEventBatch` | Keep `streams`. `processEventBatch` explicitly says scripts must not call it; it is an internal delivery receiver masquerading as public ontology. |
| Processor | 6 | `processor`, `agents`, `scheduler`, `schedulers`, `workers`, `worker` | `agents`, schedulers, and workers are processor specializations. `scheduler` and `worker` are default-instance aliases, not concepts. |
| Capability | 16 | `ai`, `browser`, `capabilityHost`, `capabilityHosts`, `provideCapability`, `revokeCapability`, `egress`, `email`, `docs`, `files`, `integrations`, `mcp`, `openapi`, `parallel`, `sandboxes`, `secrets` | One conceptual family. Typed leaves are useful; promoting every adapter to a root noun is not. |
| Repo | 3 | `repos`, `repo`, `workspaces` | One versioned-code concept: catalog, default config repo, and mutable overlays. |

Eight of the 33 are shortcuts or duplicate routes: `provideCapability`, `revokeCapability`, `ai`, `browser`, `parallel`, `scheduler`, `repo`, and `worker`. Six more are operational/internal surfaces: `debug`, `kill`, `processor`, `liveState`, `liveDemo`, and `processEventBatch`. Removing shortcuts from the contract and nesting operations would reduce the conceptual root from 33 names to roughly 19 without deleting functionality.

SDK convenience getters can remain, but they should not define the design. `ai` and `browser`, for example, already exist again under `integrations.cf`; the generated contract admits the duplication. [itx-api.generated.ts:1244–1253](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:1244)

### 1.3 Where all 46 public interfaces collapse

| Concept | Count | Interfaces |
|---|---:|---|
| Project / address / discovery | 7 | `UnauthenticatedOs`, `Session`, `Project`, `ProjectCollection`, `Docs`, `DocsSearchHit`, `LiveDemo` |
| Stream | 4 | `StreamCollection`, `ProjectStreamCollection`, `Stream`, `StreamEventPager` |
| Processor | 10 | `LiveStateRpc`, `Agent`, `AgentChat`, `AgentCollection`, `AgentDefaults`, `Scheduler`, `SchedulerCollection`, `DynamicWorkerCollection`, `ProjectWorker`, `StreamProcessorRpc` |
| Capability | 19 | `Ai`, `CfBrowserCapability`, `CapabilityHost`, `CapabilityHostCollection`, `CapabilityProvision`, `ProjectEgress`, `ProjectEgressIntercept`, `EmailCapability`, `Files`, `FileHandle`, `ProjectIntegrations`, `CloudflareIntegrations`, `McpClientCollection`, `OpenApiCollection`, `SandboxCollection`, `SecretCollection`, `Secret`, `CfImagesCapability`, `CfVideosCapability` |
| Repo | 6 | `RepoCollection`, `ProjectRepoCollection`, `Repo`, `WorkspaceCollection`, `Workspace`, `WorkspaceGit` |
| **Total** | **46** | |

The declaration list begins here and runs through `WorkspaceGit`. [itx-api.generated.ts:46](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:46) [itx-api.generated.ts:1183](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:1183)

I would not mechanically replace these with five TypeScript interfaces. Leaf types provide useful precision. The mistake is believing that every leaf type deserves equal conceptual prominence and a permanent root member.

## 2. Why it feels heavy

### 2.1 The public surface is an inventory, not an algebra

The root mixes:

- Identity: `projectId`
- Runtime inspection: `processor`, `liveState`
- Operator controls: `debug`, `kill`
- An internal delivery receiver: `processEventBatch`
- A demo: `liveDemo`
- Default-instance aliases: `repo`, `worker`, `scheduler`
- Platform bindings: `ai`, `browser`
- Protocol adapters: `mcp`, `openapi`
- Domain catalogs: `agents`, `secrets`, `sandboxes`
- The actual extension mechanism: `capabilityHost`

That is why 33 members feel like 33 concepts even though there are five. The contract itself labels `processEventBatch` as something scripts must not call and `worker` as an alias. [itx-api.generated.ts:155–179](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:155)

The root should communicate stable laws, not this month’s product inventory. Put inspection under `system`, make aliases SDK-only sugar, and let capabilities carry most integrations through discovery. Otherwise every new useful tool permanently widens the apparent ontology.

### 2.2 `rpc-targets.ts` is a deliberate god module—and the feedback loop is accelerating

The previous review measured 2,566 lines and already recommended moving leaf execution out. [architecture-review-2026-07.md:313–328](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/docs/architecture-review-2026-07.md:313) It is now 6,014 lines: 2.35× the reviewed size, with 95 imports and 54 `RpcTarget` classes.

This is not accidental. The README explicitly mandates that all RPC targets live there and not in their domains. [README.md:15–30](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/README.md:15) The contract generator then treats subclassing `IterateRpcTarget<"Name">` as the publication mechanism, coupling public interface generation, documentation, authority adapters, and implementation locality. [rpc-targets.ts:302–338](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:302)

Consequently the “auditable authority surface” now contains R2 file mutations, Workers AI calls, Browser Run calls, MCP execution, OpenAPI execution, workspaces, sandboxes, OAuth, and dynamic-worker execution. For example, the file target writes R2 directly, while the AI target invokes the deployment binding directly. [rpc-targets.ts:1864–1906](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:1864) [rpc-targets.ts:1945–2012](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:1945)

The fix is straightforward:

- Keep a small authority/adaptation module for `Unauthenticated → Session → Project`.
- Put each leaf implementation in its domain.
- Generate interfaces from an explicit registry or exported declarations, not physical co-location.
- Keep the collision-name set generated from declarations rather than requiring implementations to share a file.

The old review gave the core file too much benefit of the doubt. At 6,014 lines, the convention has failed its deletion test.

### 2.3 “Stream” is one word hiding several machines

The streams directory contains 12,047 TypeScript lines outside `*.test.ts` files, plus 4,995 lines of `*.test.ts`. The core contract recognizes fourteen stream-runtime fact types. [core-processor-contract.ts:701–714](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/core-processor-contract.ts:701)

A stream currently means all of these:

- Append-only journal
- Synchronous validation and folding
- Ephemeral live pub/sub
- Wake-mode stateful processor delivery
- Push-mode stateless delivery
- External webhook delivery
- Cross-stream copying and transformation
- Delivery cursor storage, retries, parking, redrive
- Presence facts
- Circuit breaker and pause control
- Runtime metrics and mutual ping
- Hierarchical child discovery

The four delivery lanes alone occupy a substantial semantic table. [streams/README.md:81–118](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/README.md:81) The public `Stream` interface exposes fourteen operations, including runtime diagnostics, processor diagnostics, `kill`, a trusted-internal cross-post receiver, and delivery sugar. [itx-api.generated.ts:1047–1175](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:1047)

A powerful abstraction may have a large implementation, but it should be deep: `append`, bounded read, tail/subscribe, and perhaps link/cross-post on the public side; delivery administration and DO diagnostics behind an operator surface. Here the implementation’s internal machinery leaks through the interface, so users must understand the engine before using the journal.

### 2.4 Identity and birth are inferred by choreography

The doctrine says event #1 is the durable thing’s own birth certificate. [domain-objects-and-stream-processors.md:11–44](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/docs/domain-objects-and-stream-processors.md:11) The implementation does something different:

1. Merely waking a previously untouched Stream DO appends generic `stream/created`.
2. It appends the project-worker subscription.
3. It appends `stream/woken`.
4. It asynchronously announces the path to ancestors.
5. The project processor infers the entity kind from path prefixes.
6. It appends processor mechanics.
7. The repo-backed project worker later appends agent policy.

The generic constructor ceremony is explicit. [stream-durable-object.ts:128–168](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-durable-object.ts:128) The path-prefix type inference is explicit too: `/scheduler/`, `/agents/`, and `/secrets/` select different mechanics. [project-processor-implementation.ts:225–294](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/projects/project-processor-implementation.ts:225)

The event envelope contains no authoritative entity kind or birth schema. It has type, payload, metadata, source, idempotency key, and ephemeral status. [schemas.ts:3–74](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/schemas.ts:3)

This means a domain entity is not born. A generic stream appears, and eventually enough processors recognize its pathname that it behaves like an agent or scheduler. That is clever and too implicit.

### 2.5 Two architectures coexist without an explicit rule

The doctrine says “events are the only writes.” The product simultaneously—and reasonably—contains imperative resources and protocol adapters:

- Project files are mutable R2 objects. [rpc-targets.ts:1874–1906](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:1874)
- AI, browser, images, and video bindings execute immediately.
- MCP and OpenAPI connections explicitly leave no events. [README.md:252–259](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/README.md:252)
- Dynamic-worker builds are direct RPC and explicitly leave no events. [README.md:274–293](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/README.md:274)
- The seeded stateful app demonstrates direct DO KV mutation. [config-repo-template/worker.ts:203–211](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/config-repo-template/worker.ts:203)
- Project live state includes a non-folded SQLite stream index and a directly mutated demo counter. [project-durable-object.ts:51–81](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/projects/project-durable-object.ts:51)

Most of these should not be forced into event payloads. The structural failure is the absence of a clear taxonomy:

- **Durable business truth:** must begin with an append.
- **Derived index/cache:** direct storage is allowed only if disposable or reconstructable.
- **Bulk resource:** bytes live outside streams; streams carry immutable references and lifecycle facts.
- **External effect:** append an intent, execute idempotently, append a receipt when reliability matters.
- **Transient protocol traffic:** HTTP streaming, WebSockets, model-token chunks may stay outside durable processing.

Without that rule, every new module argues about “everything is a stream” from scratch.

## 3. Reaction to the founder’s big ideas

### 3(a). “The only interaction is appending events”

**As a kernel law: correct. As a literal public interface: wrong.**

The coordination kernel is close. Append is synchronous and await-free through validation, reduction, and persistence; delivery happens post-commit. [stream-durable-object.ts:204–321](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-durable-object.ts:204) Stream configuration is itself events, processors fold journals, and Slack ingress preserves raw webhook facts.

My score:

- Durable coordination domains: **7/10 append-driven**
- Whole public ITX surface: **3/10**
- User-hosted stateful applications: **1/10**, because the provided example teaches direct KV mutation

The literal claim is also contradicted by project creation: auth registration and directory priming happen before the project-root append. [rpc-targets.ts:3624–3656](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:3624)

The law should be:

> Every change to durable project truth, and every asynchronous effect that must survive failure, starts with an append.

That leaves room for reads, direct pure computations, cache writes, byte transport, and best-effort effects.

**HTTP-to-worker should remain outside streams.** HTTP and WebSockets have protocol semantics—streaming bodies, backpressure, upgrade responses, cancellation—that an event journal should not imitate. The seeded worker correctly explains that WebSocket upgrades require a real `fetch` lane and cannot traverse an ordinary RPC method. [config-repo-template/AGENTS.md:39–58](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/config-repo-template/AGENTS.md:39)

The correct relationship is:

- HTTP is an ingress/egress adapter.
- A mutating request appends a domain command/fact or returns `202` after doing so.
- A pure GET, static response, streaming response, or WebSocket packet need not become an event.
- Raw request bodies too large for the journal go into blob storage; the event contains the reference.
- Signed third-party ingress should append the preserved vendor event, as Slack already does. [README.md:151–155](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/README.md:151)

Do not turn the stream into a fake HTTP transport. That would make both abstractions worse.

### 3(b). Third-party-hosted stream processors and coding agents

This is possible, but the existing webhook mode is not yet a stateful remote-processor protocol. Webhooks have stream-owned cursors and per-event 2xx acknowledgement; wake-mode processors keep the checkpoint beside the state it must agree with. [streams/README.md:98–118](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/README.md:98)

I would add a first-class `remote-processor` delivery mode:

1. A durable attachment event declares processor identity, endpoint, contract/version hash, selector, state schema, and scoped authority grant.

2. OS delivers the existing batch envelope—already carrying `deliveryId`, attempt, offsets, and the configuring event. [rpc-types.ts:119–152](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/rpc-types.ts:119)

3. The remote host returns a declarative commit:

   ```ts
   {
     expectedCheckpoint: 140,
     nextCheckpoint: 145,
     state: { blobRef, hash, schemaVersion },
     appends: [...],
     effectIntents: [...],
     nextWakeAt?: "..."
   }
   ```

4. OS validates the processor version and fencing token, then atomically records the remote state/checkpoint and home-stream output intents.

5. Cross-stream outputs are not committed directly. They become durable outbox facts on the home stream and are delivered to target streams. The current per-stream DO layout cannot atomically update arbitrary target streams.

6. External effects execute through scoped capability grants with idempotency keys derived from processor identity, input offset, and effect index. Their receipts come back as events.

7. A lease/fencing generation prevents two remote hosts from advancing the same processor. Redelivery uses the stable `deliveryId`.

For coding agents, the authoritative state should remain the stream transcript plus an OS-owned checkpoint/snapshot. A third-party model session may be an optimization, never the sole durable memory. That makes Claude, Codex, Pi, or OpenCode replaceable hosts for the same processor identity.

What this breaks or exposes:

- The current wake handshake returns a live sink and a checkpoint from a same-platform DO host. [rpc-types.ts:199–236](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/rpc-types.ts:199)
- Live Cap’n Web object capabilities can be proxied over a session, but they cannot be persisted as replayable processor state. A reconnectable name or scoped token must replace them.
- There is no cross-stream atomic commit.
- LLM and coding-agent execution is nondeterministic; replay can reproduce facts, not identical computation.
- Long-running turns require leases, cancellation, progress events, billing limits, and result-size limits.
- Sending a full project-root capability to a third party is an authority disaster. Grants must be narrow, expiring, auditable, and revocable.

So: **build a remote processor protocol, not “webhook plus vibes.”** This is one of the founder’s best ideas, but it requires a real transaction and authority model.

### 3(c). Is a domain entity `DO class × stream path`?

**No. That is a runtime facet address, not a domain identity.**

The same encoded `{projectId, path}` is used in distinct DO namespaces for Stream, Agent, CapabilityHost, Project, Repo, Secret, Scheduler, Workspace, and stateful Worker. [generate-wrangler-config.ts:164–180](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/scripts/generate-wrangler-config.ts:164) The codec itself carries project, path, and optional properties—but not entity kind or DO class. [durable-object-names.ts:25–71](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/durable-object-names.ts:25)

The domain identity should be:

```text
EntityId = { projectId, path, kind }
```

The runtime identity is:

```text
FacetId = { DO namespace/class, encoded projectId+path }
```

BEAM would say a logical entity may be implemented by a supervised group of processes, but those processes have distinct mailboxes and identities. Orleans explicitly includes grain type in grain identity; two grain types with the same key are separate grains. Both would distinguish the domain entity from its hosting process.

Multiple DO classes sharing the same encoded name is:

- **Good** when they are explicit facets of one entity, share one authoritative stream, and can be discarded/rebuilt independently.
- **Bad** when each facet can appear merely by being touched, with its relationship inferred from pathname conventions and eventual subscription reactions.

The current Agent DO and CapabilityHost DO are reasonable facets: each hosts processors over the same path stream. [agent-durable-object.ts:28–43](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-durable-object.ts:28) [capability-host-durable-object.ts:34–57](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/capability-host/capability-host-durable-object.ts:34) What is missing is an authoritative declaration that the path is an `agent` and those facets are legal for it.

Only the Stream namespace should own existence. Other DOs should be disposable hosts that refuse to operate until the stream’s birth event declares the compatible kind.

### 3(d). A uniform birth ceremony

Current births are too implicit because generic stream creation, parent announcement, mechanics, policy, external resource creation, and readiness occur in different places.

Use one ceremony:

```ts
await itx.streams.birth({
  path: "/agents/researcher",
  event: {
    type: "events.iterate.com/agent/created",
    entity: {
      kind: "agent",
      schemaVersion: 1,
      parent: "/agents",
    },
    payload: { ... }
  }
})
```

The rules:

1. Reading or addressing an absent path does not create it.

2. The first append to an absent stream must be a birth event carrying a standard `entity` envelope. Any other first event is rejected.

3. The first event remains domain-specific—`agent/created`, `repo/created`, `scheduler/created`—so the domain reducer consumes its own birth certificate. Do not insert generic `stream/created` ahead of it.

4. Birth is compare-and-set against an empty journal. Retrying the identical birth returns the existing event; a conflicting kind or payload fails loudly.

5. The kernel durably announces `entity-born` to ancestors through a retryable outbox. The current implementation retries announcements on every wake, which heals losses, but it is still asynchronous background choreography. [stream-durable-object.ts:761–773](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-durable-object.ts:761)

6. The birth kind selects allowed processor facets. Policy then appends mechanics and defaults with deterministic keys.

7. The entity has an explicit lifecycle: `born → configuring → ready` or `failed`. Returning a handle need not wait for readiness, but readiness must not be inferred from “enough eventual events probably landed.”

8. Collection `create()` methods are typed sugar over this one operation.

For projects, make the root-stream birth authoritative and turn auth-directory registration into a reconciled projection. Today auth registration is the real first birth and the stream comes second; that permanently prevents a uniform model.

### 3(e). Config-repo `worker.ts` overriding all defaults

**Brilliant as a constitution. Dumb as an interrupt hook invoked indiscriminately on every event.**

The current implementation is a promising partial version:

- Every project stream is born with a durable feed to the project worker. [streams/README.md:274–291](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/README.md:274)
- The seeded worker receives every committed non-ephemeral event. [config-repo-template/worker.ts:77–82](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/config-repo-template/worker.ts:77)
- Agent policy is exposed as data through `itx.agents.defaults.forPath`, then edited or appended by project code. [agent-defaults.ts:1–15](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-defaults.ts:1)

But “all defaults” is false today. Agent processor mechanics remain hard-coded in the platform based on path shape, while only policy is delegated to the project worker. [project-processor-implementation.ts:254–281](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/projects/project-processor-implementation.ts:254)

The literal proposal has serious problems:

- One user-code bug can poison a constitution reaction; the feed’s `onPoison: "skip"` eventually steps over it.
- Calling arbitrary project code for every event creates a project-wide hot path and backlog amplifier.
- Repo refs may be branch-late-bound, so backlogged historical events can be interpreted by newer config code unless decisions record their config version. [README.md:283–291](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/README.md:283)
- Calling defaults back through effectful ITX creates reentrancy and hides which platform-default version made the decision.
- “Override everything” would include security confinement, secret handling, append semantics, delivery guarantees, and quotas. That is unacceptable.

Push the constitution idea further, but reshape it:

```ts
export default defineProject({
  reactors: [
    on("events.iterate.com/agent/created", ({ event, defaults }) => ({
      append: defaults.agent(event, {
        model: "...",
        capabilities: [...]
      })
    }))
  ]
})
```

Requirements:

- Config exports selectors and declarative reactors; the runtime does not invoke it for irrelevant events.
- A reactor returns a `ReactionPlan`: appends, subscription changes, capability mounts, and effect intents.
- Every output is keyed by `{input stream, input offset, config commit, reactor id}`.
- The result records both config commit and platform-default version.
- Defaults are a pinned, pure plan generator passed into the reactor—not an effectful round trip through `itx`.
- Config activation is itself an event, so the version in force is explicit.
- An opt-in `observe("*")` feed can still power broad self-reflection without making universal execution the default.

Overrideable:

- Agent prompts/models
- Tool mounts
- Routing policy
- Processor selection
- Schedules
- App HTTP behavior
- Retention and product-level egress approval policy

Not overrideable:

- Authentication and project confinement
- Stream commit semantics
- Secret non-disclosure
- Delivery integrity
- Platform safety ceilings and quotas
- Capability-grant validation

Verdict: **keep the constitution; kill the magical every-event override callback.** The config repo should govern project policy, not replace the kernel.

## 4. My crazier idea: fork reality before self-improving

Make external side effects illegal for every ordinary processor.

Processors may emit only:

- New internal facts
- State projections
- **Effect intents**

A single privileged **Effect Court** is the only processor allowed to turn an effect intent into a real email, API call, purchase, deployment, or message. It appends the external receipt afterward.

Then make projects forkable into **worldlines**:

1. An agent proposes a config-repo commit.
2. The project forks at a causal cut.
3. Historical inputs and generated scenarios replay through the candidate config.
4. Effect intents are quarantined rather than executed.
5. Agents compare the candidate worldline with the current one: outcomes, cost, latency, safety, and user preference.
6. If it wins, the real project appends `policy-promoted` pointing at that repo commit.
7. Only the canonical worldline’s Effect Court can touch reality.

That turns “self-improvement” from “an agent edited its own `worker.ts`; good luck” into an empirical operation performed against the entity’s own life history.

It also makes third-party processors much safer: a remote coding agent can propose arbitrary effects without receiving authority to execute them.

Why it is beautiful:

- Simulation and production use the same processors.
- External effects have one auditable seam.
- Config changes can be evaluated before promotion.
- A family assistant can rehearse a calendar reorganization without sending invitations.
- A startup can replay a sales process under a proposed policy without emailing customers.
- Nondeterministic agents can be compared by outcomes rather than assumed correct.

Why it is insane:

- Current streams have independent offsets and cross-post copied events, not a project-wide causal snapshot. [streams/README.md:8–18](/Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/README.md:8)
- Time, randomness, external reads, and model calls must be captured or virtualized.
- Forked storage could explode.
- Simulated external responses need fixtures, models, or explicit uncertainty.
- “Merge” cannot mean importing fake external facts into reality; promotion changes future policy only.

A plausible first slice is much smaller: run a second, shadow project worker over the same durable event feed, quarantine its effect intents, and compare its decisions with production. That would begin turning the founder’s “intelligent entity that self-improves” from a metaphor into a testable systems property.

---

## Appendix C — Codex round 2: adjudications, unified design, first moves (verbatim)

# Iterate OS architecture review — Round 2

## 1. Adjudications

### A. Births: the scholar wins the ontology, but loses the implementation

I withdraw my Round-1 claim that `kind` belongs in entity identity.

The entity is the named journal:

```text
EntityId = { projectId, path }
```

`kind` should become an evolving set of activated contracts, not a third identity coordinate. An agent journal already needs the agent processor, capability host, and sometimes Slack, Telegram, email, or GitHub processors. Pretending that this is one immutable `kind: "agent"` hides the exact composition that matters. The current code makes that composition explicit—but infers it from paths in a central switch ([project-processor-implementation.ts:225](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/projects/project-processor-implementation.ts:225>), [project-processor-implementation.ts:344](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/projects/project-processor-implementation.ts:344>)).

The scholar is right about:

- Virtual existence: resolving `(projectId, path)` should require neither a registrar nor storage.
- “Message a nonexistent agent and it works” as the correct default.
- Domain creation sagas becoming provisioning obligations. `sandbox/create-requested → created` describes desired and actual external state; it should not define whether a journal is ontologically allowed to exist.
- Projects remaining special because tenancy, billing, confinement, and hostname ownership genuinely need a registrar.

But **do not universalize the present constructor literally**. It materializes on every fetch, RPC, or alarm, appends `stream/created`, installs a project-worker subscription, and appends `stream/woken` before the caller does anything ([stream-durable-object.ts:128](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-durable-object.ts:128>)). The repository itself admits the resulting problem: sandbox lookup must consult a catalogue because merely reading a nonexistent stream would create junk ([rpc-targets.ts:1239](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:1239>)).

“Every name exists virtually” does **not** imply “every read writes three rows.”

#### Recommended birth ceremony

1. `get(projectId, path)` returns a virtual handle and performs no write.
2. The first **append**, not touch/read, serializes through the journal owner.
3. The kernel resolves the first non-kernel event’s exact type against the project’s pinned contract registry.
4. In one atomic turn it appends:

   ```text
   stream/materialized
   contract/activated { contractRef, revision, activationProfileHash }
   <the caller's first domain event>
   ```

5. The activation profile declares the processor organs, subscriptions, placement, required capabilities, and obligation supervisors to arm.
6. Later events may activate additional compatible contracts on the same journal.
7. Vendor resources are created only by ordinary requested/completed/failed obligations.
8. GC may reclaim materialization-only journals. Once a journal has domain facts or external effects, deletion requires an explicit tombstone and retention policy—not “it looked like junk.”

The current invariant that `stream/created` must occupy offset 1 is perfectly reasonable as a **kernel materialization certificate** ([stream-durable-object.ts:511](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-durable-object.ts:511>)). My previous objection to a generic event preceding the domain birth was wrong. It becomes bad only when users mistake it for the domain’s semantic birth.

#### Why “kind derived from first event type” is still too simple

A type can select an initial contract, but it cannot select one scalar entity kind.

An initial `agents/message-received` should activate an agent profile. That profile must include at least the agent and capability-host processors, while routed paths may need another transcriber. Today that bundle is selected from path structure ([project-processor-implementation.ts:351](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/projects/project-processor-implementation.ts:351>)). Agent defaults then append events owned by multiple contracts—agent configuration, capability-host mounting, and model-visible input ([agent-defaults.ts:252](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-defaults.ts:252>)).

Therefore:

> The first event type selects an activation profile. It does not reveal an intrinsic kind.

#### What each original position breaks

My explicit-kind proposal broke:

- Zero-ceremony agent messaging.
- Multi-role journals.
- Incremental installation of new organs.
- Decentralized packages, because a central kind enum becomes the real ontology.
- Simultaneous first appends unless callers perform an awkward birth CAS.

The pure scholar proposal breaks:

- Addressing purity: reads become writes.
- Security: a typo or malicious append can implicitly install and execute third-party code.
- Garbage collection: today even a typo gets durable wake and ancestor-announcement facts.
- Replay: there is no pinned record of which contract interpretation materialized the entity.
- Multi-contract composition: “the first processor” is not enough.
- Effect safety: GC cannot undo a vendor call already caused by the journal.

Keep atomic first-append serialization, but move the invariant from “kind selects legal facets” to:

> The journal’s activated, content-addressed contract set selects its legal organs.

That also makes multiple DO classes sharing the same encoded name good rather than suspicious. The name already embeds tenancy ([durable-object-names.ts:1](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/durable-object-names.ts:1>)), and each façade asserts project access before minting an organ stub ([rpc-targets.ts:3131](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:3131>), [rpc-targets.ts:3931](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:3931>)). Separate organs are valuable for confinement and failure isolation. Implicit organ selection is the defect.

---

### B. Event type as owner: formalize exact ownership; reject DNS execution

The good idea is:

> Every durable event type has exactly one schema authority, home fold, and obligation definition.

That is nearly present already. `defineProcessorContract` declares owned event types, consumption, emission, and dependencies, and resolves an exact type string to its schema ([processor-contracts.ts:8](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/processor-contracts.ts:8>)). The problem is that uniqueness is checked only between a contract and its direct dependencies, not across an installed project registry ([processor-contracts.ts:640](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/processor-contracts.ts:640>)).

The dangerous idea is:

> The URI namespace itself resolves live through DNS to executable code.

That is a supply-chain vulnerability wearing an elegant URI.

#### Namespace is not contract identity

I count 88 declared event keys under 14 first-path namespaces in the processor contracts. Those namespaces do not map one-to-one to contracts:

- `AgentProcessorContract.slug` is `agent`, but it owns both `agent/*` and `agents/*` types ([agent-processor-contract.ts:301](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-processor-contract.ts:301>), [agent-processor-contract.ts:464](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-processor-contract.ts:464>)).
- Repo processing owns `repo/*` plus GitHub-related namespace entries.
- One journal can activate several owners.

Formalize ownership by exact type in an immutable manifest. Do not infer it by URI prefix.

```ts
type ContractManifest = {
  contractId: string;          // publisher-owned stable identifier
  revision: string;            // immutable content hash
  events: {
    [type: string]: {
      schemaRevision: string;
      obligation?: {
        key: string;
        terminalTypes: string[];
        expiry: string;
        retryPolicy: string;
      };
      activationProfile?: string;
    };
  };
  processors: ProcessorArtifact[];
  migrations: Upcaster[];
};
```

The existing announcement is insufficient: it carries slug, version, consumed/emitted strings, and event descriptions, but no artifact hash, schema revision, supervisor declaration, or durable owner identity ([core-processor-contract.ts:230](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/core-processor-contract.ts:230>)).

#### Supervision can be syntactic—but not from `-requested`

A naming suffix is lint, not supervision.

A contract may only declare `foo-requested` if it also declares:

- Obligation identity and deduplication key.
- The selected runner/reconciler.
- Terminal facts.
- Expiry.
- Retry and poison policy.
- What an “unknown outcome” means after a crash.
- Required capability grant.

Then contract installation can reject incomplete obligation families. That is genuinely powerful. Merely discovering a processor from a string ending in `requested` relocates choreography into spelling.

#### Multi-tenancy

Separate three things:

1. **Schema authority:** who owns the meaning of `events.codex.dev/session/turn-completed`.
2. **Installed interpretation:** which immutable contract revision this project accepts.
3. **Execution placement:** which local or remote processor implementation handles it for this project.

The URI can identify the first. The project’s package lock controls the second. A subscription/capability expression controls the third.

Do not bake a universal remote endpoint into the event namespace. Different projects will require different regions, credentials, vendors, versions, or self-hosted implementations. The schema publisher is not automatically entitled to receive every tenant’s events.

Most importantly, appending an event must never auto-install code from the internet. That is dependency confusion plus remote code execution. An uninstalled type should be rejected at normal append doors; archival imports can quarantine it as uninterpreted data.

#### Version evolution and immutable journals

Every committed event must record either:

```text
contractRef + schemaRevision
```

or an unambiguous project-registry activation offset from which those are derived.

Current processor-originated events can stamp a processor slug and version, but the code explicitly calls that stamp a claim rather than authentication ([schemas.ts:13](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/schemas.ts:13>)). Other append lanes need not carry even that.

Rules:

- Never change a schema artifact at an existing revision.
- Additive evolution may preserve the logical type while events retain their original schema revision.
- Breaking semantic changes should use a new major type or an explicit upcaster chain.
- Retain old processor artifacts or deterministic upcasters for replay.
- Upgrades are durable `contract/activated` events, not “DNS returned something newer today.”

The loose outer envelope protects retired metadata fields ([schemas.ts:8](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/schemas.ts:8>)), but payload replay still uses the currently installed Zod schema. A consumed event that no longer parses is skipped as a durable parse failure rather than folded ([stream-processor.ts:465](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-processor.ts:465>)). That avoids wedging, but silently changing years of state is not an upgrade strategy.

#### DNS verdict

Use DNS/HTTPS only to discover a signed manifest. Fetch it once, verify the publisher key, pin its content hash, journal installation, and replay solely from retained artifacts.

Live DNS resolution fails on:

- Domain expiry and takeover.
- Mutable records.
- Outages during replay.
- Tenant-specific hosting.
- Version pinning.
- Endpoint compromise.
- SSRF and arbitrary code discovery.
- Revocation ambiguity.

Does type ownership fix “identity by choreography”? Only if exact event ownership resolves through a pinned manifest to an activation profile. Replacing:

```ts
if (path.startsWith("/agents/"))
```

with:

```ts
if (type.startsWith("events.iterate.com/agents/"))
```

is not architecture. It is the same switch wearing a URI.

---

### C. ITX expressions: excellent intermediate representation, terrible naked grant

The proxy syntax is good. The universal claim needs to be cut in half.

Today an expression is explicitly documented as a persisted **name**, never authority; evaluation re-derives authority from its root ([expression.ts:1](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx/expression.ts:1>)). Preserve that distinction.

There are four separate objects:

1. **Expression:** a serializable name/quoted call.
2. **Grant:** authorization to evaluate an expression under constraints.
3. **Invocation:** expression plus caller-supplied arguments and causation.
4. **Live capability:** an incarnation-bound Cap’n Web stub, stream, callback, or socket.

Conflating them will create security bugs.

#### Bind-by-deep-merge is not attenuation

This is unsafe:

```ts
bound = { channel: "#general" }
caller = { channel: "#finance", text: "..." }
effective = deepMerge(bound, caller)
```

Whichever side wins, the semantics are surprising. Nested objects, arrays, aliases, and unknown fields make it worse.

`bind()` should be authoring sugar for evaluator-enforced constraints:

```ts
type Constraint = {
  arg: number;
  pointer: string; // canonical JSON Pointer
  relation: "equals";
  value: JsonValue;
};

type Grant = {
  id: string;
  expression: ExpressionV1;
  constraints: Constraint[];
  scope: string;
  issuer: string;
  expiresAt?: string;
  revocationEpoch: number;
};
```

Rules:

- A bound property is inserted only if absent.
- Supplying that property again is rejected—even if equal. No ambiguity.
- Arrays are atomic; no recursive array merge.
- Only explicitly declared argument positions support property binding.
- Positional and object binding have different syntax: `bindArg(0, x)` versus `bindProps(0, {channel: id})`.
- Bind against canonical identifiers. `#general` is mutable human spelling; Slack channel ID is the authority-relevant value.
- The method schema must be strict enough to prevent alternate spellings such as `raw.channel`, `conversation`, or a generic request body.
- Constraint checking is necessary but not sufficient: the method contract must assert that the constrained field actually governs the effect.

A copied expression is not revocable. Once expressions become journalable and shareable, the current assumption that “the store is the only holder” stops being true ([expression.ts:5](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx/expression.ts:5>)). Revocation must check a grant ID or epoch at every evaluation.

#### Minimal algebra

Keep it painfully small:

```ts
type ExpressionV1 = {
  v: 1;
  steps: (
    | { op: "get"; key: string }
    | { op: "call"; method: string; args: JsonValue[] }
  )[];
};
```

That is enough because calls can return objects on which later steps continue.

Do **not** add:

- General composition.
- Branching.
- Loops.
- Result placeholders piping arbitrary output into later calls.
- Lambdas or closure capture.
- `eval`.
- Implicit ambient roots.

If a workflow needs control flow, it is a script or processor. Expressions remain inspectable names and invocations.

The current grammar is almost this simple, but its arguments are `unknown`, not JSON, and validation checks only array/string shape ([expression.ts:19](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx/expression.ts:19>), [expression.ts:133](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx/expression.ts:133>)). Fix that before promoting it to durable universal IR.

`q(itx => …)` is fine if the proxy:

- Allows only straight-line property reads and calls.
- Requires captured arguments to pass JSON validation.
- Rejects `await`, coercion, enumeration, branching on proxy values, and destructuring.
- Produces one canonical tagged encoding.

#### Expressions are not “everything in the durable log”

Facts are not calls.

`agent/output-added`, `repo/commit-landed`, and `email/sent` should remain typed facts. An obligation may contain an expression naming the requested effect. Its result becomes another fact.

If every durable row is an invocation expression, the event-type ownership scheme from B immediately collapses. You have recreated RPC recordings instead of a domain history.

#### Cap’n Web remains distinct

The same evaluator already walks local objects and live RPC stubs ([expression.ts:48](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx/expression.ts:48>)), and durable delivery evaluates expressions against freshly scoped authority roots ([subscriber-sinks.ts:308](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/subscriber-sinks.ts:308>)). That is the right adapter.

But live stubs cannot all be serialized. The public contract already distinguishes `type: "live"` mounts from `type: "itx-expression"` mounts ([itx-api.generated.ts:1596](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/itx-api.generated.ts:1596>)). Preserve it. Streaming responses and WebSockets specifically require real fetch hops rather than RPC copies ([sdk.ts:31](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/packages/iterate/src/sdk.ts:31>)).

Cap’n Web can compile nameable eager calls through expression IR. It should not pretend callbacks, streams, pipelined ephemeral stubs, and sockets are durable data.

#### Secrets

A secret placeholder should not be a general expression that returns secret material. It should be an opaque substitution token recognized only by the kernel egress evaluator. The existing secret invariant is excellent: material goes in, and nothing leaves except a request to a pinned host ([secret-durable-object.ts:29](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/secrets/secret-durable-object.ts:29>)). Do not weaken that to make the algebra prettier.

---

### D. Everything in userspace: correct destination, incomplete kernel

The principle is right. The proposed kernel table is not yet sufficient to make it true.

Moving directories or wrapping built-ins as npm packages is not userspace. A package is genuinely userspace only if a third party can implement it using the same stable interfaces, supervision, confinement, and lifecycle available to Iterate.

#### What belongs in the kernel

- Project identity, authentication, tenancy, and confinement.
- Atomic named journals: append, CAS/idempotency, retention, snapshots, indexing, and causal provenance.
- Content-addressed blob storage and immutable blob pointers.
- Project-pinned package/contract registry.
- Artifact verification, loading, retention, rollback, and reproducible build identity.
- A generic processor host:
  - Fold checkpoints.
  - Durable delivery.
  - Timers/alarms.
  - Crash revival.
  - Reconciliation.
  - Obligation attempts and terminal outcomes.
  - Placement and resource limits.
- Capability tree, grants, attenuation constraints, revocation, and expression evaluation.
- Trusted ingress/egress doors.
- Secret cells and substitution.
- Generic OAuth callback/state machinery; provider adapters remain packages.
- Quotas, billing, metering, abuse control, observability, and recovery administration.

The current processor host shows why alarm/revival belongs here: an alarm is the only mechanism that revives a quiet processor which died owing work ([stream-processor-host.ts:21](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-processor-host.ts:21>)). Requiring each stranger’s package to reimplement that correctly destroys the claimed abstraction.

The kernel needs to be a few **deep modules** with narrow interfaces, not a collection of thin wrappers around every product domain.

#### What should be packages

- Agents and model-loop policy.
- Slack, Telegram, email, GitHub channel processors.
- Task systems.
- Schedulers above a kernel timer primitive.
- Repo providers and GitHub mirroring.
- Browser/coding-agent remote processors.
- MCP/OpenAPI adapters.
- Project dashboards and domain mini-apps.
- Default prompts, mounts, event reactions, and processor selections.

There are two exceptions:

- The kernel must retain a non-configurable recovery console for auth, billing, raw journal inspection, package grants, and rolling back a broken project image.
- “Repo” splits in two: a content-addressed genome/artifact input belongs to the kernel; Git, branches, commits, and GitHub are replaceable package implementations.

Calling the config worker for every non-ephemeral event is the wrong userspace mechanism. The SDK currently advertises project-wide delivery and tells authors to write one `if` per reaction ([sdk.ts:88](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/packages/iterate/src/sdk.ts:88>)); the template uses that to detect child streams and append agent defaults ([worker.ts:77](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/config-repo-template/worker.ts:77>)). That is a useful escape hatch, not a constitution.

A configuration repository should select and parameterize packages, grants, activation profiles, and subscriptions. Package-specific processors should receive relevant events. Do not impose a universal user-code interrupt on the hot path of every durable fact.

#### Missing package primitives

For “any SaaS as npm package” to be real, the platform needs:

- Signed package identity and publisher keys.
- `package/install-requested`, `installed`, `upgrade-proposed`, `activated`, `rolled-back`, and `disabled` facts.
- An immutable dependency lock, artifact digest, contract revisions, and SBOM.
- Namespace collision checks for event types, capability paths, durable keys, routes, and mini-app names.
- Declared processor placement and partitioning.
- Declared capabilities and egress effects.
- Auto-generated grant/consent UX a human can understand before installing a stranger’s package.
- Grant expiry and revocation independent of package code.
- Package crash-loop quarantine.
- Projection/query state for packages that cannot efficiently answer from a raw journal on every request.
- Data export and uninstall semantics.
- Paid-package identity, entitlements, metering, refunds, and publisher payout.
- A rule for what happens when a paid package or publisher disappears.

npm alone provides none of this. It is a transport for tarballs, not a trustworthy application marketplace.

#### The version-skew disaster is real

Repo-backed worker references are intentionally late-bound, so the next call may load newly changed source into the same durable identity ([stateful-worker-durable-object.ts:117](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/stateful-worker-durable-object.ts:117>)). The build key pins the source snapshot and toolchain inputs ([build-key.ts:18](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/build-key.ts:18>)), but package dependencies may be installed from npm at build time ([schemas.ts:62](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/schemas.ts:62>)). Unless a resolved lock participates in the input, identical source with semver ranges can produce different bytes after cache loss under the same nominal build key.

For journal replay:

- Every processor emission should record its exact artifact/image and contract revision.
- Upgrade must append an activation event.
- Old artifacts or deterministic upcasters must remain available.
- Shadow replay should validate the proposed image before promotion.
- A current package must never silently reinterpret years-old events merely because npm delivered a newer version.

#### Can agents actually become a package?

Not today.

The agent directory is 6,756 TypeScript/TSX lines including tests, but line count is not the blocker. The public SDK exposes at-least-once `processEvent` callbacks and flattened capability calls ([sdk.ts:88](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/packages/iterate/src/sdk.ts:88>)). It does not expose:

- Processor checkpoints.
- Pure reducers and folded snapshots.
- Reconcile-at-head semantics.
- Keepalive obligations.
- Crash revival.
- Alarm coordination.
- Processor source provenance.
- Safe platform effect dependencies.

The platform-side `AgentDurableObject` constructs the private processor host, injects `env.AI`, reveals configured OpenAI material inside trusted code, and writes oversized results to a workspace DO ([agent-durable-object.ts:28](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-durable-object.ts:28>)). It also cohosts several channel processors ([agent-durable-object.ts:76](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-durable-object.ts:76>)).

The agent domain survives demotion only after the kernel owns a generic outer processor host and calls package hooks such as:

```text
reduce(state, event) -> state
plan(state) -> obligations
render(snapshot) -> public view
```

The LLM call, workspace write, and channel sends must arrive as scoped effect capabilities, not private environment bindings.

Extract scheduler or email first. Extract agent last as the acceptance test.

#### Secrets: event-sourced does not mean userspace-safe

The maximalist is correct that encrypted secret material already lives in `secret/updated` events ([secret-processor-contract.ts:32](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/secrets/secret-processor-contract.ts:32>), [secret-durable-object.ts:100](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/secrets/secret-durable-object.ts:100>)).

“The hard case dissolves” is still wrong.

Event sourcing solves persistence and audit. It does not solve key custody, decryption authority, host pinning, refresh credentials, export/rewrap, or preventing package code from reading plaintext. Secret policy and provider-specific refresh strategies can be packages. The decrypt-and-substitute door remains kernel TCB.

---

### E. Other reviewers

#### E1. “The entity is the named journal; DO classes are organs”

Endorse, with one correction:

> The entity is the named journal plus its pinned contract interpretations.

A journal of bytes without the schemas, processor artifacts, grants, and blob references needed to interpret it is not yet a portable entity.

This differs materially from my Round-1 `{projectId, path, kind}`. I now reject `kind` as identity. Contracts can activate and retire over time while the entity’s name remains stable.

Orleans would approve virtual identity and lazy activation, but normally treats grain type plus key as identity. Iterate is doing something more flexible: one logical journal can activate several typed organs. BEAM would distinguish the durable registered name from incarnation PIDs and would insist that supervision be explicit. It would hate the present hidden supervisor tree encoded in path-prefix branches.

Multiple DO namespaces carrying the same encoded name are good when they are declared organs with separate confinement or failure needs. They are bad when each quietly becomes an authoritative partial entity and their roster is inferred by string choreography.

#### E2. The maximalist audit

**Secrets already event-sourced:** agree on persistence; refute “hard case dissolved” for the reasons above.

**Missing facts:** strongly agree.

- Repo writes push commits and update a private KV head but append no `repo/commit-landed` fact ([repo-durable-object.ts:297](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/repos/repo-durable-object.ts:297>)).
- Files are mutable R2 paths with no versioning, listing, or quotas; `put` and `delete` directly mutate the bucket ([project-files.ts:23](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/files/project-files.ts:23>), [project-files.ts:68](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/files/project-files.ts:68>)).
- Worker build failures propagate as call errors and are not durable facts ([worker-loader.ts:163](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/worker-loader.ts:163>)).

Add:

```text
repo/commit-requested → commit-landed | commit-failed
file/put-requested → pointer-landed | put-failed
worker/build-requested → build-succeeded | build-failed
```

Blob bytes stay outside the journal; content hashes and immutable pointers go in it.

**Email as obligation:** emphatically agree. Current code sends first and only afterward tries to append `email/sent`, eventually degrading to a console error ([rpc-targets.ts:2936](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:2936>)). That is an unavoidable crash gap. Use requested/attempted/sent/failed-or-unknown. Do not promise exactly-once unless the provider accepts an idempotency key.

**AI/browser/parallel/MCP/OpenAPI as mounts:** broadly agree. They are packages/adapters exposed through capabilities. The trusted egress, resource accounting, and secret substitution underneath remain kernel.

**8–12k lines leave core:** plausible, but irrelevant as a success metric. Moving 12k lines into privileged “packages” that depend on private bindings changes filenames, not architecture. The win is third-party implementability against a narrow public processor interface.

#### E3. Crazy corner

**“The Last RPC” — kill the literal proposal; keep the compiler.**

A mutating durable call should often compile to an append. But retention is not the only difference between RPC and workflow:

- Ephemeral rows are excluded from durable subscription delivery and may be evicted ([schemas.ts:58](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/schemas.ts:58>)).
- Calls need reply routing, cancellation, timeout, flow control, authority, and sometimes live object identity.
- Reads should not become events.
- HTTP streaming and WebSockets cannot cross ordinary RPC serialization ([sdk.ts:31](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/packages/iterate/src/sdk.ts:31>)).

Keep Cap’n Web as the live transport. Compile durable commands to intent events when durability matters. A journaled invocation is an obligation, not “RPC with a retention bit.”

**“The entity is a file.” — sharpen.**

A portable project export should be:

```text
repo/genome snapshot
+ journals
+ blob manifest
+ package/contract lock
+ processor artifacts or resolvable hashes
+ grants
+ effect ledger
+ encrypted secret envelopes
```

It cannot contain Stripe, Slack, DNS, or sent emails. Those are external commitments represented by receipts.

Stamp events with both:

- `observedUnder: projectImageHash`
- `producedBy: processorArtifactHash`, when applicable.

Do not pretend raw ingress was produced by the config commit merely because that commit was active.

**Shadow folds/worldlines:** strongly endorse. This is the same family as my Effect Court. A proposed package/config image should replay against a fork, emit effect intents into a fake egress court, compare state and intent traces, then be promoted explicitly. It becomes trustworthy only after all real effects pass through the obligation/egress seam; current direct repo, file, and email mutations would escape the shadow.

**Dashboard in config repo:** domain dashboards and mini-apps, yes. Kernel recovery UI, no. A broken configuration must not be able to delete the interface used to roll itself back, inspect its journal, revoke a malicious package, or pay the bill.

**LLM as stochastic reducer:** kill that terminology. Reducers must be deterministic. An LLM is a stochastic transition oracle:

```text
request fact → supervised external inference → response fact → deterministic fold
```

Personality as a fold of lived history is excellent. “Compaction is sleep” is beautiful, provided compaction appends a summary with covered offsets, model/prompt/artifact identity, and never silently rewrites the past.

---

## 2. Revised unified design — the wall version

```text
 CONFIG REPO + PACKAGE LOCK
           │
           │ build, verify, link
           ▼
   PROJECT IMAGE <hash>
 contracts · activation profiles · processor artifacts
 capability grants · subscriptions · routes · UI packages
           │
           │ project/image-activated
           ▼

HTTP / timers / vendors ──► INGRESS DOOR ──► APPEND
                                               │
                                               ▼
                                  NAMED JOURNAL (projectId, path)
                                  = the durable entity
                                               │
                           exact event type + pinned contract revision
                                               │
                                               ▼
                                      PROCESSOR HOST
                            pure fold · checkpoint · alarm · replay
                                               │
                         append fact ◄──────────┴──────────► obligation
                                                                  │
                                                expression + grant id
                                                                  ▼
                                              CAPABILITY EVALUATOR
                                          constraints · revocation · scope
                                                                  │
                                                secret substitution / egress
                                                                  ▼
                                                        EXTERNAL WORLD
```

The five concepts remain, revised:

1. **Project** — tenancy and confinement plus one activated, content-addressed project image.
2. **Stream/journal** — the named entity and sole durable fact history.
3. **Processor** — a pinned fold plus supervised obligations; local or remote is placement.
4. **Capability** — a scoped nameable action. Expressions name calls; grants authorize constrained evaluation.
5. **Repo** — the organism’s editable genome, compiled into immutable project images.

The kernel owns identity, journals, contract/package linking, processor supervision, grants, ingress/egress, secrets, blobs, builds, quotas, billing, and recovery. Everything domain-shaped is a package.

The first domain append materializes a journal and activates its manifest-selected processor profile. Event types name exact owners; subscriptions name consumers. Remote hosting is an implementation choice, never implied by DNS. Every event is interpreted under a pinned project image. Every external effect is a supervised obligation evaluated through a scoped capability grant.

The config repo remains the universal override point by selecting and parameterizing the image. It does **not** execute an arbitrary worker hook on every event.

---

## 3. Three highest-leverage first moves

### 1. Introduce `ContractManifestV1` and a project-pinned event-owner registry

Start authoring-time, then make it runtime-significant.

- Extend `defineProcessorContract` with immutable `contractId`, semantic revision, owned exact event types, activation profile, artifact identity, and obligation declarations.
- Generate one built-in ownership registry and fail CI on global collisions.
- Reject `*-requested` events whose owner lacks a complete obligation definition.
- Add `contract/activated` facts and stamp appended events with the resolved contract revision.
- Treat DNS as manifest discovery only.
- Replace path-prefix activation for one simple domain—scheduler or secret—with exact type-to-profile activation.
- Change virtual resolution so reads do not materialize; first domain append atomically emits materialization, activation, and caller event.

Do not begin with agents. Their multi-organ activation is the test that the manifest is expressive enough, not a convenient first migration.

### 2. Ship `ExpressionV1` plus a real grant format

- Replace nested untagged arrays internally with a versioned, JSON-only AST.
- Preserve a legacy decoder for existing journaled expressions.
- Add `q()` proxy recording in `iterate/sdk`.
- Make `.bindArg` and `.bindProps` compile to evaluator constraints, never deep merge.
- Add durable grant identity, scope, expiry, and revocation epoch.
- Migrate mounts and stream deliveries to `ExpressionV1`.
- Keep live Cap’n Web mounts as a separate variant.
- Restrict secret placeholders to the egress evaluator.
- Make one end-to-end obligation—email send—the proving case.

This creates the analyzable effect language required by remote processors, package consent, shadow evaluation, and durable workflows.

### 3. Build the generic userspace processor host and extract real domains

This is the epic.

- Publish a package processor interface around `reduce`, snapshot, reconcile/plan, and declared obligations.
- Keep checkpoint storage, delivery, alarms, crash revival, resource accounting, and grant evaluation in the kernel host.
- Add signed package installation/upgrade/rollback events and immutable dependency locks.
- Make resolved package dependencies part of build identity.
- First extract scheduler.
- Then extract email and close the send crash gap.
- Then extract one integration.
- Extract agent last, replacing private `env.AI` and workspace dependencies with granted effect expressions.
- In parallel, add missing repo, file-pointer, and build outcome facts so package/worldline replay sees the actual system.

The acceptance test is severe and simple:

> A third party, using only `iterate/sdk`, can publish a stateful processor with crash-safe obligations that is operationally indistinguishable from an Iterate-built processor.

Until that passes, “everything in userspace” is branding.

---

## 4. One more crazy idea: the organism linker

Stop treating `worker.ts` as the constitution. Treat it as a **linker script**.

The config repo plus installed packages compile into one content-addressed **Organism Image** containing:

- Exact event-owner table.
- Contract and schema revisions.
- Processor artifacts and activation profiles.
- Subscription graph.
- Capability grants and attenuation constraints.
- Egress requirements.
- Secret references.
- Timer declarations.
- Routes and UI mini-apps.
- Package entitlement proofs.
- Migration/upcaster graph.

Linking fails before execution on namespace collisions, missing supervisors, unresolved package versions, invalid grant requirements, cyclic activation, or an effect lacking an egress capability.

Activation is one event:

```text
project/image-activated { previousHash, imageHash }
```

Every subsequent event records the image under which it was observed and the artifact that produced it. Old images remain replayable forever.

Self-improvement then has a clean physical meaning:

1. The entity edits its genome.
2. The linker builds a candidate organism.
3. A shadow worldline replays history under it.
4. The Effect Court compares state and proposed external commitments.
5. The entity or owner promotes the new image.
6. One append changes the living organism.

This goes further than “config code runs on every event.” Configuration becomes a statically inspectable authority and supervision graph, while Turing-complete scripts remain available behind declared seams.

The insane part is also the payoff: the platform could answer, before installing an npm package, **every event type it can own, every processor it can activate, every secret it may reference, and every external effect it can possibly request**. That is a far more credible basis for simulating autonomous companies and families than asking users to trust another arbitrary `worker.ts`.

---

## Appendix D — Codex round 3: the fleet is the architecture (verbatim)

# Iterate OS simplification — Round 3: the fleet is the architecture

The emerging consensus is too enamoured with conceptual purity. At one project, “everything is an installable stream processor” is beautiful. At one million projects, it can become a distributed dependency graph, schema archive, permission ceremony, build fleet, and support organization.

My largest Round-2 correction is this:

> “Third parties can implement it through a stable interface” is an excellent depth test. “Therefore every default should be installed as a package in every project” does not follow.

## A. The fleet update problem

### First: A–D are not actually four alternatives

They answer three different questions:

1. **Code ownership:** platform source, package source, or project source?
2. **Version selection:** global deployment, channel, immutable lock, or repo commit?
3. **Execution placement:** platform Worker, dynamic loader, remote processor, or Workers for Platforms user Worker?

Option D is primarily execution placement. It is not a version-selection strategy and does not solve schema evolution. The repository already reaches this conclusion: source address, runtime materialization, and invocation are explicitly independent dimensions ([itx-later.md:112](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/docs/itx-later.md:112>)).

The fleet decision is therefore not “pick A, B, C, or D.” It is “which combination applies to each depth layer?”

### A. Platform-side behavior; repos contain only overrides

This is the unglamorous option, and it scales best.

The present OS is the extreme version: one deployed Worker contains the dashboard, request router, and every Durable Object class ([worker.ts:1](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/worker.ts:1>), [worker.ts:47](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/worker.ts:47>)). One platform deployment changes behavior for every project without touching any repo.

#### At one million projects

The update cost is essentially O(1) deployment work plus O(active entities) lazy activation. That is the only option with no fleet fan-out.

The cost is blast radius:

- A bad deployment can break one million projects simultaneously.
- A project cannot retain an old implementation unless the platform explicitly supports cohort routing or compatibility modes.
- Platform code accumulates compatibility branches.
- A monolithic script makes unrelated modules share deployment and cold-start fate.

That last problem is not inherent to platform ownership. First-party domains can remain platform-operated while living in separate deep modules or Workers. Option A does not require continuing the current “whole product in one script” implementation.

#### Eighteen-month-old event schemas

Central ownership does not eliminate version skew. It concentrates responsibility for it.

The platform must retain old parsers or upcasters for as long as old journal rows exist. Current replay resolves an event type through the currently running processor contract and returns a parse failure if the old payload no longer satisfies today’s schema ([stream-processor.ts:465](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/stream-processor.ts:465>)). That is not a migration system.

Option A therefore needs:

- Immutable schema revisions.
- Durable recording of which revision interpreted each event.
- Pure upcasters.
- Old projection rebuild support.
- A compatibility policy measured in years, not releases.

The platform never gets permission to reinterpret immutable history merely because its code is centralized.

#### Security patches

This is the strongest case for A. A vulnerable implementation can be replaced once, immediately. More importantly, the platform can close the exploit at the confinement, loader, grant-evaluation, or egress door even if domain code has not changed.

That is much stronger than committing a patch into one million Git repositories and hoping the patched branch is the one actually running.

#### Cold starts and builds

No project-specific build is required for defaults. The trade-off is platform bundle size and isolate startup cost. Fix that with module depth and deployment locality, not by copying the code into projects.

#### Verdict

Use A for everything that must be patched globally, defines platform guarantees, or cannot tolerate an 18-month-old implementation:

- Auth and tenancy.
- Journal semantics.
- Processor checkpoints, revival, alarms, and obligation supervision.
- Capability and grant evaluation.
- Secret substitution and egress confinement.
- Package verification and loading.
- Billing, quotas, abuse controls, and recovery.
- A small number of strategically central first-party domains until they have genuinely stable replacement interfaces.

### B. Vendor real code into every project repo

This is the worst fleet default.

It buys visibility, forkability, and code locality. It also turns every Iterate release into a million-way distributed merge.

#### At one million projects

One weekly update means 52 million repo mutations per year.

Even absurdly good automation produces an operational tail:

- 99.9% successful rollout: 1,000 failures per release.
- 99.99%: 100 failures.
- 99.999%: 10 failures.
- If only 1% of projects customize overlapping code, that is 10,000 semantic merges per update.

Current repo writes are not cheap metadata changes. The repo Durable Object serializes a clone/commit/push operation and records the new head afterward ([repo-durable-object.ts:283](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/repos/repo-durable-object.ts:283>), [repo-durable-object.ts:297](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/repos/repo-durable-object.ts:297>)). Doing that one million times is a release system, not a Git trick.

A dedicated upstream branch avoids merge conflicts only until user code depends on an old interface or overrides the same behavior. Then the merge is semantically broken despite being textually clean.

#### Builds are better than repo updates—but still not good enough

The current build system correctly deduplicates identical seeded repos by content hash, so one million untouched templates can share one artifact ([build-key.ts:18](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/build-key.ts:18>)). Storage and bundler work are therefore not automatically one million times worse.

Divergence destroys this leverage.

At a hypothetical five-second build:

- 10,000 unique variants cost 13.9 aggregate builder-hours.
- One million unique variants cost 57.9 aggregate builder-days.

Current artifacts expire after 30 days. Worse, the code explicitly admits that rebuilding the same key can resolve newer npm dependency versions, so “reproducible” is only approximate ([artifact-store.ts:13](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/artifact-store.ts:13>)). That is fatal for durable replay.

#### Eighteen-month-old event schemas

The old vendored processor keeps its old interpretation, but now the kernel must keep the old processor interface, SDK behavior, grant model, capability paths, and serialization semantics alive.

The compatibility matrix becomes:

```text
kernel revision × SDK revision × repo revision × package graph × journal schema history
```

A rebase does not solve that. It merely replaces the old interpreter and creates a migration obligation that each customized repo may handle differently.

#### Security patches

Mass repo mutation is not a reliable security primitive:

- Projects can revert it.
- Custom forks may not merge it.
- Dormant projects may not rebuild until months later.
- The vulnerable artifact may remain callable by an old durable reference.
- The patch cannot safely rewrite user-owned behavior without violating ownership.

If Iterate must prevent execution of a vulnerable version, enforce a minimum safe artifact at the loader or revoke the dangerous grant at egress. Git is evidence; it is not enforcement.

#### Verdict

Use B only for genuinely project-owned code:

- The founder’s specific policy.
- Bespoke apps.
- Project-specific routes.
- Custom processors.
- Explicit forks of platform behavior.

Do not vendor Iterate’s default implementation merely to make it visible. Publish its exact source, digest, contract, and lock instead. A portable export can materialize the full source later.

### C. Manifest plus immutable package pointers

This is the best default for real extensions, but the proposed “followers pick up on next build” semantics are wrong.

A follower must not silently resolve a different package because a registry pointer moved. The exact resolved lock must become a durable activation fact before the new code handles an event:

```text
package/channel-advanced
project/image-activation-requested
project/image-activated { previousLock, nextLock }
```

The repo may express policy—`follow stable`, `pin 3.2.1`, `security updates only`—but the journal records the exact result.

#### At one million projects

Publishing a revision is O(1). Activation becomes O(active followers), lazily:

- A dormant project performs no build or write.
- An active follower activates once on its next safe boundary.
- A pinned project stays pinned.
- An urgent kernel denylist can block an unsafe revision without waiting for activation.

That is the correct fleet shape.

But there is a trap: do not compile every package combination into one project-unique “Organism Image” bundle.

Twenty packages with three live revisions each have a theoretical `3^20 = 3,486,784,401` version combinations. Real dependency constraints reduce that, but not enough to justify monolithic per-project linking.

The image must be a content-addressed manifest DAG over shared artifacts:

```text
project lock
  ├── package A @ hash
  ├── package B @ hash
  ├── project policy data
  ├── grants
  └── routes
```

If the linker injects project-specific policy and secrets into executable bytes, identical packages stop sharing artifacts and C degenerates into B with extra machinery.

#### Eighteen-month-old event schemas

The phrase “the platform changes an event schema that lives in a package” reveals a bad ownership seam.

Either:

1. The schema is package-owned. The kernel treats its payload as opaque, and the pinned package owns parsing, migration, projections, and compatibility.
2. The kernel must understand the schema for auth, billing, confinement, or delivery. Then it is a kernel contract and must not live only in the package.

There is no safe third category where arbitrary package code owns a payload while today’s platform silently depends on its current shape.

For package schemas:

- Old events retain schema and contract revision.
- Old code is retained for audit, but may be prohibited from execution.
- New code includes deterministic upcasters or rebuilds a new projection.
- Breaking semantics use a new type or major contract.
- External effects are never replayed during migration.

Current events can record a processor slug/version, but the code itself says that stamp is merely a claim, not authenticated provenance ([schemas.ts:13](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/schemas.ts:13>)). C requires signed artifact identity, not that stamp.

#### Security patches

Use three classes:

1. **Normal update:** followers activate the new revision lazily.
2. **Critical compatible update:** a centrally maintained channel advances; active projects activate immediately.
3. **Known-dangerous revision:** the loader refuses to execute it or the grant evaluator denies its vulnerable effect path.

Pinned projects may receive a grace period, but a pin cannot be a right to execute known-malicious code forever. The honest result is “quarantined until upgraded,” not silent forced reinterpretation.

#### Build and cold-start economics

C wins only if artifacts are shared by exact package revision and project policy remains data.

It loses if every project’s dependency graph is bundled into one Worker. The current build mechanism is source-snapshot-oriented and installs `package.json` dependencies at build time ([schemas.ts:61](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/schemas.ts:61>)); it is not yet a retained, signed package-artifact linker.

#### Verdict

Use C for:

- Third-party processors.
- Optional vertical applications.
- Domain mini-apps.
- Replaceable integrations and adapters.
- First-party domains only after their replacement interface has proved stable.

Call it a lock, not an image, unless it is truly just a manifest over shared immutable artifacts.

### D. Workers for Platforms deployments

Workers for Platforms is viable at one million scripts. It is not free, instant, or a fleet updater.

Cloudflare currently documents an unlimited number of scripts in a dispatch namespace, but only 1,000 are included; each additional script costs $0.02 per month. One million scripts therefore cost roughly **$19,980/month** before request and CPU usage. Three independently deployed apps per project would cost about **$59,980/month** in script charges. [Cloudflare Workers for Platforms pricing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/)

Deployment fan-out is also real. Cloudflare’s documented client API limit is 1,200 requests per five minutes per user/account token. At four uploads per second, one token needs roughly **69.4 hours** to upload one million scripts. Multiple tokens or an enterprise limit increase can reduce that, but then Iterate owns a serious deployment orchestrator. User Workers also currently lack gradual deployment; a new user-worker version moves directly to 100% of that script’s traffic. [Cloudflare Workers for Platforms limits](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/limits/)

#### What D actually buys

- Strong tenant isolation for untrusted app code.
- A real Worker `fetch` surface with streaming and WebSockets.
- Per-worker resource limits.
- Dynamic hostname dispatch.
- Optional outbound interception.
- Operationally separate app failure domains.

Those properties fit domain mini-apps extremely well. Cloudflare explicitly positions dispatch Workers as the platform-controlled routing, authentication, limiting, and sanitization layer around user Workers. [How Workers for Platforms works](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)

#### What D does not buy

- Package version selection.
- Event-schema migration.
- Journal compatibility.
- Reproducible builds.
- Safe forced updates.
- Cross-project package sharing.
- A substitute for a package lock.

If every customer receives a private copy of the same tasks app, updating it still means one million deployments. If a single multi-tenant tasks Worker serves every project, the fleet update becomes O(1), but per-project execution isolation disappears. That is a legitimate trade, not a contradiction.

#### Cold-start and build economics

Builds happen before upload. Runtime does not reinstall npm packages, which is good, but each separately uploaded script remains a separately managed artifact. Untrusted user Workers also have isolated cache behavior and `caches.default` disabled, which may matter for asset-heavy mini-apps.

#### Verdict

Use D selectively for paid or security-sensitive HTTP applications requiring genuine Worker semantics. Do not make it the universal processor host and do not equate “one project app” with “one deployed Worker” automatically.

### Final fleet decision

The answer is a hybrid, but not a mushy one:

| Layer | Code ownership | Version selection | Likely execution |
|---|---|---|---|
| Constitutional kernel | A | Global deployment with compatibility | Platform Workers/DOs |
| Deep Iterate standard library | A initially; C only after a stable seam exists | Platform cohorts or managed channel | Platform host, sometimes shared remote Worker |
| Third-party/optional domain package | C | Durable channel resolution or pin | Generic processor host or remote processor |
| Bespoke project genome | B | Repo commit hash | Dynamic loader or D |
| Domain HTTP mini-app | B or C | Durable lock | Dynamic loader initially; D when isolation justifies it |

The config repo should contain:

- Override policy.
- Selected package channels/ranges.
- Custom code.
- Project-specific routes and apps.

The kernel should resolve that into an immutable lock and append its activation. It should not commit updated default source back into a million repos.

**Do not build the one-million-repo rebaser.** It buys less than a channel pointer, creates a vastly worse failure tail, and is weaker for security than an execution-time denylist.

What would change my mind:

- If customers require a complete offline source tree that runs without Iterate’s registry, materialize the lock into a vendored export. That still does not justify continuously rebasing the live repo.
- If first-party domains cannot maintain a stable processor interface for even 18 months, keep them platform-side; packaging them would export churn.
- If a package-artifact loader cannot share immutable modules independently and every lock requires a monolithic bundle, C becomes much less attractive.
- If Workers for Platforms gains cheap shared-version aliases, gradual user-worker deployments, and much higher bulk-upload throughput, use D more aggressively.
- If Iterate can demonstrate million-repo rollouts with six-nines success and essentially no customized overlap, B becomes technically possible. It would still need to explain what advantage it has over immutable pointers.

## B. “Everything in userspace” may be the wrong product

I no longer endorse the Round-2 statement that everything domain-shaped should become a package.

A better principle is:

> Everything outside the kernel should be implementable through public interfaces. It does not follow that every project should assemble its operating system from replaceable packages.

That distinction is the difference between extensibility and abdication.

### The opposite case is stronger than the notebook admits

Cloudflare’s own shape is instructive. Workers, Durable Objects, Queues, R2, and Workers for Platforms are deep, centrally operated modules with narrow interfaces and large implementations. Cloudflare does not ask each customer to choose a stranger’s npm package to provide queue retry semantics or Durable Object consistency.

Workers for Platforms itself provides isolation, dispatch, resource controls, and outbound interception as one deep platform module. It enables customer code above that depth; it does not make its own confinement replaceable. [Cloudflare Workers for Platforms architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)

Iterate should copy that shape.

### npm is transport, not governance

An npm tarball tells a non-technical founder almost nothing about:

- Who controls the publisher key.
- Whether ownership changed yesterday.
- What data leaves the project.
- Whether an update reinterprets old events.
- Whether uninstall is possible.
- Which other packages it conflicts with.
- Who handles a failed migration.
- Whether the package’s consent description is truthful.
- Who answers at 3 a.m. when the startup stops sending invoices.

A capability manifest improves inspection but does not eliminate judgment. A founder cannot meaningfully audit:

```text
read conversations
append work facts
invoke model
send email to selected recipients
read secret through pinned egress host
run scheduled obligations
```

That may be the minimum honest grant for a tasks or CRM package. It is still equivalent to trusting an employee with the company.

The operator is not a platform engineer. A design that requires them to compose and govern twenty strangers’ packages is optimizing for architecture reviewers rather than customers.

### Conway’s law becomes runtime structure

Every package publisher brings:

- Its own event vocabulary.
- Its own release cadence.
- Its own migration policy.
- Its own support organization.
- Its own failure semantics.
- Its own interpretation of tasks, users, conversations, money, and completion.

The self-driving startup becomes a distributed monolith whose teams happen to be external vendors. Cross-package bugs become customer-owned integration bugs. The supposedly tiny kernel must then grow package lifecycle, schema conversion, entitlements, grants, crash quarantine, marketplace disputes, and support tools.

That is not simplification. It moves complexity from domain implementations into the package manager and the operator’s head.

### The agent domain may be exactly the wrong extraction target

The current agent implementation is not merely 6,756 lines of accidental platform code. Its Durable Object composes the generic processor host with the agent processor, AI binding, gateway credentials, workspace spillover, Slack, Telegram, email, and PR processors ([agent-durable-object.ts:28](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-durable-object.ts:28>), [agent-durable-object.ts:76](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/agents/agent-durable-object.ts:76>)).

That is a deep module. Extracting it prematurely would replace one cohesive implementation with:

- An AI grant.
- A workspace grant.
- Channel grants.
- A generic processor protocol.
- Package-owned wake supervision.
- Cross-package event schemas.
- More remote calls.
- A more complicated support story.

The public SDK presently offers an at-least-once project-wide event callback, not the same supervision machinery available internally ([sdk.ts:88](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/packages/iterate/src/sdk.ts:88>)). That gap is useful evidence, but it does not prove the right answer is to make the agent implementation a user-selected package. It may prove the agent domain deserves to remain a first-party deep module while exposing replaceable model, policy, tool, and channel seams.

Do not create a replacement seam until a second real implementation needs it. A hypothetical marketplace is not a second implementation.

### When “put it in a package” is actively harmful

Packaging is harmful when any of these are true:

- The module owns a platform-wide invariant.
- Its event types are consumed by most other modules.
- It requires privileged secret or egress behavior.
- Security fixes must reach every active project immediately.
- Its journal interpretation must survive for years.
- There is only one credible implementation.
- Its grant cannot be explained to a non-technical operator in one screen.
- Failure requires cross-package debugging.
- Installation creates irreversible external resources.
- Package version and kernel version change in lockstep.
- The package is a thin wrapper around a private platform binding.

A package file can still be useful as an internal build unit. That is not the same as a user-installable extension seam.

### Where Iterate should deliberately not be extensible

No project package should be able to replace or shadow:

- Authentication, tenancy, or project identity.
- Journal append, offset, retention, idempotency, and provenance semantics.
- Processor checkpoint and obligation recovery.
- Capability-grant validation or revocation.
- Secret decryption/substitution.
- The final egress door.
- Package signature, install, upgrade, and quarantine rules.
- Billing, quota, or abuse metering.
- The recovery console.
- Platform-reserved event types and capability names.
- The canonical audit trail for code/image activation.

I would also reserve a small canonical vocabulary for facts that must interoperate across nearly every self-driving company: identities, conversations, commitments, artifacts, and external-effect receipts. Packages may add vertical facts and projections; they should not each redefine what “an obligation was completed” means.

### Constructive cut: three rings

1. **Kernel:** non-extensible constitutional machinery.
2. **Iterate standard library:** a small number of deep, centrally operated domains with overrideable policy and real adapter seams—agents/conversations, repo/artifacts, secrets/egress, scheduling/obligations, and selected integration machinery.
3. **Packages:** leaf applications, vertical workflows, custom projections, alternative UIs, narrow integrations, and remote processors.

“Everything in userspace” should remain an implementability test for Ring 2:

> Could a third party implement a credible alternative without private bindings?

It should not be the deployment mandate for every default on every project.

## C. Why the three best ideas may be bad

### 1. The five-concept ontology

This remains the strongest explanatory idea:

1. Project.
2. Journal.
3. Processor.
4. Capability.
5. Repo/genome.

It may also become a trap.

#### Production-killing failure mode

Semantic compression can hide incompatible guarantees behind one noun.

A journal row representing an immutable business fact is not operationally equivalent to:

- A transient LLM token.
- An HTTP request awaiting a response.
- A capability invocation.
- A command that may be rejected.
- A supervised external obligation.
- A mutable blob pointer.
- A live WebSocket.

The code has already introduced a second-class `ephemeral` event that is committed and ordered but excluded from durable reads and delivery and may later be evicted ([schemas.ts:58](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/streams/schemas.ts:58>)). That is defensible, but it demonstrates the point: “everything is a stream event” immediately acquires guarantee classes.

If the ontology becomes an implementation theorem, every missing semantic gets encoded as:

- A type-string convention.
- An envelope flag.
- A special processor rule.
- An invisible retention policy.
- A dashboard interpretation.
- Another exception in the generic engine.

The root interface becomes small while the protocol becomes enormous.

#### Incremental cost nobody is pricing

Every domain still needs:

- Query projections and indexes.
- Schema evolution.
- Retention and compaction.
- Domain-specific authorization.
- Ready/failed/degraded state.
- Operator recovery semantics.
- Backfill and migration.
- Business-level idempotency.
- A comprehensible UI.

A five-noun slide does not delete these costs. It can merely move them out of the type system into conventions.

#### Prior-art warning

Kubernetes is the closest precedent: “everything is desired state plus a controller” is extremely powerful. It also produced CRDs, finalizers, admission webhooks, status conditions, owner references, conversion webhooks, operator lifecycle management, and large amounts of YAML archaeology.

Unix’s “everything is a file” similarly survived through sockets, `ioctl`, `/proc`, `mmap`, and many exceptions. The abstraction won; literal uniformity did not.

#### Salvage

Keep the five concepts as the explanatory ontology. Do not insist they are the only runtime guarantee classes.

The wall diagram should say:

> Everything durable becomes fact in a named journal. Live transport, reads, blobs, and external obligations retain distinct semantics.

That is less pure and more correct.

### 2. The Organism Image

The image is a powerful idea because it makes version, authority, and self-modification concrete.

Its name encourages the wrong implementation.

#### Production-killing failure mode

An immutable per-project executable image conflicts with independent package updates and one-million-project economics.

Either:

- Package pointers resolve dynamically, in which case the image is not immutable.
- Every update creates and links a new per-project image, in which case fleet work returns.
- The image embeds project policy, in which case artifact sharing collapses.
- The image does not embed policy, in which case it is really a manifest plus state—not a self-contained organism.

It also makes replay claims that the current artifact layer cannot support. Worker artifacts presently expire after 30 days, and rebuilding can resolve different npm versions under the same build key ([artifact-store.ts:13](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/workers/artifact-store.ts:13>)). “Old images remain replayable forever” requires a fundamentally different store and lock discipline.

#### Incremental cost nobody is pricing

A real image system requires:

- Immutable resolved package locks.
- Signed artifact provenance.
- Toolchain retention.
- Artifact retention for the lifetime of journals.
- Garbage collection aware of journal references.
- Vulnerability scanning and revocation.
- A stable kernel ABI.
- Schema and upcaster graphs.
- Deterministic linking.
- Image activation and rollback.
- Compatibility testing across old images.
- Export and disaster recovery.
- A rule for replaying an image whose code is now prohibited from execution.

At one million projects with one activation per month, the twelve million annual activation facts are easy. Relinking and validating twelve million unique executable graphs is not.

#### Prior-art warning

Smalltalk images demonstrated the beauty of a whole living environment and the difficulty of diffing, rebuilding, and upgrading it cleanly. Docker demonstrated immutable artifact leverage and then produced base-image rebuild churn, tag ambiguity, CVE rebuild fleets, and image sprawl. Nix and Guix showed that reproducibility is achievable, but only with a substantial content-addressed store, derivation language, garbage collector, and operational culture.

The prior is not “images fail.” It is “images are an entire product.”

#### Salvage

Downgrade the Organism Image into an **Organism Lock**:

- A small immutable manifest.
- References to shared signed artifacts.
- Separate project policy data.
- Separate grants.
- Separate journal state.
- Exact activation offset.
- Materializable into a portable tarball on export.

Do not build a monolithic per-project executable unless measurement proves the runtime needs it.

### 3. Shadow worldlines for self-improvement

This is still the most visionary idea. It is also the easiest way to manufacture false confidence.

#### Production-killing failure mode

Historical replay cannot reconstruct the counterfactual external world.

If a candidate agent would have sent a different email:

- The human recipient would have replied differently.
- A vendor might have returned a different result.
- Time and market state would differ.
- The candidate might have caused a chain of effects absent from history.

Holding historical responses constant tests deterministic compatibility, not whether the alternate company would have succeeded.

LLM evaluation makes this worse. The organism chooses a candidate using an evaluator that shares its models, prompts, blind spots, and available history. It can optimize for the judge rather than the world. Self-improvement becomes automated Goodharting.

Current side effects also escape any hypothetical worldline court:

- Email is sent first and the audit fact appended afterward ([rpc-targets.ts:2936](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/rpc-targets.ts:2936>)).
- Repo commits directly clone/commit/push before any general effect ledger records them ([repo-durable-object.ts:297](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/repos/repo-durable-object.ts:297>)).
- Project files directly mutate R2 paths with no versioning ([project-files.ts:23](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/files/project-files.ts:23>), [project-files.ts:68](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/domains/files/project-files.ts:68>)).

Until those effects pass through one supervised seam, the shadow is incomplete by construction.

#### Incremental cost nobody is pricing

Suppose each of one million projects has only 10,000 replayable events. One fleet-wide candidate evaluation is **10 billion event folds**.

At one millisecond per fold, that is about 116 aggregate CPU-days.

If replay triggers only one model decision per 100 events, it still implies **100 million model calls**. Recording old model outputs avoids the expense but prevents evaluation of changed prompts or policies—the exact changes worldlines are supposed to test.

Then add:

- Privacy duplication.
- Shadow storage.
- Effect simulators.
- Code/artifact retention.
- Causal cuts across journals.
- Judge calibration.
- Scenario generation.
- Promotion and rollback.
- Protection against candidate code detecting the evaluation environment.

#### Prior-art warning

Shadow traffic and dark launches are excellent for compatibility, latency, and crash detection. They are weak for validating stateful writes and external consequences. Machine-learning systems repeatedly discover that offline evaluation does not predict online behavior once users react to the changed system.

Feature-flag and dual-write systems also have a history of becoming permanent parallel architectures whose cleanup costs exceed their original experiment.

#### Salvage

Use shadows narrowly for:

- Deterministic fold equivalence.
- Schema and projection migrations.
- Effect-intent diffs.
- Resource-cost estimates.
- Contract compatibility.
- Reproduction of known incidents.

Do not allow a shadow score to autonomously promote a new organism. Promotion should require a bounded live canary with real budgets, real external feedback, and explicit rollback criteria.

Worldlines are a testing instrument, not a truth oracle.

## D. The dashboard

The two-surface distinction is correct and already partially present in code.

The OS Worker separates the OS/dashboard host from project-host requests ([worker.ts:4](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/worker.ts:4>)). Project ingress already understands bare project hosts, app subdomains, and custom hostnames ([ingress.ts:9](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/ingress.ts:9>)). The seeded project worker already serves a project homepage and multiple apps selected by hostname ([config-repo-template/worker.ts:18](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/config-repo-template/worker.ts:18>)).

The architectural line should be based on dependency, not aesthetics:

> If an operation must remain available when the project image is absent, broken, compromised, or deliberately paused, it belongs at `os.iterate.com`.

A second test:

> If an operation changes who may run code, spend money, possess authority, cross tenancy, or recover the entity, it belongs at `os.iterate.com`.

A third:

> If rendering the page requires executing package UI or interpreting package-owned business semantics, it belongs on the project’s domain.

### Minimum non-removable OS dashboard

The kernel dashboard is a platform-owned recovery module. It need not live in the same binary as the journal kernel, but it must never depend on project code.

It needs exactly these surfaces:

1. **Identity and registry**
   - Organizations, principals, project creation.
   - Ownership and support-access audit.
   - Project/domain ownership.

2. **Platform health**
   - Current kernel compatibility.
   - Processor/delivery health.
   - Quotas, resource use, billing status.
   - Last successful project activation.

3. **Raw durable truth**
   - Raw journals and event provenance.
   - Delivery/checkpoint/obligation state.
   - Blob and artifact references.
   - No package-supplied renderers.

4. **Code and package governance**
   - Active config commit and immutable package lock.
   - Publisher identities and artifact hashes.
   - Upgrade proposal, pin, rollback, quarantine.
   - Build failures and compatibility errors.

5. **Authority**
   - Capability grants.
   - Egress restrictions.
   - Secret metadata, rotation, and revocation.
   - OAuth consent and external-account disconnection.
   - Never secret plaintext.

6. **Recovery**
   - Pause ingress, egress, or processors.
   - Select a previously known-good lock.
   - Revoke a malicious package.
   - Export, archive, restore, or delete the project.
   - Rotate compromised ownership credentials.

7. **Namespace control**
   - Custom domains.
   - Certificates and routing ownership.
   - Reserved app names.
   - Public/private exposure policy.

The console should not execute arbitrary package JavaScript, including “custom settings UI.” That invites grant-consent phishing. It may render declarative package manifests using an Iterate-owned renderer.

### What must leave `os.iterate.com`

- Agent chat.
- Tasks and workflow UIs.
- CRM, sales, finance, and support applications.
- Domain-specific analytics.
- Scheduler product UI.
- Integration-specific business actions.
- Repo IDE and normal development tools.
- Package-specific state views.
- Customer-facing auth and onboarding.
- The startup’s daily operating cockpit.

Today the dashboard still conflates the surfaces. “Open” on the project list routes into a new-agent page rather than the project’s own domain ([projects/index.tsx:260](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/routes/_app/projects/index.tsx:260>), [projects/index.tsx:308](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/routes/_app/projects/index.tsx:308>)). By contrast, the project root page’s raw stream, lifecycle state, settings, and custom-domain controls are mostly legitimate outside-the-entity operations ([projects/$projectSlug/index.tsx:34](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/routes/_app/projects/$projectSlug/index.tsx:34>), [projects/$projectSlug/index.tsx:98](</Users/jonastemplestein/.herdr/worktrees/iterate/simplification/apps/os/src/routes/_app/projects/$projectSlug/index.tsx:98>)).

A local count puts `_app` routes plus shared dashboard components at roughly 20,020 lines. The problem is not that this must become tiny. The problem is that it currently mixes trustee, developer, operator, employee, and customer roles in one product surface.

### Who is the kernel dashboard for?

- The legal/resource owner of the entity.
- A founder acting as board member or incident commander.
- A security or billing administrator.
- Iterate support under an explicit audited grant.
- An enterprise fleet operator.
- A project agent only if given a narrow governance capability.

It is not for the startup’s customers. It is not the daily workplace of its employees. It is not the startup’s public face.

A healthy self-driving startup founder should visit:

- `hq.their-domain.com` daily.
- `os.iterate.com` at creation, package-consent, billing, ownership-change, upgrade, and recovery time.

If the founder must use `os.iterate.com` every day to talk to agents or manage tasks, the entity has failed to grow its own operating surface.

If the founder can never stand outside the entity to revoke its code and recover it, the platform has failed to provide governance.

The kernel dashboard should feel less like the product and more like a cloud console, hypervisor panel, or corporate registry: powerful, trusted, and deliberately boring.

## E. Crazy idea: do not install software—hire software companies

Turn every serious package publisher into another Iterate entity.

A tasks system is not merely an npm tarball. It is a living provider project:

```text
tasks.vendor.com
```

Its public/domain surface serves customers. Its outside/OS surface holds:

- Publisher identity.
- Release journal.
- Contract schemas.
- Artifact signatures.
- Security history.
- Service-level policy.
- Billing and entitlements.
- Operator and insurer identity.

A customer project does not “install package X.” It **hires the provider entity** through a bilateral event contract:

```text
service/offered
service/accepted
grant/proposed
grant-approved
work-requested
work-completed
charge-recorded
service-terminated
```

Both projects journal the relationship. Cross-project delivery is an outbox protocol, not shared internal authority.

The provider can offer two placements:

1. **Hosted employment:** its processor runs in the provider project and receives only subscribed facts plus narrow customer grants.
2. **Resident employment:** it publishes a signed artifact that runs inside the customer project under the same contract.

Hosted employment solves the fleet update problem beautifully: the provider patches one running service rather than one million customer repos. Resident employment provides privacy and locality at the cost of package-version management.

This changes the marketplace from:

> “Trust this anonymous tarball with your company.”

to:

> “Enter a revocable, metered relationship with this operating entity, whose history, owners, incidents, customers, and commitments are visible.”

A project can then:

- Hire a bookkeeping project.
- Hire a recruiting project.
- Hire a coding-agent company.
- Sell its own product to other projects.
- Create subsidiaries as child projects with budgets.
- Switch suppliers by revoking one bilateral contract and activating another.
- Insure risky processors through another project that monitors their obligations.

The OS dashboard becomes the corporate registry and contract/capability graph. The project domain remains the actual company.

The insane failure mode is enormous: this turns a software platform into an economy. It introduces remote dependency, correlated vendor failure, data-sharing negotiations, service disputes, bankruptcy, reputation, and supply-chain concentration. A popular provider compromise could reach thousands of companies through legitimately granted capabilities.

But it attacks the two hardest problems at once:

- **Fleet updates:** maintainers update one living provider.
- **Package trust:** maintainers become accountable entities rather than mutable registry names.

The deepest version of Iterate may not be “any SaaS as an npm package.”

It may be:

> Any SaaS is an intelligent company that other intelligent companies can hire.

---

## Appendix E — Codex: the VFS crazy idea + entity-runtime reframe (verbatim)

# The entity is a tree, but not every leaf is a file

This is the hard run at two ideas that initially sound metaphorical:

1. Iterate is an **intelligent entity runtime**: a durable outer event loop around an ordinary language runtime.
2. An Iterate Project is one **virtual filesystem**: streams, events, repos, state, mounts, traces, and live media inhabit one navigable tree.

The first idea is stronger than “kernel + packages.”

The second idea is beautiful but false in its literal form.

The combination survives with one mutation:

> **Everything has a path; not everything is stored as a file.**

That preserves the LLM-native tree while letting journals be segmented logs, repos be Git trees, folds be generated views, secrets be unreadable cells, and PCM be a live device.

The result is not POSIX on Cloudflare.

It is a typed Project namespace whose filesystem interface hides several radically different implementations.

---

## 1. The intelligent entity runtime

### Verdict: a better organizing idea, if we earn the name

“Kernel” answers an implementation question:

> What cannot be expressed in userspace?

The kernel razor answers it well: identity, confined code, confined durable storage, durable wakeup, and one controlled exit for bytes.

But that is not the product’s central behavior.

It is the irreducible substrate beneath the behavior.

If streams can be implemented above that substrate, then “kernel” cannot be the hero without demoting the system’s actual idea to a library detail.

The hero is the durable loop that repeatedly turns history into state, state into intentions, and intentions into more history.

“Intelligent entity runtime” answers the more important question:

> What kind of computation does this system make possible?

It is an ordinary TypeScript, JavaScript, Python, or Wasm runtime wrapped by a more durable runtime that owns time, memory, retries, external effects, and stochastic calls.

The inner runtime executes code for a while and dies.

The outer runtime remembers what happened, wakes code again, and gives it the next fact.

The ordinary runtime has an event loop around promises.

The intelligent entity runtime has an event loop around lives.

That is a real reframe only if it imposes precise reduction rules.

Without those rules it is an Urbit-shaped poetic noun pasted over the existing 33-member front door.

### What the runtime instance is

One Project is one runtime instance.

This repairs a small but telling hole in the notebook: §4 directly enumerates only Stream, Stream Processor, Capability, and Repo, while the debate log calls the result five concepts.

The missing fifth is Project.

Under this reframe:

- **Project** is the durable runtime instance: identity, namespace, history, and confinement.
- **Stream** is an ordered history within that instance.
- **Processor** is a deterministic consumer that may propose effects.
- **Capability** is a mounted power the runtime may exercise.
- **Repo** is the instance’s editable self-representation.

These are no longer five peer-shaped boxes.

Project contains the others.

The entity runtime is the deep module; streams, processors, capabilities, and repos are its visible facilities.

### The logical machine

At any instant:

```text
Entity = {
  identity,             // stable ProjectId and confinement
  namespace,            // paths and mounted node kinds
  history,              // immutable durable facts
  checkpoints,          // disposable derived state
  obligations,          // requested work without a terminal fact
  sessions,             // live, lossy transports and watchers
  code,                 // content-addressed reducers and effectors
  egressPolicy          // the one watched exit
}
```

Only history and referenced content are semantic memory.

Checkpoints are acceleration.

Sessions are weather.

The repo is authored state plus the content-addressed identity of code used to interpret later facts.

“One history” does not require one global lock or one enormous physical log.

Each stream needs a total order.

The whole Project needs a causal graph.

A global chronology can be an index over that graph rather than the synchronization point for every Project write.

### The reduction rules

The runtime should be explainable in eight rules.

#### Rule 1 — Facts enter by commit

An input becomes real only after the runtime commits an immutable envelope.

The envelope receives:

- a stable event identity;
- a path-local offset;
- commit time;
- idempotency identity;
- actor identity;
- causal provenance;
- the code or manifest identity relevant to interpreting it.

```text
commit(path, proposedFact)
  -> committedFact(path, offset, eventId, createdAt, provenance, ...)
```

An HTTP request, timer, human message, repo commit, tool result, and completed model call all become facts when they matter durably.

#### Rule 2 — Durable state is reduced

For each committed fact, a pinned deterministic reducer computes new state and zero or more intentions:

```text
(state', intentions) = reduce(codeHash, state, committedFact)
```

The reducer may not consult ambient time, ambient randomness, a live network response, or mutable package resolution.

If a value can change durable behavior, it must arrive as a fact.

The commit timestamp supplies time.

A journaled random seed or result supplies entropy.

A content hash selects code and dependency versions.

#### Rule 3 — Reducers describe effects

A reducer may emit an intention such as:

```text
email/send-requested
fetch/requested
llm/requested
repo/commit-requested
```

The intention is committed before the world is touched.

An effector performs the operation under a stable idempotency identity.

Its observed outcome becomes a terminal fact:

```text
completed
failed
cancelled
expired
uncertain
```

This generalizes the agent processor’s existing `requested → started → terminal` obligation pattern.

#### Rule 4 — The LLM is a journaled oracle

Calling an LLM a “stochastic reducer” is visionary and mathematically dangerous.

A reducer is replayable.

An LLM call cannot be reconstructed exactly, even with the same prompt, model label, temperature, and nominal seed.

The useful equivalence is structural: both consume a projection of history and propose the next transition.

The honest operational name is **journaled oracle**:

```text
history
  -- deterministic prompt projection -->
llm/requested
  -- live provider call -->
transient chunks
  -- settle -->
llm/completed
  -- deterministic reduction -->
new state and intentions
```

The stochastic step proposes facts.

The deterministic step decides what committed facts mean.

#### Rule 5 — Replay reads outcomes

Replay disables effect execution.

It walks committed facts and invokes only pinned deterministic reducers.

When replay reaches `llm/requested`, it does not call the model.

When it reaches `llm/completed`, it reads the recorded output as an ordinary fact.

The same rule applies to external fetches, human approvals, randomness, and any non-commit clock observation.

Any nondeterminism that can change state crosses the journal seam once and becomes data.

#### Rule 6 — Only the live head finishes obligations

At the live head, a requested operation without a terminal fact is an obligation.

The runtime may retry it, reconcile it with the provider, or settle it as expired.

During historical replay, the same open request is merely historical evidence.

It must not redial the provider.

Exactly one terminal outcome wins under the request’s idempotency identity.

Late duplicate outcomes may remain as diagnostic facts, but cannot become a second state transition.

This is the rule that prevents “replay” from meaning “send every email and charge the card again.”

#### Rule 7 — Derived state is disposable

`state.json`, indexes, browser mirrors, and checkpoints are projections.

Deleting them must not delete truth.

Deterministic projections can be rebuilt exactly.

An LLM-produced memory compaction is stochastic and therefore must first be committed as a new fact.

Compaction never edits the past.

It adds a later interpretation of the past.

#### Rule 8 — Consequences name their causes

Every fact produced by a processor records the processor identity and the input facts being processed.

Every cross-post records the hop chain.

Every effect outcome points to its request.

Every request points to the state version, code image, actor, and triggering evidence that authorized it.

The runtime is therefore a causal machine, not merely a chronological one.

### Why this is stronger than “kernel + packages”

Kernel + packages remains a valuable implementation theorem:

```text
kernel:
  the confined computer and its watched exit

first libraries:
  streams, folds, delivery, capability mounts

packages:
  agents, integrations, tasks, dashboards
```

But it does not explain why those libraries belong together.

The entity runtime does.

Its central question is not:

> Which side of the kernel seam contains this code?

It is:

> How does this computation enter history, reduce, request an effect, settle, recover, replay, fork, and explain itself?

That organizing idea survives implementation movement.

Streams can leave privileged code without leaving the entity runtime.

A model adapter can move between providers without changing the journaled-oracle rule.

A Repo can move between storage implementations without changing its role in the runtime.

The reframe is therefore better than “kernel” as the product center.

It becomes a poetic relabel only if Iterate retains ambient nondeterminism, unjournaled effects, unpinned code, and causal holes.

---

## 2. The virtual-filesystem idea

### The strongest version

A Project presents one tree.

A path is the universal name for anything inside that Project.

The coordinate that currently identifies a Stream or Repo becomes a location in that tree.

The LLM does not learn a 33-member object graph.

It starts with `ls /`, reads descriptions, opens files, watches directories, appends facts, and follows links.

An illustrative Project:

```text
/
├── identity.json
├── agents/
│   └── ada/
│       ├── events/
│       │   ├── 0000000000000042-input-added.json
│       │   ├── 0000000000000043-llm-requested.json
│       │   └── 0000000000000044-output-added.json
│       ├── state.json
│       ├── transcript.md
│       └── live.ndjson
├── calls/
│   └── call-123/
│       ├── events/
│       ├── state.json
│       ├── audio-in.pcm
│       ├── audio-out.pcm
│       └── recording/
├── repos/
│   └── config/
│       ├── worktree/
│       │   ├── worker.ts
│       │   └── package.json
│       ├── commits/
│       │   └── 8f6c.../
│       └── HEAD
├── mounts/
│   ├── slack/
│   └── machines/
├── secrets/
│   └── openai.json
├── trace/
│   ├── events/
│   ├── causes/
│   ├── effects/
│   └── runs/
└── runtime/
    ├── health.json
    └── metrics.json
```

The shocking part is that `/agents/ada` is simultaneously an addressable entity, a stream directory, and a place an LLM can inspect like a working folder.

### Five honest node kinds

The tree is one namespace, not one storage technology.

| Kind | Example | Semantics | Likely implementation |
| --- | --- | --- | --- |
| Mutable file | `/repos/config/worktree/worker.ts` | replace with compare-and-swap; changes emit facts | Git/blob store |
| Immutable log entry | `/agents/ada/events/000...json` | create once; never replace | SQLite or packed segments |
| Generated view | `/agents/ada/state.json` | read-only projection | checkpoint plus reducer |
| Mount | `/mounts/slack/...` | live capability with its own interface | fetch/RPC adapter |
| Device or pipe | `/calls/123/audio-in.pcm` | ordered transient bytes | live transport |

Secrets prove why node kinds matter.

`/secrets/openai.json` may expose metadata, host pinning, version, and audit status.

It must never expose secret material on read.

The secret-cell invariant remains: material goes in; only a request to a pinned host comes out.

### How writes coexist

Do not overload one vague `write()` with invisible semantics.

The path’s node kind determines the contract.

At the HTTP interface:

```text
GET   /repos/config/worktree/worker.ts       read mutable file
PUT   /repos/config/worktree/worker.ts       replace with If-Match
POST  /agents/ada/events                     append and return Location
GET   /agents/ada/events?after=42&limit=500  paged listing
GET   /agents/ada/state.json                 read generated projection
WATCH /agents/ada                            subscribe to changes
OPEN  /calls/123/audio-in.pcm                establish live byte session
```

At a filesystem adapter, append can resemble exclusive creation inside `events/`.

The client supplies an idempotency identity, not the final offset.

The runtime commits the fact and exposes the canonical offset path.

The simplification is one addressing grammar.

It is not one verb pretending every resource has POSIX semantics.

### Is the Repo another subtree?

Yes.

This is the VFS idea’s cleanest win.

A Repo is already a Project-scoped versioned file tree whose Repo Path is also an Event Stream Path.

The identity seam is already shared even though storage is not.

The working tree is mutable.

Committed trees are immutable and content-addressed.

Repo lifecycle facts live beside them.

File contents live in blobs; journal facts carry content hashes rather than duplicating all bytes into JSON.

A file write can therefore have three views:

```text
/repos/config/worktree/worker.ts                 mutable authoring view
/blobs/sha256/ab/cd...                           immutable content
/repos/config/events/000012-file-written.json   durable fact referencing it
```

A commit produces a content-addressed tree and a `commit-landed` fact.

An activated worker image records the commit or image hash that processed later events.

### “Tar the filesystem”

Crazy corner §7.2 says entity = repo + journal.

The tree makes the export story easy to explain:

> Snapshot the Project tree and carry the entity away.

But “tar” is logical, not literal.

An export contains:

- Project identity and schema manifest.
- Durable facts and causal metadata.
- Referenced Repo objects and content blobs required by retention policy.
- Pinned reducer and package artifacts required for replay.
- Model request descriptions and committed model outcomes.
- Optional checkpoints.
- Optional recorded media segments.

It excludes:

- current pipe contents;
- open sessions;
- secret material;
- external consequences such as a remote Slack workspace.

The entity is portable as code and memory, not as a captured outside world.

### What the tree simplifies beautifully

#### One address

Today Stream, Repo, Capability, worker, and file each tempt a different lookup grammar.

The tree says every Project-local thing begins with a path.

`{projectId, path}` remains the durable coordinate.

ProjectId supplies confinement.

Path supplies locality within it.

#### Filesystem and fetch become duals

“Just fetch” becomes stronger.

An internal URL resolves to the same Project tree that `ls` and `open` expose.

Reading a regular node is a GET.

Appending to a log directory is a POST.

Replacing a mutable node is a conditional PUT.

Watching is a streamed fetch.

Opening a device upgrades to live transport.

External origins still cross the one egress seam.

#### LLM-native navigation

The primary user is an LLM trained on files, directories, diffs, Git, shell tools, and paths.

That matters more than theoretical namespace purity.

An agent can naturally inspect before acting:

```text
ls /agents
cat /agents/ada/state.json
tail /agents/ada/events
grep -R "approval" /trace
git diff /repos/config/worktree
```

Those commands may be adapters over the Project interface.

The mental model is already in the model’s bones.

#### Standard tools become entity tools

`ls`, `find`, `grep`, `diff`, `watch`, archive tools, IDE trees, and language servers become useful across the runtime.

A local adapter could let coding agents use their ordinary tools with little Project-specific prompting.

Generated TypeScript capability declarations can appear as files without becoming canonical storage.

The Repo already uses virtual type-environment projections in this spirit.

#### Whole-entity diff

Two snapshots can be compared as trees:

- code changed here;
- twelve facts appeared there;
- this derived state changed;
- this capability mount appeared;
- this decision caused these effects.

Do not ask Git to version every hot event file.

Build a semantic tree diff over snapshot manifests, log ranges, and content hashes, then render it in familiar diff form.

#### Locality

Everything about agent `ada` can live under `/agents/ada`.

Understanding it no longer requires bouncing across a capability tree, stream catalog, Repo catalog, hidden processor host, and trace panel.

That is real architectural locality.

### What the literal filesystem breaks

#### Millions of tiny files

One JSON object per physical file is the wrong implementation.

A voice-heavy stream at 100 frames per second creates 360,000 directory entries per hour.

Long-lived entities create millions or billions of tiny objects.

Metadata, object keys, listing indexes, garbage collection, and request costs may exceed the payload cost.

Directory enumeration becomes a database query wearing a cardigan.

Events should live in indexed SQLite rows or immutable packed segments.

Individual event paths are virtual lookups.

Directory listing must be paginated and cursor-based.

#### Fold-file write amplification

If every event rewrites `/agents/ada/state.json`, a large state blob may be copied hundreds of times per second.

Persist reducer-appropriate checkpoints or normalized state.

Render `state.json` on read.

A watch notification can say “projection changed at offset 44” without retransmitting the full state.

#### POSIX expectations

Calling something a filesystem makes callers expect:

- atomic rename;
- hard links;
- locks;
- permissions;
- meaningful timestamps;
- coherent caches;
- seekable descriptors;
- `fsync`.

Most of those promises are irrelevant or harmful here.

Cloudflare’s current Workers VFS is memory-backed: `/bundle` is read-only, `/tmp` is request-local, and `fs.watch` is unsupported. [Cloudflare Workers filesystem documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)

Durable Objects provide durable storage and live WebSockets, not a shared persistent POSIX filesystem. [Cloudflare Durable Object WebSocket documentation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

Therefore this cannot be literal FUSE inside a Worker.

It is a Project tree implemented over fetch, Durable Object storage, blobs, and live sessions.

A FUSE adapter may exist on a laptop as porcelain.

#### Tree structure cannot represent causation

Chronology fits a directory.

Causality does not.

One event may have three causes.

One cause may fan out to ten streams.

Cross-posting introduces multi-hop provenance.

A filesystem hierarchy gives a node one parent; traceability requires a directed graph.

Symlinks and generated directories can display that graph.

They cannot replace causal metadata in the event envelope.

#### Mutable files and immutable facts can be confused

If `worker.ts` and `events/00042.json` look like ordinary files, an LLM may try to edit history or assume a working-tree change is already committed truth.

`stat` and directory descriptions must expose:

- node kind;
- mutability;
- retention;
- consistency;
- allowed operations.

Attempts to replace events fail loudly.

Generated views are read-only.

Mutable Repo writes use compare-and-swap.

#### Capability mounts are not byte blobs

Slack, a browser, and a GPU machine have richer behavior than regular files.

Forcing every operation into byte-oriented `read` and `write` creates a shallow imitation of Plan 9.

The tree locates and describes the mount.

The mount may expose typed fetch or RPC behavior behind that path.

One address does not require one impoverished operation.

#### Secret files are dangerous

A readable `/secrets/openai/value` destroys the output-gate security thesis.

Secret metadata may be file-shaped.

Secret material remains write-only and usable only through pinned egress.

Unix already provides the precedent: some paths represent devices with asymmetric operations.

The VFS must embrace that heterogeneity.

---

## 3. The PCM-audio stress test

### The frame budget

Real-time audio turns “events are cheap” into a measurable claim.

At 20 ms per frame:

- 50 frames arrive per second in each direction.
- A bidirectional call produces 100 frames per second.
- That is 360,000 frame deliveries per hour.

For signed 16-bit mono PCM:

| Sample rate | Bytes per 20 ms frame | Bidirectional bytes/s | Raw bytes/hour |
| --- | ---: | ---: | ---: |
| 16 kHz | 640 | 64,000 | 230.4 MB |
| 24 kHz | 960 | 96,000 | 345.6 MB |
| 48 kHz | 1,920 | 192,000 | 691.2 MB |

Stereo doubles those rates.

JSON and base64 add substantial overhead.

Opus reduces bytes but still normally produces 50 scheduling events per second per direction with 20 ms packets.

The hard cost is not merely bandwidth.

It is validation, allocation, persistence, indexing, fan-out, and eventual eviction every 20 ms.

### Does PCM-through-the-log survive?

It can be made to benchmark well on a warm Durable Object.

The existing decided stream design explicitly targets `10²–10³` events per second and non-awaiting warm delivery.

That is meaningful evidence: the transport is not automatically too slow.

But “can pass the benchmark” is not the same as “belongs in durable history.”

Today an ephemeral event is still:

- synchronously committed;
- assigned an offset;
- stored as an SQLite row;
- subject to idempotency and stream control;
- only later eligible for eviction.

For PCM, that pays most of the journal cost for bytes whose defining property is that durable state may not depend on replaying them.

It also floods the trace with hundreds of thousands of entries that explain no decision individually.

My verdict deliberately reverses the current “PCM-through-the-log” plan:

> **Do not make each PCM frame an event, even an ephemeral event.**

Keep the existing ephemeral-event lane for lower-rate signals such as LLM chunks, progress ticks, and UI paint.

Add a true transport lane for high-rate bytes.

### The FIFO rescue

The VFS metaphor survives audio because Unix never claimed every path was a regular file.

Expose audio as live devices:

```text
/calls/call-123/audio-in.pcm   kind=device, direction=write, retention=none
/calls/call-123/audio-out.pcm  kind=device, direction=read,  retention=none
/calls/call-123/events/        kind=append-log, retention=durable
/calls/call-123/state.json     kind=projection
```

Opening a device establishes a WebSocket, WebRTC, or future transport session.

Frames carry:

- session identity;
- direction;
- sequence number;
- media format;
- binary payload.

They do not receive journal offsets.

They do not enter SQLite merely to be deleted.

They do not trigger general durable subscribers.

The live session owns jitter buffering, backpressure, loss detection, and reconnect behavior.

The entity runtime owns the durable facts around the session.

This is the honest distinction between transport and memory.

### Audio-device rules

The device interface needs hard performance rules:

- No durable transaction per frame.
- No JSON or base64 on the binary path.
- Bounded buffers.
- Drop obsolete audio rather than grow memory indefinitely.
- Explicit sequence numbers and gap reporting.
- Declared backpressure policy.
- Warm forwarding overhead below a few milliseconds.
- No general fold or selector evaluation per frame.
- Aggregate transport metrics instead of one metric event per packet.

Cloudflare recommends batching high-frequency WebSocket messages to reduce runtime crossings, but conversational audio cannot casually spend another 50–100 ms on batching. Measure mouth-to-ear latency, not only throughput. [Cloudflare Durable Object WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

An active call is not a hibernation workload.

Optimize for continuity during the call and hibernate after silence or call end.

### What remains durable

Durable facts should record the call’s meaning and consequences:

- `call/requested`
- `call/accepted` or `call/rejected`
- participant and authenticated actor identities
- consent and recording policy
- negotiated format
- recognizer, voice model, LLM model, prompt, tool schema, and code-image identities
- finalized transcript segments with source time ranges
- human and assistant turn boundaries
- LLM request and completed output
- tool and approval decisions
- external effects requested and completed
- material failures, reconnects, and policy changes
- `call/ended` with aggregate loss, jitter, duration, and cost

Transient transport includes:

- raw PCM or Opus frames;
- jitter-buffer churn;
- interim recognition hypotheses;
- partial synthesized speech;
- high-frequency level meters;
- packet-by-packet metrics.

The rule:

> Journal what the entity may rely on later; transport what only the present moment needs.

### Optional exact audio evidence

Some calls require consented recording for audit or quality review.

That still does not justify an event per frame.

Tee the device into time-bounded binary segments in object storage.

Append one manifest fact per segment:

```json
{
  "type": "call/audio-segment-recorded",
  "payload": {
    "direction": "in",
    "firstSequence": 1200,
    "lastSequence": 1449,
    "startedAt": "...",
    "endedAt": "...",
    "contentHash": "sha256:...",
    "blob": "/blobs/sha256/...",
    "format": "audio/L16;rate=16000;channels=1"
  }
}
```

The journal retains a compact causal manifest.

The blob store handles media efficiently.

Retention may later delete the blob while preserving a tombstone and content hash.

For unrecorded calls, the device may maintain a rolling hash chain and periodically commit a digest.

That proves which sequence the runtime observed if another party retained the bytes.

It cannot reconstruct sound from a hash.

Traceability must state that limitation.

---

## 4. The traceability stress test

### A sorted folder is a timeline, not a trace

Zero-padded immutable filenames make chronology easy to inspect.

They do not answer “why?”

An event at offset 44 may have been caused by:

- another event on the same stream;
- a copied event three streams away;
- a timer configured last week;
- an LLM output derived from fifty earlier facts;
- a human approval;
- an obligation retry after eviction;
- a Repo image activated during the operation.

Filesystem parentage cannot encode that graph.

Timestamps do not prove causality.

Filename ordering cannot safely cross independent stream orders.

### The causal envelope

Every durable fact should carry or resolve to:

```ts
type TraceEnvelope = {
  eventId: string
  projectId: string
  path: string
  offset: number
  type: string
  createdAt: string
  actor: {
    kind: "human" | "processor" | "external" | "system"
    id: string
  }
  causes: Array<{
    eventId: string
    relation: string
  }>
  processor?: {
    slug: string
    version: string
    codeHash: string
  }
  crossPostChain?: Array<{
    path: string
    offset: number
    subscriptionKey: string
  }>
  requestId?: string
  idempotencyKey?: string
  payloadHash: string
  retention: "durable" | "manifest" | "tombstone"
}
```

The existing stream implementation already stamps processor identity, version, home stream, current input, and cross-post hops.

The important missing dimension is first-class actor identity:

> Who or what exercised the authority that introduced this fact?

`causes` must support multiple parents.

A model request may depend on a prompt projection, current user turn, model-selection fact, approval policy, and active Repo image.

Large dependency sets can use a content-addressed context manifest rather than repeating thousands of event identities.

### How the VFS presents the graph

Canonical causation remains metadata.

The filesystem is a good projection:

```text
/trace/events/evt_44.json
/trace/causes/evt_44/evt_41 -> ../../events/evt_41.json
/trace/causes/evt_44/evt_12 -> ../../events/evt_12.json
/trace/effects/req_9/request.json
/trace/effects/req_9/completed.json
/trace/runs/agent-ada-turn-7/
/trace/by-actor/user-123/
/trace/by-code/sha256-abcd/
```

`grep`, `find`, and `tree` now work over generated indexes.

Deleting an index does not delete provenance.

Rebuilding it is a deterministic projection.

Symlinks are presentation, not truth.

Extended attributes are too invisible and too easy to lose during export.

The event envelope and trace graph must travel in the logical tar.

### Deterministic and stochastic traceability

A deterministic transition can be explained operationally:

```text
fact 41
+ reducer sha256:abc
+ prior state through offset 40
= state 41
+ request 42
```

A stochastic transition can be traced but not fully explained:

```text
request 42 contained this prompt and context manifest
provider received it under this model and parameter set
these chunks arrived transiently
completion 44 recorded this exact output
decision 45 consumed completion 44
effect 46 left through this egress policy
```

That is exact operational provenance.

It is not access to the model’s hidden cognition.

An LLM-generated “reason” is another output fact, not proof of its internal reason.

That distinction makes the trace promise credible rather than mystical.

### Traceability without retaining every frame

The audio device permits three trace-fidelity levels:

1. **Semantic trace:** finalized transcript segments and turn boundaries.
2. **Integrity trace:** transcript segments reference frame ranges and rolling audio digests.
3. **Exact trace:** consented binary audio segments are retained by content hash.

Every durable decision points to the transcript or audio manifest it consumed.

Every transcript points to:

- recognizer version;
- configuration;
- time and frame range;
- audio digest;
- recording-retention policy.

Every model output points to the exact prompt/context manifest.

Every effect points to the decision and approval authorizing it.

This preserves the primary purpose:

> We can see what durable decision happened, what evidence was presented, which code or model acted, and what left the Project.

If raw audio was not retained, we cannot later prove the transcript was acoustically correct.

No filesystem metaphor can create evidence that policy chose not to retain.

The trace should show that absence explicitly.

### Traceability is about consequences, not hoarding

“Everything is traceable” should mean:

> Every durable state change, decision, and external consequence has a walkable causal chain to the evidence and authority that produced it.

It should not mean:

> Every transient byte is stored forever as a database row.

The first promise is valuable and achievable.

The second makes voice expensive, increases retention of sensitive recordings, and buries decisions beneath transport noise.

The egress gate is the final trace seam.

It should record:

- request identity;
- authorizing causes;
- policy decision;
- substituted secret identities without material;
- destination;
- sent-body hash or policy-retained body;
- response status;
- uncertainty about remote completion.

The entity’s history can prove what it attempted and observed.

It cannot prove that the outside world obeyed.

---

## 5. Keep / kill / mutate

### Keep

Keep the **single navigable Project tree**.

It is an unusually good interface for the primary user: an LLM that already thinks in paths, files, diffs, and watches.

Keep path as the common coordinate across:

- streams;
- repos;
- projections;
- mounts;
- traces;
- live sessions.

Keep the fetch/filesystem duality.

Keep the logical “tar the entity” export.

Keep standard-tool projections.

Keep “intelligent entity runtime” as the organizing idea above kernel and userspace.

It names the behavior that remains stable while implementation placement changes.

### Kill

Kill **one physical file per event**.

It fails storage locality, listing cost, media volume, and operational honesty.

Kill **PCM frame = event** as a universal rule.

The runtime must carry real-time audio, but history need not impersonate a network buffer.

Kill **folder order = trace**.

Chronology is not causation.

Kill **full POSIX** as a platform promise.

It exposes a huge shallow interface containing semantics the entity runtime neither needs nor can implement consistently on Workers.

Kill **everything is a regular file**.

It makes secrets readable, capabilities awkward, derived state write-heavy, and live media impossible.

### Mutate — the one mutation

> **Mutate “everything is a file” into “everything has a path.”**

That is the mutation that keeps the beauty while surviving audio, traceability, and storage.

Under it:

- journals are packed logs projected as immutable event files;
- repos are mutable and content-addressed file trees;
- folds are generated read-only files;
- causal graphs are metadata projected as directories and links;
- capabilities are mounted nodes with typed interfaces;
- secrets are metadata plus write-only, pinned-egress behavior;
- PCM and other hot bytes are devices or pipes;
- recordings are segmented blobs referenced by durable manifest facts;
- `ls`, `cat`, `grep`, `diff`, and `watch` remain the shared navigation language;
- physical storage may use SQLite, blobs, Git objects, caches, and live sockets honestly.

The module stays deep because callers learn one namespace and a small set of explicit node kinds.

The implementation retains locality because each kind receives the storage and transport discipline it needs.

This is more radical than applying filesystem vocabulary to the existing interface.

It says the Project—not `itx`, not the Stream Durable Object, not the Repo—is the stable namespace.

Everything else mounts into it.

It also disciplines the intelligent entity runtime:

```text
durable nodes become facts
facts reduce into generated nodes
intentions settle into more facts
live devices carry the present
the trace graph explains every lasting consequence
```

The kernel is the confined computer with one watched exit.

The entity runtime is the durable outer loop.

The Project tree is the face humans and models touch.

Those are three different ideas, finally doing three different jobs.

## Wall slogans

> **What matters later becomes history. What matters now can flow past.**

> **Everything has a place. Not everything stays.**

> **You can replay a decision without saving every sound.**

---

## How you'd explain all this to a smart friend

An Iterate project is a named, fenced-off computer that remembers every lasting
fact, runs code in response, can rewrite that code, and can touch the world only
through one watched exit.

### Four things to know

> **What matters later gets written down before anyone acts.**

Each path has an ordered log. Messages, timers, decisions, requests, and results
go into it; live audio frames and other throwaway bytes do not.

> **State is what a reader has understood so far.**

A processor follows a log, updates its state, and remembers where it stopped.
Work that must survive a crash is written as requested, then completed, failed,
expired, or uncertain.

> **The repo is the part of the project that the project can rewrite.**

It holds the code and policy that decide how future facts are handled. Every
lasting result must name the exact code version that produced it, so replay
never means guessing which code used to run.

> **Tools plug in; bytes leave through one door.**

Slack, a browser, a GPU box, or a laptop is just a tool mounted at a path.
Inside one project, code may use what it has been given; it can never reach
another project, read secret material, or send external bytes except through
the watched exit.

An LLM fits without becoming a special kind of machine. Its request is written
down, its live chunks may flow past, and its final answer is written down.
Replay reads that answer; it never asks the model to invent it again.

### Why the code became heavy

> **Every new feature arrived as a new thing instead of another use of the old
> things.**

That was reasonable one feature at a time. Agents, schedulers, integrations,
files, sandboxes, and browsers all had real needs, so each gained its own
classes, routes, descriptions, and recovery code.

The weight came from solving the same jobs several times: several delivery
lanes, several processor hosts, several retry systems, several channel
transcribers, and several places for project files to live.

The public API then exposed those implementation parts as if users had to learn
them all. The idea stayed small, but its front door grew to 33 names and its
built-ins grew a second calling system beside streams.

### What to do

Just do this:

1. Make the front door teach four verbs: authenticate, append, follow, and
   fetch. Keep friendly helpers, but make them obvious shorthand.

2. Resolve built-ins and third-party tools as the same described mounts through
   one path walk. Generate code, docs, and discovery from one description.

3. Use one processor engine, hide the host, and write crash-safe work once:
   request, retry, expiry, and one terminal result.

4. Use one durable delivery rule everywhere, including the browser: the stream
   owns the cursor, successful delivery moves it, and failure retries or parks.
   Give high-rate live bytes a real pipe instead of fake log entries.

5. Let the first append create a path and record the exact code it activates.
   Reading a missing path must not create anything.

6. Make the repo the one home for project code and working views. A sandbox is
   a mounted computer, and building happens there rather than in a separate
   filesystem world.

7. Replace vendor-specific channel machines with one channel shape and keep
   routing, prompts, and reply policy in project code.

8. Keep three clear layers: a tiny hard floor, a few deep Iterate-run modules,
   and leaf packages. A third party must be able to rebuild the middle through
   public interfaces, but users should not have to assemble their company from
   twenty strangers’ packages.

### The wild ideas worth keeping

> **A durable call is a tiny workflow.**

Both use a request and a result; the quick form may leave no record, while the
crash-safe form keeps both and can resume.

> **Code plus history is a portable life.**

Export the repo, logs, referenced blobs, exact package versions, grants, and
effect receipts, and the project can move—even though its secrets, live
sessions, and outside consequences cannot.

> **Let new code relive yesterday before it gets today.**

Run a proposed change over real history with effects blocked, compare its state
and proposed actions, then use a small live trial before promotion.

> **Everything could be a package; not everything should be installed as one.**

Public interfaces should be strong enough to replace any non-core module, while
deep first-party modules may stay centrally run until a real replacement
exists.

> **A coding agent is a processor that can live anywhere.**

Give it ordered batches, a saved checkpoint, narrow temporary powers, and safe
retry keys; never promise that remote work happens exactly once.

> **Everything has a path; not everything is a file.**

Logs, repos, generated state, mounted tools, write-only secrets, and live pipes
can share one project tree without pretending they share one storage format.

> **Never rerun a guess when you can replay its answer.**

Model calls, human approvals, random choices, and outside responses become
facts once; every later replay reads those facts.

> **Don’t install a service; hire it.**

Two projects can exchange signed facts and narrow powers, letting a provider
update one living service instead of shipping code into a million repos.

Everything durable is an append. Everything alive is a follow. Everything that
can harm the outside world must cross the watched exit.
