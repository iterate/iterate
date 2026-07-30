# Self-hosting the kernel — requirements, the independence lattice, and a build-and-prove plan

A living spec. Goal: lay out every self-hosting concern from the beginning, as testable
requirements + a milestone sequence where **each step builds one thing and proves it**. Jonas's
annotations are folded in and preserved (quoted where the exact wording matters). Keep annotating.

Status legend: ✅ done · 🟡 partial · ⬜ not started.

---

## Part 0 — Two workers: the control plane and the project runner _(this round's big shift)_

"The platform worker" was under-defined. It's now clear it's probably **two workers** (maybe more
for performance — the dynamic worker builder is already separate):

- **Control plane** — knows about _many_ projects: ingress, the hostname→project routing table (KV,
  control-plane-owned — see D-i), the auth **wall**, the directory/registry. One per deployment.
- **Project runner** — knows about _one_ project: it **is** the ITX capability tree
  (`ProjectWorkerEntrypoint`), exposed as a default-export worker with `/api` (capnweb) **plus** the
  Workers-RPC equivalent. Confined. **No wall in front of it** — it sits at `/api` and derives
  identity from what it's handed (props / the `authenticate` call), because the wall is a
  control-plane concern.

> "The control plane that knows about multiple projects, and the worker that knows just about one
> project, could be two different workers — both in the same account, or both in a customer's
> account, or run locally, or one each." — Jonas

**One uniform interface (the unification).** The project runner is always reached through the _same_
ITX/`/api` code path — same account via **Workers RPC (service binding)**, cross-account via a
**persistent bidirectional capnweb WebSocket**. Internal calls go through it too, so "cross-account"
is just "the same path, different transport."

> "This `ProjectWorkerEntrypoint` is actually the ITX capability tree. Even internally we should go
> through that code path, so later we can go through the same path but over HTTP + a capnweb
> connection if it's across accounts." — Jonas

This is _why_ `ProjectWorkerEntrypoint` should break out of the monolith: it becomes independently
deployable, and the control plane talks to it identically wherever it lives.

**Placement is a free matrix:** control-plane {ours} × project-runner {our account · customer account
· per-project account · local container} — independently. Two concrete points:

- **Local runner behind our control plane (home-assistant mode).** Our control plane + ingress +
  auth, project runner running `pnpm dev` on a home box → **data never leaves the box**. Because it's
  behind NAT, the runner **dials out** and holds a bidirectional capnweb session with the control
  plane; inbound HTTP routes _down_ that session. Architecturally must be doable (maybe never
  shipped). Note: some CF resources (e.g. artifacts) need real Cloudflare cloud, so a fully-local
  runner is limited to local capabilities.
  > "Use iterate's control plane, ingress, auth, and a local `pnpm dev` worker on a home-assistant
  > machine — the data never leaves the home assistant. Architecturally this should be doable." — Jonas
- **Account-per-project (design idea to hold, not a hard requirement).** The strongest firewall
  between projects is a **separate Cloudflare account per project** — maximal isolation + budget
  control. Architect from the start so this is easy.
  > "The biggest way to stop projects from fucking with each other is to put them in different
  > Cloudflare accounts. A future model: a Cloudflare account per project with just the project
  > runner in it — maximum control over budgets. Architect everything to make that easy." — Jonas

---

## Part A — Requirements (testable)

Each is a claim we should be able to _prove_, not just assert.

- **R1 — Identical platform-worker bundle.** The platform (kernel) worker is byte-for-byte
  identical across every deployment; hosted-vs-self-host is `APP_CONFIG`/env only. _Why:_ an
  identical bundle is edge-cached everywhere → ~free cold starts, very fast. _Test:_ build with
  hosted and self-host config; `sha256` the bundles → equal. 🟡
- **R2 — Runtime = platform capabilities behind ITX, not compiled into userspace.** The
  load-bearing bits live in the platform worker and are called from userspace via `ITX.*`. _Test:_
  a config-worker bundle contains none of the runtime; capabilities resolve at runtime. 🟡
- **R3 — No-auth self-host is first-class — down to a Raspberry Pi.** Deploy with no `wall` →
  everyone anonymous, single-tenant, works. The floor of the ladder is literally **`pnpm dev` in
  Miniflare on a Pi** on your local network.

  > "particularly interesting when you just run this in MiniFlare. Just run `pnpm dev` on your
  > Raspberry Pi, and it should get you relatively far. You're in your local network, you don't
  > care about anything." — Jonas

  _Test:_ Miniflare, no wall, create + reach a project, zero external deps. ✅ (dev profile)

