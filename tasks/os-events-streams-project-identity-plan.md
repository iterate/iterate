---
state: open
priority: high
size: large
dependsOn: []
---

# OS and Events streams project identity plan

## Outcome

OS and Events should share the stream runtime cleanly, use stable Project IDs
internally, expose a lightweight OS Project Stream Explorer, and preserve the
existing Clerk organization flow.

The implementation is successful only when all existing e2e and manual smoke
tests against both `apps/os` and `apps/events` continue working.

## Decisions

- Keep Clerk's current organization selection model.
- Keep `/orgs/:organizationSlug` routes.
- Treat the URL organization slug as the requested scope and Clerk's active
  organization session claim as the expected authorization claim.
- Do not broadly rewrite Clerk auth. If touched mismatch handling must be
  explicit, use `403`.
- Use Project ID as stable identity everywhere internally.
- Keep Project Slug as the pretty browser route identity.
- Make Project Slug globally unique in OS.
- The shared Stream Durable Object must not know about Projects. Stream identity
  is `{ namespace, path }`.
- OS uses stable Project ID as the stream namespace, but the shared runtime must
  also support future namespaces such as `platform`.
- OS stream paths must not redundantly start with `/projects/{projectId}`.
  Project scope is implied by the stream namespace / `StreamsCapability` props.
- Use a splat route for stream detail pages: `/streams/foo/bar` represents
  Event Stream Path `/foo/bar`.
- List streams from the Durable Object catalog, not inferred stream child state.
- Mount public Durable Object fetch routing at the start of the main OS Worker
  fetch handler.

## Implementation Scope

### Project identity and sqlfu

- Replace OS's project uniqueness rule from `(clerk_org_id, slug)` to global
  `slug` if any old schema/query state remains.
- Add or keep the sqlfu migration for the D1 schema change.
- Update `apps/os/src/db/definitions.sql`.
- Update OS project queries and generated sqlfu assets.
- Browser routes may continue to use project slugs, but route loaders should
  resolve to `project.id` and child code should prefer that stable Project ID.

### Clerk/auth scope

- Preserve the current Clerk active organization integration:
  `organizationSyncOptions`, Clerk org selection UI, and active org claims.
- Avoid a standalone auth refactor.
- Only clarify or preserve route/org checks when they are already in the path of
  the stream/project refactor.

### Shared stream runtime

- Keep the shared stream runtime in `packages/shared/src/streams`.
- Refactor `StreamDurableObject` structured name, helper APIs, catalog indexes, and
  public structured-name addressing from `projectId` to `namespace`.
- Keep `path` as the Event Stream Path within that namespace.
- Test that the same runtime works with OS Project ID namespaces, Events POC
  namespaces, and a non-project namespace such as `platform`.
- Ensure OS and Events import stream schemas/types directly from shared.
- Remove Events contract stream re-export indirection where it remains.
- Ensure Stream Durable Object uses the durable-object-utils mixins we want:
  durable object core, lifecycle hooks, D1 object catalog, KV inspector,
  Outerbase, and public fetch route.
- Do not add `withAppConfig`, `withStreamProcessorRunner`,
  `withMultiplexAlarms`, or `withScheduler`.

### Public Durable Object fetch routes

- Mount `routeDurableObjectRequest(...)` at the very start of
  `apps/os/src/entry.workerd.ts` fetch handling.
- Register `StreamDurableObject` with `env.STREAM`.
- Keep the Events app public stream Durable Object route behavior.
- Public routes should support default init-param addressing and debug surfaces
  such as KV inspector and Outerbase.

### Events deployment config

- Keep Events able to deploy its own Stream Durable Object by default.
- If `deploymentConfig.streamDurableObjectBindingScriptName` is present, bind
  Events' `STREAM` namespace cross-script to that script's Stream Durable
  Object.
- OS should export and deploy its own Stream Durable Object from the main
  Worker script.

### OS Streams API and UI

- Add or keep a minimal OS streams oRPC surface using shared stream schemas.
- Bind OS `StreamsCapability` to a stream namespace equal to the stable
  Project ID.
- Normalize OS codemode and UI stream paths so they are project-local paths,
  not `/projects/{projectId}/...` paths.
- Add Project Stream Explorer pages:
  - `/orgs/:organizationSlug/projects/:projectSlug/streams`
  - `/orgs/:organizationSlug/projects/:projectSlug/streams/$`
- The streams page lists all initialized streams for the current Project from
  the Durable Object catalog by namespace.
- The detail page is deep-linkable and can implicitly initialize stream state.
- Breadcrumbs allow navigating to child stream paths.
- Use the shared stream path label component from `packages/ui`.

### Processor subscriptions

- Keep webhook and websocket subscriptions supported by the Stream Durable
  Object.
- OS codemode processors must subscribe through callable Durable Object targets,
  not websocket URLs.
- The codemode session processor exposes `afterAppend()` and receives append
  notifications through env-bound Durable Object namespace calls.

### Documentation

- Update `apps/os/CONTEXT.md` for stable Project ID, globally unique Project
  Slug, Clerk active organization semantics, stream namespace, StreamsCapability,
  and Project Stream Explorer terminology.
- Update OS/Events docs for stream deployment config and public Durable Object
  debug routes.

## Success Conditions

- Existing `apps/os` e2e tests still pass.
- Existing `apps/events` e2e tests still pass.
- Existing manual smoke tests for `apps/os` still work.
- Existing manual smoke tests for `apps/events` still work.
- OS local dev can append/read stream events through its own Stream Durable
  Object namespace.
- OS Project Stream Explorer lists initialized streams from the catalog.
- OS stream detail splat routes open the expected Event Stream Path.
- Shared stream catalog listing proves namespace isolation: two namespaces can
  contain the same Event Stream Path without colliding.
- OS Code Mode stream paths are project-local and do not begin with
  `/projects/{projectId}`.
- Public Stream Durable Object routes work through OS and Events worker fetch.
- Events can run with its own Stream Durable Object.
- Events can run with `streamDurableObjectBindingScriptName` pointing at OS.
- Code Mode processing uses callable Durable Object subscription delivery.
- Deployed preview verification passes against the real preview URLs, including
  API smoke coverage and browser checks through Agent Browser. Authenticated
  browser checks should use Clerk testing-token support where Clerk requires it.

## Verification Commands

Run the focused checks while implementing, then the broader checks before
handoff:

```sh
pnpm --dir apps/os sqlfu:generate
pnpm --dir apps/os sqlfu:check
pnpm --filter @iterate-com/shared typecheck
pnpm --filter @iterate-com/os typecheck
pnpm --filter @iterate-com/events typecheck
pnpm --filter @iterate-com/os-contract typecheck
pnpm --filter @iterate-com/events-contract typecheck
pnpm --filter @iterate-com/events test
pnpm --dir apps/os test:e2e:preview
pnpm --dir apps/events test:e2e:preview
```

Manual smoke coverage must include both local development and preview
deployment paths for OS and Events.
