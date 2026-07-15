# Synthesis — the cook-down

Written last, after a night of many voices (workflow lenses, codex ×4, a
maximalist audit, an actor-systems scholar, a content-addressed lens, an Urbit
lens, a boring-tech skeptic, three competing explanations, a VFS run). This is
the distilled answer, in plain words, with the honest disagreements left
standing. If you read one file in this folder, read the notebook
(`../simplification-ruminations-2026-07.md`); if you read one more, read this.

---

## The one thing the whole night converged on

Every voice — even the ones that disagreed about everything else — ended up in
the same place when pushed:

> **There is a tiny irreducible core — "the seed" — and everything else is a
> library on top of it. The seed is: run confined code, give it durable
> storage, and control the one door it can send bytes out of. Everything you
> think of as "the platform" (streams, processors, capabilities, agents, the
> dashboard) is a library standing on that seed.**

This matters because it settles the argument you raised — *"if streams leave
the kernel, how important is the kernel concept?"* The answer: **"kernel" is
not the hero. It's the floor.** It's small, boring, and load-bearing, and it is
not what the system IS. What the system IS depends on who's asking — and the
night produced three honest answers to that, for three different audiences.

## What an iterate project is — three true answers

The three consolidated explanations (`explain-*.md`) are not rivals to
pick between. Each is the right lead for a different audience. Their own
self-critiques proved it: each concedes the other two are describing the same
thing from a different side.

| Audience | Lead with | The one-line |
|---|---|---|
| **Vision / recruiting / "why is this new"** | Intelligent entity runtime | *"A durable outer event loop wrapped around ordinary code, where deterministic folds and stochastic AI steps take turns over one history — a program whose loop lives in storage and survives its own process. A normal program's loop is around promises; this one is around lives."* |
| **Engineering / how it actually works** | One log and a fold | *"One write (append) and one read (follow). Durable state is a fold of the log; the log is the only truth, everything else is a cache. A call is an append that doesn't stay; a workflow is one that does."* |
| **Governance / security / fleet** | An operating system | *"A tiny kernel you can't touch, a small standard library iterate operates, and packages for everything else — with two shells: one to stand outside an entity and run it, one where the entity lives and faces the world."* |

The mistake would be to force one. Lead with the runtime for the story, teach
with the log, govern with the OS. The codex referee (`explain-referee.md`)
scored them independently and agreed exactly: *"'One log and a fold' wins the
technical explanation. 'Intelligent entity runtime' wins the meaning of the
product. 'Operating system' wins governance and fleet operations. Any essay
claiming to be the universal framing loses."* It also ruled on the front-door
rule for all three: **"First say what the programmer does. Then offer the
metaphor."**

**The wall paragraph** (the referee's unified answer, borrowing the best
sentence from each essay — this is the one to put on the wall):

> An Iterate project is a confined computer with one watched door: it runs
> ordinary code, keeps durable named history, and controls the bytes that
> leave. Its one durable write is to append a fact to a named log, and its one
> read is to follow that log; current state is a fold of those facts, so
> derived caches can be thrown away and rebuilt. Processors follow forever,
> turn history into state, finish or repair outstanding work, and sometimes
> ask an AI model; because a model answer cannot be reproduced, the answer is
> written back as a fact and replay reads it instead of asking again. Project,
> stream, processor, callable reference, and git repo form the small
> programming model above that seed, while live audio, blobs, reads, and
> external effects keep their own explicit rules. The result is a durable outer
> event loop around ordinary programs: something that can act, think, crash,
> restart, and still account for what happened.

And the referee's four-line final ruling, the shortest true summary of the
whole night:

> **The seed confines. The log remembers. Processors keep going. The OS model
> governs who may change what.**

## The five concepts (each glossed in words a programmer already owns)