- **R3b — Miniflare / container is a supported low-stakes deployment _tier_, not just a dev
  convenience.** `wrangler login` (any Cloudflare account) + `pnpm dev` → working; run it as, e.g., a
  home-assistant app — `pnpm dev` in a container.

  > "`pnpm dev` in Miniflare should more or less just work. It should require basically a wrangler
  > login authenticated with some Cloudflare account, and then you can just crack on. You should be
  > able to run this as a home-assistant app — just `pnpm dev` in a container." — Jonas

  Reliability model for this tier is explicitly **restart-on-crash, not HA**:

  > "Miniflare isn't 'production grade' — it does the trick and can be restarted when it falls
  > over." — Jonas

  Implications: **(a)** it's a third value on the _compute_ dimension — **your own container
  (Miniflare)**, not the Cloudflare edge — running the _same_ identical bundle (R1), minus the
  edge-caching benefit; **(b)** the `wrangler login` account is the **source for Cloudflare-only
  capabilities** (e.g. Workers AI / `ITX.ai`), which ties directly into per-capability sourcing
  (R5) — a truly-offline build using no cloud capabilities would need no account at all (→ OQ-g).
  _Test:_ fresh machine → `wrangler login` + `pnpm dev` → create + use a project (incl. an `ai`
  call); kill the process → restart → state intact (from `kv`/streams). 🟡

- **R4 — Hosted-vs-self-host is config, not a fork.** Same code path, same tests. ✅ (kernel), 🟡
  (runtime)
- **R5 — Capabilities are per-source, and this is why the big RPC targets must break up.** Each
  ITX capability (`ai`, `repos`/`artifacts`, `browser`, `ai-search`, `egress`, `secrets`,
  `streams`, …) is independently **sourced** from our account _or_ yours, carrying its own
  metadata (which AI gateway, etc.). This is a **primary argument for decomposing the monolithic
  RPC targets** — the capability tree becomes the config surface.

  > "This capability tree on ITX is actually another argument in favour of breaking out these
  > massive RPC targets. Depending on the configuration, these built-in platform capabilities come
  > from different places, and they can be represented as app config." — Jonas

  Concretely: `itx.repos.get(...).clone()` hits **your** account's repos if you source `repos`
  yourself (private code stays in your account), while you might still use **our** `ai` service
  binding. _Test:_ source `repos` from account A and `ai` from account B in one project; both work. ⬜

- **R6 — Hostname namespace.**
  - **Hosted (L1):** free `*.iterate.app` sibling namespace (`--` label). **And** Cloudflare-for-
    SaaS custom domains work _even fully hosted_ — your own domain(s) on our workers/account.
    Multiple domains per project must be possible.
    > "Even though it's our workers, our account, our everything, you can still use your own domain
    > (Cloudflare for SaaS). We use that frequently. Loads of people will. Maybe multiple domains to
    > a single project." — Jonas
  - **Self-host:** the control-plane deployment needs **a domain with wildcard DNS (for now)** —
    locked. Custom hostnames are decoupled from _how_ Cloudflare implements them (not tied to
    enterprise Cloudflare-for-SaaS): the control plane helps you set DNS, but **ingress routing only
    cares that the HTTP request reached our worker and that a lookup table (KV) says which project
    it belongs to.**

    > "It just matters that the HTTP request has somehow arrived at our worker, and there is some
    > entry in our lookup table that says which project this belongs to — probably in KV." — Jonas

  - **No paths** — real hostnames only. 🟡

- **R7 — Iterate is the HTTP _edge_, never the _store_ — including webhooks.** In BYO-account:
  you get `iterate.app` hostnames automatically (we do ingress); iterate is first + last HTTP
  contact (ingress + egress); iterate **never stores** in/out data — it lives only in **your**
  streams/R2. **This must extend to webhook ingress**: our first-party Slack/GitHub/etc. ingress
  must not durably store webhooks (short TTL only); the control plane holds only _which webhook →
  which project_ routing, then cross-posts. _Test:_ run a level-2 project; assert data-at-rest
  (incl. webhook payloads) exists in the customer account and **nowhere** durably in ours. ⬜
