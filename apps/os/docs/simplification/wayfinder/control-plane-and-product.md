# The minimum elegant interface: generic control plane · iterate product · the two web apps

Written during the overnight build (2026-07-31), grounded in what R1–R4 actually proved. This is the
synthesis Jonas asked for: _"the minimum most elegant interface between all these things — the control
plane, and the iterate product that wraps it with first-party secrets and integrations."_ Plus the
two-web-apps split.

---

## 1. The three layers (and the one seam between them)

```
┌──────────────────────────────────────────────────────────────────────┐
│  ITERATE PRODUCT  (a thin layer, off-by-config in self-host)           │
│    · first-party secrets (Exa/Parallel/AI keys we hold + meter)        │
│    · first-party integrations (Slack/GitHub OAuth receivers)  [future] │
│    · billing (metering → what the customer owes)                       │
│  ── consumes ──▼── the generic control plane's config + hooks ─────────│
├──────────────────────────────────────────────────────────────────────┤
│  GENERIC CONTROL PLANE  (the kernel's "many projects" half)            │
│    · ingress + routing table (host → project)                          │
│    · the wall (verify an injected JWT)  · the directory (list/create)  │
│    · the egress door (secret substitution + metering hook)             │
│    · /api (capnweb) + /mcp (MCP) — headless control surfaces           │
│    · the Worker Loader (confinement) + script exec + dynamic caps      │
├──────────────────────────────────────────────────────────────────────┤
│  PROJECT WORKER  (the kernel's "one project" half = ProjectWorkerEntrypoint)│
│    · streams (durable log) · secrets store · ai · repos [future]       │
│    · runs userspace confined (config worker / run_script)              │
└──────────────────────────────────────────────────────────────────────┘
```

**The seam (the whole point): the iterate product is CONFIG the generic control plane consumes — not a
fork, not a wrapper worker.** Proven concretely in R1/R3:

- `AppConfig.platformSecrets` **is** the iterate-product secrets layer. Present → the control plane's
  egress door substitutes + meters first-party keys. Absent/`[]` → a generic control plane with no
  first-party secrets. **The exact same worker, the exact same code path.** (R1 proved substitution +
  origin-pin + meter live; R3 proved `ai.source:"remote"` is just this same door.)
- The generic control plane never mentions "iterate", "Exa", or "billing". It knows only: _"here are some
  origin-pinned secrets to substitute at egress, and a meter hook to call."_ Iterate the product supplies
  those; a self-hoster supplies none (or their own).

**The elegant collapse discovered in R3:** _remote-sourcing a capability == egress through the control
plane with a first-party key._ So "per-capability sourcing" (M3) and "first-party metered secrets" (R9)
and "the iterate product" are **one mechanism**: the control-plane egress door + platform secrets +
the meter hook. AI-remote, Exa, Parallel — all the same door. This is the minimum interface: **one door,
one config list, one hook.**

---

## 2. What is generic vs product (the exact line)

| concern                                           | generic control plane               | iterate product                             |
| ------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| ingress / routing / wall / directory              | ✅                                  | —                                           |
| egress door + secret substitution                 | ✅ (mechanism)                      | supplies the platform secrets + meter sink  |
| `/api` + `/mcp`                                   | ✅                                  | —                                           |
| Worker Loader / exec / dynamic caps               | ✅                                  | —                                           |
| streams / project secrets / ai-local              | ✅ (project worker)                 | —                                           |
| **first-party secrets** (Exa/Parallel/metered-AI) | —                                   | ✅ `platformSecrets` config                 |
| **first-party integrations** (Slack/GitHub OAuth) | ingress routing to a project stream | ✅ the OAuth client + receiver _(future)_   |
| **billing** (cost download, invoicing)            | the meter _hook_                    | ✅ the meter _sink_ + billing DO _(future)_ |

**Recommended structural clarification (not yet applied — keeps proven code stable):** group all
product config under one key — `AppConfig.product?: { platformSecrets, integrations, billing }`. Then
"generic control plane" is literally "config with no `product` key", and the iterate deployment is "config
with a `product` block". One grep tells you the whole product surface. _(Flagged for a follow-up; R1–R4
left `platformSecrets` top-level to avoid churning the live proofs.)_

