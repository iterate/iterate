# iterate — the design document (living)

> **What this is.** A small, load-bearing document we build from scratch and grow
> deliberately. The old exploration pile (`index.html`, `simplification-*.md`, the
> lenses, the vote) is on the shelf — we drag things _out_ of it and _into here_
> only once we believe them.
>
> **How it works (the diffusion).** Everything starts life at the bottom, in **Open
> questions**. As we resolve something, it moves _up_ into a **Belief**, a
> **Requirement**, or a **Decision**. Resolved _terms_ move into the **Taxonomy**
> (§6) — our canonical glossary: one word per concept, rejected synonyms listed as
> _Avoid_. Nothing is locked until it's in one of those sections. Items have stable
> IDs (B1, R1, D1, Q1…) so we can point at them.
>
> **The three buckets, kept separate on purpose:**
>
> - **Belief** — a claim about the _world or the future_ that motivates the design.
>   Could turn out wrong. ("AI will be smarter than us soon.")
> - **Requirement** — a constraint the system _must_ satisfy. ("A user can work on
>   many repos at once.")
> - **Decision** — a design choice we're _locking in_. ("Trust is binary: inside
>   the project vs outside.")
>
> Status tags on individual lines: **[LOCKED]** we're sure · **[PROPOSED]** leaning
> yes, not confirmed · **[OPEN]** still arguing.

---

## 1. What this is (the high-level description)

_The tip of the pyramid. Must pass the Paul-Graham test: a smart outsider gets it in one
read. Structure (Jonas): **where we're going** (the audacious destination — the hook that
picks people up) → **the big idea, concretely** (what it is today) → **how it works** → a
worked example → the anatomy. (Noun locked: **digital organism**.)_

**Where this is going.** We are building toward **digital organisms that run themselves** —
software entities that don't just do work, but **improve their own code, host their own
infrastructure, and fund their own existence.** In the limit an iterate project is a genuinely
**autonomous digital lifeform**: it earns money for the work it does, **pays its own compute
bills out of what it earns**, rewrites itself to get better, and needs a human only where we
**deliberately** keep one in the loop (the membrane — [[D14]]). That is the destination.
Everything below is the concrete, mostly-unglamorous machinery that gets us there — but the
destination is worth saying out loud, because every decision here is in service of it.

**The big idea, concretely.** Today, an **iterate project is a self-improving digital
organism.** It can do **anything a human with an internet-connected computer can do — and it
gets better over time.** It might be a **company**, a **personal assistant**, a **co-worker**,
a **tutor**, or a **game that rewrites its own rules as people play** (see `use-cases.md`).

**How it works.** The simplest way to picture it is as a **web server.** HTTP requests come in
from the outside world, and in response it does three things: **updates its own state, sends
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

Suppose the organism _is_ a SaaS company, and its website lives in its git repo. A
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

**And there are only two ways anything ever starts.** Trace any activity back and it
began as one of exactly two triggers: an **inbound HTTP request** (from the outside world
into a project — landing in `fetch` — or into the control plane at `os.iterate.com`); or
an **internal alarm** (a timed Durable Object event) from the inside. Every agent run,
every code change, every outbound call is set in motion by one of those two. ([[D18]]; the
self-improvement loop that runs on top of them: [[D19]].)

---

## 2. What makes it different

_Given the primitives (§1), why this is not just "a web app" or "an agent framework":_

- **You never configure it — you change its code, and it changes its own.** Behavior
  is determined _entirely_ by the config repo; there's nothing it isn't involved in,
  except the small kernel. It's all userspace ([[D2]], [[D4]]).
- **Agents produce code and consume events** — not tool-calls and tool-results. A
  webhook is barely transcribed; the agent just cares that _something happened_ and
  writes code to handle it. _(ref: PI coding agent, [[Q13]].)_
- **Everything is a stream, so everything is observable** — and replayable. Anything
  that goes wrong is visible after the fact.
- **The kernel is tiny; the organism is userspace.** All the interesting behavior
  lives on top of a small, fixed core ([[D2]]).
- **An agent is just events on a stream.** The only thing separating a stream that does
  nothing from the most powerful coding agent in the world is a **set of events** you append
  — there is no agent data structure ([[D20]]). _(Enshrined, unshakable — Jonas.)_
- **Everything is a stream processor** — the browser UI, the CLI, and the agent alike; each
  reads one stream and reacts ([[D22]], [[D23]]). _(Loud and clear — Jonas.)_

_Rejected words: "fenced-off computer", "intelligent entity runtime" (mean nothing to
an outsider); don't open with "it's basically a web app" (undersells self-improvement)._

### North-star (a stated design vision)

_Two levels of "iterate on iterate," deliberately separated:_

- _**Company-level (intended, near-term).** We intend to **run our entire company on an
  iterate config repo** — Iterate's own operations are themselves an iterate organism. This
  is just "iterate is one of its own customers": safe dogfooding, no circular platform
  dependency._
- _**Platform-level (the north-star, deferred).** In the limit, the **control plane itself
  is just another organism** — `os.iterate.com` a privileged project on the same `itx`, the
  same two entry points ([[D18]]), the same streams, improving itself the same way. We
  **don't do this at the start**: a platform that provides *its own* platform is too easy to
  **break everything at once** (bootstrapping / circular-dependency risk). But it's the
  aspiration the architecture must keep reachable ([[R15]]) — the payoff of "everything is
  userspace" ([[D2]]) and "deployment is placement" ([[R10]])._

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
  _unnecessary_ **and** definitely _painful_.
