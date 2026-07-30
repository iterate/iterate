# Q05 — Taxonomy: build it inside-out (agreed / in-flux / open), don't ratify a glossary yet

**Status: deferred — reframed.** _(Jonas: "we're not in a place yet where we can create this whole
taxonomy… start from the inside out with the things we kind of agree on… lay out what different
architectures we're proposing, what is actually currently in flux, and what we can lock in.")_

Ratifying ~25 terms now hardens vocabulary before the architecture is proven. Instead we grow the
glossary term-by-term as each `R0`/`Q03`/`Q04` conversation _earns_ a word. Track three tiers:

## Tier 1 — Agreed (safe to name now)

Control plane · project runner _(boundary still open — R0)_ · ITX capability tree · wall · directory ·
confinement · the lattice · Miniflare tier · home-assistant mode · born project-secret key ·
project-app-session · **the dial** (`dialProject`: the one `row → Project` routing fn).

## Tier 2 — In flux (used, but definition contested)

- **capability source** — shape/granularity contested (Q03); tie to capability-host/shadowing before locking.
- **placement** vs **runner placement** vs **registry row** — one concept, three names; pick one after R0.
- **role** — was a bundle knob (rejected, ADR 0016); may survive as a per-worker deploy descriptor.
- **collapsed / split / stretched** — descriptive shapes; keep only if they earn their keep.

## Tier 3 — Open / rejected-for-now (do NOT coin yet)

codex's `ProjectManifest`, `binder`, `CapabilityPlan`, `RunnerGateway`, `Link Broker DO`, `lease epoch`,
`FetchTarget`, `placement generation`, `birth receipt`, `ProjectGrant`, `runner-link`. Real concepts;
coin only when a specific rung in the lab actually needs the distinction.

## The other half of Jonas's ask (do this next)

"Lay out what different architectures we're proposing." → a short **architectures-in-tension** doc:
the 4 radical archetypes (log-is-the-computer · account-per-project/WfP · signed-capability peer mesh ·
capnweb-only) vs. the mainline two-role model, each with what it locks and what it costs — so we can
say, per piece, _agreed / in-flux / open_. Draft after R0 lands.
