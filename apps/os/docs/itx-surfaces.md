# itx surfaces: restricted scopes and served itx

> Stopgap. This exists because every itx in `apps/os` starts with the full
> built-in surface and trusted authority, so restriction can only subtract.
> When scopes start empty and capabilities are added, delete this.

A **surface** (`src/domains/itx/surface.ts`) is a host-minted allowlist of
built-in member names on an itx. Present, the itx exposes only those members
(plus `__describe`) and `ItxEntrypoint` mints it project-confined and
non-admin (`restrictedScopeAuthContext`, principal `scope:<path>`). Absent is
today's behaviour.

**Enforcement.** A restricted instance gets a prototype in front of its class
prototype that shadows every removed member, deferring it to the
dynamic-capability hop beneath the class, so a removed built-in fails exactly
like an unmounted capability (`no capability "repo.readFile"`). `instanceof`
holds. `ProjectRpcTarget` reaches its own members through private accessors
(the SURFACE RULE comment in `rpc-targets.ts`) so its logic keeps working
whatever the surface says; `__describe()` lists only the allowed members and
says `RESTRICTED scope`.

**Agents.** The capability-host birth certificate carries it:

```ts
await itx.agents.get(path).create(undefined, {
  capabilityHost: { config: { surface: ["chat"] }, fallback: null },
});
```

The host passes the surface to every script run (`ScriptExecutionEntrypoint`
→ `DynamicWorkerRunner` → binding props). The certificate lands once under a
fixed idempotency key, so the surface cannot be widened later; `fallback:
null` stops the scope inheriting the root host's mounts. Mount what the
agent may use on its own host with `provideCapability`.

**Apps.** `itx.scope({ path, surface })` returns a surfaced, project-confined
itx for a path; it never widens. `serveItx` (`iterate/sdk`) serves it over an
app's own `/api` with exactly the handshake the SDK session keeper expects,
so `useItx()`, `useStreamConnection()`, `useLiveState()` work unchanged on
the app's origin. Its `scope.surface` lists the members served as dotted
paths down to each method (`agent.liveState.get`, never `agent.liveState`);
the platform gets the roots, the relay is the member-level allowlist. A
Cap'n Web session cannot serialize a Workers-RPC stub, so the served project
is a tree of Cap'n Web targets forwarding onto the scoped stub; anything not
listed does not exist on it.

**Proof.** `surface.test.ts`, `packages/iterate/src/serve-itx.test.ts` (the
relay over an in-memory Cap'n Web session), and
`e2e/vitest/itx-garple-storefront.e2e.test.ts`: a visitor on a website chats,
through a served itx, with an agent on the real agent processor born with
`surface: ["chat"]` and one mounted catalogue tool; it sells a domain and
cannot be prompt-injected into the repo.
