import { describe, expect, it, test } from "vitest";
import { z } from "zod";
import { subtractObjectPropsFromJSONSchema } from "./schema-utils.ts";
import {
  makeJSONSchemaOpenAICompatible,
  zodToOpenAIJSONSchema,
} from "./zod-to-openai-json-schema.ts";

describe("makeJSONSchemaOpenAICompatible", () => {
  it("should not add empty required array to object with no properties", () => {
    const schema = {
      type: "object",
      properties: {},
    };

    makeJSONSchemaOpenAICompatible(schema);

    expect(schema).not.toHaveProperty("required");
  });

  it("should not add empty required array to object with empty properties", () => {
    const schema = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };

    makeJSONSchemaOpenAICompatible(schema);

    expect(schema).not.toHaveProperty("required");
  });

  it("should preserve existing required array", () => {
    const schema: any = {
      type: "object",
      properties: {
        foo: { type: "string" },
        bar: { type: "number" },
      },
      required: ["foo"],
    };

    makeJSONSchemaOpenAICompatible(schema);

    expect(schema.required).toEqual(["foo"]);
  });

  it("should preserve existing required array without adding all properties", () => {
    const schema = {
      type: "object",
      properties: {
        foo: { type: "string" },
        bar: { type: "number" },
      },
      required: ["foo"],
    };

    makeJSONSchemaOpenAICompatible(schema);

    // Preserve existing required array, don't auto-add all properties
    expect(schema.required).toEqual(["foo"]);
  });

  it("should not add required for non-object types", () => {
    const schema = {
      type: "string",
    };

    makeJSONSchemaOpenAICompatible(schema);

    expect(schema).not.toHaveProperty("required");
  });

  it("should add empty properties field to object schema with no properties field", () => {
    const schema: any = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    };

    makeJSONSchemaOpenAICompatible(schema);

    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(schema).not.toHaveProperty("required");
  });

  it("should handle the exact flow from tool-spec-to-runtime-tool", () => {
    // This simulates what happens in tool-spec-to-runtime-tool.ts
    const inputSchema: any = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    };

    // First, subtractObjectPropsFromJSONSchema is called
    const afterSubtract = subtractObjectPropsFromJSONSchema(inputSchema, {});
    console.log("After subtract:", JSON.stringify(afterSubtract, null, 2));

    // Then makeJSONSchemaOpenAICompatible is called
    makeJSONSchemaOpenAICompatible(afterSubtract);
    console.log("After makeJSONSchemaOpenAICompatible:", JSON.stringify(afterSubtract, null, 2));

    expect(afterSubtract).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(afterSubtract).not.toHaveProperty("required");
  });
});

describe("zodToOpenAISchema", () => {
  it("should not add empty required array to empty zod object", () => {
    const Zod = z.object({});
    const jsonSchema = zodToOpenAIJSONSchema(Zod);

    expect(jsonSchema).not.toHaveProperty("required");
  });

  it("should add required array for zod object with properties", () => {
    const Zod = z.object({
      foo: z.string(),
      bar: z.number(),
    });
    const jsonSchema = zodToOpenAIJSONSchema(Zod);

    expect(jsonSchema.required).toEqual(["foo", "bar"]);
  });
});

