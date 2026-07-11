import { expect, test } from "vitest";
import {
  firstExportedTypeName,
  jsonSchemaToTypeText,
  mcpCapabilityTypeDeclaration,
  openApiCapabilityTypeDeclaration,
} from "./capability-type-declarations.ts";
import { listOpenApiOperations } from "./openapi-types.ts";

test("jsonSchemaToTypeText renders the common shapes", () => {
  expect(jsonSchemaToTypeText({ type: "string" })).toBe("string");
  expect(jsonSchemaToTypeText({ type: "integer" })).toBe("number");
  expect(jsonSchemaToTypeText({ type: "array", items: { type: "boolean" } })).toBe(
    "Array<boolean>",
  );
  expect(jsonSchemaToTypeText({ enum: ["a", "b", 3] })).toBe('"a" | "b" | 3');
  expect(jsonSchemaToTypeText({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe(
    "string | null",
  );
  expect(
    jsonSchemaToTypeText({
      type: "object",
      properties: {
        city: { type: "string", description: "Where to forecast" },
        days: { type: "number" },
        "kebab-name": { type: "string" },
      },
      required: ["city"],
    }),
  ).toBe('{ /** Where to forecast */ city: string; days?: number; "kebab-name"?: string }');
});

test("jsonSchemaToTypeText resolves $ref against the root schema", () => {
  const root = {
    definitions: { Pet: { type: "object", properties: { name: { type: "string" } } } },
  };
  expect(jsonSchemaToTypeText({ $ref: "#/definitions/Pet" }, root)).toBe("{ name?: string }");
});

test("jsonSchemaToTypeText degrades to unknown instead of throwing", () => {
  expect(jsonSchemaToTypeText(undefined)).toBe("unknown");
  expect(jsonSchemaToTypeText({ $ref: "#/missing" }, {})).toBe("unknown");
  expect(jsonSchemaToTypeText({ type: "weird" })).toBe("unknown");
  // Self-referential schema bottoms out at the depth cap.
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.properties = { next: cyclic };
  expect(jsonSchemaToTypeText(cyclic, cyclic as never)).toContain("unknown");
});

test("mcpCapabilityTypeDeclaration types each tool from its inputSchema", () => {
  const declaration = mcpCapabilityTypeDeclaration([
    {
      name: "web_search",
      description: "Search the web.",
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    { name: "with-dash", inputSchema: { type: "object" as const } },
  ]);
  expect(declaration).toContain("export type Capability = {");
  expect(declaration).toContain("/** Search the web. */");
  expect(declaration).toContain("web_search(input: { query: string }): Promise<unknown>;");
  // No required properties -> optional input (dispatch treats a missing
  // argument as {}), so no-arg calls typecheck.
  expect(declaration).toContain('"with-dash"(input?: Record<string, unknown>): Promise<unknown>;');
  expect(firstExportedTypeName(declaration)).toBe("Capability");
});

test("openApiCapabilityTypeDeclaration merges parameters and body into one input", () => {
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          summary: "Fetch one pet.",
          parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        },
      },
      "/free-form": {
        post: {
          operationId: "freeForm",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        },
      },
      "/notes": {
        post: {
          operationId: "addNote",
          parameters: [{ name: "petId", in: "query", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { type: "string" } } } },
        },
      },
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
            },
          },
        },
      },
    },
  };
  const declaration = openApiCapabilityTypeDeclaration(listOpenApiOperations(spec), spec);
  expect(declaration).toContain("/** Fetch one pet. */");
  expect(declaration).toContain("getPet(input: { petId: string }): Promise<unknown>;");
  expect(declaration).toContain("createPet(input: { name: string }): Promise<unknown>;");
  // A property-less object body means leftover input keys ARE the body
  // (dispatch's rule), typed as an index signature — never invalid syntax.
  expect(declaration).toContain("freeForm(input?: { [key: string]: unknown }): Promise<unknown>;");
  // A NON-object body rides under dispatch's { body } convention, and a
  // required parameter keeps the input required.
  expect(declaration).toContain(
    "addNote(input: { petId: string; body?: string }): Promise<unknown>;",
  );
});

test("firstExportedTypeName picks the first export in CODE and tolerates none", () => {
  expect(firstExportedTypeName("export interface Forecast { city: string }")).toBe("Forecast");
  expect(firstExportedTypeName("// prose\nexport type A = 1;\nexport type B = 2;")).toBe("A");
  expect(firstExportedTypeName("type NotExported = 1;")).toBeUndefined();
  // A comment mentioning an export must not bind the mount to a ghost name.
  expect(firstExportedTypeName("/** export type Ghost */\nexport type Real = 1;")).toBe("Real");
});
