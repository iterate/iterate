// McpClient: the first-party MCP client capability (itx-next.md §1).
//
// MCP is not a transport in the capability model — it is a client
// IMPLEMENTATION, i.e. an ordinary RPC target. This entrypoint is the
// first-party half of the litmus test: registered via a loopback ref and
// parameterized per server by props, it must have NO powers a user-space
// equivalent (the same class exported from a project worker) couldn't have.
//
//   await itx.provideCapability({
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
// MCP's streamable HTTP transport is STATELESS — it is fetch with metadata.
// Connect → call → close, per invocation; there is no session state worth
// keeping, and deliberately no Durable Object anywhere in this path.

import { WorkerEntrypoint } from "cloudflare:workers";
import { resolveItx } from "../entrypoint.ts";
import type { ItxRuntime } from "../handle.ts";
import type { PathCall } from "../itx.ts";
import { connectMcp, executeMcpToolCall, listMcpTools } from "./mcp-client-core.ts";

export type McpClientProps = {
  /** The remote MCP server (streamable HTTP). Provider-supplied. */
  serverUrl: string;
  /** Sent on every request; values pass through egress secret substitution. */
  headers?: Record<string, string>;
  /** Per-request deadline forwarded to the MCP SDK (its default is 60s);
   * raise it for genuinely slow servers. Provider-supplied. */
  timeoutMs?: number;
  /** Attribution, injected by the dial. */
  capabilityPath?: string;
  context?: string;
};

export class McpClient extends WorkerEntrypoint<Env, McpClientProps> {
  async call(input: PathCall): Promise<unknown> {
    const props = this.ctx.props;
    if (!props.serverUrl) {
      throw new Error("McpClient needs props.serverUrl (the remote MCP server).");
    }
    if (!props.context) {
      // The dial always injects context; refusing without it means this
      // client can never fetch outside the egress pipe.
      throw new Error("McpClient needs context attribution to route egress.");
    }
    if (input.path.join(".") === "describeItx") {
      // The core's provide-time self-description probe (itx.ts). An MCP
      // surface is dynamic — listTools is the discovery door — so there is
      // nothing static to answer; returning empty keeps the probe from
      // becoming a real network tool call.
      return {};
    }

    const itx = await resolveItx({
      env: this.env,
      exports: this.ctx.exports as unknown as ItxRuntime["exports"],
      props: { capabilityPath: props.capabilityPath, context: props.context },
    });

    const options = props.timeoutMs ? { timeout: props.timeoutMs } : undefined;
    const client = await connectMcp({
      // ALL transport HTTP rides the project egress pipe — this is where
      // getSecret() placeholders in headers become real credentials. Build a
      // real Request first: the SDK may pass a URL (which itx.fetch would not
      // stringify) or a Request plus separate init (whose headers must merge
      // before egress sees them). The handle's fetch — the one egress door —
      // strips the SDK's per-request AbortSignal; nothing transport-specific
      // is handled here.
      fetch: (fetchInput: Request | string | URL, init?: RequestInit) => {
        const request =
          fetchInput instanceof Request
            ? new Request(fetchInput, init)
            : new Request(String(fetchInput), init);
        // The transport's standalone GET (the server-push SSE channel) is
        // useless in this stateless connect → call → close client and would
        // pin a long-lived stream through the egress chain for every call —
        // answer it locally with the spec's "not offered" status, which the
        // SDK handles as the expected no-stream case.
        if (request.method === "GET") {
          return Promise.resolve(new Response(null, { status: 405 }));
        }
        return itx.fetch(request);
      },
      headers: props.headers,
      requestOptions: options,
      serverUrl: props.serverUrl,
    });

    try {
      if (input.path.join(".") === "listTools") {
        return await listMcpTools(client, options);
      }
      return await executeMcpToolCall({
        args: input.args,
        client,
        options,
        path: input.path,
      });
    } finally {
      await client.close().catch(() => {});
    }
  }
}