- **WA2 [ASSUMPTION].** **Prompt-injection is solved with more AI, not more
  human-in-the-loop.** For the few actions that legally require a human, we need a
  **cryptographically verified human-approval** path (secure enclave / attestation —
  [[Q15]]). For everything else, **AI is the guardrail** — and in the not-so-distant
  future even _human_ actions will require **AI approval**, not the reverse.

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
- **R15 [LOCKED]. Don't foreclose the platform running on itself.** The architecture must
  leave the door open for the control plane (`os.iterate.com`) to eventually be **just
  another organism** — iterate running on iterate — even though we **won't build that day
  one**. It's the natural consequence of homogeneity + [[R10]] (same substrate; deployment
  is placement). _Why not now: a platform that provides its own platform is too easy to
  break all at once — see the North-star note in §2._
- **R16 [LOCKED]. Iterate's integrations work out of the box, but every one is overridable in
  userspace.** A project can reach any third-party API **through iterate's own integration** —
  iterate provides the key/account and charges a **pass-through fee** — so it works **out of
  the box**. But **every one is overridable**: if you don't want iterate's OpenAI key or the
  surcharge, you **bring your own** (your own OpenAI account, your own keys/secrets) and the
  default steps aside. **No forced surcharge, no forced key.** (This is [[D2]] / [[D17]]
  applied to integrations & billing; BYO extends to secrets — [[D10]].)
