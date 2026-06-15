# Step 09 — dial: code-loading via the Worker Loader

**Adds:** the second kind of capability becomes real. A **sturdy** capability is
plain serializable data — a ref naming a worker to build and run, plus the
`props` that specialize it. `dial` turns that ref back into something callable by
**loading the worker** (Cloudflare's Worker Loader) and handing back its
entrypoint. The entrypoint's methods run in the freshly-built isolate.

```ts
itx.provideCapability(["calc"], {
  type: "rpc",
  worker: { type: "source", source: "/* a WorkerEntrypoint module */" },
  entrypoint: "Calc",
  props: { base: 100 },
});
await itx.invoke(["calc", "add"], [2, 3]); // → 105, computed inside the loaded isolate
```

- `ItxDO.#dial` (in `../../server.ts`) calls `env.LOADER.get(id, () => ({ mainModule,
modules }))` and `getEntrypoint(name, { props })`. The isolate is **content-addressed**
  (same source → same isolate, no rebuild). The ref's `props` arrive as `this.ctx.props`.
- The capability is stored in the fold as an `address` (Step 06/08's `kind: "rpc"`),
  not a live stub — it survives eviction because it's just data; dial rebuilds the
  worker on demand. This is how "the Petstore API" or any first-party worker becomes
  one capability.

This workshop handles the `source` worker kind (inline code). Production also
dials `binding`, `loopback`, and `durable-object` refs, and resolves repo sources
through a per-commit build memo — same `dial` seam, more ref kinds.

**The failure it buys you out of:** live stubs die with their provider. A sturdy
ref is durable data; dial reconstructs the running code whenever it's invoked.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/09-dial/intent.test.ts`.