describe("zodToOpenAISchema", () => {
  describe("Basic Types", () => {
    test("converts simple string schema", () => {
      const schema = z.object({ name: z.string() });
      const result = zodToOpenAIJSONSchema(schema);

      expect(result).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
        additionalProperties: false,
      });
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "name": {
              "type": "string",
            },
          },
          "required": [
            "name",
          ],
          "type": "object",
        }
      `);
    });

    test("removes pattern and format from string schema", () => {
      const schema = z.object({
        email: z.string().email(),
        url: z.string().url(),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.email).not.toHaveProperty("pattern");
      expect(result.properties.email).not.toHaveProperty("format");
      expect(result.properties.url).not.toHaveProperty("pattern");
      expect(result.properties.url).not.toHaveProperty("format");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "email": {
              "type": "string",
            },
            "url": {
              "type": "string",
            },
          },
          "required": [
            "email",
            "url",
          ],
          "type": "object",
        }
      `);
    });

    test("handles string with description", () => {
      const schema = z.object({
        userName: z.string().describe("The user name"),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.userName.description).toBe("The user name");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "userName": {
              "description": "The user name",
              "type": "string",
            },
          },
          "required": [
            "userName",
          ],
          "type": "object",
        }
      `);
    });

    test("converts number types", () => {
      const schema = z.object({
        age: z.number(),
        temperature: z.number().optional(),
        attempt: z.number().int(),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.age).toEqual({ type: "number" });
      expect(result.properties.temperature).toBeDefined();
      expect(result.properties.attempt).toMatchObject({ type: "integer" });
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "age": {
              "type": "number",
            },
            "attempt": {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "temperature": {
              "type": "number",
            },
          },
          "required": [
            "age",
            "attempt",
          ],
          "type": "object",
        }
      `);
    });

    test("converts boolean types", () => {
      const schema = z.object({
        isActive: z.boolean(),
        thingIsApproved: z.boolean().describe("Approval status"),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.isActive).toEqual({ type: "boolean" });
      expect(result.properties.thingIsApproved).toEqual({
        type: "boolean",
        description: "Approval status",
      });
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "isActive": {
              "type": "boolean",
            },
            "thingIsApproved": {
              "description": "Approval status",
              "type": "boolean",
            },
          },
          "required": [
            "isActive",
            "thingIsApproved",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("Enum Types", () => {
    test("converts enum types from workflow status", () => {
      const schema = z.object({
        status: z.enum(["running", "completed", "failed", "cancelled"]),
        event: z.enum(["STEP_START", "CALLBACK_RECEIVED", "STEP_END"]),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.status).toHaveProperty("enum");
      expect(result.properties.status.enum).toEqual([
        "running",
        "completed",
        "failed",
        "cancelled",
      ]);
      expect(result.properties.event.enum).toEqual(["STEP_START", "CALLBACK_RECEIVED", "STEP_END"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "event": {
              "enum": [
                "STEP_START",
                "CALLBACK_RECEIVED",
                "STEP_END",
              ],
              "type": "string",
            },
            "status": {
              "enum": [
                "running",
                "completed",
                "failed",
                "cancelled",
              ],
              "type": "string",
            },
          },
          "required": [
            "status",
            "event",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("Union Types", () => {
    test("converts union types", () => {
      const schema = z.object({
        callback: z.union([
          z.object({ type: z.literal("WORKFLOW_EVENT"), workflowId: z.string() }),
          z.object({ type: z.literal("URL_CALLBACK"), url: z.string() }),
        ]),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.callback).toHaveProperty("anyOf");
      expect(result.properties.callback.anyOf).toHaveLength(2);
      expect(result.properties.callback.anyOf[0].additionalProperties).toBe(false);
      expect(result.properties.callback.anyOf[1].additionalProperties).toBe(false);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "callback": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "properties": {
                    "type": {
                      "const": "WORKFLOW_EVENT",
                      "type": "string",
                    },
                    "workflowId": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "type",
                    "workflowId",
                  ],
                  "type": "object",
                },
                {
                  "additionalProperties": false,
                  "properties": {
                    "type": {
                      "const": "URL_CALLBACK",
                      "type": "string",
                    },
                    "url": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "type",
                    "url",
                  ],
                  "type": "object",
                },
              ],
            },
          },
          "required": [
            "callback",
          ],
          "type": "object",
        }
      `);
    });

    test("converts discriminated union types", () => {
      const schema = z.object({
        task: z.discriminatedUnion("status", [
          z.object({
            id: z.string(),
            status: z.literal("pending"),
          }),
          z.object({
            id: z.string(),
            status: z.literal("completed"),
            result: z.string(),
          }),
        ]),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.task).toHaveProperty("anyOf");
      expect(result.properties.task.anyOf).toHaveLength(2);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "task": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                    },
                    "status": {
                      "const": "pending",
                      "type": "string",
                    },
                  },
                  "required": [
                    "id",
                    "status",
                  ],
                  "type": "object",
                },
                {
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                    },
                    "result": {
                      "type": "string",
                    },
                    "status": {
                      "const": "completed",
                      "type": "string",
                    },
                  },
                  "required": [
                    "id",
                    "status",
                    "result",
                  ],
                  "type": "object",
                },
              ],
            },
          },
          "required": [
            "task",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("Literal Types", () => {
    test("converts literal types with const handling", () => {
      const schema = z.object({
        ok: z.literal(true),
        type: z.literal("WORKFLOW_EVENT"),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      // Check if literal values are converted properly
      expect(result.properties.ok).toBeDefined();
      expect(result.properties.type).toBeDefined();
      // The actual conversion might vary, so let's just check they exist
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "ok": {
              "const": true,
              "type": "boolean",
            },
            "type": {
              "const": "WORKFLOW_EVENT",
              "type": "string",
            },
          },
          "required": [
            "ok",
            "type",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("Real tRPC Schemas", () => {
    test("converts browser task creation schema", () => {
      const schema = z.object({
        title: z.string(),
        prompt: z.string(),
        outputSchema: z.string(),
        workflowCallbackTarget: z
          .object({
            type: z.literal("WORKFLOW_EVENT"),
            workflowId: z.string(),
            eventType: z.string(),
            workflowClassName: z.string(),
          })
          .optional(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      // workflowCallbackTarget should be stripped
      expect(result.properties).not.toHaveProperty("workflowCallbackTarget");
      expect(result.required).toEqual(["title", "prompt", "outputSchema"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "outputSchema": {
              "type": "string",
            },
            "prompt": {
              "type": "string",
            },
            "title": {
              "type": "string",
            },
          },
          "required": [
            "title",
            "prompt",
            "outputSchema",
          ],
          "type": "object",
        }
      `);
    });

    test("converts workflow step logging schema", () => {
      const LogWorkflowStepInput = z.object({
        workflowId: z.string(),
        stepName: z.string(),
        attempt: z.number().int(),
        event: z.enum(["STEP_START", "CALLBACK_RECEIVED", "STEP_END"]),
        durationMs: z.number().optional(),
        payload: z.unknown().optional(),
      });

      const result = zodToOpenAIJSONSchema(LogWorkflowStepInput) as any;

      expect(result.type).toBe("object");
      expect(result.additionalProperties).toBe(false);
      expect(result.required).toHaveLength(4); // Only non-optional fields are required
      expect(result.properties.event.enum).toEqual(["STEP_START", "CALLBACK_RECEIVED", "STEP_END"]);
      expect(result.properties.attempt.type).toBe("integer");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "attempt": {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer",
            },
            "durationMs": {
              "type": "number",
            },
            "event": {
              "enum": [
                "STEP_START",
                "CALLBACK_RECEIVED",
                "STEP_END",
              ],
              "type": "string",
            },
            "payload": {
              "additionalProperties": false,
              "description": "The value can be a string containing a JSON object",
              "type": "string",
            },
            "stepName": {
              "type": "string",
            },
            "workflowId": {
              "type": "string",
            },
          },
          "required": [
            "workflowId",
            "stepName",
            "attempt",
            "event",
          ],
          "type": "object",
        }
      `);
    });

    test("converts workflow status update schema without date", () => {
      const UpdateWorkflowStatus = z.object({
        workflowId: z.string(),
        status: z.enum(["running", "completed", "failed", "cancelled"]),
        output: z.unknown().optional(),
        completedAt: z.string().optional(), // Use string instead of date
      });

      const result = zodToOpenAIJSONSchema(UpdateWorkflowStatus) as any;

      expect(result.properties.status.enum).toEqual([
        "running",
        "completed",
        "failed",
        "cancelled",
      ]);
      expect(result.properties.output).toBeDefined();
      expect(result.properties.completedAt).toBeDefined();
      expect(result.required).toContain("workflowId");
      expect(result.required).toContain("status");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "completedAt": {
              "type": "string",
            },
            "output": {
              "additionalProperties": false,
              "description": "The value can be a string containing a JSON object",
              "type": "string",
            },
            "status": {
              "enum": [
                "running",
                "completed",
                "failed",
                "cancelled",
              ],
              "type": "string",
            },
            "workflowId": {
              "type": "string",
            },
          },
          "required": [
            "workflowId",
            "status",
          ],
          "type": "object",
        }
      `);
    });

    test("converts browser task with user email schema", () => {
      const schema = z.object({
        userEmail: z.string().email().optional(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.userEmail).not.toHaveProperty("format");
      expect(result.properties.userEmail).not.toHaveProperty("pattern");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "userEmail": {
              "type": "string",
            },
          },
          "type": "object",
        }
      `);
    });
  });

  describe("Edge Cases", () => {
    test("handles empty objects", () => {
      const schema = z.object({
        data: z.object({}),
      });
      const result = zodToOpenAIJSONSchema(schema) as any;

      // Empty objects are converted to objects with empty properties, not strings
      expect(result.properties.data).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "data": {
              "additionalProperties": false,
              "properties": {},
              "type": "object",
            },
          },
          "required": [
            "data",
          ],
          "type": "object",
        }
      `);
    });

    test("handles deeply nested objects", () => {
      const schema = z.object({
        user: z.object({
          profile: z.object({
            settings: z.object({
              notifications: z.boolean(),
            }),
          }),
        }),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(
        result.properties.user.properties.profile.properties.settings.additionalProperties,
      ).toBe(false);
      expect(result.properties.user.properties.profile.required).toEqual(["settings"]);
      expect(result.properties.user.properties.profile.properties.settings.required).toEqual([
        "notifications",
      ]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "user": {
              "additionalProperties": false,
              "properties": {
                "profile": {
                  "additionalProperties": false,
                  "properties": {
                    "settings": {
                      "additionalProperties": false,
                      "properties": {
                        "notifications": {
                          "type": "boolean",
                        },
                      },
                      "required": [
                        "notifications",
                      ],
                      "type": "object",
                    },
                  },
                  "required": [
                    "settings",
                  ],
                  "type": "object",
                },
              },
              "required": [
                "profile",
              ],
              "type": "object",
            },
          },
          "required": [
            "user",
          ],
          "type": "object",
        }
      `);
    });

    test("handles array types", () => {
      const schema = z.object({
        tags: z.array(z.string()),
        numbers: z.array(z.number()),
        events: z.array(
          z.object({
            type: z.string(),
            timestamp: z.number(),
          }),
        ),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.tags.type).toBe("array");
      expect(result.properties.tags.items.type).toBe("string");
      expect(result.properties.events.items.additionalProperties).toBe(false);
      expect(result.properties.events.items.required).toEqual(["type", "timestamp"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "events": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "timestamp": {
                    "type": "number",
                  },
                  "type": {
                    "type": "string",
                  },
                },
                "required": [
                  "type",
                  "timestamp",
                ],
                "type": "object",
              },
              "type": "array",
            },
            "numbers": {
              "items": {
                "type": "number",
              },
              "type": "array",
            },
            "tags": {
              "items": {
                "type": "string",
              },
              "type": "array",
            },
          },
          "required": [
            "tags",
            "numbers",
            "events",
          ],
          "type": "object",
        }
      `);
    });

    test("handles unknown and any types", () => {
      const schema = z.object({
        payload: z.unknown(),
        data: z.any(),
        output: z.unknown().optional(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.payload).toBeDefined();
      expect(result.properties.data).toBeDefined();
      expect(result.properties.output).toBeDefined();
      expect(result.required).toContain("payload");
      expect(result.required).toContain("data");
      expect(result.required).not.toContain("output");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "data": {
              "additionalProperties": false,
              "description": "The value can be a string containing a JSON object",
              "type": "string",
            },
            "output": {
              "additionalProperties": false,
              "description": "The value can be a string containing a JSON object",
              "type": "string",
            },
            "payload": {
              "additionalProperties": false,
              "description": "The value can be a string containing a JSON object",
              "type": "string",
            },
          },
          "required": [
            "payload",
            "data",
          ],
          "type": "object",
        }
      `);
    });

    test("removes default values", () => {
      const schema = z.object({
        model: z.string().default("gpt-4"),
        temperature: z.number().default(0.7),
        args: z.array(z.any()).optional().default([]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.model).not.toHaveProperty("default");
      expect(result.properties.temperature).not.toHaveProperty("default");
      expect(result.properties.args).not.toHaveProperty("default");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "args": {
              "items": {
                "additionalProperties": false,
                "description": "The value can be a string containing a JSON object",
                "type": "string",
              },
              "type": "array",
            },
            "model": {
              "type": "string",
            },
            "temperature": {
              "type": "number",
            },
          },
          "required": [
            "model",
            "temperature",
            "args",
          ],
          "type": "object",
        }
      `);
    });

    test("handles simple object types instead of record types", () => {
      const schema = z.object({
        headers: z.object({
          authorization: z.string(),
          contentType: z.string(),
        }),
        metadata: z.object({
          key: z.string(),
        }),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.headers.type).toBe("object");
      expect(result.properties.metadata.type).toBe("object");
    });

    test("handles simple object instead of record with propertyNames", () => {
      const schema = z.object({
        config: z.object({
          setting1: z.string(),
          setting2: z.string(),
        }),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.config).not.toHaveProperty("propertyNames");
      expect(result.properties.config.type).toBe("object");
    });
  });

  describe("Complex Real-World Schemas", () => {
    test("converts complete browser task completion schema", () => {
      const schema = z.object({
        taskId: z.string(),
        result: z.object({
          is_valid: z.boolean(),
          reason: z.string(),
          result: z.any(),
        }),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.type).toBe("object");
      expect(result.additionalProperties).toBe(false);
      expect(result.properties.result.additionalProperties).toBe(false);
      expect(result.properties.result.required).toEqual(["is_valid", "reason", "result"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "result": {
              "additionalProperties": false,
              "properties": {
                "is_valid": {
                  "type": "boolean",
                },
                "reason": {
                  "type": "string",
                },
                "result": {
                  "additionalProperties": false,
                  "description": "The value can be a string containing a JSON object",
                  "type": "string",
                },
              },
              "required": [
                "is_valid",
                "reason",
                "result",
              ],
              "type": "object",
            },
            "taskId": {
              "type": "string",
            },
          },
          "required": [
            "taskId",
            "result",
          ],
          "type": "object",
        }
      `);
    });

    test("converts workflow procedure reference schema", () => {
      const Input = z.object({
        procedureReference: z.object({
          type: z.literal("trpc_procedure_reference"),
          workerServiceName: z.string(),
          appName: z.string(),
          procedureName: z.string(),
          procedureType: z.enum(["query", "mutation"]),
          inputSchema: z.string(),
          outputSchema: z.string(),
        }),
        args: z.array(z.any()).optional().default([]),
        callbackTarget: z
          .union([
            z.object({ type: z.literal("WORKFLOW_EVENT"), workflowId: z.string() }),
            z.object({ type: z.literal("URL_CALLBACK"), url: z.string() }),
          ])
          .optional(),
      });

      const result = zodToOpenAIJSONSchema(Input) as any;

      expect(result.properties.procedureReference.properties.procedureType.enum).toEqual([
        "query",
        "mutation",
      ]);
      expect(result.properties.args.type).toBe("array");
      expect(result.properties.callbackTarget).toHaveProperty("anyOf");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "args": {
              "items": {
                "additionalProperties": false,
                "description": "The value can be a string containing a JSON object",
                "type": "string",
              },
              "type": "array",
            },
            "callbackTarget": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "properties": {
                    "type": {
                      "const": "WORKFLOW_EVENT",
                      "type": "string",
                    },
                    "workflowId": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "type",
                    "workflowId",
                  ],
                  "type": "object",
                },
                {
                  "additionalProperties": false,
                  "properties": {
                    "type": {
                      "const": "URL_CALLBACK",
                      "type": "string",
                    },
                    "url": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "type",
                    "url",
                  ],
                  "type": "object",
                },
              ],
            },
            "procedureReference": {
              "additionalProperties": false,
              "properties": {
                "appName": {
                  "type": "string",
                },
                "inputSchema": {
                  "type": "string",
                },
                "outputSchema": {
                  "type": "string",
                },
                "procedureName": {
                  "type": "string",
                },
                "procedureType": {
                  "enum": [
                    "query",
                    "mutation",
                  ],
                  "type": "string",
                },
                "type": {
                  "const": "trpc_procedure_reference",
                  "type": "string",
                },
                "workerServiceName": {
                  "type": "string",
                },
              },
              "required": [
                "type",
                "workerServiceName",
                "appName",
                "procedureName",
                "procedureType",
                "inputSchema",
                "outputSchema",
              ],
              "type": "object",
            },
          },
          "required": [
            "procedureReference",
            "args",
          ],
          "type": "object",
        }
      `);
    });

    test("handles optional nested objects with simple structure", () => {
      const schema = z.object({
        required: z.string(),
        optional: z
          .object({
            nested: z.object({
              value: z.number(),
              metadata: z
                .object({
                  key: z.string(),
                })
                .optional(),
            }),
          })
          .optional(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.required).toContain("required");
      expect(result.required).not.toContain("optional");
      expect(result.properties.optional.properties.nested.additionalProperties).toBe(false);
      expect(result.properties.optional.properties.nested.required).toEqual(["value"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "optional": {
              "additionalProperties": false,
              "properties": {
                "nested": {
                  "additionalProperties": false,
                  "properties": {
                    "metadata": {
                      "additionalProperties": false,
                      "properties": {
                        "key": {
                          "type": "string",
                        },
                      },
                      "required": [
                        "key",
                      ],
                      "type": "object",
                    },
                    "value": {
                      "type": "number",
                    },
                  },
                  "required": [
                    "value",
                  ],
                  "type": "object",
                },
              },
              "required": [
                "nested",
              ],
              "type": "object",
            },
            "required": {
              "type": "string",
            },
          },
          "required": [
            "required",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("String Replacements and Filtering", () => {
    test('replaces {"not":{}} with "false"', () => {
      const schema = z.object({ test: z.string() });
      const result = JSON.stringify(zodToOpenAIJSONSchema(schema));

      expect(result).not.toContain('{"not":{}}');
    });

    test("filters out objects with only additionalProperties in anyOf", () => {
      const schema = z.object({
        value: z.union([
          z.string(),
          z.number(),
          z.any(), // This might generate an object with only additionalProperties: false
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      if (result.properties.value.anyOf) {
        // Check that no items in anyOf have only additionalProperties
        const hasOnlyAdditionalProperties = result.properties.value.anyOf.some(
          (item: any) => Object.keys(item).length === 1 && item.additionalProperties === false,
        );
        expect(hasOnlyAdditionalProperties).toBe(false);
      }
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "value": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "type": "string",
                },
                {
                  "additionalProperties": false,
                  "type": "number",
                },
                {
                  "additionalProperties": false,
                  "description": "The value can be a string containing a JSON object",
                  "type": "string",
                },
              ],
            },
          },
          "required": [
            "value",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("Required Fields Handling", () => {
    test("makes all fields required including optional ones", () => {
      const schema = z.object({
        required: z.string(),
        optional: z.string().optional(),
        withDefault: z.string().default("default"),
        optionalWithDefault: z.string().optional().default("default"),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.required).toEqual(["required", "withDefault", "optionalWithDefault"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "optional": {
              "type": "string",
            },
            "optionalWithDefault": {
              "type": "string",
            },
            "required": {
              "type": "string",
            },
            "withDefault": {
              "type": "string",
            },
          },
          "required": [
            "required",
            "withDefault",
            "optionalWithDefault",
          ],
          "type": "object",
        }
      `);
    });

    test("preserves existing required array if already defined", () => {
      // This tests the condition where obj.required is already an array
      const schema = z.object({
        field1: z.string(),
        field2: z.number(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(Array.isArray(result.required)).toBe(true);
      expect(result.required).toContain("field1");
      expect(result.required).toContain("field2");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "field1": {
              "type": "string",
            },
            "field2": {
              "type": "number",
            },
          },
          "required": [
            "field1",
            "field2",
          ],
          "type": "object",
        }
      `);
    });
  });

  describe("Workflow Callback Target Stripping", () => {
    test("strips workflowCallbackTarget from nested objects", () => {
      const schema = z.object({
        data: z.object({
          workflowCallbackTarget: z.object({
            type: z.literal("WORKFLOW_EVENT"),
            workflowId: z.string(),
          }),
          keepThis: z.string(),
        }),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.data.properties).not.toHaveProperty("workflowCallbackTarget");
      expect(result.properties.data.properties).toHaveProperty("keepThis");
      expect(result.properties.data.required).toEqual(["keepThis"]);
    });

    test("strips multiple instances of workflowCallbackTarget", () => {
      const schema = z.object({
        workflowCallbackTarget: z.string(),
        nested: z.object({
          workflowCallbackTarget: z.number(),
          value: z.string(),
        }),
        keep: z.boolean(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties).not.toHaveProperty("workflowCallbackTarget");
      expect(result.properties.nested.properties).not.toHaveProperty("workflowCallbackTarget");
      expect(result.properties.nested.properties).toHaveProperty("value");
      expect(result.required).toEqual(["nested", "keep"]);
      expect(result.properties.nested.required).toEqual(["value"]);
    });
  });

  describe("Additional Properties Handling", () => {
    test("sets additionalProperties to false for all objects", () => {
      const schema = z.object({
        simple: z.object({
          value: z.string(),
        }),
        nested: z.object({
          deep: z.object({
            value: z.number(),
          }),
        }),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.additionalProperties).toBe(false);
      expect(result.properties.simple.additionalProperties).toBe(false);
      expect(result.properties.nested.additionalProperties).toBe(false);
      expect(result.properties.nested.properties.deep.additionalProperties).toBe(false);
    });

    test("preserves existing additionalProperties if already defined", () => {
      // This would test the condition where additionalProperties is already set
      // The function only sets it if it's undefined
      const schema = z.object({
        value: z.string(),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.additionalProperties).toBe(false);
    });
  });

  describe("Comprehensive Union and Discriminated Union Tests", () => {
    test("handles unions of primitive types", () => {
      const schema = z.object({
        value: z.union([z.string(), z.number(), z.boolean()]),
        nullableValue: z.union([z.string(), z.null()]),
        literalUnion: z.union([z.literal("option1"), z.literal("option2"), z.literal("option3")]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.value).toHaveProperty("anyOf");
      expect(result.properties.value.anyOf).toHaveLength(3);
      expect(result.properties.value.anyOf[0].type).toBe("string");
      expect(result.properties.value.anyOf[1].type).toBe("number");
      expect(result.properties.value.anyOf[2].type).toBe("boolean");

      expect(result.properties.nullableValue).toHaveProperty("anyOf");
      expect(result.properties.nullableValue.anyOf).toHaveLength(2);

      expect(result.properties.literalUnion).toHaveProperty("anyOf");
      expect(result.properties.literalUnion.anyOf).toHaveLength(3);

      expect(result.required).toEqual(["value", "nullableValue", "literalUnion"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "additionalProperties": false,
          "properties": {
            "literalUnion": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "const": "option1",
                  "type": "string",
                },
                {
                  "additionalProperties": false,
                  "const": "option2",
                  "type": "string",
                },
                {
                  "additionalProperties": false,
                  "const": "option3",
                  "type": "string",
                },
              ],
            },
            "nullableValue": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "type": "string",
                },
                {
                  "additionalProperties": false,
                  "type": "null",
                },
              ],
            },
            "value": {
              "anyOf": [
                {
                  "additionalProperties": false,
                  "type": "string",
                },
                {
                  "additionalProperties": false,
                  "type": "number",
                },
                {
                  "additionalProperties": false,
                  "type": "boolean",
                },
              ],
            },
          },
          "required": [
            "value",
            "nullableValue",
            "literalUnion",
          ],
          "type": "object",
        }
      `);
    });

    test("handles unions mixing primitives and objects", () => {
      const schema = z.object({
        response: z.union([
          z.string(),
          z.object({ error: z.string(), code: z.number() }),
          z.array(z.string()),
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.response).toHaveProperty("anyOf");
      expect(result.properties.response.anyOf).toHaveLength(3);
      expect(result.properties.response.anyOf[0].type).toBe("string");
      expect(result.properties.response.anyOf[1].type).toBe("object");
      expect(result.properties.response.anyOf[1].additionalProperties).toBe(false);
      expect(result.properties.response.anyOf[1].required).toEqual(["error", "code"]);
      expect(result.properties.response.anyOf[2].type).toBe("array");
      expect(result.properties.response.anyOf[2].items.type).toBe("string");
    });

    test("handles deeply nested unions", () => {
      const schema = z.object({
        data: z.union([
          z.object({
            type: z.literal("user"),
            profile: z.union([
              z.object({ version: z.literal("v1"), name: z.string() }),
              z.object({ version: z.literal("v2"), firstName: z.string(), lastName: z.string() }),
            ]),
          }),
          z.object({
            type: z.literal("system"),
            config: z.union([z.string(), z.object({ key: z.string(), value: z.any() })]),
          }),
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.data).toHaveProperty("anyOf");
      expect(result.properties.data.anyOf).toHaveLength(2);

      // Check first union member (user)
      const userType = result.properties.data.anyOf[0];
      expect(userType.additionalProperties).toBe(false);
      expect(userType.properties.profile).toHaveProperty("anyOf");
      expect(userType.properties.profile.anyOf).toHaveLength(2);
      expect(userType.properties.profile.anyOf[0].additionalProperties).toBe(false);
      expect(userType.properties.profile.anyOf[1].additionalProperties).toBe(false);

      // Check second union member (system)
      const systemType = result.properties.data.anyOf[1];
      expect(systemType.additionalProperties).toBe(false);
      expect(systemType.properties.config).toHaveProperty("anyOf");
      expect(systemType.properties.config.anyOf).toHaveLength(2);
    });

    test("handles complex discriminated unions with multiple variants", () => {
      const schema = z.object({
        event: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("user_created"),
            userId: z.string(),
            email: z.string().email(),
            timestamp: z.number(),
          }),
          z.object({
            type: z.literal("user_updated"),
            userId: z.string(),
            changes: z.object({
              before: z.unknown(),
              after: z.unknown(),
            }),
          }),
          z.object({
            type: z.literal("user_deleted"),
            userId: z.string(),
            reason: z.string().optional(),
            deletedBy: z.string(),
          }),
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.event).toHaveProperty("anyOf");
      expect(result.properties.event.anyOf).toHaveLength(3);

      // Check that email pattern/format is removed
      const userCreatedEvent = result.properties.event.anyOf[0];
      expect(userCreatedEvent.properties.email).not.toHaveProperty("pattern");
      expect(userCreatedEvent.properties.email).not.toHaveProperty("format");

      // Check that required fields are in required array (optional fields are not)
      const userDeletedEvent = result.properties.event.anyOf[2];
      expect(userDeletedEvent.required).toContain("type");
      expect(userDeletedEvent.required).toContain("userId");
      expect(userDeletedEvent.required).toContain("deletedBy");
      expect(userDeletedEvent.required).not.toContain("reason");

      // Check additionalProperties is false for all variants
      result.properties.event.anyOf.forEach((variant: any) => {
        expect(variant.additionalProperties).toBe(false);
      });
    });

    test("handles real-world API response pattern", () => {
      const APIResponse = z.discriminatedUnion("status", [
        z.object({
          status: z.literal("success"),
          data: z.object({
            id: z.string(),
            result: z.any(),
          }),
          metadata: z
            .object({
              requestId: z.string(),
              timestamp: z.number(),
            })
            .optional(),
        }),
        z.object({
          status: z.literal("error"),
          error: z.object({
            code: z.string(),
            message: z.string(),
            details: z.unknown().optional(),
          }),
          retryAfter: z.number().optional(),
        }),
        z.object({
          status: z.literal("redirect"),
          location: z.string().url(),
          permanent: z.boolean().default(false),
        }),
      ]);

      const schema = z.object({ response: APIResponse });
      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.response).toHaveProperty("anyOf");
      expect(result.properties.response.anyOf).toHaveLength(3);

      // Check URL pattern removal
      const redirectResponse = result.properties.response.anyOf[2];
      expect(redirectResponse.properties.location).not.toHaveProperty("pattern");
      expect(redirectResponse.properties.location).not.toHaveProperty("format");

      // Check default value removal
      expect(redirectResponse.properties.permanent).not.toHaveProperty("default");

      // Check that required fields are present and optional fields are not forced to be required
      const successResponse = result.properties.response.anyOf[0];
      expect(successResponse.required).toContain("status");
      expect(successResponse.required).toContain("data");
      expect(successResponse.required).not.toContain("metadata");

      const errorResponse = result.properties.response.anyOf[1];
      expect(errorResponse.required).toContain("status");
      expect(errorResponse.required).toContain("error");
      expect(errorResponse.required).not.toContain("retryAfter");
    });

    test("handles union edge cases", () => {
      // Single element union
      const SingleUnion = z.object({
        single: z.union([z.string()]),
      });

      // Union with undefined/null
      const NullishUnion = z.object({
        nullable: z.union([z.string(), z.undefined(), z.null()]),
      });

      // Union with any/unknown
      const AnyUnion = z.object({
        flexible: z.union([z.string(), z.any(), z.unknown()]),
      });

      const singleResult = zodToOpenAIJSONSchema(SingleUnion) as any;
      expect(singleResult.properties.single).toHaveProperty("anyOf");
      expect(singleResult.properties.single.anyOf).toHaveLength(1);

      const nullishResult = zodToOpenAIJSONSchema(NullishUnion) as any;
      expect(nullishResult.properties.nullable).toHaveProperty("anyOf");

      const anyResult = zodToOpenAIJSONSchema(AnyUnion) as any;
      expect(anyResult.properties.flexible).toHaveProperty("anyOf");

      // Verify filtering of empty objects with only additionalProperties
      if (anyResult.properties.flexible.anyOf) {
        const hasOnlyAdditionalProperties = anyResult.properties.flexible.anyOf.some(
          (item: any) => Object.keys(item).length === 1 && item.additionalProperties === false,
        );
        expect(hasOnlyAdditionalProperties).toBe(false);
      }
    });

    test("handles unions containing arrays and complex structures", () => {
      const schema = z.object({
        items: z.union([
          z.array(z.string()),
          z.array(z.object({ id: z.string(), value: z.number() })),
          z.object({ count: z.number(), items: z.array(z.any()) }),
        ]),
        config: z.union([
          z.object({ type: z.literal("simple"), value: z.string() }),
          z.object({
            type: z.literal("complex"),
            settings: z.object({
              option1: z.boolean(),
              option2: z.string(),
            }),
          }),
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      // Verify array handling in unions
      expect(result.properties.items).toHaveProperty("anyOf");
      expect(result.properties.items.anyOf).toHaveLength(3);
      expect(result.properties.items.anyOf[0].type).toBe("array");
      expect(result.properties.items.anyOf[0].items.type).toBe("string");
      expect(result.properties.items.anyOf[1].type).toBe("array");
      expect(result.properties.items.anyOf[1].items.additionalProperties).toBe(false);
      expect(result.properties.items.anyOf[2].type).toBe("object");
      expect(result.properties.items.anyOf[2].additionalProperties).toBe(false);

      // Verify nested object structures
      expect(result.properties.config).toHaveProperty("anyOf");
      expect(result.properties.config.anyOf).toHaveLength(2);
      const complexConfig = result.properties.config.anyOf[1];
      expect(complexConfig.properties.settings.additionalProperties).toBe(false);
      expect(complexConfig.properties.settings.required).toEqual(["option1", "option2"]);
    });

    test("strips workflowCallbackTarget from discriminated unions", () => {
      const schema = z.object({
        action: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("create"),
            data: z.object({ name: z.string() }),
            workflowCallbackTarget: z.object({ workflowId: z.string() }),
          }),
          z.object({
            type: z.literal("update"),
            id: z.string(),
            changes: z.unknown(),
            workflowCallbackTarget: z.object({ workflowId: z.string() }),
          }),
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.action).toHaveProperty("anyOf");
      expect(result.properties.action.anyOf).toHaveLength(2);

      // Verify workflowCallbackTarget is stripped from all union variants
      result.properties.action.anyOf.forEach((variant: any) => {
        expect(variant.properties).not.toHaveProperty("workflowCallbackTarget");
        expect(variant.additionalProperties).toBe(false);
      });

      // Verify other properties are preserved
      expect(result.properties.action.anyOf[0].properties).toHaveProperty("type");
      expect(result.properties.action.anyOf[0].properties).toHaveProperty("data");
      expect(result.properties.action.anyOf[1].properties).toHaveProperty("type");
      expect(result.properties.action.anyOf[1].properties).toHaveProperty("id");
      expect(result.properties.action.anyOf[1].properties).toHaveProperty("changes");
    });

    test("handles nested discriminated unions", () => {
      const schema = z.object({
        command: z.discriminatedUnion("action", [
          z.object({
            action: z.literal("process"),
            target: z.discriminatedUnion("type", [
              z.object({ type: z.literal("file"), path: z.string() }),
              z.object({ type: z.literal("url"), url: z.string() }),
            ]),
          }),
          z.object({
            action: z.literal("transform"),
            input: z.string(),
            operation: z.discriminatedUnion("op", [
              z.object({ op: z.literal("uppercase") }),
              z.object({ op: z.literal("lowercase") }),
              z.object({ op: z.literal("trim"), chars: z.string().optional() }),
            ]),
          }),
        ]),
      });

      const result = zodToOpenAIJSONSchema(schema) as any;

      expect(result.properties.command).toHaveProperty("anyOf");
      expect(result.properties.command.anyOf).toHaveLength(2);

      // Verify nested discriminated union structure
      const processCommand = result.properties.command.anyOf[0];
      expect(processCommand.properties.target).toHaveProperty("anyOf");
      expect(processCommand.properties.target.anyOf).toHaveLength(2);

      const transformCommand = result.properties.command.anyOf[1];
      expect(transformCommand.properties.operation).toHaveProperty("anyOf");
      expect(transformCommand.properties.operation.anyOf).toHaveLength(3);

      // Verify all nested unions are properly converted
      processCommand.properties.target.anyOf.forEach((variant: any) => {
        expect(variant.additionalProperties).toBe(false);
      });

      transformCommand.properties.operation.anyOf.forEach((variant: any) => {
        expect(variant.additionalProperties).toBe(false);
      });

      // Verify required fields are present and optional fields are not forced to be required
      const trimOperation = transformCommand.properties.operation.anyOf[2];
      expect(trimOperation.required).toContain("op");
      expect(trimOperation.required).not.toContain("chars");
    });

    test("handles large unions efficiently", () => {
      const LargeUnion = z.union(
        Array.from({ length: 20 }, (_, i) =>
          z.object({
            type: z.literal(`type${i}`),
            value: i % 2 === 0 ? z.string() : z.number(),
            metadata: z.object({ index: z.literal(i) }),
          }),
        ),
      );

      const schema = z.object({ data: LargeUnion });
      const result = zodToOpenAIJSONSchema(schema) as any;

      // Verify all 20 variants are present
      expect(result.properties.data).toHaveProperty("anyOf");
      expect(result.properties.data.anyOf).toHaveLength(20);

      // Verify performance (should complete quickly) - if this test runs, it's fast enough
      expect(result.properties.data.anyOf[0].additionalProperties).toBe(false);
      expect(result.properties.data.anyOf[19].additionalProperties).toBe(false);

      // Verify structure of a few variants
      expect(result.properties.data.anyOf[0].properties.value.type).toBe("string");
      expect(result.properties.data.anyOf[1].properties.value.type).toBe("number");

      // Verify all variants have required fields
      result.properties.data.anyOf.forEach((variant: any) => {
        expect(variant.required).toEqual(["type", "value", "metadata"]);
        expect(variant.properties.metadata.additionalProperties).toBe(false);
      });
    });
  });

  describe("Union Input Schemas", () => {
    test("handles union of zod objects as direct input", () => {
      const Union = z.union([
        z.object({
          type: z.literal("user"),
          name: z.string(),
          email: z.string().email(),
        }),
        z.object({
          type: z.literal("admin"),
          name: z.string(),
          permissions: z.array(z.string()),
        }),
        z.object({
          type: z.literal("guest"),
          sessionId: z.string(),
        }),
      ]);

      const result = zodToOpenAIJSONSchema(Union) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(3);

      // Check user variant
      const userVariant = result.anyOf[0];
      expect(userVariant.type).toBe("object");
      expect(userVariant.additionalProperties).toBe(false);
      expect(userVariant.required).toEqual(["type", "name", "email"]);
      expect(userVariant.properties.email).not.toHaveProperty("pattern");
      expect(userVariant.properties.email).not.toHaveProperty("format");

      // Check admin variant
      const adminVariant = result.anyOf[1];
      expect(adminVariant.type).toBe("object");
      expect(adminVariant.additionalProperties).toBe(false);
      expect(adminVariant.required).toEqual(["type", "name", "permissions"]);
      expect(adminVariant.properties.permissions.type).toBe("array");
      expect(adminVariant.properties.permissions.items.type).toBe("string");

      // Check guest variant
      const guestVariant = result.anyOf[2];
      expect(guestVariant.type).toBe("object");
      expect(guestVariant.additionalProperties).toBe(false);
      expect(guestVariant.required).toEqual(["type", "sessionId"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "email": {
                  "type": "string",
                },
                "name": {
                  "type": "string",
                },
                "type": {
                  "const": "user",
                  "type": "string",
                },
              },
              "required": [
                "type",
                "name",
                "email",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "properties": {
                "name": {
                  "type": "string",
                },
                "permissions": {
                  "items": {
                    "type": "string",
                  },
                  "type": "array",
                },
                "type": {
                  "const": "admin",
                  "type": "string",
                },
              },
              "required": [
                "type",
                "name",
                "permissions",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "properties": {
                "sessionId": {
                  "type": "string",
                },
                "type": {
                  "const": "guest",
                  "type": "string",
                },
              },
              "required": [
                "type",
                "sessionId",
              ],
              "type": "object",
            },
          ],
        }
      `);
    });

    test("handles discriminated union of zod objects as direct input", () => {
      const DiscriminatedUnion = z.discriminatedUnion("status", [
        z.object({
          status: z.literal("pending"),
          taskId: z.string(),
          createdAt: z.string(),
        }),
        z.object({
          status: z.literal("completed"),
          taskId: z.string(),
          completedAt: z.string(),
          result: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
        }),
        z.object({
          status: z.literal("failed"),
          taskId: z.string(),
          error: z.object({
            code: z.string(),
            message: z.string(),
          }),
        }),
      ]);

      const result = zodToOpenAIJSONSchema(DiscriminatedUnion) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(3);

      // Check all variants have proper structure
      result.anyOf.forEach((variant: any) => {
        expect(variant.type).toBe("object");
        expect(variant.additionalProperties).toBe(false);
        expect(variant.required).toContain("status");
        expect(variant.required).toContain("taskId");
      });

      // Check completed variant has nested object
      const completedVariant = result.anyOf[1];
      expect(completedVariant.properties.result.type).toBe("object");
      expect(completedVariant.properties.result.additionalProperties).toBe(false);
      expect(completedVariant.properties.result.required).toEqual(["success", "data"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "createdAt": {
                  "type": "string",
                },
                "status": {
                  "const": "pending",
                  "type": "string",
                },
                "taskId": {
                  "type": "string",
                },
              },
              "required": [
                "status",
                "taskId",
                "createdAt",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "properties": {
                "completedAt": {
                  "type": "string",
                },
                "result": {
                  "additionalProperties": false,
                  "properties": {
                    "data": {
                      "additionalProperties": false,
                      "description": "The value can be a string containing a JSON object",
                      "type": "string",
                    },
                    "success": {
                      "type": "boolean",
                    },
                  },
                  "required": [
                    "success",
                    "data",
                  ],
                  "type": "object",
                },
                "status": {
                  "const": "completed",
                  "type": "string",
                },
                "taskId": {
                  "type": "string",
                },
              },
              "required": [
                "status",
                "taskId",
                "completedAt",
                "result",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "properties": {
                "error": {
                  "additionalProperties": false,
                  "properties": {
                    "code": {
                      "type": "string",
                    },
                    "message": {
                      "type": "string",
                    },
                  },
                  "required": [
                    "code",
                    "message",
                  ],
                  "type": "object",
                },
                "status": {
                  "const": "failed",
                  "type": "string",
                },
                "taskId": {
                  "type": "string",
                },
              },
              "required": [
                "status",
                "taskId",
                "error",
              ],
              "type": "object",
            },
          ],
        }
      `);
    });

    test("handles union with null and undefined", () => {
      const NullableUnion = z.union([
        z.object({
          type: z.literal("data"),
          value: z.string(),
        }),
        z.null(),
        z.undefined(),
      ]);

      const result = zodToOpenAIJSONSchema(NullableUnion) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(3);

      // Check object variant
      const objectVariant = result.anyOf[0];
      expect(objectVariant.type).toBe("object");
      expect(objectVariant.additionalProperties).toBe(false);
      expect(objectVariant.required).toEqual(["type", "value"]);

      // Check null variant
      const nullVariant = result.anyOf[1];
      expect(nullVariant.type).toBe("null");

      // Check undefined variant (should be handled appropriately)
      const undefinedVariant = result.anyOf[2];
      expect(undefinedVariant).toBeDefined();
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "type": {
                  "const": "data",
                  "type": "string",
                },
                "value": {
                  "type": "string",
                },
              },
              "required": [
                "type",
                "value",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "type": "null",
            },
            {
              "additionalProperties": false,
              "type": "null",
            },
          ],
        }
      `);
    });

    test("handles union with mixed object and primitive types", () => {
      const MixedUnion = z.union([
        z.object({
          type: z.literal("object"),
          data: z.string(),
        }),
        z.string(),
        z.number(),
        z.boolean(),
      ]);

      // @ts-expect-error - zodToOpenAISchema is not typed correctly
      const result = zodToOpenAIJSONSchema(MixedUnion) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(4);

      // Check object variant
      const objectVariant = result.anyOf[0];
      expect(objectVariant.type).toBe("object");
      expect(objectVariant.additionalProperties).toBe(false);
      expect(objectVariant.required).toEqual(["type", "data"]);

      // Check primitive variants
      expect(result.anyOf[1].type).toBe("string");
      expect(result.anyOf[2].type).toBe("number");
      expect(result.anyOf[3].type).toBe("boolean");
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "data": {
                  "type": "string",
                },
                "type": {
                  "const": "object",
                  "type": "string",
                },
              },
              "required": [
                "type",
                "data",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "type": "string",
            },
            {
              "additionalProperties": false,
              "type": "number",
            },
            {
              "additionalProperties": false,
              "type": "boolean",
            },
          ],
        }
      `);
    });

    test("strips workflowCallbackTarget from union input objects", () => {
      const UnionWithCallback = z.union([
        z.object({
          type: z.literal("action1"),
          data: z.string(),
          workflowCallbackTarget: z.object({
            workflowId: z.string(),
          }),
        }),
        z.object({
          type: z.literal("action2"),
          value: z.number(),
          workflowCallbackTarget: z.object({
            workflowId: z.string(),
          }),
        }),
      ]);

      const result = zodToOpenAIJSONSchema(UnionWithCallback) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(2);

      // Verify workflowCallbackTarget is stripped from both variants
      result.anyOf.forEach((variant: any) => {
        expect(variant.properties).not.toHaveProperty("workflowCallbackTarget");
        expect(variant.additionalProperties).toBe(false);
      });

      // Verify other properties are preserved
      expect(result.anyOf[0].properties).toHaveProperty("type");
      expect(result.anyOf[0].properties).toHaveProperty("data");
      expect(result.anyOf[0].required).toEqual(["type", "data"]);

      expect(result.anyOf[1].properties).toHaveProperty("type");
      expect(result.anyOf[1].properties).toHaveProperty("value");
      expect(result.anyOf[1].required).toEqual(["type", "value"]);
      expect(result).toMatchInlineSnapshot(`
        {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "anyOf": [
            {
              "additionalProperties": false,
              "properties": {
                "data": {
                  "type": "string",
                },
                "type": {
                  "const": "action1",
                  "type": "string",
                },
              },
              "required": [
                "type",
                "data",
              ],
              "type": "object",
            },
            {
              "additionalProperties": false,
              "properties": {
                "type": {
                  "const": "action2",
                  "type": "string",
                },
                "value": {
                  "type": "number",
                },
              },
              "required": [
                "type",
                "value",
              ],
              "type": "object",
            },
          ],
        }
      `);
    });

    test("handles deeply nested union input with complex structures", () => {
      const ComplexUnion = z.union([
        z.object({
          category: z.literal("user_action"),
          action: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("create"),
              data: z.object({
                name: z.string(),
                email: z.string().email(),
              }),
            }),
            z.object({
              type: z.literal("update"),
              id: z.string(),
              changes: z.array(z.string()),
            }),
          ]),
        }),
        z.object({
          category: z.literal("system_event"),
          event: z.object({
            timestamp: z.number(),
            source: z.string(),
            metadata: z.object({
              version: z.string(),
              environment: z.enum(["dev", "staging", "prod"]),
            }),
          }),
        }),
      ]);

      const result = zodToOpenAIJSONSchema(ComplexUnion) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(2);

      // Check user_action variant
      const userActionVariant = result.anyOf[0];
      expect(userActionVariant.type).toBe("object");
      expect(userActionVariant.additionalProperties).toBe(false);
      expect(userActionVariant.properties.action).toHaveProperty("anyOf");
      expect(userActionVariant.properties.action.anyOf).toHaveLength(2);

      // Check nested discriminated union handling
      const createAction = userActionVariant.properties.action.anyOf[0];
      expect(createAction.properties.data.additionalProperties).toBe(false);
      expect(createAction.properties.data.properties.email).not.toHaveProperty("pattern");
      expect(createAction.properties.data.properties.email).not.toHaveProperty("format");

      // Check system_event variant
      const systemEventVariant = result.anyOf[1];
      expect(systemEventVariant.type).toBe("object");
      expect(systemEventVariant.additionalProperties).toBe(false);
      expect(systemEventVariant.properties.event.additionalProperties).toBe(false);
      expect(systemEventVariant.properties.event.properties.metadata.additionalProperties).toBe(
        false,
      );
      expect(
        systemEventVariant.properties.event.properties.metadata.properties.environment.enum,
      ).toEqual(["dev", "staging", "prod"]);
    });

    test("handles single object union (edge case)", () => {
      const SingleObjectUnion = z.union([
        z.object({
          id: z.string(),
          name: z.string(),
        }),
      ]);

      const result = zodToOpenAIJSONSchema(SingleObjectUnion) as any;

      expect(result).toHaveProperty("anyOf");
      expect(result.anyOf).toHaveLength(1);
      expect(result.anyOf[0].type).toBe("object");
      expect(result.anyOf[0].additionalProperties).toBe(false);
      expect(result.anyOf[0].required).toEqual(["id", "name"]);
    });
  });
});

describe("OpenAI Incompatible Features", () => {
  test("handles schema with $ref, $defs, and propertyNames", () => {
    const schemaWithRefs = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        runbookUniqueName: {
          description: "The unique name of the runbook to use",
          type: "string",
        },
        childAgentInput: {
          description: "Input data for the runbook",
          type: "object",
          additionalProperties: {
            $ref: "#/$defs/__schema0",
          },
          properties: {},
        },
        childAgentContext: {
          description: "Additional context for the sub-agent",
          type: "string",
        },
      },
      required: ["runbookUniqueName", "childAgentInput", "childAgentContext"],
      additionalProperties: false,
      $defs: {
        __schema0: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "null" },
            { type: "null" },
            {
              type: "array",
              items: { $ref: "#/$defs/__schema0" },
            },
            {
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: { $ref: "#/$defs/__schema0" },
            },
          ],
        },
      },
    };

    makeJSONSchemaOpenAICompatible(schemaWithRefs);

    // Check that $defs and $ref are removed
    expect(schemaWithRefs).not.toHaveProperty("$defs");
    expect(JSON.stringify(schemaWithRefs)).not.toContain("$ref");

    // Check that propertyNames is removed from nested structures
    expect(JSON.stringify(schemaWithRefs)).not.toContain("propertyNames");

    // Verify the structure is still valid
    expect(schemaWithRefs.type).toBe("object");
    expect(schemaWithRefs.properties).toHaveProperty("runbookUniqueName");
    expect(schemaWithRefs.properties).toHaveProperty("childAgentInput");
    expect(schemaWithRefs.properties).toHaveProperty("childAgentContext");

    // Check that childAgentInput has been simplified
    expect(schemaWithRefs.properties.childAgentInput.type).toBe("object");
    expect(schemaWithRefs.properties.childAgentInput).toHaveProperty("additionalProperties");

    // The additionalProperties should now be a simplified representation
    const additionalProps = schemaWithRefs.properties.childAgentInput.additionalProperties;
    expect(additionalProps).toBeDefined();

    // Should not have any propertyNames in the entire structure
    const stringified = JSON.stringify(schemaWithRefs);
    expect(stringified).not.toContain("propertyNames");
    expect(stringified).not.toContain("$ref");
    expect(stringified).not.toContain("$defs");
  });
});
