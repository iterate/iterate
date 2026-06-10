import { McpAgent } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import type { ExecuteCodemodeFunctionCallInput } from "~/rpc-targets/legacy-codemode-call.ts";
import type { ProjectMcpServerConnectionProps } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

export { CodemodeSession } from "~/durable-objects/codemode-session-tombstone.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export {
  MockArtifactAgentDurableObject as AgentDurableObject,
  MockArtifactsBinding,
} from "./mock-artifacts-binding.ts";
export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/rpc-targets/os-capabilities.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { ProjectCapability } from "~/domains/projects/entrypoints/project-capability.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { Stream as StreamDurableObject } from "@iterate-com/streams/workers/durable-objects/stream";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";
export { WorkspaceDurableObject } from "~/domains/workspaces/durable-objects/workspace-durable-object.ts";
export { OutboundMcpFromOurClientCapability } from "~/domains/outbound-mcp-client/entrypoints/outbound-mcp-from-our-client-capability.ts";
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";

const mcpHandler = McpAgent.serve("/mcp", { binding: "PROJECT_MCP_SERVER_CONNECTION" });

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  args: Record<string, unknown>[];
  functionPath: string[];
};

export class TestBuiltinMatrixProvider extends WorkerEntrypoint {
  async executeCodemodeFunctionCall(input: ToolFunctionInput & ExecuteCodemodeFunctionCallInput) {
    const path = input.functionPath.join(".");
    if (path !== "compose") {
      throw new Error(`TestBuiltinMatrixProvider does not implement ${path}`);
    }

    const ctx = createCodemodeContext({
      codemodeSessionCapability: input.codemodeSessionCapability,
    });
    const [request] = input.args;
    const pet = await ctx.integrations.http.catalog.getPet({
      include: "owner",
      petId: request?.petId,
    });
    const echo = await ctx.mcp.cloudflareDocs["echo.text"]({
      text: `provider saw ${String(request?.text)}`,
    });
    const leaf = await ctx.leaf({
      value: request?.value,
    });

    return {
      echo,
      leaf,
      pet,
      provider: "builtin-matrix",
      route: "codemode-session-capability",
    };
  }
}

export class TestLeafProvider extends WorkerEntrypoint {
  async executeCodemodeFunctionCall(input: ToolFunctionInput & ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length > 0) {
      throw new Error(`TestLeafProvider expected leaf call, got ${input.functionPath.join(".")}`);
    }

    const [request] = input.args;
    return {
      provider: "leaf",
      toolFunctionPath: input.functionPath,
      value: Number(request?.value) * 2,
    };
  }
}

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