- **R8 — First-party webhook ingress is a first-class reason to BYO-account.** Why bring your own
  Cloudflare account but still route through iterate? To use our **first-party webhook ingress**
  (Slack, GitHub, everything pre-wired) without giving us your data.

  > "Why would somebody bring their own Cloudflare account so they can use our first-party webhook
  > ingress, where we have Slack and GitHub all nicely set up? They'd need to be comfortable that we
  > don't store those webhooks in our router — currently not the case, but it should be. Short TTL." — Jonas

  _Test:_ a GitHub webhook to our edge lands in the customer's project stream (their account); our
  router retains only routing state + a short-TTL buffer. ⬜

- **R9 — First-party secrets / integrated billing as capabilities.** Iterate can offer
  volume-discounted third-party access via **our** secrets/keys, metered — even when you BYO
  account. Storage-shaped capabilities (R2, repos/artifacts) default to **yours**.
  > "It's conceivable to use iterate's first-party secrets to access other AI accounts with
  > integrated billing — e.g. an API key that lets you use a third-party system at a large
  > volume-discount. That's fine. But for storage, like R2 or repos artifacts, you'd want your own." — Jonas
  > ⬜
- **R10 — Project-to-project isolation is non-negotiable at every level.** Confinement guarantees
  it (Worker Loader + props scoping) regardless of directory mode.

  > "When you self-host, you should have the guarantee that one project cannot fuck with another
  > project." — Jonas

  _Test:_ project A's config worker cannot read/reach project B's data or capabilities. ✅ (mechanism) 🟡 (assert in self-host)

- **R11 — Cross-account capabilities via a bidirectional capnweb connection.** Workers RPC can't
  cross CF account boundaries. capnweb **is** the RPC protocol (a re-implementation of Workers
  RPC), so for chatty cross-account work we open a **persistent bidirectional capnweb (WebSocket)
  session** and do RPC through it — not HTTP-batch-per-call.
  > "capnweb is basically a re-implementation of Workers RPC. If we go back and forth a lot over the
  > public internet, we establish a bidirectional capnweb connection and do the RPC through that." — Jonas
  > ⬜
- **R12 — Move up and down the ladder.** Any transition (level ↔ level, or one dimension) is
  **config + data-migration, never a code rewrite** (Part C). ⬜
- **R13 — Directory = registry (+ ingress routing) + membership; two real modes.** `kv`
  (single-tenant) vs `auth` (multi-tenant); `open` = zero-config default; delete `local`. The
  registry half **is** the ingress lookup table (R6). 🟡
- **R14 — Dashboard + `/api` are kernel-reserved control plane.** Always reachable regardless of
  config-worker health. ✅

---

## Part B — It's a lattice, not a ladder

"Three levels" is shorthand; the truth is **independent dimensions** — you can occupy any
consistent combination, which is what R5 and R12 require.

| dimension                                         | "iterate" end                                  | "you" end                                                     |
| ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| **Ingress hostname**                              | `*.iterate.app` (+ CF-for-SaaS custom domains) | your domain(s)                                                |
| **Compute** (platform worker)                     | our CF account (edge)                          | your CF account (edge), **or your own container (Miniflare)** |
| **Data at rest** (streams / R2 / DO / repos)      | our account                                    | your account                                                  |
| **Control plane / directory**                     | ours                                           | yours                                                         |
| **Egress edge** (last HTTP hop out)               | ours                                           | yours                                                         |
| **Each capability** (`ai`, `repos`, `secrets`, …) | our account _(possibly volume-discounted)_     | your account _(per-capability)_                               |

The named levels are common bundles:

| level                  | hostname                      | compute   | data at rest | capabilities                                            | control plane |
| ---------------------- | ----------------------------- | --------- | ------------ | ------------------------------------------------------- | ------------- |
| **1 — iterate-hosted** | ours (+ your custom domains)  | ours      | ours         | ours                                                    | ours          |
| **2 — BYO account**    | **ours** (auto `iterate.app`) | **yours** | **yours**    | **mixed** (e.g. storage yours, `ai`/discounted-3p ours) | ours          |
| **3 — full self-host** | yours                         | yours     | yours        | yours                                                   | yours         |

**Level-2 shape (R7):** HTTP hits _our_ ingress at `--proj.iterate.app` → forwarded across the
account boundary to _your_ project worker → reads/writes _your_ streams → egresses back through
_our_ edge. We are a **pass-through for traffic + webhooks, never a store.**

