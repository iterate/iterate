# OS Domain Stream Ownership

This note maps OS domain objects that own, process, or imply stream ownership for
the streams migration. File references are repo-relative.

## Core Model

OS treats the shared stream runtime as a generic `{ namespace, path }` service.
The shared `StreamDurableObject` knows only `namespace` and `path`, writes its
own append-only SQLite log, and records initialized streams in the shared D1
catalog as `StreamDurableObject` rows indexed by `namespace` and `path`
(`packages/shared/src/streams/stream-durable-object.ts:51`,
`packages/shared/src/streams/stream-durable-object.ts:68`,
`packages/shared/src/streams/stream-durable-object.ts:100`).

Inside OS, the stream namespace is the stable Project ID. Stream paths are
project-local and must not redundantly encode `/projects/{projectId}`
(`apps/os/src/domains/streams/README.md:1`,
`apps/os/src/orpc/routers/codemode.ts:313`). The project stream API is a
capability over `STREAM` plus `projectId`; the project oRPC router exposes
`list`, `create`, `append`, `appendBatch`, `read`, `streamEvents`, and
`getState` (`apps/os/src/domains/streams/entrypoints/streams-capability.ts:37`,
`apps/os/src/orpc/routers/streams.ts:8`,
`apps/os-contract/src/index.ts:736`).

The shared Durable Object catalog tables are:

- `mixin_d1_object_catalog_objects(class, name, id, structured_name_json, created_at, last_woken_at)`
- `mixin_d1_object_catalog_indexes(class, index_name, index_value, name)`

They are created by the lifecycle mixin and used for discovery by stream,
project, repo, codemode, agent, workspace, and Slack durable objects
(`packages/shared/src/durable-object-utils/mixins/with-lifecycle-hooks.ts:81`,
`packages/shared/src/durable-object-utils/mixins/with-lifecycle-hooks.ts:838`).

## Database Tables

App-level D1 tables from `apps/os/src/db/definitions.sql`:

| Table                 | Scope                          | Domain use                                                                                                       |
| --------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `projects`            | Project listing projection     | Stable Project ID, globally unique Project slug, optional custom hostname. Not lifecycle authority.              |
| `project_permissions` | Project access grant           | Organization ownership grant via `principal_type = clerk_organization`; not a Project DO property.               |
| `ingress_routes`      | Project ingress projection     | Hot exact-host lookup for OS ingress; desired state lives on the Project DO.                                     |
| `project_connections` | Project integration connection | Project-scoped Slack/Google provider records; Slack webhook provider identifier is globally unique per provider. |
| `project_secrets`     | Project secret material        | D1-backed authority for current Project Secrets and OAuth access tokens.                                         |
| `oauth_states`        | OAuth callback state           | Project and user scoped OAuth flow state.                                                                        |

Project Durable Objects also keep local SQLite `project_state` and
`project_ingress_routes` tables for desired state
(`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:250`).
Stream Durable Objects keep per-stream event and reduced-state SQLite tables via
the shared streams migration, not in OS D1
(`packages/shared/src/streams/stream-durable-object.ts:232`).

## Routes And Procedures

Current TanStack UI routes in code are project-slug based:

- `/projects`
- `/projects/$projectSlug`
- `/projects/$projectSlug/codemode-sessions`
- `/projects/$projectSlug/codemode-sessions/$codemodeSessionName`
- `/projects/$projectSlug/agents`
- `/projects/$projectSlug/agents/streams/$`
- `/projects/$projectSlug/repos`
- `/projects/$projectSlug/secrets`
- `/projects/$projectSlug/integrations`
- `/projects/$projectSlug/mcp`
- `/projects/$projectSlug/streams`
- `/projects/$projectSlug/streams/$`

See `apps/os/src/routes/_app/projects/$projectSlug/...` and
`apps/os/src/routes/_app/projects/index.tsx`.

The oRPC contract uses collection procedures under `os.projects.*` and
project-scoped procedures under `os.project.*`. Project-scoped inputs carry
`projectSlugOrId`; middleware resolves and authorizes this to a stable Project
ID before handlers run (`apps/os/src/orpc/orpc.ts:28`,
`apps/os-contract/src/index.ts:14`).

