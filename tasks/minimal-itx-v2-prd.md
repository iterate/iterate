---
state: todo
priority: high
size: large
tags: [itx, reference-implementation, prd, architecture]
---

# Minimal ITX v2 reference implementation PRD

## Problem Statement

The current minimal ITX reference implementation proves many important ideas, but
it is no longer minimal. The user-facing ITX surface, host domain-object
surfaces, built-in capabilities, dynamic capability fallback, script execution,
and path-proxy adapters are too entangled. This makes the reference harder to use
as a design artifact for the production platform.

The specific pain is that common built-ins such as streams, agents, and repos
route through the stateful ITX context Durable Object before reaching the actual
domain object. That makes the context core look more central than it should be.
The core should be the durable capability fold and script-execution journal, not
the router for every built-in capability tree branch.

The user wants a new, even more minimal reference app in a separate folder that
shows the desired shape cleanly without preserving every behaviour of the
existing reference implementation.

## Solution

Create a new reference app that models ITX as two sharply separated layers:

- A stateless Cap'n Web RPC target tree that exposes built-ins and user-facing
  controls.
- A tiny stateful ITX processor that only owns dynamic provided capabilities and
  script-execution events.

The stateless tree should expose project and agent ITX handles as hand-written
RpcTargets. Project ITX has project-scoped built-ins. Agent ITX inherits the same
project-scoped built-ins and adds an agent surface. Unknown names fall through to
the host context's ITX processor using Cap'n Web's `fallbackCall` support from
the local iterate/capnweb fork.

The implementation should live in a new app folder, not by mutating the existing
minimal reference implementation. The existing test machinery can be reused or
adapted, but the public API is allowed to become smaller and cleaner.

## User Stories

1. As an ITX designer, I want a smaller reference app, so that the architecture is easier to reason about.
2. As an ITX designer, I want built-ins to live in a stateless RPC target tree, so that the stateful context core is not on every built-in call path.
3. As an ITX designer, I want dynamic capabilities to fall through from an RpcTarget, so that I do not need a dummy function proxy as the main ITX surface.
4. As an ITX designer, I want to use Cap'n Web `fallbackCall`, so that real methods and getters can coexist with runtime-defined capability names.
5. As an ITX designer, I want project ITX and agent ITX to be distinct classes, so that project ITX has no special knowledge of agent-only members.
6. As an ITX designer, I want agent ITX to inherit project ITX built-ins, so that the agent handle remains small and unsurprising.
7. As an ITX caller, I want `itx.streams.get(path)` to route directly to the stream domain surface, so that stream calls avoid an unnecessary context resolver hop.
8. As an ITX caller, I want `itx.agents.get(path)` to return an agent ITX handle, so that switching to an agent context is explicit and chainable.
9. As an ITX caller, I want `itx.repos.get(path)` to return a repo domain surface, so that repo calls are scoped by normal domain paths.
10. As an ITX caller, I want `itx.repo` to be shorthand for the project repo, so that the common repo case remains concise.
11. As an ITX caller, I want `itx.project` to expose the project Durable Object's public RPC target, so that project domain methods do not need to be rewrapped on ITX.
12. As an ITX caller in an agent context, I want `itx.agent` to expose the current agent Durable Object's public RPC target, so that agent domain methods are available without duplicating wrappers.
13. As an ITX caller in a project context, I want `itx.agent` to behave like an ordinary dynamic capability miss, so that project ITX has no bespoke agent-only branch.
14. As an ITX provider, I want `provideCapability` to append a capability-provided event, so that the stream remains the source of truth.
15. As an ITX provider, I want `provideCapability` to return an explicit revocation object, so that I can revoke the capability without retyping its path.
16. As an ITX provider, I want `revokeCapability` to remain public, so that durable capabilities can be cleaned up later even if the provision object is gone.
17. As an ITX provider, I do not want `Symbol.dispose` semantics yet, so that capability lifetime stays explicit in the reference.
18. As an ITX provider, I do not want live capability disconnect auto-revoke yet, so that the first implementation keeps live lifetime handling simple.
19. As an ITX caller, I want no `.describe()` public API in the new reference, so that the reference does not carry introspection machinery before it is needed.
20. As an ITX implementer, I want the ITX processor to be tiny, so that its responsibilities are obvious and testable.
21. As an ITX implementer, I want domain objects to define their own RPC target wrappers, so that the ITX tree does not duplicate domain methods.
22. As an ITX implementer, I want domain object RPC wrappers to use the simple generated wrapper helper, so that the reference favours trust and clarity over allowlist ceremony.
23. As an ITX implementer, I want each domain object to expose `getRpcTarget`, so that remote code can obtain the domain object's intended public RPC surface.
24. As an ITX implementer, I want `getRpcTarget` itself to be remotely callable, so that the stateless ITX tree can obtain a wrapper from a Durable Object stub.
25. As an ITX implementer, I accept that generated wrappers may expose `getRpcTarget`, so that the wrapper declaration remains a simple one-liner.
26. As an ITX implementer, I want collection targets to trust caller paths, so that the reference does not hide path normalization rules.
27. As an ITX implementer, I want `ItxEntrypoint` props to be `{ projectId, path }`, so that loaded dynamic workers restore an ITX handle from the same domain coordinate vocabulary used elsewhere.
28. As an ITX implementer, I want `ItxEntrypoint.get()` to choose project versus agent ITX with a simple path check, so that the restorer is explicit and small.
29. As a dynamic worker author, I want `env.ITX.get()`, so that loaded code receives the same handle shape as an external ITX client.
30. As a script runner, I want `runScript` to live only in the ITX processor, so that script execution is implemented once.
31. As a script runner, I want `runScript` to append a script-execution-requested event and wait for completion, so that script execution remains stream-driven.
32. As a script runner, I want script workers to receive an ITX binding for the same host context, so that scripts run with the same project or agent authority as the caller.
33. As a maintainer, I want the new reference to use the local iterate/capnweb fork before upstream merge, so that the reference can use `fallbackCall` immediately.
34. As a maintainer, I want the existing reference app left alone, so that the new design can be compared against the previous implementation.
35. As a maintainer, I want reused test machinery where practical, so that the new app does not spend most of its code on harness setup.

