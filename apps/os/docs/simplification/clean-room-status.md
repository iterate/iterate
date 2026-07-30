# Clean-room kernel — status, and the self-hosting design space

A zoom-out on the `apps/kernel` POC, revised after annotation. What it is, what's done, the
**hard requirements** that shape it, how it differs from `apps/os`, and an honest map of the
self-hosting design space (the part that "still seems messy"). Push on anything.

---

## 0. The organizing requirement (this shapes everything below)

**One platform worker, byte-for-byte identical across every deployment — hosted and self-host —
differing _only_ in env-var config.** Not an aesthetic: an identical bundle is cached at the
Cloudflare edge everywhere, so cold starts are ~free and it's very fast. This is a **hard
requirement**, and it forces two rules:

1. **Don't compile deployment-specific behavior into the worker.** Hosted-vs-self-host is
   `APP_CONFIG`, never a different build.
2. **Runtime capabilities live in the platform worker, behind ITX — not compiled into
   userspace.** The LLM-request piece (the thing holding the Cloudflare AI binding), the durable
   log, the egress door: these are _platform capabilities_. Userspace config workers call _into_
   them (`ITX.ai`, `ITX.streams`, …). That keeps userspace thin **and** the bundle identical.

Note the scope: it's the **platform worker** that must be identical. Per-project **config
workers** are inherently different (they're the user's code) — but they're loaded dynamically,
not baked into the platform bundle, so they don't break the rule.

---

## 1. The one-sentence version

The kernel is a **substrate**: it turns a hostname into a confined per-project worker, verifies
who's calling, exposes an `/api`, and is the choke point for capabilities + egress. The
capabilities that make iterate _iterate_ (LLM requests, the durable log, processors) are meant
to hang off it **as platform capabilities via ITX** — some are stubbed today.

**854 lines, two deps (`capnweb`, `jose`), no Node compat, zero imports from `apps/os`.**

---

## 2. What the kernel does today (the substrate)

1. **Ingress** — hostname → `{ projectId, app }`.
2. **Confinement** — a Cloudflare **Worker Loader** runs each config worker in a sandbox that
   sees exactly one binding (`ITX`); props (`projectId`) are unforgeable to it.
3. **Identity ("the wall")** — wide open, or _verify_ a JWT some ingress wall injected. ~47
   lines — **verification only** (see §4 for the honest scope).
4. **`/api`** — a capnweb tree mirroring apps/os: `authenticate → projects.get(slug) → create`.
5. **One egress door** — every sandbox `fetch` routes through one kernel-controlled method
   (the mechanism; policy TBD).
6. **Dashboard = kernel-reserved control plane** — served directly, never via the config worker,
   so a broken config worker can't lock you out of the tool that fixes it.
7. **`project-app-session`** — a narrow, 15-min, project-scoped token so an app acts _as_ the
   user without holding the user's real session.

---

## 3. Conceptual simplifications vs apps/os

- **Identity is "verify a JWT a wall injected."** No OIDC client / cookies / PKCE / DCR /
  session refresh in the kernel — that machinery **moved to the wall** (Cloudflare Access), it
  didn't vanish. The kernel does no login.
- **Two orthogonal knobs** (`wall` + `directory`) instead of a welded auth stack — _this is what
  lets self-host skip auth entirely_.
- **Caller = a raw verified JWT**, decoded on demand; no shadow-principal type chain.
- **Confinement is ~15 lines** and is the load-bearing idea.
- **Capabilities, not compiled code** (§0): the runtime is meant to be ITX capabilities, so
  userspace stays thin and the bundle stays identical.

---

## 4. Honest scope of "the 47-line wall" _(annotation fix)_

The 47 lines **verify a signature** — "is this JWT validly signed by the configured wall." They
do **not** check permissions. Authorization ("which projects can this user reach") is the
**directory** (~210 lines) plus, for hosted, auth.iterate.com's whole membership system. So:

- **Login:** not in the kernel at all — the wall (Cloudflare Access) does it.
- **Identity verification:** 47 lines.
- **Authorization:** the directory (separate concern).
- **MCP:** works via the _same_ wall — Managed OAuth injects a JWT the 47 lines verify — but its
  permissions come from the directory RPC, same as a browser.

So the simplification is real (no login machinery, tiny verification) but it's _not_ "47 lines
replaces apps/os auth." It's "the kernel verifies; the wall logs in; the directory authorizes."

---

## 5. The runtime — not "port later," but "capabilities to hang on ITX"

Reframed per §0. The agent loop, for example, is really several things:

- **Frontend** (React components/hooks) → belongs in the **SDK**, not the platform.
- **Non-load-bearing backend** → mostly userspace.
- **The one load-bearing piece** → the bit that makes the **LLM request** (it holds the
  Cloudflare AI binding). _That_ wants to be a **platform capability** (`ITX.ai`) — identical
  bundle, called from userspace — not compiled into each project.

Same lens applies to the rest:

- **Durable log** — `processEvent` is a stub. Should be a platform capability (`ITX.streams`),
  not userspace.
- **Secrets** — no store yet; the egress door should substitute secrets it holds.
- **Egress _policy_** — the door exists (mechanism); rules/approval/metering don't.

So "outstanding" ≠ "a big userspace port." It's: **build these as platform capabilities behind
ITX.** The durable log is the first and biggest.

---

## 6. Self-hosting is multi-dimensional — and there are three levels

Self-hosting isn't binary. The independent dimensions:

- **Hostnames** — which domains projects live on.
- **Worker deployment** — whose account runs the platform worker.
- **Cloudflare account** — whose account holds the _data_ (streams, R2, DOs).
- **Secrets** — whose secret store.
- **Egress** — one door, or chained doors across accounts.

Three named levels along those dimensions:

| level                  | platform worker   | data (streams/R2/DO) | some capabilities (`ITX.ai`) | control plane |
| ---------------------- | ----------------- | -------------------- | ---------------------------- | ------------- |
| **1 — iterate-hosted** | our account       | our account          | our account                  | ours          |
| **2 — BYO Cloudflare** | our control plane | **their** account    | **our** account (over HTTP)  | ours          |
| **3 — full self-host** | their account     | their account        | their account                | theirs        |

**Level 2 is the commercially interesting one:** "you handle billing, but you don't hold my
data." Their streams/R2/DOs live in _their_ account, in a format identical to full self-host; a
bundle of capabilities (`ITX.ai`, model access) is served from _ours_. Future decouple = swap
those capability origins to theirs. Enabling primitive: **ITX capabilities over HTTP** (capnweb
supports it), because **Workers RPC can't cross Cloudflare account boundaries.**

**Two-level egress falls out of level 2:** a project's outbound goes project-egress-door →
**control-plane egress door** (in our account, across the boundary via HTTP). The control-plane
door is where our metering/policy sits when we're the billing counterparty.

---

## 7. Self-hosting, concretely — the hostname namespace is the crux

The thing that makes hosted "just work" is a **free sibling-hostname namespace**: everyone shares
`*.iterate.app`, so a project gets `foo.iterate.app` and `dashboard--foo.iterate.app` (the `--`
label so one wildcard cert covers it). Self-host doesn't get that for free. Options:

- **Self-host, shared domain (simplest, identical to hosted):** you burn a **control-plane
  domain**; its subdomains are your namespace. Projects at `foo.you.com`, dashboards at
  `dashboard--foo.you.com`. One wildcard `*.you.com`, and self-host = hosted with your domain.
- **Self-host, project = domain (natural for "I have a few domains"):** `example.com` _is_
  project `example`; dashboard at `dashboard.example.com`. Needs a **hostname→project routing
  table** — which is exactly the "routing data structure," and it's **populated when you create
  the project** (so the directory _is_ the ingress router, seen from another angle).
- **Paths (`/dashboard`) — rejected.** SPA base-path hell + cookie scoping. Self-host must use a
  real hostname.

The self-host getting-started shape you'd actually want:

1. Deploy **one** platform worker + create the Cloudflare resources (KV, Worker Loader binding,
   wildcard route/DNS/Total TLS).
