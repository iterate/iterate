// Unit tests for the OpenAPI operation table (ports the still-applicable cases
// from the legacy src/itx/capabilities/openapi-types.test.ts). The next engine
// no longer derives TypeScript declaration strings from specs — capability
// `types` are caller-provided — so the surviving subjects are the flattened
// operation list, $ref resolution against the spec, and the object-vs-`body`
// request-body split that executeOperation dispatches on.

import { describe, expect, test } from "vitest";
import { resolveJsonSchema } from "./json-schema-types.ts";
import {
  isObjectSchema,
  listOpenApiOperations,
  operationBodySchema,
  type OpenApiOperation,
} from "./openapi-types.ts";

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
        description: "List widgets by status",
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
      NewWidget: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, status: { type: "string" } },
      },
      Widget: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
    },
  },
} as unknown as Record<string, unknown>;

describe("listOpenApiOperations", () => {
  const operations = listOpenApiOperations(SPEC);
  const byId = (operationId: string): OpenApiOperation =>
    operations.find((operation) => operation.operationId === operationId)!;

  test("flattens paths×methods to flat operationIds, merging path-item parameters", () => {
    expect(operations.map((operation) => operation.operationId)).toEqual([
      "getWidget",
      "deleteWidget",
      "listWidgets",
      "createWidget",
      "putRaw",
    ]);
    const getWidget = byId("getWidget");
    expect(getWidget).toMatchObject({ method: "get", path: "/widgets/{widgetId}" });
    // The path-item-level widgetId parameter merges into the operation's own.
    expect(getWidget.parameters.map((parameter) => parameter.name)).toEqual([
      "widgetId",
      "verbose",
    ]);
    // Operations without their own parameters still inherit the path-item ones.
    expect(byId("deleteWidget").parameters.map((parameter) => parameter.name)).toEqual([
      "widgetId",
    ]);
  });

  test("captures summaries (falling back to descriptions) for describe() output", () => {
    expect(byId("getWidget").summary).toBe("Fetch one widget");
    expect(byId("listWidgets").summary).toBe("List widgets by status");
    expect(byId("deleteWidget").summary).toBeUndefined();
  });

  test("object request bodies resolve their $ref and inline as the input object", () => {
    const bodySchema = operationBodySchema(byId("createWidget"), SPEC);
    // The $ref resolves against components.schemas…
    expect(bodySchema).toMatchObject({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, status: { type: "string" } },
    });
    // …and an object schema means leftover input keys ARE the JSON body.
    expect(isObjectSchema(bodySchema)).toBe(true);
  });

  test("non-object bodies travel under a `body` key; bodyless operations have none", () => {
    const rawSchema = operationBodySchema(byId("putRaw"), SPEC);
    expect(rawSchema).toEqual({ type: "string" });
    expect(isObjectSchema(rawSchema)).toBe(false);
    expect(operationBodySchema(byId("getWidget"), SPEC)).toBeUndefined();
  });
});

describe("resolveJsonSchema", () => {
  test("follows $ref pointers into components.schemas", () => {
    expect(resolveJsonSchema({ $ref: "#/components/schemas/Widget" }, SPEC)).toMatchObject({
      type: "object",
      required: ["id", "name"],
    });
  });

  test("passes plain schemas through and rejects dangling or external refs", () => {
    expect(resolveJsonSchema({ type: "boolean" }, SPEC)).toEqual({ type: "boolean" });
    expect(resolveJsonSchema(true, SPEC)).toBe(true);
    expect(resolveJsonSchema({ $ref: "#/components/schemas/Missing" }, SPEC)).toBeUndefined();
    expect(
      resolveJsonSchema({ $ref: "https://example.com/spec.json#/Widget" }, SPEC),
    ).toBeUndefined();
  });
});
