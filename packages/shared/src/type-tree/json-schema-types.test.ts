/**
 * Tests for the JSON Schema to TypeScript conversion.
 *
 * Adapted from @cloudflare/codemode (cloudflare/agents):
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/tests/json-schema-types.test.ts
 * https://github.com/cloudflare/agents/blob/main/packages/codemode/src/tests/schema-conversion.test.ts
 *
 * These tests cover jsonSchemaToType (single schema) and
 * generateTypesFromJsonSchema (MCP-style tool descriptors).
 * All tests use plain JSON Schema objects with no AI SDK or Zod dependency.
 */

import { describe, it, expect } from "vitest";
import {
  generateContextTypesFromJsonSchema,
  generateTypesFromJsonSchema,
  jsonSchemaToType,
  jsonSchemaToTypeString,
  type ConversionContext,
} from "./json-schema-types.ts";

// ---------------------------------------------------------------------------
// jsonSchemaToType -- single schema to type declaration
// ---------------------------------------------------------------------------

describe("jsonSchemaToType", () => {
  it("converts a simple object with required and optional fields", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      },
      "UserInput",
    );

    expect(result).toBe(
      ["type UserInput = {", "    name: string;", "    age?: number;", "}"].join("\n"),
    );
  });

  it("converts string enums", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "inactive", "pending"] },
        },
      },
      "StatusInput",
    );

    expect(result).toBe(
      ["type StatusInput = {", '    status?: "active" | "inactive" | "pending";', "}"].join("\n"),
    );
  });

  it("converts nested objects", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: {
              street: { type: "string" },
              zip: { type: "string" },
            },
            required: ["street"],
          },
        },
      },
      "PersonInput",
    );

    expect(result).toBe(
      [
        "type PersonInput = {",
        "    address?: {",
        "        street: string;",
        "        zip?: string;",
        "    };",
        "}",
      ].join("\n"),
    );
  });

  it("converts arrays with typed items", () => {
    const result = jsonSchemaToType(
      {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          scores: { type: "array", items: { type: "number" } },
        },
      },
      "DataInput",
    );

    expect(result).toBe(
      ["type DataInput = {", "    tags?: string[];", "    scores?: number[];", "}"].join("\n"),
    );
  });

  it("converts a bare string schema", () => {
    expect(jsonSchemaToType({ type: "string" }, "NameInput")).toBe("type NameInput = string");
  });

  it("converts an empty object schema to Record<string, unknown>", () => {
    expect(jsonSchemaToType({ type: "object" }, "EmptyInput")).toBe(
      "type EmptyInput = Record<string, unknown>",
    );
  });
});

// ---------------------------------------------------------------------------
// jsonSchemaToTypeString -- low-level conversion
// ---------------------------------------------------------------------------

