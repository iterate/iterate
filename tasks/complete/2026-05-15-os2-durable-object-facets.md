---
status: complete
priority: high
size: medium
---

# OS2 Durable Object Facets For Project Apps

Status summary: Complete. Project config Dynamic Workers can call a project-scoped `env.DURABLE_OBJECTS` binding to fetch named Durable Object facets owned by `ProjectDurableObject`; the ingress test proves a generated counter Durable Object persists across requests. Remaining follow-up is broader generated-app prompt guidance outside this code slice.

## Context

Slack thread context: generated app code tried to create a Durable Object by exporting a class such as `ChatServer`, but Dynamic Workers cannot create Durable Object namespaces from inside the dynamic worker. Cloudflare's Durable Object Facets solve this by having a deployed supervisor Durable Object load dynamic code, call `ctx.facets.get(...)`, and forward requests into the facet.

OS2 already has the right supervisor boundary: `ProjectDurableObject` owns project ingress, loads the project config worker with `env.LOADER`, and is a SQLite Durable Object. The fix should keep generated project code close to normal Cloudflare code while making the namespace/facet authority explicitly project-scoped.

## Checklist

- [x] Add a project-scoped Dynamic Worker binding for Durable Object facets. _Implemented `ProjectDynamicDurableObjectsBinding`, exposed as a loopback WorkerEntrypoint._
- [x] Let project config worker code call the binding to get a named facet for an exported Dynamic Worker DurableObject class. _Dynamic code can call `await env.DURABLE_OBJECTS.get({ className, name })` and then `facet.fetch(request)`._
- [x] Keep facet creation inside `ProjectDurableObject`, using its current project config worker checkout and `ctx.facets.get(...)`. _`ProjectDurableObject` validates the checkout, loads the current worker class, records facet metadata, and creates the facet with `ctx.facets.get(...)`._
- [x] Update OS2 worker exports/types so `ctx.exports` can create the binding in production and tests. _Exported the binding from `entry.workerd.ts` and the project-ingress test entry; refreshed Worker runtime types through the Cloudflare catalog bump._
- [x] Add a project ingress worker-pool test proving a generated DurableObject class persists state across requests. _`project-ingress.test.ts` now routes `app3.demo.iterate.localhost/api/counter` twice and sees values `1` then `2`._
- [x] Update iterate-config seed/example code or docs so agents can discover the facet API. _The base seed and local `iterate-config-repo` include an `apps/app3/worker.ts` counter example using `env.DURABLE_OBJECTS`._

## Initial Design Notes

Expose a small binding to the dynamic project config worker, tentatively:

```ts
const chat = await env.DURABLE_OBJECTS.get({
  className: "ChatServer",
  name: "main",
});
return await chat.fetch(request);
```

`getByName({ className, name })` can be an alias if it makes generated code more closely resemble a Durable Object namespace. The binding itself should be a parent-worker `WorkerEntrypoint` that calls back into the project DO. The actual facet must be created by `ProjectDurableObject` because `ctx.facets` is only available inside a Durable Object.

Cloudflare docs checked while writing the spec: Durable Object facets are created with `this.ctx.facets.get(name, callback)`, and the callback returns a class from `worker.getDurableObjectClass(className)`. Dynamic Worker `WorkerCode.env` can receive custom service bindings created from `ctx.exports`.

## Implementation Notes

- Dynamic Worker facet requests cross a WorkerEntrypoint RPC boundary before returning to the Project Durable Object, so the binding serializes request URL/method/headers/body and reconstructs a fresh `Request` inside the Project Durable Object before calling `facet.fetch(...)`.
- The project-ingress fixture now returns bundled-style Worker Loader code with `mainModule: "bundle.js"` because `@cloudflare/worker-bundler` returns a bundled JavaScript module for package-backed config workers. Feeding `.ts` module names directly to Worker Loader worked for regular entrypoints but caused internal workerd failures for facets.
- `ProjectDurableObject` aborts recorded facets when a rebuilt project config checkout changes commit, preserving facet storage while forcing the next call to reload code from the current checkout.
- Verification: `pnpm --dir apps/os2 typecheck`, `pnpm --dir apps/os2 test:project-ingress`, `pnpm --dir apps/os2 test`, `pnpm lint`, and `pnpm format:check`.