Key oRPC/REST paths:

- `os.projects.create/list/find/findBySlug/updateConfig/remove`:
  `/projects`, `/projects/{id}`, `/projects/by-slug/{slug}`
  (`apps/os-contract/src/index.ts:298`).
- `os.project.get/lifecycleState`: `/project/{projectSlugOrId}`,
  `/projects/{projectSlugOrId}/lifecycle-state`
  (`apps/os-contract/src/index.ts:391`).
- `os.project.codemode.*`: `/projects/{projectSlugOrId}/codemode-sessions`,
  `/codemode-scripts`, `/codemode-events/{+streamPath}`
  (`apps/os-contract/src/index.ts:410`).
- `os.project.agents.*`: `/agents`, `/agents/presets`,
  `/agents/messages/{+agentPath}`, `/agents/runtime-state/{+agentPath}`
  (`apps/os-contract/src/index.ts:504`).
- `os.project.repos.*`: `/repos`, `/repos/{repoSlug}`
  (`apps/os-contract/src/index.ts:580`).
- `os.project.inboundMcpServer.listSessions`: `/mcp-sessions`
  (`apps/os-contract/src/index.ts:625`).
- `os.project.integrations.*`: `/integrations/slack`,
  `/integrations/slack/oauth`, `/integrations/google`,
  `/integrations/google/oauth` (`apps/os-contract/src/index.ts:636`).
- `os.project.secrets.*`: `/secrets`, `/secrets/{id}`
  (`apps/os-contract/src/index.ts:692`).
- `os.project.streams.*`: `/streams`, `/streams/events/{+streamPath}`,
  `/streams/event-stream/{+streamPath}`, `/streams/__state/{+streamPath}`
  (`apps/os-contract/src/index.ts:736`).

## Domain Entities

### Organization

IDs/slugs:

- Auth-worker Organization ID and slug enter OS through the authenticated
  principal and active organization context.
- D1 records only project access grants:
  `project_permissions(project_id, principal_type, principal_id, role)`.

Stream relationship:

- No organization stream exists today.
- Organizations own Projects through D1 access grants, not through the Project
  Durable Object (`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:246`).

Lifecycle boundary:

- Organization lifecycle is external to OS and auth-worker owned.
- OS should not use organization slug as stream namespace unless a new
  organization-scoped stream domain is explicitly introduced.

Ambiguity:

- Docs mention organization-scoped routes such as
  `/orgs/:organizationSlug/projects/...`, while current route files use
  `/projects/$projectSlug/...`. Decide whether this is planned route migration,
  stale docs, or an auth-worker routing concern.

### Project

IDs/slugs:

- Stable ID is a TypeID with prefix `proj`; optional caller-managed ID is
  accepted by the create contract (`apps/os/src/orpc/routers/projects.ts:121`,
  `apps/os-contract/src/index.ts:32`).
- Project slug is globally unique in D1 and hostname-safe
  (`apps/os/src/db/definitions.sql:1`).
- Project DO name is derived from structured name `{ projectId }`
  (`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:67`).

Routes/procedures:

- UI: `/projects`, `/projects/$projectSlug`, settings, streams, repos, agents,
  codemode sessions, integrations, secrets, MCP.
- oRPC: `os.projects.*`, `os.project.get`, `os.project.lifecycleState`.

Database tables:

- App D1: `projects`, `project_permissions`, `ingress_routes`.
- Project DO SQLite: `project_state`, `project_ingress_routes`.
- DO catalog: `ProjectDurableObject` via `createIterateDurableObjectBase`
  (`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:235`).

Current stream relationship:

- Stream namespace: Project ID.
- Lifecycle stream path: `/`
  (`apps/os/src/domains/projects/stream-processors/project-lifecycle.ts:10`).
- Processor: `ProjectLifecycleProcessorContract`.
- Consumes: `events.iterate.com/project/created`,
  `events.iterate.com/os/project-created`,
  `events.iterate.com/project/config-worker-built`,
  `events.iterate.com/project/cname-record-created`,
  `events.iterate.com/project/cname-record-creation-failed`
  (`apps/os/src/domains/projects/stream-processors/project-lifecycle.ts:20`).
