# itx surfaces: restricted scopes and served itx

An itx is one class (`ProjectRpcTarget`) at one scope path, with the full
built-in surface and, behind a dynamic-worker binding, trusted-internal
authority. A **surface** is the host-minted allowlist that narrows that:
which built-in members exist on the itx, with project-confined, non-admin
authority. Two doors use it.

## The surface

`ItxSurface` (`src/domains/itx/surface.ts`) is a list of dotted member paths.
A bare root (`"chat"`) allows the whole subtree; a dotted entry
(`"agent.message"`) allows one member of a child, and the child narrows to
its listed members. Narrowing is implemented for `agent`, `chat`, `stream`,
and `liveState` (the agent-scope chain); a dotted entry under any other
member is rejected when the surface is parsed — at `scope()`, at the
binding, and in the certificate schema — because serving that child whole
would be wider than the entry states. `__describe` always stays.

- **Runtime.** A restricted instance gets a prototype in front of its class
  prototype that shadows every removed member; a shadow defers to the
  dynamic-capability hop beneath the class, so a removed built-in fails
  exactly like an unmounted capability (`no capability "repo.readFile"`).
  Classes without a hop (streams, chat) answer `"append" is not available in
this scope`. `instanceof` still holds, and each restrictable class reaches
  its own members through private accessors, so its logic keeps working
  whatever the surface says (the SURFACE RULE comment in `rpc-targets.ts`).
- **Authority.** `ItxEntrypoint.get()` mints a surfaced binding with
  `restrictedScopeAuthContext` (`auth.ts`): one project, never admin,
  principal `scope:<path>`.
- **Typecheck.** The execution gate's `Itx` becomes
  `Pick<Project, allowed roots> & { removed: ItxMemberRemovedFromThisScope } & mounts`,
  and a member access on the marker blocks the script before it runs — the
  one "property does not exist" the gate treats as proof
  (`src/domains/typecheck/virtual-project.ts`).
- **Describe.** `__describe()` lists only the allowed roots and says
  `RESTRICTED scope`.

## Door 1: an agent born with a surface

The capability-host birth certificate carries it:

```ts
await itx.agents.get(path).create(undefined, {
  capabilityHost: { config: { surface: ["chat.sendMessage", "docs"] }, fallback: null },
});
```

The host passes the surface to every script run (`ScriptExecutionEntrypoint`
→ `DynamicWorkerRunner` → binding props) and to the typecheck gate. Because
the certificate lands once under a fixed idempotency key, the surface is
decided at birth and cannot be widened. `fallback: null` also stops the
scope inheriting the project root's mounts. Mount what the agent may use on
its own host with `provideCapability`.

## Door 2: `project.scope()` and `serveItx`

`itx.scope({ path, surface })` returns a surfaced, project-confined itx for
a path — the one way to hand an itx to code that must not hold the
project's authority. It never widens.

A project worker serves it to a browser with `serveItx` from `iterate/sdk`,
which speaks exactly the handshake the SDK session keeper expects
(`authenticate` → session → `projects.get(slug)` → project), so a page on the
app's own origin needs no configuration and `useItx()`,
`useStreamConnection()`, `useLiveState()` work as on the dashboard:

```ts
if (url.pathname === "/api") {
  return await serveItx(req, {
    project: await this.env.ITX.get(),
    scope: {
      path: `/agents/web/${visitor}`,
      surface: [
        "agent.message",
        "agent.liveState.get",
        "agent.liveState.subscribe",
        "agent.stream.openConnection",
      ],
    },
    slug: "garple",
  });
}
```

A Cap'n Web session cannot serialize a Workers-RPC stub, so `serveItx`
relays: the served project is a tree of Cap'n Web targets built from the
surface's dotted members, each leaf forwarding onto the scoped stub as a
genuine member call, browser callbacks retained with `dup()` and re-wrapped
as plain functions, and returned stubs (connection handles) wrapped so their
methods stay callable. A leaf is a method call, so an object-valued member
is listed through to its methods (`agent.liveState.get`, never
`agent.liveState`). Anything not listed does not exist on the served
project at all. Bare roots cannot be served; list the members.

## Proof

- `src/domains/itx/surface.test.ts`, `src/domains/typecheck/virtual-project.test.ts`
  (restricted `Itx`), `packages/iterate/src/serve-itx.test.ts` (the relay
  over an in-memory Cap'n Web session).
- `e2e/vitest/itx-restricted-surface.e2e.test.ts`: an agent born with a
  surface, the gate, the runtime wall, `project.scope()`.
- `e2e/vitest/itx-served-surface.e2e.test.ts`: a committed project worker
  serving a scoped itx over `/api` to the stock node client — message,
  a live connection with replay and a live event, live state, close, a
  removed member.
- `e2e/vitest/itx-garple-storefront.e2e.test.ts`: the use case, end to end
  — a visitor on a website chats with an agent that runs on the REAL agent
  processor, born with `surface: ["chat.sendMessage"]` and one mounted
  catalogue tool, sells a domain, and cannot be prompt-injected into the
  repo (the gate blocks the script; a cast-around attempt dies at runtime).
