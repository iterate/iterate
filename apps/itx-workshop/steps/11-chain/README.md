# Step 11 — the context chain: project itx → agent itx (extend / super)

**Adds:** inheritance. A context is a project id + a path (Step 12): `prj:<id>` is
the **project** itx, `prj:<id>/agents/<name>` is an **agent** itx under it. The
agent's parent is the project. On a capability **miss**, the agent climbs to the
parent (super); the agent's own caps (and roots) **shadow** the project's; the
project is unaffected by the agent.

```ts
// project provides "db"; agent (a child) inherits it via the chain:
await agent.invoke(["db"], ["q"]); // → project's db   (climbed to super)
await agent.fetch(url); // → project's itx.fetch root (inherited)

// agent provides its own "db" — shadows the inherited one, child-local:
await agent.invoke(["db"], ["q"]); // → agent's db
await project.invoke(["db"], ["q"]); // → still the project's db
```

- `ItxDO.#parentContext()` returns the parent processor stub (an agent climbs to
  `prj:<id>`; the project root has no parent here). The processor's `invoke`
  resolves its own fold + roots first, then climbs: `parent.invoke({ path, args })`.
- Resolution order is own-fold → roots → parent, so a child shadow always wins
  and inheritance is by **late binding** (re-resolved per call), not by copy.

Production's chain bottoms out at a code-rooted platform context above the
project; here it stops at the project root. Same climb, one more rung.

**The failure it buys you out of:** every agent would have to re-provide `fetch`,
`db`, and every shared capability. The chain lets a project provide once and every
agent under it inherit — while still letting an agent override locally.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/11-chain/intent.test.ts`.
