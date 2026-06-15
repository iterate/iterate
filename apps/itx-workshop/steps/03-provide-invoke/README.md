# Step 03 — provide & invoke: capabilities go dynamic

**Adds:** a runtime registry. Stop passing objects as call arguments; add two
verbs — `provide({ name, capability })` registers a capability under a name,
`invoke({ name, args })` calls it. The set of capabilities is now grown at
runtime.

```ts
await itx.provide({ name: "double", capability: (n) => n * 2 });
await itx.invoke({ name: "double", args: [21] }); // → 42
```

The registry here is **per-connection** (one per socket) — deliberately. So a
_second_ client opening its own socket gets an empty registry and can't see what
the first provided.

**The failure it buys you out of:** "pass one object into one method" can't grow a
toolset at runtime. `provide`/`invoke` can. But the per-connection limit is the
exact thing **Step 04** fixes by moving the registry into a Durable Object.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/03-provide-invoke/intent.test.ts`.
