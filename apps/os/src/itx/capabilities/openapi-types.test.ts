// Unit tests for the OpenAPI → TypeScript declaration derivation — plain
// Node, one small inline spec, assertions on the exact signatures an agent
// would read out of describe().types.

import { describe, expect, test } from "vitest";
import { deriveOpenApiTypes, listOpenApiOperations } from "./openapi-types.ts";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Widget API", version: "1.0.0" },
  paths: {
    "/widgets/{widgetId}": {
      parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "integer" } }],
      get: {
        operationId: "getWidget",
        summary: "Fetch one widget",
        parameters: [{ name: "verbose", in: "query", schema: { type: "boolean" } }],
        responses: {
          "200": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Widget" } },
            },
          },
        },
      },
      delete: { operationId: "deleteWidget", responses: { "204": { description: "gone" } } },
    },
    "/widgets": {
      get: {
        operationId: "listWidgets",
        parameters: [
          {
            name: "status",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["draft", "live"] },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Widget" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createWidget",
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NewWidget" } },
          },
        },
        responses: {
          "201": {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Widget" } },
            },
          },
        },
      },
    },
    "/raw": {
      put: {
        operationId: "putRaw",
        requestBody: { content: { "application/json": { schema: { type: "string" } } } },
        responses: { "200": { content: { "application/json": { schema: { type: "boolean" } } } } },
      },
    },
  },
  components: {
    schemas: {
      Widget: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          status: { type: "string", enum: ["draft", "live"] },
          tags: { type: "array", items: { type: "string" } },
          owner: { oneOf: [{ $ref: "#/components/schemas/Owner" }, { type: "null" }] },
        },
      },
      NewWidget: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, status: { type: "string" } },
      },
      Owner: { type: "object", properties: { email: { type: "string" } } },
    },
  },
} as unknown as Record<string, unknown>;

describe("listOpenApiOperations", () => {
  test("flattens paths×methods to flat operationIds, merging path-item parameters", () => {
    const operations = listOpenApiOperations(SPEC);
    expect(operations.map((operation) => operation.operationId)).toEqual([
      "getWidget",
      "deleteWidget",
      "listWidgets",
      "createWidget",
      "putRaw",
    ]);
    const getWidget = operations.find((operation) => operation.operationId === "getWidget")!;
    expect(getWidget).toMatchObject({ method: "get", path: "/widgets/{widgetId}" });
    // The path-item-level widgetId parameter merges into the operation's own.
    expect(getWidget.parameters.map((parameter) => parameter.name)).toEqual([
      "widgetId",
      "verbose",
    ]);
  });
});

describe("deriveOpenApiTypes", () => {
  const types = deriveOpenApiTypes(SPEC);

  test("path + query params merge into ONE input object; path params are required", () => {
    expect(types).toContain(
      "declare function getWidget(input: { widgetId: number; verbose?: boolean }): Promise<",
    );
  });

  test("$refs resolve against components.schemas; enums become literal unions", () => {
    expect(types).toContain(
      'Promise<{ id: number; name: string; status?: "draft" | "live"; tags?: string[]; owner?: { email?: string } | null }>',
    );
    expect(types).toContain('status: "draft" | "live"');
  });

  test("object request bodies inline their properties into the input object", () => {
    expect(types).toContain(
      "declare function createWidget(input: { name: string; status?: string }): Promise<",
    );
  });

  test("non-object bodies travel under a `body` key; bare responses are unknown", () => {
    expect(types).toContain("declare function putRaw(input: { body: string }): Promise<boolean>;");
    // deleteWidget inherits the path-item-level widgetId; no response schema → unknown.
    expect(types).toContain(
      "declare function deleteWidget(input: { widgetId: number }): Promise<unknown>;",
    );
  });

  test("summaries become JSDoc; arrays of $refs resolve", () => {
    expect(types).toContain("/** Fetch one widget */");
    expect(types).toContain(
      'declare function listWidgets(input: { status: "draft" | "live" }): Promise<{ id: number; name: string;',
    );
  });
});
