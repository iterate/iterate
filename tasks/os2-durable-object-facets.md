---
status: ready
priority: high
size: medium
---

# OS2 Durable Object Facets For Project Apps

Status summary: Specified but not implemented. The target is a small vertical slice that lets project config Dynamic Workers route requests into Durable Object facets owned by the Project Durable Object. Missing pieces are the binding surface, Project DO facet loader, test coverage, and prompt/example guidance.

## Context

Slack thread context: generated app code tried to create a Durable Object by exporting a class such as `ChatServer`, but Dynamic Workers cannot create Durable Object namespaces from inside the dynamic worker. Cloudflare's Durable Object Facets solve this by having a deployed supervisor Durable Object load dynamic code, call `ctx.facets.get(...)`, and forward requests into the facet.

OS2 already has the right supervisor boundary: `ProjectDurableObject` owns project ingress, loads the project config worker with `env.LOADER`, and is a SQLite Durable Object. The fix should keep generated project code close to normal Cloudflare code while making the namespace/facet authority explicitly project-scoped.

## Checklist

- [ ] Add a project-scoped Dynamic Worker binding for Durable Object facets.
- [ ] Let project config worker code call the binding to get a named facet for an exported Dynamic Worker DurableObject class.
- [ ] Keep facet creation inside `ProjectDurableObject`, using its current project config worker checkout and `ctx.facets.get(...)`.
- [ ] Update OS2 worker exports/types so `ctx.exports` can create the binding in production and tests.
- [ ] Add a project ingress worker-pool test proving a generated DurableObject class persists state across requests.
- [ ] Update iterate-config seed/example code or docs so agents can discover the facet API.

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
