import { describe, expect, test, vi } from "vitest";
import { createOpenApiToolProvider } from "./openapi-tool-provider.ts";

vi.mock("@cloudflare/codemode", () => ({
  generateTypesFromJsonSchema: (descriptors: Record<string, unknown>) => {
    const methods = Object.keys(descriptors)
      .map((name) => `  ${name}(args: object): Promise<unknown>;`)
      .join("\n");
    return `declare const codemode: {\n${methods}\n};`;
  },
}));

const openApiSpec = {
  openapi: "3.1.1",
  paths: {
    "/streams/{path}": {
      post: {
        operationId: "appendStreamEvents",
        parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { event: { type: "object" } },
                required: ["event"],
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
      },
      delete: {
        operationId: "destroyStream",
        parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/streams/__state/{path}": {
      get: {
        operationId: "getStreamState",
        parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/secrets": {
      get: {
        operationId: "secrets.list",
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

describe("createOpenApiToolProvider", () => {
  test("limits generated tools and types by operationId", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    });

    const provider = await createOpenApiToolProvider({
      name: "iterate_events",
      spec: openApiSpec,
      baseUrl: "https://events.example/api/",
      operationIds: ["appendStreamEvents"],
      fetch: fetchFn,
    });

    expect(Object.keys(provider.tools ?? {})).toEqual(["appendStreamEvents"]);
    expect(provider.types).toContain("appendStreamEvents");
    expect(provider.types).not.toContain("getStreamState");
    expect(provider.types).not.toContain("destroyStream");
    expect(provider.types).not.toContain("secrets_list");

    const appendStreamEvents = provider.tools?.appendStreamEvents;
    expect(appendStreamEvents).toBeDefined();
    await appendStreamEvents?.execute({ path: "team/inbox", body: { event: { type: "hello" } } });

    expect(fetchFn).toHaveBeenCalledWith(
      new URL("streams/team%2Finbox", "https://events.example/api/"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: { type: "hello" } }),
      },
    );
  });
});
