---
state: open
priority: high
size: large
dependsOn:
  - os2-shared-stream-runtime-preview
---

# OS2 and Events streams project identity plan

## Outcome

OS2 and Events should share the stream runtime cleanly, use stable Project IDs
internally, expose a lightweight OS2 Project Stream Explorer, and preserve the
existing Clerk organization flow.

The implementation is successful only when all existing e2e and manual smoke
tests against both `apps/os2` and `apps/events` continue working.

## Decisions

- Keep Clerk's current organization selection model.
- Keep `/orgs/:organizationSlug` routes.
- Treat the URL organization slug as the requested scope and Clerk's active
  organization session claim as the expected authorization claim.
- Do not broadly rewrite Clerk auth. If touched mismatch handling must be
  explicit, use `403`.
- Use Project ID as stable identity everywhere internally.
- Keep Project Slug as the pretty browser route identity.
- Make Project Slug globally unique in OS2.
- The shared Stream Durable Object must not know about Projects. Stream identity
  is `{ namespace, path }`.
- OS2 uses stable Project ID as the stream namespace, but the shared runtime must
  also support future namespaces such as `platform`.
- OS2 stream paths must not redundantly start with `/projects/{projectId}`.
  Project scope is implied by the stream namespace / `StreamsCapability` props.
- Use a splat route for stream detail pages: `/streams/foo/bar` represents
  Event Stream Path `/foo/bar`.
- List streams from the Durable Object catalog, not inferred stream child state.
- Mount public Durable Object fetch routing at the start of the main OS2 Worker
  fetch handler.

## Implementation Scope

### Project identity and sqlfu

- Replace OS2's project uniqueness rule from `(clerk_org_id, slug)` to global
  `slug` if any old schema/query state remains.
- Add or keep the sqlfu migration for the D1 schema change.
- Update `apps/os2/src/db/definitions.sql`.
- Update OS2 project queries and generated sqlfu assets.
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
- Test that the same runtime works with OS2 Project ID namespaces, Events POC
  namespaces, and a non-project namespace such as `platform`.
- Ensure OS2 and Events import stream schemas/types directly from shared.
- Remove Events contract stream re-export indirection where it remains.
- Ensure Stream Durable Object uses the durable-object-utils mixins we want:
  durable object core, lifecycle hooks, D1 object catalog, KV inspector,
  Outerbase, and public fetch route.
- Do not add `withAppConfig`, `withStreamProcessorRunner`,
  `withMultiplexAlarms`, or `withScheduler`.

### Public Durable Object fetch routes

- Mount `routeDurableObjectRequest(...)` at the very start of
  `apps/os2/src/entry.workerd.ts` fetch handling.
- Register `StreamDurableObject` with `env.STREAM`.
- Keep the Events app public stream Durable Object route behavior.
- Public routes should support default init-param addressing and debug surfaces
  such as KV inspector and Outerbase.

### Events deployment config

- Keep Events able to deploy its own Stream Durable Object by default.
- If `deploymentConfig.streamDurableObjectBindingScriptName` is present, bind
  Events' `STREAM` namespace cross-script to that script's Stream Durable
  Object.
- OS2 should export and deploy its own Stream Durable Object from the main
  Worker script.

### OS2 Streams API and UI

- Add or keep a minimal OS2 streams oRPC surface using shared stream schemas.
- Bind OS2 `StreamsCapability` to a stream namespace equal to the stable
  Project ID.
- Normalize OS2 codemode and UI stream paths so they are project-local paths,
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
- OS2 codemode processors must subscribe through callable Durable Object targets,
  not websocket URLs.
- The codemode session processor exposes `afterAppend()` and receives append
  notifications through env-bound Durable Object namespace calls.

### Documentation

- Update `apps/os2/CONTEXT.md` for stable Project ID, globally unique Project
  Slug, Clerk active organization semantics, stream namespace, StreamsCapability,
  and Project Stream Explorer terminology.
- Update OS2/Events docs for stream deployment config and public Durable Object
  debug routes.

## Success Conditions

- Existing `apps/os2` e2e tests still pass.
- Existing `apps/events` e2e tests still pass.
- Existing manual smoke tests for `apps/os2` still work.
- Existing manual smoke tests for `apps/events` still work.
- OS2 local dev can append/read stream events through its own Stream Durable
  Object namespace.
- OS2 Project Stream Explorer lists initialized streams from the catalog.
- OS2 stream detail splat routes open the expected Event Stream Path.
- Shared stream catalog listing proves namespace isolation: two namespaces can
  contain the same Event Stream Path without colliding.
- OS2 Code Mode stream paths are project-local and do not begin with
  `/projects/{projectId}`.
- Public Stream Durable Object routes work through OS2 and Events worker fetch.
- Events can run with its own Stream Durable Object.
- Events can run with `streamDurableObjectBindingScriptName` pointing at OS2.
- Code Mode processing uses callable Durable Object subscription delivery.
- Deployed preview verification passes against the real preview URLs, including
  API smoke coverage and browser checks through Agent Browser. Authenticated
  browser checks should use Clerk testing-token support where Clerk requires it.

## Verification Commands

Run the focused checks while implementing, then the broader checks before
handoff:

```sh
pnpm --dir apps/os2 sqlfu:generate
pnpm --dir apps/os2 sqlfu:check
pnpm --filter @iterate-com/shared typecheck
pnpm --filter @iterate-com/os2 typecheck
pnpm --filter @iterate-com/events typecheck
pnpm --filter @iterate-com/os2-contract typecheck
pnpm --filter @iterate-com/events-contract typecheck
pnpm --filter @iterate-com/events test
pnpm --dir apps/os2 test:e2e:preview
pnpm --dir apps/events test:e2e:preview
```

Manual smoke coverage must include both local development and preview
deployment paths for OS2 and Events.
