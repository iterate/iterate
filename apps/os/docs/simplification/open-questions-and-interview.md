# Open questions & interview agenda

The morning agenda. These are the real forks — places where the night's work
found a genuine choice that needs *your* judgment, not more analysis. Grouped:
(0) things everyone agreed on (just decide yes/no), (1) the big framing forks,
(2) the mechanism forks, (3) where the reviewers actively disagree, (4) the
wild-idea keep/kill list.

Each fork states the options and what each buys/costs, so the interview can be
"pick, with reasons" rather than "explain from scratch."

---

## 0. High agreement — probably just say yes (fast wins)

Every voice (workflow lenses, codex ×3, maximalist, scholar, even the skeptic)
converged on these. They're mostly deletion or cheap facts. The interview
question for each is just: **do it now, or is there a reason not to?**

1. **Add the missing FACTS.** `repo/commit-landed`, `file/put → pointer-landed`,
   `worker/build-requested → build-succeeded|failed`. Today commits, file puts,
   and build failures happen with NO event — the one class of thing nothing
   can react to or trace. Cheap; unlocks traceability + shadow replay. (App. A
   §4, App. C §E2)
2. **Email send becomes an obligation** (`send-requested → sent|failed`) instead
   of send-first-then-maybe-append. Closes a real crash gap (`rpc-targets.ts:2936`).
3. **One egress door.** gmail/github currently bypass the project egress door
   (dial their Secret DO directly), skipping interceptors + approvals; Slack
   doesn't. Route all vendor egress through the one door. (§5.9)
4. **Fix the hermeticity bug.** `artifact-store.ts:13-16`: npm ranges re-resolve
   at build time, so the "immutable" build key isn't. Pin resolved deps into
   the key. Without this, exact replay and content-addressed fleet updates are
   both impossible. (App. C §9, App. D §A)
5. **Delete the stale-architecture corpus.** CONTEXT.md (951 lines teaching
   deleted vocabulary), pre-v4 design docs at max prominence, the `/reactivity`
   playground route, colliding ADR numbers. Zero runtime risk. (§5.9)
6. **Collapse the two fold engines** (the stream's hand-rolled core processor →
   hosted on the one StreamProcessor engine) and **the four delivery lanes → one**
   (nudge-then-pull, browser on the same lane). Biggest single line win. (§5.3, §5.5)
7. **One obligation primitive** for "durable job with expiry" (replaces 5 hand-
   rolled copies + keepalive + spine-park) — AND make it impossible to declare a
   `-requested` event type without its reconciler + expiry. (§5.4, §6.2.5)

If you agree with 1-7, that's the un-controversial half of the simplification
and could start immediately, independent of every framing debate below.

---

## 1. The big framing forks

### Q1. What is the ONE-LINE answer to "what is an iterate project?"
Three consolidated explanations were written (see `explain-*.md`), each
committing to a different hero:
- **Intelligent entity runtime** — "a durable outer event loop wrapped around a
  language runtime, where deterministic folds and stochastic AI steps take turns
  over one history." (Your §6.14 framing. Best at conveying *why it's new*.)
