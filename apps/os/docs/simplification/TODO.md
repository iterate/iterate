# Simplification — the working to-do

The list we're actually working from. Chosen by Jonas 2026-07-28 out of the fuller
menu in [`jam-2026-07-28.md`](./jam-2026-07-28.md) §10. Ordered by dependency, not
importance. Update this doc as we go; graduate items into `tasks/` when ready to
build.

---

## Requirements to hold (constrain every task below)

- **[R1] `@iterate` must be self-deployable into a user's own Cloudflare account.**
  Hold from the start — it's easier to keep true than to retrofit, and building it
  is what forces the core/userspace boundary to be real. The limit case: a user
  rents _only the core_.
- **[R2] One `fetch`, split by hostname; all egress through one door.** Internal
  names (`<x>.iterate`) resolve free; external origins cross the watched exit.
- **[R3] Three layers, drawn explicitly.** (a) **core/kernel** — the tiny
  non-extensible floor; (b) **first-party userspace** — iterate's own std-lib and
  apps, deployed _as userspace_, not baked into the core; (c) **user userspace**.
  Two independent dimensions: core↔userspace, and first-party↔user. Anything not in
  (a) must be expressible as (b) or (c).
- **[R4] Born from nothing but a secret that authenticates the project.** Empty
  memory, no money; the one birth endowment is an identity/authentication secret.
  Everything else arrives as events (funding first).

---

## 1. Built-ins → described mounts _(foundational — do first)_

Dissolve the `rpc-targets.ts` god-object (~6k) + its generator (~5k). Built-ins
stop being a hardcoded second dispatch regime and become ordinary
**capability-provided mounts**, resolved by one longest-prefix path-walk over
folded state — the same mechanism third parties already use.

Why first: it's the _mechanism_ that workstreams 2–4 all ride on. Once a built-in
is a mount, it can move to first-party userspace [R3], be swapped by a user [R3],
and be reasoned about as "just another capability."

- [x] Map the current surface: `rpc-targets.ts` (7,667) + generator (811) = ~8.5k
      LOC; ~30 hardcoded built-in getters; third-party mounts already event-sourced
      via `capability-host` `resolveLongestPrefix`. See `core-boundary.md`.
- [ ] **Tracer bullet = `kv`** (`KvRpcTarget`, 66 LOC, zero deps): re-express as a
      birth-seeded mount; delete its `ITX_SURFACE_MEMBER_NAMES` collision-check;
      before/after test `itx.kv.get(k)` identical. Then
      `ai`/`browser`/`files`/`docs`/`email`, then `integrations`/`agents`.
- [ ] **PERF CONSTRAINT (Jonas) — the crux risk.** Well-known built-ins must keep
      resolving **in-isolate: ZERO capability-host DO round-trips.** Today built-ins
      are in-isolate (fast); third-party mounts round-trip the capability-host DO
      (slower). Unify the _description_ (one registry, not ~7.7k lines of hardcoded
      getters), NOT the _dispatch_: well-known/local capabilities resolve from a
      **static in-isolate registry** (their description is the same for every project,
      their impl is local); the DO stays on the path only for dynamic (user-added) or
      remote mounts, and even those resolve from an **in-isolate folded snapshot**.
      The `kv` tracer bullet's success criterion IS "no DO hop" — if we can't hit
      in-isolate, we learn it on 66 lines before touching anything else.
- [ ] One path-walk resolver for built-ins + third-party mounts (delete the
      collision guards / reserved-segment special-casing).
- [ ] Generate types/docs/discovery from the one description (not the generator).

Open: which built-in is the cleanest tracer bullet? (leans: a small
self-contained one, not `agents`.)

## 2. One fetch = ingress + egress; all egress through the door _(your #2, + the nested-egress model)_

- [ ] Collapse the ingress lane and the egress lane into one hostname-routed
      `fetch` (`ingress.ts` + `domains/projects/egress.ts`). Internal free,
      external gated.
- [ ] Route **all** vendor egress through the one gate — gmail/github currently
      bypass it by dialing the Secret DO directly. No exceptions.
- [ ] Model the **two nested egress hops** explicitly: **project → iterate
      deployment → world.** Secret substitution / metering / leased-OAuth happens
      at the _iterate_ hop; in self-hosted [R1] the two hops collapse to one. This
      is the clean model of "how a project uses a secret it can't see."
- [ ] Define the hostname discipline that makes internal-vs-external unambiguous.

Open: exact internal naming scheme; where the project-hop vs iterate-hop boundary
is drawn in code so it survives [R1] self-hosting.

## 3. Move more code into userspace _(your #1)_

Rides on #1. Move first-party features out of the core into **first-party
userspace** [R3] (mechanism already proven: review bot → userspace processor
#2223; starter apps packaged into `iterate/starter-apps/*`).

- [ ] Channels/Slack → userspace (the "one channel shape" collapse) — vendor logic
      leaves the platform.
- [ ] **Renderers from events → the whole front-end is eventually userspace.** A
      renderer (e.g. a feed-item renderer) is something you **append to a stream**;
      the platform UI becomes a _generic player_ that reads renderer definitions off
      the stream and plays them. No feed-item rendering hardcoded in platform code.
      ← Jonas flagged this specifically, twice; treat the front-end as userspace,
      not a platform concern.
- [ ] Draw the line: for each thing moved, is it first-party userspace or user
      userspace [R3]?

Open: what's the delivery shape for a renderer-from-events (a capability mount? a
typed event the UI folds)? — decide alongside #1's mount model.

## 4. The pure core model + self-deployable `@iterate` _(your #4 — the thematic spine)_

The framing that #1–#3 serve. Do the boundary-drawing _as_ we do #1, since moving
rpc-targets to mounts is exactly what exposes the line.

- [x] **First-cut enumeration** of the three layers [R3] → `core-boundary.md`.
      Headline: the core is small; the agent + integrations + ~30 std-lib
      capabilities are all first-party userspace. 5 boundary calls await Jonas.
- [ ] Make [R1] a **standing test/target**: can the core boot in a bare Cloudflare
      account with no first-party userspace? Use it as the definition of "core."
- [ ] **Genesis model** [R4]: define a project's birth from nothing but its
      authenticating secret — what the first event is, what the secret authenticates
      it _to_ (iterate deployment? the world directly?), how funding arrives after.
- [ ] Connect to #2: the two egress hops are how the authenticating secret + leased
      secrets are actually used; make sure the boundary is the same one [R1] needs.

Open: is the authenticating secret issued by the iterate deployment (hosted) or
self-minted (self-hosted)? — this is the [R1] hinge.

---

## Notes

- Full menu (incl. items we deferred: one obligation primitive, repo=one-filesystem,
  one OAuth engine, VFS one-path-tree, content-addressed defs, build-key
  hermeticity, delete CONTEXT.md, missing facts) lives in `jam-2026-07-28.md` §10.
- Docs predate the 2026-07-28 merge of `origin/main`; **verify each item's current
  state against `apps/os` before building** — several may be partly done.