- Project DO appends project-created and provisioning events to `/`, and
  subscribes itself with `events.iterate.com/core/subscription-configured`
  (`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:899`,
  `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:1052`).
- Project creation also initializes `/agents` and the iterate-config repo/workspace
  indirectly (`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:314`,
  `apps/os/src/domains/projects/durable-objects/project-durable-object.ts:1023`).

Lifecycle boundary:

- Project DO is the authority for project lifecycle and desired ingress state.
- D1 project and ingress rows are queryable projections.
- Project ID as stream namespace means most child domain lifecycles are
  project-contained but not necessarily Project DO-owned.

Ambiguities:

- `os.projects.remove` deletes only the D1 project row today; it does not
  destroy the Project DO, root stream, child streams, repos, workspaces, agents,
  or catalog rows (`apps/os/src/orpc/routers/projects.ts:356`).
- Should Project deletion become a stream event on `/`, a Project DO command, a
  cascade across child streams, or a tombstone-only lifecycle?

### Stream

IDs/slugs:

- Structured name `{ namespace, path }`; in OS, `namespace = projectId`.
- Public stream path is a `StreamPath`, for example `/`, `/repos/foo`,
  `/codemode-sessions/csess_x`, `/agents/assistant`.

Routes/procedures:

- UI explorer: `/projects/$projectSlug/streams` and splat detail route.
- oRPC: `os.project.streams.*`.
- Debug/public durable object route: `/durable-objects/stream/...`
  via shared public route metadata
  (`packages/shared/src/streams/stream-durable-object.ts:95`).

Database tables:

- DO catalog tables for discovery.
- Stream DO-local SQLite event log and reduced state.

Current event/processor relationship:

- The Stream DO owns append, idempotency, offset precondition, core reduction,
  child stream propagation, live readers, and subscriber fanout
  (`packages/shared/src/streams/stream-durable-object.ts:226`,
  `packages/shared/src/streams/stream-durable-object.ts:402`).
- The stream tree emits child stream events to ancestors after initialization
  (`packages/shared/src/streams/stream-durable-object.ts:426`).

Lifecycle boundary:

- A stream is initialized when a Stream DO is initialized. That first append is
  `events.iterate.com/core/stream-initialized`.
- Stream processors and domain DOs subscribe by appending
  `events.iterate.com/core/subscription-configured`.

Ambiguities:

- `os.project.streams.append` currently grants append policy `{ mode: "any" }`
  to project-scoped callers (`apps/os/src/orpc/routers/streams.ts:83`). Decide
  which domain event types should be publicly appendable after migration.

### Codemode Session

IDs/slugs:

- Structured name `{ projectId, streamPath }`
  (`apps/os/src/domains/codemode/durable-objects/codemode-session.ts:42`).
- Catalog/route identifier is `name`, derived from the structured name
  (`apps/os/src/orpc/routers/codemode.ts:351`).
- Default stream path is `/codemode-sessions/csess_<random>` for createSession
  and `/codemode-sessions/cblk_<random>` for executeScript
  (`apps/os/src/orpc/routers/codemode.ts:357`).

Routes/procedures:

- UI: `/projects/$projectSlug/codemode-sessions`,
  `/projects/$projectSlug/codemode-sessions/new`,
  `/projects/$projectSlug/codemode-sessions/$codemodeSessionName`.
- oRPC: `os.project.codemode.listSessions`, `findSession`, `createSession`,
  `executeScript`, `streamEvents`, `describe`.

Database tables:

- DO catalog: `CodemodeSession` indexed by `projectId` and `streamPath`
  (`apps/os/src/domains/codemode/durable-objects/codemode-session.ts:141`).
- Stream events live in the session stream.

Current stream relationship:

- Session stream path is the session identity and processor input.
- Processor: shared `CodemodeProcessorContract`.
- The session appends provider registrations, script execution requests,
  function call requests/completions, logs, and script completion events
  (`apps/os/src/domains/codemode/durable-objects/codemode-session.ts:283`,
  `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:330`,
  `apps/os/src/domains/codemode/durable-objects/codemode-session.ts:364`).
