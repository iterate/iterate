# Step 11 — the context chain: project itx → agent itx (a parent for resolution)

**Adds:** inheritance. A context is a project id + a path: `prj:<id>` is
the **project** itx, `prj:<id>/agents/<name>` is an **agent** itx under it. The
agent's parent is the project. On a capability **miss**, resolution falls through
to the parent; the agent's own caps (and built-in capabilities) **shadow** the
project's; the project is unaffected by the agent.

```ts
// project provides "db"; agent (a child) inherits it via the chain:
await agent.invokeCapability(["db"], ["q"]); // → project's db   (resolved against the parent)
await agent.fetch(url); // → project's itx.fetch built-in (inherited)

// agent provides its own "db" — shadows the inherited one, child-local:
await agent.invokeCapability(["db"], ["q"]); // → agent's db
await project.invokeCapability(["db"], ["q"]); // → still the project's db
```

- A context's PARENT is recorded as DATA — a `{ ref, address }` link in the
  birth certificate (`ItxDO.#parentRef()`): an agent parents to `prj:<id>` (a
  DO-backed context, `{ type: "context" }`), the project root parents to the
  global root (a code address, `{ type: "code" }`). On a miss the core dials that
  address via the injected `dial` (the same one capabilities use) and resolves
  against it: `parent.invokeCapability({ path, args })`.
- Resolution order is own-fold → built-in capabilities → parent, so a child shadow always wins
  and inheritance is by **late binding** (re-resolved per call), not by copy.

The chain bottoms out at a code-rooted platform context above the project — the
global root (`13-platform-root`). Same climb, one more rung.

**The failure it buys you out of:** every agent would have to re-provide `fetch`,
`db`, and every shared capability. The chain lets a project provide once and every
agent under it inherit — while still letting an agent override locally.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/11-chain/intent.test.ts`.
