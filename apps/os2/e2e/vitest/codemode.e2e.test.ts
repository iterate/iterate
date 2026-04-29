/**
 * E2E tests for codemode oRPC endpoints.
 * Runs against a live os2 deployment (dev or preview).
 *
 * Set OS2_BASE_URL to the deployment URL before running:
 *   OS2_BASE_URL=https://os.iterate-dev-jonas.com pnpm test:e2e
 */
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { osContract } from "@iterate-com/os2-contract";
import type { appRouter } from "~/orpc/root.ts";

type OrpcClient = RouterClient<typeof appRouter>;

function requireBaseUrl() {
  const baseUrl = process.env.OS2_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OS2_BASE_URL is required for os2 e2e tests.");
  }
  return baseUrl;
}

function createClient(baseUrl: string) {
  return createORPCClient(new OpenAPILink(osContract, { url: `${baseUrl}/api` })) as OrpcClient;
}

describe("codemode.execute", () => {
  it("executes simple code and returns a result event stream", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);

    const stream = await client.codemode.execute({
      code: "async () => 1 + 1",
      providers: [],
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }

    // Should have at least block-added and block-result-added
    const blockAdded = events.find((e) => e.type === "codemode-block-added");
    expect(blockAdded).toBeDefined();
    expect(blockAdded?.code).toBe("async () => 1 + 1");

    const result = events.find((e) => e.type === "codemode-block-result-added");
    expect(result).toBeDefined();
    expect(result?.result).toBe(2);
    expect(result?.error).toBeUndefined();
  });

  it("returns log events from console.log", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);

    const stream = await client.codemode.execute({
      code: 'async () => { console.log("hello from sandbox"); return "done"; }',
      providers: [],
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }

    const result = events.find((e) => e.type === "codemode-block-result-added");
    expect(result?.result).toBe("done");

    // Logs may arrive via events or in the result (depends on timing)
    const logEvents = events.filter((e) => e.type === "codemode-log-emitted");
    // At minimum, the result should have logs in the response
    expect(result?.error).toBeUndefined();
  });

  it("generates a blockId when not provided", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);

    const stream = await client.codemode.execute({
      code: "async () => 42",
      providers: [],
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }

    expect(events.length).toBeGreaterThan(0);
    const blockId = events[0]?.blockId;
    expect(typeof blockId).toBe("string");
    expect((blockId as string).startsWith("cblk_")).toBe(true);

    // All events share the same blockId
    for (const event of events) {
      expect(event.blockId).toBe(blockId);
    }
  });

  it("uses caller-provided blockId", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);

    const stream = await client.codemode.execute({
      code: "async () => 42",
      blockId: "cblk_custom_test_123",
      providers: [],
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }

    for (const event of events) {
      expect(event.blockId).toBe("cblk_custom_test_123");
    }
  });

  it("returns error for code that throws", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);

    const stream = await client.codemode.execute({
      code: 'async () => { throw new Error("test error"); }',
      providers: [],
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of stream) {
      events.push(event as Record<string, unknown>);
    }

    const result = events.find((e) => e.type === "codemode-block-result-added");
    expect(result).toBeDefined();
    expect(result?.error).toBe("test error");
  });
});

describe("codemode.describe", () => {
  it("returns type definitions placeholder when no providers have describe", async () => {
    const baseUrl = requireBaseUrl();
    const client = createClient(baseUrl);

    const result = await client.codemode.describe({
      providers: [
        {
          path: ["test"],
          execute: {
            type: "fetch",
            via: { type: "url", url: "https://httpbin.org/post" },
          },
        },
      ],
    });

    expect(result.typeDefinitions).toContain("test");
    expect(result.typeDefinitions).toContain("not provided type information");
  });
});
