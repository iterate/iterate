# iterate — the interview (append-only)

> **What this is.** A running, append-only transcript of Claude interviewing Jonas to
> harden `DESIGN.md`. Format: each entry is a **Q** (with concrete code / a hypothetical),
> Jonas's **A** (his honest answer, captured close to verbatim), and a short **→** note
> on what it changes in `DESIGN.md` (which Belief / Requirement / Decision / Taxonomy /
> Open-question it feeds). Ideas Claude floats are marked **[idea]** with pros/cons.
>
> **Rules.** Append only — never rewrite a past Q&A. The **Backlog** at the very bottom is
> the one living list (questions Claude still wants to ask); it gets rewritten freely.
> Entries are numbered I1, I2, … so we can point at them.

---

## Session log

<!-- entries appended below, oldest first -->

### I1 — Are the event dimensions really 3 independent knobs, or is side-effects derived from TTL?

**Asked.** You said side-effects-allowed feels "tied to TTL — a bit messy." My candidate
resolution: there are only **two independent knobs** — _delivery_ (broadcast vs opt-in)
and _retention/TTL_ (durable vs expiring) — and **side-effects-allowed is _derived_, not
set.** The reason it couples to TTL is [[R6]]: side effects survive eviction by being
**re-driven from the log on wake** (idempotency-key re-drive of an open obligation). You
can only re-drive an obligation whose triggering fact is **still there** — so an event
that will age out **must not** be the sole cause of a durable side effect. Hence
"no side effects" ⟺ "will expire", by the recovery model, not by accident.
Concrete trace posed: an inbound **voice call** — PCM chunks at ~50/sec, a transcription,
a "book the meeting" side effect, TTS chunks back out — which dimension is set how on each
of those five kinds of event?

**A:** Agrees the recovery logic _couples_ side-effects to TTL — but **rejects _deriving_**
the flag from TTL, on **principle-of-least-surprise** grounds ("this event has TTL 0 and
_therefore_ doesn't run through processEvent" is surprising; `sideEffects: "disallow"` is
obvious). So model side-effects **explicitly.** "Ephemeral" = colloquial combination of
(a) **excluded-by-default from subscriptions** — the one that matters now: high-freq
chunks are opt-in via the `subscribe` signature for **push, pull, _and_ waitFor**, so a
quick `itx.subscribe` isn't flooded; (b) **TTL** (null=forever, 0=deletable; implementation
**deferred** to detailed stream design, + R2 offload for >10 GB); (c) explicit side-effects
flag. Left the durable-transcript sub-question unanswered → **pinned.**
**Meta-instruction:** stop asking hyper-detailed questions — ask **broad, directional**
ones; when he volunteers a detail, _then_ go deeper; file parked detail here and return to
the big picture.

**→** refined [[D11]]; [[Q16]] resolved-direction + TTL pinned; saved feedback memory
(broad-strokes interviewing).

### I2 — Is there a part of the organism it's _not allowed_ to change? (the membrane)

**Asked (broad):** does a digital organism have a tiny un-editable membrane, held by the
platform, à la DNA-repair / apoptosis in a cell?
**A:** **100% yes — there must be guardrails.** Contents: (1) **crypto human-approval**
(secure enclaves) — for legal constraint, taken seriously, used rarely; gates
merge/push-to-main (PR-review-like) and high-risk egress (large Stripe refunds via egress
policy); (2) **spend control** — a key human-world input, implicit (LLM) + explicit
(virtual cards, third-party, infra); a big missing primitive; spend also happens in
third-party systems → a **money-spent event** on any stream, tagged, aggregated at levels,
with a global **kill switch**; argues for per-project third-party API keys + possibly
**per-project Cloudflare accounts** so infra spend is capped per customer; (3)
**runaway/loop controls** requiring human sign-off; (4) the **live-version pointer = the PR
idea**. "Everything needs to be able to grind to a halt."
**→** new [[D14]] (the membrane), [[B5]] (spend ceiling = human input), [[R14]] (uniform
spend tracking + halt), updated [[R10]] (spend containment), [[Q15]] elevated. **Pins:**
membrane name; money-spent-event mechanics.

### I3 — What physically forces the organism through the one egress door?