- The session subscribes itself as callable subscriber to its stream
  (`apps/os/src/domains/codemode/durable-objects/codemode-session.ts:554`).
- Relative processor stream paths are resolved under the session stream path;
  absolute paths escape to another project-local stream path
  (`apps/os/src/domains/codemode/durable-objects/codemode-session.ts:777`).

Lifecycle boundary:

- The Codemode Session DO is the authority for executing scripts and invoking
  tool providers for one `{ projectId, streamPath }`.
- The event stream is also the durable session transcript and processor input.
- Inbound MCP and Agents can attach codemode to their own streams rather than
  always using `/codemode-sessions/...`.

Ambiguities:

- `createSession` is attach-or-create for `{ projectId, streamPath }`; confirm
  whether user-created sessions should be exclusive owners of their stream path
  or merely processors attached to any domain stream.
- Codemode blocks and sessions both default under `/codemode-sessions/...`;
  decide whether one-shot block paths should be a separate family.

### Agent

IDs/slugs:

- Agent identity is `agentPath`, a project-local `StreamPath`.
- Agent DO structured name is `{ projectId, agentPath }`
  (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:69`).
- Root agents stream is `/agents`.

Routes/procedures:

- UI: `/projects/$projectSlug/agents`, `/agents/new`,
  `/agents/new-preset`, `/agents/streams/$`.
- oRPC: `os.project.agents.list`, `listPresets`, `configurePreset`,
  `sendMessage`, `runtimeState`.

Database tables:

- DO catalog: `AgentDurableObject` indexed by `projectId` and `agentPath`
  (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:121`).
- Stream events live on `/agents` and child agent paths.

Current stream relationship:

- `/agents` runs a JSONata reactor and stores path-prefix presets.
- Child streams under `/agents/...` run agent chat, agent, LLM, and codemode
  related processors (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:150`).
- `sendMessage` appends `events.iterate.com/agent-chat/user-message-added`
  (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:253`).
- Agent setup appends `events.iterate.com/agent/system-prompt-updated` and
  other configured setup events when missing
  (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:411`).
- Agent DO ensures a Codemode Session on the same `agentPath`
  (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:333`).
- Agent output can trigger codemode execution; codemode completion is fed back
  as `events.iterate.com/agent/input-added`
  (`apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:469`,
  `apps/os/src/domains/agents/durable-objects/agent-durable-object.ts:607`).

Lifecycle boundary:

- Agent stream path is both durable identity and event stream.
- Agent DO owns processors and side effects for that path.
- Agent workspaces are separate DOs; codemode uses the agent path as session path.

Ambiguities:

- The list API filters catalog records to paths starting with `/agents/`, which
  excludes the root `/agents` record (`apps/os/src/orpc/routers/agents.ts:45`).
  Confirm whether other agent-like paths should ever live outside `/agents/`.
- Agent creation in the UI appends directly through `os.project.streams.appendBatch`
  instead of an `agents.create` command; decide whether Agent should get an
  explicit lifecycle command/event owner.

### Repo

IDs/slugs:

- Repo is identified by `{ projectId, repoSlug }`.
- Repo slug is project-local lowercase kebab-case.
- Repo DO structured name is `{ projectId, repoSlug }`
  (`apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:37`).
- Cloudflare Artifacts name is an internal projection from project ID and repo
  slug (`apps/os/src/domains/repos/README.md:82`).

Routes/procedures:

- UI: `/projects/$projectSlug/repos`,
  `/projects/$projectSlug/repos/$repoSlug`.
- oRPC: `os.project.repos.list`, `create`, `get`.
- Codemode: `ctx.repos.create`, `ctx.repos.get`,
  `ctx.repos.ensureIterateConfigInfo`, `ctx.repos.list`
  (`apps/os/src/domains/repos/entrypoints/repo-capability.ts:69`).

Database tables:

- DO catalog: `RepoDurableObject` indexed by `projectId` and `repoSlug`.
- Repo DO KV stores write token material; stream stores lifecycle facts
  (`apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:117`).