This is the front door. The single most important discipline of the whole
exercise (from Urbit's grave — see below): **every concept glosses in one line
using words a working programmer already has.** No new vocabulary to do your
first useful thing.

1. **Project** — *a git repo = a company.* The whole entity: one identity, one
   security boundary, one namespace that everything else lives in.
2. **Stream** — *a log.* Append-only journal at a path. The only write is an
   append.
3. **Processor** — *a consumer that folds a log into state* (and can cause side
   effects, and heal unfinished work after a crash). An agent is a processor
   wearing a prompt.
4. **Capability** — *a callable reference.* How anything reaches into a
   project; you have authority because you hold the reference, not because a
   check let you in.
5. **Repo** — *a git repo again, but as the genome:* the entity's own source,
   which it can read and rewrite. Self-improvement lives here.

Three cross-cutting facts that are NOT extra concepts:
- **The seed** (confined code + storage + one exit) — the floor.
- **One door** — internal fetch is free; external fetch is the entire security
  surface. "The only real security is bytes leaving the project."
- **The runtime** — the five concepts compose into the durable outer loop.

## The two-and-a-half slogans for the wall

> **Everything durable is an append; everything alive is a follow.**

> **The kernel gives you a confined computer with one door. Everything else,
> including streams, is a library you could have written yourself.**

> **One log of truth, plus typed devices** — for reads, blobs, live media, and
> the outside world. (This is the honest version of "everything is a stream":
> the log is the only *truth*; audio, files, HTTP, and external effects are
> *devices* with their own rules. It's Unix's `/proc` + sockets, not a
> betrayal of the idea. The VFS run and the one-log essay reached this
> independently.)

## What to actually do — three tiers

### Tier 1 — just do it (everyone agreed, mostly deletion + cheap facts)

These need no framing decision. See `open-questions-and-interview.md` §0.
- Add the missing FACTS: `repo/commit-landed`, `file/put→pointer-landed`,
  `worker/build-requested→succeeded|failed`. (Unlocks traceability + replay.)
- Email send → an obligation (closes a real crash gap).
- One egress door (gmail/github currently bypass it).
- Fix the build-key hermeticity bug (npm ranges re-resolve — breaks replay).
- Delete the stale-architecture corpus (CONTEXT.md etc.).
- Collapse the two fold engines → one; the four delivery lanes → one.
- One obligation primitive; make a `-requested` type uncompilable without its
  reconciler + expiry.

That is most of the felt "heaviness" gone, with no philosophy required.

### Tier 2 — the structural collapse (the §5 program, ordered by leverage)

1. Built-ins become described mounts on the one capability table (dissolves
   most of the 6k-line `rpc-targets.ts` + the generator pipeline).
2. One channel mechanism (Slack/Telegram/email/PR are one parameterized thing,
   ideally in userspace).
3. Repo becomes the one filesystem substrate; workspace + builder dissolve;
   sandboxes become mounts.
4. Merge the CapabilityHost DO into the path's host DO (kills a hot-loop hop).
5. Resolve mounts from folded state in-isolate (6 hops → 2-3).
6. One OAuth engine; one path-walk; by-reference script journaling; typecheck
   off the hot path; a generic processor-host DO.

Target: the kernel + the deep library land near "small enough that one person
can hold the whole entity in their head." Honest count is ~6k for the core,
not 5k — and that's fine; 5k was always shorthand for *legible*, not a budget.

### Tier 3 — the strategic forks (need YOUR call — the interview)

These are in `open-questions-and-interview.md`. The big ones:
- **How far toward packages?** The night reversed itself here. Early
  enthusiasm ("everything in userspace, any SaaS as an npm package") met a
  strong counter: extensibility ≠ abdication; npm is transport not governance;
  a non-technical founder can't audit 20 strangers' grants; the agent domain
  is a *deep module*, the wrong thing to extract. **The reconciliation is
  three rings** (kernel / iterate-standard-library / packages), with
  "everything in userspace" demoted to an *implementability test* ("could a
  third party build this without private bindings?") rather than a deployment
  mandate. Recommended mainline.
- **The 1M-repo update problem.** Don't build the million-repo rebaser.
  Publish versions and let projects *choose to follow* them (channels + locks,
  like apt/npm), which iterate already half-implements via content-addressed
  build keys. The exotic-but-elegant endgame: **hosted employment** — a
  service runs in ITS OWN project and you subscribe to it, so its maintainer
  patches one running instance, not a million repos. ("Don't install software
  — hire software companies. Any SaaS is an intelligent company that other
  companies can hire.")
- **Births**: first *append* materializes (not read); the event TYPE selects
  an activation profile via a *pinned, content-hashed manifest* — never a live
  DNS lookup. Your "event type encodes its supervisor" idea, made safe.
- **Expressions**: adopt the small algebra (get + call, JSON args, no eval) +
  proxy-recorded syntax + bind-as-*constraint* (never deep-merge) + a separate
  revocable grant object. Great IR; terrible naked grant.
- **The five concepts are the EXPLANATION, not a runtime theorem.** "Everything
  is X" always grows exceptions (Kubernetes CRDs; Unix ioctl/proc). Say so up
  front: one log of truth + typed devices.
- **Self-improvement (shadow worldlines)**: a *testing instrument*, not a
  truth oracle. Never auto-promote on a replay score; require a live canary.

## The disagreements worth keeping (don't paper over)

- **Is the substrate overengineered?** The skeptic says a startup wants
  Postgres + a queue + cron and event-sourcing-everything is a known trap; the
  Urbit lens says the architecture is sound and the risk is *culture*, not
  design. The strongest bridge: adopt Urbit's state-adapter discipline
  (versioned state + `migrate(old)`), which is the concrete answer to the
  skeptic's #1 blow (schema evolution). You should be able to defend the
  substrate to a skeptical senior hire; if you can't yet, that's the gap.
- **Buy Temporal vs build the obligation primitive.** The bespoke primitive is
  the price of 1M cheap confined entities with LLM-native ergonomics; Temporal
  isn't that on Workers. But name the bet.
- **How much dashboard is kernel?** By the dependency test ("must work when the
  project is broken"), the non-removable console is sizable. A healthy founder
  lives at `hq.their-domain.com` daily and visits `os.iterate.com` only at
  create / consent / billing / recovery.

## The one discipline that outranks everything

From Urbit — the closest existing relative of this vision, technically
breathtaking and adoption-irrelevant for 20 years. It did not die of bad
architecture. It died of **a private language only its authors spoke.** This
notebook is already growing one (organ, attenuation, worldline, Effect Court).
That vocabulary is fine as internal scaffolding; it must never reach the front
door.

> **Every core concept glosses in one line of words a working programmer
> already owns, and no newcomer learns a new word to do their first useful
> thing.**

The architecture is at least as beautiful as Urbit's — which is exactly why
it's at least as much at risk. If you agree to nothing else from this whole
exercise, agree to that.

---

_Companion: the plain-words "explain it to a smart friend" closing lives in
`explain-plain.md` (and at the bottom of the notebook). The referee's scored
comparison of the three framings lives in `explain-referee.md`._
