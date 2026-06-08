# Current OS Stream Surface

Factual inventory of stream and stream-processor usage in `apps/os`.

## oRPC Surface

Transport and router mounting:

- `apps/os/src/routes/api.orpc.$.ts:4` exposes `ANY /api/orpc/$` through `orpcRpcHandler` with prefix `/api/orpc`.
- `apps/os/src/routes/api.orpc-ws.ts:5` exposes `GET /api/orpc-ws` and routes WebSocket messages to `orpcWebSocketHandler`.
- `apps/os/src/orpc/root.ts:7` mounts `testRouter`, `projectsRouter`, `internalRouter`, and `ping`.
- `apps/os/src/orpc/handler.ts:19` defines OpenAPI tags including `Streams`, `Codemode`, `Agents`, and `Repos`.
- `apps/os/src/orpc/client.ts:43` creates the browser OpenAPI client at `/api`; `apps/os/src/orpc/client.ts:83` creates the browser WebSocket client at `/api/orpc-ws`.
- `apps/os/src/orpc/orpc.ts:28` resolves `projectSlugOrId` through `projectScopeMiddleware` before project-scoped procedures run.

Contract routes touching streams or processors:

| Procedure                        | HTTP route                                                             | Implementation                             | Notes                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `project.lifecycleState`         | `GET /projects/{projectSlugOrId}/lifecycle-state`                      | `apps/os/src/orpc/routers/projects.ts:385` | Reads Project DO stream-processor runner state. Contract at `apps/os-contract/src/index.ts:401`.                                       |
| `project.codemode.listSessions`  | `GET /projects/{projectSlugOrId}/codemode-sessions`                    | `apps/os/src/orpc/routers/projects.ts:393` | Lists `CodemodeSession` lifecycle records from `DO_CATALOG`. Contract at `apps/os-contract/src/index.ts:411`.                          |
| `project.codemode.findSession`   | `GET /projects/{projectSlugOrId}/codemode-sessions/{name}`             | `apps/os/src/orpc/routers/projects.ts:410` | Reads one `CodemodeSession` lifecycle record and verifies project ownership. Contract at `apps/os-contract/src/index.ts:420`.          |
| `project.codemode.createSession` | `POST /projects/{projectSlugOrId}/codemode-sessions`                   | `apps/os/src/orpc/routers/codemode.ts:29`  | Creates or initializes a CodemodeSession DO and appends setup/script events. Contract at `apps/os-contract/src/index.ts:429`.          |
| `project.codemode.executeScript` | `POST /projects/{projectSlugOrId}/codemode-scripts`                    | `apps/os/src/orpc/routers/codemode.ts:67`  | Appends script-execution request events to a codemode session stream. Contract at `apps/os-contract/src/index.ts:453`.                 |
| `project.codemode.streamEvents`  | `GET /projects/{projectSlugOrId}/codemode-events/{+streamPath}`        | `apps/os/src/orpc/routers/codemode.ts:89`  | Streams NDJSON events through `StreamsCapability.stream`. Contract at `apps/os-contract/src/index.ts:475`.                             |
| `project.codemode.describe`      | `POST /projects/{projectSlugOrId}/codemode-description`                | `apps/os/src/orpc/routers/codemode.ts:112` | Reads codemode session metadata and provider/script configuration from stream events. Contract at `apps/os-contract/src/index.ts:490`. |
| `project.agents.list`            | `GET /projects/{projectSlugOrId}/agents`                               | `apps/os/src/orpc/routers/agents.ts:26`    | Lists `AgentDurableObject` lifecycle records from `DO_CATALOG`. Contract at `apps/os-contract/src/index.ts:505`.                       |
| `project.agents.listPresets`     | `GET /projects/{projectSlugOrId}/agents/presets`                       | `apps/os/src/orpc/routers/agents.ts:57`    | Reads preset configuration events from the `/agents` root stream. Contract at `apps/os-contract/src/index.ts:514`.                     |
| `project.agents.configurePreset` | `POST /projects/{projectSlugOrId}/agents/presets`                      | `apps/os/src/orpc/routers/agents.ts:67`    | Appends preset configuration events to the `/agents` root stream. Contract at `apps/os-contract/src/index.ts:532`.                     |
| `project.agents.sendMessage`     | `POST /projects/{projectSlugOrId}/agents/messages/{+agentPath}`        | `apps/os/src/orpc/routers/agents.ts:89`    | Calls the Agent DO, which appends `agent-chat/user-message-added`. Contract at `apps/os-contract/src/index.ts:555`.                    |
| `project.agents.runtimeState`    | `GET /projects/{projectSlugOrId}/agents/runtime-state/{+agentPath}`    | `apps/os/src/orpc/routers/agents.ts:104`   | Reads Agent DO processor runtime state. Contract at `apps/os-contract/src/index.ts:570`.                                               |
| `project.repos.list`             | `GET /projects/{projectSlugOrId}/repos`                                | `apps/os/src/orpc/routers/repos.ts:7`      | Delegates to `ReposCapability`, backed by Repo DO lifecycle/catalog state. Contract at `apps/os-contract/src/index.ts:581`.            |
| `project.repos.create`           | `POST /projects/{projectSlugOrId}/repos`                               | `apps/os/src/orpc/routers/repos.ts:17`     | Creates a Repo DO and appends repo-created events. Contract at `apps/os-contract/src/index.ts:590`.                                    |
| `project.repos.get`              | `GET /projects/{projectSlugOrId}/repos/{repoSlug}`                     | `apps/os/src/orpc/routers/repos.ts:27`     | Reads Repo DO processor state. Contract at `apps/os-contract/src/index.ts:607`.                                                        |
| `project.streams.list`           | `GET /projects/{projectSlugOrId}/streams`                              | `apps/os/src/orpc/routers/streams.ts:8`    | Lists stream catalog records through `StreamsCapability.list`. Contract at `apps/os-contract/src/index.ts:737`.                        |
| `project.streams.create`         | `POST /projects/{projectSlugOrId}/streams`                             | `apps/os/src/orpc/routers/streams.ts:14`   | Initializes a stream through `StreamsCapability.create`. Contract at `apps/os-contract/src/index.ts:746`.                              |
| `project.streams.append`         | `POST /projects/{projectSlugOrId}/streams/events/{+streamPath}`        | `apps/os/src/orpc/routers/streams.ts:22`   | Appends one event through `StreamsCapability.append`. Contract at `apps/os-contract/src/index.ts:755`.                                 |
| `project.streams.appendBatch`    | `POST /projects/{projectSlugOrId}/streams/event-batches/{+streamPath}` | `apps/os/src/orpc/routers/streams.ts:32`   | Appends multiple events through `StreamsCapability.appendBatch`. Contract at `apps/os-contract/src/index.ts:769`.                      |
| `project.streams.read`           | `GET /projects/{projectSlugOrId}/streams/events/{+streamPath}`         | `apps/os/src/orpc/routers/streams.ts:42`   | Reads persisted stream events. Contract at `apps/os-contract/src/index.ts:783`.                                                        |
| `project.streams.streamEvents`   | `GET /projects/{projectSlugOrId}/streams/event-stream/{+streamPath}`   | `apps/os/src/orpc/routers/streams.ts:51`   | Streams NDJSON events and decodes them into an async iterator. Contract at `apps/os-contract/src/index.ts:798`.                        |
| `project.streams.getState`       | `GET /projects/{projectSlugOrId}/streams/__state/{+streamPath}`        | `apps/os/src/orpc/routers/streams.ts:66`   | Reads stream durable object state. Contract at `apps/os-contract/src/index.ts:813`.                                                    |
| `test.randomLogStream`           | `GET /test/random-log-stream`                                          | `apps/os-contract/src/index.ts:284`        | Test/demo streaming route used by `apps/os/src/routes/_app/log-stream.tsx`; it is not a project event stream.                          |

