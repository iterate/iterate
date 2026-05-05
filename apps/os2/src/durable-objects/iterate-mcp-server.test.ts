import { SELF, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamPath } from "@iterate-com/events-contract";
import { type Event, type EventInput } from "@iterate-com/events-contract";
import { describe, expect, test } from "vitest";
import { createEventsClient } from "~/lib/events-client.ts";

type TestEnv = {
  EVENTS_BASE_URL: string;
};

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
        `/projects/proj__test__inboundmcp/mcp-server-sessions/mcp-client-e2e-${slugifySegment(
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
      await client.close();
    }
  });

  test("registers tool provider documentation supplied to run_code", async () => {
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
  return { providersAreDocumentation: true };
}`,
          events: providerDocumentationEvents(),
        },
      });

      expect(result.isError).not.toBe(true);
      expect(parseRunCodeResult(result.content)).toEqual({ providersAreDocumentation: true });

      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const streamPath = mcpSessionStreamPath("mcp-provider-matrix-e2e", sessionId ?? "");

      const events = await readCurrentStreamEvents(streamPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "events.iterate.com/codemode/tool-provider-registered",
            payload: expect.objectContaining({
              docs: expect.stringContaining("Slack"),
              path: ["slack"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/script-execution-completed",
            payload: expect.objectContaining({
              outcome: { status: "succeeded", output: { providersAreDocumentation: true } },
            }),
          }),
        ]),
      );
    } finally {
      await client.close();
    }
  });
});

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
  const client = createEventsClient((env as TestEnv).EVENTS_BASE_URL);
  const stream = await client.stream(
    {
      beforeOffset: "end",
      path: streamPath,
    },
    {
      signal: AbortSignal.timeout(10_000),
    },
  );

  const events: Event[] = [];
  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function mcpSessionStreamPath(clientName: string, sessionId: string) {
  return StreamPath.parse(
    `/projects/proj__test__inboundmcp/mcp-server-sessions/${slugifySegment(
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

function providerDocumentationEvents(): EventInput[] {
  return [
    {
      type: "events.iterate.com/codemode/tool-provider-registered",
      payload: {
        docs: "Slack functions are available under ctx.slack.",
        path: ["slack"],
        typeDefinitions:
          "declare const slack: { messages: { send(input: { text: string }): Promise<void> } };",
      },
    },
  ];
}

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