## Implementation Decisions

- Build a new reference app in a new folder rather than refactoring the current reference app in place.
- Use the local iterate/capnweb fork or a local package override that includes `fallbackCall` support before the upstream PR is merged.
- Keep production OS ITX out of scope for this implementation.
- Keep the public `/api/itx/<projectId>` connection shape if useful for reusing the current test harness.
- Ignore the admin/root ITX surface unless needed for test bootstrapping.
- Drop public `.describe()` from the new reference app entirely.
- Do not implement public capability listing or introspection in v2.
- Keep `revokeCapability` as a public API for durable/sturdy capability cleanup.
- Make `provideCapability` return a provision object with an explicit `revoke` method.
- Do not add `Symbol.dispose` to the returned provision object in this pass.
- Do not auto-revoke live capabilities on `onRpcBroken` in this pass.
- Remove host-injected built-ins from the ITX processor.
- Keep the ITX processor focused on appending provide/revoke events, reducing capability state, invoking provided capabilities, appending script execution requests, and processing script execution requests.
- Keep the core dispatch method named `invokeCapability` for now.
- Remove old defensive control-name dispatch from `invokeCapability`; control verbs belong on the hand-written ITX RpcTarget.
- Let the hand-written ITX RpcTarget reject `provideCapability` when the first path segment is already a public member on the current ITX target.
- Do not maintain a static built-in roots list for this collision check.
- Use a hand-written `ProjectItxRpcTarget` as the user-facing project ITX tree.
- Use an `AgentItxRpcTarget` that inherits from `ProjectItxRpcTarget` and adds the current agent domain surface.
- Use getters for built-in tree branches.
- Keep project ITX unaware of `agent`; a project call to `itx.agent...` should fall through like any other missing dynamic capability.
- Expose `itx.project` as the current project's domain RPC target.
- Expose `itx.agent` only on agent ITX as the current agent's domain RPC target.
- Expose `itx.streams` as a collection target whose `get` returns the stream domain RPC target for the caller-supplied path.
- Expose `itx.agents` as a collection target whose `get` returns an agent ITX handle for the caller-supplied path.
- Expose `itx.repos` as a collection target whose `get` returns a repo domain RPC target for the caller-supplied path.
- Expose `itx.repo` as shorthand for the project repo path.
- Collection targets should trust caller paths exactly; no leading-slash normalization or prefix validation.
- Use the existing generated RPC target helper pattern for domain objects.
- Define simple trusting RPC target wrappers for project, agent, repo, and stream domain objects.
- Add `getRpcTarget` to each domain Durable Object that should expose a domain surface through ITX.
- Let generated wrappers include all prototype methods in the reference implementation, even if that includes `getRpcTarget`.
- Keep `ItxRpcTarget` hand-written because it owns routing, built-ins, collision checks, and dynamic fallback.
- Make `ItxEntrypoint` accept `{ projectId, path }` props and expose `get()`.
- Let `ItxEntrypoint.get()` instantiate `ProjectItxRpcTarget` when the path is the project root and `AgentItxRpcTarget` when the path is an agent path.
- Dynamic workers should receive an `ITX` binding constructed from the same `{ projectId, path }` context as the host creating them.
- `runScript` should go all the way into the host Durable Object's ITX processor, append a script-execution-requested event, and rely on the processor side effect to run the script.
- Script worker execution should restore the same ITX context through `env.ITX.get()`.