describe("jsonSchemaToTypeString", () => {
  function convert(schema: unknown, indent = ""): string {
    const ctx: ConversionContext = {
      root: schema as Record<string, unknown>,
      depth: 0,
      seen: new Set(),
      maxDepth: 20,
    };
    return jsonSchemaToTypeString(schema as boolean | Record<string, unknown>, indent, ctx);
  }

  it("maps boolean true schema to unknown", () => {
    expect(convert(true)).toBe("unknown");
  });

  it("maps boolean false schema to never", () => {
    expect(convert(false)).toBe("never");
  });

  it("maps integer to number", () => {
    expect(convert({ type: "integer" })).toBe("number");
  });

  it("handles bare array type without items", () => {
    expect(convert({ type: "array" })).toBe("unknown[]");
  });

  it("handles anyOf union types", () => {
    const result = convert({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    expect(result).toContain("string | number");
  });

  it("handles nullable field via anyOf with null", () => {
    const result = convert({
      type: "object",
      properties: {
        name: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    expect(result).toContain("string | null");
  });

  it("handles allOf intersection types", () => {
    const result = convert({
      type: "object",
      properties: {
        val: {
          allOf: [
            { type: "object", properties: { a: { type: "string" } } },
            { type: "object", properties: { b: { type: "number" } } },
          ],
        },
      },
    });
    expect(result).toContain(" & ");
    expect(result).toContain("a?: string;");
    expect(result).toContain("b?: number;");
  });

  it("handles oneOf union types with 3+ members", () => {
    const result = convert({
      type: "object",
      properties: {
        val: {
          oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        },
      },
    });
    expect(result).toContain("string | number | boolean");
  });

  it('handles type array like ["string", "null"]', () => {
    const result = convert({
      type: "object",
      properties: {
        val: { type: ["string", "null"] },
      },
    });
    expect(result).toContain("string | null");
  });

  it("applies OpenAPI nullable: true to produce union with null", () => {
    const result = convert({
      type: "object",
      properties: {
        name: { type: "string", nullable: true },
      },
    });
    expect(result).toContain("string | null");
  });

  it("handles empty enum as never", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { enum: [] },
      },
    });
    expect(result).toContain("val?: never;");
  });

  it("handles null in enum", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { enum: ["a", null, "b"] },
      },
    });
    expect(result).toContain('"a" | null | "b"');
  });

  it("escapes special chars in enum strings", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { type: "string", enum: ['say "hello"', "back\\slash"] },
      },
    });
    expect(result).toContain('say \\"hello\\"');
    expect(result).toContain("back\\\\slash");
  });

  it("escapes special chars in const", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { const: 'line "one"' },
      },
    });
    expect(result).toContain('line \\"one\\"');
  });

  it("serializes object enum values with JSON.stringify", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { enum: [{ key: "value" }, "plain"] },
      },
    });
    expect(result).toContain('{"key":"value"}');
    expect(result).not.toContain("[object Object]");
  });

  it("serializes array enum values with JSON.stringify", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { enum: [[1, 2, 3], "plain"] },
      },
    });
    expect(result).toContain("[1,2,3]");
  });

  it("serializes object const values with JSON.stringify", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { const: { nested: true } },
      },
    });
    expect(result).toContain('{"nested":true}');
  });

  // --- $ref resolution ---

  it("resolves $defs refs", () => {
    const result = convert({
      type: "object",
      properties: {
        address: { $ref: "#/$defs/Address" },
      },
      $defs: {
        Address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
        },
      },
    });
    expect(result).toContain("street?: string;");
    expect(result).toContain("city?: string;");
  });

  it("resolves definitions refs", () => {
    const result = convert({
      type: "object",
      properties: {
        item: { $ref: "#/definitions/Item" },
      },
      definitions: {
        Item: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      },
    });
    expect(result).toContain("name?: string;");
  });

  it("returns unknown for unresolvable ref", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { $ref: "#/definitions/DoesNotExist" },
      },
    });
    expect(result).toContain("val?: unknown;");
  });

  it("returns unknown for external URL ref", () => {
    const result = convert({
      type: "object",
      properties: {
        val: { $ref: "https://example.com/schema.json" },
      },
    });
    expect(result).toContain("val?: unknown;");
  });

  it("resolves nested ref chains", () => {
    const result = convert({
      type: "object",
      properties: {
        item: { $ref: "#/$defs/Wrapper" },
      },
      $defs: {
        Wrapper: {
          type: "object",
          properties: {
            inner: { $ref: "#/$defs/Inner" },
          },
        },
        Inner: {
          type: "object",
          properties: {
            value: { type: "number" },
          },
        },
      },
    });
    expect(result).toContain("value?: number;");
  });

  // --- Circular schemas ---

  it("handles self-referencing $ref without stack overflow", () => {
    const result = convert({
      type: "object",
      properties: {
        child: { $ref: "#" },
      },
    });
    expect(result).toContain("child?:");
  });

  it("handles deeply nested schemas hitting depth limit", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 30; i++) {
      schema = { type: "object", properties: { nested: schema } };
    }
    const result = convert(schema);
    expect(result).toContain("unknown");
  });

  // --- additionalProperties ---

  it("emits index signature for additionalProperties: true", () => {
    const result = convert({
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    });
    expect(result).toContain("name?: string;");
    expect(result).toContain("[key: string]: unknown;");
  });

  it("emits typed index signature for typed additionalProperties", () => {
    const result = convert({
      type: "object",
      additionalProperties: { type: "string" },
    });
    expect(result).toContain("[key: string]: string;");
  });

  it("returns empty object type when no properties and additionalProperties is false", () => {
    const result = convert({
      type: "object",
      additionalProperties: false,
    });
    expect(result).toBe("{}");
  });

  it("returns Record<string, unknown> when no properties and no additionalProperties constraint", () => {
    const result = convert({ type: "object" });
    expect(result).toBe("Record<string, unknown>");
  });

  // --- Tuple support ---

  it("handles items as array (draft-07 tuples)", () => {
    const result = convert({
      type: "object",
      properties: {
        pair: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
      },
    });
    expect(result).toContain("[string, number]");
  });

  it("handles prefixItems (JSON Schema 2020-12)", () => {
    const result = convert({
      type: "object",
      properties: {
        triple: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
        },
      },
    });
    expect(result).toContain("[string, number, boolean]");
  });

  // --- Property name safety ---

  it("escapes control characters in property names", () => {
    const result = convert({
      type: "object",
      properties: {
        "has\nnewline": { type: "string" },
        "has\ttab": { type: "string" },
      },
    });
    expect(result).toContain("\\n");
    expect(result).toContain("\\t");
  });

  it("escapes quotes in property names", () => {
    const result = convert({
      type: "object",
      properties: {
        'has"quote': { type: "string" },
      },
    });
    expect(result).toContain('\\"');
  });

  it("handles empty string property name", () => {
    const result = convert({
      type: "object",
      properties: {
        "": { type: "string" },
      },
    });
    expect(result).toContain('""');
  });

  // --- Descriptions and JSDoc ---

  it("emits field descriptions as JSDoc comments", () => {
    const result = convert({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
    });
    expect(result).toContain("/** Search query */");
  });

  it("normalizes newlines in field descriptions", () => {
    const result = convert({
      type: "object",
      properties: {
        field: { type: "string", description: "Line one\nLine two\r\nLine three" },
      },
    });
    expect(result).toContain("/** Line one Line two Line three */");
    expect(result).not.toContain("Line one\n");
  });

  it("escapes */ in property descriptions", () => {
    const result = convert({
      type: "object",
      properties: {
        field: { type: "string", description: "Value like */ can break comments" },
      },
    });
    expect(result).toContain("*\\/");
    expect(result).not.toContain("/** Value like */ can");
  });

  it("uses multi-line JSDoc when both description and format are present", () => {
    const result = convert({
      type: "object",
      properties: {
        email: { type: "string", description: "User email address", format: "email" },
      },
    });
    expect(result).toContain("* User email address");
    expect(result).toContain("* @format email");
    expect(result).not.toContain("/** User email address @format email */");
  });

  it("uses single-line JSDoc when only format is present", () => {
    const result = convert({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
      },
    });
    expect(result).toContain("/** @format uuid */");
  });
});

