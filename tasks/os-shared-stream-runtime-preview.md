---
state: done
priority: high
size: large
dependsOn: []
---

# OS shared stream runtime preview

Move stream ownership out of the Events app, make OS self-contained for
streams, and prove Code Mode works in a full OS preview deployment.

## Outcome

Deploy a preview OS worker where Code Mode works end-to-end using a local
`StreamDurableObject` namespace exported by the OS main Worker script. Prove it
with concrete local and preview checks.

## Goals

1. Export all OS Durable Objects from the same main Worker script.
   - `apps/os/src/entry.workerd.ts` exports every OS Durable Object class.
   - `apps/os/alchemy.run.ts` does not create separate Worker scripts for OS
     Durable Objects.
   - OS Durable Object namespaces are ordinary env bindings on the main Worker.
   - Code that calls Durable Objects uses env Durable Object namespace bindings.

2. Let Events bind to OS's stream Durable Object namespace.
   - `apps/events/alchemy.run.ts` parses `DeploymentConfig` with an optional
     `streamDurableObjectBindingScriptName`.
   - When that config is present, Events binds `STREAM` cross-script to that
     Worker script's `StreamDurableObject`.
   - When absent, Events deploys and binds its own `StreamDurableObject`.
   - This must work in local development, not only in preview/prod.

3. Move the stream runtime into shared.
   - Move `StreamDurableObject` and associated stream runtime files from
     `apps/events/src/durable-objects/` to `packages/shared/src/streams/`.
   - Move stream-local SQL definitions, migrations, generated queries, and tests
     with the runtime.
   - Refactor `StreamDurableObject` to use the standard Durable Object mixins:
     lifecycle hooks, D1 object catalog, public fetch route, Outerbase, KV
     inspector, and durable object core.
   - Do not add app config, stream processor runner, multiplexed alarms, or
     scheduler mixins for this slice.

4. Make `events-contract` less central.
   - Core stream schemas and types that other apps care about live in
     `packages/shared/src/streams/types.ts`.
   - `apps/events-contract` may import and re-export shared stream types for the
     Events app API, but it does not own the core stream model.
   - OS must not depend on `apps/events` or `apps/events-contract` for stream
     runtime, stream types, or Code Mode stream access.
   - OS exposes a minimal OS-owned oRPC stream API that thinly wraps the shared
     stream runtime. Keep the public surface minimal: append, read, get state.

5. Keep stream subscriptions flexible, but use callables for processors.
   - The stream runtime still supports webhook subscriptions.
   - The stream runtime still supports WebSocket subscriptions for non-processor
     subscribers.
   - Processor subscriptions in OS use callable subscriptions, not WebSocket
     subscriptions.
   - Code Mode's processor target is a Durable Object RPC method such as
     `CodemodeSession.afterAppend({ event })`.
   - Callable delivery for processors should point at an env Durable Object
     namespace binding plus a concrete Durable Object selector. This does not
     require `ctx.exports`.

6. Events app debug routes stay public for the POC.
   - Register the stream Durable Object public fetch route in Events'
     `entry.workerd.ts`.
   - Events UI shows direct links for stream debug views such as KV inspector and
     Outerbase Studio.
   - Use the mixin's vanilla public route behavior, including init-param
     addressing where that is the default path.

## Important Corrections

- Processor subscription callables should use env Durable Object namespace
  bindings. `ctx.exports` is not part of the processor-subscription design.
- Single-script OS deployment is useful because every Durable Object can receive
  env bindings for every other Durable Object namespace without cross-worker
  service-binding cycles.
- Webhook and WebSocket subscriptions are not being removed from the stream
  runtime. Only processor subscriptions should stop using WebSockets.

## Local Proof Required

Before preview deployment, prove locally that:

- OS's main Worker exports and binds all required Durable Objects.
- OS Code Mode can append to and read from its own shared stream namespace.
- A callable processor subscription invokes `CodemodeSession.afterAppend`.
- Events can run locally with `streamDurableObjectBindingScriptName` pointing at
  the OS Worker script and can append/read through that cross-script stream
  binding.
- Events public stream debug links reach the expected stream Durable Object
  routes.

Record the exact commands and outputs in the implementation notes or PR.

## Preview Proof Required

