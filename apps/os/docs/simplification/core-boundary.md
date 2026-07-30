# Core boundary — first cut (2026-07-28)

Answers TODO [R3] "what is core vs first-party userspace vs user userspace?" and
serves [R1] (self-deployable `@iterate`). Grounded in the _current_ merged code,
not the (older) pile. Numbers are rough except where noted.

## Headline

The core is **small**. Most of what looks like core today is **first-party
userspace** baked into an **8,478-LOC god-object** (`apps/os/src/rpc-targets.ts`
7,667 + `scripts/generate-itx-api.ts` 811) plus the `domains/*`. Notably, **the
agent itself is userspace** — a stream processor that runs in a sandbox, not a
kernel concept. **Moving built-ins → described mounts (workstream 1) is literally
the act of drawing this line**: every built-in that becomes a mount crosses from
"core" to "first-party userspace."

## The two dimensions [R3]

- **core ↔ userspace** (kernel floor vs everything built on it)
- within userspace: **first-party** (iterate ships it) **↔ user** (you bring it)
- plus a fourth bucket that is neither: **hosted-only platform ops** — excluded
  from the self-deployable core [R1].

---

## CORE — the self-deployable kernel [R1 boots *only* this in a bare CF account]

The tight floor. Everything here is "must exist or nothing runs / nothing is
safe":

- **Confined execution** — run untrusted code in isolation. (`domains/workers` +
  `domains/sandboxes` as the execution substrate.)
- **Durable log + processor engine** — append / follow, subscription + wake.
  (`domains/streams`.)
- **Capability resolver + confinement** — the path-walk that resolves every mount
  and blocks cross-project/exfil. (`domains/capability-host`: `resolveLongestPrefix`,
  provide/revoke.) _This is what ex-built-ins resolve through after workstream 1._
- **One egress door** — the watched exit + approvals. (`domains/projects/egress*`.)
- **Identity + project isolation** — the one auth decision, the project edge
  (D1/R1), request threading. (`auth`, `request-context`.)
- **Addressing** — the `{projectId, path}` naming every DO rides.
  (`durable-object-names`.)
- **Secret vault + substitution at the door.** (`domains/secrets`.) _(boundary call
  below)_
- **The one `fetch` entrypoint** — ingress routing, unifying with egress per [R2].
  (`ingress`, `worker.ts` spine.)

Rough size: on the order of ~15–25k LOC of genuine floor — a fraction of the app.

## FIRST-PARTY USERSPACE — iterate's distribution (shippable as mounts/packages; swappable; self-hostable)

The bulk. All of this _could_ be a described mount or a userspace package:

- **The agent** (`domains/agents`, ~5k) — the flagship, but it's a processor in a
  sandbox. **Userspace.** ← the biggest statement the line makes.
- **Channels / integrations** (`domains/integrations`, ~8k) — Slack, GitHub,
  Telegram, email inbound. ← the "Slack → userspace" cut.
- **Dev surface** — `workspaces` (editor), `repos` (source storage + build entry),
  `typecheck` (IDE hints). _(boundary calls below)_
- **Std-lib capabilities that are really just mounts** — `kv`, `ai`, `browser`,
  `files`, `docs`, `email` (send), `mcp`, `openapi`, `scheduler`, `devices`,
  `parallel`, `inbound-mcp-server`, `notifications`. These are ~30 hardcoded
  getters in `rpc-targets.ts` today; each is a mount waiting to happen.
- **The dashboard UI** (`routes/` + `components/`) — trends toward _user_ userspace
  via renderers-from-events (see below).

## USER USERSPACE — what a user brings / builds

- Their config worker (`fetch` + `processEvent`), their apps, their own capability
  mounts, and — per Jonas — **their renderers**: a renderer is **appended to a
  stream**, and the platform UI is a _generic player_ that reads renderer defs off
  the stream and plays them. The front-end itself becomes user userspace.

## HOSTED-ONLY PLATFORM OPS — NOT part of the self-deployable core [R1 excludes]

- `config.ts` / env, `observability` (posthog/tracing), preview environments,
  deploy/`ensure-resources`/`erase-data` scripts, operator/admin auth + auth-worker
  delegation, billing + fleet ops, and the **leased pre-approved OAuth clients**
  (the moat — §7 of the jam). Self-hosting means you do without these or BYO.

---

## Boundary calls that need Jonas's ruling

1. **repos / workers.** Execution (`workers`) is clearly core; but source storage +
   the build pipeline (`repos`) is swappable (BYO GitHub/Gitea). _Lean: `workers`
   (exec) = core; `repos` (storage/build) = first-party._
2. **secrets.** Storage + substitution is tied to the egress door + identity → _lean
   core_; but "which vault" could itself be a mount. Core, or a privileged mount?
3. **typecheck.** The script-safety gate + the fleet-migration tripwire (§9) feels
   core; the IDE-hints feel first-party. _Lean: split — gate = core, hints =
   first-party._
4. **scheduler.** Alarms are a core primitive; the cron/recurrence abstraction is
   first-party. _Lean: split — alarm = core, scheduler = first-party._
5. **Confirm the big one: the agent is userspace, not core.** Both maps say
   first-party; the model (agent = processor) implies it. Ratify?

---

## The mechanism that moves the line: built-ins → mounts

- **Today:** built-ins are hardcoded getters in `rpc-targets.ts`; third-party
  capabilities are **event-sourced mounts** resolved by `resolveLongestPrefix` over
  `CapabilityRecord`s (folded from `capability-provided` events,
  `domains/capability-host/`). _The mount mechanism already exists._
- **Target mount shape** (`capability-host/types.ts`):
  `CapabilityProvidedPayload = { path: string[]; type: "live" | "itx-expression";
types?: string; instructions?: string; … }`.
- **To move a built-in across the line:** re-express it as a **birth-seeded
  `itx-expression` mount**; delete its collision-check in `ITX_SURFACE_MEMBER_NAMES`.
- **Tracer bullet: `kv`** — `KvRpcTarget`, 66 LOC, **zero dependencies**, pure data
  access. Prove the pattern end-to-end (with a before/after test: `itx.kv.get(k)`
  identical), then `ai` / `browser` / `files` / `docs` / `email`, then the big ones
  (`integrations`, `agents`).
