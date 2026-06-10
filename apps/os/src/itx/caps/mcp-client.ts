// McpClient: the first-party MCP client capability (itx-next.md §1).
//
// MCP is not a transport in the capability model — it is a client
// IMPLEMENTATION, i.e. an ordinary RPC target. This entrypoint is the
// first-party half of the litmus test: registered via a loopback ref and
// parameterized per server by props, it must have NO powers a user-space
// equivalent (the same class exported from a project worker) couldn't have.
//
//   await itx.caps.define({
//     invoke: "path-call",
//     name: "docs",
//     target: {
//       type: "rpc",
//       worker: { type: "loopback" },
//       entrypoint: "McpClient",
//       props: {
//         serverUrl: "https://docs.example.com/mcp",
//         headers: { authorization: 'Bearer getSecret({ key: "DOCS_TOKEN" })' },
//       },
//     },
//   });
//
//   await itx.docs.listTools();
//   await itx.docs.someToolName({ ...args });
//
// Every HTTP request to the MCP server goes through PROJECT EGRESS via this
// cap's own itx handle (Law 5): secret placeholders in `headers` are
// substituted inside the Project DO and never exist in this isolate.
//
// Deliberately stateless: connect → call → close, per invocation. The old
// OutboundMcpFromOurClientCapability cached the connection in a Durable
// Object; when per-call handshake latency matters, the same class becomes a
// `durable-object` ref (or a stored-source DO cap) without changing callers.

import { WorkerEntrypoint } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveItx } from "../entrypoint.ts";
import type { ItxRuntime } from "../handle.ts";
import type { PathCall } from "../protocol.ts";
import {
  describeOutboundMcpFromOurClientTools,
  executeOutboundMcpFromOurClientToolFunction,
} from "~/domains/outbound-mcp-client/utils/outbound-mcp-from-our-client-capability-core.ts";

export type McpClientProps = {
  /** The remote MCP server (streamable HTTP). Definer-supplied. */
  serverUrl: string;
  /** Sent on every request; values pass through egress secret substitution. */
  headers?: Record<string, string>;
  /** Attribution, injected by the registry at dial time. */
  cap?: string;
  context?: string;
};

export class McpClient extends WorkerEntrypoint<Env, McpClientProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    if (!props.serverUrl) {
      throw new Error("McpClient needs props.serverUrl (the remote MCP server).");
    }
    if (!props.context) {
      // The registry always injects context; refusing without it means this
      // client can never fetch outside the egress pipe.
      throw new Error("McpClient needs context attribution to route egress.");
    }

    const itx = await resolveItx({
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      props: { cap: props.cap, context: props.context },
    });

    const transport = new StreamableHTTPClientTransport(new URL(props.serverUrl), {
      // ALL transport HTTP rides the project egress pipe — this is where
      // getSecret() placeholders in headers become real credentials. Build a
      // real Request first: the SDK may pass a URL (which itx.fetch would not
      // stringify) or a Request plus separate init (whose headers must merge
      // before egress sees them).
      fetch: (fetchInput: Request | string | URL, init?: RequestInit) =>
        itx.fetch(
          fetchInput instanceof Request
            ? new Request(fetchInput, init)
            : new Request(String(fetchInput), init),
        ),
      requestInit: props.headers ? { headers: props.headers } : undefined,
    });
    const client = new Client({ name: "itx-mcp-client", version: "1.0.0" });

    try {
      // Inside the try so a failed connect still runs close() — a partial
      // handshake can otherwise leave server-side session state dangling.
      await client.connect(transport);
      if (input.path.join(".") === "listTools") {
        const listed = await client.listTools();
        return describeOutboundMcpFromOurClientTools(
          listed.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          })),
        );
      }
      return await executeOutboundMcpFromOurClientToolFunction({
        args: input.args,
        client,
        path: input.path,
      });
    } finally {
      await client.close().catch(() => {});
    }
  }
}