**Why level 2 is the product:** iterate-hosted convenience (billing, first-party webhook ingress,
volume-discounted capabilities) **without** iterate holding your data. The nuance Jonas flags:
this isn't all-ours-or-all-yours — storage tends to be yours, some capabilities (discounted 3p
access via our keys) stay ours, and it's **per-capability**. Wants more thought on the exact
cross-account wiring; notes it **rhymes with what the Tasks app and the clean-room dashboard
already do** (the remote-app mutual-auth pattern).

---

## Part C — Moving up and down the ladder (R12)

Because everything is config + the capability tree is per-capability sourced, each transition is
bounded, not a rewrite:

| transition                              | what it takes                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1 → L2** (lift data to your account) | provision your CF account; **migrate** existing data; repoint the `data`/`streams`/`repos` capability sources; keep hostname + control plane ours. |
| **L2 → L3** (cut the cord)              | move remaining capabilities (`ai`, egress) to your account; stand up your own control plane + directory + wall; move ingress to your domain.       |
| **L3 → L2** (come back)                 | point ingress at `iterate.app`; delegate control plane to us; keep data where it is.                                                               |
| **any single dimension**                | e.g. "use my own AI gateway" or "keep repos in my account" = repoint just that capability source (R5). No data move, no code change.               |

Requirement: **no transition edits project code** — the lattice moves under it.

---

## Part D — Build-and-prove milestones

Ordered so each proves one thing and composes onto the last. Each = _build → prove_.

- **M0 — Lock R1 (identical bundle).** CI assertion that the platform-worker build is byte-identical
  across profiles. Prove: `sha256(hosted) == sha256(selfhost)`. _First — it's the north star._ 🟡
- **M1 — Self-host, shared domain, wide open (incl. the Pi floor).** Deploy the one worker to a
  **fresh domain + fresh CF account** (and separately: `pnpm dev` in Miniflare), wildcard route, no
  wall, `kv` directory. Prove: create `foo`; `foo.you.com` serves; `dashboard--foo.you.com` serves. 🟡
- **M2 — Ingress lookup table + custom hostnames (R6/R13).** A hostname→project **KV lookup
  table**, written at create; ingress resolves _any_ domain that reaches the worker (decoupled from
  CF-for-SaaS specifics). Prove: map `example.com` → `example` and a second domain to the same
  project; both route. ⬜
- **M3 — Break up the RPC targets into a sourced capability tree (R5).** Each capability names a
  source (local binding vs remote). Prove: `repos` from account A, `ai` from account B, in one
  project. _This is the structural unlock for the whole lattice._ ⬜
- **M4 — Durable log as a platform capability (`ITX.streams`, R2).** Real append/subscribe backed
  by DO/R2 **in the configured account**; kill the `processEvent` stub. Prove: append → persist →
  subscriber replays. _First real runtime piece; makes "data in your account" mean something._ ⬜
- **M5 — Cross-account capability over a bidirectional capnweb session (R11).** Prove: `ITX.ai`
  served from another account over a persistent capnweb WS round-trips like a local binding. ⬜