- **R17 [LOCKED]. In the future you must be able to run a project on your own accounts —
  "renting only the kernel."** A project must be able to run in **your own Cloudflare
  account**, with **your own** OpenAI account, secrets — **everything** — the platform↔your-
  account connection done over **Cap'n Web (capnweb)**. At that limit **you're just renting
  the kernel** from iterate. **Directional, not day-one** — it's fuzzy ("not at all clear what
  it means"), and we won't yet have access to your artefact bindings — but the door must stay
  open. (Sharpens [[R10]]; connects the [[R15]] north-star and the [[D2]] kernel.)
  _Model: the **streams (and iterate's code) run in the customer's Cloudflare account** — like
  a normal **enterprise on-prem deployment**, where they run our code and we push updates to
  it. Jonas: "could still work quite well."_
- **R18 [LOCKED]. What iterate brings to the table (the "walls" you rent).** Even when you bring
  your own accounts / keys ([[R16]], [[R17]]), iterate provides real value out of the box:
  **first-party, pre-approved OAuth clients** (e.g. a ready Google OAuth client), a **polished
  mobile app**, and the **kernel walls themselves** (the egress MITM proxy, the stream
  substrate, identity). "**Renting the wall**" is a good way to think about it — you rent the
  walls and the pre-built surface, and bring the rest.
- **R19 [LOCKED]. The entire product can _be_ an agent.** It must be **trivial** to build an
  application where the **whole product is an agent**: every visitor **starts an agent
  conversation** and interacts with it directly. There is **no difference between an internal and
  an external agent** — same machinery, same events ([[D8]], [[D20]], [[D22]]). An agent-as-product
  is just an agent reachable from the public edge. _(Jonas, loudly: this must be possible.)_

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
  _Clarification: the **interior** is binary — employees, or partners in a marriage using it as a
  family butler, all trust each other and see everything. But the **outside is not monolithic**:
  the organism interacts with **external stakeholders at different trust levels**, so the **edge**
  is where graded trust actually lives — *what can this third party see? what am I allowed to show
  them? am I being tricked?* The binary is about the interior; the **boundary itself is rich**
  (enforced at the egress / interaction door — [[D6]], [[D15]])._
  _Users vs holders (2026-07-15): the differentiated parties a project **serves** — a startup's
  customers, a tutor's kids, a game's players — are **users, not interior members.** They **never
  hold an `itx`**; they're HTTP visitors the config worker's `fetch` authenticates and serves
  **per-user views** (ordinary userspace web-app auth). So D1's binary is precisely "**who holds an
  `itx`**": inside = the project's agents + operators, fully trusted; and differentiated visibility
  among users needs **no interior levels** — it falls out of users being *outside*. Orthogonally
  (Jonas leans toward this as "even better / more meaningful"): a user may *also* be their **own
  project** — e.g. a kid is a sovereign organism holding an `itx` to their *own* streams, and the
  tutor holds a *granted capability* across the edge (federation). Both models compose._
- **D2 [LOCKED]. Everything except a tiny kernel is overridable in userspace.** A
  project's behavior is defined in its config repo; there is almost nothing the
  platform does that a project can't override in userspace — except a small fixed
  **kernel** (the things that genuinely _cannot_ be expressed in userspace, plus two
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
  through it) is an unforgeable handle that both _names_ a thing and _carries_ the
  right to use it. There is **no per-use permission check** — if you can call it,
  you're allowed. Checks happen at **mint time**, not use time: `authenticate()` is
  the one identity→capability conversion, and `session.projects.get("prj_x")` asserts
  your claims cover the project **before** handing back the itx. Confinement is
  **structural, not guarded** — a project-A itx literally cannot _express_ a reference
  to project B, so there is nothing to check ([[R1]] by construction). The smell to
  avoid: "get the reference, then check whether the holder is allowed" at _use_ time —
  that's an ACL leaking into a capability system. The fixes are always (1) move the
  check to **mint time**, (2) **attenuate instead of check** (hand out a narrower
  capability that structurally can't do the forbidden thing — bind-as-attenuation,
  [[R7]]), or (3) make the forbidden thing **un-nameable**. The only legitimate per-use
  check is **revocation** (is this capability still valid?) — about the capability,
  not the holder.
- **D14 [LOCKED]. A small protected control plane (the "membrane") lives outside
  userspace — the one deliberate exception to [[D2]].** A self-editing organism has no
  floor unless a _tiny_ part of it is un-editable by its own code. That part is held by
  the **platform, not the organism**, requires **human sign-off to change**, and is what
  lets everything **grind to a halt**. It holds exactly four kinds of thing, and nothing
  else:
  1. **The promotion / rollback gate** on the "which version of me is live" pointer.
     Code may be _written_ freely (userspace); making it _live_ — merge/push to the
     artifact's main — passes a gate the live code can't rewrite, so a bad commit is
     always rollback-able. Shaped like a **GitHub pull-request review** — realized as a
     **protected `main` branch on the artefact** ([[D19]]).
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
  at the edge of a project. This is the mechanism _behind_ [[D6]], and it's where [[D10]]
  substitutes secrets (the agent sends a placeholder; the proxy injects the real secret at
  the door). It answers "what forces code through the one door?": nothing _asks_ it to —
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
    _Reality check (2026-07-15): the **forced single egress door is shipped** — a Dynamic Worker's
    bare `fetch()` routes via `globalOutbound` → the Project DO so explicit RPC egress and bare
    fetch "share one decision point" (`projects/egress.ts` `ProjectEgressEntrypoint`), and the
    interceptor "sees getSecret(...) placeholders, never material" (`:5`). The richer **MITM-SSL /
    log-capture / DLP / data-mine** framing is **aspirational** — not (yet) in the code I read; the
    shipped reality is a single forced egress + secret substitution + origin allowlist._
- **D18 [LOCKED]. The entire system has exactly two entry points: an inbound HTTP request
  and an internal alarm.** Trace any activity to its root and it began as one of two
  triggers: (1) an **inbound HTTP request** — from the outside world into a **project**
  (→ the project worker's `fetch`), or into the **control plane** (`os.iterate.com`); or
  (2) an **internal alarm** — a timed **Durable Object alarm** from the inside. Everything
  else (agent runs, code changes, outbound calls) is set in motion by one of these two.
  _(Cloudflare offers other worker entry points — a queue consumer, an email consumer — but
  they don't apply to projects as designed today. The project-vs-control-plane HTTP split
  may get refactored.)_
- **D24 [LOCKED]. We build the agent harness _as a distributed system_ — and embrace it.** We
  **want** parts to **degrade or fail independently**: one stream processor implements basic
  agent turn-taking, another _completely independently_ implements loop detection, and neither
  can take the other down. Independence is a **feature**, not a cost we tolerate. (Follows from
  [[D22]] (everything is a processor), [[D23]] (one processor : one stream), [[R6]] (any part
  can fail and recover); it's part of why we accept cross-post's duplication.)

### Streams & events

- **D3 [LOCKED]. We are event-sourcing purists.** The organism's runtime state is
  derived by reducing event streams (its _code_ lives in git — [[D9]]), and mechanisms
  are expressed as **events on the normal path**, not special-case hooks (waking is a
  `stream/woken` event, not a `reconcile` method — [[Q2]]). We hold the line even when
  it looks inefficient.
  _Concrete example: the **only** way a stream processor can react to events in two
  different streams is to **cross-post** one stream's events onto the other. It looks
  inefficient — and it's actually really useful._
  _(We hold this line **completely** — the whole agent lifecycle is events. Sharpened in
  [[D23]]: one processor : one stream; cross-post is the only multi-stream mechanism.)_
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
  ephemeral _type_.** "Ephemeral" is a **colloquial label** for a combination of a few
  **explicit, orthogonal** properties. Preference: model each property **explicitly**,
  rather than a wishy-washy "ephemeral" type or _deriving_ one property from another.
  1. **Included-by-default on subscriptions? (delivery)** — most events are delivered to
     all subscribers by default. High-frequency lanes (audio PCM chunks, streaming LLM
     tokens) are **excluded by default from _both_ push and pull subscribers** (and from
     a live `waitFor`); a subscriber gets them only by **explicitly opting in**, using
     the **same signature as `subscribe`**. _Why: a quick `itx.subscribe` in a script
     must not suddenly be flooded with chunk spam — opt-in is least-tedious._
     **(The dimension that actually matters right now.)**
  2. **Side effects allowed?** — modelled **explicitly** (e.g. `sideEffects: "disallow"`),
     **not derived from TTL.** Deriving "this doesn't run through `processEvent`" from a
     TTL number violates the **principle of least surprise**; an explicit flag is
     obvious. _(Leaning explicit; likely a formal dimension.)_
  3. **TTL** — `null` / `undefined` = **forever**; `0` = **deletable ~immediately** (for
     now just a _signal_ of the event's real nature; actual deletion **not implemented**).
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
  kinds: **`fetch` middleware** is synchronous and _in-path_ (transform request →
  response, can short-circuit — like Express/Hono); **event middleware** is
  _post-commit reaction_ (the fact lands first; you can only react by appending, never
  rewrite it). **Pre-commit rejection stays kernel** — only the inline core processor
  may reject a malformed or paused append; userspace middleware is always the
  post-commit reaction chain. This preserves [[D3]] purism (the raw fact is _always_
  recorded), journal sovereignty (an append can't be blocked by user code), and
  stateless scaling (userspace off the commit hot path).
- **D16 [LOCKED]. The stream substrate has exactly two primitives — `append` and
  `processEvent` — and everything else is an optimisation over them.**
  - **`append`** — submit an **event input** (not an event directly); it is durably
    recorded as an event, and `append` returns once that's done (the wait is inherent —
    [[D4]]). The event input may carry an optional **offset precondition**: "append this
    **only if the stream hasn't moved** past this offset." That optional compare-and-swap
    is what lets the _same_ log be a **task queue** (claim a job = conditional-append a
    `claimed` fact; exactly one wins) and a **database** (sell the last ticket = append
    conditional on the current stock offset).
  - **`processEvent`** — the read/react side: you are invoked for **every event on a
    stream from a starting offset**, and checking each event is how you reduce, react, or
    wait. This is the "consume a stream and check every event" operation — but we call it
    **`processEvent`** everywhere, _never_ "consume." A third-party processor ([[R11]])
    does the same thing by processing the stream itself.
  - Everything else is convenience or performance on top:
    - **`waitFor(namedEvent)`** = process events from now and stop when the named one
      appears (optional timeout). Sugar, not a primitive.
    - **Server-side filters** (JSONata, a discrete type filter) = a **speed** optimisation
      over receiving everything and checking client-side; _logically identical_.
  - So "do you wait for the reaction?" **just depends** — you may process until the outcome
    appears, or not; nothing forces the log or the worker to block. (Resolves [[Q5]].)
    _Reality check ✓ **shipped verbatim** (2026-07-15): `streams/stream-durable-object.ts:224`
    `append(...)`; the event input's optional `offset` is "an optional optimistic-concurrency
    assertion" (`:233`), enforced as a compare-and-swap at `:263` (`expected offset X, got Y`)._
- **D20 [LOCKED · ENSHRINED]. An agent is just a stream with a preset of events appended —
  there is no "agent" data structure.** The thing that turns an inert stream (one that does
  nothing) into **the most powerful coding agent in the world** is _simply a set of events_.
  You take an **array of events as a preset** and **append** it to a stream; the stream then
  starts driving a processor that appends more events, calls LLMs, and so on. No agent
  object, no agent schema — **agent-ness is events.** _This is a founder-locked, unshakable
  statement of the design — Jonas said this, and it should not change (2026-07-15)._ (The
  deepest form of [[D7]] / [[D8]]: even "being an agent" reduces to events on a stream;
  connects [[D5]], [[D16]].)
- **D22 [LOCKED · ENSHRINED]. Everything is a stream processor.** The **browser UI**, the
  **CLI**, and the **agent** are all stream processors — each reads a stream and reacts.
  Loud and clear: there is no other kind of actor. (Homogeneity — all written against `itx`;
  connects [[D8]], [[R11]], [[D20]].)
- **D23 [LOCKED]. One processor : one stream — the stream is the serialization point;
  cross-post is the only way to combine streams.** A stream processor processes events from
  **exactly one stream**, because a single stream is the **only** thing that guarantees a
  total order. To react to N streams, you **cross-post** their events onto one stream. Events
  are therefore **duplicated across streams — and that is fine** (storage is cheap). The
  payoff: within a stream, everyone agrees on the **exact order** things happened — **perfect
  ordering.** (Sharpens the cross-post rule in [[D3]]; each event carries an incrementing
  **offset** within its stream.)
- **D25 [LOCKED · ENSHRINED]. The events _are_ the API — the _durable_ interaction surface.**
  You interact with the system durably by **appending and reading events** — the event
  vocabulary is the interface, and there is no separate _durable_ RPC API. Convenience functions
  may wrap `append`, but underneath it's events. That's how you talk to the system's memory, full
  stop. (Sharpens [[D16]]; twin of [[D20]] — if an agent is just events, so is talking to one.)
  - **Caveat (bounds the purism):** **not everything serialises into an event**, deliberately.
    Rich, _ephemeral_ interactions — **request/response streams and rich JavaScript objects passed
    across RPC (capnweb) boundaries** — go over **RPC, not events**. This is a **feature**: it
    lets you write **natural, richly-typed JavaScript** that's legible to an LLM ([[B2]], [[R7]]).
    So: **events for durable truth; RPC for rich ephemeral interaction.** _(This is why "the last
    RPC" — collapsing all RPC into events — is rejected.)_

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
  adds provenance + waking subscribers. Config worker provides the _behavior_; the
  platform provides the _plumbing_.
  - **One fetch, direction by hostname ("just fetch" — ADOPTED).** `itx.fetch` is the
    single HTTP verb: an internal name routes _into_ the project; an external name goes
    _out_ through the egress door ([[D6]], [[D10]]). The separate `egress` member of
    the tree **collapses into `itx.fetch`.** An edge request and internal
    `itx.fetch("http://self.iterate/…")` are the **same code path**.
  - **The asymmetry:** `fetch` is fully **stateless** — it touches the DO/streams only
    if the handler chooses to read or write durable state. The event side has a
    durability point: `append(e)` writes `e` to its stream **through the stream DO**
    (the ordering point and the record) **first**, and only **then** does the platform
    wake the worker's `processEvent`, which runs statelessly. Compute is stateless; the
    DO is the ordering point, never the HTTP hot path.
- **D5 [LOCKED]. Agents produce only code.** No traditional tool-calling — an agent
  responds to events by writing a script that runs. (That script is the `itx` script block
  in the self-improvement loop — [[D19]].)
- **D17 [LOCKED]. The non-kernel layer is _referenced_ through `itx` (microservices-style),
  not copied into each repo.** The shared platform layer (default agent prompts, integrations,
  defaults) lives behind the project's **`itx` binding**; a project **pulls a default out of
  `itx` and modifies it however it likes**.
  - **Un-overridden defaults auto-update:** if the platform redeploys and a project **has
    not overridden** a default, the project **receives the update** (it referenced ours,
    not a copy). Overridden → the project's own version wins. This is how one improvement
    reaches a million projects **without rebasing a million repos** ([[Q8]]).
  - **Versioning `itx` is a candidate, not settled.** _If_ we don't want to **brick existing
    integrations** on an API-incompatible change (e.g. to how default prompts are retrieved),
    we _might_ **version `itx`** — but that's an open **maybe** (Jonas: "I don't know"), not a
    locked decision. → [[Q17]].
    _This is the "referenced, override-by-exception" resolution of the [[D2]] tension: a
    project may fork/pin any piece, but by default it references the shared one. The layer's
    name is still open ([[Q7]])._
- **D19 [LOCKED]. The self-improvement loop: entry point → deterministic code → event →
  processor → LLM → code that commits to the repo.** Concretely: an entry point ([[D18]])
  runs **deterministic code** an LLM authored earlier (the project worker's `fetch`); that
  **usually just returns an HTTP response** (rendering the product's web pages —
  disambiguated by hostname, normal auth: _it's just a web application_), but it may also
  **append an event to a stream**. If a **processor is subscribed** to that stream, it makes
  **LLM requests**; the LLM produces an **`itx` script block** ([[D5]]); that script **runs
  code in the project's context**; and that code can call e.g. **`itx.repo.commitFiles`**
  (`itx.repo` is a top-level getter; the method is `commitFiles`/`edit` — _not_
  `itx.project.repo.commit`, corrected 2026-07-15), which **updates the project repo** — which
  is how the deterministic code itself changes.
  - **Protected main.** The agent may **not** land on live `main` directly: `main` on the
    artefact is a **protected branch** (the promotion gate of [[D14]], shaped like a GitHub
    PR review). Self-modification always flows through a repo commit onto a gated branch —
    never an instant, un-gated change to live code. _Reality check (2026-07-15): **not built
    on `main`** — `commitFiles` lands straight on the default branch with no gate
    (`repos/repo-durable-object.ts:301`). The loop's front half is real; the gate is
    aspirational. See the Reality-check appendix._
- **D21 [LOCKED · directional]. `itx` is assembled from mounts.** Capabilities are **mounted**
  onto `itx`, not hardcoded into one god-object. It's a **combination** today — the
  first-party API surface was written out directly because that was easier before the mount
  machinery existed — but **strategically `itx` should be assembled**. Userspace mounting
  **already works**: a project can **durably mount capabilities defined in worker files in
  git repos that sit at the same level as the platform's own** capabilities. So the
  first-party surface should migrate from hardcoded toward mounts over time. (Resolves [[Q4]]
  directionally; same referenced-module machinery as [[D17]]; the kernel provides the
  **mount primitive** plus the un-mountable capabilities — egress door, repo, identity.)

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
  _Reality check ✓ **shipped** (2026-07-15): `secrets/platform-secrets.ts` substitutes
  `getSecret(...)` references at the egress door, **host-allowlisted** (`secret_not_allowed_for_origin`),
  never-material, "no partial substitution escapes" (`:88`); the egress interceptor "sees
  getSecret(...) placeholders, never material" (`projects/egress.ts:5`)._

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

**event** — an immutable, past-tense fact appended to a stream, at a monotonically
incrementing **offset**; the only way to change durable state. Plain-language synonym: "a
fact."
_Avoid_: message (for the durable record), record.

**offset** — an event's monotonically incrementing position within its stream; the ordering
coordinate, and the optional precondition on `append` ([[D16]], [[D23]]).
_Avoid_: sequence number (colloquial only), index.

**stream** — an append-only log of events at a path, each event carrying a monotonically
**incrementing offset**; the unit of durable state and the **serialization point** (the one
total order everyone agrees on — [[D23]]). Plain-language synonym: "a log."
_Avoid_: journal (code sometimes says "journal" — standardize on stream), table.

**processor** — something that reads **one stream** and reacts: it reduces events into
reduced state and causes side effects. Processes **exactly one stream** for total ordering
([[D23]]). The browser UI, the CLI, and the agent are all processors ([[D22]]); an agent is a
processor with a prompt.
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

**agent** — a **stream with a preset of events appended** — nothing more. There is **no agent
data structure**; appending the right set of events turns an inert stream into an agent
([[D20]]). Equivalently, "a processor with a prompt," where the prompt and wiring arrive _as
events_.
_Avoid_: agent object, agent config (there is no such structure).

**mount** — a capability attached onto `itx`. Capabilities are **mounted** (from the platform,
or from a project's own worker files in git repos at the same level), not hardcoded ([[D21]]).
_Avoid_: —

**capability** — a callable reference that lets code do something (call a tool,
reach another entity, hit the network); you have authority because you hold it.
_Avoid_: permission, binding.

**project** — one iterate entity: its own identity, streams, code, and secrets, and
the single trust boundary. Nothing inside a project is hidden from anything else
inside it ([[D1]]).
_Avoid_: tenant, workspace, org, account.

**repo** — a git repository owned by a project.
_Avoid_: —

**config repo** — _the_ project's config repo: the git repo holding the project's own
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

**kernel** — the part of the system that _cannot_ be built in userspace, plus the
two-or-three things that could be but are too essential to leave out; small on
purpose ([[D2]]).
_Avoid_: **seed** (rejected).

### Flagged ambiguities (names still open)

- **The non-kernel layer** has no agreed name — **not "packages"** (implies npm). → [[Q7]]
- **kernel vs core** — resolved _against_ "seed"; final pick between the two still open.
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
  (concurrency), [[D16]] (`processEvent` = the read/react primitive), [[D20]] (an agent = a
  preset of events on a stream).
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
- **Decisions:** [[D2]], [[D13]], [[R7]] (TS-like), [[D17]] (referenced defaults through
  `itx`; itx-versioning a candidate — [[Q17]]).
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
  normal reaction path. There is no separate `reconcile` _kind of thing_; it's the
  same job (make the world match the reduced state) under a different trigger. Keep
  the alarm; drop `reconcile` as a distinct method. Nuances that survive as
  _mechanics, not concepts_: act only when at head; re-drive with idempotency keys.
  _Reality check (2026-07-15, read the code): in current `main`, `reconcile` **is** still a
  distinct hook — `streams/stream-processor.ts:463` (overridden by the agent at
  `agents/agent-processor-implementation.ts:462`, called per-batch at `:553`), doing
  desired-vs-actual re-drive of open LLM obligations (the [[Q3]] pattern: expire / settle /
  backstop / reschedule). The design's "no separate reconcile" matches the in-flight
  **stream-processor runner redesign** that removes `reconcile`/`processEventBatch` — i.e. the
  doc describes the **target**, not today's main. The substance (obligation re-drive) is
  shipped; only the packaging (a hook vs. a normal-path wake event) is in flux._
- **Q3 — Event-pair convention. [RESOLVED → convention].** Durable side effects only:
  `<verb>-requested → <verb>-completed { outcome }` — two events, outcome is data (not
  three). Reduced state tracks open ones; wake re-drives them ([[D3]]). **Pair only
  durable effects; plain queries stay normal calls** (no added latency). A convention,
  not a framework. _(Not important / not blocking — parked per Jonas.)_
- **Q4 — Built-ins as mounts. [RESOLVED direction → [[D21]]].** `itx` should be **assembled
  from mounts** (directionally B), not a hardcoded god-object — a **combination** today
  (first-party surface hardcoded for expedience), migrating to mounts. Userspace mounting
  already works (capabilities from worker files in git repos at the same level as platform
  ones). Dissolves the ~6k-line describe-file. Still open: perf of many mounts; the
  `__describe` story.
- **Q5 — Config worker sync/async + stateless vs Durable Object. [RESOLVED → [[D16]]].**
  The substrate is two primitives, `append` + `consume`. `append` waits for durability
  (inherent); waiting for a _reaction / outcome_ is just consuming until the named event
  appears — "it just depends," nothing forces a block. `processEvent` is the read/react
  primitive; `waitFor` and server-side filters are optimisations. So the worker needn't be a
  resident DO to block/coordinate — **stateless stands** ([[R13]]); the DO is only the
  **ordering point**. Placement (stateless vs DO) is an optimisation, not a fundamental.
- **Q6 — Do "other repos" need the repo abstraction at all?** [[R3]] says work on
  many repos; maybe only the _config_ repo is special and the rest are "just use
  GitHub + octokit like a normal person."
- **Q7 — What do we call the non-kernel layer? [upgrade/override contract RESOLVED →
  [[D17]]; naming still open].** Mechanism settled: the layer is **referenced through
  `itx`** (auto-updates unless overridden; itx-versioning for breaking changes is a candidate
  — [[D17]] / [[Q17]]).
  Still open: the **name** (not "packages" — implies npm) and the line between a deep
  first-party module and a leaf extension.
- **Q8 — Updating a million projects. [RESOLVED direction → [[D17]]].** Don't rebase a
  million repos: shared defaults are **referenced behind `itx`** and **auto-update unless
  overridden**; API-incompatible changes _might_ be handled by **versioning `itx`** ([[Q17]]
  — open). (Still to detail: channels vs pins, canary/rollout policy, forced security pushes.)
- **Q9 — Make expressions look like TypeScript** ([[R7]]) — how, exactly, while
  keeping the grammar tiny (get + call, no loops, no eval) and bind = an enforced
  constraint (not object-merge)?
- **Q10 — The plain framing. [RESOLVED].** Lead with _what it is/does_ (a
  self-improving AI entity that can do anything a human-with-a-computer can, and gets
  better); put the mechanism (HTTP in → state → HTTP out) _second_. Don't open with
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
  open].** We _need_ this primitive (secure-enclave proof of human approval); it gates
  **promotion** and **high-risk egress**, and is used rarely. Open mechanics: what the
  signature actually attests (key-possession vs physical-presence vs informed-consent vs
  legal-identity — different claims), which **attested UI** shows the canonical bytes, and
  what stops a **destination-swap** between approval and execution. ([[WA2]], [[D14]].)
- **Q16 — Event dimensions (delivery / TTL / side-effects). [RESOLVED direction; TTL
  pinned].** "Ephemeral" decomposes into **explicit** properties, not a hard type
  ([[D11]]): (1) **delivery** — high-freq lanes excluded-by-default from push, pull, and
  `waitFor`, opt-in via the `subscribe` signature; (2) **side-effects** modelled
  **explicitly** (`sideEffects: "disallow"`), _not_ derived from TTL (least surprise);
  (3) **TTL** (null = forever, 0 = deletable) — concept set, **implementation pinned for
  the detailed stream design** (with R2 offload for >10 GB streams). **PIN: do not design
  TTL / offload mechanics now** — return to the big picture. _Still parked: is a live
  voice **transcript** durable (kept forever) or throwaway (only the final one durable)?_
- **Q17 — Should `itx` be versioned?** Open (Jonas: "I don't know"). _If_ we don't want to
  brick existing integrations on an API-incompatible change to the platform surface, we might
  version the `itx` contract — but it's a **maybe**, not a decision ([[D17]]).

---

_Parking lot (on the shelf, not lost): the "wild ideas" (entity-is-a-file,
hire-companies, shadow-selves, time-travel debugging, the-project-as-a-filesystem)
and their 6-judge vote live in the exploration pile. We pull them in only if/when a
requirement or belief here calls for them._

---

## Reality check — design vs. `main` (2026-07-15)

_A 5-agent code audit (`apps/os/src/domains/…`, ~480k tokens, 138 tool calls) verified all 39
locked decisions/requirements against the current code. **Decisions & requirements describe the
design — "locked" means decided, not built; this appendix records what's actually shipped.**
Tally: **8 shipped verbatim · 17 real-mechanism (some framing aspirational) · 11 partial · 1
target (in-flight redesign) · 2 fully aspirational.**_

**The substrate spine is real (shipped verbatim, doc == code):** [[D4]] (config worker =
`{fetch, processEvent}`), [[D5]] (agents produce only code — codemode, no JSON tool-calls),
[[D12]] (pre-commit rejection is kernel — the strongest-grounded claim), [[D16]] (append + CAS
offset precondition), [[D20]] (agent = a preset of events, no agent object), [[D23]] (one
processor : one stream + cross-post), [[R6]] (eviction recovery: idempotency keys + keepalive
alarms + obligation re-drive, tested), [[R13]] (stateless ingress, DO is egress-only).

**The gaps that matter most — where the doc claims more than `main` delivers:**

- **[[D14]] the membrane — only 1 of 4 legs built.** Shipped: **cryptographic human-approval**
  (Secure-Enclave ECDSA P-256, `projects/egress-approvals.ts`). **Not built:** the
  protected-main promotion gate (leg 1) and **spend caps / kill-switch / money-spent event**
  (leg 2 — the [[R14]] primitive we pinned). Loop control (leg 4) is inline in the agent, not a
  platform membrane. The unified "four-thing kernel object" doesn't exist yet.
- **[[D19]] protected main is aspirational** — `commitFiles` lands straight on the default
  branch, no gate (`repos/repo-durable-object.ts:301`). (API name corrected inline:
  `itx.repo.commitFiles`, not `itx.project.repo.commit`.)
- **[[R16]] BYO-OpenAI — the flagship example isn't real.** Out-of-box iterate keys ship, and
  BYO works for arbitrary third-party secrets, but "bring your own OpenAI account, iterate steps
  aside" is **not** implemented — the lane misleadingly named "BYOK" (`workers-ai-transport.ts:33`)
  is still iterate's own key. No surcharge accounting.
- **[[R10]] export + [[R17]] run-on-your-own-account — zero scaffolding** (no exporter, no
  placement code). Both are "must stay possible," so expected — but nothing today.
- **[[D11]] event dimensions — still one `ephemeral: true` boolean** (`streams/schemas.ts:73`),
  the "wishy-washy type" D11 says to replace. No `sideEffects` flag, no TTL. D11 is the target.
- **[[R12]] concurrency is cross-agent, not intra-agent** — many agents run in parallel, but one
  agent stream is **deliberately single-flight** (one `currentRequest`, supersede-without-dialing).
- **[[R4]] voice — the ephemeral lane is built, the PCM/audio pipeline is not** (zero codec code).
- **[[Q2]] reconcile is still a distinct hook** on `main` (`stream-processor.ts:463`) — matches
  the in-flight runner redesign that removes it; the doc describes the target.
- **[[D13]] / [[D6]] "structural, not guarded"** is really "structural **and** redundantly
  guarded" — sub-targets also `assertCanAccessProject` at construction (belt-and-suspenders on an
  inherited, never caller-supplied id; the spirit holds).
- **[[D22]]** browser UI + agent genuinely share one `StreamProcessor` base; the **CLI is not** a
  processor today (it's an itx/RPC client) — the enshrined "CLI is a processor" is the aspiration.
- **[[D24]]** loop detection lives **inline** in the agent, not as the "completely independent
  processor" the example cites (the distributed-independence _philosophy_ is real, that instance isn't).
- **[[D10]]** secret substitution ships; the **"secret jail" raw-access worker doesn't** —
  HMAC/signing runs as trusted strategies inside the Secret DO, not user code in a jail.

**Real-mechanism, aspirational-framing (core shipped, slogan is doc gloss):** [[D3]], [[D7]]
("four systems in one" is a conceptualization), [[D9]] (per-payload, not an envelope field),
[[D25]] (events-as-durable-API sits _beside_ a large itx RPC surface), [[D8]] (fan-in, not one
literal loop), [[D2]] (real split, but the tiny-kernel _ratio_ is the target — first-party itx is
still hardcoded), [[D17]] (referenced-defaults shipped for agents; general case is [[D21]]-directional),
[[D21]], [[D15]], [[D1]], [[R1]], [[R2]], [[R3]], [[R18]].

_Full verdicts (id · status · `file:line` evidence) are in the audit output. Bottom line: the
**event/stream/agent core is built and matches the doc**; the **safety membrane, portability, and
BYO-sovereignty layers are designed but largely unbuilt** — which is honest for a forward-looking
design doc, now labelled as such._

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
  subscribers explicitly request those events; otherwise they're excluded from _both_
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
- ✅ [2026-07-15, terminology + precondition] "We do have a precondition on append. You
  don't append an event, you append an **event input**. The event input can contain an
  offset — that's your precondition, optional; if you put in an offset it means 'only append
  if the stream hasn't moved.' Also, instead of 'consume' we say **`processEvent`**
  everywhere — that's what we currently call this." → updated [[D16]] (append an event input
  - optional offset precondition; read primitive = `processEvent`, not consume); taxonomy:
    append, event input, processEvent (Avoid: consume).
- ✅ [2026-07-15, referenced layer + itx versioning] "This would be like a microservices
  architecture. The shared non-kernel layer is referenced. E.g. the default system prompt is
  something the project worker can pull out of its `itx` binding and then modify however they
  please. It does mean if we redeploy and the default has not been overridden, that update
  will be received. It also means if we make an API-incompatible change — e.g. in how these
  default agent prompts are retrieved from the platform — we will need to version our `itx`."
  → new [[D17]]; resolved-direction [[Q8]] + [[Q7]] (upgrade/override contract).
- ✅ [2026-07-15, two entry points + the self-improvement loop] "From the outside world the
  only thing that comes in is an HTTP request → deterministic code → the project worker's
  `fetch`. The only other thing that can happen is an internal clock event — a Durable Object
  alarm. The only two entry points to the entire system are an HTTP request from outside or an
  alarm from inside; everything else is triggered by one of those two — which is amazing. (An
  HTTP request could also hit the control plane, os.iterate.com — we could refactor this.)
  When an HTTP request comes in, deterministic code an LLM once said should run executes; it
  can produce an event on a stream, or more often just an HTTP response rendering a web page
  (disambiguated by hostname, normal auth — just a web application). If the event lands on a
  stream a processor is subscribed to, that processor does LLM requests; the LLM produces an
  `itx` script block; the script writes code that runs in the project context; the code calls
  something like `itx.project.repo.commit` that updates the project repo — that's how the
  deterministic code gets updated. We could say the agent is not allowed to land live main —
  a protected main branch on the artefact; probably a good idea. (Cloudflare also has queue-
  and email-consumer entry points, but they don't apply to projects as written.)" → new
  [[D18]] (two entry points) + [[D19]] (self-improvement loop + protected main); §1 anatomy;
  refined [[D14]] (protected main), [[D5]].
- ✅ [2026-07-15, control plane as an organism — north-star] "In the limit the control plane
  could be another organism. In the beginning we don't want that — it makes it too easy to
  basically break everything, because it would be providing its own platform, and that's
  risky. But that should be a stated design vision, something to aspire to. Just as an
  example, we intend to run our entire company on this iterate config repo." → new [[R15]] +
  North-star note (§2), with the company-level (intended) vs platform-level (deferred)
  distinction; answers I8.
- ✅ [2026-07-15, agent = events (ENSHRINED) + itx assembled from mounts] "The thing that
  turns a stream into an agent should simply be a few events. Instead of a big agent data
  structure, you take an array of events as a preset and append it to a stream; it then starts
  calling a processor that appends events. The thing that separates a stream that does nothing
  from the most powerful coding agent in the world is just a set of events — that needs to be
  enshrined and unshakable. Jonas said this and it shouldn't change. On `itx`: it can be a
  combination, but directionally assembled-from-mounts (B) is better; it just needed machinery
  we didn't have, so it was easier to write out the first-party surface. It's already possible
  to durably mount capabilities defined in worker files in git repos at the same level as the
  platform ones. Strategically it should be assembled." → new [[D20]] (agent = events,
  ENSHRINED) + [[D21]] (itx assembled from mounts); resolved [[Q4]]; taxonomy: agent, mount.
- ✅ [2026-07-15, hold the line: everything is a stream processor + one-stream ordering] "Yes
  completely — we are going to completely hold the line on event sourcing. Events exist in
  streams with an incrementing offset. The browser UI is a stream processor, our CLI is a
  stream processor, our agent is a stream processor — this should be loud and clear. Each
  stream processor can only process events from one stream, because that's the only way to
  guarantee order. A stream is a serialisation point; if you want to consume from five streams
  you have to cross-post. Events will be duplicated in multiple streams and that is fine —
  storage is cheap and architecturally this gives perfect ordering: within a stream we always
  agree on the exact order in which things happen." → new [[D22]] (everything is a processor,
  ENSHRINED) + [[D23]] (one processor : one stream, cross-post only); reaffirms [[D3]];
  taxonomy: offset added, stream/event/processor sharpened.
- ✅ [2026-07-15, correction] "I'm not saying `itx` IS a versioned API — I'm saying that IF we
  didn't want to brick people's existing integrations, we should maybe version `itx`. I don't
  know." → softened [[D17]] (itx-versioning downgraded to a candidate); added [[Q17]].
- ✅ [2026-07-15, bring-your-own-everything / rent the kernel] "In the future you should be
  able to run a project in your own Cloudflare account — the connection to our platform could
  use Cap'n Web. You should be able to access any third-party API ideally through iterate's own
  integration where we charge a pass-through fee — but you must be able to override this in
  userspace: if you don't want our OpenAI key or our surcharge, you don't have to. Works out of
  the box, but overrideable, and that extends to secrets — bring your own account, your own
  Cloudflare, your own OpenAI, everything. At that point you're really just renting the kernel
  from us. It's wishy-washy and not day-one (we won't have access to your artefact bindings),
  but directionally what we want." → new [[R16]] (out-of-box-but-overridable integrations) +
  [[R17]] (run on your own accounts / rent the kernel); sharpens [[R10]].
- ✅ [2026-07-15, distributed system + events-are-the-API + renting the wall] "We are basically
  building almost like an agent harness as a distributed system. We embrace the distributed
  nature because we want things to independently degrade or fail — one stream processor
  implements basic agent turn-taking, another completely independently implements loop
  detection. A big part of that: the events are the API. There's no separate API. We might have
  convenience functions that wrap append, but the events are the API — that's how you interact
  with the system. 'Renting the wall' is not a bad way to put it (we might have a mobile app).
  Things we bring: first-party pre-approved OAuth clients like a Google OAuth client, a nice
  mobile app. I do think we'd want all the streams to live in the other Cloudflare account —
  they'd be running our code, and like a normal enterprise deployment you then update their
  code. Could still work quite well. And when you say interface [for the kernel], that's
  abstract — why would these all be on one interface? How could you append without first
  authenticating?" → new [[D24]] (distributed system), [[D25]] (events are the API), [[R18]]
  (what iterate brings / walls); refined [[R17]] (streams in customer's CF account, enterprise
  model); kernel = a capability _chain_ (authenticate → itx → append), not a flat interface
  ([[D13]]).
- ✅ [2026-07-15, git-repo-everything + kill last-RPC + entity-file + hire-companies] "I'd like a
  subagent to explore how feasible it'd be to use Git LFS and not persist ephemeral events — just
  say everything is a Git repo, including file attachments and the search index. How crazy is
  that? It would simplify things massively. Probably can't commit per event (billions in prod) but
  maybe — probably not impossible. Another version: the config repo contains durable references
  that ARE committed, referencing which files in R2 / external resources exist. The last RPC
  doesn't work — we lean into JavaScript with rich types: we pass request/response streams and
  rich JS objects through RPC boundaries; not everything serialises into events, but that's good —
  you get code natural for the LLM. Entity as a file is a really cool idea to move toward. Hire
  software companies I don't really get — that's the endgame, ignore for now." → launched research
  subagent (everything-is-git); ❌ killed the-last-RPC + bounded [[D25]] (events = durable, RPC =
  rich ephemeral); entity-is-a-file = confirmed direction; hire-companies = endgame/ignore.
- ✅ [2026-07-15, inter-org + the edge is graded] "A short-term goal: companies should be more
  efficient if they both have iterate — 'let my iterate talk to your iterate, good things should
  happen.' And interacting with the outside world you DO need a trust boundary: what can the third
  party see? what am I allowed to show them? am I being tricked? Inside a project everyone trusts
  each other — employees, or partners in a marriage using it as a family butler, all have all the
  information — but the system interacts with the outside world and there are stakeholders of
  different trust levels." → ⚡ near-term inter-org goal; clarified [[D1]] (interior binary, outside
  graded — the edge manages disclosure + deception-detection).
