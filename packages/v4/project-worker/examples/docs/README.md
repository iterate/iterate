# Docs in userspace

This is deliberately a small document lens, not a platform-owned task system. A document is a
path plus durable Yjs updates. The stream holds the update history; the processor checkpoint holds
only one compact merged Yjs update plus `{ documents[path].text }`. The `DocsDurableObject` is an
ordinary processor facet, so its materialized state is automatically available through the existing
live-state seed/delta surface.

```ts
await itx.enableProcessor("docs", {
  source: {
    "cap.js": docsProcessor,
    "yjs.js": resolvedYjsModule,
  },
  className: "DocsDurableObject",
  consumes: ["docs/update"],
});

await itx.append({
  type: "docs/update",
  idempotencyKey: "alice:1",
  payload: { path: "/tasks.md", update: base64(Y.encodeStateAsUpdate(aliceDoc)) },
});
```

The processor has no private server protocol: two browsers append concurrent Yjs updates, then
read `itx.facets.get("docs").snapshot()` or subscribe to the normal live-state delta. Re-enabling
the processor reconstructs the same result by replaying those durable events.

Publishing is a separate immutable step: commit a pinned revision, check and build that exact
revision, then write the activation receipt and rewrite rule together.

```ts
const repo = itx.repos.get("/apps/docs");
const revision = await repo.commit({
  parent: (await repo.head())?.revision ?? null,
  message: "docs app v1",
  files: { "src/main.ts": appSource },
});
const source = {
  source: { repo: "/apps/docs", revision: revision.revision },
  options: { entryPoint: "src/main.ts" },
};
const checked = await itx.check(source);
const built = await itx.build(source);
if (checked.status !== "checked" || built.status !== "built") throw new Error("not publishable");
const target = `itx.workers.load(${JSON.stringify(built.code)}, { cacheKey: ${JSON.stringify(built.key)} })`;
const receipt = await itx.append(
  {
    type: "events.iterate.com/docs/activated",
    idempotencyKey: crypto.randomUUID(),
    payload: {
      repo: "/apps/docs",
      revision: revision.revision,
      buildKey: built.key,
      documentPath: "/tasks.md",
    },
  },
  {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    idempotencyKey: crypto.randomUUID(),
    payload: { match: "itx.docs", target },
  },
);
```

`receipt` contains the committed event offsets. It is the durable activation record; a later
`itx.docs` fetch is resolved from that rule, not from a client-held `workers.load()` handle.

Install the project ingress router the same way: append ordinary rewrite-rule facts for both the
published Docs capability and `itx.fetch` (whose target is `examples/docs/router.ts`'s compiled
`WorkerEntrypoint`). Those facts survive the installer closing its API session.

```ts
await itx.append(
  {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    idempotencyKey: crypto.randomUUID(),
    payload: { match: "itx.docs", target: docsTarget },
  },
  {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    idempotencyKey: crypto.randomUUID(),
    payload: { match: "itx.fetch", target: routerFetchTarget },
  },
);
```

`itx.provide()` is intentionally different: its rewrite is session-scoped, whether the target is a
live RPC capability or a pure expression. It is recalled when its handle or provider session ends.
Use it for session-owned capabilities, not a durable router or published Docs capability.

```ts
const response = await fetch(`/expression?context=${encodeURIComponent(projectId)}&itx=itx.docs`);
if (!response.ok) throw new Error(await response.text());
```

The dependency bytes are explicit because v4's processor loader intentionally does not install
packages on behalf of a project. The example supplies the resolved Yjs module beside the processor;
the separately published app above is a small contextual entrypoint. A repository revision currently
limits every file to 64 KiB, whereas minified Yjs is larger, so publishing the processor's dependency
requires a package/chunk layer rather than pretending a single source file fits.
