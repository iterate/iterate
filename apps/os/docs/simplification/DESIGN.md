# iterate — the design document (living)

> **What this is.** A small, load-bearing document we build from scratch and grow
> deliberately. The old exploration pile (`index.html`, `simplification-*.md`, the
> lenses, the vote) is on the shelf — we drag things *out* of it and *into here*
> only once we believe them.
>
> **How it works (the diffusion).** Everything starts life at the bottom, in **Open
> questions**. As we resolve something, it moves *up* into a **Belief**, a
> **Requirement**, or a **Decision**. Resolved *terms* move into the **Taxonomy**
> (§6) — our canonical glossary: one word per concept, rejected synonyms listed as
> _Avoid_. Nothing is locked until it's in one of those sections. Items have stable
> IDs (B1, R1, D1, Q1…) so we can point at them.
>
> **The three buckets, kept separate on purpose:**
> - **Belief** — a claim about the *world or the future* that motivates the design.
>   Could turn out wrong. ("AI will be smarter than us soon.")
> - **Requirement** — a constraint the system *must* satisfy. ("A user can work on
>   many repos at once.")
> - **Decision** — a design choice we're *locking in*. ("Trust is binary: inside
>   the project vs outside.")
>
> Status tags on individual lines: **[LOCKED]** we're sure · **[PROPOSED]** leaning
> yes, not confirmed · **[OPEN]** still arguing.

---

## 1. What this is (the high-level description)

_The tip of the pyramid. Must pass the Paul-Graham test: a smart outsider gets it
in one read. Structure: two prose paragraphs → the primitives → a worked example.
(Noun locked: **digital organism**.)_

An **iterate project is a self-improving digital organism.** It can do **anything a
human with an internet-connected computer can do — and it gets better over time.** It
might be a **company**, a **personal assistant**, or a **co-worker**.

The simplest way to picture it is as a **web server.** HTTP requests come in from the
outside world, and in response it does three things: **updates its own state, sends
HTTP responses, and makes its own outbound HTTP requests.** That is the entire
surface — **HTTP out is the only way it can influence the world.**

What the web server actually runs is **TypeScript, executed in the context of the
project.** That TypeScript comes from one of two places: it is **stored in the
project's git repo**, or it is **written on the fly by an LLM.** Either way it is
ordinary code doing ordinary work — read the request, change some state, maybe call
out, reply.

That git repo is the organism's **self-editing DNA.** It is the source code that
defines how the organism behaves — and the organism **rewrites its own DNA to get
better:** the LLMs read what is happening in the world and edit the code, so the
behavior improves over time. This is deliberate: iterate is built so that **any and
every behavior can be defined here, in userspace** — there is almost nothing the git
repo isn't in charge of, save a small fixed kernel. Configuration is not a settings
file; it is a program the organism keeps rewriting.

All of this code is written the **same way, everywhere** — the git-repo code, an
agent's on-the-fly script, even the browser UI — as a function of **one project
object, `itx`**, through which it reaches everything the project can do: its state,
its tools, its secrets, the outside world. Platform code and the organism's own code
are written identically.

One level down sits the substrate that makes all this durable: the organism's state
and its internal messaging are **append-only event streams**, and **stream
processors** fold those events into state and react to them. Streams are both its
memory and how its parts talk to each other — but you rarely think about them up here;
what matters is that behavior is **code the organism writes.**

### A worked example (a SaaS company)

Suppose the organism *is* a SaaS company, and its website lives in its git repo. A
customer emails support to complain about a bug — that email arrives as an **HTTP
request** (a webhook). The **TypeScript** in the git repo routes it to an **agent**,
which pings the founder on Slack, **edits the website's TypeScript in the git repo** to
fix the bug, and **emails the customer** back to say it's fixed. The customer's next
request to the site is served by the **rewritten code**. HTTP in; the organism changed
its own DNA; HTTP out.

### The anatomy of a project

_The whole programmable surface of a project is **two functions** — the crisp version
to hold in your head:_

- **`fetch(request)` — the synchronous face.** The request comes from the **untrusted
  internet.** It passes through the platform (which adds a few headers for your
  convenience — the resolved project, auth context), but the request itself is
  untrusted. You return a response.
- **`processEvent(event)` — the reactive face.** It is invoked for **every
  default-delivery event on every stream in the project** — the events broadcast to all
  subscribers, as opposed to opt-in high-frequency lanes ([[D11]]). (Audio frames and
  live tokens ride opt-in lanes and aren't pushed here unless a processor explicitly
  subscribes — so it isn't a firehose.)
  This is your mechanism to do **almost anything:** watch everything that happens
  anywhere in the organism, and react.

Everything else — agents, integrations, the dashboard, workflows — is built out of
those two functions plus the streams they read and write. ([[D4]] locks the pair;
[[R13]] keeps `fetch` stateless.)

---

## 2. What makes it different

_Given the primitives (§1), why this is not just "a web app" or "an agent framework":_

- **You never configure it — you change its code, and it changes its own.** Behavior
  is determined *entirely* by the config repo; there's nothing it isn't involved in,
  except the small kernel. It's all userspace ([[D2]], [[D4]]).
- **Agents produce code and consume events** — not tool-calls and tool-results. A
  webhook is barely transcribed; the agent just cares that *something happened* and
  writes code to handle it. _(ref: PI coding agent, [[Q13]].)_
- **Everything is a stream, so everything is observable** — and replayable. Anything
  that goes wrong is visible after the fact.
- **The kernel is tiny; the organism is userspace.** All the interesting behavior
  lives on top of a small, fixed core ([[D2]]).

_Rejected words: "fenced-off computer", "intelligent entity runtime" (mean nothing to
an outsider); don't open with "it's basically a web app" (undersells self-improvement)._

---

## 3. Beliefs

- **B1 [LOCKED].** AI models will soon be more capable than humans at the work these
  organisms do. We build for that world, not today's.
- **B2 [LOCKED].** The **primary user of the system's API is an LLM**, not a human.
  Legibility-to-a-model is a first-class goal (usually the same as legibility-to-a-
  human).
- **B3 [LOCKED].** Software will increasingly be **written and continuously rewritten
  by AI** — so we optimize the substrate for **AI-authored, self-modifying code**,
  not for humans hand-writing it.
- **B4 [LOCKED]. Verification flips.** As AI outpaces us, observability exists for
  **audit and for the AI itself** — not for a human to sign off on each action. We do
  not assume a human must approve what the AI does; over time the reverse may hold.
- **B5 [LOCKED]. The spend ceiling is a human-world input.** How much money I'm willing to
  let this thing spend — **implicitly** (LLM / inference) and **explicitly** (virtual
  payment cards, third-party services, infrastructure) — is a **key input that comes from
  the human world**, not something the organism sets for itself. (Motivates [[R14]],
  [[D14]].)

_(Deleted as not-meaningful-enough: "orgs are event-processing systems"; "an economy
of entities"; the old "humans need proof" — subsumed by B4.)_

### Working assumptions

_Things we believe are **probably true** and will act as-if — but we **won't build
against them** (fallbacks, extra machinery) unless we're really forced to._

- **WA1 [ASSUMPTION].** Within a project there probably **don't need to be different
  levels of authentication or authorization.** If multiple humans work in one project
  in the future, they'll more likely all get the **same access the AI has** — because
  internal authz checks tie you in knots and are genuinely hard. This is the belief
  under [[D1]]: we build binary trust precisely because internal authz is probably
  *unnecessary* **and** definitely *painful*.
- **WA2 [ASSUMPTION].** **Prompt-injection is solved with more AI, not more
  human-in-the-loop.** For the few actions that legally require a human, we need a
  **cryptographically verified human-approval** path (secure enclave / attestation —
  [[Q15]]). For everything else, **AI is the guardrail** — and in the not-so-distant
  future even *human* actions will require **AI approval**, not the reverse.

---

## 4. Requirements

_These are things that must be **possible in the future** — **not day-one features.**
The design must not foreclose them; we don't have to ship them now._

- **R1 [LOCKED].** **One project can never access another project.** This is the one
  hard boundary the whole trust model rests on (see [[D1]]).
- **R2 [LOCKED].** **Secrets must never enter code that could exfiltrate them.** The
  only thing that ultimately matters, security-wise, is bytes leaving the project.
- **R3 [LOCKED].** A user must be able to **work on many repos together** in one
  project. (Still open: do those other repos need our "repo" abstraction at all, or is
  it fine to just use GitHub + octokit like a normal person? → [[Q6]].)
- **R4 [LOCKED].** The event/stream substrate must be **fast enough to carry
  real-time voice (PCM audio)** — decisions/transcripts are durable facts; raw audio
  is a live lane, not stored history.
- **R5 [LOCKED].** **Everything is traceable.** You can always see exactly what
  happened and why. This is a primary reason the substrate is a log, not a
  by-product.
- **R6 [LOCKED].** **Assume any part can fail at any moment and recover uniformly.**
  Idempotency keys on side effects; processors survive infrastructure eviction and
  heal on wake.
- **R7 [LOCKED].** The capability / grant / expression surface should **look like
  TypeScript** (you write `itx.slack.postMessage(...)`, not a nested array). → [[Q9]].
- **R10 [LOCKED].** An organism's **full durable state must be exportable** — its
  streams, its git repo, and its referenced blobs. And it must stay **possible (not
  ruled out) for a project to run on its own dedicated deployment** — e.g. its own
  Cloudflare account, via Workers for Platforms or a direct Workers deployment.
  **Deployment is a placement choice, not an architectural one:** the general
  architecture must be identical regardless of where or how a project runs.
  _Spend containment is a second reason to want this: a project with its **own
  third-party API keys** (own limits) and potentially its **own Cloudflare account**
  (Cloudflare now allows programmatic account creation) lets even inference and infra
  spend be **bottled up and capped per project** — see [[R14]], [[D14]]._
- **R11 [LOCKED].** A **stream processor must be hostable anywhere — including by a
  third party.** Any coding agent (Claude, Codex, Pi, …) is a stateful stream
  processor: it subscribes to a stream, keeps its own state, and appends events back.
  The stream↔processor contract must stay clean enough that a third party could host
  one. (Server-side mirror of [[D8]].)
- **R12 [LOCKED].** The **agent system must allow many LLM requests in flight at the
  same time** — concurrency is a first-class requirement, not a later optimization.
- **R13 [LOCKED].** **Ingress is served by the stateless worker entry point, never the
  project durable object.** An external request lands on a stateless worker that
  resolves hostname → project, mints an `itx`, and calls the config worker's `fetch` —
  so HTTP scales horizontally like any web app; the DO/streams are touched only when a
  handler chooses to read or write durable state ([[D4]]).
- **R14 [LOCKED]. Spend must be uniformly tracked and haltable.** Because spend is
  incurred inside the project **and in third-party systems**, the design needs a **uniform
  money-spent primitive** — a spend/cost event that can ride **any stream**, carries
  **tags**, and is **aggregated at multiple levels** — plus a way to **cap** spend and to
  **halt everything** (a kill switch). A big, currently-missing primitive. _(Mechanics —
  the event shape, aggregation levels, kill-switch — are pinned for the detailed design;
  see the pin under [[D14]]. Belief behind it: [[B5]].)_
  **Transitive:** spend limits **nest** — you can hand an agent a **sub-budget** ("spend up
  to $20 on this, then come back to me if you haven't solved it") that **pauses and reports
  back** when exhausted, rather than failing silently.

_(Former R8 "everything expressible in userspace" folded into [[D2]]. R9
"replay-from-streams" rejected — durable state also lives in git ([[D9]]).)_

---

## 5. Decisions

_Grouped by what they're about. Domain-specific decisions (streams, secrets, …) will
eventually migrate under their **core domain object** in the architecture (§7); for
now they're gathered here._

### Foundational (whole-system)

- **D1 [LOCKED]. One trust boundary — the project edge.** Inside a project,
  everything and everyone (human or AI) is **fully trusted and sees the same things**
  — no internal access levels, no per-person permissions. The **only** boundary is
  between a project and everything outside it. A hard line that deliberately **rules
  out customers** who need tiered internal access.
  _Why: the users here are AIs more capable than us, not employees at access levels
  ([[B1]], [[B4]]); any line drawn inside a project is both incoherent for that world
  and a huge source of complexity._ _(Name still workshoppable — want something more
  self-explanatory than "binary trust".)_
- **D2 [LOCKED]. Everything except a tiny kernel is overridable in userspace.** A
  project's behavior is defined in its config repo; there is almost nothing the
  platform does that a project can't override in userspace — except a small fixed
  **kernel** (the things that genuinely *cannot* be expressed in userspace, plus two
  or three so essential we keep them in anyway). We call it the **kernel** (or core),
  never "seed". → [[Q7]] (what the non-kernel layer is called).
- **D6 [LOCKED]. The only real security is at the network egress door.** To the
  extent security matters in this future, it lives where **bytes leave the project** —
  not in enterprise-IT-style internal access controls. ([[R1]], [[R2]] reduce to this.)
  _Clarification: the capability tree (`itx`) is **addressing**, not security — it's
  how code reaches what it can do (`itx.slack.postMessage(...)`), not a set of access
  checks. Security lives in exactly **two** places: the **project boundary** (checked
  once, at authenticate — [[D1]], [[R1]]) and the **egress door** (here + [[D10]]).
  That's why untrusted, LLM-written code can be handed a big pile of capabilities
  freely: none of them let it escape the project or reveal a secret except through the
  one gated door — which is itself just one leaf of the tree (`itx.egress`). The "just
  fetch" idea (unifying the inbound + outbound HTTP lanes) is a separate plumbing
  convenience, not a security change._
- **D13 [LOCKED]. Security is object-capability, not access-control-lists.** Authority
  is **what you hold**, not **who you are**: an `itx` (and every reference reachable
  through it) is an unforgeable handle that both *names* a thing and *carries* the
  right to use it. There is **no per-use permission check** — if you can call it,
  you're allowed. Checks happen at **mint time**, not use time: `authenticate()` is
  the one identity→capability conversion, and `session.projects.get("prj_x")` asserts
  your claims cover the project **before** handing back the itx. Confinement is
  **structural, not guarded** — a project-A itx literally cannot *express* a reference
  to project B, so there is nothing to check ([[R1]] by construction). The smell to
  avoid: "get the reference, then check whether the holder is allowed" at *use* time —
  that's an ACL leaking into a capability system. The fixes are always (1) move the
  check to **mint time**, (2) **attenuate instead of check** (hand out a narrower
  capability that structurally can't do the forbidden thing — bind-as-attenuation,
  [[R7]]), or (3) make the forbidden thing **un-nameable**. The only legitimate per-use
  check is **revocation** (is this capability still valid?) — about the capability,
  not the holder.
- **D14 [LOCKED]. A small protected control plane (the "membrane") lives outside
  userspace — the one deliberate exception to [[D2]].** A self-editing organism has no
  floor unless a *tiny* part of it is un-editable by its own code. That part is held by
  the **platform, not the organism**, requires **human sign-off to change**, and is what
  lets everything **grind to a halt**. It holds exactly four kinds of thing, and nothing
  else:
  1. **The promotion / rollback gate** on the "which version of me is live" pointer.
     Code may be *written* freely (userspace); making it *live* — merge/push to the
     artifact's main — passes a gate the live code can't rewrite, so a bad commit is
     always rollback-able. Shaped like a **GitHub pull-request review**.
  2. **Spend controls** ([[B5]], [[R14]]) — caps and a kill switch on money the organism
     can spend, implicitly (LLM requests) and explicitly (virtual cards, third parties,
     infra).
  3. **Cryptographic human-approval** ([[Q15]], [[WA2]]) — secure-enclave proof that a
     real human approved. Gates the few high-stakes acts: promotion (above) and
     high-risk egress (e.g. a large Stripe refund) via egress policy ([[D10]]). Taken
     very seriously; **used rarely**.
  4. **Runaway / loop controls** — loop detection and similar, which also require human
     sign-off to change.
  _Does **not** contradict [[B4]]: the default is still "AI doesn't need a human to sign
  off." The membrane is the deliberate, minimal minority — for legal need and for not
  burning the house down. Name still open (membrane / control plane / guardrails /
  constitution)._ _Pin (detailed design, not now): the money-spent event shape, its
  multi-level aggregation, and the kill-switch mechanics ([[R14]])._
- **D15 [LOCKED]. The egress door is a programmable man-in-the-middle SSL proxy — the
  project boundary made physical.** At the network level there must be **no way to reach
  the internet without passing through our gate**. What enforces it is a **programmable
  egress proxy** doing **full man-in-the-middle SSL**, so all outbound bytes are visible
  and controllable at the boundary. Think **draconian enterprise security**: it can log,
  capture and store all egress, filter, data-mine, and do **data-loss prevention** — all
  at the edge of a project. This is the mechanism *behind* [[D6]], and it's where [[D10]]
  substitutes secrets (the agent sends a placeholder; the proxy injects the real secret at
  the door). It answers "what forces code through the one door?": nothing *asks* it to —
  there is structurally **no other exit**.
  - **Code runs sandboxed.** The organism's own code runs in a **sandbox** — on Cloudflare
    a **dynamic worker**, or a **VM / Cloudflare container with egress interception** —
    never a process with an un-intercepted network. The confinement is **structural** and
    a **kernel** concern (userspace can't edit the walls of its own box).
  - **Forced routing (Cloudflare):** even general-purpose sandboxes / containers **force
    their egress through the container Durable Object**, whose `fetch` is the MITM proxy,
    so a sandbox can't go around it. _(This rules out some things — e.g. strict cert
    pinning — accepted.)_
  - **Borrowed machines too:** when a capability lends a real machine to the project
    (e.g. Jonas's Mac), that machine's egress is likewise forced through the gate. No
    un-proxied path out, from anywhere.

### Streams & events

- **D3 [LOCKED]. We are event-sourcing purists.** The organism's runtime state is
  derived by reducing event streams (its *code* lives in git — [[D9]]), and mechanisms
  are expressed as **events on the normal path**, not special-case hooks (waking is a
  `stream/woken` event, not a `reconcile` method — [[Q2]]). We hold the line even when
  it looks inefficient.
  _Concrete example: the **only** way a stream processor can react to events in two
  different streams is to **cross-post** one stream's events onto the other. It looks
  inefficient — and it's actually really useful._
- **D7 [LOCKED]. One stream + stream-processor abstraction does everything.** A single
  abstraction is our **primary database, our persistent task queue, our workflow
  engine, and our live-streaming infrastructure** — four systems collapsed into one.
- **D8 [LOCKED]. One universal event interface — interact with anything, from
  anything.** The organism reaches the world through any channel (email, Slack, voice,
  …), and **many channels and many people can share one stream** — that's fine. And
  you interact with the organism however you like: your **own agent loop over its MCP
  server**, a **voice agent**, **using it as a tool**, or its **built-in agent**. It
  all reduces to the same thing — **events entering the one project-wide event loop.**
- **D9 [LOCKED]. Events are small and reference bigger durable objects.** An event may
  carry a **commit hash** or a **file-object reference** that resolves out-of-band into
  something larger. So durable state lives in **two stores**: the **event streams**
  (the organism's memory) and the **git repo** (its code / DNA) — **not every git
  commit is a stream event.** _(This is why "replay everything from streams alone" —
  the rejected R9 — is wrong: you replay streams **and** resolve their references into
  git and blobs.)_
- **D11 [REVISED → explicit dimensions; TTL deferred]. An event isn't a durable/
  ephemeral *type*.** "Ephemeral" is a **colloquial label** for a combination of a few
  **explicit, orthogonal** properties. Preference: model each property **explicitly**,
  rather than a wishy-washy "ephemeral" type or *deriving* one property from another.
  1. **Included-by-default on subscriptions? (delivery)** — most events are delivered to
     all subscribers by default. High-frequency lanes (audio PCM chunks, streaming LLM
     tokens) are **excluded by default from *both* push and pull subscribers** (and from
     a live `waitFor`); a subscriber gets them only by **explicitly opting in**, using
     the **same signature as `subscribe`**. _Why: a quick `itx.subscribe` in a script
     must not suddenly be flooded with chunk spam — opt-in is least-tedious._
     **(The dimension that actually matters right now.)**
  2. **Side effects allowed?** — modelled **explicitly** (e.g. `sideEffects: "disallow"`),
     **not derived from TTL.** Deriving "this doesn't run through `processEvent`" from a
     TTL number violates the **principle of least surprise**; an explicit flag is
     obvious. _(Leaning explicit; likely a formal dimension.)_
  3. **TTL** — `null` / `undefined` = **forever**; `0` = **deletable ~immediately** (for
     now just a *signal* of the event's real nature; actual deletion **not implemented**).
     This is the real property "ephemeral" was gesturing at. _(Concept set; mechanics
     **deferred to the detailed stream design** — pin in [[Q16]]; connects to future
     **R2 offload** for streams past the ~10 GB SQLite limit.)_

  So **"ephemeral" ≈ excluded-by-default + short/zero TTL + no side effects** — a
  colloquial combination, never a first-class kind. What it still preserves: a firehose
  lane for live voice / tokens ([[R4]], [[D7]]) that doesn't flood ordinary subscribers,
  and the rule that **durable truth is always its own durable append.**
  _(Supersedes "events are durable or ephemeral"; refines the earlier 3-knob draft —
  side-effects is now explicit, not derived. — Jonas, 2026-07-15.)_
- **D12 [LOCKED]. Capture verbatim, transform by appending — middleware is append +
  react.** Raw ingress is recorded as a **sacred, never-mutated fact**; the normalized
  or routed version is a **separate appended fact next to it** (normalize / enrich /
  route / drop = append the transformed version, or simply don't forward it onward). A
  chain of append+react **is** a middleware system, with no middleware machinery. Two
  kinds: **`fetch` middleware** is synchronous and *in-path* (transform request →
  response, can short-circuit — like Express/Hono); **event middleware** is
  *post-commit reaction* (the fact lands first; you can only react by appending, never
  rewrite it). **Pre-commit rejection stays kernel** — only the inline core processor
  may reject a malformed or paused append; userspace middleware is always the
  post-commit reaction chain. This preserves [[D3]] purism (the raw fact is *always*
  recorded), journal sovereignty (an append can't be blocked by user code), and
  stateless scaling (userspace off the commit hot path).
- **D16 [LOCKED]. The stream substrate has exactly two primitives — `append` and
  `processEvent` — and everything else is an optimisation over them.**
  - **`append`** — submit an **event input** (not an event directly); it is durably
    recorded as an event, and `append` returns once that's done (the wait is inherent —
    [[D4]]). The event input may carry an optional **offset precondition**: "append this
    **only if the stream hasn't moved** past this offset." That optional compare-and-swap
    is what lets the *same* log be a **task queue** (claim a job = conditional-append a
    `claimed` fact; exactly one wins) and a **database** (sell the last ticket = append
    conditional on the current stock offset).
  - **`processEvent`** — the read/react side: you are invoked for **every event on a
    stream from a starting offset**, and checking each event is how you reduce, react, or
    wait. This is the "consume a stream and check every event" operation — but we call it
    **`processEvent`** everywhere, *never* "consume." A third-party processor ([[R11]])
    does the same thing by processing the stream itself.
  - Everything else is convenience or performance on top:
    - **`waitFor(namedEvent)`** = process events from now and stop when the named one
      appears (optional timeout). Sugar, not a primitive.
    - **Server-side filters** (JSONata, a discrete type filter) = a **speed** optimisation
      over receiving everything and checking client-side; *logically identical*.
  - So "do you wait for the reaction?" **just depends** — you may process until the outcome
    appears, or not; nothing forces the log or the worker to block. (Resolves [[Q5]].)

### Config & code

- **D4 [LOCKED]. The config repo is a git repo, and the config worker is exactly two
  handlers: `fetch` and `processEvent`.** The primary configuration is a git repo in
  the form of a **Cloudflare Worker** (the "config repo") — configuration is **code**,
  not a settings file. The worker has two senses, mirroring a Cloudflare Worker:
  **`fetch(request)`** for synchronous HTTP, and **`processEvent(event)`** for
  asynchronous reactions to durable facts. **You (a caller) call `{ append, fetch }`;
  the worker implements `{ processEvent, fetch }`.** `append` is the write primitive
  ("put this exact fact on this stream" — sacred, never mutated); after a fact is
  appended, the platform wakes the worker's `processEvent`, which reacts by appending
  more facts. `fetch` is shared (synchronous request/response). `itx` is the plumbing
  around the worker's behavior: `itx.fetch` adds hostname routing + egress policy
  (secrets, allowlist, human-in-the-loop) around the worker's `fetch`; the append lane
  adds provenance + waking subscribers. Config worker provides the *behavior*; the
  platform provides the *plumbing*.
  - **One fetch, direction by hostname ("just fetch" — ADOPTED).** `itx.fetch` is the
    single HTTP verb: an internal name routes *into* the project; an external name goes
    *out* through the egress door ([[D6]], [[D10]]). The separate `egress` member of
    the tree **collapses into `itx.fetch`.** An edge request and internal
    `itx.fetch("http://self.iterate/…")` are the **same code path**.
  - **The asymmetry:** `fetch` is fully **stateless** — it touches the DO/streams only
    if the handler chooses to read or write durable state. The event side has a
    durability point: `append(e)` writes `e` to its stream **through the stream DO**
    (the ordering point and the record) **first**, and only **then** does the platform
    wake the worker's `processEvent`, which runs statelessly. Compute is stateless; the
    DO is the ordering point, never the HTTP hot path.
- **D5 [LOCKED]. Agents produce only code.** No traditional tool-calling — an agent
  responds to events by writing a script that runs.

### Secrets

- **D10 [LOCKED]. Secrets are write-only and never revealed.** A secret can only ever
  be sent to the **host(s) declared when it was added** (an egress allowlist bound at
  creation time). Code uses a secret by putting a **placeholder** in an outbound
  request and fetching **through the secret's durable object**, which substitutes the
  real value for the placeholder at the egress door — and only if the destination host
  is on the allowlist. The code never sees the secret. **Escape hatch:** if code
  genuinely needs the raw secret (e.g. request signing / HMAC), it runs in a
  locked-down **"secret jail" dynamic worker**, isolated enough to prevent
  exfiltration. _(Secrets deserve their own section in the architecture — [[Q14]].)_
  _Principle: the agent must **never see** the secrets that mutate the outside world — the
  same risk reduction human developers get by never touching prod secrets. (Far future: an
  agent may **briefly** see a secret it is itself creating.)_

---

## 6. Taxonomy (canonical language)

_One word per concept. When several exist, we pick one and list the rest as
**Avoid**. Terms land here the instant we settle them; genuinely-open names sit in
**Flagged ambiguities** until decided. Definitions say what a thing **is**, in one
sentence — not what it does._

### Language

**reduce** — the function a processor defines to turn events into state:
`(reducedState, event) => reducedState`.
_Avoid_: fold (as the verb), reducer.

**reduced state** — the persisted, derived state of a stream: what you get by
reducing its events from the start. Disposable — delete it and it rebuilds by
re-reducing the log. _[LOCKED Q1]_
_Avoid_: fold, the fold, the reduction.

**runtime state** — ephemeral in-memory state inside a processor or durable object
at a moment in time; not persisted and not derived from the log (an open
connection, a half-built batch). _[LOCKED Q1]_
_Avoid_: —

**event** — an immutable, past-tense fact appended to a stream; the only way to
change durable state. Plain-language synonym: "a fact."
_Avoid_: message (for the durable record), record.

**stream** — an append-only log of events at a path; the unit of durable state and
of ordering. Plain-language synonym: "a log."
_Avoid_: journal (code sometimes says "journal" — standardize on stream), table.

**processor** — something that reads a stream and reacts: it reduces events into
reduced state and causes side effects. An agent is a processor with a prompt.
_Avoid_: consumer, handler.

**append** — the write primitive: submit an **event input**; it is durably recorded as an
event and `append` returns once that's done. The event input may carry an optional **offset
precondition** (append only if the stream hasn't moved) — a compare-and-swap ([[D16]]).
_Avoid_: write, publish, emit (colloquial only).

**event input** — what you hand to `append`: the proposed event plus optional metadata,
notably an optional **offset precondition**. The durable **event** is what results, once
recorded, with its assigned offset.
_Avoid_: —

**processEvent** — the read/react primitive: you are invoked for **every event on a stream
from a starting offset**, and checking each event is how you reduce, react, or wait.
`waitFor` and server-side filters are **optimisations** over it; it is what the worker
implements ([[D4]], [[D16]]).
_Avoid_: **consume** (rejected — we say `processEvent`).

**capability** — a callable reference that lets code do something (call a tool,
reach another entity, hit the network); you have authority because you hold it.
_Avoid_: permission, binding.

**project** — one iterate entity: its own identity, streams, code, and secrets, and
the single trust boundary. Nothing inside a project is hidden from anything else
inside it ([[D1]]).
_Avoid_: tenant, workspace, org, account.

**repo** — a git repository owned by a project.
_Avoid_: —

**config repo** — *the* project's config repo: the git repo holding the project's own
code and rules. Its configuration is a **web server** (a fetch function / Cloudflare
Worker) the platform calls into — not a settings file. The entity rewrites it to
improve itself. [LOCKED terminology]
_Avoid_: settings, config file.

**itx** — the project's capability context object: what you hold after authenticating
and narrowing to one project. **`itx` always means the project.** All code — platform,
config-repo, agent scripts, even browser React — is written as a function of `itx`.
_Avoid_: —

**stream** (comms sense) — besides being memory, streams are the internal
communication substrate: parts of a project coordinate only by appending events and
reacting to them, never by calling each other directly.
_Avoid_: event bus, message queue, workflow engine (accurate but jargon — keep out of
the opening).

**kernel** — the part of the system that *cannot* be built in userspace, plus the
two-or-three things that could be but are too essential to leave out; small on
purpose ([[D2]]).
_Avoid_: **seed** (rejected).

### Flagged ambiguities (names still open)

- **The non-kernel layer** has no agreed name — **not "packages"** (implies npm). → [[Q7]]
- **kernel vs core** — resolved *against* "seed"; final pick between the two still open.
- **consume vs subscribe** — RESOLVED: the read/react primitive is **`processEvent`** (not
  "consume"); "subscribe" stays the opt-in **delivery** setup ([[D11]]).

---

## 7. Architecture — the core domain objects

_The "how it works" body. One subsection per core domain object; each carries: **what
it is** (one line), the **decisions** that govern it (from §5), **how it works**, and
its **open questions**. Domain-specific decisions will migrate here from §5 over time;
for now they're cross-referenced. **Status: skeleton — we fill objects one at a time**
(recommended first: Stream, the most locked)._

### 7.1 Project — the organism / the trust boundary
- **What:** one iterate entity — its identity, streams, code, secrets, and the single
  trust boundary.
- **Decisions:** [[D1]] (one trust boundary), [[D13]] (ocap not ACL), [[R1]], [[R10]].
- **How it works / open:** _stub._

### 7.2 Stream — the log (memory + messaging)
- **What:** an append-only log of events at a path — both the organism's memory
  (reduced state) and how its parts talk (append + react).
- **Decisions:** [[D3]] (event-sourcing purist + cross-post), [[D7]] (one abstraction =
  db/queue/workflow/streaming), [[D8]] (universal event interface), [[D9]] (events
  reference big objects), [[D11]] (event delivery / TTL / side-effect dimensions),
  [[D12]] (capture-verbatim,
  middleware = append+react).
- **How it works / open:** [[D16]] (two primitives — `append` + `processEvent` —
  everything else is an optimisation; `append` takes an event input with an optional offset
  precondition); [[Q3]] (event-pair convention — resolved). _Fill first._

### 7.3 Processor — reduce + react
- **What:** reads a stream, reduces events into reduced state, reacts by appending /
  side-effecting. An **agent is a processor with a prompt**; a processor can be hosted
  anywhere ([[R11]]).
- **Decisions:** [[D3]] (reconcile-is-just-wake, [[Q2]] resolved), [[R11]], [[R12]]
  (concurrency), [[D16]] (`processEvent` = platform-hosted `consume`).
- **How it works / open:** the obligation convention (`requested → completed{outcome}`,
  [[Q3]]); the at-head/idempotency mechanics. _stub._

### 7.4 Config repo & the config worker — the DNA
- **What:** the git repo holding the organism's code; the config worker = `{ fetch,
  processEvent }`; `itx` wraps both.
- **Decisions:** [[D4]], [[D2]] (userspace override), [[R13]] (stateless ingress).
- **How it works / open:** [[Q5]] (largely resolved by R13 — confirm). _stub._

### 7.5 Capability & `itx` — the addressing tree
- **What:** the one homogeneous surface all code is written against; **addressing, not
  security** ([[D13]]); expressions + bind-as-attenuation; mounts.
- **Decisions:** [[D2]], [[D13]], [[R7]] (TS-like).
- **How it works / open:** [[Q4]] (capabilities as mounts installed by processors — a
  hook model), [[Q9]] (make expressions look like TypeScript), [[Q7]] (what the
  non-kernel layer is called). _stub._

### 7.6 Secret — write-only
- **What:** write-only, host-bound at add-time, substituted at the egress door;
  "secret jail" worker for the rare raw-access case.
- **Decisions:** [[D10]].
- **How it works / open:** [[Q14]] (write this section in full). _stub._

### 7.7 Egress door — the one exit
- **What:** the single place bytes leave the project; `fetch`'s external branch; where
  all outward-facing security lives.
- **Decisions:** [[D6]], [[D15]] (programmable MITM SSL proxy + sandboxed code + forced
  routing), [[D10]] (secret substitution at the door).
- **How it works / open:** a programmable man-in-the-middle SSL proxy (enterprise-DLP
  style: log / capture / filter / DLP); sandboxes and borrowed machines force egress
  through it ([[D15]]). Open: what MITM SSL rules out (cert pinning), and the DLP policy
  surface. _stub._

### 7.8 Repo & blobs — git + big objects
- **What:** git repos (a project may work on many, [[R3]]); events reference commit
  hashes and file objects ([[D9]]).
- **Decisions:** [[R3]], [[D9]].
- **How it works / open:** [[Q6]] (do "other repos" need the repo abstraction, or just
  use GitHub + octokit?). _stub._

### 7.9 Worker / Sandbox — running code
- **What:** dynamic workers / sandboxes for running code; the "secret jail"; machine
  providers plugged in as mounts.
- **Decisions:** (sandbox = just a capability mount — from the big-ideas evaluation);
  egress is intercepted at the sandbox boundary ([[D15]]).
- **How it works / open:** _stub._

### 7.10 Guardrails — the protected control plane (the membrane)
- **What:** the small, un-editable part of the organism, held by the **platform**, that
  requires human sign-off to change and can **halt everything** ([[D14]]).
- **Decisions:** [[D14]], [[B5]], [[R14]], [[Q15]]; relates to [[D2]] (the one exception),
  [[D10]] (egress-gated approvals), [[R10]] (per-project accounts for spend containment),
  [[B4]] (default is still no-human-sign-off).
- **How it works / open:** the name; the money-spent event primitive + multi-level
  aggregation + kill switch (pinned); the human-approval attestation mechanics ([[Q15]]).
  _stub._

---

## 8. Open questions (the diffusion frontier)

_The live edge. Each of these wants to become a Belief / Requirement / Decision, or
to be explicitly dropped. Roughly ordered by how load-bearing they are._

- **Q1 — `reduce` vs `fold`. [RESOLVED → Taxonomy §5]** Function is **`reduce`**;
  the persisted result is **reduced state** (not "fold"); ephemeral in-memory state
  is **runtime state**. "State" alone is banned as ambiguous.
- **Q2 — Is `reconcile` a separate concept? [RESOLVED → no; see [[D3]]].** Verified:
  waking and (re)connecting already emit events — `stream/woken` and the
  `subscriber-connected` presence facts (`core-processor-contract.ts`). So the alarm
  → wake/reconnect → **event**, and a processor heals by handling that event on its
  normal reaction path. There is no separate `reconcile` *kind of thing*; it's the
  same job (make the world match the reduced state) under a different trigger. Keep
  the alarm; drop `reconcile` as a distinct method. Nuances that survive as
  *mechanics, not concepts*: act only when at head; re-drive with idempotency keys.
- **Q3 — Event-pair convention. [RESOLVED → convention].** Durable side effects only:
  `<verb>-requested → <verb>-completed { outcome }` — two events, outcome is data (not
  three). Reduced state tracks open ones; wake re-drives them ([[D3]]). **Pair only
  durable effects; plain queries stay normal calls** (no added latency). A convention,
  not a framework. _(Not important / not blocking — parked per Jonas.)_
- **Q4 — Built-ins as mounts + performance.** Moving built-in tools onto the one
  capability table dissolves the 6k-line god-file — but what's the perf cost, and is
  the clean model "hooks" (a processor reacts to repo-push/worker-built and installs
  capabilities)? The `__describe` story isn't clean yet.
- **Q5 — Config worker sync/async + stateless vs Durable Object. [RESOLVED → [[D16]]].**
  The substrate is two primitives, `append` + `consume`. `append` waits for durability
  (inherent); waiting for a *reaction / outcome* is just consuming until the named event
  appears — "it just depends," nothing forces a block. `processEvent` = platform-hosted
  consume; `waitFor` and server-side filters are optimisations. So the worker needn't be a
  resident DO to block/coordinate — **stateless stands** ([[R13]]); the DO is only the
  **ordering point**. Placement (stateless vs DO) is an optimisation, not a fundamental.
- **Q6 — Do "other repos" need the repo abstraction at all?** [[R3]] says work on
  many repos; maybe only the *config* repo is special and the rest are "just use
  GitHub + octokit like a normal person."
- **Q7 — How far toward "everything in userspace" / what do we call the layer?**
  The vote killed "everything ships as an npm package in every project" 6–0; the
  survivor was "a small number of deep first-party modules + leaf extensions", with
  "userspace" as a *test* not a mandate. Need our own words (not "packages") and our
  own line for what's a deep in-kernel/first-party module vs. a userspace extension.
- **Q8 — Updating a million projects.** Don't rebase a million repos. Publish a
  version + let projects follow a channel or pin (the apt/App-Store model). Lock the
  strategy per layer when we're ready.
- **Q9 — Make expressions look like TypeScript** ([[R7]]) — how, exactly, while
  keeping the grammar tiny (get + call, no loops, no eval) and bind = an enforced
  constraint (not object-merge)?
- **Q10 — The plain framing. [RESOLVED].** Lead with *what it is/does* (a
  self-improving AI entity that can do anything a human-with-a-computer can, and gets
  better); put the mechanism (HTTP in → state → HTTP out) *second*. Don't open with
  "it's basically a web app" — it undersells self-improvement.
- **Q11 — The noun. [RESOLVED → "digital organism"].** (Considered: AI entity, AI
  coworker, autonomous AI, no-fixed-noun.) Still want the single crispest PG one-liner
  eventually, but the noun is set.
- **Q12 — Deferred: one channel mechanism** (Slack/Telegram/email/GitHub → one
  parameterized thing). Jonas: **not yet.**
- **Q13 — The PI coding agent reference.** Find/settle the canonical reference for
  "self-modifying, produces-only-code" (PI coding agent) to cite in §1.1.
- **Q14 — Write the Secrets section of the architecture.** The secret durable object,
  placeholder substitution at the egress door, the add-time host allowlist, and the
  "secret jail" dynamic worker for the rare raw-access case ([[D10]]).
- **Q15 — Cryptographically verified human approval. [DIRECTION LOCKED → [[D14]]; mechanics
  open].** We *need* this primitive (secure-enclave proof of human approval); it gates
  **promotion** and **high-risk egress**, and is used rarely. Open mechanics: what the
  signature actually attests (key-possession vs physical-presence vs informed-consent vs
  legal-identity — different claims), which **attested UI** shows the canonical bytes, and
  what stops a **destination-swap** between approval and execution. ([[WA2]], [[D14]].)
- **Q16 — Event dimensions (delivery / TTL / side-effects). [RESOLVED direction; TTL
  pinned].** "Ephemeral" decomposes into **explicit** properties, not a hard type
  ([[D11]]): (1) **delivery** — high-freq lanes excluded-by-default from push, pull, and
  `waitFor`, opt-in via the `subscribe` signature; (2) **side-effects** modelled
  **explicitly** (`sideEffects: "disallow"`), *not* derived from TTL (least surprise);
  (3) **TTL** (null = forever, 0 = deletable) — concept set, **implementation pinned for
  the detailed stream design** (with R2 offload for >10 GB streams). **PIN: do not design
  TTL / offload mechanics now** — return to the big picture. _Still parked: is a live
  voice **transcript** durable (kept forever) or throwaway (only the final one durable)?_

---

_Parking lot (on the shelf, not lost): the "wild ideas" (entity-is-a-file,
hire-companies, shadow-selves, time-travel debugging, the-project-as-a-filesystem)
and their 6-judge vote live in the exploration pile. We pull them in only if/when a
requirement or belief here calls for them._

---

## Verbatim (Jonas's exact words — fold in, don't lose)

_A running safety-net of things Jonas said, captured verbatim so nuance survives
paraphrase. ✅ = represented in a section above · ⬜ = still to fold / sharpen._

- ✅ "It can do anything that a human with an internet-connected computer can do and
  it gets better over time. It could be a company, it could be a personal assistant,
  it could be a co-worker." → §1
- ⬜ "This is accomplished through a combination of stochastic LLM requests that
  produce deterministic code as well as deterministic code that directly responds to
  HTTP requests. The AI writes code to modify the deterministic code but in principle
  it should also be allowed for the AI to make HTTP responses directly from the model
  weights. I don't care." → §1 (parenthetical) — sharpen the phrasing.
- ⬜ "Our agents only produce code. They don't even do traditional tool calling and
  also they just consume events. Webhooks are barely transcribed for the agent. The
  agent just cares about the fact that something has happened. That's quite novel."
  → §1.1
- ⬜ "Everything is insanely observable. Anything that goes wrong is observable and
  self-modifying, just like the PI coding agent. Definitely a reference we need in
  there." → §1.1 (+ [[Q13]] PI reference)
- ⬜ "This is on a relatively high level of abstraction, not in the kernel." → §1.1
- ✅ "The internal state is maintained in append-only event streams and a
  configuration Git repository, which form the infrastructure backbone… [plus] the
  ability to run arbitrary code in response to internal and external requests." → §1.2
- ✅ "All code across all projects on project and platform surfaces [is] written
  homogeneously as an operation on an iterate context object, exposing the
  capabilities of the platform and the project." → §1.3 (expanded — make more complete)
- ✅ "If your project represented a SaaS company, an event might be an inbound email
  from a customer complaining… that would trigger, based on rules in your config repo,
  an agent… speak to you on Slack… respond to the customer on email… update the source
  code for the website… the user's next HTTP request would be served by the updated
  code." → §1.4
- ✅ "We use the streams for state but they're also the key communication primitive
  internally because parts of the system are like an event bus. It is sort of like an
  event bus and workflow model. I don't really want to use those terms at the
  beginning." → §1.2 (streams-as-comms; kept jargon out)
- ✅ "The configuration is expressed as a web server, like a fetch function… more
  specifically a Cloudflare worker. Configuration is a Cloudflare worker that the
  platform calls into." → §1.1, §1.2, Taxonomy(config repo)
- ✅ "Even the browser code, even the React components, they just write ITX context
  code and it's the project's ITX context object. ITX always means the project.
  Technically it is the result of authenticating and narrowing to a project but it is
  the object." → §1.3, Taxonomy(itx)
- ✅ "You should be able to do anything in userspace. The behaviour should be entirely
  determined by the config repo. There should actually be nothing that the config repo
  isn't involved in, really, unless it's in the kernel." → §2 + [[D2]] (everything
  overridable in userspace).
- ✅ [beliefs/decisions grilling] deleted B2(old)/B4(old)/B6; locked B4 (verification
  flips); renamed D1 (one trust boundary), reframed D2 (everything overridable in
  userspace), D3 (event-sourcing purists + cross-post example); added D4 (config = git
  repo as a Cloudflare Worker), D5 (agents only code), D6 (security at egress door),
  D7 (one stream abstraction = db + task queue + workflows + live streaming). D4-cand
  (only-append) dropped: "you can also commit."
- ✅ "This thing can interact with anything you can interact with: emails, Slack,
  multiple different channels and people on a single stream. You can talk to it using
  your own agent loop using MCP, a voice agent using your MCP server, use it as a tool,
  the built-in agent. It's all just events that enter the project-wide event loop." → [[D8]]
- ✅ "I don't think R9 is a real requirement because we have the git repo. Not every git
  commit is a stream event… the events can have references that resolve into something
  bigger, like a reference to a file object or a commit hash." → R9 REJECTED; → [[D9]]
- ✅ "Secrets cannot be revealed and they can only be sent to a host that is provided
  when a secret is added. You fetch through the secret durable object to replace a
  header — substitute secret for the real thing. If we ever need access to the actual
  secret, you can get access to it in a secret jail dynamic worker." → [[D10]]
- ✅ [/btw fork] "The config worker is just two handlers: `fetch` and `processEvent`…
  `egress.fetch` collapses into `itx.fetch` (direction by hostname)… ingress must NOT
  go through the project DO; it lands on the stateless worker entry point." → refined
  [[D4]] (config worker = {fetch, processEvent}, itx wraps both, egress folds into
  itx.fetch, "just fetch" ADOPTED); added [[R13]] (stateless ingress). Also: `itx` is
  addressing, not security → clarified [[D6]].
- ✅ [/btw fork] "`append` and `processEvent` are the two ends of one flow, not two
  verbs — `append` is the write/inject primitive (sacred fact), `processEvent` is the
  worker's reaction. Middleware = append the transformed version next to the sacred
  original (capture verbatim, select downstream); a chain of append+react IS
  middleware. Pre-commit rejection stays kernel." → corrected [[D4]] (caller calls
  `{append, fetch}`, worker implements `{processEvent, fetch}`); added [[D12]].
- ✅ [/btw fork] "In pure capability security, checking whether the holder is allowed
  is a category error — the capability IS the authority. Checks happen at mint time
  ('should I vend you this?'), not use time. Attenuate instead of check; make the
  forbidden thing un-nameable; the only per-use check is revocation." → added [[D13]]
  (object-capability, not ACL).
- ✅ "Within a project I'm not sure there need to be different levels of auth… multiple
  humans would all need the same access as the AI… otherwise you tie yourself in knots
  doing internal authorization checks." → [[WA1]]
- ✅ "Prompt injection: more AI is the way to solve that, not more human in the loop.
  Some things maybe legally require human approval and we need a cryptographically
  verified way to do that. For anything else, human actions will require AI approval in
  the not so distant future." → [[WA2]], [[Q15]]
- ✅ "A project config is just a fetch function plus a processEvent function. The fetch
  function comes from the untrusted internet, though it goes through the platform where
  some headers are added for your convenience. The processEvent function consumes all
  non-ephemeral events on all streams and gets invoked for that. That is your mechanism
  to do almost anything." → §1 "The anatomy of a project" (refines [[D4]])
- ✅ "Let's call it a digital organism." → §1 noun ([[Q11]]).
- ✅ [restructure] "The first two paragraphs are good… then introduce the primitives…
  at the very end of the first section bring it together with an example. 'What makes
  it different' comes later." → §1 restructured (prose → 3 primitives → example);
  "what makes it different" moved to §2.
- ✅ [primitives-as-a-list rejected → narrative] "The primitives are pretty dumb, it
  doesn't need to be a list." → §1 rewritten as prose on levels of abstraction.
- ✅ "One way to think about it is that it is like a web server. It receives HTTP
  requests… in response it can update its own state, make HTTP responses, and also make
  outbound HTTP requests. That is the only way it can influence the world." → §1
- ✅ "The web server runs TypeScript code in the context of the project, and this
  TypeScript comes from either a git repo or is written on the fly by LLMs… the git repo
  represents the programming of the organism… it's the self-editing DNA of the
  organism." (genotype = repo, phenotype = the running web server.) → §1
- ✅ "Anything in the project should trust anything in the project… there are going to
  be large language models that are more powerful than us… they're not going to be
  employees of different access levels… There's only inside the project and outside
  the project… They should all have access to the same stuff that AI has access to…
  That rules out a whole bunch of customers." → [[D1]]
- ✅ "A belief is that AI models will soon be smarter than humans and we should build
  something that doesn't necessarily assume humans need to have proof of everything
  AI does. If anything the opposite might be true." → [[B1]], [[B2]]
- ✅ "Everything that could be implemented in user space is not in the kernel.
  Everything that can't be implemented in user space is in the kernel. We want the
  kernel to be small, but we've also chosen to include two or three things that could
  be implemented in user space but that are so essential that we have chosen not to."
  → [[D2]]
- ✅ "Prefer the pure form… wouldn't the alarm cause a reconnect, which causes an
  event which we can pick up and process[Event]… this illustrates the kind of purity
  I'm looking for." → [[D3]]
- ✅ [volunteered decision, 2026-07-15] "I don't like anymore that we have ephemeral
  events. Better for events to have a property — **delivery** — delivered to push/any
  subscribers, or only to one explicitly requested (streaming / voice PCM chunks
  explicitly request it); a **TTL** (do they age out?); and the relevant one, **are you
  allowed to enact side effects** — some events shouldn't, but that's tied to TTL, a bit
  messy. Rather than a hard type, we call an event ephemeral colloquially if these
  dimensions are populated such-and-such." → revised [[D11]] + [[Q16]].
- ✅ [2026-07-15, refines D11] ""Ephemeral" is a combination of two dimensions: a time to
  live, and whether to include it by default on subscriptions. Browser / PCM / streaming
  subscribers explicitly request those events; otherwise they're excluded from *both*
  push and pull — a quick `itx.subscribe` shouldn't get flooded. A live wait-until-event
  can consider them, but only opt-in, same signature as subscribe. TTL null/undefined =
  forever, 0 = deletable immediately (we won't actually delete yet — it signals the real
  property, vs the wishy-washy 'ephemeral'). But deriving 'doesn't run through
  processEvent' from TTL fails the principle of least surprise — 'side effects: disallow'
  is more obvious, so model that explicitly; TTL added as a real dimension later (+ R2
  offload for >10 GB streams)."" → refined [[D11]] + [[Q16]].
- ✅ [2026-07-15, the guardrail membrane] "There must be guardrails. For legal reasons we
  need a way to constrain the agent — cryptographically secure proof of human approval
  using secure enclaves; we take it seriously but don't want to use it much. It could gate
  merging/pushing main (a GitHub-PR-review-like mechanism) and certain side effects like
  large Stripe refunds via egress policies. Cost control is a key human-world input — how
  much money am I willing to let it spend, implicitly (LLM) and explicitly (virtual cards).
  A big missing primitive. Spend can be incurred in third-party systems, so I imagine a
  money-spent event that can be on any stream with tags, aggregated at different levels,
  with a way to shut everything down. An argument for projects having their own third-party
  API keys with their own limits — even their own Cloudflare account (programmatic account
  creation) so even Cloudflare spend is capped per project. The 'which version of me is
  live' pointer is basically the pull-request idea; spend is another; everything needs to
  be able to grind to a halt." → [[D14]], [[B5]], [[R14]], updated [[R10]], elevated [[Q15]].
- ✅ [2026-07-15, egress proxy + sandbox + transitive spend + never-see-secrets] "Money
  should be transitive — fire up an agent and say 'spend up to $20 working on this, then
  come back to me if you haven't solved it.' At the network level there must be NO way to
  fetch the internet without going through our gate — a man-in-the-middle egress SSL proxy,
  a programmable egress proxy like a draconian enterprise corporate security environment:
  key-logging, egress capture/storage, filtering, data-mining, data-loss protection, all at
  the project boundary. On Cloudflare even general-purpose sandboxes force egress through
  the container Durable Object, whose fetch does full MITM SSL (rules out some things). If I
  lend my Mac to the project, egress is forced through there too. The code absolutely is run
  in a sandbox — a Cloudflare dynamic worker, or a virtual machine / Cloudflare container
  with egress interception. The secrets that mutate the outside world the agent must never
  see — like human developers, a lot of risk is reduced by never seeing secrets (far future:
  maybe they briefly see ones they're creating)." → new [[D15]]; refined [[R14]]
  (transitive), [[D10]] (never-see), [[D14]], §7.7, §7.9.
- ✅ [2026-07-15, the two primitives] "You definitely have to wait for the fact to be
  durably recorded — that's for sure. Then wait for the whole reaction to finish? It just
  depends. The fundamental operation is you can either **append** or you can **consume** a
  stream — consume from some starting offset and check on every stream event. Everything
  else is basically an optimisation on top of that: 'append waits for durability but you
  wait for outcomes yourself.' You could use JSONata or some discrete type filter on the
  server because it'll be faster, but logically that's what this is — that's what we're
  building." → new [[D16]]; resolved [[Q5]]; taxonomy: append, consume.