Current stream relationship:

- Repo stream path is `/repos/{repoSlug}`
  (`apps/os/src/domains/repos/stream-processors/repo-stream-processor.ts:10`).
- Processor: `RepoStreamProcessorContract`.
- Consumes: `events.iterate.com/repo/created`.
- Repo DO subscribes itself to `/repos/{repoSlug}` and appends repo-created
  after artifact creation (`apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:307`,
  `apps/os/src/domains/repos/durable-objects/repo-durable-object.ts:326`).

Lifecycle boundary:

- `ReposCapability.create` is the explicit creation path and should not be
  bypassed by selector/get methods.
- Repo DO is authority for repo lifecycle and access token refresh; Artifacts is
  backing storage.
- The stream records durable repo facts, but sensitive token material lives in
  DO KV.

Ambiguities:

- `refreshWriteToken` updates DO KV but does not append a lifecycle event. Decide
  whether credential rotation should be stream-visible without leaking material.
- The iterate-config repo is auto-created by Project/Agent setup; decide whether
  system repos need distinct lifecycle event metadata or ownership.

### Workspace

IDs/slugs:

- Workspace DO structured name is `{ projectId, workspaceId }`
  (`apps/os/src/domains/workspaces/durable-objects/workspace-durable-object.ts:7`).
- Default codemode workspace ID is `codemode-session:{streamPath}`
  (`apps/os/src/domains/workspaces/entrypoints/workspace-provider-registration.ts:33`).
- Agent workspace ID is derived from the agent path in Agent DO code.
- Project config workspace ID is a fixed project config workspace under the
  project (`apps/os/src/domains/projects/durable-objects/project-durable-object.ts:1419`).

Routes/procedures:

- No product UI route or direct oRPC router.
- Codemode provider: `ctx.workspace.*` and `ctx.workspace.git.*`
  (`apps/os/src/domains/workspaces/entrypoints/workspace-provider-registration.ts:3`,
  `apps/os/src/domains/workspaces/entrypoints/workspace-capability.ts:24`).

Database tables:

- DO catalog: `WorkspaceDurableObject` indexed by `projectId` and `workspaceId`
  (`apps/os/src/domains/workspaces/durable-objects/workspace-durable-object.ts:25`).
- Workspace file/git state lives in DO-local Cloudflare Shell storage.

Current stream relationship:

- No stream processor or canonical workspace event stream exists today.
- Workspace identity is often implied by a codemode session stream path or agent
  path, but workspace state is not represented by stream events.

Lifecycle boundary:

- Workspace DO owns file system and Git state.
- Workspace creation is lazy through capability calls or Agent/Project setup.

Ambiguities:

- The workspace README says the product concept is unsettled because OS already
  has Projects and Organizations (`apps/os/src/domains/workspaces/README.md:1`).
  Confirm whether workspaces should remain implementation-private or become a
  user-visible stream-owning domain.

### Secret

IDs/slugs:

- Secret ID is TypeID prefix `sec`.
- Secret key is project-local arbitrary string; unique with `project_id`
  (`apps/os/src/db/definitions.sql:67`,
  `apps/os/src/domains/secrets/secrets-store.ts:52`).

Routes/procedures:

- UI: `/projects/$projectSlug/secrets`,
  `/projects/$projectSlug/secrets/$secretId`.
- oRPC: `os.project.secrets.list`, `get`, `upsert`, `remove`.
- Codemode: `ctx.secrets.get/set/delete/list` through `SecretsCapability`
  (`apps/os/src/domains/secrets/entrypoints/secrets-capability.ts:38`).

Database tables:

- `project_secrets(id, project_id, key, material, metadata, created_at, updated_at)`.

Current stream relationship:

- No Secret Durable Object and no Secret stream processor today.
- Integration connect/disconnect flows append integration lifecycle events after
  writing related secrets, but ordinary secret CRUD does not append stream
  events (`apps/os/src/domains/secrets/integration-streams.ts:26`,
  `apps/os/src/orpc/routers/secrets.ts:8`).

Lifecycle boundary:

- Current authority is D1-backed `SecretsCapability`.
- Longer-term Project Egress and Secret Durable Object work may move material
  behind a narrower trusted boundary (`apps/os/src/domains/secrets/README.md:1`).

Ambiguities:

- Should secret create/update/delete become project lifecycle events, per-secret
  streams, or remain D1-only because secret material must not leak into event
  history?
- If secret usage accounting lands later, should that be on the secret stream,
  project egress stream, or the consumer domain stream?

### Provider Connection And Integrations

IDs/slugs:

- Connection ID is currently legacy `conn_<uuid-without-dashes>`.
- Provider is `slack`, `google`, or future string.
- Slack webhook routing key is Slack `team_id` stored as
  `webhook_provider_identifier`, unique per provider
  (`apps/os/src/db/definitions.sql:41`,
  `apps/os/src/domains/secrets/README.md:12`).

Routes/procedures:

- UI: `/projects/$projectSlug/integrations`.
- oRPC: `os.project.integrations.getSlackConnection`,
  `startSlackOAuthFlow`, `disconnectSlack`, `getGoogleConnection`,
  `startGoogleOAuthFlow`, `disconnectGoogle`.
- HTTP callbacks/webhooks:
  `/api/integrations/slack/callback`,
  `/api/integrations/google/callback`,
  `/api/integrations/slack/webhook`,
  `/api/integrations/slack/interactivity-webhook`
  (`apps/os/src/domains/secrets/integration-api.ts:26`).

Database tables:

- `project_connections`, `project_secrets`, `oauth_states`.

Current stream relationship:

- Slack integration stream: `/integrations/slack`.
- Google integration stream: `/integrations/google`.
- Connected/disconnected event constants:
  `events.iterate.com/slack/connected`,
  `events.iterate.com/slack/disconnected`,
  `events.iterate.com/google-integration/connected`,
  `events.iterate.com/google-integration/disconnected`
  (`apps/os/src/domains/secrets/integration-streams.ts:7`).
- OAuth callbacks write D1 connection/secret rows, then append connected events
  (`apps/os/src/domains/secrets/integration-api.ts:103`,
  `apps/os/src/domains/secrets/integration-api.ts:127`,
  `apps/os/src/domains/secrets/integration-api.ts:211`,
  `apps/os/src/domains/secrets/integration-api.ts:240`).
- Disconnect procedures delete D1 state, then append disconnected events
  (`apps/os/src/orpc/routers/integrations.ts:38`,
  `apps/os/src/orpc/routers/integrations.ts:91`).
- Slack webhooks resolve `team_id` to a Project ID through D1 and append
  `events.iterate.com/slack/webhook-received` to `/integrations/slack`
  (`apps/os/src/domains/secrets/integration-api.ts:298`,
  `apps/os/src/domains/secrets/integration-api.ts:321`).

Lifecycle boundary:

- D1 is current authority for connection claims and secret material.
- Integration streams expose lifecycle and inbound webhook facts to processors.

Ambiguities:

- The README says future Slack and Google processors should own the event
  vocabulary; Slack has a processor now, Google does not
  (`apps/os/src/domains/secrets/README.md:31`).
- Decide whether D1 connection rows or integration streams are canonical for
  connected/disconnected status once processors exist.

### Slack Integration And Slack Agent

IDs/slugs:

- SlackIntegration DO structured name is `{ projectId }`
  (`apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:38`).
- SlackAgent DO structured name is `{ projectId, streamPath }`
  (`apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:28`).
- Routed agent streams are described as
  `/agents/slack/<channel>/ts-...`
  (`apps/os/src/domains/slack/README.md:1`).

Routes/procedures:

- No separate product route beyond integrations and agents.
- Slack Web API codemode provider uses Slack secrets and project context.

Database tables:

- DO catalog: `SlackIntegrationDurableObject`, `SlackAgentDurableObject`.
- D1 secrets/connections for Slack access token and team claim.

Current stream relationship:

- SlackIntegration DO subscribes to `/integrations/slack` and runs the shared
  `SlackProcessorContract` (`apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:81`,
  `apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:149`).
