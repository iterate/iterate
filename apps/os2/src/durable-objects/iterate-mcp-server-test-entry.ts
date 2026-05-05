import { McpAgent } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import { DESCRIBE_TOOL_FUNCTION_NAME } from "@iterate-com/shared/codemode/types";
import type { ProjectMcpServerConnectionProps } from "./project-mcp-server-connection.ts";

export { CodemodeSession } from "./codemode-session.ts";
export { ProjectMcpServerConnection } from "./project-mcp-server-connection.ts";
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";

const mcpHandler = McpAgent.serve("/mcp", { binding: "PROJECT_MCP_SERVER_CONNECTION" });

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  path: string[];
  input: Record<string, unknown>;
};

export class TestBuiltinMatrixProvider extends WorkerEntrypoint {
  async executeToolFunction(input: ToolFunctionInput) {
    const path = input.path.join(".");
    if (path === DESCRIBE_TOOL_FUNCTION_NAME) {
      return { typeDefinitions: "{ compose(input: Record<string, unknown>): Promise<unknown>; }" };
    }

    if (path !== "compose") {
      throw new Error(`TestBuiltinMatrixProvider does not implement ${path}`);
    }

    const ctx = createCodemodeContext({
      codemodeSessionCapability: input.codemodeSessionCapability,
    });
    const pet = await ctx.integrations.http.catalog.getPet({
      include: "owner",
      petId: input.input.petId,
    });
    const echo = await ctx.integrations.publicMcp["echo.text"]({
      text: `provider saw ${String(input.input.text)}`,
    });
    const leaf = await ctx.leaf({
      value: input.input.value,
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
  async executeToolFunction(input: ToolFunctionInput) {
    if (input.path.length === 1 && input.path[0] === DESCRIBE_TOOL_FUNCTION_NAME) {
      return { typeDefinitions: "(input: { value: number }): Promise<{ value: number }>" };
    }

    if (input.path.length > 0) {
      throw new Error(`TestLeafProvider expected leaf call, got ${input.path.join(".")}`);
    }

    return {
      provider: "leaf",
      toolFunctionPath: input.path,
      value: Number(input.input.value) * 2,
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