Router helper behavior:

- `apps/os/src/orpc/routers/streams.ts:76` constructs `StreamsCapability` from `context.workerExports` with `appendPolicy: { mode: "any" }` and the project id.
- `apps/os/src/orpc/routers/codemode.ts:313` validates codemode stream paths and requires a matching provided session stream path when applicable.
- `apps/os/src/orpc/routers/agents.ts:141` resolves the `/agents` root stream through `context.stream` and `AGENTS_STREAM_PATH`.
- `apps/os/src/orpc/routers/repos.ts:38` constructs `ReposCapability` from `context.workerExports`.

## Durable Objects And Capabilities

OS exports and binds these stream-adjacent Durable Object classes and worker-entrypoint capabilities:

| Class or binding                | Binding name in app context                         | Source                                                                                                                             | Stream role                                                                                |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `StreamDurableObject`           | `STREAM` / `context.stream`                         | `packages/shared/src/streams/stream-durable-object.ts`, exported by `apps/os/src/entry.workerd.ts:61`                              | Persistent event streams. Used by `StreamsCapability` and processor stream APIs.           |
| `StreamsCapability`             | `context.workerExports.StreamsCapability`           | `apps/os/src/domains/streams/entrypoints/streams-capability.ts:73`, exported by `apps/os/src/entry.workerd.ts:60`                  | WorkerEntrypoint facade for stream create/list/read/append/stream/get-state/list-children. |
| `CodemodeSession`               | `CODEMODE_SESSION` / `context.codemodeSession`      | `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:223`, exported by `apps/os/src/entry.workerd.ts:43`              | `withStreamProcessorRunner` over a codemode session stream.                                |
| `AgentDurableObject`            | `AGENT` / `context.agent`                           | `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:144`, exported by `apps/os/src/entry.workerd.ts:40`            | `withStreamProcessor` over agent streams and `/agents` root.                               |
| `ProjectDurableObject`          | `PROJECT` / `context.projectDurableObjectNamespace` | `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:271`, exported by `apps/os/src/entry.workerd.ts:44`        | `withStreamProcessorRunner` over the project lifecycle stream `/`.                         |
| `RepoDurableObject`             | `REPO` / `context.repo`                             | `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:120`, exported by `apps/os/src/entry.workerd.ts:58`              | `withStreamProcessorRunner` over `/repos/{repoSlug}` streams.                              |
| `SlackIntegrationDurableObject` | `SLACK_INTEGRATION` / `context.slackIntegration`    | `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:112`, exported by `apps/os/src/entry.workerd.ts:46` | Processor runner over `/integrations/slack`; emits routed subscriptions.                   |
| `SlackAgentDurableObject`       | `SLACK_AGENT` / `context.slackAgent`                | `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:109`, exported by `apps/os/src/entry.workerd.ts:45`       | Processor runner for Slack agent stream paths.                                             |
| `WorkspaceDurableObject`        | `WORKSPACE` / worker env                            | `apps/os/src/entry.workerd.ts:62`                                                                                                  | Used by agent/codemode processor flows; not a stream store.                                |
| `ProjectMcpServerConnection`    | `PROJECT_MCP_SERVER_CONNECTION`                     | `apps/os/src/entry.workerd.ts:48`                                                                                                  | MCP connection DO; included in test and app bindings.                                      |
| `DebugAppendChainSubscriber`    | `DEBUG_APPEND_CHAIN_SUBSCRIBER`                     | `apps/os/src/durable-objects/debug-append-chain-subscriber.ts`, exported by `apps/os/src/entry.workerd.ts:63`                      | Optional local debug subscriber for append-chain inspection.                               |