Create a full OS preview deployment and prove:

- The preview deploy succeeds.
- Code Mode starts a session.
- Code Mode appends events to the shared stream runtime.
- The Code Mode stream processor receives appended events through callable
  subscription delivery.
- Events can be configured to point at the OS preview stream namespace and can
  inspect the same stream via debug links.

## Implementation Notes

- `StreamDurableObject` and associated stream runtime files now live in
  `packages/shared/src/streams/`.
- `StreamDurableObject` uses the standard Durable Object mixins for durable
  object core, lifecycle hooks, D1 object catalog, KV inspector, Outerbase, and
  public fetch routes.
- The stream structured name uses `projectId` and `path`; project slug based stream
  identity was removed for this slice.
- OS exports `StreamDurableObject`, `CodemodeSession`,
  `ProjectMcpServerConnection`, `ProjectDurableObject`, and the other OS
  Durable Objects from `apps/os/src/entry.workerd.ts`.
- OS's Alchemy config binds all OS Durable Object namespaces on the main
  Worker script. No OS stream Durable Object sidecar Worker is deployed.
- Events' Alchemy config accepts optional
  `streamDurableObjectBindingScriptName`. When present, Events binds `STREAM`
  to that script's `StreamDurableObject`; otherwise it deploys its own local
  stream namespace.
- Events preview configs `preview_2` through `preview_9` set
  `DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME` to the matching
  OS preview Worker script name.
- Code Mode registers a callable stream subscription whose target is the
  `CODEMODE_SESSION` env Durable Object namespace and whose RPC method is
  `afterAppend`.
- `ctx.exports` is intentionally not involved in processor subscription
  delivery.
- Events app-local secret storage now uses `project_id` / `projectId` naming.
  Historical migrations still mention `project_slug` because migration
  `0002_secrets_project_id.sql` renames that existing D1 column in place.

## Proof Notes

Subagents reviewed the migration direction for larger incongruities and bold
follow-up refactors. Their findings were consolidated in
`tasks/os-stream-runtime-big-refactors.md`.

Local static and unit checks run successfully:

```sh
pnpm --filter @iterate-com/shared typecheck
pnpm --filter @iterate-com/os typecheck
pnpm --filter @iterate-com/events typecheck
pnpm --filter @iterate-com/events test
pnpm --filter @iterate-com/events-contract typecheck
pnpm --filter @iterate-com/os-contract typecheck
pnpm --filter @iterate-com/agents typecheck
pnpm --filter @iterate-com/events-contract test
pnpm --filter @iterate-com/events sqlfu:generate
pnpm --filter @iterate-com/events exec sqlfu check migrations-match-definitions
pnpm --filter @iterate-com/shared test:callable
pnpm --filter @iterate-com/shared exec vitest run src/streams/external-subscriber.test.ts src/streams/circuit-breaker.test.ts
pnpm --filter @iterate-com/shared test:durable-object-utils:unit
pnpm --filter @iterate-com/shared sqlfu:streams:check
pnpm --filter @iterate-com/os test:codemode-session
pnpm --filter @iterate-com/os test:project-mcp-server-connection
pnpm exec tsc --noEmit --allowImportingTsExtensions --moduleResolution bundler --module esnext --target es2022 scripts/preview/apps.ts scripts/preview/preview.ts
```

The `test:codemode-session` suite includes a Workers runtime test proving that
a callable stream subscription delivers a directly appended event to
`CodemodeSession.afterAppend({ event })` and advances
`afterAppendCompletedThroughOffset`.

Local development cross-script binding proof:

```sh
doppler run --project os --config dev_jonas -- env APP_CONFIG_BASE_URL=http://localhost:5183 HOST=127.0.0.1 PORT=5183 pnpm exec tsx ./alchemy.run.ts
doppler run --project events --config dev_jonas -- env APP_CONFIG_BASE_URL=http://localhost:5184 DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME=os-dev-jonas HOST=127.0.0.1 PORT=5184 pnpm exec tsx ./alchemy.run.ts
EVENTS_BASE_URL=http://127.0.0.1:5184 pnpm --dir apps/events test:e2e:preview
curl -i http://127.0.0.1:5183/api/__internal/health
curl -i http://127.0.0.1:5184/api/__internal/health
```