**Asked (broad):** is the egress door a physical chokepoint code can't route around, or a
door we ask it to use? Does that mean sandboxing even trusted git-repo code?
**A:** **Emphatically physical, and yes — all code is sandboxed.** "At the network level
there must be NO way to fetch the internet without going through our gate." Mechanism = a
**programmable man-in-the-middle SSL egress proxy** at the project boundary — like
**draconian enterprise security** (log, capture/store all egress, filter, data-mine, DLP).
The code runs in a **sandbox**: a Cloudflare **dynamic worker**, or a **VM / Cloudflare
container with egress interception**. Cloudflare general-purpose sandboxes **force egress
through the container Durable Object** whose `fetch` is the MITM proxy; a **borrowed Mac**
lent to the project has its egress forced through the gate too. No un-proxied path out,
from anywhere. Secrets that mutate the world: the **agent must never see them** (like human
devs never seeing prod secrets; far-future exception: briefly, when the agent creates one).
Also volunteered: **spend is transitive** — sub-budgets with "come back to me when the $20
is gone."
**→** new [[D15]] (egress = programmable MITM SSL proxy + sandboxed code + forced routing),
refined [[R14]] (transitive budgets), [[D10]] (never-see), §7.7, §7.9. Pin: what MITM SSL
rules out (cert pinning); DLP policy surface.

### I4 — Do we wait for the reaction? → the two primitives

**Asked (broad):** does `append` wait for the reaction, or just for durability? Is the
config worker a stateless function or a resident Durable Object?
**A:** You **must** wait for durability (for sure). Waiting for the _whole reaction_ — "it
just depends." The **fundamental operations are just two: `append`, and `consume`** a
stream from a starting offset (check every event). Everything else is an **optimisation**
on top: "append waits for durability but you wait for outcomes yourself" is expressible as
consume; server-side filters (JSONata / a discrete type filter) are just _faster_ ways to
do consume-and-check — "logically that's what this is, that's what we're building."
**→** new [[D16]] (two primitives: append + consume; `processEvent` = hosted consume,
`waitFor` + filters = optimisation); [[Q5]] **resolved** (stateless stands, DO is only the
ordering point; placement is an optimisation). Taxonomy: `append`, `consume` (+ flagged:
consume vs subscribe).

### I5 — Precondition on append + terminology (consume → processEvent)

**Asked (broad):** do `append` + `processEvent` cover queue-claim + conditional-write, or is
there a hidden third primitive?
**A:** **Precondition already exists.** You don't append an event — you append an **event
input**, which can carry an **offset** = an optional precondition ("only append if the
stream hasn't moved"). That's the compare-and-swap → exclusive claim (queue) and conditional
write (db) from the one primitive. **Terminology fix:** we don't say "consume" — we say
**`processEvent`** everywhere.
**→** updated [[D16]] (append takes an event input + optional offset precondition; read
primitive is `processEvent`, not consume); taxonomy: `append`, `event input`, `processEvent`
(Avoid: consume); resolved the consume-vs-subscribe flag.

### I6 — How does one improvement reach a million self-editing projects?

**Asked (broad):** is the non-kernel layer referenced (central, pinned/channel) or copied
into each repo? Does referencing betray "the repo IS the organism"?
**A:** **Referenced — like a microservices architecture.** The shared layer lives behind the
project's **`itx` binding**; a project **pulls a default out of `itx`** (e.g. the default
system prompt) and modifies it however it likes. If the platform redeploys and a default
**wasn't overridden, the update is received**; overridden → the project's own wins. And
**`itx` is a versioned API** — an API-incompatible change (e.g. how default agent prompts are
retrieved) means **versioning `itx`**.
**→** new [[D17]] (non-kernel layer referenced through itx; override-by-exception;
auto-update-unless-overridden; itx versioned for breaking changes); resolves the
upgrade/override contract in [[Q7]] and the fleet-update direction in [[Q8]] (layer **name**
still open).

### I7 — Walk through self-improvement → the two entry points

