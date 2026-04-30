import { SELF, env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamPath } from "@iterate-com/events-contract";
import { type Event, type EventInput } from "@iterate-com/events-contract";
import { createEventsClient } from "~/lib/events-client.ts";
import { describe, expect, test } from "vitest";

type TestEnv = {
  EVENTS_BASE_URL: string;
  MOCK_PROVIDER_BASE_URL: string;
};

describe("IterateMcpServer inbound MCP", () => {
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
  await ctx.codemode.append({
    type: "events.iterate.com/codemode/test-note",
    payload: { source: "inbound-mcp-e2e" },
  });
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
            type: "events.iterate.com/codemode/test-note",
            payload: { source: "inbound-mcp-e2e" },
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/script-execution-finished",
            payload: expect.objectContaining({
              result: { message: "hello from inbound mcp", value: 42 },
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

  test("runs code through builtin, OpenAPI, MCP-client, nested, and leaf providers", async () => {
    const baseUrl = (env as TestEnv).MOCK_PROVIDER_BASE_URL;

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
  const directOpenApi = await ctx.integrations.http.catalog.getPet({
    include: "owner",
    petId: "pet-7",
  });
  const directMcp = await ctx.integrations.publicMcp["echo.text"]({
    text: "hello from script",
  });
  const leaf = await ctx.leaf({ value: 21 });
  const composed = await ctx.builtin.matrix.compose({
    petId: "pet-9",
    text: "hello from provider",
    value: 11,
  });

  return {
    composed,
    directMcp,
    directOpenApi,
    leaf,
    streamPath: await ctx.codemode.getStreamPath(),
  };
}`,
          events: providerMatrixEvents({
            baseUrl,
            mcpServerUrl: `${baseUrl}/mcp`,
          }),
        },
      });

      expect(result.isError).not.toBe(true);
      const output = parseRunCodeResult(result.content) as {
        composed: {
          echo: { echoed: string; provider: string };
          leaf: { value: number };
          pet: { name: string; petId: string; provider: string };
          provider: string;
          route: string;
        };
        directMcp: { echoed: string; provider: string };
        directOpenApi: { name: string; petId: string; provider: string };
        leaf: { provider: string; toolFunctionPath: string[]; value: number };
        streamPath: string;
      };

      expect(output).toMatchObject({
        composed: {
          echo: {
            echoed: "provider saw hello from provider",
            provider: "public-mcp",
          },
          leaf: { value: 22 },
          pet: {
            name: "Pet PET-9",
            petId: "pet-9",
            provider: "openapi",
          },
          provider: "builtin-matrix",
          route: "codemode-session-capability",
        },
        directMcp: {
          echoed: "hello from script",
          provider: "public-mcp",
        },
        directOpenApi: {
          name: "Pet PET-7",
          petId: "pet-7",
          provider: "openapi",
        },
        leaf: {
          provider: "leaf",
          toolFunctionPath: [],
          value: 42,
        },
      });

      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const streamPath = mcpSessionStreamPath("mcp-provider-matrix-e2e", sessionId ?? "");
      expect(output.streamPath).toBe(streamPath);

      const events = await readCurrentStreamEvents(streamPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "events.iterate.com/codemode/tool-provider-registered",
            payload: expect.objectContaining({
              path: ["builtin", "matrix"],
            }),
          }),
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
            type: "events.iterate.com/codemode/tool-provider-registered",
            payload: expect.objectContaining({
              path: ["leaf"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/tool-function-call-requested",
            payload: expect.objectContaining({
              path: ["leaf"],
              providerPath: ["leaf"],
              toolFunctionPath: [],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/tool-function-call-requested",
            payload: expect.objectContaining({
              path: ["integrations", "publicMcp", "echo.text"],
              providerPath: ["integrations", "publicMcp"],
              toolFunctionPath: ["echo.text"],
            }),
          }),
          expect.objectContaining({
            type: "events.iterate.com/codemode/script-execution-finished",
            payload: expect.objectContaining({
              result: expect.objectContaining({
                leaf: expect.objectContaining({ value: 42 }),
              }),
            }),
          }),
        ]),
      );

      const har = (await fetch(`${baseUrl}/__har`).then((response) => response.json())) as {
        log: {
          entries: Array<{
            request: { postData?: { text?: string }; url: string };
          }>;
        };
      };
      expect(har.log.entries.map((entry) => new URL(entry.request.url).pathname)).toEqual(
        expect.arrayContaining(["/openapi.json", "/pets/pet-7", "/pets/pet-9", "/mcp"]),
      );
      expect(
        har.log.entries.some(
          (entry) =>
            new URL(entry.request.url).pathname === "/mcp" &&
            entry.request.postData?.text?.includes("tools/call"),
        ),
      ).toBe(true);
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

function providerMatrixEvents(input: { baseUrl: string; mcpServerUrl: string }): EventInput[] {
  return [
    toolProviderRegisteredEvent({
      path: ["builtin", "matrix"],
      callable: workersRpcCallable({
        bindingName: "BUILTIN_MATRIX_PROVIDER",
        bindingType: "service",
      }),
    }),
    toolProviderRegisteredEvent({
      path: ["integrations", "http", "catalog"],
      callable: workersRpcCallable({
        bindingName: "OPENAPI_BRIDGE",
        bindingType: "service",
        providerProps: {
          baseUrl: input.baseUrl,
          specUrl: `${input.baseUrl}/openapi.json`,
        },
      }),
    }),
    toolProviderRegisteredEvent({
      path: ["integrations", "publicMcp"],
      callable: {
        rpcMethod: "executeToolFunction",
        type: "workers-rpc",
        via: {
          bindingName: "MCP_CLIENT_BRIDGE",
          bindingType: "durable-object-namespace",
          durableObject: { name: input.mcpServerUrl },
          type: "env-binding",
        },
      },
    }),
    toolProviderRegisteredEvent({
      path: ["leaf"],
      callable: workersRpcCallable({
        bindingName: "LEAF_PROVIDER",
        bindingType: "service",
      }),
    }),
  ];
}

function toolProviderRegisteredEvent(provider: Record<string, unknown>): EventInput {
  return {
    type: "events.iterate.com/codemode/tool-provider-registered",
    payload: {
      descriptor: provider,
      path: provider.path,
    },
  };
}

function workersRpcCallable(input: {
  bindingName: string;
  bindingType: "service";
  providerProps?: Record<string, unknown>;
}) {
  return {
    rpcMethod: "executeToolFunction",
    type: "workers-rpc",
    via: {
      bindingName: input.bindingName,
      bindingType: input.bindingType,
      type: "env-binding",
    },
    ...(input.providerProps
      ? {
          transformInput: {
            shallowMerge: {
              providerProps: input.providerProps,
            },
          },
        }
      : {}),
  };
}

function slugifySegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
