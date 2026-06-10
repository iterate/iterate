import { SELF, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { describe, expect, test } from "vitest";
import { getInitializedStreamStub } from "~/domains/streams/stream-runtime.ts";

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

      const execJsTool = findExecJsTool(await client.listTools());
      expect(execJsTool.inputSchema).toMatchObject({
        properties: expect.not.objectContaining({ project: expect.anything() }),
      });

      const result = await client.callTool({
        name: "exec_js",
        arguments: {
          code: `async (itx) => {
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
        `/mcp-server-sessions/mcp-client-e2e-${slugifySegment(sessionId ?? "").slice(-12)}`,
      );
      const events = await readCurrentStreamEvents(streamPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "events.iterate.com/mcp-server/tool-invocation-started",
            payload: expect.objectContaining({
              projectId: "proj__test__inboundmcp",
              streamPath,
              toolName: "exec_js",
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/itx/execution-requested",
          }),
          expect.objectContaining({
            type: "events.iterate.com/itx/execution-completed",
            payload: expect.objectContaining({
              logs: expect.arrayContaining([expect.stringContaining("hello from inbound mcp")]),
              ok: true,
              result: { message: "hello from inbound mcp", value: 42 },
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/mcp-server/tool-invocation-finished",
            payload: expect.objectContaining({
              projectId: "proj__test__inboundmcp",
              streamPath,
              toolName: "exec_js",
            }),
          }),
        ]),
      );
    } finally {
      await closeMcpClient({ client, transport });
    }
  });

  test("requires a literal project slug when OAuth grants multiple projects", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://os.iterate.test/mcp?mode=multi"),
      {
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
      },
    );
    const client = new Client({ name: "mcp-multi-project-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      const execJsTool = findExecJsTool(await client.listTools());
      expect(execJsTool.inputSchema).toMatchObject({
        properties: {
          project: {
            enum: ["mcp-project", "other-project"],
            type: "string",
          },
        },
        required: expect.arrayContaining(["code", "project"]),
      });

      const result = await client.callTool({
        name: "exec_js",
        arguments: {
          project: "other-project",
          code: `async () => ({ project: "other-project" })`,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(parseRunCodeResult(result.content)).toEqual({ project: "other-project" });

      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const streamPath = mcpSessionStreamPath("mcp-multi-project-e2e", sessionId ?? "");
      const events = await readCurrentStreamEvents(streamPath, "proj__test__other");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "events.iterate.com/mcp-server/tool-invocation-started",
            payload: expect.objectContaining({
              projectId: "proj__test__other",
              projectSlug: "other-project",
            }),
          }),
        ]),
      );
    } finally {
      await closeMcpClient({ client, transport });
    }
  });

  test("requires project even for admin-token MCP sessions", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL("https://os.iterate.test/mcp?mode=admin"),
      {
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
      },
    );
    const client = new Client({ name: "mcp-admin-project-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      const execJsTool = findExecJsTool(await client.listTools());
      expect(execJsTool.inputSchema).toMatchObject({
        properties: {
          project: {
            enum: ["mcp-project", "other-project"],
            type: "string",
          },
        },
        required: expect.arrayContaining(["code", "project"]),
      });

      const missingProjectResult = await client.callTool({
        name: "exec_js",
        arguments: {
          code: `async () => ({ ok: true })`,
        },
      });
      expect(missingProjectResult.isError).toBe(true);
      expect(extractTextContent(missingProjectResult.content).join("\n")).toContain(
        "Invalid arguments for tool exec_js",
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

async function readCurrentStreamEvents(streamPath: StreamPath, namespace = projectId) {
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: (env as TestEnv).STREAM,
    namespace,
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

function findExecJsTool(response: Awaited<ReturnType<Client["listTools"]>>) {
  const tool = response.tools.find((candidate) => candidate.name === "exec_js");
  if (!tool) throw new Error("exec_js tool not found");
  return tool;
}

function mcpSessionStreamPath(clientName: string, sessionId: string) {
  return StreamPath.parse(
    `/mcp-server-sessions/${slugifySegment(clientName)}-${slugifySegment(sessionId).slice(-12)}`,
  );
}

function parseRunCodeResult(content: unknown) {
  const text = extractTextContent(content).join("\n");
  const marker = "Result: ";
  const index = text.indexOf(marker);
  if (index === -1) throw new Error(`exec_js result did not contain "${marker}": ${text}`);
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
