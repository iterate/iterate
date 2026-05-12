import { McpAgent } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { ProjectMcpServerConnectionProps } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";

export { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
export { ProjectMcpServerConnection } from "~/domains/inbound-mcp-server/durable-objects/project-mcp-server-connection.ts";
export {
  MockArtifactAgentDurableObject as AgentDurableObject,
  MockArtifactsBinding,
} from "./mock-artifacts-binding.ts";
export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AiCapability, OrpcCapability } from "~/domains/codemode/example-capabilities.ts";
export { FetchCapability } from "~/domains/codemode/fetch-capability.ts";
export { RepoDurableObject } from "~/domains/repos/durable-objects/repo-durable-object.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsCapability } from "~/domains/streams/entrypoints/streams-capability.ts";
export { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
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
    ctxWithProps.props = {
      clientId: "mcp-client-test",
      orgId: "org_test",
      orgPermissions: [],
      orgRole: "admin",
      orgSlug: "test-org",
      projectId: "proj__test__inboundmcp",
      projectSlug: "mcp-project",
      scopes: ["profile"],
      userId: "user_test",
    };
    return mcpHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
