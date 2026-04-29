import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/**
 * MCP connection as a separate DO.
 *
 * AgentLoop and Codemode should not own live MCP connections as in-memory
 * runtime state. They should consume stream events describing desired
 * connections, and an MCPConnection DO should own the actual sockets/HTTP
 * clients.
 */

export type MCPConnectionProps = {
  connectionId: string;
};

export class MCPConnection extends DurableObject {
  #connected = false;

  async connect(args: { serverUrl: string; headers?: Record<string, string> }) {
    /**
     * Real implementation:
     * - open MCP transport
     * - store connection metadata in DO state
     * - expose tool list
     */
    this.#connected = true;
    return { ok: true, serverUrl: args.serverUrl };
  }

  async listTools() {
    if (!this.#connected) return { tools: [] };
    return {
      tools: [
        {
          name: "example.echo",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    };
  }

  async callTool(args: { name: string; input: unknown }) {
    if (!this.#connected) throw new Error("MCP connection is not connected.");
    return { name: args.name, input: args.input };
  }
}

/**
 * WorkerEntrypoint facade that Codemode can receive as a tool provider
 * callable/binding. This lets Codemode treat MCP as just another provider.
 */
export class MCPToolProvider extends WorkerEntrypoint<Env, MCPConnectionProps> {
  async getTypes() {
    const connection = this.getConnection();
    const { tools } = await connection.listTools();
    return {
      types: tools.map((tool) => `  ${tool.name}(input: unknown): Promise<unknown>;`).join("\n"),
    };
  }

  async execute(args: { toolName: string; input: unknown }) {
    return this.getConnection().callTool({
      name: args.toolName,
      input: args.input,
    });
  }

  private getConnection(): DurableObjectStub<MCPConnection> {
    const id = this.env.MCP_CONNECTION.idFromName(this.ctx.props.connectionId);
    return this.env.MCP_CONNECTION.get(id);
  }
}

/**
 * Stream events still matter:
 *
 * - `mcp-connection-configured`
 * - `mcp-connection-ready`
 * - `tool-provider-config-updated`
 *
 * The MCP DO owns live sockets. Codemode owns only a reduced view of available
 * providers and uses provider callables to execute.
 */
