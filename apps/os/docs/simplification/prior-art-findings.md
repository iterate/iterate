# Prior-art findings — hardening the iterate design

> Companion to `DESIGN.md`. For each area: (1) how the leading systems actually do it,
> (2) the mechanism/API worth borrowing, (3) the pitfall they hit, (4) where iterate is
> genuinely novel vs. reinventing. Each area ends with a **Borrow / Avoid / iterate is
> novel here** line. Interview questions at the very end.
>
> iterate frame (for reference): a project = a self-improving digital organism = a web
> server whose behavior is TypeScript in a git repo (or LLM-written on the fly). Whole
> surface = `fetch(request)` + `processEvent(event)`. State + internal messaging = append-only
> event streams; processors `reduce` events into reduced state and react by appending.
> Security is object-capability, enforced only at the project boundary + the egress door.
> Cloudflare Workers + Durable Objects.

---

## 1. Reactions on stateful actors vs. stateless compute

**The key question for iterate:** `processEvent` fires for every durable event on every
stream. Does the reaction run on a *sticky stateful actor* that already holds reduced
state, or on a *stateless worker* that (re)loads state? iterate's answer (D4/R13): the
**DO is the ordering point and the record; compute is stateless.** The whole industry has
converged on the same split — but they disagree on where the *hot reduced state* lives.

**How the leaders actually do it:**

- **Restate.dev** is the closest architectural twin. The **Restate Server** (Rust) is "at
  a similar place in your stack as a message broker": it stores all state + execution
  journal and *pushes* invocations to **stateless** service handlers, delivering the
  relevant state/journal *with each request*. Your services "remain stateless, can scale
  horizontally, and run stateful logic even on serverless." **Virtual Objects** are
  entities keyed by an id, each with isolated K/V state and a **per-key intrinsic lock** —
  at most one invocation runs per key at a time; others queue. This is *exactly* iterate's
  "DO is the ordering point, worker is stateless" — Restate Server ≈ the stream DO,
  Virtual Object key ≈ stream path, per-key lock ≈ single-writer-per-stream.
- **Temporal** runs a **cluster**: Frontend (RPC), History (persists event histories, fires
  timers — stored in Cassandra/MySQL/Postgres *behind* Temporal, not your DB), Matching
  (dispatches tasks to long-polling workers). Your code is a stateless **worker** that
  pulls a task, **replays the event history to rebuild local variable state**, executes,
  reports back. Reduced state is *never* held hot — it's re-derived by deterministic replay
  every activation. Cost: "tens to hundreds of ms per step" of async dispatch.
- **DBOS** collapses the split: it's a *library* you import, pointed at Postgres; each step
  checkpoint is a **single Postgres write (1–2 ms)**. No separate worker fleet, no cluster.
  Workflow state lives in the *same transactional boundary* as your business data.
- **Azure Durable Functions** = Temporal's model on serverless: orchestrator functions
  **replay from an event-sourced history** on every activation, hence the hard
  **determinism constraint** (no `Date.now()`, no random, no non-replayable I/O in the
  orchestrator).
- **Kafka Streams** is the outlier that keeps state **hot and local**: each stateful
  processor owns an embedded **RocksDB** store (writes are local, no network hop), backed by
  a compacted **changelog topic**. On failure/rebalance it **restores by replaying the
  changelog** (bypassing deserialization for speed) from a **checkpoint file** offset. If
  the checkpoint is lost → full changelog replay (minutes for large state). The mitigation
  is **`num.standby.replicas`**: warm standby tasks that continuously tail the changelog on
  *another* instance, cutting failover from *minutes to seconds*; plus **warmup replicas** to
  keep a task available on the old instance while it re-warms on the new one.
- **Akka Cluster Sharding** keeps entities as **sticky in-memory actors** distributed across
  nodes (Shard Coordinator), with **passivation** (evict idle entities) and rehydration from
  a persistence journal — and co-locates Kafka partitions with shards to avoid network hops.
- **EventStoreDB** is purpose-built for the *rebuild-an-aggregate* direction Kafka is bad at:
  aggregate streams, optimistic concurrency, catch-up subscriptions, server-side projections.

**Mechanism worth borrowing:** Restate's "**server holds journal+state, pushes to stateless
handler, single-writer lock per key**" is the cleanest statement of iterate's own model — and
worth stealing its *vocabulary* (Virtual Object = keyed durable entity with a per-key queue).
For cold-start/rebuild, Kafka's **checkpoint-file-offset + standby replica** is the concrete
recipe iterate wants for "processor survives eviction and heals on wake" (R6): persist a
reduced-state snapshot + the offset it covers, so wake replays *only the tail*, not the whole
log; optionally keep a warm standby subscriber.

