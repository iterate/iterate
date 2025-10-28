import { describe, it, expect } from "vitest";
import type { JSONSchema } from "zod/v4/core";
import { z } from "zod";
import { subtractObjectPropsFromJSONSchema } from "./subtract-object-props-from-json-schema.js";

describe("subtractObjectPropsFromJSONSchema", () => {
  describe("basic functionality", () => {
    it("removes provided props from required and properties", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["width", "height"],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, { width: 123 });

      expect(result).toEqual({
        type: "object",
        properties: {
          height: { type: "number" },
        },
        required: ["height"],
      });
    });

    it("drops properties entirely if all provided", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
        required: ["foo"],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, { foo: "bar" });

      expect(result).toEqual({ type: "object" });
    });
  });

  describe("empty required array handling", () => {
    it("should omit required field when schema starts with empty required array", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
        required: [],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, {});

      expect(result).toEqual({
        type: "object",
        properties: {
          foo: { type: "string" },
        },
      });
      expect(result).not.toHaveProperty("required");
    });

    it("should omit required field when schema has empty properties and empty required", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {},
        required: [],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, {});

      expect(result).toEqual({
        type: "object",
      });
      expect(result).not.toHaveProperty("required");
      expect(result).not.toHaveProperty("properties");
    });

    it("should omit required field when subtracting from schema with no properties but empty required", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        required: [],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, {});

      expect(result).toEqual({
        type: "object",
      });
      expect(result).not.toHaveProperty("required");
    });

    it("should omit required field when all properties are removed and required becomes empty", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {
          foo: { type: "string" },
          bar: { type: "number" },
        },
        required: ["foo", "bar"],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, { foo: "value", bar: 42 });

      expect(result).toEqual({
        type: "object",
      });
      expect(result).not.toHaveProperty("required");
      expect(result).not.toHaveProperty("properties");
    });

    it("should not add required field when schema has no required field and empty properties", () => {
      const schema: JSONSchema.JSONSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: false,
      };

      const result = subtractObjectPropsFromJSONSchema(schema, {});

      expect(result).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(result).not.toHaveProperty("required");
      expect(result).not.toHaveProperty("properties");
    });

    it("should not add required field when schema has no properties or required field", () => {
      const schema: JSONSchema.JSONSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      };

      const result = subtractObjectPropsFromJSONSchema(schema, {});

      expect(result).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(result).not.toHaveProperty("required");
    });

    it("should remove empty properties field when present", () => {
      const schema: JSONSchema.JSONSchema = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {},
      };

      const result = subtractObjectPropsFromJSONSchema(schema, {});

      expect(result).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      });
      expect(result).not.toHaveProperty("required");
      expect(result).not.toHaveProperty("properties");
    });
  });

  describe("nested objects with empty required arrays", () => {
    it("should omit required field in nested objects when they start with empty required", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: [],
          },
        },
        required: ["nested"],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, { nested: {} });

      expect(result).toEqual({
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
          },
        },
        required: ["nested"],
      });
      expect(result.properties?.nested).not.toHaveProperty("required");
    });

    it("should remove nested object entirely when it has no properties and empty required", () => {
      const schema: JSONSchema.JSONSchema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        required: ["nested"],
      };

      const result = subtractObjectPropsFromJSONSchema(schema, { nested: {} });

      expect(result).toEqual({
        type: "object",
      });
      expect(result).not.toHaveProperty("required");
      expect(result).not.toHaveProperty("properties");
    });
  });

  describe("zod schema generation", () => {
    it("checks what zod produces for empty object schemas", () => {
      const EmptyObject = z.object({});
      const Json = z.toJSONSchema(EmptyObject, {
        target: "draft-2020-12",
      });

      // Check if zod adds required: []
      if ("required" in Json && Array.isArray(Json.required) && Json.required.length === 0) {
        console.log("WARNING: Zod adds empty required array to empty object schemas!");
      }
    });
  });
});
