import { McpAgent } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import type { IterateMcpServerProps } from "./iterate-mcp-server.ts";

export { CodemodeSession } from "./codemode-session.ts";
export { IterateMcpServer } from "./iterate-mcp-server.ts";
export { McpClientBridge } from "~/rpc-targets/mcp-client-bridge.ts";
export { OpenApiBridge } from "~/rpc-targets/openapi-bridge.ts";

const mcpHandler = McpAgent.serve("/mcp", { binding: "ITERATE_MCP_SERVER" });

type ToolFunctionInput = {
  codemodeSessionCapability: Parameters<
    typeof createCodemodeContext
  >[0]["codemodeSessionCapability"];
  path: string[];
  payload: Record<string, unknown>;
};

export class TestBuiltinMatrixProvider extends WorkerEntrypoint {
  async executeToolFunction(input: ToolFunctionInput) {
    const path = input.path.join(".");
    if (path !== "compose") {
      throw new Error(`TestBuiltinMatrixProvider does not implement ${path}`);
    }

    const ctx = createCodemodeContext({
      codemodeSessionCapability: input.codemodeSessionCapability,
    });
    const pet = await ctx.integrations.http.catalog.getPet({
      include: "owner",
      petId: input.payload.petId,
    });
    const echo = await ctx.integrations.publicMcp["echo.text"]({
      text: `provider saw ${String(input.payload.text)}`,
    });
    const leaf = await ctx.leaf({
      value: input.payload.value,
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
    if (input.path.length > 0) {
      throw new Error(`TestLeafProvider expected leaf call, got ${input.path.join(".")}`);
    }

    return {
      provider: "leaf",
      toolFunctionPath: input.path,
      value: Number(input.payload.value) * 2,
    };
  }
}

export default {
  fetch(request, env, ctx) {
    const ctxWithProps = ctx as ExecutionContext & { props?: IterateMcpServerProps };
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
