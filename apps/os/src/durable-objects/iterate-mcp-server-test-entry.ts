import { McpAgent } from "agents/mcp";
import type { ProjectMcpServerConnectionProps } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export {
  MockArtifactAgentDurableObject as AgentDurableObject,
  MockArtifactsBinding,
} from "./mock-artifacts-binding.ts";
export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/rpc-targets/os-capabilities.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";
export { ItxDurableObject } from "~/itx/itx-durable-object.ts";
export { EgressPipe, ItxEntrypoint, ProjectEgress } from "~/itx/entrypoint.ts";
export { PlatformContext } from "~/itx/platform-context.ts";

const mcpHandler = McpAgent.serve("/mcp", { binding: "PROJECT_MCP_SERVER_CONNECTION" });

export default {
  async fetch(request, env, ctx) {
    // The itx context catalog lives in the deployment D1 (DB and DO_CATALOG
    // are the same database in real deployments); this env runs no
    // migrations, so create what extendContext needs.
    await ensureD1Schema(env.DO_CATALOG);
    const ctxWithProps = ctx as ExecutionContext & { props?: ProjectMcpServerConnectionProps };
    ctxWithProps.props = propsForRequest(request);
    return mcpHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function ensureD1Schema(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
        id text primary key not null,
        slug text not null unique,
        custom_hostname text unique,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS itx_contexts (
        id text primary key not null,
        project_id text not null,
        journal_path text not null,
        created_at text not null default current_timestamp
      )`),
  ]);
}

function propsForRequest(request: Request): ProjectMcpServerConnectionProps {
  const mode = new URL(request.url).searchParams.get("mode");
  if (mode === "multi" || mode === "admin") {
    const isAdmin = mode === "admin";
    const orgFields = {
      organizationId: isAdmin ? "admin-api" : "org_test",
      organizationPermissions: isAdmin ? ["admin:api"] : [],
      organizationRole: "admin",
      organizationSlug: isAdmin ? null : "test-org",
    } as const;
    return {
      authType: isAdmin ? "admin_api_secret" : "oauth_access_token",
      clientId: "mcp-client-test",
      orgId: isAdmin ? "admin-api" : "org_test",
      orgPermissions: isAdmin ? ["admin:api"] : [],
      orgRole: isAdmin ? "admin" : null,
      orgSlug: isAdmin ? null : "test-org",
      projectId: null,
      projectSlug: null,
      projects: [
        { id: "proj__test__inboundmcp", slug: "mcp-project", ...orgFields },
        { id: "proj__test__other", slug: "other-project", ...orgFields },
      ],
      scopes: isAdmin
        ? []
        : ["profile", "project", "project:proj__test__inboundmcp", "project:proj__test__other"],
      userId: isAdmin ? "admin-api-secret" : "user_test",
    };
  }

  return {
    clientId: "mcp-client-test",
    orgId: "org_test",
    orgPermissions: [],
    orgRole: "admin",
    orgSlug: "test-org",
    projectId: "proj__test__inboundmcp",
    projectSlug: "mcp-project",
    scopes: ["profile", "project", "project:proj__test__inboundmcp"],
    userId: "user_test",
  };
}