**Asked (broad):** trace the loop from event → new live code; how do concurrent improvements
not clobber each other?
**A (reframed upward):** **The whole system has exactly two entry points — an inbound HTTP
request (to a project's `fetch`, or to the control plane os.iterate.com) and an internal
Durable Object alarm.** Everything else is triggered by one of those two ("amazing… very
important — put it in the anatomy section"). The loop: HTTP/alarm → deterministic `fetch`
(LLM-authored) → _usually_ an HTTP response (web pages, hostname-disambiguated, normal auth —
"just a web application"), _sometimes_ an **event on a stream** → a **subscribed processor**
→ **LLM** → an **`itx` script block** → runs code → **`itx.project.repo.commit`** updates the
repo → deterministic code changes. **Protected main:** the agent can't land live `main`
directly — a **protected main branch on the artefact** (the [[D14]] gate). (Cloudflare
queue/email consumers exist but don't apply to projects.)
**→** new [[D18]] (two entry points) + [[D19]] (self-improvement loop + protected main); added
to §1 anatomy; refined [[D14]] (protected main), [[D5]]. (My compare-and-swap-pointer framing
→ he prefers the git-native **protected main branch**; concurrent _stream_ writes still
ordered by the offset precondition, [[D16]].)

### I8 — Is the control plane itself just another organism?

**Asked (broad):** iterate-on-iterate — is os.iterate.com just a privileged project or a
different species? Worry: a bug in "the platform project" takes down everyone.
**A:** Draw the distinction. **Company-level dogfooding is intended & near-term:** "we intend
to run our **entire company** on this iterate config repo" — Iterate's own operations as an
organism (safe; no circular platform dependency). **Platform-level self-hosting is the
north-star, deferred:** in the limit the control plane could be another organism, but not at
the start — a platform providing its own platform is too easy to break all at once. "That
should be a stated design vision."
**→** new [[R15]] (don't foreclose platform self-hosting) + a **North-star** note in §2 with
the company-vs-platform split; "platform-eats-itself" promoted from wild-ideas to a stated
vision (platform level deferred; company level intended).

### I9 — What determines the shape of `itx`? + the enshrined "agent = events"

**Asked (broad):** is `itx` a hardcoded god-object or assembled from mounts? Who can mount?
**A (itx):** **A combination, but directionally assembled from mounts (B).** It just needed
machinery they didn't have, so the first-party surface was written out directly. **Userspace
mounting already works** — a project can durably mount capabilities defined in **worker files
in git repos at the same level as the platform's**. Strategically → assembled. (→ [[D21]];
resolves [[Q4]].)
**A (volunteered, ENSHRINED):** **The thing that turns a stream into an agent is simply a few
events.** No agent data structure — take an **array of events as a preset**, append it to a
stream, and it starts driving a processor that appends events. "The thing that separates a
stream that does nothing from the most powerful coding agent in the world is just a set of
events" — **enshrined, unshakable; Jonas said this and it shouldn't change.** (→ [[D20]].)
**→** new [[D20]] (agent = events, ENSHRINED) + [[D21]] (itx assembled from mounts); [[Q4]]
resolved; §2 + taxonomy (agent, mount) updated.

### I10 — Is the whole agent lifecycle just events? → hold the line completely

**Asked (broad):** is birth / config / subagent / death / roster nothing but events, with
spend as the only bound?
**A:** **Yes completely — hold the line on event sourcing.** And two things loud and clear:
(1) **everything is a stream processor** — the browser UI, the CLI, the agent all are; (2)
**a processor processes exactly one stream** (the only way to guarantee order — the stream is
the **serialization point**); to combine N streams you **cross-post**, so events are
**duplicated across streams and that's fine** (storage cheap) — the payoff is **perfect
per-stream ordering**. Events carry an **incrementing offset**.
**→** new [[D22]] (everything is a stream processor, ENSHRINED) + [[D23]] (one processor : one
stream; cross-post the only multi-stream mechanism; duplication fine); reaffirms [[D3]]; §2 +
taxonomy (offset added; stream / event / processor sharpened).

### I11 — Bring-your-own-everything / renting the kernel

**Volunteered (asked to lock):** (1) **out of the box, overridable:** any third-party API is
reachable **through iterate's integration** (pass-through fee) but **every one is overridable**
— BYO OpenAI key / account / secrets, no forced surcharge (a **key requirement**); (2) **run
on your own accounts (future):** a project must be able to run in **your own Cloudflare
account** (platform↔account over **capnweb**), BYO everything → at the limit **you're renting
only the kernel** — fuzzy, directional, not day-one (no access to your artefact bindings yet).
**→** new [[R16]] (out-of-box-but-overridable integrations & billing) + [[R17]] (BYO
accounts / rent the kernel); sharpens [[R10]]; connects [[R15]] north-star, [[D2]] kernel.

### I12 — Distributed system + events-are-the-API + renting the wall + kernel-as-chain

**Volunteered asides (locked):** (a) **we build the agent harness AS a distributed system** and
embrace independent degradation/failure — turn-taking in one processor, loop-detection in
another, fully independent → [[D24]]; (b) **the events ARE the API** — no separate RPC;
convenience fns may wrap `append`, but the event vocabulary is the interface → [[D25]].
**On the kernel / self-hosting:** **"renting the wall" is a good framing** (we also bring a
mobile app + first-party pre-approved OAuth clients — [[R18]]). Self-host = **streams + our code
run in the customer's Cloudflare account**, enterprise-on-prem style (they run our code, we push
updates) → refined [[R17]].
**Corrected my code:** the kernel is **not one flat `interface`** — "how could you append
without first authenticating?" It's a **capability chain** (authenticate → session → itx →
append/processEvent/mount) — ocap acquisition ([[D13]]), not a bag of methods.
**→** new [[D24]], [[D25]], [[R18]]; refined [[R17]]; ⚡ renting-the-wall spark; kernel redrawn
as a chain.

---

## Explorations (unstructured — the crazy ideas)

_Mode shift (Jonas, 2026-07-15): **stop locking; explore broadly.** Pump intuition on the wild
ideas from `big-ideas.html` + the research / lens markdown (VFS, entity-is-a-file,
hire-companies, shadow-selves, time-travel, mind-is-a-fold, the-last-RPC, …). Claude offers
multiple-choice futures / its own crazy takes; when Jonas says something interesting, capture
it here as a **⚡ spark** and confirm it's worth retaining — promote to DESIGN.md only if it
hardens. These are **not decisions.**_

<!-- ⚡ sparks appended below -->

⚡ **A personal organism for everyone (+ groups)** (2026-07-15, Jonas: "could be cool"). Ambition:
every **person** AND every **group** has their own organism (project); a tutor / startup / family
are other organisms they **federate** with (my-iterate ↔ your-iterate). **Platform-knows-about-users?**
Jonas: "might have to — not sure." Claude's resolving take: the platform already knows **identities**
(`authenticate → session → project claims` — who you are, which projects you can reach); a _per-product
user_ (customer #4823 of Acme) stays **userspace** (config-worker `fetch` auth). So **platform =
identity** (cross-project, for federation / SSO); **userspace = product-user**. OPEN + deep: is a
person's **identity == their personal organism** (auth = waking your own organism), or separate?

⚡ **Multiplayer self-rewriting game** (2026-07-15, Jonas: "I love this idea"). A game lots of
people play together AS an iterate organism: the world = a shared stream, each player = an agent
(reachable from any channel — [[DESIGN:R19]]), NPCs = agents with memory, real-time via ephemeral
lanes ([[DESIGN:D11]]). **The magic: the world's RULES are code a Game-Master agent rewrites as
people play** — players blindly _program_ the world through play; rule changes go through
protected-`main` so a bad rule rolls back ([[DESIGN:D19]]). Real stakes via egress + membrane; the
whole world is replayable/forkable (time-is-a-place). Flavors: **Prayer-Engine** (pray → the god
edits physics), **Constitution** (laws are code, players amend by vote → organism rewrites itself),
**Escape-room-that-fights-back** (patches itself to stay just-unsolved). → jamming.

⚡ **Self-funding organism** (2026-07-15, Jonas: "really cool… very very very cool" — crazy-future).
An organism that **collects money** (charging players/customers via egress + a payment processor)
and uses it to **pay its own bills** (LLM / compute / infra / virtual cards, gated by the spend
membrane [[DESIGN:R14]]). Two forms: a **blockchain** wallet/treasury (truly sovereign,
un-de-platformable, could even issue its own token) or **just a money pile** (a Stripe-backed
balance it draws down). Generalizes the self-funding game — any organism that charges > costs is
**economically autonomous**, which makes the **spend membrane (D14 leg 2, currently UNBUILT) the
load-bearing safety primitive** for the whole class. Ties to sovereignty ([[DESIGN:R17]]).

⚡ **The irreducible core = ~6 verbs + 1 wall** (2026-07-15 synthesis, answers the founding "why
so heavy?"). The reality-check proved the durable core is tiny: `authenticate → itx`;
`append(eventInput + optional offset CAS)`; `processEvent` (one stream); `fetch` (one HTTP verb,
direction by hostname); `mount`; `repo.commitFiles` — plus the **egress wall** (forced outbound,
not an API you call). Everything else (agents, integrations, dashboard, secrets) is built from
those. **So "it feels too heavy" is NOT the core** — it's the **262 KB hardcoded `itx` surface**
(`rpc-targets.ts`). [[D21]] (assemble `itx` from mounts) is literally the plan to dissolve that
surface; the reality-check says the machinery exists but the migration hasn't run. → **"make it
simpler" = finish moving the surface into mounts, not redesign the core.** Highest-leverage next
move: prove one fat branch of `rpc-targets.ts` (integrations / secrets / docs) can live as a mount.
Honest caveat: two things can't shrink into the six verbs — the egress **wall** (infra, not an API)
and the rich **itx RPC tree** for non-serializable handles/streams ([[D25]], capnweb).

⚡ **"Renting the wall"** (2026-07-15). Jonas likes framing the rentable kernel as **walls you
run inside** rather than an API you call — because iterate also brings a **pre-built surface**
(first-party pre-approved OAuth clients like Google, a mobile app). **Self-hosting model:**
streams + iterate's code run in the **customer's own Cloudflare account**, enterprise-on-prem
style (they run our code; we push updates). → hardened into [[R17]] / [[R18]]. Still fuzzy:
kernel-as-walls vs kernel-as-API, and whether the walls stay tamper-proof when the customer
runs our code on their own metal. → Jonas: **probably fine, future issue — not now** (walls
degrade from "security we enforce" to "safety we provide"; deferred).

⚡ **Shadow-selves promotion gate** (2026-07-15). Before promoting candidate code, **replay the
organism's recent life through it (side-effects jailed) and compare** — a far better gate than a
synthetic smoke test, and it needs no new infra (events [[D23]] + sandbox [[D15]] + `sideEffects:
disallow` [[D11]]). **Jonas's key refinement:** most recent events are _produced by the organism
itself_, so replaying those is circular — **replay the EXTERNAL-interface events** (the raw
exogenous inputs — webhooks, emails, HTTP; = [[D12]]'s sacred raw ingress) and see what the
candidate produces. Confirmed "really good" + "should be able to do in the future" — **not build
now**; a **candidate requirement** (design shouldn't foreclose it). Open: LLM non-determinism
makes the diff fuzzy; judging "better vs different" likely needs a **judge agent** → the gate
([[D14]] / [[D19]]) may itself be an LLM reviewer.

⚡ **Rewind/fork requires ALL internal assets to be rewindable** (2026-07-15). Caveat (Jonas):
it's not just streams — the **AI search index (vector DB)**, the **two R2 buckets**, and the
**repo commits** all need to rewind (fuzzier), and **third-party integration state can't be
rewound at all**. Claude's read: internal assets rewind _by construction_ IF derived state (incl.
the search index) **re-reduces from the log** and blobs are **content-addressed + event-
referenced** ([[D9]]); git rewinds by checking out the commit live at offset N ([[D19]]). The one
truly un-rewindable thing is **external state** — exactly why replay **jails side effects**.
→ **Parked (Jonas: lock & move on):** a future capability; but the _discipline_ (keep derived
assets — incl. the search index — derived from the log; content-address blobs) is worth holding
**now** — cheap now, expensive to retrofit. Not a build item.

⚡ **Time is a place** (parked). `itx.at(offset)`: reconstruct the organism at any past moment;
fork it and feed it the event that didn't happen — time-travel debugging. Falls out of
event-sourcing + external-input replay; gated on the rewindability discipline above.

⚡ **Entity is a file / portability** — **✅ confirmed direction (Jonas: "a really cool idea to move
toward")**. A project = its external-input log + git repo + content-addressed blobs; tar it,
rehydrate anywhere. Portability as the moat. Connects [[R10]] / [[R17]] and the git-repo-everything
exploration below.

⚡ **The mind is a fold** — **ALREADY REAL, not a new idea (verified in code 2026-07-15).** The
agent processor's `history` (model-visible) is reduced from events; the LLM's output is stored as
an `llm-request-completed` event and folded into history (`agents/agent-processor-contract.ts`).
"Replay" already exists = on DO eviction/wake or a state-version bump, the stream DO **discards
persisted reduced state and re-reduces the full event log from its own SQLite**
(`streams/core-processor-contract.ts:20`; checkpoint offset = the "replay cursor",
`streams/stream-processor.ts:305`) — so re-reduction rebuilds the exact conversation **without
re-calling the model** ([[R6]] eviction recovery, [[D3]]). So there's **nothing to lock** — plain
event-sourcing, already shipped. The **only** forward-looking bit is **shadow-selves**:
re-reducing through _candidate_ code, where stored answers may not match new prompts → must
re-infer (future; parked). NB: events live in the **stream DO's SQLite**, NOT git (git = code;
separate settled question). _Lesson: I over-abstracted an existing mechanism — read the code first._

⚡ **The last RPC** — **❌ KILLED (Jonas)**. Collapsing all RPC into events _doesn't work_: capnweb
RPC passes **request/response streams and rich JavaScript objects** that **can't be serialised
into events** — and that's a **good** thing, because it lets you write natural, richly-typed JS
that's legible to an LLM. So: **events for durable truth; RPC for rich ephemeral interaction**
(→ bounds [[D25]]).

⚡ **Hire software companies** — **Jonas: don't really get it; it's the endgame — ignore for now.**
Packages become iterate entities you _hire_ via signed-event contracts. Connects [[D17]] + the
economy vision.

⚡ **Everything is one Git repo?** — **RESEARCHED; verdict in `research-everything-is-git.md`.**
(a) **commit-per-event at billions: NO, decisively** — largest git repos (Windows 300 GB / 3.5M
files / ~250k commits, needs GVFS/Scalar; Linux ~1M commits) are 3–4 orders below billions;
git-as-a-DB systems (Dolt, Irmin/Tezos, Noms) _refuse_ one-commit-per-record and use
content-addressed **prolly trees** instead. Keep the event streams. (b) **Git LFS: no** — it's
pointer+separate-store = what iterate already has (content-hash fact + R2), minus a second
protocol/client/quota/5 GB cap. (c) **search index in git: no** — it's derived; keep it unstored,
rebuild from streams+blobs. (d) **The hybrid Jonas floated IS the answer, and it's ≈ [[D9]]
already:** git holds code + at most periodic **manifest/pointer snapshots**; **R2** holds
content-addressed bytes; **streams** stay; the **search index stops being a store**. Net: **4
stores → 3**, crisper roles. Two rules: **never commit-per-event; never store derived state in
git.** **Bonus (worth locking later):** stamp each event with the **code/image hash that processed
it** → exact replay across self-modification (content-addressing reaches _into_ the journal at
just that one point; ties shadow-selves + [[D19]]). Authoring stays files-and-git (LLM trained on
files; Unison/Nix/IPFS = graveyard of "make humans edit hashes").

⚡ **"Let my iterate talk to your iterate"** (2026-07-15, **near-term goal**). If two companies
both run iterate, connecting their organisms should make both more efficient — "let my iterate
talk to your iterate, good things happen." A concrete, near-term B2B network effect — the
short-horizon cousin of hire-companies (the endgame). Governed by the edge trust boundary
([[D1]] clarification: an outside party is a **graded** stakeholder — control disclosure, watch
for deception).

---

## Backlog — questions still to ask (living list, reorder freely)

_Seeded from DESIGN.md §8 open questions + the tensions between locked decisions.
Codex (gpt-5.6-sol, xhigh) and a prior-art researcher are feeding this list in the
background._

> **⚠️ Interview style (Jonas, 2026-07-15):** ask **broad, big-picture, directional**
> questions ("where are we going / how does it work in the abstract"). Do **not** open
> with hyper-detailed mechanics. When Jonas volunteers a detail, _then_ a detailed
> follow-up is welcome; otherwise **file the detail here as a pin** and steer back to the
> big picture. (Misses to avoid: TTL-value tables, "quarantine a poison event after how
> many retries," etc.)

**Load-bearing (ask first):**

- **Q5 — config worker: stateless vs Durable Object; do we _wait_ on processEvent?**
  Jonas's instinct ("we do have to wait — how else would it work?") vs D3 react-only vs
  R13 stateless ingress vs R12 concurrency. _(asking now — I1)_
- **Q4 — built-ins as capability mounts + the perf cost**; is the clean model "hooks"
  (a processor reacts to repo-push / worker-built and installs capabilities)?
- **Q7 — what do we call the non-kernel layer** (not "packages"), and where exactly is
  the line between a deep first-party module and a userspace extension?
- **Q8 — updating a million projects** without rebasing a million repos (apt / App-Store
  channel-or-pin model?).

**Streams & events:**

- **Q3 mechanics** — obligation convention (`requested → completed{outcome}`): at-head
  guard, idempotency-key re-drive. Worth a worked code trace?
- **D11 vs R5** — if ephemeral events (audio, tokens) are evictable, what exactly _is_
  the durable trace of a voice call? What's the rule for "distill ephemeral → durable"?
- **D7 leak test** — name the case where "one stream abstraction" visibly strains
  (e.g. a 50k-row relational query; a fan-out to 10k subscribers).

**Capabilities / security:**

- **Q9 — expressions that look like TypeScript** with a tiny grammar (get + call, no
  loops/eval); bind = enforced constraint, not object-merge. What does the source look like?
- **D6 vs D10** — the "secret jail" worker can see a raw secret; how is that not a hole
  in "the only security is the egress door"? What contains the jail?
- **Q15 — cryptographically verified human approval** (secure enclave / attestation) —
  concrete mechanism.

**Code / repos / scale:**

- **Q6 — do "other repos" need the repo abstraction** or is it "just use GitHub + octokit"?
- **Self-modification safety** — an agent rewrites its own `processEvent` into something
  that throws on every event. What stops the organism from bricking itself? Rollback story?
- **R10 export/portability** — what precisely is in the tarball, and what breaks when you
  rehydrate on a fresh Cloudflare account?

**Framing:**

- **Q13 — the PI coding agent reference** for "produces-only-code / self-modifying."
- The single crispest Paul-Graham one-liner (Q11 noun is set: "digital organism").

---

### 🔥 Stocked 2026-07-15 — Codex (gpt-5.6-sol xhigh) + prior-art research

_Full text on disk: **`codex-devils-advocate.md`** (A1–A20 questions, B1–B6 pitches all
verdict ADOPT, C1–C3 disagreements) and **`prior-art-findings.md`** (6 areas + PA1–PA8
questions, each naming a real system). Distilled below, most load-bearing first._

**★ Three convergences — where BOTH independent reviewers hit the same gap (ask these):**

1. **No protected control plane; the promotion gate is itself self-editable.**
   **[→ RESOLVED 2026-07-15 → [[D14]] the membrane (see I2); remaining opens: the name,
   the money-spent-event mechanics, and [[Q15]] human-approval attestation.]**
   Codex C3 / B3 / B5 / A5; prior-art PA7 (Darwin Gödel Machine + SICA: keep an archive of
   prior versions, sandbox-eval on a benchmark held _outside_ the mutable agent, rollback).
   The organism can rewrite its own `processEvent` into something that throws on every
   event, loop at ~$108k/hr, or **edit its own spend cap / canary gate.** Direct tension
   with **[[D2]]** ("everything overridable in userspace") and **[[D1]]** ("nothing withheld
   inside the project"). → is there an _un-editable membrane_ (active-code pointer, spend
   cap, activation+rollback gate) in the kernel, and exactly where does userspace stop?
   _(candidate → a new Decision, or a "constitution" / kernel control-plane concept)_
2. **ocap needs withheld ambient authority — but D1 withholds nothing and we hand root
   `itx` to LLM code.**
   **[→ NETWORK side RESOLVED 2026-07-15 → [[D15]]: physical MITM SSL egress proxy + all
   code sandboxed (see I3). Still open: the _in-process_ ocap side — attenuation / who
   mints the narrowed capability / confused-deputy (A7, PA4/PA5); note D14.3 already gates
   high-risk egress via human approval.]** Codex C2 / A7 / A8; prior-art PA5 (Endo/Agoric Hardened JS:
   `harden()`, Compartments, no ambient `fetch`/`Date`), PA4 (June-2026 paper "Capability
   Gates Are Not Authorization": LangChain, LlamaIndex, Stripe Agent Toolkit _all_ ship the
   confused-deputy bug; cheap models attempt unauthorized calls 3.2× more). → what
   withholds root `itx` from a script, who mints the attenuated handle, and is LLM code run
   in an SES/Compartment so it can't reach global `fetch` and route _around_ `itx`? Does
   **[[D6]]** actually cover response bytes / WebSocket frames / logs / exports / secret-jail
   return, or is "one egress door" a metaphor?
3. **"One stream abstraction" is one _envelope_ over several _substrates_, not one
   mechanism.** Codex C1 / B4; prior-art PA1 (Restate = journal+state in server,
   single-writer lock, stateless handlers — "architecturally identical to your
   DO-is-ordering-point"). A db needs conditional writes + indexes; a queue needs exclusive
   claim + lease + redelivery; live PCM needs bounded buffer + backpressure + deliberate
   loss. → keep **[[D7]]** as _one API/naming_, but admit distinct semantics underneath?
   (Re-opens D7's "four systems collapsed into one" wording.)

**Streams / events / concurrency:**

- **`await append()` — what does it wait for?** (A1) durable-commit only / first
  processEvent / whole causal chain (never terminates)? The `waitFor(terminalEvent)`
  pattern (B1) keeps D3 non-blocking. _[feeds Q5]_
- **Concurrency invariant on a stateless fetch** (A2): 100 concurrent buys of the last
  unit — conditional-append-on-revision vs reservation-RPC-on-DO vs accept-then-reject.
  R13 gives horizontal scale, not database invariants.
- **Broadcast stream → task queue** (A11): where's the atomic claim + lease so 8 replicas
  don't all send the invoice? Idempotency key must ride _into the external call_ (PA3 —
  Temporal/Stripe; internal dedup window 24–72h expires).
- **Cross-stream saga recovery after a mid-crash** (A12): which durable event marks the
  open obligation, discoverable without scanning every account stream?
- **Replay bill** (A13): 1B events / 50k eps = 5.6h recovery. Checkpoint interval?
  May old segments ever be compacted? _[feeds Q5 / R6]_
- **Poison event** (A4): seq 900 throws forever, 901–14000 blocked. Quarantine after N
  tries? Who may skip? How does reduced state advance past it? _[feeds R6]_
- **Non-determinism in `reduce`** (PA2 — Durable Functions/Temporal replay ban
  `Date.now()`): what stops a stray clock/random call silently corrupting reduced state?

**Concurrent self-modification:**

- **Two LLM edits from the same parent commit** (A3): serialize by event seq / merge /
  reject / last-wins? Which code handles event 82 if C1 & C2 land 3ms apart?
- **Fleet update = merge across a million diverging branches** (PA8 — Cloudflare gradual
  deploys can't roll back across a KV/D1 schema change): precedence when a channel bump
  and a project's own rewrite touch the same file? The content-addressed **"system image"**
  (B6) answers Q7 + Q8 together.

**Secrets ([[Q14]]):**

- **What may leave the secret jail?** (A6, B2; PA6 — Vault Transit). Industry verdict:
  expose `hmac`/`sign`/`encrypt` _operations_ (key never leaves) instead of a jail that
  sees plaintext — strictly stronger than [[D10]]'s escape hatch. SSRF: does the allowlist
  pin the _connected_ host (post-DNS/redirect) or the _requested_ host?

**Capabilities ([[Q9]] / [[Q4]]):**

- **The tiny grammar** (A19): productions for `itx.slack.postMessage.bind({channel})`; on a
  later call with `{channel:"C_PAYROLL"}` — reject / ignore / intersect? Stored as source
  text or canonical AST?
- **Mount-install vs code-activation race** (A15): must activation atomically bind
  `{codeDigest, capabilityTableDigest}`? Lookup cost for 200 mounts @ 10k rps?

**Trust boundary ([[D1]] / [[WA1]]):**

- **The two-person company** (A14): founder Alice + payroll _contractor_ Bob + support
  Piper all get the same `itx`; Bob can read payroll, rewrite `processEvent`, use every
  secret. Refuse the deployment? Three projects over public HTTP? Rely on social trust?
  D1 rejects _ordinary delegation_, not just enterprise roles.

**Repos ([[Q6]]):**

- **A non-config repo is referenced, then GitHub deletes it** (A16): the export has commit
  C52 but can't rebuild it. Mirror referenced objects into a project-owned content store,
  or does [[R10]] explicitly exclude them? "Just use octokit" vs exportability/provenance.

**Human approval ([[Q15]]):**

- **What does the signature attest?** (A20): key-possession vs physical-presence vs
  informed-consent vs legal-identity — four different claims. Which canonical bytes, which
  _attested_ UI shows them, what stops a destination-swap between approval and execution?