- **M6 — Cross-account provisioning (via customer's CF API key, R-new).** Our control plane
  creates the needed resources (KV, DO, R2, routes) in the customer's account idempotently. Prove:
  from an empty customer account + their API key, control plane stands up a working project. ⬜
- **M7 — Level 2 end-to-end (R6/R7/R9/R11).** Our ingress (`--proj.iterate.app`) → their worker
  (capnweb) → their streams; two-level egress; `ai` + discounted-3p from us; webhook ingress with
  short-TTL-only. Prove: data + webhooks at rest **only** in their account; nothing durable in ours. ⬜
- **M8 — Ladder mobility (R12).** Repoint capability sources + migrate streams/R2 between accounts.
  Prove: move `ai` to their account and data back to ours — **code unchanged** each time. ⬜

Rough order: **M0 → M1 → M2 → M3 → M4 → {M5, M6} → M7 → M8.**

---

## Part E — Decisions (resolved by annotation)

- **D1 — Transit-yes / at-rest-no is acceptable.** Iterate seeing HTTP _transit_ in level 2 (while
  storing nothing) is fine. > "I actually think that is totally fine." — Jonas
- **D2 — Project isolation is the hard guarantee** (R10), _not_ multi-user tenancy. Self-host must
  guarantee one project can't touch another (confinement provides it). Whether self-host also needs
  multi-_user_ orgs is a smaller residual (OQ-b).
- **D3 — BYO-account auth, for now: the customer gives us a Cloudflare API key.** No fancier scoping
  yet. > "you would have to provide a Cloudflare API key or something like that to us — no way
  > around it, for now." — Jonas
- **D4 — Cross-account chattiness → a persistent bidirectional capnweb session** (R11), not
  HTTP-batch-per-call.
- **D5 — If we host the control plane, we always have a billing relationship.** Customer pays for
  their own-account storage/bindings; anything used from our account is **metered**. > "any they use
  from our Cloudflare account will be metered." — Jonas
- **D6 — Two workers: control plane + project runner** (Part 0). The runner is the ITX tree; no wall
  in front of it; reached via Workers RPC (same account) or bidirectional capnweb (cross-account).
- **D7 — No wall on the project runner** (resolves OQ-c). Identity crosses via the `/api`/ITX path
  (props / `authenticate`); the wall is a control-plane concern.
- **D8 — Ingress routing table is control-plane-owned** regardless of where compute/data live
  (resolves OQ-i). > "I would say so." — Jonas
- **D9 — Self-hosters own their own upgrades** (resolves OQ-d): `git pull` + `pnpm deploy`. Not our
  concern to auto-update. > "Self-hosters have to sort this out themselves." — Jonas
- **D10 — Data-migration mechanics: out of scope for now** (parks OQ-e). > "Don't worry about this
  now." — Jonas
- **D11 — Cross-account provisioning = an Alchemy-v2 / preview-env-style script** (resolves OQ-f):
  assume a script "creates the stuff" in the customer account and returns the identifiers we need to
  deploy. > "You can assume there's a script that creates the stuff needed and gives us the
  identifiers." — Jonas
- **D12 — Support "our control plane + local project runner"** architecturally (resolves OQ-g): the
  home-assistant mode, data-stays-local; fully-offline is limited to non-cloud capabilities.

---

## Part F — Open questions (still)

- **OQ-a — Platform vs userspace boundary for processors.** Stream processors are per-project
  userspace, so they don't break R1's _platform_-bundle rule — but the exact line (what's platform/
  ITX-exposed vs userspace/loaded) is undecided. > "Not sure yet." — Jonas
- **OQ-b — Multi-_user_ self-host.** D2 settles project isolation. Does self-host also need
  multi-user orgs/membership (today only `auth.iterate.com` provides that), or is "project isolation
  - whoever's through your wall" enough?
- **OQ-c — Where does the _wall_ live in level 2?** Ingress is at our edge (`iterate.app`) but
  compute is theirs. Does our Access org front their compute, and how does the verified identity
  cross the account boundary to the directory? (Interacts with D3/D4.)
- **OQ-d — Versioning / upgrades of the identical bundle.** If the platform worker is edge-cached
  and identical, how do self-hosters _get updates_ — pin a version, auto-update, redeploy? R1 makes
  the bundle stable but says nothing about how it advances.
- **OQ-e — Data-migration mechanics (R12/M8).** How do streams/R2/repos actually move between
  accounts — copy semantics, downtime, consistency, cutover?
- **OQ-f — Cross-account provisioning surface (M6).** Exactly what our control plane creates in
  the customer's account (KV, DO, R2, routes, DNS), and how idempotently — the cross-account
  `ensure-resources`.
- **OQ-g — Is a fully-offline (no Cloudflare account) container mode a goal (R3b)?** R3b assumes
  "basically a wrangler login," because Cloudflare-only capabilities (Workers AI) are Cloudflare-
  backed. Is a _zero-cloud_ mode (no account at all, only local capabilities) worth supporting, or
  do we assume a wrangler-login is always present because you'll want `ai`?

### Author questions (my steer requests — please answer these too)

- **OQ-h — Build level-2 cross-account wiring on the _existing_ remote-apps mutual-auth pattern?**
  You flagged twice that it "rhymes with what the Tasks app and the clean-room dashboard already
  do" — another origin authenticates to us and calls ITX back. Is that the concrete implementation
  basis for M5/M7, or do we want a fresh mechanism? (If yes, I'll write up exactly how that pattern
  works today as the level-2 spec.)
- **OQ-i — Is the ingress lookup/routing table always control-plane-owned?** In level 2, ingress is
  at _our_ edge (`iterate.app`) but data is in _your_ account. I assume the hostname→project routing
  table (R6/R13) lives in the **control plane** (ours when we host it) regardless of where data
  lives — routing is a control-plane concern, decoupled from storage. Confirm?
- **OQ-j — What's the actual _next build_?** My lean on sequencing: **M0** first (lock the
  identical-bundle invariant so we don't drift), then **M3** (break up the RPC targets into a
  sourced capability tree — the structural unlock the whole lattice hangs off) _before_ **M4** (the
  durable log — the thing that turns the skeleton into a product). Is that the order, or is the
  durable log urgent enough to come first?