Events' local preview smoke passed against the Events Worker on port 5184 while
`STREAM` was bound cross-script to the local OS Worker script
`os-dev-jonas`. Both local health checks returned HTTP 200. This caught and
fixed two local-runtime issues: stream Durable Object names now derive only from
`projectId` and `path`, and lifecycle initialization tolerates a Cloudflare
local cross-script namespace where `ctx.id.name` is unavailable while still
rejecting real name mismatches when the runtime supplies a name.

Events local public debug route proof:

```sh
ENC='%7B%22projectId%22%3A%22local-proof%22%2C%22path%22%3A%22%2Flocal-proof%22%7D'
curl -i "http://127.0.0.1:5184/durable-objects/stream/by-structured-name/$ENC/__kv"
curl -i "http://127.0.0.1:5184/durable-objects/stream/by-structured-name/$ENC/__outerbase"
```

Both local debug routes returned HTTP 200. The KV inspector response showed the
lifecycle mixin params with `projectId: "local-proof"` and
`path: "/local-proof"`.

Preview deploy checks were rerun successfully for `preview_2` after the final
shared stream, lifecycle, and Events `project_id` schema fixes:

```sh
doppler run --project os --config preview_2 -- pnpm tsx ./alchemy.run.ts
doppler run --project events --config preview_2 -- pnpm tsx ./alchemy.run.ts
OS_BASE_URL=https://os.iterate-preview-2.com pnpm --dir apps/os test:e2e:preview
EVENTS_BASE_URL=https://events.iterate-preview-2.com pnpm --dir apps/events test:e2e:preview
curl -i https://os.iterate-preview-2.com/api/__internal/health
curl -i https://events.iterate-preview-2.com/api/__internal/health
```

The final Events preview deploy applied
`apps/events/src/db/migrations/0002_secrets_project_id.sql`. Both health checks
returned HTTP 200. OS preview smoke passed for
`https://os.iterate-preview-2.com/`; Events preview smoke passed for
`https://events.iterate-preview-2.com/`.

Events public debug route proof against the Events preview Worker, with Events
bound cross-script to OS's `StreamDurableObject` namespace:

```sh
ENC='%7B%22projectId%22%3A%22preview-proof-final%22%2C%22path%22%3A%22%2Fpreview-proof-final%22%7D'
curl -i "https://events.iterate-preview-2.com/durable-objects/stream/by-structured-name/$ENC/__kv"
curl -i "https://events.iterate-preview-2.com/durable-objects/stream/by-structured-name/$ENC/__outerbase"
```

Both debug routes returned HTTP 200. The KV inspector response showed the
lifecycle mixin params with `projectId: "preview-proof-final"` and
`path: "/preview-proof-final"`.

Authenticated Code Mode preview E2E proof was run by creating a temporary Clerk
preview user, a temporary Clerk Organization, a temporary OS Project, and a
short-lived session bearer token inside one command. The bearer token was passed
directly to the child Vitest process and was not written into the repo.

```sh
doppler run --project os --config preview_2 -- pnpm exec tsx -e '<create temporary Clerk user/org/session, create OS project, run codemode.e2e.test.ts, clean up Clerk user/org>'
```

The setup produced project
`proj__os__01kqx50eqqfambaqyghhjfms1z`, then ran:

```sh
OS_BASE_URL=https://os.iterate-preview-2.com \
OS_E2E_PROJECT_ID=proj__os__01kqx50eqqfambaqyghhjfms1z \
OS_E2E_BEARER_TOKEN=<temporary Clerk session token> \
pnpm --dir apps/os exec vitest run --config e2e/vitest.config.ts e2e/vitest/codemode.e2e.test.ts
```

Result: 1 file passed, 2 tests passed. The Code Mode preview spec started a
script, read output events from the stream path, and observed the completed
script execution event. This proves the preview Code Mode path appends to the
shared stream runtime and receives processor output through the callable
subscription path.

## Non-goals

- Do not remove webhook subscription support.
- Do not remove WebSocket subscription support for non-processor subscribers.
- Do not add scheduler or multiplexed alarm behavior to the stream Durable
  Object in this slice.
- Do not preserve backwards compatibility for old project slug based stream
  identity.
