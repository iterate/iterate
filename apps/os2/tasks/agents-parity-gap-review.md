---
state: todo
priority: medium
size: medium
dependsOn: []
---

# Agents Parity Gap Review

Decide which parts of the old `apps/agents` stream-driven agent stack should be
ported, replaced, or explicitly left behind in `apps/os2`.

## Context

`apps/os2` already overlaps with `apps/agents` around codemode, MCP, oRPC, and
events, but it is not a direct port. OS2 is organized around Clerk
organizations, projects, `CodemodeSession`, and project-hosted MCP. Agents is
organized around stream processor runners, event-stream callbacks, and a richer
agent console.

## Missing From OS2

- Stream processor runner Durable Objects:
  `AgentStreamProcessorRunner`, `CodemodeStreamProcessorRunner`,
  `WebchatStreamProcessorRunner`, and `ChildStreamAutoSubscriber`.
- Runner WebSocket callback routing for events push subscriptions.
- Slack provider runtime: `SlackApi`, `@slack/web-api`, Slack token config, and
  default Slack tool-provider events.
- Pull-based stream processor harness and tests.
- Agent-specific oRPC routes: `createAgent`, `installProcessor`,
  `basePathDefaults`, and `sample`.
- `events-forwarded` webhook path used for forwarded-event subscription tests.
- `StreamApi` / `routeAgentRequest` integration from the Cloudflare `agents`
  package.
- Stream TUI implementation and scripts.
- Rich events URL helpers for stream viewer/composer links and runner callback
  URLs.
- Agents Drizzle table shape keyed by project slug and stream path.
- Agents e2e infrastructure: HAR replay, mock internet, forwarded events,
  runtime smoke, agent loop, and TUI tests.

## Partial Parity

- Codemode exists in both apps, but agents uses events-driven stream processor
  runners while OS2 uses `CodemodeSession`.
- MCP/OpenAPI tool calling exists in both apps, but agents uses `MCPClient` and
  `OpenApiToolClient` Durable Objects while OS2 uses `McpClientBridge` and
  `OpenApiBridge`.
- OS2 project stream code talks to the Events stream Durable Object through the
  `STREAM` namespace binding instead of an Events URL client.
- OS2 uses `McpAgent.serve("/mcp")` with Clerk/project auth; agents uses agent
  request routing and stream callbacks.

## Desired Outcome

- Decide whether OS2 should support the old stream processor runner model, or
  whether `CodemodeSession` fully replaces it.
- Decide whether Slack should become a first-class OS2 provider, a project
  preset, or stay agents-only.
- Decide whether OS2 needs a stream console/TUI, or whether the project
  `run-code` page is the only supported interaction surface.
- Decide whether any agents e2e infrastructure should be reused for OS2
  codemode/MCP coverage.
- Record explicit non-goals for agents features that should not move forward.

## Useful Files

- `apps/agents/AGENTS.md`
- `apps/agents/alchemy.run.ts`
- `apps/agents/src/entry.workerd.ts`
- `apps/agents/src/durable-objects`
- `apps/agents/src/stream-tui`
- `apps/agents/src/lib/events-urls.ts`
- `apps/agents/src/orpc/root.ts`
- `apps/agents/e2e`
- `apps/os2/AGENTS.md`
- `apps/os2/alchemy.run.ts`
- `apps/os2/src/entry.workerd.ts`
- `apps/os2/src/durable-objects/codemode-session.ts`
- `apps/os2/src/durable-objects/iterate-mcp-server.ts`
- `apps/os2/src/rpc-targets`