Context and exported worker wiring:

- `apps/os/src/context.ts:27` defines stream-related `AppContext` fields: `agent`, `codemodeSession`, `projectDurableObjectNamespace`, `repo`, `slackAgent`, `slackIntegration`, `stream`, and `workerExports`.
- `apps/os/src/entry.workerd.ts:150` maps Cloudflare env bindings into that context.
- `apps/os/src/lib/worker-env.d.ts:5` declares `Cloudflare.GlobalProps.mainModule` exports including `AgentCapability`, `CodemodeSession`, `ProjectCapability`, `ReposCapability`, `StreamsCapability`, and stream processor DO classes.

## Stream Capability Internals

- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:25` requires `STREAM` and optionally uses `DO_CATALOG`.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:37` scopes capability props by `projectId`, optional `streamPath`, optional append metadata, and append policy.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:88` exposes codemode-callable stream operations: `append`, `appendBatch`, `create`, `list`, `read`, `getState`, and `listChildren`.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:112` appends through the `STREAM` namespace with project namespace metadata.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:170` lists stream catalog rows by querying `DO_CATALOG` for `StreamDurableObject` records in the project namespace.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:197` streams events as `application/x-ndjson`.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:239` derives child stream paths from `child-created` and `first-initialized` events.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:302` centralizes stream path resolution and append policy checks.
- `apps/os/src/domains/streams/entrypoints/streams-capability.ts:379` delegates low-level calls to initialized `StreamDurableObject` stubs.

## Processor Usage

Project lifecycle:

