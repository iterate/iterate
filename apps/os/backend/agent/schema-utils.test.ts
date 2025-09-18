import { describe, it, expect } from "vitest";
import type { JSONSchema } from "zod/v4/core";
import { subtractObjectPropsFromJSONSchema } from "./subtract-object-props-from-json-schema.ts";

// Reusable test schemas
const schemas: Record<string, JSONSchema.JSONSchema> = {
  simpleRectangle: {
    type: "object",
    properties: {
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["width", "height"],
  },

  singleProp: {
    type: "object",
    properties: {
      foo: { type: "string" },
    },
    required: ["foo"],
  },

  nestedAddress: {
    type: "object",
    properties: {
      address: {
        type: "object",
        properties: {
          street: { type: "string" },
          city: { type: "string" },
          geo: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lon: { type: "number" },
            },
            required: ["lat", "lon"],
          },
        },
        required: ["street", "city", "geo"],
      },
    },
    required: ["address"],
  },

  userProfile: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      preferences: {
        type: "object",
        properties: {
          theme: { type: "string" },
          notifications: {
            type: "object",
            properties: {
              email: { type: "boolean" },
              sms: { type: "boolean" },
            },
            required: ["email"],
          },
        },
        required: ["theme", "notifications"],
      },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["name", "preferences"],
  },

  deeplyNested: {
    type: "object",
    properties: {
      level1: {
        type: "object",
        properties: {
          level2: {
            type: "object",
            properties: {
              level3: {
                type: "object",
                properties: {
                  value: { type: "string" },
                },
                required: ["value"],
              },
            },
            required: ["level3"],
          },
        },
        required: ["level2"],
      },
    },
    required: ["level1"],
  },
};

describe("subtractObjectPropsFromJSONSchema", () => {
  const testCases = [
    {
      name: "removes provided props from required and properties",
      schema: schemas.simpleRectangle,
      provided: { width: 123 },
      expected: {
        type: "object",
        properties: {
          height: { type: "number" },
        },
        required: ["height"],
      },
    },
    {
      name: "drops properties entirely if all provided",
      schema: schemas.singleProp,
      provided: { foo: "bar" },
      expected: { type: "object" },
    },
    {
      name: "handles nested object partial provision",
      schema: schemas.nestedAddress,
      provided: {
        address: {
          street: "Main St",
          geo: {
            lat: 40.0,
          },
        },
      },
      expected: {
        type: "object",
        properties: {
          address: {
            type: "object",
            properties: {
              city: { type: "string" },
              geo: {
                type: "object",
                properties: {
                  lon: { type: "number" },
                },
                required: ["lon"],
              },
            },
            required: ["city", "geo"],
          },
        },
        required: ["address"],
      },
    },
    {
      name: "handles complete nested object removal",
      schema: schemas.nestedAddress,
      provided: {
        address: {
          street: "Main St",
          city: "NYC",
          geo: {
            lat: 40.0,
            lon: -73.0,
          },
        },
      },
      expected: { type: "object" },
    },
    {
      name: "preserves unrelated nested properties",
      schema: schemas.userProfile,
      provided: {
        name: "Alice",
        preferences: {
          theme: "dark",
        },
      },
      expected: {
        type: "object",
        properties: {
          age: { type: "number" },
          preferences: {
            type: "object",
            properties: {
              notifications: {
                type: "object",
                properties: {
                  email: { type: "boolean" },
                  sms: { type: "boolean" },
                },
                required: ["email"],
              },
            },
            required: ["notifications"],
          },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["preferences"],
      },
    },
    {
      name: "handles deeply nested partial provision",
      schema: schemas.deeplyNested,
      provided: {
        level1: {
          level2: {},
        },
      },
      expected: {
        type: "object",
        properties: {
          level1: {
            type: "object",
            properties: {
              level2: {
                type: "object",
                properties: {
                  level3: {
                    type: "object",
                    properties: {
                      value: { type: "string" },
                    },
                    required: ["value"],
                  },
                },
                required: ["level3"],
              },
            },
            required: ["level2"],
          },
        },
        required: ["level1"],
      },
    },
    {
      name: "handles non-object values in nested structures",
      schema: schemas.userProfile,
      provided: {
        preferences: {
          theme: "dark",
          notifications: {
            email: true,
            sms: false,
          },
        },
        tags: ["tag1", "tag2"], // array value - should be removed entirely
      },
      expected: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      },
    },
  ];

  it.each(testCases)("$name", ({ schema, provided, expected }) => {
    const result = subtractObjectPropsFromJSONSchema(schema, provided);
    expect(result).toEqual(expected);
  });

  it.skip("handles arrays of objects (not yet supported)", () => {
    // Future enhancement – subtracting inside items of array schemas would be nice
    // Example schema with array of objects:
    const _schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
            required: ["id", "name"],
          },
        },
      },
    };
    // This would require more complex logic to handle array item schemas
  });

  it.skip("handles oneOf/anyOf schemas (not yet supported)", () => {
    // Future enhancement - polymorphic schemas
    const _schema = {
      type: "object",
      properties: {
        payment: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { const: "card" },
                cardNumber: { type: "string" },
              },
              required: ["type", "cardNumber"],
            },
            {
              type: "object",
              properties: {
                type: { const: "bank" },
                accountNumber: { type: "string" },
              },
              required: ["type", "accountNumber"],
            },
          ],
        },
      },
    };
    // This would require analysis of which branch matches the provided data
  });
});
