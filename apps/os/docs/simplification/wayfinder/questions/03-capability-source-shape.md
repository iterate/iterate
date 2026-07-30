# Q03 — What _is_ a capability source? Shape + granularity.

**Reframed after code-grounding (2026-07-30). Status: open, blocked on R0.**

## ⚠️ Key grounding finding: sourcing ≠ mounting (they are orthogonal seams)

The apps/os map settles what "can shadow what":

- **Mounting** (the capability host — `provideCapability`/`invokeCapability`,
  `resolveLongestPrefix`, `capability-host-durable-object.ts`) adds **new userspace capabilities at
  undeclared names only**. It **can never shadow a builtin** — enforced at _provide_ time by
  `rejectBuiltinCollision(ITX_SURFACE_MEMBER_NAMES, path)` (`utils.ts:183`) and by
  `installPrototypeInvokeCapabilityFallback`, which inserts a proxied hop _below_ the declared members
  on the prototype chain so builtins win by JS lookup order. Quote: _"a dynamic capability can never
  shadow a built-in name — the built-in always wins."_
- **Sourcing** (the NEW thing R5/M3 wants) swaps the **implementation behind a builtin getter** —
  e.g. `ProjectRpcTarget.ai` returning a local `env.AI` wrapper vs a remote proxy. Today `ai` is a flat
  global binding read at one site (`AiRpcTarget`, `rpc-targets.ts:2655`) with **zero project-scoping**;
  the sourcing seam is a factory `aiFor(cfg, env)` mirroring the existing `directoryFor(cfg, env)`
  (`directory.ts:78`). Orthogonal to the mount table.

**Consequence:** Jonas tied sourcing to "the capability host / dynamic capability model," but the
capability host is _fallback-for-unknown-names_, not a shadowing engine. If we want sourcing to vary a
builtin, that's the **getter-factory** seam, not the mount table. **Open decision:** do the two seams
stay separate (recommended — clean), or do we extend the capability host to allow _sourced_ builtins to
be swapped (would require relaxing `rejectBuiltinCollision`)?

## Original framing (still relevant)

## The question

The M3 structural unlock is "each ITX capability is independently sourced." Three shapes are on the
table — which do we adopt?

## Options

- **(A) Minimal union (opus).** A capability getter _returns a source_:
  `CapabilitySource = {kind:"local", stub:RpcTarget} | {kind:"remote", stub:RpcStub}`. Indistinguishable
  to callers because capnweb's `RpcTarget` **is** `cloudflare:workers`'. No manifest, no consent. Config
  builds the source table via one `sourcesFor(config, env, projectId)`.
- **(B) Versioned manifest + bilateral consent (codex).** A 4-field descriptor
  (`source`, `provider`, `contract:"streams@1"`, `config`), a versioned `ProjectManifest`, atomic
  generation flips, _and_ — in BYO — the customer runner must **authorize** source changes the hosted CP
  proposes. Contract-version negotiation, fail-closed activation.
- **(C) Storage-shaped vs service-shaped dichotomy (fable-migration).** Storage capabilities (streams,
  repos, R2) are **never sourced** — they follow runner placement (data gravity). Only ~6 **service**
  capabilities (`ai`, egress, ai-search, …) are sourceable, via a per-project source table.

## Recommendation: **(C) as the mental model + (A) as the mechanism; defer (B).**

Storage follows the runner (you don't "source" your own database — it's wherever your runner is); only
service-shaped capabilities get the `{kind, stub}` knob. codex's manifest/consent machinery is real but
**premature** — it answers a governance question we haven't hit. Adopt it later if BYO consent becomes
concrete.

## Taxonomy note

"Capability source" is the one coinage all authors share — bless it. Reject codex's `ProjectManifest`,
`binder`, `CapabilityPlan` for now (see Q05).
