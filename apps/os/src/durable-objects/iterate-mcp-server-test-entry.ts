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

const mcpHandler = McpAgent.serve("/mcp", { binding: "PROJECT_MCP_SERVER_CONNECTION" });

export default {
  fetch(request, env, ctx) {
    const ctxWithProps = ctx as ExecutionContext & { props?: ProjectMcpServerConnectionProps };
    ctxWithProps.props = propsForRequest(request);
    return mcpHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

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