## Testing Decisions

- Focus tests on external behavior, not internal routing details.
- Reuse the current reference app's e2e environment pattern where it saves setup effort.
- Keep tests that prove live capability provision and invocation, but update them to use the new provision return object instead of `.describe()`.
- Keep tests that prove explicit revocation removes a capability.
- Keep tests that prove durable/sturdy capability refs can be provided and later invoked.
- Keep tests that prove dynamic worker capabilities run and can call back into `env.ITX.get()`.
- Keep tests that prove script execution is event-driven by externally observing `runScript` results and follow-up capability effects.
- Keep tests that prove `itx.agents.get(path)` returns an agent ITX handle.
- Keep tests that prove agent scripts run in the agent context.
- Keep tests that prove `itx.project` exposes project domain methods.
- Keep tests that prove `itx.agent` exists only on agent ITX by expecting normal dynamic-capability miss behavior from project ITX.
- Keep tests that prove `itx.streams.get(path)` can append and read stream events through the stream domain surface.
- Keep tests that prove `itx.repos.get(path)` and `itx.repo` reach the repo domain surface.
- Add tests for built-in collision rejection during `provideCapability`.
- Add tests for direct chained calls that rely on Cap'n Web promise pipelining, such as obtaining an agent ITX handle and immediately calling a method on it.
- Do not write tests for `.describe()` because it is intentionally absent.
- Do not write tests for `Symbol.dispose` or live disconnect auto-revoke because those behaviours are explicitly deferred.
- Run typechecking for the new app.
- Run the new app's e2e suite against a local Wrangler worker, following the current reference implementation's test machinery where practical.

## Out of Scope

- Changing production OS ITX.
- Migrating the existing minimal reference implementation in place.
- Preserving the current reference implementation's public API.
- Reintroducing `.describe()` or any capability listing API.
- Implementing `Symbol.dispose` on provision objects.
- Auto-revoking live capabilities when provider RPC sessions break.
- Designing a full admin/root ITX surface.
- Adding authorization policy beyond the minimal project connection machinery needed for the reference app.
- Adding path normalization or short-name sugar for agents, repos, or streams.
- Hardening generated domain RPC wrappers with explicit allowlists.
- Renaming `invokeCapability` to a smaller protocol name.
- Solving production egress/fetch shadowing semantics.

## Further Notes

The capnweb PR that adds `fallbackCall` is load-bearing for this design. Without
it, the reference would have to keep using a proxy function as the top-level ITX
surface. The new app should therefore either consume a local checkout of the fork
or use a package override/tarball that contains the fallback-call branch.

The goal is not to make a new production-ready ITX framework. The goal is to
write the smallest reference that demonstrates the intended boundaries:
stateless built-in tree first, stateful dynamic context fallback second, and a
tiny stream-backed ITX processor underneath.