- **Operating system** — kernel / standard-library / packages, two shells.
  (Best at governance + the fleet story. Codex's favorite.)
- **One log and a fold** — a database turned inside out; one write, one read.
  (Best at the data model + the collapse math. The purest.)
**Fork:** which is the *front-door* framing (the others become supporting
lenses)? My read: lead with **entity runtime** for the vision/why, use **one
log** for the engineering, use **OS/three-rings** for the governance/fleet. But
you may want a single hero. Which?

### Q2. Is "streams" kernel-by-necessity, or a privileged library by choice?
The kernel razor (§6.12) proves streams are *expressible* in userspace over the
seed (confined code + storage + one exit) — so they are NOT kernel by necessity.
The skeptic's sharpest jab ("streams is your BIGGEST directory, 17k lines")
becomes agreement, not gotcha.
**Fork:** (a) *keep streams as a deep, privileged Ring-2 library* (practical:
performance, and the LLM shouldn't reimplement at-least-once) — OR (b) *actually
move them to userspace* to prove the seed is the whole kernel and hit ~5k LOC.
Nobody thinks (b) is worth doing SOON, but *saying* streams are a library (not
kernel) is clarifying either way. Do you want to commit to that framing even if
you don't move the code?

### Q3. "Everything in userspace": mandate or test?
Codex round 3 reversed the night's earlier enthusiasm: **three rings** (kernel /
iterate-standard-library / packages), with "everything in userspace" demoted
from a *deployment mandate* to an *implementability test* for Ring 2 ("could a
third party build a credible alternative without private bindings?"). The case:
npm is transport not governance; a non-technical founder can't audit 20
strangers' grants; the agent domain is a deep module, the WRONG thing to
extract first.
**Fork:** how far toward packages do you actually want to go? Poles: (a)
purist — everything ships as a package, iterate owns none privileged; (b)
three-rings — a few deep first-party modules, packages only at the leaves; (c)
platform-monolith — deep modules, extensibility later. My read: (b). Agree? And
specifically: **where should iterate deliberately NOT be extensible?** (codex's
list: auth/tenancy, journal semantics, obligation recovery, grant validation,
secret substitution, egress door, billing, recovery console, reserved event
types.)

### Q4. The fleet-update problem — which option per layer?
Codex's key insight: A/B/C/D aren't alternatives, they answer three different
questions (code ownership × version selection × execution placement). The
recommended hybrid (App. D "Final fleet decision"): kernel = A (global deploy);
deep std-lib = A now, C after a stable seam; third-party = C (channel/pin);
bespoke genome = B (repo commit); mini-app = B or C, D only when isolation
justifies. And loudly: **DON'T build the million-repo rebaser.** Rename
"Organism Image" → "Organism LOCK" (a manifest over shared artifacts, not a
per-project monolithic bundle — 3^20 combos otherwise).
**Fork:** do you accept "publish a version + let projects choose to follow it"
(channels + locks, like apt/npm) over "rebase all repos"? And is the content-
addressed-namespace endgame (Unison-style, `lens-content-addressed.md`) the
right north star, or too exotic for the LLM-as-primary-user?

---

## 2. The mechanism forks

### Q5. Births: virtual-activation or first-append-materializes?
The scholar wants Orleans-style: every path always exists, first touch
materializes, no ceremony. Codex r2 sharpened: first *append* (not read)
materializes; the event's TYPE selects an *activation profile* via a *pinned,
content-hashed manifest* (NOT a live DNS lookup — "a supply-chain vuln wearing
an elegant URI"); `kind` is not identity — the *activated contract set* is.
**Fork:** adopt "first append materializes + manifest-selected activation
profile + reads never materialize"? This also answers your "event type encodes
its processor/supervisor" idea (§6.5): YES, but the type resolves to an owner
through a *pinned manifest*, not by URI-prefix magic or DNS.

### Q6. Expressions as the universal quoted call + partial application?
Your idea (§6.7): proxy-recorded `q(itx => itx.a.b.c())` syntax + bind-an-arg as
capability attenuation, and "everything on every surface is an itx expression."
Codex r2 verdict: proxy syntax good; keep the algebra *painfully small* (get +
call only, JSON args, no eval/loops/lambdas); **bind must compile to evaluator-
enforced constraints, NOT deep-merge** (deep-merge is a security bug); and it's
a great IR but a *terrible naked grant* — an expression is a NAME, authority
comes from the evaluating scope; a shareable/journalable expression needs a
separate revocable *grant* object. And NOT everything is an expression: facts
(`output-added`, `commit-landed`) are facts, not calls.
**Fork:** adopt the small algebra + proxy syntax + bind-as-constraint + separate
grant object? (This is high-value and mostly agreed — the fork is just how much
to promise.)

### Q7. Just-fetch + egress-is-the-only-security?
Collapse ingress+egress into one `fetch` verb (routes by hostname; internal =
free, external = the one gate). "The only real security is egress bytes." Open
sub-question nobody resolved: does the internal lane REALLY need no gate, or does
cross-entity-within-a-project still need capability checks (a compromised agent
messaging another agent)? And: **secure enclave for humanness — kernel or a very-
trusted mount?**

### Q8. The five concepts: explanation, or runtime theorem?
Codex r3's Kubernetes/Unix warning: "everything is X" always survives by growing
exceptions (CRDs/finalizers; sockets/ioctl/proc). The `ephemeral` event already
proves guarantee-classes creep in.
**Fork:** commit to "the five concepts are the EXPLANATION; live transport,
reads, blobs, and external obligations keep distinct semantics — and that's
correct, not a betrayal"? (I think yes — the honest wall line is "everything
durable becomes a fact in a named log; transport/reads/blobs/effects are
devices with their own rules.")

---

## 3. Where the reviewers actively disagree (you adjudicate)

- **Is the whole thing overengineered?** The skeptic says event-sourcing-
  everything is a known trap and a self-driving startup wants Postgres + a queue
  + cron. The Urbit lens says the architecture is sound and the risk is CULTURE
  (idiolect), not design. The state-adapter discipline (Urbit's `+on-load`) is
  the concrete answer to the skeptic's #1 blow (schema evolution). **Your call:
  is the substrate a bet you're happy to defend to a skeptical senior hire?**
- **Buy Temporal vs build the obligation primitive?** Skeptic: buy Temporal
  (it IS §5.4). Everyone else: the bespoke primitive is the price of 1M cheap
  entities + LLM-native ergonomics + per-entity confinement, which Temporal
  doesn't give you on Workers. **Your call.**
- **Births: lean IN to implicit (scholar) vs add manifest ceremony (codex).**
  Not fully reconciled — codex's manifest-activation adds structure the scholar's
  pure-virtual model resists. The synthesis (event-type → activation profile via
  pinned manifest) leans codex. Comfortable?
- **Dashboard: how much is kernel?** Codex draws it by dependency ("must work
  when the project is broken → os.iterate.com"). The minimum non-removable
  console is sizable (identity, health, raw journal, package governance,
  authority, recovery, domains). **Does a self-driving-startup founder ever log
  into os.iterate.com day-to-day, or only at create/consent/billing/recovery?**
  (Codex: only the latter; daily life is at hq.their-domain.com.)

---

## 4. Wild-idea keep / kill / mutate

- **The Last RPC** (a call is an ephemeral append; retention is the only
  difference; capnweb becomes a compiler) — codex: keep the COMPILER, kill the
  literal "delete rpc-targets"; retention is NOT the only difference (reply
  routing, cancellation, streaming, live stubs). **Keep as compile-target, not
  dogma?**
- **The entity is a file** (project = tar of repo + journal, portable) — keep,
  but it needs: events stamped with the exact code-hash that processed them
  (content-addressing makes this exact), and honesty that external *consequences*
  aren't in the tar (only receipts). Strong moat, weak wedge.
- **Shadow worldlines / self-improvement** — codex r3: a TESTING INSTRUMENT, not
  a truth oracle; can't reconstruct the counterfactual world; LLM judge Goodharts;
  NEVER auto-promote — require a bounded live canary. **Keep, scoped to
  compatibility/migration/incident-repro?**
- **Hire software companies** (§7.10) — packages become entities you hire via
  bilateral event contracts; hosted-employment solves fleet updates (patch one
  running service). "Any SaaS is an intelligent company other companies hire."
  Beautiful, and the literal expression of the vision — but it turns the platform
  into an economy (bankruptcy, correlated failure). **North star, or too far?**
- **The whole project as one virtual filesystem** (§7.8) — you flagged it as
  "crazy shit for a codex to run with." Codex verdict pending in
  `crazy-vfs-and-entity-runtime.md`; likely "not a literal VFS, but the entity
  *presents as* a filesystem" (a /proc-style view over streams) as the most
  LLM-legible front door. The audio requirement forces the FIFO/character-device
  distinction. **Keep as a VIEW, not the substrate?**

---

## The one discipline that outranks all of the above

From Urbit's grave (`lens-sovereign-computer.md`): the architecture is not the
risk — the **private language** is. Urbit had beauty this deep and died because
onboarding took weeks of learning a new vocabulary. This notebook is already
growing one (organ, attenuation, worldline, Effect Court). **The commitment to
extract from you:** every core concept must gloss in one line of words a working
programmer already owns — Stream = a log, Processor = a consumer that folds a
log, Capability = a callable reference, Repo = a git repo, Door = an HTTP
handler — and no newcomer learns a new word to do their first useful thing. If
you agree to nothing else, agree to that.