**The pitfall they hit:** the **rebuild-state cost** is the recurring wound. Temporal/Durable
Functions pay full deterministic replay on *every* activation (fine for short workflows, brutal
for long-lived ones — hence Temporal's `continue-as-new` to truncate history). Kafka pays
**minutes of changelog replay** on checkpoint loss, which is why standby replicas exist at all.
The determinism constraint (Durable Functions) is a constant footgun — a stray `Date.now()`
silently corrupts replay.

**Where iterate is genuinely novel vs. reinventing:**
- *Reinventing (fine):* stateless-compute-over-a-durable-log is Restate/Temporal/Kafka
  orthodoxy. iterate is not inventing durable execution.
- *Genuinely different:* everyone above runs **workflow-as-code** (the reaction *is* a
  durable function whose control flow is checkpointed/replayed). iterate runs
  **reaction-as-event-sourcing-purist**: there is no durable call stack to replay — the
  reaction is a fresh `processEvent` over reduced state, and "waking" is itself a
  `stream/woken` **event** on the normal path (D3), not a framework hook. Nobody else models
  *reconcile/reconnect/timer* as ordinary events the same code path handles. That's a real
  simplification — and a real bet that you never need a suspended-call-stack workflow.

**Borrow / Avoid / iterate is novel here:** **Borrow** Restate's server-holds-state /
stateless-handler / per-key single-writer framing and Kafka's checkpoint-offset + standby-replica
recipe for cheap wake. **Avoid** Temporal/Durable-Functions deterministic-replay-of-a-call-stack
(iterate's fresh-reduce-over-reduced-state sidesteps the determinism footgun entirely).
**iterate is novel** in making waking/reconcile a first-class *event* rather than a workflow hook.

---

## 2. The request→completed "obligation" / saga pattern

iterate's convention (Q3): durable side effects are a **pair** — `<verb>-requested →
<verb>-completed { outcome }` — reduced state tracks open ones; wake re-drives them with
idempotency keys. This is a well-trodden path; the naming and failure semantics are settled
industry-wide and iterate should adopt the vocabulary deliberately.

**How the leaders actually do it:**

- **Transactional Outbox** is the canonical "I intend to do X" fact. You write the business
  change **and** an outbox row in the *same DB transaction*; a relay polls/tails the outbox and
  publishes. Guarantees **at-least-once** → the consumer *must* be idempotent. This is iterate's
  `-requested` event committed atomically with the state change, and the platform's wake =
  the relay.
- **Idempotency via inbox:** consumers keep an **inbox table / dedup cache** of processed
  message ids for an **idempotency window (commonly 24–72h)**; check-before-process, skip or
  return cached result on replay. This is exactly iterate's "idempotency keys on side effects"
  (R6) — but note the *windowed* nature: dedup is not free forever.
- **Temporal Activities** are the gold standard for the effect half: **at-least-once**
  execution ("if a Worker runs an Activity successfully but crashes before reporting, it's
  retried"), made **effectively-once** by idempotency keys on the effect. Temporal's *intent*
  half is the workflow history event that schedules the activity.
- **Saga / compensation:** the outcome of `-completed` can be failure, which triggers
  **compensating transactions** (undo prior local transactions). Two flavors: **orchestration**
  (a central coordinator drives compensations — Temporal, Netflix Conductor/Orkes) vs.
  **choreography** (each service reacts to events — the iterate cross-post model). Canonical
  naming: **pivot transaction** (the point of no return, after which you roll *forward* not back).
- **Intent-focused events (event-sourcing orthodoxy):** "`two seats reserved`" beats
  "`remaining seats = 42`" — capture the *business intent*, not just the resulting state. This
  is a direct argument for iterate's D12 (capture verbatim) and for making `-requested` carry
  the *intent*, not a diff.

**Mechanism worth borrowing:** the **outbox + inbox-idempotency + windowed dedup** triad is the
literal implementation of iterate's request/completed pair. Steal the naming discipline: the
verb-past-tense `-requested`/`-completed{outcome}` maps onto "command intent recorded" →
"activity result." And explicitly adopt **saga vocabulary** — *compensation*, *pivot
transaction* — for the failure branch iterate currently under-specifies (Q3 says "outcome is
data" but not what re-drive does on a *non-idempotent, already-half-done* effect).

**The pitfall they hit:** the **non-idempotent effect that half-succeeded** (charged the card,
crashed before writing `-completed`). At-least-once + a naive re-drive double-charges. The
industry fix is *always* an idempotency key **carried into the external call itself** (Stripe's
`Idempotency-Key` header), not just internal dedup — because the dedup window can expire before
the retry. Second pitfall: **dedup window expiry** — a retry after 72h is a fresh, un-deduped
effect. Third: choreography sagas become **impossible to reason about** at scale (no central
view of in-flight transactions) — orchestration exists precisely because pure choreography
doesn't debug.

**Where iterate is genuinely novel vs. reinventing:**
- *Reinventing (correctly):* the requested/completed pair *is* outbox+saga. iterate should
  say so and inherit 20 years of hardening, not reinvent the failure taxonomy.
- *Genuinely different:* iterate has **no separate outbox table** — the stream *is* the outbox,
  because the append that records intent and the append that would be the outbox row are the
  same primitive (D7: one abstraction = db + queue + workflow). And "re-drive on wake" is not a
  relay poller but a **reduce over open pairs** on the normal reaction path (D3). That
  collapse is real and worth stating; but it does *not* exempt iterate from the
  idempotency-key-in-the-external-call and dedup-window problems.

**Borrow / Avoid / iterate is novel here:** **Borrow** the outbox/inbox/idempotency-window triad
and saga vocabulary (*compensation*, *pivot transaction*, *effectively-once*), and Stripe-style
idempotency keys pushed *into the external call*. **Avoid** pure choreography with no in-flight
view for multi-step effects (add a reduced-state ledger of open obligations — which iterate
already implies). **iterate is novel** in that the stream *is* the outbox — intent and record
are one append — so there's no dual-write to keep consistent.

---

## 3. Object-capability systems in practice

iterate's D13 is textbook ocap: authority = what you hold; checks at **mint time**, not use
time; **attenuate instead of check**; make forbidden things **un-nameable**; the only per-use
check is **revocation**. This is drawn straight from Mark Miller's *Robust Composition* (2006)
and it's directly implementable — the hard part is attenuation-without-leaks and revocation.

**How the leaders actually do it:**

- **E language / CapTP** (Miller): the origin. Attenuation = **interpose an access abstraction
  ("attenuating forwarder") that forwards messages Alice→Carol under Alice's control** —
  exactly iterate's bind-as-attenuation. Named patterns to steal wholesale:
  - **Caretaker / revocable forwarder:** hand out a *forwarder* to the real object plus a
    *revoker*; calling the revoker nulls the forwarder → **revocation without touching the real
    capability**. This is iterate's "only legitimate per-use check is revocation."
  - **Facet:** a narrow interface object exposing only some methods of a richer object (read-only
    facet of a read-write thing) — attenuation by *interface*, not by argument.
  - **Membrane:** a *transitive* caretaker — revoke the membrane and **every object reached
    through it** dies at once. This is what iterate wants when it revokes an `itx` subtree.
  - **Sealer/unsealer:** rights amplification / opaque boxing.
- **Cap'n Proto** productionized CapTP: capabilities are first-class RPC objects; **Level 1 =
  promise pipelining** (call methods on the *result* of a call before it returns — one round
  trip for a chain). Directly relevant to iterate's `itx.a.b.c()` tree and R7 "looks like
  TypeScript": pipelining is how you keep a deep capability tree fast over a network hop.
- **WASM Component Model / WASI Preview 2:** "a component starts with **no ambient authority**
  and can only do what the host explicitly grants" — **imports *are* capabilities**. Each P2
  component carries a **WIT world** declaring every interface it imports/exports — a *typed,
  auditable* capability manifest. Note the caveat: WASM has ocap **safety** but not full ocap
  **expressiveness** (you can't freely mint/attenuate references at runtime the way E can) —
  which is exactly the gap iterate's TS-like `itx` fills in userspace.
- **Endo / Hardened JS (Agoric):** ocap *in JavaScript* — `harden()` (deep freeze), Compartments
  (no ambient authority: no `fetch`/`process`/`Date` unless passed in), used for supply-chain
  attack resistance. This is the most directly reusable body of code for iterate, since `itx` is
  a JS object handed to untrusted LLM-written JS — Compartments are the enforcement primitive
  that makes "a project-A `itx` literally cannot express a reference to project B" (D13) *true at
  the language level*, not just by convention.
- **Spritely Goblins / OCapN:** the modern CapTP successor (a `Revoker`/`Revocable` and
  `PermeableMembrane` "revocation as an effect" are shipped primitives), pushing ocap to
  distributed P2P — relevant to R11 (a processor hostable by a third party) which needs a
  wire protocol for capabilities.

**Mechanism worth borrowing:** the **caretaker/revocable-forwarder** (revocation) and
**membrane** (transitive revocation of a whole subtree) are the exact primitives D13 needs and
should be named as such in §7.5. And **Endo Compartments + `harden()`** are the concrete
enforcement for handing untrusted LLM code a big pile of capabilities safely.

**The pitfall they hit — and it's iterate's stated fear, now with a citation:** a brand-new
(June 2026) paper, *"Capability Gates Are Not Authorization: Confused-Deputy Failures in LLM
Agent Frameworks"* (arXiv 2606.28679), audits **LangChain/LangGraph, LlamaIndex, and the Stripe
Agent Toolkit** and finds all three ship the confused-deputy pattern by default: they check
**tool-name existence + schema validity** but **not the concrete argument values** against
policy. Their example: an `issue_refund` tool exists (capability ✓), amount is well-typed
(schema ✓), but destination `acct_ATTACKER_999` is never checked against the allowlist — the
prompt-injected model *becomes* the authorization boundary. **This is precisely the smell D13
warns against** ("get the reference, then check whether the holder is allowed at use time").
Their fix (**ScopeGate**: a fail-closed PDP over concrete arguments, policy never sourced from
model output) is the *ACL* answer. iterate's D13 answer is more radical: don't gate the argument
— **attenuate the capability** so `acct_ATTACKER_999` is *un-nameable* (bind the destination at
mint time). Worth noting the measured stakes: cheaper "deployment-tier" models attempt
unauthorized calls at **3.2× the rate** of flagship models (0.603 vs 0.189) — i.e. the threat
scales exactly as iterate's B1 world (many cheap autonomous agents) arrives.

The *other* pitfall — the one iterate must not trip while implementing R7/Q9 — is
**over-broad bind**: "bind an argument to narrow a capability" only narrows if the binding is an
*enforced structural constraint*, not an object-merge the callee can override. Miller's forwarder
works because the forwarder *is* the only reference Bob holds; if iterate's `bind` produces a
capability that still carries the un-narrowed original reachable underneath, it's a leak.

**Where iterate is genuinely novel vs. reinventing:**
- *Reinventing (with pedigree):* mint-time checks, attenuation, un-nameability, revocation-only
  per-use are Miller/E orthodoxy. iterate is standing on solid, formally-verified ground.
- *Genuinely different:* iterate applies ocap to **LLM-authored untrusted code as the primary
  caller** (B2) and makes the capability tree **look like ordinary TypeScript** (`itx.slack
  .postMessage()`, R7/Q9) rather than E-syntax or a WIT manifest or a nested grant array. Nobody
  in the ocap canon targets "the untrusted code is written by a model, at runtime, and must read
  like idiomatic TS." And the **two-doors** collapse (all security at project boundary +
  egress, everything else is *addressing not security*, D6) is a sharper articulation than the
  frameworks, which scatter checks.

**Borrow / Avoid / iterate is novel here:** **Borrow** the caretaker/revocable-forwarder +
membrane patterns for revocation (name them in §7.5), Endo Compartments + `harden()` as the JS
enforcement, and Cap'n Proto promise-pipelining for a fast deep `itx` tree over a hop.
**Avoid** the confused-deputy trap the entire LLM-agent-framework industry just shipped —
per-call argument gates whose policy is really "trust the model"; D13 already forbids this, keep
it forbidden. **iterate is novel** in ocap-for-LLM-authored-TS and the two-doors security
collapse; do *not* re-derive Miller's patterns from scratch.

---

## 4. Secret-substitution egress proxies

iterate's D10 is a **detokenizing egress proxy**: code sends a placeholder, the secret DO
substitutes the real value at the egress door *only if* the destination host is on the
add-time allowlist; code never sees the secret; a "secret jail" worker handles the rare
raw-access case. This is a real, shipping product category — iterate is reinventing a known
proxy, which is *good* (proven), and should copy its exact escape-hatch containment.

**How the leaders actually do it:**

- **Basis Theory Proxy (outbound / detokenize)** is a near-exact match for D10: "outbound HTTP
  requests can include **tokens** within the payload, and the proxy **detokenizes and substitutes
  the token data** into the request before forwarding to the destination... share sensitive data
  with a third party **without retrieving it on your servers**." Their placeholder is a *token*;
  iterate's is a per-secret placeholder. They also do the **inbound** direction (tokenize before
  data reaches your servers) — a mirror iterate could use for *inbound* secrets. PCI-scope
  reduction is the selling point: "card data never touches your environment."
- **Skyflow** — same tokenization-vault-as-proxy model, positioned around data residency /
  polymorphic tokens.
- **HashiCorp Vault** has two directly-relevant mechanisms:
  - **Transit engine ("encryption as a service"):** "keys **never leave Vault**; apps send
    plaintext, receive ciphertext, never touch the key." Vault *doesn't store* the data — it only
    performs the crypto op and returns the result. **This is the answer to iterate's HMAC/signing
    escape hatch** — instead of a "secret jail" that hands the raw secret to a locked-down worker,
    you can expose **`sign` / `hmac` / `encrypt` operations** against the secret DO and *never
    reveal the key at all*. Strictly stronger than a jail.
  - **Response wrapping + cubbyhole:** Vault returns a **single-use token** whose **cubbyhole**
    (per-token private store, "no other token — even root — can read another's cubbyhole") holds
    the real response; the caller does one **unwrap**. Useful pattern for *transporting* a secret
    to the one place allowed to use it with **detection of interception** (if the wrap token was
    already unwrapped, someone stole it).
- **Cloudflare Secrets Store / Worker secrets** — the substrate iterate runs on; secrets are
  injected as bindings, but *readable by the worker* (so not, by itself, D10's write-only
  property — iterate's DO-substitution is the thing that adds write-only-ness on top).

**Mechanism worth borrowing:** two concrete upgrades to D10:
1. **Vault Transit as the escape-hatch design, not a jail.** For request signing / HMAC — the
   canonical "code genuinely needs the raw secret" case D10 cites — expose **crypto operations on
   the secret DO** (`itx.secrets.foo.hmac(bytes)`, `.sign(...)`) so the raw key *never* leaves.
   The "secret jail dynamic worker" becomes the *last resort* for exotic crypto Vault-Transit
   can't express, not the default.
2. **Basis Theory's token-in-payload substitution** is the exact ergonomic to copy — placeholder
   embedded anywhere in the outbound request body/headers, substituted at the proxy — and their
   inbound direction gives iterate a symmetric "capture an incoming secret without seeing it."

**The pitfall they hit:** the **known escape hatches are all "the caller needs the raw bytes"** —
HMAC/signing (AWS SigV4, webhook signatures), where the naive design leaks the secret to compute
the signature. Vault Transit's whole existence is the industry admitting *substitution isn't
enough* — you need **operations-on-the-secret** at the boundary. Second pitfall: **the allowlist
is only as good as the host match** — SSRF-style tricks (redirects to a non-allowlisted host,
DNS rebinding, `Host`-header vs. connect-address mismatch) can smuggle a substituted secret to an
attacker; the proxy must pin the *connected* host, follow-no-redirect (or re-check on redirect),
and resolve DNS itself. Third: **placeholder collision / injection** — if the model can get a
placeholder *echoed back* into a later outbound request to a different host, substitution fires in
the wrong place; placeholders must be unguessable and single-use-scoped.

**Where iterate is genuinely novel vs. reinventing:**
- *Reinventing (well):* detokenizing egress proxy = Basis Theory/Skyflow; keys-never-leave crypto
  = Vault Transit. iterate should not pretend this is new.
- *Genuinely different:* in Basis Theory/Vault the proxy is an **external SaaS boundary** you opt
  specific fields into. In iterate it's the **only** exit (D6: `itx.fetch`'s external branch is
  *the* egress door) and it's **unified with ordinary fetch** ("just fetch", direction by
  hostname) — every outbound byte already goes through the substitution point, so there's no
  "did you remember to route this through the proxy?" gap that the SaaS products all have.
  Binding the allowlist **at secret-add time** (not per-call policy) is also more ocap-pure than
  Vault's policy-per-path model.

**Borrow / Avoid / iterate is novel here:** **Borrow** Basis Theory's token-in-payload
substitution (both directions) and, crucially, **Vault Transit's operations-on-the-secret** as
the *primary* HMAC/signing answer. **Avoid** treating the raw-secret "jail" as the default escape
hatch (it's the leak-prone one), and avoid a host allowlist that trusts the requested host over
the connected host (SSRF). **iterate is novel** in making the substitution proxy the *sole,
unavoidable* egress door unified with normal fetch, and in add-time host binding rather than
per-call policy.

---

## 5. Self-modifying / code-generating agent runtimes

iterate's D5 ("agents produce only code") + the organism rewriting its own DNA is the
**self-modifying coding agent** genre, now a live research area. The central risk iterate must
answer: an agent commits broken code that breaks the agent (self-bricking). The research
converged on **archive + sandbox-eval + rollback**, and iterate's event-sourcing gives it a
better substrate for exactly that.

**How the leaders actually do it:**

- **Pi coding agent** (Peter Steinberger / earendil-works, underpins OpenClaw) — the canonical
  "self-modifying, produces-only-code" reference iterate wants (Q13). Extensions are **TypeScript
  files auto-loaded with hot reload**; "the coding agent can be tasked with **modifying its own
  capabilities**," changes take effect **immediately without restarting the session.** This is
  *precisely* iterate's model (agent edits TS in the repo, next request served by rewritten
  code) — Pi is the closest existing artifact and the right citation for §1.1/§2.
- **SICA (Self-Improving Coding Agent, Robeyns et al., arXiv 2504.15228):** removes the
  meta-agent/target-agent split — the agent edits **its own codebase**. Reports **17% → 53% on
  SWE-Bench Verified.** Safety = **Docker sandboxing, resource/time limits, multi-metric
  evaluation, and rollback (version management)**. Implemented in plain Python, no DSL.
- **Darwin Gödel Machine (Sakana/Zhang et al., arXiv 2505.22954):** the population version —
  **maintains an *archive* of agents**, samples one, uses a foundation model to produce an
  "interesting" variant, **empirically validates each change on coding benchmarks** (not formal
  proofs — the "Darwinian" relaxation of Schmidhuber's provable Gödel Machine). **20% → 50% on
  SWE-bench, 14.2% → 30.7% on Polyglot.** Safety: **all self-modification in isolated sandboxes,
  strict per-execution time limits, human oversight.** The archive is the anti-bricking device:
  a bad mutation just doesn't get selected; you never lose the good ancestors.
- **Cognition / Devin:** productized autonomous SWE; the self-bricking analogue is guarded
  operationally (a Devin edits a *target* repo, not its own runtime), so the safety story is
  sandboxed VMs + human PR review rather than self-referential archives.
- **The deployment-safety analogue (Cloudflare Workers, below in §6):** **versions +
  gradual/canary deploy + instant rollback + version affinity** is the *infrastructure* answer to
  "don't let a bad version take down everyone."

**Mechanism worth borrowing:** the **archive-of-versions + sandbox-eval-before-promote + rollback**
loop (SICA/DGM) maps perfectly onto iterate: the **git repo is already the archive** (every commit
is a candidate genome), and **canary/shadow-eval** should gate promotion of an
agent-authored commit before it serves live traffic. Specifically: run the new config-worker
version against a **shadow of recent real events** (iterate has the stream — it can *replay*),
compare outcomes, and only then flip the deployment.

**The pitfall they hit:** **empirical validation is only as good as the benchmark** — DGM
explicitly warns its improvements are *toward the benchmark*, and an agent optimizing a proxy
metric can regress real behavior (reward-hacking / Goodhart). Second: **the eval harness itself is
part of the mutable surface** — if the agent can edit its own tests/eval, it can "pass" by
weakening the check (DGM/SICA keep the eval *outside* the mutable agent; iterate must keep the
promotion gate in the **kernel**, un-editable in userspace, per D2). Third: **hot-reload
self-modification (Pi) has no gate at all** — immediate effect is great for iteration, lethal for
a load-bearing organism; a syntax error in the reloaded file bricks the session.

**Where iterate is genuinely novel vs. reinventing:**
- *Reinventing (and should cite):* self-editing agent = Pi/SICA/DGM. Cite Pi as the named
  reference (resolves Q13).
- *Genuinely different:* the self-improving-agent papers rebuild state from scratch each
  generation and eval on *fixed benchmarks*. iterate self-modifies against a **live stream of
  real-world events it can replay** — so its "eval" is *shadow-replay of actual recent history*,
  not a synthetic benchmark, which is a strictly better Goodhart defense **if the promotion gate
  is kernel-enforced.** And iterate's **total observability + replay** (R5, everything is a
  stream) means a bad self-edit is not just rolled back but **forensically diagnosable** — you can
  see exactly which event the rewritten code mishandled. No self-improving-agent system has that.

**Borrow / Avoid / iterate is novel here:** **Borrow** SICA/DGM's archive + sandbox-eval +
rollback, and cite **Pi** as the produces-only-code reference (Q13). **Avoid** Pi-style ungated
hot-reload for the *config worker itself* (fine for a scratch script, self-bricking for the
organism) and **avoid letting userspace edit its own promotion gate** — keep the canary/shadow-eval
gate in the kernel (D2). **iterate is novel** in shadow-replaying *real recorded events* as the
promotion eval (vs. fixed benchmarks) and in full-replay forensics of a bad self-edit.

---

## 6. Fleet updates without rebasing every repo

iterate's Q8: don't rebase a million project repos to ship a platform update — publish a version,
let each project **follow a channel or pin** (the apt / App Store model). This is entirely
solved prior art; iterate just needs to pick the layer-by-layer policy.

**How the leaders actually do it:**

- **apt (Debian):** **channels** — `stable` / `testing` / `unstable` labels that always point at
  the current release for that label — plus **pinning** (`apt_preferences` priorities) to hold a
  stable base while cherry-picking newer versions of specific packages. The exact "follow a
  channel *or* pin" duality iterate wants.
- **npm + SemVer + lockfile:** the **caret `^`** range (default) = "auto-take minor/patch, never
  a breaking major"; the **`package-lock.json`** records the *exact* resolved version so the whole
  fleet is reproducible even under a range. The two-layer split — **declared range** (follow) vs.
  **lockfile** (pin) — is the cleanest model for iterate: a project *declares* a channel/range in
  its config repo, a **lock** captures what's actually running, and updates are a lockfile bump.
- **App Store / Play phased rollout:** **Apple Phased Release** ≈ 1/2/5/10/20/50/100% over **7
  days** for auto-update users; **Google Play staged rollout** ≈ 1–5% day 1 → 10% → 50% → 100%
  gated on **crash-free-session** health. Percentage-of-installs + health-gated promotion —
  the fleet-scale canary.
- **Config management (Chef/Puppet/Ansible):** push desired-state to N machines; **convergence**
  + **environments/branches** (Chef environments pin cookbook versions per environment). Relevant
  to iterate's "reconcile world to reduced state" framing.
- **Feature-flag platforms (LaunchDarkly etc.):** **decouple deploy from release** — code ships
  dark, a flag flips it on for a %/segment. This is the *userspace* fleet-update lever: iterate
  could ship a platform capability behind a flag each project opts into on its own schedule.
- **Cloudflare gradual deployments** (iterate's own substrate): a deployment references **one
  version at 100% or two versions split by %**; **version affinity** routes a given
  user/session consistently to one version (avoids **version skew** — two incompatible versions
  serving the same user); **rollback** = flip 100% to a prior version. **Caveat straight from
  the docs:** you *cannot* roll back across a KV/D1 schema change — **stateful resources break
  rollback.** This is the sharpest warning for iterate: a platform update that migrates stream
  schema or DO state is *not* cheaply reversible.

**Mechanism worth borrowing:** the **npm declared-range + lockfile** two-layer split is the
model — each project's config repo *declares* which channel of the kernel/first-party modules it
follows; a lock records the exact version running; a fleet update is a **channel publish** that
projects pick up by lockfile bump (auto on their cadence, or pinned). Layer it: **kernel** =
tightly-controlled channel with **Cloudflare-gradual-deploy %-rollout + health gate** (App Store
model); **first-party modules** = SemVer channels projects follow; **userspace leaf extensions** =
the project owns entirely (never pushed). Use **version affinity** to avoid skew when a project
straddles versions mid-rollout.

**The pitfall they hit:** **version skew** (Cloudflare's named hazard) — during a %-rollout two
incompatible versions serve the same entity; the fix is *affinity* (pin an entity to one version
for the rollout). And the **stateful-rollback wall** — apt/npm rollbacks are clean because
packages are stateless; the moment an update **migrates persistent state** (KV/D1 schema, or in
iterate's case **stream/reduced-state schema or DO state**), rollback stops being free. Third:
**channel drift** — a fleet where everyone auto-follows `stable` moves together (good for
security fixes, bad if `stable` regresses); Debian's own docs call always-tracking-the-label
"bad practice" for exactly this.

**Where iterate is genuinely novel vs. reinventing:**
- *Reinventing (fine):* channels/pinning/phased-rollout/flags are 30-year-old solved problems.
  iterate should copy apt+npm+App-Store wholesale, not invent a scheme.
- *Genuinely different:* in apt/npm the unit is a **package installed into a passive host**. In
  iterate the unit is a **self-modifying organism whose code is itself LLM-authored** — so a
  "fleet update" competes with the project's *own* rewrites of the same files. The novel question
  (not really answered by prior art) is **merge/precedence between a platform channel update and
  a project's self-authored divergence** — closer to a *git rebase/merge across a fleet of
  actively-edited branches* than to `apt upgrade`. That's the genuinely new problem, and it's
  worth flagging that no package manager solves "the installs edit themselves."

**Borrow / Avoid / iterate is novel here:** **Borrow** apt channels+pinning, npm range+lockfile
two-layer split, App-Store health-gated phased rollout, and Cloudflare gradual-deploy + version
affinity — layered by kernel/first-party/userspace. **Avoid** cross-fleet rollback that spans a
stream/DO **schema migration** (Cloudflare's own "can't roll back across KV/D1 changes" wall) and
always-track-`stable` channel drift. **iterate is novel** in that the installs **self-edit**, so
fleet updates are a *merge across actively-diverging branches*, not a package upgrade — a problem
no package manager solves and iterate must design deliberately.

---

## Sharpest 8 interview questions this research suggests

1. **(Restate / stateful vs. stateless)** Restate holds journal+state in its server and pushes to
   stateless handlers with a per-key single-writer lock — architecturally identical to your
   "DO is the ordering point, worker is stateless." So what does iterate gain by *not* being
   Restate? Concretely: when a stream has 10M events, does `processEvent` re-reduce from zero, and
   if not, where does the reduced-state snapshot + covered-offset live — and is that not just
   Kafka's checkpoint file with a warm standby?

2. **(Azure Durable Functions / determinism)** Durable Functions and Temporal pay full
   deterministic replay of a call stack on every activation and forbid `Date.now()`/random in the
   orchestrator. iterate claims to sidestep this by re-reducing fresh state instead of replaying a
   call stack. But an agent-as-processor *does* have long-running LLM-request state in flight
   across wakes — how is that not a suspended call stack, and what stops a non-deterministic
   `reduce` from silently corrupting reduced state the way a stray `Date.now()` corrupts a Durable
   Functions replay?

3. **(Temporal Activities / outbox)** Your `requested → completed{outcome}` pair is the transactional
   outbox + Temporal at-least-once activity. Temporal's hard-won lesson is the idempotency key must
   ride *into the external call itself* (Stripe `Idempotency-Key`), not just internal dedup, because
   the dedup window (24–72h) expires. When wake re-drives an open obligation whose external effect
   half-succeeded 80 hours ago, what prevents the double-charge — and is that mechanism in the
   kernel or left to userspace?

4. **(LangChain/Stripe Agent Toolkit / confused deputy)** The June 2026 "Capability Gates Are Not
   Authorization" paper shows LangChain, LlamaIndex, and Stripe's Agent Toolkit all ship the
   confused-deputy bug — they check tool-name + schema but not the concrete `destination_account`
   argument — and that cheap models attempt unauthorized calls 3.2× more than flagship ones. D13
   says the fix is attenuation (make `acct_ATTACKER_999` un-nameable), not an argument gate. Walk
   through `itx.payments.refund(...)`: at *mint time*, how is the allowed destination structurally
   bound so the model literally cannot express the attacker's account — and doesn't that binding
   have to come from *somewhere* the prompt-injected model doesn't control?

5. **(Endo/Agoric Hardened JS / enforcement)** D13 says a project-A `itx` "literally cannot express"
   a reference to project B — but you're handing a plain JS object to untrusted LLM-authored JS on
   Workers. Agoric had to build Hardened JS (`harden()`, Compartments, no ambient `fetch`/`Date`)
   to make that true at the language level. Are you running LLM code in a Compartment/SES-equivalent,
   and if not, what stops the model's code from reaching ambient authority (global `fetch`,
   prototype pollution) and going *around* `itx` entirely?

6. **(Vault Transit / secret escape hatch)** D10's raw-secret escape hatch is a "secret jail"
   worker that gets the plaintext key. Vault's entire Transit engine exists because the industry
   decided that's the leak-prone answer — instead you expose `hmac`/`sign`/`encrypt` *operations* so
   the key never leaves. Why is iterate's default a jail-that-sees-the-key rather than
   operations-on-the-secret at the egress DO — and for the SSRF vector, does the allowlist pin the
   *connected* host (post-DNS, post-redirect) or the *requested* host?

7. **(Darwin Gödel Machine / self-bricking)** DGM and SICA prevent self-bricking with an
   *archive of prior versions* + *sandbox-eval on a benchmark held outside the mutable agent* +
   *rollback*, and DGM warns the agent optimizes *toward the benchmark* (Goodhart). Your git repo is
   the archive and you can shadow-replay real events instead of a synthetic benchmark — but what
   keeps a self-editing organism from *also editing its own promotion/canary gate*? Is that gate in
   the un-editable kernel (D2), and can you show the exact boundary where userspace stops and the
   gate begins?

8. **(Cloudflare gradual deploys + npm lockfile / fleet update)** Cloudflare's own docs say you
   *cannot roll back a Worker across a KV/D1 schema change*, and version skew forces version
   affinity. When a kernel update migrates stream or reduced-state schema across a million
   self-editing projects, you have (a) an irreversible-rollback wall and (b) each project's *own*
   LLM-authored edits to the same surface — which is a git *merge across a million actively-diverging
   branches*, not `apt upgrade`. What is the precedence rule when a platform channel bump and a
   project's self-rewrite touch the same file, and how do you roll back the ones where the migration
   already ran?