- Slack processor consumes Slack connection, disconnection, thread-route, and
  webhook events; emits subscription configs, thread-route configs, and routed
  webhook events (`packages/shared/src/stream-processors/slack/contract.ts:28`).
- Routed stream bootstrap subscribes both SlackAgent DO and Agent DO to the
  Slack-routed agent stream (`apps/os/src/domains/slack/durable-objects/slack-integration-durable-object.ts:180`).
- SlackAgent DO runs `SlackAgentProcessorContract` on the routed stream and can
  call Slack side effects using `slack.access_token`
  (`apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:74`,
  `apps/os/src/domains/slack/durable-objects/slack-agent-durable-object.ts:187`).

Lifecycle boundary:

- SlackIntegration DO owns project-level Slack webhook routing state.
- SlackAgent DO owns Slack-specific side effects and route context on a routed
  agent stream.
- Agent DO owns general agent chat/codemode behavior on the same routed stream.

Ambiguities:

- Two domain DOs process the same routed Slack agent stream. Confirm whether the
  migration wants a single stream owner plus processors, or explicit shared
  ownership by subscription.
- Slack connected/disconnected writes are currently D1-first then stream event;
  decide failure/repair semantics if append fails after D1 mutation.

### Google And Gmail

IDs/slugs:

- Google connection is a `project_connections` row with provider `google`.
- Google access token secret key is `google.access_token`.

Routes/procedures:

- Integration UI/oRPC as above.
- Gmail codemode provider exposes `ctx.gmail.request(...)`
  (`apps/os/src/domains/google/entrypoints/gmail-capability.ts:24`).

Database tables:

- `project_connections`, `project_secrets`, `oauth_states`.

Current stream relationship:

- Google lifecycle stream path is `/integrations/google`.
- Connect/disconnect events are appended manually by OAuth/router code.
- There is no GoogleIntegration Durable Object or stream processor in OS today.
- GmailCapability reads and refreshes tokens through D1-backed secret helpers;
  token refresh writes D1 but appends no stream event
  (`apps/os/src/domains/secrets/oauth.ts:126`).

Lifecycle boundary:

- Google integration state is D1-first today.
- Gmail request execution is a stateless WorkerEntrypoint capability.

Ambiguities:

- Should token refresh, expiry, and revoked-token failures be lifecycle events
  on `/integrations/google`, secret events, or only operational logs?
- Should a future Google processor mirror Slack's project-level integration DO?

### Inbound MCP Server Session

IDs/slugs:

- Project MCP connection props include project, organization, user, client, and
  auth fields (`apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:48`).
- Catalog structured name is `{ projectId, projectSlug, orgId, orgSlug, userId,
clientId, clientName, streamPath }`
  (`apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:71`).
- Stream path is `/mcp-server-sessions/{sessionSlug}` where session slug is
  derived from MCP client name plus session ID suffix
  (`apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:448`).

Routes/procedures:

- UI: `/projects/$projectSlug/mcp`.
- oRPC list: `os.project.inboundMcpServer.listSessions`.
- Runtime MCP resource: `/mcp` handled by the OS MCP handler and
  `ProjectMcpServerConnection` (`apps/os/src/domains/inbound-mcp-server/README.md:1`).

Database tables:

- DO catalog: `ProjectMcpServerConnection`, manually upserted with indexes on
  `orgId` and `projectId`
  (`apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:486`).

Current stream relationship:

- Inbound MCP appends `events.iterate.com/mcp-server/session-started`,
  `/tool-invocation-started`, and `/tool-invocation-finished` to the session
  stream (`apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:377`).
- `exec_js` starts codemode on the same MCP session stream path and waits for
  matching codemode completion/log events
  (`apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:239`,
  `apps/os/src/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts:716`).

Lifecycle boundary:

- Inbound MCP connection owns the MCP session identity and stream path.
- Codemode attaches to that stream as the execution processor, so MCP and
  codemode lifecycle events interleave.

Ambiguities:

- Confirm whether inbound MCP session streams are owned by MCP with codemode as
  attached processor, or by CodemodeSession because execution is delegated there.
- Session stream path includes client-derived slug; decide collision/tombstone
  semantics across reconnects.

### Outbound MCP Client

