# R0 — What IS the runner? (+ the capability mounting/shadowing model)

**The new root. Status: grounding (2 code-mappers running).**

Q04 (dial direction) and Q03 (capability sourcing / RPC-target split) both bottom out here. Jonas:
_"I don't know what the runner is so it's hard to say… we need to talk about that more."_ Facts are
mine to find first — this ticket is blocked on mapping the **current** `apps/os` capability anatomy +
the **current** `apps/kernel` lab, then proposing a crisp definition to react to.

## The question, precisely

What is a **project runner**, concretely?

1. **Its boundary** — is a runner _one worker per project_ (holds that project's DOs + bindings +
   capability tree), or _one worker serving many projects_ that mints a **sealed per-project tree** via
   `ctx.exports({projectId})` loopback props (codex's gateway reading)? These have very different
   deploy/isolation/account-per-project stories.
2. **What it physically owns** — which Durable Objects (repo, stream, secret) and which platform ENV
   bindings (AI, artifacts) live _inside_ the runner vs. are _sourced_ from elsewhere.
3. **How its capability tree is assembled** — Jonas's hypothesis: **props on the project entrypoint**
   determine which capabilities are mounted, how — tied to the existing **capability host / dynamic
   capability model** (`resolveLongestPrefix`, `provideCapability`, mounts). The load-bearing sub-question:
   **what can shadow what?** Can a mounted/sourced capability shadow a builtin, and by what precedence?

## Why it's the fulcrum

- "Per-capability sourcing" (Q03) is meaningless until we know whether a capability is a branch of an
  in-worker tree or a mount resolved by the capability host — and whether sourcing = swapping a mount.
- "Dial direction" (Q04) is unanswerable until we know if a runner is a public HTTP endpoint (one dial
  target) or a confined loopback inside a multi-project worker.
- Account-per-project (Q06) is trivial under reading (1), a big change under reading (2).

## What Jonas has already said (constraints on the answer)

- Cross-account is **always HTTP** — one HTTP endpoint you can dial. _(supersedes "always dial-out
  uniformly"; it's HTTP either way.)_
- **Either side should probably be able to dial either side** — but Jonas may relax this. _(tentative)_
- The lab must show an example repo DO + stream DO + AI binding + artifacts binding, where topology can
  **split which binding is used** — so the runner's relationship to its bindings is the concrete anchor.

## Grounded findings (2026-07-30, both mappers reported)

**Neither codebase has a single "runner worker."** The role is a per-project _scope_, hosted differently:

- **clean room:** runner = `ProjectEntrypoint` minted per-project via `ctx.exports({projectId})` loopback
  props — one worker, many projects, sealed tree; the confined config worker sees one binding, `ITX`
  (kernel.ts:319-379).
- **apps/os:** the role is split across **`ProjectDurableObject`** (physical state; identity = its DO
  name `{projectId}.iterate{path}`; no props) + **`ItxEntrypoint`** (`WorkerEntrypoint<Env,
ItxEntrypointProps>` = what userspace sees as `env.ITX`; props `{streamContext, path, purpose,
projectId}` **gate scope** — _"callers do not choose their own scope, the hosting object mints it"_,
  `itx/utils.ts:85`). The ITX tree itself (`ProjectRpcTarget`, ~25 capability getters) is built
  in-isolate by **`itxForScope()`** (`rpc-targets.ts:5989`) — confirmed the waist, the only constructor,
  5 call sites.

**→ Jonas's hypothesis is already how os works:** props on the entrypoint (`ItxEntrypointProps`) already
determine scope/mounting via `scopeFromItxEntrypointProps`. Good news — not a new invention.

## The refined tension (this is what to decide)

Not "one worker per project vs many." Both are already "many projects, per-project scope." The real fork
is the **deployable boundary** when we split for cross-account / account-per-project:

- **(A) Runner = a logical per-project _scope_** hosted inside a shared multi-project worker (today's
  reality: DO-per-project + `ctx.exports` loopback). Account-per-project = run the shared worker in each
  account. `dialProject(projectId)` abstracts scope-here (loopback/binding) vs scope-elsewhere (HTTP).
- **(B) Runner = a genuinely separate deployable** (its own worker, potentially one-per-account).

Recommendation leaning **(A)**: the runner is a _scope that can be hosted in different physical
containers_, and **the dial** is the abstraction. But confirm with Jonas — it's the fulcrum for Q06.

## Sourcing vs mounting (settles half of Q03) — see Q03

Mounting (capability host) = add unknown-name userspace caps; **never shadows a builtin**. Sourcing =
swap the impl behind a builtin getter via an `aiFor(cfg,env)` factory. Two orthogonal seams.

## Storage-shaped vs service-shaped, checked against the real DO list

Storage (follow the runner — they ARE its data): `REPO`, `STREAM`, `SECRET`, `FILES`, `PROJECT`,
`CAPABILITY_HOST` DOs. Service (sourceable): `ai` (flat global binding, no project scope — the cleanest
first proof), egress, browser, ai-search. Artifacts/repos = storage (git over Cloudflare Artifacts,
`repo-durable-object.ts:1824`). The dichotomy holds.