---

## Part G — What's already true (build on it, not over it)

- Substrate: confinement, `wall` (verify-a-JWT, ~47 lines), `/api` capnweb tree, one egress door,
  kernel-reserved dashboard — deployed hosted + self-host, config-only difference. ✅
- No-auth + `pnpm dev`/Miniflare self-host corner works (wide open + local kv). ✅
- Directory has `kv` (single-tenant) + `auth.iterate.com` (multi-tenant) live; needs the R13
  collapse + registry-as-router unification. 🟡
- `getUserGrants` / `getUserGrantsByEmail` directory RPCs exist for membership. ✅
- Cloudflare Access + auth.iterate.com IdP proven for hosted identity. ✅

The gaps: the **runtime as platform capabilities** (M4 durable log first), the **sourced capability
tree** (M3 — the structural unlock, and the argument for breaking up the big RPC targets), and the
**cross-account lattice** (M5–M8). Everything above is plumbing until the durable log exists.

---

## Part H — The control-plane ↔ project-runner interface: what already exists (resolves OQ-h)

OQ-h asked whether the cross-account/project-runner interface should build on the existing
remote-apps mutual-auth pattern. Answer, from a source audit: **most of it already exists** — the
`/api` capnweb door _is_ "a project runner exposing its ITX tree," and two credential lanes already
cover machine and on-behalf-of auth. The genuinely new bits are a _mutual_ cross-account credential
and a _pinned, long-lived_ session.

**Reusable verbatim:**

- **The capnweb `/api` door = the project runner.** `authenticate()` returns a confined ITX tree
  (`apps/os/src/rpc-targets.ts:6108` `UnauthenticatedOsRpcTarget`; kernel `kernel.ts:347`
  `newWorkersRpcResponse(request, new Os(...))`). Served over **WebSocket** (blessed transport — lint
  `iterate/no-capnweb-http-batch` forbids HTTP-batch in source) via
  `newWorkersWebSocketRpcResponse` / `newWorkersRpcResponse`, dialed by `newWebSocketRpcSession`.
- **Machine lane — the born `project-secret` API key.** Every project is born with a readable
  `itxk_…` key at `/secrets/project-api-key` (`rpc-targets.ts:5379`); verified **inside the Secret
  Durable Object** (constant-time `verifyMaterialField`, `secret-durable-object.ts:509`); grants
  exactly one project, no admin, no user (`auth.ts:282-298`). A ready machine↔machine credential.
- **On-behalf-of lane — `project-app-session`.** Narrow, short-lived (15-min), per-project HS256
  grant, verified locally (`project-app-session.ts`; os `auth.ts:300-313`). The kernel front door
  already mints + stamps it for the dashboard; the Tasks vessel and clean-room vessel both dial back
  with it (`newWebSocketRpcSession(...).authenticate({ type: "project-app-session", token })`).
- **HTTP fronting — the config-worker reverse proxy** (`apps/tasks/src/config-bridge.ts`
  `TasksApp.create`): member-gate then rewrite host → vessel origin → `fetch`. Note it's a _proxy_,
  not a capability mount.
- **Persistent redial already proven** — `apps/tasks/src/checkout-do.ts` `ProjectDial` holds and
  lazily re-opens a bidirectional capnweb WS from a stateless worker.

**Deliberately removed (prior art to re-read before rebuilding):** `remoteCapability` was a
\*platform-side capnweb capability **mount\*** (exposing a remote app's caps _into_ the project's ITX
tree). It was **removed in #2156** in favor of the HTTP reverse proxy. It's the closest prior art for
"expose a project-runner's tree into a control plane" — re-read that commit before resurrecting it.

**What's genuinely new for the lattice:**

1. A **mutual** cross-account credential — today each lane is one-directional (a client presents to a
   server); control-plane↔runner needs both ends to trust each other.
2. A **pinned, long-lived** control-plane↔runner session — existing dials are per-request /
   redial-on-stale, not a durable link (needed for the NAT/home-assistant case where the runner dials
   out and inbound HTTP routes down the held session).

**Decision D13 — build the interface on the existing `/api` capnweb door + the two credential lanes;**
add only (1) the mutual cross-account credential and (2) the pinned session. Do **not** resurrect
`remoteCapability` without re-reading #2156.
