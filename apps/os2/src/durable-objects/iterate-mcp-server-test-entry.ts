import { McpAgent } from "agents/mcp";
import { WorkerEntrypoint } from "cloudflare:workers";
import { createCodemodeContext } from "@iterate-com/shared/codemode/context-proxy";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import type { ProjectMcpServerConnectionProps } from "./project-mcp-server-connection.ts";

export { CodemodeSession } from "./codemode-session.ts";
export { ProjectMcpServerConnection } from "./project-mcp-server-connection.ts";
export {
  AgentCapability,
  AgentDurableObject,
  AiCapability,
  OrpcCapability,
  RepoCapability,
  RepoDurableObject,
  SlackCapability,
  WorkspaceDurableObject,
} from "~/codemode/example-capabilities.ts";
export { FetchCapability } from "~/codemode/fetch-capability.ts";
export { StreamsCapability } from "~/entrypoints/stream-capability.ts";
export { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
export { OutboundMcpFromOurClientCapability } from "~/rpc-targets/outbound-mcp-from-our-client-capability.ts";
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
    const echo = await ctx.integrations.publicMcp["echo.text"]({
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