// ---------------------------------------------------------------------------
// generateTypesFromJsonSchema -- MCP-style tool descriptors
// ---------------------------------------------------------------------------

describe("generateTypesFromJsonSchema", () => {
  it("generates types for a single tool with descriptions", () => {
    const result = generateTypesFromJsonSchema({
      getWeather: {
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
            units: {
              type: "string",
              enum: ["celsius", "fahrenheit"],
            },
          },
          required: ["city"],
        },
      },
    });

    expect(result).toBe(
      [
        "type GetWeatherInput = {",
        "    /** City name */",
        "    city: string;",
        '    units?: "celsius" | "fahrenheit";',
        "}",
        "type GetWeatherOutput = unknown",
        "",
        "declare const tools: {",
        "\t/**",
        "\t * Get weather for a city",
        "\t * @param input.city - City name",
        "\t */",
        "\tgetWeather: (input: GetWeatherInput) => Promise<GetWeatherOutput>;",
        "}",
      ].join("\n"),
    );
  });

  it("generates types for multiple tools with name sanitization", () => {
    const result = generateTypesFromJsonSchema({
      search: {
        description: "Search for items",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
      "get-item": {
        description: "Get an item by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    });

    expect(result).toBe(
      [
        "type SearchInput = {",
        "    query: string;",
        "    limit?: number;",
        "}",
        "type SearchOutput = unknown",
        "type GetItemInput = {",
        "    id: string;",
        "}",
        "type GetItemOutput = unknown",
        "",
        "declare const tools: {",
        "\t/**",
        "\t * Search for items",
        "\t */",
        "\tsearch: (input: SearchInput) => Promise<SearchOutput>;",
        "\t/**",
        "\t * Get an item by ID",
        "\t */",
        "\tget_item: (input: GetItemInput) => Promise<GetItemOutput>;",
        "}",
      ].join("\n"),
    );
  });

  it("generates typed output schemas when provided", () => {
    const result = generateTypesFromJsonSchema({
      getUser: {
        description: "Get a user",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        outputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          required: ["name", "email"],
        },
      },
    });

    expect(result).toBe(
      [
        "type GetUserInput = {",
        "    id: string;",
        "}",
        "type GetUserOutput = {",
        "    name: string;",
        "    email: string;",
        "}",
        "",
        "declare const tools: {",
        "\t/**",
        "\t * Get a user",
        "\t */",
        "\tgetUser: (input: GetUserInput) => Promise<GetUserOutput>;",
        "}",
      ].join("\n"),
    );
  });

  it("handles an empty tool set", () => {
    expect(generateTypesFromJsonSchema({})).toBe("declare const tools: {}");
  });

  it("generates types from MCP-style tool definitions", () => {
    const result = generateTypesFromJsonSchema({
      create_issue: {
        description: "Create a GitHub issue",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string", description: "Repository owner" },
            repo: { type: "string", description: "Repository name" },
            title: { type: "string", description: "Issue title" },
            body: { type: "string", description: "Issue body" },
            labels: {
              type: "array",
              items: { type: "string" },
              description: "Labels to add",
            },
          },
          required: ["owner", "repo", "title"],
        },
      },
      list_issues: {
        description: "List issues in a repository",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            state: {
              type: "string",
              enum: ["open", "closed", "all"],
            },
            per_page: { type: "number" },
          },
          required: ["owner", "repo"],
        },
      },
    });

    expect(result).toBe(
      [
        "type CreateIssueInput = {",
        "    /** Repository owner */",
        "    owner: string;",
        "    /** Repository name */",
        "    repo: string;",
        "    /** Issue title */",
        "    title: string;",
        "    /** Issue body */",
        "    body?: string;",
        "    /** Labels to add */",
        "    labels?: string[];",
        "}",
        "type CreateIssueOutput = unknown",
        "type ListIssuesInput = {",
        "    owner: string;",
        "    repo: string;",
        '    state?: "open" | "closed" | "all";',
        "    per_page?: number;",
        "}",
        "type ListIssuesOutput = unknown",
        "",
        "declare const tools: {",
        "\t/**",
        "\t * Create a GitHub issue",
        "\t * @param input.owner - Repository owner",
        "\t * @param input.repo - Repository name",
        "\t * @param input.title - Issue title",
        "\t * @param input.body - Issue body",
        "\t * @param input.labels - Labels to add",
        "\t */",
        "\tcreate_issue: (input: CreateIssueInput) => Promise<CreateIssueOutput>;",
        "\t/**",
        "\t * List issues in a repository",
        "\t */",
        "\tlist_issues: (input: ListIssuesInput) => Promise<ListIssuesOutput>;",
        "}",
      ].join("\n"),
    );
  });

  it("generates nested declarations for dotted tool names", () => {
    const result = generateTypesFromJsonSchema({
      "bla.bla.doIt": {
        description: "Do it",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
        outputSchema: { type: "string" },
      },
    });

    expect(result).toBe(
      [
        "type BlaBlaDoItInput = {",
        "    x: string;",
        "}",
        "type BlaBlaDoItOutput = string",
        "",
        "declare const tools: {",
        "\tbla: {",
        "\t\tbla: {",
        "\t\t\t/**",
        "\t\t\t * Do it",
        "\t\t\t */",
        "\t\t\tdoIt: (input: BlaBlaDoItInput) => Promise<BlaBlaDoItOutput>;",
        "\t\t};",
        "\t};",
        "}",
      ].join("\n"),
    );
  });

  it("generates declarations for provider documentation namespaces", () => {
    const result = generateTypesFromJsonSchema(
      {
        doIt: {
          description: "Do it",
          inputSchema: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
          },
          outputSchema: { type: "string" },
        },
      },
      "mcp.someServer",
    );

    expect(result).toBe(
      [
        "type DoItInput = {",
        "    x: string;",
        "}",
        "type DoItOutput = string",
        "",
        "declare const mcp: {",
        "\tsomeServer: {",
        "\t\t/**",
        "\t\t * Do it",
        "\t\t */",
        "\t\tdoIt: (input: DoItInput) => Promise<DoItOutput>;",
        "\t};",
        "}",
      ].join("\n"),
    );
  });

  it("does not crash for empty dotted provider namespaces", () => {
    expect(generateTypesFromJsonSchema({}, "mcp.someServer")).toBe("declare const mcp: {}");
  });

  it("normalizes newlines in tool descriptions", () => {
    const result = generateTypesFromJsonSchema({
      test: {
        description: "Tool that does\nmultiple things\r\non multiple lines",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    });
    expect(result).toContain("Tool that does multiple things on multiple lines");
  });

  it("escapes */ in tool descriptions", () => {
    const result = generateTypesFromJsonSchema({
      test: {
        description: "A tool with */ in description",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
        },
      },
    });
    expect(result).toContain("*\\/");
    expect(result).not.toMatch(/\* A tool with \*\/ in/);
  });

  it("preserves both flat and dotted declarations when names conflict by prefix", () => {
    const result = generateTypesFromJsonSchema({
      files: {
        description: "Flat files tool",
        inputSchema: { type: "object", properties: {} },
      },
      "files.read": {
        description: "Read file",
        inputSchema: { type: "object", properties: {} },
      },
    });

    expect(result).toContain("\tfiles: {");
    expect(result).toContain("$call: (input: FilesInput) => Promise<FilesOutput>;");
    expect(result).toContain("read: (input: FilesReadInput) => Promise<FilesReadOutput>;");
  });

  it("generates ctx declarations with core built-ins and nested provider paths", () => {
    const result = generateContextTypesFromJsonSchema({
      namespace: ["builtin", "slack"],
      tools: {
        "chat.postMessage": {
          description: "Post a Slack message",
          inputSchema: {
            type: "object",
            properties: {
              channel: { type: "string" },
              text: { type: "string" },
            },
            required: ["channel", "text"],
          },
          outputSchema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
        },
      },
    });

    expect(result).toContain("interface ItxExecutionContext {");
    expect(result).toContain("fetch: typeof fetch;");
    expect(result).toContain("console: ItxConsole;");
    expect(result).toContain("builtin: {");
    expect(result).toContain("slack: {");
    expect(result).toContain("chat: {");
    expect(result).toContain(
      "postMessage: (input: ChatPostMessageInput) => Promise<ChatPostMessageOutput>;",
    );
    expect(result).toContain("declare const ctx: ItxExecutionContext");
  });
});