2. Go to a control-plane URL (even `controlplane.you.workers.dev`) — see which projects exist,
   **create a project**. This is the registry/directory UI.
3. Each project gets ingress: shared-domain (`--` convention, derivable) or a mapped custom
   domain (routing-table entry written at create).

**No-auth self-host:** deploy with no `wall` → everyone anonymous, single-tenant, you trust your
perimeter (Caddy / tunnel / private network). **`pnpm dev`** is the same corner: wide open + a
local KV directory, zero external deps. In both, the kernel just needs a **routing structure**
(hostname→project) plus a **registry** (which projects exist); "how does it get populated" is the
create flow.

---

## 8. The directory — why it "seems messy" (and the fix)

The word "directory" conflates **two questions**:

1. **Registry / routing** — does this project exist, what's its id, what hostname routes to it?
2. **Authorization** — who is allowed to reach it? (membership)

Four providers sit on a spectrum of how much of #2 they answer:

| provider           | registry            | membership                         | orgs / multi-tenant | honest label                |
| ------------------ | ------------------- | ---------------------------------- | ------------------- | --------------------------- |
| `open`             | "exists when named" | none                               | no                  | demo / zero-config          |
| `local`            | fixed Set           | none                               | no                  | test fixture                |
| `kv`               | KV of slugs         | **none** (anyone through the wall) | no                  | **single-tenant self-host** |
| `auth.iterate.com` | auth-prd DB         | real, per-user                     | **yes**             | **multi-tenant SaaS**       |

**Why we don't _always_ use kv:** kv has **no membership and no orgs** — anyone through the wall
reaches any project. Fine for single-tenant self-host (your box, your people). Impossible for
hosted iterate.com, which is **multi-tenant**: customer A must not reach B's project, and
projects belong to orgs with billing. kv isn't "the simple one we're lazy about" — it's "the
single-tenant one, which hosted structurally can't be."

**The fix (proposed):** stop pretending there are four peers. There are **two real modes** —
`kv` (single-tenant) and `auth.iterate.com` (multi-tenant) — plus `open` as the zero-config "just
let me try it" default. **Delete `local`** (a test fixture wearing a provider's clothes). And
name the split as what it is: _single-tenant vs multi-tenant_, not four interchangeable stores.
Bonus: the registry half of the directory is also the **ingress routing table** (§7) — same data,
two uses.

---

## 9. Open decisions (to make on purpose, not by default)

1. **Adopt the identical-bundle rule formally** (§0) and audit that nothing deployment-specific
   is compiled in. This is the north-star constraint.
2. **Build the durable log as a platform ITX capability** (§5) — the first real runtime piece,
   and the thing that turns the skeleton into a product.
3. **Directory: collapse to single-tenant vs multi-tenant** (§8); unify registry with ingress
   routing.
4. **Pick the self-host hostname story** (§7): shared-domain-only (simplest) vs also supporting
   project=domain (needs the routing table). Probably both, but which is the documented default?
5. **Level 2 (BYO Cloudflare account)** (§6): is the middle tier a near-term target? It needs
   ITX-over-HTTP across accounts + two-level egress. Big, but it's the "don't hold my data" story.
6. **Where does the LLM-request capability live** (§5)? Confirm: platform capability (`ITX.ai`),
   not userspace — so it can be served from our account (level 2) or theirs (level 3).

---

## 10. Through-line

- **Substrate: done and clean** (854 lines, config-only, control plane separated).
- **Organizing rule: one identical, edge-cached platform worker; runtime = ITX capabilities**,
  not compiled userspace. This is the constraint that keeps hosted == self-host.
- **Runtime: mostly unbuilt** — durable log first, as a platform capability.
- **Self-hosting is a design space, not a switch** — three levels (hosted / BYO-account /
  full), several dimensions (hostnames, account, secrets, egress). The middle tier is the
  interesting product.
- **The mess** is one word doing two jobs: "directory" = registry + tenancy. Split it into
  single-tenant vs multi-tenant and most of the confusion goes away.