- `apps/os/src/domains/projects/stream-processors/project-lifecycle.ts:10` defines `PROJECT_LIFECYCLE_STREAM_PATH` as `/`.
- `apps/os/src/domains/projects/stream-processors/project-lifecycle.ts:20` defines `ProjectLifecycleProcessorContract`.
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:218` wraps the Project DO with `withStreamProcessorRunner`.
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:399` exposes `getProjectLifecycleRunnerState` for `project.lifecycleState`.
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:404` handles stream appends with `afterAppend`.
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:899` and `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:965` write lifecycle events to the root stream.
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:1034` writes the `/agents` root stream setup rule.
- `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:1052` configures the project lifecycle callable subscription.

Codemode:

- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:42` structures DO names as `{ projectId, streamPath }`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:141` indexes lifecycle records by `projectId` and `streamPath`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:157` wraps the DO with `withStreamProcessorRunner` and `CodemodeProcessorContract`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:223` wakes the runner by ensuring a live consumer.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:264` consumes events in `afterAppend`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:283` creates a session by appending initial events and optional script requests through `StreamsCapability`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:542` exposes runner state.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:554` appends a callable subscription event for binding `CODEMODE_SESSION`, RPC method `afterAppend`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:777` implements the processor stream API over `STREAM`.

Agents:

- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:69` defines `AGENTS_STREAM_PATH` as `/agents`.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:71` structures DO names as `{ projectId, agentPath }`.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:121` indexes lifecycle records by `agentPath` and `projectId`.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:134` wraps the DO with `withStreamProcessor`.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:144` registers root-stream or agent-stream processors on wake.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:174` exposes `/stream-subscription` WebSocket subscription handling.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:239` consumes events in `afterAppend`.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:253` appends chat user-message events.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:297` appends a WebSocket subscription event for binding `AGENT`.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:333` creates CodemodeSession DOs for agent stream paths.
- `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:737` constructs a `StreamsCapability` for the agent's project.

Repos:

- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:37` structures DO names as `{ projectId, repoSlug }`.
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:87` indexes lifecycle records by `projectId` and `repoSlug`.
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:100` wraps the DO with `withStreamProcessorRunner` and `RepoStreamProcessorContract`.
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:129` creates repo artifacts and appends repo-created events.
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:227` consumes events in `afterAppend`.
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:307` appends repo-created events through `STREAM`.
- `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:326` appends a callable subscription event for binding `REPO`, RPC method `afterAppend`.
- `apps/os/src/domains/repos/stream-processors/repo-stream-processor.ts` defines the repo stream processor and repo stream path helpers.

Slack and integration streams:

- `apps/os/src/domains/secrets/integration-streams.ts:7` defines `/integrations/slack` and `/integrations/google` stream paths.
- `apps/os/src/domains/secrets/integration-streams.ts:26` appends integration events through `StreamsCapability` with stream-scoped append policy.
- `apps/os/src/domains/secrets/integration-api.ts:309` requires `STREAM` and `SLACK_INTEGRATION` bindings for Slack webhook handling.
- `apps/os/src/domains/secrets/integration-api.ts:321` appends Slack webhook events to `/integrations/slack`.
- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:81` wraps the integration DO with `withStreamProcessorRunner` and `SlackProcessorContract`.
- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:121` consumes Slack integration events in `afterAppend`.
- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:149` appends a callable subscription event for binding `SLACK_INTEGRATION`.
- `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:180` emits routed subscription events for `SLACK_AGENT` and `AGENT`.
- `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:74` wraps Slack agent streams with `withStreamProcessorRunner` and `SlackAgentProcessorContract`.
- `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:109` consumes Slack agent events in `afterAppend`.

## UI Routes And Components

Stream browser:

- `apps/os/src/routes/_app/projects/$projectSlug/streams/route.tsx:1` defines the `/projects/$projectSlug/streams` layout.
- `apps/os/src/routes/_app/projects/$projectSlug/streams/index.tsx:28` loads `project.streams.list`.
- `apps/os/src/routes/_app/projects/$projectSlug/streams/index.tsx:67` creates streams through `project.streams.create`.
- `apps/os/src/routes/_app/projects/$projectSlug/streams/index.tsx:207` links each stream row to the stream detail route and Events debug view.
- `apps/os/src/routes/_app/projects/$projectSlug/streams/$.tsx:6` renders a splat stream detail route.
- `apps/os/src/routes/_app/projects/$projectSlug/streams/$.tsx:33` appends chat-shaped test messages through `project.streams.appendBatch`.
- `apps/os/src/components/project-stream-view.tsx:121` streams events through `createBrowserOpenApiClient().project.streams.streamEvents`.
- `apps/os/src/components/project-stream-view.tsx:164` reduces events locally with `StreamViewProcessorContract`.
- `apps/os/src/components/project-stream-view.tsx:251` appends raw-composer events through `project.streams.appendBatch`.
- `apps/os/src/components/path-breadcrumbs.tsx:137` links stream breadcrumbs to stream detail routes.
- `apps/os/src/components/path-breadcrumbs.tsx:160` queries stream children with `project.streams.list`.

Agents:

- `apps/os/src/routes/_app/projects/$projectSlug/agents/index.tsx:20` loads `project.agents.list` and `project.agents.listPresets`.
- `apps/os/src/routes/_app/projects/$projectSlug/agents/index.tsx:205` links agents to `/agents/streams/$`.
- `apps/os/src/routes/_app/projects/$projectSlug/agents/new.tsx:125` creates agent streams by appending setup and subscription events through `project.streams.appendBatch`.
- `apps/os/src/routes/_app/projects/$projectSlug/agents/new.tsx:410` builds the `STREAM_SUBSCRIPTION_CONFIGURED_TYPE` event for binding `AGENT`.
- `apps/os/src/routes/_app/projects/$projectSlug/agents/streams/$.tsx:7` loads agent runtime state before rendering a stream.
- `apps/os/src/routes/_app/projects/$projectSlug/agents/streams/$.tsx:36` sends agent chat messages through `project.agents.sendMessage`.
- `apps/os/src/routes/_app/projects/$projectSlug/agents/new-preset.tsx:70` saves path-prefix presets through `project.agents.configurePreset`.

Codemode:

- `apps/os/src/routes/_app/projects/$projectSlug/codemode-sessions/index.tsx:14` loads `project.codemode.listSessions`.
- `apps/os/src/routes/_app/projects/$projectSlug/codemode-sessions/new.tsx:90` creates codemode sessions through `project.codemode.createSession`.
- `apps/os/src/routes/_app/projects/$projectSlug/codemode-sessions/new.tsx:298` builds preview setup/provider/script events for the target stream.
- `apps/os/src/routes/_app/projects/$projectSlug/codemode-sessions/$codemodeSessionName.tsx:15` validates optional `streamPath` search state.
- `apps/os/src/routes/_app/projects/$projectSlug/codemode-sessions/$codemodeSessionName.tsx:39` loads `project.codemode.findSession`.
- `apps/os/src/routes/_app/projects/$projectSlug/codemode-sessions/$codemodeSessionName.tsx:70` renders the codemode session with `ProjectStreamView`.
- `apps/os/src/components/codemode-session-controls.tsx:118` runs scripts through `project.codemode.executeScript`.
- `apps/os/src/components/codemode-session-controls.tsx:133` appends providers to an existing stream through `project.codemode.createSession`.

Repos and stream links:

- `apps/os/src/routes/_app/projects/$projectSlug/repos/index.tsx:50` lists repos through `project.repos.list`.
- `apps/os/src/routes/_app/projects/$projectSlug/repos/index.tsx:101` creates repos through `project.repos.create`.
- `apps/os/src/routes/_app/projects/$projectSlug/repos/$repoSlug.tsx:8` loads repo info through `project.repos.get`.
- `apps/os/src/lib/stream-links.ts:1` converts between stream paths and route splats.
- `apps/os/src/lib/stream-viewer-url.ts:1` builds stream dashboard URLs.
- `apps/os/src/routes/_app/log-stream.tsx` renders the `test.randomLogStream` demo route, separate from project streams.

## Tests

Durable Object and processor tests:

- `apps/os/src/durable-objects/codemode-session.test.ts:77` verifies session creation returns without timing out.
- `apps/os/src/durable-objects/codemode-session.test.ts:100` verifies tool-provider registration appends events.
- `apps/os/src/durable-objects/codemode-session.test.ts:113` verifies function calls append request events and resolve on result events.
- `apps/os/src/durable-objects/codemode-session.test.ts:197` verifies callable stream subscription delivery to `afterAppend`.
- `apps/os/src/durable-objects/codemode-session.test.ts:235` exercises loopback codemode RPC context including repos, agents, streams, and codemode session listing.
- `apps/os/src/durable-objects/project-ingress.test.ts:12` verifies project ingress writes project-created/config-worker-built lifecycle events and advances runner offsets.
- `apps/os/src/durable-objects/project-ingress.test.ts:192` verifies the `streams.*` project hostname routes to the bundled project worker.
- `apps/os/src/domains/repos/stream-processors/repo-stream-processor.test.ts` covers repo stream processor reduction and repo stream path helpers.
- `apps/os/src/domains/agents/agent-presets.test.ts` covers agent preset stream event helpers.
- `apps/os/src/domains/codemode/default-provider-registrations.test.ts` covers default codemode provider event registration.

End-to-end and UI-adjacent stream tests:

- `apps/os/e2e/vitest/agents.e2e.test.ts:36` configures an agent preset, sends a message, and reads stream events until LLM/codemode/chat output appears.
- `apps/os/e2e/vitest/agents.e2e.test.ts:142` exercises the default OpenAI agent chat path.
- `apps/os/e2e/vitest/codemode.e2e.test.ts:14` starts codemode scripts and reads output through `project.codemode.streamEvents`.
- `apps/os/e2e/vitest/codemode.e2e.test.ts:50` verifies codemode egress interception events.
- `apps/os/e2e/vitest/codemode.e2e.test.ts:124` verifies codemode description output.
- `apps/os/e2e/vitest/codemode-mcp-provider-stack.e2e.test.ts` exercises public MCP `exec_js` with built-in, RPC, OpenAPI, stream, and Slack providers; it calls `os.streams.list`, `streams.append`, and `streams.read`.
- `apps/os/e2e/tui-test/stream-tui.spec.ts` covers the stream TUI command flow.
- `packages/iterate/src/stream-tui/command-router.test.ts`, `packages/iterate/src/stream-tui/command-discovery.test.ts`, `packages/iterate/src/stream-tui/command-invocation.test.ts`, `packages/iterate/src/stream-tui/feed-formatting.test.ts`, `packages/iterate/src/stream-tui/navigation-state.test.ts`, `packages/iterate/src/stream-tui/pilotty-command.test.ts`, `packages/iterate/src/stream-tui/stream-paths.test.ts`, and `packages/iterate/src/stream-tui/stream-tree.test.ts` cover stream TUI parsing, routing, formatting, and navigation behavior.
- `apps/os/src/lib/stream-viewer-url.test.ts`, `apps/os/src/lib/events-links.test.ts`, and `apps/os/src/lib/agent-links.test.ts` cover stream/event/agent URL construction.

Test config and scripts:

- `apps/os/package.json:27` runs the main unit test suite while excluding durable object tests.
- `apps/os/package.json:28` runs `test:codemode-session`.
- `apps/os/package.json:29` runs `test:project-ingress`.
- `apps/os/package.json:30` runs `test:project-mcp-server-connection`.
- `apps/os/package.json:31` runs `e2e`.
- `apps/os/package.json:35` runs `benchmark:agent-stream`.
- `apps/os/vitest.config.ts:14` excludes durable-object, route, and e2e tests from the default suite.
- `apps/os/e2e/vitest.config.ts:21` configures the e2e Vitest suite.

## Env, Wrangler, And Alchemy Wiring

Alchemy app wiring:

- `apps/os/alchemy.run.ts:38` creates the D1 database used as `DB` and `DO_CATALOG`.
- `apps/os/alchemy.run.ts:63` creates the `STREAM` namespace for `StreamDurableObject`.
- `apps/os/alchemy.run.ts:67` creates `CODEMODE_SESSION`.
- `apps/os/alchemy.run.ts:71` creates `PROJECT_MCP_SERVER_CONNECTION`.
- `apps/os/alchemy.run.ts:78` creates `PROJECT`.
- `apps/os/alchemy.run.ts:82` creates `REPO`.
- `apps/os/alchemy.run.ts:86` creates `WORKSPACE`.
- `apps/os/alchemy.run.ts:90` creates `AGENT`.
- `apps/os/alchemy.run.ts:94` creates `SLACK_INTEGRATION`.
- `apps/os/alchemy.run.ts:101` creates `SLACK_AGENT`.
- `apps/os/alchemy.run.ts:105` optionally creates `DEBUG_APPEND_CHAIN_SUBSCRIBER`.
- `apps/os/alchemy.run.ts:112` binds these resources into the worker, including `DB`, `DO_CATALOG`, `CODEMODE_SESSION`, `AGENT`, `PROJECT`, `SLACK_AGENT`, `SLACK_INTEGRATION`, `REPO`, `PROJECT_MCP_SERVER_CONNECTION`, `STREAM`, `WORKSPACE`, and optional debug subscriber binding.

Wrangler/Vitest Durable Object wiring:

- `apps/os/src/durable-objects/codemode-session.wrangler.vitest.jsonc:9` binds `CODEMODE_SESSION`, `STREAM`, `REPO`, `WORKSPACE`, `AGENT`, and `PROJECT`.
- `apps/os/src/durable-objects/codemode-session.wrangler.vitest.jsonc:37` binds `DB` and `DO_CATALOG` D1 databases.
- `apps/os/src/durable-objects/codemode-session.wrangler.vitest.jsonc:56` declares migrations for `CodemodeSession`, `StreamDurableObject`, `RepoDurableObject`, `WorkspaceDurableObject`, `AgentDurableObject`, and `ProjectDurableObject`.
- `apps/os/src/durable-objects/project-ingress.wrangler.vitest.jsonc:14` binds `PROJECT`, `AGENT`, `CODEMODE_SESSION`, `PROJECT_MCP_SERVER_CONNECTION`, `STREAM`, `REPO`, and `WORKSPACE`.
- `apps/os/src/durable-objects/project-ingress.wrangler.vitest.jsonc:46` binds `DB` and `DO_CATALOG`.
- `apps/os/src/durable-objects/project-ingress.wrangler.vitest.jsonc:60` declares migrations for project-ingress DO tests.
- `apps/os/src/durable-objects/iterate-mcp-server.wrangler.vitest.jsonc:7` binds `CODEMODE_SESSION`, `PROJECT_MCP_SERVER_CONNECTION`, outbound MCP client capability, `REPO`, `WORKSPACE`, `AGENT`, and `STREAM`.
- `apps/os/src/durable-objects/iterate-mcp-server.wrangler.vitest.jsonc:39` binds `DO_CATALOG`.
- `apps/os/src/durable-objects/iterate-mcp-server.wrangler.vitest.jsonc:52` declares migrations for MCP server DO tests.
- `apps/os/src/durable-objects/codemode-session.vitest.config.ts:26` configures Cloudflare test pooling for codemode session tests.
- `apps/os/src/durable-objects/project-ingress.vitest.config.ts:26` configures Cloudflare test pooling for project ingress tests.
- `apps/os/src/durable-objects/iterate-mcp-server.vitest.config.ts` configures Cloudflare test pooling and service bindings for MCP server connection tests.

Environment references:

- `docs/devops-cloudflare-doppler-alchemy-setup.md:62` documents `DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME`.
- `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:107`, `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:87`, `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:98`, `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:79`, `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:52`, and `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:44` declare stream-related DO env shapes.

## Dependency Map

- Browser UI, stream TUI, e2e tests, and scripts call `apps/os-contract/src/index.ts` procedures through the oRPC/OpenAPI clients in `apps/os/src/orpc/client.ts`.
- Project-scoped oRPC routers resolve project identity via `apps/os/src/orpc/orpc.ts`, then use `AppContext` bindings from `apps/os/src/context.ts`.
- `project.streams.*` procedures call `StreamsCapability`, which calls the `STREAM` namespace and the shared `StreamDurableObject`; stream listing also depends on `DO_CATALOG`.
- `project.codemode.*` procedures call `CodemodeSession` DOs; those DOs run `CodemodeProcessorContract` over a project stream and subscribe by appending callable subscription events back into that stream.
- `project.agents.*` procedures call `AgentDurableObject` and the `/agents` root stream; Agent DOs run stream processors, create child agent runners, create CodemodeSession DOs for agent streams, and append chat/tool/codemode events.
- `project.repos.*` procedures call `ReposCapability`, which uses `RepoDurableObject`; Repo DOs process `/repos/{repoSlug}` streams and maintain repo info state.
- Project creation and lifecycle use `ProjectDurableObject` over the root `/` stream; the Project DO also writes `/agents` root stream setup and injects `StreamsCapability` into dynamic project workers.
- Slack webhook handling appends to `/integrations/slack`; `SlackIntegrationDurableObject` consumes that stream and emits routed subscription events for `SlackAgentDurableObject` and `AgentDurableObject`.
- Alchemy binds all production/preview/dev DO namespaces; Wrangler/Vitest JSONC files mirror the required stream-related namespaces for isolated durable-object tests.