**Even cleaner (thermonuclear option, §5):** the product layer could be a _separate module_ that the
control plane imports only its config-shape from — so the generic kernel has zero product code, and
`apps/iterate` supplies the `product` config + the integration receivers. This is the "iterate is a thing
built ON a generic control plane" framing (ADR 0030), taken to a module boundary.

---

## 3. The two web apps (R6 — Jonas's late insight, confirmed by the build)

The build made the split obvious. There are **two genuinely different web apps**, and they map exactly to
the two halves of the kernel:

### (a) The control-plane web app — "the console"

- **What:** create projects, list your projects, pick one, see billing/usage, manage domains. The human
  face of the **generic control plane** — the UI twin of `/api` + `/mcp` (which already do list/create/reach).
- **How addressed:** the control plane's own hostname (e.g. `iterate.com` / `<cp-host>`), NOT a project
  host. Headless siblings `/api` + `/mcp` already live here (once the CP has its own front door).
- **Auth:** behind the wall (Access/OTP), talks to the directory. Cross-project by nature.
- **Analogy:** today's `apps/os` dashboard's "org/projects" surface, minus a specific project.

### (b) The main dashboard — "the project app", written like the Tasks app

- **What:** the rich per-project experience (chat, streams, agents, files…). Jonas: _"written more like
  the Tasks app."_ This matters: the Tasks app is a **remote app that authenticates to a project and calls
  its ITX** — it holds no platform privilege, reaches capabilities only through the project's `/api` with a
  narrow `project-app-session`. That's exactly the confinement the kernel already enforces.
- **How addressed:** a project host (`dashboard--<slug>.<base>`), kernel-reserved (ADR 0014) so a broken
  config worker can't lock you out. Already scaffolded as the `kernel-mini-os` vessel.
- **Auth:** the front door mints a narrow `project-app-session`; the app acts AS the user, scoped to the
  one project. (Proven in the existing dashboard vessel.)

**Why two, not one:** the console is _cross-project + control-plane-privileged_ (create projects, billing);
the dashboard is _single-project + userspace-shaped_ (no platform privilege, reaches only its project's
ITX — like any remote app). Conflating them would force the project dashboard to hold cross-project /
control-plane power it must never have. The split is the same generic-vs-scoped line as the kernel itself.

**Build note:** both already have their seams. The console = a UI over the directory (the `/api`/`/mcp`
list-create-reach surface). The dashboard = the `project-app-session` remote-app pattern (Tasks/`ProjectDial`).
Neither needs new kernel mechanism — they're two clients of surfaces that exist.

---

## 4. The whole system, in one breath

_A generic control plane routes a hostname to a project, verifies who you are at the wall, and hands the
project worker a confined ITX tree. Everything the project does to the outside world goes back through the
control-plane egress door. The iterate product is nothing but a bag of origin-pinned first-party secrets +
a meter hook that the generic egress door consumes — plus (future) first-party OAuth receivers that route
into project streams. Two web apps sit on top: a cross-project console (the control plane's face) and a
per-project dashboard (a remote app scoped to one project, like Tasks). Self-hosting = the same worker with
the product bag empty._

---

## 5. Open structural choices this surfaces (feed the thermonuclear review)

1. **Group product config under `AppConfig.product`** (or even a separate `apps/iterate` module that owns
   the product config + integration receivers). Makes "generic vs product" a boundary, not a convention.
2. **The meter belongs in a DO, not KV** (R1 limitation) — and "the billing DO" is a clean home for the
   product's meter sink + cost-download job.
3. **Integrations (Slack/GitHub) are the next product piece** — the OAuth receiver at the CP host + routing
   the webhook into a project stream (the directory-stream pattern from apps/os). Not built tonight.
4. **`/api` + `/mcp` want the control plane's OWN hostname**, headless — the forcing function for splitting
   the one worker into CP + project-runner workers (ADR 0017). Tonight they ride project hosts; that's the
   one wart the split removes.