IDs/slugs:

- DO name encodes remote MCP server URL and request headers
  (`apps/os/src/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts:13`).

Routes/procedures:

- No project UI/oRPC route.
- Codemode provider created by `ctx.codemode.connectToMcpServer` and examples.

Database tables:

- No DO catalog use in current class; it extends raw `DurableObject`, not the
  lifecycle mixin.

Current stream relationship:

- It is an RPC tool provider invoked by CodemodeSession. Tool calls are traced
  by codemode function-call events on the owning codemode stream, but the
  outbound MCP DO has no separate stream processor or lifecycle stream.

Lifecycle boundary:

- One DO instance owns one remote MCP connection/session cache.
- Codemode stream owns call lifecycle; remote MCP connection state is DO-local.

Ambiguities:

- Should outbound MCP connection lifecycle become stream-visible so reconnects,
  tool list changes, and auth failures can be replayed or inspected?
- Encoding headers in a Durable Object name is called out in comments; confirm
  whether any sensitive headers can appear there before broader migration.

### Ingress And Project Egress

IDs/slugs:

- Ingress uses normalized hostnames and route IDs.
- Project egress intercept tunnel is Project-owned but currently ephemeral.

Routes/procedures:

- Host routing happens before app routing through D1 `ingress_routes`.
- ProjectIngressEntrypoint receives stable `projectId`.

Database tables:

- D1 `ingress_routes` projection.
- Project DO SQLite `project_ingress_routes`.

Current stream relationship:

- Project creation and DNS provisioning events are on Project root `/`.
- Ingress route changes are primarily DO/D1 state today; not every route change
  has a first-class stream event.
- Project egress secret substitution uses SecretsCapability; no dedicated egress
  stream currently exists.

Lifecycle boundary:

- Project DO owns desired ingress state.
- D1 is hot lookup projection.

Ambiguities:

- Should ingress mutations become Project Lifecycle Events, a separate
  `/ingress` stream, or remain Project DO state with repair logs?
- Should project egress intercept tunnels have a stream lifecycle, or remain
  ephemeral testing/runtime state?

## Cross-Domain Ownership Patterns

1. Project ID is the namespace boundary. Avoid stream paths that include
   `/projects/{projectId}`.
2. Stream path often is the domain identity: codemode sessions and agents are
   named by `{ projectId, streamPath }`; repos derive stream path from repo slug.
3. D1 app tables are mostly projections or D1-backed POC authorities. Do not
   assume a D1 row is the lifecycle owner without checking the domain README and
   Durable Object.
4. DO catalog rows are discovery/projection records. They do not necessarily
   mean the catalog owns lifecycle.
5. Several domains append setup/subscription events through generic stream APIs,
   so event ownership is looser than domain ownership today.
6. Slack is the clearest multi-processor stream example: integration stream
   routes into agent streams, where SlackAgent and Agent both process the same
   stream.

## Ambiguities To Grill The User On

1. Should every project child object have one canonical owner stream path, or
   can a stream be intentionally co-owned by multiple domain processors?
2. Is the migration trying to make event streams the source of truth for
   lifecycle, or just the audit/processor bus beside DO/D1 authorities?
3. Should Project deletion cascade to child streams/DOs/catalog rows, append a
   root tombstone only, or remain D1-only?
4. Should Secret and OAuth token changes be represented as redacted lifecycle
   events, or kept out of event history entirely?
5. Do integrations use D1 connection rows as authority with stream events as
   notifications, or should `/integrations/{provider}` streams become canonical?
6. Are current UI routes under `/projects/$projectSlug/...` correct, or should
   the docs' organization-scoped route shape become the canonical product route?
7. Should `os.project.streams.append` remain a generic project append API, or
   should domain-owned event types only be appendable through domain commands?
8. Is `Workspace` an implementation detail tied to codemode/agent streams, or a
   first-class domain object that needs its own stream lifecycle?
9. For inbound MCP, is the owning stream conceptually an MCP session stream with
   codemode attached, or a codemode stream initiated by MCP?
10. For repos, should token refresh and backing artifact changes be represented
    by redacted repo lifecycle events?
