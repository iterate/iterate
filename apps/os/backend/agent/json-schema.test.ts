import { describe, it, expect } from "vitest";
import { filterOptionalFieldsFromJSONSchema } from "./json-schema.ts";

describe("filterOptionalFieldsFromJSONSchema", () => {
  it("filters out optional fields from a simple object schema", () => {
    const schema = {
      type: "object",
      properties: {
        required1: { type: "string" },
        required2: { type: "number" },
        optional1: { type: "boolean" },
        optional2: { type: "string" },
      },
      required: ["required1", "required2"],
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      type: "object",
      properties: {
        required1: { type: "string" },
        required2: { type: "number" },
      },
      required: ["required1", "required2"],
    });
  });

  it("handles nested object schemas recursively", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            age: { type: "number" },
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                city: { type: "string" },
                zipCode: { type: "string" },
              },
              required: ["street", "city"],
            },
          },
          required: ["name", "address"],
        },
        optionalField: { type: "string" },
      },
      required: ["user"],
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                city: { type: "string" },
              },
              required: ["street", "city"],
            },
          },
          required: ["name", "address"],
        },
      },
      required: ["user"],
    });
  });

  it("handles array schemas with object items", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          optional: { type: "boolean" },
        },
        required: ["id", "name"],
      },
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "name"],
      },
    });
  });

  it("handles schemas with no required fields", () => {
    const schema = {
      type: "object",
      properties: {
        field1: { type: "string" },
        field2: { type: "number" },
      },
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      type: "object",
    });
  });

  it("handles empty required array", () => {
    const schema = {
      type: "object",
      properties: {
        field1: { type: "string" },
      },
      required: [],
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      type: "object",
    });
  });

  it("handles oneOf, anyOf, allOf schemas", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
          },
          required: ["a"],
        },
        {
          type: "object",
          properties: {
            c: { type: "number" },
            d: { type: "number" },
          },
          required: ["c"],
        },
      ],
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            a: { type: "string" },
          },
          required: ["a"],
        },
        {
          type: "object",
          properties: {
            c: { type: "number" },
          },
          required: ["c"],
        },
      ],
    });
  });

  it("handles non-object schemas", () => {
    expect(filterOptionalFieldsFromJSONSchema({ type: "string" })).toEqual({ type: "string" });
    expect(filterOptionalFieldsFromJSONSchema({ type: "number" })).toEqual({ type: "number" });
    expect(filterOptionalFieldsFromJSONSchema(null)).toEqual(null);
    expect(filterOptionalFieldsFromJSONSchema(undefined)).toEqual(undefined);
  });

  it("handles schemas without explicit type but with properties", () => {
    const schema = {
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    });
  });

  it("preserves other schema properties", () => {
    const schema = {
      type: "object",
      description: "A user object",
      title: "User",
      properties: {
        name: { type: "string", description: "User's name" },
        optional: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };

    const result = filterOptionalFieldsFromJSONSchema(schema);

    expect(result).toEqual({
      type: "object",
      description: "A user object",
      title: "User",
      properties: {
        name: { type: "string", description: "User's name" },
      },
      required: ["name"],
      additionalProperties: false,
    });
  });
});
