import {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Self,
  Worker,
  WorkerLoader,
} from "alchemy/cloudflare";
import { initAlchemy } from "@iterate-com/shared/alchemy/init";
import { IterateApp } from "@iterate-com/shared/alchemy/iterate-app";
import manifest, { AppConfig } from "./src/app.ts";

const ctx = await initAlchemy(manifest, AppConfig, process.env);

const db = await D1Database("agents-db", {
  name: `${ctx.workerName}-db`,
  migrationsDir: "./drizzle",
  adopt: true,
});

const agentStreamProcessorRunner = DurableObjectNamespace("agent-stream-processor-runner", {
  className: "AgentStreamProcessorRunner",
  sqlite: true,
});
const codemodeStreamProcessorRunner = DurableObjectNamespace("codemode-stream-processor-runner", {
  className: "CodemodeStreamProcessorRunner",
  sqlite: true,
});
const webchatStreamProcessorRunner = DurableObjectNamespace("webchat-stream-processor-runner", {
  className: "WebchatStreamProcessorRunner",
  sqlite: true,
});
const childStreamAutoSubscriber = DurableObjectNamespace("child-stream-auto-subscriber", {
  className: "ChildStreamAutoSubscriber",
  sqlite: true,
});
const mcpClient = DurableObjectNamespace("mcp-client", {
  className: "MCPClient",
  sqlite: true,
});
const openApiToolClient = DurableObjectNamespace("openapi-tool-client", {
  className: "OpenApiToolClient",
  sqlite: true,
});
const slackApi = DurableObjectNamespace("slack-api", {
  className: "SlackApi",
  sqlite: true,
});

const { worker, afterFinalize } = await IterateApp(ctx, {
  bindings: {
    DB: db,
    AGENT_STREAM_PROCESSOR_RUNNER: agentStreamProcessorRunner,
    CODEMODE_STREAM_PROCESSOR_RUNNER: codemodeStreamProcessorRunner,
    WEBCHAT_STREAM_PROCESSOR_RUNNER: webchatStreamProcessorRunner,
    CHILD_STREAM_AUTO_SUBSCRIBER: childStreamAutoSubscriber,
    MCP_CLIENT: mcpClient,
    OPENAPI_TOOL_CLIENT: openApiToolClient,
    SLACK_API: slackApi,
    LOADER: WorkerLoader(),
    AI: Ai(),
    // Nested codemode workers need a real `Fetcher` for `globalOutbound`,
    // not `globalThis.fetch`. Same pattern as events' old dynamic-worker egress gateway.
    CODEMODE_OUTBOUND_FETCH: Worker.experimentalEntrypoint(Self, "CodemodeOutboundFetch"),
  },
  // Cloudflare gates `request.signal` behind this flag — needed by the oRPC
  // logging plugin to distinguish aborted client requests from real failures.
  // https://developers.cloudflare.com/workers/runtime-apis/request/
  // `global_fetch_strictly_public` lets this Worker call same-zone Worker routes
  // such as events.iterate.com via fetch instead of bypassing Workers to origin.
  compatibilityFlags: ["enable_request_signal", "global_fetch_strictly_public"],
});

export { worker };

await ctx.app.finalize();
await afterFinalize();

if (!ctx.app.local) process.exit(0);
