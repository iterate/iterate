import { SELF, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { getInitializedStreamStub } from "@iterate-com/shared/streams/helpers";
import { describe, expect, test } from "vitest";

type TestEnv = {
  STREAM: Env["STREAM"];
};

const projectId = "proj__test__inboundmcp";

describe("ProjectMcpServerConnection inbound MCP", () => {
  test("runs code through CodemodeSession and appends events to the MCP session stream", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp-project.iterate-preview-test.app/mcp"),
      {
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
      },
    );
    const client = new Client({ name: "mcp-client-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "run_code" }),
          expect.objectContaining({ name: "reveal_secret" }),
        ]),
      });

      const result = await client.callTool({
        name: "run_code",
        arguments: {
          code: `async (ctx) => {
  const message = \`hello from \${"inbound mcp"}\`;
  console.log(message);
  return { message, value: 6 * 7 };
}`,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(extractTextContent(result.content).join("\n")).toContain('"value": 42');
      expect(extractTextContent(result.content).join("\n")).toContain(
        '"message": "hello from inbound mcp"',
      );
      expect(extractTextContent(result.content).join("\n")).toContain("hello from inbound mcp");

      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();

      const streamPath = StreamPath.parse(
        `/projects/${projectId}/mcp-server-sessions/mcp-client-e2e-${slugifySegment(
          sessionId ?? "",
        ).slice(-12)}`,
      );
      const events = await readCurrentStreamEvents(streamPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "events.iterate.com/mcp-server/tool-invocation-started",
            payload: expect.objectContaining({
              projectId: "proj__test__inboundmcp",
              streamPath,
              toolName: "run_code",
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/script-execution-requested",
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/log-emitted",
            payload: expect.objectContaining({
              message: "hello from inbound mcp",
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/script-execution-completed",
            payload: expect.objectContaining({
              outcome: {
                status: "succeeded",
                output: { message: "hello from inbound mcp", value: 42 },
              },
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/mcp-server/tool-invocation-finished",
            payload: expect.objectContaining({
              projectId: "proj__test__inboundmcp",
              streamPath,
              toolName: "run_code",
            }),
          }),
        ]),
      );
    } finally {
      await closeMcpClient({ client, transport });
    }
  });

  test("auto-loads static codemode tool providers for run_code", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp-project.iterate-preview-test.app/mcp"),
      {
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
      },
    );
    const client = new Client({ name: "mcp-provider-matrix-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      const result = await client.callTool({
        name: "run_code",
        arguments: {
          code: `async (ctx) => {
  const operations = await ctx.integrations.http.catalog.listOperations();
  const mcpTools = await ctx.integrations.publicMcp.listTools();
  const echo = await ctx.integrations.publicMcp["echo.text"]({ text: "hello static MCP" });
  const agentHandle = await ctx.createSubagent();

  const [pet, workspace, agent, pipelinedAgent, composed] = await Promise.all([
    ctx.integrations.http.catalog.getPet({ petId: "fido", include: "owner" }),
    ctx.workspace.proofOfConcept({ message: "workspace from inbound MCP" }),
    agentHandle.sendMessage({ message: "hi", subPath: "mcp" }),
    ctx.makeSubagent().doThing({ label: "promise-pipeline", value: 21 }),
    ctx.integrations.builtinMatrix.compose({
      petId: "otto",
      text: "composition",
      value: 21,
    }),
  ]);
  agentHandle[Symbol.dispose]?.();

  return {
    agent,
    composed,
    echo,
    mcpToolNames: mcpTools.tools.map((tool) => tool.name),
    operationIds: operations.map((operation) => operation.operationId),
    pet,
    pipelinedAgent,
    workspace,
  };
}`,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(parseRunCodeResult(result.content)).toMatchObject({
        agent: { message: "hi", subPath: "mcp" },
        composed: {
          echo: { echoed: "provider saw composition", provider: "public-mcp" },
          leaf: { provider: "leaf", value: 42 },
          pet: { include: "owner", name: "Pet OTTO", petId: "otto", provider: "openapi" },
          provider: "builtin-matrix",
        },
        echo: { echoed: "hello static MCP", provider: "public-mcp" },
        mcpToolNames: ["echo.text"],
        operationIds: ["getPet"],
        pet: { include: "owner", name: "Pet FIDO", petId: "fido", provider: "openapi" },
        pipelinedAgent: { doubled: 42, label: "promise-pipeline", value: 21 },
        workspace: { message: "workspace from inbound MCP" },
      });

      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const streamPath = mcpSessionStreamPath("mcp-provider-matrix-e2e", sessionId ?? "");

      const events = await readCurrentStreamEvents(streamPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "events.iterate.com/codemode/tool-provider-registered",
            payload: expect.objectContaining({
              path: ["integrations", "http", "catalog"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/tool-provider-registered",
            payload: expect.objectContaining({
              path: ["integrations", "publicMcp"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/function-call-requested",
            payload: expect.objectContaining({
              invocationKind: "rpc",
              path: ["integrations", "builtinMatrix", "compose"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/function-call-requested",
            payload: expect.objectContaining({
              invocationKind: "rpc",
              path: ["makeSubagent"],
              providerPath: ["makeSubagent"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/function-call-completed",
            payload: expect.objectContaining({
              invocationKind: "rpc",
              outcome: expect.objectContaining({
                status: "returned",
                value: { kind: "live-value", type: "function" },
              }),
              path: ["makeSubagent"],
              providerPath: ["makeSubagent"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/script-execution-completed",
            payload: expect.objectContaining({
              outcome: expect.objectContaining({
                output: expect.objectContaining({
                  agent: expect.objectContaining({ message: "hi", subPath: "mcp" }),
                  pet: expect.objectContaining({ petId: "fido", provider: "openapi" }),
                  pipelinedAgent: expect.objectContaining({
                    doubled: 42,
                    label: "promise-pipeline",
                  }),
                }),
                status: "succeeded",
              }),
            }),
          }),
        ]),
      );
    } finally {
      await closeMcpClient({ client, transport });
    }
  });
});

async function closeMcpClient(input: { client: Client; transport: StreamableHTTPClientTransport }) {
  // The MCP Streamable HTTP client separates "terminate the remote MCP session"
  // from "close this local client transport". Terminating first sends DELETE
  // with the session id, which lets the agents/mcp Durable Object bridge destroy
  // its session before the worker-pool runtime starts tearing down.
  await input.transport.terminateSession().catch(() => undefined);
  await input.client.close();
}

function extractTextContent(content: unknown) {
  if (!Array.isArray(content)) return [];

  return content.flatMap((item) =>
    item != null &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "text" &&
    "text" in item &&
    typeof item.text === "string"
      ? [item.text]
      : [],
  );
}

async function readCurrentStreamEvents(streamPath: StreamPath) {
  const stream = await getInitializedStreamStub({
    namespace: (env as TestEnv).STREAM,
    projectId,
    path: streamPath,
  });
  const events = await stream.history({ before: "end" });
  try {
    // Worker-pool tests exercise real Cloudflare RPC semantics. Even plain
    // object/array results can carry a client-side RPC disposer, so clone the
    // serializable event list for assertions and then dispose the RPC result.
    // Docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    return structuredClone(events);
  } finally {
    disposeRpcResult(events);
  }
}

function mcpSessionStreamPath(clientName: string, sessionId: string) {
  return StreamPath.parse(
    `/projects/${projectId}/mcp-server-sessions/${slugifySegment(
      clientName,
    )}-${slugifySegment(sessionId).slice(-12)}`,
  );
}

function parseRunCodeResult(content: unknown) {
  const text = extractTextContent(content).join("\n");
  const marker = "Result: ";
  const index = text.indexOf(marker);
  if (index === -1) throw new Error(`run_code result did not contain "${marker}": ${text}`);
  return JSON.parse(text.slice(index + marker.length));
}

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function disposeRpcResult(value: unknown) {
  if (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof value[Symbol.dispose] === "function"
  ) {
    value[Symbol.dispose]();
  }
}
