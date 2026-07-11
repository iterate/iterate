import { expect, test } from "vitest";
import {
  firstExportedTypeName,
  jsonSchemaToTypeText,
  mcpCapabilityTypeDeclaration,
  openApiCapabilityTypeDeclaration,
  openApiCapabilityTypeInline,
  openApiCapabilityTypeReference,
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
  const declaration = mcpCapabilityTypeDeclaration(
    [
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
    ],
    "MCP server https://mcp.example.com",
  );
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
      "/user/{username}": {
        put: {
          operationId: "updateUser",
          parameters: [
            { name: "username", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { username: { type: "string" }, email: { type: "string" } },
                },
              },
            },
          },
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
  // The REST echo pattern (/user/{username} + username in the body) must not
  // emit a duplicate member — that used to fail the compile gate and silently
  // untype the whole mount. The parameter claims the key.
  expect(declaration).toContain(
    "updateUser(input: { username: string; email?: string }): Promise<unknown>;",
  );
});

test("generated declarations over the size budget collapse to one permissive line", () => {
  // A wall of member names helps no reader — over the budget the mount keeps
  // a one-line permissive type and the provenance pointer.
  const tools = Array.from({ length: 400 }, (_, i) => ({
    name: `tool_${i}`,
    description: "x".repeat(200),
    inputSchema: {
      type: "object" as const,
      properties: { a: { type: "string", description: "y".repeat(100) } },
    },
  }));
  const declaration = mcpCapabilityTypeDeclaration(tools, "MCP server https://mcp.example.com");
  expect(declaration.length).toBeLessThan(500);
  expect(declaration).toContain("// Generated from MCP server https://mcp.example.com");
  expect(declaration).toContain(
    "Record<string, (input?: Record<string, unknown>) => Promise<unknown>>",
  );
  expect(firstExportedTypeName(declaration)).toBe("Capability");

  // Under the budget: full schemas plus the same provenance header.
  const small = mcpCapabilityTypeDeclaration(
    tools.slice(0, 2),
    "MCP server https://mcp.example.com",
  );
  expect(small).toContain("// Generated from");
  expect(small).toContain("tool_1(input?: {");
});

test("openApiCapabilityTypeInline journals the full declaration for auth'd specs", () => {
  // The sidecar's bare fetch cannot send auth headers, so specs behind them
  // journal inline (budgeted like MCP) instead of by reference.
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/pets": { get: { operationId: "listPets" } },
    },
  };
  const inline = openApiCapabilityTypeInline(
    listOpenApiOperations(spec),
    spec,
    "https://private.example.com/spec.json",
  );
  expect(inline).toContain("// Generated from https://private.example.com/spec.json");
  expect(inline).toContain("listPets(input?: Record<string, unknown>): Promise<unknown>;");
  expect(inline).not.toContain("openapi:");
});

test("openApiCapabilityTypeReference is one journal-sized line, not a schema dump", () => {
  const reference = openApiCapabilityTypeReference(
    "https://petstore3.swagger.io/api/v3/openapi.json",
  );
  expect(reference.length).toBeLessThan(500);
  expect(reference).toContain("// Generated from https://petstore3.swagger.io");
  expect(reference).toContain(
    'import("openapi:https://petstore3.swagger.io/api/v3/openapi.json").Capability',
  );
  expect(firstExportedTypeName(reference)).toBe("Capability");
});

test("firstExportedTypeName picks the first TOP-LEVEL export in CODE and tolerates none", () => {
  expect(firstExportedTypeName("export interface Forecast { city: string }")).toBe("Forecast");
  expect(firstExportedTypeName("// prose\nexport type A = 1;\nexport type B = 2;")).toBe("A");
  expect(firstExportedTypeName("type NotExported = 1;")).toBeUndefined();
  // A comment mentioning an export must not bind the mount to a ghost name.
  expect(firstExportedTypeName("/** export type Ghost */\nexport type Real = 1;")).toBe("Real");
  // A namespace-nested export is not importable by bare name; picking it used
  // to poison every typecheck in the scope with an unresolvable reference.
  expect(
    firstExportedTypeName("export namespace NS { export interface Inner { x: 1 } }"),
  ).toBeUndefined();
  expect(
    firstExportedTypeName(
      "export namespace NS { export interface Inner { x: 1 } }\nexport type Outer = 1;",
    ),
  ).toBe("Outer");
  // Classes and enums are types too — they no longer silently degrade to any.
  expect(firstExportedTypeName("export declare class Client { get(): void }")).toBe("Client");
  expect(firstExportedTypeName("export abstract class Base {}")).toBe("Base");
  expect(firstExportedTypeName("export const enum Mode { A }")).toBe("Mode");
  // Value-only exports export no TYPE.
  expect(firstExportedTypeName("export const x = 1;")).toBeUndefined();
  // Braces inside string-literal types must not skew the depth count —
  // "/user/{id}" carries an unbalanced brace.
  expect(
    firstExportedTypeName('type Internal = { route: "/user/{id}" };\nexport type Real = Internal;'),
  ).toBe("Real");
  expect(firstExportedTypeName("export type T = `prefix-${string}`;\nexport type U = 1;")).toBe(
    "T",
  );
});
