# Where we got to — simplification jam, 2026-07-28

A clean digest of a long conversation. Full narrative in `jam-2026-07-28.md`
(§0–15); this is the "hold it in your head" version.

## The through-line

An iterate project is a **digital organism on the internet**. It touches the world
only through HTTP (`fetch` in, `fetch` out). It's **born with almost nothing** —
empty memory, no money — just a bag of **secrets** and the ability to **spend
money**. Everything that lasts goes in one **append-only log** (its memory), and an
**agent inside can rewrite the project's own code**.

**The single biggest realization:** self-hosted and iterate-hosted are the **same
codebase**. The difference is the value of ~5 config knobs. That makes the whole
"what's core vs hosted" question tractable.

## Decided (we converged; you ratified or accepted)

1. **The kernel is small** and is defined by one test: _what you cannot break from
   your own config._ True floor = the raw Cloudflare bindings + the log (streams) +
   the capability resolver + the one egress door + identity/addressing + the
   confined-code runner, **plus `integrations`** (kept as a named kernel feature for
   now — with the understanding it may later be generalized; see note). Even
   `files`/`kv` are userspace **wrappers** over raw bindings (R2/KV). ~6k LOC.
2. **Everything else is userspace** — the agent, the dashboard, apps — delivered as
   `iterate/*` npm packages the config imports. _(Note on `integrations`: it stays in
   the kernel for now, but it decomposes — a self-refreshing secret + an inbound
   webhook route + a card painted into a shared view — and may be generalized once
   there are enough of them to justify it. Kept named rather than dissolved into
   primitives today.)_
3. **First-party vs third-party userspace is not a real line** — just provenance
   (which npm package, and whether it's seeded in the birth template).
4. **Self-host vs hosted = one codebase + ~5 config knobs:** leased OAuth clients ·
   platform egress API keys · hostname base (`*.iterate.app` vs your domain) ·
   identity authority · billing counterparty. Everything else is identical.
5. **The OS is a normal edge worker, not a dynamic project.** Its dashboard becomes
   a **stateless front-end proxied at a hostname** (exactly like the `tasks` app in
   the template today). You could swap in a different OS front-end.
6. **Front-ends = stateless adapters over the capability tree** (dashboard, inbound
   MCP, the `/api`), all proxied, all replaceable. Outbound MCP = a kernel capability.
7. **Auth splits cleanly:** _identity_ at the wall (iterate OIDC hosted, or your
   Cloudflare Access self-hosted) + _authorization_ via `itx.auth` at the proxy. The
   kernel ships unprotected; auth is a rented/BYO wall. This deletes the dashboard's
   bespoke session system.
8. **Money:** born broke (the first thought costs money); **funding is the genesis
   event**; negative balance → frozen. Money = a **secret at the root** (bank/Bitcoin
   key) + **budgets = attenuated capabilities**. No wallet subsystem; it's just
   "extending a small, bounded credit." Don't over-engineer settlement.
9. **Multi-project when self-hosting: yes** — it's a kernel property.
10. **Interfaces:** kernel↔consumer is a capability tree — Workers RPC internally
    (fast), Cap'n Web for external/cross-deployment.

## Still open — your calls

- **Thin vs thick OS front-end:** just dashboard+provisioning (agents/integrations
  live in the projects it creates), or does the OS worker bundle them? _(lean: thin)_
- **Overturn the "governance ring" fully?** i.e. iterate owns the deep modules only
  by convention (it publishes + seeds them), not by architecture. _(you lean yes)_
- **Grubstake:** does the platform give every new project a tiny free balance so it
  can take its first breath and earn/raise its own funding?
- **Event provenance:** make "appended-by-which-capability" a first-class field, so
  userspace-added integrations can't forge events?
- **Fleet updates:** type errors as the tripwire → the organism's own agent fixes its
  config. You agreed in principle; parked the details.

## What to build first (the concrete to-do — see `TODO.md`)

1. **Built-ins → mounts** (foundational). Tracer bullet: the `kv` capability (66 LOC,
   zero deps) → a mount. Proves the whole pattern once.
2. **One fetch** = ingress + egress; route all egress through the one door.
3. **Move code to userspace:** channels/Slack; renderers-from-events; the stateless
   OS front-end.
4. **Extract the kernel** out of `ProjectDurableObject` — the big lift, done gradually
   (each feature that leaves shrinks it toward ~6k).

## The docs

- `jam-2026-07-28.md` — full narrative, §0–15.
- `TODO.md` — the working list (4 workstreams + requirements).
- `core-boundary.md` — first-cut core / first-party / user layering.
- `kernel-sketch.md` — Model 3 in code (answering "but we use CF bindings").
- `self-host-vs-hosted-walkthroughs.html` — the 6 concrete walkthroughs.
- `os-as-a-project.html` — today-vs-Model-3 diagrams.
